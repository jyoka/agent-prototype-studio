import fsp from 'node:fs/promises';
import path from 'node:path';
import { SHAPE_LABELS } from './architecture.js';
import { createMockConnection } from './product-ai/mock.js';
import { createMockAgent } from './sim/agent-mock.js';
import { EVAL_RUN_FORMAT, EVAL_RUN_LIMITS, EvalPlanError, createBudget, createEvalWriter, newEvalRunId, planGroups, pruneEvalRuns, runEvals } from './sim/eval-run.js';
import { redact } from './redact.js';
import { BusyError } from './store.js';

// 場面の一覧を Studio の主の画面から回す(task 423。docs/design/ai-architecture-review.md の 15 節)。
// 回し方は npm run evals と同じ(runEvals)。構成ごとの比べにするため、既定の構成と compositions/ の構成を全部、各構成の既定の前提で回す。
// 結果は npm run evals と同じ所(.studio/evals/<回しの ID>/)に置き、画面の比べる表は一番新しい結果から作る。
// お試しの AI(モック)は費用がかからず、同意なしで回せる。本物の AI(Claude Code)は、試作品の中の AI を本物にするときと同じ口
// (AiSessions.useReal)で、選べるか、会の同意、本物の AI を使う同意を確かめ、費用の上限(limitUsd)がなければ始めない。
// 上限は台帳(.studio/evals/ledger.jsonl)で数え、達したら次の返事を始めずに止める(npm run evals の --limit-usd と同じ)。
// 採点(judge)はしない(画面の回しでは未採点のまま。採点するのは npm run evals の --real だけ)。
// 1 つの試作品で、同時に回すのは 1 つだけ。止めるまで待たずに返し、画面は GET で進み具合を読む。

export const SCENE_RUN_LIMITS = {
  // 本物の AI で回すときの費用の上限(USD)の既定と最大。最大は npm run evals の --limit-usd と同じ
  defaultLimitUsd: 1,
  maxLimitUsd: EVAL_RUN_LIMITS.limitUsdMax,
  // 失敗した場面のうち、画面に出す数
  maxFailures: 30,
  // 1 つの確かめの期待と実際の文の長さ
  maxCheckChars: 300,
};

const CONNECTIONS = ['mock', 'claude-code'];
const VERDICT_WORDS = { passed: '通った', failed: '通らなかった', 'n/a': '当てはまらない', unjudged: '未採点', error: '回せなかった', stopped: '途中で止めた' };

export class SceneRunError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const clip = (text, max) => {
  const value = String(text ?? '');
  return value.length > max ? `${value.slice(0, max)}…` : value;
};

const median = (values) => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

// 構成の名前。画面には app/ を出さないので、ファイルは app/ からの相対で出す(構成 B はファイルがないので ai.json)
function compositionOf(group) {
  const composition = group.composition ?? {};
  const shape = composition.shape ?? null;
  return {
    name: composition.name || SHAPE_LABELS[shape] || composition.file || 'AI の設定',
    file: composition.file ?? 'ai.json',
    shape,
    shapeLabel: shape ? SHAPE_LABELS[shape] ?? shape : null,
  };
}

