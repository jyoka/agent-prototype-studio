import { ASSUMPTION_LIMITS, PART_KINDS } from './assumptions.js';
import {
  ACTION_PATTERN,
  Problems,
  checkKeys,
  formatVersion,
  integer,
  isPlainObject,
  jsonValue,
  list,
  listJsonFiles,
  named,
  oneOf,
  readAppJson,
  text,
  texts,
  toolNameOf,
} from './check.js';

// 模擬のエージェントのモックの決まり(app/mocks/*.json)。同じ入力で同じ返事と同じツールの呼び出しを返す。
// 品質を測るものではなく、関門とテストで、ツールの口と会話の進め方を確かめるために使う(docs/design/agent-simulation.md の 3.3)。
export const DEFAULT_MOCKS = 'mocks';
// 決まりの語(when)。増やせるのは Studio のコードだけ
export const MOCK_CONDITIONS = ['contains', 'action', 'turnsAtLeast'];
// 返事の型で使える置き換え。ツールの結果の数と見出しだけ
export const MOCK_PLACEHOLDERS = ['{result.count}', '{result.titles}'];

export const MOCK_LIMITS = {
  maxFiles: 50,
  maxRules: 50,
  maxWords: 20,
  maxCards: 10,
  maxTurns: 30,
};

const TOP_KEYS = ['formatVersion', 'rules', 'otherwise'];
const RULE_KEYS = ['when', 'call', 'reply'];
const PART_KEYS = {
  text: ['kind', 'text'],
  buttons: ['kind', 'items'],
  card: ['kind', 'title', 'text', 'items'],
  carousel: ['kind', 'cards'],
  notice: ['kind', 'text'],
};

function placeholders(problems, where, value, { withResult }) {
  for (const found of value.match(/\{[^{}]*\}/g) ?? []) {
    if (!MOCK_PLACEHOLDERS.includes(found)) problems.add(where, `${found} は使えない置き換えです。使える置き換え: ${MOCK_PLACEHOLDERS.join('、')}`);
    else if (!withResult) problems.add(where, `${found} は、ツールを呼ぶ決まり(call)の返事でだけ使えます`);
  }
}

function partText(problems, where, value, { required = true, withResult, max = ASSUMPTION_LIMITS.textMaxChars }) {
  const result = text(problems, where, value, { required, max });
  if (result !== undefined) placeholders(problems, where, result, { withResult });
  return result;
}

// ボタンは文か { "label": 文, "action": 名前 }
function buttons(problems, where, value, options) {
  const items = list(problems, where, value, { min: 1, max: ASSUMPTION_LIMITS.buttonsMax }) ?? [];
  for (const [i, item] of items.entries()) {
    const at = `${where}[${i}]`;
    if (typeof item === 'string') {
      partText(problems, at, item, { ...options, max: 40 });
      continue;
    }
    if (!isPlainObject(item)) {
      problems.add(at, '文か { "label": …, "action": … } で書いてください');
      continue;
    }
    checkKeys(problems, at, item, ['label', 'action']);
    partText(problems, `${at}.label`, item.label, { ...options, max: 40 });
    named(problems, `${at}.action`, item.action, ACTION_PATTERN, { required: false, hint: '英小文字で始め、英小文字、数字、_、- だけで 40 字まで' });
  }
}

function card(problems, where, value, options) {
  checkKeys(problems, where, value, PART_KEYS.card);
  partText(problems, `${where}.title`, value.title, { ...options, max: 100 });
  partText(problems, `${where}.text`, value.text, { ...options, required: false });
  if (value.items !== undefined) buttons(problems, `${where}.items`, value.items, options);
}

// 返事の部品の並び。部品の種類は会話の枠の 5 つ(3.8)
export function checkParts(problems, where, value, { withResult = false } = {}) {
  const parts = list(problems, where, value, { min: 1, max: ASSUMPTION_LIMITS.partsMax, of: '部品の' }) ?? [];
  for (const [i, part] of parts.entries()) {
    const at = `${where}[${i}]`;
    if (!isPlainObject(part)) {
      problems.add(at, `{ "kind": …, … } の形で書いてください。kind: ${PART_KINDS.join(', ')}`);
      continue;
    }
    const kind = oneOf(problems, `${at}.kind`, part.kind, PART_KINDS, { label: '部品の種類' });
    if (!kind) continue;
    const options = { withResult };
    if (kind === 'card') {
      card(problems, at, part, options);
      continue;
    }
    checkKeys(problems, at, part, PART_KEYS[kind]);
    if (kind === 'text' || kind === 'notice') partText(problems, `${at}.text`, part.text, options);
    if (kind === 'buttons') buttons(problems, `${at}.items`, part.items, options);
    if (kind === 'carousel') {
      const cards = list(problems, `${at}.cards`, part.cards, { min: 1, max: MOCK_LIMITS.maxCards, of: 'カードの' }) ?? [];
      for (const [j, item] of cards.entries()) {
        if (!isPlainObject(item)) problems.add(`${at}.cards[${j}]`, '{ "title": …, "text": … } の形で書いてください');
        else card(problems, `${at}.cards[${j}]`, item, options);
      }
    }
  }
  return parts;
}

