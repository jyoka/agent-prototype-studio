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
  // 起動ごとの引数と作業ディレクトリを 1 行ずつ残す(--version は除く)
  const log = path.join(dir, 'launches.ndjson');
  const recorder = `require('fs').appendFileSync(process.argv[1], JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }) + '\\n')`;
  await fs.writeFile(
    bin,
    `#!/bin/sh\ntouch "${marker}"\nif [ "$1" = "--version" ]; then echo "2.1.311 (Claude Code)"; exit 0; fi\n"${process.execPath}" -e "${recorder}" "${log}" "$@"\nexec "${process.execPath}" "${FAKE_CLI}" "$@"\n`,
    { mode: 0o755 },
  );
  return { bin, marker, log };
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

test('偽の claude で最後まで動き、9 つの確かめごとと費用を報告に残す', posixOnly, async (t) => {
  const { bin, log } = await shim(t);
  const { output } = await runScript(['--run'], { PATH: process.env.PATH, STUDIO_CLAUDE_BIN: bin, HOME: process.env.HOME });
  const root = /作業の場所: (.+)/.exec(output)?.[1];
  assert.ok(root, output);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const report = JSON.parse(await fs.readFile(path.join(root, 'report.json'), 'utf8'));
  assert.deepEqual(Object.keys(report.results).sort(), [
    'auth',
    'claude-md',
    'customizations',
    'hooks',
    'interrupt',
    'observe-tools',
    'read-outside',
    'user-claude-md',
    'write-outside',
  ]);
  // 偽の claude は守りどおりに振る舞うので、すべて期待どおりになる。実機の結果ではない。
  // ~/.claude/CLAUDE.md がない PC では、user-claude-md は確かめられない
  for (const [key, result] of Object.entries(report.results)) {
    if (key === 'user-claude-md' && result.status === '確かめられなかった') continue;
    assert.equal(result.status, '確かめた: 期待どおり', `${key}: ${result.detail}`);
  }
  assert.equal(report.launches, 4);
  assert.equal(report.totalCostUsd, 0);
  // どの起動にも費用の上限が付き、MCP の設定は app/ の外にある
  const launches = (await fs.readFile(log, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(launches.length, 4);
  for (const launch of launches) {
    assert.equal(launch.argv[launch.argv.indexOf('--max-budget-usd') + 1], '0.5');
    const config = launch.argv[launch.argv.indexOf('--mcp-config') + 1];
    assert.ok(path.relative(launch.cwd, config).startsWith('..'), config);
  }
});
