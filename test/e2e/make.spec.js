import fs from 'node:fs/promises';
import path from 'node:path';
import { SAMPLES, chooseSample, closeMore, expect, launchStudio, openDevDetails, test } from './studio.js';

// 作る欄の縦切り。作る AI は決定的な偽接続(src/agent/fake-claude.js)で、モデルも外部の API も呼ばない。

async function sendRequest(page, text) {
  await page.getByLabel('依頼').fill(text);
  await page.getByRole('button', { name: '送る' }).click();
}

function lastRun(page) {
  return page.getByRole('list', { name: '作る会話' }).locator('> li.run').last();
}

test('作る欄の依頼で試作品のファイルが変わり、試す画面に反映される', async ({ page, home }) => {
  const studio = await launchStudio(home);
  try {
    await page.goto(studio.url);
    await chooseSample(page, SAMPLES.library);
    const make = page.getByRole('region', { name: '言葉で直す' });
    // 送る前に、どの接続で、どの認証で動くかを見せる
    await expect(make.locator('#agent-status')).toContainText('接続: 偽接続');
    await expect(make.locator('#agent-status')).toContainText('Claude Code もモデルも呼ばないので、料金はかかりません');
    await expect(make.locator('#agent-status')).toContainText('ANTHROPIC_API_KEY はありません');
    await expect(make.getByRole('list', { name: '作る会話' })).toContainText('まだ依頼はありません');

    const app = page.frameLocator('iframe[title="試作品"]');
    await expect(app.getByRole('heading', { name: 'こもれび図書室' })).toBeVisible();

    // 例を押すと依頼の欄に入る
    await make.getByRole('button', { name: '見出しを「ひだまり図書室」にして', exact: true }).click();
    await expect(page.getByLabel('依頼')).toHaveValue('見出しを「ひだまり図書室」にして');
    await page.getByRole('button', { name: '送る' }).click();

    const run = lastRun(page);
    await expect(run.locator('.bubble.user')).toContainText('見出しを「ひだまり図書室」にして');
    await expect(run).toContainText('書き換える: app/App.jsx');
    await expect(run.locator('.bubble.agent')).toContainText('見出しを「ひだまり図書室」に変えました');
    await expect(run).toContainText('変わったファイル: app/App.jsx');
    await expect(run).toContainText('ビルドに成功しました。試す画面に反映しました。');
    await expect(run.locator('.run-status')).toContainText('終わりました');
    await expect(run.locator('.run-status')).toContainText('認証の報告: none');

    // 試す画面に反映される。作る会話と試す画面は別の場所にある
    await expect(app.getByRole('heading', { name: 'ひだまり図書室' })).toBeVisible();
    await expect(make.locator('iframe')).toHaveCount(0);
    const appFile = await fs.readFile(path.join(home, 'projects', 'sample-library', 'app', 'App.jsx'), 'utf8');
    expect(appFile).toContain('<h1>ひだまり図書室</h1>');
    await expect(page.getByLabel('依頼')).toHaveValue('');
    await expect(page.getByRole('button', { name: '送る' })).toBeEnabled();

    // 試した結果は、試す画面で操作できる
    await app.getByLabel('書名か著者で探す').fill('雲');
    await expect(app.getByRole('list', { name: '本の一覧' }).getByRole('listitem')).toHaveCount(1);

    // 再読み込みしても、作る会話は残る
    await page.reload();
    await chooseSample(page, SAMPLES.library);
    await expect(lastRun(page)).toContainText('ビルドに成功しました。試す画面に反映しました。');

    // ターミナルには依頼の文を出さない
    expect(studio.output()).toContain('作る AI に依頼しました: sample-library(偽接続)');
    expect(studio.output()).not.toContain('ひだまり図書室');
  } finally {
    await studio.stop();
  }
});

