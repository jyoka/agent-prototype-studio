import fs from 'node:fs/promises';
import path from 'node:path';
import { SAMPLES, chooseSample, chooseTestRequest, expect, launchStudio, test } from './studio.js';

// 作るループを閉じる(docs/design/harness.md の 2.1〜2.4、S1、S12)。作る AI は決定的な偽接続
// (src/agent/fake-claude.js)で、モデルも外部の API も呼ばない。関門 G5 と G6 は Studio の観察器(Playwright の Chromium)

// 開発者向けの詳細の「試験用の依頼」から選んで送る
async function sendRequest(page, text) {
  await chooseTestRequest(page, text);
  await page.getByRole('button', { name: '送る' }).click();
}

function lastRun(page) {
  return page.getByRole('list', { name: '作る会話' }).locator('> li.run').last();
}

test('壊れる依頼でも、Studio が失敗を直す依頼にして返し、作る AI が直して fixed になる', async ({ page, home }) => {
  const studio = await launchStudio(home);
  try {
    await page.goto(studio.url);
    await chooseSample(page, SAMPLES.library);
    const app = page.frameLocator('iframe[title="試作品"]');
    await expect(app.getByRole('heading', { name: 'こもれび図書室' })).toBeVisible();

    await sendRequest(page, '壊して');
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
    await expect(run.locator('[data-kind="gates"]')).toHaveText(/Studio が確かめた結果\(直すラウンド 1 の後\): .*G4 ビルド: 通った、GE 場面: 通った\(場面なし\)、G5 起動の確認: 通った/);
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
    expect(record.reports).toEqual([
      { gate: 'G5', round: 2, file: `.studio/runs/${last.id}/rounds/2/report.json` },
      { gate: 'G6', round: 2, file: `.studio/runs/${last.id}/rounds/2/scenarios/report.json` },
    ]);
    for (const report of record.reports) await fs.access(path.join(home, 'projects', 'sample-library', report.file));
  } finally {
    await studio.stop();
  }
});

