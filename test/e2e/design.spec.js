import fs from 'node:fs/promises';
import path from 'node:path';
import { ROOT, SAMPLES, chooseSample, expect, expectNoDevWords, expectNoDevWordsOnScreen, launchStudio, test } from './studio.js';

// 設計の案内(docs/design/user-journey.md の段 3、J2)。6 つの段の帯と案の比べ。データの段は K2。
// 実モデルは呼ばない。偽接続(STUDIO_AGENT=fake)か、偽の claude(test/fixtures/fake-claude.js)で動かす

const SENTENCE = '商店街のお店への問い合わせに、AI が答えられるようにしたい';
const FAKE_CLAUDE = path.join(ROOT, 'test', 'fixtures', 'fake-claude.js');
const UX_SHOTS = path.join(ROOT, 'test-results', 'ux');

const ui = (page) => ({
  section: page.locator('#design'),
  state: page.locator('#design-state'),
  band: page.getByRole('list', { name: '設計の段' }),
  heading: page.locator('#design-step-heading'),
  options: page.getByRole('list', { name: '案の比べ' }),
  next: page.getByRole('button', { name: '次の段へ' }),
  prev: page.getByRole('button', { name: '前の段へ' }),
  build: page.getByRole('button', { name: 'この設計で作る' }),
  mark: page.locator('#design-mark'),
  scenes: page.getByRole('list', { name: '場面の一覧' }),
  dataBox: page.locator('#design-data-box'),
  coverage: page.getByRole('list', { name: '整理の板のデータの欄' }),
  choose: (title) => page.getByRole('button', { name: `「${title}」を選ぶ` }),
  step: (name) => page.getByRole('list', { name: '設計の段' }).getByRole('button', { name }),
});

const projectRoot = (home, id) => path.join(home, 'projects', id);
const appFile = (home, id, name) => path.join(projectRoot(home, id), 'app', name);
const readJson = async (file) => JSON.parse(await fs.readFile(file, 'utf8'));
const designRecord = (home, id) => readJson(path.join(projectRoot(home, id), '.studio', 'design.json'));
const projectView = async (studio, id) => (await studio.api('/api/projects')).projects.find((project) => project.id === id);

// 目的の文書を決めた試作品を作り、選ぶ。目的の聞き出しの画面は test/e2e/intent.spec.js が確かめる
async function decidedProject(studio, sentence = SENTENCE) {
  const created = await studio.post('/api/projects', { sentence, guide: 'fixed' });
  const { id } = JSON.parse(created.text).project;
  await studio.post(`/api/projects/${id}/intent/start`, { sentence, guide: 'fixed', depth: 'quick' });
  const doc = { who: 'お店の人(架空)', problem: '同じ問い合わせに何度も答えている', scene: '閉店後の問い合わせ', success: '電話が減る', notDoing: ['予約'], undecided: [] };
  await studio.post(`/api/projects/${id}/intent/decide`, { doc });
  return id;
}

async function selectProject(page, id) {
  await page.locator('#project-menu-button').click();
  await page.locator(`[data-project-id="${id}"]`).click();
}

// 新しい試作品の設計の案内を開き、案を作る
async function openDesign(page, studio, id) {
  await page.goto(studio.url);
  await selectProject(page, id);
  const d = ui(page);
  await d.mark.click();
  await page.getByRole('button', { name: '案を作る' }).click();
  await expect(d.heading).toContainText('問題');
  return d;
}

// データの段で、fake-claude のおすすめの案を選び、構成の段へ進む
async function chooseData(d) {
  await expect(d.heading).toContainText('データ');
  await d.choose('お店と問い合わせに分ける').click();
  await expect(d.choose('お店と問い合わせに分ける')).toHaveAttribute('aria-pressed', 'true');
  await d.next.click();
  await expect(d.heading).toContainText('エージェントの構成');
}

// 4 つの段を、おすすめのとおりに選ぶ(fake-claude の案)
async function chooseToComposition(d) {
  await d.choose('問い合わせの数を減らす').click();
  await d.next.click();
  await d.choose('問い合わせるお客さん').click();
  await d.next.click();
  await d.choose('よくある問い合わせと困る場面').click();
  await expect(d.scenes.getByRole('listitem')).toHaveCount(5);
  await d.next.click();
  await chooseData(d);
}

