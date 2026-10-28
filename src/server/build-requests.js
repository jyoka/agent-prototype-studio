import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { startAgentProcess, STOP_STEPS_MS } from './agent-process.js';
import { diffSnapshots, MAX_SNAPSHOT_ENTRIES, snapshotApp } from './app-snapshot.js';
import { buildClaudeArgs, DEFAULT_MAX_BUDGET_USD, MAX_TURNS, OBSERVE_TOOLS, writeObserveMcpConfig } from './claude-args.js';
import { describeStep } from '../observer/scenario.js';
import { buildFixPrompt, describeFailure, ERROR_KIND_TEXT } from './fix-prompt.js';
import { AI_FILE, describeDefinitionChanges } from './product-ai/definition.js';
import { RealAiConsent } from './real-ai.js';
import { readMessage } from './stream-json.js';
import { describeSimulationChanges, referencedFiles, weakenedAiRules } from './sim/changes.js';

export const MAX_REQUEST_CHARS = 4000;
export const DEFAULT_AGENT_TIMEOUT_MS = 10 * 60_000;
const MAX_RUNS_PER_PROJECT = 20;
const MAX_ITEMS_PER_RUN = 300;
// 作る AI の出力から作る項目。数が多いときに省くのはこれだけで、Studio の結果の項目は省かない
const AGENT_ITEM_KINDS = new Set(['assistant', 'tool', 'tool-error']);
const LOGIN_PATTERN = /not logged in|please run \/login|invalid api key|authentication_error|oauth token has expired/i;
const MAX_GATE_ERRORS = 20;
const MAX_GATE_TEXT = 1000;
// 起動の確認で撮る画面幅。証拠のスクリーンショットになる
const LAUNCH_VIEWPORTS = ['mobile', 'tablet', 'desktop'];
// 関門 G6 の時間の上限: シナリオ 1 本と、関門の全体(harness.md の 2.2)。超えたら、その関門の失敗
export const SCENARIO_GATE_LIMITS = Object.freeze({ scenarioTimeoutMs: 60_000, gateTimeoutMs: 3 * 60_000 });
// 関門 G6 の結果に残す、失敗したシナリオの数と、そのときの画面の文字の長さ
const MAX_GATE_FAILURES = 20;
const MAX_FAILURE_PAGE_TEXT = 2000;
export const RUN_FORMAT = 'prototype-studio-run';
// 直すラウンドの上限。作る AI の起動は、1 つの依頼で最初の 1 回と合わせて 3 回まで(harness.md の 2.2、2026-10-28 の決定)
export const MAX_FIX_ROUNDS = 2;

// 作る run の節の並び(blueprint。docs/design/harness.md の 2.1、2.2)。
// kind が code の節は決まった手順で、作る AI の接続(this.connection)に触れない。触れるのは model の節だけ。
// 関門は安い順に回し、失敗した段で止める(S11)。G2〜G4 は buildApp の 1 回の呼び出しで、誤りの段の名前で分ける。
// 関門が失敗したら、節 fix が直す依頼を作り、作る AI の節に戻す(直すラウンド。MAX_FIX_ROUNDS 回まで)。直した後は G1 から回し直す
export const BLUEPRINT = Object.freeze([
  { name: 'accept', kind: 'code', label: '受け付け' },
  { name: 'fingerprint', kind: 'code', label: '前の指紋' },
  { name: 'agent', kind: 'model', label: '作る AI' },
  { name: 'changes', kind: 'code', gate: 'G1', label: '変更の確認' },
  { name: 'inspect', kind: 'code', gate: 'G2', label: '検査' },
  { name: 'contract', kind: 'code', gate: 'G3', label: '契約' },
  { name: 'compile', kind: 'code', gate: 'G4', label: 'ビルド' },
  { name: 'launch', kind: 'code', gate: 'G5', label: '起動の確認' },
  { name: 'scenarios', kind: 'code', gate: 'G6', label: 'シナリオ' },
  { name: 'fix', kind: 'code', label: '直す依頼' },
  { name: 'evidence', kind: 'code', label: '証拠をまとめる' },
].map((node) => Object.freeze(node)));
const NODES = new Map(BLUEPRINT.map((node) => [node.name, node]));
const GATES = BLUEPRINT.filter((node) => node.gate);
const BUILD_GATES = ['inspect', 'contract', 'compile'];
const GATE_STATUS_TEXT = { passed: '通った', failed: '失敗', unverified: '未確認', unchanged: '変更なし', skipped: '行わない' };

const clip = (value, max = MAX_GATE_TEXT) => String(value ?? '').slice(0, max);
const GATE_TIMEOUT = Symbol('gate-timeout');
const freshGates = () => GATES.map((node) => ({ id: node.gate, name: node.name, label: node.label, status: 'skipped' }));
// ビルドの誤りを、関門の結果に残す形にする
const gateErrors = (errors) =>
  errors.slice(0, MAX_GATE_ERRORS).map((e) => ({ file: e.file, line: e.line ?? null, column: e.column ?? null, text: clip(e.text) }));

// 失敗の指紋。依頼の前から同じ失敗が出ていたかを比べる。行と列は、前後の行が変わるとずれるので入れない
function failureSignature(gate) {
  const errors = [
    ...(gate.failures ?? []).map((f) => `${f.file ?? ''} ${f.scenario} ${f.step ?? ''} ${f.actual}`),
    ...(gate.errors ?? []).map((e) => (e.text !== undefined ? `${e.file} ${e.text}` : `${e.kind} ${e.message}`)),
  ].sort();
  return JSON.stringify([gate.name, errors.length > 0 ? errors : [gate.summary ?? '']]);
}

// 関門 G5 の結果を、観察器の report から決める。report がなければ未確認
function launchGate(report, reason) {
  if (!report) return { status: 'unverified', reason };
  const errors = (report.errors ?? []).slice(0, MAX_GATE_ERRORS).map((e) => ({ kind: e.kind, message: clip(e.message) }));
  const base = { verdict: report.verdict, loadMs: report.load?.durationMs ?? null, errorCount: report.errors?.length ?? 0, errors };
  if (report.verdict === 'unverified') return { ...base, status: 'unverified', reason: report.reason ?? '観察器が理由を返しませんでした' };
  if (report.verdict === 'failed') {
    const first = errors[0];
    const summary = first ? `起動の確認で${ERROR_KIND_TEXT[first.kind] ?? first.kind}がありました(${clip(first.message, 200)})` : '起動の確認で失敗しました';
    return { ...base, status: 'failed', summary: errors.length > 1 ? `${summary}。ほか ${errors.length - 1} 件` : summary };
  }
  if (!report.page) return { ...base, status: 'unverified', reason: '試作品の画面を読めませんでした' };
  if (report.page.empty) return { ...base, status: 'failed', summary: '起動の確認で、画面に何も描かれていませんでした' };
  return { ...base, status: 'passed' };
}

