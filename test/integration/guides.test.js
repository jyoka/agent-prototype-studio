import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildApp } from '../../src/server/build.js';
import { LIMITS } from '../../src/server/inspect.js';
import { createStarterProject } from '../../src/server/intent.js';
import { MaterialError, ProjectMaterials, applyStudioMaterials, materialRule } from '../../src/server/materials.js';
import { AiSessions } from '../../src/server/product-ai/session.js';
import { ProjectStore } from '../../src/server/store.js';
import { ProjectVersions } from '../../src/server/versions.js';

// 部品と指針をつなぐ(docs/design/user-journey.md の J5)。置き場所、写し、関門 G3、これからの試作品全部。素材はどれも架空
const FIXTURE = new URL('../fixtures/design-guides/', import.meta.url);
const read = (name) => fs.readFile(new URL(name, FIXTURE), 'utf8');
const GUIDES = [
  { path: 'voice.md', text: await read('guides/voice.md') },
  { path: 'look.md', text: await read('guides/look.md') },
];
const STORYBOOK = [
  { path: 'storybook-static/index.json', text: await read('storybook-static/index.json') },
  { path: 'storybook-static/manifests/components.json', text: await read('storybook-static/manifests/components.json') },
];
const MIT = { license: 'listed', licenseName: 'MIT' };

async function makeProject(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-guides-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const root = path.join(home, 'projects', 'shop');
  const app = path.join(root, 'app');
  await fs.cp(new URL('app/', FIXTURE), app, { recursive: true });
  const store = new ProjectStore(home);
  await store.build('shop');
  return { home, root, app, store, materials: new ProjectMaterials({ store }) };
}

const gate = (root, app) => buildApp({ appDir: app, buildsDir: path.join(root, '.studio', 'builds'), projectRoot: root });

test('有効にすると、元を .studio/materials/ に、写しを app/design/ に置き、作る AI への決まりに場所が入る', async (t) => {
  const { root, app, materials } = await makeProject(t);
  const result = await materials.enableGuides('shop', { kind: 'guides', files: GUIDES, answers: MIT, source: '架空のデザイン担当', reason: '架空の理由' });
  assert.equal(result.enabled, true);
  assert.equal(result.build.ok, true);
  assert.equal(await fs.readFile(path.join(app, 'design', 'guides', 'voice.md'), 'utf8'), GUIDES[0].text);
  assert.equal(await fs.readFile(path.join(root, '.studio', 'materials', 'guides', 'look.md'), 'utf8'), GUIDES[1].text);
  const view = result.materials.guides.kinds.guides;
  assert.equal(view.source, '架空のデザイン担当');
  assert.equal(view.licenseLabel, '公開のライセンス(MIT)');
  assert.equal(view.scope, 'project');
  assert.equal(view.urlCount, 1);
  assert.deepEqual(view.files.map((file) => file.copy), ['design/guides/voice.md', 'design/guides/look.md']);
  const rule = await materialRule(root);
  assert.match(rule, /design\/guides\/voice\.md/);
  assert.doesNotMatch(rule, /文の決まり/, '中身は決まりの文に入れない');
  const source = JSON.parse(await fs.readFile(path.join(root, '.studio', 'materials', 'source.json'), 'utf8'));
  assert.deepEqual(source.history.map((entry) => [entry.kind, entry.action]), [['guides', 'enable']]);
  assert.equal(source.tokens, undefined, 'トークンの記録は作らない');
});

test('ライセンスが分からないと有効にできない。誰の素材かがなければ断る。何も書かない', async (t) => {
  const { root, app, materials } = await makeProject(t);
  await assert.rejects(
    materials.enableGuides('shop', { kind: 'storybook', files: STORYBOOK, answers: { license: 'unknown' }, source: '架空' }),
    (error) => error instanceof MaterialError && error.status === 409 && /ライセンスが分かりません/.test(error.message),
  );
  await assert.rejects(materials.enableGuides('shop', { kind: 'storybook', files: STORYBOOK, answers: MIT, source: ' ' }), /誰の素材か/);
  await assert.rejects(fs.lstat(path.join(app, 'design')));
  await assert.rejects(fs.lstat(path.join(root, '.studio', 'materials')));
  const bad = await materials.enableGuides('shop', { kind: 'storybook', files: GUIDES, answers: MIT, source: '架空' });
  assert.equal(bad.enabled, false);
  assert.match(bad.check.errors[0].text, /index\.json/);
});

