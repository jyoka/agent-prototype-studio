import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { startStudio } from '../../src/server/index.js';
import { startRelay } from '../../src/relay/relay-server.js';
import { aadOf, generateSigner, importKey, importSigner, open, seal, signEvent, textPrint } from '../../src/share-page/seal.js';

// 共有の場の Studio の側(src/server/share.js。docs/design/collaboration.md の 9.4、K7 の 2 枚目)。
// 中継のサーバーに届くのは、会の鍵で包んだ文書の写しと書き込みだけ。app/ のソースと run の記録は届かない。
// 作る AI は偽接続(agent: 'fake')。実モデルは呼ばない。

const ID = 'sample-library';

function request(port, { method = 'GET', pathname = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: pathname, headers }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => (text += chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: text }));
    });
    req.setTimeout(60_000, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end(body);
  });
}

async function waitFor(check, what, ms = 10_000) {
  const until = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > until) throw new Error(`${what} が ${ms}ms で起きません`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function withShare(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-share-'));
  const bodies = [];
  const relay = await startRelay({ onBody: (entry) => bodies.push(JSON.stringify(entry)) });
  const studio = await startStudio({ home, studioPort: 0, previewPort: 0, openBrowser: false, agent: 'fake', relayUrl: relay.url }, { env: { PATH: process.env.PATH } });
  t.after(async () => {
    await studio.close();
    await relay.close();
    await fs.rm(home, { recursive: true, force: true });
  });
  const token = new URL(studio.url).hash.slice('#token='.length);
  const sp = studio.ports.studio;
  const host = `127.0.0.1:${sp}`;
  const headers = { host, 'x-studio-token': token, origin: `http://${host}`, 'content-type': 'application/json' };
  const post = async (pathname, body) => {
    const response = await request(sp, { method: 'POST', pathname, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, json: JSON.parse(response.body.trim().split('\n').at(-1)) };
  };
  return { home, studio, relay, bodies, post };
}

// 招待のリンクのフラグメントから、鍵と札と人の ID を読む(参加者のページと同じ読み方)
function readLink(link) {
  const url = new URL(link);
  const params = new URLSearchParams(url.hash.slice(1));
  return { sessionId: url.pathname.split('/').pop(), key: params.get('k'), ticket: params.get('t'), member: params.get('m'), signingKey: params.get('s') };
}

// 参加者のページと同じに、署名してから会の鍵で包む。signAs を渡すと、その人の鍵で署名する(偽の書き込みを作るため)
async function sealRow(member, op, { signAs = member, by } = {}) {
  const { sessionId, key, member: id } = readLink(member.link);
  const signed = await signEvent(await importSigner(readLink(signAs.link).signingKey ?? (await generateSigner()).privateKey), sessionId, { opId: crypto.randomUUID(), at: new Date().toISOString(), ...op, by: by ?? id });
  return seal(await importKey(key), aadOf(sessionId, 'row'), signed);
}

async function postRow(relay, member, data) {
  const { sessionId, ticket } = readLink(member.link);
  return fetch(`${relay.url}/api/sessions/${sessionId}/rows`, { method: 'POST', headers: { Authorization: `Bearer ${ticket}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ data }) });
}

async function docsOf(relay, link) {
  const { sessionId, key, ticket } = readLink(link);
  const response = await fetch(`${relay.url}/api/sessions/${sessionId}/files/docs`, { headers: { Authorization: `Bearer ${ticket}` } });
  if (!response.ok) return null;
  return open(await importKey(key), aadOf(sessionId, 'file:docs'), (await response.json()).data);
}

test('中継のサーバーには、包んだ文書だけが届き、app/ のソースと run の記録は届かない', async (t) => {
  const { home, studio, relay, bodies, post } = await withShare(t);
  const board = '/api/projects/sample-library/organize';
  // 架空の要点と項目。中継のサーバーの置き場に、平文で出てこないことを確かめる
  const itemText = '貸出の期限は架空の十四日にする';
  assert.equal((await post(`${board}/item`, { column: 'rule', text: itemText })).status, 200);

  // 作る AI(偽接続)に直させ、app/ と run の記録を作る。共有を始める前と後の両方で作る
  const before = await post(`/api/projects/${ID}/build-requests`, { request: '見出しを「共有の前の図書室」にして' });
  assert.ok(['passed', 'unverified'].includes(before.json.run.status), JSON.stringify(before.json.run.status));

  const started = await post(`/api/projects/${ID}/share/start`);
  assert.equal(started.status, 200, JSON.stringify(started.json));
  const invited = await post(`/api/projects/${ID}/share/invite`, { name: '架空の参加者', role: 'participant' });
  assert.equal(invited.status, 200, JSON.stringify(invited.json));
  const link = invited.json.share.members[0].link;
  assert.match(link, new RegExp(`^${relay.url}/s/[A-Za-z0-9_-]+#k=`));

  const after = await post(`/api/projects/${ID}/build-requests`, { request: '見出しを「共有の後の図書室」にして' });
  assert.ok(['passed', 'unverified'].includes(after.json.run.status));
  // 写しが置き直されるのを待つ(板の項目が載っている)
  const docs = await waitFor(async () => {
    const value = await docsOf(relay, link);
    return value?.board.items.some((item) => item.text === itemText) ? value : null;
  }, '写しを置く');
  assert.deepEqual(Object.keys(docs).sort(), ['at', 'board', 'comments', 'dataDesign', 'format', 'members', 'openItems', 'requirements', 'results', 'scenes', 'seen', 'title'].sort());
  assert.ok(docs.requirements.sections.some((section) => section.items.some((item) => item.text === itemText)));

  // 中継のサーバーが受け取ったもの全部と、置き場に残ったもの全部
  const session = [...relay.relay.sessions.values()][0];
  const raw = `${bodies.join('\n')}\n${JSON.stringify(session)}`;
  assert.ok(!raw.includes(itemText), '板の文が平文で届いた');
  assert.ok(!raw.includes('架空の参加者'), '人の呼び名が平文で届いた');
  // 包んだものを開いた中身も含めて、app/ のソースと run の記録を探す
  const key = await importKey(readLink(link).key);
  const opened = [];
  for (const [name, file] of Object.entries(session.files)) opened.push(JSON.stringify(await open(key, aadOf(session.id, `file:${name}`), file.data)));
  const everything = `${raw}\n${opened.join('\n')}`;
  const app = path.join(home, 'projects', ID, 'app');
  const source = await fs.readFile(path.join(app, 'App.jsx'), 'utf8');
  assert.match(source, /共有の後の図書室/);
  for (const word of ['共有の前の図書室', '共有の後の図書室', 'App.jsx', 'export default', 'import ']) assert.ok(!everything.includes(word), `app/ のソースらしいものが届いた: ${word}`);
  for (const run of [before.json.run, after.json.run]) {
    assert.ok(!everything.includes(run.id), `run の ID が届いた: ${run.id}`);
    const record = await fs.readFile(path.join(home, 'projects', ID, run.evidence.run), 'utf8');
    assert.ok(record.length > 0);
  }
  for (const word of ['runs/', 'run.json', 'changedFiles', 'gates', '見出しを']) assert.ok(!everything.includes(word), `run の記録らしいものが届いた: ${word}`);
});

test('参加者の書き込みを Studio が板に当てる。見るだけの人と記録らしいものは当てない', async (t) => {
  const { studio, relay, post } = await withShare(t);
  const board = '/api/projects/sample-library/organize';
  const added = await post(`${board}/item`, { column: 'requirement', text: '本を探せる' });
  const itemId = added.json.organize.items.find((item) => item.text === '本を探せる').id;
  await post(`/api/projects/${ID}/share/start`);
  const participant = (await post(`/api/projects/${ID}/share/invite`, { name: '参加者 A', role: 'participant' })).json.share.members.at(-1);
  const viewer = (await post(`/api/projects/${ID}/share/invite`, { name: '見る人 B', role: 'viewer' })).json.share.members.at(-1);
  assert.equal(viewer.role, 'viewer');
  const write = async (member, op) => postRow(relay, member, await sealRow(member, op));
  assert.equal((await write(viewer, { op: 'item-edit', id: itemId, text: '見るだけの人の文' })).status, 403);
  assert.equal((await write(participant, { op: 'item-edit', id: itemId, text: '本を題と著者で探せる' })).status, 201);
  assert.equal((await write(participant, { op: 'item-add', column: 'user', text: '電話 090-1234-5678 の人' })).status, 201);
  await waitFor(() => studio.organizes.boards.get(ID)?.items.some((item) => item.text === '本を題と著者で探せる'), '板に当てる');
  const docs = await waitFor(async () => {
    const value = await docsOf(relay, participant.link);
    return value?.seen >= 2 ? value : null;
  }, '写しに当てた番号が載る');
  assert.ok(docs.board.items.some((item) => item.text === '本を題と著者で探せる'));
  // 記録らしいものは断り、理由を写しに載せる。板にも入れない
  assert.ok(docs.results.some((r) => !r.ok && /電話番号/.test(r.message)), JSON.stringify(docs.results));
  assert.ok(!studio.organizes.boards.get(ID).items.some((item) => item.text.includes('090')));
  assert.ok(!studio.organizes.boards.get(ID).points.some((point) => point.text.includes('090')));
  // 当てた書き込みは、中継のサーバーから消す(詰め直し)
  await waitFor(() => [...relay.relay.sessions.values()][0].rows.length === 0, '当てた書き込みを消す');
});

test('会のデータを消すと、中継のサーバーの写しも消す', async (t) => {
  const { studio, relay, post } = await withShare(t);
  const created = await post('/api/meetings', { purpose: '架空の図書室の会' });
  const id = created.json.project.id;
  // 同意の前は共有を始められない
  assert.equal((await post(`/api/projects/${id}/share/start`)).status, 403);
  await post(`/api/projects/${id}/meeting/decide`, { decision: 'trial' });
  const started = await post(`/api/projects/${id}/share/start`);
  assert.equal(started.status, 200, JSON.stringify(started.json));
  const sessionId = [...relay.relay.sessions.keys()][0];
  // 中継のサーバーの消す日は、会の消す日の終わり
  const deleteOn = studio.meetings.records.get(id).deleteOn;
  assert.equal(new Date(relay.relay.sessions.get(sessionId).expiresAt).toISOString(), new Date(`${deleteOn}T23:59:59`).toISOString());
  const plan = (await post(`/api/projects/${id}/meeting/erase`, { confirm: id })).json;
  assert.ok(plan.erased.some((row) => row.key === 'relay'), JSON.stringify(plan.erased));
  assert.equal(relay.relay.sessions.has(sessionId), false);
});

test('中継のサーバーに届かないときは、写しを消せなかったと知らせ、次の起動で消し直す', async (t) => {
  const { home, studio, relay, post } = await withShare(t);
  const created = await post('/api/meetings', { purpose: '架空の消し直しの会' });
  const id = created.json.project.id;
  await post(`/api/projects/${id}/meeting/decide`, { decision: 'trial' });
  await post(`/api/projects/${id}/share/start`);
  const sessionId = [...relay.relay.sessions.keys()][0];
  // 中継のサーバーへの道を断つ(fetch を失敗させる)
  const real = studio.shares.fetchImpl;
  studio.shares.fetchImpl = async () => {
    throw new TypeError('fetch failed');
  };
  const erased = (await post(`/api/projects/${id}/meeting/erase`, { confirm: id })).json;
  assert.ok(erased.notErased.some((line) => line.startsWith('中継のサーバーの写しは消せませんでした')), JSON.stringify(erased.notErased));
  assert.ok(!erased.erased.some((row) => row.key === 'relay'));
  assert.equal(relay.relay.sessions.has(sessionId), true);
  const pending = JSON.parse(await fs.readFile(path.join(home, 'share-pending.json'), 'utf8'));
  assert.equal(pending[0].sessionId, sessionId);
  // 次の起動と同じ消し直し
  studio.shares.fetchImpl = real;
  await studio.shares.retryPending();
  assert.equal(relay.relay.sessions.has(sessionId), false);
  await assert.rejects(fs.access(path.join(home, 'share-pending.json')));
});

test('中継のサーバーが見るだけの人の書き込みを断り損ねても、Studio は役の表で捨てる。同じ書き込みは 1 度だけ当てる', async (t) => {
  const { studio, relay, post } = await withShare(t);
  const board = '/api/projects/sample-library/organize';
  await post(`${board}/item`, { column: 'requirement', text: '本を探せる' });
  await post(`/api/projects/${ID}/share/start`);
  const participant = (await post(`/api/projects/${ID}/share/invite`, { name: '参加者 A', role: 'participant' })).json.share.members.at(-1);
  const viewer = (await post(`/api/projects/${ID}/share/invite`, { name: '見る人 B', role: 'viewer' })).json.share.members.at(-1);
  // 中継のサーバーの不具合を真似る: 見るだけの人にも書かせる
  const session = [...relay.relay.sessions.values()][0];
  session.members[readLink(viewer.link).member].write = true;
  assert.equal((await postRow(relay, viewer, await sealRow(viewer, { op: 'item-add', column: 'user', text: '見るだけの人が足した項目', opId: 'v1' }))).status, 201);
  // 送り直し(返事が届かなかった、中継のサーバーが同じ暗号文を配り直した)は 1 度だけ当てる
  const twice = await sealRow(participant, { op: 'item-add', column: 'user', text: '本を借りる人', opId: 'p1' });
  assert.equal((await postRow(relay, participant, twice)).status, 201);
  assert.equal((await postRow(relay, participant, twice)).status, 201);
  const docs = await waitFor(async () => {
    const value = await docsOf(relay, participant.link);
    return value?.seen >= 3 ? value : null;
  }, '3 つの書き込みを当てる');
  const items = studio.organizes.boards.get(ID).items;
  assert.equal(items.filter((item) => item.text === '本を借りる人').length, 1);
  assert.ok(!items.some((item) => item.text === '見るだけの人が足した項目'));
  assert.ok(docs.results.some((r) => !r.ok && /書ける人の書き込みではない/.test(r.message)), JSON.stringify(docs.results));
});

test('「共有を始める」が 2 つ同時に届いても、会は 1 つだけ作る', async (t) => {
  const { relay, post } = await withShare(t);
  const [a, b] = await Promise.all([post(`/api/projects/${ID}/share/start`), post(`/api/projects/${ID}/share/start`)]);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.equal(relay.relay.sessions.size, 1);
});

test('中継のサーバーの宛先を決めずに起動し直しても、会のデータを消すと前の写しを消しに行く', async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-share-'));
  const relay = await startRelay();
  t.after(async () => {
    await relay.close();
    await fs.rm(home, { recursive: true, force: true });
  });
  const config = { home, studioPort: 0, previewPort: 0, openBrowser: false, agent: 'fake' };
  const first = await startStudio({ ...config, relayUrl: relay.url }, { env: { PATH: process.env.PATH } });
  const id = await first.meetings.create({ purpose: '架空の起動し直しの会' });
  await first.meetings.decide(id, { decision: 'trial' });
  await first.shares.start(id);
  await first.close();
  assert.equal(relay.relay.sessions.size, 1);
  // 宛先なしで起動し直す。共有はつながないが、記録は覚えておく
  const second = await startStudio(config, { env: { PATH: process.env.PATH } });
  t.after(() => second.close());
  assert.equal(second.shares.links.size, 0);
  assert.match((await second.shares.view(id)).problem, /宛先が違う/);
  const erased = await second.meetings.erase(id, { confirm: id });
  assert.ok(erased.erased.some((row) => row.key === 'relay'), JSON.stringify(erased.erased));
  assert.equal(relay.relay.sessions.size, 0);
});

test('コメントと承認: 決める人の承認がそろっても「進行役が送る待ち」で止まり、進行役が送るまで作る AI は動かない', async (t) => {
  const { studio, relay, post } = await withShare(t);
  await post(`/api/projects/${ID}/share/start`);
  const invite = async (name, role) => (await post(`/api/projects/${ID}/share/invite`, { name, role })).json.share.members.at(-1);
  const participant = await invite('参加者 A', 'participant');
  const decider = await invite('決める人 B', 'decider');
  assert.match(decider.link, /&s=[A-Za-z0-9_-]+$/);
  const comments = async () => (await studio.comments.view(ID)).comments;
  const seen = async (n) => waitFor(async () => {
    const value = await docsOf(relay, participant.link);
    return value?.seen >= n ? value : null;
  }, `${n} 個の書き込みを当てる`);

  // 参加者がコメントを書く。名前は役の表から付く
  assert.equal((await postRow(relay, participant, await sealRow(participant, { op: 'comment-add', kind: 'look', text: '見出しを「ひだまり図書室」にして', opId: 'c1' }))).status, 201);
  let docs = await seen(1);
  const [comment] = await comments();
  assert.equal(comment.author, '参加者 A');
  assert.equal(comment.sharedBy, readLink(participant.link).member);
  assert.equal(docs.comments[0].text, '見出しを「ひだまり図書室」にして');
  const print = await textPrint(comment.text);

  // 参加者の役の承認(自分の鍵で正しく署名)は数えない
  await postRow(relay, participant, await sealRow(participant, { op: 'comment-approve', comment: comment.id, textPrint: print, opId: 'a1' }));
  // 参加者が、決める人のふりをする(書き込みの中の人を決める人にし、自分の鍵で署名)
  await postRow(relay, participant, await sealRow(participant, { op: 'comment-approve', comment: comment.id, textPrint: print, opId: 'a2' }, { by: readLink(decider.link).member }));
  // 中継のサーバーが、参加者の書き込みを決める人のものにすり替える(署名は参加者の鍵のまま)
  const session = [...relay.relay.sessions.values()][0];
  const swapped = await sealRow(participant, { op: 'comment-approve', comment: comment.id, textPrint: print, opId: 'a3' }, { by: readLink(decider.link).member });
  await postRow(relay, participant, swapped);
  session.rows.at(-1).member = readLink(decider.link).member;
  // 文の指紋が違う承認
  await postRow(relay, decider, await sealRow(decider, { op: 'comment-approve', comment: comment.id, textPrint: 'x'.repeat(64), opId: 'a4' }));
  docs = await seen(5);
  assert.deepEqual(docs.results.slice(-4).map((r) => r.ok), [false, false, false, false], JSON.stringify(docs.results));
  assert.match(docs.results.at(-4).message, /決める人の役ではない/);
  assert.match(docs.results.at(-3).message, /署名が合わない/);
  assert.match(docs.results.at(-2).message, /署名が合わない/);
  assert.match(docs.results.at(-1).message, /文が承認したときと違う/);
  assert.equal((await comments())[0].status, 'open');
  assert.equal((await comments())[0].approvals.length, 0);

  // 決める人の承認でそろう。列には並ばず、進行役が送る待ち。作る AI は起動しない
  await postRow(relay, decider, await sealRow(decider, { op: 'comment-approve', comment: comment.id, textPrint: print, opId: 'a5' }));
  docs = await seen(6);
  const [awaiting] = await comments();
  assert.equal(awaiting.status, 'awaiting');
  assert.deepEqual(awaiting.approvals.map((a) => [a.role, a.via, a.pressedBy]), [['decider', 'shared', '決める人 B']]);
  assert.equal(docs.comments[0].status, 'awaiting');
  const view = await studio.shares.view(ID);
  assert.equal(view.awaiting[0].id, comment.id);
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(studio.requests.summary(ID).running, false);
  assert.equal(studio.comments.fixing.has(ID), false);

  // 進行役が送ると、列に並ぶ
  const sent = await post(`/api/projects/${ID}/comments/${comment.id}/send`, { pressedBy: '進行役' });
  assert.equal(sent.status, 200, JSON.stringify(sent.json));
  assert.ok(['queued', 'fixing', 'review'].includes(sent.json.comment.status), sent.json.comment.status);
  await waitFor(async () => (await comments())[0].status === 'review', '直し終わる', 60_000);
  const record = (await comments())[0].records[0];
  assert.equal(record.approval.approvers[0].via, 'shared');
  assert.equal(record.approval.sentBy.pressedBy, '進行役');
});

test('要件のコメントは、決める人の承認だけでは送る待ちにならない', async (t) => {
  const { studio, relay, post } = await withShare(t);
  await post(`/api/projects/${ID}/share/start`);
  const decider = (await post(`/api/projects/${ID}/share/invite`, { name: '決める人 B', role: 'decider' })).json.share.members.at(-1);
  await postRow(relay, decider, await sealRow(decider, { op: 'comment-add', kind: 'requirement', text: '貸出の上限を 5 冊にして', opId: 'r1' }));
  await waitFor(async () => (await studio.comments.view(ID)).comments.length === 1, 'コメントが届く');
  const [comment] = (await studio.comments.view(ID)).comments;
  await postRow(relay, decider, await sealRow(decider, { op: 'comment-approve', comment: comment.id, textPrint: await textPrint(comment.text), opId: 'r2' }));
  await waitFor(async () => (await studio.comments.view(ID)).comments[0].approvals.length === 1, '承認が届く');
  assert.equal((await studio.comments.view(ID)).comments[0].status, 'open');
  // 進行役が自分の画面で承認すると、それが最後の 1 押しになり、列に並ぶ
  const approved = await post(`/api/projects/${ID}/comments/${comment.id}/approve`, { role: 'facilitator', pressedBy: '進行役' });
  assert.equal(approved.status, 200);
  assert.ok(['queued', 'fixing', 'review'].includes(approved.json.comment.status));
  await waitFor(async () => ['review', 'failed'].includes((await studio.comments.view(ID)).comments[0].status), '直し終わる', 60_000);
});

test('外した人の承認は数えない。古い承認の出し直しと、書き込みの ID のない書き込みは当てない', async (t) => {
  const { studio, relay, post } = await withShare(t);
  await post(`/api/projects/${ID}/share/start`);
  const invite = async (name, role) => (await post(`/api/projects/${ID}/share/invite`, { name, role })).json.share.members.at(-1);
  const decider = await invite('決める人 B', 'decider');
  const viewer = await invite('見る人 C', 'viewer');
  // 見るだけの人のリンクには、署名の鍵を入れない
  assert.equal(readLink(viewer.link).signingKey, null);
  const comments = async () => (await studio.comments.view(ID)).comments;
  const results = async (n) => (await waitFor(async () => {
    const value = await docsOf(relay, decider.link);
    return value?.seen >= n ? value : null;
  }, `${n} 個の書き込みを当てる`)).results;

  await postRow(relay, decider, await sealRow(decider, { op: 'comment-add', kind: 'look', text: '見出しを「ひだまり図書室」にして' }));
  await results(1);
  const [comment] = await comments();
  const print = await textPrint(comment.text);
  const early = new Date(Date.now() - 60_000).toISOString();
  // 承認して、取り消す
  await postRow(relay, decider, await sealRow(decider, { op: 'comment-approve', comment: comment.id, textPrint: print }));
  await postRow(relay, decider, await sealRow(decider, { op: 'comment-unapprove', comment: comment.id }));
  await results(3);
  assert.equal((await comments())[0].status, 'open');
  // 取り消しより前の時刻の承認(覚えている書き込みの ID の外から出し直されたもの)は当てない
  await postRow(relay, decider, await sealRow(decider, { op: 'comment-approve', comment: comment.id, textPrint: print, at: early }));
  // 書き込みの ID のない書き込みは当てない
  await postRow(relay, decider, await sealRow(decider, { op: 'comment-approve', comment: comment.id, textPrint: print, opId: '' }));
  let last = await results(5);
  assert.match(last.at(-2).message, /前に当てた書き込みより古い/);
  assert.match(last.at(-1).message, /書き込みの ID がない/);
  assert.equal((await comments())[0].status, 'open');

  // 承認がそろって送る待ちになった後に人を外すと、その承認を外し、送れなくなる
  await postRow(relay, decider, await sealRow(decider, { op: 'comment-approve', comment: comment.id, textPrint: print }));
  last = await results(6);
  assert.equal((await comments())[0].status, 'awaiting', JSON.stringify(last.at(-1)));
  const removed = await post(`/api/projects/${ID}/share/remove`, { member: readLink(decider.link).member });
  assert.equal(removed.status, 200, JSON.stringify(removed.json));
  assert.equal((await comments())[0].status, 'open');
  assert.equal((await comments())[0].approvals.length, 0);
  assert.equal((await post(`/api/projects/${ID}/comments/${comment.id}/send`, {})).status, 409);
  // 中継のサーバーでも札を消した
  assert.equal([...relay.relay.sessions.values()][0].members[readLink(decider.link).member], undefined);
});

test('中継のサーバーに届かなくても、人を外すと役の表から先に外し、つながったときに札を消す', async (t) => {
  const { studio, relay, post } = await withShare(t);
  await post(`/api/projects/${ID}/share/start`);
  const participant = (await post(`/api/projects/${ID}/share/invite`, { name: '参加者 A', role: 'participant' })).json.share.members.at(-1);
  const member = readLink(participant.link).member;
  const real = studio.shares.fetchImpl;
  studio.shares.fetchImpl = async (url, options) => {
    if (options?.method === 'DELETE') throw new TypeError('fetch failed');
    return real(url, options);
  };
  const removed = await post(`/api/projects/${ID}/share/remove`, { member });
  assert.equal(removed.status, 502);
  assert.match(removed.json.error.message, /役の表からは外しました/);
  assert.deepEqual((await studio.shares.view(ID)).members, []);
  assert.ok([...relay.relay.sessions.values()][0].members[member]);
  // つながり直すと、札を消し直す
  studio.shares.fetchImpl = real;
  await studio.shares.links.get(ID).revoke();
  assert.equal([...relay.relay.sessions.values()][0].members[member], undefined);
  assert.deepEqual(studio.shares.links.get(ID).record.revoked, []);
});
