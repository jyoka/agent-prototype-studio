import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadConfig, STUDIO_ROOT } from '../../src/server/config.js';
import { DEPTHS, FIXED_QUESTIONS } from '../../src/server/intent.js';
import { startStudio } from '../../src/server/index.js';

// 目的の聞き出し(src/server/intent.js、docs/design/user-journey.md の J1)。実モデルは呼ばない。
// 偽の claude(test/fixtures/fake-claude.js)は、残りの問いの数によらず、いつも次の問いを返す
const posixOnly = { skip: process.platform === 'win32' ? '偽の claude を直接起動するため' : false };
const FAKE = path.join(STUDIO_ROOT, 'test', 'fixtures', 'fake-claude.js');

async function boot(t, env) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-intent-'));
  const log = path.join(home, 'claude.log');
  const allEnv = { PATH: process.env.PATH, HOME: home, STUDIO_CLAUDE_BIN: FAKE, FAKE_CLAUDE_LOG: log, ...env };
  const studio = await startStudio(loadConfig({ ...allEnv, STUDIO_HOME: home, STUDIO_PORT: '0', STUDIO_PREVIEW_PORT: '0', STUDIO_NO_OPEN: '1' }), { env: allEnv });
  t.after(async () => {
    await studio.close();
    await fs.rm(home, { recursive: true, force: true });
  });
  return { studio, home, launches: async () => (await fs.readFile(log, 'utf8').catch(() => '')).split('\n').filter(Boolean).map((line) => JSON.parse(line)) };
}

const readRecord = async (home, id) => JSON.parse(await fs.readFile(path.join(home, 'projects', id, '.studio', 'intent.json'), 'utf8'));

for (const [depth, { limit }] of Object.entries(DEPTHS)) {
  test(`場面: 深さ ${depth} の問いは ${limit} を超えない。偽の claude が聞き続けても、Studio が止める`, posixOnly, async (t) => {
    const { studio, home, launches } = await boot(t, { STUDIO_AGENT: 'claude' });
    studio.consent.agree();
    const intents = studio.intents;
    const id = await intents.createProject({ sentence: '架空の 1 文' });
    let view = await intents.start(id, { sentence: '架空の 1 文', depth });
    let questions = 0;
    while (view.status === 'interviewing') {
      questions += 1;
      assert.ok(questions <= limit, `${questions} 問目が出ました`);
      assert.match(view.pending.question, /^偽の問い \d+ は何ですか\?$/);
      view = await intents.answer(id, { answer: `答え ${questions}` });
    }
    assert.equal(questions, limit);
    assert.equal(view.status, 'draft');
    assert.equal((await readRecord(home, id)).turns.length, limit);
    // 1 回の起動が 1 文か 1 つの答えに対応し、守りの引数がそろっている(偽の claude は足りないと止まる)
    const calls = await launches();
    assert.equal(calls.length, limit + 1);
    assert.ok(calls.every((call) => call.argv.includes('--safe-mode') && call.argv[call.argv.indexOf('--tools') + 1] === ''));
  });
}

test('AI の返事に status: decided があっても、「決めた」の印は付かない。decide でだけ付く', posixOnly, async (t) => {
  const { studio, home } = await boot(t, { STUDIO_AGENT: 'claude' });
  studio.consent.agree();
  const intents = studio.intents;
  const id = await intents.createProject({ sentence: '[決めた印] 架空の 1 文' });
  let view = await intents.start(id, { sentence: '[決めた印] 架空の 1 文', depth: 'quick' });
  view = await intents.answer(id, { answer: 'a' });
  view = await intents.answer(id, { answer: 'b' });
  assert.equal(view.status, 'draft');
  assert.equal(view.decidedAt, null);
  assert.equal(intents.summary(id).status, 'draft');
  view = await intents.decide(id, {});
  assert.equal(view.status, 'decided');
  assert.ok(view.decidedAt);
  assert.equal((await readRecord(home, id)).status, 'decided');
  // 画面が送る doc に status を混ぜても、文書には入らない
  await intents.edit(id, { doc: { who: '人', status: 'decided' } });
  assert.equal(intents.summary(id).status, 'draft');
  assert.equal((await readRecord(home, id)).doc.status, undefined);
});

