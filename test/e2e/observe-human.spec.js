import fs from 'node:fs/promises';
import path from 'node:path';
import { chooseSample, chooseTestRequest, closeMore, expect, expectNoDevWords, expectReadableText, launchStudio, openCheck, ROOT, SAMPLES, test, goStage } from './studio.js';

// 人の「確かめる」(docs/design/harness.md の 3.1、8 節の P27)。利用者が画面から、表示中の試作品を自動で確かめる。
// 作るループの関門と同じ観察の入口を使い、同じ形の report を書き、作る run と同じ形の結果の帯で出す(S5)。
// 実モデルは呼ばない。作る AI は偽接続(STUDIO_AGENT=fake)、本物の AI で確かめるときの試作品の中の AI は偽の CLI
// (test/fixtures/fake-claude.js)。観察器は Playwright の Chromium

// 「分かるか」の確かめ(ux-redesign.md 9 節)のスクリーンショットの置き場。test-results/ は git が無視する
const UX_SHOTS = path.join(ROOT, 'test-results', 'ux');
const FAKE = path.join(ROOT, 'test', 'fixtures', 'fake-claude.js');
const CHECK = '試作品を自動で確かめる';
const AGAIN = 'もう一度確かめる';
const PASSED = '確かめました。問題は見つかりませんでした';
const CARD = '本物の AI を使う前に';

function items(page) {
  return page.getByRole('list', { name: '作る会話' }).locator('> li.run');
}

// 人の「確かめる」の項目(作る run の項目と、頼んだ文で分ける)
function checkItems(page) {
  return items(page).filter({ has: page.locator('.bubble.user', { hasText: '試作品を自動で確かめる' }) });
}

function band(item) {
  return item.getByRole('group', { name: '確かめた結果' });
}

function checkSection(panel) {
  return panel.getByRole('region', { name: CHECK });
}

// 帯の小さな画像が、読み込み終わっている
async function expectShotsLoaded(target, count) {
  const images = target.getByRole('list', { name: '確かめた画面' }).locator('img');
  await expect(images).toHaveCount(count);
  for (const image of await images.all()) {
    await expect(image).toHaveAttribute('src', /^data:image\/png;base64,/);
    await expect.poll(() => image.evaluate((img) => img.complete && img.naturalWidth > 0)).toBe(true);
  }
}

const readJson = async (file) => JSON.parse(await fs.readFile(file, 'utf8'));
const checksOf = async (studio, id) => (await studio.api(`/api/projects/${id}/checks`)).checks;

// report の形(項目の名前と、その型)。null は object と同じに数える(reason など、値がないときは null)
function shapeOf(report) {
  const kind = (value) => (Array.isArray(value) ? 'array' : value === null || typeof value === 'object' ? 'object' : typeof value);
  return Object.fromEntries(Object.keys(report).sort().map((key) => [key, kind(report[key])]));
}

