import fs from 'node:fs/promises';
import path from 'node:path';
import {
  ROOT,
  SAMPLES,
  STAGES,
  chooseSample,
  closeMore,
  expect,
  goStage,
  launchStudio,
  openMaterials,
  openMechanism,
  openVersions,
  strongButtons,
  switchToRealAi,
  test,
} from './studio.js';
import { showReview } from './scenes.js';

// 画面の枠(docs/design/ui-ux-v2.md の 2.2〜2.6、2.8、5.1、5.3、13 節。UI/UX の 3 枚目)。
// どの段でも、段の道筋、今の行、作業台、次の一手の帯、仕組みの引き出しで 4 つの問いに答える。
// 偽接続(STUDIO_AGENT=fake)と偽の claude で動かし、実モデルは呼ばない。題材は架空

const UX_SHOTS = path.join(ROOT, 'test-results', 'ux');
const NAMES = Object.keys(STAGES);
const ACTORS = ['● あなた', '■ 作る AI', '▲ 試作品の中の AI', '⬢ 関門と守り'];

// 要素がスクロールしないで見える(画面の中にある)
async function expectOnScreen(page, locator, label) {
  await expect(locator, label).toBeVisible();
  const box = await locator.boundingBox();
  const { width, height } = page.viewportSize();
  expect(box.y, `${label} の上`).toBeGreaterThanOrEqual(0);
  expect(box.y + box.height, `${label} の下`).toBeLessThanOrEqual(height);
  expect(box.x + box.width, `${label} の右`).toBeLessThanOrEqual(width);
}

// 5.3 の 4 つの問いに、この段で答えているか。段の名前は name
async function expectFourAnswers(page, name) {
  // 今どこにいる?: aria-current="step" の段は 1 つで、作業台の見出しと同じ名前。横に「n / 9 段」
  const current = page.locator('#stage-list [aria-current="step"]');
  await expect(current).toHaveCount(1);
  await expect(current).toHaveAttribute('data-stage', STAGES[name]);
  await expect(current.locator('.stage-name')).toHaveText(name);
  await expect(page.locator('#bench-heading .bench-name')).toHaveText(name);
  await expect(page.locator('#stage-count')).toHaveText(`${NAMES.indexOf(name) + 1} / 9 段`);
  // 次に何をする?: 次の一手の帯に 1 文
  const band = page.getByRole('region', { name: '次の一手' });
  await expect(band).toBeVisible();
  await expect(page.locator('#next-text')).not.toHaveText('');
  // 今、誰が働いている?: 今の行に 4 者の形と名前。働いている者は 1 つ以上
  const line = page.getByRole('region', { name: '今の行' });
  const actors = line.getByRole('list', { name: '4 者' }).getByRole('listitem');
  await expect(actors).toHaveCount(4);
  for (const [index, label] of ACTORS.entries()) await expect(actors.nth(index)).toContainText(label);
  expect(await line.locator('.actor[data-active]').count()).toBeGreaterThan(0);
  // 本当はどう動いている?: 「仕組みを見る」
  await expect(line.getByRole('button', { name: /仕組みを見る/ })).toBeVisible();
  // 目立つのは次の一手だけ: 強い色のボタンは、次の一手の帯の 1 つだけ
  const strong = await strongButtons(page);
  expect(strong.length, `段 ${name} の強い色のボタン: ${JSON.stringify(strong)}`).toBeLessThanOrEqual(1);
  for (const button of strong) expect(button.inBand, `段 ${name} の「${button.text}」が次の一手の帯の外`).toBe(true);
  // 1280x800 で、作業台の見出しと次の一手の帯がスクロールなしで見える(2.8)
  await expectOnScreen(page, page.locator('#bench-heading'), `段 ${name} の作業台の見出し`);
  await expectOnScreen(page, band, `段 ${name} の次の一手の帯`);
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
});

