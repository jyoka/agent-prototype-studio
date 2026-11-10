import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AiSessions } from '../../src/server/product-ai/session.js';
import { ProjectShows, SHOW_FILE, SHOW_VERSION_NAME } from '../../src/server/show.js';
import { ProjectStore } from '../../src/server/store.js';
import { ProjectVersions } from '../../src/server/versions.js';

// 人に見せる(user-journey.md の J7)。答えは見せた版に結び付けて残り、版を戻しても消えない。
// 題材は求人ではない架空の題材(図書室の本の取り置き)

async function makeHome(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-show-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const app = path.join(home, 'projects', 'shelf', 'app');
  await fs.mkdir(app, { recursive: true });
  await fs.writeFile(path.join(app, 'main.js'), "document.getElementById('root').textContent = '取り置きの一覧';\n");
  return { home, app };
}

async function boot(home, doc = null) {
  const store = new ProjectStore(home);
  await store.buildAll();
  const aiSessions = new AiSessions({ definitionOf: (id) => store.aiDefinition(id) });
  // 目的の文書(intent.js)のうち、見せる画面が読むのは viewOf だけ
  const intents = { viewOf: () => (doc ? { status: 'decided', doc } : { status: 'none' }) };
  let shows;
  const versions = new ProjectVersions({ store, aiSessions, answersOf: (id) => shows.answersByVersion(id) });
  shows = new ProjectShows({ home, store, versions, intents });
  return { store, versions, shows };
}

test('見せ始めると、今の状態を版に結び付ける。どの版とも違えば保存し、同じなら保存しない', async (t) => {
  const { home, app } = await makeHome(t);
  const studio = await boot(home, { success: '本を探す時間が半分になる' });

  const first = await studio.shows.start('shelf');
  assert.equal(first.savedNow, true);
  assert.equal(first.version.number, 1);
  assert.equal(first.version.name, SHOW_VERSION_NAME);
  assert.equal(first.source, 'success');
  assert.equal(first.questions[0], 'この試作品で「本を探す時間が半分になる」に近づきそうですか?');

  const again = await studio.shows.start('shelf');
  assert.equal(again.savedNow, false);
  assert.equal(again.version.id, first.version.id);
  assert.equal((await studio.versions.list('shelf')).versions.length, 1);

  await fs.writeFile(path.join(app, 'main.js'), "document.getElementById('root').textContent = '取り置きの一覧(新)';\n");
  const changed = await studio.shows.start('shelf');
  assert.equal(changed.savedNow, true);
  assert.equal(changed.version.number, 2);
});

test('答えは見せた版に残り、別の版に戻しても、起動し直しても消えない', async (t) => {
  const { home, app } = await makeHome(t);
  let studio = await boot(home, { success: '本を探す時間が半分になる' });
  const shown = await studio.shows.start('shelf');

  const { record } = await studio.shows.answer('shelf', {
    versionId: shown.version.id,
    viewer: ' 同僚\n',
    answers: [
      { question: shown.questions[0], answer: '近づきそう。棚の番号が見えるのが良い' },
      { question: shown.questions[1], answer: '' },
    ],
  });
  assert.equal(record.versionNumber, 1);
  assert.equal(record.viewer, '同僚');
  assert.deepEqual(record.answers, [{ question: shown.questions[0], answer: '近づきそう。棚の番号が見えるのが良い' }]);

  // 試作品を変えて保存し、見せた版の前後を行き来する
  await fs.writeFile(path.join(app, 'main.js'), "document.getElementById('root').textContent = '取り置きの一覧(新)';\n");
  const v2 = await studio.versions.save('shelf', { name: '直した版' });
  await studio.versions.restore('shelf', shown.version.id);
  await studio.versions.restore('shelf', v2.version.id);

  const listed = await studio.versions.list('shelf');
  const v1 = listed.versions.find((v) => v.id === shown.version.id);
  assert.equal(v1.shows.length, 1);
  assert.equal(v1.shows[0].answers[0].answer, '近づきそう。棚の番号が見えるのが良い');
  assert.deepEqual(listed.versions.find((v) => v.id === v2.version.id).shows, []);
  // 答えは版の写しの外(.studio/show.json)にある
  const file = path.join(home, 'projects', 'shelf', '.studio', SHOW_FILE);
  assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).records.length, 1);

  studio = await boot(home);
  assert.equal((await studio.versions.list('shelf')).versions.find((v) => v.id === shown.version.id).shows.length, 1);
});

