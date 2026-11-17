// Studio 画面。トークンを持つ特権の画面なので、外から来た文字は必ず textContent で出す。
import { clearState, explainBox, fillState, stateLine } from '/guide.js';

const TOKEN_KEY = 'prototype-studio-token';
const POLL_MS = 3000;
const MESSAGE_WINDOW_MS = 5000;
const MAX_MESSAGES_PER_WINDOW = 20;
const MAX_UNEXPECTED_LOADS = 3;
const MAX_EVENTS = 50;
// 作る会話の項目の「誰が」の名前。接続(偽接続、Claude Code)の名前は、開発者向けの詳細にだけ出す(ux-redesign.md 4 節)。
// 画面の名前は「作る AI」にそろえた(ui-ux-v2.md の 6 節。前は「直す AI」)
const FIX_AI = '作る AI';
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
  cancelled: () => '止めました',
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
  'failed:contract': (gate) => (gate.errors?.some((error) => error.material)
    ? 'つないだ素材と合わないところがあります'
    : 'AI の設定か、確かめ方のファイルの形に誤りがあります'),
  'failed:compile': () => '試作品のファイルに誤りがあり、新しい状態を表示できません',
  'failed:launch': () => '試作品を開くと、誤りが出ます',
  'failed:scenarios': () => '決めた手順で試すと、思ったとおりに動きません',
  'failed:evals': () => 'AI の場面を回すと、思ったとおりに動きません',
};
// 作る会話の項目の「誰が」の名前(項目の kind ごと)。作るループの言葉(関門、シナリオ、report、直すラウンド)は、
// 利用者の言葉にする(ux-redesign.md 4 節の表の「作るループの言葉」)。項目の本文はサーバーの文
const ITEM_LABELS = {
  tool: '操作',
  'tool-error': '操作の失敗',
  denied: 'やめた操作',
  failed: '失敗',
  cancelled: '止めました',
  hint: 'すること',
  changes: '確かめた結果',
  info: 'Studio',
  skipped: 'Studio',
  'build-ok': '表示の準備',
  'build-failed': '表示の準備',
  'ai-settings': 'AI の設定(Studio が確かめた結果)',
  'launch-ok': '開いて表示できるか',
  'launch-failed': '開いて表示できるか',
  'launch-unverified': '開いて表示できるか',
  'scenarios-ok': '決めた手順で動くか',
  'scenarios-failed': '決めた手順で動くか',
  'scenarios-unverified': '決めた手順で動くか',
  'scenarios-changed': '確かめ方が変わりました',
  'evals-ok': 'AI の場面で動くか',
  'evals-failed': 'AI の場面で動くか',
  'evals-changed': '確かめ方が変わりました',
  'guards-changed': 'AI の守ることが変わりました',
  gates: '自動の確かめ',
  preexisting: '確かめた結果',
  round: 'もう一度直す',
  'fix-request': `直す依頼(Studio から${FIX_AI} へ)`,
  'gave-up': 'ここで止めました',
  // 結果の帯の「確かめた中身」に出す、関門の名前(run.gates の name ごと)。U3 の言葉を使わない。
  // 作る会話の項目の本文も同じ名前を使う(src/server/build-requests.js の GATE_WORDS)
  'gate:changes': '変わったところ',
  'gate:inspect': 'ファイルの名前と大きさ',
  'gate:contract': 'AI の設定と確かめ方の形',
  'gate:compile': '表示の準備',
  'gate:launch': '開いて表示できるか',
  'gate:evals': 'AI の場面で動くか',
  'gate:scenarios': '決めた手順で動くか',
  'gate:architecture': '承認した構成と同じか',
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
  // つながらないときだけ出す(ux-redesign.md 4 節の「つながっています」の行)
  offline:
    'Studio が止まっています。直し方: npm start を実行したターミナルが開いたままか確かめてください。閉じていたら、もう一度 npm start を実行して、表示された URL を開いてください。',
};
const STOPPED = 'Studio が止まっています';

const $ = (id) => document.getElementById(id);
const els = {
  connection: $('connection'),
  banner: $('banner'),
  bannerText: $('banner-text'),
  // 画面の枠(ui-ux-v2.md の 2.2)
  stageList: $('stage-list'),
  stageCompact: $('stage-compact'),
  stageCount: $('stage-count'),
  benchHeading: $('bench-heading'),
  stageNote: $('stage-note'),
  stageNoteText: $('stage-note-text'),
  stageShow: $('stage-show'),
  stageCheck: $('stage-check'),
  stageHandoff: $('stage-handoff'),
  nowLine: $('now-line'),
  actorOthers: $('actor-others'),
  aiMode: $('ai-mode'),
  aiModeInfo: $('ai-mode-info'),
  reverted: $('reverted'),
  revertedText: $('reverted-text'),
  revertedUndo: $('reverted-undo'),
  realAiNow: $('real-ai-now'),
  realAiNowInfo: $('real-ai-now-info'),
  nextBand: $('next-band'),
  nextText: $('next-text'),
  nextSlot: $('next-slot'),
  mechanism: $('mechanism'),
  mechanismButton: $('mechanism-button'),
  mechanismClose: $('mechanism-close'),
  mechanismPrompts: $('mechanism-prompts-body'),
  materials: $('materials'),
  materialsButton: $('materials-button'),
  materialsClose: $('materials-close'),
  hintsReset: $('hints-reset'),
  hintsResetNote: $('hints-reset-note'),
  list: $('project-list'),
  title: $('project-title'),
  projectMenuButton: $('project-menu-button'),
  projectMenu: $('project-menu'),
  saveMark: $('save-mark'),
  saveNow: $('save-now'),
  showStart: $('show-start'),
  show: $('show'),
  showHeading: $('show-heading'),
  showTitle: $('show-title'),
  showLead: $('show-lead'),
  showForm: $('show-form'),
  showQuestions: $('show-questions'),
  showViewer: $('show-viewer'),
  showSave: $('show-save'),
  showEnd: $('show-end'),
  showStatus: $('show-status'),
  showRealAi: $('show-real-ai'),
  // 画面へのコメント(K3)
  commentForm: $('comment-form'),
  commentPlace: $('comment-place'),
  commentPlaceText: $('comment-place-text'),
  commentText: $('comment-text'),
  commentAuthor: $('comment-author'),
  commentAdd: $('comment-add'),
  commentPressed: $('comment-pressed'),
  commentSpoken: $('comment-spoken'),
  commentQueue: $('comment-queue'),
  commentResume: $('comment-resume'),
  commentList: $('comment-list'),
  commentStatus: $('comment-status'),
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
  frameVersion: $('frame-version'),
  // 段 5〜8 の右の列(ui-ux-v2.md の 2.2、4.2、4.3)
  sideSwitch: $('side-switch'),
  sideMaker: $('side-maker'),
  sideBack: $('side-back'),
  measure: $('measure'),
  tabs: { turn: $('tab-turn'), scenes: $('tab-scenes'), compare: $('tab-compare') },
  panels: { turn: $('panel-turn'), scenes: $('panel-scenes'), compare: $('panel-compare') },
  turnEmpty: $('turn-empty'),
  turnTimeline: $('turn-timeline'),
  scenesEmpty: $('scenes-empty'),
  compareBasis: $('compare-basis'),
  rechoose: $('rechoose'),
  rechooseButton: $('rechoose-button'),
  rechooseNote: $('rechoose-note'),
  makeNow: $('make-now'),
  makeNowRequest: $('make-now-request'),
  makeNowList: $('make-now-list'),
  makeNowRounds: $('make-now-rounds'),
  makeNowTime: $('make-now-time'),
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
  tokensForm: $('tokens-form'),
  tokensFile: $('tokens-file'),
  tokensConnected: $('tokens-connected'),
  tokensMessage: $('tokens-message'),
  tokensProblems: $('tokens-problems'),
  tokensReview: $('tokens-review'),
  tokensSummary: $('tokens-summary'),
  tokensRoles: $('tokens-roles'),
  tokensMissing: $('tokens-missing'),
  tokensSource: $('tokens-source'),
  tokensReason: $('tokens-reason'),
  tokensConnect: $('tokens-connect'),
  guidesEnabled: $('guides-enabled'),
  guidesMessage: $('guides-message'),
  guidesSteps: $('guides-steps'),
  guidesAsk: $('guides-ask'),
  guidesHaveNote: $('guides-have-note'),
  guidesOwner: $('guides-owner'),
  guidesSource: $('guides-source'),
  guidesLicense: $('guides-license'),
  guidesLicenseNameBox: $('guides-license-name-box'),
  guidesLicenseName: $('guides-license-name'),
  guidesAskNext: $('guides-ask-next'),
  guidesCheck: $('guides-check'),
  guidesFilesBox: $('guides-files-box'),
  guidesFiles: $('guides-files'),
  guidesFolderBox: $('guides-folder-box'),
  guidesFolder: $('guides-folder'),
  guidesPackageBox: $('guides-package-box'),
  guidesPackage: $('guides-package'),
  guidesScopeNote: $('guides-scope-note'),
  guidesProblems: $('guides-problems'),
  guidesChecked: $('guides-checked'),
  guidesCheckBack: $('guides-check-back'),
  guidesCheckNext: $('guides-check-next'),
  guidesTry: $('guides-try'),
  guidesUrls: $('guides-urls'),
  guidesPreview: $('guides-preview'),
  guidesTryBack: $('guides-try-back'),
  guidesTryNext: $('guides-try-next'),
  guidesEnableForm: $('guides-enable-form'),
  guidesReason: $('guides-reason'),
  guidesSummary: $('guides-summary'),
  guidesBlocked: $('guides-blocked'),
  guidesEnableBack: $('guides-enable-back'),
  guidesEnable: $('guides-enable'),
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
// versionAt は表示している版を作った時刻、newAt は同じ試作品で新しい版に替わった時刻(試作品の欄の 1 行。ui-ux-v2.md の 4.3)
const preview = { frame: null, url: null, projectId: null, expectingLoad: false, unexpectedLoads: [], port: null, versionAt: null, newAt: null };
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
// 手順の済みは、一覧の API の試作品ごとの firstSteps(src/server/first-steps.js)。
// 「はじめの手順」の見た目はなくした(ui-ux-v2.md の 13 節)。進み方は、段 5、段 6 の次の一手の文に使う
const firstSteps = { touching: false };
// 画面の枠(ui-ux-v2.md の 2.2)。stage は、目的、設計、審査、会の画面を開いていないときの段。
// drawer は開いている引き出し(mechanism か materials)。band は次の一手の帯に移したボタンと、その元の場所。
// ready は、下の部品の状態がそろって、枠を描けるようになったか
// trialInfo は今の行の「○ お試しの AI」の中身を開いているか。reverted は版を戻した後の 1 行(5.4 の「元に戻した」。次の操作で消える)
const frame = { stage: 'build', side: 'stage', tab: 'turn', drawer: null, compactOpen: false, pending: false, ready: false, moved: null, home: null, prompts: { projectId: null, key: '', seq: 0, data: null }, trialInfo: false, reverted: null };
// 「その場で」の 1 行(5.1)。counts は操作の種類ごとの回数、limit はこの回数で出さなくなる(hints.js)
const hintState = { counts: {}, limit: 2, loaded: false };
// はじめの画面、目的の聞き出し、目的の文書(user-journey.md の段 1、段 2、J1)。view は出している画面(start、talk、doc)で、null なら試作品の画面。
// projectId は聞き出している試作品(はじめの画面で新しく作るときは null)。record はサーバーの状態(src/server/intent.js)。
// guide は聞き出し方(ai か fixed)。startSeen は起動後の最初の一覧を読んだか(はじめの画面は 1 回だけ開く)
const intentUi = { view: null, projectId: null, record: null, waiting: false, guide: 'ai', declined: false, startSeen: false, sending: false, shownQuestion: null, seq: 0 };
// AI の実行の記録(#277)。open は、開いている「渡したもの、受け取ったもの」の記録の ID
const trace = { projectId: null, entries: null, snapshot: '', seq: 0, timer: null, open: new Set() };
const TRACE_POLL_MS = 1000;
// 応答を待っている発言の数を、試作品ごとに数える。開き直しや作り直しの後も「止める」を出し続けるため
const waitingByProject = new Map();
const waitingFor = (projectId) => waitingByProject.get(projectId) ?? 0;
// その他の引き出しの「保存した状態」。保存した版の一覧と、作業中がどの版と同じか
const versions = { projectId: null, data: null, seq: 0, busy: false, message: null };
// 見せる画面(J7)。open の間は、試作品と確かめたい問いだけを出す。version は見せている版、questions は問い。
// warned は、残していない答えがあるまま「見せ終わる」を 1 回押したか
const showUi = { open: false, starting: false, saving: false, projectId: null, version: null, questions: [], source: null, savedNow: false, message: null, warned: false };
// 画面へのコメント(K3。サーバーは src/server/comments.js)。見せる画面の中に出す。data はサーバーの一覧、snapshot は前に描いた中身。
// place は書く前に選んだ画面の場所({ x, y } は見えている枠の中の %)、picking は場所を選んでいる最中か。
// confirmRevert は「後のものも一緒に戻る」と知らせたコメント(もう一度押すと戻す)
const commentsUi = { projectId: null, data: null, snapshot: '', seq: 0, busy: false, place: null, picking: false, message: null, confirmRevert: null };
// 画面の場所を選ぶ層。試作品の枠の上に重ねる(試作品の中は読まない。ADR 0001 の層 2)
const commentLayer = document.createElement('div');
commentLayer.className = 'comment-layer';
commentLayer.setAttribute('aria-hidden', 'true');
// 自分のトークン(J4)。file は選んだファイルの名前と中身、check はサーバーの検査の結果。つなぐまで何も書かれない
const tokens = { projectId: null, data: null, seq: 0, busy: false, file: null, check: null, problems: [], message: null, buildAt: null };
// 部品と指針をつなぐ案内の 4 歩(user-journey.md の J5)。サーバーの中身は tokens.data.guides(同じ素材の API で読む)。
// enabledKey は「有効にしている」の欄を描いたときの中身。変わったときだけ描き直す(押そうとしたボタンを消さない)
const guidesFlow = { step: 1, kind: null, files: null, check: null, busy: false, problems: [], message: null, seq: 0, enabledKey: '' };
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
  setConnection('error', code === 'offline' ? STOPPED : '問題があります');
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
    renderMeetingDue(data.meetingsDue ?? []);
    if (!intentUi.startSeen) {
      intentUi.startSeen = true;
      if (data.start?.show) openStart(null);
    }
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
    // 見せている間は、コメントの列と直した記録を読み直す(作る AI が終わると、状態が変わる)
    if (showUi.open) await loadComments();
  } catch (error) {
    if (seq < appliedSeq) return;
    handleError(error);
  }
}

function selectedProject() {
  return projects.find((project) => project.id === selectedId) ?? null;
}

function render() {
  scheduleFrame();
  if (!selectedProject()) {
    // 目的を聞き出したか、ヒアリングを整理した試作品があれば、最後に触ったものを選ぶ(読み込み直しや起動し直しで、続きに戻れるように)。
    // なければ、AI と話せる試作品(求人相談)を選ぶ(ux-redesign.md 5 節)
    const touchedAt = (p) => [p.intent?.updatedAt, p.organize?.updatedAt, p.design?.updatedAt, p.meeting?.updatedAt].filter(Boolean).sort().at(-1);
    const latest = projects.filter(touchedAt).sort((a, b) => touchedAt(b).localeCompare(touchedAt(a)))[0];
    selectedId = latest?.id ?? projects.find((p) => p.id === 'sample-job-consult')?.id ?? projects[0]?.id ?? null;
  }
  renderList();
  const project = selectedProject();
  renderIntentMark(project);
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
  if ((project?.id ?? null) !== tokens.projectId) {
    tokens.buildAt = project?.lastBuild?.finishedAt ?? null;
    loadTokens(project?.id ?? null);
  } else if (project && tokens.data && !tokens.busy && !guidesFlow.busy && (project.lastBuild?.finishedAt ?? null) !== tokens.buildAt) {
    // ビルドのたびに読み直す。作る AI が写しを変えたことなどを、素材の欄にも出す(案内の途中の答えは消さない)
    reloadMaterials(project);
  }
  renderTokens(project);
  renderGuides(project);
  syncScenes(project);
  syncQuality(project);
  if (!project) {
    showPlaceholder('試作品がありません。');
  } else if (!project.previewUrl) {
    showPlaceholder('表示できる状態がありません。');
  } else if (project.previewUrl !== preview.url) {
    clearEvents();
    // 同じ試作品で版が替わったら、新しい版の時刻を覚える(試作品の欄の「新しい版です」の 1 行)
    preview.newAt = preview.projectId === project.id && preview.url ? new Date().toISOString() : null;
    preview.versionAt = project.lastBuild?.finishedAt ?? new Date().toISOString();
    showPreview(project.previewUrl, project.id);
    // 版が変わると AI の設定も変わり得るので、読み直す
    loadAi(project.id);
  }
  if (!project?.previewUrl && ai.projectId !== null) loadAi(null);
}

// 選ぶ試作品を変える。前の試作品の表示を持ち込まない
function switchProject(id) {
  if (selectedId === id) return;
  selectedId = id;
  makeError = null;
  closeConsent();
  versions.message = null;
  render();
  // 会話を読んでから、前の証拠が古いかを読む(一覧の次の読み込みを待たない)
  syncConversation().then(() => syncChecks()).then(() => loadEvidence());
  loadVersions();
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
      ? `${FIX_AI} が作業中`
      : project.versioning
        ? '保存か、戻すか、渡すフォルダーを作っています'
        : project.checking
        ? '自動で確かめています'
        : project.building
        ? '表示の準備をしています'
        : unavailable
          ? '表示できません'
          : '';
    button.append(name, state);
    button.addEventListener('click', () => {
      setProjectMenu(false);
      leaveIntent();
      closeOrganize();
      closeDesign();
      closeReview();
      closeMeeting();
      switchProject(project.id);
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
// 「作る AI に直してもらう」は依頼の欄に文を入れるだけで、送るのは利用者。誤りの場所(ファイルと行)は「開発者向け」の中だけ。
// 作る AI が直している間(直すラウンドでビルドし直す)と、ビルドの間は出さない
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
  fillRequest(FIX_DISPLAY_REQUEST);
});

// 開発者向けの詳細の「作る AIの接続」。接続の種類、版、認証の見込み、実行ファイル、使えない理由を出す
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

// 作る AI が使えないときのカード(ux-redesign.md 7-5)。見出しの 1 文は判定で変える。
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

// 利用者に見せる依頼の例。本物の作る AI で意味のある依頼にする(ux-redesign.md 5 節)。
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
  openMaker();
  els.requestText.value = text;
  els.requestText.focus();
}

// 作る AI の欄を開く。依頼の欄は段 5〜8 の右の列にある。ほかの段からなら段 5「作る」に移り、段 6〜8 なら右の列を作る AI の欄に替える(ui-ux-v2.md の 2.3)
function openMaker() {
  const stage = viewedStage();
  if (!LAYOUT_STAGES.has(stage) || screenOpen()) goStage('build');
  else if (stage !== 'build' && frame.side !== 'maker') {
    frame.side = 'maker';
    renderFrame();
  }
}

function renderExamples() {
  const project = selectedProject();
  // 作る AI が使えないときは、送れないので例も出さない(使えないときのカードを出す)
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
        setDrawer(null);
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
  els.requestText.placeholder = agent && !agent.ready ? '作る AI が使えないので、送れません' : '例: 見出しの色を落ち着いた青にして';
  els.send.disabled = !ready;
  els.cancel.hidden = !(project && runningRun(project.id));
  renderMakeNow(project);
  renderFrameVersion(project, running);
  renderConversation(project);
  renderRealAiMarks();
  renderSaveMark(project);
  scheduleFrame();
  renderScenes(project);
  renderQuality(project);
}

// ---- 作る AI の欄の「今していること」(ui-ux-v2.md の 4.3) ----
// いちばん新しい依頼の文と、作る AI と関門の列。関門は 1 つずつ利用者の言葉で、✓ 済み、● 確かめています、○ まだ、× 落ちた。
// 今の節は run.current(サーバーの build-requests.js)。直すラウンドの前のラウンドで落ちた関門も × で残す
const NOW_STATE_WORDS = { done: '済み', active: '確かめています', writing: '書いています', todo: 'まだ', failed: '落ちた', warn: '確かめられませんでした', same: '変わっていません', skipped: '行っていません', stopped: '止めました' };
const NOW_STATE_MARKS = { done: '✓', active: '●', writing: '●', todo: '○', failed: '×', warn: '!', same: '─', skipped: '─', stopped: '─' };
// 関門と守りの側の節(今の行で ⬢ が働いている)。関門のほかに、直す依頼をまとめる節と、結果をまとめる節
const GATE_SIDE_NODES = new Set(['changes', 'architecture', 'inspect', 'contract', 'compile', 'evals', 'launch', 'scenarios', 'fix', 'evidence']);
// 作る AI の 1 回の依頼にかかる時間の目安。測った値ではないので、推測と書く
const MAKER_ESTIMATE = '多くは 3 分以内。推測';
let makeNowTimer = null;

function latestRun(projectId) {
  return conversations.get(projectId)?.runs.at(-1) ?? null;
}

function durationWords(ms) {
  const seconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  return minutes > 0 ? `${minutes} 分 ${seconds % 60} 秒` : `${seconds} 秒`;
}

// 時と分だけ(試作品の欄の版の 1 行)
function clockText(iso) {
  return new Date(iso).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
}

function gateNowState(run, gate) {
  if (gate.status === 'passed') return 'done';
  if (gate.status === 'failed') return 'failed';
  if (gate.status === 'unverified') return 'warn';
  if (gate.status === 'unchanged') return 'same';
  if (run.status === 'running') return run.current?.node === gate.name ? 'active' : 'todo';
  return 'skipped';
}

// 今していることの 1 行。形(者)と平たい名前と状態の印と言葉。色だけで状態を示さない
function nowRow(actor, name, state, detail = '') {
  const li = element('li', undefined, 'now-row');
  li.dataset.actor = actor;
  li.dataset.state = state;
  const mark = element('span', NOW_STATE_MARKS[state] ?? '', 'now-mark');
  mark.setAttribute('aria-hidden', 'true');
  const shape = element('span', actor === 'maker' ? '■' : '⬢', 'actor-shape');
  shape.setAttribute('aria-hidden', 'true');
  li.append(mark, shape, element('span', name, 'now-name'), element('span', NOW_STATE_WORDS[state] ?? '', 'now-state'));
  if (detail) li.append(element('span', detail, 'now-detail'));
  return li;
}

// 作る AI の行の状態。ラウンドごとの節 agent の結果から読む
function makerNowState(run, round) {
  if (run.status === 'running' && run.current?.node === 'agent' && run.current.round === round) return 'writing';
  const node = (run.nodes ?? []).find((n) => n.name === 'agent' && n.round === round);
  if (node) return node.outcome === 'passed' ? 'done' : node.outcome === 'cancelled' ? 'stopped' : 'failed';
  return run.status === 'running' ? 'todo' : 'skipped';
}

function lastToolSummary(run) {
  return run.items.findLast((item) => item.kind === 'tool' && item.summary)?.summary ?? '';
}

function renderMakeNow(project) {
  const run = project ? latestRun(project.id) : null;
  els.makeNow.hidden = !run;
  if (!run) {
    stopMakeNowTimer();
    return;
  }
  els.makeNow.dataset.status = run.status;
  els.makeNowRequest.textContent = run.request;
  const rows = [];
  const round = run.round ?? 1;
  const first = makerNowState(run, 1);
  rows.push(nowRow('maker', '試作品を書く', first, first === 'writing' ? lastToolSummary(run) : ''));
  // 前のラウンドで落ちた関門と、それを直した作る AI の行
  for (let r = 2; r <= round; r += 1) {
    const failed = (run.rounds?.[r - 2]?.gates ?? []).find((gate) => gate.status === 'failed');
    if (failed) rows.push(nowRow('gate', `${gateLabel(failed)}(${r - 1} 回目)`, 'failed'));
    const state = makerNowState(run, r);
    rows.push(nowRow('maker', `落ちたところを直す(${r - 1} 回目)`, state, state === 'writing' ? lastToolSummary(run) : ''));
  }
  // 今のラウンドの関門。審査のない試作品の「承認した構成と同じか」は出さない(行っていない)
  const gates = (run.gates ?? []).filter((gate) => !(gate.name === 'architecture' && gate.status === 'skipped'));
  if (gates.length > 0) {
    const head = element('li', undefined, 'now-gates');
    head.dataset.actor = 'gate';
    const shape = element('span', '⬢', 'actor-shape');
    shape.setAttribute('aria-hidden', 'true');
    const list = element('ol', undefined, 'now-gate-list');
    list.setAttribute('aria-label', '関門');
    for (const gate of gates) {
      const li = nowRow('gate', gateLabel(gate), gateNowState(run, gate));
      li.dataset.gate = gate.name;
      list.append(li);
    }
    head.append(shape, element('span', round > 1 ? `関門(直した後の ${round} 回目)` : '関門', 'now-name'), list);
    rows.push(head);
  }
  els.makeNowList.replaceChildren(...rows);
  const fixes = round - 1;
  els.makeNowRounds.hidden = fixes === 0;
  if (fixes > 0) {
    const what = run.status === 'failed' ? '直そうとした回数' : run.status === 'running' ? '直している回数' : '直した回数';
    els.makeNowRounds.textContent = `${FIX_AI} が${what}: ${fixes} 回(${run.maxFixRounds ?? fixes} 回まで)`;
  }
  renderMakeNowTime(run);
  if (run.status === 'running') startMakeNowTimer();
  else stopMakeNowTimer();
}

function renderMakeNowTime(run) {
  const started = Date.parse(run.startedAt);
  if (!Number.isFinite(started)) {
    els.makeNowTime.textContent = '';
    return;
  }
  if (run.status === 'running') {
    els.makeNowTime.textContent = `経過 ${durationWords(Date.now() - started)}(${MAKER_ESTIMATE})`;
  } else {
    const finished = Date.parse(run.finishedAt);
    els.makeNowTime.textContent = Number.isFinite(finished) ? `かかった時間 ${durationWords(finished - started)}` : '';
  }
}

// 作っている間だけ、経過の時間を 1 秒ごとに書き直す
function startMakeNowTimer() {
  if (makeNowTimer) return;
  makeNowTimer = setInterval(() => {
    const project = selectedProject();
    const run = project ? latestRun(project.id) : null;
    if (!run || run.status !== 'running') return stopMakeNowTimer();
    renderMakeNowTime(run);
  }, 1000);
}

function stopMakeNowTimer() {
  clearInterval(makeNowTimer);
  makeNowTimer = null;
}

// 試作品の欄の版の 1 行(4.3)。作っている間は前の版を出し続けると言い、新しい版が出たら時刻を言う。白紙にしない
function renderFrameVersion(project, making) {
  const ours = Boolean(project && preview.url && preview.projectId === project.id);
  // 新しい版は、いちばん新しい依頼より後に出たものだけ(次の依頼を始めたら、前の「新しい版です」は出さない)
  const run = ours ? latestRun(project.id) : null;
  const fresh = Boolean(ours && preview.newAt && (!run || Date.parse(preview.newAt) >= Date.parse(run.startedAt)));
  let text = '';
  if (fresh && making) text = `新しい版です。${clockText(preview.newAt)}。残りの確かめをしています。`;
  else if (ours && making && preview.versionAt) text = `前の版を出しています。この版は ${clockText(preview.versionAt)} のものです。新しい版は、表示の準備を通ったら出ます。`;
  else if (fresh) text = `新しい版です。${clockText(preview.newAt)}`;
  els.frameVersion.hidden = !text;
  els.frameVersion.textContent = text;
  els.frameVersion.dataset.kind = fresh ? 'new' : 'previous';
}

// 最初の一歩の進み方(ux-redesign.md 2 節、7-1、7-2、7-4)。見た目の「はじめの手順」はなくし(ui-ux-v2.md の 13 節)、
// 段 5 と段 6 の次の一手の帯の 1 文に使う。済みはサーバーが返す(first-steps.js)。
// 作る AI が直しきれなかったとき(failed)は、2 番を済みにせず、結果の帯を見るように言う
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
    return { text: `${FIX_AI} が直しきれませんでした。右の「作る AI」の欄の結果を見て、頼み方を変えてもう一度送ってください。`, tone: 'warn' };
  }
  if (current === 1) return '気になったところを、右の「作る AI」の欄に頼んでみましょう。押すと入る例もあります。';
  if (current === 2 && ai.projectId === project.id && ai.retry?.available) {
    return '試作品の上の「同じ発言で試し直す」で、直す前と後の返事を比べられます。';
  }
  if (current === 2) return noAi ? '直った試作品の画面を、もう一度触ってみましょう。' : `直った試作品で、もう一度${role}に話しかけてみましょう。`;
  return '試して、直して、直った結果も試しました。ほかにも気になるところがあれば、言葉で直せます。段 6 で場面を回して測れます。';
}

// AI のない試作品では、試作品の画面を触ると、案内の 1 番(直した後なら 3 番)が済む。
// 試作品は別の origin の iframe なので、中の操作は見えない。iframe に焦点が移ったこと(この画面の blur)で知る
async function touchedPreview() {
  const project = selectedProject();
  if (!project || firstSteps.touching || !withoutAi(project) || preview.projectId !== project.id) return;
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

// 終わって試作品が新しくなった実行。何を変えたかは、Studio が確かめた変わったファイルから言う(作る AI の報告に頼らない)
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

// 実行ごとの「開発者向け」。操作の詳細(ファイルの名前、道具の名前)、項目の開発者向けの文(サーバーの detail。
// 変わったファイル、関門の名前、作る AI の返した誤り)、接続の名前、認証の報告を出す
function runDevDetails(run) {
  const box = element('details', undefined, 'run-dev');
  box.open = openRunDetails.has(run.id);
  box.addEventListener('toggle', () => (box.open ? openRunDetails.add(run.id) : openRunDetails.delete(run.id)));
  box.append(element('summary', '開発者向け: 操作の詳細'));
  const entries = run.items.filter((item) => item.kind === 'tool' || item.detail);
  if (entries.length > 0) {
    const list = element('ul');
    list.setAttribute('aria-label', '操作の詳細');
    list.append(
      ...entries.map((item) => {
        const li = element('li', `${ITEM_LABELS[item.kind] ?? item.kind}: ${item.kind === 'tool' ? item.text : item.detail}`);
        // 作る会話の項目(data-kind)と取り違えないよう、別の名前にする
        li.dataset.devKind = item.kind;
        return li;
      }),
    );
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
  // 理由は最初の 1 文だけ(利用者の言葉)。全文は「開発者向け」に出す
  if (gate.reason) list.append(element('li', `理由: ${firstSentence(gate.reason)}`));
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

// 直すラウンドごとの、見つけた問題と、作る AI に返した依頼の文
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
    // 関門 GA は、AI 構成の審査のない試作品では何もしない(skipped)。今の試作品の見え方を変えないため、その節は出さない(R2)
    const names = (run.nodes ?? []).filter((node) => node.round === round.round && !(node.name === 'architecture' && node.outcome === 'skipped')).map((node) => (node.gate ? `${node.gate} ${node.name}` : node.name));
    rounds.append(element('li', `ラウンド ${round.round}: ${names.join(' → ')}`));
  }
  box.append(rounds);
  const gates = element('ul');
  gates.setAttribute('aria-label', '関門');
  for (const gate of run.gates ?? []) {
    const li = element('li', `${gate.id} ${gate.label}(${gate.name}): ${gate.status}`);
    if (gate.reason) li.append(element('span', `理由: ${gate.reason}`, 'evidence-line'));
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
// 試作品の中の AI の接続の、利用者の言葉(ux-redesign.md 4 節)。接続の名前(モック、Claude Code)は開発者向けの詳細にだけ出す。
// AI_WORDS は文の中の名前、AI_SHORT は試作品の上の「▲ … ▾」、AI_DESCRIPTIONS は選ぶときの説明
const AI_WORDS = { mock: 'お試しの AI', 'claude-code': '本物の AI' };
const AI_SHORT = { mock: 'お試し', 'claude-code': '本物' };
const AI_DESCRIPTIONS = {
  mock: '決まった言葉だけ分かります。無料で、いつも同じ返事です。',
  'claude-code': '自由な言葉が分かります。あなたの Claude Code で動きます。',
};
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
  for (const gate of check.gates ?? []) {
    const li = element('li', `${gate.id} ${gate.label}(${gate.name}): ${gate.status}`);
    if (gate.reason) li.append(element('span', `理由: ${gate.reason}`, 'evidence-line'));
    gates.append(li);
  }
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
  // Claude Code が見つからないときは、場所や環境変数の名前の入ったサーバーの理由を出さない(試す欄の選び方と同じ 1 文)
  const reason = real?.code === 'not-found' ? UNAVAILABLE.missing.lead() : real?.reason;
  els.checkAiNote.textContent = real && real.available === false ? `本物の AI は選べません: ${reason}` : '';
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
    // 結果は作る AI の欄の会話に出る。段 7 の右の列から、作る AI の欄に切り替えて見せる
    openMaker();
  } catch (error) {
    if (error instanceof ApiError && error.code === 'consent-required') {
      // 同意のカードは、段 7 の「試作品を自動で確かめる」の中に出す
      goStage('quality');
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

function consentCard(view, { tag = 'div', card = null, place = null } = {}) {
  const { summary } = view;
  const key = card ? 'card' : place;
  const box = element(tag, undefined, 'consent-card');
  box.dataset.use = card?.use ?? 'info';
  box.setAttribute('role', 'group');
  box.setAttribute('aria-label', card ? CONSENT_HEADING : REAL_AI_MARK);
  box.append(element('h3', card ? CONSENT_HEADING : REAL_AI_MARK));
  // 同意(5.4)。唯一の割り込み。印から開いた中身は「お試しか本物か」の本物の側
  box.append(card ? stateLine('consent') : stateLine('mode-real', { at: view.consent.agreedAt ? formatTime(view.consent.agreedAt) : null }));
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
  row('料金', summary.cost.text);
  // 上限は、カードの中でいつも見せる(料金と上限を先に出す。5.4 の「同意」)。聞き出す、整理する、案を出す AI のカードは、その AI の上限
  const ownLimits = ['intent', 'organize', 'design'].includes(card?.use) ? view.details?.[card.use]?.limits : null;
  row('上限', typeof ownLimits === 'string' ? ownLimits : summary.cost.limits);
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
      element('p', '作る AI に足す指示の全文:'),
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
  if (details.intent) {
    part(
      '目的を聞き出すとき',
      ...labeledList('目的を聞き出すときに送るもの', details.intent.items),
      element('p', details.intent.notSent),
      element('p', details.intent.tools),
      element('p', details.intent.limits),
      element('p', '聞き出す AI への指示の全文:'),
      element('pre', details.intent.systemPrompt),
    );
  }
  if (details.organize) {
    part(
      'ヒアリングを整理するとき',
      ...labeledList('ヒアリングを整理するときに送るもの', details.organize.items),
      element('p', details.organize.notSent),
      element('p', details.organize.tools),
      element('p', details.organize.limits),
      element('p', '整理する AI への指示の全文:'),
      element('pre', details.organize.systemPrompt),
    );
  }
  if (details.design) {
    part(
      '設計の案を出すとき',
      ...labeledList('設計の案を出すときに送るもの', details.design.items),
      element('p', details.design.notSent),
      element('p', details.design.tools),
      element('p', details.design.limits),
      element('p', '案を出す AI への指示の全文:'),
      element('pre', details.design.systemPrompt),
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
    else if (use === 'evals') await startScenes('claude-code');
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

// 同意する。同意は Studio を止めるまで、作る AI と試作品の中の AI の両方に効く。
// 直す欄の送信で出したカードなら欄の依頼を送り、試す欄で出したカードなら本物の AI に切り替える
async function agreeConsent() {
  const card = consent.card;
  if (!card || consent.agreeing) return;
  consent.agreeing = true;
  renderMake(selectedProject());
  renderAi();
  renderIntentConsent();
  renderOrganizeConsent();
  renderDesignConsent();
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
    renderIntentConsent();
    renderOrganizeConsent();
    renderDesignConsent();
  }
  if (card.use === 'design') {
    if (agreed && still) await startDesign('ai');
    return;
  }
  if (card.use === 'intent') {
    if (agreed && still) await sendSentence();
    return;
  }
  if (card.use === 'organize') {
    if (agreed && still) await runOrganize();
    return;
  }
  if (!agreed || !still || card.projectId !== selectedId) return;
  if (card.use === 'product') await selectConnection(card.kind);
  else if (card.use === 'check') await startCheck();
  else if (card.use === 'evals') await startScenes('claude-code');
  else if (card.send) await submitRequest();
}

// やめる。直す欄では、同意が要ることと「確かめる」を出す。試作品の中の AI は、お試しのまま。
// 本物の AI で確かめるカードでは、確かめずに、同意が要ることを引き出しに出す
function declineConsent() {
  const card = consent.card;
  if (consent.agreeing) return;
  consent.card = null;
  if (card?.use === 'fix') consent.declined = true;
  if (card?.use === 'intent') intentUi.declined = true;
  if (card?.use === 'organize') organizeUi.declined = true;
  if (card?.use === 'design') designUi.declined = true;
  if (card?.use === 'check') checks.message = { projectId: card.projectId, text: '本物の AI で確かめるには、同意が要ります。お試しの AI なら、同意なしで確かめられます。' };
  if (card?.use === 'evals') sceneUi.message = '本物の AI で回すには、同意が要ります。お試しの AI なら、同意なしで回せます。';
  renderMake(selectedProject());
  renderAi();
  renderIntentConsent();
  renderOrganize();
  renderDesign();
}

// 本物の AI を使っている間の小さな印(試す欄の上と直す欄の上)。押すと、カードの中身をもう一度見られる。
// 試す欄は試作品の中の AI が本物のとき、直す欄は同意の後で作る AI が Claude Code のとき
// 試作品の中の AI が、本物の AI(料金のかかる接続)か
function tryRealAi() {
  return Boolean(ai.session && ai.projectId === selectedId && ai.choices?.options.find((o) => o.kind === ai.session.connection.kind)?.billing);
}

function renderRealAiMarks() {
  scheduleFrame();
  const tryReal = tryRealAi();
  els.showRealAi.hidden = !tryReal;
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
  ({ try: els.realAiTry, now: els.realAiNow }[place] ?? els.realAiMake).focus();
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
    sawHint('make-request');
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

// 試作品の中の AI を選ぶ欄(ux-redesign.md 7-2)。選べない AI は、理由と次の手順を出す
function connectionPicker(session) {
  const box = element('fieldset', undefined, 'ai-picker');
  box.append(element('legend', '試作品の中の AI'));
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
    label.append(radio, document.createTextNode(AI_WORDS[option.kind] ?? option.label));
    box.append(label);
    if (AI_DESCRIPTIONS[option.kind]) box.append(element('p', AI_DESCRIPTIONS[option.kind], 'hint'));
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
// 前の会話の発言と修正を、新しい設定で送り直す。応答するのは試作品の中の AI で、作る AI は動かない。
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

// 応答を待つ間だけ、試す欄の上に「止める」を出す。開発者向けの詳細を閉じていても止められるように
function renderAiWaiting() {
  // 今の行の ▲(答えている)も描き直す
  scheduleFrame();
  const { session } = ai;
  const waiting = Boolean(session) && waitingFor(ai.projectId) > 0;
  els.aiWaiting.hidden = !waiting;
  if (!waiting) {
    els.aiWaiting.replaceChildren();
    return;
  }
  const stop = element('button', '止める');
  stop.type = 'button';
  stop.addEventListener('click', cancelAi);
  els.aiWaiting.replaceChildren(element('span', `${AI_WORDS[session.connection.kind] ?? session.connection.label} の返事を待っています…`), stop);
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
  scheduleFrame();
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
  // 試作品の上の「▲ お試し ▾」(ui-ux-v2.md の 4.2)。読み上げでは、何の切り替えかを言う
  els.aiBadge.textContent = AI_SHORT[session.connection.kind] ?? session.connection.label;
  els.aiSwitch.setAttribute('aria-label', `試作品の中の AI: ${els.aiBadge.textContent}。押すと、お試しか本物かを選べます`);
  els.aiSwitch.title = AI_DESCRIPTIONS[session.connection.kind] ?? session.connection.description;
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

// 保存の札(ux-redesign.md 4 節の「保存版 v1」の行)。名前を付けたときは、その名前を添える
function versionLabel(version) {
  return `保存 ${version.number}${version.name ? `「${version.name}」` : ''}`;
}

// 文の中で、後ろに言葉が続くとき。「」で終わらないときだけ空白を入れる
function versionSubject(version) {
  return version.name ? versionLabel(version) : `${versionLabel(version)} `;
}

// 今の状態(今の試作品のファイルと、メモリーにある会話と状態)と、保存したものを分けて見せる
function workingView(data) {
  const { working } = data;
  const version = data.versions.find((v) => v.id === working.versionId);
  const base = data.versions.find((v) => v.id === working.baseVersionId);
  if (working.files === 'none') {
    return {
      state: 'unsaved',
      text: '今の状態: まだ保存していません。良い状態になったら保存してください。',
    };
  }
  if (working.files === 'changed' || !version) {
    return {
      state: 'changed',
      text: `今の状態には、保存していない変更があります${base ? `(${versionSubject(base)}から)` : ''}。`,
    };
  }
  if (working.conversation === 'changed') {
    return {
      state: 'partly',
      text: `今の試作品のファイルは${versionSubject(version)}と同じです。会話と状態は、保存したときから変わっています。`,
    };
  }
  if (working.conversation === 'initial') {
    return {
      state: 'partly',
      text: `今の試作品のファイルは${versionSubject(version)}と同じです。会話と状態は最初のままです。保存したときの会話から続けるには、その保存の「この状態に戻す」を押してください。`,
    };
  }
  return { state: 'saved', text: `今の状態は${versionSubject(version)}と同じです。` };
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
  head.append(element('strong', `保存 ${version.number}`));
  if (version.name) head.append(element('span', version.name, 'version-name'));
  if (version.kind === 'auto') head.append(element('span', '自動', 'tag'));
  if (working.files === 'saved' && working.versionId === version.id) head.append(element('span', '今の状態と同じ', 'tag current'));
  const conversation = version.ai ? `会話: 発言 ${version.ai.userMessages} 件` : '会話は最初のまま';
  const meta = [new Date(version.savedAt).toLocaleString('ja-JP'), `ファイル ${version.fileCount} 個`, conversation];
  if (!version.builds) meta.push('表示できない状態');
  const button = element('button', 'この状態に戻す');
  button.type = 'button';
  button.disabled = locked;
  button.setAttribute('aria-label', `保存 ${version.number} の状態に戻す`);
  button.title = '保存したときのファイルと会話に戻します。今の状態がどの保存とも違えば、先に自動で保存します';
  button.addEventListener('click', () => restoreVersion(project, version));
  li.append(head, element('p', meta.join('・'), 'muted'), button);
  if (version.shows?.length > 0) li.append(showAnswers(version));
  return li;
}

// 版に残した、人に見せた答え(J7)。版を戻しても消えない
function showAnswers(version) {
  const box = element('details', undefined, 'show-answers');
  keepOpenAs(box, `show-answers:${version.id}`);
  box.append(element('summary', `人に見せた答え(${version.shows.length} 回)`));
  for (const record of version.shows) {
    const section = element('section', undefined, 'show-record');
    const when = new Date(record.answeredAt).toLocaleString('ja-JP');
    section.setAttribute('aria-label', `${when}に見せた答え`);
    section.append(element('p', `${when}${record.viewer ? `・相手: ${record.viewer}` : ''}`, 'muted'));
    const list = element('dl', undefined, 'show-record-list');
    for (const item of record.answers) list.append(element('dt', item.question), element('dd', item.answer));
    section.append(list);
    box.append(section);
  }
  return box;
}

// 版を保存したり戻したりできない間(作る AI の作業中、ビルド中、確かめ中、渡すフォルダーを作っている間)
function versionsLocked(project) {
  return Boolean(!project || project.running || project.building || project.versioning || project.checking || versions.busy || handoff.busy);
}

function renderVersions(project) {
  scheduleFrame();
  const data = project && versions.projectId === project.id ? versions.data : null;
  const locked = versionsLocked(project);
  els.versionName.disabled = locked;
  els.saveVersion.disabled = locked;
  lockHandoff(project);
  els.versionsMessage.hidden = !versions.message;
  els.versionsMessage.textContent = versions.message?.text ?? '';
  els.versionsMessage.dataset.kind = versions.message?.kind ?? '';
  els.saveNow.disabled = locked;
  renderShowStart(project);
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
    versions.message = { kind: 'ok', text: `保存しました(${versionLabel(data.version)})。` };
  } catch (error) {
    versionsFailed(error, '保存できませんでした');
  } finally {
    versions.busy = false;
    if (selectedId !== project.id) versions.message = null;
    renderVersions(selectedProject());
  }
}

// 人に見せる(J7)。表示できる試作品があり、作業中でないときだけ押せる
function renderShowStart(project) {
  els.showStart.disabled =
    showUi.starting || !project?.previewUrl || project.running || project.building || project.versioning || project.checking || versions.busy || handoff.busy;
}

const SHOW_FALLBACK_NOTE = '目的の文書に「成功の印」がないので、決まった問いを出しています。成功の印を書くと、そこから問いを作ります。';

// 見せる画面にする。今の状態をどれかの版に結び付け(どの版とも違えば保存し)、問いを受け取る。
// 開いている画面(目的、整理、設計、審査、会)と引き出しは閉じる
async function startShow() {
  const project = selectedProject();
  if (!project || showUi.starting) return;
  showUi.starting = true;
  renderShowStart(project);
  try {
    const { show } = await api(`/api/projects/${encodeURIComponent(project.id)}/show/start`, { method: 'POST' });
    if (selectedId !== project.id) return;
    setProjectMenu(false);
    setDrawer(null);
    leaveIntent();
    closeOrganize();
    renderOrganize();
    closeDesign();
    renderDesign();
    closeReview();
    closeMeeting();
    Object.assign(showUi, {
      open: true,
      projectId: project.id,
      version: show.version,
      questions: show.questions,
      source: show.source,
      savedNow: show.savedNow,
      message: null,
      warned: false,
    });
    els.showQuestions.replaceChildren(...show.questions.map(showQuestionItem));
    els.showViewer.value = '';
    Object.assign(commentsUi, { projectId: project.id, data: null, snapshot: '', place: null, picking: false, message: null, confirmRevert: null });
    renderShow();
    els.showHeading.focus();
    loadVersions();
    loadComments();
  } catch (error) {
    if (error instanceof ApiError && ['offline', 'token'].includes(error.code)) handleError(error);
    else showBanner(null, `見せる画面を開けませんでした: ${error.message}`);
  } finally {
    showUi.starting = false;
    renderShowStart(selectedProject());
  }
}

function showQuestionItem(question, index) {
  const li = element('li', undefined, 'show-question');
  const label = element('label', question);
  label.htmlFor = `show-answer-${index}`;
  const answer = element('textarea');
  answer.id = `show-answer-${index}`;
  answer.rows = 2;
  answer.maxLength = 1000;
  answer.dataset.question = question;
  answer.addEventListener('input', () => {
    showUi.warned = false;
  });
  li.append(label, answer);
  return li;
}

function showAnswerFields() {
  return [...els.showQuestions.querySelectorAll('textarea')];
}

function renderShow() {
  scheduleFrame();
  els.show.hidden = !showUi.open;
  if (showUi.open) document.body.dataset.show = 'open';
  else delete document.body.dataset.show;
  if (!showUi.open) return;
  const project = projects.find((p) => p.id === showUi.projectId);
  els.showTitle.textContent = project?.title ?? '';
  els.showLead.textContent = [
    showUi.savedNow ? `見せる前に、今の状態を${versionSubject(showUi.version)}として保存しました。` : '',
    `答えは${versionSubject(showUi.version)}に残します。`,
    showUi.source === 'fallback' ? SHOW_FALLBACK_NOTE : '',
  ]
    .filter(Boolean)
    .join('');
  els.showRealAi.hidden = !tryRealAi();
  els.showSave.disabled = showUi.saving;
  els.showStatus.textContent = showUi.message?.text ?? '';
  els.showStatus.dataset.kind = showUi.message?.kind ?? '';
  renderComments();
}

async function saveShowAnswers() {
  if (!showUi.open || showUi.saving) return;
  const answers = showAnswerFields().map((field) => ({ question: field.dataset.question, answer: field.value.trim() }));
  if (!answers.some((item) => item.answer)) {
    showUi.message = { kind: 'failed', text: '答えが 1 つもありません。聞いた答えを書いてから残してください。' };
    renderShow();
    return;
  }
  showUi.saving = true;
  showUi.message = null;
  renderShow();
  const projectId = showUi.projectId;
  try {
    const { record } = await api(`/api/projects/${encodeURIComponent(projectId)}/show/answer`, {
      method: 'POST',
      json: { versionId: showUi.version.id, viewer: els.showViewer.value, answers },
    });
    for (const field of showAnswerFields()) field.value = '';
    els.showViewer.value = '';
    showUi.warned = false;
    showUi.message = { kind: 'ok', text: `${versionSubject(showUi.version)}に答えを残しました(${record.answers.length} 問)。次の人に見せるときは、そのまま続けられます。` };
    loadVersions();
  } catch (error) {
    if (error instanceof ApiError && ['offline', 'token'].includes(error.code)) handleError(error);
    showUi.message = { kind: 'failed', text: `答えを残せませんでした: ${error.message}` };
  } finally {
    showUi.saving = false;
    renderShow();
  }
}

// 見せ終わる。残していない答えがあれば、1 回目は知らせて止まる(もう一度押すと閉じる)
function endShow() {
  if (!showUi.open) return;
  if (!showUi.warned && showAnswerFields().some((field) => field.value.trim())) {
    showUi.warned = true;
    showUi.message = { kind: 'failed', text: '残していない答えがあります。「答えを残す」を押すか、残さずに閉じるときは、もう一度「見せ終わる」を押してください。' };
    renderShow();
    return;
  }
  Object.assign(showUi, { open: false, projectId: null, version: null, questions: [], source: null, savedNow: false, message: null, warned: false });
  els.showQuestions.replaceChildren();
  commentsUi.seq += 1;
  Object.assign(commentsUi, { projectId: null, data: null, snapshot: '', place: null, picking: false, message: null, confirmRevert: null });
  renderShow();
  scheduleFrame();
  els.benchHeading.focus();
}

// ---- 画面へのコメント(K3) ----

const COMMENT_ROLE_WORDS = { facilitator: '進行役', decider: '決める人' };

function commentsPath(projectId, tail = '') {
  return `/api/projects/${encodeURIComponent(projectId)}/comments${tail}`;
}

async function loadComments() {
  const projectId = commentsUi.projectId;
  if (!projectId) return;
  const seq = ++commentsUi.seq;
  try {
    const { comments } = await api(commentsPath(projectId));
    if (seq !== commentsUi.seq || projectId !== commentsUi.projectId) return;
    applyComments(comments);
  } catch (error) {
    if (seq !== commentsUi.seq) return;
    if (error instanceof ApiError && ['offline', 'token'].includes(error.code)) handleError(error);
    else commentsUi.message = { kind: 'failed', text: `コメントを読めませんでした: ${error.message}` };
    renderComments();
  }
}

// 一覧を受け取る。直した版ができたときと戻したときは、見せている版(答えを残す先)を今の版に合わせる
function applyComments(data) {
  const before = commentsUi.data;
  commentsUi.data = data;
  const latest = (list) => list?.comments.flatMap((c) => c.records).flatMap((r) => r.events.map((e) => ({ ...e, record: r }))).sort((a, b) => a.at.localeCompare(b.at)).at(-1) ?? null;
  const prev = latest(before);
  const now = latest(data);
  if (showUi.open && before && now && (!prev || now.at !== prev.at)) {
    const version = now.type === 'reverted' ? now.version : now.type === 'fixed' ? now.record.versions.after : null;
    if (version && version.id !== showUi.version?.id) {
      showUi.version = version;
      showUi.savedNow = false;
      loadVersions();
    }
  }
  renderShow();
}

function renderComments() {
  const data = commentsUi.data;
  const open = showUi.open && commentsUi.projectId === showUi.projectId;
  commentLayer.dataset.on = String(open);
  commentLayer.classList.toggle('picking', open && commentsUi.picking);
  els.commentPlace.setAttribute('aria-pressed', String(commentsUi.picking));
  els.commentPlace.textContent = commentsUi.picking ? '場所を選ぶのをやめる' : '画面の場所を選ぶ';
  els.commentPlaceText.textContent = commentsUi.picking
    ? '試作品の画面の上で、コメントを付けたい所を押してください(Esc でやめる)。'
    : `場所: ${commentsUi.place ? `見えている画面の、左から ${commentsUi.place.x}%、上から ${commentsUi.place.y}% のあたり` : '画面の全体'}`;
  els.commentAdd.disabled = commentsUi.busy || !data || data.broken;
  els.commentStatus.textContent = commentsUi.message?.text ?? '';
  els.commentStatus.dataset.kind = commentsUi.message?.kind ?? '';
  if (!open) return;
  const comments = data?.comments ?? [];
  // 試作品の枠の上の印(番号)。開いている、待っている、直しているコメントだけ
  const pins = comments.filter((c) => c.place && ['open', 'queued', 'fixing', 'review'].includes(c.status)).map((c) => {
    const pin = element('span', String(c.number), 'comment-pin');
    pin.style.left = `${c.place.x}%`;
    pin.style.top = `${c.place.y}%`;
    return pin;
  });
  if (commentsUi.place) {
    const pin = element('span', '新', 'comment-pin comment-pin-new');
    pin.style.left = `${commentsUi.place.x}%`;
    pin.style.top = `${commentsUi.place.y}%`;
    pins.push(pin);
  }
  commentLayer.replaceChildren(...pins);
  const queued = comments.filter((c) => c.status === 'queued');
  const fixing = comments.find((c) => c.status === 'fixing');
  const held = queued.find((c) => c.held);
  els.commentQueue.textContent = [
    fixing ? `作る AI が、コメント ${fixing.number} を直しています。` : '',
    queued.length > 0 ? `列に ${queued.length} 件が待っています(${queued.map((c) => `コメント ${c.number}`).join('、')})。前の直しが終わってから、1 件ずつ送ります。` : '',
    held ? `列を止めています: ${held.held.message}${held.held.next ? ` ${held.held.next}` : ''}` : '',
  ]
    .filter(Boolean)
    .join('');
  els.commentResume.hidden = !held;
  els.commentResume.disabled = commentsUi.busy;
  const snapshot = JSON.stringify([data, commentsUi.busy, commentsUi.confirmRevert]);
  if (snapshot === commentsUi.snapshot) return;
  commentsUi.snapshot = snapshot;
  els.commentList.replaceChildren(...[...comments].reverse().map(commentItem));
}

function approvalWords(comment) {
  const by = (role) => comment.approvals.find((a) => a.role === role);
  const who = (a) => [a.pressedBy ? `押した人: ${a.pressedBy}` : '', a.spokenBy ? `声に出した人: ${a.spokenBy}` : ''].filter(Boolean).join('、');
  const one = (role) => {
    const a = by(role);
    return a ? `${COMMENT_ROLE_WORDS[role]} 済み${who(a) ? `(${who(a)})` : ''}` : `${COMMENT_ROLE_WORDS[role]} まだ`;
  };
  if (comment.needsBoth) return `承認(2 人が要ります): ${one('facilitator')}、${one('decider')}`;
  const done = comment.approvals[0];
  return done ? `承認: ${COMMENT_ROLE_WORDS[done.role]}${who(done) ? `(${who(done)})` : ''}` : '承認: まだ(進行役か決める人の 1 人)';
}

function commentButton(text, onClick, { primary = false, disabled = false } = {}) {
  const button = element('button', text);
  button.type = 'button';
  if (primary) button.className = 'primary';
  button.disabled = commentsUi.busy || disabled;
  button.addEventListener('click', onClick);
  return button;
}

function commentItem(comment) {
  const li = element('li', undefined, 'comment-item');
  li.dataset.status = comment.status;
  li.dataset.commentId = comment.id;
  const head = element('p', undefined, 'comment-head');
  head.append(element('strong', `コメント ${comment.number}`), element('span', comment.kindLabel, 'comment-kind-mark'));
  const state = element('span', `${comment.statusLabel}${comment.queuePosition ? `(列の ${comment.queuePosition} 番目)` : ''}`, 'comment-state');
  head.append(state);
  li.append(head, element('p', comment.text, 'comment-text'));
  const meta = [`場所: ${comment.placeWords}`, comment.author ? `書いた人: ${comment.author}` : ''].filter(Boolean).join('。');
  li.append(element('p', meta, 'muted'));
  if (comment.near?.length > 0) li.append(element('p', `同じ所に向いたコメント: ${comment.near.map((n) => `コメント ${n}`).join('、')}。承認の前に読み比べてください。`, 'comment-near'));
  if (!['closed', 'returned'].includes(comment.status)) li.append(element('p', approvalWords(comment), 'comment-approvals'));
  if (comment.status === 'returned') li.append(element('p', '承認したので、作る AI には送らず、AI 構成の審査に戻しました。審査で 4 つを承認し直すまで、作る AI は作り始めません。', 'comment-note'));
  if (comment.held && comment.status !== 'queued') li.append(element('p', comment.held.message, 'comment-note'));
  const actions = element('div', undefined, 'show-actions comment-actions');
  const id = comment.id;
  const react = commentButton(`同じ意見(反応 ${comment.reactions})`, () => commentAct(id, 'react'), { disabled: comment.status === 'closed' });
  react.setAttribute('aria-label', `コメント ${comment.number} に反応を付ける(今 ${comment.reactions})`);
  if (['open', 'queued'].includes(comment.status)) actions.append(react);
  if (comment.status === 'open') {
    for (const role of ['facilitator', 'decider']) {
      const done = comment.approvals.some((a) => a.role === role);
      actions.append(commentButton(`${COMMENT_ROLE_WORDS[role]}として承認`, () => commentAct(id, 'approve', { role, ...whoFields() }), { primary: true, disabled: done }));
    }
  }
  if (['open', 'queued'].includes(comment.status) && comment.approvals.length > 0) actions.append(commentButton('承認を取り消す', () => commentAct(id, 'unapprove')));
  if (comment.status === 'open') actions.append(commentButton('閉じる', () => commentAct(id, 'close')));
  if (comment.status === 'review') actions.append(commentButton('直った', () => commentAct(id, 'resolve', whoFields()), { primary: true }));
  if (['review', 'resolved', 'failed'].includes(comment.status) && comment.recordId) {
    const confirming = commentsUi.confirmRevert === id;
    actions.append(commentButton(confirming ? '後の直しも一緒に戻す' : '元に戻す', () => revertComment(id, confirming)));
  }
  if (['reverted', 'failed', 'closed'].includes(comment.status)) actions.append(commentButton('開き直す', () => commentAct(id, 'reopen')));
  if (comment.status === 'returned') actions.append(commentButton('審査を開く', () => openReviewFromShow()));
  if (actions.childElementCount > 0) li.append(actions);
  for (const record of comment.records ?? []) li.append(fixRecordBox(record));
  return li;
}

// 直した記録。前と後の画面を並べ、起きたこと(送った、直した、直った、戻した)を出す。関門と依頼の全文は開発者向けに閉じて出す
function fixRecordBox(record) {
  const box = element('section', undefined, 'fix-record');
  box.setAttribute('aria-label', `直した記録(コメント ${record.comment.number})`);
  const label = (v) => (v ? versionSubject(v) : 'なし');
  box.append(element('p', `直す前: ${label(record.versions.before)}。直した後: ${label(record.versions.after)}`, 'muted'));
  if (record.compare?.before || record.compare?.after) {
    const pair = element('div', undefined, 'fix-compare');
    for (const [key, caption] of [['before', '直す前'], ['after', '直した後']]) {
      const figure = element('figure');
      if (record.compare[key]) figure.append(shotImage(commentsUi.projectId, record.compare[key], `${caption}の画面(コメント ${record.comment.number})`));
      else figure.append(element('p', '画面を撮れませんでした', 'muted'));
      figure.append(element('figcaption', caption));
      pair.append(figure);
    }
    box.append(pair);
  }
  if (record.changes?.summary) box.append(element('p', `変わったもの: ${record.changes.files.length} 個のファイル`, 'muted'));
  const events = element('ol', undefined, 'fix-events');
  events.setAttribute('aria-label', `起きたこと(コメント ${record.comment.number})`);
  for (const event of record.events) {
    const who = event.by ? [event.by.pressedBy ? `押した人: ${event.by.pressedBy}` : '', event.by.spokenBy ? `声に出した人: ${event.by.spokenBy}` : ''].filter(Boolean).join('、') : '';
    events.append(element('li', `${formatTime(event.at)} ${event.label}${who ? `(${who})` : ''}${event.note && event.type !== 'failed' ? `。${event.note}` : ''}`));
  }
  box.append(events);
  const dev = element('details', undefined, 'card-dev');
  dev.append(element('summary', '開発者向け: 依頼の全文と確かめた結果'));
  dev.append(element('pre', record.request.text, 'fix-request'));
  dev.append(element('p', `変わったファイル: ${record.changes.files.join('、') || 'なし'}`));
  dev.append(element('p', `関門: ${record.gates.results.map((g) => `${g.id} ${g.label}: ${g.status}`).join('、') || 'なし'}(${record.gates.run ?? '記録なし'})`));
  dev.append(element('p', `記録: .studio/fix-records/${record.id}/record.json`));
  box.append(dev);
  return box;
}

function whoFields() {
  return { pressedBy: els.commentPressed.value, spokenBy: els.commentSpoken.value };
}

async function commentRequest(path, json) {
  const projectId = commentsUi.projectId;
  if (!projectId || commentsUi.busy) return null;
  commentsUi.busy = true;
  commentsUi.message = null;
  renderComments();
  try {
    const result = await api(commentsPath(projectId, path), { method: 'POST', json });
    if (projectId === commentsUi.projectId) {
      commentsUi.seq += 1;
      applyComments(result.comments);
    }
    return result;
  } catch (error) {
    if (error instanceof ApiError && ['offline', 'token'].includes(error.code)) handleError(error);
    if (projectId === commentsUi.projectId) commentsUi.message = { kind: 'failed', text: error.message, code: error.code };
    return null;
  } finally {
    commentsUi.busy = false;
    commentsUi.snapshot = '';
    renderComments();
  }
}

async function addComment() {
  const text = els.commentText.value.trim();
  if (!text) {
    commentsUi.message = { kind: 'failed', text: 'コメントを書いてください。' };
    renderComments();
    return;
  }
  const kind = els.commentForm.querySelector('input[name="comment-kind"]:checked')?.value ?? 'look';
  const result = await commentRequest('', { text, kind, place: commentsUi.place, author: els.commentAuthor.value });
  if (!result) return;
  els.commentText.value = '';
  commentsUi.place = null;
  setPicking(false);
  commentsUi.message = { kind: 'ok', text: `コメント ${result.comment.number} を書きました。承認するまで、作る AI には送りません。` };
  renderComments();
}

async function commentAct(commentId, action, json = {}) {
  commentsUi.confirmRevert = null;
  const result = await commentRequest(`/${commentId}/${action}`, json);
  if (!result?.comment) return;
  const c = result.comment;
  const done = {
    react: null,
    approve: c.status === 'queued' ? `コメント ${c.number} を承認しました。列に並べ、順に作る AI に送ります。` : c.status === 'returned' ? `コメント ${c.number} を承認しました。構成のコメントなので、作る AI には送らず、AI 構成の審査に戻しました。` : `コメント ${c.number} に承認を 1 つ付けました。もう 1 人の承認がそろうまで送りません。`,
    unapprove: `コメント ${c.number} の承認を取り消しました。作る AI には送りません。`,
    close: `コメント ${c.number} を閉じました。`,
    reopen: `コメント ${c.number} を開き直しました。`,
    resolve: `コメント ${c.number} を「直った」にしました。`,
  }[action];
  if (done) {
    commentsUi.message = { kind: 'ok', text: done };
    renderComments();
  }
}

// 元に戻す。後に直したコメントがあれば、1 回目は知らせて止まる(もう一度押すと、それらも一緒に戻す)
async function revertComment(commentId, confirm) {
  const result = await commentRequest(`/${commentId}/revert`, { confirm, ...whoFields() });
  if (result?.comment) {
    commentsUi.confirmRevert = null;
    commentsUi.message = { kind: 'ok', text: `${versionSubject(result.restored)}に戻しました。直した記録に「戻した」を足しました。` };
    lastSnapshot = '';
    await refresh();
  } else if (commentsUi.message?.code === 'later-fixes') {
    commentsUi.confirmRevert = commentId;
  }
  renderComments();
}

async function resumeComments() {
  const result = await commentRequest('/resume', {});
  if (result) commentsUi.message = { kind: 'ok', text: '列を進めました。' };
  renderComments();
}

function setPicking(on) {
  commentsUi.picking = on;
  renderComments();
}

function pickPlace(event) {
  if (!commentsUi.picking) return;
  const rect = commentLayer.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return;
  const clamp = (v) => Math.min(100, Math.max(0, Math.round(v)));
  commentsUi.place = { x: clamp(((event.clientX - rect.left) / rect.width) * 100), y: clamp(((event.clientY - rect.top) / rect.height) * 100) };
  commentsUi.picking = false;
  renderComments();
  els.commentText.focus();
}

// 構成のコメントを審査に戻した後。見せる画面を閉じてから、AI 構成の審査を開く(残していない答えがあれば、見せる画面が知らせて止まる)
async function openReviewFromShow() {
  const projectId = commentsUi.projectId;
  endShow();
  if (showUi.open || !projectId) return;
  await openReview(projectId);
}

// 版の保存や復元の間も押せないようにする。renderVersions からも呼ぶ
function lockHandoff(project) {
  const locked =
    !project || handoff.projectId !== project.id || project.running || project.building || project.versioning || project.checking || versions.busy || handoff.busy;
  for (const field of Object.values(els.handoffNotes)) field.disabled = locked;
  els.handoffExport.disabled = locked;
  els.handoffExport.textContent = handoff.busy ? '作っています…' : '渡すフォルダーを作る';
}

function renderHandoff(project) {
  scheduleFrame();
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
    const where = element('p', 'フォルダーの場所: ');
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
      element(
        'p',
        `渡すフォルダーを作りました。本物につないだもの ${counts.real} 件、お試しのもの ${counts.mock} 件、つないでいないもの ${counts.missing} 件、未決事項 ${counts.questions} 件。`,
      ),
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
    const last = element('p', `前に作ったフォルダー(${new Date(handoff.last.createdAt).toLocaleString('ja-JP')}): `);
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
    handoff.message = `渡すときのメモを読めませんでした: ${error.message}`;
  }
  handoff.projectId = projectId;
  renderHandoff(selectedProject());
}

async function loadTokens(projectId) {
  const seq = ++tokens.seq;
  Object.assign(tokens, { projectId, data: null, file: null, check: null, problems: [], message: null });
  resetGuidesFlow();
  guidesFlow.message = null;
  els.tokensFile.value = '';
  els.tokensSource.value = '';
  els.tokensReason.value = '';
  if (!projectId) return;
  try {
    const { materials } = await api(`/api/projects/${encodeURIComponent(projectId)}/materials`);
    if (seq !== tokens.seq) return;
    tokens.data = materials;
  } catch (error) {
    if (error instanceof ApiError && ['offline', 'token'].includes(error.code)) handleError(error);
    // 次の描画で読み直す
    if (seq === tokens.seq) tokens.projectId = undefined;
  }
  renderTokens(selectedProject());
  renderGuides(selectedProject());
}

async function reloadMaterials(project) {
  tokens.buildAt = project.lastBuild?.finishedAt ?? null;
  const seq = tokens.seq;
  try {
    const { materials } = await api(`/api/projects/${encodeURIComponent(project.id)}/materials`);
    if (seq !== tokens.seq || tokens.projectId !== project.id) return;
    tokens.data = materials;
  } catch (error) {
    if (error instanceof ApiError && ['offline', 'token'].includes(error.code)) handleError(error);
    return;
  }
  renderTokens(selectedProject());
  renderGuides(selectedProject());
}

// 今の役割の選択。まだ選んでいなければ、サーバーの見立て
function chosenTokenRoles() {
  const roles = {};
  for (const select of els.tokensRoles.querySelectorAll('select')) roles[select.name] = select.value || null;
  return roles;
}

function renderTokenRoles() {
  const { check } = tokens;
  const { candidates } = check;
  const rows = (tokens.data?.roles ?? []).map((role) => {
    const row = element('label', null, 'tokens-role');
    row.append(element('span', role.label));
    const select = document.createElement('select');
    select.name = role.id;
    const none = element('option', '既定の素材のまま');
    none.value = '';
    select.append(none);
    for (const token of candidates.filter((t) => t.type === role.type)) {
      const option = element('option', token.path);
      option.value = token.path;
      select.append(option);
    }
    select.value = check.roles[role.id] ?? '';
    select.addEventListener('change', renderTokenMissing);
    row.append(select);
    return row;
  });
  els.tokensRoles.replaceChildren(...rows);
  renderTokenMissing();
}

function renderTokenMissing() {
  const roles = chosenTokenRoles();
  const missing = (tokens.data?.roles ?? []).filter((role) => !roles[role.id]).map((role) => role.label);
  els.tokensMissing.hidden = missing.length === 0;
  els.tokensMissing.textContent = missing.length > 0 ? `足りない役割: ${missing.join('、')}。つなぐ先のトークンがなければ、既定の素材のままになります。` : '';
}

function renderTokens(project) {
  const lock = !project || tokens.busy || project.running || project.building || project.versioning || project.checking;
  const { data, check } = tokens;
  els.tokensFile.disabled = lock || !data;
  const connected = data?.connected ?? null;

  els.tokensConnected.hidden = !connected && !(data?.problems?.length > 0);
  if (connected) {
    const box = [];
    box.push(element('p', `つないでいます: ${connected.fileName}(トークン ${connected.count} 個)`));
    box.push(element('p', `誰の素材か: ${connected.source}`));
    if (connected.reason) box.push(element('p', `つなぐ理由: ${connected.reason}`));
    if (connected.missingRoles.length > 0) box.push(element('p', `既定の素材のままの役割: ${connected.missingRoles.join('、')}`, 'muted'));
    box.push(element('p', '既定の素材の部品と、トークンの変数を使う所が変わります。値のまま書いた色は変わりません。', 'muted'));
    const names = document.createElement('details');
    names.className = 'tokens-names';
    // 開いたものは、次の描画でも開いたまま
    names.open = Boolean(els.tokensConnected.querySelector('.tokens-names')?.open);
    names.append(element('summary', '作る AI が使う名前'));
    const list = element('ul', null, 'tokens-list');
    for (const token of connected.tokens) {
      for (const variable of token.variables) {
        const item = document.createElement('li');
        if (token.type === 'color') {
          const swatch = element('span', null, 'tokens-swatch');
          swatch.style.background = variable.value;
          item.append(swatch);
        }
        item.append(element('code', variable.name));
        list.append(item);
      }
    }
    names.append(list);
    if (connected.count > connected.tokens.length) names.append(element('p', `ほかに ${connected.count - connected.tokens.length} 個あります。`, 'muted'));
    box.push(names);
    const actions = element('div', null, 'tokens-actions');
    const use = element('button', 'トークンを使うよう直す依頼を入れる');
    use.type = 'button';
    use.disabled = lock;
    use.addEventListener('click', () => {
      setDrawer(null);
      fillRequest('つないだトークンの変数を使うように、色と字を直して');
    });
    const remove = element('button', '外す');
    remove.type = 'button';
    remove.disabled = lock;
    remove.addEventListener('click', () => disconnectTokens(project));
    actions.append(use, remove);
    box.push(actions);
    els.tokensConnected.replaceChildren(...box);
  } else if (data?.problems?.length > 0) {
    const remove = element('button', '外す');
    remove.type = 'button';
    remove.disabled = lock;
    remove.addEventListener('click', () => disconnectTokens(project));
    els.tokensConnected.replaceChildren(...data.problems.map((text) => element('p', text)), remove);
  }

  els.tokensMessage.hidden = !tokens.message;
  els.tokensMessage.textContent = tokens.message?.text ?? '';
  els.tokensMessage.dataset.kind = tokens.message?.kind ?? '';

  els.tokensProblems.hidden = tokens.problems.length === 0;
  if (tokens.problems.length > 0) {
    const list = element('ul');
    for (const text of tokens.problems) list.append(element('li', text));
    els.tokensProblems.replaceChildren(element('p', '次の所を直して、選び直してください。'), list);
  }

  const reviewing = Boolean(check?.ok && tokens.file);
  els.tokensReview.hidden = !reviewing;
  if (reviewing) {
    const warnings = check.warnings.length > 0 ? `注意: ${check.warnings.slice(0, 3).join('。')}。` : '';
    els.tokensSummary.textContent = `「${tokens.file.name}」の形を確かめました。トークンが ${check.count} 個あります。${warnings}`;
    els.tokensConnect.disabled = lock || els.tokensSource.value.trim() === '';
  }
}

// ファイルを選んだら検査だけをする。つなぐのは人が押してから
async function checkTokenFile(file) {
  const project = selectedProject();
  if (!project || !file || !tokens.data) return;
  Object.assign(tokens, { file: null, check: null, problems: [], message: null });
  if (file.size > tokens.data.limitBytes) {
    tokens.problems = [`ファイルが大きすぎます(上限 ${tokens.data.limitBytes / 1024} KB)`];
    renderTokens(project);
    return;
  }
  const seq = ++tokens.seq;
  tokens.busy = true;
  renderTokens(project);
  try {
    const text = await file.text();
    const { check } = await api(`/api/projects/${encodeURIComponent(project.id)}/materials/tokens/check`, { method: 'POST', json: { text } });
    if (seq !== tokens.seq) return;
    tokens.check = check;
    if (check.ok) {
      tokens.file = { name: file.name, text };
      renderTokenRoles();
    } else {
      const more = check.errorCount - check.errors.length;
      tokens.problems = [...check.errors.map((error) => error.text), ...(more > 0 ? [`ほかに ${more} 件あります`] : [])];
    }
  } catch (error) {
    if (error instanceof ApiError && ['offline', 'token'].includes(error.code)) handleError(error);
    tokens.problems = [`ファイルを確かめられませんでした: ${error.message}`];
  } finally {
    tokens.busy = false;
    renderTokens(selectedProject());
  }
}

async function connectTokens() {
  const project = selectedProject();
  if (!project || !tokens.file || tokens.busy) return;
  tokens.busy = true;
  renderTokens(project);
  try {
    const data = await api(`/api/projects/${encodeURIComponent(project.id)}/materials/tokens`, {
      method: 'POST',
      json: {
        text: tokens.file.text,
        fileName: tokens.file.name,
        roles: chosenTokenRoles(),
        source: els.tokensSource.value,
        reason: els.tokensReason.value,
      },
    });
    // 待つ間に試作品を切り替えていたら、前の試作品の結果を出さない
    if (tokens.projectId !== project.id) return;
    tokens.data = data.materials;
    if (!data.connected) {
      tokens.problems = data.conflicts ?? data.check.errors.map((error) => error.text);
      return;
    }
    Object.assign(tokens, { file: null, check: null, problems: [] });
    els.tokensFile.value = '';
    els.tokensSource.value = '';
    els.tokensReason.value = '';
    tokens.message = data.build.ok
      ? { kind: 'ok', text: 'つなぎました。試す欄の試作品に入れました。' }
      : { kind: 'failed', text: `つなぎましたが、試作品を表示できません。試す欄は前の状態のままです。${data.build.firstError ?? ''}` };
  } catch (error) {
    if (error instanceof ApiError && ['offline', 'token'].includes(error.code)) handleError(error);
    if (tokens.projectId === project.id) tokens.message = { kind: 'failed', text: `つなげませんでした: ${error.message}` };
  } finally {
    tokens.busy = false;
    lastSnapshot = '';
    await refresh();
    render();
  }
}

async function disconnectTokens(project) {
  if (!project || tokens.busy) return;
  tokens.busy = true;
  tokens.message = null;
  renderTokens(project);
  try {
    const data = await api(`/api/projects/${encodeURIComponent(project.id)}/materials/tokens/remove`, { method: 'POST' });
    if (tokens.projectId !== project.id) return;
    tokens.data = data.materials;
    const left = data.references > 0 ? `トークンの変数を読む所が ${data.references} か所残っていて、その所には色や字の値がありません。「作る AI」の欄で直せます。` : '';
    tokens.message = data.build.ok
      ? { kind: left ? 'failed' : 'ok', text: `外しました。既定の素材の部品の見た目に戻しました。${left}` }
      : { kind: 'failed', text: `外しましたが、試作品を表示できません。試す欄は前の状態のままです。${data.build.firstError ?? ''}` };
  } catch (error) {
    if (error instanceof ApiError && ['offline', 'token'].includes(error.code)) handleError(error);
    if (tokens.projectId === project.id) tokens.message = { kind: 'failed', text: `外せませんでした: ${error.message}` };
  } finally {
    tokens.busy = false;
    lastSnapshot = '';
    await refresh();
    render();
  }
}

// ---- 部品と指針をつなぐ(user-journey.md の J5)。聞く、確かめる、見本で試す、有効にする ----

const GUIDE_KIND_LABELS = { guides: '指針の文', storybook: 'Storybook の部品の一覧', package: '部品のパッケージ' };
// 「何を持っていますか」の答えと、確かめる素材の種類
const GUIDE_HAVE_KINDS = { guides: 'guides', storybook: 'storybook', npm: 'package' };
const GUIDE_LICENSE_LABELS = { listed: '公開のライセンスがある', internal: '社内の素材で、使う許可がある', unknown: '分からない' };
// 「何を持っていますか」の答えごとの案内。指針の文と Storybook のほかは、この案内で進むのをやめる
const GUIDE_HAVE_NOTES = {
  tokens: '色と字のトークンは、上の「自分のトークンをつなぐ」でつなぎます。',
  npm: '部品のパッケージのフォルダーで npm pack を動かして作ったファイル(.tgz)を、次の歩で選びます。中で使えるパッケージは、Studio が同梱するもの(React、Radix Themes、Radix Colors、Lucide)だけです。',
  none: '既定の素材(Radix Themes、Lucide、OS の字)で作れます。何もしなくて大丈夫です。',
  unknown: 'デザイナーに、次のように聞いてください。「試作品に使える、デザインの決まりの文(Markdown)か、Storybook を書き出したフォルダーか、部品のパッケージ(npm pack で作ったファイル)はありますか。誰の素材で、試作品に使ってよいか(ライセンスや社内の許可)も教えてください」',
};

function guidesHave() {
  return els.guidesAsk.querySelector('input[name="guides-have"]:checked')?.value ?? null;
}

function guideAnswers() {
  return { license: els.guidesLicense.value || 'unknown', licenseName: els.guidesLicenseName.value };
}

function guideLicenseText(answers) {
  if (answers.license === 'listed') return `公開のライセンス(${answers.licenseName.trim() || '名前を書いていません'})`;
  return GUIDE_LICENSE_LABELS[answers.license] ?? GUIDE_LICENSE_LABELS.unknown;
}

function resetGuidesFlow() {
  Object.assign(guidesFlow, { step: 1, kind: null, files: null, check: null, problems: [], enabledKey: '' });
  for (const field of [els.guidesSource, els.guidesLicenseName, els.guidesReason, els.guidesFiles, els.guidesFolder, els.guidesPackage]) field.value = '';
  els.guidesLicense.value = '';
  for (const radio of els.guidesAsk.querySelectorAll('input[name="guides-have"]')) radio.checked = false;
  const scope = els.guidesEnableForm.querySelector('input[name="guides-scope"][value="project"]');
  if (scope) scope.checked = true;
}

function guidesStep(step) {
  guidesFlow.step = step;
  if (step === 3) renderGuidesPreview();
  if (step === 4) renderGuidesSummary();
  renderGuides(selectedProject());
  // 次の歩の見出しへ。読み上げでも、どこまで進んだかが分かる
  const heading = { 1: 'guides-ask-heading', 2: 'guides-check-heading', 3: 'guides-try-heading', 4: 'guides-enable-heading' }[step];
  $(heading)?.scrollIntoView({ block: 'nearest' });
}

function renderGuides(project) {
  const data = tokens.data?.guides ?? null;
  const lock = !project || !data || guidesFlow.busy || tokens.busy || project.running || project.building || project.versioning || project.checking;
  renderGuidesEnabled(project, data, lock);

  els.guidesMessage.hidden = !guidesFlow.message;
  els.guidesMessage.textContent = guidesFlow.message?.text ?? '';
  els.guidesMessage.dataset.kind = guidesFlow.message?.kind ?? '';

  const { step, check } = guidesFlow;
  for (const item of els.guidesSteps.children) {
    const n = Number(item.dataset.step);
    item.dataset.state = n < step ? 'done' : n === step ? 'current' : 'todo';
    if (n === step) item.setAttribute('aria-current', 'step');
    else item.removeAttribute('aria-current');
  }
  els.guidesAsk.hidden = step !== 1;
  els.guidesCheck.hidden = step !== 2;
  els.guidesTry.hidden = step !== 3;
  els.guidesEnableForm.hidden = step !== 4;

  // 1. 聞く
  const have = guidesHave();
  const note = GUIDE_HAVE_NOTES[have];
  els.guidesHaveNote.hidden = !note;
  els.guidesHaveNote.textContent = note ?? '';
  const usable = Object.hasOwn(GUIDE_HAVE_KINDS, have ?? '');
  els.guidesOwner.hidden = !usable;
  els.guidesLicenseNameBox.hidden = els.guidesLicense.value !== 'listed';
  for (const field of els.guidesAsk.querySelectorAll('input, select')) field.disabled = lock;
  els.guidesAskNext.disabled = lock || !usable || els.guidesSource.value.trim() === '' || els.guidesLicense.value === '';

  // 2. 確かめる
  els.guidesFilesBox.hidden = guidesFlow.kind !== 'guides';
  els.guidesFolderBox.hidden = guidesFlow.kind !== 'storybook';
  els.guidesPackageBox.hidden = guidesFlow.kind !== 'package';
  els.guidesFiles.disabled = lock;
  els.guidesFolder.disabled = lock;
  els.guidesPackage.disabled = lock;
  els.guidesCheckBack.disabled = guidesFlow.busy;
  els.guidesProblems.hidden = guidesFlow.problems.length === 0;
  if (guidesFlow.problems.length > 0) {
    const list = element('ul');
    for (const text of guidesFlow.problems) list.append(element('li', text));
    els.guidesProblems.replaceChildren(element('p', '次の所を直して、選び直してください。'), list);
  }
  const checked = Boolean(check?.ok && guidesFlow.files);
  els.guidesChecked.hidden = !checked;
  if (checked && els.guidesChecked.dataset.for !== String(guidesFlow.seq)) {
    els.guidesChecked.dataset.for = String(guidesFlow.seq);
    const box = [element('p', guidesCheckedText(check))];
    if (check.urlCount > 0) box.push(element('p', `外への URL が ${check.urlCount} 個あります。次の「見本で試す」で場所を出します。`, 'guides-warning-text'));
    if (check.networkCount > 0) box.push(element('p', `外への通信が ${check.networkCount} か所あります。次の「見本で試す」で場所を出します。`, 'guides-warning-text'));
    for (const warning of check.warnings) box.push(element('p', `${warning.file}${warning.line ? ` ${warning.line} 行目` : ''}: ${warning.text}`, 'muted'));
    if (check.license.detected) box.push(element('p', `フォルダーの中のライセンスの書き方: 「${check.license.detected}」。「1. 聞く」の答えと合っているかを確かめてください。`, 'muted'));
    els.guidesChecked.replaceChildren(...box);
  }
  els.guidesCheckNext.disabled = lock || !checked;

  // 3. 見本で試す、4. 有効にする
  els.guidesTryNext.disabled = !checked;
  const license = check?.license;
  const blocked = Boolean(check && !license?.ok);
  els.guidesBlocked.hidden = !blocked;
  els.guidesBlocked.textContent = blocked ? `有効にできません。${license.reason}` : '';
  for (const field of els.guidesEnableForm.querySelectorAll('input')) field.disabled = lock;
  // 部品のパッケージは、今はこの試作品だけ(これからの試作品全部は後の段)
  const packageOnly = guidesFlow.kind === 'package';
  els.guidesScopeNote.hidden = !packageOnly;
  const allScope = els.guidesEnableForm.querySelector('input[name="guides-scope"][value="all"]');
  if (packageOnly && allScope) {
    allScope.disabled = true;
    if (allScope.checked) els.guidesEnableForm.querySelector('input[name="guides-scope"][value="project"]').checked = true;
  }
  els.guidesEnable.disabled = lock || blocked || !checked;
  els.guidesEnableBack.disabled = guidesFlow.busy;
}

function guidesCheckedText(check) {
  if (check.kind === 'package') return `部品のパッケージ「${check.name}」(${check.version})を確かめました。ファイルが ${check.fileCount} 個あります。試しに組み立てられました。`;
  if (check.kind === 'storybook') return `部品の一覧を確かめました。部品が ${check.components.length} 個あります。`;
  return `指針の文を確かめました。ファイルが ${check.copies.length} 個あります。`;
}

// 有効にしている部品と指針と、これからの試作品全部のもの。写しが変わったときは、戻す操作を出す
function renderGuidesEnabled(project, data, lock) {
  const packagesData = tokens.data?.packages ?? null;
  const key = JSON.stringify({ id: project?.id ?? null, kinds: data?.kinds, studioWide: data?.studioWide, problems: data?.problems, packages: packagesData, lock });
  if (key === guidesFlow.enabledKey) return;
  guidesFlow.enabledKey = key;
  const box = [];
  for (const record of Object.values(data?.kinds ?? {}).filter(Boolean)) {
    const item = element('div', null, 'guides-record');
    const count = record.kind === 'storybook' ? `部品 ${record.componentCount} 個` : `ファイル ${record.files.length} 個`;
    item.append(
      element('p', `有効にしています: ${record.label}(${count})`),
      element('p', `誰の素材か: ${record.source}`),
      element('p', `使ってよいか: ${record.licenseLabel}`),
      element('p', `どこで使うか: ${record.scope === 'all' ? 'これからの試作品全部' : 'この試作品だけ'}${record.from === 'studio' ? '(Studio 全体の素材から入れました)' : ''}`),
    );
    if (record.reason) item.append(element('p', `有効にした理由: ${record.reason}`));
    item.append(element('p', `写し: ${record.files.map((file) => file.copy).join('、')}`, 'muted'));
    if (record.urlCount > 0) item.append(element('p', `外への URL が ${record.urlCount} 個あります。試作品からは読めません。`, 'guides-warning-text'));
    const remove = element('button', `${record.label}を外す`, 'detail-button');
    remove.type = 'button';
    remove.disabled = lock;
    remove.addEventListener('click', () => disableGuides(project, record.kind, 'project'));
    item.append(remove);
    box.push(item);
  }
  for (const record of Object.values(data?.studioWide ?? {}).filter(Boolean)) {
    const item = element('div', null, 'guides-record');
    item.append(element('p', `これからの試作品全部に入れます: ${record.label}(誰の素材か: ${record.source}、使ってよいか: ${record.licenseLabel})`));
    const remove = element('button', `${record.label}を、これからの試作品から外す`, 'detail-button');
    remove.type = 'button';
    remove.disabled = lock;
    remove.addEventListener('click', () => disableGuides(project, record.kind, 'studio'));
    item.append(remove);
    box.push(item);
  }
  for (const record of packagesData?.items ?? []) {
    const item = element('div', null, 'guides-record');
    item.append(
      element('p', `有効にしています: 部品のパッケージ「${record.name}」(${record.version})`),
      element('p', `誰の素材か: ${record.source}`),
      element('p', `使ってよいか: ${record.licenseLabel}`),
      element('p', 'どこで使うか: この試作品だけ'),
    );
    if (record.reason) item.append(element('p', `有効にした理由: ${record.reason}`));
    if (record.exports.length > 0) item.append(element('p', `使える名前: ${record.exports.join('、')}`, 'muted'));
    if (record.networkCount > 0) item.append(element('p', `外への通信が ${record.networkCount} か所あります。試作品からは届きません。`, 'guides-warning-text'));
    const remove = element('button', `部品のパッケージ「${record.name}」を外す`, 'detail-button');
    remove.type = 'button';
    remove.disabled = lock;
    remove.addEventListener('click', () => disablePackage(project, record.name));
    item.append(remove);
    box.push(item);
  }
  if (packagesData?.problems?.length > 0) {
    const item = element('div', null, 'tokens-problems');
    for (const text of packagesData.problems) item.append(element('p', text));
    box.push(item);
  }
  if (data?.problems?.length > 0) {
    const item = element('div', null, 'tokens-problems');
    for (const text of data.problems) item.append(element('p', text));
    const restore = element('button', '写しを戻す');
    restore.type = 'button';
    restore.disabled = lock;
    restore.addEventListener('click', () => restoreGuides(project));
    item.append(restore);
    box.push(item);
  }
  els.guidesEnabled.hidden = box.length === 0;
  els.guidesEnabled.replaceChildren(...box);
}

// 見本で試す。写しと決まりの文は文字だけで描く(画像や字を読まないので、外へ通信しない)
function renderGuidesPreview() {
  const { check } = guidesFlow;
  if (!check?.ok) return;
  if (check.kind === 'package') {
    renderPackagePreview(check);
    return;
  }
  els.guidesUrls.hidden = check.urlCount === 0;
  if (check.urlCount > 0) {
    const list = element('ul');
    for (const found of check.urls) list.append(element('li', `${found.component ? `部品「${found.component}」` : `${found.file}${found.line ? ` ${found.line} 行目` : ''}`}: ${found.url}`));
    els.guidesUrls.replaceChildren(
      element('p', `外への URL が ${check.urlCount} 個あります。試作品は外へ通信できないので、この URL の字や画像は試作品に出ません。使うなら、字や画像を素材のファイルに入れてください。`),
      list,
    );
  }
  const box = [];
  if (check.components.length > 0) {
    const table = element('table', null, 'guides-components');
    table.setAttribute('aria-label', '部品の一覧の見本');
    const head = element('tr');
    head.append(element('th', '部品'), element('th', '見本'), element('th', '使い方'));
    table.append(head);
    for (const component of check.components) {
      const row = element('tr');
      row.append(element('td', component.name), element('td', component.stories.join('、')), element('td', component.description || '(書いてありません)'));
      table.append(row);
    }
    box.push(element('p', 'Storybook から読んだ部品の一覧', 'card-label'), table);
  }
  box.push(element('p', '作る AI が読む写し(試作品のフォルダーに置きます)', 'card-label'));
  check.copies.forEach((copy, index) => {
    const details = document.createElement('details');
    details.open = index === 0;
    details.append(element('summary', `${copy.path}(${copy.title})`), element('pre', copy.text.length > 20000 ? `${copy.text.slice(0, 20000)}\n…(ここまで)` : copy.text, 'guides-copy'));
    box.push(details);
  });
  if (check.rule) box.push(element('p', '作る AI への決まりに足す文', 'card-label'), element('pre', check.rule, 'guides-copy'));
  els.guidesPreview.replaceChildren(...box);
}

// 部品のパッケージの見本で試す。外への通信の場所、使える名前、作る AI への決まりを、文字だけで出す。
// 試しの組み立ては Studio が確かめるときに済ませた(パッケージのコードは Studio では動かさない)
function renderPackagePreview(check) {
  els.guidesUrls.hidden = check.networkCount === 0;
  if (check.networkCount > 0) {
    const list = element('ul');
    for (const found of check.network) list.append(element('li', `${found.file}${found.line ? ` ${found.line} 行目` : ''}: ${found.kind === 'api' ? `通信の道具(${found.text})` : found.text}`));
    const more = check.networkCount - check.network.length;
    if (more > 0) list.append(element('li', `ほかに ${more} か所`));
    els.guidesUrls.replaceChildren(
      element('p', `外への通信が ${check.networkCount} か所あります。試作品は外へ通信できないので、この通信は届きません。字や画像が欠けたり、部品の一部が動かなかったりします。`),
      list,
    );
  }
  const box = [
    element('p', '試作品での使い方', 'card-label'),
    element('pre', `import { ${check.exports.slice(0, 3).join(', ') || '…'} } from '${check.name}';`, 'guides-copy'),
  ];
  if (check.exports.length > 0) box.push(element('p', `使える名前(${check.exports.length} 個): ${check.exports.join('、')}`));
  else box.push(element('p', '使える名前を読めませんでした。CommonJS の形のパッケージは、名前が出ないことがあります。', 'muted'));
  box.push(element('p', `中で使うパッケージ: ${check.dependencies.length > 0 ? check.dependencies.join('、') : 'ありません'}(Studio が同梱するもの)`, 'muted'));
  if (check.rule) box.push(element('p', '作る AI への決まりに足す文', 'card-label'), element('pre', check.rule, 'guides-copy'));
  els.guidesPreview.replaceChildren(...box);
}

// 有効にする前の、出典とライセンスの一覧
function renderGuidesSummary() {
  const { check } = guidesFlow;
  if (!check) return;
  if (check.kind === 'package') {
    const list = element('dl', null, 'guides-facts');
    const add = (term, value) => list.append(element('dt', term), element('dd', value));
    add('素材', `部品のパッケージ「${check.name}」(${check.version}、ファイル ${check.fileCount} 個)`);
    add('誰の素材か', els.guidesSource.value.trim());
    add('使ってよいか', guideLicenseText(guideAnswers()));
    add('置く場所', 'Studio の中(試作品のフォルダーの外)。作る AI は中身を読めず、名前で import します');
    add('外への通信', check.networkCount > 0 ? `${check.networkCount} か所(試作品からは届きません)` : 'ありません');
    add('使える試作品', 'この試作品だけ');
    els.guidesSummary.replaceChildren(element('p', '出典とライセンスの一覧', 'card-label'), list, element('p', '外せば、いつでも前の素材に戻せます。', 'muted'));
    return;
  }
  const list = element('dl', null, 'guides-facts');
  const add = (term, value) => list.append(element('dt', term), element('dd', value));
  add('素材', `${GUIDE_KIND_LABELS[check.kind]}(${check.kind === 'storybook' ? `部品 ${check.components.length} 個` : `ファイル ${check.copies.length} 個`})`);
  add('誰の素材か', els.guidesSource.value.trim());
  add('使ってよいか', guideLicenseText(guideAnswers()));
  add('写す場所', check.copies.map((copy) => copy.path).join('、'));
  add('外への URL', check.urlCount > 0 ? `${check.urlCount} 個(試作品からは読めません)` : 'ありません');
  els.guidesSummary.replaceChildren(element('p', '出典とライセンスの一覧', 'card-label'), list, element('p', '外せば、いつでも前の素材に戻せます。', 'muted'));
}

// Storybook のフォルダーから送るファイル。選んだフォルダーの中か、1 つ下のフォルダーの中(1 つ上を選んだとき)
const STORYBOOK_WANTED = /^(?:[^/]+\/)?(?:index\.json|package\.json|manifests\/components\.json|licen[cs]e(?:\.[a-z]+)?)$/i;

// 選んだファイルを読む。フォルダーからは、部品の一覧と使い方の文とライセンスの手がかりだけを送る
async function readGuideFiles(kind, fileList) {
  if (kind === 'package') return readPackageFile(fileList[0]);
  const limits = tokens.data.guides.limits;
  const files = [];
  const problems = [];
  for (const file of fileList) {
    const relative = file.webkitRelativePath || file.name;
    const parts = relative.split('/');
    const inner = parts.length > 1 ? parts.slice(1).join('/') : relative;
    if (kind === 'storybook') {
      if (!STORYBOOK_WANTED.test(inner)) continue;
      if (file.size > limits.maxIndexBytes) {
        problems.push(`${relative}: 大きすぎます(上限 ${limits.maxIndexBytes / 1024 / 1024} MB)`);
        continue;
      }
    } else {
      if (!/\.(md|markdown)$/i.test(file.name)) continue;
      if (file.size > limits.maxFileBytes) {
        problems.push(`${relative}: 大きすぎます(上限 ${limits.maxFileBytes / 1024} KB)`);
        continue;
      }
    }
    files.push({ path: relative, text: await file.text() });
  }
  return { files, problems };
}

// 部品のパッケージのファイルを読む。base64 にして送る(Studio が展開して確かめる)
async function readPackageFile(file) {
  const limit = tokens.data.packages?.limits?.maxTarballBytes ?? 0;
  if (!file) return { files: null, problems: ['npm pack で作ったファイル(.tgz)を選んでください'] };
  if (file.size > limit) return { files: null, problems: [`${file.name}: 大きすぎます(上限 ${limit / 1024 / 1024} MB)`] };
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return { files: { tarball: btoa(binary), fileName: file.name }, problems: [] };
}

// 2. 確かめる。検査だけで、何も書かない
async function checkGuideFiles(fileList) {
  const project = selectedProject();
  if (!project || !tokens.data?.guides || !guidesFlow.kind) return;
  Object.assign(guidesFlow, { files: null, check: null, problems: [] });
  const seq = ++guidesFlow.seq;
  guidesFlow.busy = true;
  renderGuides(project);
  try {
    const { files, problems } = await readGuideFiles(guidesFlow.kind, fileList);
    if (problems.length > 0) {
      guidesFlow.problems = problems;
      return;
    }
    await runGuideCheck(project, files, seq);
  } catch (error) {
    if (error instanceof ApiError && ['offline', 'token'].includes(error.code)) handleError(error);
    if (seq === guidesFlow.seq) guidesFlow.problems = [`ファイルを確かめられませんでした: ${error.message}`];
  } finally {
    if (seq === guidesFlow.seq) guidesFlow.busy = false;
    renderGuides(selectedProject());
  }
}

async function runGuideCheck(project, files, seq) {
  const isPackage = guidesFlow.kind === 'package';
  const { check } = await api(`/api/projects/${encodeURIComponent(project.id)}/materials/${isPackage ? 'packages' : 'guides'}/check`, {
    method: 'POST',
    json: isPackage ? { ...files, answers: guideAnswers() } : { kind: guidesFlow.kind, files, answers: guideAnswers() },
  });
  if (seq !== guidesFlow.seq) return;
  guidesFlow.check = check;
  if (check.ok) {
    guidesFlow.files = files;
  } else {
    const more = check.errorCount - check.errors.length;
    guidesFlow.problems = [...check.errors.map((error) => `${error.file ? `${error.file}${error.line ? ` ${error.line} 行目` : ''}: ` : ''}${error.text}`), ...(more > 0 ? [`ほかに ${more} 件あります`] : [])];
  }
}

// 1. 聞く の答えで進む。選び直した答え(ライセンスなど)で、選んだファイルを確かめ直す
async function submitGuideAsk() {
  const project = selectedProject();
  const kind = GUIDE_HAVE_KINDS[guidesHave() ?? ''];
  if (!project || !kind) return;
  if (guidesFlow.kind !== kind) {
    Object.assign(guidesFlow, { kind, files: null, check: null, problems: [] });
    els.guidesFiles.value = '';
    els.guidesFolder.value = '';
    els.guidesPackage.value = '';
  } else if (guidesFlow.files) {
    const seq = ++guidesFlow.seq;
    guidesFlow.busy = true;
    renderGuides(project);
    try {
      await runGuideCheck(project, guidesFlow.files, seq);
    } catch (error) {
      if (error instanceof ApiError && ['offline', 'token'].includes(error.code)) handleError(error);
      if (seq === guidesFlow.seq) guidesFlow.problems = [`ファイルを確かめられませんでした: ${error.message}`];
    } finally {
      if (seq === guidesFlow.seq) guidesFlow.busy = false;
    }
  }
  guidesStep(2);
}

// 4. 有効にする。サーバーがもう一度確かめ、ライセンスが分からなければ断る
async function enableGuides() {
  const project = selectedProject();
  const { check, files, kind } = guidesFlow;
  if (!project || !check?.ok || !check.license.ok || !files || guidesFlow.busy) return;
  guidesFlow.busy = true;
  guidesFlow.message = null;
  renderGuides(project);
  const scope = kind === 'package' ? 'project' : els.guidesEnableForm.querySelector('input[name="guides-scope"]:checked')?.value ?? 'project';
  try {
    const owner = { answers: guideAnswers(), source: els.guidesSource.value, reason: els.guidesReason.value, scope };
    const data = await api(`/api/projects/${encodeURIComponent(project.id)}/materials/${kind === 'package' ? 'packages' : 'guides'}`, {
      method: 'POST',
      json: kind === 'package' ? { ...files, ...owner } : { kind, files, ...owner },
    });
    if (tokens.projectId !== project.id) return;
    tokens.data = data.materials;
    if (!data.enabled) {
      guidesFlow.check = data.check;
      guidesFlow.problems = data.check.errors.map((error) => error.text);
      guidesStep(2);
      return;
    }
    resetGuidesFlow();
    const where = scope === 'all' ? '。これからの試作品にも入れます' : '';
    const done = kind === 'package'
      ? `有効にしました。この試作品は「${check.name}」を import できます。作る AI は次の依頼から使えます。`
      : `有効にしました${where}。作る AI は次の依頼から、${GUIDE_KIND_LABELS[kind]}を読みます。`;
    guidesFlow.message = data.build.ok
      ? { kind: 'ok', text: done }
      : { kind: 'failed', text: `有効にしましたが、試作品を表示できません。試す欄は前の状態のままです。${data.build.firstError ?? ''}` };
  } catch (error) {
    if (error instanceof ApiError && ['offline', 'token'].includes(error.code)) handleError(error);
    if (tokens.projectId === project.id) guidesFlow.message = { kind: 'failed', text: `有効にできませんでした: ${error.message}` };
  } finally {
    guidesFlow.busy = false;
    lastSnapshot = '';
    await refresh();
    render();
  }
}

async function disableGuides(project, kind, from) {
  if (!project || guidesFlow.busy) return;
  guidesFlow.busy = true;
  guidesFlow.message = null;
  renderGuides(project);
  try {
    const data = await api(`/api/projects/${encodeURIComponent(project.id)}/materials/guides/remove`, { method: 'POST', json: { kind, from } });
    if (tokens.projectId !== project.id) return;
    tokens.data = data.materials;
    if (from === 'studio') guidesFlow.message = { kind: 'ok', text: `これからの試作品には、${GUIDE_KIND_LABELS[kind]}を入れません。今ある試作品はそのままです。` };
    else guidesFlow.message = data.build.ok
      ? { kind: 'ok', text: `${GUIDE_KIND_LABELS[kind]}を外しました。写しを消し、作る AI への決まりからも外しました。` }
      : { kind: 'failed', text: `外しましたが、試作品を表示できません。試す欄は前の状態のままです。${data.build.firstError ?? ''}` };
  } catch (error) {
    if (error instanceof ApiError && ['offline', 'token'].includes(error.code)) handleError(error);
    if (tokens.projectId === project.id) guidesFlow.message = { kind: 'failed', text: `外せませんでした: ${error.message}` };
  } finally {
    guidesFlow.busy = false;
    lastSnapshot = '';
    await refresh();
    render();
  }
}

// 部品のパッケージを外す。試作品がまだ import していれば、表示できなくなる(試す欄は前の状態のまま)
async function disablePackage(project, name) {
  if (!project || guidesFlow.busy) return;
  guidesFlow.busy = true;
  guidesFlow.message = null;
  renderGuides(project);
  try {
    const data = await api(`/api/projects/${encodeURIComponent(project.id)}/materials/packages/remove`, { method: 'POST', json: { name } });
    if (tokens.projectId !== project.id) return;
    tokens.data = data.materials;
    guidesFlow.message = data.build.ok
      ? { kind: 'ok', text: `部品のパッケージ「${name}」を外しました。作る AI への決まりからも外しました。` }
      : { kind: 'failed', text: `部品のパッケージ「${name}」を外しました。試作品がまだ使っているので、表示できません。試す欄は前の状態のままです。「作る AI」の欄で、使わない形に直してもらってください。` };
  } catch (error) {
    if (error instanceof ApiError && ['offline', 'token'].includes(error.code)) handleError(error);
    if (tokens.projectId === project.id) guidesFlow.message = { kind: 'failed', text: `外せませんでした: ${error.message}` };
  } finally {
    guidesFlow.busy = false;
    lastSnapshot = '';
    await refresh();
    render();
  }
}

async function restoreGuides(project) {
  if (!project || guidesFlow.busy) return;
  guidesFlow.busy = true;
  guidesFlow.message = null;
  renderGuides(project);
  try {
    const data = await api(`/api/projects/${encodeURIComponent(project.id)}/materials/guides/restore`, { method: 'POST' });
    if (tokens.projectId !== project.id) return;
    tokens.data = data.materials;
    guidesFlow.message = data.build.ok
      ? { kind: 'ok', text: '写しを戻しました。試す欄の試作品を作り直しました。' }
      : { kind: 'failed', text: `写しを戻しましたが、試作品を表示できません。${data.build.firstError ?? ''}` };
  } catch (error) {
    if (error instanceof ApiError && ['offline', 'token'].includes(error.code)) handleError(error);
    if (tokens.projectId === project.id) guidesFlow.message = { kind: 'failed', text: `写しを戻せませんでした: ${error.message}` };
  } finally {
    guidesFlow.busy = false;
    lastSnapshot = '';
    await refresh();
    render();
  }
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
    if (handoff.projectId === project.id) handoff.message = `渡すフォルダーを作れませんでした: ${error.message}`;
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
    if (data.autoSaved) text += `戻す前の状態は、保存 ${data.autoSaved.number}(自動)にしました。`;
    if (data.setAside) text += `戻す前の状態は大きすぎて保存できないので、${data.setAside} に移しました。`;
    if (!data.build.ok) text += 'ただし、戻した試作品を表示できません。試す欄は前の状態のままです。';
    else if (data.conversation === 'initial') text += '保存した会話は今の AI の設定に合わないので、会話は最初から始めます。';
    versions.message = { kind: data.build.ok ? 'ok' : 'failed', text };
    // 元に戻した(5.4)。作業台の上の 1 行。表示できなかったときは、試す欄が前のままなので出さない
    frame.reverted = data.build.ok ? { projectId: project.id, restored: data.restored, before: data.before ?? null, setAside: Boolean(data.setAside) } : null;
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
    if (step.delegate) li.append(labeled('委任の頼み', nameOf(step.delegate.to)));
  } else if (step.kind === 'agent') {
    li.dataset.step = 'agent';
    const facts = [`接続 ${via(step)}`];
    // マスターとサブ(docs/design/agent-simulation.md の 2.9)。任された参加者(サブ)には、任せた参加者と深さを出す
    if (step.parent) {
      li.dataset.depth = String(step.depth);
      facts.unshift(`${nameOf(step.parent)} から任された仕事(深さ ${step.depth})`);
    } else if (Number.isFinite(step.round) && step.round > 1) facts.unshift(`任せた結果を受け取って ${step.round} 回目`);
    if (Number.isFinite(step.ms)) facts.push(`${step.ms} ミリ秒`);
    if (Number.isFinite(step.costUsd)) facts.push(`費用の目安 $${step.costUsd.toFixed(4)}`);
    li.append(element('strong', `参加者 ${nameOf(step.participant)}(模擬のエージェント${step.parent ? '、サブ' : ''})`), document.createTextNode(`: ${facts.join('、')}`));
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
  } else if (step.delegationIgnored) {
    li.dataset.step = 'delegation-ignored';
    li.append(element('strong', `${nameOf(step.participant)} の委任(${step.delegationIgnored.map(nameOf).join('、')})を使いませんでした`), document.createTextNode(`: ${step.reason}`));
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
  if (entry.delegations?.length) {
    // 委任(マスターとサブ)。任せた参加者 → 任された参加者、深さ、通したか。止めたときは理由
    const lines = entry.delegations.map((d) => `${nameOf(d.from)} → ${nameOf(d.to)}(深さ ${d.depth}): ${EFFECT_WORDS[d.effect] ?? d.effect}${d.reason ? `、理由 ${d.reason}` : ''}`);
    box.append(labeled('委任', lines.join(' / ')));
  }
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

// 1 ターンの記録(task 423。ai-architecture-review.md の 15 節)。試す欄の会話で最後に送った発言の記録から、
// 働いた参加者、呼んだ道具、効いた守りの層、時間、費用を、技術の言葉と平たい言葉を並べて出す。観察の会話の記録は使わない。
// 全部の中身(引数、プロンプトの部品、理由)は、開発者向けの詳細の「AI の実行の記録」に残す
const TURN_KIND_WORDS = { agent: 'エージェント(道具を選びながら自分で進める AI)', harness: 'harness(AI の周りで決まりを守らせるコード)', human: '人(模擬)' };
const TURN_EFFECTS = { passed: '通した', blocked: '止めた', violated: '合わなかった(記録だけ)', retried: 'やり直させた', replaced: '決まった文に代えた', asked: '頼んだ' };
const HARNESS_GUARD_EFFECTS = { passed: 'passed', retried: 'retried', fallback: 'replaced' };

function lastTurnEntry() {
  if (trace.projectId !== ai.projectId || !trace.entries) return null;
  // 記録は新しい順。観察の会話と、発言でない記録(リセット、切り替え)は飛ばす
  return trace.entries.find((entry) => entry.type === 'reply' && !entry.observation) ?? null;
}

// 段から、守りの層と判定を集める。出口の確かめと会話の枠は返事の段に、ツールの守りはツールの段に付く
function turnGuards(entry) {
  if (entry.kind === 'sim-turn') {
    const guards = (entry.steps ?? []).flatMap((step) => [
      ...(step.guards ?? []).map((guard) => ({ ...guard, tool: typeof step.tool === 'string' ? step.tool : null })),
      ...(step.prompt?.asked ?? []).map((id) => ({ layer: 'prompt', guard: id, effect: 'asked' })),
    ]);
    for (const d of entry.delegations ?? []) if (d.effect === 'blocked') guards.push({ layer: 'delegation', guard: 'delegation', effect: 'blocked', reason: d.reason });
    if (entry.handoff?.effect === 'blocked') guards.push({ layer: 'handoff', guard: 'handoff', effect: 'blocked', reason: entry.handoff.reason });
    return guards;
  }
  // 構成のない試作品(AI の設定 1 つ)。harness の守ることの確かめ(出口の確かめ)と、状態に入れなかった値(コードの検査)
  const guards = [];
  const checked = entry.harness?.guards;
  if (checked) guards.push({ layer: 'output', guard: checked.failed?.length ? checked.failed.join('、') : 'guards', effect: HARNESS_GUARD_EFFECTS[checked.result] ?? checked.result });
  if (entry.rejected?.length) guards.push({ layer: 'tool', guard: 'fields', effect: 'blocked', reason: `${entry.rejected.length} つの値を状態に入れなかった` });
  if (entry.harness?.timeout) guards.push({ layer: 'output', guard: 'timeout', effect: 'replaced' });
  return guards;
}

const TURN_LAYERS = {
  tool: 'ツールの守り(コードが止める)',
  permission: '渡したツールの名前(コードが止める)',
  prompt: 'プロンプトの頼み(モデル頼み)',
  output: '出口の確かめ(返事をコードが確かめる)',
  surface: '会話の枠(使えない部品を落とす)',
  delegation: '委任の上限(コードが止める)',
  handoff: '引き継ぎの決まり(コードが止める)',
};

function turnGuardText(guard) {
  let effect = TURN_EFFECTS[guard.effect] ?? guard.effect;
  if (guard.layer === 'surface') effect = guard.to ? `${partWord(guard.from)}を${partWord(guard.to)}に落とした` : `${partWord(guard.from)}を外した`;
  return `${TURN_LAYERS[guard.layer] ?? guard.layer}「${guard.guard}」${guard.tool ? `(${guard.tool})` : ''}: ${effect}`;
}

// この 1 ターンの流れ(ui-ux-v2.md の 4.2)。1 行ごとに、時刻(等幅。発言を受けてからの秒)、者の形、部品の種類、平たい 1 文。
// 者の形はモデルの行(▲)と守りの行(⬢)にだけ付け、コードと道具の行には付けない。守りが止めた行は「止めました」と、
// 続く行で「失敗ではなく、守りが働いた印」と止めた層の名前を出す。プロンプトの全文と道具の入出力は仕組みの引き出しへ
const TIMELINE_KINDS = { code: 'コード', model: 'モデル', tool: '道具', guard: '守り', person: '人' };
const GUARD_DONE = { blocked: '止めました', retried: 'やり直させました', replaced: '決まった文に代えました', violated: '合わないところを記録しました' };

// 時刻は、発言を受けてからの秒。段は始まった順に並ぶ。参加者の段(エージェント、harness、人)は順に進み、
// ツールの段は、それを呼んだ参加者の段の中で起きる(参加者の段の ms はツールの時間を含む)
function timelineRows(entry, nameOf) {
  const rows = [];
  let at = 0;
  let top = 0;
  let inner = 0;
  const push = (kind, text, extra = {}) => rows.push({ at, kind, text, ...extra });
  const guardRows = (guards) => {
    for (const guard of guards ?? []) {
      if (!GUARD_DONE[guard.effect]) continue;
      const layer = LAYER_WORDS[guard.layer] ?? TURN_LAYERS[guard.layer] ?? guard.layer;
      push('guard', `${GUARD_DONE[guard.effect]}: ${guard.tool ?? guard.guard}`, { effect: guard.effect, name: guard.tool ?? guard.guard, layerWord: layer });
      if (guard.effect === 'blocked') push('note', `止めたのは${layer}。失敗ではなく、守りが働いた印です。`, { layer: guard.layer });
    }
  };
  push('code', '発言を受け取る');
  if (entry.kind === 'sim-turn') {
    for (const step of entry.steps ?? []) {
      const ms = Number.isFinite(step.ms) ? step.ms : 0;
      if (typeof step.tool === 'string') {
        at = inner;
        inner += ms;
      } else if (['agent', 'harness', 'human'].includes(step.kind)) {
        at = top;
        inner = top;
        top += ms;
      } else at = top;
      if (typeof step.tool === 'string') {
        const blocked = (step.guards ?? []).some((guard) => guard.effect === 'blocked');
        push('tool', `${step.tool} を呼ぶ${blocked ? '' : step.result?.ok ? '' : '(失敗した)'}`);
        guardRows((step.guards ?? []).map((guard) => ({ ...guard, tool: step.tool })));
      } else if (step.kind === 'agent') {
        push('model', `${nameOf(step.participant)}が、次にすることを考える`);
        guardRows(step.guards);
      } else if (step.kind === 'harness') {
        push('code', `${nameOf(step.participant)}の決まった手順で進める`);
        guardRows(step.guards);
      } else if (step.kind === 'human') {
        push('person', `${nameOf(step.participant)}(人の役)の決まった返事`);
      } else if (step.fallback) {
        push('guard', `${nameOf(step.participant)}の返事を決まった文に代えました`, { effect: 'replaced' });
      } else if (step.output) {
        push('code', `返事の部品をそろえる(${partsText(step.output.parts)})`);
        guardRows(step.guards);
      } else {
        guardRows(step.guards);
      }
    }
    at = top;
    for (const d of entry.delegations ?? []) if (d.effect === 'blocked') guardRows([{ layer: 'delegation', guard: '委任', effect: 'blocked' }]);
    if (entry.handoff?.effect === 'blocked') guardRows([{ layer: 'handoff', guard: '引き継ぎ', effect: 'blocked' }]);
  } else {
    // 構成のない試作品(AI の設定 1 つ)。抽出と言い方はモデル、決定と確かめはコード
    const harness = entry.harness ?? {};
    if (harness.extract) push('model', '発言から、決まった項目を読み取る');
    if (entry.rejected?.length) guardRows([{ layer: 'tool', guard: `${entry.rejected.length} つの値`, effect: 'blocked' }]);
    if (harness.decision) push('code', `次に${harness.decision.ask?.label ? `「${harness.decision.ask.label}」を聞く` : '言うこと'}と決める`);
    if (harness.phrase) push('model', '返事の言い方を作る');
    const checked = harness.guards;
    if (checked) {
      if (checked.result === 'passed') push('guard', '出口の確かめ: 通しました', { effect: 'passed' });
      else guardRows([{ layer: 'output', guard: checked.failed?.join('、') || '守ること', effect: HARNESS_GUARD_EFFECTS[checked.result] ?? checked.result }]);
    }
  }
  if (Number.isFinite(entry.elapsedMs) && entry.status !== 'running') at = Math.max(at, entry.elapsedMs);
  push('code', entry.status === 'running' ? '返事を待っています' : '返事を返す');
  return rows;
}

function renderTimeline(entry, nameOf) {
  const rows = timelineRows(entry, nameOf);
  // 守りが止めた(5.4)。最初に止めたものの名前と層を、3 つの文で言う
  const blocked = rows.find((row) => row.effect === 'blocked');
  const guardLine = $('turn-guard');
  guardLine.hidden = !blocked;
  if (blocked) {
    fillState(guardLine, 'guard-stopped', {
      what: `「${blocked.name}」`,
      now: `止めたのは${blocked.layerWord}で、失敗ではなく守りが働いた印です。`,
      next: '何もしなくて大丈夫で、気になれば下の ⬢ の行を読めます。',
    });
  }
  const items = rows.map((row) => {
    const li = element('li', undefined, 'timeline-row');
    li.dataset.kind = row.kind;
    if (row.effect) li.dataset.effect = row.effect;
    if (row.kind === 'note') {
      li.append(element('span', '', 'tl-time'), element('span', '→', 'tl-shape'), element('span', '', 'tl-kind'), element('span', row.text, 'tl-text'));
      return li;
    }
    const time = element('time', (row.at / 1000).toFixed(2), 'tl-time');
    const shape = element('span', row.kind === 'model' ? '▲' : row.kind === 'guard' ? '⬢' : '', 'tl-shape');
    shape.setAttribute('aria-hidden', 'true');
    li.append(time, shape, element('span', TIMELINE_KINDS[row.kind] ?? row.kind, 'tag tl-kind'), element('span', row.text, 'tl-text'));
    return li;
  });
  els.turnTimeline.replaceChildren(...items);
}

function renderTurnRecord() {
  const section = $('turn-record');
  const body = $('turn-record-body');
  const entry = ai.session && ai.projectId === selectedId ? lastTurnEntry() : null;
  section.hidden = !entry;
  els.turnEmpty.hidden = Boolean(entry);
  els.turnEmpty.textContent = ai.projectId === selectedId && ai.loaded && !ai.session
    ? 'この試作品には、試作品の中の AI がいません。1 ターンの記録はありません。'
    : 'まだ話していません。左の試作品で話しかけると、1 回の返事で働いた部品が、時刻の順に出ます。';
  if (!entry) {
    els.turnTimeline.replaceChildren();
    body.replaceChildren();
    return;
  }
  section.dataset.status = entry.status;
  const labels = new Map((entry.participants ?? []).map((p) => [p.id, p]));
  const nameOf = (id) => labels.get(id)?.label ?? String(id);
  const via = entry.connection?.real ? '本物の AI' : 'お試しの AI';
  const head = element('p');
  head.append(element('strong', `発言「${entry.text || '(ボタン)'}」`), document.createTextNode(`(${via}。${formatTime(entry.at)}。${TRACE_STATUS[entry.status] ?? entry.status})`));
  // 用語と中身の 2 列。dl は使わない(試す欄の AI の状態の dl と、読み上げの役割が混ざらないように)
  const facts = element('div', undefined, 'turn-facts');
  const row = (term, value) => {
    const cell = element('div', undefined, 'turn-value');
    if (value instanceof Node) cell.append(value);
    else cell.textContent = value;
    facts.append(element('div', term, 'turn-term'), cell);
  };
  // 参加者: 段に出てきた順。任された参加者(サブ)には、任せた参加者を添える
  const acted = [];
  if (entry.kind === 'sim-turn') {
    for (const step of entry.steps ?? []) {
      if (!['agent', 'harness', 'human'].includes(step.kind) || acted.some((item) => item.id === step.participant)) continue;
      acted.push({ id: step.participant, kind: step.kind, parent: step.parent ?? null });
    }
  }
  const people = element('ul');
  people.setAttribute('aria-label', '働いた参加者');
  if (entry.kind === 'sim-turn') {
    people.append(...acted.map((item) => element('li', `${nameOf(item.id)}: ${TURN_KIND_WORDS[item.kind] ?? item.kind}${item.parent ? `。${nameOf(item.parent)} から任された(サブ)` : ''}`)));
  } else {
    people.append(element('li', `試作品の中の AI: ${TURN_KIND_WORDS.harness}`));
  }
  if (people.childElementCount === 0) people.append(element('li', 'まだ分かりません'));
  row('参加者(エージェント)', people);
  // 道具: 呼んだツールと、通ったか止まったか
  const tools = (entry.steps ?? []).filter((step) => typeof step.tool === 'string');
  const toolList = element('ul');
  toolList.setAttribute('aria-label', '呼んだ道具');
  for (const step of tools) {
    const blocked = (step.guards ?? []).find((guard) => guard.effect === 'blocked');
    const li = element('li', `${step.tool}(${nameOf(step.by)} が呼んだ): ${blocked ? `${TURN_LAYERS[blocked.layer] ?? blocked.layer}が止めた` : step.result?.ok ? '通った' : '失敗した'}`);
    li.dataset.effect = blocked ? 'blocked' : step.result?.ok ? 'passed' : 'failed';
    toolList.append(li);
  }
  row('道具(ツール)', tools.length > 0 ? toolList : '呼んでいません');
  // 守り: 止めた、やり直させた、代えたものを先に出す。通しただけのものは数だけ
  const guards = turnGuards(entry);
  const acting = guards.filter((guard) => guard.effect !== 'passed');
  const passed = guards.length - acting.length;
  const guardList = element('ul');
  guardList.setAttribute('aria-label', '守りの層');
  const order = (guard) => (guard.effect === 'blocked' ? 0 : guard.effect === 'asked' ? 2 : 1);
  for (const guard of [...acting].sort((a, b) => order(a) - order(b))) {
    const li = element('li', turnGuardText(guard));
    li.dataset.layer = guard.layer;
    li.dataset.effect = guard.effect;
    guardList.append(li);
  }
  if (passed > 0) guardList.append(element('li', `ほかに通した守り ${passed} つ`));
  if (guardList.childElementCount === 0) guardList.append(element('li', '守りの記録はありません'));
  row('守り(ガードレール)', guardList);
  const cost = entry.output?.costUsd;
  const time = Number.isFinite(entry.elapsedMs) && entry.status !== 'running' ? formatSeconds(entry.elapsedMs) : '待っています';
  row('時間と費用', `${time}、${entry.connection?.real ? (Number.isFinite(cost) ? `${cost.toFixed(4)} USD(Claude Code の報告)` : '費用は不明') : '費用はかかりません(お試しの AI)'}`);
  renderTimeline(entry, nameOf);
  // プロンプトの全文と道具の入出力は、仕組みの引き出しへ(頼んだら)
  const more = element('button', 'プロンプトと道具の中身を見る(仕組みを見る)', 'quiet turn-more');
  more.type = 'button';
  more.addEventListener('click', () => {
    setDrawer('mechanism');
    $('trace-heading')?.scrollIntoView({ block: 'start' });
  });
  body.replaceChildren(head, facts, element('p', '全部の中身(引数、プロンプトの部品、理由)は、「仕組みを見る」の「AI の実行の記録」にあります。', 'muted'), more);
}

function renderTrace() {
  renderTurnRecord();
  const { session } = ai;
  if (!session) {
    els.aiTrace.replaceChildren(element('p', 'プロダクト内 AI を使う試作品を開くと、ここに出ます。', 'muted'));
    return;
  }
  const current = ai.choices?.options.find((o) => o.kind === session.connection.kind);
  const nodes = [
    labeled('今の接続', connectionNote({ label: session.connection.label, real: Boolean(current?.billing) })),
    labeled('AI が使えるツール', current?.tools ?? '不明'),
    labeled('試作品から AI への操作', '会話を読む、発言を送る、状態を直す。接続の切り替えと応答を「止める」は Studio の画面だけでできます。'),
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
  els.frameHost.replaceChildren(element('p', text, 'placeholder'), commentLayer);
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
  els.frameHost.replaceChildren(iframe, commentLayer);
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
    addEvent('warning', '試作品が何度も別のページへ移動しようとしたので、止めました。「仕組みを見る」の「画面を読み込み直す」で最初から開けます。');
    showPlaceholder('試作品を止めました。「仕組みを見る」で、試作品からの知らせを見てください。');
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

// 表示のメニュー(ui-ux-v2.md の 2.2)。<html> の data-theme、data-motion、data-room を変え、studio.css のトークンが切り替わる。
// 選んだものはこのブラウザ(localStorage)が覚える。Studio の外には送らない
const DISPLAY_KEY = 'prototype-studio-display';
const DISPLAY_DEFAULT = { theme: 'system', motion: 'on', room: 'off' };
const displayButton = $('display-button');
const displayMenu = $('display-menu');
const displayThemes = [...displayMenu.querySelectorAll('input[name="display-theme"]')];
const displayMotionOff = $('display-motion-off');
const displayRoom = $('display-room');

function readDisplay() {
  try {
    const saved = JSON.parse(localStorage.getItem(DISPLAY_KEY) ?? '{}');
    return {
      theme: ['light', 'dark', 'system'].includes(saved.theme) ? saved.theme : DISPLAY_DEFAULT.theme,
      motion: saved.motion === 'off' ? 'off' : 'on',
      room: saved.room === 'on' ? 'on' : 'off',
    };
  } catch {
    return { ...DISPLAY_DEFAULT };
  }
}

function applyDisplay(display) {
  const root = document.documentElement;
  if (display.theme === 'system') delete root.dataset.theme;
  else root.dataset.theme = display.theme;
  if (display.motion === 'off') root.dataset.motion = 'off';
  else delete root.dataset.motion;
  if (display.room === 'on') root.dataset.room = 'on';
  else delete root.dataset.room;
  for (const input of displayThemes) input.checked = input.value === display.theme;
  displayMotionOff.checked = display.motion === 'off';
  displayRoom.checked = display.room === 'on';
}

function changeDisplay() {
  const display = {
    theme: displayThemes.find((input) => input.checked)?.value ?? DISPLAY_DEFAULT.theme,
    motion: displayMotionOff.checked ? 'off' : 'on',
    room: displayRoom.checked ? 'on' : 'off',
  };
  applyDisplay(display);
  try {
    localStorage.setItem(DISPLAY_KEY, JSON.stringify(display));
  } catch {
    // 覚えられなくても、今の画面には効いている
  }
}

function setDisplayMenu(open) {
  displayMenu.hidden = !open;
  displayButton.setAttribute('aria-expanded', String(open));
}

applyDisplay(readDisplay());
displayMenu.addEventListener('change', changeDisplay);
displayButton.addEventListener('click', () => setDisplayMenu(displayMenu.hidden));

els.aiSwitch.addEventListener('click', () => setAiMenu(els.aiMenu.hidden));

els.realAiTry.addEventListener('click', () => toggleRealAiInfo('try'));
els.realAiMake.addEventListener('click', () => toggleRealAiInfo('make'));

// 一覧の外を押したら閉じる。試作品の iframe を押したときは、この画面から焦点が外れるので、それでも閉じる。
// 押した要素が描き直しで外れても(版の一覧の「この状態に戻す」など)、押した時の道筋で中か外かを決める
const projectSwitch = document.querySelector('.project-switch');
const displaySwitch = document.querySelector('.display-switch');
document.addEventListener('click', (event) => {
  const path = event.composedPath();
  if (!els.projectMenu.hidden && !path.includes(projectSwitch)) setProjectMenu(false);
  if (!displayMenu.hidden && !path.includes(displaySwitch)) setDisplayMenu(false);
});
window.addEventListener('blur', () => {
  setProjectMenu(false);
  setDisplayMenu(false);
});

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  if (!els.projectMenu.hidden) {
    setProjectMenu(false);
    els.projectMenuButton.focus();
  } else if (!displayMenu.hidden) {
    setDisplayMenu(false);
    displayButton.focus();
  } else if (!els.aiMenu.hidden) {
    setAiMenu(false);
    els.aiSwitch.focus();
  } else if (!els.stageList.hidden && frame.compactOpen) {
    setCompact(false);
    els.stageCompact.focus();
  } else if (frame.drawer) {
    const button = frame.drawer === 'mechanism' ? els.mechanismButton : els.materialsButton;
    setDrawer(null);
    button.focus();
  }
});

els.saveNow.addEventListener('click', () => saveVersion());
els.showStart.addEventListener('click', () => startShow());
els.showForm.addEventListener('submit', (event) => {
  event.preventDefault();
  saveShowAnswers();
});
els.showEnd.addEventListener('click', () => endShow());
els.commentForm.addEventListener('submit', (event) => {
  event.preventDefault();
  addComment();
});
els.commentPlace.addEventListener('click', () => setPicking(!commentsUi.picking));
els.commentResume.addEventListener('click', () => resumeComments());
commentLayer.addEventListener('click', (event) => pickPlace(event));
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && commentsUi.picking) setPicking(false);
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

// 同じ名前のファイルを直して選び直しても、change が起きるようにする
els.tokensFile.addEventListener('click', () => {
  els.tokensFile.value = '';
});
els.tokensFile.addEventListener('change', () => {
  const file = els.tokensFile.files?.[0];
  if (file) checkTokenFile(file);
});
els.tokensSource.addEventListener('input', () => renderTokens(selectedProject()));
els.tokensForm.addEventListener('submit', (event) => {
  event.preventDefault();
  connectTokens();
});
els.handoffForm.addEventListener('submit', (event) => {
  event.preventDefault();
  exportHandoff();
});
for (const field of [els.guidesSource, els.guidesLicense, els.guidesLicenseName]) {
  field.addEventListener('input', () => renderGuides(selectedProject()));
  field.addEventListener('change', () => renderGuides(selectedProject()));
}
for (const radio of els.guidesAsk.querySelectorAll('input[name="guides-have"]')) radio.addEventListener('change', () => renderGuides(selectedProject()));
els.guidesAsk.addEventListener('submit', (event) => {
  event.preventDefault();
  submitGuideAsk();
});
for (const input of [els.guidesFiles, els.guidesFolder, els.guidesPackage]) {
  input.addEventListener('change', () => {
    if (input.files?.length > 0) checkGuideFiles([...input.files]);
  });
}
els.guidesCheckBack.addEventListener('click', () => guidesStep(1));
els.guidesCheckNext.addEventListener('click', () => guidesStep(3));
els.guidesTryBack.addEventListener('click', () => guidesStep(2));
els.guidesTryNext.addEventListener('click', () => guidesStep(4));
els.guidesEnableBack.addEventListener('click', () => guidesStep(3));
els.guidesEnableForm.addEventListener('submit', (event) => {
  event.preventDefault();
  enableGuides();
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

// 目的の聞き出しと目的の文書(user-journey.md の段 1、段 2、J1)。サーバーは src/server/intent.js。
// 外から来た文字(1 文、問い、答え)は、ほかと同じく textContent と value でだけ出す
const INTENT_MARKS = { none: '目的なし', skipped: '目的なし', interviewing: '目的: 下書き', draft: '目的: 下書き', decided: '目的: 決めた' };
const INTENT_EXAMPLES = ['商店街のお店への問い合わせに、AI が答えられるようにしたい', '小さな図書室で、読みたい本を探す手伝いをしたい', '習い事の教室の予約の問い合わせを減らしたい'];
const INTENT_LIST_FIELDS = ['notDoing', 'undecided'];
const INTENT_TEXT_FIELDS = ['who', 'problem', 'scene', 'success'];
// 作る AI の欄の上限(index.html の request-text の maxlength)
const MAX_REQUEST_TEXT = 4000;
const intentEls = {
  section: $('intent'),
  heading: $('intent-heading'),
  start: $('intent-start'),
  lead: $('intent-lead'),
  sentence: $('intent-sentence'),
  examples: $('intent-examples'),
  fixedNote: $('intent-fixed-note'),
  consent: $('intent-consent'),
  declined: $('intent-declined'),
  send: $('intent-send'),
  talk: $('intent-talk'),
  talkSentence: $('intent-talk-sentence'),
  turns: $('intent-turns'),
  waiting: $('intent-waiting'),
  asking: $('intent-asking'),
  progress: $('intent-progress'),
  question: $('intent-question'),
  reason: $('intent-reason'),
  answer: $('intent-answer'),
  doc: $('intent-doc'),
  docState: $('intent-doc-state'),
  decide: $('intent-decide'),
  begin: $('intent-begin'),
  reopen: $('intent-reopen'),
  back: $('intent-back'),
  docSkip: $('intent-doc-skip'),
  trailHead: $('intent-trail-head'),
  trail: $('intent-trail'),
  note: $('intent-note'),
  error: $('intent-error'),
  mark: $('intent-mark'),
};
const intentDocField = (field) => $(`intent-doc-${field}`);

function renderIntentMark(project) {
  const status = project?.intent?.status ?? 'none';
  // はじめの画面で新しく作るときは、選んでいる試作品の印を出さない(これから作るものの印に見えるため)
  intentEls.mark.hidden = !project || (intentUi.view === 'start' && !intentUi.projectId);
  intentEls.mark.textContent = INTENT_MARKS[status] ?? INTENT_MARKS.none;
  intentEls.mark.dataset.state = status === 'decided' ? 'decided' : status === 'draft' || status === 'interviewing' ? 'draft' : 'none';
  renderOrganizeMark(project);
  renderMeetingMark(project);
  renderDesignMark(project);
  renderReviewMark(project);
}

function intentError(text) {
  intentEls.error.hidden = !text;
  intentEls.error.textContent = text ?? '';
}

function renderIntentConsent() {
  const card = consent.card?.use === 'intent' ? consent.card : null;
  intentEls.consent.replaceChildren(...(card ? [consentCard(card.view, { card })] : []));
  intentEls.declined.hidden = !intentUi.declined || Boolean(card);
}

function turnItems(turns) {
  return turns.map((turn) => {
    const li = element('li', turn.question);
    li.append(element('span', turn.unknown ? '分からない(決めていないことに入れました)' : turn.answer, 'intent-answer-text'));
    return li;
  });
}

function renderIntentDocState(record) {
  const decided = record.status === 'decided';
  intentEls.docState.dataset.state = record.status;
  if (decided) intentEls.docState.textContent = `${formatTime(record.decidedAt)}に決めました。この目的で、設計に進みますか。`;
  else if (record.status === 'skipped') intentEls.docState.textContent = `${formatTime(record.skippedAt)}に飛ばしました。「目的なし」のまま進めています。決めるときは、中身を確かめて「これで決める」を押してください。`;
  else intentEls.docState.textContent = '答えから下書きを作りました。まだ決めていません。違うところを直してから、「これで決める」を押しますか。';
  intentEls.decide.hidden = decided;
  intentEls.docSkip.hidden = decided || record.status === 'skipped';
  intentEls.begin.hidden = !decided;
  $('intent-design').hidden = !decided;
  intentEls.reopen.hidden = !decided;
  for (const field of [...INTENT_TEXT_FIELDS, ...INTENT_LIST_FIELDS]) intentDocField(field).readOnly = decided;
}

// 文書の欄を、サーバーの文書で埋める。書いている途中の文を上書きしないよう、文書の画面に入るときと、決めた後だけ呼ぶ
function fillIntentDoc(doc) {
  for (const field of INTENT_TEXT_FIELDS) intentDocField(field).value = doc[field] ?? '';
  for (const field of INTENT_LIST_FIELDS) intentDocField(field).value = (doc[field] ?? []).join('\n');
}

function readIntentDoc() {
  const doc = {};
  for (const field of INTENT_TEXT_FIELDS) doc[field] = intentDocField(field).value.trim();
  for (const field of INTENT_LIST_FIELDS) doc[field] = intentDocField(field).value.split('\n').map((line) => line.trim()).filter(Boolean);
  return doc;
}

function renderIntent() {
  scheduleFrame();
  const { view, record, waiting } = intentUi;
  intentEls.section.hidden = !view;
  if (view) document.body.dataset.intent = view;
  else delete document.body.dataset.intent;
  intentEls.start.hidden = view !== 'start';
  intentEls.talk.hidden = view !== 'talk';
  intentEls.doc.hidden = view !== 'doc';
  intentEls.note.hidden = !record?.note || view === 'start';
  intentEls.note.textContent = record?.note ?? '';
  renderIntentMark(selectedProject());
  if (view === 'start') {
    intentEls.heading.textContent = 'どんなものを作りたいですか';
    const project = intentUi.projectId ? selectedProject() : null;
    // はじめて(5.4)。試作品がまだないときは、何が起きたか、今どうなっているか、次に何をするかの 3 つの文と「─」の印
    if (project) clearState(intentEls.lead, `「${project.title}」の目的を聞き出します。1 文で書いてください。`);
    else fillState(intentEls.lead, 'first', { none: projects.length === 0 });
    intentEls.fixedNote.hidden = Boolean(agent?.ready) || intentUi.guide === 'fixed';
    intentEls.send.disabled = intentUi.sending;
    renderIntentConsent();
  } else if (view === 'talk') {
    intentEls.heading.textContent = '目的を聞いています';
    intentEls.talkSentence.textContent = record?.sentence ?? intentEls.sentence.value.trim();
    intentEls.turns.replaceChildren(...turnItems(record?.turns ?? []));
    intentEls.waiting.hidden = !waiting;
    intentEls.asking.hidden = waiting || !record?.pending;
    if (record?.pending) {
      intentEls.progress.textContent = `問い ${record.turns.length + 1} / 多くて ${record.limit}(案内の深さ: ${record.depthLabel})`;
      intentEls.question.textContent = record.pending.question;
      intentEls.reason.textContent = record.pending.reason;
    }
  } else if (view === 'doc') {
    intentEls.heading.textContent = '目的の文書';
    renderIntentDocState(record);
    intentEls.trailHead.textContent = record.depthLabel ? `最初の 1 文: ${record.sentence}(案内の深さ: ${record.depthLabel})` : `最初の 1 文: ${record.sentence}`;
    intentEls.trail.replaceChildren(...turnItems(record.turns ?? []));
  }
}

function openStart(projectId, sentence = '') {
  intentUi.view = 'start';
  intentUi.projectId = projectId;
  intentUi.record = null;
  intentUi.guide = 'ai';
  intentUi.declined = false;
  intentEls.sentence.value = sentence;
  intentError(null);
  renderIntent();
  intentEls.sentence.focus();
}

// 別の画面へ移る。書いた文書は下書きとして残す
function leaveIntent() {
  if (intentUi.view === 'doc' && intentUi.record?.status === 'draft') {
    api(intentPath(intentUi.projectId, 'edit'), { method: 'POST', json: { doc: readIntentDoc() } }).catch(handleError);
  }
  closeIntent();
}

function closeIntent() {
  intentUi.seq += 1;
  if (!intentUi.view) return;
  if (consent.card?.use === 'intent') consent.card = null;
  intentUi.view = null;
  intentUi.record = null;
  intentUi.waiting = false;
  intentUi.declined = false;
  intentError(null);
  renderIntent();
}

// サーバーの状態を画面にする。聞いている間は会話、終わったら文書
function showIntent(record) {
  const entering = intentUi.view !== 'doc';
  intentUi.record = record;
  intentUi.waiting = false;
  intentUi.view = record.status === 'interviewing' ? 'talk' : 'doc';
  if (intentUi.view === 'doc' && entering) fillIntentDoc(record.doc);
  renderIntent();
  if (intentUi.view === 'talk') {
    // 問いが変わったときだけ、答えの欄を空にする(開き直しで、書いている途中の文を消さない)
    if (record.pending?.question !== intentUi.shownQuestion) intentEls.answer.value = '';
    intentUi.shownQuestion = record.pending?.question ?? null;
    intentEls.answer.focus();
  } else if (entering) {
    intentEls.heading.focus();
  }
}

async function refreshAfterIntent() {
  // 作ったばかりの試作品を読む前の一覧で、選び直されていても、聞き出している試作品に戻す
  if (intentUi.view && intentUi.projectId) selectedId = intentUi.projectId;
  lastSnapshot = '';
  await refresh();
}

const intentPath = (id, action = '') => `/api/projects/${encodeURIComponent(id)}/intent${action ? `/${action}` : ''}`;

function intentFailed(error) {
  if (error instanceof ApiError && !['offline', 'token'].includes(error.code)) intentError(`進められませんでした: ${error.message}`);
  else handleError(error);
}

// 同意のカードを出す。別のタブで同意していたら、そのまま送る
async function openIntentConsent() {
  const view = await api('/api/real-ai');
  setConsentState(view.consent);
  if (view.consent.agreed) return sendSentence();
  openConsentDetails.delete('card');
  consent.card = { use: 'intent', projectId: null, view };
  renderIntentConsent();
}

// 1 文を送る。新しく作るときは試作品を作ってから聞き出しを始める。同意の前は、サーバーが断る
async function sendSentence() {
  const sentence = intentEls.sentence.value.trim();
  if (!sentence) {
    intentError('作りたいものを 1 文で書いてください。');
    intentEls.sentence.focus();
    return;
  }
  if (intentUi.sending) return;
  intentError(null);
  intentUi.sending = true;
  intentUi.declined = false;
  renderIntent();
  const depth = intentEls.start.querySelector('input[name="intent-depth"]:checked')?.value ?? 'normal';
  const guide = intentUi.guide;
  let id = intentUi.projectId;
  try {
    if (!id) {
      const { project } = await api('/api/projects', { method: 'POST', json: { sentence, guide } });
      id = project.id;
      intentUi.projectId = id;
      selectedId = id;
    }
    intentUi.view = 'talk';
    intentUi.waiting = true;
    renderIntent();
    await refreshAfterIntent();
    const { intent } = await api(intentPath(id, 'start'), { method: 'POST', json: { sentence, depth, guide } });
    if (intentUi.projectId === id && intentUi.view) showIntent(intent);
  } catch (error) {
    intentUi.view = intentUi.view ? 'start' : null;
    intentUi.waiting = false;
    if (error instanceof ApiError && error.code === 'consent-required') {
      intentUi.sending = false;
      renderIntent();
      await openIntentConsent();
      return;
    }
    intentFailed(error);
  } finally {
    intentUi.sending = false;
    renderIntent();
  }
  await refreshAfterIntent();
}

// 答える。text が null なら「分からない」
async function sendAnswer(text) {
  const id = intentUi.projectId;
  if (!id || intentUi.waiting) return;
  if (text !== null && !text.trim()) {
    intentError('答えを書くか、「分からない」を押してください。');
    intentEls.answer.focus();
    return;
  }
  intentError(null);
  intentUi.waiting = true;
  renderIntent();
  try {
    const turn = intentUi.record?.turns?.length;
    const { intent } = await api(intentPath(id, 'answer'), { method: 'POST', json: text === null ? { unknown: true, turn } : { answer: text, turn } });
    if (intentUi.projectId === id && intentUi.view) showIntent(intent);
  } catch (error) {
    intentUi.waiting = false;
    renderIntent();
    intentFailed(error);
    // 別の画面で問いが進んでいたら、今の問いを読み直す(答えの文は欄に残る)
    if (error instanceof ApiError && ['stale-question', 'not-asking'].includes(error.code)) await reloadIntent(id);
  }
  await refreshAfterIntent();
}

// 打ち切り、決める、直す、飛ばす。どれも 1 回の POST で、返った状態を出す
async function intentAction(action, body = {}) {
  const id = intentUi.projectId;
  if (!id) return null;
  intentError(null);
  try {
    const { intent } = await api(intentPath(id, action), { method: 'POST', json: body });
    await refreshAfterIntent();
    return intent;
  } catch (error) {
    intentFailed(error);
    return null;
  }
}

// はじめの画面の「飛ばす」。1 文があれば新しい試作品を作って「目的なし」を残す。なければ、はじめの画面を閉じるだけ(サンプルで試せる)
async function skipFromStart() {
  if (intentUi.sending) return;
  const sentence = intentEls.sentence.value.trim();
  intentError(null);
  intentUi.sending = true;
  try {
    let id = intentUi.projectId;
    if (!id && sentence) {
      const { project } = await api('/api/projects', { method: 'POST', json: { sentence, guide: 'fixed' } });
      id = project.id;
      selectedId = id;
    }
    if (id) await api(intentPath(id, 'skip'), { method: 'POST', json: { sentence } });
    await api('/api/start', { method: 'POST' });
    // 新しい試作品が一覧に載ってから閉じる(印と 2 列が、その試作品を指すように)
    if (id) selectedId = id;
    await refreshAfterIntent();
    closeIntent();
  } catch (error) {
    intentFailed(error);
  } finally {
    intentUi.sending = false;
  }
}

// サーバーの今の状態を読み直して出す。問いを考えている最中なら、終わるまで待つ(読み込み直した後に、古い問いへ答えないように)
async function reloadIntent(id) {
  const seq = ++intentUi.seq;
  const { intent } = await api(intentPath(id));
  if (seq !== intentUi.seq) return;
  if (intent.thinking) {
    intentUi.record = intent;
    intentUi.view = 'talk';
    intentUi.waiting = true;
    renderIntent();
    setTimeout(() => {
      if (seq === intentUi.seq) reloadIntent(id).catch(handleError);
    }, 1000);
    return;
  }
  showIntent(intent);
  await refreshAfterIntent();
}

// 上の帯の印を押す。文書がなければはじめの画面、聞いている間は会話、それ以外は文書。
// その試作品の聞き出しか文書を出しているときは、何もしない(書いている途中の文を上書きしない)
async function openIntentFromMark() {
  const project = selectedProject();
  if (!project || (intentUi.view && intentUi.projectId === project.id)) return;
  if (project.meeting?.status === 'waiting') return openMeeting(project.id);
  closeOrganize();
  closeDesign();
  closeReview();
  closeMeeting();
  try {
    const { intent } = await api(intentPath(project.id));
    if (intent.thinking) {
      intentUi.projectId = project.id;
      intentError(null);
      await reloadIntent(project.id);
      return;
    }
    if (intent.status === 'none' || (intent.status === 'skipped' && (intent.turns ?? []).length === 0)) {
      openStart(project.id, intent.sentence ?? '');
      return;
    }
    intentUi.projectId = project.id;
    intentUi.guide = intent.guide ?? 'ai';
    intentUi.view = null;
    intentError(null);
    showIntent(intent);
  } catch (error) {
    handleError(error);
  }
}

// 決めた目的を、作る AI の欄の依頼に入れる。送るのは人(同意もここでは取らない)
function intentRequestText(doc) {
  const lines = ['次の目的で試作品を作ってください。'];
  const labels = { who: '誰', problem: '何の問題', scene: '場面', success: '成功の印' };
  for (const field of INTENT_TEXT_FIELDS) if (doc[field]) lines.push(`${labels[field]}: ${doc[field]}`);
  if (doc.notDoing?.length > 0) lines.push(`しないこと: ${doc.notDoing.join('、')}`);
  if (doc.undecided?.length > 0) lines.push(`決めていないこと: ${doc.undecided.join('、')}`);
  // 文書が長いときは、欄の上限で切る。送る前に人が見られる
  const text = lines.join('\n');
  return text.length > MAX_REQUEST_TEXT ? `${text.slice(0, MAX_REQUEST_TEXT - 1)}…` : text;
}

intentEls.examples.replaceChildren(
  ...INTENT_EXAMPLES.map((text) => {
    const li = element('li');
    const button = element('button', text);
    button.type = 'button';
    button.addEventListener('click', () => {
      intentEls.sentence.value = text;
      intentEls.sentence.focus();
    });
    li.append(button);
    return li;
  }),
);
intentEls.mark.addEventListener('click', openIntentFromMark);
$('new-project').addEventListener('click', () => {
  setProjectMenu(false);
  leaveIntent();
  closeOrganize();
  closeDesign();
  closeReview();
  closeMeeting();
  openStart(null);
});
intentEls.start.addEventListener('submit', (event) => {
  event.preventDefault();
  sendSentence();
});
$('intent-skip').addEventListener('click', skipFromStart);
$('intent-use-fixed').addEventListener('click', () => {
  intentUi.guide = 'fixed';
  sendSentence();
});
intentEls.talk.addEventListener('submit', (event) => {
  event.preventDefault();
  sendAnswer(intentEls.answer.value);
});
$('intent-unknown').addEventListener('click', () => sendAnswer(null));
$('intent-stop').addEventListener('click', () => {
  if (intentUi.projectId) api(intentPath(intentUi.projectId, 'cancel'), { method: 'POST' }).catch(intentFailed);
});
$('intent-finish').addEventListener('click', async () => {
  const intent = await intentAction('finish');
  if (intent) showIntent(intent);
});
async function skipFromIntent() {
  const intent = await intentAction('skip');
  if (intent) closeIntent();
}
$('intent-talk-skip').addEventListener('click', skipFromIntent);
intentEls.docSkip.addEventListener('click', skipFromIntent);
intentEls.doc.addEventListener('submit', async (event) => {
  event.preventDefault();
  const intent = await intentAction('decide', { doc: readIntentDoc() });
  if (!intent) return;
  // 決めるときに足した「書いていません」の行を、欄に出す
  fillIntentDoc(intent.doc);
  showIntent(intent);
  $('intent-design').focus();
});
// 決めた後に直す。「決めた」の印を外し、もう一度押すまで付かない
intentEls.reopen.addEventListener('click', async () => {
  const intent = await intentAction('edit', { doc: readIntentDoc() });
  if (intent) showIntent(intent);
});
intentEls.back.addEventListener('click', async () => {
  // 決める前に書いた分は残す。決めた後と飛ばした後の印は変えない
  if (intentUi.record?.status === 'draft' && !(await intentAction('edit', { doc: readIntentDoc() }))) return;
  closeIntent();
});
intentEls.begin.addEventListener('click', () => {
  const text = intentRequestText(intentUi.record.doc);
  closeIntent();
  fillRequest(text);
});
$('intent-design').addEventListener('click', () => openDesign());

// ヒアリングの整理(user-journey.md の K1、field-session.md の段 1、段 2)。サーバーは src/server/organize.js。
// 要点と項目は外から来た文字なので、ほかと同じく textContent と value でだけ出す。
// board はサーバーの板。waiting はこの画面の「整理する」の応答を待っている間。editing は直している項目の ID で、editDraft はその書きかけ(板を読み直しても消さない)
const ORGANIZE_COLUMNS = { requirement: '要求', user: '使う人', scene: '場面', rule: '決まりごと', data: 'データ' };
const ORGANIZE_MARKS = { none: 'ヒアリングの整理', draft: '整理: 下書き', confirmed: '整理: 確かめた' };
const ORGANIZE_ASK_KINDS = { conflict: '矛盾', unasked: '聞いていない', guess: '推測', empty: '聞いていない' };
const organizeUi = { open: false, projectId: null, board: null, waiting: false, declined: false, editing: null, editDraft: null, inputsFor: null, seq: 0, timer: null };
const organizeEls = {
  section: $('organize'),
  heading: $('organize-heading'),
  state: $('organize-state'),
  confirm: $('organize-confirm'),
  note: $('organize-note'),
  error: $('organize-error'),
  pointForm: $('organize-point-form'),
  point: $('organize-point'),
  points: $('organize-points'),
  run: $('organize-run'),
  waiting: $('organize-waiting'),
  noAi: $('organize-no-ai'),
  consent: $('organize-consent'),
  declined: $('organize-declined'),
  columns: $('organize-columns'),
  guess: $('organize-guess'),
  addForm: $('organize-add-form'),
  addColumn: $('organize-add-column'),
  addText: $('organize-add-text'),
  asks: $('organize-asks'),
  mark: $('organize-mark'),
};
const organizePath = (id, action = '') => `/api/projects/${encodeURIComponent(id)}/organize${action ? `/${action}` : ''}`;

function renderOrganizeMark(project) {
  const status = project?.organize?.status ?? 'none';
  organizeEls.mark.hidden = !project || (intentUi.view === 'start' && !intentUi.projectId);
  organizeEls.mark.textContent = ORGANIZE_MARKS[status] ?? ORGANIZE_MARKS.none;
  organizeEls.mark.dataset.state = status === 'confirmed' ? 'decided' : status === 'draft' ? 'draft' : 'none';
}

function organizeError(text) {
  organizeEls.error.hidden = !text;
  organizeEls.error.textContent = text ?? '';
}

function organizeFailed(error) {
  // 記録らしいものの知らせは、断った理由そのもの
  if (error instanceof ApiError && error.code === 'record') organizeError(error.message);
  else if (error instanceof ApiError && !['offline', 'token'].includes(error.code)) organizeError(`進められませんでした: ${error.message}`);
  else handleError(error);
}

function renderOrganizeConsent() {
  const card = consent.card?.use === 'organize' ? consent.card : null;
  organizeEls.consent.replaceChildren(...(card ? [consentCard(card.view, { card })] : []));
  organizeEls.declined.hidden = !organizeUi.declined || Boolean(card);
}

function smallButton(text, onClick) {
  const button = element('button', text);
  button.type = 'button';
  button.addEventListener('click', onClick);
  return button;
}

function columnOptions(select) {
  select.append(...Object.entries(ORGANIZE_COLUMNS).map(([value, label]) => {
    const option = element('option', label);
    option.value = value;
    return option;
  }));
}

function organizePointItem(point) {
  const li = element('li');
  const head = element('div', undefined, 'organize-point-head');
  head.append(element('span', `${point.n}. ${point.text}`), smallButton('消す', () => organizeAct('point-remove', { n: point.n })));
  li.append(head);
  if (!point.placed) {
    // AI が落とした要点と、まだ整理していない要点。手で振り分ける道にもなる
    const row = element('div', undefined, 'organize-unplaced');
    const select = element('select');
    select.setAttribute('aria-label', `要点 ${point.n} を入れる欄`);
    const blank = element('option', '欄を選ぶ');
    blank.value = '';
    select.append(blank);
    columnOptions(select);
    select.addEventListener('change', () => {
      if (select.value) organizeAct('place', { n: point.n, column: select.value });
    });
    row.append(element('span', 'まだどの欄にもありません'), select);
    li.append(row);
  }
  return li;
}

function organizeEditForm(item) {
  const form = element('form', undefined, 'organize-edit');
  const text = element('textarea');
  text.rows = 2;
  text.maxLength = 300;
  text.value = organizeUi.editDraft?.text ?? item.text;
  text.setAttribute('aria-label', '項目の文');
  text.addEventListener('input', () => {
    organizeUi.editDraft = { text: text.value, column: select.value };
  });
  const select = element('select');
  select.setAttribute('aria-label', '項目の欄');
  columnOptions(select);
  select.value = organizeUi.editDraft?.column ?? item.column;
  select.addEventListener('change', () => {
    organizeUi.editDraft = { text: text.value, column: select.value };
  });
  const save = element('button', '保存する');
  save.type = 'submit';
  const buttons = element('div', undefined, 'organize-item-actions');
  buttons.append(save, smallButton('やめる', () => {
    organizeUi.editing = null;
    organizeUi.editDraft = null;
    renderOrganize();
  }));
  form.append(text, select, buttons);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    // 保存できるまで、書きかけを残す
    organizeUi.editDraft = { text: text.value, column: select.value };
    if (!(await organizeAct('item-edit', { id: item.id, text: text.value, column: select.value }))) return;
    organizeUi.editing = null;
    organizeUi.editDraft = null;
    renderOrganize();
  });
  return form;
}

function organizeItemNode(item, pointText) {
  const li = element('li', undefined, 'organize-item');
  li.dataset.guess = String(item.guess);
  if (organizeUi.editing === item.id) {
    li.append(organizeEditForm(item));
    return li;
  }
  li.append(element('p', item.text, 'organize-item-text'));
  if (item.guess) {
    const badge = element('span', '推測', 'organize-badge');
    badge.dataset.kind = 'guess';
    li.append(badge, element('p', '話に出ていません。', 'organize-source'));
  } else if (item.sources.length === 0) {
    li.append(element('span', '人が確かめた', 'organize-badge'));
  }
  for (const n of item.sources) li.append(element('p', `元の要点 ${n}: ${pointText.get(n) ?? ''}`, 'organize-source'));
  const buttons = element('div', undefined, 'organize-item-actions');
  if (item.guess) buttons.append(smallButton('この項目は合っている', () => organizeAct('item-check', { id: item.id })));
  buttons.append(
    smallButton('直す', () => {
      organizeUi.editing = item.id;
      organizeUi.editDraft = null;
      renderOrganize();
    }),
    smallButton('消す', () => organizeAct('item-remove', { id: item.id })),
  );
  li.append(buttons);
  return li;
}

function organizeAskItem(ask) {
  const li = element('li');
  const badge = element('span', ORGANIZE_ASK_KINDS[ask.kind] ?? ask.kind, 'organize-badge');
  badge.dataset.kind = ask.kind;
  const head = element('div', undefined, 'organize-point-head');
  const body = element('span');
  body.append(badge, ` ${ask.text}`);
  if (ask.sources.length > 0) body.append(`(要点 ${ask.sources.join('、')})`);
  head.append(body);
  // 推測と空の欄は Studio が出す。元を直すと消える
  if (ask.kind === 'conflict' || ask.kind === 'unasked') head.append(smallButton('消す', () => organizeAct('ask-remove', { id: ask.id })));
  li.append(head);
  return li;
}

function organizeStateText(board) {
  const guesses = board.items.filter((item) => item.guess).length;
  const counts = `要点 ${board.points.length} 個、項目 ${board.items.length} 個、推測 ${guesses} 個、聞くこと ${board.asks.length} 個。`;
  if (board.status === 'confirmed') return `${formatTime(board.confirmedAt)}に、決める人が確かめました。板を変えると、この印は外れます。${counts}`;
  if (board.items.length === 0) return 'まだ整理していません。板は空です。聞いた要点を打ってから、「整理する」を押しますか。';
  return `板を整理しました。${counts}まだ確かめていません。違う項目を直し、推測を確かめてから、決める人が読んで押しますか。`;
}

function renderOrganize() {
  scheduleFrame();
  const { open, board, waiting } = organizeUi;
  organizeEls.section.hidden = !open;
  if (open) document.body.dataset.organize = 'open';
  else delete document.body.dataset.organize;
  renderOrganizeConsent();
  if (!open) return;
  if (!board) {
    // 読み込みの間は、前に開いていた試作品の板を見せない(読んでいない板を押したり消したりしないように)
    organizeEls.state.textContent = '読み込んでいます…';
    organizeEls.confirm.disabled = true;
    organizeEls.run.disabled = true;
    organizeEls.waiting.hidden = true;
    for (const list of [organizeEls.points, organizeEls.columns, organizeEls.asks]) list.replaceChildren();
    organizeEls.guess.hidden = true;
    return;
  }
  const guesses = board.items.filter((item) => item.guess).length;
  organizeEls.guess.hidden = guesses === 0;
  if (guesses > 0) fillState(organizeEls.guess, 'guess', { count: guesses });
  const thinking = waiting || board.thinking;
  organizeEls.state.textContent = organizeStateText(board);
  organizeEls.state.dataset.state = board.status === 'confirmed' ? 'decided' : 'draft';
  organizeEls.note.hidden = !board.note;
  organizeEls.note.textContent = board.note ?? '';
  organizeEls.confirm.disabled = thinking || board.items.length === 0 || board.status === 'confirmed';
  $('organize-design').hidden = board.status !== 'confirmed';
  organizeEls.run.hidden = thinking;
  organizeEls.run.disabled = !board.ai || board.points.length === 0;
  organizeEls.waiting.hidden = !thinking;
  organizeEls.noAi.hidden = Boolean(board.ai);
  organizeEls.points.replaceChildren(...board.points.map(organizePointItem));
  const pointText = new Map(board.points.map((point) => [point.n, point.text]));
  organizeEls.columns.replaceChildren(...Object.entries(ORGANIZE_COLUMNS).map(([column, label]) => {
    const box = element('section', undefined, 'organize-column');
    box.setAttribute('aria-label', label);
    box.dataset.column = column;
    const list = element('ul', undefined, 'organize-list');
    list.append(...board.items.filter((item) => item.column === column).map((item) => organizeItemNode(item, pointText)));
    box.append(element('h4', label), list);
    return box;
  }));
  organizeEls.asks.replaceChildren(...board.asks.map(organizeAskItem));
}

// サーバーの板を出す。後から来た応答が古ければ捨てる(AI を待つ間も要点を足せるので、順が入れ替わることがある)
function applyBoard(board) {
  const shown = organizeUi.board;
  if (shown && board.rev < shown.rev) return;
  // 待つ間の読み直しで何も変わっていなければ、書き直さない(書いている欄の入力と開いた選択を崩さない)
  if (shown && board.rev === shown.rev && board.thinking === shown.thinking && board.ai === shown.ai) {
    scheduleOrganizePoll();
    return;
  }
  organizeUi.board = board;
  // 直している項目が整理し直しで入れ替わったら、編集を閉じる。書きかけの文は失わないよう、知らせに出す
  if (organizeUi.editing && !board.items.some((item) => item.id === organizeUi.editing)) {
    organizeError(organizeUi.editDraft ? `直している間に整理し直したので、閉じました。書きかけ: ${organizeUi.editDraft.text}` : null);
    organizeUi.editing = null;
    organizeUi.editDraft = null;
  }
  renderOrganize();
  scheduleOrganizePoll();
}

// 別の画面か読み込み直しの前に押した整理を待つ間は、板を読み直す
function scheduleOrganizePoll() {
  clearTimeout(organizeUi.timer);
  if (!organizeUi.open || organizeUi.waiting || !organizeUi.board?.thinking) return;
  const { seq, projectId } = organizeUi;
  organizeUi.timer = setTimeout(async () => {
    try {
      const { organize } = await api(organizePath(projectId));
      if (seq === organizeUi.seq) applyBoard(organize);
    } catch (error) {
      if (seq === organizeUi.seq) handleError(error);
    }
    if (seq === organizeUi.seq && !organizeUi.board?.thinking) await refreshOrganizeList();
  }, 1000);
}

async function refreshOrganizeList() {
  if (organizeUi.open) selectedId = organizeUi.projectId;
  lastSnapshot = '';
  await refresh();
}

async function organizeAct(action, body = {}) {
  const id = organizeUi.projectId;
  if (!id) return null;
  organizeError(null);
  const { seq } = organizeUi;
  try {
    const { organize } = await api(organizePath(id, action), { method: 'POST', json: body });
    if (seq === organizeUi.seq) applyBoard(organize);
    await refreshOrganizeList();
    return organize;
  } catch (error) {
    if (seq !== organizeUi.seq) return null;
    organizeUi.refusedRecord = error instanceof ApiError && error.code === 'record';
    organizeFailed(error);
    // 板が変わっていたら、読み直す(古い板を読んだまま押さないように)
    if (error instanceof ApiError && ['stale-board', 'no-item', 'no-point', 'no-ask'].includes(error.code)) {
      const { organize } = await api(organizePath(id));
      if (seq === organizeUi.seq) applyBoard(organize);
    }
    return null;
  }
}

// 「整理する」。1 回押すと 1 回呼ぶ。本物の AI は、同意の前はサーバーが断る
async function runOrganize() {
  const id = organizeUi.projectId;
  if (!id || organizeUi.waiting) return;
  organizeError(null);
  organizeUi.waiting = true;
  organizeUi.declined = false;
  renderOrganize();
  const { seq } = organizeUi;
  try {
    const { organize } = await api(organizePath(id, 'run'), { method: 'POST' });
    if (seq !== organizeUi.seq) return;
    organizeUi.waiting = false;
    applyBoard(organize);
    await refreshOrganizeList();
  } catch (error) {
    if (seq !== organizeUi.seq) return;
    organizeUi.waiting = false;
    renderOrganize();
    if (error instanceof ApiError && error.code === 'consent-required') {
      const view = await api('/api/real-ai');
      if (seq !== organizeUi.seq) return;
      setConsentState(view.consent);
      if (view.consent.agreed) return runOrganize();
      openConsentDetails.delete('card');
      consent.card = { use: 'organize', projectId: null, view };
      renderOrganizeConsent();
      return;
    }
    organizeFailed(error);
  }
}

// 聞き取りの欄と整理の板を開く
async function openOrganize() {
  const project = selectedProject();
  if (!project || (organizeUi.open && organizeUi.projectId === project.id)) return;
  if (project.meeting?.status === 'waiting') return openMeeting(project.id);
  leaveIntent();
  closeDesign();
  closeReview();
  closeMeeting();
  // 別の試作品の板には、前の試作品のために書いた文を持ち込まない
  if (organizeUi.inputsFor !== project.id) {
    organizeEls.point.value = '';
    organizeEls.addText.value = '';
  }
  organizeUi.inputsFor = project.id;
  organizeUi.seq += 1;
  const { seq } = organizeUi;
  organizeUi.open = true;
  organizeUi.projectId = project.id;
  organizeUi.board = null;
  organizeUi.waiting = false;
  organizeUi.declined = false;
  organizeUi.editing = null;
  organizeUi.editDraft = null;
  organizeError(null);
  renderOrganize();
  try {
    const { organize } = await api(organizePath(project.id));
    if (seq !== organizeUi.seq) return;
    applyBoard(organize);
    organizeEls.point.focus();
  } catch (error) {
    if (seq === organizeUi.seq) handleError(error);
  }
}

function closeOrganize() {
  organizeUi.seq += 1;
  clearTimeout(organizeUi.timer);
  if (!organizeUi.open) return;
  if (consent.card?.use === 'organize') consent.card = null;
  organizeUi.open = false;
  organizeUi.board = null;
  organizeUi.projectId = null;
  organizeUi.waiting = false;
  organizeUi.declined = false;
  organizeUi.editing = null;
  organizeUi.editDraft = null;
  organizeError(null);
  renderOrganize();
}

columnOptions(organizeEls.addColumn);
organizeEls.mark.addEventListener('click', openOrganize);
organizeEls.pointForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const text = organizeEls.point.value.trim();
  if (!text) {
    organizeError('聞いた要点を書いてください。');
    return;
  }
  // 打ち続けられるように、応答を待たずに欄を空にする。足せなかったら、文を欄に戻す
  organizeEls.point.value = '';
  organizeEls.point.focus();
  organizeUi.refusedRecord = false;
  if (await organizeAct('point', { text })) {
    sawHint('organize-point');
    return;
  }
  // 次の要点を打ち始めていたら、上書きせず、足せなかった文を知らせに出す(記録らしいものは、もう一度は出さない)
  if (organizeEls.point.value) {
    if (!organizeUi.refusedRecord) organizeError(`足せなかった要点: ${text}`);
  }
  else organizeEls.point.value = text;
});
organizeEls.addForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const text = organizeEls.addText.value.trim();
  if (!text) {
    organizeError('足す項目の文を書いてください。');
    return;
  }
  if (await organizeAct('item', { column: organizeEls.addColumn.value, text })) organizeEls.addText.value = '';
});
organizeEls.run.addEventListener('click', runOrganize);
$('organize-stop').addEventListener('click', () => {
  if (organizeUi.projectId) api(organizePath(organizeUi.projectId, 'cancel'), { method: 'POST' }).catch(organizeFailed);
});
// 読んでいた板の版を送る。読んだ後に板が変わっていたら、サーバーが断る
organizeEls.confirm.addEventListener('click', () => organizeAct('confirm', { rev: organizeUi.board?.rev }));
$('organize-back').addEventListener('click', closeOrganize);
$('organize-design').addEventListener('click', () => openDesign());

// 会の始めとお客さんのデータ(field-session.md の段 0、collaboration.md の 7 節、K4)。サーバーは src/server/meeting.js。
// 目的は外から来た文字なので、ほかと同じく textContent と value でだけ出す。
// view は 'new'(目的を書く)、'meeting'(会の中身)、'erased'(消した一覧)のどれか
const MEETING_MARKS = { waiting: '会: 同意の前', agreed: '会: 同意した', trial: '会: お試しの AI だけ' };
const MEETING_STATES = {
  waiting: '同意の前です。整理する AI も作る AI も呼びません。中身をお客さんと読み、決める人が同意を押しますか。',
  agreed: '決める人が同意しました。',
  trial: 'お試しの AI だけで進めます。外の AI には送りません。お客さんが送ってよいと決めたら、「同意して始める」を押せます。',
};
const meetingUi = { view: null, projectId: null, record: null, confirming: false, working: false, erased: null, seq: 0 };
// 会の終わりの画面(view が 'closing')の中身。data はサーバーの closing.js の形
const closingUi = { data: null, exported: null, busy: false };
const meetingEls = {
  section: $('meeting'),
  heading: $('meeting-heading'),
  state: $('meeting-state'),
  newForm: $('meeting-new'),
  // 「会を用意する」。次の一手の帯に移すので、form の中を探さず、ここで持つ
  newSubmit: $('meeting-new').querySelector('button[type="submit"]'),
  purpose: $('meeting-purpose'),
  body: $('meeting-body'),
  facts: $('meeting-facts'),
  deleteOn: $('meeting-delete-on'),
  agree: $('meeting-agree'),
  trial: $('meeting-trial'),
  organize: $('meeting-organize'),
  erase: $('meeting-erase'),
  confirm: $('meeting-confirm'),
  plan: $('meeting-plan'),
  erased: $('meeting-erased'),
  erasedList: $('meeting-erased-list'),
  left: $('meeting-left'),
  notErased: $('meeting-not-erased'),
  error: $('meeting-error'),
  mark: $('meeting-mark'),
  due: $('meeting-due'),
  closingOpen: $('meeting-closing-open'),
  closing: $('meeting-closing'),
};
const meetingPath = (id, action = '') => `/api/projects/${encodeURIComponent(id)}/meeting${action ? `/${action}` : ''}`;

function renderMeetingMark(project) {
  const meeting = project?.meeting;
  const shown = Boolean(meeting) && meeting.status !== 'none' && !(intentUi.view === 'start' && !intentUi.projectId);
  meetingEls.mark.hidden = !shown;
  if (!shown) return;
  meetingEls.mark.textContent = meeting.overdue ? '会: 消す日を過ぎた' : MEETING_MARKS[meeting.status];
  meetingEls.mark.dataset.state = meeting.overdue || meeting.status === 'waiting' ? 'none' : meeting.status === 'agreed' ? 'decided' : 'draft';
}

// 消す日を過ぎた会の知らせ。押すと、その会を開く(消すかは人が決める)。
// 会の目的は出さない。ほかのお客さんの前で、別の会の目的を見せないため
function renderMeetingDue(list) {
  meetingEls.due.hidden = list.length === 0;
  meetingEls.due.replaceChildren(...list.map((entry) => {
    const line = element('p');
    line.append(element('span', `消す日を過ぎた会があります(消す日 ${entry.deleteOn})`), smallButton('開く', () => {
      leaveIntent();
      closeOrganize();
      closeDesign();
      closeReview();
      switchProject(entry.id);
      openMeeting(entry.id);
    }));
    return line;
  }));
}

function meetingError(text) {
  meetingEls.error.hidden = !text;
  meetingEls.error.textContent = text ?? '';
}

function meetingFailed(error) {
  if (error instanceof ApiError && !['offline', 'token'].includes(error.code)) meetingError(error.message);
  else handleError(error);
}

function meetingFact(term, ...values) {
  const dd = element('dd');
  dd.append(...values);
  return [element('dt', term), dd];
}

function bulletList(tag, texts) {
  const list = element(tag);
  list.append(...texts.map((text) => element('li', text)));
  return list;
}

function erasedLine(row) {
  const names = row.names?.length > 0 ? `(${row.names.join('、')})` : '';
  return element('li', `${row.label}: ${row.count} 個${names}`);
}

function renderMeetingFacts(record) {
  const { sending } = record;
  meetingEls.facts.replaceChildren(
    ...meetingFact('目的', record.purpose),
    ...meetingFact('流れ', bulletList('ol', record.flow.map((step) => step.label))),
    ...meetingFact('何を送るか', sending.outside ? bulletList('ul', sending.items) : '外の AI には送りません。今の起動は、外の AI につながっていません。'),
    ...(sending.outside ? [...meetingFact('送り先', sending.to ?? '不明'), ...meetingFact('料金', sending.cost ?? '不明')] : []),
    ...meetingFact('置き場', `この PC の中だけです。${record.place}`),
    ...meetingFact('見られる人', record.viewers),
    ...meetingFact('入れないもの', 'お客さんの記録(名前、住所、電話番号、メールアドレス、取引の番号や数字の実物)は入れません。形で見分けて止めますが、漏れることがあります。'),
    ...meetingFact('同意しないとき', 'お試しの AI だけで進めます。外の AI には送りません。要点は手で振り分け、設計は決まった案で進めます。料金はかかりません。'),
  );
}

function renderMeeting() {
  scheduleFrame();
  const { view, record, working, confirming, erased } = meetingUi;
  meetingEls.section.hidden = !view;
  if (view) document.body.dataset.meeting = 'open';
  else delete document.body.dataset.meeting;
  if (!view) return;
  meetingEls.newForm.hidden = view !== 'new';
  meetingEls.body.hidden = view !== 'meeting' || !record;
  meetingEls.erased.hidden = view !== 'erased';
  meetingEls.closing.hidden = view !== 'closing';
  $('meeting-only-fiction').hidden = view === 'erased';
  if (view === 'new') {
    meetingEls.heading.textContent = '会の始め';
    meetingEls.state.textContent = '会の目的を書いて、用意してください。用意しただけでは、どの AI も呼びません。';
    delete meetingEls.state.dataset.state;
    return;
  }
  if (view === 'erased') {
    const complete = erased.left.length === 0;
    meetingEls.heading.textContent = complete ? '会のデータを消しました' : '会のデータの一部を消せませんでした';
    meetingEls.state.textContent = complete ? '次のものを、この PC から消しました。' : '次のものだけを消しました。残った場所を、手で消してください。';
    meetingEls.state.dataset.state = complete ? 'decided' : 'draft';
    meetingEls.erasedList.replaceChildren(...erased.erased.map(erasedLine));
    meetingEls.left.hidden = erased.left.length === 0;
    meetingEls.left.textContent = erased.left.length > 0 ? `消せなかったものがあります。手で消してください: ${erased.left.join('、')}` : '';
    meetingEls.notErased.replaceChildren(...erased.notErased.map((text) => element('li', text)));
    return;
  }
  if (view === 'closing') {
    renderClosing();
    return;
  }
  meetingEls.heading.textContent = '会の始め';
  if (!record) {
    meetingEls.state.textContent = '読み込んでいます…';
    return;
  }
  meetingEls.state.textContent = record.overdue ? `消す日(${record.deleteOn})を過ぎました。要らなければ、会のデータを消してください。` : MEETING_STATES[record.status];
  meetingEls.state.dataset.state = record.status === 'agreed' && !record.overdue ? 'decided' : 'draft';
  renderMeetingFacts(record);
  if (document.activeElement !== meetingEls.deleteOn) meetingEls.deleteOn.value = record.deleteOn;
  meetingEls.agree.hidden = record.status === 'agreed';
  meetingEls.trial.hidden = record.status !== 'waiting';
  meetingEls.organize.hidden = record.status === 'waiting';
  meetingEls.closingOpen.hidden = record.status === 'waiting';
  for (const button of [meetingEls.agree, meetingEls.trial, meetingEls.organize, meetingEls.closingOpen, meetingEls.erase, $('meeting-back'), $('meeting-erase-go'), $('meeting-erase-cancel')]) button.disabled = working;
  meetingEls.confirm.hidden = !confirming;
  meetingEls.erase.hidden = confirming;
  meetingEls.plan.replaceChildren(...record.erasable.map(erasedLine));
}

function openMeetingNew() {
  meetingUi.seq += 1;
  Object.assign(meetingUi, { view: 'new', projectId: null, record: null, confirming: false, working: false, erased: null });
  meetingEls.purpose.value = '';
  meetingError(null);
  renderMeeting();
  meetingEls.purpose.focus();
}

async function openMeeting(id) {
  leaveIntent();
  closeOrganize();
  closeDesign();
  closeReview();
  meetingUi.seq += 1;
  const { seq } = meetingUi;
  Object.assign(meetingUi, { view: 'meeting', projectId: id, record: null, confirming: false, working: false, erased: null });
  meetingError(null);
  renderMeeting();
  meetingEls.heading.focus();
  try {
    const { meeting } = await api(meetingPath(id));
    if (seq !== meetingUi.seq) return;
    meetingUi.record = meeting;
    renderMeeting();
  } catch (error) {
    if (seq === meetingUi.seq) meetingFailed(error);
  }
}

function closeMeeting() {
  meetingUi.seq += 1;
  Object.assign(closingUi, { data: null, exported: null, busy: false });
  if (!meetingUi.view) return;
  Object.assign(meetingUi, { view: null, projectId: null, record: null, confirming: false, working: false, erased: null });
  meetingError(null);
  renderMeeting();
}

// 一覧を読み直す。selectedId は呼ぶ側が決める
async function refreshMeetingList() {
  lastSnapshot = '';
  await refresh();
}

async function createMeeting() {
  if (meetingUi.working) return;
  const purpose = meetingEls.purpose.value.trim();
  if (!purpose) {
    meetingError('会の目的を書いてください。');
    return;
  }
  meetingUi.working = true;
  meetingError(null);
  try {
    const { project } = await api('/api/meetings', { method: 'POST', json: { purpose } });
    selectedId = project.id;
    await refreshMeetingList();
    await openMeeting(project.id);
  } catch (error) {
    meetingUi.working = false;
    meetingFailed(error);
  }
}

// 同意する(agree)か、同意しない道を選ぶ(trial)。人が押したときだけ送る。その後は整理の板を開く
async function decideMeeting(decision) {
  const id = meetingUi.projectId;
  if (!id || meetingUi.working) return;
  meetingUi.working = true;
  meetingError(null);
  renderMeeting();
  const { seq } = meetingUi;
  try {
    const { consent: state } = await api(meetingPath(id, 'decide'), { method: 'POST', json: { decision, deleteOn: meetingEls.deleteOn.value } });
    setConsentState(state);
    selectedId = id;
    await refreshMeetingList();
    if (seq !== meetingUi.seq) return;
    closeMeeting();
    await openOrganize();
  } catch (error) {
    if (seq !== meetingUi.seq) return;
    meetingUi.working = false;
    renderMeeting();
    meetingFailed(error);
  }
}

async function eraseMeeting() {
  const id = meetingUi.projectId;
  if (!id || meetingUi.working) return;
  meetingUi.working = true;
  meetingError(null);
  renderMeeting();
  const { seq } = meetingUi;
  try {
    const erased = await api(meetingPath(id, 'erase'), { method: 'POST', json: { confirm: id } });
    // 消した後は、会ではない試作品を選ぶ。別のお客さんの会の目的を、帯に出さないため
    if (selectedId === id) selectedId = projects.find((project) => project.id !== id && project.meeting?.status === 'none')?.id ?? null;
    // 別の画面へ移っていても、消した結果は必ず見せる
    meetingUi.seq += 1;
    Object.assign(meetingUi, { view: 'erased', projectId: null, record: null, confirming: false, working: false, erased });
    closeOrganize();
    closeDesign();
    closeReview();
    leaveIntent();
    renderMeeting();
    await refreshMeetingList();
  } catch (error) {
    if (seq !== meetingUi.seq) return handleError(error);
    meetingUi.working = false;
    renderMeeting();
    meetingFailed(error);
  }
}

function startMeetingFromMenu() {
  setProjectMenu(false);
  leaveIntent();
  closeOrganize();
  closeDesign();
  closeReview();
  openMeetingNew();
}

$('new-meeting').addEventListener('click', startMeetingFromMenu);
$('intent-meeting').addEventListener('click', startMeetingFromMenu);
meetingEls.mark.addEventListener('click', () => {
  const project = selectedProject();
  if (project && !(meetingUi.view === 'meeting' && meetingUi.projectId === project.id)) openMeeting(project.id);
});
meetingEls.newForm.addEventListener('submit', (event) => {
  event.preventDefault();
  createMeeting();
});
$('meeting-new-cancel').addEventListener('click', closeMeeting);
$('meeting-delete-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const id = meetingUi.projectId;
  if (!id) return;
  meetingError(null);
  const { seq } = meetingUi;
  try {
    const { meeting } = await api(meetingPath(id, 'delete-on'), { method: 'POST', json: { deleteOn: meetingEls.deleteOn.value } });
    if (seq !== meetingUi.seq) return;
    meetingUi.record = meeting;
    renderMeeting();
    await refreshMeetingList();
  } catch (error) {
    if (seq === meetingUi.seq) meetingFailed(error);
  }
});
meetingEls.agree.addEventListener('click', () => decideMeeting('agree'));
meetingEls.trial.addEventListener('click', () => decideMeeting('trial'));
meetingEls.organize.addEventListener('click', () => {
  closeMeeting();
  openOrganize();
});
$('meeting-back').addEventListener('click', closeMeeting);
meetingEls.erase.addEventListener('click', async () => {
  const id = meetingUi.projectId;
  const { seq } = meetingUi;
  // 押した時の中身を読み直して見せる
  try {
    const { meeting } = await api(meetingPath(id));
    if (seq !== meetingUi.seq) return;
    meetingUi.record = meeting;
    meetingUi.confirming = true;
    renderMeeting();
  } catch (error) {
    if (seq === meetingUi.seq) meetingFailed(error);
  }
});
$('meeting-erase-cancel').addEventListener('click', () => {
  meetingUi.confirming = false;
  renderMeeting();
});
$('meeting-erase-go').addEventListener('click', eraseMeeting);
$('meeting-erased-close').addEventListener('click', closeMeeting);

// 会の終わりの成果物(field-session.md の段 7、user-journey.md の K5)。サーバーは src/server/closing.js。
// 会の画面の 1 つの view('closing')として出す。7 つの成果物、未決事項の持ち主と期日、要件の文書、データ設計、直した記録、書き出し。
// 文は外から来た文字なので、ほかと同じく textContent と value でだけ出す
const CLOSING_FROM_WORDS = { purpose: '目的の文書', point: '元の要点', checked: '人が確かめた', guess: '推測(話に出ていない)', comment: '承認したコメント' };
const closingPath = (id, action = '') => `/api/projects/${encodeURIComponent(id)}/closing${action ? `/${action}` : ''}`;

function closingSource(item) {
  if (item.from === 'comment') return `コメント ${item.comment.number}(${item.comment.statusLabel})`;
  if (item.from === 'point') return `元の要点 ${item.sources.map((source) => `${source.n}「${source.text}」`).join('、')}`;
  return CLOSING_FROM_WORDS[item.from] ?? item.from;
}

function closingOpenLine(item, index) {
  const li = element('li');
  li.dataset.unowned = String(!item.owner);
  const head = element('p', item.text);
  const from = element('small', item.owner ? `${item.fromLabel}` : `${item.fromLabel}。持ち主なし`);
  const form = element('form');
  form.className = 'closing-owner';
  const ownerId = `closing-owner-${index}`;
  const dueId = `closing-due-${index}`;
  const owner = element('input');
  owner.type = 'text';
  owner.id = ownerId;
  owner.maxLength = 40;
  owner.autocomplete = 'off';
  owner.value = item.owner;
  const due = element('input');
  due.type = 'date';
  due.id = dueId;
  due.value = item.due;
  const ownerLabel = element('label', '持ち主');
  ownerLabel.htmlFor = ownerId;
  const dueLabel = element('label', '期日');
  dueLabel.htmlFor = dueId;
  const save = element('button', '決める');
  save.type = 'submit';
  save.disabled = closingUi.busy;
  form.append(ownerLabel, owner, dueLabel, due, save);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    saveClosingOwner(item.key, owner.value, due.value);
  });
  li.append(head, from, form);
  return li;
}

function closingDataView(data) {
  const box = element('div');
  if (data.status === 'chosen' || data.status === 'stale') {
    box.append(element('p', `選んだ案: ${data.title ?? ''}${data.status === 'stale' ? '(確かめ直しが要る)' : ''}。型と細かい決まりは会の後に決めます。`));
    const table = element('table');
    table.className = 'closing-table';
    const head = element('tr');
    head.append(element('th', '覚えておくもの'), element('th', '誰が書くか'), element('th', '項目'));
    table.append(head);
    for (const entity of data.entities) {
      const row = element('tr');
      row.append(element('td', entity.name), element('td', entity.writer || '-'), element('td', entity.fields.map((field) => (field.kind === 'key' ? `${field.name}(主キー)` : field.kind === 'link' ? `${field.name}(${field.to}への外部キー)` : `${field.name}(${field.kindLabel})`)).join('、')));
      table.append(row);
    }
    box.append(table);
  } else {
    box.append(element('p', data.status === 'skipped' ? '設計の案内を飛ばしたので、データ設計はありません。' : 'データの案を、まだ選んでいません。設計の案内のデータの段で選びます。'));
  }
  if (data.heard.length > 0) box.append(element('p', `整理の板のデータの欄: ${data.heard.map((item) => `「${item.text}」${item.onDesign ? '' : '(案に載っていない)'}`).join('、')}`));
  return box;
}

// 時間を「12 分 5 秒」の形にする(src/server/timeline.js の durationWords と同じ)
function durationText(ms) {
  if (ms === null || ms === undefined) return 'まだ測れていません';
  const seconds = Math.round(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  if (hours > 0) return `${hours} 時間 ${minutes % 60} 分`;
  return minutes > 0 ? `${minutes} 分 ${seconds % 60} 秒` : `${seconds} 秒`;
}

// 段ごとの時刻(K6。src/server/timeline.js)。見せられるまでの時間と、承認から直った版までの時間を先に出す
function renderClosingTimeline(timeline) {
  const { targets } = timeline;
  const fixes = timeline.fixes.length === 0
    ? '承認したコメントはまだありません'
    : timeline.fixes.map((fix) => `コメント ${fix.comment ?? '-'} は ${fix.ms !== null ? durationText(fix.ms) : fix.fixedAt ? '直した版の自動の確かめが通っていません' : 'まだ直っていません'}`).join('、');
  const show = element('li', `見せられるまでの時間: ${durationText(timeline.toShowMs)}(同意から、自動の確かめが通った最初の試作品まで。目安 ${targets.showMinutes} 分以内、仮)`);
  show.dataset.over = String(timeline.toShowMs !== null && timeline.toShowMs > targets.showMinutes * 60_000);
  const fix = element('li', `承認から直った版まで: ${fixes}(目安 ${targets.fixMinutes} 分以内、仮)`);
  fix.dataset.over = String(timeline.longestFixMs !== null && timeline.longestFixMs > targets.fixMinutes * 60_000);
  $('closing-measures').replaceChildren(show, fix);
  const head = element('tr');
  head.append(...['段', '時刻を残す印', '時刻', '始めから', '目安(60 分の型、仮)'].map((text) => {
    const th = element('th', text);
    th.scope = 'col';
    return th;
  }));
  const rows = timeline.stages.map((stage) => {
    const row = element('tr');
    row.dataset.stage = stage.key;
    row.dataset.reached = String(Boolean(stage.at));
    const over = stage.elapsedMs !== null && stage.elapsedMs > stage.planMinutes * 60_000;
    const th = element('th', stage.label);
    th.scope = 'row';
    row.append(
      th,
      element('td', stage.mark),
      element('td', stage.at ? new Date(stage.at).toLocaleTimeString('ja-JP') : 'まだ'),
      element('td', stage.at ? durationText(stage.elapsedMs) : '-'),
      element('td', `${stage.planMinutes} 分まで${over ? '(目安を超えた)' : ''}`),
    );
    return row;
  });
  $('closing-timeline').replaceChildren(head, ...rows);
}

function renderClosing() {
  scheduleFrame();
  const data = closingUi.data;
  meetingEls.heading.textContent = '会の終わり';
  const unowned = $('closing-unowned');
  if (!data) {
    meetingEls.state.textContent = '読み込んでいます…';
    delete meetingEls.state.dataset.state;
    unowned.hidden = true;
    return;
  }
  const allReady = data.deliverables.every((item) => item.status === 'ready');
  meetingEls.state.textContent = `7 つの成果物のうち ${data.present} つがあります。${data.unowned === 0 ? '未決事項の全部に持ち主がいます。' : ''}未決事項を読み上げ、持ち主と期日を決めてから書き出しますか。`;
  meetingEls.state.dataset.state = allReady ? 'decided' : 'draft';
  unowned.hidden = data.unowned === 0;
  unowned.textContent = data.unowned > 0 ? `持ち主のない未決事項が ${data.unowned} 件あります。` : '';
  $('closing-deliverables').replaceChildren(...data.deliverables.map((item) => {
    const li = element('li');
    li.className = 'closing-row';
    const mark = element('span', item.statusLabel, 'closing-state');
    mark.dataset.state = item.status;
    li.append(element('strong', item.label), mark, element('span', item.note));
    return li;
  }));
  $('closing-open').replaceChildren(...(data.openItems.length > 0 ? data.openItems.map(closingOpenLine) : [element('li', '会の記録から見つけた未決事項はありません。')]));
  const req = data.requirements;
  $('closing-requirements-state').textContent = req.status === 'none'
    ? '目的の文書も、整理の板の項目もありません。'
    : `${req.status === 'confirmed' ? '決める人が「この理解で合っている」を押しました。' : 'まだ「この理解で合っている」を押していない下書きです。'}項目 ${req.counts.items}、推測の印 ${req.counts.guesses}。`;
  $('closing-requirements').replaceChildren(...req.sections.flatMap((section) => {
    const dd = element('dd');
    if (section.items.length === 0) dd.append('(なし)');
    else {
      const list = element('ul');
      list.append(...section.items.map((item) => {
        const li = element('li', item.text);
        li.append(' ', element('small', `(${closingSource(item)})`));
        return li;
      }));
      dd.append(list);
    }
    return [element('dt', section.label), dd];
  }));
  $('closing-data').replaceChildren(closingDataView(data.dataDesign));
  $('closing-fixes').replaceChildren(...(data.fixRecords.length > 0
    ? data.fixRecords.map((record) => element('li', `コメント ${record.comment.number}「${record.comment.text}」(${record.comment.kindLabel}): ${record.events.at(-1)?.label ?? record.status}。承認: ${record.approval.approvers.map((a) => a.roleLabel).join('、') || 'なし'}`))
    : [element('li', '画面へのコメントから直した記録はありません。')]));
  renderClosingTimeline(data.timeline);
  for (const button of [$('closing-export'), $('closing-reload'), $('closing-back')]) button.disabled = closingUi.busy;
  $('closing-export').textContent = closingUi.busy ? '書き出しています…' : '書き出す';
  const exported = $('closing-exported');
  exported.hidden = !closingUi.exported;
  if (closingUi.exported) {
    const line = element('p', '書き出しました: ');
    line.append(element('code', closingUi.exported.dir));
    exported.replaceChildren(line);
  }
}

async function loadClosing() {
  const id = meetingUi.projectId;
  const { seq } = meetingUi;
  try {
    const { closing } = await api(closingPath(id));
    if (seq !== meetingUi.seq) return;
    closingUi.data = closing;
    renderMeeting();
  } catch (error) {
    if (seq === meetingUi.seq) meetingFailed(error);
  }
}

async function openClosing(id) {
  leaveIntent();
  closeOrganize();
  closeDesign();
  closeReview();
  meetingUi.seq += 1;
  Object.assign(meetingUi, { view: 'closing', projectId: id, confirming: false, working: false, erased: null });
  Object.assign(closingUi, { data: null, exported: null, busy: false });
  meetingError(null);
  renderMeeting();
  meetingEls.heading.focus();
  await loadClosing();
}

async function saveClosingOwner(key, owner, due) {
  const id = meetingUi.projectId;
  if (!id || closingUi.busy) return;
  const { seq } = meetingUi;
  closingUi.busy = true;
  meetingError(null);
  renderMeeting();
  try {
    const { closing } = await api(closingPath(id, 'owner'), { method: 'POST', json: { key, owner, due } });
    if (seq !== meetingUi.seq) return;
    closingUi.data = closing;
  } catch (error) {
    if (seq === meetingUi.seq) meetingFailed(error);
  } finally {
    if (seq === meetingUi.seq) {
      closingUi.busy = false;
      renderMeeting();
    }
  }
}

// 書き出しは、本番開発へ渡すフォルダー(引き継ぎ)と同じ。前に書いたメモを、そのまま使う
async function exportClosing() {
  const id = meetingUi.projectId;
  if (!id || closingUi.busy) return;
  const { seq } = meetingUi;
  closingUi.busy = true;
  meetingError(null);
  renderMeeting();
  try {
    const { notes } = await api(`/api/projects/${encodeURIComponent(id)}/handoff`);
    const { handoff: made } = await api(`/api/projects/${encodeURIComponent(id)}/handoff`, { method: 'POST', json: notes ?? {} });
    if (seq !== meetingUi.seq) return;
    closingUi.exported = made;
    // 書き出しは会の終わりの印なので、段ごとの時刻を読み直す。読み直せなくても書き出しは済んでいるので、誤りは出さない(「読み直す」で読める)
    try {
      const { closing } = await api(closingPath(id));
      if (seq === meetingUi.seq) closingUi.data = closing;
    } catch {
      // 前の中身のまま
    }
  } catch (error) {
    if (seq === meetingUi.seq) meetingFailed(error);
  } finally {
    if (seq === meetingUi.seq) {
      closingUi.busy = false;
      renderMeeting();
    }
  }
}

meetingEls.closingOpen.addEventListener('click', () => {
  if (meetingUi.projectId) openClosing(meetingUi.projectId);
});
$('closing-export').addEventListener('click', exportClosing);
$('closing-reload').addEventListener('click', loadClosing);
$('closing-back').addEventListener('click', () => {
  if (meetingUi.projectId) openMeeting(meetingUi.projectId);
});

// 設計の案内(user-journey.md の段 3、J2)。サーバーは src/server/design.js。
// 案と場面は外から来た文字なので、ほかと同じく textContent と value でだけ出す。
// record はサーバーの状態。sceneDraft は直している場面の一覧(次の段へ進むときに保存する)
const DESIGN_MARKS = { none: '設計なし', skipped: '設計なし', drafting: '設計: 下書き', decided: '設計: 決めた' };
const designUi = { open: false, projectId: null, record: null, waiting: false, declined: false, sceneDraft: null, seq: 0, timer: null };
const designEls = {
  section: $('design'),
  heading: $('design-heading'),
  state: $('design-state'),
  band: $('design-band'),
  waiting: $('design-waiting'),
  begin: $('design-begin'),
  noAi: $('design-no-ai'),
  consent: $('design-consent'),
  declined: $('design-declined'),
  start: $('design-start'),
  step: $('design-step'),
  stepHeading: $('design-step-heading'),
  stepLead: $('design-step-lead'),
  stale: $('design-stale'),
  basis: $('design-basis'),
  options: $('design-options'),
  custom: $('design-custom'),
  customText: $('design-custom-text'),
  scenesBox: $('design-scenes-box'),
  scenes: $('design-scenes'),
  sceneCategory: $('design-scene-category'),
  sceneText: $('design-scene-text'),
  dataBox: $('design-data-box'),
  dataFigure: $('design-data-figure'),
  dataTables: $('design-data-tables'),
  dataCoverage: $('design-data-coverage'),
  dataSample: $('design-data-sample'),
  shelf: $('design-shelf'),
  shelfTable: $('design-shelf-table'),
  ragVerdict: $('design-rag-verdict'),
  ragReason: $('design-rag-reason'),
  ragSteps: $('design-rag-steps'),
  ragDecide: $('design-rag-decide'),
  owner: $('design-owner'),
  review: $('design-review'),
  noteBox: $('design-note-box'),
  note: $('design-note'),
  prev: $('design-prev'),
  next: $('design-next'),
  build: $('design-build'),
  again: $('design-again'),
  skip: $('design-skip'),
  message: $('design-note-message'),
  error: $('design-error'),
  mark: $('design-mark'),
};
const designPath = (id, action = '') => `/api/projects/${encodeURIComponent(id)}/design${action ? `/${action}` : ''}`;

function renderDesignMark(project) {
  const status = project?.design?.status ?? 'none';
  designEls.mark.hidden = !project || (intentUi.view === 'start' && !intentUi.projectId);
  designEls.mark.textContent = DESIGN_MARKS[status] ?? DESIGN_MARKS.none;
  designEls.mark.dataset.state = status === 'decided' ? 'decided' : status === 'drafting' ? 'draft' : 'none';
}

function designError(text) {
  designEls.error.hidden = !text;
  designEls.error.textContent = text ?? '';
}

function designFailed(error) {
  if (error instanceof ApiError && !['offline', 'token'].includes(error.code)) designError(`進められませんでした: ${error.message}`);
  else handleError(error);
}

function renderDesignConsent() {
  const card = consent.card?.use === 'design' ? consent.card : null;
  designEls.consent.replaceChildren(...(card ? [consentCard(card.view, { card })] : []));
  designEls.declined.hidden = !designUi.declined || Boolean(card);
}

const designStepOf = (record, id) => record.steps.find((step) => step.id === id);
const designCurrent = (record) => designStepOf(record, record.current) ?? record.steps[0];
const designChosen = (step) => step.options.find((option) => option.id === step.chosen) ?? null;
const designChosenLabel = (step) => (step.chosen === 'custom' ? step.text : designChosen(step)?.title ?? '');
// 先へ進めるのは、ここまでの段を選んだ分だけ
const designOpenIndex = (record) => {
  const at = record.steps.findIndex((step) => !step.chosen);
  return at === -1 ? record.steps.length - 1 : at;
};

function designStateText(record) {
  const staleAfter = record.status === 'decided' && record.steps.find((step) => step.stale);
  if (staleAfter) return `${formatTime(record.decidedAt)}に決めた後に、構成のファイルが変わりました。次にすること: 「${staleAfter.label}」の案を確かめ直してください。`;
  // データの段(K2)より前に決めた設計には、選んでいない段がある
  const unchosen = record.status === 'decided' && record.steps.find((step) => !step.chosen);
  if (unchosen) return `${formatTime(record.decidedAt)}に決めた後に、「${unchosen.label}」の段が増えました。次にすること: 「${unchosen.label}」の案を選んでください。`;
  if (record.status === 'decided') return `${formatTime(record.decidedAt)}に決めました。次にすること: 作った試作品を試してください。`;
  if (record.status === 'skipped') return `${formatTime(record.skippedAt)}に飛ばしました。「設計なし」のまま進めています。設計に戻るときは、案を選んでください。`;
  const stale = record.steps.find((step) => step.stale);
  if (stale) return `前の段を変えました。次にすること: 「${stale.label}」の案を確かめ直してください。`;
  if (record.ready) return `${record.steps.length} つの段を選びました。次にすること: 「この設計で作る」を押してください。`;
  const step = designCurrent(record);
  if (!step.chosen) return `次にすること: 「${step.label}」の案を読んで、1 つ選んでください。`;
  return '次にすること: 「次の段へ」を押してください。';
}

function designOptionItem(option, step, record) {
  const li = element('li', undefined, 'design-option');
  const chosen = step.chosen === option.id;
  li.dataset.chosen = String(chosen);
  li.dataset.available = String(option.available !== false);
  const head = element('div');
  head.append(element('span', option.title, 'design-option-title'));
  if (option.recommended) head.append(' ', element('span', 'おすすめ', 'organize-badge'));
  if (chosen) head.append(' ', element('span', '選んだ案', 'organize-badge'));
  li.append(head);
  if (option.detail) li.append(element('p', option.detail));
  if (option.question) {
    const facts = element('dl');
    const fact = (name, value) => facts.append(element('dt', name), element('dd', value));
    fact('問い', option.question);
    fact('順番を決めるもの', option.decidedBy);
    fact('モデルに任せること', option.modelRole);
    fact('数', 'まだ測っていない');
    li.append(facts);
  }
  if (option.scenes) {
    const list = element('ul');
    for (const scene of option.scenes) list.append(element('li', `${record.categories[scene.category]}: ${scene.text}`));
    li.append(list);
  }
  if (option.entities) li.append(...dataOptionSummary(option));
  if (option.reason) li.append(element('p', `${option.recommended ? 'おすすめの理由' : '理由'}: ${option.reason}`, 'design-reason'));
  if (option.limitation) li.append(element('p', option.limitation, 'muted'));
  const button = element('button', `「${option.title}」を選ぶ`);
  button.type = 'button';
  button.disabled = option.available === false;
  button.setAttribute('aria-pressed', String(chosen));
  button.addEventListener('click', () => chooseDesign(step.id, option.id));
  li.append(button);
  return li;
}

// データの段(K2)。項目の種類の言葉。主キーと外部キーの言葉も隠さない(field-session.md の段 3)
const FIELD_KIND_LABELS = { key: '番号(主キー)', link: 'つながりの番号(外部キー)', text: '文', number: '数', date: '日付', choice: '選ぶもの' };
const linkText = (link) => `1 つの「${link.from}」に、いくつもの「${link.to}」(${link.label}。1 対 多)`;

// 整理の板のデータの欄が、案に全部載ったか。載っていない欄と、Studio が足した欄を数える
function dataCoverageText(option) {
  const coverage = option.coverage ?? [];
  if (coverage.length === 0) return '整理の板にデータの欄はありません。';
  const missing = coverage.filter((entry) => entry.where.length === 0);
  const added = option.added?.length ?? 0;
  const parts = [missing.length === 0 ? `整理の板のデータの欄 ${coverage.length} つが、全部載っています。` : `整理の板のデータの欄 ${coverage.length} つのうち、${missing.length} つがまだ載っていません。「案を作り直す」で載ります。`];
  if (added > 0) parts.push(`${added} つは案になかったので、Studio が「聞いたことのメモ」に足しました。`);
  return parts.join('');
}

// 案のカードに出す短い形。覚えておくものと項目、つながり、整理の板の欄が載ったか、図
function dataOptionSummary(option) {
  const list = element('ul');
  for (const entity of option.entities) list.append(element('li', `${entity.name}: ${entity.fields.map((field) => field.name).join('、')}`));
  for (const link of option.links) list.append(element('li', `つながり: ${linkText(link)}`));
  return [list, element('p', dataCoverageText(option), 'muted design-data-note'), dataFigure(option, `「${option.title}」の図`)];
}

// データ設計の図。覚えておくものを箱に、つながりを矢印にする。外の部品を使わず、SVG で描く
const SVG_NS = 'http://www.w3.org/2000/svg';
function svgNode(tag, attributes = {}, text) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, String(value));
  if (text !== undefined) node.textContent = text;
  return node;
}

function dataFigure(option, label) {
  const shown = 6;
  const width = 200;
  const lineHeight = 17;
  const head = 24;
  const gapX = 130;
  const gapY = 56;
  const columns = Math.min(3, option.entities.length);
  const heightOf = (entity) => head + Math.min(entity.fields.length, shown + 1) * lineHeight + 8;
  const rowHeight = Math.max(...option.entities.map(heightOf));
  const rows = Math.ceil(option.entities.length / columns);
  const boxes = new Map(option.entities.map((entity, index) => {
    const x = 10 + (index % columns) * (width + gapX);
    const y = 10 + Math.floor(index / columns) * (rowHeight + gapY);
    return [entity.name, { x, y, w: width, h: heightOf(entity) }];
  }));
  const svg = svgNode('svg', { viewBox: `0 0 ${20 + columns * width + (columns - 1) * gapX} ${20 + rows * rowHeight + (rows - 1) * gapY}`, role: 'img', 'aria-label': `${label}。${option.entities.map((entity) => entity.name).join('、')}。${option.links.map(linkText).join('。')}`, class: 'data-figure' });
  const marker = `data-arrow-${Math.random().toString(36).slice(2, 8)}`;
  const defs = svgNode('defs');
  const arrow = svgNode('marker', { id: marker, viewBox: '0 0 10 10', refX: 10, refY: 5, markerWidth: 8, markerHeight: 8, orient: 'auto-start-reverse' });
  arrow.append(svgNode('path', { d: 'M 0 0 L 10 5 L 0 10 z', class: 'link-arrow' }));
  defs.append(arrow);
  svg.append(defs);
  // 箱の縁から縁へ線を引く(中心を結ぶ線が縁を出る所)
  const edge = (box, dx, dy) => {
    const t = Math.min(dx === 0 ? Infinity : box.w / 2 / Math.abs(dx), dy === 0 ? Infinity : box.h / 2 / Math.abs(dy));
    return { x: box.x + box.w / 2 + dx * t, y: box.y + box.h / 2 + dy * t };
  };
  for (const link of option.links) {
    const from = boxes.get(link.from);
    const to = boxes.get(link.to);
    if (!from || !to) continue;
    const dx = to.x + to.w / 2 - (from.x + from.w / 2);
    const dy = to.y + to.h / 2 - (from.y + from.h / 2);
    const start = edge(from, dx, dy);
    const end = edge(to, -dx, -dy);
    svg.append(svgNode('line', { x1: start.x, y1: start.y, x2: end.x, y2: end.y, class: 'link-line', 'marker-end': `url(#${marker})` }));
    svg.append(svgNode('text', { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 - 4, 'text-anchor': 'middle', class: 'link-label' }, `${link.label}(1 対 多)`));
  }
  for (const entity of option.entities) {
    const box = boxes.get(entity.name);
    svg.append(svgNode('rect', { x: box.x, y: box.y, width: box.w, height: box.h, rx: 6, class: 'entity-box' }));
    svg.append(svgNode('rect', { x: box.x, y: box.y, width: box.w, height: head, rx: 6, class: 'entity-head' }));
    svg.append(svgNode('text', { x: box.x + 8, y: box.y + 16, class: 'entity-name' }, entity.name));
    const fields = entity.fields.slice(0, shown);
    fields.forEach((field, index) => {
      const mark = field.kind === 'key' ? '(主キー)' : field.kind === 'link' ? '(外部キー)' : '';
      svg.append(svgNode('text', { x: box.x + 8, y: box.y + head + 14 + index * lineHeight, class: mark ? 'entity-key' : 'entity-field' }, `${field.name}${mark}`.slice(0, 22)));
    });
    if (entity.fields.length > shown) svg.append(svgNode('text', { x: box.x + 8, y: box.y + head + 14 + shown * lineHeight, class: 'entity-key' }, `ほか ${entity.fields.length - shown} つ`));
  }
  return svg;
}

// 選んだ案の表。項目ごとに、種類、例(架空)、元の話(整理の板の欄)を並べる
function dataTable(entity, textOf) {
  const table = element('table');
  const caption = [entity.name, entity.about, entity.writer ? `書く人: ${entity.writer}` : ''].map((part) => part.replace(/。+$/, '')).filter(Boolean).join('。');
  table.append(element('caption', caption));
  const headRow = element('tr');
  for (const name of ['項目', '種類', '例(架空)', '元の話(整理の板)']) headRow.append(element('th', name));
  const thead = element('thead');
  thead.append(headRow);
  const tbody = element('tbody');
  for (const field of entity.fields) {
    const row = element('tr');
    const kind = field.kind === 'link' ? `${FIELD_KIND_LABELS.link}: 「${field.to}」の番号を指す` : FIELD_KIND_LABELS[field.kind] ?? field.kind;
    const examples = field.kind === 'key' || field.kind === 'link' ? 'Studio が付けます' : field.examples?.length > 0 ? field.examples.join('、') : 'Studio が作ります';
    const sources = [...(field.sources ?? []), ...(field.kind === 'key' ? entity.sources ?? [] : [])].map(textOf).filter(Boolean);
    row.append(element('th', field.name), element('td', kind), element('td', examples), element('td', sources.join('、') || 'なし'));
    row.firstChild.setAttribute('scope', 'row');
    tbody.append(row);
  }
  table.append(thead, tbody);
  return table;
}

function renderDataBox(step) {
  const option = designChosen(step);
  designEls.dataBox.hidden = !option;
  designEls.shelf.hidden = !option;
  if (!option) return;
  const coverage = option.coverage ?? [];
  const textOf = (id) => coverage.find((entry) => entry.id === id)?.text ?? '';
  designEls.dataFigure.replaceChildren(dataFigure(option, 'データ設計の図'));
  const links = element('ul');
  for (const link of option.links) links.append(element('li', `つながり: ${linkText(link)}`));
  designEls.dataTables.replaceChildren(...option.entities.map((entity) => dataTable(entity, textOf)), ...(option.links.length > 0 ? [links] : []));
  designEls.dataCoverage.replaceChildren(...(coverage.length > 0 ? coverage.map((entry) => {
    const li = element('li', `${entry.text} → ${entry.where.length > 0 ? entry.where.join('、') : 'まだ載っていません'}`);
    li.dataset.placed = String(entry.where.length > 0);
    return li;
  }) : [element('li', '整理の板にデータの欄はありません。')]));
  designEls.dataSample.textContent = `${dataCoverageText(option)}選んだ案から、試作品の架空のデータを表ごとに 3 行作りました。「この設計で作る」で、作る AI はこのデータを読んで画面を描きます。`;
  renderShelf(option);
}

// AI が読むデータの棚と RAG の判定(task 421)。技術の言葉は平たい言葉と並べる(ai-architecture-review.md の 8 節)
const SHELF_SHAPE_LABELS = { table: '表', rules: '短い決まり', document: '長い文書' };
const SHELF_READ_LABELS = { tool: 'ツールで引く', prompt: 'プロンプトに入れる', rag: 'RAG(文書を探して読む)', none: '使わない' };
const SHELF_CHANGE_LABELS = { minutes: '毎分', daily: '毎日', rarely: '年に数回', unknown: 'まだ決めていない' };
const shelfPersonalText = (item) => (item.personal === true ? `あり${item.personalKinds?.length ? `(${item.personalKinds.join('、')})` : ''}` : item.personal === false ? 'なし' : '不明(確かめてください)');

// 引くツールの列(審査の画面だけ。#426)。表をツールで引くのにツールがなければ「まだない」
const shelfToolsText = (item) => (item.tools?.length > 0 ? item.tools.join('、') : item.read === 'tool' ? 'まだない' : 'なし');

function shelfTable(shelf, { tools = false } = {}) {
  const table = element('table');
  table.setAttribute('aria-label', 'AI が読むデータの棚');
  const headRow = element('tr');
  for (const name of ['データ', '形', 'AI の読み方', '変わる速さ', '個人情報', '試作品での扱い', ...(tools ? ['引くツール'] : [])]) headRow.append(element('th', name));
  const thead = element('thead');
  thead.append(headRow);
  const tbody = element('tbody');
  for (const item of shelf) {
    const row = element('tr');
    row.dataset.read = item.read;
    row.append(element('th', item.name), element('td', SHELF_SHAPE_LABELS[item.shape] ?? item.shape), element('td', SHELF_READ_LABELS[item.read] ?? item.read), element('td', SHELF_CHANGE_LABELS[item.change] ?? item.change), element('td', shelfPersonalText(item)), element('td', item.prototype));
    if (tools) row.append(element('td', shelfToolsText(item)));
    row.firstChild.setAttribute('scope', 'row');
    tbody.append(row);
  }
  table.append(thead, tbody);
  return table;
}

function renderShelf(option) {
  const shelf = option.shelf ?? [];
  const rag = option.rag;
  designEls.shelfTable.replaceChildren(shelf.length > 0 ? shelfTable(shelf) : element('p', 'AI が読むデータは、まだありません。', 'muted'));
  if (!rag) return;
  designEls.ragVerdict.dataset.needed = String(rag.needed);
  designEls.ragVerdict.textContent = `RAG: ${rag.verdict}(${rag.note})`;
  designEls.ragReason.replaceChildren(element('p', `理由: ${rag.reason}。`), ...(rag.addWhen ? [element('p', `足す条件: ${rag.addWhen}。`)] : []));
  designEls.ragSteps.replaceChildren(...rag.steps.map((step) => {
    const answer = step.read === 'rag'
      ? (rag.needed === false ? '問わない(ここまでで足りた)' : `長い文書: ${step.items.join('、') || 'なし'}`)
      : `${SHELF_READ_LABELS[step.read]}: ${step.items.join('、') || 'なし'}`;
    return element('li', `${step.question} → ${answer}`);
  }));
  if (rag.decide) {
    const list = element('ul');
    for (const item of rag.decide) list.append(element('li', `${item.label}: ${item.question}(試作品では: ${item.prototype})`));
    designEls.ragDecide.replaceChildren(element('p', 'RAG を足すなら決めること'), list);
  } else designEls.ragDecide.replaceChildren();
}

function designSceneItem(scene, index, record) {
  const li = element('li', undefined, 'design-scene');
  const label = record.categories[scene.category];
  li.append(element('span', label, 'organize-badge'));
  const input = element('input');
  input.type = 'text';
  input.maxLength = 200;
  input.value = scene.text;
  input.setAttribute('aria-label', `場面 ${index + 1}(${label})の文`);
  input.addEventListener('input', () => {
    designUi.sceneDraft ??= structuredClone(record.scenes);
    designUi.sceneDraft[index].text = input.value;
  });
  const remove = element('button', '消す');
  remove.type = 'button';
  remove.setAttribute('aria-label', `場面 ${index + 1}(${label})を消す`);
  remove.addEventListener('click', () => {
    designUi.sceneDraft ??= structuredClone(record.scenes);
    designUi.sceneDraft.splice(index, 1);
    designError(null);
    renderDesign();
  });
  li.append(input, remove);
  return li;
}

function renderDesign() {
  scheduleFrame();
  const { open, record, waiting } = designUi;
  designEls.section.hidden = !open;
  if (open) document.body.dataset.design = 'open';
  else delete document.body.dataset.design;
  renderDesignConsent();
  if (!open) return;
  const hasOptions = Boolean(record?.steps?.length);
  const thinking = waiting || Boolean(record?.thinking);
  designEls.waiting.hidden = !thinking;
  designEls.begin.hidden = thinking || hasOptions;
  designEls.noAi.hidden = Boolean(agent?.ready);
  designEls.start.disabled = thinking;
  designEls.step.hidden = !hasOptions || thinking;
  designEls.band.hidden = !hasOptions;
  designEls.message.hidden = !record?.note;
  designEls.message.textContent = record?.note ?? '';
  for (const button of [designEls.prev, designEls.next, designEls.build, designEls.again]) button.hidden = true;
  designEls.skip.hidden = record?.status === 'skipped' || record?.status === 'decided' || thinking;
  if (!hasOptions) {
    designEls.state.textContent = record?.hasIntent === false
      ? '目的の文書をまだ決めていません。このまま進めると、最初の 1 文か試作品の名前を材料にします。次にすること: 「案を作る」を押してください。'
      : '次にすること: 「案を作る」を押してください。';
    designEls.state.dataset.state = 'draft';
    designEls.band.replaceChildren();
    return;
  }
  designEls.state.textContent = designStateText(record);
  designEls.state.dataset.state = record.status === 'decided' ? 'decided' : 'draft';
  const openAt = designOpenIndex(record);
  designEls.band.replaceChildren(...record.steps.map((step, index) => {
    const li = element('li');
    if (step.id === record.current) li.setAttribute('aria-current', 'step');
    li.dataset.state = step.stale ? 'stale' : step.chosen ? 'done' : 'open';
    const button = element('button', `${index + 1}. ${step.label}`);
    button.type = 'button';
    button.disabled = index > openAt || thinking;
    button.append(element('small', step.stale ? '確かめ直す' : step.chosen ? designChosenLabel(step) : 'まだ選んでいません'));
    button.addEventListener('click', () => goDesign(step.id));
    li.append(button);
    return li;
  }));
  if (thinking) return;
  const step = designCurrent(record);
  const index = record.steps.indexOf(step);
  designEls.stepHeading.textContent = `${index + 1}. ${step.label}: ${step.question}`;
  designEls.stepLead.textContent = step.lead;
  designEls.stale.hidden = !step.stale;
  designEls.basis.textContent = `案は今日の一番良い推測です(出した日: ${record.optionsDate}。${step.source === 'ai' ? 'AI が出した案' : 'Studio の決まった案'})。どの案も、まだ測っていません。`;
  designEls.options.replaceChildren(...step.options.map((option) => designOptionItem(option, step, record)));
  designEls.custom.hidden = step.id !== 'problem' && step.id !== 'users';
  if (step.id !== designUi.customFor) designEls.customText.value = step.chosen === 'custom' ? step.text ?? '' : '';
  designUi.customFor = step.id;
  const showScenes = step.id === 'scenes' && Boolean(step.chosen);
  designEls.scenesBox.hidden = !showScenes;
  if (showScenes) {
    const scenes = designUi.sceneDraft ?? record.scenes;
    designEls.scenes.replaceChildren(...scenes.map((scene, at) => designSceneItem(scene, at, record)));
  }
  if (step.id === 'data') renderDataBox(step);
  else {
    designEls.dataBox.hidden = true;
    designEls.shelf.hidden = true;
  }
  designEls.owner.hidden = step.id !== 'composition' || !record.ownerComposition;
  designEls.review.hidden = step.id !== 'composition' && !record.ready;
  designEls.noteBox.hidden = !step.chosen;
  if (document.activeElement !== designEls.note) designEls.note.value = step.note ?? '';
  designEls.prev.hidden = index === 0;
  const last = index === record.steps.length - 1;
  designEls.next.hidden = last;
  designEls.next.disabled = !step.chosen;
  designEls.build.hidden = !last;
  designEls.build.disabled = !record.ready;
  designEls.again.hidden = false;
}

function showDesign(record) {
  designUi.record = record;
  renderDesign();
  // 別のタブや読み込み直しで案を作っている最中なら、終わるまで読み直す
  clearTimeout(designUi.timer);
  if (designUi.open && !designUi.waiting && record?.thinking) {
    const { seq } = designUi;
    designUi.timer = setTimeout(async () => {
      try {
        const { design } = await api(designPath(designUi.projectId));
        if (seq === designUi.seq) showDesign(design);
      } catch (error) {
        if (seq === designUi.seq) handleError(error);
      }
    }, 1000);
  }
}

async function refreshDesignList() {
  if (designUi.open && designUi.projectId) selectedId = designUi.projectId;
  lastSnapshot = '';
  await refresh();
}

async function openDesign() {
  const project = selectedProject();
  if (!project) return;
  if (designUi.open && designUi.projectId === project.id) return;
  if (project.meeting?.status === 'waiting') return openMeeting(project.id);
  leaveIntent();
  closeOrganize();
  closeMeeting();
  closeReview();
  designUi.seq += 1;
  const { seq } = designUi;
  designUi.open = true;
  designUi.projectId = project.id;
  designUi.record = null;
  designUi.waiting = false;
  designUi.declined = false;
  designUi.sceneDraft = null;
  designError(null);
  renderDesign();
  try {
    const { design } = await api(designPath(project.id));
    if (seq !== designUi.seq) return;
    showDesign(design);
    designEls.heading.focus();
  } catch (error) {
    if (seq === designUi.seq) handleError(error);
  }
}

function closeDesign() {
  designUi.seq += 1;
  clearTimeout(designUi.timer);
  if (!designUi.open) return;
  if (consent.card?.use === 'design') consent.card = null;
  designUi.open = false;
  designUi.projectId = null;
  designUi.record = null;
  designUi.waiting = false;
  designUi.declined = false;
  designUi.sceneDraft = null;
  designUi.customFor = null;
  designEls.customText.value = '';
  designError(null);
  renderDesign();
}

// 案を作る。本物の AI は、同意の前はサーバーが断る。guide が fixed なら AI を呼ばない
async function startDesign(guide) {
  const id = designUi.projectId;
  if (!id || designUi.waiting) return;
  designError(null);
  designUi.waiting = true;
  designUi.declined = false;
  renderDesign();
  const { seq } = designUi;
  try {
    const { design } = await api(designPath(id, 'start'), { method: 'POST', json: { guide } });
    if (seq !== designUi.seq) return;
    designUi.waiting = false;
    showDesign(design);
    await refreshDesignList();
  } catch (error) {
    if (seq !== designUi.seq) return;
    designUi.waiting = false;
    renderDesign();
    if (error instanceof ApiError && error.code === 'consent-required') {
      const view = await api('/api/real-ai');
      if (seq !== designUi.seq) return;
      setConsentState(view.consent);
      if (view.consent.agreed) return startDesign(guide);
      openConsentDetails.delete('card');
      consent.card = { use: 'design', projectId: null, view };
      renderDesignConsent();
      return;
    }
    designFailed(error);
  }
}

// 1 回の POST で、返った状態を出す
// dropScenes は、送った場面の書きかけを、返事を描く前に捨てる。
// 一覧の読み直しを待つ間に打った文を、後から捨てないため
async function designAct(action, body, { dropScenes = false } = {}) {
  const id = designUi.projectId;
  if (!id) return null;
  designError(null);
  const { seq } = designUi;
  try {
    const { design } = await api(designPath(id, action), { method: 'POST', json: body ?? {} });
    if (seq !== designUi.seq) return null;
    if (dropScenes) designUi.sceneDraft = null;
    showDesign(design);
    await refreshDesignList();
    return design;
  } catch (error) {
    if (seq === designUi.seq) designFailed(error);
    return null;
  }
}

// 書きかけの場面と理由を保存する。保存できなければ false(次の段へ進まない)
async function saveDesignDrafts() {
  const record = designUi.record;
  const step = designCurrent(record);
  if (designUi.sceneDraft) {
    const saved = await designAct('scenes', { scenes: designUi.sceneDraft }, { dropScenes: true });
    if (!saved) return false;
  }
  const note = designEls.note.value.trim();
  if (step.chosen && note !== (step.note ?? '')) {
    if (!(await designAct('choose', { step: step.id, option: step.chosen, text: step.text ?? undefined, note }))) return false;
  }
  return true;
}

// 案を選ぶ。同じ案を押し直すときは、直している場面を一緒に保存する。別の案を選ぶと、その案の場面に入れ替わる
async function chooseDesign(step, option) {
  const same = designCurrent(designUi.record).chosen === option;
  const scenes = same && designUi.sceneDraft ? designUi.sceneDraft : undefined;
  await designAct('choose', { step, option, note: designEls.noteBox.hidden ? undefined : designEls.note.value.trim(), scenes }, { dropScenes: true });
}

async function goDesign(step) {
  if (!(await saveDesignDrafts())) return;
  if (await designAct('go', { step })) {
    designEls.note.value = designCurrent(designUi.record).note ?? '';
    designEls.stepHeading.scrollIntoView?.({ block: 'nearest' });
  }
}

// 「この設計で作る」。「決めた」の印を付け、AI 構成の審査を開く。依頼は審査の「この構成で作る」で送る
async function buildFromDesign() {
  const id = designUi.projectId;
  if (!id || !(await saveDesignDrafts())) return;
  designError(null);
  try {
    // 決めたら、作る前に AI 構成の審査へ進む(4 つを承認してから作る。ai-architecture-review.md)
    await api(designPath(id, 'decide'), { method: 'POST' });
    selectedId = id;
    lastSnapshot = '';
    await refresh();
    await openReview(id);
  } catch (error) {
    designFailed(error);
  }
}

designEls.sceneCategory.append(...Object.entries({ normal: 'うまくいく', unknown: '分からない', refuse: '断る', slow: '遅い', human: '人に渡す' }).map(([value, label]) => {
  const option = element('option', label);
  option.value = value;
  return option;
}));
designEls.mark.addEventListener('click', openDesign);
designEls.start.addEventListener('click', () => startDesign('ai'));
$('design-use-fixed').addEventListener('click', () => startDesign('fixed'));
$('design-stop').addEventListener('click', () => {
  if (designUi.projectId) api(designPath(designUi.projectId, 'cancel'), { method: 'POST' }).catch(designFailed);
});
designEls.custom.addEventListener('submit', async (event) => {
  event.preventDefault();
  const text = designEls.customText.value.trim();
  if (!text) {
    designError('自分の言葉を書いてください。');
    return;
  }
  await designAct('choose', { step: designUi.record.current, option: 'custom', text });
});
$('design-scene-add').addEventListener('submit', (event) => {
  event.preventDefault();
  const text = designEls.sceneText.value.trim();
  if (!text) {
    designError('足す場面の文を書いてください。');
    return;
  }
  designError(null);
  designUi.sceneDraft ??= structuredClone(designUi.record.scenes);
  designUi.sceneDraft.push({ category: designEls.sceneCategory.value, text });
  designEls.sceneText.value = '';
  renderDesign();
});
designEls.prev.addEventListener('click', () => {
  const { record } = designUi;
  goDesign(record.steps[record.steps.indexOf(designCurrent(record)) - 1].id);
});
designEls.next.addEventListener('click', () => {
  const { record } = designUi;
  goDesign(record.steps[record.steps.indexOf(designCurrent(record)) + 1].id);
});
designEls.build.addEventListener('click', buildFromDesign);
designEls.again.addEventListener('click', () => startDesign('ai'));
// 戻るときは、書きかけの場面と理由を残す。保存できなければ、画面に残る
$('design-back').addEventListener('click', async () => {
  if (!designUi.record?.steps?.length || (await saveDesignDrafts())) closeDesign();
});
designEls.skip.addEventListener('click', async () => {
  if (await designAct('skip')) closeDesign();
});

// ---- AI 構成の審査(docs/design/ai-architecture-review.md)----
// 4 つ(エージェントの構成、harness、データと RAG、技術の組)を上から順に並べ、欄ごとに承認する。4 つそろうまで「この構成で作る」は押せない。
// 構成を選び直すと、4 つの承認は全部消える(サーバーが消す)。中身はどれも Studio が今のファイルから書いたもので、画面は出すだけ
const reviewPath = (id, action = '') => `/api/projects/${encodeURIComponent(id)}/review${action ? `/${action}` : ''}`;
const reviewUi = { open: false, projectId: null, record: null, seq: 0, busy: false };
const reviewEls = {
  section: $('review'),
  heading: $('review-heading'),
  count: $('review-count'),
  state: $('review-state'),
  basis: $('review-basis'),
  schematic: $('review-schematic'),
  flow: $('review-flow'),
  fingerprint: $('review-fingerprint'),
  stopped: $('review-stopped'),
  stoppedText: $('review-stopped-text'),
  who: $('review-who'),
  pressed: $('review-pressed'),
  spoken: $('review-spoken'),
  spokenLabel: $('review-spoken-label'),
  items: $('review-items'),
  unseen: $('review-unseen'),
  approve: $('review-approve'),
  build: $('review-build'),
  measure: $('review-measure'),
  toDesign: $('review-to-design'),
  skipBox: $('review-skip-box'),
  skipReason: $('review-skip-reason'),
  message: $('review-message'),
  error: $('review-error'),
  mark: $('review-mark'),
};
const REVIEW_MARKS = { drafting: '審査: 承認 {n} / 4', approved: '審査: 承認済み', stopped: '審査: 承認と違う構成', skipped: '審査なし', missing: '審査: 記録がありません' };
const FIGURE_KIND_LABELS = { person: '人', ai: 'AI', code: 'コード', tool: 'ツール' };

function renderReviewMark(project) {
  const summary = project?.review ?? { status: 'none' };
  reviewEls.mark.hidden = !project || summary.status === 'none' || (intentUi.view === 'start' && !intentUi.projectId);
  reviewEls.mark.textContent = (REVIEW_MARKS[summary.status] ?? '').replace('{n}', String(summary.approved ?? 0));
  reviewEls.mark.dataset.state = summary.status === 'approved' ? 'decided' : summary.status === 'skipped' ? 'none' : 'draft';
}

function reviewError(text) {
  reviewEls.error.hidden = !text;
  reviewEls.error.textContent = text ?? '';
}

function reviewMessage(text) {
  reviewEls.message.hidden = !text;
  reviewEls.message.textContent = text ?? '';
}

function reviewFailed(error) {
  if (error instanceof ApiError && !['offline', 'token'].includes(error.code)) reviewError(`進められませんでした: ${error.message}`);
  else handleError(error);
}

// 構成の図。人、AI、コード、ツールの箱を、使う人からの近さで列に並べ、矢印でつなぐ
function compositionFigureSvg(figure, label) {
  const depth = new Map([['user', 0]]);
  const queue = ['user'];
  while (queue.length > 0) {
    const from = queue.shift();
    for (const edge of figure.edges.filter((item) => item.from === from)) {
      if (depth.has(edge.to)) continue;
      depth.set(edge.to, depth.get(from) + 1);
      queue.push(edge.to);
    }
  }
  for (const node of figure.nodes) if (!depth.has(node.id)) depth.set(node.id, 1);
  const columns = new Map();
  for (const node of figure.nodes) {
    const at = depth.get(node.id);
    columns.set(at, [...(columns.get(at) ?? []), node]);
  }
  const width = 170;
  const height = 46;
  const gapX = 70;
  const gapY = 24;
  const rows = Math.max(...[...columns.values()].map((nodes) => nodes.length));
  const boxes = new Map();
  for (const [column, nodes] of columns) {
    nodes.forEach((node, index) => boxes.set(node.id, { x: 10 + column * (width + gapX), y: 10 + index * (height + gapY), w: width, h: height }));
  }
  const totalW = 20 + columns.size * width + (columns.size - 1) * gapX;
  const totalH = 20 + rows * height + (rows - 1) * gapY;
  const described = `${label}。${figure.nodes.map((node) => `${FIGURE_KIND_LABELS[node.kind] ?? ''} ${node.label}`).join('、')}。${figure.edges.map((edge) => `${figure.nodes.find((n) => n.id === edge.from)?.label ?? edge.from} から ${figure.nodes.find((n) => n.id === edge.to)?.label ?? edge.to} へ ${edge.label}`).join('。')}`;
  const svg = svgNode('svg', { viewBox: `0 0 ${totalW} ${totalH}`, role: 'img', 'aria-label': described, class: 'data-figure review-figure' });
  const marker = `review-arrow-${Math.random().toString(36).slice(2, 8)}`;
  const defs = svgNode('defs');
  const arrow = svgNode('marker', { id: marker, viewBox: '0 0 10 10', refX: 10, refY: 5, markerWidth: 8, markerHeight: 8, orient: 'auto-start-reverse' });
  arrow.append(svgNode('path', { d: 'M 0 0 L 10 5 L 0 10 z', class: 'link-arrow' }));
  defs.append(arrow);
  svg.append(defs);
  for (const edge of figure.edges) {
    const from = boxes.get(edge.from);
    const to = boxes.get(edge.to);
    if (!from || !to) continue;
    const backward = to.x <= from.x;
    const start = { x: backward ? from.x + from.w / 2 : from.x + from.w, y: backward ? from.y + from.h : from.y + from.h / 2 };
    const end = { x: backward ? to.x + to.w / 2 : to.x, y: backward ? to.y : to.y + to.h / 2 };
    svg.append(svgNode('line', { x1: start.x, y1: start.y, x2: end.x, y2: end.y, class: 'link-line', 'marker-end': `url(#${marker})` }));
    svg.append(svgNode('text', { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 - 4, 'text-anchor': 'middle', class: 'link-label' }, edge.label));
  }
  for (const node of figure.nodes) {
    const box = boxes.get(node.id);
    svg.append(svgNode('rect', { x: box.x, y: box.y, width: box.w, height: box.h, rx: node.kind === 'person' ? 22 : 6, class: `entity-box figure-${node.kind}` }));
    svg.append(svgNode('text', { x: box.x + 8, y: box.y + 17, class: 'entity-key' }, FIGURE_KIND_LABELS[node.kind] ?? ''));
    svg.append(svgNode('text', { x: box.x + 8, y: box.y + 35, class: 'entity-name' }, node.label.slice(0, 16)));
  }
  return svg;
}

const usd = (value) => `${value.toFixed(value < 0.01 ? 4 : 2)} USD`;

// 案の数(想像図の 1 の数)。同じ場面の一覧を回した結果だけを出す。回していなければ「まだ測っていない」
function metricsBlock(metrics) {
  const box = element('div', undefined, 'review-metrics');
  if (!metrics) {
    box.append(element('p', '数: まだ測っていない。「お試しの AI で場面を回す」で形を確かめられます。本物の AI で測るのは、人が頼んだときだけです。', 'muted'));
    return box;
  }
  const how = metrics.real ? `本物の AI で回した(${formatTime(metrics.measuredAt)}。${metrics.model ?? 'モデル不明'}、${metrics.round} 回目)` : `お試しの AI で回した(${formatTime(metrics.measuredAt)})。形の確かめだけで、案の良し悪しの根拠にしません`;
  box.append(element('p', how, metrics.real ? undefined : 'muted'));
  if (metrics.stale) box.append(element('p', '回した後に場面の一覧が変わったので、この数は古いです。', 'review-warn'));
  const table = element('table');
  table.setAttribute('aria-label', 'この構成の数');
  const rows = [
    ['通った場面', `${metrics.passed} / ${metrics.total}`],
    ['道具の正しさ', metrics.toolRecall === null ? `呼ぶべき道具を確かめる場面なし(呼んだ回数 ${metrics.toolCalls}、誤った呼び出し ${metrics.wrongCalls})` : `${Math.round(metrics.toolRecall * 100)}%(誤った呼び出し ${metrics.wrongCalls})`],
    ['1 会話の費用', metrics.costPerConversationUsd === null ? 'お試しの AI なので費用はかかりません' : usd(metrics.costPerConversationUsd)],
    ['待ち時間(返事の中央値)', metrics.real && metrics.medianReplySeconds !== null ? `${metrics.medianReplySeconds} 秒` : 'お試しの AI なので測れません'],
  ];
  const tbody = element('tbody');
  for (const [name, value] of rows) {
    const tr = element('tr');
    tr.append(element('th', name), element('td', value));
    tr.firstChild.setAttribute('scope', 'row');
    tbody.append(tr);
  }
  table.append(tbody);
  box.append(table);
  return box;
}

function reviewTable(label, heads, rows) {
  const table = element('table');
  table.setAttribute('aria-label', label);
  const headRow = element('tr');
  for (const name of heads) headRow.append(element('th', name));
  const thead = element('thead');
  thead.append(headRow);
  const tbody = element('tbody');
  for (const cells of rows) {
    const tr = element('tr');
    cells.forEach((cell, index) => {
      const td = element(index === 0 ? 'th' : 'td');
      if (index === 0) td.setAttribute('scope', 'row');
      if (cell instanceof Node) td.append(cell);
      else td.textContent = cell;
      tr.append(td);
    });
    tbody.append(tr);
  }
  table.append(thead, tbody);
  return table;
}

function reviewCompositionBody(record) {
  const c = record.composition;
  const body = [];
  const group = element('div', undefined, 'review-switch');
  group.setAttribute('role', 'group');
  group.setAttribute('aria-label', '構成を切り替える');
  for (const option of c.options) {
    const button = element('button');
    button.type = 'button';
    button.append(element('strong', option.label), element('small', option.plain), element('small', option.metrics ? `${option.metrics.real ? '本物の AI' : 'お試しの AI'}: ${option.metrics.passed} / ${option.metrics.total} 通った` : 'まだ測っていない'));
    button.setAttribute('aria-pressed', String(c.shape === option.id));
    button.disabled = reviewUi.busy || !c.choosable || !option.available || Boolean(record.stopped);
    button.addEventListener('click', () => {
      if (c.shape !== option.id) reviewAct('choose', { composition: option.id });
    });
    group.append(button);
  }
  body.push(group);
  body.push(element('p', c.choosable ? '構成を選び直すと、4 つの承認は全部消えます。Studio が構成のファイルを書き直します。' : '今の構成をそのまま審査します。Studio は書き換えません。', 'muted'));
  const choice = c.options.find((option) => option.id === c.shape);
  body.push(element('p', choice ? `${choice.label}: ${choice.plain}。順番を決めるもの: ${choice.decidedBy}。モデルの役目: ${choice.modelRole}。` : `${c.label}。`));
  body.push(compositionFigureSvg(c.figure, `${c.label}の図`));
  if (c.recommended) {
    const scenes = c.basisScenes.length > 0 ? c.basisScenes.map((scene) => `${scene.id}${scene.verdict ? `(${scene.verdict === 'passed' ? '通った' : scene.verdict === 'failed' ? '通らなかった' : scene.verdict})` : ''}`).join('、') : 'なし';
    // おすすめには、札、日付、根拠の場面、「推測」を付ける。「理想の作り」とは言い切らない(ui-ux-v2.md の 9 節)
    const p = element('p', undefined, 'review-recommend');
    const guess = element('span', '推測', 'badge review-guess');
    p.append(element('span', 'おすすめ', 'badge'), document.createTextNode(' '), element('strong', c.recommended.label), document.createTextNode(' '), guess, document.createTextNode(`。理由: ${c.recommended.reason}。出した日: ${c.recommended.date ?? '不明'}(${c.recommended.source === 'ai' ? 'AI が出した案' : 'Studio の決まった案'}。その日の推測です)。根拠の場面: ${scenes}${record.evidence.status === 'unmeasured' ? '(まだ回していない下書き)' : ''}。`));
    body.push(p);
    if (c.recommended.option !== c.shape) body.push(element('p', `おすすめと違う「${c.label}」を選んでいます。${c.outOfOrder ? '簡単な方から問う順を飛ばして選んだ印が、AI 構成書に残ります。' : ''}`, 'review-warn'));
  }
  if (c.answers.length > 0) {
    const list = element('ol', undefined, 'review-answers');
    list.setAttribute('aria-label', '簡単な方から順の問い');
    for (const answer of c.answers) list.append(element('li', `${answer.question} → ${answer.answer}(${answer.basis}${answer.evalIds.length > 0 ? `。通らなかった場面: ${answer.evalIds.join('、')}` : ''})`));
    body.push(list);
  }
  body.push(metricsBlock(c.metrics));
  return body;
}

function reviewHarnessBody(record) {
  const h = record.harness;
  const body = [element('p', 'harness は、AI の周りで決まりを守らせるコードです。行ごとに、決めるのがコードかモデルか人かを出します。「モデル頼み」はコードで縛れず、モデルに頼るしかない所です。', 'muted')];
  body.push(reviewTable('harness の部品', ['部品', 'この案での中身', '決めるのは', '今の Studio にあるか'], h.rows.map((row) => {
    const who = element('span', row.decidedByLabel);
    if (row.modelOnly) who.append(element('span', 'モデル頼み', 'review-badge'));
    return [row.part, row.content, who, row.inStudio];
  })));
  body.push(element('p', `モデルに任せる: ${h.modelDecides.join('、') || 'なし'}。コードで縛る: ${h.codeBinds.join('、') || 'なし'}。人が決める: ${h.humanDecides.join('、') || 'なし'}。`));
  const details = element('details', undefined, 'review-prompts');
  details.append(element('summary', `プロンプトの全文を読む(${h.prompts.length} つ)`));
  for (const prompt of h.prompts) {
    details.append(element('h4', `${prompt.label}(${prompt.participant})`));
    details.append(element('pre', prompt.text));
  }
  body.push(details);
  return body;
}

function reviewDataBody(record) {
  const { shelf, rag, source } = record.data;
  const body = [element('p', `AI が読むデータの棚です(${source === 'data-design' ? '設計の案内のデータ設計から' : '試作品のツールとデータから'} Studio が書いた下書き)。変わる速さと個人情報は、本番のデータの話として確かめてください。`, 'muted')];
  body.push(shelf.length > 0 ? shelfTable(shelf, { tools: true }) : element('p', 'AI が読むデータは、まだありません。', 'muted'));
  const box = element('div', undefined, 'design-rag');
  box.setAttribute('role', 'group');
  box.setAttribute('aria-label', 'RAG の判定(審査)');
  const verdict = element('p', `RAG(文書から探した部分を AI に読ませる仕組み): ${rag.verdict}(${rag.note})`, 'design-rag-verdict');
  verdict.dataset.needed = String(rag.needed);
  box.append(verdict, element('p', `理由: ${rag.reason}。`));
  if (rag.addWhen) box.append(element('p', `足す条件: ${rag.addWhen}。`));
  if (rag.decide) {
    const list = element('ul');
    for (const item of rag.decide) list.append(element('li', `${item.label}: ${item.question}(試作品では: ${item.prototype})`));
    box.append(element('p', 'RAG を足すなら決めること'), list);
  }
  body.push(box);
  return body;
}

function reviewStackBody(record) {
  const { rows, note } = record.stack;
  return [
    element('p', `試作品で使うものは、今のファイルから Studio が書きました。${note} 試作品の組は、本番の品質を約束しません。`, 'muted'),
    reviewTable('技術の組', ['部品', '試作品で使うもの', '本番の候補(案。未接続)'], rows.map((row) => [`${row.part}(${row.plain})`, row.prototype, row.candidates.join(' / ')])),
  ];
}

const REVIEW_BODIES = { composition: reviewCompositionBody, harness: reviewHarnessBody, data: reviewDataBody, stack: reviewStackBody };

// 欄ごとの言葉(ui-ux-v2.md の 4.1)。term は見出しの横の語、hint はその場での 1 行。「これは何?」の 3 つの問いは guide.js の EXPLAINS(review-欄の id)
const REVIEW_TEXTS = {
  composition: {
    term: 'agent setup',
    hint: '次の一手を、コードが決めるかモデルが決めるかを読みます。違えば、選び直せます。',
  },
  harness: {
    term: 'ふだんの言葉: AI の周りの決まり',
    hint: '任せる所と縛る所を読みます。違えば、言葉で直せます。',
  },
  data: {
    term: '何をどう読むか',
    hint: '読むものと、個人情報の扱いを読みます。',
  },
  stack: {
    term: '試作品と本番の候補',
    hint: '試作品で使うものと、本番の候補を読みます。候補は案で、決定ではありません。',
  },
};

// 欄の 4 つの状態。印と文で分け、色だけに頼らない(10.4 の札)
const REVIEW_STATES = {
  approved: { mark: '✓', text: '承認した', tone: 'ok' },
  reading: { mark: '●', text: '読んでいる', tone: 'accent' },
  unseen: { mark: '○', text: 'まだ見ていない', tone: '' },
  lost: { mark: '!', text: '承認が消えた', tone: 'warn' },
};

// 流れ図の部品の種類。コードは実線、モデルは点線、守りは関門と守りの色の縁(10.4)
const FLOW_KINDS = { person: '人', code: 'コード', model: 'モデル', data: 'データ', guard: '守り' };
const FLOW_DRIVERS = {
  'fixed-flow': ['code', '固定の流れ'],
  'single-agent': ['model', '1 つの AI が回す'],
  'master-sub': ['model', '親の AI が子に任せる'],
  handoff: ['model', 'AI 同士の引き継ぎ'],
  none: ['code', 'AI なし'],
};

// 読んでいる欄。止まっているとき、飛ばしたときはない。それ以外は、上から見て最初の承認していない欄
function readingItem(record) {
  if (!record?.items?.length || record.stopped || record.status === 'skipped') return null;
  return record.items.find((item) => !item.approved) ?? null;
}

// 次に押す承認(読んでいる欄と、まだ承認していない役)
function nextApproval(record) {
  const item = readingItem(record);
  if (!item) return null;
  const role = item.needs.find((need) => !item.by.some((entry) => entry.role === need && entry.valid));
  return role ? { item, role } : null;
}

// 英字で終わる名前(harness、データと RAG)の後ろには、空白を 1 つ置く
const spaced = (label) => (/[A-Za-z0-9]$/.test(label) ? `${label} ` : label);

function reviewItemState(item, reading) {
  if (item.approved) return 'approved';
  if (item.lost) return 'lost';
  return item === reading ? 'reading' : 'unseen';
}

// 承認が消えた理由(5.4 の「承認が消えた」)。「〜ので、この欄の承認を消しました。」の「〜」の所
function lostBecause(record, item) {
  const lost = item.lost;
  if (lost.reason === 'choose') {
    const label = record.items.find((entry) => entry.id === lost.item)?.label ?? 'エージェントの構成';
    return `${label}を選び直した`;
  }
  if (lost.reason === 'comment') return `コメント ${lost.number} から審査に戻した`;
  return '承認の後に中身が変わった';
}

// 流れ図の部品。items は、その部品に関係する欄(読んでいる欄の部品の縁を強くする)
function reviewFlowNodes(record) {
  const shape = record.composition?.shape;
  const [kind, name] = FLOW_DRIVERS[shape] ?? ['code', record.composition?.label ?? '流れ'];
  const shelf = record.data?.shelf?.length ?? 0;
  const nodes = [{ kind: 'person', name: '使う人', items: [] }, { kind, name, items: ['composition', 'stack'] }];
  if (shape !== 'none') nodes.push({ kind: 'model', name: '言葉を読む、文を作る', items: ['harness', 'stack'] });
  nodes.push({ kind: 'data', name: shelf > 0 ? `読むもの ${shelf} 種` : '読むものなし', items: ['data'] });
  nodes.push({ kind: 'guard', name: '3 つの層', items: ['harness'] });
  nodes.push({ kind: 'person', name: '返事', items: [] });
  return nodes;
}

function renderReviewFlow(record) {
  reviewEls.flow.replaceChildren(...reviewFlowNodes(record).map((node) => {
    const li = element('li', undefined, 'node');
    li.dataset.kind = node.kind;
    li.dataset.items = node.items.join(' ');
    const tag = element('span', FLOW_KINDS[node.kind], 'tag');
    tag.dataset.kind = node.kind;
    li.append(tag, element('span', node.name, 'node-name'));
    return li;
  }));
}

// 流れ図で、その欄に関係する部品の縁を強くする。id がなければ、どれも強くしない
function highlightFlow(id) {
  for (const node of reviewEls.flow.children) {
    if (id && node.dataset.items.split(' ').includes(id)) node.dataset.focus = 'true';
    else delete node.dataset.focus;
  }
  reviewEls.flow.dataset.focusItem = id ?? '';
}

// 「これは何?」(5.2)。開くと 3 つの問い。harness は、仕組みの引き出しのプロンプトへの道も出す
function reviewExplain(item, { open = false } = {}) {
  return explainBox(`review-${item.id}`, { open, onMore: () => setDrawer('mechanism') });
}

// たたんだ欄の短い中身(1 行)
function reviewItemSummary(record, item) {
  if (item.id === 'composition') {
    const c = record.composition;
    const p = element('p', undefined, 'review-choice');
    p.append(element('strong', c.label));
    if (c.recommended?.option === c.shape) p.append(document.createTextNode(' '), Object.assign(element('span', 'おすすめ', 'badge'), { title: '案を出す AI のおすすめ(推測)' }));
    const others = c.options.filter((option) => option.id !== c.shape).map((option) => option.label);
    if (others.length > 0) p.append(document.createTextNode(`。ほかの案: ${others.join('、')}`));
    return p;
  }
  if (item.id === 'harness') {
    const h = record.harness;
    return element('p', `モデルに任せる: ${h.modelDecides.join('、') || 'なし'}。コードで縛る: ${h.codeBinds.length} つ。人が決める: ${h.humanDecides.join('、') || 'なし'}。`, 'review-choice');
  }
  if (item.id === 'data') {
    const { shelf, rag } = record.data;
    return element('p', `読むもの ${shelf.length} 種。RAG: ${rag.verdict}。`, 'review-choice');
  }
  const model = record.stack.rows.find((row) => row.id === 'model');
  return element('p', `試作品のモデル: ${model?.prototype ?? '不明'}。本番の候補は案で、まだつないでいません。`, 'review-choice');
}

// 承認した人と時刻(役ごと)
function reviewApprovals(record, item) {
  const done = item.by.filter((entry) => entry.valid);
  if (done.length === 0) return null;
  return element('p', done.map((entry) => `${record.roles[entry.role]}が承認(${formatTime(entry.at)}${entry.pressedBy ? `。押した人: ${entry.pressedBy}` : ''}${entry.spokenBy ? `。声に出した人: ${entry.spokenBy}` : ''})`).join('・'), 'review-done');
}

function reviewItemNode(record, item, reading) {
  const state = reviewItemState(item, reading);
  const isReading = item === reading;
  const li = element('li', undefined, 'review-item-slot');
  const section = element('section', undefined, 'review-item design-data');
  section.dataset.item = item.id;
  section.dataset.state = state;
  section.dataset.approved = String(item.approved);
  if (isReading) {
    section.dataset.reading = 'true';
    section.setAttribute('aria-current', 'true');
  }
  section.setAttribute('aria-labelledby', `review-h-${item.id}`);
  // 欄の頭: 承認が消えた理由と、コメントから戻した項目
  if (item.lost) section.append(stateLine('lost', { because: lostBecause(record, item), className: 'review-lost' }));
  const comments = record.comments ?? [];
  if (comments.length > 0 && item === (reading ?? record.items[0])) {
    const list = element('ul', undefined, 'review-from-comments');
    list.setAttribute('aria-label', '審査に戻したコメント');
    list.append(...comments.map((c) => element('li', `コメントから: ${c.text}(コメント ${c.number}、${formatTime(c.at)})`)));
    section.append(list);
  }
  const head = element('div', undefined, 'review-item-head');
  const look = REVIEW_STATES[state];
  const badge = element('span', `${look.mark} ${look.text}`, 'badge review-state');
  if (look.tone) badge.dataset.tone = look.tone;
  const heading = element('h3', item.label);
  heading.id = `review-h-${item.id}`;
  heading.append(document.createTextNode(' '), element('span', REVIEW_TEXTS[item.id].term, 'review-term'));
  head.append(badge, heading);
  section.append(head);
  if (!isReading) {
    section.append(reviewItemSummary(record, item));
    const approvals = reviewApprovals(record, item);
    if (approvals) section.append(approvals);
    // たたんだ欄の中身は、頼んだら開く(読む順は変えない)
    const peek = element('details', undefined, 'review-peek');
    peek.append(element('summary', '中身を見る'), ...REVIEW_BODIES[item.id](record), reviewExplain(item));
    section.append(peek);
    li.append(section);
    return li;
  }
  if (record.thinking) {
    // 案を出す AI が作業中。中身の代わりに、待つ間に読むもの(3 つの問い)を先に出す
    section.append(element('p', '案を作っています。待つ間に、この欄の 3 つの問いを読めます。', 'review-thinking'), reviewExplain(item, { open: true }));
    li.append(section);
    return li;
  }
  const hint = element('p', REVIEW_TEXTS[item.id].hint, 'hint');
  hint.dataset.hint = `review-${item.id}`;
  section.append(hint, ...REVIEW_BODIES[item.id](record), reviewExplain(item));
  const approvals = reviewApprovals(record, item);
  if (approvals) section.append(approvals);
  // 欄の中のボタンは、弱いボタン「言葉で直す」だけ(4.1)。承認の前は作る AI が動かないので、設計の案内に戻って選び直す
  const actions = element('div', undefined, 'review-item-actions');
  const fix = element('button', '言葉で直す', 'quiet');
  fix.type = 'button';
  fix.title = '設計の案内に戻り、この欄の元になった段を選び直します';
  fix.disabled = reviewUi.busy;
  fix.addEventListener('click', reviewToDesign);
  actions.append(fix);
  section.append(actions);
  li.append(section);
  return li;
}

function renderReview() {
  scheduleFrame();
  const { open, record } = reviewUi;
  reviewEls.section.hidden = !open;
  if (open) document.body.dataset.design = 'open';
  else if (!designUi.open) delete document.body.dataset.design;
  const reviewing = Boolean(open && record?.items?.length && record.composition && !['none', 'missing', 'skipped'].includes(record.status));
  const asking = reviewing ? nextApproval(record) : null;
  reviewEls.who.hidden = !asking;
  reviewEls.approve.hidden = !asking;
  if (!open || !record) return;
  if (!reviewing) {
    reviewEls.count.textContent = '';
    reviewEls.basis.textContent = '';
    reviewEls.schematic.hidden = true;
    reviewEls.state.textContent = record.status === 'skipped' ? `審査を飛ばしました(${formatTime(record.skipped?.at)}。理由: ${record.skipped?.reason ?? '不明'})。「審査なし」の印のまま作れます。` : 'まだ審査を始めていません。設計の案内で「この設計で作る」を押すと始まります。';
    reviewEls.items.replaceChildren();
    reviewEls.unseen.hidden = true;
    reviewEls.build.hidden = true;
    reviewEls.measure.hidden = true;
    reviewEls.stopped.hidden = true;
    return;
  }
  reviewEls.measure.hidden = false;
  const left = record.total - record.approvedCount;
  reviewEls.count.textContent = `承認 ${record.approvedCount} / ${record.total}${left > 0 ? `・あと ${left} つ` : ''}`;
  reviewEls.count.dataset.ready = String(record.ready);
  const meeting = record.mode === 'meeting';
  reviewEls.spoken.hidden = !meeting;
  reviewEls.spokenLabel.hidden = !meeting;
  reviewEls.stopped.hidden = !record.stopped;
  if (record.stopped) {
    const labels = (record.stopped.items ?? []).map((id) => record.items.find((item) => item.id === id)?.label).filter(Boolean);
    reviewEls.stoppedText.textContent = `承認の後に AI の作りが変わったので、作るのを止めています。試す欄の試作品は、承認したときのままです(${formatTime(record.stopped.at)}。変わった所: ${labels.join('、') || '不明'})。審査に戻ると、変わった所だけ承認し直します。承認した構成に戻すと、構成のファイルだけを承認したときの中身に戻します。`;
  }
  reviewEls.state.textContent = record.status === 'approved'
    ? `${formatTime(record.approvedAt)}に 4 つを承認しました${record.approvedUnmeasured ? '(測らずに承認した印が残っています)' : ''}。`
    : record.evidence.status === 'unmeasured' && !record.stopped
      ? '数はまだ測っていません。測らずに承認すると、その印が残ります。'
      : '';
  reviewEls.state.hidden = !reviewEls.state.textContent;
  // 案の日付と根拠(9 節: 「理想の作り」と言い切らず、日付と根拠の場面と「推測」を付ける)
  const c = record.composition;
  reviewEls.basis.textContent = c.recommended ? `案は ${c.recommended.date ?? '日付不明'} 時点の推測です。根拠は、場面の一覧の ${c.basisScenes.length} つです。` : '案はありません。今の構成をそのまま読みます。';
  // 流れ図と、4 つそろったときの指紋
  reviewEls.schematic.hidden = false;
  renderReviewFlow(record);
  reviewEls.fingerprint.hidden = !record.ready;
  if (record.ready) {
    reviewEls.fingerprint.replaceChildren(element('span', 'AI 構成書の指紋', 'review-fingerprint-label'), element('code', `指紋 ${record.fingerprint.value.slice(0, 4)}…`));
    reviewEls.fingerprint.title = record.fingerprint.value;
  }
  const reading = readingItem(record);
  reviewEls.items.replaceChildren(...record.items.map((item) => reviewItemNode(record, item, reading)));
  const unseen = record.items.filter((item) => reviewItemState(item, reading) === 'unseen').length;
  reviewEls.unseen.hidden = unseen === 0;
  if (unseen > 0) fillState(reviewEls.unseen, 'unseen', { count: unseen, total: record.total });
  highlightFlow(reading?.id ?? null);
  renderHints();
  if (asking) {
    const { item, role } = asking;
    reviewEls.approve.textContent = item.needs.length === 1 && role === 'owner' ? `${spaced(item.label)}を承認する` : `${spaced(item.label)}を${record.roles[role]}として承認する`;
    reviewEls.approve.dataset.item = item.id;
    reviewEls.approve.dataset.role = role;
  }
  reviewEls.approve.disabled = reviewUi.busy || Boolean(record.thinking);
  // 4 つそろうまで「この構成で作る」は出さない(押せないボタンを置かない。10.4)
  reviewEls.build.hidden = !record.ready;
  reviewEls.build.disabled = reviewUi.busy;
  reviewEls.measure.disabled = reviewUi.busy || Boolean(record.stopped);
  reviewEls.toDesign.hidden = !designUi.lastProjectId || designUi.lastProjectId !== reviewUi.projectId;
}

async function openReview(projectId = selectedProject()?.id) {
  if (!projectId) return;
  leaveIntent();
  closeOrganize();
  closeMeeting();
  if (designUi.open) {
    designUi.lastProjectId = designUi.projectId;
    closeDesign();
  }
  reviewUi.seq += 1;
  const { seq } = reviewUi;
  reviewUi.open = true;
  reviewUi.projectId = projectId;
  reviewUi.record = null;
  reviewError(null);
  reviewMessage(null);
  renderReview();
  try {
    const { review } = await api(reviewPath(projectId));
    if (seq !== reviewUi.seq) return;
    reviewUi.record = review;
    renderReview();
    reviewEls.heading.focus();
  } catch (error) {
    if (seq === reviewUi.seq) reviewFailed(error);
  }
}

function closeReview() {
  reviewUi.seq += 1;
  if (!reviewUi.open) return;
  reviewUi.open = false;
  reviewUi.projectId = null;
  reviewUi.record = null;
  reviewError(null);
  reviewMessage(null);
  renderReview();
}

async function reviewAct(action, body = {}) {
  const id = reviewUi.projectId;
  if (!id || reviewUi.busy) return null;
  reviewError(null);
  reviewMessage(action === 'measure' ? 'お試しの AI で場面を回しています…' : null);
  reviewUi.busy = true;
  renderReview();
  const { seq } = reviewUi;
  try {
    const result = await api(reviewPath(id, action), { method: 'POST', json: body });
    if (seq !== reviewUi.seq) return null;
    reviewUi.record = result.review;
    reviewMessage(action === 'choose' ? '構成を選び直しました。4 つの承認は消えました。' : action === 'measure' ? 'お試しの AI で回しました。形の確かめだけです。' : action === 'back' ? '新しい審査にしました。変わった所だけ承認し直してください。' : action === 'restore' ? '構成のファイルを、承認したときの中身に戻しました。' : null);
    lastSnapshot = '';
    await refresh();
    return result;
  } catch (error) {
    if (seq === reviewUi.seq) {
      reviewMessage(null);
      reviewFailed(error);
    }
    return null;
  } finally {
    if (seq === reviewUi.seq) {
      reviewUi.busy = false;
      renderReview();
    }
  }
}

// 「この構成で作る」と「審査なしで作る」。依頼の文は、作る AI の欄と同じ道で送る(本物の AI の同意もその道で取る)
async function buildFromReview(action, body = {}) {
  const id = reviewUi.projectId;
  const result = await reviewAct(action, body);
  if (!result) return;
  if (!result.request) {
    reviewMessage(action === 'skip' ? '審査を飛ばしました。作る依頼は、試作品の画面の欄から送ってください。' : '承認しました。作る依頼は、試作品の画面の欄から送ってください。');
    return;
  }
  selectedId = id;
  closeReview();
  lastSnapshot = '';
  await refresh();
  els.requestText.value = result.request;
  await submitRequest();
}

// 設計の案内に戻る(「設計の案内に戻る」と、欄の「言葉で直す」)
async function reviewToDesign() {
  const id = reviewUi.projectId;
  closeReview();
  selectedId = id;
  render();
  await openDesign();
}

reviewEls.mark.addEventListener('click', () => openReview());
reviewEls.approve.addEventListener('click', () => {
  const { item, role } = reviewEls.approve.dataset;
  if (!item) return;
  sawHint(`review-${item}`);
  reviewAct('approve', { item, role, pressedBy: reviewEls.pressed.value.trim() || undefined, spokenBy: reviewEls.spoken.hidden ? undefined : reviewEls.spoken.value.trim() || undefined });
});
// 欄にカーソルや焦点が乗ったら、流れ図でその欄の部品を示す。離れたら、読んでいる欄に戻す
const reviewFocusOf = (event) => event.target.closest?.('.review-item')?.dataset.item ?? null;
const reviewReadingId = () => readingItem(reviewUi.record)?.id ?? null;
reviewEls.items.addEventListener('pointerover', (event) => highlightFlow(reviewFocusOf(event) ?? reviewReadingId()));
reviewEls.items.addEventListener('pointerleave', () => highlightFlow(reviewReadingId()));
reviewEls.items.addEventListener('focusin', (event) => highlightFlow(reviewFocusOf(event) ?? reviewReadingId()));
reviewEls.items.addEventListener('focusout', (event) => {
  if (!reviewEls.items.contains(event.relatedTarget)) highlightFlow(reviewReadingId());
});
reviewEls.build.addEventListener('click', () => buildFromReview('build'));
reviewEls.measure.addEventListener('click', () => reviewAct('measure'));
$('review-back').addEventListener('click', () => reviewAct('back'));
$('review-restore').addEventListener('click', () => reviewAct('restore'));
$('review-close').addEventListener('click', closeReview);
reviewEls.toDesign.addEventListener('click', reviewToDesign);
$('review-skip').addEventListener('click', () => {
  const reason = reviewEls.skipReason.value.trim();
  if (!reason) {
    reviewError('飛ばす理由を書いてください。');
    return;
  }
  buildFromReview('skip', { reason, by: reviewEls.pressed.value.trim() || undefined });
});

// 場面の一覧と比べる表(task 423。ai-architecture-review.md の 15 節。サーバーは src/server/scene-runs.js)。
// 試す欄の下に置く。場面の一覧を構成ごとに回し、通った数、道具の呼び方の正しさ、費用、待ち時間を並べる。
// 通らない場面の「直す」は、作る AI の欄に依頼を入れる(送るのは人)。本物の AI は、今の同意(consent の use が evals)と費用の上限を通す。
// data はサーバーの中身、version は読んだときの一覧の版(projects の scenes.version が変わったら読み直す)
const sceneUi = { projectId: null, data: null, version: null, seq: 0, starting: false, message: null };
const sceneEls = {
  box: $('scene-runs'),
  summary: $('scene-runs-summary'),
  runMock: $('scene-run-mock'),
  runReal: $('scene-run-real'),
  limit: $('scene-limit'),
  cancel: $('scene-cancel'),
  realNote: $('scene-real-note'),
  consent: $('scene-consent'),
  status: $('scene-status'),
  table: $('scene-table'),
  list: $('scene-list'),
  listSummary: $('scene-list-summary'),
};
const SCENE_STATUS = { done: '終わった', stopped: '途中で止めた', error: '途中で失敗した', running: '回している' };
const sceneUsd = (value) => `${value.toFixed(value < 0.01 ? 4 : 2)} USD`;

// 読み直す印。回しの版(場面を 1 つ回すごとに上がる)、場面の数、表示中の版(ビルドで場面の一覧が変わる)
const sceneKey = (project) => JSON.stringify([project.scenes?.version ?? 0, project.scenes?.count ?? 0, project.previewUrl ?? null]);

// 印が変わったら、場面の中身を読み直す。force は欄を開いたとき(ターミナルや審査の画面で回した結果も読むため)
async function syncScenes(project, { force = false } = {}) {
  const id = project?.id ?? null;
  if (sceneUi.projectId !== id) Object.assign(sceneUi, { projectId: id, data: null, version: null, message: null });
  if (!id || !(project.scenes?.count > 0 || sceneUi.data)) {
    renderScenes(project);
    return;
  }
  const key = sceneKey(project);
  if (!force && sceneUi.version === key && sceneUi.data) return;
  const seq = ++sceneUi.seq;
  try {
    const { scenes } = await api(`/api/projects/${encodeURIComponent(id)}/scenes`);
    if (seq !== sceneUi.seq || sceneUi.projectId !== id) return;
    sceneUi.data = scenes;
    sceneUi.version = key;
  } catch (error) {
    if (seq === sceneUi.seq) handleError(error);
  }
  renderScenes(selectedProject());
}

function sceneTable(last) {
  const table = element('table');
  table.setAttribute('aria-label', '構成ごとの比べる表');
  const head = element('tr');
  // 測った数(コードで確かめた結果)と、AI の判断(自然さの採点)は別の列。AI の判断の列は頭に「AI の判断」と書く(ui-ux-v2.md の 4.2)
  for (const name of ['構成', '回した AI', '通った場面(測った数)', '道具の呼び方の正しさ(ツールの再現率)', 'AI の判断: 自然さの採点', '費用', '待ち時間(返事の中央値)']) {
    const th = element('th', name);
    th.setAttribute('scope', 'col');
    if (name.startsWith('AI の判断')) th.dataset.judge = 'true';
    head.append(th);
  }
  const thead = element('thead');
  thead.append(head);
  const tbody = element('tbody');
  for (const row of last.rows) {
    const tr = element('tr');
    tr.dataset.row = row.key;
    const name = element('th');
    name.setAttribute('scope', 'row');
    name.append(document.createTextNode(row.composition.name), element('small', [row.composition.shapeLabel, row.composition.file].filter(Boolean).join('・')));
    const who = row.real ? `本物の AI${row.assumption?.model ? `(${row.assumption.model}${row.assumption.standIn ? '。代わりのモデル' : ''})` : ''}` : 'お試しの AI';
    const passed = `${row.passed} / ${row.ran}${row.failed + row.errors > 0 ? `(通らない ${row.failed + row.errors})` : ''}${row.unjudged > 0 ? `(採点していない ${row.unjudged})` : ''}${row.stopped > 0 ? `(途中で止めた ${row.stopped})` : ''}${row.notApplicable > 0 ? `(当てはまらない ${row.notApplicable})` : ''}`;
    const tools = row.toolRecall === null ? `確かめる場面なし(呼んだ ${row.toolCalls} 回、誤った呼び出し ${row.wrongCalls})` : `${Math.round(row.toolRecall * 100)}%(誤った呼び出し ${row.wrongCalls})`;
    const cost = row.real
      ? `${sceneUsd(row.costUsd ?? 0)}${row.costPerConversationUsd !== null ? `(1 会話 ${sceneUsd(row.costPerConversationUsd)})` : ''}${row.judgeCostUsd > 0 ? `。ほかに採点 ${sceneUsd(row.judgeCostUsd)}` : ''}`
      : 'かかりません';
    const wait = row.real ? (row.medianReplySeconds !== null ? `${row.medianReplySeconds} 秒` : '-') : '測れません(お試しの AI)';
    tr.append(name);
    for (const text of [who, passed, tools]) tr.append(element('td', text));
    const judgeCell = element('td', judgeText(row));
    judgeCell.dataset.judge = 'true';
    tr.append(judgeCell);
    for (const text of [cost, wait]) tr.append(element('td', text));
    tbody.append(tr);
  }
  table.append(thead, tbody);
  return table;
}

// 開発向けの元の文(CLI の引数の名前などが入りうる)は、閉じた開く操作の中に置く(8 節。見える文字に開発の言葉を出さない)
function sceneDevNote(summary, text) {
  const box = element('details', undefined, 'card-dev');
  box.append(element('summary', summary), element('p', text));
  return box;
}

// AI の判断(自然さの採点)の列の文。採点は本物の AI で回したときだけ(お試しの AI では採点しない)
function judgeText(row) {
  const judge = row.judge ?? { passed: 0, failed: 0, unjudged: 0 };
  const judged = judge.passed + judge.failed;
  if (judged + judge.unjudged === 0) return '採点する場面なし';
  if (judged === 0) return `採点していません(${judge.unjudged} つ)`;
  return `基準以上 ${judge.passed} / ${judged}${judge.unjudged > 0 ? `(採点していない ${judge.unjudged})` : ''}`;
}

// 場面の 3 つの状態(4.2)。✓ 通った、× 通らない、○ まだ回していない。「まだ」は「通った」と同じ見た目にしない
const SCENE_STATES = {
  passed: { mark: '✓', word: '通った', state: 'ok' },
  failed: { mark: '×', word: '通らない', state: 'failed' },
  error: { mark: '×', word: '通らない(回せなかった)', state: 'failed' },
  stopped: { mark: '○', word: '途中で止めた', state: 'todo' },
  unjudged: { mark: '○', word: '採点していない', state: 'todo' },
  'n/a': { mark: '─', word: '当てはまらない', state: 'skipped' },
  none: { mark: '○', word: 'まだ回していない', state: 'todo' },
};

// 場面ごとの結果。前の回しの後に場面が変わった(stale)ものと、回していないものは「まだ回していない」
function sceneVerdict(last, id) {
  return (last && last.verdicts?.[id]) || 'none';
}

// 通らない場面の数と、場面のタブの名前の数(「場面 4/6 通った」)
function sceneCounts(data) {
  const scenes = data?.scenes ?? [];
  const last = data?.last ?? null;
  const verdicts = scenes.map((scene) => sceneVerdict(last, scene.id));
  return {
    total: scenes.length,
    passed: verdicts.filter((v) => v === 'passed').length,
    failed: verdicts.filter((v) => v === 'failed' || v === 'error').length,
    ran: verdicts.filter((v) => v !== 'none').length,
  };
}

// 場面を直す依頼の文。前の回しの「直す」の文(確かめと構成の名前が入る)があれば、それを使う
function sceneRequest(last, scene) {
  const failure = (last?.failures ?? []).find((item) => item.id === scene.id);
  return failure?.request ?? `場面「${scene.id}」${scene.about ? `(${scene.about})` : ''}が通るように直して。場面の一覧と守りは弱めないで。`;
}

// 「ここから直す」「1 つ目から直す」。作る AI の欄を開き、場面の名前を入れた頼む文で始める(送るのは人。ui-ux-v2.md の 2.3)
function fixScene(request) {
  fillRequest(request);
}

function sceneItem(last, scene) {
  const verdict = sceneVerdict(last, scene.id);
  const look = SCENE_STATES[verdict] ?? SCENE_STATES.none;
  const li = element('li', undefined, 'scene-state');
  li.dataset.scene = scene.id;
  li.dataset.state = look.state;
  li.dataset.verdict = verdict;
  const mark = element('span', look.mark, 'scene-mark');
  mark.setAttribute('aria-hidden', 'true');
  li.append(mark, element('span', look.word, 'scene-word'), element('span', scene.id, 'scene-name'));
  if (scene.about) li.append(element('span', scene.about, 'scene-about'));
  if (look.state === 'failed') {
    // どの構成で、どの確かめが通らなかったか。理由の元の文(開発向け)は閉じた中に置く
    for (const item of (last?.failures ?? []).filter((f) => f.id === scene.id)) {
      const row = last.rows.find((r) => r.key === item.row);
      const checks = item.checks.map((check) => `確かめ「${check.check}」: 期待 ${check.expected ?? '-'}、実際 ${check.actual ?? '-'}`).join('。');
      li.append(element('p', `構成「${row?.composition.name ?? ''}」: ${item.verdictLabel}。${item.reason ? '' : checks}`, 'scene-detail'));
      if (item.reason) li.append(sceneDevNote('開発者向け: 回せなかった理由', item.reason));
    }
    const fix = element('button', 'ここから直す', 'quiet');
    fix.type = 'button';
    fix.title = '作る AI の欄を開き、この場面を直す依頼を入れます。送るのはあなたです';
    fix.addEventListener('click', () => fixScene(sceneRequest(last, scene)));
    li.append(fix);
  }
  return li;
}

// 比べる表の上の 1 文。数が同じ場面で測ったものかを書く(4.2)
function compareBasisText(last) {
  if (!last) return '';
  if (last.stale) return '回した後に場面の一覧が変わりました。この表は、今の場面の一覧と同じ場面で測ったものではありません。';
  const counts = new Set(last.rows.map((row) => row.scenes));
  if (last.status !== 'done') return '回しを途中で止めたので、組ごとに測った場面が違うことがあります。数をそのまま比べないでください。';
  if (counts.size === 1) return `どの組も、同じ ${[...counts][0]} 本の場面で測りました。`;
  return '組ごとに測った場面の数が違います。数をそのまま比べないでください。';
}

// 構成を選び直す(比べるタブの弱いボタン)。審査のある試作品では、選び直すと段 4 の承認が消えることを、押す前に言う(4.2)
function renderRechoose(project) {
  const review = project?.review?.status ?? 'none';
  const hasChoice = !els.simChoice.hidden;
  els.rechoose.hidden = !project || (review === 'none' && !hasChoice);
  if (els.rechoose.hidden) return;
  if (review !== 'none') {
    els.rechooseButton.textContent = '構成を選び直す';
    els.rechooseNote.textContent = review === 'skipped'
      ? '審査を飛ばした試作品です。選び直すと、段 4「審査」で構成を読み直します。'
      : '選び直すと、段 4「審査」の承認が消えます。読み直して承認するまで、作る AI は作りません。';
  } else {
    els.rechooseButton.textContent = '構成と前提を選ぶ';
    els.rechooseNote.textContent = '審査のない試作品なので、消える承認はありません。選ぶと、試作品の会話が最初からになります。';
  }
}

async function rechoose() {
  const project = selectedProject();
  if (!project) return;
  if ((project.review?.status ?? 'none') !== 'none') {
    await openReview(project.id);
    // 構成の欄の「中身を見る」を開く(選び直すのは、その中)
    const box = document.querySelector('.review-item[data-item="composition"] details');
    if (box) {
      box.open = true;
      box.scrollIntoView({ block: 'nearest' });
    }
    return;
  }
  setDrawer('mechanism');
  els.simChoice.scrollIntoView({ block: 'start' });
}

// 段 6 の右の 3 つのタブの名前。数を添える(「場面 4/6 通った」)
function renderTabNames(project) {
  const data = sceneUi.projectId === project?.id ? sceneUi.data : null;
  const counts = sceneCounts(data);
  els.tabs.scenes.textContent = counts.total === 0 ? '場面(まだない)' : counts.ran === 0 ? `場面 ${counts.total} つ・まだ` : `場面 ${counts.passed}/${counts.total} 通った`;
  const rows = data?.last?.rows.length ?? 0;
  els.tabs.compare.textContent = rows > 0 ? `比べる ${rows} 組` : '比べる';
}

function selectTab(name, { focus = false } = {}) {
  frame.tab = name;
  document.body.dataset.tab = name;
  for (const [key, tab] of Object.entries(els.tabs)) {
    const selected = key === name;
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
    els.panels[key].hidden = !selected;
  }
  if (focus) els.tabs[name].focus();
  if (name !== 'turn') syncScenes(selectedProject(), { force: true });
}

function renderScenes(project) {
  scheduleFrame();
  renderTabNames(project);
  renderRechoose(project);
  const data = sceneUi.projectId === project?.id ? sceneUi.data : null;
  const count = project?.scenes?.count ?? 0;
  sceneEls.box.hidden = !project || (count === 0 && !data?.last);
  els.scenesEmpty.hidden = !project || !sceneEls.box.hidden;
  if (sceneEls.box.hidden) {
    els.compareBasis.textContent = '';
    sceneEls.table.replaceChildren(element('p', 'まだ回していません。場面の一覧ができたら、場面のタブで回します。', 'muted'));
    return;
  }
  const running = data?.running ?? (project.scenes?.running ? {} : null);
  const last = data?.last ?? null;
  const counts = sceneCounts(data);
  sceneEls.summary.textContent = `場面の一覧(${count} 本${last ? `。前の回しで通らない場面 ${counts.failed}` : ''}${running ? '。回しています…' : ''})`;
  const busy = Boolean(running) || sceneUi.starting || consent.agreeing;
  sceneEls.runMock.disabled = busy || count === 0;
  const real = data?.real;
  sceneEls.runReal.disabled = busy || count === 0 || !real?.available;
  sceneEls.limit.disabled = busy || !real?.available;
  if (real) sceneEls.limit.max = String(real.maxLimitUsd);
  sceneEls.cancel.hidden = !running;
  const reason = real?.code === 'not-found' ? UNAVAILABLE.missing.lead() : real?.reason;
  sceneEls.realNote.textContent = real && !real.available
    ? `本物の AI では回せません: ${reason}`
    : '本物の AI で回すと、場面の発言ごとに試作品の中の AI を呼び、費用がかかります。使った費用が上限に達したら、次の返事を始めずに止めます。自然さの採点はしません。';
  const card = consent.card?.use === 'evals' && consent.card.projectId === project.id ? consent.card : null;
  sceneEls.consent.hidden = !card;
  sceneEls.consent.replaceChildren(...(card ? [consentCard(card.view, { card })] : []));
  const lines = [];
  if (running) {
    const how = running.real ? `本物の AI。使った費用 ${sceneUsd(running.spentUsd ?? 0)} / 上限 ${sceneUsd(running.limitUsd ?? 0)}` : 'お試しの AI';
    lines.push(`場面を回しています… ${running.done ?? 0} / ${running.total ?? '?'}(${how})`);
  }
  if (sceneUi.message) lines.push(sceneUi.message);
  if (data?.problem) lines.push(data.problem.text);
  sceneEls.status.replaceChildren(document.createTextNode(lines.join(' ')), ...(data?.problem?.detail ? [sceneDevNote('開発者向け: 回せなかった理由', data.problem.detail)] : []));
  els.compareBasis.textContent = compareBasisText(last);
  if (!last) {
    sceneEls.table.replaceChildren(element('p', 'まだ回していません。場面のタブで回すと、構成ごとの表がここに出ます。', 'muted'));
  } else {
    const how = last.real
      ? `本物の AI で回した(${formatTime(last.startedAt)}。上限 ${sceneUsd(last.limitUsd ?? 0)}。自然さは${last.judged ? '採点した' : '採点していません'})`
      : `お試しの AI で回した(${formatTime(last.startedAt)})。形が動くかの確かめだけで、構成の良し悪しの根拠にしません`;
    const notes = [element('p', `${how}。状態: ${SCENE_STATUS[last.status] ?? last.status}${last.stopText ? `(${last.stopText})` : ''}`, last.status === 'done' || last.status === 'running' ? 'muted' : 'scene-warn')];
    if (last.stopReason) notes.push(sceneDevNote('開発者向け: 止めた理由の元の文', last.stopReason));
    sceneEls.table.replaceChildren(...notes, sceneTable(last));
  }
  const scenes = data?.scenes ?? [];
  const more = last && last.failureCount > last.failures.length ? `通らない場面のうち ${last.failureCount - last.failures.length} つは、中身をここに出していません。` : '';
  sceneEls.listSummary.textContent = `回す場面(${scenes.length} 本、構成 ${data?.compositions ?? 0} つ)。${last ? '前の回しの結果です。' : 'まだ回していません。'}${more}`;
  sceneEls.list.replaceChildren(...scenes.map((scene) => sceneItem(last, scene)));
}

// 回し始める。本物の AI で同意の前なら、同意のカードを欄に出し、同意したら回す
async function startScenes(connection) {
  const project = selectedProject();
  if (!project || sceneUi.starting) return;
  const id = project.id;
  const limitUsd = Number(sceneEls.limit.value);
  sceneUi.starting = true;
  sceneUi.message = null;
  if (consent.card?.use === 'evals') consent.card = null;
  renderScenes(project);
  try {
    const { scenes } = await api(`/api/projects/${encodeURIComponent(id)}/scenes/run`, { method: 'POST', json: connection === 'mock' ? { connection } : { connection, limitUsd } });
    if (sceneUi.projectId === id) sceneUi.data = scenes;
  } catch (error) {
    if (error instanceof ApiError && error.code === 'consent-required') {
      sceneUi.starting = false;
      await openConsent('evals', { projectId: id });
    } else if (error instanceof ApiError && !['offline', 'token'].includes(error.code)) {
      sceneUi.message = `回せませんでした: ${error.message}`;
    } else {
      handleError(error);
    }
  } finally {
    sceneUi.starting = false;
    sceneUi.version = null;
    lastSnapshot = '';
    await refresh();
    renderScenes(selectedProject());
  }
}

async function cancelScenes() {
  const project = selectedProject();
  if (!project) return;
  try {
    await api(`/api/projects/${encodeURIComponent(project.id)}/scenes/cancel`, { method: 'POST' });
    sceneUi.message = '止めています。今の返事が終わったら、それまでの結果を残して止まります。';
  } catch (error) {
    handleError(error);
  }
  renderScenes(selectedProject());
}

// 段 6 の 3 つのタブ。押すか、左右の矢印で選ぶ(WAI-ARIA のタブの形)
for (const [name, tab] of Object.entries(els.tabs)) {
  tab.addEventListener('click', () => selectTab(name));
  tab.addEventListener('keydown', (event) => {
    const keys = Object.keys(els.tabs);
    const at = keys.indexOf(name);
    const to = event.key === 'ArrowRight' ? keys[(at + 1) % keys.length] : event.key === 'ArrowLeft' ? keys[(at + keys.length - 1) % keys.length] : event.key === 'Home' ? keys[0] : event.key === 'End' ? keys.at(-1) : null;
    if (!to) return;
    event.preventDefault();
    selectTab(to, { focus: true });
  });
}
els.rechooseButton.addEventListener('click', rechoose);
sceneEls.runMock.addEventListener('click', () => startScenes('mock'));
sceneEls.runReal.addEventListener('click', () => startScenes('claude-code'));
sceneEls.cancel.addEventListener('click', cancelScenes);

// 質の見直しの表(user-journey.md の J6。サーバーは src/server/quality.js)。試す欄の下、場面の一覧と比べる表の次に置く。
// 測ったもの(アクセシビリティの違反、字と地の差、素材に合わない色と部品、場面の結果、道具の呼び方、守りの効き、費用、待ち時間)と、
// AI の判断(返事の自然さの採点、使いやすさの見直し)を分けた 2 つの表にする。AI の判断の行には「判断」の印を付ける。
// 「直す」は、作る AI の欄に依頼を入れる(送るのは人)。「画面を確かめて見直す」は、お試しの AI で試作品を自動で確かめる(費用なし)
const qualityUi = { projectId: null, data: null, version: null, seq: 0, starting: false, message: null };
const qualityEls = {
  box: $('quality'),
  summary: $('quality-summary'),
  check: $('quality-check'),
  status: $('quality-status'),
  table: $('quality-table'),
};
const QUALITY_BADGES = { fix: '直す', ok: '問題なし', info: '目安なし' };
// 場所の一覧のうち、ファイルと行、要素の名前(クラスの名前)を出すもの(開発の言葉が入りうるので、開発者向けとして閉じておく)
const QUALITY_DEV_PLACES = new Set(['a11y', 'contrast', 'colors', 'parts']);
const QUALITY_VIEWPORTS = { mobile: 'スマートフォンの幅', tablet: 'タブレットの幅', desktop: 'パソコンの幅' };
const QUALITY_PARTIAL = { running: '場面を回している最中なので、場面の行は途中の数です。', stopped: '場面の回しを途中で止めたので、場面の行は途中の数です。', error: '場面の回しが途中で失敗したので、場面の行は途中の数です。' };

// 読み直す印。確かめの版、確かめている最中か、場面の回しの版、表示中の版
const qualityKey = (project) => JSON.stringify([project.checksVersion ?? 0, Boolean(project.checking), project.scenes?.version ?? 0, project.previewUrl ?? null]);

async function syncQuality(project, { force = false } = {}) {
  const id = project?.id ?? null;
  if (qualityUi.projectId !== id) Object.assign(qualityUi, { projectId: id, data: null, version: null, message: null });
  if (!id) {
    renderQuality(project);
    return;
  }
  const key = qualityKey(project);
  if (!force && qualityUi.version === key) return;
  qualityUi.version = key;
  const seq = ++qualityUi.seq;
  try {
    const { quality } = await api(`/api/projects/${encodeURIComponent(id)}/quality`);
    if (seq !== qualityUi.seq || qualityUi.projectId !== id) return;
    qualityUi.data = quality;
  } catch (error) {
    if (seq === qualityUi.seq) {
      qualityUi.version = null;
      handleError(error);
    }
  }
  renderQuality(selectedProject());
}

function qualityTableOf(rows, group, label) {
  const table = element('table', undefined, 'quality-rows');
  table.setAttribute('aria-label', label);
  const head = element('tr');
  for (const name of ['項目', '結果', 'なぜ大事か', '直す']) head.append(element('th', name));
  const thead = element('thead');
  thead.append(head);
  const tbody = element('tbody');
  for (const row of rows.filter((item) => item.group === group)) {
    const tr = element('tr');
    tr.dataset.row = row.id;
    tr.dataset.status = row.status;
    const name = element('th');
    name.setAttribute('scope', 'row');
    name.append(document.createTextNode(row.label));
    if (row.group === 'judged') name.append(' ', element('span', '判断', 'quality-mark'));
    const result = element('td');
    if (QUALITY_BADGES[row.status]) result.append(element('span', QUALITY_BADGES[row.status], `quality-badge quality-${row.status}`), ' ');
    result.append(document.createTextNode(row.result));
    if (row.note) result.append(element('small', row.note));
    if (row.places.length > 0) {
      const places = element('details', undefined, QUALITY_DEV_PLACES.has(row.id) ? 'card-dev quality-places' : 'quality-places');
      places.append(element('summary', `${QUALITY_DEV_PLACES.has(row.id) ? '開発者向け: ' : ''}場所(${row.places.length})`));
      const list = element('ul');
      list.append(...row.places.map((text) => element('li', text)));
      places.append(list);
      result.append(places);
    }
    const fix = element('td');
    fix.append(document.createTextNode(row.fix));
    if (row.request) {
      const button = element('button', '直す');
      button.type = 'button';
      button.title = '作る AI の欄に、この行を直す依頼を入れます。送るのはあなたです';
      button.addEventListener('click', () => {
        fillRequest(row.request);
        qualityUi.message = `「${row.label}」を直す依頼を、作る AI の欄に入れました。読んで、送ってください。`;
        renderQuality(selectedProject());
      });
      fix.append(' ', button);
    }
    tr.append(name, result, element('td', row.why), fix);
    tbody.append(tr);
  }
  table.append(thead, tbody);
  return table;
}

function renderQuality(project) {
  scheduleFrame();
  const data = qualityUi.projectId === project?.id ? qualityUi.data : null;
  qualityEls.box.hidden = !project;
  if (!project) return;
  const checking = Boolean(project.checking) || qualityUi.starting;
  qualityEls.summary.textContent = data
    ? `質の見直し(直す ${data.summary.fix}、まだ見ていない ${data.summary.unseen}${checking ? '。確かめています…' : ''})`
    : '質の見直し';
  qualityEls.check.disabled = !canCheck(project) || !project.previewUrl;
  qualityEls.check.textContent = checking ? '確かめています…' : '画面を確かめて見直す';
  const lines = [];
  if (checking) lines.push('試作品を自動で確かめています。終わると、アクセシビリティと字と地の差の行が埋まります。');
  if (data?.audit) lines.push(`画面を確かめた時刻: ${formatTime(data.audit.at)}(確かめの最後の画面を、${QUALITY_VIEWPORTS[data.audit.viewport] ?? '最後の画面幅'}で見た)。`);
  if (data?.audit?.stale) lines.push('確かめた後に試作品か素材が変わったので、アクセシビリティと字と地の差の行は古いです。もう一度確かめてください。');
  if (data?.scenes?.stale) lines.push('場面を回した後に場面の一覧が変わったので、場面の行は古いです。');
  if (data?.scenes && QUALITY_PARTIAL[data.scenes.status]) lines.push(QUALITY_PARTIAL[data.scenes.status]);
  if (qualityUi.message) lines.push(qualityUi.message);
  qualityEls.status.textContent = lines.join(' ');
  if (!data) {
    qualityEls.table.replaceChildren(element('p', '読み込んでいます…', 'muted'));
    return;
  }
  qualityEls.table.replaceChildren(
    element('h4', '測ったもの'),
    qualityTableOf(data.rows, 'measured', '質の見直し: 測ったもの'),
    element('h4', 'AI の判断'),
    element('p', 'AI の判断は、AI が読んで決めたものです。ぶれがあるので、人が確かめます。', 'muted'),
    qualityTableOf(data.rows, 'judged', '質の見直し: AI の判断'),
  );
}

// お試しの AI で、表示中の試作品を自動で確かめる(引き出しの「試作品を自動で確かめる」と同じ確かめ。費用も同意も要らない)
async function startQualityCheck() {
  const project = selectedProject();
  if (!project || !canCheck(project) || qualityUi.starting) return;
  qualityUi.starting = true;
  qualityUi.message = null;
  renderQuality(project);
  try {
    await api(`/api/projects/${encodeURIComponent(project.id)}/checks`, { method: 'POST', json: { connection: 'mock' } });
  } catch (error) {
    if (error instanceof ApiError && !['offline', 'token'].includes(error.code)) qualityUi.message = `確かめられませんでした: ${error.message}`;
    else handleError(error);
  } finally {
    qualityUi.starting = false;
    lastSnapshot = '';
    await refresh();
    render();
  }
}

qualityEls.box.addEventListener('toggle', () => {
  if (qualityEls.box.open) syncQuality(selectedProject(), { force: true });
});
qualityEls.check.addEventListener('click', startQualityCheck);

// ---- 画面の枠(ui-ux-v2.md の 2.2〜2.6、2.8、5.1、5.3、13 節) ----
// どの段でも、段の道筋、今の行、作業台、次の一手の帯、仕組みの引き出しの 5 つで画面を作る。
// 作業台の中身は今の画面の部品(目的、設計、審査、整理、会、試す、言葉で直す)。見せ方の作り直しは UI/UX の 4〜8 枚目

const STAGES = [
  { key: 'talk', num: 1, name: '話す' },
  { key: 'goal', num: 2, name: '目的', human: true },
  { key: 'design', num: 3, name: '設計', human: true },
  { key: 'review', num: 4, name: '審査', human: true },
  { key: 'build', num: 5, name: '作る' },
  { key: 'measure', num: 6, name: '測る' },
  { key: 'quality', num: 7, name: '質' },
  { key: 'show', num: 8, name: '見せる', human: true },
  { key: 'handoff', num: 9, name: '渡す' },
];
const stageOf = (key) => STAGES.find((stage) => stage.key === key) ?? STAGES[4];
// 試作品と作る AI の欄の 2 列を出す段(2.4)
const LAYOUT_STAGES = new Set(['build', 'measure', 'quality', 'show']);
const STAGE_STATE_WORDS = { done: '済み', skipped: '飛ばした', 'no-review': '審査なし' };
const STAGE_STATE_MARKS = { done: '✓', skipped: '─', 'no-review': '─' };

// 見本の試作品は、段 1〜4 を「飛ばした」で始める(2.3)
const isSample = (project) => Boolean(project?.id?.startsWith('sample-'));

// 作業台に出している段。目的、整理、設計、審査、会の画面を開いていれば、その段。ほかは段の道筋で選んだ段
function viewedStage() {
  if (showUi.open) return 'show';
  if (meetingUi.view) return meetingUi.view === 'closing' ? 'handoff' : 'goal';
  if (intentUi.view === 'start') return 'talk';
  if (intentUi.view || organizeUi.open) return 'goal';
  if (designUi.open) return 'design';
  if (reviewUi.open) return 'review';
  return frame.stage;
}

// 開いている画面があるか(目的、整理、設計、審査、会)
function screenOpen() {
  return Boolean(meetingUi.view || intentUi.view || organizeUi.open || designUi.open || reviewUi.open);
}

// 段の済み、飛ばした、審査なし。今ある記録から読む(段 7 と 8 の済みは、それぞれの作業台を作るカードで足す)
function stageState(key, project) {
  if (!project) return 'todo';
  const intent = project.intent?.status ?? 'none';
  const sample = isSample(project);
  switch (key) {
    case 'talk':
      if (['interviewing', 'draft', 'decided'].includes(intent) || (project.meeting?.status ?? 'none') !== 'none') return 'done';
      return intent === 'skipped' || sample ? 'skipped' : 'todo';
    case 'goal':
      if (intent === 'decided' || project.organize?.status === 'confirmed') return 'done';
      return intent === 'skipped' || sample ? 'skipped' : 'todo';
    case 'design':
      if (project.design?.status === 'decided') return 'done';
      return project.design?.status === 'skipped' || sample ? 'skipped' : 'todo';
    case 'review':
      if (project.review?.status === 'approved') return 'done';
      if (project.review?.status === 'skipped') return 'no-review';
      return sample ? 'skipped' : 'todo';
    case 'build':
      return project.previewUrl && project.lastBuild?.ok !== false ? 'done' : 'todo';
    case 'measure':
      return project.firstSteps?.tried ? 'done' : 'todo';
    case 'handoff':
      return handoff.projectId === project.id && handoff.last ? 'done' : 'todo';
    default:
      return 'todo';
  }
}

function stageButtonContent(button, stage, state) {
  const parts = [element('span', String(stage.num), 'stage-num')];
  if (stage.human) {
    const mark = element('span', '●', 'stage-human');
    mark.setAttribute('aria-hidden', 'true');
    parts.push(mark, element('span', '(人が決める段)', 'visually-hidden'));
  }
  parts.push(element('span', stage.name, 'stage-name'));
  if (STAGE_STATE_MARKS[state]) {
    const mark = element('span', STAGE_STATE_MARKS[state], 'stage-state');
    mark.setAttribute('aria-hidden', 'true');
    parts.push(mark, element('span', `(${STAGE_STATE_WORDS[state]})`, 'visually-hidden'));
  }
  if (state === 'no-review') parts.push(element('span', '審査なし', 'stage-flag'));
  button.replaceChildren(...parts);
}

function renderRail(project, current) {
  const stage = stageOf(current);
  for (const button of els.stageList.querySelectorAll('button.stage')) {
    const key = button.dataset.stage;
    const state = stageState(key, project);
    button.dataset.state = state;
    stageButtonContent(button, stageOf(key), state);
    if (key === current) button.setAttribute('aria-current', 'step');
    else button.removeAttribute('aria-current');
    button.disabled = !project && key !== 'talk';
  }
  els.stageCount.textContent = `${stage.num} / ${STAGES.length} 段`;
  els.stageCompact.textContent = `${stage.num} / ${STAGES.length} ${stage.name} ▾`;
  els.stageCompact.setAttribute('aria-label', `段の道筋: ${STAGES.length} 段のうち ${stage.num} 段目、${stage.name}。押すと 9 段の一覧を開きます`);
  const heading = [element('span', String(stage.num), 'bench-num'), element('span', stage.name, 'bench-name')];
  if (stage.human) {
    const mark = element('span', '●', 'stage-human');
    mark.setAttribute('aria-hidden', 'true');
    heading.splice(1, 0, mark);
  }
  els.benchHeading.replaceChildren(...heading);
  els.benchHeading.dataset.stage = current;
}

function setCompact(open) {
  frame.compactOpen = open;
  els.stageCompact.setAttribute('aria-expanded', String(open));
  document.body.dataset.compactOpen = String(open);
}

// ---- 今の行(2.5、2.6) ----
const ACTOR_KEYS = ['you', 'maker', 'product', 'gate'];
const ACTOR_NAMES = { you: 'あなた', maker: '作る AI', product: '試作品の中の AI', gate: '関門と守り' };

function sceneRunning(project) {
  if (!project) return false;
  const running = sceneUi.projectId === project.id ? sceneUi.data?.running : null;
  return Boolean(running ?? project.scenes?.running);
}

// 4 者が今していること。働いている者は active。どの AI も働いていなければ、あなたの番
function actorStates(project, stage) {
  const states = {};
  const making = Boolean(project && (project.running || sending?.projectId === project.id || runningRun(project.id)));
  const thinking = intentUi.waiting ? '問いを考えています' : designUi.waiting ? '案を作っています' : organizeUi.waiting ? '板を整理しています' : null;
  // 作る依頼の今の節が関門の側なら、働いているのは ⬢(作る AI は結果を待つ)
  const run = project ? runningRun(project.id) : null;
  const gateNode = run?.current && GATE_SIDE_NODES.has(run.current.node) ? run.current.node : null;
  if (gateNode) states.maker = { text: '関門の結果を待っています' };
  else if (making) states.maker = { text: '試作品を書いています', active: true };
  else if (thinking) states.maker = { text: thinking, active: true };
  else if (agent && !agent.ready) states.maker = { text: '今は使えません' };
  else states.maker = { text: '待っています' };
  const answering = Boolean(project && waitingFor(project.id) > 0);
  const hasAi = Boolean(project && ai.projectId === project.id && ai.session);
  if (answering) states.product = { text: '答えています', active: true };
  else if (sceneRunning(project)) states.product = { text: '場面を回しています', active: true };
  else if (project && ai.projectId === project.id && ai.loaded && !ai.session) states.product = { text: 'この試作品にはいません' };
  else if (hasAi) states.product = { text: tryRealAi() ? '本物' : 'お試し' };
  else states.product = { text: 'まだ読み込んでいません' };
  const review = project?.review?.status ?? 'none';
  if (gateNode === 'fix') states.gate = { text: '直す依頼をまとめています', active: true };
  else if (gateNode === 'evidence') states.gate = { text: '確かめた結果をまとめています', active: true };
  else if (gateNode) states.gate = { text: `${ITEM_LABELS[`gate:${gateNode}`] ?? gateNode}を確かめています`, active: true };
  else if (project?.building) states.gate = { text: '表示の準備を確かめています', active: true };
  else if (project?.checking) states.gate = { text: '試作品を確かめています', active: true };
  else if (review === 'drafting' || review === 'stopped') states.gate = { text: '承認まで作らせません' };
  else states.gate = { text: '見張っています' };
  const busy = ACTOR_KEYS.some((key) => states[key]?.active);
  if (!busy) {
    const waitingYou = stage === 'review' && review === 'drafting' ? `あなたの番(承認 ${project.review.approved ?? 0} / 4)` : 'あなたの番';
    states.you = { text: waitingYou, active: true };
  } else {
    states.you = { text: '待てます' };
  }
  return states;
}

function renderNowLine(project, stage) {
  const states = actorStates(project, stage);
  let others = 0;
  for (const li of els.nowLine.querySelectorAll('.actor')) {
    const state = states[li.dataset.actor];
    li.querySelector('.actor-text').textContent = state.text;
    if (state.active) li.dataset.active = 'true';
    else {
      delete li.dataset.active;
      others += 1;
    }
  }
  els.actorOthers.textContent = `ほか ${others} 者`;
  // お試しか本物か(2.6)。作る AI か試作品の中の AI のどちらかが本物なら、本物の印にする
  const real = tryRealAi() || Boolean(consent.agreed && agent?.kind === 'claude' && agent.ready);
  els.aiMode.hidden = real;
  renderTrialInfo(!real && frame.trialInfo);
  renderRealAiMark(els.realAiNow, els.realAiNowInfo, real, 'now');
}

// お試しのときの中身(5.4 の「お試しか本物か」)。○ の印と 3 つの文。閉じるボタン
function renderTrialInfo(open) {
  els.aiMode.setAttribute('aria-expanded', String(open));
  els.aiModeInfo.hidden = !open;
  if (!open) {
    els.aiModeInfo.replaceChildren();
    return;
  }
  if (els.aiModeInfo.childElementCount > 0) return;
  const close = element('button', '閉じる');
  close.type = 'button';
  close.addEventListener('click', () => {
    frame.trialInfo = false;
    renderFrame();
    els.aiMode.focus();
  });
  els.aiModeInfo.append(stateLine('mode-trial'), close);
}

// ---- 次の一手の帯(2.2、10.4) ----
// 今の段の作業台にある次の一手のボタンを、帯に移して出す。押せない(hidden か disabled の)ボタンは移さない。
// 移したボタンは同じ要素なので、id、押したときの動き、form の送信はそのまま
function moveToBand(button) {
  if (frame.moved === button) return;
  if (frame.moved) {
    frame.home.replaceWith(frame.moved);
    frame.moved = null;
    frame.home = null;
  }
  if (!button) return;
  // form の外に出ても、その form を送れるようにする
  if (button.form?.id && !button.getAttribute('form')) button.setAttribute('form', button.form.id);
  const home = document.createComment('次の一手の帯に移したボタンの元の場所');
  const focused = document.activeElement === button;
  button.replaceWith(home);
  frame.home = home;
  frame.moved = button;
  els.nextSlot.append(button);
  if (focused) button.focus();
}

// 帯の自前のボタン。段を移るだけの操作に使う(作業台のボタンと名前が重ならないようにする)
const nextGo = element('button', '', 'primary');
nextGo.type = 'button';
nextGo.id = 'next-go';
let nextGoAction = null;
nextGo.addEventListener('click', () => nextGoAction?.());
// 帯の弱いボタン「止める」(作っている間だけ。4.3)
const nextStop = element('button', '止める', 'quiet');
nextStop.type = 'button';
nextStop.id = 'next-stop';
nextStop.addEventListener('click', () => els.cancel.click());

// 帯にあるボタンは、元の場所で見えるかで決める(帯の中では、元の親の hidden が効かないため)
function shownAtHome(button) {
  if (!button || button.hidden || button.disabled) return false;
  if (frame.moved === button) return !frame.home.parentElement?.closest('[hidden]');
  return !button.closest('[hidden]');
}

function firstShown(...buttons) {
  return buttons.find(shownAtHome) ?? null;
}

// 段ごとの次の一手。text は 1 文、button は帯に移す作業台のボタン、go は帯の自前のボタン({ label, run })
function nextStep(project, stage) {
  if (!project && stage !== 'talk') return { text: '試作品がありません。試作品の名前のメニューの「新しく作る」から始めます。' };
  if (meetingUi.view) {
    if (meetingUi.view === 'new') return { text: '会の目的を 1 文で書き、会を用意します。題材は架空にします。', button: meetingEls.newSubmit };
    if (meetingUi.view === 'closing') {
      if (closingUi.busy && frame.moved === $('closing-export')) return { text: '成果物を書き出しています。', button: $('closing-export'), keep: true };
      return { text: '未決事項の持ち主と期日を決めて、成果物を書き出します。', button: firstShown($('closing-export')) };
    }
    if (meetingUi.view === 'erased') return { text: '会のデータを消しました。消せないものを読み、閉じます。' };
    const button = firstShown(meetingEls.agree, meetingEls.organize);
    return { text: button === meetingEls.agree ? 'お客さんに会の決まりを読み上げ、同意をもらってから始めます。' : '同意をもらいました。聞き取りと整理の板に進みます。', button };
  }
  if (intentUi.view === 'start') return { text: '1 文を書いて送ると、問いが 1 つずつ返ります。', button: firstShown(intentEls.send) };
  if (intentUi.view === 'talk') {
    if (intentUi.waiting) return { state: 'working', words: { who: '聞き出す AI ', doing: '次の問いを考えています', now: '前の答えは残っていて、止めても消えません。', next: '待つ間に、前の答えを読み返しませんか。' } };
    return { text: '問いに 1 つずつ答えます。分からなければ「分からない」で進めます。', button: firstShown(intentEls.reply) };
  }
  if (intentUi.view === 'doc') {
    const button = firstShown($('intent-design'), intentEls.decide);
    return { text: button === intentEls.decide ? '下書きを読み、違うところを直してから決めます。' : '目的を決めました。この目的で設計に進みます。', button };
  }
  if (organizeUi.open) {
    if (organizeUi.waiting) return { state: 'working', words: { who: '整理する AI ', doing: '板を整理しています', now: '整理が終わるまで、板の項目は前のままです。', next: 'その間も、聞いた要点を打ち続けられます。' } };
    const items = organizeUi.board?.items?.length ?? 0;
    const button = firstShown($('organize-design'), items === 0 ? organizeEls.run : organizeEls.confirm, organizeEls.run);
    const text = button === organizeEls.run ? '聞いた要点を打ち、板に整理します。' : button === organizeEls.confirm ? '決める人が板を読み、合っていれば確かめます。' : '板を確かめました。この理解で設計に進みます。';
    return { text, button };
  }
  if (designUi.open) {
    if (designUi.waiting) return { state: 'working', words: { who: '案を出す AI ', doing: '案を作っています', now: '前に選んだ案は、そのまま残っています。', next: '止めるときは、作業台の「止める」を押せます。' } };
    const button = firstShown(designEls.start, designEls.build, designEls.next);
    const text = button === designEls.start ? '問題から画面までの段ごとに、案を並べてもらいます。' : button === designEls.build ? '最後の段まで選びました。この設計で作り、作る前に審査します。' : button === designEls.next ? '案を比べて 1 つ選び、次の段へ進みます。' : '案を選びます。';
    return { text, button };
  }
  if (reviewUi.open) {
    const record = reviewUi.record;
    if (shownAtHome($('review-back'))) return { state: 'guard-stopped', words: { what: '承認と違う AI の作りで作ること', now: '試す欄の試作品は、承認したときのままです。', next: '審査に戻って、変わった所を読み直しますか。' }, button: $('review-back') };
    if (reviewUi.busy && frame.moved === reviewEls.build) return { text: '作り始めています。', button: reviewEls.build, keep: true };
    if (shownAtHome(reviewEls.build)) return { text: 'この構成で作ります。作る AI が書き始め、守りが確かめます。', button: reviewEls.build };
    const asking = nextApproval(record);
    if (asking && record.thinking) return { state: 'working', words: { who: '案を出す AI ', doing: '案を作っています', now: '終わるまで、承認は押せません。', next: '待つ間に、読んでいる欄の 3 つの問いを読みませんか。' } };
    if (asking) {
      const keep = reviewUi.busy && frame.moved === reviewEls.approve;
      return { state: 'waiting', words: { approved: record.approvedCount, total: record.total, label: spaced(asking.item.label) }, button: reviewEls.approve, keep };
    }
    return { text: record?.status === 'skipped' ? '審査を飛ばしました。試作品の画面に戻って作ります。' : '審査の記録を読んでいます。' };
  }
  if (stage === 'talk' || stage === 'goal' || stage === 'design' || stage === 'review') return noteStep(project, stage);
  const making = Boolean(project.running || sending?.projectId === project.id || runningRun(project.id));
  // 作っている間は、あなたの番ではないので強い色のボタンを出さない。弱いボタン「止める」と待つ間の 1 文だけ(4.3)
  if (making && LAYOUT_STAGES.has(stage)) {
    return { state: 'working', words: { who: `${FIX_AI} ` }, stop: Boolean(runningRun(project.id)) };
  }
  if (stage === 'build') return buildStep(project);
  if (stage === 'measure') return measureStep(project);
  if (stage === 'quality') return { text: '見直しの表の「直す」を上から片付けます。終わったら、人に見せます。', go: { label: '見せる段へ進む', run: () => goStage('show') } };
  return nextStepTail(project, stage);
}

// 最初の一歩の進み方(試す → 言葉で直す → 直った結果を試す)の 1 文(13 節。前の「はじめの手順」の 1 文)
function firstStepsStep(project) {
  const progress = project.firstSteps ?? {};
  const hint = firstStepsHint(project, FIRST_STEPS.findIndex((step) => !progress[step.key]));
  return { text: typeof hint === 'string' ? hint : hint.text, tone: typeof hint === 'string' ? '' : hint.tone };
}

// 頼み方を変える、言い換える。作る AI の欄を開き、前の依頼の文を入れて選ぶ(送るのは人)
function rephrase(run) {
  openMaker();
  els.requestText.value = run.request;
  els.requestText.focus();
  els.requestText.select();
}

// 段 5 の次の一手。いちばん新しい依頼の結果の 4 つ(4.3 の表)と、ほかの終わり方。依頼がまだなければ最初の一歩の 1 文
function buildStep(project) {
  const tryIt = { label: '試す', run: () => goStage('measure') };
  const run = latestRun(project.id);
  if (!run) return { ...firstStepsStep(project), go: tryIt };
  const change = { label: '頼み方を変える', run: () => rephrase(run) };
  // 守りが止めた: 作る AI が試作品のフォルダーの外を触ろうとして、断られた
  if (run.items.some((item) => item.kind === 'denied') && !UPDATED_STATUSES.has(run.status)) {
    return { state: 'guard-stopped', go: { label: '言い換える', run: () => rephrase(run) }, outcome: 'guarded' };
  }
  const fixes = (run.round ?? 1) - 1;
  const checked = (run.gates ?? []).filter((gate) => gate.status === 'passed').length;
  switch (run.status) {
    case 'passed':
    case 'done':
      return { text: `試作品を作りました。${checked > 0 ? `確かめた ${checked} つは、全部通りました。` : ''}試作品で動きを試せます。`, go: tryIt, outcome: 'passed' };
    case 'fixed':
      return { text: `${fixes} 度落ちましたが、${FIX_AI} が直して通りました。直したところは記録にあります。`, go: tryIt, outcome: 'fixed' };
    case 'failed': {
      const gate = failedGate(run);
      return { state: 'gate-failed', words: { gate: gate ? gateLabel(gate) : null }, tone: 'warn', go: change, outcome: 'failed' };
    }
    case 'unverified':
      return { text: '試作品を作りました。自動の確かめの一部は、確かめられませんでした。試作品で動きを試しますか。', go: tryIt, outcome: 'unverified' };
    case 'cancelled':
      return { text: '止めました。前の版を出しています。', go: tryIt, outcome: 'cancelled' };
    case 'unchanged':
      return { text: '試作品のファイルは変わりませんでした。頼み方を変えて、もう一度試しますか。', go: change, outcome: 'unchanged' };
    default:
      return { text: `${(RUN_STATUS[run.status] ?? (() => '終わりました'))(run)}。前の版を出しています。頼み方を変えて、もう一度試しますか。`, tone: 'warn', go: change, outcome: run.status };
  }
}

// 段 6 の次の一手(4.2)。通らない場面があれば「1 つ目から直す」、回した場面が全部通れば「質の見直しへ進む」。
// まだ回していなければ、最初の一歩の進み方の 1 文(13 節)
function measureStep(project) {
  const quality = { label: '質の見直しへ進む', run: () => goStage('quality') };
  const data = sceneUi.projectId === project.id ? sceneUi.data : null;
  const last = data?.last ?? null;
  const counts = sceneCounts(data);
  if (last && counts.failed > 0) {
    const first = (data.scenes ?? []).find((scene) => ['failed', 'error'].includes(sceneVerdict(last, scene.id)));
    return { text: `${counts.failed} つの場面が通りませんでした。これを見つけるのが試す目的です。`, go: { label: '1 つ目から直す', run: () => fixScene(sceneRequest(last, first)) } };
  }
  if (last && last.status === 'done' && !last.stale && counts.total > 0 && counts.passed + counts.failed > 0) {
    return { text: `回した ${counts.passed} つの場面は、全部通りました。次は質の見直しです。`, go: quality };
  }
  return { ...firstStepsStep(project), go: quality };
}

// 段 8 と段 9 の次の一手
function nextStepTail(project, stage) {
  if (stage === 'show') {
    if (showUi.starting && frame.moved === els.showStart) return { text: '見せる画面を用意しています。', button: els.showStart, keep: true };
    if (shownAtHome(els.showStart)) return { text: '試作品と確かめたい問いだけの画面にして、人に見せます。', button: els.showStart };
    return { text: '保存か、作る AI の作業が終わると、人に見せられます。' };
  }
  if (stage === 'handoff') {
    if (handoff.busy && frame.moved === els.handoffExport) return { text: '渡すフォルダーを作っています。', button: els.handoffExport, keep: true };
    if (shownAtHome(els.handoffExport)) return { text: '目的、決まったこと、未決事項を書き、本番開発へ渡すフォルダーを作ります。', button: els.handoffExport };
    return { text: '保存か、作る AI の作業が終わると、渡すフォルダーを作れます。' };
  }
  return { text: '' };
}

// まだの段、または開ける画面のない段を押したときの作業台。何が足りないかを言い、次の一手を 1 つ出す
function noteStep(project, stage) {
  const intent = project.intent?.status ?? 'none';
  if (stage === 'talk') {
    if (isSample(project) && intent === 'none') {
      return { note: '見本の試作品なので、話す段は飛ばしています。自分の思いつきから始めるときは、新しい試作品を 1 文から作ります。', text: '自分の思いつきを 1 文で書いて、新しい試作品を始めます。', go: { label: '1 文から始める', run: () => $('new-project').click() } };
    }
    return { note: 'この試作品は、最初の 1 文から聞き出しを始めています。続きは段 2「目的」にあります。', text: '目的の文書を開いて、続きを読みます。', go: { label: '目的の文書を開く', run: () => openIntentFromMark() } };
  }
  if (stage === 'goal') {
    return { note: '目的の文書はまだありません。思いつきの 1 文から、問いに答えて作ります。', text: '1 文を書いて、目的を聞き出してもらいます。', go: { label: '目的を聞き出す', run: () => openIntentFromMark() } };
  }
  if (stage === 'design') {
    return { note: '見本の試作品なので、設計の段は飛ばしています。設計の案内を開くと、この試作品の設計を始められます。', text: '設計の案内を開いて、この試作品の設計を始めます。', go: { label: '設計の案内を開く', run: () => openDesign() } };
  }
  return {
    note: isSample(project) ? '見本の試作品なので、審査は飛ばしています。審査は、設計の案内で設計を決めると始まります。' : 'AI 構成の審査は、まだ始まっていません。設計の案内で設計を決めると始まります。足りないもの: 決めた設計。',
    text: '設計の案内で設計を決め、審査に進みます。',
    go: { label: '設計の案内を開く', run: () => openDesign() },
  };
}

function renderBand(project, stage) {
  const step = nextStep(project, stage);
  // 12 の状態(5.4)は、何が起きたか、今どうなっているか、次に何をするかの 3 つの文と印で出す
  if (step.state) fillState(els.nextText, step.state, step.words ?? {});
  else clearState(els.nextText, step.text);
  els.nextText.dataset.tone = step.tone ?? '';
  // 押している最中(keep)は、押せなくなっても帯に残す(押した場所が消えないように)
  const button = step.button && (step.keep || shownAtHome(step.button)) ? step.button : null;
  moveToBand(button);
  if (step.go && !button) {
    nextGo.textContent = step.go.label;
    nextGoAction = step.go.run;
    if (!nextGo.isConnected) els.nextSlot.append(nextGo);
  } else {
    nextGoAction = null;
    nextGo.remove();
  }
  // 作っている間の弱いボタン「止める」。作る AI の欄の「止める」と同じ操作
  if (step.stop) {
    if (!nextStop.isConnected) els.nextSlot.append(nextStop);
  } else nextStop.remove();
  els.nextBand.dataset.outcome = step.outcome ?? '';
  // 作業台の注記(まだの段)
  const note = !screenOpen() && !showUi.open && ['talk', 'goal', 'design', 'review'].includes(stage) && project ? step.note ?? '' : '';
  els.stageNote.hidden = !note;
  if (note) els.stageNoteText.textContent = note;
}

// ---- 作業台の出し分け ----
function renderBench(project, stage) {
  const open = screenOpen();
  // 開いている画面がなければ、段ごとの作業台にする
  const bench = open ? 'screen' : LAYOUT_STAGES.has(stage) ? 'layout' : stage === 'handoff' ? 'handoff' : 'note';
  document.body.dataset.bench = bench;
  document.body.dataset.stage = stage;
  els.stageShow.hidden = open || stage !== 'show';
  els.stageCheck.hidden = open || stage !== 'quality';
  els.stageHandoff.hidden = open || stage !== 'handoff';
  renderSide(stage);
}

// 段 5〜8 の右の列(2.2、2.4)。段 5 は作る AI の欄。段 6〜8 は段の欄で、右上の「■ 作る AI に頼む」で作る AI の欄に替える。
// 見せている間は、見せる画面の問いの欄。どれを出すかは body の data-side で決める(CSS)
const SIDE_NAMES = { measure: '測る', quality: '質の見直し', show: '見せる' };
function renderSide(stage) {
  const maker = stage === 'build' || frame.side === 'maker';
  const side = showUi.open ? 'showing' : maker ? 'maker' : stage;
  document.body.dataset.side = side;
  els.sideSwitch.hidden = showUi.open || stage === 'build' || !LAYOUT_STAGES.has(stage);
  els.sideMaker.hidden = maker;
  els.sideBack.hidden = !maker;
  els.sideBack.textContent = `← ${SIDE_NAMES[stage] ?? ''}に戻る`;
  els.measure.hidden = side !== 'measure';
}

// 元に戻した(5.4)の 1 行。何時の版に戻したか、戻す前の版は残っているか、次に試すか。戻す前と同じ版があれば「戻す前に戻る」
function renderReverted(project) {
  const reverted = frame.reverted;
  const shown = Boolean(reverted && project && reverted.projectId === project.id && !showUi.open);
  els.reverted.hidden = !shown;
  if (!shown) return;
  const at = reverted.restored.savedAt ? new Date(reverted.restored.savedAt).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' }) : '';
  fillState(els.revertedText, 'reverted', { at, kept: !reverted.setAside });
  els.revertedUndo.hidden = !reverted.before;
  // 版の一覧の「この状態に戻す」と同じ時に押せなくする(作る AI の作業中など)
  els.revertedUndo.disabled = versionsLocked(project);
}

// 次の操作で、元に戻した 1 行を消す。1 行の中の「戻す前に戻る」は操作に数えない。
// 試作品の名前のメニューが開いている間の押す操作(メニューの中の操作と、メニューを閉じる操作)も数えない。
// 版を戻すのはメニューの中なので、メニューを閉じた後に 1 行を読めるように
document.addEventListener(
  'click',
  (event) => {
    if (!frame.reverted || els.reverted.contains(event.target) || !els.projectMenu.hidden) return;
    frame.reverted = null;
    scheduleFrame();
  },
  true,
);

els.revertedUndo.addEventListener('click', () => {
  const project = selectedProject();
  const before = frame.reverted?.before;
  if (!project || !before || frame.reverted.projectId !== project.id) return;
  restoreVersion(project, before);
});

function renderFrame() {
  if (!frame.ready) return;
  const project = selectedProject();
  const stage = viewedStage();
  renderReverted(project);
  renderRail(project, stage);
  renderBench(project, stage);
  renderNowLine(project, stage);
  renderBand(project, stage);
  renderHints();
  if (frame.drawer === 'mechanism') loadPrompts();
}

// 描き直しを 1 回にまとめる。各画面の描き直しの後に呼ぶ
function scheduleFrame() {
  if (frame.pending) return;
  frame.pending = true;
  queueMicrotask(() => {
    frame.pending = false;
    renderFrame();
  });
}

// 段の道筋を押したとき。その段の作業台に移る。まだの段も押せて、何が足りないかを作業台に出す
function goStage(key) {
  const project = selectedProject();
  setCompact(false);
  setProjectMenu(false);
  if (!project && key !== 'talk') return;
  frame.stage = 'build';
  frame.side = 'stage';
  if (key === 'talk') {
    if (!project) return $('new-project').click();
    const intent = project.intent?.status ?? 'none';
    if (!isSample(project) && (intent === 'none' || intent === 'skipped')) return openIntentFromMark();
    closeScreens();
    frame.stage = 'talk';
  } else if (key === 'goal') {
    if ((project.meeting?.status ?? 'none') !== 'none') return project.meeting.status === 'waiting' ? openMeeting(project.id) : openOrganize();
    if (project.organize?.status && project.organize.status !== 'none') return openOrganize();
    const intent = project.intent?.status ?? 'none';
    if (intent !== 'none' && !(intent === 'skipped' && isSample(project))) return openIntentFromMark();
    closeScreens();
    frame.stage = 'goal';
  } else if (key === 'design') {
    if (isSample(project) && (project.design?.status ?? 'none') === 'none') {
      closeScreens();
      frame.stage = 'design';
      renderFrame();
      return;
    }
    return openDesign();
  } else if (key === 'review') {
    if ((project.review?.status ?? 'none') !== 'none') return openReview(project.id);
    closeScreens();
    frame.stage = 'review';
  } else {
    closeScreens();
    frame.stage = key;
    // 段 6 は 3 つのタブ(前に選んだタブ)を、段 7 は質の見直しを開いて出す
    if (key === 'measure') selectTab(frame.tab);
    if (key === 'quality' && !qualityEls.box.hidden) qualityEls.box.open = true;
  }
  renderFrame();
  els.benchHeading.focus({ preventScroll: true });
}

function closeScreens() {
  if (showUi.open) return;
  leaveIntent();
  closeOrganize();
  closeDesign();
  closeReview();
  closeMeeting();
}

els.stageList.addEventListener('click', (event) => {
  const button = event.target.closest('button.stage');
  if (button) goStage(button.dataset.stage);
});
els.stageCompact.addEventListener('click', () => setCompact(!frame.compactOpen));
// 段 6〜8 の右上の「■ 作る AI に頼む」と「← (段)に戻る」
els.sideMaker.addEventListener('click', () => {
  frame.side = 'maker';
  renderFrame();
  els.requestText.focus({ preventScroll: true });
});
els.sideBack.addEventListener('click', () => {
  frame.side = 'stage';
  renderFrame();
  els.sideMaker.focus({ preventScroll: true });
});
const stageRail = document.querySelector('.stage-rail');
document.addEventListener('click', (event) => {
  if (frame.compactOpen && !event.composedPath().includes(stageRail)) setCompact(false);
});

// ---- 仕組みの引き出しと素材(2.2) ----
function setDrawer(name) {
  frame.drawer = name;
  els.mechanism.hidden = name !== 'mechanism';
  els.materials.hidden = name !== 'materials';
  els.mechanismButton.setAttribute('aria-expanded', String(name === 'mechanism'));
  els.materialsButton.setAttribute('aria-expanded', String(name === 'materials'));
  if (name) document.body.dataset.drawer = name;
  else delete document.body.dataset.drawer;
  if (name === 'mechanism') loadPrompts();
}

function toggleDrawer(name) {
  const opening = frame.drawer !== name;
  setDrawer(opening ? name : null);
  if (opening) (name === 'mechanism' ? els.mechanism : els.materials).focus({ preventScroll: true });
}

els.mechanismButton.addEventListener('click', () => toggleDrawer('mechanism'));
els.materialsButton.addEventListener('click', () => toggleDrawer('materials'));
els.mechanismClose.addEventListener('click', () => {
  setDrawer(null);
  els.mechanismButton.focus();
});
els.materialsClose.addEventListener('click', () => {
  setDrawer(null);
  els.materialsButton.focus();
});
els.realAiNow.addEventListener('click', () => toggleRealAiInfo('now'));
els.aiMode.addEventListener('click', () => {
  frame.trialInfo = !frame.trialInfo;
  renderFrame();
});

// . のキーで仕組みの引き出しを開き、もう一度で閉じる。字を打っている所では効かせない。見せる画面では開かない
document.addEventListener('keydown', (event) => {
  if (event.key !== '.' || event.ctrlKey || event.metaKey || event.altKey || event.isComposing) return;
  const target = event.target;
  if (target instanceof HTMLElement && (target.isContentEditable || target.closest('input, textarea, select'))) return;
  if (showUi.open) return;
  event.preventDefault();
  toggleDrawer('mechanism');
});

// 引き出しの「プロンプト」。AI 構成の審査の harness のプロンプトの全文を読む(審査のない試作品には、まだない)
async function loadPrompts() {
  const project = selectedProject();
  const key = project ? `${project.id}:${project.review?.status ?? 'none'}:${project.review?.approved ?? 0}` : '';
  if (frame.prompts.key === key) return;
  frame.prompts.key = key;
  const seq = ++frame.prompts.seq;
  if (!project || (project.review?.status ?? 'none') === 'none') {
    els.mechanismPrompts.replaceChildren(element('p', 'この試作品には、AI 構成の審査がまだありません。審査を始めると、試作品の中の AI に渡すプロンプトの全文をここで読めます。', 'muted'));
    return;
  }
  try {
    const { review } = await api(reviewPath(project.id));
    if (seq !== frame.prompts.seq) return;
    const prompts = review?.harness?.prompts ?? [];
    if (prompts.length === 0) {
      els.mechanismPrompts.replaceChildren(element('p', 'この構成には、プロンプトがありません。', 'muted'));
      return;
    }
    const nodes = [element('p', `試作品の中の AI に渡すプロンプトの全文です(${prompts.length} つ)。AI 構成の審査の harness と同じものです。`, 'muted')];
    for (const prompt of prompts) nodes.push(element('h4', `${prompt.label}(${prompt.participant})`), element('pre', prompt.text, 'mechanism-prompt'));
    els.mechanismPrompts.replaceChildren(...nodes);
  } catch (error) {
    if (seq !== frame.prompts.seq) return;
    frame.prompts.key = '';
    els.mechanismPrompts.replaceChildren(element('p', `プロンプトを読めませんでした: ${error.message}`, 'muted'));
  }
}

// ---- 「その場で」の 1 行(5.1) ----
// <p class="hint" data-hint="種類"> は、その種類の操作を hintState.limit 回したら出さない。回数は Studio のデータの置き場に残る(hints.js)
function renderHints() {
  for (const hint of document.querySelectorAll('.hint[data-hint]')) {
    hint.hidden = hintState.loaded && (hintState.counts[hint.dataset.hint] ?? 0) >= hintState.limit;
  }
}

function applyHints(hints) {
  hintState.counts = hints?.counts ?? {};
  hintState.limit = hints?.limit ?? 2;
  hintState.loaded = true;
  renderHints();
}

async function loadHints() {
  try {
    const { hints } = await api('/api/hints');
    applyHints(hints);
  } catch {
    // 読めないときは、どの 1 行も出したままにする
  }
}

// 操作を 1 回したことを残す。覚えた回数に届いていれば送らない
async function sawHint(kind) {
  if ((hintState.counts[kind] ?? 0) >= hintState.limit) return;
  hintState.counts = { ...hintState.counts, [kind]: (hintState.counts[kind] ?? 0) + 1 };
  renderHints();
  try {
    const { hints } = await api('/api/hints', { method: 'POST', json: { seen: kind } });
    applyHints(hints);
  } catch {
    // 残せなくても、操作は済んでいる
  }
}

els.hintsReset.addEventListener('click', async () => {
  try {
    const { hints } = await api('/api/hints', { method: 'POST', json: { reset: true } });
    applyHints(hints);
    els.hintsResetNote.hidden = false;
    els.hintsResetNote.textContent = '覚えて出さなくなった案内を、もう一度出します。';
  } catch (error) {
    handleError(error);
  }
});

// ---- 「これは何?」(5.2) ----
// data-explain の付いた部品に、閉じた「これは何?」を置く。置く場所は data-explain-after の子の後ろ。なければ最初の見出しの後ろ、それもなければ最後。
// 専門の中身(プロンプト、記録、接続)は、仕組みの引き出しへのボタンにする
function mountExplains() {
  for (const part of document.querySelectorAll('[data-explain]')) {
    if (part.querySelector(':scope > details.explain')) continue;
    const box = explainBox(part.dataset.explain, { onMore: () => setDrawer('mechanism') });
    const after = part.dataset.explainAfter ? part.querySelector(part.dataset.explainAfter) : part.querySelector(':scope > :is(h2, h3, h4, legend, figcaption)');
    // 置く場所が部品の子でなければ(入れ子の中なら)、その子の後ろではなく、入れ子を含む子の後ろに置く
    let anchor = after;
    while (anchor && anchor.parentElement !== part) anchor = anchor.parentElement;
    if (anchor) anchor.after(box);
    else part.append(box);
  }
}

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
  mountExplains();
  // お客さんの前(5.4)。見せる画面の「架空」の札と 3 つの文
  fillState($('show-notice'), 'customer');
  frame.ready = true;
  loadHints();
  await refresh();
  renderFrame();
  pollTimer = setInterval(refresh, POLL_MS);
}