test('見本の試作品で、9 つのどの段でも 4 つの問いに答え、強い色のボタンは次の一手の帯の 1 つだけ', async ({ page, home }) => {
  test.setTimeout(60_000);
  const studio = await launchStudio(home);
  try {
    await page.goto(studio.url);
    await chooseSample(page, SAMPLES.jobConsult);
    await expect(page.frameLocator('iframe[title="試作品"]').getByRole('heading', { name: 'しおかぜ求人相談' })).toBeVisible();
    // 最初は段 5「作る」。見本は段 1〜4 を「飛ばした」(─)で始める
    await expectFourAnswers(page, '作る');
    for (const key of ['talk', 'goal', 'design', 'review']) {
      await expect(page.locator(`#stage-list button.stage[data-stage="${key}"]`)).toHaveAttribute('data-state', 'skipped');
      await expect(page.locator(`#stage-list button.stage[data-stage="${key}"] .stage-state`)).toHaveText('─');
    }
    // 人が決める 4 つの段に ●
    for (const key of ['goal', 'design', 'review', 'show']) await expect(page.locator(`#stage-list button.stage[data-stage="${key}"] .stage-human`)).toHaveText('●');
    for (const key of ['talk', 'build', 'measure', 'quality', 'handoff']) await expect(page.locator(`#stage-list button.stage[data-stage="${key}"] .stage-human`)).toHaveCount(0);

    for (const name of NAMES) {
      await goStage(page, name);
      await expectFourAnswers(page, name);
    }
    // まだの段も押せて、何が足りないかを作業台に出す(審査は、見本では飛ばしている)
    await goStage(page, '審査');
    await expect(page.getByRole('region', { name: 'この段で足りないもの' })).toContainText('審査は飛ばしています');
    await expect(page.getByRole('region', { name: '次の一手' }).getByRole('button', { name: '設計の案内を開く' })).toBeVisible();
  } finally {
    await studio.stop();
  }
});

