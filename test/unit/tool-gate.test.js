import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import dgram from 'node:dgram';
import fsCallback from 'node:fs';
import fs from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import tls from 'node:tls';
import { parseTools } from '../../src/server/sim/tools.js';
import { callTool, loadToolData } from '../../src/server/sim/tool-gate.js';

// ツールの口(docs/design/agent-simulation.md の 3.5、7.3 の sim-2)。
// データは設計の 2.4、2.5 の例を元にした架空のもの

const JOBS = [
  { id: 'j1', title: '架空の品出し', area: 'みなと町', wage: 1100, days: ['土', '日'], contact: '架空の窓口 A' },
  { id: 'j2', title: '架空の受付', area: 'もり台', wage: 1200, days: ['月'], contact: '架空の窓口 B' },
  { id: 'j3', title: '架空の配膳', area: 'みなと町', wage: 1000, days: ['土'], contact: '架空の窓口 C' },
  { id: 'j4', title: '架空のレジ', area: 'みなと町', wage: 1300, days: ['日'], contact: '架空の窓口 D' },
];
const QUESTIONS = ['どのあたりで探していますか', '時給はいくら以上がよいですか'];

const TOOLS = {
  formatVersion: 1,
  owner: 'dip',
  tools: [
    {
      name: 'search_jobs',
      description: '架空の求人を、場所、時給、曜日で探す',
      inputSchema: {
        type: 'object',
        properties: {
          area: { type: 'string', enum: ['みなと町', 'もり台', 'かわべ市'] },
          minWage: { type: 'number', minimum: 900, maximum: 3000 },
          day: { type: 'string', enum: ['月', '火', '水', '木', '金', '土', '日'] },
          word: { type: 'string', maxLength: 20 },
        },
      },
      do: {
        op: 'search',
        data: 'data/jobs.json',
        match: {
          area: { field: 'area' },
          minWage: { field: 'wage', atLeast: true },
          day: { field: 'days', includes: true },
          word: { field: 'title', contains: true },
        },
        fields: ['id', 'title', 'area', 'wage'],
        sort: { field: 'wage', order: 'desc' },
        limit: 2,
      },
      guards: { maxCallsPerConversation: 3 },
    },
    {
      name: 'get_job',
      description: '架空の求人を 1 つ、id で詳しく見る',
      inputSchema: { type: 'object', properties: { id: { type: 'string', maxLength: 10 } }, required: ['id'] },
      do: { op: 'get', data: 'data/jobs.json', key: 'id' },
      guards: { hideFields: ['contact'] },
    },
    {
      name: 'suggest_questions',
      description: 'DIP が聞いてほしいことの一覧を返す',
      do: { op: 'fixed', data: 'data/questions.json' },
    },
    {
      name: 'opening_hours',
      description: '架空の窓口の受付時間を返す',
      do: { op: 'fixed', value: { open: '10:00', close: '18:00' } },
      guards: { maxResultChars: 100 },
    },
    {
      name: 'long_notice',
      description: '長い知らせを返す',
      do: { op: 'fixed', value: 'あ'.repeat(300) },
      guards: { maxResultChars: 200 },
    },
    {
      name: 'record_consent',
      description: '希望を保存してよいと本人が言ったことを記録する',
      inputSchema: { type: 'object', properties: { agreed: { type: 'boolean' } }, required: ['agreed'] },
      do: { op: 'record', into: 'consent' },
    },
    {
      name: 'save_wish',
      description: '本人の希望を保存する',
      inputSchema: {
        type: 'object',
        properties: {
          area: { type: 'string', maxLength: 20 },
          minWage: { type: 'integer', minimum: 900 },
          note: { type: 'string', maxLength: 200 },
          tags: { type: 'array', items: { type: 'string', maxLength: 10 } },
        },
      },
      do: { op: 'record', into: 'wishes', mode: 'append' },
      guards: {
        requires: [{ recorded: 'consent', equals: { agreed: true } }],
        deny: [
          { arg: 'note', looksLike: ['phone', 'email'], message: '電話番号とメールアドレスは保存できません' },
          { arg: 'note', containsAny: ['マイナンバー'], message: 'マイナンバーは保存できません' },
        ],
      },
    },
    {
      name: 'handoff_to_consult',
      description: 'バイト探しの相談を相談役に引き継ぐ',
      inputSchema: { type: 'object', properties: { area: { type: 'string', maxLength: 20 }, minWage: { type: 'number' }, note: { type: 'string' } } },
      do: { op: 'handoff', to: 'consult' },
    },
  ],
};

