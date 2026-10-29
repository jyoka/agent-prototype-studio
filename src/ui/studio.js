// Studio 画面。トークンを持つ特権の画面なので、外から来た文字は必ず textContent で出す。
const TOKEN_KEY = 'prototype-studio-token';
const POLL_MS = 3000;
const MESSAGE_WINDOW_MS = 5000;
const MAX_MESSAGES_PER_WINDOW = 20;
const MAX_UNEXPECTED_LOADS = 3;
const MAX_EVENTS = 50;
// 作る会話の項目の「誰が」の名前。接続(偽接続、Claude Code)の名前は、開発者向けの詳細にだけ出す(ux-redesign.md 4 節)
const FIX_AI = '直す AI';
const RUN_STATUS = {
  running: () => `${FIX_AI} が作業しています…`,
  done: () => '終わりました',
  // 関門で失敗したまま止めたときは、直しきれなかったことと、何がうまくいかないかを言う
  failed: (run) => {
    const gate = failedGate(run);
    if (!gate) return '失敗しました';
    const what = (RUN_STATUS[`failed:${gate.name}`] ?? (() => `${gateLabel(gate)}で問題が見つかりました`))(gate);
    return `終わりました。${FIX_AI} が直しきれませんでした。${what}`;
  },
  cancelled: () => '中断しました',
  'timed-out': () => '時間の上限を超えたので止めました',
  // 作るループの結果(harness.md の 2.4)。結果の帯の 1 文になる。U3 の言葉を使わない(ux-redesign.md 4 節)
  passed: () => '終わりました。確かめました。問題は見つかりませんでした',
  fixed: () => `終わりました。確かめて見つけた問題を、${FIX_AI} が直しました`,
  unverified: (run) => {
    const reason = firstSentence(run.gates?.find((gate) => gate.status === 'unverified')?.reason);
    return `終わりました。自動の確かめができませんでした${reason ? `(${reason})` : ''}`;
  },
  unchanged: () => '終わりました。試作品のファイルは変わっていません',
  'agent-failed': () => `${FIX_AI} が失敗しました`,
  // 直しきれなかったときの「何がうまくいかないか」。関門の名前(run.gates の name)ごとの行。
  // 新しい関門は、ここと ITEM_LABELS の gate: の行を足すだけで、結果の帯に出る
  'failed:changes': () => `${FIX_AI} が、試作品のファイルを変えませんでした`,
  'failed:inspect': () => '試作品のファイルの名前か大きさに問題があります',
  'failed:contract': () => 'AI の設定か、確かめ方のファイルの形に誤りがあります',
  'failed:compile': () => '試作品のファイルに誤りがあり、新しい状態を表示できません',
  'failed:launch': () => '試作品を開くと、誤りが出ます',
  'failed:scenarios': () => '決めた手順で試すと、思ったとおりに動きません',
  'failed:evals': () => 'AI の場面を回すと、思ったとおりに動きません',
};
const ITEM_LABELS = {
  tool: '操作',
  'tool-error': 'ツールの失敗',
  denied: '断られた操作',
  failed: '失敗',
  cancelled: '中断',
  hint: 'すること',
  changes: '確かめた結果',
  info: 'Studio',
  skipped: 'Studio',
  'build-ok': 'ビルド',
  'build-failed': 'ビルド',
  'ai-settings': 'プロダクト内 AI の設定(Studio が確かめた結果)',
  'launch-ok': '起動の確認',
  'launch-failed': '起動の確認',
  'launch-unverified': '起動の確認',
  'scenarios-ok': 'シナリオ',
  'scenarios-failed': 'シナリオ',
  'scenarios-unverified': 'シナリオ',
  'scenarios-changed': '確かめ方が変わりました',
  'evals-ok': '場面',
  'evals-failed': '場面',
  'evals-changed': '確かめ方が変わりました',
  'guards-changed': 'ガードレールが変わりました',
  gates: '関門',
  preexisting: '確かめた結果',
  round: '直すラウンド',
  'fix-request': '直す依頼(Studio から作る AI へ)',
  'gave-up': '人に返す',
  // 結果の帯の「確かめた中身」に出す、関門の名前(run.gates の name ごと)。U3 の言葉を使わない
  'gate:changes': '変わったところ',
  'gate:inspect': 'ファイルの名前と大きさ',
  'gate:contract': 'AI の設定と確かめ方の形',
  'gate:compile': '表示の準備',
  'gate:launch': '開いて表示できるか',
  'gate:evals': 'AI の場面で動くか',
  'gate:scenarios': '決めた手順で動くか',
};
// 試作品からプロダクト内 AI への要求。連打で実モデルを呼び続けないよう、数を絞る
const AI_WINDOW_MS = 5000;
const MAX_AI_REQUESTS_PER_WINDOW = 10;
const MAX_AI_IN_FLIGHT = 3;
const MAX_AI_TEXT = 2000;
// ボタンの action の長さ(形はサーバーが確かめる)
const MAX_AI_ACTION = 40;
const MAX_AI_CHANGES = 20;
const EVENT_LABELS = {
  'runtime-error': '実行時エラー',
  'console-error': 'console.error',
};

const MESSAGES = {
  'no-token':
    'この画面を開くための鍵がありません。npm start を実行したターミナルに表示された URL(#token= を含むもの)を開いてください。',
  token: '鍵が合いません。Studio を起動し直したときは、ターミナルに表示された新しい URL を開いてください。',
  offline:
    'Studio のサーバーにつながりません。npm start を実行したターミナルが開いたままか確かめてください。止めたときは、もう一度 npm start を実行して、表示された URL を開いてください。',
};

const $ = (id) => document.getElementById(id);
const els = {
  connection: $('connection'),
  banner: $('banner'),
  bannerText: $('banner-text'),
  firstSteps: $('first-steps'),
  firstStepsList: $('first-steps-list'),
  firstStepsHint: $('first-steps-hint'),
  firstStepsClose: $('first-steps-close'),
  list: $('project-list'),
  title: $('project-title'),
  projectMenuButton: $('project-menu-button'),
  projectMenu: $('project-menu'),
  saveMark: $('save-mark'),
  saveNow: $('save-now'),
  more: $('more'),
  morePanel: $('more-panel'),
  moreClose: $('more-close'),
  devDetails: $('dev-details'),
  reopen: $('reopen'),
  rebuild: $('rebuild'),
  reset: $('reset'),
  aiSwitch: $('ai-switch'),
  aiMenu: $('ai-menu'),
  tryConsent: $('try-consent'),
  realAiTry: $('real-ai-try'),
  realAiTryInfo: $('real-ai-try-info'),
  realAiMake: $('real-ai-make'),
  realAiMakeInfo: $('real-ai-make-info'),
  aiBadge: $('ai-badge'),
  aiStatus: $('ai-status'),
  aiWaiting: $('ai-waiting'),
  retryBar: $('retry-bar'),
  aiTrace: $('ai-trace'),
  simChoice: $('sim-choice'),
  simChoiceBody: $('sim-choice-body'),
  checkAi: $('check-ai'),
  checkAiNote: $('check-ai-note'),
  checkConsent: $('check-consent'),
  checkRun: $('check-run'),
  checkMessage: $('check-message'),
  frameHost: $('frame-host'),
  frameLabel: $('frame-label'),
  previewBroken: $('preview-broken'),
  previewBrokenLead: $('preview-broken-lead'),
  previewBrokenFix: $('preview-broken-fix'),
  previewBrokenErrors: $('preview-broken-errors'),
  shotDialog: $('shot-dialog'),
  shotDialogImage: $('shot-dialog-image'),
  shotDialogCaption: $('shot-dialog-caption'),
  shotDialogClose: $('shot-dialog-close'),
  buildStatus: $('build-status'),
  events: $('events'),
  eventsEmpty: $('events-empty'),
  agentStatus: $('agent-status'),
  devAgentMark: $('dev-agent-mark'),
  makeTarget: $('make-target'),
  unavailable: $('agent-unavailable'),
  unavailableHeading: $('agent-unavailable-heading'),
  unavailableLead: $('agent-unavailable-lead'),
  unavailableSteps: $('agent-unavailable-steps'),
  unavailableDetail: $('agent-unavailable-detail'),
  testRequests: $('test-requests'),
  testRequestList: $('test-request-list'),
  conversation: $('conversation'),
  requestForm: $('request-form'),
  requestText: $('request-text'),
  send: $('send'),
  cancel: $('cancel'),
  examples: $('examples'),
  exampleList: $('example-list'),
  workingStatus: $('working-status'),
  saveForm: $('save-form'),
  versionName: $('version-name'),
  saveVersion: $('save-version'),
  versionsMessage: $('versions-message'),
  versionList: $('version-list'),
  handoffForm: $('handoff-form'),
  handoffNotes: { purpose: $('handoff-purpose'), decided: $('handoff-decided'), undecided: $('handoff-undecided') },
  handoffExport: $('handoff-export'),
  handoffResult: $('handoff-result'),
};

class ApiError extends Error {
  constructor(code, message, next = '') {
    super(message);
    this.code = code;
    // サーバーが返す、次にすること
    this.next = next;
  }
}

let token = readToken();
let projects = [];
let lastSnapshot = '';
let selectedId = null;
let pollTimer = null;
let refreshSeq = 0;
let appliedSeq = 0;
const preview = { frame: null, url: null, projectId: null, expectingLoad: false, unexpectedLoads: [], port: null };
// 作る会話。プロジェクトごとに、サーバーの版の番号と実行の一覧を持つ
let agent = null;
const conversations = new Map();
let sending = null;
let makeError = null;
// 本物の AI を使う前の同意(ux-redesign.md 6 節。サーバーは src/server/real-ai.js)。
// agreed はサーバーの同意の状態(一覧の API の consent)。card は出している同意のカードで、いつも 1 枚だけ(直す欄と試す欄で重ねない)。
// card の use は fix(直す欄の送信)か product(試作品の中の AI を本物にする)、kind は切り替える接続、send は同意の後に欄の依頼を送るか。
// view は /api/real-ai の中身。info は印を押して開いた中身(place は try か make)。declined は直す欄で「やめる」を選んだ後
const consent = { agreed: false, agreedAt: null, card: null, info: null, declined: false, agreeing: false, seq: 0 };
// 開発者向けの詳細に出している、プロダクト内 AI の会話と状態。
// choices は選べる接続と、実行の前に出す「送るもの」と「費用」。choices.simulation は構成と前提の選び方(構成のない試作品では null)。
// retry は設定が変わる前の会話と、試し直しの結果(Studio の画面だけに出す。試作品には渡さない)
// loaded は projectId の読み込みが終わったか(AI を使わない試作品では、終わっても session は null)
const ai = { projectId: null, session: null, loaded: false, choices: null, seq: 0, switching: false, retry: null };
// 試し直している試作品。別の試作品を選んでも、その試作品の欄には出さない
const retryingProjects = new Set();
// 試し直しの帯の「直す前と後の返事」を開いている試作品(再描画で閉じないよう覚える)。試し直しが終わると開く
const retryOpen = new Set();
// 最初の一歩の案内(ux-redesign.md 2 節)。dismissed は閉じたか(サーバーが Studio を止めるまで覚える)。
// 手順の済みは、一覧の API の試作品ごとの firstSteps(src/server/first-steps.js)
const firstSteps = { dismissed: false, touching: false };
// AI の実行の記録(#277)。open は、開いている「渡したもの、受け取ったもの」の記録の ID
const trace = { projectId: null, entries: null, snapshot: '', seq: 0, timer: null, open: new Set() };
const TRACE_POLL_MS = 1000;
// 応答を待っている発言の数を、試作品ごとに数える。開き直しや作り直しの後も「止める」を出し続けるため
const waitingByProject = new Map();
const waitingFor = (projectId) => waitingByProject.get(projectId) ?? 0;
// その他の引き出しの「保存した状態」。保存した版の一覧と、作業中がどの版と同じか
const versions = { projectId: null, data: null, seq: 0, busy: false, message: null };
// その他の引き出しの「本番開発へ渡す」(#280)。メモは試作品を選んだときだけ読み、書いている途中の文を上書きしない
// target は読み込みを頼んだ試作品、projectId は読み終えた試作品
const handoff = { target: undefined, projectId: null, seq: 0, busy: false, result: null, message: null, last: null };

// URL のフラグメントから鍵を読み、履歴に残さないよう消す(ADR-0001 の層 3)。
function takeTokenFromHash() {
  const match = /^#token=([a-f0-9]{64})$/.exec(location.hash);
  if (!match) return null;
  sessionStorage.setItem(TOKEN_KEY, match[1]);
  history.replaceState(null, '', location.pathname);
  return match[1];
}

function readToken() {
  return takeTokenFromHash() ?? sessionStorage.getItem(TOKEN_KEY);
}

async function send(path, options = {}) {
  try {
    const { json, ...rest } = options;
    const headers = { ...rest.headers, 'X-Studio-Token': token ?? '' };
    if (json !== undefined) {
      headers['Content-Type'] = 'application/json';
      rest.body = JSON.stringify(json);
    }
    return await fetch(path, { ...rest, headers });
  } catch {
    throw new ApiError('offline', MESSAGES.offline);
  }
}

async function api(path, options = {}) {
  const response = await send(path, options);
  let body = null;
  try {
    body = await response.json();
  } catch {
    // JSON でない応答は下で扱う
  }
  if (!response.ok) {
    throw new ApiError(
      body?.error?.code ?? 'http',
      body?.error?.message ?? `サーバーが ${response.status} を返しました`,
      typeof body?.error?.next === 'string' ? body.error.next : '',
    );
  }
  return body;
}

// 接続の印は、問題があるときだけ出す(ux-redesign.md 3 節)
function setConnection(state, text) {
  els.connection.dataset.state = state;
  els.connection.hidden = state !== 'error';
  els.connection.textContent = els.connection.hidden ? '' : text;
}

function showBanner(code, fallback) {
  els.banner.hidden = false;
  els.bannerText.textContent = MESSAGES[code] ?? fallback;
  setConnection('error', code === 'offline' ? 'つながっていません' : '問題があります');
}

function clearBanner() {
  els.banner.hidden = true;
  els.bannerText.textContent = '';
  setConnection('ok', 'つながっています');
}

function handleError(error) {
  if (error instanceof ApiError) {
    showBanner(error.code, error.message);
    // 鍵が合わないときは、待っても直らない
    if (error.code === 'token') stopPolling();
  } else {
    showBanner('internal', `画面で問題が起きました: ${error.message}`);
  }
}

function stopPolling() {
  clearInterval(pollTimer);
  pollTimer = null;
}

async function refresh() {
  const seq = ++refreshSeq;
  try {
    const data = await api('/api/projects');
    // 後から送った要求の結果を、先に送った要求の結果で上書きしない
    if (seq < appliedSeq) return;
    appliedSeq = seq;
    clearBanner();
    agent = data.agent;
    setConsentState(data.consent);
    // この画面で閉じた後は、閉じたことを送り終える前の一覧で、もう一度出さない
    firstSteps.dismissed ||= data.firstSteps?.dismissed === true;
    renderFirstSteps(selectedProject());
    const snapshot = JSON.stringify(data.projects);
    if (snapshot !== lastSnapshot) {
      lastSnapshot = snapshot;
      projects = data.projects;
      render();
      await syncConversation();
      await syncChecks();
    }
    // 作業中のファイルは、Studio の外でも変わり得るので、毎回確かめる(保存の印と、証拠が古いかの印)
    await loadVersions();
    await loadEvidence();
  } catch (error) {
    if (seq < appliedSeq) return;
    handleError(error);
  }
}

function selectedProject() {
  return projects.find((project) => project.id === selectedId) ?? null;
}

function render() {
  if (!selectedProject()) {
    // 初めて開いたときは、AI と話せる試作品(求人相談)を選ぶ(ux-redesign.md 5 節)
    selectedId = projects.find((p) => p.id === 'sample-job-consult')?.id ?? projects[0]?.id ?? null;
  }
  renderList();
  const project = selectedProject();
  els.title.textContent = project ? project.title : 'ありません';
  els.reopen.disabled = !project?.previewUrl;
  els.reset.disabled = !project?.previewUrl;
  els.rebuild.disabled = !project || project.building || project.running || project.versioning || project.checking;
  renderBuild(project);
  renderMake(project);
  renderPreviewBroken(project);
  renderVersions(project);
  if ((project?.id ?? null) !== handoff.target) loadHandoff(project?.id ?? null);
  renderHandoff(project);
  if (!project) {
    showPlaceholder('試作品がありません。');
  } else if (!project.previewUrl) {
    showPlaceholder('表示できる版がありません。「その他」の「開発者向けの詳細」を見てください。');
  } else if (project.previewUrl !== preview.url) {
    clearEvents();
    showPreview(project.previewUrl, project.id);
    // 版が変わると AI の設定も変わり得るので、読み直す
    loadAi(project.id);
  }
  if (!project?.previewUrl && ai.projectId !== null) loadAi(null);
}

function renderList() {
  const items = projects.map((project) => {
    const li = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.projectId = project.id;
    button.setAttribute('aria-current', String(project.id === selectedId));
    const name = document.createElement('span');
    name.textContent = project.title;
    const state = document.createElement('span');
    state.className = 'state';
    const failed = project.lastBuild && !project.lastBuild.ok;
    // AI と話せるかは名前に入っているので、ここには今の状態だけを短く出す
    const unavailable = !project.running && !project.versioning && !project.building && !project.checking && (failed || !project.previewUrl);
    state.dataset.state = unavailable ? 'error' : 'ok';
    state.textContent = project.running
      ? '作る AI が作業中'
      : project.versioning
        ? '版の保存・復元か書き出しをしています'
        : project.checking
        ? '自動で確かめています'
        : project.building
        ? 'ビルド中'
        : unavailable
          ? '表示できません'
          : '';
    button.append(name, state);
    button.addEventListener('click', () => {
      setProjectMenu(false);
      if (selectedId === project.id) return;
      selectedId = project.id;
      makeError = null;
      closeConsent();
      versions.message = null;
      render();
      // 会話を読んでから、前の証拠が古いかを読む(一覧の次の読み込みを待たない)
      syncConversation().then(() => syncChecks()).then(() => loadEvidence());
      loadVersions();
    });
    li.append(button);
    return li;
  });
  els.list.replaceChildren(...items);
}

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function formatTime(iso) {
  return new Date(iso).toLocaleTimeString('ja-JP');
}

