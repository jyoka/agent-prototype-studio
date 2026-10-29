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

// 開発の言葉(ux-redesign.md 9 節の U3)。利用者の画面の見える文字には出さない(開発者向けの詳細は除く)
export const U3_WORDS = ['偽接続', 'モック', 'ANTHROPIC_API_KEY', 'Console', 'app/ai.json', 'app/', 'ビルド', 'プロダクト内 AI', '認証の報告', 'STUDIO_', '--'];

// 要素の見える文字(閉じた details の中と hidden の要素は入らない)に、開発の言葉がない
export async function expectNoDevWords(locator) {
  const text = await locator.innerText();
  for (const word of U3_WORDS) expect(text, `「${word}」が見えています`).not.toContain(word);
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
  await page.getByRole('radio', { name: 'Claude Code', exact: true }).click();
  const card = page.getByRole('group', { name: '本物の AI を使う前に' });
  const badge = page.locator('#ai-badge');
  await expect(card.or(badge.filter({ hasText: 'AI: Claude Code' }))).toBeVisible();
  if (await card.isVisible()) await card.getByRole('button', { name: '同意して使う' }).click();
  await expect(badge).toHaveText('AI: Claude Code');
}

// 上の帯の「その他」を押して、右の引き出しを開く(開いていれば、そのまま)。
// 保存した状態、本番開発へ渡す、画面を読み込み直す、開発者向けの詳細は、この中にある
export async function openMore(page) {
  const more = page.getByRole('banner').getByRole('button', { name: 'その他' });
  if ((await more.getAttribute('aria-expanded')) !== 'true') await more.click();
  const panel = page.getByRole('complementary', { name: 'その他' });
  await expect(panel).toBeVisible();
  return panel;
}

// 引き出しを閉じる(閉じていれば、そのまま)。引き出しは右の「言葉で直す」の上に重なるので、直す欄を使う前に閉じる
export async function closeMore(page) {
  const more = page.getByRole('banner').getByRole('button', { name: 'その他' });
  if ((await more.getAttribute('aria-expanded')) === 'true') await page.locator('#more-close').click();
  await expect(page.locator('#more-panel')).toBeHidden();
}

// その他 → 開発者向けの詳細を開く(開いていれば、そのまま)。ビルド、プロダクト内 AI、AI の実行の記録、試作品からの知らせがある
export async function openDevDetails(page) {
  await openMore(page);
  const details = page.locator('#dev-details');
  if (!(await details.evaluate((el) => el.open))) await details.locator(':scope > summary').click();
  await expect(page.locator('#build-status')).toBeVisible();
  return details;
}

// 偽接続(STUDIO_AGENT=fake)の試験用の依頼を、その他 → 開発者向けの詳細の「試験用の依頼」から選ぶ。
// 押すと依頼の欄に入り、引き出しは閉じる(ux-redesign.md 5 節、U4)。送るのは呼んだ側
export async function chooseTestRequest(page, text) {
  await openDevDetails(page);
  await page.getByRole('list', { name: '偽の直す AI で試せる例' }).getByRole('button', { name: text, exact: true }).click();
  await expect(page.locator('#more-panel')).toBeHidden();
  await expect(page.getByLabel('依頼')).toHaveValue(text);
}
