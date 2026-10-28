import { redact, redactDeep } from '../redact.js';
import { ConnectionError } from './claude-code.js';
import { formatValue, normalizeValue } from './definition.js';
import { checkProgress, shownValue, startProgress, turn } from './harness.js';
import { CALL_LIMITS, ProjectCallWindow, TURN_LIMITS, createTurnMeter } from './limits.js';
import { createMockConnection } from './mock.js';
import { RealAiConsent } from '../real-ai.js';

export const SESSION_LIMITS = {
  maxTextLength: 500,
  maxMessages: 200,
  // 費用のかかる接続(Claude Code)の応答(有料のターン)は、1 つの会話でこの回数まで。試作品のコードが勝手に送り続けても止まる。
  // 1 ターンの呼び出しと、プロジェクトごとの 1 時間の呼び出しの上限は limits.js の CALL_LIMITS
  maxPaidReplies: 30,
  // 実行の記録は、試作品ごとに新しい方からこの件数まで。AI に渡した本文は、この文字数まで残す。
  // 観察の会話の記録は、利用者の会話の記録とは別に数える(観察で利用者の記録を押し出さない)
  maxTraceEntries: 50,
  maxTraceText: 20_000,
  // 1 つの観察の会話の記録は、古い方からこの件数まで(観察の report の ai に入れる)
  maxObservationEntries: 100,
};

// 利用者の試す画面の会話の ID。観察の会話は、観察ごとに別の ID を持つ(docs/design/harness.md の 3.4)
export const USER_CONVERSATION = 'user';

// 会話は「プロジェクトと会話の ID」で分ける
const slotOf = (projectId, conversation) => JSON.stringify([projectId, conversation]);

function freshSession(definition, key) {
  return {
    key,
    definition,
    busy: false,
    controller: null,
    state: { ...definition.initialState },
    // harness の進み具合(今の段、ターンの数、終わったか)
    progress: startProgress(definition),
    messages: definition.mock.greeting ? [{ role: 'assistant', text: definition.mock.greeting }] : [],
  };
}

const MESSAGE_ROLES = new Set(['user', 'assistant', 'correction']);

// ディスクから読んだ会話と状態を、設定の決まりで確かめ直す。版のファイルは手で直され得るため
function checkSnapshot(definition, snapshot) {
  const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
  if (!isObject(snapshot) || !isObject(snapshot.state) || !Array.isArray(snapshot.messages)) return null;
  if (snapshot.messages.length > SESSION_LIMITS.maxMessages) return null;
  const state = { ...definition.initialState };
  for (const [key, value] of Object.entries(snapshot.state)) {
    const field = definition.fields.find((f) => f.key === key);
    const normalized = field ? normalizeValue(field, value) : undefined;
    if (normalized === undefined) return null;
    state[key] = normalized;
  }
  const messages = [];
  for (const message of snapshot.messages) {
    if (!isObject(message) || !MESSAGE_ROLES.has(message.role) || typeof message.text !== 'string' || message.text.length > 4000) return null;
    if (message.role === 'user') {
      messages.push({ role: message.role, text: message.text });
      continue;
    }
    if (message.role === 'assistant') {
      // どの接続が応答したか、待った時間、費用の目安も戻す。有料の応答の回数と、画面の表示に使う
      const assistant = { role: 'assistant', text: message.text };
      if (message.via !== undefined) {
        if (typeof message.via !== 'string' || !/^[a-z0-9-]{1,32}$/.test(message.via)) return null;
        assistant.via = message.via;
      }
      for (const key of ['elapsedMs', 'costUsd']) {
        if (message[key] === undefined) continue;
        if (!Number.isFinite(message[key]) || message[key] < 0) return null;
        assistant[key] = message[key];
      }
      messages.push(assistant);
      continue;
    }
    if (!Array.isArray(message.changes)) return null;
    const changes = [];
    for (const change of message.changes) {
      const field = isObject(change) ? definition.fields.find((f) => f.key === change.key) : null;
      if (!field) return null;
      const from = change.from === undefined ? null : normalizeValue(field, change.from);
      const to = normalizeValue(field, change.to);
      if (from === undefined || to === undefined) return null;
      changes.push({ key: field.key, label: field.label, from, to });
    }
    messages.push({ role: 'correction', text: message.text, changes });
  }
  // 進み具合のない版(#307 より前の保存)は、最初の段から、発言の数をターンとして始める
  const turns = Math.min(messages.filter((m) => m.role === 'user').length, definition.flow.maxTurns);
  const progress = snapshot.progress === undefined ? { ...startProgress(definition), turns } : checkProgress(definition, snapshot.progress);
  if (!progress) return null;
  return { state, messages, progress };
}

export class AiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }

  // 非エンジニアにわかる、次にすること。決まっていない失敗(設定の誤りなど)は、メッセージに書いてある
  get next() {
    return this.nextText ?? NEXT_ACTIONS[this.code] ?? (this.code === 'connection' ? GENERIC_NEXT : undefined);
  }
}

