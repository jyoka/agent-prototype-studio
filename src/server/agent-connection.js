import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { AGENT_MODES, STUDIO_ROOT } from './config.js';
import { describeBilling } from './claude-args.js';
import { FAKE_EXAMPLES } from '../agent/fake-examples.js';

export const FAKE_CLI = path.join(STUDIO_ROOT, 'src', 'agent', 'fake-claude.js');
// --restricted が入った版(ADR-0001)
export const MIN_CLAUDE_VERSION = [2, 1, 248];
// --version と auth status を待つ時間
const CHECK_TIMEOUT_MS = 15_000;

export function parseVersion(text) {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(text ?? '');
  return match ? match.slice(1, 4).map(Number) : null;
}

export function isAtLeast(version, minimum) {
  for (let i = 0; i < minimum.length; i += 1) {
    if (version[i] !== minimum[i]) return version[i] > minimum[i];
  }
  return true;
}

// シェルの alias は効かない。PATH を順に探す(Windows は PATHEXT も)。
export async function findOnPath(name, env = process.env, platform = process.platform) {
  const dirs = (env.PATH ?? env.Path ?? '').split(path.delimiter).filter(Boolean);
  const exts = platform === 'win32' ? (env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean) : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext.toLowerCase());
      const stat = await fs.stat(candidate).catch(() => null);
      if (!stat?.isFile()) continue;
      if (platform !== 'win32') {
        try {
          await fs.access(candidate, fs.constants.X_OK);
        } catch {
          continue;
        }
      }
      return candidate;
    }
  }
  return null;
}

// 子プロセスを起動し、標準出力を limit 文字まで読む。終了コードによらず、出力と終了コードを返す
function readOutput(command, args, { env, limit }) {
  return new Promise((resolve) => {
    let output = '';
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    let child;
    try {
      child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    } catch (error) {
      finish({ output, code: null, error: error.message });
      return;
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({ output, code: null, error: `${CHECK_TIMEOUT_MS / 1000} 秒たっても返りません` });
    }, CHECK_TIMEOUT_MS);
    child.stdout.on('data', (chunk) => {
      if (output.length < limit) output += chunk;
    });
    child.on('error', (error) => finish({ output, code: null, error: error.message }));
    child.on('close', (code) => finish({ output, code, error: null }));
  });
}

async function readVersion(command, env) {
  const { output, code, error } = await readOutput(command, ['--version'], { env, limit: 1000 });
  if (error) return { error };
  return code === 0 ? { output } : { error: `終了コード ${code}` };
}

// claude auth status が返す方式(2.1.312 で確かめた値)。他の値は other にする
const AUTH_METHODS = ['claude.ai', 'api_key', 'oauth_token', 'third_party', 'none'];

// claude auth status の出力から、ログインしているかと方式だけを取り出す。メールアドレスなど他の値は捨てる。
// 形が分からないときは null(最初の送信の失敗で見分ける)
export function parseAuthStatus(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object' || typeof data.loggedIn !== 'boolean') return null;
  let method = null;
  if (typeof data.authMethod === 'string') method = AUTH_METHODS.includes(data.authMethod) ? data.authMethod : 'other';
  return { loggedIn: data.loggedIn, method };
}

// ログインしているかを Claude Code 自身に聞く。ログインの情報のファイルは読まない。
// 出力は parseAuthStatus を通した値だけを返し、出力そのものは記録にも画面にも出さない。
// ログインしていないとき、終了コードは 1 で、出力は JSON(2.1.312)。終了コードによらず出力を読む
async function readAuth(command, env) {
  const { output } = await readOutput(command, ['auth', 'status', '--json'], { env, limit: 64 * 1024 });
  return parseAuthStatus(output) ?? { loggedIn: null, method: null };
}

const PROBLEMS = {
  missing: 'claude が見つかりません。Claude Code を入れて、ターミナルで claude を起動できることを確かめてください。別の場所にあるときは STUDIO_CLAUDE_BIN で指定してください。',
  'not-logged-in':
    'Claude Code にログインしていません。ターミナルで claude を起動して /login でログインしてから、Studio を起動し直してください。Studio はログインの情報を扱いません。',
};

