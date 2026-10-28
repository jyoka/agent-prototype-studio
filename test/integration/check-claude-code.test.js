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

// app/ の外への書き込みの依頼にだけ、決まった動きをする偽の claude。ほかの依頼は偽接続に渡す
// refuse: 道具を呼ばずに文で断る。write: 守りが効かなかったとして、外にファイルを作る
function outsideWrapper(mode) {
  return `
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const input = fs.readFileSync(0, 'utf8');
const emit = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
if (input.includes('Write の道具で')) {
  const target = path.resolve(process.cwd(), '..', 'outside-written.txt');
  if (${JSON.stringify(mode)} === 'write') {
    fs.writeFileSync(target, '架空のメモ');
    emit({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_w', name: 'Write', input: { file_path: target, content: '架空のメモ' } }] } });
  }
  emit({ type: 'assistant', message: { content: [{ type: 'text', text: 'この依頼はお断りします。' }] } });
  emit({ type: 'result', subtype: 'success', is_error: false, result: 'この依頼はお断りします。', total_cost_usd: 0, permission_denials: [] });
} else {
  const child = spawn(process.execPath, [${JSON.stringify(FAKE_CLI)}, ...process.argv.slice(2)], { stdio: ['pipe', 'inherit', 'inherit'] });
  child.stdin.end(input);
  child.on('close', (code) => process.exit(code ?? 1));
}
`;
}

async function shim(t, mode = null) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-check-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'claude');
  const marker = path.join(dir, 'called');
  // 起動ごとの引数と作業ディレクトリを 1 行ずつ残す(--version は除く)
  const log = path.join(dir, 'launches.ndjson');
  const recorder = `require('fs').appendFileSync(process.argv[1], JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }) + '\\n')`;
  let cli = FAKE_CLI;
  if (mode) {
    cli = path.join(dir, 'outside-wrapper.cjs');
    await fs.writeFile(cli, outsideWrapper(mode));
  }
  await fs.writeFile(
    bin,
    `#!/bin/sh\ntouch "${marker}"\nif [ "$1" = "--version" ]; then echo "2.1.311 (Claude Code)"; exit 0; fi\n"${process.execPath}" -e "${recorder}" "${log}" "$@"\nexec "${process.execPath}" "${cli}" "$@"\n`,
    { mode: 0o755 },
  );
  return { bin, marker, log, dir };
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
  assert.equal(report.launches, 5);
  assert.equal(report.totalCostUsd, 0);
  // どの起動にも費用の上限が付き、MCP の設定は app/ の外にある
  const launches = (await fs.readFile(log, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(launches.length, 5);
  for (const launch of launches) {
    assert.equal(launch.argv[launch.argv.indexOf('--max-budget-usd') + 1], '0.5');
    const config = launch.argv[launch.argv.indexOf('--mcp-config') + 1];
    assert.ok(path.relative(launch.cwd, config).startsWith('..'), config);
  }
});

// ~/.claude/CLAUDE.md がある HOME で動かす(ないと user-claude-md が確かめられず、終了コード 2 になる)
async function runWithHome(t, mode) {
  const { bin, dir } = await shim(t, mode);
  const home = path.join(dir, 'home');
  await fs.mkdir(path.join(home, '.claude'), { recursive: true });
  await fs.writeFile(path.join(home, '.claude', 'CLAUDE.md'), '架空の利用者の指示です。\n');
  // HOME を変えても、入れてある Chromium を観察の道具が見つけられるようにする(Playwright の既定の置き場所)
  const cache = { darwin: path.join('Library', 'Caches'), win32: path.join('AppData', 'Local') }[process.platform] ?? '.cache';
  const browsers = process.env.PLAYWRIGHT_BROWSERS_PATH ?? path.join(os.homedir(), cache, 'ms-playwright');
  const env = { PATH: process.env.PATH, STUDIO_CLAUDE_BIN: bin, HOME: home, PLAYWRIGHT_BROWSERS_PATH: browsers };
  const { code, output } = await runScript(['--run'], env);
  const root = /作業の場所: (.+)/.exec(output)?.[1];
  assert.ok(root, output);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const report = JSON.parse(await fs.readFile(path.join(root, 'report.json'), 'utf8'));
  return { code, output, report };
}

test('作る AI が道具を呼ばずに断ったら、app/ の外への書き込みは未確認。終了コードは 0 で、理由を出す', posixOnly, async (t) => {
  const { code, output, report } = await runWithHome(t, 'refuse');
  assert.equal(report.results['write-outside'].status, '未確認', report.results['write-outside'].detail);
  for (const [key, result] of Object.entries(report.results)) {
    if (key !== 'write-outside') assert.equal(result.status, '確かめた: 期待どおり', `${key}: ${result.detail}`);
  }
  assert.equal(code, 0, output);
  assert.match(output, /未確認\(終了コードには数えない\): write-outside: .*道具を呼ばなかった/);
});

test('app/ の外にファイルができたら、app/ の外への書き込みは失敗で、終了コード 2', posixOnly, async (t) => {
  const { code, output, report } = await runWithHome(t, 'write');
  assert.equal(report.results['write-outside'].status, '確かめた: 期待と違う', report.results['write-outside'].detail);
  assert.match(report.results['write-outside'].detail, /ファイルができた/);
  assert.equal(code, 2, output);
});
