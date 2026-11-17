import fs from 'node:fs/promises';
import path from 'node:path';
import { ROOT, SAMPLES, chooseSample, expect, expectNoDevWordsOnScreen, launchStudio, openDevDetails, test } from './studio.js';

// U10: 「分かるか」の確かめ(docs/design/ux-redesign.md の 9 節)のスクリーンショット。P31。
// U7(最初の 1 分の流れ)と U8(Claude Code がないとき)の各場面、結果の帯(fixed、failed)、
// 見本 A(バイト探し)のトークの枠と、開発者向けの詳細の記録を 1440x900 で撮り、test-results/ux/ に置く(git は無視する)。
// 人の確かめに使う画像は、撮った後に docs/evidence/ux/final/ へ写す(docs/evidence/ux/final/check.md)。
// 実モデルは呼ばない。直す AI は偽の claude(既定の起動と同じ形。上の帯に開発用の印が出ない)、試作品の中の AI はお試しの AI

const UX_SHOTS = path.join(ROOT, 'test-results', 'ux');
const CARD = '本物の AI を使う前に';
const EXAMPLE = 'カフェで働きたいです';
const BEFORE = '働き方の希望はありますか?';
const AFTER = '時給はいくら以上を希望しますか?';

// 偽の claude をシェルスクリプトで作る。--version と auth status と試作品の中の AI(--json-schema)は偽の CLI に、
// それ以外(直す AI)は偽接続に渡す。slow なら直す AI の出力を 1 行ずつ少し遅らせる。直している場面を撮るため
async function writeFakeClaude(home, { slow = false } = {}) {
  const bin = path.join(home, 'bin', 'claude');
  await fs.mkdir(path.dirname(bin), { recursive: true });
  const node = `"${process.execPath}"`;
  const cli = `"${path.join(ROOT, 'test', 'fixtures', 'fake-claude.js')}"`;
  const fixer = `"${path.join(ROOT, 'src', 'agent', 'fake-claude.js')}"`;
  const run = slow
    ? `${node} ${fixer} "$@" | while IFS= read -r line || [ -n "$line" ]; do printf '%s\\n' "$line"; sleep 0.2; done`
    : `exec ${node} ${fixer} "$@"`;
  await fs.writeFile(
    bin,
    ['#!/bin/sh', `case "$1" in --version|auth) exec ${node} ${cli} "$@";; esac`, `case "$*" in *--json-schema*) exec ${node} ${cli} "$@";; esac`, run, ''].join('\n'),
    { mode: 0o755 },
  );
  return bin;
}

async function launchWithFakeClaude(home, options) {
  return launchStudio(home, { env: { STUDIO_AGENT: undefined, STUDIO_CLAUDE_BIN: await writeFakeClaude(home, options) } });
}

// 撮る。devWords が true なら、Studio の画面(iframe の外)の見える文字に開発の言葉がないことも確かめる(U3)
async function shoot(page, name, { devWords = true } = {}) {
  if (devWords) await expectNoDevWordsOnScreen(page);
  await page.screenshot({ path: path.join(UX_SHOTS, `U10-${name}.png`) });
}

function lastRun(page) {
  return page.getByRole('list', { name: '作る会話' }).locator('> li.run').last();
}

// 次の一手の帯の 1 文(前の「はじめの手順」の 1 文。ui-ux-v2.md の 13 節)
function nextOf(page) {
  return page.locator('#next-text');
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
});

