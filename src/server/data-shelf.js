import fs from 'node:fs';
import { findRecords } from './redact.js';
import { SAMPLE_ROWS } from './data-design.js';

// データの棚と RAG の判定(docs/design/ai-architecture-review.md の 1 節「データと RAG」、task 421)。
// 棚は、AI が何をどう読むかを、データごとに 1 行で見せる。データ設計(K2)の案か、試作品のツールとデータから下書きを作る。
// RAG の判定は、棚の読み方を簡単な方から順に問い、足りたら止まって「要らない」と書く。問いの文と足す条件は
// src/server/review/options.json のデータ(作る AI が書き換えられない所。5 節)。数の上限は決めず、場面が通るかで決める。

const OPTIONS = JSON.parse(fs.readFileSync(new URL('./review/options.json', import.meta.url), 'utf8'));
export const RAG_OPTIONS = OPTIONS.rag;

// 棚の項目の語。増やせるのは Studio のコードだけ
export const SHELF_SHAPES = { table: '表', rules: '短い決まり', document: '長い文書' };
export const SHELF_READS = { tool: 'ツールで引く', prompt: 'プロンプトに入れる', rag: 'RAG(文書を探して読む)', none: '使わない' };
export const SHELF_CHANGES = { minutes: '毎分', daily: '毎日', rarely: '年に数回', unknown: 'まだ決めていない' };
export const SHELF_SOURCES = { 'data-design': 'データ設計', board: '整理の板', app: '試作品のツールとデータ' };
export const SHELF_LIMITS = { maxItems: 50, maxName: 60, maxPrototype: 100, maxKinds: 10 };
const SHELF_KEYS = ['id', 'name', 'shape', 'read', 'change', 'personal', 'personalKinds', 'prototype', 'source', 'tools'];
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

// 判定の答え。needed は true(要る)、false(要らない)、null(まだ決めていない)
export const RAG_VERDICTS = { true: '要る', false: '要らない', null: 'まだ決めていない' };

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const clip = (value, max) => String(value ?? '').trim().replace(/\s+/g, ' ').slice(0, max);

// 棚の形の検査。問題の文の一覧を返す(空なら正しい形)。RAG で読むのは長い文書だけ
export function shelfProblems(shelf) {
  if (!Array.isArray(shelf)) return ['棚は配列にしてください'];
  const problems = [];
  if (shelf.length > SHELF_LIMITS.maxItems) problems.push(`棚のデータは ${SHELF_LIMITS.maxItems} 個までです`);
  const ids = new Set();
  for (const [i, item] of shelf.entries()) {
    const at = `棚の ${i + 1} 番目`;
    if (!isPlainObject(item)) {
      problems.push(`${at}: { "id": …, "name": …, … } の形にしてください`);
      continue;
    }
    for (const key of Object.keys(item)) if (!SHELF_KEYS.includes(key)) problems.push(`${at}: 「${key}」は書けません`);
    if (typeof item.id !== 'string' || !ID_PATTERN.test(item.id)) problems.push(`${at}: id は英数字で始め、英数字と _ と - だけで 64 字までにしてください`);
    else if (ids.has(item.id)) problems.push(`${at}: id「${item.id}」が重なっています`);
    else ids.add(item.id);
    if (typeof item.name !== 'string' || item.name.trim() === '' || item.name.length > SHELF_LIMITS.maxName) problems.push(`${at}: 名前は ${SHELF_LIMITS.maxName} 文字までの文にしてください`);
    for (const [key, words, label] of [['shape', SHELF_SHAPES, '形'], ['read', SHELF_READS, 'AI の読み方'], ['change', SHELF_CHANGES, '変わる速さ'], ['source', SHELF_SOURCES, '元']]) {
      if (!Object.hasOwn(words, item[key])) problems.push(`${at}: ${label}は ${Object.keys(words).join('、')} のどれかにしてください`);
    }
    if (item.personal !== true && item.personal !== false && item.personal !== null) problems.push(`${at}: 個人情報は true、false、null(不明)のどれかにしてください`);
    if (item.personalKinds !== undefined) {
      const kinds = item.personalKinds;
      if (!Array.isArray(kinds) || kinds.length > SHELF_LIMITS.maxKinds || kinds.some((kind) => typeof kind !== 'string' || kind === '')) problems.push(`${at}: 個人情報の種類は文の配列にしてください`);
      else if (kinds.length > 0 && item.personal !== true) problems.push(`${at}: 個人情報の種類を書くなら、個人情報は true にしてください`);
    }
    if (typeof item.prototype !== 'string' || item.prototype.trim() === '' || item.prototype.length > SHELF_LIMITS.maxPrototype) problems.push(`${at}: 試作品での扱いは ${SHELF_LIMITS.maxPrototype} 文字までの文にしてください`);
    if (item.read === 'rag' && item.shape !== 'document') problems.push(`${at}: RAG で読めるのは長い文書だけです`);
    // そのデータを読むツールの名前(審査の画面で出す。#426)。書かなければ、まだ調べていない
    if (item.tools !== undefined && (!Array.isArray(item.tools) || item.tools.some((name) => typeof name !== 'string' || name === ''))) problems.push(`${at}: ツールは名前の配列にしてください`);
  }
  return problems;
}

