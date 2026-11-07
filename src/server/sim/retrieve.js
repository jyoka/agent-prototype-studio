// 文書の検索(ツールの処理 op: "retrieve"。docs/design/ai-architecture-review.md の「データと RAG」)。
// 手元で動かし、外へ通信しない。モデルも埋め込みも使わない。同じ文書と同じ問いなら、いつも同じ順で返す。
// 方法: 文字の 2 つ組(bigram)の BM25。日本語は語の区切りがないので、形態素の辞書を足さずに 2 文字ずつ区切る。
// 1 件の文書がそのまま検索と引用の単位(Studio は文書を自動では分けない。分けるのは文書を書く側)。
// このファイルは何も読み込まない(ツールの口の守り S21。ファイル、プロセス、外への通信に届かない)

// BM25 の決まった値(よく使われる値。変えると順が変わるので、場面の数と比べられなくなる)
export const BM25 = { k1: 1.2, b: 0.75 };
// 文書のデータの形の上限
export const DOC_LIMITS = { maxDocs: 500, maxTitle: 100, maxText: 2000, maxId: 64 };
export const DOC_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;

// 文字を NFKC にそろえ、英字を小文字にし、文字と数字の並びごとに 2 文字ずつ区切る。1 文字だけの並びは 1 文字で数える
export function tokensOf(value) {
  const tokens = [];
  const runs = String(value ?? '').normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  for (const run of runs) {
    const chars = [...run];
    if (chars.length === 1) tokens.push(chars[0]);
    for (let i = 0; i + 1 < chars.length; i += 1) tokens.push(chars[i] + chars[i + 1]);
  }
  return tokens;
}

// 文書のデータの形の問題。[{ id, title?, text }] で、id は重ならない。問題の文の一覧を返す(空なら正しい形)
export function documentProblems(docs) {
  if (!Array.isArray(docs) || docs.some((doc) => !isPlainObject(doc))) return ['文書のデータは、オブジェクトの配列([{ "id": …, "title": …, "text": … }, …])にしてください'];
  const problems = [];
  if (docs.length > DOC_LIMITS.maxDocs) problems.push(`文書は ${DOC_LIMITS.maxDocs} 件までです`);
  const ids = new Set();
  for (const [i, doc] of docs.entries()) {
    const at = `[${i}]`;
    for (const key of Object.keys(doc)) if (!['id', 'title', 'text'].includes(key)) problems.push(`${at}: 「${key}」は書けません(id、title、text だけ)`);
    if (typeof doc.id !== 'string' || !DOC_ID_PATTERN.test(doc.id)) problems.push(`${at}.id: 英数字で始め、英数字と _ と - だけで 64 字までにしてください`);
    else if (ids.has(doc.id)) problems.push(`${at}.id: 「${doc.id}」が重なっています`);
    else ids.add(doc.id);
    if (doc.title !== undefined && (typeof doc.title !== 'string' || doc.title.trim() === '' || doc.title.length > DOC_LIMITS.maxTitle)) {
      problems.push(`${at}.title: ${DOC_LIMITS.maxTitle} 文字までの文にしてください`);
    }
    if (typeof doc.text !== 'string' || doc.text.trim() === '') problems.push(`${at}.text: 文書の本文を書いてください`);
    else if (doc.text.length > DOC_LIMITS.maxText) problems.push(`${at}.text: 1 件は ${DOC_LIMITS.maxText} 文字までです。条や見出しごとに分けてください`);
  }
  return problems;
}

// 引用の文。答えに書けば、どの文書を読んだかが分かる。見出しがあれば見出し、なければ id
export const citeOf = (doc) => (typeof doc.title === 'string' && doc.title.trim() ? doc.title.trim() : doc.id);

// 問いに近い文書を、点の高い順に返す。点が 0 の文書は返さない。同じ点はデータの順。
// 返す: { count(点が 0 より大きい文書の数), items: [{ id, title?, text, cite, score }](limit 件まで) }
export function searchDocuments(docs, query, { limit = 3 } = {}) {
  const wanted = [...new Set(tokensOf(query))];
  if (wanted.length === 0 || docs.length === 0) return { count: 0, items: [] };
  // 1 文字だけの語(問いが 1 文字の並びのとき)は、文書の中の 1 文字ずつも数える(「税」「犬」などの問いで当たるように)
  const singles = new Set(wanted.filter((token) => [...token].length === 1));
  const counted = docs.map((doc) => {
    const source = `${doc.title ?? ''}\n${doc.text}`;
    const tokens = tokensOf(source);
    const freq = new Map();
    for (const token of tokens) freq.set(token, (freq.get(token) ?? 0) + 1);
    // 1 文字の語の数は、文書の中のその文字の数にする(1 文字の並びの分も、2 つ組の中の分も入る)
    for (const char of singles) freq.delete(char);
    if (singles.size > 0) for (const char of source.normalize('NFKC').toLowerCase()) if (singles.has(char)) freq.set(char, (freq.get(char) ?? 0) + 1);
    return { doc, length: tokens.length, freq };
  });
  const average = counted.reduce((sum, item) => sum + item.length, 0) / counted.length || 1;
  const idf = new Map(wanted.map((token) => {
    const n = counted.filter((item) => item.freq.has(token)).length;
    return [token, Math.log(1 + (counted.length - n + 0.5) / (n + 0.5))];
  }));
  const scored = counted.map((item, index) => {
    let score = 0;
    for (const token of wanted) {
      const f = item.freq.get(token) ?? 0;
      if (f === 0) continue;
      score += idf.get(token) * ((f * (BM25.k1 + 1)) / (f + BM25.k1 * (1 - BM25.b + (BM25.b * item.length) / average)));
    }
    return { item, index, score: Math.round(score * 1000) / 1000 };
  }).filter((entry) => entry.score > 0);
  scored.sort((x, y) => y.score - x.score || x.index - y.index);
  return {
    count: scored.length,
    items: scored.slice(0, limit).map(({ item: { doc }, score }) => ({
      id: doc.id,
      ...(doc.title !== undefined ? { title: doc.title } : {}),
      text: doc.text,
      cite: citeOf(doc),
      score,
    })),
  };
}
