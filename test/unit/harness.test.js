import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { STUDIO_ROOT } from '../../src/server/config.js';
import { createClaudeCodeConnection } from '../../src/server/product-ai/claude-code.js';
import { parseAiDefinition } from '../../src/server/product-ai/definition.js';
import { quickExtract, startProgress, turn } from '../../src/server/product-ai/harness.js';
import { createMockConnection, mockExtract } from '../../src/server/product-ai/mock.js';
import { AiSessions } from '../../src/server/product-ai/session.js';

// 架空の学習相談(samples/study-consult)に、確かめの段(confirm)を足した版 2 の設定
async function studyWithConfirm(extra = {}) {
  const source = JSON.parse(await fs.readFile(path.join(STUDIO_ROOT, 'samples', 'study-consult', 'app', 'ai.json'), 'utf8'));
  const raw = {
    ...source,
    formatVersion: 2,
    fields: source.fields.map((field) => (field.key === 'minutes' ? { ...field, required: false } : field)),
    flow: {
      steps: [
        { id: 'hear', ask: ['subject', 'level', 'style', 'minutes'], next: [{ when: { filled: 'required' }, to: 'confirm' }] },
        { id: 'confirm', say: 'summary', next: [{ when: { intent: 'yes' }, to: 'done' }, { when: { intent: 'no' }, to: 'hear' }] },
      ],
      maxTurns: 15,
    },
    mock: { ...source.mock, intents: { yes: ['はい', 'それで'], no: ['いいえ', 'ちがう', '違う'] } },
    ...extra,
  };
  const { definition, errors } = parseAiDefinition(JSON.stringify(raw));
  assert.deepEqual(errors, []);
  return definition;
}

// 求人ではない題材(架空の旅の相談)。版 1 の形
function travel() {
  const { definition, errors } = parseAiDefinition(
    JSON.stringify({
      name: '旅の相談(架空)',
      fields: [
        { key: 'place', label: '行き先', question: 'どこへ行きたいですか?', options: [{ value: '湖の町', keywords: ['湖'] }, { value: '山の村', keywords: ['山'] }] },
        { key: 'nights', label: '泊数', type: 'number', unit: '泊', min: 1, max: 14, question: '何泊しますか?' },
      ],
      mock: { greeting: 'ようこそ。', complete: '{summary}で探します。' },
    }),
  );
  assert.deepEqual(errors, []);
  return definition;
}

// 呼ばれた口を数える接続。抽出は渡した関数で返す
function recording(extractWith, { kind = 'recording' } = {}) {
  const calls = [];
  return {
    calls,
    kind,
    label: 'テスト用',
    async extract(input) {
      calls.push(['extract', input.text]);
      return extractWith(input);
    },
    async phrase({ decision }) {
      calls.push(['phrase', decision.step]);
      return { reply: `(${decision.step}の返事)` };
    },
  };
}

// 発言を順に送り、決定の列を返す
async function talk(connection, definition, texts) {
  let progress = startProgress(definition);
  let state = { ...definition.initialState };
  const messages = [];
  const decisions = [];
  const replies = [];
  for (const text of texts) {
    const result = await turn({ connection, definition, progress, state, messages, text });
    ({ progress, state } = result);
    messages.push({ role: 'user', text }, { role: 'assistant', text: result.reply });
    decisions.push(result.decision);
    replies.push(result.reply);
  }
  return { decisions, replies, state, progress };
}

const brief = (decision) => [decision.step, decision.ask, decision.say, decision.done];

test('turn() は抽出 → 決定 → 言い方の順に回し、何を聞くか、段の遷移、終わるかは ai.json とコードが決める(S16)', async () => {
  const definition = await studyWithConfirm();
  // 抽出はいつも同じ値を返す。何を聞くかや終わるかを返しても、harness は使わない
  const connection = recording(() => ({ updates: { subject: '写真', level: 'はじめて' }, intent: 'answer', ask: 'minutes', done: true }));
  const result = await turn({ connection, definition, progress: startProgress(definition), state: { ...definition.initialState }, messages: [], text: '写真をはじめてやります' });
  assert.deepEqual(connection.calls, [['extract', '写真をはじめてやります'], ['phrase', 'hear']]);
  assert.deepEqual(result.state, { subject: '写真', level: 'はじめて', style: null, minutes: null });
  assert.deepEqual(result.progress, { step: 'hear', turns: 1, done: false });
  assert.equal(result.decision.ask, 'style');
  assert.equal(result.decision.done, false);
  assert.deepEqual(result.decision.mustInclude, [definition.fields[2].question]);
  assert.deepEqual(result.decision.changes.map((c) => c.key), ['subject', 'level']);
  assert.match(result.decision.reason, /遷移の条件をどれも満たしていない/);
  assert.match(result.decision.reason, /「学び方」を聞く/);
  // 言い方の返事に問いの原文がなかったので、harness が後ろに足した(mustAsk)
  assert.equal(result.reply, `(hearの返事)${definition.fields[2].question}`);
});

