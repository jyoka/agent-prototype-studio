import fs from 'node:fs/promises';
import path from 'node:path';
import { appPath, kindOf } from '../manifest.js';

// 構成、ツール、前提、モック、場面の検査に共通の部品(docs/design/agent-simulation.md の 2.7)。
// どのファイルも作る AI が app/ に書くので、決まった語と上限だけを受け付け、誤りは利用者向けの文で返す。

// ツールの名前。そのまま --allowedTools に並ぶので、`,`、空白、`*` などを入れさせない
export const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]{0,39}$/;
// 参加者、前提、守り、枠、場面の id。起動の引数に入らないので、ハイフンを許す
export const ID_PATTERN = /^[a-z][a-z0-9-]{0,39}$/;
// 持ち主の名前(英小文字、20 字まで)
export const OWNER_PATTERN = /^[a-z][a-z0-9-]{0,19}$/;
// 引数と項目の名前(ai.json の項目の key と同じ形)
export const KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,31}$/;
// ボタンの action の名前
export const ACTION_PATTERN = /^[a-z][a-z0-9_-]{0,39}$/;

export const SIM_LIMITS = {
  // 構成、ツール、前提、モック、場面の 1 つのファイル
  maxFileBytes: 256 * 1024,
  // ツールが読むデータの 1 つのファイル(app/ の検査の 1 ファイルの上限と同じ)
  maxDataBytes: 1024 * 1024,
  // プロンプトの枠の文、前提の hostPrompt
  maxPromptChars: 8000,
  maxShortText: 100,
  maxText: 1000,
};

export class Problems {
  constructor(file) {
    this.file = file;
    this.list = [];
  }

  add(where, text) {
    this.list.push({ file: this.file, text: where ? `${where}: ${text}` : text });
  }
}

// 誤りの文に入れる値。長いもの、文字列にできないもの(入れ子が深すぎるなど)も、短い文にする
export function show(value) {
  let shown;
  try {
    shown = JSON.stringify(value);
  } catch {
    return '(読めない値)';
  }
  if (shown === undefined) return 'なし';
  return shown.length > 60 ? `${shown.slice(0, 60)}…` : shown;
}

export const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

export function checkKeys(problems, where, object, allowed) {
  for (const key of Object.keys(object)) {
    if (!allowed.includes(key)) problems.add(where, `「${key}」は使えない項目です。使える項目: ${allowed.join(', ')}`);
  }
}

export function text(problems, where, value, { required = false, max = SIM_LIMITS.maxShortText } = {}) {
  if (value === undefined && !required) return undefined;
  if (typeof value !== 'string' || value.trim() === '') {
    problems.add(where, '空でない文字列で書いてください');
    return undefined;
  }
  if (value.length > max) {
    problems.add(where, `長すぎます(上限 ${max} 文字)`);
    return undefined;
  }
  return value;
}

export function named(problems, where, value, pattern, { required = true, hint = '' } = {}) {
  if (value === undefined && !required) return undefined;
  if (typeof value !== 'string' || !pattern.test(value)) {
    problems.add(where, `${show(value)} は使えない名前です。${hint || `形: ${pattern.source}`}`);
    return undefined;
  }
  return value;
}

export const idOf = (problems, where, value, options) =>
  named(problems, where, value, ID_PATTERN, { hint: '英小文字で始め、英小文字、数字、- だけで 40 字まで', ...options });
export const toolNameOf = (problems, where, value, options) =>
  named(problems, where, value, TOOL_NAME_PATTERN, { hint: '英小文字で始め、英小文字、数字、_ だけで 40 字まで', ...options });
export const ownerOf = (problems, where, value) =>
  named(problems, where, value, OWNER_PATTERN, { required: false, hint: '英小文字で始め、英小文字、数字、- だけで 20 字まで' });

// 決まった語のどれか。知らない語は誤り(増やせるのは Studio のコードだけ)
export function oneOf(problems, where, value, allowed, { required = true, label = '種類' } = {}) {
  if (value === undefined && !required) return undefined;
  if (!allowed.includes(value)) {
    problems.add(where, `${show(value)} は知らない${label}です。使える${label}: ${allowed.join(', ')}`);
    return undefined;
  }
  return value;
}

export function integer(problems, where, value, { min, max, required = false } = {}) {
  if (value === undefined && !required) return undefined;
  if (!Number.isInteger(value) || value < min || value > max) {
    problems.add(where, `${min} から ${max} までの整数で書いてください`);
    return undefined;
  }
  return value;
}

export function bool(problems, where, value) {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') {
    problems.add(where, 'true か false で書いてください');
    return undefined;
  }
  return value;
}

