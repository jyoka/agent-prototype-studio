import { ConnectionError } from './claude-code.js';

// 実モデル(費用のかかる接続)の呼び出しの上限(docs/design/harness.md の 4.4。利用者が 2026-10-28 に決めた値)。
// 1 つの会話の有料のターン(30 まで)は session.js の SESSION_LIMITS.maxPaidReplies で数える。
export const CALL_LIMITS = {
  // 1 ターンの呼び出し。抽出 2 回、言い方 2 回(どちらも、壊れた出力のやり直しを含む。言い方は、守ることに合わない返事のやり直しも含む)
  perTurn: { extract: 2, phrase: 2 },
  // プロジェクトごとの呼び出し。観察の会話も含め、この時間の窓でこの回数まで。
  // 観察ごとに新しい会話を作ると会話ごとの上限が毎回戻るので、プロジェクトで抑える(ADR-0001 の T6)
  perProject: 120,
  windowMs: 60 * 60 * 1000,
};

// 1 ターンの期限。過ぎたら接続を止め、決まった文(mock の型)で返し、記録に時間切れと残す(harness.js の turn)。
// 試作品の側の待ち時間(src/runtime/runtime.js の AI_TIMEOUT_MS)は、これより少し長くする
export const TURN_LIMITS = { deadlineMs: 240_000 };

const KIND_LABELS = { extract: '抽出', phrase: '言い方' };
const perTurnTotal = (perTurn) => Object.values(perTurn).reduce((sum, n) => sum + n, 0);

// プロジェクトごとの呼び出しの時刻。メモリーにだけ置く(Studio を止めると数え直す)。
// 会話のリセットや観察の終わりでは数え直さない
export class ProjectCallWindow {
  constructor({ limit = CALL_LIMITS.perProject, windowMs = CALL_LIMITS.windowMs, now = Date.now } = {}) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.now = now;
    this.calls = new Map();
  }

  recent(projectId) {
    const since = this.now() - this.windowMs;
    const list = (this.calls.get(projectId) ?? []).filter((at) => at > since);
    this.calls.set(projectId, list);
    return list;
  }

  count(projectId) {
    return this.recent(projectId).length;
  }

  // 1 回分を数える。上限に当たっていたら数えずに投げる(モデルを呼ばない)
  take(projectId) {
    this.ensure(projectId, 1);
    this.recent(projectId).push(this.now());
  }

  // あと need 回呼べるか。呼べなければ投げる
  ensure(projectId, need) {
    const list = this.recent(projectId);
    if (list.length + need > this.limit) {
      // need 回分の空きができるのは、古い方から (超える数) 番目の呼び出しが窓を出たとき
      const freedBy = list[Math.min(list.length - 1, list.length + need - this.limit - 1)] ?? this.now();
      const minutes = Math.max(1, Math.ceil((freedBy + this.windowMs - this.now()) / 60_000));
      throw new ConnectionError(
        'project-limit',
        `この試作品で本物の AI を呼べるのは、自動の確かめも含めて ${Math.round(this.windowMs / 60_000)} 分に ${this.limit} 回までです。上限に当たったので、呼ばずに止めました。あと約 ${minutes} 分で呼べるようになります`,
      );
    }
  }
}

// 1 ターンの呼び出しを数え、記録に残す。接続は CLI を起動する前に start(kind) を呼び、終わったら end(結果) を呼ぶ。
// 上限に当たったら、start が投げる(モデルを呼ばない)。take はプロジェクトの上限を数える関数
export function createTurnMeter({ perTurn = CALL_LIMITS.perTurn, take = () => {} } = {}) {
  const calls = [];
  return {
    start(kind) {
      const made = calls.filter((call) => call.kind === kind).length;
      if (!Object.hasOwn(perTurn, kind) || made >= perTurn[kind]) {
        const each = Object.entries(perTurn).map(([k, n]) => `${KIND_LABELS[k] ?? k} ${n} 回`).join('、');
        throw new ConnectionError(
          'turn-limit',
          `1 回の発言で本物の AI を呼べるのは ${perTurnTotal(perTurn)} 回まで(${each})です。上限に当たったので、${KIND_LABELS[kind] ?? kind}を呼ばずに止めました`,
        );
      }
      take();
      const call = { kind, attempt: made + 1, waitMs: null, durationMs: null, costUsd: null, format: null, problem: null, error: null };
      calls.push(call);
      const started = Date.now();
      return {
        // 結果: { durationMs, costUsd, format, problem, error }。待ち時間(CLI の起動を含む)はここで測る
        end(result = {}) {
          call.waitMs = Date.now() - started;
          for (const key of ['durationMs', 'costUsd', 'format', 'problem', 'error']) {
            if (result[key] !== undefined && result[key] !== null) call[key] = result[key];
          }
        },
      };
    },
    // この種類の呼び出しを、このターンであと何回できるか
    remaining(kind) {
      return Math.max(0, (perTurn[kind] ?? 0) - calls.filter((call) => call.kind === kind).length);
    },
    // 記録に残す形。回数、待った時間の合計、CLI が報告した処理の時間と費用の合計、1 回ずつの中身
    summary() {
      const sum = (key) => {
        const values = calls.map((call) => call[key]).filter(Number.isFinite);
        return values.length > 0 ? values.reduce((a, b) => a + b, 0) : null;
      };
      const formats = calls.map((call) => call.format).filter(Boolean);
      let format = null;
      if (formats.includes('broken')) format = 'broken';
      else if (formats.includes('text-json')) format = 'text-json';
      else if (formats.length > 0) format = 'structured';
      return {
        count: calls.length,
        extract: calls.filter((call) => call.kind === 'extract').length,
        phrase: calls.filter((call) => call.kind === 'phrase').length,
        waitMs: sum('waitMs') ?? 0,
        durationMs: sum('durationMs'),
        costUsd: sum('costUsd'),
        format,
        calls: calls.map((call) => ({ ...call })),
      };
    },
  };
}
