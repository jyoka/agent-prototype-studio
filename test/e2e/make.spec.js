import fs from 'node:fs/promises';
import path from 'node:path';
import { ROOT, SAMPLES, chooseSample, chooseTestRequest, closeMore, expect, launchStudio, openDevDetails, test } from './studio.js';

// 作る欄(言葉で直す)の縦切り。作る AI(直す AI)は決定的な偽接続(src/agent/fake-claude.js)か偽の claude で、
// モデルも外部の API も呼ばない。

// 偽の claude(test/fixtures/fake-claude.js)。--version と auth status に答える。直す AI としては使わない
const FAKE_CLAUDE = path.join(ROOT, 'test', 'fixtures', 'fake-claude.js');
// 「分かるか」の確かめ(ux-redesign.md 9 節)のスクリーンショットの置き場。test-results/ は git が無視する
const UX_SHOTS = path.join(ROOT, 'test-results', 'ux');
// 開発の言葉と試験用の依頼。利用者の画面(開発者向けの詳細を開く前)には見えない(U3、U4)
const TEST_WORDS = ['壊して', 'ゆっくり進めて', '失敗して', 'ログインしていないふりをして', 'app/ の外にメモを書いて'];

async function sendRequest(page, text) {
  await page.getByLabel('依頼').fill(text);
  await page.getByRole('button', { name: '送る' }).click();
}

// 開発者向けの詳細の「試験用の依頼」から選んで送る
async function sendTestRequest(page, text) {
  await chooseTestRequest(page, text);
  await page.getByRole('button', { name: '送る' }).click();
}

