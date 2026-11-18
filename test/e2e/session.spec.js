import fs from 'node:fs/promises';
import path from 'node:path';
import { ROOT, expect, expectNoDevWordsOnScreen, expectStartReadable, launchStudio, measureTextContrast, test, writeProject } from './studio.js';

// 1 時間の会の帯と、会の始めと終わり、段 9 の渡す(docs/design/ui-ux-v2.md の 2.7、4.8、5.4、11 節。UI/UX の 8 枚目)。
// 会の試作品では、段の道筋の代わりに 7 つの帯と予定の分を出す。予定を過ぎても赤くせず、文で言う。字は会議室の大きさで始まる。
// 会の試作品の間は、開発の言葉を出さず、「データは架空です」を今の行に出し続ける。
// 偽接続(STUDIO_AGENT=fake)で動かし、実モデルは呼ばない。会はお試しの AI か、偽接続の同意で始める。題材は架空

const UX_SHOTS = path.join(ROOT, 'test-results', 'ux');
const PURPOSE = '架空の花屋の、配達の受付を考える会';
const BANDS = [
  ['始める', 5],
  ['聞く、AI が整理する', 20],
  ['審査', 8],
  ['作る', 10],
  ['見せる', 8],
  ['直す', 5],
  ['渡す', 4],
];

async function createMeeting(page) {
  await page.locator('#project-menu-button').click();
  await page.getByRole('button', { name: 'お客さんとの会を始める' }).click();
  await page.getByLabel('会の目的').fill(PURPOSE);
  await page.getByRole('button', { name: '会を用意する' }).click();
  await expect(page.getByRole('heading', { level: 2, name: '会の始め' })).toBeVisible();
}

// お客さんの前(5.4): 開発の言葉がなく、今の行に「データは架空です」
async function expectCustomerFront(page) {
  await expect(page.getByRole('region', { name: '今の行' }).getByText('データは架空です', { exact: true })).toBeVisible();
  await expect(page.locator('#dev-agent-mark')).toBeHidden();
  await expectNoDevWordsOnScreen(page);
}

async function shoot(page, name) {
  await fs.mkdir(UX_SHOTS, { recursive: true });
  for (const theme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: theme });
    await page.waitForTimeout(150);
    await page.screenshot({ path: path.join(UX_SHOTS, `session-${name}-${theme}.png`) });
  }
  await page.emulateMedia({ colorScheme: 'light' });
}