// 失敗ごとの、次にすること。画面の言葉で書く。type は発言(reply)か修正(correction)か
const NEXT_ACTIONS = {
  cancelled: 'Studio の画面で止めました。試作品の欄に書いた文は残っているので、もう一度送れます。',
  reset: '応答を待つ間に会話を最初に戻したので、届いた応答は捨てました。もう一度送ってください。',
  limit: '時間をおいてから送り直すか、「試す」の上の「AI」でモックに戻してください。会話はそのままです。',
  budget: '「会話を最初から」で会話を短くしてから送るか、「試す」の上の「AI」でモックに戻してください。',
  timeout: 'もう一度送ってください。続くときは、「試す」の上の「AI」でモックに戻してください。',
  auth: 'ターミナルで claude を起動し、ログインしてから、もう一度送ってください。Studio はログインの情報を扱いません。',
  'not-found': 'Claude Code を入れてください。別の場所にあるときは、STUDIO_CLAUDE_BIN にその場所を書いて Studio を起動し直してください。',
  'paid-limit': '「会話を最初から」でやり直すか、「試す」の上の「AI」でモックに戻してください。',
  'turn-limit': 'もう一度送ってください。続くときは、「試す」の上の「AI」でモックに戻して試し、この記録を開発の担当者に見せてください。',
  'project-limit': '時間をおいてから送るか、「試す」の上の「AI」でモックに戻してください。会話はそのままです。',
  'too-long': '「会話を最初から」を押して、やり直してください。',
  busy: '前の応答が届くまで待ってください。急ぐときは、下の「詳細」の「応答を止める」を押してください。',
  'reply:invalid': `空でない、${SESSION_LIMITS.maxTextLength} 文字までの文を送ってください。`,
  'correction:invalid':
    '選べる値に直してください。試作品の画面が選べない値を送っているときは、「言葉で直す」欄で直す依頼をするか、app/ai.json の選択肢を確かめてください。',
};
const GENERIC_NEXT = 'もう一度送ってください。続くときは、「試す」の上の「AI」でモックに戻して試し、この記録を開発の担当者に見せてください。';

export function nextAction(code, type = 'reply') {
  return NEXT_ACTIONS[`${type}:${code}`] ?? NEXT_ACTIONS[code] ?? GENERIC_NEXT;
}

const clip = (text) =>
  typeof text === 'string' && text.length > SESSION_LIMITS.maxTraceText
    ? `${text.slice(0, SESSION_LIMITS.maxTraceText)}\n…(ここから先、${text.length - SESSION_LIMITS.maxTraceText} 文字は記録に残していません)`
    : text;

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

// 記録に残す段ごとの中身。接続が返した長い値は切る
function clipStages(stages) {
  const clipped = structuredClone(stages);
  if (clipped.extract?.output) clipped.extract.output.updates = clip(JSON.stringify(clipped.extract.output.updates));
  if (clipped.phrase?.stdin) clipped.phrase.stdin = clip(clipped.phrase.stdin);
  if (clipped.phrase?.retryStdin) clipped.phrase.retryStdin = clip(clipped.phrase.retryStdin);
  return clipped;
}

// 実行の記録に出す接続。実際の AI モデルかどうか(real)を必ず付ける
const connectionOfRecord = (connection) => ({ kind: connection.kind, label: connection.label, real: Boolean(connection.billing) });

// 接続の失敗を、試作品と Studio 画面に返す形にする
const CONNECTION_ERRORS = {
  cancelled: [409, 'cancelled'],
  limit: [429, 'limit'],
  budget: [429, 'budget'],
  timeout: [504, 'timeout'],
  auth: [502, 'auth'],
  'not-found': [502, 'not-found'],
  'turn-limit': [429, 'turn-limit'],
  'project-limit': [429, 'project-limit'],
};