const HANDOFFS = [
  { from: 'front', to: 'consult', carry: ['area', 'minWage'] },
  { from: 'consult', to: 'front' },
];

async function makeApp(t, files) {
  const appDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tool-gate-'));
  t.after(() => fs.rm(appDir, { recursive: true, force: true }));
  for (const [file, value] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(appDir, file)), { recursive: true });
    await fs.writeFile(path.join(appDir, file), typeof value === 'string' ? value : JSON.stringify(value));
  }
  return appDir;
}

// 検査した tools.json と、読んだデータ
async function setup(t, raw = TOOLS) {
  const appDir = await makeApp(t, { 'data/jobs.json': JOBS, 'data/questions.json': QUESTIONS });
  const { toolset, errors } = await parseTools(raw, { file: 'tools.json', appDir });
  assert.deepEqual(errors, []);
  const loaded = await loadToolData(appDir, toolset);
  assert.deepEqual(loaded.errors, []);
  return { tools: toolset, data: loaded.data, appDir };
}

const effects = (outcome) => outcome.guards.map((guard) => `${guard.guard}:${guard.effect}`);
const blockedBy = (outcome) => outcome.guards.find((guard) => guard.effect === 'blocked');
// ms は毎回違うので、比べるときは外す
const withoutMs = ({ ms, entry, ...rest }) => ({ ...rest, entry: { ...entry, ms: undefined } });

test('5 つの op が動く: search は条件、項目、並べ方、件数で返す', async (t) => {
  const { tools, data } = await setup(t);
  const all = await callTool({ tools, data, name: 'search_jobs', args: { area: 'みなと町' } });
  assert.equal(all.ok, true);
  // 合うのは 3 件。時給の高い順に 2 件まで。項目は fields だけ
  assert.deepEqual(all.result, {
    count: 3,
    items: [
      { id: 'j4', title: '架空のレジ', area: 'みなと町', wage: 1300 },
      { id: 'j1', title: '架空の品出し', area: 'みなと町', wage: 1100 },
    ],
  });
  assert.deepEqual(effects(all), ['schema:passed', 'maxCallsPerConversation:passed']);

  const narrowed = await callTool({ tools, data, name: 'search_jobs', args: { area: 'みなと町', minWage: 1050, day: '土' } });
  assert.deepEqual(narrowed.result, { count: 1, items: [{ id: 'j1', title: '架空の品出し', area: 'みなと町', wage: 1100 }] });

  const word = await callTool({ tools, data, name: 'search_jobs', args: { word: '受付' } });
  assert.deepEqual(word.result.items.map((item) => item.id), ['j2']);

  const none = await callTool({ tools, data, name: 'search_jobs', args: { area: 'かわべ市' } });
  assert.deepEqual(none.result, { count: 0, items: [] });
});

