import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { STUDIO_ROOT, loadConfig } from '../../src/server/config.js';
import { startStudio } from '../../src/server/index.js';
import { ensureSampleProjects, projectPaths } from '../../src/server/projects.js';

// 観察の CLI(npm run observe -- <プロジェクト>、docs/design/harness.md の 3.1、S5)。
// CLI は動いている Studio とは別に、作業中の app/ を一時フォルダーにビルドして観察する。
// 作るループの関門と CLI が、同じ入口から同じ形の report を返すことも、ここで確かめる。
// 本物の観察器(Playwright の Chromium)を使う。プロダクト内 AI はモックで、モデルは呼ばない
const CLI = path.join(STUDIO_ROOT, 'bin', 'observe.js');
const JOB = 'sample-job-consult';
const LIBRARY = 'sample-library';
const CLI_TIMEOUT_MS = 120_000;

let home;
let tmp;
let studio;

// CLI を子プロセスで動かす。一時フォルダー(TMPDIR)はこのテストだけのものにして、消えたかを見る
function runCli(args, env = {}) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [CLI, ...args],
      { env: { PATH: process.env.PATH, HOME: process.env.HOME, STUDIO_HOME: home, TMPDIR: tmp, ...env }, timeout: CLI_TIMEOUT_MS },
      (error, stdout, stderr) => resolve({ code: error ? (error.code ?? 'killed') : 0, stdout, stderr }),
    );
  });
}

// フォルダーの中のファイルと、その中身と時刻(変わっていないかを比べる)
async function snapshotDir(dir) {
  const files = {};
  for (const name of (await fs.readdir(dir, { recursive: true })).sort()) {
    const file = path.join(dir, name);
    const stat = await fs.stat(file);
    if (stat.isFile()) files[name] = { mtimeMs: stat.mtimeMs, body: (await fs.readFile(file)).toString('base64') };
  }
  return files;
}

async function observations(id) {
  const dir = path.join(projectPaths(home, id).studio, 'observations');
  return (await fs.readdir(dir).catch(() => [])).sort();
}

const reportPathOf = (stdout) => /^report: (.+)$/m.exec(stdout)?.[1];

test.before(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-observe-cli-'));
  tmp = path.join(home, 'tmp');
  await fs.mkdir(tmp);
  await ensureSampleProjects(home, path.join(STUDIO_ROOT, 'samples'));
  // 動いている Studio。CLI はこの表示中のビルドに触れない
  studio = await startStudio(loadConfig({ STUDIO_HOME: home, STUDIO_PORT: '0', STUDIO_PREVIEW_PORT: '0', STUDIO_NO_OPEN: '1' }), { env: {} });
});

test.after(async () => {
  await studio?.close();
  if (home) await fs.rm(home, { recursive: true, force: true });
});

