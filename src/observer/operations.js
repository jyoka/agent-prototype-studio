import fs from 'node:fs/promises';
import path from 'node:path';

// 観察器の 7 つの操作と 4 つの確かめ(docs/design/harness.md の 3.3、S4)。
// 1 つの観察の文脈(開いた試作品のページ)の中で、順に呼ぶ。シナリオの手順(step)からも、
// 1 つずつの呼び出し(作る AI の観察の道具、jyoka/tasks#311)からも、同じ関数を使う。
// 対象は役割と名前、ラベル、文字、領域で指す。CSS のセレクターは受け取らない。

export const VIEWPORTS = Object.freeze({
  mobile: Object.freeze({ width: 390, height: 844 }),
  tablet: Object.freeze({ width: 820, height: 1180 }),
  desktop: Object.freeze({ width: 1280, height: 800 }),
});

// report の page と read の結果の長さ。作る AI に文で渡せる長さに切る
export const PAGE_LIMITS = Object.freeze({ maxText: 3000, maxTree: 5000 });

// 画面幅を変えた後、iframe の中の描画が追いつくのを待つ時間
export const VIEWPORT_SETTLE_MS = 150;
const SCREENSHOT_TIMEOUT_MS = 5_000;
const POLL_MS = 100;
const MAX_ELEMENTS = 50;
const MAX_ELEMENT_TEXT = 200;
// inspect で対象を指さないときに一覧にする、操作できる要素の役割
const INTERACTIVE_ROLES = ['button', 'link', 'textbox', 'searchbox', 'combobox', 'listbox', 'checkbox', 'radio', 'switch', 'slider', 'spinbutton', 'tab', 'menuitem'];

// 手順の失敗。message は利用者と作る AI に見せる文
export class StepFailure extends Error {}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const squash = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
const cut = (value, max) => (value.length > max ? { text: value.slice(0, max), truncated: true } : { text: value, truncated: false });
const isTimeout = (error) => error?.name === 'TimeoutError';

// 人が読む対象の書き方
export function describeTarget(target) {
  if (!target) return '画面全体';
  if (target.role) return target.name ? `役割 ${target.role}、名前「${target.name}」` : `役割 ${target.role}`;
  if (target.label) return `ラベル「${target.label}」`;
  if (target.text) return `文字「${target.text}」`;
  if (target.region) return `領域「${target.region}」`;
  return JSON.stringify(target);
}

// ariaSnapshot の 1 行目(`- button "送る" [disabled]`)から、役割と名前を読む
function roleAndName(snapshot) {
  const match = /^- ([a-z]+)(?: "((?:[^"\\]|\\.)*)")?/.exec(snapshot ?? '');
  if (!match) return { role: null, name: '' };
  return { role: match[1], name: (match[2] ?? '').replace(/\\(.)/g, '$1') };
}

// 時間内に条件がそろうまで、繰り返し確かめる。check は { ok, detail } を返す
async function poll(check, timeoutMs) {
  const end = Date.now() + timeoutMs;
  let last;
  for (;;) {
    last = await check();
    if (last.ok || Date.now() >= end) return last;
    await delay(POLL_MS);
  }
}

export class Operations {
  // page:          観察用の親ページ(Playwright の Page)。試作品はその中の iframe
  // errors:        ここまでに集めたエラーの配列を返す関数(noErrors に使う)
  // ai:            observe() に渡された ai 関数。ai.state() があれば aiState に使う
  // outDir:        スクリーンショットを置くフォルダー(なければ screenshot は失敗する)
  // stepTimeoutMs: 1 つの操作と確かめにかける時間の上限
  constructor({ page, errors = () => [], ai = null, outDir = null, stepTimeoutMs = 5_000 }) {
    this.page = page;
    this.errors = errors;
    this.ai = ai;
    this.outDir = outDir;
    this.stepTimeoutMs = stepTimeoutMs;
    this.viewportName = null;
    this.shots = 0;
  }

  // 試作品の中(sandbox の iframe)。親ページにある iframe は 1 つだけ
  frame() {
    return this.page.frameLocator('iframe');
  }

  body() {
    return this.frame().locator('body');
  }

  locate(target) {
    if (!target) return this.body();
    const frame = this.frame();
    if (target.role) return frame.getByRole(target.role, target.name ? { name: target.name } : {});
    if (target.label) return frame.getByLabel(target.label);
    if (target.text) return frame.getByText(target.text);
    if (target.region) return frame.getByRole('region', { name: target.region });
    throw new StepFailure(`対象の書き方が正しくありません: ${JSON.stringify(target)}`);
  }

  // 対象が 1 つ以上あるのを待ち、最初の 1 つを返す
  async one(target) {
    const locator = this.locate(target).first();
    try {
      await locator.waitFor({ state: 'attached', timeout: this.stepTimeoutMs });
    } catch (error) {
      if (isTimeout(error)) throw new StepFailure(`対象が見つかりません: ${describeTarget(target)}`);
      throw error;
    }
    return locator;
  }