// モックの決まりを検査する。どのツールを呼べるかは、使う参加者の tools で決まるので、構成の検査で確かめる
export function parseMock(raw, { file }) {
  const problems = new Problems(`app/${file}`);
  if (!isPlainObject(raw)) {
    problems.add('', '全体を { … } のオブジェクトで書いてください');
    return { mock: null, errors: problems.list };
  }
  checkKeys(problems, '', raw, TOP_KEYS);
  formatVersion(problems, raw);
  const rules = [];
  if (raw.rules !== undefined) {
    const items = list(problems, 'rules', raw.rules, { max: MOCK_LIMITS.maxRules, of: '決まりの' }) ?? [];
    for (const [i, rule] of items.entries()) {
      const where = `rules[${i}]`;
      if (!isPlainObject(rule)) {
        problems.add(where, '{ "when": { … }, "reply": […] } の形で書いてください');
        continue;
      }
      checkKeys(problems, where, rule, RULE_KEYS);
      if (!isPlainObject(rule.when) || Object.keys(rule.when).length === 0) {
        problems.add(`${where}.when`, `{ ${MOCK_CONDITIONS.join('、')} のどれか } の形で書いてください`);
      } else {
        for (const key of Object.keys(rule.when)) {
          if (!MOCK_CONDITIONS.includes(key)) problems.add(`${where}.when`, `${JSON.stringify(key)} は知らない条件です。使える条件: ${MOCK_CONDITIONS.join(', ')}`);
        }
        if (rule.when.contains !== undefined) texts(problems, `${where}.when.contains`, rule.when.contains, { min: 1, max: MOCK_LIMITS.maxWords, maxChars: 30 });
        named(problems, `${where}.when.action`, rule.when.action, ACTION_PATTERN, { required: false, hint: '英小文字で始め、英小文字、数字、_、- だけで 40 字まで' });
        integer(problems, `${where}.when.turnsAtLeast`, rule.when.turnsAtLeast, { min: 1, max: MOCK_LIMITS.maxTurns });
      }
      let call = null;
      if (rule.call !== undefined) {
        if (!isPlainObject(rule.call)) problems.add(`${where}.call`, '{ "tool": ツールの名前, "args": { … } } の形で書いてください');
        else {
          checkKeys(problems, `${where}.call`, rule.call, ['tool', 'args']);
          const tool = toolNameOf(problems, `${where}.call.tool`, rule.call.tool);
          const args = rule.call.args ?? {};
          if (!isPlainObject(args)) problems.add(`${where}.call.args`, '{ 引数の名前: 値 } の形で書いてください');
          else jsonValue(problems, `${where}.call.args`, args);
          call = { tool, args };
        }
      }
      checkParts(problems, `${where}.reply`, rule.reply, { withResult: call !== null });
      rules.push({ when: rule.when, call, reply: rule.reply });
    }
  }
  checkParts(problems, 'otherwise', raw.otherwise);
  if (problems.list.length > 0) return { mock: null, errors: problems.list };
  return { mock: { file, rules, otherwise: raw.otherwise }, errors: [] };
}

async function readMock(appDir, file) {
  const { value, error } = await readAppJson(appDir, file);
  if (error) return { mock: null, errors: [{ file: `app/${file}`, text: error }] };
  return parseMock(value, { file });
}

// mocks/ のモックと、構成が指すモック(mocks/ の外でもよい)を読む
export async function readMocks(appDir, folder, extraFiles = []) {
  const { files, errors } = await listJsonFiles(appDir, folder, { max: MOCK_LIMITS.maxFiles, label: 'モックの決まり' });
  const mocks = new Map();
  for (const file of [...new Set([...files, ...extraFiles])]) {
    const parsed = await readMock(appDir, file);
    errors.push(...parsed.errors);
    if (parsed.mock) mocks.set(file, parsed.mock);
  }
  return { mocks, errors };
}
