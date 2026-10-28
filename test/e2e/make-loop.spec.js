import fs from 'node:fs/promises';
import path from 'node:path';
import { expect, launchStudio, test } from './studio.js';

// 作るループを閉じる(docs/design/harness.md の 2.1〜2.4、S1、S12)。作る AI は決定的な偽接続
// (src/agent/fake-claude.js)で、モデルも外部の API も呼ばない。関門 G5 は Studio の観察器(Playwright の Chromium)

async function sendRequest(page, text) {
  await page.getByLabel('依頼').fill(text);
  await page.getByRole('button', { name: '送る' }).click();
}

function lastRun(page) {
  return page.getByRole('list', { name: '作る会話' }).locator('> li.run').last();
}

test('壊れる依頼でも、Studio が失敗を直す依頼にして返し、作る AI が直して fixed になる', async ({ page, home }) => {
  const studio = await launchStudio(home);
  try {
    await page.goto(studio.url);
    const app = page.frameLocator('iframe[title="試作品"]');
    await expect(app.getByRole('heading', { name: 'こもれび図書室' })).toBeVisible();

    await page.getByRole('region', { name: '作る' }).getByRole('button', { name: '壊して', exact: true }).click();
    await page.getByRole('button', { name: '送る' }).click();
    const run = lastRun(page);
    await expect(run.locator('.run-status')).toContainText('作る AI が直すラウンドで直し、Studio が確かめた関門は、すべて通りました', { timeout: 20_000 });

    // 作る会話に、ラウンドの区切りと直す依頼の要約が出る
    await expect(run.locator('[data-kind="build-failed"]')).toContainText('ビルドに失敗しました');
    await expect(run.locator('[data-kind="round"]')).toHaveText(/直すラウンド 1\/2: 作る AI を起動し直します\(起動 2\/3 回目\)。/);
    await expect(run.locator('[data-kind="round"] .who')).toHaveText('直すラウンド');
    await expect(run.locator('[data-kind="fix-request"]')).toContainText('G4 ビルドの失敗(app/App.jsx:2:');
    await expect(run.locator('[data-kind="fix-request"]')).toContainText('添えたのは、元の依頼、失敗の中身、変わったファイルの名前(1 個)だけです');
    await expect(run.locator('.bubble.agent').filter({ hasText: 'Studio の直す依頼を読みました' })).toBeVisible();
    await expect(run.locator('[data-kind="launch-ok"]')).toBeVisible();
    await expect(run.locator('[data-kind="gates"]')).toHaveText(/Studio が確かめた結果\(直すラウンド 1 の後\): .*G4 ビルド: 通った、G5 起動の確認: 通った/);
    await expect(run.locator('[data-kind="gave-up"]')).toHaveCount(0);

    // 試す画面は直した版で、ビルドは通っている
    await expect(page.locator('#build-status')).toContainText('ビルドに成功しました');
    await expect(app.getByRole('heading', { name: 'こもれび図書室' })).toBeVisible();

    // run.json に、ラウンドごとの節の列、関門の結果、report の場所、起動の回数が残る
    const { runs } = await studio.api('/api/projects/sample-library/build-requests');
    const last = runs.at(-1);
    expect(last.status).toBe('fixed');
    const record = JSON.parse(await fs.readFile(path.join(home, 'projects', 'sample-library', last.evidence.run), 'utf8'));
    expect(record.agentLaunches.count).toBe(2);
    expect(record.rounds.map((round) => round.nodes.at(-1))).toEqual(['fix', 'evidence']);
    expect(record.reports).toEqual([{ gate: 'G5', round: 2, file: `.studio/runs/${last.id}/rounds/2/report.json` }]);
    await fs.access(path.join(home, 'projects', 'sample-library', record.reports[0].file));
  } finally {
    await studio.stop();
  }
});

test('直せない作る AI は、起動 3 回で止まり、失敗と証拠を人に返す', async ({ page, home }) => {
  const studio = await launchStudio(home);
  try {
    await page.goto(studio.url);
    const app = page.frameLocator('iframe[title="試作品"]');
    await expect(app.getByRole('heading', { name: 'こもれび図書室' })).toBeVisible();

    await sendRequest(page, '壊して、直せないふりをして');
    const run = lastRun(page);
    await expect(run.locator('[data-kind="gave-up"]')).toHaveText(/直すラウンドを 2 回行いましたが、G4 ビルドで失敗したままです。ここで止めて、失敗と証拠を返します。/, { timeout: 20_000 });
    await expect(run.locator('.run-status')).toContainText('失敗しました');
    await expect(run.locator('[data-kind="round"]')).toHaveCount(2);
    await expect(run.locator('[data-kind="round"]').last()).toContainText('直すラウンド 2/2');
    await expect(page.locator('#build-status')).toContainText('ビルドに失敗しました');
    // 試す画面は、前にビルドできた版のまま
    await expect(app.getByRole('heading', { name: 'こもれび図書室' })).toBeVisible();

    const { runs } = await studio.api('/api/projects/sample-library/build-requests');
    expect(runs.at(-1).status).toBe('failed');
    expect(runs.at(-1).launches).toHaveLength(3);
  } finally {
    await studio.stop();
  }
});