function problemItem(problem) {
  const li = document.createElement('li');
  const where = problem.line ? `${problem.file}(${problem.line} 行 ${problem.column} 文字目)` : problem.file;
  li.append(element('code', where), document.createTextNode(`: ${problem.text}`));
  if (problem.lineText) li.append(element('pre', problem.lineText));
  return li;
}

function renderBuild(project) {
  const nodes = [];
  const build = project?.lastBuild;
  if (!project) {
    nodes.push(element('p', '試作品がありません。', 'muted'));
  } else if (project.building) {
    nodes.push(element('p', 'ビルドしています…', 'muted'));
  } else if (!build) {
    nodes.push(element('p', 'まだビルドしていません。', 'muted'));
  } else if (build.ok) {
    nodes.push(element('p', `ビルドに成功しました(${formatTime(build.finishedAt)})`, 'ok'));
    if (build.warnings?.length) {
      const list = element('ul', undefined, 'problem-list');
      list.append(...build.warnings.map(problemItem));
      nodes.push(element('p', '注意:', 'hint'), list);
    }
  } else {
    nodes.push(element('p', `ビルドに失敗しました(${formatTime(build.finishedAt)})`, 'failed'));
    const list = element('ul', undefined, 'problem-list');
    list.setAttribute('aria-label', 'ビルドの問題');
    list.append(...build.errors.map(problemItem));
    nodes.push(list);
    nodes.push(element('p', '直し方: app/ の中のファイルを直してから「ファイルから作り直す」を押してください。', 'hint'));
    const where = element('p', 'ファイルの場所: ', 'hint');
    where.append(element('code', project.appDir));
    nodes.push(where);
    if (project.previewUrl) {
      nodes.push(element('p', '「試す」には、前にビルドできた版を表示しています。', 'notice'));
    }
  }
  els.buildStatus.replaceChildren(...nodes);
}

// 試作品を表示できないとき(ux-redesign.md 7-6)。試す欄の上に、表示できないことと、前に表示できた状態を出していることを出す。
// 「直す AI に直してもらう」は依頼の欄に文を入れるだけで、送るのは利用者。誤りの場所(ファイルと行)は「開発者向け」の中だけ。
// 直す AI が直している間(直すラウンドでビルドし直す)と、ビルドの間は出さない
const FIX_DISPLAY_REQUEST = '表示できるように直して';

function renderPreviewBroken(project) {
  const build = project?.lastBuild;
  const broken = Boolean(project && build && !build.ok && !project.running && !project.building);
  els.previewBroken.hidden = !broken;
  els.frameLabel.hidden = !(broken && project.previewUrl);
  if (!broken) return;
  els.previewBrokenLead.textContent = project.previewUrl
    ? '試作品のファイルに誤りがあります。下には、前に表示できた状態を出しています。'
    : '試作品のファイルに誤りがあります。前に表示できた状態もありません。';
  els.previewBrokenFix.disabled = els.requestText.disabled;
  els.previewBrokenErrors.replaceChildren(...(build.errors ?? []).map(problemItem));
}

els.previewBrokenFix.addEventListener('click', () => {
  setMorePanel(false);
  fillRequest(FIX_DISPLAY_REQUEST);
});

// 開発者向けの詳細の「直す AI(作る AI)の接続」。接続の種類、版、認証の見込み、実行ファイル、使えない理由を出す
function renderAgentStatus() {
  const nodes = [];
  els.devAgentMark.hidden = agent?.kind !== 'fake';
  if (!agent) {
    els.agentStatus.replaceChildren();
    return;
  }
  els.agentStatus.dataset.kind = agent.kind;
  els.agentStatus.dataset.billing = agent.billing.mode;
  els.agentStatus.dataset.ready = String(agent.ready);
  if (agent.kind === 'fake') {
    nodes.push(element('p', '接続: 偽接続(STUDIO_AGENT=fake)', 'agent-name'));
    nodes.push(element('p', '決まった応答だけを返します。Claude Code もモデルも呼ばないので、料金はかかりません。'));
    nodes.push(element('p', `Claude Code に切り替えたときの認証の見込み: ${agent.billing.text}`, 'muted'));
  } else {
    nodes.push(element('p', `接続: Claude Code${agent.version ? ` ${agent.version}` : ''}(STUDIO_AGENT=${agent.mode})`, 'agent-name'));
    if (agent.problem) {
      nodes.push(element('p', `使えません(${agent.status}): ${agent.problem}`, 'failed'));
    } else {
      nodes.push(element('p', `認証と課金: ${agent.billing.text}`, 'billing'));
      nodes.push(
        element(
          'p',
          '読み書きを app/ の中に限り、コマンドと Web を使わせない設定で起動します。権限の確認で断られた操作は、会話に出します。この守りが実機で効くかは、まだ確かめていません(README の「実機で確かめる」)。',
          'muted',
        ),
      );
    }
    if (agent.command) {
      const where = element('p', '実行ファイル: ', 'muted');
      where.append(element('code', agent.command));
      nodes.push(where);
    }
  }
  els.agentStatus.replaceChildren(...nodes);
}

// 直す AI が使えないときのカード(ux-redesign.md 7-5)。見出しの 1 文は判定で変える。
// サーバーの理由の文(実行ファイルの場所、spawn … ENOENT など)は、カードの中の「開発者向け」にだけ出す
const RESTART_STEP = 'Studio を止めて、もう一度起動する';
const UNAVAILABLE = {
  missing: {
    heading: '言葉で直すには、Claude Code が要ります',
    lead: () => 'この PC で Claude Code が見つかりません。',
    steps: ['Claude Code を入れる', 'ターミナルで claude を起動して、ログインする', RESTART_STEP],
  },
  old: {
    heading: 'Claude Code が古いので使えません',
    lead: (view) => `この PC の Claude Code${view.version ? ` ${view.version}` : ''} は古いので、Studio から安全に動かせません。`,
    steps: ['ターミナルで claude update を実行して、Claude Code を新しくする', RESTART_STEP],
  },
  'not-logged-in': {
    heading: 'Claude Code にログインしていません',
    lead: () => 'Claude Code は見つかりましたが、ログインしていません。',
    steps: ['ターミナルで claude を起動して、/login でログインする', RESTART_STEP],
  },
  unusable: {
    heading: 'この Claude Code は、Studio から使えません',
    lead: () => 'この PC の Claude Code を、Studio から動かせませんでした。',
    steps: ['Claude Code を入れ直すか、新しくする', 'ターミナルで claude を起動できることを確かめる', RESTART_STEP],
  },
};

function renderUnavailable() {
  const card = agent && !agent.ready ? UNAVAILABLE[agent.status] ?? UNAVAILABLE.unusable : null;
  els.unavailable.hidden = !card;
  els.unavailable.dataset.status = agent?.status ?? '';
  if (!card) return;
  els.unavailableHeading.textContent = card.heading;
  els.unavailableLead.textContent = card.lead(agent);
  els.unavailableSteps.replaceChildren(...card.steps.map((step) => element('li', step)));
  const detail = [element('p', agent.problem ?? '理由は分かりません。')];
  if (agent.command) {
    const where = element('p', '確かめた場所: ');
    where.append(element('code', agent.command));
    detail.push(where);
  }
  els.unavailableDetail.replaceChildren(...detail);
}

// 利用者に見せる依頼の例。本物の直す AI で意味のある依頼にする(ux-redesign.md 5 節)。
// AI のある試作品では、最後の項目(最初の項目は、もう最初に聞く)を先に聞く例を入れる。AI のない試作品は Studio の共通の例だけ。
// {role} は試作品の AI の役の名前(「案内役」など)。題材の言葉は Studio に持たず、AI の設定の名前から取る
const COMMON_EXAMPLES = ['見出しの色を落ち着いた青にして', 'ボタンを大きくして', '説明の文を短くして'];
const AI_EXAMPLES = ['{field}を先に聞くようにして', '{role}の話し方を、もっとやわらかくして', '見出しの色を落ち着いた青にして'];
const MAX_ROLE = 8;

// AI の設定の名前(「しおかぜ求人相談の案内役(架空)」)の、最後の「の」の後ろを役の名前にする。取れなければ「AI」
function aiRole(name) {
  const role = String(name ?? '').replace(/\s*\([^()]*\)$/u, '').split('の').at(-1).trim();
  return role && role.length <= MAX_ROLE ? role : 'AI';
}

function userExamples(project) {
  if (!project) return [];
  if (ai.projectId !== project.id) return project.previewUrl ? [] : COMMON_EXAMPLES;
  // 読み込みの途中は出さない(共通の例から AI の例に入れ替わって、押す場所がずれないため)
  if (!ai.loaded) return [];
  const fields = ai.session?.fields ?? [];
  if (fields.length < 2) return COMMON_EXAMPLES;
  const role = aiRole(ai.session.name);
  return AI_EXAMPLES.map((text) => text.replace('{field}', () => fields.at(-1).label).replace('{role}', () => role));
}

function fillRequest(text) {
  els.requestText.value = text;
  els.requestText.focus();
}

function renderExamples() {
  const project = selectedProject();
  // 直す AI が使えないときは、送れないので例も出さない(使えないときのカードを出す)
  const examples = agent?.ready ? userExamples(project) : [];
  els.examples.hidden = examples.length === 0;
  els.exampleList.replaceChildren(
    ...examples.map((text) => {
      const li = document.createElement('li');
      const button = element('button', text);
      button.type = 'button';
      button.addEventListener('click', () => fillRequest(text));
      li.append(button);
      return li;
    }),
  );
  renderTestRequests();
}

// 例の文に、選んでいる試作品の AI の項目の名前を入れる。最初の項目は、もう最初に聞くので最後の項目にする
function testRequestText(example) {
  const fields = ai.projectId === selectedId ? ai.session?.fields ?? [] : [];
  if (!example.fieldTemplate || fields.length < 2) return example.text;
  return example.fieldTemplate.replace('{field}', () => fields.at(-1).label);
}

// 開発者向けの詳細の「試験用の依頼」。偽接続(STUDIO_AGENT=fake)のときだけ、サーバーが例を返す。
// 押すと依頼の欄に入れ、引き出しを閉じる(引き出しは依頼の欄の上に重なるため)
function renderTestRequests() {
  const examples = agent?.examples ?? [];
  els.testRequests.hidden = examples.length === 0;
  els.testRequestList.replaceChildren(
    ...examples.map((example) => {
      const li = document.createElement('li');
      const text = testRequestText(example);
      const button = element('button', text);
      button.type = 'button';
      button.addEventListener('click', () => {
        setMorePanel(false);
        fillRequest(text);
      });
      li.append(button, element('span', example.note, 'muted'));
      return li;
    }),
  );
}

function runningRun(projectId) {
  return conversations.get(projectId)?.runs.find((run) => run.status === 'running') ?? null;
}

// 直す欄の上の名前。一覧の名前の終わりの括弧(架空・AI と話せる など)は省く
function shortTitle(project) {
  return project.title.replace(/\s*\([^()]*\)$/u, '') || project.title;
}

function renderMake(project) {
  renderAgentStatus();
  renderUnavailable();
  renderExamples();
  els.makeTarget.textContent = project ? `${shortTitle(project)}への依頼` : '';
  const running = Boolean(project?.running || sending?.projectId === project?.id || (project && runningRun(project.id)));
  const ready = Boolean(project && agent?.ready && !running && !project.building && !project.versioning && !project.checking && !sending);
  els.requestText.disabled = !ready;
  els.requestText.placeholder = agent && !agent.ready ? '直す AI が使えないので、送れません' : '例: 見出しの色を落ち着いた青にして';
  els.send.disabled = !ready;
  els.cancel.hidden = !(project && runningRun(project.id));
  renderConversation(project);
  renderRealAiMarks();
  renderSaveMark(project);
  renderFirstSteps(project);
}

// 最初の一歩の案内(ux-redesign.md 2 節、7-1、7-2、7-4)。1 行の説明と 3 つの手順を、上の帯の下に出す。
// 手順は、サーバーが返す済み(first-steps.js)で進み、最初のまだ済んでいない手順に aria-current="step" を付ける。
// 下の 1 文は、今の手順で何をするか。直す AI が直しきれなかったとき(failed)は、2 番を済みにせず、結果の帯を見るように言う
const FIRST_STEPS = [
  { key: 'tried', label: '試す', noAi: '試作品の画面を触る' },
  { key: 'fixed', label: '言葉で直す' },
  { key: 'triedFixed', label: '直った結果を試す' },
];

// 選んでいる試作品が AI を使わないか(読み込みが終わるまでは、使うものとして扱う)
function withoutAi(project) {
  return ai.projectId === project.id && ai.loaded && !ai.session;
}

function firstStepsHint(project, current) {
  const noAi = withoutAi(project);
  const role = ai.projectId === project.id && ai.session ? aiRole(ai.session.name) : 'AI';
  const fixing = Boolean(project.running || sending?.projectId === project.id || runningRun(project.id));
  if (current === 0) {
    return noAi ? 'まず左の試作品の画面を、押したり書いたりしてみましょう。' : `まず左の試作品で、${role}に話しかけてみましょう。`;
  }
  if (current === 1 && fixing) return `${FIX_AI} が直しています。終わると、試作品が新しくなります。`;
  if (current === 1 && project.firstSteps?.lastRun === 'failed') {
    return { text: `${FIX_AI} が直しきれませんでした。右の「言葉で直す」の結果を見て、頼み方を変えてもう一度送ってください。`, tone: 'warn' };
  }
  if (current === 1) return '気になったところを、右の「言葉で直す」に頼んでみましょう。押すと入る例もあります。';
  if (current === 2 && ai.projectId === project.id && ai.retry?.available) {
    return '試作品の上の「同じ発言で試し直す」で、直す前と後の返事を比べられます。';
  }
  if (current === 2) return noAi ? '直った試作品の画面を、もう一度触ってみましょう。' : `直った試作品で、もう一度${role}に話しかけてみましょう。`;
  return '3 つの手順が終わりました。ほかにも気になるところがあれば、言葉で直せます。';
}

function renderFirstSteps(project) {
  const shown = Boolean(project) && !firstSteps.dismissed;
  els.firstSteps.hidden = !shown;
  if (!shown) return;
  const progress = project.firstSteps ?? {};
  const noAi = withoutAi(project);
  const current = FIRST_STEPS.findIndex((step) => !progress[step.key]);
  els.firstStepsList.replaceChildren(
    ...FIRST_STEPS.map((step, index) => {
      const li = element('li');
      const done = Boolean(progress[step.key]);
      li.dataset.state = done ? 'done' : index === current ? 'current' : 'todo';
      if (index === current) li.setAttribute('aria-current', 'step');
      // 枠は手順の名前にだけ付ける(手順の間の矢印は、li の前に CSS で出す)
      const name = element('span', undefined, 'first-steps-name');
      if (done) name.append(element('span', '✓ ', 'first-steps-mark'));
      name.append(document.createTextNode(`${index + 1} ${(noAi && step.noAi) || step.label}`));
      if (done) name.append(element('span', '(済み)', 'visually-hidden'));
      li.append(name);
      return li;
    }),
  );
  const hint = firstStepsHint(project, current);
  els.firstStepsHint.textContent = typeof hint === 'string' ? hint : hint.text;
  els.firstStepsHint.dataset.tone = typeof hint === 'string' ? '' : hint.tone;
}

els.firstStepsClose.addEventListener('click', async () => {
  firstSteps.dismissed = true;
  renderFirstSteps(selectedProject());
  try {
    await api('/api/first-steps', { method: 'POST', json: { dismiss: true } });
  } catch (error) {
    handleError(error);
  }
});

// AI のない試作品では、試作品の画面を触ると、案内の 1 番(直した後なら 3 番)が済む。
// 試作品は別の origin の iframe なので、中の操作は見えない。iframe に焦点が移ったこと(この画面の blur)で知る
async function touchedPreview() {
  const project = selectedProject();
  if (!project || firstSteps.dismissed || firstSteps.touching || !withoutAi(project) || preview.projectId !== project.id) return;
  const progress = project.firstSteps ?? {};
  if (progress.tried && (!progress.fixed || progress.triedFixed)) return;
  firstSteps.touching = true;
  try {
    await api('/api/first-steps', { method: 'POST', json: { touched: project.id } });
    await refresh();
  } catch (error) {
    handleError(error);
  } finally {
    firstSteps.touching = false;
  }
}

window.addEventListener('blur', () => {
  setTimeout(() => {
    if (preview.frame && document.activeElement === preview.frame) touchedPreview();
  }, 0);
});

// 終わって試作品が新しくなった実行。何を変えたかは、Studio が確かめた変わったファイルから言う(直す AI の報告に頼らない)
const UPDATED_STATUSES = new Set(['done', 'passed', 'fixed', 'unverified']);
const AI_SETTINGS_FILE = 'app/ai.json';

function updatedText(run) {
  const files = (run.changedFiles ?? []).map((change) => change.file);
  if (!UPDATED_STATUSES.has(run.status) || files.length === 0 || !run.build?.ok) return null;
  const what = [];
  if (files.includes(AI_SETTINGS_FILE)) what.push('AI の設定');
  if (files.some((file) => file !== AI_SETTINGS_FILE)) what.push('試作品のファイル');
  return `${what.join('と')}を変えました。試作品は新しくなっています。`;
}

// 開いている、実行ごとの「開発者向け」(再描画で閉じないよう、実行の ID で覚える)
const openRunDetails = new Set();

// 実行ごとの「開発者向け」。操作の詳細(ファイルの名前、道具の名前)、接続の名前、認証の報告を出す
function runDevDetails(run) {
  const box = element('details', undefined, 'run-dev');
  box.open = openRunDetails.has(run.id);
  box.addEventListener('toggle', () => (box.open ? openRunDetails.add(run.id) : openRunDetails.delete(run.id)));
  box.append(element('summary', '開発者向け: 操作の詳細'));
  const tools = run.items.filter((item) => item.kind === 'tool');
  if (tools.length > 0) {
    const list = element('ul');
    list.setAttribute('aria-label', '操作の詳細');
    list.append(...tools.map((item) => element('li', `${ITEM_LABELS.tool}: ${item.text}`)));
    box.append(list);
  }
  box.append(element('p', `接続: ${run.agent}`, 'muted'));
  if (run.auth) box.append(element('p', `認証の報告: ${run.auth}`, 'muted'));
  return box;
}

