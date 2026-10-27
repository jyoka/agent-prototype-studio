// Studio 画面。トークンを持つ特権の画面なので、外から来た文字は必ず textContent で出す。
const TOKEN_KEY = 'prototype-studio-token';
const POLL_MS = 3000;
const MESSAGE_WINDOW_MS = 5000;
const MAX_MESSAGES_PER_WINDOW = 20;
const MAX_UNEXPECTED_LOADS = 3;
const MAX_EVENTS = 50;
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
  frameHost: $('frame-host'),
  buildStatus: $('build-status'),
  events: $('events'),
  eventsEmpty: $('events-empty'),
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
const preview = { frame: null, url: null, projectId: null, expectingLoad: false, unexpectedLoads: [], port: null };
// 詳細の欄に出している、プロダクト内 AI の会話と状態
const ai = { projectId: null, session: null, seq: 0 };

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

async function api(path, options = {}) {
  let response;
  try {
    const headers = { 'X-Studio-Token': token ?? '' };
    let body;
    if (options.json !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(options.json);
    }
    response = await fetch(path, { method: options.method, headers, body });
  } catch {
    throw new ApiError('offline', MESSAGES.offline);
  }
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
    const snapshot = JSON.stringify(data.projects);
    if (snapshot === lastSnapshot) return;
    lastSnapshot = snapshot;
    projects = data.projects;
    render();
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
  els.rebuild.disabled = !project || project.building;
  renderBuild(project);
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
    state.textContent = project.building ? 'ビルド中' : failed ? 'ビルドに失敗' : project.previewUrl ? '開けます' : '';
    button.append(name, state);
    button.addEventListener('click', () => {
      if (selectedId === project.id) return;
      selectedId = project.id;
      render();
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

function formatAiValue(field, value) {
  if (value === null || value === undefined) return '未定';
  return field.type === 'number' ? `${Number(value).toLocaleString('ja-JP')}${field.unit ?? ''}` : String(value);
}

// プロダクト内 AI の接続(モックか実モデルか)と、AI が理解した状態を出す
function renderAi() {
  const { session } = ai;
  els.aiBadge.hidden = !session;
  if (!session) {
    els.aiStatus.replaceChildren(
      element('p', ai.projectId ? 'この試作品はプロダクト内 AI を使っていません。' : '試作品を開くと、ここに出ます。', 'muted'),
    );
    return;
  }
  els.aiBadge.dataset.kind = session.connection.kind;
  els.aiBadge.textContent = `AI: ${session.connection.label}`;
  els.aiBadge.title = session.connection.description;
  const connection = element('p', undefined, 'ai-connection');
  connection.dataset.kind = session.connection.kind;
  connection.append(element('strong', `接続: ${session.connection.label}`), document.createTextNode(` ${session.connection.description}`));
  const list = element('dl', undefined, 'ai-state');
  list.setAttribute('aria-label', 'AI が理解した状態');
  for (const field of session.fields) {
    list.append(element('dt', field.label), element('dd', formatAiValue(field, session.state[field.key])));
  }
  const count = session.messages.filter((m) => m.role === 'user').length;
  els.aiStatus.replaceChildren(
    connection,
    element('p', '架空のデータで試してください。実在の人や会社の情報は入れないでください。', 'muted'),
    element('p', session.name, 'ai-name'),
    element('p', `利用者の発言: ${count} 件`, 'muted'),
    list,
  );
}

async function loadAi(projectId) {
  const seq = ++ai.seq;
  ai.projectId = projectId;
  ai.session = null;
  renderAi();
  if (!projectId) return;
  try {
    const { session } = await api(`/api/projects/${encodeURIComponent(projectId)}/ai`);
    if (seq !== ai.seq) return;
    ai.session = session;
  } catch (error) {
    if (seq !== ai.seq) return;
    if (!(error instanceof ApiError && error.code === 'no-ai')) handleError(error);
  }
  renderAi();
}

function showAiSession(projectId, session) {
  if (ai.projectId !== projectId) return;
  // 先に送った読み込みの結果で、新しい状態を上書きしない
  ai.seq += 1;
  ai.session = session;
  renderAi();
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
    try {
      const { session } = await request;
      showAiSession(projectId, session);
      reply({ id: data.id, ok: true, session });
    } catch (error) {
      const code = error instanceof ApiError ? error.code : 'internal';
      if (code === 'offline' || code === 'token') handleError(error);
      else addEvent('warning', `AI への要求に失敗しました: ${error.message}`);
      reply({ id: data.id, ok: false, error: { code, message: error.message } });
    } finally {
      inFlight -= 1;
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
      const { session } = await api(`/api/projects/${encodeURIComponent(project.id)}/ai/reset`, { method: 'POST' });
      showAiSession(project.id, session);
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
