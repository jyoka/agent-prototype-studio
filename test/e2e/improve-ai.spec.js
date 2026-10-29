import fs from 'node:fs/promises';
import path from 'node:path';
import { SAMPLES, chooseSample, chooseTestRequest, closeMore, expect, expectNoDevWords, launchStudio, test } from './studio.js';

// 自然言語でプロダクト内 AI の振る舞いを変え、前の発言を新しい設定で試し直す(#279)。
// 作る AI は偽接続(src/agent/fake-claude.js)、プロダクト内 AI はモック。モデルも外部の API も呼ばない。

const NOT_UNDERSTOOD_FIRST = 'すみません、希望の条件として読み取れませんでした。自由な言葉は、上の『AI: 本物』で試せます。';
const NOT_UNDERSTOOD = `${NOT_UNDERSTOOD_FIRST}どんなお仕事に興味がありますか?`;
const ASK_BY_EXAMPLE = 'すみません、うまく読み取れませんでした。たとえば「カフェのホール」「アルバイト・パート」「しおかぜ町」のように、短く教えてください。';
const AFTER_JOB = '職種「カフェのホール」と理解しました。働き方の希望はありますか?';
const AFTER_JOB_WAGE_FIRST = '職種「カフェのホール」と理解しました。時給はいくら以上を希望しますか?';

async function sendRequest(page, text) {
  await page.getByLabel('依頼').fill(text);
  await page.getByRole('button', { name: '送る' }).click();
}

function makeRuns(page) {
  return page.getByRole('list', { name: '作る会話' }).locator('> li.run');
}

