import { SAMPLES, chooseSample, expect, launchStudio, openDevDetails, test } from './studio.js';

// 構成と前提の選び方(docs/design/agent-simulation.md の sim-10)。その他 → 開発者向けの詳細の「構成と前提」で選ぶ。
// 選ぶと会話を最初からにする。構成のない試作品では出ない(R2)。模擬のエージェントはモック(お試しの AI)で答える
function talkOf(page) {
  const app = page.frameLocator('iframe[title="試作品"]');
  const talk = app.getByRole('region', { name: '会話' });
  const items = talk.getByRole('list', { name: 'やりとり' }).locator(':scope > li');
  const message = app.getByLabel('メッセージ');
  const say = async (text) => {
    await message.fill(text);
    await app.getByRole('button', { name: '送る' }).click();
    await expect(message).toHaveValue('');
  };
  return { app, talk, items, say };
}

test('バイト探しでは、開発者向けの詳細で構成と前提を選べ、選ぶと会話が最初からになる。前提ごとに使える部品が分かる', async ({ page, home }) => {
  const studio = await launchStudio(home);
  try {
    await page.goto(studio.url);
    await chooseSample(page, SAMPLES.partTime);
    const { talk, items, say } = talkOf(page);
    await say('みなと町でバイトを探しています');
    await expect(talk.getByRole('group', { name: 'カードの一覧' }).getByRole('article')).toHaveCount(3);

    // 既定では隠れている(U5)
    const choice = page.getByRole('region', { name: '構成と前提', includeHidden: true });
    await expect(choice).toBeHidden();
    await openDevDetails(page);
    await expect(choice).toBeVisible();

    // 構成は、既定の composition.json と、compositions/ の c.json と c2.json。今は既定
    const compositions = choice.getByRole('group', { name: '構成を選ぶ' });
    await expect(compositions.getByRole('radio')).toHaveCount(3);
    await expect(compositions.getByRole('radio', { name: '相手の会社のエージェントと、こちらのツール(架空)(app/composition.json、既定)' })).toBeChecked();
    await expect(compositions).toContainText('参加者: そよかぜの案内役(模擬)(模擬のエージェント)');
    await expect(compositions).toContainText('参加者: 受付(模擬)(模擬のエージェント)、相談役(harness)、担当者(模擬)(人(模擬))');

    // 前提は 2 つ。前提ごとに、使える部品とモデルが違う
    const assumptions = choice.getByRole('group', { name: '前提を選ぶ' });
    await expect(assumptions.getByRole('radio')).toHaveCount(2);
    const partnerA = assumptions.getByRole('radio', { name: /partner-a、既定/ });
    const partnerB = assumptions.getByRole('radio', { name: /\(partner-b\)/ });
    await expect(partnerA).toBeChecked();
    await expect(assumptions).toContainText('使える部品: 文、ボタン、カード、カルーセル。モデル: claude-sonnet-5-5(代わりのモデル)');
    await expect(assumptions).toContainText('使える部品: 文、ボタン。モデル: claude-haiku-5-5(代わりのモデル)');

    // 前提 B を選ぶと、会話は最初からになり、カードは文に落ちる
    await partnerB.check();
    await expect(partnerB).toBeChecked();
    await expect(items).toHaveCount(0);
    const trace = page.locator('#ai-trace');
    const entries = trace.getByRole('list', { name: 'AI の実行の記録' }).locator(':scope > li');
    await expect(entries.first()).toContainText(
      '構成「相手の会社のエージェントと、こちらのツール(架空)」、前提「相手の仕様の推測 B(架空。文とボタンだけ)」を選び、会話を最初からにしました(Studio の画面から)',
    );
    await say('詳しく見せて');
    await expect(items.last()).toContainText('架空の品出し\nみなと町・時給 1100 円・土日\n1. この求人で希望を保存\n2. 条件を変える');
    await expect(talk.getByRole('article')).toHaveCount(0);
    // 記録に、選んだ前提と、カードを文に落としたことが出る(S23)
    const turn = entries.first();
    await turn.getByText('模擬の会話の中身: 参加者、ツール、守り(開発向け)').click();
    await expect(turn).toContainText('前提: partner-b(app/assumptions/partner-b.json、指紋 sha256:');
    await expect(turn.getByRole('list', { name: '守りの層と判定' }).filter({ hasText: 'surface-downgrade' })).toContainText(
      '会話の枠「surface-downgrade」: カードを文に落とした、持ち主 studio',
    );

    // 構成 C を選ぶと、前提はその構成の既定に戻り、話す参加者が替わる
    await compositions.getByRole('radio', { name: /compositions\/c\.json/ }).check();
    await expect(compositions.getByRole('radio', { name: /compositions\/c\.json/ })).toBeChecked();
    await expect(assumptions.getByRole('radio', { name: /partner-a、既定/ })).toBeChecked();
    await expect(items).toHaveCount(0);
    await say('ありがとう');
    await expect(items.last()).toContainText('受付です。');
    await expect(items.last().locator('.studio-talk__who')).toContainText('受付(模擬)');

    // 呼び手を替える構成(C2)の前提は、その構成の置き場(callers/)のもの
    await compositions.getByRole('radio', { name: /compositions\/c2\.json/ }).check();
    await expect(assumptions.getByRole('radio')).toHaveCount(3);
    await expect(assumptions.getByRole('radio', { name: /caller-sonnet、既定/ })).toBeChecked();

    // 試す欄の上のボタンは、AI の切り替えを除くと「会話を最初から」だけのまま(U9)
    await expect(page.locator('#try-toolbar').getByRole('button').and(page.locator(':not(#ai-switch)'))).toHaveText(['会話を最初から']);
  } finally {
    await studio.stop();
  }
});

test('構成のない試作品では、構成と前提の選び方が出ない。選ぶ口も断る(R2)', async ({ page, home }) => {
  const studio = await launchStudio(home);
  try {
    await page.goto(studio.url);
    await chooseSample(page, SAMPLES.jobConsult);
    await openDevDetails(page);
    await expect(page.locator('#ai-status')).toContainText('接続: モック');
    await expect(page.getByRole('region', { name: '構成と前提' })).toHaveCount(0);
    await expect(page.locator('#sim-choice')).toBeHidden();

    const refused = await studio.post(`/api/projects/${SAMPLES.jobConsult.id}/ai/simulation`, { composition: 'composition.json' });
    expect(refused.status).toBe(409);
    expect(JSON.parse(refused.text).error.code).toBe('not-supported');
    // 構成のある試作品でも、ない構成と、その構成にない前提は断る
    const unknown = await studio.post(`/api/projects/${SAMPLES.partTime.id}/ai/simulation`, { composition: 'compositions/none.json' });
    expect(unknown.status).toBe(400);
    const wrong = await studio.post(`/api/projects/${SAMPLES.partTime.id}/ai/simulation`, { composition: 'composition.json', assumptions: 'caller-sonnet' });
    expect(wrong.status).toBe(400);
  } finally {
    await studio.stop();
  }
});