// プロダクト内 AI の会話と状態を、プロジェクトごとにサーバーで持つ(ADR-0001 の「試す」)。
// 1 ターンは harness(harness.js の turn)が回す。接続(モック、Claude Code)は抽出と言い方だけを返し、
// 値の検査、状態の更新、段の遷移、終わるかは harness が決める。記録、上限、リセットはここで必ず行う。
// 接続はプロジェクトごとに選ぶ。既定はモック。切り替えても会話と状態はそのまま引き継ぐ。
// 会話は「プロジェクトと会話の ID」で分ける。利用者の会話は USER_CONVERSATION。観察の会話は観察ごとに新しく作り、
// 終わったら消す(S15)。観察の会話は、利用者の会話、選んだ接続、試し直しの前の会話に触れない。
// 作業中の会話はメモリーにだけ置く。Studio を止めると消える。残すときは版として保存する(versions.js)。
// 設定が変わって会話が最初に戻ったら、前の会話を 1 つ覚えておき、同じ発言と修正を新しい設定で送り直せる(試し直す、#279)。
export class AiSessions {
  // dataNumbersOf は、表示中の版の架空のデータに出てくる数(返事の noNewNumbers の確かめに使う)。turnDeadlineMs は 1 ターンの期限。
  // consent は本物の AI を使う前の同意(real-ai.js)。Studio では直す AI と同じものを渡す。渡さなければ、同意していない状態から始まる
  constructor({
    definitionOf,
    dataNumbersOf = () => [],
    connections = [createMockConnection()],
    projectCalls = new ProjectCallWindow(),
    turnDeadlineMs = TURN_LIMITS.deadlineMs,
    consent = new RealAiConsent(),
  }) {
    this.definitionOf = definitionOf;
    this.consent = consent;
    this.dataNumbersOf = dataNumbersOf;
    this.turnDeadlineMs = turnDeadlineMs;
    this.connections = new Map(connections.map((connection) => [connection.kind, connection]));
    this.defaultKind = connections[0].kind;
    // 会話。slotOf(プロジェクト, 会話の ID) で引く
    this.sessions = new Map();
    // 開いている観察の会話。接続は観察を始めたときに決め、利用者の選んだ接続とは別にする
    this.observations = new Map();
    this.observationSeq = 0;
    // 選んだ接続は、リセットしても変えない
    this.selected = new Map();
    // 設定が変わる前の、最後の会話。リセットしても消さない
    this.previous = new Map();
    // 実行の記録(#277)。試作品ごとに、リセットしても残す。メモリーにだけ置き、Studio を止めると消える
    this.traces = new Map();
    this.traceSeq = 0;
    // 実モデルの呼び出しの時刻。プロジェクトごとに、観察の会話も含めて数える(CALL_LIMITS.perProject)
    this.projectCalls = projectCalls;
  }

  // 記録に足す。秘密らしい文字列と、要らない個人のデータは、ここで伏せてから残す
  // 観察の会話の記録には「観察から」の印(observation に観察の会話の ID)を付け、その観察の記録にも足す
  record(projectId, entry, conversation = USER_CONVERSATION) {
    const list = this.traces.get(projectId) ?? [];
    const observation = this.observations.get(slotOf(projectId, conversation));
    const recorded = { id: ++this.traceSeq, at: new Date().toISOString(), ...redactDeep(entry) };
    if (observation) recorded.observation = conversation;
    list.push(recorded);
    const sameKind = (item) => Boolean(item.observation) === Boolean(observation);
    if (list.filter(sameKind).length > SESSION_LIMITS.maxTraceEntries) list.splice(list.findIndex(sameKind), 1);
    this.traces.set(projectId, list);
    if (observation && observation.entries.length < SESSION_LIMITS.maxObservationEntries) observation.entries.push(recorded);
    return recorded;
  }

  // 記録を、新しい方から返す
  trace(projectId) {
    this.definition(projectId);
    return {
      entries: (this.traces.get(projectId) ?? []).map((entry) => structuredClone(entry)).reverse(),
      limits: { maxEntries: SESSION_LIMITS.maxTraceEntries },
    };
  }

  clearTrace(projectId) {
    this.definition(projectId);
    this.traces.delete(projectId);
    return this.trace(projectId);
  }

  // 失敗を記録に書く。次にすることも付ける
  static fail(entry, error, type) {
    const code = error?.code ?? 'connection';
    entry.status = code === 'cancelled' || code === 'reset' ? 'cancelled' : 'failed';
    entry.error = { code, message: redact(String(error?.message ?? error)), next: nextAction(code, type) };
    // API の応答(試作品からの知らせ)にも、記録と同じ次にすることを付ける
    if (error instanceof AiError) error.nextText = entry.error.next;
    // 起動できなかったとき、上限などで 1 回も呼ばずに止めたときは、渡すはずだったものを、送っていないと記録する
    if (entry.input && (code === 'not-found' || entry.calls?.count === 0)) entry.input.notSent = true;
  }

  // 終わった観察の会話には書かない(利用者の記録に、印のない記録を残さないため)
  checkConversation(projectId, conversation) {
    if (conversation !== USER_CONVERSATION && !this.observations.has(slotOf(projectId, conversation))) {
      throw new AiError(409, 'closed', 'この観察の会話はもう終わっています');
    }
  }

  connectionOf(projectId, conversation = USER_CONVERSATION) {
    const observation = this.observations.get(slotOf(projectId, conversation));
    if (observation) return this.connections.get(observation.connection);
    return this.connections.get(this.selected.get(projectId) ?? this.defaultKind);
  }

  // 試作品の中の AI を本物の接続(費用のかかる接続)で使う前の、ただ 1 つの口。利用者の切り替え(select)と、
  // 人の「確かめる」の観察(observationConnection)が通る。選べるか(STUDIO_ALLOW_CLAUDE_CODE=0 でないか、Claude Code があるか)と、
  // 同意(real-ai.js)を確かめ、だめなら理由のコードつきで断る。モックは何も確かめない。use は同意の断りの文に使う
  useReal(connection, use = 'product') {
    if (!connection.billing) return;
    const { available, code, reason } = connection.availability?.() ?? { available: true };
    if (!available) throw new AiError(403, code ?? 'unavailable', reason);
    try {
      this.consent.require(use);
    } catch (error) {
      throw Object.assign(new AiError(403, error.code, error.message), { nextText: error.next });
    }
  }

