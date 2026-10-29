import { ASSUMPTION_LIMITS, PART_KINDS } from './assumptions.js';
import { ACTION_PATTERN, isPlainObject } from './check.js';

// 模擬のエージェントの返事の部品(docs/design/agent-simulation.md の 3.8)。
// 返事の形(JSON スキーマ)は、前提の messageTypes と、会話の枠が描ける部品の重なりから作る。
// 重なりにない部品は文に落とし、落としたことを記録に残す(S17、S23)。文(text)はいつも使える。

// 前提に messageLimits がないときは、前提の上限(3.4 の表)を使う
const LIMIT_DEFAULTS = {
  textMaxChars: ASSUMPTION_LIMITS.textMaxChars,
  buttonsMax: ASSUMPTION_LIMITS.buttonsMax,
  partsMax: ASSUMPTION_LIMITS.partsMax,
};
// ボタンの文と action、カードの見出し、カルーセルのカードの数(モックの決まりの検査と同じ上限。mocks.js)
const BUTTON_MAX_CHARS = 40;
const TITLE_MAX_CHARS = 100;
const MAX_CARDS = 10;

const clampInt = (value, max, fallback) => (Number.isInteger(value) && value >= 1 ? Math.min(value, max) : fallback);

export function messageLimitsOf(assumption) {
  const limits = isPlainObject(assumption?.messageLimits) ? assumption.messageLimits : {};
  return {
    textMaxChars: clampInt(limits.textMaxChars, ASSUMPTION_LIMITS.textMaxChars, LIMIT_DEFAULTS.textMaxChars),
    buttonsMax: clampInt(limits.buttonsMax, ASSUMPTION_LIMITS.buttonsMax, LIMIT_DEFAULTS.buttonsMax),
    partsMax: clampInt(limits.partsMax, ASSUMPTION_LIMITS.partsMax, LIMIT_DEFAULTS.partsMax),
  };
}

// 返事に使える部品の種類。前提の messageTypes と会話の枠の部品の重なり。文はいつも使える
export function partKindsOf(assumption) {
  const types = Array.isArray(assumption?.messageTypes) ? assumption.messageTypes : ['text'];
  return PART_KINDS.filter((kind) => kind === 'text' || types.includes(kind));
}

// 模擬のエージェントの返事の形(--json-schema に渡す)。{ "parts": [部品, …] }
export function replySchema(assumption) {
  const { textMaxChars, buttonsMax, partsMax } = messageLimitsOf(assumption);
  const textValue = { type: 'string', maxLength: textMaxChars };
  const button = {
    anyOf: [
      { type: 'string', maxLength: BUTTON_MAX_CHARS },
      {
        type: 'object',
        properties: { label: { type: 'string', maxLength: BUTTON_MAX_CHARS }, action: { type: 'string', maxLength: BUTTON_MAX_CHARS } },
        required: ['label'],
        additionalProperties: false,
      },
    ],
  };
  const buttons = { type: 'array', minItems: 1, maxItems: buttonsMax, items: button };
  const cardProperties = { title: { type: 'string', maxLength: TITLE_MAX_CHARS }, text: textValue, items: buttons };
  const card = { type: 'object', properties: cardProperties, required: ['title'], additionalProperties: false };
  const shapes = {
    text: { properties: { text: textValue }, required: ['text'] },
    buttons: { properties: { items: buttons }, required: ['items'] },
    card: { properties: cardProperties, required: ['title'] },
    carousel: { properties: { cards: { type: 'array', minItems: 1, maxItems: MAX_CARDS, items: card } }, required: ['cards'] },
    notice: { properties: { text: textValue }, required: ['text'] },
  };
  const variants = partKindsOf(assumption).map((kind) => ({
    type: 'object',
    properties: { kind: { const: kind }, ...shapes[kind].properties },
    required: ['kind', ...shapes[kind].required],
    additionalProperties: false,
  }));
  return {
    type: 'object',
    properties: { parts: { type: 'array', minItems: 1, maxItems: partsMax, items: { anyOf: variants } } },
    required: ['parts'],
    additionalProperties: false,
  };
}

const isText = (value) => typeof value === 'string' && value.trim() !== '';

// ボタンは { label, action? } にそろえる
function buttonOf(item) {
  if (isText(item)) return { label: item.slice(0, BUTTON_MAX_CHARS) };
  if (isPlainObject(item) && isText(item.label)) {
    // action は、試作品が studio.ai.send で送り返せる形のものだけ残す
    return { label: item.label.slice(0, BUTTON_MAX_CHARS), ...(typeof item.action === 'string' && ACTION_PATTERN.test(item.action) ? { action: item.action } : {}) };
  }
  return null;
}

const buttonsText = (items, numbered = true) => items.map((item, i) => (numbered ? `${i + 1}. ${item.label}` : item.label)).join('\n');
const cardText = (card, numbered = true) => [card.title, card.text, card.items?.length ? buttonsText(card.items, numbered) : ''].filter(Boolean).join('\n');