// 作るループの結果の帯(harness.md の 7.2、ux-redesign.md 4 節)。直す欄の依頼ごとに、状態の 1 文、
// 確かめた画面幅のスクリーンショット(押すと大きく)、直した回数を出す。関門ごとの結果、失敗の中身、
// シナリオの手順、直す依頼の文は「確かめた中身を見る」の中、節の列と report の場所は、その中の「開発者向け」に置く。
// 関門の並びは run.gates(run.json の関門の一覧)のまま出し、G1〜G6 を画面に決め打ちで書かない(agent-simulation.md の 8.2)
const EVIDENCE_STATUSES = new Set(['passed', 'fixed', 'failed', 'unverified', 'unchanged']);
const GATE_RESULT = { passed: '問題なし', failed: '問題あり', unverified: '確かめられませんでした', unchanged: '変わっていません', skipped: '行っていません' };
const STEP_RESULT = { passed: '通った', failed: '通らなかった', skipped: '行っていない' };
const SHOT_LABELS = { mobile: 'スマートフォン', tablet: 'タブレット', desktop: 'パソコン' };
const ERROR_KINDS = { runtime: '実行時のエラー', 'console-error': '画面の知らせのエラー', 'unhandled-rejection': '処理されない誤り', timeout: '時間切れ', evals: '場面の回し' };
const STALE_TEXT = 'この後に変わりました';
// 開いている「確かめた中身を見る」と、その中の開く操作(再描画で閉じないよう、実行の ID と場所で覚える)
const openEvidence = new Set();
// 証拠が古いか(/api/projects/:id/evidence)。runs は実行の ID ごと、checks は人の「確かめる」の ID ごとの stale
const evidence = { projectId: null, runs: new Map(), checks: new Map(), seq: 0, snapshot: '' };
// スクリーンショット。画像の API はトークンを要るので、fetch で読んで data: の URL にする(CSP の img-src は 'self' と data: だけ)
// 読めなかった画像は、同じ描画のたびに読み直さない。覚えておく画像の数には上限を付ける
const MAX_SHOTS = 60;
const shotUrls = new Map();
const shotLoads = new Map();
const shotFailed = new Set();

function firstSentence(text) {
  if (typeof text !== 'string' || !text) return '';
  return text.split('。')[0].trim();
}

function gateLabel(gate) {
  return ITEM_LABELS[`gate:${gate.name}`] ?? gate.label ?? gate.name;
}

// 直しきれなかった関門。直すラウンドで何も変わらなかったときは、前のラウンドの失敗(残っていれば)を先に言う
function failedGate(run) {
  const gates = run.gates ?? [];
  return gates.find((gate) => gate.status === 'failed') ?? gates.find((gate) => gate.status === 'unchanged' && run.round > 1) ?? null;
}

function hasEvidence(run) {
  return EVIDENCE_STATUSES.has(run.status) && (run.gates ?? []).some((gate) => gate.status !== 'skipped');
}

function keepOpenAs(box, key) {
  box.open = openEvidence.has(key);
  box.addEventListener('toggle', () => (box.open ? openEvidence.add(key) : openEvidence.delete(key)));
  return box;
}

function shotKey(projectId, file) {
  return `${projectId}\n${file}`;
}

function loadShot(projectId, file) {
  const key = shotKey(projectId, file);
  if (shotFailed.has(key)) return Promise.reject(new Error('画像を読めませんでした'));
  if (!shotLoads.has(key)) {
    const loading = (async () => {
      const response = await send(`/api/projects/${encodeURIComponent(projectId)}/evidence/screenshot?file=${encodeURIComponent(file)}`);
      if (!response.ok) throw new Error(`サーバーが ${response.status} を返しました`);
      const blob = await response.blob();
      const url = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(blob);
      });
      shotUrls.set(key, url);
      // 古いものから忘れる(忘れた画像は、また描くときに読み直す)
      for (const old of shotUrls.keys()) {
        if (shotUrls.size <= MAX_SHOTS) break;
        shotUrls.delete(old);
        shotLoads.delete(old);
      }
      return url;
    })();
    loading.catch(() => {
      shotLoads.delete(key);
      shotFailed.add(key);
    });
    shotLoads.set(key, loading);
  }
  return shotLoads.get(key);
}

function shotImage(projectId, file, alt) {
  const img = element('img');
  img.alt = alt;
  const ready = shotUrls.get(shotKey(projectId, file));
  if (ready) img.src = ready;
  else {
    loadShot(projectId, file)
      .then((url) => {
        img.src = url;
      })
      .catch(() => img.replaceWith(element('span', '画像を読めませんでした', 'muted')));
  }
  return img;
}

function shotName(shot) {
  return SHOT_LABELS[shot.name] ?? shot.name;
}

// 押すと大きく見る小さな画像
function shotButton(projectId, shot, caption) {
  const button = element('button', undefined, 'shot');
  button.type = 'button';
  button.setAttribute('aria-label', `${caption}を大きく見る`);
  button.append(shotImage(projectId, shot.file, caption));
  button.addEventListener('click', () => openShot(projectId, shot.file, caption));
  return button;
}

function openShot(projectId, file, caption) {
  els.shotDialogImage.replaceChildren(shotImage(projectId, file, caption));
  els.shotDialogCaption.textContent = caption;
  if (!els.shotDialog.open) els.shotDialog.showModal();
}

function gateProblems(gate) {
  const list = element('ul', undefined, 'evidence-problems');
  if (gate.reason) list.append(element('li', `理由: ${gate.reason}`));
  if (gate.summary && !gate.errors?.length && !gate.failures?.length) list.append(element('li', gate.summary));
  for (const failure of gate.failures ?? []) {
    // 関門 GE(場面)の失敗は、シナリオの代わりに場面の id と確かめを持つ
    const where = failure.eval !== undefined ? (failure.check ? `の確かめ「${failure.check}」` : '') : failure.step ? `の ${failure.step} 番目の手順` : '';
    const li = element('li', `${failure.eval !== undefined ? '場面' : ''}「${failure.eval ?? failure.scenario}」${where}で通りませんでした`);
    if (failure.expected) li.append(element('span', `期待: ${failure.expected}`, 'evidence-line'));
    li.append(element('span', `実際: ${failure.actual}`, 'evidence-line'));
    list.append(li);
  }
  for (const error of gate.errors ?? []) {
    list.append(element('li', error.text !== undefined ? `誤り: ${error.text}` : `${ERROR_KINDS[error.kind] ?? error.kind}: ${error.message}`));
  }
  const more = (gate.errorCount ?? 0) - (gate.errors?.length ?? 0);
  if (more > 0) list.append(element('li', `ほか ${more} 件`));
  return list;
}

// 関門ごとの結果。失敗と未確認には中身を添える
function gateList(gates, label) {
  const list = element('ul', undefined, 'evidence-gates');
  list.setAttribute('aria-label', label);
  for (const gate of gates) {
    const li = element('li');
    li.dataset.status = gate.status;
    li.append(element('span', gateLabel(gate), 'gate-name'), document.createTextNode(': '), element('span', GATE_RESULT[gate.status] ?? gate.status, 'gate-result'));
    if (gate.status === 'failed' || gate.status === 'unverified') li.append(gateProblems(gate));
    list.append(li);
  }
  return list;
}

// シナリオの手順と結果。関門の結果に scenarios があるものだけ(どの関門かは決め打ちにしない)
function scenarioSteps(projectId, gates) {
  const nodes = [];
  for (const gate of gates) {
    for (const scenario of gate.scenarios ?? []) {
      const box = element('div', undefined, 'evidence-scenario');
      box.dataset.verdict = scenario.verdict;
      const name = scenario.base ? `${scenario.name}(Studio がいつも確かめる手順)` : scenario.name;
      box.append(element('p', `「${name}」: ${scenario.verdict === 'passed' ? '通った' : '通らなかった'}`, 'evidence-scenario-name'));
      const steps = element('ol');
      steps.setAttribute('aria-label', `「${scenario.name}」の手順`);
      steps.append(...scenario.steps.map((step) => element('li', `${step.text}: ${STEP_RESULT[step.status] ?? step.status}`)));
      if (scenario.steps.length > 0) box.append(steps);
      const shot = (gate.failures ?? []).find((failure) => failure.scenario === scenario.name && failure.screenshot);
      if (shot) box.append(shotButton(projectId, { file: shot.screenshot }, `「${scenario.name}」で通らなかったときの画面`));
      nodes.push(box);
    }
  }
  return nodes;
}

// 直すラウンドごとの、見つけた問題と、直す AI に返した依頼の文
function fixHistory(run) {
  const nodes = [];
  for (const request of run.fixRequests ?? []) {
    const before = run.rounds?.find((round) => round.round === request.round - 1);
    const gate = (before?.gates ?? []).find((g) => g.status === 'failed');
    const box = element('div', undefined, 'evidence-fix');
    const subject = gate ? `「${gateLabel(gate)}」で問題が見つかったので、${FIX_AI} に直してもらいました` : `${FIX_AI} に直してもらいました`;
    box.append(element('p', `${request.round - 1} 回目: ${subject}`));
    const text = keepOpenAs(element('details', undefined, 'evidence-raw'), `${run.id}:fix:${request.round}`);
    text.append(element('summary', `${FIX_AI} に返した依頼の文`), element('pre', request.text));
    box.append(text);
    nodes.push(box);
  }
  return nodes;
}

// 開発者向け: 節の列、関門の ID、report と run.json の場所、誤りの場所
function evidenceDev(run) {
  const box = keepOpenAs(element('details', undefined, 'evidence-dev'), `${run.id}:dev`);
  box.append(element('summary', '開発者向け: 節の列と記録の場所'));
  const rounds = element('ul');
  rounds.setAttribute('aria-label', '節の列');
  for (const round of run.rounds ?? []) {
    const names = (run.nodes ?? []).filter((node) => node.round === round.round).map((node) => (node.gate ? `${node.gate} ${node.name}` : node.name));
    rounds.append(element('li', `ラウンド ${round.round}: ${names.join(' → ')}`));
  }
  box.append(rounds);
  const gates = element('ul');
  gates.setAttribute('aria-label', '関門');
  for (const gate of run.gates ?? []) {
    const li = element('li', `${gate.id} ${gate.label}(${gate.name}): ${gate.status}`);
    for (const error of gate.errors ?? []) {
      if (error.file) li.append(element('span', `${error.file}${error.line ? `:${error.line}${error.column ? `:${error.column}` : ''}` : ''} ${error.text ?? ''}`, 'evidence-line'));
    }
    gates.append(li);
  }
  box.append(gates);
  const files = element('ul');
  files.setAttribute('aria-label', '記録の場所');
  if (run.evidence?.run) files.append(element('li', run.evidence.run));
  for (const round of run.rounds ?? []) {
    for (const gate of round.gates ?? []) if (gate.report) files.append(element('li', `${gate.report}(ラウンド ${round.round}、${gate.id})`));
  }
  box.append(files);
  if (run.appDigest) box.append(element('p', `確かめた app/ の指紋: ${run.appDigest.slice(0, 12)}`, 'muted'));
  return box;
}

// check が true なら、人の「確かめる」の結果(checks.js。作る run と同じ形の gates を持つ)。
// again が true なら「もう一度確かめる」を置く(会話のいちばん新しい帯だけ)
function evidenceBand(projectId, run, { check = false, again = false } = {}) {
  const band = element('div', undefined, 'evidence');
  band.setAttribute('role', 'group');
  band.setAttribute('aria-label', '確かめた結果');
  band.dataset.status = run.status;
  const stale = evidence.projectId === projectId && (check ? evidence.checks : evidence.runs).get(run.id) === true;
  band.dataset.stale = String(stale);
  band.append(element('p', (check ? CHECK_STATUS : RUN_STATUS)[run.status](run), 'run-status'));
  if (stale) {
    const mark = element('p', undefined, 'evidence-stale');
    mark.append(element('strong', STALE_TEXT), document.createTextNode('。この結果は、今の試作品より前のものです。'));
    band.append(mark);
  }
  const shots = (run.gates ?? []).flatMap((gate) => gate.screenshots ?? []);
  if (shots.length > 0) {
    const list = element('ul', undefined, 'evidence-shots');
    list.setAttribute('aria-label', '確かめた画面');
    list.append(
      ...shots.map((shot) => {
        const caption = `${shotName(shot)}の幅で確かめた画面`;
        const li = element('li');
        li.append(shotButton(projectId, shot, caption), element('span', shot.width ? `${shotName(shot)}(幅 ${shot.width})` : shotName(shot), 'muted'));
        return li;
      }),
    );
    band.append(list);
  }
  const fixes = check ? 0 : (run.round ?? 1) - 1;
  if (fixes > 0) {
    const what = run.status === 'failed' ? '直そうとした回数' : '直した回数';
    band.append(element('p', `${FIX_AI} が${what}: ${fixes} 回(${run.maxFixRounds ?? fixes} 回まで)`, 'evidence-rounds muted'));
  }
  // 人の「確かめる」(P27)の「もう一度確かめる」
  const actions = element('div', undefined, 'evidence-actions');
  if (again) actions.append(...checkAgain());
  band.append(actions);
  const more = keepOpenAs(element('details', undefined, 'evidence-more'), `${run.id}:more`);
  more.append(element('summary', '確かめた中身を見る'), gateList(run.gates ?? [], '確かめたこと'));
  const steps = scenarioSteps(projectId, run.gates ?? []);
  if (steps.length > 0) more.append(element('p', '決めた手順', 'card-label'), ...steps);
  const history = check ? [] : fixHistory(run);
  if (history.length > 0) more.append(element('p', '見つけた問題と直したこと', 'card-label'), ...history);
  more.append(check ? checkDev(run) : evidenceDev(run));
  band.append(more);
  return band;
}

// 人の「確かめる」(harness.md の 3.1、P27)。その他の引き出しの「試作品を自動で確かめる」と、結果の帯の「もう一度確かめる」から始める。
// サーバー(src/server/checks.js)が、作るループと同じ観察の入口を、表示中の試作品を見るモードで呼ぶ。
// 結果は直す欄の会話に、作る run と時刻の順に並べ、同じ形の結果の帯で出す。試す欄の会話は変わらない
// 試作品の中の AI の接続の、利用者の言葉(確かめるときの AI、試し直しの前と後の返事)
const AI_WORDS = { mock: 'お試しの AI', 'claude-code': '本物の AI' };
const CHECK_STATUS = {
  running: () => '試作品を自動で確かめています…',
  passed: () => '確かめました。問題は見つかりませんでした',
  failed: (check) => {
    const gate = failedGate(check);
    const what = gate ? (RUN_STATUS[`failed:${gate.name}`] ?? (() => `${gateLabel(gate)}で問題が見つかりました`))(gate) : '問題が見つかりました';
    return `確かめました。${what}`;
  },
  unverified: (check) => {
    const gate = check.gates?.find((g) => g.status === 'unverified');
    const reason = firstSentence(check.reason ?? gate?.reason);
    return `自動の確かめができませんでした${reason ? `(${reason})` : ''}`;
  },
};
// byProject はプロジェクトごとの { version, list }。connection は引き出しで選んだ試作品の中の AI(既定はお試し)
const checks = { byProject: new Map(), connection: 'mock', starting: false, message: null, seq: 0 };

function checksOf(projectId) {
  return checks.byProject.get(projectId)?.list ?? [];
}

// 確かめを始められるか。作る run、ビルド、版の操作、確かめの間は押せない(サーバーも 409 で断る)
function canCheck(project) {
  if (!project) return false;
  const busy = project.running || project.building || project.versioning || project.checking || runningRun(project.id) || sending?.projectId === project.id;
  return !busy && !checks.starting && !versions.busy && !handoff.busy && !consent.agreeing;
}

// 結果の帯の「もう一度確かめる」と、そのときの試作品の中の AI
function checkAgain() {
  const project = selectedProject();
  const button = element('button', 'もう一度確かめる');
  button.type = 'button';
  button.disabled = !project || !canCheck(project);
  button.addEventListener('click', () => startCheck());
  if (!(ai.projectId === selectedId && ai.session)) return [button];
  return [button, element('span', `試作品の中の AI: ${AI_WORDS[checkConnection()]}`, 'muted')];
}

// 開発者向け: report の場所、観察の ID、確かめた app/ の指紋、接続
function checkDev(check) {
  const box = keepOpenAs(element('details', undefined, 'evidence-dev'), `${check.id}:dev`);
  box.append(element('summary', '開発者向け: 記録の場所'));
  const files = element('ul');
  files.setAttribute('aria-label', '記録の場所');
  if (check.report) files.append(element('li', check.report));
  box.append(files);
  const gates = element('ul');
  gates.setAttribute('aria-label', '関門');
  for (const gate of check.gates ?? []) gates.append(element('li', `${gate.id} ${gate.label}(${gate.name}): ${gate.status}`));
  box.append(gates);
  box.append(element('p', `試作品の中の AI の接続: ${check.connection}。AI のやり取り: ${check.aiEntries ?? 0} 件(report の ai)`, 'muted'));
  if (check.appDigest) box.append(element('p', `確かめた app/ の指紋: ${check.appDigest.slice(0, 12)}`, 'muted'));
  return box;
}

function checkItem(projectId, check, again) {
  const li = element('li', undefined, 'run check');
  li.dataset.status = check.status;
  const head = element('div', undefined, 'bubble user');
  const via = check.ai ? `(試作品の中の AI: ${AI_WORDS[check.connection] ?? check.connection})` : '';
  head.append(element('span', 'あなた', 'who'), element('p', `試作品を自動で確かめる${via}`));
  li.append(head);
  if (check.status === 'running') li.append(element('p', CHECK_STATUS.running(), 'run-status'));
  else li.append(evidenceBand(projectId, check, { check: true, again }));
  return li;
}

// 引き出しで選んだ試作品の中の AI。AI のない試作品と、本物を選べないときはお試し
function checkConnection() {
  const real = ai.projectId === selectedId ? ai.choices?.options.find((o) => o.kind === 'claude-code') : null;
  return checks.connection === 'claude-code' && real?.available !== false && ai.session ? 'claude-code' : 'mock';
}

