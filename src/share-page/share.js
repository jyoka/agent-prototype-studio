// 参加者のページ(docs/design/collaboration.md の 9.4。K7 の 2 枚目と 3 枚目)。中継のサーバーが配る静的なファイルで、鍵は持たない。
// 鍵と札と署名の鍵は招待のリンクのフラグメント(# の後)にあり、開いたらすぐ sessionStorage に移してアドレス欄から消す。
// 書き込み(板の項目、コメント、反応、承認)は、自分の署名の鍵で署名してから会の鍵で包む。Studio が署名と役を確かめて当てる。
// 承認を送っても、作る AI はすぐには動かない。Studio が確かめ、進行役が自分の PC で「作る AI に送る」を押してから動く。
// 中継のサーバーとは暗号文だけをやり取りする。写しはメモリーと sessionStorage だけに置き、長く残る所には置かない。
// 外から来た文字は、必ず textContent で出す。
import { aadOf, importKey, importSigner, open, randomText, seal, signEvent, textPrint } from '/s/seal.js';

const STORE_PREFIX = 'prototype-studio-share:';
const RETRY_MS = [500, 1000, 2000, 4000];
// 中継のサーバーは 15 秒ごとに心拍を送る。これだけ何も来なければ、切れたと見てつなぎ直す
const SILENCE_MS = 45_000;
// 送れなかった書き込みを送り直す間
const RESEND_MS = 2000;
const sessionId = location.pathname.split('/').pop();
const storeKey = `${STORE_PREFIX}${sessionId}`;
const pendingKey = `${storeKey}:pending`;
const $ = (id) => document.getElementById(id);

const state = {
  key: null,
  ticket: null,
  me: null,
  // 署名の鍵(秘密の側)。招待のリンクになければ書けない
  signer: null,
  docs: null,
  version: 0,
  online: false,
  gone: false,
  // 送る書き込み。seq は中継のサーバーが付けた番号(まだ届いていなければ null)。読み込み直しても残すため sessionStorage にも置く
  pending: [],
  flushing: false,
  resendTimer: null,
  // 直している項目。写しが来ても、書きかけの欄を崩さない
  editing: null,
  error: null,
};

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined && text !== null) node.textContent = text;
  if (className) node.className = className;
  return node;
}

// 招待のリンクを読む。鍵をアドレス欄と閲覧の履歴に残さない
function readLink() {
  const params = new URLSearchParams(location.hash.slice(1));
  if (params.get('k') && params.get('t') && params.get('m')) {
    sessionStorage.setItem(storeKey, JSON.stringify({ k: params.get('k'), t: params.get('t'), m: params.get('m'), s: params.get('s') }));
    history.replaceState(null, '', location.pathname);
  }
  try {
    return JSON.parse(sessionStorage.getItem(storeKey) ?? 'null');
  } catch {
    return null;
  }
}

const api = (pathname, options = {}) =>
  fetch(`/api/sessions/${sessionId}${pathname}`, {
    ...options,
    headers: { Authorization: `Bearer ${state.ticket}`, ...(options.body ? { 'Content-Type': 'application/json' } : {}) },
    cache: 'no-store',
  });

function setStatus(kind, text) {
  const status = $('share-status');
  status.dataset.state = kind;
  status.textContent = text;
}

function showError(text) {
  state.error = text;
  $('share-error').hidden = !text;
  $('share-error').textContent = text ?? '';
}

// 会のデータが消えた。手元の写しも消す
function gone(text = 'この会のデータは消しました。この画面の写しも消しました。') {
  state.gone = true;
  state.docs = null;
  state.pending = [];
  state.key = null;
  state.signer = null;
  clearTimeout(state.resendTimer);
  sessionStorage.removeItem(storeKey);
  sessionStorage.removeItem(pendingKey);
  $('share-main').hidden = true;
  $('share-main').replaceChildren();
  $('share-gone').hidden = false;
  $('share-gone').textContent = text;
  setStatus('gone', '共有は終わりました。');
}

