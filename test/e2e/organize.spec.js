import fs from 'node:fs/promises';
import path from 'node:path';
import { chooseSample, expect, expectNoDevWords, expectReadableText, launchStudio, ROOT, SAMPLES, test } from './studio.js';

// ヒアリングの整理(docs/design/user-journey.md の K1、docs/design/field-session.md の段 1、段 2)。
// 実モデルは呼ばない。偽の claude(test/fixtures/fake-claude.js)か、偽接続(STUDIO_AGENT=fake)で動かす。

const FAKE_CLAUDE = path.join(ROOT, 'test', 'fixtures', 'fake-claude.js');
const UX_SHOTS = path.join(ROOT, 'test-results', 'ux');
const COLUMNS = ['要求', '使う人', '場面', '決まりごと', 'データ'];
// 架空の「しおかぜ便」の会の要点 10 個(field-session.md の 1 節と 2 節)
const POINTS = [
  '再配達の受付を、電話なしで済ませたい',
  'お年寄りのお客さんも多い',
  '夕方に電話が集中する',
  '再配達の受付は、その日の 17 時まで',
  '不在票に荷物の番号がある',
  '「荷物はいつ届くか」の電話も多い',
  '受付の担当は 2 人で回している',
  '不在票を見て、今日の夜に届けてほしい人がいる',
  '17 時を過ぎたら翌日の受付にする',
  'お届け先と希望の日時を聞いている',
];

const ui = (page) => ({
  section: page.locator('#organize'),
  mark: page.locator('#organize-mark'),
  state: page.locator('#organize-state'),
  point: page.getByLabel('聞いた要点'),
  points: page.getByRole('list', { name: '打った要点' }),
  run: page.getByRole('button', { name: '整理する', exact: true }),
  confirm: page.getByRole('button', { name: 'この理解で合っている' }),
  column: (name) => page.getByRole('region', { name, exact: true }),
  items: page.locator('#organize-columns .organize-item'),
  asks: page.getByRole('list', { name: '聞くことの一覧' }),
  note: page.locator('#organize-note'),
});

const claudeEnv = (log) => ({ STUDIO_AGENT: 'claude', STUDIO_CLAUDE_BIN: FAKE_CLAUDE, ...(log ? { FAKE_CLAUDE_LOG: log } : {}) });

async function board(home, id) {
  return JSON.parse(await fs.readFile(path.join(home, 'projects', id, '.studio', 'organize.json'), 'utf8'));
}

// 図書室を選び、整理の板を開く
async function openBoard(page, studio) {
  await page.goto(studio.url);
  await page.locator('#project-menu-button').click();
  await chooseSample(page, SAMPLES.library);
  const s = ui(page);
  await expect(s.mark).toHaveText('ヒアリングの整理');
  await s.mark.click();
  await expect(page.getByRole('heading', { level: 2, name: 'ヒアリングの整理' })).toBeVisible();
  await expect(page.getByRole('region', { name: '作る AI', exact: true })).toBeHidden();
  return s;
}

async function typePoints(s, points) {
  for (const [index, text] of points.entries()) {
    await s.point.fill(text);
    await s.point.press('Enter');
    await expect(s.points.getByRole('listitem')).toHaveCount(index + 1);
    await expect(s.point).toHaveValue('');
  }
}

