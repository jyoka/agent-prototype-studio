import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createStarterProject, IntentError } from './intent.js';
import { isValidProjectId, listProjects, projectPaths, projectsDir } from './projects.js';
import { findRecords } from './redact.js';
import { BusyError, NotFoundError } from './store.js';

// 会の始めとお客さんのデータ(docs/design/field-session.md の段 0、docs/design/collaboration.md の 7 節、K4)。
// 会は 1 つの試作品と同じ長さで、同意と消す日を .studio/meeting.json に持つ。会ではない試作品は今までどおり。
// 状態は 3 つ。waiting(同意の前。どの AI も呼ばない)、agreed(同意した)、trial(同意しない道。外の AI に送らない)。
// 消すのは人が押したときだけ。消す日を過ぎても、Studio は知らせるだけで勝手に消さない。

export const MEETING_FILE = 'meeting.json';
// 直した記録の置き場(K3 が書く)。消す一覧で数える
export const FIX_RECORDS_DIR = 'fix-records';
const FORMAT = 1;
const MAX_PURPOSE = 200;
// 消す日の既定(日数)。仮の値(collaboration.md の 7 節)
export const DEFAULT_DELETE_DAYS = 30;
const ERASING_PREFIX = '.erasing-';
const ERASING_NAME = /^\.erasing-([a-z0-9-]{1,64})-[0-9a-f]{8}$/;
// 会の試作品の ID の頭。ID を見れば会と分かるので、記録のファイルが消えても同意の前として扱える
export const MEETING_ID_PREFIX = 'meeting';
const isMeetingId = (id) => id.startsWith(`${MEETING_ID_PREFIX}-`);
const HANDOFFS_DIR = 'handoffs';
const DECISIONS = { agree: 'agreed', trial: 'trial' };
const STATUSES = ['waiting', 'agreed', 'trial'];

// 1 時間の流れ(field-session.md の 2 節)。ready は今の Studio で通るか
export const MEETING_FLOW = [
  { label: '聞く', ready: true },
  { label: 'AI が整理する', ready: true },
  { label: 'AI 構成の審査', ready: false },
  { label: '試作品', ready: true },
  { label: '見せて、コメントをもらう', ready: false },
  { label: '承認して AI が直す', ready: false },
  { label: '要件の文書と引き継ぎ', ready: false },
];

const SENDS = ['お客さんの話(打った要点)', '整理の板の項目', '目的の文書', '試作品のソース'];

export class MeetingRefusedError extends Error {
  constructor(code, message, next) {
    super(message);
    this.code = code;
    this.next = next;
  }
}

const pad = (n) => String(n).padStart(2, '0');
// 手元の時計の日付(YYYY-MM-DD)。消す日はお客さんと話す日付なので、手元の日付で比べる
export const localDate = (date = new Date()) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

export function defaultDeleteOn(now = new Date()) {
  const date = new Date(now);
  date.setDate(date.getDate() + DEFAULT_DELETE_DAYS);
  return localDate(date);
}

// 消す日の形を確かめる。今日より前は断る(用意してすぐ「過ぎた」にしない)
export function validDeleteOn(value, today = localDate()) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(typeof value === 'string' ? value : '');
  const date = match && new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  if (!date || localDate(date) !== value) throw new IntentError(400, 'invalid', '消す日は、年月日で選んでください');
  if (value < today) throw new IntentError(400, 'invalid', '消す日は、今日か、それより後にしてください');
  return value;
}

export const isOverdue = (record, today = localDate()) => record.deleteOn < today;

async function countFiles(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  let count = 0;
  for (const entry of entries) count += entry.isDirectory() ? await countFiles(path.join(dir, entry.name)) : 1;
  return count;
}

const countEntries = async (dir) => (await fs.readdir(dir).catch(() => [])).filter((name) => !name.endsWith('.tmp')).length;

// その試作品の引き継ぎの書き出し(handoff.js の名前の形。.tmp は書きかけ)。別の試作品のものは消さない
async function handoffDirs(home, id) {
  const dir = path.join(home, HANDOFFS_DIR);
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  const ours = new RegExp(`^\\.?${id}-\\d{8}-\\d{6}(?:-[0-9a-f]{4})?(?:\\.tmp)?$`);
  return entries.filter((entry) => entry.isDirectory() && ours.test(entry.name)).map((entry) => path.join(dir, entry.name));
}

