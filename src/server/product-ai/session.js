import { redact, redactDeep } from '../redact.js';
import { ConnectionError } from './claude-code.js';
import { formatValue, normalizeValue } from './definition.js';
import { createMockConnection } from './mock.js';

export const SESSION_LIMITS = {
  maxTextLength: 500,
  maxMessages: 200,
  // 費用のかかる接続(Claude Code)の応答は、1 つの会話でこの回数まで。試作品のコードが勝手に送り続けても止まる
  maxPaidReplies: 30,
  // 実行の記録は、試作品ごとに新しい方からこの件数まで。AI に渡した本文は、この文字数まで残す
  maxTraceEntries: 50,
  maxTraceText: 20_000,
};

function freshSession(definition, key) {
  return {
    key,
    definition,
    busy: false,
    controller: null,
    state: { ...definition.initialState },
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
  return { state, messages };
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
  limit: '時間をおいてから送り直すか、右の「接続を選ぶ」でモックに戻してください。会話はそのままです。',
  budget: '「リセット」で会話を短くしてから送るか、右の「接続を選ぶ」でモックに戻してください。',
  timeout: 'もう一度送ってください。続くときは、右の「接続を選ぶ」でモックに戻してください。',
  auth: 'ターミナルで claude を起動し、ログインしてから、もう一度送ってください。Studio はログインの情報を扱いません。',
  'not-found': 'Claude Code を入れてください。別の場所にあるときは、STUDIO_CLAUDE_BIN にその場所を書いて Studio を起動し直してください。',
  'paid-limit': '「リセット」で会話を最初からやり直すか、右の「接続を選ぶ」でモックに戻してください。',
  'too-long': '「リセット」で会話を最初からやり直してください。',
  busy: '前の応答が届くまで待ってください。急ぐときは、右の「応答を止める」を押してください。',
  'reply:invalid': `空でない、${SESSION_LIMITS.maxTextLength} 文字までの文を送ってください。`,
  'correction:invalid':
    '選べる値に直してください。試作品の画面が選べない値を送っているときは、「作る」欄で直す依頼をするか、app/ai.json の選択肢を確かめてください。',
};
const GENERIC_NEXT = 'もう一度送ってください。続くときは、右の「接続を選ぶ」でモックに戻して試し、この記録を開発の担当者に見せてください。';

export function nextAction(code, type = 'reply') {
  return NEXT_ACTIONS[`${type}:${code}`] ?? NEXT_ACTIONS[code] ?? GENERIC_NEXT;
}

const clip = (text) =>
  typeof text === 'string' && text.length > SESSION_LIMITS.maxTraceText
    ? `${text.slice(0, SESSION_LIMITS.maxTraceText)}\n…(ここから先、${text.length - SESSION_LIMITS.maxTraceText} 文字は記録に残していません)`
    : text;

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

// 記録に出す、決まりに合わなかった値
const shownValue = (value) => (typeof value === 'string' ? value : JSON.stringify(value) ?? String(value)).slice(0, 100);

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
};

// プロダクト内 AI の会話と状態を、プロジェクトごとにサーバーで持つ(ADR-0001 の「試す」)。
// 応答の中身は接続(モック、Claude Code)が決め、値の検査、状態の更新、記録、リセットはここで必ず行う。
// 接続はプロジェクトごとに選ぶ。既定はモック。切り替えても会話と状態はそのまま引き継ぐ。
// 作業中の会話はメモリーにだけ置く。Studio を止めると消える。残すときは版として保存する(versions.js)。
export class AiSessions {
  constructor({ definitionOf, connections = [createMockConnection()] }) {
    this.definitionOf = definitionOf;
    this.connections = new Map(connections.map((connection) => [connection.kind, connection]));
    this.defaultKind = connections[0].kind;
    this.sessions = new Map();
    // 選んだ接続は、リセットしても変えない
    this.selected = new Map();
    // 実行の記録(#277)。試作品ごとに、リセットしても残す。メモリーにだけ置き、Studio を止めると消える
    this.traces = new Map();
    this.traceSeq = 0;
  }

  // 記録に足す。秘密らしい文字列と、要らない個人のデータは、ここで伏せてから残す
  record(projectId, entry) {
    const list = this.traces.get(projectId) ?? [];
    const recorded = { id: ++this.traceSeq, at: new Date().toISOString(), ...redactDeep(entry) };
    list.push(recorded);
    if (list.length > SESSION_LIMITS.maxTraceEntries) list.splice(0, list.length - SESSION_LIMITS.maxTraceEntries);
    this.traces.set(projectId, list);
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
    // 起動できなかったときは、渡すはずだったものを、送っていないと記録する
    if (code === 'not-found' && entry.input) entry.input.notSent = true;
  }

