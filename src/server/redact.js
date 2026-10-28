// 画面に出す前と、記録に残す前に、秘密らしい文字列と、要らない個人のデータを伏せる。
// 伏せるのは表示と記録だけ。AI に送る中身は変えない(送るものは、同意のカードの「詳しく」で出している)。
// 形で見分けるので、漏れも誤りもあり得る。架空のデータで試す決まりは変わらない。

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// 電話番号: 0 で始まり、ハイフンで区切るか続けて 10 桁か 11 桁。郵便番号や金額は桁が合わないので伏せない
const PHONE = /(?<![\d-])(?:\+81-?|0)[1-9]\d{0,3}-?\d{1,4}-?\d{3,4}(?![\d-])/g;
const isPhoneNumber = (match) => {
  const digits = match.replace(/^\+81/, '0').replace(/\D/g, '').length;
  return digits === 10 || digits === 11;
};

// 形で見分けられる鍵とトークン。伏せる(redact)と、書き出しを止める(findSecrets)の両方で使う
const KEY_FORMS = [
  [/\bsk-ant-[A-Za-z0-9_-]{8,}/g, 'API キーらしい文字列'],
  [/\bsk-[A-Za-z0-9_-]{20,}/g, 'API キーらしい文字列'],
  [/\b[sr]k_(?:live|test)_[A-Za-z0-9]{10,}/g, 'API キーらしい文字列'],
  [/\bAIza[0-9A-Za-z_-]{35}/g, 'API キーらしい文字列'],
  [/\bAKIA[0-9A-Z]{16}\b/g, 'AWS のアクセスキーらしい文字列'],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}/g, 'GitHub のトークンらしい文字列'],
  [/\bnpm_[A-Za-z0-9]{30,}/g, 'npm のトークンらしい文字列'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, 'Slack のトークンらしい文字列'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, '認証のトークンらしい文字列'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/g, '秘密鍵'],
];

const RULES = [
  // API キーとトークンらしいもの
  ...KEY_FORMS.map(([pattern, kind]) => [pattern, `[伏せた: ${kind}]`]),
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
  [EMAIL, '[伏せた: メールアドレス]'],
  [PHONE, (match) => (isPhoneNumber(match) ? '[伏せた: 電話番号]' : match)],
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

// 書き出す前に、ファイルの中の秘密情報を探す(引き継ぎ、handoff.js)。見つけたら書き出さない。
// 伏せる(redact)より狭く、取り違えにくい形だけを探す。画像を埋め込んだ data: URL などの長い符号は、秘密とみなさない
const hasDigitAndLetter = (value) => /\d/.test(value) && /[A-Za-z]/.test(value);
const KEY_NAME = '[A-Za-z_]*(?:api[_-]?key|secret|token|password|passwd)[A-Za-z_]*';
const SECRET_PATTERNS = [
  ...KEY_FORMS.map(([pattern, kind]) => [new RegExp(pattern.source), kind]),
  [/\bBearer [A-Za-z0-9._~+/=-]{16,}/, '認証のトークンらしい文字列'],
  // 名前が鍵らしい変数に、英字と数字の混ざった 12 文字以上の値を入れているもの。'your-api-key' のような見本は数字がないので除く。
  // 引用符のない値(.env、YAML、.npmrc の書き方)は、. や ( を含まないものだけ(config.apiKey2 のような参照を除く)
  [new RegExp(`\\b${KEY_NAME}["']?\\s*[:=]\\s*["'\`]([^"'\`\\s]{12,})["'\`]`, 'i'), '鍵らしい名前の値', (match) => hasDigitAndLetter(match[1])],
  [new RegExp(`\\b${KEY_NAME}\\s*[:=]\\s*([A-Za-z0-9_+/=-]{12,})(?![\\w.(])`, 'i'), '鍵らしい名前の値', (match) => hasDigitAndLetter(match[1])],
];

function findByLine(text, check) {
  const found = [];
  text.split(/\r?\n/).forEach((line, index) => {
    // 同じ行の同じ種類は 1 つにする(sk-ant- は sk- の形にも合う)
    for (const kind of new Set(check(line))) found.push({ line: index + 1, kind });
  });
  return found;
}

// 秘密らしい文字列の、行と種類。値そのものは返さない(画面と記録に出さないため)
export function findSecrets(text) {
  return findByLine(text, (line) =>
    SECRET_PATTERNS.flatMap(([pattern, kind, accept]) => {
      const match = pattern.exec(line);
      return match && (!accept || accept(match)) ? [kind] : [];
    }),
  );
}

// メールアドレスと電話番号らしいものの、行と種類。架空のデータか、人が確かめるために使う
export function findPersonalData(text) {
  return findByLine(text, (line) => [
    ...(line.match(EMAIL) ? ['メールアドレス'] : []),
    ...((line.match(PHONE) ?? []).some(isPhoneNumber) ? ['電話番号'] : []),
  ]);
}
