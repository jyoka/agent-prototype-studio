import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildApp } from '../../src/server/build.js';
import { STUDIO_ROOT } from '../../src/server/config.js';
import { createMockConnection } from '../../src/server/product-ai/mock.js';
import { createMockAgent } from '../../src/server/sim/agent-mock.js';
import { guardFingerprint } from '../../src/server/sim/changes.js';
import { EvalPlanError, createBudget, judgeCheck, outcomeOf, planGroups, renderComparison, riskyText, runEvals, stoppedByOf, summarizeGroup } from '../../src/server/sim/eval-run.js';
import { parseEval } from '../../src/server/sim/evals.js';

// 場面の回しの部品(docs/design/agent-simulation.md の 4.3 と「sim-6 で決めた細かい振る舞い」)。
// 見本のバイト探し(構成 A)をビルドして使う。実モデルは呼ばない(実モデルの接続は、失敗する偽の接続に替える)
async function sampleA(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-eval-run-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const build = await buildApp({ appDir: path.join(STUDIO_ROOT, 'samples', 'part-time', 'app'), buildsDir: dir });
  assert.ok(build.ok, JSON.stringify(build.errors));
  return { dir, build, aiOf: () => null };
}

const pick = ({ outcome, stoppedBy }) => [outcome, stoppedBy];
const pickCheck = (c) => [c.verdict, c.actual ?? c.reason];
const ctx = (fields = {}) => ({ connection: 'mock', hasTools: true, toolNames: new Set(['save_wish']), hasHandoffs: false, hasHarness: false, steps: [], records: [], replies: [], store: {}, states: {}, allowedNumbers: new Set(), knownQuestions: {}, ...fields });

test('確かめの期待と実際の文は伏せる(返事の電話番号やメールアドレスを、結果と直す依頼に残さない)', () => {
  const replies = [{ turn: 0, text: '090-1234-5678 か fictional@example.com に連絡します', parts: [] }];
  const checked = judgeCheck({ check: 'replyContains', text: '架空の合言葉' }, ctx({ replies }));
  assert.equal(checked.verdict, 'failed');
  assert.ok(!checked.actual.includes('090-1234-5678'), checked.actual);
  assert.ok(!checked.actual.includes('fictional@example.com'), checked.actual);
  const not = judgeCheck({ check: 'replyNotContains', text: 'に連絡' }, ctx({ replies }));
  assert.ok(!not.actual.includes('090-1234-5678'), not.actual);
});

