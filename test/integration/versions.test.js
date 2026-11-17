import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AiSessions } from '../../src/server/product-ai/session.js';
import { ProjectStore } from '../../src/server/store.js';
import { ProjectVersions, recoverInterrupted } from '../../src/server/versions.js';

// 求人ではない題材。版の仕組みが題材に依存しないことを確かめる
const TRAVEL_AI = {
  name: '旅の相談(架空)',
  fields: [
    { key: 'place', label: '行き先', options: [{ value: '湖の町', keywords: ['湖'] }, { value: '山の村', keywords: ['山'] }] },
    { key: 'nights', label: '泊数', type: 'number', unit: '泊', min: 1, max: 14 },
  ],
  mock: { greeting: '旅の相談です。' },
};

async function makeHome(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-versions-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const app = path.join(home, 'projects', 'travel', 'app');
  await fs.mkdir(app, { recursive: true });
  await fs.writeFile(path.join(app, 'main.js'), "document.getElementById('root').textContent = '一つ目';\n");
  await fs.writeFile(path.join(app, 'ai.json'), JSON.stringify(TRAVEL_AI));
  return { home, app };
}

// Studio の起動と同じ組み立て。起動し直すときは、これをもう一度呼ぶ
async function boot(home, options = {}) {
  await recoverInterrupted(home);
  const store = new ProjectStore(home);
  await store.buildAll();
  const aiSessions = new AiSessions({ definitionOf: (id) => store.aiDefinition(id) });
  return { store, aiSessions, versions: new ProjectVersions({ store, aiSessions, ...options }) };
}

const studioDir = (home) => path.join(home, 'projects', 'travel', '.studio');

test('保存した版に、ファイルと会話と状態を戻せる。Studio を起動し直しても版は残る', async (t) => {
  const { home, app } = await makeHome(t);
  let studio = await boot(home);

  let listed = await studio.versions.list('travel');
  assert.deepEqual(listed.versions, []);
  assert.equal(listed.working.files, 'none');
  assert.equal(listed.working.conversation, 'initial');

  await studio.aiSessions.send('travel', '湖に行きたい');
  studio.aiSessions.correct('travel', { nights: 3 });
  const saved = await studio.versions.save('travel', { name: ' 良い版\n一つ目 ' });
  assert.equal(saved.version.number, 1);
  assert.equal(saved.version.name, '良い版 一つ目');
  assert.equal(saved.version.kind, 'manual');
  assert.deepEqual(saved.version.ai, { messages: 4, userMessages: 1 });
  assert.deepEqual(saved.working, { files: 'saved', versionId: saved.version.id, conversation: 'saved', baseVersionId: saved.version.id });

  // 作業中を変える(ファイルと会話)
  await fs.writeFile(path.join(app, 'main.js'), "document.getElementById('root').textContent = '二つ目';\n");
  await studio.store.build('travel');
  await studio.aiSessions.send('travel', 'やっぱり山');
  listed = await studio.versions.list('travel');
  assert.equal(listed.working.files, 'changed');
  assert.equal(listed.working.baseVersionId, saved.version.id);

  // 復元すると、先に今の作業中を自動で保存してから、版のファイルと会話に戻す
  const restored = await studio.versions.restore('travel', saved.version.id);
  assert.equal(restored.restored.id, saved.version.id);
  assert.equal(restored.autoSaved.number, 2);
  assert.equal(restored.autoSaved.kind, 'auto');
  assert.equal(restored.conversation, 'restored');
  assert.equal(restored.build.ok, true);
  assert.match(await fs.readFile(path.join(app, 'main.js'), 'utf8'), /一つ目/);
  const view = studio.aiSessions.view('travel');
  assert.deepEqual(view.state, { place: '湖の町', nights: 3 });
  assert.deepEqual(view.messages.map((m) => m.role), ['assistant', 'user', 'assistant', 'correction']);
  assert.deepEqual(restored.working, { files: 'saved', versionId: saved.version.id, conversation: 'saved', baseVersionId: saved.version.id });
  assert.deepEqual(restored.versions.map((v) => v.number), [2, 1]);
  // 戻す前の状態の版(画面の「戻す前に戻る」。ui-ux-v2.md の 5.4 の「元に戻した」)は、自動で保存した版
  assert.equal(restored.before.id, restored.autoSaved.id);
  // 戻す前に戻ると、戻す前は保存 1 と同じなので自動の保存はせず、戻す前の版は保存 1
  const undone = await studio.versions.restore('travel', restored.before.id);
  assert.equal(undone.autoSaved, null);
  assert.equal(undone.before.id, saved.version.id);
  assert.match(await fs.readFile(path.join(app, 'main.js'), 'utf8'), /二つ目/);
  // 今と同じ版に戻すときは、戻す前の版はない
  const same = await studio.versions.restore('travel', restored.before.id);
  assert.equal(same.before, null);
  // 続きの確かめのため、保存 1 に戻しておく
  await studio.versions.restore('travel', saved.version.id);

  // 戻した会話から続けると、保存したときと同じ応答になる(修正を踏まえる)
  const next = await studio.aiSessions.send('travel', 'よろしく');
  assert.equal(next.messages.at(-1).text, '直していただいた泊数「3泊」で進めます。今の条件は行き先「湖の町」、泊数「3泊」です。');

  // 起動し直す。作業中の会話はメモリーにあったので最初に戻るが、版はディスクに残る
  studio = await boot(home);
  listed = await studio.versions.list('travel');
  assert.deepEqual(listed.versions.map((v) => v.number), [2, 1]);
  assert.deepEqual(listed.working, { files: 'saved', versionId: saved.version.id, conversation: 'initial', baseVersionId: saved.version.id });

  // 会話が最初のままなら、復元の前に自動で保存しない(失うものがない)
  const resumed = await studio.versions.restore('travel', saved.version.id);
  assert.equal(resumed.autoSaved, null);
  assert.deepEqual(studio.aiSessions.view('travel').state, { place: '湖の町', nights: 3 });

  // 自動で保存した版にも戻れる。そのときの会話も戻る
  const back = await studio.versions.restore('travel', restored.autoSaved.id);
  assert.equal(back.autoSaved, null);
  assert.match(await fs.readFile(path.join(app, 'main.js'), 'utf8'), /二つ目/);
  assert.deepEqual(studio.aiSessions.view('travel').state, { place: '山の村', nights: 3 });
});

