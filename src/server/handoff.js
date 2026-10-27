import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ALLOWED_PACKAGES, buildApp } from './build.js';
import { STUDIO_ROOT } from './config.js';
import { VersionError, copyTree } from './versions.js';
import { responseSchema, systemPrompt } from './product-ai/claude-code.js';
import { formatValue } from './product-ai/definition.js';
import { findPersonalData, findSecrets, redact, redactDeep } from './redact.js';
import { BusyError } from './store.js';

// 本番開発への引き継ぎ(#280)。試作品のソース、意図、AI の設定、モックと状態、未接続と未決事項を、
// 1 つのフォルダーに書き出す。中身は決まった手順で作り、AI の判断は入れない(ADR-0001、Stripe の Minions)。
// 形は docs/handoff.md に書く。標準化は仮で、使われ方を見て直す。

export const HANDOFF_FORMAT = 'prototype-studio-handoff';
export const HANDOFF_FORMAT_VERSION = 1;
export const MAX_NOTE_LENGTH = 4000;
const NOTE_KEYS = ['purpose', 'decided', 'undecided'];
const NOTES_FILE = 'handoff-notes.json';
const MAX_FINDINGS = 20;

// 秘密を入れるためのファイル。中を見ずに、書き出しから外す
// .env.example のような見本は外さない(中は他のファイルと同じく調べる)
const SECRET_FILES = [/(^|\/)\.env(\.(?!(example|sample|template)$)[^/]*)?$/i, /\.(pem|key|p12|pfx)$/i, /(^|\/)id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i, /(^|\/)\.netrc$/i];
const CODE_FILE = /\.(jsx?|tsx?|mjs|cjs|html?)$/i;
// 試作品の中では動かないが、本番では何かにつなぐ必要があるコード
const CODE_SIGNS = [
  [/\bfetch\s*\(|\bXMLHttpRequest\b|\bWebSocket\b|\bEventSource\b|\bsendBeacon\b/, 'network'],
  [/\b(localStorage|sessionStorage|indexedDB)\b/, 'storage'],
  [/\b(TODO|FIXME)\b|未実装|仮実装/, 'todo'],
];
// 架空のデータを置いたファイルの手がかり(推定)
const DATA_NAME = /(^|[/._-])(data|mock|mocks|fixture|fixtures|sample|samples|seed|dummy|fake)([/._-]|$)/i;
const EXPORTED_LIST = /export\s+const\s+[A-Za-z_$][\w$]*\s*=\s*\[/;

export class HandoffError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function cleanNotes(raw) {
  const notes = {};
  for (const key of NOTE_KEYS) {
    const value = raw?.[key];
    if (value === undefined || value === null) {
      notes[key] = '';
      continue;
    }
    if (typeof value !== 'string') throw new HandoffError(400, 'invalid', '引き継ぎのメモは文字で書いてください');
    // 改行とタブは残し、ほかの制御文字は消す
    const cleaned = value.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim();
    if (cleaned.length > MAX_NOTE_LENGTH) throw new HandoffError(400, 'invalid', `引き継ぎのメモは、1 つの欄で ${MAX_NOTE_LENGTH} 文字までにしてください`);
    notes[key] = cleaned;
  }
  return notes;
}

const pad = (n) => String(n).padStart(2, '0');
function stamp(date) {
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

async function studioVersion() {
  try {
    return JSON.parse(await fs.readFile(path.join(STUDIO_ROOT, 'package.json'), 'utf8')).version ?? null;
  } catch {
    return null;
  }
}

// 写した app/ のファイルを読み、秘密、個人のデータらしいもの、本番でつなぐ必要があるコード、架空のデータの手がかりを探す
async function scanFiles(appDir) {
  const files = [];
  const secrets = [];
  const personal = [];
  const signs = { network: [], storage: [], todo: [] };
  const dataFiles = [];
  async function walk(dir) {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      const shown = `app/${path.relative(appDir, full).split(path.sep).join('/')}`;
      const content = await fs.readFile(full);
      files.push({ path: shown, bytes: content.length, sha256: crypto.createHash('sha256').update(content).digest('hex') });
      // 画像などの中も、秘密の形だけは探す。行の番号は目安になる
      if (content.includes(0)) {
        for (const found of findSecrets(content.toString('latin1'))) secrets.push({ file: shown, ...found });
        continue;
      }
      const text = content.toString('utf8');
      for (const found of findSecrets(text)) secrets.push({ file: shown, ...found });
      for (const found of findPersonalData(text)) personal.push({ file: shown, ...found });
      if (CODE_FILE.test(entry.name)) {
        text.split(/\r?\n/).forEach((line, index) => {
          for (const [pattern, kind] of CODE_SIGNS) {
            if (pattern.test(line)) signs[kind].push({ file: shown, line: index + 1, text: redact(line.trim()).slice(0, 120) });
          }
        });
        if (DATA_NAME.test(shown.slice('app/'.length)) || (text.includes('架空') && EXPORTED_LIST.test(text))) dataFiles.push(shown);
      } else if (/\.json$/i.test(entry.name) && DATA_NAME.test(shown.slice('app/'.length))) {
        dataFiles.push(shown);
      }
    }
  }
  await walk(appDir);
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { files, secrets, personal, signs, dataFiles: dataFiles.sort() };
}

const where = (found) => `${found.file}:${found.line}`;
const listWhere = (list) => {
  const shown = list.slice(0, MAX_FINDINGS).map(where).join('、');
  return list.length > MAX_FINDINGS ? `${shown} ほか ${list.length - MAX_FINDINGS} か所` : shown;
};

// 会話の各発言に、どの接続の応答かと、実際の AI モデルかを付ける
function describeConversation(definition, snapshot, connections) {
  const fresh = {
    state: { ...definition.initialState },
    messages: definition.mock.greeting ? [{ role: 'assistant', text: definition.mock.greeting }] : [],
  };
  const { state, messages } = snapshot ?? fresh;
  return {
    initial: snapshot === null,
    state: definition.fields.map((field) => ({ key: field.key, label: field.label, value: state[field.key] ?? null, shown: formatValue(field, state[field.key]) })),
    messages: messages.map((message, index) => {
      if (message.role !== 'assistant') return redactDeep({ role: message.role, text: message.text });
      // 最初のあいさつは、接続を通さずに設定から出す。ほかに接続のない応答は、#276 より前に保存した版のもの
      const kind = message.via ?? null;
      const connection = kind ? connections.get(kind) : null;
      const greeting = !kind && index === 0 && message.text === definition.mock.greeting;
      return redactDeep({
        role: 'assistant',
        text: message.text,
        via: kind,
        viaLabel: kind ? (connection?.label ?? kind) : greeting ? '設定の固定文(mock.greeting)' : '不明(接続の記録がない)',
        real: Boolean(connection?.billing),
        ...(Number.isFinite(message.elapsedMs) ? { elapsedMs: message.elapsedMs } : {}),
        ...(Number.isFinite(message.costUsd) ? { costUsd: message.costUsd } : {}),
      });
    }),
  };
}

// 実機、モック、未接続の一覧。どの試作品にも出る行と、見つけたものから出る行がある
function capabilities({ fileCount, ai, conversation, scan }) {
  const rows = [];
  const add = (kind, item, prototype, production, evidence = []) => rows.push({ kind, item, prototype, production, evidence });
  const replies = conversation?.messages.filter((m) => m.role === 'assistant' && m.via) ?? [];
  const realReplies = replies.filter((m) => m.real);
  const mockReplies = replies.filter((m) => !m.real);

  add(
    'real',
    '画面と操作',
    `app/ の ${fileCount} 個のファイル。React で書かれ、ブラウザの中で実際に動く。`,
    '本番の技術と設計の決まりに合わせて、作り直すか移す。試作品のコードは、品質、性能、アクセシビリティを確かめていない。',
  );
  if (ai && realReplies.length > 0) {
    const labels = [...new Set(realReplies.map((m) => m.viaLabel))].join('、');
    add(
      'real',
      'プロダクト内 AI(実モデル)',
      `${labels} で ${realReplies.length} 回応答した。会話の記録で「${labels}」と印の付いた応答が、実際の AI モデルの応答。指示は ai/system-prompt.md。`,
      '本番のモデル、鍵の管理、費用の上限、応答の監視を決める。試作品は Claude Code の CLI を本人のログインで動かしていた。',
    );
  }
  if (ai) {
    add(
      'mock',
      'プロダクト内 AI(モック)',
      `Studio の決まった規則で応答する。app/ai.json の keywords が文にあるかで項目を読み取り、mock の文を返す。言い回しは理解しない。この会話のモックの応答: ${mockReplies.length} 回。`,
      '本番では使わない。決まった応答が要るテストの見本にする。',
    );
    add(
      'mock',
      '会話と状態の置き場',
      'Studio のサーバーのメモリーが持ち、試作品は window.studio.ai(session、send、correct、onChange)で呼ぶ。Studio を止めると消える。',
      '本番のサーバーに、会話と状態を持つ API を作る。window.studio.ai の呼び方と、返す形(state、messages)が見本になる。',
    );
  }
  add(
    'mock',
    'データ',
    scan.dataFiles.length > 0
      ? `app/ の中に書いた固定のデータ。架空のデータを置いたファイルの手がかり(推定): ${scan.dataFiles.join('、')}。`
      : 'app/ の中に書いた固定の値と、操作の間だけ画面のメモリーにある値。',
    '本物のデータの出どころ(API、データベース)と、項目の意味を決める。',
    scan.dataFiles,
  );
  add(
    'missing',
    'サーバーと保存',
    scan.signs.storage.length > 0
      ? `試作品にはサーバーもデータベースもない。ブラウザに保存するコードがある(${listWhere(scan.signs.storage)})が、試作品の中では使えない(sandbox)。開き直すと、画面で変えた値は消える。`
      : '試作品にはサーバーもデータベースもない。開き直すと、画面で変えた値は消える。',
    '保存先、保存する項目、消す時期を決めて作る。',
    scan.signs.storage.map(where),
  );
  add(
    'missing',
    '外部の API と通信',
    scan.signs.network.length > 0
      ? `通信するコードがある(${listWhere(scan.signs.network)})が、試作品の通信は CSP(connect-src 'none')で止めているので、届いていない。`
      : '試作品の通信は CSP(connect-src \'none\')で止めている。外部の API にはつないでいない。',
    'つなぐ先、認証、失敗したときの画面を決めて作る。',
    scan.signs.network.map(where),
  );
  add('missing', 'ログインと利用者の区別', '試作品にはない。誰が使っても同じ画面と会話になる。', '認証の方式と、利用者ごとのデータの分け方を決める。');
  if (ai) {
    add(
      'missing',
      'プロダクト内 AI の本番の接続',
      '試作品は、モックか、利用者の PC の Claude Code(CLI)で応答した。本番のサーバーからは呼んでいない。',
      'モデル、鍵の管理、費用の上限、応答の形の検査(ai/response-schema.json)、記録と監視を作る。',
    );
  }
  add('missing', '本物のデータと個人情報', '試作品は架空のデータだけで試す決まり。', '個人情報の扱い、保存の期間、AI の提供元に送ってよい範囲を決める。');
  return rows;
}

// Studio が見つけた、決める必要のあること
function studioQuestions({ ai, conversation, working, scan, excluded }) {
  const questions = [];
  if (ai && !conversation.messages.some((m) => m.real)) {
    questions.push('プロダクト内 AI を実モデルで試していない(会話の応答はモックだけ)。ai.json の instructions どおりに振る舞うかは、確かめていない。');
  }
  const unknown = conversation?.messages.filter((m) => m.role === 'assistant' && !m.via && m.viaLabel.startsWith('不明')).length ?? 0;
  if (unknown > 0) questions.push(`どの接続の応答か記録がない応答が ${unknown} 件ある(古い版から戻した会話)。モックか実モデルかは分からない。`);
  if (ai && conversation.initial) questions.push('プロダクト内 AI と話していない状態で書き出した。会話の記録は最初のあいさつだけ。');
  if (working.files === 'changed') questions.push('保存した版のどれとも違う作業中から書き出した。どの版を本番の基にするか決める。');
  if (working.files === 'none') questions.push('版を保存していない作業中から書き出した。');
  if (scan.personal.length > 0) {
    questions.push(`メールアドレスか電話番号らしいものがある(${listWhere(scan.personal)})。架空のものか確かめる。`);
  }
  if (scan.signs.todo.length > 0) questions.push(`コードに未実装の印がある(${listWhere(scan.signs.todo)})。`);
  if (excluded.length > 0) questions.push(`秘密を入れるファイルを書き出しから外した(${excluded.map((e) => e.path).join('、')})。本番で要る設定か確かめる。`);
  return questions;
}

// 改行は、どの書き方でも 1 行にする。表の行を足されないように
const oneLine = (value) => String(value ?? '').replace(/\r\n|[\r\n\u2028\u2029\u0085]/g, ' / ');
// Markdown の表の 1 マス
const cell = (value) => oneLine(value).replace(/\\/g, '\\\\').replace(/\|/g, '\\|');
// コードとして出す(コードの中では \ を重ねない)。` を含むときは、文字のまま出す
const code = (value) => (String(value).includes('`') ? cell(value) : `\`${oneLine(value).replace(/\|/g, '\\|')}\``);
const KIND_LABELS = { real: '実機', mock: 'モック', missing: '未接続' };
const ROLE_LABELS = { user: '利用者', assistant: 'AI', correction: '利用者の修正' };
const RUN_LABELS = { done: '終わった', failed: '失敗', cancelled: '中断', 'timed-out': '時間切れ', running: '作業中' };
const localTime = (iso) => (iso ? new Date(iso).toLocaleString('ja-JP') : '');

// 書き出した人のメモは引用にする。行頭の # などが見出しにならないように
function noteBlock(text) {
  return text ? text.split('\n').map((line) => (line ? `> ${line}` : '>')).join('\n') : '(書かれていません)';
}

function fieldRule(field) {
  if (field.type === 'number') {
    const range = [field.min !== null ? `${field.min} 以上` : '', field.max !== null ? `${field.max} 以下` : ''].filter(Boolean).join('、');
    return `数${field.unit ? `(単位: ${field.unit})` : ''}${range ? `、${range}` : ''}`;
  }
  return `選択肢: ${field.options.map((o) => o.value).join('、')}`;
}

function renderReadme(h) {
  const lines = [];
  const push = (...items) => lines.push(...items);
  push(
    `# 引き継ぎ: ${oneLine(h.project.title)}`,
    '',
    `Prototype Studio で作った試作品を、本番開発の担当者に渡す資料です。${h.createdAtLocal} に書き出しました。`,
    '試作品は、体験を確かめるためのものです。本番の品質ではありません。',
    '',
    '## 区分の意味',
    '',
    '| 区分 | 意味 |',
    '|---|---|',
    '| 実機 | 試作品の中で、本物が動いている |',
    '| モック | 決まった規則や架空のデータが、本物の代わりをしている |',
    '| 未接続 | 試作品にはない。本番で作る |',
    '',
    '## 目的',
    '',
    noteBlock(h.notes.purpose),
    '',
    '## 決まったこと',
    '',
    noteBlock(h.notes.decided),
    '',
    '## 未決事項',
    '',
    '### 書き出した人が書いたもの',
    '',
    noteBlock(h.notes.undecided),
    '',
    '### Studio が見つけたこと(自動)',
    '',
    ...(h.openQuestions.length > 0 ? h.openQuestions.map((q) => `- ${q}`) : ['(ありません)']),
    '',
    '## 実機・モック・未接続の一覧',
    '',
    '| 区分 | 項目 | 試作品での中身 | 本番でやること |',
    '|---|---|---|---|',
    ...h.capabilities.map((row) => `| ${KIND_LABELS[row.kind]} | ${cell(row.item)} | ${cell(row.prototype)} | ${cell(row.production)} |`),
    '',
  );

  if (h.ai) {
    const { ai } = h;
    push(
      '## プロダクト内 AI',
      '',
      `- 名前: ${oneLine(ai.name)}`,
      `- 書き出したときの接続: ${ai.connection.label}${ai.connection.real ? '(実際の AI モデル)' : '(実際の AI モデルではない)'}`,
      '- 設定: `app/ai.json`',
      '- 実モデルに渡す指示の全文: `ai/system-prompt.md`(ai.json の instructions に、Studio の決まりを足したもの)',
      '- 応答の形(JSON スキーマ): `ai/response-schema.json`',
      '',
      '覚える項目:',
      '',
      '| key | 名前 | 決まり | 最初の値 |',
      '|---|---|---|---|',
      ...ai.fields.map((field) => `| \`${field.key}\` | ${cell(field.label)} | ${cell(fieldRule(field))} | ${cell(formatValue(field, ai.initialState[field.key]))} |`),
      '',
      '## 試した会話と状態',
      '',
      h.conversation.initial
        ? 'まだ話していません。最初の状態です。'
        : `書き出したときの会話です(${h.conversation.messages.length} 件)。「接続」の列で、モックの応答と実際の AI モデルの応答を区別できます。`,
      '',
      '| # | 誰 | 接続 | 内容 |',
      '|---|---|---|---|',
      ...h.conversation.messages.map((m, i) => {
        const via = m.role !== 'assistant' ? '' : `${m.viaLabel}${m.real ? '(実モデル)' : ''}`;
        return `| ${i + 1} | ${ROLE_LABELS[m.role] ?? m.role} | ${cell(via)} | ${cell(m.text)} |`;
      }),
      '',
      'そのときの状態:',
      '',
      '| key | 名前 | 値 |',
      '|---|---|---|',
      ...h.conversation.state.map((s) => `| \`${s.key}\` | ${cell(s.label)} | ${cell(s.shown)} |`),
      '',
    );
  } else {
    push('## プロダクト内 AI', '', 'この試作品は、プロダクト内 AI を使っていません(`app/ai.json` がありません)。', '');
  }

  push(
    '## ソース',
    '',
    `- 入口: ${h.source.entry ? code(h.source.entry) : '(見つかりません)'}`,
    `- 使えるライブラリ: ${h.source.libraries.join('、')}(Studio が同梱するもの。ほかは import できない)`,
    `- 版: ${h.working.text}`,
    '',
    '| ファイル | バイト |',
    '|---|---|',
    ...h.source.files.map((f) => `| ${code(f.path)} | ${f.bytes} |`),
    '',
  );
  if (h.versions.length > 0) {
    push(
      '保存した版:',
      '',
      '| 版 | 名前 | 種類 | 保存した日時 |',
      '|---|---|---|---|',
      ...h.versions.map((v) => `| v${v.number} | ${cell(v.name || '(名前なし)')} | ${v.kind === 'auto' ? '自動' : '手動'} | ${localTime(v.savedAt)} |`),
      '',
    );
  }
  push('## 変更の経緯', '');
  if (h.requests.length > 0) {
    push(
      '作る欄に送った依頼です。Studio を起動してからのものだけで、起動し直す前の依頼は残っていません。',
      '',
      '| 日時 | 依頼 | 結果 | 変わったファイル |',
      '|---|---|---|---|',
      ...h.requests.map((r) => `| ${localTime(r.startedAt)} | ${cell(r.request)} | ${RUN_LABELS[r.status] ?? r.status} | ${cell(r.changedFiles.map((c) => c.file).join('、'))} |`),
      '',
    );
  } else {
    push('Studio を起動してから、作る欄の依頼はありません(起動し直す前の依頼は残っていません)。', '');
  }
  push(
    '## 入れていないもの',
    '',
    '- 秘密情報。Studio は書き出す前に、API キーやトークンらしい文字列を探す。見つかったら書き出さない。',
    ...(h.excluded.length > 0 ? [`- 秘密を入れるファイル: ${h.excluded.map((e) => code(e.path)).join('、')}`] : []),
    '- AI の実行の記録(AI に渡した本文の全文を含む)、作る AI の返事、ログインの情報、環境変数、PC のフォルダーの場所。',
    '- 会話の中のメールアドレスと電話番号らしい文字列は伏せた(`[伏せた: …]`)。',
    '',
    '## 試作品を動かす',
    '',
    '- Prototype Studio で開く: `app/` を `~/PrototypeStudio/projects/<英小文字・数字・ハイフンの名前>/app/` に写し、Studio を起動して一覧から選ぶ。',
    '- Studio の外では、`window.studio.ai` がないので、プロダクト内 AI の部分は動かない。',
    '- 機械で読むときは `handoff.json` を使う(形は Prototype Studio の docs/handoff.md)。',
    '',
  );
  return lines.join('\n');
}

const ENTRY_NAMES = ['main.jsx', 'main.tsx', 'main.js', 'main.ts'];

function workingText(working, versions) {
  const version = versions.find((v) => v.id === working.versionId);
  const label = version ? `保存版 v${version.number}${version.name ? `「${version.name}」` : ''}` : null;
  if (working.files === 'none') return '版を保存していない作業中から書き出した';
  if (working.files === 'changed') return '保存した版のどれとも違う作業中から書き出した';
  if (working.conversation === 'changed') return `ファイルは${label}と同じ。会話はそのときから進んでいる`;
  if (working.conversation === 'initial') return `ファイルは${label}と同じ。会話は最初のまま`;
  return `${label}と同じ`;
}

// 試作品の引き継ぎ。書き出し先は <STUDIO_HOME>/handoffs/<試作品の ID>-<日時>/。
// 作る AI が読み書きする app/ とも、Studio だけが書く .studio/ とも別の場所にする。
export class ProjectHandoffs {
  constructor({ home, store, aiSessions, versions, requests, log = () => {} }) {
    this.dir = path.join(home, 'handoffs');
    this.store = store;
    this.aiSessions = aiSessions;
    this.versions = versions;
    this.requests = requests;
    this.log = log;
  }

  notesFile(paths) {
    return path.join(paths.studio, NOTES_FILE);
  }

  async readNotes(paths) {
    try {
      return cleanNotes(JSON.parse(await fs.readFile(this.notesFile(paths), 'utf8')));
    } catch {
      return cleanNotes({});
    }
  }

  // 画面に出す。前に書いたメモと、最後に書き出した場所
  async view(id) {
    const paths = await this.store.requireProject(id);
    return { notes: await this.readNotes(paths), last: await this.last(id) };
  }

  async last(id) {
    const entries = await fs.readdir(this.dir, { withFileTypes: true }).catch(() => []);
    const found = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith(`${id}-`)) continue;
      try {
        const manifest = JSON.parse(await fs.readFile(path.join(this.dir, entry.name, 'handoff.json'), 'utf8'));
        if (manifest.format === HANDOFF_FORMAT && manifest.project?.id === id) {
          found.push({ dir: path.join(this.dir, entry.name), name: entry.name, createdAt: manifest.createdAt });
        }
      } catch {
        // 書きかけや、壊れたもの
      }
    }
    return found.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0] ?? null;
  }

  async export(id, rawNotes) {
    const notes = cleanNotes(rawNotes);
    const paths = await this.store.requireProject(id);
    const project = (await this.store.list()).find((p) => p.id === id);
    // 版の保存と同じ印を使い、作る AI、ビルド、版の操作、プロダクト内 AI への発言と同時には書き出さない
    this.store.claimVersions(id);
    const createdAt = new Date();
    let name = `${id}-${stamp(createdAt)}`;
    if (await fs.lstat(path.join(this.dir, name)).catch(() => null)) name = `${name}-${crypto.randomBytes(2).toString('hex')}`;
    const tmp = path.join(this.dir, `.${name}.tmp`);
    try {
      if (this.aiSessions.isBusy(id)) throw new BusyError('プロダクト内 AI が応答しているところです。終わってから書き出してください');
      // 前に書いたメモは、次に開いたときに出す。書き出しに失敗しても残す
      await fs.mkdir(paths.studio, { recursive: true });
      await fs.writeFile(this.notesFile(paths), `${JSON.stringify(notes, null, 2)}\n`);

      const excluded = [];
      const appCopy = path.join(tmp, 'app');
      try {
        await copyTree(paths.app, appCopy, {
          skip: (relative) => {
            if (!SECRET_FILES.some((pattern) => pattern.test(relative))) return false;
            excluded.push({ path: `app/${relative}`, reason: '秘密を入れるファイル' });
            return true;
          },
        });
      } catch (error) {
        if (error instanceof VersionError) throw new HandoffError(error.status, error.code, error.message.replace('版にできません', '書き出せません'));
        throw error;
      }
      // 写しをビルドして確かめる。写しの AI の設定を、書き出す設定にする
      const build = await buildApp({ appDir: appCopy, buildsDir: path.join(tmp, 'builds') }).catch((error) => ({
        ok: false,
        errors: [{ file: 'app/', text: error.message }],
      }));
      await fs.rm(path.join(tmp, 'builds'), { recursive: true, force: true });
      if (!build.ok) {
        const first = build.errors[0];
        throw new HandoffError(422, 'build', `ビルドできない状態は書き出せません。直してから書き出してください(${first ? `${first.file}: ${first.text}` : '理由はわかりません'})`);
      }
      const scan = await scanFiles(appCopy);
      if (scan.secrets.length > 0) {
        throw new HandoffError(
          422,
          'secret',
          `秘密情報らしい文字列があるので、書き出しませんでした。消してから書き出してください(${scan.secrets
            .slice(0, 5)
            .map((s) => `${where(s)} ${s.kind}`)
            .join('、')})`,
        );
      }

      const definition = build.ai ?? null;
      const conversation = definition
        ? describeConversation(definition, this.aiSessions.snapshot(id, definition), this.aiSessions.connections)
        : null;
      const selected = this.aiSessions.connectionOf(id);
      const { versions: versionList, working } = await this.versions.list(id);
      const manifest = {
        format: HANDOFF_FORMAT,
        formatVersion: HANDOFF_FORMAT_VERSION,
        createdAt: createdAt.toISOString(),
        studioVersion: await studioVersion(),
        project: { id, title: redact(project?.title ?? id) },
        notes: redactDeep(notes),
        working: { ...working, text: workingText(working, versionList) },
        capabilities: capabilities({ fileCount: scan.files.length, ai: definition, conversation, scan }),
        openQuestions: [
          ...(notes.undecided ? [{ from: 'person', text: redact(notes.undecided) }] : []),
          ...studioQuestions({ ai: definition, conversation, working, scan, excluded }).map((text) => ({ from: 'studio', text })),
        ],
        ai: definition
          ? {
              name: definition.name,
              file: 'app/ai.json',
              connection: { kind: selected.kind, label: selected.label, real: Boolean(selected.billing) },
              fields: definition.fields,
              initialState: definition.initialState,
              mock: definition.mock,
              systemPromptFile: 'ai/system-prompt.md',
              responseSchemaFile: 'ai/response-schema.json',
            }
          : null,
        conversation,
        source: {
          entry: ENTRY_NAMES.map((n) => `app/${n}`).find((n) => scan.files.some((f) => f.path === n)) ?? null,
          libraries: ALLOWED_PACKAGES.filter((p) => !p.includes('/')),
          files: scan.files,
          signs: scan.signs,
          dataFiles: scan.dataFiles,
          personalData: scan.personal,
        },
        versions: versionList.map((v) => ({ number: v.number, name: redact(v.name), kind: v.kind, savedAt: v.savedAt, builds: v.builds })),
        requests: this.requests.list(id).map((run) =>
          redactDeep({ request: run.request, status: run.status, startedAt: run.startedAt, changedFiles: run.changedFiles ?? [] }),
        ),
        excluded,
      };

      const readme = renderReadme({
        ...manifest,
        openQuestions: manifest.openQuestions.filter((q) => q.from === 'studio').map((q) => q.text),
        createdAtLocal: createdAt.toLocaleString('ja-JP'),
      });
      await fs.writeFile(path.join(tmp, 'README.md'), readme);
      await fs.writeFile(path.join(tmp, 'handoff.json'), `${JSON.stringify(manifest, null, 2)}\n`);
      if (definition) {
        await fs.mkdir(path.join(tmp, 'ai'), { recursive: true });
        await fs.writeFile(path.join(tmp, 'ai', 'system-prompt.md'), `${systemPrompt(definition)}\n`);
        await fs.writeFile(path.join(tmp, 'ai', 'response-schema.json'), `${JSON.stringify(responseSchema(definition), null, 2)}\n`);
      }
      await fs.rename(tmp, path.join(this.dir, name));
      this.log(`引き継ぎを書き出しました: ${id}(${name})`);
      const count = (kind) => manifest.capabilities.filter((row) => row.kind === kind).length;
      return {
        handoff: {
          dir: path.join(this.dir, name),
          name,
          createdAt: manifest.createdAt,
          counts: { real: count('real'), mock: count('mock'), missing: count('missing'), questions: manifest.openQuestions.length },
          excluded,
        },
        notes,
        last: { dir: path.join(this.dir, name), name, createdAt: manifest.createdAt },
      };
    } catch (error) {
      await fs.rm(tmp, { recursive: true, force: true });
      throw error;
    } finally {
      this.store.releaseVersions(id);
    }
  }
}
