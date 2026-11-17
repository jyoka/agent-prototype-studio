import fs from 'node:fs/promises';
import path from 'node:path';
import { ROOT, SAMPLES, chooseProject, chooseSample, expect, expectNoDevWordsOnScreen, launchStudio, openMeasureTab, test } from './studio.js';

// 実行の記録と比べる表を主の画面に出す(task 423。docs/design/ai-architecture-review.md の 15 節)。
// 試す欄の下の「1 ターンの記録」と「場面の一覧と比べる表」。お試しの AI(モック)で回す。
// 本物の AI は偽の claude(test/fixtures/fake-claude.js)で、実モデルは呼ばない。題材は架空のしおかぜ便の運送約款(samples/terms-help)

const FAKE = path.join(ROOT, 'test', 'fixtures', 'fake-claude.js');
const SAMPLE = path.join(ROOT, 'samples', 'terms-help');
const TITLE = 'しおかぜ便の約款の相談(架空)';

// RAG ありの構成(既定)と、RAG なしの構成(compare/ から写す。docs/usage.md の手順と同じ)を並べた試作品
async function placeTermsHelp(home) {
  const root = path.join(home, 'projects', 'terms-help');
  await fs.cp(path.join(SAMPLE, 'app'), path.join(root, 'app'), { recursive: true });
  for (const dir of ['compositions', 'mocks', 'prompts']) await fs.cp(path.join(SAMPLE, 'compare', dir), path.join(root, 'app', dir), { recursive: true });
  await fs.mkdir(path.join(root, '.studio'), { recursive: true });
  await fs.writeFile(path.join(root, '.studio', 'project.json'), JSON.stringify({ title: TITLE }));
  return root;
}

function fakeEnv(home) {
  return {
    STUDIO_CLAUDE_BIN: FAKE,
    FAKE_CLAUDE_LOG: path.join(home, 'fake-claude.jsonl'),
    ANTHROPIC_API_KEY: undefined,
    ANTHROPIC_AUTH_TOKEN: undefined,
    ANTHROPIC_BASE_URL: undefined,
    CLAUDE_CODE_USE_BEDROCK: undefined,
    CLAUDE_CODE_USE_VERTEX: undefined,
    CLAUDE_CODE_USE_FOUNDRY: undefined,
  };
}

// 偽の claude を呼んだ回数(FAKE_CLAUDE_LOG の行の数。--version と auth status は数えない)
const modelCalls = async (home) => (await fs.readFile(path.join(home, 'fake-claude.jsonl'), 'utf8').catch(() => '')).split('\n').filter(Boolean).length;

