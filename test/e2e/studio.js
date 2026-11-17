import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test as base } from '@playwright/test';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const URL_PATTERN = /http:\/\/127\.0\.0\.1:\d+\/#token=[a-f0-9]{64}/;
const STARTUP_TIMEOUT_MS = 20_000;
const STOP_TIMEOUT_MS = 5_000;

function waitForExit(child, ms) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

// npm とその子の node をまとめて止める
function signal(child, name) {
  try {
    if (process.platform === 'win32') {
      const force = name === 'SIGKILL' ? ['/F'] : [];
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', ...force], { stdio: 'ignore', timeout: STOP_TIMEOUT_MS });
    } else {
      // detached で起動したので、プロセスグループごと送る
      process.kill(-child.pid, name);
    }
  } catch {
    // すでに終わっている
  }
}

async function stopChild(child) {
  if (!(await waitForExit(child, 0))) {
    signal(child, 'SIGTERM');
    if (!(await waitForExit(child, STOP_TIMEOUT_MS))) {
      signal(child, 'SIGKILL');
      await waitForExit(child, STOP_TIMEOUT_MS);
    }
  }
  child.stdout.destroy();
  child.stderr.destroy();
}

function waitForUrl(child, output) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`起動が ${STARTUP_TIMEOUT_MS}ms で終わりません:\n${output()}`)), STARTUP_TIMEOUT_MS);
    child.stdout.on('data', () => {
      const match = URL_PATTERN.exec(output());
      if (match) {
        clearTimeout(timer);
        resolve(match[0]);
      }
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`起動の途中で終了しました(${code}):\n${output()}`));
    });
  });
}

// 作る AI の接続と認証に関わる変数。利用者の環境に何があっても、テストの結果を変えない
const AGENT_ENV = [
  'STUDIO_AGENT',
  'STUDIO_CLAUDE_BIN',
  'STUDIO_MAX_BUDGET_USD',
  'STUDIO_ALLOW_CLAUDE_CODE',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
];

// 利用者と同じ手順(npm start、または node bin/studio.js)で起動し、表示された URL を返す。
// env で環境変数を足す。値が undefined の名前は消す。
// 作る AI は、env で選ばなければ偽接続(STUDIO_AGENT=fake)にする。STUDIO_AGENT を消すか claude にするテストは、
// STUDIO_CLAUDE_BIN で偽の claude か、ない場所を指す。指さなければ起動しない(手元の本物の Claude Code を呼ばないため)。
// 本物を呼ぶのは real: true を渡したときだけ(test/e2e/real-loop.spec.js と real-sim.spec.js。STUDIO_REAL=1 のときだけ動く)
export async function launchStudio(home, { useNpm = false, env: extraEnv = {}, real = false } = {}) {
  const command = useNpm ? (process.platform === 'win32' ? 'npm.cmd' : 'npm') : process.execPath;
  const args = useNpm ? ['start'] : ['bin/studio.js'];
  const env = { ...process.env, STUDIO_HOME: home, STUDIO_NO_OPEN: '1', STUDIO_PORT: '0', STUDIO_PREVIEW_PORT: '0' };
  for (const name of AGENT_ENV) delete env[name];
  env.STUDIO_AGENT = 'fake';
  // はじめの画面は test/e2e/intent.spec.js が確かめる。ほかのテストは、試作品の画面から始める
  env.STUDIO_START_SCREEN = '0';
  Object.assign(env, extraEnv);
  for (const [name, value] of Object.entries(env)) if (value === undefined) delete env[name];
  if (env.STUDIO_AGENT !== 'fake' && !env.STUDIO_CLAUDE_BIN && !real) {
    throw new Error(`STUDIO_AGENT=${env.STUDIO_AGENT ?? '(なし)'} で起動するテストは、STUDIO_CLAUDE_BIN で偽の claude か、ない場所を指してください`);
  }
  const child = spawn(command, args, {
    cwd: ROOT,
    env,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: useNpm && process.platform === 'win32',
  });
  let output = '';
  child.stdout.on('data', (chunk) => (output += chunk));
  child.stderr.on('data', (chunk) => (output += chunk));

  let url;
  try {
    url = await waitForUrl(child, () => output);
  } catch (error) {
    await stopChild(child);
    throw error;
  }

  const origin = new URL(url).origin;
  const token = new URL(url).hash.slice('#token='.length);
  return {
    url,
    origin,
    token,
    output: () => output,
    async api(pathname) {
      const response = await fetch(`${origin}${pathname}`, { headers: { 'X-Studio-Token': token } });
      return response.json();
    },
    // 画面と同じく、Origin とトークンを付けて送る
    async post(pathname, body) {
      const response = await fetch(`${origin}${pathname}`, {
        method: 'POST',
        headers: { 'X-Studio-Token': token, Origin: origin, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      return { status: response.status, text: await response.text() };
    },
    stop: () => stopChild(child),
  };
}

export async function writeProject(home, id, files, title = id) {
  const root = path.join(home, 'projects', id);
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(root, 'app', name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content);
  }
  await fs.mkdir(path.join(root, '.studio'), { recursive: true });
  await fs.writeFile(path.join(root, '.studio', 'project.json'), JSON.stringify({ title }));
  return path.join(root, 'app');
}

// 一時的なデータの置き場を、テストごとに作って消す。
export const test = base.extend({
  home: async ({}, use) => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'prototype-studio-e2e-'));
    await use(home);
    await fs.rm(home, { recursive: true, force: true });
  },
});

