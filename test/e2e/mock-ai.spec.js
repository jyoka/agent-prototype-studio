import { SAMPLES, chooseProject, chooseSample, expect, launchStudio, test, writeProject } from './studio.js';

const GREETING =
  'こんにちは。しおかぜ求人相談の案内役です(架空のサービスです)。どんなお仕事を探していますか? 職種、雇用区分、勤務地、時給の希望を、話しやすいところから教えてください。';
const AFTER_JOB = '職種「カフェのホール」と理解しました。働き方の希望はありますか? アルバイト・パート、契約社員、正社員から選べます。';

test('モックの AI と話し、理解された希望条件を直すと、次の応答に入り、リセットで最初に戻る', async ({ page, home }) => {
  const studio = await launchStudio(home);
  try {
    await page.goto(studio.url);
    await chooseSample(page, SAMPLES.jobConsult);
    const app = page.frameLocator('iframe[title="試作品"]');
    const details = page.locator('#ai-status');
    const studioState = page.getByRole('definition');

    // 架空のデータとモックであることを、Studio と試作品の両方で示す
    await expect(page.locator('#ai-badge')).toHaveText('AI: モック');
    await expect(details).toContainText('接続: モック');
    await expect(details).toContainText('実際の AI モデルは呼びません');
    await expect(details).toContainText('架空のデータで試してください');
    await expect(app.getByRole('heading', { name: 'しおかぜ求人相談' })).toBeVisible();
    await expect(app.locator('.note')).toContainText('架空のサービスと架空の求人です');
    await expect(app.locator('.note')).toContainText('いまの案内役はお試しの AI です。決まった言葉だけ分かります');

    const log = app.getByRole('region', { name: '会話' }).getByRole('listitem');
    const conditions = app.getByRole('region', { name: '希望条件' }).locator('.value');
    const jobs = app.getByRole('region', { name: '条件に合う求人' });
    const message = app.getByLabel('メッセージ');
    const sendButton = app.getByRole('button', { name: '送る' });
    const say = async (text) => {
      await message.fill(text);
      await sendButton.click();
      await expect(message).toHaveValue('');
    };

    // 初期状態
    await expect(log).toHaveCount(1);
    await expect(log.first()).toContainText(GREETING);
    await expect(conditions).toHaveText(['未定', '未定', '未定', '未定']);
    await expect(jobs.locator('.count')).toHaveText('9 件');
    await expect(studioState).toHaveText(['未定', '未定', '未定', '未定']);

    // 話す、理解された条件が出る
    await say('カフェで働きたいです');
    await expect(log.last()).toContainText(AFTER_JOB);
    await say('アルバイトで、しおかぜ町がいいです');
    await expect(log.last()).toContainText('雇用区分「アルバイト・パート」、勤務地「しおかぜ町」と理解しました。時給はいくら以上を希望しますか?');
    await expect(conditions).toHaveText(['カフェのホール', 'アルバイト・パート', 'しおかぜ町', '未定']);
    await expect(studioState).toHaveText(['カフェのホール', 'アルバイト・パート', 'しおかぜ町', '未定']);
    await expect(jobs.getByRole('listitem')).toHaveText([/喫茶こもれび/]);

    // 本人が直す
    await app.getByLabel('勤務地を直す').selectOption('もみじ台');
    await expect(log.last()).toHaveText('あなたの修正: 勤務地を「もみじ台」に直しました。');
    await expect(conditions).toHaveText(['カフェのホール', 'アルバイト・パート', 'もみじ台', '未定']);
    await expect(studioState).toHaveText(['カフェのホール', 'アルバイト・パート', 'もみじ台', '未定']);
    await expect(jobs.getByRole('listitem')).toHaveText([/カフェ海猫/]);

    // 次の応答に、直した条件が入る
    await say('時給は1100円以上がいいです');
    await expect(log.last()).toContainText(
      '直していただいた勤務地「もみじ台」で進めます。時給の下限「1,100円」と理解しました。今の希望条件は職種「カフェのホール」、雇用区分「アルバイト・パート」、勤務地「もみじ台」、時給の下限「1,100円」です。',
    );
    await expect(conditions).toHaveText(['カフェのホール', 'アルバイト・パート', 'もみじ台', '1,100円以上']);
    await expect(jobs.locator('.count')).toHaveText('1 件');
    await expect(details).toContainText('利用者の発言: 3 件');

    // 数の条件も直せる。合う求人がなくなる
    await app.getByLabel('時給の下限を直す').fill('1200');
    await app.getByRole('button', { name: '直す' }).click();
    await expect(log.last()).toHaveText('あなたの修正: 時給の下限を「1,200円」に直しました。');
    await expect(jobs).toContainText('合う求人がありません');

    // 開き直しても、会話と条件はサーバーに残る
    await expect(log).toHaveCount(9);
    await page.getByRole('button', { name: '開き直す' }).click();
    await expect(log).toHaveCount(9);
    await expect(conditions).toHaveText(['カフェのホール', 'アルバイト・パート', 'もみじ台', '1,200円以上']);

    // リセットで初期状態に戻る
    await page.getByRole('button', { name: '会話を最初から' }).click();
    await expect(log).toHaveCount(1);
    await expect(log.first()).toContainText(GREETING);
    await expect(conditions).toHaveText(['未定', '未定', '未定', '未定']);
    await expect(jobs.locator('.count')).toHaveText('9 件');
    await expect(studioState).toHaveText(['未定', '未定', '未定', '未定']);
    await expect(details).toContainText('利用者の発言: 0 件');

    // 同じ入力には、同じ応答を返す(再現できるモック)。返事の印は「お試しの AI」
    await say('カフェで働きたいです');
    await expect(log.last()).toContainText(AFTER_JOB);
    await expect(log.last().locator('.via')).toHaveText('お試しの AI');

    // 決まった言葉で読み取れないときは、本物の AI で試せることを伝える
    await say('なんとなく楽しい仕事');
    await expect(log.last()).toContainText('すみません、希望の条件として読み取れませんでした。自由な言葉は、上の『AI: 本物』で試せます。');

    // サンプルの画面(iframe の中)に、開発の言葉「モック」が出ない
    await expect(app.locator('body')).not.toContainText('モック');

    await expect(page.locator('#events-empty')).toBeVisible();
  } finally {
    await studio.stop();
  }
});

