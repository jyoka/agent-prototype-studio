import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildApp } from '../../src/server/build.js';
import { MaterialError, ProjectMaterials, materialRule } from '../../src/server/materials.js';
import { ProjectStore } from '../../src/server/store.js';
import { packFixture } from '../fixtures/design-packages/pack.js';

// 部品のパッケージ(docs/design/user-journey.md の J5 の後半)。置き場所、試作品ごとの import、関門 G3。パッケージはどれも架空
const FIXTURE = new URL('../fixtures/design-packages/', import.meta.url);
const PACKAGE = new URL('minato-ui/', FIXTURE).pathname;
const MIT = { license: 'listed', licenseName: 'MIT' };
const tgz = async (extra) => (await packFixture(PACKAGE, extra)).toString('base64');

async function makeHome(t, ids = ['shop']) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-packages-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  for (const id of ids) await fs.cp(new URL('app/', FIXTURE), path.join(home, 'projects', id, 'app'), { recursive: true });
  const store = new ProjectStore(home);
  return { home, store, materials: new ProjectMaterials({ store }), root: (id) => path.join(home, 'projects', id) };
}

const gate = (root) => buildApp({ appDir: path.join(root, 'app'), buildsDir: path.join(root, '.studio', 'builds'), projectRoot: root });

test('有効にした試作品だけが import できる。中身は .studio/ に置き、app/ には写さない', async (t) => {
  const { materials, root } = await makeHome(t, ['shop', 'other']);
  const before = await gate(root('shop'));
  assert.equal(before.ok, false);
  assert.match(before.errors[0].text, /「@minato\/ui」は使えません/);

  const result = await materials.enablePackage('shop', { tarball: await tgz(), fileName: 'minato-ui-1.2.0.tgz', answers: MIT, source: '架空のデザイン担当', reason: '架空の理由' });
  assert.equal(result.enabled, true);
  assert.equal(result.build.ok, true, result.build.firstError);
  assert.equal(result.check.files, undefined, '展開した中身は画面に返さない');
  const view = result.materials.packages.items[0];
  assert.deepEqual([view.name, view.version, view.licenseLabel, view.networkCount], ['@minato/ui', '1.2.0', '公開のライセンス(MIT)', 3]);
  assert.ok(await fs.stat(path.join(root('shop'), '.studio', 'materials', 'packages', 'node_modules', '@minato', 'ui', 'index.js')));
  await assert.rejects(fs.lstat(path.join(root('shop'), 'app', 'node_modules')), '作る AI が読める所に置かない');
  const built = await gate(root('shop'));
  assert.equal(built.ok, true);
  const js = await fs.readFile(path.join(root('shop'), '.studio', 'builds', built.buildId, 'app.js'), 'utf8');
  assert.match(js, /minato-card/);
  const css = await fs.readFile(path.join(root('shop'), '.studio', 'builds', built.buildId, 'app.css'), 'utf8');
  assert.match(css, /\.minato-card/);

  // ほかの試作品からは import できない
  const other = await gate(root('other'));
  assert.equal(other.ok, false);
  assert.match(other.errors[0].text, /「@minato\/ui」は使えません/);

  const rule = await materialRule(root('shop'));
  assert.match(rule, /「@minato\/ui」\(1\.2\.0\)を import できる/);
  assert.equal(await materialRule(root('other')), null);
  const source = JSON.parse(await fs.readFile(path.join(root('shop'), '.studio', 'materials', 'source.json'), 'utf8'));
  assert.deepEqual(source.history.map((entry) => [entry.kind, entry.action, entry.name]), [['package', 'enable', '@minato/ui']]);
  assert.ok(await fs.stat(path.join(root('shop'), '.studio', 'materials', 'packages', 'tarballs', `${source.packages[0].sha256}.tgz`)));
});

test('置いた中身が変わると関門 G3 で止め、作る AI には直せない印を付ける。外すと import できなくなる', async (t) => {
  const { materials, root } = await makeHome(t);
  await materials.enablePackage('shop', { tarball: await tgz(), answers: MIT, source: '架空' });
  await fs.appendFile(path.join(root('shop'), '.studio', 'materials', 'packages', 'node_modules', '@minato', 'ui', 'index.js'), '\n// 変えた\n');
  const changed = await gate(root('shop'));
  assert.equal(changed.ok, false);
  assert.equal(changed.stage, 'contract');
  assert.equal(changed.errors[0].locked, true);
  assert.match(changed.errors[0].text, /「@minato\/ui」の中身が、有効にしたときから変わっている/);

  // 受け取ったファイル(引き継ぎに写すもの)がなくなっても止める
  await fs.writeFile(path.join(root('shop'), '.studio', 'materials', 'packages', 'node_modules', '@minato', 'ui', 'index.js'), await fs.readFile(path.join(PACKAGE, 'index.js')));
  assert.equal((await gate(root('shop'))).ok, true, '元に戻すと通る');
  await fs.rm(path.join(root('shop'), '.studio', 'materials', 'packages', 'tarballs'), { recursive: true });
  assert.equal((await gate(root('shop'))).errors[0].locked, true);

  const removed = await materials.disablePackage('shop', { name: '@minato/ui' });
  assert.equal(removed.build.ok, false, '試作品がまだ import している');
  assert.match(removed.build.firstError, /「@minato\/ui」は使えません/);
  assert.deepEqual(removed.materials.packages.items, []);
  await assert.rejects(fs.lstat(path.join(root('shop'), '.studio', 'materials', 'packages', 'node_modules', '@minato')));
  await assert.rejects(materials.disablePackage('shop', { name: '@minato/ui' }), (error) => error instanceof MaterialError && error.status === 404);
});

