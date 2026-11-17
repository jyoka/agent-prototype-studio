import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { FIX_RECORDS_DIR } from './meeting.js';
import { isValidProjectId, projectPaths } from './projects.js';
import { findRecords } from './redact.js';
import { BusyError, NotFoundError } from './store.js';

// 画面へのコメント、反応、承認、列、直した記録、元に戻す(docs/design/user-journey.md の K3。docs/design/collaboration.md の 3〜5 節)。
// 1 台の PC の形(collaboration.md の 6 節の案 A)。役は進行役と決める人だけ。名前は申告で、Studio は本人を確かめない。
// 作る AI を動かすのは、承認がそろったコメントだけ。反応、コメントの書き込み、承認の取り消しでは動かない。
// 承認したコメントは列に並び、前の実行が終わってから 1 つずつ作る AI に渡す(1 プロジェクト 1 実行のまま)。
// 種類が「構成」のコメントは、承認しても作る AI に送らず、AI 構成の審査に戻す(ai-architecture-review.md の 6 節)。
// コメントは .studio/comments.json、直した記録は .studio/fix-records/<記録の ID>/record.json に置く。
// .studio/ は Studio だけが書く場所で、作る AI は読み書きできない(ADR 0001)。元に戻しても記録は消さず、「戻した」を足す

export const COMMENTS_FILE = 'comments.json';
export const FIX_RECORD_FILE = 'record.json';
export const FIX_RECORD_FORMAT = 'prototype-studio-fix-record';
const FORMAT = 1;

export const COMMENT_LIMITS = Object.freeze({
  maxText: 1000,
  maxName: 40,
  maxComments: 300,
  maxReactions: 999,
  // 同じ所に向いたコメントとみなす距離(見えている枠の幅と高さの %)
  nearPercent: 12,
});

// コメントの種類。look は 1 人の承認、requirement は進行役と決める人の 2 人の承認。architecture は 1 人の承認で審査に戻す
export const COMMENT_KINDS = Object.freeze({
  look: '見た目と動き',
  requirement: '要件',
  architecture: '構成',
});

// 役。1 台の形では、決める人が声に出し、進行役が押す。押した人と声に出した人の両方を残す
export const COMMENT_ROLES = Object.freeze({ facilitator: '進行役', decider: '決める人' });

// 状態(collaboration.md の 4 節の図)。approved は列に入る前の一瞬なので、残すのは queued から
export const COMMENT_STATUS_WORDS = Object.freeze({
  open: '開いている',
  queued: '待っている',
  fixing: '直している',
  review: '確かめる',
  resolved: '直った',
  reverted: '戻した',
  closed: '閉じた',
  failed: '落ちた',
  returned: '審査に戻した',
});

// 直した記録の項目(collaboration.md の 5 節の表)。単体テストが、これがそろうかを確かめる
export const FIX_RECORD_FIELDS = Object.freeze(['comment', 'approval', 'request', 'versions', 'changes', 'gates', 'confirmation']);

export class CommentError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const ID = /^[a-f0-9]{16}$/;
const newId = () => crypto.randomBytes(8).toString('hex');
const now = () => new Date().toISOString();

function clip(value, max) {
  return typeof value === 'string' ? value.replace(/[\u0000-\u0008\u000b-\u001f\u007f]+/g, ' ').trim().slice(0, max) : '';
}

// 画面の場所。見えている枠の中の位置(左からと上からの %)。試作品の中は読まない(別の場所で動くため。ADR 0001 の層 2)
export function cleanPlace(place) {
  if (place === null || place === undefined) return null;
  const x = Number(place?.x);
  const y = Number(place?.y);
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 100 || y < 0 || y > 100) {
    throw new CommentError(400, 'invalid', '画面の場所の形が正しくありません。もう一度、場所を選んでください');
  }
  return { x: Math.round(x), y: Math.round(y) };
}

export function placeWords(place) {
  if (!place) return '画面の全体';
  return `見えている画面の、左から ${place.x}%、上から ${place.y}% のあたり`;
}

// 承認がそろったか。要件は 2 つの役の両方、ほかはどちらか 1 人
export function approvalSatisfied(kind, approvals) {
  const roles = new Set((approvals ?? []).map((a) => a.role));
  if (kind === 'requirement') return roles.has('facilitator') && roles.has('decider');
  return roles.size > 0;
}