// 比べる表の 1 行(組)。通った数、道具の呼び方の正しさ、費用、待ち時間。モックの費用と待ち時間は振る舞いの差を表さないので、画面は「測れない」と出す
export function rowOf(group, index) {
  const evals = group.evals ?? [];
  const summary = group.summary ?? {};
  const ran = evals.filter((item) => item.verdict !== 'n/a');
  const replyMs = evals.flatMap((item) => (item.turns ?? []).map((turn) => turn.ms)).filter(Number.isFinite);
  const costUsd = evals.reduce((sum, item) => sum + (item.costUsd ?? 0), 0);
  const conversations = ran.filter((item) => (item.turns ?? []).length > 0).length;
  return {
    key: `${index}`,
    composition: compositionOf(group),
    assumption: group.assumption ? { id: group.assumption.id, model: group.assumption.model ?? null, standIn: group.assumption.standIn ?? null } : null,
    connection: group.connection,
    real: Boolean(group.real),
    round: group.round ?? 1,
    scenes: evals.length,
    ran: ran.length,
    passed: evals.filter((item) => item.verdict === 'passed').length,
    failed: evals.filter((item) => item.verdict === 'failed').length,
    errors: evals.filter((item) => item.verdict === 'error').length,
    stopped: evals.filter((item) => item.verdict === 'stopped').length,
    notApplicable: evals.length - ran.length,
    // 採点(judge)だけの場面で、採点しなかったもの(画面の回しは採点しない)
    unjudged: evals.filter((item) => item.verdict === 'unjudged').length,
    toolRecall: summary.toolRecall ?? null,
    wrongCalls: summary.wrongCalls ?? 0,
    toolCalls: summary.tools?.calls ?? 0,
    costUsd: group.real ? costUsd : null,
    // 採点の費用(npm run evals -- --real の結果だけ)。会話の費用とは分けて出す
    judgeCostUsd: group.real ? evals.reduce((sum, item) => sum + (item.judgeCostUsd ?? 0), 0) : null,
    costPerConversationUsd: group.real && conversations > 0 ? costUsd / conversations : null,
    medianReplySeconds: group.real && replyMs.length > 0 ? Math.round(median(replyMs) / 10) / 100 : null,
  };
}

// 「直す」で言葉で直す欄に入れる依頼の文。場面の id と、通らなかった確かめと、ツールの呼び出しの要約。
// 場面と守りを弱めて通さないことを、作る AI への決まり(fix-prompt.js の CLOSING)と同じ考えで書く
export function fixRequestOf({ scene, row }) {
  const how = row.real ? '本物の AI' : 'お試しの AI';
  const lines = [`場面「${scene.id}」${scene.about ? `(${scene.about})` : ''}が、構成「${row.composition.name}」を${how} で回したときに通りませんでした。`];
  if (scene.reason) lines.push(`理由: ${scene.reason}`);
  for (const check of scene.checks) lines.push(`- 確かめ「${check.check}」: 期待 ${check.expected ?? '-'}、実際 ${check.actual ?? '-'}`);
  lines.push(`ツールの呼び出し: ${scene.tools.length > 0 ? scene.tools.join('、') : 'なし'}`);
  lines.push('場面の一覧と守り(ガードレール)は弱めずに、AI の作り(プロンプト、ツール、決まった返事)を直して、この場面が通るようにしてください。');
  return lines.join('\n');
}

// 止めた理由の平たい言葉。費用の上限、起動の数の上限、止める操作、途中の失敗
export function stopTextOf(result) {
  const reason = String(result.stopReason ?? '');
  if (result.status === 'stopped') {
    if (reason.includes('limit-usd')) return '使った費用が上限に達したので、次の返事を始めずに止めました';
    if (reason.includes('max-launches')) return '本物の AI を呼んだ回数が上限に達したので、次の返事を始めずに止めました';
    return '止めました。それまでの結果を残しています';
  }
  if (result.status === 'error') return '途中で回せなくなりました。それまでの結果を残しています';
  return null;
}

