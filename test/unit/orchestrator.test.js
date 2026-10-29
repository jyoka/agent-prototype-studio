import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { STUDIO_ROOT } from '../../src/server/config.js';
import { createMockConnection } from '../../src/server/product-ai/mock.js';
import { createMockAgent } from '../../src/server/sim/agent-mock.js';
import { OUTPUT_FALLBACK_TEXT, SimError, checkOutput, runTurn, startConversation } from '../../src/server/sim/orchestrator.js';
import { replySchema } from '../../src/server/sim/parts.js';
import { callTool } from '../../src/server/sim/tool-gate.js';
import { buildSim } from '../fixtures/sim.js';

// 会話の進め方(src/server/sim/orchestrator.js。docs/design/agent-simulation.md の 3.2、7.3 の sim-4)。
// 実モデルは呼ばない。模擬のエージェントはモック(app/mocks/*.json)か、テストの中の決まった接続。
// 試作品は test/fixtures/sim-a(構成 A)と sim-c(構成 C)。データはすべて架空

async function talk(sim, texts, { agent = createMockAgent(), harnessConnection = createMockConnection(), conversation = startConversation(sim), ...options } = {}) {
  const turns = [];
  for (const item of texts) {
    const input = typeof item === 'string' ? { text: item } : item;
    const result = await runTurn({ sim, conversation, input, agent, harnessConnection, ...options });
    conversation = result.conversation;
    turns.push(result);
  }
  return { conversation, turns };
}

const toolSteps = (record) => record.steps.filter((step) => step.tool !== undefined);
const outputSteps = (record) => record.steps.filter((step) => step.output !== undefined && step.attempt !== undefined);

test('構成 A: 回し手の模擬のエージェントが話し、ツールはツールの口を通る。引き継ぎはない(S16)', async (t) => {
  const sim = (await buildSim(t, 'sim-a')).prepare();
  const { conversation, turns } = await talk(sim, ['みなと町で探して']);
  const { record, said } = turns[0];
  assert.deepEqual(said.map((m) => m.from), ['partner']);
  assert.equal(conversation.active, 'partner');
  assert.equal(record.handoff, null);
  const [search] = toolSteps(record);
  assert.equal(search.tool, 'search_jobs');
  assert.equal(search.by, 'partner');
  assert.deepEqual(search.result, { ok: true, chars: search.result.chars, count: 2, keys: ['count', 'items'] });
  // 返事の型の置き換えは、ツールの結果の数と見出しだけ
  assert.equal(said[0].parts[0].text, '2件ありました。架空の品出し、架空の配膳');
  assert.deepEqual(conversation.calls, { search_jobs: 1 });
});

test('構成 C: 引き継ぎは辺で決まり、受け渡す値は相談役の項目の決まりで確かめて状態に入れる(S16)', async (t) => {
  const sim = (await buildSim(t, 'sim-c')).prepare();
  const { conversation, turns } = await talk(sim, ['相談したい']);
  const { record, said } = turns[0];
  assert.deepEqual(said.map((m) => m.from), ['front', 'consult']);
  assert.deepEqual(record.handoff, { from: 'front', to: 'consult', effect: 'passed', carry: { accepted: ['area'], rejected: [] } });
  assert.equal(conversation.harness.consult.state.area, 'みなと町');
  // 分かっている値は聞き直さず、未定の項目だけを聞く
  assert.match(said[1].text, /時給はいくら以上がよいですか/);
  assert.doesNotMatch(said[1].text, /どのあたりで働きたいですか/);
  assert.equal(conversation.active, 'consult');
  assert.equal(conversation.handoffs, 1);
  // 次の発言は、引き継いだ先が受ける
  const next = await runTurn({ sim, conversation, input: { text: '1200円以上' }, agent: createMockAgent(), harnessConnection: createMockConnection() });
  assert.ok(next.record.nodes.includes('harness:consult'));
  assert.ok(!next.record.nodes.includes('agent:front'));
});