// 引き出しの「試作品を自動で確かめる」
function renderCheck(project) {
  const real = ai.projectId === project?.id ? ai.choices?.options.find((o) => o.kind === 'claude-code') : null;
  // 試作品の中の AI を選べるのは、AI と話せる試作品だけ
  els.checkAi.hidden = !(project && ai.projectId === project.id && ai.session);
  const radios = els.checkAi.querySelectorAll('input[name="check-ai"]');
  for (const radio of radios) {
    radio.checked = radio.value === checkConnection();
    if (radio.value === 'claude-code') radio.disabled = !real || real.available === false;
  }
  els.checkAiNote.hidden = !(real && real.available === false);
  els.checkAiNote.textContent = real && real.available === false ? `本物の AI は選べません: ${real.reason}` : '';
  const card = consent.card?.use === 'check' && consent.card.projectId === project?.id ? consent.card : null;
  els.checkConsent.hidden = !card;
  els.checkConsent.replaceChildren(...(card ? [consentCard(card.view, { card })] : []));
  els.checkRun.disabled = !project || !canCheck(project);
  els.checkRun.textContent = project?.checking || checks.starting ? '確かめています…' : '試作品を自動で確かめる';
  const message = checks.message?.projectId === project?.id ? checks.message.text : '';
  els.checkMessage.hidden = !message;
  els.checkMessage.textContent = message;
}

// 一覧の版の番号(checksVersion)が変わったら、確かめの一覧を読み直す
async function syncChecks() {
  const project = selectedProject();
  if (!project) return;
  const cached = checks.byProject.get(project.id);
  if (cached && cached.version === project.checksVersion) return;
  const seq = ++checks.seq;
  try {
    const data = await api(`/api/projects/${encodeURIComponent(project.id)}/checks`);
    if (seq !== checks.seq) return;
    checks.byProject.set(project.id, { version: project.checksVersion, list: data.checks });
    if (project.id === selectedId) {
      renderMake(selectedProject());
      await loadEvidence();
    }
  } catch (error) {
    handleError(error);
  }
}

// 確かめを始める。本物の AI を選んでいて同意の前なら、引き出しに同意のカードを出し、同意したら始める
async function startCheck() {
  const project = selectedProject();
  if (!project || !canCheck(project)) return;
  const connection = checkConnection();
  checks.starting = true;
  checks.message = null;
  if (consent.card?.use === 'check') consent.card = null;
  renderMake(project);
  try {
    const data = await api(`/api/projects/${encodeURIComponent(project.id)}/checks`, { method: 'POST', json: { connection } });
    const cached = checks.byProject.get(project.id) ?? { version: -1, list: [] };
    checks.byProject.set(project.id, { version: -1, list: [...cached.list.filter((c) => c.id !== data.check.id), data.check] });
  } catch (error) {
    if (error instanceof ApiError && error.code === 'consent-required') {
      setMorePanel(true);
      await openConsent('check', { projectId: project.id });
    } else if (error instanceof ApiError && !['offline', 'token'].includes(error.code)) {
      checks.message = { projectId: project.id, text: `確かめられませんでした: ${error.message}` };
    } else {
      handleError(error);
    }
  } finally {
    checks.starting = false;
    lastSnapshot = '';
    await refresh();
    render();
  }
}

// 証拠が古いかを読む。古いかは、今の app/ の指紋と、run が確かめた指紋で決まる(次の依頼、版の復元、手で変えたとき)
async function loadEvidence() {
  const project = selectedProject();
  const runs = project ? conversations.get(project.id)?.runs ?? [] : [];
  const items = project ? [...runs, ...checksOf(project.id)] : [];
  if (!project || !items.some((item) => item.appDigest && item.status !== 'running')) return;
  const seq = ++evidence.seq;
  try {
    const data = await api(`/api/projects/${encodeURIComponent(project.id)}/evidence`);
    if (seq !== evidence.seq || project.id !== selectedId) return;
    const snapshot = JSON.stringify([data.runs, data.checks]);
    if (evidence.projectId === project.id && snapshot === evidence.snapshot) return;
    evidence.projectId = project.id;
    evidence.snapshot = snapshot;
    evidence.runs = new Map(data.runs.map((run) => [run.id, run.stale]));
    evidence.checks = new Map((data.checks ?? []).map((check) => [check.id, check.stale]));
    renderConversation(selectedProject());
  } catch (error) {
    if (seq !== evidence.seq) return;
    handleError(error);
  }
}

// 作る run と人の「確かめる」を、始めた時刻の順に並べる。「もう一度確かめる」は、いちばん新しい結果の帯にだけ置く
function renderConversation(project) {
  const runs = project ? conversations.get(project.id)?.runs ?? [] : [];
  const entries = [...runs.map((run) => ({ run })), ...(project ? checksOf(project.id) : []).map((check) => ({ check }))];
  entries.sort((a, b) => String((a.run ?? a.check).startedAt ?? '').localeCompare(String((b.run ?? b.check).startedAt ?? '')));
  const newest = entries.findLast((entry) => (entry.check ? entry.check.status !== 'running' : hasEvidence(entry.run)));
  const nodes = entries.map((entry) => (entry.check ? checkItem(project.id, entry.check, entry === newest) : runItem(project.id, entry.run, entry === newest)));
  if (makeError) nodes.push(element('li', makeError, 'make-error'));
  if (consent.declined && !consent.card) nodes.push(declinedBlock());
  if (consent.card?.use === 'fix' && consent.card.projectId === project?.id) nodes.push(consentCard(consent.card.view, { tag: 'li', card: consent.card }));
  if (nodes.length === 0) nodes.push(element('li', 'まだ依頼はありません。', 'muted empty'));
  const atBottom = els.conversation.scrollHeight - els.conversation.scrollTop - els.conversation.clientHeight < 40;
  els.conversation.replaceChildren(...nodes);
  if (atBottom || sending) els.conversation.scrollTop = els.conversation.scrollHeight;
  renderCheck(project);
}

function runItem(projectId, run, again) {
  const li = document.createElement('li');
  li.className = 'run';
  li.dataset.status = run.status;
  const request = element('div', undefined, 'bubble user');
  request.append(element('span', 'あなた', 'who'), element('p', run.request));
  li.append(request);
  const steps = element('ul', undefined, 'steps');
  let lastSummary = null;
  for (const item of run.items) {
    // 操作は短い文にする(ux-redesign.md 7-3)。続けて同じ文になるときは 1 つにまとめる
    if (item.kind === 'tool') {
      const summary = item.summary ?? '作業を進めました';
      if (summary === lastSummary) continue;
      lastSummary = summary;
      const step = element('li', undefined, 'step-short');
      step.dataset.kind = item.kind;
      step.append(element('span', summary, 'text'));
      steps.append(step);
      continue;
    }
    lastSummary = null;
    const step = document.createElement('li');
    step.dataset.kind = item.kind;
    if (item.kind === 'assistant') {
      step.className = 'bubble agent';
      step.append(element('span', FIX_AI, 'who'), element('p', item.text));
    } else {
      step.append(element('span', ITEM_LABELS[item.kind] ?? item.kind, 'who'), element('span', item.text, 'text'));
    }
    steps.append(step);
  }
  li.append(steps);
  const updated = updatedText(run);
  if (updated) li.append(element('p', updated, 'run-updated'));
  if (hasEvidence(run)) li.append(evidenceBand(projectId, run, { again }));
  else li.append(element('p', (RUN_STATUS[run.status] ?? (() => run.status))(run), 'run-status'));
  li.append(runDevDetails(run));
  return li;
}

function upsertRun(projectId, run) {
  const conversation = conversations.get(projectId) ?? { version: -1, runs: [] };
  const index = conversation.runs.findIndex((r) => r.id === run.id);
  if (index === -1) conversation.runs.push(run);
  else conversation.runs[index] = run;
  conversations.set(projectId, conversation);
  if (projectId === selectedId) renderMake(selectedProject());
}

// 一覧の版の番号が変わったら、会話を読み直す(再読み込みや、別のタブで送った依頼)
async function syncConversation() {
  const project = selectedProject();
  if (!project || sending?.projectId === project.id) return;
  const cached = conversations.get(project.id);
  if (cached && cached.version === project.runsVersion) return;
  try {
    const data = await api(`/api/projects/${encodeURIComponent(project.id)}/build-requests`);
    conversations.set(project.id, { version: project.runsVersion, runs: data.runs });
    if (project.id === selectedId) renderMake(selectedProject());
    // 終わった run が増えたら、前の証拠が古くなったかを読み直す
    if (project.id === selectedId) await loadEvidence();
  } catch (error) {
    handleError(error);
  }
}

async function readRuns(response, projectId) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
    let newline;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line.trim()) upsertRun(projectId, JSON.parse(line).run);
    }
    if (done) return;
  }
}

// 本物の AI を使う前の同意のカード(ux-redesign.md 6 節)。中身はサーバーが返す(/api/real-ai。src/server/real-ai.js の consentView)。
// 見える文字は利用者の言葉だけにする(U3)。指示の全文、上限、記録の扱いは「詳しく」の中に置く(開発の言葉を使ってよい)。
// card があれば「同意して使う」「やめる」を出す。印から開いた中身(place が try か make)は「閉じる」だけ
const CONSENT_HEADING = '本物の AI を使う前に';
const REAL_AI_MARK = '本物の AI(あなたの Claude Code)';
const DECLINED_TEXT = '言葉で直すには、本物の AI を使うことへの同意が要ります。';
// 開いている「詳しく」(再描画で閉じないよう、card か try か make で覚える)
const openConsentDetails = new Set();

// 料金の行。使った分だけかかる見込みのときは、上限の文も添える(ふだんは「詳しく」の中だけ)
function costText(cost) {
  const paid = ['api-key', 'settings'].includes(cost.kind) || ['api_key', 'third_party'].includes(cost.method);
  return paid ? `${cost.text}${cost.limits}` : cost.text;
}

function consentCard(view, { tag = 'div', card = null, place = null } = {}) {
  const { summary } = view;
  const key = card ? 'card' : place;
  const box = element(tag, undefined, 'consent-card');
  box.dataset.use = card?.use ?? 'info';
  box.setAttribute('role', 'group');
  box.setAttribute('aria-label', card ? CONSENT_HEADING : REAL_AI_MARK);
  box.append(element('h3', card ? CONSENT_HEADING : REAL_AI_MARK));
  if (!card && view.consent.agreedAt) {
    box.append(element('p', `${formatTime(view.consent.agreedAt)}に同意しました。Studio を止めるまで有効です。`, 'muted'));
  }
  box.append(element('p', summary.runsOn, 'consent-lead'));
  const facts = element('dl', undefined, 'consent-facts');
  const row = (term, value) => {
    const dd = element('dd');
    dd.append(value);
    facts.append(element('dt', term), dd);
  };
  const sends = element('ul');
  sends.setAttribute('aria-label', '送るもの');
  sends.append(...summary.sends.map((item) => element('li', item)));
  row('送るもの', sends);
  row('送らないもの', summary.notSent);
  row('送り先', summary.to);
  row('料金', costText(summary.cost));
  box.append(facts, element('p', summary.note, 'consent-note'), consentDetails(view, key));
  const buttons = element('div', undefined, 'consent-buttons');
  if (card) {
    const ok = element('button', '同意して使う', 'primary');
    ok.type = 'button';
    ok.disabled = consent.agreeing;
    ok.addEventListener('click', agreeConsent);
    const cancel = element('button', 'やめる');
    cancel.type = 'button';
    // 同意を送っている間は、やめられない(同意の後に送るか切り替えるかが、押した順とずれないように)
    cancel.disabled = consent.agreeing;
    cancel.addEventListener('click', declineConsent);
    buttons.append(ok, cancel);
  } else {
    const close = element('button', '閉じる');
    close.type = 'button';
    close.addEventListener('click', () => closeRealAiInfo(place));
    buttons.append(close);
  }
  box.append(buttons);
  return box;
}

function labeledList(label, items) {
  const list = element('ul');
  list.setAttribute('aria-label', label);
  list.append(...items.map((item) => element('li', item)));
  return [element('p', `${label}:`), list];
}

function fieldText(field) {
  if (field.options) return `${field.label}: ${field.options.join('、')}`;
  const range = Number.isFinite(field.min) || Number.isFinite(field.max) ? ` ${field.min ?? ''}〜${field.max ?? ''}` : '';
  return `${field.label}: 数${range}${field.unit ? `(${field.unit})` : ''}`;
}

// 「詳しく」。前の確認(試す欄の「接続を選ぶ」、直す欄の小さな確認)の中身を、ここへ移した
function consentDetails(view, key) {
  const { details, summary } = view;
  const box = element('details', undefined, 'consent-details');
  box.open = openConsentDetails.has(key);
  box.addEventListener('toggle', () => (box.open ? openConsentDetails.add(key) : openConsentDetails.delete(key)));
  box.append(element('summary', '詳しく(AI への指示の全文、1 回の上限、記録の扱い)'));
  const part = (heading, ...nodes) => {
    const section = element('section');
    section.append(element('h4', heading), ...nodes);
    box.append(section);
  };
  if (details.fix) {
    part(
      '言葉で直すとき',
      ...labeledList('言葉で直すときに送るもの', details.fix.items),
      element('p', details.fix.notSent),
      element('p', details.fix.tools),
      element('p', '直す AI に足す指示の全文:'),
      element('pre', details.fix.systemPrompt),
    );
  }
  const product = details.product;
  if (product) {
    part(
      '試作品の中の AI と話すとき',
      element('p', product.description),
      element('p', `送り先: ${product.sends.to}`),
      ...labeledList('話すときに送るもの', product.sends.items),
      element('p', product.sends.notSent),
      ...labeledList('覚える項目と選択肢', product.fields.map(fieldText)),
      element('p', `今の会話: ${product.conversation.messages} 件(本物の AI に切り替えると、この会話も送ります)`),
      element('p', `費用: ${product.billing.label}。${product.billing.text}`),
      element('p', `回数の制限: ${product.limits.text}`),
      element('p', product.tools),
      element('p', '送る指示の全文:'),
      element('pre', product.sends.systemPrompt),
    );
  }
  part('1 回の上限', element('p', summary.cost.limits));
  part('記録の扱い', ...(details.records ?? []).map((text) => element('p', text)));
  return box;
}

// 直す欄で「やめる」を選んだ後。「確かめる」で、もう一度カードを出す(欄の依頼は、送るを押すまで送らない)
function declinedBlock() {
  const li = element('li', undefined, 'consent-declined');
  const button = element('button', '確かめる');
  button.type = 'button';
  button.addEventListener('click', () => openConsent('fix', { projectId: selectedId }));
  li.append(element('p', DECLINED_TEXT), button);
  return li;
}

// サーバーの同意の状態を覚える。同意したら「やめる」の後の表示は消す
function setConsentState(state) {
  if (!state) return;
  const changed = consent.agreed !== Boolean(state.agreed);
  consent.agreed = Boolean(state.agreed);
  consent.agreedAt = state.agreedAt ?? null;
  if (consent.agreed) consent.declined = false;
  if (changed) {
    renderMake(selectedProject());
    renderAi();
  }
}

// 同意のカードを出す。同意の前に断られた直す欄の送信(send)と、試作品の中の AI を本物にするとき(kind)と、
// 本物の AI で確かめるとき(use が check。カードは引き出しの「試作品を自動で確かめる」に出す)に呼ぶ。
// カードは 1 枚だけにする。前のカードは閉じる(直す欄の依頼の文は欄に残る)
async function openConsent(use, { projectId, kind = null, send = false }) {
  if (!projectId) return;
  const seq = ++consent.seq;
  let view;
  try {
    view = await api(`/api/real-ai?project=${encodeURIComponent(projectId)}`);
  } catch (error) {
    if (seq === consent.seq) handleError(error);
    return;
  }
  if (seq !== consent.seq || projectId !== selectedId) return;
  setConsentState(view.consent);
  // 別のタブで同意していたら、カードは出さない。直す欄の依頼は欄に残っているので、もう一度送れば送られる
  if (view.consent.agreed) {
    if (use === 'product') await selectConnection(kind);
    else if (use === 'check') await startCheck();
    return;
  }
  openConsentDetails.delete('card');
  consent.card = { use, projectId, kind, send, view };
  if (use === 'product') setAiMenu(false);
  renderMake(selectedProject());
  renderAi();
}

// カードと、印から開いた中身を閉じる(試作品を切り替えたとき)
function closeConsent() {
  consent.seq += 1;
  consent.card = null;
  consent.info = null;
}

// 同意する。同意は Studio を止めるまで、直す AI と試作品の中の AI の両方に効く。
// 直す欄の送信で出したカードなら欄の依頼を送り、試す欄で出したカードなら本物の AI に切り替える
async function agreeConsent() {
  const card = consent.card;
  if (!card || consent.agreeing) return;
  consent.agreeing = true;
  renderMake(selectedProject());
  renderAi();
  let agreed = false;
  // 待つ間に、別のカードに入れ替わったか、試作品を切り替えて閉じたときは、同意だけをして送らない
  let still = false;
  try {
    const view = await api('/api/real-ai/consent', { method: 'POST' });
    agreed = true;
    still = consent.card === card;
    if (still) consent.card = null;
    setConsentState(view.consent);
  } catch (error) {
    handleError(error);
  } finally {
    consent.agreeing = false;
    renderMake(selectedProject());
    renderAi();
  }
  if (!agreed || !still || card.projectId !== selectedId) return;
  if (card.use === 'product') await selectConnection(card.kind);
  else if (card.use === 'check') await startCheck();
  else if (card.send) await submitRequest();
}

// やめる。直す欄では、同意が要ることと「確かめる」を出す。試作品の中の AI は、お試しのまま。
// 本物の AI で確かめるカードでは、確かめずに、同意が要ることを引き出しに出す
function declineConsent() {
  const card = consent.card;
  if (consent.agreeing) return;
  consent.card = null;
  if (card?.use === 'fix') consent.declined = true;
  if (card?.use === 'check') checks.message = { projectId: card.projectId, text: '本物の AI で確かめるには、同意が要ります。お試しの AI なら、同意なしで確かめられます。' };
  renderMake(selectedProject());
  renderAi();
}

// 本物の AI を使っている間の小さな印(試す欄の上と直す欄の上)。押すと、カードの中身をもう一度見られる。
// 試す欄は試作品の中の AI が本物のとき、直す欄は同意の後で直す AI が Claude Code のとき
function renderRealAiMarks() {
  const tryReal = Boolean(ai.session && ai.projectId === selectedId && ai.choices?.options.find((o) => o.kind === ai.session.connection.kind)?.billing);
  const makeReal = consent.agreed && agent?.kind === 'claude' && agent.ready;
  renderRealAiMark(els.realAiTry, els.realAiTryInfo, tryReal, 'try');
  renderRealAiMark(els.realAiMake, els.realAiMakeInfo, makeReal, 'make');
}