test('結果の帯の「もう一度確かめる」は、作るループと同じ入口を使い、同じ形の report を返し、同じ形の帯で出る(S5)', async ({ page, home }) => {
  test.setTimeout(60_000);
  const studio = await launchStudio(home);
  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(studio.url);
    await chooseSample(page, SAMPLES.library);
    await expect(page.frameLocator('iframe[title="試作品"]').getByRole('heading', { name: 'こもれび図書室' })).toBeVisible();

    // 作るループの結果の帯
    await chooseTestRequest(page, '見出しを「ひだまり図書室」にして');
    await page.getByRole('button', { name: '送る' }).click();
    const runBand = band(items(page).first());
    await expect(runBand.locator('.run-status')).toHaveText('終わりました。確かめました。問題は見つかりませんでした', { timeout: 20_000 });
    // AI のない試作品では、確かめに使う AI は出さない
    await expect(runBand.locator('.evidence-actions')).toHaveText(AGAIN);

    await runBand.getByRole('button', { name: AGAIN }).click();
    await expect(items(page)).toHaveCount(2);
    const checkItem = checkItems(page);
    await expect(checkItem.locator('.bubble.user')).toHaveText('あなた試作品を自動で確かめる');
    const checkBand = band(checkItem);
    await expect(checkBand.locator('.run-status')).toHaveText(PASSED, { timeout: 30_000 });
    // 同じ形の帯: 状態の 1 文、確かめた 3 つの画面幅、開くと確かめたこと。「もう一度確かめる」は、いちばん新しい帯にだけ
    await expectShotsLoaded(checkBand, 3);
    await expect(checkBand.getByRole('button', { name: AGAIN })).toBeVisible();
    await expect(runBand.getByRole('button', { name: AGAIN })).toHaveCount(0);
    await expectNoDevWords(checkBand);
    await checkBand.locator('details.evidence-more > summary').click();
    await expect(checkBand.getByRole('list', { name: '確かめたこと' }).locator('> li')).toHaveText(['開いて表示できるか: 問題なし', '決めた手順で動くか: 問題なし']);
    await expect(checkBand.getByRole('list', { name: '「起動して描画が空でなく、エラーがない」の手順' })).toContainText('描画が空でない: 通った');

    // report は .studio/observations/<観察の ID>/ にあり、作るループの関門の report と同じ形
    const root = path.join(home, 'projects', SAMPLES.library.id);
    const [check] = await checksOf(studio, SAMPLES.library.id);
    expect(check.status).toBe('passed');
    expect(check.report).toMatch(/^\.studio\/observations\/[^/]+\/report\.json$/);
    const report = await readJson(path.join(root, check.report));
    const { runs } = await studio.api(`/api/projects/${SAMPLES.library.id}/build-requests`);
    const record = await readJson(path.join(root, runs.at(-1).evidence.run));
    expect(record.reports.map((r) => r.gate)).toEqual(['G5', 'G6']);
    for (const { file } of record.reports) {
      const gateReport = await readJson(path.join(root, file));
      expect(gateReport.format).toBe(report.format);
      expect(gateReport.formatVersion).toBe(report.formatVersion);
      expect(shapeOf(gateReport)).toEqual(shapeOf(report));
    }
    expect(report.format).toBe('prototype-studio-observation');
    // 表示中のビルドを見た。作る run が確かめた app/ と同じ中身
    expect(report.appDigest).toBe(runs.at(-1).appDigest);
    expect(report.screenshots.map((shot) => shot.name)).toEqual(['mobile', 'tablet', 'desktop']);
    // 開発者向けに、report の場所
    await checkBand.locator('details.evidence-dev > summary').click();
    await expect(checkBand.getByRole('list', { name: '記録の場所' })).toHaveText(check.report);
  } finally {
    await studio.stop();
  }
});

