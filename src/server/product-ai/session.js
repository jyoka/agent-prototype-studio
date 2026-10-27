import { formatValue, normalizeValue } from './definition.js';
import { createMockConnection } from './mock.js';

export const SESSION_LIMITS = {
  maxTextLength: 500,
  maxMessages: 200,
};

export class AiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// プロダクト内 AI の会話と状態を、プロジェクトごとにサーバーで持つ(ADR-0001 の「試す」)。
// 応答の中身は接続(モック、後に実モデル)が決め、値の検査、状態の更新、記録、リセットはここで必ず行う。
// 会話はメモリーにだけ置く。Studio を止めると消える。
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
    const session = {
      key,
      definition,
      busy: false,
      state: { ...definition.initialState },
      messages: definition.mock.greeting ? [{ role: 'assistant', text: definition.mock.greeting }] : [],
    };
    this.sessions.set(projectId, session);
    return session;
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
