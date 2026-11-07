import assert from 'node:assert/strict';
import test from 'node:test';
import { aiDataOptions, dataCoverage, dataDesignProblems, dataRequestLines, DATA_FILE, fixedDataOptions, KEY_FIELD, MAX_DATA_REQUEST, NOTE_ENTITY, reshapeDataOption, SAMPLE_ROWS, sampleData, shapeDataOption } from '../../src/server/data-design.js';
import { desiredFiles, designRequest, fixedOptions, mergeAiOptions, STEPS } from '../../src/server/design.js';
import { DESIGN_SCHEMA } from '../../src/server/design-ai.js';
import { findRecords } from '../../src/server/redact.js';

// データ設計の形(src/server/data-design.js、docs/design/user-journey.md の K2)。実モデルは呼ばない。題材はすべて架空

const BOARD = [
  { id: 'i1', column: 'data', text: '荷物の番号と状態' },
  { id: 'i2', column: 'data', text: '再配達の希望の日と時間帯' },
  { id: 'i3', column: 'data', text: '問い合わせの記録' },
  { id: 'i4', column: 'user', text: '荷物を受け取る人(架空)' },
  { id: 'i5', column: 'rule', text: '17 時までの依頼は翌日' },
];
const dataIds = BOARD.filter((item) => item.column === 'data').map((item) => item.id);

const covered = (option) => dataCoverage(option, BOARD).every((item) => item.where.length > 0);

test('形の検査: つながりの先がないと問題になる', () => {
  const option = shapeDataOption({ title: '架空', entities: [{ name: '荷物', fields: [{ name: '状態', kind: 'text' }] }], links: [] }, []);
  assert.deepEqual(dataDesignProblems(option), []);
  const broken = structuredClone(option);
  broken.links.push({ from: '荷物', to: 'ない表', label: 'つながる' });
  assert.ok(dataDesignProblems(broken).some((problem) => problem.includes('つながりの先「ない表」がありません')));
  const dangling = structuredClone(option);
  dangling.entities[0].fields.push({ name: 'お届け先の番号', kind: 'link', to: 'お届け先', examples: [], sources: [] });
  assert.ok(dataDesignProblems(dangling).some((problem) => problem.includes('つながりの先「お届け先」がありません')));
});

test('形の検査: 項目の名前が重なると問題になる。覚えておくものの名前と主キーも同じ', () => {
  const option = shapeDataOption({ title: '架空', entities: [{ name: '荷物', fields: [{ name: '状態', kind: 'text' }] }], links: [] }, []);
  const twice = structuredClone(option);
  twice.entities[0].fields.push({ name: '状態', kind: 'text', examples: [], sources: [] });
  assert.ok(dataDesignProblems(twice).some((problem) => problem.includes('項目「状態」が重なっています')));
  const sameEntity = structuredClone(option);
  sameEntity.entities.push(structuredClone(option.entities[0]));
  assert.ok(dataDesignProblems(sameEntity).some((problem) => problem.includes('覚えておくもの「荷物」が重なっています')));
  const noKey = structuredClone(option);
  noKey.entities[0].fields = noKey.entities[0].fields.filter((field) => field.kind !== 'key');
  assert.ok(dataDesignProblems(noKey).some((problem) => problem.includes('主キー')));
});

test('形を整える: 先のないつながり、自分へのつながり、重なる名前、番号と同じ名前を捨て、つながりの番号を Studio が付ける', () => {
  const option = shapeDataOption({
    title: '架空の案',
    entities: [
      { name: 'お届け先', fields: [{ name: '地区', kind: 'text' }, { name: '地区', kind: 'text' }, { name: KEY_FIELD, kind: 'number' }] },
      { name: '荷物', fields: [{ name: '状態', kind: 'choice', examples: ['持ち戻り', '配達中'] }, { name: '中身', kind: '知らない種類' }] },
      { name: '荷物', fields: [] },
    ],
    links: [
      { from: 'お届け先', to: '荷物', label: '受け取る' },
      { from: 'お届け先', to: '荷物', label: '重なり' },
      { from: '荷物', to: 'ない表', label: '先がない' },
      { from: '荷物', to: '荷物', label: '自分' },
    ],
  }, []);
  assert.deepEqual(dataDesignProblems(option), []);
  assert.deepEqual(option.entities.map((entity) => entity.name), ['お届け先', '荷物']);
  assert.deepEqual(option.entities[0].fields.map((field) => [field.name, field.kind]), [[KEY_FIELD, 'key'], ['地区', 'text']]);
  assert.deepEqual(option.entities[1].fields.map((field) => [field.name, field.kind]), [[KEY_FIELD, 'key'], ['お届け先の番号', 'link'], ['状態', 'choice'], ['中身', 'text']]);
  assert.deepEqual(option.links, [{ from: 'お届け先', to: '荷物', label: '受け取る' }]);
});

