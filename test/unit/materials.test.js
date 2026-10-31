import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DEFAULT_MATERIAL_GUIDE, STUDIO_SYSTEM_PROMPT } from '../../src/server/claude-args.js';
import { ALLOWED_PACKAGES, NPM_LIBRARIES, STUDIO_PACKAGES, buildApp } from '../../src/server/build.js';
import { STUDIO_ROOT } from '../../src/server/config.js';
import { buildSourceList, collectBundledPackages } from '../../scripts/material-sources.js';

const MATERIAL_DIR = path.join(STUDIO_ROOT, 'materials', 'default');
const FIXTURE_APP = path.join(STUDIO_ROOT, 'test', 'fixtures', 'default-material', 'app');
const MAIN = 'import { createRoot } from "react-dom/client";\ncreateRoot(document.body).render(<p>hi</p>);\n';

async function readList() {
  return JSON.parse(await fs.readFile(path.join(MATERIAL_DIR, 'source.json'), 'utf8'));
}

async function tempDirs(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-material-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, buildsDir: path.join(root, '.studio', 'builds') };
}

async function buildFiles(t, files) {
  const { root, buildsDir } = await tempDirs(t);
  const appDir = path.join(root, 'app');
  await fs.mkdir(appDir, { recursive: true });
  for (const [name, content] of Object.entries(files)) await fs.writeFile(path.join(appDir, name), content);
  return { result: await buildApp({ appDir, buildsDir }), buildsDir };
}

