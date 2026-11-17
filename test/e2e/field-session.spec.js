import fs from 'node:fs/promises';
import path from 'node:path';
import { ROOT, expect, expectNoDevWords, launchStudio, openMeasureTab, startShowing, test } from './studio.js';

// 現場の場面の通し(docs/design/user-journey.md の K6、docs/design/field-session.md の 2 節と 6 節)。
// 架空の台本(しおかぜ便の会の要点を順に打つ)で、会の始めから会の終わりまでを 1 台の PC の形で通す。
// 作る AI も、整理する AI と案を出す AI も、偽接続(STUDIO_AGENT=fake。偽の claude の src/agent/fake-claude.js)で、実モデルは呼ばない。
// 試作品の中の AI と場面の回しは、お試しの AI。人物、会社、題材は、どれも架空

const UX_SHOTS = path.join(ROOT, 'test-results', 'ux');
const PURPOSE = 'しおかぜ便(架空)の再配達の受付を考える会';

// 台本。進行役が聞き、操作役が打つ要点(field-session.md の 1 節と 2 節。架空)
const SCRIPT = [
  '再配達の受付を、電話なしで済ませたい',
  'お年寄りのお客さんも多い',
  '夕方に電話が集中する',
  '再配達の受付は、その日の 17 時まで',
  '不在票に荷物の番号がある',
  '「荷物はいつ届くか」の電話も多い',
  '受付の担当は 2 人で回している',
  '不在票を見て、今日の夜に届けてほしい人がいる',
  '17 時を過ぎたら翌日の受付にする',
  '受けた依頼は、お届け先と希望の日時を一覧に書いている',
];
const COLUMNS = ['要求', '使う人', '場面', '決まりごと', 'データ'];
// 目的の文書(J1)。聞き出しの画面は test/e2e/intent.spec.js が確かめるので、決めた中身を先に入れる
const INTENT = {
  who: '荷物を受け取る人と、受付の担当(架空)',
  problem: '再配達と「いつ届くか」の電話で、受付が手いっぱい',
  scene: '不在票を見た夕方',
  success: '再配達の受付が電話なしで済む',
  notDoing: ['料金の払い戻しの受付'],
  undecided: [],
};
const HEADING = 'しおかぜ便 再配達の受付';
const STAGES = ['start', 'listen', 'organize', 'review', 'prototype', 'show', 'fix', 'closing'];

const readJson = async (file) => JSON.parse(await fs.readFile(file, 'utf8'));
const timelineFile = (home, id) => path.join(home, 'projects', id, '.studio', 'timeline.json');
const stagesOf = async (home, id) => (await readJson(timelineFile(home, id)).catch(() => ({ stages: {} }))).stages;

