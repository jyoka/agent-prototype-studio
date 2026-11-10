import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { approvalNeeds, architectureFingerprint, changedItems, compositionShape, harnessRows, REVIEW_ITEM_IDS } from '../../src/server/architecture.js';
import { STUDIO_ROOT } from '../../src/server/config.js';
import { ProjectReviews } from '../../src/server/review.js';
import { ProjectStore } from '../../src/server/store.js';

// AI 構成の審査と AI 構成書(src/server/review.js、src/server/architecture.js。docs/design/ai-architecture-review.md の 6 節)。
// AI は呼ばない。見本の試作品(架空の再配達の受付)を写して使う。設計の案内はない形(今の構成を審査する)で確かめる
const PROJECT = 'redelivery-review';

async function setup(t, { mode = 'single' } = {}) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-review-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const root = path.join(home, 'projects', PROJECT);
  await fs.mkdir(path.join(root, '.studio'), { recursive: true });
  await fs.cp(path.join(STUDIO_ROOT, 'samples', 'redelivery', 'app'), path.join(root, 'app'), { recursive: true });
  await fs.writeFile(path.join(root, '.studio', 'project.json'), JSON.stringify({ title: '再配達(架空)' }));
  const store = new ProjectStore(home);
  await store.build(PROJECT);
  const designs = { records: new Map(), intentOf: () => null, boardOf: () => [] };
  const reviews = new ProjectReviews({ home, store, designs, modeOf: () => mode });
  const app = path.join(home, 'projects', PROJECT, 'app');
  const studio = path.join(home, 'projects', PROJECT, '.studio');
  return { home, store, reviews, app, studio };
}

const readJson = async (file) => JSON.parse(await fs.readFile(file, 'utf8'));

