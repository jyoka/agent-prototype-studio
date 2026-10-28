import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { INSTALL_COMMAND, LAUNCH_ARGS, launchOptions, ObserverBrowser } from '../../src/observer/browser.js';
import { Observer } from '../../src/observer/observe.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OK_BUILD = {
  result: { ok: true, buildId: 'a'.repeat(32), appDigest: 'b'.repeat(64), errors: [] },
  previewUrl: 'http://localhost:1/p/demo/x/',
  hostUrl: 'http://127.0.0.1:2/observe.html',
};

// 本物の代わりに、起動の引数と同時に開いた文脈の数を数える
function fakeLaunch() {
  const calls = [];
  let open = 0;
  let maxOpen = 0;
  const launch = async (options) => {
    calls.push(options);
    return {
      isConnected: () => true,
      on() {},
      version: () => '1.0',
      async close() {},
      async newContext() {
        open += 1;
        maxOpen = Math.max(maxOpen, open);
        return {
          async close() {
            open -= 1;
          },
        };
      },
    };
  };
  return { launch, calls, maxOpen: () => maxOpen };
}

test('起動に channel も executablePath も渡さない(利用者の Chrome と Edge を使わない)', async () => {
  assert.deepEqual(Object.keys(launchOptions()).sort(), ['args', 'headless', 'timeout']);
  assert.equal(launchOptions().headless, true);
  const fake = fakeLaunch();
  const browser = new ObserverBrowser({ launch: fake.launch });
  await browser.withContext({}, async () => {});
  assert.equal(fake.calls.length, 1);
  assert.equal('channel' in fake.calls[0], false);
  assert.equal('executablePath' in fake.calls[0], false);
  // 観察器のファイルに、Chrome と Edge の channel の名前がない
  for (const file of ['browser.js', 'observe.js']) {
    const source = await fs.readFile(path.join(ROOT, 'src', 'observer', file), 'utf8');
    assert.doesNotMatch(source, /channel\s*:|msedge|chrome-beta|executablePath\s*:/, file);
  }
});

test('起動の引数で、名前の解決を loopback だけにし、DNS の先読みと WebRTC の UDP を止める(ADR-0002)', () => {
  const { args } = launchOptions();
  assert.deepEqual(args, [...LAUNCH_ARGS]);
  assert.ok(args.includes('--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1'));
  assert.ok(args.includes('--force-webrtc-ip-handling-policy=disable_non_proxied_udp'));
  // 行き止まりのプロキシは、解決されない名前(.invalid)にする
  const proxy = args.find((arg) => arg.startsWith('--proxy-server='));
  assert.match(new URL(proxy.slice('--proxy-server='.length)).hostname, /\.invalid$/);
  // Playwright が付ける --disable-features を上書きしない。デバッグの口は Playwright のパイプのまま
  assert.equal(args.some((arg) => /^--(disable-features|remote-debugging-port|proxy-bypass-list)/.test(arg)), false);
  // 呼ぶたびに新しい配列を返す(呼ぶ側が書き換えても次の起動に響かない)
  assert.notEqual(launchOptions().args, launchOptions().args);
});

test('ブラウザは 1 回だけ起動して使い回し、文脈は 1 つずつ開く', async () => {
  const fake = fakeLaunch();
  const browser = new ObserverBrowser({ launch: fake.launch });
  const slow = () => new Promise((resolve) => setTimeout(resolve, 20));
  await Promise.all([browser.withContext({}, slow), browser.withContext({}, slow), browser.withContext({}, slow)]);
  assert.equal(fake.calls.length, 1);
  assert.equal(fake.maxOpen(), 1);
  await browser.close();
});

test('起動できなければ unverified と、入れ方を含む理由を返す(通ったとは返さない)', async () => {
  const launch = async () => {
    throw new Error("browserType.launch: Executable doesn't exist at /tmp/none/chrome-headless-shell\n╔═══╗");
  };
  const observer = new Observer({ browser: new ObserverBrowser({ launch }) });
  const report = await observer.observe({ build: OK_BUILD, viewports: [] });
  assert.equal(report.verdict, 'unverified');
  assert.match(report.reason, /Playwright の Chromium が見つかりません/);
  assert.ok(report.reason.includes(INSTALL_COMMAND));
  assert.equal(report.buildId, OK_BUILD.result.buildId);
  assert.equal(report.browser, null);
  assert.deepEqual(report.errors, []);
});

test('Playwright の Chromium が入っていない PC では unverified と入れ方を返す(本物の playwright-core)', async () => {
  // ブラウザの置き場を空のフォルダーにして、入っていない PC と同じにする
  const empty = await fs.mkdtemp(path.join(os.tmpdir(), 'prototype-studio-no-browser-'));
  try {
    const script = [
      "import { Observer } from './src/observer/observe.js';",
      'const observer = new Observer();',
      `const report = await observer.observe({ build: ${JSON.stringify(OK_BUILD)}, viewports: [] });`,
      'await observer.close();',
      'console.log(JSON.stringify(report));',
    ].join('\n');
    const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script], {
      cwd: ROOT,
      env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: empty },
      timeout: 30_000,
    });
    const report = JSON.parse(stdout);
    assert.equal(report.verdict, 'unverified');
    assert.match(report.reason, /見つかりません/);
    assert.ok(report.reason.includes(`\`${INSTALL_COMMAND}\``));
  } finally {
    await fs.rm(empty, { recursive: true, force: true });
  }
});

