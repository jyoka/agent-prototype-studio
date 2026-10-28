import fs from 'node:fs/promises';
import path from 'node:path';
import { BrowserUnavailableError, ObserverBrowser } from './browser.js';
import { Operations, StepFailure, VIEWPORTS, VIEWPORT_SETTLE_MS } from './operations.js';
import { SCENARIO_LIMITS, baseScenarios, checkScenario } from './scenario.js';

// 観察器(docs/design/harness.md の 3.1)。表示中のビルドをヘッドレスの Chromium で開き、
// 読み込み、エラー、スクリーンショット、シナリオ、最後の画面、合否を report で返す。
// import してよいのは、ビルドの結果、プレビューの配信、ブラウザの部品だけ(S2)。
// 作る AI、Studio の画面、版、会話の実装には依存しない。AI の要求は、呼ぶ側が渡す ai 関数に渡す。

export const REPORT_FORMAT = 'prototype-studio-observation';
export const REPORT_FORMAT_VERSION = 1;

export { VIEWPORTS };

export const DEFAULT_LIMITS = Object.freeze({
  // 読み込みの時間切れ。無限ループなどで読み込みが終わらないときのエラー
  loadTimeoutMs: 15_000,
  // 読み込みの後、描画中の例外と遅れて出るエラーを待つ時間
  settleMs: 500,
  // シナリオの 1 つの手順(操作と確かめ)にかける時間
  stepTimeoutMs: 5_000,
  // シナリオ 1 本にかける時間(harness.md 2.2)
  scenarioTimeoutMs: 60_000,
});

const HOST_TIMEOUT_MS = 10_000;
const SCREENSHOT_TIMEOUT_MS = 5_000;
// 読み込みの時間切れの他に、観察の全体にかける時間の上限
const EXTRA_TIMEOUT_MS = 30_000;
const MAX_ERRORS = 50;
const MAX_MESSAGE = 1000;
const MAX_STACK = 4000;
const MAX_AI_REQUESTS = 50;
const MAX_AI_TEXT = 2000;
const MAX_AI_CHANGES = 20;
// report の ai に入れるやり取りの数(会話の始まりと、要求の上限の分)
const MAX_AI_ENTRIES = MAX_AI_REQUESTS + 1;

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
    // シナリオごとの合否、手順ごとの結果、失敗した手順とそのときのスクリーンショット
    scenarios: [],
    // 最後の画面の文字と、アクセシビリティの木の要約(operations.js の read)
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

// observe() に渡されたシナリオを、回す形にそろえる。形の誤りは回さずに、failed の結果にする
function planOf(item) {
  const loaded = isPlainObject(item) && Object.hasOwn(item, 'file');
  const file = loaded ? (item.file ?? null) : null;
  if (loaded && Array.isArray(item.errors) && item.errors.length > 0) return { base: false, file, scenario: null, errors: item.errors };
  const checked = checkScenario(loaded ? item.scenario : item, { file });
  return { base: false, file, scenario: checked.scenario, errors: checked.errors };
}

const failureText = (error) => (error instanceof StepFailure || error instanceof StepTimeoutError ? error.message : `手順の途中で問題が起きました: ${text(error?.message ?? error, 300)}`);

// シナリオ 1 本を回し、手順ごとの結果を返す。失敗した手順で止め、そのときの画面を撮る
async function runScenario({ ops, item, index, limit, stop }) {
  const started = Date.now();
  const scenario = item.scenario;
  const entry = {
    name: scenario?.name ?? item.errors[0]?.scenario ?? item.file ?? `${index + 1} 本目のシナリオ`,
    base: item.base,
    file: item.file,
    viewport: scenario?.viewport ?? null,
    verdict: 'failed',
    durationMs: 0,
    steps: [],
    failed: null,
    problems: structuredClone(item.errors),
  };
  if (!scenario) {
    // 形の誤り。どの手順がどう違うかを problems に入れ、回さない
    entry.failed = { step: item.errors[0]?.step ?? null, message: item.errors.map((e) => e.text).join(' / ').slice(0, MAX_MESSAGE), screenshot: null };
    return entry;
  }
  entry.steps = scenario.steps.map((step, i) => ({ n: i + 1, step: structuredClone(step), status: 'skipped', durationMs: null, result: null, message: null }));
  const prefix = `scenario-${index + 1}`;
  let current = null;
  let cancelled = false;
  const work = (async () => {
    await ops.viewport(scenario.viewport);
    for (const [i, step] of scenario.steps.entries()) {
      if (stop.stopped || cancelled) return;
      current = entry.steps[i];
      const at = Date.now();
      try {
        current.result = structuredClone((await ops.step(step, { file: `${prefix}-step-${i + 1}.png` })) ?? null);
        current.status = 'passed';
      } finally {
        current.durationMs = Date.now() - at;
      }
    }
  })();
  try {
    await within(work, limit.scenarioTimeoutMs, `シナリオが ${Math.round(limit.scenarioTimeoutMs / 1000)} 秒で終わりませんでした`);
    entry.verdict = 'passed';
  } catch (error) {
    cancelled = true;
    if (current && current.status !== 'passed') current.status = 'failed';
    const message = failureText(error);
    if (current?.status === 'failed') current.message = message;
    let screenshot = null;
    if (!stop.stopped) screenshot = await ops.screenshot('失敗したとき', { file: `${prefix}-failed.png` }).catch(() => null);
    entry.failed = { step: current?.status === 'failed' ? current.n : null, message, screenshot };
  }
  entry.durationMs = Date.now() - started;
  return entry;
}