test('学習相談のサンプルも、返事の印と注意書きが「お試しの AI」で、画面に「モック」の言葉がない', async ({ page, home }) => {
  const studio = await launchStudio(home);
  try {
    await page.goto(studio.url);
    await chooseSample(page, SAMPLES.studyConsult);
    const app = page.frameLocator('iframe[title="試作品"]');
    const log = app.getByRole('region', { name: '会話' }).getByRole('listitem');
    await expect(app.locator('.note')).toContainText('いまの相談役はお試しの AI です。決まった言葉だけ分かります');

    await app.getByLabel('メッセージ').fill('なんとなく何か学びたい');
    await app.getByRole('button', { name: '送る' }).click();
    await expect(log.last()).toContainText('すみません、学びたいことや進め方として読み取れませんでした。自由な言葉は、上の『AI: 本物』で試せます。');
    await expect(log.last().locator('.via')).toHaveText('お試しの AI');
    await expect(app.locator('body')).not.toContainText('モック');
  } finally {
    await studio.stop();
  }
});

// 求人ではない題材。Studio の runtime と AI の設定の形だけで動き、求人の前提を持たない
const TRAVEL_AI = {
  name: '旅の相談(架空)',
  fields: [
    { key: 'place', label: '行き先', options: [{ value: '湖の町', keywords: ['湖'] }, { value: '山の村', keywords: ['山'] }] },
    { key: 'nights', label: '泊数', type: 'number', unit: '泊', min: 1, max: 14, question: '何泊しますか?' },
  ],
  mock: { greeting: '旅の相談です。', complete: '{summary}で探します。' },
};