// 結果(result.json)から、画面の比べる表を作る。sceneIds は今の場面の一覧(回した後に変わったら stale)
export function tableOf(result, sceneIds = null) {
  const rows = (result.groups ?? []).map((group, index) => rowOf(group, index));
  const failures = [];
  let failureCount = 0;
  (result.groups ?? []).forEach((group, index) => {
    const row = rows[index];
    for (const item of group.evals ?? []) {
      if (item.verdict !== 'failed' && item.verdict !== 'error') continue;
      failureCount += 1;
      if (failures.length >= SCENE_RUN_LIMITS.maxFailures) continue;
      const scene = {
        id: item.id,
        about: item.about ?? null,
        kind: item.kind ?? null,
        verdict: item.verdict,
        verdictLabel: VERDICT_WORDS[item.verdict] ?? item.verdict,
        reason: item.verdict === 'error' ? clip(item.reason, SCENE_RUN_LIMITS.maxCheckChars) : null,
        checks: (item.checks ?? [])
          .filter((check) => check.verdict === 'failed')
          .map((check) => ({ check: check.check, expected: check.expected === undefined ? null : clip(check.expected, SCENE_RUN_LIMITS.maxCheckChars), actual: check.actual === undefined ? null : clip(check.actual, SCENE_RUN_LIMITS.maxCheckChars) })),
        tools: item.tools ?? [],
      };
      failures.push({ row: row.key, ...scene, request: fixRequestOf({ scene, row }) });
    }
  });
  // 古いかは、最後まで回した結果だけで決める(回している途中と、途中で止めた結果は、場面がそろわないのが当たり前)
  const ran = new Set((result.groups ?? []).flatMap((group) => (group.evals ?? []).map((item) => item.id)));
  const stale = result.status === 'done' && Array.isArray(sceneIds) && ran.size > 0 && (ran.size !== new Set(sceneIds).size || sceneIds.some((id) => !ran.has(id)));
  return {
    id: result.id,
    startedAt: result.startedAt ?? null,
    finishedAt: result.finishedAt ?? null,
    status: result.status,
    // 止めた理由と失敗の理由。画面には平たい言葉(stopText)を出し、元の文(CLI の引数の名前などが入る)は開発向けに分ける
    stopText: stopTextOf(result),
    stopReason: result.stopReason ?? null,
    real: Boolean(result.options?.real),
    limitUsd: result.options?.limitUsd ?? null,
    judged: Boolean(result.options?.judge),
    totals: result.totals ?? null,
    rows,
    failures,
    failureCount,
    stale,
  };
}

// 構成の全部(既定の構成と compositions/ の構成)。比べる表を構成ごとにするため
export function allCompositions(simulation) {
  const files = (simulation?.compositions ?? []).map((item) => item.composition?.file).filter((file) => typeof file === 'string' && file !== simulation?.composition?.file);
  return ['default', ...new Set(files)];
}

export class ProjectSceneRuns {
  // aiSessions は試作品の中の AI(本物の AI を使う前の確かめ useReal と、本物の接続)。
  // realConnection() は本物の AI で回すための新しい接続({ agent, harness, launchCapUsd })。回しが終わったら閉じる。
  // onMeasured(id) は回し終えた後に呼ぶ(AI 構成の審査の数を取り直す)
  constructor({ store, aiSessions, realConnection, onMeasured = async () => {}, log = () => {} }) {
    this.store = store;
    this.aiSessions = aiSessions;
    this.realConnection = realConnection;
    this.onMeasured = onMeasured;
    this.log = log;
    // 回している最中の回し。{ id, connection, limitUsd, startedAt, done, total, controller, spentUsd }
    this.running = new Map();
    // 画面が読み直すかを決める番号
    this.versions = new Map();
    // 回しそのものが失敗したときの理由(次の回しまで)。{ text: 画面の文, detail: 元の文(伏せた形。開発向け) }
    this.problems = new Map();
    this.works = new Set();
    this.closing = false;
  }

  changed(id) {
    this.versions.set(id, (this.versions.get(id) ?? 0) + 1);
  }

  // 一覧に載せる短い形(projectView)。count は場面の数、running は回している最中か
  summary(id) {
    const count = (this.store.simulation(id)?.evals ?? []).length;
    return { count, running: this.running.has(id), version: this.versions.get(id) ?? 0 };
  }