test('受け渡す値が項目の決まりに合わなければ、状態に入れずに記録に残す', async (t) => {
  const sim = (await buildSim(t, 'sim-c')).prepare();
  const { conversation, turns } = await talk(sim, ['範囲外の相談']);
  assert.deepEqual(turns[0].record.handoff.carry, {
    accepted: [],
    rejected: [
      { key: 'area', reason: '項目の決まりに合わない値' },
      { key: 'minWage', reason: '項目の決まりに合わない値' },
    ],
  });
  assert.deepEqual(conversation.harness.consult.state, { area: null, minWage: null });
});

test('辺にない引き継ぎは、モデルが頼んでもツールの守りが断り、話す参加者は替わらない', async (t) => {
  const sim = (await buildSim(t, 'sim-c')).prepare();
  sim.composition.handoffs = sim.composition.handoffs.filter((edge) => edge.to !== 'staff');
  const { conversation, turns } = await talk(sim, ['体調が悪い']);
  const [step] = toolSteps(turns[0].record);
  assert.equal(step.tool, 'handoff_to_staff');
  assert.deepEqual(step.guards.map((g) => [g.guard, g.effect]), [['schema', 'passed'], ['handoff', 'blocked']]);
  assert.equal(turns[0].record.handoff, null);
  assert.equal(conversation.active, 'front');
});

test('引き継ぎは 1 ターン 1 回。引き継いだ先がさらに引き継ごうとしても、そのターンでは断る', async (t) => {
  const sim = (await buildSim(t, 'sim-c')).prepare();
  // 担当者を、受付に戻すツールを持つ模擬のエージェントにする(テストの中だけ)
  sim.toolset = { ...sim.toolset, tools: [...sim.toolset.tools, { ...sim.toolset.tools[1], name: 'handoff_to_front', do: { op: 'handoff', to: 'front' } }] };
  const staff = sim.composition.participants.find((p) => p.id === 'staff');
  Object.assign(staff, { kind: 'agent', prompt: [], tools: ['handoff_to_front'], mock: 'mocks/staff.json' });
  sim.mocks.set('mocks/staff.json', {
    file: 'mocks/staff.json',
    rules: [{ when: { contains: ['体調'] }, call: { tool: 'handoff_to_front', args: {} }, reply: [{ kind: 'text', text: '受付に戻します。' }] }],
    otherwise: [{ kind: 'text', text: '担当です。' }],
  });
  sim.composition.handoffs.push({ from: 'staff', to: 'front', carry: [] });
  const { conversation, turns } = await talk(sim, ['体調が悪い']);
  const { record, said } = turns[0];
  assert.deepEqual(said.map((m) => m.from), ['front', 'staff']);
  assert.deepEqual(record.handoff.refused, { to: 'front', reason: '1 ターンで引き継げるのは 1 回まで' });
  assert.equal(conversation.active, 'staff');
  assert.equal(conversation.handoffs, 1);
});

test('1 つの会話の引き継ぎは limits.maxHandoffs まで。戻るのも引き継ぎに数える', async (t) => {
  const sim = (await buildSim(t, 'sim-c')).prepare();
  sim.composition.limits = { ...sim.composition.limits, maxHandoffs: 1 };
  // 1 回目: 受付 → 相談役。相談役は渡した値だけで終わるが、戻る引き継ぎは上限で止まる
  const { conversation, turns } = await talk(sim, ['全部お願い']);
  assert.equal(turns[0].record.handoff.effect, 'passed');
  assert.equal(turns[0].record.returned.effect, 'blocked');
  assert.equal(conversation.active, 'consult');

  const none = (await buildSim(t, 'sim-c')).prepare();
  none.composition.limits = { ...none.composition.limits, maxHandoffs: 0 };
  const blocked = await talk(none, ['体調が悪い']);
  assert.equal(blocked.turns[0].record.handoff.effect, 'blocked');
  assert.match(blocked.turns[0].record.handoff.reason, /limits\.maxHandoffs/);
  assert.equal(blocked.conversation.active, 'front');
  assert.deepEqual(blocked.turns[0].said.map((m) => m.from), ['front']);
});