test('審査のある試作品で、9 つのどの段でも 4 つの問いに答える。仕組みの引き出しは 1 回の操作で開き、プロンプトと記録が見える。ライトとダークを撮る', async ({ page, home }) => {
  test.setTimeout(90_000);
  const studio = await launchStudio(home);
  try {
    await showReview(page, studio);
    // 審査の画面は段 4。次の一手の帯は、読んでいる欄の承認(押せない「この構成で作る」は出さない)
    await expectFourAnswers(page, '審査');
    await expect(page.locator('#next-text')).toHaveText('あなたの承認を待っています。承認は 2 / 4 で、そろうまで作る AI は動きません。データと RAG を読み、違わなければ承認しますか。');
    await expect(page.getByRole('region', { name: '次の一手' }).getByRole('button')).toHaveText(['データと RAG を承認する']);
    await expect(page.locator('#now-line .actor[data-actor="you"]')).toHaveAttribute('data-active', 'true');
    await expect(page.locator('#now-line .actor[data-actor="you"] .actor-text')).toHaveText('あなたの番(承認 2 / 4)');
    await expect(page.locator('#now-line .actor[data-actor="gate"] .actor-text')).toHaveText('承認まで作らせません');

    // 初めの画面では、プロンプトの全文が見えていない
    const prompts = page.locator('#mechanism-prompts-body pre');
    await expect(prompts.first()).toBeHidden();
    await expect(page.locator('#review details.review-prompts pre').first()).toBeHidden();

    for (const theme of ['light', 'dark']) {
      await page.emulateMedia({ colorScheme: theme });
      // 色の切り替えの動き(--motion-quick)が終わってから撮る
      await page.waitForTimeout(300);
      await page.locator('#review-heading').evaluate((el) => el.scrollIntoView({ block: 'start', behavior: 'instant' }));
      await page.screenshot({ path: path.join(UX_SHOTS, `frame-${theme}-stage4-review.png`) });
    }
    await page.emulateMedia({ colorScheme: 'light' });

    // 「仕組みを見る」の 1 回で開き、プロンプトの全文と AI の実行の記録が見える。作業台は隠れない
    const drawer = await openMechanism(page);
    await expect(prompts.first()).toBeVisible();
    await expect(prompts.first()).not.toHaveText('');
    await expect(drawer.getByRole('heading', { name: 'AI の実行の記録' })).toBeVisible();
    await expect(page.locator('#ai-trace')).toBeVisible();
    await expect(page.locator('#review-heading')).toBeVisible();
    const drawerBox = await page.locator('#mechanism').boundingBox();
    const benchBox = await page.locator('#bench').boundingBox();
    expect(benchBox.x + benchBox.width).toBeLessThanOrEqual(drawerBox.x + 1);
    for (const theme of ['light', 'dark']) {
      await page.emulateMedia({ colorScheme: theme });
      // 色の切り替えの動き(--motion-quick)が終わってから撮る
      await page.waitForTimeout(300);
      await page.screenshot({ path: path.join(UX_SHOTS, `frame-${theme}-drawer.png`) });
    }
    await page.emulateMedia({ colorScheme: 'light' });
    // もう一度押すと閉じる。. のキーでも 1 回で開き、もう一度で閉じる
    await page.locator('#mechanism-button').click();
    await expect(drawer).toBeHidden();
    await page.locator('#bench-heading').focus();
    await page.keyboard.press('.');
    await expect(drawer).toBeVisible();
    await expect(prompts.first()).toBeVisible();
    await page.keyboard.press('.');
    await expect(drawer).toBeHidden();
    // 字を打っている所では、. は字になる(引き出しは開かない)
    await page.locator('#review-pressed').fill('');
    await page.locator('#review-pressed').press('.');
    await expect(page.locator('#review-pressed')).toHaveValue('.');
    await expect(drawer).toBeHidden();
    await page.locator('#review-pressed').fill('');

    for (const name of NAMES) {
      await goStage(page, name);
      await expectFourAnswers(page, name);
    }

    // 段 6 の枠を、ライトとダークで撮る
    await goStage(page, '測る');
    // 右の列は 3 つのタブ(この 1 ターン、場面、比べる)。前に選んだタブ(はじめは「この 1 ターン」)を出す
    await expect(page.getByRole('tablist', { name: '測る' }).getByRole('tab')).toHaveText(['この 1 ターン', /^場面/, /^比べる/]);
    await expect(page.getByRole('tab', { name: 'この 1 ターン' })).toHaveAttribute('aria-selected', 'true');
    for (const theme of ['light', 'dark']) {
      await page.emulateMedia({ colorScheme: theme });
      // 色の切り替えの動き(--motion-quick)が終わってから撮る
      await page.waitForTimeout(300);
      await page.screenshot({ path: path.join(UX_SHOTS, `frame-${theme}-stage6-measure.png`) });
    }
    await page.emulateMedia({ colorScheme: 'light' });
  } finally {
    await studio.stop();
  }
});