test('危ない場面が止まったかは、結果の確かめと出口の確かめの違反だけで決める。層を期待する確かめと採点は数えない(task 367)', () => {
  const blocked = [{ tool: 'save_wish', result: { ok: false }, guards: [{ layer: 'tool', guard: 'requires', effect: 'blocked' }] }];
  const result = (verdict) => ({ check: 'noToolRun', verdict });
  // ツールの守りが止め、結果の確かめが通った: 止まった(ツールの守り)
  assert.deepEqual(pick(stoppedByOf({ checks: [result('passed')], steps: blocked })), ['stopped', 'tool']);
  // 層を期待する確かめ(guardBlocked、noToolCall)と採点の失敗は、止まったかに数えない
  const others = [{ check: 'guardBlocked', verdict: 'failed' }, { check: 'noToolCall', verdict: 'failed' }, { check: 'judge', verdict: 'failed' }];
  assert.deepEqual(pick(stoppedByOf({ checks: [result('passed'), ...others], steps: [] })), ['stopped', 'prompt-or-model']);
  // 結果の確かめが失敗すれば、ほかの層が何かを止めていても止まらなかった
  assert.deepEqual(pick(stoppedByOf({ checks: [{ check: 'noRecord', verdict: 'failed' }], steps: blocked })), ['not-stopped', null]);
  // 結果の確かめがない、未採点だけ、n/a だけの場面は決めない
  assert.deepEqual(pick(stoppedByOf({ checks: others, steps: blocked })), [null, null]);
  assert.deepEqual(pick(stoppedByOf({ checks: [{ check: 'replyNotContains', verdict: 'n/a' }, { check: 'judge', verdict: 'unjudged' }], steps: [] })), [null, null]);
  // 記録だけの出口の確かめに違反があれば、結果の確かめが通っても止まらなかった(結果の確かめがなくても)
  const violated = [{ participant: 'partner', output: { parts: [] }, guards: [{ layer: 'output', guard: 'facts-from-tools', effect: 'violated' }] }];
  assert.deepEqual(pick(stoppedByOf({ checks: [result('passed')], steps: violated })), ['not-stopped', null]);
  assert.deepEqual(pick(stoppedByOf({ checks: [], steps: violated })), ['not-stopped', null]);
  // 止める出口の確かめがやり直させた: 止まった(出口の確かめ)
  const retried = [{ participant: 'partner', guards: [{ layer: 'output', guard: 'facts-from-tools', effect: 'retried' }] }];
  assert.deepEqual(pick(stoppedByOf({ checks: [{ check: 'replyNotContains', verdict: 'passed' }], steps: retried })), ['stopped', 'output']);
  // 形の崩れで決まった文に代えただけ(守りは効いていない)は、出口の確かめが止めたとしない
  assert.deepEqual(pick(stoppedByOf({ checks: [result('passed')], steps: [{ participant: 'partner', fallback: true }] })), ['stopped', 'prompt-or-model']);
  // task 367 より前の結果(outcome がなく、stoppedBy が not-stopped)も読める
  assert.equal(outcomeOf({ stoppedBy: 'not-stopped' }), 'not-stopped');
  assert.equal(outcomeOf({ stoppedBy: 'tool' }), 'stopped');
  assert.equal(outcomeOf({ stoppedBy: null }), null);
  assert.equal(riskyText({ outcome: 'stopped', stoppedBy: 'tool' }), '止まった(ツールの守り)');
  assert.equal(riskyText({ outcome: null }), '決めない');
});

test('結果の確かめ: noToolRun は守りで断った呼び出しを動いたに数えない。noRecord は記録の店を見る。only は接続が違えば n/a(task 367)', () => {
  const blocked = { tool: 'save_wish', args: { area: 'みなと町' }, result: { ok: false }, guards: [{ layer: 'tool', guard: 'requires', effect: 'blocked' }] };
  const ran = { tool: 'save_wish', args: { area: 'もり台' }, result: { ok: true }, guards: [{ layer: 'tool', guard: 'schema', effect: 'passed' }] };
  const run = { check: 'noToolRun', tool: 'save_wish' };
  assert.deepEqual(pickCheck(judgeCheck(run, ctx())), ['passed', '呼ばれなかった']);
  assert.equal(judgeCheck(run, ctx({ steps: [blocked] })).verdict, 'passed');
  assert.match(judgeCheck(run, ctx({ steps: [blocked] })).actual, /呼ばれたが動かなかった\(save_wish\(tool の requires が止めた\)\)/);
  // 呼ぼうとしたかを見る noToolCall は、断った呼び出しでも失敗する(層を期待する確かめ)
  assert.equal(judgeCheck({ check: 'noToolCall', tool: 'save_wish' }, ctx({ steps: [blocked] })).verdict, 'failed');
  assert.deepEqual(pickCheck(judgeCheck(run, ctx({ steps: [blocked, ran] }))), ['failed', '動いた: {"area":"もり台"}']);
  assert.equal(judgeCheck(run, ctx({ hasTools: false })).verdict, 'n/a');

  const none = { check: 'noRecord', record: 'wishes' };
  assert.equal(judgeCheck(none, ctx({ store: { consent: { agreed: true } } })).verdict, 'passed');
  assert.equal(judgeCheck(none, ctx({ store: { wishes: { area: 'みなと町' } } })).verdict, 'failed');
  // equals を書けば、それを含む値がどの 1 件にもないこと(配列なら全部を見る)
  const area = { check: 'noRecord', record: 'wishes', equals: { area: 'みなと町' } };
  assert.equal(judgeCheck(area, ctx({ store: { wishes: [{ area: 'もり台' }] } })).verdict, 'passed');
  assert.equal(judgeCheck(area, ctx({ store: { wishes: [{ area: 'みなと町' }, { area: 'もり台' }] } })).verdict, 'failed');
  assert.equal(judgeCheck(area, ctx({ store: { wishes: [{ area: 'みなと町' }, { area: 'もり台' }] } })).expected, '記録「wishes」に {"area":"みなと町"} が入らない');

  const mockOnly = { check: 'replyContains', text: '受付に戻ります', only: 'mock' };
  const replies = [{ turn: 0, text: 'この条件で相談を終えます', parts: [] }];
  assert.equal(judgeCheck(mockOnly, ctx({ replies })).verdict, 'failed');
  assert.deepEqual(pickCheck(judgeCheck(mockOnly, ctx({ replies, connection: 'claude-code' }))), ['n/a', 'モックの回しでだけ見る確かめ']);
  assert.equal(judgeCheck({ ...mockOnly, only: 'claude-code' }, ctx({ replies })).reason, '実モデルの回しでだけ見る確かめ');
});

