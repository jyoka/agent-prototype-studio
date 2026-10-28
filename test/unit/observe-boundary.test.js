import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// 観察器の境界(docs/design/harness.md の 3.1、S2)。
// 観察器が import してよいのは、ビルドの結果、プレビューの配信、ブラウザの部品だけ。
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OBSERVER_DIR = path.join(ROOT, 'src', 'observer');
const HOST_PAGE = path.join(ROOT, 'src', 'ui', 'observe.js');

// 観察器の外で import してよいもの
const ALLOWED_PACKAGES = ['playwright-core'];
const ALLOWED_FILES = ['src/server/build.js', 'src/server/preview-server.js'].map((file) => path.join(ROOT, file));
// 作る AI、Studio の画面、版、会話の実装
const FORBIDDEN = [/src\/server\/build-requests\.js$/, /src\/server\/agent-[^/]+\.js$/, /src\/ui\/studio\.js$/, /src\/server\/versions\.js$/, /src\/server\/product-ai\//];

function importsOf(source) {
  const specs = [];
  const pattern = /(?:^|[\s;])(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|^\s*import\s*['"]([^'"]+)['"]/gm;
  for (const match of source.matchAll(pattern)) specs.push(match[1] ?? match[2] ?? match[3]);
  return specs;
}

async function observerFiles() {
  const entries = await fs.readdir(OBSERVER_DIR, { recursive: true });
  return entries.filter((name) => name.endsWith('.js')).map((name) => path.join(OBSERVER_DIR, name));
}

test('観察器の import は、観察器の中、node:、playwright-core、ビルドとプレビューの配信だけ', async () => {
  const files = await observerFiles();
  assert.ok(files.length >= 2);
  for (const file of files) {
    for (const spec of importsOf(await fs.readFile(file, 'utf8'))) {
      if (spec.startsWith('node:') || ALLOWED_PACKAGES.includes(spec)) continue;
      assert.ok(spec.startsWith('.'), `${path.relative(ROOT, file)} が ${spec} を import しています`);
      const target = path.resolve(path.dirname(file), spec);
      const inside = !path.relative(OBSERVER_DIR, target).startsWith('..');
      assert.ok(inside || ALLOWED_FILES.includes(target), `${path.relative(ROOT, file)} が ${spec} を import しています`);
    }
  }
});

test('観察器から、作る AI、Studio の画面、版、会話の実装へ、間接にもつながらない', async () => {
  const seen = new Set();
  const queue = await observerFiles();
  while (queue.length > 0) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    const relative = path.relative(ROOT, file).split(path.sep).join('/');
    for (const pattern of FORBIDDEN) assert.doesNotMatch(relative, pattern, `観察器から ${relative} につながっています`);
    for (const spec of importsOf(await fs.readFile(file, 'utf8'))) {
      if (spec.startsWith('.')) queue.push(path.resolve(path.dirname(file), spec));
    }
  }
});

test('import の見つけ方が、static、副作用だけ、動的な import を拾う', () => {
  assert.deepEqual(importsOf("import a from './a.js';\nimport './b.js';\nconst c = await import('./c.js');\nexport { d } from './d.js';"), [
    './a.js',
    './b.js',
    './c.js',
    './d.js',
  ]);
});

test('観察用の親ページは Studio の API を呼ばず、トークンを持たない', async () => {
  const source = await fs.readFile(HOST_PAGE, 'utf8');
  const code = source.replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(code, /fetch\s*\(|XMLHttpRequest|EventSource|WebSocket|sendBeacon|\/api\//);
  assert.doesNotMatch(code, /token/i);
  assert.match(code, /sandbox', 'allow-scripts allow-forms'/);
  assert.doesNotMatch(code, /allow-same-origin/);
  assert.doesNotMatch(code, /\bimport\b/);
});

// 観察を呼ぶ所(作るループの G5 と G6、Studio の observe()、CLI)は、同じ入口(observe-entry.js)を使う(S5)
const ENTRY = path.join(ROOT, 'src', 'server', 'observe-entry.js');
const CALLERS = [path.join(ROOT, 'src', 'server', 'index.js'), path.join(ROOT, 'bin', 'observe.js')];

async function sourceFiles() {
  const files = [];
  for (const dir of ['src', 'bin']) {
    for (const name of await fs.readdir(path.join(ROOT, dir), { recursive: true })) {
      const file = path.join(ROOT, dir, name);
      if (name.endsWith('.js') && path.relative(OBSERVER_DIR, file).startsWith('..')) files.push(file);
    }
  }
  return files;
}

test('呼ぶ所が同じ入口を使う: 観察器を直接呼ぶのは入口だけで、作るループと CLI は入口の observeProject を呼ぶ', async () => {
  // 観察器の observe({ build, ... }) を呼ぶのは、観察器の外では入口だけ
  const direct = [];
  for (const file of await sourceFiles()) {
    const code = (await fs.readFile(file, 'utf8')).replace(/^\s*\/\/.*$/gm, '');
    if (/\.observe\(\s*\{/.test(code)) direct.push(path.relative(ROOT, file));
  }
  assert.deepEqual(direct, [path.relative(ROOT, ENTRY)]);

  for (const file of CALLERS) {
    const source = await fs.readFile(file, 'utf8');
    const fromEntry = importsOf(source).some((spec) => path.resolve(path.dirname(file), spec) === ENTRY);
    assert.ok(fromEntry, `${path.relative(ROOT, file)} が観察の入口を import していません`);
    assert.match(source, /\bobserveProject\(\{/, `${path.relative(ROOT, file)} が observeProject を呼んでいません`);
  }

  // 作るループの関門 G5 と G6(build-requests.js の this.observe)には、入口を通す observeGate を渡す
  const index = await fs.readFile(CALLERS[0], 'utf8');
  assert.match(index, /observe: observeGate,/);
  const gate = index.slice(index.indexOf('async function observeGate('), index.indexOf('const requests = new BuildRequests('));
  assert.match(gate, /observeShown\(/);
  const shown = index.slice(index.indexOf('async function observeShown('), index.indexOf('async function observeGate('));
  assert.match(shown, /return observeProject\(\{/);
  // CLI は作業中の app/ を見るモードで、プロダクト内 AI はモックに決めている
  const cli = await fs.readFile(CALLERS[1], 'utf8');
  assert.match(cli, /mode: 'working'/);
  assert.match(cli, /aiConnection: 'mock'/);
});

// 観察の道具の MCP サーバー(jyoka/tasks#311)も、CLI と同じ入口の、作業中の app/ を見るモードを使う(S5)
const MCP_SERVER = path.join(ROOT, 'src', 'server', 'observe-mcp.js');

test('観察の道具の MCP サーバーは同じ入口を使う: どの道具も observeProject を作業中の app/ のモードとモックの AI で呼ぶ', async () => {
  const source = await fs.readFile(MCP_SERVER, 'utf8');
  const fromEntry = importsOf(source).some((spec) => path.resolve(path.dirname(MCP_SERVER), spec) === ENTRY);
  assert.ok(fromEntry, 'MCP サーバーが観察の入口を import していません');
  // 観察器を直接 import しない(Observer を作らない)。使ってよいのは操作の失敗とシナリオの検査だけ
  for (const spec of importsOf(source)) {
    const target = path.resolve(path.dirname(MCP_SERVER), spec);
    if (!path.relative(OBSERVER_DIR, target).startsWith('..')) {
      assert.ok(['operations.js', 'scenario.js'].includes(path.basename(target)), `MCP サーバーが ${spec} を import しています`);
    }
  }
  assert.doesNotMatch(source, /new Observer\(/);
  const calls = source.split(/\bobserveProject\(\{/).slice(1).map((rest) => rest.slice(0, rest.indexOf('});')));
  assert.equal(calls.length, 2, 'open と run_scenarios の 2 か所で呼ぶ');
  for (const call of calls) {
    assert.match(call, /mode: 'working'/);
    assert.match(call, /aiConnection: 'mock'/);
    // プロジェクトの場所は起動の引数で受け取ったものだけ
    assert.match(call, /projectDir: this\.projectDir,/);
  }
  // stdio の起動の口は、この MCP サーバーを使う
  const bin = await fs.readFile(path.join(ROOT, 'bin', 'observe-mcp.js'), 'utf8');
  assert.match(bin, /import\('\.\.\/src\/server\/observe-mcp\.js'\)/);
});