  // Playwright の時間切れを、利用者に見せる文にする
  async act(target, what, work) {
    try {
      return await work();
    } catch (error) {
      if (error instanceof StepFailure) throw error;
      if (isTimeout(error)) throw new StepFailure(`${describeTarget(target)} を${what}できませんでした(${Math.round(this.stepTimeoutMs / 1000)} 秒で終わりません。隠れているか、押せない状態かもしれません)`);
      throw new StepFailure(`${describeTarget(target)} を${what}できませんでした: ${squash(error?.message).slice(0, 300)}`);
    }
  }

  // 1. ページを読む: 画面の文字と、アクセシビリティの木の要約
  async read() {
    const body = this.body();
    try {
      const [text, tree] = await Promise.all([
        body.innerText({ timeout: this.stepTimeoutMs }),
        body.ariaSnapshot({ timeout: this.stepTimeoutMs }),
      ]);
      const shownText = cut(text.trim(), PAGE_LIMITS.maxText);
      const shownTree = cut(tree.trim(), PAGE_LIMITS.maxTree);
      return {
        viewport: this.viewportName,
        text: shownText.text,
        tree: shownTree.text,
        truncated: shownText.truncated || shownTree.truncated,
      };
    } catch (error) {
      if (isTimeout(error)) throw new StepFailure('画面を読めませんでした。試作品が応答していません');
      throw error;
    }
  }

  // 2. 要素の一覧と検査: 役割、名前、見えているか、押せるか。対象がなければ、操作できる要素の一覧
  async inspect(target = null) {
    let locators = [];
    let total = 0;
    if (target) {
      await this.one(target);
      locators = await this.locate(target).all();
      total = locators.length;
    } else {
      // 描画が空のときに一覧が空にならないよう、まず本文を待つ
      await this.body().waitFor({ state: 'attached', timeout: this.stepTimeoutMs }).catch(() => {});
      for (const role of INTERACTIVE_ROLES) {
        const found = await this.frame().getByRole(role, { includeHidden: true }).all();
        total += found.length;
        locators.push(...found);
      }
    }
    const elements = [];
    for (const locator of locators.slice(0, MAX_ELEMENTS)) {
      const timeout = this.stepTimeoutMs;
      const [snapshot, visible, enabled, text] = await Promise.all([
        locator.ariaSnapshot({ timeout }).catch(() => ''),
        locator.isVisible(),
        locator.isEnabled({ timeout }).catch(() => false),
        locator.innerText({ timeout }).catch(() => ''),
      ]);
      elements.push({ ...roleAndName(snapshot), text: squash(text).slice(0, MAX_ELEMENT_TEXT), visible, enabled });
    }
    return { target: target ?? null, count: total, elements, truncated: total > elements.length };
  }

  // 3. クリック
  async click(target) {
    const locator = await this.one(target);
    await this.act(target, '押す', () => locator.click({ timeout: this.stepTimeoutMs }));
    return { target };
  }

  // 4. 入力: 対象の中の文字を、渡した文字に入れ替える
  async type(target, text) {
    const locator = await this.one(target);
    await this.act(target, '入力', () => locator.fill(text, { timeout: this.stepTimeoutMs }));
    return { target, text };
  }

  // 5. スクロール: 対象が見えるまで。対象がなければ、ページの端(to: top、bottom)まで
  async scroll({ target = null, to = 'bottom' } = {}) {
    if (target) {
      const locator = await this.one(target);
      await this.act(target, 'スクロールして表示', () => locator.scrollIntoViewIfNeeded({ timeout: this.stepTimeoutMs }));
      return { target };
    }
    const scrollY = await this.act(null, 'スクロール', () =>
      this.body().evaluate(
        (body, end) => {
          const root = document.scrollingElement ?? document.documentElement;
          window.scrollTo(0, end === 'top' ? 0 : root.scrollHeight);
          return Math.round(window.scrollY);
        },
        to,
        { timeout: this.stepTimeoutMs },
      ),
    );
    return { to, scrollY };
  }

  // 6. 画面幅の切り替え: mobile、tablet、desktop
  async viewport(name) {
    if (!Object.hasOwn(VIEWPORTS, name)) {
      throw new StepFailure(`画面幅の名前が正しくありません: ${name}(${Object.keys(VIEWPORTS).join('、')} から選ぶ)`);
    }
    const size = VIEWPORTS[name];
    let timer;
    const timedOut = new Promise((resolve) => {
      timer = setTimeout(() => resolve('timeout'), this.stepTimeoutMs);
    });
    const resized = this.page.setViewportSize({ ...size });
    resized.catch(() => {});
    try {
      if ((await Promise.race([resized, timedOut])) === 'timeout') throw new StepFailure(`画面幅を ${name} に変えられません。試作品が応答していません`);
    } finally {
      clearTimeout(timer);
    }
    // 試作品が止まっていると requestAnimationFrame も返らないので、時間で待つ
    await delay(VIEWPORT_SETTLE_MS);
    this.viewportName = name;
    return { viewport: name, ...size };
  }