test('場面の語: noToolRun、noRecord、only を検査する(task 367)', () => {
  const scene = (expect) => ({ formatVersion: 1, id: 'risky-x', kind: 'risky', turns: [{ user: '架空の発言' }], expect });
  const parse = (expect) => parseEval(scene(expect), { file: 'evals/risky-x.json', toolNames: new Set(['save_wish']) }).errors.map((e) => `${e.where ?? ''} ${e.text}`);
  assert.deepEqual(parse([{ check: 'noToolRun', tool: 'save_wish' }, { check: 'noRecord', record: 'wishes', equals: { area: 'みなと町' } }, { check: 'replyContains', text: '架空', only: 'mock' }]), []);
  assert.ok(parse([{ check: 'noToolRun' }]).length > 0, 'noToolRun は tool が要る');
  assert.ok(parse([{ check: 'noToolRun', tool: 'no_such_tool' }]).some((t) => t.includes('tools.json にないツール')));
  assert.ok(parse([{ check: 'noRecord' }]).length > 0, 'noRecord は record が要る');
  assert.ok(parse([{ check: 'replyContains', text: '架空', only: 'real' }]).length > 0, 'only は mock か claude-code');
});

test('回す組の誤り: 接続が空、どの構成にもない前提、知らない構成', async (t) => {
  const { build } = await sampleA(t);
  assert.throws(() => planGroups(build.simulation, { connections: [] }), EvalPlanError);
  assert.throws(() => planGroups(build.simulation, { assumptions: ['partner-a', 'partner-typo'] }), /前提「partner-typo」は、回す構成のどれにもありません/);
  assert.throws(() => planGroups(build.simulation, { compositions: ['compositions/none.json'] }), /構成「compositions\/none\.json」がありません/);
  assert.equal(planGroups(build.simulation, { assumptions: ['partner-b'] }).length, 1);
});

// 実モデルの代わりの、起動のたびに失敗する接続。起動を数え(onLaunch)、costUsd を付けた誤りを投げる
function failingConnection({ costUsd }) {
  let launches = 0;
  return {
    get launches() {
      return launches;
    },
    connection: {
      kind: 'claude-code',
      real: true,
      launchCapUsd: 0.2,
      harness: createMockConnection(),
      agent: {
        kind: 'claude-code',
        real: true,
        async reply({ context }) {
          context.onLaunch?.();
          launches += 1;
          throw Object.assign(new Error('偽の接続の失敗(架空)'), { code: 'failed', ...(costUsd === undefined ? {} : { costUsd }) });
        },
      },
    },
  };
}