test('会の試作品では、会の帯が 7 つの帯と予定の分、使った分を出す。予定を過ぎると赤ではなく文で言う。帯を押すと作業台が開き、「9 段で見る」で段の道筋も出せる', async ({ page, home }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1280, height: 800 });
  const studio = await launchStudio(home);
  try {
    await page.goto(studio.url);
    // 会ではない試作品では、段の道筋(9 段)
    await expect(page.locator('#stage-list')).toBeVisible();
    await expect(page.locator('#meeting-band')).toBeHidden();
    await expect(page.locator('#rail-toggle')).toBeHidden();
    await createMeeting(page);

    // 会の帯: 7 つの帯と予定の分。段の道筋は出さない
    const band = page.getByRole('list', { name: '会の帯' });
    await expect(band).toBeVisible();
    await expect(page.locator('#stage-list')).toBeHidden();
    const items = band.locator('button.band');
    await expect(items).toHaveCount(7);
    for (const [index, [name, plan]] of BANDS.entries()) {
      await expect(items.nth(index).locator('.band-name')).toHaveText(name);
      await expect(items.nth(index).locator('.band-minutes')).toHaveText(new RegExp(`^(\\d+|─) / ${plan} 分$`));
    }
    // 会の始めは「始める」の帯。使った分は 0 分から数える
    await expect(band.locator('[aria-current="step"]')).toHaveCount(1);
    await expect(items.first()).toHaveAttribute('aria-current', 'step');
    await expect(items.first().locator('.band-minutes')).toHaveText('0 / 5 分');
    await expect(page.locator('#stage-count')).toHaveText('会 0 / 60 分');
    await expectCustomerFront(page);

    // 会の始め(4.8): 同意、消す日、題材が架空であること、記録に入れないもの、本物の AI を使うか。次の一手は「同意して始める」
    const facts = page.locator('#meeting-facts');
    for (const term of ['題材', '記録に入れないもの', '本物の AI', '何を送るか', '置き場']) await expect(facts.getByRole('term').filter({ hasText: new RegExp(`^${term}$`) })).toHaveCount(1);
    await expect(page.getByLabel('消す日')).not.toHaveValue('');
    const next = page.getByRole('region', { name: '次の一手' });
    await expect(next.getByRole('button', { name: '同意して始める' })).toBeVisible();
    await shoot(page, 'start');
    await next.getByRole('button', { name: '同意して始める' }).click();

    // 聞く、AI が整理する: 整理の板が開き、始めるは済み(✓)
    await expect(page.locator('#organize')).toBeVisible();
    await expect(items.nth(1)).toHaveAttribute('aria-current', 'step');
    await expect(items.first()).toHaveAttribute('data-state', 'done');
    await expect(items.first()).toContainText('✓');
    await expect(items.nth(1)).toHaveAttribute('data-state', 'now');
    await expect(items.nth(1).locator('.band-minutes')).toHaveText('0 / 20 分');
    await expect(page.locator('.band-over')).toHaveCount(0);
    await expectCustomerFront(page);

    // 23 分たった(画面の時計だけを進める)。聞くの帯は 23 / 20 分で、赤ではなく文で「予定を 3 分過ぎています」と言う
    await page.clock.setFixedTime(Date.now() + 23 * 60_000 + 5_000);
    await items.nth(1).click();
    await expect(items.nth(1).locator('.band-minutes')).toHaveText('23 / 20 分');
    const over = items.nth(1).locator('.band-over');
    await expect(over).toHaveText('予定を 3 分過ぎています');
    // 色は本文と同じ(赤くしない)。過ぎた帯の分の字も、失敗の色(--color-danger)ではない
    const color = (locator) => locator.evaluate((node) => getComputedStyle(node).color);
    const danger = await page.evaluate(() => {
      const probe = document.createElement('span');
      probe.style.color = 'var(--color-danger)';
      document.body.append(probe);
      const value = getComputedStyle(probe).color;
      probe.remove();
      return value;
    });
    await page.mouse.move(0, 400);
    expect(await color(over)).toBe(await color(page.locator('#next-text')));
    expect(await color(items.nth(1).locator('.band-minutes'))).not.toBe(danger);
    expect(await color(items.nth(1))).not.toBe(danger);
    await shoot(page, 'band-over');

    // 帯を押すと、2.7 の表の作業台が開く
    await items.nth(6).click();
    await expect(page.getByRole('heading', { level: 2, name: '会の終わり' })).toBeVisible();
    await expect(items.nth(6)).toHaveAttribute('aria-current', 'step');
    await expectCustomerFront(page);
    await items.nth(3).click();
    await expect(page.locator('#bench-heading .bench-name')).toHaveText('作る');
    await expect(items.nth(3)).toHaveAttribute('aria-current', 'step');
    await items.nth(5).click();
    await expect(items.nth(5)).toHaveAttribute('aria-current', 'step');
    await expect(page.locator('body')).toHaveAttribute('data-side', 'maker');
    await items.nth(4).click();
    await expect(page.locator('#bench-heading .bench-name')).toHaveText('見せる');
    await expectCustomerFront(page);
    await items.first().click();
    await expect(page.getByRole('heading', { level: 2, name: '会の始め' })).toBeVisible();

    // 「9 段で見る」で段の道筋。段の印(会、整理)は段の下に戻る。もう一度押すと会の帯
    const toggle = page.getByRole('button', { name: '9 段で見る' });
    await toggle.click();
    await expect(page.locator('#stage-list')).toBeVisible();
    await expect(band).toBeHidden();
    await expect(page.locator('#stage-list [aria-current="step"]')).toHaveCount(1);
    await expect(page.locator('#stage-list li[data-stage="goal"] #meeting-mark')).toBeVisible();
    await page.getByRole('button', { name: '会の帯で見る' }).click();
    await expect(band).toBeVisible();
    await expect(band.locator('li[data-band="start"] #meeting-mark')).toBeVisible();
    await expect(band.locator('li[data-band="listen"] #organize-mark')).toBeVisible();
  } finally {
    await studio.stop();
  }
});