test('権限の確認で断られた操作と、作る AI の失敗を会話に出す。試す画面は前の版のまま', async ({ page, home }) => {
  const studio = await launchStudio(home);
  try {
    await page.goto(studio.url);
    await chooseSample(page, SAMPLES.library);
    const app = page.frameLocator('iframe[title="試作品"]');
    await expect(app.getByRole('heading', { name: 'こもれび図書室' })).toBeVisible();
    const previewSrc = await page.locator('iframe[title="試作品"]').getAttribute('src');

    // 拒否: app/ の外への書き込みは、権限の確認で断られる。
    // 偽接続の拒否なので、確かめているのは「断られたことの出し方」。実機の閉じ込めは npm run check:claude で確かめる
    await sendRequest(page, 'app/ の外にメモを書いて');
    let run = lastRun(page);
    await expect(run.locator('[data-kind="denied"]')).toContainText('権限の確認で断られました: 書く:');
    await expect(run.locator('[data-kind="denied"]')).toContainText('outside-note.txt(app/ の外)');
    await expect(run.locator('[data-kind="tool-error"]')).toContainText('許可されていません');
    await expect(run).toContainText('app/ のファイルは変わっていません。');
    await expect(run.locator('.run-status')).toContainText('終わりました');
    await expect(fs.access(path.join(home, 'projects', 'sample-library', 'outside-note.txt'))).rejects.toThrow();
    await expect(fs.access(path.join(home, 'projects', 'outside-note.txt'))).rejects.toThrow();

    // 失敗: Ctrl+Enter でも送れる
    await page.getByLabel('依頼').fill('失敗して');
    await page.getByLabel('依頼').press('Control+Enter');
    run = lastRun(page);
    await expect(run.locator('[data-kind="failed"]')).toContainText('偽接続 が失敗しました: 偽接続: 依頼どおりに失敗しました');
    await expect(run.locator('.run-status')).toContainText('失敗しました');

    // ログインしていないときは、利用者がすることを出す
    await sendRequest(page, 'ログインしていないふりをして');
    run = lastRun(page);
    await expect(run.locator('[data-kind="hint"]')).toContainText('/login でログインしてから、もう一度送ってください');

    // ここまで、試す画面は同じ版のまま
    expect(await page.locator('iframe[title="試作品"]').getAttribute('src')).toBe(previewSrc);

    // ビルドに失敗する変更は、場所を出し、前の版を表示したままにする。
    // 作る AI が直すラウンドでも直せないときの形(直せたときは make-loop.spec.js)
    await sendRequest(page, '壊して、直せないふりをして');
    run = lastRun(page);
    await expect(run.locator('[data-kind="gave-up"]')).toContainText('直すラウンドを 2 回行いましたが、G4 ビルドで失敗したままです');
    await expect(run).toContainText('変わったファイル: app/App.jsx');
    await expect(run.locator('[data-kind="build-failed"]')).toHaveCount(3);
    await expect(run.locator('[data-kind="build-failed"]').first()).toContainText('前にビルドできた版のままです');
    await expect(page.locator('#build-status')).toContainText('ビルドに失敗しました');
    await expect(page.locator('#build-status')).toContainText('app/App.jsx(2 行');
    await expect(page.locator('#build-status')).toContainText('「試す」には、前にビルドできた版を表示しています');
    await expect(app.getByRole('heading', { name: 'こもれび図書室' })).toBeVisible();

    await sendRequest(page, '直して');
    await expect(lastRun(page)).toContainText('ビルドに成功しました。試す画面に反映しました。');
    await expect(page.locator('#build-status')).toContainText('ビルドに成功しました');
    await expect(app.getByRole('heading', { name: 'こもれび図書室' })).toBeVisible();
  } finally {
    await studio.stop();
  }
});

test('作業中は中断でき、その間はほかの依頼と作り直しを待たせる', async ({ page, home }) => {
  const studio = await launchStudio(home);
  try {
    await page.goto(studio.url);
    await chooseSample(page, SAMPLES.library);
    await expect(page.locator('#connection')).toBeHidden();
    await sendRequest(page, 'ゆっくり進めて');
    const run = lastRun(page);
    await expect(run).toContainText('少しずつ進めています(1/60)');
    await expect(run.locator('.run-status')).toContainText('偽接続が作業しています');
    await expect(page.getByRole('button', { name: '送る' })).toBeDisabled();
    await expect(page.getByLabel('依頼')).toBeDisabled();
    // ファイルから作り直すは、その他 → 開発者向けの詳細にある
    await openDevDetails(page);
    await expect(page.getByRole('button', { name: 'ファイルから作り直す' })).toBeDisabled();
    await closeMore(page);

    // 同じプロジェクトでは 1 つずつ。API から送っても断る
    const second = await studio.post('/api/projects/sample-library/build-requests', { request: '見出しを「別」にして' });
    expect(second.status).toBe(409);
    expect((await studio.post('/api/projects/sample-library/builds')).status).toBe(409);

    // 再読み込みしても、作業中の様子と中断のボタンが戻る
    await page.reload();
    await chooseSample(page, SAMPLES.library);
    const menu = page.getByRole('navigation', { name: '試作品の一覧', includeHidden: true });
    await expect(menu.getByRole('button', { name: SAMPLES.library.name, includeHidden: true })).toContainText('作る AI が作業中');
    await expect(lastRun(page).locator('.run-status')).toContainText('偽接続が作業しています');
    await page.getByRole('button', { name: '中断' }).click();
    await expect(lastRun(page).locator('[data-kind="cancelled"]')).toContainText('中断しました');
    await expect(lastRun(page).locator('.run-status')).toContainText('中断しました');
    await expect(page.getByRole('button', { name: '中断' })).toBeHidden();
    await expect(page.getByRole('button', { name: '送る' })).toBeEnabled();
    const steps = await lastRun(page).locator('li').count();
    // 中断の後は、もう進まない
    await page.waitForTimeout(1500);
    expect(await lastRun(page).locator('li').count()).toBe(steps);
    const { runs } = await studio.api('/api/projects/sample-library/build-requests');
    expect(runs.at(-1).status).toBe('cancelled');
  } finally {
    await studio.stop();
  }
});