test('ライセンスが分からない、誰の素材か書いていない、検査に通らないときは、何も置かない', async (t) => {
  const { materials, root } = await makeHome(t);
  await assert.rejects(materials.enablePackage('shop', { tarball: await tgz(), answers: { license: 'unknown' }, source: '架空' }), (error) => error instanceof MaterialError && error.status === 409 && /ライセンスが分かりません/.test(error.message));
  await assert.rejects(materials.enablePackage('shop', { tarball: await tgz(), answers: MIT, source: ' ' }), (error) => error.status === 400);
  await assert.rejects(materials.enablePackage('shop', { tarball: await tgz(), answers: MIT, source: '架空', scope: 'all' }), (error) => error.status === 400);
  const refused = await materials.enablePackage('shop', { tarball: await tgz({ 'package.json': JSON.stringify({ name: '@minato/ui', version: '1.0.0', scripts: { install: 'node-gyp rebuild' } }) }), answers: MIT, source: '架空' });
  assert.equal(refused.enabled, false);
  assert.match(refused.check.errors[0].text, /インストールの時に動くスクリプト/);
  await assert.rejects(fs.lstat(path.join(root('shop'), '.studio', 'materials')));
});

test('置いた後に中身をすり替えても、同梱のライブラリの中を通って外へ出る import はビルドが止める', async (t) => {
  const { materials, root } = await makeHome(t);
  await materials.enablePackage('shop', { tarball: await tgz(), answers: MIT, source: '架空' });
  const dir = path.join(root('shop'), '.studio', 'materials', 'packages', 'node_modules', '@minato', 'ui');
  await fs.writeFile(path.join(dir, 'index.js'), "import pkg from '@radix-ui/colors/../../../package.json';\nexport const ShopCard = () => pkg;\nexport const MinatoButton = () => null;\n");
  const sourceFile = path.join(root('shop'), '.studio', 'materials', 'source.json');
  const source = JSON.parse(await fs.readFile(sourceFile, 'utf8'));
  const { digestFiles } = await import('../../src/server/packages.js');
  const files = await Promise.all((await fs.readdir(dir)).map(async (name) => ({ path: name, data: await fs.readFile(path.join(dir, name)) })));
  source.packages[0].digest = digestFiles(files);
  await fs.writeFile(sourceFile, JSON.stringify(source));
  const result = await gate(root('shop'));
  assert.equal(result.ok, false);
  assert.match(result.errors.map((e) => e.text).join('\n'), /部品のパッケージの中の「@radix-ui\/colors\/\.\.\/\.\.\/\.\.\/package\.json」は使えません/);
});

test('パッケージの中から、同梱のライブラリと自分の中のほかは読めない', async (t) => {
  const { materials, root } = await makeHome(t);
  // 試しの組み立ての後に中身をすり替えたとしても、ビルドが同じ決まりで止める(指紋を合わせ直して確かめる)
  await materials.enablePackage('shop', { tarball: await tgz(), answers: MIT, source: '架空' });
  const dir = path.join(root('shop'), '.studio', 'materials', 'packages', 'node_modules', '@minato', 'ui');
  await fs.writeFile(path.join(dir, 'index.js'), "import '../../../../../../app/main.jsx';\nexport const ShopCard = () => null;\nexport const MinatoButton = () => null;\n");
  const sourceFile = path.join(root('shop'), '.studio', 'materials', 'source.json');
  const source = JSON.parse(await fs.readFile(sourceFile, 'utf8'));
  const { digestFiles } = await import('../../src/server/packages.js');
  const files = await Promise.all((await fs.readdir(dir)).map(async (name) => ({ path: name, data: await fs.readFile(path.join(dir, name)) })));
  source.packages[0].digest = digestFiles(files);
  await fs.writeFile(sourceFile, JSON.stringify(source));
  const result = await gate(root('shop'));
  assert.equal(result.ok, false);
  assert.match(result.errors.map((e) => e.text).join('\n'), /部品のパッケージの外は読み込めません/);
});