const myRole = () => state.docs?.members?.find((m) => m.id === state.me)?.role ?? null;
// 決める人と参加者は、板とコメントを書ける。承認できるのは決める人だけ(collaboration.md の 3 節)
const canWrite = () => ['participant', 'decider'].includes(myRole()) && Boolean(state.signer);
const canApprove = () => myRole() === 'decider' && Boolean(state.signer);

async function loadDocs() {
  const response = await api('/files/docs');
  if (response.status === 410) return gone();
  if (response.status === 404) return;
  if (!response.ok) throw new Error(`docs ${response.status}`);
  const file = await response.json();
  if (file.version < state.version) return;
  const docs = await open(state.key, aadOf(sessionId, 'file:docs'), file.data);
  state.version = file.version;
  state.docs = docs;
  // Studio が当てた書き込みは、「送った」の印を外す。断られたものは理由を出す
  const refused = docs.results?.filter((r) => r.member === state.me && !r.ok && state.pending.some((p) => p.seq === r.seq)) ?? [];
  state.pending = state.pending.filter((p) => p.seq === null || p.seq > docs.seen);
  savePending();
  if (refused.length > 0) showError(`進行役の Studio が当てませんでした: ${refused.map((r) => r.message).join(' / ')}`);
  render();
}

function savePending() {
  if (state.gone) return;
  sessionStorage.setItem(pendingKey, JSON.stringify(state.pending.map(({ op, seq }) => ({ op, seq }))));
}

function loadPending() {
  try {
    const saved = JSON.parse(sessionStorage.getItem(pendingKey) ?? '[]');
    return Array.isArray(saved) ? saved.filter((p) => p && typeof p.op === 'object').map((p) => ({ op: p.op, seq: Number.isInteger(p.seq) ? p.seq : null })) : [];
  } catch {
    return [];
  }
}

// 書き込みを、書いた順に 1 つずつ送る。届かなければ残し、少し待つか、つながったときに送り直す
async function flush() {
  if (state.flushing || state.gone) return;
  state.flushing = true;
  clearTimeout(state.resendTimer);
  try {
    for (const item of [...state.pending]) {
      if (item.seq !== null) continue;
      const signed = await signEvent(state.signer, sessionId, { ...item.op, by: state.me });
      const data = await seal(state.key, aadOf(sessionId, 'row'), signed);
      let response;
      try {
        response = await api('/rows', { method: 'POST', body: JSON.stringify({ data }) });
      } catch {
        break;
      }
      if (response.status === 410) return gone();
      if (response.status === 403) {
        state.pending = state.pending.filter((p) => p !== item);
        showError('この役では書けません。');
        render();
        continue;
      }
      // 速すぎる、中継のサーバーの不具合など。順を崩さないよう、ここで止めて後で送り直す
      if (!response.ok) break;
      item.seq = (await response.json()).seq;
      savePending();
    }
  } finally {
    state.flushing = false;
  }
  if (!state.gone && state.pending.some((p) => p.seq === null)) state.resendTimer = setTimeout(flush, RESEND_MS);
}

function send(op) {
  showError(null);
  // 時刻は署名に入る。Studio は、反応と承認をこの時刻の順で当て、古いものの出し直しを断る
  state.pending.push({ op: { ...op, opId: randomText(9), at: new Date().toISOString() }, seq: null });
  savePending();
  render();
  flush();
}

// 写しに、まだ当たっていない自分の書き込みを重ねる
function boardWithPending() {
  const board = state.docs.board;
  let items = board.items.map((item) => ({ ...item }));
  for (const { op } of state.pending) {
    if (op.op === 'item-edit') items = items.map((item) => (item.id === op.id ? { ...item, text: op.text, pending: true } : item));
    if (op.op === 'item-remove') items = items.filter((item) => item.id !== op.id);
    if (op.op === 'item-add') items.push({ id: `pending-${op.opId}`, column: op.column, text: op.text, guess: false, pending: true, local: true });
  }
  return items;
}

