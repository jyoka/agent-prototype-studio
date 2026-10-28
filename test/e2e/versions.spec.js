import fs from 'node:fs/promises';
import path from 'node:path';
import { SAMPLES, chooseSample, expect, launchStudio, test } from './studio.js';

// 版の保存と復元を、画面の操作だけで確かめる。作る AI は偽接続、プロダクト内 AI はモックで、実モデルは呼ばない。

const AFTER_CORRECTION = '直していただいた勤務地「もみじ台」で進めます。雇用区分「アルバイト・パート」と理解しました。';

function parts(page) {
  const app = page.frameLocator('iframe[title="試作品"]');
  const message = app.getByLabel('メッセージ');
  return {
    app,
    badge: page.locator('#work-badge'),
    status: page.locator('#working-status'),
    notice: page.locator('#versions-message'),
    versionList: page.getByRole('list', { name: '保存した版' }),
    log: app.getByRole('region', { name: '会話' }).getByRole('listitem'),
    conditions: app.getByRole('region', { name: '希望条件' }).locator('.value'),
    async say(text) {
      await message.fill(text);
      await app.getByRole('button', { name: '送る' }).click();
      await expect(message).toHaveValue('');
    },
  };
}

test('保存した版に戻すと、ファイルと会話と状態が戻る。Studio を起動し直しても、保存した版から再開できる', async ({ page, home }) => {
  // Studio を 2 回起動するので、ほかのテストより長く待つ
  test.setTimeout(90_000);
  let studio = await launchStudio(home);
  const appFile = path.join(home, 'projects', 'sample-job-consult', 'app', 'App.jsx');
  try {
    await page.goto(studio.url);
    await chooseSample(page, SAMPLES.jobConsult);
    const ui = parts(page);
    await expect(ui.app.getByRole('heading', { name: 'しおかぜ求人相談' })).toBeVisible();
    await expect(ui.badge).toHaveText('作業中(まだ保存していません)');
    await expect(ui.versionList.getByRole('listitem')).toHaveCount(0);

    // 試して、良いところで保存する
    await ui.say('カフェで働きたいです');
    await ui.app.getByLabel('勤務地を直す').selectOption('もみじ台');
    await expect(ui.log.last()).toHaveText('あなたの修正: 勤務地を「もみじ台」に直しました。');
    await page.getByLabel('版の名前(なくてもよい)').fill('最初の良い版');
    await page.getByRole('button', { name: '今の作業中を保存' }).click();
    await expect(ui.notice).toHaveText('v1「最初の良い版」として保存しました。');
    await expect(ui.badge).toHaveText('作業中 = 保存版 v1');
    await expect(ui.status).toHaveText('作業中は保存版 v1「最初の良い版」と同じです。');
    const v1 = ui.versionList.getByRole('listitem').filter({ hasText: 'v1' });
    await expect(v1).toContainText('最初の良い版');
    await expect(v1).toContainText('会話: 発言 1 件');
    await expect(v1).toContainText('作業中と同じ');
    await page.screenshot({ path: test.info().outputPath('1-saved.png'), fullPage: true });

    // 作る欄で試作品を変え、会話も進める。作業中は保存版と違うと出る
    await page.getByLabel('依頼').fill('見出しを「うみかぜ求人相談」にして');
    await page.getByRole('button', { name: '送る' }).click();
    await expect(ui.app.getByRole('heading', { name: 'うみかぜ求人相談' })).toBeVisible();
    await expect(ui.badge).toHaveText('作業中(保存していない変更あり)');
    await expect(ui.status).toHaveText('作業中には、保存していない変更があります(保存版 v1「最初の良い版」から)。');
    await expect(v1).not.toContainText('作業中と同じ');
    await ui.say('アルバイトがいいです');
    await expect(ui.log.last()).toContainText(AFTER_CORRECTION);
    await expect(ui.log).toHaveCount(6);
    await page.screenshot({ path: test.info().outputPath('2-changed.png'), fullPage: true });

    // 復元すると、変更前のファイルと、保存したときの会話と条件に戻る。戻す前の作業中は自動で保存される
    await page.getByRole('button', { name: 'v1 を復元' }).click();
    await expect(ui.notice).toHaveText('v1「最初の良い版」に戻しました。戻す前の作業中は v2(自動)に保存しました。');
    await expect(ui.app.getByRole('heading', { name: 'しおかぜ求人相談' })).toBeVisible();
    await expect(ui.log).toHaveCount(4);
    await expect(ui.log.last()).toHaveText('あなたの修正: 勤務地を「もみじ台」に直しました。');
    await expect(ui.conditions).toHaveText(['カフェのホール', '未定', 'もみじ台', '未定']);
    await expect(page.getByRole('definition')).toHaveText(['カフェのホール', '未定', 'もみじ台', '未定']);
    await expect(ui.badge).toHaveText('作業中 = 保存版 v1');
    expect(await fs.readFile(appFile, 'utf8')).toContain('<h1>しおかぜ求人相談</h1>');
    const v2 = ui.versionList.getByRole('listitem').filter({ hasText: 'v2' });
    await expect(v2).toContainText('復元の前の作業中(自動)');
    await expect(v2).toContainText('自動');
    await expect(v2).toContainText('会話: 発言 2 件');
    await page.screenshot({ path: test.info().outputPath('3-restored.png'), fullPage: true });

    // 保存したときの初期条件から続けると、同じ応答が返る(本人の修正を踏まえる)
    await ui.say('アルバイトがいいです');
    await expect(ui.log.last()).toContainText(AFTER_CORRECTION);
    await expect(ui.badge).toHaveText('作業中(会話が v1 から変わっています)');
  } finally {
    await studio.stop();
  }

  // 起動し直す。作業中の会話は消えるが、保存した版は残り、そこから再開できる
  studio = await launchStudio(home);
  try {
    await page.goto(studio.url);
    await chooseSample(page, SAMPLES.jobConsult);
    const ui = parts(page);
    await expect(ui.app.getByRole('heading', { name: 'しおかぜ求人相談' })).toBeVisible();
    await expect(ui.log).toHaveCount(1);
    await expect(ui.badge).toHaveText('作業中(ファイルは v1 と同じ)');
    await expect(ui.status).toContainText('会話と状態は最初のままです');
    await expect(ui.versionList.getByRole('listitem')).toHaveText([/^v2/, /^v1/]);

    // 会話が最初のままなら、失うものがないので自動の保存はしない
    await page.getByRole('button', { name: 'v1 を復元' }).click();
    await expect(ui.notice).toHaveText('v1「最初の良い版」に戻しました。');
    await expect(ui.log).toHaveCount(4);
    await expect(ui.conditions).toHaveText(['カフェのホール', '未定', 'もみじ台', '未定']);
    await ui.say('アルバイトがいいです');
    await expect(ui.log.last()).toContainText(AFTER_CORRECTION);
    await page.screenshot({ path: test.info().outputPath('4-resumed-after-restart.png'), fullPage: true });

    // 自動で保存した版(変更の後)にも戻れる
    await page.getByRole('button', { name: 'v2 を復元' }).click();
    await expect(ui.notice).toContainText('v2「復元の前の作業中(自動)」に戻しました。');
    await expect(ui.app.getByRole('heading', { name: 'うみかぜ求人相談' })).toBeVisible();
    await expect(ui.log).toHaveCount(6);
    await expect(ui.conditions).toHaveText(['カフェのホール', 'アルバイト・パート', 'もみじ台', '未定']);
    await expect(ui.versionList.getByRole('listitem')).toHaveText([/^v3/, /^v2/, /^v1/]);
    await expect(page.locator('#events-empty')).toBeVisible();
  } finally {
    await studio.stop();
  }
});

