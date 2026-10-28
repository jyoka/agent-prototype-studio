import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { BuildRequests } from '../../src/server/build-requests.js';
import { describeBilling } from '../../src/server/claude-args.js';
import { readFixPrompt } from '../../src/server/fix-prompt.js';
import { startStudio } from '../../src/server/index.js';
import { ensureSampleProjects } from '../../src/server/projects.js';
import { STUDIO_ROOT } from '../../src/server/config.js';
import { ProjectStore } from '../../src/server/store.js';

// 偽の claude(Node のスクリプト)を直接起動するため
const posixOnly = { skip: process.platform === 'win32' ? '偽の claude を直接起動できないため' : false };

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
  const studio = await startStudio({ home, studioPort: 0, previewPort: 0, openBrowser: false, agent: 'fake' }, { env: { PATH: process.env.PATH, ...env } });
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

// app/ を変えた run は、関門 G5、G6(観察器)まで回る。Playwright の Chromium がない環境では未確認になる(通ったとは扱わない)
function assertGatesPassed(run) {
  const launch = run.gates.find((gate) => gate.id === 'G5');
  const scenarios = run.gates.find((gate) => gate.id === 'G6');
  if (run.status === 'unverified') {
    assert.match(launch.reason, /Chromium/, JSON.stringify(launch));
    assert.equal(scenarios.status, 'unverified');
  } else {
    assert.equal(run.status, 'passed', JSON.stringify(run.gates));
    assert.equal(launch.status, 'passed');
    assert.equal(scenarios.status, 'passed');
  }
  assert.deepEqual(run.gates.slice(0, 4).map((gate) => gate.status), ['passed', 'passed', 'passed', 'passed']);
}

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
  assertGatesPassed(last);
  assert.equal(last.auth, 'none');
  assert.deepEqual(last.changedFiles, [{ file: 'app/App.jsx', change: 'modified' }]);
  // どの app/ の中身をビルドしたか(引き継ぎが、証拠が古いかを見る)
  const { lastBuild } = (await studio.store.list()).find((p) => p.id === 'sample-library');
  assert.match(lastBuild.appDigest, /^[0-9a-f]{64}$/);
  assert.deepEqual(last.build, { ok: true, errorCount: 0, stage: null, buildId: studio.store.previewBuildId('sample-library'), appDigest: lastBuild.appDigest });
  assert.notEqual(studio.store.previewBuildId('sample-library'), before);
  // 通った節の列と関門の結果は .studio/runs/<run-id>/run.json に残る
  const record = JSON.parse(await fs.readFile(path.join(studio.store.home, 'projects', 'sample-library', last.evidence.run), 'utf8'));
  const observed = last.status === 'unverified' ? ['launch'] : ['launch', 'scenarios'];
  assert.deepEqual(record.nodes.map((node) => node.name), ['accept', 'fingerprint', 'agent', 'changes', 'inspect', 'contract', 'compile', ...observed, 'evidence']);
  assert.deepEqual(record.gates, last.gates);

  const list = JSON.parse((await request(sp, { pathname: RUNS, headers })).body);
  assert.deepEqual(list.runs.map((r) => r.id), [last.id]);
  const projects = JSON.parse((await request(sp, { pathname: '/api/projects', headers })).body);
  assert.equal(projects.agent.kind, 'fake');
  const library = projects.projects.find((p) => p.id === 'sample-library');
  assert.equal(library.running, false);
  assert.ok(library.runsVersion > 0);
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
  assert.equal(JSON.parse(next.body.trim().split('\n').at(-1)).run.status, 'unchanged');
});

test('始めた直後に Studio を止めても、作る AI を起動せずに終わり、新しい依頼は受けない', async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-requests-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const studio = await startStudio({ home, studioPort: 0, previewPort: 0, openBrowser: false, agent: 'fake' }, { env: { PATH: process.env.PATH } });
  const started = await studio.requests.start('sample-library', 'ゆっくり進めて');
  const ended = new Promise((resolve) => started.subscribe(() => {}, resolve));
  const begin = Date.now();
  await studio.close();
  const final = await ended;
  assert.equal(final.status, 'cancelled');
  assert.ok(Date.now() - begin < 3000, `止まるまで ${Date.now() - begin}ms`);
  await assert.rejects(studio.requests.start('sample-library', 'x'), /止めているところ/);
});

