import fs from 'node:fs/promises';
import path from 'node:path';
import { chooseSample, expect, expectNoDevWords, expectReadableText, launchStudio, ROOT, SAMPLES, test } from './studio.js';

// はじめの画面、目的の聞き出し、目的の文書(docs/design/user-journey.md の段 1、段 2、J1)。
// 実モデルは呼ばない。偽接続(STUDIO_AGENT=fake)か、偽の claude(test/fixtures/fake-claude.js)で動かす。
// launchStudio の既定は、はじめの画面を出さない。ここだけ STUDIO_START_SCREEN を消して出す

const SENTENCE = '商店街のお店への問い合わせに、AI が答えられるようにしたい';
const START = { STUDIO_START_SCREEN: undefined };
const FAKE_CLAUDE = path.join(ROOT, 'test', 'fixtures', 'fake-claude.js');
// 「分かるか」の確かめのスクリーンショットの置き場。test-results/ は git が無視する
const UX_SHOTS = path.join(ROOT, 'test-results', 'ux');

const ui = (page) => ({
  section: page.locator('#intent'),
  heading: page.getByRole('heading', { level: 2, name: 'どんなものを作りたいですか' }),
  sentence: page.getByLabel('作りたいもの'),
  question: page.locator('#intent-question'),
  answer: page.getByLabel('答え', { exact: true }),
  reply: page.getByRole('button', { name: '答える' }),
  unknown: page.getByRole('button', { name: '分からない' }),
  mark: page.locator('#intent-mark'),
  decide: page.getByRole('button', { name: 'これで決める' }),
  undecided: page.getByLabel('決めていないこと(1 行に 1 つ)'),
  state: page.locator('#intent-doc-state'),
});

// .studio/intent.json を読む。.studio/ は Studio だけが書く場所
async function record(home, id) {
  return JSON.parse(await fs.readFile(path.join(home, 'projects', id, '.studio', 'intent.json'), 'utf8'));
}

async function projectIdOf(studio) {
  const { projects } = await studio.api('/api/projects');
  return projects.find((project) => project.id.startsWith('idea-'))?.id;
}