  // 観察に使う接続。既定はモック。本物の接続は、切り替えと同じ口(useReal)で、選べるかと同意を確かめる
  observationConnection(kind = 'mock') {
    const connection = this.connections.get(kind);
    if (!connection) throw new AiError(400, 'invalid', `「${String(kind)}」という接続はありません`);
    this.useReal(connection, 'check');
    return connection;
  }

  // 観察用の新しい会話を作り、その ID を返す
  openObservation(projectId, { connection: kind = 'mock' } = {}) {
    const definition = this.definition(projectId);
    const connection = this.observationConnection(kind);
    const conversation = `observation-${++this.observationSeq}`;
    const slot = slotOf(projectId, conversation);
    this.observations.set(slot, { connection: kind, entries: [] });
    const session = freshSession(definition, JSON.stringify(definition));
    this.sessions.set(slot, session);
    // 会話の始まり(あいさつと最初の状態)を記録する
    this.record(
      projectId,
      {
        type: 'open',
        from: 'prototype',
        status: 'ok',
        connection: connectionOfRecord(connection),
        greeting: session.messages[0]?.text ?? null,
        state: this.describeState(session),
      },
      conversation,
    );
    return conversation;
  }

  // 観察の会話の記録を、古い方から返す
  observationTrace(projectId, conversation) {
    const observation = this.observations.get(slotOf(projectId, conversation));
    if (!observation) throw new AiError(404, 'closed', 'この観察の会話はもう終わっています');
    return observation.entries.map((entry) => structuredClone(entry));
  }

  // 観察が終わったら、その会話を捨てる。応答を待っていたら止める
  closeObservation(projectId, conversation) {
    const slot = slotOf(projectId, conversation);
    if (!this.observations.has(slot)) return false;
    this.sessions.get(slot)?.controller?.abort();
    this.sessions.delete(slot);
    this.observations.delete(slot);
    return true;
  }

  // 開いている会話の ID(利用者の会話も含む)。テストと調べもの用
  conversations(projectId) {
    return [...this.sessions.keys()].map((slot) => JSON.parse(slot)).filter(([id]) => id === projectId).map(([, conversation]) => conversation);
  }

  // 実行の前に Studio 画面に出す。選べる接続、選べない理由、送るもの、費用
  connectionChoices(projectId) {
    const definition = this.definition(projectId);
    const selected = this.connectionOf(projectId).kind;
    return {
      selected,
      options: [...this.connections.values()].map((connection) => ({
        kind: connection.kind,
        label: connection.label,
        description: connection.description,
        tools: connection.tools ?? null,
        ...(connection.availability?.() ?? { available: true, reason: '' }),
        billing: connection.billing ?? null,
        sends: connection.sends?.(definition) ?? null,
      })),
    };
  }

  // 同意のカードの「詳しく」に出す、試作品の中の AI を本物にしたときの中身(切り替える前の確認の中身を移したもの)。
  // 送る指示の全文、項目と選択肢、会話の件数、上限、回数の制限、道具を渡さないこと。ai.json のない試作品と、本物の接続がないときは null
  realDetails(projectId) {
    const definition = this.definitionOf(projectId);
    const connection = [...this.connections.values()].find((c) => c.billing);
    if (!definition || !connection) return null;
    const current = this.sessions.get(slotOf(projectId, USER_CONVERSATION));
    const messages = current && current.key === JSON.stringify(definition) ? current.messages : freshSession(definition, '').messages;
    const perTurn = Object.values(CALL_LIMITS.perTurn).reduce((sum, n) => sum + n, 0);
    return {
      kind: connection.kind,
      label: connection.label,
      description: connection.description,
      tools: connection.tools ?? null,
      ...(connection.availability?.() ?? { available: true, reason: '' }),
      billing: { kind: connection.billing.kind, label: connection.billing.label, text: connection.billing.text },
      sends: connection.sends(definition),
      fields: definition.fields.map((field) => ({
        label: field.label,
        ...(field.type === 'number' ? { unit: field.unit ?? null, min: field.min, max: field.max } : { options: field.options.map((o) => o.value) }),
      })),
      conversation: { messages: messages.length },
      limits: {
        perTurn,
        perProject: CALL_LIMITS.perProject,
        windowMinutes: CALL_LIMITS.windowMs / 60_000,
        perConversation: SESSION_LIMITS.maxPaidReplies,
        text: `1 ターンで ${perTurn} 回まで呼びます。試作品ごとに、観察も含めて ${CALL_LIMITS.windowMs / 60_000} 分に ${CALL_LIMITS.perProject} 回まで、1 つの会話で ${SESSION_LIMITS.maxPaidReplies} 回の返事までです。`,
      },
    };
  }