// 作る AI に渡す依頼の文。コメントの文はそのままにせず、決まった形(どうなってほしいか、画面の場所、元の要点、要件の項目)に包む。
// context は { purpose: 目的の文書, board: 整理の板の項目 }。上限は作る欄の依頼と同じ(build-requests.js の MAX_REQUEST_CHARS)。
// 偽接続は依頼の言葉で動きを決めるので、包む文には、コメントの文より前に「」を置かず、動きの合図になる語を使わない
export function requestFor(comment, { purpose = null, board = [] } = {}, maxChars = 4000) {
  const lines = [
    '画面へのコメントから頼みます。コメントの文のとおりに、試作品を変えてください。',
    `どうなってほしいか: ${comment.text}`,
    `画面の場所: ${placeWords(comment.place)}`,
    `種類: ${COMMENT_KINDS[comment.kind]}(コメント ${comment.number})`,
  ];
  if (comment.kind === 'requirement') {
    lines.push('要件を変えるコメントです。進行役と決める人の 2 人が承認しました。');
  }
  const doc = purpose && typeof purpose === 'object' ? purpose : null;
  const points = doc ? [['使う人', doc.who], ['困りごと', doc.problem], ['場面', doc.scene], ['成功の印', doc.success]].filter(([, v]) => typeof v === 'string' && v.trim()) : [];
  if (points.length > 0) {
    lines.push('目的の文書の要点:');
    for (const [label, value] of points) lines.push(`- ${label}: ${clip(value, 300)}`);
  }
  if (comment.kind === 'requirement') {
    const items = (Array.isArray(board) ? board : []).filter((item) => typeof item?.text === 'string' && item.text.trim()).slice(0, 20);
    if (items.length > 0) {
      lines.push('要件の文書の関係する項目(整理の板から):');
      for (const item of items) lines.push(`- ${clip(item.text, 200)}`);
    }
  }
  return lines.join('\n').slice(0, maxChars);
}

// 同じ所に向いた、開いたコメント(承認の前に並べて見せる。collaboration.md の 5 節)
export function nearNumbers(comment, comments) {
  if (!comment.place) return [];
  return comments
    .filter((other) => other.id !== comment.id && other.place && ['open', 'queued'].includes(other.status))
    .filter((other) => Math.hypot(other.place.x - comment.place.x, other.place.y - comment.place.y) <= COMMENT_LIMITS.nearPercent)
    .map((other) => other.number);
}

const versionRef = (version) => (version ? { id: version.id, number: version.number, name: version.name } : null);

// 直した記録を作る(作る AI に渡す直前)。項目は collaboration.md の 5 節の表のとおり
export function newFixRecord({ comment, request, before, id = newId(), at = now() }) {
  return {
    format: FIX_RECORD_FORMAT,
    formatVersion: 1,
    id,
    createdAt: at,
    updatedAt: at,
    status: 'fixing',
    comment: {
      id: comment.id,
      number: comment.number,
      text: comment.text,
      place: comment.place,
      placeWords: placeWords(comment.place),
      kind: comment.kind,
      kindLabel: COMMENT_KINDS[comment.kind],
      author: comment.author || null,
      reactions: comment.reactions,
    },
    approval: {
      // 2 人のときは 2 人とも。1 台の形では、押した人と声に出した人
      approvers: comment.approvals.map((a) => ({ role: a.role, roleLabel: COMMENT_ROLES[a.role], pressedBy: a.pressedBy, spokenBy: a.spokenBy, at: a.at })),
      completedAt: comment.queuedAt ?? at,
    },
    request: { text: request },
    versions: { before: versionRef(before), after: null },
    changes: {
      files: [],
      summary: null,
      // 要件の文書の項目を変えたか。K3 では作る AI は app/ だけを書き、要件の文書は変えない(要件の文書は K5)
      requirementItems: [],
    },
    gates: { status: null, results: [], run: null, runId: null },
    confirmation: { resolvedBy: null, resolvedAt: null, revertedBy: null, revertedAt: null },
    compare: { before: null, after: null },
    // 起きたことの並び。元に戻すと「戻した」が足される。消さない
    events: [{ type: 'requested', label: '作る AI に送った', at }],
  };
}

