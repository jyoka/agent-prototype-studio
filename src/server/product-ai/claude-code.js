import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { formatValue } from './definition.js';

// プロダクト内 AI を、利用者が入れた Claude Code(未改変の CLI)で動かす接続(#276)。
// 認証は CLI に任せる。ツールは資格情報を読まない、保存しない、渡さない。環境変数は利用者のものをそのまま渡す。
// 会話は Studio が持ち、毎回すべてを渡す(--no-session-persistence)。CLI の会話の再開(--resume)は使わない。

export const CLAUDE_CODE_LIMITS = {
  timeoutMs: 90_000,
  maxOutputBytes: 1024 * 1024,
  maxStderrBytes: 16 * 1024,
  // 1 回の応答の費用の上限(--max-budget-usd)。ログインが Console のアカウントだと、API キーがなくても従量課金になるので、いつも付ける
  maxBudgetUsd: 0.1,
  // 止めるときの段階: SIGINT、待って SIGTERM、待ってプロセスグループごと SIGKILL
  stopGraceMs: 1500,
};

export class ConnectionError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// 送り先と課金を変える環境変数。値は読まず、あるかだけを見る
const PROVIDER_ENV = ['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN'];

// 実行の前に画面に出す。ANTHROPIC_API_KEY があると、CLI は API の従量課金で動く(#270)
export function billingOf(env) {
  const providers = PROVIDER_ENV.filter((name) => env[name]);
  if (providers.length > 0) {
    return {
      kind: 'other',
      label: '環境変数で指定された提供元の課金',
      text: `環境変数 ${providers.join('、')} があるので、送り先と課金はその設定に従います。1 回の応答の上限は $${CLAUDE_CODE_LIMITS.maxBudgetUsd} です(--max-budget-usd)。`,
      providers,
    };
  }
  if (env.ANTHROPIC_API_KEY) {
    return {
      kind: 'api-key',
      label: 'API の従量課金',
      text: `環境変数 ANTHROPIC_API_KEY があるので、API キーの持ち主に従量で課金されます。1 回の応答の上限は $${CLAUDE_CODE_LIMITS.maxBudgetUsd} です(--max-budget-usd)。`,
    };
  }
  // ログインの種類は Studio からは分からない(資格情報を読まないため)。分からないことを、そのまま出す
  return {
    kind: 'subscription',
    label: 'Claude Code にログインしているアカウント',
    text: `ANTHROPIC_API_KEY がないので、Claude Code にログインしている本人のアカウントで動きます。Pro や Max のサブスクリプションなら、その枠を使います。枠の量は公開されておらず、事前に見積もれません。Console のアカウントでログインしているときは、API の従量課金になります。どちらかは Studio からは分かりません。1 回の応答の上限として $${CLAUDE_CODE_LIMITS.maxBudgetUsd} を Claude Code に渡します(--max-budget-usd)。`,
  };
}

// 実行ファイルを PATH から探す。見つけるだけで、起動はしない
export function findExecutable(name, env) {
  if (path.isAbsolute(name) || name.includes('/') || name.includes('\\')) {
    return isExecutable(name) ? path.resolve(name) : null;
  }
  const extensions = process.platform === 'win32' ? ['.exe', ''] : [''];
  for (const dir of (env.PATH ?? env.Path ?? '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of extensions) {
      const file = path.join(dir, name + ext);
      if (isExecutable(file)) return file;
    }
  }
  return null;
}

function isExecutable(file) {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) return false;
    if (process.platform !== 'win32') fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// ai.json の fields から、応答の形(JSON スキーマ)を作る。updates には変わった項目だけを入れさせる
export function responseSchema(definition) {
  const properties = {};
  for (const field of definition.fields) {
    if (field.type === 'number') {
      const number = { type: ['number', 'null'] };
      if (field.min !== null) number.minimum = field.min;
      if (field.max !== null) number.maximum = field.max;
      properties[field.key] = number;
    } else {
      properties[field.key] = { enum: [...field.options.map((option) => option.value), null] };
    }
  }
  return {
    type: 'object',
    properties: {
      reply: { type: 'string' },
      updates: { type: 'object', properties, additionalProperties: false },
    },
    required: ['reply', 'updates'],
    additionalProperties: false,
  };
}

