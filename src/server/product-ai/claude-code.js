import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { redact } from '../redact.js';
import { INTENTS, formatValue } from './definition.js';

// プロダクト内 AI を、利用者が入れた Claude Code(未改変の CLI)で動かす接続(#276)。
// 認証は CLI に任せる。ツールは資格情報を読まない、保存しない、渡さない。環境変数は利用者のものをそのまま渡す。
// 会話は Studio が持ち、毎回すべてを渡す(--no-session-persistence)。CLI の会話の再開(--resume)は使わない。
// 1 ターンは harness の 2 つの口(抽出と言い方)に合わせた 2 種の呼び出しにする(jyoka/tasks#308)。

export const CLAUDE_CODE_LIMITS = {
  timeoutMs: 90_000,
  maxOutputBytes: 1024 * 1024,
  maxStderrBytes: 16 * 1024,
  // 1 回の呼び出しの費用の上限(--max-budget-usd)。ログインが Console のアカウントだと、API キーがなくても従量課金になるので、いつも付ける。
  // 1 回の発言(ターン)では、抽出と言い方で多くて 4 回呼ぶ(limits.js の CALL_LIMITS.perTurn)
  maxBudgetUsd: 0.1,
  // 止めるときの段階: SIGINT、待って SIGTERM、待ってプロセスグループごと SIGKILL
  stopGraceMs: 1500,
};

// 出力の形が壊れていたときに、同じ呼び出しを試す回数(1 回やり直す)。1 ターンの呼び出しの上限は limits.js の CALL_LIMITS
const ATTEMPTS = 2;

export class ConnectionError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// 送り先と課金を変える環境変数。値は読まず、あるかだけを見る
export const PROVIDER_ENV = ['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN'];

// 費用の上限の説明。--max-budget-usd は 1 回の呼び出しごとに効く。1 回の発言では、2 種の呼び出しをそれぞれ多くて ATTEMPTS 回
const budgetText = () => {
  const calls = ATTEMPTS * CALL_KINDS.length;
  return `1 回の呼び出しの上限は $${CLAUDE_CODE_LIMITS.maxBudgetUsd} です(--max-budget-usd)。1 回の発言で多くて ${calls} 回呼ぶので、1 回の発言では多くて $${(CLAUDE_CODE_LIMITS.maxBudgetUsd * calls).toFixed(1)} です。`;
};

// 実行の前に画面に出す。ANTHROPIC_API_KEY があると、CLI は API の従量課金で動く(#270)
export function billingOf(env) {
  const providers = PROVIDER_ENV.filter((name) => env[name]);
  if (providers.length > 0) {
    return {
      kind: 'other',
      label: '環境変数で指定された提供元の課金',
      text: `環境変数 ${providers.join('、')} があるので、送り先と課金はその設定に従います。${budgetText()}`,
      providers,
    };
  }
  if (env.ANTHROPIC_API_KEY) {
    return {
      kind: 'api-key',
      label: 'API の従量課金',
      text: `環境変数 ANTHROPIC_API_KEY があるので、API キーの持ち主に従量で課金されます。${budgetText()}`,
    };
  }
  // ログインの種類は Studio からは分からない(資格情報を読まないため)。分からないことを、そのまま出す
  return {
    kind: 'subscription',
    label: 'Claude Code にログインしているアカウント',
    text: `ANTHROPIC_API_KEY がないので、Claude Code にログインしている本人のアカウントで動きます。Pro や Max のサブスクリプションなら、その枠を使います。枠の量は公開されておらず、事前に見積もれません。Console のアカウントでログインしているときは、API の従量課金になります。どちらかは Studio からは分かりません。${budgetText()}`,
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

// 接続は harness(harness.js)の 2 つの口を持つ。どちらも 1 回の呼び出しで `claude -p` を 1 回起動する(docs/design/harness.md の 4.4)。
//   extract … 発言から項目の値と発言の種類を読む。スキーマは全部の項目と intent
//   phrase  … harness の決定(何を聞くか、何を言うか)を返事の文にする。スキーマは {reply} だけ
// モデルが返すのは、この 2 つの JSON だけ。何を聞くか、段の遷移、終わるかは harness が決める。
export const CALL_KINDS = ['extract', 'phrase'];

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

// 抽出の形(JSON スキーマ)。updates は ai.json の全部の項目、intent は Studio の決めた種類
export function extractSchema(definition) {
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
      updates: { type: 'object', properties, additionalProperties: false },
      intent: { enum: [...INTENTS, null] },
    },
    required: ['updates', 'intent'],
    additionalProperties: false,
  };
}

