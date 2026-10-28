import path from 'node:path';
import { ROOT, SAMPLES, chooseSample, expect, launchStudio, openAiMenu, test } from './studio.js';

// 画面の骨組み(ux-redesign.md 3 節、7-1、7-2)。上の帯と、左「試す」・右「言葉で直す」の 2 列

// 「分かるか」の確かめ(ux-redesign.md 9 節)のスクリーンショットの置き場。test-results/ は git が無視する
const UX_SHOTS = path.join(ROOT, 'test-results', 'ux');

// 要素が、スクロールしないで見える場所(画面の中)にあることを確かめる
async function expectInViewport(page, locator, label) {
  await expect(locator, label).toBeVisible();
  const box = await locator.boundingBox();
  const { width, height } = page.viewportSize();
  expect(box, label).not.toBeNull();
  expect(box.x, `${label} の左`).toBeGreaterThanOrEqual(0);
  expect(box.y, `${label} の上`).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width, `${label} の右`).toBeLessThanOrEqual(width);
  expect(box.y + box.height, `${label} の下`).toBeLessThanOrEqual(height);
}

for (const size of [
  { width: 1440, height: 900 },
  { width: 1280, height: 800 },
]) {
  test(`U6: ${size.width}x${size.height} で、試作品の会話の欄と、直す欄の依頼の欄と「送る」が、スクロールなしで見える`, async ({ page, home }) => {
    const studio = await launchStudio(home);
    try {
      await page.setViewportSize(size);
      await page.goto(studio.url);
      const app = page.frameLocator('iframe[title="試作品"]');
      await expect(app.getByRole('heading', { name: 'しおかぜ求人相談' })).toBeVisible();

      expect(await page.evaluate(() => window.scrollY)).toBe(0);
      const chat = app.getByRole('region', { name: '会話' });
      await expectInViewport(page, chat, '試作品の会話の欄');
      await expectInViewport(page, chat.getByLabel('メッセージ'), '試作品の会話の入力');
      await expectInViewport(page, chat.getByRole('button', { name: '送る' }), '試作品の会話の「送る」');
      const make = page.getByRole('region', { name: '言葉で直す' });
      await expectInViewport(page, make.getByLabel('依頼'), '直す欄の依頼の欄');
      await expectInViewport(page, make.getByRole('button', { name: '送る' }), '直す欄の「送る」');

      // 左の「試す」が約 6 割、右の「言葉で直す」が約 4 割
      const tryBox = await page.getByRole('region', { name: '試す' }).boundingBox();
      const makeBox = await make.boundingBox();
      expect(tryBox.x).toBeLessThan(makeBox.x);
      const share = tryBox.width / (tryBox.width + makeBox.width);
      expect(share).toBeGreaterThan(0.55);
      expect(share).toBeLessThan(0.65);
    } finally {
      await studio.stop();
    }
  });
}

test('U9: 試す欄の上のボタンは、AI の切り替えを除くと「会話を最初から」だけ。最初の画面に保存の印と接続の印は出ない', async ({ page, home }) => {
  const studio = await launchStudio(home);
  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(studio.url);
    const app = page.frameLocator('iframe[title="試作品"]');
    await expect(app.getByRole('heading', { name: 'しおかぜ求人相談' })).toBeVisible();

    // 試す欄の上
    const toolbar = page.locator('#try-toolbar');
    await expect(toolbar.locator('#ai-switch')).toBeVisible();
    await expect(toolbar.getByRole('button').and(page.locator(':not(#ai-switch)'))).toHaveText(['会話を最初から']);
    // 開き直す、作り直すは、試す欄の上にない(P22 で「その他」の引き出しへ移すまでは、下の詳細にある)
    for (const name of ['開き直す', '作り直す', 'リセット']) {
      await expect(page.getByRole('region', { name: '試す' }).getByRole('button', { name })).toHaveCount(0);
    }

    // 上の帯: 試作品の切り替え、保存、その他
    const topbar = page.getByRole('banner');
    await expect(topbar.getByRole('button', { name: `試作品: ${SAMPLES.jobConsult.name}` })).toBeVisible();
    await expect(topbar.getByRole('button', { name: '保存', exact: true })).toBeVisible();
    await expect(topbar.getByRole('button', { name: 'その他' })).toBeVisible();

    // 何もしていない最初の画面に、保存の印と「つながっています」が出ない
    await expect(page.locator('#save-mark')).toBeHidden();
    await expect(page.locator('#connection')).toBeHidden();
    await expect(page.getByText('つながっています')).toHaveCount(0);
    await expect(page.getByText('保存していない変更があります')).toBeHidden();
    // 一覧の読み込みが 1 回終わった後も、出ないまま
    await page.waitForResponse((response) => response.url().endsWith('/api/projects'));
    await expect(page.locator('#save-mark')).toBeHidden();
    await expect(page.locator('#connection')).toBeHidden();

    // 最初の画面を 1440x900 で撮る(新しい文脈のエージェントに見せ、人の 5 秒の確かめにも使う)
    await page.screenshot({ path: path.join(UX_SHOTS, 'P21-first.png') });
  } finally {
    await studio.stop();
  }
});