// 部品を文にする(使えない部品を落とすとき、試し直しの前と後の返事、記録に使う)。
// numbered が false なら、ボタンの並びの番号(「1. 」)を付けない(数の確かめに使う。番号は Studio が付けたもので、返事の数ではない)
export function partText(part, { numbered = true } = {}) {
  if (part.kind === 'text' || part.kind === 'notice') return part.text;
  if (part.kind === 'buttons') return buttonsText(part.items, numbered);
  if (part.kind === 'card') return cardText(part, numbered);
  if (part.kind === 'carousel') return part.cards.map((card) => cardText(card, numbered)).join('\n\n');
  return '';
}

export const partsToText = (parts, options) => (Array.isArray(parts) ? parts.map((part) => partText(part, options)).filter(Boolean).join('\n') : '');

// 行の頭の並びの番号(「1. 」)。使えない部品を文に落としたときに Studio が付けたものと、箇条の番号
const ORDINAL = /^[ \t]*\d{1,2}\. /gm;
// 出口の確かめと場面の確かめで、返事の数を見るときの文。ボタンの番号を付けず、文の部品の行の頭の並びの番号も外す
// (使えない部品を文に落とすと、番号の付いた文の部品になるため)。番号の後ろの文の数は、そのまま確かめる
export const partsToCheckedText = (parts) =>
  Array.isArray(parts)
    ? parts
        .map((part) => (part.kind === 'text' || part.kind === 'notice' ? String(part.text ?? '').replace(ORDINAL, '') : partText(part, { numbered: false })))
        .filter(Boolean)
        .join('\n')
    : '';

// 部品の形をそろえる。形の合わないものは null
function normalizePart(raw, limits) {
  if (!isPlainObject(raw)) return null;
  const clip = (value) => value.slice(0, limits.textMaxChars);
  const buttons = (items) => (Array.isArray(items) ? items.map(buttonOf).filter(Boolean) : []);
  const card = (value) => {
    if (!isPlainObject(value) || !isText(value.title)) return null;
    const items = buttons(value.items);
    return { title: value.title.slice(0, TITLE_MAX_CHARS), ...(isText(value.text) ? { text: clip(value.text) } : {}), ...(items.length ? { items } : {}) };
  };
  switch (raw.kind) {
    case 'text':
    case 'notice':
      return isText(raw.text) ? { kind: raw.kind, text: raw.text } : null;
    case 'buttons': {
      const items = buttons(raw.items);
      return items.length > 0 ? { kind: 'buttons', items } : null;
    }
    case 'card': {
      const value = card(raw);
      return value ? { kind: 'card', ...value } : null;
    }
    case 'carousel': {
      const cards = Array.isArray(raw.cards) ? raw.cards.map(card).filter(Boolean).slice(0, MAX_CARDS) : [];
      return cards.length > 0 ? { kind: 'carousel', cards } : null;
    }
    default:
      return null;
  }
}

// 返事の部品を、前提で使える種類と上限に合わせる。使えない部品は文に落とし、形の合わない部品は除く。
// 返す: { parts, downgrades: [{ from, to, reason }] }。to が null なら除いた
export function fitParts(raw, assumption) {
  const limits = messageLimitsOf(assumption);
  const kinds = partKindsOf(assumption);
  const downgrades = [];
  const items = Array.isArray(raw) ? raw : [];
  if (!Array.isArray(raw)) downgrades.push({ from: 'parts', to: null, reason: '部品の並び(parts)が配列でない' });
  const parts = [];
  for (const item of items) {
    const kind = isPlainObject(item) && typeof item.kind === 'string' ? item.kind.slice(0, 40) : String(typeof item);
    if (parts.length >= limits.partsMax) {
      downgrades.push({ from: kind, to: null, reason: `部品の数が前提の上限(partsMax ${limits.partsMax})を超えた` });
      continue;
    }
    const part = normalizePart(item, limits);
    if (!part) {
      downgrades.push({ from: kind, to: null, reason: '部品の形が合わない' });
      continue;
    }
    if (!kinds.includes(part.kind)) {
      downgrades.push({ from: part.kind, to: 'text', reason: `前提の messageTypes(${kinds.join('、')})にない部品` });
      parts.push({ kind: 'text', text: partText(part) });
      continue;
    }
    if (part.kind === 'buttons' && part.items.length > limits.buttonsMax) {
      downgrades.push({ from: 'buttons', to: 'buttons', reason: `ボタンの数が前提の上限(buttonsMax ${limits.buttonsMax})を超えた` });
      part.items = part.items.slice(0, limits.buttonsMax);
    }
    parts.push(part);
  }
  // 文の長さは、文に落とした後で前提の上限に合わせる
  for (const part of parts) {
    if ((part.kind === 'text' || part.kind === 'notice') && part.text.length > limits.textMaxChars) {
      downgrades.push({ from: part.kind, to: part.kind, reason: `文が前提の上限(textMaxChars ${limits.textMaxChars})を超えた` });
      part.text = part.text.slice(0, limits.textMaxChars);
    }
  }
  return { parts, downgrades };
}

// 記録に残す部品の形。中身の文は残さず、種類とボタンの数だけ(4.1)
export const describeParts = (parts) =>
  parts.map((part) => ({
    kind: part.kind,
    ...(part.kind === 'buttons' ? { items: part.items.length } : {}),
    ...(part.kind === 'carousel' ? { cards: part.cards.length } : {}),
  }));
