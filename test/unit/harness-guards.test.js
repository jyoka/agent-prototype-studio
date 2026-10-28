import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { readDataNumbers } from '../../src/server/build.js';
import { STUDIO_ROOT } from '../../src/server/config.js';
import { createClaudeCodeConnection } from '../../src/server/product-ai/claude-code.js';
import { parseAiDefinition } from '../../src/server/product-ai/definition.js';
import { checkReply, numbersIn } from '../../src/server/product-ai/guards.js';
import { startProgress, turn } from '../../src/server/product-ai/harness.js';
import { TURN_LIMITS, createTurnMeter } from '../../src/server/product-ai/limits.js';
import { createMockConnection, mockExtract, templateReply } from '../../src/server/product-ai/mock.js';
import { AiSessions } from '../../src/server/product-ai/session.js';

// 実モデルは呼ばない。Claude Code は偽の CLI に差し替える
const FAKE = path.join(STUDIO_ROOT, 'test', 'fixtures', 'fake-claude.js');

// 求人ではない題材(架空の旅の相談)。版 2 で rules を書く
function travel(rules = {}) {
  const { definition, errors } = parseAiDefinition(
    JSON.stringify({
      formatVersion: 2,
      name: '旅の相談(架空)',
      fields: [
        { key: 'place', label: '行き先', question: 'どこへ行きたいですか? 湖の町、山の村、海の港があります。', options: [{ value: '湖の町', keywords: ['湖'] }, { value: '山の村', keywords: ['山'] }, { value: '海の港', keywords: ['海'] }] },
        { key: 'nights', label: '泊数', type: 'number', unit: '泊', min: 1, max: 14, question: '何泊しますか?' },
      ],
      rules: { maxReplyChars: 200, forbidden: ['実在の宿'], ...rules },
      mock: { greeting: 'ようこそ。', complete: '{summary}で探します。' },
    }),
  );
  assert.deepEqual(errors, []);
  return definition;
}

// 行き先を聞いている決定(まだ何も決まっていない)
const askingPlace = (definition) => ({
  step: 'hear',
  from: 'hear',
  turn: 1,
  ask: 'place',
  say: null,
  changes: [],
  corrected: [],
  intent: null,
  done: false,
  mustInclude: [definition.fields[0].question],
});
const empty = { place: null, nights: null };

async function fakeEnv(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-guards-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const log = path.join(dir, 'calls.jsonl');
  const env = { PATH: process.env.PATH, STUDIO_CLAUDE_BIN: FAKE, FAKE_CLAUDE_LOG: log };
  const calls = async () => (await fs.readFile(log, 'utf8').catch(() => '')).split('\n').filter(Boolean).map((line) => JSON.parse(line));
  return { env, calls };
}

const kindOf = (call) => (JSON.parse(call.argv.find((a) => a.startsWith('--json-schema=')).slice(14)).properties.reply ? 'phrase' : 'extract');

// Claude Code(偽)を選んだ会話
async function fakeSessions(t, definition, options = {}) {
  const { env, calls } = await fakeEnv(t);
  const sessions = new AiSessions({ definitionOf: () => definition, connections: [createMockConnection(), createClaudeCodeConnection({ env, allowed: true })], ...options });
  t.after(() => sessions.close());
  sessions.select('p', 'claude-code', { confirmed: true });
  return { sessions, calls };
}

test('数は 3 桁の区切りと全角をそろえて読む。漢数字は読まない', () => {
  assert.deepEqual(numbersIn('時給 1,300 円、２泊、1.50 倍、三泊'), ['1300', '2', '1.5']);
});

