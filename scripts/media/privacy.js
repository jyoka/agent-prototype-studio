import { spawnSync } from 'node:child_process';
import os from 'node:os';

// 撮った画像に写してはいけないもの(CONTRIBUTING.md の「画像と動く画像を撮り直す」)。日付、作業ディレクトリ、メールアドレス。
// 画面の見える文字は findLeaks で、書き出したファイルの中身(メタデータ)は findLeaksInBytes で、撮るたびに調べる。
// 時刻(15:04:05 など)は日付ではないので数えない

const DATE_PATTERNS = [
  // 2026-10-29、2026/10/29、2026.10.29、2026年10月29日
  /\b(?:19|20)\d{2}\s*[-/.年]\s*(?:0?[1-9]|1[0-2])\s*[-/.月]\s*(?:0?[1-9]|[12]\d|3[01])日?/,
  // 20261029(回しの ID の頭など)
  /\b(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\b/,
  // 10月29日
  /(?:^|[^\d])(?:0?[1-9]|1[0-2])月(?:0?[1-9]|[12]\d|3[01])日/,
];
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/;
// 利用者の場所らしいパス。macOS、Linux、Windows、一時フォルダー
const PATH_PATTERNS = [/\/Users\/[^\s/]+/, /\/home\/[^\s/]+/, /\/(?:private\/)?var\/folders\//, /\/tmp\//, /[A-Za-z]:\\(?:Users|Documents and Settings)\\/i];

// 調べるパスの既定。ホーム、一時フォルダー、作業ディレクトリ、利用者の名前
export function defaultPaths(extra = []) {
  const paths = [os.homedir(), os.tmpdir(), process.cwd(), ...extra];
  return [...new Set(paths.filter((p) => typeof p === 'string' && p.length > 1))];
}

// 文字の中の、写してはいけないものを [{ kind, match }] で返す。なければ空
export function findLeaks(text, { paths = defaultPaths(), user = os.userInfo().username } = {}) {
  const leaks = [];
  for (const pattern of DATE_PATTERNS) {
    const match = pattern.exec(text);
    if (match) leaks.push({ kind: '日付', match: match[0].trim() });
  }
  const email = EMAIL.exec(text);
  if (email) leaks.push({ kind: 'メールアドレス', match: email[0] });
  for (const p of paths) if (text.includes(p)) leaks.push({ kind: '作業ディレクトリ', match: p });
  for (const pattern of PATH_PATTERNS) {
    const match = pattern.exec(text);
    if (match) leaks.push({ kind: '作業ディレクトリ', match: match[0] });
  }
  // 利用者の名前は、短いと普通の語に当たるので、4 字以上のときだけ調べる
  if (typeof user === 'string' && user.length >= 4 && new RegExp(`\\b${user.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(text)) {
    leaks.push({ kind: '利用者の名前', match: user });
  }
  return leaks;
}

// 失敗の知らせに使う 1 行
export function describeLeaks(where, leaks) {
  return `${where} に写してはいけないものがあります: ${leaks.map((l) => `${l.kind}「${l.match}」`).join('、')}`;
}

// 手元の git に書いたメールアドレス(なければ空)
export function gitEmails(cwd = process.cwd()) {
  const result = spawnSync('git', ['config', '--get', 'user.email'], { cwd, encoding: 'utf8', timeout: 10_000 });
  const email = result.status === 0 ? result.stdout.trim() : '';
  return email ? [email] : [];
}

// 日付の書き方(ファイルのメタデータに入る形を含む)
function dateForms(date) {
  const y = String(date.getFullYear());
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return [`${y}-${m}-${d}`, `${y}/${m}/${d}`, `${y}:${m}:${d}`, `${y}${m}${d}`];
}

// ファイルの中身(画像の圧縮したデータ)は、文字の形で調べると偶然に当たる。
// そこで、決まった文字(今日の日付、パス、利用者の名前、git のメールアドレス)がそのまま入っていないかだけを調べる
export function findLeaksInBytes(bytes, { paths = defaultPaths(), user = os.userInfo().username, emails = gitEmails(), now = new Date() } = {}) {
  const text = Buffer.from(bytes).toString('latin1');
  const leaks = [];
  for (const form of dateForms(now)) if (text.includes(form)) leaks.push({ kind: '日付', match: form });
  for (const p of paths) if (text.includes(p)) leaks.push({ kind: '作業ディレクトリ', match: p });
  for (const email of emails) if (text.includes(email)) leaks.push({ kind: 'メールアドレス', match: email });
  if (typeof user === 'string' && user.length >= 4 && text.includes(user)) leaks.push({ kind: '利用者の名前', match: user });
  return leaks;
}