test('あいまいな 1 文で問いが返り、「分からない」が決めていないことに入り、押すまで「決めた」の印が付かない', async ({ page, home }) => {
  test.setTimeout(60_000);
  const studio = await launchStudio(home, { env: START });
  try {
    await page.goto(studio.url);
    const s = ui(page);
    // はじめの画面: 例の 1 文、案内の深さ(既定は「ふつう」)。試作品の画面は隠れている
    await expect(s.heading).toBeVisible();
    await expect(page.getByRole('list', { name: '例の 1 文' }).getByRole('button')).toHaveCount(3);
    await expect(page.getByRole('group', { name: '案内の深さ' }).getByRole('radio', { checked: true })).toHaveAccessibleName(/ふつう/);
    await expect(page.getByRole('region', { name: '言葉で直す' })).toBeHidden();
    await expect(page.getByRole('region', { name: 'はじめの手順' })).toBeHidden();
    await expectNoDevWords(s.section);
    await expectReadableText(page, 'はじめの画面');
    await page.screenshot({ path: path.join(UX_SHOTS, 'J1-start.png') });

    // 例を押すと欄に入る。送ると、作り始める前に問いが 1 つ返る
    await page.getByRole('button', { name: SENTENCE }).click();
    await expect(s.sentence).toHaveValue(SENTENCE);
    await page.getByRole('button', { name: '送る' }).click();
    await expect(s.question).toContainText(SENTENCE);
    await expect(s.question).toContainText('誰');
    await expect(page.locator('#intent-progress')).toContainText('問い 1 / 多くて 4');
    await expect(s.mark).toHaveText('目的: 下書き');
    await expectNoDevWords(s.section);
    await page.screenshot({ path: path.join(UX_SHOTS, 'J1-talk.png') });

    // 答える。次の問いへ進み、前の問いと答えが残る
    await s.answer.fill('お店の人');
    await s.reply.click();
    await expect(page.locator('#intent-progress')).toContainText('問い 2 / 多くて 4');
    await expect(page.getByRole('list', { name: '問いと答え', exact: true })).toContainText('お店の人');

    // 「分からない」は答えにでき、問いが決めていないことに入る
    const unknownQuestion = await s.question.textContent();
    await s.unknown.click();
    await expect(page.locator('#intent-progress')).toContainText('問い 3 / 多くて 4');
    await s.answer.fill('閉店後の問い合わせ');
    await s.reply.click();
    await expect(page.locator('#intent-progress')).toContainText('問い 4 / 多くて 4');
    await s.answer.fill('わからない');
    await s.reply.click();

    // 上限で文書になる。AI の返事だけでは「決めた」の印は付かない
    await expect(page.getByRole('heading', { level: 2, name: '目的の文書' })).toBeVisible();
    await expect(page.getByLabel('誰', { exact: true })).toHaveValue('お店の人');
    await expect(page.getByLabel('場面', { exact: true })).toHaveValue('閉店後の問い合わせ');
    await expect(s.undecided).toHaveValue(new RegExp(unknownQuestion.replace(/[?()]/g, '.')));
    await expect(s.state).toContainText('まだ決めていません');
    await expect(s.mark).toHaveText('目的: 下書き');
    const id = await projectIdOf(studio);
    expect((await record(home, id)).status).toBe('draft');
    expect((await record(home, id)).decidedAt).toBeNull();
    await expectNoDevWords(s.section);
    await expectReadableText(page, '目的の文書の下書き');
    await page.screenshot({ path: path.join(UX_SHOTS, 'J1-draft.png'), fullPage: true });

    // 人が直して「これで決める」を押すと、印が付く。書いていない項目は、決めていないことに足す
    await page.getByLabel('成功の印', { exact: true }).fill('');
    await page.getByLabel('何の問題', { exact: true }).fill('同じ問い合わせに何度も答えている');
    await s.decide.click();
    await expect(s.mark).toHaveText('目的: 決めた');
    await expect(s.state).toContainText('決めました');
    await expect(s.undecided).toHaveValue(/「成功の印」を書いていません/);
    const decided = await record(home, id);
    expect(decided.status).toBe('decided');
    expect(decided.doc.problem).toBe('同じ問い合わせに何度も答えている');
    expect(decided.turns).toHaveLength(4);
    await page.screenshot({ path: path.join(UX_SHOTS, 'J1-decided.png'), fullPage: true });

    // 次にすること: 決めた目的を、言葉で直す欄の依頼に入れる。送るのは人
    await page.getByRole('button', { name: 'この目的で試作品を作り始める' }).click();
    await expect(page.getByRole('region', { name: '言葉で直す' })).toBeVisible();
    await expect(page.getByLabel('依頼')).toHaveValue(/誰: お店の人/);
    await expect(page.locator('iframe[title="試作品"]')).toHaveAttribute('src', new RegExp(`/p/${id}/`));
    await expect(page.frameLocator('iframe[title="試作品"]').getByRole('heading', { name: '新しい試作品' })).toBeVisible();

    // 読み込み直しても、決めた印と文書が残る
    await page.reload();
    await expect(s.mark).toHaveText('目的: 決めた');
    await s.mark.click();
    await expect(s.state).toContainText('決めました');

    // 決めた後に直すと、印が外れる。もう一度押すまで付かない
    await page.getByRole('button', { name: '直す', exact: true }).click();
    await expect(s.mark).toHaveText('目的: 下書き');
    await expect(s.state).toContainText('まだ決めていません');
    expect((await record(home, id)).decidedAt).toBeNull();
  } finally {
    await studio.stop();
  }
  // 起動し直しても残り、はじめの画面は出ない
  const again = await launchStudio(home, { env: START });
  try {
    await page.goto(again.url);
    const s = ui(page);
    await expect(s.mark).toHaveText('目的: 下書き');
    await expect(s.heading).toBeHidden();
  } finally {
    await again.stop();
  }
});

