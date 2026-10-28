import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildApp } from '../../src/server/build.js';
import { STUDIO_ROOT } from '../../src/server/config.js';
import { createClaudeCodeConnection } from '../../src/server/product-ai/claude-code.js';
import { DEFAULT_RULES, describeDefinitionChanges, parseAiDefinition } from '../../src/server/product-ai/definition.js';
import { CALL_LIMITS, ProjectCallWindow, createTurnMeter } from '../../src/server/product-ai/limits.js';
import { createMockConnection, extractUpdates, mockExtract } from '../../src/server/product-ai/mock.js';
import { AiSessions, SESSION_LIMITS } from '../../src/server/product-ai/session.js';

// 求人ではない題材(架空の旅行の相談)。共通の部分が題材に依存しないことを確かめる
const TRAVEL = {
  name: '旅の相談(架空)',
  fields: [
    {
      key: 'place',
      label: '行き先',
      question: 'どこへ行きたいですか?',
      options: [
        { value: '湖の町', keywords: ['湖'] },
        { value: '山の村', keywords: ['山'] },
      ],
    },
    { key: 'nights', label: '泊数', type: 'number', unit: '泊', min: 1, max: 14 },
  ],
  initialState: { nights: 1 },
  mock: { greeting: 'ようこそ。', complete: '{summary}で考えます。' },
};

function travel() {
  const { definition, errors } = parseAiDefinition(JSON.stringify(TRAVEL));
  assert.deepEqual(errors, []);
  return definition;
}

test('AI の設定を読み、省いたところには題材に依存しない既定を入れる', () => {
  const definition = travel();
  assert.equal(definition.fields[1].question, '泊数を教えてください。');
  assert.equal(definition.fields[0].type, 'choice');
  assert.deepEqual(definition.initialState, { place: null, nights: 1 });
  assert.equal(definition.mock.understood, '{changes}と理解しました。');
});

test('AI の設定の誤りは、どこが悪いかを利用者向けの文で返す', () => {
  const cases = [
    ['{', /JSON として読めません/],
    ['[]', /オブジェクトで書いてください/],
    [JSON.stringify({ name: 'x', fields: [] }), /^fields: /],
    [JSON.stringify({ ...TRAVEL, extra: 1 }), /「extra」は使えない項目です/],
    [JSON.stringify({ ...TRAVEL, fields: [{ ...TRAVEL.fields[0], key: '1bad' }] }), /fields\[0\]\.key/],
    [JSON.stringify({ ...TRAVEL, fields: [TRAVEL.fields[0], TRAVEL.fields[0]] }), /「place」が重なっています/],
    [JSON.stringify({ ...TRAVEL, fields: [{ ...TRAVEL.fields[0], type: 'text' }] }), /"choice" か "number"/],
    [JSON.stringify({ ...TRAVEL, initialState: { nights: 99 } }), /initialState\.nights: 項目の決まりに合わない値/],
    [JSON.stringify({ ...TRAVEL, initialState: { color: 'red' } }), /initialState\.color: fields にない項目/],
    [JSON.stringify({ ...TRAVEL, mock: { hello: 'x' } }), /mock: 「hello」は使えない項目です/],
  ];
  for (const [source, pattern] of cases) {
    const { definition, errors } = parseAiDefinition(source);
    assert.equal(definition, null, source);
    assert.ok(errors.length > 0, source);
    assert.equal(errors[0].file, 'app/ai.json');
    assert.ok(errors.some((e) => pattern.test(e.text)), `${source}\n${JSON.stringify(errors)}`);
  }
});

test('モックは言葉から値を読み取る(全角、言い直し、単位つきの数)', () => {
  const definition = travel();
  assert.deepEqual(extractUpdates(definition, '湖のそばで２泊したい'), { place: '湖の町', nights: 2 });
  // 後から言った方を採る
  assert.deepEqual(extractUpdates(definition, '湖もいいけど、やっぱり山がいい'), { place: '山の村' });
  // 決まりの範囲の外の数は採らない
  assert.deepEqual(extractUpdates(definition, '30泊したい'), {});
  assert.deepEqual(extractUpdates(definition, '2泊じゃなくて3泊'), { nights: 3 });
  assert.deepEqual(extractUpdates(definition, '20泊じゃなくて5泊'), { nights: 5 });
  assert.deepEqual(extractUpdates(definition, 'こんにちは'), {});
});

test('モックは同じ入力にいつも同じ応答を返し、本人の修正を次の応答に入れる', async () => {
  const definition = travel();
  const run = async () => {
    const sessions = new AiSessions({ definitionOf: () => definition });
    const replies = [sessions.view('p').messages[0].text];
    replies.push((await sessions.send('p', '湖に行きたい')).messages.at(-1).text);
    sessions.correct('p', { place: '山の村' });
    replies.push((await sessions.send('p', 'よろしく')).messages.at(-1).text);
    return replies;
  };
  const first = await run();
  assert.deepEqual(first, [
    'ようこそ。',
    '行き先「湖の町」と理解しました。行き先「湖の町」、泊数「1泊」で考えます。',
    '直していただいた行き先「山の村」で進めます。行き先「山の村」、泊数「1泊」で考えます。',
  ]);
  assert.deepEqual(await run(), first);
});