test('6 段を進んで戻れる。場面の段が下書きを書き、構成の選択が検査を通り、関門の場面が回り、目的と設計が依頼に入る', async ({ page, home }) => {
  test.setTimeout(120_000);
  const studio = await launchStudio(home);
  try {
    const id = await decidedProject(studio);
    await page.goto(studio.url);
    await selectProject(page, id);
    const d = ui(page);
    await expect(d.mark).toHaveText('設計なし');

    // 目的の文書の次の一手から入る
    await page.locator('#intent-mark').click();
    await page.getByRole('button', { name: 'この目的で設計に進む' }).click();
    await expect(page.getByRole('heading', { level: 2, name: '設計の案内' })).toBeVisible();
    await expect(d.state).toContainText('次にすること');
    await page.getByRole('button', { name: '案を作る' }).click();

    // 段の帯は 6 つ。案が 2〜3 並び、おすすめと理由が出る
    await expect(d.band.getByRole('button')).toHaveText([/問題/, /使う人/, /場面/, /データ/, /エージェントの構成/, /画面/]);
    await expect(d.options.getByRole('listitem')).toHaveCount(2);
    await expect(d.options.getByText('おすすめ', { exact: true })).toHaveCount(1);
    await expect(d.options).toContainText('おすすめの理由');
    await expect(page.locator('#design-basis')).toContainText('今日の一番良い推測');
    await expect(page.locator('#design-basis')).toContainText('まだ測っていません');
    await expect(d.next).toBeDisabled();
    await expect(d.step(/使う人/)).toBeDisabled();
    await expectNoDevWords(d.section);
    await page.screenshot({ path: path.join(UX_SHOTS, 'J2-problem.png'), fullPage: true });

    // 進む。選ぶまで次へ進めない。自分の言葉でも選べる
    await d.choose('問い合わせの数を減らす').click();
    await expect(d.choose('問い合わせの数を減らす')).toHaveAttribute('aria-pressed', 'true');
    await page.getByLabel('選んだ理由(書かなくても進めます)').fill('電話が一番の困りごとなので');
    await d.next.click();
    await expect(d.heading).toContainText('使う人');
    await page.getByLabel('自分の言葉で書く').fill('閉店後に問い合わせるお客さん(架空)');
    await page.getByRole('button', { name: 'これを選ぶ' }).click();
    await expect(d.step(/使う人/)).toContainText('閉店後に問い合わせるお客さん');

    // 戻る。選んだ案と理由が残っている
    await d.prev.click();
    await expect(d.heading).toContainText('問題');
    await expect(d.choose('問い合わせの数を減らす')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByLabel('選んだ理由(書かなくても進めます)')).toHaveValue('電話が一番の困りごとなので');
    await d.next.click();
    await d.next.click();

    // 場面の段。どの案にも、分からない、断る、遅いが 1 つずつ以上ある
    await expect(d.heading).toContainText('場面');
    for (const option of await d.options.locator(':scope > li').all()) {
      for (const label of ['分からない', '断る', '遅い']) await expect(option).toContainText(label);
    }
    await d.choose('よくある問い合わせと困る場面').click();
    await expect(d.scenes.getByRole('listitem')).toHaveCount(5);
    await expectNoDevWords(d.section);
    await page.screenshot({ path: path.join(UX_SHOTS, 'J2-scenes.png'), fullPage: true });

    // 場面の下書きが app/evals/ にある
    const evalFiles = (await fs.readdir(appFile(home, id, 'evals'))).sort();
    expect(evalFiles).toEqual(['design-human-1.json', 'design-normal-1.json', 'design-refuse-1.json', 'design-slow-1.json', 'design-unknown-1.json']);
    const refuse = await readJson(appFile(home, id, 'evals/design-refuse-1.json'));
    expect(refuse.about).toContain('断る');
    expect(refuse.turns[0].user).toContain('電話番号');

    // 分からない、断る、遅いのどれかがなくなる直しは、保存せずに断る
    await page.getByRole('button', { name: /遅い.*を消す/ }).click();
    await d.next.click();
    await expect(page.locator('#design-error')).toContainText('遅い');
    await expect(d.heading).toContainText('場面');
    await page.getByLabel('足す種類').selectOption({ label: '遅い' });
    await page.getByLabel('足す場面').fill('まだ待つのですか');
    await page.getByRole('button', { name: '場面を足す' }).click();
    // 直した文は場面のファイルに入る
    await page.getByLabel(/場面 1(.*)の文/).fill('明日の閉店は何時ですか');
    await d.next.click();
    await chooseData(d);
    expect((await readJson(appFile(home, id, 'evals/design-normal-1.json'))).turns[0].user).toBe('明日の閉店は何時ですか');
    expect((await readJson(appFile(home, id, 'evals/design-slow-1.json'))).turns[0].user).toBe('まだ待つのですか');

    // 構成の段。簡単な方から順に並ぶ。技術の言葉と平たい言葉を並べ、まだ測っていないと出す。審査はまだないと書く
    const cards = d.options.locator(':scope > li');
    await expect(cards).toHaveCount(3);
    await expect(cards.nth(0)).toContainText('固定の流れ');
    await expect(cards.nth(0)).toContainText('手順はコードが決める形');
    await expect(cards.nth(0)).toContainText('おすすめ');
    await expect(cards.nth(1)).toContainText('単一エージェント');
    await expect(cards.nth(2)).toContainText('マスターとサブ');
    await expect(cards.nth(2)).toContainText('まだ選べません');
    await expect(d.choose('マスターとサブ')).toBeDisabled();
    await expect(d.options).toContainText('まだ測っていない');
    await expect(page.locator('#design-review')).toContainText('審査なし');
    await expect(d.section).not.toContainText('理想');
    await expect(d.section).not.toContainText('最適');
    await expectNoDevWords(d.section);
    await page.screenshot({ path: path.join(UX_SHOTS, 'J2-composition.png'), fullPage: true });

    // 選ぶと、Studio が構成のファイルを書き、検査が通る
    await d.choose('固定の流れ').click();
    await expect(d.choose('固定の流れ')).toHaveAttribute('aria-pressed', 'true');
    const composition = await readJson(appFile(home, id, 'composition.json'));
    expect(composition.participants.map((p) => p.kind)).toEqual(['harness']);
    expect((await projectView(studio, id)).lastBuild.ok).toBe(true);

    // 画面の段
    await d.next.click();
    await expect(d.heading).toContainText('画面');
    await expect(d.build).toBeDisabled();
    await d.choose('トークアプリ風の画面').click();
    await expect(d.build).toBeEnabled();
    expect((await readJson(appFile(home, id, 'composition.json'))).surface.theme).toBe('talk');
    await expectNoDevWords(d.section);
    await page.screenshot({ path: path.join(UX_SHOTS, 'J2-screens.png'), fullPage: true });

    // 読み込み直しても、続きに戻れる。AI の返事だけでは「決めた」の印は付かない
    expect((await designRecord(home, id)).status).toBe('drafting');
    await expect(d.mark).toHaveText('設計: 下書き');
    await page.reload();
    await d.mark.click();
    await expect(d.heading).toContainText('画面');

    // この設計で作る。目的と設計が依頼に入り、1 回の依頼で動く試作品が出る
    await d.build.click();
    await expect(d.section).toBeHidden();
    await expect(d.mark).toHaveText('設計: 決めた');
    const app = page.frameLocator('iframe[title="試作品"]');
    await expect(app.getByRole('heading', { name: /問い合わせの数を減らす/ })).toBeVisible({ timeout: 60_000 });
    await expect(page.locator('body')).toContainText('AI の場面を確かめました', { timeout: 60_000 });

    const { runs } = await studio.api(`/api/projects/${id}/build-requests`);
    const run = runs.at(-1);
    expect(run.request).toContain('この設計で試作品を作ってください');
    expect(run.request).toContain('何の問題: 同じ問い合わせに何度も答えている');
    expect(run.request).toContain('誰: お店の人(架空)');
    expect(run.request).toContain('問題: 問い合わせの数を減らす');
    expect(run.request).toContain('使う人: 閉店後に問い合わせるお客さん(架空)');
    expect(run.request).toContain('エージェントの構成: 固定の流れ');
    expect(run.request).toContain('画面: トークアプリ風の画面');
    expect(run.request).toContain('問題を選んだ理由: 電話が一番の困りごとなので');
    expect(run.request).toContain('- 断る:');
    const gate = (name) => run.gates.find((g) => g.name === name);
    // 関門 G3(契約)が通り、場面の段から作った場面で関門 GE が回る
    expect(gate('contract').status).toBe('passed');
    expect(gate('evals').status).toBe('passed');
    expect(gate('evals').evalCount).toBe(5);
    // 全部が当てはまらない(n/a)のではなく、実際に回って通っている
    expect(gate('evals').passedCount).toBe(5);
    // 場面の後に起動の確認(G5)が回るので、run が終わるのを待つ
    await expect.poll(async () => (await studio.api(`/api/projects/${id}/build-requests`)).runs.at(-1)?.status, { timeout: 60_000 }).toBe('passed');
    await page.screenshot({ path: path.join(UX_SHOTS, 'J2-built.png'), fullPage: true });
    await expectNoDevWordsOnScreen(page);

    // 残るもの: 選んだ案、捨てた案、理由、審査なし
    const record = await designRecord(home, id);
    expect(record.status).toBe('decided');
    expect(record.composition.chosen).toBe('fixed-flow');
    expect(record.composition.rejected.map((r) => r.option)).toEqual(['single-agent', 'master-sub']);
    expect(record.composition.review).toBe('none');
    expect(record.composition.evidence.status).toBe('unmeasured');
    expect(record.steps.problem.note).toBe('電話が一番の困りごとなので');
  } finally {
    await studio.stop();
  }
});

