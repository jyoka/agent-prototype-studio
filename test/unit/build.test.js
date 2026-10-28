import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildApp } from '../../src/server/build.js';
import { STUDIO_ROOT } from '../../src/server/config.js';

async function makeApp(t, files) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-build-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const appDir = path.join(root, 'project', 'app');
  for (const [name, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(appDir, name)), { recursive: true });
    await fs.writeFile(path.join(appDir, name), content);
  }
  await fs.mkdir(appDir, { recursive: true });
  return { root, appDir, buildsDir: path.join(root, 'project', '.studio', 'builds') };
}

test('サンプルは React ごと 1 つの script に束ねられる', async (t) => {
  const { buildsDir } = await makeApp(t, {});
  const result = await buildApp({ appDir: path.join(STUDIO_ROOT, 'samples', 'library', 'app'), buildsDir });
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  const files = (await fs.readdir(path.join(buildsDir, result.buildId))).sort();
  assert.deepEqual(files, ['app.css', 'app.js', 'index.html', 'runtime.js']);
  const html = await fs.readFile(path.join(buildsDir, result.buildId, 'index.html'), 'utf8');
  assert.match(html, /<script src="runtime.js" crossorigin="anonymous"><\/script>\s*<script src="app.js"/);
  assert.match(html, /href="app.css"/);
});

test('文法の誤りは、app/ からのパスと行で返す', async (t) => {
  const { appDir, buildsDir } = await makeApp(t, { 'main.js': 'import { x } from "./part.js";\nconsole.log(x);\n', 'part.js': 'export const x = (;\n' });
  const result = await buildApp({ appDir, buildsDir });
  assert.equal(result.ok, false);
  assert.equal(result.errors[0].file, 'app/part.js');
  assert.equal(result.errors[0].line, 1);
  assert.equal(await fs.readdir(buildsDir).catch(() => []).then((d) => d.length), 0);
});

test('入口のファイルがなければ、置くべき名前を返す', async (t) => {
  const { appDir, buildsDir } = await makeApp(t, { 'other.js': '' });
  const result = await buildApp({ appDir, buildsDir });
  assert.equal(result.ok, false);
  assert.match(result.errors[0].text, /app\/main\.jsx/);
});

test('同梱していないライブラリと、app/ の外のファイルは読み込めない', async (t) => {
  const { root, appDir, buildsDir } = await makeApp(t, {
    'main.js': 'import "lodash";\nimport "../secret.js";\nimport "/etc/hosts";\nimport "https://example.com/x.js";\n',
  });
  await fs.writeFile(path.join(root, 'project', 'secret.js'), 'export default 1;');
  const result = await buildApp({ appDir, buildsDir });
  assert.equal(result.ok, false);
  const texts = result.errors.map((e) => e.text).join('\n');
  assert.match(texts, /「lodash」は使えません/);
  assert.match(texts, /app\/ の外のファイルは読み込めません: \.\.\/secret\.js/);
  assert.match(texts, /app\/ の外のファイルは読み込めません: \/etc\/hosts/);
  assert.match(texts, /外部の URL は読み込めません/);
});

test('同梱のライブラリの中の import は解決できる', async (t) => {
  const { appDir, buildsDir } = await makeApp(t, {
    'main.jsx': 'import { createRoot } from "react-dom/client";\ncreateRoot(document.body).render(<p>hi</p>);\n',
  });
  const result = await buildApp({ appDir, buildsDir });
  assert.equal(result.ok, true, JSON.stringify(result.errors));
});

test('日本語や空白の名前の画像も、配信できる名前で出力する', async (t) => {
  const { appDir, buildsDir } = await makeApp(t, {
    'main.js': 'import url from "./写真 1.png";\nconsole.log(url);\n',
    '写真 1.png': 'not really a png',
  });
  const result = await buildApp({ appDir, buildsDir });
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  const files = await fs.readdir(path.join(buildsDir, result.buildId));
  const asset = files.find((name) => name.endsWith('.png'));
  assert.match(asset, /^asset-[A-Z0-9]+\.png$/);
});

test('app/ の検査で問題があれば、ビルドしない', { skip: process.platform === 'win32' }, async (t) => {
  const { root, appDir, buildsDir } = await makeApp(t, { 'main.js': 'console.log(1);\n', 'CLAUDE.md': 'x' });
  await fs.symlink(path.join(root, 'outside.txt'), path.join(appDir, 'link.txt'));
  await fs.mkdir(path.join(appDir, '.claude'));
  const result = await buildApp({ appDir, buildsDir });
  assert.equal(result.ok, false);
  const found = result.errors.map((e) => `${e.file} ${e.text}`).sort();
  assert.deepEqual(found, [
    'app/.claude この名前のファイルやフォルダーは app/ に置けません',
    'app/CLAUDE.md この名前のファイルやフォルダーは app/ に置けません',
    'app/link.txt シンボリックリンクは使えません',
  ]);
});

test('見本 3 つは目録を持ち、目録どおりにビルドできる', async (t) => {
  const { buildsDir } = await makeApp(t, {});
  for (const sample of ['job-consult', 'library', 'study-consult']) {
    const appDir = path.join(STUDIO_ROOT, 'samples', sample, 'app');
    const result = await buildApp({ appDir, buildsDir });
    assert.equal(result.ok, true, `${sample}: ${JSON.stringify(result.errors)}`);
    assert.equal(result.manifest.declared, true, sample);
    assert.equal(result.manifest.entry, 'main.jsx', sample);
    assert.ok(result.manifest.title && result.manifest.intent.purpose, sample);
    assert.ok(result.manifest.constraints.includes('データはすべて架空'), sample);
    assert.ok(result.manifest.data.length > 0, sample);
    assert.equal(result.manifest.ai !== null, result.ai !== null, sample);
  }
});

