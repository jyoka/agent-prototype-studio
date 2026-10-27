import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { STUDIO_ROOT } from './config.js';
import { describeBilling } from './claude-args.js';
import { FAKE_EXAMPLES } from '../agent/fake-examples.js';

export const FAKE_CLI = path.join(STUDIO_ROOT, 'src', 'agent', 'fake-claude.js');
// --restricted が入った版(ADR-0001)
export const MIN_CLAUDE_VERSION = [2, 1, 248];
const VERSION_TIMEOUT_MS = 15_000;

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

function readVersion(command) {
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
      child = spawn(command, ['--version'], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    } catch (error) {
      finish({ error: error.message });
      return;
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({ error: `${VERSION_TIMEOUT_MS / 1000} 秒たっても版が返りません` });
    }, VERSION_TIMEOUT_MS);
    child.stdout.on('data', (chunk) => {
      if (output.length < 1000) output += chunk;
    });
    child.on('error', (error) => finish({ error: error.message }));
    child.on('close', (code) => finish(code === 0 ? { output } : { error: `終了コード ${code}` }));
  });
}

// 作る AI の接続を決める。既定は偽接続で、Claude Code とモデルは呼ばない。
// Claude Code は、利用者が STUDIO_AGENT=claude で明示したときだけ使う(#274 の Ready conditions)。
export async function resolveConnection(config, env = process.env) {
  const billing = describeBilling(env);
  if (config.agent !== 'claude') {
    return {
      kind: 'fake',
      label: '偽接続',
      command: process.execPath,
      prefixArgs: [FAKE_CLI],
      version: null,
      billing,
      problem: null,
      examples: FAKE_EXAMPLES,
    };
  }

  const base = { kind: 'claude', label: 'Claude Code', prefixArgs: [], version: null, billing, problem: null, examples: [] };
  const command = config.claudeBin ? path.resolve(config.claudeBin) : await findOnPath('claude', env);
  if (!command) {
    return {
      ...base,
      command: null,
      problem: 'claude が見つかりません。Claude Code を入れて、ターミナルで claude を起動できることを確かめてください。別の場所にあるときは STUDIO_CLAUDE_BIN で指定してください。',
    };
  }
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(command)) {
    // .cmd は cmd.exe を通るので、引数が命令として読まれる恐れがある(ADR-0001)
    return {
      ...base,
      command,
      problem: `npm 版の ${path.basename(command)} は使えません。ネイティブ版の Claude Code(claude.exe)を入れるか、STUDIO_CLAUDE_BIN で claude.exe を指定してください。`,
    };
  }
  const { output, error } = await readVersion(command);
  const version = parseVersion(output);
  if (!version) {
    return { ...base, command, problem: `Claude Code の版を確かめられません(${command}: ${error ?? output.trim()})。` };
  }
  const versionText = version.join('.');
  if (!isAtLeast(version, MIN_CLAUDE_VERSION)) {
    return {
      ...base,
      command,
      version: versionText,
      problem: `Claude Code ${versionText} は古すぎます。${MIN_CLAUDE_VERSION.join('.')} 以上が要ります(--restricted のため)。claude update で更新してください。`,
    };
  }
  return { ...base, command, version: versionText };
}

// 画面に見せる形。実行ファイルの場所は見せるが、環境変数の値は見せない。
export function connectionView(connection) {
  return {
    kind: connection.kind,
    label: connection.label,
    command: connection.kind === 'claude' ? connection.command : null,
    version: connection.version,
    billing: { mode: connection.billing.mode, text: connection.billing.text },
    ready: !connection.problem,
    problem: connection.problem,
    examples: connection.examples,
  };
}
