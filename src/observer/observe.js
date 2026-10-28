import fs from 'node:fs/promises';
import path from 'node:path';
import { BrowserUnavailableError, ObserverBrowser } from './browser.js';

// 観察器(docs/design/harness.md の 3.1)。表示中のビルドをヘッドレスの Chromium で開き、
// 読み込み、エラー、スクリーンショット、合否を report で返す。
// import してよいのは、ビルドの結果、プレビューの配信、ブラウザの部品だけ(S2)。
// 作る AI、Studio の画面、版、会話の実装には依存しない。AI の要求は、呼ぶ側が渡す ai 関数に渡す。

export const REPORT_FORMAT = 'prototype-studio-observation';
export const REPORT_FORMAT_VERSION = 1;

export const VIEWPORTS = Object.freeze({
  mobile: Object.freeze({ width: 390, height: 844 }),
  tablet: Object.freeze({ width: 820, height: 1180 }),
  desktop: Object.freeze({ width: 1280, height: 800 }),
});

export const DEFAULT_LIMITS = Object.freeze({
  // 読み込みの時間切れ。無限ループなどで読み込みが終わらないときのエラー
  loadTimeoutMs: 15_000,
  // 読み込みの後、描画中の例外と遅れて出るエラーを待つ時間
  settleMs: 500,
  // 観察の全体の上限。null なら loadTimeoutMs + settleMs + 30 秒。超えたら文脈ごと閉じる(ADR-0001 の T8)
  observeTimeoutMs: null,
});

const HOST_TIMEOUT_MS = 10_000;
const SCREENSHOT_TIMEOUT_MS = 5_000;
// 画面幅を変えた後、iframe の中の描画が追いつくのを待つ時間
const VIEWPORT_SETTLE_MS = 150;
// 読み込みの時間切れの他に、観察の全体にかける時間の上限
const EXTRA_TIMEOUT_MS = 30_000;
const MAX_ERRORS = 50;
const MAX_MESSAGE = 1000;
const MAX_STACK = 4000;
const MAX_URL = 500;
const MAX_AI_REQUESTS = 50;
const MAX_AI_TEXT = 2000;
const MAX_AI_CHANGES = 20;
// report の ai に入れるやり取りの数(会話の始まりと、要求の上限の分)
const MAX_AI_ENTRIES = MAX_AI_REQUESTS + 1;
const MAX_PAGE_TEXT = 2000;
const PAGE_TIMEOUT_MS = 5_000;

// 親ページが Node に渡す知らせの種類と、report の errors の kind
const EVENT_KINDS = {
  'runtime-error': 'runtime',
  'unhandled-rejection': 'unhandled-rejection',
  'console-error': 'console-error',
};

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value, max) => String(value ?? '').slice(0, max);

// 試作品からの AI への要求の形を確かめる(Studio の画面と同じ決まり)
function validAiRequest(data) {
  if (!isPlainObject(data) || !Number.isSafeInteger(data.id)) return false;
  if (data.op === 'session') return true;
  if (data.op === 'send') return typeof data.text === 'string' && data.text.length <= MAX_AI_TEXT;
  if (data.op === 'correct') {
    if (!isPlainObject(data.changes)) return false;
    const entries = Object.entries(data.changes);
    return (
      entries.length > 0 &&
      entries.length <= MAX_AI_CHANGES &&
      entries.every(
        ([key, value]) =>
          key.length <= 64 && (value === null || Number.isFinite(value) || (typeof value === 'string' && value.length <= 200)),
      )
    );
  }
  return false;
}

function aiRequestOf(data) {
  if (data.op === 'send') return { op: 'send', text: data.text };
  if (data.op === 'correct') return { op: 'correct', changes: { ...data.changes } };
  return { op: 'session' };
}

function checkViewports(viewports) {
  if (!Array.isArray(viewports)) throw new TypeError('viewports は画面幅の名前の配列で渡してください');
  for (const name of viewports) {
    if (!Object.hasOwn(VIEWPORTS, name)) {
      throw new TypeError(`画面幅の名前が正しくありません: ${name}(${Object.keys(VIEWPORTS).join('、')} から選ぶ)`);
    }
  }
  return [...new Set(viewports)];
}

function emptyReport(build) {
  return {
    format: REPORT_FORMAT,
    formatVersion: REPORT_FORMAT_VERSION,
    buildId: build.result?.ok ? (build.result.buildId ?? null) : null,
    appDigest: build.result?.appDigest ?? null,
    startedAt: new Date().toISOString(),
    durationMs: null,
    browser: null,
    load: { done: false, durationMs: null, timeoutMs: null },
    errors: [],
    // 観察の中のプロダクト内 AI とのやり取り(ai.entries() が返す、AI の実行の記録と同じ形)
    ai: [],
    // シナリオ(jyoka/tasks#302)で埋める
    scenarios: [],
    // 最後の画面: { text, empty }。アクセシビリティの木の要約は jyoka/tasks#302 で足す
    page: null,
    screenshots: [],
    verdict: 'unverified',
    reason: null,
  };
}

