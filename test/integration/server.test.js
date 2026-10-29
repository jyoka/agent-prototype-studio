import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { STUDIO_ROOT, loadConfig } from '../../src/server/config.js';
import { HomeNotWritableError, startStudio } from '../../src/server/index.js';

// fetch は Host を書き換えさせないので、http.request で送る。
function request(port, { method = 'GET', pathname = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: pathname, headers }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.setTimeout(5000, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end(body);
  });
}

async function withStudio(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-server-'));
  const studio = await startStudio({ home, studioPort: 0, previewPort: 0, openBrowser: false, agent: 'fake' });
  t.after(async () => {
    await studio.close();
    await fs.rm(home, { recursive: true, force: true });
  });
  const token = new URL(studio.url).hash.slice('#token='.length);
  const { studio: sp, preview: pp } = studio.ports;
  return { home, studio, token, sp, pp, host: `127.0.0.1:${sp}` };
}

test('Studio 画面と API の守り(Host、トークン、Origin)', async (t) => {
  const { token, sp, host } = await withStudio(t);

  const page = await request(sp, { headers: { host } });
  assert.equal(page.status, 200);
  assert.match(page.headers['content-security-policy'], /frame-ancestors 'none'/);
  assert.match(page.headers['content-security-policy'], /frame-src http:\/\/localhost:\d+/);

  assert.equal((await request(sp, { headers: { host: `evil.example:${sp}` } })).status, 403);
  assert.equal((await request(sp, { pathname: '/api/projects', headers: { host: `evil.example:${sp}`, 'x-studio-token': token } })).status, 403);

  const noToken = await request(sp, { pathname: '/api/projects', headers: { host } });
  assert.equal(noToken.status, 401);
  assert.equal(JSON.parse(noToken.body).error.code, 'token');

  const ok = await request(sp, { pathname: '/api/projects', headers: { host, 'x-studio-token': token } });
  assert.equal(ok.status, 200);
  const sample = JSON.parse(ok.body).projects.find((p) => p.id === 'sample-library');
  assert.equal(sample.id, 'sample-library');
  assert.match(sample.previewUrl, /^http:\/\/localhost:\d+\/p\/sample-library\/[a-f0-9]{32}\/$/);

  const buildPath = '/api/projects/sample-library/builds';
  assert.equal((await request(sp, { method: 'POST', pathname: buildPath, headers: { host, 'x-studio-token': token } })).status, 403);
  assert.equal(
    (await request(sp, { method: 'POST', pathname: buildPath, headers: { host, 'x-studio-token': token, origin: 'http://evil.example' } })).status,
    403,
  );
  const rebuilt = await request(sp, { method: 'POST', pathname: buildPath, headers: { host, 'x-studio-token': token, origin: `http://${host}` } });
  assert.equal(rebuilt.status, 200);
  assert.notEqual(JSON.parse(rebuilt.body).project.previewUrl, sample.previewUrl);

  const missing = await request(sp, { method: 'POST', pathname: '/api/projects/..%2Fx/builds', headers: { host, 'x-studio-token': token, origin: `http://${host}` } });
  assert.equal(missing.status, 404);
});

