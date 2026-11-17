import fs from 'node:fs/promises';
import path from 'node:path';
import { ROOT, closeMore, expect, goStage, launchStudio, measureTextContrast as measure, openAiMenu, openDevDetails, openMaterials, test } from './studio.js';

// 見た目の土台(docs/design/ui-ux-v2.md の 3.7、7、10、11 節)。偽接続(STUDIO_AGENT=fake)で起動し、実モデルは呼ばない。
// 字と地の差、動きを止める、会議室の大きさ、表示のメニューの色の切り替えを、本物の画面で確かめる

// スクリーンショットの置き場。test-results/ は git が無視する
const UX_SHOTS = path.join(ROOT, 'test-results', 'ux');
// 10.1 の --color-bg
const BG = { light: 'rgb(244, 245, 246)', dark: 'rgb(15, 17, 19)' };

async function openStudio(page, studio) {
  await page.goto(studio.url);
  await expect(page.frameLocator('iframe[title="試作品"]').getByRole('heading', { name: 'しおかぜ求人相談' })).toBeVisible();
}

// 表示のメニューを開く(開いていれば、そのまま)
async function openDisplay(page) {
  const button = page.getByRole('banner').getByRole('button', { name: '表示' });
  if ((await button.getAttribute('aria-expanded')) !== 'true') await button.click();
  const menu = page.getByRole('group', { name: '表示' });
  await expect(menu).toBeVisible();
  return menu;
}

async function closeDisplay(page) {
  const button = page.getByRole('banner').getByRole('button', { name: '表示' });
  if ((await button.getAttribute('aria-expanded')) === 'true') await button.click();
  await expect(page.locator('#display-menu')).toBeHidden();
}

async function chooseTheme(page, name) {
  const menu = await openDisplay(page);
  await menu.getByRole('radio', { name }).check();
}

const background = (page) => page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor);

// 開いた画面ごとに測り、全部の字の結果をまとめる
async function measureScreens(page, testInfo, label) {
  const all = [];
  const record = async (screen) => {
    const results = await measure(page);
    for (const result of results) all.push({ ...result, screen });
    console.log(`[${label}] ${screen}: 字の要素 ${results.length}、一番低い差 ${results[0].ratio}(${results[0].where}「${results[0].text}」)`);
  };
  // 1. 最初の画面(段の道筋、今の行、試す、言葉で直す、次の一手の帯)
  await record('最初の画面');
  // 2. 表示のメニューを開いた画面
  await openDisplay(page);
  await record('表示のメニュー');
  await closeDisplay(page);
  // 3. 試作品の中の AI の切り替えを開いた画面
  await openAiMenu(page);
  await record('AI の切り替え');
  await page.locator('#ai-switch').click();
  // 4. 仕組みの引き出しを開いた画面
  await openDevDetails(page);
  await record('仕組みの引き出し');
  await closeMore(page);
  // 5. 素材を開いた画面
  await openMaterials(page);
  await record('素材');
  await closeMore(page);
  // 6. 段 9 の作業台(本番開発へ渡す)と、段 4 のまだの段の作業台
  await goStage(page, '渡す');
  await record('段 9 渡す');
  await goStage(page, '審査');
  await record('段 4 審査(まだ)');
  await goStage(page, '作る');
  all.sort((a, b) => a.ratio - b.ratio);
  await testInfo.attach(`contrast-${label}.json`, { body: JSON.stringify(all, null, 2), contentType: 'application/json' });
  return all;
}