// 関門 G6 の結果を、観察器の report から決める。report がなければ未確認。
// 失敗したシナリオごとに、名前、失敗した手順、期待と実際、そのときの画面の文字を残す(直す依頼に入れる)
function scenarioGate(report, reason) {
  if (!report) return { status: 'unverified', reason };
  const scenarios = report.scenarios ?? [];
  const errors = (report.errors ?? []).slice(0, MAX_GATE_ERRORS).map((e) => ({ kind: e.kind, message: clip(e.message) }));
  const failed = scenarios.filter((scenario) => scenario.verdict !== 'passed');
  const failures = failed.slice(0, MAX_GATE_FAILURES).map((scenario) => {
    const n = scenario.failed?.step ?? null;
    const step = n ? scenario.steps?.[n - 1]?.step : null;
    return {
      scenario: clip(scenario.name, 200),
      file: scenario.file ?? null,
      base: scenario.base === true,
      step: n,
      expected: step ? clip(describeStep(step), 300) : null,
      actual: clip(scenario.failed?.message ?? 'シナリオが通りませんでした'),
      pageText: scenario.failed?.pageText ? clip(scenario.failed.pageText.replace(/\s+/g, ' ').trim(), MAX_FAILURE_PAGE_TEXT) : null,
    };
  });
  const base = {
    verdict: report.verdict,
    scenarioCount: scenarios.length,
    baseCount: scenarios.filter((scenario) => scenario.base).length,
    failedCount: failed.length,
    failures,
    errorCount: report.errors?.length ?? 0,
    errors,
  };
  if (report.verdict === 'unverified') return { ...base, status: 'unverified', reason: report.reason ?? '観察器が理由を返しませんでした' };
  if (report.verdict !== 'failed' && scenarios.length > 0) return { ...base, status: 'passed' };
  if (report.verdict !== 'failed') return { ...base, status: 'unverified', reason: 'シナリオを回せませんでした' };
  const first = failures[0];
  let summary;
  if (first) {
    const where = first.step ? `の ${first.step} 番目の手順` : '';
    summary = `シナリオ「${first.scenario}」${where}で失敗しました(${clip(first.actual, 200)})`;
    if (failed.length > 1) summary += `。ほか ${failed.length - 1} 本`;
  } else if (errors[0]) {
    summary = `シナリオの間に${ERROR_KIND_TEXT[errors[0].kind] ?? errors[0].kind}がありました(${clip(errors[0].message, 200)})`;
  } else {
    summary = 'シナリオの確かめで失敗しました';
  }
  return { ...base, status: 'failed', summary };
}

// 関門の結果から、run の結果の状態を決める(harness.md の 2.4)。作る AI を止めたときと失敗したとき、
// 直すラウンドで app/ が変わらなかったときは、その節で決まる
function finalStatus(gates, round) {
  const by = Object.fromEntries(gates.map((gate) => [gate.name, gate.status]));
  if (by.changes === 'unchanged') return 'unchanged';
  if (gates.some((gate) => gate.status === 'failed')) return 'failed';
  if (by.launch === 'unverified' || by.scenarios === 'unverified') return 'unverified';
  return round > 1 ? 'fixed' : 'passed';
}

export class RequestError extends Error {}
export class AgentUnavailableError extends Error {}

// 作る欄の依頼を受け、作る run を blueprint の節の順に回す。
// 作る AI の節(model)と、決まった節(code)を分ける(ADR-0001、Stripe の Minions)。
// observe(id, { gate, viewports, outDir, limits }) は、表示中のビルドを観察器で開き、report を返す関数。
// gate が 'launch' なら関門 G5(基本のシナリオなし)、'scenarios' なら関門 G6(app/ のシナリオと基本のシナリオを、
// プロダクト内 AI をモックにして回す)。なければ G5 と G6 は未確認になる。
// scenarioLimits は G6 の時間の上限(SCENARIO_GATE_LIMITS)。onNode({ projectId, runId, node, kind }) は、節に入るたびに呼ぶ(確かめ用)。
// onAgentEvent({ projectId, runId, round, type, ... }) は、作る AI に渡した文(type: 'input'、text)と、
// 作る AI の stream-json の 1 行(type: 'message'、message)ごとに呼ぶ(実機の確かめの記録用。scripts/check-loop.js)
// 構成、ツール、前提、モック、場面、プロンプトの枠のファイル(docs/design/agent-simulation.md の 2.1 の置き場所)
const SIMULATION_FILES = ['app/composition.json', 'app/tools.json'];
const SIMULATION_FOLDERS = ['app/compositions/', 'app/assumptions/', 'app/mocks/', 'app/evals/', 'app/prompts/'];
const isSimulationFile = (file) => SIMULATION_FILES.includes(file) || SIMULATION_FOLDERS.some((folder) => file.startsWith(folder));

export class BuildRequests {
  constructor({
    store,
    connection,
    observe = null,
    env = process.env,
    log = () => {},
    onNode = () => {},
    onAgentEvent = () => {},
    timeoutMs = DEFAULT_AGENT_TIMEOUT_MS,
    scenarioLimits = SCENARIO_GATE_LIMITS,
    maxBudgetUsd = DEFAULT_MAX_BUDGET_USD,
    consent = new RealAiConsent(),
  }) {
    this.store = store;
    this.connection = connection;
    // 本物の AI を使う前の同意(real-ai.js)。接続が Claude Code のときだけ、送る前に確かめる。偽接続は同意なしで使える
    this.consent = consent;
    // 決まった節が使う、接続の名前と問題。決まった節は、ここだけを見る
    this.agentLabel = connection.label;
    this.agentProblem = connection.problem;
    this.observe = observe;
    this.env = env;
    this.log = log;
    this.onNode = onNode;
    this.onAgentEvent = onAgentEvent;
    this.timeoutMs = timeoutMs;
    this.scenarioLimits = { ...SCENARIO_GATE_LIMITS, ...scenarioLimits };
    this.maxBudgetUsd = maxBudgetUsd;
    this.runs = new Map();
    this.active = new Map();
    this.versions = new Map();
    // プロジェクトごとの、表示中のビルドの起動の確認かシナリオの失敗(依頼の前から同じ失敗が出ていたかを比べる)
    this.launchFailures = new Map();
    this.closing = false;
  }

  summary(id) {
    return { running: this.active.has(id), version: this.versions.get(id) ?? 0 };
  }

  list(id) {
    return (this.runs.get(id) ?? []).map((run) => structuredClone(run));
  }

  touch(id, run) {
    this.versions.set(id, (this.versions.get(id) ?? 0) + 1);
    this.active.get(id)?.emitter.emit('update', structuredClone(run));
  }