function renderRealAiMark(button, host, shown, place) {
  if (!shown && consent.info?.place === place) consent.info = null;
  const open = shown && consent.info?.place === place;
  button.hidden = !shown;
  button.setAttribute('aria-expanded', String(open));
  host.hidden = !open;
  host.replaceChildren(...(open ? [consentCard(consent.info.view, { place })] : []));
}

async function toggleRealAiInfo(place) {
  if (consent.info?.place === place) {
    closeRealAiInfo(place);
    return;
  }
  const seq = ++consent.seq;
  const projectId = selectedId;
  try {
    const view = await api(`/api/real-ai${projectId ? `?project=${encodeURIComponent(projectId)}` : ''}`);
    if (seq !== consent.seq || projectId !== selectedId) return;
    setConsentState(view.consent);
    openConsentDetails.delete(place);
    consent.info = { place, view };
    renderRealAiMarks();
  } catch (error) {
    handleError(error);
  }
}

function closeRealAiInfo(place) {
  if (consent.info?.place !== place) return;
  consent.info = null;
  renderRealAiMarks();
  (place === 'try' ? els.realAiTry : els.realAiMake).focus();
}

async function submitRequest() {
  const project = selectedProject();
  const text = els.requestText.value.trim();
  if (!project || !text || sending) return;
  sending = { projectId: project.id };
  makeError = null;
  if (consent.card?.use === 'fix') consent.card = null;
  renderMake(project);
  try {
    const response = await send(`/api/projects/${encodeURIComponent(project.id)}/build-requests`, {
      method: 'POST',
      json: { request: text },
    });
    if (!response.ok) {
      const body = await response.json().catch(() => null);
      throw new ApiError(body?.error?.code ?? 'http', body?.error?.message ?? `サーバーが ${response.status} を返しました`);
    }
    els.requestText.value = '';
    await readRuns(response, project.id);
  } catch (error) {
    if (error instanceof ApiError && error.code === 'consent-required') {
      // 依頼の文は欄に残す。同意のカードを出し、同意したら送る
      await openConsent('fix', { projectId: project.id, send: true });
    } else if (error instanceof ApiError && !['offline', 'token'].includes(error.code)) {
      makeError = `送れませんでした: ${error.message}`;
    } else if (error instanceof ApiError) {
      handleError(error);
    } else {
      // 読んでいる途中で切れた。実行はサーバーで続くので、一覧から読み直す
      makeError = `様子を受け取れなくなりました。少し待つと、会話を読み直します(${error.message})`;
    }
  } finally {
    sending = null;
    // 次の一覧で、サーバーの会話を読み直させる
    const conversation = conversations.get(project.id);
    if (conversation) conversation.version = -1;
    lastSnapshot = '';
    await refresh();
    render();
  }
}

function formatAiValue(field, value) {
  if (value === null || value === undefined) return '未定';
  return field.type === 'number' ? `${Number(value).toLocaleString('ja-JP')}${field.unit ?? ''}` : String(value);
}

function formatSeconds(ms) {
  return `${(ms / 1000).toLocaleString('ja-JP', { maximumFractionDigits: 1 })} 秒`;
}

// 最後の応答の、接続、速さ、費用
function lastReplyText(session) {
  const last = session.messages.findLast((m) => m.role === 'assistant' && m.via);
  if (!last) return '';
  const label = ai.choices?.options.find((o) => o.kind === last.via)?.label ?? last.via;
  const parts = [`最後の応答: ${label}`];
  if (Number.isFinite(last.elapsedMs)) parts.push(formatSeconds(last.elapsedMs));
  if (Number.isFinite(last.costUsd)) parts.push(`費用の目安 $${last.costUsd.toFixed(4)}`);
  return parts.join('、');
}

// 接続を選ぶ欄。選べない接続は、理由と次の手順を出す
function connectionPicker(session) {
  const box = element('fieldset', undefined, 'ai-picker');
  box.append(element('legend', '接続を選ぶ'));
  for (const option of ai.choices?.options ?? []) {
    const label = element('label');
    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'ai-connection';
    radio.value = option.kind;
    radio.checked = session.connection.kind === option.kind;
    radio.disabled = !option.available || waitingFor(ai.projectId) > 0 || ai.switching;
    radio.addEventListener('change', () => {
      // 本物の AI は、同意の前なら同意のカードを出す。同意の後とモックは、すぐ切り替える
      if (option.billing && !consent.agreed) openConsent('product', { projectId: ai.projectId, kind: option.kind });
      else selectConnection(option.kind);
    });
    label.append(radio, document.createTextNode(option.label));
    box.append(label);
    if (!option.available) box.append(...unavailableReason(option));
  }
  return box;
}

// 選べない接続の理由。Claude Code が見つからないときは、直す欄の使えないときのカード(7-5)と同じ 1 文にし、
// 場所や環境変数の名前の入った理由は「開発者向け」の中に出す
function unavailableReason(option) {
  if (option.code !== 'not-found') return [element('p', option.reason, 'hint')];
  const dev = element('details', undefined, 'card-dev');
  dev.append(element('summary', '開発者向け: 確かめた結果'), element('p', option.reason));
  return [element('p', UNAVAILABLE.missing.lead(), 'hint'), dev];
}

// 直す前と後の返事(試し直しの帯の中)。同じ発言への、前の設定の返事と新しい設定の返事を並べる。
// 前と後で AI(お試しか本物か)が違うときだけ、どちらの AI の返事かを添える
function retryResultBlock(result) {
  const box = element('section');
  box.setAttribute('aria-label', '直す前と後の返事');
  const list = element('ol');
  for (const reply of result.replies) {
    const li = document.createElement('li');
    const changed = reply.before !== reply.after;
    const via = (kind) => (reply.beforeVia && reply.afterVia && reply.beforeVia !== reply.afterVia ? `(${AI_WORDS[kind] ?? kind})` : '');
    li.dataset.changed = String(changed);
    li.append(
      element('p', `あなた: ${reply.text}`, 'retry-user'),
      element('p', `前${via(reply.beforeVia)}: ${reply.before ?? '(返事なし)'}`, 'retry-before'),
      element('p', `後${via(reply.afterVia)}: ${reply.after}`, 'retry-after'),
      element('p', changed ? '変わりました' : '同じ返事です', changed ? 'retry-changed' : 'muted'),
    );
    list.append(li);
  }
  box.append(list);
  if (result.skipped.length > 0) {
    box.append(element('p', `送り直さなかった修正(新しい設定にない項目か、決まりに合わない値): ${result.skipped.join('、')}`, 'hint'));
  }
  if (result.stopped) box.append(element('p', `途中で止まりました: ${result.stopped}`, 'failed'));
  return box;
}

// 試し直しの帯(ux-redesign.md 7-4)。試す欄の上に置く。試作品の中の AI の設定が変わった後に、
// 前の会話の発言と修正を、新しい設定で送り直す。応答するのは試作品の中の AI で、直す AI は動かない。
// 直す前と後の返事は、帯の中の開く操作で見る。本物の AI を選んでいるときは、使う回数をボタンの横に出す
function renderRetry() {
  const info = ai.session && ai.projectId === selectedId ? ai.retry : null;
  els.retryBar.hidden = !info?.available;
  if (!info?.available) {
    els.retryBar.replaceChildren();
    return;
  }
  const projectId = ai.projectId;
  const counts = `発言 ${info.userMessages} 件${info.corrections > 0 ? `、修正 ${info.corrections} 件` : ''}`;
  const fresh = !ai.session.messages.some((m) => m.role === 'user' || m.role === 'correction');
  const busy = info.retrying || retryingProjects.has(projectId);
  let text;
  if (busy) text = `前の会話(${counts})を、新しい設定で送り直しています…`;
  else if (info.result) text = `前の会話(${counts})を、新しい設定で送り直しました。`;
  else if (fresh) text = `会話は新しい設定で最初から始まっています。前の会話(${counts})を、新しい設定で送り直せます。`;
  else text = `設定が変わる前の会話(${counts})を、新しい設定で送り直せます。今の会話は最初に戻ります。`;
  const nodes = [element('h3', 'AI の設定が変わりました'), element('p', text)];
  const button = element('button', info.result ? 'もう一度試し直す' : '同じ発言で試し直す');
  button.type = 'button';
  button.disabled = busy || ai.switching || waitingFor(projectId) > 0;
  button.addEventListener('click', retryAi);
  nodes.push(button);
  const option = ai.choices?.options.find((o) => o.kind === ai.session.connection.kind);
  if (option?.billing) nodes.push(element('span', `発言 ${info.userMessages} 回分、本物の AI を使います`, 'retry-cost'));
  if (info.result) {
    const details = element('details', undefined, 'retry-result');
    details.open = retryOpen.has(projectId);
    details.addEventListener('toggle', () => (details.open ? retryOpen.add(projectId) : retryOpen.delete(projectId)));
    details.append(element('summary', '直す前と後の返事'), retryResultBlock(info.result));
    nodes.push(details);
  }
  els.retryBar.replaceChildren(...nodes);
}

// 試作品の中の AI を本物にするときの同意のカード。試す欄の上に出す
function renderTryConsent() {
  const card = consent.card?.use === 'product' && consent.card.projectId === ai.projectId ? consent.card : null;
  els.tryConsent.hidden = !card;
  els.tryConsent.replaceChildren(...(card ? [consentCard(card.view, { card })] : []));
}

// 応答を待つ間だけ、試す欄の上に「応答を止める」を出す。開発者向けの詳細を閉じていても止められるように
function renderAiWaiting() {
  const { session } = ai;
  const waiting = Boolean(session) && waitingFor(ai.projectId) > 0;
  els.aiWaiting.hidden = !waiting;
  if (!waiting) {
    els.aiWaiting.replaceChildren();
    return;
  }
  const stop = element('button', '応答を止める');
  stop.type = 'button';
  stop.addEventListener('click', cancelAi);
  els.aiWaiting.replaceChildren(element('span', `${session.connection.label} の応答を待っています…`), stop);
}

// プロダクト内 AI の接続(モックか実モデルか)と、AI が理解した状態を出す。
// 接続の選び方は試す欄の上の「AI: … ▾」に、状態は開発者向けの詳細に出す(試作品の中と二重に出さない)
function renderAi() {
  const { session } = ai;
  renderCheck(selectedProject());
  renderRetry();
  renderExamples();
  renderAiWaiting();
  renderTryConsent();
  renderRealAiMarks();
  renderFirstSteps(selectedProject());
  renderSimChoice();
  els.aiSwitch.hidden = !session;
  if (!session) {
    setAiMenu(false);
    els.aiMenu.replaceChildren();
    els.aiStatus.replaceChildren(
      element('p', ai.projectId ? 'この試作品はプロダクト内 AI を使っていません。' : '試作品を開くと、ここに出ます。', 'muted'),
    );
    renderTrace();
    syncTracePolling();
    return;
  }
  els.aiSwitch.dataset.kind = session.connection.kind;
  els.aiBadge.textContent = `AI: ${session.connection.label}`;
  els.aiSwitch.title = session.connection.description;
  const connection = element('p', undefined, 'ai-connection');
  connection.dataset.kind = session.connection.kind;
  connection.append(element('strong', `接続: ${session.connection.label}`), document.createTextNode(` ${session.connection.description}`));
  const nodes = [connection];
  // 接続の選び方は、試す欄の上の「AI: … ▾」の中に出す。
  // 本物の AI を選んでいる間の送り先と料金は、試す欄の上の小さな印を押すと見られる(renderRealAiMarks)
  els.aiMenu.replaceChildren(connectionPicker(session));
  const last = lastReplyText(session);
  if (last) nodes.push(element('p', last, 'muted ai-last'));
  const list = element('dl', undefined, 'ai-state');
  list.setAttribute('aria-label', 'AI が理解した状態');
  for (const field of session.fields) {
    list.append(element('dt', field.label), element('dd', formatAiValue(field, session.state[field.key])));
  }
  const count = session.messages.filter((m) => m.role === 'user').length;
  nodes.push(
    element('p', '架空のデータで試してください。実在の人や会社の情報は入れないでください。', 'muted'),
    element('p', session.name, 'ai-name'),
    element('p', `利用者の発言: ${count} 件`, 'muted'),
    list,
  );
  els.aiStatus.replaceChildren(...nodes);
  renderTrace();
  syncTracePolling();
}

// 返事の部品と参加者の種類の、画面の言葉
const PART_WORDS = { text: '文', buttons: 'ボタン', card: 'カード', carousel: 'カルーセル', notice: '知らせ' };
const PARTICIPANT_KINDS = { agent: '模擬のエージェント', harness: 'harness', human: '人(模擬)' };

// 構成と前提の選び方(開発者向けの詳細。docs/design/agent-simulation.md の sim-10)。構成のファイルがない試作品では出さない(R2)。
// 前提ごとに、使える部品とモデルを出す。選ぶと会話を最初からにする
function renderSimChoice() {
  const choices = ai.session && ai.projectId === selectedId ? ai.choices?.simulation : null;
  els.simChoice.hidden = !choices;
  if (!choices) {
    els.simChoiceBody.replaceChildren();
    return;
  }
  const disabled = waitingFor(ai.projectId) > 0 || ai.switching || retryingProjects.has(ai.projectId);
  const { selected } = choices;
  const current = choices.compositions.find((c) => c.file === selected.composition);
  const radio = (name, value, checked, onChange) => {
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = name;
    input.value = value;
    input.checked = checked;
    input.disabled = disabled;
    input.addEventListener('change', onChange);
    return input;
  };
  const compositions = element('fieldset', undefined, 'ai-picker');
  compositions.append(element('legend', '構成を選ぶ'));
  for (const composition of choices.compositions) {
    const label = element('label');
    const checked = composition.file === selected.composition;
    label.append(
      radio('sim-composition', composition.file, checked, () => chooseSimulation({ composition: composition.file })),
      document.createTextNode(`${composition.name}(app/${composition.file}${composition.default ? '、既定' : ''})`),
    );
    const who = composition.participants.map((p) => `${p.label}(${PARTICIPANT_KINDS[p.kind] ?? p.kind})`).join('、');
    compositions.append(label, element('p', `参加者: ${who}`, 'hint'));
  }
  const nodes = [element('p', '選ぶと、会話を最初からにします。試作品の中の AI は、選んだ構成と前提で答えます。', 'muted'), compositions];
  if (current?.assumptions.length > 0) {
    const assumptions = element('fieldset', undefined, 'ai-picker');
    assumptions.append(element('legend', '前提を選ぶ'));
    for (const assumption of current.assumptions) {
      const label = element('label');
      label.append(
        radio('sim-assumptions', assumption.id, assumption.id === selected.assumptions, () =>
          chooseSimulation({ composition: current.file, assumptions: assumption.id }),
        ),
        document.createTextNode(`${assumption.name}(${assumption.id}${assumption.id === current.defaultAssumptions ? '、既定' : ''})`),
      );
      const model = assumption.model ? `。モデル: ${assumption.model}${assumption.standIn ? '(代わりのモデル)' : ''}` : '';
      assumptions.append(label, element('p', `使える部品: ${assumption.parts.map((kind) => PART_WORDS[kind] ?? kind).join('、')}${model}`, 'hint'));
    }
    nodes.push(assumptions);
  } else {
    nodes.push(element('p', 'この構成は前提を使いません(模擬のエージェントがいません)。', 'muted'));
  }
  els.simChoiceBody.replaceChildren(...nodes);
}

// 構成と前提を選ぶ。会話は最初からになるので、試作品も開き直す(「会話を最初から」と同じ)
async function chooseSimulation(choice) {
  const projectId = ai.projectId;
  if (!projectId) return;
  ai.switching = true;
  renderAi();
  try {
    const { session, retry, simulation } = await api(`/api/projects/${encodeURIComponent(projectId)}/ai/simulation`, { method: 'POST', json: choice });
    if (ai.projectId !== projectId) return;
    if (ai.choices) ai.choices.simulation = simulation;
    showAiSession(projectId, session, retry);
    const { selected, compositions } = simulation;
    const composition = compositions.find((c) => c.file === selected.composition);
    const assumption = composition?.assumptions.find((a) => a.id === selected.assumptions);
    addEvent('info', `構成「${composition?.name ?? selected.composition}」${assumption ? `と前提「${assumption.name}」` : ''}にしました。会話は最初からです。`);
    const project = selectedProject();
    if (project?.id === projectId && project.previewUrl) {
      preview.unexpectedLoads = [];
      showPreview(project.previewUrl, project.id);
    }
  } catch (error) {
    if (error instanceof ApiError && !['offline', 'token'].includes(error.code)) {
      addEvent('warning', `構成と前提を選べませんでした: ${error.message}`);
    } else {
      handleError(error);
    }
  } finally {
    ai.switching = false;
    renderAi();
  }
}

async function loadAi(projectId) {
  const seq = ++ai.seq;
  if (projectId !== ai.projectId) setAiMenu(false);
  ai.projectId = projectId;
  ai.session = null;
  ai.loaded = false;
  ai.choices = null;
  ai.retry = null;
  renderAi();
  if (!projectId) return;
  try {
    const base = `/api/projects/${encodeURIComponent(projectId)}/ai`;
    const [{ session, retry }, choices] = await Promise.all([api(base), api(`${base}/connections`)]);
    if (seq !== ai.seq) return;
    ai.session = session;
    ai.retry = retry ?? null;
    ai.choices = choices;
    loadTrace(projectId);
  } catch (error) {
    if (seq !== ai.seq) return;
    if (!(error instanceof ApiError && error.code === 'no-ai')) handleError(error);
  }
  ai.loaded = true;
  renderAi();
}

function showAiSession(projectId, session, retry) {
  if (ai.projectId !== projectId) return;
  // 先に送った読み込みの結果で、新しい状態を上書きしない。読み込みは、これで終わったことにする
  ai.seq += 1;
  ai.session = session;
  ai.loaded = true;
  if (retry !== undefined) ai.retry = retry;
  if (ai.choices) ai.choices.selected = session.connection.kind;
  renderAi();
  loadTrace(projectId);
  // 会話が変わると、作業中が保存した版と同じかどうかも変わる
  if (projectId === selectedId) loadVersions();
}

function versionLabel(version) {
  return `v${version.number}${version.name ? `「${version.name}」` : ''}`;
}

// 文の中で、後ろに言葉が続くとき。「」で終わらないときだけ空白を入れる
function versionSubject(version) {
  return version.name ? versionLabel(version) : `${versionLabel(version)} `;
}

