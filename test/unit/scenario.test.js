import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ACTIONS, EXPECTS, baseScenarios, checkScenario, readScenarios } from '../../src/observer/scenario.js';

// シナリオの形と検査(docs/design/harness.md の 3.3、S4)
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const valid = () => ({
  name: '架空の相談で、話すと項目に出る',
  viewport: 'mobile',
  steps: [
    { do: 'read' },
    { do: 'inspect' },
    { do: 'inspect', target: { role: 'button', name: '送る' } },
    { do: 'type', target: { label: 'メッセージ' }, text: '架空の話題です' },
    { do: 'click', target: { role: 'button', name: '送る' } },
    { do: 'scroll', to: 'bottom' },
    { do: 'scroll', target: { region: '項目' } },
    { do: 'viewport', viewport: 'tablet' },
    { do: 'screenshot', name: '話した後' },
    { expect: 'text', target: { region: '項目' }, contains: '架空の話題' },
    { expect: 'text', contains: '架空' },
    { expect: 'visible', target: { text: '架空の話題' } },
    { expect: 'visible' },
    { expect: 'noErrors' },
    { expect: 'aiState', key: 'topic', equals: '架空の話題' },
    { expect: 'aiState', key: 'minutes', equals: 30 },
    { expect: 'aiState', key: 'level', equals: null },
  ],
});

const texts = (errors) => errors.map((error) => error.text);

test('7 つの操作と 4 つの確かめを、シナリオの手順に書ける', () => {
  assert.deepEqual(ACTIONS, ['read', 'inspect', 'click', 'type', 'scroll', 'viewport', 'screenshot']);
  assert.deepEqual(EXPECTS, ['text', 'visible', 'noErrors', 'aiState']);
  const { scenario, errors } = checkScenario(valid(), { file: 'app/scenarios/talk.json' });
  assert.deepEqual(errors, []);
  assert.deepEqual(scenario, valid());
  // 検査を通った写しは凍らせてあり、回す途中で変わらない
  assert.ok(Object.isFrozen(scenario) && Object.isFrozen(scenario.steps[2].target));
});

test('viewport を書かなければ desktop で回す', () => {
  const { scenario } = checkScenario({ name: '架空', steps: [{ expect: 'noErrors' }] });
  assert.equal(scenario.viewport, 'desktop');
});

test('知らない do と expect は、どのシナリオの何番目の手順かと、使えるものを返す', () => {
  const raw = { name: '架空の店', steps: [{ expect: 'noErrors' }, { do: 'hover', target: { text: '架空' } }, { expect: 'title', contains: '架空' }] };
  const { scenario, errors } = checkScenario(raw, { file: 'app/scenarios/shop.json' });
  assert.equal(scenario, null);
  assert.deepEqual(errors, [
    {
      file: 'app/scenarios/shop.json',
      scenario: '架空の店',
      step: 2,
      text: '2 番目の手順: 知らない do です: "hover"(使えるもの: read、inspect、click、type、scroll、viewport、screenshot)',
    },
    {
      file: 'app/scenarios/shop.json',
      scenario: '架空の店',
      step: 3,
      text: '3 番目の手順: 知らない expect です: "title"(使えるもの: text、visible、noErrors、aiState)',
    },
  ]);
});

test('対象がない手順と、対象の書き方の誤りを返す。CSS のセレクターは使えない', () => {
  const raw = {
    name: '架空',
    steps: [
      { do: 'click' },
      { do: 'type', text: '架空' },
      { expect: 'text', target: { selector: '#send' }, contains: '架空' },
      { do: 'click', target: { role: 'button', label: '送る' } },
      { do: 'click', target: { name: '送る' } },
      { do: 'click', target: { text: '' } },
      { do: 'click', target: '送る' },
    ],
  };
  assert.deepEqual(texts(checkScenario(raw).errors), [
    '1 番目の手順: do が click の手順には target が要ります(対象がありません)',
    '2 番目の手順: do が type の手順には target が要ります(対象がありません)',
    '3 番目の手順: CSS のセレクターは使えません。役割と名前、ラベル、文字、領域で指してください',
    '4 番目の手順: target には role、label、text、region のどれか 1 つを書いてください(今は role、label)',
    '5 番目の手順: target には role、label、text、region のどれか 1 つを書いてください(今は なし)',
    '6 番目の手順: target.text は空でない文字列で書いてください(今の値: "")',
    '7 番目の手順: target は { "role": …, "name": … }、{ "label": … }、{ "text": … }、{ "region": … } のどれかで書いてください',
  ]);
  // 対象の種類が 1 つでも、CSS のセレクターを足せば誤り
  assert.deepEqual(texts(checkScenario({ name: '架空', steps: [{ do: 'click', target: { text: '送る', css: 'button' } }] }).errors), [
    '1 番目の手順: CSS のセレクターは使えません。役割と名前、ラベル、文字、領域で指してください',
  ]);
});