test('U10(U7): 最初の画面から、試す → 言葉で直す → 直った結果を試す、までの各場面を撮る', async ({ page, home }) => {
  test.skip(process.platform === 'win32', '偽の claude をシェルスクリプトで作るため');
  // 直す AI の依頼(作るループの関門を含む)を 1 回終えるまで待つ
  test.setTimeout(120_000);
  const studio = await launchWithFakeClaude(home, { slow: true });
  try {
    await page.goto(studio.url);
    const app = page.frameLocator('iframe[title="試作品"]');
    const log = app.getByRole('region', { name: '会話' }).getByRole('listitem');
    const make = page.getByRole('region', { name: '言葉で直す' });
    const bar = page.getByRole('region', { name: '試し直す' });
    const next = nextOf(page);

    // 最初の画面(人の確かめの 5 秒の確かめで見せる画像)
    await expect(app.getByRole('heading', { name: 'しおかぜ求人相談' })).toBeVisible();
    await expect(next).toHaveText('まず左の試作品で、案内役に話しかけてみましょう。');
    await expect(make.getByRole('list', { name: '直し方の例' }).getByRole('button')).toHaveCount(3);
    // 上の帯に開発用の印(偽の直す AI)が出ない
    await expect(page.locator('#dev-agent-mark')).toBeHidden();
    await shoot(page, '01-first');

    // 1. 試す: 例の文を送ると返事が来て、次の一手の帯が言葉で直すを勧める
    await app.getByLabel('メッセージ').fill(EXAMPLE);
    await app.getByRole('button', { name: '送る' }).click();
    await expect(log).toHaveCount(3);
    await expect(log.last()).toContainText(BEFORE);
    await expect(next).toContainText('「言葉で直す」に頼んでみましょう');
    await shoot(page, '02-talked');

    // 2. 言葉で直す: 直す欄の例を押して送ると、本物の AI を使う前のカードが出る
    await make.getByRole('list', { name: '直し方の例' }).getByRole('button', { name: '時給の下限を先に聞くようにして' }).click();
    await make.getByRole('button', { name: '送る' }).click();
    const card = page.getByRole('group', { name: CARD });
    await expect(card).toBeVisible();
    await shoot(page, '03-consent');

    // 同意すると、直す AI が直す
    await card.getByRole('button', { name: '同意して使う' }).click();
    const run = lastRun(page);
    await expect(run.getByText('AI の設定を読みました')).toBeVisible({ timeout: 15_000 });
    await expect(run.locator('.run-status')).toHaveText('直す AI が作業しています…');
    await shoot(page, '04-fixing');

    // 直す AI が終わると、結果の帯と試し直しの帯が出て、次の一手の帯が試し直しを勧める
    await expect(run.getByRole('group', { name: '確かめた結果' })).toBeVisible({ timeout: 60_000 });
    await expect(run.locator('.run-updated')).toHaveText('AI の設定を変えました。試作品は新しくなっています。');
    await expect(next).toContainText('同じ発言で試し直す');
    await expect(bar.getByRole('button', { name: '同じ発言で試し直す' })).toBeVisible();
    await shoot(page, '05-fixed');

    // 3. 直った結果を試す: 「同じ発言で試し直す」で、直す前と後の返事が並ぶ
    await bar.getByRole('button', { name: '同じ発言で試し直す' }).click();
    const reply = bar.getByRole('region', { name: '直す前と後の返事' }).getByRole('listitem');
    await expect(reply.locator('.retry-before')).toContainText(BEFORE);
    await expect(reply.locator('.retry-after')).toContainText(AFTER);
    await expect(next).toContainText('直った結果も試しました');
    await shoot(page, '06-retried');
  } finally {
    await studio.stop();
  }
});

test('U10(U8): Claude Code がないときの直す欄と、そのまま試せる場面を撮る', async ({ page, home }) => {
  const studio = await launchStudio(home, { env: { STUDIO_AGENT: undefined, STUDIO_CLAUDE_BIN: path.join(home, 'no-such-claude') } });
  try {
    await page.goto(studio.url);
    const app = page.frameLocator('iframe[title="試作品"]');
    await expect(app.getByRole('heading', { name: 'しおかぜ求人相談' })).toBeVisible();
    const card = page.getByRole('group', { name: '言葉で直すには、Claude Code が要ります' });
    await expect(card).toBeVisible();
    await expect(card).toContainText('この PC で Claude Code が見つかりません。');
    await expect(page.getByLabel('依頼')).toHaveAttribute('placeholder', '直す AI が使えないので、送れません');
    await shoot(page, '07-unavailable');

    // 試すは使える(試作品の中の AI はお試しの AI)
    await app.getByLabel('メッセージ').fill(EXAMPLE);
    await app.getByRole('button', { name: '送る' }).click();
    await expect(app.getByRole('region', { name: '会話' }).getByRole('listitem').last()).toContainText(BEFORE);
    await expect(card).toBeVisible();
    await shoot(page, '08-unavailable-talked');
  } finally {
    await studio.stop();
  }
});

