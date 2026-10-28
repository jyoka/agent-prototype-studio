import { ConnectionError } from './claude-code.js';
import { END_STEP, INTENTS, describeWhen, formatValue, normalizeValue } from './definition.js';
import { templateReply } from './mock.js';

// プロダクト内 AI の harness(docs/design/harness.md の 4)。1 ターンを 3 段で回す:
//   抽出(接続) → 決定(ここのコード) → 言い方(接続)
// 何を聞くか、段の遷移、終わるかは app/ai.json とここのコードが決める。接続が返すのは抽出の JSON と返事の文だけ。
// 接続の口は 2 つ: extract({ definition, fields, state, messages, text, signal, meter }) -> { updates, intent }、
// phrase({ definition, decision, state, messages, text, signal, meter }) -> { reply }。モックも Claude Code もこの 2 つを持つ。
// 実モデルの接続は、出力が壊れていたら 1 回やり直し、だめなら retry と fallback に理由を入れて返す
// (抽出は「変更なし」、言い方は reply なし。言い方はここで mock の型の文に代える)。meter は呼び出しの上限と記録(limits.js)。
// 1 回の呼び出しで { reply, updates } を返す接続(respond。テスト用)も通す。
// その返事は決定の前に作られるが、updates は同じ抽出の検査を通し、決定は harness が行う。

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

// 記録に出す、決まりに合わなかった値
export const shownValue = (value) => (typeof value === 'string' ? value : JSON.stringify(value) ?? String(value)).slice(0, 100);

// 会話の進み具合。今の段、数えたターン、終わったか。会話ごとにサーバーが持つ
export function startProgress(definition) {
  return { step: definition.flow.steps[0].id, turns: 0, done: false };
}

// ディスクから読んだ進み具合を、設定の決まりで確かめる。合わなければ undefined
export function checkProgress(definition, raw) {
  if (!isPlainObject(raw)) return undefined;
  const { step, turns, done } = raw;
  if (!definition.flow.steps.some((s) => s.id === step)) return undefined;
  if (!Number.isInteger(turns) || turns < 0) return undefined;
  if (typeof done !== 'boolean') return undefined;
  return { step, turns: Math.min(turns, definition.flow.maxTurns), done };
}

const stepOf = (definition, id) => definition.flow.steps.find((step) => step.id === id);
const fieldOf = (definition, key) => definition.fields.find((field) => field.key === key);
const labelOf = (definition) => (key) => fieldOf(definition, key)?.label ?? key;

// 今の段で、次に聞く項目。段の ask の順で、未定の最初のもの
function askingField(definition, progress, state) {
  if (progress.done) return null;
  const key = stepOf(definition, progress.step).ask.find((k) => state[k] === null);
  return key ? fieldOf(definition, key) : null;
}

// 抽出を呼ばずに読める答え: 今聞いている項目への、選択肢の文字そのもの、数だけの答え(単位は付けてよい)。
// 聞いていない項目の選択肢は読まない(確かめの段の「はい」が、たまたま選択肢と同じ文字でも、答えとして取らない)
export function quickExtract(definition, progress, state, text) {
  const said = text.normalize('NFKC').trim();
  const asking = askingField(definition, progress, state);
  if (asking?.type === 'choice') {
    const option = asking.options.find((o) => o.value.normalize('NFKC') === said);
    if (option) return { updates: { [asking.key]: option.value }, intent: 'answer', reason: `今聞いている${asking.label}の選択肢の文字そのもの` };
  }
  if (asking?.type === 'number') {
    const unit = asking.unit.normalize('NFKC');
    const digits = unit && said.endsWith(unit) ? said.slice(0, -unit.length).trim() : said;
    if (/^\d[\d,]*(\.\d+)?$/.test(digits)) {
      return { updates: { [asking.key]: digits.replaceAll(',', '') }, intent: 'answer', reason: `今聞いている${asking.label}への、数だけの答え` };
    }
  }
  return null;
}