// 作る run の結果を記録に入れる。gates は Studio の関門の結果、run は .studio/runs/ の記録への参照
export function applyRunToRecord(record, run, { after = null, at = now() } = {}) {
  const fixed = ['passed', 'fixed', 'unverified'].includes(run.status);
  const files = (run.changedFiles ?? []).map((f) => (typeof f === 'string' ? f : f?.file)).filter((f) => typeof f === 'string');
  return {
    ...record,
    updatedAt: at,
    status: fixed ? 'review' : 'failed',
    versions: { ...record.versions, after: versionRef(after) },
    changes: {
      ...record.changes,
      files,
      summary: files.length === 0 ? '変わったファイルはありません' : `${files.length} 個のファイルが変わりました(${files.slice(0, 5).join('、')}${files.length > 5 ? ' ほか' : ''})`,
    },
    gates: {
      status: run.status,
      runId: run.id,
      run: run.evidence?.run ?? `.studio/runs/${run.id}/run.json`,
      results: (run.gates ?? []).filter((g) => g.status !== 'skipped').map((g) => ({ id: g.id, name: g.name, label: g.label, status: g.status, summary: g.summary ?? g.reason ?? null })),
    },
    events: [...record.events, fixed ? { type: 'fixed', label: '直した版ができた', at } : { type: 'failed', label: '直せなかった', at, note: run.status }],
  };
}

async function writeAtomic(file, text) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  await fs.writeFile(tmp, text);
  await fs.rename(tmp, file);
}

const json = (value) => `${JSON.stringify(value, null, 2)}\n`;

function isComment(c) {
  return c && typeof c === 'object' && typeof c.id === 'string' && Number.isSafeInteger(c.number) && typeof c.text === 'string' && Object.hasOwn(COMMENT_KINDS, c.kind) && Object.hasOwn(COMMENT_STATUS_WORDS, c.status) && Array.isArray(c.approvals);
}

// 列で止めた理由。見せる画面に出るので、開発の言葉を含みうる文(ほかの作業中、作る AI を使えない)は平たい文に置き換え、元の文は detail に残す
const PLAIN_CODES = new Set(['consent-required', 'meeting-consent-required', 'meeting-trial', 'review-not-approved', 'review-changed', 'review-missing', 'review-stopped']);
export function heldReason(error) {
  const code = error?.code ?? (error instanceof BusyError ? 'busy' : 'error');
  if (PLAIN_CODES.has(code)) return { code, message: error.message, ...(error.next ? { next: error.next } : {}) };
  if (code === 'busy') return { code, message: 'ほかの作業(作る AI、保存、戻す、確かめ)の最中なので、送れませんでした。終わってから「列を進める」を押してください', detail: error?.message ?? null };
  if (code === 'build') return { code, message: '今の状態は表示できないので、直す前の状態を保存できませんでした。「作る AI」の欄で直してから「列を進める」を押してください', detail: error?.message ?? null };
  return { code, message: '作る AI に送れませんでした。見せ終わってから「作る AI」の欄で理由を確かめ、「列を進める」を押してください', detail: error?.message ?? null };
}

// 直した記録の全部(.studio/fix-records/<記録の ID>/record.json)を、作った順に読む。会の終わりの成果物と引き継ぎも使う(K5)
export async function readFixRecords(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  const found = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !ID.test(entry.name)) continue;
    try {
      const record = JSON.parse(await fs.readFile(path.join(dir, entry.name, FIX_RECORD_FILE), 'utf8'));
      if (record?.format === FIX_RECORD_FORMAT && record.id === entry.name) found.push(record);
    } catch {
      // 読めない記録は出さない(消さない)
    }
  }
  return found.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
}

export class ProjectComments {
  // requests は作る run(build-requests.js)、versions は版(versions.js)、reviews は AI 構成の審査(review.js)。
  // contextOf(id) は依頼に包む { purpose, board }。talkGate(id) は会の同意の前と消している間に断る(index.js)。
  // shoot(id, outDir) は今の画面のスクリーンショットを撮り、PNG の場所を返す(直す前と後の比べ。撮れなければ null)
  constructor({ home, store, requests, versions, reviews = null, contextOf = () => ({}), talkGate = () => {}, shoot = null, onFixed = () => {}, log = () => {} }) {
    this.home = home;
    this.store = store;
    this.requests = requests;
    this.versions = versions;
    this.reviews = reviews;
    // 直した版ができたとき(会の段ごとの時刻。timeline.js)
    this.onFixed = onFixed;
    this.contextOf = contextOf;
    this.talkGate = talkGate;
    this.shoot = shoot;
    this.log = log;
    // 試作品ごとのコメントの記録(読んだもの)。書くたびに全部を書き直す
    this.data = new Map();
    // 列を進めている試作品。同じ試作品の列は 1 つずつ
    this.pumping = new Set();
    // 動いている直しの run の ID と、コメントの ID
    this.fixing = new Map();
    // 作る AI に渡している最中のコメント(requests.start を呼んでから返るまで)。この間は承認を取り消せない
    this.starting = new Map();
    // 審査に戻している最中の構成のコメント。この間は承認を取り消せない
    this.returning = new Set();
    // 試作品ごとの書き込みの並び。後から計った中身が、先に計った中身に上書きされないように、1 つずつ書く
    this.writes = new Map();
  }