export { expect };

// 開発の言葉(ux-redesign.md 9 節の U3)と、作るループの設計の言葉(harness.md の 7.2)。
// 利用者の画面の見える文字には出さない(開発者向けの詳細は除く)
export const U3_WORDS = ['偽接続', 'モック', 'ANTHROPIC_API_KEY', 'Console', 'app/ai.json', 'app/', 'ビルド', 'プロダクト内 AI', '認証の報告', 'STUDIO_', '--'];
export const HARNESS_WORDS = ['関門', 'シナリオ', 'report', '観察器'];
export const DEV_WORDS = [...U3_WORDS, ...HARNESS_WORDS];

// 文字の中の開発の言葉を、前後の文字つきで返す(どこに出ているかを、失敗の知らせで分かるように)
export function devWordsIn(text) {
  const found = [];
  for (const word of DEV_WORDS) {
    for (let at = text.indexOf(word); at !== -1; at = text.indexOf(word, at + word.length)) {
      found.push(`「${word}」: …${text.slice(Math.max(0, at - 30), at + word.length + 30).replace(/\s+/g, ' ')}…`);
    }
  }
  return found;
}

// 要素の見える文字(閉じた details の中と hidden の要素は入らない)に、開発の言葉がない
export async function expectNoDevWords(locator) {
  expect(devWordsIn(await locator.innerText())).toEqual([]);
}

// Studio の画面(iframe の外)の見える文字の全部に、開発の言葉がない(U3)。iframe の中の文字は innerText に入らない。
// 今の行(4 者の「⬢ 関門と守り」)は数えない。「関門」を開発の言葉から外すのは UI/UX の 5 枚目(ui-ux-v2.md の 6 節)。
// それまでは、今の行だけを調べる対象から外す
export async function expectNoDevWordsOnScreen(page) {
  const text = await page.locator('body').evaluate((body) => {
    const line = document.getElementById('now-line');
    const shown = line && line.checkVisibility() ? line.innerText : '';
    return shown ? body.innerText.replace(shown, '') : body.innerText;
  });
  expect(devWordsIn(text)).toEqual([]);
}

// サンプルの ID と、試作品の一覧の名前(Studio が目録の title と、試作品の中の AI があるかから作る)。
// 一覧の順も、この順(求人相談、学習相談、バイト探し、図書室)
export const SAMPLES = {
  jobConsult: { id: 'sample-job-consult', name: '求人相談(架空・AI と話せる)' },
  studyConsult: { id: 'sample-study-consult', name: '学習相談(架空・AI と話せる)' },
  partTime: { id: 'sample-part-time', name: 'バイト探し(架空・AI と話せる)' },
  library: { id: 'sample-library', name: '図書室(架空・AI なし)' },
};