test('会話は、修正の記録を含めて残り、リセットで設定の初期状態に戻る', async () => {
  const sessions = new AiSessions({ definitionOf: () => travel() });
  await sessions.send('p', '山で3泊');
  const corrected = sessions.correct('p', { nights: '5', place: null });
  assert.deepEqual(corrected.state, { place: null, nights: 5 });
  assert.deepEqual(
    corrected.messages.map((m) => m.role),
    ['assistant', 'user', 'assistant', 'correction'],
  );
  assert.equal(corrected.messages[3].text, '泊数を「5泊」に直しました。行き先を未定に戻しました。');
  assert.deepEqual(corrected.messages[3].changes, [
    { key: 'nights', label: '泊数', from: 3, to: 5 },
    { key: 'place', label: '行き先', from: '山の村', to: null },
  ]);
  // 変わらない修正は記録しない
  assert.equal(sessions.correct('p', { nights: 5 }).messages.length, 4);

  const reset = sessions.reset('p');
  assert.deepEqual(reset.state, { place: null, nights: 1 });
  assert.deepEqual(reset.messages, [{ role: 'assistant', text: 'ようこそ。' }]);
  assert.equal(reset.connection.kind, 'mock');
  assert.match(reset.connection.description, /実際の AI モデルは呼びません/);
});

test('決まりに合わない入力と、接続が返した決まりに合わない値は、状態に入れない', async () => {
  const definition = travel();
  const connection = {
    ...createMockConnection(),
    async respond() {
      return { reply: 'はい', updates: { place: '海の町', nights: 3, unknown: 'x' } };
    },
  };
  const sessions = new AiSessions({ definitionOf: () => definition, connections: [connection] });
  const view = await sessions.send('p', 'どこでも');
  assert.deepEqual(view.state, { place: null, nights: 3 });

  const codes = async (fn) => {
    try {
      await fn();
    } catch (error) {
      return error.code;
    }
    return 'ok';
  };
  assert.equal(await codes(() => sessions.send('p', '  ')), 'invalid');
  assert.equal(await codes(() => sessions.send('p', 'あ'.repeat(SESSION_LIMITS.maxTextLength + 1))), 'invalid');
  assert.equal(await codes(() => sessions.correct('p', { place: '海の町' })), 'invalid');
  assert.equal(await codes(() => sessions.correct('p', { color: 'red' })), 'invalid');
  for (const value of ['0x5', '1e1', '3泊', NaN, Infinity, true]) {
    assert.equal(await codes(() => sessions.correct('p', { nights: value })), 'invalid', String(value));
  }
  assert.equal(sessions.correct('p', { nights: '４' }).state.nights, 4);
  assert.equal(await codes(() => sessions.correct('p', [])), 'invalid');
  assert.equal(await codes(() => new AiSessions({ definitionOf: () => null }).view('p')), 'no-ai');
});

test('応答を待つ間は次の発言を断り、リセットされたら届いた応答を捨てる', async () => {
  let release;
  const connection = {
    ...createMockConnection(),
    respond: () => new Promise((resolve) => (release = () => resolve({ reply: '遅い応答', updates: { nights: 2 } }))),
  };
  const sessions = new AiSessions({ definitionOf: () => travel(), connections: [connection] });
  const first = sessions.send('p', '湖');
  await assert.rejects(sessions.send('p', '山'), { code: 'busy' });
  assert.throws(() => sessions.correct('p', { nights: 3 }), { code: 'busy' });
  sessions.reset('p');
  release();
  await assert.rejects(first, { code: 'reset' });
  assert.deepEqual(sessions.view('p').messages, [{ role: 'assistant', text: 'ようこそ。' }]);
});

test('版から戻した会話は、応答した接続と時間と費用を残し、決まりに合わなければ初期状態から始める', async () => {
  const sessions = new AiSessions({ definitionOf: () => travel() });
  await sessions.send('p', '湖');
  const snapshot = sessions.snapshot('p');
  snapshot.messages[2].costUsd = 0.01;
  sessions.reset('p');
  assert.equal(sessions.restore('p', JSON.parse(JSON.stringify(snapshot))), true);
  assert.deepEqual(sessions.snapshot('p'), snapshot);
  assert.equal(sessions.view('p').messages.at(-1).via, 'mock');

  for (const bad of [{ via: 'Bad Kind!' }, { via: 1 }, { elapsedMs: -1 }, { costUsd: 'x' }]) {
    const broken = structuredClone(snapshot);
    Object.assign(broken.messages[2], bad);
    assert.equal(sessions.restore('p', broken), false);
    assert.equal(sessions.view('p').messages.length, 1);
  }
});

test('版を戻すと、応答を待っている実行を止める', async () => {
  let signal;
  const connection = {
    ...createMockConnection(),
    respond: (input) => new Promise((resolve, reject) => {
      signal = input.signal;
      signal.addEventListener('abort', () => reject(new Error('止めた')));
    }),
  };
  const sessions = new AiSessions({ definitionOf: () => travel(), connections: [connection] });
  const pending = sessions.send('p', '湖');
  sessions.restore('p', null);
  assert.equal(signal.aborted, true);
  await assert.rejects(pending, { code: 'reset' });
});

test('接続が失敗したら、会話を変えずに理由を返す', async () => {
  const connection = { ...createMockConnection(), respond: async () => Promise.reject(new Error('つながらない')) };
  const sessions = new AiSessions({ definitionOf: () => travel(), connections: [connection] });
  await assert.rejects(sessions.send('p', '湖'), { code: 'connection', message: /つながらない/ });
  assert.equal(sessions.view('p').messages.length, 1);
});

test('会話が長くなりすぎたら、リセットを促す', async () => {
  const sessions = new AiSessions({ definitionOf: () => travel() });
  // あいさつの 1 件と、1 往復で 2 件
  for (let i = 0; i < (SESSION_LIMITS.maxMessages - 2) / 2; i += 1) await sessions.send('p', '湖');
  await assert.rejects(sessions.send('p', '湖'), { code: 'too-long', message: /会話を最初から/ });
});

