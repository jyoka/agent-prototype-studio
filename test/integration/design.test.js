import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadConfig, STUDIO_ROOT } from '../../src/server/config.js';
import { startStudio } from '../../src/server/index.js';

// 設計の案内(src/server/design.js、docs/design/user-journey.md の J2)。実モデルは呼ばない。
// 偽の claude(test/fixtures/fake-claude.js)か、偽接続(STUDIO_AGENT=fake)で動かす
const posixOnly = { skip: process.platform === 'win32' ? '偽の claude を直接起動するため' : false };
const FAKE = path.join(STUDIO_ROOT, 'test', 'fixtures', 'fake-claude.js');

async function boot(t, env) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-design-'));
  const log = path.join(home, 'claude.log');
  const allEnv = { PATH: process.env.PATH, HOME: home, STUDIO_CLAUDE_BIN: FAKE, FAKE_CLAUDE_LOG: log, ...env };
  const studio = await startStudio(loadConfig({ ...allEnv, STUDIO_HOME: home, STUDIO_PORT: '0', STUDIO_PREVIEW_PORT: '0', STUDIO_NO_OPEN: '1' }), { env: allEnv });
  t.after(async () => {
    await studio.close();
    await fs.rm(home, { recursive: true, force: true });
  });
  const designCalls = async () => (await fs.readFile(log, 'utf8').catch(() => '')).split('\n').filter(Boolean).map((line) => JSON.parse(line)).filter((call) => call.argv.some((arg) => arg.includes('"screens"')));
  return { studio, home, designCalls };
}

const appOf = (home, id, ...name) => path.join(home, 'projects', id, 'app', ...name);
const stepOf = (view, id) => view.steps.find((step) => step.id === id);

async function chooseAll(designs, id, composition) {
  for (const step of ['problem', 'users', 'scenes', 'composition', 'screens']) {
    const view = await designs.view(id);
    const option = step === 'composition' ? composition : stepOf(view, step).options[0].id;
    await designs.choose(id, { step, option });
  }
}

test('案を出す AI: 同意の前は呼ばない。起動は道具なしで、返事の印と知らない項目は使わない', posixOnly, async (t) => {
  const { studio, home, designCalls } = await boot(t, { STUDIO_AGENT: 'claude' });
  const id = await studio.intents.createProject({ sentence: '[印を書く] 架空の 1 文', guide: 'fixed' });
  await studio.intents.start(id, { sentence: '[印を書く] 架空の 1 文', guide: 'fixed' });
  await assert.rejects(studio.designs.start(id, { guide: 'ai' }), { code: 'consent-required' });
  assert.equal((await designCalls()).length, 0);
  assert.equal(studio.designs.summary(id).status, 'none');

  studio.consent.agree();
  const view = await studio.designs.start(id, { guide: 'ai' });
  const calls = await designCalls();
  assert.equal(calls.length, 1);
  assert.ok(calls[0].argv.includes('--safe-mode'));
  assert.equal(calls[0].argv[calls[0].argv.indexOf('--tools') + 1], '');
  // AI が status: decided やファイルの名前を返しても、印は付かず、ファイルは書かない
  assert.equal(view.status, 'drafting');
  assert.equal(view.decidedAt, null);
  assert.equal(view.guide, 'ai');
  await assert.rejects(fs.stat(path.join(home, 'projects', 'outside.json')));
  assert.deepEqual(stepOf(view, 'problem').options.map((option) => option.title), ['偽の問題 1', '偽の問題 2', '偽の問題 3']);
  assert.equal(stepOf(view, 'problem').options[1].recommended, true);
  // AI が落とした分からない、遅いは Studio が足す
  for (const option of stepOf(view, 'scenes').options) {
    for (const category of view.requiredScenes) assert.ok(option.scenes.some((scene) => scene.category === category), category);
  }
  assert.equal(stepOf(view, 'composition').options.find((option) => option.recommended).id, 'single-agent');
  assert.equal(stepOf(view, 'screens').options.find((option) => option.recommended).id, 'talk');
});

