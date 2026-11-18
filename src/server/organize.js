import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { IntentError } from './intent.js';
import { AI_ASK_KINDS, COLUMNS } from './organize-ai.js';
import { isValidProjectId, listProjects, projectPaths } from './projects.js';
import { findRecords } from './redact.js';
import { BusyError, NotFoundError } from './store.js';

// ヒアリングの整理(docs/design/user-journey.md の K1、docs/design/field-session.md の段 1、段 2)。
// 置き場所は .studio/organize.json。.studio/ は Studio だけが書く場所で、作る AI は読み書きできない。
// 「推測」の印は Studio が決める。元の要点(今ある要点を指す番号)のない項目に付き、AI の返事では消せない。
// 「確かめた」の印は、決める人が「この理解で合っている」を押したとき(confirm)だけ付く。板が変わると外れる。
// 記録らしいもの(名前や電話番号の形。redact.js の findRecords)は、板に入れない(docs/design/collaboration.md の 7 節、K4)。
// 人が打った文は保存せずに断る。AI の返事からは捨てて知らせる。前の板に残っていたら、起動のときに取り除く。

export const ORGANIZE_FILE = 'organize.json';
const FORMAT = 1;
const MAX_POINTS = 200;
const MAX_POINT = 500;
const MAX_TEXT = 300;
const MAX_ITEMS = 200;
const MAX_ASKS = 50;

const clip = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : '');
const uniqueKnown = (value, known) => (Array.isArray(value) ? [...new Set(value.filter((n) => known.has(n)))] : []);
const itemKey = (item) => `${item.column}\n${item.text}`;
const hasRecord = (text) => findRecords(text).length > 0;
const citesAny = (sources, numbers) => Array.isArray(sources) && sources.some((n) => numbers.includes(n));

// 記録らしいものを省いたときの知らせ。値そのものは入れない。打った人を責めない言葉にする(ui-ux-v2.md の 4.5。「電話番号らしいものは省きます」の形)
const omittedNote = (count) => `個人の記録らしいものは省きます(${count} 件)。整理の板にも AI にも入れていません。`;

function refuseRecord(text) {
  const kinds = findRecords(text);
  if (kinds.length > 0) throw new IntentError(422, 'record', `${kinds.join('や')}らしいものは省きます。AI にも整理の板にも入れていません。その部分を抜くと、要点に足せます。`);
}

export function emptyBoard() {
  return {
    formatVersion: FORMAT,
    status: 'draft',
    rev: 0,
    nextPoint: 1,
    nextItem: 1,
    nextAsk: 1,
    points: [],
    items: [],
    asks: [],
    // 人が消したもの。次の整理で AI が同じ文を返しても、板に戻さない
    dismissed: { items: [], asks: [] },
    note: null,
    organizedAt: null,
    confirmedAt: null,
  };
}

const pointNumbers = (board) => new Set(board.points.map((point) => point.n));

// 話に出ていない項目か。今ある要点を指していない項目で、人が確かめていないもの
export const isGuess = (item) => item.sources.length === 0 && !item.checkedAt;