function describeField(field) {
  if (field.type === 'number') {
    const range = [field.min !== null ? `${field.min} 以上` : '', field.max !== null ? `${field.max} 以下` : ''].filter(Boolean).join('、');
    return `- ${field.key}(${field.label}): 数${field.unit ? `、単位は${field.unit}` : ''}${range ? `、${range}` : ''}`;
  }
  return `- ${field.key}(${field.label}): 次のどれか ${field.options.map((option) => `「${option.value}」`).join('、')}`;
}

// 試作品の作り手が書いた指示(ai.json の instructions)に、Studio の決まりを足す
export function systemPrompt(definition) {
  return [
    definition.instructions || `あなたは「${definition.name}」です。`,
    '',
    '# Studio の決まり(Prototype Studio が付け足しています)',
    'あなたは試作品の中で利用者と話す AI です。データはすべて架空です。実在の人や会社の情報を求めないでください。',
    '会話から、次の項目の値を読み取ってください。',
    ...definition.fields.map(describeField),
    '利用者が自分で直した項目(「利用者の修正」)は、その値を優先し、勝手に戻さないでください。',
    '未定の項目があれば、1 つずつ聞いてください。',
    '応答は JSON だけにしてください。形: {"reply": "利用者への返事", "updates": {"項目の key": 値}}。',
    'updates には、今回の発言で新しく分かった項目か、変わった項目だけを入れてください。分からない項目は入れないでください。null は「未定に戻す」です。',
  ].join('\n');
}

function line(message) {
  if (message.role === 'user') return `[利用者] ${message.text}`;
  if (message.role === 'correction') return `[利用者の修正] ${message.text}`;
  return `[AI] ${message.text}`;
}

// stdin で渡す本文。会話の全体、今の状態、新しい発言(argv には入れない)
export function conversationPrompt({ definition, state, messages, text }) {
  const current = definition.fields.map((field) => `- ${field.key}(${field.label}): ${formatValue(field, state[field.key])}`);
  return [
    '<これまでの会話>',
    ...(messages.length > 0 ? messages.map(line) : ['(まだありません)']),
    '</これまでの会話>',
    '',
    '<今の状態>',
    ...current,
    '</今の状態>',
    '',
    '<新しい発言>',
    text,
    '</新しい発言>',
  ].join('\n');
}

// 起動の引数。偽接続でも実接続でも同じにする(ADR-0001)。発言は argv に入れず stdin で渡す
export function buildArgs(definition) {
  const args = [
    '-p',
    '--restricted', // コマンド実行と Web を外し、利用者とプロジェクトの設定ファイルを読まない
    '--safe-mode', // CLAUDE.md、skills、plugins、hooks、MCP、auto memory を読まない
    '--tools',
    '', // プロダクト内 AI にはツールを渡さない
    '--strict-mcp-config',
    '--permission-mode',
    'dontAsk',
    '--no-session-persistence', // ~/.claude/projects/ に会話を残さない。会話は Studio が持つ
    '--output-format',
    'json',
    // 値が - で始まってもフラグとして読まれないよう、= でつなぐ
    `--json-schema=${JSON.stringify(responseSchema(definition))}`,
    `--system-prompt=${systemPrompt(definition)}`,
    '--max-budget-usd',
    String(CLAUDE_CODE_LIMITS.maxBudgetUsd),
  ];
  return args;
}

const LIMIT_PATTERN = /usage limit|rate.?limit|hit your limit|limit reached|too many requests|\b429\b/i;
const AUTH_PATTERN = /not logged in|please run .*login|invalid api key|authentication|unauthorized|\b401\b/i;

function failure(text, fallback) {
  const detail = String(text ?? '').trim().slice(0, 300);
  if (LIMIT_PATTERN.test(detail)) {
    return new ConnectionError('limit', `Claude Code の利用の上限に当たりました(${detail})。時間をおいて試すか、接続をモックに戻してください`);
  }
  if (AUTH_PATTERN.test(detail)) {
    return new ConnectionError('auth', `Claude Code にログインできていません(${detail})。ターミナルで claude を起動してログインしてから、もう一度試してください`);
  }
  return new ConnectionError('failed', `${fallback}${detail ? `(${detail})` : ''}`);
}