test('飛ばすと「目的なし」の印が付き、飛ばしたことが残る。印を押すと、あとから聞き出せる', async ({ page, home }) => {
  test.setTimeout(60_000);
  const studio = await launchStudio(home, { env: START });
  try {
    await page.goto(studio.url);
    const s = ui(page);

    // 文を書いて飛ばす: 新しい試作品ができ、「目的なし」の印。問いは返らない
    await s.sentence.fill(SENTENCE);
    await page.getByRole('button', { name: '飛ばす' }).click();
    await expect(page.getByRole('region', { name: '言葉で直す' })).toBeVisible();
    await expect(s.mark).toHaveText('目的なし');
    const id = await projectIdOf(studio);
    await expect(page.locator('iframe[title="試作品"]')).toHaveAttribute('src', new RegExp(`/p/${id}/`));
    const skipped = await record(home, id);
    expect(skipped.status).toBe('skipped');
    expect(skipped.skippedAt).toBeTruthy();
    expect(skipped.sentence).toBe(SENTENCE);

    // 印を押すと、あとから聞き出せる
    await s.mark.click();
    await expect(s.heading).toBeVisible();
    await expect(s.sentence).toHaveValue(SENTENCE);
    await page.getByRole('button', { name: '送る' }).click();
    await expect(s.question).toContainText('誰');
    await expect(s.mark).toHaveText('目的: 下書き');

    // 聞いている途中でも飛ばせる
    await page.getByRole('button', { name: '飛ばす' }).click();
    await expect(s.mark).toHaveText('目的なし');
    expect((await record(home, id)).status).toBe('skipped');
  } finally {
    await studio.stop();
  }
});

// 狭い窓では体がページごとスクロールする。欄の中だけが隠れて動くと、人には続きが見えない。
// toBeVisible は欄の中で隠れていても通るので、ボタンが欄の枠の中に収まることまで見る
async function expectWhole(section, button) {
  await expect(button).toBeVisible();
  const { clientHeight, scrollHeight } = await section.evaluate((el) => ({ clientHeight: el.clientHeight, scrollHeight: el.scrollHeight }));
  expect(scrollHeight).toBeLessThanOrEqual(clientHeight + 1);
  await button.scrollIntoViewIfNeeded();
  const box = await section.boundingBox();
  const target = await button.boundingBox();
  expect(target.y).toBeGreaterThanOrEqual(box.y);
  expect(target.y + target.height).toBeLessThanOrEqual(box.y + box.height + 1);
}

for (const [width, height] of [[900, 900], [390, 700]]) {
  test(`幅 ${width} の窓でも、はじめの画面、問い、目的の文書の全部が見え、「これで決める」まで進める`, async ({ page, home }) => {
    test.setTimeout(60_000);
    const studio = await launchStudio(home, { env: START });
    try {
      await page.setViewportSize({ width, height });
      await page.goto(studio.url);
      const s = ui(page);
      await expect(s.heading).toBeVisible();
      await expectWhole(s.section, page.getByRole('button', { name: '送る' }));
      await expectWhole(s.section, page.getByRole('button', { name: '飛ばす' }));

      await s.sentence.fill(SENTENCE);
      await page.getByRole('group', { name: '案内の深さ' }).getByRole('radio', { name: /速く/ }).click();
      await page.getByRole('button', { name: '送る' }).click();
      await expect(s.question).toContainText('誰');
      await expectWhole(s.section, s.reply);

      await s.answer.fill('お店の人');
      await s.reply.click();
      await expect(page.locator('#intent-progress')).toContainText('問い 2 / 多くて 2');
      await s.unknown.click();

      await expect(page.getByRole('heading', { level: 2, name: '目的の文書' })).toBeVisible();
      await expectWhole(s.section, s.decide);
      await s.decide.click();
      await expect(s.mark).toHaveText('目的: 決めた');
    } finally {
      await studio.stop();
    }
  });
}