test('要点 10 個が 5 つの欄に振り分けられ、全項目に元の要点か「推測」の印があり、押すまで「確かめた」の印が付かない', async ({ page, home }) => {
  test.skip(process.platform === 'win32', '偽の claude を直接起動するため');
  test.setTimeout(90_000);
  const log = path.join(home, 'claude.log');
  const studio = await launchStudio(home, { env: claudeEnv(log) });
  const id = SAMPLES.library.id;
  const launches = async () => (await fs.readFile(log, 'utf8').catch(() => '')).split('\n').filter(Boolean).filter((line) => line.includes('toAsk'));
  try {
    const s = await openBoard(page, studio);
    await expect(s.state).toContainText('まだ整理していません');
    await expect(s.confirm).toBeDisabled();
    await expect(s.run).toBeDisabled();
    await typePoints(s, POINTS);
    await expect(s.mark).toHaveText('整理: 下書き');
    // 打っただけでは呼ばない。整理していない要点は、そう分かる
    expect(await launches()).toHaveLength(0);
    await expect(s.points.getByText('まだどの欄にもありません')).toHaveCount(10);

    // 初めては同意のカード。カードの前に AI を起動しない
    await s.run.click();
    const card = page.getByRole('group', { name: '本物の AI を使う前に' });
    await expect(card).toBeVisible();
    await expect(card.getByRole('list', { name: '送るもの' })).toContainText('打った要点と整理の板の項目');
    expect(await launches()).toHaveLength(0);
    await card.getByRole('button', { name: '同意して使う' }).click();

    // 5 つの欄に振り分けられる
    await expect(s.items).toHaveCount(12);
    for (const name of COLUMNS) await expect(s.column(name).locator('.organize-item').first()).toBeVisible();
    expect(await launches()).toHaveLength(1);
    await expect(s.points.getByText('まだどの欄にもありません')).toHaveCount(0);

    // 全項目に、元の要点か「推測」の印がある。どちらもない項目はない
    const items = await s.items.all();
    let guesses = 0;
    for (const item of items) {
      const sources = await item.locator('.organize-source', { hasText: '元の要点' }).count();
      const guess = await item.getByText('推測', { exact: true }).count();
      expect(sources + guess, await item.innerText()).toBeGreaterThan(0);
      expect(sources > 0 && guess > 0, await item.innerText()).toBe(false);
      guesses += guess;
    }
    expect(guesses).toBe(2);
    // 元の要点には、打った文がそのまま出る
    await expect(s.column('要求').locator('.organize-item').first()).toContainText(`元の要点 1: ${POINTS[0]}`);
    // 偽の claude が「ない要点」を指した項目も「推測」になる
    await expect(s.column('決まりごと').locator('.organize-item', { hasText: '偽のない要点を指す項目' }).getByText('推測', { exact: true })).toBeVisible();

    // 矛盾と聞いていないことと推測が、聞くことに出る
    await expect(s.asks.getByRole('listitem').filter({ hasText: '矛盾' })).toContainText('(要点 1、2)');
    await expect(s.asks.getByRole('listitem').filter({ hasText: '偽の聞いていないこと' })).toBeVisible();
    await expect(s.asks.getByRole('listitem').filter({ hasText: '話に出ていません' })).toHaveCount(2);
    await expectNoDevWords(s.section);
    await expectReadableText(page, 'ヒアリングの整理');
    await page.screenshot({ path: path.join(UX_SHOTS, 'K1-board.png'), fullPage: true });

    // 押すまで「確かめた」の印が付かない
    await expect(s.mark).toHaveText('整理: 下書き');
    await expect(s.state).toContainText('まだ確かめていません');
    let saved = await board(home, id);
    expect(saved.status).toBe('draft');
    expect(saved.confirmedAt).toBeNull();

    // 推測を人が確かめると、印が外れ、聞くことから消える
    const guessItem = s.column('データ').locator('.organize-item', { hasText: '偽の話に出ていない項目' });
    await guessItem.getByRole('button', { name: 'この項目は合っている' }).click();
    await expect(guessItem.getByText('人が確かめた')).toBeVisible();
    await expect(guessItem.getByText('推測', { exact: true })).toHaveCount(0);
    await expect(s.asks.getByRole('listitem').filter({ hasText: '話に出ていません' })).toHaveCount(1);
    await expect(s.mark).toHaveText('整理: 下書き');

    // 決める人が押すと、印が付く
    await s.confirm.click();
    await expect(s.mark).toHaveText('整理: 確かめた');
    await expect(s.state).toContainText('決める人が確かめました');
    // 確かめた後は押せない(時刻を押し直さない)
    await expect(s.confirm).toBeDisabled();
    saved = await board(home, id);
    expect(saved.status).toBe('confirmed');
    expect(saved.confirmedAt).toBeTruthy();
    await page.screenshot({ path: path.join(UX_SHOTS, 'K1-confirmed.png'), fullPage: true });

    // 読み込み直しても残る
    await page.reload();
    await expect(s.mark).toHaveText('整理: 確かめた');
    await s.mark.click();
    await expect(s.items).toHaveCount(12);
    await expect(s.state).toContainText('決める人が確かめました');

    // 板を変えると、印が外れる。もう一度押すまで付かない
    await s.point.fill('当日の配達は、午前と午後に分かれている');
    await s.point.press('Enter');
    await expect(s.mark).toHaveText('整理: 下書き');
    await expect(s.state).toContainText('まだ確かめていません');
    expect((await board(home, id)).confirmedAt).toBeNull();
  } finally {
    await studio.stop();
  }
  // 起動し直しても残る。同意は残らないので、整理せずに読める
  const again = await launchStudio(home, { env: claudeEnv() });
  try {
    await page.goto(again.url);
    await page.locator('#project-menu-button').click();
    await chooseSample(page, SAMPLES.library);
    const s = ui(page);
    await expect(s.mark).toHaveText('整理: 下書き');
    await s.mark.click();
    await expect(s.points.getByRole('listitem')).toHaveCount(11);
  } finally {
    await again.stop();
  }
});

