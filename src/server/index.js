import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { connectionView, resolveConnection } from './agent-connection.js';
import { Observer } from '../observer/observe.js';
import { BuildRequests, MAX_FIX_ROUNDS } from './build-requests.js';
import { ProjectChecks } from './checks.js';
import { STUDIO_ROOT } from './config.js';
import { FirstSteps } from './first-steps.js';
import { Hints } from './hints.js';
import { ProjectHandoffs, latestEvalRun, latestEvidence } from './handoff.js';
import { ProjectClosings } from './closing.js';
import { digestSnapshot, snapshotApp } from './app-snapshot.js';
import { ProjectIntents } from './intent.js';
import { createIntentAi, INTENT_SYSTEM_PROMPT } from './intent-ai.js';
import { ProjectDesigns } from './design.js';
import { ProjectReviews } from './review.js';
import { ProjectSceneRuns } from './scene-runs.js';
import { ProjectQuality } from './quality.js';
import { ProjectShows } from './show.js';
import { ProjectComments } from './comments.js';
import { ProjectMaterials } from './materials.js';
import { createDesignAi, DESIGN_SYSTEM_PROMPT } from './design-ai.js';
import { ProjectMeetings, removeErasing } from './meeting.js';
import { CHECKED_RUN, MeetingTimeline } from './timeline.js';
import { ProjectOrganizes } from './organize.js';
import { ProjectShares, ShareError } from './share.js';
import { COLUMNS, createOrganizeAi, ORGANIZE_SYSTEM_PROMPT } from './organize-ai.js';
import { createPreviewHandler } from './preview-server.js';
import { CLAUDE_CODE_LIMITS, createClaudeCodeConnection } from './product-ai/claude-code.js';
import { createMockConnection } from './product-ai/mock.js';
import { AiSessions } from './product-ai/session.js';
import { observeProject } from './observe-entry.js';
import { ensureSampleProjects, listProjects, projectPaths, projectsDir } from './projects.js';
import { SIM_AGENT_LIMITS, createClaudeCodeAgent } from './sim/agent-claude-code.js';
import { createMockAgent } from './sim/agent-mock.js';
import { removeAllSimDirs } from './sim/tools-mcp.js';
import { consentView, describeCost, RealAiConsent } from './real-ai.js';
import { STUDIO_SYSTEM_PROMPT } from './claude-args.js';
import { createToken } from './security.js';
import { createStudioHandler } from './studio-server.js';
import { ProjectStore } from './store.js';
import { ProjectVersions, recoverInterrupted } from './versions.js';

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve(server.address().port);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

export class HomeNotWritableError extends Error {
  constructor(home, cause) {
    super(`データの置き場に書き込めません(${home})`, { cause });
  }
}

export class PortInUseError extends Error {
  constructor(port, name) {
    super(`ポート ${port} は使われています`);
    this.port = port;
    this.envName = name;
  }
}

// 試作品の番号を OS に任せたとき、::1 で使われていた番号を選び直す回数
const PREVIEW_PORT_ATTEMPTS = 5;

async function listenOrExplain(server, port, host, envName) {
  try {
    return await listen(server, port, host);
  } catch (error) {
    if (error.code === 'EADDRINUSE') throw new PortInUseError(port, envName);
    throw error;
  }
}

// Studio を起動する。待ち受けは loopback だけ(0.0.0.0 にはしない)。
// env は作る AI とプロダクト内 AI に渡す環境変数。既定は利用者のもの(ADR-0001: そのまま渡し、値は読まない)。
// scenarioLimits は関門 G6 の時間の上限(build-requests.js の SCENARIO_GATE_LIMITS)。テストで短くするときだけ渡す。
// onAgentEvent は作る AI に渡した文と stream-json を受け取る関数(BuildRequests と同じ。実機の確かめの記録用)
// 共有の場に置く整理の板。項目と聞くことの文だけ。元の要点(お客さんの話そのもの)は置かない
function sharedBoard(view) {
  return {
    status: view.status,
    columns: Object.entries(COLUMNS).map(([id, label]) => ({ id, label })),
    items: view.items.map((item) => ({ id: item.id, column: item.column, text: item.text, guess: item.guess })),
    asks: view.asks.map((ask) => ({ kind: ask.kind, text: ask.text })),
  };
}

