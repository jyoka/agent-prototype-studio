import fs from 'node:fs/promises';
import path from 'node:path';
import { describeTarget } from './operations.js';

// シナリオの形と検査(docs/design/harness.md の 3.3)。シナリオは app/<目録の scenarios>/*.json に置く。
// 手順は、観察器の 7 つの操作(do)と、4 つの確かめ(expect)から作る。
// 対象は役割と名前、ラベル、文字、領域で指す。CSS のセレクターは使わない(作る AI と人が読めるため)。
// 題材の言葉は、シナリオの中にだけ書く。この形は題材に依存しない。

export const VIEWPORT_NAMES = Object.freeze(['mobile', 'tablet', 'desktop']);
export const ACTIONS = Object.freeze(['read', 'inspect', 'click', 'type', 'scroll', 'viewport', 'screenshot']);
export const EXPECTS = Object.freeze(['text', 'visible', 'noErrors', 'aiState']);
export const SCROLL_ENDS = Object.freeze(['top', 'bottom']);

export const SCENARIO_LIMITS = Object.freeze({
  maxScenarios: 20,
  maxSteps: 50,
  maxName: 100,
  maxText: 1000,
  maxFileBytes: 64 * 1024,
});

const TOP_KEYS = ['name', 'viewport', 'steps'];
const TARGET_KINDS = ['role', 'label', 'text', 'region'];
// 手順ごとに書ける項目と、なくてはならない項目
const STEP_KEYS = {
  read: { allowed: [], required: [] },
  inspect: { allowed: ['target'], required: [] },
  click: { allowed: ['target'], required: ['target'] },
  type: { allowed: ['target', 'text'], required: ['target', 'text'] },
  scroll: { allowed: ['target', 'to'], required: [] },
  viewport: { allowed: ['viewport'], required: ['viewport'] },
  screenshot: { allowed: ['name'], required: ['name'] },
  text: { allowed: ['target', 'contains'], required: ['contains'] },
  visible: { allowed: ['target'], required: [] },
  noErrors: { allowed: [], required: [] },
  aiState: { allowed: ['key', 'equals'], required: ['key', 'equals'] },
};

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const quote = (value) => JSON.stringify(value) ?? String(value);

class Problems {
  constructor(file, scenario) {
    this.file = file;
    this.scenario = scenario;
    this.list = [];
  }

  // step は 1 から数える(人が読む番号)。シナリオ全体の誤りは null
  add(step, text) {
    const where = step === null ? '' : `${step} 番目の手順: `;
    this.list.push({ file: this.file, scenario: this.scenario, step, text: `${where}${text}` });
  }
}

function checkText(problems, step, key, value, { max = SCENARIO_LIMITS.maxText, allowEmpty = false } = {}) {
  if (typeof value !== 'string' || (!allowEmpty && value.trim() === '')) {
    problems.add(step, `${key} は空でない文字列で書いてください(今の値: ${quote(value)})`);
    return false;
  }
  if (value.length > max) {
    problems.add(step, `${key} が長すぎます(上限 ${max} 文字)`);
    return false;
  }
  return true;
}

function checkTarget(problems, step, target) {
  if (!isPlainObject(target)) {
    problems.add(step, `target は { "role": …, "name": … }、{ "label": … }、{ "text": … }、{ "region": … } のどれかで書いてください`);
    return;
  }
  if (Object.hasOwn(target, 'selector') || Object.hasOwn(target, 'css')) {
    problems.add(step, 'CSS のセレクターは使えません。役割と名前、ラベル、文字、領域で指してください');
    return;
  }
  const kinds = TARGET_KINDS.filter((kind) => Object.hasOwn(target, kind));
  if (kinds.length !== 1) {
    problems.add(step, `target には ${TARGET_KINDS.join('、')} のどれか 1 つを書いてください(今は ${kinds.length === 0 ? 'なし' : kinds.join('、')})`);
    return;
  }
  const allowed = kinds[0] === 'role' ? ['role', 'name'] : kinds;
  for (const key of Object.keys(target)) {
    if (allowed.includes(key)) continue;
    if (key === 'name') problems.add(step, 'target の name は role と一緒に書いてください');
    else problems.add(step, `target の「${key}」は使えない項目です。使える項目: role と name、label、text、region`);
  }
  for (const key of allowed) {
    if (Object.hasOwn(target, key)) checkText(problems, step, `target.${key}`, target[key], { max: SCENARIO_LIMITS.maxName });
  }
}

