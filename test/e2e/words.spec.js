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
  openCheck,
  test,
  writeProject,
} from './studio.js';

// 画面の言葉(docs/design/ux-redesign.md の 4 節、9 節の U3。画面の文は P29、サーバーの文は P30)。
// 全部の場面で、Studio の画面(iframe の外)の見えている文字に、開発の言葉(U3)と作るループの設計の言葉
// (関門、シナリオ、report、観察器。harness.md の 7.2)がないことを確かめる。作る会話の項目の本文(サーバーの文)も含める。
// 開発者向けの詳細は開かない(開いたときに、認証の報告、ファイルの名前、関門の名前が見えることは別に確かめる)。
// 各場面を 1440x900 で撮り、test-results/ux/ に置く(「分かるか」の確かめ。test-results/ は git が無視する)。
// 実モデルは呼ばない。作る AI は偽接続か偽の claude、試作品の中の AI はお試しの AI

const UX_SHOTS = path.join(ROOT, 'test-results', 'ux');
const CARD = '本物の AI を使う前に';

// 偽の claude をシェルスクリプトで作る。--version と auth status と試作品の中の AI(--json-schema)は偽の CLI に、
// それ以外(作る AI)は偽接続に渡す。作る AI の出力は 1 行ずつ少し遅らせる。直している場面を撮るため
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

// 利用者が書いた依頼の文(作る会話の「あなた」と、作る AI の欄の「依頼:」)。Studio の文ではないので、確かめから外す(試験用の依頼に「app/」がある)。
// 今の行(#now-line)も調べる。「関門」を開発の言葉から外した(ui-ux-v2.md の 6 節)
const USER_TEXT = '.bubble.user > p, .make-now-request';

