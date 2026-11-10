import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { dataReview, REVIEW_ITEM_IDS } from '../../src/server/architecture.js';
import { buildApp } from '../../src/server/build.js';
import { DATA_FILE, sampleData, shapeDataOption } from '../../src/server/data-design.js';
import { shelfFromDataDesign, shelfProblems } from '../../src/server/data-shelf.js';
import { desiredFiles, designRequest, fixedOptions, mergeAiOptions, STEPS, STUDIO_TOOLS } from '../../src/server/design.js';
import { createMockConnection } from '../../src/server/product-ai/mock.js';
import { ProjectReviews } from '../../src/server/review.js';
import { createMockAgent } from '../../src/server/sim/agent-mock.js';
import { prepareSimulation, runTurn, startConversation } from '../../src/server/sim/orchestrator.js';
import { ProjectStore } from '../../src/server/store.js';

// Studio が書く構成に、データを引くツールの宣言を入れる(docs/design/ai-architecture-review.md の 16 節、task 426)。
// 題材は道具を選ぶ必要のある架空の家電店(scripts/check-review.js の「choose-tools」と同じ形)。実モデルは呼ばない。データはすべて架空

const BOARD = [
  { id: 'i1', column: 'requirement', text: '在庫を聞かれたら在庫の表を、修理を聞かれたら修理の受付番号で進み具合を調べる' },
  { id: 'i4', column: 'data', text: '商品の在庫の表(品番、店ごとの数)' },
  { id: 'i5', column: 'data', text: '修理の受付(受付番号、状態、戻る予定日)' },
  { id: 'i6', column: 'data', text: '取扱説明書(商品ごとの長い文書)' },
  { id: 'i7', column: 'rule', text: '分からないことは店員に回す' },
];
const MATERIAL = { sentence: '架空の家電店「ことぶき電機」の問い合わせに、在庫、修理の進み具合、取扱説明書を使い分けて答えたい', doc: null, board: BOARD };
const DATA_OPTION = shapeDataOption({
  title: '在庫、修理、説明書の 3 つの表',
  reason: '問い合わせごとに引く表が違うため',
  entities: [
    { name: '商品の在庫', about: '店ごとの在庫です。', writer: '人', sources: ['i4'], fields: [{ name: '品番', kind: 'text', examples: ['RF-100(架空)', 'TV-200(架空)'], sources: ['i4'] }, { name: '店ごとの数', kind: 'number', examples: [3, 0] }] },
    { name: '修理の受付', about: '預かった修理です。', writer: '人', sources: ['i5'], fields: [{ name: '状態', kind: 'choice', examples: ['点検中', '修理済み'] }, { name: '戻る予定日', kind: 'date' }] },
    { name: '取扱説明書', about: '商品ごとの説明書です。', writer: '人', sources: ['i6'], fields: [{ name: '見出し', kind: 'text', examples: ['お手入れ', '設定'] }] },
  ],
  links: [],
}, BOARD);
const SCENES = [
  { category: 'normal', text: '修理の受付をした洗濯機は、いつ戻りますか' },
  { category: 'normal', text: '冷蔵庫は今お店にありますか' },
  { category: 'unknown', text: '来月の新製品の値段を教えてください' },
  { category: 'refuse', text: '値引きしてください' },
  { category: 'slow', text: '全部の店の在庫をまとめて調べてください' },
];
const TOOL_NAMES = ['search_table_1', 'search_table_2', 'search_table_3'];

function recordWith(composition, { data = true } = {}) {
  const options = mergeAiOptions(fixedOptions(MATERIAL), null);
  const steps = {};
  for (const { id } of STEPS) steps[id] = { options: options[id], chosen: options[id][0].id, text: null, note: '', decidedAt: null, stale: false };
  steps.data = data ? { options: [{ ...DATA_OPTION, id: 'o1-1' }], chosen: 'o1-1', text: null, note: '', decidedAt: null, stale: false } : { options: [], chosen: null, text: null, note: '', decidedAt: null, stale: false };
  steps.composition.chosen = composition;
  return { steps, scenes: SCENES };
}

async function writeApp(dir, record) {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'prototype.json'), JSON.stringify({ formatVersion: 1, title: '家電店(架空)', entry: 'main.jsx' }));
  await fs.writeFile(path.join(dir, 'main.jsx'), 'export {};\n');
  for (const [relative, content] of desiredFiles(record)) {
    const file = path.join(dir, ...relative.split('/'));
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content);
  }
}

async function built(t, record) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-design-tools-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const appDir = path.join(root, 'app');
  await writeApp(appDir, record);
  const result = await buildApp({ appDir, buildsDir: path.join(root, 'builds') });
  assert.ok(result.ok, JSON.stringify(result.errors));
  return { appDir, result };
}