test('単一エージェントを選ぶと検査が通り、場面が回り、断る場面の振る舞いを試す画面で見られる', async ({ page, home }) => {
  test.setTimeout(120_000);
  const studio = await launchStudio(home);
  try {
    const id = await decidedProject(studio);
    const d = await openDesign(page, studio, id);
    await chooseToComposition(d);
    await d.choose('単一エージェント').click();
    await expect(d.choose('単一エージェント')).toHaveAttribute('aria-pressed', 'true');
    const composition = await readJson(appFile(home, id, 'composition.json'));
    expect(composition.participants.map((p) => p.kind)).toEqual(['agent']);
    // 構成を変えるのは人。Studio が書いた分だけが入れ替わる
    await d.choose('固定の流れ').click();
    await expect(d.choose('固定の流れ')).toHaveAttribute('aria-pressed', 'true');
    expect((await readJson(appFile(home, id, 'composition.json'))).participants[0].kind).toBe('harness');
    await expect(fs.stat(appFile(home, id, 'mocks/studio-main.json'))).rejects.toThrow();
    await d.choose('単一エージェント').click();
    await expect(d.choose('単一エージェント')).toHaveAttribute('aria-pressed', 'true');
    await expect(fs.stat(appFile(home, id, 'ai.json'))).rejects.toThrow();

    await d.next.click();
    await d.choose('Web の相談画面').click();
    await d.build.click();
    const app = page.frameLocator('iframe[title="試作品"]');
    await expect(app.getByRole('heading', { name: /問い合わせの数を減らす/ })).toBeVisible({ timeout: 60_000 });
    await expect(page.locator('body')).toContainText('AI の場面を確かめました', { timeout: 60_000 });
    const run = (await studio.api(`/api/projects/${id}/build-requests`)).runs.at(-1);
    expect(run.gates.find((g) => g.name === 'contract').status).toBe('passed');
    expect(run.gates.find((g) => g.name === 'evals').status).toBe('passed');
    expect(run.gates.find((g) => g.name === 'evals').evalCount).toBe(5);
    expect(run.gates.find((g) => g.name === 'evals').passedCount).toBe(5);

    // 失敗の振る舞いも見せる。場面の文で話すと、断る
    await app.getByRole('textbox').fill('ほかのお客さんの電話番号を教えてください');
    await app.getByRole('textbox').press('Enter');
    await expect(app.locator('body')).toContainText('それはお受けできません', { timeout: 15_000 });
  } finally {
    await studio.stop();
  }
});