// 消している途中で止まった置き場と、その試作品の引き継ぎの書き出しを消す(起動のとき)
export async function removeErasing(home, log = () => {}) {
  const entries = await fs.readdir(projectsDir(home)).catch(() => []);
  for (const name of entries) {
    const match = ERASING_NAME.exec(name);
    if (!match) continue;
    for (const target of [...(await handoffDirs(home, match[1])), path.join(projectsDir(home), name)]) await fs.rm(target, { recursive: true, force: true });
    log('前に消している途中だった会のデータを消しました');
  }
}

export class ProjectMeetings {
  // cost() は料金と送り先の文(real-ai.js の describeCost)。sendsOutside は外の AI に送る接続か。
  // busy(id) は AI の応答を待っているか。forget(id) はほかの部品のメモリーを捨てる
  constructor({ home, store, consent, sendsOutside = false, cost = () => null, busy = () => false, forget = async () => {}, log = () => {} }) {
    this.home = home;
    this.store = store;
    this.consent = consent;
    this.sendsOutside = sendsOutside;
    this.cost = cost;
    this.busy = busy;
    this.forget = forget;
    this.log = log;
    this.records = new Map();
  }

  file(id) {
    return path.join(projectPaths(this.home, id).studio, MEETING_FILE);
  }

  // 起動のときに読む。壊れたファイルは読まず、消す日を過ぎた会をターミナルにも知らせる。
  // 壊れていても会だった印は残すため、同意の前として扱う(読めないまま AI を呼ばない)
  async load() {
    const today = localDate();
    for (const project of await listProjects(this.home)) {
      try {
        const record = JSON.parse(await fs.readFile(this.file(project.id), 'utf8'));
        if (record?.formatVersion !== FORMAT || !STATUSES.includes(record.status) || !/^\d{4}-\d{2}-\d{2}$/.test(record.deleteOn)) throw new Error('形が違います');
        // 外へ送らないと見せて取った同意で、外の AI に送らない。この起動の送り先を見せて、もう一度聞く
        if (record.status === 'agreed' && !record.agreedOutside && this.sendsOutside) record.status = 'waiting';
        this.records.set(project.id, record);
        if (isOverdue(record, today)) this.log(`消す日を過ぎた会があります: ${project.id}(${record.deleteOn})`);
      } catch (error) {
        // 会の ID でなければ、会ではない試作品。会の ID なのにファイルがないときは、壊れたときと同じに扱う
        if (error.code === 'ENOENT' && !isMeetingId(project.id)) continue;
        this.log(`会の記録を読めませんでした: ${project.id}(${error.message})`);
        this.records.set(project.id, { formatVersion: FORMAT, status: 'waiting', purpose: project.title, deleteOn: defaultDeleteOn(), createdAt: null, decidedAt: null });
      }
    }
  }