test('Claude Code が見つからないときは 503 で理由を返す', async (t) => {
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
  assert.match(JSON.parse(response.body).error.message, /claude が見つかりません/);
});

test('自動(STUDIO_AGENT を書かない)で Claude Code にログインしていないときは、503 で理由を返す', posixOnly, async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-requests-'));
  // 偽の claude(test/fixtures/fake-claude.js)に、ログインしていない形を返させる。判定は Studio に渡した env で聞く
  const studio = await startStudio(
    { home, studioPort: 0, previewPort: 0, openBrowser: false, agent: 'auto', claudeBin: path.join(STUDIO_ROOT, 'test', 'fixtures', 'fake-claude.js') },
    { env: { PATH: process.env.PATH, FAKE_CLAUDE_AUTH: 'logged-out' } },
  );
  t.after(async () => {
    await studio.close();
    await fs.rm(home, { recursive: true, force: true });
  });
  assert.equal(studio.connection.status, 'not-logged-in');
  const token = new URL(studio.url).hash.slice('#token='.length);
  const host = `127.0.0.1:${studio.ports.studio}`;
  const response = await request(studio.ports.studio, {
    method: 'POST',
    pathname: RUNS,
    headers: { host, 'x-studio-token': token, origin: `http://${host}`, 'content-type': 'application/json' },
    body: JSON.stringify({ request: 'x' }),
  });
  assert.equal(response.status, 503);
  assert.match(JSON.parse(response.body).error.message, /ログインしていません/);
});

test('依頼の文は stdin だけで渡し、引数には入れない。作業ディレクトリは app/', async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-requests-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  await ensureSampleProjects(home, path.join(STUDIO_ROOT, 'samples'));
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
  assert.equal(final.status, 'unchanged');

  const record = JSON.parse(await fs.readFile(recordFile, 'utf8'));
  assert.equal(record.stdin, text);
  assert.ok(record.argv.every((arg) => !arg.includes('dangerously') && !arg.includes('$(echo')), JSON.stringify(record.argv));
  assert.equal(record.cwd, await fs.realpath(path.join(home, 'projects', 'sample-library', 'app')));
  // API キーで動くときは費用の上限が付く
  assert.equal(record.argv[record.argv.indexOf('--max-budget-usd') + 1], '1');
  // 環境変数は利用者のものをそのまま渡す(足しも隠しもしない)
  assert.deepEqual(record.envNames.filter((name) => name !== '__CF_USER_TEXT_ENCODING').sort(), Object.keys(env).sort());
});

test('観察の道具の MCP の設定は、作る run のフォルダー(app/ の外)に書いて渡す。作業ディレクトリは app/ のまま(S13)', async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-requests-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  await ensureSampleProjects(home, path.join(STUDIO_ROOT, 'samples'));
  const recordFile = path.join(home, 'record.json');
  const recorder = path.join(home, 'recorder.mjs');
  await fs.writeFile(
    recorder,
    `import fs from 'node:fs';
     fs.readFileSync(0, 'utf8');
     fs.writeFileSync(process.env.RECORD_FILE, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }));
     console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'ok', permission_denials: [] }));`,
  );
  const store = new ProjectStore(home);
  const env = { PATH: process.env.PATH, RECORD_FILE: recordFile };
  const requests = new BuildRequests({
    store,
    env,
    connection: { kind: 'claude', label: '記録', command: process.execPath, prefixArgs: [recorder], billing: describeBilling(env), problem: null },
  });
  const started = await requests.start('sample-library', '見出しを「記録の図書室」にして');
  const final = await new Promise((resolve) => started.subscribe(() => {}, resolve));

  const record = JSON.parse(await fs.readFile(recordFile, 'utf8'));
  const projectDir = await fs.realpath(path.join(home, 'projects', 'sample-library'));
  const appDir = path.join(projectDir, 'app');
  assert.equal(record.cwd, appDir);
  assert.ok(!record.argv.includes('--safe-mode'));
  assert.ok(record.argv.includes('--strict-mcp-config'));
  const configFile = record.argv[record.argv.indexOf('--mcp-config') + 1];
  // 作る run のフォルダー .studio/runs/<run-id>/ にあり、app/ の外
  assert.equal(path.relative(await fs.realpath(path.join(home, 'projects', 'sample-library', '.studio', 'runs', final.id)), await fs.realpath(configFile)), 'mcp.json');
  assert.ok(path.relative(appDir, await fs.realpath(configFile)).startsWith('..'));
  // サーバーは観察の道具の 1 つだけ。プロジェクトの場所(app/ の親)を起動の引数で渡す
  const config = JSON.parse(await fs.readFile(configFile, 'utf8'));
  assert.deepEqual(Object.keys(config.mcpServers), ['observe']);
  const server = config.mcpServers.observe;
  assert.equal(server.args[0], path.join(STUDIO_ROOT, 'bin', 'observe-mcp.js'));
  assert.equal(await fs.realpath(server.args[1]), projectDir);
  // app/ には MCP の設定を置かない
  await assert.rejects(fs.access(path.join(appDir, '.mcp.json')));
  await assert.rejects(fs.access(path.join(appDir, 'mcp.json')));
});