// 言い方の形(JSON スキーマ)。返事の文だけ
export function phraseSchema() {
  return {
    type: 'object',
    properties: { reply: { type: 'string' } },
    required: ['reply'],
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

const INTENT_MEANINGS = {
  answer: '項目に答えた',
  yes: '確かめに「はい」と答えた',
  no: '確かめに「いいえ」と答えた',
  clarify: '質問を返した',
  aside: '関係のない話をした',
  restart: '最初からやり直したいと言った',
};

const STUDIO_HEAD = [
  '# Studio の決まり(Prototype Studio が付け足しています)',
  'あなたは試作品の中で利用者と話す AI の一部です。データはすべて架空です。実在の人や会社の情報を求めないでください。',
];

// 抽出の指示。試作品の作り手の instructions(言い方の指示)は渡さない。何を聞くかも決めさせない
export function extractPrompt(definition) {
  return [
    `あなたは「${definition.name}」の、発言を読み取る係です。返事の文は書きません。`,
    '',
    ...STUDIO_HEAD,
    '<新しい発言> から、次の項目の値を読み取ってください。聞かれていない項目も、発言にあれば読み取ってください。',
    ...definition.fields.map(describeField),
    '利用者が自分で直した項目(「利用者の修正」)は、その値を優先し、勝手に戻さないでください。',
    '発言の種類(intent)を、次のどれか 1 つにしてください。どれでもなければ null にしてください。',
    ...INTENTS.map((intent) => `- ${intent}: ${INTENT_MEANINGS[intent]}`),
    '応答は JSON だけにしてください。形: {"updates": {"項目の key": 値}, "intent": "種類"}。',
    'updates には、今回の発言で新しく分かった項目か、変わった項目だけを入れてください。分からない項目は入れないでください。null は「未定に戻す」です。',
  ].join('\n');
}

// 言い方の指示。試作品の作り手が書いた instructions(人柄、口調)に、Studio の決まりを足す
export function phrasePrompt(definition) {
  return [
    definition.instructions || `あなたは「${definition.name}」です。`,
    '',
    ...STUDIO_HEAD,
    '何を聞くか、何を言うか、会話を終えるかは Studio が決めて <言うこと> で渡します。あなたは、その中身を利用者への返事の文にするだけです。',
    '- <言うこと> に「聞く問い」があれば、その文をそのまま返事に入れてください。ほかの項目は聞かないでください。',
    '- 「まとめる」とあれば、<今の状態> の値を変えずにまとめ、これでよいか確かめてください。',
    '- 「会話を終える」とあれば、<今の状態> の値でまとめて終えてください。新しく聞かないでください。',
    '- 利用者がまだ言っていない値を、決まったこととして言わないでください。<今の状態> と発言にない数を作らないでください。',
    `- 返事は ${definition.rules.maxReplyChars} 文字以内にしてください。`,
    '応答は JSON だけにしてください。形: {"reply": "利用者への返事"}。',
  ].join('\n');
}

export const systemPromptOf = (definition, kind) => (kind === 'phrase' ? phrasePrompt(definition) : extractPrompt(definition));
const schemaOf = (definition, kind) => (kind === 'phrase' ? phraseSchema() : extractSchema(definition));

function line(message) {
  if (message.role === 'user') return `[利用者] ${message.text}`;
  if (message.role === 'correction') return `[利用者の修正] ${message.text}`;
  return `[AI] ${message.text}`;
}

const conversation = (messages) => ['<これまでの会話>', ...(messages.length > 0 ? messages.map(line) : ['(まだありません)']), '</これまでの会話>'];
const currentState = (definition, state) => [
  '<今の状態>',
  ...definition.fields.map((field) => `- ${field.key}(${field.label}): ${formatValue(field, state[field.key])}`),
  '</今の状態>',
];
const newText = (text) => ['<新しい発言>', text, '</新しい発言>'];
// やり直しのときだけ付ける。前の出力のどこが壊れていたか
const retryNote = (problem) => (problem ? ['', '<前の出力の問題>', `前の出力は${problem}ので、使えませんでした。決まった形の JSON だけを返してください。`, '</前の出力の問題>'] : []);
// 守ることの確かめ(guards.js)で合わなかった返事を、やり直すときだけ付ける。合わなかったところ(1 行ずつ)
const guardNote = (lines) =>
  lines?.length > 0 ? ['', '<前の返事の問題>', '前の返事は、Studio の決まりに合わなかったので使えませんでした。次の点を直して、<言うこと> の中身を返事にしてください。', ...lines, '</前の返事の問題>'] : [];

// 抽出の本文(stdin)。会話の全体、今の状態、新しい発言
export function extractInput({ definition, state, messages, text, problem = null }) {
  return [...conversation(messages), '', ...currentState(definition, state), '', ...newText(text), ...retryNote(problem)].join('\n');
}

// 言い方の本文(stdin)。会話の全体、新しい発言、決定の後の状態、決定の中身(何を聞くか、何を言うか)。
// guardProblem は、前の返事が守ることに合わなかったところ(harness がやり直すときに渡す)
export function phraseInput({ definition, decision, state, messages, text = '', problem = null, guardProblem = null }) {
  const fieldOf = (key) => definition.fields.find((field) => field.key === key);
  const shown = (key) => `${fieldOf(key)?.label ?? key}「${formatValue(fieldOf(key), state[key])}」`;
  const say = [];
  if (decision.corrected.length > 0) say.push(`- 本人が直した項目(直した内容に合わせると伝える): ${decision.corrected.map(shown).join('、')}`);
  if (decision.changes.length > 0) say.push(`- 今の発言から読み取った値(理解したと伝える): ${decision.changes.map((change) => shown(change.key)).join('、')}`);
  else if (decision.corrected.length === 0 && (decision.intent === null || decision.intent === 'answer') && !decision.tell?.length) say.push('- 今の発言からは、条件を読み取れなかった(そう伝える)');
  // 固定の流れがツールの結果から作った文。モデルにはツールも結果の全体も渡さない(docs/design/agent-simulation.md の 2.8)
  for (const fact of decision.tell ?? []) say.push(`- 伝えること(この文をそのまま入れる): ${fact}`);
  if (decision.say === 'summary') say.push('- まとめる: 今の状態をまとめ、これでよいか確かめる');
  if (decision.escalate) say.push('- 担当者に渡す: この後は担当者が話す。新しく聞かない');
  else if (decision.done) say.push('- 会話を終える: 今の状態でまとめて終える。新しく聞かない');
  for (const question of decision.mustInclude) if (!decision.tell?.includes(question)) say.push(`- 聞く問い(この文をそのまま入れる): ${question}`);
  if (say.length === 0) say.push('- 発言を受け止める');
  return [
    ...conversation(messages),
    '',
    ...newText(text),
    '',
    ...currentState(definition, state),
    '',
    '<言うこと>',
    ...say,
    '</言うこと>',
    ...guardNote(guardProblem),
    ...retryNote(problem),
  ].join('\n');
}

// 起動の引数。偽接続でも実接続でも同じにする(ADR-0001)。発言は argv に入れず stdin で渡す。
// kind は呼び出しの種類(extract か phrase)。違うのは --json-schema と --system-prompt だけ。
// model は harness の参加者が前提から読んだモデルの名前(形は assumptions.js の MODEL_NAME_PATTERN で検査済み)。書かなければ --model を付けない
export function buildArgs(definition, kind = 'extract', { model = null } = {}) {
  if (!CALL_KINDS.includes(kind)) throw new Error(`知らない呼び出しの種類です: ${kind}`);
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
    `--json-schema=${JSON.stringify(schemaOf(definition, kind))}`,
    `--system-prompt=${systemPromptOf(definition, kind)}`,
    '--max-budget-usd',
    String(CLAUDE_CODE_LIMITS.maxBudgetUsd),
  ];
  if (model) args.push(`--model=${model}`);
  return args;
}

// Claude Code が見つからないとき。場所の指定(STUDIO_CLAUDE_BIN)は開発者向けなので、ここでは言わない(選べるかの理由 availability に書く)
const NOT_FOUND = 'この PC で Claude Code が見つかりません。Claude Code を入れてから、Studio を起動し直してください';
const LIMIT_PATTERN = /usage limit|rate.?limit|hit your limit|limit reached|too many requests|\b429\b/i;
const AUTH_PATTERN = /not logged in|please run .*login|invalid api key|authentication|unauthorized|\b401\b/i;

// 失敗の文は試作品の画面に出るので、利用者の言葉で書く(ux-redesign.md 4 節。Claude Code(実モデル) → 本物の AI、モック → お試しの AI)。
// CLI の出力(detail)は、原因を追えるように最後の括弧に残す
export function failure(text, fallback) {
  // CLI の出力は画面と記録に出るので、秘密らしい文字列を伏せる
  // 先に伏せてから短くする。切った端に、鍵の一部が残らないように
  const detail = redact(String(text ?? '').trim().slice(0, 4000)).slice(0, 300);
  if (LIMIT_PATTERN.test(detail)) {
    return new ConnectionError('limit', `本物の AI の利用の上限に当たりました。時間をおいて試すか、試す欄の上の「AI」でお試しの AI に戻してください(${detail})`);
  }
  if (AUTH_PATTERN.test(detail)) {
    return new ConnectionError('auth', `Claude Code にログインしていません。ターミナルで claude を起動してログインしてから、もう一度試してください(${detail})`);
  }
  return new ConnectionError('failed', `${fallback}${detail ? `(${detail})` : ''}`);
}

function parseJsonObject(text) {
  if (typeof text !== 'string') return null;
  // ```json … ``` で囲まれていても読む
  const body = text.trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/, '$1');
  try {
    const value = JSON.parse(body);
    return isPlainObject(value) ? value : null;
  } catch {
    return null;
  }
}