test('noNewNumbers: 状態、利用者の発言、問いの原文、架空のデータに出てくる数だけを許す(S18)', () => {
  const definition = travel();
  const decision = askingPlace(definition);
  const base = { definition, decision, state: { place: null, nights: 2 }, utterances: ['予算は 30,000 円です'], dataNumbers: ['12800'] };
  const question = definition.fields[0].question;
  // 状態(2)、発言(30000)、架空のデータ(12800)、項目の範囲(14)
  assert.deepEqual(checkReply(`2泊、予算 3万ではなく 30000 円、12,800 円の宿もあります。14泊まで選べます。${question}`, base).failed.filter((f) => f.rule === 'noNewNumbers').map((f) => f.detail), [
    '「3」は、状態、利用者の発言、問いの原文、架空のデータのどれにも出てこない数',
  ]);
  assert.deepEqual(checkReply(`2泊で、予算は 30,000 円ですね。12,800 円の宿があります。${question}`, base).failed, []);
  const made = checkReply(`合う宿は 987 件です。${question}`, base);
  assert.deepEqual(made.failed.map((f) => f.rule), ['noNewNumbers']);
  assert.match(made.failed[0].detail, /「987」/);
  // 決まりを切れば確かめない
  assert.deepEqual(checkReply(`合う宿は 987 件です。${question}`, { ...base, definition: travel({ noNewNumbers: false }) }).failed, []);
});

test('noLeading: まだ言っていない選択肢の値を書かない。今聞いている問いの原文の中の選択肢は除く(S18)', () => {
  const definition = travel();
  const decision = askingPlace(definition);
  const question = definition.fields[0].question;
  const base = { definition, decision, state: empty, utterances: ['旅行に行きたい'] };
  // 問いの原文の中に選択肢が並んでいても合う
  assert.deepEqual(checkReply(`旅行ですね。${question}`, base).failed, []);
  // 言っていない値を決まったこととして書くと合わない(問いの原文があっても)
  const leading = checkReply(`湖の町がおすすめなので、湖の町にしますね。${question}`, base);
  assert.deepEqual(leading.failed.map((f) => f.rule), ['noLeading']);
  assert.match(leading.failed[0].detail, /「湖の町」/);
  // 利用者が言った値、状態の値は書いてよい
  assert.deepEqual(checkReply(`湖の町ですね。${question}`, { ...base, utterances: ['湖の町に行きたい'] }).failed, []);
  assert.deepEqual(checkReply('山の村で探します。', { ...base, decision: { ...decision, ask: null, mustInclude: [] }, state: { place: '山の村', nights: null } }).failed, []);
  assert.deepEqual(checkReply(`湖の町にしますね。${question}`, { ...base, definition: travel({ noLeading: false }) }).failed, []);
});

test('mustAsk: 問いの原文が抜けた返事には、原文を後ろに足す。入っていれば足さない(S18)', () => {
  const definition = travel();
  const decision = askingPlace(definition);
  const question = definition.fields[0].question;
  const base = { definition, decision, state: empty, utterances: ['旅行に行きたい'] };
  assert.deepEqual(checkReply('旅行ですね。', base), { reply: `旅行ですね。${question}`, added: [question], failed: [] });
  assert.deepEqual(checkReply('旅行ですね', base).reply, `旅行ですね。${question}`);
  assert.deepEqual(checkReply(`旅行ですね。${question}いつ頃ですか?`, base), { reply: `旅行ですね。${question}いつ頃ですか?`, added: [], failed: [] });
  // 聞かない決定では足さない。決まりを切れば足さない
  assert.deepEqual(checkReply('探します。', { ...base, decision: { ...decision, ask: null, mustInclude: [] } }).added, []);
  assert.deepEqual(checkReply('旅行ですね。', { ...base, definition: travel({ mustAsk: false }) }).reply, '旅行ですね。');
});

test('maxReplyChars と forbidden: 長さの上限を超える返事と、禁止の言葉を含む返事は合わない(S18)', () => {
  const definition = travel({ maxReplyChars: 80 });
  const decision = { ...askingPlace(definition), ask: null, mustInclude: [] };
  const base = { definition, decision, state: empty, utterances: [] };
  assert.deepEqual(checkReply('あ'.repeat(80), base).failed, []);
  const long = checkReply('あ'.repeat(81), base);
  assert.deepEqual(long.failed.map((f) => f.rule), ['maxReplyChars']);
  assert.match(long.failed[0].detail, /81 文字で、上限の 80 文字/);
  // 全角と半角の違いでは逃げられない
  const forbidden = checkReply('ｓｓ 実在の宿 ｓｓ', { ...base, definition: travel({ maxReplyChars: 80, forbidden: ['実在の宿', 'ss'] }) });
  assert.deepEqual(forbidden.failed.map((f) => f.rule), ['forbidden']);
  assert.deepEqual(checkReply('架空の宿です。', base).failed, []);
});

