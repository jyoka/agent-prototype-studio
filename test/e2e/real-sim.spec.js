import fs from 'node:fs/promises';
import path from 'node:path';
import { SAMPLES, chooseSample, expect, launchStudio, openDevDetails, switchToRealAi, test } from './studio.js';

// 構成 A を実モデルで通す(docs/design/agent-simulation.md の sim-7。S10、S13、S19、S22)。
// 見本のバイト探しの模擬のエージェントを、本人のログインの Claude Code に切り替えて 1 回話し、
// 記録に、参加者、ツールの呼び出し(引数と結果)、守りの判定、費用、待ち時間が残ることを見る。
// 実モデルを呼んで費用がかかるので、STUDIO_REAL=1 のときだけ動く。ふだんは飛ばし、飛ばしたことを出力に出す。
//   STUDIO_REAL=1 npx playwright test test/e2e/real-sim.spec.js
// 起動は 1 回の発言で 1 回(形が崩れたときのやり直しで 2 回まで)。1 回の起動の費用の上限は 0.2 USD(--max-budget-usd)。
// STUDIO_REAL_EVIDENCE=<フォルダー>(記録は docs/evidence/sim-a/)を足すと、Studio の画面のスクリーンショットをそこにも置く
const REAL = process.env.STUDIO_REAL === '1';
const SKIP_REASON = '実モデル(Claude Code)を呼ぶので、STUDIO_REAL=1 のときだけ動きます';
const REPLY_TIMEOUT_MS = 3 * 60_000;
const SAY = 'みなと町で土日に働きたい';

if (!REAL) console.log(`real-sim.spec.js を飛ばしました: ${SKIP_REASON}`);

test.describe('構成 A を実モデルで通す', () => {
  test.skip(!REAL, SKIP_REASON);
  test.setTimeout(REPLY_TIMEOUT_MS * 2 + 60_000);

  test('バイト探しの模擬のエージェントを本物の AI にして話すと、ツールを自分で選んで呼び、記録に守りの判定と費用と待ち時間が残る', async ({ page, home }, testInfo) => {
    // 作る AI は偽接続のまま。本物を呼ぶのは、試作品の中の AI(模擬のエージェント)だけ
    const studio = await launchStudio(home, { real: true });
    const shots = [];
    const shoot = async (name) => {
      const file = testInfo.outputPath(`${name}.png`);
      await page.screenshot({ path: file, fullPage: true });
      shots.push(file);
    };
    try {
      await page.goto(studio.url);
      await chooseSample(page, SAMPLES.partTime);
      const app = page.frameLocator('iframe[title="試作品"]');
      const talk = app.getByRole('region', { name: '会話' });
      const items = talk.getByRole('list', { name: 'やりとり' }).locator(':scope > li');
      await switchToRealAi(page);
      await expect(talk).toContainText('いまの案内役は本物の AI');

      await app.getByLabel('メッセージ').fill(SAY);
      await app.getByRole('button', { name: '送る' }).click();
      await expect(items).toHaveCount(2, { timeout: REPLY_TIMEOUT_MS });
      await expect(items.last()).toContainText('本物の AI');
      await shoot('1-real-reply');

      // 記録(伏せた sim-turn): 参加者、接続、費用と待ち時間、ツールの呼び出しの引数と結果、守りの層と判定
      const { entries } = await studio.api(`/api/projects/${SAMPLES.partTime.id}/ai/trace`);
      const turn = entries.find((entry) => entry.kind === 'sim-turn');
      expect(turn).toBeTruthy();
      expect(turn.assumptions).toMatchObject({ id: 'partner-a', standIn: true });
      const agent = turn.steps.find((step) => step.kind === 'agent');
      expect(agent).toMatchObject({ participant: 'partner', connection: 'claude-code', real: true });
      expect(agent.costUsd).toBeGreaterThan(0);
      expect(agent.ms).toBeGreaterThan(0);
      // 起動は、決まった引数(組み込みの道具なし、許した名前だけ)で行った(S10、S13)
      expect(agent.command).toEqual(expect.arrayContaining(['--restricted', '--tools', '--strict-mcp-config', '--allowedTools']));
      expect(agent.command[agent.command.indexOf('--tools') + 1]).toBe('');
      const tools = turn.steps.filter((step) => step.tool);
      expect(tools.map((step) => step.tool)).toContain('search_jobs');
      for (const step of tools) {
        expect(step.by).toBe('partner');
        expect(step.result).toHaveProperty('ok');
        // ツールの守りの判定が、層と持ち主つきで残る(S22)
        expect(step.guards.length).toBeGreaterThan(0);
        for (const guard of step.guards) expect(guard).toMatchObject({ layer: expect.any(String), guard: expect.any(String), effect: expect.any(String) });
      }
      const output = turn.steps.find((step) => step.output);
      expect(output.guards).toEqual(expect.arrayContaining([expect.objectContaining({ layer: 'output', guard: 'facts-from-tools' })]));

      // 開発者向けの詳細にも、同じ記録が出る
      await openDevDetails(page);
      const entry = page.locator('#ai-trace').getByRole('list', { name: 'AI の実行の記録' }).locator(':scope > li').first();
      await entry.getByText('模擬の会話の中身: 参加者、ツール、守り(開発向け)').click();
      const steps = entry.getByRole('list', { name: '模擬の会話の段' }).locator(':scope > li');
      await expect(steps.filter({ hasText: '接続 claude-code(実際の AI モデル)' })).toHaveCount(1);
      await expect(steps.filter({ hasText: 'ツール search_jobs' }).first()).toContainText('そよかぜの案内役(模擬)(partner) が呼びました');
      await shoot('2-trace');

      const outcome = `起動の待ち時間 ${(agent.ms / 1000).toFixed(1)} 秒、費用 ${agent.costUsd} USD、ツール ${tools.map((step) => `${step.tool}(${step.result.ok ? '成功' : '失敗'})`).join('、')}`;
      testInfo.annotations.push({ type: '結果', description: outcome });
      console.log(`real-sim の結果: ${outcome}`);
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