test('画面を灰色にしても、今の行の 4 者と、お試しか本物かを、形と文で読める', async ({ page, home }) => {
  test.skip(process.platform === 'win32', '偽の claude をシェルスクリプトで作るため');
  // 偽の claude を本物として使う(試作品の中の AI を本物にする)。実モデルは呼ばない
  const bin = path.join(home, 'bin', 'claude');
  await fs.mkdir(path.dirname(bin), { recursive: true });
  const node = `"${process.execPath}"`;
  const cli = `"${path.join(ROOT, 'test', 'fixtures', 'fake-claude.js')}"`;
  const fixer = `"${path.join(ROOT, 'src', 'agent', 'fake-claude.js')}"`;
  await fs.writeFile(bin, ['#!/bin/sh', `case "$1" in --version|auth) exec ${node} ${cli} "$@";; esac`, `case "$*" in *--json-schema*) exec ${node} ${cli} "$@";; esac`, `exec ${node} ${fixer} "$@"`, ''].join('\n'), { mode: 0o755 });
  const studio = await launchStudio(home, { env: { STUDIO_AGENT: undefined, STUDIO_CLAUDE_BIN: bin } });
  try {
    await page.goto(studio.url);
    await expect(page.frameLocator('iframe[title="試作品"]').getByRole('heading', { name: 'しおかぜ求人相談' })).toBeVisible();
    await page.evaluate(() => document.documentElement.style.setProperty('filter', 'grayscale(1)'));
    const line = page.getByRole('region', { name: '今の行' });
    const text = async () => (await line.innerText()).replace(/\s+/g, ' ');
    // 4 者は形と名前の組。色がなくても、形で見分けられる
    for (const label of ACTORS) expect(await text()).toContain(label);
    // お試しか本物かは、印の形(○ と ◉)と文で分ける
    expect(await text()).toContain('○ お試しの AI・料金なし');
    await page.screenshot({ path: path.join(UX_SHOTS, 'frame-grayscale-trial.png') });

    await switchToRealAi(page);
    const real = line.getByRole('button', { name: '◉ 本物の AI・あなたの Claude Code' });
    await expect(real).toBeVisible();
    expect(await text()).not.toContain('○ お試しの AI・料金なし');
    await expect(line.locator('.actor[data-actor="product"] .actor-text')).toHaveText('本物');
    await page.screenshot({ path: path.join(UX_SHOTS, 'frame-grayscale-real.png') });
    // 本物のときは、押すと同意の中身(送るもの、送り先、料金)をもう一度見られる
    await real.click();
    await expect(real).toHaveAttribute('aria-expanded', 'true');
    const info = page.locator('#real-ai-now-info');
    await expect(info).toBeVisible();
    await expect(info.getByRole('list', { name: '送るもの' })).toBeVisible();
    await real.click();
    await expect(info).toBeHidden();
  } finally {
    await studio.stop();
  }
});

test('13 節の部品は全部どこかで使える。「その他」と「はじめの手順」はなく、中身は段、素材、試作品の名前のメニュー、仕組みの引き出しにある', async ({ page, home }) => {
  test.setTimeout(60_000);
  const studio = await launchStudio(home);
  try {
    await page.goto(studio.url);
    await chooseSample(page, SAMPLES.jobConsult);
    await expect(page.frameLocator('iframe[title="試作品"]').getByRole('heading', { name: 'しおかぜ求人相談' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'その他' })).toHaveCount(0);
    await expect(page.getByRole('region', { name: 'はじめの手順' })).toHaveCount(0);

    // 試作品の名前のメニュー: 切り替え、新しく作る、お客さんとの会を始める、版と「この状態に戻す」
    const versions = await openVersions(page);
    const menu = page.getByRole('navigation', { name: '試作品の一覧' });
    await expect(menu.getByRole('button', { name: '新しく作る' })).toBeVisible();
    await expect(menu.getByRole('button', { name: 'お客さんとの会を始める' })).toBeVisible();
    await expect(versions.getByRole('button', { name: '保存', exact: true })).toBeEnabled();
    await versions.getByRole('button', { name: '保存', exact: true }).click();
    await expect(page.locator('#versions-message')).toHaveText('保存しました(保存 1)。');
    await expect(versions.getByRole('button', { name: '保存 1 の状態に戻す' })).toBeVisible();
    await closeMore(page);

    // 素材: 自分のトークンをつなぐ、部品と指針をつなぐ
    const materials = await openMaterials(page);
    await expect(materials.getByLabel('トークンのファイル')).toBeEnabled();
    await expect(materials.getByRole('region', { name: '部品と指針をつなぐ' }).getByRole('radio', { name: /指針の文/ })).toBeVisible();
    await closeMore(page);

    // 仕組みの引き出し: 接続、試験用の依頼、ビルド、プロダクト内 AI、構成と前提(構成のある試作品だけ)、実行の記録、試作品からの知らせ、画面を読み込み直す
    const drawer = await openMechanism(page);
    for (const name of ['作る AIの接続', '試験用の依頼', 'ビルド', 'プロダクト内 AI', 'AI の実行の記録', '試作品からの知らせ']) {
      await expect(drawer.getByRole('heading', { name, exact: true })).toBeVisible();
    }
    await expect(drawer.getByRole('button', { name: 'ファイルから作り直す' })).toBeEnabled();
    await expect(drawer.getByRole('button', { name: '画面を読み込み直す' })).toBeEnabled();
    await closeMore(page);

    // 段 7: 試作品を自動で確かめる。段 8: 人に見せる。段 9: 本番開発へ渡す(押すボタンは次の一手の帯)
    await goStage(page, '質');
    await expect(page.getByRole('region', { name: '試作品を自動で確かめる' }).getByRole('button', { name: '試作品を自動で確かめる' })).toBeEnabled();
    await goStage(page, '見せる');
    await expect(page.getByRole('region', { name: '次の一手' }).getByRole('button', { name: '人に見せる' })).toBeEnabled();
    await goStage(page, '渡す');
    await expect(page.getByRole('region', { name: '本番開発へ渡す' }).getByLabel('目的(この試作品で確かめたいこと)')).toBeEnabled();
    await expect(page.getByRole('region', { name: '次の一手' }).getByRole('button', { name: '渡すフォルダーを作る' })).toBeEnabled();

    // 構成のある見本では、仕組みの引き出しに「構成と前提」が出る
    await goStage(page, '作る');
    await chooseSample(page, SAMPLES.partTime);
    await openMechanism(page);
    await expect(page.getByRole('region', { name: '構成と前提' })).toBeVisible();
  } finally {
    await studio.stop();
  }
});

