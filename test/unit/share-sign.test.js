import assert from 'node:assert/strict';
import test from 'node:test';
import { generateSigner, importSigner, importVerifier, signEvent, stableJson, textPrint, verifyEvent } from '../../src/share-page/seal.js';

// 共有の場の人ごとの署名(src/share-page/seal.js。docs/design/collaboration.md の 9.4、K7 の 3 枚目)

test('署名した書き込みは、同じ人の公開の鍵でだけ通る。中身、会、書いた人を変えると通らない', async () => {
  const a = await generateSigner();
  const b = await generateSigner();
  const event = await signEvent(await importSigner(a.privateKey), 'session-1', { op: 'comment-approve', comment: 'c1', by: 'member-a', opId: 'x1' });
  const va = await importVerifier(a.publicKey);
  assert.equal(await verifyEvent(va, 'session-1', event), true);
  assert.equal(await verifyEvent(await importVerifier(b.publicKey), 'session-1', event), false);
  assert.equal(await verifyEvent(va, 'session-2', event), false);
  assert.equal(await verifyEvent(va, 'session-1', { ...event, by: 'member-b' }), false);
  assert.equal(await verifyEvent(va, 'session-1', { ...event, comment: 'c2' }), false);
  assert.equal(await verifyEvent(va, 'session-1', { ...event, sig: undefined }), false);
  assert.equal(await verifyEvent(va, 'session-1', { ...event, sig: '!!' }), false);
  assert.equal(await verifyEvent(va, 'session-1', null), false);
});

test('署名する文は、キーの順によらない', () => {
  assert.equal(stableJson({ b: 1, a: { d: [1, { y: 2, x: 1 }], c: null } }), stableJson({ a: { c: null, d: [1, { x: 1, y: 2 }] }, b: 1 }));
});

test('コメントの文の指紋は、文が変わると変わる', async () => {
  assert.equal(await textPrint('見出しを大きくして'), await textPrint('見出しを大きくして'));
  assert.notEqual(await textPrint('見出しを大きくして'), await textPrint('見出しを小さくして'));
  assert.match(await textPrint('a'), /^[0-9a-f]{64}$/);
});
