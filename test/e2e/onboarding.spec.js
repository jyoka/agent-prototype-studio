import fs from 'node:fs/promises';
import path from 'node:path';
import { chooseSample, expect, expectNoDevWords, expectReadableText, launchStudio, ROOT, SAMPLES, switchToRealAi, test } from './studio.js';

// 最初の一歩の案内と試し直しの帯(docs/design/ux-redesign.md の 2 節、7-1、7-2、7-4、9 節の U2、U7。P28)。
// 実モデルは呼ばない。claude は偽物で、直す AI としては偽接続(src/agent/fake-claude.js)、
// --version と auth status には偽の CLI(test/fixtures/fake-claude.js)が答える。試作品の中の AI は、お試しの AI のまま

// 「分かるか」の確かめ(ux-redesign.md 9 節)のスクリーンショットの置き場。test-results/ は git が無視する
const UX_SHOTS = path.join(ROOT, 'test-results', 'ux');
const LEAD = '試作品を試して、気になるところを言葉で直す場所です。';
const STEPS = ['1 試す', '2 言葉で直す', '3 直った結果を試す'];
// 試作品の会話で送る例の文(ux-redesign.md 7-2)と、直す前と後の返事
const EXAMPLE = 'カフェで働きたいです';
const BEFORE = '働き方の希望はありますか?';
const AFTER = '時給はいくら以上を希望しますか?';