function buildErrors(result) {
  const errors = Array.isArray(result?.errors) && result.errors.length > 0 ? result.errors : [{ file: 'app/', text: 'ビルドに失敗しました' }];
  const at = result?.finishedAt ?? new Date().toISOString();
  return errors.slice(0, MAX_ERRORS).map((error) => ({
    kind: 'build',
    message: text(error.text, MAX_MESSAGE),
    stack: '',
    file: error.file ?? null,
    line: error.line ?? null,
    column: error.column ?? null,
    at,
  }));
}

// 観察の文脈から出してよい要求: 観察用の親ページとその script(同じ名前の .js)、観察するビルドのファイル。
// Studio の API、他のプロジェクトと他の版、外部への要求は断つ(S8、S13)。CSP の前で断てないもの
// (frame-src が通す、プレビューの origin の中の他のプロジェクトへの移動など)もここで止まる
function requestFilter(build) {
  const host = new URL(build.hostUrl);
  const hostFiles = new Set([host.pathname, host.pathname.replace(/\.html$/, '.js')]);
  const preview = new URL(build.previewUrl);
  return (url) => {
    let target;
    try {
      target = new URL(url);
    } catch {
      return false;
    }
    if (target.origin === host.origin) return hostFiles.has(target.pathname);
    if (target.origin === preview.origin) return target.pathname.startsWith(preview.pathname);
    return false;
  };
}

function waitFor(promise, ms) {
  let timer;
  return Promise.race([
    promise.then(() => true),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(false), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class StepTimeoutError extends Error {}

// 試作品の iframe の中で動かす。文字がなく、大きさのある要素もなければ、空の画面とみなす
function readPage(max) {
  const body = document.body;
  if (!body) return { text: '', empty: true };
  const shown = String(body.innerText ?? '').replace(/\s+/g, ' ').trim();
  const skip = new Set(['SCRIPT', 'STYLE', 'LINK', 'META', 'TEMPLATE', 'NOSCRIPT']);
  let sized = false;
  for (const element of body.querySelectorAll('*')) {
    if (skip.has(element.tagName) || element.id === 'root') continue;
    const rect = element.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      sized = true;
      break;
    }
  }
  return { text: shown.slice(0, max), empty: shown === '' && !sized };
}

// 呼ぶ側の ai 関数が entries() を持っていれば、観察の中のやり取りを report に入れる
function aiEntries(ai) {
  if (typeof ai?.entries !== 'function') return [];
  try {
    const entries = ai.entries();
    return Array.isArray(entries) ? structuredClone(entries.slice(0, MAX_AI_ENTRIES)) : [];
  } catch {
    return [];
  }
}

// プレビューの配信が、そのビルドを今も返すか
async function previewStatus(url) {
  try {
    const response = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(3_000) });
    return response.status;
  } catch {
    return null;
  }
}

function checkLimits(limits) {
  if (!isPlainObject(limits)) throw new TypeError('limits はオブジェクトで渡してください');
  const limit = { ...DEFAULT_LIMITS };
  for (const [key, value] of Object.entries(limits)) {
    if (!Object.hasOwn(DEFAULT_LIMITS, key)) throw new TypeError(`limits の名前が正しくありません: ${key}`);
    if (value === undefined) continue;
    if (!Number.isFinite(value) || value < 0 || value > 10 * 60_000) {
      throw new TypeError(`limits.${key} は 0 から 600000 のミリ秒で渡してください(今の値: ${value})`);
    }
    limit[key] = value;
  }
  return limit;
}

// 試作品が止まると、ブラウザの操作が返らないことがある。どの操作にも時間の上限を付ける
async function within(promise, ms, message) {
  promise.catch(() => {});
  if (!(await waitFor(promise, ms))) throw new StepTimeoutError(message);
  return promise;
}

export class Observer {
  constructor({ browser = new ObserverBrowser() } = {}) {
    this.browser = browser;
  }