// 抽出の検査。項目の決まり(選択肢、数の範囲、型)に合う値だけを採り、合わない値は rejected に残す
export function checkExtraction(definition, output) {
  const accepted = {};
  const rejected = [];
  if (!isPlainObject(output)) {
    rejected.push({ key: '(抽出の全体)', label: null, value: shownValue(output), reason: '{ updates, intent } の形ではない' });
    return { updates: accepted, intent: null, rejected };
  }
  const raw = output.updates ?? {};
  if (!isPlainObject(raw)) {
    rejected.push({ key: 'updates', label: null, value: shownValue(raw), reason: '{ 項目の key: 値 } の形ではない' });
  } else {
    for (const [key, value] of Object.entries(raw)) {
      const field = fieldOf(definition, key);
      const normalized = field ? normalizeValue(field, value) : undefined;
      if (normalized === undefined) {
        rejected.push({ key, label: field?.label ?? null, value: shownValue(value), reason: field ? '項目の決まりに合わない値' : 'app/ai.json にない項目' });
        continue;
      }
      accepted[key] = normalized;
    }
  }
  let intent = output.intent ?? null;
  if (intent !== null && !INTENTS.includes(intent)) {
    rejected.push({ key: 'intent', label: '発言の種類(intent)', value: shownValue(intent), reason: `Studio の決めた種類(${INTENTS.join(', ')})にない` });
    intent = null;
  }
  // 項目の並びの順にそろえる。同じ抽出なら、同じ順で決定する
  const updates = Object.fromEntries(definition.fields.filter((f) => Object.hasOwn(accepted, f.key)).map((f) => [f.key, accepted[f.key]]));
  return { updates, intent, rejected };
}

// 最後の AI の発言より後に、本人が直した項目
export function correctedSinceLastReply(messages) {
  const keys = [];
  for (let i = messages.length - 1; i >= 0 && messages[i].role !== 'assistant'; i -= 1) {
    if (messages[i].role !== 'correction') continue;
    for (const change of messages[i].changes) if (!keys.includes(change.key)) keys.unshift(change.key);
  }
  return keys;
}

function holds(definition, when, { state, intent, turns }) {
  if (when.filled === 'required' && definition.fields.some((field) => field.required && state[field.key] === null)) return false;
  if (Array.isArray(when.filled) && when.filled.some((key) => state[key] === null)) return false;
  if (when.intent !== undefined && when.intent !== intent) return false;
  if (when.turnsAtLeast !== undefined && turns < when.turnsAtLeast) return false;
  return true;
}

// 決定。抽出を検査した結果から、状態の更新、段の遷移、次に聞く項目、言うこと、終わるかを決める。
// 同じ設定、進み具合、状態、会話、抽出なら、いつも同じ決定になる(接続によらない)
// 返す decision: { step, from, turn, ask, say, changes, corrected, intent, done, mustInclude, reason }
export function decide(definition, { progress, state, messages, extraction }) {
  const label = labelOf(definition);
  const nextState = { ...state, ...extraction.updates };
  // 抽出で受け入れた値(前と同じ値も含む)。言い方で「〜と理解しました」と返す
  const changes = Object.entries(extraction.updates).map(([key, to]) => ({ key, label: label(key), from: state[key], to }));
  const corrected = correctedSinceLastReply(messages).filter((key) => !Object.hasOwn(extraction.updates, key));
  const next = { ...progress, turns: Math.min(progress.turns + 1, definition.flow.maxTurns) };
  const reasons = [];
  if (progress.done) {
    reasons.push('会話はもう終わっているので、それ以上聞かない');
  } else {
    const step = stepOf(definition, progress.step);
    const move = step.next.find((item) => holds(definition, item.when, { state: nextState, intent: extraction.intent, turns: next.turns }));
    if (move) {
      const why = describeWhen(move.when, label);
      if (move.to === END_STEP) {
        next.done = true;
        reasons.push(`段「${step.id}」で${why}なので、会話を終える`);
      } else {
        next.step = move.to;
        reasons.push(`段「${step.id}」で${why}なので、段「${move.to}」へ移る`);
      }
    } else {
      reasons.push(`段「${step.id}」の遷移の条件をどれも満たしていないので、この段に留まる`);
    }
    if (!next.done && next.turns >= definition.flow.maxTurns) {
      next.done = true;
      reasons.push(`ターンが flow.maxTurns(${definition.flow.maxTurns})に達したので、会話を終える`);
    }
  }
  const asking = askingField(definition, next, nextState);
  let say = null;
  if (next.done) {
    say = definition.end.say;
  } else {
    const step = stepOf(definition, next.step);
    say = step.say;
    // 聞く項目がみな埋まった段では、今の条件をまとめて返す(直すところを言ってもらうため)
    if (!say && !asking && step.ask.length > 0) {
      say = 'summary';
      reasons.push(`段「${step.id}」で聞く項目はみな埋まっているので、今の条件をまとめる`);
    }
  }
  if (asking) reasons.push(`段「${next.step}」で未定の最初の項目「${asking.label}」を聞く`);
  const decision = {
    step: next.step,
    from: progress.step,
    turn: next.turns,
    ask: asking?.key ?? null,
    say,
    changes,
    corrected,
    intent: extraction.intent,
    done: next.done,
    mustInclude: asking ? [asking.question] : [],
    reason: reasons.join('。'),
  };
  return { decision, state: nextState, progress: next };
}