// 場面の見える文字を確かめて撮る。場面ごとに失敗を集めて、最後にまとめて知らせる(1 つの場面で止めない)。
// 作る会話の項目の本文(サーバーの文。P30)と、作る AI の返事も含める。作る AI の返事は偽接続の決まった文で、
// 本物のモデルの返事は Studio が決められないので、ここでは確かめない
async function scene(page, name, prefix = 'P29') {
  const text = await page.evaluate((selector) => {
    const hidden = [...document.querySelectorAll(selector)].filter((node) => node.style.display !== 'none');
    for (const node of hidden) node.style.display = 'none';
    const text = document.body.innerText;
    for (const node of hidden) node.style.display = '';
    return text;
  }, USER_TEXT);
  expect.soft(devWordsIn(text), `場面「${name}」の見える文字に、開発の言葉があります`).toEqual([]);
  await page.screenshot({ path: path.join(UX_SHOTS, `${prefix}-${name}.png`) });
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

  test('最初、試す、話す、同意のカード、直す、直った後、確かめる', async ({ page, home }) => {
    test.skip(process.platform === 'win32', '偽の claude をシェルスクリプトで作るため');
    // 作る AI の依頼を 1 回と、確かめを 1 回終えるまで待つ
    test.setTimeout(120_000);
    const studio = await launchStudio(home, { env: { STUDIO_AGENT: undefined, STUDIO_CLAUDE_BIN: await writeFakeClaude(home) } });
    try {
      await page.goto(studio.url);
      const app = page.frameLocator('iframe[title="試作品"]');
      const make = page.getByRole('region', { name: '作る AI', exact: true });
      const card = page.getByRole('group', { name: CARD });

      // 最初
      await expect(app.getByRole('heading', { name: 'しおかぜ求人相談' })).toBeVisible();
      await expect(make.getByRole('list', { name: '直し方の例' }).getByRole('button')).toHaveCount(3);
      await scene(page, 'first');

      // 試す: 試す欄の上の「AI: … ▾」を開く
      await openAiMenu(page);
      await scene(page, 'try');

      // 同意のカード(試作品の中の AI を本物にするとき)。やめると、お試しのまま
      await page.locator('#ai-menu').getByRole('radio').nth(1).check();
      await expect(card).toBeVisible();
      await scene(page, 'consent-try');
      await card.getByRole('button', { name: 'やめる' }).click();
      await expect(card).toHaveCount(0);

      // 話す
      await app.getByLabel('メッセージ').fill('カフェで働きたいです');
      await app.getByRole('button', { name: '送る' }).click();
      await expect(app.getByRole('region', { name: '会話' }).getByRole('listitem')).toHaveCount(3);
      await scene(page, 'talk');

      // 同意のカード(直す欄の初回の送信)
      await make.getByRole('list', { name: '直し方の例' }).getByRole('button', { name: '時給の下限を先に聞くようにして' }).click();
      await make.getByRole('button', { name: '送る' }).click();
      await expect(card).toBeVisible();
      await scene(page, 'consent');

      // 直す: 同意すると送られ、作る AI が作業する
      await card.getByRole('button', { name: '同意して使う' }).click();
      const run = lastRun(page);
      await expect(run.getByText('AI の設定を読みました')).toBeVisible({ timeout: 15_000 });
      await scene(page, 'fixing');

      // 直った後: 結果の帯と試し直しの帯
      const band = bandOf(run);
      await expect(band).toBeVisible({ timeout: 60_000 });
      const bar = page.getByRole('region', { name: '試し直す' });
      await expect(bar).toBeVisible();
      await scene(page, 'fixed');
      await bar.getByRole('button', { name: '同じ発言で試し直す' }).click();
      await expect(bar.getByRole('region', { name: '直す前と後の返事' })).toBeVisible();
      await scene(page, 'retried');

      // 段 7「質」の「試作品を自動で確かめる」(仕組みの引き出しは閉じたまま)
      const panel = await openCheck(page);
      await expect(panel.getByRole('button', { name: '試作品を自動で確かめる' })).toBeEnabled();
      await scene(page, 'more');

      // 確かめる: 段 7 の「試作品を自動で確かめる」。結果は直す欄に、同じ形の結果の帯で出る
      await panel.getByRole('button', { name: '試作品を自動で確かめる' }).click();
      await closeMore(page);
      const checked = page.getByRole('list', { name: '作る会話' }).locator('> li.check').last();
      await expect(bandOf(checked)).toBeVisible({ timeout: 30_000 });
      await scene(page, 'check');
    } finally {
      await studio.stop();
    }
  });

  test('結果の帯: fixed と failed', async ({ page, home }) => {
    test.setTimeout(90_000);
    const studio = await launchStudio(home);
    try {
      await page.goto(studio.url);
      await chooseSample(page, SAMPLES.library);
      await expect(page.frameLocator('iframe[title="試作品"]').getByRole('heading', { name: 'こもれび図書室' })).toBeVisible();

      await chooseTestRequest(page, '壊して');
      await page.getByRole('button', { name: '送る' }).click();
      await expect(bandOf(lastRun(page))).toHaveAttribute('data-status', 'fixed', { timeout: 30_000 });
      await scene(page, 'band-fixed');

      await chooseTestRequest(page, '壊して、直せないふりをして');
      await page.getByRole('button', { name: '送る' }).click();
      await expect(bandOf(lastRun(page))).toHaveAttribute('data-status', 'failed', { timeout: 30_000 });
      await scene(page, 'band-failed');
    } finally {
      await studio.stop();
    }
  });

  // 「分かるか」の確かめ(P30): 作る会話の失敗の場面と、権限で断られた場面を撮る。
  // 撮った後に、その実行の「開発者向け: 操作の詳細」を開き、開発者向けの文が見えることを確かめる
  test('作る会話の失敗と、権限で断られた場面。開発者向けの詳細には、認証の報告、ファイルの名前、関門の名前がある', async ({ page, home }) => {
    test.setTimeout(90_000);
    const studio = await launchStudio(home);
    try {
      await page.goto(studio.url);
      await chooseSample(page, SAMPLES.library);
      await expect(page.frameLocator('iframe[title="試作品"]').getByRole('heading', { name: 'こもれび図書室' })).toBeVisible();

      // 権限で断られた場面
      await chooseTestRequest(page, 'app/ の外にメモを書いて');
      await page.getByRole('button', { name: '送る' }).click();
      let run = lastRun(page);
      await expect(run.locator('[data-kind="denied"]')).toHaveText(/試作品のフォルダーの外は触れないので、やめました/);
      await expect(bandOf(run)).toBeVisible({ timeout: 30_000 });
      await scene(page, 'denied', 'P30');

      // 作る会話の失敗の場面(作る AI が 2 回直しても直らない)
      await chooseTestRequest(page, '壊して、直せないふりをして');
      await page.getByRole('button', { name: '送る' }).click();
      run = lastRun(page);
      await expect(bandOf(run)).toHaveAttribute('data-status', 'failed', { timeout: 30_000 });
      await expect(run.locator('[data-kind="gave-up"]')).toContainText('直したいことを言葉で送ってください');
      await scene(page, 'failed', 'P30');

      // 開発者向けの詳細: 認証の報告、ファイルの名前、関門の名前
      await run.locator('.run-dev > summary').click();
      const dev = run.getByRole('list', { name: '操作の詳細' });
      await expect(run.locator('.run-dev')).toContainText('認証の報告: none');
      await expect(dev).toContainText('変わったファイル: app/App.jsx');
      await expect(dev).toContainText('G4 ビルド');
      await expect(dev.locator('[data-dev-kind="gave-up"]')).toContainText('直すラウンドを 2 回行ったが、G4 ビルドで失敗したまま。');
    } finally {
      await studio.stop();
    }
  });

  test('結果の帯: unverified(画面を開いて確かめられないとき)', async ({ page, home }) => {
    // 観察に使う Chromium を、ない場所で探させる。開いて確かめられないので unverified になる
    const studio = await launchStudio(home, { env: { PLAYWRIGHT_BROWSERS_PATH: path.join(home, 'no-browsers') } });
    try {
      await page.goto(studio.url);
      await chooseSample(page, SAMPLES.library);
      await chooseTestRequest(page, '見出しを「ひだまり図書室」にして');
      await page.getByRole('button', { name: '送る' }).click();
      const run = lastRun(page);
      await expect(bandOf(run)).toHaveAttribute('data-status', 'unverified', { timeout: 20_000 });
      await scene(page, 'band-unverified');
      // 項目の本文には、理由の最初の 1 文だけが出る。ブラウザーの場所と英語の誤りは、開発者向けの詳細にだけ出る
      const item = run.locator('[data-kind="launch-unverified"]');
      await expect(item).toContainText('この PC には、試作品を開いて確かめるためのブラウザーが入っていません。');
      await expect(item).not.toContainText('/');
      await expect(item).not.toContainText('Executable');
      await expect(item).not.toContainText('Chromium');
      await run.locator('.run-dev > summary').click();
      const dev = run.getByRole('list', { name: '操作の詳細' });
      await expect(dev).toContainText('G5 起動の確認: 未確認。');
      await expect(dev).toContainText('npm run install:chromium');
    } finally {
      await studio.stop();
    }
  });

  test('エラー: 作る AI が使えない(7-5)', async ({ page, home }) => {
    const studio = await launchStudio(home, { env: { STUDIO_AGENT: undefined, STUDIO_CLAUDE_BIN: path.join(home, 'no-such-claude') } });
    try {
      await page.goto(studio.url);
      await expect(page.getByRole('group', { name: '言葉で直すには、Claude Code が要ります' })).toBeVisible();
      await expect(page.frameLocator('iframe[title="試作品"]').getByRole('heading', { name: 'しおかぜ求人相談' })).toBeVisible();
      await scene(page, 'unavailable');
      // 試す欄の「AI: … ▾」でも、本物の AI を選べない理由を出す
      await openAiMenu(page);
      await scene(page, 'unavailable-try');
      // 段 7 の「試作品を自動で確かめる」でも、本物の AI を選べない理由を同じ 1 文で出す
      await page.keyboard.press('Escape');
      const panel = await openCheck(page);
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