test('モックの返事は、見本の題材でいつも守ることに合う', async () => {
  for (const [sample, texts] of [
    ['study-consult', ['プログラミングを学びたい', 'はじめてです', 'こんにちは', '動画で学ぶ', '1日30分くらい', 'ありがとう']],
    ['job-consult', ['カフェで働きたい', '正社員で', 'もみじ台がいい', '時給は1300円以上', 'よろしく']],
  ]) {
    const appDir = path.join(STUDIO_ROOT, 'samples', sample, 'app');
    const { definition, errors } = parseAiDefinition(await fs.readFile(path.join(appDir, 'ai.json'), 'utf8'));
    assert.deepEqual(errors, []);
    const manifest = JSON.parse(await fs.readFile(path.join(appDir, 'prototype.json'), 'utf8'));
    const dataNumbers = await readDataNumbers(appDir, manifest.data);
    const sessions = new AiSessions({ definitionOf: () => definition, dataNumbersOf: () => dataNumbers });
    for (const text of texts) await sessions.send('p', text);
    const replies = sessions.trace('p').entries.filter((entry) => entry.type === 'reply');
    assert.equal(replies.length, texts.length);
    for (const entry of replies) assert.deepEqual(entry.harness.guards, { result: 'passed', failed: [], checks: [{ attempt: 1, reply: entry.output.reply, failed: [], added: [] }] }, sample);
  }
});

test('架空のデータに出てくる数は、目録の data に書いたファイルから読む', async () => {
  const appDir = path.join(STUDIO_ROOT, 'samples', 'job-consult', 'app');
  const numbers = await readDataNumbers(appDir, [{ file: 'jobs.js', about: '架空の求人' }]);
  assert.ok(numbers.includes('1350'));
  assert.deepEqual(await readDataNumbers(appDir, []), []);
});

test('合わない返事は言い方を 1 回やり直し、2 回目も合わなければ決まった文で返る。やり直しも 1 ターンの呼び出しに数える(S18)', async (t) => {
  const definition = travel();
  const { sessions, calls } = await fakeSessions(t, definition);
  const view = await sessions.send('p', '[数を作る] 山の村で2泊');
  const [entry] = sessions.trace('p').entries;
  // 決まった文(mock の型)で返る
  const state = { place: '山の村', nights: 2 };
  assert.deepEqual(view.state, state);
  assert.equal(view.messages.at(-1).text, templateReply(definition, { ...askingPlace(definition), ask: null, mustInclude: [], changes: [{ key: 'place' }, { key: 'nights' }], done: true, say: 'complete' }, state));
  assert.equal(entry.harness.guards.result, 'fallback');
  assert.deepEqual(entry.harness.guards.failed, ['noNewNumbers']);
  assert.deepEqual(entry.harness.guards.checks.map((c) => c.attempt), [1, 2]);
  assert.match(entry.harness.guards.reason, /やり直しても守ることに合わなかった/);
  // 言い方は 2 回(やり直しを含む)。1 ターンの呼び出しの数に入る
  assert.deepEqual([entry.calls.count, entry.calls.extract, entry.calls.phrase], [3, 1, 2]);
  assert.deepEqual((await calls()).map(kindOf), ['extract', 'phrase', 'phrase']);
  // やり直しの本文に、合わなかったところを入れて渡す
  const retried = (await calls()).at(-1).stdin;
  assert.match(retried, /<前の返事の問題>\n[^\n]*\n- 数字を作らない\(noNewNumbers\): 「987」は/);
  assert.equal(entry.harness.phrase.retryStdin, retried);
});

