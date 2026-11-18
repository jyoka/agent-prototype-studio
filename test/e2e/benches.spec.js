import fs from 'node:fs/promises';
import path from 'node:path';
import {
  ROOT,
  SAMPLES,
  chooseSample,
  devWordsIn,
  expect,
  expectNoDevWordsOnScreen,
  goStage,
  launchStudio,
  startShowing,
  strongButtons,
  test,
  writeProject,
} from './studio.js';

// はじめ、目的、整理、質、見せる(docs/design/ui-ux-v2.md の 4.4〜4.7。UI/UX の 7 枚目)。
// 段 1 は白紙で始まらない。段 2 は問いが 1 つずつで、「これで決める」を押すまで ✓ が付かない。推測の札は色を外しても分かる。
// 質の見直しは「測った数」と「AI の判断」を別の列にし、見ていない行は ○ と「まだ見ていない」。見せる画面と操作役の画面を分ける。
// 場面 4〜7 をライトとダークで撮り、test-results/ux/ に置く(test-results/ は git が無視する)。
// 実モデルは呼ばない。作る AI と聞き出す AI と整理する AI は偽接続(STUDIO_AGENT=fake)。試作品の中の AI はお試しの AI。題材は架空

const UX_SHOTS = path.join(ROOT, 'test-results', 'ux');
const START = { STUDIO_START_SCREEN: undefined };

// ライトとダークで撮る。target があれば、画面の真ん中に寄せてから撮る
async function shoot(page, name, target = null) {
  if (target) await target.evaluate((el) => el.scrollIntoView({ block: 'center', behavior: 'instant' }));
  for (const theme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: theme });
    await page.waitForTimeout(150);
    await page.screenshot({ path: path.join(UX_SHOTS, `scene-${name}-${theme}.png`) });
  }
  await page.emulateMedia({ colorScheme: 'light' });
}

// 強い色のボタンは、次の一手の帯の 1 つだけ。label があれば、その名前
async function expectOneStrong(page, label) {
  const strong = await strongButtons(page);
  expect(strong, JSON.stringify(strong)).toHaveLength(1);
  expect(strong[0].inBand).toBe(true);
  if (label) expect(strong[0].text).toBe(label);
}

// 推測の札(4.4、4.5)。色を外しても(強制の色)、点線の縁と「推測」の文で分かる
async function expectGuessWithoutColor(page, locator) {
  for (const forcedColors of ['none', 'active']) {
    await page.emulateMedia({ forcedColors });
    await expect(locator.getByText('推測', { exact: true })).toBeVisible();
    expect(await locator.evaluate((el) => getComputedStyle(el).borderTopStyle)).toBe('dotted');
  }
  await page.emulateMedia({ forcedColors: 'none' });
}

const stageOf = (page, key) => page.locator(`#stage-list button.stage[data-stage="${key}"]`);

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
});