  addItem(id, run, kind, text) {
    if (AGENT_ITEM_KINDS.has(kind) && run.items.filter((item) => AGENT_ITEM_KINDS.has(item.kind)).length >= MAX_ITEMS_PER_RUN) {
      if (!run.items.some((item) => item.kind === 'skipped')) {
        run.items.push({ kind: 'skipped', text: '作る AI の知らせが多すぎるので、ここから先は省きます。', at: new Date().toISOString() });
        this.touch(id, run);
      }
      return;
    }
    run.items.push({ kind, text, at: new Date().toISOString() });
    this.touch(id, run);
  }

  // 節に入る。終わったら、返す関数に結果(outcome)を渡すと、通った節の列に残る
  enterNode(id, run, name) {
    const node = NODES.get(name);
    const started = Date.now();
    // 節 fix は終わるときに次のラウンドへ進めるので、ラウンドの番号は入るときにとる
    const round = run.round;
    this.onNode({ projectId: id, runId: run.id, node: node.name, kind: node.kind });
    return (outcome) => {
      run.nodes.push({ name: node.name, kind: node.kind, ...(node.gate ? { gate: node.gate } : {}), round, startedAt: new Date(started).toISOString(), durationMs: Date.now() - started, outcome });
    };
  }

  setGate(run, name, fields) {
    const gate = run.gates.find((g) => g.name === name);
    Object.assign(gate, fields);
  }

  // 節 accept: 依頼を受けて実行を始める。返す subscribe で、実行の様子を受け取れる。
  async start(id, requestText) {
    const acceptedAt = Date.now();
    const request = typeof requestText === 'string' ? requestText.trim() : '';
    if (!request) throw new RequestError('依頼を書いてください');
    if (request.length > MAX_REQUEST_CHARS) throw new RequestError(`依頼は ${MAX_REQUEST_CHARS} 文字までにしてください`);
    if (this.closing) throw new AgentUnavailableError('Studio を止めているところです');
    const paths = await this.store.requireProject(id);
    if (this.closing) throw new AgentUnavailableError('Studio を止めているところです');
    if (this.agentProblem) throw new AgentUnavailableError(this.agentProblem);
    if (this.connection.kind === 'claude') this.consent.require('fix');
    this.store.claimRun(id);

    const run = {
      id: crypto.randomBytes(8).toString('hex'),
      request,
      agent: this.agentLabel,
      status: 'running',
      startedAt: new Date(acceptedAt).toISOString(),
      finishedAt: null,
      auth: null,
      items: [],
      changedFiles: [],
      build: null,
      // 通った節の列と、関門ごとの結果。終わったら .studio/runs/<run-id>/run.json に残す。
      // gates は今のラウンドの結果。終わったラウンドの結果は rounds に残す
      nodes: [],
      gates: freshGates(),
      round: 1,
      rounds: [{ round: 1, input: 'request', changedFiles: [], gates: null }],
      launches: [],
      // 作る AI の道具の呼び出しの回数(すべてのラウンドの合計)。observe は観察の道具の分
      toolCalls: { count: 0, observe: 0, byTool: {} },
      // 直すラウンドで app/ のシナリオが変わったら、ラウンドとファイルを残す(確かめ方が変わった印)
      scenariosChanged: [],
      evidence: null,
    };
    this.onNode({ projectId: id, runId: run.id, node: 'accept', kind: 'code' });
    run.nodes.push({ name: 'accept', kind: 'code', round: 1, startedAt: run.startedAt, durationMs: Date.now() - acceptedAt, outcome: 'passed' });
    const emitter = new EventEmitter();
    const runs = this.runs.get(id) ?? [];
    runs.push(run);
    if (runs.length > MAX_RUNS_PER_PROJECT) runs.splice(0, runs.length - MAX_RUNS_PER_PROJECT);
    this.runs.set(id, runs);
    const active = { run, emitter, handle: null };
    this.active.set(id, active);
    this.touch(id, run);
    this.log(`作る AI に依頼しました: ${id}(${this.agentLabel})`);

    active.done = this.execute(id, paths, active)
      .catch(async (error) => {
        this.log(`作る AI の実行で問題が起きました: ${id}(${error.message})`);
        run.status = 'failed';
        this.addItem(id, run, 'failed', `Studio の中で問題が起きました: ${error.message}`);
        if (!run.evidence) await this.evidence(id, paths, run).catch(() => {});
      })
      .finally(() => {
        run.finishedAt ??= new Date().toISOString();
        this.active.delete(id);
        this.store.releaseRun(id);
        this.touch(id, run);
        emitter.emit('end', structuredClone(run));
      });

    return {
      run: structuredClone(run),
      subscribe(onUpdate, onEnd) {
        emitter.on('update', onUpdate);
        emitter.once('end', onEnd);
        return () => {
          emitter.off('update', onUpdate);
          emitter.off('end', onEnd);
        };
      },
    };
  }

  // accept の後の節を、決まった順に回す。どの節も、次の節の名前(終わりは null)を返す
  async execute(id, paths, active) {
    const state = { id, paths, active, run: active.run, currentRound: active.run.rounds[0] };
    let next = 'fingerprint';
    while (next) next = await this.step(next, state);
    // 証拠をまとめる節を、通った節の列に入れてから書く
    await this.evidence(id, paths, state.run);
  }

  async step(name, state) {
    const done = this.enterNode(state.id, state.run, name);
    const { next, outcome } = await this[`node_${name}`](state);
    done(outcome);
    return next;
  }

  // 節 fingerprint: 前の app/ の指紋と、表示中の版のプロダクト内 AI の設定(実行の後の設定と比べる)
  async node_fingerprint(state) {
    state.before = await snapshotApp(state.paths.app);
    state.roundBefore = state.before;
    state.aiBefore = this.store.aiDefinition(state.id);
    state.simulationBefore = this.store.simulation(state.id);
    // シナリオの置き場所(表示中の版の目録)。直すラウンドでシナリオが変わったかを見るのに使う
    state.scenarioFolder = this.store.manifest(state.id)?.scenarios ?? null;
    state.appDirs = [state.paths.app, await fs.realpath(state.paths.app)];
    state.knownFailure = this.knownFailure(state.id);
    return { next: 'agent', outcome: 'passed' };
  }

  // 依頼の前の、表示中のビルドの失敗の指紋。ビルドが失敗していればその誤り、
  // 通っていれば、そのビルドの起動の確認の失敗。どちらもなければ null
  knownFailure(id) {
    const last = this.store.entry(id).lastBuild;
    if (last && !last.ok) {
      const name = BUILD_GATES.includes(last.stage) ? last.stage : 'compile';
      return failureSignature({ name, errors: gateErrors(last.errors ?? []) });
    }
    const launch = this.launchFailures.get(id);
    return launch && launch.buildId === this.store.previewBuildId(id) ? launch.signature : null;
  }