test('見本 3 つは変えずにビルドでき、構成 B として読まれる(R2)', async (t) => {
  const { buildsDir } = await makeApp(t, {});
  for (const sample of ['job-consult', 'library', 'study-consult']) {
    const appDir = path.join(STUDIO_ROOT, 'samples', sample, 'app');
    const result = await buildApp({ appDir, buildsDir });
    assert.equal(result.ok, true, `${sample}: ${JSON.stringify(result.errors)}`);
    // 見本は composition.json を持たない。目録は版 1 のまま
    assert.equal(result.manifest.formatVersion, 1, sample);
    assert.deepEqual(result.simulation.compositions, [], sample);
    assert.deepEqual(result.simulation.evals, [], sample);
    if (result.ai === null) {
      // AI のない見本(図書室)は、今と同じく構成もない
      assert.equal(result.simulation.composition, null, sample);
      continue;
    }
    const { composition } = result.simulation;
    assert.equal(composition.file, null, sample);
    assert.equal(composition.driver, 'main', sample);
    assert.deepEqual(composition.participants, [
      { id: 'main', kind: 'harness', label: result.ai.name, owner: 'studio', ai: 'ai.json', returnTo: null },
    ], sample);
    assert.equal(composition.tools, null, sample);
    assert.deepEqual(composition.guards, [], sample);
  }
});

test('ビルドの誤りには、止まった段の名前(inspect、contract、compile)が付く', async (t) => {
  const MAIN = 'console.log(1);\n';
  const cases = [
    ['inspect', { 'main.js': MAIN, 'CLAUDE.md': 'x' }],
    ['contract', { 'main.js': MAIN, 'prototype.json': '{ "formatVersion": 1,' }],
    ['contract', { 'main.js': MAIN, 'ai.json': '{"name": "x"}' }],
    ['contract', { 'other.js': MAIN }],
    ['compile', { 'main.js': 'const x = (;\n' }],
  ];
  for (const [stage, files] of cases) {
    const { appDir, buildsDir } = await makeApp(t, files);
    const result = await buildApp({ appDir, buildsDir });
    const label = `${stage}: ${Object.keys(files).join(', ')}`;
    assert.equal(result.ok, false, label);
    assert.equal(result.stage, stage, label);
    assert.ok(result.errors.length > 0, label);
    assert.ok(result.errors.every((e) => e.stage === stage), `${label}: ${JSON.stringify(result.errors)}`);
  }
  // 通ったビルドには段の名前を付けない
  const { appDir, buildsDir } = await makeApp(t, { 'main.js': MAIN });
  const ok = await buildApp({ appDir, buildsDir });
  assert.equal(ok.ok, true);
  assert.equal(ok.stage, undefined);
});

test('目録が指すシナリオの形の誤りは、contract の段の失敗として、ファイル、シナリオ、手順で返す', async (t) => {
  const MAIN = 'console.log(1);\n';
  const good = JSON.stringify({ name: '架空の確かめ', steps: [{ expect: 'noErrors' }] });
  const bad = JSON.stringify({ name: '架空の注文', steps: [{ expect: 'noErrors' }, { do: 'click' }, { do: 'hover' }] });

  // 既定の置き場所(app/scenarios/)
  const plain = await makeApp(t, { 'main.js': MAIN, 'scenarios/a-good.json': good, 'scenarios/b-bad.json': bad });
  const result = await buildApp({ appDir: plain.appDir, buildsDir: plain.buildsDir });
  assert.equal(result.ok, false);
  assert.equal(result.stage, 'contract');
  assert.deepEqual(
    result.errors.map((e) => [e.stage, e.file, e.scenario, e.step, e.line]),
    [
      ['contract', 'app/scenarios/b-bad.json', '架空の注文', 2, null],
      ['contract', 'app/scenarios/b-bad.json', '架空の注文', 3, null],
    ],
  );
  assert.match(result.errors[0].text, /^2 番目の手順: /);
  assert.equal(await fs.readdir(plain.buildsDir).catch(() => []).then((d) => d.length), 0);

  // 目録で置き場所を変えたら、そこを検査する。読めない JSON も同じ段の失敗
  const moved = await makeApp(t, {
    'main.js': MAIN,
    'prototype.json': JSON.stringify({ formatVersion: 1, scenarios: 'checks' }),
    'checks/broken.json': '{ "name": ',
    'scenarios/b-bad.json': bad,
  });
  const movedResult = await buildApp({ appDir: moved.appDir, buildsDir: moved.buildsDir });
  assert.equal(movedResult.stage, 'contract');
  assert.deepEqual(movedResult.errors.map((e) => e.file), ['app/checks/broken.json']);
  assert.match(movedResult.errors[0].text, /JSON として読めません/);

  // 形の正しいシナリオだけなら、ビルドは通る
  const fine = await makeApp(t, { 'main.js': MAIN, 'scenarios/a-good.json': good });
  assert.equal((await buildApp({ appDir: fine.appDir, buildsDir: fine.buildsDir })).ok, true);
});