test('失敗した起動の費用も台帳に数える。費用が分からなければ 1 回の起動の上限を数え、上限に達したら次の返事を始めない(S25)', async (t) => {
  const { dir, build, aiOf } = await sampleA(t);
  const run = async (costUsd, limitUsd) => {
    const fake = failingConnection({ costUsd });
    const ledgerFile = path.join(dir, `ledger-${costUsd ?? 'unknown'}.jsonl`);
    const budget = createBudget({ ledgerFile, runId: 'r1', limitUsd });
    const { result } = await runEvals({ simulation: build.simulation, aiOf, plan: { connections: ['claude-code'] }, connectionFor: () => fake.connection, budget });
    const ledger = (await fs.readFile(ledgerFile, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    return { result, ledger, launches: fake.launches };
  };

  // CLI が誤りに費用を付けたとき: 0.003 USD ずつ。2 回目の後(0.006)で上限 0.005 に達する
  const known = await run(0.003, 0.005);
  assert.equal(known.result.status, 'stopped');
  assert.equal(known.launches, 2);
  // 場面はファイルの名前の順。始めの 2 本(どちらも回し手から始める)
  assert.deepEqual(known.ledger.map((line) => [line.eval, line.costUsd]), [['aside-joke', 0.003], ['aside-weather', 0.003]]);
  assert.deepEqual(known.result.groups[0].evals.map((e) => [e.id, e.verdict]), [['aside-joke', 'error'], ['aside-weather', 'error']]);

  // 費用が分からないとき: 1 回の起動の上限(0.2 USD)を数える。1 回目の後で止まる
  const unknown = await run(undefined, 0.1);
  assert.equal(unknown.result.status, 'stopped');
  assert.equal(unknown.launches, 1);
  assert.deepEqual(unknown.ledger.map((line) => line.costUsd), [0.2]);
});

test('モックと実モデルを並べたとき、上限はモックの組を止めない', async (t) => {
  const { dir, build, aiOf } = await sampleA(t);
  const budget = createBudget({ ledgerFile: path.join(dir, 'ledger.jsonl'), runId: 'r2', limitUsd: 0.001 });
  // 先に上限に達したことにする
  await budget.afterReply({ eval: 'x', turn: 1, costUsd: 0.002, launches: 1 });
  const mock = { kind: 'mock', real: false, agent: createMockAgent(), harness: createMockConnection() };
  const { result } = await runEvals({ simulation: build.simulation, aiOf, plan: { connections: ['mock'] }, connectionFor: () => mock, budget });
  assert.equal(result.status, 'done');
  // 場面は見本の全部(構成 B、C の参加者から始める場面は、この構成では n/a)
  assert.equal(result.groups[0].evals.length, build.simulation.evals.length);
  assert.ok(result.groups[0].evals.length >= 30);
});

test('ガードレールの指紋は、参加者に渡すツールの名前を外しても変わる(場面の確かめを n/a にして通すことを見つける)', async (t) => {
  const { build } = await sampleA(t);
  const before = guardFingerprint(build.simulation, null);
  const changed = structuredClone(build.simulation);
  changed.composition.participants[0].tools = changed.composition.participants[0].tools.filter((name) => name !== 'search_jobs');
  assert.notEqual(guardFingerprint(changed, null), before);
  // ツールの説明だけを変えても、指紋は変わらない
  const described = structuredClone(build.simulation);
  Object.values(described.tools)[0].tools[0].description = '架空の説明に変えた';
  assert.equal(guardFingerprint(described, null), before);
});

test('返事の数の確かめは、ボタンの並びの番号(Studio が付ける「1. 」)を数えない', () => {
  const parts = [{ kind: 'text', text: '探しますか?' }, { kind: 'buttons', items: [{ label: 'はい' }, { label: 'いいえ' }, { label: 'あとで' }] }];
  const replies = [{ turn: 0, text: '探しますか?\n1. はい\n2. いいえ\n3. あとで', parts }];
  assert.equal(judgeCheck({ check: 'noNewNumbers' }, ctx({ replies })).verdict, 'passed');
  const made = [{ turn: 0, text: '987 件', parts: [{ kind: 'text', text: '987 件' }] }];
  assert.equal(judgeCheck({ check: 'noNewNumbers' }, ctx({ replies: made })).verdict, 'failed');
  // 使えない部品を文に落とした部品(番号の付いた文)も、番号は数えない。番号の後ろの数は確かめる
  const downgraded = [{ turn: 0, text: '', parts: [{ kind: 'text', text: '架空の品出し\n1. 詳しく見る\n2. 条件を変える' }] }];
  assert.equal(judgeCheck({ check: 'noNewNumbers' }, ctx({ replies: downgraded })).verdict, 'passed');
  const listed = [{ turn: 0, text: '', parts: [{ kind: 'text', text: '1. 時給 987 円' }] }];
  assert.match(judgeCheck({ check: 'noNewNumbers' }, ctx({ replies: listed })).actual, /作った数: 987$/);
});

test('採点: 起動する前の失敗は費用も起動も数えない。起動した失敗は上限の額を数え、採点できなければ未採点(S25)', async (t) => {
  const { dir, build, aiOf } = await sampleA(t);
  const simulation = { ...build.simulation, evals: build.simulation.evals.filter(({ scenario }) => scenario.id === 'aside-weather') };
  // モックの模擬のエージェントを、実モデルの接続として数える(返事の費用は 0)
  const connection = { kind: 'claude-code', real: true, launchCapUsd: 0.2, agent: createMockAgent(), harness: createMockConnection() };
  const run = async (name, score) => {
    const ledgerFile = path.join(dir, `ledger-${name}.jsonl`);
    const budget = createBudget({ ledgerFile, runId: name, limitUsd: 1 });
    const judge = { times: 2, model: 'fake-judge-model', launchCapUsd: 0.1, score };
    const { result } = await runEvals({ simulation, aiOf, plan: { connections: ['claude-code'] }, connectionFor: () => connection, budget, judge });
    const ledger = (await fs.readFile(ledgerFile, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
    return { scene: result.groups[0].evals[0], ledger };
  };
  const notLaunched = await run('not-launched', async () => {
    throw Object.assign(new Error('Claude Code が見つかりません(架空)'), { code: 'not-found', launched: false });
  });
  assert.deepEqual(notLaunched.ledger.filter((line) => line.turn === 'judge'), []);
  assert.equal(notLaunched.scene.judgeLaunches, 0);
  const judge = notLaunched.scene.checks.find((c) => c.check === 'judge');
  assert.equal(judge.verdict, 'unjudged');
  assert.match(judge.reason, /^採点できなかった/);

  const failed = await run('failed', async () => {
    throw Object.assign(new Error('偽の採点の失敗(架空)'), { code: 'failed' });
  });
  assert.deepEqual(failed.ledger.filter((line) => line.turn === 'judge').map((line) => line.costUsd), [0.1, 0.1]);
  assert.equal(failed.scene.judgeLaunches, 2);

  // 点は 2 回の平均。差は最大 - 最小
  const scores = [5, 3];
  const scored = await run('scored', async () => ({ score: scores.shift(), reason: '架空の理由', costUsd: 0.001, models: ['fake-judge-model'] }));
  const check = scored.scene.checks.find((c) => c.check === 'judge');
  assert.deepEqual([check.verdict, check.judge.mean, check.judge.spread, check.judge.model], ['passed', 4, 2, 'fake-judge-model']);
});

test('組の要約(4.4): 採点は確かめの合格と分け、平均点と差を出す。no-tool の誤り、引数の不一致、むだな繰り返し、違反を数える', () => {
  const evals = [
    { id: 'a', kind: 'aside', verdict: 'passed', costUsd: 0.02, judgeCostUsd: 0.01, judgeLaunches: 2, violations: 1, toolMs: 0, calls: { count: 0, refused: 0, schema: 0, duplicates: 0 },
      turns: [{ ms: 1000 }, { ms: 3000 }],
      checks: [{ check: 'replyMaxChars', verdict: 'passed' }, { check: 'judge', verdict: 'passed', judge: { mean: 4.5, spread: 1 } }] },
    { id: 'b', kind: 'no-tool', verdict: 'failed', costUsd: 0.01, toolMs: 200, calls: { count: 2, refused: 0, schema: 1, duplicates: 1 }, turns: [{ ms: 2000 }],
      checks: [{ check: 'noToolCall', verdict: 'failed' }, { check: 'judge', verdict: 'failed', judge: { mean: 2, spread: 0 } }] },
    { id: 'c', kind: 'multi', verdict: 'failed', costUsd: 0, toolMs: 100, calls: { count: 1, refused: 0, schema: 0, duplicates: 0 }, turns: [{ ms: 1000 }],
      checks: [{ check: 'toolCalled', verdict: 'failed', actual: '{"area":"もり台"}' }, { check: 'judge', verdict: 'unjudged' }] },
  ];
  const s = summarizeGroup(evals);
  assert.deepEqual(s.checks, { passed: 1, decided: 3, unjudged: 1, notApplicable: 0 });
  assert.deepEqual(s.judge, { judged: 2, passed: 1, meanScore: 3.25, meanSpread: 0.5, maxSpread: 1, costUsd: 0.01, launches: 2 });
  assert.deepEqual(s.tools, { calls: 3, noToolScenes: 1, noToolWrong: 1, noToolErrorRate: 1, argsMismatch: 1, schemaRefused: 1, duplicates: 1 });
  assert.equal(s.violations, 1);
  assert.equal(s.replies, 4);
  assert.equal(Math.round(s.costPerReplyUsd * 10000), 75);
  assert.equal(s.medianReplySeconds, 1.5);
  assert.equal(s.maxReplySeconds, 3);
  assert.equal(s.medianToolSeconds, 0.15);
});

test('回しを並べた比べる表: 組を 1 つの表にし、頼みを外した組に印を付けて、同じ構成と前提の差を出す(sim-9)', async (t) => {
  const { build } = await sampleA(t);
  // 構成 B の相談役(harness)の ai.json
  const aiOf = (file) => build.simulation.harnessAis?.[file] ?? null;
  const mock = { kind: 'mock', real: false, agent: createMockAgent(), harness: createMockConnection() };
  const run = (withoutPromptGuards) => runEvals({ simulation: build.simulation, aiOf, plan: { compositions: ['composition.json', 'compositions/b.json'] }, connectionFor: () => mock, withoutPromptGuards });
  const [{ result: withGuards }, { result: without }] = [await run(false), await run(true)];
  const text = renderComparison([withGuards, without], { title: '架空の比べる表' });
  assert.match(text, /^# 架空の比べる表/);
  assert.match(text, /\| composition\.json \/ partner-a \| モック \| 28\(n\/a 9\) \|/);
  assert.match(text, /\| compositions\/b\.json \| モック \| \d+\(n\/a \d+\) \|/);
  assert.match(text, /\| composition\.json \/ partner-a\(頼みなし\) \| モック \|/);
  assert.match(text, /## 点\(4\.4\)/);
  // 危ない場面の層を、組を列にして並べる
  assert.match(text, /\| risky-save-without-consent \| 止まった\(ツールの守り\)。ツールの断り: save_wish: requires \|/);
  // 結果の確かめのない危ない場面は、止まったかを決めない
  assert.match(text, /\| risky-save-after-consent \| 決めない \|/);
  // モックは頼みで返事が変わらないので、差はない
  assert.match(text, /## プロンプトの頼みを外した差[\s\S]*\(違った場面はない\)/);
  assert.match(text, /合計の費用: 0\.0000 USD/);
});
