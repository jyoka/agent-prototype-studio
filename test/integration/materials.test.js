import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { snapshotApp } from '../../src/server/app-snapshot.js';
import { buildClaudeArgs, STUDIO_SYSTEM_PROMPT } from '../../src/server/claude-args.js';
import { evidenceState } from '../../src/server/evidence.js';
import { MaterialError, ProjectMaterials, readTokenMaterial } from '../../src/server/materials.js';
import { BusyError, ProjectStore } from '../../src/server/store.js';

const TOKENS = await fs.readFile(new URL('../fixtures/design-tokens/tokens.json', import.meta.url), 'utf8');
const FIXTURE_APP = new URL('../fixtures/design-tokens/app/', import.meta.url);

async function makeProject(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-materials-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const root = path.join(home, 'projects', 'shop');
  const app = path.join(root, 'app');
  await fs.cp(FIXTURE_APP, app, { recursive: true });
  const store = new ProjectStore(home);
  await store.build('shop');
  return { root, app, store, materials: new ProjectMaterials({ store }) };
}

const builtCss = async (store, root) => {
  const id = store.previewBuildId('shop');
  return fs.readFile(path.join(root, '.studio', 'builds', id, 'app.css'), 'utf8');
};

test('つなぐと .studio/materials/ にだけ書き、ビルドの app.css の最後に変数が入る。app/ は変わらない', async (t) => {
  const { root, app, store, materials } = await makeProject(t);
  const before = await snapshotApp(app);
  assert.doesNotMatch(await builtCss(store, root), /--token-color-accent:/);

  const result = await materials.connect('shop', { text: TOKENS, fileName: 'minato.tokens.json', source: '架空の会社のデザイン担当', reason: '架空の理由' });
  assert.equal(result.connected, true);
  assert.equal(result.build.ok, true);
  assert.deepEqual(await snapshotApp(app), before);

  const css = await builtCss(store, root);
  assert.match(css, /--token-color-accent: rgb\(0 128 64\);/);
  assert.ok(css.lastIndexOf('--token-color-accent:') > css.lastIndexOf('.rt-Button'), '部品の CSS より後に入る');
  assert.equal(result.materials.connected.source, '架空の会社のデザイン担当');
  assert.equal(result.materials.connected.reason, '架空の理由');
  assert.equal(result.materials.connected.roles.action, 'color.accent');
  assert.deepEqual(result.materials.connected.missingRoles, []);

  const source = JSON.parse(await fs.readFile(path.join(root, '.studio', 'materials', 'source.json'), 'utf8'));
  assert.equal(source.tokens.spec, 'W3C Design Tokens 2025.10');
  assert.deepEqual(source.history.map((entry) => entry.action), ['connect']);
  assert.equal(await fs.readFile(path.join(root, '.studio', 'materials', 'tokens.json'), 'utf8'), TOKENS);
});

test('形の誤りは書かずに返す。誰の素材かがなければ断る', async (t) => {
  const { root, materials } = await makeProject(t);
  const bad = await materials.connect('shop', { text: '{"a": {"$value": 1}}', source: '架空' });
  assert.equal(bad.connected, false);
  assert.match(bad.check.errors[0].text, /種類がありません/);
  await assert.rejects(materials.connect('shop', { text: TOKENS, source: '  ' }), (error) => error instanceof MaterialError && /誰の素材か/.test(error.message));
  await assert.rejects(fs.lstat(path.join(root, '.studio', 'materials', 'tokens.json')));
});

test('検査だけでは何も書かない', async (t) => {
  const { root, materials } = await makeProject(t);
  const { check } = await materials.check('shop', { text: TOKENS });
  assert.equal(check.ok, true);
  assert.ok(check.count > 0);
  await assert.rejects(fs.lstat(path.join(root, '.studio', 'materials')));
});