test('文を書かずに飛ばすと、今までの最初の画面(サンプルと案内)になる。上の帯の「新しく作る」から、はじめの画面を開ける', async ({ page, home }) => {
  test.setTimeout(60_000);
  const studio = await launchStudio(home, { env: START });
  try {
    await page.goto(studio.url);
    const s = ui(page);
    await page.getByRole('button', { name: '飛ばす' }).click();
    await expect(page.getByRole('region', { name: 'はじめの手順' })).toBeVisible();
    await expect(page.frameLocator('iframe[title="試作品"]').getByRole('heading', { name: 'しおかぜ求人相談' })).toBeVisible();
    await expect(s.mark).toHaveText('目的なし');
    expect(await projectIdOf(studio)).toBeUndefined();

    // 読み込み直しても、はじめの画面はまた出ない
    await page.reload();
    await expect(page.getByRole('region', { name: 'はじめの手順' })).toBeVisible();
    await expect(s.heading).toBeHidden();

    await page.locator('#project-menu-button').click();
    await page.getByRole('button', { name: '新しく作る' }).click();
    await expect(s.heading).toBeVisible();

    // 試作品を選ぶと、はじめの画面を閉じる
    await page.locator('#project-menu-button').click();
    await chooseSample(page, SAMPLES.library);
    await expect(s.heading).toBeHidden();
  } finally {
    await studio.stop();
  }
});

test('深さごとの上限を超えて問いを出さない(偽の claude はいつも次の問いを返す)。同意の前は起動せず、やめると決まった問いで進む', async ({ page, home }) => {
  test.skip(process.platform === 'win32', '偽の claude を直接起動するため');
  test.setTimeout(60_000);
  const log = path.join(home, 'claude.log');
  const studio = await launchStudio(home, { env: { ...START, STUDIO_AGENT: 'claude', STUDIO_CLAUDE_BIN: FAKE_CLAUDE, FAKE_CLAUDE_LOG: log } });
  const launches = async () => (await fs.readFile(log, 'utf8').catch(() => '')).split('\n').filter(Boolean);
  try {
    await page.goto(studio.url);
    const s = ui(page);
    await s.sentence.fill(SENTENCE);
    await page.getByRole('group', { name: '案内の深さ' }).getByRole('radio', { name: /速く/ }).click();
    await page.getByRole('button', { name: '送る' }).click();

    // 同意のカード。カードの前に AI を起動せず、試作品も作らない
    const card = page.getByRole('group', { name: '本物の AI を使う前に' });
    await expect(card).toBeVisible();
    await expect(card.getByRole('list', { name: '送るもの' })).toContainText('書いた 1 文と問いへの答え');
    expect(await launches()).toHaveLength(0);
    expect(await projectIdOf(studio)).toBeUndefined();

    // やめると、AI を使わずに決まった問いで進める
    await card.getByRole('button', { name: 'やめる' }).click();
    await expect(page.getByRole('button', { name: '決まった問いで進める' })).toBeVisible();
    await page.getByRole('button', { name: '決まった問いで進める' }).click();
    await expect(s.question).toHaveText('一番困っているのは誰ですか?');
    expect(await launches()).toHaveLength(0);
    await page.getByRole('button', { name: '飛ばす' }).click();
    await expect(s.mark).toHaveText('目的なし');

    // 同意すると、本物の接続(偽の claude)で聞く。速くの上限は 2 問
    await page.locator('#project-menu-button').click();
    await page.getByRole('button', { name: '新しく作る' }).click();
    await expect(s.heading).toBeVisible();
    await s.sentence.fill(SENTENCE);
    await page.getByRole('group', { name: '案内の深さ' }).getByRole('radio', { name: /速く/ }).click();
    await page.getByRole('button', { name: '送る' }).click();
    await card.getByRole('button', { name: '同意して使う' }).click();
    await expect(s.question).toHaveText('偽の問い 1 は何ですか?');
    await s.answer.fill('答え 1');
    await s.reply.click();
    await expect(s.question).toHaveText('偽の問い 2 は何ですか?');
    await s.answer.fill('答え 2');
    await s.reply.click();
    await expect(page.getByRole('heading', { level: 2, name: '目的の文書' })).toBeVisible();
    await expect(s.mark).toHaveText('目的: 下書き');
    const id = (await studio.api('/api/projects')).projects.findLast((project) => project.intent.status === 'draft').id;
    expect((await record(home, id)).turns).toHaveLength(2);
  } finally {
    await studio.stop();
  }
});