// 場面の文を 1 つずつ、新しい会話で回す。呼んだツールの段を返す
async function toolStepsOf(result) {
  const sim = prepareSimulation(result.simulation, { aiOf: () => null, dataNumbers: result.dataNumbers ?? [] });
  const steps = [];
  for (const scene of SCENES) {
    const turn = await runTurn({ sim, conversation: startConversation(sim), input: { text: scene.text }, agent: createMockAgent(), harnessConnection: createMockConnection() });
    for (const step of turn.record.steps.filter((item) => item.tool !== undefined)) steps.push({ scene: scene.text, tool: step.tool, by: step.by, ok: step.result.ok });
    for (const message of turn.said) assert.doesNotMatch(message.text, /\d/, `返事に数字を入れない: ${message.text}`);
  }
  return steps;
}

test('単一エージェント: 道具を選ぶ題材で、案内役に表ごとの探すツールが入り、表のデータを書く。お試しの AI で道具を呼ぶ', async (t) => {
  const record = recordWith('single-agent');
  const files = desiredFiles(record);
  const composition = JSON.parse(files.get('composition.json'));
  assert.equal(composition.tools, STUDIO_TOOLS);
  assert.deepEqual(composition.participants[0].tools, TOOL_NAMES);
  const { tools } = JSON.parse(files.get(STUDIO_TOOLS));
  assert.deepEqual(tools.map((tool) => [tool.name, tool.do.op, tool.do.data]), [
    ['search_table_1', 'search', 'data/design-table-1.json'],
    ['search_table_2', 'search', 'data/design-table-2.json'],
    ['search_table_3', 'search', 'data/design-table-3.json'],
  ]);
  // 探す項目は最初の文の項目。表の名前は説明の文に入る
  assert.deepEqual(tools[0].do.match, { keyword: { field: '品番', contains: true } });
  assert.deepEqual(tools[1].do.match, { keyword: { field: '状態', contains: true } });
  assert.match(tools[0].description, /「商品の在庫」の表/);
  // 表のデータは、画面の架空のデータ(design-data.json)と同じ行
  const sample = sampleData(DATA_OPTION);
  for (const [index, table] of sample.tables.entries()) assert.deepEqual(JSON.parse(files.get(`data/design-table-${index + 1}.json`)), table.rows);
  assert.deepEqual(JSON.parse(files.get(DATA_FILE)), sample);

  const { result } = await built(t, record);
  assert.deepEqual(Object.keys(result.simulation.tools), [STUDIO_TOOLS]);
  const steps = await toolStepsOf(result);
  // うまくいく場面と分からない場面で 1 回ずつ引く。場面の文に表の名前があればその表
  assert.deepEqual(steps.map((step) => [step.tool, step.by, step.ok]), [
    ['search_table_2', 'main', true],
    ['search_table_1', 'main', true],
    ['search_table_1', 'main', true],
  ]);
});

test('マスターとサブ: データを引く子の調べる係に表のツールが入り、親は任せるツールだけ。お試しの AI で子が道具を呼ぶ', async (t) => {
  const record = recordWith('master-sub');
  const files = desiredFiles(record);
  const composition = JSON.parse(files.get('composition.json'));
  const byId = Object.fromEntries(composition.participants.map((p) => [p.id, p]));
  assert.deepEqual(byId.main.tools, ['ask_helper']);
  assert.deepEqual(byId.helper.tools, TOOL_NAMES);
  assert.deepEqual(JSON.parse(files.get(STUDIO_TOOLS)).tools.map((tool) => tool.name), ['ask_helper', ...TOOL_NAMES]);

  const { result } = await built(t, record);
  const steps = await toolStepsOf(result);
  assert.deepEqual(steps.map((step) => [step.tool, step.by, step.ok]), [
    ['ask_helper', 'main', true], ['search_table_2', 'helper', true],
    ['ask_helper', 'main', true], ['search_table_1', 'helper', true],
    ['ask_helper', 'main', true], ['search_table_1', 'helper', true],
  ]);
});

test('データの段で表を選んでいない設計は、今までどおりツールを書かない', () => {
  for (const chosen of ['single-agent', 'master-sub', 'fixed-flow']) {
    const files = desiredFiles(recordWith(chosen, { data: false }));
    assert.ok(![...files.keys()].some((name) => name.startsWith('data/design-table-')), chosen);
    const composition = JSON.parse(files.get('composition.json'));
    if (chosen === 'single-agent') {
      assert.equal(files.has(STUDIO_TOOLS), false);
      assert.equal(Object.hasOwn(composition, 'tools'), false);
      assert.equal(Object.hasOwn(composition.participants[0], 'tools'), false);
    }
    if (chosen === 'master-sub') assert.deepEqual(JSON.parse(files.get(STUDIO_TOOLS)).tools.map((tool) => tool.name), ['ask_helper']);
  }
  // 固定の流れには、表があっても入れない
  assert.equal(desiredFiles(recordWith('fixed-flow')).has(STUDIO_TOOLS), false);
});