// AI の返事を板に入れる。形に合わないものは捨てる。今ない要点を指す番号は捨てるので、指す先がなくなった項目は「推測」になる。
// 人が直した項目は残し、人が消したものは戻さない。「推測」と「確かめた」を AI が書く口はない(知らない項目は読まない)
export function applyOrganized(board, output) {
  // AI が記録らしいと言った要点は、一覧から消す。元にしていた番号も消える
  const recorded = uniqueKnown(output?.recordPoints, pointNumbers(board));
  // 手で欄に置いた項目は要点と同じ文なので、一緒に消す。人が消したものの中の同じ文も消す。人が直した文は残す(元の番号だけが消える)
  const recordTexts = new Set(board.points.filter((point) => recorded.includes(point.n)).map((point) => point.text.slice(0, MAX_TEXT)));
  const dropped = recorded.reduce(withoutPoint, board);
  const cleaned = {
    ...dropped,
    items: dropped.items.filter((item) => !recordTexts.has(item.text)),
    dismissed: { items: dropped.dismissed.items.filter((text) => !recordTexts.has(text)), asks: dropped.dismissed.asks },
  };
  const known = pointNumbers(cleaned);
  const held = cleaned.items.filter((item) => item.held);
  // 人が直すか振り分けた文は、欄が違っても AI の項目にしない(同じ話が 2 つの項目に分かれないように)
  const heldTexts = new Set(held.map((item) => item.text));
  const seen = new Set();
  const dismissedItems = new Set(cleaned.dismissed.items);
  const dismissedAsks = new Set(cleaned.dismissed.asks);
  let { nextItem, nextAsk } = cleaned;
  let omitted = recorded.length;
  const items = [...held];
  for (const given of Array.isArray(output?.items) ? output.items : []) {
    if (items.length >= MAX_ITEMS) break;
    if (typeof given?.column !== 'string' || !Object.hasOwn(COLUMNS, given.column)) continue;
    const text = clip(given.text, MAX_TEXT);
    const key = itemKey({ column: given.column, text });
    // 記録があると言った要点を元にした項目は、作らない(番号を抜いた文でも、記録の話なので)
    if (citesAny(given.sources, recorded)) continue;
    if (hasRecord(text)) {
      omitted += 1;
      continue;
    }
    if (!text || dismissedItems.has(text) || heldTexts.has(text) || seen.has(key)) continue;
    seen.add(key);
    items.push({ id: `i${nextItem}`, column: given.column, text, sources: uniqueKnown(given.sources, known), by: 'ai', held: false, checkedAt: null });
    nextItem += 1;
  }
  const asks = [];
  for (const given of Array.isArray(output?.toAsk) ? output.toAsk : []) {
    if (asks.length >= MAX_ASKS) break;
    const text = clip(given?.text, MAX_TEXT);
    if (citesAny(given?.sources, recorded)) continue;
    if (hasRecord(text)) {
      omitted += 1;
      continue;
    }
    if (!text || dismissedAsks.has(text) || asks.some((ask) => ask.text === text)) continue;
    asks.push({ id: `a${nextAsk}`, kind: AI_ASK_KINDS.includes(given.kind) ? given.kind : 'unasked', text, sources: uniqueKnown(given.sources, known) });
    nextAsk += 1;
  }
  return { ...cleaned, items, asks, nextItem, nextAsk, note: omitted > 0 ? omittedNote(omitted) : null, organizedAt: new Date().toISOString() };
}

// 前の板に残っていた記録らしいものを取り除く。K4 より前に打った要点のため。何もなければ同じ板を返す
export function scrubRecords(board) {
  const recorded = board.points.filter((point) => hasRecord(point.text)).map((point) => point.n);
  const dropped = recorded.reduce(withoutPoint, board);
  const clean = (entry) => !hasRecord(entry.text);
  const scrubbed = {
    ...dropped,
    items: dropped.items.filter(clean),
    asks: dropped.asks.filter(clean),
    dismissed: { items: dropped.dismissed.items.filter((text) => !hasRecord(text)), asks: dropped.dismissed.asks.filter((text) => !hasRecord(text)) },
  };
  const removed = recorded.length + (dropped.items.length - scrubbed.items.length) + (dropped.asks.length - scrubbed.asks.length) + (dropped.dismissed.items.length - scrubbed.dismissed.items.length) + (dropped.dismissed.asks.length - scrubbed.dismissed.asks.length);
  return removed > 0 ? { ...scrubbed, note: omittedNote(removed) } : board;
}

// 要点を消す。指していた番号も消す。元の要点がなくなった項目は「推測」になる
function withoutPoint(board, n) {
  const drop = (entry) => ({ ...entry, sources: entry.sources.filter((source) => source !== n) });
  return { ...board, points: board.points.filter((point) => point.n !== n), items: board.items.map(drop), asks: board.asks.map(drop) };
}

// 聞くことの全部。AI が出したものに、Studio が 2 つを足す。推測のままの項目と、空の欄(AI の返事によらず出す)
export function asksOf(board) {
  const guesses = board.items.filter(isGuess).map((item) => ({ id: `guess-${item.id}`, kind: 'guess', text: `${COLUMNS[item.column]}の「${item.text}」は話に出ていません。合っていますか?`, sources: [] }));
  const filled = new Set(board.items.map((item) => item.column));
  const empty = board.items.length === 0 ? [] : Object.keys(COLUMNS).filter((column) => !filled.has(column)).map((column) => ({ id: `empty-${column}`, kind: 'empty', text: `「${COLUMNS[column]}」の話をまだ聞いていません。`, sources: [] }));
  return [...board.asks, ...guesses, ...empty];
}