  // build:     { result, previewUrl, hostUrl }
  //            result は buildApp() の結果。previewUrl は表示中のビルドの URL(プレビューの配信)、
  //            hostUrl は観察用の親ページの URL(Studio の origin の /observe.html)
  // scenarios: 回すシナリオ(jyoka/tasks#302 で回す。今は受け取るだけ)
  // viewports: スクリーンショットを撮る画面幅の名前(mobile、tablet、desktop)
  // ai:        試作品からの AI の要求({ op, text?, changes? })に session を返す関数。なければ断る。
  //            ai.entries() があれば、観察の中のやり取りとして report の ai に入れる
  // limits:    時間の上限(DEFAULT_LIMITS)
  // outDir:    スクリーンショットを置くフォルダー
  async observe({ build, scenarios = [], viewports = ['desktop'], ai = null, limits = {}, outDir = null } = {}) {
    if (!isPlainObject(build)) throw new TypeError('build を渡してください');
    if (!Array.isArray(scenarios)) throw new TypeError('scenarios は配列で渡してください');
    const names = checkViewports(viewports);
    const limit = checkLimits(limits);
    const started = Date.now();
    const report = emptyReport(build);
    const finish = () => {
      report.ai = aiEntries(ai);
      report.durationMs = Date.now() - started;
      return report;
    };

    // ビルドに失敗していれば、ブラウザがなくても失敗と分かる
    if (!build.result?.ok) {
      report.errors = buildErrors(build.result);
      report.verdict = 'failed';
      return finish();
    }

    if (names.length > 0 && !outDir) throw new TypeError('スクリーンショットを置く outDir を渡してください');
    const first = VIEWPORTS[names[0] ?? 'desktop'];
    const observeTimeoutMs = limit.observeTimeoutMs ?? limit.loadTimeoutMs + limit.settleMs + EXTRA_TIMEOUT_MS;
    // 時間を超えて返った操作が、返した後の report を書き換えないように、写しに書く
    const draft = structuredClone(report);
    try {
      // service worker の要求は route を通らないので、使わせない。ダウンロードも受けない
      const options = { viewport: { ...first }, serviceWorkers: 'block', acceptDownloads: false };
      await this.browser.withContext(options, (context, browser) =>
        within(
          this.run({ context, browser, build, names, ai, limit, outDir, report: draft }),
          observeTimeoutMs,
          '観察が時間内に終わりませんでした',
        ),
      );
    } catch (error) {
      // 時間切れまでに分かったこと(読み込み、エラー)は残す
      Object.assign(report, structuredClone(draft));
      report.verdict = 'unverified';
      report.reason =
        error instanceof BrowserUnavailableError ? error.message : `観察の途中で問題が起きました: ${text(error?.message ?? error, 300)}`;
      return finish();
    }
    Object.assign(report, structuredClone(draft));
    if (report.reason) {
      report.verdict = 'unverified';
    } else {
      report.verdict = report.load.done && report.errors.length === 0 ? 'passed' : 'failed';
    }
    return finish();
  }

