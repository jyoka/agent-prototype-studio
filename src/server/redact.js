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

// 住所: 番地の形(1-12-3、1丁目12番3号、12番地、101号室)、町や村のすぐ後の番地(かわせみ町12-3)、
// 〒か「郵便番号」の後の 7 桁、都道府県のすぐ後の市区町村(東京都みほん区)。
// 駅や町の名前だけ(渋谷あたり、みなと町、かわべ市、新宿三丁目駅、東京都みほん区あたり)は住所としない。
// 日付(2026-10-29)、電話番号、数の範囲(10-18 時、1-2-3 月)、ファイルの場所も除く
const DIGIT = '[0-9０-９]';
const DASH = '[-\\u2010-\\u2015\\u2212\\u30fc\\uff0d\\uff70]';
// 数の後にこの言葉が続けば、番地ではなく数の範囲とみなす
const UNIT = '\\s*(?:時|分|歳|才|か月|ヶ月|カ月|月|日|円|人|件|回|週|年|番線|号線|%)';
// 市区町村の後にこの言葉が続けば、おおまかな場所の希望とみなす
const AREA_AFTER = /^[^\s、。,.!?！？のでにはをがへとやも]{0,8}?の?(?:あたり|辺り|周辺|近辺|付近|近く|方面|内|全域|エリア|駅)/;
const ADDRESS_FORMS = [
  {
    pattern: new RegExp(`(?<!${DIGIT}|${DASH}|[A-Za-z_./[])${DIGIT}{1,4}(?:${DASH}${DIGIT}{1,4}){2,3}(?!${DIGIT}|${DASH}|[A-Za-z_/\\]]|\\.${DIGIT}|${UNIT})`, 'g'),
    accept: (match) => {
      const plain = match[0].normalize('NFKC').replace(new RegExp(DASH, 'g'), '-');
      return !/^(?:19|20)\d{2}-\d{1,2}-\d{1,2}$/.test(plain) && !(plain.startsWith('0') && isPhoneNumber(plain));
    },
  },
  {
    pattern: new RegExp(
      `(?:${DIGIT}+|[一二三四五六七八九十]+)丁目(?!駅)(?:${DIGIT}+番(?:地|${DIGIT}+号?)?|${DIGIT}{1,4}(?:${DASH}${DIGIT}{1,4}){0,2})?|${DIGIT}+番地|${DIGIT}+番${DIGIT}+号|${DIGIT}+号室`,
      'g',
    ),
  },
  { pattern: new RegExp(`(?<=[町村])${DIGIT}{1,4}${DASH}${DIGIT}{1,4}(?!${DIGIT}|${DASH}|${UNIT})`, 'g') },
  { pattern: new RegExp(`(?:〒|郵便番号[はが:：]?)\\s*${DIGIT}{3}${DASH}?${DIGIT}{4}`, 'g') },
  {
    pattern: /(?:北海道|東京都|京都府|大阪府|\p{Script=Han}{2,3}県)(?:[^\s、。,.!?！？のでにはをがへとやも]{1,8}?[市区町村郡]){1,3}/gu,
    accept: (match) => !/都道府県|市区町村/.test(match[0]) && !AREA_AFTER.test(match.input.slice(match.index + match[0].length)),
  },
];

