import { formatValue } from './definition.js';

// モックの接続。実際のモデルは呼ばず、app/ai.json の言葉と型だけで、いつも同じ応答を返す。
// harness(harness.js)の 2 つの口を持つ。何を聞くか、段の遷移、終わるかは harness が決める。
//   extract({ definition, fields, state, messages, text }) -> { updates, intent }  言葉の一致で読む
//   phrase({ definition, decision, state, messages }) -> { reply }               mock の型に当てはめる

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

export function extractUpdates(definition, text, fields = definition.fields) {
  const normalized = normalize(text);
  const updates = {};
  for (const field of fields) {
    const value = field.type === 'number' ? extractNumber(field, normalized) : extractChoice(field, normalized);
    if (value !== undefined) updates[field.key] = value;
  }
  return updates;
}

// 発言の種類: mock.intents の言葉が文の中で一番前に出てきた種類を採る(はい/いいえは文の頭に来やすい)。
// 言葉がなく、項目の値を読めたら answer。どちらもなければ null(読み取れなかった)
export function extractIntent(definition, text, updates) {
  const normalized = normalize(text);
  let found = null;
  let foundAt = Infinity;
  for (const [intent, words] of Object.entries(definition.mock.intents)) {
    for (const word of words) {
      const at = normalized.indexOf(normalize(word));
      if (at >= 0 && at < foundAt) {
        foundAt = at;
        found = intent;
      }
    }
  }
  return found ?? (Object.keys(updates).length > 0 ? 'answer' : null);
}

export function mockExtract({ definition, fields = definition.fields, text }) {
  const updates = extractUpdates(definition, text, fields);
  return { updates, intent: extractIntent(definition, text, updates) };
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

// 段や終わりで言うことの型。summary はまとめて確かめる型、complete は終わりの型
const SAY_TEMPLATES = { summary: 'confirm', complete: 'complete' };

// 決定(harness の decision)を、mock の型に当てはめた文にする。実モデルの言い方が使えないときの決まった文にも使う
export function templateReply(definition, decision, state) {
  const { mock, fields } = definition;
  const summary = () => describe(definition, state, fields.map((f) => f.key));
  const parts = [];
  if (decision.corrected.length > 0) parts.push(fill(mock.afterCorrection, { changes: describe(definition, state, decision.corrected) }));
  if (decision.changes.length > 0) {
    parts.push(fill(mock.understood, { changes: describe(definition, state, decision.changes.map((change) => change.key)) }));
  } else if (decision.corrected.length === 0 && (decision.intent === null || decision.intent === 'answer') && !decision.tell?.length) {
    // はい、いいえなど、項目でない答えを読めたときは「読み取れなかった」と言わない。固定の流れで伝える文があるときも言わない
    parts.push(mock.notUnderstood);
  }
  // 固定の流れがツールの結果から作った文(docs/design/agent-simulation.md の 2.8)
  parts.push(...(decision.tell ?? []));
  if (decision.say) parts.push(fill(mock[SAY_TEMPLATES[decision.say]], { summary: summary() }));
  if (decision.ask) parts.push(fields.find((field) => field.key === decision.ask).question);
  return parts.filter(Boolean).join('');
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
        rule:
          '抽出: app/ai.json の各項目の選択肢と keywords、mock.intents の言葉が発言の中にあるかで、値と発言の種類を読み取ります。何を聞くか、段の遷移、終わるかは harness が決めます。言い方: その決定を mock の型に当てはめて返事を作ります。',
      };
    },
    async extract({ definition, fields, text }) {
      return mockExtract({ definition, fields, text });
    },
    async phrase({ definition, decision, state }) {
      return { reply: templateReply(definition, decision, state) };
    },
  };
}
