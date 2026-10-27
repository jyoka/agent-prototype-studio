import fs from 'node:fs/promises';
import path from 'node:path';

// 試作品のプロダクト内 AI の設定。成果物の一部なので app/ に置き、ビルドのたびに検査する。
// 中身は題材に依存しない形(覚える項目、モックの応答の型)だけを決める。
export const AI_FILE = 'ai.json';
const SHOWN = `app/${AI_FILE}`;

export const AI_LIMITS = {
  maxFields: 20,
  maxOptions: 50,
  maxKeywords: 20,
  maxShortText: 100,
  maxTemplate: 1000,
  maxInstructions: 20_000,
};

const KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,31}$/;
const TOP_KEYS = ['name', 'instructions', 'fields', 'initialState', 'mock'];
const FIELD_KEYS = { choice: ['key', 'label', 'type', 'question', 'options'], number: ['key', 'label', 'type', 'question', 'unit', 'keywords', 'min', 'max'] };
const OPTION_KEYS = ['value', 'keywords'];
export const MOCK_TEMPLATES = {
  greeting: '',
  understood: '{changes}と理解しました。',
  afterCorrection: '直していただいた{changes}で進めます。',
  notUnderstood: 'すみません、条件として読み取れませんでした。',
  complete: '今の条件は{summary}です。',
};

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

function text(problems, where, value, { required = false, max = AI_LIMITS.maxShortText } = {}) {
  if (value === undefined && !required) return undefined;
  if (typeof value !== 'string' || (required && value.trim() === '')) {
    problems.add(where, required ? '空でない文字列で書いてください' : '文字列で書いてください');
    return undefined;
  }
  if (value.length > max) {
    problems.add(where, `長すぎます(上限 ${max} 文字)`);
    return undefined;
  }
  return value;
}

function keywords(problems, where, value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > AI_LIMITS.maxKeywords) {
    problems.add(where, `${AI_LIMITS.maxKeywords} 個までの文字列の配列で書いてください`);
    return [];
  }
  return value.map((item, i) => text(problems, `${where}[${i}]`, item, { required: true, max: 30 })).filter(Boolean);
}

function finiteOrUndefined(problems, where, value) {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    problems.add(where, '数で書いてください');
    return undefined;
  }
  return value;
}

function parseField(problems, where, raw, seenKeys) {
  if (!isPlainObject(raw)) {
    problems.add(where, 'オブジェクトで書いてください');
    return null;
  }
  const type = raw.type ?? 'choice';
  if (!Object.hasOwn(FIELD_KEYS, type)) {
    problems.add(`${where}.type`, '"choice" か "number" にしてください');
    return null;
  }
  checkKeys(problems, where, raw, FIELD_KEYS[type]);
  const key = raw.key;
  if (typeof key !== 'string' || !KEY_PATTERN.test(key)) {
    problems.add(`${where}.key`, '英字で始まる、英数字と _ だけの 32 文字までの名前にしてください');
  } else if (seenKeys.has(key)) {
    problems.add(`${where}.key`, `「${key}」が重なっています`);
  } else {
    seenKeys.add(key);
  }
  const label = text(problems, `${where}.label`, raw.label, { required: true, max: 40 });
  const question = text(problems, `${where}.question`, raw.question, { max: AI_LIMITS.maxTemplate });
  const field = { key, label, type, question: question ?? `${label ?? key}を教えてください。` };

  if (type === 'choice') {
    if (!Array.isArray(raw.options) || raw.options.length === 0 || raw.options.length > AI_LIMITS.maxOptions) {
      problems.add(`${where}.options`, `1 個から ${AI_LIMITS.maxOptions} 個の選択肢を配列で書いてください`);
      return null;
    }
    const values = new Set();
    field.options = raw.options.map((option, i) => {
      const at = `${where}.options[${i}]`;
      if (!isPlainObject(option)) {
        problems.add(at, '{ "value": …, "keywords": […] } の形で書いてください');
        return null;
      }
      checkKeys(problems, at, option, OPTION_KEYS);
      const value = text(problems, `${at}.value`, option.value, { required: true, max: 60 });
      if (value !== undefined && values.has(value)) problems.add(`${at}.value`, `「${value}」が重なっています`);
      values.add(value);
      return { value, keywords: keywords(problems, `${at}.keywords`, option.keywords) };
    });
  } else {
    field.unit = text(problems, `${where}.unit`, raw.unit, { max: 10 }) ?? '';
    field.keywords = keywords(problems, `${where}.keywords`, raw.keywords);
    field.min = finiteOrUndefined(problems, `${where}.min`, raw.min) ?? null;
    field.max = finiteOrUndefined(problems, `${where}.max`, raw.max) ?? null;
    if (field.min !== null && field.max !== null && field.min > field.max) problems.add(where, 'min が max より大きくなっています');
  }
  return field;
}