// 作業中(今の app/ と、メモリーにある会話と状態)と、保存した版を分けて見せる
function workingView(data) {
  const { working } = data;
  const version = data.versions.find((v) => v.id === working.versionId);
  const base = data.versions.find((v) => v.id === working.baseVersionId);
  if (working.files === 'none') {
    return {
      state: 'unsaved',
      text: '作業中: まだ保存した版はありません。良い状態になったら保存してください。',
    };
  }
  if (working.files === 'changed' || !version) {
    return {
      state: 'changed',
      text: `作業中には、保存していない変更があります${base ? `(保存版 ${versionSubject(base)}から)` : ''}。`,
    };
  }
  if (working.conversation === 'changed') {
    return {
      state: 'partly',
      text: `作業中のファイルは保存版 ${versionSubject(version)}と同じです。会話と状態は、保存したときから変わっています。`,
    };
  }
  if (working.conversation === 'initial') {
    return {
      state: 'partly',
      text: `作業中のファイルは保存版 ${versionSubject(version)}と同じです。会話と状態は最初のままです。保存したときの会話から続けるには、その版の「復元」を押してください。`,
    };
  }
  return { state: 'saved', text: `作業中は保存版 ${versionSubject(version)}と同じです。` };
}

// 上の帯の保存の印。保存していない変更があるときだけ出す(ux-redesign.md の気づいたこと A)。
// まだ版がないときは、ファイルが最初から変わったかをサーバーが知らないので、
// 会話が進んだか、作る AI の依頼(app/ を変えなかったものを除く)があれば、変更ありとする
function hasUnsavedChanges(project, working) {
  if (working.files === 'changed' || working.conversation === 'changed') return true;
  if (working.files !== 'none') return false;
  return (conversations.get(project.id)?.runs ?? []).some((run) => run.status !== 'unchanged');
}

function renderSaveMark(project) {
  const data = project && versions.projectId === project.id ? versions.data : null;
  els.saveMark.hidden = !(data && hasUnsavedChanges(project, data.working));
}

function versionItem(project, version, working, locked) {
  const li = element('li', undefined, 'version');
  li.dataset.versionId = version.id;
  const head = element('p', undefined, 'version-head');
  head.append(element('strong', `v${version.number}`));
  if (version.name) head.append(element('span', version.name, 'version-name'));
  if (version.kind === 'auto') head.append(element('span', '自動', 'tag'));
  if (working.files === 'saved' && working.versionId === version.id) head.append(element('span', '作業中と同じ', 'tag current'));
  const conversation = version.ai ? `会話: 発言 ${version.ai.userMessages} 件` : '会話は最初のまま';
  const meta = [new Date(version.savedAt).toLocaleString('ja-JP'), `ファイル ${version.fileCount} 個`, conversation];
  if (!version.builds) meta.push('ビルドできない状態');
  const button = element('button', '復元');
  button.type = 'button';
  button.disabled = locked;
  button.setAttribute('aria-label', `v${version.number} を復元`);
  button.title = 'この版のファイルと会話に戻します。今の作業中がどの版とも違えば、先に自動で保存します';
  button.addEventListener('click', () => restoreVersion(project, version));
  li.append(head, element('p', meta.join('・'), 'muted'), button);
  return li;
}

function renderVersions(project) {
  const data = project && versions.projectId === project.id ? versions.data : null;
  const locked = !project || project.running || project.building || project.versioning || project.checking || versions.busy || handoff.busy;
  els.versionName.disabled = locked;
  els.saveVersion.disabled = locked;
  lockHandoff(project);
  els.versionsMessage.hidden = !versions.message;
  els.versionsMessage.textContent = versions.message?.text ?? '';
  els.versionsMessage.dataset.kind = versions.message?.kind ?? '';
  els.saveNow.disabled = locked;
  renderSaveMark(project);
  if (!data) {
    els.workingStatus.textContent = project ? '読み込んでいます…' : '';
    els.versionList.replaceChildren();
    return;
  }
  const view = workingView(data);
  els.workingStatus.dataset.state = view.state;
  els.workingStatus.textContent = view.text;
  els.versionList.replaceChildren(...data.versions.map((version) => versionItem(project, version, data.working, locked)));
}

function applyVersions(projectId, data) {
  // 先に送った一覧の読み込みの結果で、上書きしない
  versions.seq += 1;
  versions.projectId = projectId;
  versions.data = { versions: data.versions, working: data.working };
}

async function loadVersions() {
  const projectId = selectedProject()?.id ?? null;
  const seq = ++versions.seq;
  if (!projectId) {
    versions.projectId = null;
    versions.data = null;
    renderVersions(null);
    return;
  }
  try {
    const data = await api(`/api/projects/${encodeURIComponent(projectId)}/versions`);
    if (seq !== versions.seq || projectId !== selectedId) return;
    const changed = versions.projectId !== projectId || JSON.stringify(data) !== JSON.stringify(versions.data);
    versions.projectId = projectId;
    versions.data = data;
    if (changed) renderVersions(selectedProject());
  } catch (error) {
    if (seq !== versions.seq) return;
    handleError(error);
  }
}

function versionsFailed(error, what) {
  if (error instanceof ApiError && ['offline', 'token'].includes(error.code)) handleError(error);
  versions.message = { kind: 'failed', text: `${what}: ${error.message}` };
}

async function saveVersion() {
  const project = selectedProject();
  if (!project || versions.busy) return;
  versions.busy = true;
  versions.message = null;
  renderVersions(project);
  try {
    const data = await api(`/api/projects/${encodeURIComponent(project.id)}/versions`, {
      method: 'POST',
      json: { name: els.versionName.value },
    });
    if (selectedId === project.id) applyVersions(project.id, data);
    els.versionName.value = '';
    versions.message = { kind: 'ok', text: `${versionSubject(data.version)}として保存しました。` };
  } catch (error) {
    versionsFailed(error, '保存できませんでした');
  } finally {
    versions.busy = false;
    if (selectedId !== project.id) versions.message = null;
    renderVersions(selectedProject());
  }
}

// 版の保存や復元の間も押せないようにする。renderVersions からも呼ぶ
function lockHandoff(project) {
  const locked =
    !project || handoff.projectId !== project.id || project.running || project.building || project.versioning || project.checking || versions.busy || handoff.busy;
  for (const field of Object.values(els.handoffNotes)) field.disabled = locked;
  els.handoffExport.disabled = locked;
  els.handoffExport.textContent = handoff.busy ? '書き出しています…' : '引き継ぎ用に書き出す';
}

function renderHandoff(project) {
  lockHandoff(project);
  const box = els.handoffResult;
  if (handoff.message) {
    box.hidden = false;
    box.dataset.kind = 'failed';
    box.replaceChildren(element('p', handoff.message));
    return;
  }
  if (handoff.result) {
    const { dir, counts, excluded } = handoff.result;
    box.hidden = false;
    box.dataset.kind = 'ok';
    const where = element('p', '書き出した場所: ');
    where.append(element('code', dir));
    const copy = element('button', '場所をコピー');
    copy.type = 'button';
    copy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(dir);
        copy.textContent = 'コピーしました';
      } catch {
        copy.textContent = 'コピーできません。場所を選んでコピーしてください';
      }
    });
    const nodes = [
      element('p', `書き出しました。実機 ${counts.real} 件、モック ${counts.mock} 件、未接続 ${counts.missing} 件、未決事項 ${counts.questions} 件。`),
      where,
      copy,
      element('p', 'フォルダーの README.md に、区分の一覧、未決事項、試した会話があります。フォルダーごと開発の担当者に渡してください。', 'muted'),
    ];
    if (excluded.length > 0) nodes.push(element('p', `秘密を入れるファイルは外しました: ${excluded.map((e) => e.path).join('、')}`, 'muted'));
    box.replaceChildren(...nodes);
    return;
  }
  if (handoff.last) {
    box.hidden = false;
    box.dataset.kind = 'last';
    const last = element('p', `前に書き出したもの(${new Date(handoff.last.createdAt).toLocaleString('ja-JP')}): `);
    last.append(element('code', handoff.last.dir));
    box.replaceChildren(last);
    return;
  }
  box.hidden = true;
  box.replaceChildren();
}

async function loadHandoff(projectId) {
  const seq = ++handoff.seq;
  handoff.target = projectId;
  handoff.projectId = null;
  handoff.result = null;
  handoff.message = null;
  handoff.last = null;
  for (const field of Object.values(els.handoffNotes)) field.value = '';
  if (!projectId) return;
  try {
    const data = await api(`/api/projects/${encodeURIComponent(projectId)}/handoff`);
    if (seq !== handoff.seq || projectId !== selectedId) return;
    for (const [key, field] of Object.entries(els.handoffNotes)) field.value = data.notes[key] ?? '';
    handoff.last = data.last;
  } catch (error) {
    if (seq !== handoff.seq) return;
    if (error instanceof ApiError && ['offline', 'token'].includes(error.code)) handleError(error);
    handoff.message = `引き継ぎのメモを読めませんでした: ${error.message}`;
  }
  handoff.projectId = projectId;
  renderHandoff(selectedProject());
}

async function exportHandoff() {
  const project = selectedProject();
  if (!project || handoff.busy || handoff.projectId !== project.id) return;
  handoff.busy = true;
  handoff.result = null;
  handoff.message = null;
  renderHandoff(project);
  renderVersions(project);
  try {
    const notes = Object.fromEntries(Object.entries(els.handoffNotes).map(([key, field]) => [key, field.value]));
    const data = await api(`/api/projects/${encodeURIComponent(project.id)}/handoff`, { method: 'POST', json: notes });
    if (handoff.projectId !== project.id) return;
    handoff.result = data.handoff;
    handoff.last = data.last;
  } catch (error) {
    if (error instanceof ApiError && ['offline', 'token'].includes(error.code)) handleError(error);
    if (handoff.projectId === project.id) handoff.message = `書き出せませんでした: ${error.message}`;
  } finally {
    handoff.busy = false;
    renderHandoff(selectedProject());
    renderVersions(selectedProject());
  }
}

// 版のファイルと会話に戻す。サーバーがビルドし直すので、試す画面は新しいビルドで開き直す
async function restoreVersion(project, version) {
  if (versions.busy) return;
  versions.busy = true;
  versions.message = null;
  renderVersions(project);
  try {
    const data = await api(`/api/projects/${encodeURIComponent(project.id)}/versions/${version.id}/restore`, { method: 'POST' });
    if (selectedId === project.id) applyVersions(project.id, data);
    let text = `${versionSubject(data.restored)}に戻しました。`;
    if (data.autoSaved) text += `戻す前の作業中は v${data.autoSaved.number}(自動)に保存しました。`;
    if (data.setAside) text += `戻す前の作業中は大きすぎて版にできないので、${data.setAside} に移しました。`;
    if (!data.build.ok) text += 'ただし、ビルドに失敗しました。試す画面は前の版のままです。「ビルド」の欄を見てください。';
    else if (data.conversation === 'initial') text += '保存した会話は今の AI の設定に合わないので、会話は最初から始めます。';
    versions.message = { kind: data.build.ok ? 'ok' : 'failed', text };
  } catch (error) {
    versionsFailed(error, '戻せませんでした');
  } finally {
    versions.busy = false;
    if (selectedId !== project.id) versions.message = null;
    lastSnapshot = '';
    await refresh();
    render();
  }
}

async function selectConnection(kind) {
  const projectId = ai.projectId;
  if (!projectId) return;
  ai.switching = true;
  renderAi();
  try {
    const { session, retry } = await api(`/api/projects/${encodeURIComponent(projectId)}/ai/connection`, {
      method: 'POST',
      json: { kind },
    });
    if (ai.projectId !== projectId) return;
    setAiMenu(false);
    addEvent('info', `プロダクト内 AI の接続を「${session.connection.label}」にしました。会話と状態はそのまま引き継ぎます。`);
    showAiSession(projectId, session, retry);
    // 試作品にも知らせる(studio.ai.onChange)
    if (preview.projectId === projectId) preview.port?.postMessage({ type: 'ai-session', session });
  } catch (error) {
    if (error instanceof ApiError && error.code === 'consent-required') {
      // 画面の覚えている同意が、サーバーと食い違っていた。カードを出す
      setConsentState({ agreed: false, agreedAt: null });
      openConsent('product', { projectId, kind });
    } else if (error instanceof ApiError && !['offline', 'token'].includes(error.code)) {
      addEvent('warning', `接続を切り替えられませんでした: ${error.message}`);
    } else {
      handleError(error);
    }
  } finally {
    ai.switching = false;
    renderAi();
  }
}

// 設定が変わる前の会話の発言と修正を、今の設定と今の接続で送り直し、試作品を開き直す
async function retryAi() {
  const projectId = ai.projectId;
  if (!projectId || retryingProjects.has(projectId)) return;
  retryingProjects.add(projectId);
  waitingByProject.set(projectId, waitingFor(projectId) + 1);
  renderAi();
  try {
    const { session, retry } = await api(`/api/projects/${encodeURIComponent(projectId)}/ai/retry`, { method: 'POST' });
    // 直す前と後の返事は、帯の中で開いて見せる
    retryOpen.add(projectId);
    showAiSession(projectId, session, retry);
    // 試し直すと、最初の一歩の案内の 3 番が済む
    refresh();
    const result = retry.result;
    if (result?.stopped) addEvent('warning', `試し直しが途中で止まりました: ${result.stopped}`);
    else addEvent('info', `前の会話の発言 ${result?.replies.length ?? 0} 件を、今の設定で送り直しました。`);
    // 試作品は、送り直した会話で開き直す(リセットと同じ)
    const project = selectedProject();
    if (project?.id === projectId && project.previewUrl) {
      preview.unexpectedLoads = [];
      showPreview(project.previewUrl, project.id);
    }
  } catch (error) {
    if (error instanceof ApiError && !['offline', 'token'].includes(error.code)) {
      addEvent('warning', `試し直せませんでした: ${error.message}`);
      // 途中まで送った会話と、試し直せる会話を読み直す
      try {
        const { session, retry } = await api(`/api/projects/${encodeURIComponent(projectId)}/ai`);
        showAiSession(projectId, session, retry);
      } catch {
        // 読めなければ、次に開いたときに読む
      }
    } else {
      handleError(error);
    }
  } finally {
    retryingProjects.delete(projectId);
    waitingByProject.set(projectId, Math.max(0, waitingFor(projectId) - 1));
    if (ai.projectId === projectId) renderAi();
  }
}

// 応答を待っている実行を止める。止めた発言は会話に残らない
async function cancelAi() {
  const projectId = ai.projectId;
  if (!projectId) return;
  try {
    await api(`/api/projects/${encodeURIComponent(projectId)}/ai/cancel`, { method: 'POST' });
  } catch (error) {
    handleError(error);
  }
}

// AI の実行の記録。試作品の中の AI に、何を渡し、何が返り、状態がどう変わり、なぜ失敗したかを出す
const TRACE_STATUS = {
  running: '応答を待っています…',
  ok: '終わりました',
  failed: '失敗しました',
  cancelled: '止めました',
};
const TRACE_FORMATS = {
  structured: '構造化出力(--json-schema)を読みました',
  'text-json': '構造化出力がなかったので、本文の JSON を読みました(代わりの方法)',
  broken: '形の合わない出力がありました(やり直しと代わりの値は、harness の段に出ます)',
};
const CALL_KINDS = { extract: '抽出', phrase: '言い方' };

function connectionNote(connection) {
  return connection.real ? `${connection.label}(実際の AI モデル)` : `${connection.label}(AI モデルは呼んでいません)`;
}

function traceTitle(entry) {
  if (entry.type === 'reply') return `発言 → ${connectionNote(entry.connection)}`;
  if (entry.type === 'correction') return '状態の修正(試作品から)';
  if (entry.type === 'connection') return `接続の切り替え: ${entry.previous.label} → ${entry.connection.label}(Studio の画面から)`;
  if (entry.type === 'open') return `観察の会話を始めました → ${connectionNote(entry.connection)}`;
  if (entry.type === 'simulation') {
    const assumption = entry.assumptions ? `、前提「${entry.assumptions.name ?? entry.assumptions.id}」` : '';
    return `構成「${entry.composition.name ?? entry.composition.file}」${assumption}を選び、会話を最初からにしました(Studio の画面から)`;
  }
  return '会話と状態を最初に戻しました(Studio の画面から)';
}

function changeList(label, changes) {
  const list = element('ul', undefined, 'trace-changes');
  list.setAttribute('aria-label', label);
  list.append(...changes.map((change) => element('li', `${change.label}: ${change.from} → ${change.to}`)));
  return list;
}

function labeled(label, text, className) {
  const p = element('p', undefined, className);
  p.append(element('strong', `${label}: `), document.createTextNode(text));
  return p;
}

// 開いている欄は、記録を描き直しても開いたままにする
function keepOpen(box, key) {
  box.open = trace.open.has(key);
  box.addEventListener('toggle', () => (box.open ? trace.open.add(key) : trace.open.delete(key)));
}

function preBlock(entry, summary, text) {
  const box = element('details');
  keepOpen(box, `${entry.id}:${summary}`);
  box.append(element('summary', summary), element('pre', text));
  return box;
}