  async run({ context, browser, build, names, ai, limit, outDir, report }) {
    report.browser = { name: 'chromium', version: browser.version() };
    report.load.timeoutMs = limit.loadTimeoutMs;
    const addError = (kind, message, stack = '', extra = {}) => {
      if (report.errors.length >= MAX_ERRORS) return;
      report.errors.push({ kind, message: text(message, MAX_MESSAGE), stack: text(stack, MAX_STACK), ...extra, at: new Date().toISOString() });
    };
    // 断った要求は errors に残す。blockedBy は断ったもの(route は観察器、csp は試作品の CSP)
    const addBlocked = (url, blockedBy) => {
      const message =
        blockedBy === 'route'
          ? `試作品が観察するビルドの外へ要求を出したので、断ちました: ${url}`
          : `試作品の CSP が要求を断ちました: ${url}`;
      addError('blocked-request', message, '', { url: text(url, MAX_URL), blockedBy });
    };

    // ページを開く前に、文脈のすべての要求(iframe の中も)を調べる
    const allowed = requestFilter(build);
    await context.route('**/*', (route) => {
      const url = route.request().url();
      if (allowed(url)) return route.continue().catch(() => {});
      addBlocked(url, 'route');
      return route.abort('blockedbyclient').catch(() => {});
    });
    // CSP が断った要求は route に届かない。ブラウザが知らせる失敗から拾う(fetch など、要求にならないものは拾えない)
    context.on('requestfailed', (request) => {
      if (request.failure()?.errorText === 'csp') addBlocked(request.url(), 'csp');
    });

    const page = await context.newPage();
    const fromHost = (source) => source.page === page && source.frame === page.mainFrame();

    let onLoad;
    const loaded = new Promise((resolve) => {
      onLoad = resolve;
    });
    let loadStarted = null;
    let frameLoaded = false;

    // binding は文脈のすべての frame に入る。試作品の iframe から直接呼ばれたものは受けない
    await context.exposeBinding('studioObserveEvent', (source, data) => {
      if (!fromHost(source) || !isPlainObject(data)) return;
      if (data.type === 'load') {
        if (report.load.durationMs === null && loadStarted !== null) {
          report.load.done = true;
          report.load.durationMs = Date.now() - loadStarted;
          onLoad();
        }
        return;
      }
      if (data.type === 'frame-load') {
        frameLoaded = true;
        return;
      }
      if (data.type === 'navigated') {
        addError('runtime', '試作品が別のページへ移動しようとしました。試作品は Studio の外へ移動できません');
        return;
      }
      if (Object.hasOwn(EVENT_KINDS, data.type) && typeof data.message === 'string') {
        addError(EVENT_KINDS[data.type], data.message, typeof data.stack === 'string' ? data.stack : '');
      }
    });

    let aiCount = 0;
    await context.exposeBinding('studioObserveAi', async (source, data) => {
      if (!fromHost(source)) return { ok: false, error: { code: 'invalid', message: 'この要求は受け付けません' } };
      if (!validAiRequest(data)) return { ok: false, error: { code: 'invalid', message: 'AI への要求の形が正しくありません' } };
      if (typeof ai !== 'function') return { ok: false, error: { code: 'no-ai', message: 'この観察では AI を使えません' } };
      aiCount += 1;
      if (aiCount > MAX_AI_REQUESTS) return { ok: false, error: { code: 'rate', message: 'AI への要求が多すぎます' } };
      try {
        return { ok: true, session: await ai(aiRequestOf(data)) };
      } catch (error) {
        return { ok: false, error: { code: text(error?.code ?? 'internal', 64), message: text(error?.message ?? error, MAX_MESSAGE) } };
      }
    });

    // pageerror は iframe の中のエラーも含むので使わない。エラーは親ページから受け取る。
    // ページが落ちたときは、試作品の失敗ではなく、観察できなかったこととして扱う
    page.on('crash', () => {
      report.reason ??= 'ブラウザのページが落ちました';
    });

    const response = await page.goto(build.hostUrl, { timeout: HOST_TIMEOUT_MS });
    if (!response?.ok()) throw new Error(`観察用の親ページを開けません(${response?.status() ?? '応答なし'})`);
    loadStarted = Date.now();
    await page.evaluate((url) => window.studioObserveHost.open(url), build.previewUrl);

    if (!(await waitFor(loaded, limit.loadTimeoutMs))) {
      // ページは開いたのに runtime から合図がない。ビルドが消えたか、試作品が別のページへ移ったか、止まっている
      if (frameLoaded) {
        const status = await previewStatus(build.previewUrl);
        if (status !== 200) {
          report.reason = `試作品のビルドを開けませんでした(${status ?? '応答なし'})。観察の間に作り直されたかもしれません。もう一度観察してください`;
          return;
        }
        const frameUrl = page.mainFrame().childFrames()[0]?.url();
        if (frameUrl && frameUrl !== build.previewUrl) {
          addError('runtime', '試作品が読み込みの途中で別のページへ移動しました。試作品は表示中のビルドの外へ移動できません');
          return;
        }
      }
      addError('timeout', `${Math.round(limit.loadTimeoutMs / 1000)} 秒で読み込みが終わりませんでした。無限ループや重い処理がないか確かめてください`);
      return;
    }
    await delay(limit.settleMs);
    if (report.reason) return;

    if (names.length > 0) await fs.mkdir(outDir, { recursive: true });
    for (const name of names) {
      const size = VIEWPORTS[name];
      const file = path.join(outDir, `${name}.png`);
      try {
        await within(page.setViewportSize({ ...size }), SCREENSHOT_TIMEOUT_MS, '画面幅を変えられません');
        // 試作品が止まっていると requestAnimationFrame も返らないので、時間で待つ
        await delay(VIEWPORT_SETTLE_MS);
        await page.screenshot({ path: file, timeout: SCREENSHOT_TIMEOUT_MS });
      } catch (error) {
        if (!(error instanceof StepTimeoutError || error?.name === 'TimeoutError')) throw error;
        addError('timeout', `${name} の画面を撮れませんでした。試作品が応答していません。読み込みの後に無限ループや重い処理がないか確かめてください`);
        return;
      }
      report.screenshots.push({ name, viewport: name, width: size.width, height: size.height, file });
    }

    // 最後の画面の文字と、空でないか(関門 G5 が見る)
    const frame = page.mainFrame().childFrames()[0];
    if (!frame) return;
    try {
      const read = await within(frame.evaluate(readPage, MAX_PAGE_TEXT), PAGE_TIMEOUT_MS, '画面を読めません');
      // 試作品の中で作った値なので、決まった形に写す
      report.page = { text: text(read?.text, MAX_PAGE_TEXT), empty: read?.empty === true };
    } catch (error) {
      // 読めなかったときは page を null のままにする(空かどうかは分からない)
      if (error instanceof StepTimeoutError) {
        addError('timeout', '画面の中身を読めませんでした。試作品が応答していません。読み込みの後に無限ループや重い処理がないか確かめてください');
      }
    }
  }

  close() {
    return this.browser.close();
  }
}