  // 接続を切り替える。本物の接続へは、選べるかと同意を useReal で確かめる。
  // 同意は Studio を止めるまで有効なので、切り替えのたびの確認(前の confirmed)は求めない
  select(projectId, kind) {
    const session = this.session(projectId);
    const connection = this.connections.get(kind);
    if (!connection) throw new AiError(400, 'invalid', `「${String(kind)}」という接続はありません`);
    if (session.busy) throw new AiError(409, 'busy', 'AI が応答しています。止めるか、終わってから切り替えてください');
    this.useReal(connection, 'product');
    const before = this.connectionOf(projectId);
    this.selected.set(projectId, kind);
    if (before.kind !== kind) {
      this.record(projectId, {
        type: 'connection',
        from: 'studio',
        status: 'ok',
        connection: connectionOfRecord(connection),
        previous: connectionOfRecord(before),
      });
    }
    return this.view(projectId);
  }

  // 応答を待っている途中なら止める。止めた発言は会話に残さない
  cancel(projectId) {
    const session = this.session(projectId);
    // 試し直しの途中なら、残りの発言も送らない
    if (session.retrying) session.stopRetry = true;
    session.controller?.abort();
    return this.view(projectId);
  }

  // Studio を止めるとき。応答を待っている CLI を止め、終わるまで待つ(上限つき)
  async close() {
    for (const session of this.sessions.values()) session.controller?.abort();
    await Promise.all([...this.connections.values()].map((connection) => connection.close?.()));
  }

  definition(projectId) {
    const definition = this.definitionOf(projectId);
    if (!definition) {
      throw new AiError(404, 'no-ai', 'この試作品はプロダクト内 AI を使っていません(app/ai.json がありません)');
    }
    return definition;
  }

  // 設定(app/ai.json)が変わったビルドに切り替わったら、その設定の初期状態から始める
  // 観察の会話は、終わった後には使えない。設定が変わっても、試し直しの前の会話には入れない
  session(projectId, conversation = USER_CONVERSATION) {
    const definition = this.definition(projectId);
    const key = JSON.stringify(definition);
    const slot = slotOf(projectId, conversation);
    const user = conversation === USER_CONVERSATION;
    this.checkConversation(projectId, conversation);
    const current = this.sessions.get(slot);
    if (current && current.key === key) return current;
    current?.controller?.abort();
    // 試し直しの途中の会話は、送り直しきれていないので覚えない。元の前の会話を残す
    if (user && !current?.retrying && current?.messages.some((m) => m.role === 'user' || m.role === 'correction')) {
      this.previous.set(projectId, { name: current.definition.name, messages: current.messages.map((m) => structuredClone(m)) });
    }
    const session = freshSession(definition, key);
    this.sessions.set(slot, session);
    return session;
  }

  // 版の保存に入れる会話と状態。definition は保存するファイルの設定で、今の会話がその設定のものでなければ、
  // あるいは最初のままなら null(復元すると、その設定の初期状態から始まる)
  snapshot(projectId, definition = this.definitionOf(projectId)) {
    if (!definition) return null;
    const key = JSON.stringify(definition);
    const current = this.sessions.get(slotOf(projectId, USER_CONVERSATION));
    if (!current || current.key !== key) return null;
    const snapshot = {
      state: { ...current.state },
      messages: current.messages.map((message) => structuredClone(message)),
      progress: { ...current.progress },
    };
    const fresh = freshSession(definition, key);
    if (JSON.stringify(snapshot) === JSON.stringify({ state: fresh.state, messages: fresh.messages, progress: fresh.progress })) return null;
    return snapshot;
  }

  // 版の会話と状態に置き換える。表示中の版の設定の決まりで確かめ、合わなければ初期状態にして false を返す。
  // 応答を待っている途中でも置き換える。届いた応答は捨てる(リセットと同じ)
  restore(projectId, snapshot) {
    // 実モデルの応答を待っていたら、止めて費用を使い続けない
    const slot = slotOf(projectId, USER_CONVERSATION);
    this.sessions.get(slot)?.controller?.abort();
    this.sessions.delete(slot);
    const definition = this.definitionOf(projectId);
    if (!definition) return snapshot === null;
    const session = this.session(projectId);
    if (snapshot === null) return true;
    const checked = checkSnapshot(definition, snapshot);
    if (!checked) return false;
    session.state = checked.state;
    session.messages = checked.messages;
    session.progress = checked.progress;
    return true;
  }

  // 試し直しの途中も、発言と発言の間を含めて応答中とみなす(版の復元で、送り直しの途中の会話を取り替えない)
  isBusy(projectId) {
    const session = this.sessions.get(slotOf(projectId, USER_CONVERSATION));
    return Boolean(session?.busy || session?.retrying);
  }

