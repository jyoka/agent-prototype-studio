import { formatValue, normalizeValue } from './definition.js';
import { createMockConnection } from './mock.js';

export const SESSION_LIMITS = {
  maxTextLength: 500,
  maxMessages: 200,
};

function freshSession(definition, key) {
  return {
    key,
    definition,
    busy: false,
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
    if (message.role !== 'correction') {
      messages.push({ role: message.role, text: message.text });
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
}

// プロダクト内 AI の会話と状態を、プロジェクトごとにサーバーで持つ(ADR-0001 の「試す」)。
// 応答の中身は接続(モック、後に実モデル)が決め、値の検査、状態の更新、記録、リセットはここで必ず行う。
// 作業中の会話はメモリーにだけ置く。Studio を止めると消える。残すときは版として保存する(versions.js)。
export class AiSessions {
  constructor({ definitionOf, connection = createMockConnection() }) {
    this.definitionOf = definitionOf;
    this.connection = connection;
    this.sessions = new Map();
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
    return {
      connection: {
        kind: this.connection.kind,
        label: this.connection.label,
        description: this.connection.description,
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
    this.sessions.delete(projectId);
    return this.view(projectId);
  }

  checkRoom(session, adding) {
    if (session.messages.length + adding > SESSION_LIMITS.maxMessages) {
      throw new AiError(409, 'too-long', '会話が長くなりすぎました。Studio の「リセット」で最初からやり直してください');
    }
  }

  async send(projectId, text) {
    if (typeof text !== 'string' || text.trim() === '') throw new AiError(400, 'invalid', '話す内容を書いてください');
    if (text.length > SESSION_LIMITS.maxTextLength) {
      throw new AiError(400, 'invalid', `${SESSION_LIMITS.maxTextLength} 文字までにしてください`);
    }
    const session = this.session(projectId);
    if (session.busy) throw new AiError(409, 'busy', 'AI が前の発言に応答しています。少し待ってください');
    this.checkRoom(session, 2);
    session.busy = true;
    let result;
    try {
      result = await this.connection.respond({
        definition: session.definition,
        state: { ...session.state },
        messages: session.messages.map((message) => structuredClone(message)),
        text: text.trim(),
      });
    } catch (error) {
      throw new AiError(502, 'connection', `AI から応答を受け取れませんでした: ${error.message}`);
    } finally {
      session.busy = false;
    }
    // 応答を待つ間にリセットや設定の切り替えがあったら、古い会話に書き足さない
    if (this.sessions.get(projectId) !== session) throw new AiError(409, 'reset', '応答を待つ間に会話が最初に戻りました');
    const reply = typeof result?.reply === 'string' ? result.reply.slice(0, 4000) : '';
    const applied = {};
    for (const [key, value] of Object.entries(result?.updates ?? {})) {
      const field = session.definition.fields.find((f) => f.key === key);
      // 接続が決まりに合わない値を返しても、状態には入れない
      const normalized = field ? normalizeValue(field, value) : undefined;
      if (normalized !== undefined) applied[key] = normalized;
    }
    Object.assign(session.state, applied);
    session.messages.push({ role: 'user', text: text.trim() }, { role: 'assistant', text: reply });
    return this.view(projectId);
  }

  // 本人が、AI の理解した条件を直す。次の応答はこの記録を踏まえる。
  correct(projectId, changes) {
    if (changes === null || typeof changes !== 'object' || Array.isArray(changes) || Object.keys(changes).length === 0) {
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
    if (applied.length === 0) return this.view(projectId);
    this.checkRoom(session, 1);
    for (const { field, to } of applied) session.state[field.key] = to;
    session.messages.push({
      role: 'correction',
      text: `${applied.map(({ field, to }) => (to === null ? `${field.label}を未定に戻しました` : `${field.label}を「${formatValue(field, to)}」に直しました`)).join('。')}。`,
      changes: applied.map(({ field, from, to }) => ({ key: field.key, label: field.label, from, to })),
    });
    return this.view(projectId);
  }
}
