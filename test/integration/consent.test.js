import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadConfig, STUDIO_ROOT } from '../../src/server/config.js';
import { startStudio } from '../../src/server/index.js';

// 本物の AI を使う前の同意(src/server/real-ai.js、docs/design/ux-redesign.md の 6 節、harness.md の P24)。
// 実モデルは呼ばない。作る AI と試作品の中の AI の Claude Code は、どちらも偽の claude に差し替える。

// 偽の claude をシェルスクリプトでつなぐため
const posixOnly = { skip: process.platform === 'win32' ? '偽の claude をシェルスクリプトで作るため' : false };
const JOB = 'sample-job-consult';
// 環境変数の値。どの応答にも出てはいけない
const SECRET = 'fictional-secret-value-0000';

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

// 作る AI(stream-json)は偽接続の作る AI に、それ以外(--version、auth status、試作品の中の AI)は偽の Claude Code に渡す
async function fakeClaude(dir) {
  const bin = path.join(dir, 'bin', 'claude');
  await fs.mkdir(path.dirname(bin), { recursive: true });
  const agent = path.join(STUDIO_ROOT, 'src', 'agent', 'fake-claude.js');
  const product = path.join(STUDIO_ROOT, 'test', 'fixtures', 'fake-claude.js');
  await fs.writeFile(
    bin,
    `#!/bin/sh\ncase " $* " in\n  *" stream-json "*) exec "${process.execPath}" "${agent}" "$@" ;;\n  *) exec "${process.execPath}" "${product}" "$@" ;;\nesac\n`,
    { mode: 0o755 },
  );
  return bin;
}

// 利用者と同じく環境変数から設定を読んで起動する。env は Studio と Claude Code に渡す環境変数(手元のものは渡さない)
async function boot(t, { home, env }) {
  const studio = await startStudio(loadConfig({ ...env, STUDIO_HOME: home, STUDIO_PORT: '0', STUDIO_PREVIEW_PORT: '0', STUDIO_NO_OPEN: '1' }), { env });
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await studio.close();
  };
  t.after(close);
  const token = new URL(studio.url).hash.slice('#token='.length);
  const port = studio.ports.studio;
  const host = `127.0.0.1:${port}`;
  const headers = { host, 'x-studio-token': token, origin: `http://${host}` };
  const call = async (pathname, json, extra = {}) => {
    const res = await request(port, {
      method: json === undefined ? 'GET' : 'POST',
      pathname,
      headers: { ...headers, ...(json === undefined ? {} : { 'content-type': 'application/json' }), ...extra },
      body: json === undefined ? undefined : JSON.stringify(json),
    });
    return { status: res.status, text: res.body, body: res.body.startsWith('{') && !res.body.includes('\n{') ? JSON.parse(res.body) : null };
  };
  return { studio, call, close };
}

async function setup(t, extraEnv = {}) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-consent-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const bin = await fakeClaude(home);
  const env = { PATH: process.env.PATH, STUDIO_AGENT: 'claude', STUDIO_CLAUDE_BIN: bin, FAKE_CLAUDE_LOG: path.join(home, 'product-ai.jsonl'), ...extraEnv };
  return { home, env };
}

