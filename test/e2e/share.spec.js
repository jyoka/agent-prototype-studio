import path from 'node:path';
import { startRelay } from '../../src/relay/relay-server.js';
import { chooseSample, expect, expectNoDevWords, launchStudio, SAMPLES, test } from './studio.js';

// その場の共有(docs/design/collaboration.md の 9.4、K7 の 2 枚目)。中継のサーバーはテストの中で 127.0.0.1 に起こす。
// 作る AI は偽接続(STUDIO_AGENT=fake)。実モデルは呼ばない。題材は架空の図書室

const ID = SAMPLES.library.id;
const FIRST = '本を題で探せる';
const SECOND = '貸出は 1 人 3 冊まで';

async function addItems(studio) {
  for (const [column, text] of [['requirement', FIRST], ['rule', SECOND]]) {
    const added = await studio.post(`/api/projects/${ID}/organize/item`, { column, text });
    expect(added.status).toBe(200);
  }
}

// 進行役の画面で整理の板を開く
async function openBoard(page, studio) {
  await page.goto(studio.url);
  await page.locator('#project-menu-button').click();
  await chooseSample(page, SAMPLES.library);
  await page.locator('#organize-mark').click();
  await expect(page.getByRole('heading', { level: 2, name: 'ヒアリングの整理' })).toBeVisible();
  return page.locator('#share');
}

// 共有を始め、招待のリンクを作って、その文を返す
async function invite(share, name, role) {
  await share.getByLabel('招く人の呼び名').fill(name);
  await share.getByLabel('役').selectOption({ label: role });
  await share.getByRole('button', { name: '招待のリンクを作る' }).click();
  const link = share.getByLabel(`${name}の招待のリンク`);
  await expect(link).toHaveValue(/\/s\/[A-Za-z0-9_-]+#k=/);
  return link.inputValue();
}

async function openParticipant(browser, link) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(link);
  // 鍵はアドレス欄と閲覧の履歴に残さない
  await expect(page).toHaveURL(/\/s\/[A-Za-z0-9_-]+$/);
  await expect(page.locator('#share-status')).toHaveText(/つながっています/);
  return { context, page };
}

const boardItem = (page, column, text) => page.getByRole('region', { name: column, exact: true }).getByRole('listitem').filter({ hasText: text });

test('2 つのブラウザで、整理の板の別の項目を同時に直すと、両方と進行役の画面に出る', async ({ page, browser, home }) => {
  test.setTimeout(60_000);
  const relay = await startRelay();
  const studio = await launchStudio(home, { env: { STUDIO_RELAY_URL: relay.url } });
  const opened = [];
  try {
    await addItems(studio);
    const share = await openBoard(page, studio);
    await expect(share.locator('#share-state')).toContainText('共有していません');
    await share.getByRole('button', { name: '共有を始める' }).click();
    await expect(share.locator('#share-state')).toContainText('共有しています');
    const linkA = await invite(share, 'しおり', '参加者(直せる)');
    const linkB = await invite(share, 'みなと', '参加者(直せる)');
    const linkC = await invite(share, 'つばさ', '見るだけ');
    await expectNoDevWords(page.locator('#organize'));

    const a = await openParticipant(browser, linkA);
    const b = await openParticipant(browser, linkB);
    opened.push(a, b);
    await expect(a.page.locator('#share-who')).toHaveText('あなた: しおり(参加者(直せる))');
    for (const p of [a.page, b.page]) {
      await expect(boardItem(p, '要求', FIRST)).toBeVisible();
      await expect(boardItem(p, '決まりごと', SECOND)).toBeVisible();
    }

    // 同じ板の別の項目を、2 人が同時に直す
    await boardItem(a.page, '要求', FIRST).getByRole('button', { name: '直す' }).click();
    await boardItem(b.page, '決まりごと', SECOND).getByRole('button', { name: '直す' }).click();
    await a.page.getByLabel('項目の文').fill('本を題と著者で探せる');
    await b.page.getByLabel('項目の文').fill('貸出は 1 人 5 冊まで');
    await Promise.all([a.page.getByRole('button', { name: '保存' }).click(), b.page.getByRole('button', { name: '保存' }).click()]);

    for (const p of [a.page, b.page]) {
      await expect(boardItem(p, '要求', '本を題と著者で探せる')).toBeVisible();
      await expect(boardItem(p, '決まりごと', '貸出は 1 人 5 冊まで')).toBeVisible();
      // Studio が当てたら「送りました」の印が消える
      await expect(p.locator('.share-pending')).toHaveCount(0);
    }
    // 進行役の画面にも出る(押さなくても読み直す)
    await expect(page.locator('#organize-columns .organize-item', { hasText: '本を題と著者で探せる' })).toBeVisible();
    await expect(page.locator('#organize-columns .organize-item', { hasText: '貸出は 1 人 5 冊まで' })).toBeVisible();

    // 見るだけの人は読めるが、直す口がない
    const c = await openParticipant(browser, linkC);
    opened.push(c);
    await expect(c.page.getByText('見るだけの役です')).toBeVisible();
    await expect(boardItem(c.page, '要求', '本を題と著者で探せる')).toBeVisible();
    await expect(c.page.getByRole('button', { name: '直す' })).toHaveCount(0);
    await expect(c.page.locator('#share-add')).toBeHidden();
    // 要件の文書の写しも、直した板から作り直される
    await expect(c.page.locator('#share-requirements')).toContainText('本を題と著者で探せる');
  } finally {
    for (const { context } of opened) await context.close();
    await studio.stop();
    await relay.close();
  }
});