// 上の帯の「試作品: … ▾」を押して一覧を開き、名前(文字列か正規表現)の試作品を選ぶ。一覧は選ぶと閉じる
export async function chooseProject(page, name) {
  const menuButton = page.locator('#project-menu-button');
  if ((await menuButton.getAttribute('aria-expanded')) !== 'true') await menuButton.click();
  const menu = page.getByRole('navigation', { name: '試作品の一覧', includeHidden: true });
  const button = menu.getByRole('button', { name, includeHidden: true });
  await button.click();
  await expect(menuButton).toHaveAttribute('aria-expanded', 'false');
  return button;
}

// 一覧からサンプルを選び、試作品の欄がそのサンプルに変わるまで待つ。
// 初めて開いたときは求人相談が選ばれているので、ほかのサンプルを使うテストは、これで明示して選ぶ
export async function chooseSample(page, sample) {
  const button = await chooseProject(page, sample.name);
  await expect(button).toHaveAttribute('aria-current', 'true');
  await expect(page.locator('iframe[title="試作品"]')).toHaveAttribute('src', new RegExp(`/p/${sample.id}/`));
}

// 試す欄の上の「AI: … ▾」を押して、試作品の中の AI の接続の選び方を開く(開いていれば、そのまま)
export async function openAiMenu(page) {
  const aiSwitch = page.locator('#ai-switch');
  if ((await aiSwitch.getAttribute('aria-expanded')) !== 'true') await aiSwitch.click();
  await expect(page.locator('#ai-menu')).toBeVisible();
}

// 試作品の中の AI を本物の AI(Claude Code)に切り替える。同意の前なら、試す欄の上に出る同意のカードで「同意して使う」を押す。
// 同意は直す AI と共通なので、同意の後はカードを出さずに切り替わる(ux-redesign.md 6 節)
export async function switchToRealAi(page) {
  await openAiMenu(page);
  await page.getByRole('radio', { name: '本物の AI', exact: true }).click();
  const card = page.getByRole('group', { name: '本物の AI を使う前に' });
  const badge = page.locator('#ai-badge');
  await expect(card.or(badge.filter({ hasText: 'AI: 本物' }))).toBeVisible();
  if (await card.isVisible()) await card.getByRole('button', { name: '同意して使う' }).click();
  await expect(badge).toHaveText('AI: 本物');
}

// 段の道筋(ui-ux-v2.md の 2.2、2.3)。9 つの段の名前と、画面の data-stage の名前
export const STAGES = { 話す: 'talk', 目的: 'goal', 設計: 'design', 審査: 'review', 作る: 'build', 測る: 'measure', 質: 'quality', 見せる: 'show', 渡す: 'handoff' };

// 段の道筋の段を押して、その段の作業台に移る。狭い画面では「n / 9 … ▾」を開いてから押す。
// 目的、設計、審査の段は、開く画面(聞き出し、整理、設計の案内、審査)が別にあるので、作業台の見出しまでは待たない
export async function goStage(page, name) {
  const key = STAGES[name];
  if (!key) throw new Error(`段の名前が違います: ${name}`);
  const compact = page.locator('#stage-compact');
  if ((await compact.isVisible()) && (await compact.getAttribute('aria-expanded')) !== 'true') await compact.click();
  await page.locator(`#stage-list button.stage[data-stage="${key}"]`).click();
  if (['build', 'measure', 'quality', 'show', 'handoff'].includes(key)) {
    await expect(page.locator(`#stage-list button.stage[data-stage="${key}"]`)).toHaveAttribute('aria-current', 'step');
  }
}

// 試作品の名前のメニューを開き、「保存した状態」(版と「この状態に戻す」)を返す。開いていれば、そのまま
export async function openVersions(page) {
  const menuButton = page.locator('#project-menu-button');
  if ((await menuButton.getAttribute('aria-expanded')) !== 'true') await menuButton.click();
  const region = page.getByRole('region', { name: '保存した状態' });
  await expect(region).toBeVisible();
  return region;
}