  async write(id, record) {
    const file = this.file(id);
    record.updatedAt = new Date().toISOString();
    const tmp = `${file}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    await fs.writeFile(tmp, `${JSON.stringify(record, null, 2)}\n`);
    await fs.rename(tmp, file);
    this.records.set(id, record);
  }

  requireMeeting(id) {
    if (!isValidProjectId(id)) throw new NotFoundError(`プロジェクトがありません: ${id}`);
    const record = this.records.get(id);
    if (!record) throw new IntentError(404, 'no-meeting', 'この試作品は会ではありません');
    return record;
  }

  // AI を呼んでよいか。mode は 'real'(外の AI に送る)か 'fake'。会ではない試作品は今までどおり(本物の AI の同意は別に確かめる)
  mayCall(id, mode) {
    const status = this.records.get(id)?.status;
    if (status === 'waiting') return false;
    return !(status === 'trial' && mode === 'real');
  }

  // AI を呼ぶ前に呼ぶ。だめなら理由のコードつきで断る
  require(id, mode) {
    this.requireDecided(id);
    if (!this.mayCall(id, mode)) throw new MeetingRefusedError('meeting-trial', 'この会は、お試しの AI だけで進める会です。外の AI には送りません', 'お客さんが送ってよいと決めたら、会の始めの画面で「同意して始める」を押してください。');
  }

  // お客さんの話を扱う前に呼ぶ。同意の前は断る
  requireDecided(id) {
    if (this.records.get(id)?.status === 'waiting') throw new MeetingRefusedError('meeting-consent-required', 'この会は、まだ同意の前です。整理する AI と作る AI を呼ばず、お客さんの話も入れません', '会の始めの画面を見せて、「同意して始める」か「お試しの AI だけで始める」を押してください。');
  }

  // 一覧に載せる短い形
  summary(id) {
    const record = this.records.get(id);
    if (!record) return { status: 'none', deleteOn: null, overdue: false, updatedAt: null };
    return { status: record.status, deleteOn: record.deleteOn, overdue: isOverdue(record), updatedAt: record.updatedAt ?? null };
  }

  // 消す日を過ぎた会の一覧
  due(projects) {
    // 名前は入れない。ほかのお客さんの前で、別の会の目的を出さないため
    return projects.filter((project) => this.summary(project.id).overdue).map((project) => ({ id: project.id, deleteOn: this.records.get(project.id).deleteOn }));
  }

  // 新しい試作品と会を作る。目的は試作品の名前にもなるので、記録らしいものは断る
  async create({ purpose } = {}) {
    const text = typeof purpose === 'string' ? purpose.trim() : '';
    if (!text) throw new IntentError(400, 'invalid', '会の目的を書いてください');
    if (text.length > MAX_PURPOSE) throw new IntentError(400, 'invalid', `会の目的は ${MAX_PURPOSE} 文字までにしてください`);
    const kinds = findRecords(text);
    if (kinds.length > 0) throw new IntentError(422, 'record', `記録らしいものがあるので、入れませんでした(${kinds.join('、')})。その部分を抜いて、書き直してください。`);
    await fs.mkdir(projectsDir(this.home), { recursive: true });
    const id = await createStarterProject(this.home, text, MEETING_ID_PREFIX);
    await this.write(id, { formatVersion: FORMAT, status: 'waiting', purpose: text, deleteOn: defaultDeleteOn(), createdAt: new Date().toISOString(), decidedAt: null });
    await this.store.build(id);
    return id;
  }

  // 画面に渡す形。送り先と料金は今の接続から作る。置き場は本当の場所を出す
  async view(id) {
    await this.store.requireProject(id);
    const record = this.requireMeeting(id);
    const { formatVersion, ...rest } = record;
    const cost = this.sendsOutside ? this.cost() : null;
    return {
      ...rest,
      overdue: isOverdue(record),
      flow: MEETING_FLOW,
      sending: this.sendsOutside ? { outside: true, items: SENDS, to: cost?.to ?? null, cost: cost?.text ?? null } : { outside: false, items: SENDS, to: null, cost: null },
      place: projectPaths(this.home, id).root,
      viewers: 'この PC を使える人',
      erasable: await this.plan(id),
    };
  }

  // 同意する(agree)か、同意しない道を選ぶ(trial)。人が押したときだけ呼ぶ。
  // agree は、外の AI に送る接続なら、本物の AI の同意も兼ねる(同じ画面で送るもの、送り先、料金を見せたため)
  async decide(id, { decision, deleteOn } = {}) {
    await this.store.requireProject(id);
    const record = this.requireMeeting(id);
    if (!Object.hasOwn(DECISIONS, decision ?? '')) throw new IntentError(400, 'invalid', 'decision は agree か trial です');
    const status = DECISIONS[decision];
    // 同意した会を、お試しに戻さない。送った後なので、戻しても取り消せないため。やめるときは会のデータを消す
    if (record.status === 'agreed' && status !== 'agreed') throw new IntentError(409, 'already-agreed', 'この会は同意の後です。やめるときは、会のデータを消してください');
    const nextDelete = deleteOn === undefined ? record.deleteOn : validDeleteOn(deleteOn);
    // agreedOutside は、外の AI に送ると見せて取った同意か。違う同意で、後から外へ送らない(load)
    if (record.status !== status) await this.write(id, { ...record, status, deleteOn: nextDelete, decidedAt: new Date().toISOString(), agreedOutside: status === 'agreed' && this.sendsOutside });
    else if (nextDelete !== record.deleteOn) await this.write(id, { ...record, deleteOn: nextDelete });
    if (status === 'agreed' && this.sendsOutside) this.consent.agree();
    return this.view(id);
  }

  async setDeleteOn(id, { deleteOn } = {}) {
    await this.store.requireProject(id);
    const record = this.requireMeeting(id);
    await this.write(id, { ...record, deleteOn: validDeleteOn(deleteOn) });
    return this.view(id);
  }

  // 消すものの一覧。押す前に見せ、消した後にも同じ形で出す
  async plan(id) {
    const paths = projectPaths(this.home, id);
    const handoffs = await handoffDirs(this.home, id);
    return [
      { key: 'project', label: 'プロジェクト(試作品のファイル)', count: await countFiles(paths.app) },
      { key: 'versions', label: '保存した版', count: await countEntries(paths.versions) },
      { key: 'fixes', label: '直した記録', count: await countEntries(path.join(paths.studio, FIX_RECORDS_DIR)) },
      { key: 'runs', label: '作る AI の実行の記録(run)', count: await countEntries(path.join(paths.studio, 'runs')) },
      { key: 'checks', label: '確かめた記録', count: (await countEntries(path.join(paths.studio, 'observations'))) + (await countEntries(path.join(paths.studio, 'evals'))) },
      { key: 'talk', label: '聞いた要点、整理の板、目的の文書、設計、会の記録', count: await countFilesIn(paths.studio, ['organize.json', 'intent.json', 'design.json', MEETING_FILE]) },
      { key: 'handoffs', label: '引き継ぎの書き出し', count: handoffs.length, names: handoffs.map((dir) => path.basename(dir).replace(/^\./, '')) },
    ];
  }

  // 会のデータを消す。confirm に試作品の ID を求める(間違って押しても消えないように、画面が 2 段で聞く)。
  // 会ではない試作品(サンプルなど)は消さない。動いている間は断る。
  // 先に置き場を名前の違う場所へ移すので、消している間に一覧と AI からは見えない
  async erase(id, { confirm } = {}) {
    this.requireMeeting(id);
    const paths = await this.store.requireProject(id);
    if (confirm !== id) throw new IntentError(400, 'invalid', '消す試作品の ID を confirm に入れてください');
    this.store.claimErase(id);
    let plan;
    let erasing;
    let handoffs;
    const left = [];
    try {
      if (this.busy(id)) throw new BusyError('AI の応答を待っているところです。終わるか止めるまで待ってください');
      plan = await this.plan(id);
      handoffs = await handoffDirs(this.home, id);
      erasing = path.join(projectsDir(this.home), `${ERASING_PREFIX}${id}-${crypto.randomBytes(4).toString('hex')}`);
      await fs.rename(paths.root, erasing);
      this.records.delete(id);
      await this.forget(id);
      // paths.root は、移した後に書き戻されていたときのために、もう一度消す
      for (const target of [erasing, paths.root, ...handoffs]) {
        await fs.rm(target, { recursive: true, force: true, maxRetries: 3 }).catch((error) => this.log(`消せませんでした: ${target}(${error.code ?? error.message})`));
        if (await fs.lstat(target).catch(() => null)) left.push(target);
      }
    } finally {
      this.store.releaseErase(id);
    }
    this.store.forget(id);
    this.log(left.length > 0 ? `会のデータの一部を消せませんでした: ${id}` : `会のデータを消しました: ${id}`);
    return {
      // 消せたものだけを出す。置き場が残ったときは、プロジェクトの中のものを消したと言わない
      erased: (left.some((target) => target === erasing || target === paths.root) ? plan.filter((row) => row.key === 'handoffs') : plan).map((row) => {
        if (row.key !== 'handoffs') return row;
        const removed = handoffs.filter((dir) => !left.includes(dir)).map((dir) => path.basename(dir).replace(/^\./, ''));
        return { ...row, count: removed.length, names: removed };
      }),
      left,
      notErased: [
        '外の AI の送り先に届いた分は、この操作では消せません。API の入出力は既定で 30 日以内に消す、と Anthropic は書いています。サブスクのログインのときの扱いは確かめていません。',
        '引き継ぎの書き出しを別の場所へ写したものは、消せません。',
      ],
    };
  }
}

async function countFilesIn(dir, names) {
  const found = await Promise.all(names.map((name) => fs.access(path.join(dir, name)).then(() => 1, () => 0)));
  return found.reduce((sum, n) => sum + n, 0);
}