// 開発の担当者向け。接続に渡したもの、受け取ったもの
function traceInternals(entry) {
  const box = element('details', undefined, 'trace-internals');
  keepOpen(box, String(entry.id));
  const { input, output } = entry;
  // 起動できなかったときは、送っていないことをはっきり出す
  box.append(
    element('summary', input.notSent ? 'AI に渡すはずだったもの(起動できなかったので、送っていません)' : 'AI に渡したもの、受け取ったもの(開発向け)'),
  );
  box.append(labeled(input.notSent ? '送り先(送っていません)' : '送り先', input.to ?? 'どこにも送りません(Studio の中で応答します)'));
  if (input.tools) box.append(labeled('使えるツール', input.tools));
  if (input.rule) box.append(labeled('応答のしかた', input.rule));
  box.append(labeled('渡した会話', `${input.history} 件と、新しい発言`));
  if (input.state?.length) box.append(labeled('渡した状態', input.state.map((s) => `${s.label}「${s.value}」`).join('、')));
  if (input.command) {
    const command = labeled('起動の形', '');
    command.append(element('code', input.command.join(' ')));
    box.append(command);
  }
  // 抽出を呼ばずに読んだターンでは、抽出の本文は送っていない
  const extractSkipped = entry.harness?.extract?.via === 'shortcut';
  if (input.systemPrompt) box.append(preBlock(entry, extractSkipped ? '指示(--system-prompt)の全文(抽出を呼ばなかったので、送っていません)' : '指示(--system-prompt)の全文', input.systemPrompt));
  if (input.stdin) box.append(preBlock(entry, extractSkipped ? '本文(標準入力)の全文(抽出を呼ばなかったので、送っていません)' : '本文(標準入力)の全文', input.stdin));
  if (input.phrase) {
    const command = labeled('言い方の起動の形', '');
    command.append(element('code', input.phrase.command.join(' ')));
    box.append(command);
    box.append(preBlock(entry, '言い方の指示の全文', input.phrase.systemPrompt));
  }
  if (entry.harness?.phrase?.stdin) box.append(preBlock(entry, '言い方の本文の全文', entry.harness.phrase.stdin));
  if (entry.harness?.phrase?.retryStdin) box.append(preBlock(entry, '言い方のやり直しの本文の全文', entry.harness.phrase.retryStdin));
  if (entry.calls) {
    const kinds = Object.keys(CALL_KINDS).map((kind) => `${CALL_KINDS[kind]} ${entry.calls[kind]} 回`).join('、');
    box.append(labeled('実際の AI モデルの呼び出し', `${entry.calls.count} 回(${kinds})、待った時間の合計 ${formatSeconds(entry.calls.waitMs)}`));
    const list = element('ol', undefined, 'trace-calls');
    list.setAttribute('aria-label', '呼び出しの 1 回ずつ');
    list.append(
      ...entry.calls.calls.map((call) =>
        element(
          'li',
          [
            `${CALL_KINDS[call.kind] ?? call.kind}(${call.attempt} 回目)`,
            Number.isFinite(call.waitMs) ? `待った時間 ${formatSeconds(call.waitMs)}` : null,
            call.problem ? `出力が壊れていた: ${call.problem}` : null,
            call.error ? `失敗: ${call.error}` : null,
          ]
            .filter(Boolean)
            .join('、'),
        ),
      ),
    );
    box.append(list);
  }
  if (output) {
    if (output.format) box.append(labeled('応答の形', TRACE_FORMATS[output.format] ?? output.format));
    box.append(labeled('受け取った updates', output.updates));
    if (Number.isFinite(output.costUsd)) box.append(labeled('費用の目安(CLI の報告)', `$${output.costUsd.toFixed(4)}`));
    if (Number.isFinite(output.durationMs)) box.append(labeled('処理の時間(CLI の報告)', formatSeconds(output.durationMs)));
  }
  return box;
}

const STAGE_EXTRACT = {
  shortcut: '抽出を呼ばずに読みました',
  connection: '接続の抽出(extract)を呼びました',
  respond: '接続の 1 回の呼び出し(返事と updates)の updates を使いました',
};
const STAGE_PHRASE = {
  connection: '接続の言い方(phrase)を呼びました',
  respond: '接続の 1 回の呼び出しの返事を使いました(決定の前に作られた返事です)',
};
const STAGE_SAY = { summary: '条件のまとめ', complete: '終わりの文' };
const GUARD_RESULTS = { passed: '合格', retried: 'やり直して合格', fallback: '決まった文(mock の型)に代えた' };
const GUARD_LABELS = { noNewNumbers: '数字を作らない', noLeading: '誘導しない', mustAsk: '聞くべき問いを入れる', maxReplyChars: '長さ', forbidden: '禁止の言葉', noJsonText: 'JSON の文を出さない' };
const TIMEOUT_STAGES = { extract: '抽出', phrase: '言い方' };

// 開発の担当者向け。harness の 3 段(抽出 → 決定 → 言い方)の中身。モデルの判断と決まった手順の境目を見せる
function traceStages(entry) {
  const { extract, decision, phrase } = entry.harness;
  const box = element('details', undefined, 'trace-internals');
  keepOpen(box, `${entry.id}:stages`);
  box.append(element('summary', 'harness の段: 抽出 → 決定 → 言い方(開発向け)'));
  const stage = (text) => {
    const p = element('p');
    p.append(element('strong', text));
    return p;
  };
  if (extract) {
    box.append(stage('1. 抽出'));
    box.append(labeled('どう読んだか', [STAGE_EXTRACT[extract.via] ?? extract.via, extract.reason, extract.retry].filter(Boolean).join('。')));
    if (extract.fallback) box.append(labeled('代わりの値', extract.fallback, 'notice'));
    box.append(labeled('入力', `段「${extract.input.step}」、発言「${extract.input.text}」`));
    if (extract.output) box.append(labeled('出力', `updates ${extract.output.updates}、intent ${extract.output.intent ?? 'なし'}`));
    if (extract.rejected) {
      const rejected = extract.rejected.map((r) => `${r.label ?? r.key}「${r.value}」(${r.reason})`).join('、');
      box.append(labeled('検査で入れなかった値', rejected || 'なし', rejected ? 'notice' : undefined));
    }
  }
  if (decision) {
    box.append(stage('2. 決定(harness のコード)'));
    const where = decision.from === decision.step ? `段「${decision.step}」` : `段「${decision.from}」→「${decision.step}」`;
    box.append(
      labeled(
        '決定',
        `${where}、ターン ${decision.turn}、聞く項目 ${decision.ask?.label ?? 'なし'}、言うこと ${STAGE_SAY[decision.say] ?? 'なし'}、${decision.done ? '終わる' : '続ける'}`,
      ),
    );
    if (decision.corrected.length > 0) box.append(labeled('本人が直した項目', decision.corrected.map((c) => c.label).join('、')));
    box.append(labeled('理由', decision.reason));
  }
  if (phrase) {
    box.append(stage('3. 言い方'));
    box.append(labeled('どう作ったか', [STAGE_PHRASE[phrase.via] ?? phrase.via, phrase.retry, phrase.fallback].filter(Boolean).join('。')));
    if (phrase.input.mustInclude.length > 0) box.append(labeled('入れる問いの原文', phrase.input.mustInclude.join(' / ')));
    if (phrase.output) box.append(labeled('出力', phrase.output.reply));
  }
  const { guards, timeout } = entry.harness;
  if (timeout) {
    box.append(labeled('時間切れ', `1 ターンの期限(${formatSeconds(timeout.limitMs)})を${TIMEOUT_STAGES[timeout.stage] ?? timeout.stage}の途中で過ぎたので、接続を止めて決まった文で返しました`, 'notice'));
  }
  if (guards) {
    box.append(stage('4. 守ることの確かめ(harness のコード。形だけを確かめ、意味は確かめません)'));
    const failed = guards.failed.map((rule) => `${GUARD_LABELS[rule] ?? rule}(${rule})`).join('、');
    box.append(labeled('結果', `${GUARD_RESULTS[guards.result] ?? guards.result}${failed ? `。合わなかった決まり: ${failed}` : ''}`, guards.result === 'passed' ? undefined : 'notice'));
    for (const check of guards.checks) {
      const problems = check.failed.map((f) => `${GUARD_LABELS[f.rule] ?? f.rule}: ${f.detail}`);
      if (check.added.length > 0) problems.push(`問いの原文が抜けていたので、後ろに足した: ${check.added.join(' / ')}`);
      if (check.retryCall) problems.push(check.retryCall);
      box.append(labeled(`${check.attempt} 回目の返事`, `${check.reply}(${problems.length > 0 ? problems.join('。') : '合う'})`));
    }
    if (guards.reason) box.append(labeled('理由', guards.reason, 'notice'));
  }
  return box;
}

// 守りの層と判定の言葉(docs/design/agent-simulation.md の 3.7)
const LAYER_WORDS = { tool: 'ツールの守り', permission: '渡したツールの名前', prompt: 'プロンプトの頼み', output: '出口の確かめ', surface: '会話の枠' };
const EFFECT_WORDS = { passed: '通した', blocked: '止めた', violated: '合わなかった(記録だけ)', retried: 'やり直させた', replaced: '決まった文に代えた', asked: '頼んだ' };
const partWord = (kind) => PART_WORDS[kind] ?? kind;

function guardText(guard) {
  let effect = EFFECT_WORDS[guard.effect] ?? guard.effect;
  if (guard.layer === 'surface') effect = guard.to ? `${partWord(guard.from)}を${partWord(guard.to)}に落とした` : `${partWord(guard.from)}を外した`;
  const parts = [`${LAYER_WORDS[guard.layer] ?? guard.layer}「${guard.guard}」: ${effect}`];
  if (guard.owner) parts.push(`持ち主 ${guard.owner}`);
  if (guard.failed?.length) parts.push(`合わなかった決まり ${guard.failed.join('、')}`);
  if (guard.reason) parts.push(`理由 ${guard.reason}`);
  return parts.join('、');
}

function guardList(guards) {
  const list = element('ul', undefined, 'sim-guards');
  list.setAttribute('aria-label', '守りの層と判定');
  for (const guard of guards) {
    const li = element('li', guardText(guard));
    li.dataset.layer = guard.layer;
    li.dataset.effect = guard.effect;
    list.append(li);
  }
  return list;
}

function partsText(parts) {
  return (parts ?? []).map((part) => `${partWord(part.kind)}${part.items ? `(${part.items} 個)` : ''}${part.cards ? `(${part.cards} 枚)` : ''}`).join('、') || 'なし';
}

function toolResultText(result) {
  if (!result) return '不明';
  if (!result.ok) return `失敗: ${result.error}`;
  const parts = [`成功、${result.chars} 字`];
  if (Number.isFinite(result.count)) parts.push(`${result.count} 件`);
  if (result.keys?.length) parts.push(`項目 ${result.keys.join('、')}`);
  return parts.join('、');
}

// 模擬の会話の 1 ターン(sim-turn)の段の 1 つ。参加者の発言、ツールの呼び出し(引数と結果)、返事の部品と、それぞれの守りの判定
function simStepItem(entry, step, index, nameOf) {
  const li = element('li', undefined, 'sim-step');
  const via = (step) => `${step.connection}${step.real ? '(実際の AI モデル)' : '(AI モデルは呼んでいません)'}`;
  if (typeof step.tool === 'string') {
    li.dataset.step = 'tool';
    li.append(element('strong', `ツール ${step.tool}`), document.createTextNode(`(${nameOf(step.by)} が呼びました${Number.isFinite(step.ms) ? `、${step.ms} ミリ秒` : ''})`));
    li.append(labeled('引数', JSON.stringify(step.args ?? {})), labeled('結果', toolResultText(step.result)));
    if (step.fault) li.append(element('p', '前提の失敗(faults)に当たったので、失敗を返しました', 'notice'));
    if (step.handoff) li.append(labeled('引き継ぎの頼み', nameOf(step.handoff.to)));
  } else if (step.kind === 'agent') {
    li.dataset.step = 'agent';
    const facts = [`接続 ${via(step)}`];
    if (Number.isFinite(step.ms)) facts.push(`${step.ms} ミリ秒`);
    if (Number.isFinite(step.costUsd)) facts.push(`費用の目安 $${step.costUsd.toFixed(4)}`);
    li.append(element('strong', `参加者 ${nameOf(step.participant)}(模擬のエージェント)`), document.createTextNode(`: ${facts.join('、')}`));
    const pieces = (step.prompt?.pieces ?? []).map((piece) => `${piece.slot ? `枠 ${piece.slot}` : `前提の ${piece.key}`}(持ち主 ${piece.owner}、${piece.chars} 字)`);
    if (pieces.length > 0) li.append(labeled('プロンプトの部品', pieces.join('、')));
    if (step.command) {
      const command = labeled('起動の形', '');
      command.append(element('code', step.command.join(' ')));
      li.append(command);
    }
    const asked = (step.prompt?.asked ?? []).map((id) => ({ layer: 'prompt', guard: id, effect: 'asked' }));
    if (asked.length > 0) li.append(guardList(asked));
  } else if (step.kind === 'harness') {
    li.dataset.step = 'harness';
    li.append(element('strong', `参加者 ${nameOf(step.participant)}(harness)`), document.createTextNode(`: 接続 ${via(step)}${Number.isFinite(step.ms) ? `、${step.ms} ミリ秒` : ''}`));
    if (step.harness && Object.keys(step.harness).length > 0) li.append(traceStages({ id: `${entry.id}:${index}`, harness: step.harness }));
  } else if (step.kind === 'human') {
    li.dataset.step = 'human';
    li.append(element('strong', `参加者 ${nameOf(step.participant)}(人)`), document.createTextNode(': 模擬の決まった返事'));
  } else if (step.fallback) {
    li.dataset.step = 'fallback';
    li.append(element('strong', `${nameOf(step.participant)} の返事を決まった文に代えました`), document.createTextNode(`: ${step.reason}`));
  } else if (step.handoffIgnored) {
    li.dataset.step = 'handoff-ignored';
    li.append(element('strong', `${nameOf(step.participant)} の引き継ぎ(${step.handoffIgnored.map(nameOf).join('、')})を使いませんでした`), document.createTextNode(`: ${step.reason}`));
  } else if (step.output) {
    li.dataset.step = 'output';
    li.append(element('strong', `${nameOf(step.participant)} の返事の部品(${step.attempt} 回目)`), document.createTextNode(`: ${partsText(step.output.parts)}`));
  }
  if (step.guards?.length > 0) li.append(guardList(step.guards));
  return li;
}

function handoffText(handoff, nameOf) {
  const parts = [`${nameOf(handoff.from)} → ${nameOf(handoff.to)}: ${EFFECT_WORDS[handoff.effect] ?? handoff.effect}`];
  if (handoff.reason) parts.push(`理由 ${handoff.reason}`);
  if (handoff.carry?.accepted?.length) parts.push(`受け渡した値 ${handoff.carry.accepted.join('、')}`);
  if (handoff.carry?.rejected?.length) parts.push(`入れなかった値 ${handoff.carry.rejected.map((r) => `${r.key}(${r.reason})`).join('、')}`);
  if (handoff.refused) parts.push(`続けての引き継ぎ(${nameOf(handoff.refused.to)})は断った: ${handoff.refused.reason}`);
  if (handoff.ignored?.length) parts.push(`使わなかった頼み ${handoff.ignored.map(nameOf).join('、')}`);
  return parts.join('、');
}

// 開発の担当者向け。模擬の会話の 1 ターン(sim-turn。docs/design/agent-simulation.md の 4.1)の中身。
// 構成と前提(指紋つき)、参加者、ツールの呼び出しの引数と結果、守りの層と判定、引き継ぎ、見える記録
function traceSim(entry) {
  const box = element('details', undefined, 'trace-internals');
  keepOpen(box, `${entry.id}:sim`);
  box.append(element('summary', '模擬の会話の中身: 参加者、ツール、守り(開発向け)'));
  const labels = new Map((entry.participants ?? []).map((p) => [p.id, p.label]));
  const nameOf = (id) => (labels.has(id) ? `${labels.get(id)}(${id})` : String(id));
  // 指紋(sha256:…)は、見分けられる長さまで出す
  const short = (digest) => (typeof digest === 'string' ? `${digest.slice(0, 'sha256:'.length + 12)}…` : '不明');
  if (entry.composition) {
    const file = entry.composition.file ? `app/${entry.composition.file}、` : '';
    box.append(labeled('構成', `${entry.composition.name ?? ''}(${file}指紋 ${short(entry.composition.digest)})`));
  }
  if (entry.assumptions) {
    const { id, file, digest, standIn } = entry.assumptions;
    box.append(labeled('前提', `${id}(${file ? `app/${file}、` : ''}指紋 ${short(digest)}${standIn ? '、代わりのモデル' : ''})`));
  }
  if (entry.participants?.length) {
    box.append(labeled('参加者', entry.participants.map((p) => `${p.label}(${p.id}、${PARTICIPANT_KINDS[p.kind] ?? p.kind})`).join('、')));
  }
  const facts = [];
  if (Number.isFinite(entry.turn)) facts.push(`ターン ${entry.turn}`);
  if (entry.active) facts.push(entry.active.before === entry.active.after ? `話す参加者 ${nameOf(entry.active.after)}` : `話す参加者 ${nameOf(entry.active.before)} → ${nameOf(entry.active.after)}`);
  if (Number.isFinite(entry.input?.history)) facts.push(`渡した会話 ${entry.input.history} 件と、新しい発言`);
  if (facts.length > 0) box.append(labeled('ターン', facts.join('、')));
  if (entry.nodes?.length) box.append(labeled('通った節', entry.nodes.join(' → ')));
  const steps = element('ol', undefined, 'sim-steps');
  steps.setAttribute('aria-label', '模擬の会話の段');
  steps.append(...entry.steps.map((step, index) => simStepItem(entry, step, index, nameOf)));
  box.append(steps);
  if (entry.handoff) box.append(labeled('引き継ぎ', handoffText(entry.handoff, nameOf)));
  if (entry.returned) box.append(labeled('戻り', handoffText(entry.returned, nameOf)));
  if (entry.views) {
    const seen = (list) => (list ?? []).join('、') || 'なし';
    box.append(labeled('見える記録(前提の logging)', `相手から ${seen(entry.views.partnerSees)}、こちらから ${seen(entry.views.dipSees)}`));
  }
  return box;
}

function traceItem(entry) {
  const li = element('li', undefined, 'trace-entry');
  li.dataset.type = entry.type;
  li.dataset.status = entry.status;
  li.dataset.real = String(Boolean(entry.connection?.real));
  // 観察の会話の記録には印を付ける。利用者の試す画面の会話とは別の会話
  if (entry.observation) li.dataset.observation = entry.observation;
  const head = element('p', undefined, 'trace-head');
  head.append(element('time', formatTime(entry.at)), element('strong', traceTitle(entry)));
  if (entry.observation) head.append(element('span', '観察から', 'trace-origin'));
  const status = [TRACE_STATUS[entry.status] ?? entry.status];
  if (Number.isFinite(entry.elapsedMs) && entry.status !== 'running') status.push(formatSeconds(entry.elapsedMs));
  head.append(element('span', status.join('、'), 'trace-status'));
  li.append(head);
  if (entry.type === 'reply') {
    li.append(labeled('発言', entry.text || '(空)'));
    if (entry.output) li.append(labeled('返事', entry.output.reply || '(空)'));
  }
  if (entry.type === 'correction' && entry.requested.length > 0) {
    li.append(labeled('直そうとした値', entry.requested.map((r) => `${r.key}「${r.value}」`).join('、')));
  }
  if (entry.type === 'open' && entry.greeting) li.append(labeled('あいさつ', entry.greeting));
  if (entry.type === 'reset' || entry.type === 'open') li.append(labeled('最初の状態', entry.state.map((s) => `${s.label}「${s.value}」`).join('、')));
  if (entry.status === 'ok' && entry.changes) {
    if (entry.changes.length > 0) li.append(element('p', '状態の変化:'), changeList('状態の変化', entry.changes));
    else li.append(element('p', '状態の変化: なし', 'muted'));
  }
  if (entry.rejected?.length) {
    li.append(
      labeled(
        '状態に入れなかった値',
        entry.rejected.map((r) => `${r.label ?? r.key}「${r.value}」(${r.reason})`).join('、'),
        'notice',
      ),
    );
  }
  if (entry.error) {
    li.append(labeled('理由', entry.error.message, 'failed'), labeled('次にすること', entry.error.next, 'trace-next'));
  }
  if (entry.kind === 'sim-turn') {
    li.dataset.kind = 'sim-turn';
    if (entry.action) li.append(labeled('ボタンの action', entry.action));
    if (entry.steps) li.append(traceSim(entry));
  } else {
    if (entry.type === 'reply' && entry.input) li.append(traceInternals(entry));
    if (entry.type === 'reply' && entry.harness) li.append(traceStages(entry));
  }
  return li;
}

