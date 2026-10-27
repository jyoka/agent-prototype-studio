import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildApp } from '../../src/server/build.js';
import { STUDIO_ROOT } from '../../src/server/config.js';
import { describeDefinitionChanges, parseAiDefinition } from '../../src/server/product-ai/definition.js';
import { createMockConnection, extractUpdates } from '../../src/server/product-ai/mock.js';
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
  await assert.rejects(sessions.send('p', '湖'), { code: 'too-long', message: /リセット/ });
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
    respond: (input) =>
      new Promise((resolve, reject) => {
        release = () => resolve(createMockConnection().respond(input));
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
    respond: (input) => new Promise((resolve) => (release = () => resolve(createMockConnection().respond(input)))),
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