// 画面に渡す形。印はここで作る(ファイルの中の値を信じない)
export function boardView(board) {
  const { formatVersion, nextPoint, nextItem, nextAsk, ...rest } = board;
  const cited = new Set(board.items.flatMap((item) => item.sources));
  return {
    ...rest,
    points: board.points.map((point) => ({ ...point, placed: cited.has(point.n) })),
    items: board.items.map((item) => ({ ...item, guess: isGuess(item) })),
    asks: asksOf(board),
  };
}

export class ProjectOrganizes {
  // ai は整理する AI の接続(organize-ai.js)。consent は本物の AI を使う前の同意(real-ai.js)。
  // aiMode(id) は 'fake'(偽接続。同意なし)、'real'(同意が要る)、null(使えない。人が手で振り分ける)のどれか。
  // talkGate(id) は、会の同意の前に投げる(meeting.js)。お客さんの話を、同意の前に板へ入れない。
  // onWrite(id) は板を書いた後に呼ぶ(共有の場の写しを置き直す。share.js)
  constructor({ home, store, ai, consent, aiMode, talkGate = () => {}, onWrite = () => {}, log = () => {} }) {
    this.home = home;
    this.store = store;
    this.ai = ai;
    this.consent = consent;
    this.aiMode = aiMode;
    this.talkGate = talkGate;
    this.onWrite = onWrite;
    this.log = log;
    this.boards = new Map();
    // 応答を待っている試作品ごとの AbortController
    this.calling = new Map();
    // 試作品ごとの書き換えの列。AI を待つ間も要点を足せるように、書き換えは短く、順に通す
    this.queues = new Map();
    this.closed = false;
  }

  file(id) {
    return path.join(projectPaths(this.home, id).studio, ORGANIZE_FILE);
  }

  // 起動のときに読む。壊れたファイルは読まず、「整理なし」として扱う(次に書くと置き換わる)
  async load() {
    for (const project of await listProjects(this.home)) {
      try {
        const board = JSON.parse(await fs.readFile(this.file(project.id), 'utf8'));
        if (board?.formatVersion === FORMAT && [board.points, board.items, board.asks, board.dismissed?.items, board.dismissed?.asks].every(Array.isArray)) {
          const scrubbed = scrubRecords(board);
          if (scrubbed === board) this.boards.set(project.id, board);
          else {
            await this.write(project.id, { ...scrubbed, rev: board.rev + 1, status: 'draft', confirmedAt: null });
            this.log(`整理の板から、記録らしいものを取り除きました: ${project.id}`);
          }
        }
      } catch (error) {
        if (error.code !== 'ENOENT') this.log(`整理の板を読めませんでした: ${project.id}(${error.message})`);
      }
    }
  }

  async write(id, board) {
    // 止めた後に返ってきた呼び出しは書かない(置き場が消されていても、作り直さない)
    if (this.closed) return;
    // 待つ間に会のデータが消されていたら、書かない(置き場を作り直さない)
    await this.store.requireProject(id);
    const file = this.file(id);
    board.updatedAt = new Date().toISOString();
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    await fs.writeFile(tmp, `${JSON.stringify(board, null, 2)}\n`);
    await fs.rename(tmp, file);
    this.boards.set(id, board);
    this.onWrite(id);
  }

  // 一覧に載せる短い形。板がなければ none
  summary(id) {
    const board = this.boards.get(id);
    return { status: board?.status ?? 'none', confirmedAt: board?.confirmedAt ?? null, updatedAt: board?.updatedAt ?? null };
  }

  async requireProject(id) {
    if (!isValidProjectId(id)) throw new NotFoundError(`プロジェクトがありません: ${id}`);
    return this.store.requireProject(id);
  }

  // thinking は AI の応答を待っているか。ai は今 AI を呼べるか(null なら、人が手で振り分ける)
  viewOf(id) {
    const board = this.boards.get(id);
    const base = board ? boardView(board) : { ...boardView(emptyBoard()), status: 'none' };
    return { ...base, thinking: this.calling.has(id), ai: this.aiMode(id) };
  }

  async view(id) {
    await this.requireProject(id);
    return this.viewOf(id);
  }