test('5 つの op が動く: get、fixed(data と value)、record(replace と append)、handoff', async (t) => {
  const { tools, data } = await setup(t);

  const job = await callTool({ tools, data, name: 'get_job', args: { id: 'j2' } });
  assert.equal(job.ok, true);
  assert.equal(job.result.title, '架空の受付');
  const missing = await callTool({ tools, data, name: 'get_job', args: { id: 'j9' } });
  assert.equal(missing.ok, false);
  assert.match(missing.error, /見つかりません/);

  const questions = await callTool({ tools, data, name: 'suggest_questions' });
  assert.deepEqual(questions.result, QUESTIONS);
  const hours = await callTool({ tools, data, name: 'opening_hours', args: {} });
  assert.deepEqual(hours.result, { open: '10:00', close: '18:00' });

  // record は記録の店を値で返す。渡した店は変えない
  const store = {};
  const consent = await callTool({ tools, data, store, name: 'record_consent', args: { agreed: true } });
  assert.equal(consent.ok, true);
  assert.deepEqual(consent.result, { recorded: 'consent' });
  assert.deepEqual(consent.store, { consent: { agreed: true } });
  assert.deepEqual(store, {});
  const again = await callTool({ tools, data, store: consent.store, name: 'record_consent', args: { agreed: false } });
  assert.deepEqual(again.store, { consent: { agreed: false } });

  const first = await callTool({ tools, data, store: consent.store, name: 'save_wish', args: { area: 'みなと町' } });
  const second = await callTool({ tools, data, store: first.store, name: 'save_wish', args: { minWage: 1100, tags: ['土日'] } });
  assert.deepEqual(second.store.wishes, [{ area: 'みなと町' }, { minWage: 1100, tags: ['土日'] }]);

  // handoff は頼むだけ。辺があれば carry の値だけを渡す
  const handoff = await callTool({
    tools,
    data,
    context: { by: 'front', handoffs: HANDOFFS },
    name: 'handoff_to_consult',
    args: { area: 'みなと町', minWage: 1000, note: '架空のメモ' },
  });
  assert.equal(handoff.ok, true);
  assert.deepEqual(handoff.result, { handoff: 'consult' });
  assert.deepEqual(handoff.handoff, { to: 'consult', carry: { area: 'みなと町', minWage: 1000 } });
  assert.deepEqual(handoff.entry.handoff, { to: 'consult' });
  assert.deepEqual(effects(handoff), ['schema:passed', 'handoff:passed']);
});

test('形の検査: inputSchema に合わない引数は実行せず、schema で断る', async (t) => {
  const { tools, data } = await setup(t);
  const store = { consent: { agreed: true } };
  const cases = [
    ['search_jobs', { area: '架空の島' }, /どれか/],
    ['search_jobs', { minWage: 100 }, /900 以上/],
    ['search_jobs', { minWage: '1000' }, /数に/],
    ['search_jobs', { place: 'みなと町' }, /知らない引数/],
    ['get_job', {}, /「id」がありません/],
    ['get_job', { id: 'j1234567890' }, /10 文字まで/],
    ['save_wish', { minWage: 1000.5 }, /整数/],
    ['save_wish', { tags: ['長すぎる言葉を書いた札です'] }, /tags\[0\]/],
    ['save_wish', null, /オブジェクト/],
    ['record_consent', { agreed: 'yes' }, /true か false/],
  ];
  for (const [name, args, pattern] of cases) {
    const outcome = await callTool({ tools, data, store, name, args });
    assert.equal(outcome.ok, false, `${name} ${JSON.stringify(args)}`);
    assert.match(outcome.error, pattern);
    assert.equal(blockedBy(outcome).guard, 'schema');
    assert.equal(blockedBy(outcome).layer, 'tool');
    assert.equal(blockedBy(outcome).owner, 'dip');
    assert.equal(outcome.store, store, '断ったら記録の店を変えない');
  }

  const unknown = await callTool({ tools, data, name: 'delete_all', args: {} });
  assert.equal(unknown.ok, false);
  assert.deepEqual(effects(unknown), ['schema:blocked']);
  assert.deepEqual(unknown.calls, {});
});

