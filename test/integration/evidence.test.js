import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { startStudio } from '../../src/server/index.js';

// 作るループの証拠(docs/design/harness.md の 7.2、S6)。作る AI は偽接続(STUDIO_AGENT=fake と同じ)で、モデルを呼ばない。
// 証拠が古いかは、run が確かめた app/ の指紋と、今の app/ の指紋で決まる。スクリーンショットの API は
// .studio/runs/ と .studio/observations/ の中の画像だけを返し、トークンがなければ断る
const PROJECT = 'sample-library';
// 1x1 の PNG(架空の画像)
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6300010000000500010d0a2db40000000049454e44ae426082', 'hex');

async function boot(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-evidence-'));
  // 関門 G5、G6 は Studio の観察器(Playwright の Chromium)。ないときは未確認になるが、指紋は残る
  const studio = await startStudio({ home, studioPort: 0, previewPort: 0, openBrowser: false, agent: 'fake' }, { env: { PATH: process.env.PATH } });
  t.after(async () => {
    await studio.close();
    await fs.rm(home, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${studio.ports.studio}`;
  const token = new URL(studio.url).hash.slice('#token='.length);
  const root = path.join(home, 'projects', PROJECT);
  const get = (pathname, headers = { 'X-Studio-Token': token }) => fetch(`${origin}${pathname}`, { headers });
  const evidence = async () => (await get(`/api/projects/${PROJECT}/evidence`)).json();
  const staleOf = async (run) => (await evidence()).runs.find((r) => r.id === run.id)?.stale;
  const send = async (text) => {
    const started = await studio.requests.start(PROJECT, text);
    return new Promise((resolve) => started.subscribe(() => {}, resolve));
  };
  const screenshot = (file, headers) => get(`/api/projects/${PROJECT}/evidence/screenshot?file=${encodeURIComponent(file)}`, headers);
  return { home, root, studio, token, origin, evidence, staleOf, send, screenshot };
}

test('作業中の app/ が変わると、前の証拠が古くなる(次の依頼、手で変えたとき、版の復元)(S6)', async (t) => {
  const { root, studio, staleOf, evidence, send } = await boot(t);
  const appFile = path.join(root, 'app', 'App.jsx');
  const original = await fs.readFile(appFile, 'utf8');
  // 版の復元で戻す先
  const saved = await studio.versions.save(PROJECT, { name: '依頼の前' });

  const first = await send('見出しを「ひだまり図書室」にして');
  assert.ok(['passed', 'unverified'].includes(first.status), first.status);
  assert.match(first.appDigest, /^[a-f0-9]{64}$/);
  assert.equal(first.appDigest, first.build.appDigest);
  // run.json にも、確かめた指紋が残る
  const record = JSON.parse(await fs.readFile(path.join(root, first.evidence.run), 'utf8'));
  assert.equal(record.appDigest, first.appDigest);
  assert.equal((await evidence()).appDigest, first.appDigest);
  assert.equal(await staleOf(first), false);

  // 手で変えると古くなり、元に戻すと古くなくなる(指紋で決めるので、時刻では決めない)
  const edited = (await fs.readFile(appFile, 'utf8')).replace('ひだまり図書室', 'ひだまり図書室(手で直した)');
  await fs.writeFile(appFile, edited);
  assert.equal(await staleOf(first), true);
  await fs.writeFile(appFile, edited.replace('ひだまり図書室(手で直した)', 'ひだまり図書室'));
  assert.equal(await staleOf(first), false);

  // 次の依頼の後は、前の証拠が古く、新しい証拠は古くない(直しきれずに止まった run も、確かめた app/ は今の app/)
  const second = await send('壊して、直せないふりをして');
  assert.equal(second.status, 'failed');
  assert.equal(await staleOf(first), true);
  assert.equal(await staleOf(second), false);

  // 版の復元で app/ が依頼の前に戻ると、どちらの証拠も古い
  await studio.versions.restore(PROJECT, saved.version.id);
  assert.equal(await fs.readFile(appFile, 'utf8'), original);
  assert.equal(await staleOf(first), true);
  assert.equal(await staleOf(second), true);
});

test('関門まで進まなかった run と、動いている run には、古いかの印を付けない', async (t) => {
  const { studio, staleOf, send } = await boot(t);
  const failed = await send('失敗して');
  assert.equal(failed.status, 'agent-failed');
  // 作る AI が失敗しても、app/ を確かめた(G1)ので指紋はある
  assert.equal(await staleOf(failed), false);

  const started = await studio.requests.start(PROJECT, 'ゆっくり進めて');
  assert.equal(await staleOf(started.run), null);
  studio.requests.cancel(PROJECT, started.run.id);
  await new Promise((resolve) => started.subscribe(() => {}, resolve));
});

test('スクリーンショットの API は、.studio/runs/ と .studio/observations/ の中の画像だけを返し、トークンがないと断る', async (t) => {
  const { home, root, screenshot, token, origin } = await boot(t);
  const runDir = path.join(root, '.studio', 'runs', '0123456789abcdef', 'rounds', '1');
  await fs.mkdir(runDir, { recursive: true });
  await fs.writeFile(path.join(runDir, 'desktop.png'), PNG);
  const obsDir = path.join(root, '.studio', 'observations', 'obs-1');
  await fs.mkdir(obsDir, { recursive: true });
  await fs.writeFile(path.join(obsDir, 'desktop.png'), PNG);

  const ok = await screenshot('.studio/runs/0123456789abcdef/rounds/1/desktop.png');
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('content-type'), 'image/png');
  assert.equal(ok.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(ok.headers.get('cache-control'), 'no-store');
  assert.deepEqual(Buffer.from(await ok.arrayBuffer()), PNG);
  assert.equal((await screenshot('.studio/observations/obs-1/desktop.png')).status, 200);

  // トークンがない、合わない
  const noToken = await screenshot('.studio/runs/0123456789abcdef/rounds/1/desktop.png', {});
  assert.equal(noToken.status, 401);
  assert.equal((await noToken.json()).error.code, 'token');
  assert.equal((await screenshot('.studio/runs/0123456789abcdef/rounds/1/desktop.png', { 'X-Studio-Token': '0'.repeat(64) })).status, 401);

  // 置き場の外。app/、ビルド、版、上へのたどり、絶対パス、PNG でないもの
  await fs.writeFile(path.join(root, 'app', 'shot.png'), PNG);
  await fs.mkdir(path.join(root, '.studio', 'builds'), { recursive: true });
  await fs.writeFile(path.join(root, '.studio', 'builds', 'shot.png'), PNG);
  await fs.writeFile(path.join(home, 'outside.png'), PNG);
  for (const file of [
    'app/shot.png',
    '.studio/builds/shot.png',
    '.studio/runs/../builds/shot.png',
    '.studio/runs/../../app/shot.png',
    '.studio/runs/./0123456789abcdef/rounds/1/desktop.png',
    path.join(home, 'outside.png'),
    '.studio/runs/0123456789abcdef/run.json',
    '.studio/runs',
    '',
  ]) {
    const response = await screenshot(file);
    assert.equal(response.status, 400, file);
    assert.equal((await response.json()).error.code, 'invalid', file);
  }
  // 場所がない
  assert.equal((await fetch(`${origin}/api/projects/${PROJECT}/evidence/screenshot`, { headers: { 'X-Studio-Token': token } })).status, 400);
  assert.equal((await screenshot('.studio/runs/0123456789abcdef/rounds/1/none.png')).status, 404);
  // 名前が .png でも、中身が PNG でなければ返さない
  await fs.writeFile(path.join(runDir, 'fake.png'), 'PNG ではない');
  assert.equal((await screenshot('.studio/runs/0123456789abcdef/rounds/1/fake.png')).status, 404);

  // シンボリックリンクで外を指しても読まない(ファイルのリンクと、置き場のフォルダーのリンク)
  await fs.symlink(path.join(home, 'outside.png'), path.join(runDir, 'link.png'));
  assert.equal((await screenshot('.studio/runs/0123456789abcdef/rounds/1/link.png')).status, 404);
  await fs.mkdir(path.join(home, 'elsewhere'), { recursive: true });
  await fs.writeFile(path.join(home, 'elsewhere', 'desktop.png'), PNG);
  await fs.rm(obsDir, { recursive: true });
  await fs.symlink(path.join(home, 'elsewhere'), obsDir);
  assert.equal((await screenshot('.studio/observations/obs-1/desktop.png')).status, 404);

  // ない試作品
  assert.equal((await fetch(`${origin}/api/projects/none/evidence/screenshot?file=x.png`, { headers: { 'X-Studio-Token': token } })).status, 404);
  // GET だけ
  const post = await fetch(`${origin}/api/projects/${PROJECT}/evidence`, { method: 'POST', headers: { 'X-Studio-Token': token, Origin: origin } });
  assert.equal(post.status, 404);
});

test('作る run の結果に、確かめた画面幅のスクリーンショットの場所が入り、API で読める', async (t) => {
  const { send, screenshot } = await boot(t);
  const run = await send('見出しを「ひだまり図書室」にして');
  const launch = run.gates.find((gate) => gate.name === 'launch');
  if (launch.status === 'unverified' && /Chromium/.test(launch.reason ?? '')) {
    t.skip('Playwright の Chromium がない');
    return;
  }
  assert.equal(run.status, 'passed');
  assert.deepEqual(
    launch.screenshots.map((shot) => [shot.name, shot.file]),
    ['mobile', 'tablet', 'desktop'].map((name) => [name, `.studio/runs/${run.id}/rounds/1/${name}.png`]),
  );
  for (const shot of launch.screenshots) {
    const response = await screenshot(shot.file);
    assert.equal(response.status, 200, shot.file);
    assert.equal(response.headers.get('content-type'), 'image/png');
  }
  // シナリオの関門の結果に、シナリオごとの手順と結果が入る(結果の帯の「確かめた中身」で見せる)
  const scenarios = run.gates.find((gate) => gate.name === 'scenarios');
  assert.ok(scenarios.scenarios.length > 0);
  assert.ok(scenarios.scenarios.every((scenario) => scenario.verdict === 'passed' && scenario.steps.every((step) => typeof step.text === 'string')));
});
