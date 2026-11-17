import fs from 'node:fs/promises';
import path from 'node:path';
import { chooseProject, chooseSample, closeMore, expect, expectNoDevWords, expectNoDevWordsOnScreen, expectReadableText, launchStudio, openDevDetails, ROOT, SAMPLES, test, writeProject } from './studio.js';

// 「分かるか」の確かめ(ux-redesign.md 9 節)のスクリーンショットの置き場。test-results/ は git が無視する
const UX_SHOTS = path.join(ROOT, 'test-results', 'ux');

test('URL の鍵がない、または合わないときは、どうすればよいかを出す', async ({ page, home }) => {
  const studio = await launchStudio(home);
  try {
    await page.goto(`${studio.origin}/`);
    await expect(page.getByRole('alert')).toContainText('この画面を開くための鍵がありません');
    await expect(page.getByRole('alert')).toContainText('ターミナルに表示された URL');

    // 案内のとおり、同じタブに URL を貼る。フラグメントだけが変わるので、ブラウザは読み直さない
    await page.goto(`${studio.origin}/#token=${'0'.repeat(64)}`);
    await expect(page.getByRole('alert')).toContainText('鍵が合いません');
    await expect(page.locator('iframe')).toHaveCount(0);

    await page.goto(studio.url);
    await expect(page.locator('#connection')).toBeHidden();
    await expect(page.getByRole('alert')).toBeHidden();
    expect(new URL(page.url()).hash).toBe('');
    await chooseSample(page, SAMPLES.library);
    const app = page.frameLocator('iframe[title="試作品"]');
    await expect(app.getByRole('heading', { name: 'こもれび図書室' })).toBeVisible();
  } finally {
    await studio.stop();
  }
});

test('ビルドに失敗した試作品は、場所と直し方を出し、直して作り直すと開ける', async ({ page, home }) => {
  const appDir = await writeProject(
    home,
    'broken-demo',
    { 'main.jsx': 'const items = [1, 2;\ndocument.getElementById("root").textContent = items.join(",");\n' },
    '壊れた試作品',
  );
  await writeProject(home, 'unknown-lib', { 'main.js': 'import _ from "lodash";\nconsole.log(_);\n' }, '使えないライブラリ');
  const studio = await launchStudio(home);
  try {
    expect(studio.output()).toContain('ビルド失敗: broken-demo');
    await page.goto(studio.url);
    // 上の帯の一覧の行に、表示できないことを短く出す
    const broken = await chooseProject(page, /壊れた試作品/);
    await expect(broken).toContainText('表示できません');

    // ビルドの結果は、仕組みの引き出しにある
    await openDevDetails(page);
    const status = page.locator('#build-status');
    await expect(status).toContainText('ビルドに失敗しました');
    await expect(status.getByRole('list', { name: 'ビルドの問題' })).toContainText('app/main.jsx(1 行');
    await expect(status).toContainText('直し方: app/ の中のファイルを直してから「ファイルから作り直す」を押してください。');
    await expect(status).toContainText(appDir);
    await expect(page.locator('#frame-host')).toContainText('表示できる状態がありません');

    await chooseProject(page, /使えないライブラリ/);
    await expect(status).toContainText('「lodash」は使えません');

    // 直して作り直す
    await chooseProject(page, /壊れた試作品/);
    await fs.writeFile(
      path.join(appDir, 'main.jsx'),
      'const items = [1, 2];\ndocument.getElementById("root").textContent = "直りました " + items.join(",");\n',
    );
    await page.getByRole('button', { name: 'ファイルから作り直す' }).click();
    await expect(status).toContainText('ビルドに成功しました');
    await expect(page.frameLocator('iframe[title="試作品"]').getByText('直りました 1,2')).toBeVisible();
  } finally {
    await studio.stop();
  }
});

