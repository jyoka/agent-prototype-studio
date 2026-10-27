import assert from 'node:assert/strict';
import test from 'node:test';
import { createBuildId, createToken, isAllowedHost, tokensEqual } from '../../src/server/security.js';

test('Host は自分の loopback の名前とポートだけを受ける', () => {
  assert.equal(isAllowedHost('127.0.0.1:4317', 4317), true);
  assert.equal(isAllowedHost('LOCALHOST:4317', 4317), true);
  assert.equal(isAllowedHost('127.0.0.1:4318', 4317), false);
  assert.equal(isAllowedHost('evil.example:4317', 4317), false);
  assert.equal(isAllowedHost('127.0.0.1', 4317), false);
  assert.equal(isAllowedHost('192.168.0.10:4317', 4317), false);
  assert.equal(isAllowedHost(undefined, 4317), false);
});

test('トークンと版の ID は推測できない長さの乱数になる', () => {
  assert.match(createToken(), /^[a-f0-9]{64}$/);
  assert.match(createBuildId(), /^[a-f0-9]{32}$/);
  assert.notEqual(createToken(), createToken());
});

test('トークンの比較は長さや型が違っても例外を出さない', () => {
  const token = createToken();
  assert.equal(tokensEqual(token, token), true);
  assert.equal(tokensEqual(token.slice(1), token), false);
  assert.equal(tokensEqual(undefined, token), false);
  assert.equal(tokensEqual(['a'], token), false);
});