test('人が直して足して消す。整理し直しても、直した項目は残り、消した項目は戻らない', async ({ page, home }) => {
  test.setTimeout(60_000);
  const studio = await launchStudio(home);
  try {
    const s = await openBoard(page, studio);
    await typePoints(s, ['再配達の受付は、その日の 17 時まで', '不在票に荷物の番号がある']);
    await s.run.click();
    // 偽接続は要点の語で欄を決める
    const rule = s.column('決まりごと').locator('.organize-item', { hasText: '17 時まで' }).first();
    await expect(rule).toBeVisible();
    await expect(s.column('データ').locator('.organize-item', { hasText: '不在票' })).toBeVisible();
    await expectNoDevWords(s.section);

    // 直す: 文と欄を変える
    await rule.getByRole('button', { name: '直す', exact: true }).click();
    await s.section.getByLabel('項目の文').fill('再配達の受付は 17 時まで');
    await s.section.getByLabel('項目の欄').selectOption({ label: '要求' });
    await s.section.getByRole('button', { name: '保存する' }).click();
    await expect(s.column('要求').locator('.organize-item', { hasText: '再配達の受付は 17 時まで' })).toContainText('元の要点 1');

    // 直している途中に要点を足しても、書きかけの文は消えない
    const dataItem = s.column('データ').locator('.organize-item', { hasText: '不在票' });
    await dataItem.getByRole('button', { name: '直す', exact: true }).click();
    await s.section.getByLabel('項目の文').fill('書きかけの文');
    await s.point.fill('直している間に打った要点');
    await s.point.press('Enter');
    await expect(s.points.getByRole('listitem')).toHaveCount(3);
    await expect(s.section.getByLabel('項目の文')).toHaveValue('書きかけの文');
    await s.section.getByRole('button', { name: 'やめる' }).click();
    await s.points.getByRole('listitem').filter({ hasText: '直している間に打った要点' }).getByRole('button', { name: '消す' }).click();
    await expect(s.points.getByRole('listitem')).toHaveCount(2);

    // 消す
    await s.column('データ').locator('.organize-item', { hasText: '不在票' }).getByRole('button', { name: '消す' }).click();
    await expect(s.column('データ').locator('.organize-item')).toHaveCount(0);
    await expect(s.asks).toContainText('「データ」の話をまだ聞いていません');

    // 足す: 打った文は要点にも足され、その要点が元になる
    await page.getByLabel('足す欄').selectOption({ label: '使う人' });
    await page.getByLabel('足す項目').fill('受付の担当');
    await page.getByRole('button', { name: '項目を足す' }).click();
    await expect(s.column('使う人').locator('.organize-item', { hasText: '受付の担当' })).toContainText('元の要点 4: 受付の担当');

    // 整理し直す
    await s.run.click();
    await expect(s.note).toBeHidden();
    await expect(s.column('要求').locator('.organize-item', { hasText: '再配達の受付は 17 時まで' })).toBeVisible();
    await expect(s.column('使う人').locator('.organize-item', { hasText: '受付の担当' })).toHaveCount(1);
    await expect(s.section.locator('.organize-item', { hasText: '不在票に荷物の番号がある' }).filter({ hasNot: s.section.getByText('元の要点 4') })).toHaveCount(0);
  } finally {
    await studio.stop();
  }
});

test('同意しないと AI を呼ばず、要点を手で振り分けられる。項目がそろえば押せる', async ({ page, home }) => {
  test.skip(process.platform === 'win32', '偽の claude を直接起動するため');
  test.setTimeout(60_000);
  const log = path.join(home, 'claude.log');
  const studio = await launchStudio(home, { env: claudeEnv(log) });
  try {
    const s = await openBoard(page, studio);
    await typePoints(s, ['お年寄りのお客さんも多い']);
    await s.run.click();
    const card = page.getByRole('group', { name: '本物の AI を使う前に' });
    await card.getByRole('button', { name: 'やめる' }).click();
    await expect(page.locator('#organize-declined')).toBeVisible();
    expect((await fs.readFile(log, 'utf8').catch(() => '')).includes('toAsk')).toBe(false);

    await page.getByLabel('要点 1 を入れる欄').selectOption({ label: '使う人' });
    await expect(s.column('使う人').locator('.organize-item')).toContainText('元の要点 1: お年寄りのお客さんも多い');
    await expect(s.asks).toContainText('「要求」の話をまだ聞いていません');
    await s.confirm.click();
    await expect(s.mark).toHaveText('整理: 確かめた');
    expect((await fs.readFile(log, 'utf8').catch(() => '')).includes('toAsk')).toBe(false);
  } finally {
    await studio.stop();
  }
});

