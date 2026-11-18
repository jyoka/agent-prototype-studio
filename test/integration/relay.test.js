import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { startRelay } from '../../src/relay/relay-server.js';
import { aadOf, importKey, open, randomText, seal, ticketHash } from '../../src/share-page/seal.js';

// 中継のサーバー(docs/design/collaboration.md の 9.4)。暗号文を預かって配るだけ。
// 札で入る人を分け、見るだけの人の書き込みを断り、消す日を過ぎた会と消した会には「消した」と返す。

async function withRelay(t, options = {}) {
  const relay = await startRelay(options);
  t.after(() => relay.close());
  const call = async (pathname, { method = 'GET', ticket, body } = {}) => {
    const response = await fetch(`${relay.url}${pathname}`, {
      method,
      headers: { ...(ticket ? { Authorization: `Bearer ${ticket}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await response.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      // ページなど
    }
    return { status: response.status, headers: response.headers, text, json };
  };
  return { relay, call };
}

async function newSession(call, { expiresAt = new Date(Date.now() + 60_000).toISOString() } = {}) {
  const studio = randomText(32);
  const created = await call('/api/sessions', { method: 'POST', body: { expiresAt, studioTicketHash: await ticketHash(studio) } });
  assert.equal(created.status, 201, created.text);
  return { id: created.json.id, studio };
}

async function addMember(call, session, write) {
  const ticket = randomText(32);
  const member = randomText(12);
  const added = await call(`/api/sessions/${session.id}/members/${member}`, { method: 'PUT', ticket: session.studio, body: { ticketHash: await ticketHash(ticket), write } });
  assert.equal(added.status, 200, added.text);
  return { ticket, member };
}

test('暗号文だけを預かり、札で人を分け、見るだけの人の書き込みを断る', async (t) => {
  const { call } = await withRelay(t);
  const session = await newSession(call);
  const writer = await addMember(call, session, true);
  const viewer = await addMember(call, session, false);
  const key = await importKey(randomText(32));
  const data = await seal(key, aadOf(session.id, 'row'), { op: 'item-edit', id: 'i1', text: '架空の文' });

  // 札なし、知らない札、見るだけの札は書けない
  assert.equal((await call(`/api/sessions/${session.id}/rows`, { method: 'POST', body: { data } })).status, 401);
  assert.equal((await call(`/api/sessions/${session.id}/rows`, { method: 'POST', ticket: randomText(32), body: { data } })).status, 403);
  const refused = await call(`/api/sessions/${session.id}/rows`, { method: 'POST', ticket: viewer.ticket, body: { data } });
  assert.equal(refused.status, 403);
  assert.equal(refused.json.error.code, 'read-only');
  // 平文は受けない
  assert.equal((await call(`/api/sessions/${session.id}/rows`, { method: 'POST', ticket: writer.ticket, body: { data: '平文 です' } })).status, 400);

  const posted = await call(`/api/sessions/${session.id}/rows`, { method: 'POST', ticket: writer.ticket, body: { data } });
  assert.equal(posted.status, 201);
  assert.equal(posted.json.seq, 1);
  // 見るだけの人も読める。書いた人の ID は中継のサーバーが付ける
  const rows = await call(`/api/sessions/${session.id}/rows?since=0`, { ticket: viewer.ticket });
  assert.equal(rows.json.rows.length, 1);
  assert.equal(rows.json.rows[0].member, writer.member);
  assert.deepEqual(await open(key, aadOf(session.id, 'row'), rows.json.rows[0].data), { op: 'item-edit', id: 'i1', text: '架空の文' });
  // 使い道が違えば開けない(中継のサーバーが暗号文を別の口へ移しても読めない)
  await assert.rejects(open(key, aadOf(session.id, 'file:docs'), rows.json.rows[0].data));

  // Studio だけの口は、参加者の札では使えない
  assert.equal((await call(`/api/sessions/${session.id}/files/docs`, { method: 'PUT', ticket: writer.ticket, body: { data } })).status, 403);
  assert.equal((await call(`/api/sessions/${session.id}`, { method: 'DELETE', ticket: writer.ticket })).status, 403);
  assert.equal((await call(`/api/sessions/${session.id}/compact`, { method: 'POST', ticket: writer.ticket, body: { upTo: 1 } })).status, 403);

  const put = await call(`/api/sessions/${session.id}/files/docs`, { method: 'PUT', ticket: session.studio, body: { data } });
  assert.equal(put.json.version, 1);
  assert.equal((await call(`/api/sessions/${session.id}/files/docs`, { ticket: viewer.ticket })).json.data, data);
  assert.equal((await call(`/api/sessions/${session.id}/compact`, { method: 'POST', ticket: session.studio, body: { upTo: 1 } })).json.removed, 1);
  assert.equal((await call(`/api/sessions/${session.id}/rows?since=0`, { ticket: viewer.ticket })).json.rows.length, 0);
});

test('参加者のページは鍵を持たず、外を読まない CSP で出す', async (t) => {
  const { call } = await withRelay(t);
  const session = await newSession(call);
  const page = await call(`/s/${session.id}`);
  assert.equal(page.status, 200);
  const csp = page.headers.get('content-security-policy');
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /connect-src 'self'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.equal(page.headers.get('cache-control'), 'no-store');
  assert.equal(page.headers.get('referrer-policy'), 'no-referrer');
  assert.doesNotMatch(page.text, new RegExp(session.studio));
  assert.equal((await call('/s/seal.js')).status, 200);
  assert.equal((await call('/s/../server/share.js')).status, 404);
});

test('会を消すと、受け取りを待つ人に「消した」を送り、その後は 410 を返す', async (t) => {
  const { call, relay } = await withRelay(t);
  const session = await newSession(call);
  const viewer = await addMember(call, session, false);
  const controller = new AbortController();
  t.after(() => controller.abort());
  const stream = await fetch(`${relay.url}/api/sessions/${session.id}/stream`, { headers: { Authorization: `Bearer ${viewer.ticket}` }, signal: controller.signal });
  assert.equal(stream.status, 200);
  const reader = stream.body.getReader();
  const decoder = new TextDecoder();
  let seen = '';
  const until = async (word) => {
    while (!seen.includes(word)) {
      const { value, done } = await reader.read();
      if (done) break;
      seen += decoder.decode(value, { stream: true });
    }
    return seen.includes(word);
  };
  assert.ok(await until('event: hello'));
  const removed = await call(`/api/sessions/${session.id}`, { method: 'DELETE', ticket: session.studio });
  assert.deepEqual(removed.json.removed, { rows: 0, files: 0 });
  assert.ok(await until('event: deleted'));
  const after = await call(`/api/sessions/${session.id}/rows`, { ticket: viewer.ticket });
  assert.equal(after.status, 410);
  assert.equal(after.json.error.code, 'deleted');
});

test('消す日を過ぎた会は、中継のサーバーが自分で消す', async (t) => {
  let now = Date.now();
  const { call, relay } = await withRelay(t, { now: () => now });
  const session = await newSession(call, { expiresAt: new Date(now + 1000).toISOString() });
  const viewer = await addMember(call, session, false);
  now += 2000;
  await relay.relay.sweep();
  assert.equal(relay.relay.sessions.has(session.id), false);
  assert.equal((await call(`/api/sessions/${session.id}/rows`, { ticket: viewer.ticket })).status, 410);
  // 消す日のない会や、遠すぎる消す日は作らない
  assert.equal((await call('/api/sessions', { method: 'POST', body: { studioTicketHash: await ticketHash('x'.repeat(20)) } })).status, 400);
  assert.equal((await call('/api/sessions', { method: 'POST', body: { expiresAt: new Date(now + 400 * 86400_000).toISOString(), studioTicketHash: await ticketHash('x'.repeat(20)) } })).status, 400);
});

test('置き場を渡すと、止めて起こし直しても続きから配る', async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-data-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const first = await startRelay({ dataDir });
  const call = async (base, pathname, init = {}) => (await fetch(`${base}${pathname}`, init)).json();
  const studio = randomText(32);
  const { id } = await call(first.url, '/api/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expiresAt: new Date(Date.now() + 60_000).toISOString(), studioTicketHash: await ticketHash(studio) }) });
  await call(first.url, `/api/sessions/${id}/files/docs`, { method: 'PUT', headers: { Authorization: `Bearer ${studio}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ data: 'AAAA' }) });
  await first.close();
  const second = await startRelay({ dataDir });
  t.after(() => second.close());
  const file = await call(second.url, `/api/sessions/${id}/files/docs`, { headers: { Authorization: `Bearer ${studio}` } });
  assert.equal(file.data, 'AAAA');
  assert.equal(file.version, 1);
});
