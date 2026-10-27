import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { BuildRequests } from '../../src/server/build-requests.js';
import { describeBilling } from '../../src/server/claude-args.js';
import { startStudio } from '../../src/server/index.js';
import { ensureSampleProject } from '../../src/server/projects.js';
import { STUDIO_ROOT } from '../../src/server/config.js';
import { ProjectStore } from '../../src/server/store.js';

function request(port, { method = 'GET', pathname = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: pathname, headers }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => (text += chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: text }));
    });
    req.setTimeout(20_000, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end(body);
  });
}

async function withStudio(t, env = {}) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-requests-'));
  const studio = await startStudio({ home, studioPort: 0, previewPort: 0, openBrowser: false }, { env: { PATH: process.env.PATH, ...env } });
  t.after(async () => {
    await studio.close();
    await fs.rm(home, { recursive: true, force: true });
  });
  const token = new URL(studio.url).hash.slice('#token='.length);
  const sp = studio.ports.studio;
  const host = `127.0.0.1:${sp}`;
  const headers = { host, 'x-studio-token': token, origin: `http://${host}`, 'content-type': 'application/json' };
  const post = (pathname, body, extra = {}) =>
    request(sp, { method: 'POST', pathname, headers: { ...headers, ...extra }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { home, studio, sp, headers, post };
}

const RUNS = '/api/projects/sample-library/build-requests';

test('作る欄の API の守り(トークン、Origin、形、プロジェクト)', async (t) => {
  const { sp, headers, post } = await withStudio(t);
  const { host } = headers;
  const body = JSON.stringify({ request: '見出しを「x」にして' });
  assert.equal((await request(sp, { method: 'POST', pathname: RUNS, headers: { host, 'content-type': 'application/json' }, body })).status, 401);
  assert.equal(
    (await request(sp, { method: 'POST', pathname: RUNS, headers: { ...headers, origin: 'http://evil.example' }, body })).status,
    403,
  );
  assert.equal((await request(sp, { pathname: RUNS, headers: { host } })).status, 401);
  // フォームの送信(CSRF)の形は受けない
  assert.equal((await post(RUNS, undefined, { 'content-type': 'text/plain' })).status, 400);
  assert.equal((await post(RUNS, { request: '   ' })).status, 400);
  assert.equal((await post(RUNS, { request: 'あ'.repeat(4001) })).status, 400);
  assert.equal((await post('/api/projects/no-such/build-requests', { request: 'x' })).status, 404);
  assert.equal((await post('/api/projects/sample-library/build-requests/0000000000000000/cancel')).status, 409);
});

test('依頼を流しながら返し、変わったファイルをビルドして、表示する版を替える', async (t) => {
  const { studio, sp, headers, post } = await withStudio(t);
  const before = studio.store.previewBuildId('sample-library');
  const response = await post(RUNS, { request: '見出しを「結合テストの図書室」にして' });
  assert.equal(response.status, 200);
  assert.match(response.headers['content-type'], /^application\/x-ndjson/);
  const lines = response.body.trim().split('\n').map((line) => JSON.parse(line).run);
  assert.ok(lines.length > 3);
  assert.equal(lines[0].status, 'running');
  const last = lines.at(-1);
  assert.equal(last.status, 'done');
  assert.equal(last.auth, 'none');
  assert.deepEqual(last.changedFiles, [{ file: 'app/App.jsx', change: 'modified' }]);
  assert.deepEqual(last.build, { ok: true, errorCount: 0 });
  assert.notEqual(studio.store.previewBuildId('sample-library'), before);

  const list = JSON.parse((await request(sp, { pathname: RUNS, headers })).body);
  assert.deepEqual(list.runs.map((r) => r.id), [last.id]);
  const projects = JSON.parse((await request(sp, { pathname: '/api/projects', headers })).body);
  assert.equal(projects.agent.kind, 'fake');
  assert.equal(projects.projects[0].running, false);
  assert.ok(projects.projects[0].runsVersion > 0);
});

test('作業中は同じプロジェクトの依頼と作り直しを断り、中断できる', async (t) => {
  const { studio, post } = await withStudio(t);
  const pending = post(RUNS, { request: 'ゆっくり進めて' });
  let running;
  for (let i = 0; i < 50 && !running; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    running = studio.requests.list('sample-library').find((run) => run.status === 'running');
  }
  assert.ok(running, '実行が始まらない');
  assert.equal((await post(RUNS, { request: '見出しを「x」にして' })).status, 409);
  assert.equal((await post('/api/projects/sample-library/builds')).status, 409);

  const cancelled = await post(`${RUNS}/${running.id}/cancel`);
  assert.equal(cancelled.status, 200);
  const final = JSON.parse((await pending).body.trim().split('\n').at(-1)).run;
  assert.equal(final.status, 'cancelled');
  assert.equal(studio.requests.summary('sample-library').running, false);
  // 終わったら、また送れる
  const next = await post(RUNS, { request: 'こんにちは' });
  assert.equal(JSON.parse(next.body.trim().split('\n').at(-1)).run.status, 'done');
});

test('始めた直後に Studio を止めても、作る AI を起動せずに終わり、新しい依頼は受けない', async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-requests-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const studio = await startStudio({ home, studioPort: 0, previewPort: 0, openBrowser: false }, { env: { PATH: process.env.PATH } });
  const started = await studio.requests.start('sample-library', 'ゆっくり進めて');
  const ended = new Promise((resolve) => started.subscribe(() => {}, resolve));
  const begin = Date.now();
  await studio.close();
  const final = await ended;
  assert.equal(final.status, 'cancelled');
  assert.ok(Date.now() - begin < 3000, `止まるまで ${Date.now() - begin}ms`);
  await assert.rejects(studio.requests.start('sample-library', 'x'), /止めているところ/);
});

