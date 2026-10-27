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
};
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
};

class ApiError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

let token = readToken();
let projects = [];
let lastSnapshot = '';
let selectedId = null;
let pollTimer = null;
let refreshSeq = 0;
let appliedSeq = 0;
const preview = { frame: null, url: null, expectingLoad: false, unexpectedLoads: [], port: null };
// 作る会話。プロジェクトごとに、サーバーの版の番号と実行の一覧を持つ
let agent = null;
const conversations = new Map();
let sending = null;
let makeError = null;

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
    return await fetch(path, { ...options, headers: { ...options.headers, 'X-Studio-Token': token ?? '' } });
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
    throw new ApiError(body?.error?.code ?? 'http', body?.error?.message ?? `サーバーが ${response.status} を返しました`);
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
    if (snapshot === lastSnapshot) return;
    lastSnapshot = snapshot;
    projects = data.projects;
    render();
    await syncConversation();
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
  els.rebuild.disabled = !project || project.building || project.running;
  renderBuild(project);
  renderMake(project);
  if (!project) {
    showPlaceholder('試作品がありません。');
  } else if (!project.previewUrl) {
    showPlaceholder('表示できる版がありません。右の「詳細」を見てください。');
  } else if (project.previewUrl !== preview.url) {
    clearEvents();
    showPreview(project.previewUrl);
  }
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
      render();
      syncConversation();
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
  const ready = Boolean(project && agent?.ready && !running && !project.building && !sending);
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
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ request: text }),
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
  els.frameHost.replaceChildren(element('p', text, 'placeholder'));
}

// 試作品は sandbox の iframe(allow-same-origin なし)で、別ポートから開く(ADR-0001 の層 2)。
function showPreview(url) {
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
  showPreview(preview.url);
}

function connect(iframe) {
  const channel = new MessageChannel();
  const port = channel.port1;
  let windowStart = Date.now();
  let count = 0;
  port.onmessage = (event) => {
    if (iframe !== preview.frame) return;
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
  showPreview(project.previewUrl);
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