function checkStep(problems, step, raw) {
  if (!isPlainObject(raw)) {
    problems.add(step, '{ "do": … } か { "expect": … } のオブジェクトで書いてください');
    return;
  }
  const hasDo = Object.hasOwn(raw, 'do');
  const hasExpect = Object.hasOwn(raw, 'expect');
  if (hasDo === hasExpect) {
    problems.add(step, 'do(操作)か expect(確かめ)のどちらか 1 つを書いてください');
    return;
  }
  const kind = hasDo ? raw.do : raw.expect;
  const names = hasDo ? ACTIONS : EXPECTS;
  if (!names.includes(kind)) {
    problems.add(step, `知らない ${hasDo ? 'do' : 'expect'} です: ${quote(kind)}(使えるもの: ${names.join('、')})`);
    return;
  }
  const { allowed, required } = STEP_KEYS[kind];
  const label = `${hasDo ? 'do' : 'expect'} が ${kind} の手順`;
  for (const key of Object.keys(raw)) {
    if (key !== 'do' && key !== 'expect' && !allowed.includes(key)) {
      problems.add(step, `${label}に「${key}」は書けません${allowed.length > 0 ? `。書ける項目: ${allowed.join('、')}` : ''}`);
    }
  }
  for (const key of required) {
    if (!Object.hasOwn(raw, key)) problems.add(step, `${label}には ${key} が要ります${key === 'target' ? '(対象がありません)' : ''}`);
  }
  if (Object.hasOwn(raw, 'target')) checkTarget(problems, step, raw.target);
  if (kind === 'type' && Object.hasOwn(raw, 'text')) checkText(problems, step, 'text', raw.text, { allowEmpty: true });
  if (kind === 'text' && Object.hasOwn(raw, 'contains')) checkText(problems, step, 'contains', raw.contains);
  if (kind === 'screenshot' && Object.hasOwn(raw, 'name')) checkText(problems, step, 'name', raw.name, { max: SCENARIO_LIMITS.maxName });
  if (kind === 'viewport' && Object.hasOwn(raw, 'viewport') && !VIEWPORT_NAMES.includes(raw.viewport)) {
    problems.add(step, `viewport の値が違います: ${quote(raw.viewport)}(${VIEWPORT_NAMES.join('、')} から選ぶ)`);
  }
  if (kind === 'scroll') {
    if (Object.hasOwn(raw, 'target') && Object.hasOwn(raw, 'to')) problems.add(step, 'scroll には target か to のどちらか 1 つを書いてください');
    if (Object.hasOwn(raw, 'to') && !SCROLL_ENDS.includes(raw.to)) {
      problems.add(step, `to の値が違います: ${quote(raw.to)}(${SCROLL_ENDS.join('、')} から選ぶ)`);
    }
  }
  if (kind === 'aiState') {
    if (Object.hasOwn(raw, 'key')) checkText(problems, step, 'key', raw.key, { max: 64 });
    const value = raw.equals;
    if (Object.hasOwn(raw, 'equals') && !(value === null || Number.isFinite(value) || (typeof value === 'string' && value.length <= SCENARIO_LIMITS.maxText))) {
      problems.add(step, `equals は文字列、数、null のどれかで書いてください(今の値: ${quote(value)})`);
    }
  }
}

// シナリオ 1 本を検査する。file は誤りに添える場所(app/scenarios/<名前>.json)。
// 返す scenario は、検査を通った写し(凍らせてある)。誤りがあれば scenario は null
export function checkScenario(raw, { file = null } = {}) {
  const name = isPlainObject(raw) && typeof raw.name === 'string' ? raw.name : null;
  const problems = new Problems(file, name);
  if (!isPlainObject(raw)) {
    problems.add(null, '全体を { "name": …, "steps": […] } のオブジェクトで書いてください');
    return { scenario: null, errors: problems.list };
  }
  for (const key of Object.keys(raw)) {
    if (!TOP_KEYS.includes(key)) problems.add(null, `「${key}」は使えない項目です。使える項目: ${TOP_KEYS.join('、')}`);
  }
  checkText(problems, null, 'name', raw.name, { max: SCENARIO_LIMITS.maxName });
  if (raw.viewport !== undefined && !VIEWPORT_NAMES.includes(raw.viewport)) {
    problems.add(null, `viewport の値が違います: ${quote(raw.viewport)}(${VIEWPORT_NAMES.join('、')} から選ぶ)`);
  }
  if (!Array.isArray(raw.steps) || raw.steps.length === 0 || raw.steps.length > SCENARIO_LIMITS.maxSteps) {
    problems.add(null, `steps は 1 個から ${SCENARIO_LIMITS.maxSteps} 個までの手順の配列で書いてください`);
  } else {
    raw.steps.forEach((step, i) => checkStep(problems, i + 1, step));
  }
  if (problems.list.length > 0) return { scenario: null, errors: problems.list };
  return { scenario: deepFreeze(structuredClone({ name: raw.name, viewport: raw.viewport ?? 'desktop', steps: raw.steps })), errors: [] };
}