// 値を項目の決まりに合わせる。合わない値は undefined を返す(null は「未定」)。
export function normalizeValue(field, value) {
  if (value === null || value === '') return null;
  if (field.type === 'choice') {
    return typeof value === 'string' && field.options.some((option) => option.value === value) ? value : undefined;
  }
  // 文字列は 10 進の数だけを受ける(0x10 や 1e3 は受けない)
  let number = value;
  if (typeof value === 'string') {
    const digits = value.normalize('NFKC').replaceAll(',', '').trim();
    number = /^-?\d+(\.\d+)?$/.test(digits) ? Number(digits) : undefined;
  }
  if (typeof number !== 'number' || !Number.isFinite(number)) return undefined;
  if (field.min !== null && number < field.min) return undefined;
  if (field.max !== null && number > field.max) return undefined;
  return number;
}

export function formatValue(field, value) {
  if (value === null || value === undefined) return '未定';
  return field.type === 'number' ? `${value.toLocaleString('ja-JP')}${field.unit}` : value;
}

export function parseAiDefinition(source) {
  const problems = new Problems();
  let raw;
  try {
    raw = JSON.parse(source);
  } catch (error) {
    problems.add('', `JSON として読めません(${error.message})`);
    return { definition: null, errors: problems.list };
  }
  if (!isPlainObject(raw)) {
    problems.add('', '全体を { … } のオブジェクトで書いてください');
    return { definition: null, errors: problems.list };
  }
  checkKeys(problems, '', raw, TOP_KEYS);
  const name = text(problems, 'name', raw.name, { required: true });
  const instructions = text(problems, 'instructions', raw.instructions, { max: AI_LIMITS.maxInstructions }) ?? '';

  let fields = [];
  if (!Array.isArray(raw.fields) || raw.fields.length === 0 || raw.fields.length > AI_LIMITS.maxFields) {
    problems.add('fields', `覚える項目を 1 個から ${AI_LIMITS.maxFields} 個、配列で書いてください`);
  } else {
    const seenKeys = new Set();
    fields = raw.fields.map((field, i) => parseField(problems, `fields[${i}]`, field, seenKeys));
  }

  const mock = { ...MOCK_TEMPLATES };
  if (raw.mock !== undefined) {
    if (!isPlainObject(raw.mock)) {
      problems.add('mock', 'オブジェクトで書いてください');
    } else {
      checkKeys(problems, 'mock', raw.mock, Object.keys(MOCK_TEMPLATES));
      for (const key of Object.keys(MOCK_TEMPLATES)) {
        const value = text(problems, `mock.${key}`, raw.mock[key], { max: AI_LIMITS.maxTemplate });
        if (value !== undefined) mock[key] = value;
      }
    }
  }

  if (problems.list.length > 0) return { definition: null, errors: problems.list };

  const initialState = Object.fromEntries(fields.map((field) => [field.key, null]));
  if (raw.initialState !== undefined) {
    if (!isPlainObject(raw.initialState)) {
      problems.add('initialState', 'オブジェクトで書いてください');
    } else {
      for (const [key, value] of Object.entries(raw.initialState)) {
        const field = fields.find((f) => f.key === key);
        if (!field) {
          problems.add(`initialState.${key}`, 'fields にない項目です');
          continue;
        }
        const normalized = normalizeValue(field, value);
        if (normalized === undefined) problems.add(`initialState.${key}`, '項目の決まりに合わない値です');
        else initialState[key] = normalized;
      }
    }
  }
  if (problems.list.length > 0) return { definition: null, errors: problems.list };
  return { definition: { name, instructions, fields, initialState, mock }, errors: [] };
}

// app/ai.json を読む。なければ AI を使わない試作品として null を返す。
export async function readAiDefinition(appDir) {
  const file = path.join(appDir, AI_FILE);
  const stat = await fs.lstat(file).catch(() => null);
  if (!stat) return { definition: null, errors: [] };
  if (!stat.isFile()) return { definition: null, errors: [{ file: SHOWN, text: '普通のファイルにしてください' }] };
  return parseAiDefinition(await fs.readFile(file, 'utf8'));
}
