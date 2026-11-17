import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { projectPaths } from './projects.js';
import { BusyError } from './store.js';

// 人に見せる(docs/design/user-journey.md の J7。段 7)。
// 見せる画面には、試作品と確かめたい問いだけを出す。問いは目的の文書の「成功の印」から Studio が作る(AI は呼ばない)。
// 見せ始めると、今の状態をどれかの版に結び付ける。どの版とも違えば、新しい版として保存する。
// 答えは .studio/show.json に、見せた版の ID と番号を付けて残す。版の写し(.studio/versions/)の中には置かない。
// だから、版を戻しても答えは消えない(目的の文書と同じ扱い)。.studio/ は Studio だけが書く場所で、作る AI は読み書きできない。
// 手元の PC で見せる形だけ。共有の公開はしない(外への通信はない)

export const SHOW_FILE = 'show.json';
const FORMAT = 1;
// 見せ始めたときに、どの版とも違う状態を保存する名前
export const SHOW_VERSION_NAME = '人に見せた状態';

export const SHOW_LIMITS = Object.freeze({
  // 成功の印から作る問いの数
  maxSuccessQuestions: 5,
  maxQuestion: 200,
  maxAnswer: 1000,
  maxViewer: 40,
  // 1 つの試作品に残す答えの記録の数。超えたら古いものから消す
  maxRecords: 200,
});

// 成功の印がないときの問い。最後の問いは、いつも足す
export const FALLBACK_QUESTIONS = Object.freeze(['この試作品を、ふだんの仕事で使ってみたいと思いますか?']);
export const CLOSING_QUESTION = '使ってみて、分かりにくいところや困ったところはありましたか?';

export class ShowError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function clip(value, max) {
  return typeof value === 'string' ? value.replace(/[\u0000-\u0008\u000b-\u001f\u007f]+/g, ' ').trim().slice(0, max) : '';
}

// 成功の印の文を、1 つずつの印に分ける。改行と句点で分け、行の頭の箇条書きの印(「- 」「・」など)を外す。
// 文の中の中黒(「勤務地・職種」)では分けない
export function successItems(success) {
  if (typeof success !== 'string') return [];
  const items = success
    .split(/[\n。]+/)
    .map((item) => item.replace(/^[\s\-*・●]+/, '').replace(/[\s、,.!!]+$/, '').trim())
    .filter(Boolean);
  return [...new Set(items)].slice(0, SHOW_LIMITS.maxSuccessQuestions);
}

// 確かめたい問い。成功の印ごとに 1 つと、最後に困ったところを聞く問い。
// source は success(成功の印から作った)か fallback(成功の印がないので決まった問い)
export function questionsFrom(doc) {
  const items = successItems(doc?.success);
  const fromSuccess = items.map((item) => clip(`この試作品で「${item}」に近づきそうですか?`, SHOW_LIMITS.maxQuestion));
  return {
    source: items.length > 0 ? 'success' : 'fallback',
    questions: [...(items.length > 0 ? fromSuccess : FALLBACK_QUESTIONS), CLOSING_QUESTION],
  };
}

function isRecord(record) {
  return (
    record !== null &&
    typeof record === 'object' &&
    typeof record.id === 'string' &&
    typeof record.versionId === 'string' &&
    Number.isSafeInteger(record.versionNumber) &&
    typeof record.answeredAt === 'string' &&
    Array.isArray(record.answers)
  );
}

// 版の一覧の上に、答えを載せる形。版の ID ごとに、古い順
export function byVersion(records) {
  const map = {};
  for (const record of records) (map[record.versionId] ??= []).push(record);
  return map;
}

// .studio/show.json を読む。引き継ぎ(handoff.js)も使う。壊れたファイルは broken で知らせ、読める記録だけを返す
// 形の違う記録が混ざっていれば、書き直すと消えるので、壊れたものとして扱う(読める記録は出す)
export async function readShowFile(file) {
  try {
    const data = JSON.parse(await fs.readFile(file, 'utf8'));
    if (data?.format !== FORMAT || !Array.isArray(data.records)) return { records: [], broken: true, reason: '形が違います' };
    const records = data.records.filter(isRecord);
    if (records.length !== data.records.length) return { records, broken: true, reason: '形の違う記録があります' };
    return { records, broken: false, reason: null };
  } catch (error) {
    if (error.code === 'ENOENT') return { records: [], broken: false, reason: null };
    return { records: [], broken: true, reason: error.message };
  }
}

export class ProjectShows {
  // versions は版(versions.js)。intents は目的の文書(intent.js)
  constructor({ home, store, versions, intents, log = () => {} }) {
    this.home = home;
    this.store = store;
    this.versions = versions;
    this.intents = intents;
    this.log = log;
    // 書き換えの途中の試作品。同じ試作品の書き換えは 1 つずつ
    this.locked = new Set();
    // 読めないファイルを知らせた試作品
    this.warned = new Set();
  }

  file(id) {
    return path.join(projectPaths(this.home, id).studio, SHOW_FILE);
  }

