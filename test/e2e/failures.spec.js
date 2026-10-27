import fs from 'node:fs/promises';
import path from 'node:path';
import { expect, launchStudio, test, writeProject } from './studio.js';

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
    await expect(page.locator('#connection')).toHaveText('つながっています');
    await expect(page.getByRole('alert')).toBeHidden();
    expect(new URL(page.url()).hash).toBe('');
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
    await page.getByRole('button', { name: /壊れた試作品/ }).click();
    await expect(page.getByRole('button', { name: /壊れた試作品/ })).toContainText('ビルドに失敗');

    const status = page.locator('#build-status');
    await expect(status).toContainText('ビルドに失敗しました');
    await expect(status.getByRole('list', { name: 'ビルドの問題' })).toContainText('app/main.jsx(1 行');
    await expect(status).toContainText('直し方: app/ の中のファイルを直してから「作り直す」を押してください。');
    await expect(status).toContainText(appDir);
    await expect(page.locator('#frame-host')).toContainText('表示できる版がありません');

    await page.getByRole('button', { name: /使えないライブラリ/ }).click();
    await expect(status).toContainText('「lodash」は使えません');

    // 直して作り直す
    await page.getByRole('button', { name: /壊れた試作品/ }).click();
    await fs.writeFile(
      path.join(appDir, 'main.jsx'),
      'const items = [1, 2];\ndocument.getElementById("root").textContent = "直りました " + items.join(",");\n',
    );
    await page.getByRole('button', { name: '作り直す' }).click();
    await expect(status).toContainText('ビルドに成功しました');
    await expect(page.frameLocator('iframe[title="試作品"]').getByText('直りました 1,2')).toBeVisible();
  } finally {
    await studio.stop();
  }
});

test('試作品の実行時エラーを、中身つきで詳細の欄に出す', async ({ page, home }) => {
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
    await page.getByRole('button', { name: /エラーを出す試作品/ }).click();
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

test('Studio のサーバーが止まったら、つながらないことと次の手順を出す', async ({ page, home }) => {
  const studio = await launchStudio(home);
  await page.goto(studio.url);
  await expect(page.locator('#connection')).toHaveText('つながっています');
  await studio.stop();
  await expect(page.getByRole('alert')).toContainText('Studio のサーバーにつながりません', { timeout: 10_000 });
  await expect(page.getByRole('alert')).toContainText('npm start');
  await expect(page.locator('#connection')).toHaveText('つながっていません');
});
