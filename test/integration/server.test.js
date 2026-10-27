import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
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
  const studio = await startStudio({ home, studioPort: 0, previewPort: 0, openBrowser: false });
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
  await assert.rejects(startStudio({ home, studioPort: port, previewPort: 0, openBrowser: false }), {
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
  await assert.rejects(startStudio({ home, studioPort: 0, previewPort: port, openBrowser: false }), {
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

  const studio = await startStudio({ home, studioPort: 0, previewPort: 0, openBrowser: false });
  t.after(() => studio.close());
  const projects = await studio.store.list();
  assert.deepEqual(projects.map((p) => p.id), ['locked', 'sample-job-consult', 'sample-library']);
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
  await assert.rejects(startStudio({ home, studioPort: 0, previewPort: 0, openBrowser: false }), HomeNotWritableError);
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
  assert.match(during.body.error.message, /版を保存か復元しているところ/);
  assert.equal((await call('/api/projects/sample-job-consult/ai')).status, 200);
  studio.store.releaseVersions('sample-job-consult');
});

test('プロダクト内 AI の接続の API: 既定はモック、実モデルは許されるまで選べず、Studio 画面以外からは切り替えられない', async (t) => {
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
  assert.equal(claude.available, false);
  assert.match(claude.reason, /STUDIO_ALLOW_CLAUDE_CODE=1/);
  assert.ok(['subscription', 'api-key'].includes(claude.billing.kind));
  assert.match(claude.sends.systemPrompt, /しおかぜ求人相談/);

  const refused = await call(`${base}/connection`, { kind: 'claude-code', confirmed: true });
  assert.equal(refused.status, 403);
  assert.equal(refused.body.error.code, 'unavailable');
  assert.equal((await call(`${base}/connection`, { kind: 'claude-code', confirmed: true }, { origin: 'http://localhost:1' })).status, 403);
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
  assert.match(full.body.error.next, /リセット/);

  // 消すのは POST だけ。AI のない試作品と、鍵と Origin の守りは他の API と同じ
  assert.equal((await call(`${base}/clear-trace`)).status, 404);
  assert.equal((await call(`${base}/trace`, {})).status, 404);
  assert.equal((await call(`${base}/clear-trace`, {}, { origin: 'http://evil.example' })).status, 403);
  assert.equal((await call(`${base}/trace`, undefined, { 'x-studio-token': 'x' })).status, 401);
  assert.equal((await call('/api/projects/sample-library/ai/trace')).body.error.code, 'no-ai');
  assert.deepEqual((await call(`${base}/clear-trace`, {})).body.entries, []);
});