test('ビルドできない状態は保存しない。復元の前の自動保存では残し、戻すとビルドの失敗が出る', async (t) => {
  const { home, app } = await makeHome(t);
  const studio = await boot(home);
  const first = await studio.versions.save('travel');
  assert.equal(first.version.name, '');
  assert.equal(first.version.ai, null);

  // ビルドに失敗しても、試す画面は前のビルドのまま。会話は続けられる
  await fs.writeFile(path.join(app, 'main.js'), 'const = ;\n');
  assert.equal((await studio.store.build('travel')).ok, false);
  await studio.aiSessions.send('travel', '山に行きたい');
  await assert.rejects(studio.versions.save('travel'), (error) => error.code === 'build' && /表示できない状態は保存できません/.test(error.message));
  assert.equal((await studio.versions.list('travel')).versions.length, 1);
  // 書きかけのフォルダーを残さない
  assert.deepEqual((await fs.readdir(path.join(studioDir(home), 'versions'))).length, 1);

  const restored = await studio.versions.restore('travel', first.version.id);
  assert.equal(restored.autoSaved.builds, false);
  assert.deepEqual(restored.autoSaved.ai, { messages: 3, userMessages: 1 });
  assert.match(await fs.readFile(path.join(app, 'main.js'), 'utf8'), /一つ目/);
  assert.deepEqual(studio.aiSessions.view('travel').state, { place: null, nights: null });

  // ビルドできない自動の版に戻すと、ファイルはその版に、会話もその版に戻る。試す画面は前のビルドのまま
  const broken = await studio.versions.restore('travel', restored.autoSaved.id);
  assert.equal(broken.build.ok, false);
  assert.equal(broken.conversation, 'restored');
  assert.match(await fs.readFile(path.join(app, 'main.js'), 'utf8'), /const = ;/);
  assert.deepEqual(studio.aiSessions.view('travel').state, { place: '山の村', nights: null });
});

