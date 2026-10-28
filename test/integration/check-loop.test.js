import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { STUDIO_ROOT } from '../../src/server/config.js';

// npm run check:loop(scripts/check-loop.js)。実モデルを呼ぶのは --real を付けたときだけ。
// ここでは偽の claude で、--real がなければ呼ばないこと、API の料金がかかる見込みなら止めることを確かめる
const SCRIPT = path.join(STUDIO_ROOT, 'scripts', 'check-loop.js');
const posixOnly = { skip: process.platform === 'win32' ? '偽の claude をシェルスクリプトで作るため' : false };

function runScript(args, env, timeoutMs = 30_000) {
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

// 呼ばれたら印を残す偽の claude。--version だけに答える
async function shim(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-check-loop-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'claude');
  const marker = path.join(dir, 'called');
  const launched = path.join(dir, 'launched');
  await fs.writeFile(bin, `#!/bin/sh\ntouch "${marker}"\nif [ "$1" = "--version" ]; then echo "2.1.312 (Claude Code)"; exit 0; fi\ntouch "${launched}"\nexit 1\n`, { mode: 0o755 });
  return { dir, bin, marker, launched };
}

test('--real がなければ、何をするかを出すだけで Claude Code を呼ばない', posixOnly, async (t) => {
  const { bin, marker } = await shim(t);
  const { code, output } = await runScript([], { PATH: process.env.PATH, STUDIO_CLAUDE_BIN: bin });
  assert.equal(code, 0);
  assert.match(output, /test\/fixtures\/loop-broken\//);
  assert.match(output, /--real を付けて実行してください/);
  await assert.rejects(fs.access(marker));
});

test('--real でも、API の料金がかかる見込みなら、明示しない限り止めて記録を書かない', posixOnly, async (t) => {
  const { dir, bin, launched } = await shim(t);
  const out = path.join(dir, 'evidence');
  const { code, output } = await runScript(['--real', '--out', out], { PATH: process.env.PATH, STUDIO_CLAUDE_BIN: bin, ANTHROPIC_API_KEY: 'fictional' });
  assert.equal(code, 1);
  assert.match(output, /--allow-api-billing/);
  await assert.rejects(fs.access(launched));
  await assert.rejects(fs.access(out));
});
