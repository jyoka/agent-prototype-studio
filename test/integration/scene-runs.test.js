import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadConfig, STUDIO_ROOT } from '../../src/server/config.js';
import { startStudio } from '../../src/server/index.js';

// 主の画面の場面の回し(src/server/scene-runs.js、task 423)の API。実モデルは呼ばない。
// 本物の AI は偽の claude(test/fixtures/fake-claude.js)。見本は架空のしおかぜ便の運送約款(samples/terms-help)で、
// RAG ありの構成となしの構成(compare/)を並べる。RAG なしの構成では、約款を読む場面が通らない

const FAKE = path.join(STUDIO_ROOT, 'test', 'fixtures', 'fake-claude.js');
const SAMPLE = path.join(STUDIO_ROOT, 'samples', 'terms-help');
const ID = 'terms-help';

function request(port, { method = 'GET', pathname = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: pathname, headers }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => (text += chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: text }));
    });
    req.setTimeout(20_000, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end(body);
  });
}

async function setup(t, extraEnv = {}) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-scenes-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const root = path.join(home, 'projects', ID);
  await fs.cp(path.join(SAMPLE, 'app'), path.join(root, 'app'), { recursive: true });
  for (const dir of ['compositions', 'mocks', 'prompts']) await fs.cp(path.join(SAMPLE, 'compare', dir), path.join(root, 'app', dir), { recursive: true });
  await fs.mkdir(path.join(root, '.studio'), { recursive: true });
  await fs.writeFile(path.join(root, '.studio', 'project.json'), JSON.stringify({ title: 'しおかぜ便の約款の相談(架空)' }));
  const log = path.join(home, 'fake-claude.jsonl');
  const env = { PATH: process.env.PATH, STUDIO_AGENT: 'fake', STUDIO_CLAUDE_BIN: FAKE, FAKE_CLAUDE_LOG: log, ...extraEnv };
  const studio = await startStudio(loadConfig({ ...env, STUDIO_HOME: home, STUDIO_PORT: '0', STUDIO_PREVIEW_PORT: '0', STUDIO_NO_OPEN: '1' }), { env });
  t.after(() => studio.close());
  const token = new URL(studio.url).hash.slice('#token='.length);
  const port = studio.ports.studio;
  const host = `127.0.0.1:${port}`;
  const headers = { host, 'x-studio-token': token, origin: `http://${host}` };
  const call = async (pathname, json) => {
    const res = await request(port, {
      method: json === undefined ? 'GET' : 'POST',
      pathname,
      headers: { ...headers, ...(json === undefined ? {} : { 'content-type': 'application/json' }) },
      body: json === undefined ? undefined : JSON.stringify(json),
    });
    return { status: res.status, body: JSON.parse(res.body) };
  };
  // 回し終わるまで待つ(上限 60 秒)
  const finished = async () => {
    const until = Date.now() + 60_000;
    for (;;) {
      const { body } = await call(`/api/projects/${ID}/scenes`);
      if (!body.scenes.running) return body.scenes;
      if (Date.now() > until) throw new Error('場面の回しが 60 秒で終わりません');
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  };
  const modelCalls = async () => (await fs.readFile(log, 'utf8').catch(() => '')).split('\n').filter(Boolean).length;
  const runDirs = async () => (await fs.readdir(path.join(root, '.studio', 'evals')).catch(() => [])).filter((name) => name !== 'ledger.jsonl');
  return { home, root, studio, call, finished, modelCalls, runDirs };
}

test('お試しの AI で回すと、構成ごとの比べる表と、通らない場面と「直す」の依頼の文が返り、結果は .studio/evals/ に残る', async (t) => {
  const { call, finished, modelCalls, runDirs } = await setup(t);
  const before = await call(`/api/projects/${ID}/scenes`);
  assert.equal(before.status, 200);
  assert.equal(before.body.scenes.scenes.length, 4);
  assert.equal(before.body.scenes.compositions, 2);
  assert.equal(before.body.scenes.last, null);
  const listed = (await call('/api/projects')).body.projects.find((p) => p.id === ID);
  assert.deepEqual({ count: listed.scenes.count, running: listed.scenes.running }, { count: 4, running: false });

  const started = await call(`/api/projects/${ID}/scenes/run`, { connection: 'mock' });
  assert.equal(started.status, 200);
  const scenes = await finished();
  assert.equal(scenes.problem, null);
  const { last } = scenes;
  assert.equal(last.status, 'done');
  assert.equal(last.real, false);
  assert.deepEqual(
    last.rows.map((row) => [row.composition.file, row.connection, row.passed, row.ran, row.failed, row.costUsd, row.medianReplySeconds]),
    [
      ['composition.json', 'mock', 4, 4, 0, null, null],
      ['compositions/no-rag.json', 'mock', 0, 2, 2, null, null],
    ],
  );
  assert.deepEqual(last.failures.map((f) => [f.row, f.id]), [['1', 'terms-damage'], ['1', 'terms-redelivery-fee']]);
  const request = last.failures[0].request;
  assert.match(request, /^場面「terms-damage」\(.+\)が、構成「RAG なし: 約款を読まない\(架空\)」をお試しの AI で回したときに通りませんでした。/);
  assert.match(request, /確かめ「replyContains」: 期待 返事に「30 万円」がある、実際 /);
  assert.match(request, /場面の一覧と守り\(ガードレール\)は弱めずに/);
  // 画面に出す依頼の文に、開発の言葉(app/ など)を入れない
  assert.doesNotMatch(request, /app\/|モック/);
  assert.equal((await runDirs()).length, 1);
  // お試しの AI だけなので、本物の AI(偽の claude)は 1 回も呼ばない
  assert.equal(await modelCalls(), 0);
});