test('答えが 1 つもない、版が分からない、版がないときは残さない', async (t) => {
  const { home } = await makeHome(t);
  const studio = await boot(home);
  const shown = await studio.shows.start('shelf');
  assert.equal(shown.source, 'fallback');

  await assert.rejects(studio.shows.answer('shelf', { versionId: shown.version.id, answers: [{ question: 'q', answer: '  ' }] }), { code: 'empty' });
  await assert.rejects(studio.shows.answer('shelf', { answers: [{ question: 'q', answer: 'a' }] }), { code: 'invalid' });
  await assert.rejects(studio.shows.answer('shelf', { versionId: shown.version.id, answers: 'a' }), { code: 'invalid' });
  await assert.rejects(studio.shows.answer('shelf', { versionId: '0123456789abcdef', answers: [{ question: 'q', answer: 'a' }] }), { code: 'not-found' });
  assert.deepEqual(await studio.shows.records('shelf'), []);
});

test('読めない答えのファイルは上書きしない', async (t) => {
  const { home } = await makeHome(t);
  const studio = await boot(home);
  const shown = await studio.shows.start('shelf');
  const file = path.join(home, 'projects', 'shelf', '.studio', SHOW_FILE);
  await fs.writeFile(file, '{ 壊れている');
  await assert.rejects(studio.shows.answer('shelf', { versionId: shown.version.id, answers: [{ question: 'q', answer: 'a' }] }), { code: 'broken' });
  assert.equal(await fs.readFile(file, 'utf8'), '{ 壊れている');
});

test('今の状態が自動の版と同じときは、自分で保存した版を作って結び付ける(自動の版は古いものから消えるため)', async (t) => {
  const { home, app } = await makeHome(t);
  const studio = await boot(home);
  const v1 = await studio.versions.save('shelf', { name: '最初' });
  await fs.writeFile(path.join(app, 'main.js'), "document.getElementById('root').textContent = '取り置きの一覧(新)';\n");
  // 戻すと、戻す前の状態が自動の版になる。その自動の版に戻すと、今の状態は自動の版と同じ
  const restored = await studio.versions.restore('shelf', v1.version.id);
  await studio.versions.restore('shelf', restored.autoSaved.id);
  const shown = await studio.shows.start('shelf');
  assert.equal(shown.savedNow, true);
  assert.notEqual(shown.version.id, restored.autoSaved.id);
  const listed = await studio.versions.list('shelf');
  assert.equal(listed.versions.find((v) => v.id === shown.version.id).kind, 'manual');
});

test('今の状態が表示できない自動の版と同じときは、見せない(画面には前の状態が出ているため)', async (t) => {
  const { home, app } = await makeHome(t);
  const studio = await boot(home);
  const v1 = await studio.versions.save('shelf', { name: '最初' });
  await fs.writeFile(path.join(app, 'main.js'), 'document.getElementById(\n');
  const restored = await studio.versions.restore('shelf', v1.version.id);
  assert.equal(restored.autoSaved.builds, false);
  await studio.versions.restore('shelf', restored.autoSaved.id);
  await assert.rejects(studio.shows.start('shelf'), { code: 'build' });
});

test('形の違う記録が混ざった答えのファイルは上書きしない。読める記録は出す', async (t) => {
  const { home } = await makeHome(t);
  const studio = await boot(home);
  const shown = await studio.shows.start('shelf');
  await studio.shows.answer('shelf', { versionId: shown.version.id, answers: [{ question: 'q', answer: 'a' }] });
  const file = path.join(home, 'projects', 'shelf', '.studio', SHOW_FILE);
  const data = JSON.parse(await fs.readFile(file, 'utf8'));
  data.records.push({ id: 1 });
  await fs.writeFile(file, JSON.stringify(data));
  assert.equal((await studio.shows.records('shelf')).length, 1);
  await assert.rejects(studio.shows.answer('shelf', { versionId: shown.version.id, answers: [{ question: 'q', answer: 'b' }] }), { code: 'broken' });
  assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).records.length, 2);
});

test('表示できない状態は、見せる前に保存できないので、見せられない', async (t) => {
  const { home, app } = await makeHome(t);
  const studio = await boot(home);
  await fs.writeFile(path.join(app, 'main.js'), 'document.getElementById(\n');
  await assert.rejects(studio.shows.start('shelf'), { code: 'build' });
});