test('シンボリックリンクのある作業中は保存しない。版にできないほど大きい作業中は、消さずに脇へ置いてから戻す', async (t) => {
  const { home, app } = await makeHome(t);
  const studio = await boot(home);
  const first = await studio.versions.save('travel');

  await fs.symlink(path.join(home, 'outside.txt'), path.join(app, 'link.txt'));
  await assert.rejects(studio.versions.save('travel'), (error) => error.code === 'build' && /シンボリックリンク/.test(error.message));
  await fs.rm(path.join(app, 'link.txt'));

  for (let i = 0; i < 501; i += 1) await fs.writeFile(path.join(app, `f${i}.txt`), 'x');
  const restored = await studio.versions.restore('travel', first.version.id);
  assert.equal(restored.autoSaved, null);
  assert.ok(restored.setAside.startsWith(path.join(studioDir(home), 'set-aside')));
  assert.equal((await fs.readdir(path.join(restored.setAside, 'app'))).length, 503);
  assert.deepEqual((await fs.readdir(app)).sort(), ['ai.json', 'main.js']);
  assert.equal(restored.working.files, 'saved');
});

test('利用者の版は上限で止め、自動の版は古いものから消す。消した版の番号は使い回さない', async (t) => {
  const { home, app } = await makeHome(t);
  const studio = await boot(home, { maxVersions: 2, maxAutoVersions: 1 });
  const v1 = await studio.versions.save('travel');
  const change = (text) => fs.writeFile(path.join(app, 'main.js'), `document.getElementById('root').textContent = '${text}';\n`);

  await change('a');
  const r1 = await studio.versions.restore('travel', v1.version.id);
  await change('b');
  const r2 = await studio.versions.restore('travel', v1.version.id);
  // 自動の版は新しい 1 個だけ残る。上限があっても、復元は止まらない
  assert.deepEqual(r2.versions.map((v) => [v.number, v.kind]), [[3, 'auto'], [1, 'manual']]);
  assert.equal(r1.autoSaved.number, 2);

  const v4 = await studio.versions.save('travel');
  assert.equal(v4.version.number, 4);
  await assert.rejects(studio.versions.save('travel'), (error) => error.code === 'too-many');

  // いちばん新しい版のフォルダーを手で消しても、次の番号は進む
  await fs.rm(path.join(studioDir(home), 'versions', v4.version.id), { recursive: true });
  assert.equal((await studio.versions.save('travel')).version.number, 5);
});

test('自動の版が上限まであるとき、いちばん古い自動の版を復元しても、その版は消えない', async (t) => {
  const { home, app } = await makeHome(t);
  const studio = await boot(home, { maxAutoVersions: 1 });
  const v1 = await studio.versions.save('travel');
  const change = (text) => fs.writeFile(path.join(app, 'main.js'), `document.getElementById('root').textContent = '${text}';\n`);

  await change('二つ目');
  const r1 = await studio.versions.restore('travel', v1.version.id);
  const v2 = r1.autoSaved;
  assert.equal(v2.number, 2);

  // 作業中を変えてから、上限いっぱいの自動の版(v2)を復元する。復元の前に v3 が自動で保存される
  await change('三つ目');
  const r2 = await studio.versions.restore('travel', v2.id);
  assert.equal(r2.restored.id, v2.id);
  assert.equal(r2.autoSaved.number, 3);
  assert.match(await fs.readFile(path.join(app, 'main.js'), 'utf8'), /二つ目/);
  assert.deepEqual(r2.versions.map((v) => [v.number, v.kind]), [[3, 'auto'], [2, 'auto'], [1, 'manual']]);
  assert.equal(r2.working.versionId, v2.id);

  // 次の自動の保存では、上限を超えた古い自動の版が消える
  await change('四つ目');
  const r3 = await studio.versions.restore('travel', v1.version.id);
  assert.deepEqual(r3.versions.map((v) => [v.number, v.kind]), [[4, 'auto'], [1, 'manual']]);
});