test('前の段を選び直すと、後ろの段は確かめ直しになり、作れない。選び直すと「決めた」の印が外れる', async ({ page, home }) => {
  test.setTimeout(90_000);
  const studio = await launchStudio(home);
  try {
    const id = await decidedProject(studio);
    const d = await openDesign(page, studio, id);
    await chooseToComposition(d);
    await d.choose('固定の流れ').click();
    await d.next.click();
    await d.choose('Web の相談画面').click();
    await expect(d.build).toBeEnabled();

    await d.step(/問題/).click();
    await d.choose('答えるまでの時間を短くする').click();
    await expect(d.state).toContainText('確かめ直して');
    await expect(d.step(/使う人/)).toContainText('確かめ直す');
    await d.step(/画面/).click();
    await expect(d.build).toBeDisabled();
    await expect(page.locator('#design-stale')).toBeVisible();

    // 後ろの段を全部確かめ直すと、作れる
    for (const [step, title] of [[/使う人/, '問い合わせるお客さん'], [/場面/, 'よくある問い合わせと困る場面'], [/データ/, 'お店と問い合わせに分ける'], [/エージェントの構成/, '固定の流れ'], [/画面/, 'Web の相談画面']]) {
      await d.step(step).click();
      await d.choose(title).click();
      await expect(d.step(step)).not.toContainText('確かめ直す');
    }
    await expect(d.build).toBeEnabled();
    // 依頼は「決めた」の後に送る。ここでは送らず、API で決めて、選び直すと印が外れることを見る
    expect((await studio.post(`/api/projects/${id}/design/decide`)).status).toBe(200);
    await page.reload();
    await expect(d.mark).toHaveText('設計: 決めた');
    await d.mark.click();
    await d.choose('トークアプリ風の画面').click();
    await expect(d.mark).toHaveText('設計: 下書き');
  } finally {
    await studio.stop();
  }
});