  paths(id) {
    if (!isValidProjectId(id)) throw new NotFoundError(`プロジェクトがありません: ${id}`);
    const { studio, root } = projectPaths(this.home, id);
    return { root, studio, file: path.join(studio, COMMENTS_FILE), records: path.join(studio, FIX_RECORDS_DIR) };
  }

  async requireProject(id) {
    if (!isValidProjectId(id)) throw new NotFoundError(`プロジェクトがありません: ${id}`);
    return this.store.requireProject(id);
  }

  // 読む。読めないファイルは上書きしない(broken を返し、書く操作を断る)
  async load(id) {
    if (this.data.has(id)) return this.data.get(id);
    const { file } = this.paths(id);
    let data;
    try {
      const raw = JSON.parse(await fs.readFile(file, 'utf8'));
      if (raw?.format !== FORMAT || !Array.isArray(raw.comments) || !raw.comments.every(isComment)) throw new Error('形が違います');
      data = { lastNumber: Number.isSafeInteger(raw.lastNumber) ? raw.lastNumber : 0, comments: raw.comments, broken: false };
      // 前の起動で直している途中だったものは、途中で終わった(直した記録にも残す)。列に残ったものは、人が「列を進める」を押すまで止める
      for (const c of data.comments) {
        if (c.status === 'fixing') {
          c.status = 'failed';
          c.held = { code: 'restarted', message: 'Studio を止めたので、直すのが途中で終わりました。「元に戻す」か「開き直す」を選んでください' };
          const record = c.recordId ? await this.readRecord(id, c.recordId) : null;
          if (record?.status === 'fixing') {
            const at = now();
            record.status = 'failed';
            record.updatedAt = at;
            record.events.push({ type: 'failed', label: '直せなかった', at, note: 'Studio を止めたので、途中で終わった' });
            await this.writeRecord(id, record).catch(() => {});
          }
        } else if (c.status === 'queued') {
          c.held = { code: 'restarted', message: 'Studio を起動し直したので、列を止めています。「列を進める」で続けます' };
        }
      }
    } catch (error) {
      if (error.code === 'ENOENT') data = { lastNumber: 0, comments: [], broken: false };
      else {
        this.log(`コメントを読めませんでした: ${id}(${error.message})。ファイルは上書きしません`);
        data = { lastNumber: 0, comments: [], broken: true };
      }
    }
    this.data.set(id, data);
    return data;
  }

  // 書く。中身は並びの順が来てから計る(いつも最後の中身を書く)
  async save(id) {
    const previous = this.writes.get(id) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(async () => {
      const data = this.data.get(id);
      if (!data || data.broken) return;
      await this.store.requireProject(id);
      await writeAtomic(this.paths(id).file, json({ format: FORMAT, lastNumber: data.lastNumber, comments: data.comments }));
    });
    this.writes.set(id, next);
    try {
      await next;
    } finally {
      if (this.writes.get(id) === next) this.writes.delete(id);
    }
  }

  // 書く操作の前。会の同意の前と、会のデータを消している間は断る(talkGate)
  async writable(id) {
    await this.requireProject(id);
    this.talkGate(id);
    const data = await this.load(id);
    if (data.broken) throw new CommentError(500, 'broken', `前のコメントのファイルを読めないので、書けません。${this.paths(id).file} を確かめてください`);
    return data;
  }

  async find(id, commentId) {
    const data = await this.writable(id);
    const comment = typeof commentId === 'string' && ID.test(commentId) ? data.comments.find((c) => c.id === commentId) : null;
    if (!comment) throw new CommentError(404, 'not-found', 'そのコメントはありません');
    return { data, comment };
  }

  forget(id) {
    this.data.delete(id);
    this.fixing.delete(id);
  }

