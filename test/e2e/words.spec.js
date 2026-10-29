import fs from 'node:fs/promises';
import path from 'node:path';
import {
  ROOT,
  SAMPLES,
  chooseProject,
  chooseSample,
  chooseTestRequest,
  closeMore,
  devWordsIn,
  expect,
  launchStudio,
  openAiMenu,
  openDevDetails,
  openMore,
  test,
  writeProject,
} from './studio.js';

// 画面の言葉(docs/design/ux-redesign.md の 4 節、9 節の U3。P29)。
// 全部の場面で、Studio の画面(iframe の外)の見えている文字に、開発の言葉(U3)と作るループの設計の言葉
// (関門、シナリオ、report、観察器。harness.md の 7.2)がないことを確かめる。開発者向けの詳細は開かない。
// 各場面を 1440x900 で撮り、test-results/ux/ に置く(「分かるか」の確かめ。test-results/ は git が無視する)。
// 実モデルは呼ばない。直す AI は偽接続か偽の claude、試作品の中の AI はお試しの AI

const UX_SHOTS = path.join(ROOT, 'test-results', 'ux');
const CARD = '本物の AI を使う前に';

// 偽の claude をシェルスクリプトで作る。--version と auth status と試作品の中の AI(--json-schema)は偽の CLI に、
// それ以外(直す AI)は偽接続に渡す。直す AI の出力は 1 行ずつ少し遅らせる。直している場面を撮るため
async function writeFakeClaude(home) {
  const bin = path.join(home, 'bin', 'claude');
  await fs.mkdir(path.dirname(bin), { recursive: true });
  const node = `"${process.execPath}"`;
  const cli = `"${path.join(ROOT, 'test', 'fixtures', 'fake-claude.js')}"`;
  const fixer = `"${path.join(ROOT, 'src', 'agent', 'fake-claude.js')}"`;
  await fs.writeFile(
    bin,
    [
      '#!/bin/sh',
      `case "$1" in --version|auth) exec ${node} ${cli} "$@";; esac`,
      `case "$*" in *--json-schema*) exec ${node} ${cli} "$@";; esac`,
      `${node} ${fixer} "$@" | while IFS= read -r line || [ -n "$line" ]; do printf '%s\\n' "$line"; sleep 0.2; done`,
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  return bin;
}

// 画面の文ではないもの: 作る会話の項目の本文(サーバーの文。P30 で直す)と、直す AI の返事(モデルの出力)
const NOT_SCREEN_TEXT = '.steps > li:not(.step-short) > .text, .bubble.agent > p';

// 場面の見える文字を確かめて撮る。場面ごとに失敗を集めて、最後にまとめて知らせる(1 つの場面で止めない)。
// full が false なら、画面の文ではないもの(NOT_SCREEN_TEXT)を外して確かめる
async function scene(page, name, { full = false } = {}) {
  const text = await page.evaluate(
    ([selector, full]) => {
      const hidden = full ? [] : [...document.querySelectorAll(selector)].filter((node) => node.style.display !== 'none');
      for (const node of hidden) node.style.display = 'none';
      const text = document.body.innerText;
      for (const node of hidden) node.style.display = '';
      return text;
    },
    [NOT_SCREEN_TEXT, full],
  );
  expect.soft(devWordsIn(text), `場面「${name}」の見える文字に、開発の言葉があります`).toEqual([]);
  if (!full) await page.screenshot({ path: path.join(UX_SHOTS, `P29-${name}.png`) });
}

function lastRun(page) {
  return page.getByRole('list', { name: '作る会話' }).locator('> li.run').last();
}

function bandOf(item) {
  return item.getByRole('group', { name: '確かめた結果' });
}

test.describe('U3: 見える文字に開発の言葉がない', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
  });

  // 作る会話の項目のある場面は 2 通りに確かめる。画面の文だけ(今通る)と、項目の本文と直す AI の返事も含めた全部(P30 の後に通す)。
  // 全部の方で残る言葉は、Report の一覧のとおり、サーバーの文(作る会話の項目)と直す AI の返事にある
  for (const full of [false, true]) {
    const define = full ? test.fixme : test;
    const suffix = full ? '(作る会話の項目と直す AI の返事も含める。P30)' : '';
    const check = (page, name) => scene(page, name, { full });

    define(`最初、試す、話す、同意のカード、直す、直った後、確かめる${suffix}`, async ({ page, home }) => {
      test.skip(process.platform === 'win32', '偽の claude をシェルスクリプトで作るため');
      // 直す AI の依頼を 1 回と、確かめを 1 回終えるまで待つ
      test.setTimeout(120_000);
      const studio = await launchStudio(home, { env: { STUDIO_AGENT: undefined, STUDIO_CLAUDE_BIN: await writeFakeClaude(home) } });
      try {
        await page.goto(studio.url);
        const app = page.frameLocator('iframe[title="試作品"]');
        const make = page.getByRole('region', { name: '言葉で直す' });
        const card = page.getByRole('group', { name: CARD });

        // 最初
        await expect(app.getByRole('heading', { name: 'しおかぜ求人相談' })).toBeVisible();
        await expect(make.getByRole('list', { name: '直し方の例' }).getByRole('button')).toHaveCount(3);
        await check(page, 'first');

        // 試す: 試す欄の上の「AI: … ▾」を開く
        await openAiMenu(page);
        await check(page, 'try');

        // 同意のカード(試作品の中の AI を本物にするとき)。やめると、お試しのまま
        await page.locator('#ai-menu').getByRole('radio').nth(1).check();
        await expect(card).toBeVisible();
        await check(page, 'consent-try');
        await card.getByRole('button', { name: 'やめる' }).click();
        await expect(card).toHaveCount(0);

        // 話す
        await app.getByLabel('メッセージ').fill('カフェで働きたいです');
        await app.getByRole('button', { name: '送る' }).click();
        await expect(app.getByRole('region', { name: '会話' }).getByRole('listitem')).toHaveCount(3);
        await check(page, 'talk');

        // 同意のカード(直す欄の初回の送信)
        await make.getByRole('list', { name: '直し方の例' }).getByRole('button', { name: '時給の下限を先に聞くようにして' }).click();
        await make.getByRole('button', { name: '送る' }).click();
        await expect(card).toBeVisible();
        await check(page, 'consent');

        // 直す: 同意すると送られ、直す AI が作業する
        await card.getByRole('button', { name: '同意して使う' }).click();
        const run = lastRun(page);
        await expect(run.getByText('AI の設定を読みました')).toBeVisible({ timeout: 15_000 });
        await check(page, 'fixing');

        // 直った後: 結果の帯と試し直しの帯
        const band = bandOf(run);
        await expect(band).toBeVisible({ timeout: 60_000 });
        const bar = page.getByRole('region', { name: '試し直す' });
        await expect(bar).toBeVisible();
        await check(page, 'fixed');
        await bar.getByRole('button', { name: '同じ発言で試し直す' }).click();
        await expect(bar.getByRole('region', { name: '直す前と後の返事' })).toBeVisible();
        await check(page, 'retried');

        // その他の引き出し(開発者向けの詳細は閉じたまま)
        const panel = await openMore(page);
        await expect(panel.getByRole('button', { name: '試作品を自動で確かめる' })).toBeEnabled();
        await check(page, 'more');

        // 確かめる: 引き出しの「試作品を自動で確かめる」。結果は直す欄に、同じ形の結果の帯で出る
        await panel.getByRole('button', { name: '試作品を自動で確かめる' }).click();
        await closeMore(page);
        const checked = page.getByRole('list', { name: '作る会話' }).locator('> li.check').last();
        await expect(bandOf(checked)).toBeVisible({ timeout: 30_000 });
        await check(page, 'check');
      } finally {
        await studio.stop();
      }
    });

    define(`結果の帯: fixed と failed${suffix}`, async ({ page, home }) => {
      test.setTimeout(90_000);
      const studio = await launchStudio(home);
      try {
        await page.goto(studio.url);
        await chooseSample(page, SAMPLES.library);
        await expect(page.frameLocator('iframe[title="試作品"]').getByRole('heading', { name: 'こもれび図書室' })).toBeVisible();

        await chooseTestRequest(page, '壊して');
        await page.getByRole('button', { name: '送る' }).click();
        await expect(bandOf(lastRun(page))).toHaveAttribute('data-status', 'fixed', { timeout: 30_000 });
        await check(page, 'band-fixed');

        await chooseTestRequest(page, '壊して、直せないふりをして');
        await page.getByRole('button', { name: '送る' }).click();
        await expect(bandOf(lastRun(page))).toHaveAttribute('data-status', 'failed', { timeout: 30_000 });
        await check(page, 'band-failed');
      } finally {
        await studio.stop();
      }
    });

    define(`結果の帯: unverified(画面を開いて確かめられないとき)${suffix}`, async ({ page, home }) => {
      // 観察に使う Chromium を、ない場所で探させる。開いて確かめられないので unverified になる
      const studio = await launchStudio(home, { env: { PLAYWRIGHT_BROWSERS_PATH: path.join(home, 'no-browsers') } });
      try {
        await page.goto(studio.url);
        await chooseSample(page, SAMPLES.library);
        await chooseTestRequest(page, '見出しを「ひだまり図書室」にして');
        await page.getByRole('button', { name: '送る' }).click();
        await expect(bandOf(lastRun(page))).toHaveAttribute('data-status', 'unverified', { timeout: 20_000 });
        await check(page, 'band-unverified');
      } finally {
        await studio.stop();
      }
    });
  }

  test('エラー: 直す AI が使えない(7-5)', async ({ page, home }) => {
    const studio = await launchStudio(home, { env: { STUDIO_AGENT: undefined, STUDIO_CLAUDE_BIN: path.join(home, 'no-such-claude') } });
    try {
      await page.goto(studio.url);
      await expect(page.getByRole('group', { name: '言葉で直すには、Claude Code が要ります' })).toBeVisible();
      await expect(page.frameLocator('iframe[title="試作品"]').getByRole('heading', { name: 'しおかぜ求人相談' })).toBeVisible();
      await scene(page, 'unavailable');
      // 試す欄の「AI: … ▾」でも、本物の AI を選べない理由を出す
      await openAiMenu(page);
      await scene(page, 'unavailable-try');
      // その他の引き出しの「試作品を自動で確かめる」でも、本物の AI を選べない理由を同じ 1 文で出す
      await page.keyboard.press('Escape');
      const panel = await openMore(page);
      await expect(panel.locator('#check-ai-note')).toHaveText('本物の AI は選べません: この PC で Claude Code が見つかりません。');
      await scene(page, 'unavailable-more');
    } finally {
      await studio.stop();
    }
  });

  test('エラー: 試作品を表示できない(7-6)', async ({ page, home }) => {
    const appDir = await writeProject(home, 'shop-demo', { 'main.jsx': 'document.getElementById("root").textContent = "架空の雑貨店 ひだまり堂";\n' }, '架空の雑貨店');
    const studio = await launchStudio(home);
    try {
      await page.goto(studio.url);
      await chooseProject(page, /架空の雑貨店/);
      await expect(page.frameLocator('iframe[title="試作品"]').getByText('架空の雑貨店 ひだまり堂')).toBeVisible();
      await fs.writeFile(path.join(appDir, 'main.jsx'), 'const items = [1, 2;\n');
      await openDevDetails(page);
      await page.getByRole('button', { name: 'ファイルから作り直す' }).click();
      await closeMore(page);
      await expect(page.getByRole('group', { name: '試作品を表示できません' })).toBeVisible();
      await scene(page, 'cannot-display');
    } finally {
      await studio.stop();
    }
  });
});
