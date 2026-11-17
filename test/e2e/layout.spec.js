import path from 'node:path';
import { ROOT, SAMPLES, chooseSample, expect, launchStudio, openAiMenu, openDevDetails, openMaterials, openMechanism, test } from './studio.js';

// 画面の骨組み(ux-redesign.md 3 節、7-1、7-2、7-7。ui-ux-v2.md の 2.2 で枠を足した)。上の帯と、左「試す」・右「言葉で直す」の 2 列と、仕組みの引き出し

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
      const make = page.getByRole('region', { name: '作る AI', exact: true });
      await expectInViewport(page, make.getByLabel('依頼'), '直す欄の依頼の欄');
      await expectInViewport(page, make.getByRole('button', { name: '送る' }), '直す欄の「送る」');

      // 左の「試す」が約 6 割、右の「言葉で直す」が約 4 割
      const tryBox = await page.getByRole('region', { name: '試作品', exact: true }).boundingBox();
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
    // 画面を読み込み直す(開き直す)、ファイルから作り直す(作り直す)は、試す欄の上にない。仕組みの引き出しにある
    for (const name of ['画面を読み込み直す', 'ファイルから作り直す', '開き直す', '作り直す', 'リセット']) {
      await expect(page.getByRole('region', { name: '試作品', exact: true }).getByRole('button', { name })).toHaveCount(0);
    }

    // 上の帯: 試作品の切り替え、保存、素材、表示。「その他」はなくした(ui-ux-v2.md の 13 節)
    const topbar = page.getByRole('banner');
    await expect(topbar.getByRole('button', { name: `試作品: ${SAMPLES.jobConsult.name}` })).toBeVisible();
    await expect(topbar.getByRole('button', { name: '保存', exact: true })).toBeVisible();
    await expect(topbar.getByRole('button', { name: '素材', exact: true })).toBeVisible();
    await expect(topbar.getByRole('button', { name: '表示' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'その他' })).toHaveCount(0);

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
    await expect(page.locator('#versions-message')).toHaveText('保存しました(保存 1)。');
    await expect(mark).toBeHidden();
    await expect(page.locator('#working-status')).toHaveText('今の状態は保存 1 と同じです。');
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
    await expect(menu.getByRole('button')).toHaveText([SAMPLES.jobConsult.name, SAMPLES.studyConsult.name, SAMPLES.partTime.name, SAMPLES.library.name, '新しく作る', 'お客さんとの会を始める']);
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
    await expect(page.locator('#ai-switch')).toHaveText('▲ お試し ▾');
    await expect(page.locator('#ai-menu')).toBeHidden();
    await openAiMenu(page);
    await expect(page.locator('#ai-menu').getByRole('radio', { name: 'お試しの AI', exact: true })).toBeChecked();
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
    const tryBox = await page.getByRole('region', { name: '試作品', exact: true }).boundingBox();
    const makeBox = await page.getByRole('region', { name: '作る AI', exact: true }).boundingBox();
    expect(makeBox.y).toBeGreaterThanOrEqual(tryBox.y + tryBox.height);
    expect(Math.abs(makeBox.x - tryBox.x)).toBeLessThan(2);
  } finally {
    await studio.stop();
  }
});