test('U10: 結果の帯(fixed と failed)を撮る', async ({ page, home }) => {
  test.skip(process.platform === 'win32', '偽の claude をシェルスクリプトで作るため');
  // 直す依頼を 2 回(どちらも直すラウンドを回す)終えるまで待つ
  test.setTimeout(90_000);
  const studio = await launchWithFakeClaude(home);
  try {
    await page.goto(studio.url);
    await chooseSample(page, SAMPLES.library);
    await expect(page.frameLocator('iframe[title="試作品"]').getByRole('heading', { name: 'こもれび図書室' })).toBeVisible();
    const make = page.getByRole('region', { name: '言葉で直す' });
    const send = async (text) => {
      await page.getByLabel('依頼').fill(text);
      await make.getByRole('button', { name: '送る' }).click();
    };

    // 壊れる依頼でも、Studio が見つけた問題を直す AI が直す(fixed)
    await send('壊して');
    await page.getByRole('group', { name: CARD }).getByRole('button', { name: '同意して使う' }).click();
    const fixed = lastRun(page).getByRole('group', { name: '確かめた結果' });
    await expect(fixed).toHaveAttribute('data-status', 'fixed', { timeout: 30_000 });
    await expect(fixed).toContainText('直す AI が直した回数: 1 回(2 回まで)');
    await expect(fixed.getByRole('list', { name: '確かめた画面' }).locator('img')).toHaveCount(3);
    await shoot(page, '09-band-fixed');

    // 直しきれない依頼(failed)。前に表示できた状態を出したまま、何がうまくいかないかを返す
    await send('壊して、直せないふりをして');
    const failed = lastRun(page).getByRole('group', { name: '確かめた結果' });
    await expect(failed).toHaveAttribute('data-status', 'failed', { timeout: 30_000 });
    await expect(failed).toContainText('直す AI が直そうとした回数: 2 回(2 回まで)');
    await shoot(page, '10-band-failed');
  } finally {
    await studio.stop();
  }
});

test('U10: 見本 A(バイト探し)のトークの枠と、開発者向けの詳細の記録を撮る', async ({ page, home }) => {
  test.skip(process.platform === 'win32', '偽の claude をシェルスクリプトで作るため');
  const studio = await launchWithFakeClaude(home);
  try {
    await page.goto(studio.url);
    await chooseSample(page, SAMPLES.partTime);
    const app = page.frameLocator('iframe[title="試作品"]');
    const talk = app.getByRole('region', { name: '会話' });
    const items = talk.getByRole('list', { name: 'やりとり' }).locator(':scope > li');
    await expect(app.getByRole('heading', { name: 'そよかぜバイト探し' })).toBeVisible();

    // トークの枠: 例の発言を押すと、案内役(模擬)がツールで探し、カードの一覧が出る
    await talk.getByRole('group', { name: '話しかける例' }).getByRole('button', { name: 'みなと町でバイトを探しています' }).click();
    await expect(items.last()).toContainText('みなと町では3件ありました。');
    await expect(talk.getByRole('group', { name: 'カードの一覧' }).getByRole('article')).toHaveCount(3);
    await shoot(page, '11-talk-cards');

    // 同意の前に保存を頼むと、ツールの守りが止める
    const message = app.getByLabel('メッセージ');
    await message.fill('そのまま保存して');
    await app.getByRole('button', { name: '送る' }).click();
    await expect(items.last()).toContainText('記録「consent」がありません');
    await shoot(page, '12-talk-guard');

    // 開発者向けの詳細の記録: 模擬の会話の中身(参加者、ツール、守り)を開く。開発者向けなので、開発の言葉は確かめない
    await openDevDetails(page);
    const entries = page.locator('#ai-trace').getByRole('list', { name: 'AI の実行の記録' }).locator(':scope > li');
    await expect(entries).toHaveCount(2);
    const blocked = entries.first();
    const summary = blocked.getByText('模擬の会話の中身: 参加者、ツール、守り(開発向け)');
    await summary.click();
    const tool = blocked.getByRole('list', { name: '模擬の会話の段' }).locator(':scope > li').filter({ hasText: 'ツール save_wish' });
    await expect(tool.getByRole('list', { name: '守りの層と判定' }).locator('li[data-effect="blocked"]')).toContainText('ツールの守り「requires」: 止めた');
    await summary.evaluate((node) => node.scrollIntoView({ block: 'start' }));
    await shoot(page, '13-dev-record', { devWords: false });
  } finally {
    await studio.stop();
  }
});
