import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { isValidProjectId, listProjects, projectPaths, projectsDir } from './projects.js';
import { BusyError, NotFoundError } from './store.js';

// 目的の聞き出しと目的の文書(docs/design/user-journey.md の段 1、段 2、J1)。
// 置き場所は .studio/intent.json(目録の intent は広げない)。.studio/ は Studio だけが書く場所で、作る AI は読み書きできない。
// 「決めた」の印は、人が「これで決める」を押したとき(decide)だけ付く。聞き出す AI の返事からは付かない。
// 問いの数の上限は Studio が数える。AI が聞き続けようとしても、上限を超えて問いを出さない。

export const INTENT_FILE = 'intent.json';
const FORMAT = 1;

// 案内の深さ。limit は問いの数の上限(値は仮。人の確かめで直す)
export const DEPTHS = {
  quick: { label: '速く', limit: 2 },
  normal: { label: 'ふつう', limit: 4 },
  deep: { label: '深く', limit: 7 },
};
export const DEFAULT_DEPTH = 'normal';

// 目的の文書の項目
export const DOC_FIELDS = ['who', 'problem', 'scene', 'success'];
const DOC_LISTS = ['notDoing', 'undecided'];
export const FIELD_LABELS = { who: '誰', problem: '何の問題', scene: '場面', success: '成功の印', notDoing: 'しないこと', undecided: '決めていないこと' };

// 決まった問い。AI を使わないとき(同意しない、Claude Code がない)と、AI の返事を使えないときに、この順に聞く
export const FIXED_QUESTIONS = [
  { field: 'who', question: '一番困っているのは誰ですか?', reason: '使う人が決まると、場面を考えられるからです。' },
  { field: 'problem', question: 'その人は、今どんなことに困っていますか?', reason: '解く問題をはっきりさせるためです。' },
  { field: 'scene', question: 'それは、いつ、どこで起きますか?', reason: '試す場面を決めるためです。' },
  { field: 'success', question: 'うまくいったら、何が変わりますか?', reason: 'できたかどうかを確かめる印にするためです。' },
  { field: 'notDoing', question: '今回はしないと決めていることはありますか?', reason: '試作品の範囲を絞るためです。' },
];

const MAX_SENTENCE = 400;
const MAX_ANSWER = 1000;
const MAX_FIELD = 1000;
const MAX_LIST_ITEMS = 30;
const MAX_ITEM = 300;
const MAX_TITLE = 40;
const UNKNOWN_ANSWER = /^(分からない|わからない|分かりません|わかりません|不明|未定|知らない|知りません)[。.!!]*$/;
// 文書の項目を書かないまま決めたときに、決めていないことへ足す文
const unwritten = (label) => `「${label}」を書いていません`;
const UNWRITTEN_PATTERN = /^「.+」を書いていません$/;

export class IntentError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function clip(value, max) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function cleanList(value) {
  if (!Array.isArray(value)) return [];
  const items = value.map((item) => clip(item, MAX_ITEM)).filter(Boolean);
  return [...new Set(items)].slice(0, MAX_LIST_ITEMS);
}

export function emptyDoc() {
  return { who: '', problem: '', scene: '', success: '', notDoing: [], undecided: [] };
}

function requireDocShape(doc) {
  if (doc !== undefined && (doc === null || typeof doc !== 'object' || Array.isArray(doc))) throw new IntentError(400, 'invalid', '目的の文書の形が正しくありません');
}

// 文書の形にそろえる。知らない項目(AI や画面が送る status など)は捨てる
export function cleanDoc(doc) {
  const source = doc && typeof doc === 'object' && !Array.isArray(doc) ? doc : {};
  const clean = emptyDoc();
  for (const field of DOC_FIELDS) clean[field] = clip(source[field], MAX_FIELD);
  for (const field of DOC_LISTS) clean[field] = cleanList(source[field]);
  return clean;
}