test('はじめと目的: 白紙の欄がなく、強い色は帯の「送る」だけ。問いは 1 つずつ、「分からない」は決めていないことに入り、「これで決める」まで段 2 に ✓ がない', async ({ page, home }) => {
  test.setTimeout(90_000);
  const studio = await launchStudio(home, { env: START });
  try {
    await page.goto(studio.url);
    // 段 1 の作業台。見出しと、例の文が入った欄(白紙でない)
    await expect(page.getByRole('heading', { level: 2, name: '思いつきを 1 文で書いてください' })).toBeVisible();
    await expect(stageOf(page, 'talk')).toHaveAttribute('aria-current', 'step');
    const sentence = page.getByLabel('作りたいもの');
    await expect(sentence).not.toHaveValue('');
    const examples = page.getByRole('list', { name: '例の 1 文' }).getByRole('button');
    await expect(examples).toHaveCount(3);
    await expect(sentence).toHaveValue((await examples.first().innerText()).trim());
    await expect(page.getByRole('group', { name: '聞き方の深さ' }).getByRole('radio')).toHaveCount(3);
    await expect(page.locator('#intent-samples > summary')).toContainText('見本の試作品から始める');
    // 目立つのは次の一手だけ。強い色のボタンは帯の「送る」
    await expectOneStrong(page, '送る');
    await expect(page.locator('#next-text')).toHaveText('1 文を書いて送ると、問いが 1 つずつ返ります。');
    await shoot(page, '4-start');

    // 例を押すと欄に入る。送ると、段 2 の 2 列になる(左に問い 1 つ、右に目的の文書の下書き)
    await examples.nth(1).click();
    await expect(sentence).toHaveValue((await examples.nth(1).innerText()).trim());
    await page.getByRole('region', { name: '次の一手' }).getByRole('button', { name: '送る' }).click();
    const question = page.locator('#intent-question');
    await expect(question).toBeVisible();
    await expect(page.getByRole('heading', { level: 3, name: '目的の文書の下書き' })).toBeVisible();
    // 問いは 1 つずつ: 問いの欄は 1 つで、問いの文は 1 つ
    await expect(page.locator('#intent-goal .intent-question:visible')).toHaveCount(1);
    expect((await question.innerText()).match(/[??]/g)).toHaveLength(1);
    await expect(page.locator('#intent-progress')).toHaveText('問い 1 / 多くて 4');
    // 「分からない」は「答える」と同じ重さ(同じ形と幅)
    const reply = page.getByRole('button', { name: '答える' });
    const unknown = page.getByRole('button', { name: '分からない' });
    const [replyBox, unknownBox] = [await reply.boundingBox(), await unknown.boundingBox()];
    expect(Math.abs(replyBox.width - unknownBox.width)).toBeLessThan(2);
    expect(await reply.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(await unknown.evaluate((el) => getComputedStyle(el).backgroundColor));
    // 次の一手は「これで決める」(帯)。押すまで段 2 に ✓ はない
    await expectOneStrong(page, 'これで決める');
    await expect(stageOf(page, 'goal')).not.toHaveAttribute('data-state', 'done');
    await expect(stageOf(page, 'goal')).not.toContainText('✓');
    // 推測で埋めた行(偽接続は、まだ聞いていない成功の印を推測で埋める)。色を外しても、点線の縁と「推測」の文で分かる
    const success = page.locator('.intent-row[data-field="success"]');
    await expect(success).toHaveAttribute('data-guess', 'true');
    await expectGuessWithoutColor(page, success);
    await shoot(page, '4-goal');

    // 答える。答えが下書きの「誰」に入る
    await page.getByLabel('答え', { exact: true }).fill('商店街のお店の人(架空)');
    await reply.click();
    await expect(page.locator('#intent-progress')).toHaveText('問い 2 / 多くて 4');
    await expect(page.getByLabel('誰', { exact: true })).toHaveValue('商店街のお店の人(架空)');
    // 「分からない」は、決めていないことに入れたと 1 文で言う
    const asked = (await question.innerText()).trim();
    await unknown.click();
    await expect(page.locator('#intent-progress')).toHaveText('問い 3 / 多くて 4');
    await expect(page.locator('#intent-unknown-note')).toHaveText(`「${asked}」は、決めていないことに入れました。`);
    await expect(page.getByLabel('決めていないこと(1 行に 1 つ)')).toHaveValue(new RegExp(asked.replace(/[?()]/g, '.')));
    await expect(stageOf(page, 'goal')).not.toHaveAttribute('data-state', 'done');
    await shoot(page, '4-unknown');

    // 帯の「これで決める」を押すと、段 2 に ✓ が付く(問いの途中でも決められる)
    await page.getByRole('region', { name: '次の一手' }).getByRole('button', { name: 'これで決める' }).click();
    await expect(page.locator('#intent-doc-state')).toContainText('決めました');
    await expect(stageOf(page, 'goal')).toHaveAttribute('data-state', 'done');
    await expect(stageOf(page, 'goal')).toContainText('✓');
    // 決めた後は推測の札がない(人が決めたので)
    await expect(page.locator('.intent-row[data-guess="true"]')).toHaveCount(0);
  } finally {
    await studio.stop();
  }
});

test('はじめ: 見本の試作品から始めると、見本の試作品の画面になり、試作品を新しく作らない', async ({ page, home }) => {
  const studio = await launchStudio(home, { env: START });
  try {
    await page.goto(studio.url);
    await expect(page.getByRole('heading', { level: 2, name: '思いつきを 1 文で書いてください' })).toBeVisible();
    await page.locator('#intent-samples > summary').click();
    await page.getByRole('list', { name: '見本の試作品' }).getByRole('button', { name: /図書室/ }).click();
    await expect(page.getByRole('heading', { level: 2, name: '思いつきを 1 文で書いてください' })).toBeHidden();
    await expect(page.locator('iframe[title="試作品"]')).toHaveAttribute('src', new RegExp(`/p/${SAMPLES.library.id}/`));
    // 見本は段 1〜4 を「飛ばした」
    await expect(stageOf(page, 'talk')).toHaveAttribute('data-state', 'skipped');
    const { projects } = await studio.api('/api/projects');
    expect(projects.filter((project) => project.id.startsWith('idea-'))).toHaveLength(0);
  } finally {
    await studio.stop();
  }
});

test('整理の板: 札は「元: n 行目」か「推測」。推測は点線と文。個人の記録は責めない言葉で省く。聞く時間の間は、次の一手が「聞くこと」に向く', async ({ page, home }) => {
  test.setTimeout(90_000);
  const studio = await launchStudio(home);
  try {
    // 会を用意し、同意して始めて、聞き取りと整理の板に進む(整理する AI は偽接続)
    await page.goto(studio.url);
    await page.locator('#project-menu-button').click();
    await page.getByRole('button', { name: 'お客さんとの会を始める' }).click();
    await page.getByLabel('会の目的').fill('架空のパン屋の予約の問い合わせを考える会');
    await page.getByRole('button', { name: '会を用意する' }).click();
    await page.getByRole('button', { name: '同意して始める' }).click();
    await expect(page.getByRole('heading', { level: 2, name: 'ヒアリングの整理' })).toBeVisible();
    // 省くことを先に言う
    await expect(page.locator('.organize-omit')).toHaveText('(電話番号や名前らしいものは省きます)');

    const point = page.getByLabel('聞いた要点');
    for (const text of ['土曜の予約が多い', 'お店の人が電話を受けている', 'パンの種類は月に 1 回変わる']) {
      await point.fill(text);
      await point.press('Enter');
    }
    await expect(page.getByRole('list', { name: '打った要点' }).getByRole('listitem')).toHaveCount(3);
    // 電話番号らしいものは、責めない言葉で省く(打った文の値は出さない)
    await point.fill('090-0000-0000 から予約の電話があった');
    await point.press('Enter');
    await expect(page.locator('#organize-error')).toHaveText('電話番号らしいものは省きます。AI にも整理の板にも入れていません。その部分を抜くと、要点に足せます。');
    await expect(page.locator('#organize-error')).not.toContainText('ください');
    await point.fill('');

    await page.getByRole('button', { name: '整理する', exact: true }).click();
    const items = page.locator('#organize-columns .organize-item');
    await expect(items.first()).toBeVisible({ timeout: 30_000 });
    // どの札にも「元: n 行目」か「推測」がある
    for (const item of await items.all()) {
      const sources = await item.locator('.organize-source', { hasText: /^元: \d+ 行目「/ }).count();
      const guess = await item.getByText('推測', { exact: true }).count();
      expect(sources + guess, await item.innerText()).toBeGreaterThan(0);
    }
    await expect(items.filter({ hasText: '土曜の予約が多い' }).first()).toContainText('元: 1 行目「土曜の予約が多い」');
    // 推測の札は、色を外しても点線の縁と「推測」の文で分かる
    const guess = items.filter({ has: page.getByText('推測', { exact: true }) }).first();
    await expectGuessWithoutColor(page, guess);
    // 聞くこと(矛盾と聞いていないこと)。会の聞く時間の間は、次の一手が「聞くこと」の 1 つ目に向く(強い色のボタンは出さない)
    const asks = page.getByRole('list', { name: '聞くことの一覧' }).getByRole('listitem');
    await expect(asks.first()).toBeVisible();
    await expect(page.locator('#next-text')).toContainText('「聞くこと」の 1 つ目を、お客さんに聞きます。');
    expect(await strongButtons(page)).toHaveLength(0);
    await shoot(page, '5-board', page.locator('#organize-columns'));
  } finally {
    await studio.stop();
  }
});

// 字と地の差が足りない見本(質の見直しに「直す」が出る)
const FAINT = {
  'main.jsx': [
    "import { createRoot } from 'react-dom/client';",
    "import './style.css';",
    '',
    'function App() {',
    '  return (',
    '    <main>',
    '      <h1>図書室の受付(架空)</h1>',
    '      <p className="faint">返す日は、受付で聞いてください</p>',
    '    </main>',
    '  );',
    '}',
    '',
    "createRoot(document.getElementById('root')).render(<App />);",
    '',
  ].join('\n'),
  'style.css': '.faint { color: #c8c8c8; background: #ffffff; }\n',
};

test('質の見直し: 「測った数」と「AI の判断」が別の列。見ていない行は ○ と「まだ見ていない」で ✓ と違う。頭に「見た n / m・まだ k」。右上は弱いボタン', async ({ page, home }) => {
  test.setTimeout(90_000);
  await writeProject(home, 'faint-look', FAINT, '図書室の受付(架空)');
  const studio = await launchStudio(home);
  try {
    await page.goto(studio.url);
    await page.locator('#project-menu-button').click();
    await page.getByRole('navigation', { name: '試作品の一覧' }).getByRole('button', { name: /図書室の受付/ }).click();
    await expect(page.frameLocator('iframe[title="試作品"]').getByRole('heading', { name: '図書室の受付(架空)' })).toBeVisible();
    await goStage(page, '質');
    const box = page.locator('#quality');
    const table = box.getByRole('table', { name: '質の見直しの表' });
    await expect(table).toBeVisible();
    // 列: 項目、測った数、AI の判断、なぜ大事か、直す
    await expect(table.locator('thead th')).toHaveText(['項目', '測った数', 'AI の判断', 'なぜ大事か', '直す']);
    // 測ったものの行は「測った数」の列に結果があり、「AI の判断」の列は「─」
    const colors = table.locator('tbody tr[data-row="colors"]');
    await expect(colors.locator('td').nth(0)).toContainText('値のまま書いた色');
    await expect(colors.locator('td').nth(1)).toHaveText('─');
    // AI の判断の行は「AI の判断」の列に「AI の判断」の札があり、「測った数」の列は「─」
    for (const id of ['natural', 'usability']) {
      const row = table.locator(`tbody tr[data-row="${id}"]`);
      await expect(row.locator('td').nth(0)).toHaveText('─');
      await expect(row.locator('td').nth(1).locator('.quality-mark')).toHaveText('AI の判断');
    }
    await expect(table.locator('tbody tr[data-group="measured"] .quality-mark')).toHaveCount(0);

    // 見ていない行は ○ と「まだ見ていない」。✓ と同じ見た目にしない
    const unseen = table.locator('tbody tr[data-status="unseen"]');
    await expect(unseen.first()).toBeVisible();
    for (const row of await unseen.all()) {
      await expect(row.locator('th .quality-state')).toHaveText('○');
      await expect(row.locator('th .quality-unseen')).toHaveText('まだ見ていない');
    }
    // 頭の数: 見た n / m・まだ k。まだの数は、見ていない行の数
    const count = page.locator('#quality-count');
    const unseenCount = await unseen.count();
    await expect(count).toHaveText(new RegExp(`^見た \\d+ / \\d+・まだ ${unseenCount}・直す \\d+$`));
    // 右上の「試作品を自動で確かめる」は弱いボタン。作業台に強い色のボタンはない
    const check = page.getByRole('region', { name: '試作品を自動で確かめる' }).getByRole('button', { name: '試作品を自動で確かめる' });
    await expect(check).toBeVisible();
    await expect(check).toHaveClass(/quiet/);
    const checkBox = await check.boundingBox();
    const tableBox = await table.boundingBox();
    expect(checkBox.y).toBeLessThan(tableBox.y);
    expect(checkBox.x + checkBox.width).toBeGreaterThan(tableBox.x + tableBox.width / 2);
    for (const button of await strongButtons(page)) expect(button.inBand).toBe(true);
    await shoot(page, '7-quality-before');

    // 画面を確かめると、字と地の差の行が ✓ でなく「!」と「直す」になり、見た数が増える。✓ の行と ○ の行は印が違う
    await box.getByRole('button', { name: '画面を確かめて見直す' }).click();
    const contrast = table.locator('tbody tr[data-row="contrast"]');
    await expect(contrast).toHaveAttribute('data-status', 'fix', { timeout: 60_000 });
    await expect(contrast.locator('th .quality-state')).toHaveText('!');
    const ok = table.locator('tbody tr[data-status="ok"]').first();
    await expect(ok.locator('th .quality-state')).toHaveText('✓');
    await expect(ok.locator('th .quality-unseen')).toHaveCount(0);
    const unseenStyle = await table.locator('tbody tr[data-status="unseen"] th .quality-state').first().evaluate((el) => getComputedStyle(el).color);
    const okStyle = await ok.locator('th .quality-state').evaluate((el) => getComputedStyle(el).color);
    expect(unseenStyle).not.toBe(okStyle);
    // 次の一手は、上の「直す」の行を直す
    await expect(page.locator('#next-text')).toContainText('に直すところがあります。');
    await expectNoDevWordsOnScreen(page);
    await shoot(page, '7-quality');
  } finally {
    await studio.stop();
  }
});

// 作る AI の起動の数(偽接続の run の数)
async function runsOf(studio, id) {
  const { runs } = await studio.api(`/api/projects/${id}/build-requests`);
  return runs.length;
}

test('見せる: 見せる画面に開発の言葉、段の道筋、今の行、仕組みの引き出しがなく「データは架空です」。操作役の画面で、反応では作る AI が動かないと分かり、承認で 1 回だけ動く', async ({ page, home }) => {
  test.setTimeout(150_000);
  const studio = await launchStudio(home);
  const id = SAMPLES.jobConsult.id;
  try {
    await page.goto(studio.url);
    await chooseSample(page, SAMPLES.jobConsult);
    const app = page.frameLocator('iframe[title="試作品"]');
    await expect(app.getByRole('heading', { name: 'しおかぜ求人相談' })).toBeVisible();
    await startShowing(page);
    const show = page.getByRole('region', { name: '確かめたい問い' });
    await expect(show).toBeVisible();

    // 見せる画面: 試作品、確かめたいこと、「データは架空です」、お試しか本物か。ほかは出さない
    await expect(page.locator('#show-fiction')).toHaveText('データは架空です');
    await expect(page.locator('#show-trial-ai')).toContainText('試作品の中の AI: お試し');
    await expect(page.locator('#stage-list')).toBeHidden();
    await expect(page.getByRole('region', { name: '今の行' })).toBeHidden();
    await expect(page.getByRole('region', { name: '次の一手' })).toBeHidden();
    await page.keyboard.press('.');
    await expect(page.locator('#mechanism')).toBeHidden();
    await expect(page.locator('#mechanism-button')).toBeHidden();
    await expectNoDevWordsOnScreen(page);
    expect(devWordsIn(await app.locator('body').innerText())).toEqual([]);
    // コメントを書く欄はあるが、一覧と承認は出さない
    await expect(show.getByRole('button', { name: 'コメントを書く' })).toBeVisible();
    await expect(page.getByRole('list', { name: 'コメントの一覧' })).toBeHidden();
    await show.getByRole('textbox', { name: 'コメント', exact: true }).fill('見出しを「うみかぜ求人相談」にして');
    await show.getByRole('button', { name: 'コメントを書く' }).click();
    await expect(page.locator('#comment-status')).toContainText('コメント 1 を書きました。');
    await show.getByRole('textbox', { name: 'コメント', exact: true }).fill('相談の受付時間を書いてほしい');
    await show.getByRole('radio', { name: '要件' }).check();
    await show.getByRole('button', { name: 'コメントを書く' }).click();
    await expect(page.locator('#comment-status')).toContainText('コメント 2 を書きました。');
    await shoot(page, '6-customer');

    // 操作役の画面: 枠が出て、コメントの一覧の頭に「反応では作る AI は動かない」の 1 文。反応と承認待ちを分ける
    await page.getByRole('button', { name: '操作役の画面へ' }).click();
    await expect(page.locator('#stage-list button.stage[data-stage="show"]')).toHaveAttribute('aria-current', 'step');
    await expect(page.getByRole('region', { name: '今の行' })).toBeVisible();
    // 見せている間は、試作品の切り替えと段の移動を止める(見せている試作品と答えを残す先がずれないように)
    await expect(page.locator('#project-menu-button')).toBeDisabled();
    await expect(page.locator('#stage-list button.stage[data-stage="goal"]')).toBeDisabled();
    await expect(page.locator('#comment-react-note')).toHaveText('反応(同じ意見)を付けても、作る AI は動きません。承認したコメントだけを、作る AI に送ります。');
    const list = page.getByRole('list', { name: 'コメントの一覧' });
    const item = (n) => list.locator(':scope > li').filter({ has: page.getByText(`コメント ${n}`, { exact: true }) });
    await expect(item(1).locator('.comment-reacts')).toContainText('反応 0');
    await expect(item(1).locator('.comment-approve')).toContainText('承認待ち');
    await expect(item(1).locator('.comment-approve')).toContainText('承認 0 / 1');
    // 要件のコメントは 2 人の承認で動く。「1 / 2」と出す
    await item(2).getByRole('button', { name: '進行役として承認' }).click();
    await expect(item(2).locator('.comment-approve')).toContainText('承認 1 / 2(2 人が要ります)');
    await expect(page.locator('#comment-summary')).toHaveText('承認待ち 2 つ・反応 0');
    // 反応を付けても、作る AI は動かない(帯もそう言う)
    for (let i = 0; i < 3; i += 1) await item(1).getByRole('button', { name: /に反応を付ける/ }).click();
    await expect(item(1).locator('.comment-reacts')).toContainText('反応 3');
    await expect(page.locator('#next-text')).toContainText('反応では作る AI は動きません。');
    await page.waitForTimeout(1500);
    expect(await runsOf(studio, id)).toBe(0);
    // 強い色のボタンは帯の外にない(承認のボタンも強い色にしない)
    for (const button of await strongButtons(page)) expect(button.inBand, button.text).toBe(true);
    await expectNoDevWordsOnScreen(page);
    await shoot(page, '6-operator');

    // 承認で 1 回だけ動く。直した後は、コメントに「元に戻す」が残る
    await item(1).getByRole('button', { name: '決める人として承認' }).click();
    await expect(item(1)).toContainText('確かめる', { timeout: 60_000 });
    await expect(app.getByRole('heading', { name: 'うみかぜ求人相談' })).toBeVisible();
    expect(await runsOf(studio, id)).toBe(1);
    await expect(item(1).getByRole('button', { name: '元に戻す' })).toBeVisible();
    await page.waitForTimeout(1500);
    expect(await runsOf(studio, id)).toBe(1);
    await expect(page.locator('#next-text')).toContainText('作る AI が直したコメントが 1 つあります。');
    await shoot(page, '6-fixed');

    // 見せる画面に戻ると、また枠と一覧を隠す
    await page.getByRole('button', { name: '見せる画面に戻る' }).first().click();
    await expect(page.locator('#stage-list')).toBeHidden();
    await expect(list).toBeHidden();
    // 見せ終わると、試作品の切り替えと段の移動が戻る
    await page.getByRole('button', { name: '見せ終わる' }).click();
    await expect(page.locator('#project-menu-button')).toBeEnabled();
    await expect(page.locator('#stage-list button.stage[data-stage="goal"]')).toBeEnabled();
  } finally {
    await studio.stop();
  }
});

