import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { connectionView, FAKE_CLI, findOnPath, isAtLeast, parseAuthStatus, parseVersion, resolveConnection } from '../../src/server/agent-connection.js';
import { startStudio } from '../../src/server/index.js';

const posixOnly = { skip: process.platform === 'win32' ? '偽の claude をシェルスクリプトで作るため' : false };

// 架空のログインの値。Studio の API の応答と記録に出てはいけない
const SECRETS = ['fictional-user@example.com', '架空の組織', 'fictional-org-0000', '/fictional/config-dir'];
const LOGGED_IN = {
  loggedIn: true,
  authMethod: 'claude.ai',
  apiProvider: 'firstParty',
  analyticsDisabled: false,
  projectsDirectory: `${SECRETS[3]}/projects`,
  configDirectory: SECRETS[3],
  email: SECRETS[0],
  orgName: SECRETS[1],
  orgId: SECRETS[2],
  subscriptionType: 'max',
};
// 本物(2.1.312)はログインしていないとき、この形を終了コード 1 で返す
const LOGGED_OUT = { loggedIn: false, authMethod: 'none', apiProvider: 'firstParty', configDirectory: SECRETS[3] };

// 偽の claude。--version には版を返す。auth status には、auth を渡せばその JSON を、渡さなければ版の文を返す(形の分からない版)
async function fakeClaude(t, version, { auth, authExit = 0 } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-connection-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'claude');
  const authPart = auth ? `if [ "$1" = "auth" ] && [ "$2" = "status" ]; then\ncat <<'EOF'\n${JSON.stringify(auth, null, 2)}\nEOF\nexit ${authExit}\nfi\n` : '';
  await fs.writeFile(bin, `#!/bin/sh\n${authPart}echo "${version} (Claude Code)"\n`, { mode: 0o755 });
  return { dir, bin };
}

test('版を読み、下限と比べる', () => {
  assert.deepEqual(parseVersion('2.1.311 (Claude Code)'), [2, 1, 311]);
  assert.equal(parseVersion('unknown'), null);
  assert.equal(isAtLeast([2, 1, 248], [2, 1, 248]), true);
  assert.equal(isAtLeast([2, 1, 247], [2, 1, 248]), false);
  assert.equal(isAtLeast([2, 2, 0], [2, 1, 248]), true);
  assert.equal(isAtLeast([3, 0, 0], [2, 1, 248]), true);
});

test('STUDIO_AGENT=fake は偽接続で、Claude Code を探さない', async () => {
  const connection = await resolveConnection({ agent: 'fake' }, { PATH: '' });
  assert.equal(connection.kind, 'fake');
  assert.equal(connection.status, 'ready');
  assert.equal(connection.auth, null);
  assert.equal(connection.command, process.execPath);
  assert.deepEqual(connection.prefixArgs, [FAKE_CLI]);
  assert.equal(connection.problem, null);
  assert.ok(connection.examples.length > 0);
});

test('claude を PATH から探す。実行できないファイルは飛ばす', posixOnly, async (t) => {
  const { dir, bin } = await fakeClaude(t, '2.1.311');
  const other = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-connection-'));
  t.after(() => fs.rm(other, { recursive: true, force: true }));
  await fs.writeFile(path.join(other, 'claude'), '', { mode: 0o644 });
  assert.equal(await findOnPath('claude', { PATH: [other, dir].join(path.delimiter) }), bin);
  assert.equal(await findOnPath('claude', { PATH: other }), null);

  const connection = await resolveConnection({ agent: 'claude' }, { PATH: [other, dir].join(path.delimiter) });
  assert.equal(connection.kind, 'claude');
  assert.equal(connection.command, bin);
  assert.equal(connection.version, '2.1.311');
  assert.equal(connection.problem, null);
});

test('古い Claude Code や、見つからないときは理由を返す', posixOnly, async (t) => {
  const { bin } = await fakeClaude(t, '2.1.100');
  const old = await resolveConnection({ agent: 'claude', claudeBin: bin }, {});
  assert.match(old.problem, /2\.1\.100 は古すぎます/);
  const missing = await resolveConnection({ agent: 'claude' }, { PATH: '' });
  assert.match(missing.problem, /claude が見つかりません/);
});

test('接続を書かない呼び出しは誤りにする。手元の Claude Code を知らずに起動しないため', async () => {
  await assert.rejects(resolveConnection({}, { PATH: '' }), /agent/);
  await assert.rejects(resolveConnection({ agent: 'gpt' }, { PATH: '' }), /agent/);
});

test('auth status の出力から、ログインしているかと方式だけを取り出す', () => {
  assert.deepEqual(parseAuthStatus(JSON.stringify(LOGGED_IN)), { loggedIn: true, method: 'claude.ai' });
  assert.deepEqual(parseAuthStatus(JSON.stringify(LOGGED_OUT)), { loggedIn: false, method: 'none' });
  for (const method of ['api_key', 'oauth_token', 'third_party']) {
    assert.deepEqual(parseAuthStatus(JSON.stringify({ loggedIn: true, authMethod: method })), { loggedIn: true, method });
  }
  // 知らない方式の値はそのまま出さない
  assert.deepEqual(parseAuthStatus(JSON.stringify({ loggedIn: true, authMethod: SECRETS[0] })), { loggedIn: true, method: 'other' });
  assert.deepEqual(parseAuthStatus(JSON.stringify({ loggedIn: true })), { loggedIn: true, method: null });
  // 形が分からないとき
  for (const text of ['', '2.1.311 (Claude Code)', 'Login method: Claude Max', '{"loggedIn":"yes"}', 'null', '[]']) {
    assert.equal(parseAuthStatus(text), null, text);
  }
});