test('AI 構成書の項目がそろう: 4 つの審査の中身、場面の指紋、項目ごとの指紋、承認した人と時刻と指紋、承認の時刻', async (t) => {
  const { reviews, studio } = await setup(t);
  // 審査を始める前は、今の試作品として何もしない(R2)
  assert.deepEqual(await reviews.check(PROJECT), { applies: false });
  await reviews.start(PROJECT, { origin: 'existing' });
  for (const item of REVIEW_ITEM_IDS) await reviews.approve(PROJECT, { item, pressedBy: '早瀬(架空)' });
  const { review } = await reviews.build(PROJECT);
  assert.equal(review.status, 'approved');
  const doc = await readJson(path.join(studio, 'reviews', review.id, 'architecture.json'));

  assert.deepEqual(Object.keys(doc).sort(), ['approvals', 'approvedAt', 'approvedUnmeasured', 'basis', 'composition', 'createdAt', 'data', 'evidence', 'fingerprint', 'formatVersion', 'harness', 'id', 'mode', 'origin', 'previous', 'stack', 'stopped', 'updatedAt'].sort());
  assert.equal(doc.formatVersion, 1);
  assert.match(doc.id, /^review-\d{8}-\d{6}-[0-9a-f]{6}$/);
  // 1. 構成: 選んだ形、問いへの答え、捨てた案、図
  assert.equal(doc.composition.chosen, 'fixed-flow');
  assert.ok(Array.isArray(doc.composition.answers) && doc.composition.answers.length === 1);
  assert.ok(Array.isArray(doc.composition.rejected));
  assert.ok(doc.composition.figure.nodes.some((node) => node.kind === 'person'));
  // 2. harness: 表の 9 行、モデルに任せる、コードで縛る、モデル頼み、人に渡す条件、プロンプトの全文
  assert.deepEqual(doc.harness.rows.map((row) => row.id), ['turn', 'ask', 'prompt', 'tools', 'guards', 'escalate', 'limits', 'context', 'trace']);
  for (const key of ['modelDecides', 'codeBinds', 'humanDecides', 'modelOnly', 'escalate', 'prompts']) assert.ok(Array.isArray(doc.harness[key]), key);
  assert.ok(doc.harness.codeBinds.includes('1 ターンの回し方'));
  assert.ok(doc.harness.escalate.length > 0);
  assert.ok(doc.harness.prompts[0].text.length > 0);
  // 3. データと RAG: 棚と判定
  assert.ok(doc.data.shelf.length > 0);
  assert.ok(['要る', '要らない', 'まだ決めていない'].includes(doc.data.rag.verdict));
  // 4. 技術の組: 試作品で使うもの(代わりのモデル)と、本番の候補(確かめていない)
  assert.deepEqual(doc.stack.prototype.map((row) => row.kind), ['model', 'runner', 'tools', 'knowledge', 'memory', 'evals', 'trace']);
  assert.ok(doc.stack.productionCandidates.every((row) => row.verified === false && row.candidates.length > 0));
  // 数: 回していないので「まだ測っていない」。場面の指紋は別に残す
  assert.deepEqual(doc.evidence, { status: 'unmeasured', measuredAt: null, runIds: [], evalsDigest: doc.evidence.evalsDigest });
  assert.match(doc.evidence.evalsDigest, /^[0-9a-f]{64}$/);
  assert.equal(doc.approvedUnmeasured, true);
  // 指紋: 全体と、項目ごとの指紋と入れたファイル
  assert.equal(doc.fingerprint.algorithm, 'sha256');
  assert.match(doc.fingerprint.value, /^[0-9a-f]{64}$/);
  assert.deepEqual(Object.keys(doc.fingerprint.items), ['composition', 'harness', 'data', 'stack']);
  assert.deepEqual(doc.fingerprint.items.composition.files, ['composition.json']);
  assert.ok(doc.fingerprint.items.harness.files.includes('ai.json'));
  assert.ok(doc.fingerprint.items.harness.files.includes('tools.json'));
  assert.deepEqual(doc.fingerprint.items.data.files, ['tools.json']);
  // 承認: 項目ごとに要る役、押した人、声に出した人、時刻、その項目の指紋
  for (const item of REVIEW_ITEM_IDS) {
    assert.deepEqual(doc.approvals[item].needs, ['owner']);
    const [entry] = doc.approvals[item].by;
    assert.deepEqual(Object.keys(entry).sort(), ['at', 'digest', 'pressedBy', 'role', 'spokenBy']);
    assert.equal(entry.pressedBy, '早瀬(架空)');
    assert.equal(entry.digest, doc.fingerprint.items[item].digest);
  }
  assert.ok(Date.parse(doc.approvedAt) >= Date.parse(doc.createdAt));
  // 承認した構成のファイルの写しと、審査が要る印
  assert.ok((await fs.readdir(path.join(studio, 'reviews', review.id, 'files'))).includes('composition.json'));
  assert.equal((await readJson(path.join(studio, 'project.json'))).review, 'required');
  assert.deepEqual(await readJson(path.join(studio, 'reviews', 'current.json')), { id: review.id });
});

