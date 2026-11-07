import { isPlainObject } from './check.js';

// 模擬のエージェントのモックの接続(docs/design/agent-simulation.md の 3.3)。実際のモデルは呼ばない。
// app/mocks/*.json の決まりで、決まった返事と決まったツールの呼び出しを返す。ツールは、会話の進め方が渡す
// tools.call(同じプロセスの中のツールの口)で呼ぶ。同じ発言、同じ会話、同じ記録の店なら、いつも同じ結果になる。

const normalize = (value) => String(value ?? '').normalize('NFKC');

// 決まりの語は contains(発言の言葉のどれか)、action(ボタン)、turnsAtLeast(利用者の発言の数)、
// delegated(その参加者に任せた結果を受け取った後の返事。2.9)。書いたものは全部満たす。
// サブ(任された参加者)の text は、依頼の文(task)
export function ruleMatches(when, { text, action, turns, delegated = [] }) {
  if (when.contains !== undefined && !when.contains.some((word) => normalize(text).includes(normalize(word)))) return false;
  if (when.action !== undefined && when.action !== action) return false;
  if (when.turnsAtLeast !== undefined && turns < when.turnsAtLeast) return false;
  if (when.delegated !== undefined && !delegated.some((item) => item.from === when.delegated && typeof item.text === 'string')) return false;
  return true;
}

// 返事の型の置き換え。ツールの結果の数({result.count})と見出し({result.titles})だけ
function placeholders(result) {
  const items = isPlainObject(result) && Array.isArray(result.items) ? result.items : Array.isArray(result) ? result : [];
  const count = isPlainObject(result) && typeof result.count === 'number' ? result.count : items.length;
  const titles = items.map((item) => (isPlainObject(item) && typeof item.title === 'string' ? item.title : null)).filter(Boolean).join('、');
  return { '{result.count}': String(count), '{result.titles}': titles };
}

function fill(value, values) {
  if (typeof value === 'string') return value.replace(/\{(?:result\.(?:count|titles)|delegated\.text)\}/g, (found) => values[found] ?? '');
  if (Array.isArray(value)) return value.map((item) => fill(item, values));
  if (isPlainObject(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, fill(item, values)]));
  return value;
}

export function createMockAgent() {
  return {
    kind: 'mock',
    label: 'モック',
    real: false,
    // 開発者向けの詳細の「AI が使えるツール」に出す(構成のある試作品だけ)
    tools: 'モックの決まり(app/mocks/)で応答します。決まりに書いたツールを、Studio の中のツールの口で呼びます。モデルは呼びません。',
    // 1 回の返事。mock はモックの決まり(mocks.js の parseMock)、input は { text, action }、turns はこの発言を含む利用者の発言の数。
    // delegated は、このターンに任せた先(サブ)から受け取った結果([{ from, text } か { from, refused }])。
    // 返す: { parts(部品の並び。会話の進め方が前提に合わせる), rule(当たった決まりの番号か 'otherwise') }
    async reply({ mock, input, turns, tools, delegated = [] }) {
      const index = mock.rules.findIndex((rule) => ruleMatches(rule.when, { ...input, turns, delegated }));
      if (index < 0) return { parts: structuredClone(mock.otherwise), rule: 'otherwise' };
      const rule = mock.rules[index];
      const received = { '{delegated.text}': delegated.filter((item) => item.from === rule.when.delegated && typeof item.text === 'string').map((item) => item.text).join('') };
      if (!rule.call) return { parts: fill(structuredClone(rule.reply), received), rule: index };
      const outcome = await tools.call(rule.call.tool, structuredClone(rule.call.args));
      // ツールが断ったり失敗したりしたら、返ってきた文をそのまま返事にする(モックはツールの結果を読んで言い換えない)
      if (!outcome.ok) return { parts: [{ kind: 'text', text: outcome.error }], rule: index };
      return { parts: fill(structuredClone(rule.reply), { ...placeholders(outcome.result), ...received }), rule: index };
    },
  };
}