  // 壊れたファイルは、答えがないものとして読む(消さない。次に書くときに上書きしないよう、書く前に確かめる)
  async readRecords(id) {
    const read = await readShowFile(this.file(id));
    if (!read.broken) return { records: read.records, broken: false };
    return { ...this.broken(id, read.reason), records: read.records };
  }

  // 版の一覧を読むたびに呼ばれるので、ターミナルへの知らせは試作品ごとに 1 回だけ
  broken(id, reason) {
    if (!this.warned.has(id)) {
      this.warned.add(id);
      this.log(`人に見せた答えを読めませんでした: ${id}(${reason})。ファイルは上書きしません`);
    }
    return { records: [], broken: true };
  }

  async records(id) {
    return (await this.readRecords(id)).records;
  }

  // 版の一覧に載せる答え(versions.js の list から呼ぶ)
  async answersByVersion(id) {
    return byVersion(await this.records(id));
  }

  async questions(id) {
    const intent = this.intents.viewOf(id);
    return questionsFrom(intent?.status === 'skipped' ? null : intent?.doc);
  }

  async view(id) {
    await this.store.requireProject(id);
    return { ...(await this.questions(id)), records: await this.records(id) };
  }

  // 見せ始める。今の状態と同じ、自分で保存した版があれば、それに結び付ける。なければ保存する(表示できない状態は保存できず、見せられない)。
  // 自動の版には結び付けない。自動の版は古いものから消えるので、答えの行き先がなくなる
  async start(id) {
    await this.store.requireProject(id);
    const list = await this.versions.list(id);
    let version = list.working.files === 'saved' ? list.versions.find((v) => v.id === list.working.versionId) : null;
    // 今の状態が表示できない版と同じなら、画面には前に表示できた状態が出ている。見せているものと答えが食い違うので、見せない
    if (version && !version.builds) throw new ShowError(422, 'build', '今の状態は表示できないので、見せられません。「作る AI」の欄で直してもらってから見せてください');
    if (version?.kind === 'auto') version = null;
    let savedNow = false;
    if (!version) {
      const saved = await this.versions.save(id, { name: SHOW_VERSION_NAME });
      version = saved.version;
      savedNow = true;
    }
    this.log(`人に見せ始めました: ${id}(v${version.number}${savedNow ? '。今の状態を保存' : ''})`);
    return {
      version: { id: version.id, number: version.number, name: version.name },
      savedNow,
      ...(await this.questions(id)),
    };
  }

  // 答えを残す。{ versionId, viewer, answers: [{ question, answer }] }。答えが 1 つもなければ残さない
  async answer(id, { versionId, viewer, answers } = {}) {
    await this.store.requireProject(id);
    if (typeof versionId !== 'string') throw new ShowError(400, 'invalid', 'どの版を見せたかが分かりません。見せる画面を開き直してください');
    if (!Array.isArray(answers)) throw new ShowError(400, 'invalid', '答えの形が正しくありません');
    const cleaned = answers
      .slice(0, SHOW_LIMITS.maxSuccessQuestions + FALLBACK_QUESTIONS.length + 1)
      .map((item) => ({ question: clip(item?.question, SHOW_LIMITS.maxQuestion), answer: clip(item?.answer, SHOW_LIMITS.maxAnswer) }))
      .filter((item) => item.question && item.answer);
    if (cleaned.length === 0) throw new ShowError(400, 'empty', '答えが 1 つもありません。聞いた答えを書いてから残してください');
    const { versions } = await this.versions.list(id);
    const version = versions.find((v) => v.id === versionId);
    if (!version) throw new ShowError(404, 'not-found', '見せた版がありません。見せる画面を開き直してください');
    if (this.locked.has(id)) throw new BusyError('前の答えを残しているところです。終わるまで待ってください');
    this.locked.add(id);
    try {
      const { records, broken } = await this.readRecords(id);
      if (broken) {
        // 読めないファイルを上書きして、前の答えを消さない
        throw new ShowError(500, 'broken', `前の答えのファイルを読めないので、残せません。${this.file(id)} を確かめてください`);
      }
      const record = {
        id: crypto.randomBytes(8).toString('hex'),
        versionId: version.id,
        versionNumber: version.number,
        answeredAt: new Date().toISOString(),
        viewer: clip(viewer, SHOW_LIMITS.maxViewer),
        answers: cleaned,
      };
      const next = [...records, record].slice(-SHOW_LIMITS.maxRecords);
      // 待つ間に会のデータが消されていたら、書かない(置き場を作り直さない)
      await this.store.requireProject(id);
      const file = this.file(id);
      await fs.mkdir(path.dirname(file), { recursive: true });
      const tmp = `${file}.${crypto.randomBytes(4).toString('hex')}.tmp`;
      await fs.writeFile(tmp, `${JSON.stringify({ format: FORMAT, records: next }, null, 2)}\n`);
      await fs.rename(tmp, file);
      this.log(`人に見せた答えを残しました: ${id}(v${version.number}。${cleaned.length} 問)`);
      return { record, records: next };
    } finally {
      this.locked.delete(id);
    }
  }
}