for (const theme of ['light', 'dark']) {
  test(`見えている字の全部が、字と地の差 4.5:1 以上(${theme})。字は 13px 以上で、外から何も読み込まない`, async ({ page, home }, testInfo) => {
    const studio = await launchStudio(home);
    const requests = [];
    page.on('request', (req) => requests.push(new URL(req.url())));
    try {
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.emulateMedia({ colorScheme: theme });
      await openStudio(page, studio);
      expect(await background(page)).toBe(BG[theme]);

      const results = await measureScreens(page, testInfo, theme);
      expect(results.length).toBeGreaterThan(100);
      const lowest = results[0];
      // 一番低い値と場所は、ui-ux-v2.md の 3.7 に書き写す
      console.log(`[${theme}] 字の要素 ${results.length}、一番低い差 ${lowest.ratio}(${lowest.screen}: ${lowest.where}「${lowest.text}」)`);
      const failing = results.filter((result) => result.ratio < 4.5);
      expect(failing, JSON.stringify(failing, null, 2)).toEqual([]);
      // 10.2: 最小の字は 13px(--text-1)
      const small = results.filter((result) => result.fontSize < 13);
      expect(small, JSON.stringify(small, null, 2)).toEqual([]);

      await fs.mkdir(UX_SHOTS, { recursive: true });
      await page.screenshot({ path: path.join(UX_SHOTS, `appearance-${theme}.png`) });
      await openDisplay(page);
      await page.screenshot({ path: path.join(UX_SHOTS, `appearance-${theme}-display-menu.png`) });

      // 字は OS の字だけ。Studio の画面の読み込みは、127.0.0.1 の外に出ない
      const outside = requests.filter((url) => /^https?:$/.test(url.protocol) && !['127.0.0.1', 'localhost'].includes(url.hostname));
      expect(outside.map((url) => url.href)).toEqual([]);
      expect(await page.evaluate(() => [...document.fonts].length)).toBe(0);
    } finally {
      await studio.stop();
    }
  });
}

test('表示のメニューで、ライト、ダーク、OS に従うが切り替わり、読み込み直しても覚えている', async ({ page, home }) => {
  const studio = await launchStudio(home);
  try {
    await page.emulateMedia({ colorScheme: 'light' });
    await openStudio(page, studio);
    const html = page.locator('html');

    // 既定は OS に従う
    const menu = await openDisplay(page);
    await expect(menu.getByRole('radio', { name: 'OS に従う' })).toBeChecked();
    await expect(html).not.toHaveAttribute('data-theme');
    expect(await background(page)).toBe(BG.light);

    // ダークを選ぶと、OS がライトでもダークになる
    await chooseTheme(page, 'ダーク');
    await expect(html).toHaveAttribute('data-theme', 'dark');
    expect(await background(page)).toBe(BG.dark);
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme)).toBe('dark');

    // 読み込み直しても覚えている
    await page.reload();
    await expect(html).toHaveAttribute('data-theme', 'dark');
    expect(await background(page)).toBe(BG.dark);
    await expect((await openDisplay(page)).getByRole('radio', { name: 'ダーク' })).toBeChecked();

    // ライトを選ぶと、OS がダークでもライトになる
    await page.emulateMedia({ colorScheme: 'dark' });
    await chooseTheme(page, 'ライト');
    await expect(html).toHaveAttribute('data-theme', 'light');
    expect(await background(page)).toBe(BG.light);

    // OS に従うに戻すと、OS の設定(今はダーク)になる
    await chooseTheme(page, 'OS に従う');
    await expect(html).not.toHaveAttribute('data-theme');
    expect(await background(page)).toBe(BG.dark);
    await page.emulateMedia({ colorScheme: 'light' });
    expect(await background(page)).toBe(BG.light);

    // メニューは Esc で閉じ、焦点は「表示」のボタンに戻る
    await openDisplay(page);
    await page.keyboard.press('Escape');
    await expect(page.locator('#display-menu')).toBeHidden();
    await expect(page.getByRole('banner').getByRole('button', { name: '表示' })).toBeFocused();
  } finally {
    await studio.stop();
  }
});