test('ビルドは AI の設定を検査し、誤りがあれば失敗として知らせる', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-ai-build-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const buildsDir = path.join(dir, 'builds');

  const sample = await buildApp({ appDir: path.join(STUDIO_ROOT, 'samples', 'job-consult', 'app'), buildsDir });
  assert.equal(sample.ok, true, JSON.stringify(sample.errors));
  assert.deepEqual(
    sample.ai.fields.map((f) => f.label),
    ['職種', '雇用区分', '勤務地', '時給の下限'],
  );

  const library = await buildApp({ appDir: path.join(STUDIO_ROOT, 'samples', 'library', 'app'), buildsDir });
  assert.equal(library.ai, null);

  const appDir = path.join(dir, 'app');
  await fs.mkdir(appDir);
  await fs.writeFile(path.join(appDir, 'main.js'), 'console.log(1);\n');
  await fs.writeFile(path.join(appDir, 'ai.json'), '{"name": "x"}');
  const broken = await buildApp({ appDir, buildsDir });
  assert.equal(broken.ok, false);
  assert.equal(broken.errors[0].file, 'app/ai.json');
  assert.match(broken.errors[0].text, /fields/);
});

function parse(raw) {
  const { definition, errors } = parseAiDefinition(JSON.stringify(raw));
  assert.deepEqual(errors, []);
  return definition;
}

test('設定の前後を比べ、振る舞いの変わったところを利用者向けの文で返す', () => {
  const before = travel();
  assert.deepEqual(describeDefinitionChanges(before, travel()), []);
  const after = parse({
    ...TRAVEL,
    instructions: '追加の指示',
    fields: [TRAVEL.fields[1], { ...TRAVEL.fields[0], question: 'どちらへ?' }],
    mock: { ...TRAVEL.mock, notUnderstood: 'もう一度お願いします。' },
  });
  assert.deepEqual(describeDefinitionChanges(before, after), [
    '実モデルへの指示(instructions)を書き換えました(0 文字 → 5 文字)',
    '聞く順と項目の並び: 行き先、泊数 → 泊数、行き先',
    '行き先を聞く文: 「どこへ行きたいですか?」 → 「どちらへ?」',
    'モックの読み取れなかったときの返事: 「すみません、条件として読み取れませんでした。」 → 「もう一度お願いします。」',
  ]);
  const fewer = parse({ ...TRAVEL, fields: [TRAVEL.fields[0]], initialState: {} });
  assert.deepEqual(describeDefinitionChanges(before, fewer), ['なくした項目: 泊数']);
  assert.deepEqual(describeDefinitionChanges(before, parse({ ...TRAVEL, initialState: { nights: 2 } })), ['項目の最初の値を変えました']);
  assert.match(describeDefinitionChanges(null, before)[0], /設定ができました/);
  // 足した項目を前に入れると、聞く順も変わる
  const budget = { key: 'budget', label: '予算', type: 'number', unit: '円', min: 1 };
  assert.deepEqual(describeDefinitionChanges(before, parse({ ...TRAVEL, fields: [budget, ...TRAVEL.fields] })), [
    '足した項目: 予算',
    '聞く順と項目の並び: 行き先、泊数 → 予算、行き先、泊数',
  ]);
  assert.deepEqual(describeDefinitionChanges(before, parse({ ...TRAVEL, fields: [...TRAVEL.fields, budget] })), ['足した項目: 予算']);
});

// 版 2 の設定(架空の旅行の相談)。聞く段と確かめの段を持つ
const TRAVEL_V2 = {
  ...TRAVEL,
  formatVersion: 2,
  fields: [{ ...TRAVEL.fields[0], required: true }, { ...TRAVEL.fields[1], required: false }],
  flow: {
    steps: [
      { id: 'hear', ask: ['place', 'nights'], next: [{ when: { filled: 'required' }, to: 'confirm' }] },
      {
        id: 'confirm',
        say: 'summary',
        next: [
          { when: { intent: 'yes' }, to: 'done' },
          { when: { intent: 'no' }, to: 'hear' },
        ],
      },
    ],
    maxTurns: 15,
  },
  end: { say: 'complete' },
  rules: { noNewNumbers: true, noLeading: true, mustAsk: true, maxReplyChars: 300, forbidden: ['実在の宿の名前'] },
  mock: { ...TRAVEL.mock, intents: { yes: ['はい', 'それで'], no: ['ちがう'] } },
};

test('版 2 の設定を読み、段、遷移、終わる条件、守ること、intent の言葉を返す', () => {
  const definition = parse(TRAVEL_V2);
  assert.equal(definition.formatVersion, 2);
  assert.deepEqual(definition.fields.map((field) => field.required), [true, false]);
  assert.deepEqual(definition.flow, {
    steps: [
      { id: 'hear', ask: ['place', 'nights'], say: null, next: [{ when: { filled: 'required' }, to: 'confirm' }] },
      {
        id: 'confirm',
        ask: [],
        say: 'summary',
        next: [
          { when: { intent: 'yes' }, to: 'done' },
          { when: { intent: 'no' }, to: 'hear' },
        ],
      },
    ],
    maxTurns: 15,
  });
  assert.deepEqual(definition.end, { say: 'complete' });
  assert.deepEqual(definition.rules, { noNewNumbers: true, noLeading: true, mustAsk: true, maxReplyChars: 300, forbidden: ['実在の宿の名前'] });
  assert.deepEqual(definition.mock.intents, { yes: ['はい', 'それで'], no: ['ちがう'] });
  // 条件の語は組み合わせられる(どれも満たすとき)
  const combined = parse({
    ...TRAVEL_V2,
    flow: { steps: [{ id: 'hear', ask: ['place'], next: [{ when: { filled: ['place'], turnsAtLeast: 2 }, to: 'done' }] }] },
  });
  assert.deepEqual(combined.flow.steps[0].next[0].when, { filled: ['place'], turnsAtLeast: 2 });
  assert.equal(combined.flow.maxTurns, 30);
});

