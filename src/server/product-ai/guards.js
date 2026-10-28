import { formatValue } from './definition.js';

// プロダクト内 AI の返事の、守ることの確かめ(docs/design/harness.md の 4.5)。app/ai.json の rules に書いた 5 つを、
// 返事の文の形で確かめる。意味までは確かめない(「誘導しない」「数字を作らない」も、文字の並びで見るだけ)。
//   noNewNumbers  返事の中の数が、状態の値、利用者の発言、ai.json の作り手の文(問いの原文など)、架空のデータのどれかに出てくる
//   noLeading     利用者がまだ言っていない選択肢の値を、返事に書かない。今聞いている項目の問いの原文の中の選択肢は除く
//   mustAsk       決定が項目を聞くとき、返事にその問いの原文が入っている。入っていなければ、後ろに足す(やり直しはしない)
//   maxReplyChars 返事の文字数
//   forbidden     作り手が書いた禁止の言葉を含まない

export const GUARD_LABELS = {
  noNewNumbers: '数字を作らない',
  noLeading: '誘導しない',
  mustAsk: '聞くべき問いを入れる',
  maxReplyChars: '長さ',
  forbidden: '禁止の言葉',
};

const normalize = (text) => String(text ?? '').normalize('NFKC');

// 算用数字の数。3 桁ごとの区切り(1,300)と小数を 1 つの数として読み、値の書き方にそろえる(1,300 も 1300 も "1300")。
// 漢数字(三、十)は読まない
const NUMBER = /\d+(?:,\d{3})*(?:\.\d+)?/g;
export function numbersIn(text) {
  return [...normalize(text).matchAll(NUMBER)].map((match) => String(Number(match[0].replaceAll(',', ''))));
}

// 利用者の発言。これまでの会話の発言と本人の修正、今の発言
export function utterancesOf(messages, text) {
  return [...messages.filter((m) => m.role === 'user' || m.role === 'correction').map((m) => m.text), text];
}

// 返事に出してよい数。状態の値、利用者の発言、ai.json の作り手の文(名前、項目の名前、問いの原文、選択肢、単位、範囲、mock の型)、架空のデータ。
// 作り手の文を入れるのは、モックの言い方(mock の型)がいつも合うようにするため
function allowedNumbers({ definition, state, utterances, dataNumbers }) {
  const texts = [...utterances, definition.name];
  for (const field of definition.fields) {
    texts.push(field.label, field.question, formatValue(field, state[field.key]));
    if (field.type === 'number') texts.push(field.unit, String(field.min ?? ''), String(field.max ?? ''), String(state[field.key] ?? ''));
    else texts.push(...field.options.map((option) => option.value));
  }
  texts.push(...Object.values(definition.mock).filter((value) => typeof value === 'string'));
  return new Set([...texts.flatMap(numbersIn), ...dataNumbers.flatMap(numbersIn)]);
}

function checkNumbers(body, input) {
  const allowed = allowedNumbers(input);
  const made = [...new Set(numbersIn(body).filter((n) => !allowed.has(n)))];
  return made.length > 0 ? `「${made.join('」「')}」は、状態、利用者の発言、問いの原文、架空のデータのどれにも出てこない数` : null;
}

// 決まったこととして書いてよい選択肢の値: 今の状態の値と、利用者の発言に出てきた値。
// 今聞いている項目の問いの原文は、選択肢を並べてよいので、先に返事から除いて見る
function checkLeading(body, { definition, decision, state, utterances }) {
  const said = normalize(utterances.join('\n'));
  const allowed = [];
  const unsaid = [];
  for (const field of definition.fields) {
    if (field.type !== 'choice') continue;
    for (const { value } of field.options) {
      (state[field.key] === value || said.includes(normalize(value)) ? allowed : unsaid).push(normalize(value));
    }
  }
  // 長い方から除く(「英語の会話」を言ったときに、中の「英語」を言っていないことにしない)
  let rest = body;
  for (const text of [...decision.mustInclude.map(normalize), ...allowed].sort((a, b) => b.length - a.length)) {
    if (text) rest = rest.replaceAll(text, '\u0000');
  }
  const found = [...new Set(unsaid.filter((value) => rest.includes(value)))];
  return found.length > 0 ? `利用者がまだ言っていない「${found.join('」「')}」を書いている` : null;
}

// 返事を確かめる。mustAsk で問いの原文が抜けていたら足してから、ほかの 4 つを確かめる。
// 返す: { reply: 足した後の返事, added: 足した問いの原文(なければ []), failed: [{ rule, detail }] }
// input: { definition, decision, state(決定の後), utterances(utterancesOf), dataNumbers(架空のデータに出てくる数) }
export function checkReply(reply, { definition, decision, state, utterances = [], dataNumbers = [] }) {
  const rules = definition.rules;
  const input = { definition, decision, state, utterances, dataNumbers };
  let text = reply;
  const added = [];
  if (rules.mustAsk) {
    for (const question of decision.mustInclude) {
      if (normalize(text).includes(normalize(question))) continue;
      const trimmed = text.trimEnd();
      text = /[。.!?！？」』)）]$/.test(trimmed) || trimmed === '' ? `${trimmed}${question}` : `${trimmed}。${question}`;
      added.push(question);
    }
  }
  const body = normalize(text);
  const failed = [];
  const fail = (rule, detail) => detail && failed.push({ rule, detail });
  if (rules.noNewNumbers) fail('noNewNumbers', checkNumbers(body, input));
  if (rules.noLeading) fail('noLeading', checkLeading(body, input));
  const length = [...text].length;
  if (length > rules.maxReplyChars) fail('maxReplyChars', `${length} 文字で、上限の ${rules.maxReplyChars} 文字を超えている`);
  const words = rules.forbidden.filter((word) => body.includes(normalize(word)));
  if (words.length > 0) fail('forbidden', `禁止の言葉「${words.join('」「')}」を含む`);
  return { reply: text, added, failed };
}

// やり直しの言い方に渡す、合わなかったところ
export const describeFailures = (failed) => failed.map(({ rule, detail }) => `- ${GUARD_LABELS[rule]}(${rule}): ${detail}`);
