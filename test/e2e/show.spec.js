import { SAMPLES, chooseSample, closeMore, devWordsIn, expect, expectNoDevWordsOnScreen, launchStudio, openVersions, startShowing, test } from './studio.js';

// 人に見せる(docs/design/user-journey.md の J7。段 7)。段 8「見せる」の次の一手の帯の「人に見せる」で、見せる画面にする。
// 見せる画面には、試作品と確かめたい問いだけが出て、開発の欄と開発の言葉は出ない。問いは目的の文書の成功の印から作る。
// 答えは見せた版に残り、版を戻しても消えない。作る AI は偽接続、試作品の中の AI はお試しの AI で、実モデルは呼ばない。題材は架空

const SUCCESS = '相談に来た人が、希望の条件を 3 分で伝えられる。\n担当が聞き直す回数が減る';
const QUESTIONS = [
  'この試作品で「相談に来た人が、希望の条件を 3 分で伝えられる」に近づきそうですか?',
  'この試作品で「担当が聞き直す回数が減る」に近づきそうですか?',
  '使ってみて、分かりにくいところや困ったところはありましたか?',
];
const ANSWER = '近づきそう。勤務地を選び直せるのが分かりやすい';

function parts(page) {
  const app = page.frameLocator('iframe[title="試作品"]');
  const show = page.getByRole('region', { name: '確かめたい問い' });
  return {
    app,
    show,
    questions: show.getByRole('list', { name: '確かめたい問い' }).getByRole('listitem'),
    status: page.locator('#show-status'),
    versionList: page.getByRole('list', { name: '保存した状態の一覧' }),
  };
}

async function startShow(page) {
  await startShowing(page);
}

// 目的の文書に成功の印を書いて決める(人が目的の画面でする操作を、API で先に済ませる)
async function decideIntent(studio, id) {
  expect((await studio.post(`/api/projects/${id}/intent/skip`, {})).status).toBe(200);
  const doc = { who: '仕事を探している人(架空)', problem: '希望の条件をうまく伝えられない', scene: '相談の窓口', success: SUCCESS, notDoing: [], undecided: [] };
  expect((await studio.post(`/api/projects/${id}/intent/decide`, { doc })).status).toBe(200);
}