test('版 2 の形の誤りは、ビルドの失敗として、どこが悪いかを返す(S16 の形の側)', async (t) => {
  const steps = TRAVEL_V2.flow.steps;
  const withSteps = (changed) => ({ ...TRAVEL_V2, flow: { ...TRAVEL_V2.flow, steps: changed } });
  const cases = [
    // 存在しない段への遷移
    [withSteps([steps[0], { ...steps[1], next: [{ when: { intent: 'yes' }, to: 'finish' }] }]), /flow\.steps\[1\]\.next\[0\]\.to: 存在しない段「finish」への遷移です/],
    // 存在しない項目を ask に書く
    [withSteps([{ ...steps[0], ask: ['place', 'budget'] }, steps[1]]), /flow\.steps\[0\]\.ask\[1\]: 「budget」は fields にない項目です/],
    // 知らない条件の語
    [withSteps([{ ...steps[0], next: [{ when: { expr: 'place != null' }, to: 'confirm' }] }, steps[1]]), /flow\.steps\[0\]\.next\[0\]\.when: 「expr」は知らない条件の語です。使える語: filled, intent, turnsAtLeast/],
    // 知らない intent(遷移の条件と、モックの言葉)
    [withSteps([steps[0], { ...steps[1], next: [{ when: { intent: 'maybe' }, to: 'done' }] }]), /flow\.steps\[1\]\.next\[0\]\.when\.intent: 「maybe」は知らない intent です。使える intent: answer, yes, no, clarify, aside, restart/],
    [{ ...TRAVEL_V2, mock: { intents: { maybe: ['たぶん'] } } }, /mock\.intents: 「maybe」は知らない intent です/],
    // そのほかの形
    [withSteps([steps[0], { ...steps[1], next: [{ when: { filled: ['budget'] }, to: 'done' }] }]), /when\.filled\[0\]: 「budget」は fields にない項目です/],
    [withSteps([steps[0], { ...steps[1], id: 'hear' }]), /flow\.steps\[1\]\.id: 「hear」が重なっています/],
    [withSteps([{ ...steps[0], id: 'done' }]), /「done」は終わりを表すので/],
    [withSteps([{ ...steps[0], say: 'joke' }]), /flow\.steps\[0\]\.say: 「joke」は知らない種類です/],
    [withSteps([]), /flow\.steps: 段を 1 個から/],
    [{ ...TRAVEL_V2, flow: { maxTurns: 0 } }, /flow\.maxTurns: 1 以上の整数/],
    [{ ...TRAVEL_V2, end: { say: 'bye' } }, /end\.say: 「bye」は知らない種類です/],
    [{ ...TRAVEL_V2, rules: { noLeading: 'yes' } }, /rules\.noLeading: true か false/],
    [{ ...TRAVEL_V2, rules: { maxReplyChars: 5000 } }, /rules\.maxReplyChars: 1 から 2000 までの整数/],
    [{ ...TRAVEL_V2, rules: { strict: true } }, /rules: 「strict」は使えない項目です/],
    [{ ...TRAVEL_V2, fields: [{ ...TRAVEL.fields[0], required: 'yes' }] }, /fields\[0\]\.required: true か false/],
    [{ ...TRAVEL_V2, formatVersion: 3 }, /formatVersion: 1 か 2 にしてください/],
    // 版を書かずに版 2 の項目を書いたら、黙って版 1 として読まない
    [{ ...TRAVEL, flow: TRAVEL_V2.flow }, /flow: 版 2 の項目です。使うときは "formatVersion": 2 を書いてください/],
    [{ ...TRAVEL, fields: TRAVEL_V2.fields }, /fields\[0\]\.required: 版 2 の項目です/],
    [{ ...TRAVEL, mock: { confirm: 'よいですか?' } }, /mock\.confirm: 版 2 の項目です/],
    // 型の違う値は、正しい値を知らないと言わずに、書き方を知らせる
    [withSteps([steps[0], { ...steps[1], next: [{ when: { intent: ['yes'] }, to: 'done' }] }]), /when\.intent: answer, yes, no, clarify, aside, restart のどれかを文字列で/],
    [withSteps([{ ...steps[0], say: ['summary'] }, steps[1]]), /flow\.steps\[0\]\.say: summary, complete のどれかを文字列で/],
    [withSteps([{ ...steps[0], next: [{ when: { filled: 'required' } }] }, steps[1]]), /next\[0\]\.to: 移る段の id か "done"\(終わる\)を文字列で/],
    // 満たされ方のおかしい条件
    [{ ...TRAVEL_V2, flow: undefined, fields: TRAVEL_V2.fields.map((field) => ({ ...field, required: false })) }, /fields: 必須の項目\(required が true\)が 1 つもないので/],
    [withSteps([{ ...steps[0], next: [{ when: { turnsAtLeast: 20 }, to: 'confirm' }] }, steps[1]]), /when\.turnsAtLeast: flow\.maxTurns\(15\)より大きいので/],
  ];
  for (const [raw, pattern] of cases) {
    const source = JSON.stringify(raw);
    const { definition, errors } = parseAiDefinition(source);
    assert.equal(definition, null, source);
    assert.ok(errors.every((e) => e.file === 'app/ai.json'));
    assert.ok(errors.some((e) => pattern.test(e.text)), `${pattern}\n${JSON.stringify(errors)}`);
  }

  // ビルドの失敗として、右の「詳細」に出る誤りになる
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-ai-v2-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const appDir = path.join(dir, 'app');
  await fs.mkdir(appDir);
  await fs.writeFile(path.join(appDir, 'main.js'), 'console.log(1);\n');
  await fs.writeFile(path.join(appDir, 'ai.json'), JSON.stringify(cases[0][0]));
  const broken = await buildApp({ appDir, buildsDir: path.join(dir, 'builds') });
  assert.equal(broken.ok, false);
  assert.ok(broken.errors.some((e) => e.file === 'app/ai.json' && /存在しない段「finish」/.test(e.text)), JSON.stringify(broken.errors));
});

