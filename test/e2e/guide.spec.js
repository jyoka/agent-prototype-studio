import fs from 'node:fs/promises';
import path from 'node:path';
import { showReview } from './scenes.js';
import {
  chooseSample,
  chooseTestRequest,
  closeMore,
  expect,
  goStage,
  launchStudio,
  openMeasureTab,
  openVersions,
  ROOT,
  SAMPLES,
  startShowing,
  test,
  toneWordsIn,
} from './studio.js';

// 案内と 12 の状態(docs/design/ui-ux-v2.md の 5 節)。UI/UX の 6 枚目。
// 12 の状態ごとに状態を作り、何が起きたか、今どうなっているか、次に何をするかの 3 つの文と、5.4 の印が画面にあるかを確かめる。
// 割り込みは本物の AI を使う前の同意だけ。段 1〜9 の作業台の部品に「これは何?」があり、見える文字に言わない語がない。
// 12 の状態をライトとダークで撮り、test-results/ux/ に置く(test-results/ は git が無視する)。
// 実モデルは呼ばない。作る AI は偽接続(STUDIO_AGENT=fake)か偽の claude(test/fixtures/fake-claude.js)。試作品の中の AI はお試しの AI

const UX_SHOTS = path.join(ROOT, 'test-results', 'ux');
const FAKE_CLAUDE = path.join(ROOT, 'test', 'fixtures', 'fake-claude.js');
const CARD = '本物の AI を使う前に';

// 状態の 1 行。3 つの文が順にあり、どれも 1 文。印(::before)が 5.4 の印
async function expectState(locator, kind, mark) {
  await expect(locator).toBeVisible();
  await expect(locator).toHaveAttribute('data-state', kind);
  await expect(locator).toHaveAttribute('data-mark', mark);
  const parts = locator.locator(':scope > .state-part');
  await expect(parts).toHaveCount(3);
  expect(await parts.evaluateAll((nodes) => nodes.map((node) => node.dataset.part))).toEqual(['happened', 'now', 'next']);
  for (const text of await parts.allTextContents()) {
    expect(text.split(/(?<=[。?])/).filter((part) => part.trim()), `「${text}」は 1 文`).toHaveLength(1);
  }
  // 印は CSS が ::before で描く(画面に見える)
  const shown = await locator.evaluate((node) => getComputedStyle(node, '::before').content);
  expect(shown).toContain(mark);
  await expect(locator.locator(':scope > .state-part').first()).toBeVisible();
}

// 割り込み(作業を止める表示)がない。モーダルのダイアログも、作業台を止める inert もない
async function expectNoInterrupt(page) {
  expect(await page.locator('dialog[open], [aria-modal="true"], [inert]').count()).toBe(0);
}

// ライトとダークで撮る。target があれば、画面の真ん中に寄せてから撮る
async function shoot(page, name, target = null) {
  if (target) await target.evaluate((el) => el.scrollIntoView({ block: 'center', behavior: 'instant' }));
  for (const theme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: theme });
    await page.waitForTimeout(150);
    await page.screenshot({ path: path.join(UX_SHOTS, `state-${name}-${theme}.png`) });
  }
  await page.emulateMedia({ colorScheme: 'light' });
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
});

test('はじめて: 段 1 の作業台に「─」と 3 つの文。例を押すと欄に入る', async ({ page, home }) => {
  const studio = await launchStudio(home, { env: { STUDIO_START_SCREEN: undefined } });
  try {
    await page.goto(studio.url);
    await expect(page.getByRole('heading', { level: 2, name: 'どんなものを作りたいですか' })).toBeVisible();
    await expectState(page.locator('#intent-lead'), 'first', '─');
    await expect(page.locator('#intent-lead')).toContainText('ラフな 1 文で大丈夫です。');
    await expectNoInterrupt(page);
    await shoot(page, 'first');
  } finally {
    await studio.stop();
  }
});