test('作る欄の依頼でプロダクト内 AI の設定が変わり、前の発言を新しい設定で試し直して比べられる', async ({ page, home }) => {
  const studio = await launchStudio(home);
  try {
    await page.goto(studio.url);
    await chooseSample(page, SAMPLES.jobConsult);
    const app = page.frameLocator('iframe[title="試作品"]');
    const log = app.getByRole('region', { name: '会話' }).getByRole('listitem');
    const message = app.getByLabel('メッセージ');
    const say = async (text) => {
      await message.fill(text);
      await app.getByRole('button', { name: '送る' }).click();
      await expect(message).toHaveValue('');
    };
    // 試し直しの帯は、試す欄の上にある。直す前と後の返事は、帯の中で開いて見る(ux-redesign.md 7-4)
    const bar = page.getByRole('region', { name: '試し直す' });
    const comparison = bar.getByRole('region', { name: '直す前と後の返事' }).getByRole('listitem');

    // 1. 試作品で、プロダクト内 AI(モック)の応答を見る
    await say('よろしくお願いします');
    await expect(log.last()).toContainText(NOT_UNDERSTOOD);
    await say('カフェで働きたいです');
    await expect(log.last()).toContainText(AFTER_JOB);
    await expect(bar).toBeHidden();

    // 2. 作る欄で、振る舞いの変え方を自然言語で頼む。作る AI が書くのは設定(app/ai.json)
    // 偽接続の試験用の依頼は、開発者向けの詳細から選ぶ
    await chooseTestRequest(page, '読み取れなかったときは例を出して聞き返すようにして');
    await page.getByRole('button', { name: '送る' }).click();
    let run = makeRuns(page).last();
    await expect(run.locator('.run-status')).toContainText('終わりました');
    await expect(run.getByText('AI の設定を書きました')).toBeVisible();
    await expect(run.locator('.run-dev')).toContainText('書く: app/ai.json');
    await expect(run.locator('.run-updated')).toHaveText('AI の設定を変えました。試作品は新しくなっています。');
    await expect(run.locator('.run-dev')).toContainText('変わったファイル: app/ai.json');
    // 変わったかどうかは、作る AI の報告ではなく Studio が設定どうしを比べて出す
    let settings = run.locator('[data-kind="ai-settings"]');
    await expect(settings).toContainText('AI の設定(Studio が確かめた結果)');
    await expect(settings).toContainText(`お試しの AI の読み取れなかったときの返事: 「${NOT_UNDERSTOOD_FIRST}」 → 「${ASK_BY_EXAMPLE}」`);
    await expect(settings).toContainText('本物の AI への指示に足した文: 「読み取れなかったときは、選べる値の例を挙げて聞き返してください。」');
    // 案内するボタンは、試作品の上の試し直しの帯にあるものと同じ名前
    await expect(settings).toContainText('試作品の上の「同じ発言で試し直す」で、同じ発言を新しい設定に送り直せます。');
    await expect(run).toContainText('試作品に反映しました。');

    // 3. 設定が反映され、会話は新しい設定で最初から。前の会話は試し直せる
    await expect(log).toHaveCount(1);
    await expect(bar.getByRole('heading', { name: 'AI の設定が変わりました' })).toBeVisible();
    await expect(bar).toContainText('会話は新しい設定で最初から始まっています。前の会話(発言 2 件)を、新しい設定で送り直せます。');
    await bar.getByRole('button', { name: '同じ発言で試し直す' }).click();

    // 4. 同じ発言に、新しい設定で応答する。前と今の応答を並べて比べられる
    await expect(log).toHaveCount(5);
    await expect(log.nth(1)).toContainText('よろしくお願いします');
    await expect(log.nth(2)).toContainText(ASK_BY_EXAMPLE);
    await expect(log.nth(2).locator('.via')).toHaveText('お試しの AI');
    await expect(log.nth(4)).toContainText(AFTER_JOB);
    // 直す前と後の返事は、試し直すと帯の中で開く。開発者向けの詳細には出さない
    await expect(comparison).toHaveCount(2);
    await expect(comparison.nth(0)).toContainText('あなた: よろしくお願いします');
    await expect(comparison.nth(0)).toContainText(`前: ${NOT_UNDERSTOOD}`);
    await expect(comparison.nth(0)).toContainText(`後: ${ASK_BY_EXAMPLE}`);
    await expect(comparison.nth(0)).toContainText('変わりました');
    await expect(comparison.nth(1)).toContainText('同じ返事です');
    await expect(bar).toContainText('前の会話(発言 2 件)を、新しい設定で送り直しました。');
    await expect(page.locator('#ai-status')).not.toContainText('あなた: よろしくお願いします');
    await expectNoDevWords(bar);
    // 閉じても、次の描画で開き直さない
    await bar.getByText('直す前と後の返事', { exact: true }).click();
    await expect(comparison.first()).toBeHidden();
    await page.waitForTimeout(3500);
    await expect(comparison.first()).toBeHidden();
    await expect(page.locator('#events')).toContainText('前の会話の発言 2 件を、今の設定で送り直しました。');

    // 作る AI とプロダクト内 AI を混同しない。試し直しで作る AI は動かず、作る会話に試作品の会話は入らない
    await expect(makeRuns(page)).toHaveCount(1);
    await expect(page.getByRole('list', { name: '作る会話' })).not.toContainText('よろしくお願いします');
    await expect(page.locator('#agent-status')).toContainText('接続: 偽接続');
    await expect(page.locator('#ai-badge')).toHaveText('AI: お試し');
    expect(studio.output().match(/作る AI に依頼しました/g)).toHaveLength(1);

    // 5. もう一度変える。前の設定(1 回目の変更の後)の応答と比べる。引き出しは直す欄に重なるので閉じる
    await closeMore(page);
    await sendRequest(page, '案内役が「時給の下限」を先に聞くようにして');
    run = makeRuns(page).last();
    await expect(run.locator('.run-status')).toContainText('終わりました');
    settings = run.locator('[data-kind="ai-settings"]');
    await expect(settings).toContainText('聞く順と項目の並び: 職種、雇用区分、勤務地、時給の下限 → 時給の下限、職種、雇用区分、勤務地');
    await expect(log).toHaveCount(1);
    await expect(app.getByRole('region', { name: '希望条件' }).locator('dt')).toHaveText(['時給の下限', '職種', '雇用区分', '勤務地']);
    await bar.getByRole('button', { name: '同じ発言で試し直す' }).click();
    await expect(log).toHaveCount(5);
    await expect(log.nth(4)).toContainText(AFTER_JOB_WAGE_FIRST);
    await expect(comparison.nth(1)).toContainText(`前: ${AFTER_JOB}`);
    await expect(comparison.nth(1)).toContainText(`後: ${AFTER_JOB_WAGE_FIRST}`);

    // 生成された設定は、試作品の成果物(app/ai.json)に残る
    const aiFile = JSON.parse(await fs.readFile(path.join(home, 'projects', 'sample-job-consult', 'app', 'ai.json'), 'utf8'));
    expect(aiFile.fields.map((field) => field.key)).toEqual(['wage', 'jobType', 'employmentType', 'area']);
    expect(aiFile.mock.notUnderstood).toBe(ASK_BY_EXAMPLE);
    expect(aiFile.instructions).toContain('足りない項目は、「時給の下限」から先に聞いてください。');

    // リセットしても、試し直しはできる(前の会話は残る)
    await page.getByRole('button', { name: '会話を最初から' }).click();
    await expect(log).toHaveCount(1);
    await expect(comparison).toHaveCount(0);
    await expect(bar.getByRole('button', { name: '同じ発言で試し直す' })).toBeEnabled();
    await expect(page.locator('#events')).not.toContainText('実行時エラー');
  } finally {
    await studio.stop();
  }
});

test('AI を使わない試作品では、振る舞いの依頼は作る会話で断られ、試し直しは出ない', async ({ page, home }) => {
  const studio = await launchStudio(home);
  try {
    await page.goto(studio.url);
    await chooseSample(page, SAMPLES.library);
    await expect(page.frameLocator('iframe[title="試作品"]').getByRole('heading', { name: 'こもれび図書室' })).toBeVisible();
    await sendRequest(page, '案内役が「時給の下限」を先に聞くようにして');
    const run = makeRuns(page).last();
    await expect(run.locator('.run-status')).toContainText('終わりました');
    await expect(run.locator('.bubble.agent')).toContainText('この試作品には AI の設定がないので、試作品の中の AI の振る舞いは変えられません');
    await expect(run).toContainText('試作品のファイルは変わっていません。');
    await expect(run.locator('[data-kind="ai-settings"]')).toHaveCount(0);
    await expect(page.getByRole('region', { name: '試し直す' })).toBeHidden();
  } finally {
    await studio.stop();
  }
});