test('形を整える: 案に載っていない整理の板のデータの欄は、Studio が「聞いたことのメモ」に足す。記録らしい例は捨てる', () => {
  const option = shapeDataOption({
    title: '架空の案',
    entities: [{ name: '荷物', sources: ['i1'], fields: [{ name: '受け取る人', kind: 'text', examples: ['みほん 花子', '090-1234-5678', 'taro@example.com'], sources: ['i2', 'i99'] }] }],
    links: [],
  }, BOARD);
  assert.deepEqual(dataDesignProblems(option), []);
  assert.ok(covered(option));
  assert.deepEqual(option.added, ['i3']);
  const note = option.entities.find((entity) => entity.name === NOTE_ENTITY);
  assert.equal(note.by, 'studio');
  assert.deepEqual(note.fields.map((field) => field.name), [KEY_FIELD, '問い合わせの記録']);
  // 知らない元(i99)は捨てる
  assert.deepEqual(option.entities[0].fields[1].sources, ['i2']);
  assert.deepEqual(option.entities[0].fields[1].examples, ['みほん 花子']);
});

test('Studio の決まった案: 2〜3 あり、どれも形が正しく、整理の板のデータの欄が全部載る', () => {
  for (const board of [BOARD, BOARD.filter((item) => item.column !== 'user'), []]) {
    const options = fixedDataOptions(board);
    assert.ok(options.length >= 2 && options.length <= 3, String(board.length));
    for (const option of options) {
      assert.deepEqual(dataDesignProblems(option), [], option.title);
      assert.ok(option.reason, option.title);
      assert.ok(dataCoverage(option, board).every((item) => item.where.length > 0), option.title);
      assert.deepEqual(option.added, [], option.title);
    }
  }
  // 欄の文が長くても重なっても、項目の名前は重ならない
  const long = [{ id: 'i1', column: 'data', text: 'あ'.repeat(50) }, { id: 'i2', column: 'data', text: `${'あ'.repeat(50)}い` }];
  for (const option of fixedDataOptions(long)) assert.deepEqual(dataDesignProblems(option), [], option.title);
});

test('AI の案: 使える案が 2 つそろわなければ決まった案に戻る。使わない言葉の案は捨てる', () => {
  const good = (title) => ({ title, detail: '架空', reason: '架空', entities: [{ name: '荷物', about: '', writer: '', sources: dataIds, fields: [] }], links: [] });
  assert.equal(aiDataOptions({ options: [good('案 1')], recommended: 0 }, BOARD), null);
  assert.equal(aiDataOptions({ options: [good('案 1'), good('理想の案')], recommended: 0 }, BOARD), null);
  assert.equal(aiDataOptions({ options: [good('案 1'), { title: '', entities: [] }], recommended: 0 }, BOARD), null);
  const shaped = aiDataOptions({ options: [good('案 1'), good('案 2')], recommended: 1 }, BOARD);
  assert.equal(shaped.options.length, 2);
  assert.equal(shaped.recommended, 1);
  assert.equal(aiDataOptions(null, BOARD), null);
});

test('合わせる: データの段は AI の案か決まった案。決まった案はおすすめが 1 つ', () => {
  const material = { sentence: '架空', doc: null, board: BOARD };
  const fixed = fixedOptions(material);
  const merged = mergeAiOptions(fixed, null, 1, BOARD);
  assert.equal(merged.data, fixed.data);
  assert.equal(merged.data.filter((option) => option.recommended).length, 1);
  assert.ok(STEPS.some((step) => step.id === 'data'));
  assert.ok(DESIGN_SCHEMA.required.includes('data'));
});

test('架空のデータ: 表ごとに決まった行数で、主キーは重ならず、つながりの番号は元の番号を指す。記録らしい値はない', () => {
  const option = shapeDataOption({
    title: '架空の案',
    entities: [
      { name: 'お届け先', fields: [{ name: '地区', kind: 'text', examples: ['みほん区'] }] },
      { name: '荷物', fields: [{ name: '届ける日', kind: 'date' }, { name: '重さ', kind: 'number', examples: ['2', 'たくさん'] }, { name: '状態', kind: 'choice' }] },
    ],
    links: [{ from: 'お届け先', to: '荷物', label: '受け取る' }],
  }, BOARD);
  const data = sampleData(option);
  assert.equal(data.tables.length, option.entities.length);
  for (const table of data.tables) {
    assert.equal(table.rows.length, SAMPLE_ROWS);
    const keys = table.rows.map((row) => row[KEY_FIELD]);
    assert.equal(new Set(keys).size, keys.length);
    for (const row of table.rows) for (const value of Object.values(row)) assert.deepEqual(findRecords(String(value)), [], String(value));
  }
  const owners = new Set(data.tables[0].rows.map((row) => row[KEY_FIELD]));
  const parcels = data.tables[1];
  assert.ok(parcels.rows.every((row) => owners.has(row['お届け先の番号'])));
  assert.equal(parcels.rows[0]['重さ'], 2);
  assert.deepEqual(data.links, [{ from: 'お届け先', to: '荷物', label: '受け取る', field: 'お届け先の番号' }]);
  // Studio のメモにも行がある(整理の板の欄の名前で)
  assert.ok(data.tables.at(-1).columns.includes('問い合わせの記録'));
});

