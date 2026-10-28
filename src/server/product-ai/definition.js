import fs from 'node:fs/promises';
import path from 'node:path';

// 試作品のプロダクト内 AI の設定。成果物の一部なので app/ に置き、ビルドのたびに検査する。
// 中身は題材に依存しない形(覚える項目、段と遷移、終わる条件、守ること、モックの応答の型)だけを決める。
// 版 1(formatVersion も flow もない)は、同じ振る舞いの版 2 として読む。
export const AI_FILE = 'ai.json';
export const AI_FORMAT_VERSION = 2;
const SHOWN = `app/${AI_FILE}`;

export const AI_LIMITS = {
  maxFields: 20,
  maxOptions: 50,
  maxKeywords: 20,
  maxShortText: 100,
  maxTemplate: 1000,
  maxInstructions: 20_000,
  maxSteps: 20,
  maxNext: 10,
  maxForbidden: 20,
  maxReplyChars: 2000,
};

// 会話のターンの上限。flow.maxTurns がこれを超えても、ここまでとして読む(有料の応答の上限 30 回に合わせる)
export const MAX_TURNS = 30;
// 利用者の発言の種類。Studio が決め、増やすのは Studio のコードだけ
export const INTENTS = ['answer', 'yes', 'no', 'clarify', 'aside', 'restart'];
// 遷移の条件に使える語。式や関数は書かせない(遷移をコードで確かめるため)
export const CONDITIONS = ['filled', 'intent', 'turnsAtLeast'];
// 段と終わりで言うことの種類
export const SAY_KINDS = ['summary', 'complete'];
// next[].to にこれを書くと、会話を終える
export const END_STEP = 'done';
export const DEFAULT_RULES = { noNewNumbers: true, noLeading: true, mustAsk: true, maxReplyChars: 1000, forbidden: [] };
const RULE_FLAGS = ['noNewNumbers', 'noLeading', 'mustAsk'];

const KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,31}$/;
const TOP_KEYS = ['formatVersion', 'name', 'instructions', 'fields', 'initialState', 'flow', 'end', 'rules', 'mock'];
const FIELD_KEYS = {
  choice: ['key', 'label', 'type', 'required', 'question', 'options'],
  number: ['key', 'label', 'type', 'required', 'question', 'unit', 'keywords', 'min', 'max'],
};
const OPTION_KEYS = ['value', 'keywords'];
const FLOW_KEYS = ['steps', 'maxTurns'];
const STEP_KEYS = ['id', 'ask', 'say', 'next'];
const NEXT_KEYS = ['when', 'to'];
const END_KEYS = ['say'];
const RULE_KEYS = [...RULE_FLAGS, 'maxReplyChars', 'forbidden'];
export const MOCK_TEMPLATES = {
  greeting: '',
  understood: '{changes}と理解しました。',
  afterCorrection: '直していただいた{changes}で進めます。',
  notUnderstood: 'すみません、条件として読み取れませんでした。',
  complete: '今の条件は{summary}です。',
  // 版 2: 段の say が summary のときの型
  confirm: '今の条件は{summary}です。これでよいですか?',
};

class Problems {
  constructor(shown = SHOWN) {
    this.list = [];
    this.shown = shown;
  }