test('ツールの守り: requires は記録がないか条件に合わなければ実行せず、blocked と理由を残す(S22)', async (t) => {
  const { tools, data } = await setup(t);
  const none = await callTool({ tools, data, store: {}, name: 'save_wish', args: { area: 'みなと町' } });
  assert.equal(none.ok, false);
  assert.deepEqual(blockedBy(none), { layer: 'tool', guard: 'requires', effect: 'blocked', owner: 'dip', reason: '記録「consent」がありません' });
  assert.deepEqual(none.store, {});
  assert.deepEqual(none.entry.guards, none.guards);
  assert.deepEqual(none.entry.result, { ok: false, error: '記録「consent」がありません' });

  const refused = await callTool({ tools, data, store: { consent: { agreed: false } }, name: 'save_wish', args: { area: 'みなと町' } });
  assert.equal(blockedBy(refused).guard, 'requires');
  assert.match(blockedBy(refused).reason, /条件/);
  assert.equal(refused.store.wishes, undefined);

  const agreed = await callTool({ tools, data, store: { consent: { agreed: true } }, name: 'save_wish', args: { area: 'みなと町' } });
  assert.equal(agreed.ok, true);
  assert.deepEqual(effects(agreed), ['schema:passed', 'requires:passed', 'deny:passed']);
});

test('ツールの守り: deny は電話番号、メールアドレス、言葉に当たれば宣言の文で断る(S22)', async (t) => {
  const { tools, data } = await setup(t);
  const store = { consent: { agreed: true } };
  const phone = await callTool({ tools, data, store, name: 'save_wish', args: { note: '090-0000-0000 に電話して' } });
  assert.equal(phone.ok, false);
  assert.equal(phone.error, '電話番号とメールアドレスは保存できません');
  assert.equal(blockedBy(phone).guard, 'deny');
  assert.match(blockedBy(phone).reason, /note/);
  assert.equal(phone.store, store);
  // 記録の引数は伏せて残す
  assert.equal(phone.entry.args.note.includes('090-0000-0000'), false);

  const email = await callTool({ tools, data, store, name: 'save_wish', args: { note: 'taro@example.com に送って' } });
  assert.equal(email.error, '電話番号とメールアドレスは保存できません');
  const word = await callTool({ tools, data, store, name: 'save_wish', args: { note: 'マイナンバーも書いておく' } });
  assert.equal(word.error, 'マイナンバーは保存できません');
  const fine = await callTool({ tools, data, store, name: 'save_wish', args: { note: '土日だけ。時給 1100 円以上' } });
  assert.equal(fine.ok, true);
});

test('ツールの守り: hideFields は結果から項目を除き、除いたことを blocked として残す(S22)', async (t) => {
  const { tools, data } = await setup(t);
  const job = await callTool({ tools, data, name: 'get_job', args: { id: 'j1' } });
  assert.equal(job.ok, true);
  assert.equal(Object.hasOwn(job.result, 'contact'), false);
  assert.deepEqual(job.result.days, ['土', '日']);
  assert.deepEqual(blockedBy(job), { layer: 'tool', guard: 'hideFields', effect: 'blocked', owner: 'dip', reason: '結果から contact を除きました' });
  assert.deepEqual(job.entry.result.keys, ['id', 'title', 'area', 'wage', 'days']);
  // 元のデータは変えない
  assert.equal(data['data/jobs.json'][0].contact, '架空の窓口 A');
});

test('ツールの守り: maxCallsPerConversation を超えた呼び出しは実行しない(S22)', async (t) => {
  const { tools, data } = await setup(t);
  let calls = {};
  for (let i = 1; i <= 3; i += 1) {
    const outcome = await callTool({ tools, data, context: { calls }, name: 'search_jobs', args: {} });
    assert.equal(outcome.ok, true);
    calls = outcome.calls;
  }
  assert.deepEqual(calls, { search_jobs: 3 });
  const over = await callTool({ tools, data, context: { calls }, name: 'search_jobs', args: {} });
  assert.equal(over.ok, false);
  assert.equal(over.result, undefined);
  assert.deepEqual(blockedBy(over), {
    layer: 'tool',
    guard: 'maxCallsPerConversation',
    effect: 'blocked',
    owner: 'dip',
    reason: 'このツールは 1 つの会話で 3 回までです',
  });
  assert.deepEqual(over.calls, { search_jobs: 4 });
});