function renderTrace() {
  const { session } = ai;
  if (!session) {
    els.aiTrace.replaceChildren(element('p', 'プロダクト内 AI を使う試作品を開くと、ここに出ます。', 'muted'));
    return;
  }
  const current = ai.choices?.options.find((o) => o.kind === session.connection.kind);
  const nodes = [
    labeled('今の接続', connectionNote({ label: session.connection.label, real: Boolean(current?.billing) })),
    labeled('AI が使えるツール', current?.tools ?? '不明'),
    labeled('試作品から AI への操作', '会話を読む、発言を送る、状態を直す。接続の切り替えと「応答を止める」は Studio の画面だけでできます。'),
    element(
      'p',
      '記録は Studio のメモリーにだけ置き、Studio を止めると消えます。メールアドレス、電話番号、鍵らしい文字列は、伏せて記録します(AI に送る中身は変えません)。',
      'muted',
    ),
  ];
  const entries = trace.projectId === ai.projectId ? trace.entries : null;
  const scrollTop = els.aiTrace.querySelector('.trace-list')?.scrollTop ?? 0;
  if (!entries) {
    nodes.push(element('p', '読み込んでいます…', 'muted'));
  } else if (entries.length === 0) {
    nodes.push(element('p', 'まだ記録はありません。試作品の中で AI に話しかけると、ここに出ます。', 'muted'));
  } else {
    const list = element('ol', undefined, 'trace-list');
    list.setAttribute('aria-label', 'AI の実行の記録');
    list.append(...entries.map(traceItem));
    const clear = element('button', '記録を消す');
    clear.type = 'button';
    clear.addEventListener('click', clearTrace);
    nodes.push(list, clear);
  }
  els.aiTrace.replaceChildren(...nodes);
  const shown = els.aiTrace.querySelector('.trace-list');
  if (shown) shown.scrollTop = scrollTop;
}

async function loadTrace(projectId) {
  const seq = ++trace.seq;
  if (trace.projectId !== projectId) {
    trace.projectId = projectId;
    trace.entries = null;
    trace.snapshot = '';
    trace.open.clear();
  }
  if (!projectId) return renderTrace();
  try {
    const data = await api(`/api/projects/${encodeURIComponent(projectId)}/ai/trace`);
    if (seq !== trace.seq) return;
    const snapshot = JSON.stringify(data.entries);
    if (snapshot === trace.snapshot && trace.entries) return;
    trace.snapshot = snapshot;
    trace.entries = data.entries;
  } catch (error) {
    if (seq !== trace.seq) return;
    // 次に読めたとき、同じ中身でも描き直す
    trace.snapshot = '';
    if (error instanceof ApiError && error.code === 'no-ai') trace.entries = [];
    else {
      // つながらない間は、前に読めた記録を出したままにする
      handleError(error);
      trace.entries ??= [];
    }
  }
  renderTrace();
}

// 応答を待つ間は、記録を読み直し続ける(待っている発言と、渡したものが見える)
function syncTracePolling() {
  const waiting = ai.projectId && waitingFor(ai.projectId) > 0;
  if (waiting && !trace.timer) {
    trace.timer = setInterval(() => loadTrace(ai.projectId), TRACE_POLL_MS);
    loadTrace(ai.projectId);
  } else if (!waiting && trace.timer) {
    clearInterval(trace.timer);
    trace.timer = null;
  }
}

async function clearTrace() {
  const projectId = ai.projectId;
  if (!projectId) return;
  try {
    await api(`/api/projects/${encodeURIComponent(projectId)}/ai/clear-trace`, { method: 'POST' });
  } catch (error) {
    handleError(error);
  }
  await loadTrace(projectId);
}

function clearEvents() {
  els.events.replaceChildren();
  els.eventsEmpty.hidden = false;
}

function addEvent(kind, title, detail = '') {
  const li = document.createElement('li');
  li.dataset.kind = kind;
  li.append(element('time', new Date().toLocaleTimeString('ja-JP')), element('strong', title));
  if (detail) li.append(element('pre', detail));
  els.events.prepend(li);
  while (els.events.children.length > MAX_EVENTS) els.events.lastElementChild.remove();
  els.eventsEmpty.hidden = true;
}

function disconnect() {
  preview.port?.close();
  preview.port = null;
}

function showPlaceholder(text) {
  disconnect();
  preview.frame = null;
  preview.url = null;
  preview.projectId = null;
  els.frameHost.replaceChildren(element('p', text, 'placeholder'));
}

// 試作品は sandbox の iframe(allow-same-origin なし)で、別ポートから開く(ADR-0001 の層 2)。
function showPreview(url, projectId) {
  disconnect();
  const iframe = document.createElement('iframe');
  iframe.title = '試作品';
  iframe.setAttribute('sandbox', 'allow-scripts allow-forms');
  iframe.referrerPolicy = 'no-referrer';
  iframe.addEventListener('load', () => onFrameLoad(iframe));
  // src を先に決めてから入れる。about:blank の load を起こさないため
  iframe.src = url;
  preview.frame = iframe;
  preview.url = url;
  preview.projectId = projectId;
  preview.expectingLoad = true;
  els.frameHost.replaceChildren(iframe);
}

function onFrameLoad(iframe) {
  if (iframe !== preview.frame) return;
  if (preview.expectingLoad) {
    preview.expectingLoad = false;
    connect(iframe);
    return;
  }
  // 試作品が自分で別の URL へ移動した。port は渡さず、作り直す
  const now = Date.now();
  preview.unexpectedLoads = preview.unexpectedLoads.filter((time) => now - time < 10_000);
  preview.unexpectedLoads.push(now);
  if (preview.unexpectedLoads.length > MAX_UNEXPECTED_LOADS) {
    addEvent('warning', '試作品が何度も別のページへ移動しようとしたので、止めました。「その他」の「画面を読み込み直す」で最初から開けます。');
    showPlaceholder('試作品を止めました。「その他」の「開発者向けの詳細」を見てください。');
    return;
  }
  addEvent('warning', '試作品が別のページへ移動しようとしたので、最初から開き直しました。試作品は Studio の外へ移動できません。');
  showPreview(preview.url, preview.projectId);
}

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

// 試作品からの AI への要求の形を確かめる。サーバーでも、もう一度確かめる
function validAiRequest(data) {
  if (!Number.isSafeInteger(data.id)) return false;
  if (data.op === 'session') return true;
  if (data.op === 'send') {
    return typeof data.text === 'string' && data.text.length <= MAX_AI_TEXT && (data.action === undefined || (typeof data.action === 'string' && data.action.length <= MAX_AI_ACTION));
  }
  if (data.op === 'correct') {
    if (!isPlainObject(data.changes)) return false;
    const entries = Object.entries(data.changes);
    return (
      entries.length > 0 &&
      entries.length <= MAX_AI_CHANGES &&
      entries.every(
        ([key, value]) =>
          key.length <= 64 && (value === null || Number.isFinite(value) || (typeof value === 'string' && value.length <= 200)),
      )
    );
  }
  return false;
}

// 試作品は自分のプロジェクトの AI だけを呼べる。どのプロジェクトかは、親画面が決める
function createAiRelay(iframe, port, projectId) {
  let windowStart = Date.now();
  let count = 0;
  let inFlight = 0;
  let warned = false;
  const reply = (message) => {
    if (iframe === preview.frame) port.postMessage({ type: 'ai-response', ...message });
  };
  return async (data) => {
    if (!validAiRequest(data)) {
      if (Number.isSafeInteger(data.id)) reply({ id: data.id, ok: false, error: { code: 'invalid', message: 'AI への要求の形が正しくありません' } });
      return;
    }
    const now = Date.now();
    if (now - windowStart > AI_WINDOW_MS) {
      windowStart = now;
      count = 0;
      warned = false;
    }
    count += 1;
    if (count > MAX_AI_REQUESTS_PER_WINDOW || inFlight >= MAX_AI_IN_FLIGHT) {
      if (!warned) addEvent('warning', '試作品から AI への要求が多すぎるので、しばらく断ります。');
      warned = true;
      reply({ id: data.id, ok: false, error: { code: 'rate', message: 'AI への要求が多すぎます。少し待ってから試してください' } });
      return;
    }
    const base = `/api/projects/${encodeURIComponent(projectId)}/ai`;
    const request =
      data.op === 'send'
        ? api(`${base}/messages`, { method: 'POST', json: data.action === undefined ? { text: data.text } : { text: data.text, action: data.action } })
        : data.op === 'correct'
          ? api(`${base}/corrections`, { method: 'POST', json: { changes: data.changes } })
          : api(base);
    inFlight += 1;
    // 応答を待つ間は、試す欄の上に「止める」を出す
    const waiting = data.op === 'send';
    if (waiting) {
      waitingByProject.set(projectId, waitingFor(projectId) + 1);
      if (ai.projectId === projectId) renderAi();
    }
    try {
      const { session, retry } = await request;
      showAiSession(projectId, session, retry);
      reply({ id: data.id, ok: true, session });
      // 話すと、最初の一歩の案内の 1 番(直した後なら 3 番)が済む
      if (data.op === 'send') refresh();
      // 待つ間に開き直していたら、新しく開いた試作品に知らせる(studio.ai.onChange)
      if (iframe !== preview.frame && preview.projectId === projectId) preview.port?.postMessage({ type: 'ai-session', session });
    } catch (error) {
      const code = error instanceof ApiError ? error.code : 'internal';
      if (code === 'offline' || code === 'token') handleError(error);
      else addEvent('warning', `AI への要求に失敗しました: ${error.message}`, error.next ? `次にすること: ${error.next}` : '');
      reply({ id: data.id, ok: false, error: { code, message: error.message } });
      if (ai.projectId === projectId) loadTrace(projectId);
    } finally {
      inFlight -= 1;
      if (waiting) {
        waitingByProject.set(projectId, Math.max(0, waitingFor(projectId) - 1));
        if (ai.projectId === projectId) renderAi();
      }
    }
  };
}

function connect(iframe) {
  const channel = new MessageChannel();
  const port = channel.port1;
  const relayAi = createAiRelay(iframe, port, preview.projectId);
  let windowStart = Date.now();
  let count = 0;
  port.onmessage = (event) => {
    if (iframe !== preview.frame) return;
    if (isPlainObject(event.data) && event.data.type === 'ai-request') {
      relayAi(event.data);
      return;
    }
    const now = Date.now();
    if (now - windowStart > MESSAGE_WINDOW_MS) {
      windowStart = now;
      count = 0;
    }
    count += 1;
    if (count === MAX_MESSAGES_PER_WINDOW + 1) {
      addEvent('warning', '試作品からの知らせが多すぎるので、しばらく省きます。');
    }
    if (count > MAX_MESSAGES_PER_WINDOW) return;
    const data = event.data;
    if (!data || typeof data !== 'object' || !Object.hasOwn(EVENT_LABELS, data.type) || typeof data.message !== 'string') return;
    const stack = typeof data.stack === 'string' ? data.stack.slice(0, 4000) : '';
    addEvent('error', `${EVENT_LABELS[data.type]}: ${data.message.slice(0, 1000)}`, stack);
  };
  preview.port = port;
  // opaque origin の相手には '*' しか指定できない。渡すのは port だけで、返事はこの port で受ける
  iframe.contentWindow.postMessage({ type: 'studio:connect' }, '*', [channel.port2]);
}

// 上の帯の試作品の一覧と、試す欄の上の AI の切り替えは、押すと開き、もう一度押すか Esc で閉じる
function setProjectMenu(open) {
  els.projectMenu.hidden = !open;
  els.projectMenuButton.setAttribute('aria-expanded', String(open));
}

function setAiMenu(open) {
  els.aiMenu.hidden = !open;
  els.aiSwitch.setAttribute('aria-expanded', String(open));
}

els.projectMenuButton.addEventListener('click', () => setProjectMenu(els.projectMenu.hidden));

els.aiSwitch.addEventListener('click', () => setAiMenu(els.aiMenu.hidden));

els.realAiTry.addEventListener('click', () => toggleRealAiInfo('try'));
els.realAiMake.addEventListener('click', () => toggleRealAiInfo('make'));

// 一覧の外を押したら閉じる。試作品の iframe を押したときは、この画面から焦点が外れるので、それでも閉じる
document.addEventListener('click', (event) => {
  if (!els.projectMenu.hidden && !event.target.closest('.project-switch')) setProjectMenu(false);
});
window.addEventListener('blur', () => setProjectMenu(false));

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  if (!els.projectMenu.hidden) {
    setProjectMenu(false);
    els.projectMenuButton.focus();
  } else if (!els.aiMenu.hidden) {
    setAiMenu(false);
    els.aiSwitch.focus();
  } else if (!els.morePanel.hidden) {
    setMorePanel(false);
    els.more.focus();
  }
});

els.saveNow.addEventListener('click', () => saveVersion());

// 上の帯の「その他」で、右から引き出しを開く。閉じるボタン、もう一度「その他」、Esc で閉じる。
// 開いている間も、左の試作品は使える(開発者向けの詳細の記録を見ながら試すため)
function setMorePanel(open) {
  els.morePanel.hidden = !open;
  els.more.setAttribute('aria-expanded', String(open));
  if (open) els.morePanel.focus();
}

els.more.addEventListener('click', () => setMorePanel(els.morePanel.hidden));

els.moreClose.addEventListener('click', () => {
  setMorePanel(false);
  els.more.focus();
});

// 開発者向けの詳細を開いたら、その見出しを引き出しの上へ送る。下に隠れたまま開いても分からないため
els.devDetails.addEventListener('toggle', () => {
  if (els.devDetails.open) els.devDetails.scrollIntoView({ block: 'start' });
});

els.reopen.addEventListener('click', () => {
  const project = selectedProject();
  if (!project?.previewUrl) return;
  preview.unexpectedLoads = [];
  clearEvents();
  showPreview(project.previewUrl, project.id);
});

// 会話と状態を、AI の設定にある初期状態に戻してから、開き直す
els.reset.addEventListener('click', async () => {
  const project = selectedProject();
  if (!project?.previewUrl) return;
  els.reset.disabled = true;
  try {
    try {
      const { session, retry } = await api(`/api/projects/${encodeURIComponent(project.id)}/ai/reset`, { method: 'POST' });
      showAiSession(project.id, session, retry);
    } catch (error) {
      // AI を使わない試作品は、開き直すだけにする
      if (!(error instanceof ApiError && error.code === 'no-ai')) throw error;
    }
    // 待つ間に別の試作品が選ばれたら、そちらを開いたままにする
    if (selectedId === project.id) {
      preview.unexpectedLoads = [];
      clearEvents();
      showPreview(project.previewUrl, project.id);
    }
  } catch (error) {
    handleError(error);
  } finally {
    els.reset.disabled = !selectedProject()?.previewUrl;
  }
});

els.rebuild.addEventListener('click', async () => {
  const project = selectedProject();
  if (!project) return;
  els.rebuild.disabled = true;
  renderBuild({ ...project, building: true });
  try {
    await api(`/api/projects/${encodeURIComponent(project.id)}/builds`, { method: 'POST' });
  } catch (error) {
    handleError(error);
  }
  lastSnapshot = '';
  await refresh();
  // つながらないときも、ボタンと開発者向けの詳細を元に戻す
  render();
});

els.checkRun.addEventListener('click', () => startCheck());

els.checkAi.addEventListener('change', (event) => {
  if (event.target.name !== 'check-ai') return;
  checks.connection = event.target.value;
  checks.message = null;
  // 前に出したカードは閉じる(本物を選び直して押したときに、もう一度出す)
  if (consent.card?.use === 'check') consent.card = null;
  renderMake(selectedProject());
});

els.shotDialogClose.addEventListener('click', () => els.shotDialog.close());
// 画像の外(dialog の余白)を押しても閉じる
els.shotDialog.addEventListener('click', (event) => {
  if (event.target === els.shotDialog) els.shotDialog.close();
});

els.handoffForm.addEventListener('submit', (event) => {
  event.preventDefault();
  exportHandoff();
});

els.saveForm.addEventListener('submit', (event) => {
  event.preventDefault();
  saveVersion();
});

els.requestForm.addEventListener('submit', (event) => {
  event.preventDefault();
  submitRequest();
});

els.requestText.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    submitRequest();
  }
});

els.cancel.addEventListener('click', async () => {
  const project = selectedProject();
  const run = project && runningRun(project.id);
  if (!run) return;
  els.cancel.disabled = true;
  try {
    const data = await api(`/api/projects/${encodeURIComponent(project.id)}/build-requests/${run.id}/cancel`, { method: 'POST' });
    upsertRun(project.id, data.run);
  } catch (error) {
    if (error instanceof ApiError && error.code === 'not-running') {
      lastSnapshot = '';
      await refresh();
    } else {
      handleError(error);
    }
  } finally {
    els.cancel.disabled = false;
  }
});

// 案内のとおり同じタブに URL を貼ると、フラグメントだけが変わり、画面は読み直されない。
// 新しい鍵を覚えてから読み直し、はじめからつなぎ直す。
window.addEventListener('hashchange', () => {
  if (takeTokenFromHash()) location.reload();
});

if (!token) {
  showBanner('no-token');
  showPlaceholder('ターミナルに表示された URL から開いてください。');
  els.buildStatus.replaceChildren(element('p', '鍵がないので読み込めません。', 'muted'));
} else {
  setConnection('checking', '確かめています…');
  await refresh();
  pollTimer = setInterval(refresh, POLL_MS);
}