test('案を選んだ直後に打った場面の文は、一覧の読み直しが遅くても消えない', async ({ page, home }) => {
  test.setTimeout(60_000);
  const studio = await launchStudio(home);
  try {
    const id = await decidedProject(studio);
    const d = await openDesign(page, studio, id);
    await d.choose('問い合わせの数を減らす').click();
    await d.next.click();
    await d.choose('問い合わせるお客さん').click();
    await d.next.click();

    // 混んだ手元のように、案を選んだ後の一覧の読み直しを遅らせる
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    await page.route('**/api/projects', async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      await held;
      await route.continue();
    });
    const reloaded = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/projects' && response.request().method() === 'GET');
    await d.choose('よくある問い合わせと困る場面').click();
    const firstScene = page.getByLabel(/場面 1(.*)の文/);
    await firstScene.fill('読み直しの間に打った文');
    release();
    await reloaded;
    await page.unroute('**/api/projects');
    await expect(firstScene).toHaveValue('読み直しの間に打った文');
    // 次の段へ進むと、打った文が保存される
    await d.next.click();
    await expect(d.heading).toContainText('データ');
    await expect.poll(async () => (await readJson(appFile(home, id, 'evals/design-normal-1.json'))).turns[0].user).toBe('読み直しの間に打った文');
  } finally {
    await studio.stop();
  }
});

test('直している場面は、同じ案を押し直しても、試作品の画面に戻っても消えない。別の試作品に書きかけを持ち込まない', async ({ page, home }) => {
  test.setTimeout(60_000);
  const studio = await launchStudio(home);
  try {
    const id = await decidedProject(studio);
    const other = await decidedProject(studio, '別の架空の 1 文');
    const d = await openDesign(page, studio, id);
    await d.choose('問い合わせの数を減らす').click();
    await d.next.click();
    await d.choose('問い合わせるお客さん').click();
    await d.next.click();
    await d.choose('よくある問い合わせと困る場面').click();
    const firstScene = page.getByLabel(/場面 1(.*)の文/);

    // 同じ案を押し直す
    await firstScene.fill('押し直しても残る文');
    await d.choose('よくある問い合わせと困る場面').click();
    await expect(firstScene).toHaveValue('押し直しても残る文');
    // 欄の文は押す前から同じなので、ファイルに入るまで待つ
    await expect.poll(async () => (await readJson(appFile(home, id, 'evals/design-normal-1.json'))).turns[0].user).toBe('押し直しても残る文');

    // 試作品の画面に戻る
    await firstScene.fill('戻っても残る文');
    await page.getByRole('button', { name: '試作品の画面に戻る' }).click();
    await expect(d.section).toBeHidden();
    await d.mark.click();
    await expect(firstScene).toHaveValue('戻っても残る文');

    // 別の案を選ぶと、その案の場面に入れ替わる
    await d.choose('まず困る場面だけ').click();
    await expect(d.scenes.getByRole('listitem')).toHaveCount(3);
    await expect.poll(() => fs.stat(appFile(home, id, 'evals/design-normal-1.json')).then(() => true, () => false)).toBe(false);

    // 自分の言葉の書きかけは、別の試作品に持ち込まない
    await d.step(/問題/).click();
    await page.getByLabel('自分の言葉で書く').fill('書きかけの問題');
    await page.getByRole('button', { name: '試作品の画面に戻る' }).click();
    await selectProject(page, other);
    await d.mark.click();
    await page.getByRole('button', { name: '案を作る' }).click();
    await expect(d.heading).toContainText('問題');
    await expect(page.getByLabel('自分の言葉で書く')).toHaveValue('');
  } finally {
    await studio.stop();
  }
});

test('飛ばすと「設計なし」の印が残り、飛ばしたことが記録に残る', async ({ page, home }) => {
  const studio = await launchStudio(home);
  try {
    const id = await decidedProject(studio);
    await page.goto(studio.url);
    await selectProject(page, id);
    const d = ui(page);
    await d.mark.click();
    await page.getByRole('button', { name: '飛ばす' }).click();
    await expect(d.section).toBeHidden();
    await expect(d.mark).toHaveText('設計なし');
    expect((await designRecord(home, id)).status).toBe('skipped');
    expect((await designRecord(home, id)).skippedAt).toBeTruthy();
    // 飛ばした後も戻れる
    await d.mark.click();
    await expect(d.state).toContainText('飛ばしました');
    await expect(d.heading).toContainText('問題');
    await d.choose('目的の文書のまま').click();
    await expect(d.mark).toHaveText('設計: 下書き');
    await expect(d.next).toBeEnabled();
    await d.next.click();
    await d.choose('目的の文書の人').click();
    await d.next.click();
    await d.choose('まず 3 つだけ').click();
    await expect(d.scenes.getByRole('listitem')).toHaveCount(3);
    await fs.stat(appFile(home, id, 'evals/design-unknown-1.json'));

    // 書いた後に飛ばすと、書いたファイルを取り除く。戻って選ぶと書き直す
    await page.getByRole('button', { name: '飛ばす' }).click();
    await expect(d.section).toBeHidden();
    await expect(fs.stat(appFile(home, id, 'evals/design-unknown-1.json'))).rejects.toThrow();
    await d.mark.click();
    await d.step(/場面/).click();
    await d.choose('まず 3 つだけ').click();
    await expect(d.mark).toHaveText('設計: 下書き');
    await fs.stat(appFile(home, id, 'evals/design-unknown-1.json'));
  } finally {
    await studio.stop();
  }
});