test('版 1 の設定は、段は 1 つ、全部の項目を並びの順に聞き、全部が埋まったら終わる版 2 として読む', async () => {
  const definition = travel();
  assert.equal(definition.formatVersion, 2);
  assert.deepEqual(definition.flow, {
    steps: [{ id: 'hear', ask: ['place', 'nights'], say: null, next: [{ when: { filled: 'required' }, to: 'done' }] }],
    maxTurns: 30,
  });
  // 全部の項目が終わる条件に入る
  assert.ok(definition.fields.every((field) => field.required));
  assert.deepEqual(definition.end, { say: 'complete' });
  assert.deepEqual(definition.rules, DEFAULT_RULES);
  assert.deepEqual(definition.mock.intents, {});
  // formatVersion: 1 と書いても同じ。同じ振る舞いの版 2 と比べても、変わったところはない
  assert.deepEqual(parse({ ...TRAVEL, formatVersion: 1 }), definition);
  assert.deepEqual(describeDefinitionChanges(definition, parse({ ...TRAVEL, formatVersion: 2 })), []);

  // 見本の ai.json は、変えずに版 2 として読める
  for (const sample of ['job-consult', 'study-consult']) {
    const source = await fs.readFile(path.join(STUDIO_ROOT, 'samples', sample, 'app', 'ai.json'), 'utf8');
    assert.equal(JSON.parse(source).formatVersion, undefined, sample);
    const { definition: read, errors } = parseAiDefinition(source);
    assert.deepEqual(errors, [], sample);
    assert.equal(read.flow.steps.length, 1, sample);
    assert.deepEqual(read.flow.steps[0].ask, read.fields.map((field) => field.key), sample);
    assert.deepEqual(read.flow.steps[0].next, [{ when: { filled: 'required' }, to: 'done' }], sample);
    assert.ok(read.fields.every((field) => field.required), sample);
  }
});

test('flow.maxTurns が 30 を超えると 30 として読む', () => {
  const turns = (maxTurns) => parse({ ...TRAVEL_V2, flow: { ...TRAVEL_V2.flow, maxTurns } }).flow.maxTurns;
  assert.equal(turns(15), 15);
  assert.equal(turns(30), 30);
  assert.equal(turns(31), 30);
  assert.equal(turns(1000), 30);
  // steps を書かずに maxTurns だけ書くと、段は既定(全部を順に聞く)
  const only = parse({ ...TRAVEL_V2, flow: { maxTurns: 99 } });
  assert.equal(only.flow.maxTurns, 30);
  assert.deepEqual(only.flow.steps.map((step) => step.id), ['hear']);
});

test('設定の変化の説明は、段、終わる条件、守ることの変化も出す', () => {
  const v1 = travel();
  const v2 = parse(TRAVEL_V2);
  assert.deepEqual(describeDefinitionChanges(v1, v2), [
    '足した段「confirm」: 聞く項目 なし、言うこと 条件のまとめ(mock.confirm)、進む先 利用者が「いいえ」と答えたとき段「hear」へ、利用者が「はい」と答えたとき終わる',
    '段「hear」から進む先: なし → 必須の項目が埋まったとき段「confirm」へ',
    '終わる条件: 段「hear」で必須の項目が埋まったとき → 段「confirm」で利用者が「はい」と答えたとき',
    '終わる条件から外した項目(required): 泊数',
    '会話を終えるターン数(flow.maxTurns): 30 → 15',
    '守ること「返事の長さの上限(maxReplyChars)」: 1000 文字 → 300 文字',
    '守ること「禁止の言葉(forbidden)」に足した: 「実在の宿の名前」',
    'モックが yes と読む言葉: なし → 「はい」、「それで」',
    'モックが no と読む言葉: なし → 「ちがう」',
  ]);
  assert.deepEqual(describeDefinitionChanges(v2, parse(TRAVEL_V2)), []);

  const { steps } = TRAVEL_V2.flow;
  const changed = parse({
    ...TRAVEL_V2,
    flow: {
      steps: [
        { id: 'hear', ask: ['nights'], say: 'summary', next: [{ when: { filled: ['place'], turnsAtLeast: 3 }, to: 'done' }] },
        { id: 'check', next: [{ when: { intent: 'restart' }, to: 'hear' }] },
      ],
      maxTurns: 40,
    },
    end: { say: 'summary' },
    rules: { noNewNumbers: false, mustAsk: true, noLeading: true, maxReplyChars: 300, forbidden: [] },
  });
  assert.deepEqual(describeDefinitionChanges(v2, changed), [
    'なくした段: 「confirm」',
    '足した段「check」: 聞く項目 なし、言うこと なし、進む先 利用者が最初からと言ったとき段「hear」へ',
    '段「hear」で聞く項目: 行き先、泊数 → 泊数',
    '段「hear」で言うこと: なし → 条件のまとめ(mock.confirm)',
    '段「hear」から進む先: 必須の項目が埋まったとき段「confirm」へ → なし',
    '終わる条件: 段「confirm」で利用者が「はい」と答えたとき → 段「hear」で行き先が埋まった かつ 3 ターン以上たったとき',
    '会話を終えるターン数(flow.maxTurns): 15 → 30',
    '終わったときに言うこと(end): 終わりの文(mock.complete) → 条件のまとめ(mock.confirm)',
    '守ること「数字を作らない(noNewNumbers)」: する → しない',
    '守ること「禁止の言葉(forbidden)」から外した: 「実在の宿の名前」',
  ]);
  // 最初の段を入れ替える
  const swapped = parse({ ...TRAVEL_V2, flow: { ...TRAVEL_V2.flow, steps: [TRAVEL_V2.flow.steps[1], TRAVEL_V2.flow.steps[0]] } });
  assert.deepEqual(describeDefinitionChanges(v2, swapped), ['最初の段: 「hear」 → 「confirm」']);
  // 進む先と終わり方が同じでも、確かめる順が変わると、どれで移るかが変わり得る
  const reordered = parse({ ...TRAVEL_V2, flow: { ...TRAVEL_V2.flow, steps: [steps[0], { ...steps[1], next: [...steps[1].next].reverse() }] } });
  assert.deepEqual(describeDefinitionChanges(v2, reordered), [
    '段「confirm」で遷移を確かめる順: 利用者が「はい」と答えたとき終わる、利用者が「いいえ」と答えたとき段「hear」へ → 利用者が「いいえ」と答えたとき段「hear」へ、利用者が「はい」と答えたとき終わる',
  ]);
  // filled: "required" を使わない流れでは、required を変えても終わり方は変わらないので出さない
  const byList = { ...TRAVEL_V2, flow: { steps: [{ id: 'hear', ask: ['place'], next: [{ when: { filled: ['place'] }, to: 'done' }] }] } };
  assert.deepEqual(describeDefinitionChanges(parse(byList), parse({ ...byList, fields: [TRAVEL_V2.fields[0], { ...TRAVEL.fields[1], required: true }] })), []);
  assert.deepEqual(describeDefinitionChanges(v2, parse({ ...TRAVEL_V2, mock: { ...TRAVEL_V2.mock, confirm: '{summary}で進めますか?' } })), [
    'モックの条件のまとめを確かめるときの返事: 「今の条件は{summary}です。これでよいですか?」 → 「{summary}で進めますか?」',
  ]);
});

