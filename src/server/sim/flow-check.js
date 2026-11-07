import { END_STEP, normalizeValue } from '../product-ai/definition.js';
import { KEY_PATTERN, checkKeys, integer, isPlainObject, jsonValue, list, named, oneOf, show, text, toolNameOf, unique } from './check.js';

// 固定の流れの検査(docs/design/agent-simulation.md の 2.8)。harness の参加者に書く flow(段からコードがツールを呼ぶ)、
// escalate(条件で人に渡す)、model(前提のモデルを使う)。条件の語は決まったものだけで、式、関数、正規表現は書かせない。
export const ESCALATE_CONDITIONS = ['unreadAfter', 'toolFailed', 'fieldIs', 'resultIs'];
export const FLOW_LIMITS = { maxEntries: 20, maxCalls: 5, maxArgs: 20, maxEscalate: 10, maxTimes: 10, maxTell: 500 };

const ENTRY_KEYS = ['step', 'calls', 'tell', 'then', 'onFail'];
const CALL_KEYS = ['tool', 'args', 'as'];
const FAIL_KEYS = ['to', 'clear', 'tell'];
const ESCALATE_KEYS = ['id', 'when', 'to', 'tell'];
const KEY_HINT = '英字で始め、英数字と _ だけで 32 字まで';
const key = (problems, where, value, options) => named(problems, where, value, KEY_PATTERN, { hint: KEY_HINT, ...options });

// 伝える文。置き換えは {state.項目} と {result.名前.項目} だけ
function tellOf(problems, where, value, options) {
  const body = text(problems, where, value, { max: FLOW_LIMITS.maxTell, ...options });
  for (const found of body?.match(/\{[^{}]*\}/g) ?? []) {
    if (!/^\{(state\.[A-Za-z]\w*|result\.[A-Za-z]\w*\.[A-Za-z]\w*)\}$/.test(found)) {
      problems.add(where, `${found} は使えない置き換えです。使える置き換え: {state.項目}、{result.名前.項目}`);
    }
  }
  return body;
}

function parseArgs(problems, where, raw) {
  if (raw === undefined) return {};
  if (!isPlainObject(raw) || Object.keys(raw).length > FLOW_LIMITS.maxArgs) {
    problems.add(where, `{ 引数の名前: 値 } の形で、${FLOW_LIMITS.maxArgs} 個までで書いてください`);
    return {};
  }
  const args = {};
  for (const [name, value] of Object.entries(raw)) {
    const at = `${where}.${name}`;
    if (isPlainObject(value)) {
      if (Object.hasOwn(value, 'state')) {
        checkKeys(problems, at, value, ['state']);
        args[name] = { state: key(problems, `${at}.state`, value.state) };
      } else if (Object.hasOwn(value, 'result')) {
        checkKeys(problems, at, value, ['result', 'key']);
        args[name] = { result: key(problems, `${at}.result`, value.result), key: key(problems, `${at}.key`, value.key) };
      } else {
        problems.add(at, '{ "state": 項目 }、{ "result": 名前, "key": 項目 }、または文字、数、true か false で書いてください');
      }
    } else if (['string', 'number', 'boolean'].includes(typeof value)) {
      args[name] = value;
    } else {
      problems.add(at, '{ "state": 項目 }、{ "result": 名前, "key": 項目 }、または文字、数、true か false で書いてください');
    }
  }
  return args;
}