// 氏名: 「〜と申します」「〜といいます」「〜って言います」の前と、「名前は〜」「氏名:〜」の後の、名前の形。
// 名前の前に言葉がつく名乗り(大学生の山田太郎と申します)は、最後のひらがなの後の、漢字とカタカナだけの部分を名前とみなす。
// 言いよどみ(駅の近くといいますか)、場所や数の言い方(みなと町といいます、10 時からといいます)、身分(学生って言います)、
// 名前でない続き(名前は聞かないで、店の名前は〜、{ 名前: 値 }、英字と日本語の混ざった文)は除く。名乗りのない名前だけの文は見分けられない。
// part は伏せる部分の位置(名前だけ。名乗りの言葉は残す)
const NAME_CHAR = '[\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}ー々\\uff66-\\uff9fA-Za-z]';
const NAME = `${NAME_CHAR}(?:[ 　・]?${NAME_CHAR}){0,19}`;
const SELF = '(?:私|わたし|わたくし|僕|ぼく|俺|おれ|自分)';
const NOT_NAME_END = /(?:町|市|区|村|駅|近く|あたり|辺り|周辺|ほう|方|から|まで|だけ|くらい|ぐらい|ごろ|頃|いい|たい|ない|ます|です|こと|もの|ところ|感じ|時|円|日|月|週|曜|学生|主婦|主夫|フリーター|社会人|会社員|無職|パート|アルバイト|バイト|初心者|未経験|経験者|店|屋|仕事|作業|早番|中番|遅番|夜勤|日勤|希望|条件|カフェ|コンビニ|スーパー)$/;
// 英字と日本語の混ざった並び(「目録の title から作る」)と、助詞の後に漢字やカタカナが続く並び(「試作品のデータが決め」)は、
// 名前ではなく文とみなす
const sentence = (name) => (/[A-Za-z]/.test(name) && /[^\sA-Za-z・]/.test(name)) || /[のがを][\p{Script=Han}\p{Script=Katakana}]/u.test(name);
// 英字の名前の後に、コードの名前(studio-talk、user_id、v2)のような続きがあれば、名前とみなさない
const codeAfter = (match) => /^[-_./0-9A-Za-z]/.test(match.input.slice(match.indices[1][1]));
// 名乗りの言葉の前の、名前の位置。文に見えるときは、最後のひらがなの後の、漢字とカタカナだけの 2 文字以上を名前とみなす
// (「大学生の山田太郎」は「山田太郎」。「店長が厳しい」「人気のカフェ」は名前としない)。名前がなければ null
const NAMED_TAIL = /(?<=\p{Script=Hiragana})[\p{Script=Han}\p{Script=Katakana}ー々\uff66-\uff9f](?:[ 　・]?[\p{Script=Han}\p{Script=Katakana}ー々\uff66-\uff9f])+$/u;
function selfNameSpan(match) {
  const name = match[1];
  const [start, end] = match.indices[1];
  if (NOT_NAME_END.test(name)) return null;
  if (!sentence(name)) return [start, end];
  if (/[A-Za-z]/.test(name)) return null;
  const tail = name.match(NAMED_TAIL);
  if (!tail || sentence(tail[0])) return null;
  return [start + tail.index, end];
}
const PERSON_NAME_FORMS = [
  {
    pattern: new RegExp(`(?:${SELF}は[ 　]?)?(${NAME})[ 　]?(?:と|って)(?:申します|もうします|いいます|言います)(?![かとのもがけ])`, 'dgu'),
    accept: (match) => selfNameSpan(match) !== null,
    part: selfNameSpan,
  },
  {
    pattern: new RegExp(
      `(?<![{,]\\s*)(?<=^|[\\s、。,.!?！？「『(（:：にもはがで]|${SELF}の)(?:お?名前(?:は|:|：)|(?:氏名|本名|フルネーム)(?:は|:|：|[ 　]))[、,]?[ 　]?` +
        `(?!これ|それ|あれ|どれ|この|その|あの|どの|ここ|そこ|まだ|秘密|内緒|未定|不要|なし|無し|ない|あと|後で|後ほど|なんでも|何でも|結構|大丈夫|やめ|控え|省|言|教|書|伏|載|聞|出|入|いら|要ら)(${NAME})`,
      'dgu',
    ),
    accept: (match) => !/^(?:です|でございます)$|(?:ない|ません|ます|たい|ください|ほしい|欲しい|いい)(?:です)?$/.test(match[1]) && !sentence(match[1]) && !codeAfter(match),
    part: (match) => {
      const [start] = match.indices[1];
      return [start, start + match[1].replace(/[ 　]?(?:です|でございます)$/, '').length];
    },
  },
];

// 形に合い、除く条件にも当たらないもの。伏せる(redact)と、見つける(findPersonalData、ツールの守りの deny)の両方で使う
function matchesOf(forms, text) {
  return forms.flatMap(({ pattern, accept }) => [...text.matchAll(pattern)].filter((match) => !accept || accept(match)));
}

function hide(forms, text, label) {
  let result = text;
  for (const form of forms) {
    const spans = matchesOf([form], result).map((match) => (form.part ? form.part(match) : [match.index, match.index + match[0].length]));
    for (const [start, end] of spans.reverse()) result = `${result.slice(0, start)}${label}${result.slice(end)}`;
  }
  return result;
}

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
  return hide(PERSON_NAME_FORMS, hide(ADDRESS_FORMS, text, '[伏せた: 住所]'), '[伏せた: 氏名]');
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

// メールアドレス、電話番号、住所、氏名らしいものの、行と種類。架空のデータか、人が確かめるために使う。
// ツールの守り(deny の looksLike)も、これで見分ける
export function findPersonalData(text) {
  return findByLine(text, (line) => [
    ...(line.match(EMAIL) ? ['メールアドレス'] : []),
    ...((line.match(PHONE) ?? []).some(isPhoneNumber) ? ['電話番号'] : []),
    ...(matchesOf(ADDRESS_FORMS, line).length > 0 ? ['住所'] : []),
    ...(matchesOf(PERSON_NAME_FORMS, line).length > 0 ? ['氏名'] : []),
  ]);
}
