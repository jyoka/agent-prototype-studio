import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { FAKE_CLI } from '../../src/server/agent-connection.js';
import { BLUEPRINT, BuildRequests } from '../../src/server/build-requests.js';
import { describeBilling } from '../../src/server/claude-args.js';
import { STUDIO_ROOT } from '../../src/server/config.js';
import { ensureSampleProjects } from '../../src/server/projects.js';
import { ProjectStore } from '../../src/server/store.js';
import { ObserverBrowser } from '../../src/observer/browser.js';
import { Observer } from '../../src/observer/observe.js';

// 作る run の blueprint(docs/design/harness.md の 2.1、2.2、S9、S11)。
// 作る AI は偽接続(モデルを呼ばない)。観察器は、呼ぶ側が渡す observe 関数を差し替えて確かめる
const PROJECT = 'sample-library';
const ALL_NODES = BLUEPRINT.map((node) => node.name);
// 最初のラウンドで全関門が通った run の節の列。直す依頼の節(fix)は通らない
const PASSED_NODES = ALL_NODES.filter((name) => name !== 'fix');
const ENV = { PATH: process.env.PATH };

function fakeConnection() {
  return { kind: 'fake', label: '偽接続', command: process.execPath, prefixArgs: [FAKE_CLI], billing: describeBilling(ENV), problem: null };
}

function passedReport() {
  return { verdict: 'passed', reason: null, errors: [], load: { done: true, durationMs: 120 }, page: { text: '架空の図書室', empty: false }, screenshots: [] };
}

// 関門 G6 の report。基本のシナリオ 1 本が通った
function scenariosReport() {
  return { ...passedReport(), scenarios: [{ name: '起動して描画が空でなく、エラーがない', base: true, file: null, verdict: 'passed', steps: [], failed: null }] };
}

// observe は関門 G5 の観察、scenarios は関門 G6 の観察を差し替える
async function setup(t, { connection = fakeConnection(), observe, scenarios = scenariosReport, onNode, onAgentEvent } = {}) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-blueprint-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  await ensureSampleProjects(home, path.join(STUDIO_ROOT, 'samples'));
  const store = new ProjectStore(home);
  // Studio の起動と同じく、先に 1 回ビルドしておく
  await store.build(PROJECT);
  const calls = [];
  const scenarioCalls = [];
  const requests = new BuildRequests({
    store,
    connection,
    env: ENV,
    onNode,
    onAgentEvent,
    observe:
      observe === null
        ? null
        : async (id, options) => {
          if (options.gate === 'scenarios') {
            scenarioCalls.push({ id, ...options });
            return scenarios(id, options);
          }
          calls.push({ id, ...options });
          return (observe ?? passedReport)(id, options);
        },
  });
  const root = path.join(home, 'projects', PROJECT);
  const send = async (text) => {
    const started = await requests.start(PROJECT, text);
    return new Promise((resolve) => started.subscribe(() => {}, resolve));
  };
  const readRun = async (run) => JSON.parse(await fs.readFile(path.join(root, '.studio', 'runs', run.id, 'run.json'), 'utf8'));
  return { home, root, store, requests, calls, scenarioCalls, send, readRun };
}

const gateStatus = (record) => Object.fromEntries(record.gates.map((gate) => [gate.id, gate.status]));