test('会話のターンは limits.maxTurns まで。超えたら回さずに止める', async (t) => {
  const sim = (await buildSim(t, 'sim-a')).prepare();
  sim.composition.limits = { ...sim.composition.limits, maxTurns: 1 };
  const { conversation } = await talk(sim, ['こんにちは']);
  await assert.rejects(
    runTurn({ sim, conversation, input: { text: 'もう一度' }, agent: createMockAgent(), harnessConnection: createMockConnection() }),
    (error) => error instanceof SimError && error.code === 'too-long',
  );
});

test('1 ターンはコードで決めた節の並びで回り、通った節が記録に残る。決まった節の間にモデルを呼ぶと例外を出す接続でも、ターンが終わる(S9)', async (t) => {
  const sim = (await buildSim(t, 'sim-c')).prepare();
  let current = null;
  const onNode = (name) => (current = name);
  const guard = (prefix) => {
    if (!current?.startsWith(prefix)) throw new Error(`決まった節「${current}」の間にモデルを呼びました`);
  };
  const mockAgent = createMockAgent();
  const agent = { ...mockAgent, reply: async (input) => (guard('agent:'), mockAgent.reply(input)) };
  const mock = createMockConnection();
  const harnessConnection = { ...mock, extract: (input) => (guard('harness:'), mock.extract(input)), phrase: (input) => (guard('harness:'), mock.phrase(input)) };
  const { turns } = await talk(sim, ['相談したい', '1200円以上'], { agent, harnessConnection, onNode });
  assert.deepEqual(turns[0].record.nodes, ['accept', 'prompt:front', 'agent:front', 'surface:front', 'output:front', 'handoff', 'harness:consult', 'reply']);
  assert.deepEqual(turns[1].record.nodes, ['accept', 'harness:consult', 'handoff', 'reply']);
});

test('引き継いだ先の harness がそのターンで done になっても、そのターンに話すのは 1 回だけで、次の発言は戻り先が受ける(2.5)', async (t) => {
  const sim = (await buildSim(t, 'sim-c')).prepare();
  const { conversation, turns } = await talk(sim, ['全部お願い']);
  const { record, said } = turns[0];
  // 受付が引き継ぎ、相談役が渡した値だけで終わる。受付はこのターンでもう話さない
  assert.deepEqual(said.map((m) => m.from), ['front', 'consult']);
  assert.equal(record.nodes.filter((name) => name === 'agent:front').length, 1);
  assert.equal(conversation.harness.consult.progress.done, true);
  assert.deepEqual(record.returned, { from: 'consult', to: 'front', effect: 'passed' });
  assert.equal(conversation.active, 'front');
  assert.equal(conversation.handoffs, 2);
  const next = await runTurn({ sim, conversation, input: { text: 'こんにちは' }, agent: createMockAgent(), harnessConnection: createMockConnection() });
  assert.deepEqual(next.said.map((m) => m.from), ['front']);
  assert.equal(next.said[0].text, 'ご用件をどうぞ。');
});

