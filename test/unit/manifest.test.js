import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildApp } from '../../src/server/build.js';
import { readManifest } from '../../src/server/manifest.js';

const MAIN = 'import { createRoot } from "react-dom/client";\ncreateRoot(document.body).render(<p>hi</p>);\n';
const AI = JSON.stringify({ name: '架空の相談役', fields: [{ key: 'topic', label: '話題', options: [{ value: '本', keywords: ['本'] }] }] });

// 架空の試作品の目録。どの題材でもない言葉だけで書く
const VALID = {
  formatVersion: 1,
  title: '架空の試作品',
  entry: 'src/start.jsx',
  intent: { purpose: '目録の形を確かめる', tryThis: ['ボタンを押す'] },
  constraints: ['データはすべて架空'],
  unimplemented: ['ログイン'],
  data: [{ file: 'data/items.js', about: '架空の品物の一覧' }],
  ai: 'settings/ai.json',
  scenarios: 'checks',
};

async function makeApp(t, files) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-manifest-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const appDir = path.join(root, 'project', 'app');
  await fs.mkdir(appDir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(appDir, name)), { recursive: true });
    await fs.writeFile(path.join(appDir, name), typeof content === 'string' ? content : JSON.stringify(content));
  }
  return { root, appDir, buildsDir: path.join(root, 'project', '.studio', 'builds') };
}

const validFiles = (manifest = VALID) => ({
  'prototype.json': manifest,
  'src/start.jsx': MAIN,
  'data/items.js': 'export const ITEMS = [];\n',
  'settings/ai.json': AI,
});

test('目録に書いた入口、AI の設定、データ、シナリオの置き場所で読む', async (t) => {
  const { appDir, buildsDir } = await makeApp(t, validFiles());
  const { manifest, errors } = await readManifest(appDir);
  assert.deepEqual(errors, []);
  assert.deepEqual(manifest, { ...VALID, declared: true });

  const result = await buildApp({ appDir, buildsDir });
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(result.ai.name, '架空の相談役');
  assert.equal(result.manifest.entry, 'src/start.jsx');
});

test('目録のない試作品は既定の値で読み、ビルドが通る', async (t) => {
  const { appDir, buildsDir } = await makeApp(t, { 'main.jsx': MAIN, 'ai.json': AI });
  const { manifest, errors } = await readManifest(appDir);
  assert.deepEqual(errors, []);
  assert.deepEqual(manifest, {
    formatVersion: 1,
    title: null,
    entry: 'main.jsx',
    intent: { purpose: null, tryThis: [] },
    constraints: [],
    unimplemented: [],
    data: [],
    ai: 'ai.json',
    scenarios: 'scenarios',
    declared: false,
  });
  const result = await buildApp({ appDir, buildsDir });
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(result.ai.name, '架空の相談役');
});

test('目録がなく ai.json もなければ、ai は null。入口は今までの順に探す', async (t) => {
  const { appDir } = await makeApp(t, { 'main.js': 'console.log(1);\n', 'main.ts': 'console.log(2);\n' });
  const { manifest } = await readManifest(appDir);
  assert.equal(manifest.ai, null);
  assert.equal(manifest.entry, 'main.js');
});

test('目録に書かない項目は既定の値で埋める', async (t) => {
  const { appDir, buildsDir } = await makeApp(t, { 'prototype.json': { formatVersion: 1 }, 'main.tsx': MAIN });
  const { manifest } = await readManifest(appDir);
  assert.equal(manifest.entry, 'main.tsx');
  assert.equal(manifest.ai, null);
  assert.equal(manifest.scenarios, 'scenarios');
  assert.equal(manifest.declared, true);
  const result = await buildApp({ appDir, buildsDir });
  assert.equal(result.ok, true, JSON.stringify(result.errors));
});