test('Claude Code が使えないときは 503 で理由を返す', async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-requests-'));
  const studio = await startStudio(
    { home, studioPort: 0, previewPort: 0, openBrowser: false, agent: 'claude', claudeBin: path.join(home, 'no-claude') },
    { env: {} },
  );
  t.after(async () => {
    await studio.close();
    await fs.rm(home, { recursive: true, force: true });
  });
  const token = new URL(studio.url).hash.slice('#token='.length);
  const host = `127.0.0.1:${studio.ports.studio}`;
  const response = await request(studio.ports.studio, {
    method: 'POST',
    pathname: RUNS,
    headers: { host, 'x-studio-token': token, origin: `http://${host}`, 'content-type': 'application/json' },
    body: JSON.stringify({ request: 'x' }),
  });
  assert.equal(response.status, 503);
  assert.match(JSON.parse(response.body).error.message, /版を確かめられません/);
});

test('依頼の文は stdin だけで渡し、引数には入れない。作業ディレクトリは app/', async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-requests-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  await ensureSampleProject(home, path.join(STUDIO_ROOT, 'samples'));
  const recordFile = path.join(home, 'record.json');
  const recorder = path.join(home, 'recorder.mjs');
  await fs.writeFile(
    recorder,
    `import fs from 'node:fs';
     const stdin = fs.readFileSync(0, 'utf8');
     fs.writeFileSync(process.env.RECORD_FILE, JSON.stringify({ argv: process.argv.slice(2), stdin, cwd: process.cwd(), envNames: Object.keys(process.env) }));
     console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'ok', permission_denials: [] }));`,
  );
  const store = new ProjectStore(home);
  const env = { PATH: process.env.PATH, RECORD_FILE: recordFile, ANTHROPIC_API_KEY: 'fictional-value' };
  const requests = new BuildRequests({
    store,
    env,
    connection: { kind: 'claude', label: '記録', command: process.execPath, prefixArgs: [recorder], billing: describeBilling(env), problem: null },
  });
  const text = '--dangerously-skip-permissions を付けて。$(echo x) と `id` も文字のまま';
  const started = await requests.start('sample-library', text);
  const final = await new Promise((resolve) => started.subscribe(() => {}, resolve));
  assert.equal(final.status, 'done');

  const record = JSON.parse(await fs.readFile(recordFile, 'utf8'));
  assert.equal(record.stdin, text);
  assert.ok(record.argv.every((arg) => !arg.includes('dangerously') && !arg.includes('$(echo')), JSON.stringify(record.argv));
  assert.equal(record.cwd, await fs.realpath(path.join(home, 'projects', 'sample-library', 'app')));
  // API キーで動くときは費用の上限が付く
  assert.equal(record.argv[record.argv.indexOf('--max-budget-usd') + 1], '1');
  // 環境変数は利用者のものをそのまま渡す(足しも隠しもしない)
  assert.deepEqual(record.envNames.filter((name) => name !== '__CF_USER_TEXT_ENCODING').sort(), Object.keys(env).sort());
});