  add(where, text) {
    this.list.push({ file: this.shown, text: where ? `${where}: ${text}` : text });
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
  if (raw.required !== undefined && typeof raw.required !== 'boolean') problems.add(`${where}.required`, 'true か false で書いてください');
  const question = text(problems, `${where}.question`, raw.question, { max: AI_LIMITS.maxTemplate });
  // required を書かない項目は、終わる条件に入る(版 1 の「全部が埋まったら終わる」と同じ)
  const field = { key, label, type, required: raw.required !== false, question: question ?? `${label ?? key}を教えてください。` };

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

const isPositiveInteger = (value) => Number.isInteger(value) && value >= 1;
const unknownIntent = (value) => `「${value}」は知らない intent です。使える intent: ${INTENTS.join(', ')}`;

// 書かなかったときの段と遷移(版 1 の読み替えにも使う): 段は 1 つ、全部の項目を並びの順に聞き、必須の項目が全部埋まったら終わる
function defaultFlow(fields) {
  return {
    steps: [{ id: 'hear', ask: fields.map((field) => field.key), say: null, next: [{ when: { filled: 'required' }, to: END_STEP }] }],
    maxTurns: MAX_TURNS,
  };
}

// 項目の名前の一覧。fieldKeys が null(fields に誤りがある)ときは、名前があるかを確かめない
function fieldList(problems, where, value, fieldKeys) {
  if (!Array.isArray(value) || value.length > AI_LIMITS.maxFields) {
    problems.add(where, `項目の key を ${AI_LIMITS.maxFields} 個までの配列で書いてください`);
    return [];
  }
  const keys = [];
  value.forEach((key, i) => {
    if (typeof key !== 'string') problems.add(`${where}[${i}]`, '項目の key を文字列で書いてください');
    else if (fieldKeys && !fieldKeys.has(key)) problems.add(`${where}[${i}]`, `「${key}」は fields にない項目です`);
    else if (keys.includes(key)) problems.add(`${where}[${i}]`, `「${key}」が重なっています`);
    else keys.push(key);
  });
  return keys;
}

function parseSay(problems, where, value) {
  if (value === undefined) return null;
  if (typeof value !== 'string') {
    problems.add(where, `${SAY_KINDS.join(', ')} のどれかを文字列で書いてください`);
    return null;
  }
  if (!SAY_KINDS.includes(value)) {
    problems.add(where, `「${value}」は知らない種類です。使える種類: ${SAY_KINDS.join(', ')}`);
    return null;
  }
  return value;
}

function parseWhen(problems, where, raw, fieldKeys) {
  if (!isPlainObject(raw) || Object.keys(raw).length === 0) {
    problems.add(where, `条件を { "${CONDITIONS[0]}": … } の形で書いてください。使える語: ${CONDITIONS.join(', ')}`);
    return {};
  }
  for (const word of Object.keys(raw)) {
    if (!CONDITIONS.includes(word)) problems.add(where, `「${word}」は知らない条件の語です。使える語: ${CONDITIONS.join(', ')}`);
  }
  const when = {};
  if (raw.filled !== undefined) {
    if (raw.filled === 'required') {
      when.filled = 'required';
    } else if (Array.isArray(raw.filled) && raw.filled.length > 0) {
      when.filled = fieldList(problems, `${where}.filled`, raw.filled, fieldKeys);
    } else {
      problems.add(`${where}.filled`, '"required" か、項目の key の配列で書いてください');
    }
  }
  if (raw.intent !== undefined) {
    if (typeof raw.intent !== 'string') problems.add(`${where}.intent`, `${INTENTS.join(', ')} のどれかを文字列で書いてください`);
    else if (INTENTS.includes(raw.intent)) when.intent = raw.intent;
    else problems.add(`${where}.intent`, unknownIntent(raw.intent));
  }
  if (raw.turnsAtLeast !== undefined) {
    if (isPositiveInteger(raw.turnsAtLeast)) when.turnsAtLeast = raw.turnsAtLeast;
    else problems.add(`${where}.turnsAtLeast`, '1 以上の整数で書いてください');
  }
  return when;
}

function parseSteps(problems, raw, fieldKeys) {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > AI_LIMITS.maxSteps) {
    problems.add('flow.steps', `段を 1 個から ${AI_LIMITS.maxSteps} 個、配列で書いてください`);
    return [];
  }
  // 先に段の id を集める。後ろの段への遷移も確かめるため
  const ids = new Set();
  raw.forEach((step, i) => {
    if (!isPlainObject(step)) return;
    const { id } = step;
    if (typeof id !== 'string' || !KEY_PATTERN.test(id)) {
      problems.add(`flow.steps[${i}].id`, '英字で始まる、英数字と _ だけの 32 文字までの名前にしてください');
    } else if (id === END_STEP) {
      problems.add(`flow.steps[${i}].id`, `「${END_STEP}」は終わりを表すので、段の id には使えません`);
    } else if (ids.has(id)) {
      problems.add(`flow.steps[${i}].id`, `「${id}」が重なっています`);
    } else {
      ids.add(id);
    }
  });
  return raw.map((step, i) => {
    const where = `flow.steps[${i}]`;
    if (!isPlainObject(step)) {
      problems.add(where, 'オブジェクトで書いてください');
      return null;
    }
    checkKeys(problems, where, step, STEP_KEYS);
    const ask = step.ask === undefined ? [] : fieldList(problems, `${where}.ask`, step.ask, fieldKeys);
    const say = parseSay(problems, `${where}.say`, step.say);
    let next = [];
    if (step.next !== undefined) {
      if (!Array.isArray(step.next) || step.next.length > AI_LIMITS.maxNext) {
        problems.add(`${where}.next`, `遷移を ${AI_LIMITS.maxNext} 個までの配列で書いてください`);
      } else {
        next = step.next.map((item, j) => {
          const at = `${where}.next[${j}]`;
          if (!isPlainObject(item)) {
            problems.add(at, '{ "when": { … }, "to": … } の形で書いてください');
            return null;
          }
          checkKeys(problems, at, item, NEXT_KEYS);
          const when = parseWhen(problems, `${at}.when`, item.when, fieldKeys);
          if (typeof item.to !== 'string') {
            problems.add(`${at}.to`, `移る段の id か "${END_STEP}"(終わる)を文字列で書いてください`);
          } else if (item.to !== END_STEP && !ids.has(item.to)) {
            problems.add(`${at}.to`, `存在しない段「${item.to}」への遷移です。段の id か "${END_STEP}"(終わる)を書いてください`);
          }
          return { when, to: item.to };
        });
      }
    }
    return { id: step.id, ask, say, next };
  });
}

function parseFlow(problems, raw, fields, fieldKeys) {
  const flow = defaultFlow(fields);
  if (raw === undefined) return flow;
  if (!isPlainObject(raw)) {
    problems.add('flow', 'オブジェクトで書いてください');
    return flow;
  }
  checkKeys(problems, 'flow', raw, FLOW_KEYS);
  if (raw.steps !== undefined) flow.steps = parseSteps(problems, raw.steps, fieldKeys);
  if (raw.maxTurns !== undefined) {
    if (isPositiveInteger(raw.maxTurns)) flow.maxTurns = Math.min(raw.maxTurns, MAX_TURNS);
    else problems.add('flow.maxTurns', '1 以上の整数で書いてください');
  }
  return flow;
}

function parseEnd(problems, raw) {
  const end = { say: 'complete' };
  if (raw === undefined) return end;
  if (!isPlainObject(raw)) {
    problems.add('end', 'オブジェクトで書いてください');
    return end;
  }
  checkKeys(problems, 'end', raw, END_KEYS);
  end.say = parseSay(problems, 'end.say', raw.say) ?? end.say;
  return end;
}

function parseRules(problems, raw) {
  const rules = { ...DEFAULT_RULES, forbidden: [] };
  if (raw === undefined) return rules;
  if (!isPlainObject(raw)) {
    problems.add('rules', 'オブジェクトで書いてください');
    return rules;
  }
  checkKeys(problems, 'rules', raw, RULE_KEYS);
  for (const key of RULE_FLAGS) {
    if (raw[key] === undefined) continue;
    if (typeof raw[key] === 'boolean') rules[key] = raw[key];
    else problems.add(`rules.${key}`, 'true か false で書いてください');
  }
  if (raw.maxReplyChars !== undefined) {
    if (isPositiveInteger(raw.maxReplyChars) && raw.maxReplyChars <= AI_LIMITS.maxReplyChars) rules.maxReplyChars = raw.maxReplyChars;
    else problems.add('rules.maxReplyChars', `1 から ${AI_LIMITS.maxReplyChars} までの整数で書いてください`);
  }
  if (raw.forbidden !== undefined) {
    if (!Array.isArray(raw.forbidden) || raw.forbidden.length > AI_LIMITS.maxForbidden) {
      problems.add('rules.forbidden', `${AI_LIMITS.maxForbidden} 個までの文字列の配列で書いてください`);
    } else {
      rules.forbidden = raw.forbidden.map((item, i) => text(problems, `rules.forbidden[${i}]`, item, { required: true })).filter(Boolean);
    }
  }
  return rules;
}

function parseIntents(problems, raw) {
  const intents = {};
  if (raw === undefined) return intents;
  if (!isPlainObject(raw)) {
    problems.add('mock.intents', '{ "yes": ["はい"], … } の形で書いてください');
    return intents;
  }
  for (const [intent, words] of Object.entries(raw)) {
    if (!INTENTS.includes(intent)) problems.add('mock.intents', unknownIntent(intent));
    else intents[intent] = keywords(problems, `mock.intents.${intent}`, words);
  }
  return intents;
}

// 形に誤りがないときに、満たされ方のおかしい条件を知らせる。harness が最初のターンで終えたり、いつまでも移らなかったりしないように
function checkReachable(problems, fields, flow) {
  const usesRequired = flow.steps.some((step) => step.next.some((item) => item.when.filled === 'required'));
  if (usesRequired && !fields.some((field) => field.required)) {
    problems.add('fields', '必須の項目(required が true)が 1 つもないので、"filled": "required" の条件が最初から満たされてしまいます');
  }
  flow.steps.forEach((step, i) => {
    step.next.forEach((item, j) => {
      if (item.when.turnsAtLeast > flow.maxTurns) {
        problems.add(`flow.steps[${i}].next[${j}].when.turnsAtLeast`, `flow.maxTurns(${flow.maxTurns})より大きいので、満たされることがありません`);
      }
    });
  });
}

// 版 1 で版 2 の項目を書いたら知らせる。版を書き忘れて、振る舞いが黙って変わらないようにする
function checkVersion(problems, raw) {
  if (raw.formatVersion === undefined) return 1;
  if (raw.formatVersion !== 1 && raw.formatVersion !== AI_FORMAT_VERSION) {
    problems.add('formatVersion', `1 か ${AI_FORMAT_VERSION} にしてください`);
    return null;
  }
  return raw.formatVersion;
}

function checkVersionOneKeys(problems, raw) {
  const v2 = (where) => problems.add(where, `版 2 の項目です。使うときは "formatVersion": ${AI_FORMAT_VERSION} を書いてください`);
  for (const key of ['flow', 'end', 'rules']) if (raw[key] !== undefined) v2(key);
  if (Array.isArray(raw.fields)) {
    raw.fields.forEach((field, i) => {
      if (isPlainObject(field) && field.required !== undefined) v2(`fields[${i}].required`);
    });
  }
  for (const key of ['intents', 'confirm']) if (isPlainObject(raw.mock) && raw.mock[key] !== undefined) v2(`mock.${key}`);
}

export function parseAiDefinition(source, shown = SHOWN) {
  const problems = new Problems(shown);
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
  const version = checkVersion(problems, raw);
  if (version === 1) checkVersionOneKeys(problems, raw);
  const name = text(problems, 'name', raw.name, { required: true });
  const instructions = text(problems, 'instructions', raw.instructions, { max: AI_LIMITS.maxInstructions }) ?? '';

  let fields = [];
  let fieldsOk = false;
  if (!Array.isArray(raw.fields) || raw.fields.length === 0 || raw.fields.length > AI_LIMITS.maxFields) {
    problems.add('fields', `覚える項目を 1 個から ${AI_LIMITS.maxFields} 個、配列で書いてください`);
  } else {
    const before = problems.list.length;
    const seenKeys = new Set();
    fields = raw.fields.map((field, i) => parseField(problems, `fields[${i}]`, field, seenKeys));
    fieldsOk = problems.list.length === before;
  }
  // fields に誤りがあるときは、段の ask などの項目の名前を確かめない(同じ誤りを何度も出さない)
  const fieldKeys = fieldsOk ? new Set(fields.map((field) => field.key)) : null;
  // 版 1 で書いた版 2 の項目は、上で知らせたので読まない(同じ誤りを重ねて出さない)
  const v2 = version === 1 ? {} : raw;
  const flow = parseFlow(problems, v2.flow, fieldsOk ? fields : [], fieldKeys);
  const end = parseEnd(problems, v2.end);
  const rules = parseRules(problems, v2.rules);

  const mock = { ...MOCK_TEMPLATES, intents: {} };
  if (raw.mock !== undefined) {
    if (!isPlainObject(raw.mock)) {
      problems.add('mock', 'オブジェクトで書いてください');
    } else {
      checkKeys(problems, 'mock', raw.mock, [...Object.keys(MOCK_TEMPLATES), 'intents']);
      for (const key of Object.keys(MOCK_TEMPLATES)) {
        const value = text(problems, `mock.${key}`, raw.mock[key], { max: AI_LIMITS.maxTemplate });
        if (value !== undefined) mock[key] = value;
      }
      mock.intents = parseIntents(problems, version === 1 ? undefined : raw.mock.intents);
    }
  }

  if (problems.list.length === 0) checkReachable(problems, fields, flow);
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
  // 版 1 も版 2 の形で返す。使う側(harness)は版 2 だけを読めばよい
  return { definition: { formatVersion: AI_FORMAT_VERSION, name, instructions, fields, initialState, flow, end, rules, mock }, errors: [] };
}

// app/ai.json(目録の ai で別の名前にもできる。app/ からの相対パス)を読む。なければ AI を使わない試作品として null を返す。
export async function readAiDefinition(appDir, name = AI_FILE) {
  const file = path.join(appDir, ...name.split('/'));
  const shown = `app/${name}`;
  const stat = await fs.lstat(file).catch(() => null);
  if (!stat) return { definition: null, errors: [] };
  if (!stat.isFile()) return { definition: null, errors: [{ file: shown, text: '普通のファイルにしてください' }] };
  return parseAiDefinition(await fs.readFile(file, 'utf8'), shown);
}

const MOCK_LABELS = {
  greeting: '最初のあいさつ',
  understood: '読み取れたときの返事',
  afterCorrection: '本人の修正を受けたときの返事',
  notUnderstood: '読み取れなかったときの返事',
  complete: '条件がそろったときの返事',
  confirm: '条件のまとめを確かめるときの返事',
};

const SAY_LABELS = { summary: '条件のまとめ(mock.confirm)', complete: '終わりの文(mock.complete)' };
const INTENT_LABELS = {
  answer: '項目に答えた',
  yes: '「はい」と答えた',
  no: '「いいえ」と答えた',
  clarify: '質問を返した',
  aside: '関係のない話をした',
  restart: '最初からと言った',
};
const RULE_LABELS = {
  noNewNumbers: '数字を作らない(noNewNumbers)',
  noLeading: '誘導しない(noLeading)',
  mustAsk: '問いの原文を入れる(mustAsk)',
};

const quote = (value) => {
  const text = String(value ?? '');
  return `「${text.length > 200 ? `${text.slice(0, 200)}…` : text}」`;
};

// 前と後の設定を比べ、プロダクト内 AI の振る舞いのどこが変わったかを、利用者向けの文で返す。
// 作る AI の報告ではなく、Studio がビルドできた設定どうしを比べる(決まった手順)。
export function describeDefinitionChanges(before, after) {
  if (!before && !after) return [];
  if (!before) return [`プロダクト内 AI の設定ができました(${after.name})`];
  if (!after) return ['プロダクト内 AI の設定がなくなりました'];
  const lines = [];
  if (before.name !== after.name) lines.push(`名前: ${quote(before.name)} → ${quote(after.name)}`);
  if (before.instructions !== after.instructions) {
    const added = before.instructions && after.instructions.startsWith(before.instructions)
      ? after.instructions.slice(before.instructions.length).trim()
      : '';
    lines.push(
      added
        ? `実モデルへの指示(instructions)に足した文: ${quote(added)}`
        : `実モデルへの指示(instructions)を書き換えました(${before.instructions.length} 文字 → ${after.instructions.length} 文字)`,
    );
  }
  const keysBefore = before.fields.map((field) => field.key);
  const keysAfter = after.fields.map((field) => field.key);
  const labelOf = (key) => (after.fields.find((f) => f.key === key) ?? before.fields.find((f) => f.key === key)).label;
  const removed = keysBefore.filter((key) => !keysAfter.includes(key));
  const added = keysAfter.filter((key) => !keysBefore.includes(key));
  if (removed.length > 0) lines.push(`なくした項目: ${removed.map(labelOf).join('、')}`);
  if (added.length > 0) lines.push(`足した項目: ${added.map(labelOf).join('、')}`);
  const common = (keys) => keys.filter((key) => keysBefore.includes(key) && keysAfter.includes(key));
  // 前からある項目の順が変わったときと、足した項目を前からある項目より前に入れたとき
  const lastCommon = Math.max(-1, ...common(keysAfter).map((key) => keysAfter.indexOf(key)));
  const addedInFront = added.some((key) => keysAfter.indexOf(key) < lastCommon);
  if (common(keysBefore).join() !== common(keysAfter).join() || addedInFront) {
    // モックは、未定の項目を並びの順に聞く
    lines.push(`聞く順と項目の並び: ${keysBefore.map(labelOf).join('、')} → ${keysAfter.map(labelOf).join('、')}`);
  }
  for (const key of common(keysAfter)) {
    const was = before.fields.find((f) => f.key === key);
    const now = after.fields.find((f) => f.key === key);
    if (was.label !== now.label) lines.push(`項目の名前: ${quote(was.label)} → ${quote(now.label)}`);
    if (was.question !== now.question) lines.push(`${now.label}を聞く文: ${quote(was.question)} → ${quote(now.question)}`);
    const rest = ({ label, question, required, ...other }) => JSON.stringify(other);
    if (rest(was) !== rest(now)) lines.push(`${now.label}の読み取り方(選択肢、言葉、数の範囲など)を変えました`);
  }
  // 項目の並びが変わっても、値が同じなら変わったとしない
  const initialChanged = common(keysAfter).some((key) => before.initialState[key] !== after.initialState[key])
    || added.some((key) => after.initialState[key] !== null);
  if (initialChanged) lines.push('項目の最初の値を変えました');
  lines.push(...describeFlowChanges(before, after, labelOf), ...describeRuleChanges(before.rules, after.rules));
  for (const [key, label] of Object.entries(MOCK_LABELS)) {
    if (before.mock[key] !== after.mock[key]) lines.push(`モックの${label}: ${quote(before.mock[key])} → ${quote(after.mock[key])}`);
  }
  for (const intent of INTENTS) {
    const words = (definition) => (definition.mock.intents[intent] ?? []).map((word) => `「${word}」`).join('、') || 'なし';
    if (words(before) !== words(after)) lines.push(`モックが ${intent} と読む言葉: ${words(before)} → ${words(after)}`);
  }
  return lines;
}

// 遷移の条件を、利用者向けの文にする(harness の決定の理由にも使う)
export function describeWhen(when, labelOf) {
  const parts = [];
  if (when.filled === 'required') parts.push('必須の項目が埋まった');
  else if (when.filled) parts.push(`${when.filled.map(labelOf).join('、')}が埋まった`);
  if (when.intent) parts.push(`利用者が${INTENT_LABELS[when.intent]}`);
  if (when.turnsAtLeast) parts.push(`${when.turnsAtLeast} ターン以上たった`);
  return `${parts.join(' かつ ')}とき`;
}

const describeMoves = (step, labelOf) =>
  step.next.filter((item) => item.to !== END_STEP).map((item) => `${describeWhen(item.when, labelOf)}段「${item.to}」へ`).join('、') || 'なし';

const describeEnds = (step, labelOf) =>
  step.next.filter((item) => item.to === END_STEP).map((item) => `${describeWhen(item.when, labelOf)}終わる`);

const describeOrder = (step, labelOf) =>
  step.next.map((item) => `${describeWhen(item.when, labelOf)}${item.to === END_STEP ? '終わる' : `段「${item.to}」へ`}`).join('、');

function describeStep(step, labelOf) {
  const ends = describeEnds(step, labelOf);
  return [
    `聞く項目 ${step.ask.map(labelOf).join('、') || 'なし'}`,
    `言うこと ${SAY_LABELS[step.say] ?? 'なし'}`,
    `進む先 ${describeMoves(step, labelOf)}`,
    ...(ends.length > 0 ? [ends.join('、')] : []),
  ].join('、');
}

// どの段で、どの条件のときに終わるか
const endConditions = (definition, labelOf) =>
  definition.flow.steps
    .flatMap((step) => step.next.filter((item) => item.to === END_STEP).map((item) => `段「${step.id}」で${describeWhen(item.when, labelOf)}`))
    .join(' または ') || 'なし(flow.maxTurns のターン数で終わる)';

// 段、終わる条件の変化。項目を足す、なくす、並べ替えるだけで変わる「全部の項目を順に聞く」段は、項目の行で知らせる
function describeFlowChanges(before, after, labelOf) {
  const lines = [];
  const stepsBefore = before.flow.steps;
  const stepsAfter = after.flow.steps;
  const idsBefore = stepsBefore.map((step) => step.id);
  const idsAfter = stepsAfter.map((step) => step.id);
  const removed = idsBefore.filter((id) => !idsAfter.includes(id));
  if (removed.length > 0) lines.push(`なくした段: ${removed.map((id) => `「${id}」`).join('、')}`);
  for (const step of stepsAfter.filter((s) => !idsBefore.includes(s.id))) lines.push(`足した段「${step.id}」: ${describeStep(step, labelOf)}`);
  if (idsBefore[0] !== idsAfter[0]) lines.push(`最初の段: 「${idsBefore[0]}」 → 「${idsAfter[0]}」`);
  const asksAll = (step, definition) => step.ask.join() === definition.fields.map((field) => field.key).join();
  for (const now of stepsAfter) {
    const was = stepsBefore.find((step) => step.id === now.id);
    if (!was) continue;
    if (was.ask.join() !== now.ask.join() && !(asksAll(was, before) && asksAll(now, after))) {
      lines.push(`段「${now.id}」で聞く項目: ${was.ask.map(labelOf).join('、') || 'なし'} → ${now.ask.map(labelOf).join('、') || 'なし'}`);
    }
    if (was.say !== now.say) lines.push(`段「${now.id}」で言うこと: ${SAY_LABELS[was.say] ?? 'なし'} → ${SAY_LABELS[now.say] ?? 'なし'}`);
    if (describeMoves(was, labelOf) !== describeMoves(now, labelOf)) {
      lines.push(`段「${now.id}」から進む先: ${describeMoves(was, labelOf)} → ${describeMoves(now, labelOf)}`);
    } else if (describeEnds(was, labelOf).join() === describeEnds(now, labelOf).join() && describeOrder(was, labelOf) !== describeOrder(now, labelOf)) {
      // 進む先と終わり方は同じで、確かめる順だけが変わった(上から順に確かめ、最初に満たしたもので移る)
      lines.push(`段「${now.id}」で遷移を確かめる順: ${describeOrder(was, labelOf)} → ${describeOrder(now, labelOf)}`);
    }
  }
  const endsBefore = endConditions(before, labelOf);
  const endsAfter = endConditions(after, labelOf);
  if (endsBefore !== endsAfter) lines.push(`終わる条件: ${endsBefore} → ${endsAfter}`);
  // 足した項目となくした項目は、項目の行で知らせる
  const common = after.fields.filter((field) => before.fields.some((f) => f.key === field.key));
  const required = common.filter((field) => field.required && !before.fields.find((f) => f.key === field.key).required);
  const optional = common.filter((field) => !field.required && before.fields.find((f) => f.key === field.key).required);
  const usesRequired = (definition) => definition.flow.steps.some((step) => step.next.some((item) => item.when.filled === 'required'));
  const requiredMatters = usesRequired(before) || usesRequired(after);
  if (requiredMatters && required.length > 0) lines.push(`終わる条件に入れた項目(required): ${required.map((field) => field.label).join('、')}`);
  if (requiredMatters && optional.length > 0) lines.push(`終わる条件から外した項目(required): ${optional.map((field) => field.label).join('、')}`);
  if (before.flow.maxTurns !== after.flow.maxTurns) lines.push(`会話を終えるターン数(flow.maxTurns): ${before.flow.maxTurns} → ${after.flow.maxTurns}`);
  if (before.end.say !== after.end.say) lines.push(`終わったときに言うこと(end): ${SAY_LABELS[before.end.say]} → ${SAY_LABELS[after.end.say]}`);
  return lines;
}

function describeRuleChanges(before, after) {
  const lines = [];
  const onOff = (value) => (value ? 'する' : 'しない');
  for (const [key, label] of Object.entries(RULE_LABELS)) {
    if (before[key] !== after[key]) lines.push(`守ること「${label}」: ${onOff(before[key])} → ${onOff(after[key])}`);
  }
  if (before.maxReplyChars !== after.maxReplyChars) {
    lines.push(`守ること「返事の長さの上限(maxReplyChars)」: ${before.maxReplyChars} 文字 → ${after.maxReplyChars} 文字`);
  }
  const added = after.forbidden.filter((word) => !before.forbidden.includes(word));
  const removed = before.forbidden.filter((word) => !after.forbidden.includes(word));
  if (added.length > 0) lines.push(`守ること「禁止の言葉(forbidden)」に足した: ${added.map(quote).join('、')}`);
  if (removed.length > 0) lines.push(`守ること「禁止の言葉(forbidden)」から外した: ${removed.map(quote).join('、')}`);
  return lines;
}