test('終わる条件を満たすと done になり、それ以上聞かない(S16)', async () => {
  const definition = travel();
  const { decisions, replies } = await talk(createMockConnection(), definition, ['湖の町', '3泊', 'やっぱり山がいい', '何泊でしたっけ']);
  assert.deepEqual(decisions.map(brief), [
    ['hear', 'nights', null, false],
    ['hear', null, 'complete', true],
    ['hear', null, 'complete', true],
    ['hear', null, 'complete', true],
  ]);
  assert.match(decisions[1].reason, /必須の項目が埋まったときなので、会話を終える/);
  assert.match(decisions[2].reason, /会話はもう終わっている/);
  // 終わった後も、本人の言い直しは状態に入れ、問いは足さない
  assert.equal(replies[2], '行き先「山の村」と理解しました。行き先「山の村」、泊数「3泊」で探します。');
  for (const reply of replies.slice(1)) assert.doesNotMatch(reply, /何泊しますか|どこへ行きたいですか/);

  // flow.maxTurns に達しても終わる
  const { definition: short } = parseAiDefinition(
    JSON.stringify({ formatVersion: 2, name: '短い相談(架空)', fields: definition.fields.map(({ question, ...f }) => f), flow: { maxTurns: 2 } }),
  );
  const ended = await talk(createMockConnection(), short, ['こんにちは', 'こんにちは', 'こんにちは']);
  assert.deepEqual(ended.decisions.map((d) => d.done), [false, true, true]);
  assert.match(ended.decisions[1].reason, /flow\.maxTurns\(2\)に達した/);
});

test('抽出の結果が同じなら、接続によらず決定が同じ(S19)', async () => {
  const definition = await studyWithConfirm();
  const texts = ['プログラミングを学びたい', '初めてです', 'こんにちは', '動画で学ぶ', '30分です', 'いいえ', '本で学びたい', 'はい', 'はい'];
  const mock = await talk(createMockConnection(), definition, texts);
  // モックの抽出の結果を、前もって列にしておき、そのまま返す接続(言い方はモックと違う)
  const answers = [];
  await talk(recording((input) => (answers.push(mockExtract(input)), answers.at(-1))), definition, texts);
  const fixed = recording(() => answers.shift());
  const other = await talk(fixed, definition, texts);
  assert.deepEqual(other.decisions, mock.decisions);
  assert.notDeepEqual(other.replies, mock.replies);
  assert.deepEqual(mock.decisions.map(brief), [
    ['hear', 'level', null, false],
    ['hear', 'style', null, false],
    ['hear', 'style', null, false],
    ['confirm', null, 'summary', false],
    ['confirm', null, 'summary', false],
    ['hear', null, 'summary', false],
    ['confirm', null, 'summary', false],
    ['confirm', null, 'complete', true],
    ['confirm', null, 'complete', true],
  ]);
  assert.deepEqual(mock.state, { subject: 'プログラミング', level: 'はじめて', style: '本で学ぶ', minutes: 30 });
});