test('本物の AI を止めた設定では、「整理する」を押せず、手で振り分ける道を案内する', async ({ page, home }) => {
  test.skip(process.platform === 'win32', '偽の claude を直接起動するため');
  test.setTimeout(60_000);
  const studio = await launchStudio(home, { env: { ...claudeEnv(), STUDIO_ALLOW_CLAUDE_CODE: '0' } });
  try {
    const s = await openBoard(page, studio);
    await expect(page.locator('#organize-no-ai')).toBeVisible();
    await typePoints(s, ['お年寄りのお客さんも多い']);
    await expect(s.run).toBeDisabled();
  } finally {
    await studio.stop();
  }
});

test('AI を待つ間も要点を足せる。止めると板はそのまま。失敗しても要点は消えず、もう一度押せる。待つ間は押せない', async ({ page, home }) => {
  test.skip(process.platform === 'win32', '偽の claude を直接起動するため');
  test.setTimeout(90_000);
  const studio = await launchStudio(home, { env: claudeEnv() });
  try {
    const s = await openBoard(page, studio);
    await typePoints(s, ['[整理が遅い] 架空の要点']);
    await s.run.click();
    await page.getByRole('group', { name: '本物の AI を使う前に' }).getByRole('button', { name: '同意して使う' }).click();
    await expect(page.getByText('整理しています…')).toBeVisible();
    await expect(s.confirm).toBeDisabled();

    // 待つ間も打てる
    await s.point.fill('待つ間に打った要点');
    await s.point.press('Enter');
    await expect(s.points.getByRole('listitem')).toHaveCount(2);
    await expect(page.getByText('整理しています…')).toBeVisible();

    // 読み込み直しても、待っていることが分かり、止められる
    await page.reload();
    await s.mark.click();
    await expect(page.getByText('整理しています…')).toBeVisible();
    await expect(s.confirm).toBeDisabled();
    await page.getByRole('button', { name: '止める' }).click();
    await expect(s.note).toContainText('止めました', { timeout: 15_000 });
    await expect(s.points.getByRole('listitem')).toHaveCount(2);
    await expect(s.items).toHaveCount(0);

    // 失敗: 要点は残り、知らせが出る
    await s.points.getByRole('listitem').filter({ hasText: '架空の要点' }).getByRole('button', { name: '消す' }).click();
    await s.point.fill('[整理が失敗] 架空の要点');
    await s.point.press('Enter');
    await expect(s.points.getByRole('listitem')).toHaveCount(2);
    await s.run.click();
    await expect(s.note).toContainText('AI の返事を使えませんでした');
    await expect(s.points.getByRole('listitem')).toHaveCount(2);

    // 失敗の元の要点を消すと、整理できる
    await s.points.getByRole('listitem').filter({ hasText: '整理が失敗' }).getByRole('button', { name: '消す' }).click();
    await s.run.click();
    await expect(s.column('要求').locator('.organize-item', { hasText: '待つ間に打った要点' })).toBeVisible();
    await expect(s.note).toBeHidden();
  } finally {
    await studio.stop();
  }
});

for (const [width, height] of [[1024, 700], [900, 900], [390, 700]]) {
  test(`幅 ${width} の窓でも、要点、板、「この理解で合っている」まで進める`, async ({ page, home }) => {
    test.setTimeout(60_000);
    const studio = await launchStudio(home);
    try {
      await page.setViewportSize({ width, height });
      const s = await openBoard(page, studio);
      await typePoints(s, ['再配達の受付は、その日の 17 時まで']);
      await s.run.click();
      await expect(s.column('決まりごと').locator('.organize-item').first()).toBeVisible();
      await s.confirm.scrollIntoViewIfNeeded();
      await s.confirm.click();
      await expect(s.mark).toHaveText('整理: 確かめた');
      // 横にはみ出さない
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow).toBeLessThanOrEqual(1);
      // 上の帯が見出しに重ならない
      const bar = await page.getByRole('banner').boundingBox();
      const heading = await page.getByRole('heading', { level: 2, name: 'ヒアリングの整理' }).boundingBox();
      expect(bar.y + bar.height).toBeLessThanOrEqual(heading.y + 1);
      await page.screenshot({ path: path.join(UX_SHOTS, `K1-${width}.png`), fullPage: true });
    } finally {
      await studio.stop();
    }
  });
}