// text の中の JSON のオブジェクトのうち、最初に読めるものを返す。全体が JSON でなくても、前後に文があっても探す。
// モデルが本文や reply の中に JSON を、前置きや後書きの文と一緒に書くことがあるため(jyoka/tasks#365)
const SCAN_LIMIT = 100_000;
export function jsonObjectIn(text) {
  const whole = parseJsonObject(text);
  if (whole || typeof text !== 'string' || text.length > SCAN_LIMIT) return whole;
  for (let start = text.indexOf('{'); start >= 0; start = text.indexOf('{', start + 1)) {
    const end = closingBrace(text, start);
    if (end < 0) continue;
    try {
      const value = JSON.parse(text.slice(start, end + 1));
      if (isPlainObject(value)) return value;
    } catch {
      // 次の { から探す
    }
  }
  return null;
}

// start の { に対応する } の位置。JSON の文字列の中の括弧は数えない。閉じていなければ -1
function closingBrace(text, start) {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i += 1) {
    const char = text[i];
    if (inString) {
      if (char === '\\') i += 1;
      else if (char === '"') inString = false;
    } else if (char === '"') inString = true;
    else if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

// 言い方の reply が、それ自体 {"reply": "…"} の JSON の文なら(前後に文があっても)、中の reply の文を取り出す。
// sim-9 の実モデルで、構造化出力の reply に JSON の文を入れて返す回があった(jyoka/tasks#365)。
// 取り出せない形(閉じていない JSON など)はそのまま返し、harness の守ることの確かめ(guards.js の noJsonText)がやり直しに回す
const MAX_UNWRAP = 3;
export function unwrapReply(reply) {
  let text = reply;
  for (let depth = 0; depth < MAX_UNWRAP && typeof text === 'string'; depth += 1) {
    const inner = jsonObjectIn(text);
    if (typeof inner?.reply !== 'string') break;
    text = inner.reply;
  }
  return text;
}

// --output-format json の結果を、{ output, format, meta } にする。CLI の失敗(上限、ログイン、費用、読めない出力)は投げる。
// 構造化出力(structured_output)を優先し、なければ本文の中の JSON を読む(代わりの方法。前後に文があってもよい)。
// どちらもなければ output は null(モデルの出力が壊れている。やり直すかは呼ぶ側が決める)
// format: structured は構造化出力、text-json は本文の JSON、broken は JSON の出力がない
export function parseResult(stdout) {
  const result = parseJsonObject(stdout);
  if (!result) throw failure(stdout, '本物の AI の返事を読めませんでした。もう一度送ってください');
  if (result.is_error || (typeof result.subtype === 'string' && result.subtype !== 'success')) {
    if (result.subtype === 'error_max_budget_usd') {
      throw new ConnectionError('budget', `1 回の呼び出しの費用の上限($${CLAUDE_CODE_LIMITS.maxBudgetUsd})に当たったので止めました`);
    }
    throw failure(result.result ?? result.subtype, '本物の AI が失敗しました。もう一度送ってください');
  }
  const meta = {
    costUsd: Number.isFinite(result.total_cost_usd) ? result.total_cost_usd : null,
    durationMs: Number.isFinite(result.duration_ms) ? result.duration_ms : null,
  };
  if (isPlainObject(result.structured_output)) return { output: result.structured_output, format: 'structured', meta };
  const output = jsonObjectIn(result.result);
  if (output) return { output, format: 'text-json', meta };
  return { output: null, format: 'broken', meta };
}

// 出力の形の検査。壊れていれば理由を返す。値が項目の決まりに合うかは harness が確かめる(checkExtraction)
export function extractionProblem(output) {
  if (!output) return 'JSON の出力がなかった';
  if (!isPlainObject(output.updates)) return 'updates が { 項目の key: 値 } の形でなかった';
  if (output.intent !== undefined && output.intent !== null && typeof output.intent !== 'string') return 'intent が文字列でなかった';
  return null;
}

export function replyProblem(output) {
  if (!output) return 'JSON の出力がなかった';
  if (typeof output.reply !== 'string' || unwrapReply(output.reply).trim() === '') return 'reply が空か、文でなかった';
  return null;
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

// 記録に出す引数。長い値(指示と応答の形)は、別に出すので短くする
export function shownArgs(args) {
  return args.map((arg) => {
    const at = arg.indexOf('=');
    if (at > 0 && arg.startsWith('--') && arg.length > 80) return `${arg.slice(0, at + 1)}…(${arg.length - at - 1} 文字)`;
    return arg;
  });
}

// 1 回の呼び出しのために CLI を起動し、終わるか、止めるか、時間切れまで待つ
// running には、動いている CLI を止める関数と、終わりを待つ Promise を入れる(Studio を止めるとき用)。
// parse は標準出力を結果にする関数(既定は --output-format json の parseResult。模擬のエージェントは stream-json を読む)
export function runCli({ bin, args, input, cwd, env, signal, limits, running, parse = parseResult }) {
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
        finish(new ConnectionError('not-found', NOT_FOUND));
      } else {
        finish(new ConnectionError('failed', `Claude Code を起動できませんでした(${error.code ?? error.message})`));
      }
    });
    child.once('close', (code, signalName) => {
      if (stopReason === 'cancelled') return finish(new ConnectionError('cancelled', '応答を止めました'));
      if (stopReason === 'timeout') {
        return finish(new ConnectionError('timeout', `本物の AI が ${Math.round(limits.timeoutMs / 1000)} 秒で返事をしなかったので止めました`));
      }
      if (stopReason === 'too-large') return finish(new ConnectionError('failed', '本物の AI の返事が大きすぎるので止めました'));
      if (code !== 0) {
        // 失敗でも JSON の結果を出すことがある(上限、ログインなど)
        try {
          // 終了コードが 0 でなくても、読めた結果を使ってよいと parse が言ったもの(模擬のエージェントの --max-turns で止まった返事)は返す
          const parsed = parse(stdout);
          if (parsed?.acceptNonZero) return finish(null, parsed);
        } catch (error) {
          if (error instanceof ConnectionError && error.code !== 'failed') return finish(error);
        }
        return finish(failure(stderr || stdout, `本物の AI が途中で止まりました(終了コード ${code ?? signalName})。もう一度送ってください`));
      }
      try {
        finish(null, parse(stdout));
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

// allowed は本物の AI を選べるか(config.allowClaudeCode)。書かない呼び出しは選べない側にする
export function createClaudeCodeConnection({ env = process.env, allowed = false, limits = CLAUDE_CODE_LIMITS } = {}) {
  const binName = env.STUDIO_CLAUDE_BIN || 'claude';
  const billing = billingOf(env);
  const running = new Set();
  let workDir = null;

  return {
    kind: 'claude-code',
    label: 'Claude Code',
    description: '利用者が入れた Claude Code を、本人のログインで動かします。発言のたびに実際の AI モデルを呼びます(抽出と言い方で、1 回の発言に 1 回から 4 回)。',
    billing,
    tools: 'Claude Code にはツールを渡していません(--tools "")。ファイル、コマンド、Web は使えません。',
    // 選べるか。選べないときは、理由のコード(code)と、理由と次の手順を返す。
    // allowed が false なのは、起動した人が STUDIO_ALLOW_CLAUDE_CODE=0 で本物の AI を止めたとき(既定は選べる)。
    // 選べても、使う前に同意が要る(real-ai.js。AiSessions.useReal で確かめる)
    availability() {
      if (!allowed) {
        return {
          available: false,
          code: 'disabled',
          reason: '本物の AI は、使わない設定で起動されています。使いたいときは、Studio を起動した人に確かめてください。',
        };
      }
      if (!findExecutable(binName, env)) {
        return {
          available: false,
          code: 'not-found',
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
          '新しく送る発言と、Studio が決めた次に聞くこと・言うこと',
        ],
        notSent: 'app/ の他のファイル、他の試作品、PC のファイルは送りません。Claude Code にはツールを渡しません。',
        systemPrompt: `【抽出の指示】\n${extractPrompt(definition)}\n\n【言い方の指示】\n${phrasePrompt(definition)}`,
      };
    },
    // 実行の記録に出す。抽出の呼び出しで CLI に渡すもの(送る前に作る。失敗しても見られるように)と、言い方の起動の形と指示
    describe({ definition, state, messages, text }) {
      return {
        to: this.sends(definition).to,
        tools: this.tools,
        command: [path.basename(binName), ...shownArgs(buildArgs(definition, 'extract'))],
        systemPrompt: extractPrompt(definition),
        stdin: extractInput({ definition, state, messages, text }),
        phrase: {
          command: [path.basename(binName), ...shownArgs(buildArgs(definition, 'phrase'))],
          systemPrompt: phrasePrompt(definition),
        },
      };
    },
    // 言い方の呼び出しで渡す本文。harness が送る前に記録に残す
    describePhrase(input) {
      return { stdin: phraseInput(input) };
    },
    // CLI を 1 回起動する。起動する前に上限を数え(meter。上限なら投げてモデルを呼ばない)、待ち時間と結果を残す
    async call(kind, { definition, input, signal, meter, model = null }) {
      const bin = findExecutable(binName, env);
      if (!bin) throw new ConnectionError('not-found', NOT_FOUND);
      // 止められた後と、作業フォルダーを作れないときは、数えずに終える
      if (signal?.aborted) throw new ConnectionError('cancelled', '応答を止めました');
      if (!workDir || !fs.existsSync(workDir)) workDir = emptyWorkDir();
      const metered = meter?.start(kind);
      try {
        const parsed = await runCli({ bin, args: buildArgs(definition, kind, { model }), input, cwd: workDir, env, signal, limits, running });
        return { ...parsed, metered };
      } catch (error) {
        metered?.end({ error: error.code ?? 'failed' });
        throw error;
      }
    },
    // 出力の形が壊れていたら 1 回やり直す。2 回とも壊れていたら fallback に理由を入れて返す(代わりの値は呼ぶ側が決める)。
    // 1 ターンの呼び出しの上限を使い切っていたら(守ることのやり直しで使ったとき)、やり直さずに fallback で返す
    async attempts(kind, { definition, signal, meter, inputOf, problemOf, model = null }) {
      const problems = [];
      for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
        if (attempt > 1 && meter && meter.remaining(kind) === 0) {
          return { output: null, fallback: `出力が壊れていて(${problems[0]})、1 ターンの呼び出しの上限でやり直せなかった` };
        }
        const { output, format, meta, metered } = await this.call(kind, { definition, input: inputOf(problems.at(-1) ?? null), signal, meter, model });
        const problem = problemOf(output);
        metered?.end({ ...meta, format: problem ? 'broken' : format, problem });
        const retry = problems.length > 0 ? `1 回目の出力は${problems[0]}ので、やり直した` : null;
        if (!problem) return { output, retry };
        problems.push(problem);
        if (signal?.aborted) throw new ConnectionError('cancelled', '応答を止めました');
      }
      return { output: null, retry: `1 回目の出力は${problems[0]}ので、やり直した`, fallback: `2 回とも出力が壊れていた(${problems.join('、')})` };
    },
    // 抽出。2 回とも壊れていたら「変更なし」で返す
    async extract({ definition, state, messages, text, signal, meter, model = null }) {
      const { output, retry, fallback } = await this.attempts('extract', {
        definition,
        signal,
        meter,
        model,
        inputOf: (problem) => extractInput({ definition, state, messages, text, problem }),
        problemOf: extractionProblem,
      });
      if (!output) return { updates: {}, intent: null, retry, fallback: `${fallback}ので、変更なしにした` };
      return { updates: output.updates, intent: output.intent ?? null, ...(retry ? { retry } : {}) };
    },
    // 言い方。2 回とも壊れていたら reply を null で返す。harness がモックの言い方の型で返事を作る
    // guardProblem は、守ることに合わなかった前の返事の問題(harness がやり直すときに渡す)
    async phrase({ definition, decision, state, messages, text, signal, meter, guardProblem = null, model = null }) {
      const { output, retry, fallback } = await this.attempts('phrase', {
        definition,
        signal,
        meter,
        model,
        inputOf: (problem) => phraseInput({ definition, decision, state, messages, text, problem, guardProblem }),
        problemOf: replyProblem,
      });
      if (!output) return { reply: null, retry, fallback };
      const reply = unwrapReply(output.reply);
      const unwrapped = reply !== output.reply ? '返事の文が {"reply": …} の JSON の形だったので、中の reply の文だけを使った' : null;
      return { reply, ...(retry ? { retry } : {}), ...(unwrapped ? { unwrapped } : {}) };
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