  // 画面に出す形。直した記録は、記録のあるコメントに付ける
  async view(id) {
    await this.requireProject(id);
    const data = await this.load(id);
    const records = await this.readRecords(id);
    const queue = data.comments.filter((c) => c.status === 'queued').sort((a, b) => String(a.queuedAt).localeCompare(String(b.queuedAt)));
    return {
      broken: data.broken,
      kinds: COMMENT_KINDS,
      roles: COMMENT_ROLES,
      fixing: this.fixing.has(id),
      comments: data.comments.map((c) => ({
        ...c,
        statusLabel: COMMENT_STATUS_WORDS[c.status],
        kindLabel: COMMENT_KINDS[c.kind],
        placeWords: placeWords(c.place),
        // 要件は進行役と決める人の 2 人。ほかはどちらか 1 人
        needsBoth: c.kind === 'requirement',
        queuePosition: c.status === 'queued' ? queue.findIndex((q) => q.id === c.id) + 1 : null,
        near: c.status === 'open' ? nearNumbers(c, data.comments) : [],
        records: records.filter((r) => r.comment?.id === c.id),
      })),
    };
  }

  async readRecords(id) {
    return readFixRecords(this.paths(id).records);
  }

  async readRecord(id, recordId) {
    try {
      const record = JSON.parse(await fs.readFile(path.join(this.paths(id).records, recordId, FIX_RECORD_FILE), 'utf8'));
      return record?.format === FIX_RECORD_FORMAT && record.id === recordId ? record : null;
    } catch {
      return null;
    }
  }

  async writeRecord(id, record) {
    await this.store.requireProject(id);
    await writeAtomic(path.join(this.paths(id).records, record.id, FIX_RECORD_FILE), json(record));
  }

  // コメントを書く。{ text, kind, place, author }。作る AI は動かない
  async create(id, { text, kind = 'look', place = null, author = '' } = {}) {
    await this.requireProject(id);
    this.talkGate(id);
    const body = clip(text, COMMENT_LIMITS.maxText);
    if (!body) throw new CommentError(400, 'empty', 'コメントを書いてください');
    if (!Object.hasOwn(COMMENT_KINDS, kind)) throw new CommentError(400, 'invalid', '知らない種類です');
    const records = findRecords(body);
    if (records.length > 0) {
      throw new CommentError(422, 'record', `記録らしいものがあるので、残していません(${records.join('、')})。その部分を抜いて、書き直してください`);
    }
    const data = await this.writable(id);
    if (data.comments.length >= COMMENT_LIMITS.maxComments) throw new CommentError(409, 'too-many', `コメントは 1 つの試作品に ${COMMENT_LIMITS.maxComments} 個までです`);
    data.lastNumber += 1;
    const comment = {
      id: newId(),
      number: data.lastNumber,
      text: body,
      kind,
      place: cleanPlace(place),
      author: clip(author, COMMENT_LIMITS.maxName),
      createdAt: now(),
      status: 'open',
      reactions: 0,
      approvals: [],
      queuedAt: null,
      held: null,
      recordId: null,
    };
    data.comments.push(comment);
    await this.save(id);
    this.log(`コメントを書きました: ${id}(${comment.number}。${COMMENT_KINDS[kind]})`);
    return { comment };
  }

  // 反応を付ける。数を足すだけで、作る AI は動かない(反応の数では動かない決まり)
  async react(id, commentId) {
    const { comment } = await this.find(id, commentId);
    if (['closed'].includes(comment.status)) throw new CommentError(409, 'closed', '閉じたコメントには反応を付けられません');
    comment.reactions = Math.min(COMMENT_LIMITS.maxReactions, comment.reactions + 1);
    await this.save(id);
    return { comment };
  }

  // 承認する。{ role, pressedBy, spokenBy }。そろったら、構成は審査に戻し、ほかは列に並べて列を進める
  async approve(id, commentId, { role, pressedBy, spokenBy } = {}) {
    const { comment } = await this.find(id, commentId);
    this.talkGate(id);
    if (!Object.hasOwn(COMMENT_ROLES, role)) throw new CommentError(400, 'invalid', '承認するのは進行役か決める人です');
    if (comment.status !== 'open') throw new CommentError(409, 'not-open', `「${COMMENT_STATUS_WORDS[comment.status]}」のコメントは承認できません`);
    const approvals = [
      ...comment.approvals.filter((a) => a.role !== role),
      { role, pressedBy: clip(pressedBy, COMMENT_LIMITS.maxName) || null, spokenBy: clip(spokenBy, COMMENT_LIMITS.maxName) || null, at: now() },
    ];
    let returned = null;
    if (approvalSatisfied(comment.kind, approvals) && comment.kind === 'architecture') {
      // 作る AI には送らない。AI 構成の審査に戻し、4 つの承認をやり直すまで作る AI を起動しない。
      // 審査に戻せたときだけ、承認を残す(戻せなければ、承認しなかったことにする)
      if (!this.reviews) throw new CommentError(503, 'no-review', 'AI 構成の審査を使えません');
      if (this.returning.has(comment.id)) throw new BusyError('このコメントを審査に戻しているところです');
      this.returning.add(comment.id);
      try {
        const at = now();
        returned = await this.reviews.reopenFromComment(id, { id: comment.id, number: comment.number, text: comment.text, at });
        comment.approvals = approvals;
        comment.status = 'returned';
        comment.returnedAt = at;
        await this.save(id);
        this.log(`構成のコメントを AI 構成の審査に戻しました: ${id}(${comment.number})`);
      } finally {
        this.returning.delete(comment.id);
      }
      return { comment, review: returned };
    }
    comment.approvals = approvals;
    if (approvalSatisfied(comment.kind, approvals)) {
      comment.status = 'queued';
      comment.queuedAt = now();
      comment.held = null;
      await this.save(id);
      this.log(`承認したコメントを列に並べました: ${id}(${comment.number})`);
      this.kick(id);
    } else {
      await this.save(id);
    }
    return { comment, review: null };
  }