test('お試しか本物か、元に戻した、お客さんの前: ○ の中身、↶ の 1 行と「戻す前に戻る」、「架空」の札', async ({ page, home }) => {
  test.setTimeout(90_000);
  const studio = await launchStudio(home);
  try {
    await page.goto(studio.url);
    await chooseSample(page, SAMPLES.library);
    const app = page.frameLocator('iframe[title="試作品"]');
    await expect(app.getByRole('heading', { level: 1 })).toBeVisible();

    // お試しか本物か: 今の行の右の「○ お試しの AI・料金なし」を押すと、3 つの文が開く
    const mode = page.locator('#ai-mode');
    await expect(mode).toHaveText('○ お試しの AI・料金なし');
    await mode.click();
    await expect(mode).toHaveAttribute('aria-expanded', 'true');
    const info = page.getByRole('group', { name: 'お試しの AI' });
    await expectState(info.locator('.state-line'), 'mode-trial', '○');
    await expect(info).toContainText('料金はかからず、外には何も送っていません。');
    await expectNoInterrupt(page);
    await shoot(page, 'mode');
    await info.getByRole('button', { name: '閉じる' }).click();
    await expect(info).toBeHidden();
    await expect(mode).toBeFocused();

    // 元に戻した: 保存 1 → 試作品を変える → 保存 1 に戻す。作業台の上に ↶ の 1 行と、弱いボタン「戻す前に戻る」
    const versions = await openVersions(page);
    await versions.locator('#save-version').click();
    await expect(page.locator('#versions-message')).toHaveText('保存しました(保存 1)。');
    await closeMore(page);
    await chooseTestRequest(page, '見出しを「ひだまり図書室」にして');
    await page.getByRole('button', { name: '送る' }).click();
    await expect(app.getByRole('heading', { name: 'ひだまり図書室' })).toBeVisible({ timeout: 30_000 });
    await openVersions(page);
    await page.getByRole('button', { name: '保存 1 の状態に戻す' }).click();
    await expect(page.locator('#versions-message')).toContainText('保存 1 に戻しました。戻す前の状態は、保存 2(自動)にしました。');
    await expect(app.getByRole('heading', { name: 'ひだまり図書室' })).toHaveCount(0);
    // メニューを閉じる操作は、次の操作に数えない(版を戻すのはメニューの中なので、閉じた後に 1 行を読める)
    await page.locator('#project-menu-button').click();
    await expect(page.locator('#project-menu')).toBeHidden();
    const reverted = page.locator('#reverted');
    await expectState(page.locator('#reverted-text'), 'reverted', '↶');
    await expect(page.locator('#reverted-text')).toHaveText(/^\d\d:\d\d の版に戻しました。戻す前の版と記録は残っています。戻した試作品を試しますか。$/);
    const undo = reverted.getByRole('button', { name: '戻す前に戻る' });
    await expect(undo).toHaveClass(/quiet/);
    await expectNoInterrupt(page);
    await shoot(page, 'reverted');
    // 「戻す前に戻る」で、戻す前の版(保存 2)に戻る。1 行は新しい中身で残る
    await undo.click();
    await expect(app.getByRole('heading', { name: 'ひだまり図書室' })).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('#reverted-text')).toContainText('の版に戻しました。');
    // 次の操作で消える
    await page.locator('#bench-heading').click();
    await expect(reverted).toBeHidden();

    // お客さんの前: 見せる画面に「架空」の札と 3 つの文
    await startShowing(page);
    const notice = page.locator('#show-notice');
    await expectState(notice, 'customer', '架空');
    await expect(notice).toContainText('出てくるデータは、すべて架空です。');
    // 見せる画面では、仕組みの引き出しを開けない
    await page.keyboard.press('.');
    await expect(page.locator('#mechanism')).toBeHidden();
    await expectNoInterrupt(page);
    await shoot(page, 'customer', notice);
  } finally {
    await studio.stop();
  }
});