function deepFreeze(value) {
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
}

// 手順が期待すること(人と作る AI が読む文)。関門 G6 の失敗の「期待」に使う。書き方は operations.js の失敗の文にそろえる
export function describeStep(step) {
  if (!isPlainObject(step)) return quote(step);
  const target = describeTarget(step.target ?? null);
  switch (step.do) {
    case 'read':
      return '画面を読める';
    case 'inspect':
      return `${target} を調べられる`;
    case 'click':
      return `${target} を押せる`;
    case 'type':
      return `${target} に「${step.text}」を入力できる`;
    case 'scroll':
      return step.target ? `${target} までスクロールできる` : `ページの${step.to === 'top' ? '上' : '下'}の端までスクロールできる`;
    case 'viewport':
      return `画面幅を ${step.viewport} にできる`;
    case 'screenshot':
      return `「${step.name}」の画面を撮れる`;
    default:
      break;
  }
  switch (step.expect) {
    case 'text':
      return `${target} に「${step.contains}」がある`;
    case 'visible':
      return step.target ? `${target} が見える` : '描画が空でない';
    case 'noErrors':
      return 'ここまでにエラーがない';
    case 'aiState':
      return `プロダクト内 AI の状態の「${step.key}」が ${quote(step.equals)} になる`;
    default:
      return quote(step);
  }
}

// Studio の基本のシナリオ。Studio のコードの中にだけ持ち、app/ からは変えられない(harness.md 2.3、3.3)。
// 起動して描画が空でない、エラーがない。AI のある試作品では、あいさつ(ai.json の mock.greeting)が出る。
// 返すシナリオは凍らせてあり、呼ぶ所ごとに新しく作る
export function baseScenarios({ greeting = '' } = {}) {
  const list = [
    {
      name: '起動して描画が空でなく、エラーがない',
      viewport: 'desktop',
      steps: [{ expect: 'visible' }, { expect: 'noErrors' }],
    },
  ];
  if (typeof greeting === 'string' && greeting.trim() !== '') {
    list.push({
      name: 'プロダクト内 AI のあいさつが出る',
      viewport: 'desktop',
      steps: [{ expect: 'text', contains: greeting.slice(0, SCENARIO_LIMITS.maxText) }],
    });
  }
  return list.map((scenario) => deepFreeze(scenario));
}

// app/<folder>/*.json を名前の順に読み、検査する。フォルダーがなければ空。
// 読めないファイルや形の誤りは、errors に、どのファイル(とシナリオ、手順)がどう違うかで返す
export async function readScenarios(appDir, folder = 'scenarios') {
  const dir = path.join(appDir, ...folder.split('/'));
  const shown = (name) => `app/${folder}/${name}`;
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch((error) => {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return [];
    throw error;
  });
  const files = entries
    .filter((entry) => entry.name.endsWith('.json'))
    .map((entry) => entry.name)
    .sort();
  const scenarios = [];
  const errors = [];
  if (files.length > SCENARIO_LIMITS.maxScenarios) {
    errors.push({ file: `app/${folder}/`, scenario: null, step: null, text: `シナリオが多すぎます(${files.length} 本。上限 ${SCENARIO_LIMITS.maxScenarios} 本)` });
    return { scenarios, errors };
  }
  for (const name of files) {
    const file = shown(name);
    const full = path.join(dir, name);
    const stat = await fs.lstat(full);
    if (!stat.isFile()) {
      errors.push({ file, scenario: null, step: null, text: '普通のファイルにしてください' });
      continue;
    }
    if (stat.size > SCENARIO_LIMITS.maxFileBytes) {
      errors.push({ file, scenario: null, step: null, text: `ファイルが大きすぎます(上限 ${SCENARIO_LIMITS.maxFileBytes} バイト)` });
      continue;
    }
    let raw;
    try {
      raw = JSON.parse(await fs.readFile(full, 'utf8'));
    } catch (error) {
      errors.push({ file, scenario: null, step: null, text: `JSON として読めません(${error.message})` });
      continue;
    }
    const checked = checkScenario(raw, { file });
    if (checked.scenario) scenarios.push({ file, scenario: checked.scenario });
    errors.push(...checked.errors);
  }
  return { scenarios, errors };
}
