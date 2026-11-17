import fs from 'node:fs/promises';
import path from 'node:path';
import { chooseSample, chooseTestRequest, expect, expectNoDevWordsOnScreen, goStage, launchStudio, openMeasureTab, ROOT, SAMPLES, test } from './studio.js';

// 段 5「作る」と段 6「測る」の 2 列(docs/design/ui-ux-v2.md の 2.2、2.4、4.2、4.3、6 節)。UI/UX の 5 枚目。
// 実モデルは呼ばない。作る AI は偽の claude(シェルスクリプト。--version と auth status は test/fixtures/fake-claude.js、
// ほかは偽接続 src/agent/fake-claude.js に渡し、1 行ずつ少し遅らせる)か、偽接続(STUDIO_AGENT=fake)。試作品の中の AI はお試しの AI

const UX_SHOTS = path.join(ROOT, 'test-results', 'ux');

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
      `${node} ${fixer} "$@" | while IFS= read -r line || [ -n "$line" ]; do printf '%s\\n' "$line"; sleep 0.3; done`,
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  return bin;
}

// 画面の様子を、描くたびに(requestAnimationFrame)集める。変わったときだけ残す。
// 今していることの関門の状態、作る AI の行の状態、今の行の働いている者、試作品の iframe の src、版の 1 行、強い色のボタンの数
async function startSampling(page) {
  await page.evaluate(() => {
    const probe = document.createElement('span');
    probe.style.color = 'var(--color-accent)';
    document.body.append(probe);
    const accent = getComputedStyle(probe).color;
    probe.remove();
    window.__samples = [];
    window.__sampling = true;
    let last = '';
    const tick = () => {
      const sample = {
        status: document.getElementById('make-now')?.dataset.status ?? '',
        maker: [...document.querySelectorAll('#make-now-list > .now-row[data-actor="maker"]')].at(-1)?.dataset.state ?? '',
        gates: [...document.querySelectorAll('#make-now-list .now-gate-list .now-row')].map((row) => row.dataset.state).join(','),
        active: [...document.querySelectorAll('#now-line .actor[data-active]')].map((actor) => actor.dataset.actor).join(','),
        src: document.querySelector('iframe[title="試作品"]')?.getAttribute('src') ?? null,
        version: document.getElementById('frame-version')?.checkVisibility() ? document.getElementById('frame-version').textContent : '',
        strong: [...document.querySelectorAll('button')].filter((button) => button.checkVisibility() && getComputedStyle(button).backgroundColor === accent).map((button) => button.textContent),
      };
      const key = JSON.stringify(sample);
      if (key !== last) {
        last = key;
        window.__samples.push(sample);
      }
      if (window.__sampling) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

async function stopSampling(page) {
  return page.evaluate(() => {
    window.__sampling = false;
    return window.__samples;
  });
}

test('作っている間: 強い色のボタンがなく、試作品の欄は前の版を出し続け、関門の列が順に進む。今の行の働いている者が正しい', async ({ page, home }) => {
  test.skip(process.platform === 'win32', '偽の claude をシェルスクリプトで作るため');
  test.setTimeout(120_000);
  const studio = await launchStudio(home, { env: { STUDIO_AGENT: undefined, STUDIO_CLAUDE_BIN: await writeFakeClaude(home) } });
  try {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(studio.url);
    const app = page.frameLocator('iframe[title="試作品"]');
    await expect(app.getByRole('heading', { name: 'しおかぜ求人相談' })).toBeVisible();
    const make = page.getByRole('region', { name: '作る AI', exact: true });
    // 段 5 の右の列は作る AI の欄。名前は「作る AI」にそろえ、「直す AI」はどこにもない
    await expect(page.locator('#stage-list button.stage[data-stage="build"]')).toHaveAttribute('aria-current', 'step');
    await expect(make.getByRole('heading', { name: '作る AI' })).toBeVisible();
    await expect(page.locator('body')).not.toContainText('直す AI');

    // 作る AI に頼む。偽の claude なので、本物の AI を使う前の同意のカードが出る(人が押す)
    const before = await page.locator('iframe[title="試作品"]').getAttribute('src');
    await make.getByRole('list', { name: '直し方の例' }).getByRole('button', { name: '時給の下限を先に聞くようにして' }).click();
    await startSampling(page);
    await make.getByRole('button', { name: '送る' }).click();
    await page.getByRole('group', { name: '本物の AI を使う前に' }).getByRole('button', { name: '同意して使う' }).click();

    // 作っている間の画面: 依頼の文、今していること、経過の時間と目安(推測)。帯は弱いボタン「止める」と待つ間の 1 文
    const now = page.getByRole('region', { name: '今していること' });
    await expect(now).toBeVisible({ timeout: 15_000 });
    await expect(now.locator('#make-now-request')).toHaveText('時給の下限を先に聞くようにして');
    await expect(now.locator('#make-now-time')).toHaveText(/^経過 \d+ 秒\(多くは 3 分以内。推測\)$/);
    await expect(page.locator('#next-text')).toHaveText('作る AI が試作品を書いています。止めても、前の版は残ります。');
    const band = page.getByRole('region', { name: '次の一手' });
    await expect(band.getByRole('button', { name: '止める' })).toBeVisible();
    await expect(band.getByRole('button', { name: '止める' })).toHaveClass(/quiet/);
    await expect(page.locator('#frame-version')).toHaveText(/^前の版を出しています。この版は \d\d:\d\d のものです。新しい版は、表示の準備を通ったら出ます。$/);
    for (const theme of ['light', 'dark']) {
      await page.emulateMedia({ colorScheme: theme });
      await page.waitForTimeout(300);
      await page.screenshot({ path: path.join(UX_SHOTS, `build-making-${theme}.png`) });
    }
    await page.emulateMedia({ colorScheme: 'light' });

    // 終わると、帯は 4.3 の表の 1 文と「試す」
    await expect(now).toHaveAttribute('data-status', /^(passed|fixed|unverified)$/, { timeout: 60_000 });
    const samples = await stopSampling(page);
    const running = samples.filter((sample) => sample.status === 'running');
    expect(running.length).toBeGreaterThan(0);
    // 強い色のボタンは、作っている間に 1 つもない(あなたの番ではないため)
    expect(running.filter((sample) => sample.strong.length > 0)).toEqual([]);
    // 試作品の欄は白紙にならない。作る AI が書いている間は、前の版(同じ src)を出し続ける
    expect(samples.every((sample) => sample.src)).toBe(true);
    const writing = running.filter((sample) => sample.maker === 'writing');
    expect(writing.length).toBeGreaterThan(0);
    for (const sample of writing) {
      expect(sample.src).toBe(before);
      expect(sample.version).toMatch(/^前の版を出しています。/);
      // ■ 作る AI が書いている間は、今の行で ■ が働いている
      expect(sample.active).toBe('maker');
    }
    // 関門の列が順に進む: 済み(✓)の数は減らず、確かめている(●)関門と、まだ(○)の関門が出る
    const gateRuns = running.filter((sample) => sample.gates);
    const doneCounts = gateRuns.map((sample) => sample.gates.split(',').filter((state) => state === 'done').length);
    expect(doneCounts).toEqual([...doneCounts].sort((a, b) => a - b));
    expect(gateRuns.some((sample) => sample.gates.includes('done') && sample.gates.includes('todo'))).toBe(true);
    const checking = gateRuns.filter((sample) => sample.gates.includes('active'));
    expect(checking.length).toBeGreaterThan(0);
    // ⬢ 関門が確かめている間は、今の行で ⬢ が働いている(■ は結果を待っている)
    for (const sample of checking) expect(sample.active).toBe('gate');
    // 新しい版が出たら「新しい版です。10:55」の 1 行
    await expect(page.locator('#frame-version')).toHaveText(/^新しい版です。\d\d:\d\d$/);
    expect(await page.locator('iframe[title="試作品"]').getAttribute('src')).not.toBe(before);
    await expect(now.locator('.now-gate-list .now-row')).not.toHaveCount(0);
    for (const row of await now.locator('.now-gate-list .now-row').all()) await expect(row).toHaveAttribute('data-state', /^(done|warn|same)$/);
    await expect(now.locator('#make-now-time')).toHaveText(/^かかった時間 \d+/);
    await expect(page.locator('#next-text')).toHaveText(/^試作品を(作りました。|作りました。自動の確かめの一部は)/);
    await expect(band.getByRole('button', { name: '試す' })).toBeVisible();
    await expect(page.locator('body')).not.toContainText('直す AI');
    await expectNoDevWordsOnScreen(page);
  } finally {
    await studio.stop();
  }
});

test('試す場面: 試作品の中の AI が答えている間は、今の行で ▲ が働いている', async ({ page, home }) => {
  const studio = await launchStudio(home);
  try {
    await page.goto(studio.url);
    await chooseSample(page, SAMPLES.partTime);
    const app = page.frameLocator('iframe[title="試作品"]');
    const message = app.getByLabel('メッセージ');
    await expect(message).toBeVisible();
    await startSampling(page);
    await message.fill('詳しく見せて');
    await app.getByRole('button', { name: '送る' }).click();
    await expect(message).toHaveValue('');
    await expect(page.locator('#now-line .actor[data-actor="you"]')).toHaveAttribute('data-active', 'true');
    const samples = await stopSampling(page);
    expect(samples.some((sample) => sample.active === 'product'), JSON.stringify(samples)).toBe(true);
    // 答え終わると、あなたの番に戻る
    expect(samples.at(-1).active).toBe('you');
  } finally {
    await studio.stop();
  }
});

// 関門で落ちる偽の run(4.3 の表)。偽接続の試験用の依頼で、表示の準備で落ちる
test('関門で落ちて直しきれない run: 落ちた関門の ×、作る AI が直した回数、帯の 1 文と「頼み方を変える」が出る', async ({ page, home }) => {
  test.setTimeout(90_000);
  const studio = await launchStudio(home);
  try {
    await page.goto(studio.url);
    await chooseSample(page, SAMPLES.library);
    await chooseTestRequest(page, '壊して、直せないふりをして');
    await page.getByRole('button', { name: '送る' }).click();
    const now = page.getByRole('region', { name: '今していること' });
    await expect(now).toHaveAttribute('data-status', 'failed', { timeout: 60_000 });
    // 落ちた関門は × と「落ちた」。前のラウンドで落ちた関門も、回目を添えて残す
    const failed = now.locator('.now-row[data-actor="gate"][data-state="failed"]');
    await expect(failed.first().locator('.now-mark')).toHaveText('×');
    await expect(failed.first().locator('.now-state')).toHaveText('落ちた');
    await expect(failed.filter({ hasText: '表示の準備(1 回目)' })).toHaveCount(1);
    await expect(now.locator('.now-gate-list .now-row[data-gate="compile"]')).toHaveAttribute('data-state', 'failed');
    // まだの関門は、作り終わった後は「行っていません」(○ まだ、とは分ける)
    await expect(now.locator('.now-gate-list .now-row[data-gate="launch"] .now-state')).toHaveText('行っていません');
    await expect(now.locator('#make-now-rounds')).toHaveText('作る AI が直そうとした回数: 2 回(2 回まで)');
    await expect(now.locator('.now-row[data-actor="maker"]')).toHaveCount(3);
    await expect(page.locator('#next-text')).toHaveText('「表示の準備」で落ち、作る AI が直しきれませんでした。前に動いた版を出しています。頼み方を変えて、もう一度試しますか。');
    const change = page.getByRole('region', { name: '次の一手' }).getByRole('button', { name: '頼み方を変える' });
    await expect(change).toBeVisible();
    // 「頼み方を変える」は、前の依頼の文を作る AI の欄に入れる(送るのは人)
    await change.click();
    await expect(page.getByLabel('依頼')).toHaveValue('壊して、直せないふりをして');
    await expect(page.getByLabel('依頼')).toBeFocused();
    await expectNoDevWordsOnScreen(page);
  } finally {
    await studio.stop();
  }
});

test('関門で落ち、作る AI が直して通った run: 前のラウンドで落ちた関門の ×、直した回数、帯の 1 文と「試す」が出る', async ({ page, home }) => {
  test.setTimeout(90_000);
  const studio = await launchStudio(home);
  try {
    await page.goto(studio.url);
    await chooseSample(page, SAMPLES.library);
    await chooseTestRequest(page, '壊して');
    await page.getByRole('button', { name: '送る' }).click();
    const now = page.getByRole('region', { name: '今していること' });
    await expect(now).toHaveAttribute('data-status', 'fixed', { timeout: 60_000 });
    await expect(now.locator('.now-row[data-actor="gate"][data-state="failed"]')).toHaveText(/×.*表示の準備\(1 回目\)落ちた/);
    await expect(now.locator('.now-row[data-actor="maker"]').last()).toContainText('落ちたところを直す(1 回目)');
    await expect(now.locator('.now-row[data-actor="maker"]').last()).toHaveAttribute('data-state', 'done');
    await expect(now.locator('#make-now-rounds')).toHaveText('作る AI が直した回数: 1 回(2 回まで)');
    await expect(page.locator('#next-text')).toHaveText('1 度落ちましたが、作る AI が直して通りました。直したところは記録にあります。');
    await page.getByRole('region', { name: '次の一手' }).getByRole('button', { name: '試す' }).click();
    // 「試す」で段 6 に移る。右の列は 3 つのタブ
    await expect(page.locator('#stage-list button.stage[data-stage="measure"]')).toHaveAttribute('aria-current', 'step');
    await expect(page.getByRole('tablist', { name: '測る' })).toBeVisible();
  } finally {
    await studio.stop();
  }
});

test('守りが止めた run: 帯は「言い換える」。段 6〜8 では右上の「■ 作る AI に頼む」で作る AI の欄に切り替えられる', async ({ page, home }) => {
  test.setTimeout(60_000);
  const studio = await launchStudio(home);
  try {
    await page.goto(studio.url);
    await chooseSample(page, SAMPLES.library);
    await chooseTestRequest(page, 'app/ の外にメモを書いて');
    await page.getByRole('button', { name: '送る' }).click();
    const now = page.getByRole('region', { name: '今していること' });
    await expect(now).not.toHaveAttribute('data-status', 'running', { timeout: 30_000 });
    await expect(page.locator('#next-text')).toHaveText('試作品のフォルダーの外は触れないので、やめました。試作品の中で済む依頼に言い換えてください。');
    await expect(page.getByRole('region', { name: '次の一手' }).getByRole('button', { name: '言い換える' })).toBeVisible();

    // 段 6〜8 の右の列と、「■ 作る AI に頼む」
    for (const [stage, side] of [['測る', '#measure'], ['質', '#stage-check'], ['見せる', '#stage-show']]) {
      await goStage(page, stage);
      await expect(page.locator(side)).toBeVisible();
      await expect(page.getByRole('region', { name: '作る AI', exact: true })).toBeHidden();
      await page.getByRole('button', { name: '作る AI に頼む' }).click();
      await expect(page.getByRole('region', { name: '作る AI', exact: true })).toBeVisible();
      await expect(page.locator(side)).toBeHidden();
      await page.locator('#side-back').click();
      await expect(page.locator(side)).toBeVisible();
    }
  } finally {
    await studio.stop();
  }
});

test('1024px より狭いと、段 6 の 2 列を上下に並べる', async ({ page, home }) => {
  const studio = await launchStudio(home);
  try {
    await page.setViewportSize({ width: 900, height: 900 });
    await page.goto(studio.url);
    await expect(page.frameLocator('iframe[title="試作品"]').getByRole('heading', { name: 'しおかぜ求人相談' })).toBeVisible();
    await openMeasureTab(page, 'この 1 ターン');
    const tryBox = await page.getByRole('region', { name: '試作品', exact: true }).boundingBox();
    const sideBox = await page.locator('#measure').boundingBox();
    expect(sideBox.y).toBeGreaterThanOrEqual(tryBox.y + tryBox.height);
  } finally {
    await studio.stop();
  }
});