test('作る AI が写しを変えると関門 G3 で止まり、作る AI には直せない印が付く。写しを戻すと通る', async (t) => {
  const { root, app, materials } = await makeProject(t);
  await materials.enableGuides('shop', { kind: 'storybook', files: STORYBOOK, answers: { license: 'internal' }, source: '架空' });
  const copy = path.join(app, 'design', 'components.md');
  assert.match(await fs.readFile(copy, 'utf8'), /## ShopCard/);
  await fs.appendFile(copy, '\n- 書き足した行\n');
  const failed = await gate(root, app);
  assert.equal(failed.ok, false);
  assert.equal(failed.stage, 'contract');
  assert.equal(failed.errors[0].file, 'app/design/components.md');
  assert.equal(failed.errors[0].locked, true);
  assert.equal(failed.errors[0].material, true);
  assert.match(failed.errors[0].text, /写しを戻す/);
  const view = await materials.view('shop');
  assert.equal(view.guides.problems.length, 1);

  const restored = await materials.restoreGuides('shop');
  assert.equal(restored.restored, 1);
  assert.equal(restored.build.ok, true);
  assert.deepEqual(restored.materials.guides.problems, []);

  // 消したときも同じ
  await fs.rm(copy);
  assert.match((await gate(root, app)).errors[0].text, /なくなっています/);
  await materials.restoreGuides('shop');
  // 元が変わったら戻せない。外して有効にし直す
  await fs.appendFile(path.join(root, '.studio', 'materials', 'storybook', 'components.md'), 'x');
  assert.match((await gate(root, app)).errors[0].text, /元のファイル/);
  await assert.rejects(materials.restoreGuides('shop'), /写しを戻せません/);
  const removed = await materials.disableGuides('shop', { kind: 'storybook' });
  assert.equal(removed.build.ok, true);
  await assert.rejects(fs.lstat(copy));
  assert.equal(removed.materials.guides.kinds.storybook, null);
});

test('写しの場所が app/ の外へのリンクでも、たどらずに置き換える。人が置いたファイルは上書きしない', async (t) => {
  const { home, app, materials } = await makeProject(t);
  const outside = path.join(home, 'outside');
  await fs.mkdir(outside);
  await fs.mkdir(path.join(app, 'design'));
  await fs.writeFile(path.join(app, 'design', 'components.md'), '人が置いたファイル\n');
  await assert.rejects(
    materials.enableGuides('shop', { kind: 'storybook', files: STORYBOOK, answers: MIT, source: '架空' }),
    (error) => error.code === 'clash' && /design\/components\.md/.test(error.message),
  );
  assert.equal(await fs.readFile(path.join(app, 'design', 'components.md'), 'utf8'), '人が置いたファイル\n');
  await fs.rm(path.join(app, 'design'), { recursive: true });
  await materials.enableGuides('shop', { kind: 'guides', files: GUIDES, answers: MIT, source: '架空' });
  // 作る AI が写しのフォルダーを外へのリンクにすり替えた
  await fs.rm(path.join(app, 'design', 'guides'), { recursive: true });
  await fs.symlink(outside, path.join(app, 'design', 'guides'));
  await materials.restoreGuides('shop');
  assert.deepEqual(await fs.readdir(outside), [], 'app/ の外に書かない');
  assert.equal((await fs.lstat(path.join(app, 'design', 'guides'))).isDirectory(), true);
  assert.equal(await fs.readFile(path.join(app, 'design', 'guides', 'voice.md'), 'utf8'), GUIDES[0].text);
});

test('これからの試作品全部に有効にすると、新しい試作品に写す。外すと、これからの試作品には入れない', async (t) => {
  const { home, materials } = await makeProject(t);
  await materials.enableGuides('shop', { kind: 'guides', files: GUIDES, answers: MIT, source: '架空のデザイン担当', scope: 'all' });
  const view = await materials.view('shop');
  assert.equal(view.guides.studioWide.guides.source, '架空のデザイン担当');

  const id = await createStarterProject(home, '架空のお店の案内を作りたい');
  const root = path.join(home, 'projects', id);
  assert.equal(await fs.readFile(path.join(root, 'app', 'design', 'guides', 'voice.md'), 'utf8'), GUIDES[0].text);
  const store = new ProjectStore(home);
  const built = await store.build(id);
  assert.equal(built.ok, true, '写しは関門を通る');
  const other = await new ProjectMaterials({ store }).view(id);
  assert.equal(other.guides.kinds.guides.from, 'studio');
  assert.match(await materialRule(root), /design\/guides\/look\.md/);

  await materials.disableGuides('shop', { kind: 'guides', from: 'studio' });
  assert.equal((await materials.view('shop')).guides.studioWide.guides, null);
  assert.ok((await materials.view('shop')).guides.kinds.guides, '今の試作品はそのまま');
  const next = await createStarterProject(home, '架空の別の案内');
  assert.equal(await applyStudioMaterials(home, path.join(home, 'projects', next)), 0);
  await assert.rejects(fs.lstat(path.join(home, 'projects', next, 'app', 'design')));
});

test('トークンをつないでも外しても、部品と指針の記録は残る', async (t) => {
  const { root, materials } = await makeProject(t);
  await materials.enableGuides('shop', { kind: 'guides', files: GUIDES, answers: MIT, source: '架空' });
  const tokens = await fs.readFile(new URL('../fixtures/design-tokens/tokens.json', import.meta.url), 'utf8');
  const connected = await materials.connect('shop', { text: tokens, source: '架空' });
  assert.equal(connected.connected, true);
  await materials.disconnect('shop', {});
  const source = JSON.parse(await fs.readFile(path.join(root, '.studio', 'materials', 'source.json'), 'utf8'));
  assert.equal(source.guides.files.length, 2);
  assert.deepEqual(source.history.map((entry) => `${entry.kind}:${entry.action}`), ['guides:enable', 'tokens:connect', 'tokens:disconnect']);
});

test('写しのない版に戻しても、素材は戻らない。今の写しを書き直して、関門を通る', async (t) => {
  const { app, store, materials } = await makeProject(t);
  const versions = new ProjectVersions({ store, aiSessions: new AiSessions({ definitionOf: (id) => store.aiDefinition(id) }) });
  const before = await versions.save('shop', { name: '素材の前' });
  await materials.enableGuides('shop', { kind: 'guides', files: GUIDES, answers: MIT, source: '架空' });
  const restored = await versions.restore('shop', before.version.id);
  assert.equal(restored.build.ok, true);
  assert.equal(await fs.readFile(path.join(app, 'design', 'guides', 'voice.md'), 'utf8'), GUIDES[0].text);
  assert.ok((await materials.view('shop')).guides.kinds.guides);
});

test('外した写しが版から戻ってきたら消す。人が置いた design/ のファイルは消さずに断る', async (t) => {
  const { app, store, materials } = await makeProject(t);
  const versions = new ProjectVersions({ store, aiSessions: new AiSessions({ definitionOf: (id) => store.aiDefinition(id) }) });
  await materials.enableGuides('shop', { kind: 'guides', files: GUIDES, answers: MIT, source: '架空' });
  const withCopies = await versions.save('shop', { name: '素材あり' });
  await materials.disableGuides('shop', { kind: 'guides' });
  await versions.restore('shop', withCopies.version.id);
  await assert.rejects(fs.lstat(path.join(app, 'design', 'guides', 'voice.md')), '外した素材の写しを残さない');
  assert.equal((await materials.view('shop')).guides.kinds.guides, null);

  // design がファイルなら、消さずに断る
  await fs.rm(path.join(app, 'design'), { recursive: true, force: true });
  await fs.writeFile(path.join(app, 'design'), '人が置いたファイル\n');
  await assert.rejects(
    materials.enableGuides('shop', { kind: 'guides', files: GUIDES, answers: MIT, source: '架空' }),
    (error) => error.code === 'clash' && /: design。/.test(error.message),
  );
  assert.equal(await fs.readFile(path.join(app, 'design'), 'utf8'), '人が置いたファイル\n');
});

test('写しを足すと試作品のフォルダーの上限を超えるなら、書く前に断る', async (t) => {
  const { app, materials } = await makeProject(t);
  // 上限まで 100 バイトを残して埋める。指針の文の写し(数百バイト)を足すと超える
  const used = (await fs.readdir(app)).length > 0 ? await Promise.all((await fs.readdir(app)).map(async (name) => (await fs.lstat(path.join(app, name))).size)).then((sizes) => sizes.reduce((a, b) => a + b, 0)) : 0;
  let left = LIMITS.maxTotalBytes - used - 100;
  for (let i = 0; left > 0; i += 1) {
    const size = Math.min(left, LIMITS.maxFileBytes);
    await fs.writeFile(path.join(app, `big-${i}.txt`), 'x'.repeat(size));
    left -= size;
  }
  assert.equal((await new ProjectStore(path.dirname(path.dirname(path.dirname(app)))).build('shop')).ok, true, '埋めた後もビルドできる');
  await assert.rejects(
    materials.enableGuides('shop', { kind: 'guides', files: GUIDES, answers: MIT, source: '架空' }),
    (error) => error.code === 'too-large' && /上限/.test(error.message),
  );
  await assert.rejects(fs.lstat(path.join(app, 'design')));
});
