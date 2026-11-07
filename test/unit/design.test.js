import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { compositionChoices, compositionOptions, cleanScenes, COMPOSITION_OPTIONS, desiredFiles, designRequest, fixedOptions, mergeAiOptions, missingScenes, REQUIRED_SCENES, SCENE_CATEGORIES, SCREENS, STEPS, withRequiredScenes } from '../../src/server/design.js';
import { DESIGN_SCHEMA, designOutputProblem } from '../../src/server/design-ai.js';
import { DATA_FILE } from '../../src/server/data-design.js';
import { readManifest } from '../../src/server/manifest.js';
import { readAiDefinition } from '../../src/server/product-ai/definition.js';
import { readSimulation } from '../../src/server/sim/composition.js';
import { parseEval } from '../../src/server/sim/evals.js';

// 設計の案内の部品(src/server/design.js、docs/design/user-journey.md の J2)。実モデルは呼ばない

const MATERIAL = { sentence: '商店街のお店への問い合わせに答えたい(架空)', doc: { who: 'お店の人', problem: '同じ問い合わせに何度も答える', scene: '閉店後', success: '電話が減る', notDoing: [], undecided: [] }, board: [] };

function recordWith(compositionChosen, { scenes } = {}) {
  const options = mergeAiOptions(fixedOptions(MATERIAL), null);
  const steps = {};
  for (const { id } of STEPS) {
    steps[id] = { options: options[id], chosen: options[id][0].id, text: null, note: '', decidedAt: null, stale: false };
  }
  steps.composition.chosen = compositionChosen;
  return { steps, scenes: scenes ?? options.scenes[0].scenes };
}

async function writeDesired(record) {
  const appDir = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-design-unit-'));
  await fs.writeFile(path.join(appDir, 'prototype.json'), JSON.stringify({ formatVersion: 1, title: '架空', entry: 'main.jsx' }));
  await fs.writeFile(path.join(appDir, 'main.jsx'), 'export {};\n');
  for (const [relative, content] of desiredFiles(record)) {
    const file = path.join(appDir, ...relative.split('/'));
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content);
  }
  return appDir;
}

async function contractOf(appDir) {
  const { manifest } = await readManifest(appDir);
  const { definition: ai } = await readAiDefinition(appDir, manifest.ai ?? undefined);
  return readSimulation(appDir, manifest, ai);
}

test('6 つの段が、問題、使う人、場面、データ、エージェントの構成、画面の順', () => {
  assert.deepEqual(STEPS.map((step) => step.label), ['問題', '使う人', '場面', 'データ', 'エージェントの構成', '画面']);
});

test('Studio の決まった案: どの段も案が 2〜3 あり、おすすめが 1 つで、理由がある', () => {
  const options = mergeAiOptions(fixedOptions(MATERIAL), null);
  for (const step of ['problem', 'users', 'scenes', 'data', 'screens']) {
    assert.ok(options[step].length >= 2 && options[step].length <= 3, step);
    assert.equal(options[step].filter((option) => option.recommended).length, 1, step);
    assert.ok(options[step].every((option) => option.reason), step);
  }
  assert.equal(options.composition.length, 3);
  assert.equal(options.composition.filter((option) => option.recommended).length, 1);
});

test('場面の案: どの案にも、分からない、断る、遅いが 1 つずつ以上ある', () => {
  for (const option of fixedOptions(MATERIAL).scenes) assert.deepEqual(missingScenes(option.scenes), [], option.title);
  assert.deepEqual(REQUIRED_SCENES, ['unknown', 'refuse', 'slow']);
});

test('場面の整え: 知らない種類と空の文を捨て、足りない種類を足す。上限でも 3 つは欠けない', () => {
  assert.deepEqual(cleanScenes([{ category: 'evil', text: 'a' }, { category: 'normal', text: '  ' }, { category: 'normal', text: 'よくある' }, { category: 'normal', text: 'よくある' }, 'x', null]), [{ category: 'normal', text: 'よくある' }]);
  const full = Array.from({ length: 12 }, (_, i) => ({ category: 'normal', text: `よくある ${i}` }));
  const filled = withRequiredScenes(cleanScenes(full));
  assert.equal(filled.length, 12);
  assert.deepEqual(missingScenes(filled), []);
});