test('1024px より狭い窓では、会の帯が今の帯の 1 つのボタンにまとまり、押すと 7 つの帯を開く(2.8)', async ({ page, home }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 390, height: 700 });
  const studio = await launchStudio(home);
  try {
    await page.goto(studio.url);
    await createMeeting(page);
    const compact = page.locator('#stage-compact');
    const items = page.locator('#meeting-band button.band');
    // まとめたボタンは、今の帯の名前と使った分。7 つの帯は閉じたまま。段の印(会)は出したまま
    await expect(compact).toBeVisible();
    await expect(compact).toHaveText('始める 0 / 5 分 ▾');
    await expect(compact).toHaveAttribute('aria-controls', 'meeting-band');
    await expect(compact).toHaveAttribute('aria-expanded', 'false');
    await expect(items.first()).toBeHidden();
    await expect(page.locator('#stage-list')).toBeHidden();
    await expect(page.locator('#meeting-mark')).toBeVisible();
    // 上の帯と次の一手の帯は低いまま。会の始めの中身が最初の画面に入り、固定の次の一手の帯に隠れない(会議室の大きさの 1.25 倍でも)
    await expect(page.locator('html')).toHaveAttribute('data-room', 'on');
    const bar = await page.getByRole('banner').boundingBox();
    expect(bar.height).toBeLessThan(300);
    const nextBand = await page.locator('#next-band').boundingBox();
    expect(nextBand.height).toBeLessThan(700 / 4);
    await expectStartReadable(page.locator('#meeting-state'));
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
    await shoot(page, 'band-narrow');

    // 押すと 7 つの帯が開き、帯を選ぶと閉じて、その作業台に移る
    await compact.click();
    await expect(compact).toHaveAttribute('aria-expanded', 'true');
    await expect(items).toHaveCount(7);
    for (let i = 0; i < 7; i += 1) await expect(items.nth(i)).toBeVisible();
    await shoot(page, 'band-narrow-open');
    await items.nth(6).click();
    await expect(page.getByRole('heading', { level: 2, name: '会の終わり' })).toBeVisible();
    await expect(items.first()).toBeHidden();
    await expect(compact).toHaveText(/^渡す (\d+|─) \/ 4 分 ▾$/);
    // Escape でも閉じる
    await compact.click();
    await expect(items.first()).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(items.first()).toBeHidden();
    await expect(compact).toBeFocused();

    // 予定を過ぎたら、まとめたボタンでも文で言う
    await page.clock.setFixedTime(Date.now() + 9 * 60_000 + 5_000);
    await compact.click();
    await items.first().click();
    await expect(compact).toHaveText('始める 9 / 5 分、予定を 4 分過ぎています ▾');

    // 「9 段で見る」では、まとめたボタンは段の道筋の「n / 9 … ▾」に戻る
    await page.getByRole('button', { name: '9 段で見る' }).click();
    await expect(compact).toHaveText(/^\d \/ 9 .+ ▾$/);
    await expect(compact).toHaveAttribute('aria-controls', 'stage-list');
    await compact.click();
    await expect(page.locator('#stage-list button.stage')).toHaveCount(9);
    await expect(page.locator('#stage-list button.stage').first()).toBeVisible();
    await expect(items.first()).toBeHidden();
  } finally {
    await studio.stop();
  }
});

