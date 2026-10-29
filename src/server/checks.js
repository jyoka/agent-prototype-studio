import crypto from 'node:crypto';
import path from 'node:path';
import { launchGate, scenarioGate } from './build-requests.js';

// 人の「確かめる」(docs/design/harness.md の 3.1、8 節の P27)。利用者が画面から、表示中の試作品を自動で確かめる。
// 観察は、作るループの関門と同じ入口(observe-entry.js の observeProject)を、表示中のビルドを見るモード(shown)で呼ぶ。
// 呼ぶのは index.js の observeShown で、ここは観察の入口も観察器も import しない(S5)。
// report は .studio/observations/<観察の ID>/report.json に書かれる(入口が書く)。
// 結果は、作る run の結果の帯(P26)と同じ形で画面に出すため、関門 G5 と G6 と同じ形の gates にまとめる。
// 作る run、ビルド、版の操作の間は断る(ProjectStore.claimCheck。1 プロジェクト 1 実行)。
// 試作品の中の AI の既定はお試し(mock)。本物(claude-code)は、選べるかと同意を、始める前に確かめる
// (AiSessions.observationConnection)。本物で確かめるときも 1 回の観察だけで、呼び出しはプロジェクトごとの上限に数える(harness.md の 3.3)

// 確かめるときの試作品の中の AI の接続
export const CHECK_CONNECTIONS = ['mock', 'claude-code'];
// 確かめる画面幅。作る run の起動の確認と同じ 3 つ
const CHECK_VIEWPORTS = ['mobile', 'tablet', 'desktop'];
// 覚えておく確かめの数(プロジェクトごと)。古いものから忘れる。report のフォルダーは消さない
const MAX_CHECKS_PER_PROJECT = 20;
const MAX_REASON = 300;

export class CheckError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const relativeTo = (paths, file) => path.relative(paths.root, file).split(path.sep).join('/');

// 観察器の report を、作る run の関門 G5、G6 と同じ形の結果にする
function gatesOf(paths, report, reportFile) {
  const launch = { id: 'G5', name: 'launch', label: '起動の確認', ...launchGate(report) };
  launch.report = relativeTo(paths, reportFile);
  launch.screenshots = (report.screenshots ?? [])
    .filter((shot) => typeof shot?.file === 'string')
    .map((shot) => ({ name: shot.name, width: shot.width ?? null, height: shot.height ?? null, file: relativeTo(paths, shot.file) }));
  const scenarios = { id: 'G6', name: 'scenarios', label: 'シナリオ', ...scenarioGate(report) };
  scenarios.report = launch.report;
  // 1 回の観察なので、エラーは起動の確認の側にだけ出す(同じエラーを 2 回並べない)
  if (launch.errorCount > 0) {
    scenarios.errors = [];
    scenarios.errorCount = 0;
  }
  for (const failure of scenarios.failures ?? []) if (failure.screenshot) failure.screenshot = relativeTo(paths, failure.screenshot);
  return [launch, scenarios];
}

function statusOf(gates) {
  if (gates.some((gate) => gate.status === 'failed')) return 'failed';
  if (gates.some((gate) => gate.status !== 'passed')) return 'unverified';
  return 'passed';
}

export class ProjectChecks {
  // observe(id, options) は表示中のビルドを観察する関数(index.js の observeShown。観察の入口を通す)。
  // { report, dir, reportFile } を返す
  constructor({ store, aiSessions, observe, log = () => {} }) {
    this.store = store;
    this.aiSessions = aiSessions;
    this.observe = observe;
    this.log = log;
    this.checks = new Map();
    this.versions = new Map();
    this.running = new Set();
    this.closing = false;
  }

  list(id) {
    return (this.checks.get(id) ?? []).map((check) => structuredClone(check));
  }

  // 画面が読み直すかを決める番号と、確かめている最中か(projectView に入れる)
  summary(id) {
    return { checking: (this.checks.get(id) ?? []).some((check) => check.status === 'running'), version: this.versions.get(id) ?? 0 };
  }

  changed(id) {
    this.versions.set(id, (this.versions.get(id) ?? 0) + 1);
  }

  // 確かめを始め、動いている確かめを返す。終わるのは待たない(画面は一覧を読み直す)
  async start(id, { connection = 'mock' } = {}) {
    const paths = await this.store.requireProject(id);
    if (this.closing) throw new CheckError(503, 'closing', 'Studio を止めているところです');
    if (!CHECK_CONNECTIONS.includes(connection)) {
      throw new CheckError(400, 'invalid', `確かめるときの AI は ${CHECK_CONNECTIONS.join(' か ')} で選んでください`);
    }
    // 本物の AI は、選べるかと同意を、始める前に確かめる(同意の前は consent-required で断る)
    this.aiSessions.observationConnection(connection);
    const project = (await this.store.list()).find((p) => p.id === id);
    this.store.claimCheck(id);
    const check = {
      id: crypto.randomBytes(8).toString('hex'),
      status: 'running',
      connection,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      durationMs: null,
      buildId: project?.previewBuildId ?? null,
      appDigest: project?.lastBuild?.appDigest ?? null,
      // 試作品の中の AI があるか(画面は、AI のある試作品でだけ、確かめに使った AI を出す)
      ai: Boolean(this.store.aiDefinition(id) || this.store.simulation(id)?.composition),
      gates: [],
      // .studio/observations/<観察の ID>/report.json(プロジェクトから)
      report: null,
      reason: null,
    };
    const list = this.checks.get(id) ?? [];
    list.push(check);
    if (list.length > MAX_CHECKS_PER_PROJECT) list.splice(0, list.length - MAX_CHECKS_PER_PROJECT);
    this.checks.set(id, list);
    this.changed(id);
    const work = this.run(id, paths, check);
    this.running.add(work);
    work.finally(() => this.running.delete(work));
    return structuredClone(check);
  }

  async run(id, paths, check) {
    const started = Date.now();
    try {
      // 1 回の観察だけ。基本のシナリオと、目録の scenarios(既定は app/scenarios/)を回し、3 つの画面幅で撮る
      const { report, reportFile } = await this.observe(id, { viewports: CHECK_VIEWPORTS, aiConnection: check.connection });
      check.gates = gatesOf(paths, report, reportFile);
      check.status = statusOf(check.gates);
      check.report = relativeTo(paths, reportFile);
      check.buildId = report.buildId ?? check.buildId;
      check.appDigest = report.appDigest ?? check.appDigest;
      check.aiEntries = Array.isArray(report.ai) ? report.ai.length : 0;
      this.log(`確かめました: ${id}(${check.status}、${check.report})`);
    } catch (error) {
      check.status = 'unverified';
      check.reason = `確かめる途中で問題が起きました。${String(error?.message ?? error).slice(0, MAX_REASON)}`;
      check.gates = [{ id: 'G5', name: 'launch', label: '起動の確認', status: 'unverified', reason: check.reason }];
      this.log(`確かめられませんでした: ${id}(${check.reason})`);
    } finally {
      check.finishedAt = new Date().toISOString();
      check.durationMs = Date.now() - started;
      this.store.releaseCheck(id);
      this.changed(id);
    }
  }

  // Studio を止めるとき。観察器のブラウザが閉じれば、動いている確かめは終わる
  async closeAll() {
    this.closing = true;
    await Promise.allSettled([...this.running]);
  }
}
