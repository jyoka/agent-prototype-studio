import { chromium } from 'playwright-core';

// 観察器のブラウザ。Playwright の Chromium だけを使う(docs/design/harness.md の 3.5)。
// 利用者の Chrome と Edge は探さない。だから launch に channel も executablePath も渡さない(ADR-0002)。
// launch はデバッグの口をパイプで開き、TCP のポートを開けない。プロフィールは毎回新しい一時のもの。

export const INSTALL_COMMAND = 'npm run install:chromium';

// 起動、文脈を開く、閉じる、の時間の上限
const LAUNCH_TIMEOUT_MS = 30_000;
const STEP_TIMEOUT_MS = 5_000;

export class BrowserUnavailableError extends Error {}

// 見つからないときも、起動に失敗したときも、入れ方を添える
export function unavailableReason(error) {
  const detail = String(error?.message ?? error).split('\n')[0].slice(0, 300);
  const missing = /Executable doesn't exist|Failed to launch|ENOENT/i.test(detail);
  // 最初の 1 文は利用者の画面(作る会話と結果の帯)に出るので、4 節の言葉で書く。2 文目からは開発者向けの詳細にだけ出る
  const lead = missing
    ? 'この PC には、試作品を開いて確かめるためのブラウザーが入っていません。'
    : '試作品を開いて確かめるためのブラウザーを起動できませんでした。';
  const head = missing
    ? '観察に使う Playwright の Chromium が見つかりません。'
    : '観察に使う Playwright の Chromium を起動できませんでした。';
  return `${lead}${head}Studio のフォルダーで \`${INSTALL_COMMAND}\` を実行して入れてから、もう一度試してください(${detail})`;
}

// 起動の引数。観察の文脈の context.route(observe.js)は、ページの要求しか断てない。
// DNS の先読みと WebRTC は route を通らないので、ブラウザ全体をここでしぼる(docs/adr/0002-observer-and-harness.md)。
// Playwright が付ける --disable-features を上書きしないように、--disable-features は使わない。
export const LAUNCH_ARGS = Object.freeze([
  // 名前の解決を loopback だけにする。Studio は 127.0.0.1、プレビューは localhost で開く。
  // ほかの名前と IP はすべて「見つからない」にするので、DNS に問い合わせず、接続もしない。
  // DNS の先読みもこの規則で止める。--dns-prefetch-disable は、手元の Playwright の Chromium のバイナリになかったので付けない
  '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1',
  // WebRTC は UDP を使わず、プロキシを通す TCP だけにする(STUN と TURN の UDP が出ない)
  '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
  // 行き止まりのプロキシ。上の WebRTC の決まりで、IP を直に書いた TURN の TCP もここへ向かって失敗する
  // (この引数がないと、IP を直に書いた TURN の TCP は名前の解決を通らずに届く)。
  // ページの要求は、プロキシで失敗した後も上の規則で解決しない(net log で確かめた)。
  // .invalid は解決されない名前(RFC 2606)で、上の規則でも解決しない。
  // loopback(Studio とプレビュー)へは、Chromium の既定でプロキシを通らずに届く
  '--proxy-server=http://observer-blocked.invalid:9',
]);

export function launchOptions() {
  return { headless: true, timeout: LAUNCH_TIMEOUT_MS, args: [...LAUNCH_ARGS] };
}

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve('timeout'), ms);
    }),
  ]);
}

// ブラウザは 1 つだけ起動して使い回し、観察ごとに新しい BrowserContext を作る。
// 同時に回す観察は 1 つまで。後から来た観察は、前の観察が終わるまで待つ。
export class ObserverBrowser {
  constructor({ launch = (options) => chromium.launch(options), stepTimeoutMs = STEP_TIMEOUT_MS } = {}) {
    this.launch = launch;
    this.stepTimeoutMs = stepTimeoutMs;
    this.browser = null;
    this.starting = null;
    this.queue = Promise.resolve();
    this.closed = false;
  }

  async ensureBrowser() {
    if (this.browser?.isConnected()) return this.browser;
    if (!this.starting) {
      this.starting = (async () => {
        try {
          const browser = await this.launch(launchOptions());
          browser.on('disconnected', () => {
            if (this.browser === browser) this.browser = null;
          });
          this.browser = browser;
          return browser;
        } catch (error) {
          throw new BrowserUnavailableError(unavailableReason(error), { cause: error });
        } finally {
          this.starting = null;
        }
      })();
    }
    return this.starting;
  }

  // work(context, browser) を、新しい文脈の中で 1 つずつ回す
  withContext(options, work) {
    const run = this.queue.then(async () => {
      if (this.closed) throw new BrowserUnavailableError('試作品を開いて確かめる仕組みは、もう止まっています');
      const browser = await this.ensureBrowser();
      const opening = browser.newContext(options);
      const context = await withTimeout(opening, this.stepTimeoutMs);
      if (context === 'timeout') {
        // 応答しないブラウザは止めて、次の観察で作り直す
        opening.then((late) => late.close()).catch(() => {});
        await this.restart();
        throw new Error('ブラウザが応答しません');
      }
      try {
        return await work(context, browser);
      } finally {
        // 応答しない試作品で閉じられないときは、ブラウザごと止めて次の観察で作り直す
        if ((await withTimeout(context.close().catch(() => {}), this.stepTimeoutMs)) === 'timeout') {
          await this.restart();
        }
      }
    });
    this.queue = run.catch(() => {});
    return run;
  }

  // 応答しないブラウザは、閉じ終わるのを待たずに手放す。次の観察は新しいブラウザを起動する。
  // 手放したブラウザは、Playwright が close の 30 秒後にプロセスグループごと強制終了する(ADR-0001 の T8)
  async restart() {
    const browser = this.browser;
    this.browser = null;
    if (browser) await withTimeout(browser.close().catch(() => {}), this.stepTimeoutMs);
  }

  async close() {
    this.closed = true;
    await this.queue;
    await this.restart();
  }

  // 動いている観察を待たずに止める(観察の道具のサーバーが中断されたとき)。動いている観察は、ブラウザが閉じて失敗で終わる。
  // 起動の途中なら、起動したらすぐ閉じる。この後の観察は断る
  async abort() {
    this.closed = true;
    this.starting?.then((browser) => browser.close()).catch(() => {});
    await this.restart();
  }
}