function editForm(item) {
  const form = element('form', undefined, 'share-edit');
  const label = element('label', '項目の文');
  const input = element('input');
  input.type = 'text';
  input.maxLength = 300;
  input.value = state.editing.draft ?? item.text;
  input.id = `share-edit-${item.id}`;
  label.htmlFor = input.id;
  input.addEventListener('input', () => {
    state.editing.draft = input.value;
  });
  const save = element('button', '保存');
  save.type = 'submit';
  const cancel = element('button', 'やめる');
  cancel.type = 'button';
  cancel.addEventListener('click', () => {
    state.editing = null;
    render();
  });
  form.append(label, input, save, cancel);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const text = input.value.trim();
    state.editing = null;
    if (text && text !== item.text) send({ op: 'item-edit', id: item.id, text });
    else render();
  });
  return form;
}

function itemNode(item) {
  const li = element('li', undefined, 'share-item');
  li.dataset.id = item.id;
  if (state.editing?.id === item.id) {
    // 写しが来ても、書きかけの欄はそのまま使う
    state.editing.node ??= editForm(item);
    li.append(state.editing.node);
    return li;
  }
  li.append(element('p', item.text, 'share-item-text'));
  if (item.guess) li.append(element('span', '推測', 'share-badge'));
  if (item.pending) li.append(element('p', '送りました。進行役の Studio が受け取ると、みんなの画面に出ます。', 'share-pending'));
  if (canWrite() && !item.local) {
    const actions = element('div', undefined, 'share-actions');
    const edit = element('button', '直す');
    edit.type = 'button';
    edit.addEventListener('click', () => {
      state.editing = { id: item.id, draft: null, node: null };
      render();
      $(`share-edit-${item.id}`)?.focus();
    });
    const remove = element('button', '消す');
    remove.type = 'button';
    remove.addEventListener('click', () => send({ op: 'item-remove', id: item.id }));
    actions.append(edit, remove);
    li.append(actions);
  }
  return li;
}

function renderBoard() {
  const { board } = state.docs;
  const items = boardWithPending();
  if (state.editing && !items.some((item) => item.id === state.editing.id)) {
    showError(state.editing.draft ? `直している項目が板から消えたので、閉じました。書きかけ: ${state.editing.draft}` : null);
    state.editing = null;
  }
  $('share-columns').replaceChildren(...board.columns.map((column) => {
    const box = element('section', undefined, 'share-column');
    box.setAttribute('aria-label', column.label);
    const list = element('ul', undefined, 'share-list');
    list.append(...items.filter((item) => item.column === column.id).map(itemNode));
    if (list.childElementCount === 0) list.append(element('li', '(まだ項目がありません)', 'muted'));
    box.append(element('h3', column.label), list);
    return box;
  }));
  const select = $('share-add-column');
  if (select.options.length !== board.columns.length) {
    select.replaceChildren(...board.columns.map((column) => {
      const option = element('option', column.label);
      option.value = column.id;
      return option;
    }));
  }
  $('share-add').hidden = !canWrite();
  $('share-asks').replaceChildren(...(board.asks.length === 0 ? [element('li', '(ありません)', 'muted')] : board.asks.map((ask) => element('li', ask.text))));
}

function renderDocs() {
  const { requirements, dataDesign, scenes, openItems } = state.docs;
  $('share-requirements').replaceChildren(
    ...(requirements.status === 'none'
      ? [element('p', '(まだありません)', 'muted')]
      : requirements.sections.map((section) => {
        const box = element('div', undefined, 'share-req');
        const list = element('ul', undefined, 'share-list');
        list.append(...(section.items.length === 0 ? [element('li', '(なし)', 'muted')] : section.items.map((item) => element('li', item.guess ? `${item.text}(推測)` : item.text))));
        box.append(element('h3', section.label), list);
        return box;
      })),
  );
  if (!dataDesign) $('share-data').replaceChildren(element('p', 'データの案は、まだ選んでいません。', 'muted'));
  else {
    const list = element('ul', undefined, 'share-list');
    list.append(...dataDesign.entities.map((entity) => element('li', `${entity.name}(${entity.writer}): ${entity.fields.join('、')}`)));
    $('share-data').replaceChildren(element('p', `選んだ案: ${dataDesign.title}${dataDesign.stale ? '(確かめ直しが要る)' : ''}`), list);
  }
  $('share-scenes').replaceChildren(...(scenes.length === 0 ? [element('li', '(まだありません)', 'muted')] : scenes.map((scene) => element('li', `${scene.category}: ${scene.text}`))));
  $('share-open').replaceChildren(...(openItems.length === 0 ? [element('li', '(ありません)', 'muted')] : openItems.map((item) => element('li', `${item.text}(${item.from}。持ち主: ${item.owner || 'なし'}${item.due ? `、期日 ${item.due}` : ''})`))));
}

