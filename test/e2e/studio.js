import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test as base } from '@playwright/test';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const URL_PATTERN = /http:\/\/127\.0\.0\.1:\d+\/#token=[a-f0-9]{64}/;
const STARTUP_TIMEOUT_MS = 20_000;
const STOP_TIMEOUT_MS = 5_000;

function waitForExit(child, ms) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

// npm とその子の node をまとめて止める
function signal(child, name) {
  try {
    if (process.platform === 'win32') {
      const force = name === 'SIGKILL' ? ['/F'] : [];
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', ...force], { stdio: 'ignore', timeout: STOP_TIMEOUT_MS });
    } else {
      // detached で起動したので、プロセスグループごと送る
      process.kill(-child.pid, name);
    }
  } catch {
    // すでに終わっている
  }
}

async function stopChild(child) {
  if (!(await waitForExit(child, 0))) {
    signal(child, 'SIGTERM');
    if (!(await waitForExit(child, STOP_TIMEOUT_MS))) {
      signal(child, 'SIGKILL');
      await waitForExit(child, STOP_TIMEOUT_MS);
    }
  }
  child.stdout.destroy();
  child.stderr.destroy();
}

function waitForUrl(child, output) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`起動が ${STARTUP_TIMEOUT_MS}ms で終わりません:\n${output()}`)), STARTUP_TIMEOUT_MS);
    child.stdout.on('data', () => {
      const match = URL_PATTERN.exec(output());
      if (match) {
        clearTimeout(timer);
        resolve(match[0]);
      }
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`起動の途中で終了しました(${code}):\n${output()}`));
    });
  });
}

// 作る AI の接続と認証に関わる変数。利用者の環境に何があっても、テストの結果を変えない
const AGENT_ENV = [
  'STUDIO_AGENT',
  'STUDIO_CLAUDE_BIN',
  'STUDIO_MAX_BUDGET_USD',
  'STUDIO_ALLOW_CLAUDE_CODE',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
];

// 利用者と同じ手順(npm start、または node bin/studio.js)で起動し、表示された URL を返す。
// env で環境変数を足す。値が undefined の名前は消す。
// 作る AI は、env で選ばなければ偽接続(STUDIO_AGENT=fake)にする。STUDIO_AGENT を消すか claude にするテストは、
// STUDIO_CLAUDE_BIN で偽の claude か、ない場所を指す。指さなければ起動しない(手元の本物の Claude Code を呼ばないため)。
// 本物を呼ぶのは real: true を渡したときだけ(test/e2e/real-loop.spec.js。STUDIO_REAL=1 のときだけ動く)
export async function launchStudio(home, { useNpm = false, env: extraEnv = {}, real = false } = {}) {
  const command = useNpm ? (process.platform === 'win32' ? 'npm.cmd' : 'npm') : process.execPath;
  const args = useNpm ? ['start'] : ['bin/studio.js'];
  const env = { ...process.env, STUDIO_HOME: home, STUDIO_NO_OPEN: '1', STUDIO_PORT: '0', STUDIO_PREVIEW_PORT: '0' };
  for (const name of AGENT_ENV) delete env[name];
  env.STUDIO_AGENT = 'fake';
  Object.assign(env, extraEnv);
  for (const [name, value] of Object.entries(env)) if (value === undefined) delete env[name];
  if (env.STUDIO_AGENT !== 'fake' && !env.STUDIO_CLAUDE_BIN && !real) {
    throw new Error(`STUDIO_AGENT=${env.STUDIO_AGENT ?? '(なし)'} で起動するテストは、STUDIO_CLAUDE_BIN で偽の claude か、ない場所を指してください`);
  }
  const child = spawn(command, args, {
    cwd: ROOT,
    env,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: useNpm && process.platform === 'win32',
  });
  let output = '';
  child.stdout.on('data', (chunk) => (output += chunk));
  child.stderr.on('data', (chunk) => (output += chunk));

  let url;
  try {
    url = await waitForUrl(child, () => output);
  } catch (error) {
    await stopChild(child);
    throw error;
  }

  const origin = new URL(url).origin;
  const token = new URL(url).hash.slice('#token='.length);
  return {
    url,
    origin,
    token,
    output: () => output,
    async api(pathname) {
      const response = await fetch(`${origin}${pathname}`, { headers: { 'X-Studio-Token': token } });
      return response.json();
    },
    // 画面と同じく、Origin とトークンを付けて送る
    async post(pathname, body) {
      const response = await fetch(`${origin}${pathname}`, {
        method: 'POST',
        headers: { 'X-Studio-Token': token, Origin: origin, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      return { status: response.status, text: await response.text() };
    },
    stop: () => stopChild(child),
  };
}

export async function writeProject(home, id, files, title = id) {
  const root = path.join(home, 'projects', id);
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(root, 'app', name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content);
  }
  await fs.mkdir(path.join(root, '.studio'), { recursive: true });
  await fs.writeFile(path.join(root, '.studio', 'project.json'), JSON.stringify({ title }));
  return path.join(root, 'app');
}

// 一時的なデータの置き場を、テストごとに作って消す。
export const test = base.extend({
  home: async ({}, use) => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'prototype-studio-e2e-'));
    await use(home);
    await fs.rm(home, { recursive: true, force: true });
  },
});

export { expect } from '@playwright/test';