test('人を待っている、まだ見ていない、承認が消えた: 帯の ●、欄の上の ○、欄の頭の !', async ({ page, home }) => {
  test.setTimeout(60_000);
  const studio = await launchStudio(home);
  try {
    await showReview(page, studio);
    // 人を待っている: 帯に 3 つの文。承認の数を数で言う
    const band = page.locator('#next-text');
    await expectState(band, 'waiting', '●');
    await expect(band).toHaveText('あなたの承認を待っています。承認は 2 / 4 で、そろうまで作る AI は動きません。データと RAG を読み、違わなければ承認しますか。');
    await expect(page.locator('#now-line .actor[data-actor="you"]')).toHaveAttribute('data-active', 'true');
    // まだ見ていない: 欄の一覧の上に ○ と数
    const unseen = page.locator('#review-unseen');
    await expectState(unseen, 'unseen', '○');
    await expect(unseen).toContainText('4 つの欄のうち、1 つはまだ見ていません。');
    await expect(page.locator('#review-items .review-item[data-state="unseen"] .review-state')).toHaveText('○ まだ見ていない');
    await expectNoInterrupt(page);
    await page.locator('#bench-heading').evaluate((el) => el.scrollIntoView({ block: 'start', behavior: 'instant' }));
    await shoot(page, 'waiting');
    await shoot(page, 'unseen', unseen);

    // 承認が消えた: 構成を選び直すと、承認していた欄の頭に ! と 3 つの文
    const composition = page.locator('#review-items .review-item[data-item="composition"]');
    await composition.locator('details.review-peek > summary').click();
    await page.getByRole('group', { name: '構成を切り替える' }).getByRole('button', { name: /^単一エージェント/ }).click();
    await expect(page.locator('#review-count')).toHaveText('承認 0 / 4・あと 4 つ');
    const lost = composition.locator('.review-lost');
    await expectState(lost, 'lost', '!');
    await expect(lost).toHaveText('エージェントの構成を選び直したので、この欄の承認を消しました。この欄は、まだ承認していない形に戻っています。読み直して、承認し直しますか。');
    await expectNoInterrupt(page);
    await shoot(page, 'lost', lost);
  } finally {
    await studio.stop();
  }
});

test('AI が作業中、守りが止めた、関門で落ちた: 帯の ●、⬢ 止めました、× ⬢。作業中は強い色のボタンがない', async ({ page, home }) => {
  test.setTimeout(150_000);
  const studio = await launchStudio(home);
  try {
    await page.goto(studio.url);
    await chooseSample(page, SAMPLES.library);
    const band = page.locator('#next-text');
    const next = page.getByRole('region', { name: '次の一手' });

    // AI が作業中: 今の行の ■ が働いている者。帯は ● と 3 つの文と、弱いボタン「止める」だけ
    await chooseTestRequest(page, 'ゆっくり進めて');
    await page.getByRole('button', { name: '送る' }).click();
    await expectState(band, 'working', '●');
    await expect(band).toHaveText('作る AI が試作品を書いています。止めても、前の版は残ります。その間に、足りない場面がないか見てみませんか。');
    await expect(page.locator('#now-line .actor[data-actor="maker"]')).toHaveAttribute('data-active', 'true');
    await expect(next.locator('button.primary')).toHaveCount(0);
    await expect(next.getByRole('button', { name: '止める' })).toHaveClass(/quiet/);
    await expectNoInterrupt(page);
    await shoot(page, 'working');
    await next.getByRole('button', { name: '止める' }).click();
    await expect(page.locator('#make-now')).not.toHaveAttribute('data-status', 'running', { timeout: 30_000 });

    // 守りが止めた: 作る AI が試作品のフォルダーの外を触ろうとして断られた
    await chooseTestRequest(page, 'app/ の外にメモを書いて');
    await page.getByRole('button', { name: '送る' }).click();
    await expectState(band, 'guard-stopped', '⬢ 止めました');
    await expect(band).toHaveText('守りが、試作品のフォルダーの外を触る操作を止めました。失敗ではなく守りが働いた印で、試作品は前のままです。試作品の中で済む頼み方に、言い換えますか。');
    await expect(next.getByRole('button', { name: '言い換える' })).toBeVisible();
    await expectNoInterrupt(page);
    await shoot(page, 'guard-stopped');

    // 関門で落ちた: 直しきれず、前に動いた版を出す
    await chooseTestRequest(page, '壊して、直せないふりをして');
    await page.getByRole('button', { name: '送る' }).click();
    await expect(page.locator('#make-now')).toHaveAttribute('data-status', 'failed', { timeout: 60_000 });
    await expectState(band, 'gate-failed', '× ⬢');
    await expect(band).toHaveText('「表示の準備」で落ち、作る AI が直しきれませんでした。前に動いた版を出しています。頼み方を変えて、もう一度試しますか。');
    await expect(page.locator('#make-now .now-row[data-actor="gate"][data-state="failed"] .now-mark').first()).toHaveText('×');
    await expect(next.getByRole('button', { name: '頼み方を変える' })).toBeVisible();
    await expectNoInterrupt(page);
    await shoot(page, 'gate-failed');
  } finally {
    await studio.stop();
  }
});

