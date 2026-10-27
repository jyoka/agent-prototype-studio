// Studio 画面。トークンを持つ特権の画面なので、外から来た文字は必ず textContent で出す。
const TOKEN_KEY = 'prototype-studio-token';
const POLL_MS = 3000;
const MESSAGE_WINDOW_MS = 5000;
const MAX_MESSAGES_PER_WINDOW = 20;
const MAX_UNEXPECTED_LOADS = 3;
const MAX_EVENTS = 50;
const RUN_STATUS = {
  running: (run) => `${run.agent}が作業しています…`,
  done: () => '終わりました',
  failed: () => '失敗しました',
  cancelled: () => '中断しました',
  'timed-out': () => '時間の上限を超えたので止めました',
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
};
// 試作品からプロダクト内 AI への要求。連打で実モデルを呼び続けないよう、数を絞る
const AI_WINDOW_MS = 5000;
const MAX_AI_REQUESTS_PER_WINDOW = 10;
const MAX_AI_IN_FLIGHT = 3;
const MAX_AI_TEXT = 2000;
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
  list: $('project-list'),
  title: $('project-title'),
  reopen: $('reopen'),
  rebuild: $('rebuild'),
  reset: $('reset'),
  aiBadge: $('ai-badge'),
  aiStatus: $('ai-status'),
  retryBar: $('retry-bar'),
  aiTrace: $('ai-trace'),
  frameHost: $('frame-host'),
  buildStatus: $('build-status'),
  events: $('events'),
  eventsEmpty: $('events-empty'),
  agentStatus: $('agent-status'),
  conversation: $('conversation'),
  requestForm: $('request-form'),
  requestText: $('request-text'),
  send: $('send'),
  cancel: $('cancel'),
  examples: $('examples'),
  exampleList: $('example-list'),
  workBadge: $('work-badge'),
  workingStatus: $('working-status'),
  saveForm: $('save-form'),
  versionName: $('version-name'),
  saveVersion: $('save-version'),
  versionsMessage: $('versions-message'),
  versionList: $('version-list'),
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
// 詳細の欄に出している、プロダクト内 AI の会話と状態。
// choices は選べる接続と、実行の前に出す「送るもの」と「費用」。confirm は実モデルへ切り替える前の確認。
// retry は設定が変わる前の会話と、試し直しの結果(Studio の画面だけに出す。試作品には渡さない)
const ai = { projectId: null, session: null, choices: null, seq: 0, confirm: null, switching: false, retry: null };
// 試し直している試作品。別の試作品を選んでも、その試作品の欄には出さない
const retryingProjects = new Set();
// AI の実行の記録(#277)。open は、開いている「渡したもの、受け取ったもの」の記録の ID
const trace = { projectId: null, entries: null, snapshot: '', seq: 0, timer: null, open: new Set() };
const TRACE_POLL_MS = 1000;
// 応答を待っている発言の数を、試作品ごとに数える。開き直しや作り直しの後も「止める」を出し続けるため
const waitingByProject = new Map();
const waitingFor = (projectId) => waitingByProject.get(projectId) ?? 0;
// 詳細の欄の「版」。保存した版の一覧と、作業中がどの版と同じか
const versions = { projectId: null, data: null, seq: 0, busy: false, message: null };

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

