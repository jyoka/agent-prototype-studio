import { expect, launchStudio, test } from './studio.js';
import {
  SCENE_VIEWPORT,
  askToSave,
  expectNoLeaks,
  expectNoLeaksInClip,
  hideDevOnlyMarks,
  openPartTime,
  reviewClip,
  scrollDrawerTo,
  searchJobs,
  showQuality,
  showReview,
  showSimChoice,
  showSimTrace,
  writeFixRequest,
} from './scenes.js';

// npm run media が撮る場面(test/e2e/scenes.js)が、今の画面で通るかを確かめる。画像は書かない。
// 画面が変わって場面が通らなくなったら、npm run media より先にここで分かる。
// どの場面でも、画面の見える文字に、日付、作業ディレクトリ、メールアドレスが出ない
for (const colorScheme of ['light', 'dark']) {
  test.describe(colorScheme, () => {
    test.use({ colorScheme, viewport: SCENE_VIEWPORT });

    test(`撮る場面(${colorScheme}): トークで探して保存を頼み、ツールの守りが止め、記録にツールの呼び出しと守りの判定が出る`, async ({ page, home }) => {
      const studio = await launchStudio(home);
      try {
        await openPartTime(page, studio);
        await hideDevOnlyMarks(page);
        // 開発用の印は撮らない。利用者の画面には出ない印
        await expect(page.locator('#dev-agent-mark')).toBeHidden();
        await searchJobs(page);
        await askToSave(page);
        await writeFixRequest(page);
        await expectNoLeaks(page, '試す画面と作る AI の欄', home);

        // 画面の地の色が、選んだ見た目(ダークとライト)に合う
        const background = await page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor);
        // ui-ux-v2.md の 10.1 の --color-bg
        expect(background).toBe(colorScheme === 'dark' ? 'rgb(15, 17, 19)' : 'rgb(244, 245, 246)');

        const choice = await showSimChoice(page);
        await expect(choice).toBeInViewport();
        await expectNoLeaks(page, '構成と前提', home);

        const { tool, blocked } = await showSimTrace(page);
        await scrollDrawerTo(tool, { block: 'center' });
        await expect(blocked).toBeInViewport();
        await expectNoLeaks(page, '模擬の会話の記録', home);
      } finally {
        await studio.stop();
      }
    });

    test(`撮る場面(${colorScheme}): 質の見直しで画面を確かめ、AI 構成の審査で 2 つを承認する。審査の撮る範囲に日付が入らない`, async ({ page, home }) => {
      test.setTimeout(120_000);
      const studio = await launchStudio(home);
      try {
        await openPartTime(page, studio);
        await hideDevOnlyMarks(page);
        await searchJobs(page);
        await askToSave(page);
        const { table } = await showQuality(page);
        await expect(table).toBeInViewport();
        await expectNoLeaks(page, '質の見直し', home);

        const review = await showReview(page, studio);
        await expect(review.getByRole('heading', { name: 'AI 構成の審査' })).toBeInViewport();
        const clip = await reviewClip(page);
        // 撮る範囲は、上の帯から欄の一覧まで。流れ図、承認の数、承認済みの印が入る
        expect(clip.height).toBeGreaterThan(400);
        await expectNoLeaksInClip(page, clip, 'AI 構成の審査', home);
      } finally {
        await studio.stop();
      }
    });
  });
}