  view(projectId, { conversation = USER_CONVERSATION } = {}) {
    const { definition, state, messages, busy } = this.session(projectId, conversation);
    const connection = this.connectionOf(projectId, conversation);
    return {
      connection: {
        kind: connection.kind,
        label: connection.label,
        description: connection.description,
      },
      name: definition.name,
      fields: definition.fields.map((field) =>
        field.type === 'number'
          ? { key: field.key, label: field.label, type: field.type, unit: field.unit, min: field.min, max: field.max }
          : { key: field.key, label: field.label, type: field.type, options: field.options.map((o) => o.value) },
      ),
      state: { ...state },
      messages: messages.map((message) => structuredClone(message)),
      busy,
    };
  }

  // 応答を待っている途中でも、新しい会話に取り替える。届いた応答は捨てる
  reset(projectId) {
    this.definition(projectId);
    // 実モデルの応答を待っていたら、止めて費用を使い続けない
    const slot = slotOf(projectId, USER_CONVERSATION);
    this.sessions.get(slot)?.controller?.abort();
    this.sessions.delete(slot);
    const view = this.view(projectId);
    this.record(projectId, {
      type: 'reset',
      from: 'studio',
      status: 'ok',
      connection: connectionOfRecord(this.connectionOf(projectId)),
      state: this.describeState(this.session(projectId)),
    });
    return view;
  }

  // 記録に出す状態。項目の名前と、画面と同じ書き方の値
  describeState(session) {
    return session.definition.fields.map((field) => ({ key: field.key, label: field.label, value: formatValue(field, session.state[field.key]) }));
  }

  checkRoom(session, adding) {
    if (session.messages.length + adding > SESSION_LIMITS.maxMessages) {
      throw new AiError(409, 'too-long', '会話が長くなりすぎました。Studio の「会話を最初から」でやり直してください');
    }
  }

  // Studio の画面だけに出す。試し直せる前の会話と、最後に試し直した結果
  retryInfo(projectId) {
    const session = this.session(projectId);
    const previous = this.previous.get(projectId);
    const count = (role) => previous?.messages.filter((m) => m.role === role).length ?? 0;
    return {
      available: Boolean(previous),
      name: previous?.name ?? null,
      userMessages: count('user'),
      corrections: count('correction'),
      retrying: Boolean(session.retrying),
      result: session.retried ? structuredClone(session.retried) : null,
    };
  }

  // 前の会話の発言と修正を、今の設定と今の接続で、最初から順に送り直す。今の会話は最初に戻る。
  // 応答は今の接続が返す(作る AI は動かない)。送り直すたびに、前の応答と今の応答を並べて残す
  async retry(projectId) {
    const current = this.session(projectId);
    const previous = this.previous.get(projectId);
    if (!previous) {
      throw new AiError(409, 'no-previous', '試し直す会話がありません。設定を変える前に、試す画面で AI と話してください');
    }
    if (current.busy || current.retrying) throw new AiError(409, 'busy', 'AI が応答しています。止めるか、終わってから試し直してください');
    const connection = this.connectionOf(projectId);
    const users = previous.messages.filter((m) => m.role === 'user').length;
    if (connection.billing && users > SESSION_LIMITS.maxPaidReplies) {
      throw new AiError(
        429,
        'paid-limit',
        `${connection.label} への発言は、1 つの会話で ${SESSION_LIMITS.maxPaidReplies} 回までです。試し直す発言が ${users} 件あるので、接続をモックに戻してください`,
      );
    }
    const slot = slotOf(projectId, USER_CONVERSATION);
    this.sessions.delete(slot);
    const session = this.session(projectId);
    session.retrying = true;
    const result = { from: previous.name, via: connection.kind, replies: [], skipped: [], stopped: null };
    session.retried = result;
    try {
      for (const [index, message] of previous.messages.entries()) {
        // session() で確かめる。設定が変わっていたら、ここで新しい会話に替わる(古い会話に、新しい設定の応答を書き足さない)
        if (this.session(projectId) !== session) throw new AiError(409, 'reset', '試し直す間に会話が最初に戻ったか、設定が変わりました');
        if (session.stopRetry) {
          result.stopped = '試し直しを止めました';
          break;
        }
        if (message.role === 'user') {
          const before = previous.messages[index + 1]?.role === 'assistant' ? previous.messages[index + 1] : null;
          await this.send(projectId, message.text, { replaying: true });
          const after = session.messages.at(-1);
          result.replies.push({ text: message.text, before: before?.text ?? null, beforeVia: before?.via ?? null, after: after.text, afterVia: after.via });
        } else if (message.role === 'correction') {
          const changes = {};
          for (const change of message.changes ?? []) {
            const field = session.definition.fields.find((f) => f.key === change.key);
            // 今の設定にない項目や、今の決まりに合わない値は、直さずに知らせる
            if (field && normalizeValue(field, change.to) !== undefined) changes[change.key] = change.to;
            else result.skipped.push(`${change.label}を「${change.to ?? '未定'}」に直す修正`);
          }
          if (Object.keys(changes).length > 0) this.correct(projectId, changes, { replaying: true });
        }
      }
    } catch (error) {
      // 途中で止まっても、そこまでの結果は残す。リセットや設定の切り替えで会話が替わったら、そちらを伝える
      if (!(error instanceof AiError) || this.sessions.get(slot) !== session) throw error;
      result.stopped = error.message;
    } finally {
      session.retrying = false;
      session.stopRetry = false;
    }
    return this.view(projectId);
  }