// 偽の claude をシェルスクリプトで作る。--version には version を返し、それ以外は偽接続(src/agent/fake-claude.js)に渡す。
// delay(秒)があれば、偽接続の出力を 1 行ずつ遅らせる(作業中の画面を撮るため)
async function writeFakeClaude(home, { version = '2.1.311', delay = 0 } = {}) {
  const bin = path.join(home, 'bin', 'claude');
  await fs.mkdir(path.dirname(bin), { recursive: true });
  const fake = path.join(ROOT, 'src', 'agent', 'fake-claude.js');
  const run = `"${process.execPath}" "${fake}" "$@"`;
  const body = delay
    ? `${run} | while IFS= read -r line || [ -n "$line" ]; do printf '%s\\n' "$line"; sleep ${delay}; done`
    : `exec ${run}`;
  await fs.writeFile(bin, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "${version} (Claude Code)"; exit 0; fi\n${body}\n`, { mode: 0o755 });
  return bin;
}

// 見えている文字(開いていない details の中や hidden の要素は入らない)
function visibleText(page) {
  return page.locator('body').innerText();
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
    // 偽接続は、上の帯の印だけで分かる。直す欄の上に接続と認証の長文の枠はない
    await expect(page.getByRole('banner').getByText('開発用: 偽の直す AI')).toBeVisible();
    await expect(make.locator('#make-target')).toHaveText('図書室への依頼');
    await expect(make).not.toContainText('接続:');
    await expect(make.getByRole('list', { name: '作る会話' })).toContainText('まだ依頼はありません');
    // どの接続で、どの認証で動くかは、開発者向けの詳細にある
    await openDevDetails(page);
    const status = page.locator('#agent-status');
    await expect(status).toBeVisible();
    await expect(status).toContainText('接続: 偽接続');
    await expect(status).toContainText('Claude Code もモデルも呼ばないので、料金はかかりません');
    await expect(status).toContainText('ANTHROPIC_API_KEY はありません');
    await closeMore(page);

    const app = page.frameLocator('iframe[title="試作品"]');
    await expect(app.getByRole('heading', { name: 'こもれび図書室' })).toBeVisible();

    // 試験用の依頼は、開発者向けの詳細から選ぶ。押すと依頼の欄に入る
    await sendTestRequest(page, '見出しを「ひだまり図書室」にして');

    const run = lastRun(page);
    await expect(run.locator('.bubble.user')).toContainText('見出しを「ひだまり図書室」にして');
    // 操作は短い文で出す。ファイルの名前と道具の名前は、実行ごとの「開発者向け」の中にだけ出す
    await expect(run.getByText('試作品のファイルを書き換えました')).toBeVisible();
    await expect(run.locator('.bubble.agent .who').first()).toHaveText('直す AI');
    await expect(run.locator('.bubble.agent')).toContainText('見出しを「ひだまり図書室」に変えました');
    // 作る会話の項目の本文は利用者の言葉。ファイルの名前は開発者向けにだけ出す(ux-redesign.md 4 節)
    await expect(run.locator('.steps')).toContainText('試作品のファイルが 1 個変わりました。');
    await expect(run.locator('.steps')).not.toContainText('app/App.jsx');
    await expect(run.locator('.run-dev')).toContainText('確かめた結果: 変わったファイル: app/App.jsx');
    await expect(run).toContainText('試作品に反映しました。');
    await expect(run.locator('.run-updated')).toHaveText('試作品のファイルを変えました。試作品は新しくなっています。');
    await expect(run.locator('.run-status')).toContainText('終わりました');
    await expect(run.locator('.run-status')).not.toContainText('認証の報告');
    const dev = run.locator('.run-dev');
    await expect(dev.getByText('操作: 書き換える: app/App.jsx')).toBeHidden();
    await dev.locator('summary').click();
    await expect(dev.getByText('操作: 書き換える: app/App.jsx')).toBeVisible();
    await expect(dev).toContainText('接続: 偽接続');
    await expect(dev).toContainText('認証の報告: none');

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
    await expect(lastRun(page)).toContainText('試作品に反映しました。');

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
    await sendTestRequest(page, 'app/ の外にメモを書いて');
    let run = lastRun(page);
    // 画面には利用者の言葉で、何をやめたかを出す(ux-redesign.md 4 節)。断られた操作と場所は、開発者向けにだけ出す
    await expect(run.locator('[data-kind="denied"]')).toHaveText(/試作品のフォルダーの外は触れないので、やめました/);
    await expect(run.locator('[data-kind="denied"]')).not.toContainText('app/');
    const dev = run.locator('.run-dev');
    await dev.locator('summary').click();
    await expect(dev.locator('[data-dev-kind="denied"]')).toContainText('権限の確認で断られました: 書く:');
    await expect(dev.locator('[data-dev-kind="denied"]')).toContainText('outside-note.txt(app/ の外)');
    await expect(run.locator('[data-kind="tool-error"]')).toContainText('直す AI の操作が、うまくいきませんでした。');
    await expect(dev.locator('[data-dev-kind="tool-error"]')).toContainText('許可されていません');
    await expect(run).toContainText('試作品のファイルは変わっていません。');
    // 断られた書き込みを、書いたとは言わない
    await expect(run.locator('.step-short').filter({ hasText: '試作品のフォルダーの外のファイルに書こうとしました' })).toHaveCount(1);
    await expect(run).not.toContainText('外のファイルを書きました');
    await expect(run.locator('.run-status')).toContainText('終わりました');
    await expect(fs.access(path.join(home, 'projects', 'sample-library', 'outside-note.txt'))).rejects.toThrow();
    await expect(fs.access(path.join(home, 'projects', 'outside-note.txt'))).rejects.toThrow();

    // 失敗: Ctrl+Enter でも送れる
    await chooseTestRequest(page, '失敗して');
    await page.getByLabel('依頼').press('Control+Enter');
    run = lastRun(page);
    await expect(run.locator('[data-kind="failed"]')).toHaveText(/直す AI が途中で失敗しました。もう一度送ってください。/);
    await expect(run.locator('.run-dev [data-dev-kind="failed"]')).toContainText('偽接続 が失敗しました: 偽接続: 依頼どおりに失敗しました');
    await expect(run.locator('.run-status')).toContainText('失敗しました');

    // ログインしていないときは、利用者がすることを出す
    await sendTestRequest(page, 'ログインしていないふりをして');
    run = lastRun(page);
    await expect(run.locator('[data-kind="hint"]')).toContainText('/login でログインしてから、もう一度送ってください');

    // ここまで、試す画面は同じ版のまま
    expect(await page.locator('iframe[title="試作品"]').getAttribute('src')).toBe(previewSrc);

    // ビルドに失敗する変更は、場所を出し、前の版を表示したままにする。
    // 作る AI が直すラウンドでも直せないときの形(直せたときは make-loop.spec.js)
    await sendTestRequest(page, '壊して、直せないふりをして');
    run = lastRun(page);
    await expect(run.locator('[data-kind="gave-up"]')).toContainText('直す AI が 2 回直そうとしましたが、「表示の準備」の問題が残っています');
    await expect(run.locator('.run-dev [data-dev-kind="gave-up"]')).toContainText('直すラウンドを 2 回行ったが、G4 ビルドで失敗したまま。');
    await expect(run.locator('.run-dev')).toContainText('変わったファイル: app/App.jsx');
    await expect(run.locator('[data-kind="build-failed"]')).toHaveCount(3);
    await expect(run.locator('[data-kind="build-failed"]').first()).toContainText('試作品を表示できません。試す欄には、前に表示できた状態を出しています。');
    await expect(page.locator('#build-status')).toContainText('ビルドに失敗しました');
    await expect(page.locator('#build-status')).toContainText('app/App.jsx(2 行');
    await expect(page.locator('#build-status')).toContainText('「試す」には、前にビルドできた版を表示しています');
    await expect(app.getByRole('heading', { name: 'こもれび図書室' })).toBeVisible();

    await sendTestRequest(page, '直して');
    await expect(lastRun(page)).toContainText('試作品に反映しました。');
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
    await sendTestRequest(page, 'ゆっくり進めて');
    const run = lastRun(page);
    await expect(run).toContainText('少しずつ進めています(1/60)');
    // 作業中の表示は、操作の短い文と「直す AI が作業しています」
    await expect(run.getByText('試作品のファイルを探しました')).toBeVisible();
    await expect(run.locator('.run-status')).toContainText('直す AI が作業しています');
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
    await expect(menu.getByRole('button', { name: SAMPLES.library.name, includeHidden: true })).toContainText('直す AI が作業中');
    await expect(lastRun(page).locator('.run-status')).toContainText('直す AI が作業しています');
    await page.getByRole('region', { name: '言葉で直す' }).getByRole('button', { name: '止める' }).click();
    await expect(lastRun(page).locator('[data-kind="cancelled"]')).toContainText('止めました。途中まで書き換えた試作品のファイルは、そのまま残っています。');
    await expect(lastRun(page).locator('.run-status')).toContainText('止めました');
    await expect(page.getByRole('region', { name: '言葉で直す' }).getByRole('button', { name: '止める' })).toBeHidden();
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
  const bin = await writeFakeClaude(home);
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
    // 偽接続ではないので、上の帯の開発用の印と、試験用の依頼は出ない。利用者向けの例(AI のない試作品は共通の例)を出す
    await expect(page.locator('#dev-agent-mark')).toBeHidden();
    await expect(page.locator('#test-requests')).toBeHidden();
    await expect(page.getByRole('list', { name: '直し方の例' }).getByRole('button')).toHaveText(['見出しの色を落ち着いた青にして', 'ボタンを大きくして', '説明の文を短くして']);

    // 初めての送信は、本物の AI を使う前の同意を求める。依頼の文は欄に残り、まだ送らない
    await sendRequest(page, '見出しを「本番の形で」にして');
    const consent = page.getByRole('group', { name: '本物の AI を使う前に' });
    await expect(consent).toContainText('AI は、あなたの Claude Code で動きます。');
    await expect(consent).toContainText('API キーの設定があるので、使った分だけ料金がかかります。');
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
    await consent.getByRole('button', { name: '同意して使う' }).click();
    await expect(consent).toBeHidden();
    const run = lastRun(page);
    await expect(run.locator('.bubble.agent .who').first()).toHaveText('直す AI');
    await expect(run).toContainText('試作品に反映しました。');
    await expect(run.locator('.run-dev')).toContainText('接続: Claude Code');
    await expect(run.locator('.run-dev')).toContainText('認証の報告: ANTHROPIC_API_KEY');
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
    await expect(page.getByRole('group', { name: '言葉で直すには、Claude Code が要ります' })).toBeVisible();
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

test('U4: 既定の起動では試験用の依頼が見えず、利用者向けの例が 3 つ出る。試作品を切り替えると、直す欄の上の名前と例が変わる', async ({ page, home }) => {
  test.skip(process.platform === 'win32', '偽の claude(Node のスクリプト)を直接起動できないため');
  // 既定(STUDIO_AGENT を書かない)で、偽の claude がログインしている形
  const studio = await launchStudio(home, { env: { STUDIO_AGENT: undefined, STUDIO_CLAUDE_BIN: FAKE_CLAUDE } });
  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(studio.url);
    const app = page.frameLocator('iframe[title="試作品"]');
    await expect(app.getByRole('heading', { name: 'しおかぜ求人相談' })).toBeVisible();
    const make = page.getByRole('region', { name: '言葉で直す' });
    await expect(make.locator('#make-target')).toHaveText('求人相談への依頼');
    // AI のある試作品の例。1 つ目は、試作品の AI の設定の最後の項目を先に聞く
    const examples = make.getByRole('list', { name: '直し方の例' }).getByRole('button');
    await expect(examples).toHaveText(['時給の下限を先に聞くようにして', '案内役の話し方を、もっとやわらかくして', '見出しの色を落ち着いた青にして']);
    await expect(page.locator('#agent-unavailable')).toBeHidden();
    await expect(page.locator('#dev-agent-mark')).toBeHidden();
    await expect(page.getByLabel('依頼')).toBeEnabled();
    // 押すと依頼の欄に入る
    await examples.nth(1).click();
    await expect(page.getByLabel('依頼')).toHaveValue('案内役の話し方を、もっとやわらかくして');
    await page.screenshot({ path: path.join(UX_SHOTS, 'P23-normal.png') });

    // 試験用の依頼は、最初の画面にも、開発者向けの詳細を開いても出ない
    for (const word of TEST_WORDS) expect(await visibleText(page)).not.toContain(word);
    await openDevDetails(page);
    await expect(page.locator('#test-requests')).toBeHidden();
    for (const word of TEST_WORDS) expect(await visibleText(page)).not.toContain(word);
    await closeMore(page);

    // 試作品を切り替えると、直す欄の上の名前が変わる。AI のない試作品は Studio の共通の例だけ
    await chooseSample(page, SAMPLES.library);
    await expect(make.locator('#make-target')).toHaveText('図書室への依頼');
    await expect(examples).toHaveText(['見出しの色を落ち着いた青にして', 'ボタンを大きくして', '説明の文を短くして']);
    await chooseSample(page, SAMPLES.studyConsult);
    await expect(make.locator('#make-target')).toHaveText('学習相談への依頼');
    await expect(examples.first()).toHaveText('1日に使える時間を先に聞くようにして');
  } finally {
    await studio.stop();
  }
});

test('U4: STUDIO_AGENT=fake では、試験用の依頼は開発者向けの詳細を開いたときだけ見え、上の帯に開発用の印が出る', async ({ page, home }) => {
  const studio = await launchStudio(home);
  try {
    await page.goto(studio.url);
    const app = page.frameLocator('iframe[title="試作品"]');
    await expect(app.getByRole('heading', { name: 'しおかぜ求人相談' })).toBeVisible();
    await expect(page.getByRole('banner').getByText('開発用: 偽の直す AI')).toBeVisible();
    // 利用者向けの例は、偽接続でも同じ 3 つ
    await expect(page.getByRole('list', { name: '直し方の例' }).getByRole('button')).toHaveCount(3);
    for (const word of TEST_WORDS) expect(await visibleText(page)).not.toContain(word);

    await openDevDetails(page);
    const tests = page.getByRole('list', { name: '偽の直す AI で試せる例' });
    await expect(tests).toBeVisible();
    for (const word of ['壊して', 'ゆっくり進めて', '失敗して', 'ログインしていないふりをして']) {
      await expect(tests.getByRole('button', { name: word, exact: true })).toBeVisible();
    }
    // 試作品の AI の項目の名前を入れた例も、ここにある
    await expect(tests.getByRole('button', { name: '「時給の下限」を先に聞くようにして', exact: true })).toBeVisible();

    // 選ぶと依頼の欄に入り、引き出しが閉じる。送ると直す AI が動く
    await sendTestRequest(page, '「時給の下限」を先に聞くようにして');
    const run = lastRun(page);
    await expect(run.locator('.run-updated')).toHaveText('AI の設定を変えました。試作品は新しくなっています。');
    await expect(run.getByText('AI の設定を読みました')).toBeVisible();
    await expect(run.getByText('AI の設定を書きました')).toBeVisible();
  } finally {
    await studio.stop();
  }
});

test('U8: Claude Code がないと、直す欄に何ができないかと手順を出し、試すは使える。エラーの文は開発者向けの中だけ', async ({ page, home }) => {
  const missing = path.join(home, 'no-such-claude');
  const studio = await launchStudio(home, { env: { STUDIO_AGENT: undefined, STUDIO_CLAUDE_BIN: missing } });
  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(studio.url);
    const app = page.frameLocator('iframe[title="試作品"]');
    await expect(app.getByRole('heading', { name: 'しおかぜ求人相談' })).toBeVisible();

    const card = page.getByRole('group', { name: '言葉で直すには、Claude Code が要ります' });
    await expect(card).toBeVisible();
    await expect(card).toContainText('この PC で Claude Code が見つかりません。');
    await expect(card).toContainText('今できること');
    await expect(card).toContainText('試作品を試す(お試しの AI)');
    await expect(card).toContainText('保存、本番開発へ渡す');
    await expect(card.getByRole('listitem').filter({ hasText: 'Claude Code を入れる' })).toBeVisible();
    await expect(card.getByRole('listitem').filter({ hasText: 'Studio を止めて、もう一度起動する' })).toBeVisible();
    // 送れない。例も出さない
    await expect(page.getByRole('button', { name: '送る' }).last()).toBeDisabled();
    await expect(page.getByLabel('依頼')).toHaveAttribute('placeholder', '直す AI が使えないので、送れません');
    await expect(page.locator('#examples')).toBeHidden();
    await expect(page.locator('#dev-agent-mark')).toBeHidden();
    // サーバーの理由の文と、変数の名前は見えない。カードの中の「開発者向け」を開くと見える
    for (const word of ['ENOENT', 'spawn', 'claude が見つかりません', 'STUDIO_', missing]) {
      expect(await visibleText(page)).not.toContain(word);
    }
    await page.screenshot({ path: path.join(UX_SHOTS, 'P23-unavailable.png') });
    await card.getByText('開発者向け: 確かめた結果').click();
    await expect(card.getByText('claude が見つかりません')).toBeVisible();
    await expect(card).toContainText(missing);

    // 試すは使える(試作品の中の AI はお試しの AI)
    const message = app.getByLabel('メッセージ');
    await message.fill('カフェで働きたいです');
    await app.getByRole('button', { name: '送る' }).click();
    await expect(app.getByRole('region', { name: '会話' }).getByRole('listitem').last()).toContainText('カフェ');
  } finally {
    await studio.stop();
  }
});

test('起動できない claude は、見出しを変えて出し、spawn … ENOENT は開発者向けの中にだけ出す', async ({ page, home }) => {
  test.skip(process.platform === 'win32', 'シェルスクリプトの claude を使うため');
  // ある場所にあるが、起動すると ENOENT になる claude(先頭の行の実行ファイルがない)
  const bin = path.join(home, 'bin', 'claude');
  await fs.mkdir(path.dirname(bin), { recursive: true });
  await fs.writeFile(bin, '#!/no-such-dir/no-such-shell\n', { mode: 0o755 });
  const studio = await launchStudio(home, { env: { STUDIO_AGENT: undefined, STUDIO_CLAUDE_BIN: bin } });
  try {
    const { agent } = await studio.api('/api/projects');
    expect(agent).toMatchObject({ status: 'unusable', ready: false });
    expect(agent.problem).toContain('ENOENT');
    await page.goto(studio.url);
    const card = page.getByRole('group', { name: 'この Claude Code は、Studio から使えません' });
    await expect(card).toBeVisible();
    expect(await visibleText(page)).not.toContain('ENOENT');
    await card.getByText('開発者向け: 確かめた結果').click();
    await expect(card.getByText(/spawn .*ENOENT/)).toBeVisible();
  } finally {
    await studio.stop();
  }
});

test('Claude Code が古いときと、ログインしていないときは、カードの見出しと手順が変わる', async ({ page, home }) => {
  test.skip(process.platform === 'win32', '偽の claude をスクリプトで作るため');
  const old = await writeFakeClaude(home, { version: '2.0.0' });
  let studio = await launchStudio(home, { env: { STUDIO_AGENT: undefined, STUDIO_CLAUDE_BIN: old } });
  try {
    await page.goto(studio.url);
    const card = page.getByRole('group', { name: 'Claude Code が古いので使えません' });
    await expect(card).toBeVisible();
    await expect(card).toContainText('この PC の Claude Code 2.0.0 は古いので');
    await expect(card.getByRole('listitem').filter({ hasText: 'claude update' })).toBeVisible();
    await expect(page.getByRole('group', { name: '言葉で直すには、Claude Code が要ります' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '送る' }).last()).toBeDisabled();
  } finally {
    await studio.stop();
  }

  studio = await launchStudio(home, { env: { STUDIO_AGENT: undefined, STUDIO_CLAUDE_BIN: FAKE_CLAUDE, FAKE_CLAUDE_AUTH: 'logged-out' } });
  try {
    await page.goto(studio.url);
    const card = page.getByRole('group', { name: 'Claude Code にログインしていません' });
    await expect(card).toBeVisible();
    await expect(card.getByRole('listitem').filter({ hasText: '/login でログインする' })).toBeVisible();
    await expect(page.getByRole('button', { name: '送る' }).last()).toBeDisabled();
  } finally {
    await studio.stop();
  }
});

test('作業中は操作を短い文で出し、終わったら何を変えたかと、試作品が新しくなったことを出す', async ({ page, home }) => {
  test.skip(process.platform === 'win32', '偽の claude をシェルスクリプトで作るため');
  // 偽接続の出力を 1 行ずつ遅らせる claude。作業中の画面を撮るため
  const bin = await writeFakeClaude(home, { delay: 1 });
  const studio = await launchStudio(home, { env: { STUDIO_AGENT: undefined, STUDIO_CLAUDE_BIN: bin } });
  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(studio.url);
    const app = page.frameLocator('iframe[title="試作品"]');
    await expect(app.getByRole('heading', { name: 'しおかぜ求人相談' })).toBeVisible();
    await page.getByRole('list', { name: '直し方の例' }).getByRole('button', { name: '時給の下限を先に聞くようにして' }).click();
    await page.getByRole('button', { name: '送る' }).last().click();
    await page.getByRole('group', { name: '本物の AI を使う前に' }).getByRole('button', { name: '同意して使う' }).click();

    const run = lastRun(page);
    await expect(run.getByText('AI の設定を読みました')).toBeVisible({ timeout: 15_000 });
    await expect(run.locator('.run-status')).toHaveText('直す AI が作業しています…');
    await page.screenshot({ path: path.join(UX_SHOTS, 'P23-working.png') });
    // ファイルの名前と道具の名前は見えない
    for (const word of ['ai.json', 'Read', '読む:', 'Claude Code']) expect(await run.innerText()).not.toContain(word);

    await expect(run.locator('.run-updated')).toHaveText('AI の設定を変えました。試作品は新しくなっています。', { timeout: 20_000 });
    await expect(app.getByRole('region', { name: '希望条件' }).locator('dt').first()).toHaveText('時給の下限');
  } finally {
    await studio.stop();
  }
});