test('同意の前は起動せず、試作品も作らない。AI を使わない道は同意なしで進む', posixOnly, async (t) => {
  const { studio, launches } = await boot(t, { STUDIO_AGENT: 'claude' });
  const intents = studio.intents;
  const before = (await studio.store.list()).length;
  await assert.rejects(intents.createProject({ sentence: '架空の 1 文' }), { code: 'consent-required' });
  assert.equal((await studio.store.list()).length, before);
  const id = await intents.createProject({ sentence: '架空の 1 文', guide: 'fixed' });
  await assert.rejects(intents.start(id, { sentence: '架空の 1 文' }), { code: 'consent-required' });
  let view = await intents.start(id, { sentence: '架空の 1 文', guide: 'fixed' });
  assert.equal(view.pending.question, FIXED_QUESTIONS[0].question);
  view = await intents.answer(id, { answer: '分からない' });
  assert.deepEqual(view.doc.undecided, [FIXED_QUESTIONS[0].question]);
  assert.equal((await launches()).length, 0);
});

test('壊れた出力は 1 回やり直す。2 回とも壊れていると、決まった問いに切り替えて、呼ぶのをやめる', posixOnly, async (t) => {
  const { studio, launches } = await boot(t, { STUDIO_AGENT: 'claude' });
  studio.consent.agree();
  const intents = studio.intents;
  const once = await intents.createProject({ sentence: '[聞き出しが一度壊れる]' });
  assert.equal((await intents.start(once, { sentence: '[聞き出しが一度壊れる]' })).pending.question, '偽の問い 1 は何ですか?');
  assert.equal((await launches()).length, 2);

  const broken = await intents.createProject({ sentence: '[聞き出しが壊れる]' });
  let view = await intents.start(broken, { sentence: '[聞き出しが壊れる]', depth: 'quick' });
  assert.equal(view.pending.question, FIXED_QUESTIONS[0].question);
  assert.equal(view.guide, 'fixed');
  assert.match(view.note, /AI の返事を使えなかった/);
  assert.equal((await launches()).length, 4);
  view = await intents.answer(broken, { answer: 'お店の人' });
  assert.equal(view.pending.question, FIXED_QUESTIONS[1].question);
  assert.equal((await launches()).length, 4);
  assert.equal(view.doc.who, 'お店の人');
});

test('起動に失敗すると決まった問いに切り替わる。問いを返さなくても、最初の 1 問は必ず返す。問いは 1 つに切る', posixOnly, async (t) => {
  const { studio } = await boot(t, { STUDIO_AGENT: 'claude' });
  studio.consent.agree();
  const intents = studio.intents;
  const failed = await intents.createProject({ sentence: '[聞き出しが失敗]' });
  assert.equal((await intents.start(failed, { sentence: '[聞き出しが失敗]' })).pending.question, FIXED_QUESTIONS[0].question);
  const none = await intents.createProject({ sentence: '[問いなし]' });
  const view = await intents.start(none, { sentence: '[問いなし]' });
  assert.equal(view.pending.question, FIXED_QUESTIONS[0].question);
  assert.equal((await intents.answer(none, { answer: 'a' })).status, 'draft');
  const two = await intents.createProject({ sentence: '[問いを 2 つ]' });
  assert.equal((await intents.start(two, { sentence: '[問いを 2 つ]' })).pending.question, '偽の問い 1 は何ですか?');
});

test('Claude Code がないときは、起動せずに決まった問いで進む。同意も要らない', async (t) => {
  const { studio, launches } = await boot(t, { STUDIO_AGENT: 'claude', STUDIO_CLAUDE_BIN: path.join(os.tmpdir(), 'no-such-claude-bin') });
  const intents = studio.intents;
  const id = await intents.createProject({ sentence: '架空の 1 文' });
  const view = await intents.start(id, { sentence: '架空の 1 文' });
  assert.equal(view.guide, 'fixed');
  assert.equal(view.pending.question, FIXED_QUESTIONS[0].question);
  assert.equal((await launches()).length, 0);
});

