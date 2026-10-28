import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createMockConnection } from '../../src/server/product-ai/mock.js';
import { createObservationAi } from '../../src/server/product-ai/observation.js';
import { AiSessions, USER_CONVERSATION } from '../../src/server/product-ai/session.js';
import { ProjectStore } from '../../src/server/store.js';
import { ProjectVersions } from '../../src/server/versions.js';

// 観察用の会話(docs/design/harness.md の 3.4、S15)。観察は観察ごとに新しい会話で始め、終わったら捨てる。
// 観察しても、利用者の試す画面の会話、状態、選んだ接続、版、試し直しの前の会話は変わらない。
// 求人ではない題材(架空の旅の相談)で確かめる
const TRAVEL_AI = {
  name: '旅の相談(架空)',
  fields: [
    { key: 'place', label: '行き先', options: [{ value: '湖の町', keywords: ['湖'] }, { value: '山の村', keywords: ['山'] }] },
    { key: 'nights', label: '泊数', type: 'number', unit: '泊', min: 1, max: 14 },
  ],
  mock: { greeting: '旅の相談です。' },
};

// 利用者が選ぶ、モックとは別の接続(実モデルではない)。観察はこれを使わない
function echoConnection() {
  return {
    kind: 'echo',
    label: 'こだま(テスト用)',
    description: '発言をそのまま返す',
    async respond({ text }) {
      return { reply: `こだま: ${text}`, updates: {} };
    },
  };
}

async function boot(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-observe-session-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const app = path.join(home, 'projects', 'travel', 'app');
  await fs.mkdir(app, { recursive: true });
  await fs.writeFile(path.join(app, 'main.js'), "document.getElementById('root').textContent = '旅';\n");
  await fs.writeFile(path.join(app, 'ai.json'), JSON.stringify(TRAVEL_AI));
  const store = new ProjectStore(home);
  await store.buildAll();
  const aiSessions = new AiSessions({
    definitionOf: (id) => store.aiDefinition(id),
    connections: [createMockConnection(), echoConnection()],
  });
  const versions = new ProjectVersions({ store, aiSessions });
  // ai.json を変えてビルドし直す(作る AI が設定を変えたときと同じ)
  const changeAi = async (name) => {
    await fs.writeFile(path.join(app, 'ai.json'), JSON.stringify({ ...TRAVEL_AI, name }));
    await store.build('travel');
  };
  return { store, aiSessions, versions, changeAi };
}

// 利用者から見えるものを全部集める
async function userSide({ aiSessions, versions }) {
  const listed = await versions.list('travel');
  return {
    view: aiSessions.view('travel'),
    snapshot: aiSessions.snapshot('travel'),
    retry: aiSessions.retryInfo('travel'),
    busy: aiSessions.isBusy('travel'),
    connections: aiSessions.connectionChoices('travel').selected,
    versions: listed.versions,
    working: listed.working,
  };
}

test('観察しても、利用者の会話、状態、選んだ接続、版、試し直しの前の会話は変わらない。観察の会話は終わると消える', async (t) => {
  const studio = await boot(t);
  const { aiSessions, versions } = studio;

  // 利用者が試す画面で話し、設定が変わって前の会話ができ、新しい設定でも話している途中
  await aiSessions.send('travel', '湖に行きたい');
  await studio.changeAi('旅の相談(架空、二つ目)');
  await aiSessions.send('travel', '山にします');
  aiSessions.correct('travel', { nights: 2 });
  await versions.save('travel', { name: '話している途中' });
  aiSessions.select('travel', 'echo');
  await aiSessions.send('travel', 'もう少し考えます');
  const before = await userSide(studio);
  assert.equal(before.retry.available, true);
  assert.equal(before.retry.userMessages, 1);
  assert.equal(before.connections, 'echo');
  assert.deepEqual(before.view.state, { place: '山の村', nights: 2 });

  const ai = createObservationAi(aiSessions, 'travel');
  // 最初の要求で、あいさつだけの新しい会話が始まる。利用者の会話は持ち込まない
  const opened = await ai({ op: 'session' });
  assert.deepEqual(opened.messages, [{ role: 'assistant', text: '旅の相談です。' }]);
  assert.deepEqual(opened.state, { place: null, nights: null });
  // 観察の接続の既定はモック。利用者の選んだ接続(echo)は使わない
  assert.equal(opened.connection.kind, 'mock');
  const conversation = ai.conversation();
  assert.notEqual(conversation, USER_CONVERSATION);
  assert.deepEqual(aiSessions.conversations('travel').sort(), [conversation, USER_CONVERSATION].sort());

  const replied = await ai({ op: 'send', text: '湖で3泊したい' });
  assert.deepEqual(replied.state, { place: '湖の町', nights: 3 });
  assert.equal(replied.messages.at(-1).via, 'mock');
  const corrected = await ai({ op: 'correct', changes: { place: '山の村' } });
  assert.deepEqual(corrected.state, { place: '山の村', nights: 3 });

  // 観察の途中でも、利用者の側は何も変わっていない
  assert.deepEqual(await userSide(studio), before);

  ai.close();
  // 観察の会話は消え、利用者の会話だけが残る
  assert.deepEqual(aiSessions.conversations('travel'), [USER_CONVERSATION]);
  assert.equal(aiSessions.observations.size, 0);
  await assert.rejects(ai({ op: 'session' }), { code: 'closed' });
  assert.deepEqual(await userSide(studio), before);

  // やり取りは閉じた後も取り出せる(観察の report の ai に入る)
  assert.deepEqual(
    ai.entries().map((entry) => [entry.type, entry.observation, entry.status]),
    [
      ['open', conversation, 'ok'],
      ['reply', conversation, 'ok'],
      ['correction', conversation, 'ok'],
    ],
  );

  // 次の観察は、また新しい会話で始まる。前の観察の発言と状態は残らない
  const next = createObservationAi(aiSessions, 'travel');
  const fresh = await next({ op: 'session' });
  assert.notEqual(next.conversation(), conversation);
  assert.deepEqual(fresh.messages, [{ role: 'assistant', text: '旅の相談です。' }]);
  assert.deepEqual(fresh.state, { place: null, nights: null });
  next.close();
  assert.deepEqual(await userSide(studio), before);
});