// 上の帯の「素材」を押して、右の引き出し(自分のトークン、部品と指針)を開く。開いていれば、そのまま
export async function openMaterials(page) {
  const button = page.getByRole('banner').getByRole('button', { name: '素材', exact: true });
  if ((await button.getAttribute('aria-expanded')) !== 'true') await button.click();
  const panel = page.getByRole('complementary', { name: '素材' });
  await expect(panel).toBeVisible();
  return panel;
}

// 今の行の「仕組みを見る」を押して、仕組みの引き出しを開く。開いていれば、そのまま。
// 接続、試験用の依頼、ビルド、プロダクト内 AI、構成と前提、AI の実行の記録、試作品からの知らせ、画面を読み込み直すがある
export async function openMechanism(page) {
  const button = page.locator('#mechanism-button');
  if ((await button.getAttribute('aria-expanded')) !== 'true') await button.click();
  const panel = page.getByRole('complementary', { name: '仕組み' });
  await expect(panel).toBeVisible();
  return panel;
}

// 開いている引き出し(仕組み、素材)と、試作品の名前のメニューを閉じる(閉じていれば、そのまま)。
// 前の「その他」の引き出しを閉じる操作の代わり。閉じた後は、試作品と言葉で直す欄が見える
export async function closeMore(page) {
  for (const [button, panel] of [['#mechanism-button', '#mechanism'], ['#materials-button', '#materials']]) {
    if ((await page.locator(button).getAttribute('aria-expanded')) === 'true') await page.locator(button).click();
    await expect(page.locator(panel)).toBeHidden();
  }
  const menuButton = page.locator('#project-menu-button');
  if ((await menuButton.getAttribute('aria-expanded')) === 'true') await menuButton.click();
  // 段 9 やまだの段の作業台にいるときは、試作品と言葉で直す欄のある段 5「作る」に戻る
  const bench = await page.locator('body').getAttribute('data-bench');
  if (bench === 'handoff' || bench === 'note') await goStage(page, '作る');
}

// 仕組みの引き出しを開き、中の詳しいもの(ビルドなど)が見えるまで待つ。前の「仕組みの引き出し」の代わり
export async function openDevDetails(page) {
  const panel = await openMechanism(page);
  await expect(page.locator('#build-status')).toBeVisible();
  return panel;
}

// 段 9「渡す」の作業台に移り、「本番開発へ渡す」を返す
export async function openHandoff(page) {
  await goStage(page, '渡す');
  const region = page.getByRole('region', { name: '本番開発へ渡す' });
  await expect(region).toBeVisible();
  return region;
}

// 段 7「質」の作業台に移り、「試作品を自動で確かめる」を返す
export async function openCheck(page) {
  await goStage(page, '質');
  const region = page.getByRole('region', { name: '試作品を自動で確かめる' });
  await expect(region).toBeVisible();
  return region;
}

// 段 8「見せる」の作業台に移り、次の一手の帯の「人に見せる」を押して、見せる画面にする
export async function startShowing(page) {
  await goStage(page, '見せる');
  const button = page.getByRole('region', { name: '次の一手' }).getByRole('button', { name: '人に見せる' });
  await expect(button).toBeEnabled();
  await button.click();
}

// 偽接続(STUDIO_AGENT=fake)の試験用の依頼を、仕組みの引き出しの「試験用の依頼」から選ぶ。
// 押すと依頼の欄に入り、引き出しは閉じる(ux-redesign.md 5 節、U4)。送るのは呼んだ側
export async function chooseTestRequest(page, text) {
  await openDevDetails(page);
  await page.getByRole('list', { name: '偽の直す AI で試せる例' }).getByRole('button', { name: text, exact: true }).click();
  await expect(page.locator('#mechanism')).toBeHidden();
  await expect(page.getByLabel('依頼')).toHaveValue(text);
}