// 答えだけから作る下書き。AI を使わないときの文書で、AI の下書きの空きを埋める元にもなる
export function draftFromTurns({ sentence, turns }) {
  const doc = emptyDoc();
  for (const turn of turns) {
    if (turn.unknown || !turn.answer) continue;
    if (DOC_LISTS.includes(turn.field)) doc[turn.field].push(turn.answer);
    else doc[turn.field] = doc[turn.field] ? `${doc[turn.field]} ${turn.answer}` : turn.answer;
  }
  // 問題を聞く前は、最初の 1 文が今わかっている問題
  doc.problem ||= sentence;
  doc.undecided = turns.filter((turn) => turn.unknown).map((turn) => turn.question);
  return cleanDoc(doc);
}

// AI の下書きと答えを合わせる。「分からない」と答えた問いは、AI の返事によらず決めていないことに入れる
export function mergeDraft(record, draft) {
  const base = draftFromTurns(record);
  if (!draft) return base;
  const given = cleanDoc(draft);
  const merged = emptyDoc();
  for (const field of DOC_FIELDS) merged[field] = given[field] || base[field];
  merged.notDoing = given.notDoing.length > 0 ? given.notDoing : base.notDoing;
  merged.undecided = cleanList([...base.undecided, ...given.undecided]);
  return merged;
}

// 問いを 1 つだけにする(1 度に 1 つ聞く)。文に分け、最初の問いの文を返す。問いの文がなければ最初の文を返す
export function singleQuestion(text) {
  const sentences = clip(text, MAX_ITEM).match(/[^??。]+[??。]?/g)?.map((sentence) => sentence.trim()).filter(Boolean) ?? [];
  return sentences.find((sentence) => /(?:[??]|か。)$/.test(sentence)) ?? sentences[0] ?? '';
}

function nextFixed(turns) {
  const asked = new Set(turns.map((turn) => turn.field));
  return FIXED_QUESTIONS.find((item) => !asked.has(item.field)) ?? null;
}

// 文書の項目が空なら、決めていないことに足す。前に足した文は消してから作り直す
function withUnwritten(doc) {
  const kept = doc.undecided.filter((item) => !UNWRITTEN_PATTERN.test(item));
  const missing = DOC_FIELDS.filter((field) => !doc[field]).map((field) => unwritten(FIELD_LABELS[field]));
  return { ...doc, undecided: cleanList([...kept, ...missing]) };
}

// 新しい試作品の最初の中身。依頼を受けるまでの置き場で、利用者の文は入れない(タイトルと意図は目録にだけ書く)
const STARTER_MAIN = `import { createRoot } from 'react-dom/client';

function App() {
  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', padding: '2rem', lineHeight: 1.6 }}>
      <h1>新しい試作品</h1>
      <p>まだ中身はありません。右の「言葉で直す」で、作りたいものを頼んでください。</p>
    </main>
  );
}

createRoot(document.getElementById('root')).render(<App />);
`;

function titleOf(sentence) {
  const line = sentence.replace(/\s+/g, ' ').trim();
  return line.length > MAX_TITLE ? `${line.slice(0, MAX_TITLE)}…` : line;
}