  // 一番新しい結果(.studio/evals/<回しの ID>/result.json)。npm run evals と審査の画面の回しも含む
  async latest(id) {
    const paths = await this.store.requireProject(id);
    const dir = path.join(paths.root, '.studio', 'evals');
    const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
    // 回しの ID は始めた時刻から始まる(newEvalRunId)。新しい名前から読み、最初に読めた結果を使う
    const names = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort().reverse();
    for (const name of names) {
      const result = await fsp
        .readFile(path.join(dir, name, 'result.json'), 'utf8')
        .then((text) => JSON.parse(text))
        .catch(() => null);
      if (result?.format === EVAL_RUN_FORMAT && Array.isArray(result.groups)) return result;
    }
    return null;
  }

  // 画面に出す形。場面の一覧、回している最中の進み具合、一番新しい比べる表、本物の AI で回せるか
  async view(id) {
    await this.store.requireProject(id);
    const simulation = this.store.simulation(id);
    const scenes = (simulation?.evals ?? []).map(({ scenario }) => ({ id: scenario.id, kind: scenario.kind ?? null, about: scenario.about ?? null }));
    const running = this.running.get(id);
    const latest = await this.latest(id);
    const real = this.aiSessions.connections.get('claude-code');
    const availability = real ? (real.availability?.() ?? { available: true }) : { available: false, reason: '本物の AI の接続がありません' };
    return {
      scenes,
      compositions: simulation?.composition ? allCompositions(simulation).length : 0,
      running: running
        ? { connection: running.connection, real: running.connection !== 'mock', limitUsd: running.limitUsd, startedAt: running.startedAt, done: running.done, total: running.total, spentUsd: running.budget?.spent ?? 0 }
        : null,
      last: latest ? tableOf(latest, scenes.map((scene) => scene.id)) : null,
      problem: this.problems.get(id) ?? null,
      real: {
        available: availability.available !== false,
        code: availability.code ?? null,
        reason: availability.available === false ? availability.reason ?? null : null,
        defaultLimitUsd: SCENE_RUN_LIMITS.defaultLimitUsd,
        maxLimitUsd: SCENE_RUN_LIMITS.maxLimitUsd,
      },
      version: this.versions.get(id) ?? 0,
    };
  }

  // 回し始める。終わるのは待たない。本物の AI は、選べるかと同意(useReal)と費用の上限を、始める前に確かめる
  async start(id, { connection = 'mock', limitUsd } = {}) {
    const paths = await this.store.requireProject(id);
    // ここから running に入れるまで await しない(同じ試作品で、2 つの回しを同時に始めないため)
    if (this.closing) throw new SceneRunError(503, 'closing', 'Studio を止めているところです');
    if (!CONNECTIONS.includes(connection)) throw new SceneRunError(400, 'invalid', `回す AI は ${CONNECTIONS.join(' か ')} で選んでください`);
    if (this.running.has(id)) throw new BusyError('場面を回しているところです。終わるか止めるまで待ってください');
    const context = this.store.simulationContext(id);
    if (!context?.simulation?.composition) throw new SceneRunError(409, 'no-composition', 'この試作品には AI がないか、表示できていないので、場面を回せません');
    if ((context.simulation.evals ?? []).length === 0) throw new SceneRunError(409, 'no-scenes', '場面の一覧がないので、回せません');
    const real = connection === 'claude-code';
    let limit = null;
    if (real) {
      limit = Number(limitUsd);
      if (!Number.isFinite(limit) || limit <= 0 || limit > SCENE_RUN_LIMITS.maxLimitUsd) {
        throw new SceneRunError(400, 'invalid-limit', `費用の上限は、0 より大きく ${SCENE_RUN_LIMITS.maxLimitUsd} 以下の USD で書いてください`);
      }
      const harness = this.aiSessions.connections.get('claude-code');
      if (!harness) throw new SceneRunError(403, 'unavailable', '本物の AI の接続がありません');
      // 試作品の中の AI を本物にするときと同じ口。本物の AI を使わない設定、Claude Code がない、会の同意の前、本物の AI を使う同意の前は、ここで断る
      this.aiSessions.useReal(harness, 'evals', id);
    }
    const plan = { compositions: allCompositions(context.simulation), connections: [connection] };
    let groups;
    try {
      groups = planGroups(context.simulation, plan);
    } catch (error) {
      if (error instanceof EvalPlanError) throw new SceneRunError(409, 'plan', error.message);
      throw error;
    }
    const runId = newEvalRunId();
    const evalsDir = path.join(paths.root, '.studio', 'evals');
    const state = {
      id: runId,
      connection,
      limitUsd: limit,
      startedAt: new Date().toISOString(),
      done: 0,
      total: groups.reduce((n, group) => n + group.repeat, 0) * context.simulation.evals.length,
      controller: new AbortController(),
      budget: real ? createBudget({ ledgerFile: path.join(evalsDir, 'ledger.jsonl'), runId, limitUsd: limit }) : null,
    };
    this.running.set(id, state);
    let writer;
    try {
      writer = await createEvalWriter({ root: paths.root, parts: ['.studio', 'evals', runId] });
    } catch (error) {
      this.running.delete(id);
      this.changed(id);
      this.log(`場面の回しの結果を書く場所を作れませんでした: ${id}(${error?.message ?? error})`);
      throw new SceneRunError(500, 'write', '結果を書く場所を作れなかったので、回しませんでした');
    }
    this.problems.delete(id);
    this.changed(id);
    // run は投げない(失敗は problems に残す)。念のため、拾われない失敗で Studio を止めない
    const work = this.run(id, { context, plan, writer, evalsDir, projectDir: paths.root, state, real }).catch(() => {});
    this.works.add(work);
    work.finally(() => this.works.delete(work));
    return this.view(id);
  }