test('観察用の親ページは、決まったパスに、API を呼べない CSP つきで置く', async (t) => {
  const { sp, pp, host } = await withStudio(t);
  for (const pathname of ['/observe.html', '/observe.js']) {
    const page = await request(sp, { pathname, headers: { host } });
    assert.equal(page.status, 200, pathname);
    const csp = page.headers['content-security-policy'];
    assert.match(csp, /connect-src 'none'/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.ok(csp.includes(`frame-src http://localhost:${pp}`));
  }
  // Studio の画面の CSP は変えない
  assert.match((await request(sp, { headers: { host } })).headers['content-security-policy'], /connect-src 'self'/);
});

test('プレビューは表示中の版の静的ファイルだけを、CSP つきで返す', async (t) => {
  const { studio, sp, pp } = await withStudio(t);
  const buildId = studio.store.previewBuildId('sample-library');
  const host = `localhost:${pp}`;
  const base = `/p/sample-library/${buildId}/`;

  const index = await request(pp, { pathname: base, headers: { host } });
  assert.equal(index.status, 200);
  const csp = index.headers['content-security-policy'];
  assert.match(csp, /^sandbox allow-scripts allow-forms;/);
  assert.match(csp, new RegExp(`script-src http://${host}${base};`));
  assert.match(csp, /connect-src 'none'/);
  assert.match(csp, new RegExp(`frame-ancestors http://127.0.0.1:${sp} http://localhost:${sp}$`));
  assert.equal(index.headers['access-control-allow-origin'], undefined);

  const script = await request(pp, { pathname: `${base}app.js`, headers: { host, origin: 'null' } });
  assert.equal(script.status, 200);
  assert.equal(script.headers['access-control-allow-origin'], 'null');
  const fromSite = await request(pp, { pathname: `${base}app.js`, headers: { host, origin: 'http://evil.example' } });
  assert.equal(fromSite.headers['access-control-allow-origin'], undefined);

  assert.equal((await request(pp, { pathname: base, headers: { host: `evil.example:${pp}` } })).status, 403);
  assert.equal((await request(pp, { pathname: `/p/sample-library/${'0'.repeat(32)}/`, headers: { host } })).status, 404);
  for (const pathname of [`${base}..%2F..%2Fapp%2Fmain.jsx`, `${base}../../app/main.jsx`, `${base}.hidden`, '/api/projects']) {
    assert.equal((await request(pp, { pathname, headers: { host } })).status, 404, pathname);
  }
  assert.equal((await request(pp, { method: 'POST', pathname: base, headers: { host } })).status, 405);
});

test('待ち受けは loopback だけ', async (t) => {
  const { sp, pp } = await withStudio(t);
  const lan = Object.values(os.networkInterfaces())
    .flat()
    .find((info) => info && info.family === 'IPv4' && !info.internal);
  if (!lan) {
    t.skip('LAN のアドレスがない');
    return;
  }
  for (const port of [sp, pp]) {
    const error = await new Promise((resolve) => {
      const socket = net.connect({ host: lan.address, port, timeout: 2000 });
      socket.on('connect', () => {
        socket.destroy();
        resolve(null);
      });
      socket.on('timeout', () => {
        socket.destroy();
        resolve(new Error('timeout'));
      });
      socket.on('error', resolve);
    });
    assert.ok(error, `${lan.address}:${port} につながってしまった`);
  }
});

test('ポートが使われていれば、どのポートかわかるエラーで止まる', async (t) => {
  const blocker = net.createServer();
  await new Promise((resolve) => blocker.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => blocker.close(resolve)));
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-server-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const port = blocker.address().port;
  await assert.rejects(startStudio({ home, studioPort: port, previewPort: 0, openBrowser: false, agent: 'fake' }), {
    name: 'Error',
    message: `ポート ${port} は使われています`,
    envName: 'STUDIO_PORT',
  });
});

test('::1 の同じポートを他のプロセスが使っていれば、起動せずに知らせる', async (t) => {
  const squatter = net.createServer();
  const listened = await new Promise((resolve) => {
    squatter.once('error', () => resolve(false));
    squatter.listen(0, '::1', () => resolve(true));
  });
  if (!listened) {
    t.skip('::1 で待ち受けられない環境');
    return;
  }
  t.after(() => new Promise((resolve) => squatter.close(resolve)));
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-server-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const port = squatter.address().port;
  await assert.rejects(startStudio({ home, studioPort: 0, previewPort: port, openBrowser: false, agent: 'fake' }), {
    envName: 'STUDIO_PREVIEW_PORT',
  });
});

test('壊れたプロジェクトがあっても、他の試作品は開ける', { skip: process.platform === 'win32' }, async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-server-'));
  // app/ がファイル
  await fs.mkdir(path.join(home, 'projects', 'app-is-file'), { recursive: true });
  await fs.writeFile(path.join(home, 'projects', 'app-is-file', 'app'), '');
  // 読めないフォルダーがある
  const locked = path.join(home, 'projects', 'locked', 'app', 'private');
  await fs.mkdir(locked, { recursive: true });
  await fs.writeFile(path.join(home, 'projects', 'locked', 'app', 'main.js'), 'console.log(1);\n');
  await fs.chmod(locked, 0o000);
  t.after(async () => {
    await fs.chmod(locked, 0o700);
    await fs.rm(home, { recursive: true, force: true });
  });

  const studio = await startStudio({ home, studioPort: 0, previewPort: 0, openBrowser: false, agent: 'fake' });
  t.after(() => studio.close());
  const projects = await studio.store.list();
  assert.deepEqual(projects.map((p) => p.id), ['sample-job-consult', 'sample-study-consult', 'sample-part-time', 'sample-library', 'locked']);
  // 一覧の名前は、表示中の版の目録の title と AI があるかから作る。構成(composition.json)だけの試作品も AI と話せる。ビルドできないものは置き場の名前のまま
  assert.deepEqual(projects.map((p) => p.title), ['求人相談(架空・AI と話せる)', '学習相談(架空・AI と話せる)', 'バイト探し(架空・AI と話せる)', '図書室(架空・AI なし)', 'locked']);
  const locked_ = projects.find((p) => p.id === 'locked');
  assert.equal(locked_.lastBuild.ok, false);
  assert.match(locked_.lastBuild.errors[0].text, /ビルドの途中で問題が起きました/);
  assert.ok(studio.store.previewBuildId('sample-library'));
});

test('データの置き場がふつうのファイルのときは、書き込めないことを知らせる', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-home-file-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const home = path.join(dir, 'file');
  await fs.writeFile(home, '');
  await assert.rejects(startStudio({ home, studioPort: 0, previewPort: 0, openBrowser: false, agent: 'fake' }), HomeNotWritableError);
});

