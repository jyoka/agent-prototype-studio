import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildApp } from '../../src/server/build.js';
import { STUDIO_ROOT } from '../../src/server/config.js';
import { parseAiDefinition } from '../../src/server/product-ai/definition.js';
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
  const sessions = new AiSessions({ definitionOf: () => definition, connection });
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
  const sessions = new AiSessions({ definitionOf: () => travel(), connection });
  const first = sessions.send('p', '湖');
  await assert.rejects(sessions.send('p', '山'), { code: 'busy' });
  assert.throws(() => sessions.correct('p', { nights: 3 }), { code: 'busy' });
  sessions.reset('p');
  release();
  await assert.rejects(first, { code: 'reset' });
  assert.deepEqual(sessions.view('p').messages, [{ role: 'assistant', text: 'ようこそ。' }]);
});

test('接続が失敗したら、会話を変えずに理由を返す', async () => {
  const connection = { ...createMockConnection(), respond: async () => Promise.reject(new Error('つながらない')) };
  const sessions = new AiSessions({ definitionOf: () => travel(), connection });
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
