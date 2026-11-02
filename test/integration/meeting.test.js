import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadConfig, STUDIO_ROOT } from '../../src/server/config.js';
import { startStudio } from '../../src/server/index.js';

// 会の始めの API と起動(src/server/meeting.js、docs/design/collaboration.md の 7 節、K4)。実モデルは呼ばない。
const posixOnly = { skip: process.platform === 'win32' ? '偽の claude を直接起動するため' : false };
const FAKE = path.join(STUDIO_ROOT, 'test', 'fixtures', 'fake-claude.js');

async function boot(t, env, home = null) {
  const dir = home ?? (await fs.mkdtemp(path.join(os.tmpdir(), 'studio-meeting-')));
  const log = path.join(dir, 'claude.log');
  const allEnv = { PATH: process.env.PATH, HOME: dir, STUDIO_CLAUDE_BIN: FAKE, FAKE_CLAUDE_LOG: log, STUDIO_START_SCREEN: '0', ...env };
  const studio = await startStudio(loadConfig({ ...allEnv, STUDIO_HOME: dir, STUDIO_PORT: '0', STUDIO_PREVIEW_PORT: '0', STUDIO_NO_OPEN: '1' }), { env: allEnv });
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await studio.close();
  };
  t.after(async () => {
    await close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  const { origin, hash } = new URL(studio.url);
  const call = async (pathname, body, headers = { 'x-studio-token': hash.slice('#token='.length), origin }) => {
    const res = await fetch(`${origin}${pathname}`, { method: body === undefined ? 'GET' : 'POST', headers: { ...headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  const launches = async () => (await fs.readFile(log, 'utf8').catch(() => '')).split('\n').filter(Boolean).map((line) => JSON.parse(line)).filter((entry) => entry.argv.includes('-p'));
  const meeting = async (purpose = '架空の配送会社の会') => (await call('/api/meetings', { purpose })).body.project.id;
  return { studio, home: dir, call, launches, meeting, close };
}

test('API: トークンがないと断る。会ではない試作品には会の口がない。目的がないと作らない', posixOnly, async (t) => {
  const { studio, call } = await boot(t, { STUDIO_AGENT: 'fake' });
  assert.equal((await call('/api/meetings', { purpose: '架空' }, {})).status, 401);
  assert.equal((await call('/api/meetings', { purpose: '架空' }, { origin: new URL(studio.url).origin })).status, 401);
  assert.equal((await call('/api/meetings', { purpose: ' ' })).status, 400);
  assert.equal((await call('/api/meetings', { purpose: 'あ'.repeat(201) })).status, 400);
  assert.equal((await call('/api/meetings', { purpose: '090-0000-0000 の会' })).status, 422);
  assert.equal((await call('/api/projects/sample-library/meeting')).status, 404);
  assert.equal((await call('/api/projects/sample-library/meeting/decide', { decision: 'agree' })).status, 404);
  assert.equal((await call('/api/projects/sample-library/meeting/erase', { confirm: 'sample-library' })).status, 404);
  assert.ok(await fs.lstat(path.join(studio.store.home, 'projects', 'sample-library')));
  assert.equal((await call('/api/projects/no-such/meeting')).status, 404);
  assert.equal((await call('/api/projects')).body.meetingsDue.length, 0);
});

test('同意の前は、本物の AI の同意の後でも、整理する AI、作る AI、聞き出す AI、案を出す AI、試作品の中の AI を呼ばない', posixOnly, async (t) => {
  const { studio, call, launches, meeting } = await boot(t, { STUDIO_AGENT: 'claude' });
  const id = await meeting();
  studio.consent.agree();
  const base = `/api/projects/${id}`;
  assert.equal((await call(`${base}/meeting`)).body.meeting.status, 'waiting');

  assert.equal((await call(`${base}/organize/run`, {})).body.error.code, 'meeting-consent-required');
  assert.equal((await call(`${base}/organize/point`, { text: '架空の要点' })).body.error.code, 'meeting-consent-required');
  assert.equal((await call(`${base}/build-requests`, { request: '見出しを大きくして' })).body.error.code, 'meeting-consent-required');
  // 試作品の中の AI の本物の接続。AI の設定のある会で、画面と同じ口を通す
  const app = path.join(studio.store.home, 'projects', id, 'app');
  const manifest = JSON.parse(await fs.readFile(path.join(app, 'prototype.json'), 'utf8'));
  await fs.writeFile(path.join(app, 'prototype.json'), JSON.stringify({ ...manifest, ai: 'ai.json' }));
  await fs.copyFile(path.join(STUDIO_ROOT, 'samples', 'job-consult', 'app', 'ai.json'), path.join(app, 'ai.json'));
  assert.equal((await call(`${base}/builds`, {})).status, 200);
  assert.equal((await call(`${base}/ai`)).status, 200);
  assert.equal((await call(`${base}/ai/connection`, { kind: 'claude-code' })).body.error.code, 'meeting-consent-required');
  assert.throws(() => studio.aiSessions.observationConnection('claude-code', id), { code: 'meeting-consent-required' });
  assert.equal((await call(`${base}/checks`, { connection: 'claude-code' })).body.error.code, 'meeting-consent-required');
  // 聞き出しと設計も、同意の前は断る。決まった問いと決まった案でも、話を入れない
  for (const guide of ['ai', 'fixed']) {
    assert.equal((await call(`${base}/intent/start`, { sentence: '架空の受付', guide })).body.error.code, 'meeting-consent-required');
    assert.equal((await call(`${base}/design/start`, { guide })).body.error.code, 'meeting-consent-required');
  }
  assert.equal((await call(`${base}/organize`)).body.organize.ai, null);
  assert.deepEqual(await launches(), []);

  // 会ではない試作品は、今までどおり動く
  assert.equal((await call('/api/projects/sample-library/organize/point', { text: '架空の要点' })).status, 200);
  assert.equal((await call('/api/projects/sample-library/organize/run', {})).status, 200);
  assert.equal((await launches()).length, 1);
});

test('同意すると本物の AI の同意も入る。起動し直すと、会の同意は残り、本物の AI の同意はまた聞く', posixOnly, async (t) => {
  const first = await boot(t, { STUDIO_AGENT: 'claude' });
  const id = await first.meeting();
  const base = `/api/projects/${id}`;
  assert.equal(first.studio.consent.agreed, false);
  assert.equal((await first.call(`${base}/meeting/decide`, { decision: 'nope' })).status, 400);
  assert.equal(first.studio.consent.agreed, false);
  const agreed = await first.call(`${base}/meeting/decide`, { decision: 'agree' });
  assert.equal(agreed.status, 200);
  assert.equal(agreed.body.meeting.status, 'agreed');
  assert.ok(agreed.body.meeting.decidedAt);
  assert.equal(agreed.body.consent.agreed, true);
  // 同意した後は、お試しに戻さない
  assert.equal((await first.call(`${base}/meeting/decide`, { decision: 'trial' })).status, 409);
  await first.call(`${base}/organize/point`, { text: '架空の要点' });
  assert.equal((await first.call(`${base}/organize/run`, {})).status, 200);
  assert.equal((await first.launches()).length, 1);
  await first.close();

  const second = await boot(t, { STUDIO_AGENT: 'claude' }, first.home);
  assert.equal((await second.call(`${base}/meeting`)).body.meeting.status, 'agreed');
  const refused = await second.call(`${base}/organize/run`, {});
  assert.equal(refused.status, 403);
  assert.equal(refused.body.error.code, 'consent-required');
});

test('外の AI につながっていない起動では、同意しても本物の AI の同意を入れず、画面にも外へ送らないと出す。お試しの会は偽接続を使える', posixOnly, async (t) => {
  const { studio, call, meeting } = await boot(t, { STUDIO_AGENT: 'fake' });
  const id = await meeting();
  const base = `/api/projects/${id}`;
  const view = (await call(`${base}/meeting`)).body.meeting;
  assert.equal(view.sending.outside, false);
  assert.equal(view.viewers, 'この PC を使える人');
  assert.equal((await call(`${base}/meeting/decide`, { decision: 'trial' })).body.meeting.status, 'trial');
  assert.equal(studio.consent.agreed, false);
  await call(`${base}/organize/point`, { text: '再配達の受付を、電話なしで済ませたい' });
  const organized = await call(`${base}/organize/run`, {});
  assert.equal(organized.status, 200);
  assert.ok(organized.body.organize.items.length > 0);
});

test('消す日: 同意と一緒に変えられる。壊れた会の記録は同意の前として扱い、AI を呼ばない', posixOnly, async (t) => {
  const first = await boot(t, { STUDIO_AGENT: 'claude' });
  const id = await first.meeting();
  const base = `/api/projects/${id}`;
  assert.equal((await first.call(`${base}/meeting/delete-on`, { deleteOn: '2020-01-01' })).status, 400);
  assert.equal((await first.call(`${base}/meeting/decide`, { decision: 'agree', deleteOn: '2020-01-01' })).status, 400);
  assert.equal((await first.call(`${base}/meeting`)).body.meeting.status, 'waiting');
  await first.close();
  await fs.writeFile(path.join(first.home, 'projects', id, '.studio', 'meeting.json'), '{ 壊れています');
  const second = await boot(t, { STUDIO_AGENT: 'claude' }, first.home);
  second.studio.consent.agree();
  assert.equal((await second.call(`${base}/organize/run`, {})).body.error.code, 'meeting-consent-required');
  assert.deepEqual(await second.launches(), []);
  // 同意し直すと、記録を書き直して進める
  assert.equal((await second.call(`${base}/meeting/decide`, { decision: 'agree' })).status, 200);
  const record = JSON.parse(await fs.readFile(path.join(first.home, 'projects', id, '.studio', 'meeting.json'), 'utf8'));
  assert.equal(record.status, 'agreed');
});

test('会の記録のファイルが消えても、同意の前として扱う。消す口も残る', posixOnly, async (t) => {
  const first = await boot(t, { STUDIO_AGENT: 'claude' });
  const id = await first.meeting();
  await first.call(`/api/projects/${id}/meeting/decide`, { decision: 'agree' });
  await first.close();
  await fs.rm(path.join(first.home, 'projects', id, '.studio', 'meeting.json'));
  const second = await boot(t, { STUDIO_AGENT: 'claude' }, first.home);
  second.studio.consent.agree();
  const base = `/api/projects/${id}`;
  assert.equal((await second.call(`${base}/organize/run`, {})).body.error.code, 'meeting-consent-required');
  assert.deepEqual(await second.launches(), []);
  assert.equal((await second.call(`${base}/meeting/erase`, { confirm: id })).status, 200);
  await assert.rejects(fs.lstat(path.join(first.home, 'projects', id)));
});

test('外へ送らないと見せて取った同意では、外へ送らない。外の AI につないで起動し直すと、もう一度聞く', posixOnly, async (t) => {
  const first = await boot(t, { STUDIO_AGENT: 'fake' });
  const id = await first.meeting();
  const base = `/api/projects/${id}`;
  await first.call(`${base}/meeting/decide`, { decision: 'agree' });
  assert.equal((await first.call(`${base}/meeting`)).body.meeting.status, 'agreed');
  await first.close();
  const second = await boot(t, { STUDIO_AGENT: 'claude' }, first.home);
  second.studio.consent.agree();
  assert.equal((await second.call(`${base}/meeting`)).body.meeting.status, 'waiting');
  assert.equal((await second.call(`${base}/organize/run`, {})).body.error.code, 'meeting-consent-required');
  assert.deepEqual(await second.launches(), []);
  assert.equal((await second.call(`${base}/meeting/decide`, { decision: 'agree' })).body.meeting.status, 'agreed');
  assert.equal(JSON.parse(await fs.readFile(path.join(first.home, 'projects', id, '.studio', 'meeting.json'), 'utf8')).agreedOutside, true);
});

test('消している間に届いた書き換えは断る。消した後に返った AI は置き場を作り直さない', posixOnly, async (t) => {
  const { studio, call, home, meeting } = await boot(t, { STUDIO_AGENT: 'fake' });
  const id = await meeting();
  const base = `/api/projects/${id}`;
  await call(`${base}/meeting/decide`, { decision: 'agree' });
  studio.store.claimErase(id);
  assert.equal((await call(`${base}/organize/point`, { text: '架空の要点' })).status, 409);
  assert.equal((await call(`${base}/intent/start`, { sentence: '架空の受付', guide: 'fixed' })).status, 409);
  assert.equal((await call(`${base}/design/start`, { guide: 'fixed' })).status, 409);
  studio.store.releaseErase(id);
  assert.equal((await call(`${base}/meeting/erase`, { confirm: id })).status, 200);
  // 遅れて返った書き込み
  await assert.rejects(studio.intents.write(id, { status: 'draft' }));
  await assert.rejects(studio.designs.write(id, { status: 'drafting' }));
  await assert.rejects(studio.organizes.write(id, { status: 'draft' }));
  await assert.rejects(fs.lstat(path.join(home, 'projects', id)));
});

test('消す: AI の応答を待つ間は断る。止めた後は消える。メモリーにも残らない', posixOnly, async (t) => {
  const { studio, call, home, meeting } = await boot(t, { STUDIO_AGENT: 'claude' });
  const id = await meeting();
  const base = `/api/projects/${id}`;
  await call(`${base}/meeting/decide`, { decision: 'agree' });
  await call(`${base}/organize/point`, { text: '[整理が遅い] 架空の要点' });
  const running = call(`${base}/organize/run`, {});
  // 呼び出しが始まるまで待つ
  for (let i = 0; i < 100 && !studio.organizes.calling.has(id); i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(studio.organizes.calling.has(id), true);
  const busy = await call(`${base}/meeting/erase`, { confirm: id });
  assert.equal(busy.status, 409);
  assert.ok(await fs.lstat(path.join(home, 'projects', id)));
  await call(`${base}/organize/cancel`, {});
  await running;

  assert.equal((await call(`${base}/meeting/erase`, { confirm: id })).status, 200);
  await assert.rejects(fs.lstat(path.join(home, 'projects', id)));
  assert.deepEqual((await fs.readdir(path.join(home, 'projects'))).filter((name) => name.startsWith('.erasing')), []);
  assert.equal(studio.organizes.boards.has(id), false);
  assert.equal(studio.meetings.records.has(id), false);
  assert.equal(studio.store.state.has(id), false);
  assert.equal((await call(`${base}/meeting/erase`, { confirm: id })).status, 404);
});