  // 関門の失敗が、依頼の前から同じ形で出ていたら印を付ける(harness.md の 2.3)
  markPreexisting(state, gate) {
    if (!state.knownFailure || failureSignature(gate) !== state.knownFailure) return;
    gate.preexisting = true;
    if (state.preexistingNoted) return;
    state.preexistingNoted = true;
    this.addItem(state.id, state.run, 'preexisting', `${gate.id} ${gate.label}の失敗は、依頼の前のビルドでも同じ形で出ていました(依頼の前から壊れていました)。`);
  }

  // 節 agent(model): 作る AI を起動し、終わるまで待つ。ここだけが作る AI の接続に触れる。
  // 直すラウンドでも、引数、cwd、環境変数、時間の上限、止め方は最初のラウンドと同じ。違うのは stdin の文(直す依頼)だけ。
  // 観察の道具の MCP の設定は、run ごとに 1 つ、app/ の外(.studio/runs/<run-id>/mcp.json)に置き、どのラウンドでも同じファイルを渡す。
  // 起動のたびに同じ中身で書き直す(前のラウンドの間に書き換えられていても、Studio の決めた中身で起動する)
  async node_agent(state) {
    const { id, paths, active, run } = state;
    const connection = this.connection;
    let result = null;
    // 直すラウンドの作る AI も、最初のラウンドと同じく中断できる
    active.exited = false;
    active.handle = null;

    if (active.cancelRequested) {
      run.status = 'cancelled';
      this.addItem(id, run, 'cancelled', '起動する前に中断しました。');
      this.keepPreviousGates(state);
      return { next: 'evidence', outcome: 'cancelled' };
    }
    const launchedAt = Date.now();
    let handle;
    try {
      state.mcpConfig = await writeObserveMcpConfig({ dir: this.runDir(paths, run), projectDir: paths.root, maxSeconds: this.timeoutMs / 1000 });
      const input = state.fixPrompt ?? run.request;
      const event = { projectId: id, runId: run.id, round: run.round };
      this.onAgentEvent({ ...event, type: 'input', text: input });
      handle = startAgentProcess({
        command: connection.command,
        args: [...connection.prefixArgs, ...buildClaudeArgs({ billing: connection.billing, mcpConfig: state.mcpConfig, maxBudgetUsd: this.maxBudgetUsd })],
        cwd: paths.app,
        // 利用者の環境変数をそのまま渡す。値は読まない、残さない
        env: this.env,
        input,
        timeoutMs: this.timeoutMs,
        onMessage: (message) => {
          this.onAgentEvent({ ...event, type: 'message', message });
          const read = readMessage(message, state.appDirs);
          if (read.init) {
            run.auth = read.init.apiKeySource;
            this.touch(id, run);
          }
          if (read.result) result = read.result;
          for (const name of read.toolUses) this.countToolCall(run, name);
          for (const item of read.items) this.addItem(id, run, item.kind, item.text);
        },
      });
    } catch (error) {
      run.status = 'agent-failed';
      run.launches.push({ round: run.round, startedAt: new Date(launchedAt).toISOString(), durationMs: Date.now() - launchedAt, outcome: 'spawn-error' });
      this.addItem(id, run, 'failed', `${run.agent} を起動できませんでした(${error.code ?? error.message})`);
      this.keepPreviousGates(state);
      return { next: 'evidence', outcome: 'failed' };
    }
    active.handle = handle;
    // 起動の前に中断が押されていたとき
    if (active.cancelRequested) handle.stop('cancel');
    const exit = await handle.done;
    // ここから先は決まった手順だけ。中断を受けても今の関門は止めず、次の直すラウンドに進まない(cancel、node_fix)
    active.exited = true;

    let outcome;
    if (exit.stopReason === 'cancel') {
      run.status = 'cancelled';
      outcome = 'cancelled';
      this.addItem(id, run, 'cancelled', '中断しました。途中まで書かれたファイルは、そのまま残っています。');
    } else if (exit.stopReason === 'timeout') {
      run.status = 'timed-out';
      outcome = 'timed-out';
      this.addItem(id, run, 'failed', `時間の上限(${Math.round(this.timeoutMs / 60_000)} 分)を超えたので止めました。依頼を小さく分けて送ってください。`);
    } else if (exit.spawnError) {
      run.status = 'agent-failed';
      outcome = 'failed';
      this.addItem(id, run, 'failed', `${run.agent} を起動できませんでした(${exit.spawnError.code ?? exit.spawnError.message})`);
    } else if (result?.ok && exit.code === 0) {
      outcome = 'passed';
    } else {
      run.status = 'agent-failed';
      outcome = 'failed';
      this.addItem(id, run, 'failed', this.failureText(result, exit));
    }
    run.launches.push({
      round: run.round,
      startedAt: new Date(launchedAt).toISOString(),
      durationMs: Date.now() - launchedAt,
      outcome,
      exitCode: exit.code ?? null,
      signal: exit.signal ?? null,
      // Claude Code が result で返した費用と、やりとりの回数(返さなかったら null)
      costUsd: result?.costUsd ?? null,
      numTurns: result?.numTurns ?? null,
    });

    for (const denial of result?.denials ?? []) {
      this.addItem(id, run, 'denied', `権限の確認で断られました: ${denial}`);
    }
    const loginText = `${result?.text ?? ''}\n${exit.stderrTail}`;
    if (run.status === 'agent-failed' && LOGIN_PATTERN.test(loginText)) {
      this.addItem(
        id,
        run,
        'hint',
        'Claude Code にログインしていないか、ログインが切れています。ターミナルで claude を起動して /login でログインしてから、もう一度送ってください。Studio はログインの情報を扱いません。',
      );
    }
    // 止めた run も、途中まで書かれたファイルを確かめてビルドする(試す画面で見られるように)
    return { next: 'changes', outcome };
  }

  countToolCall(run, name) {
    const calls = run.toolCalls;
    calls.count += 1;
    if (OBSERVE_TOOLS.includes(name)) calls.observe += 1;
    // 名前の数は、決まった道具の数より多くならない見込み。知らない名前が多く来ても増やしすぎない
    if (name === '__proto__') return;
    if (Object.hasOwn(calls.byTool, name)) calls.byTool[name] += 1;
    else if (Object.keys(calls.byTool).length < 50) calls.byTool[name] = 1;
  }

  // 直すラウンドが関門の前に終わったとき(起動の前の中断、起動できない)。app/ は前のラウンドのままなので、
  // run.gates を前のラウンドの結果に戻す(前の失敗を隠さない)。このラウンドで回した関門はない
  keepPreviousGates(state) {
    const { run } = state;
    if (run.round === 1) return;
    state.currentRound.gates = structuredClone(run.gates);
    run.gates = structuredClone(run.rounds[run.round - 2].gates);
  }