test('「その場で」の 1 行は、同じ操作を 2 回した後に出なくなり、「案内をもう一度出す」で戻る。回数は Studio のデータの置き場にあり、試作品には入らない', async ({ page, home }) => {
  const studio = await launchStudio(home);
  try {
    await page.goto(studio.url);
    await chooseSample(page, SAMPLES.jobConsult);
    await page.locator('#organize-mark').click();
    await expect(page.getByRole('heading', { name: 'ヒアリングの整理' })).toBeVisible();
    const hint = page.locator('.hint[data-hint="organize-point"]');
    await expect(hint).toBeVisible();
    await expect(hint).toHaveText('聞いた要点は 1 つずつ短く打ち、Enter で足します。板への整理は後でまとめてできます。');
    const points = page.getByRole('list', { name: '打った要点' }).getByRole('listitem');
    for (const [index, text] of ['架空のお店は火曜が休み', '予約は電話が多い'].entries()) {
      await page.getByLabel('聞いた要点').fill(text);
      await page.getByLabel('聞いた要点').press('Enter');
      await expect(points).toHaveCount(index + 1);
      // 1 回目の後はまだ出る。2 回目の後は出ない
      if (index === 0) await expect(hint).toBeVisible();
    }
    await expect(hint).toBeHidden();

    // 回数は Studio のデータの置き場(hints.json)にあり、試作品のフォルダーには入らない。読み込み直しても出ないまま
    const saved = JSON.parse(await fs.readFile(path.join(home, 'hints.json'), 'utf8'));
    expect(saved).toEqual({ counts: { 'organize-point': 2 } });
    const projectFiles = await fs.readdir(path.join(home, 'projects', SAMPLES.jobConsult.id), { recursive: true });
    expect(projectFiles.filter((file) => file.includes('hints'))).toEqual([]);
    await page.reload();
    await page.locator('#organize-mark').click();
    await expect(page.getByRole('heading', { name: 'ヒアリングの整理' })).toBeVisible();
    await expect(hint).toBeHidden();

    // 表示のメニューの「案内をもう一度出す」で戻る
    await page.getByRole('banner').getByRole('button', { name: '表示' }).click();
    await page.getByRole('button', { name: '案内をもう一度出す' }).click();
    await expect(page.locator('#hints-reset-note')).toHaveText('覚えて出さなくなった案内を、もう一度出します。');
    await expect(hint).toBeVisible();
    expect(JSON.parse(await fs.readFile(path.join(home, 'hints.json'), 'utf8'))).toEqual({ counts: {} });
  } finally {
    await studio.stop();
  }
});