for (const [mark, expected] of [['[案が壊れる]', 'AI の返事を使えなかった'], ['[案が失敗]', 'AI の返事を使えなかった']]) {
  test(`案を出す AI: ${mark} のときは、Studio の決まった案で進める`, posixOnly, async (t) => {
    const { studio } = await boot(t, { STUDIO_AGENT: 'claude' });
    studio.consent.agree();
    const sentence = `${mark} 架空の 1 文`;
    const id = await studio.intents.createProject({ sentence, guide: 'fixed' });
    await studio.intents.start(id, { sentence, guide: 'fixed' });
    const view = await studio.designs.start(id, { guide: 'ai' });
    assert.match(view.note, new RegExp(expected));
    assert.equal(view.guide, 'fixed');
    assert.equal(stepOf(view, 'problem').options[0].title, '目的の文書のまま');
  });
}

test('案を出す AI: 一度壊れた返事は 1 回やり直す。「理想」を含む案は使わない。難しい形は勧めない', posixOnly, async (t) => {
  const { studio, designCalls } = await boot(t, { STUDIO_AGENT: 'claude' });
  studio.consent.agree();
  const sentence = '[案が一度壊れる] [案に理想] [難しい形] 架空の 1 文';
  const id = await studio.intents.createProject({ sentence, guide: 'fixed' });
  await studio.intents.start(id, { sentence, guide: 'fixed' });
  const view = await studio.designs.start(id, { guide: 'ai' });
  assert.equal((await designCalls()).length, 2);
  // 残りが 1 つになった「問題」の段は決まった案に戻る
  assert.equal(stepOf(view, 'problem').options[0].title, '目的の文書のまま');
  assert.equal(stepOf(view, 'composition').options.find((option) => option.recommended).id, 'fixed-flow');
});