test('既定の素材の部品、色、アイコンを import してビルドできる。字とアイコンのファイルも外の URL も出力に増えない', async (t) => {
  const { buildsDir } = await tempDirs(t);
  const result = await buildApp({ appDir: FIXTURE_APP, buildsDir });
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  const out = path.join(buildsDir, result.buildId);
  assert.deepEqual((await fs.readdir(out)).sort(), ['app.css', 'app.js', 'index.html', 'runtime.js']);
  const css = await fs.readFile(path.join(out, 'app.css'), 'utf8');
  assert.match(css, /\.rt-Button/);
  // --blue-9 は Themes にもあるので、Radix Colors の CSS が束に入ったことは元のパスの注釈で見る
  assert.match(css, /\/\* .*node_modules\/@radix-ui\/colors\/blue\.css \*\//);
  // 字は OS の字だけ(local)。CSS から読むものは 1 つもない
  assert.doesNotMatch(css, /url\(/);
  assert.doesNotMatch(css, /@import/);
  assert.ok([...css.matchAll(/src:\s*([^;]+);/g)].every((m) => /^local\(/.test(m[1])));
});

test('CSS の @import でも、既定の素材の CSS を読める', async (t) => {
  const { result } = await buildFiles(t, {
    'main.jsx': `import "./app.css";\n${MAIN}`,
    'app.css': '@import "@radix-ui/themes/styles.css";\n@import "@radix-ui/colors/blue-dark-alpha.css";\n',
  });
  assert.equal(result.ok, true, JSON.stringify(result.errors));
});

test('既定の素材のうち、許した名前のほかは今どおり落ちる', async (t) => {
  const refused = [
    'radix-ui',
    '@radix-ui/react-dialog',
    '@radix-ui/themes/package.json',
    '@radix-ui/themes/dist/esm/index.js',
    '@radix-ui/themes/tokens.css',
    '@radix-ui/colors/colors.png',
    '@radix-ui/colors/index.js',
    '@radix-ui/colors/package.json',
    '@radix-ui/colors/../../../package.json',
    '@radix-ui/colors/../themes/styles.css',
    'lucide-react/dynamic',
    'lucide-react/package.json',
    '@floating-ui/dom',
    'classnames',
    '@material/web',
    'lodash',
  ];
  const { result } = await buildFiles(t, { 'main.js': refused.map((name) => `import ${JSON.stringify(name)};`).join('\n') });
  assert.equal(result.ok, false);
  assert.equal(result.stage, 'compile');
  const texts = result.errors.map((e) => e.text);
  for (const name of refused) assert.ok(texts.some((text) => text.startsWith(`「${name}」は使えません`)), name);
  // どこを直せばよいかが分かるように、使える名前も出す
  assert.match(texts[0], /@radix-ui\/themes, .*lucide-react, @radix-ui\/colors\/<色>\.css/);
});

test('同梱の npm のパッケージの名前は、スコープつきも含めて中のファイルを除いて並ぶ', () => {
  assert.deepEqual(NPM_LIBRARIES, ['react', 'react-dom', '@radix-ui/themes', '@radix-ui/colors', 'lucide-react']);
  assert.ok(ALLOWED_PACKAGES.includes('@radix-ui/themes/styles.css'));
  for (const name of STUDIO_PACKAGES) assert.ok(!NPM_LIBRARIES.includes(name), name);
});

test('出典とライセンスの一覧は、入っている同梱のパッケージの全部と一致する', async () => {
  const list = await readList();
  const row = ({ name, version, license }) => `${name}@${version} ${license}`;
  assert.deepEqual(list.packages.map(row).sort(), collectBundledPackages().map(row).sort());
  // 手で直した跡や古い一覧が残らない。一覧も原文も、作り直しと同じ中身
  const rebuilt = buildSourceList();
  assert.deepEqual(list, rebuilt.list);
  for (const { file, text } of rebuilt.licenses) assert.equal(await fs.readFile(path.join(MATERIAL_DIR, file), 'utf8'), text, file);
  // 役の決まりも、同梱した素材を指す
  for (const { package: name } of list.roles.filter((r) => r.package)) {
    assert.ok(list.packages.some((p) => p.name === name), name);
  }
  assert.ok(list.roles.some((r) => r.role === '字' && r.package === null));
  for (const name of NPM_LIBRARIES) assert.ok(list.roles.some((r) => r.package === name), name);
});

test('見本の束に入ったパッケージは、全部が出典とライセンスの一覧に載る', async (t) => {
  const { packages } = await readList();
  const { buildsDir } = await tempDirs(t);
  const result = await buildApp({ appDir: FIXTURE_APP, buildsDir });
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  const out = path.join(buildsDir, result.buildId);
  const bundled = new Set();
  for (const file of ['app.js', 'app.css']) {
    const text = await fs.readFile(path.join(out, file), 'utf8');
    // esbuild は束ねたファイルの前に、元のパスを注釈で書く
    for (const m of text.matchAll(/^\s*(?:\/\/|\/\*)\s*.*node_modules\/((?:@[^/\s]+\/)?[^/\s]+)\//gm)) bundled.add(m[1]);
  }
  for (const name of ['react', 'react-dom', '@radix-ui/themes', '@radix-ui/colors', 'lucide-react']) assert.ok(bundled.has(name), name);
  const missing = [...bundled].filter((name) => !packages.some((p) => p.name === name));
  assert.deepEqual(missing, []);
});

test('一覧の全部に、出典の URL と、読めるライセンスの原文がある', async () => {
  const { packages } = await readList();
  assert.ok(packages.length > 0);
  for (const pkg of packages) {
    assert.match(pkg.source, /^https:\/\/github\.com\/[^/]+\/[^/]+$/, pkg.name);
    assert.ok(['MIT', 'ISC', '0BSD'].includes(pkg.license), `${pkg.name}: ${pkg.license}`);
    const text = await fs.readFile(path.join(MATERIAL_DIR, pkg.licenseFile), 'utf8');
    assert.match(text, pkg.license === '0BSD' ? /Permission to use, copy, modify/ : /Permission/, pkg.name);
    assert.match(text, /Copyright/i, pkg.name);
  }
  // 原文を置いたのに一覧が指していないファイルは残さない
  const used = new Set(packages.map((p) => path.basename(p.licenseFile)));
  assert.deepEqual((await fs.readdir(path.join(MATERIAL_DIR, 'licenses'))).filter((f) => !used.has(f)), []);
});

test('指針の要約を作る AI の決まりに入れ、5 つの項目が全部ある', () => {
  assert.ok(STUDIO_SYSTEM_PROMPT.includes(DEFAULT_MATERIAL_GUIDE));
  for (const heading of ['部品の選び方', '色の役割', '字の大きさ', '間隔', 'アクセシビリティ']) {
    assert.ok(DEFAULT_MATERIAL_GUIDE.includes(`${heading}:`), heading);
  }
  for (const name of ['@radix-ui/themes', '@radix-ui/colors', 'lucide-react']) assert.ok(STUDIO_SYSTEM_PROMPT.includes(name), name);
  assert.doesNotMatch(DEFAULT_MATERIAL_GUIDE, /https?:\/\//);
});

test('指針が名を挙げる部品と CSS の変数は、同梱した素材に実際にある', async (t) => {
  const parts = [...new Set(DEFAULT_MATERIAL_GUIDE.match(/(?<![.\w])[A-Z][A-Za-z]+\b/g))]
    .filter((word) => !['Theme', 'Web', 'CSS', 'OS', 'Studio'].includes(word) && !word.startsWith('Radix'))
    .sort();
  assert.ok(parts.includes('AlertDialog') && parts.includes('IconButton'), parts.join(','));
  // esbuild は、ない名前の import をビルドの失敗にする
  const { result, buildsDir } = await buildFiles(t, {
    'main.jsx': `import { Theme, ${parts.join(', ')} } from "@radix-ui/themes";\nimport "@radix-ui/themes/styles.css";\nimport "@radix-ui/colors/blue.css";\nconsole.log(Theme, ${parts.join(', ')});\n`,
  });
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  const css = await fs.readFile(path.join(buildsDir, result.buildId, 'app.css'), 'utf8');
  for (const [, name] of DEFAULT_MATERIAL_GUIDE.matchAll(/var\((--[a-z0-9-]+)\)/g)) assert.ok(css.includes(`${name}:`), name);
});