test('台本を会の始めから会の終わりまで通すと、7 つの成果物がそろい、段ごとの時刻と測った時間が残る', async ({ page, home }) => {
  test.setTimeout(300_000);
  const studio = await launchStudio(home);
  try {
    // ---- 段 0. 始める(会の始めの画面。K4) ----
    await page.goto(studio.url);
    await page.locator('#project-menu-button').click();
    await page.getByRole('button', { name: 'お客さんとの会を始める' }).click();
    await page.getByLabel('会の目的').fill(PURPOSE);
    await page.getByRole('button', { name: '会を用意する' }).click();
    const meetingMark = page.locator('#meeting-mark');
    await expect(meetingMark).toHaveText('会: 同意の前');
    const id = (await studio.api('/api/projects')).projects.find((project) => project.meeting.status !== 'none').id;
    // 流れの 7 段が、どれも今の Studio で通る(「まだ作っていません」がない)
    const facts = page.locator('#meeting-facts');
    await expect(facts.locator('ol li')).toHaveText(['聞く', 'AI が整理する', 'AI 構成の審査', '試作品', '見せて、コメントをもらう', '承認して AI が直す', '要件の文書と引き継ぎ']);
    await expect(page.locator('#meeting')).not.toContainText('まだ作っていません');
    // 同意の前は、時刻を残さない
    expect(await stagesOf(home, id)).toEqual({});
    await page.getByRole('button', { name: '同意して始める' }).click();
    await expect(meetingMark).toHaveText('会: 同意した');
    expect(Object.keys(await stagesOf(home, id))).toEqual(['start']);

    // ---- 段 1 と 2. 聞く、AI が整理する(整理の板。K1) ----
    const board = page.locator('#organize');
    await expect(board).toBeVisible();
    const point = page.getByLabel('聞いた要点');
    for (const [index, text] of SCRIPT.entries()) {
      await point.fill(text);
      await point.press('Enter');
      await expect(page.getByRole('list', { name: '打った要点' }).getByRole('listitem')).toHaveCount(index + 1);
    }
    await page.getByRole('button', { name: '整理する', exact: true }).click();
    for (const name of COLUMNS) await expect(page.getByRole('region', { name, exact: true }).locator('.organize-item').first()).toBeVisible();
    // 話に出ていない項目(推測)を、お客さんと確かめる
    const guess = board.locator('.organize-item').filter({ has: page.getByText('推測', { exact: true }) });
    await expect(guess).toHaveCount(1);
    await guess.getByRole('button', { name: 'この項目は合っている' }).click();
    await expect(board.locator('.organize-item').filter({ has: page.getByText('推測', { exact: true }) })).toHaveCount(0);
    await page.getByRole('button', { name: 'この理解で合っている' }).click();
    await expect(page.locator('#organize-mark')).toHaveText('整理: 確かめた');
    await expect.poll(async () => Object.keys(await stagesOf(home, id))).toEqual(['start', 'listen', 'organize']);

    // 目的の文書(J1)
    expect((await studio.post(`/api/projects/${id}/intent/start`, { sentence: PURPOSE, guide: 'fixed', depth: 'quick' })).status).toBe(200);
    expect((await studio.post(`/api/projects/${id}/intent/decide`, { doc: INTENT })).status).toBe(200);

    // ---- 段 3. AI 構成の審査(設計の案内 J2、データの段 K2、審査 #422) ----
    await page.locator('#design-mark').click();
    await page.getByRole('button', { name: '案を作る' }).click();
    const heading = page.locator('#design-step-heading');
    const choose = (title) => page.getByRole('button', { name: `「${title}」を選ぶ` });
    const next = page.getByRole('button', { name: '次の段へ' });
    await expect(heading).toContainText('問題');
    await choose('問い合わせの数を減らす').click();
    await next.click();
    await choose('問い合わせるお客さん').click();
    await next.click();
    await choose('よくある問い合わせと困る場面').click();
    await next.click();
    await expect(heading).toContainText('データ');
    await choose('お店と問い合わせに分ける').click();
    // 整理の板のデータの欄が、全部データ設計に載る
    const coverage = page.getByRole('list', { name: '整理の板のデータの欄' }).getByRole('listitem');
    await expect(coverage).not.toHaveCount(0);
    for (const entry of await coverage.all()) await expect(entry).toHaveAttribute('data-placed', 'true');
    await next.click();
    await choose('固定の流れ').click();
    await next.click();
    await choose('Web の相談画面').click();
    await page.getByRole('button', { name: 'この設計で作る' }).click();

    // 会の中では、harness とデータと RAG は進行役と決める人の 2 人が承認する。1 台の形では、決める人が声に出し、進行役が押す
    await expect(page.getByRole('heading', { level: 2, name: 'AI 構成の審査' })).toBeVisible();
    // 承認は次の一手の帯で、読んでいる欄から順に押す。帯の 1 文の下に、押した人と「声に出した人」の欄
    const review = page.locator('#review');
    const band = page.getByRole('region', { name: '次の一手' });
    await expect(page.locator('#review-spoken')).toBeVisible();
    for (const name of ['エージェントの構成を進行役として承認する', 'harness を進行役として承認する', 'harness を決める人として承認する', 'データと RAG を進行役として承認する', 'データと RAG を決める人として承認する', '技術の組を進行役として承認する']) {
      await band.getByRole('button', { name, exact: true }).click();
    }
    await expect(page.locator('#review-count')).toHaveText('承認 4 / 4');
    await expectNoDevWords(review);
    await page.getByRole('button', { name: 'この構成で作る' }).click();
    await expect(review).toBeHidden();

    // ---- 段 4. 試作品(作る AI と自動の確かめ) ----
    await expect.poll(async () => (await studio.api(`/api/projects/${id}/build-requests`)).runs.at(-1)?.status, { timeout: 90_000 }).toBe('passed');
    await expect.poll(async () => Object.keys(await stagesOf(home, id))).toEqual(['start', 'listen', 'organize', 'review', 'prototype']);
    const app = page.frameLocator('iframe[title="試作品"]');
    await expect(app.locator('h1')).toBeVisible({ timeout: 30_000 });

    // ---- 段 5. 見せて、コメントをもらう(見せる画面 J7、コメント K3) ----
    await startShowing(page);
    const show = page.getByRole('region', { name: '確かめたい問い' });
    await expect(show).toBeVisible();
    await expect(show).toContainText('再配達の受付が電話なしで済む');
    const comments = page.getByRole('region', { name: 'コメント' });
    await comments.getByLabel('コメント', { exact: true }).fill(`見出しを「${HEADING}」にして`);
    await comments.getByRole('radio', { name: '見た目と動き' }).check();
    await comments.getByRole('button', { name: 'コメントを書く' }).click();
    await expect(page.locator('#comment-status')).toContainText('を書きました。承認するまで、作る AI には送りません。');
    const first = comments.getByRole('list', { name: 'コメントの一覧' }).locator(':scope > li').first();
    await first.getByRole('button', { name: /に反応を付ける/ }).click();
    await expect.poll(async () => Object.keys(await stagesOf(home, id))).toContain('show');

    // ---- 段 6. 承認して AI が直す ----
    await comments.getByLabel('押した人').fill('早瀬(進行役、架空)');
    await comments.getByLabel('声に出した人').fill('野上(決める人、架空)');
    await first.getByRole('button', { name: '決める人として承認' }).click();
    await expect(first).toContainText('確かめる', { timeout: 90_000 });
    await expect(app.getByRole('heading', { name: HEADING })).toBeVisible();
    await first.getByRole('button', { name: '直った' }).click();
    await expect(first).toContainText('直った');
    await expect.poll(async () => Object.keys(await stagesOf(home, id))).toContain('fix');
    await page.getByRole('button', { name: '見せ終わる' }).click();
    await expect(show).toBeHidden();

    // 場面の一覧を、直った版でお試しの AI で回す
    const scenes = await openMeasureTab(page, '場面');
    await scenes.getByRole('button', { name: '場面を回す(お試しの AI)' }).click();
    await expect(page.getByRole('tab', { name: /^比べる \d+ 組$/ })).toBeVisible({ timeout: 60_000 });
    const compare = await openMeasureTab(page, '比べる');
    await expect(compare.getByRole('table', { name: '構成ごとの比べる表' })).toBeVisible();

    // ---- 段 7. 要件の文書と引き継ぎ(会の終わり。K5) ----
    await meetingMark.click();
    await page.getByRole('button', { name: '会の終わりへ' }).click();
    await expect(page.getByRole('heading', { level: 2, name: '会の終わり' })).toBeVisible();
    // 未決事項を読み上げ、全部に持ち主と期日を付ける
    const open = page.getByRole('list', { name: '未決事項の持ち主と期日' }).getByRole('listitem');
    await expect(open).not.toHaveCount(0);
    const count = await open.count();
    for (let i = 0; i < count; i += 1) {
      await open.nth(i).getByLabel('持ち主').fill(i % 2 === 0 ? '進行役' : '決める人');
      await open.nth(i).getByLabel('期日').fill('2026-11-25');
      await open.nth(i).getByRole('button', { name: '決める' }).click();
      await expect(open.nth(i).getByLabel('持ち主')).toHaveValue(i % 2 === 0 ? '進行役' : '決める人');
    }
    await expect(page.locator('#closing-unowned')).toBeHidden();

    // 7 つの成果物が、全部そろう
    const deliverables = page.getByRole('list', { name: '7 つの成果物' }).getByRole('listitem');
    await expect(deliverables.locator('strong')).toHaveText(['要件の文書', 'データ設計', '構成の図', 'AI 構成書', '試作品', '場面の一覧', '未決事項']);
    await expect(deliverables.locator('.closing-state')).toHaveText(Array(7).fill('そろった'));

    // 段ごとの時刻。書き出す前は、会の終わりだけがまだ
    const table = page.getByRole('table', { name: '段ごとの時刻' });
    await expect(table.locator('tr[data-reached="true"]')).toHaveCount(7);
    await expect(table.locator('tr[data-stage="closing"]')).toHaveAttribute('data-reached', 'false');
    const measures = page.getByRole('list', { name: '測った時間' }).getByRole('listitem');
    await expect(measures.first()).toContainText(/^見せられるまでの時間: \d+ (秒|分 \d+ 秒)/);
    await expect(measures.nth(1)).toContainText(/^承認から直った版まで: コメント 1 は \d+ (秒|分 \d+ 秒)/);
    await expectNoDevWords(page.locator('#meeting'));

    // 書き出す。書き出しが会の終わりの印になる
    await page.getByRole('button', { name: '書き出す' }).click();
    await expect(page.locator('#closing-exported')).toContainText('書き出しました');
    await expect(table.locator('tr[data-reached="true"]')).toHaveCount(8);
    await page.screenshot({ path: path.join(UX_SHOTS, 'K6-closing.png'), fullPage: true });

    // 段ごとの時刻が記録に残る。段の順に並ぶ
    const stages = await stagesOf(home, id);
    expect(Object.keys(stages).sort()).toEqual([...STAGES].sort());
    const times = STAGES.map((key) => Date.parse(stages[key]));
    expect(times.every((time, i) => i === 0 || time >= times[i - 1]), JSON.stringify(stages)).toBe(true);

    // 書き出しに、7 つの成果物と段ごとの時刻と測った時間が入る
    const dir = await page.locator('#closing-exported code').innerText();
    const manifest = await readJson(path.join(dir, 'handoff.json'));
    expect(manifest.closing.deliverables.map((item) => item.status)).toEqual(Array(7).fill('ready'));
    expect(manifest.closing.unowned).toBe(0);
    const { timeline } = manifest.closing;
    expect(timeline.reached).toBe(8);
    expect(timeline.stages.map((stage) => stage.key)).toEqual(STAGES);
    expect(timeline.stages.find((stage) => stage.key === 'closing').at).toBe(stages.closing);
    expect(timeline.toShowMs).toBe(Date.parse(stages.prototype) - Date.parse(stages.start));
    expect(timeline.fixes).toHaveLength(1);
    expect(timeline.fixes[0]).toMatchObject({ comment: 1 });
    expect(timeline.fixes[0].ms).toBeGreaterThanOrEqual(0);
    const readme = await fs.readFile(path.join(dir, 'README.md'), 'utf8');
    expect(readme).toContain('### 段ごとの時刻');
    expect(readme).toContain('見せられるまでの時間(同意から、自動の確かめが通った最初の試作品まで)');
    // 実際にかかった時間を、テストの記録に残す(人の確かめの目安と比べる元)
    test.info().annotations.push({ type: '見せられるまで', description: `${timeline.toShowMs} ms` }, { type: '承認から直った版まで', description: `${timeline.fixes[0].ms} ms` });
  } finally {
    await studio.stop();
  }
});