test('読んだ後に板が変わっていると、押しても「確かめた」の印が付かず、板を読み直す', async ({ page, home }) => {
  test.setTimeout(60_000);
  const studio = await launchStudio(home);
  try {
    const s = await openBoard(page, studio);
    await typePoints(s, ['再配達の受付は、その日の 17 時まで']);
    await s.run.click();
    await expect(s.column('決まりごと').locator('.organize-item').first()).toBeVisible();
    // 別のタブで要点が足された
    const added = await studio.post(`/api/projects/${SAMPLES.library.id}/organize/point`, { text: '別のタブで足した要点' });
    expect(added.status).toBe(200);
    await s.confirm.click();
    await expect(page.locator('#organize-error')).toContainText('読み直してから');
    await expect(s.points).toContainText('別のタブで足した要点');
    expect((await board(home, SAMPLES.library.id)).confirmedAt).toBeNull();
    await expect(s.state).toContainText('まだ確かめていません');
    // 読み直した板なら押せる
    await s.confirm.click();
    await expect(s.mark).toHaveText('整理: 確かめた');
  } finally {
    await studio.stop();
  }
});

test('整理の板がある試作品があれば、読み込み直しても起動し直しても、はじめの画面で隠さない', async ({ page, home }) => {
  test.setTimeout(60_000);
  const env = { STUDIO_START_SCREEN: undefined };
  const start = page.getByRole('heading', { level: 2, name: 'どんなものを作りたいですか' });
  const first = await launchStudio(home, { env });
  try {
    await page.goto(first.url);
    await expect(start).toBeVisible();
    await page.locator('#project-menu-button').click();
    await chooseSample(page, SAMPLES.library);
    const s = ui(page);
    await s.mark.click();
    await typePoints(s, ['お年寄りのお客さんも多い']);
    await page.reload();
    await expect(s.mark).toHaveText('整理: 下書き');
    await expect(start).toBeHidden();
    await expect(page.locator('#project-title')).toContainText('図書室');
  } finally {
    await first.stop();
  }
  const again = await launchStudio(home, { env });
  try {
    await page.goto(again.url);
    const s = ui(page);
    await expect(s.mark).toHaveText('整理: 下書き');
    await expect(start).toBeHidden();
  } finally {
    await again.stop();
  }
});

test('板を開くと、前の試作品のために書いた文と板を持ち込まない', async ({ page, home }) => {
  test.setTimeout(60_000);
  const studio = await launchStudio(home);
  try {
    const s = await openBoard(page, studio);
    await typePoints(s, ['図書室の要点']);
    await s.point.fill('図書室のために書きかけた文');
    await page.getByRole('button', { name: '試作品の画面に戻る' }).click();
    await page.locator('#project-menu-button').click();
    await chooseSample(page, SAMPLES.jobConsult);
    await s.mark.click();
    await expect(s.section).toBeVisible();
    await expect(s.point).toHaveValue('');
    await expect(s.points.getByRole('listitem')).toHaveCount(0);
    await expect(s.confirm).toBeDisabled();
  } finally {
    await studio.stop();
  }
});

test('整理の板から別の画面へ移れる。はじめの画面と重ならない', async ({ page, home }) => {
  test.setTimeout(60_000);
  const studio = await launchStudio(home);
  try {
    const s = await openBoard(page, studio);
    // 試作品の画面に戻る
    await page.getByRole('button', { name: '試作品の画面に戻る' }).click();
    await expect(s.section).toBeHidden();
    await expect(page.getByRole('region', { name: '作る AI', exact: true })).toBeVisible();

    // 目的の印を押すと、板を閉じて開く
    await s.mark.click();
    await expect(s.section).toBeVisible();
    await page.locator('#intent-mark').click();
    await expect(s.section).toBeHidden();
    await expect(page.locator('#intent')).toBeVisible();

    // 目的の画面から板を開くと、目的の画面を閉じる
    await s.mark.click();
    await expect(s.section).toBeVisible();
    await expect(page.locator('#intent')).toBeHidden();

    // 新しく作る
    await page.locator('#project-menu-button').click();
    await page.getByRole('button', { name: '新しく作る' }).click();
    await expect(s.section).toBeHidden();
    await expect(page.getByRole('heading', { level: 2, name: 'どんなものを作りたいですか' })).toBeVisible();
    await expect(s.mark).toBeHidden();
  } finally {
    await studio.stop();
  }
});