function parseEntry(problems, where, raw) {
  if (!isPlainObject(raw)) {
    problems.add(where, '{ "step": 段の id, "calls": […], "onFail": { "to": 段の id } } の形で書いてください');
    return null;
  }
  checkKeys(problems, where, raw, ENTRY_KEYS);
  const entry = { step: key(problems, `${where}.step`, raw.step) };
  const calls = raw.calls === undefined ? [] : list(problems, `${where}.calls`, raw.calls, { max: FLOW_LIMITS.maxCalls, of: '呼び出しの' }) ?? [];
  entry.calls = calls
    .map((call, i) => {
      const at = `${where}.calls[${i}]`;
      if (!isPlainObject(call)) {
        problems.add(at, '{ "tool": ツールの名前, "args": { … } } の形で書いてください');
        return null;
      }
      checkKeys(problems, at, call, CALL_KEYS);
      return {
        tool: toolNameOf(problems, `${at}.tool`, call.tool),
        args: parseArgs(problems, `${at}.args`, call.args),
        ...(call.as !== undefined ? { as: key(problems, `${at}.as`, call.as) } : {}),
      };
    })
    .filter(Boolean);
  const tell = tellOf(problems, `${where}.tell`, raw.tell);
  if (tell !== undefined) entry.tell = tell;
  if (entry.calls.length === 0 && tell === undefined) problems.add(where, 'calls か tell のどちらかを書いてください');
  if (raw.then !== undefined) entry.then = key(problems, `${where}.then`, raw.then);
  if (raw.onFail !== undefined) {
    if (!isPlainObject(raw.onFail)) problems.add(`${where}.onFail`, '{ "to": 段の id, "clear": [項目], "tell": 文 } の形で書いてください');
    else {
      checkKeys(problems, `${where}.onFail`, raw.onFail, FAIL_KEYS);
      const clear = raw.onFail.clear === undefined ? [] : list(problems, `${where}.onFail.clear`, raw.onFail.clear, { max: FLOW_LIMITS.maxArgs, of: '項目の' }) ?? [];
      entry.onFail = {
        to: key(problems, `${where}.onFail.to`, raw.onFail.to),
        clear: clear.map((item, i) => key(problems, `${where}.onFail.clear[${i}]`, item)).filter(Boolean),
        ...(raw.onFail.tell !== undefined ? { tell: tellOf(problems, `${where}.onFail.tell`, raw.onFail.tell) } : {}),
      };
    }
  }
  // 失敗したときの行き先を、書く人に決めさせる(黙って進まないため)
  if (entry.calls.length > 0 && !entry.onFail && raw.onFail === undefined) problems.add(`${where}.onFail`, 'ツールが失敗したときに移る段を { "to": 段の id } で書いてください');
  if (entry.calls.length === 0 && raw.onFail !== undefined) problems.add(`${where}.onFail`, 'calls のない段には書けません');
  return entry;
}

function parseWhen(problems, where, raw) {
  if (!isPlainObject(raw) || Object.keys(raw).length !== 1) {
    problems.add(where, `条件を 1 つだけ書いてください。使える語: ${ESCALATE_CONDITIONS.join(', ')}`);
    return null;
  }
  const [word] = Object.keys(raw);
  oneOf(problems, where, word, ESCALATE_CONDITIONS, { label: '条件の語' });
  const value = raw[word];
  const at = `${where}.${word}`;
  if (!ESCALATE_CONDITIONS.includes(word)) return null;
  if (!isPlainObject(value)) {
    problems.add(at, 'オブジェクトで書いてください');
    return null;
  }
  const times = () => integer(problems, `${at}.times`, value.times, { min: 1, max: FLOW_LIMITS.maxTimes, required: true });
  if (word === 'unreadAfter') {
    checkKeys(problems, at, value, ['field', 'times']);
    return { unreadAfter: { field: key(problems, `${at}.field`, value.field), times: times() } };
  }
  if (word === 'toolFailed') {
    checkKeys(problems, at, value, ['tool', 'times']);
    return { toolFailed: { tool: toolNameOf(problems, `${at}.tool`, value.tool), times: times() } };
  }
  if (word === 'fieldIs') {
    checkKeys(problems, at, value, ['field', 'equals']);
    return { fieldIs: { field: key(problems, `${at}.field`, value.field), equals: value.equals } };
  }
  checkKeys(problems, at, value, ['result', 'key', 'equals']);
  jsonValue(problems, `${at}.equals`, value.equals);
  return { resultIs: { result: key(problems, `${at}.result`, value.result), key: key(problems, `${at}.key`, value.key), equals: value.equals } };
}

// 形だけを検査して、参加者に足す項目を返す。書かなかった項目は返さない(今の構成の指紋を変えないため)
export function parseFlowParts(problems, where, raw) {
  const parts = {};
  if (raw.model !== undefined) {
    if (!isPlainObject(raw.model)) problems.add(`${where}.model`, '{ "from": "assumptions" } の形で書いてください');
    else {
      checkKeys(problems, `${where}.model`, raw.model, ['from']);
      parts.model = { from: oneOf(problems, `${where}.model.from`, raw.model.from, ['assumptions'], { label: '読み先' }) };
    }
  }
  if (raw.flow !== undefined) {
    const entries = list(problems, `${where}.flow`, raw.flow, { min: 1, max: FLOW_LIMITS.maxEntries, of: '段の' }) ?? [];
    parts.flow = entries.map((entry, i) => parseEntry(problems, `${where}.flow[${i}]`, entry)).filter(Boolean);
    unique(problems, `${where}.flow`, parts.flow.map((entry) => entry.step), '段');
    unique(problems, `${where}.flow`, parts.flow.flatMap((entry) => entry.calls.map((call) => call.as)).filter(Boolean), '結果の名前(as)');
    // 呼ぶツールの名前。場面の確かめ(toolCalled など)が、この参加者のツールとして読む。モデルには渡さない
    const tools = [...new Set(parts.flow.flatMap((entry) => entry.calls.map((call) => call.tool)).filter(Boolean))];
    if (tools.length > 0) parts.tools = tools;
  }
  if (raw.escalate !== undefined) {
    const items = list(problems, `${where}.escalate`, raw.escalate, { min: 1, max: FLOW_LIMITS.maxEscalate, of: '条件の' }) ?? [];
    parts.escalate = items
      .map((item, i) => {
        const at = `${where}.escalate[${i}]`;
        if (!isPlainObject(item)) {
          problems.add(at, '{ "id": …, "when": { … }, "to": 人の参加者, "tell": 文 } の形で書いてください');
          return null;
        }
        checkKeys(problems, at, item, ESCALATE_KEYS);
        return {
          id: named(problems, `${at}.id`, item.id, /^[a-z][a-z0-9-]{0,39}$/, { hint: '英小文字で始め、英小文字、数字、- だけで 40 字まで' }),
          when: parseWhen(problems, `${at}.when`, item.when),
          to: named(problems, `${at}.to`, item.to, /^[a-z][a-z0-9-]{0,39}$/, { hint: '人の参加者の id' }),
          tell: tellOf(problems, `${at}.tell`, item.tell, { required: true }),
        };
      })
      .filter(Boolean);
    unique(problems, `${where}.escalate`, parts.escalate.map((item) => item.id), '条件の id');
  }
  return parts;
}