test('直すラウンドも同じ引数、同じ環境変数で起動し、作業ディレクトリは app/ のまま。直す依頼は stdin だけで渡す', async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-requests-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  await ensureSampleProjects(home, path.join(STUDIO_ROOT, 'samples'));
  const recordFile = path.join(home, 'record.ndjson');
  const recorder = path.join(home, 'recorder.mjs');
  // 1 回目はビルドできない行を足し、直す依頼を受けたらその行を消す
  await fs.writeFile(
    recorder,
    `import fs from 'node:fs';
     const stdin = fs.readFileSync(0, 'utf8');
     fs.appendFileSync(process.env.RECORD_FILE, JSON.stringify({ argv: process.argv.slice(2), stdin, cwd: process.cwd(), envNames: Object.keys(process.env).sort() }) + '\\n');
     const bad = 'const recordedBroken = ;\\n';
     const text = fs.readFileSync('App.jsx', 'utf8');
     fs.writeFileSync('App.jsx', text.includes(bad) ? text.replace(bad, '') : text + bad);
     console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'ok', permission_denials: [] }));`,
  );
  const store = new ProjectStore(home);
  await store.build('sample-library');
  const env = { PATH: process.env.PATH, RECORD_FILE: recordFile, ANTHROPIC_API_KEY: 'fictional-value' };
  const requests = new BuildRequests({
    store,
    env,
    // 関門 G5、G6 の観察。G6 には回したシナリオ(基本のシナリオ 1 本)が入る
    observe: async () => ({ verdict: 'passed', errors: [], load: { done: true, durationMs: 1 }, page: { text: '架空', empty: false }, scenarios: [{ name: '架空の基本', base: true, verdict: 'passed' }] }),
    connection: { kind: 'claude', label: '記録', command: process.execPath, prefixArgs: [recorder], billing: describeBilling(env), problem: null },
  });
  const text = '見出しを「記録の図書室」にして';
  const started = await requests.start('sample-library', text);
  const final = await new Promise((resolve) => started.subscribe(() => {}, resolve));
  assert.equal(final.status, 'fixed', JSON.stringify(final.items));

  const [first, second, ...rest] = (await fs.readFile(recordFile, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(rest.length, 0);
  assert.deepEqual(second.argv, first.argv);
  assert.deepEqual(second.envNames, first.envNames);
  // 観察の道具の MCP の設定も、同じ run のフォルダーの同じファイル(S10)
  const configFile = first.argv[first.argv.indexOf('--mcp-config') + 1];
  assert.equal(second.argv[second.argv.indexOf('--mcp-config') + 1], configFile);
  assert.equal(path.basename(path.dirname(configFile)), final.id);
  const appDir = await fs.realpath(path.join(home, 'projects', 'sample-library', 'app'));
  assert.equal(first.cwd, appDir);
  assert.equal(second.cwd, appDir);
  assert.equal(first.stdin, text);
  assert.deepEqual(readFixPrompt(second.stdin), { request: text, gate: 'G4 ビルド' });
  assert.ok(second.argv.every((arg) => !arg.includes('前の依頼') && !arg.includes('記録の図書室')));
});

test('作る欄でプロダクト内 AI の設定を変えると、変化を作る会話に出し、前の会話を新しい設定で試し直せる', async (t) => {
  const { studio, sp, headers, post } = await withStudio(t);
  const AI = '/api/projects/sample-job-consult/ai';
  const get = async (pathname) => JSON.parse((await request(sp, { pathname, headers })).body);
  const say = async (text) => JSON.parse((await post(`${AI}/messages`, { text })).body);

  // 前の設定で話す(モック)
  await say('カフェで働きたいです');
  await post(`${AI}/corrections`, { changes: { area: 'もみじ台' } });
  const before = await get(AI);
  assert.equal(before.retry.available, false);
  assert.match(before.session.messages.at(2).text, /働き方の希望はありますか/);

  // 作る AI(偽接続)が app/ai.json を書き換える。応答するのはプロダクト内 AI で、作る AI はここだけで動く
  const response = await post('/api/projects/sample-job-consult/build-requests', { request: '案内役が「時給の下限」を先に聞くようにして' });
  const run = JSON.parse(response.body.trim().split('\n').at(-1)).run;
  assertGatesPassed(run);
  assert.deepEqual(run.changedFiles, [{ file: 'app/ai.json', change: 'modified' }]);
  const settings = run.items.find((item) => item.kind === 'ai-settings');
  assert.ok(settings, JSON.stringify(run.items));
  assert.match(settings.text, /聞く順と項目の並び: 職種、雇用区分、勤務地、時給の下限 → 時給の下限、職種、雇用区分、勤務地/);
  assert.match(settings.text, /実モデルへの指示\(instructions\)に足した文: 「足りない項目は、「時給の下限」から先に聞いてください。」/);
  assert.deepEqual(studio.store.aiDefinition('sample-job-consult').fields.map((f) => f.key), ['wage', 'jobType', 'employmentType', 'area']);

  // 設定が変わったので、会話は最初から。前の会話は試し直せる
  const changed = await get(AI);
  assert.deepEqual(changed.session.messages.map((m) => m.role), ['assistant']);
  assert.deepEqual(changed.retry, {
    available: true,
    name: 'しおかぜ求人相談の案内役(架空)',
    userMessages: 1,
    corrections: 1,
    retrying: false,
    result: null,
  });

  const retried = JSON.parse((await post(`${AI}/retry`)).body);
  assert.deepEqual(retried.session.messages.map((m) => m.role), ['assistant', 'user', 'assistant', 'correction']);
  assert.equal(retried.session.state.area, 'もみじ台');
  const [reply] = retried.retry.result.replies;
  assert.equal(reply.text, 'カフェで働きたいです');
  assert.match(reply.before, /働き方の希望はありますか/);
  assert.equal(reply.after, '職種「カフェのホール」と理解しました。時給はいくら以上を希望しますか?');
  assert.equal(reply.afterVia, 'mock');
  // 試し直しで、作る AI は動かない
  assert.equal(studio.requests.list('sample-job-consult').length, 1);
});

test('AI の設定がない試作品では、振る舞いの依頼を断り、ファイルを変えない', async (t) => {
  const { post } = await withStudio(t);
  const response = await post(RUNS, { request: '案内役が「時給の下限」を先に聞くようにして' });
  const run = JSON.parse(response.body.trim().split('\n').at(-1)).run;
  assert.equal(run.status, 'unchanged');
  assert.deepEqual(run.changedFiles, []);
  assert.ok(run.items.some((item) => item.kind === 'assistant' && /app\/ai\.json がない/.test(item.text)));
  assert.ok(!run.items.some((item) => item.kind === 'ai-settings'));
  assert.equal((await post('/api/projects/sample-library/ai/retry')).status, 404);
});
