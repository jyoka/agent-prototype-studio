import { expect, launchStudio, test } from './studio.js';

test('npm start で起動し、ブラウザでサンプルの試作品を操作できる', async ({ page, home }) => {
  const studio = await launchStudio(home, { useNpm: true });
  try {
    expect(studio.output()).toContain('Prototype Studio を起動しました。');
    expect(studio.output()).toContain('ビルド成功: sample-library');

    await page.goto(studio.url);
    await expect(page.locator('#connection')).toHaveText('つながっています');
    // 鍵は URL から消え、履歴に残らない
    expect(new URL(page.url()).hash).toBe('');
    await expect(page.getByRole('button', { name: /サンプル: 架空の図書室/ })).toHaveAttribute('aria-current', 'true');
    await expect(page.locator('#build-status')).toContainText('ビルドに成功しました');

    const iframe = page.locator('iframe[title="試作品"]');
    await expect(iframe).toHaveAttribute('sandbox', 'allow-scripts allow-forms');
    expect(await iframe.getAttribute('src')).toMatch(/^http:\/\/localhost:\d+\/p\/sample-library\/[a-f0-9]{32}\/$/);

    const app = page.frameLocator('iframe[title="試作品"]');
    await expect(app.getByRole('heading', { name: 'こもれび図書室' })).toBeVisible();
    await expect(app.getByText('架空のデータです。')).toBeVisible();
    await expect(app.locator('.summary')).toHaveText('全 8 冊、貸出できる本 6 冊');

    // 探す
    await app.getByLabel('書名か著者で探す').fill('雲');
    const list = app.getByRole('list', { name: '本の一覧' });
    await expect(list.getByRole('listitem')).toHaveCount(1);
    await list.getByRole('button', { name: /まちの雲図鑑/ }).click();

    // 借りる、返す
    const detail = app.getByRole('region', { name: '本の詳細' });
    await expect(detail.getByRole('heading', { name: 'まちの雲図鑑' })).toBeVisible();
    await detail.getByRole('button', { name: '借りる' }).click();
    await expect(detail.getByText('この本は貸出中です。')).toBeVisible();
    await expect(app.locator('.summary')).toHaveText('全 8 冊、貸出できる本 5 冊');
    await detail.getByRole('button', { name: '返す' }).click();
    await expect(app.locator('.summary')).toHaveText('全 8 冊、貸出できる本 6 冊');

    // 分野で絞る
    await app.getByLabel('書名か著者で探す').fill('');
    await app.getByRole('group', { name: '分野' }).getByRole('button', { name: '小説' }).click();
    await expect(list.getByRole('listitem')).toHaveCount(2);

    // 登録する
    await app.getByRole('group', { name: '分野' }).getByRole('button', { name: 'すべて' }).click();
    const form = app.getByRole('form', { name: '本を登録する' });
    await form.getByLabel('書名').fill('架空の星座あつめ');
    await form.getByLabel('著者').fill('夜空 ひかる');
    await form.getByRole('button', { name: '登録する' }).click();
    await expect(app.locator('.summary')).toHaveText('全 9 冊、貸出できる本 7 冊');
    await expect(detail.getByRole('heading', { name: '架空の星座あつめ' })).toBeVisible();

    // 試作品からエラーは届いていない
    await expect(page.locator('#events-empty')).toBeVisible();

    // 再読み込みしても、同じタブなら使い続けられる
    await page.reload();
    await expect(page.locator('#connection')).toHaveText('つながっています');
    await expect(app.getByRole('heading', { name: 'こもれび図書室' })).toBeVisible();
  } finally {
    await studio.stop();
  }
});