test('やり直しで合えば、やり直しの返事を使う', async (t) => {
  const definition = travel();
  const { sessions, calls } = await fakeSessions(t, definition);
  const view = await sessions.send('p', '[一度数を作る] 旅行の相談です');
  const [entry] = sessions.trace('p').entries;
  assert.equal(entry.harness.guards.result, 'retried');
  assert.deepEqual(entry.harness.guards.failed, ['noNewNumbers']);
  assert.doesNotMatch(view.messages.at(-1).text, /987/);
  assert.match(view.messages.at(-1).text, /^偽の Claude Code です。/);
  assert.ok(view.messages.at(-1).text.endsWith(definition.fields[0].question));
  assert.deepEqual((await calls()).map(kindOf), ['extract', 'phrase', 'phrase']);
});

test('問いの原文が抜けた返事には、やり直さずに原文を足す(S18)', async (t) => {
  const definition = travel();
  const { sessions, calls } = await fakeSessions(t, definition);
  const view = await sessions.send('p', '[問いを抜く] 旅行の相談です');
  const [entry] = sessions.trace('p').entries;
  const question = definition.fields[0].question;
  assert.equal(view.messages.at(-1).text, `偽の Claude Code です。これまでの会話を受け取りました(修正の記録なし)。「[問いを抜く] 旅行の相談です」への返事です。${question}`);
  assert.equal(entry.harness.guards.result, 'passed');
  assert.deepEqual(entry.harness.guards.checks[0].added, [question]);
  assert.deepEqual((await calls()).map(kindOf), ['extract', 'phrase']);
});

test('形の壊れた出力のやり直しで言い方の呼び出しを使い切ったら、守ることのやり直しはせずに決まった文で返す', async (t) => {
  const definition = travel();
  const { sessions, calls } = await fakeSessions(t, definition);
  // 1 回目は形が壊れ、形のやり直しの返事は数を作る。言い方は 2 回まで
  const view = await sessions.send('p', '[言い方が一度壊れる][一度数を作る] 旅行の相談です');
  const [entry] = sessions.trace('p').entries;
  assert.equal(entry.status, 'ok');
  assert.equal(entry.harness.guards.result, 'fallback');
  assert.match(entry.harness.guards.reason, /上限を使い切っていた/);
  assert.equal(entry.calls.phrase, 2);
  assert.deepEqual((await calls()).map(kindOf), ['extract', 'phrase', 'phrase']);
  assert.ok(view.messages.at(-1).text.endsWith(definition.fields[0].question));
});

test('守ることのやり直しの後に形が壊れても、3 回目は呼ばずに決まった文で返す', async () => {
  const definition = travel();
  const meter = createTurnMeter();
  let phrased = 0;
  // 呼ぶたびに meter で数える接続。1 回目は数を作り、2 回目は形の壊れた返事(空)を返し、形のやり直しを試みる
  const connection = {
    kind: 'counting',
    async extract() {
      return { updates: {}, intent: null };
    },
    async phrase({ meter: m }) {
      phrased += 1;
      m.start('phrase').end({});
      if (phrased === 1) return { reply: '合う宿は 987 件です。' };
      if (m.remaining('phrase') === 0) return { reply: null, fallback: '出力が壊れていて、1 ターンの呼び出しの上限でやり直せなかった' };
      throw new Error('3 回目を呼んだ');
    },
  };
  const trace = {};
  const result = await turn({ connection, definition, progress: startProgress(definition), state: empty, messages: [], text: 'こんにちは', meter, trace });
  assert.equal(phrased, 2);
  assert.equal(trace.guards.result, 'fallback');
  assert.match(trace.guards.reason, /やり直しの返事も使えなかった/);
  assert.equal(result.reply, templateReply(definition, result.decision, result.state));
});