test('偽接続は同意なしで聞き出す。新しい試作品は表示でき、目録の検査を通る', async (t) => {
  const { studio } = await boot(t, { STUDIO_AGENT: 'fake' });
  const id = await studio.intents.createProject({ sentence: '架空の、長い長い長い長い長い長い長い長い長い長い長い長い長い長い長い長い長い 1 文です' });
  const project = (await studio.store.list()).find((p) => p.id === id);
  assert.equal(project.lastBuild.ok, true);
  assert.ok(project.previewBuildId);
  assert.match(project.title, /…/);
  const view = await studio.intents.start(id, { sentence: '架空の 1 文', depth: 'quick' });
  assert.match(view.pending.question, /架空の 1 文/);
  await assert.rejects(studio.intents.start(id, { sentence: '架空', depth: 'いちばん深く' }), /案内の深さ/);
  await assert.rejects(studio.intents.start(id, { sentence: ' ' }), /1 文で/);
});

test('はじめの画面: 文書があるか閉じたか、設定で止めると出さない', async (t) => {
  const { studio } = await boot(t, { STUDIO_AGENT: 'fake' });
  assert.equal(studio.intents.startState().show, true);
  studio.intents.dismissStart();
  assert.equal(studio.intents.startState().show, false);
  const { studio: off } = await boot(t, { STUDIO_AGENT: 'fake', STUDIO_START_SCREEN: '0' });
  assert.equal(off.intents.startState().show, false);
});

test('形の合わない値は断る。文書でない doc では「決めた」を付けない', async (t) => {
  const { studio } = await boot(t, { STUDIO_AGENT: 'fake' });
  const intents = studio.intents;
  await assert.rejects(intents.createProject({ sentence: '架空', guide: null }), /guide/);
  const id = await intents.createProject({ sentence: '架空の 1 文' });
  await assert.rejects(intents.start(id, { sentence: '架空', depth: ['quick'] }), /案内の深さ/);
  await intents.start(id, { sentence: '架空の 1 文', depth: 'quick' });
  await assert.rejects(intents.decide(id, { doc: 5 }), /文書の形/);
  await assert.rejects(intents.edit(id, { doc: ['a'] }), /文書の形/);
  assert.equal(intents.summary(id).status, 'interviewing');
});

test('別の画面で問いが進んでいたら、答えを断る。同じ試作品の書き換えは 1 つずつ', async (t) => {
  const { studio, home } = await boot(t, { STUDIO_AGENT: 'fake' });
  const intents = studio.intents;
  const id = await intents.createProject({ sentence: '架空の 1 文' });
  await intents.start(id, { sentence: '架空の 1 文' });
  await intents.answer(id, { answer: '答え 1', turn: 0 });
  await assert.rejects(intents.answer(id, { answer: '遅れた答え', turn: 0 }), { code: 'stale-question' });
  const results = await Promise.allSettled([intents.answer(id, { answer: '答え 2', turn: 1 }), intents.decide(id, {})]);
  // どちらが先でもよい。後から来た 1 つだけを断り、先の結果を消さない
  assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
  const record = await readRecord(home, id);
  if (results[0].status === 'fulfilled') {
    assert.equal(record.turns.length, 2);
    assert.notEqual(record.status, 'decided');
  } else {
    assert.equal(record.turns.length, 1);
    assert.equal(record.status, 'decided');
  }
});

test('最初の問いを待つ間に止まっても、起動し直すと決まった問いから続けられる', async (t) => {
  const { studio, home } = await boot(t, { STUDIO_AGENT: 'fake' });
  const id = await studio.intents.createProject({ sentence: '架空の 1 文' });
  const file = path.join(home, 'projects', id, '.studio', 'intent.json');
  await fs.writeFile(file, JSON.stringify({ formatVersion: 1, status: 'interviewing', sentence: '架空の 1 文', depth: 'quick', guide: 'ai', turns: [], pending: null, doc: {} }));
  await studio.intents.load();
  const view = await studio.intents.view(id);
  assert.equal(view.pending.question, FIXED_QUESTIONS[0].question);
  assert.equal(view.guide, 'fixed');
});
