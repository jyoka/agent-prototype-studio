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
