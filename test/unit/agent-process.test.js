import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { startAgentProcess, STOP_STEPS_MS } from '../../src/server/agent-process.js';

const posixOnly = { skip: process.platform === 'win32' ? 'プロセスグループは POSIX だけ' : false };

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntil(check, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

function run(script, options = {}) {
  return startAgentProcess({
    command: process.execPath,
    args: ['-e', script],
    cwd: os.tmpdir(),
    env: process.env,
    input: options.input ?? '',
    timeoutMs: options.timeoutMs ?? 20_000,
    onMessage: options.onMessage ?? (() => {}),
    onInvalidLine: options.onInvalidLine,
  });
}

test('stdout の JSON の行を順に渡し、JSON でない行と stderr は分けて扱う', async () => {
  const messages = [];
  const invalid = [];
  const handle = run(
    `let input = ''; process.stdin.on('data', (c) => (input += c)); process.stdin.on('end', () => {
       console.log(JSON.stringify({ type: 'echo', input }));
       console.log('not json');
       console.error('warning on stderr');
       process.stdout.write(JSON.stringify({ type: 'last' }));
     });`,
    { input: '--looks-like-a-flag 依頼', onMessage: (m) => messages.push(m), onInvalidLine: (l) => invalid.push(l) },
  );
  const exit = await handle.done;
  assert.equal(exit.code, 0);
  assert.deepEqual(messages, [{ type: 'echo', input: '--looks-like-a-flag 依頼' }, { type: 'last' }]);
  assert.deepEqual(invalid, ['not json']);
  assert.equal(exit.stderrTail, 'warning on stderr');
  assert.equal(exit.stopReason, null);
});

test('中断は SIGINT から始め、止まらなければプロセスグループごと強制終了する', posixOnly, async (t) => {
  const saved = { ...STOP_STEPS_MS };
  Object.assign(STOP_STEPS_MS, { interrupt: 200, terminate: 200 });
  t.after(() => Object.assign(STOP_STEPS_MS, saved));
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-agent-process-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const pidFile = path.join(dir, 'grandchild.pid');

  // 自分も孫も SIGINT と SIGTERM を無視する
  const handle = run(
    `const { spawn } = require('node:child_process');
     process.on('SIGINT', () => {}); process.on('SIGTERM', () => {});
     const grandchild = spawn(process.execPath, ['-e', "process.on('SIGINT', () => {}); process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: 'ignore' });
     require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(grandchild.pid));
     setInterval(() => {}, 1000);`,
  );
  assert.ok(await waitUntil(() => fs.access(pidFile).then(() => true, () => false), 5000), '孫が起動しない');
  const grandchild = Number(await fs.readFile(pidFile, 'utf8'));
  const started = Date.now();
  handle.stop('cancel');
  const exit = await handle.done;
  assert.equal(exit.stopReason, 'cancel');
  assert.equal(exit.signal, 'SIGKILL');
  assert.ok(Date.now() - started < 5000);
  assert.ok(await waitUntil(() => !alive(grandchild), 3000), '孫が残っている');
});

test('SIGINT で止まる相手は、強制終了まで待たない', posixOnly, async () => {
  const handle = run(`process.on('SIGINT', () => process.exit(130)); console.log('{}'); setInterval(() => {}, 1000);`, {
    onMessage: () => handle.stop('cancel'),
  });
  const started = Date.now();
  const exit = await handle.done;
  assert.equal(exit.code, 130);
  assert.equal(exit.stopReason, 'cancel');
  assert.ok(Date.now() - started < STOP_STEPS_MS.interrupt);
});

test('時間の上限を超えたら止める', async () => {
  const handle = run(`process.on('SIGINT', () => process.exit(130)); setInterval(() => {}, 1000);`, { timeoutMs: 300 });
  const exit = await handle.done;
  assert.equal(exit.stopReason, 'timeout');
});

test('起動できないときは、その理由を返す', async () => {
  const handle = startAgentProcess({
    command: path.join(os.tmpdir(), 'studio-no-such-command-274'),
    args: [],
    cwd: os.tmpdir(),
    env: process.env,
    input: 'x',
    timeoutMs: 5000,
    onMessage: () => {},
  });
  const exit = await handle.done;
  assert.equal(exit.spawnError.code, 'ENOENT');
});

test('本体が SIGINT で終わっても、SIGINT を無視する子は残さない', posixOnly, async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-agent-process-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const pidFile = path.join(dir, 'grandchild.pid');
  const handle = run(
    `const { spawn } = require('node:child_process');
     const grandchild = spawn(process.execPath, ['-e', "process.on('SIGINT', () => {}); setInterval(() => {}, 1000)"], { stdio: 'ignore' });
     require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(grandchild.pid));
     process.on('SIGINT', () => process.exit(130));
     setInterval(() => {}, 1000);`,
  );
  assert.ok(await waitUntil(() => fs.access(pidFile).then(() => true, () => false), 5000), '孫が起動しない');
  const grandchild = Number(await fs.readFile(pidFile, 'utf8'));
  handle.stop('cancel');
  const exit = await handle.done;
  assert.equal(exit.code, 130);
  assert.ok(await waitUntil(() => !alive(grandchild), 3000), '孫が残っている');
});