test('承認がそろうまで作れない。承認の後に構成のファイルが変わると、その項目の承認が効かなくなり、関門の比べで止まる', async (t) => {
  const { reviews, app } = await setup(t);
  await reviews.start(PROJECT, { origin: 'existing' });
  for (const item of ['composition', 'harness', 'data']) await reviews.approve(PROJECT, { item });
  await assert.rejects(reviews.build(PROJECT), { code: 'not-approved' });
  assert.equal((await reviews.check(PROJECT)).code, 'review-not-approved');
  await reviews.approve(PROJECT, { item: 'stack' });
  await reviews.build(PROJECT);
  assert.equal((await reviews.check(PROJECT)).ok, true);

  // 画面のソースを変えても止めない(指紋に入れない)
  await fs.appendFile(path.join(app, 'App.jsx'), '\n// 画面だけを直した\n');
  assert.equal((await reviews.check(PROJECT)).ok, true);
  // 前提を変えると技術の組だけが変わる
  const assumption = path.join(app, 'assumptions', 'stand-in.json');
  const value = await readJson(assumption);
  await fs.writeFile(assumption, JSON.stringify({ ...value, model: { name: 'claude-haiku-5-5', standIn: true } }, null, 2));
  const check = await reviews.check(PROJECT);
  assert.equal(check.ok, false);
  assert.equal(check.code, 'review-changed');
  assert.deepEqual(check.changed, ['stack']);
  const view = await reviews.view(PROJECT);
  assert.equal(view.items.find((item) => item.id === 'stack').approved, false);
  assert.equal(view.items.find((item) => item.id === 'composition').approved, true);
  assert.equal(view.approvedCount, 3);

  // 止めた後: 審査に戻るか戻すまで、作る AI は起動しない。ファイルが同じに戻っても、止めた印は残る
  await reviews.markStopped(PROJECT, { changed: check.changed });
  assert.equal((await reviews.check(PROJECT)).code, 'review-stopped');
  await assert.rejects(reviews.approve(PROJECT, { item: 'stack' }), { code: 'review-stopped' });
  // 承認した構成に戻すと、前提のファイルが承認したときの中身に戻り、足した前提のファイルは取り除かれ、また作れる
  await fs.writeFile(path.join(app, 'assumptions', 'extra.json'), JSON.stringify({ formatVersion: 1, id: 'extra' }));
  await reviews.restore(PROJECT);
  assert.equal((await readJson(assumption)).model.name, value.model.name);
  await assert.rejects(fs.stat(path.join(app, 'assumptions', 'extra.json')));
  assert.equal((await reviews.check(PROJECT)).ok, true);
  assert.equal((await reviews.view(PROJECT)).status, 'approved');
});

test('指紋: 目録の指し先を替える、ファイルを消すと変わり、項目ごとに分かれる。目録の題名を変えても変わらない', async (t) => {
  const { app } = await setup(t);
  const base = await architectureFingerprint(app);
  assert.equal(await architectureFingerprint(app).then((f) => f.value), base.value);

  // 目録の指し先だけを替える(compositions/ の別の構成へ向け直して素通りしない)
  const manifestFile = path.join(app, 'prototype.json');
  const manifest = await readJson(manifestFile);
  await fs.writeFile(manifestFile, JSON.stringify({ ...manifest, composition: 'compositions/single-agent.json' }));
  const pointed = await architectureFingerprint(app);
  assert.ok(changedItems(base, pointed).includes('composition'));
  await fs.writeFile(manifestFile, JSON.stringify(manifest, null, 2));
  // 目録の指し先以外(題名など)を変えても止めない
  await fs.writeFile(manifestFile, JSON.stringify({ ...manifest, title: '別の名前(架空)' }, null, 2));
  assert.deepEqual(changedItems(base, await architectureFingerprint(app)), []);

  // ツールの宣言を消すと、harness とデータが変わる(ないことも指紋に入る)
  const tools = await fs.readFile(path.join(app, 'tools.json'));
  await fs.rm(path.join(app, 'tools.json'));
  assert.deepEqual(changedItems(base, await architectureFingerprint(app)), ['harness', 'data']);
  await fs.writeFile(path.join(app, 'tools.json'), tools);
  assert.deepEqual(changedItems(base, await architectureFingerprint(app)), []);
});

test('指紋: 構成のない試作品(構成 B)は AI の設定だけを見る。シンボリックリンクはたどらず印にする', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-review-b-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir, 'prototype.json'), JSON.stringify({ formatVersion: 1, title: '架空', entry: 'main.jsx', ai: 'ai.json' }));
  await fs.writeFile(path.join(dir, 'ai.json'), JSON.stringify({ name: '架空' }));
  const fingerprint = await architectureFingerprint(dir);
  assert.deepEqual(fingerprint.items.harness.files, ['ai.json', 'composition.json']);
  assert.deepEqual(fingerprint.items.stack.files, []);
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-review-outside-'));
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  await fs.writeFile(path.join(outside, 'ai.json'), JSON.stringify({ name: '外' }));
  await fs.rm(path.join(dir, 'ai.json'));
  await fs.symlink(path.join(outside, 'ai.json'), path.join(dir, 'ai.json'));
  const linked = await architectureFingerprint(dir);
  assert.notEqual(linked.items.harness.digest, fingerprint.items.harness.digest);
});

