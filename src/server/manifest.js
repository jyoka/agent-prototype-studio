import fs from 'node:fs/promises';
import path from 'node:path';
import { AI_FILE } from './product-ai/definition.js';

// 試作品の目録。成果物の契約の入口で、作る AI が app/ に書き、ビルドのたびに検査する(harness.md 5 節)。
// 題材に依存しない形(入口、意図、制約、架空のデータの宣言、AI の設定、シナリオの置き場所)だけを決める。
export const MANIFEST_FILE = 'prototype.json';
export const MANIFEST_FORMAT_VERSION = 1;
export const ENTRY_NAMES = ['main.jsx', 'main.tsx', 'main.js', 'main.ts'];
const SHOWN = `app/${MANIFEST_FILE}`;
const ENTRY_EXTENSIONS = ['.jsx', '.tsx', '.js', '.ts'];
const DEFAULT_SCENARIOS = 'scenarios';

export const MANIFEST_LIMITS = {
  maxShortText: 100,
  maxText: 1000,
  maxItems: 50,
  maxItemText: 200,
};

const TOP_KEYS = ['formatVersion', 'title', 'entry', 'intent', 'constraints', 'unimplemented', 'data', 'ai', 'scenarios'];
const INTENT_KEYS = ['purpose', 'tryThis'];
const DATA_KEYS = ['file', 'about'];

class Problems {
  constructor() {
    this.list = [];
  }

  add(where, text) {
    this.list.push({ file: SHOWN, text: where ? `${where}: ${text}` : text });
  }
}

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function checkKeys(problems, where, object, allowed) {
  for (const key of Object.keys(object)) {
    if (!allowed.includes(key)) problems.add(where, `「${key}」は使えない項目です。使える項目: ${allowed.join(', ')}`);
  }
}

function text(problems, where, value, { required = false, max = MANIFEST_LIMITS.maxShortText } = {}) {
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

function texts(problems, where, value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MANIFEST_LIMITS.maxItems) {
    problems.add(where, `${MANIFEST_LIMITS.maxItems} 個までの文字列の配列で書いてください`);
    return [];
  }
  return value
    .map((item, i) => text(problems, `${where}[${i}]`, item, { required: true, max: MANIFEST_LIMITS.maxItemText }))
    .filter((item) => item !== undefined);
}

// app/ からの相対パスにそろえる。app/ の外を指すもの(.. や絶対パス)は誤りにする
function appPath(problems, where, value, { folder = false } = {}) {
  if (typeof value !== 'string' || value.trim() === '') {
    problems.add(where, 'app/ からの相対パスを、空でない文字列で書いてください');
    return undefined;
  }
  if (value.includes('\\') || value.includes('\0') || path.posix.isAbsolute(value) || /^[A-Za-z]:/.test(value)) {
    problems.add(where, `app/ からの相対パスを / 区切りで書いてください(絶対パスは使えません): ${value}`);
    return undefined;
  }
  if (value.split('/').includes('..')) {
    problems.add(where, `app/ の外は指せません(.. は使えません): ${value}`);
    return undefined;
  }
  if (!folder && value.endsWith('/')) {
    problems.add(where, `ファイルを指してください(末尾の / は要りません): ${value}`);
    return undefined;
  }
  const normalized = path.posix.normalize(value).replace(/\/$/, '');
  if (normalized === '.' || normalized === '') {
    problems.add(where, `app/ の中のファイルやフォルダーを指してください: ${value}`);
    return undefined;
  }
  return normalized;
}

async function kindOf(appDir, relative) {
  const stat = await fs.lstat(path.join(appDir, ...relative.split('/'))).catch(() => null);
  if (!stat) return 'none';
  if (stat.isFile()) return 'file';
  if (stat.isDirectory()) return 'directory';
  return 'other';
}

async function requireFile(problems, appDir, where, relative) {
  const kind = await kindOf(appDir, relative);
  if (kind === 'none') problems.add(where, `app/${relative} がありません`);
  else if (kind !== 'file') problems.add(where, `app/${relative} は普通のファイルにしてください`);
}

// 目録がないときの入口。今までの探し方(main.jsx など)のまま
export async function findEntryName(appDir) {
  for (const name of ENTRY_NAMES) {
    if ((await kindOf(appDir, name)) === 'file') return name;
  }
  return null;
}

async function defaults(appDir) {
  return {
    formatVersion: MANIFEST_FORMAT_VERSION,
    title: null,
    entry: await findEntryName(appDir),
    intent: { purpose: null, tryThis: [] },
    constraints: [],
    unimplemented: [],
    data: [],
    ai: (await kindOf(appDir, AI_FILE)) === 'none' ? null : AI_FILE,
    scenarios: DEFAULT_SCENARIOS,
  };
}

