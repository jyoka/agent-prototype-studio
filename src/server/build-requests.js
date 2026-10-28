import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { startAgentProcess, STOP_STEPS_MS } from './agent-process.js';
import { diffSnapshots, MAX_SNAPSHOT_ENTRIES, snapshotApp } from './app-snapshot.js';
import { buildClaudeArgs, DEFAULT_MAX_BUDGET_USD, MAX_TURNS } from './claude-args.js';
import { AI_FILE, describeDefinitionChanges } from './product-ai/definition.js';
import { readMessage } from './stream-json.js';

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
export const RUN_FORMAT = 'prototype-studio-run';

// 作る run の節の並び(blueprint。docs/design/harness.md の 2.1、2.2)。
// kind が code の節は決まった手順で、作る AI の接続(this.connection)に触れない。触れるのは model の節だけ。
// 関門は安い順に回し、失敗した段で止める(S11)。G2〜G4 は buildApp の 1 回の呼び出しで、誤りの段の名前で分ける
export const BLUEPRINT = Object.freeze([
  { name: 'accept', kind: 'code', label: '受け付け' },
  { name: 'fingerprint', kind: 'code', label: '前の指紋' },
  { name: 'agent', kind: 'model', label: '作る AI' },
  { name: 'changes', kind: 'code', gate: 'G1', label: '変更の確認' },
  { name: 'inspect', kind: 'code', gate: 'G2', label: '検査' },
  { name: 'contract', kind: 'code', gate: 'G3', label: '契約' },
  { name: 'compile', kind: 'code', gate: 'G4', label: 'ビルド' },
  { name: 'launch', kind: 'code', gate: 'G5', label: '起動の確認' },
  { name: 'evidence', kind: 'code', label: '証拠をまとめる' },
].map((node) => Object.freeze(node)));
const NODES = new Map(BLUEPRINT.map((node) => [node.name, node]));
const GATES = BLUEPRINT.filter((node) => node.gate);
const BUILD_GATES = ['inspect', 'contract', 'compile'];
const ERROR_KIND_TEXT = {
  runtime: '実行時のエラー',
  'console-error': 'console.error',
  'unhandled-rejection': '処理されない reject',
  timeout: '時間切れ',
  build: 'ビルドのエラー',
};
const GATE_STATUS_TEXT = { passed: '通った', failed: '失敗', unverified: '未確認', unchanged: '変更なし', skipped: '行わない' };

const clip = (value, max = MAX_GATE_TEXT) => String(value ?? '').slice(0, max);

