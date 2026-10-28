import fs from 'node:fs/promises';
import path from 'node:path';
import { REQUEST } from '../../scripts/real-loop-record.js';
import { ROOT, expect, launchStudio, test } from './studio.js';

// 実モデルの閉じたループ(jyoka/tasks#314、docs/design/harness.md の S1、S12)。本人のログインの Claude Code を、作る欄から呼ぶ。
// 実モデルを呼んで費用がかかるので、STUDIO_REAL=1 のときだけ動く。ふだんは飛ばし、飛ばしたことを出力に出す。
//   STUDIO_REAL=1 npx playwright test test/e2e/real-loop.spec.js
// STUDIO_REAL_EVIDENCE=<フォルダー>(記録は docs/evidence/real-loop-e2e/)を足すと、Studio の画面のスクリーンショットをそこにも置く
const REAL = process.env.STUDIO_REAL === '1';
const SKIP_REASON = '実モデル(Claude Code)を呼ぶので、STUDIO_REAL=1 のときだけ動きます';
const FIXTURE = path.join(ROOT, 'test', 'fixtures', 'loop-broken', 'app');
const PROJECT = 'loop-broken';
const TITLE = '確かめ用: 壊れた学習相談(架空)';
// 作る AI の起動は 3 回まで、1 回 10 分。関門の時間を足す
const RUN_TIMEOUT_MS = 35 * 60_000;

if (!REAL) console.log(`real-loop.spec.js を飛ばしました: ${SKIP_REASON}`);

test.describe('実モデルの閉じたループ', () => {
  test.skip(!REAL, SKIP_REASON);
  test.setTimeout(RUN_TIMEOUT_MS + 5 * 60_000);

  test('狭い画面で落ちる見本に関係のない依頼を送ると、関門の失敗が作る AI に返り、fixed か、起動 3 回までの failed で終わる', async ({ page, home }, testInfo) => {
    const root = path.join(home, 'projects', PROJECT);
    await fs.cp(FIXTURE, path.join(root, 'app'), { recursive: true });
    await fs.mkdir(path.join(root, '.studio'), { recursive: true });
    await fs.writeFile(path.join(root, '.studio', 'project.json'), JSON.stringify({ title: TITLE }));

    const studio = await launchStudio(home, { env: { STUDIO_AGENT: 'claude' } });
    const shots = [];
    const shoot = async (name) => {
      const file = testInfo.outputPath(`${name}.png`);
      await page.screenshot({ path: file, fullPage: true });
      shots.push(file);
    };
    try {
      await page.goto(studio.url);
      await page.getByRole('button', { name: new RegExp(TITLE.replace(/[()]/g, '\\$&')) }).click();
      const app = page.frameLocator('iframe[title="試作品"]');
      // 試す欄の幅は狭いので、依頼の前の見本は試す画面でも落ちている(見出しは出ない)
      await expect(page.getByRole('region', { name: TITLE })).toBeVisible();

      await page.getByLabel('依頼').fill(REQUEST);
      await page.getByRole('button', { name: '送る' }).click();
      const run = page.getByRole('list', { name: '作る会話' }).locator('> li.run').last();
      // 1 回目の関門の失敗(G5 か G6)が、作る会話に出る
      await expect(run.locator('[data-kind="launch-failed"], [data-kind="scenarios-failed"]').first()).toBeVisible({ timeout: RUN_TIMEOUT_MS });
      await shoot('1-gate-failed');
      await expect(run.locator('[data-kind="fix-request"]').first()).toBeVisible({ timeout: RUN_TIMEOUT_MS });
      await expect(run.locator('.run-status')).toHaveText(/終わりました|失敗しました/, { timeout: RUN_TIMEOUT_MS });
      await shoot('2-run-finished');

      const { runs } = await studio.api(`/api/projects/${PROJECT}/build-requests`);
      const last = runs.at(-1);
      const record = JSON.parse(await fs.readFile(path.join(root, last.evidence.run), 'utf8'));
      const failedFirst = record.rounds[0].gates.filter((gate) => gate.status === 'failed').map((gate) => gate.id);
      const outcome = `${record.status}、起動 ${record.agentLaunches.count} 回、1 回目に失敗した関門 ${failedFirst.join('、')}、作る AI の費用 ${record.agentLaunches.costUsd ?? '不明'} USD`;
      testInfo.annotations.push({ type: '結果', description: outcome });
      console.log(`real-loop の結果: ${outcome}`);
      expect(failedFirst.some((id) => id === 'G5' || id === 'G6')).toBe(true);
      expect(record.rounds[1]?.input).toBe('fix');
      expect(['fixed', 'failed']).toContain(record.status);
      expect(record.agentLaunches.count).toBeLessThanOrEqual(3);
      if (record.status === 'fixed') {
        expect(record.gates.every((gate) => gate.status === 'passed')).toBe(true);
        // 試す画面は直した版で、見出しが変わっている
        await expect(app.getByRole('heading', { name: 'あおぞら学びの相談室' })).toBeVisible();
      } else {
        await expect(run.locator('[data-kind="gave-up"]')).toBeVisible();
      }
      for (const report of record.reports) await fs.access(path.join(root, report.file));
    } finally {
      if (process.env.STUDIO_REAL_EVIDENCE) {
        const dir = path.resolve(process.env.STUDIO_REAL_EVIDENCE);
        await fs.mkdir(dir, { recursive: true });
        for (const file of shots) await fs.copyFile(file, path.join(dir, `studio-${path.basename(file)}`));
      }
      await studio.stop();
    }
  });
});