test('AI の案: 形が足りない段と、「理想」「最適」を含む案は使わず、決まった案を出す', () => {
  const fixed = fixedOptions(MATERIAL);
  const merged = mergeAiOptions(fixed, {
    problem: { recommended: 1, options: [{ title: '案 1', detail: '中身', reason: '理由' }, { title: '案 2', detail: '中身', reason: '理由' }, { title: '案 3', detail: '中身', reason: '最適です' }] },
    users: { recommended: 0, options: [{ title: '理想の人', detail: '中身', reason: '理由' }, { title: '人 2', detail: '中身', reason: '理由' }] },
    scenes: { recommended: 9, options: [{ title: '組 1', reason: '理由', scenes: [] }, { title: '組 2', reason: '理由', scenes: [{ category: 'refuse', text: '断る文' }] }] },
    composition: { recommended: 'master-sub', reason: '難しい形' },
    screens: { recommended: 'nope', reason: 'x' },
  });
  assert.deepEqual(merged.problem.map((option) => option.title), ['案 1', '案 2']);
  assert.equal(merged.problem[1].recommended, true);
  // 残りが 1 つになった段は、決まった案のまま
  assert.equal(merged.users, fixed.users);
  // 足りない種類は Studio が足す。番号が範囲の外なら最初を勧める
  assert.deepEqual(missingScenes(merged.scenes[0].scenes), []);
  assert.equal(merged.scenes[0].recommended, true);
  // まだ動かない形は勧めない。簡単な方を勧める
  assert.equal(merged.composition.find((option) => option.recommended).id, 'fixed-flow');
  assert.equal(merged.screens.find((option) => option.recommended).id, SCREENS[0].id);
});

test('AI の案: 使わない言葉の案を捨てても、勧めた案を勧める。勧めた案を捨てたら最初の案', () => {
  const option = (title, reason = '理由') => ({ title, detail: '中身', reason });
  const merged = mergeAiOptions(fixedOptions(MATERIAL), {
    problem: { recommended: 1, options: [option('案 0', '最適です'), option('案 1'), option('案 2')] },
    users: { recommended: 0, options: [option('人 0', '最適です'), option('人 1'), option('人 2')] },
  });
  assert.equal(merged.problem.find((item) => item.recommended).title, '案 1');
  assert.equal(merged.users.find((item) => item.recommended).title, '人 1');
});

test('構成の選択肢: 簡単な方から順に 3 つ。マスターとサブはまだ選べず、理由がある。AI から AI への引き継ぎは選択肢にない', () => {
  assert.deepEqual(COMPOSITION_OPTIONS.map((option) => option.id), ['fixed-flow', 'single-agent', 'master-sub']);
  assert.deepEqual(COMPOSITION_OPTIONS.map((option) => option.order), [1, 2, 3]);
  const options = compositionOptions('single-agent', '理由');
  assert.equal(options.find((option) => option.recommended).id, 'single-agent');
  assert.equal(options.find((option) => option.id === 'master-sub').available, false);
  assert.ok(options.find((option) => option.id === 'master-sub').limitation);
  // AI の理由に使わない言葉があれば、Studio の文に代える
  assert.doesNotMatch(compositionOptions('single-agent', '最適です').find((option) => option.recommended).reason, /最適/);
});

test('この試作品で選べる構成の案: AI の設定が残ると単一エージェントは選べず、おすすめは固定の流れに移る', () => {
  const options = compositionOptions('single-agent', '理由');
  assert.equal(compositionChoices(options, {}), options);

  const kept = compositionChoices(options, { keptAi: true });
  assert.equal(kept.length, 3);
  assert.equal(kept.find((option) => option.id === 'single-agent').available, false);
  assert.ok(kept.find((option) => option.id === 'single-agent').limitation);
  assert.deepEqual(kept.filter((option) => option.recommended).map((option) => option.id), ['fixed-flow']);
  assert.ok(kept.find((option) => option.recommended).reason);

  // もともと固定の流れを勧めていれば、理由を変えない
  const fixedFirst = compositionOptions('fixed-flow', 'AI の理由');
  assert.equal(compositionChoices(fixedFirst, { keptAi: true }).find((option) => option.recommended).reason, 'AI の理由');

  // 今の構成があれば、「今の構成のまま」だけ
  const owner = compositionChoices(options, { owner: true, keptAi: true });
  assert.deepEqual(owner.filter((option) => option.available).map((option) => option.id), ['keep']);
  assert.deepEqual(owner.filter((option) => option.recommended).map((option) => option.id), ['keep']);
});

