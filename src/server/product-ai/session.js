import { ConnectionError } from './claude-code.js';
import { formatValue, normalizeValue } from './definition.js';
import { createMockConnection } from './mock.js';

export const SESSION_LIMITS = {
  maxTextLength: 500,
  maxMessages: 200,
  // 費用のかかる接続(Claude Code)の応答は、1 つの会話でこの回数まで。試作品のコードが勝手に送り続けても止まる
  maxPaidReplies: 30,
};

export class AiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

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
// 会話はメモリーにだけ置く。Studio を止めると消える。
export class AiSessions {
  constructor({ definitionOf, connections = [createMockConnection()] }) {
    this.definitionOf = definitionOf;
    this.connections = new Map(connections.map((connection) => [connection.kind, connection]));
    this.defaultKind = connections[0].kind;
    this.sessions = new Map();
    // 選んだ接続は、リセットしても変えない
    this.selected = new Map();
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
    this.selected.set(projectId, kind);
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
    const session = {
      key,
      definition,
      busy: false,
      controller: null,
      state: { ...definition.initialState },
      messages: definition.mock.greeting ? [{ role: 'assistant', text: definition.mock.greeting }] : [],
    };
    this.sessions.set(projectId, session);
    return session;
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
    const connection = this.connectionOf(projectId);
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
    session.busy = true;
    session.controller = new AbortController();
    const started = Date.now();
    let result;
    try {
      result = await connection.respond({
        definition: session.definition,
        state: { ...session.state },
        messages: session.messages.map((message) => structuredClone(message)),
        text: text.trim(),
        signal: session.controller.signal,
      });
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
    for (const [key, value] of Object.entries(result?.updates ?? {})) {
      const field = session.definition.fields.find((f) => f.key === key);
      // 接続が決まりに合わない値を返しても、状態には入れない
      const normalized = field ? normalizeValue(field, value) : undefined;
      if (normalized !== undefined) applied[key] = normalized;
    }
    Object.assign(session.state, applied);
    // どの接続が応答したかを残す。切り替えた後も、前の応答がどちらのものか分かる
    // 応答の速さは、利用者が待った時間(CLI の起動を含む)で測る
    const assistant = { role: 'assistant', text: reply, via: connection.kind, elapsedMs: Date.now() - started };
    if (Number.isFinite(result?.meta?.costUsd)) assistant.costUsd = result.meta.costUsd;
    session.messages.push({ role: 'user', text: text.trim() }, assistant);
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
