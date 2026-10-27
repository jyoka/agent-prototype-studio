// 画面に出す前と、記録に残す前に、秘密らしい文字列と、要らない個人のデータを伏せる。
// 伏せるのは表示と記録だけ。AI に送る中身は変えない(送るものは、切り替える前の確認で出している)。
// 形で見分けるので、漏れも誤りもあり得る。架空のデータで試す決まりは変わらない。

const RULES = [
  // API キーとトークンらしいもの
  [/\bsk-ant-[A-Za-z0-9_-]{8,}/g, '[伏せた: API キーらしい文字列]'],
  [/\bsk-[A-Za-z0-9_-]{20,}/g, '[伏せた: API キーらしい文字列]'],
  [/\b(Bearer|Basic) [A-Za-z0-9._~+/=-]{8,}/g, '$1 [伏せた]'],
  // 名前が鍵らしい設定の値。数だけの値(max_tokens: 100 など)は伏せない
  [
    /\b([A-Za-z_]*(?:api[_-]?key|token|secret|password|passwd)[A-Za-z_]*)(["']?\s*[:=]\s*["']?)([^\s"',;]+)/gi,
    (match, name, separator, value) => (/^\d+$/.test(value) ? match : `${name}${separator}[伏せた]`),
  ],
  // 長い符号(鍵、ハッシュ、セッションの ID など)
  [/\b[A-Fa-f0-9]{32,}\b/g, '[伏せた: 長い符号]'],
  // 英字と数字が混ざった、区切りのない長い並び(ファイルの場所や URL は区切りがあるので伏せない)
  [/\b[A-Za-z0-9+_]{40,}={0,2}/g, (match) => (/\d/.test(match) && /[A-Za-z]/.test(match) ? '[伏せた: 長い符号]' : match)],
  // 個人のデータ
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[伏せた: メールアドレス]'],
  // 電話番号: 0 で始まり、ハイフンで区切るか続けて 10 桁か 11 桁。郵便番号や金額は桁が合わないので伏せない
  [
    /(?<![\d-])(?:\+81-?|0)[1-9]\d{0,3}-?\d{1,4}-?\d{3,4}(?![\d-])/g,
    (match) => {
      const digits = match.replace(/^\+81/, '0').replace(/\D/g, '').length;
      return digits === 10 || digits === 11 ? '[伏せた: 電話番号]' : match;
    },
  ],
];

export function redact(value) {
  if (typeof value !== 'string') return value;
  let text = value;
  for (const [pattern, replacement] of RULES) text = text.replace(pattern, replacement);
  return text;
}

// 入れ子の値の、文字列をすべて伏せる
export function redactDeep(value) {
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map(redactDeep);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactDeep(item)]));
  }
  return value;
}