test('自動の判定 4 通り: 使える、ない、古い、ログインしていない', posixOnly, async (t) => {
  const ready = await fakeClaude(t, '2.1.311', { auth: LOGGED_IN });
  const old = await fakeClaude(t, '2.1.100', { auth: LOGGED_IN });
  const loggedOut = await fakeClaude(t, '2.1.311', { auth: LOGGED_OUT, authExit: 1 });

  const usable = await resolveConnection({ agent: 'auto', claudeBin: ready.bin }, {});
  assert.equal(usable.mode, 'auto');
  assert.equal(usable.kind, 'claude');
  assert.equal(usable.status, 'ready');
  assert.equal(usable.problem, null);
  assert.equal(usable.version, '2.1.311');
  assert.deepEqual(usable.auth, { loggedIn: true, method: 'claude.ai' });
  // PATH から見つけても同じ
  assert.equal((await resolveConnection({ agent: 'auto' }, { PATH: ready.dir })).status, 'ready');

  const missing = await resolveConnection({ agent: 'auto' }, { PATH: '' });
  assert.equal(missing.kind, 'claude');
  assert.equal(missing.status, 'missing');
  assert.match(missing.problem, /claude が見つかりません/);
  // STUDIO_CLAUDE_BIN がない場所を指すときも「ない」
  const missingBin = await resolveConnection({ agent: 'auto', claudeBin: path.join(ready.dir, 'no-such-claude') }, {});
  assert.equal(missingBin.status, 'missing');

  const tooOld = await resolveConnection({ agent: 'auto', claudeBin: old.bin }, {});
  assert.equal(tooOld.status, 'old');
  assert.match(tooOld.problem, /2\.1\.100 は古すぎます/);

  const notLoggedIn = await resolveConnection({ agent: 'auto', claudeBin: loggedOut.bin }, {});
  assert.equal(notLoggedIn.status, 'not-logged-in');
  assert.match(notLoggedIn.problem, /ログインしていません/);
  assert.deepEqual(notLoggedIn.auth, { loggedIn: false, method: 'none' });

  // 偽接続には落とさない
  for (const connection of [missing, tooOld, notLoggedIn]) {
    assert.equal(connection.kind, 'claude');
    assert.equal(connectionView(connection).ready, false);
  }
});

test('STUDIO_AGENT=claude も同じ判定で、Claude Code に固定する', posixOnly, async (t) => {
  const loggedOut = await fakeClaude(t, '2.1.311', { auth: LOGGED_OUT, authExit: 1 });
  const connection = await resolveConnection({ agent: 'claude', claudeBin: loggedOut.bin }, {});
  assert.equal(connection.mode, 'claude');
  assert.equal(connection.kind, 'claude');
  assert.equal(connection.status, 'not-logged-in');
});

test('auth status の形が分からない版は使えるとし、最初の送信の失敗で見分ける', posixOnly, async (t) => {
  // 版の文だけを返す(auth status を知らない版の代わり)
  const { bin } = await fakeClaude(t, '2.1.300');
  const connection = await resolveConnection({ agent: 'auto', claudeBin: bin }, {});
  assert.equal(connection.status, 'ready');
  assert.equal(connection.problem, null);
  assert.deepEqual(connection.auth, { loggedIn: null, method: null });
});

test('auth status のログインの有無と方式以外の値は、API の応答と記録に出ない', posixOnly, async (t) => {
  const { bin } = await fakeClaude(t, '2.1.311', { auth: LOGGED_IN });
  const connection = await resolveConnection({ agent: 'auto', claudeBin: bin }, {});
  const view = connectionView(connection);
  assert.deepEqual(view.auth, { loggedIn: true, method: 'claude.ai' });
  for (const text of [JSON.stringify(connection), JSON.stringify(view)]) {
    for (const secret of [...SECRETS, 'subscriptionType', 'firstParty']) assert.ok(!text.includes(secret), secret);
  }

  // Studio を起動し、画面が読む API と、ログと、データの置き場のファイルを調べる
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-connection-home-'));
  const lines = [];
  const studio = await startStudio(
    { home, studioPort: 0, previewPort: 0, openBrowser: false, agent: 'auto', claudeBin: bin },
    { env: { PATH: process.env.PATH }, log: (line) => lines.push(line) },
  );
  t.after(async () => {
    await studio.close();
    await fs.rm(home, { recursive: true, force: true });
  });
  const token = new URL(studio.url).hash.slice('#token='.length);
  const response = await fetch(`http://127.0.0.1:${studio.ports.studio}/api/projects`, { headers: { 'X-Studio-Token': token } });
  const body = await response.text();
  assert.equal(JSON.parse(body).agent.status, 'ready');
  assert.deepEqual(JSON.parse(body).agent.auth, { loggedIn: true, method: 'claude.ai' });
  const files = (await fs.readdir(home, { recursive: true, withFileTypes: true })).filter((entry) => entry.isFile());
  const stored = await Promise.all(files.map((entry) => fs.readFile(path.join(entry.parentPath, entry.name), 'utf8')));
  for (const [name, text] of [['API', body], ['ログ', lines.join('\n')], ['置き場', stored.join('\n')]]) {
    for (const secret of SECRETS) assert.ok(!text.includes(secret), `${name}に ${secret}`);
  }
});