test('案を出す AI の形: 構成は動く 2 つの形だけ勧められる。ファイルの名前を書く項目がない', () => {
  assert.deepEqual(DESIGN_SCHEMA.properties.composition.properties.recommended.enum, ['fixed-flow', 'single-agent']);
  assert.doesNotMatch(JSON.stringify(DESIGN_SCHEMA), /"file"|"path"|"status"|decided/);
  assert.equal(designOutputProblem(null), 'JSON の出力がなかった');
  assert.match(designOutputProblem({ problem: '形が違う' }), /problem/);
});

for (const chosen of ['fixed-flow', 'single-agent']) {
  test(`関門 G3: 「${chosen}」を選んで書いたファイルが構成の検査を通り、場面の検査も通る`, async () => {
    const appDir = await writeDesired(recordWith(chosen));
    try {
      const { simulation, errors } = await contractOf(appDir);
      assert.deepEqual(errors, []);
      assert.equal(simulation.composition.file, 'composition.json');
      assert.equal(simulation.composition.participants[0].kind, chosen === 'fixed-flow' ? 'harness' : 'agent');
      assert.equal(simulation.composition.surface.theme, SCREENS[0].theme);
      assert.equal(simulation.evals.length, 5);
    } finally {
      await fs.rm(appDir, { recursive: true, force: true });
    }
  });
}

test('場面の下書き: どの種類も場面の検査を通り、種類の名前が about に入る。数や文に変な文字があっても JSON の値に閉じる', () => {
  const scenes = Object.keys(SCENE_CATEGORIES).map((category) => ({ category, text: `「../../etc/passwd」 {result.count} ${category} 12:00` }));
  const files = desiredFiles({ steps: { composition: { chosen: null }, screens: {} }, scenes });
  assert.equal(files.size, scenes.length);
  for (const [relative, content] of files) {
    assert.match(relative, /^evals\/design-[a-z]+-1\.json$/);
    const { scenario, errors } = parseEval(JSON.parse(content), { file: relative, toolNames: new Set() });
    assert.deepEqual(errors, []);
    assert.ok(Object.values(SCENE_CATEGORIES).some(({ label }) => scenario.about.startsWith(`${label}: `)));
  }
});

test('構成を選ぶ前は、場面のファイルと、データの段で選んだ案の架空のデータだけを書く', () => {
  const record = recordWith(null);
  assert.ok([...desiredFiles(record).keys()].every((name) => name.startsWith('evals/') || name === DATA_FILE));
  assert.ok(desiredFiles(record).has(DATA_FILE));
  assert.ok(![...desiredFiles(recordWith('keep')).keys()].some((name) => name === 'composition.json'));
});

test('依頼の文: 目的と設計が入り、長い文書でも上限に収まる。決まりの文は切れない', () => {
  const long = 'あ'.repeat(1000);
  const record = recordWith('fixed-flow');
  record.steps.problem.chosen = 'custom';
  record.steps.problem.text = long.slice(0, 300);
  for (const { id } of STEPS) record.steps[id].note = long.slice(0, 300);
  record.scenes = Array.from({ length: 12 }, (_, i) => ({ category: 'normal', text: `${long.slice(0, 190)}${i}` }));
  const text = designRequest({ doc: { who: long, problem: long, scene: long, success: long, notDoing: [long], undecided: [long] }, record });
  assert.ok(text.length <= 4000, `${text.length} 文字`);
  assert.match(text, /^この設計で試作品を作ってください。/);
  assert.match(text, /構成のファイルは Studio が書きました。変えないでください/);
  assert.match(text, /場面のファイルは evals の下に Studio が書きました。弱めないでください/);

  assert.doesNotMatch(text, /ai\.json/);

  const none = designRequest({ doc: null, record: recordWith('keep') });
  assert.match(none, /目的の文書は決めていません/);
  assert.match(none, /今の構成のまま/);

  // 単一エージェントでは、AI の設定を置かせない(置くと基本のシナリオで止まる)
  assert.match(designRequest({ doc: null, record: recordWith('single-agent') }), /AI の設定\(ai\.json\)は置かないでください/);
});