  // 書き換えを 1 つずつ通す。work は今の板から次の板を返す。keepMark でなければ「確かめた」の印を外す
  async change(id, work, { keepMark = false } = {}) {
    await this.requireProject(id);
    this.talkGate(id);
    const run = async () => {
      // 列を待つ間に、会のデータが消されたかもしれない。消した後に書いて、置き場を作り直さない
      await this.requireProject(id);
      const board = this.boards.get(id) ?? emptyBoard();
      const next = work(board);
      next.rev = board.rev + 1;
      if (!keepMark) {
        next.status = 'draft';
        next.confirmedAt = null;
      }
      await this.write(id, next);
      return this.viewOf(id);
    };
    const result = (this.queues.get(id) ?? Promise.resolve()).then(run, run);
    this.queues.set(id, result.catch(() => {}));
    return result;
  }

  // 聞いた要点を足す
  addPoint(id, { text } = {}) {
    return this.change(id, (board) => {
      refuseRecord(text ?? '');
      const clean = clip(text, MAX_POINT);
      if (!clean) throw new IntentError(400, 'invalid', '聞いた要点を書いてください');
      return withPoint(board, clean).board;
    });
  }

  removePoint(id, { n } = {}) {
    return this.change(id, (board) => {
      requirePoint(board, n);
      return withoutPoint(board, n);
    });
  }

  // 要点を、人が欄に入れる。AI を使えないときの道でもある。項目の元は、その要点
  placePoint(id, { n, column } = {}) {
    return this.change(id, (board) => {
      const point = requirePoint(board, n);
      requireColumn(column);
      return withPersonItem(board, { column, text: point.text.slice(0, MAX_TEXT), sources: [n] });
    });
  }

  // 項目を人が足す。人が打った文を要点にも足し、項目の元にする(全部の項目に、元の要点か「推測」の印があるように)
  addItem(id, { column, text } = {}) {
    return this.change(id, (board) => {
      requireColumn(column);
      refuseRecord(text ?? '');
      const clean = clip(text, MAX_TEXT);
      if (!clean) throw new IntentError(400, 'invalid', '項目の文を書いてください');
      const { board: added, n } = withPoint(board, clean);
      return withPersonItem(added, { column, text: clean, sources: [n] });
    });
  }

  // 項目を人が直す。次の整理でも残す。元の要点は変えない(直しても話に出たことにはならない)。
  // 直す前の文は人が消したものに入れる(AI がまた同じ文を返しても、別の項目として戻さない)
  editItem(id, { id: itemId, text, column } = {}) {
    return this.change(id, (board) => {
      const item = requireItem(board, itemId);
      refuseRecord(text ?? '');
      const clean = text === undefined ? item.text : clip(text, MAX_TEXT);
      if (!clean) throw new IntentError(400, 'invalid', '項目の文を書いてください');
      if (column !== undefined) requireColumn(column);
      const replaced = clean === item.text ? board.dismissed.items : [...new Set([...board.dismissed.items, item.text])];
      return { ...replaceItem(board, itemId, { ...item, text: clean, column: column ?? item.column, held: true }), dismissed: { ...board.dismissed, items: replaced } };
    });
  }

  removeItem(id, { id: itemId } = {}) {
    return this.change(id, (board) => {
      const item = requireItem(board, itemId);
      return {
        ...board,
        items: board.items.filter((entry) => entry.id !== itemId),
        dismissed: { ...board.dismissed, items: [...new Set([...board.dismissed.items, item.text])] },
      };
    });
  }

  // 「推測」の項目を、人が合っていると確かめた。「推測」の印が外れ、次の整理でも残す
  checkItem(id, { id: itemId } = {}) {
    return this.change(id, (board) => replaceItem(board, itemId, { ...requireItem(board, itemId), held: true, checkedAt: new Date().toISOString() }));
  }

  // 聞くことを消す(AI が出したものだけ。推測と空の欄は、元を直すと消える)
  removeAsk(id, { id: askId } = {}) {
    return this.change(id, (board) => {
      const ask = board.asks.find((entry) => entry.id === askId);
      if (!ask) throw new IntentError(404, 'no-ask', 'その聞くことはありません');
      return {
        ...board,
        asks: board.asks.filter((entry) => entry.id !== askId),
        dismissed: { ...board.dismissed, asks: [...new Set([...board.dismissed.asks, ask.text])] },
      };
    });
  }