test('作る AI の起動ごとに、Claude Code が返した費用とやりとりの回数を run.json に残し、渡した文と出力を onAgentEvent に渡す', async (t) => {
  const events = [];
  const { send, readRun } = await setup(t, { onAgentEvent: (event) => events.push(event) });
  const run = await send('見出しを「単体の図書室」にして');
  assert.equal(run.status, 'passed', JSON.stringify(run.items));

  const record = await readRun(run);
  const [launch] = record.agentLaunches.launches;
  // 偽接続も、本物と同じく result に total_cost_usd と num_turns を返す
  assert.equal(typeof launch.costUsd, 'number');
  assert.ok(Number.isInteger(launch.numTurns) && launch.numTurns > 0);
  assert.equal(record.agentLaunches.costUsd, launch.costUsd);

  // 確かめの記録用: 渡した文(依頼)と、stream-json の 1 行ずつ。どれも run とラウンドを持つ
  assert.deepEqual(events[0], { projectId: PROJECT, runId: run.id, round: 1, type: 'input', text: '見出しを「単体の図書室」にして' });
  const messages = events.filter((event) => event.type === 'message');
  assert.ok(messages.some((event) => event.message.type === 'result'));
  assert.ok(events.every((event) => event.runId === run.id && event.round === 1));
});

test('作る run は節の並びで動き、通った節の列と関門の結果を run.json に残す', async (t) => {
  const { root, calls, scenarioCalls, send, readRun } = await setup(t);
  const run = await send('見出しを「単体の図書室」にして');
  assert.equal(run.status, 'passed', JSON.stringify(run.items));

  const record = await readRun(run);
  assert.equal(record.format, 'prototype-studio-run');
  assert.equal(record.status, 'passed');
  assert.deepEqual(record.nodes.map((node) => node.name), PASSED_NODES);
  assert.deepEqual(record.nodes.map((node) => node.kind), BLUEPRINT.filter((node) => node.name !== 'fix').map((node) => node.kind));
  assert.ok(record.nodes.every((node) => node.outcome === 'passed' && node.durationMs >= 0), JSON.stringify(record.nodes));
  assert.deepEqual(gateStatus(record), { G1: 'passed', G2: 'passed', G3: 'passed', G4: 'passed', G5: 'passed', G6: 'passed' });
  assert.deepEqual(record.changedFiles, [{ file: 'app/App.jsx', change: 'modified' }]);
  // 作る AI の起動の回数と時間
  assert.equal(record.agentLaunches.count, 1);
  assert.ok(record.agentLaunches.durationMs > 0);
  assert.equal(record.agentLaunches.launches[0].outcome, 'passed');
  // 依頼の文は run.json に入れない
  assert.ok(!JSON.stringify(record).includes('単体の図書室'));

  // G5 は基本のシナリオなしで、3 つの画面幅を撮る。report は rounds/1/ に置く
  assert.equal(calls.length, 1);
  assert.equal(calls[0].gate, 'launch');
  assert.deepEqual(calls[0].viewports, ['mobile', 'tablet', 'desktop']);
  assert.equal(calls[0].outDir, path.join(root, '.studio', 'runs', run.id, 'rounds', '1'));
  // G6 はシナリオを回す。画面幅のスクリーンショットは撮らず、時間の上限を渡す。report は rounds/1/scenarios/ に置く
  assert.equal(scenarioCalls.length, 1);
  assert.deepEqual(scenarioCalls[0].viewports, []);
  assert.deepEqual(scenarioCalls[0].limits, { scenarioTimeoutMs: 60_000, observeTimeoutMs: 180_000 });
  assert.equal(scenarioCalls[0].outDir, path.join(root, '.studio', 'runs', run.id, 'rounds', '1', 'scenarios'));
  const reportFile = `.studio/runs/${run.id}/rounds/1/report.json`;
  const scenarioFile = `.studio/runs/${run.id}/rounds/1/scenarios/report.json`;
  assert.deepEqual(record.reports, [{ gate: 'G5', round: 1, file: reportFile }, { gate: 'G6', round: 1, file: scenarioFile }]);
  assert.equal(JSON.parse(await fs.readFile(path.join(root, reportFile), 'utf8')).verdict, 'passed');
  assert.equal(JSON.parse(await fs.readFile(path.join(root, scenarioFile), 'utf8')).scenarios.length, 1);
  assert.deepEqual(record.scenariosChanged, []);
  assert.deepEqual(run.evidence, { run: `.studio/runs/${run.id}/run.json` });

  // 作る会話には、関門の結果を短く出す
  assert.ok(run.items.some((item) => item.kind === 'launch-ok'));
  assert.equal(run.items.find((item) => item.kind === 'scenarios-ok').text, 'シナリオを確かめました。基本のシナリオ 1 本と、app/ のシナリオ 0 本が、すべて通りました(プロダクト内 AI はモック)。');
  const gates = run.items.find((item) => item.kind === 'gates');
  assert.equal(gates.text, 'Studio が確かめた結果: G1 変更の確認: 通った、G2 検査: 通った、G3 契約: 通った、G4 ビルド: 通った、G5 起動の確認: 通った、G6 シナリオ: 通った');
});