test('守りが止めた(1 ターンの記録): 試作品の中の守りが止めた行の上に ⬢ と 3 つの文', async ({ page, home }) => {
  test.setTimeout(60_000);
  const studio = await launchStudio(home);
  try {
    await page.goto(studio.url);
    await chooseSample(page, SAMPLES.partTime);
    const app = page.frameLocator('iframe[title="試作品"]');
    const message = app.getByLabel('メッセージ');
    await message.fill('みなと町でバイトを探しています');
    await app.getByRole('button', { name: '送る' }).click();
    await expect(message).toHaveValue('');
    await message.fill('そのまま保存して');
    await app.getByRole('button', { name: '送る' }).click();
    const panel = await openMeasureTab(page, 'この 1 ターン');
    const guard = panel.locator('#turn-guard');
    await expectState(guard, 'guard-stopped', '⬢ 止めました');
    await expect(guard).toContainText('失敗ではなく守りが働いた印です。');
    await shoot(page, 'guard-stopped-turn', guard);
    await expectNoInterrupt(page);
  } finally {
    await studio.stop();
  }
});

test('同意と AI の推測: 割り込みは同意のカードだけ。同意の前は偽の claude を呼ばない。カードに送るもの、送り先、料金と上限', async ({ page, home }) => {
  test.skip(process.platform === 'win32', '偽の claude を直接起動するため');
  test.setTimeout(90_000);
  const log = path.join(home, 'claude.log');
  const studio = await launchStudio(home, { env: { STUDIO_AGENT: 'claude', STUDIO_CLAUDE_BIN: FAKE_CLAUDE, FAKE_CLAUDE_LOG: log } });
  // 版や認証を確かめる呼び出し(--version、auth)は、モデルを呼ばないので数えない
  const calls = async () =>
    (await fs.readFile(log, 'utf8').catch(() => ''))
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line).argv)
      .filter((argv) => !['--version', 'auth'].includes(argv[0]));
  try {
    await page.goto(studio.url);
    await chooseSample(page, SAMPLES.library);
    await page.locator('#organize-mark').click();
    await expect(page.getByRole('heading', { level: 2, name: 'ヒアリングの整理' })).toBeVisible();
    for (const point of ['再配達の受付を、電話なしで済ませたい', '夕方に電話が集中する', 'お届け先と希望の日時を聞いている']) {
      await page.getByLabel('聞いた要点').fill(point);
      await page.getByLabel('聞いた要点').press('Enter');
    }
    await expect(page.getByRole('list', { name: '打った要点' }).getByRole('listitem')).toHaveCount(3);
    await page.getByRole('button', { name: '整理する', exact: true }).click();

    // 同意: カードは 1 枚。◉ と 3 つの文。送るもの、送り先、料金と上限が見える
    const card = page.getByRole('group', { name: CARD });
    await expect(card).toHaveCount(1);
    await expectState(card.locator('.state-line'), 'consent', '◉');
    await expect(card.locator('dt')).toHaveText(['送るもの', '送らないもの', '送り先', '料金', '上限']);
    await expect(card.getByRole('list', { name: '送るもの' })).toContainText('打った要点と整理の板の項目');
    await expect(card.locator('dd').nth(4)).toContainText('ドルまで');
    // 割り込みは同意のカードだけ: ほかにモーダルや inert はない
    await expectNoInterrupt(page);
    expect(await calls()).toEqual([]);
    await shoot(page, 'consent', card.locator('.state-line'));
    await card.getByRole('button', { name: '同意して使う' }).click();

    // AI の推測: 推測で埋めた項目があると、板の上に「推測」の札(点線)と 3 つの文
    const guess = page.locator('#organize-guess');
    await expect(page.locator('#organize-columns .organize-item').first()).toBeVisible({ timeout: 30_000 });
    expect((await calls()).length).toBeGreaterThan(0);
    await expectState(guess, 'guess', '推測');
    await expect(guess).toContainText('推測で埋めました。');
    expect(await guess.evaluate((node) => getComputedStyle(node, '::before').borderTopStyle)).toBe('dotted');
    await expect(page.locator('.organize-badge[data-kind="guess"]').first()).toHaveCSS('border-top-style', 'dotted');
    await expectNoInterrupt(page);
    await shoot(page, 'guess', guess);
  } finally {
    await studio.stop();
  }
});