  // 承認を取り消す。作る AI が動き出す前(開いている、待っている)だけ。動き出した後は元に戻すで扱う
  async unapprove(id, commentId) {
    const { comment } = await this.find(id, commentId);
    if (!['open', 'queued'].includes(comment.status) || this.isStarting(id, comment.id) || this.returning.has(comment.id)) {
      throw new CommentError(409, 'started', '作る AI が動き出した後は、承認を取り消せません。直した後に「元に戻す」を使ってください');
    }
    if (comment.approvals.length === 0) throw new CommentError(409, 'no-approval', 'まだ承認していません');
    comment.approvals = [];
    comment.status = 'open';
    comment.queuedAt = null;
    comment.held = null;
    await this.save(id);
    this.log(`承認を取り消しました: ${id}(${comment.number})`);
    return { comment };
  }

  // 閉じる。開いているコメントだけ(書いた人か進行役が閉じる)
  async close(id, commentId) {
    const { comment } = await this.find(id, commentId);
    if (comment.status !== 'open') throw new CommentError(409, 'not-open', `「${COMMENT_STATUS_WORDS[comment.status]}」のコメントは閉じられません`);
    comment.status = 'closed';
    comment.approvals = [];
    await this.save(id);
    return { comment };
  }

  // 開き直す。戻した、落ちた、閉じたコメントを、承認の前に戻す
  async reopen(id, commentId) {
    const { comment } = await this.find(id, commentId);
    if (!['reverted', 'failed', 'closed'].includes(comment.status)) throw new CommentError(409, 'not-reopenable', `「${COMMENT_STATUS_WORDS[comment.status]}」のコメントは開き直せません`);
    comment.status = 'open';
    comment.approvals = [];
    comment.queuedAt = null;
    comment.held = null;
    await this.save(id);
    return { comment };
  }

  // 「直った」。確かめる状態のコメントだけ。押した人と時刻を記録に残す
  async resolve(id, commentId, { pressedBy, spokenBy } = {}) {
    const { comment } = await this.find(id, commentId);
    if (comment.status !== 'review') throw new CommentError(409, 'not-review', '直した版ができてから「直った」を押してください');
    const record = comment.recordId ? await this.readRecord(id, comment.recordId) : null;
    const at = now();
    const by = { pressedBy: clip(pressedBy, COMMENT_LIMITS.maxName) || null, spokenBy: clip(spokenBy, COMMENT_LIMITS.maxName) || null };
    if (record) {
      record.status = 'resolved';
      record.updatedAt = at;
      record.confirmation = { ...record.confirmation, resolvedBy: by, resolvedAt: at };
      record.events.push({ type: 'resolved', label: '直った', at, by });
      await this.writeRecord(id, record);
    }
    comment.status = 'resolved';
    await this.save(id);
    return { comment };
  }