test('引き出しの「試作品を自動で確かめる」: お試しの AI が既定で、確かめても試す欄の会話は変わらない。作る run の間は押せない', async ({ page, home }) => {
  test.setTimeout(90_000);
  const studio = await launchStudio(home);
  const id = SAMPLES.jobConsult.id;
  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(studio.url);
    const app = page.frameLocator('iframe[title="試作品"]');
    await expect(app.getByRole('heading', { name: 'しおかぜ求人相談' })).toBeVisible();

    // 試す欄で話しておく
    await app.getByLabel('メッセージ').fill('しおかぜ町でカフェのアルバイトを探しています');
    await app.getByRole('button', { name: '送る' }).click();
    await expect(app.getByRole('region', { name: '会話' })).toContainText('しおかぜ町でカフェのアルバイトを探しています');
    await expect.poll(async () => (await studio.api(`/api/projects/${id}/ai`)).session.state.area).toBe('しおかぜ町');
    const before = (await studio.api(`/api/projects/${id}/ai`)).session;
    expect(before.messages.filter((m) => m.role === 'user')).toHaveLength(1);

    // 試す欄の上には置かない(U9)
    await expect(page.locator('#try-toolbar').getByRole('button').and(page.locator(':not(#ai-switch)'))).toHaveText(['会話を最初から']);

    const section = await openCheck(page);
    await section.scrollIntoViewIfNeeded();
    await expect(section.getByRole('radio', { name: /お試しの AI/ })).toBeChecked();
    await expect(section.getByRole('radio', { name: /本物の AI/ })).not.toBeChecked();
    await expect(section).toContainText('試す欄の会話は変わりません。');
    await expectNoDevWords(section);
    await page.screenshot({ path: path.join(UX_SHOTS, 'P27-drawer.png') });

    await section.getByRole('button', { name: CHECK }).click();
    await closeMore(page);
    const checkItem = checkItems(page);
    await expect(checkItem.locator('.bubble.user')).toHaveText('あなた試作品を自動で確かめる(試作品の中の AI: お試しの AI)');
    const checkBand = band(checkItem);
    await expect(checkBand.locator('.run-status')).toHaveText(PASSED, { timeout: 45_000 });
    await expectShotsLoaded(checkBand, 3);
    await expect(checkBand.locator('.evidence-actions')).toContainText('試作品の中の AI: お試しの AI');
    await expectNoDevWords(checkBand);
    await expectReadableText(page, '人の確かめの帯');
    await page.screenshot({ path: path.join(UX_SHOTS, 'P27-band.png') });

    // アプリのシナリオも回った。試作品の中の AI は観察用の会話(お試し)で、試す欄の会話には入らない
    const [check] = await checksOf(studio, id);
    const report = await readJson(path.join(home, 'projects', id, check.report));
    expect(report.scenarios.map((s) => [s.base === true, s.verdict])).toEqual(
      expect.arrayContaining([
        [true, 'passed'],
        [false, 'passed'],
      ]),
    );
    expect(report.ai.length).toBeGreaterThan(0);
    expect(report.ai.every((entry) => entry.observation)).toBe(true);
    const after = (await studio.api(`/api/projects/${id}/ai`)).session;
    expect(after.messages).toEqual(before.messages);
    expect(after.state).toEqual(before.state);
    expect(after.connection.kind).toBe('mock');
    await expect(app.getByRole('region', { name: '会話' })).toContainText('しおかぜ町でカフェのアルバイトを探しています');

    // 作る run の間は、引き出しのボタンも帯の「もう一度確かめる」も押せない(サーバーも 409 で断る)
    await chooseTestRequest(page, 'ゆっくり進めて');
    await page.getByRole('button', { name: '送る' }).click();
    await expect(page.getByRole('region', { name: '作る AI', exact: true }).getByRole('button', { name: '止める' })).toBeVisible();
    await expect(checkBand.getByRole('button', { name: AGAIN })).toBeDisabled();
    await openCheck(page);
    await expect(section.getByRole('button', { name: CHECK })).toBeDisabled();
    const refused = await studio.post(`/api/projects/${id}/checks`, {});
    expect(refused.status).toBe(409);
    // 段 7 では、次の一手の帯の弱いボタン「止める」で止める(作る AI の欄の「止める」と同じ操作。ui-ux-v2.md の 4.3)
    await page.getByRole('region', { name: '次の一手' }).getByRole('button', { name: '止める' }).click();
    await goStage(page, '作る');
    await expect(items(page).last().locator('.run-status')).toHaveText('止めました', { timeout: 15_000 });
    await expect(checkBand.getByRole('button', { name: AGAIN })).toBeEnabled();
  } finally {
    await studio.stop();
  }
});