  // 利用者の発言を接続に渡す。成功も失敗も、実行の記録に残す
  // 試し直し(replaying)の発言は、Studio 画面から送ったものとして記録する。conversation は会話の ID
  async send(projectId, text, { replaying = false, conversation = USER_CONVERSATION } = {}) {
    // AI のない試作品は、記録する AI がないので記録しない
    this.definition(projectId);
    this.checkConversation(projectId, conversation);
    const connection = this.connectionOf(projectId, conversation);
    const entry = this.record(
      projectId,
      {
        type: 'reply',
        from: replaying ? 'studio' : 'prototype',
        status: 'running',
        connection: connectionOfRecord(connection),
        text: typeof text === 'string' ? text.trim().slice(0, SESSION_LIMITS.maxTextLength) : '',
      },
      conversation,
    );
    const started = Date.now();
    try {
      return await this.reply(projectId, connection, text, entry, { replaying, conversation });
    } catch (error) {
      AiSessions.fail(entry, error, 'reply');
      throw error;
    } finally {
      entry.elapsedMs = Date.now() - started;
    }
  }

  async reply(projectId, connection, text, entry, { replaying, conversation }) {
    if (typeof text !== 'string' || text.trim() === '') throw new AiError(400, 'invalid', '話す内容を書いてください');
    if (text.length > SESSION_LIMITS.maxTextLength) {
      throw new AiError(400, 'invalid', `${SESSION_LIMITS.maxTextLength} 文字までにしてください`);
    }
    const slot = slotOf(projectId, conversation);
    const session = this.session(projectId, conversation);
    if (session.busy) throw new AiError(409, 'busy', 'AI が前の発言に応答しています。少し待ってください');
    if (session.retrying && !replaying) throw new AiError(409, 'busy', '前の会話を試し直しています。終わるまで待ってください');
    this.checkRoom(session, 2);
    if (connection.billing) {
      const paid = session.messages.filter((m) => m.role === 'assistant' && m.via === connection.kind).length;
      if (paid >= SESSION_LIMITS.maxPaidReplies) {
        throw new AiError(
          429,
          'paid-limit',
          `${connection.label} への発言は、1 つの会話で ${SESSION_LIMITS.maxPaidReplies} 回までです。Studio の「会話を最初から」でやり直すか、接続をモックに戻してください`,
        );
      }
    }
    const input = {
      definition: session.definition,
      state: { ...session.state },
      messages: session.messages.map((message) => structuredClone(message)),
      text: text.trim(),
    };
    // 接続に渡すものを、送る前に記録する。応答を待つ間も、失敗しても見られる
    const described = connection.describe?.(input) ?? {};
    entry.input = redactDeep({
      ...described,
      systemPrompt: clip(described.systemPrompt),
      stdin: clip(described.stdin),
      ...(described.phrase ? { phrase: { ...described.phrase, systemPrompt: clip(described.phrase.systemPrompt) } } : {}),
      history: input.messages.length,
      state: this.describeState(session),
    });
    session.busy = true;
    session.controller = new AbortController();
    const started = Date.now();
    // 段ごとの中身(抽出、決定、言い方)。失敗しても、そこまでを記録に残す
    const stages = {};
    // 費用のかかる接続の呼び出しを数える。1 ターンの上限と、プロジェクトごとの上限(観察の会話も同じ projectId で数える)。
    // プロジェクトの残りが抽出と言い方の 2 回に足りなければ、呼ぶ前に止める(抽出だけ呼んで捨てないため)
    const meter = connection.billing ? createTurnMeter({ perTurn: CALL_LIMITS.perTurn, take: () => this.projectCalls.take(projectId) }) : null;
    let result;
    try {
      if (meter) this.projectCalls.ensure(projectId, 2);
      result = await turn({
        connection,
        ...input,
        progress: { ...session.progress },
        signal: session.controller.signal,
        meter,
        trace: stages,
        dataNumbers: this.dataNumbersOf(projectId) ?? [],
        deadlineMs: this.turnDeadlineMs,
      });
    } catch (error) {
      // 応答を待つ間にリセットや設定の切り替えがあったら、そちらを伝える
      if (this.sessions.get(slot) !== session) throw new AiError(409, 'reset', '応答を待つ間に会話が最初に戻りました');
      if (error instanceof ConnectionError && Object.hasOwn(CONNECTION_ERRORS, error.code)) {
        const [status, code] = CONNECTION_ERRORS[error.code];
        throw new AiError(status, code, error.message);
      }
      throw new AiError(502, 'connection', `AI から応答を受け取れませんでした: ${error.message}`);
    } finally {
      session.busy = false;
      session.controller = null;
      entry.harness = redactDeep(clipStages(stages));
      // 呼び出しの回数と待ち時間(jyoka/tasks#314 で速さを測るため)。失敗しても、そこまでの呼び出しを残す
      if (meter) entry.calls = meter.summary();
    }
    // 応答を待つ間にリセットや設定の切り替えがあったら、古い会話に書き足さない
    if (this.sessions.get(slot) !== session) throw new AiError(409, 'reset', '応答を待つ間に会話が最初に戻りました');
    const { reply } = result;
    const changes = session.definition.fields
      .filter((field) => session.state[field.key] !== result.state[field.key])
      .map((field) => ({ key: field.key, label: field.label, from: formatValue(field, session.state[field.key]), to: formatValue(field, result.state[field.key]) }));
    session.state = result.state;
    session.progress = result.progress;
    // どの接続が応答したかを残す。切り替えた後も、前の応答がどちらのものか分かる
    // 応答の速さは、利用者が待った時間(CLI の起動を含む)で測る
    const assistant = { role: 'assistant', text: reply, via: connection.kind, elapsedMs: Date.now() - started };
    // CLI の報告。実モデルの接続は、このターンの呼び出しの合計
    const meta = entry.calls ?? result.meta ?? {};
    if (Number.isFinite(meta.costUsd)) assistant.costUsd = meta.costUsd;
    session.messages.push({ role: 'user', text: text.trim() }, assistant);
    const updates = isPlainObject(result.raw?.updates) ? result.raw.updates : {};
    Object.assign(
      entry,
      redactDeep({
        status: 'ok',
        output: {
          reply,
          updates: clip(JSON.stringify(updates)),
          format: meta.format ?? null,
          costUsd: Number.isFinite(meta.costUsd) ? meta.costUsd : null,
          durationMs: Number.isFinite(meta.durationMs) ? meta.durationMs : null,
        },
        changes,
        rejected: result.extraction.rejected,
      }),
    );
    return this.view(projectId, { conversation });
  }