// 記録に出す決定。値は画面と同じ書き方にする
export function describeDecision(definition, decision) {
  const label = labelOf(definition);
  const shown = (key, value) => formatValue(fieldOf(definition, key), value);
  return {
    step: decision.step,
    from: decision.from,
    turn: decision.turn,
    ask: decision.ask ? { key: decision.ask, label: label(decision.ask) } : null,
    say: decision.say,
    done: decision.done,
    intent: decision.intent,
    changes: decision.changes.map(({ key, from, to }) => ({ key, label: label(key), from: shown(key, from), to: shown(key, to) })),
    corrected: decision.corrected.map((key) => ({ key, label: label(key) })),
    mustInclude: decision.mustInclude,
    reason: decision.reason,
  };
}

const describeState = (definition, state) =>
  definition.fields.map((field) => ({ key: field.key, label: field.label, value: formatValue(field, state[field.key]) }));

// 1 ターン。接続の失敗(例外)はそのまま投げる。進み具合と状態は書き換えず、新しいものを返す。
// trace に段ごとの中身(抽出、決定、言い方)を書き足す。途中で失敗しても、そこまでが残る
export async function turn({ connection, definition, progress, state, messages, text, signal, meter, trace = {} }) {
  const fields = definition.fields;
  trace.extract = { input: { text, step: progress.step, fields: fields.map((field) => field.key), state: describeState(definition, state) } };
  let raw;
  let oneCall = null;
  const quick = connection.respond ? null : quickExtract(definition, progress, state, text);
  if (quick) {
    trace.extract.via = 'shortcut';
    trace.extract.reason = `${quick.reason}なので、抽出を呼ばずに読んだ`;
    raw = { updates: quick.updates, intent: quick.intent };
  } else if (connection.respond) {
    // 1 回の呼び出しで返事と updates を返す接続。返事は決定の前に作られる
    trace.extract.via = 'respond';
    oneCall = await connection.respond({ definition, state, messages, text, signal });
    raw = { updates: oneCall?.updates, intent: oneCall?.intent };
  } else {
    trace.extract.via = 'connection';
    const extracted = await connection.extract({ definition, fields, state, messages, text, signal, meter });
    raw = extracted;
    if (extracted?.retry) trace.extract.retry = extracted.retry;
    if (extracted?.fallback) trace.extract.fallback = extracted.fallback;
  }
  trace.extract.output = { updates: raw?.updates ?? null, intent: raw?.intent == null ? null : shownValue(raw.intent) };
  const extraction = checkExtraction(definition, raw);
  trace.extract.rejected = extraction.rejected;

  // 抽出を待つ間に止められたら、言い方を呼ばない(実モデルの呼び出しを無駄にしない)
  if (signal?.aborted) throw new ConnectionError('cancelled', '応答を止めました');
  const decided = decide(definition, { progress, state, messages, extraction });
  trace.decision = describeDecision(definition, decided.decision);

  const phraseInput = { step: decided.decision.step, ask: trace.decision.ask, say: decided.decision.say, done: decided.decision.done, mustInclude: decided.decision.mustInclude };
  trace.phrase = { input: phraseInput };
  let reply;
  if (oneCall) {
    trace.phrase.via = 'respond';
    reply = oneCall.reply;
  } else {
    trace.phrase.via = 'connection';
    const phraseInput = { definition, decision: decided.decision, state: decided.state, messages, text };
    // 送る本文を、送る前に記録に残す(失敗しても見られるように)
    const sent = connection.describePhrase?.(phraseInput);
    if (sent?.stdin) trace.phrase.stdin = sent.stdin;
    const said = await connection.phrase({ ...phraseInput, signal, meter });
    if (said?.retry) trace.phrase.retry = said.retry;
    reply = said?.reply;
    if (said?.fallback && (typeof reply !== 'string' || reply.trim() === '')) {
      trace.phrase.fallback = `${said.fallback}ので、mock の型の文に代えた`;
    }
  }
  if (typeof reply !== 'string' || reply.trim() === '') {
    // 返事が文でなければ、決定を mock の型に当てはめた決まりの文で返す
    trace.phrase.fallback ??= '接続の返事が空か文でなかったので、mock の型の文に代えた';
    reply = templateReply(definition, decided.decision, decided.state);
  }
  reply = reply.slice(0, 4000);
  trace.phrase.output = { reply };
  return {
    reply,
    raw,
    extraction,
    decision: decided.decision,
    state: decided.state,
    progress: decided.progress,
    meta: oneCall?.meta ?? null,
  };
}