// 流れが指すもの(段、項目、ツール、結果の名前、人の参加者、辺)が、あってつながっているかを確かめる。
// 書く処理のツールは、同意の後にしか動かないことを、書いた時点で確かめる
export function checkFlowParts(problems, at, participant, { definition, composition, toolset, toolByName, byId, edge }) {
  const { flow, escalate } = participant;
  if (!flow && !escalate) return;
  // harness の設定が読めないときは、そちらの誤りを先に直してもらう
  if (!definition) return;
  const steps = definition.flow.steps.map((step) => step.id);
  const fields = new Set(definition.fields.map((field) => field.key));
  const results = new Set((flow ?? []).flatMap((entry) => entry.calls.map((call) => call.as)).filter(Boolean));
  const flowTools = new Set((flow ?? []).flatMap((entry) => entry.calls.map((call) => call.tool)));
  const hasStep = (where, id, label) => {
    if (id && !steps.includes(id)) problems.add(where, `「${id}」は ${show(participant.ai)} にない段です(${label})`);
  };
  const hasField = (where, name) => {
    if (name && !fields.has(name)) problems.add(where, `「${name}」は app/${participant.ai} の fields にない項目です`);
  };
  const hasResult = (where, name) => {
    if (name && !results.has(name)) problems.add(where, `「${name}」は、この流れの as にない結果の名前です`);
  };
  const checkTell = (where, tell) => {
    for (const [, from, name] of (tell ?? '').matchAll(/\{(state|result)\.([A-Za-z]\w*)/g)) {
      if (from === 'state') hasField(where, name);
      else hasResult(where, name);
    }
  };

  for (const [i, entry] of (flow ?? []).entries()) {
    const where = `${at}.flow[${i}]`;
    hasStep(`${where}.step`, entry.step, '呼ぶ段');
    if (entry.step === steps[0]) problems.add(`${where}.step`, `「${entry.step}」は最初の段です。入る前の発言がないので、ツールは次の段から呼んでください`);
    if (entry.then && entry.then !== END_STEP) hasStep(`${where}.then`, entry.then, '通ったときに移る段');
    if (entry.onFail) {
      if (entry.onFail.to === END_STEP) problems.add(`${where}.onFail.to`, `失敗のときに "${END_STEP}" には移れません。人に渡すときは escalate の toolFailed を書いてください`);
      else if (entry.onFail.to === entry.step) problems.add(`${where}.onFail.to`, '失敗のときに自分の段には移れません。同じターンに呼び直さないので、値を聞き直す段か確かめる段を書いてください');
      else hasStep(`${where}.onFail.to`, entry.onFail.to, '失敗したときに移る段');
      for (const [j, name] of entry.onFail.clear.entries()) hasField(`${where}.onFail.clear[${j}]`, name);
      checkTell(`${where}.onFail.tell`, entry.onFail.tell);
    }
    checkTell(`${where}.tell`, entry.tell);
    // 置き換えの前の長さで見る。書いた文だけで返事の上限を超えると、言い方がいつもやり直しになるため
    for (const [label, body] of [['tell', entry.tell], ['onFail.tell', entry.onFail?.tell]]) {
      if (body && body.length > definition.rules.maxReplyChars) problems.add(`${where}.${label}`, `app/${participant.ai} の rules.maxReplyChars(${definition.rules.maxReplyChars} 文字)より長いので、返事に入りません`);
    }
    for (const [j, call] of entry.calls.entries()) {
      const callAt = `${where}.calls[${j}]`;
      if (composition.tools === null) {
        problems.add(`${callAt}.tool`, '構成の tools で、ツールの宣言のファイルを指してください');
        continue;
      }
      const tool = toolByName.get(call.tool);
      if (!tool) {
        if (toolset) problems.add(`${callAt}.tool`, `「${call.tool}」は app/${toolset.file} にないツールです`);
        continue;
      }
      if (tool.do.op === 'handoff') problems.add(`${callAt}.tool`, '流れから引き継ぎのツールは呼べません。人に渡すときは escalate に書いてください');
      if (tool.do.op === 'delegate') problems.add(`${callAt}.tool`, '流れから委任のツールは呼べません。委任は agent の参加者だけが使えます');
      for (const name of tool.inputSchema?.required ?? []) {
        if (!Object.hasOwn(call.args, name)) problems.add(`${callAt}.args`, `「${call.tool}」に要る引数「${name}」がありません`);
      }
      for (const [name, arg] of Object.entries(call.args)) {
        if (!Object.hasOwn(tool.inputSchema?.properties ?? {}, name)) problems.add(`${callAt}.args.${name}`, `「${call.tool}」の inputSchema にない引数です`);
        if (isPlainObject(arg) && Object.hasOwn(arg, 'state')) hasField(`${callAt}.args.${name}.state`, arg.state);
        if (isPlainObject(arg) && Object.hasOwn(arg, 'result')) hasResult(`${callAt}.args.${name}.result`, arg.result);
      }
    }
    // この段に入る道。ai.json の遷移と、流れの then と onFail
    const moves = definition.flow.steps.flatMap((step) => step.next.filter((item) => item.to === entry.step));
    const codeMoves = (flow ?? []).filter((other) => other.then === entry.step || other.onFail?.to === entry.step);
    if (steps.includes(entry.step) && entry.step !== steps[0] && moves.length === 0 && codeMoves.length === 0) {
      problems.add(`${where}.step`, `段「${entry.step}」に入る遷移がないので、ツールが呼ばれません`);
    }
    // 守り(requires)のない書くツールは、「はい」と言われた遷移からしか入れない段でだけ呼べる
    const unguarded = entry.calls.filter((call) => {
      const tool = toolByName.get(call.tool);
      return tool?.do.op === 'record' && !tool.guards?.requires?.length;
    });
    if (unguarded.length > 0 && (codeMoves.length > 0 || moves.some((item) => item.when.intent !== 'yes'))) {
      problems.add(where, `書くツール(${unguarded.map((call) => call.tool).join('、')})は、同意の前に動かないように、入る遷移を全部 "intent": "yes" にするか、ツールの guards.requires を書いてください`);
    }
  }

  for (const [i, item] of (escalate ?? []).entries()) {
    const where = `${at}.escalate[${i}]`;
    const target = byId.get(item.to);
    if (!target) problems.add(`${where}.to`, `「${item.to}」は participants にない参加者です`);
    else if (target.kind !== 'human') problems.add(`${where}.to`, '渡す先は human の参加者だけです(AI から AI への引き継ぎは、固定の流れでは書けません)');
    else if (!edge(participant.id, item.to)) problems.add(`${where}.to`, `人に渡すのも引き継ぎです。handoffs に { "from": "${participant.id}", "to": "${item.to}" } を書いてください`);
    if (composition.limits.maxHandoffs === 0) problems.add(`${where}.to`, 'limits.maxHandoffs が 0 なので、人に渡せません');
    checkTell(`${where}.tell`, item.tell);
    const { unreadAfter, toolFailed, fieldIs, resultIs } = item.when ?? {};
    if (unreadAfter) hasField(`${where}.when.unreadAfter.field`, unreadAfter.field);
    if (toolFailed && !flowTools.has(toolFailed.tool)) problems.add(`${where}.when.toolFailed.tool`, `「${toolFailed.tool}」は、この流れが呼ばないツールです`);
    if (fieldIs) {
      hasField(`${where}.when.fieldIs.field`, fieldIs.field);
      const field = definition.fields.find((candidate) => candidate.key === fieldIs.field);
      const normalized = field ? normalizeValue(field, fieldIs.equals) : undefined;
      if (field && (normalized === undefined || normalized === null)) problems.add(`${where}.when.fieldIs.equals`, `${show(fieldIs.equals)} は「${field.label}」の決まりに合わない値です`);
      // 動くときは状態の値と比べるので、同じ形にそろえる
      else if (field) fieldIs.equals = normalized;
    }
    if (resultIs) hasResult(`${where}.when.resultIs.result`, resultIs.result);
  }
}