test('ツールの守り: maxResultChars は宣言と前提の小さいほうで、超えた結果を返さない(S22)', async (t) => {
  const { tools, data } = await setup(t);
  const long = await callTool({ tools, data, name: 'long_notice' });
  assert.equal(long.ok, false);
  assert.equal(long.result, undefined);
  assert.equal(blockedBy(long).guard, 'maxResultChars');
  assert.match(blockedBy(long).reason, /302 文字。上限 200 文字/);

  // 前提の resultMaxChars のほうが小さければ、そちらで止める
  const assumption = { toolCalling: { resultMaxChars: 20 } };
  const hours = await callTool({ tools, data, context: { assumption }, name: 'opening_hours' });
  assert.equal(hours.ok, false);
  assert.match(blockedBy(hours).reason, /上限 20 文字/);
  const roomy = await callTool({ tools, data, context: { assumption: { toolCalling: { resultMaxChars: 5000 } } }, name: 'opening_hours' });
  assert.equal(roomy.ok, true);
  assert.deepEqual(effects(roomy), ['schema:passed', 'maxResultChars:passed']);
});

test('引き継ぎ: 構成の辺にない引き継ぎは、ツールの守りで断る', async (t) => {
  const { tools, data } = await setup(t);
  const outcome = await callTool({ tools, data, context: { by: 'consult', handoffs: HANDOFFS }, name: 'handoff_to_consult', args: {} });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.handoff, undefined);
  assert.equal(blockedBy(outcome).guard, 'handoff');
});

test('同じ呼び出しには、同じ結果と同じ守りの判定を返す', async (t) => {
  const { tools, data } = await setup(t);
  const calls = [
    { name: 'search_jobs', args: { area: 'みなと町', day: '土' }, context: { calls: { search_jobs: 1 } } },
    { name: 'search_jobs', args: {}, context: { calls: { search_jobs: 3 } } },
    { name: 'get_job', args: { id: 'j3' } },
    { name: 'save_wish', args: { note: '090-0000-0000' }, store: { consent: { agreed: true } } },
    { name: 'save_wish', args: { area: 'もり台' }, store: { consent: { agreed: true }, wishes: [{ area: 'みなと町' }] } },
    { name: 'save_wish', args: { area: 'もり台' } },
    { name: 'long_notice' },
    { name: 'handoff_to_consult', args: { area: 'みなと町' }, context: { by: 'front', handoffs: HANDOFFS } },
    { name: 'search_jobs', args: {}, context: { calls: { search_jobs: 1 }, assumption: { toolCalling: { faults: [{ tool: 'search_jobs', onCall: 2 }] } } } },
  ];
  for (const call of calls) {
    const first = await callTool({ tools, data, ...call });
    const second = await callTool({ tools, data, ...call });
    assert.deepEqual(withoutMs(second), withoutMs(first), call.name);
  }
});