test('中継のサーバーを止めて進行役と参加者がそれぞれ直し、つなぎ直すと両方の画面で合わさる。共有をやめると参加者の写しも消える', async ({ page, browser, home }) => {
  test.setTimeout(60_000);
  const dataDir = path.join(home, 'relay-data');
  let relay = await startRelay({ dataDir });
  const { port } = relay;
  const studio = await launchStudio(home, { env: { STUDIO_RELAY_URL: relay.url } });
  let participant;
  try {
    await addItems(studio);
    const share = await openBoard(page, studio);
    await share.getByRole('button', { name: '共有を始める' }).click();
    await expect(share.locator('#share-state')).toContainText('共有しています');
    participant = await openParticipant(browser, await invite(share, 'しおり', '参加者(直せる)'));
    const p = participant.page;
    await expect(boardItem(p, '要求', FIRST)).toBeVisible();

    // 中継のサーバーを止める。両方の画面が、つながっていないと知らせる
    await relay.close();
    await expect(share.locator('#share-state')).toContainText('つながっていません');
    await expect(p.locator('#share-status')).toContainText('つながっていません');

    // 進行役は手元で続けられる
    const item = page.locator('#organize-columns .organize-item', { hasText: FIRST });
    await item.getByRole('button', { name: '直す', exact: true }).click();
    await page.locator('#organize').getByLabel('項目の文').fill('本を題と著者と分類で探せる');
    await page.locator('#organize').getByRole('button', { name: '保存する' }).click();
    await expect(page.locator('#organize-columns .organize-item', { hasText: '本を題と著者と分類で探せる' })).toBeVisible();
    await expect(boardItem(p, '要求', FIRST)).toBeVisible();

    // 参加者も、切れている間に直せる。画面に残り、「送りました」と出る
    await boardItem(p, '決まりごと', SECOND).getByRole('button', { name: '直す' }).click();
    await p.getByLabel('項目の文').fill('貸出は 1 人 4 冊まで');
    await p.getByRole('button', { name: '保存' }).click();
    await expect(boardItem(p, '決まりごと', '貸出は 1 人 4 冊まで')).toContainText('送りました');

    // つなぎ直すと、両方の直しが合わさる
    relay = await startRelay({ port, dataDir });
    await expect(share.locator('#share-state')).toContainText('共有しています', { timeout: 15_000 });
    await expect(p.locator('#share-status')).toContainText('つながっています', { timeout: 15_000 });
    await expect(boardItem(p, '要求', '本を題と著者と分類で探せる')).toBeVisible();
    await expect(boardItem(p, '決まりごと', '貸出は 1 人 4 冊まで')).toBeVisible();
    await expect(p.locator('.share-pending')).toHaveCount(0);
    await expect(page.locator('#organize-columns .organize-item', { hasText: '貸出は 1 人 4 冊まで' })).toBeVisible();

    // 共有をやめると、中継のサーバーの写しを消し、参加者の画面の写しも消える
    await share.getByRole('button', { name: '共有をやめる(中継のサーバーの写しを消す)' }).click();
    await expect(share.locator('#share-state')).toContainText('共有していません');
    await expect(p.locator('#share-gone')).toHaveText(/この会のデータは消しました/);
    await expect(p.locator('#share-main')).toBeHidden();
    expect(await p.evaluate(() => sessionStorage.length)).toBe(0);
  } finally {
    await participant?.context.close();
    await studio.stop();
    await relay.close();
  }
});