// 関門 G5 の結果を、観察器の report から決める。report がなければ未確認
function launchGate(report, reason) {
  if (!report) return { status: 'unverified', reason };
  const errors = (report.errors ?? []).slice(0, MAX_GATE_ERRORS).map((e) => ({ kind: e.kind, message: clip(e.message) }));
  const base = { verdict: report.verdict, loadMs: report.load?.durationMs ?? null, errors };
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

// 関門の結果から、run の結果の状態を決める(harness.md の 2.4)。作る AI を止めたときと失敗したときは、その節で決まる
function finalStatus(gates) {
  const by = Object.fromEntries(gates.map((gate) => [gate.name, gate.status]));
  if (by.changes === 'unchanged') return 'unchanged';
  if (gates.some((gate) => gate.status === 'failed')) return 'failed';
  if (by.launch === 'unverified') return 'unverified';
  return 'passed';
}

export class RequestError extends Error {}
export class AgentUnavailableError extends Error {}

// 作る欄の依頼を受け、作る run を blueprint の節の順に回す。
// 作る AI の節(model)と、決まった節(code)を分ける(ADR-0001、Stripe の Minions)。
// observe(id, { viewports, outDir }) は、表示中のビルドを観察器で開き、report を返す関数(関門 G5)。
// なければ G5 は未確認になる。onNode({ projectId, runId, node, kind }) は、節に入るたびに呼ぶ(確かめ用)
export class BuildRequests {
  constructor({
    store,
    connection,
    observe = null,
    env = process.env,
    log = () => {},
    onNode = () => {},
    timeoutMs = DEFAULT_AGENT_TIMEOUT_MS,
    maxBudgetUsd = DEFAULT_MAX_BUDGET_USD,
  }) {
    this.store = store;
    this.connection = connection;
    // 決まった節が使う、接続の名前と問題。決まった節は、ここだけを見る
    this.agentLabel = connection.label;
    this.agentProblem = connection.problem;
    this.observe = observe;
    this.env = env;
    this.log = log;
    this.onNode = onNode;
    this.timeoutMs = timeoutMs;
    this.maxBudgetUsd = maxBudgetUsd;
    this.runs = new Map();
    this.active = new Map();
    this.versions = new Map();
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
    this.onNode({ projectId: id, runId: run.id, node: node.name, kind: node.kind });
    return (outcome) => {
      run.nodes.push({ name: node.name, kind: node.kind, ...(node.gate ? { gate: node.gate } : {}), startedAt: new Date(started).toISOString(), durationMs: Date.now() - started, outcome });
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
      // 通った節の列と、関門ごとの結果。終わったら .studio/runs/<run-id>/run.json に残す
      nodes: [],
      gates: GATES.map((node) => ({ id: node.gate, name: node.name, label: node.label, status: 'skipped' })),
      launches: [],
      evidence: null,
    };
    this.onNode({ projectId: id, runId: run.id, node: 'accept', kind: 'code' });
    run.nodes.push({ name: 'accept', kind: 'code', startedAt: run.startedAt, durationMs: Date.now() - acceptedAt, outcome: 'passed' });
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
    const state = { id, paths, active, run: active.run };
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
    state.aiBefore = this.store.aiDefinition(state.id);
    state.appDirs = [state.paths.app, await fs.realpath(state.paths.app)];
    return { next: 'agent', outcome: 'passed' };
  }

  // 節 agent(model): 作る AI を起動し、終わるまで待つ。ここだけが作る AI の接続に触れる
  async node_agent(state) {
    const { id, paths, active, run } = state;
    const connection = this.connection;
    let result = null;

    if (active.cancelRequested) {
      run.status = 'cancelled';
      this.addItem(id, run, 'cancelled', '起動する前に中断しました。');
      return { next: 'evidence', outcome: 'cancelled' };
    }
    const launchedAt = Date.now();
    let handle;
    try {
      handle = startAgentProcess({
        command: connection.command,
        args: [...connection.prefixArgs, ...buildClaudeArgs({ billing: connection.billing, maxBudgetUsd: this.maxBudgetUsd })],
        cwd: paths.app,
        // 利用者の環境変数をそのまま渡す。値は読まない、残さない
        env: this.env,
        input: run.request,
        timeoutMs: this.timeoutMs,
        onMessage: (message) => {
          const read = readMessage(message, state.appDirs);
          if (read.init) {
            run.auth = read.init.apiKeySource;
            this.touch(id, run);
          }
          if (read.result) result = read.result;
          for (const item of read.items) this.addItem(id, run, item.kind, item.text);
        },
      });
    } catch (error) {
      run.status = 'agent-failed';
      run.launches.push({ startedAt: new Date(launchedAt).toISOString(), durationMs: Date.now() - launchedAt, outcome: 'spawn-error' });
      this.addItem(id, run, 'failed', `${run.agent} を起動できませんでした(${error.code ?? error.message})`);
      return { next: 'evidence', outcome: 'failed' };
    }
    active.handle = handle;
    // 起動の前に中断が押されていたとき
    if (active.cancelRequested) handle.stop('cancel');
    const exit = await handle.done;
    // ここから先は決まった手順だけ。中断は受けない
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
      startedAt: new Date(launchedAt).toISOString(),
      durationMs: Date.now() - launchedAt,
      outcome,
      exitCode: exit.code ?? null,
      signal: exit.signal ?? null,
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

  // 節 changes(G1 変更の確認): 変わったファイルを、作る AI の報告に頼らず Studio が確かめる
  async node_changes(state) {
    const { id, paths, run, before } = state;
    const after = await snapshotApp(paths.app);
    run.changedFiles = diffSnapshots(before, after);
    if (before.size >= MAX_SNAPSHOT_ENTRIES || after.size >= MAX_SNAPSHOT_ENTRIES) {
      this.addItem(id, run, 'info', `app/ のファイルが ${MAX_SNAPSHOT_ENTRIES} 個を超えているので、変わったファイルを確かめきれません。ビルドし直します。`);
      this.setGate(run, 'changes', { status: 'passed', changedFiles: run.changedFiles.length, detail: '数が多いので確かめきれません' });
      return { next: 'inspect', outcome: 'passed' };
    }
    if (run.changedFiles.length === 0) {
      this.addItem(id, run, 'info', 'app/ のファイルは変わっていません。');
      this.setGate(run, 'changes', { status: 'unchanged', changedFiles: 0 });
      return { next: 'evidence', outcome: 'unchanged' };
    }
    this.addItem(id, run, 'changes', `変わったファイル: ${run.changedFiles.slice(0, 50).map((c) => c.file).join('、')}${run.changedFiles.length > 50 ? ` ほか ${run.changedFiles.length - 50} 個` : ''}`);
    this.setGate(run, 'changes', { status: 'passed', changedFiles: run.changedFiles.length });
    return { next: 'inspect', outcome: 'passed' };
  }

  // 節 inspect、contract、compile(G2〜G4): buildApp の 1 回の呼び出し。誤りの段の名前で、どの関門で止まったかを分ける。
  // 1 回のビルドの結果を、3 つの節に分けて記録する(安い順に止まる決まりは buildApp の中の順で満たす)
  async node_inspect(state) {
    const { id, run } = state;
    const build = await this.store.build(id, { byRun: true });
    // 段の名前がない失敗は、ビルドの途中で Studio が問題に当たったとき(読めないファイルなど)。G4 の失敗として扱う
    const failedAt = build.ok ? null : (BUILD_GATES.includes(build.stage) ? build.stage : 'compile');
    state.buildFailedAt = failedAt;
    run.build = { ok: build.ok, errorCount: build.errors?.length ?? 0, stage: failedAt, buildId: build.buildId ?? null };
    const failedIndex = failedAt ? BUILD_GATES.indexOf(failedAt) : BUILD_GATES.length;
    for (const [index, name] of BUILD_GATES.entries()) {
      if (index < failedIndex) this.setGate(run, name, { status: 'passed' });
      else if (index === failedIndex) {
        this.setGate(run, name, {
          status: 'failed',
          errorCount: build.errors.length,
          errors: build.errors.slice(0, MAX_GATE_ERRORS).map((e) => ({ file: e.file, line: e.line ?? null, column: e.column ?? null, text: clip(e.text) })),
        });
      }
    }
    if (build.ok) {
      this.addItem(id, run, 'build-ok', 'ビルドに成功しました。試す画面に反映しました。');
    } else {
      this.addItem(id, run, 'build-failed', 'ビルドに失敗しました。試す画面は、前にビルドできた版のままです。詳細の欄で場所を確かめ、直す依頼を送ってください。');
    }
    this.reportAiChanges(id, run, state.aiBefore, build.ok);
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
    if (state.buildFailedAt === name) return { next: 'evidence', outcome: 'failed' };
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
    const roundDir = path.join(this.runDir(paths, run), 'rounds', '1');
    const reportFile = path.join(roundDir, 'report.json');
    let report = null;
    let reason = null;
    if (typeof this.observe !== 'function') {
      reason = 'この Studio では観察器を使えません';
    } else {
      try {
        report = await this.observe(id, { viewports: LAUNCH_VIEWPORTS, outDir: roundDir });
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
    if (gate.status === 'passed') {
      this.addItem(id, run, 'launch-ok', '起動を確かめました。描画が終わり、エラーはなく、画面は空ではありません。');
    } else if (gate.status === 'failed') {
      this.addItem(id, run, 'launch-failed', `確かめで失敗あり: ${gate.summary}。試す画面は新しいビルドにしたので、そこで動きを確かめ、直す依頼を送ってください。`);
    } else {
      this.addItem(id, run, 'launch-unverified', `起動は確かめていません(未確認): ${gate.reason}`);
    }
    return { next: 'evidence', outcome: gate.status };
  }

  // 節 evidence: 結果の状態を決め、関門の結果を作る会話に短く出し、run.json に残す
  async node_evidence(state) {
    const { id, run } = state;
    if (run.status === 'running') run.status = finalStatus(run.gates);
    if (run.gates.some((gate) => gate.status !== 'skipped')) {
      const parts = run.gates
        .filter((gate) => gate.status !== 'skipped')
        .map((gate) => `${gate.id} ${gate.label}: ${GATE_STATUS_TEXT[gate.status] ?? gate.status}`);
      this.addItem(id, run, 'gates', `Studio が確かめた結果: ${parts.join('、')}`);
    }
    this.log(`作る AI の実行が終わりました: ${id}(${run.status}、変わったファイル ${run.changedFiles.length} 個)`);
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
      agentLaunches: {
        count: run.launches.length,
        durationMs: run.launches.reduce((sum, launch) => sum + launch.durationMs, 0),
        launches: run.launches,
      },
      changedFiles: run.changedFiles,
      build: run.build,
      reports: run.gates.filter((gate) => gate.report).map((gate) => ({ gate: gate.id, round: 1, file: gate.report })),
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

  // 決まった手順: プロダクト内 AI の設定が変わったかを、Studio がビルドした設定どうしで確かめて出す。
  // 作る AI が書いたのは設定(app/ai.json)で、試す画面で応答するのはプロダクト内 AI。2 つを混ぜないよう、作る会話には設定の変化だけを出す
  reportAiChanges(id, run, aiBefore, buildOk) {
    const touched = run.changedFiles.some((change) => change.file === `app/${AI_FILE}`);
    if (!buildOk) {
      if (touched) this.addItem(id, run, 'ai-settings', `app/${AI_FILE} が変わりましたが、ビルドに失敗したので、プロダクト内 AI は前の設定のままです。`);
      return;
    }
    const lines = describeDefinitionChanges(aiBefore, this.store.aiDefinition(id));
    if (lines.length === 0) {
      if (touched) this.addItem(id, run, 'ai-settings', `app/${AI_FILE} は変わりましたが、プロダクト内 AI の振る舞いに関わるところは変わっていません。`);
      return;
    }
    const after = this.store.aiDefinition(id)
      ? '試す画面の会話は、新しい設定で最初から始まります。設定を変える前に試す画面で話していたときは、試す画面の上の「前の発言で試し直す」で、同じ発言を新しい設定に送り直せます。'
      : '';
    this.addItem(
      id,
      run,
      'ai-settings',
      [`プロダクト内 AI の設定(app/${AI_FILE})が変わりました。Studio が前の設定と比べた結果:`, ...lines.map((line) => `- ${line}`), after].filter(Boolean).join('\n'),
    );
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

  cancel(id, runId) {
    const active = this.active.get(id);
    if (!active || active.run.id !== runId || active.exited) return null;
    if (!active.cancelRequested) {
      active.cancelRequested = true;
      this.addItem(id, active.run, 'info', '中断しています…');
      active.handle?.stop('cancel');
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