function parseJsonObject(text) {
  if (typeof text !== 'string') return null;
  // ```json … ``` で囲まれていても読む
  const body = text.trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/, '$1');
  try {
    const value = JSON.parse(body);
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

// --output-format json の結果を、{ reply, updates, meta } にする。
// 構造化出力(structured_output)を優先し、なければ本文を JSON として読む(代わりの方法)。
export function parseResult(stdout) {
  const result = parseJsonObject(stdout);
  if (!result) throw failure(stdout, 'Claude Code の出力を読めませんでした');
  if (result.is_error || (typeof result.subtype === 'string' && result.subtype !== 'success')) {
    if (result.subtype === 'error_max_budget_usd') {
      throw new ConnectionError('budget', `1 回の応答の費用の上限($${CLAUDE_CODE_LIMITS.maxBudgetUsd})に当たったので止めました`);
    }
    throw failure(result.result ?? result.subtype, 'Claude Code がエラーを返しました');
  }
  const meta = { costUsd: Number.isFinite(result.total_cost_usd) ? result.total_cost_usd : null };
  let output = result.structured_output;
  let structured = true;
  if (output === null || typeof output !== 'object' || Array.isArray(output)) {
    output = parseJsonObject(result.result);
    structured = false;
  }
  if (output && typeof output.reply === 'string') {
    const updates = output.updates !== null && typeof output.updates === 'object' && !Array.isArray(output.updates) ? output.updates : {};
    return { reply: output.reply, updates, meta: { ...meta, structured } };
  }
  // JSON で返さなかったときは、本文を返事として使い、状態は変えない
  if (typeof result.result === 'string' && result.result.trim()) {
    return { reply: result.result.trim(), updates: {}, meta: { ...meta, structured: false } };
  }
  throw new ConnectionError('failed', 'Claude Code の応答が空でした');
}

function signalTree(child, name) {
  try {
    if (process.platform === 'win32') {
      // Windows にはシグナルとプロセスグループがないので、木ごと止める
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', timeout: 5000 });
    } else {
      process.kill(-child.pid, name);
    }
  } catch {
    // すでに終わっている
  }
}

// 1 回の応答のために CLI を起動し、終わるか、止めるか、時間切れまで待つ
// running には、動いている CLI を止める関数と、終わりを待つ Promise を入れる(Studio を止めるとき用)
function run({ bin, args, input, cwd, env, signal, limits, running }) {
  let entry;
  const promise = new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new ConnectionError('cancelled', '応答を止めました'));
      return;
    }
    let child;
    try {
      child = spawn(bin, args, {
        cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
        windowsHide: true,
      });
    } catch (error) {
      reject(new ConnectionError('not-found', `Claude Code を起動できませんでした(${error.code ?? error.message})`));
      return;
    }
    let stdout = '';
    let stderr = '';
    let outBytes = 0;
    let stopReason = null;
    const timers = [];
    const stop = (reason) => {
      if (stopReason) return;
      stopReason = reason;
      signalTree(child, 'SIGINT');
      timers.push(setTimeout(() => signalTree(child, 'SIGTERM'), limits.stopGraceMs));
      timers.push(setTimeout(() => signalTree(child, 'SIGKILL'), limits.stopGraceMs * 2));
    };
    const onAbort = () => stop('cancelled');
    entry = { stop: () => stop('cancelled'), done: null };
    running.add(entry);
    signal?.addEventListener('abort', onAbort, { once: true });
    timers.push(setTimeout(() => stop('timeout'), limits.timeoutMs));

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      outBytes += Buffer.byteLength(chunk);
      if (outBytes > limits.maxOutputBytes) stop('too-large');
      else stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      if (stderr.length < limits.maxStderrBytes) stderr += chunk;
    });
    child.stdin.on('error', () => {
      // 先に終わった CLI には書けない。結果は exit で扱う
    });
    child.stdin.end(input);

    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      running.delete(entry);
      for (const timer of timers) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (error) reject(error);
      else resolve(value);
    };
    child.once('error', (error) => {
      if (error.code === 'ENOENT') {
        finish(new ConnectionError('not-found', `Claude Code が見つかりません(${bin})。Claude Code を入れるか、STUDIO_CLAUDE_BIN で場所を指定してください`));
      } else {
        finish(new ConnectionError('failed', `Claude Code を起動できませんでした(${error.code ?? error.message})`));
      }
    });
    child.once('close', (code, signalName) => {
      if (stopReason === 'cancelled') return finish(new ConnectionError('cancelled', '応答を止めました'));
      if (stopReason === 'timeout') {
        return finish(new ConnectionError('timeout', `Claude Code が ${Math.round(limits.timeoutMs / 1000)} 秒で応答しなかったので止めました`));
      }
      if (stopReason === 'too-large') return finish(new ConnectionError('failed', 'Claude Code の出力が大きすぎるので止めました'));
      if (code !== 0) {
        // 失敗でも JSON の結果を出すことがある(上限、ログインなど)
        try {
          parseResult(stdout);
        } catch (error) {
          if (error instanceof ConnectionError && error.code !== 'failed') return finish(error);
        }
        return finish(failure(stderr || stdout, `Claude Code が終了コード ${code ?? signalName} で止まりました`));
      }
      try {
        finish(null, parseResult(stdout));
      } catch (error) {
        finish(error);
      }
    });
  });
  if (entry) entry.done = promise.catch(() => {});
  return promise;
}