test('直せない作る AI は、起動 3 回で止まり、失敗と証拠を人に返す', async ({ page, home }) => {
  const studio = await launchStudio(home);
  try {
    await page.goto(studio.url);
    await chooseSample(page, SAMPLES.library);
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

test('シナリオの関門 G6 の失敗を直す依頼にして返し、作る AI が直して fixed になる', async ({ page, home }) => {
  // 起動の確認(G5)とシナリオ(G6)を、直す前と直した後の 2 回ずつ観察器で回す
  test.setTimeout(90_000);
  const studio = await launchStudio(home);
  try {
    await page.goto(studio.url);
    await chooseSample(page, SAMPLES.library);
    const app = page.frameLocator('iframe[title="試作品"]');
    await expect(app.getByRole('heading', { name: 'こもれび図書室' })).toBeVisible();

    await sendRequest(page, 'シナリオを足して、見出しを崩して');
    const run = lastRun(page);
    await expect(run.locator('.run-status')).toContainText('作る AI が直すラウンドで直し、Studio が確かめた関門は、すべて通りました', { timeout: 60_000 });

    // 作る会話に、G6 の失敗、直す依頼、直した後の G6 の結果が出る
    await expect(run.locator('[data-kind="scenarios-failed"]')).toContainText('確かめで失敗あり: シナリオ「見出しが出る」の 1 番目の手順で失敗しました');
    await expect(run.locator('[data-kind="scenarios-failed"] .who')).toHaveText('シナリオ');
    await expect(run.locator('[data-kind="fix-request"]')).toContainText('G6 シナリオの失敗(シナリオ「見出しが出る」(app/scenarios/heading.json)の 1 番目の手順で失敗しました)');
    await expect(run.locator('.bubble.agent').filter({ hasText: '失敗した関門: G6 シナリオ' })).toBeVisible();
    await expect(run.locator('[data-kind="scenarios-ok"]')).toContainText('基本のシナリオ 1 本と、app/ のシナリオ 1 本が、すべて通りました(プロダクト内 AI はモック)');
    await expect(run.locator('[data-kind="gates"]')).toHaveText(/Studio が確かめた結果\(直すラウンド 1 の後\): .*G5 起動の確認: 通った、G6 シナリオ: 通った$/);
    // 直すラウンドで変わったのは見出しだけ。シナリオは変わっていない
    await expect(run.locator('[data-kind="scenarios-changed"]')).toHaveCount(0);

    // 試す画面は直した版で、見出しが戻っている
    await expect(app.getByRole('heading', { name: 'こもれび図書室' })).toBeVisible();
    const { runs } = await studio.api('/api/projects/sample-library/build-requests');
    expect(runs.at(-1).status).toBe('fixed');
    expect(runs.at(-1).gates.find((gate) => gate.id === 'G6').status).toBe('passed');
  } finally {
    await studio.stop();
  }
});

test('直すラウンドでシナリオを弱めて通すと、「確かめ方が変わりました」が出る', async ({ page, home }) => {
  test.setTimeout(90_000);
  const studio = await launchStudio(home);
  try {
    await page.goto(studio.url);
    await chooseSample(page, SAMPLES.library);
    await expect(page.frameLocator('iframe[title="試作品"]').getByRole('heading', { name: 'こもれび図書室' })).toBeVisible();
    await sendRequest(page, 'シナリオを足して、見出しを崩して、シナリオを弱めて直して');
    const run = lastRun(page);
    await expect(run.locator('[data-kind="scenarios-changed"]')).toHaveText(
      /確かめ方が変わりました: 直すラウンド 1 で、作る AI がシナリオを変えました\(app\/scenarios\/heading\.json\)。/,
      { timeout: 60_000 },
    );
    await expect(run.locator('[data-kind="scenarios-changed"] .who')).toHaveText('確かめ方が変わりました');
    const { runs } = await studio.api('/api/projects/sample-library/build-requests');
    const record = JSON.parse(await fs.readFile(path.join(home, 'projects', 'sample-library', runs.at(-1).evidence.run), 'utf8'));
    expect(record.scenariosChanged).toEqual([{ round: 2, files: [{ file: 'app/scenarios/heading.json', change: 'modified' }] }]);
  } finally {
    await studio.stop();
  }
});

test('作る AI が観察の道具で画面を開いて読み、その項目が作る会話に出て、run.json に回数が残る', async ({ page, home }) => {
  test.setTimeout(90_000);
  const studio = await launchStudio(home);
  try {
    await page.goto(studio.url);
    await chooseSample(page, SAMPLES.library);
    const app = page.frameLocator('iframe[title="試作品"]');
    await expect(app.getByRole('heading', { name: 'こもれび図書室' })).toBeVisible();

    // 偽接続は、--mcp-config で渡された観察の道具のサーバーを起動し、open と read_page を 1 回ずつ呼ぶ
    await sendRequest(page, '見出しを「ひだまり図書室」にして、画面で確かめて');
    const run = lastRun(page);
    await expect(run.locator('.run-status')).toContainText('すべて通りました', { timeout: 60_000 });
    // 作る会話には短い文で出し、道具の名前は実行ごとの「開発者向け」の中に出す
    const tools = run.locator('[data-kind="tool"]');
    await expect(tools.filter({ hasText: '試作品の画面を開いて確かめました' })).toHaveCount(1);
    await expect(tools.filter({ hasText: '試作品の画面を読みました' })).toHaveCount(1);
    const dev = run.locator('.run-dev li');
    await expect(dev.filter({ hasText: '観察: 開く' })).toHaveCount(1);
    await expect(dev.filter({ hasText: '観察: ページを読む' })).toHaveCount(1);
    // 観察の道具が読んだ画面は、作る AI が書き換えた後の作業中の app/
    await expect(run.locator('.bubble.agent').filter({ hasText: '観察の道具で確かめると、画面の見出しは「ひだまり図書室」でした' })).toBeVisible();
    await expect(app.getByRole('heading', { name: 'ひだまり図書室' })).toBeVisible();

    const { runs } = await studio.api('/api/projects/sample-library/build-requests');
    const last = runs.at(-1);
    expect(last.status).toBe('passed');
    const record = JSON.parse(await fs.readFile(path.join(home, 'projects', 'sample-library', last.evidence.run), 'utf8'));
    expect(record.toolCalls).toEqual({
      count: 4,
      observe: 2,
      byTool: { Read: 1, Edit: 1, mcp__observe__open: 1, mcp__observe__read_page: 1 },
    });
    // MCP の設定は run のフォルダーにあり、観察の道具は app/ に何も残さない
    await fs.access(path.join(home, 'projects', 'sample-library', '.studio', 'runs', last.id, 'mcp.json'));
    expect(record.changedFiles).toEqual([{ file: 'app/App.jsx', change: 'modified' }]);
  } finally {
    await studio.stop();
  }
});