test('プロダクト内 AI の API: 会話、修正、リセットと、その守り', async (t) => {
  const { token, sp, host } = await withStudio(t);
  const base = '/api/projects/sample-job-consult/ai';
  const headers = { host, 'x-studio-token': token, origin: `http://${host}`, 'content-type': 'application/json' };
  const call = async (pathname, json, extra = {}) => {
    const res = await request(sp, {
      method: json === undefined ? 'GET' : 'POST',
      pathname,
      headers: { ...headers, ...extra },
      body: json === undefined ? undefined : typeof json === 'string' ? json : JSON.stringify(json),
    });
    return { status: res.status, body: JSON.parse(res.body) };
  };

  const initial = await call(base);
  assert.equal(initial.status, 200);
  assert.equal(initial.body.session.connection.kind, 'mock');
  assert.deepEqual(initial.body.session.state, { jobType: null, employmentType: null, area: null, wage: null });
  assert.equal(initial.body.session.messages.length, 1);

  const sent = await call(`${base}/messages`, { text: 'しおかぜ町でカフェのアルバイト。時給1100円以上' });
  assert.equal(sent.status, 200);
  assert.deepEqual(sent.body.session.state, { jobType: 'カフェのホール', employmentType: 'アルバイト・パート', area: 'しおかぜ町', wage: 1100 });

  const corrected = await call(`${base}/corrections`, { changes: { area: 'もみじ台' } });
  assert.equal(corrected.body.session.state.area, 'もみじ台');
  const next = await call(`${base}/messages`, { text: 'お願いします' });
  assert.match(next.body.session.messages.at(-1).text, /^直していただいた勤務地「もみじ台」で進めます。/);

  assert.equal((await call(`${base}/corrections`, { changes: { area: '月の裏側' } })).body.error.code, 'invalid');
  assert.equal((await call(`${base}/messages`, '{')).status, 400);
  assert.equal((await call(`${base}/messages`, { text: 'x'.repeat(501) })).body.error.code, 'invalid');
  assert.equal((await call(`${base}/messages`, { text: 'x'.repeat(20_000) })).status, 400);

  const reset = await call(`${base}/reset`, {});
  assert.deepEqual(reset.body.session, initial.body.session);

  // AI を使わない試作品、ない試作品
  const library = await call('/api/projects/sample-library/ai');
  assert.equal(library.status, 404);
  assert.equal(library.body.error.code, 'no-ai');
  assert.equal((await call('/api/projects/nothing/ai')).body.error.code, 'not-found');
  assert.equal((await call('/api/projects/..%2Fx/ai/reset', {})).status, 404);

  // トークンと Origin
  assert.equal((await call(base, undefined, { 'x-studio-token': 'x' })).status, 401);
  assert.equal((await call(`${base}/reset`, {}, { origin: 'http://evil.example' })).status, 403);
  // GET 以外では状態を変えない
  assert.equal((await call(`${base}/reset`)).status, 404);
});

test('版の API: 保存、一覧、復元と、その守り', async (t) => {
  const { studio, token, sp, host } = await withStudio(t);
  const base = '/api/projects/sample-job-consult/versions';
  const headers = { host, 'x-studio-token': token, origin: `http://${host}`, 'content-type': 'application/json' };
  const call = async (pathname, json, extra = {}) => {
    const res = await request(sp, {
      method: json === undefined ? 'GET' : 'POST',
      pathname,
      headers: { ...headers, ...extra },
      body: json === undefined ? undefined : JSON.stringify(json),
    });
    return { status: res.status, body: JSON.parse(res.body) };
  };

  assert.deepEqual((await call(base)).body, {
    versions: [],
    working: { files: 'none', versionId: null, conversation: 'initial', baseVersionId: null },
  });
  await call('/api/projects/sample-job-consult/ai/messages', { text: 'カフェで働きたいです' });
  const saved = await call(base, { name: '最初' });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.version.number, 1);
  assert.equal(saved.body.working.files, 'saved');
  assert.equal(saved.body.working.conversation, 'saved');

  await call('/api/projects/sample-job-consult/ai/reset', {});
  const listed = await call(base);
  assert.equal(listed.body.working.conversation, 'initial');
  const restored = await call(`${base}/${saved.body.version.id}/restore`, {});
  assert.equal(restored.status, 200);
  assert.equal(restored.body.conversation, 'restored');
  const session = await call('/api/projects/sample-job-consult/ai');
  assert.equal(session.body.session.state.jobType, 'カフェのホール');

  assert.equal((await call(`${base}/0123456789abcdef/restore`, {})).body.error.code, 'not-found');
  assert.equal((await call(`${base}/..%2F..%2Fx/restore`, {})).status, 404);
  assert.equal((await call('/api/projects/nothing/versions')).status, 404);
  assert.equal((await call(base, { name: 1 })).body.error.code, 'invalid');
  // トークンと Origin
  assert.equal((await call(base, undefined, { 'x-studio-token': 'x' })).status, 401);
  assert.equal((await call(base, {}, { origin: 'http://evil.example' })).status, 403);
  assert.equal((await call(`${base}/${saved.body.version.id}/restore`)).status, 404);

  // 版の保存と復元の間は、プロダクト内 AI の会話を変えない
  studio.store.claimVersions('sample-job-consult');
  const during = await call('/api/projects/sample-job-consult/ai/messages', { text: 'アルバイト' });
  assert.equal(during.status, 409);
  assert.match(during.body.error.message, /保存か、保存した状態に戻すか、本番開発へ渡すフォルダーを作っているところ/);
  assert.equal((await call('/api/projects/sample-job-consult/ai')).status, 200);
  studio.store.releaseVersions('sample-job-consult');
});