function render() {
  if (state.gone || !state.docs) return;
  $('share-main').hidden = false;
  $('share-title').textContent = state.docs.title ? `その場の共有: ${state.docs.title}` : 'その場の共有';
  const me = state.docs.members?.find((m) => m.id === state.me);
  $('share-who').textContent = me ? `あなた: ${me.name}(${me.roleLabel})` : '';
  $('share-viewer').hidden = myRole() !== 'viewer';
  renderBoard();
  renderComments();
  renderDocs();
}

// ---- コメント、反応、承認(K7 の 3 枚目) ----

function commentStatus(text) {
  $('share-comment-status').textContent = text ?? '';
}

function approvalWords(comment) {
  const names = comment.approvals.map((a) => (a.name ? `${a.name}(${a.roleLabel})` : a.roleLabel));
  const need = comment.needsBoth ? '2(進行役と決める人)' : '1(進行役か決める人)';
  return `承認 ${comment.approvals.length} / ${need}${names.length > 0 ? `: ${names.join('、')}` : ''}`;
}

const STATUS_NOTES = {
  awaiting: '承認がそろいました。進行役が自分の PC で「作る AI に送る」を押すと、作る AI が直します。',
  queued: '進行役が送りました。順に作る AI が直します。',
  fixing: '作る AI が直しています。',
  review: '直した版ができました。進行役の画面で確かめます。',
};

function commentNode(comment) {
  const li = element('li', undefined, 'share-comment');
  li.dataset.status = comment.status;
  const head = element('p', undefined, 'share-comment-head');
  head.append(element('strong', `コメント ${comment.number}`), element('span', comment.kindLabel, 'share-badge'), element('span', comment.statusLabel, 'share-comment-state'));
  li.append(head, element('p', comment.text, 'share-comment-text'));
  li.append(element('p', [comment.author ? `書いた人: ${comment.author}` : '', `反応 ${comment.reactions}`, approvalWords(comment)].filter(Boolean).join('。'), 'muted'));
  if (STATUS_NOTES[comment.status]) li.append(element('p', STATUS_NOTES[comment.status], 'share-note'));
  const actions = element('div', undefined, 'share-actions');
  const live = ['open', 'awaiting', 'queued'].includes(comment.status);
  if (canWrite() && live) {
    const react = element('button', '同じ意見');
    react.type = 'button';
    react.setAttribute('aria-label', `コメント ${comment.number} に反応を付ける(今 ${comment.reactions})`);
    react.addEventListener('click', () => send({ op: 'comment-react', comment: comment.id }));
    actions.append(react);
  }
  const mine = comment.approvals.some((a) => a.member === state.me);
  if (canApprove() && comment.status === 'open' && comment.kind !== 'architecture' && !mine) {
    const approve = element('button', '決める人として承認');
    approve.type = 'button';
    approve.addEventListener('click', async () => {
      send({ op: 'comment-approve', comment: comment.id, textPrint: await textPrint(comment.text) });
      commentStatus(`コメント ${comment.number} に承認を送りました。進行役の Studio が役を確かめ、承認がそろうと、進行役が作る AI に送ります。`);
    });
    actions.append(approve);
  }
  if (canApprove() && mine && live) {
    const retract = element('button', '承認を取り消す');
    retract.type = 'button';
    retract.addEventListener('click', () => {
      send({ op: 'comment-unapprove', comment: comment.id });
      commentStatus(`コメント ${comment.number} の承認の取り消しを送りました。`);
    });
    actions.append(retract);
  }
  if (actions.childElementCount > 0) li.append(actions);
  return li;
}