// 設定を差し替えられる AiSessions。作る AI が app/ai.json を書き換えてビルドした後と同じ状態を作る
function switchable(connections) {
  const holder = { definition: travel() };
  const sessions = new AiSessions({ definitionOf: () => holder.definition, ...(connections ? { connections } : {}) });
  return { sessions, holder };
}

test('設定が変わると会話は最初に戻り、前の発言と修正を新しい設定で試し直して、前後の応答を並べる', async () => {
  const { sessions, holder } = switchable();
  assert.equal(sessions.retryInfo('p').available, false);
  await assert.rejects(sessions.retry('p'), { code: 'no-previous' });
  await sessions.send('p', '湖に行きたい');
  sessions.correct('p', { nights: 3 });
  await sessions.send('p', 'よろしく');

  // 泊数を先に聞き、読み取れないときの返事を変えた設定
  holder.definition = parse({
    ...TRAVEL,
    fields: [TRAVEL.fields[1], TRAVEL.fields[0]],
    initialState: {},
    mock: { ...TRAVEL.mock, notUnderstood: '例: 「湖」「2泊」。' },
  });
  const fresh = sessions.view('p');
  assert.deepEqual(fresh.messages, [{ role: 'assistant', text: 'ようこそ。' }]);
  assert.deepEqual(sessions.retryInfo('p'), {
    available: true,
    name: '旅の相談(架空)',
    userMessages: 2,
    corrections: 1,
    retrying: false,
    result: null,
  });
  // 何も話さずにリセットしても、前の会話は残る
  sessions.reset('p');
  assert.equal(sessions.retryInfo('p').available, true);

  const view = await sessions.retry('p');
  assert.deepEqual(view.messages.map((m) => m.role), ['assistant', 'user', 'assistant', 'correction', 'user', 'assistant']);
  assert.deepEqual(view.state, { nights: 3, place: '湖の町' });
  const { result } = sessions.retryInfo('p');
  assert.equal(result.stopped, null);
  assert.deepEqual(
    result.replies.map((r) => [r.text, r.before, r.after]),
    [
      ['湖に行きたい', '行き先「湖の町」と理解しました。行き先「湖の町」、泊数「1泊」で考えます。', '行き先「湖の町」と理解しました。泊数を教えてください。'],
      [
        'よろしく',
        '直していただいた泊数「3泊」で進めます。行き先「湖の町」、泊数「3泊」で考えます。',
        '直していただいた泊数「3泊」で進めます。泊数「3泊」、行き先「湖の町」で考えます。',
      ],
    ],
  );
  // もう一度試し直せる。結果はリセットで消える
  assert.equal((await sessions.retry('p')).messages.length, 6);
  sessions.reset('p');
  assert.equal(sessions.retryInfo('p').result, null);
});

test('試し直しは、今の設定にない修正を飛ばして知らせ、途中の割り込みを断り、止められる', async () => {
  let release;
  const slow = {
    ...createMockConnection(),
    extract: (input) =>
      new Promise((resolve, reject) => {
        release = () => resolve(mockExtract(input));
        input.signal.addEventListener('abort', () => reject(Object.assign(new Error('止めました'), { name: 'AbortError' })));
      }),
  };
  const { sessions, holder } = switchable();
  await sessions.send('p', '湖');
  sessions.correct('p', { nights: 4 });
  await sessions.send('p', '山');
  holder.definition = parse({ ...TRAVEL, fields: [TRAVEL.fields[0]], initialState: {} });
  sessions.view('p');
  sessions.connections.set('mock', slow);

  const retrying = sessions.retry('p');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sessions.retryInfo('p').retrying, true);
  await assert.rejects(sessions.send('p', '湖'), { code: 'busy' });
  await assert.rejects(sessions.retry('p'), { code: 'busy' });
  release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.throws(() => sessions.correct('p', { place: '山の村' }), { code: 'busy' });
  // 2 つ目の発言を待つ間に止める
  sessions.cancel('p');
  const view = await retrying;
  const { result } = sessions.retryInfo('p');
  assert.deepEqual(result.skipped, ['泊数を「4」に直す修正']);
  assert.equal(result.replies.length, 1);
  assert.ok(result.stopped);
  assert.deepEqual(view.messages.map((m) => m.role), ['assistant', 'user', 'assistant']);
  assert.equal(sessions.retryInfo('p').retrying, false);
});