test('ビルドできない状態は保存せず、理由を出す。作る AI の作業中は版を操作できない', async ({ page, home }) => {
  const studio = await launchStudio(home);
  try {
    await page.goto(studio.url);
    await chooseSample(page, SAMPLES.library);
    const ui = parts(page);
    await expect(ui.app.getByRole('heading', { name: 'こもれび図書室' })).toBeVisible();
    await page.getByRole('button', { name: '今の作業中を保存' }).click();
    await expect(ui.badge).toHaveText('作業中 = 保存版 v1');

    await page.getByLabel('依頼').fill('壊して、直せないふりをして');
    await page.getByRole('button', { name: '送る' }).click();
    // 作る AI が直すラウンドを終えて、壊れたまま人に返すまで待つ
    await expect(page.getByRole('list', { name: '作る会話' }).locator('[data-kind="gave-up"]')).toBeVisible();
    await expect(page.locator('#build-status')).toContainText('ビルドに失敗しました');
    await page.getByRole('button', { name: '今の作業中を保存' }).click();
    await expect(ui.notice).toContainText('保存できませんでした: ビルドできない状態は保存できません');
    await expect(ui.versionList.getByRole('listitem')).toHaveCount(1);

    // 壊れた作業中からも戻せる。壊れた作業中は自動で保存され、ビルドできない状態と出る
    await page.getByRole('button', { name: 'v1 を復元' }).click();
    await expect(ui.notice).toHaveText('v1 に戻しました。戻す前の作業中は v2(自動)に保存しました。');
    await expect(page.locator('#build-status')).toContainText('ビルドに成功しました');
    await expect(ui.versionList.getByRole('listitem').filter({ hasText: 'v2' })).toContainText('ビルドできない状態');

    await page.getByLabel('依頼').fill('ゆっくり進めて');
    await page.getByRole('button', { name: '送る' }).click();
    await expect(page.getByRole('button', { name: '中断' })).toBeVisible();
    await expect(page.getByRole('button', { name: '今の作業中を保存' })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'v1 を復元' })).toBeDisabled();
    await page.getByRole('button', { name: '中断' }).click();
    await expect(page.getByRole('button', { name: '今の作業中を保存' })).toBeEnabled();
  } finally {
    await studio.stop();
  }
});