const TRAVEL_MAIN = `
const root = document.getElementById('root');
const out = document.createElement('output');
const state = document.createElement('pre');
const input = document.createElement('input');
input.setAttribute('aria-label', '発言');
const send = document.createElement('button');
send.textContent = '送る';
const fix = document.createElement('button');
fix.textContent = '山に直す';
root.append(input, send, fix, out, state);
function show(session) {
  out.textContent = session.messages.at(-1).text;
  state.textContent = JSON.stringify(session.state);
}
const fail = (error) => (out.textContent = 'エラー: ' + error.code);
window.studio.ai.session().then(show, fail);
send.addEventListener('click', () => window.studio.ai.send(input.value).then(show, fail));
fix.addEventListener('click', () => window.studio.ai.correct({ place: '山の村' }).then(show, fail));
`;

const NO_AI_MAIN = `
window.studio.ai.session().then(
  () => (document.getElementById('root').textContent = 'つながった'),
  (error) => (document.getElementById('root').textContent = 'エラー: ' + error.code + ' ' + error.message),
);
`;

const FLOOD_MAIN = `
Promise.allSettled(Array.from({ length: 15 }, () => window.studio.ai.session())).then((results) => {
  const refused = results.filter((r) => r.status === 'rejected' && r.reason.code === 'rate').length;
  document.getElementById('root').textContent = '断られた数: ' + refused;
});
`;

test('別の題材でも同じ仕組みで動き、AI のない試作品と連打には理由を返す', async ({ page, home }) => {
  await writeProject(home, 'travel-mock', { 'main.js': TRAVEL_MAIN, 'ai.json': JSON.stringify(TRAVEL_AI) }, '架空の旅の相談');
  await writeProject(home, 'no-ai', { 'main.js': NO_AI_MAIN }, 'AI のない試作品');
  await writeProject(home, 'flood', { 'main.js': FLOOD_MAIN, 'ai.json': JSON.stringify(TRAVEL_AI) }, '連打する試作品');
  const studio = await launchStudio(home);
  try {
    await page.goto(studio.url);
    const app = page.frameLocator('iframe[title="試作品"]');

    await chooseProject(page, /架空の旅の相談/);
    await expect(page.locator('#ai-badge')).toHaveText('AI: モック');
    await expect(app.locator('output')).toHaveText('旅の相談です。');
    await app.getByLabel('発言').fill('湖に行きたい');
    await app.getByRole('button', { name: '送る' }).click();
    await expect(app.locator('output')).toHaveText('行き先「湖の町」と理解しました。何泊しますか?');
    await app.getByRole('button', { name: '山に直す' }).click();
    await expect(app.locator('output')).toHaveText('行き先を「山の村」に直しました。');
    await app.getByLabel('発言').fill('3泊で');
    await app.getByRole('button', { name: '送る' }).click();
    await expect(app.locator('output')).toHaveText('直していただいた行き先「山の村」で進めます。泊数「3泊」と理解しました。行き先「山の村」、泊数「3泊」で探します。');
    await expect(page.getByRole('definition')).toHaveText(['山の村', '3泊']);

    // リセットの返事を待つ間に別の試作品を選んだら、選んだ方を開いたままにする
    await page.route('**/api/projects/travel-mock/ai/reset', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 800));
      await route.continue();
    });
    await page.getByRole('button', { name: '会話を最初から' }).click();
    await chooseProject(page, /AI のない試作品/);
    await page.waitForTimeout(1200);
    await expect(page.locator('iframe[title="試作品"]')).toHaveAttribute('src', /\/p\/no-ai\//);

    await expect(app.locator('#root')).toContainText('エラー: no-ai この試作品はプロダクト内 AI を使っていません');
    await expect(page.locator('#ai-badge')).toBeHidden();
    await expect(page.locator('#ai-status')).toHaveText('この試作品はプロダクト内 AI を使っていません。');
    await expect(page.locator('#events')).toContainText('AI への要求に失敗しました');

    await chooseProject(page, /連打する試作品/);
    await expect(app.locator('#root')).toHaveText(/断られた数: [1-9]\d*/);
    await expect(page.locator('#events')).toContainText('試作品から AI への要求が多すぎる');
  } finally {
    await studio.stop();
  }
});