test('試し直しの途中でリセットされたら、新しい会話に書き足さない', async () => {
  let release;
  const slow = {
    ...createMockConnection(),
    extract: (input) => new Promise((resolve) => (release = () => resolve(mockExtract(input)))),
  };
  const { sessions, holder } = switchable([slow]);
  release = null;
  const first = sessions.send('p', '湖');
  release();
  await first;
  holder.definition = parse({ ...TRAVEL, name: '別の設定' });
  sessions.view('p');
  const retrying = sessions.retry('p');
  await new Promise((resolve) => setImmediate(resolve));
  sessions.reset('p');
  release();
  await assert.rejects(retrying, { code: 'reset' });
  assert.deepEqual(sessions.view('p').messages.map((m) => m.role), ['assistant']);
});

test('試し直しの途中で設定が変わったら、止めて、元の前の会話を残す', async () => {
  let release;
  const slow = {
    ...createMockConnection(),
    respond: (input) =>
      new Promise((resolve, reject) => {
        release = () => resolve({ reply: `${input.definition.name}: ${input.text}`, updates: {} });
        input.signal.addEventListener('abort', () => reject(Object.assign(new Error('止めました'), { name: 'AbortError' })));
      }),
  };
  const { sessions, holder } = switchable();
  for (const text of ['一', '二', '三']) await sessions.send('p', text);
  holder.definition = parse({ ...TRAVEL, name: '二つ目の設定' });
  sessions.view('p');
  sessions.connections.set('mock', slow);
  const retrying = sessions.retry('p');
  await new Promise((resolve) => setImmediate(resolve));
  release();
  await new Promise((resolve) => setImmediate(resolve));
  // 2 つ目を待つ間に、作る AI が設定を変えた
  holder.definition = parse({ ...TRAVEL, name: '三つ目の設定' });
  release();
  await assert.rejects(retrying, { code: 'reset' });
  const info = sessions.retryInfo('p');
  assert.equal(info.name, '旅の相談(架空)');
  assert.equal(info.userMessages, 3);
  assert.equal(info.retrying, false);
  assert.deepEqual(sessions.view('p').messages.map((m) => m.role), ['assistant']);
});

test('試し直しの発言と修正は Studio 画面から送ったものとして記録し、途中は版の復元を断る応答中とみなす', async () => {
  let release;
  const slow = {
    ...createMockConnection(),
    respond: (input) =>
      new Promise((resolve) => {
        release = () => resolve({ reply: `${input.definition.name}: ${input.text}`, updates: {} });
      }),
  };
  const { sessions, holder } = switchable();
  await sessions.send('p', '湖に行きたい');
  sessions.correct('p', { nights: 3 });
  holder.definition = parse({ ...TRAVEL, name: '二つ目の設定' });
  sessions.view('p');
  sessions.connections.set('mock', slow);
  const retrying = sessions.retry('p');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sessions.isBusy('p'), true);
  release();
  await retrying;
  assert.equal(sessions.isBusy('p'), false);
  const entries = sessions.trace('p').entries.reverse();
  assert.deepEqual(
    entries.map((e) => [e.type, e.from, e.status]),
    [
      ['reply', 'prototype', 'ok'],
      ['correction', 'prototype', 'ok'],
      ['reply', 'studio', 'ok'],
      ['correction', 'studio', 'ok'],
    ],
  );
});

test('学習相談のサンプル(#281)の設定は検査に通り、README の例の文から項目を読み取る', async () => {
  const source = await fs.readFile(path.join(STUDIO_ROOT, 'samples', 'study-consult', 'app', 'ai.json'), 'utf8');
  const { definition, errors } = parseAiDefinition(source);
  assert.deepEqual(errors, []);
  assert.deepEqual(extractUpdates(definition, 'プログラミングを本で学びたいです'), { subject: 'プログラミング', style: '本で学ぶ' });
  assert.deepEqual(extractUpdates(definition, '初めてなので、教室に通いたい'), { level: 'はじめて', style: '教室に通う' });
  assert.deepEqual(extractUpdates(definition, '毎日45分なら使えます'), { minutes: 45 });
  // 「1日」の 1 は単位(分)が続かないので読まない。単位の換算はしない
  assert.deepEqual(extractUpdates(definition, '1日30分くらい'), { minutes: 30 });
  assert.deepEqual(extractUpdates(definition, '1時間くらい'), {});
});

// 費用のかかる接続(テスト用)。Claude Code の接続と同じく、呼ぶ前に meter で数える。made は実際に「呼んだ」回数
function paidConnection() {
  const made = [];
  const call = (kind, meter) => {
    meter?.start(kind).end({ costUsd: 0.001 });
    made.push(kind);
  };
  return {
    made,
    kind: 'paid',
    label: '有料の接続(テスト用)',
    billing: { kind: 'test' },
    async extract({ definition, text, meter }) {
      // [やり直しすぎ] 決まりより多くやり直そうとする接続。3 回目は meter が止める
      for (let i = 0; i < (text.includes('[やり直しすぎ]') ? 3 : 1); i += 1) call('extract', meter);
      return mockExtract({ definition, text });
    },
    async phrase({ meter }) {
      call('phrase', meter);
      return { reply: '有料の返事' };
    },
  };
}

