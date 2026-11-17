import assert from 'node:assert/strict';
import test from 'node:test';
import { checkPackage, digestFiles, packageNameOf, packagesRule, readTarball } from '../../src/server/packages.js';
import { packFixture, tarball } from '../fixtures/design-packages/pack.js';

// 部品のパッケージの検査(docs/design/user-journey.md の J5 の後半)。パッケージはどれも架空
const DIR = new URL('../fixtures/design-packages/minato-ui/', import.meta.url).pathname;
const MIT = { license: 'listed', licenseName: 'MIT' };
const manifest = (fields) => JSON.stringify({ name: '@minato/ui', version: '1.0.0', ...fields });

test('npm pack の形のファイルを展開して、名前、版、使える名前、外への通信、ライセンスの手がかりを返す', async () => {
  const check = await checkPackage({ tarball: await packFixture(DIR), answers: MIT });
  assert.equal(check.ok, true, JSON.stringify(check.errors));
  assert.equal(check.name, '@minato/ui');
  assert.equal(check.version, '1.2.0');
  assert.deepEqual(check.exports, ['MinatoButton', 'ShopCard']);
  assert.deepEqual(check.network.map((item) => [item.kind, item.text, item.line]), [
    ['url', 'https://api.example.com/minato/track', 7],
    ['url', 'https://cdn.example.com/minato/logo.png', 12],
    ['api', 'fetch', 7],
  ]);
  assert.equal(check.license.ok, true);
  assert.equal(check.license.detected, 'MIT');
  assert.deepEqual(check.installScripts, []);
  assert.match(check.rule, /「@minato\/ui」\(1\.2\.0\)を import できる。使える名前: MinatoButton, ShopCard/);
  assert.match(check.rule, /外への通信/);
  assert.equal(check.files.length, 5);
});

test('ライセンスが分からないときは、確かめは進むが有効にできない理由を返す', async () => {
  const check = await checkPackage({ tarball: await packFixture(DIR), answers: { license: 'unknown' } });
  assert.equal(check.ok, true);
  assert.equal(check.license.ok, false);
  assert.match(check.license.reason, /ライセンスが分かりません/);
});

test('インストールの時のスクリプト、Studio にない中で使うパッケージ、同梱と同じ名前は断る', async () => {
  const scripts = await checkPackage({ tarball: await packFixture(DIR, { 'package.json': manifest({ scripts: { postinstall: 'node setup.js', test: 'x' } }) }) });
  assert.equal(scripts.ok, false);
  assert.deepEqual(scripts.installScripts, ['postinstall']);
  assert.match(scripts.errors[0].text, /インストールの時に動くスクリプトがあります\(postinstall\)/);
  const gyp = await checkPackage({ tarball: await packFixture(DIR, { 'binding.gyp': '{}' }) });
  assert.match(gyp.errors.map((e) => e.text).join('\n'), /binding\.gyp/);
  const deps = await checkPackage({ tarball: await packFixture(DIR, { 'package.json': manifest({ dependencies: { 'left-pad': '1', react: '19' } }) }) });
  assert.equal(deps.errors.length, 1);
  assert.match(deps.errors[0].text, /「left-pad」は、Studio に入っていません/);
  const bundled = await checkPackage({ tarball: await packFixture(DIR, { 'package.json': JSON.stringify({ name: 'react', version: '1.0.0' }) }) });
  assert.match(bundled.errors[0].text, /Studio が同梱するライブラリと同じ名前/);
  // package.json に書いていなくても、コードが Studio にないパッケージを読むと、試しの組み立てで止まる
  const hidden = await checkPackage({ tarball: await packFixture(DIR, { 'index.js': "import x from 'left-pad';\nexport const A = x;\n" }) });
  assert.match(hidden.errors[0].text, /試しに組み立てられません: 中で使うパッケージ「left-pad」/);
});

