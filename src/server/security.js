import crypto from 'node:crypto';

export function createToken() {
  return crypto.randomBytes(32).toString('hex');
}

export function createBuildId() {
  return crypto.randomBytes(16).toString('hex');
}

// DNS rebinding を防ぐため、自分の loopback の名前とポートだけを受ける。
export function isAllowedHost(hostHeader, port) {
  if (typeof hostHeader !== 'string') return false;
  const host = hostHeader.toLowerCase();
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
}

export function tokensEqual(given, expected) {
  if (typeof given !== 'string' || given.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}