// 参加者の書き込みを当てる。share.js が署名と役の表を確かめた後に呼ぶ。
// 板は足す、直す、消すの 3 つだけ。整理する AI と「確かめた」の印は、進行役の画面でだけ。
// コメント、反応、承認、承認の取り消しは comments.js に渡す(K7 の 3 枚目)。承認がそろっても列には並べない
function applySharedOp(organizes, comments, id, op, member) {
  if (typeof op?.op === 'string' && op.op.startsWith('comment-')) return comments.applyShared(id, op, member);
  if (op?.op === 'item-edit' && typeof op.id === 'string' && typeof op.text === 'string') return organizes.editItem(id, { id: op.id, text: op.text });
  if (op?.op === 'item-add' && typeof op.column === 'string' && typeof op.text === 'string') return organizes.addItem(id, { column: op.column, text: op.text });
  if (op?.op === 'item-remove' && typeof op.id === 'string') return organizes.removeItem(id, { id: op.id });
  throw new ShareError(400, 'invalid', 'その書き込みは使えません');
}

export async function startStudio(config, { log = () => {}, env = process.env, scenarioLimits, onAgentEvent } = {}) {
  try {
    await fs.mkdir(projectsDir(config.home), { recursive: true });
    for (const id of await ensureSampleProjects(config.home, path.join(STUDIO_ROOT, 'samples'))) {
      log(`サンプルの試作品を用意しました: ${id}`);
    }
    await recoverInterrupted(config.home, log);
    // 消している途中で止まった会のデータは、続きを消す
    await removeErasing(config.home, log);
    // 前の起動の模擬の会話の作業の場所(.studio/sim/)は、会話がもうメモリーにないので消す
    for (const project of await listProjects(config.home)) await removeAllSimDirs(project.paths.root);
  } catch (error) {
    // ENOTDIR と EEXIST は、置き場の途中にふつうのファイルがあるとき
    if (['EACCES', 'EPERM', 'EROFS', 'ENOTDIR', 'EEXIST'].includes(error.code)) {
      throw new HomeNotWritableError(config.home, error);
    }
    throw error;
  }

  const connection = await resolveConnection(config, env);
  // 共有の場(下で作る)。部品の間で呼び合うので、先に名前だけを置く
  let shares = null;
  // 本物の AI を使う前の同意。1 つを作る AI と試作品の中の AI で共有する。メモリーにだけ持ち、起動し直すと消える
  const consent = new RealAiConsent();
  const token = createToken();
  const store = new ProjectStore(config.home, log);
  const ports = { studio: config.studioPort, preview: config.previewPort };
  // 外の AI に送る接続か(作る AI の同意の判定と同じ)
  const sendsOutside = connection.kind === 'claude' && !connection.problem;
  // 会の始めと会のデータ(meeting.js)。同意の前は、どの AI も呼ばない。消すときは、下の部品のメモリーも捨てる
  const meetings = new ProjectMeetings({
    home: config.home,
    store,
    consent,
    sendsOutside,
    cost: () => describeCost({ env, auth: connection.auth, fixBudgetUsd: config.maxBudgetUsd, fixLaunches: MAX_FIX_ROUNDS + 1 }),
    busy: (id) => comments.pumping.has(id) || comments.fixing.has(id) || intents.calling.has(id) || intents.locked.has(id) || organizes.calling.has(id) || designs.calling.has(id) || designs.locked.has(id) || aiSessions.busyFor(id) || sceneRuns.running.has(id),
    forget: async (id) => {
      await organizes.forget(id);
      intents.forget(id);
      designs.forget(id);
      reviews.forget(id);
      sceneRuns.forget(id);
      requests.forget(id);
      checks.forget(id);
      comments.forget(id);
      aiSessions.forgetProject(id);
      firstSteps.forget(id);
    },
    // 共有の場(share.js)。消す一覧に中継のサーバーの写しを載せ、会のデータを消すときに写しも消す
    sharing: (id) => shares.isSharing(id),
    eraseShared: (id) => shares.forget(id),
    log,
  });
  await meetings.load();
  // 会の段ごとの時刻(timeline.js、K6)。同意の後の会だけに残す。お試しの AI だけで始めた会も測る
  const timeline = new MeetingTimeline({ home: config.home, isOpen: (id) => ['agreed', 'trial'].includes(meetings.records.get(id)?.status), log });
  // 観察器のブラウザは、Studio の中で 1 つだけ。最初の観察のときに起動する
  const observer = new Observer();

  // 表示中のビルドを観察する。呼ぶ所(作る run の関門 G5、G6、人の「確かめる」と、下の observe())は、どれも観察の入口
  // (observe-entry.js の observeProject)を通す。返すのは { report, dir, reportFile }
  async function observeShown(id, options) {
    const paths = await store.requireProject(id);
    const project = (await store.list()).find((p) => p.id === id);
    const last = project.lastBuild ?? { ok: false, errors: [{ file: 'app/', text: 'まだビルドしていません' }] };
    // 基本のシナリオ(あいさつ)のために、表示中の版の AI の設定を添える
    const result = last.ok ? { ...last, ai: store.aiDefinition(id) } : last;
    return observeProject({
      ...options,
      mode: 'shown',
      projectDir: paths.root,
      projectId: id,
      shown: {
        result,
        previewUrl: result.ok ? `http://localhost:${ports.preview}/p/${id}/${project.previewBuildId}/` : null,
        hostUrl: `http://127.0.0.1:${ports.studio}/observe.html`,
        manifest: store.manifest(id),
      },
      aiSessions,
      observer,
    });
  }

  // プロダクト内 AI の接続の既定はモック。Claude Code は、利用者が画面で同意してから切り替える。
  // STUDIO_ALLOW_CLAUDE_CODE=0 のときは選べない(config.allowClaudeCode。書かない設定は選べない側にする)
  // 構成(app/composition.json)のある試作品は、会話の進め方が回す。模擬のエージェントの接続も、モックと Claude Code の 2 つで、
  // プロダクト内 AI と同じ選び方(既定はモック、本物は同意の後だけ)に従う(docs/design/agent-simulation.md の 3.3)
  const aiSessions = new AiSessions({
    definitionOf: (id) => store.aiDefinition(id),
    dataNumbersOf: (id) => store.dataNumbers(id),
    connections: [createMockConnection(), createClaudeCodeConnection({ env, allowed: config.allowClaudeCode === true })],
    consent,
    meetingGate: (id, mode) => meetings.require(id, mode),
    simulationOf: (id) => store.simulationContext(id),
    agents: [createMockAgent(), createClaudeCodeAgent({ env })],
    projectDirOf: (id) => projectPaths(config.home, id).root,
  });

  // 作る run の関門の観察。G5 は基本のシナリオとアプリのシナリオなしで観察し、プロダクト内 AI の要求は断る(ai を渡さない)。
  // G6 は app/ のシナリオと基本のシナリオを回す。プロダクト内 AI は、利用者が選んだ接続によらず、いつもモックの
  // 観察用の会話で答え、終わったら会話を捨てる(同じ入力で同じ結果になり、費用がかからない。ADR-0001 の T6)
  async function observeGate(id, { gate, viewports, outDir, limits }) {
    const options = gate === 'scenarios' ? { viewports: [], aiConnection: 'mock', limits, outDir } : { scenarios: [], base: false, viewports, outDir };
    return (await observeShown(id, options)).report;
  }

  const requests = new BuildRequests({
    store,
    connection,
    observe: observeGate,
    env,
    log,
    maxBudgetUsd: config.maxBudgetUsd,
    consent,
    meetingGate: (id, mode) => meetings.require(id, mode),
    // AI 構成の審査(review.js)。審査の要る試作品は、4 つの承認の後だけ作る AI を起動し、承認と違う構成は関門 GA で止める
    reviews: { check: (id) => reviews.check(id), markStopped: (id, detail) => reviews.markStopped(id, detail) },
    // run が終わるたびに、承認したコメントの列を進める(comments.js)。自動の確かめが通れば、会の「試作品」の時刻を残す(timeline.js)
    onEnd: (id, run) => {
      if (CHECKED_RUN.includes(run?.status)) timeline.mark(id, 'prototype', run.finishedAt);
      comments.afterRun(id);
    },
    ...(scenarioLimits ? { scenarioLimits } : {}),
    ...(onAgentEvent ? { onAgentEvent } : {}),
  });
  // 人の「確かめる」(P27)。作るループと同じ入口を、表示中のビルドを見るモードで呼ぶ(observeShown)
  const checks = new ProjectChecks({ store, aiSessions, observe: observeShown, log });
  // 最初の一歩の案内の進み方と、閉じたこと。メモリーにだけ持ち、起動し直すと消える(first-steps.js)
  const firstSteps = new FirstSteps({ statusesOf: (id) => requests.statuses(id) });
  // 「その場で」の 1 行を覚えた回数。Studio のデータの置き場の hints.json(利用者ごと。試作品には入れない。hints.js)
  const hints = new Hints({ home: config.home });
  await hints.load();
  // 目的の聞き出し。聞き出す AI は、作る AI と同じ接続の判定を使う別の役(intent-ai.js)。
  // 偽接続は同意なしで使う。本物は同意の後だけ。使えないとき、本物の AI を止めた設定のときは、決まった問いで進める
  // お客さんの話を書き換える前に呼ぶ。同意の前と、消している間は断る
  const talkGate = (id) => {
    meetings.requireDecided(id);
    store.checkNotErasing(id);
  };
  // 会の中では、同意の前は使えない扱い。お試しだけの会では、本物を使えない扱い(meeting.js)。id がないのは新しい試作品のとき
  const thinkingAiMode = (id) => {
    if (connection.problem) return null;
    const mode = connection.kind === 'fake' ? 'fake' : config.allowClaudeCode === true ? 'real' : null;
    return mode && id && !meetings.mayCall(id, mode) ? null : mode;
  };
  const intents = new ProjectIntents({
    home: config.home,
    store,
    ai: createIntentAi({ connection, env }),
    consent,
    aiMode: thinkingAiMode,
    talkGate,
    startScreen: config.startScreen !== false,
    otherWork: () => organizes.boards.size > 0 || designs.records.size > 0 || meetings.records.size > 0,
    log,
  });
  await intents.load();
  // ヒアリングの整理。整理する AI は聞き出す AI と同じ決め方の別の役(organize-ai.js)。使えないときは、人が手で振り分ける
  // 板を書いたら、共有の場の写しを置き直す(共有していなければ何もしない)
  const organizes = new ProjectOrganizes({ home: config.home, store, ai: createOrganizeAi({ connection, env }), consent, aiMode: thinkingAiMode, talkGate, onWrite: (id) => shares?.changed(id), log });
  await organizes.load();
  // 設計の案内。案を出す AI は聞き出す AI と同じ決め方の別の役(design-ai.js)。使えないときは、Studio の決まった案を出す
  const designs = new ProjectDesigns({
    home: config.home,
    store,
    ai: createDesignAi({ connection, env }),
    consent,
    aiMode: thinkingAiMode,
    talkGate,
    intentOf: (id) => intents.records.get(id) ?? null,
    boardOf: (id) => organizes.boards.get(id)?.items ?? [],
    reviewOf: (id) => reviews.statusOf(id),
    log,
  });
  await designs.load();
  // AI 構成の審査と AI 構成書。会の中では承認する役を分ける(docs/design/ai-architecture-review.md の 9 節)
  const reviews = new ProjectReviews({ home: config.home, store, designs, modeOf: (id) => (meetings.records.has(id) ? 'meeting' : 'single'), log });
  await reviews.load();
  // 主の画面の場面の回しと比べる表(task 423)。お試しの AI は同意なしで回す。本物の AI は、試作品の中の AI と同じ口(useReal)で
  // 選べるかと同意を確かめ、費用の上限を付けて回す。接続は回しごとに新しく作り、終わったら閉じる
  const sceneRuns = new ProjectSceneRuns({
    store,
    aiSessions,
    realConnection: () => ({
      kind: 'claude-code',
      real: true,
      agent: createClaudeCodeAgent({ env }),
      harness: createClaudeCodeConnection({ env, allowed: config.allowClaudeCode === true }),
      // 費用の分からない失敗した起動に数える額(1 回の起動の上限。npm run evals と同じ)
      launchCapUsd: Math.max(SIM_AGENT_LIMITS.maxBudgetUsd, CLAUDE_CODE_LIMITS.maxBudgetUsd),
    }),
    onMeasured: (id) => reviews.noteMeasured(id),
    log,
  });
  // 質の見直しの表(user-journey.md の J6)。観察の検査、app/ の文、場面の回しの結果を読むだけ
  const quality = new ProjectQuality({ store, sceneRuns, checks });
  const materials = new ProjectMaterials({ store, log });
  const servers = [];
  // 人に見せた答え(user-journey.md の J7)は、版の一覧に載せる。答えは版の写しの外に置くので、版を戻しても消えない
  const versions = new ProjectVersions({ store, aiSessions, log, answersOf: (id) => shows.answersByVersion(id) });
  const shows = new ProjectShows({ home: config.home, store, versions, intents, log });
  // 画面へのコメント、反応、承認、列、直した記録、元に戻す(user-journey.md の K3)。承認がそろったコメントだけを作る AI に渡す。
  // 依頼には目的の文書と整理の板を包む。直す前の画面は観察器で撮る(広い画面 1 枚。基本の手順は回さない)
  const comments = new ProjectComments({
    home: config.home,
    store,
    requests,
    versions,
    reviews,
    contextOf: (id) => {
      const intent = intents.viewOf(id);
      return { purpose: intent?.status === 'skipped' ? null : intent?.doc ?? null, board: organizes.boards.get(id)?.items ?? [] };
    },
    talkGate,
    shoot: async (id, outDir) => {
      const { report } = await observeShown(id, { scenarios: [], base: false, viewports: ['desktop'], outDir });
      return report?.screenshots?.find((shot) => typeof shot?.file === 'string')?.file ?? null;
    },
    // 直した版ができ、自動の確かめも通ったら、会の「承認して AI が直す」の時刻を残す(timeline.js)
    onFixed: (id, record) => {
      if (CHECKED_RUN.includes(record.gates?.status)) timeline.mark(id, 'fix', record.events.find((e) => e.type === 'fixed')?.at);
    },
    log,
  });
  const handoffs = new ProjectHandoffs({ home: config.home, store, aiSessions, versions, requests, log });
  // 会の終わりの成果物(K5)。7 つの成果物を記録から読み、未決事項の持ち主と期日だけを人が書く。証拠と場面の回しの読み方は引き継ぎと同じ
  const closings = new ProjectClosings({
    home: config.home,
    store,
    latestOf: async (paths) => {
      const appDigest = digestSnapshot(await snapshotApp(paths.app));
      return { evidence: await latestEvidence(paths, appDigest), latestRun: await latestEvalRun(paths, appDigest) };
    },
    talkGate,
    log,
  });
  // 共有の場(K7 の 2 枚目、collaboration.md の 9.4)。Studio から中継のサーバーへ外へつなぐだけ。待ち受けは増やさない。
  // 中継のサーバーに置くのは、整理の板と、要件の文書、データ設計、場面の一覧、未決事項の写しだけ(会の鍵で包む)。
  // 参加者の書き込みは、人が画面で押したときと同じ口(organizes の editItem など)で板に当てる。記録らしいものは同じに断る。
  // コメント、反応、承認も写しに載せ、署名と役を確かめてから comments に当てる(3 枚目)。承認がそろっても、送るのは進行役
  shares = new ProjectShares({
    home: config.home,
    store,
    relayUrl: config.relayUrl ?? null,
    docsOf: async (id) => ({ title: (await store.list()).find((p) => p.id === id)?.title ?? '', board: sharedBoard(organizes.viewOf(id)), ...(await closings.shared(id)), comments: await comments.sharedView(id) }),
    apply: (id, op, member) => applySharedOp(organizes, comments, id, op, member),
    awaitingOf: (id) => comments.awaitingOf(id),
    onRemoved: (id, member) => comments.dropSharedMember(id, member),
    gate: talkGate,
    expiresOf: (id) => meetings.records.get(id)?.deleteOn ?? null,
    log,
  });
  await shares.load();
  const studioServer = http.createServer(
    createStudioHandler({
      store,
      requests,
      checks,
      agent: connectionView(connection),
      aiSessions,
      versions,
      handoffs,
      closings,
      intents,
      organizes,
      designs,
      reviews,
      sceneRuns,
      quality,
      shows,
      comments,
      materials,
      meetings,
      timeline,
      token,
      ports,
      // 同意のカードの中身(real-ai.js の consentView)。試作品を渡すと、その試作品の中の AI の「詳しく」も入れる
      realAi: (projectId, materialGuide = null) =>
        consentView({
          consent,
          env,
          agent: connection,
          fixBudgetUsd: config.maxBudgetUsd,
          fixLaunches: MAX_FIX_ROUNDS + 1,
          systemPrompt: materialGuide ? `${STUDIO_SYSTEM_PROMPT}\n${materialGuide}` : STUDIO_SYSTEM_PROMPT,
          intentPrompt: INTENT_SYSTEM_PROMPT,
          organizePrompt: ORGANIZE_SYSTEM_PROMPT,
          designPrompt: DESIGN_SYSTEM_PROMPT,
          productAllowed: config.allowClaudeCode === true,
          product: projectId ? aiSessions.realDetails(projectId) : null,
        }),
      consent,
      firstSteps,
      hints,
      shares,
    }),
  );
  servers.push(studioServer);
  const previewHandler = createPreviewHandler({ home: config.home, store, ports });

  try {
    ports.studio = await listenOrExplain(studioServer, config.studioPort, '127.0.0.1', 'STUDIO_PORT');
    // 番号を OS に任せたとき(0)は、127.0.0.1 で空いていた番号が ::1 では使われていることがある。そのときは番号を選び直す
    const attempts = config.previewPort === 0 ? PREVIEW_PORT_ATTEMPTS : 1;
    for (let attempt = 1; ; attempt += 1) {
      const previewServer = http.createServer(previewHandler);
      servers.push(previewServer);
      ports.preview = await listenOrExplain(previewServer, config.previewPort, '127.0.0.1', 'STUDIO_PREVIEW_PORT');
      // ブラウザが localhost を ::1 で引いても届くようにする
      const previewServerV6 = http.createServer(previewHandler);
      try {
        await listen(previewServerV6, ports.preview, '::1');
        servers.push(previewServerV6);
        break;
      } catch (error) {
        if (error.code !== 'EADDRINUSE') {
          log(`::1 では待ち受けません(${error.code ?? error.message})`);
          break;
        }
        // 他のプロセスが ::1 の同じポートにいると、ブラウザはそちらを試作品として開いてしまう
        if (attempt >= attempts) throw new PortInUseError(`${ports.preview}(::1)`, 'STUDIO_PREVIEW_PORT');
        servers.pop();
        await new Promise((resolve) => previewServer.close(() => resolve()));
      }
    }
  } catch (error) {
    await Promise.all(servers.map((server) => new Promise((resolve) => server.close(() => resolve()))));
    await Promise.all([aiSessions.close(), intents.close(), organizes.close(), designs.close(), sceneRuns.closeAll(), shares.close()]);
    throw error;
  }

  await store.buildAll();

  const url = `http://127.0.0.1:${ports.studio}/#token=${token}`;
  return {
    url,
    ports,
    store,
    requests,
    connection,
    // 本物の AI を使う前の同意。画面を通らない呼び出し(scripts/check-loop.js)は、ここで同意する
    consent,
    aiSessions,
    versions,
    shows,
    comments,
    handoffs,
    intents,
    organizes,
    designs,
    reviews,
    sceneRuns,
    meetings,
    checks,
    shares,
    observer,
    // 表示中のビルドを観察する。report とスクリーンショットは .studio/observations/<観察の ID>/ に置く。
    // シナリオは、渡さなければ app/ の目録の scenarios(既定は app/scenarios/)から読む。
    // Studio の基本のシナリオは、観察器がいつも先に回す。
    // プロダクト内 AI は、aiConnection(接続の種類。'mock' など)を渡すと、観察用の新しい会話で答え、
    // 観察が終わったら会話を捨てる(S15)。自分で作った ai 関数を渡してもよい
    async observe(id, { scenarios, viewports, ai, aiConnection, operate, limits } = {}) {
      return (await observeShown(id, { scenarios, viewports, ai, aiConnection, operate, limits })).report;
    },
    async close() {
      // 作る AI と、人の「確かめる」と、応答を待っているプロダクト内 AI と聞き出す AI と整理する AI の Claude Code と、観察器のブラウザを止め、終わるまで待つ
      await Promise.all([requests.closeAll(), checks.closeAll(), sceneRuns.closeAll(), aiSessions.close(), intents.close(), organizes.close(), designs.close(), observer.close(), shares.close()]);
      await Promise.all(
        servers.map(
          (server) =>
            new Promise((resolve) => {
              server.close(() => resolve());
              server.closeAllConnections?.();
            }),
        ),
      );
    },
  };
}