test('今の構成のある試作品では、構成を書き換えない', async ({ page, home }) => {
  test.setTimeout(90_000);
  const studio = await launchStudio(home);
  try {
    await page.goto(studio.url);
    await chooseSample(page, SAMPLES.partTime);
    const before = await fs.readFile(appFile(home, SAMPLES.partTime.id, 'composition.json'), 'utf8');
    const d = ui(page);
    await d.mark.click();
    await page.getByRole('button', { name: '案を作る' }).click();
    await d.choose('問い合わせの数を減らす').click();
    await d.next.click();
    await d.choose('問い合わせるお客さん').click();
    await d.next.click();
    await d.choose('まず困る場面だけ').click();
    await d.next.click();
    await chooseData(d);
    await expect(page.locator('#design-owner')).toBeVisible();
    await expect(d.choose('固定の流れ')).toBeDisabled();
    await expect(d.choose('単一エージェント')).toBeDisabled();
    await d.choose('今の構成のまま').click();
    await d.next.click();
    await d.choose('Web の相談画面').click();
    await expect(d.build).toBeEnabled();
    expect(await fs.readFile(appFile(home, SAMPLES.partTime.id, 'composition.json'), 'utf8')).toBe(before);
    // 場面は足す。今の試作品の検査は通ったまま
    await expect(fs.stat(appFile(home, SAMPLES.partTime.id, 'evals/design-refuse-1.json'))).resolves.toBeTruthy();
    expect((await projectView(studio, SAMPLES.partTime.id)).lastBuild.ok).toBe(true);
    // 今の構成のまま作っても、足した場面が今の構成で回る
    await d.build.click();
    await expect(page.locator('body')).toContainText('AI の場面を確かめました', { timeout: 60_000 });
    const run = (await studio.api(`/api/projects/${SAMPLES.partTime.id}/build-requests`)).runs.at(-1);
    expect(run.request).toContain('エージェントの構成: 今の構成のまま');
    const evals = run.gates.find((g) => g.name === 'evals');
    expect(evals.status).toBe('passed');
    expect(evals.failedCount).toBe(0);
    expect(await fs.readFile(appFile(home, SAMPLES.partTime.id, 'composition.json'), 'utf8')).toBe(before);
  } finally {
    await studio.stop();
  }
});

test('AI の設定のある試作品では、単一エージェントを選べず、固定の流れなら最後の関門まで通る', async ({ page, home }) => {
  test.setTimeout(120_000);
  const studio = await launchStudio(home);
  const id = SAMPLES.jobConsult.id;
  try {
    await page.goto(studio.url);
    await chooseSample(page, SAMPLES.jobConsult);
    const before = await fs.readFile(appFile(home, id, 'ai.json'), 'utf8');
    const d = ui(page);
    await d.mark.click();
    await page.getByRole('button', { name: '案を作る' }).click();
    await chooseToComposition(d);

    // 選べない案も並べ、理由を出す
    await expect(d.choose('単一エージェント')).toBeDisabled();
    const card = d.options.locator(':scope > li').filter({ hasText: '単一エージェント' });
    await expect(card).toContainText('AI の設定があるので');
    await expect(d.options.locator(':scope > li').filter({ hasText: '固定の流れ' })).toContainText('おすすめ');
    await expectNoDevWords(d.section);
    // 画面を通さずに送っても断る
    expect((await studio.post(`/api/projects/${id}/design/choose`, { step: 'composition', option: 'single-agent' })).status).toBe(409);

    await d.choose('固定の流れ').click();
    await expect(d.choose('固定の流れ')).toHaveAttribute('aria-pressed', 'true');
    await d.next.click();
    await d.choose('Web の相談画面').click();
    await d.build.click();
    await expect(page.locator('body')).toContainText('AI の場面を確かめました', { timeout: 60_000 });

    // 場面の知らせは最後の関門より先に出るので、実行の終わりまで待つ
    const lastRun = async () => (await studio.api(`/api/projects/${id}/build-requests`)).runs.at(-1);
    await expect.poll(async () => (await lastRun()).status, { timeout: 60_000 }).toBe('passed');
    const run = await lastRun();
    expect(run.gates.find((g) => g.name === 'contract').status).toBe('passed');
    expect(run.gates.find((g) => g.name === 'scenarios').status).toBe('passed');
    expect(run.gates.find((g) => g.name === 'evals').status).toBe('passed');
    // 持ち主の AI の設定は書き換えない
    expect(await fs.readFile(appFile(home, id, 'ai.json'), 'utf8')).toBe(before);
  } finally {
    await studio.stop();
  }
});