test('viewport の値の誤りを、手順とシナリオ全体のどちらでも返す', () => {
  const raw = { name: '架空', viewport: 'phone', steps: [{ do: 'viewport', viewport: 'wide' }, { do: 'viewport' }] };
  assert.deepEqual(checkScenario(raw).errors.map((e) => [e.step, e.text]), [
    [null, 'viewport の値が違います: "phone"(mobile、tablet、desktop から選ぶ)'],
    [1, '1 番目の手順: viewport の値が違います: "wide"(mobile、tablet、desktop から選ぶ)'],
    [2, '2 番目の手順: do が viewport の手順には viewport が要ります'],
  ]);
});

test('手順に書けない項目、足りない項目、値の形の誤りを返す', () => {
  const raw = {
    name: '架空',
    steps: [
      { do: 'read', target: { text: '架空' } },
      { do: 'screenshot' },
      { expect: 'text', target: { text: '架空' } },
      { expect: 'aiState', key: 'topic', equals: { value: '架空' } },
      { expect: 'aiState', equals: 1 },
      { do: 'scroll', to: 'left' },
      { do: 'scroll', to: 'top', target: { text: '架空' } },
      { do: 'click', expect: 'visible', target: { text: '架空' } },
      { do: 'type', target: { label: '架空' }, text: 3 },
      'click',
    ],
  };
  assert.deepEqual(texts(checkScenario(raw).errors), [
    '1 番目の手順: do が read の手順に「target」は書けません',
    '2 番目の手順: do が screenshot の手順には name が要ります',
    '3 番目の手順: expect が text の手順には contains が要ります',
    '4 番目の手順: equals は文字列、数、null のどれかで書いてください(今の値: {"value":"架空"})',
    '5 番目の手順: expect が aiState の手順には key が要ります',
    '6 番目の手順: to の値が違います: "left"(top、bottom から選ぶ)',
    '7 番目の手順: scroll には target か to のどちらか 1 つを書いてください',
    '8 番目の手順: do(操作)か expect(確かめ)のどちらか 1 つを書いてください',
    '9 番目の手順: text は空でない文字列で書いてください(今の値: 3)',
    '10 番目の手順: { "do": … } か { "expect": … } のオブジェクトで書いてください',
  ]);
});

test('シナリオ全体の形の誤り(名前、手順の数、知らない項目)を返す', () => {
  assert.deepEqual(texts(checkScenario([]).errors), ['全体を { "name": …, "steps": […] } のオブジェクトで書いてください']);
  assert.deepEqual(texts(checkScenario({ steps: [], selector: 'main' }).errors), [
    '「selector」は使えない項目です。使える項目: name、viewport、steps',
    'name は空でない文字列で書いてください(今の値: undefined)',
    'steps は 1 個から 50 個までの手順の配列で書いてください',
  ]);
  const tooMany = { name: '架空', steps: Array.from({ length: 51 }, () => ({ expect: 'noErrors' })) };
  assert.deepEqual(texts(checkScenario(tooMany).errors), ['steps は 1 個から 50 個までの手順の配列で書いてください']);
});

