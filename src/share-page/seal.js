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

// ---- 人ごとの署名(collaboration.md の 9.4 の「鍵」。K7 の 3 枚目) ----
// 参加者の書き込み(板の項目、コメント、反応、承認)は、招待ごとの署名の鍵(ECDSA P-256)で署名する。
// 秘密の側は招待のリンクのフラグメントだけにあり、公開の側は Studio の役の表にある。中継のサーバーはどちらも持たない。
// だから中継のサーバーは、書き込みを作れず、ある人の書き込みを別の人のものにもできない。
// ただし参加者のページは中継のサーバーが配るので、ページを書き換えられると鍵を盗まれうる(collaboration.md の 9.8 の「残る危険」)。
// そのときも作る AI は、進行役が自分の PC で「作る AI に送る」を押すまで動かない。
// 鍵は Studio が作るので、署名が示すのは「中継のサーバーが作ったものではない」ことまで。本人が押した証にはならない

const SIGN = { name: 'ECDSA', namedCurve: 'P-256' };
const SIGN_HASH = { name: 'ECDSA', hash: 'SHA-256' };

// 署名の鍵の組を作る。秘密の側(pkcs8)と公開の側(spki)を base64url で返す
export async function generateSigner() {
  const pair = await subtle.generateKey(SIGN, true, ['sign', 'verify']);
  const [privateKey, publicKey] = await Promise.all([subtle.exportKey('pkcs8', pair.privateKey), subtle.exportKey('spki', pair.publicKey)]);
  return { privateKey: toBase64Url(new Uint8Array(privateKey)), publicKey: toBase64Url(new Uint8Array(publicKey)) };
}

export const importSigner = (text) => subtle.importKey('pkcs8', fromBase64Url(text), SIGN, false, ['sign']);
export const importVerifier = (text) => subtle.importKey('spki', fromBase64Url(text), SIGN, false, ['verify']);

// キーの順をそろえた JSON。署名する文を、送る側と確かめる側で同じにする
export function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().filter((key) => value[key] !== undefined).map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value ?? null);
}

// 署名する文。会の ID を入れ、別の会へ移した書き込みは通らない
const signedBytes = (sessionId, body) => encoder.encode(`prototype-studio-share:1:${sessionId}:event:${stableJson(body)}`);

// 書き込みに署名を付ける。body は { op, opId, by(人の ID), ... }
export async function signEvent(signer, sessionId, body) {
  const sig = await subtle.sign(SIGN_HASH, signer, signedBytes(sessionId, body));
  return { ...body, sig: toBase64Url(new Uint8Array(sig)) };
}

// 署名を確かめる。合わない、形が違うときは false(投げない)
export async function verifyEvent(verifier, sessionId, event) {
  if (!event || typeof event !== 'object' || typeof event.sig !== 'string') return false;
  const { sig, ...body } = event;
  try {
    return await subtle.verify(SIGN_HASH, verifier, fromBase64Url(sig), signedBytes(sessionId, body));
  } catch {
    return false;
  }
}

// コメントの文の指紋。承認をコメントの文に結ぶ(承認の後に文が変わったら、その承認は数えない)
export const textPrint = (text) => ticketHash(`comment:${text}`);