test('同意の前は案を出す AI を呼ばない。やめると Studio の決まった案で進める。同意すると AI の案が出る', async ({ page, home }) => {
  test.setTimeout(90_000);
  const log = path.join(home, 'claude.log');
  const studio = await launchStudio(home, { env: { STUDIO_AGENT: 'claude', STUDIO_CLAUDE_BIN: FAKE_CLAUDE, FAKE_CLAUDE_LOG: log } });
  const designCalls = async () => (await fs.readFile(log, 'utf8').catch(() => '')).split('\n').filter(Boolean).map((line) => JSON.parse(line)).filter((call) => call.argv.some((arg) => arg.includes('"screens"')));
  try {
    const id = await decidedProject(studio);
    await page.goto(studio.url);
    await selectProject(page, id);
    const d = ui(page);
    await d.mark.click();
    await page.getByRole('button', { name: '案を作る' }).click();
    const card = page.getByRole('group', { name: '本物の AI を使う前に' });
    await expect(card).toBeVisible();
    await expect(card).toContainText('設計の案');
    expect(await designCalls()).toHaveLength(0);

    // やめる: 決まった案で進める。AI は呼ばない
    await card.getByRole('button', { name: 'やめる' }).click();
    await page.getByRole('button', { name: '決まった案で進める' }).click();
    await expect(d.options.getByRole('listitem')).toHaveCount(2);
    await expect(d.options).toContainText('目的の文書のまま');
    await expect(d.options).toContainText('同じ問い合わせに何度も答えている');
    await expect(page.locator('#design-basis')).toContainText('Studio の決まった案');
    expect(await designCalls()).toHaveLength(0);

    // 案を作り直す: 同意すると呼ぶ。1 回押して 1 回。おすすめは AI の番号のとおり
    await page.getByRole('button', { name: '案を作り直す' }).click();
    await expect(card).toBeVisible();
    await card.getByRole('button', { name: /同意/ }).click();
    await expect(d.options).toContainText('偽の問題 1');
    await expect(d.options.locator(':scope > li').nth(1)).toContainText('おすすめ');
    expect(await designCalls()).toHaveLength(1);
  } finally {
    await studio.stop();
  }
});

