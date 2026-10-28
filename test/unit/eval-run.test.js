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
import { EvalPlanError, createBudget, judgeCheck, planGroups, runEvals, stoppedByOf } from '../../src/server/sim/eval-run.js';

// 場面の回しの部品(docs/design/agent-simulation.md の 4.3 と「sim-6 で決めた細かい振る舞い」)。
// 見本のバイト探し(構成 A)をビルドして使う。実モデルは呼ばない(実モデルの接続は、失敗する偽の接続に替える)
async function sampleA(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-eval-run-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const build = await buildApp({ appDir: path.join(STUDIO_ROOT, 'samples', 'part-time', 'app'), buildsDir: dir });
  assert.ok(build.ok, JSON.stringify(build.errors));
  return { dir, build, aiOf: () => null };
}

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

test('危ない場面の効いた層は、確かめが通ったときだけ決める。未採点だけの場面は決めない', () => {
  const blocked = [{ tool: 'save_wish', guards: [{ layer: 'tool', guard: 'requires', effect: 'blocked' }] }];
  assert.equal(stoppedByOf({ verdict: 'passed', steps: blocked }).stoppedBy, 'tool');
  assert.equal(stoppedByOf({ verdict: 'unjudged', steps: [] }).stoppedBy, null);
  assert.equal(stoppedByOf({ verdict: 'n/a', steps: [] }).stoppedBy, null);
  assert.equal(stoppedByOf({ verdict: 'failed', steps: blocked }).stoppedBy, 'not-stopped');
  // 記録だけの出口の確かめに違反があれば、確かめが通っても止まらなかった
  const violated = [{ participant: 'partner', output: { parts: [] }, guards: [{ layer: 'output', guard: 'facts-from-tools', effect: 'violated' }] }];
  assert.equal(stoppedByOf({ verdict: 'passed', steps: violated }).stoppedBy, 'not-stopped');
  // 形の崩れで決まった文に代えただけ(守りは効いていない)は、出口の確かめが止めたとしない
  assert.equal(stoppedByOf({ verdict: 'passed', steps: [{ participant: 'partner', fallback: true }] }).stoppedBy, 'prompt-or-model');
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
  assert.deepEqual(known.ledger.map((line) => [line.eval, line.costUsd]), [['aside-weather', 0.003], ['correct-area', 0.003]]);
  assert.deepEqual(known.result.groups[0].evals.map((e) => [e.id, e.verdict]), [['aside-weather', 'error'], ['correct-area', 'error']]);

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
  assert.equal(result.groups[0].evals.length, 12);
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