// 偽の claude をシェルスクリプトで作る。--version と auth status は偽の CLI に、それ以外(直す AI)は偽接続に渡す。
// 直す AI の出力は 1 行ずつ少し遅らせる。直している場面を撮るため
async function writeFakeClaude(home) {
  const bin = path.join(home, 'bin', 'claude');
  await fs.mkdir(path.dirname(bin), { recursive: true });
  const node = `"${process.execPath}"`;
  const cli = `"${path.join(ROOT, 'test', 'fixtures', 'fake-claude.js')}"`;
  const fixer = `"${path.join(ROOT, 'src', 'agent', 'fake-claude.js')}"`;
  await fs.writeFile(
    bin,
    [
      '#!/bin/sh',
      `case "$1" in --version|auth) exec ${node} ${cli} "$@";; esac`,
      `case "$*" in *--json-schema*) exec ${node} ${cli} "$@";; esac`,
      `${node} ${fixer} "$@" | while IFS= read -r line || [ -n "$line" ]; do printf '%s\\n' "$line"; sleep 0.2; done`,
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  return bin;
}

function guideOf(page) {
  const guide = page.getByRole('region', { name: 'はじめの手順' });
  return { guide, steps: guide.getByRole('list', { name: '3 つの手順' }).getByRole('listitem'), hint: page.locator('#first-steps-hint') };
}

// 今の手順(aria-current="step")が index 番目だけ。index が -1 なら、今の手順はない(全部済み)
async function expectCurrent(steps, index) {
  for (let i = 0; i < STEPS.length; i += 1) {
    if (i === index) await expect(steps.nth(i)).toHaveAttribute('aria-current', 'step');
    else await expect(steps.nth(i)).not.toHaveAttribute('aria-current');
  }
}

function lastRun(page) {
  return page.getByRole('list', { name: '作る会話' }).locator('> li.run').last();
}

test('U2、U7: 最初の画面の案内から、試す → 言葉で直す → 直った結果を試す、までが通り、手順が状態で進む', async ({ page, home }) => {
  test.skip(process.platform === 'win32', '偽の claude をシェルスクリプトで作るため');
  // 直す AI の依頼(作るループの関門を含む)を 1 回終えるまで待つ
  test.setTimeout(120_000);
  const studio = await launchStudio(home, { env: { STUDIO_AGENT: undefined, STUDIO_CLAUDE_BIN: await writeFakeClaude(home) } });
  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(studio.url);
    const app = page.frameLocator('iframe[title="試作品"]');
    const log = app.getByRole('region', { name: '会話' }).getByRole('listitem');
    const message = app.getByLabel('メッセージ');
    const make = page.getByRole('region', { name: '言葉で直す' });
    const bar = page.getByRole('region', { name: '試し直す' });
    const { guide, steps, hint } = guideOf(page);
    await expect(app.getByRole('heading', { name: 'しおかぜ求人相談' })).toBeVisible();

    // U2: 1 行の説明と 3 つの手順。1 番目が今の手順
    await expect(guide).toBeVisible();
    await expect(guide).toContainText(LEAD);
    await expect(steps).toHaveText(STEPS);
    await expectCurrent(steps, 0);
    await expect(hint).toHaveText('まず左の試作品で、案内役に話しかけてみましょう。');
    await expect(bar).toBeHidden();
    await expectNoDevWords(guide);
    await page.screenshot({ path: path.join(UX_SHOTS, 'P28-first.png') });

    // 1. 試す: 例の文を送ると、返事が来て、手順 2 が今の手順になる
    await message.fill(EXAMPLE);
    await app.getByRole('button', { name: '送る' }).click();
    await expect(log).toHaveCount(3);
    await expect(log.last()).toContainText(BEFORE);
    await expectCurrent(steps, 1);
    await expect(steps.nth(0)).toHaveAttribute('data-state', 'done');
    await expect(hint).toHaveText('気になったところを、右の「言葉で直す」に頼んでみましょう。押すと入る例もあります。');
    await expectNoDevWords(guide);
    await page.screenshot({ path: path.join(UX_SHOTS, 'P28-talked.png') });

    // 2. 言葉で直す: 直す欄の例を押して送る → 同意のカード → 同意 → 直す AI が直す
    await make.getByRole('list', { name: '直し方の例' }).getByRole('button', { name: '時給の下限を先に聞くようにして' }).click();
    await make.getByRole('button', { name: '送る' }).click();
    const card = page.getByRole('group', { name: '本物の AI を使う前に' });
    await expect(card).toBeVisible();
    await expectCurrent(steps, 1);
    await card.getByRole('button', { name: '同意して使う' }).click();
    const run = lastRun(page);
    await expect(run.getByText('AI の設定を読みました')).toBeVisible({ timeout: 15_000 });
    await expect(run.locator('.run-status')).toHaveText('直す AI が作業しています…');
    await expect(hint).toHaveText('直す AI が直しています。終わると、試作品が新しくなります。');
    await expectCurrent(steps, 1);
    await page.screenshot({ path: path.join(UX_SHOTS, 'P28-fixing.png') });

    // 直す AI が終わり、結果の帯が出る。手順 3 が今の手順になり、試し直しの帯が試す欄の上に出る
    const band = run.getByRole('group', { name: '確かめた結果' });
    await expect(band).toBeVisible({ timeout: 60_000 });
    await expect(band).toHaveAttribute('data-status', /^(passed|fixed|unverified)$/);
    await expect(run.locator('.run-updated')).toHaveText('AI の設定を変えました。試作品は新しくなっています。');
    await expectCurrent(steps, 2);
    await expect(steps.nth(1)).toHaveAttribute('data-state', 'done');
    await expect(hint).toHaveText('試作品の上の「同じ発言で試し直す」で、直す前と後の返事を比べられます。');
    await expect(bar.getByRole('heading', { name: 'AI の設定が変わりました' })).toBeVisible();
    await expect(bar).toContainText('会話は新しい設定で最初から始まっています。前の会話(発言 1 件)を、新しい設定で送り直せます。');
    // お試しの AI なので、本物の AI を使う回数は出ない
    await expect(bar.locator('.retry-cost')).toHaveCount(0);
    // 試し直しの帯は、試作品より上にある
    expect((await bar.boundingBox()).y).toBeLessThan((await page.locator('#frame-host').boundingBox()).y);

    // 3. 直った結果を試す: 「同じ発言で試し直す」で、直す前と後の返事が帯の中に出る
    await bar.getByRole('button', { name: '同じ発言で試し直す' }).click();
    const comparison = bar.getByRole('region', { name: '直す前と後の返事' });
    await expect(comparison).toBeVisible();
    const reply = comparison.getByRole('listitem');
    await expect(reply).toHaveCount(1);
    await expect(reply).toContainText(`あなた: ${EXAMPLE}`);
    await expect(reply.locator('.retry-before')).toContainText(BEFORE);
    await expect(reply.locator('.retry-after')).toContainText(AFTER);
    await expect(reply).toContainText('変わりました');
    await expect(log.last()).toContainText(AFTER);
    await expectCurrent(steps, -1);
    await expect(steps.nth(2)).toHaveAttribute('data-state', 'done');
    await expect(hint).toHaveText('3 つの手順が終わりました。ほかにも気になるところがあれば、言葉で直せます。');
    await expectNoDevWords(guide);
    await expectNoDevWords(bar);
    await expectReadableText(page, 'はじめの手順の最後');
    await page.screenshot({ path: path.join(UX_SHOTS, 'P28-fixed.png') });

    // 試し直しの結果は、開発者向けの詳細には残さない(帯へ移した)
    await expect(page.locator('#ai-status')).not.toContainText('試し直しの結果');

    // 本物の AI を選んでいるときは、試し直しのボタンの横に、本物の AI を使う回数を出す(同意は直す欄で済んでいる)
    await switchToRealAi(page);
    await expect(bar.locator('.retry-cost')).toHaveText('発言 1 回分、本物の AI を使います');
    await expectNoDevWords(bar);
  } finally {
    await studio.stop();
  }
});

test('案内は「閉じる」で隠れ、読み込み直しても隠れたまま。Studio を起動し直すと、また出る', async ({ page, home }) => {
  test.setTimeout(60_000);
  let studio = await launchStudio(home);
  try {
    await page.goto(studio.url);
    const { guide } = guideOf(page);
    await expect(guide).toBeVisible();
    await guide.getByRole('button', { name: '閉じる' }).click();
    await expect(guide).toBeHidden();
    await expect.poll(async () => (await studio.api('/api/projects')).firstSteps).toEqual({ dismissed: true });

    // 読み込み直しても、隠れたまま(閉じたことは Studio が覚える)
    await page.reload();
    await expect(page.frameLocator('iframe[title="試作品"]').getByRole('heading', { name: 'しおかぜ求人相談' })).toBeVisible();
    await page.waitForResponse((response) => response.url().endsWith('/api/projects'));
    await expect(guide).toBeHidden();
  } finally {
    await studio.stop();
  }

  // 起動し直すと、閉じたことは消え、案内がまた出る
  studio = await launchStudio(home);
  try {
    await page.goto(studio.url);
    const { guide, steps } = guideOf(page);
    await expect(guide).toBeVisible();
    await expectCurrent(steps, 0);
  } finally {
    await studio.stop();
  }
});

test('AI のない試作品(図書室)では、1 番が「試作品の画面を触る」になる。直しきれないと 2 番は済まず、結果を見るように言う', async ({ page, home }) => {
  // 直しきれない依頼(直すラウンドを 2 回回す)と、直せる依頼を 1 回ずつ終えるまで待つ
  test.setTimeout(120_000);
  const studio = await launchStudio(home);
  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(studio.url);
    await chooseSample(page, SAMPLES.library);
    const app = page.frameLocator('iframe[title="試作品"]');
    const heading = app.getByRole('heading', { name: 'こもれび図書室' });
    await expect(heading).toBeVisible();
    const { steps, hint } = guideOf(page);
    await expect(steps).toHaveText(['1 試作品の画面を触る', '2 言葉で直す', '3 直った結果を試す']);
    await expectCurrent(steps, 0);
    await expect(hint).toHaveText('まず左の試作品の画面を、押したり書いたりしてみましょう。');

    // 試作品の画面を触ると、1 番が済む
    await heading.click();
    await expectCurrent(steps, 1);

    // 直しきれなかった(failed)ときは、2 番を済みにせず、結果の帯を見るように言う
    const make = page.getByRole('region', { name: '言葉で直す' });
    const send = async (text) => {
      await page.getByLabel('依頼').fill(text);
      await make.getByRole('button', { name: '送る' }).click();
    };
    await send('壊して、直せないふりをして');
    await expect(lastRun(page).getByRole('group', { name: '確かめた結果' })).toHaveAttribute('data-status', 'failed', { timeout: 60_000 });
    await expectCurrent(steps, 1);
    await expect(hint).toHaveText('直す AI が直しきれませんでした。右の「言葉で直す」の結果を見て、頼み方を変えてもう一度送ってください。');
    await expect(hint).toHaveAttribute('data-tone', 'warn');

    // 直せた依頼で、2 番が済む(前の依頼が残した問題も直すので、fixed になることがある)。直った画面を触ると、3 番が済む
    await send('見出しを「ひだまり図書室」にして');
    await expect(lastRun(page).getByRole('group', { name: '確かめた結果' })).toHaveAttribute('data-status', /^(passed|fixed)$/, { timeout: 30_000 });
    await expectCurrent(steps, 2);
    await expect(hint).toHaveText('直った試作品の画面を、もう一度触ってみましょう。');
    const fixed = app.getByRole('heading', { name: 'ひだまり図書室' });
    await expect(fixed).toBeVisible();
    await fixed.click();
    await expectCurrent(steps, -1);
    await expect(page.getByRole('region', { name: '試し直す' })).toBeHidden();
  } finally {
    await studio.stop();
  }
});