  // 7. スクリーンショット: 名前を付けて outDir に置く。file はファイルの名前(なければ順の番号)
  async screenshot(name, { file = null } = {}) {
    if (!this.outDir) throw new StepFailure('スクリーンショットを置くフォルダーがありません');
    this.shots += 1;
    const target = path.join(this.outDir, file ?? `shot-${this.shots}.png`);
    await fs.mkdir(this.outDir, { recursive: true });
    try {
      await this.page.screenshot({ path: target, timeout: SCREENSHOT_TIMEOUT_MS });
    } catch (error) {
      if (isTimeout(error)) throw new StepFailure(`「${name}」の画面を撮れませんでした。試作品が応答していません`);
      throw error;
    }
    const size = this.page.viewportSize() ?? { width: null, height: null };
    return { name, viewport: this.viewportName, width: size.width, height: size.height, file: target };
  }

  // 確かめ text: 対象(なければ画面全体)の文字に、contains がある。空白の違いは見ない
  async expectText(target, contains) {
    const want = squash(contains);
    const last = await poll(async () => {
      const locator = this.locate(target).first();
      const shown = squash(await locator.innerText({ timeout: POLL_MS * 5 }).catch(() => null));
      return { ok: shown.includes(want), shown };
    }, this.stepTimeoutMs);
    if (!last.ok) {
      const now = last.shown ? `今の文字: 「${last.shown.slice(0, 200)}${last.shown.length > 200 ? '…' : ''}」` : '対象が見つかりません';
      throw new StepFailure(`${describeTarget(target)} に「${want}」がありません(${now})`);
    }
    return { target, contains };
  }

  // 確かめ visible: 対象が見えている。対象がなければ、描画が空でない(文字か、見える画像や入力欄がある)
  async expectVisible(target = null) {
    if (target) {
      try {
        await this.locate(target).first().waitFor({ state: 'visible', timeout: this.stepTimeoutMs });
      } catch (error) {
        if (isTimeout(error)) throw new StepFailure(`${describeTarget(target)} が見えません`);
        throw error;
      }
      return { target };
    }
    const last = await poll(async () => {
      const ok = await this.body()
        .evaluate(
          (body) => {
            if (body.innerText.trim() !== '') return true;
            return [...body.querySelectorAll('img, svg, canvas, video, input, button, textarea, select')].some((element) => {
              const box = element.getBoundingClientRect();
              return box.width > 0 && box.height > 0;
            });
          },
          null,
          { timeout: POLL_MS * 5 },
        )
        .catch(() => false);
      return { ok };
    }, this.stepTimeoutMs);
    if (!last.ok) throw new StepFailure('描画が空です。画面に文字も、見える要素もありません');
    return { target: null };
  }

  // 確かめ noErrors: ここまでにエラーがない
  async expectNoErrors() {
    const errors = this.errors();
    if (errors.length > 0) {
      const [first] = errors;
      throw new StepFailure(`エラーが ${errors.length} 件あります。最初のエラー(${first.kind}): ${squash(first.message).slice(0, 300)}`);
    }
    return { errors: 0 };
  }

  // 確かめ aiState: プロダクト内 AI の状態の項目 key が equals になる(観察用の会話の状態)
  async expectAiState(key, equals) {
    if (typeof this.ai?.state !== 'function') throw new StepFailure('この観察では、プロダクト内 AI の状態を読めません');
    const last = await poll(async () => {
      const state = await this.ai.state();
      if (!state) return { ok: false, missing: false, value: undefined, started: false };
      if (!Object.hasOwn(state, key)) return { ok: false, missing: true, keys: Object.keys(state) };
      return { ok: state[key] === equals, value: state[key], started: true };
    }, this.stepTimeoutMs);
    if (last.ok) return { key, equals };
    if (last.missing) throw new StepFailure(`AI の状態に「${key}」の項目がありません(ある項目: ${last.keys.join('、') || 'なし'})`);
    if (!last.started) throw new StepFailure('プロダクト内 AI との会話が始まっていません');
    throw new StepFailure(`AI の状態の「${key}」が ${JSON.stringify(equals)} になりません(今の値: ${JSON.stringify(last.value)})`);
  }

  // シナリオの手順を 1 つ回す。検査を通った手順(scenario.js の checkScenario)を受け取る
  async step(step, { file = null } = {}) {
    if (step.do !== undefined) {
      switch (step.do) {
        case 'read':
          return this.read();
        case 'inspect':
          return this.inspect(step.target ?? null);
        case 'click':
          return this.click(step.target);
        case 'type':
          return this.type(step.target, step.text);
        case 'scroll':
          return this.scroll({ target: step.target ?? null, to: step.to ?? 'bottom' });
        case 'viewport':
          return this.viewport(step.viewport);
        case 'screenshot':
          return this.screenshot(step.name, { file });
        default:
          throw new StepFailure(`知らない do です: ${step.do}`);
      }
    }
    switch (step.expect) {
      case 'text':
        return this.expectText(step.target ?? null, step.contains);
      case 'visible':
        return this.expectVisible(step.target ?? null);
      case 'noErrors':
        return this.expectNoErrors();
      case 'aiState':
        return this.expectAiState(step.key, step.equals);
      default:
        throw new StepFailure(`知らない expect です: ${step.expect}`);
    }
  }
}