test('決まった節の間に呼ぶと例外を出す接続を渡しても、run が終わる', async (t) => {
  let current = null;
  const touched = [];
  const real = fakeConnection();
  // 作る AI の節(model)の外で触れると例外を出す。コンストラクタ(run の外)では触れてよい
  const connection = new Proxy(real, {
    get(target, key) {
      if (current && current.kind !== 'model') {
        touched.push(`${current.node}.${String(key)}`);
        throw new Error(`決まった節 ${current.node} で、作る AI の接続(${String(key)})に触れました`);
      }
      if (current) touched.push(`${current.node}.${String(key)}`);
      return target[key];
    },
  });
  const nodes = [];
  const { send, readRun } = await setup(t, {
    connection,
    onNode: (event) => {
      current = event;
      nodes.push(`${event.node}:${event.kind}`);
    },
  });
  const run = await send('見出しを「接続を守る図書室」にして');
  assert.equal(run.status, 'passed', JSON.stringify(run.items));
  assert.deepEqual(nodes, BLUEPRINT.filter((node) => node.name !== 'fix').map((node) => `${node.name}:${node.kind}`));
  // 接続に触れたのは作る AI の節だけ
  assert.ok(touched.length > 0);
  assert.ok(touched.every((key) => key.startsWith('agent.')), touched.join(', '));
  assert.deepEqual((await readRun(run)).nodes.map((node) => node.name), PASSED_NODES);

  // 守りが効くこと: 決まった節の間なら、接続に触れると例外になる
  current = { node: 'changes', kind: 'code' };
  assert.throws(() => connection.command, /決まった節 changes/);
});

test('ビルドが失敗したら、起動の確認を行わず、失敗した段で止める', async (t) => {
  const { store, calls, send, readRun } = await setup(t);
  const before = store.previewBuildId(PROJECT);
  // 直すラウンドでも直らない偽接続。どのラウンドもビルドで止まる
  const run = await send('壊して、直せないふりをして');
  assert.equal(run.status, 'failed');
  assert.equal(calls.length, 0, '起動の確認を行った');
  assert.equal(store.previewBuildId(PROJECT), before);

  const record = await readRun(run);
  assert.deepEqual(record.rounds[0].nodes, ['accept', 'fingerprint', 'agent', 'changes', 'inspect', 'contract', 'compile', 'fix']);
  assert.equal(record.nodes.find((node) => node.name === 'compile').outcome, 'failed');
  assert.deepEqual(gateStatus(record), { G1: 'passed', G2: 'passed', G3: 'passed', G4: 'failed', G5: 'skipped', G6: 'skipped' });
  assert.equal(record.build.stage, 'compile');
  const g4 = record.gates.find((gate) => gate.id === 'G4');
  assert.equal(g4.errors[0].file, 'app/App.jsx');
  assert.equal(g4.errors[0].line, 2);
  assert.ok(run.items.some((item) => item.kind === 'gates' && item.text.includes('G4 ビルド: 失敗')));
});