test('観察の途中で設定が変わっても、観察の会話は試し直しの前の会話にならない', async (t) => {
  const studio = await boot(t);
  const { aiSessions } = studio;
  await aiSessions.send('travel', '湖に行きたい');
  await studio.changeAi('旅の相談(架空、二つ目)');
  const before = aiSessions.retryInfo('travel');
  assert.equal(before.name, '旅の相談(架空)');

  const ai = createObservationAi(aiSessions, 'travel');
  await ai({ op: 'send', text: '山で2泊' });
  await studio.changeAi('旅の相談(架空、三つ目)');
  // 新しい設定の、新しい観察の会話になる
  const view = await ai({ op: 'session' });
  assert.equal(view.name, '旅の相談(架空、三つ目)');
  assert.deepEqual(view.messages, [{ role: 'assistant', text: '旅の相談です。' }]);
  ai.close();

  assert.deepEqual(aiSessions.retryInfo('travel'), before);
});

test('観察を閉じると、応答を待っている観察の会話も止まる。利用者の会話は止めない', async (t) => {
  const studio = await boot(t);
  const { aiSessions } = studio;
  // 止められるまで応答しないモック(観察の接続)と、合図で応答する接続(利用者の接続)
  const slow = {
    ...createMockConnection(),
    respond: ({ signal }) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('止めました')))),
  };
  let answer;
  const manual = {
    ...echoConnection(),
    respond: ({ signal }) =>
      new Promise((resolve, reject) => {
        answer = resolve;
        signal.addEventListener('abort', () => reject(new Error('止めました')));
      }),
  };
  aiSessions.connections.set('mock', slow);
  aiSessions.connections.set('echo', manual);
  aiSessions.select('travel', 'echo');
  const userWaiting = aiSessions.send('travel', '山にします');
  assert.equal(aiSessions.isBusy('travel'), true);

  const ai = createObservationAi(aiSessions, 'travel');
  const waiting = ai({ op: 'send', text: '湖に行きたい' });
  await new Promise((resolve) => setImmediate(resolve));
  ai.close();
  await assert.rejects(waiting, { code: 'reset' });
  assert.deepEqual(aiSessions.conversations('travel'), [USER_CONVERSATION]);
  assert.deepEqual(ai.entries().map((entry) => entry.type), ['open', 'reply']);

  // 利用者の応答は止まっていない。届いた返事が利用者の会話に入る
  assert.equal(aiSessions.isBusy('travel'), true);
  answer({ reply: '山の村ですね', updates: { place: '山の村' } });
  const view = await userWaiting;
  // 次に聞く泊数の問いの原文は、harness が足す(rules.mustAsk)
  assert.equal(view.messages.at(-1).text, '山の村ですね。泊数を教えてください。');
  assert.deepEqual(view.state, { place: '山の村', nights: null });
});

test('実モデルの接続は同意の前と止める設定では、ない接続はいつも、観察を始めない', async (t) => {
  const { aiSessions } = await boot(t);
  let available = true;
  aiSessions.connections.set('paid', {
    kind: 'paid',
    label: '有料(テスト用)',
    billing: { note: '費用がかかる' },
    availability: () => (available ? { available: true, reason: '' } : { available: false, code: 'disabled', reason: '止める設定' }),
    respond: async () => ({}),
  });
  // 人の「確かめる」で本物の AI を使うときも、切り替えと同じ同意の口を通る
  assert.throws(() => createObservationAi(aiSessions, 'travel', { connection: 'paid' }), { code: 'consent-required', message: /本物の AI で確かめるには/ });
  assert.throws(() => createObservationAi(aiSessions, 'travel', { connection: 'none' }), { code: 'invalid' });
  aiSessions.consent.agree();
  available = false;
  assert.throws(() => createObservationAi(aiSessions, 'travel', { connection: 'paid' }), { code: 'disabled' });
  assert.equal(aiSessions.observations.size, 0);
  // 同意の後で、選べるなら始められる
  available = true;
  const ai = createObservationAi(aiSessions, 'travel', { connection: 'paid' });
  ai.close();
});
