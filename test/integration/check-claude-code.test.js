import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { FAKE_CLI } from '../../src/server/agent-connection.js';
import { STUDIO_ROOT } from '../../src/server/config.js';

const SCRIPT = path.join(STUDIO_ROOT, 'scripts', 'check-claude-code.js');
const posixOnly = { skip: process.platform === 'win32' ? '偽の claude をシェルスクリプトで作るため' : false };

function runScript(args, env, timeoutMs = 60_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk) => (output += chunk));
    child.stderr.on('data', (chunk) => (output += chunk));
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${timeoutMs}ms で終わらない:\n${output}`));
    }, timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, output });
    });
  });
}

async function shim(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-check-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'claude');
  const marker = path.join(dir, 'called');
  await fs.writeFile(
    bin,
    `#!/bin/sh\ntouch "${marker}"\nif [ "$1" = "--version" ]; then echo "2.1.311 (Claude Code)"; exit 0; fi\nexec "${process.execPath}" "${FAKE_CLI}" "$@"\n`,
    { mode: 0o755 },
  );
  return { bin, marker };
}

test('--run がなければ、何を確かめるかを出すだけで Claude Code を呼ばない', posixOnly, async (t) => {
  const { bin, marker } = await shim(t);
  const { code, output } = await runScript([], { PATH: process.env.PATH, STUDIO_CLAUDE_BIN: bin });
  assert.equal(code, 0);
  assert.match(output, /--run を付けて実行してください/);
  await assert.rejects(fs.access(marker));
});

test('API の料金がかかる見込みなら、明示しない限り止める', posixOnly, async (t) => {
  const { bin } = await shim(t);
  const { code, output } = await runScript(['--run'], { PATH: process.env.PATH, STUDIO_CLAUDE_BIN: bin, ANTHROPIC_API_KEY: 'fictional' });
  assert.equal(code, 1);
  assert.match(output, /--allow-api-billing/);
});

test('偽の claude で最後まで動き、6 つの確かめごとを報告に残す', posixOnly, async (t) => {
  const { bin } = await shim(t);
  const { output } = await runScript(['--run'], { PATH: process.env.PATH, STUDIO_CLAUDE_BIN: bin });
  const root = /作業の場所: (.+)/.exec(output)?.[1];
  assert.ok(root, output);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const report = JSON.parse(await fs.readFile(path.join(root, 'report.json'), 'utf8'));
  assert.deepEqual(Object.keys(report.results).sort(), ['auth', 'claude-md', 'hooks', 'interrupt', 'read-outside', 'write-outside']);
  // 偽の claude は守りどおりに振る舞うので、すべて期待どおりになる。実機の結果ではない
  for (const [key, result] of Object.entries(report.results)) assert.equal(result.status, '確かめた: 期待どおり', key);
});