// cwd は空の一時フォルダーにする。ツールは渡さないが、読める場所を作らないため
function emptyWorkDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'studio-product-ai-'));
}

export function createClaudeCodeConnection({ env = process.env, allowed = false, limits = CLAUDE_CODE_LIMITS } = {}) {
  const binName = env.STUDIO_CLAUDE_BIN || 'claude';
  const billing = billingOf(env);
  const running = new Set();
  let workDir = null;

  return {
    kind: 'claude-code',
    label: 'Claude Code',
    description: '利用者が入れた Claude Code を、本人のログインで動かします。発言のたびに実際の AI モデルを呼びます。',
    billing,
    // 選べるか。選べないときは、理由と次の手順を返す
    availability() {
      if (!allowed) {
        return {
          available: false,
          reason:
            '実際の AI モデルは、まだ使えない設定です。社内の利用条件とデータの扱いを確かめてから、STUDIO_ALLOW_CLAUDE_CODE=1 を付けて Studio を起動し直してください。',
        };
      }
      if (!findExecutable(binName, env)) {
        return {
          available: false,
          reason: `Claude Code が見つかりません(${binName})。Claude Code を入れてログインするか、STUDIO_CLAUDE_BIN で場所を指定してください。`,
        };
      }
      return { available: true, reason: '' };
    },
    // 実行の前に画面に出す。何が、どこへ送られるか
    sends(definition) {
      return {
        to: billing.providers
          ? `環境変数(${billing.providers.join('、')})で指定された提供元(Claude Code が送ります)`
          : 'Anthropic(Claude Code が送ります)',
        items: [
          `試作品の AI の指示(app/ai.json の instructions、${definition.instructions.length} 文字)と、Studio が付け足す決まり`,
          `覚える項目と選択肢(${definition.fields.length} 項目)`,
          'この試作品で話した会話の全体(モックとの会話、あなたの修正の記録も含む)と、今の状態',
          '新しく送る発言',
        ],
        notSent: 'app/ の他のファイル、他の試作品、PC のファイルは送りません。Claude Code にはツールを渡しません。',
        systemPrompt: systemPrompt(definition),
      };
    },
    async respond({ definition, state, messages, text, signal }) {
      const bin = findExecutable(binName, env);
      if (!bin) throw new ConnectionError('not-found', this.availability().reason);
      if (!workDir || !fs.existsSync(workDir)) workDir = emptyWorkDir();
      return run({
        bin,
        args: buildArgs(definition),
        input: conversationPrompt({ definition, state, messages, text }),
        cwd: workDir,
        env,
        signal,
        limits,
        running,
      });
    },
    // 動いている CLI を止め、終わるまで待ってから作業フォルダーを消す。待つのは SIGKILL の後まで
    async close() {
      const waits = [...running].map((entry) => {
        entry.stop();
        return entry.done;
      });
      let timer;
      const limit = new Promise((resolve) => (timer = setTimeout(resolve, limits.stopGraceMs * 2 + 1000)));
      await Promise.race([Promise.all(waits), limit]);
      clearTimeout(timer);
      if (workDir) fs.rmSync(workDir, { recursive: true, force: true });
      workDir = null;
    },
  };
}