  connectionOf(projectId) {
    return this.connections.get(this.selected.get(projectId) ?? this.defaultKind);
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

  // 接続を切り替える。実モデルへは、送るものと費用を見たうえでの確認(confirmed)を要る
  select(projectId, kind, { confirmed = false } = {}) {
    const session = this.session(projectId);
    const connection = this.connections.get(kind);
    if (!connection) throw new AiError(400, 'invalid', `「${String(kind)}」という接続はありません`);
    if (session.busy) throw new AiError(409, 'busy', 'AI が応答しています。止めるか、終わってから切り替えてください');
    const { available, reason } = connection.availability?.() ?? { available: true };
    if (!available) throw new AiError(403, 'unavailable', reason);
    if (connection.billing && !confirmed) {
      throw new AiError(400, 'not-confirmed', '送るものと費用を確かめてから切り替えてください');
    }
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
  session(projectId) {
    const definition = this.definition(projectId);
    const key = JSON.stringify(definition);
    const current = this.sessions.get(projectId);
    if (current && current.key === key) return current;
    current?.controller?.abort();
    const session = freshSession(definition, key);
    this.sessions.set(projectId, session);
    return session;
  }

  // 版の保存に入れる会話と状態。definition は保存するファイルの設定で、今の会話がその設定のものでなければ、
  // あるいは最初のままなら null(復元すると、その設定の初期状態から始まる)
  snapshot(projectId, definition = this.definitionOf(projectId)) {
    if (!definition) return null;
    const key = JSON.stringify(definition);
    const current = this.sessions.get(projectId);
    if (!current || current.key !== key) return null;
    const snapshot = { state: { ...current.state }, messages: current.messages.map((message) => structuredClone(message)) };
    const fresh = freshSession(definition, key);
    if (JSON.stringify(snapshot) === JSON.stringify({ state: fresh.state, messages: fresh.messages })) return null;
    return snapshot;
  }

  // 版の会話と状態に置き換える。表示中の版の設定の決まりで確かめ、合わなければ初期状態にして false を返す。
  // 応答を待っている途中でも置き換える。届いた応答は捨てる(リセットと同じ)
  restore(projectId, snapshot) {
    // 実モデルの応答を待っていたら、止めて費用を使い続けない
    this.sessions.get(projectId)?.controller?.abort();
    this.sessions.delete(projectId);
    const definition = this.definitionOf(projectId);
    if (!definition) return snapshot === null;
    const session = this.session(projectId);
    if (snapshot === null) return true;
    const checked = checkSnapshot(definition, snapshot);
    if (!checked) return false;
    session.state = checked.state;
    session.messages = checked.messages;
    return true;
  }

  isBusy(projectId) {
    return Boolean(this.sessions.get(projectId)?.busy);
  }

  view(projectId) {
    const { definition, state, messages, busy } = this.session(projectId);
    const connection = this.connectionOf(projectId);
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
    this.sessions.get(projectId)?.controller?.abort();
    this.sessions.delete(projectId);
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
      throw new AiError(409, 'too-long', '会話が長くなりすぎました。Studio の「リセット」で最初からやり直してください');
    }
  }

  // 利用者の発言を接続に渡す。成功も失敗も、実行の記録に残す
  async send(projectId, text) {
    // AI のない試作品は、記録する AI がないので記録しない
    this.definition(projectId);
    const connection = this.connectionOf(projectId);
    const entry = this.record(projectId, {
      type: 'reply',
      from: 'prototype',
      status: 'running',
      connection: connectionOfRecord(connection),
      text: typeof text === 'string' ? text.trim().slice(0, SESSION_LIMITS.maxTextLength) : '',
    });
    const started = Date.now();
    try {
      return await this.reply(projectId, connection, text, entry);
    } catch (error) {
      AiSessions.fail(entry, error, 'reply');
      throw error;
    } finally {
      entry.elapsedMs = Date.now() - started;
    }
  }

  async reply(projectId, connection, text, entry) {
    if (typeof text !== 'string' || text.trim() === '') throw new AiError(400, 'invalid', '話す内容を書いてください');
    if (text.length > SESSION_LIMITS.maxTextLength) {
      throw new AiError(400, 'invalid', `${SESSION_LIMITS.maxTextLength} 文字までにしてください`);
    }
    const session = this.session(projectId);
    if (session.busy) throw new AiError(409, 'busy', 'AI が前の発言に応答しています。少し待ってください');
    this.checkRoom(session, 2);
    if (connection.billing) {
      const paid = session.messages.filter((m) => m.role === 'assistant' && m.via === connection.kind).length;
      if (paid >= SESSION_LIMITS.maxPaidReplies) {
        throw new AiError(
          429,
          'paid-limit',
          `${connection.label} への発言は、1 つの会話で ${SESSION_LIMITS.maxPaidReplies} 回までです。Studio の「リセット」で最初からやり直すか、接続をモックに戻してください`,
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
      history: input.messages.length,
      state: this.describeState(session),
    });
    session.busy = true;
    session.controller = new AbortController();
    const started = Date.now();
    let result;
    try {
      result = await connection.respond({ ...input, signal: session.controller.signal });
    } catch (error) {
      // 応答を待つ間にリセットや設定の切り替えがあったら、そちらを伝える
      if (this.sessions.get(projectId) !== session) throw new AiError(409, 'reset', '応答を待つ間に会話が最初に戻りました');
      if (error instanceof ConnectionError && Object.hasOwn(CONNECTION_ERRORS, error.code)) {
        const [status, code] = CONNECTION_ERRORS[error.code];
        throw new AiError(status, code, error.message);
      }
      throw new AiError(502, 'connection', `AI から応答を受け取れませんでした: ${error.message}`);
    } finally {
      session.busy = false;
      session.controller = null;
    }
    // 応答を待つ間にリセットや設定の切り替えがあったら、古い会話に書き足さない
    if (this.sessions.get(projectId) !== session) throw new AiError(409, 'reset', '応答を待つ間に会話が最初に戻りました');
    const reply = typeof result?.reply === 'string' ? result.reply.slice(0, 4000) : '';
    const applied = {};
    const changes = [];
    const rejected = [];
    const updates = result?.updates !== null && typeof result?.updates === 'object' ? result.updates : {};
    for (const [key, value] of Object.entries(updates)) {
      const field = session.definition.fields.find((f) => f.key === key);
      // 接続が決まりに合わない値を返しても、状態には入れない。入れなかったことは記録に残す
      const normalized = field ? normalizeValue(field, value) : undefined;
      if (normalized === undefined) {
        rejected.push({ key, label: field?.label ?? null, value: shownValue(value), reason: field ? '項目の決まりに合わない値' : 'app/ai.json にない項目' });
        continue;
      }
      applied[key] = normalized;
      if (session.state[key] !== normalized) {
        changes.push({ key, label: field.label, from: formatValue(field, session.state[key]), to: formatValue(field, normalized) });
      }
    }
    Object.assign(session.state, applied);
    // どの接続が応答したかを残す。切り替えた後も、前の応答がどちらのものか分かる
    // 応答の速さは、利用者が待った時間(CLI の起動を含む)で測る
    const assistant = { role: 'assistant', text: reply, via: connection.kind, elapsedMs: Date.now() - started };
    if (Number.isFinite(result?.meta?.costUsd)) assistant.costUsd = result.meta.costUsd;
    session.messages.push({ role: 'user', text: text.trim() }, assistant);
    Object.assign(
      entry,
      redactDeep({
        status: 'ok',
        output: {
          reply,
          updates: clip(JSON.stringify(updates)),
          format: result?.meta?.format ?? null,
          costUsd: Number.isFinite(result?.meta?.costUsd) ? result.meta.costUsd : null,
          durationMs: Number.isFinite(result?.meta?.durationMs) ? result.meta.durationMs : null,
        },
        changes,
        rejected,
      }),
    );
    return this.view(projectId);
  }

  // 本人が、AI の理解した条件を直す。次の応答はこの記録を踏まえる。成功も失敗も、実行の記録に残す
  correct(projectId, changes) {
    this.definition(projectId);
    const entry = this.record(projectId, {
      type: 'correction',
      from: 'prototype',
      status: 'running',
      connection: connectionOfRecord(this.connectionOf(projectId)),
      requested: isPlainObject(changes)
        ? Object.entries(changes)
            .slice(0, 20)
            .map(([key, value]) => ({ key: key.slice(0, 64), value: shownValue(value) }))
        : [],
    });
    try {
      const applied = this.applyCorrection(projectId, changes);
      Object.assign(entry, redactDeep({ status: 'ok', changes: applied }));
      return this.view(projectId);
    } catch (error) {
      AiSessions.fail(entry, error, 'correction');
      throw error;
    }
  }

  applyCorrection(projectId, changes) {
    if (!isPlainObject(changes) || Object.keys(changes).length === 0) {
      throw new AiError(400, 'invalid', '直す項目を { 項目の key: 値 } の形で渡してください');
    }
    const session = this.session(projectId);
    if (session.busy) throw new AiError(409, 'busy', 'AI が応答しています。終わってから直してください');
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