// 目録の文を検査し、既定の値で埋めた目録を返す。ファイルの有無も app/ の中で確かめる
export async function parseManifest(source, appDir) {
  const problems = new Problems();
  let raw;
  try {
    raw = JSON.parse(source);
  } catch (error) {
    problems.add('', `JSON として読めません(${error.message})`);
    return { manifest: null, errors: problems.list };
  }
  if (!isPlainObject(raw)) {
    problems.add('', '全体を { … } のオブジェクトで書いてください');
    return { manifest: null, errors: problems.list };
  }
  checkKeys(problems, '', raw, TOP_KEYS);
  const manifest = await defaults(appDir);

  if (raw.formatVersion !== MANIFEST_FORMAT_VERSION) {
    problems.add('formatVersion', `${MANIFEST_FORMAT_VERSION} にしてください(今は ${JSON.stringify(raw.formatVersion) ?? 'なし'})`);
  }
  manifest.title = text(problems, 'title', raw.title) ?? null;

  if (raw.entry !== undefined) {
    const entry = appPath(problems, 'entry', raw.entry);
    if (entry !== undefined) {
      if (!ENTRY_EXTENSIONS.includes(path.posix.extname(entry))) {
        problems.add('entry', `入口は ${ENTRY_EXTENSIONS.join('、')} のどれかのファイルにしてください: ${entry}`);
      } else {
        await requireFile(problems, appDir, 'entry', entry);
      }
      manifest.entry = entry;
    }
  }

  if (raw.intent !== undefined) {
    if (!isPlainObject(raw.intent)) {
      problems.add('intent', '{ "purpose": …, "tryThis": […] } の形で書いてください');
    } else {
      checkKeys(problems, 'intent', raw.intent, INTENT_KEYS);
      manifest.intent = {
        purpose: text(problems, 'intent.purpose', raw.intent.purpose, { max: MANIFEST_LIMITS.maxText }) ?? null,
        tryThis: texts(problems, 'intent.tryThis', raw.intent.tryThis),
      };
    }
  }
  manifest.constraints = texts(problems, 'constraints', raw.constraints);
  manifest.unimplemented = texts(problems, 'unimplemented', raw.unimplemented);

  if (raw.data !== undefined) {
    if (!Array.isArray(raw.data) || raw.data.length > MANIFEST_LIMITS.maxItems) {
      problems.add('data', `${MANIFEST_LIMITS.maxItems} 個までの配列で書いてください`);
    } else {
      const seen = new Set();
      for (const [i, item] of raw.data.entries()) {
        const where = `data[${i}]`;
        if (!isPlainObject(item)) {
          problems.add(where, '{ "file": …, "about": … } の形で書いてください');
          continue;
        }
        checkKeys(problems, where, item, DATA_KEYS);
        const file = appPath(problems, `${where}.file`, item.file);
        const about = text(problems, `${where}.about`, item.about, { required: true, max: MANIFEST_LIMITS.maxItemText });
        if (file === undefined) continue;
        if (seen.has(file)) problems.add(`${where}.file`, `app/${file} が重なっています`);
        seen.add(file);
        await requireFile(problems, appDir, `${where}.file`, file);
        if (about !== undefined) manifest.data.push({ file, about });
      }
    }
  }

  if (raw.ai !== undefined) {
    const ai = appPath(problems, 'ai', raw.ai);
    if (ai !== undefined) {
      if (path.posix.extname(ai) !== '.json') problems.add('ai', `.json のファイルを指してください: ${ai}`);
      else await requireFile(problems, appDir, 'ai', ai);
      manifest.ai = ai;
    }
  }

  if (raw.scenarios !== undefined) {
    const scenarios = appPath(problems, 'scenarios', raw.scenarios, { folder: true });
    if (scenarios !== undefined) {
      // シナリオの置き場所は、まだなくてもよい。あるならフォルダーにする
      const kind = await kindOf(appDir, scenarios);
      if (kind !== 'none' && kind !== 'directory') problems.add('scenarios', `app/${scenarios} はフォルダーにしてください`);
      manifest.scenarios = scenarios;
    }
  }

  if (problems.list.length > 0) return { manifest: null, errors: problems.list };
  return { manifest: { ...manifest, declared: true }, errors: [] };
}

// app/prototype.json を読む。なければ既定の値の目録を返し、誤りにはしない(今の試作品を壊さない)。
export async function readManifest(appDir) {
  const kind = await kindOf(appDir, MANIFEST_FILE);
  if (kind === 'none') return { manifest: { ...(await defaults(appDir)), declared: false }, errors: [] };
  if (kind !== 'file') return { manifest: null, errors: [{ file: SHOWN, text: '普通のファイルにしてください' }] };
  return parseManifest(await fs.readFile(path.join(appDir, MANIFEST_FILE), 'utf8'), appDir);
}
