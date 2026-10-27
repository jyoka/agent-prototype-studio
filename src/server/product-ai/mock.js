import { formatValue } from './definition.js';

// モックの接続。実際のモデルは呼ばず、app/ai.json の言葉と型だけで、いつも同じ応答を返す。
// 実モデルの接続(#276)も同じ形 respond({ definition, state, messages, text }) -> { reply, updates } にする。

const normalize = (value) => value.normalize('NFKC');

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// 選択肢の項目: 文の中で一番後ろに出てきた言葉の選択肢を採る(言い直しを後勝ちにする)。
function extractChoice(field, text) {
  let found;
  let foundAt = -1;
  for (const option of field.options) {
    for (const word of [option.value, ...option.keywords]) {
      const at = text.lastIndexOf(normalize(word));
      if (at > foundAt) {
        foundAt = at;
        found = option.value;
      }
    }
  }
  return found;
}

// 数の項目: keywords があれば、その言葉より後ろの数を採る。unit があれば、単位が続く数だけを採る。
// 範囲に合う数のうち、一番後ろのものを採る(選択肢と同じく、言い直しを後勝ちにする)。
function extractNumber(field, text) {
  let from = 0;
  if (field.keywords.length > 0) {
    const positions = field.keywords.map((word) => text.indexOf(normalize(word))).filter((at) => at >= 0);
    if (positions.length === 0) return undefined;
    from = Math.min(...positions);
  }
  const unit = field.unit ? `\\s*${escapeRegExp(normalize(field.unit))}` : '';
  const pattern = new RegExp(`(\\d[\\d,]*(?:\\.\\d+)?)${unit}`, 'g');
  pattern.lastIndex = from;
  let found;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    const value = Number(match[1].replaceAll(',', ''));
    if (!Number.isFinite(value)) continue;
    if (field.min !== null && value < field.min) continue;
    if (field.max !== null && value > field.max) continue;
    found = value;
  }
  return found;
}

export function extractUpdates(definition, text) {
  const normalized = normalize(text);
  const updates = {};
  for (const field of definition.fields) {
    const value = field.type === 'number' ? extractNumber(field, normalized) : extractChoice(field, normalized);
    if (value !== undefined) updates[field.key] = value;
  }
  return updates;
}

function fill(template, values) {
  return template.replace(/\{(changes|summary)\}/g, (_, name) => values[name] ?? '');
}

function describe(definition, state, keys) {
  return keys
    .map((key) => {
      const field = definition.fields.find((f) => f.key === key);
      return `${field.label}「${formatValue(field, state[key])}」`;
    })
    .join('、');
}

// 最後の AI の発言より後に、本人が直した項目
function correctedSinceLastReply(messages) {
  const keys = [];
  for (let i = messages.length - 1; i >= 0 && messages[i].role !== 'assistant'; i -= 1) {
    if (messages[i].role !== 'correction') continue;
    for (const change of messages[i].changes) if (!keys.includes(change.key)) keys.unshift(change.key);
  }
  return keys;
}

export function mockReply(definition, state, messages, text) {
  const updates = extractUpdates(definition, text);
  const next = { ...state, ...updates };
  const corrected = correctedSinceLastReply(messages).filter((key) => !Object.hasOwn(updates, key));
  const { mock, fields } = definition;
  const parts = [];
  if (corrected.length > 0) parts.push(fill(mock.afterCorrection, { changes: describe(definition, next, corrected) }));
  const changed = Object.keys(updates);
  if (changed.length > 0) parts.push(fill(mock.understood, { changes: describe(definition, next, changed) }));
  else if (corrected.length === 0) parts.push(mock.notUnderstood);
  const missing = fields.find((field) => next[field.key] === null);
  if (missing) {
    parts.push(missing.question);
  } else {
    parts.push(fill(mock.complete, { summary: describe(definition, next, fields.map((f) => f.key)) }));
  }
  return { reply: parts.filter(Boolean).join(''), updates };
}

export function createMockConnection() {
  return {
    kind: 'mock',
    label: 'モック',
    description: '決まった規則で応答します。実際の AI モデルは呼びません。同じ入力には、いつも同じ応答を返します。',
    tools: 'モックにはツールがありません。app/ai.json の言葉と応答の型だけで応答します。',
    // 実行の記録に出す。モックは外へ何も送らない
    describe() {
      return {
        to: null,
        tools: this.tools,
        rule: 'app/ai.json の各項目の選択肢と keywords が発言の中にあるかで値を読み取り、mock の型に当てはめて返事を作ります。',
      };
    },
    async respond({ definition, state, messages, text }) {
      return mockReply(definition, state, messages, text);
    },
  };
}