  // 元に戻す。直す前の版に戻し、記録に「戻した」を足す(記録は消さない)。
  // 後のコメントで直した版がすでにあるときは、どこまで戻るかを返して断る。confirm: true で、それらも一緒に戻す
  async revert(id, commentId, { confirm = false, pressedBy, spokenBy } = {}) {
    const { data, comment } = await this.find(id, commentId);
    if (!['review', 'resolved', 'failed'].includes(comment.status) || !comment.recordId) {
      throw new CommentError(409, 'not-revertable', 'このコメントには、戻す版がありません');
    }
    if (this.fixing.has(id) || this.pumping.has(id)) throw new BusyError('作る AI が動いているところです。終わってから戻してください');
    const record = await this.readRecord(id, comment.recordId);
    if (!record?.versions?.before?.id) throw new CommentError(409, 'no-before', '直す前の版の記録がないので、戻せません');
    const records = await this.readRecords(id);
    const later = data.comments.filter(
      (c) => c.id !== comment.id && c.recordId && ['review', 'resolved', 'failed'].includes(c.status) && records.find((r) => r.id === c.recordId)?.createdAt > record.createdAt,
    );
    if (later.length > 0 && confirm !== true) {
      throw new CommentError(409, 'later-fixes', `後に直したコメント ${later.map((c) => c.number).join('、')} も一緒に戻ります。よければ、もう一度「元に戻す」を押してください`);
    }
    const restored = await this.versions.restore(id, record.versions.before.id);
    const at = now();
    const by = { pressedBy: clip(pressedBy, COMMENT_LIMITS.maxName) || null, spokenBy: clip(spokenBy, COMMENT_LIMITS.maxName) || null };
    const mark = async (target, note) => {
      const r = target.recordId ? await this.readRecord(id, target.recordId) : null;
      if (r) {
        r.status = 'reverted';
        r.updatedAt = at;
        r.confirmation = { ...r.confirmation, revertedBy: by, revertedAt: at };
        r.events.push({ type: 'reverted', label: '戻した', at, by, version: versionRef(restored.restored), ...(note ? { note } : {}) });
        await this.writeRecord(id, r);
      }
      target.status = 'reverted';
    };
    await mark(comment, null);
    for (const c of later) await mark(c, `コメント ${comment.number} を戻したので、一緒に戻りました`);
    await this.save(id);
    this.log(`コメントの直しを戻しました: ${id}(${comment.number}。v${restored.restored.number} に戻した)`);
    return { comment, restored: restored.restored, build: restored.build };
  }

  // 「列を進める」。止めた理由(同意の前、起動し直した、ほかの作業中)を外して、列を進める
  async resume(id) {
    const data = await this.writable(id);
    for (const c of data.comments) if (c.status === 'queued') c.held = null;
    await this.save(id);
    await this.pump(id);
    return this.view(id);
  }

  isStarting(id, commentId) {
    return this.starting.get(id) === commentId;
  }

  // 列を進める(待たずに)。誤りはターミナルに出す
  kick(id) {
    this.pump(id).catch((error) => this.log(`コメントの列を進められませんでした: ${id}(${error.message})`));
  }

  // 作る run が終わった後(build-requests.js の onEnd)。どの run の後でも、列の次を進める
  afterRun(id) {
    if (this.data.has(id)) this.kick(id);
  }

  // 列の先頭を 1 つ、作る AI に渡す。前の実行が動いていれば何もしない(終わったら afterRun で呼ばれる)。
  // 列は承認した順。先頭が止まっていれば、後ろも送らない(「列を進める」を待つ)
  async pump(id) {
    if (this.pumping.has(id) || this.fixing.has(id)) return;
    const data = this.data.get(id);
    if (!data || data.broken) return;
    const next = data.comments.filter((c) => c.status === 'queued').sort((a, b) => String(a.queuedAt).localeCompare(String(b.queuedAt)))[0];
    if (!next || next.held) return;
    if (this.requests.summary(id).running) return;
    this.pumping.add(id);
    const recordId = newId();
    const recordDir = path.join(this.paths(id).records, recordId);
    const stillQueued = () => next.status === 'queued' && !next.held;
    let started = null;
    try {
      // 直す前の画面(比べに使う)と、直す前の版(元に戻す先)。版は送る直前に決める(撮る間に状態が変わっても、戻す先がずれないように)
      const shot = await this.screenshot(id, recordId, 'before');
      // 待つ間に承認が取り消されていたら、渡さない
      if (!stillQueued()) return void (await fs.rm(recordDir, { recursive: true, force: true }).catch(() => {}));
      const before = await this.beforeVersion(id, next);
      if (!stillQueued()) return void (await fs.rm(recordDir, { recursive: true, force: true }).catch(() => {}));
      const request = requestFor(next, this.contextOf(id) ?? {});
      const record = newFixRecord({ comment: next, request, before, id: recordId });
      if (shot) record.compare.before = shot;
      // ここから先は取り消せない(作る AI を起動する)
      this.starting.set(id, next.id);
      started = await this.requests.start(id, request);
      // 終わりの知らせを逃さないよう、待つ前に受け取り口を付ける
      this.fixing.set(id, { runId: started.run.id, commentId: next.id });
      next.status = 'fixing';
      next.recordId = record.id;
      next.held = null;
      record.gates.runId = started.run.id;
      const written = (async () => {
        await this.writeRecord(id, record);
        await this.save(id);
      })().catch((error) => this.log(`直した記録を書けませんでした: ${id}(${error.message})`));
      started.subscribe(() => {}, (run) => {
        written.then(() => this.finish(id, next.id, record.id, run)).catch((error) => this.log(`直した記録を書けませんでした: ${id}(${error.message})`));
      });
      await written;
      this.log(`承認したコメントを作る AI に送りました: ${id}(${next.number})`);
    } catch (error) {
      if (started) throw error;
      // 同意の前、会の同意の前、審査の承認の前、ほかの作業中、表示できない状態など。列で止め、理由を出す
      next.held = heldReason(error);
      await fs.rm(recordDir, { recursive: true, force: true }).catch(() => {});
      await this.save(id).catch(() => {});
      this.log(`承認したコメントを列で止めました: ${id}(${next.number}。${error.message})`);
    } finally {
      this.pumping.delete(id);
      this.starting.delete(id);
    }
  }