function renderComments() {
  const comments = state.docs.comments ?? [];
  $('share-comment-form').hidden = !canWrite();
  const waiting = state.pending.filter((p) => p.op.op === 'comment-add').map(({ op }) => {
    const li = element('li', undefined, 'share-comment');
    li.append(element('p', op.text, 'share-comment-text'), element('p', '送りました。進行役の Studio が受け取ると、みんなの画面に出ます。', 'share-pending'));
    return li;
  });
  const list = [...comments].reverse().map(commentNode);
  $('share-comments').replaceChildren(...waiting, ...(list.length === 0 && waiting.length === 0 ? [element('li', '(まだコメントはありません)', 'muted')] : list));
}

// 中継のサーバーの受け取り(Server-Sent Events)を読む。fetch で読むのは、札を Authorization で送るため
async function listen() {
  let attempt = 0;
  while (!state.gone) {
    try {
      // 心拍が途切れたら止める口
      const connection = new AbortController();
      let watchdog = null;
      const arm = () => {
        clearTimeout(watchdog);
        watchdog = setTimeout(() => connection.abort(), SILENCE_MS);
      };
      arm();
      const response = await fetch(`/api/sessions/${sessionId}/stream`, { headers: { Authorization: `Bearer ${state.ticket}` }, cache: 'no-store', signal: connection.signal });
      if (response.status === 410) return gone();
      if (response.status === 404) return gone('この会は、中継のサーバーにありません。進行役に聞いてください。');
      if (response.status === 401 || response.status === 403) {
        setStatus('refused', 'この招待のリンクでは入れません。外されたかもしれません。進行役に聞いてください。');
        return;
      }
      if (!response.ok || !response.body) throw new Error(`stream ${response.status}`);
      attempt = 0;
      state.online = true;
      setStatus('online', 'つながっています。進行役の Studio と同じ文書を見ています。');
      flush();
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        arm();
        buffer += decoder.decode(value, { stream: true });
        let index;
        while ((index = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          const event = /^event: (.+)$/m.exec(block)?.[1];
          const data = /^data: (.+)$/m.exec(block)?.[1];
          if (event === 'deleted') return gone();
          if (event === 'hello' && JSON.parse(data ?? '{}').files?.docs) await loadDocs().catch(() => {});
          if (event === 'file' && JSON.parse(data ?? '{}').name === 'docs') await loadDocs().catch(() => {});
        }
      }
      clearTimeout(watchdog);
    } catch {
      // 切れた。下でつなぎ直す
    }
    if (state.gone) return;
    state.online = false;
    setStatus('offline', '中継のサーバーにつながっていません。書いたものはこの画面に残し、つながると送ります。');
    await new Promise((resolve) => setTimeout(resolve, RETRY_MS[Math.min(attempt, RETRY_MS.length - 1)]));
    attempt += 1;
  }
}

async function main() {
  const link = readLink();
  if (!link) {
    setStatus('refused', '招待のリンクの鍵がありません。進行役から受け取ったリンクを、そのまま開いてください。');
    return;
  }
  try {
    state.key = await importKey(link.k);
  } catch {
    setStatus('refused', '招待のリンクの鍵が読めません。進行役から受け取ったリンクを、そのまま開いてください。');
    return;
  }
  state.ticket = link.t;
  state.me = link.m;
  if (link.s) {
    try {
      state.signer = await importSigner(link.s);
    } catch {
      state.signer = null;
    }
  }
  state.pending = loadPending();
  $('share-add').addEventListener('submit', (event) => {
    event.preventDefault();
    const input = $('share-add-text');
    const text = input.value.trim();
    if (!text) return;
    send({ op: 'item-add', column: $('share-add-column').value, text });
    input.value = '';
  });
  $('share-comment-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const input = $('share-comment-text');
    const text = input.value.trim();
    if (!text) return;
    const kind = document.querySelector('input[name="share-comment-kind"]:checked')?.value ?? 'look';
    send({ op: 'comment-add', kind, text });
    input.value = '';
    commentStatus('コメントを送りました。承認がそろうまで、作る AI には送りません。');
  });
  await listen();
}

main();