test('CLI で見本を観察すると、新しい観察のフォルダーに report とスクリーンショットができ、表示中のビルドと .studio/builds/ は変わらない', async () => {
  const paths = projectPaths(home, JOB);
  const shownBuild = studio.store.previewBuildId(JOB);
  const previewUrl = `http://localhost:${studio.ports.preview}/p/${JOB}/${shownBuild}/`;
  const builds = await snapshotDir(paths.builds);
  assert.ok(Object.keys(builds).length > 0);

  const first = await runCli([JOB, '--viewports', 'mobile,desktop']);
  assert.equal(first.code, 0, first.stdout + first.stderr);
  assert.match(first.stdout, /^結果: passed/m);
  assert.match(first.stdout, /^エラー: 0 件$/m);
  assert.match(first.stdout, /^シナリオ: 3 本のうち 3 本が通った$/m);
  assert.match(first.stdout, /通った 希望を話すと、希望条件が埋まり、合う求人が絞られる/);

  // report は .studio/observations/<obs-id>/report.json。スクリーンショットも同じフォルダー
  const reportFile = reportPathOf(first.stdout);
  const dir = path.dirname(reportFile);
  assert.equal(path.dirname(dir), path.join(paths.studio, 'observations'));
  const report = JSON.parse(await fs.readFile(reportFile, 'utf8'));
  assert.equal(report.format, 'prototype-studio-observation');
  assert.equal(report.formatVersion, 1);
  assert.equal(report.verdict, 'passed');
  assert.deepEqual(report.screenshots.map((s) => [s.name, path.dirname(s.file)]), [['mobile', dir], ['desktop', dir]]);
  for (const shot of report.screenshots) {
    assert.ok((await fs.stat(shot.file)).size > 0);
    assert.match(first.stdout, new RegExp(`^  ${shot.file.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
  }
  // プロダクト内 AI はモックの観察用の会話で答えた
  assert.ok(report.ai.length > 0);
  for (const entry of report.ai) assert.deepEqual([entry.connection.kind, entry.connection.real], ['mock', false]);
  // 作業中の app/ を、Studio の表示中のビルドとは別にビルドした(中身は同じ)
  assert.notEqual(report.buildId, shownBuild);
  assert.equal(report.appDigest, (await studio.store.list()).find((p) => p.id === JOB).lastBuild.appDigest);

  // 2 回目は別のフォルダーに書く(上書きしない)
  const second = await runCli([JOB, '--viewports', 'mobile']);
  assert.equal(second.code, 0, second.stdout + second.stderr);
  assert.notEqual(path.dirname(reportPathOf(second.stdout)), dir);
  assert.equal((await observations(JOB)).length, 2);
  assert.ok(await fs.stat(reportFile));

  // 表示中のビルドと .studio/builds/ は変わらない。プレビューは今も同じビルドを返す
  assert.equal(studio.store.previewBuildId(JOB), shownBuild);
  assert.deepEqual(await snapshotDir(paths.builds), builds);
  assert.equal((await fetch(previewUrl)).status, 200);
  // 一時フォルダーは消えている
  assert.deepEqual((await fs.readdir(tmp)).filter((name) => name.startsWith('prototype-studio-observe-')), []);
});

test('作るループの関門 G5、G6、Studio の observe() と CLI は、同じ形の report を返す', async () => {
  const cli = await runCli([JOB, '--viewports', 'mobile']);
  assert.equal(cli.code, 0, cli.stdout + cli.stderr);
  const fromCli = JSON.parse(await fs.readFile(reportPathOf(cli.stdout), 'utf8'));

  const roundDir = path.join(home, 'gate-out');
  const launch = await studio.requests.observe(JOB, { gate: 'launch', viewports: ['mobile'], outDir: roundDir });
  const scenarios = await studio.requests.observe(JOB, { gate: 'scenarios', viewports: [], outDir: path.join(roundDir, 'scenarios'), limits: {} });
  const human = await studio.observe(JOB, { viewports: [], aiConnection: 'mock' });
  for (const report of [launch, scenarios, human]) {
    assert.equal(report.format, fromCli.format);
    assert.equal(report.formatVersion, fromCli.formatVersion);
    assert.deepEqual(Object.keys(report), Object.keys(fromCli));
    assert.equal(report.verdict, 'passed');
  }
  // G6 と CLI は同じシナリオ(基本のシナリオと app/scenarios/)を、モックの AI で回す
  assert.deepEqual(scenarios.scenarios.map((s) => [s.name, s.verdict]), fromCli.scenarios.map((s) => [s.name, s.verdict]));
  assert.deepEqual(Object.keys(scenarios.scenarios[0]), Object.keys(fromCli.scenarios[0]));
  // G5 は基本のシナリオなしで観察する(今までどおり)
  assert.deepEqual(launch.scenarios, []);
});

test('壊した見本では、CLI の終了コードが 0 以外になる(実行時のエラー、ビルドの失敗)', async () => {
  const app = projectPaths(home, LIBRARY).app;
  const shownBuild = studio.store.previewBuildId(LIBRARY);
  const original = await fs.readFile(path.join(app, 'App.jsx'), 'utf8');
  try {
    // 描画の前に投げる(ビルドは通る)
    await fs.writeFile(path.join(app, 'App.jsx'), `throw new Error('架空の図書室の棚が壊れました');\n${original}`);
    const thrown = await runCli([LIBRARY, '--viewports', 'mobile']);
    assert.equal(thrown.code, 1, thrown.stdout + thrown.stderr);
    assert.match(thrown.stdout, /^結果: failed/m);
    assert.match(thrown.stdout, /架空の図書室の棚が壊れました/);
    const report = JSON.parse(await fs.readFile(reportPathOf(thrown.stdout), 'utf8'));
    assert.equal(report.verdict, 'failed');
    assert.ok(report.errors.some((error) => error.kind === 'runtime'));

    // ビルドできない(ブラウザは開かない)
    await fs.writeFile(path.join(app, 'App.jsx'), `${original}\nconst broken = ;\n`);
    const unbuilt = await runCli([LIBRARY, '--viewports', 'mobile']);
    assert.equal(unbuilt.code, 1, unbuilt.stdout + unbuilt.stderr);
    const failed = JSON.parse(await fs.readFile(reportPathOf(unbuilt.stdout), 'utf8'));
    assert.equal(failed.errors[0].kind, 'build');
    assert.equal(failed.errors[0].file, 'app/App.jsx');
    assert.equal(failed.buildId, null);
  } finally {
    await fs.writeFile(path.join(app, 'App.jsx'), original);
  }
  // 壊した app/ を観察しても、Studio の表示中のビルドは変わらない
  assert.equal(studio.store.previewBuildId(LIBRARY), shownBuild);
  assert.deepEqual((await fs.readdir(tmp)).filter((name) => name.startsWith('prototype-studio-observe-')), []);
});

test('プロジェクトが見つからないときと、画面幅の名前が正しくないときは、観察せずに 0 以外で終わる', async () => {
  const missing = await runCli(['no-such-project']);
  assert.equal(missing.code, 3);
  assert.match(missing.stderr, /プロジェクトが見つかりません: no-such-project/);
  const wrong = await runCli([JOB, '--viewports', 'watch']);
  assert.equal(wrong.code, 3);
  assert.match(wrong.stderr, /画面幅の名前が正しくありません: watch/);
  const none = await runCli([]);
  assert.equal(none.code, 3);
  assert.match(none.stderr, /使い方: npm run observe/);
});

test('データの置き場の外のフォルダーも、npm を呼んだフォルダー(INIT_CWD)からの相対パスで観察できる', async () => {
  const outside = path.join(home, 'elsewhere', 'my-draft');
  await fs.mkdir(path.join(outside, 'app'), { recursive: true });
  await fs.writeFile(path.join(outside, 'app', 'main.js'), 'const broken = ;\n');
  const result = await runCli(['my-draft/', '--viewports', 'mobile'], { INIT_CWD: path.dirname(outside) });
  assert.equal(result.code, 1, result.stdout + result.stderr);
  assert.equal(path.dirname(path.dirname(reportPathOf(result.stdout))), path.join(outside, '.studio', 'observations'));
});
