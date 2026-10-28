import fs from 'node:fs/promises';
import path from 'node:path';
import { ROOT, SAMPLES, chooseSample, expect, launchStudio, openAiMenu, test } from './studio.js';

// 本物の AI を使う前の同意のカード(docs/design/ux-redesign.md の 6 節、P25)。
// 実モデルは呼ばない。claude は偽物で、直す AI としては偽接続(src/agent/fake-claude.js)、
// 試作品の中の AI と --version、auth status には偽の CLI(test/fixtures/fake-claude.js)が答える。

// 「分かるか」の確かめ(ux-redesign.md 9 節)のスクリーンショットの置き場。test-results/ は git が無視する
const UX_SHOTS = path.join(ROOT, 'test-results', 'ux');
// 開発の言葉(U3)。カードの見える文字には出さない(「詳しく」の中は除く)
const U3_WORDS = ['偽接続', 'モック', 'ANTHROPIC_API_KEY', 'Console', 'app/ai.json', 'app/', 'ビルド', 'プロダクト内 AI', '認証の報告', 'STUDIO_', '--'];
const CARD = '本物の AI を使う前に';
const MARK = '本物の AI(あなたの Claude Code)';
const DECLINED = '言葉で直すには、本物の AI を使うことへの同意が要ります。';

// 偽の claude をシェルスクリプトで作る。試作品の中の AI の呼び出し(--json-schema)と --version、auth status は偽の CLI に、
// それ以外(直す AI)は偽接続に渡す
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
      `exec ${node} ${fixer} "$@"`,
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  return bin;
}

// 直す AI も試作品の中の AI も、偽の claude を本物として使う起動(STUDIO_AGENT を書かない既定の起動と同じ)
async function launchReal(home) {
  return launchStudio(home, { env: { STUDIO_AGENT: undefined, STUDIO_CLAUDE_BIN: await writeFakeClaude(home) } });
}

// カードの見える文字(閉じた「詳しく」の中は入らない)に、開発の言葉がない
async function expectNoDevWords(card) {
  const text = await card.innerText();
  for (const word of U3_WORDS) expect(text, `「${word}」が見えています`).not.toContain(word);
}

const runsOf = async (studio) => (await studio.api(`/api/projects/${SAMPLES.jobConsult.id}/build-requests`)).runs;
const agreed = async (studio) => (await studio.api('/api/real-ai')).consent.agreed;

test.skip(process.platform === 'win32', '偽の claude をシェルスクリプトで作るため');