test('本物の AI は、同意の前は呼ばずに断る。同意の後は費用の上限で止め、台帳に残す', async (t) => {
  const { root, call, finished, modelCalls, runDirs } = await setup(t);
  const refused = await call(`/api/projects/${ID}/scenes/run`, { connection: 'claude-code', limitUsd: 1 });
  assert.equal(refused.status, 403);
  assert.equal(refused.body.error.code, 'consent-required');
  assert.match(refused.body.error.message, /本物の AI で場面を回すには、本物の AI を使うことへの同意が要ります/);
  assert.equal(await modelCalls(), 0);
  assert.deepEqual(await runDirs(), []);

  // 上限のない本物の回しは、同意の後でも始めない
  await call('/api/real-ai/consent', {});
  for (const limitUsd of [undefined, 0, -1, 101, 'abc']) {
    const bad = await call(`/api/projects/${ID}/scenes/run`, { connection: 'claude-code', limitUsd });
    assert.equal(bad.status, 400, String(limitUsd));
    assert.equal(bad.body.error.code, 'invalid-limit');
  }
  assert.equal(await modelCalls(), 0);

  // 偽の claude の 1 回の返事は 0.002 USD。上限 0.001 USD なら、最初の返事の後で止める
  const started = await call(`/api/projects/${ID}/scenes/run`, { connection: 'claude-code', limitUsd: 0.001 });
  assert.equal(started.status, 200);
  assert.equal(started.body.scenes.running.real, true);
  // 回している間は、もう 1 つ始めない
  const busy = await call(`/api/projects/${ID}/scenes/run`, { connection: 'mock' });
  assert.equal(busy.status, 409);
  const { last } = await finished();
  assert.equal(last.real, true);
  assert.equal(last.status, 'stopped');
  assert.match(last.stopReason, /上限/);
  assert.equal(last.stopText, '使った費用が上限に達したので、次の返事を始めずに止めました');
  // 途中で止めた結果は、場面がそろわなくても古いと出さない
  assert.equal(last.stale, false);
  assert.equal(last.limitUsd, 0.001);
  assert.equal(last.rows[0].real, true);
  assert.ok(last.rows[0].costUsd > 0);
  assert.ok(await modelCalls() > 0);
  const ledger = (await fs.readFile(path.join(root, '.studio', 'evals', 'ledger.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(ledger.length, 1);
  assert.ok(ledger[0].costUsd > 0);
});

test('本物の AI を使わない設定(STUDIO_ALLOW_CLAUDE_CODE=0)では、同意の後でも本物の AI で回さない', async (t) => {
  const { call, modelCalls } = await setup(t, { STUDIO_ALLOW_CLAUDE_CODE: '0' });
  await call('/api/real-ai/consent', {});
  const view = (await call(`/api/projects/${ID}/scenes`)).body.scenes;
  assert.equal(view.real.available, false);
  const refused = await call(`/api/projects/${ID}/scenes/run`, { connection: 'claude-code', limitUsd: 1 });
  assert.equal(refused.status, 403);
  assert.equal(refused.body.error.code, 'disabled');
  assert.equal(await modelCalls(), 0);
});

test('場面の一覧のない試作品(求人相談)では回さず、比べる表もない', async (t) => {
  const { call } = await setup(t);
  const job = 'sample-job-consult';
  const view = (await call(`/api/projects/${job}/scenes`)).body.scenes;
  assert.deepEqual(view.scenes, []);
  assert.equal(view.last, null);
  const refused = await call(`/api/projects/${job}/scenes/run`, { connection: 'mock' });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error.code, 'no-scenes');
  const missing = await call('/api/projects/no-such-project/scenes');
  assert.equal(missing.status, 404);
});

test('同じ試作品で同時に回し始めても、回すのは 1 つだけ。ほかは busy で断る', async (t) => {
  const { call, finished, runDirs } = await setup(t);
  const answers = await Promise.all([1, 2, 3].map(() => call(`/api/projects/${ID}/scenes/run`, { connection: 'mock' })));
  assert.deepEqual(answers.map((a) => a.status).sort(), [200, 409, 409]);
  for (const refused of answers.filter((a) => a.status === 409)) assert.equal(refused.body.error.code, 'busy');
  const { last, problem } = await finished();
  assert.equal(problem, null);
  assert.equal(last.status, 'done');
  assert.equal((await runDirs()).length, 1);
});