test('実モデルの呼び出しの 3 つの上限(会話の有料のターン 30、1 ターン 4 回、プロジェクトごとに 1 時間 120 回)。観察の会話もプロジェクトに数える', async () => {
  assert.equal(SESSION_LIMITS.maxPaidReplies, 30);
  assert.deepEqual(CALL_LIMITS.perTurn, { extract: 2, phrase: 2 });
  assert.equal(CALL_LIMITS.perProject, 120);
  assert.equal(CALL_LIMITS.windowMs, 60 * 60 * 1000);

  let now = Date.parse('2026-10-28T09:00:00Z');
  const projectCalls = new ProjectCallWindow({ now: () => now });
  const connection = paidConnection();
  const sessions = new AiSessions({ definitionOf: () => travel(), connections: [createMockConnection(), connection], projectCalls });
  sessions.consent.agree();
  sessions.select('p', 'paid');

  // 1 ターン: 呼び出しの回数と待ち時間が記録の 1 件に残る
  await sessions.send('p', '湖に行きたい');
  const [first] = sessions.trace('p').entries;
  assert.deepEqual([first.calls.count, first.calls.extract, first.calls.phrase], [2, 1, 1]);
  assert.ok(first.calls.calls.every((c) => Number.isFinite(c.waitMs)));
  assert.equal(projectCalls.count('p'), 2);

  // 1 ターン 4 回(抽出 2、言い方 2)。3 回目の抽出は呼ばずに止め、理由を返す
  const before = connection.made.length;
  await assert.rejects(sessions.send('p', '[やり直しすぎ]'), { status: 429, code: 'turn-limit', message: /1 ターンで実際の AI モデルを呼べるのは 4 回まで\(抽出 2 回、言い方 2 回\)/ });
  assert.deepEqual(connection.made.slice(before), ['extract', 'extract']);
  const [turnLimited] = sessions.trace('p').entries;
  assert.equal(turnLimited.status, 'failed');
  assert.match(turnLimited.error.next, /もう一度送ってください/);
  assert.equal(turnLimited.calls.extract, 2);

  // 会話の有料のターンは 30 まで(リセットで数え直す)
  const session = sessions.session('p');
  const paid = session.messages.filter((m) => m.via === 'paid').length;
  for (let i = paid; i < SESSION_LIMITS.maxPaidReplies; i += 1) session.messages.push({ role: 'user', text: 'x' }, { role: 'assistant', text: 'y', via: 'paid' });
  const counted = connection.made.length;
  await assert.rejects(sessions.send('p', '山'), { code: 'paid-limit', message: /30 回まで/ });
  assert.equal(connection.made.length, counted);
  sessions.reset('p');

  // プロジェクトごとに 1 時間 120 回。観察の会話も同じプロジェクトに数える。
  // 実モデルでの観察は、切り替えと同じ同意の口(useReal)を通る。同意は上で済んでいる
  while (projectCalls.count('p') < CALL_LIMITS.perProject - 4) projectCalls.take('p');
  const observation = sessions.openObservation('p', { connection: 'paid' });
  await sessions.send('p', '湖の町', { conversation: observation });
  assert.equal(projectCalls.count('p'), CALL_LIMITS.perProject - 3);
  await sessions.send('p', '山の村で2泊');
  assert.equal(projectCalls.count('p'), CALL_LIMITS.perProject - 1);
  const madeBefore = connection.made.length;
  // 残りが 1 回で、抽出と言い方の 2 回に足りないので、抽出も呼ばずに止める(抽出だけ呼んで捨てない)
  await assert.rejects(sessions.send('p', '湖に変えたい'), { status: 429, code: 'project-limit', message: /観察も含めて 60 分に 120 回まで/ });
  assert.deepEqual(connection.made.slice(madeBefore), []);
  assert.equal(projectCalls.count('p'), CALL_LIMITS.perProject - 1);
  // 新しい観察の会話を作っても、会話をリセットしても、数え直さない
  sessions.closeObservation('p', observation);
  const next = sessions.openObservation('p', { connection: 'paid' });
  await assert.rejects(sessions.send('p', '湖', { conversation: next }), { code: 'project-limit' });
  sessions.reset('p');
  await assert.rejects(sessions.send('p', '湖'), { code: 'project-limit' });
  assert.equal(connection.made.length, madeBefore);
  const [limited] = sessions.trace('p').entries;
  assert.equal(limited.error.code, 'project-limit');
  assert.match(limited.error.next, /時間をおいてから送るか/);
  assert.equal(limited.calls.count, 0);
  // 1 回も呼ばずに止めたので、渡すはずだったものは送っていない
  assert.equal(limited.input.notSent, true);
  assert.equal(turnLimited.input.notSent, undefined);
  // ほかのプロジェクトは別に数える。モックは数えない
  sessions.select('q', 'paid');
  await sessions.send('q', '湖');
  sessions.select('p', 'mock');
  await sessions.send('p', '湖');
  // 1 時間たてば、また呼べる
  now += CALL_LIMITS.windowMs;
  sessions.select('p', 'paid');
  assert.equal((await sessions.send('p', '山')).messages.at(-1).text, '有料の返事');
});

test('Claude Code の接続は、上限に当たると CLI を起動せずに止める', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-limits-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const log = path.join(dir, 'calls.jsonl');
  const env = { PATH: process.env.PATH, STUDIO_CLAUDE_BIN: path.join(STUDIO_ROOT, 'test', 'fixtures', 'fake-claude.js'), FAKE_CLAUDE_LOG: log };
  const connection = createClaudeCodeConnection({ env, allowed: true });
  t.after(() => connection.close());
  const input = { definition: travel(), state: {}, messages: [], text: '湖' };

  const turn = createTurnMeter();
  turn.start('extract');
  turn.start('extract');
  await assert.rejects(connection.extract({ ...input, meter: turn }), { code: 'turn-limit' });
  const window = new ProjectCallWindow({ limit: 1 });
  window.take('p');
  await assert.rejects(connection.extract({ ...input, meter: createTurnMeter({ take: () => window.take('p') }) }), { code: 'project-limit' });
  assert.equal(await fs.readFile(log, 'utf8').catch(() => ''), '');
});