test('選んだ案の架空のデータを書き、依頼にデータ設計が入る。選んでいなければ書かない', () => {
  const material = { sentence: '架空', doc: null, board: BOARD };
  const options = mergeAiOptions(fixedOptions(material), null, 1, BOARD);
  const steps = {};
  for (const { id } of STEPS) steps[id] = { options: options[id], chosen: options[id][0].id, text: null, note: '', decidedAt: null, stale: false };
  steps.composition.chosen = 'fixed-flow';
  const record = { steps, scenes: options.scenes[0].scenes };
  const files = desiredFiles(record);
  const written = JSON.parse(files.get(DATA_FILE));
  assert.deepEqual(written.tables.map((table) => table.name), options.data[0].entities.map((entity) => entity.name));
  const request = designRequest({ doc: null, record });
  assert.match(request, /\[データ設計\]/);
  assert.ok(request.includes(DATA_FILE));
  for (const line of dataRequestLines(options.data[0])) assert.ok(request.includes(line.slice(0, 40)), line);
  // データの段より後ろに場面が来る(上限で切れても、データ設計は残る)
  assert.ok(request.indexOf('[データ設計]') < request.indexOf('[場面の一覧]'));

  const unchosen = { ...record, steps: { ...steps, data: { ...steps.data, chosen: null } } };
  assert.equal(desiredFiles(unchosen).has(DATA_FILE), false);
  assert.doesNotMatch(designRequest({ doc: null, record: unchosen }), /\[データ設計\]/);
});

test('記録らしい整理の板の欄は、名前にも架空のデータにも入れない。それでも、どこかに載る', () => {
  const board = [{ id: 'i1', column: 'data', text: '架空の注文' }, { id: 'i2', column: 'data', text: '連絡は 090-1234-5678 まで' }];
  const options = [...fixedDataOptions(board), shapeDataOption({ title: '架空', entities: [{ name: '注文', sources: ['i1'], fields: [] }], links: [] }, board)];
  for (const option of options) {
    assert.deepEqual(dataDesignProblems(option), [], option.title);
    assert.ok(dataCoverage(option, board).every((item) => item.where.length > 0), option.title);
    const text = JSON.stringify({ option: { ...option, coverage: undefined }, data: sampleData(option) });
    assert.equal(text.includes('090'), false, option.title);
  }
});

test('長い名前でも、つながりの番号の名前と、架空のデータのつながりの印が合う', () => {
  const long = 'あ'.repeat(30);
  const option = shapeDataOption({ title: '架空', entities: [{ name: long, fields: [] }, { name: '荷物', fields: [] }], links: [{ from: long, to: '荷物', label: '持つ' }] }, []);
  assert.deepEqual(dataDesignProblems(option), []);
  const data = sampleData(option);
  const field = data.links[0].field;
  assert.ok(data.tables[1].columns.includes(field));
  assert.ok(data.tables[1].rows.every((row) => row[field] >= 1001 && row[field] <= 1003));
});

test('作り直すときの整え直し: 板が同じなら変わらない。板に足した欄は、前に選んだ案にも載る', () => {
  for (const option of [...fixedDataOptions(BOARD), shapeDataOption({ title: '架空', entities: [{ name: '荷物', sources: ['i1'], fields: [{ name: '状態', kind: 'choice', examples: ['持ち戻り'] }] }, { name: 'お届け先', fields: [] }], links: [{ from: 'お届け先', to: '荷物', label: '受け取る' }] }, BOARD)]) {
    const chosen = { ...option, id: 'o1-1', recommended: true };
    assert.deepEqual(reshapeDataOption(chosen, BOARD), chosen, option.title);
    const more = [...BOARD, { id: 'i9', column: 'data', text: '架空の後から聞いたこと' }];
    const again = reshapeDataOption(chosen, more);
    assert.equal(again.id, 'o1-1');
    assert.deepEqual(dataDesignProblems(again), [], option.title);
    assert.ok(dataCoverage(again, more).every((item) => item.where.length > 0), option.title);
  }
});

test('依頼のデータ設計は上限で切る。Studio が書けなかったときは、書いたと言わない', () => {
  const entities = Array.from({ length: 8 }, (_, n) => ({ name: `架空の表 ${n} ${'あ'.repeat(20)}`, fields: Array.from({ length: 11 }, (__, m) => ({ name: `項目 ${m} ${'い'.repeat(20)}`, kind: 'text' })) }));
  const option = shapeDataOption({ title: '架空', entities, links: entities.slice(1).map((entity) => ({ from: entities[0].name, to: entity.name, label: 'つながる' })) }, []);
  const lines = dataRequestLines(option);
  assert.ok(lines.join('\n').length <= MAX_DATA_REQUEST + 100);
  assert.match(lines.at(-1), /ほか \d+ 行/);
  assert.doesNotMatch(dataRequestLines(option, { written: false }).join('\n'), /Studio が書きました/);
});
