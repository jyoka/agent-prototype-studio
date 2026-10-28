import { chromium } from 'playwright-core';

// 観察器のブラウザ。Playwright の Chromium だけを使う(docs/design/harness.md の 3.5)。
// 利用者の Chrome と Edge は探さない。だから launch に channel も executablePath も渡さない。
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
  const head = missing
    ? '観察に使う Playwright の Chromium が見つかりません。'
    : '観察に使う Playwright の Chromium を起動できませんでした。';
  return `${head}Studio のフォルダーで \`${INSTALL_COMMAND}\` を実行して入れてから、もう一度試してください(${detail})`;
}

export function launchOptions() {
  return { headless: true, timeout: LAUNCH_TIMEOUT_MS };
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
      if (this.closed) throw new BrowserUnavailableError('観察器はもう止まっています');
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
}