// 配列。形が違えば誤りにして null を返す
export function list(problems, where, value, { min = 0, max, of = '' } = {}) {
  if (!Array.isArray(value) || value.length < min || value.length > max) {
    const range = min > 0 ? `${min} 個から ${max} 個までの` : `${max} 個までの`;
    problems.add(where, `${range}${of}配列で書いてください`);
    return null;
  }
  return value;
}

export function texts(problems, where, value, { max, maxChars = SIM_LIMITS.maxShortText, min = 0 } = {}) {
  const items = list(problems, where, value, { min, max, of: '文字列の' });
  if (!items) return [];
  return items.map((item, i) => text(problems, `${where}[${i}]`, item, { required: true, max: maxChars })).filter((item) => item !== undefined);
}

// 重なりを誤りにする
export function unique(problems, where, values, label) {
  const seen = new Set();
  for (const value of values) {
    if (value === undefined) continue;
    if (seen.has(value)) problems.add(where, `${label}「${value}」が重なっています`);
    seen.add(value);
  }
}

// JSON の値の大きさ(文字数)の上限
export function jsonValue(problems, where, value, { max = SIM_LIMITS.maxText } = {}) {
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch {
    // 入れ子が深すぎて文字列にできないもの
    problems.add(where, '入れ子が深すぎます');
    return undefined;
  }
  if (serialized === undefined) {
    problems.add(where, 'JSON の値で書いてください');
    return undefined;
  }
  if (serialized.length > max) {
    problems.add(where, `大きすぎます(JSON で ${max} 文字まで)`);
    return undefined;
  }
  return value;
}

// app/ の中のファイルを指すパス。拡張子を決めたものだけ受け付ける。
// .js などのコードは読まない(ツールの口とモックが生成コードを読まないため。ADR-0003)
export async function appFile(problems, where, value, appDir, { extensions, required = true } = {}) {
  if (value === undefined && !required) return undefined;
  const relative = appPath(problems, where, value);
  if (relative === undefined) return undefined;
  if (!extensions.includes(path.posix.extname(relative))) {
    problems.add(where, `${extensions.join('、')} のファイルを指してください(.js などのコードは読みません): ${relative}`);
    return undefined;
  }
  const kind = await kindOf(appDir, relative);
  if (kind === 'none') {
    problems.add(where, `app/${relative} がありません`);
    return undefined;
  }
  if (kind !== 'file') {
    problems.add(where, `app/${relative} は普通のファイルにしてください`);
    return undefined;
  }
  return relative;
}

export function appFolder(problems, where, value) {
  return appPath(problems, where, value, { folder: true });
}

// app/ の中の、あると分かっている普通のファイルを読む。大きすぎるものは読まない
export async function readAppText(appDir, relative, maxBytes) {
  const file = path.join(appDir, ...relative.split('/'));
  const stat = await fs.lstat(file).catch(() => null);
  if (!stat) return { error: 'ファイルがありません' };
  if (!stat.isFile()) return { error: '普通のファイルにしてください' };
  if (stat.size > maxBytes) return { error: `ファイルが大きすぎます(上限 ${maxBytes} バイト)` };
  return { text: await fs.readFile(file, 'utf8') };
}

export async function readAppJson(appDir, relative, maxBytes = SIM_LIMITS.maxFileBytes) {
  const { text: source, error } = await readAppText(appDir, relative, maxBytes);
  if (error) return { error };
  try {
    return { value: JSON.parse(source) };
  } catch (parseError) {
    return { error: `JSON として読めません(${parseError.message})` };
  }
}

// フォルダーの中の .json を名前の順に並べる。フォルダーがなければ空。
// コードのファイル(.js など)は、データとして読まないことを示すために誤りにする
const CODE_EXTENSIONS = ['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx'];
export async function listJsonFiles(appDir, folder, { max, label }) {
  const dir = path.join(appDir, ...folder.split('/'));
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch((error) => {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return [];
    throw error;
  });
  const errors = [];
  for (const entry of entries) {
    if (CODE_EXTENSIONS.includes(path.extname(entry.name))) {
      errors.push({ file: `app/${folder}/${entry.name}`, text: `${label}は .json で書いてください(.js などのコードは読みません)` });
    }
  }
  const files = entries.filter((entry) => entry.name.endsWith('.json')).map((entry) => `${folder}/${entry.name}`).sort();
  if (files.length > max) {
    errors.push({ file: `app/${folder}/`, text: `${label}が多すぎます(${files.length} 個。上限 ${max} 個)` });
    return { files: [], errors };
  }
  return { files, errors };
}

// formatVersion は今はどのファイルも 1
export function formatVersion(problems, raw, version = 1) {
  if (raw.formatVersion !== version) {
    problems.add('formatVersion', `${version} にしてください(今は ${show(raw.formatVersion)})`);
  }
}