async function openScenes(page) {
  // 一覧の名前は、題名の「(架空)」を外し、AI と話せるかを添えたもの
  await chooseProject(page, 'しおかぜ便の約款の相談(架空・AI と話せる)');
  await expect(page.locator('iframe[title="試作品"]')).toHaveAttribute('src', /\/p\/terms-help\//);
  // 段 6「測る」の右の列の「場面」のタブ。比べる表は「比べる」のタブにある
  await openMeasureTab(page, '場面');
  await expect(page.locator('#scene-runs-summary')).toContainText('場面の一覧(4 本');
  return page.locator('#measure');
}

test('画面から場面を回すと、構成ごとの比べる表が出る。通らない場面の「直す」で、作る AI の欄に依頼が入る', async ({ page, home }) => {
  const root = await placeTermsHelp(home);
  const studio = await launchStudio(home);
  try {
    await page.goto(studio.url);
    const box = await openScenes(page);
    await expect(box).toContainText('回す場面(4 本、構成 2 つ)。まだ回していません。');
    // 回す前は、どの場面も「○ まだ回していない」(「✓ 通った」と違う印と文)
    const scenes = box.getByRole('list', { name: '場面ごとの結果' }).getByRole('listitem');
    await expect(scenes).toHaveCount(4);
    for (const scene of await scenes.all()) {
      await expect(scene).toHaveAttribute('data-state', 'todo');
      await expect(scene.locator('.scene-mark')).toHaveText('○');
      await expect(scene.locator('.scene-word')).toHaveText('まだ回していない');
    }
    await expect(page.getByRole('tab', { name: /^場面/ })).toHaveText('場面 4 つ・まだ');

    await box.getByRole('button', { name: '場面を回す(お試しの AI)' }).click();
    // 場面のタブの名前に数を添える。組をまたいで、1 つの組でも通らなければ通らない
    await expect(page.getByRole('tab', { name: /^場面/ })).toHaveText('場面 2/4 通った');
    await expect(page.getByRole('tab', { name: /^比べる/ })).toHaveText('比べる 2 組');
    const passed = box.locator('.scene-state[data-state="ok"]');
    await expect(passed).toHaveCount(2);
    await expect(passed.first().locator('.scene-mark')).toHaveText('✓');
    await expect(passed.first().locator('.scene-word')).toHaveText('通った');
    const failing = box.locator('.scene-state[data-state="failed"]');
    await expect(failing).toHaveCount(2);
    await expect(failing.first().locator('.scene-mark')).toHaveText('×');
    // 次の一手の帯は「1 つ目から直す」
    await expect(page.locator('#next-text')).toHaveText('2 つの場面が通りませんでした。これを見つけるのが試す目的です。');
    await expect(page.getByRole('region', { name: '次の一手' }).getByRole('button', { name: '1 つ目から直す' })).toBeVisible();

    // 比べるタブ: 構成ごとの表。同じ場面で測ったかを表の上に書き、AI の判断(採点)は測った数と別の列
    await openMeasureTab(page, '比べる');
    await expect(page.locator('#compare-basis')).toHaveText('どの組も、同じ 4 本の場面で測りました。');
    const table = box.getByRole('table', { name: '構成ごとの比べる表' });
    await expect(table.locator('tbody tr')).toHaveCount(2);
    await expect(table.locator('thead th')).toHaveText(['構成', '回した AI', '通った場面(測った数)', '道具の呼び方の正しさ(ツールの再現率)', 'AI の判断: 自然さの採点', '費用', '待ち時間(返事の中央値)']);
    await expect(box).toContainText('お試しの AI で回した');
    await expect(box).toContainText('形が動くかの確かめだけで、構成の良し悪しの根拠にしません');
    const withRag = table.locator('tbody tr').nth(0);
    const withoutRag = table.locator('tbody tr').nth(1);
    await expect(withRag.locator('th')).toContainText('RAG あり: 約款を探して読む(架空)');
    await expect(withRag.locator('td')).toHaveText(['お試しの AI', '4 / 4', /^確かめる場面なし\(呼んだ \d+ 回、誤った呼び出し 0\)$/, /^(採点する場面なし|採点していません\(\d+ つ\))$/, 'かかりません', '測れません(お試しの AI)']);
    await expect(withoutRag.locator('th')).toContainText('RAG なし: 約款を読まない(架空)');
    await expect(withoutRag.locator('th')).toContainText('compositions/no-rag.json');
    await expect(withoutRag.locator('td').nth(1)).toHaveText('0 / 2(通らない 2)(当てはまらない 2)');
    // 測った数と AI の判断は別の列。AI の判断の列は、頭に「AI の判断」と書き、点線で分ける
    await expect(table.locator('thead th[data-judge]')).toHaveText('AI の判断: 自然さの採点');
    await expect(withRag.locator('td[data-judge]')).toHaveCount(1);
    for (const theme of ['light', 'dark']) {
      await page.emulateMedia({ colorScheme: theme });
      await page.waitForTimeout(300);
      await page.screenshot({ path: path.join(ROOT, 'test-results', 'ux', `measure-compare-${theme}.png`) });
    }
    await page.emulateMedia({ colorScheme: 'light' });
    await expectNoDevWordsOnScreen(page);

    // 通らない場面と「ここから直す」。作る AI の欄を開き、場面の名前を入れた頼む文で始める
    await openMeasureTab(page, '場面');
    await expect(failing.first()).toContainText('terms-damage');
    await expect(failing.first()).toContainText('構成「RAG なし: 約款を読まない(架空)」: 通らなかった。確かめ「replyContains」: 期待 返事に「30 万円」がある');
    await failing.first().getByRole('button', { name: 'ここから直す' }).click();
    const request = page.getByRole('region', { name: '作る AI', exact: true }).getByLabel('依頼');
    await expect(request).toBeFocused();
    await expect(page.locator('#measure')).toBeHidden();
    await expect(page.locator('#side-back')).toHaveText('← 測るに戻る');
    await expect(request).toHaveValue(/^場面「terms-damage」\(.+\)が、構成「RAG なし: 約款を読まない\(架空\)」をお試しの AI で回したときに通りませんでした。\n- 確かめ「replyContains」: 期待 返事に「30 万円」がある/);
    await expect(request).toHaveValue(/場面の一覧と守り\(ガードレール\)は弱めずに、AI の作り\(プロンプト、ツール、決まった返事\)を直して、この場面が通るようにしてください。$/);
    // 依頼は欄に入れるだけで、送るのは人。作る AI はまだ動かない
    await expect(page.getByRole('list', { name: '作る会話' }).locator('.run')).toHaveCount(0);

    // 結果は npm run evals と同じ所に残る
    const runs = (await fs.readdir(path.join(root, '.studio', 'evals'))).filter((name) => name !== 'ledger.jsonl');
    expect(runs).toHaveLength(1);
    await expect(fs.readFile(path.join(root, '.studio', 'evals', runs[0], 'report.md'), 'utf8')).resolves.toContain('## 比べる表');
    await expectNoDevWordsOnScreen(page);

    // 開き直しても、一番新しい表が出る
    await page.reload();
    const again = await openScenes(page);
    await openMeasureTab(page, '比べる');
    await expect(again.getByRole('table', { name: '構成ごとの比べる表' }).locator('tbody tr')).toHaveCount(2);
  } finally {
    await studio.stop();
  }
});

test('守りが止めたターンでは、試す欄の下の 1 ターンの記録に、止めた層と参加者と道具と時間と費用が出る。試作品の画面(見せる画面に出すもの)には出ない', async ({ page, home }) => {
  const studio = await launchStudio(home);
  try {
    await page.goto(studio.url);
    await chooseSample(page, SAMPLES.partTime);
    // 段 6「測る」の「この 1 ターン」のタブ。1 回の操作で開ける
    const panel = await openMeasureTab(page, 'この 1 ターン');
    const record = page.getByRole('region', { name: '1 ターンの記録' });
    // まだ話していなければ出さない
    await expect(record).toBeHidden();
    await expect(panel).toContainText('まだ話していません。');
    const app = page.frameLocator('iframe[title="試作品"]');
    const message = app.getByLabel('メッセージ');
    const say = async (text) => {
      await message.fill(text);
      await app.getByRole('button', { name: '送る' }).click();
      await expect(message).toHaveValue('');
    };
    await say('詳しく見せて');
    await expect(record).toContainText('発言「詳しく見せて」(お試しの AI。');
    await expect(record.getByRole('list', { name: '呼んだ道具' })).toContainText('get_job(そよかぜの案内役(模擬) が呼んだ): ');

    // 同意の前の保存は、ツールの守り(requires)が止める
    await say('そのまま保存して');
    await expect(record).toContainText('発言「そのまま保存して」');
    await expect(record.getByRole('list', { name: '働いた参加者' })).toHaveText('そよかぜの案内役(模擬): エージェント(道具を選びながら自分で進める AI)');
    await expect(record.getByRole('list', { name: '呼んだ道具' })).toHaveText('save_wish(そよかぜの案内役(模擬) が呼んだ): ツールの守り(コードが止める)が止めた');
    const guards = record.getByRole('list', { name: '守りの層' });
    await expect(guards.locator('li[data-effect="blocked"]')).toHaveText('ツールの守り(コードが止める)「requires」(save_wish): 止めた');
    await expect(guards).toContainText('プロンプトの頼み(モデル頼み)「no-contact-ask」: 頼んだ');
    await expect(guards).toContainText(/ほかに通した守り \d+ つ/);
    await expect(record).toContainText(/時間と費用\s*[\d.]+ 秒、費用はかかりません\(お試しの AI\)/);
    // この 1 ターンの流れ(ui-ux-v2.md の 4.2): 時刻(等幅)、者の形、部品の種類、平たい 1 文。形はモデル(▲)と守り(⬢)の行にだけ
    const timeline = record.getByRole('list', { name: 'この 1 ターンの流れ' }).getByRole('listitem');
    await expect(timeline.first().locator('.tl-time')).toHaveText('0.00');
    expect(await timeline.first().locator('.tl-time').evaluate((el) => getComputedStyle(el).fontFamily)).toMatch(/monospace|Menlo|SFMono/);
    for (const row of await record.locator('.timeline-row[data-kind="code"], .timeline-row[data-kind="tool"]').all()) await expect(row.locator('.tl-shape')).toHaveText('');
    await expect(record.locator('.timeline-row[data-kind="model"]').first().locator('.tl-shape')).toHaveText('▲');
    // 守りが止めた行は ⬢ と「止めました」。続く行で、失敗ではなく守りが働いた印だと言い、止めた層の名前を出す。失敗の × は使わない
    const blocked = record.locator('.timeline-row[data-kind="guard"][data-effect="blocked"]');
    await expect(blocked).toHaveCount(1);
    await expect(blocked.locator('.tl-shape')).toHaveText('⬢');
    await expect(blocked.locator('.tl-kind')).toHaveText('守り');
    await expect(blocked.locator('.tl-text')).toHaveText('止めました: save_wish');
    await expect(blocked).not.toContainText('×');
    await expect(blocked.locator('+ .timeline-row')).toHaveText(/止めたのはツールの守り。失敗ではなく、守りが働いた印です。/);
    await expectNoDevWordsOnScreen(page);
    for (const theme of ['light', 'dark']) {
      await page.emulateMedia({ colorScheme: theme });
      await page.waitForTimeout(300);
      await page.screenshot({ path: path.join(ROOT, 'test-results', 'ux', `measure-turn-${theme}.png`) });
    }
    await page.emulateMedia({ colorScheme: 'light' });

    // 記録は Studio の画面にだけある。試作品の画面(お客さんに見せる画面 #391 が出すもの)には、記録も守りの名前も出ない
    const view = (await studio.api('/api/projects')).projects.find((p) => p.id === SAMPLES.partTime.id);
    const shown = await page.context().newPage();
    await shown.goto(view.previewUrl);
    await expect(shown.getByRole('region', { name: '会話' })).toBeVisible();
    const text = await shown.locator('body').innerText();
    for (const word of ['1 ターンの記録', '守りの層', 'requires', '比べる表', '参加者']) expect(text).not.toContain(word);
    await shown.close();
    await expect(app.locator('[data-studio-only]')).toHaveCount(0);
    await expect(app.getByText('1 ターンの記録')).toHaveCount(0);
  } finally {
    await studio.stop();
  }
});

test('本物の AI で回すときは、同意の前に本物の AI を呼ばない。同意すると費用の上限を付けて回し、表に費用が出る', async ({ page, home }) => {
  test.setTimeout(90_000);
  await placeTermsHelp(home);
  const studio = await launchStudio(home, { env: fakeEnv(home) });
  try {
    await page.goto(studio.url);
    const box = await openScenes(page);
    await expect(box).toContainText('本物の AI で回すと、場面の発言ごとに試作品の中の AI を呼び、費用がかかります。');
    await box.getByLabel('費用の上限(USD)').fill('0.5');
    await box.getByRole('button', { name: '本物の AI で回す' }).click();
    const card = box.getByRole('group', { name: '本物の AI を使う前に' });
    await expect(card).toBeVisible();
    await expect(card.getByRole('list', { name: '送るもの' })).toContainText('場面の一覧の発言と、試作品の中の AI の設定(本物の AI で場面を回すとき)');
    // 同意の前: 偽の claude は 1 回も呼ばれず、結果も残らない。API でも断る
    expect(await modelCalls(home)).toBe(0);
    const refused = await studio.post('/api/projects/terms-help/scenes/run', { connection: 'claude-code', limitUsd: 0.5 });
    expect(refused.status).toBe(403);
    expect(JSON.parse(refused.text).error.code).toBe('consent-required');
    // やめると回さない
    await card.getByRole('button', { name: 'やめる' }).click();
    await expect(card).toBeHidden();
    await expect(box).toContainText('本物の AI で回すには、同意が要ります。お試しの AI なら、同意なしで回せます。');
    expect(await modelCalls(home)).toBe(0);
    expect((await studio.api('/api/real-ai')).consent.agreed).toBe(false);

    // 同意すると回す。上限は欄に書いた 0.5 USD
    await box.getByRole('button', { name: '本物の AI で回す' }).click();
    await card.getByRole('button', { name: '同意して使う' }).click();
    const table = box.getByRole('table', { name: '構成ごとの比べる表' });
    await expect(box).toContainText('本物の AI で回した', { timeout: 60_000 });
    await expect(box).toContainText('上限 0.50 USD');
    await expect(box).toContainText('自然さは採点していません');
    await openMeasureTab(page, '比べる');
    await expect(table.locator('tbody tr')).toHaveCount(2);
    const first = table.locator('tbody tr').first();
    await expect(first.locator('td').first()).toHaveText('本物の AI(claude-sonnet-5-5。代わりのモデル)');
    await expect(first.locator('td').nth(4)).toHaveText(/^\d+\.\d+ USD\(1 会話 \d+\.\d+ USD\)$/);
    await expect(first.locator('td').nth(5)).toHaveText(/^[\d.]+ 秒$/);
    expect(await modelCalls(home)).toBeGreaterThan(0);
    await expectNoDevWordsOnScreen(page);

    // 上限が小さいと、最初の返事の後で止まる。止めた理由は平たい言葉で出し、元の文(CLI の引数の名前)は開発者向けの中にだけ置く
    await openMeasureTab(page, '場面');
    await box.getByLabel('費用の上限(USD)').fill('0.001');
    await box.getByRole('button', { name: '本物の AI で回す' }).click();
    await expect(box).toContainText('使った費用が上限に達したので、次の返事を始めずに止めました', { timeout: 60_000 });
    await expect(box).not.toContainText('回した後に場面の一覧が変わった');
    await expectNoDevWordsOnScreen(page);
    await openMeasureTab(page, '比べる');
    await box.getByText('開発者向け: 止めた理由の元の文').click();
    await expect(box).toContainText('--limit-usd 0.001');
  } finally {
    await studio.stop();
  }
});