test('試作品を表示できないときは、試す欄の上に理由と前の状態を出し、「直す AI に直してもらう」で依頼の欄に文を入れる(7-6)', async ({ page, home }) => {
  const appDir = await writeProject(
    home,
    'shop-demo',
    { 'main.jsx': 'document.getElementById("root").textContent = "架空の雑貨店 ひだまり堂";\n' },
    '架空の雑貨店',
  );
  const studio = await launchStudio(home);
  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(studio.url);
    await chooseProject(page, /架空の雑貨店/);
    const app = page.frameLocator('iframe[title="試作品"]');
    await expect(app.getByText('架空の雑貨店 ひだまり堂')).toBeVisible();
    const notice = page.getByRole('group', { name: '試作品を表示できません' });
    await expect(notice).toBeHidden();

    // 手でファイルを壊して作り直す(直す AI の変更でも、同じく表示できなくなる)
    await fs.writeFile(path.join(appDir, 'main.jsx'), 'const items = [1, 2;\ndocument.getElementById("root").textContent = items.join(",");\n');
    await openDevDetails(page);
    await page.getByRole('button', { name: 'ファイルから作り直す' }).click();
    await expect(page.locator('#build-status')).toContainText('ビルドに失敗しました');
    await closeMore(page);

    await expect(notice).toBeVisible();
    await expect(notice).toContainText('試作品のファイルに誤りがあります。下には、前に表示できた状態を出しています。');
    await expect(page.getByText('試作品(前に表示できた状態)')).toBeVisible();
    // 試す欄は、前に表示できた状態のまま
    await expect(app.getByText('架空の雑貨店 ひだまり堂')).toBeVisible();
    // 誤りの場所は開発者向けの中にだけあり、見える文字に開発の言葉はない(U3)
    const places = notice.getByRole('list', { name: '誤りの場所' });
    await expect(places).toBeHidden();
    await expectNoDevWords(notice);
    await expectNoDevWords(page.locator('#frame-label'));
    await expectReadableText(page, '試作品を表示できないとき');
    await page.screenshot({ path: path.join(UX_SHOTS, 'P26-cannot-display.png') });
    await notice.getByText('開発者向け: 誤りの場所(ファイルと行)').click();
    await expect(places).toContainText('app/main.jsx(1 行');

    // 押すと依頼の欄に文が入るだけで、送らない
    await notice.getByRole('button', { name: '直す AI に直してもらう' }).click();
    await expect(page.getByLabel('依頼')).toHaveValue('表示できるように直して');
    await expect(page.getByLabel('依頼')).toBeFocused();
    await expect(page.getByRole('list', { name: '作る会話' })).toContainText('まだ依頼はありません');
    expect((await studio.api('/api/projects/shop-demo/build-requests')).runs).toEqual([]);

    // 直して作り直すと、表示できないことの知らせは消える
    await fs.writeFile(path.join(appDir, 'main.jsx'), 'document.getElementById("root").textContent = "架空の雑貨店 直りました";\n');
    await openDevDetails(page);
    await page.getByRole('button', { name: 'ファイルから作り直す' }).click();
    await expect(page.locator('#build-status')).toContainText('ビルドに成功しました');
    await expect(notice).toBeHidden();
    await expect(page.locator('#frame-label')).toBeHidden();
    await expect(app.getByText('架空の雑貨店 直りました')).toBeVisible();
  } finally {
    await studio.stop();
  }
});

test('前に表示できた状態がない試作品も、表示できないことを試す欄の上に出す(7-6)', async ({ page, home }) => {
  await writeProject(home, 'broken-first', { 'main.jsx': 'const items = [1, 2;\n' }, '最初から壊れた試作品');
  const studio = await launchStudio(home);
  try {
    await page.goto(studio.url);
    await chooseProject(page, /最初から壊れた試作品/);
    const notice = page.getByRole('group', { name: '試作品を表示できません' });
    await expect(notice).toContainText('試作品のファイルに誤りがあります。前に表示できた状態もありません。');
    await expect(page.locator('#frame-label')).toBeHidden();
    await expectNoDevWords(notice);
  } finally {
    await studio.stop();
  }
});

test('試作品の実行時エラーを、中身つきで開発者向けの詳細に出す', async ({ page, home }) => {
  await writeProject(
    home,
    'runtime-error',
    {
      'main.js': [
        'console.error("起動したときの知らせ");',
        'const button = document.createElement("button");',
        'button.textContent = "数える";',
        'button.addEventListener("click", () => { throw new Error("在庫の数が読めません"); });',
        'document.getElementById("root").append(button);',
        '',
      ].join('\n'),
    },
    'エラーを出す試作品',
  );
  const studio = await launchStudio(home);
  try {
    await page.goto(studio.url);
    await chooseProject(page, /エラーを出す試作品/);
    await openDevDetails(page);
    const events = page.locator('#events');
    // port を渡す前に起きた知らせも届く
    await expect(events).toContainText('console.error: 起動したときの知らせ');

    await page.frameLocator('iframe[title="試作品"]').getByRole('button', { name: '数える' }).click();
    await expect(events).toContainText('実行時エラー: Uncaught Error: 在庫の数が読めません');
    await expect(events).not.toContainText('Script error');
  } finally {
    await studio.stop();
  }
});

test('Studio のサーバーが止まったときだけ、「Studio が止まっています」と直し方を出す', async ({ page, home }) => {
  const studio = await launchStudio(home);
  await page.goto(studio.url);
  await expect(page.frameLocator('iframe[title="試作品"]').getByRole('heading', { name: 'しおかぜ求人相談' })).toBeVisible();
  // 問題がないときは、つながっていることも、止まっていることも出さない(一覧の読み直しを 1 回待ってから見る)
  await page.waitForTimeout(3500);
  await expect(page.locator('#connection')).toBeHidden();
  await expect(page.getByRole('alert')).toBeHidden();
  await expect(page.getByText('Studio が止まっています')).toHaveCount(0);
  await expect(page.getByText('つながっています')).toHaveCount(0);

  await studio.stop();
  const alert = page.getByRole('alert');
  await expect(alert).toContainText('Studio が止まっています。', { timeout: 10_000 });
  await expect(alert).toContainText('直し方: npm start を実行したターミナルが開いたままか確かめてください。');
  await expect(alert).toContainText('もう一度 npm start を実行して、表示された URL を開いてください。');
  await expect(page.locator('#connection')).toHaveText('Studio が止まっています');
  await expectNoDevWordsOnScreen(page);
});