test('直す欄の初回の送信でカードが出る。やめると送らず、同意すると送る。2 回目と「AI: 本物」ではカードが出ない', async ({ page, home }) => {
  // 直す AI の依頼を 2 回終えるまで待つ
  test.setTimeout(90_000);
  const studio = await launchReal(home);
  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(studio.url);
    const app = page.frameLocator('iframe[title="試作品"]');
    await expect(app.getByRole('heading', { name: 'しおかぜ求人相談' })).toBeVisible();
    const make = page.getByRole('region', { name: '言葉で直す' });
    const request = page.getByLabel('依頼');
    const card = page.getByRole('group', { name: CARD });
    // 同意の前は、本物の AI を使っている印は出ない
    await expect(page.getByRole('button', { name: MARK })).toHaveCount(0);

    // 初回の送信でカードが出る。依頼の文は欄に残り、まだ送らない
    await make.getByRole('list', { name: '直し方の例' }).getByRole('button', { name: '時給の下限を先に聞くようにして' }).click();
    await make.getByRole('button', { name: '送る' }).click();
    await expect(card).toBeVisible();
    await expect(card).toHaveCount(1);
    await expect(request).toHaveValue('時給の下限を先に聞くようにして');
    expect(await runsOf(studio)).toEqual([]);
    expect(await agreed(studio)).toBe(false);
    // 送るもの、送り先、料金
    await expect(card).toContainText('AI は、あなたの Claude Code で動きます。');
    await expect(card.getByRole('list', { name: '送るもの' })).toContainText('頼んだ文と試作品のファイル(言葉で直すとき)');
    await expect(card.getByRole('list', { name: '送るもの' })).toContainText('試作品の中の会話と AI の設定(本物の AI と話すとき)');
    await expect(card.getByRole('definition').nth(2)).toHaveText('Anthropic(Claude を作っている会社)');
    await expect(card.getByRole('definition').nth(3)).toHaveText('Claude のアカウントでログインしているので、そのプランの利用枠を使います。');
    await expect(card).toContainText('架空のデータだけで試してください。');
    await expectNoDevWords(card);
    await page.screenshot({ path: path.join(UX_SHOTS, 'P25-card.png') });

    // 「詳しく」を開くと、AI への指示の全文、1 回の上限、記録の扱いが見える
    await card.getByText('詳しく(AI への指示の全文、1 回の上限、記録の扱い)').click();
    await expect(card.getByRole('list', { name: '言葉で直すときに送るもの' })).toContainText('頼んだ文');
    await expect(card.locator('pre').first()).toContainText('Prototype Studio の「作る AI」');
    await expect(card.getByRole('list', { name: '話すときに送るもの' })).toContainText('会話の全体');
    await expect(card.locator('pre').nth(1)).toContainText('しおかぜ求人相談');
    await expect(card).toContainText('直すときの 1 回の起動で 1 ドルの上限は、API キーなどの設定で動くときに付けます');
    await expect(card).toContainText('.studio/runs');

    // やめると送らない。同意が要ることと「確かめる」を出す。試作品の中の AI はお試しのまま
    await card.getByRole('button', { name: 'やめる' }).click();
    await expect(card).toHaveCount(0);
    const declined = make.locator('.consent-declined');
    await expect(declined).toContainText(DECLINED);
    await expect(request).toHaveValue('時給の下限を先に聞くようにして');
    expect(await runsOf(studio)).toEqual([]);
    expect(await agreed(studio)).toBe(false);
    await expect(page.locator('#ai-badge')).toHaveText('AI: モック');
    await expect(page.getByRole('button', { name: MARK })).toHaveCount(0);

    // 「確かめる」でカードをもう一度見られる。同意しても、送るを押すまで送らない
    await declined.getByRole('button', { name: '確かめる' }).click();
    await expect(card).toBeVisible();
    await expect(declined).toHaveCount(0);
    await card.getByRole('button', { name: 'やめる' }).click();
    await expect(declined).toBeVisible();

    // もう一度送ると、カードが出る。同意すると、欄の依頼が送られる
    await make.getByRole('button', { name: '送る' }).click();
    await expect(card).toBeVisible();
    await card.getByRole('button', { name: '同意して使う' }).click();
    await expect(card).toHaveCount(0);
    await expect(declined).toHaveCount(0);
    const run = make.getByRole('list', { name: '作る会話' }).locator('> li.run').last();
    await expect(run.locator('.bubble.user')).toContainText('時給の下限を先に聞くようにして');
    await expect(run.locator('.run-updated')).toHaveText('AI の設定を変えました。試作品は新しくなっています。', { timeout: 20_000 });
    await expect(request).toHaveValue('');
    expect(await agreed(studio)).toBe(true);
    expect(await runsOf(studio)).toHaveLength(1);

    // 本物の AI を使っている間は、直す欄の上に小さな印が出る。押すとカードの中身をもう一度見られる
    const makeMark = make.getByRole('button', { name: MARK });
    await expect(makeMark).toBeVisible();
    await makeMark.click();
    await expect(makeMark).toHaveAttribute('aria-expanded', 'true');
    const info = make.getByRole('group', { name: MARK });
    await expect(info).toContainText('に同意しました。Studio を止めるまで有効です。');
    await expect(info).toContainText('Anthropic(Claude を作っている会社)');
    await expect(info.getByRole('button', { name: '同意して使う' })).toHaveCount(0);
    await expectNoDevWords(info);
    await page.screenshot({ path: path.join(UX_SHOTS, 'P25-mark.png') });
    await info.getByRole('button', { name: '閉じる' }).click();
    await expect(info).toHaveCount(0);

    // 2 回目の送信では、カードは出ない
    await request.fill('案内役の話し方を、もっとやわらかくして');
    await make.getByRole('button', { name: '送る' }).click();
    await expect(make.getByRole('list', { name: '作る会話' }).locator('> li.run')).toHaveCount(2);
    await expect(card).toHaveCount(0);
    await expect(make.getByRole('list', { name: '作る会話' }).locator('> li.run').last().locator('.run-status')).not.toHaveText('直す AI が作業しています…', {
      timeout: 20_000,
    });

    // 直す欄で同意した後は、「AI: 本物」を選んでもカードが出ず、すぐ切り替わる。試す欄の上にも印が出る
    await openAiMenu(page);
    await page.getByRole('radio', { name: 'Claude Code' }).click();
    await expect(page.locator('#ai-badge')).toHaveText('AI: Claude Code');
    await expect(card).toHaveCount(0);
    const tryMark = page.locator('#try-toolbar').getByRole('button', { name: MARK });
    await expect(tryMark).toBeVisible();
    await tryMark.click();
    const tryInfo = page.getByRole('region', { name: '試す' }).getByRole('group', { name: MARK });
    await expect(tryInfo).toContainText('試作品の中の会話と AI の設定(本物の AI と話すとき)');
    // 「詳しく」に、前の確認の中身(試作品の中の AI の費用と回数の制限)がある
    await tryInfo.getByText('詳しく(AI への指示の全文、1 回の上限、記録の扱い)').click();
    await expect(tryInfo).toContainText('費用: Claude Code にログインしているアカウント');
    await expect(tryInfo).toContainText('回数の制限: 1 ターンで 4 回まで呼びます。');

    // 読み込み直しても、同意は Studio を止めるまで続く
    await page.reload();
    await expect(page.locator('#real-ai-make')).toBeVisible();
  } finally {
    await studio.stop();
  }
});