  // 節 changes(G1 変更の確認): 変わったファイルを、作る AI の報告に頼らず Studio が確かめる
  // 直すラウンドでは、そのラウンドの前の指紋と比べる。変わっていなければ、直せなかったとして failed で止める
  async node_changes(state) {
    const { id, paths, run, before, roundBefore } = state;
    const after = await snapshotApp(paths.app);
    state.after = after;
    // run.changedFiles は依頼の前から変わったファイル。ラウンドの中で変わったファイルは rounds に残す
    run.changedFiles = diffSnapshots(before, after);
    const changed = diffSnapshots(roundBefore, after);
    state.currentRound.changedFiles = changed;
    const fixing = run.round > 1;
    if (roundBefore.size >= MAX_SNAPSHOT_ENTRIES || after.size >= MAX_SNAPSHOT_ENTRIES) {
      this.addItem(id, run, 'info', `app/ のファイルが ${MAX_SNAPSHOT_ENTRIES} 個を超えているので、変わったファイルを確かめきれません。ビルドし直します。`);
      this.setGate(run, 'changes', { status: 'passed', changedFiles: changed.length, detail: '数が多いので確かめきれません' });
      return { next: 'inspect', outcome: 'passed' };
    }
    if (changed.length === 0 && fixing) return this.unchangedFix(state);
    if (changed.length === 0) {
      this.addItem(id, run, 'info', 'app/ のファイルは変わっていません。');
      this.setGate(run, 'changes', { status: 'unchanged', changedFiles: 0 });
      return { next: 'evidence', outcome: 'unchanged' };
    }
    if (fixing) this.noteScenarioChanges(state, changed);
    const names = `${changed.slice(0, 50).map((c) => c.file).join('、')}${changed.length > 50 ? ` ほか ${changed.length - 50} 個` : ''}`;
    this.addItem(id, run, 'changes', `${fixing ? '直すラウンドで変わったファイル' : '変わったファイル'}: ${names}`);
    this.setGate(run, 'changes', { status: 'passed', changedFiles: changed.length });
    return { next: 'inspect', outcome: 'passed' };
  }

  // 直すラウンドで、作る AI が app/ のシナリオを変えたか。シナリオを弱めて通すことを防ぐため、
  // 変わったら印を残し、結果に「確かめ方が変わりました」と出す(harness.md の 2.3)。
  // シナリオの置き場所は、依頼の前と今の目録の両方を見る(目録で置き場所を変えても見逃さない)
  noteScenarioChanges(state, changed) {
    const { id, run } = state;
    const folders = new Set(['scenarios', state.scenarioFolder, this.store.manifest(id)?.scenarios].filter(Boolean));
    const prefixes = [...folders].map((folder) => `app/${folder}/`);
    const files = changed.filter((change) => prefixes.some((prefix) => change.file.startsWith(prefix)));
    if (files.length === 0) return;
    run.scenariosChanged.push({ round: run.round, files: files.slice(0, 50) });
    state.currentRound.scenariosChanged = true;
  }

  // 直すラウンドで app/ が変わらなかったとき。前のラウンドの失敗を隠さない:
  // app/ は前のラウンドと同じなので、run.gates は前のラウンドの結果に戻し、G1 だけ「変更なし」にする
  unchangedFix(state) {
    const { id, run } = state;
    const g1 = { status: 'unchanged', changedFiles: 0, detail: '直すラウンドで app/ が変わりませんでした' };
    this.setGate(run, 'changes', g1);
    // このラウンドで回した関門は G1 だけ
    state.currentRound.gates = structuredClone(run.gates);
    const previous = run.rounds[run.round - 2].gates;
    run.gates = structuredClone(previous).map((gate) => (gate.name === 'changes' ? { ...gate, ...g1 } : gate));
    const failed = state.lastFailure;
    if (run.status === 'running') {
      run.status = 'failed';
      this.addItem(
        id,
        run,
        'gave-up',
        `直すラウンドで app/ が変わらなかったので、ここで止めました。前のラウンドの失敗(${failed.id} ${failed.label})は直っていません。失敗と証拠を返します。詳細の欄で場所を確かめ、直す依頼を送ってください。`,
      );
    }
    return { next: 'evidence', outcome: 'unchanged' };
  }

  // 節 inspect、contract、compile(G2〜G4): buildApp の 1 回の呼び出し。誤りの段の名前で、どの関門で止まったかを分ける。
  // 1 回のビルドの結果を、3 つの節に分けて記録する(安い順に止まる決まりは buildApp の中の順で満たす)
  async node_inspect(state) {
    const { id, run } = state;
    const build = await this.store.build(id, { byRun: true });
    // 段の名前がない失敗は、ビルドの途中で Studio が問題に当たったとき(読めないファイルなど)。G4 の失敗として扱う
    const failedAt = build.ok ? null : (BUILD_GATES.includes(build.stage) ? build.stage : 'compile');
    state.buildFailedAt = failedAt;
    run.build = { ok: build.ok, errorCount: build.errors?.length ?? 0, stage: failedAt, buildId: build.buildId ?? null, appDigest: build.appDigest ?? null };
    const failedIndex = failedAt ? BUILD_GATES.indexOf(failedAt) : BUILD_GATES.length;
    for (const [index, name] of BUILD_GATES.entries()) {
      if (index < failedIndex) this.setGate(run, name, { status: 'passed' });
      else if (index === failedIndex) {
        this.setGate(run, name, { status: 'failed', errorCount: build.errors.length, errors: gateErrors(build.errors) });
      }
    }
    if (build.ok) {
      this.addItem(id, run, 'build-ok', 'ビルドに成功しました。試す画面に反映しました。');
    } else {
      this.addItem(id, run, 'build-failed', 'ビルドに失敗しました。試す画面は、前にビルドできた版のままです。詳細の欄で場所を確かめられます。');
      this.markPreexisting(state, run.gates.find((gate) => gate.name === failedAt));
    }
    this.reportAiChanges(id, run, { ai: state.aiBefore, simulation: state.simulationBefore }, build.ok);
    return this.buildStep(state, 'inspect');
  }

  node_contract(state) {
    return this.buildStep(state, 'contract');
  }

  node_compile(state) {
    return this.buildStep(state, 'compile');
  }

  // ビルドの段の節を通ったか。失敗した段で止め、起動の確認は行わない(S11)
  buildStep(state, name) {
    const index = BUILD_GATES.indexOf(name);
    if (state.buildFailedAt === name) return { next: 'fix', outcome: 'failed' };
    return { next: BUILD_GATES[index + 1] ?? 'launch', outcome: 'passed' };
  }