test('会の試作品では、字が会議室の大きさで始まり、表示のメニューで戻せる。1920x1080 で本文が 20px 以上、最小の字が 16.25px 以上', async ({ page, home }) => {
  test.setTimeout(90_000);
  const studio = await launchStudio(home);
  try {
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.goto(studio.url);
    const fontSize = (selector) => page.locator(selector).evaluate((node) => parseFloat(getComputedStyle(node).fontSize));
    // 会ではない試作品は、ふつうの大きさ
    await expect(page.locator('html')).not.toHaveAttribute('data-room', 'on');
    expect(await fontSize('body')).toBe(16);
    await createMeeting(page);
    await expect(page.locator('html')).toHaveAttribute('data-room', 'on');
    await page.getByRole('region', { name: '次の一手' }).getByRole('button', { name: 'お試しの AI だけで始める' }).or(page.getByRole('button', { name: 'お試しの AI だけで始める' })).first().click();
    await expect(page.locator('#organize')).toBeVisible();

    // 本文(作業台の文、次の一手の帯の 1 文)は 20px 以上。見えている字は全部 16.25px 以上(11 節)
    for (const selector of ['body', '#next-text', '#organize-state']) expect(await fontSize(selector), selector).toBeGreaterThanOrEqual(20);
    for (const colorScheme of ['light', 'dark']) {
      await page.emulateMedia({ colorScheme });
      const results = await measureTextContrast(page);
      const small = results.filter((result) => result.fontSize < 16.25);
      expect(small, JSON.stringify(small.slice(0, 5), null, 2)).toEqual([]);
      expect(results.filter((result) => result.ratio < 4.5)).toEqual([]);
    }
    await expectCustomerFront(page);
    await fs.mkdir(UX_SHOTS, { recursive: true });
    for (const theme of ['light', 'dark']) {
      await page.emulateMedia({ colorScheme: theme });
      // 色が切り替わる動き(--motion-quick)が終わるのを待つ
      await page.waitForTimeout(200);
      await page.screenshot({ path: path.join(UX_SHOTS, `session-room-1920-${theme}.png`) });
    }
    await page.emulateMedia({ colorScheme: 'light' });

    // 表示のメニューで戻せる。会ではない試作品に移ると、ふつうの大きさ(会の大きさとは別に覚える)
    await page.getByRole('banner').getByRole('button', { name: '表示' }).click();
    const room = page.getByRole('checkbox', { name: '会議室の大きさ' });
    await expect(room).toBeChecked();
    await room.uncheck();
    await expect(page.locator('html')).not.toHaveAttribute('data-room', 'on');
    expect(await fontSize('body')).toBe(16);
    await room.check();
    await expect(page.locator('html')).toHaveAttribute('data-room', 'on');
    await page.getByRole('banner').getByRole('button', { name: '表示' }).click();
    await page.locator('#project-menu-button').click();
    await page.getByRole('navigation', { name: '試作品の一覧' }).getByRole('button', { name: /求人相談/ }).click();
    await expect(page.locator('html')).not.toHaveAttribute('data-room', 'on');
    await expect(page.getByRole('region', { name: '今の行' }).getByText('データは架空です', { exact: true })).toBeHidden();
  } finally {
    await studio.stop();
  }
});

