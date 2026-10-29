import { ID_PATTERN, isPlainObject } from './check.js';
import { parseEval } from './evals.js';

// jyoka/tasks#327 の場面の一覧(aica の evals/scenes/<入り口>/<種類>.json。中身は場面の配列)を、
// Studio の場面(app/evals/*.json。docs/design/agent-simulation.md の 4.2)に変換する。
// 変換できない確かめ(aica の harness の状態を見るものなど)は、場面に入れずに「変換できない」として返す。
// 題材の言葉(入り口の名前、観点の文)は Studio のコードに持たない。入り口の当て方と観点の文は、呼ぶ側が渡す。

export const IMPORT_SOURCE = 'jyoka/tasks#327 の場面の一覧(aica の evals/scenes/)';

// #327 の種類(category)と、Studio の場面の種類(kind)の対応。t326 などの当てられない種類は、呼ぶ側が kinds で当てる
export const CATEGORY_KINDS = {
  chat: 'aside',
  ask: 'question',
  multi: 'multi',
  correct: 'correct',
  emotion: 'emotion',
  safety: 'risky',
  short: 'short',
  flow: 'control',
  switch: 'switch',
};

// 返事を見る確かめ(複数の発言の場面で、何番目の返信を見るか at の扱いが違う)
const REPLY_CHECKS = new Set(['reply_contains', 'reply_not_contains', 'bubble_max', 'no_made_up_number', 'no_repeat']);
const ABOUT_MAX = 200;

const issue = (check, reason) => ({ check, reason });

// 1 つの確かめを変換する。返す: { items: [Studio の確かめ], problem?: 変換できない理由 }
function convertCheck(item, { says, rubrics, passAtLeast }) {
  const name = item.check;
  if (REPLY_CHECKS.has(name) && says.length > 1 && item.at !== 'all') {
    // Studio の返事の確かめは、場面の全部の返事を見る。aica の既定(最後の返信)や番号を指す at とは意味が違う
    return { items: [], problem: `何番目の返信を見るか(at: ${JSON.stringify(item.at ?? '最後')})は、Studio の確かめにない` };
  }
  switch (name) {
    case 'reply_contains': {
      const any = Array.isArray(item.any) ? item.any.filter((t) => typeof t === 'string' && t !== '') : [];
      if (any.length !== 1) return { items: [], problem: '「どれか 1 つを含む」(any が 2 つ以上)は、Studio の確かめにない' };
      if (item.at === 'all') return { items: [], problem: '「すべての返信が含む」は、Studio の確かめにない(replyContains はどれかの返事)' };
      return { items: [{ check: 'replyContains', text: any[0] }] };
    }
    case 'reply_not_contains': {
      const texts = Array.isArray(item.texts) ? item.texts.filter((t) => typeof t === 'string' && t !== '') : [];
      if (texts.length === 0) return { items: [], problem: 'texts がない' };
      return { items: texts.map((text) => ({ check: 'replyNotContains', text })) };
    }
    case 'bubble_max':
      if (!Number.isInteger(item.chars) || item.chars < 1) return { items: [], problem: 'chars が正の整数でない' };
      // aica は空白を数えない。Studio は空白も数えるので、少し厳しくなる
      return { items: [{ check: 'replyMaxChars', value: item.chars }] };
    case 'no_made_up_number':
      return { items: [{ check: 'noNewNumbers' }] };
    case 'no_repeat':
      // aica は「turns 回続けて出ない」。Studio は「続けて times 回まで」
      if (!Number.isInteger(item.turns) || item.turns < 2) return { items: [], problem: 'turns が 2 以上の整数でない' };
      return { items: [{ check: 'noRepeat', times: Math.min(item.turns - 1, 10) }] };
    default:
      break;
  }
  if (Object.hasOwn(rubrics, name)) {
    let rubric = String(rubrics[name]);
    if (Array.isArray(item.facts) && item.facts.length > 0) rubric += `\n渡した事実: ${item.facts.map(String).join(' / ')}`;
    return { items: [{ check: 'judge', aspect: name.slice(0, 40), rubric: rubric.slice(0, 1000), passAtLeast }] };
  }
  return { items: [], problem: 'Studio の確かめにない(aica の harness の状態、部品の並び、呼び出しの数などを見る)' };
}