  // 節 launch(G5 起動の確認): 新しいビルドを観察器で開く。15 秒以内に描画が終わり、
  // 実行時のエラーと console.error がなく、画面が空でないこと。観察器が使えなければ未確認(通ったとは扱わない)
  async node_launch(state) {
    const { id, paths, run } = state;
    // 止めた run と、Studio を止めているときは、確かめない
    if (run.status === 'cancelled' || run.status === 'timed-out' || this.closing) {
      const reason = this.closing ? 'Studio を止めているので、起動の確認はしません' : '作る AI を止めたので、起動の確認はしません';
      this.setGate(run, 'launch', { status: 'skipped', reason });
      return { next: 'evidence', outcome: 'skipped' };
    }
    const roundDir = path.join(this.runDir(paths, run), 'rounds', String(run.round));
    const reportFile = path.join(roundDir, 'report.json');
    let report = null;
    let reason = null;
    if (typeof this.observe !== 'function') {
      reason = 'この Studio では観察器を使えません';
    } else {
      try {
        report = await this.observe(id, { gate: 'launch', viewports: LAUNCH_VIEWPORTS, outDir: roundDir });
      } catch (error) {
        reason = `観察の途中で問題が起きました: ${clip(error?.message ?? error, 300)}`;
      }
    }
    if (report) {
      await fs.mkdir(roundDir, { recursive: true });
      await fs.writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`);
    }
    const gate = launchGate(report, reason);
    gate.report = report ? this.relativeToProject(paths, reportFile) : null;
    this.setGate(run, 'launch', gate);
    const launched = run.gates.find((g) => g.name === 'launch');
    if (gate.status === 'passed') {
      this.launchFailures.delete(id);
      this.addItem(id, run, 'launch-ok', '起動を確かめました。描画が終わり、エラーはなく、画面は空ではありません。');
    } else if (gate.status === 'failed') {
      this.addItem(id, run, 'launch-failed', `確かめで失敗あり: ${gate.summary}。試す画面は新しいビルドにしたので、そこで動きを確かめられます。`);
      this.markPreexisting(state, launched);
      this.launchFailures.set(id, { buildId: run.build?.buildId ?? null, signature: failureSignature(launched) });
    } else {
      this.launchFailures.delete(id);
      this.addItem(id, run, 'launch-unverified', `起動は確かめていません(未確認): ${gate.reason}`);
      // 起動を確かめていない版では、シナリオも回さない。通ったとは扱わない
      this.setGate(run, 'scenarios', { status: 'unverified', reason: '起動の確認が未確認なので、シナリオは回していません' });
    }
    const next = { passed: 'scenarios', failed: 'fix' }[gate.status] ?? 'evidence';
    return { next, outcome: gate.status };
  }

  // 節 scenarios(G6 シナリオ): app/ のシナリオと Studio の基本のシナリオを、観察器で回す。
  // プロダクト内 AI はいつもモック(呼ぶ側の observe が観察用の会話をモックで作る。ADR-0001 の T6)。
  // 時間の上限は 1 本 scenarioTimeoutMs、関門の全体で gateTimeoutMs。超えたら、この関門の失敗にする
  async node_scenarios(state) {
    const { id, paths, run, active } = state;
    if (run.status === 'cancelled' || run.status === 'timed-out' || this.closing) {
      const reason = this.closing ? 'Studio を止めているので、シナリオは回しません' : '作る AI を止めたので、シナリオは回しません';
      this.setGate(run, 'scenarios', { status: 'skipped', reason });
      return { next: 'evidence', outcome: 'skipped' };
    }
    // 起動の確認の間に中断を受けたら、次の関門には進まない
    if (active.cancelRequested) {
      run.status = 'cancelled';
      this.setGate(run, 'scenarios', { status: 'skipped', reason: '中断したので、シナリオは回していません' });
      this.addItem(id, run, 'cancelled', '中断しました。G6 シナリオの確かめは行いません。');
      return { next: 'evidence', outcome: 'cancelled' };
    }
    const { scenarioTimeoutMs, gateTimeoutMs } = this.scenarioLimits;
    const outDir = path.join(this.runDir(paths, run), 'rounds', String(run.round), 'scenarios');
    const reportFile = path.join(outDir, 'report.json');
    const timeoutText = `シナリオの関門が時間の上限(${Math.round(gateTimeoutMs / 1000)} 秒)を超えました。無限ループや重い処理がないか確かめてください`;
    let report = null;
    let reason = null;
    let timedOut = false;
    if (typeof this.observe !== 'function') {
      reason = 'この Studio では観察器を使えません';
    } else {
      const started = Date.now();
      let timer;
      const deadline = new Promise((resolve) => {
        timer = setTimeout(() => resolve(GATE_TIMEOUT), gateTimeoutMs);
      });
      try {
        const observing = Promise.resolve(this.observe(id, { gate: 'scenarios', viewports: [], outDir, limits: { scenarioTimeoutMs, observeTimeoutMs: gateTimeoutMs } }));
        observing.catch(() => {});
        const result = await Promise.race([observing, deadline]);
        // 観察器が自分の上限で止まったときは、未確認の report が返る。関門の上限を使い切っていれば時間切れ
        if (result === GATE_TIMEOUT || (result?.verdict === 'unverified' && Date.now() - started >= gateTimeoutMs)) timedOut = true;
        else report = result;
      } catch (error) {
        reason = `観察の途中で問題が起きました: ${clip(error?.message ?? error, 300)}`;
      } finally {
        clearTimeout(timer);
      }
    }
    if (report) {
      await fs.mkdir(outDir, { recursive: true });
      await fs.writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`);
    }
    const gate = timedOut
      ? { status: 'failed', summary: timeoutText, errorCount: 1, errors: [{ kind: 'timeout', message: timeoutText }], failures: [] }
      : scenarioGate(report, reason);
    gate.report = report ? this.relativeToProject(paths, reportFile) : null;
    this.setGate(run, 'scenarios', gate);
    const checked = run.gates.find((g) => g.name === 'scenarios');
    if (gate.status === 'passed') {
      this.launchFailures.delete(id);
      const own = gate.scenarioCount - gate.baseCount;
      this.addItem(id, run, 'scenarios-ok', `シナリオを確かめました。基本のシナリオ ${gate.baseCount} 本と、app/ のシナリオ ${own} 本が、すべて通りました(プロダクト内 AI はモック)。`);
    } else if (gate.status === 'failed') {
      this.addItem(id, run, 'scenarios-failed', `確かめで失敗あり: ${gate.summary}。試す画面は新しいビルドにしたので、そこで動きを確かめられます。`);
      this.markPreexisting(state, checked);
      this.launchFailures.set(id, { buildId: run.build?.buildId ?? null, signature: failureSignature(checked) });
    } else {
      this.launchFailures.delete(id);
      this.addItem(id, run, 'scenarios-unverified', `シナリオは確かめていません(未確認): ${gate.reason}`);
    }
    return { next: gate.status === 'failed' ? 'fix' : 'evidence', outcome: gate.status };
  }

  // 節 fix: 関門が失敗したラウンドの後に入る。直すラウンドがまだ MAX_FIX_ROUNDS 回に満たなければ、
  // 直前のラウンドの失敗だけから直す依頼を作り(fix-prompt.js)、作る AI の節に戻す。満たしたら、失敗と証拠を人に返す
  async node_fix(state) {
    const { id, run } = state;
    const failed = run.gates.find((gate) => gate.status === 'failed');
    state.currentRound.gates = structuredClone(run.gates);
    // 止めた run と、作る AI が失敗した run は直させない(中断と時間切れの決まりは今のまま)
    if (run.status !== 'running') return { next: 'evidence', outcome: 'skipped' };
    if (this.closing) {
      this.addItem(id, run, 'info', 'Studio を止めているので、直すラウンドは行いません。');
      return { next: 'evidence', outcome: 'skipped' };
    }
    if (state.active.cancelRequested) {
      run.status = 'cancelled';
      this.addItem(id, run, 'cancelled', `中断しました。直すラウンドは行いません。${failed.id} ${failed.label}の失敗は直っていません。`);
      return { next: 'evidence', outcome: 'cancelled' };
    }
    if (run.round > MAX_FIX_ROUNDS) {
      this.addItem(
        id,
        run,
        'gave-up',
        `直すラウンドを ${MAX_FIX_ROUNDS} 回行いましたが、${failed.id} ${failed.label}で失敗したままです。ここで止めて、失敗と証拠を返します。詳細の欄で場所を確かめ、直す依頼を送ってください。`,
      );
      return { next: 'evidence', outcome: 'gave-up' };
    }

    state.fixPrompt = buildFixPrompt({ request: run.request, gate: failed, changedFiles: run.changedFiles });
    state.lastFailure = failed;
    state.roundBefore = state.after;
    run.round += 1;
    run.gates = freshGates();
    // 直す依頼の文は元の依頼を含むので、run.json には入れない。何を返したかだけを残す
    state.currentRound = {
      round: run.round,
      input: 'fix',
      fixOf: { round: run.round - 1, gate: failed.id, ...(failed.preexisting ? { preexisting: true } : {}), failureChars: describeFailure(failed).length, changedFiles: run.changedFiles.length },
      changedFiles: [],
      gates: null,
    };
    run.rounds.push(state.currentRound);
    const fixRound = run.round - 1;
    this.addItem(id, run, 'round', `直すラウンド ${fixRound}/${MAX_FIX_ROUNDS}: 作る AI を起動し直します(起動 ${run.round}/${MAX_FIX_ROUNDS + 1} 回目)。`);
    const first = clip(describeFailure(failed).split('\n')[0], 200);
    this.addItem(
      id,
      run,
      'fix-request',
      `${failed.id} ${failed.label}の失敗(${first})を作る AI に返しました。添えたのは、元の依頼、失敗の中身、変わったファイルの名前(${run.changedFiles.length} 個)だけです。`,
    );
    return { next: 'agent', outcome: 'fix' };
  }

  // 節 evidence: 結果の状態を決め、関門の結果を作る会話に短く出し、run.json に残す
  async node_evidence(state) {
    const { id, run } = state;
    if (run.status === 'running') run.status = finalStatus(run.gates, run.round);
    if (run.gates.some((gate) => gate.status !== 'skipped')) {
      const parts = run.gates
        .filter((gate) => gate.status !== 'skipped')
        .map((gate) => `${gate.id} ${gate.label}: ${GATE_STATUS_TEXT[gate.status] ?? gate.status}`);
      const when = run.round > 1 ? `(直すラウンド ${run.round - 1} の後)` : '';
      this.addItem(id, run, 'gates', `Studio が確かめた結果${when}: ${parts.join('、')}`);
    }
    if (run.scenariosChanged.length > 0) {
      const files = [...new Set(run.scenariosChanged.flatMap((change) => change.files.map((file) => file.file)))];
      const rounds = run.scenariosChanged.map((change) => change.round - 1).join('、');
      this.addItem(
        id,
        run,
        'scenarios-changed',
        `確かめ方が変わりました: 直すラウンド ${rounds} で、作る AI がシナリオを変えました(${files.join('、')})。シナリオを弱めたり消したりして通していないか、変わったシナリオを確かめてください。`,
      );
    }
    this.log(`作る AI の実行が終わりました: ${id}(${run.status}、起動 ${run.launches.length} 回、変わったファイル ${run.changedFiles.length} 個)`);
    return { next: null, outcome: 'passed' };
  }

  runDir(paths, run) {
    return path.join(paths.studio, 'runs', run.id);
  }

  relativeToProject(paths, file) {
    return path.relative(paths.root, file).split(path.sep).join('/');
  }

  // .studio/runs/<run-id>/run.json を書く。古い run のフォルダーは、覚えておく数を超えたら消す
  async evidence(id, paths, run) {
    const dir = this.runDir(paths, run);
    const file = path.join(dir, 'run.json');
    run.finishedAt ??= new Date().toISOString();
    run.evidence = { run: this.relativeToProject(paths, file) };
    // 終わったラウンドの関門の結果。最後のラウンドは、ここで閉じる
    const current = run.rounds.at(-1);
    if (current && !current.gates) current.gates = structuredClone(run.gates);
    const record = {
      format: RUN_FORMAT,
      formatVersion: 1,
      id: run.id,
      project: id,
      agent: run.agent,
      status: run.status,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      nodes: run.nodes,
      gates: run.gates,
      maxFixRounds: MAX_FIX_ROUNDS,
      // ラウンドごとの節の列と関門の結果。2 つ目からは直すラウンドで、fixOf に直す依頼で返した失敗を持つ
      rounds: run.rounds.map((round) => ({ ...round, nodes: run.nodes.filter((node) => node.round === round.round).map((node) => node.name) })),
      agentLaunches: {
        count: run.launches.length,
        durationMs: run.launches.reduce((sum, launch) => sum + launch.durationMs, 0),
        // 費用は Claude Code が返した分の合計。どの起動も返さなかったら null
        costUsd: run.launches.some((launch) => Number.isFinite(launch.costUsd))
          ? run.launches.reduce((sum, launch) => sum + (Number.isFinite(launch.costUsd) ? launch.costUsd : 0), 0)
          : null,
        launches: run.launches,
      },
      // 作る AI の道具の呼び出しの回数。observe は観察の道具(mcp__observe__)の分
      toolCalls: run.toolCalls,
      changedFiles: run.changedFiles,
      // 直すラウンドで app/ のシナリオが変わったら、確かめ方が変わった印(ラウンドとファイル)
      scenariosChanged: run.scenariosChanged,
      build: run.build,
      reports: run.rounds.flatMap((round) => (round.gates ?? []).filter((gate) => gate.report).map((gate) => ({ gate: gate.id, round: round.round, file: gate.report }))),
    };
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(file, `${JSON.stringify(record, null, 2)}\n`);
    await this.pruneRunDirs(paths, run.id);
  }

  async pruneRunDirs(paths, keepId) {
    const root = path.join(paths.studio, 'runs');
    const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
    const dirs = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory() && entry.name !== keepId)
        .map(async (entry) => ({ name: entry.name, mtime: (await fs.stat(path.join(root, entry.name)).catch(() => null))?.mtimeMs ?? 0 })),
    );
    dirs.sort((a, b) => b.mtime - a.mtime);
    for (const dir of dirs.slice(MAX_RUNS_PER_PROJECT - 1)) {
      await fs.rm(path.join(root, dir.name), { recursive: true, force: true });
    }
  }

  // 決まった手順: プロダクト内 AI の設定と構成(構成、ツール、ガードレール)が変わったかを、Studio がビルドしたものどうしで確かめて出す。
  // 作る AI が書いたのは設定(app/ai.json、app/composition.json など)で、試す画面で応答するのはプロダクト内 AI。
  // 2 つを混ぜないよう、作る会話には設定の変化だけを出す。ガードレールが減ったときは、先頭に目立つ印を付ける
  reportAiChanges(id, run, before, buildOk) {
    const touched = run.changedFiles.some((change) => change.file === `app/${AI_FILE}`);
    // 置き場所の決まったファイルと、前の構成が指していたファイル(ツールのデータ、プロンプトの枠など)。目録の ai は上の文で出す
    const referenced = referencedFiles(before.simulation).filter((file) => file !== `app/${AI_FILE}`);
    const touchedSimulation = run.changedFiles
      .filter((change) => isSimulationFile(change.file) || referenced.includes(change.file))
      .map((change) => change.file);
    if (!buildOk) {
      if (touched) this.addItem(id, run, 'ai-settings', `app/${AI_FILE} が変わりましたが、ビルドに失敗したので、プロダクト内 AI は前の設定のままです。`);
      if (touchedSimulation.length > 0) {
        this.addItem(id, run, 'ai-settings', `${touchedSimulation.slice(0, 5).join('、')} が変わりましたが、ビルドに失敗したので、構成は前のままです。`);
      }
      return;
    }
    const aiAfter = this.store.aiDefinition(id);
    const lines = describeDefinitionChanges(before.ai, aiAfter);
    const simulation = describeSimulationChanges(before.simulation, this.store.simulation(id));
    const weakened = [...weakenedAiRules(before.ai, aiAfter), ...simulation.weakened];
    if (lines.length === 0 && simulation.lines.length === 0 && weakened.length === 0) {
      if (touched) this.addItem(id, run, 'ai-settings', `app/${AI_FILE} は変わりましたが、プロダクト内 AI の振る舞いに関わるところは変わっていません。`);
      return;
    }
    const after = lines.length > 0 && aiAfter
      ? '試す画面の会話は、新しい設定で最初から始まります。設定を変える前に試す画面で話していたときは、試す画面の上の「前の発言で試し直す」で、同じ発言を新しい設定に送り直せます。'
      : '';
    const text = [
      ...(weakened.length > 0
        ? ['【ガードレールが減りました】意図した変更かを確かめてください。場面やガードレールを弱めて通すための変更なら、元に戻す依頼を送ってください:', ...weakened.map((line) => `- ${line}`)]
        : []),
      ...(lines.length > 0 ? [`プロダクト内 AI の設定(app/${AI_FILE})が変わりました。Studio が前の設定と比べた結果:`, ...lines.map((line) => `- ${line}`)] : []),
      ...(simulation.lines.length > 0
        ? ['構成、ツール、ガードレールが変わりました。Studio が前と比べた結果:', ...simulation.lines.map((line) => `- ${line}`)]
        : []),
      after,
    ];
    this.addItem(id, run, 'ai-settings', text.filter(Boolean).join('\n'));
  }

  failureText(result, exit) {
    const label = this.agentLabel;
    if (result && !result.ok) {
      if (result.subtype === 'error_max_turns') return `やりとりの回数の上限(${MAX_TURNS} 回)に達して止まりました。依頼を小さく分けて送ってください。`;
      if (result.subtype === 'error_max_budget_usd') return `費用の上限(${this.maxBudgetUsd} ドル)に達して止まりました。`;
      return `${label} が失敗しました: ${result.text || result.subtype || '理由はわかりません'}`;
    }
    const how = exit.signal ? `シグナル ${exit.signal}` : `終了コード ${exit.code}`;
    const detail = exit.stderrTail ? `\n${exit.stderrTail.slice(-1000)}` : '';
    return `${label} が途中で終わりました(${how})。${detail}`;
  }

  // 作る AI が終わった後(関門を回している間)も、直すラウンドがまだ残っていれば中断を受ける。
  // 今の関門は終わりまで回し、次の作る AI は起動しない(節 fix で止まる)
  cancel(id, runId) {
    const active = this.active.get(id);
    if (!active || active.run.id !== runId) return null;
    if (active.exited && active.run.round > MAX_FIX_ROUNDS) return null;
    if (!active.cancelRequested) {
      active.cancelRequested = true;
      if (active.exited) {
        this.addItem(id, active.run, 'info', '中断しています…(今の確かめが終わったら止め、直すラウンドは行いません)');
      } else {
        this.addItem(id, active.run, 'info', '中断しています…');
        active.handle?.stop('cancel');
      }
    }
    return structuredClone(active.run);
  }

  // Studio のプロセスが終わる直前(SIGHUP や例外で、closeAll を待てないとき)。同期で強制終了する
  killAllSync() {
    for (const active of this.active.values()) active.handle?.kill();
  }

  // Studio を止めるとき。動いている作る AI も止め、終わるまで(上限つきで)待つ
  async closeAll() {
    this.closing = true;
    const waits = [];
    for (const active of this.active.values()) {
      // 起動の前なら、起動した直後に止まる(execute の中で見る)
      active.cancelRequested = true;
      active.handle?.stop('cancel');
      waits.push(active.done);
    }
    const limit = STOP_STEPS_MS.interrupt + STOP_STEPS_MS.terminate + 3000;
    await Promise.race([Promise.allSettled(waits), new Promise((resolve) => setTimeout(resolve, limit).unref())]);
  }
}