test('渡す(段 9): 渡すものの一覧と「そろった n / 7」。持ち主のない未決事項は「!」と文で出て、帯の 1 文が足りないものを言う。秘密らしい文字列で止めると ⬢ と場所が出る', async ({ page, home }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1280, height: 800 });
  // 未決事項のある試作品(目的の文書の「決めていないこと」)と、秘密らしい文字列を書いた試作品
  await writeProject(home, 'with-secret', { 'main.jsx': "import { KEY } from './config.js';\ndocument.getElementById('root').textContent = KEY ? '鍵あり' : '鍵なし';\n", 'config.js': "export const KEY = 'sk-ant-api03-abcdefghijklmnopqrstuvwx';\n" }, '鍵を書いた試作品');
  const studio = await launchStudio(home);
  try {
    const created = JSON.parse((await studio.post('/api/projects', { sentence: '架空の文具店で、在庫の問い合わせに AI が答えられるようにしたい', guide: 'fixed' })).text).project;
    const doc = { who: '文具店の店員(架空)', problem: '在庫の問い合わせに何度も答えている', scene: '開店前', success: '電話が減る', notDoing: ['取り寄せの手続き'], undecided: ['苦情は誰が受けるか'] };
    expect((await studio.post(`/api/projects/${created.id}/intent/start`, { sentence: doc.problem, guide: 'fixed', depth: 'quick' })).status).toBe(200);
    expect((await studio.post(`/api/projects/${created.id}/intent/decide`, { doc })).status).toBe(200);
    await page.goto(studio.url);
    await page.locator('#project-menu-button').click();
    await page.getByRole('navigation', { name: '試作品の一覧' }).getByRole('button', { name: /架空の文具店/ }).click();
    await page.locator('#stage-list button.stage[data-stage="handoff"]').click();
    const region = page.getByRole('region', { name: '本番開発へ渡す' });
    await expect(region).toBeVisible();

    // 渡すものの一覧。そろったものは ✓、足りないものは「!」
    const items = page.getByRole('list', { name: '渡すもの' }).getByRole('listitem');
    await expect(items).toHaveCount(7);
    await expect(page.locator('#handoff-ready')).toHaveText(/^そろった \d \/ 7$/);
    const ready = Number((await page.locator('#handoff-ready').innerText()).match(/そろった (\d)/)[1]);
    await expect(items.locator('.deliverable-mark', { hasText: '✓' })).toHaveCount(ready);
    await expect(items.locator('.deliverable-mark', { hasText: '!' })).toHaveCount(7 - ready);

    // 持ち主のない未決事項は「!」と文
    const unowned = page.locator('#handoff-unowned');
    await expect(unowned).toHaveText('持ち主のない未決事項が 1 つあります。持ち主を決めなくても渡せますが、渡した先で誰が決めるかが分からなくなります。');
    expect(await unowned.evaluate((node) => getComputedStyle(node, '::before').content)).toBe('"! "');
    const open = page.getByRole('list', { name: '持ち主と期日を決める一覧' }).getByRole('listitem');
    await expect(open).toHaveCount(1);
    await expect(open.first()).toContainText('苦情は誰が受けるか');
    await expect(open.first()).toContainText('持ち主なし');
    await expect(open.first().locator('.deliverable-mark')).toHaveText('!');
    await expect(page.getByRole('list', { name: '消せないもの' }).getByRole('listitem')).toHaveCount(2);
    // 渡す前に、帯の 1 文で何が足りないかを言う。足りないままでも渡せる
    const nextText = page.locator('#next-text');
    await expect(nextText).toContainText('未決事項(持ち主のないものが 1 つ)');
    await expect(nextText).toContainText('足りないままでも渡せます。');
    const next = page.getByRole('region', { name: '次の一手' });
    await expect(next.getByRole('button', { name: '本番開発へ渡す' })).toBeEnabled();
    for (const theme of ['light', 'dark']) {
      await page.emulateMedia({ colorScheme: theme });
      // 色が切り替わる動き(--motion-quick)が終わるのを待つ
      await page.waitForTimeout(200);
      await page.screenshot({ path: path.join(UX_SHOTS, `session-handoff-${theme}.png`) });
    }
    await page.emulateMedia({ colorScheme: 'light' });

    // 持ち主と期日を決めると、「!」が消える
    await open.first().getByLabel('持ち主').fill('店長(架空)');
    await open.first().getByLabel('期日').fill('2026-12-01');
    await open.first().getByRole('button', { name: '決める' }).click();
    await expect(unowned).toBeHidden();
    await expect(open.first().locator('.deliverable-mark')).toHaveCount(0);
    await expect(nextText).not.toContainText('持ち主のないもの');

    // 足りないものがあっても渡せる
    await next.getByRole('button', { name: '本番開発へ渡す' }).click();
    await expect(page.locator('#handoff-result')).toContainText('渡すフォルダーを作りました');

    // 秘密らしい文字列で止めると、⬢ の形で「渡すのを止めました」と場所
    await page.locator('#project-menu-button').click();
    await page.getByRole('navigation', { name: '試作品の一覧' }).getByRole('button', { name: /鍵を書いた試作品/ }).click();
    await expect(page.frameLocator('iframe[title="試作品"]').locator('#root')).toHaveText('鍵あり');
    await page.locator('#stage-list button.stage[data-stage="handoff"]').click();
    await next.getByRole('button', { name: '本番開発へ渡す' }).click();
    const stopped = page.locator('#handoff-result .state-line');
    await expect(stopped).toHaveAttribute('data-mark', '⬢ 止めました');
    await expect(stopped).toContainText('秘密らしい文字列があったので、渡すのを止めました。');
    await expect(stopped).toContainText('場所: config.js の 1 行目(API キーらしい文字列)');
    expect(await stopped.evaluate((node) => getComputedStyle(node, '::before').content)).toContain('⬢');
    for (const theme of ['light', 'dark']) {
      await page.emulateMedia({ colorScheme: theme });
      // 色が切り替わる動き(--motion-quick)が終わるのを待つ
      await page.waitForTimeout(200);
      await page.screenshot({ path: path.join(UX_SHOTS, `session-handoff-secret-${theme}.png`) });
    }
  } finally {
    await studio.stop();
  }
});