test('前提の遅れ(delayMs)は呼び出しごとに待ち、失敗(faults)は決まった回だけ実行せずに失敗を返す', async (t) => {
  const { tools, data } = await setup(t);
  const waited = [];
  const sleep = async (ms) => waited.push(ms);
  const assumption = { toolCalling: { delayMs: 300, faults: [{ tool: 'save_wish', onCall: 2 }] } };
  let store = { consent: { agreed: true } };
  let calls = {};
  const results = [];
  for (const area of ['みなと町', 'もり台', 'かわべ市']) {
    const outcome = await callTool({ tools, data, store, context: { calls, assumption, sleep }, name: 'save_wish', args: { area } });
    results.push(outcome);
    store = outcome.store;
    calls = outcome.calls;
  }
  assert.deepEqual(waited, [300, 300, 300]);
  assert.deepEqual(results.map((outcome) => outcome.ok), [true, false, true]);
  assert.equal(results[1].fault, true);
  assert.equal(results[1].entry.fault, true);
  assert.match(results[1].error, /失敗/);
  // 失敗した回は記録しない。守りは通っている
  assert.deepEqual(store.wishes, [{ area: 'みなと町' }, { area: 'かわべ市' }]);
  assert.deepEqual(effects(results[1]), ['schema:passed', 'requires:passed', 'deny:passed']);
  // ほかのツールの回には効かない
  const other = await callTool({ tools, data, context: { calls: { get_job: 1 }, assumption, sleep }, name: 'get_job', args: { id: 'j1' } });
  assert.equal(other.ok, true);

  // 本当に待つ(sleep を渡さないとき)
  const slow = await callTool({ tools, data, context: { assumption: { toolCalling: { delayMs: 40 } } }, name: 'suggest_questions' });
  assert.equal(slow.ok, true);
  assert.ok(slow.ms >= 35, `ms: ${slow.ms}`);
});

test('すり抜けない: 全角の電話番号とメールアドレス、入れ子の項目、継ぎの名前のツール', async (t) => {
  const { tools, data } = await setup(t);
  const store = { consent: { agreed: true } };
  for (const note of ['０９０-１２３４-５６７８', '090－1234－5678', 'taro＠example.com']) {
    const outcome = await callTool({ tools, data, store, name: 'save_wish', args: { note } });
    assert.equal(outcome.ok, false, note);
    assert.equal(blockedBy(outcome).guard, 'deny', note);
  }

  // 継ぎの名前(constructor)のツールも、回数と前提の失敗を自分の回で数える
  const raw = {
    formatVersion: 1,
    owner: 'dip',
    tools: [
      { name: 'constructor', description: '名前の試し', do: { op: 'fixed', value: 'ok' }, guards: { maxCallsPerConversation: 1 } },
      {
        name: 'find_job',
        description: 'id が省ける get',
        inputSchema: { type: 'object', properties: { id: { type: 'string', maxLength: 10 }, toString: { type: 'string', maxLength: 10 } } },
        do: { op: 'get', data: 'data/jobs.json', key: 'id' },
        guards: { hideFields: ['contact'] },
      },
      { name: 'card', description: '入れ子の結果', do: { op: 'fixed', value: { count: 1, items: [], contact: '架空', detail: { contact: '架空', ok: 1 } } }, guards: { hideFields: ['contact'] } },
      { name: 'pass_on', description: '引き継ぐ', inputSchema: { type: 'object', properties: { area: { type: 'string' } } }, do: { op: 'handoff', to: 'consult' } },
    ],
  };
  const odd = await setup(t, raw);
  const first = await callTool({ ...odd, name: 'constructor' });
  assert.equal(first.ok, true);
  assert.deepEqual(first.calls, { constructor: 1 });
  const second = await callTool({ ...odd, context: { calls: first.calls }, name: 'constructor' });
  assert.equal(blockedBy(second).guard, 'maxCallsPerConversation');

  // 省ける引数が継ぎの名前(toString)でも、渡さなければ形の検査を通る。key の引数がなければ、どれも返さない
  const noKey = await callTool({ ...odd, name: 'find_job', args: {} });
  assert.equal(noKey.ok, false);
  assert.match(noKey.error, /「id」を渡してください/);

  // hideFields は、結果の形によらず、入れ子の中まで除く
  const card = await callTool({ ...odd, name: 'card' });
  assert.deepEqual(card.result, { count: 1, items: [], detail: { ok: 1 } });
  assert.equal(blockedBy(card).guard, 'hideFields');

  // 構成を読んだ辺は carry をいつも配列で持つ。空なら何も渡さない
  const handoff = await callTool({ ...odd, context: { by: 'front', handoffs: [{ from: 'front', to: 'consult', carry: [] }] }, name: 'pass_on', args: { area: 'みなと町' } });
  assert.deepEqual(handoff.handoff, { to: 'consult', carry: {} });
});