test('1000px の幅では、段の道筋が「n / 9 段の名前 ▾」の 1 つのボタンにまとまり、今の行は働いている者だけになる', async ({ page, home }) => {
  const studio = await launchStudio(home);
  try {
    await page.setViewportSize({ width: 1000, height: 800 });
    await page.goto(studio.url);
    await expect(page.frameLocator('iframe[title="試作品"]').getByRole('heading', { name: 'しおかぜ求人相談' })).toBeVisible();
    const compact = page.locator('#stage-compact');
    await expect(compact).toBeVisible();
    await expect(compact).toHaveText('5 / 9 作る ▾');
    const stages = page.locator('#stage-list button.stage');
    await expect(stages.first()).toBeHidden();
    // 段の印(目的なし、ヒアリングの整理 など)は、ボタンの横に出したまま
    await expect(page.locator('#organize-mark')).toBeVisible();
    // 押すと 9 段の一覧が開き、段を選ぶと閉じる
    await compact.click();
    await expect(stages).toHaveCount(9);
    for (let i = 0; i < 9; i += 1) await expect(stages.nth(i)).toBeVisible();
    await page.locator('#stage-list button.stage[data-stage="review"]').click();
    await expect(stages.first()).toBeHidden();
    // 横にはみ出さない
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
    await expect(compact).toHaveText('4 / 9 審査 ▾');
    // 今の行: 働いている者(あなた)だけと「ほか 3 者」
    const line = page.getByRole('region', { name: '今の行' });
    await expect(line.locator('.actor:visible')).toHaveCount(1);
    await expect(line.locator('.actor[data-actor="you"]')).toBeVisible();
    await expect(line.getByText('ほか 3 者')).toBeVisible();
    await page.screenshot({ path: path.join(UX_SHOTS, 'frame-light-narrow-1000.png') });
  } finally {
    await studio.stop();
  }
});

test('次の一手の帯に移したボタンは、一覧の読み直しで描き直しても帯に残る(会を用意する)', async ({ page, home }) => {
  const studio = await launchStudio(home);
  try {
    await page.goto(studio.url);
    await expect(page.frameLocator('iframe[title="試作品"]').getByRole('heading', { name: 'しおかぜ求人相談' })).toBeVisible();
    await page.locator('#project-menu-button').click();
    await page.getByRole('navigation', { name: '試作品の一覧' }).getByRole('button', { name: 'お客さんとの会を始める' }).click();
    const band = page.getByRole('region', { name: '次の一手' });
    await expect(band.getByRole('button', { name: '会を用意する' })).toBeVisible();
    // 一覧が変わると画面を描き直す(3 秒ごとの読み直し)。描き直しを 2 回待っても、ボタンは帯にあり、form の外でも会を用意できる
    expect((await studio.post('/api/projects', { sentence: '架空の花屋の予約の問い合わせを減らしたい', guide: 'fixed' })).status).toBe(200);
    for (let i = 0; i < 2; i += 1) await page.waitForResponse((response) => response.url().endsWith('/api/projects') && response.request().method() === 'GET');
    await expect(band.getByRole('button', { name: '会を用意する' })).toBeVisible();
    await expect(page.locator('#meeting-new').getByRole('button', { name: '会を用意する' })).toHaveCount(0);
    await page.getByLabel('会の目的').fill('架空の花屋で、予約の聞き取りを試す');
    await band.getByRole('button', { name: '会を用意する' }).click();
    await expect(page.locator('#meeting-body')).toBeVisible();
  } finally {
    await studio.stop();
  }
});