test('契約の誤りは G3 で止まり、ビルドと起動の確認を行わない', async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-blueprint-writer-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  // app/prototype.json を壊すだけの作る AI(偽物。モデルは呼ばない)
  const writer = path.join(home, 'writer.mjs');
  await fs.writeFile(
    writer,
    `import fs from 'node:fs';
     fs.readFileSync(0, 'utf8');
     fs.writeFileSync('prototype.json', '{ "formatVersion": 1,');
     console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'ok', permission_denials: [] }));`,
  );
  const { calls, send, readRun } = await setup(t, {
    connection: { kind: 'claude', label: '書くだけ', command: process.execPath, prefixArgs: [writer], billing: describeBilling(ENV), problem: null },
  });
  const run = await send('目録を書いて');
  assert.equal(run.status, 'failed');
  assert.equal(calls.length, 0);
  const record = await readRun(run);
  assert.deepEqual(gateStatus(record.rounds[0]), { G1: 'passed', G2: 'passed', G3: 'failed', G4: 'skipped', G5: 'skipped', G6: 'skipped' });
  assert.deepEqual(record.rounds[0].nodes, ['accept', 'fingerprint', 'agent', 'changes', 'inspect', 'contract', 'fix']);
  // 書くだけの作る AI は、直すラウンドで同じ中身を書くので app/ が変わらず、そこで止まる。前の失敗は結果に残る
  assert.deepEqual(record.rounds[1].nodes, ['agent', 'changes', 'evidence']);
  assert.deepEqual(gateStatus(record), { G1: 'unchanged', G2: 'passed', G3: 'failed', G4: 'skipped', G5: 'skipped', G6: 'skipped' });
  assert.equal(record.gates.find((gate) => gate.id === 'G3').errors[0].file, 'app/prototype.json');
});

test('ビルドが通って起動の確認で失敗したら、試す画面は新しいビルドにし、確かめで失敗ありと出す', async (t) => {
  const failed = () => ({
    ...passedReport(),
    verdict: 'failed',
    errors: [{ kind: 'runtime', message: '架空の在庫表が読めません', stack: '' }],
  });
  const { store, scenarioCalls, send, readRun } = await setup(t, { observe: failed });
  const before = store.previewBuildId(PROJECT);
  const run = await send('見出しを「起動で落ちる図書室」にして');
  assert.equal(run.status, 'failed');
  assert.notEqual(store.previewBuildId(PROJECT), before);
  assert.equal(run.build.buildId, store.previewBuildId(PROJECT));
  const item = run.items.find((i) => i.kind === 'launch-failed');
  assert.match(item.text, /^確かめで失敗あり: 起動の確認で実行時のエラーがありました\(架空の在庫表が読めません\)/);
  assert.match(item.text, /試す画面は新しいビルドにした/);
  const record = await readRun(run);
  assert.deepEqual(gateStatus(record.rounds[0]), { G1: 'passed', G2: 'passed', G3: 'passed', G4: 'passed', G5: 'failed', G6: 'skipped' });
  // 起動の確認が失敗した版では、シナリオの関門は行わない
  assert.equal(scenarioCalls.length, 0);
  // 偽接続は直す依頼を受けても直すところが見つからず、app/ を変えない。前の失敗は結果に残る
  assert.deepEqual(gateStatus(record), { G1: 'unchanged', G2: 'passed', G3: 'passed', G4: 'passed', G5: 'failed', G6: 'skipped' });
  assert.deepEqual(record.gates.find((gate) => gate.id === 'G5').errors, [{ kind: 'runtime', message: '架空の在庫表が読めません' }]);
});

test('エラーがなくても、画面が空なら起動の確認は失敗', async (t) => {
  const { send, readRun } = await setup(t, { observe: () => ({ ...passedReport(), page: { text: '', empty: true } }) });
  const run = await send('見出しを「空の図書室」にして');
  assert.equal(run.status, 'failed');
  assert.ok(run.items.some((item) => item.kind === 'launch-failed' && item.text.includes('画面に何も描かれていませんでした')));
  assert.equal(gateStatus(await readRun(run)).G5, 'failed');
});