test.describe('本物の AI で確かめる', () => {
  test.skip(process.platform === 'win32', '偽の claude をシェルから起動するため');

  // 求人相談の写し。シナリオは、本物の AI でも出る文だけを確かめる(お試しの AI の注意書きは見ない)
  async function writeRealProject(home) {
    const root = path.join(home, 'projects', 'check-real');
    await fs.cp(path.join(ROOT, 'samples', 'job-consult', 'app'), path.join(root, 'app'), { recursive: true });
    await fs.writeFile(
      path.join(root, 'app', 'scenarios', 'talk-and-narrow.json'),
      JSON.stringify({
        name: '希望を話すと、返事が来る',
        viewport: 'desktop',
        steps: [
          { do: 'type', target: { label: 'メッセージ' }, text: '確かめの発言です。カフェで働きたいです' },
          { do: 'click', target: { role: 'button', name: '送る' } },
          { expect: 'text', target: { region: '会話' }, contains: '偽の Claude Code です' },
          { expect: 'noErrors' },
        ],
      }),
    );
    const manifest = path.join(root, 'app', 'prototype.json');
    await fs.writeFile(manifest, JSON.stringify({ ...(await readJson(manifest)), title: '確かめの見本(架空)' }));
    await fs.mkdir(path.join(root, '.studio'), { recursive: true });
    await fs.writeFile(path.join(root, '.studio', 'project.json'), JSON.stringify({ title: '確かめの見本' }));
    return root;
  }

  const readCalls = async (file) => (await fs.readFile(file, 'utf8').catch(() => '')).split('\n').filter(Boolean).map((line) => JSON.parse(line));

  test('同意の前はカードが出て確かめない。やめると確かめず、同意すると 1 回の観察を本物の AI で回す', async ({ page, home }) => {
    test.setTimeout(90_000);
    const root = await writeRealProject(home);
    const log = path.join(home, 'fake-claude.jsonl');
    const studio = await launchStudio(home, { env: { STUDIO_CLAUDE_BIN: FAKE, FAKE_CLAUDE_LOG: log, ANTHROPIC_API_KEY: undefined } });
    try {
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(studio.url);
      await chooseProject(page);
      const section = await openCheck(page);
      await section.getByRole('radio', { name: /本物の AI/ }).check();
      await section.getByRole('button', { name: CHECK }).click();

      // 同意の前: 引き出しにカードが出て、確かめは始まらない。偽の CLI も起動しない
      const card = section.getByRole('group', { name: CARD });
      await expect(card).toBeVisible();
      await expect(card).toContainText('AI は、あなたの Claude Code で動きます。');
      expect(await checksOf(studio, 'check-real')).toEqual([]);
      expect(await readCalls(log)).toEqual([]);

      // やめると、確かめない
      await card.getByRole('button', { name: 'やめる' }).click();
      await expect(card).toBeHidden();
      await expect(section.getByRole('status')).toHaveText('本物の AI で確かめるには、同意が要ります。お試しの AI なら、同意なしで確かめられます。');
      expect(await checksOf(studio, 'check-real')).toEqual([]);

      // 同意すると、確かめる
      await section.getByRole('button', { name: CHECK }).click();
      await card.getByRole('button', { name: '同意して使う' }).click();
      await expect(card).toBeHidden();
      await closeMore(page);
      const checkItem = checkItems(page);
      await expect(checkItem.locator('.bubble.user')).toHaveText('あなた試作品を自動で確かめる(試作品の中の AI: 本物の AI)');
      await expect(band(checkItem).locator('.run-status')).toHaveText(PASSED, { timeout: 60_000 });

      const checks = await checksOf(studio, 'check-real');
      expect(checks).toHaveLength(1);
      expect(checks[0].connection).toBe('claude-code');
      const report = await readJson(path.join(root, checks[0].report));
      expect(report.ai[0].connection.kind).toBe('claude-code');
      // 偽の CLI が、シナリオの発言で呼ばれた(本物の AI の口を通った)
      const calls = await readCalls(log);
      expect(calls.some((call) => call.stdin.includes('確かめの発言です'))).toBe(true);
      // 試す欄の試作品の中の AI は、お試しのまま
      expect((await studio.api('/api/projects/check-real/ai')).session.connection.kind).toBe('mock');
    } finally {
      await studio.stop();
    }
  });

  async function chooseProject(page) {
    await page.locator('#project-menu-button').click();
    await page.getByRole('navigation', { name: '試作品の一覧', includeHidden: true }).getByRole('button', { name: /確かめの見本/ }).click();
    await expect(page.locator('iframe[title="試作品"]')).toHaveAttribute('src', /\/p\/check-real\//);
    await expect(page.frameLocator('iframe[title="試作品"]').getByRole('heading', { name: 'しおかぜ求人相談' })).toBeVisible();
  }
});