test('記録の 1 件は、引数、誤りの文、守りの理由、ツールの名前まで伏せる', async (t) => {
  const { tools, data } = await setup(t);
  const phone = '090-1234-5678';
  const outcomes = [
    await callTool({ tools, data, name: 'get_job', args: { id: '09012345678' } }),
    await callTool({ tools, data, name: 'get_job', args: { id: 'j1', [phone]: 'x' } }),
    await callTool({ tools, data, name: `call ${phone}`, args: {} }),
  ];
  for (const outcome of outcomes) {
    const recorded = JSON.stringify(outcome.entry);
    assert.equal(recorded.includes(phone) || recorded.includes('09012345678'), false, recorded);
    assert.match(recorded, /伏せた: 電話番号/);
  }
});

test('データの形が変わっていても例外を出さず、並べ方は値のないものを後ろにする', async (t) => {
  const { tools } = await setup(t);
  const broken = await callTool({ tools, data: { 'data/jobs.json': { not: 'array' } }, name: 'search_jobs', args: {} });
  assert.equal(broken.ok, false);
  assert.match(broken.error, /配列ではありません/);

  const jobs = [{ id: 'a', wage: null }, { id: 'b', wage: 1000 }, { id: 'c' }, { id: 'd', wage: 1200 }];
  const sorted = await callTool({ tools, data: { 'data/jobs.json': jobs }, name: 'search_jobs', args: {} });
  assert.deepEqual(sorted.result.items.map((item) => item.id), ['d', 'b']);
  const raw = structuredClone(TOOLS);
  raw.tools[0].do.sort.order = 'asc';
  raw.tools[0].do.limit = 4;
  const ascending = await setup(t, raw);
  const up = await callTool({ tools: ascending.tools, data: { 'data/jobs.json': jobs }, name: 'search_jobs', args: {} });
  assert.deepEqual(up.result.items.map((item) => item.id), ['b', 'd', 'a', 'c']);
});

test('データに .js を指すと検査の誤りになり、loadToolData も .js を読まない(S21)', async (t) => {
  const appDir = await makeApp(t, { 'data/jobs.js': 'export default [];', 'data/jobs.json': JOBS });
  const raw = {
    formatVersion: 1,
    tools: [{ name: 'list_jobs', description: '架空の求人の一覧', do: { op: 'fixed', data: 'data/jobs.js' } }],
  };
  const { toolset, errors } = await parseTools(raw, { file: 'tools.json', appDir });
  assert.equal(toolset, null);
  assert.match(errors.map((error) => error.text).join('\n'), /\.js などのコードは読みません/);

  // 検査を通らない宣言を渡されても、.js は読まない
  const read = [];
  for (const method of ['readFile', 'lstat', 'open', 'stat']) {
    const original = fs[method];
    t.mock.method(fs, method, function spy(file, ...rest) {
      read.push(String(file));
      return original.call(this, file, ...rest);
    });
  }
  const forged = { owner: 'dip', tools: [{ name: 'list_jobs', do: { op: 'fixed', data: 'data/jobs.js' } }, { name: 'all', do: { op: 'search', data: 'data/jobs.json' } }] };
  const loaded = await loadToolData(appDir, forged);
  t.mock.restoreAll();
  assert.deepEqual(Object.keys(loaded.data), ['data/jobs.json']);
  assert.match(loaded.errors[0].text, /\.json のファイルだけ/);
  assert.equal(read.some((file) => file.endsWith('.js')), false, read.join('\n'));

  // app/ の外を指す宣言と、配列でない search のデータも読まない
  await fs.writeFile(path.join(appDir, 'data/object.json'), JSON.stringify({ not: 'array' }));
  const outside = await loadToolData(appDir, {
    tools: [{ name: 'out', do: { op: 'fixed', data: '../outside.json' } }, { name: 'obj', do: { op: 'search', data: 'data/object.json' } }],
  });
  assert.deepEqual(outside.data, {});
  assert.match(outside.errors.map((error) => error.text).join('\n'), /app\/ の外は指せません[\s\S]*オブジェクトの配列/);
});