test('保存していない変更があるときだけ保存の印が出て、上の帯の「保存」で消える', async ({ page, home }) => {
  const studio = await launchStudio(home);
  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(studio.url);
    const app = page.frameLocator('iframe[title="試作品"]');
    const mark = page.locator('#save-mark');
    await expect(app.getByRole('heading', { name: 'しおかぜ求人相談' })).toBeVisible();
    await expect(mark).toBeHidden();

    // 試作品の中の AI と話すと、会話が保存していない変更になる
    await app.getByLabel('メッセージ').fill('カフェで働きたいです');
    await app.getByRole('button', { name: '送る' }).click();
    await expect(app.getByRole('region', { name: '会話' }).getByRole('listitem').last()).toContainText('職種「カフェのホール」と理解しました');
    await expect(mark).toHaveText('保存していない変更があります');

    // AI と話している画面を 1440x900 で撮る
    await page.screenshot({ path: path.join(UX_SHOTS, 'P21-talking.png') });

    await page.getByRole('banner').getByRole('button', { name: '保存', exact: true }).click();
    await expect(page.locator('#versions-message')).toHaveText('v1 として保存しました。');
    await expect(mark).toBeHidden();
    await expect(page.locator('#working-status')).toHaveText('作業中は保存版 v1 と同じです。');
  } finally {
    await studio.stop();
  }
});

test('試作品の切り替えは上の帯のメニューで、各行に短い印が出る。AI の切り替えは試す欄の上で開く', async ({ page, home }) => {
  const studio = await launchStudio(home);
  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(studio.url);
    const menuButton = page.locator('#project-menu-button');
    const menu = page.getByRole('navigation', { name: '試作品の一覧' });

    // 一覧は最初は閉じていて、押すと開き、Esc で閉じる
    await expect(menu).toBeHidden();
    await menuButton.click();
    await expect(menu).toBeVisible();
    await expect(menuButton).toHaveAttribute('aria-expanded', 'true');
    // AI と話せるかは名前に入っている。表示できる試作品には、ほかの印は付かない
    await expect(menu.getByRole('button')).toHaveText([SAMPLES.jobConsult.name, SAMPLES.studyConsult.name, SAMPLES.library.name]);
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();
    await expect(menuButton).toBeFocused();

    // 選ぶと閉じ、上の帯の名前が変わる。AI のない試作品では、AI の切り替えを出さない
    await chooseSample(page, SAMPLES.library);
    await expect(menu).toBeHidden();
    await expect(menuButton).toHaveText(`試作品: ${SAMPLES.library.name} ▾`);
    await expect(page.locator('#ai-switch')).toBeHidden();

    // AI の切り替えは、今の接続の選び方を試す欄の上に開く
    await chooseSample(page, SAMPLES.jobConsult);
    await expect(page.locator('#ai-switch')).toHaveText('AI: モック ▾');
    await expect(page.locator('#ai-menu')).toBeHidden();
    await openAiMenu(page);
    await expect(page.locator('#ai-menu').getByRole('radio', { name: 'モック' })).toBeChecked();
    await page.keyboard.press('Escape');
    await expect(page.locator('#ai-menu')).toBeHidden();
  } finally {
    await studio.stop();
  }
});

test('1024 より狭いときは、試すと直すを上下に並べる', async ({ page, home }) => {
  const studio = await launchStudio(home);
  try {
    await page.setViewportSize({ width: 900, height: 900 });
    await page.goto(studio.url);
    await expect(page.frameLocator('iframe[title="試作品"]').getByRole('heading', { name: 'しおかぜ求人相談' })).toBeVisible();
    const tryBox = await page.getByRole('region', { name: '試す' }).boundingBox();
    const makeBox = await page.getByRole('region', { name: '言葉で直す' }).boundingBox();
    expect(makeBox.y).toBeGreaterThanOrEqual(tryBox.y + tryBox.height);
    expect(Math.abs(makeBox.x - tryBox.x)).toBeLessThan(2);
  } finally {
    await studio.stop();
  }
});