// 場面の配列を変換する。
//   entries: { #327 の入り口: Studio の参加者の id }。書いていない入り口は entry を書かない(回し手から始める)
//   kinds: { #327 の種類: Studio の場面の種類 }(CATEGORY_KINDS に足す・上書きする)
//   rubrics: { 採点の条件の名前: 観点の文 }。書いていない採点の条件は「変換できない」
//   prefix: 場面の id の頭に付ける語。passAtLeast: 採点の合格の点(既定 4)
// 返す: { evals: [{ file, scenario }], skipped: [{ id, reason }], unconverted: [{ id, check, reason }], notes: [{ id, text }] }
export function importScenes(scenes, { entries = {}, kinds = {}, rubrics = {}, prefix = '', passAtLeast = 4 } = {}) {
  const kindOf = { ...CATEGORY_KINDS, ...kinds };
  const evals = [];
  const skipped = [];
  const unconverted = [];
  const notes = [];
  const seen = new Set();
  for (const scene of Array.isArray(scenes) ? scenes : []) {
    const sourceId = isPlainObject(scene) && typeof scene.id === 'string' ? scene.id : '(id なし)';
    const skip = (reason) => skipped.push({ id: sourceId, reason });
    if (!isPlainObject(scene)) {
      skip('場面が { … } のオブジェクトでない');
      continue;
    }
    if (typeof scene.id !== 'string' || scene.id === '') {
      skip('id がない');
      continue;
    }
    const id = `${prefix}${scene.id}`.toLowerCase().replace(/[^a-z0-9-]/g, '-');
    if (!ID_PATTERN.test(id)) {
      skip(`id「${id}」が Studio の id の形(英小文字で始め、英小文字、数字、- だけで 40 字まで)に合わない`);
      continue;
    }
    if (seen.has(id)) {
      skip(`id「${id}」が重なっている`);
      continue;
    }
    const kind = kindOf[scene.category];
    if (!kind) {
      skip(`種類「${scene.category}」を Studio の場面の種類に当てられない(kinds で当てる)`);
      continue;
    }
    const says = Array.isArray(scene.says) ? scene.says.filter((s) => isPlainObject(s) && typeof s.text === 'string') : [];
    if (says.length === 0) {
      skip('本人の発言(says)がない');
      continue;
    }
    const expect = [];
    for (const item of Array.isArray(scene.expect) ? scene.expect : []) {
      if (!isPlainObject(item) || typeof item.check !== 'string') continue;
      const { items, problem } = convertCheck(item, { says, rubrics, passAtLeast });
      if (problem) unconverted.push({ id: sourceId, ...issue(item.check, problem) });
      expect.push(...items);
    }
    // 前の会話の値は、Studio の場面に入れる所がない(history は harness の状態を変えない)
    const lost = ['known', 'profile', 'segment', 'asking', 'form'].filter((key) => scene[key] !== undefined);
    if (lost.length > 0) notes.push({ id: sourceId, text: `前の会話の値(${lost.join('、')})は変換しない。Studio の場面は history だけを渡す` });
    if (says.some((s) => s.button === true)) notes.push({ id: sourceId, text: '押したボタンは、ボタンの文を発言として送る' });
    if (expect.length === 0) {
      skip('変換できる確かめが 1 つもない');
      continue;
    }
    const scenario = {
      formatVersion: 1,
      id,
      kind,
      about: String(scene.title ?? '').slice(0, ABOUT_MAX) || undefined,
      ...(entries[scene.entry] ? { entry: entries[scene.entry] } : {}),
      ...(Array.isArray(scene.history) && scene.history.length > 0
        ? { history: scene.history.filter((m) => isPlainObject(m) && typeof m.text === 'string').map((m) => ({ role: m.who === 'user' ? 'user' : 'assistant', text: m.text })) }
        : {}),
      turns: says.map((s) => ({ user: s.text })),
      expect: expect.slice(0, 20),
    };
    if (scenario.about === undefined) delete scenario.about;
    if (scenario.history?.length === 0) delete scenario.history;
    if (expect.length > 20) unconverted.push({ id: sourceId, ...issue('expect', `確かめが 20 を超えたので、21 番目から外した`) });
    // 変換した場面を Studio の検査に通す(ツールの名前は確かめない)
    const file = `${id}.json`;
    const parsed = parseEval(scenario, { file, toolNames: new Set() });
    if (!parsed.scenario) {
      skip(`変換した場面が検査を通らない(${parsed.errors.map((e) => e.text).join(' / ').slice(0, 300)})`);
      continue;
    }
    seen.add(id);
    evals.push({ file, scenario });
  }
  return { evals, skipped, unconverted, notes };
}