test('入れ方の npm のスクリプトは、Playwright の Chromium を入れる', async () => {
  const pkg = JSON.parse(await fs.readFile(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(INSTALL_COMMAND, 'npm run install:chromium');
  assert.match(pkg.scripts['install:chromium'], /^playwright-core install .*chromium$/);
  assert.equal(pkg.dependencies['playwright-core'], pkg.devDependencies['@playwright/test']);
});

test('ビルドに失敗していれば、ブラウザを起動せずに failed を返す', async () => {
  const fake = fakeLaunch();
  const observer = new Observer({ browser: new ObserverBrowser({ launch: fake.launch }) });
  const report = await observer.observe({
    build: { result: { ok: false, appDigest: 'c'.repeat(64), errors: [{ file: 'app/main.jsx', line: 3, column: 1, text: '閉じかっこがありません' }] } },
  });
  assert.equal(report.verdict, 'failed');
  assert.equal(fake.calls.length, 0);
  assert.deepEqual(
    report.errors.map(({ kind, file, line, message }) => ({ kind, file, line, message })),
    [{ kind: 'build', file: 'app/main.jsx', line: 3, message: '閉じかっこがありません' }],
  );
});

test('知らない画面幅の名前は断る', async () => {
  const observer = new Observer({ browser: new ObserverBrowser({ launch: fakeLaunch().launch }) });
  await assert.rejects(observer.observe({ build: OK_BUILD, viewports: ['watch'] }), /画面幅の名前が正しくありません/);
});

test('文脈を開けない、閉じられないブラウザは止めて、次の観察で起動し直す', async () => {
  const launched = [];
  const launch = async () => {
    const index = launched.length;
    const browser = {
      closed: false,
      isConnected: () => !browser.closed,
      on() {},
      version: () => '1.0',
      async close() {
        browser.closed = true;
      },
      // 1 つ目のブラウザは文脈を開いたまま返さない。2 つ目は閉じる操作が返らない
      newContext: () => (index === 0 ? new Promise(() => {}) : Promise.resolve({ close: () => new Promise(() => {}) })),
    };
    launched.push(browser);
    return browser;
  };
  const browser = new ObserverBrowser({ launch, stepTimeoutMs: 50 });
  await assert.rejects(browser.withContext({}, async () => 'ok'), /ブラウザが応答しません/);
  assert.equal(launched[0].closed, true);
  assert.equal(await browser.withContext({}, async () => 'ok'), 'ok');
  assert.equal(launched.length, 2);
  assert.equal(launched[1].closed, true);
  assert.equal(browser.browser, null);
});

test('止めた後に待っていた観察は、unverified を返す', async () => {
  const fake = fakeLaunch();
  const browser = new ObserverBrowser({ launch: fake.launch });
  const observer = new Observer({ browser });
  let started;
  const running = new Promise((resolve) => {
    started = resolve;
  });
  const first = browser.withContext({}, () => {
    started();
    return new Promise((resolve) => setTimeout(() => resolve('done'), 30));
  });
  const waiting = observer.observe({ build: OK_BUILD, viewports: [] });
  await running;
  // 動いている観察は終わるまで待ち、待っていた観察は回さない
  await observer.close();
  assert.equal(await first, 'done');
  const report = await waiting;
  assert.equal(report.verdict, 'unverified');
  assert.match(report.reason, /もう止まっています/);
});

test('時間の上限は、正しい名前と値だけを受ける', async () => {
  const observer = new Observer({ browser: new ObserverBrowser({ launch: fakeLaunch().launch }) });
  for (const limits of [{ loadTimeoutMs: Number.NaN }, { loadTimeoutMs: -1 }, { loadTimeoutMs: '15000' }, { totalMs: 1 }, { observeTimeoutMs: null }]) {
    await assert.rejects(observer.observe({ build: OK_BUILD, viewports: [], limits }), /limits/, JSON.stringify(limits));
  }
});

// 閉じたかを覚えるブラウザ
function closableBrowser() {
  const browser = {
    closed: false,
    isConnected: () => !browser.closed,
    on() {},
    version: () => '1.0',
    async close() {
      browser.closed = true;
    },
    newContext: async () => ({ async close() {} }),
  };
  return browser;
}

test('abort は動いている観察を待たずにブラウザを閉じ、起動の途中なら起動したらすぐ閉じる', async () => {
  // 起動の途中で止める: 起動が終わったブラウザはすぐ閉じ、この後の観察は断る
  let finishLaunch;
  const late = closableBrowser();
  const starting = new ObserverBrowser({ launch: () => new Promise((resolve) => (finishLaunch = () => resolve(late))) });
  const waiting = starting.withContext({}, async () => 'ran');
  await new Promise((resolve) => setImmediate(resolve));
  const aborted = starting.abort();
  finishLaunch();
  await aborted;
  await waiting.catch(() => {});
  assert.equal(late.closed, true);
  await assert.rejects(starting.withContext({}, async () => 'ran'), /もう止まっています/);

  // 観察の途中で止める: 観察が終わるのを待たずに閉じる
  const open = closableBrowser();
  const running = new ObserverBrowser({ launch: async () => open });
  let entered;
  const inside = new Promise((resolve) => (entered = resolve));
  const work = running.withContext({}, () => {
    entered();
    return new Promise(() => {});
  });
  work.catch(() => {});
  await inside;
  await running.abort();
  assert.equal(open.closed, true);
});