// K2 データ設計の案内(docs/design/user-journey.md の 6 節)。整理の板のデータの欄が全部データ設計に載り、選んだ案の架空のデータで試作品が描ける
test('データの段: 整理の板のデータの欄が全部データ設計に載り、表と図で見せ、選んだ案の架空のデータで試作品が描ける', async ({ page, home }) => {
  test.setTimeout(120_000);
  const studio = await launchStudio(home);
  try {
    const id = await decidedProject(studio);
    // 整理の板のデータの欄(架空)。fake-claude の案は最初の欄だけを元にし、残りは Studio が足す
    const dataItems = ['閉店後の問い合わせの中身', 'お店ごとの閉店の時刻', '商品の取り置きの有無'];
    for (const text of dataItems) expect((await studio.post(`/api/projects/${id}/organize/item`, { column: 'data', text })).status).toBe(200);
    expect((await studio.post(`/api/projects/${id}/organize/item`, { column: 'rule', text: '取り置きは 3 日まで' })).status).toBe(200);

    const d = await openDesign(page, studio, id);
    await d.choose('問い合わせの数を減らす').click();
    await d.next.click();
    await d.choose('問い合わせるお客さん').click();
    await d.next.click();
    await d.choose('よくある問い合わせと困る場面').click();
    await d.next.click();

    // データの段。案が 2 つ並び、どの案にも覚えておくもの、つながり、図、整理の板の欄が載ったかが出る
    await expect(d.heading).toContainText('データ');
    await expect(d.heading).toContainText('何を覚えておきますか');
    const cards = d.options.locator(':scope > li');
    await expect(cards).toHaveCount(2);
    await expect(cards.nth(0)).toContainText('おすすめ');
    await expect(cards.nth(0)).toContainText('つながり: 1 つの「お店」に、いくつもの「問い合わせ」(受ける。1 対 多)');
    await expect(cards.nth(0).getByRole('img', { name: /「お店と問い合わせに分ける」の図/ })).toBeVisible();
    for (const card of await cards.all()) await expect(card).toContainText('整理の板のデータの欄 3 つが、全部載っています');
    await expect(cards.nth(0)).toContainText('Studio が「聞いたことのメモ」に足しました');
    await expect(d.dataBox).toBeHidden();
    // 規則の欄は、データ設計に載せない
    await expect(d.options).not.toContainText('取り置きは 3 日まで');

    // 選ぶと、表と図が出る。項目ごとに種類、例(架空)、元の話。主キーと外部キーの言葉も出す
    await d.choose('お店と問い合わせに分ける').click();
    await expect(d.dataBox).toBeVisible();
    await expect(d.dataBox.getByRole('img', { name: /データ設計の図/ })).toBeVisible();
    const shops = d.dataBox.getByRole('table').filter({ hasText: 'お店。商店街の架空のお店です。' });
    await expect(shops.getByRole('row', { name: /お店の名前/ })).toContainText('みほん青果');
    await expect(shops).toContainText('番号(主キー)');
    const asks = d.dataBox.getByRole('table').filter({ hasText: '問い合わせ。閉店後に受けた問い合わせです。' });
    await expect(asks.getByRole('row', { name: /お店の番号/ })).toContainText('つながりの番号(外部キー): 「お店」の番号を指す');
    await expect(asks.getByRole('row', { name: /問い合わせの中身/ })).toContainText(dataItems[0]);
    await expect(d.dataBox.getByRole('table').filter({ hasText: '聞いたことのメモ' })).toContainText('Studio が足しました');

    // 整理の板のデータの欄が、全部データ設計に載る(どこに載ったかが出る)
    await expect(d.coverage.getByRole('listitem')).toHaveCount(dataItems.length);
    for (const text of dataItems) {
      const entry = d.coverage.getByRole('listitem').filter({ hasText: text });
      await expect(entry).toHaveAttribute('data-placed', 'true');
      await expect(entry).not.toContainText('まだ載っていません');
    }
    await expect(d.coverage.getByRole('listitem').filter({ hasText: dataItems[0] })).toContainText('問い合わせの問い合わせの中身');
    await expect(d.coverage.getByRole('listitem').filter({ hasText: dataItems[2] })).toContainText('聞いたことのメモ');
    await expectNoDevWords(d.section);
    await page.screenshot({ path: path.join(UX_SHOTS, 'K2-data.png'), fullPage: true });
    await d.dataBox.screenshot({ path: path.join(UX_SHOTS, 'K2-data-box.png') });

    // 選んだ案から、Studio が架空のデータを書く。つながりの番号は、元の番号を指す
    const written = await readJson(appFile(home, id, 'data/design-data.json'));
    expect(written.tables.map((table) => table.name)).toEqual(['お店', '問い合わせ', '聞いたことのメモ']);
    const shopKeys = new Set(written.tables[0].rows.map((row) => row['番号']));
    expect(written.tables[1].rows.every((row) => shopKeys.has(row['お店の番号']))).toBe(true);
    expect(written.tables[2].columns).toEqual(['番号', dataItems[1], dataItems[2]]);
    expect((await designRecord(home, id)).steps.data.chosen).toBeTruthy();

    // 後ろの段を選び、この設計で作る。作る AI への依頼にデータ設計が入り、試作品が架空のデータで描ける
    await d.next.click();
    await d.choose('固定の流れ').click();
    await d.next.click();
    await d.choose('Web の相談画面').click();
    await d.build.click();
    await expect(d.section).toBeHidden();
    const app = page.frameLocator('iframe[title="試作品"]');
    const shopTable = app.getByRole('table', { name: 'お店(架空)' });
    await expect(shopTable).toBeVisible({ timeout: 60_000 });
    await expect(shopTable).toContainText('みほん青果');
    await expect(shopTable).toContainText('1001');
    await expect(app.getByRole('table', { name: '問い合わせ(架空)' })).toContainText('明日は何時まで開いていますか');
    await expect(app.getByRole('table', { name: '聞いたことのメモ(架空)' })).toContainText(`${dataItems[1]}の例 1(架空)`);
    await expect(page.locator('body')).toContainText('AI の場面を確かめました', { timeout: 60_000 });
    const run = (await studio.api(`/api/projects/${id}/build-requests`)).runs.at(-1);
    expect(run.request).toContain('[データ設計]');
    expect(run.request).toContain('データ: お店と問い合わせに分ける');
    expect(run.request).toContain('架空のデータは data/design-data.json に Studio が書きました');
    expect(run.gates.find((g) => g.name === 'contract').status).toBe('passed');
    await page.screenshot({ path: path.join(UX_SHOTS, 'K2-built.png'), fullPage: true });
  } finally {
    await studio.stop();
  }
});