test('「AI: 本物」を選ぶとカードが出る。やめるとお試しのまま。同意すると切り替わり、直す欄の送信でもカードが出ない', async ({ page, home }) => {
  const studio = await launchReal(home);
  try {
    await page.goto(studio.url);
    await chooseSample(page, SAMPLES.jobConsult);
    const make = page.getByRole('region', { name: '言葉で直す' });
    const card = page.getByRole('group', { name: CARD });

    await openAiMenu(page);
    await page.getByRole('radio', { name: 'Claude Code' }).check();
    // カードは試す欄の上に 1 枚だけ出る。AI の切り替えは閉じる
    await expect(page.getByRole('region', { name: '試す' }).getByRole('group', { name: CARD })).toBeVisible();
    await expect(card).toHaveCount(1);
    await expect(page.locator('#ai-menu')).toBeHidden();
    await expect(page.locator('#ai-badge')).toHaveText('AI: モック');
    await expectNoDevWords(card);
    // 前の確認(印を付けて切り替える)は出ない
    await expect(page.getByRole('checkbox')).toHaveCount(0);

    // やめると、お試しのまま。同意もしない。直す欄に同意が要るとは出さない
    await card.getByRole('button', { name: 'やめる' }).click();
    await expect(card).toHaveCount(0);
    await expect(page.locator('#ai-badge')).toHaveText('AI: モック');
    expect(await agreed(studio)).toBe(false);
    await expect(make).not.toContainText(DECLINED);

    // 直す欄の送信でカードを出してから「AI: 本物」を選ぶと、カードは試す欄の 1 枚に入れ替わる(重ねない)
    await page.getByLabel('依頼').fill('時給の下限を先に聞くようにして');
    await make.getByRole('button', { name: '送る' }).click();
    await expect(make.getByRole('group', { name: CARD })).toBeVisible();
    await openAiMenu(page);
    await page.getByRole('radio', { name: 'Claude Code' }).check();
    await expect(page.getByRole('region', { name: '試す' }).getByRole('group', { name: CARD })).toBeVisible();
    await expect(card).toHaveCount(1);
    await expect(page.getByLabel('依頼')).toHaveValue('時給の下限を先に聞くようにして');

    // 同意すると切り替わる
    await card.getByRole('button', { name: '同意して使う' }).click();
    await expect(page.locator('#ai-badge')).toHaveText('AI: Claude Code');
    await expect(card).toHaveCount(0);
    expect(await agreed(studio)).toBe(true);
    await expect(page.locator('#try-toolbar').getByRole('button', { name: MARK })).toBeVisible();
    await expect(make.getByRole('button', { name: MARK })).toBeVisible();
    expect(await runsOf(studio)).toEqual([]);

    // 同意は直す欄にも効く。送ってもカードは出ない
    await make.getByRole('button', { name: '送る' }).click();
    await expect(make.getByRole('list', { name: '作る会話' }).locator('> li.run')).toHaveCount(1);
    await expect(card).toHaveCount(0);
  } finally {
    await studio.stop();
  }
});

test('Claude Code が見つからないときは、「AI: 本物」を選べない理由を直す欄の使えないときのカードと同じ 1 文で出す。場所は開発者向けの中だけ', async ({ page, home }) => {
  const missing = path.join(home, 'no-such-claude');
  const studio = await launchStudio(home, { env: { STUDIO_CLAUDE_BIN: missing } });
  try {
    await page.goto(studio.url);
    await chooseSample(page, SAMPLES.jobConsult);
    await openAiMenu(page);
    const menu = page.locator('#ai-menu');
    await expect(page.getByRole('radio', { name: 'Claude Code' })).toBeDisabled();
    await expect(menu).toContainText('この PC で Claude Code が見つかりません。');
    for (const word of ['STUDIO_', missing]) expect(await menu.innerText()).not.toContain(word);
    await menu.getByText('開発者向け: 確かめた結果').click();
    await expect(menu).toContainText(missing);
  } finally {
    await studio.stop();
  }
});

test('同意を送っている間は「やめる」を押せない。同意の後は、欄の依頼を 1 回だけ送る', async ({ page, home }) => {
  const studio = await launchReal(home);
  try {
    // 同意の応答を遅らせ、その間の画面を確かめる
    let release;
    const held = new Promise((resolve) => (release = resolve));
    await page.route('**/api/real-ai/consent', async (route) => {
      await held;
      await route.continue();
    });
    await page.goto(studio.url);
    await chooseSample(page, SAMPLES.jobConsult);
    const make = page.getByRole('region', { name: '言葉で直す' });
    const card = page.getByRole('group', { name: CARD });
    await page.getByLabel('依頼').fill('時給の下限を先に聞くようにして');
    await make.getByRole('button', { name: '送る' }).click();
    await card.getByRole('button', { name: '同意して使う' }).click();
    await expect(card.getByRole('button', { name: '同意して使う' })).toBeDisabled();
    await expect(card.getByRole('button', { name: 'やめる' })).toBeDisabled();
    release();
    await expect(card).toHaveCount(0);
    await expect(make.getByRole('list', { name: '作る会話' }).locator('> li.run')).toHaveCount(1);
    expect(await agreed(studio)).toBe(true);
    expect(await runsOf(studio)).toHaveLength(1);
  } finally {
    await studio.stop();
  }
});