  async run(id, { context, plan, writer, evalsDir, projectDir, state, real }) {
    let made = null;
    try {
      made = real ? this.realConnection() : { kind: 'mock', real: false, agent: createMockAgent(), harness: createMockConnection() };
      const { result, traces } = await runEvals({
        simulation: context.simulation,
        aiOf: context.aiOf,
        dataNumbers: context.dataNumbers,
        project: id,
        plan,
        connectionFor: () => made,
        projectDir,
        budget: state.budget,
        signal: state.controller.signal,
        id: state.id,
        onEval: async (partial, partialTraces) => {
          state.done += 1;
          await writer.write(partial, partialTraces);
          this.changed(id);
        },
      });
      await writer.write(result, traces, { report: true });
      await pruneEvalRuns(evalsDir, state.id).catch(() => {});
      this.log(`場面を回しました: ${id}(${result.status}、${result.verdict}。${real ? `本物の AI、${(state.budget?.spent ?? 0).toFixed(4)} USD` : 'お試しの AI'})`);
      await this.onMeasured(id).catch(() => {});
    } catch (error) {
      this.problems.set(id, { text: '場面を回せませんでした。それまでの結果があれば、表に残っています。', detail: redact(String(error?.message ?? error)).slice(0, 300) });
      this.log(`場面を回せませんでした: ${id}(${error?.message ?? error})`);
    } finally {
      if (real && made) {
        await made.agent?.close?.().catch(() => {});
        await made.harness?.close?.().catch(() => {});
      }
      this.running.delete(id);
      this.changed(id);
    }
  }

  // 止める。今の返事が終わったら、それまでの結果を残して止まる
  cancel(id) {
    const state = this.running.get(id);
    if (!state) return false;
    state.controller.abort();
    return true;
  }

  // 会のデータを消すとき。回している最中なら止める
  forget(id) {
    this.cancel(id);
    this.problems.delete(id);
    this.versions.delete(id);
  }

  async closeAll() {
    this.closing = true;
    for (const state of this.running.values()) state.controller.abort();
    await Promise.allSettled([...this.works]);
  }
}