test('構成の形と harness の表: 固定の流れはコードが順番を決め、単一エージェントとマスターとサブはモデル頼みの印が付く', () => {
  const harness = { composition: { driver: 'desk', participants: [{ id: 'desk', kind: 'harness', label: '受付', ai: 'ai.json' }], guards: [], limits: { maxTurns: 30 } }, tools: {}, prompts: {}, assumptions: [] };
  const agent = { composition: { driver: 'main', participants: [{ id: 'main', kind: 'agent', label: '案内役', prompt: [{ slot: 'guide', text: '架空の案内' }], tools: [] }], guards: [{ id: 'g', layer: 'prompt', on: 'main', text: '作り話をしない' }], limits: { maxTurns: 12 } }, tools: {}, prompts: {}, assumptions: [] };
  const master = { ...agent, composition: { ...agent.composition, participants: [...agent.composition.participants, { id: 'sub', kind: 'agent', label: '係', prompt: [{ slot: 's', text: '係' }], tools: [] }], delegations: [{ from: 'main', to: 'sub' }] } };
  assert.equal(compositionShape(harness.composition), 'fixed-flow');
  assert.equal(compositionShape(agent.composition), 'single-agent');
  assert.equal(compositionShape(master.composition), 'master-sub');
  assert.equal(compositionShape({ driver: 'a', participants: [{ id: 'a', kind: 'agent' }, { id: 'b', kind: 'agent' }], handoffs: [{ from: 'a', to: 'b' }] }), 'handoff');
  const fixedRows = harnessRows({ simulation: harness, ai: { instructions: '架空', fields: [{ key: 'topic', label: '用件' }], rules: { noNewNumbers: true } } });
  assert.equal(fixedRows.find((row) => row.id === 'turn').decidedBy, 'code');
  assert.match(fixedRows.find((row) => row.id === 'ask').content, /用件/);
  assert.ok(fixedRows.every((row) => !row.modelOnly));
  const agentRows = harnessRows({ simulation: agent });
  assert.equal(agentRows.find((row) => row.id === 'turn').decidedByLabel, 'モデル');
  assert.ok(agentRows.find((row) => row.id === 'ask').modelOnly);
  // プロンプトの頼みだけの守りは、モデル頼み
  assert.ok(agentRows.find((row) => row.id === 'guards').modelOnly);
  assert.match(harnessRows({ simulation: master }).find((row) => row.id === 'turn').content, /子の AI/);
});

test('承認する役: 1 人で使うときは本人。会の中では harness とデータと RAG を進行役と決める人の 2 人が承認する', async (t) => {
  assert.deepEqual(approvalNeeds('single').harness, ['owner']);
  assert.deepEqual(approvalNeeds('meeting'), { composition: ['facilitator'], harness: ['facilitator', 'decider'], data: ['facilitator', 'decider'], stack: ['facilitator'] });
  const { reviews } = await setup(t, { mode: 'meeting' });
  await reviews.start(PROJECT, { origin: 'existing' });
  await assert.rejects(reviews.approve(PROJECT, { item: 'harness', role: 'owner' }), { code: 'invalid' });
  await reviews.approve(PROJECT, { item: 'harness', role: 'facilitator', pressedBy: '進行役(架空)', spokenBy: '決める人(架空)' });
  let view = await reviews.view(PROJECT);
  assert.equal(view.items.find((item) => item.id === 'harness').approved, false);
  await reviews.approve(PROJECT, { item: 'harness', role: 'decider' });
  view = await reviews.view(PROJECT);
  assert.equal(view.items.find((item) => item.id === 'harness').approved, true);
  assert.equal(view.items.find((item) => item.id === 'harness').by[0].spokenBy, '決める人(架空)');
});