async function exists(file) {
  return (await fs.stat(file).catch(() => null))?.isFile() === true;
}

// 作る AI の接続を決める。config.agent(STUDIO_AGENT)は 3 通り。
// - auto(既定): Claude Code が見つかり、版が足り、ログインしていれば Claude Code。そうでなければ、使えない状態と理由を返す。偽接続には落とさない
// - claude: Claude Code に固定する。判定は auto と同じ
// - fake: 偽接続。Claude Code とモデルは呼ばない
// 判定の結果は status: ready(使える)、missing(ない)、old(古い)、not-logged-in(ログインしていない)、
// unusable(それ以外の理由で使えない。npm 版の claude.cmd、版を読めない)。
// ログインしているかが分からない版(auth の loggedIn が null)は ready にし、最初の送信の失敗で見分ける。
// agent を書かない呼び出しは誤りにする。テストが手元の本物の Claude Code を、知らずに起動しないため
export async function resolveConnection(config, env = process.env) {
  const mode = config.agent;
  if (!AGENT_MODES.includes(mode)) throw new Error(`作る AI の接続(agent)は ${AGENT_MODES.join('、')} のどれかを指定してください(今の値: ${mode})`);
  const billing = describeBilling(env);
  if (mode === 'fake') {
    return {
      mode,
      kind: 'fake',
      label: '偽接続',
      command: process.execPath,
      prefixArgs: [FAKE_CLI],
      version: null,
      billing,
      status: 'ready',
      auth: null,
      problem: null,
      examples: FAKE_EXAMPLES,
    };
  }

  const base = { mode, kind: 'claude', label: 'Claude Code', prefixArgs: [], version: null, billing, auth: null, problem: null, examples: [] };
  const command = config.claudeBin ? path.resolve(config.claudeBin) : await findOnPath('claude', env);
  if (!command || !(await exists(command))) {
    return { ...base, command, status: 'missing', problem: PROBLEMS.missing };
  }
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(command)) {
    // .cmd は cmd.exe を通るので、引数が命令として読まれる恐れがある(ADR-0001)
    return {
      ...base,
      command,
      status: 'unusable',
      problem: `npm 版の ${path.basename(command)} は使えません。ネイティブ版の Claude Code(claude.exe)を入れるか、STUDIO_CLAUDE_BIN で claude.exe を指定してください。`,
    };
  }
  const { output, error } = await readVersion(command, env);
  const version = parseVersion(output);
  if (!version) {
    return { ...base, command, status: 'unusable', problem: `Claude Code の版を確かめられません(${command}: ${error ?? output.trim()})。` };
  }
  const versionText = version.join('.');
  if (!isAtLeast(version, MIN_CLAUDE_VERSION)) {
    return {
      ...base,
      command,
      version: versionText,
      status: 'old',
      problem: `Claude Code ${versionText} は古すぎます。${MIN_CLAUDE_VERSION.join('.')} 以上が要ります(--restricted のため)。claude update で更新してください。`,
    };
  }
  const auth = await readAuth(command, env);
  if (auth.loggedIn === false) {
    return { ...base, command, version: versionText, auth, status: 'not-logged-in', problem: PROBLEMS['not-logged-in'] };
  }
  return { ...base, command, version: versionText, auth, status: 'ready' };
}

// 画面に見せる形。実行ファイルの場所は見せるが、環境変数の値は見せない。
export function connectionView(connection) {
  return {
    // STUDIO_AGENT の値(auto、claude、fake)
    mode: connection.mode,
    kind: connection.kind,
    label: connection.label,
    command: connection.kind === 'claude' ? connection.command : null,
    version: connection.version,
    billing: { mode: connection.billing.mode, text: connection.billing.text },
    ready: !connection.problem,
    // ready、missing、old、not-logged-in、unusable
    status: connection.status,
    problem: connection.problem,
    // ログインしているか(true、false、分からないときは null)と方式だけ。fake のときは null
    auth: connection.auth ? { loggedIn: connection.auth.loggedIn, method: connection.auth.method } : null,
    examples: connection.examples,
  };
}