// 1 文から新しい試作品を作る。app/ の中身は Studio が書く最初の置き場だけ
export async function createStarterProject(home, sentence) {
  const id = `idea-${crypto.randomBytes(4).toString('hex')}`;
  const paths = projectPaths(home, id);
  await fs.mkdir(paths.app, { recursive: true });
  await fs.mkdir(paths.studio, { recursive: true });
  const title = titleOf(sentence);
  const manifest = {
    formatVersion: 1,
    title,
    entry: 'main.jsx',
    intent: { purpose: sentence.slice(0, 1000) },
    constraints: ['データはすべて架空'],
  };
  await fs.writeFile(path.join(paths.app, 'prototype.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  await fs.writeFile(path.join(paths.app, 'main.jsx'), STARTER_MAIN);
  await fs.writeFile(paths.meta, `${JSON.stringify({ title }, null, 2)}\n`);
  return id;
}

// 聞き出しの状態。ファイルに書いたものを起動のときに読み、以降はメモリーとファイルの両方を直す。
// ai は聞き出す AI の接続(intent-ai.js)。consent は本物の AI を使う前の同意(real-ai.js)。
// aiMode() は 'fake'(偽接続。同意なし)、'real'(同意が要る)、null(使えない。決まった問いで進める)のどれか
export class ProjectIntents {
  // otherWork() は、ほかに続きのある作業(整理の板)があるか。あれば、はじめの画面を出さない
  constructor({ home, store, ai, consent, aiMode, startScreen = true, otherWork = () => false, log = () => {} }) {
    this.home = home;
    this.store = store;
    this.ai = ai;
    this.consent = consent;
    this.aiMode = aiMode;
    this.startScreen = startScreen;
    this.otherWork = otherWork;
    this.log = log;
    this.records = new Map();
    // 応答を待っている試作品ごとの AbortController
    this.calling = new Map();
    // 書き換えの途中の試作品。同じ試作品の書き換えは 1 つずつ(前の状態を元に書き戻して、後の変更を消さないため)
    this.locked = new Set();
    this.startDismissed = false;
    this.closed = false;
  }

  file(id) {
    return path.join(projectPaths(this.home, id).studio, INTENT_FILE);
  }

  // 起動のときに読む。壊れたファイルは「目的なし」として扱う(消さない)
  async load() {
    for (const project of await listProjects(this.home)) {
      try {
        const record = JSON.parse(await fs.readFile(this.file(project.id), 'utf8'));
        if (record?.formatVersion !== FORMAT || typeof record.status !== 'string') continue;
        // 最初の問いを待つ間に止まったときは、決まった問いから続ける
        if (record.status === 'interviewing' && !record.pending) {
          record.pending = nextFixed(record.turns) ?? null;
          record.guide = 'fixed';
          record.note = '前の起動で問いを受け取れなかったので、決まった順に聞きます。';
          if (!record.pending) record.status = 'draft';
        }
        this.records.set(project.id, record);
      } catch (error) {
        if (error.code !== 'ENOENT') this.log(`目的の文書を読めませんでした: ${project.id}(${error.message})`);
      }
    }
  }

  async write(id, record) {
    // 止めた後に返ってきた呼び出しは書かない(置き場が消されていても、作り直さない)
    if (this.closed) return;
    const file = this.file(id);
    record.updatedAt = new Date().toISOString();
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    await fs.writeFile(tmp, `${JSON.stringify(record, null, 2)}\n`);
    await fs.rename(tmp, file);
    this.records.set(id, record);
  }

  // 一覧に載せる短い形。文書がなければ none(画面の「目的なし」)
  summary(id) {
    const record = this.records.get(id);
    return { status: record?.status ?? 'none', decidedAt: record?.decidedAt ?? null, updatedAt: record?.updatedAt ?? null };
  }

  // はじめの画面を出すか。出さない設定か、閉じたか、文書か整理の板のある試作品があれば出さない
  startState() {
    return { show: this.startScreen && !this.startDismissed && this.records.size === 0 && !this.otherWork() };
  }

  dismissStart() {
    this.startDismissed = true;
    return this.startState();
  }

  async view(id) {
    await this.requireProject(id);
    return this.viewOf(id);
  }

  // thinking は、問いを考えている最中か(読み込み直した画面が、古い問いに答えないように)
  viewOf(id) {
    const record = this.records.get(id);
    if (!record) return { status: 'none', thinking: false };
    const { formatVersion, ...rest } = record;
    return { ...rest, limit: DEPTHS[record.depth]?.limit ?? null, depthLabel: DEPTHS[record.depth]?.label ?? null, thinking: this.calling.has(id) };
  }

  async requireProject(id) {
    if (!isValidProjectId(id)) throw new NotFoundError(`プロジェクトがありません: ${id}`);
    return this.store.requireProject(id);
  }

  // 書き換えを 1 つずつにする。動いている間に来た書き換えは断る
  async exclusive(id, work) {
    await this.requireProject(id);
    if (this.locked.has(id)) throw new BusyError(this.calling.has(id) ? '問いを考えているところです。終わるか止めるまで待ってください' : '前の操作の途中です。終わるまで待ってください');
    this.locked.add(id);
    try {
      await work();
      return this.viewOf(id);
    } finally {
      this.locked.delete(id);
    }
  }

  // 本物の AI を使うなら、呼ぶ前に同意を確かめる。同意の前は投げる(consent-required)
  requireConsent(guide) {
    if (guide !== 'ai' && guide !== 'fixed') throw new IntentError(400, 'invalid', 'guide は ai か fixed です');
    if (guide === 'ai' && this.aiMode() === 'real') this.consent.require('intent');
  }

  // 今、聞き出す AI を呼んでよいか。偽接続か、本物で同意の後だけ。保存した聞き出しを続けるときも、ここで確かめる
  mayCallAi() {
    const mode = this.aiMode();
    return mode === 'fake' || (mode === 'real' && this.consent.agreed);
  }

  validSentence(value) {
    const sentence = clip(value, MAX_SENTENCE + 1);
    if (!sentence) throw new IntentError(400, 'invalid', '作りたいものを 1 文で書いてください');
    if (sentence.length > MAX_SENTENCE) throw new IntentError(400, 'invalid', `1 文は ${MAX_SENTENCE} 文字までにしてください`);
    return sentence;
  }

  // 1 文から新しい試作品を作る。同意の前に断り、試作品を残さない
  async createProject({ sentence, guide = 'ai' }) {
    const text = this.validSentence(sentence);
    this.requireConsent(guide);
    await fs.mkdir(projectsDir(this.home), { recursive: true });
    const id = await createStarterProject(this.home, text);
    await this.store.build(id);
    return id;
  }

  // 聞き出しを始める(もう一度聞くときも、ここから)。最初の問いを必ず 1 つ返す
  async start(id, { sentence, depth = DEFAULT_DEPTH, guide = 'ai' }) {
    return this.exclusive(id, async () => {
      const text = this.validSentence(sentence);
      if (typeof depth !== 'string' || !Object.hasOwn(DEPTHS, depth)) throw new IntentError(400, 'invalid', `案内の深さは ${Object.keys(DEPTHS).join('、')} のどれかです`);
      this.requireConsent(guide);
      const record = {
        formatVersion: FORMAT,
        status: 'interviewing',
        sentence: text,
        depth,
        guide: guide === 'ai' && this.aiMode() ? 'ai' : 'fixed',
        turns: [],
        pending: null,
        doc: emptyDoc(),
        note: guide === 'ai' && !this.aiMode() ? 'AI を使えないので、決まった順に聞きます。' : null,
        decidedAt: null,
        skippedAt: null,
      };
      // 問いを待つ前に書く。待つ間に読み込み直しても、この試作品の聞き出しに戻れるように
      await this.write(id, record);
      await this.step(id, record);
    });
  }

  // 答える。answer の文か、unknown: true(「分からない」)。
  // turn は答える問いの番号(これまでに答えた数)。別の画面で先に進んでいたら断り、答えが別の問いに付かないようにする
  async answer(id, { answer, unknown = false, turn }) {
    return this.exclusive(id, async () => {
      const record = this.requireRecord(id);
      if (record.status !== 'interviewing' || !record.pending) throw new IntentError(409, 'not-asking', '今は聞いている問いがありません');
      if (turn !== undefined && turn !== record.turns.length) throw new IntentError(409, 'stale-question', '問いが先に進んでいます。今の問いを確かめてから答えてください');
      const text = clip(answer, MAX_ANSWER);
      const isUnknown = unknown === true || UNKNOWN_ANSWER.test(text);
      if (!isUnknown && !text) throw new IntentError(400, 'invalid', '答えを書くか、「分からない」を押してください');
      const next = { ...record, turns: [...record.turns, { ...record.pending, answer: isUnknown ? '' : text, unknown: isUnknown }], pending: null, note: null };
      await this.step(id, next);
    });
  }

  // 次の問いと下書きを作って書く。上限はここで数える
  async step(id, record) {
    const { limit, label } = DEPTHS[record.depth];
    const remaining = limit - record.turns.length;
    let aiOutput = null;
    if (record.guide === 'ai') {
      // 起動し直して同意が消えた後、本物の AI を止めた設定や使えない接続で続けるときは、呼ばずに決まった問いにする
      if (this.mayCallAi()) {
        aiOutput = await this.callAi(id, record, { label, remaining });
      } else {
        record.guide = 'fixed';
        record.note = '今は AI を呼べないので、ここからは決まった順に聞きます。';
      }
    }
    record.doc = mergeDraft(record, aiOutput?.draft ?? null);
    let pending = null;
    if (remaining > 0) {
      const question = aiOutput ? singleQuestion(aiOutput.question) : '';
      const asked = record.turns.some((turn) => turn.question === question);
      if (question && !asked) {
        pending = { question, reason: clip(aiOutput.reason, MAX_ITEM), field: Object.hasOwn(FIELD_LABELS, aiOutput.about) && aiOutput.about !== 'undecided' ? aiOutput.about : 'problem' };
      } else if (!aiOutput || record.turns.length === 0) {
        // AI を使わないとき、AI の返事を使えないとき、最初に問いを返さなかったとき(最初の 1 問は必ず返す)
        const fixed = nextFixed(record.turns);
        pending = fixed ? { ...fixed } : null;
      }
    }
    record.pending = pending;
    record.status = pending ? 'interviewing' : 'draft';
    await this.write(id, record);
  }

  // AI に 1 回聞く。止めたときと失敗したときは、残りを決まった問いに切り替える(飛ばす道を残し、同じ失敗を繰り返さない)
  async callAi(id, record, { label, remaining }) {
    const controller = new AbortController();
    this.calling.set(id, controller);
    try {
      return await this.ai.next({
        sentence: record.sentence,
        turns: record.turns,
        doc: mergeDraft(record, null),
        depthLabel: label,
        remaining,
        signal: controller.signal,
      });
    } catch (error) {
      this.log(`聞き出す AI の返事を使えませんでした: ${id}(${error.code ?? 'failed'})`);
      record.guide = 'fixed';
      record.note = error.code === 'cancelled' ? '止めました。ここからは決まった順に聞きます。' : 'AI の返事を使えなかったので、ここからは決まった順に聞きます。';
      return null;
    } finally {
      this.calling.delete(id);
    }
  }

  // 応答を待つのをやめる。呼んだ側には、決まった問いで返る
  cancel(id) {
    const controller = this.calling.get(id);
    if (!controller) return false;
    controller.abort();
    return true;
  }

  requireRecord(id) {
    const record = this.records.get(id);
    if (!record) throw new IntentError(409, 'not-started', 'まだ聞き出しを始めていません');
    return record;
  }

  // 問いを打ち切って、ここまでの下書きを文書にする
  async finish(id) {
    return this.exclusive(id, async () => {
      const record = this.requireRecord(id);
      if (record.status !== 'interviewing') throw new IntentError(409, 'not-asking', '今は聞いている問いがありません');
      await this.write(id, { ...record, pending: null, status: 'draft', note: null });
    });
  }

  // 文書を直す。決めた後に直すと「決めた」の印を外す(もう一度押す)
  async edit(id, { doc }) {
    return this.exclusive(id, async () => {
      requireDocShape(doc);
      const record = this.requireRecord(id);
      await this.write(id, { ...record, doc: cleanDoc(doc ?? record.doc), pending: null, status: 'draft', decidedAt: null, skippedAt: null, note: null });
    });
  }

  // 人が「これで決める」を押したときだけ呼ぶ。「決めた」の印を付ける唯一の所
  async decide(id, { doc }) {
    return this.exclusive(id, async () => {
      requireDocShape(doc);
      const record = this.requireRecord(id);
      const decided = withUnwritten(cleanDoc(doc ?? record.doc));
      await this.write(id, { ...record, doc: decided, pending: null, status: 'decided', decidedAt: new Date().toISOString(), skippedAt: null, note: null });
    });
  }

  // 飛ばす。飛ばしたことを文書に残す。画面の印は「目的なし」
  async skip(id, { sentence } = {}) {
    return this.exclusive(id, async () => {
      const record = this.records.get(id) ?? {
        formatVersion: FORMAT,
        sentence: clip(sentence, MAX_SENTENCE),
        depth: null,
        guide: 'fixed',
        turns: [],
        doc: emptyDoc(),
      };
      await this.write(id, { ...record, pending: null, status: 'skipped', decidedAt: null, skippedAt: new Date().toISOString(), note: null });
    });
  }

  async close() {
    this.closed = true;
    for (const controller of this.calling.values()) controller.abort();
    await this.ai.close();
  }
}