test('ツールの口が読み込むのは、決まったモジュールだけ(S21)', async () => {
  const source = await fs.readFile(new URL('../../src/server/sim/tool-gate.js', import.meta.url), 'utf8');
  const imports = [...source.matchAll(/^import .* from '([^']+)';$/gm)].map((match) => match[1]);
  assert.deepEqual(imports, ['node:path', '../manifest.js', '../redact.js', './check.js']);
  // 動的な import、require、プロセス、ワーカーを使わない
  assert.doesNotMatch(source, /\bimport\(|\brequire\(|process\.|worker_threads|child_process|fetch\(/);
});

// node:fs の読み書きと、外への通信の口を、呼ぶと例外を出すものに替えて run を動かす。呼ばれた口の名前を返す
async function forbidSideEffects(t, run) {
  const touched = [];
  const targets = [
    ['fs', fsCallback],
    ['fs/promises', fs],
    ['http', http],
    ['https', https],
    ['net', net],
    ['tls', tls],
    ['dgram', dgram],
    ['child_process', childProcess],
    ['global', globalThis, ['fetch', 'WebSocket', 'EventSource']],
  ];
  const seen = new Set();
  for (const [label, target, only] of targets) {
    if (seen.has(target)) continue;
    seen.add(target);
    for (const key of only ?? Object.keys(target)) {
      const descriptor = Object.getOwnPropertyDescriptor(target, key);
      if (!descriptor || typeof descriptor.value !== 'function' || !descriptor.writable) continue;
      t.mock.method(target, key, () => {
        touched.push(`${label}.${key}`);
        throw new Error(`${label}.${key} は呼べません`);
      });
    }
  }
  syncBuiltinESMExports();
  try {
    await run();
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
  return touched;
}

test('どの op も、ファイルを読み書きせず、外へ通信しない(S21)', async (t) => {
  const { tools, data } = await setup(t);
  const outcomes = [];
  const touched = await forbidSideEffects(t, async () => {
    const context = { by: 'front', handoffs: HANDOFFS, assumption: { toolCalling: { delayMs: 1, faults: [{ tool: 'get_job', onCall: 2 }] } } };
    // 最後の get_job は 2 回目の呼び出しなので、前提の失敗に当たる
    const calls = [
      ['search_jobs', { area: 'みなと町' }],
      ['get_job', { id: 'j1' }],
      ['suggest_questions', {}],
      ['opening_hours', {}],
      ['record_consent', { agreed: true }],
      ['save_wish', { area: 'みなと町' }, { consent: { agreed: true } }],
      ['save_wish', { note: 'taro@example.com' }, { consent: { agreed: true } }],
      ['long_notice', {}],
      ['handoff_to_consult', { area: 'みなと町' }],
      ['get_job', { id: 'j1' }, {}, { get_job: 1 }],
    ];
    for (const [name, args, store = {}, counts = {}] of calls) {
      outcomes.push(await callTool({ tools, data, store, context: { ...context, calls: counts }, name, args }));
    }
  });
  assert.deepEqual(touched, []);
  // 止めた口の中でも、5 つの op が動き、守りと失敗も効いた
  assert.deepEqual(outcomes.map((outcome) => outcome.ok), [true, true, true, true, true, true, false, false, true, false]);
  assert.equal(outcomes.at(-1).fault, true);
});