export class Observer {
  constructor({ browser = new ObserverBrowser() } = {}) {
    this.browser = browser;
  }

  // build:     { result, previewUrl, hostUrl }
  //            result は buildApp() の結果。previewUrl は表示中のビルドの URL(プレビューの配信)、
  //            hostUrl は観察用の親ページの URL(Studio の origin の /observe.html)
  // scenarios: 回すシナリオ。シナリオの形(scenario.js)そのものか、readScenarios() が返す
  //            { file, scenario } か { file, errors }。Studio の基本のシナリオは、渡さなくても先に回す
  // viewports: スクリーンショットを撮る画面幅の名前(mobile、tablet、desktop)
  // ai:        試作品からの AI の要求({ op, text?, changes? })に session を返す関数。なければ断る。
  //            ai.entries() があれば、観察の中のやり取りとして report の ai に入れる。
  //            ai.state() があれば、確かめ aiState でプロダクト内 AI の状態を読む
  // operate:   シナリオの後に、7 つの操作(Operations)を 1 つずつ呼ぶ関数(ops) => Promise。
  //            時間の上限はシナリオ 1 本と同じ
  // limits:    時間の上限(DEFAULT_LIMITS)
  // outDir:    スクリーンショットを置くフォルダー
  async observe({ build, scenarios = [], viewports = ['desktop'], ai = null, operate = null, limits = {}, outDir = null } = {}) {
    if (!isPlainObject(build)) throw new TypeError('build を渡してください');
    if (!Array.isArray(scenarios)) throw new TypeError('scenarios は配列で渡してください');
    if (scenarios.length > SCENARIO_LIMITS.maxScenarios) throw new TypeError(`シナリオは ${SCENARIO_LIMITS.maxScenarios} 本までです`);
    if (operate !== null && typeof operate !== 'function') throw new TypeError('operate は関数で渡してください');
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
    // 基本のシナリオは Studio のコードの中にあり、呼ぶ側が渡すシナリオより先に回す
    const plan = [...baseScenarios({ greeting: build.result.ai?.mock?.greeting }).map((scenario) => ({ base: true, file: null, scenario, errors: [] })), ...scenarios.map(planOf)];
    const scenarioBudget = (plan.length + (operate ? 1 : 0)) * (limit.scenarioTimeoutMs + SCREENSHOT_TIMEOUT_MS);
    // 時間を超えて返った操作が、返した後の report を書き換えないように、写しに書く
    const draft = structuredClone(report);
    const stop = { stopped: false };
    try {
      await this.browser.withContext({ viewport: { ...first } }, (context, browser) =>
        within(
          this.run({ context, browser, build, names, plan, ai, operate, limit, outDir, stop, report: draft }),
          limit.loadTimeoutMs + limit.settleMs + EXTRA_TIMEOUT_MS + scenarioBudget,
          '観察が時間内に終わりませんでした',
        ).finally(() => {
          stop.stopped = true;
        }),
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
      const scenariosPassed = report.scenarios.every((scenario) => scenario.verdict === 'passed');
      report.verdict = report.load.done && report.errors.length === 0 && scenariosPassed ? 'passed' : 'failed';
    }
    return finish();
  }

  async run({ context, browser, build, names, plan, ai, operate, limit, outDir, stop, report }) {
    report.browser = { name: 'chromium', version: browser.version() };
    report.load.timeoutMs = limit.loadTimeoutMs;
    const page = await context.newPage();
    const fromHost = (source) => source.page === page && source.frame === page.mainFrame();

    const addError = (kind, message, stack = '') => {
      if (report.errors.length >= MAX_ERRORS) return;
      report.errors.push({ kind, message: text(message, MAX_MESSAGE), stack: text(stack, MAX_STACK), at: new Date().toISOString() });
    };

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

    // シナリオを手順どおりに回す。7 つの操作は、シナリオの手順と operate で同じ関数を使う
    const ops = new Operations({ page, errors: () => report.errors, ai, outDir, stepTimeoutMs: limit.stepTimeoutMs });
    ops.viewportName = names.at(-1) ?? 'desktop';
    for (const [index, item] of plan.entries()) {
      if (stop.stopped || report.reason) return;
      report.scenarios.push(await runScenario({ ops, item, index, limit, stop }));
    }
    if (operate && !stop.stopped && !report.reason) {
      await within(Promise.resolve(operate(ops)), limit.scenarioTimeoutMs, 'operate が時間内に終わりませんでした');
    }
    // 最後の画面の文字と、アクセシビリティの木の要約。止まった試作品では読めないので空のまま
    if (stop.stopped || report.reason) return;
    report.page = await ops.read().catch(() => null);
  }

  close() {
    return this.browser.close();
  }
}