test('前提の messageTypes から返事の形を作り、合わない部品を文に落として記録する。前提の id と指紋が記録に残る(S17、S23)', async (t) => {
  const fixture = await buildSim(t, 'sim-a');
  const a = fixture.prepare();
  const b = fixture.prepare({ assumptionId: 'partner-b' });
  const kinds = (sim) => replySchema(sim.assumption).properties.parts.items.anyOf.map((variant) => variant.properties.kind.const);
  assert.deepEqual(kinds(a), ['text', 'buttons']);
  assert.deepEqual(kinds(b), ['text']);

  // partner-a はカードを描けないので、カードは文に落ちる。ボタンは残る
  const withA = await talk(a, ['詳しく']);
  const [out] = outputSteps(withA.turns[0].record);
  assert.deepEqual(out.output.parts, [{ kind: 'text' }]);
  assert.deepEqual(
    out.guards.filter((g) => g.layer === 'surface').map((g) => [g.guard, g.effect, g.from, g.to]),
    [['surface-downgrade', 'replaced', 'card', 'text']],
  );
  assert.equal(withA.turns[0].said[0].parts[0].text, '架空の品出し\nみなと町の求人です。\n1. 保存する');
  const searchA = await talk(a, ['探して']);
  assert.deepEqual(searchA.turns[0].said[0].parts.map((p) => p.kind), ['text', 'buttons']);

  // partner-b は文だけ。ボタンも文に落ちる。結果の上限(60 文字)で、ツールの口が結果を返さない
  const searchB = await talk(b, ['探して']);
  assert.deepEqual(searchB.turns[0].said[0].parts.map((p) => p.kind), ['text']);
  assert.equal(toolSteps(searchB.turns[0].record)[0].guards.at(-1).guard, 'maxResultChars');

  assert.equal(withA.turns[0].record.assumptions.id, 'partner-a');
  assert.equal(searchB.turns[0].record.assumptions.id, 'partner-b');
  assert.match(withA.turns[0].record.assumptions.digest, /^sha256:[0-9a-f]{64}$/);
  assert.notEqual(withA.turns[0].record.assumptions.digest, searchB.turns[0].record.assumptions.digest);
  assert.equal(withA.turns[0].record.assumptions.standIn, true);
});

test('出口の確かめ: enforce が false なら記録だけ、true なら 1 回やり直し、だめなら型の文にする(S18)', async (t) => {
  const fixture = await buildSim(t, 'sim-a');
  const recorded = await talk(fixture.prepare(), ['作り話して']);
  const [out] = outputSteps(recorded.turns[0].record);
  assert.deepEqual(out.guards, [{ layer: 'output', guard: 'facts-from-tools', effect: 'violated', owner: 'partner', failed: ['noNewNumbers'] }]);
  assert.equal(recorded.turns[0].said[0].text, '時給は 987 円です。');

  const enforced = fixture.prepare();
  enforced.composition.guards = enforced.composition.guards.map((g) => (g.layer === 'output' ? { ...g, enforce: true } : g));
  let calls = 0;
  const mock = createMockAgent();
  const agent = { ...mock, reply: (input) => ((calls += 1), mock.reply(input)) };
  const replaced = await talk(enforced, ['作り話して'], { agent });
  assert.equal(calls, 2);
  const outs = outputSteps(replaced.turns[0].record);
  assert.deepEqual(outs.map((o) => o.guards.map((g) => g.effect)), [['retried'], ['replaced']]);
  assert.equal(replaced.turns[0].said[0].text, OUTPUT_FALLBACK_TEXT);

  // ツールの結果に出た数は、作った数にしない
  const passed = await talk(enforced, ['探して']);
  assert.deepEqual(outputSteps(passed.turns[0].record)[0].guards.map((g) => g.effect), ['passed']);
});

test('モックと、別のプロセスでツールを呼ぶ形の接続で、同じツールの呼び出しなら、ツールの結果と守りの判定の列が同じ(S19)', async (t) => {
  const fixture = await buildSim(t, 'sim-a');
  const texts = ['探して', '詳しく', { text: '保存する', action: 'save' }, '保存してよいです', { text: '保存する', action: 'save' }, '電話して'];
  const viaMock = await talk(fixture.prepare(), texts);

  // Claude Code の接続と同じ返し方(呼び出しの記録、新しい店と数をまとめて返す)をする接続。ツールの口は自分で呼ぶ
  const mockAgent = createMockAgent();
  const outOfProcess = {
    kind: 'scripted',
    real: false,
    async reply({ mock, input, turns, context }) {
      let { store, calls } = context;
      const steps = [];
      const results = [];
      const sim = fixture.prepare();
      const tools = {
        async call(name, args) {
          const outcome = await callTool({
            tools: sim.toolset,
            data: sim.toolData,
            store,
            context: { conversationId: context.conversationId, by: context.by, calls, assumption: context.assumption, handoffs: context.handoffs },
            name,
            args,
          });
          ({ store, calls } = outcome);
          steps.push(outcome.entry);
          if (outcome.ok) results.push(outcome.result);
          return outcome;
        },
      };
      const { parts } = await mockAgent.reply({ mock, input, turns, tools });
      return { output: { parts }, steps, results, store, calls };
    },
  };
  const viaScripted = await talk(fixture.prepare(), texts, { agent: outOfProcess });
  const shape = (turns) => turns.flatMap((turn) => toolSteps(turn.record)).map(({ tool, by, args, result, guards }) => ({ tool, by, args, result, guards }));
  assert.deepEqual(shape(viaScripted.turns), shape(viaMock.turns));
  assert.deepEqual(viaScripted.conversation.store, viaMock.conversation.store);
  // 同意の前の保存は requires で、電話番号は deny で止まる
  const guards = shape(viaMock.turns).map((step) => `${step.tool}:${step.guards.filter((g) => g.effect === 'blocked').map((g) => g.guard).join(',')}`);
  assert.deepEqual(guards, ['search_jobs:', 'get_job:hideFields', 'save_wish:requires', 'record_consent:', 'save_wish:', 'save_wish:deny']);
});