test('Claude Code に切り替えると、版と認証の見込みを送る前に出し、同じ引数で起動する', async ({ page, home }) => {
  test.skip(process.platform === 'win32', '偽の claude をシェルスクリプトで作るため');
  // 本物の代わりに置く claude。--version には版を返し、それ以外は偽接続に渡す
  const bin = path.join(home, 'bin', 'claude');
  await fs.mkdir(path.dirname(bin), { recursive: true });
  const fake = path.resolve('src/agent/fake-claude.js');
  await fs.writeFile(
    bin,
    `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "2.1.311 (Claude Code)"; exit 0; fi\nexec "${process.execPath}" "${fake}" "$@"\n`,
    { mode: 0o755 },
  );
  const studio = await launchStudio(home, {
    env: { STUDIO_AGENT: 'claude', STUDIO_CLAUDE_BIN: bin, ANTHROPIC_API_KEY: 'fictional-value-for-test' },
  });
  try {
    expect(studio.output()).not.toContain('fictional-value-for-test');
    await page.goto(studio.url);
    await chooseSample(page, SAMPLES.library);
    const status = page.locator('#agent-status');
    await expect(status).toContainText('接続: Claude Code 2.1.311');
    await expect(status).toContainText('API キー(ANTHROPIC_API_KEY)で動きます。API の料金がかかります');
    await expect(status).toContainText(bin);
    await expect(status).not.toContainText('fictional-value-for-test');
    await expect(page.locator('#examples')).toBeHidden();

    // 初めての送信は、本物の AI を使う前の同意を求める。依頼の文は欄に残り、まだ送らない
    await sendRequest(page, '見出しを「本番の形で」にして');
    const consent = page.getByRole('group', { name: '本物の AI を使う前に' });
    await expect(consent).toContainText('AI は、あなたの Claude Code で動きます。');
    await expect(consent).toContainText('料金: API キーの設定があるので、使った分だけ料金がかかります。');
    await expect(consent).toContainText('直すときは、直す AI の 1 回の起動で 1 ドルまでです');
    await expect(consent).not.toContainText('fictional-value-for-test');
    await expect(page.getByLabel('依頼')).toHaveValue('見出しを「本番の形で」にして');
    expect((await studio.api('/api/projects/sample-library/build-requests')).runs).toEqual([]);
    // やめると送らず、同意が要ることを出す
    await consent.getByRole('button', { name: 'やめる' }).click();
    await expect(consent).toBeHidden();
    await expect(page.getByRole('list', { name: '作る会話' })).toContainText('言葉で直すには、本物の AI を使うことへの同意が要ります。');
    expect((await studio.api('/api/real-ai')).consent.agreed).toBe(false);
    await page.getByRole('button', { name: '送る' }).click();
    await consent.getByRole('button', { name: '同意して送る' }).click();
    await expect(consent).toBeHidden();
    const run = lastRun(page);
    await expect(run.locator('.bubble.agent .who').first()).toHaveText('Claude Code');
    await expect(run).toContainText('ビルドに成功しました。試す画面に反映しました。');
    await expect(run.locator('.run-status')).toContainText('認証の報告: ANTHROPIC_API_KEY');
    await expect(page.frameLocator('iframe[title="試作品"]').getByRole('heading', { name: '本番の形で' })).toBeVisible();
  } finally {
    await studio.stop();
  }
});

test('Claude Code が見つからないときは、送る前に理由と次の手順を出す', async ({ page, home }) => {
  const studio = await launchStudio(home, { env: { STUDIO_AGENT: 'claude', STUDIO_CLAUDE_BIN: path.join(home, 'no-such-claude') } });
  try {
    await page.goto(studio.url);
    await chooseSample(page, SAMPLES.library);
    await expect(page.locator('#agent-status')).toContainText('claude が見つかりません');
    await expect(page.getByRole('button', { name: '送る' })).toBeDisabled();
    // 試す画面は使える
    await expect(page.frameLocator('iframe[title="試作品"]').getByRole('heading', { name: 'こもれび図書室' })).toBeVisible();
    const response = await studio.post('/api/projects/sample-library/build-requests', { request: '見出しを「x」にして' });
    expect(response.status).toBe(503);
  } finally {
    await studio.stop();
  }
});