test('審査を飛ばすと、飛ばした人、時刻、理由が残り、「審査なし」として作れる', async (t) => {
  const { reviews, studio } = await setup(t);
  await reviews.start(PROJECT, { origin: 'existing' });
  await assert.rejects(reviews.skip(PROJECT, { reason: '' }), { code: 'invalid' });
  await reviews.skip(PROJECT, { reason: '急ぎの確かめだけなので(架空)', by: '早瀬(架空)' });
  const skipped = await readJson(path.join(studio, 'reviews', 'skipped.json'));
  assert.equal(skipped.reason, '急ぎの確かめだけなので(架空)');
  assert.equal(skipped.by, '早瀬(架空)');
  assert.ok(skipped.at);
  assert.deepEqual(await reviews.check(PROJECT), { applies: false });
  assert.equal(reviews.summary(PROJECT).status, 'skipped');
});

test('指紋: 目録の指し先に空白を足して別のファイルへ向け直しても、指紋が変わる(読み込みと同じく、指し先を削らない)', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-review-space-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir, 'prototype.json'), JSON.stringify({ formatVersion: 1, title: '架空', entry: 'main.jsx', ai: 'ai.json' }));
  await fs.writeFile(path.join(dir, 'ai.json'), JSON.stringify({ name: '承認した設定' }));
  const before = await architectureFingerprint(dir);
  await fs.writeFile(path.join(dir, ' ai.json'), JSON.stringify({ name: '承認していない設定' }));
  await fs.writeFile(path.join(dir, 'prototype.json'), JSON.stringify({ formatVersion: 1, title: '架空', entry: 'main.jsx', ai: ' ai.json' }));
  const after = await architectureFingerprint(dir);
  assert.ok(changedItems(before, after).includes('harness'));
  assert.deepEqual(after.items.harness.files, [' ai.json', 'composition.json']);
});

test('承認した構成に戻す: 目録の指し先を戻す。戻しても承認と違えば、ビルドし直さずに断る', async (t) => {
  const { reviews, app, store } = await setup(t);
  await reviews.start(PROJECT, { origin: 'existing' });
  for (const item of REVIEW_ITEM_IDS) await reviews.approve(PROJECT, { item });
  await reviews.build(PROJECT);
  const manifestFile = path.join(app, 'prototype.json');
  const manifest = await readJson(manifestFile);
  await fs.writeFile(manifestFile, JSON.stringify({ ...manifest, composition: 'compositions/single-agent.json', title: '題名も変えた(架空)' }));
  const check = await reviews.check(PROJECT);
  assert.equal(check.code, 'review-changed');
  await reviews.markStopped(PROJECT, { changed: check.changed });
  await reviews.restore(PROJECT);
  const restored = await readJson(manifestFile);
  assert.equal(restored.composition, undefined);
  // 指し先のほかは、そのまま
  assert.equal(restored.title, '題名も変えた(架空)');
  assert.equal((await reviews.check(PROJECT)).ok, true);

  // 戻せないとき(写しが消えた)は、試す欄を替えずに断る
  const shown = store.previewBuildId(PROJECT);
  await fs.writeFile(path.join(app, 'composition.json'), '{"formatVersion": 1, "name": "壊した(架空)"}');
  const { id: reviewId } = await readJson(path.join(app, '..', '.studio', 'reviews', 'current.json'));
  await fs.rm(path.join(app, '..', '.studio', 'reviews', reviewId, 'files', 'composition.json'));
  await reviews.markStopped(PROJECT, { changed: ['composition', 'harness'] });
  await assert.rejects(reviews.restore(PROJECT), { code: 'restore-failed' });
  assert.equal(store.previewBuildId(PROJECT), shown);
});
