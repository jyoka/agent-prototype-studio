import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildApp } from '../../src/server/build.js';
import { STUDIO_ROOT } from '../../src/server/config.js';
import { createMockConnection } from '../../src/server/product-ai/mock.js';
import { agentStdin } from '../../src/server/sim/agent-claude-code.js';
import { createMockAgent } from '../../src/server/sim/agent-mock.js';
import { describeSimulationChanges, guardFingerprint } from '../../src/server/sim/changes.js';
import { DELEGATION_FALLBACK_TEXT, prepareSimulation, runTurn, startConversation } from '../../src/server/sim/orchestrator.js';
import { callTool } from '../../src/server/sim/tool-gate.js';

// マスターとサブの委任(docs/design/agent-simulation.md の 2.9)。親の AI が子の AI に仕事を任せ、結果を受け取って続ける。
// 任せるかと依頼の文はモデルが決め、辺、深さ(limits.maxDepth)、1 ターンの回数(limits.maxDelegations)はコードが守る。
// 実モデルは呼ばない。見本は samples/redelivery(架空のしおかぜ便)の compositions/master-sub.json。データはすべて架空

const MASTER_SUB = 'compositions/master-sub.json';

async function buildSample(t, edit = async () => {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-delegate-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const appDir = path.join(root, 'app');
  await fs.cp(path.join(STUDIO_ROOT, 'samples', 'redelivery', 'app'), appDir, { recursive: true });
  await edit(appDir);
  const built = await buildApp({ appDir, buildsDir: path.join(root, 'builds') });
  const prepare = () => {
    assert.ok(built.ok, JSON.stringify(built.errors));
    const aiOf = (file) => built.simulation.harnessAis?.[file] ?? (file === built.manifest.ai ? built.ai : null);
    const composition = built.simulation.compositions.find((item) => item.file === MASTER_SUB).composition;
    return prepareSimulation({ ...built.simulation, composition }, { aiOf, dataNumbers: built.dataNumbers ?? [] });
  };
  return { built, prepare };
}

const editJson = (file, change) => async (appDir) => {
  const at = path.join(appDir, file);
  const raw = JSON.parse(await fs.readFile(at, 'utf8'));
  change(raw);
  await fs.writeFile(at, JSON.stringify(raw));
};
const editAll = (...edits) => async (appDir) => {
  for (const edit of edits) await edit(appDir);
};
const participant = (raw, id) => raw.participants.find((p) => p.id === id);

async function talk(sim, texts, { agent = createMockAgent(), conversation = startConversation(sim) } = {}) {
  const turns = [];
  for (const text of texts) {
    const result = await runTurn({ sim, conversation, input: { text }, agent, harnessConnection: createMockConnection() });
    conversation = result.conversation;
    turns.push(result);
  }
  return { conversation, turns };
}

const toolSteps = (record) => record.steps.filter((step) => step.tool !== undefined);
const agentSteps = (record) => record.steps.filter((step) => step.kind === 'agent');

const errorsOf = async (t, edit) => {
  const { built } = await buildSample(t, edit);
  assert.equal(built.ok, false, '検査で誤りになるはず');
  return built.errors.map((error) => error.text).join('\n');
};

test('見本のマスターとサブ: マスターが荷物の係に任せ、結果を受け取って続ける。記録に親子が出る', async (t) => {
  const { prepare } = await buildSample(t);
  const sim = prepare();
  assert.deepEqual(sim.composition.limits, { maxTurns: 12, maxHandoffs: 1, maxDelegations: 2, maxDepth: 1 });
  const { conversation, turns } = await talk(sim, ['番号は 1001 です']);
  const { record, said } = turns[0];
  // 利用者に見えるのはマスターの 2 回目の返事だけ。サブの返事と、任せた途中の返事は見せない
  assert.deepEqual(said.map((m) => m.from), ['desk-master']);
  assert.equal(said[0].text, 'りんごの箱のお荷物が見つかりました。お届けは本日です。希望の時間帯を教えてください。');
  assert.equal(conversation.active, 'desk-master');
  assert.deepEqual(record.delegations, [{ from: 'desk-master', to: 'parcel-sub', depth: 1, round: 1, effect: 'passed', reply: { chars: 27 } }]);
  assert.deepEqual(agentSteps(record).map((step) => [step.participant, step.depth, step.parent ?? null, step.round]), [
    ['desk-master', 0, null, 1],
    ['parcel-sub', 1, 'desk-master', 1],
    ['desk-master', 0, null, 2],
  ]);
  // 荷物を引いたのはサブ。マスターは委任のツールだけを呼んだ
  assert.deepEqual(toolSteps(record).map((step) => [step.tool, step.by, step.result.ok]), [
    ['ask_parcel_desk', 'desk-master', true],
    ['get_parcel', 'parcel-sub', true],
  ]);
  assert.deepEqual(toolSteps(record)[0].delegate, { to: 'parcel-sub' });
  assert.deepEqual(record.nodes, [
    'accept',
    'prompt:desk-master', 'agent:desk-master', 'surface:desk-master', 'output:desk-master',
    'delegate:parcel-sub',
    'prompt:parcel-sub', 'agent:parcel-sub', 'surface:parcel-sub', 'output:parcel-sub',
    'prompt:desk-master', 'agent:desk-master', 'surface:desk-master', 'output:desk-master',
    'handoff', 'reply',
  ]);
});

test('1 ターンの回数の上限を超えた委任は止まる。サブは上限の回数だけ動き、マスターには断りが返る', async (t) => {
  // 結果を受け取った後の決まりを外す: マスターは結果を受け取っても、同じ発言でまた任せ続ける
  const { prepare } = await buildSample(t, editJson('mocks/desk-master.json', (raw) => {
    raw.rules = raw.rules.filter((rule) => rule.when.delegated === undefined);
  }));
  const sim = prepare();
  const { turns } = await talk(sim, ['番号は 1001 です']);
  const { record, said } = turns[0];
  assert.deepEqual(record.delegations.map((d) => [d.to, d.round, d.effect]), [
    ['parcel-sub', 1, 'passed'],
    ['parcel-sub', 2, 'passed'],
  ]);
  const tools = toolSteps(record);
  assert.equal(tools.filter((step) => step.tool === 'get_parcel').length, 2);
  // 3 回目の頼みは、ツールの口が limits.maxDelegations で断る。サブは動かない
  const refused = tools.filter((step) => step.tool === 'ask_parcel_desk').at(-1);
  assert.equal(refused.result.ok, false);
  assert.deepEqual(refused.guards.at(-1), { layer: 'tool', guard: 'maxDelegations', effect: 'blocked', owner: 'shiokaze', reason: refused.guards.at(-1).reason });
  assert.match(said[0].text, /委任の回数の上限/);
  assert.equal(agentSteps(record).filter((step) => step.participant === 'parcel-sub').length, 2);
  // 上限は次のターンで数え直す
  const next = await runTurn({ sim, conversation: turns[0].conversation, input: { text: '番号は 1001 です' }, agent: createMockAgent(), harnessConnection: createMockConnection() });
  assert.equal(next.record.delegations.filter((d) => d.effect === 'passed').length, 2);
});

test('深さの上限を超えた委任は止まる。サブがさらに任せようとしても、孫は動かない', async (t) => {
  // 荷物の係にも、予約の係へ任せるツールと辺を渡す
  const nested = (maxDepth) => editAll(
    editJson(MASTER_SUB, (raw) => {
      participant(raw, 'parcel-sub').tools.push('ask_booking_desk');
      raw.delegations.push({ from: 'parcel-sub', to: 'booking-sub' });
      raw.limits.maxDepth = maxDepth;
      raw.limits.maxDelegations = 3;
    }),
    editJson('mocks/parcel-sub.json', (raw) => {
      raw.rules.unshift(
        { when: { delegated: 'booking-sub' }, reply: [{ kind: 'text', text: '{delegated.text}' }] },
        { when: { contains: ['1001'] }, call: { tool: 'ask_booking_desk', args: { task: '本人が内容を確かめて「はい」と言いました。同意を記録してください' } }, reply: [{ kind: 'text', text: '予約の係に頼みます。' }] },
      );
    }),
  );
  // 深さ 1 の構成では、この辺は検査で止まる(使われない辺)。動くときの止まり方を見るため、深さ 2 で読んだ構成の上限を 1 に下げる
  assert.match(await errorsOf(t, nested(1)), /この辺の委任は深さ 2 で、limits\.maxDepth\(1\)を超えます/);
  const shallow = (await buildSample(t, nested(2))).prepare();
  shallow.composition.limits.maxDepth = 1;
  const { turns } = await talk(shallow, ['番号は 1001 です']);
  const { record } = turns[0];
  assert.deepEqual(record.delegations.map((d) => [d.from, d.to, d.depth, d.effect]), [['desk-master', 'parcel-sub', 1, 'passed']]);
  const refused = toolSteps(record).find((step) => step.tool === 'ask_booking_desk');
  assert.equal(refused.by, 'parcel-sub');
  assert.equal(refused.guards.at(-1).guard, 'maxDepth');
  assert.equal(refused.guards.at(-1).effect, 'blocked');
  assert.ok(!agentSteps(record).some((step) => step.participant === 'booking-sub'), '孫(booking-sub)は動かない');
  assert.equal(turns[0].conversation.store.consent, undefined);

  // 深さを 2 にすると、同じ頼みが通り、孫が深さ 2 で動く
  const deep = (await buildSample(t, nested(2))).prepare();
  const passed = (await talk(deep, ['番号は 1001 です'])).turns[0];
  assert.deepEqual(passed.record.delegations.map((d) => [d.from, d.to, d.depth, d.effect]), [
    ['desk-master', 'parcel-sub', 1, 'passed'],
    ['parcel-sub', 'booking-sub', 2, 'passed'],
  ]);
  assert.deepEqual(agentSteps(passed.record).find((step) => step.participant === 'booking-sub').parent, 'parcel-sub');
  assert.deepEqual(passed.conversation.store.consent, { agreed: true });
});

test('別のプロセスの接続が上限を超えた委任を返しても、会話の進め方が止め、決まった文に代える', async (t) => {
  const sim = (await buildSample(t)).prepare();
  const seen = [];
  // Claude Code の接続と同じく、委任の頼みを返事の後にまとめて返す接続(ツールの口を通らない)
  const agent = {
    kind: 'scripted',
    real: false,
    async reply({ participant: who }) {
      seen.push(who.id);
      if (who.id !== 'desk-master') return { parts: [{ kind: 'text', text: '調べました。' }] };
      return {
        parts: [{ kind: 'text', text: 'お調べします。' }],
        delegations: [
          { to: 'parcel-sub', task: '荷物 1001 を調べてください', carry: { parcel_no: 1001, extra: 'x' } },
          { to: 'staff', task: '人に任せる', carry: {} },
          { to: 'parcel-sub', task: '荷物 1001 を調べてください', carry: {} },
          { to: 'parcel-sub', task: '荷物 1001 を調べてください', carry: {} },
        ],
      };
    },
  };
  const { turns } = await talk(sim, ['番号は 1001 です'], { agent });
  const { record, said } = turns[0];
  assert.deepEqual(record.delegations.map((d) => [d.to, d.round, d.effect, d.reason ?? null]), [
    ['parcel-sub', 1, 'passed', null],
    ['staff', 1, 'blocked', '構成の delegations にない委任'],
    ['parcel-sub', 1, 'passed', null],
    ['parcel-sub', 1, 'blocked', '1 ターンの委任は 2 回まで(limits.maxDelegations)'],
    // 結果を受け取ったマスターがまた全部を頼んでも、回数を使い切ったので 1 つも通らない
    ['parcel-sub', 2, 'blocked', '1 ターンの委任は 2 回まで(limits.maxDelegations)'],
    ['staff', 2, 'blocked', '構成の delegations にない委任'],
    ['parcel-sub', 2, 'blocked', '1 ターンの委任は 2 回まで(limits.maxDelegations)'],
    ['parcel-sub', 2, 'blocked', '1 ターンの委任は 2 回まで(limits.maxDelegations)'],
  ]);
  assert.deepEqual(seen, ['desk-master', 'parcel-sub', 'parcel-sub', 'desk-master']);
  assert.equal(said[0].text, DELEGATION_FALLBACK_TEXT);
  assert.ok(record.steps.some((step) => step.fallback && step.participant === 'desk-master'));
});

test('サブは渡されたツールだけを使う。ほかの参加者のツールは許可の層で断り、記録の店は変わらない', async (t) => {
  const sim = (await buildSample(t)).prepare();
  // モックの決まりは構成の検査で参加者の tools に縛られるので、ここでは決まった接続で、渡していないツールを呼ばせる
  const calls = { 'parcel-sub': [['save_redelivery', { parcel_no: 1001, slot: '午前中' }], ['handoff_to_staff', {}], ['ask_booking_desk', { task: '書いて' }], ['get_parcel', { parcel_no: 1001 }]] };
  const given = {};
  const agent = {
    kind: 'scripted',
    real: false,
    async reply({ participant: who, tools, stdin }) {
      given[who.id] = { tools: who.tools, stdin };
      for (const [name, args] of calls[who.id] ?? []) await tools.call(name, args);
      if (who.id === 'desk-master' && !stdin.includes('<任せた仕事の結果>')) await tools.call('ask_parcel_desk', { task: '荷物 1001 を調べてください', parcel_no: 1001 });
      return { parts: [{ kind: 'text', text: '分かりました。' }] };
    },
  };
  const { turns, conversation } = await talk(sim, ['番号は 1001 です'], { agent });
  const byParcel = toolSteps(turns[0].record).filter((step) => step.by === 'parcel-sub');
  assert.deepEqual(byParcel.map((step) => [step.tool, step.result.ok, step.guards.at(-1).layer, step.guards.at(-1).guard]), [
    ['save_redelivery', false, 'permission', 'allowedTools'],
    ['handoff_to_staff', false, 'permission', 'allowedTools'],
    ['ask_booking_desk', false, 'permission', 'allowedTools'],
    ['get_parcel', true, 'tool', 'maxResultChars'],
  ]);
  assert.equal(conversation.store.redelivery, undefined);
  assert.equal(turns[0].record.handoff, null);
  assert.equal(turns[0].record.delegations.length, 1);
  // サブに渡すのは、その参加者のツールの名前と、依頼の文と辺の carry の値だけ。会話の全体は渡さない(辺の history が false)
  assert.deepEqual(given['parcel-sub'].tools, ['get_parcel']);
  assert.match(given['parcel-sub'].stdin, /<依頼の文>\n荷物 1001 を調べてください\n<\/依頼の文>/);
  assert.match(given['parcel-sub'].stdin, /- parcel_no: 1001/);
  assert.doesNotMatch(given['parcel-sub'].stdin, /<これまでの会話>|<新しい発言>|番号は 1001 です/);
  // マスターの 2 回目には、サブの結果が届く
  assert.match(given['desk-master'].stdin, /<任せた仕事の結果>\n\[荷物の係\(サブ、模擬\)\] 分かりました。\n<\/任せた仕事の結果>/);
});

test('辺の history が true なら、サブにも会話の全体を渡す', () => {
  const stdin = agentStdin({
    messages: [{ role: 'user', text: '前の発言' }],
    labels: { master: '受付' },
    input: { text: '調べて', action: null },
    task: { from: 'master', task: '調べて', carry: {} },
    withHistory: true,
  });
  assert.match(stdin, /<これまでの会話>\n\[利用者\] 前の発言\n<\/これまでの会話>/);
  assert.match(stdin, /受付 から任された仕事です/);
  assert.doesNotMatch(stdin, /<新しい発言>/);
});

test('委任のツールは、構成の辺がなければツールの口が断る(会話の進め方の外から呼んでも、辺を渡せば同じ)', async (t) => {
  const { built } = await buildSample(t);
  const toolset = built.simulation.tools['tools.json'];
  const context = { by: 'desk-master', delegations: [{ from: 'desk-master', to: 'booking-sub', carry: [], history: false }], depthLeft: 1, delegationsLeft: 2 };
  const refused = await callTool({ tools: toolset, context, name: 'ask_parcel_desk', args: { task: '調べて', parcel_no: 1001 } });
  assert.equal(refused.ok, false);
  assert.equal(refused.guards.at(-1).guard, 'delegate');
  const passed = await callTool({
    tools: toolset,
    context: { ...context, delegations: [{ from: 'desk-master', to: 'parcel-sub', carry: [], history: false }] },
    name: 'ask_parcel_desk',
    args: { task: '調べて', parcel_no: 1001 },
  });
  assert.equal(passed.ok, true);
  // carry に書いていない引数は渡さない
  assert.deepEqual(passed.delegate, { to: 'parcel-sub', task: '調べて', carry: {} });
  assert.deepEqual(passed.entry.delegate, { to: 'parcel-sub' });
});

test('検査: 委任の辺、委任のツール、上限、サブの置き場の誤りを書いた時点で止める', async (t) => {
  const cases = [
    [editJson(MASTER_SUB, (raw) => { raw.delegations = raw.delegations.filter((e) => e.to !== 'booking-sub'); }), /委任のツール「ask_booking_desk」は辺にありません/],
    [editJson(MASTER_SUB, (raw) => { raw.delegations.push({ from: 'desk-master', to: 'staff' }); }), /委任は agent の参加者どうしだけで書けます/],
    [editJson(MASTER_SUB, (raw) => { raw.driver = 'parcel-sub'; }), /任される参加者\(delegations の to\)は回し手になれません/],
    [editJson(MASTER_SUB, (raw) => { raw.handoffs.push({ from: 'parcel-sub', to: 'staff' }); }), /任される参加者\(delegations の to\)は、会話を引き継げません/],
    [editJson(MASTER_SUB, (raw) => { raw.delegations[0].carry.push('slot'); }), /「slot」は「parcel-sub」へ任せる委任のツールの引数にありません/],
    [editJson(MASTER_SUB, (raw) => { raw.delegations[0].carry.push('task'); }), /依頼の文\(task\)は、いつもサブに渡します/],
    [editJson(MASTER_SUB, (raw) => { raw.limits.maxDepth = 4; }), /limits\.maxDepth/],
    [editJson(MASTER_SUB, (raw) => { participant(raw, 'booking-sub').tools.push('ask_parcel_desk'); raw.delegations.push({ from: 'booking-sub', to: 'parcel-sub' }); }), /この辺の委任は深さ 2 で、limits\.maxDepth\(1\)を超えます/],
    [editJson(MASTER_SUB, (raw) => { raw.limits.maxDelegations = 11; }), /limits\.maxDelegations/],
    [editJson('compositions/single-agent.json', (raw) => { raw.limits.maxDepth = 1; }), /委任の上限は、委任の辺\(delegations\)を書いた構成にだけ書けます/],
    [editJson(MASTER_SUB, (raw) => { participant(raw, 'desk-master').tools = participant(raw, 'desk-master').tools.filter((name) => name !== 'ask_booking_desk'); }), /「desk-master」の tools に、「booking-sub」へ任せる委任のツール\(op: delegate\)がありません/],
    [editJson('tools.json', (raw) => { delete raw.tools.find((tool) => tool.name === 'ask_parcel_desk').inputSchema.properties.task.maxLength; }), /委任のツールは、inputSchema の properties に/],
    [editJson('tools.json', (raw) => { raw.tools.find((tool) => tool.name === 'ask_parcel_desk').inputSchema.required = ['parcel_no']; }), /「task」を required に入れてください/],
    [editJson('mocks/parcel-sub.json', (raw) => { raw.rules[0].when.delegated = 'booking-sub'; }), /この参加者が任せる先\(delegations の to\)ではありません/],
    [editJson('mocks/parcel-sub.json', (raw) => { raw.otherwise[0].text = '{delegated.text}'; }), /when に delegated を書いた決まりの返事でだけ使えます/],
    [editJson('composition.json', (raw) => { raw.participants[0].flow[0].calls[0].tool = 'ask_parcel_desk'; }), /流れから委任のツールは呼べません/],
  ];
  for (const [edit, pattern] of cases) assert.match(await errorsOf(t, edit), pattern);
});

test('今の構成は委任の項目を持たない(R2)。委任の上限を緩めると、守りが減ったとして出す', async (t) => {
  const { built } = await buildSample(t);
  const single = built.simulation.compositions.find((item) => item.file === 'compositions/single-agent.json').composition;
  assert.equal(single.delegations, undefined);
  assert.deepEqual(single.limits, { maxTurns: 12, maxHandoffs: 1 });
  assert.equal(built.simulation.composition.delegations, undefined);

  const loose = await buildSample(t, editJson(MASTER_SUB, (raw) => {
    raw.limits.maxDelegations = 5;
    raw.delegations[1].history = true;
  }));
  const changes = describeSimulationChanges(built.simulation, loose.built.simulation);
  const text = JSON.stringify(changes);
  assert.match(text, /1 ターンの委任の回数の上限\(limits\.maxDelegations\)を緩めた: 2 → 5/);
  assert.match(text, /会話の全体を渡すか\(history\): false → true/);
  assert.notEqual(guardFingerprint(built.simulation, built.ai), guardFingerprint(loose.built.simulation, loose.built.ai));
});