test('1 回の呼び出しで返す接続(respond)は、合わなければやり直さずに決まった文で返す', async () => {
  const definition = travel();
  const connection = { kind: 'one', async respond() { return { reply: '湖の町にしましょう。', updates: {} }; } };
  const trace = {};
  const result = await turn({ connection, definition, progress: startProgress(definition), state: empty, messages: [], text: 'こんにちは', trace });
  assert.equal(trace.guards.result, 'fallback');
  assert.deepEqual(trace.guards.failed, ['noLeading']);
  assert.equal(result.reply, templateReply(definition, result.decision, result.state));
});

// 呼ばれたら止められるまで待つ接続。stage の口だけが待つ
function hanging(stage) {
  const wait = (signal) =>
    new Promise((_, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('止めました'), { code: 'cancelled' })), { once: true }));
  return {
    kind: 'hanging',
    aborted: [],
    async extract({ text, signal }) {
      if (stage === 'extract') {
        await wait(signal).catch((error) => {
          this.aborted.push('extract');
          throw error;
        });
      }
      return mockExtract({ definition: travel(), text });
    },
    async phrase({ signal }) {
      if (stage === 'phrase') {
        await wait(signal).catch((error) => {
          this.aborted.push('phrase');
          throw error;
        });
      }
      return { reply: 'はい。' };
    },
  };
}

test('1 ターンの期限を過ぎたら、接続を止め、決まった文で返し、記録に時間切れと残す', async () => {
  const definition = travel();
  for (const stage of ['extract', 'phrase']) {
    const connection = hanging(stage);
    const trace = {};
    const started = Date.now();
    const result = await turn({ connection, definition, progress: startProgress(definition), state: empty, messages: [], text: '山の村で2泊', trace, deadlineMs: 50 });
    assert.ok(Date.now() - started < 2000);
    assert.deepEqual(connection.aborted, [stage]);
    assert.equal(result.timedOut, stage);
    assert.deepEqual(trace.timeout, { stage, limitMs: 50 });
    assert.equal(trace.guards.result, 'fallback');
    assert.match(trace.guards.reason, /1 ターンの期限\(0\.05 秒\)を過ぎた/);
    assert.equal(result.reply, templateReply(definition, result.decision, result.state));
    if (stage === 'extract') {
      // 抽出の途中なら、変更なしで決定へ進む
      assert.deepEqual(result.state, empty);
      assert.match(trace.extract.fallback, /期限/);
    } else {
      assert.deepEqual(result.state, { place: '山の村', nights: 2 });
    }
  }
});

test('期限の前に利用者が止めたら、時間切れではなく止めたことになる', async () => {
  const definition = travel();
  const controller = new AbortController();
  const pending = turn({ connection: hanging('extract'), definition, progress: startProgress(definition), state: empty, messages: [], text: 'こんにちは', signal: controller.signal, deadlineMs: 5000 });
  controller.abort();
  await assert.rejects(pending, { code: 'cancelled' });
});

test('Claude Code(偽)が期限までに応答しなければ、CLI を止めて決まった文で返す', async (t) => {
  const definition = travel();
  const { sessions } = await fakeSessions(t, definition, { turnDeadlineMs: 500 });
  const view = await sessions.send('p', '[遅い] 旅行の相談です');
  const [entry] = sessions.trace('p').entries;
  assert.equal(entry.status, 'ok');
  assert.deepEqual(entry.harness.timeout, { stage: 'extract', limitMs: 500 });
  assert.equal(entry.calls.extract, 1);
  assert.equal(view.messages.at(-1).text, templateReply(definition, { ...askingPlace(definition), intent: null }, empty));
});

test('試作品の runtime は、サーバーの 1 ターンの期限より少し長く待つ', async () => {
  const runtime = await fs.readFile(path.join(STUDIO_ROOT, 'src', 'runtime', 'runtime.js'), 'utf8');
  const waitMs = Number(runtime.match(/var AI_TIMEOUT_MS = (\d+);/)[1]);
  assert.ok(waitMs > TURN_LIMITS.deadlineMs, `runtime ${waitMs} ms、期限 ${TURN_LIMITS.deadlineMs} ms`);
  assert.ok(waitMs - TURN_LIMITS.deadlineMs <= 60_000, '待ちすぎない(期限の後の決まった文は、すぐ返る)');
});
