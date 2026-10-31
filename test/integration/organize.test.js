import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadConfig, STUDIO_ROOT } from '../../src/server/config.js';
import { startStudio } from '../../src/server/index.js';

// ヒアリングの整理の API と起動(src/server/organize.js、docs/design/user-journey.md の K1)。実モデルは呼ばない。
const posixOnly = { skip: process.platform === 'win32' ? '偽の claude を直接起動するため' : false };
const FAKE = path.join(STUDIO_ROOT, 'test', 'fixtures', 'fake-claude.js');
const ID = 'sample-library';

async function boot(t, env, home = null) {
  const dir = home ?? (await fs.mkdtemp(path.join(os.tmpdir(), 'studio-organize-')));
  const log = path.join(dir, 'claude.log');
  const allEnv = { PATH: process.env.PATH, HOME: dir, STUDIO_CLAUDE_BIN: FAKE, FAKE_CLAUDE_LOG: log, ...env };
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
  const launches = async () => (await fs.readFile(log, 'utf8').catch(() => '')).split('\n').filter(Boolean).map((line) => JSON.parse(line)).filter((call_) => call_.argv.some((arg) => arg.includes('toAsk')));
  return { studio, home: dir, call, launches, close };
}

test('API: トークンがないと断る。同意の前は起動しない。知らない操作はない', posixOnly, async (t) => {
  const { studio, call, launches } = await boot(t, { STUDIO_AGENT: 'claude' });
  const base = `/api/projects/${ID}/organize`;
  assert.equal((await call(base, undefined, {})).status, 401);
  assert.equal((await call(`${base}/point`, { text: 'x' }, { origin: new URL(studio.url).origin })).status, 401);
  assert.equal((await call(`${base}/toString`, {})).status, 404);
  assert.equal((await call(`${base}/constructor`, {})).status, 404);
  assert.equal((await call('/api/projects/no-such/organize')).status, 404);

  assert.equal((await call(base)).body.organize.status, 'none');
  assert.equal((await call(`${base}/point`, { text: ' ' })).status, 400);
  assert.equal((await call(`${base}/point`, { text: '架空の要点' })).status, 200);
  const refused = await call(`${base}/run`, {});
  assert.equal(refused.status, 403);
  assert.equal(refused.body.error.code, 'consent-required');
  assert.equal((await launches()).length, 0);

  // 一覧にも状態が載る
  const listed = (await call('/api/projects')).body.projects.find((project) => project.id === ID);
  assert.equal(listed.organize.status, 'draft');

  // 要点がなければ、同意の後も呼ばない
  studio.consent.agree();
  assert.equal((await call('/api/projects/sample-job-consult/organize/run', {})).body.error.code, 'no-points');
  assert.equal((await launches()).length, 0);
});

test('起動の形: 道具を渡さず、cwd は試作品の外の空のフォルダー。送るのは要点と板だけ', posixOnly, async (t) => {
  const { studio, home, call, launches } = await boot(t, { STUDIO_AGENT: 'claude' });
  studio.consent.agree();
  const base = `/api/projects/${ID}/organize`;
  await call(`${base}/point`, { text: '架空の要点' });
  const { status, body } = await call(`${base}/run`, {});
  assert.equal(status, 200);
  assert.ok(body.organize.items.length > 0);
  const [launch] = await launches();
  for (const flag of ['-p', '--restricted', '--safe-mode', '--strict-mcp-config', '--no-session-persistence']) assert.ok(launch.argv.includes(flag), flag);
  assert.equal(launch.argv[launch.argv.indexOf('--tools') + 1], '');
  assert.ok(!launch.argv.join(' ').includes('架空の要点'), '要点は argv に入れない');
  assert.match(launch.stdin, /\[要点 1\] 架空の要点/);
  const cwd = await fs.realpath(launch.cwd);
  assert.ok(!cwd.startsWith(await fs.realpath(home)), cwd);
  assert.deepEqual(await fs.readdir(cwd), []);
});

test('人が決めた項目と消したものを、次の整理で AI に渡す', posixOnly, async (t) => {
  const { studio, call, launches } = await boot(t, { STUDIO_AGENT: 'claude' });
  studio.consent.agree();
  const base = `/api/projects/${ID}/organize`;
  await call(`${base}/point`, { text: '架空の要点' });
  const first = (await call(`${base}/run`, {})).body.organize;
  const guess = first.items.find((item) => item.guess);
  await call(`${base}/item-remove`, { id: guess.id });
  const held = first.items.find((item) => !item.guess);
  await call(`${base}/item-edit`, { id: held.id, text: '人が直した文' });
  const second = (await call(`${base}/run`, {})).body.organize;
  const stdin = (await launches())[1].stdin;
  assert.match(stdin, /<人が決めた項目>\n\[要求\] 人が直した文\(元の要点 1\)/);
  assert.match(stdin, new RegExp(`<人が消したもの>\\n${guess.text}`));
  assert.ok(second.items.some((item) => item.text === '人が直した文'));
  assert.ok(!second.items.some((item) => item.text === guess.text));
});