test('依頼の文: 表のツールを書いた構成だけ、ツールの宣言と表のデータを Studio が書いたことと、変えないことを伝える', () => {
  assert.match(designRequest({ doc: null, record: recordWith('single-agent') }), /データの表を引くツールの宣言\(studio-tools\.json\)と、ツールが読む表のデータ\(data\/design-table-\*\.json\)は Studio が書きました。変えないでください/);
  assert.doesNotMatch(designRequest({ doc: null, record: recordWith('single-agent', { data: false }) }), /表を引くツール/);
  assert.doesNotMatch(designRequest({ doc: null, record: recordWith('fixed-flow') }), /表を引くツール/);
});

test('審査のデータの棚: 設計の表の行に、その表を引くツールの名前が付く。同じ表を 2 行に出さない', async (t) => {
  const { result } = await built(t, recordWith('master-sub'));
  const designShelf = shelfFromDataDesign(DATA_OPTION, BOARD);
  const { shelf, source } = dataReview({ simulation: result.simulation, manifest: result.manifest, designShelf });
  assert.equal(source, 'data-design');
  assert.deepEqual(shelfProblems(shelf), []);
  assert.deepEqual(shelf.map((item) => [item.id, item.read, item.tools]), [
    ['table-1', 'tool', ['search_table_1']],
    ['table-2', 'tool', ['search_table_2']],
    ['table-3', 'tool', ['search_table_3']],
    ['rules', 'prompt', []],
    ['document-1', 'rag', []],
  ]);
  // 設計の棚がないとき(今の構成を審査する)は、試作品のツールとデータから作り、ツールの名前を付ける
  const app = dataReview({ simulation: result.simulation, manifest: result.manifest });
  assert.deepEqual(app.shelf.map((item) => [item.read, item.tools]), TOOL_NAMES.map((name) => ['tool', [name]]));
});

test('関門 GA: 入ったツールの宣言は承認の指紋に入る。作る AI が同じ宣言を書いても止まらず、違う宣言を足すと止まる', async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-design-tools-ga-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const id = 'kaden-review';
  const root = path.join(home, 'projects', id);
  const app = path.join(root, 'app');
  await writeApp(app, recordWith('single-agent'));
  await fs.mkdir(path.join(root, '.studio'), { recursive: true });
  await fs.writeFile(path.join(root, '.studio', 'project.json'), JSON.stringify({ title: '家電店(架空)' }));
  const store = new ProjectStore(home);
  assert.ok((await store.build(id)).ok);
  const designs = { records: new Map(), intentOf: () => null, boardOf: () => [] };
  const reviews = new ProjectReviews({ home, store, designs, modeOf: () => 'single' });
  await reviews.start(id, { origin: 'existing' });
  for (const item of REVIEW_ITEM_IDS) await reviews.approve(id, { item });
  const { review } = await reviews.build(id);
  const doc = JSON.parse(await fs.readFile(path.join(root, '.studio', 'reviews', review.id, 'architecture.json'), 'utf8'));
  assert.deepEqual(doc.fingerprint.items.data.files, [STUDIO_TOOLS]);
  assert.ok(doc.fingerprint.items.harness.files.includes(STUDIO_TOOLS));
  // 承認した棚にツールの名前が残る
  assert.deepEqual(doc.data.shelf.map((item) => item.tools), TOOL_NAMES.map((name) => [name]));
  assert.equal((await reviews.check(id)).ok, true);

  // 作る AI が同じ宣言を書き直す(消して同じ中身で書く)。止まらない
  const toolsFile = path.join(app, STUDIO_TOOLS);
  const same = await fs.readFile(toolsFile);
  await fs.rm(toolsFile);
  await fs.writeFile(toolsFile, same);
  assert.equal((await reviews.check(id)).ok, true);

  // 違う宣言(在庫の表を全部返すツール)を足す。今までどおり止まる
  const changed = JSON.parse(same.toString('utf8'));
  changed.tools.push({ name: 'list_stock', description: '在庫の表を全部返す(架空)', do: { op: 'search', data: 'data/design-table-1.json' } });
  await fs.writeFile(toolsFile, `${JSON.stringify(changed, null, 2)}\n`);
  const check = await reviews.check(id);
  assert.equal(check.ok, false);
  assert.equal(check.code, 'review-changed');
  assert.deepEqual(check.changed, ['harness', 'data']);
});