test('案を待つ間は止められ、止めると決まった案で進む', posixOnly, async (t) => {
  const { studio, designCalls } = await boot(t, { STUDIO_AGENT: 'claude' });
  studio.consent.agree();
  const sentence = '[案が遅い] 架空の 1 文';
  const id = await studio.intents.createProject({ sentence, guide: 'fixed' });
  await studio.intents.start(id, { sentence, guide: 'fixed' });
  const waiting = studio.designs.start(id, { guide: 'ai' });
  for (let i = 0; i < 100 && (await designCalls()).length === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal((await studio.designs.view(id)).thinking, true);
  await assert.rejects(studio.designs.go(id, { step: 'problem' }), /案を作っているところです/);
  assert.equal(studio.designs.cancel(id), true);
  const view = await waiting;
  assert.match(view.note, /止めました/);
  assert.equal(view.thinking, false);
});

test('AI を使えないとき、決まった案で進む。作る AI の動いている間は、ファイルを書かずに断る', async (t) => {
  const { studio, home } = await boot(t, { STUDIO_AGENT: 'fake' });
  const id = await studio.intents.createProject({ sentence: '架空の 1 文', guide: 'fixed' });
  const fixed = await studio.designs.start(id, { guide: 'fixed' });
  assert.equal(fixed.guide, 'fixed');
  await studio.designs.choose(id, { step: 'problem', option: stepOf(fixed, 'problem').options[0].id });
  await studio.designs.choose(id, { step: 'users', option: stepOf(fixed, 'users').options[0].id });
  studio.store.claimRun(id);
  await assert.rejects(studio.designs.choose(id, { step: 'scenes', option: stepOf(fixed, 'scenes').options[0].id }), /作業中/);
  studio.store.releaseRun(id);
  await assert.rejects(fs.stat(appOf(home, id, 'evals')));
  assert.equal(stepOf(await studio.designs.view(id), 'scenes').chosen, null);
});

test('段の決まり: 知らない案、まだ選べない案、自分の言葉のない案は断る。選んでいない段の先へは進めない。作る前に全部を選ぶ', async (t) => {
  const { studio } = await boot(t, { STUDIO_AGENT: 'fake' });
  const id = await studio.intents.createProject({ sentence: '架空の 1 文', guide: 'fixed' });
  await assert.rejects(studio.designs.choose(id, { step: 'problem', option: 'x' }), { code: 'not-started' });
  const view = await studio.designs.start(id, { guide: 'ai' });
  await assert.rejects(studio.designs.choose(id, { step: 'nope', option: 'x' }), { code: 'invalid' });
  await assert.rejects(studio.designs.choose(id, { step: 'problem', option: 'x' }), { code: 'invalid' });
  await assert.rejects(studio.designs.choose(id, { step: 'problem', option: 'custom', text: '  ' }), { code: 'invalid' });
  await assert.rejects(studio.designs.choose(id, { step: 'composition', option: 'custom', text: '書く' }), { code: 'invalid' });
  await assert.rejects(studio.designs.choose(id, { step: 'composition', option: 'master-sub' }), { code: 'not-available' });
  await assert.rejects(studio.designs.go(id, { step: 'users' }), { code: 'not-chosen' });
  await assert.rejects(studio.designs.decide(id), { code: 'not-ready' });
  await studio.designs.choose(id, { step: 'problem', option: stepOf(view, 'problem').options[0].id });
  await studio.designs.go(id, { step: 'users' });
  await studio.designs.go(id, { step: 'problem' });
});

test('場面の直し: 分からない、断る、遅いのどれかが欠ける一覧は断り、ファイルを変えない。消した場面のファイルは消す', async (t) => {
  const { studio, home } = await boot(t, { STUDIO_AGENT: 'fake' });
  const id = await studio.intents.createProject({ sentence: '架空の 1 文', guide: 'fixed' });
  const view = await studio.designs.start(id, { guide: 'ai' });
  await assert.rejects(studio.designs.saveScenes(id, { scenes: [] }), { code: 'not-chosen' });
  const { scenes } = await studio.designs.choose(id, { step: 'scenes', option: stepOf(view, 'scenes').options[0].id });
  await assert.rejects(studio.designs.saveScenes(id, { scenes: scenes.filter((scene) => scene.category !== 'slow') }), { code: 'missing-scene' });
  await fs.stat(appOf(home, id, 'evals', 'design-slow-1.json'));
  await studio.designs.saveScenes(id, { scenes: scenes.filter((scene) => scene.category !== 'human') });
  await assert.rejects(fs.stat(appOf(home, id, 'evals', 'design-human-1.json')));
  await fs.stat(appOf(home, id, 'evals', 'design-slow-1.json'));
});

test('持ち主のファイル: 持ち主が直した場面と構成は書き換えない。シンボリックリンクの先には書かない', posixOnly, async (t) => {
  const { studio, home } = await boot(t, { STUDIO_AGENT: 'fake' });
  const id = await studio.intents.createProject({ sentence: '架空の 1 文', guide: 'fixed' });
  let view = await studio.designs.start(id, { guide: 'ai' });
  view = await studio.designs.choose(id, { step: 'scenes', option: stepOf(view, 'scenes').options[0].id });

  // 持ち主が場面を直した。次に書くときも残し、知らせる
  const edited = appOf(home, id, 'evals', 'design-refuse-1.json');
  const mine = { ...JSON.parse(await fs.readFile(edited, 'utf8')), about: '持ち主が直した場面' };
  await fs.writeFile(edited, JSON.stringify(mine));
  view = await studio.designs.saveScenes(id, { scenes: [...view.scenes, { category: 'normal', text: '足した場面' }] });
  assert.match(view.note, /持ち主が直したファイル/);
  assert.equal(JSON.parse(await fs.readFile(edited, 'utf8')).about, '持ち主が直した場面');

  // 構成を選んだ後に持ち主が直すと、選んだ案は確かめ直しになり、作れない。選び直しても書き換えない
  await studio.designs.choose(id, { step: 'problem', option: stepOf(view, 'problem').options[0].id });
  await studio.designs.choose(id, { step: 'users', option: stepOf(view, 'users').options[0].id });
  // 前の段を選んだので、場面の段は確かめ直し。同じ案を押し直しても、直した場面は消えない
  assert.equal(stepOf(await studio.designs.view(id), 'scenes').stale, true);
  view = await studio.designs.choose(id, { step: 'scenes', option: stepOf(view, 'scenes').chosen });
  assert.ok(view.scenes.some((scene) => scene.text === '足した場面'));
  await studio.designs.choose(id, { step: 'composition', option: 'fixed-flow' });
  await studio.designs.choose(id, { step: 'screens', option: 'web' });
  const compositionFile = appOf(home, id, 'composition.json');
  const changed = { ...JSON.parse(await fs.readFile(compositionFile, 'utf8')), name: '持ち主の構成' };
  await fs.writeFile(compositionFile, JSON.stringify(changed));
  view = await studio.designs.view(id);
  assert.equal(view.ownerComposition, true);
  assert.equal(view.ready, false);
  assert.equal(stepOf(view, 'composition').stale, true);
  await assert.rejects(studio.designs.decide(id), { code: 'not-ready' });
  await assert.rejects(studio.designs.choose(id, { step: 'composition', option: 'single-agent' }), { code: 'owner-composition' });
  await studio.designs.choose(id, { step: 'composition', option: 'keep' });
  await studio.designs.choose(id, { step: 'screens', option: 'talk' });
  assert.equal(JSON.parse(await fs.readFile(compositionFile, 'utf8')).name, '持ち主の構成');
  // 構成が読む ai.json は消さない(消すと持ち主の構成が検査を通らない)
  await fs.stat(appOf(home, id, 'ai.json'));
  assert.equal((await studio.store.list()).find((p) => p.id === id).lastBuild.ok, true);
  assert.equal((await studio.designs.decide(id)).design.status, 'decided');

  // 場面のフォルダーがリンクなら、外には書かない
  const other = await studio.intents.createProject({ sentence: '別の架空の 1 文', guide: 'fixed' });
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-design-outside-'));
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  await fs.symlink(outside, appOf(home, other, 'evals'));
  view = await studio.designs.start(other, { guide: 'ai' });
  await studio.designs.choose(other, { step: 'scenes', option: stepOf(view, 'scenes').options[0].id });
  assert.deepEqual(await fs.readdir(outside), []);
});

test('案と関係のない失敗では止めない。書いたファイルの誤りなら元に戻して断る。作り直しに失敗したら前の案を残す', posixOnly, async (t) => {
  const { studio, home } = await boot(t, { STUDIO_AGENT: 'claude' });
  studio.consent.agree();
  const id = await studio.intents.createProject({ sentence: '架空の 1 文', guide: 'fixed' });
  await studio.intents.start(id, { sentence: '架空の 1 文', guide: 'fixed' });
  let view = await studio.designs.start(id, { guide: 'ai' });
  assert.equal(stepOf(view, 'problem').source, 'ai');
  const chosenTitle = stepOf(view, 'problem').options[1].title;

  // 画面のソースが壊れていても、場面は書ける
  await fs.writeFile(appOf(home, id, 'main.jsx'), 'const broken = ;\n');
  view = await studio.designs.choose(id, { step: 'scenes', option: stepOf(view, 'scenes').options[1].id });
  await fs.stat(appOf(home, id, 'evals', 'design-slow-1.json'));

  // 持ち主の前提の上限で、書いた構成のプロンプトが通らない。書いたファイルの誤りとして戻す
  await fs.writeFile(appOf(home, id, 'main.jsx'), "export {};\n");
  await fs.mkdir(appOf(home, id, 'assumptions'), { recursive: true });
  await fs.writeFile(appOf(home, id, 'assumptions', 'mine.json'), JSON.stringify({ formatVersion: 1, id: 'mine', name: '持ち主の前提(架空)', slots: { guide: { maxChars: 1 } } }));
  await assert.rejects(studio.designs.choose(id, { step: 'composition', option: 'single-agent' }), (error) => {
    assert.equal(error.code, 'check-failed');
    assert.doesNotMatch(error.message, /app\//);
    return true;
  });
  await assert.rejects(fs.stat(appOf(home, id, 'composition.json')));
  await assert.rejects(fs.stat(appOf(home, id, 'mocks', 'studio-main.json')));
  assert.equal(stepOf(await studio.designs.view(id), 'composition').chosen, null);
  await fs.rm(appOf(home, id, 'assumptions'), { recursive: true });

  // 作り直しに失敗しても、前の AI の案を残す
  const intent = studio.intents.records.get(id);
  intent.sentence = '[案が失敗] 架空の 1 文';
  view = await studio.designs.start(id, { guide: 'ai' });
  assert.match(view.note, /前の案のまま/);
  assert.equal(stepOf(view, 'problem').options[1].title, chosenTitle);
  assert.equal(stepOf(view, 'problem').source, 'ai');
});

test('目録が別の置き場所を指すとき: 別の構成のファイルは持ち主の構成として扱い、場面は目録の置き場所に書く', async (t) => {
  const { studio, home } = await boot(t, { STUDIO_AGENT: 'fake' });
  const id = await studio.intents.createProject({ sentence: '架空の 1 文', guide: 'fixed' });
  const manifest = JSON.parse(await fs.readFile(appOf(home, id, 'prototype.json'), 'utf8'));
  await fs.writeFile(appOf(home, id, 'prototype.json'), JSON.stringify({ ...manifest, formatVersion: 2, evals: 'cases' }));
  await fs.mkdir(appOf(home, id, 'cases'));
  await studio.store.build(id);
  let view = await studio.designs.start(id, { guide: 'ai' });
  view = await studio.designs.choose(id, { step: 'scenes', option: stepOf(view, 'scenes').options[0].id });
  await fs.stat(appOf(home, id, 'cases', 'design-unknown-1.json'));
  await assert.rejects(fs.stat(appOf(home, id, 'evals')));
  assert.equal(view.ownerComposition, false);

  // compositions/ に持ち主の構成があれば、書くと隠すので書かない
  await fs.mkdir(appOf(home, id, 'compositions'));
  await fs.writeFile(appOf(home, id, 'compositions', 'mine.json'), '{}');
  assert.equal((await studio.designs.view(id)).ownerComposition, true);
  await assert.rejects(studio.designs.choose(id, { step: 'composition', option: 'fixed-flow' }), { code: 'owner-composition' });
  await fs.rm(appOf(home, id, 'compositions'), { recursive: true });
});

test('今ある試作品(AI の設定だけ)で固定の流れを選ぶと、持ち主の AI の設定を使い、場面が回る', async (t) => {
  const { studio, home } = await boot(t, { STUDIO_AGENT: 'fake' });
  const id = 'sample-job-consult';
  const before = await fs.readFile(appOf(home, id, 'ai.json'), 'utf8');
  await studio.designs.start(id, { guide: 'ai' });
  await assert.rejects(studio.designs.choose(id, { step: 'composition', option: 'single-agent' }), { code: 'not-available' });
  await chooseAll(studio.designs, id, 'fixed-flow');
  assert.equal(await fs.readFile(appOf(home, id, 'ai.json'), 'utf8'), before);
  const { request } = await studio.designs.decide(id);
  const started = await studio.requests.start(id, request);
  await new Promise((resolve) => started.subscribe(() => {}, resolve));
  const run = studio.requests.list(id).at(-1);
  const gate = (name) => run.gates.find((g) => g.name === name);
  assert.equal(gate('contract').status, 'passed');
  assert.equal(gate('scenarios').status, 'passed', JSON.stringify(gate('scenarios')));
  assert.equal(gate('evals').status, 'passed', JSON.stringify(gate('evals')));
  assert.equal(gate('evals').evalCount, 5);
  assert.equal(run.status, 'passed');
  // 捨てた案の理由にも、選べなかったことを残す
  const rejected = (await studio.designs.view(id)).composition.rejected.find((item) => item.option === 'single-agent');
  assert.match(rejected.reason, /AI の設定があるので/);
});

for (const id of ['sample-job-consult', 'sample-study-consult']) {
  test(`AI の設定のある試作品(${id}): AI が単一エージェントを勧めても、選べず、固定の流れを勧める`, posixOnly, async (t) => {
    const { studio } = await boot(t, { STUDIO_AGENT: 'claude' });
    studio.consent.agree();
    const view = await studio.designs.start(id, { guide: 'ai' });
    const options = stepOf(view, 'composition').options;
    const single = options.find((option) => option.id === 'single-agent');
    assert.equal(single.available, false);
    assert.equal(single.recommended, false);
    assert.match(single.limitation, /AI の設定があるので/);
    const recommended = options.filter((option) => option.recommended);
    assert.deepEqual(recommended.map((option) => option.id), ['fixed-flow']);
    assert.match(recommended[0].reason, /AI の設定があるので/);
  });
}

test('AI の設定が後から残ると、単一エージェントは確かめ直しになり、作れない。固定の流れに替えると、設定を書き換えない', async (t) => {
  const { studio, home } = await boot(t, { STUDIO_AGENT: 'fake' });
  const id = await studio.intents.createProject({ sentence: '架空の 1 文', guide: 'fixed' });
  await studio.designs.start(id, { guide: 'ai' });
  await chooseAll(studio.designs, id, 'single-agent');
  assert.equal((await studio.designs.view(id)).ready, true);

  // 作る AI や人が ai.json を置いた(Studio が書いた覚えはない)
  const mine = await fs.readFile(appOf(home, 'sample-job-consult', 'ai.json'), 'utf8');
  await fs.writeFile(appOf(home, id, 'ai.json'), mine);
  let view = await studio.designs.view(id);
  assert.equal(view.ready, false);
  assert.equal(stepOf(view, 'composition').stale, true);
  await assert.rejects(studio.designs.decide(id), { code: 'not-ready' });
  await assert.rejects(studio.designs.choose(id, { step: 'composition', option: 'single-agent' }), { code: 'not-available' });

  view = await studio.designs.choose(id, { step: 'composition', option: 'fixed-flow' });
  assert.equal(await fs.readFile(appOf(home, id, 'ai.json'), 'utf8'), mine);
  await studio.designs.choose(id, { step: 'screens', option: stepOf(view, 'screens').chosen });
  assert.equal((await studio.designs.view(id)).ready, true);
  assert.equal((await studio.store.list()).find((p) => p.id === id).lastBuild.ok, true);
});

test('Studio が書いた AI の設定だけなら、単一エージェントに替えられる。目録が指すと消さない', async (t) => {
  const { studio, home } = await boot(t, { STUDIO_AGENT: 'fake' });
  const id = await studio.intents.createProject({ sentence: '架空の 1 文', guide: 'fixed' });
  await studio.designs.start(id, { guide: 'ai' });
  await chooseAll(studio.designs, id, 'fixed-flow');
  await fs.stat(appOf(home, id, 'ai.json'));
  await studio.designs.choose(id, { step: 'composition', option: 'single-agent' });
  await assert.rejects(fs.stat(appOf(home, id, 'ai.json')));
  await studio.designs.choose(id, { step: 'composition', option: 'fixed-flow' });

  // 作る AI が目録に ai を書いた。消すとビルドが止まるので、単一エージェントを選ばせない
  const manifest = JSON.parse(await fs.readFile(appOf(home, id, 'prototype.json'), 'utf8'));
  await fs.writeFile(appOf(home, id, 'prototype.json'), JSON.stringify({ ...manifest, ai: 'ai.json' }));
  await studio.store.build(id);
  await assert.rejects(studio.designs.choose(id, { step: 'composition', option: 'single-agent' }), { code: 'not-available' });
  await fs.stat(appOf(home, id, 'ai.json'));
  assert.equal((await studio.store.list()).find((p) => p.id === id).lastBuild.ok, true);
});

test('版を戻してファイルが選んだ案と違っても、作る前に合わせる。起動し直しても続きに戻れる', async (t) => {
  const { studio, home } = await boot(t, { STUDIO_AGENT: 'fake' });
  const id = await studio.intents.createProject({ sentence: '架空の 1 文', guide: 'fixed' });
  await studio.designs.start(id, { guide: 'ai' });
  await chooseAll(studio.designs, id, 'single-agent');
  await fs.rm(appOf(home, id, 'composition.json'));
  await fs.rm(appOf(home, id, 'evals'), { recursive: true });
  await studio.designs.decide(id);
  assert.equal(JSON.parse(await fs.readFile(appOf(home, id, 'composition.json'), 'utf8')).participants[0].kind, 'agent');
  await fs.stat(appOf(home, id, 'evals', 'design-unknown-1.json'));
  await studio.designs.close();
  // 別の ProjectDesigns が読み直す
  const { ProjectDesigns } = await import('../../src/server/design.js');
  const again = new ProjectDesigns({ home, store: studio.store, ai: { close: async () => {} }, consent: studio.consent, aiMode: () => null });
  await again.load();
  assert.equal(again.summary(id).status, 'decided');
  assert.equal((await again.view(id)).ready, true);
});