// 個人情報らしい項目の名前(推測)。お店や商品の「名前」は個人情報としないので、名前は人らしい表のときだけ
const PERSONAL_WORDS = [['氏名', '氏名'], ['お名前', '氏名'], ['電話', '電話番号'], ['住所', '住所'], ['メール', 'メールアドレス'], ['生年月日', '生年月日'], ['連絡先', '連絡先'], ['届け先', '届け先'], ['宛名', '宛名']];
const PERSON_TABLE = /客|者|人|会員|さん|生徒|患者|利用/;

function personalOfEntity(entity) {
  const kinds = new Set();
  const person = PERSON_TABLE.test(entity?.name ?? '');
  for (const field of entity?.fields ?? []) {
    const name = String(field?.name ?? '');
    for (const [word, kind] of PERSONAL_WORDS) if (name.includes(word)) kinds.add(kind);
    if (person && name.includes('名前')) kinds.add('氏名');
  }
  // 見当たらなければ「不明」。ないと言い切らない(推測なので、人が確かめる)
  return kinds.size > 0 ? { personal: true, personalKinds: [...kinds] } : { personal: null };
}

// 整理の板の項目のうち、長い文書らしいもの(約款、手引きなど。言葉は options.json の documentWords)
export const looksLikeDocument = (text) => RAG_OPTIONS.documentWords.some((word) => String(text ?? '').normalize('NFKC').includes(word));

// データ設計(K2)の選んだ案と整理の板から、棚の下書きを作る。
// 覚えておくもの(表)はツールで引く。整理の板の決まりごとは、短い決まりとしてプロンプトに入れる。
// 整理の板のデータの欄で長い文書らしいもの(約款など)は、長い文書として RAG の候補にする。変わる速さは人が決める
export function shelfFromDataDesign(option, board = []) {
  const items = Array.isArray(board) ? board : [];
  const shelf = (option?.entities ?? []).map((entity, i) => ({
    id: `table-${i + 1}`,
    name: clip(entity.name, SHELF_LIMITS.maxName) || `表 ${i + 1}`,
    shape: 'table',
    read: 'tool',
    change: 'unknown',
    ...personalOfEntity(entity),
    prototype: `架空の ${SAMPLE_ROWS} 件`,
    source: 'data-design',
  }));
  const rules = items.filter((item) => item?.column === 'rule' && typeof item.text === 'string');
  if (rules.length > 0) {
    shelf.push({
      id: 'rules',
      name: '整理の板の決まりごと',
      shape: 'rules',
      read: 'prompt',
      change: 'unknown',
      // 記録らしいものがあれば「あり」。なくても「ない」と言い切らず「不明」にする
      ...(rules.some((item) => findRecords(item.text).length > 0) ? { personal: true } : { personal: null }),
      prototype: `決まりごと ${rules.length} つを、そのまま入れる`,
      source: 'board',
    });
  }
  const documents = items.filter((item) => item?.column === 'data' && typeof item.text === 'string' && looksLikeDocument(item.text));
  for (const [i, item] of documents.entries()) {
    shelf.push({
      id: `document-${i + 1}`,
      name: clip(item.text, SHELF_LIMITS.maxName),
      shape: 'document',
      read: 'rag',
      change: 'unknown',
      personal: null,
      prototype: '架空の文書を、条や見出しごとに作る',
      source: 'board',
    });
  }
  return shelf;
}