// 3.7 の 2 つ目の測り方。見えている字の要素ごとに、字の色と、親をたどって最初に色のある地の色を比べる(WCAG 2 の式)。
// 地が半ば透けているときは、その下の地と重ねた色にする。試作品(iframe の中)は試作品が決めるので測らない
function contrastInPage() {
  const parse = (value) => {
    const m = /rgba?\(([^)]+)\)/.exec(value);
    if (!m) return null;
    const [r, g, b, a = 1] = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
    return { r, g, b, a };
  };
  const over = (top, bottom) => ({
    r: top.r * top.a + bottom.r * (1 - top.a),
    g: top.g * top.a + bottom.g * (1 - top.a),
    b: top.b * top.a + bottom.b * (1 - top.a),
    a: 1,
  });
  const luminance = ({ r, g, b }) => {
    const [R, G, B] = [r, g, b].map((v) => {
      const c = v / 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * R + 0.7152 * G + 0.0722 * B;
  };
  const ratio = (a, b) => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  };
  const backdrop = (element) => {
    const layers = [];
    for (let node = element; node; node = node.parentElement) {
      const color = parse(getComputedStyle(node).backgroundColor);
      if (color && color.a > 0) {
        layers.push(color);
        if (color.a >= 1) break;
      }
    }
    let result = { r: 255, g: 255, b: 255, a: 1 };
    for (const layer of layers.reverse()) result = over(layer, result);
    return result;
  };
  const where = (element) => {
    const parts = [];
    for (let node = element; node && node !== document.body && parts.length < 3; node = node.parentElement) {
      parts.unshift(node.id ? `#${node.id}` : `${node.localName}${node.classList.length ? `.${[...node.classList].join('.')}` : ''}`);
      if (node.id) break;
    }
    return parts.join(' > ');
  };
  const results = [];
  for (const element of document.body.querySelectorAll('*')) {
    if (element instanceof SVGElement || ['SCRIPT', 'STYLE', 'OPTION', 'IFRAME'].includes(element.tagName)) continue;
    const text = [...element.childNodes].filter((node) => node.nodeType === Node.TEXT_NODE).map((node) => node.textContent).join('').trim();
    if (!text) continue;
    if (!element.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
    const rect = element.getBoundingClientRect();
    // 読み上げにだけ出す文字(.visually-hidden、1px の箱)は見えないので除く
    if (rect.width <= 1 || rect.height <= 1) continue;
    const style = getComputedStyle(element);
    const bg = backdrop(element);
    const fg = over(parse(style.color), bg);
    results.push({ text: text.slice(0, 40), where: where(element), ratio: Math.round(ratio(fg, bg) * 100) / 100, fontSize: parseFloat(style.fontSize) });
  }
  return results.sort((a, b) => a.ratio - b.ratio);
}

// 見えている字の全部の差を測り、低い順に返す。状態の変化の動き(120ms)が終わるのを待ってから測る(途中の色を測らないため)
export async function measureTextContrast(page) {
  // ずっと続く動き(読み込み中の印など)は待たない。待つのは状態の変化(transition)だけで、長くても 2 秒
  await page.evaluate(() => Promise.race([
    Promise.all(document.getAnimations().filter((animation) => animation instanceof CSSTransition).map((animation) => animation.finished.catch(() => {}))),
    new Promise((resolve) => setTimeout(resolve, 2000)),
  ]));
  return page.evaluate(contrastInPage);
}

// 今の画面の見えている字の全部が、ライトとダークの両方で 4.5:1 以上(ui-ux-v2.md の 11 節)。
// OS の設定(prefers-color-scheme)を切り替えて測り、終わったら元に戻す。一番低い値を出力に残す
export async function expectReadableText(page, label) {
  const before = await page.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches);
  try {
    for (const colorScheme of ['light', 'dark']) {
      await page.emulateMedia({ colorScheme });
      const results = await measureTextContrast(page);
      const lowest = results[0];
      if (lowest) console.log(`[字と地の差] ${label}(${colorScheme}): 字の要素 ${results.length}、一番低い差 ${lowest.ratio}(${lowest.where}「${lowest.text}」)`);
      const failing = results.filter((result) => result.ratio < 4.5);
      expect(failing, `${label}(${colorScheme}) で 4.5:1 より低い字: ${JSON.stringify(failing, null, 2)}`).toEqual([]);
    }
  } finally {
    await page.emulateMedia({ colorScheme: before ? 'dark' : 'light' });
  }
}