test('本物の接続の応答を止めると、決まった問いに切り替わる', async ({ page, home }) => {
  test.skip(process.platform === 'win32', '偽の claude を直接起動するため');
  test.setTimeout(60_000);
  const studio = await launchStudio(home, { env: { ...START, STUDIO_AGENT: 'claude', STUDIO_CLAUDE_BIN: FAKE_CLAUDE } });
  try {
    await page.goto(studio.url);
    const s = ui(page);
    await s.sentence.fill('[聞き出しが遅い]');
    await page.getByRole('button', { name: '送る' }).click();
    await page.getByRole('group', { name: '本物の AI を使う前に' }).getByRole('button', { name: '同意して使う' }).click();
    await expect(page.getByText('問いを考えています…')).toBeVisible();
    // 画面の文は依頼を送る前に出る。サーバーが考え始めるのを待ってから読み込み直す
    const id = await projectIdOf(studio);
    await expect.poll(async () => (await studio.api(`/api/projects/${id}/intent`)).intent.thinking, { timeout: 15_000 }).toBe(true);
    // 読み込み直しても、考えている最中なら、古い問いに答えられず、止められる
    await page.reload();
    await expect(s.mark).toHaveText('目的: 下書き');
    await s.mark.click();
    await expect(page.getByText('問いを考えています…')).toBeVisible();
    await expect(page.locator('#intent-asking')).toBeHidden();
    await page.getByRole('button', { name: '止める' }).click();
    await expect(s.question).toHaveText('一番困っているのは誰ですか?', { timeout: 15_000 });
    await expect(page.locator('#intent-note')).toContainText('止めました');
  } finally {
    await studio.stop();
  }
});

for (const [name, extra] of [
  ['同意がない', {}],
  ['本物の AI を止めた設定', { STUDIO_ALLOW_CLAUDE_CODE: '0' }],
]) {
  test(`途中の聞き出しを、起動し直して続けても、${name}なら AI を起動せず決まった問いにする`, async ({ page, home }) => {
    test.skip(process.platform === 'win32', '偽の claude を直接起動するため');
    test.setTimeout(60_000);
    const first = await launchStudio(home, { env: START });
    try {
      await page.goto(first.url);
      const s = ui(page);
      await s.sentence.fill(SENTENCE);
      await page.locator('#intent-send').click();
      await expect(s.question).toContainText('誰');
    } finally {
      await first.stop();
    }
    const log = path.join(home, 'claude.log');
    const studio = await launchStudio(home, { env: { ...START, ...extra, STUDIO_AGENT: 'claude', STUDIO_CLAUDE_BIN: FAKE_CLAUDE, FAKE_CLAUDE_LOG: log } });
    try {
      await page.goto(studio.url);
      const s = ui(page);
      await expect(s.mark).toHaveText('目的: 下書き');
      await s.mark.click();
      await expect(s.question).toContainText('誰');
      await s.answer.fill('お店の人');
      await s.reply.click();
      await expect(s.question).toHaveText('その人は、今どんなことに困っていますか?');
      await expect(page.locator('#intent-note')).toContainText('決まった順');
      expect(await fs.readFile(log, 'utf8').catch(() => '')).toBe('');
    } finally {
      await studio.stop();
    }
  });
}