// 作業台の見える「これは何?」を確かめる。初めは閉じていて、キーボードで開け、開くと 3 つの問いが 1 文ずつある
async function expectExplains(page, stage) {
  const boxes = page.locator('#bench details.explain').filter({ visible: true });
  expect(await boxes.count(), `段「${stage}」に「これは何?」がない`).toBeGreaterThan(0);
  for (const box of await boxes.all()) expect(await box.evaluate((node) => node.open), `段「${stage}」の「これは何?」が初めから開いている`).toBe(false);
  const first = boxes.first();
  await first.locator('summary').focus();
  await page.keyboard.press('Enter');
  await expect(first).toHaveAttribute('open', '');
  await expect(first.locator('dt')).toHaveText(['これは何か', '何をするのか', '次に何が起きるか']);
  for (const text of await first.locator('dd').allTextContents()) {
    expect(text.split(/(?<=[。?])/).filter((part) => part.trim()), `段「${stage}」の「${text}」は 1 文`).toHaveLength(1);
  }
  // 閉じるのも Enter(描き直しで焦点が動いていても、summary に戻してから押す)
  await first.locator('summary').focus();
  await page.keyboard.press('Enter');
  await expect(first).not.toHaveAttribute('open', '');
}

// 作業台と次の一手の帯の見える文字に、言わない語がない
async function expectTone(page, stage) {
  const text = await page.evaluate(() => `${document.getElementById('bench').innerText}\n${document.getElementById('next-band').innerText}`);
  expect(toneWordsIn(text), `段「${stage}」に言わない語があります`).toEqual([]);
}

test('段 1〜9 の作業台に「これは何?」があり、見える文字に言わない語がない', async ({ page, home }) => {
  test.setTimeout(120_000);
  // 段 1: はじめの画面
  let studio = await launchStudio(home, { env: { STUDIO_START_SCREEN: undefined } });
  try {
    await page.goto(studio.url);
    await expect(page.getByRole('heading', { level: 2, name: 'どんなものを作りたいですか' })).toBeVisible();
    await expectExplains(page, '話す');
    await expectTone(page, '話す');
  } finally {
    await studio.stop();
  }
  // 段 2〜9: 目的と設計を決め、審査まで進んだ試作品
  studio = await launchStudio(home);
  try {
    await showReview(page, studio);
    await expectExplains(page, '審査');
    await expectTone(page, '審査');
    await goStage(page, '目的');
    await expect(page.locator('#intent-doc')).toBeVisible();
    await expectExplains(page, '目的');
    await expectTone(page, '目的');
    await goStage(page, '設計');
    await expect(page.locator('#design')).toBeVisible();
    await expectExplains(page, '設計');
    await expectTone(page, '設計');
    for (const stage of ['作る', '測る', '質', '見せる', '渡す']) {
      await goStage(page, stage);
      await expectExplains(page, stage);
      await expectTone(page, stage);
    }
    // 整理の板(段 2 の会の形)
    await chooseSample(page, SAMPLES.library);
    await page.locator('#organize-mark').click();
    await expect(page.getByRole('heading', { level: 2, name: 'ヒアリングの整理' })).toBeVisible();
    await expectExplains(page, '目的(整理の板)');
    await expectTone(page, '目的(整理の板)');
  } finally {
    await studio.stop();
  }
});