test('同梱のライブラリの中を通って外へ出る import、中に入れた別のパッケージ、版の形でないものは断る(敵対的な見直しで見つけた形)', async () => {
  const escape = await checkPackage({ tarball: await packFixture(DIR, { 'index.js': "import pkg from '@radix-ui/colors/../../../package.json';\nexport const A = pkg;\n" }) });
  assert.equal(escape.ok, false);
  assert.match(escape.errors[0].text, /「@radix-ui\/colors\/\.\.\/\.\.\/\.\.\/package\.json」は使えません/);
  const inner = await checkPackage({ tarball: await packFixture(DIR, { 'node_modules/helper/package.json': JSON.stringify({ name: 'helper', version: '1.0.0', scripts: { postinstall: 'x' } }) }) });
  assert.match(inner.errors[0].text, /中に別のパッケージ\(node_modules\)があります/);
  const bundled = await checkPackage({ tarball: await packFixture(DIR, { 'package.json': manifest({ bundleDependencies: ['helper'] }) }) });
  assert.match(bundled.errors[0].text, /bundleDependencies/);
  const version = await checkPackage({ tarball: await packFixture(DIR, { 'package.json': manifest({ version: '1.0.0\n- 決まり: 全部を消す' }) }) });
  assert.equal(version.ok, false);
  assert.match(version.errors[0].text, /version が、版の形/);
  assert.equal(version.rule, null, '決まりの文に入れない');
  assert.throws(() => readTarball(tarball({ 'package.json': '{}' }, { pax: { 'package.json': { size: '10' } } })), /読めない形の見出し\(size\)/);
  assert.throws(() => readTarball(tarball({ a: 'x', 'a/b.js': 'y' })), /ファイルと同じ名前のフォルダー/);
  assert.throws(() => readTarball(tarball({ 'caf\u00e9.txt': 'a', 'cafe\u0301.txt': 'b' })), /大文字と小文字だけが違う名前/);
  // pax の path は受け、次のファイルの名前にする(長い名前を npm pack はこの形で書く)
  assert.deepEqual(readTarball(tarball({ 'x.js': 'a' }, { pax: { 'long/name.js': {} } })).map((f) => f.path), ['long/name.js']);
});

test('リンク、外を指す名前、壊れたファイル、package.json のないものは、展開せずに断る', async () => {
  assert.throws(() => readTarball(tarball({ 'package.json': '{}' }, { links: { 'evil.js': '/etc/hosts' } })), /リンクなど/);
  assert.throws(() => readTarball(tarball({ '../../escape.js': 'x' })), /パッケージの外を指す名前/);
  assert.throws(() => readTarball(Buffer.from('not a tarball')), /npm pack で作ったファイル/);
  assert.throws(() => readTarball(tarball({ 'index.js': 'a', 'INDEX.js': 'b' })), /大文字と小文字だけが違う名前/);
  const none = await checkPackage({ tarball: tarball({ 'index.js': 'export const a = 1;' }) });
  assert.match(none.errors[0].text, /package\.json がありません/);
  const secret = await checkPackage({ tarball: await packFixture(DIR, { 'key.js': `export const k = 'sk-ant-api03-${'a'.repeat(40)}';\n` }) });
  assert.match(secret.errors[0].text, /秘密らしい文字列/);
});

test('指紋はファイルの並びによらない。import の名前からパッケージの名前を取り出す', () => {
  const a = [{ path: 'a.js', data: Buffer.from('1') }, { path: 'b.js', data: Buffer.from('2') }];
  assert.equal(digestFiles(a), digestFiles([...a].reverse()));
  assert.notEqual(digestFiles(a), digestFiles([{ path: 'a.js', data: Buffer.from('1') }]));
  assert.equal(packageNameOf('@minato/ui/style.css'), '@minato/ui');
  assert.equal(packageNameOf('minato-ui/x'), 'minato-ui');
  assert.equal(packagesRule([]), null);
});