// 目録の形の誤りは、ビルドの失敗として、どの項目がどう違うかを返す(S20)
const BROKEN = [
  ['formatVersion が違う', { ...VALID, formatVersion: 2 }, /^formatVersion: 1 にしてください/],
  ['formatVersion がない', (({ formatVersion, ...rest }) => rest)(VALID), /^formatVersion: 1 にしてください\(今は なし\)/],
  ['型が違う(title が数)', { ...VALID, title: 3 }, /^title: 空でない文字列で書いてください/],
  ['型が違う(tryThis が文字列)', { ...VALID, intent: { purpose: 'x', tryThis: 'ボタン' } }, /^intent\.tryThis: 50 個までの文字列の配列/],
  ['型が違う(data が オブジェクト)', { ...VALID, data: { file: 'data/items.js' } }, /^data: 50 個までの配列/],
  ['data の about がない', { ...VALID, data: [{ file: 'data/items.js' }] }, /^data\[0\]\.about: 空でない文字列/],
  ['使えない項目', { ...VALID, extra: true }, /「extra」は使えない項目です/],
  ['entry が app/ の外', { ...VALID, entry: '../outside.jsx' }, /^entry: app\/ の外は指せません/],
  ['entry が絶対パス', { ...VALID, entry: '/etc/hosts.js' }, /^entry: .*絶対パスは使えません/],
  ['entry がない', { ...VALID, entry: 'nothing.jsx' }, /^entry: app\/nothing\.jsx がありません/],
  ['entry が script でない', { ...VALID, entry: 'data/items.json' }, /^entry: 入口は .jsx、.tsx、.js、.ts のどれか/],
  ['ai が app/ の外', { ...VALID, ai: 'settings/../../ai.json' }, /^ai: app\/ の外は指せません/],
  ['ai が Windows の絶対パス', { ...VALID, ai: 'C:\\ai.json' }, /^ai: .*絶対パスは使えません/],
  ['ai がドライブ文字つき', { ...VALID, ai: 'C:ai.json' }, /^ai: .*絶対パスは使えません/],
  ['ai の末尾に /', { ...VALID, ai: 'settings/ai.json/' }, /^ai: ファイルを指してください/],
  ['data の file が app/ の外', { ...VALID, data: [{ file: '../secret.js', about: 'x' }] }, /^data\[0\]\.file: app\/ の外は指せません/],
  ['data の file がない', { ...VALID, data: [{ file: 'data/none.js', about: 'x' }] }, /^data\[0\]\.file: app\/data\/none\.js がありません/],
  ['scenarios が app/ の外', { ...VALID, scenarios: '../scenarios' }, /^scenarios: app\/ の外は指せません/],
  ['scenarios が app/ そのもの', { ...VALID, scenarios: './' }, /^scenarios: app\/ の中のファイルやフォルダーを指してください/],
  ['scenarios がファイル', { ...VALID, scenarios: 'data/items.js' }, /^scenarios: app\/data\/items\.js はフォルダーにしてください/],
];

for (const [name, manifest, expected] of BROKEN) {
  test(`目録の誤りはビルドの失敗になる: ${name}`, async (t) => {
    const { appDir, buildsDir } = await makeApp(t, validFiles(manifest));
    const result = await buildApp({ appDir, buildsDir });
    assert.equal(result.ok, false);
    assert.ok(
      result.errors.some((e) => e.file === 'app/prototype.json' && expected.test(e.text)),
      JSON.stringify(result.errors),
    );
    // ai.json の誤りと同じ形で返す
    assert.deepEqual(Object.keys(result.errors[0]).sort(), ['column', 'file', 'line', 'lineText', 'text']);
    assert.equal(await fs.readdir(buildsDir).catch(() => []).then((d) => d.length), 0);
  });
}

test('JSON として読めない目録と、オブジェクトでない目録は誤り', async (t) => {
  const { appDir, buildsDir } = await makeApp(t, { 'prototype.json': '{ "formatVersion": 1,', 'main.jsx': MAIN });
  const result = await buildApp({ appDir, buildsDir });
  assert.equal(result.ok, false);
  assert.match(result.errors[0].text, /^JSON として読めません/);

  await fs.writeFile(path.join(appDir, 'prototype.json'), '[]');
  const { errors } = await readManifest(appDir);
  assert.match(errors[0].text, /全体を \{ … \} のオブジェクトで書いてください/);
});

test('目録がフォルダーなら誤り', async (t) => {
  const { appDir } = await makeApp(t, { 'main.jsx': MAIN });
  await fs.mkdir(path.join(appDir, 'prototype.json'));
  const { errors } = await readManifest(appDir);
  assert.deepEqual(errors, [{ file: 'app/prototype.json', text: '普通のファイルにしてください' }]);
});

test('目録が指す AI の設定の誤りは、そのファイルの名前で返す', async (t) => {
  const { appDir, buildsDir } = await makeApp(t, { ...validFiles(), 'settings/ai.json': '{"name": "x"}' });
  const result = await buildApp({ appDir, buildsDir });
  assert.equal(result.ok, false);
  assert.equal(result.errors[0].file, 'app/settings/ai.json');
});