  // 本人が、AI の理解した状態を直す。次の応答はこの記録を踏まえる。成功も失敗も、実行の記録に残す
  correct(projectId, changes, { replaying = false, conversation = USER_CONVERSATION } = {}) {
    this.definition(projectId);
    this.checkConversation(projectId, conversation);
    const entry = this.record(
      projectId,
      {
        type: 'correction',
        from: replaying ? 'studio' : 'prototype',
        status: 'running',
        connection: connectionOfRecord(this.connectionOf(projectId, conversation)),
        requested: isPlainObject(changes)
          ? Object.entries(changes)
              .slice(0, 20)
              .map(([key, value]) => ({ key: key.slice(0, 64), value: shownValue(value) }))
          : [],
      },
      conversation,
    );
    try {
      const applied = this.applyCorrection(projectId, changes, { replaying, conversation });
      Object.assign(entry, redactDeep({ status: 'ok', changes: applied }));
      return this.view(projectId, { conversation });
    } catch (error) {
      AiSessions.fail(entry, error, 'correction');
      throw error;
    }
  }

  applyCorrection(projectId, changes, { replaying, conversation }) {
    if (!isPlainObject(changes) || Object.keys(changes).length === 0) {
      throw new AiError(400, 'invalid', '直す項目を { 項目の key: 値 } の形で渡してください');
    }
    const session = this.session(projectId, conversation);
    if (session.busy) throw new AiError(409, 'busy', 'AI が応答しています。終わってから直してください');
    if (session.retrying && !replaying) throw new AiError(409, 'busy', '前の会話を試し直しています。終わるまで待ってください');
    const { fields } = session.definition;
    const applied = [];
    for (const [key, value] of Object.entries(changes)) {
      const field = fields.find((f) => f.key === key);
      if (!field) throw new AiError(400, 'invalid', `「${key}」という項目はありません`);
      const normalized = normalizeValue(field, value);
      if (normalized === undefined) throw new AiError(400, 'invalid', `${field.label}に「${String(value)}」は使えません`);
      if (session.state[key] !== normalized) applied.push({ field, from: session.state[key], to: normalized });
    }
    if (applied.length === 0) return [];
    this.checkRoom(session, 1);
    for (const { field, to } of applied) session.state[field.key] = to;
    session.messages.push({
      role: 'correction',
      text: `${applied.map(({ field, to }) => (to === null ? `${field.label}を未定に戻しました` : `${field.label}を「${formatValue(field, to)}」に直しました`)).join('。')}。`,
      changes: applied.map(({ field, from, to }) => ({ key: field.key, label: field.label, from, to })),
    });
    return applied.map(({ field, from, to }) => ({ key: field.key, label: field.label, from: formatValue(field, from), to: formatValue(field, to) }));
  }
}