  async beforeVersion(id, comment) {
    const list = await this.versions.list(id);
    const same = list.working.files === 'saved' && list.working.conversation !== 'changed' ? list.versions.find((v) => v.id === list.working.versionId) : null;
    if (same && same.kind !== 'auto' && same.builds) return same;
    const saved = await this.versions.save(id, { name: `コメント ${comment.number} の前` });
    return saved.version;
  }

  // 今の画面を撮って、記録の置き場に写す。撮れなければ null(比べに出さない)
  async screenshot(id, recordId, name) {
    if (typeof this.shoot !== 'function') return null;
    const { root, records } = this.paths(id);
    const dir = path.join(records, recordId);
    const work = path.join(dir, `${name}-observe`);
    try {
      const file = await this.shoot(id, work);
      if (!file) return null;
      const target = path.join(dir, `${name}.png`);
      await fs.mkdir(dir, { recursive: true });
      await fs.copyFile(path.resolve(file), target);
      return path.relative(root, target).split(path.sep).join('/');
    } catch (error) {
      this.log(`比べる画面を撮れませんでした: ${id}(${error.message})`);
      return null;
    } finally {
      await fs.rm(work, { recursive: true, force: true }).catch(() => {});
    }
  }

  // 作る run が終わった。直した版を保存し、記録に結果を入れ、コメントを「確かめる」か「落ちた」にする
  async finish(id, commentId, recordId, run) {
    try {
      const data = this.data.get(id);
      const comment = data?.comments.find((c) => c.id === commentId);
      let record = await this.readRecord(id, recordId);
      if (!comment || !record) return;
      const fixed = ['passed', 'fixed', 'unverified'].includes(run.status);
      let after = null;
      if (fixed) {
        after = await this.versions.save(id, { name: `コメント ${comment.number} で変えた状態` }).then((r) => r.version).catch((error) => {
          this.log(`直した版を保存できませんでした: ${id}(${error.message})`);
          return null;
        });
      }
      record = applyRunToRecord(record, run, { after });
      // 直した後の画面は、作る run が起動の確認で撮ったもの(広い画面)。なければ撮らない
      const shots = run.gates?.find((g) => g.name === 'launch')?.screenshots ?? [];
      const shot = shots.find((s) => s.name === 'desktop') ?? shots.at(-1);
      if (fixed && shot?.file) {
        const { root, records } = this.paths(id);
        const target = path.join(records, recordId, 'after.png');
        try {
          await fs.copyFile(path.join(root, ...shot.file.split('/')), target);
          record.compare.after = path.relative(root, target).split(path.sep).join('/');
        } catch {
          // 撮った画面が消えていれば、比べに出さない
        }
      }
      await this.writeRecord(id, record);
      if (fixed) {
        try {
          this.onFixed(id, record);
        } catch (error) {
          this.log(`直した後の処理で問題が起きました: ${id}(${error.message})`);
        }
      }
      comment.status = fixed ? 'review' : 'failed';
      if (!fixed) comment.held = { code: 'failed', message: '作る AI が直せませんでした。「元に戻す」で前の版に戻すか、「開き直す」で書き直してください' };
      await this.save(id);
      this.log(`承認したコメントの直しが終わりました: ${id}(${comment.number}。${run.status})`);
    } finally {
      this.fixing.delete(id);
      this.kick(id);
    }
  }
}