// 試作品のツールとデータから、棚の下書きを作る(場面の回しの報告で使う)。
// toolsets は { tools.json の名前: 検査した宣言 }、toolData は { tools.json の名前: { データのファイル: 値 } }、manifestData は目録の data
export function shelfFromApp({ toolsets = {}, toolData = {}, manifestData = [] } = {}) {
  const files = new Map();
  for (const [toolsFile, toolset] of Object.entries(toolsets)) {
    for (const tool of toolset?.tools ?? []) {
      const file = tool.do?.data;
      if (typeof file !== 'string') continue;
      const entry = files.get(file) ?? { ops: new Set(), hidden: new Set(), tools: new Set(), value: toolData[toolsFile]?.[file] };
      entry.ops.add(tool.do.op);
      entry.tools.add(tool.name);
      for (const field of tool.guards?.hideFields ?? []) entry.hidden.add(field);
      files.set(file, entry);
    }
  }
  const about = new Map((manifestData ?? []).map((item) => [item.file, item.about]));
  const shelf = [];
  const idOf = (file, i) => {
    const base = file.replace(/^.*\//, '').replace(/\.json$/, '').replace(/[^A-Za-z0-9_-]/g, '-').replace(/^[^A-Za-z0-9]+/, '').slice(0, 56);
    return `${base || 'data'}-${i + 1}`;
  };
  for (const [file, entry] of [...files].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const document = entry.ops.has('retrieve');
    const table = entry.ops.has('search') || entry.ops.has('get');
    const count = Array.isArray(entry.value) ? entry.value.length : null;
    shelf.push({
      id: idOf(file, shelf.length),
      name: clip(about.get(file) ?? file, SHELF_LIMITS.maxName),
      shape: document ? 'document' : table ? 'table' : 'rules',
      read: document ? 'rag' : 'tool',
      change: 'unknown',
      ...(entry.hidden.size > 0 ? { personal: true, personalKinds: [...entry.hidden] } : { personal: null }),
      prototype: count === null ? '架空の決まった値' : document ? `架空の文書 ${count} 件` : `架空の ${count} 件`,
      source: 'app',
      tools: [...entry.tools].sort(),
    });
  }
  // 目録のデータのうち、ツールが読まないもの(画面だけが使う)。AI は読まない
  for (const item of manifestData ?? []) {
    if (files.has(item.file)) continue;
    shelf.push({ id: idOf(item.file, shelf.length), name: clip(item.about ?? item.file, SHELF_LIMITS.maxName), shape: 'table', read: 'none', change: 'unknown', personal: null, prototype: '画面だけが使う架空のデータ', source: 'app', tools: [] });
  }
  return shelf;
}

// 文書の検索のない構成の確かめの n/a の理由(eval-run.js の judgeCheck と同じ文)
const NO_RETRIEVAL = 'この構成には文書の検索がない';

// 場面の回しの結果(eval-run.js の result)から、RAG の判定の根拠を取り出す。
// 文書の検索の確かめ(retrieved、cited)のある場面だけを見る。RAG ありの組は、その確かめの合否が決まった組。
// RAG なしの組は、その確かめが「この構成には文書の検索がない」で n/a の組
export function ragEvidenceOf(result) {
  const retrievalScenes = new Set();
  const withRag = new Map();
  const withoutRag = new Map();
  for (const group of result?.groups ?? []) {
    for (const e of group.evals ?? []) {
      const checks = (e.checks ?? []).filter((c) => c.check === 'retrieved' || c.check === 'cited');
      if (checks.length === 0) continue;
      retrievalScenes.add(e.id);
      const decided = checks.some((c) => c.verdict === 'passed' || c.verdict === 'failed');
      const target = decided ? withRag : checks.every((c) => c.verdict === 'n/a' && c.reason === NO_RETRIEVAL) ? withoutRag : null;
      if (!target || !['passed', 'failed'].includes(e.verdict)) continue;
      // 同じ場面を何度も回したら、1 回でも通らなければ通らないとみなす
      target.set(e.id, target.get(e.id) === 'failed' ? 'failed' : e.verdict);
    }
  }
  if (withRag.size === 0 || withoutRag.size === 0) return null;
  const ids = [...retrievalScenes].sort();
  return {
    failedWithout: ids.filter((id) => withoutRag.get(id) === 'failed'),
    passedWith: ids.filter((id) => withRag.get(id) === 'passed'),
    measuredAt: result.finishedAt ?? result.startedAt ?? null,
    connections: result.options?.connections ?? [],
  };
}

// RAG の判定。棚の読み方を簡単な方から順に問い(options.json の questions)、足りたら止まる。
// evidence は ragEvidenceOf の値(RAG ありとなしの両方を回したとき)。なければ「まだ測っていない」の推測。
// 返す: { needed, verdict, reason, addWhen?, evalIds?, decide?, steps, measured, note }
export function judgeRag(shelf, { evidence = null } = {}) {
  const items = Array.isArray(shelf) ? shelf : [];
  const names = (read) => items.filter((item) => item.read === read).map((item) => item.name);
  const documents = names('rag');
  const steps = RAG_OPTIONS.questions.map((q) => ({ order: q.order, question: q.question, read: q.read, items: names(q.read) }));
  const decide = RAG_OPTIONS.decide.map(({ id, label, question, prototype }) => ({ id, label, question, prototype }));
  // モックの回しは形の確かめだけ(4 節の「数の読み方」)。本物の AI で回したときだけ、そう書く
  const real = (evidence?.connections ?? []).some((kind) => kind !== 'mock');
  const note = !evidence ? '今日の推測。まだ測っていない' : real ? '本物の AI で場面を回して比べた結果' : 'お試しの AI で場面を回して比べた結果。形の確かめだけで、振る舞いの差は本物の AI で測る';
  const done = (fields) => ({ ...fields, verdict: RAG_VERDICTS[String(fields.needed)], steps, measured: Boolean(evidence), note });

  if (documents.length === 0) {
    const read = [...new Set(items.filter((item) => item.read !== 'none').map((item) => SHELF_SHAPES[item.shape]))];
    const reason = read.length === 0
      ? 'AI が読むデータがない。RAG で探す文書もない'
      : `AI が読むのは${read.join('と')}だけ。${[names('tool').length > 0 ? '表はツールで引ける' : null, names('prompt').length > 0 ? '決まりは短いのでプロンプトに入れられる' : null].filter(Boolean).join('。') || 'ツールかプロンプトで足りる'}`;
    return done({ needed: false, reason, addWhen: RAG_OPTIONS.addWhen });
  }
  if (evidence) {
    const helped = evidence.failedWithout.filter((id) => evidence.passedWith.includes(id));
    if (helped.length > 0) {
      return done({ needed: true, reason: `RAG なしでは通らない場面が ${helped.length} つあり、RAG ありで通った`, evalIds: helped, decide });
    }
    if (evidence.failedWithout.length === 0) {
      return done({ needed: false, reason: `長い文書(${documents.join('、')})はあるが、RAG なしでも文書を読む場面が通った`, addWhen: RAG_OPTIONS.addWhen });
    }
    return done({ needed: null, reason: 'RAG を足しても通らない場面がある。場面か文書を見直す', evalIds: evidence.failedWithout, decide });
  }
  return done({ needed: null, reason: `長い文書(${documents.join('、')})がある。RAG なしの形で場面が通るかを測ってから決める`, decide });
}

// 場面の回しの報告(report.md)に足す節。棚と判定を表で出す
export function renderShelfSection({ shelf, rag }) {
  const cell = (value) => String(value ?? '').replace(/\r\n|[\r\n]/g, ' / ').replace(/\|/g, '\\|');
  const personal = (item) => (item.personal === true ? `あり${item.personalKinds?.length ? `(${item.personalKinds.join('、')})` : ''}` : item.personal === false ? 'なし' : '不明');
  const lines = [
    '## データの棚と RAG の判定',
    '',
    '| データ | 形 | AI の読み方 | 変わる速さ | 個人情報 | 試作品での扱い |',
    '|---|---|---|---|---|---|',
    ...shelf.map((item) => `| ${cell(item.name)} | ${SHELF_SHAPES[item.shape]} | ${SHELF_READS[item.read]} | ${SHELF_CHANGES[item.change]} | ${personal(item)} | ${cell(item.prototype)} |`),
    '',
    `- RAG: ${rag.verdict}(${rag.note})`,
    `- 理由: ${cell(rag.reason)}`,
  ];
  if (rag.evalIds?.length) lines.push(`- 根拠の場面: ${rag.evalIds.map((id) => `\`${id}\``).join('、')}`);
  if (rag.addWhen) lines.push(`- 足す条件: ${cell(rag.addWhen)}`);
  if (rag.decide) {
    lines.push('', '| 足すなら決めること | 問い | 試作品でしたこと |', '|---|---|---|', ...rag.decide.map((d) => `| ${d.label} | ${cell(d.question)} | ${cell(d.prototype)} |`));
  }
  lines.push('');
  return lines.join('\n');
}