test('止める出口の確かめで決まった文に代えた返事の引き継ぎは使わない。記録の店と呼び出しの数は残る', async (t) => {
  const sim = (await buildSim(t, 'sim-c')).prepare();
  // 受付に、作った数を禁じる止める確かめを付け、引き継ぐ返事に数を入れる(テストの中だけ)
  sim.composition.guards.push({ id: 'no-numbers', layer: 'output', owner: 'partner', on: 'front', enforce: true, rules: { noNewNumbers: true, forbidden: [] } });
  const mock = sim.mocks.get('mocks/front.json');
  mock.rules[3] = { ...mock.rules[3], reply: [{ kind: 'text', text: '担当者 987 番におつなぎします。' }] };
  const { conversation, turns } = await talk(sim, ['体調が悪い']);
  const { record, said } = turns[0];
  assert.deepEqual(said.map((m) => [m.from, m.text]), [['front', OUTPUT_FALLBACK_TEXT]]);
  assert.equal(record.handoff, null);
  assert.equal(conversation.active, 'front');
  assert.ok(record.steps.some((step) => step.handoffIgnored?.includes('staff')));
  // やり直した回も、ツールは本当に呼ばれている
  assert.deepEqual(conversation.calls, { handoff_to_staff: 2 });
});

// 見本のバイト探し(構成 A)の出口の確かめ no-contact-in-reply(記録だけ。jyoka/tasks#366)。
// 返事に出た連絡先と住所らしい文字を、違反として記録に残す。普通の返事と、ツールの断りの文は違反にしない
test('見本の構成 A の出口の確かめは、返事の連絡先と住所らしい文字を違反にする(架空)', async () => {
  const composition = JSON.parse(await fs.readFile(path.join(STUDIO_ROOT, 'samples', 'part-time', 'app', 'composition.json'), 'utf8'));
  const guard = composition.guards.find((g) => g.id === 'no-contact-in-reply');
  assert.equal(guard.layer, 'output');
  assert.equal(guard.enforce, false);
  const failed = (text) => checkOutput(text, guard.rules, new Set()).map((f) => f.rule);
  for (const text of ['090-0000-1111 を保存しました', 'taro@example.com に送ります', 'かわせみ町１－２－３ ですね', 'かわせみ町2丁目3番地ですね', '〒000-0000 ですね']) {
    assert.deepEqual(failed(text), ['forbidden'], text);
  }
  for (const text of [
    'みなと町では3件ありました。',
    '住所は保存できません。保存できるのは、場所のおおまかな希望(駅の近く、町の名前など)、時給の下限、働き方の希望だけです',
    '電話番号やメールアドレスは、このトークでは伺いません。希望の条件だけ教えてください。',
    '話してくれてありがとうございます。ひとりで抱えこまないでください。こもれび相談窓口(架空)では、働くときの悩みや体のことを、人が話を聞きます。',
    '土日の 10-18 時の求人を探します',
  ]) {
    assert.deepEqual(failed(text), [], text);
  }
});