function setConnection(state, text) {
  els.connection.dataset.state = state;
  els.connection.textContent = text;
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
    const snapshot = JSON.stringify(data.projects);
    if (snapshot !== lastSnapshot) {
      lastSnapshot = snapshot;
      projects = data.projects;
      render();
      await syncConversation();
    }
    // 作業中のファイルは、Studio の外でも変わり得るので、毎回確かめる
    await loadVersions();
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
    selectedId = projects.find((p) => p.id === 'sample-library')?.id ?? projects[0]?.id ?? null;
  }
  renderList();
  const project = selectedProject();
  els.title.textContent = project ? project.title : '試作品がありません';
  els.reopen.disabled = !project?.previewUrl;
  els.reset.disabled = !project?.previewUrl;
  els.rebuild.disabled = !project || project.building || project.running || project.versioning;
  renderBuild(project);
  renderMake(project);
  renderVersions(project);
  if (!project) {
    showPlaceholder('試作品がありません。');
  } else if (!project.previewUrl) {
    showPlaceholder('表示できる版がありません。右の「詳細」を見てください。');
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
    state.dataset.state = failed ? 'error' : 'ok';
    state.textContent = project.running
      ? '作る AI が作業中'
      : project.versioning
        ? '版を保存か復元しています'
        : project.building
        ? 'ビルド中'
        : failed
          ? 'ビルドに失敗'
          : project.previewUrl
            ? '開けます'
            : '';
    button.append(name, state);
    button.addEventListener('click', () => {
      if (selectedId === project.id) return;
      selectedId = project.id;
      makeError = null;
      versions.message = null;
      render();
      syncConversation();
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
    nodes.push(element('p', '直し方: app/ の中のファイルを直してから「作り直す」を押してください。', 'hint'));
    const where = element('p', 'ファイルの場所: ', 'hint');
    where.append(element('code', project.appDir));
    nodes.push(where);
    if (project.previewUrl) {
      nodes.push(element('p', '中央には、前にビルドできた版を表示しています。', 'notice'));
    }
  }
  els.buildStatus.replaceChildren(...nodes);
}

// 作る欄。接続の種類と、どの認証で動くかを、送る前に見せる(#274 の Ready conditions)
function renderAgentStatus() {
  const nodes = [];
  if (!agent) {
    els.agentStatus.replaceChildren();
    return;
  }
  els.agentStatus.dataset.kind = agent.kind;
  els.agentStatus.dataset.billing = agent.billing.mode;
  els.agentStatus.dataset.ready = String(agent.ready);
  if (agent.kind === 'fake') {
    nodes.push(element('p', '接続: 偽接続', 'agent-name'));
    nodes.push(element('p', '決まった応答だけを返します。Claude Code もモデルも呼ばないので、料金はかかりません。'));
    nodes.push(element('p', `Claude Code に切り替えたときの認証の見込み: ${agent.billing.text}`, 'muted'));
  } else {
    nodes.push(element('p', `接続: Claude Code${agent.version ? ` ${agent.version}` : ''}`, 'agent-name'));
    if (agent.problem) {
      nodes.push(element('p', agent.problem, 'failed'));
    } else {
      const billing = element('p', `認証と課金: ${agent.billing.text}`, 'billing');
      nodes.push(billing);
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

function renderExamples() {
  const examples = agent?.examples ?? [];
  els.examples.hidden = examples.length === 0;
  els.exampleList.replaceChildren(
    ...examples.map((example) => {
      const li = document.createElement('li');
      const button = element('button', example.text);
      button.type = 'button';
      button.addEventListener('click', () => {
        els.requestText.value = example.text;
        els.requestText.focus();
      });
      li.append(button, element('span', example.note, 'muted'));
      return li;
    }),
  );
}

function runningRun(projectId) {
  return conversations.get(projectId)?.runs.find((run) => run.status === 'running') ?? null;
}

function renderMake(project) {
  renderAgentStatus();
  renderExamples();
  const running = Boolean(project?.running || sending?.projectId === project?.id || (project && runningRun(project.id)));
  const ready = Boolean(project && agent?.ready && !running && !project.building && !project.versioning && !sending);
  els.requestText.disabled = !ready;
  els.send.disabled = !ready;
  els.cancel.hidden = !(project && runningRun(project.id));
  renderConversation(project);
}

function renderConversation(project) {
  const runs = project ? conversations.get(project.id)?.runs ?? [] : [];
  const nodes = runs.map((run) => {
    const li = document.createElement('li');
    li.className = 'run';
    li.dataset.status = run.status;
    const request = element('div', undefined, 'bubble user');
    request.append(element('span', 'あなた', 'who'), element('p', run.request));
    li.append(request);
    const steps = element('ul', undefined, 'steps');
    for (const item of run.items) {
      const step = document.createElement('li');
      step.dataset.kind = item.kind;
      if (item.kind === 'assistant') {
        step.className = 'bubble agent';
        step.append(element('span', run.agent, 'who'), element('p', item.text));
      } else {
        step.append(element('span', ITEM_LABELS[item.kind] ?? item.kind, 'who'), element('span', item.text, 'text'));
      }
      steps.append(step);
    }
    li.append(steps);
    const status = element('p', (RUN_STATUS[run.status] ?? (() => run.status))(run), 'run-status');
    if (run.auth) status.append(element('span', `(認証の報告: ${run.auth})`, 'muted'));
    li.append(status);
    return li;
  });
  if (makeError) nodes.push(element('li', makeError, 'make-error'));
  if (nodes.length === 0) nodes.push(element('li', 'まだ依頼はありません。', 'muted empty'));
  const atBottom = els.conversation.scrollHeight - els.conversation.scrollTop - els.conversation.clientHeight < 40;
  els.conversation.replaceChildren(...nodes);
  if (atBottom || sending) els.conversation.scrollTop = els.conversation.scrollHeight;
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

async function submitRequest() {
  const project = selectedProject();
  const text = els.requestText.value.trim();
  if (!project || !text || sending) return;
  sending = { projectId: project.id };
  makeError = null;
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
    if (error instanceof ApiError && !['offline', 'token'].includes(error.code)) {
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

const CONNECTION_CHECK = '架空のデータだけで試します。上のものが送られることと、費用がかかることを確かめました';

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

// 実モデルへ切り替える前に、送り先、送るもの、送らないもの、費用を出す
function sendsBlock(option) {
  const box = element('div', undefined, 'ai-sends');
  box.append(element('p', `送り先: ${option.sends.to}`));
  const list = element('ul');
  list.setAttribute('aria-label', '送るもの');
  list.append(...option.sends.items.map((item) => element('li', item)));
  box.append(element('p', '送るもの:'), list, element('p', option.sends.notSent, 'muted'));
  const billing = element('p', undefined, 'ai-billing');
  billing.dataset.kind = option.billing.kind;
  billing.append(element('strong', `費用: ${option.billing.label}`), document.createTextNode(` ${option.billing.text}`));
  box.append(billing);
  const prompt = element('details');
  prompt.append(element('summary', '送る指示の全文を見る'), element('pre', option.sends.systemPrompt));
  box.append(prompt);
  return box;
}

function confirmBlock(option) {
  const box = element('div', undefined, 'ai-confirm');
  box.setAttribute('role', 'group');
  box.setAttribute('aria-label', `${option.label} に切り替える前の確認`);
  box.append(element('p', `${option.label} に切り替えると、発言のたびに実際の AI モデルを呼びます。`, 'notice'), sendsBlock(option));
  const label = element('label', undefined, 'ai-check');
  const check = document.createElement('input');
  check.type = 'checkbox';
  check.checked = ai.confirm.checked;
  label.append(check, document.createTextNode(CONNECTION_CHECK));
  const ok = element('button', `${option.label} に切り替える`);
  ok.type = 'button';
  ok.disabled = !ai.confirm.checked || ai.switching;
  check.addEventListener('change', () => {
    ai.confirm.checked = check.checked;
    ok.disabled = !check.checked || ai.switching;
  });
  ok.addEventListener('click', () => selectConnection(option.kind, true));
  const cancel = element('button', 'やめる');
  cancel.type = 'button';
  cancel.addEventListener('click', () => {
    ai.confirm = null;
    renderAi();
  });
  const buttons = element('div', undefined, 'ai-buttons');
  buttons.append(ok, cancel);
  box.append(label, buttons);
  return box;
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
    radio.checked = ai.confirm ? ai.confirm.kind === option.kind : session.connection.kind === option.kind;
    radio.disabled = !option.available || waitingFor(ai.projectId) > 0 || ai.switching;
    radio.addEventListener('change', () => {
      if (option.billing) {
        ai.confirm = { kind: option.kind, checked: false };
        renderAi();
      } else {
        ai.confirm = null;
        selectConnection(option.kind, false);
      }
    });
    label.append(radio, document.createTextNode(option.label));
    box.append(label);
    if (!option.available) box.append(element('p', option.reason, 'hint'));
  }
  return box;
}

function viaLabel(kind) {
  return kind ? `(${ai.choices?.options.find((o) => o.kind === kind)?.label ?? kind})` : '';
}

// 試し直しの結果。同じ発言への、前の設定の応答と今の設定の応答を並べる
function retryResultBlock(result) {
  const box = element('section', undefined, 'ai-retry');
  box.setAttribute('aria-label', '試し直しの結果');
  box.append(element('p', '試し直しの結果(前の設定 → 今の設定)', 'ai-name'));
  const list = element('ol');
  for (const reply of result.replies) {
    const li = document.createElement('li');
    const changed = reply.before !== reply.after;
    li.dataset.changed = String(changed);
    li.append(
      element('p', `あなた: ${reply.text}`, 'retry-user'),
      element('p', `前${viaLabel(reply.beforeVia)}: ${reply.before ?? '(応答なし)'}`, 'retry-before'),
      element('p', `今${viaLabel(reply.afterVia)}: ${reply.after}`, 'retry-after'),
      element('p', changed ? '応答が変わりました' : '同じ応答です', 'muted'),
    );
    list.append(li);
  }
  box.append(list);
  if (result.skipped.length > 0) {
    box.append(element('p', `送り直さなかった修正(今の設定にない項目か、決まりに合わない値): ${result.skipped.join('、')}`, 'hint'));
  }
  if (result.stopped) box.append(element('p', `途中で止まりました: ${result.stopped}`, 'failed'));
  return box;
}

// 試す画面の上。プロダクト内 AI の設定が変わった後に、前の会話の発言と修正を、今の設定で送り直す。
// 応答するのはプロダクト内 AI で、作る AI は動かない
function renderRetry() {
  const info = ai.session && ai.projectId === selectedId ? ai.retry : null;
  els.retryBar.hidden = !info?.available;
  if (!info?.available) {
    els.retryBar.replaceChildren();
    return;
  }
  const counts = `発言 ${info.userMessages} 件${info.corrections > 0 ? `、修正 ${info.corrections} 件` : ''}`;
  const fresh = !ai.session.messages.some((m) => m.role === 'user' || m.role === 'correction');
  const busy = info.retrying || retryingProjects.has(ai.projectId);
  let text;
  if (busy) text = `前の会話(${counts})を、今の設定で送り直しています…`;
  else if (info.result) text = `前の会話(${counts})を、今の設定で送り直しました。前と今の応答は、右の「詳細」の「試し直しの結果」で比べられます。`;
  else if (fresh) text = `プロダクト内 AI の設定が変わったので、会話は新しい設定で最初から始まっています。前の会話(${counts})を、今の設定で送り直せます。`;
  else text = `設定が変わる前の会話(${counts})を、今の設定で送り直せます。今の会話は最初に戻ります。`;
  const nodes = [element('p', text)];
  const option = ai.choices?.options.find((o) => o.kind === ai.session.connection.kind);
  if (option?.billing) {
    nodes.push(element('p', `接続は ${option.label} です。送り直す発言ごとに実際の AI モデルを呼び、費用がかかります(${info.userMessages} 回)。`, 'retry-cost'));
  }
  const button = element('button', info.result ? 'もう一度試し直す' : '前の発言で試し直す');
  button.type = 'button';
  button.disabled = busy || ai.switching || waitingFor(ai.projectId) > 0;
  button.addEventListener('click', retryAi);
  els.retryBar.replaceChildren(...nodes, button);
}

// プロダクト内 AI の接続(モックか実モデルか)と、AI が理解した状態を出す
function renderAi() {
  const { session } = ai;
  renderRetry();
  els.aiBadge.hidden = !session;
  if (!session) {
    els.aiStatus.replaceChildren(
      element('p', ai.projectId ? 'この試作品はプロダクト内 AI を使っていません。' : '試作品を開くと、ここに出ます。', 'muted'),
    );
    renderTrace();
    syncTracePolling();
    return;
  }
  els.aiBadge.dataset.kind = session.connection.kind;
  els.aiBadge.textContent = `AI: ${session.connection.label}`;
  els.aiBadge.title = session.connection.description;
  const connection = element('p', undefined, 'ai-connection');
  connection.dataset.kind = session.connection.kind;
  connection.append(element('strong', `接続: ${session.connection.label}`), document.createTextNode(` ${session.connection.description}`));
  const nodes = [connection];
  // 実モデルを選んでいる間は、発言の前にいつも送り先と費用が見えるようにする
  const current = ai.choices?.options.find((o) => o.kind === session.connection.kind);
  if (current?.billing && !ai.confirm) nodes.push(sendsBlock(current));
  nodes.push(connectionPicker(session));
  if (ai.confirm) {
    const option = ai.choices?.options.find((o) => o.kind === ai.confirm.kind);
    if (option) nodes.push(confirmBlock(option));
  }
  if (waitingFor(ai.projectId) > 0) {
    const waiting = element('div', undefined, 'ai-waiting');
    waiting.setAttribute('role', 'status');
    const stop = element('button', '応答を止める');
    stop.type = 'button';
    stop.addEventListener('click', cancelAi);
    waiting.append(element('span', `${session.connection.label} の応答を待っています…`), stop);
    nodes.push(waiting);
  }
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
  if (ai.retry?.result) nodes.push(retryResultBlock(ai.retry.result));
  els.aiStatus.replaceChildren(...nodes);
  renderTrace();
  syncTracePolling();
}

async function loadAi(projectId) {
  const seq = ++ai.seq;
  ai.projectId = projectId;
  ai.session = null;
  ai.choices = null;
  ai.confirm = null;
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
  renderAi();
}

function showAiSession(projectId, session, retry) {
  if (ai.projectId !== projectId) return;
  // 先に送った読み込みの結果で、新しい状態を上書きしない
  ai.seq += 1;
  ai.session = session;
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
      badge: '作業中(まだ保存していません)',
      text: '作業中: まだ保存した版はありません。良い状態になったら保存してください。',
    };
  }
  if (working.files === 'changed' || !version) {
    return {
      state: 'changed',
      badge: '作業中(保存していない変更あり)',
      text: `作業中には、保存していない変更があります${base ? `(保存版 ${versionSubject(base)}から)` : ''}。`,
    };
  }
  if (working.conversation === 'changed') {
    return {
      state: 'partly',
      badge: `作業中(会話が v${version.number} から変わっています)`,
      text: `作業中のファイルは保存版 ${versionSubject(version)}と同じです。会話と状態は、保存したときから変わっています。`,
    };
  }
  if (working.conversation === 'initial') {
    return {
      state: 'partly',
      badge: `作業中(ファイルは v${version.number} と同じ)`,
      text: `作業中のファイルは保存版 ${versionSubject(version)}と同じです。会話と状態は最初のままです。保存したときの会話から続けるには、その版の「復元」を押してください。`,
    };
  }
  return { state: 'saved', badge: `作業中 = 保存版 v${version.number}`, text: `作業中は保存版 ${versionSubject(version)}と同じです。` };
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
  const locked = !project || project.running || project.building || project.versioning || versions.busy;
  els.versionName.disabled = locked;
  els.saveVersion.disabled = locked;
  els.versionsMessage.hidden = !versions.message;
  els.versionsMessage.textContent = versions.message?.text ?? '';
  els.versionsMessage.dataset.kind = versions.message?.kind ?? '';
  if (!data) {
    els.workBadge.hidden = true;
    els.workingStatus.textContent = project ? '読み込んでいます…' : '';
    els.versionList.replaceChildren();
    return;
  }
  const view = workingView(data);
  els.workBadge.hidden = false;
  els.workBadge.dataset.state = view.state;
  els.workBadge.textContent = view.badge;
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

async function selectConnection(kind, confirmed) {
  const projectId = ai.projectId;
  if (!projectId) return;
  ai.switching = true;
  renderAi();
  try {
    const { session, retry } = await api(`/api/projects/${encodeURIComponent(projectId)}/ai/connection`, {
      method: 'POST',
      json: { kind, confirmed },
    });
    if (ai.projectId !== projectId) return;
    ai.confirm = null;
    addEvent('info', `プロダクト内 AI の接続を「${session.connection.label}」にしました。会話と状態はそのまま引き継ぎます。`);
    showAiSession(projectId, session, retry);
    // 試作品にも知らせる(studio.ai.onChange)
    if (preview.projectId === projectId) preview.port?.postMessage({ type: 'ai-session', session });
  } catch (error) {
    if (error instanceof ApiError && !['offline', 'token'].includes(error.code)) {
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
    showAiSession(projectId, session, retry);
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
  text: 'JSON でなかったので、本文を返事にしました。状態は変えていません',
};

function connectionNote(connection) {
  return connection.real ? `${connection.label}(実際の AI モデル)` : `${connection.label}(AI モデルは呼んでいません)`;
}

function traceTitle(entry) {
  if (entry.type === 'reply') return `発言 → ${connectionNote(entry.connection)}`;
  if (entry.type === 'correction') return '条件の修正(試作品から)';
  if (entry.type === 'connection') return `接続の切り替え: ${entry.previous.label} → ${entry.connection.label}(Studio の画面から)`;
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
  if (input.systemPrompt) box.append(preBlock(entry, '指示(--system-prompt)の全文', input.systemPrompt));
  if (input.stdin) box.append(preBlock(entry, '本文(標準入力)の全文', input.stdin));
  if (output) {
    if (output.format) box.append(labeled('応答の形', TRACE_FORMATS[output.format] ?? output.format));
    box.append(labeled('受け取った updates', output.updates));
    if (Number.isFinite(output.costUsd)) box.append(labeled('費用の目安(CLI の報告)', `$${output.costUsd.toFixed(4)}`));
    if (Number.isFinite(output.durationMs)) box.append(labeled('処理の時間(CLI の報告)', formatSeconds(output.durationMs)));
  }
  return box;
}

function traceItem(entry) {
  const li = element('li', undefined, 'trace-entry');
  li.dataset.type = entry.type;
  li.dataset.status = entry.status;
  li.dataset.real = String(Boolean(entry.connection?.real));
  const head = element('p', undefined, 'trace-head');
  head.append(element('time', formatTime(entry.at)), element('strong', traceTitle(entry)));
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
  if (entry.type === 'reset') li.append(labeled('最初の状態', entry.state.map((s) => `${s.label}「${s.value}」`).join('、')));
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
  if (entry.type === 'reply' && entry.input) li.append(traceInternals(entry));
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
    labeled('試作品から AI への操作', '会話を読む、発言を送る、条件を直す。接続の切り替えと「応答を止める」は Studio の画面だけでできます。'),
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
    addEvent('warning', '試作品が何度も別のページへ移動しようとしたので、止めました。「開き直す」で最初から開けます。');
    showPlaceholder('試作品を止めました。右の「詳細」を見てください。');
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
  if (data.op === 'send') return typeof data.text === 'string' && data.text.length <= MAX_AI_TEXT;
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
        ? api(`${base}/messages`, { method: 'POST', json: { text: data.text } })
        : data.op === 'correct'
          ? api(`${base}/corrections`, { method: 'POST', json: { changes: data.changes } })
          : api(base);
    inFlight += 1;
    // 応答を待つ間は、詳細の欄に「止める」を出す
    const waiting = data.op === 'send';
    if (waiting) {
      waitingByProject.set(projectId, waitingFor(projectId) + 1);
      if (ai.projectId === projectId) renderAi();
    }
    try {
      const { session, retry } = await request;
      showAiSession(projectId, session, retry);
      reply({ id: data.id, ok: true, session });
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
  // つながらないときも、ボタンと詳細の欄を元に戻す
  render();
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