  // 整理する。1 回押すと 1 回呼ぶ(形が壊れたときのやり直しを入れて多くて 2 回)。Studio が勝手には呼ばない。
  // 待つ間も要点を足せるように、列をふさがない。返ってきたら、その時の板に入れる
  async run(id) {
    await this.requireProject(id);
    if (this.calling.has(id)) throw new BusyError('整理しているところです。終わるか止めるまで待ってください');
    this.talkGate(id);
    const mode = this.aiMode(id);
    if (!mode) throw new IntentError(409, 'no-ai', '今は AI を使えません。要点の横の欄で、手で振り分けてください');
    if (mode === 'real') this.consent.require('organize');
    const board = this.boards.get(id);
    if (!board || board.points.length === 0) throw new IntentError(400, 'no-points', '先に、聞いた要点を打ってください');
    const controller = new AbortController();
    this.calling.set(id, controller);
    try {
      let output = null;
      let note = null;
      try {
        output = await this.ai.organize({
          points: board.points,
          held: board.items.filter((item) => item.held),
          dismissed: [...board.dismissed.items, ...board.dismissed.asks],
          // 項目のない返事で板を空にしない。人が決めた項目だけで足りているときだけ、空を受ける
          needItems: board.items.length === 0 || board.items.some((item) => !item.held),
          signal: controller.signal,
        });
      } catch (error) {
        this.log(`整理する AI の返事を使えませんでした: ${id}(${error.code ?? 'failed'})`);
        note = error.code === 'cancelled' ? '止めました。要点と板は、そのまま残っています。' : 'AI の返事を使えませんでした。要点と板は、そのまま残っています。もう一度押すか、要点の横の欄で、手で振り分けてください。';
      }
      // 使えなかったときは板を変えないので、「確かめた」の印も外さない
      await this.change(id, (current) => (output ? applyOrganized(current, output) : { ...current, note }), { keepMark: !output });
    } finally {
      this.calling.delete(id);
    }
    return this.viewOf(id);
  }

  // 応答を待つのをやめる
  cancel(id) {
    const controller = this.calling.get(id);
    if (!controller) return false;
    controller.abort();
    return true;
  }

  // 決める人が「この理解で合っている」を押したときだけ呼ぶ。「確かめた」の印を付ける唯一の所。
  // rev は読んでいた板の版。読んだ後に板が変わっていたら断る(読んでいない中身を確かめたことにしない)
  confirm(id, { rev } = {}) {
    return this.change(id, (board) => {
      if (this.calling.has(id)) throw new BusyError('整理しているところです。終わってから読み、押してください');
      if (board.items.length === 0) throw new IntentError(409, 'no-items', '整理の板に項目がありません');
      if (rev !== board.rev) throw new IntentError(409, 'stale-board', '読んだ後に整理の板が変わりました。読み直してから押してください');
      return { ...board, status: 'confirmed', confirmedAt: new Date().toISOString(), note: null };
    }, { keepMark: true });
  }

  // 会のデータを消した後に呼ぶ。列の書き換えが終わるのを待ち、メモリーの板を捨てる
  async forget(id) {
    await this.queues.get(id);
    this.queues.delete(id);
    this.boards.delete(id);
  }

  async close() {
    this.closed = true;
    for (const controller of this.calling.values()) controller.abort();
    await this.ai.close();
  }
}

function withPoint(board, text) {
  if (board.points.length >= MAX_POINTS) throw new IntentError(409, 'too-many', `要点は ${MAX_POINTS} 個までです`);
  const n = board.nextPoint;
  return { n, board: { ...board, nextPoint: n + 1, points: [...board.points, { n, text, at: new Date().toISOString() }], note: null } };
}

function withPersonItem(board, { column, text, sources }) {
  if (board.items.length >= MAX_ITEMS) throw new IntentError(409, 'too-many', `項目は ${MAX_ITEMS} 個までです`);
  const item = { id: `i${board.nextItem}`, column, text, sources, by: 'person', held: true, checkedAt: null };
  return { ...board, nextItem: board.nextItem + 1, items: [...board.items, item], note: null };
}

function replaceItem(board, itemId, item) {
  return { ...board, items: board.items.map((entry) => (entry.id === itemId ? item : entry)) };
}

function requirePoint(board, n) {
  const point = board.points.find((entry) => entry.n === n);
  if (!point) throw new IntentError(404, 'no-point', 'その要点はありません');
  return point;
}

function requireItem(board, itemId) {
  const item = board.items.find((entry) => entry.id === itemId);
  if (!item) throw new IntentError(404, 'no-item', 'その項目はありません。整理の板が変わった可能性があります');
  return item;
}

function requireColumn(column) {
  if (typeof column !== 'string' || !Object.hasOwn(COLUMNS, column)) throw new IntentError(400, 'invalid', `欄は ${Object.values(COLUMNS).join('、')} のどれかです`);
}