test('U5: 準備の結果、AI のやりとりの記録、AI が覚えていることは、最初は見えない。仕組みの引き出しを開くと見える', async ({ page, home }) => {
  const studio = await launchStudio(home);
  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(studio.url);
    const app = page.frameLocator('iframe[title="試作品"]');
    await expect(app.getByRole('heading', { name: 'しおかぜ求人相談' })).toBeVisible();

    // 中身は読み込み済み(要素はある)だが、見えない。AI が覚えていることは、試作品の中の「希望条件」とだけ見える
    const build = page.locator('#build-status');
    const trace = page.locator('#ai-trace');
    const state = page.locator('dl[aria-label="AI が理解した状態"]');
    await expect(build).toContainText('ビルドに成功しました');
    await expect(trace).toContainText('まだ記録はありません');
    await expect(state).toBeAttached();
    for (const [locator, label] of [
      [build, '準備の結果'],
      [trace, 'AI のやりとりの記録'],
      [state, 'AI が覚えていること'],
      [page.locator('#mechanism'), '仕組みの引き出し'],
      [page.locator('#materials'), '素材'],
    ]) {
      await expect(locator, label).toBeHidden();
    }
    await expect(app.getByRole('region', { name: '希望条件' })).toBeVisible();

    // 試作品の中の AI と話しても、開発者向けの情報は出てこない
    await app.getByLabel('メッセージ').fill('カフェで働きたいです');
    await app.getByRole('button', { name: '送る' }).click();
    await expect(app.getByRole('region', { name: '会話' }).getByRole('listitem').last()).toContainText('職種「カフェのホール」と理解しました');
    await expect(page.getByRole('list', { name: 'AI の実行の記録', includeHidden: true }).getByRole('listitem', { includeHidden: true })).not.toHaveCount(0);
    await expect(trace).toBeHidden();
    await expect(state).toBeHidden();

    // 素材: 自分のトークンをつなぐ、部品と指針をつなぐ。開いても、左の試作品は見えたまま。仕組みの中身はまだ見えない
    const materials = await openMaterials(page);
    await expect(materials.getByRole('heading', { level: 3 })).toHaveText(['自分のトークンをつなぐ', '部品と指針をつなぐ']);
    await expect(build).toBeHidden();
    await expect(app.getByRole('region', { name: '会話' })).toBeVisible();

    // 仕組みを見る: 準備の結果、AI のやりとりの記録、AI が覚えていることが見える。素材は閉じる(引き出しは 1 つずつ)
    const button = page.locator('#mechanism-button');
    await expect(button).toHaveAttribute('aria-expanded', 'false');
    await openDevDetails(page);
    await expect(button).toHaveAttribute('aria-expanded', 'true');
    await expect(materials).toBeHidden();
    await expect(build).toBeVisible();
    await expect(trace).toBeVisible();
    await expect(state).toBeVisible();
    await expect(state.getByRole('definition')).toHaveText(['カフェのホール', '未定', '未定', '未定']);
    // 試験用の依頼は、偽接続(STUDIO_AGENT=fake)のときだけ出る
    await expect(page.locator('#dev-details').getByRole('heading', { level: 3 })).toHaveText([
      'プロンプト',
      '作る AIの接続',
      '試験用の依頼',
      'ビルド',
      'プロダクト内 AI',
      'AI の実行の記録',
      '試作品からの知らせ',
      '画面を読み込み直す',
    ]);
    // 引き出しは作業台を隠さず、横に並ぶ(試作品は見えたまま)
    await expect(app.getByRole('region', { name: '会話' })).toBeVisible();
    const drawerBox = await page.locator('#mechanism').boundingBox();
    const tryBox = await page.getByRole('region', { name: '試作品', exact: true }).boundingBox();
    expect(tryBox.x + tryBox.width).toBeLessThanOrEqual(drawerBox.x + 1);
    await page.screenshot({ path: path.join(UX_SHOTS, 'P22-dev.png') });

    // Esc で閉じ、焦点は「仕組みを見る」に戻る。. のキーで開き、もう一度で閉じる
    await page.keyboard.press('Escape');
    await expect(page.locator('#mechanism')).toBeHidden();
    await expect(button).toBeFocused();
    await expect(button).toHaveAttribute('aria-expanded', 'false');
    await page.keyboard.press('.');
    await expect(page.locator('#mechanism')).toBeVisible();
    await expect(build).toBeVisible();
    await page.keyboard.press('.');
    await expect(page.locator('#mechanism')).toBeHidden();
    // 閉じるボタンでも閉じる
    const panel = await openMechanism(page);
    await panel.getByRole('button', { name: '仕組みを閉じる' }).click();
    await expect(page.locator('#mechanism')).toBeHidden();
    await expect(button).toBeFocused();
  } finally {
    await studio.stop();
  }
});

test('「画面を読み込み直す」と「ファイルから作り直す」は仕組みの引き出しにあり、押すとそれぞれ動く', async ({ page, home }) => {
  const studio = await launchStudio(home);
  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(studio.url);
    const app = page.frameLocator('iframe[title="試作品"]');
    const log = app.getByRole('region', { name: '会話' }).getByRole('listitem');
    await expect(app.getByRole('heading', { name: 'しおかぜ求人相談' })).toBeVisible();
    await app.getByLabel('メッセージ').fill('カフェで働きたいです');
    await app.getByRole('button', { name: '送る' }).click();
    await expect(log.last()).toContainText('職種「カフェのホール」と理解しました');
    const count = await log.count();

    const tryRegion = page.getByRole('region', { name: '試作品', exact: true });
    const reopen = page.getByRole('button', { name: '画面を読み込み直す', includeHidden: true });
    const rebuild = page.getByRole('button', { name: 'ファイルから作り直す', includeHidden: true });
    await expect(reopen).toHaveCount(1);
    await expect(rebuild).toHaveCount(1);
    await expect(tryRegion.getByRole('button', { name: '画面を読み込み直す', includeHidden: true })).toHaveCount(0);
    await expect(tryRegion.getByRole('button', { name: 'ファイルから作り直す', includeHidden: true })).toHaveCount(0);
    // どちらも仕組みの引き出しの中
    await expect(page.locator('#mechanism #reopen')).toHaveCount(1);
    await expect(page.locator('#mechanism #rebuild')).toHaveCount(1);

    // 画面を読み込み直すと、試作品を開き直す。会話はそのまま
    const panel = await openMechanism(page);
    const frame = page.locator('iframe[title="試作品"]');
    const before = await frame.elementHandle();
    await panel.getByRole('button', { name: '画面を読み込み直す' }).click();
    await expect.poll(async () => (await frame.elementHandle()) !== null && !(await before.evaluate((el) => el.isConnected))).toBe(true);
    await expect(app.getByRole('heading', { name: 'しおかぜ求人相談' })).toBeVisible();
    await expect(log).toHaveCount(count);

    // ファイルから作り直すと、もう一度ビルドする
    await openDevDetails(page);
    await expect(rebuild).toBeVisible();
    const builds = page.waitForResponse((response) => response.url().endsWith('/builds') && response.request().method() === 'POST');
    await rebuild.click();
    expect((await builds).ok()).toBe(true);
    await expect(page.locator('#build-status')).toContainText('ビルドに成功しました');
  } finally {
    await studio.stop();
  }
});