test('観察器が使えない(Chromium がない)ときは、起動の確認を未確認にし、結果を unverified にする', async (t) => {
  // 本物の観察器に、起動できないブラウザを渡す
  const observer = new Observer({
    browser: new ObserverBrowser({
      launch: async () => {
        throw new Error("browserType.launch: Executable doesn't exist at /fictional/chromium");
      },
    }),
  });
  t.after(() => observer.close());
  let store;
  const env = await setup(t, {
    observe: (id, { viewports, outDir }) => {
      const project = store.entry(id);
      return observer.observe({
        build: { result: project.lastBuild, previewUrl: 'http://localhost:9/p/x/', hostUrl: 'http://127.0.0.1:9/observe.html' },
        viewports,
        outDir,
      });
    },
  });
  store = env.store;
  const run = await env.send('見出しを「未確認の図書室」にして');
  assert.equal(run.status, 'unverified');
  const record = await env.readRun(run);
  assert.deepEqual(gateStatus(record), { G1: 'passed', G2: 'passed', G3: 'passed', G4: 'passed', G5: 'unverified', G6: 'unverified' });
  assert.equal(record.gates.find((gate) => gate.id === 'G6').reason, '起動の確認が未確認なので、シナリオは回していません');
  const g5 = record.gates.find((gate) => gate.id === 'G5');
  assert.match(g5.reason, /Playwright の Chromium が見つかりません/);
  assert.match(g5.reason, /npm run install:chromium/);
  assert.ok(run.items.some((item) => item.kind === 'launch-unverified' && item.text.startsWith('起動は確かめていません(未確認)')));
});

test('観察器を渡さない Studio でも、起動の確認は未確認で、通ったとは扱わない', async (t) => {
  const { send } = await setup(t, { observe: null });
  const run = await send('見出しを「観察器のない図書室」にして');
  assert.equal(run.status, 'unverified');
  assert.equal(run.gates.find((gate) => gate.id === 'G5').status, 'unverified');
  assert.equal(run.gates.find((gate) => gate.id === 'G6').status, 'unverified');
});

test('app/ が変わらなければ unchanged で、関門 G2 から先は行わない', async (t) => {
  const { calls, send, readRun } = await setup(t);
  const run = await send('こんにちは');
  assert.equal(run.status, 'unchanged');
  assert.equal(calls.length, 0);
  const record = await readRun(run);
  assert.deepEqual(record.nodes.map((node) => node.name), ['accept', 'fingerprint', 'agent', 'changes', 'evidence']);
  assert.deepEqual(gateStatus(record), { G1: 'unchanged', G2: 'skipped', G3: 'skipped', G4: 'skipped', G5: 'skipped', G6: 'skipped' });
});

test('作る AI が失敗したら agent-failed。起動の回数と結果は run.json に残る', async (t) => {
  const { send, readRun } = await setup(t);
  const run = await send('失敗して');
  assert.equal(run.status, 'agent-failed');
  const record = await readRun(run);
  assert.equal(record.agentLaunches.count, 1);
  assert.equal(record.agentLaunches.launches[0].outcome, 'failed');
  assert.equal(record.nodes.find((node) => node.name === 'agent').outcome, 'failed');
});

test('起動の確認が通っても、シナリオの関門で観察器が使えなければ、G6 を未確認にし、結果を unverified にする', async (t) => {
  const { send, readRun } = await setup(t, {
    scenarios: () => ({ ...passedReport(), verdict: 'unverified', reason: '観察の途中で問題が起きました: ブラウザが落ちました', scenarios: [] }),
  });
  const run = await send('見出しを「シナリオ未確認の図書室」にして');
  assert.equal(run.status, 'unverified');
  const record = await readRun(run);
  assert.equal(gateStatus(record).G5, 'passed');
  assert.equal(gateStatus(record).G6, 'unverified');
  assert.ok(run.items.some((item) => item.kind === 'scenarios-unverified' && item.text === 'シナリオは確かめていません(未確認): 観察の途中で問題が起きました: ブラウザが落ちました'));
});
