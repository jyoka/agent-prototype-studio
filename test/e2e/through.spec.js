import fs from 'node:fs/promises';
import path from 'node:path';
import { ROOT, STAGES, expect, launchStudio, test } from './studio.js';

// 段 1〜9 の通し(docs/design/ui-ux-v2.md の 8 節の「説明なしで終えられる」。UI/UX の 8 枚目)。
// 偽接続(STUDIO_AGENT=fake)で、段 1 の 1 文から段 9 の「本番開発へ渡す」までを、次の一手の帯のボタンだけで進める。
// 帯のほかに押すのは、見せる画面の「見せ終わる」だけ。見せる画面は、お客さんの前の決まり(5.4)で帯を出さないため(4.6)。
// 実モデルは呼ばない。作る AI、聞き出す AI、案を出す AI は偽接続。試作品の中の AI はお試しの AI。題材は架空

const UX_SHOTS = path.join(ROOT, 'test-results', 'ux');
const START = { STUDIO_START_SCREEN: undefined };
const STAGE_NAMES = Object.fromEntries(Object.entries(STAGES).map(([name, key]) => [key, name]));

test('偽接続で、段 1 の 1 文から段 9 の「本番開発へ渡す」まで、次の一手の帯のボタンだけで通せる。どの段でも aria-current="step" の段が 1 つ', async ({ page, home }) => {
  test.setTimeout(300_000);
  await page.setViewportSize({ width: 1280, height: 800 });
  const studio = await launchStudio(home, { env: START });
  try {
    await page.goto(studio.url);
    await expect(page.getByRole('heading', { level: 2, name: '思いつきを 1 文で書いてください' })).toBeVisible();
    const band = page.getByRole('region', { name: '次の一手' });
    // 帯の強い色のボタン(弱いボタン「止める」は数えない)
    const go = band.locator('#next-slot > button:not(.quiet)');
    const current = page.locator('#stage-list button.stage[aria-current="step"]');
    const pressed = [];
    const visited = new Set();
    const labelNow = async () => ((await go.count()) === 1 ? (await go.innerText()).trim() : null);

    for (let step = 0; step < 60; step += 1) {
      // 見せる画面は帯を出さない(5.4)。見せ終わって、操作役の画面に戻る
      if ((await page.locator('body').getAttribute('data-show')) === 'customer') {
        await page.getByRole('button', { name: '見せ終わる' }).click();
        pressed.push('(見せる画面の)見せ終わる');
        await expect(page.locator('body')).not.toHaveAttribute('data-show', 'customer');
        continue;
      }
      // AI が働いている間は、帯に強い色のボタンがない。出るまで待つ
      await expect(go, `帯のボタンが出ません(押したもの: ${pressed.join(' → ')})`).toHaveCount(1, { timeout: 120_000 });
      // 今どこにいる?: aria-current="step" の段は 1 つで、作業台の見出しと同じ名前(8 節)
      await expect(current).toHaveCount(1);
      const key = await current.getAttribute('data-stage');
      visited.add(key);
      await expect(page.locator('#bench-heading .bench-name')).toHaveText(STAGE_NAMES[key]);
      const label = await labelNow();
      pressed.push(`${STAGE_NAMES[key]}: ${label}`);
      await go.click();
      if (label === '本番開発へ渡す') break;
      // 押した後は、帯のボタンが替わるか消えるまで待つ(同じボタンを 2 度押さない)
      await expect.poll(labelNow, { timeout: 120_000, message: `「${label}」の後に帯が替わりません` }).not.toBe(label);
    }

    // 段 9 で渡した。帯のボタンだけで 9 つの段を全部通った
    const result = page.locator('#handoff-result');
    await expect(result, pressed.join(' → ')).toContainText('渡すフォルダーを作りました', { timeout: 60_000 });
    expect([...visited].sort()).toEqual(Object.values(STAGES).sort());
    await expect(page.locator('#stage-list button.stage[data-stage="handoff"]')).toHaveAttribute('data-state', 'done');
    await expect(page.locator('#stage-list button.stage[data-stage="show"]')).toHaveAttribute('data-state', 'done');
    const dir = (await result.locator('code').innerText()).trim();
    await expect(fs.readFile(path.join(dir, 'README.md'), 'utf8')).resolves.toContain('#');
    console.log(`[通し] ${pressed.length} 回: ${pressed.join(' → ')}`);
    await fs.mkdir(UX_SHOTS, { recursive: true });
    for (const theme of ['light', 'dark']) {
      await page.emulateMedia({ colorScheme: theme });
      // 色が切り替わる動き(--motion-quick)が終わるのを待つ
      await page.waitForTimeout(200);
      await page.screenshot({ path: path.join(UX_SHOTS, `through-handoff-${theme}.png`) });
    }
  } finally {
    await studio.stop();
  }
});
