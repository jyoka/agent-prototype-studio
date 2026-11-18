// 共有の場の暗号化(docs/design/collaboration.md の 9.4 の「鍵」、ADR 0004 の層 4)。
// Studio のサーバー(Node 22 の Web Crypto)と参加者のページ(ブラウザ)が、同じこのファイルを使う。
// 中身は会の鍵(AES-256-GCM)で包む。中継のサーバーは鍵を持たないので、暗号文しか見えない。
// 包んだ形は base64url の「12 バイトの IV + 暗号文 + 16 バイトのタグ」。
// 付ける文(AAD)に会の ID と使い道を入れる。中継のサーバーが、別の会や別の使い道へ暗号文を移しても、開けない。

const subtle = globalThis.crypto.subtle;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const KEY_BYTES = 32;
const IV_BYTES = 12;

export function toBase64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(text) {
  if (typeof text !== 'string' || !/^[A-Za-z0-9_-]*$/.test(text)) throw new Error('base64url ではありません');
  const padded = text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// ランダムな値(会の鍵、入る札、人の ID)を base64url で返す
export function randomText(bytes = KEY_BYTES) {
  return toBase64Url(globalThis.crypto.getRandomValues(new Uint8Array(bytes)));
}

// 入る札の指紋。中継のサーバーは札そのものを持たず、これだけを持つ
export async function ticketHash(ticket) {
  const digest = await subtle.digest('SHA-256', encoder.encode(ticket));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function importKey(text) {
  const raw = fromBase64Url(text);
  if (raw.length !== KEY_BYTES) throw new Error('会の鍵の長さが違います');
  return subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

// 付ける文。会の ID と使い道(row は人の書き込み、file:<名前> は Studio が置く写し)
export const aadOf = (sessionId, use) => encoder.encode(`prototype-studio-share:1:${sessionId}:${use}`);

export async function seal(key, aad, value) {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const body = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad }, key, encoder.encode(JSON.stringify(value))));
  const out = new Uint8Array(IV_BYTES + body.length);
  out.set(iv, 0);
  out.set(body, IV_BYTES);
  return toBase64Url(out);
}

// 開けないもの(鍵が違う、書き換えられた、使い道が違う)は投げる
export async function open(key, aad, text) {
  const bytes = fromBase64Url(text);
  if (bytes.length <= IV_BYTES + 16) throw new Error('暗号文が短すぎます');
  const plain = await subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(0, IV_BYTES), additionalData: aad }, key, bytes.slice(IV_BYTES));
  return JSON.parse(decoder.decode(plain));
}