test('役割を選び直せる。「既定の素材のまま」は足りない役割として出る', async (t) => {
  const { store, root, materials } = await makeProject(t);
  const { materials: view } = await materials.connect('shop', {
    text: TOKENS,
    source: '架空',
    roles: { background: null, text: 'color.text', action: 'color.brand', danger: 'font.body', font: 'font.body' },
  });
  assert.equal(view.connected.roles.action, 'color.brand');
  assert.equal(view.connected.roles.danger, null, '種類の違うトークンは当てない');
  assert.deepEqual(view.connected.missingRoles, ['地', '失敗']);
  const css = await builtCss(store, root);
  const added = css.slice(css.lastIndexOf('自分のトークン'));
  assert.match(added, /--accent-9: var\(--token-color-brand\);/);
  assert.doesNotMatch(added, /--color-background: var\(/);
});

test('つなげない使い方が試作品にあれば、書かずに場所を返す', async (t) => {
  const { app, root, materials } = await makeProject(t);
  await fs.writeFile(path.join(app, 'other.css'), '.x { color: var(--token-color-removed); }\n');
  const result = await materials.connect('shop', { text: TOKENS, source: '架空' });
  assert.equal(result.connected, false);
  assert.match(result.conflicts[0], /app\/other\.css 1 行目: 変数 --token-color-removed は、つないだトークンにありません/);
  await assert.rejects(fs.lstat(path.join(root, '.studio', 'materials', 'tokens.json')));
});

test('作る AI が app/ で素材の変数を書き換えると、関門 G3(contract)で止まり、表示中の版は変わらない', async (t) => {
  const { app, store, materials } = await makeProject(t);
  await materials.connect('shop', { text: TOKENS, source: '架空' });
  const shown = store.previewBuildId('shop');
  await fs.writeFile(path.join(app, 'override.css'), ':root { --token-color-accent: rgb(255 0 0); }\n');
  const build = await store.build('shop');
  assert.equal(build.ok, false);
  assert.equal(build.stage, 'contract');
  assert.equal(build.errors[0].file, 'app/override.css');
  assert.equal(build.errors[0].line, 1);
  assert.match(build.errors[0].text, /--token-color-accent を書き換えています/);
  assert.equal(store.previewBuildId('shop'), shown);
});

test('Studio の持つ素材のファイルが外から変わると、関門 G3 で止まる', async (t) => {
  const { root, store, materials } = await makeProject(t);
  await materials.connect('shop', { text: TOKENS, source: '架空' });
  const file = path.join(root, '.studio', 'materials', 'tokens.json');
  await fs.writeFile(file, TOKENS.replace('"components": [0, 0.5, 0.25]', '"components": [1, 0, 0]'));
  const build = await store.build('shop');
  assert.equal(build.ok, false);
  assert.equal(build.stage, 'contract');
  assert.match(build.errors[0].text, /つないだときから変わっています/);
  assert.match((await materials.view('shop')).problems[0], /つないだときから変わっています/);
  assert.equal((await materials.view('shop')).connected, null);
  // 外すと戻る
  const removed = await materials.disconnect('shop');
  assert.equal(removed.build.ok, true);
  assert.deepEqual(removed.materials.problems, []);
});

test('Studio の持つ素材のファイルが消えても、つないでいないことにしない', async (t) => {
  const { root, store, materials } = await makeProject(t);
  await materials.connect('shop', { text: TOKENS, source: '架空' });
  await fs.rm(path.join(root, '.studio', 'materials', 'tokens.json'));
  const build = await store.build('shop');
  assert.equal(build.stage, 'contract');
  assert.match(build.errors[0].text, /なくなっています/);
  assert.equal(build.errors[0].locked, true);
});

test('作る AI の決まりに、つないだトークンの名前が入る。つないでいなければ今のまま', async (t) => {
  const { root, materials } = await makeProject(t);
  assert.equal(await readTokenMaterial(root), null);
  const args = (materialGuide) => {
    const list = buildClaudeArgs({ billing: { mode: 'login' }, mcpConfig: '/tmp/x.json', materialGuide });
    return list[list.indexOf('--append-system-prompt') + 1];
  };
  assert.equal(args(null), STUDIO_SYSTEM_PROMPT);
  await materials.connect('shop', { text: TOKENS, source: '架空' });
  const prompt = args((await readTokenMaterial(root)).guide);
  assert.ok(prompt.startsWith(STUDIO_SYSTEM_PROMPT));
  assert.match(prompt, /--token-color-accent/);
  assert.doesNotMatch(prompt.slice(STUDIO_SYSTEM_PROMPT.length), /rgb\(/, '値は渡さない');
  assert.doesNotMatch(prompt, /架空の会社/, 'トークンの説明の文は渡さない');
});

test('外すと変数が消えて、履歴に残る。今の確かめは素材を変える前のものなので古くなる', async (t) => {
  const { root, store, app, materials } = await makeProject(t);
  await materials.connect('shop', { text: TOKENS, source: '架空' });
  const digest = store.entry('shop').lastBuild.appDigest;
  const paths = await store.requireProject('shop');
  const item = { id: 'a', status: 'passed', appDigest: digest, finishedAt: new Date(Date.now() - 1000).toISOString() };
  assert.equal((await evidenceState(paths, [item])).runs[0].stale, true);
  const newer = { ...item, finishedAt: new Date(Date.now() + 60_000).toISOString() };
  assert.equal((await evidenceState(paths, [newer])).runs[0].stale, false);

  const removed = await materials.disconnect('shop', { reason: '架空の理由で外す' });
  assert.equal(removed.build.ok, true);
  assert.equal(removed.materials.connected, null);
  assert.deepEqual(removed.materials.history.map((entry) => entry.action), ['connect', 'disconnect']);
  assert.equal(removed.materials.history[1].reason, '架空の理由で外す');
  assert.doesNotMatch(await builtCss(store, root), /--token-color-accent:/);
  // 見本は var(--token-*) を 3 か所読んでいる。外すと値がなくなる所を数えて知らせる
  assert.equal(removed.references, 3);
  assert.ok(app);
});

test('作る AI の作業中はつなげない', async (t) => {
  const { store, materials } = await makeProject(t);
  store.claimRun('shop');
  await assert.rejects(materials.connect('shop', { text: TOKENS, source: '架空' }), BusyError);
  store.releaseRun('shop');
  const result = await materials.connect('shop', { text: TOKENS, source: '架空' });
  assert.equal(result.connected, true);
  assert.equal(store.entry('shop').versioning, false, '終わったら印を外す');
});