test('復元の途中で止まった跡は、次の起動で戻すか脇へ置く', async (t) => {
  const { home, app } = await makeHome(t);
  await fs.mkdir(studioDir(home), { recursive: true });
  // app/ を脇へ移した直後に止まった
  await fs.rename(app, path.join(studioDir(home), 'replaced-0000aaaa'));
  await fs.mkdir(path.join(studioDir(home), 'restoring-0000aaaa'));
  await fs.mkdir(path.join(studioDir(home), 'versions', '0123456789abcdef.tmp'), { recursive: true });
  let studio = await boot(home);
  assert.match(await fs.readFile(path.join(app, 'main.js'), 'utf8'), /一つ目/);
  assert.deepEqual((await fs.readdir(studioDir(home))).sort(), ['builds', 'versions']);
  assert.deepEqual(await fs.readdir(path.join(studioDir(home), 'versions')), []);
  assert.equal((await studio.store.list()).length, 1);

  // 新しい app/ を入れた後、前の app/ を片付ける前に止まった。前の app/ は消さない
  await fs.mkdir(path.join(studioDir(home), 'replaced-0000bbbb'));
  await fs.writeFile(path.join(studioDir(home), 'replaced-0000bbbb', 'main.js'), '前の作業中');
  studio = await boot(home);
  const kept = path.join(studioDir(home), 'set-aside', 'recovered-replaced-0000bbbb', 'app', 'main.js');
  assert.equal(await fs.readFile(kept, 'utf8'), '前の作業中');
  assert.match(await fs.readFile(path.join(app, 'main.js'), 'utf8'), /一つ目/);
});

test('版の操作は、作る AI の実行やビルドと重ならない。知らない版と壊れた版は扱わない', async (t) => {
  const { home } = await makeHome(t);
  const studio = await boot(home);
  studio.store.claimRun('travel');
  await assert.rejects(studio.versions.save('travel'), /作る AI が作業中/);
  studio.store.releaseRun('travel');

  studio.store.claimVersions('travel');
  await assert.rejects(studio.store.build('travel'), /保存か、保存した状態に戻すか、本番開発へ渡すフォルダーを作っているところ/);
  assert.throws(() => studio.store.claimRun('travel'), /保存か、保存した状態に戻すか、本番開発へ渡すフォルダーを作っているところ/);
  studio.store.releaseVersions('travel');

  await assert.rejects(studio.versions.restore('travel', '../../etc'), (error) => error.code === 'not-found');
  await assert.rejects(studio.versions.restore('travel', '0123456789abcdef'), (error) => error.code === 'not-found');
  await assert.rejects(studio.versions.save('travel', { name: 'x'.repeat(61) }), (error) => error.code === 'invalid');

  // 手で壊された version.json は一覧に出さない
  const { version } = await studio.versions.save('travel');
  const record = path.join(home, 'projects', 'travel', '.studio', 'versions', version.id, 'version.json');
  await fs.writeFile(record, '{');
  assert.deepEqual((await studio.versions.list('travel')).versions, []);

  // 手で直された会話が設定の決まりに合わなければ、復元では初期状態から始める
  await studio.aiSessions.send('travel', '湖に行きたい');
  const good = await studio.versions.save('travel');
  const goodRecord = path.join(home, 'projects', 'travel', '.studio', 'versions', good.version.id, 'version.json');
  const data = JSON.parse(await fs.readFile(goodRecord, 'utf8'));
  data.ai.state.nights = 99;
  await fs.writeFile(goodRecord, JSON.stringify(data));
  const restored = await studio.versions.restore('travel', good.version.id);
  assert.equal(restored.conversation, 'initial');
  assert.deepEqual(studio.aiSessions.view('travel').state, { place: null, nights: null });

  // AI が応答を待っている間は、戻さない(自動の版に、その発言を入れそこねないため)
  let release;
  const mock = studio.aiSessions.connections.get('mock');
  studio.aiSessions.connections.set('mock', { ...mock, respond: () => new Promise((resolve) => (release = resolve)) });
  const pending = studio.aiSessions.send('travel', '湖');
  await assert.rejects(studio.versions.restore('travel', good.version.id), /AI が返事をしているところ/);
  release({ reply: 'はい', updates: {} });
  await pending;
});