test('app/scenarios/*.json を名前の順に読み、読めないファイルと形の誤りをファイルごとに返す', async (t) => {
  const appDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prototype-studio-scenario-'));
  t.after(() => fs.rm(appDir, { recursive: true, force: true }));
  // フォルダーがなければ、シナリオはない(誤りにしない)
  assert.deepEqual(await readScenarios(appDir), { scenarios: [], errors: [] });

  const dir = path.join(appDir, 'checks');
  await fs.mkdir(dir);
  await fs.writeFile(path.join(dir, 'b.json'), JSON.stringify({ name: '架空の 2 本目', steps: [{ expect: 'noErrors' }] }));
  await fs.writeFile(path.join(dir, 'a.json'), JSON.stringify({ name: '架空の 1 本目', steps: [{ do: 'read' }] }));
  await fs.writeFile(path.join(dir, 'broken.json'), '{ "name": ');
  await fs.writeFile(path.join(dir, 'wrong.json'), JSON.stringify({ name: '架空の誤り', steps: [{ do: 'click' }] }));
  await fs.writeFile(path.join(dir, 'notes.txt'), 'シナリオではない');

  const { scenarios, errors } = await readScenarios(appDir, 'checks');
  assert.deepEqual(
    scenarios.map((s) => [s.file, s.scenario.name]),
    [
      ['app/checks/a.json', '架空の 1 本目'],
      ['app/checks/b.json', '架空の 2 本目'],
    ],
  );
  assert.deepEqual(
    errors.map((e) => [e.file, e.scenario, e.step]),
    [
      ['app/checks/broken.json', null, null],
      ['app/checks/wrong.json', '架空の誤り', 1],
    ],
  );
  assert.match(errors[0].text, /^JSON として読めません/);
  assert.equal(errors[1].text, '1 番目の手順: do が click の手順には target が要ります(対象がありません)');
});

test('見本の求人相談と学習相談のシナリオは、形の検査を通る', async () => {
  for (const sample of ['job-consult', 'study-consult']) {
    const { scenarios, errors } = await readScenarios(path.join(ROOT, 'samples', sample, 'app'));
    assert.deepEqual(errors, []);
    assert.equal(scenarios.length, 1, sample);
  }
});

test('基本のシナリオは app/ の外(Studio のコード)にあり、作る AI は変えられない', async (t) => {
  // 起動して描画が空でない、エラーがない。AI のある試作品では、あいさつが出る
  const plain = baseScenarios();
  assert.deepEqual(plain, [{ name: '起動して描画が空でなく、エラーがない', viewport: 'desktop', steps: [{ expect: 'visible' }, { expect: 'noErrors' }] }]);
  const withAi = baseScenarios({ greeting: '架空の案内役です。ご用件をどうぞ。' });
  assert.deepEqual(withAi[1], { name: 'プロダクト内 AI のあいさつが出る', viewport: 'desktop', steps: [{ expect: 'text', contains: '架空の案内役です。ご用件をどうぞ。' }] });
  for (const scenario of withAi) assert.deepEqual(checkScenario(scenario).errors, []);

  // 基本のシナリオは Studio のコードの中。作る AI が書ける唯一の場所(各プロジェクトの app/)ではない
  const source = path.join(ROOT, 'src', 'observer', 'scenario.js');
  assert.ok(!source.split(path.sep).includes('app'));
  assert.match(await fs.readFile(source, 'utf8'), /export function baseScenarios/);

  // 凍らせてあり、書き換えられない。呼ぶたびに新しく作る
  assert.throws(() => {
    plain[0].steps.push({ expect: 'text', contains: '架空' });
  }, TypeError);
  assert.throws(() => {
    plain[0].steps[1].expect = 'visible';
  }, TypeError);
  assert.notEqual(baseScenarios()[0], plain[0]);

  // app/scenarios/ に同じ名前のシナリオを置いても、app/ のシナリオとして読むだけで、基本のシナリオは変わらない
  const appDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prototype-studio-scenario-'));
  t.after(() => fs.rm(appDir, { recursive: true, force: true }));
  await fs.mkdir(path.join(appDir, 'scenarios'));
  await fs.writeFile(path.join(appDir, 'scenarios', 'base.json'), JSON.stringify({ name: plain[0].name, steps: [{ do: 'read' }] }));
  const { scenarios } = await readScenarios(appDir);
  assert.deepEqual(scenarios.map((s) => s.file), ['app/scenarios/base.json']);
  assert.deepEqual(baseScenarios(), plain);
});
