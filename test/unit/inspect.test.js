import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { inspectApp } from '../../src/server/inspect.js';

test('大きさと数の上限を超えたら知らせる', async (t) => {
  const appDir = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-inspect-'));
  t.after(() => fs.rm(appDir, { recursive: true, force: true }));
  await fs.writeFile(path.join(appDir, 'a.js'), 'x'.repeat(20));
  await fs.writeFile(path.join(appDir, 'b.js'), 'y'.repeat(5));
  const problems = await inspectApp(appDir, { maxFiles: 1, maxFileBytes: 10, maxTotalBytes: 15 });
  assert.deepEqual(problems.map((p) => p.file).sort(), ['app/', 'app/', 'app/a.js']);
});

test('名前は大文字と小文字を区別せずに調べる', async (t) => {
  const appDir = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-inspect-'));
  t.after(() => fs.rm(appDir, { recursive: true, force: true }));
  await fs.mkdir(path.join(appDir, 'sub'));
  await fs.writeFile(path.join(appDir, 'sub', 'Claude.MD'), '');
  await fs.writeFile(path.join(appDir, '.MCP.json'), '');
  const problems = await inspectApp(appDir);
  assert.deepEqual(problems.map((p) => p.file).sort(), ['app/.MCP.json', 'app/sub/Claude.MD']);
});

test('app/ がなければ知らせる', async () => {
  const problems = await inspectApp(path.join(os.tmpdir(), 'studio-no-such-dir-273'));
  assert.equal(problems[0].text, 'app/ フォルダーがありません');
});