// 動いている要素(CSS の animation と transition)を数える。動くものがなければ空
function movingElements() {
  const moving = [];
  for (const element of document.querySelectorAll('*')) {
    for (const pseudo of [null, '::before', '::after']) {
      const style = getComputedStyle(element, pseudo);
      const seconds = (list) => list.split(',').map((value) => parseFloat(value) || 0);
      const animated = style.animationName !== 'none' && seconds(style.animationDuration).some((value) => value > 0);
      const transitioned = seconds(style.transitionDuration).some((value) => value > 0);
      if (animated || transitioned) moving.push(`${element.localName}${element.id ? `#${element.id}` : ''}${pseudo ?? ''}`);
    }
  }
  return { moving: moving.slice(0, 20), count: moving.length, running: document.getAnimations().length };
}

// ボタンに焦点と指を当て、状態の変化(縁と色)の動きを起こす
async function poke(page) {
  const save = page.getByRole('banner').getByRole('button', { name: '素材', exact: true });
  await save.hover();
  await page.getByRole('banner').getByRole('button', { name: '表示' }).hover();
  return page.evaluate(movingElements);
}

test('動きは止められる: OS の「視差効果を減らす」と、表示のメニューの「動きを止める」の両方で、動く要素がない', async ({ page, home }) => {
  const studio = await launchStudio(home);
  try {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await openStudio(page, studio);

    // 止めていないときは、状態の変化が短く動く(測り方が動きを見つけられることの確かめ)
    const moving = await poke(page);
    expect(moving.count).toBeGreaterThan(0);

    // OS の設定
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const reduced = await poke(page);
    expect(reduced, JSON.stringify(reduced)).toEqual({ moving: [], count: 0, running: 0 });

    // 表示のメニューの「動きを止める」。OS の設定と同じ効き方
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    expect((await poke(page)).count).toBeGreaterThan(0);
    const menu = await openDisplay(page);
    await menu.getByRole('checkbox', { name: '動きを止める' }).check();
    await expect(page.locator('html')).toHaveAttribute('data-motion', 'off');
    await closeDisplay(page);
    const off = await poke(page);
    expect(off, JSON.stringify(off)).toEqual({ moving: [], count: 0, running: 0 });

    // 読み込み直しても止まったまま
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-motion', 'off');
    expect((await poke(page)).count).toBe(0);
  } finally {
    await studio.stop();
  }
});

test('会議室の大きさ: html の字が 1.25 倍になり、本文が 20px、最小の字が 16.25px になる。ライトとダークで撮る', async ({ page, home }, testInfo) => {
  const studio = await launchStudio(home);
  try {
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.emulateMedia({ colorScheme: 'light' });
    await openStudio(page, studio);
    const fontSize = (selector) => page.locator(selector).evaluate((node) => getComputedStyle(node).fontSize);
    expect(await fontSize('body')).toBe('16px');

    const menu = await openDisplay(page);
    await menu.getByRole('checkbox', { name: '会議室の大きさ' }).check();
    await expect(page.locator('html')).toHaveAttribute('data-room', 'on');
    expect(await fontSize('html')).toBe('20px');
    expect(await fontSize('body')).toBe('20px');
    // --text-3(本文)で書いた字も 20px。試す欄の見出し
    expect(await fontSize('.toolbar h2')).toBe('20px');
    await closeDisplay(page);

    // 見えている字は全部 16.25px(13px の 1.25 倍)以上
    const results = await measure(page);
    const small = results.filter((result) => result.fontSize < 16.25);
    expect(small, JSON.stringify(small, null, 2)).toEqual([]);
    expect(results.filter((result) => result.ratio < 4.5)).toEqual([]);

    await fs.mkdir(UX_SHOTS, { recursive: true });
    await page.screenshot({ path: path.join(UX_SHOTS, 'appearance-room-light.png') });
    await chooseTheme(page, 'ダーク');
    await closeDisplay(page);
    expect(await background(page)).toBe(BG.dark);
    expect((await measure(page)).filter((result) => result.ratio < 4.5)).toEqual([]);
    await page.screenshot({ path: path.join(UX_SHOTS, 'appearance-room-dark.png') });
    await testInfo.attach('room-dark', { path: path.join(UX_SHOTS, 'appearance-room-dark.png'), contentType: 'image/png' });

    // 外すと戻る。読み込み直しても覚えている
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-room', 'on');
    const again = await openDisplay(page);
    await again.getByRole('checkbox', { name: '会議室の大きさ' }).uncheck();
    expect(await fontSize('body')).toBe('16px');
  } finally {
    await studio.stop();
  }
});