test('偽の CLI の実モデルの接続が、モックと同じ抽出を返すとき、決定の列が同じ(S19)', async (t) => {
  const definition = await studyWithConfirm();
  const texts = ['プログラミングを学びたい', '初めてです', 'こんにちは', '動画で学ぶ', '30分です', 'いいえ', '本で学びたい', 'はい', 'はい'];
  // 偽の CLI に、モックと同じ抽出を返させる(発言ごとの { updates, intent })
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-harness-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const extractions = path.join(dir, 'extractions.json');
  await fs.writeFile(extractions, JSON.stringify(Object.fromEntries(texts.map((text) => [text, mockExtract({ definition, text })]))));
  const log = path.join(dir, 'calls.jsonl');
  const env = { PATH: process.env.PATH, STUDIO_CLAUDE_BIN: path.join(STUDIO_ROOT, 'test', 'fixtures', 'fake-claude.js'), FAKE_CLAUDE_LOG: log, FAKE_CLAUDE_EXTRACTIONS: extractions };
  const real = createClaudeCodeConnection({ env, allowed: true });
  t.after(() => real.close());

  const mock = await talk(createMockConnection(), definition, texts);
  const viaCli = await talk(real, definition, texts);
  assert.deepEqual(viaCli.decisions, mock.decisions);
  assert.deepEqual(viaCli.state, mock.state);
  // 違うのは言い方の中身だけ
  assert.ok(viaCli.replies.every((reply) => reply.startsWith('偽の Claude Code です。')));
  // 偽の CLI は、抽出(選択肢の文字そのものでない発言だけ)と言い方の 2 種で呼ばれた
  const calls = (await fs.readFile(log, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  const kinds = calls.map((call) => (JSON.parse(call.argv.find((a) => a.startsWith('--json-schema=')).slice(14)).properties.reply ? 'phrase' : 'extract'));
  assert.equal(kinds.filter((k) => k === 'phrase').length, texts.length);
  assert.equal(kinds.filter((k) => k === 'extract').length, texts.length - 1);
});

test('版 2 の confirm の段: intent が yes なら done、no なら hear に戻る', async () => {
  const definition = await studyWithConfirm();
  const fill = ['写真を初めて動画で学びたい'];
  const yes = await talk(createMockConnection(), definition, [...fill, 'はい、それでお願いします']);
  assert.deepEqual(yes.decisions.map(brief), [
    ['confirm', null, 'summary', false],
    ['confirm', null, 'complete', true],
  ]);
  assert.match(yes.decisions[0].reason, /段「hear」で必須の項目が埋まったときなので、段「confirm」へ移る/);
  assert.match(yes.decisions[1].reason, /段「confirm」で利用者が「はい」と答えたときなので、会話を終える/);
  assert.equal(yes.replies[0], '学びたいこと「写真」、いまの段階「はじめて」、学び方「動画で学ぶ」ですね。今の条件は学びたいこと「写真」、いまの段階「はじめて」、学び方「動画で学ぶ」、1日に使える時間「未定」です。これでよいですか?');
  // はいを読めたので「読み取れなかった」とは言わない
  assert.match(yes.replies[1], /^学びたいこと「写真」、.*で、1 週間の進め方を作りました。/);

  const no = await talk(createMockConnection(), definition, [...fill, 'いいえ、違います', '教室に通いたい']);
  assert.deepEqual(no.decisions.map(brief), [
    ['confirm', null, 'summary', false],
    ['hear', 'minutes', null, false],
    ['confirm', null, 'summary', false],
  ]);
  assert.equal(no.decisions[1].intent, 'no');
  assert.match(no.decisions[1].reason, /「いいえ」と答えたときなので、段「hear」へ移る/);
  assert.equal(no.state.style, '教室に通う');
  // 何も読めない発言では、段に留まる
  const stay = await talk(createMockConnection(), definition, [...fill, 'うーん']);
  assert.deepEqual(brief(stay.decisions[1]), ['confirm', null, 'summary', false]);
});

test('決まりに合わない抽出の値は状態に入れず、記録に残る(S17)', async () => {
  const definition = await studyWithConfirm();
  const connection = recording(() => ({
    updates: { subject: '書道', minutes: 999, level: 'はじめて', color: 'red', style: ['動画で学ぶ'] },
    intent: 'maybe',
  }));
  const sessions = new AiSessions({ definitionOf: () => definition, connections: [connection] });
  const view = await sessions.send('p', '書道を毎日999分');
  assert.deepEqual(view.state, { subject: null, level: 'はじめて', style: null, minutes: null });
  const [entry] = sessions.trace('p').entries;
  const expected = [
    { key: 'subject', label: '学びたいこと', value: '書道', reason: '項目の決まりに合わない値' },
    { key: 'minutes', label: '1日に使える時間', value: '999', reason: '項目の決まりに合わない値' },
    { key: 'color', label: null, value: 'red', reason: 'app/ai.json にない項目' },
    { key: 'style', label: '学び方', value: '["動画で学ぶ"]', reason: '項目の決まりに合わない値' },
    { key: 'intent', label: '発言の種類(intent)', value: 'maybe', reason: 'Studio の決めた種類(answer, yes, no, clarify, aside, restart)にない' },
  ];
  assert.deepEqual(entry.rejected, expected);
  assert.deepEqual(entry.harness.extract.rejected, expected);
  assert.deepEqual(entry.changes, [{ key: 'level', label: 'いまの段階', from: '未定', to: 'はじめて' }]);
  assert.equal(entry.harness.decision.intent, null);

  // 形の壊れた抽出は、何も入れずに記録する
  const broken = recording(() => 'JSON ではない');
  const other = new AiSessions({ definitionOf: () => definition, connections: [broken] });
  assert.deepEqual((await other.send('p', '写真')).state.subject, '写真');
  await other.send('p', 'なんでも');
  const [last] = other.trace('p').entries;
  assert.deepEqual(last.rejected, [{ key: '(抽出の全体)', label: null, value: 'JSON ではない', reason: '{ updates, intent } の形ではない' }]);
});

test('選択肢の文字そのものと、今聞いている数の項目への数だけの答えは、抽出を呼ばずに決定へ進む', async () => {
  const definition = await studyWithConfirm();
  const connection = recording(() => ({ updates: {}, intent: null }));
  const { decisions, state } = await talk(connection, definition, ['写真', 'はじめて', '動画で学ぶ']);
  assert.deepEqual(connection.calls.filter(([kind]) => kind === 'extract'), []);
  assert.deepEqual(state, { subject: '写真', level: 'はじめて', style: '動画で学ぶ', minutes: null });
  assert.equal(decisions.at(-1).step, 'confirm');

  // 数は、今聞いている数の項目にだけ。単位を付けてもよい。範囲の外は検査で入れない
  const progress = { step: 'hear', turns: 3, done: false };
  const asked = { subject: '写真', level: 'はじめて', style: '動画で学ぶ', minutes: null };
  assert.deepEqual(quickExtract(definition, progress, asked, '４５分').updates, { minutes: '45' });
  assert.deepEqual(quickExtract(definition, progress, asked, '1,000').updates, { minutes: '1000' });
  // 聞いていない項目の選択肢の文字は、抽出に任せる
  assert.equal(quickExtract(definition, progress, asked, '写真'), null);
  assert.equal(quickExtract(definition, progress, { ...asked, style: null }, '45'), null);
  assert.equal(quickExtract(definition, progress, asked, '45分くらい'), null);
  const outOfRange = await turn({ connection, definition, progress, state: asked, messages: [], text: '999' });
  assert.equal(outOfRange.state.minutes, null);
  assert.equal(outOfRange.extraction.rejected[0].key, 'minutes');
  assert.deepEqual(connection.calls.filter(([kind]) => kind === 'extract'), []);
});

test('確かめの段の「はい」は、ほかの項目の選択肢と同じ文字でも、抽出に任せて intent として読む', async () => {
  const { definition, errors } = parseAiDefinition(
    JSON.stringify({
      formatVersion: 2,
      name: '車の相談(架空)',
      fields: [
        { key: 'place', label: '行き先', options: [{ value: '湖の町' }, { value: '山の村' }] },
        { key: 'car', label: '車を使うか', required: false, options: [{ value: 'はい' }, { value: 'いいえ' }] },
      ],
      flow: {
        steps: [
          { id: 'hear', ask: ['place'], next: [{ when: { filled: 'required' }, to: 'confirm' }] },
          { id: 'confirm', say: 'summary', next: [{ when: { intent: 'yes' }, to: 'done' }] },
        ],
      },
      mock: { intents: { yes: ['はい'] } },
    }),
  );
  assert.deepEqual(errors, []);
  const connection = recording((input) => ({ updates: {}, intent: mockExtract(input).intent }));
  const { decisions } = await talk(connection, definition, ['湖の町', 'はい']);
  assert.deepEqual(connection.calls.filter(([kind]) => kind === 'extract'), [['extract', 'はい']]);
  assert.deepEqual(decisions.map(brief), [
    ['confirm', null, 'summary', false],
    ['confirm', null, 'complete', true],
  ]);
});

test('抽出を待つ間に止められたら、言い方を呼ばない', async () => {
  const definition = await studyWithConfirm();
  const controller = new AbortController();
  const connection = recording(() => {
    controller.abort();
    return { updates: { subject: '写真' }, intent: 'answer' };
  });
  await assert.rejects(
    turn({ connection, definition, progress: startProgress(definition), state: { ...definition.initialState }, messages: [], text: '写真がいい', signal: controller.signal }),
    { code: 'cancelled' },
  );
  assert.deepEqual(connection.calls, [['extract', '写真がいい']]);
});

test('本人の修正はモデルを呼ばずに状態に入れ、次の決定に corrected として渡す', async () => {
  const definition = await studyWithConfirm();
  const connection = recording((input) => mockExtract(input));
  const sessions = new AiSessions({ definitionOf: () => definition, connections: [connection] });
  await sessions.send('p', 'プログラミングを学びたい');
  sessions.correct('p', { level: '少し経験あり' });
  assert.equal(connection.calls.length, 2);
  const view = await sessions.send('p', 'こんにちは');
  const [entry] = sessions.trace('p').entries;
  assert.deepEqual(entry.harness.decision.corrected, [{ key: 'level', label: 'いまの段階' }]);
  assert.equal(entry.harness.decision.step, 'hear');
  assert.equal(entry.harness.decision.ask.key, 'style');
  assert.equal(view.messages.at(-1).text, `(hearの返事)${definition.fields[2].question}`);
  // モックの言い方では、直した項目を先に言ってから聞く
  const mock = new AiSessions({ definitionOf: () => definition });
  await mock.send('p', 'プログラミングを学びたい');
  mock.correct('p', { level: '少し経験あり' });
  assert.equal((await mock.send('p', 'こんにちは')).messages.at(-1).text, `直していただいたいまの段階「少し経験あり」に合わせます。${definition.fields[2].question}`);
});

test('記録の 1 件に、抽出、決定、言い方の段ごとの中身が残る', async () => {
  const definition = await studyWithConfirm();
  const sessions = new AiSessions({ definitionOf: () => definition });
  await sessions.send('p', '写真');
  await sessions.send('p', '初めてで動画で');
  const [second, quick] = sessions.trace('p').entries;
  const { extract, decision, phrase } = second.harness;
  assert.equal(extract.via, 'connection');
  assert.equal(extract.input.text, '初めてで動画で');
  assert.equal(extract.input.step, 'hear');
  assert.deepEqual(extract.output, { updates: '{"level":"はじめて","style":"動画で学ぶ"}', intent: 'answer' });
  assert.deepEqual(extract.rejected, []);
  assert.deepEqual([decision.from, decision.step, decision.turn, decision.ask, decision.say, decision.done], ['hear', 'confirm', 2, null, 'summary', false]);
  assert.deepEqual(decision.changes.map((c) => `${c.label}: ${c.from} → ${c.to}`), ['いまの段階: 未定 → はじめて', '学び方: 未定 → 動画で学ぶ']);
  assert.match(decision.reason, /段「confirm」へ移る/);
  assert.equal(phrase.via, 'connection');
  assert.deepEqual(phrase.input, { step: 'confirm', ask: null, say: 'summary', done: false, mustInclude: [] });
  assert.equal(phrase.output.reply, second.output.reply);
  assert.equal(quick.harness.extract.via, 'shortcut');
  assert.match(quick.harness.extract.reason, /選択肢の文字そのもの/);
});

test('1 回の呼び出しで返す接続(respond。テスト用)も、updates は同じ検査を通り、決定は harness が行う', async () => {
  const definition = await studyWithConfirm();
  const connection = {
    kind: 'one-call',
    label: '1 回の呼び出し(テスト用)',
    async respond() {
      return { reply: 'モデルの返事', updates: { subject: '写真', level: 'はじめて', style: '動画で学ぶ', minutes: -1 } };
    },
  };
  const sessions = new AiSessions({ definitionOf: () => definition, connections: [connection] });
  const view = await sessions.send('p', '写真');
  assert.equal(view.messages.at(-1).text, 'モデルの返事');
  assert.equal(view.state.minutes, null);
  const [entry] = sessions.trace('p').entries;
  assert.equal(entry.harness.extract.via, 'respond');
  assert.equal(entry.harness.phrase.via, 'respond');
  assert.equal(entry.harness.decision.step, 'confirm');
  assert.equal(entry.rejected[0].key, 'minutes');
});

test('版に保存した会話は、harness の進み具合も戻す。進み具合のない古い版は最初の段から始める', async () => {
  const definition = await studyWithConfirm();
  const sessions = new AiSessions({ definitionOf: () => definition });
  await sessions.send('p', '写真を初めて動画で');
  await sessions.send('p', 'はい');
  const snapshot = sessions.snapshot('p');
  assert.deepEqual(snapshot.progress, { step: 'confirm', turns: 2, done: true });
  sessions.reset('p');
  assert.equal(sessions.restore('p', structuredClone(snapshot)), true);
  assert.deepEqual(sessions.snapshot('p'), snapshot);

  const { progress, ...old } = snapshot;
  assert.equal(sessions.restore('p', old), true);
  assert.deepEqual(sessions.snapshot('p').progress, { step: 'hear', turns: 2, done: false });
  for (const bad of [{ step: 'nowhere', turns: 0, done: false }, { step: 'hear', turns: -1, done: false }, { step: 'hear', turns: 0, done: 'no' }]) {
    assert.equal(sessions.restore('p', { ...old, progress: bad }), false);
  }
  // ターンが flow.maxTurns を超えていたら、上限として読む
  assert.equal(sessions.restore('p', { ...old, progress: { step: 'hear', turns: 99, done: false } }), true);
  assert.equal(sessions.snapshot('p').progress.turns, 15);
});