test('待つ間に足した要点は消えない。待つ間は「確かめた」を付けられず、もう 1 回は呼べない。止めると板を変えない', posixOnly, async (t) => {
  const { studio, call, launches } = await boot(t, { STUDIO_AGENT: 'claude' });
  studio.consent.agree();
  const base = `/api/projects/${ID}/organize`;
  await call(`${base}/point`, { text: '[整理が遅い] 架空の要点' });
  await call(`${base}/place`, { n: 1, column: 'data' });
  const running = call(`${base}/run`, {});
  for (let i = 0; i < 100 && !(await call(base)).body.organize.thinking; i += 1) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal((await call(base)).body.organize.thinking, true);
  assert.equal((await call(`${base}/point`, { text: '待つ間の要点' })).status, 200);
  assert.equal((await call(`${base}/run`, {})).body.error.code, 'busy');
  assert.equal((await call(`${base}/confirm`, {})).body.error.code, 'busy');
  for (let i = 0; i < 100 && (await launches()).length === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal((await launches()).length, 1);
  assert.equal((await call(`${base}/cancel`, {})).body.cancelled, true);
  const { body } = await running;
  assert.equal(body.organize.thinking, false);
  assert.match(body.organize.note, /止めました/);
  assert.deepEqual(body.organize.points.map((point) => point.n), [1, 2]);
  assert.equal(body.organize.items.length, 1);
  assert.equal((await call(`${base}/cancel`, {})).body.cancelled, false);
});

test('同じ試作品への同時の書き換えで、要点を落とさない', posixOnly, async (t) => {
  const { call } = await boot(t, { STUDIO_AGENT: 'fake' });
  const base = `/api/projects/${ID}/organize`;
  const results = await Promise.all(Array.from({ length: 10 }, (_, index) => call(`${base}/point`, { text: `要点 ${index}` })));
  assert.ok(results.every((result) => result.status === 200));
  const { organize } = (await call(base)).body;
  assert.equal(organize.points.length, 10);
  assert.equal(new Set(organize.points.map((point) => point.n)).size, 10);
});

test('起動し直しても板と印が残る。.studio/ に置き、app/ には書かない', posixOnly, async (t) => {
  const first = await boot(t, { STUDIO_AGENT: 'fake' });
  const base = `/api/projects/${ID}/organize`;
  await first.call(`${base}/point`, { text: '再配達の受付は 17 時まで' });
  const run = (await first.call(`${base}/run`, {})).body.organize;
  await first.call(`${base}/confirm`, { rev: run.rev });
  await first.close();
  const file = path.join(first.home, 'projects', ID, '.studio', 'organize.json');
  assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).status, 'confirmed');
  await assert.rejects(fs.access(path.join(first.home, 'projects', ID, 'app', 'organize.json')));

  const again = await boot(t, { STUDIO_AGENT: 'fake' }, first.home);
  const view = (await again.call(base)).body.organize;
  assert.equal(view.status, 'confirmed');
  assert.ok(view.items.some((item) => item.guess));
  assert.equal(view.points[0].text, '再配達の受付は 17 時まで');
});

test('本物の AI を止めた設定では呼ばない。Claude Code がないときも呼ばない', posixOnly, async (t) => {
  const off = await boot(t, { STUDIO_AGENT: 'claude', STUDIO_ALLOW_CLAUDE_CODE: '0' });
  const base = `/api/projects/${ID}/organize`;
  await off.call(`${base}/point`, { text: '架空の要点' });
  assert.equal((await off.call(base)).body.organize.ai, null);
  assert.equal((await off.call(`${base}/run`, {})).body.error.code, 'no-ai');
  assert.equal((await off.launches()).length, 0);
  // 手で振り分ける道は使える
  assert.equal((await off.call(`${base}/place`, { n: 1, column: 'user' })).body.organize.items[0].sources[0], 1);

  const missing = await boot(t, { STUDIO_AGENT: 'claude', STUDIO_CLAUDE_BIN: path.join(off.home, 'no-such-claude') });
  await missing.call(`${base}/point`, { text: '架空の要点' });
  assert.equal((await missing.call(`${base}/run`, {})).body.error.code, 'no-ai');
});