test('プロダクト内 AI の接続の API: 既定はモック、実モデルは止める設定では選べず、Studio 画面以外からは切り替えられない', async (t) => {
  const { token, sp, host } = await withStudio(t);
  const base = '/api/projects/sample-job-consult/ai';
  const headers = { host, 'x-studio-token': token, origin: `http://${host}`, 'content-type': 'application/json' };
  const call = async (pathname, json, extra = {}) => {
    const res = await request(sp, {
      method: json === undefined ? 'GET' : 'POST',
      pathname,
      headers: { ...headers, ...extra },
      body: json === undefined ? undefined : JSON.stringify(json),
    });
    return { status: res.status, body: JSON.parse(res.body) };
  };

  const choices = await call(`${base}/connections`);
  assert.equal(choices.status, 200);
  assert.equal(choices.body.selected, 'mock');
  const claude = choices.body.options.find((o) => o.kind === 'claude-code');
  // config に allowClaudeCode がない(STUDIO_ALLOW_CLAUDE_CODE=0 と同じ扱い)ので選べない。同意の確かめは consent.test.js
  assert.equal(claude.available, false);
  assert.equal(claude.code, 'disabled');
  assert.ok(['subscription', 'api-key'].includes(claude.billing.kind));
  assert.match(claude.sends.systemPrompt, /しおかぜ求人相談/);

  const refused = await call(`${base}/connection`, { kind: 'claude-code' });
  assert.equal(refused.status, 403);
  assert.equal(refused.body.error.code, 'disabled');
  assert.equal((await call(`${base}/connection`, { kind: 'claude-code' }, { origin: 'http://localhost:1' })).status, 403);
  assert.equal((await call(`${base}/connection`, { kind: 'mock' })).body.session.connection.kind, 'mock');
  // 待っている応答がなくても、止める要求は会話を変えない
  assert.equal((await call(`${base}/cancel`, {})).body.session.messages.length, 1);
  // 状態を変える要求は POST だけ
  assert.equal((await call(`${base}/connection`)).status, 404);
  assert.equal((await call(`${base}/connections`, {})).status, 404);
});

test('AI の実行の記録の API: 発言と失敗を、次にすることと一緒に返し、Studio 画面から消せる', async (t) => {
  const { token, sp, host } = await withStudio(t);
  const base = '/api/projects/sample-job-consult/ai';
  const headers = { host, 'x-studio-token': token, origin: `http://${host}`, 'content-type': 'application/json' };
  const call = async (pathname, json, extra = {}) => {
    const res = await request(sp, {
      method: json === undefined ? 'GET' : 'POST',
      pathname,
      headers: { ...headers, ...extra },
      body: json === undefined ? undefined : JSON.stringify(json),
    });
    return { status: res.status, body: JSON.parse(res.body) };
  };

  assert.deepEqual((await call(`${base}/trace`)).body.entries, []);
  await call(`${base}/messages`, { text: 'カフェで働きたい' });
  const tooLong = await call(`${base}/messages`, { text: 'x'.repeat(501) });
  assert.equal(tooLong.body.error.code, 'invalid');
  const badValue = await call(`${base}/corrections`, { changes: { area: '月の裏側' } });
  assert.equal(badValue.body.error.code, 'invalid');

  const { entries } = (await call(`${base}/trace`)).body;
  assert.deepEqual(
    entries.map((e) => [e.type, e.status]),
    [['correction', 'failed'], ['reply', 'failed'], ['reply', 'ok']],
  );
  assert.deepEqual(entries[2].changes, [{ key: 'jobType', label: '職種', from: '未定', to: 'カフェのホール' }]);
  assert.match(entries[1].error.next, /500 文字まで/);

  // 決まった失敗には、API の応答にも次にすることを付ける
  await call(`${base}/connection`, { kind: 'mock' });
  for (let i = 0; i < 99; i += 1) await call(`${base}/messages`, { text: 'こんにちは' });
  const full = await call(`${base}/messages`, { text: 'こんにちは' });
  assert.equal(full.body.error.code, 'too-long');
  assert.match(full.body.error.next, /会話を最初から/);

  // 消すのは POST だけ。AI のない試作品と、鍵と Origin の守りは他の API と同じ
  assert.equal((await call(`${base}/clear-trace`)).status, 404);
  assert.equal((await call(`${base}/trace`, {})).status, 404);
  assert.equal((await call(`${base}/clear-trace`, {}, { origin: 'http://evil.example' })).status, 403);
  assert.equal((await call(`${base}/trace`, undefined, { 'x-studio-token': 'x' })).status, 401);
  assert.equal((await call('/api/projects/sample-library/ai/trace')).body.error.code, 'no-ai');
  assert.deepEqual((await call(`${base}/clear-trace`, {})).body.entries, []);
});