// 作る run が終わるまで待つ
async function waitRun(call, id) {
  for (let i = 0; i < 200; i += 1) {
    const { body } = await call(`/api/projects/${id}/build-requests`);
    const run = body.runs.at(-1);
    if (run && run.status !== 'running') return run;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('作る run が終わりません');
}

test('同意の前は、作る AI の送信と本物の AI への切り替えを理由のコードつきで断り、同意の後は通す。起動し直すと同意は消える', posixOnly, async (t) => {
  const { home, env } = await setup(t);
  const first = await boot(t, { home, env });
  const { call } = first;

  const before = await call('/api/real-ai');
  assert.equal(before.status, 200);
  assert.deepEqual(before.body.consent, { agreed: false, agreedAt: null });
  // 変数がなくても、試作品の中の AI に本物の AI を選べる(同意の後に)
  assert.deepEqual(before.body.uses, { fix: { real: true, ready: true }, product: { allowed: true } });
  // 試作品を選ばなければ、試作品の中の AI の「詳しく」は入れない。ない試作品は 404
  assert.equal(before.body.details.product, null);
  assert.equal((await call('/api/real-ai?project=no-such-project')).status, 404);
  // 「詳しく」の記録の扱い。一覧の API も同意の状態を返す(画面の、本物の AI を使っている間の印)
  assert.match(before.body.details.records.join(''), /\.studio\/runs/);
  assert.deepEqual((await call('/api/projects')).body.consent, { agreed: false, agreedAt: null });

  // 作る AI の送信は断る。run は始めない
  const fix = await call(`/api/projects/${JOB}/build-requests`, { request: '失敗して' });
  assert.equal(fix.status, 403);
  assert.equal(fix.body.error.code, 'consent-required');
  assert.match(fix.body.error.message, /言葉で直すには、本物の AI を使うことへの同意が要ります/);
  assert.match(fix.body.error.next, /同意は Studio を止めるまで有効です/);
  assert.deepEqual((await call(`/api/projects/${JOB}/build-requests`)).body.runs, []);

  // 試作品の中の AI の本物への切り替えも断る。お試しの AI(モック)のまま話せる
  const choices = (await call(`/api/projects/${JOB}/ai/connections`)).body;
  assert.equal(choices.options.find((o) => o.kind === 'claude-code').available, true);
  const product = await call(`/api/projects/${JOB}/ai/connection`, { kind: 'claude-code' });
  assert.equal(product.status, 403);
  assert.equal(product.body.error.code, 'consent-required');
  assert.match(product.body.error.message, /試作品の中の AI を本物の AI にするには/);
  assert.equal((await call(`/api/projects/${JOB}/ai`)).body.session.connection.kind, 'mock');
  assert.equal((await call(`/api/projects/${JOB}/ai/messages`, { text: 'カフェで働きたいです' })).status, 200);

  // 同意の API は、ほかの API と同じくトークンと Origin を確かめる。GET では同意できない
  assert.equal((await call('/api/real-ai/consent', {}, { 'x-studio-token': 'wrong' })).status, 401);
  assert.equal((await call('/api/real-ai/consent', {}, { origin: 'http://localhost:1' })).status, 403);
  assert.equal((await call('/api/real-ai/consent')).status, 404);
  assert.equal((await call('/api/real-ai')).body.consent.agreed, false);

  const agreed = await call('/api/real-ai/consent', {});
  assert.equal(agreed.status, 200);
  assert.equal(agreed.body.consent.agreed, true);
  assert.match(agreed.body.consent.agreedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual((await call('/api/projects')).body.consent, agreed.body.consent);

  // 同意の後は通る。1 回の同意が、作る AI と試作品の中の AI の両方に効く
  const sent = await call(`/api/projects/${JOB}/build-requests`, { request: '失敗して' });
  assert.equal(sent.status, 200);
  const run = await waitRun(call, JOB);
  assert.equal(run.agent, 'Claude Code');
  const switched = await call(`/api/projects/${JOB}/ai/connection`, { kind: 'claude-code' });
  assert.equal(switched.status, 200);
  assert.equal(switched.body.session.connection.kind, 'claude-code');
  const reply = await call(`/api/projects/${JOB}/ai/messages`, { text: '正社員がいいです' });
  assert.equal(reply.status, 200);
  assert.equal(reply.body.session.messages.at(-1).via, 'claude-code');

  // 起動し直すと、同意は消える(ディスクに覚えない)。選んだ接続もお試しに戻る
  await first.close();
  const { call: again } = await boot(t, { home, env });
  assert.equal((await again('/api/real-ai')).body.consent.agreed, false);
  assert.equal((await again(`/api/projects/${JOB}/ai`)).body.session.connection.kind, 'mock');
  assert.equal((await again(`/api/projects/${JOB}/build-requests`, { request: '失敗して' })).body.error.code, 'consent-required');
  assert.equal((await again(`/api/projects/${JOB}/ai/connection`, { kind: 'claude-code' })).body.error.code, 'consent-required');
});

test('偽接続の作る AI とお試しの AI は、同意なしで使える', async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-consent-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const { call } = await boot(t, { home, env: { PATH: process.env.PATH, STUDIO_AGENT: 'fake' } });
  assert.equal((await call('/api/real-ai')).body.uses.fix.real, false);
  assert.equal((await call(`/api/projects/${JOB}/build-requests`, { request: '失敗して' })).status, 200);
  await waitRun(call, JOB);
  assert.equal((await call(`/api/projects/${JOB}/ai/connection`, { kind: 'mock' })).status, 200);
  assert.equal((await call(`/api/projects/${JOB}/ai/messages`, { text: 'カフェで働きたいです' })).status, 200);
  assert.equal((await call('/api/real-ai')).body.consent.agreed, false);
});

test('STUDIO_ALLOW_CLAUDE_CODE=0 では、同意の後でも試作品の中の AI に本物の AI を選べない', posixOnly, async (t) => {
  const { home, env } = await setup(t, { STUDIO_ALLOW_CLAUDE_CODE: '0' });
  const { studio, call } = await boot(t, { home, env });
  assert.deepEqual((await call('/api/real-ai')).body.uses.product, { allowed: false });
  assert.equal((await call('/api/real-ai/consent', {})).status, 200);
  const option = (await call(`/api/projects/${JOB}/ai/connections`)).body.options.find((o) => o.kind === 'claude-code');
  assert.equal(option.available, false);
  assert.equal(option.code, 'disabled');
  const refused = await call(`/api/projects/${JOB}/ai/connection`, { kind: 'claude-code' });
  assert.equal(refused.status, 403);
  assert.equal(refused.body.error.code, 'disabled');
  assert.equal((await call(`/api/projects/${JOB}/ai`)).body.session.connection.kind, 'mock');
  // 人の「確かめる」の観察で本物の AI を使う口にも効く(ブラウザを開く前に断る)
  await assert.rejects(studio.observe(JOB, { aiConnection: 'claude-code' }), { code: 'disabled' });
});

test('料金の文は、API キーの設定、Bedrock などの設定、ログインの方式で変わり、上限の数が入る。環境変数の値は出さない', posixOnly, async (t) => {
  const limits = (text) => {
    assert.match(text, /1 ドル/);
    assert.match(text, /0\.1 ドル/);
    assert.match(text, /1 ターンで 4 回まで/);
    assert.match(text, /1 時間に 120 回まで/);
  };
  const views = {};
  for (const [name, extra] of [
    ['api-key', { ANTHROPIC_API_KEY: SECRET }],
    ['settings', { CLAUDE_CODE_USE_BEDROCK: SECRET, ANTHROPIC_API_KEY: SECRET }],
    ['account', {}],
  ]) {
    const { home, env } = await setup(t, extra);
    const studio = await boot(t, { home, env });
    const res = await studio.call(`/api/real-ai?project=${JOB}`);
    assert.equal(res.status, 200);
    assert.ok(!res.text.includes(SECRET), name);
    // 画面の言葉で書く。環境変数の名前も出さない
    assert.ok(!/ANTHROPIC_|CLAUDE_CODE_|STUDIO_/.test(JSON.stringify(res.body.summary)), name);
    views[name] = res.body;
    await studio.close();
  }

  const apiKey = views['api-key'].summary;
  assert.equal(apiKey.cost.kind, 'api-key');
  assert.equal(apiKey.cost.text, 'API キーの設定があるので、使った分だけ料金がかかります。');
  assert.equal(apiKey.to, 'Anthropic(Claude を作っている会社)');
  // API キーのときは、作る AI の起動ごとに 1 ドルの上限を付ける。1 つの依頼では 3 回まで起動する
  assert.match(apiKey.cost.limits, /直すときは、作る AI の 1 回の起動で 1 ドルまでです\(1 つの依頼で多くて 3 回起動します\)/);
  limits(apiKey.cost.limits);

  const settings = views.settings.summary;
  assert.equal(settings.cost.kind, 'settings');
  assert.equal(settings.cost.text, '送り先と料金は、あなたの PC の設定に従います。');
  assert.equal(settings.to, 'あなたの PC の設定で決まった送り先');
  limits(settings.cost.limits);

  // claude auth status の方式(偽の claude は claude.ai)の 1 文だけ。メールアドレスなどは出さない
  const account = views.account.summary;
  assert.equal(account.cost.kind, 'account');
  assert.equal(account.cost.method, 'claude.ai');
  assert.equal(account.cost.text, 'Claude のアカウントでログインしているので、そのプランの利用枠を使います。');
  assert.match(account.cost.limits, /API キーなどの設定で動くときに付けます/);
  limits(account.cost.limits);
  assert.ok(!JSON.stringify(views.account).includes('fictional-user@example.com'));

  assert.equal(new Set(Object.values(views).map((view) => view.summary.cost.text)).size, 3);

  // 「詳しく」には、今の確認の中身(送る指示の全文、項目と選択肢、会話の件数、上限、回数の制限、道具を渡さないこと)を入れる
  const product = views.account.details.product;
  assert.equal(product.kind, 'claude-code');
  assert.match(product.sends.systemPrompt, /しおかぜ求人相談/);
  assert.match(product.sends.items.join('\n'), /会話の全体/);
  assert.ok(product.fields.length > 0);
  assert.ok(product.fields.some((field) => Array.isArray(field.options) && field.options.length > 0));
  assert.equal(product.conversation.messages, 1);
  assert.match(product.billing.text, /1 回の呼び出しの上限は \$0\.1 です/);
  assert.match(product.limits.text, /1 ターンで 4 回まで/);
  assert.match(product.limits.text, /60 分に 120 回まで/);
  assert.match(product.limits.text, /30 回の返事まで/);
  assert.match(product.tools, /ツールを渡していません/);
  assert.match(views.account.details.fix.systemPrompt, /Prototype Studio の「作る AI」/);
  assert.match(views.account.details.fix.tools, /コマンドの実行と Web は渡しません/);
});