test('見せる画面には試作品と問いだけが出て、開発の言葉が出ない。答えは見せた版に残り、版を戻しても消えない', async ({ page, home }) => {
  test.setTimeout(90_000);
  const studio = await launchStudio(home);
  try {
    await decideIntent(studio, SAMPLES.jobConsult.id);
    await page.goto(studio.url);
    await chooseSample(page, SAMPLES.jobConsult);
    const ui = parts(page);
    await expect(ui.app.getByRole('heading', { name: 'しおかぜ求人相談' })).toBeVisible();

    // 見せる。まだ版がないので、今の状態を保存してから見せる。引き出しは閉じる
    await startShow(page);
    await expect(page.locator('#mechanism')).toBeHidden();
    await expect(ui.show).toBeVisible();
    await expect(page.getByRole('heading', { name: '確かめたい問い' })).toBeFocused();
    await expect(ui.show).toContainText('これは試作品です。出てくるデータは、すべて架空です。');
    await expect(ui.show).toContainText('見せる前に、今の状態を保存 1「人に見せた状態」として保存しました。答えは保存 1「人に見せた状態」に残します。');
    await expect(ui.questions).toHaveText(QUESTIONS);

    // 開発の欄は隠れる(上の帯、言葉で直す、試す欄の道具、記録と質の見直し)。試作品はそのまま触れる
    await expect(page.getByRole('banner')).toBeHidden();
    await expect(page.getByRole('heading', { name: '作る AI' })).toBeHidden();
    await expect(page.locator('#try-toolbar')).toBeHidden();
    await expect(page.locator('#quality')).toBeHidden();
    await expect(page.locator('#scene-runs')).toBeHidden();
    await ui.app.getByLabel('メッセージ').fill('カフェで働きたいです');
    await ui.app.getByRole('button', { name: '送る' }).click();
    await expect(ui.app.getByRole('region', { name: '会話' }).getByRole('listitem').last()).toContainText('カフェ');

    // 見せている間に、ほかの画面(ここでは設計の案内)が開いた印が付いても、見せる画面は隠れない
    await page.evaluate(() => (document.body.dataset.design = 'open'));
    await expect(ui.show).toBeVisible();
    await expect(page.locator('iframe[title="試作品"]')).toBeVisible();
    await page.evaluate(() => delete document.body.dataset.design);

    // 開発の言葉が、見せる画面にも試作品の中にも出ない
    await expectNoDevWordsOnScreen(page);
    expect(devWordsIn(await ui.app.locator('body').innerText())).toEqual([]);
    await page.screenshot({ path: test.info().outputPath('1-show.png'), fullPage: true });

    // 答えを書かずに残そうとすると止まる。書いて残す
    await ui.show.getByRole('button', { name: '答えを残す' }).click();
    await expect(ui.status).toHaveText('答えが 1 つもありません。聞いた答えを書いてから残してください。');
    await ui.show.getByLabel(QUESTIONS[0]).fill(ANSWER);
    await ui.show.getByLabel('見せた相手(なくてもよい)').fill('同僚');
    await ui.show.getByRole('button', { name: '答えを残す' }).click();
    await expect(ui.status).toHaveText('保存 1「人に見せた状態」に答えを残しました(1 問)。次の人に見せるときは、そのまま続けられます。');
    await expect(ui.show.getByLabel(QUESTIONS[0])).toHaveValue('');
    await expectNoDevWordsOnScreen(page);

    // 残していない答えがあるまま見せ終わると、1 回目は知らせて止まる。もう一度押すと閉じる
    await ui.show.getByLabel(QUESTIONS[2]).fill('残さない答え');
    await ui.show.getByRole('button', { name: '見せ終わる' }).click();
    await expect(ui.status).toContainText('残していない答えがあります。');
    await expect(ui.show).toBeVisible();
    await ui.show.getByRole('button', { name: '見せ終わる' }).click();
    await expect(ui.show).toBeHidden();
    await expect(page.getByRole('banner')).toBeVisible();
    // 見せ終わると段 8 の作業台に戻る。右上の「■ 作る AI に頼む」で作る AI の欄に切り替えられる
    await expect(page.getByRole('button', { name: '作る AI に頼む' })).toBeVisible();

    // 答えは、見せた版の一覧に出る
    await openVersions(page);
    const v1 = ui.versionList.getByRole('listitem').filter({ hasText: '保存 1' });
    await v1.getByText('人に見せた答え(1 回)').click();
    await expect(v1).toContainText(QUESTIONS[0]);
    await expect(v1).toContainText(ANSWER);
    await expect(v1).toContainText('相手: 同僚');
    await expect(v1).not.toContainText('残さない答え');

    // 試作品を直して保存し、見せた版に戻し、また直した版に戻す。答えは消えない
    await closeMore(page);
    await page.getByRole('button', { name: '作る AI に頼む' }).click();
    await page.getByLabel('依頼').fill('見出しを「うみかぜ求人相談」にして');
    await page.getByRole('button', { name: '送る' }).click();
    await expect(ui.app.getByRole('heading', { name: 'うみかぜ求人相談' })).toBeVisible();
    await openVersions(page);
    await page.getByLabel('名前(なくてもよい)').fill('見出しを直した版');
    await page.locator('#save-version').click();
    await expect(page.locator('#versions-message')).toHaveText('保存しました(保存 2「見出しを直した版」)。');
    await page.getByRole('button', { name: '保存 1 の状態に戻す' }).click();
    await expect(ui.app.getByRole('heading', { name: 'しおかぜ求人相談' })).toBeVisible();
    await page.getByRole('button', { name: '保存 2 の状態に戻す' }).click();
    await expect(ui.app.getByRole('heading', { name: 'うみかぜ求人相談' })).toBeVisible();
    await expect(v1).toContainText('人に見せた答え(1 回)');
    await expect(ui.versionList.getByRole('listitem').filter({ hasText: '保存 2' })).not.toContainText('人に見せた答え');

    // 画面を読み込み直しても残っている
    await page.reload();
    await openVersions(page);
    await v1.getByText('人に見せた答え(1 回)').click();
    await expect(v1).toContainText(ANSWER);
    await page.screenshot({ path: test.info().outputPath('2-answers-kept.png'), fullPage: true });

    // 直した版を見せると、その版に結び付く(今の状態は保存 2 と同じなので、新しく保存しない)
    await startShow(page);
    await expect(ui.show).toContainText('答えは保存 2「見出しを直した版」に残します。');
    await expect(ui.show).not.toContainText('として保存しました');
    await expectNoDevWordsOnScreen(page);
  } finally {
    await studio.stop();
  }
});

test('目的の文書に成功の印がないときは、決まった問いで見せる', async ({ page, home }) => {
  const studio = await launchStudio(home);
  try {
    await page.goto(studio.url);
    await chooseSample(page, SAMPLES.library);
    const ui = parts(page);
    await startShow(page);
    await expect(ui.show).toContainText('目的の文書に「成功の印」がないので、決まった問いを出しています。');
    await expect(ui.questions).toHaveText(['この試作品を、ふだんの仕事で使ってみたいと思いますか?', '使ってみて、分かりにくいところや困ったところはありましたか?']);
    await expectNoDevWordsOnScreen(page);
    expect(devWordsIn(await ui.app.locator('body').innerText())).toEqual([]);
  } finally {
    await studio.stop();
  }
});