// 構成(app/composition.json)のある試作品(test/fixtures/sim-a、sim-c。架空)を置いて起動する。作る AI は偽接続。
// 試作品の中の AI の Claude Code は偽の claude(test/fixtures/fake-claude.js)。env は Studio と Claude Code に渡す環境変数
async function withSimStudio(t, { extraEnv = {} } = {}) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-sim-server-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  for (const name of ['sim-a', 'sim-c']) {
    await fs.cp(path.join(STUDIO_ROOT, 'test', 'fixtures', name, 'app'), path.join(home, 'projects', name, 'app'), { recursive: true });
  }
  const bin = path.join(home, 'bin', 'claude');
  await fs.mkdir(path.dirname(bin), { recursive: true });
  await fs.writeFile(bin, `#!/bin/sh\nexec "${process.execPath}" "${path.join(STUDIO_ROOT, 'test', 'fixtures', 'fake-claude.js')}" "$@"\n`, { mode: 0o755 });
  const env = { PATH: process.env.PATH, STUDIO_AGENT: 'fake', STUDIO_CLAUDE_BIN: bin, FAKE_CLAUDE_LOG: path.join(home, 'claude.jsonl'), ...extraEnv };
  const studio = await startStudio(loadConfig({ ...env, STUDIO_HOME: home, STUDIO_PORT: '0', STUDIO_PREVIEW_PORT: '0', STUDIO_NO_OPEN: '1' }), { env });
  t.after(() => studio.close());
  const token = new URL(studio.url).hash.slice('#token='.length);
  const sp = studio.ports.studio;
  const host = `127.0.0.1:${sp}`;
  const headers = { host, 'x-studio-token': token, origin: `http://${host}`, 'content-type': 'application/json' };
  const call = async (pathname, json) => {
    const res = await request(sp, { method: json === undefined ? 'GET' : 'POST', pathname, headers, body: json === undefined ? undefined : JSON.stringify(json) });
    return { status: res.status, body: JSON.parse(res.body) };
  };
  return { home, studio, call, env };
}

test('構成のある試作品: studio.ai.send(text, { action }) と、会話に参加者、今話す参加者、部品、記録の店が入る。構成 B は今の形のまま', async (t) => {
  const { call } = await withSimStudio(t);
  const base = '/api/projects/sim-a/ai';
  const initial = (await call(base)).body.session;
  assert.deepEqual(initial.participants, [{ id: 'partner', label: '相手のエージェント(模擬)', kind: 'agent' }]);
  assert.equal(initial.active, 'partner');
  assert.deepEqual(initial.records, {});
  assert.deepEqual(initial.surface, { kind: 'talk', theme: 'talk' });
  assert.deepEqual(initial.messages, []);
  assert.equal(initial.connection.kind, 'mock');

  const found = (await call(`${base}/messages`, { text: 'みなと町で探して' })).body.session;
  const [user, reply] = found.messages;
  assert.equal(user.role, 'user');
  assert.equal(reply.from, 'partner');
  assert.deepEqual(reply.parts.map((p) => p.kind), ['text', 'buttons']);
  assert.deepEqual(reply.parts[1].items, [{ label: '詳しく見る' }, { label: '保存する', action: 'save' }]);
  assert.equal(reply.text, '2件ありました。架空の品出し、架空の配膳\n1. 詳しく見る\n2. 保存する');

  // ボタンの action を送る。同意の記録がないので、保存のツールは守り(requires)が断る
  const refused = (await call(`${base}/messages`, { text: '保存する', action: 'save' })).body.session;
  assert.deepEqual(refused.messages.at(-2), { role: 'user', text: '保存する', action: 'save', via: 'mock' });
  assert.match(refused.messages.at(-1).text, /記録「consent」がありません/);
  assert.deepEqual(refused.records, {});
  await call(`${base}/messages`, { text: '保存してよいです' });
  const saved = (await call(`${base}/messages`, { text: '保存する', action: 'save' })).body.session;
  assert.deepEqual(saved.records, { consent: { agreed: true }, wishes: { area: 'みなと町' } });
  assert.equal(saved.messages.at(-1).text, '保存しました。');
  // ツールの呼び出しの中身は、試作品に返さない(記録にだけ出す)
  assert.ok(!JSON.stringify(saved).includes('search_jobs'));
  const trace = (await call(`${base}/trace`)).body.entries;
  assert.equal(trace[0].kind, 'sim-turn');
  assert.equal(trace[0].action, 'save');
  assert.ok(trace.some((entry) => entry.steps?.some((step) => step.tool === 'search_jobs')));

  // 形の合わない action は断る
  assert.equal((await call(`${base}/messages`, { text: '保存する', action: 'Save Now' })).body.error.code, 'invalid');
  assert.equal((await call(`${base}/messages`, { text: '保存する', action: 3 })).status, 400);
  // 構成の会話では、状態を直す口は使えない
  assert.equal((await call(`${base}/corrections`, { changes: { area: 'みなと町' } })).body.error.code, 'not-supported');
  // リセットで最初に戻る
  assert.deepEqual((await call(`${base}/reset`, {})).body.session.records, {});

  // 構成 C: 引き継ぎで今話す参加者が替わり、相談役の項目と状態が入る
  const c = (await call('/api/projects/sim-c/ai/messages', { text: '相談したい' })).body.session;
  assert.deepEqual(c.participants.map((p) => [p.id, p.kind]), [['front', 'agent'], ['consult', 'harness'], ['staff', 'human']]);
  assert.equal(c.active, 'consult');
  assert.deepEqual(c.messages.filter((m) => m.role === 'assistant').map((m) => m.from), ['front', 'consult']);
  assert.deepEqual(c.state, { area: 'みなと町', minWage: null });
  assert.deepEqual(c.fields.map((f) => f.key), ['area', 'minWage']);

  // 構成 B(composition.json のない見本)は、今の形のまま。text だけの send も今と同じ。action は使わない
  const b = (await call('/api/projects/sample-job-consult/ai/messages', { text: 'カフェで働きたいです', action: 'save' })).body.session;
  assert.deepEqual(Object.keys(b).sort(), ['busy', 'connection', 'fields', 'messages', 'name', 'state']);
  assert.equal(b.state.jobType, 'カフェのホール');
});

test('模擬のエージェントを Claude Code に切り替えるときも、同じ同意の口を通る。同意の前は断り、同意の後は偽の CLI で話せる', { skip: process.platform === 'win32' }, async (t) => {
  const { call, home } = await withSimStudio(t);
  const base = '/api/projects/sim-a/ai';
  const choices = (await call(`${base}/connections`)).body;
  const claude = choices.options.find((o) => o.kind === 'claude-code');
  assert.equal(claude.available, true);
  assert.match(claude.sends.items[0], /相手のエージェント\(模擬\)/);
  assert.match(claude.tools, /--allowedTools/);

  const refused = await call(`${base}/connection`, { kind: 'claude-code' });
  assert.equal(refused.status, 403);
  assert.equal(refused.body.error.code, 'consent-required');
  assert.equal((await call(base)).body.session.connection.kind, 'mock');
  // 同意の前は、偽の CLI も起動していない
  assert.equal(await fs.stat(path.join(home, 'claude.jsonl')).catch(() => null), null);

  assert.equal((await call('/api/real-ai/consent', {})).body.consent.agreed, true);
  assert.equal((await call(`${base}/connection`, { kind: 'claude-code' })).body.session.connection.kind, 'claude-code');
  const sent = (await call(`${base}/messages`, { text: 'こんにちは' })).body.session;
  assert.equal(sent.messages.at(-1).via, 'claude-code');
  assert.match(sent.messages.at(-1).text, /^偽の Claude Code です。/);
  const [launch] = (await fs.readFile(path.join(home, 'claude.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  assert.ok(launch.argv.includes('--strict-mcp-config'));
  assert.ok(!launch.argv.includes('--safe-mode'));
});

test('試し直しは構成のある会話でも動く。ボタンの action も送り直し、前と後の返事は parts を文にしたもので返す', async (t) => {
  const { call, home, studio } = await withSimStudio(t);
  const base = '/api/projects/sim-a/ai';
  await call(`${base}/messages`, { text: '保存してよいです' });
  await call(`${base}/messages`, { text: '保存する', action: 'save' });
  await call(`${base}/messages`, { text: 'みなと町で探して' });
  // 設定を変えたビルドに切り替わると、前の会話を覚えて最初に戻る
  const mock = path.join(home, 'projects', 'sim-a', 'app', 'mocks', 'partner.json');
  const rules = JSON.parse(await fs.readFile(mock, 'utf8'));
  rules.rules[3].reply = [{ kind: 'text', text: '希望を保存しました。' }];
  await fs.writeFile(mock, JSON.stringify(rules));
  await studio.store.build('sim-a');
  const fresh = (await call(base)).body;
  assert.deepEqual(fresh.session.messages, []);
  assert.equal(fresh.retry.available, true);
  assert.equal(fresh.retry.userMessages, 3);

  const { session, retry } = (await call(`${base}/retry`, {})).body;
  assert.deepEqual(session.records, { consent: { agreed: true }, wishes: { area: 'みなと町' } });
  assert.deepEqual(
    retry.result.replies.map(({ text, action, before, after }) => ({ text, action, before, after })),
    [
      { text: '保存してよいです', action: undefined, before: '保存してよいと記録しました。', after: '保存してよいと記録しました。' },
      { text: '保存する', action: 'save', before: '保存しました。', after: '希望を保存しました。' },
      {
        text: 'みなと町で探して',
        action: undefined,
        before: '2件ありました。架空の品出し、架空の配膳\n1. 詳しく見る\n2. 保存する',
        after: '2件ありました。架空の品出し、架空の配膳\n1. 詳しく見る\n2. 保存する',
      },
    ],
  );
  assert.equal(retry.result.stopped, null);
});

test('構成と前提の選び方: 選ぶと利用者の会話が最初からになり、前提の部品で答える。観察の会話は既定のまま。構成のない試作品では null', async (t) => {
  const { call, studio } = await withSimStudio(t);
  const id = 'sample-part-time';
  const base = `/api/projects/${id}/ai`;
  const before = (await call(`${base}/connections`)).body.simulation;
  assert.deepEqual(before.selected, { composition: 'composition.json', assumptions: 'partner-a' });
  assert.deepEqual(before.compositions.map((c) => [c.file, c.default]), [['composition.json', true], ['compositions/b.json', false], ['compositions/c.json', false], ['compositions/c2.json', false]]);
  assert.deepEqual(before.compositions[0].assumptions.map((a) => [a.id, a.parts]), [['partner-a', ['text', 'buttons', 'card', 'carousel']], ['partner-b', ['text', 'buttons']]]);
  // 構成 B(相談役の harness だけ)は前提を使わない
  assert.deepEqual(before.compositions[1].assumptions, []);
  assert.deepEqual(before.compositions[3].assumptions.map((a) => a.id), ['caller-haiku', 'caller-opus', 'caller-sonnet']);
  assert.deepEqual((await call(`${base}/messages`, { text: '詳しく見せて' })).body.session.messages.at(-1).parts.map((p) => p.kind), ['card']);

  const chosen = (await call(`${base}/simulation`, { composition: 'composition.json', assumptions: 'partner-b' })).body;
  assert.deepEqual(chosen.session.messages, []);
  assert.deepEqual(chosen.simulation.selected, { composition: 'composition.json', assumptions: 'partner-b' });
  // 選んだことは試し直しの前の会話にしない(設定が変わったのではない)
  assert.equal(chosen.retry.available, false);
  assert.deepEqual((await call(`${base}/messages`, { text: '詳しく見せて' })).body.session.messages.at(-1).parts.map((p) => p.kind), ['text']);
  const [turn, picked] = (await call(`${base}/trace`)).body.entries;
  assert.equal(turn.assumptions.id, 'partner-b');
  assert.match(turn.assumptions.digest, /^sha256:[a-f0-9]{64}$/);
  assert.deepEqual(turn.participants, [{ id: 'partner', label: 'そよかぜの案内役(模擬)', kind: 'agent' }]);
  assert.deepEqual(picked, { ...picked, type: 'simulation', from: 'studio', status: 'ok', assumptions: { id: 'partner-b', name: '相手の仕様の推測 B(架空。文とボタンだけ)', file: 'assumptions/partner-b.json' } });
  // 会話を最初からにしても、選んだ構成と前提は残る
  await call(`${base}/reset`, {});
  assert.equal((await call(`${base}/connections`)).body.simulation.selected.assumptions, 'partner-b');

  // 観察の会話は、既定の構成と前提で答える(試す画面の選び方に左右されない)
  const conversation = studio.aiSessions.openObservation(id);
  const observed = await studio.aiSessions.send(id, '詳しく見せて', { conversation });
  assert.deepEqual(observed.messages.at(-1).parts.map((p) => p.kind), ['card']);
  studio.aiSessions.closeObservation(id, conversation);

  // 構成を替えると、前提はその構成の既定になる。前提を使わない値は断る
  const c2 = (await call(`${base}/simulation`, { composition: 'compositions/c2.json' })).body;
  assert.deepEqual(c2.simulation.selected, { composition: 'compositions/c2.json', assumptions: 'caller-sonnet' });
  assert.equal(c2.session.name, 'ツールだけを出し、呼び手を替えて試す(架空)');
  assert.equal((await call(`${base}/simulation`, { composition: 'compositions/c2.json', assumptions: 'partner-a' })).status, 400);
  assert.equal((await call(`${base}/simulation`, { composition: '../composition.json' })).status, 400);

  // 構成のない試作品(構成 B)は、選び方が null で、選ぶ口は断る
  assert.equal((await call('/api/projects/sample-job-consult/ai/connections')).body.simulation, null);
  assert.equal((await call('/api/projects/sample-job-consult/ai/simulation', { composition: 'composition.json' })).body.error.code, 'not-supported');
});

// 人の「確かめる」(docs/design/harness.md の 3.1、P27)。表示中の試作品を、作るループと同じ観察の入口で観察する。
// 作る run、ビルド、版の操作、ほかの確かめの間は 409 で断る(1 プロジェクト 1 実行)
test('人の「確かめる」の API: 作る run、ビルド、版の操作の間は 409 で断り、終わると report を .studio/observations/ に書く', async (t) => {
  const { studio, token, sp, host, home } = await withStudio(t);
  const id = 'sample-library';
  const headers = { host, 'x-studio-token': token, origin: `http://${host}`, 'content-type': 'application/json' };
  const call = async (pathname, json) => {
    const res = await request(sp, { method: json === undefined ? 'GET' : 'POST', pathname, headers, body: json === undefined ? undefined : JSON.stringify(json) });
    return { status: res.status, body: JSON.parse(res.body) };
  };
  const base = `/api/projects/${id}/checks`;

  // 作る run の間は断る。確かめは始まらない
  const started = await studio.requests.start(id, 'ゆっくり進めて');
  const during = await call(base, {});
  assert.equal(during.status, 409);
  assert.equal(during.body.error.code, 'busy');
  assert.match(during.body.error.message, /作る AI が作業中/);
  assert.deepEqual((await call(base)).body.checks, []);
  const finished = new Promise((resolve) => started.subscribe(() => {}, resolve));
  studio.requests.cancel(id, started.run.id);
  await finished;

  // ビルドの間と、版の操作の間も断る
  studio.store.entry(id).building = true;
  assert.equal((await call(base, {})).status, 409);
  studio.store.entry(id).building = false;
  studio.store.claimVersions(id);
  assert.equal((await call(base, {})).status, 409);
  studio.store.releaseVersions(id);

  // 形の誤りと、ないプロジェクト
  assert.equal((await call(base, { connection: 'nothing' })).body.error.code, 'invalid');
  assert.equal((await call('/api/projects/nothing/checks', {})).status, 404);
  assert.equal((await call('/api/projects/nothing/checks')).status, 404);

  // 確かめる。既定の試作品の中の AI はお試し。確かめている間は、作る run、ビルド、版の操作、ほかの確かめを断る
  const check = await call(base, {});
  assert.equal(check.status, 200);
  assert.equal(check.body.check.status, 'running');
  assert.equal(check.body.check.connection, 'mock');
  assert.equal((await call(base, {})).status, 409);
  assert.equal((await call(`/api/projects/${id}/builds`, {})).status, 409);
  assert.equal((await call(`/api/projects/${id}/versions`, { name: '確かめの間' })).status, 409);
  await assert.rejects(studio.requests.start(id, '見出しを「ひだまり図書室」にして'), /試作品を自動で確かめている/);
  const project = (await call('/api/projects')).body.projects.find((p) => p.id === id);
  assert.equal(project.checking, true);

  const deadline = Date.now() + 90_000;
  let done;
  while (Date.now() < deadline) {
    done = (await call(base)).body.checks.at(-1);
    if (done.status !== 'running') break;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  assert.notEqual(done.status, 'running', '確かめが 90 秒で終わりません');
  assert.equal((await call('/api/projects')).body.projects.find((p) => p.id === id).checking, false);
  if (done.status === 'unverified' && /Chromium/.test(done.gates[0]?.reason ?? '')) {
    t.skip('Playwright の Chromium がない');
    return;
  }
  // 作る run の関門 G5、G6 と同じ形の結果。report は観察の入口が書く
  assert.equal(done.status, 'passed');
  assert.deepEqual(done.gates.map((gate) => [gate.id, gate.name, gate.status]), [
    ['G5', 'launch', 'passed'],
    ['G6', 'scenarios', 'passed'],
  ]);
  assert.match(done.report, /^\.studio\/observations\/[0-9]+-[a-f0-9]{8}\/report\.json$/);
  const report = JSON.parse(await fs.readFile(path.join(home, 'projects', id, done.report), 'utf8'));
  assert.equal(report.format, 'prototype-studio-observation');
  assert.equal(report.verdict, 'passed');
  assert.equal(report.buildId, project.previewUrl.split('/').at(-2));
  assert.deepEqual(
    done.gates[0].screenshots.map((shot) => shot.name),
    ['mobile', 'tablet', 'desktop'],
  );
  // 終わったら、ほかの操作はまた通る
  assert.equal((await call(`/api/projects/${id}/builds`, {})).status, 200);
  // 証拠が古いかの API にも、確かめの印が入る(ビルドし直しても app/ は同じなので古くない)
  const evidence = (await call(`/api/projects/${id}/evidence`)).body;
  assert.deepEqual(evidence.checks, [{ id: done.id, appDigest: done.appDigest, stale: false }]);
});

test('本物の AI で確かめるときは、同意の前は断り(consent-required)、確かめは始まらない', { skip: process.platform === 'win32' }, async (t) => {
  const { call, home } = await withSimStudio(t);
  const refused = await call('/api/projects/sim-a/checks', { connection: 'claude-code' });
  assert.equal(refused.status, 403);
  assert.equal(refused.body.error.code, 'consent-required');
  assert.match(refused.body.error.message, /本物の AI で確かめる/);
  assert.deepEqual((await call('/api/projects/sim-a/checks')).body.checks, []);
  assert.equal(await fs.stat(path.join(home, 'claude.jsonl')).catch(() => null), null);
});
