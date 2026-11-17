import fs from 'node:fs/promises';
import path from 'node:path';
import { expect, expectNoDevWords, expectReadableText, launchStudio, ROOT, test } from './studio.js';

// AI 構成の審査(docs/design/ai-architecture-review.md、task 422)。4 つの承認がそろうまで作る AI が起動しない。
// 選び直すと承認が消える。承認後に構成を変えると関門 GA で止まり、審査に戻る。
// 実モデルは呼ばない。偽の claude(test/fixtures/fake-claude.js と src/agent/fake-claude.js)か、偽接続(STUDIO_AGENT=fake)で動かす

const SENTENCE = '架空の町の図書館で、本の取り置きの問い合わせに AI が答えられるようにしたい';
const UX_SHOTS = path.join(ROOT, 'test-results', 'ux');
const STEPS = ['problem', 'users', 'scenes', 'data', 'composition', 'screens'];

const readJson = async (file) => JSON.parse(await fs.readFile(file, 'utf8'));
const projectRoot = (home, id) => path.join(home, 'projects', id);

// 案を出す AI は偽の claude(test/fixtures/fake-claude.js)、作る AI は偽の作る AI(src/agent/fake-claude.js)。
// STUDIO_AGENT を書かない起動(手元の Claude Code を使う既定)と同じ道を通り、同意も本物と同じく要る
async function writeFakeClaude(home) {
  const bin = path.join(home, 'bin', 'claude');
  await fs.mkdir(path.dirname(bin), { recursive: true });
  const node = `"${process.execPath}"`;
  const cli = `"${path.join(ROOT, 'test', 'fixtures', 'fake-claude.js')}"`;
  const fixer = `"${path.join(ROOT, 'src', 'agent', 'fake-claude.js')}"`;
  await fs.writeFile(bin, ['#!/bin/sh', `case "$1" in --version|auth) exec ${node} ${cli} "$@";; esac`, `case "$*" in *--json-schema*) exec ${node} ${cli} "$@";; esac`, `exec ${node} ${fixer} "$@"`, ''].join('\n'), { mode: 0o755 });
  return bin;
}

async function decidedProject(studio) {
  const created = await studio.post('/api/projects', { sentence: SENTENCE, guide: 'fixed' });
  const { id } = JSON.parse(created.text).project;
  await studio.post(`/api/projects/${id}/intent/start`, { sentence: SENTENCE, guide: 'fixed', depth: 'quick' });
  const doc = { who: '図書館の利用者(架空)', problem: '取り置きの問い合わせに何度も答えている', scene: '開館前の問い合わせ', success: '電話が減る', notDoing: ['貸し出しの手続き'], undecided: [] };
  await studio.post(`/api/projects/${id}/intent/decide`, { doc });
  return id;
}

// 設計の 6 段を API で選ぶ。構成は composition、ほかは AI のおすすめ
async function chooseAll(studio, id, composition) {
  for (const step of STEPS) {
    const { design } = await studio.api(`/api/projects/${id}/design`);
    const options = design.steps.find((item) => item.id === step).options;
    const option = step === 'composition' ? composition : (options.find((item) => item.recommended) ?? options[0]).id;
    const result = await studio.post(`/api/projects/${id}/design/choose`, { step, option });
    expect(result.status, result.text).toBe(200);
  }
  await studio.post(`/api/projects/${id}/design/go`, { step: 'screens' });
}

async function selectProject(page, id) {
  await page.locator('#project-menu-button').click();
  await page.locator(`[data-project-id="${id}"]`).click();
}

// 英字で終わる名前(harness、データと RAG)の後ろには空白を 1 つ置く(画面と同じ)
const spaced = (label) => (/[A-Za-z0-9]$/.test(label) ? `${label} ` : label);

// 審査の作業台(ui-ux-v2.md の 4.1)。承認のボタンは次の一手の帯にあり、読んでいる欄の名前が付く
const r = (page) => {
  const band = page.getByRole('region', { name: '次の一手' });
  const item = (label) => page.locator('#review-items').getByRole('region', { name: new RegExp(`^${label}`) });
  return {
    section: page.locator('#review'),
    count: page.locator('#review-count'),
    band,
    build: page.getByRole('button', { name: 'この構成で作る' }),
    mark: page.locator('#review-mark'),
    item,
    state: (label) => item(label).locator('.review-state'),
    reading: page.locator('#review-items .review-item[data-reading]'),
    approve: (label) => band.getByRole('button', { name: `${spaced(label)}を承認する` }),
    peek: (label) => item(label).locator('details.review-peek > summary'),
    switch: (label) => page.getByRole('group', { name: '構成を切り替える' }).getByRole('button', { name: new RegExp(`^${label}`) }),
    focused: page.locator('#review-flow .node[data-focus] .tag'),
  };
};

// ライトとダークで撮る。色の切り替えの動き(--motion-quick)が終わってから、見出しを上に合わせて撮る
async function shootThemes(page, name, top = '#review-heading') {
  for (const theme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: theme });
    await page.waitForTimeout(300);
    await page.locator(top).evaluate((el) => el.scrollIntoView({ block: 'start', behavior: 'instant' }));
    await page.screenshot({ path: path.join(UX_SHOTS, `${name}-${theme}.png`) });
  }
  await page.emulateMedia({ colorScheme: 'light' });
}

const LABELS = ['エージェントの構成', 'harness', 'データと RAG', '技術の組'];

test('4 つの承認がそろうまで作る AI が起動しない。そろうと「この構成で作る」で作り、AI 構成書に承認した人、時刻、指紋が残る', async ({ page, home }) => {
  test.setTimeout(150_000);
  test.skip(process.platform === 'win32', '偽の claude をシェルスクリプトで作るため');
  const studio = await launchStudio(home, { env: { STUDIO_AGENT: undefined, STUDIO_CLAUDE_BIN: await writeFakeClaude(home) } });
  try {
    const id = await decidedProject(studio);
    await page.goto(studio.url);
    await selectProject(page, id);
    // 案を出す AI は本物の接続。同意の前は呼ばない(今の同意のカードを通す)
    await page.locator('#design-mark').click();
    await page.getByRole('button', { name: '案を作る' }).click();
    const card = page.getByRole('group', { name: '本物の AI を使う前に' });
    await expect(card).toBeVisible();
    await card.getByRole('button', { name: /同意/ }).click();
    await expect(page.locator('#design-options')).toContainText('偽の問題');
    // 偽の claude の案のおすすめ(単一エージェント)のとおりに選ぶ
    await chooseAll(studio, id, 'single-agent');
    await page.getByRole('button', { name: '試作品の画面に戻る' }).click();
    await page.locator('#design-mark').click();
    await page.getByRole('button', { name: 'この設計で作る' }).click();

    // 審査の作業台。承認 0 / 4。4 つの欄が上から順に並び、上の 1 つだけを読んでいる。「この構成で作る」は出ない
    const v = r(page);
    await expect(page.getByRole('heading', { level: 2, name: 'AI 構成の審査' })).toBeVisible();
    await expect(v.count).toHaveText('承認 0 / 4・あと 4 つ');
    await expect(v.build).toBeHidden();
    await expect(page.locator('#review-items h3')).toHaveText([/^エージェントの構成/, /^harness/, /^データと RAG/, /^技術の組/]);
    await expect(v.reading).toHaveCount(1);
    await expect(v.state('エージェントの構成')).toHaveText('● 読んでいる');
    for (const label of LABELS.slice(1)) await expect(v.state(label)).toHaveText('○ まだ見ていない');
    // ふだんの言葉を見出しの横に置く
    await expect(v.item('harness').locator('h3')).toHaveText('harness ふだんの言葉: AI の周りの決まり');
    // おすすめ: 札、日付、根拠の場面、推測。「理想」の語は画面にない
    await expect(page.locator('#review-basis')).toHaveText(/^案は \d{4}-\d{2}-\d{2} 時点の推測です。根拠は、場面の一覧の \d+ つです。$/);

    // 1. 構成: 3 つの切り替え、図、平たい言葉、おすすめと理由と日付、根拠の場面、まだ測っていない
    const composition = v.item('エージェントの構成');
    await expect(v.switch('固定の流れ')).toBeVisible();
    await expect(v.switch('単一エージェント')).toHaveAttribute('aria-pressed', 'true');
    await expect(v.switch('マスターとサブ')).toBeEnabled();
    await expect(composition.getByRole('img')).toHaveAttribute('aria-label', /使う人.*案内役/);
    await expect(composition).toContainText('1 つの AI が道具を選んで進む形');
    const recommend = composition.locator('.review-recommend');
    await expect(recommend.locator('.badge').first()).toHaveText('おすすめ');
    await expect(recommend).toContainText('単一エージェント 推測');
    await expect(recommend).toContainText('偽の構成の理由');
    await expect(recommend).toContainText(/出した日: \d{4}-\d{2}-\d{2}/);
    await expect(recommend).toContainText('根拠の場面: design-');
    await expect(composition).toContainText('まだ測っていない');
    // 「これは何?」は閉じたまま。開くと 3 つの問い(5.2)
    const explain = composition.locator('details.explain');
    await expect(explain.locator('dl')).toBeHidden();
    await explain.locator('summary').click();
    await expect(explain.locator('dt')).toHaveText(['これは何か', '何をするのか', '次に何が起きるか']);
    await expect(explain.locator('dd').first()).toHaveText('次の一手を、コードが決めるか、モデルが決めるかです。');
    // 欄の中のボタンは、弱いボタン「言葉で直す」だけ(切り替えの群は除く)
    await expect(composition.locator('.review-item-actions button')).toHaveText(['言葉で直す']);
    await expect(composition.locator('button.primary')).toHaveCount(0);
    await expectNoDevWords(v.section);
    await expect(page.locator('body')).not.toContainText('理想');
    await expect(page.locator('body')).not.toContainText('最適');
    await expectReadableText(page, '審査(承認 0)');
    await page.screenshot({ path: path.join(UX_SHOTS, 'review-0.png'), fullPage: true });

    // 次の一手の帯で、読んでいる欄を承認する。承認すると次の欄を読む
    await expect(page.locator('#next-text')).toHaveText('エージェントの構成を読み、違わなければ承認します。承認すると、残りは 3 つです。');
    // 承認を待つ間は、今の行で ● あなたが働いている
    const you = page.locator('#now-line .actor[data-actor="you"]');
    await expect(you).toHaveAttribute('data-active', 'true');
    await expect(you.locator('.actor-text')).toHaveText('あなたの番(承認 0 / 4)');
    await expect(page.locator('#now-line .actor[data-active]')).toHaveCount(1);
    await v.approve('エージェントの構成').click();
    await expect(v.state('エージェントの構成')).toHaveText('✓ 承認した');
    await expect(you.locator('.actor-text')).toHaveText('あなたの番(承認 1 / 4)');
    await expect(v.state('harness')).toHaveText('● 読んでいる');
    await expect(v.count).toHaveText('承認 1 / 4・あと 3 つ');
    await shootThemes(page, 'review-reading');
    // 2. harness: 表の列と行。プロンプトの全文は閉じた details の中で読める
    const harness = v.item('harness');
    const harnessTable = harness.getByRole('table', { name: 'harness の部品' });
    await expect(harnessTable.locator('thead th')).toHaveText(['部品', 'この案での中身', '決めるのは', '今の Studio にあるか']);
    for (const part of ['1 ターンの回し方', '何を聞くか・いつ終えるか', 'プロンプト', '道具と権限', '守り(ガードレール)の 3 層', '人に渡す条件', '上限', '文脈と記憶', '記録と評価']) await expect(harnessTable).toContainText(part);
    await expect(harnessTable).toContainText('モデル頼み');
    await expect(harnessTable).toContainText('プロンプトの頼み');
    await harness.getByText(/プロンプトの全文を読む/).click();
    await expect(harness.locator('pre').first()).toContainText('前提の hostPrompt');
    await harness.getByText(/プロンプトの全文を読む/).click();
    await v.approve('harness').click();
    // 3. データと RAG: データの棚と RAG の判定
    const data = v.item('データと RAG');
    await expect(v.state('データと RAG')).toHaveText('● 読んでいる');
    await expect(data.getByRole('table', { name: 'AI が読むデータの棚' })).toBeVisible();
    await expect(data.getByRole('group', { name: 'RAG の判定(審査)' })).toContainText('RAG');
    await v.approve('データと RAG').click();
    // 4. 技術の組: 試作品で使うものと、本番の候補(案。未接続)
    const stack = v.item('技術の組').getByRole('table', { name: '技術の組' });
    await expect(stack.locator('thead th')).toHaveText(['部品', '試作品で使うもの', '本番の候補(案。未接続)']);
    for (const part of ['モデル', '回し方', 'ツールの接続', '知識(RAG)', '記憶', '評価', '記録']) await expect(stack).toContainText(part);
    await expect(stack).toContainText('代わりのモデル');

    // 3 つ承認しても作れない。作る欄から送っても、作る AI は起動しない
    for (const label of LABELS.slice(0, 3)) await expect(v.item(label)).toHaveAttribute('data-approved', 'true');
    await expect(v.count).toHaveText('承認 3 / 4・あと 1 つ');
    await expect(v.build).toBeHidden();
    await expect(page.locator('#next-text')).toHaveText('技術の組を読み、違わなければ承認します。承認すると、4 つそろいます。');
    await expect(page.locator('#review-fingerprint')).toBeHidden();
    const refused = await studio.post(`/api/projects/${id}/build-requests`, { request: '見出しを「架空の図書館」にして' });
    expect(refused.status).toBe(409);
    expect(JSON.parse(refused.text).error.code).toBe('review-not-approved');
    expect((await studio.api(`/api/projects/${id}/build-requests`)).runs).toHaveLength(0);
    await expect(v.mark).toHaveText('審査: 承認 3 / 4');

    // 4 つ目を承認すると「この構成で作る」に変わり、流れ図の右に AI 構成書の指紋が出る。押すと作る AI が動き、関門 GA が通る
    await page.getByLabel(/承認を押す人の名前/).fill('早瀬(架空)');
    await v.approve('技術の組').click();
    await expect(v.count).toHaveText('承認 4 / 4');
    await expect(v.reading).toHaveCount(0);
    for (const label of LABELS) await expect(v.state(label)).toHaveText('✓ 承認した');
    await expect(v.band.getByRole('button')).toHaveText(['この構成で作る']);
    await expect(page.locator('#next-text')).toHaveText('この構成で作ります。作る AI が書き始め、守りが確かめます。');
    await expect(page.locator('#review-fingerprint code')).toHaveText(/^指紋 [0-9a-f]{4}…$/);
    await expect(page.getByLabel(/承認を押す人の名前/)).toBeHidden();
    await expectReadableText(page, '審査(承認 4)');
    await shootThemes(page, 'review-approved');
    await v.build.click();
    await expect(v.section).toBeHidden();
    await expect(v.mark).toHaveText('審査: 承認済み');
    await expect.poll(async () => (await studio.api(`/api/projects/${id}/build-requests`)).runs.at(-1)?.status, { timeout: 90_000 }).toBe('passed');
    const run = (await studio.api(`/api/projects/${id}/build-requests`)).runs.at(-1);
    expect(run.request).toContain('AI 構成の審査で、人が構成、harness、データと RAG、技術の組の 4 つを承認しました');
    expect(run.gates.map((gate) => gate.id)).toEqual(['G1', 'GA', 'G2', 'G3', 'G4', 'GE', 'G5', 'G6']);
    expect(run.gates.find((gate) => gate.id === 'GA').status).toBe('passed');

    // AI 構成書: 承認した人、時刻、指紋。承認した構成のファイルの写し
    const studioDir = path.join(projectRoot(home, id), '.studio');
    const { id: reviewId } = await readJson(path.join(studioDir, 'reviews', 'current.json'));
    const doc = await readJson(path.join(studioDir, 'reviews', reviewId, 'architecture.json'));
    expect(doc.approvedAt).toBeTruthy();
    expect(doc.approvedUnmeasured).toBe(true);
    expect(doc.composition.chosen).toBe('single-agent');
    expect(doc.approvals.stack.by[0]).toMatchObject({ role: 'owner', pressedBy: '早瀬(架空)' });
    expect(doc.approvals.stack.by[0].digest).toBe(doc.fingerprint.items.stack.digest);
    expect(Object.keys(doc.fingerprint.items)).toEqual(['composition', 'harness', 'data', 'stack']);
    expect(await fs.readdir(path.join(studioDir, 'reviews', reviewId, 'files'))).toContain('composition.json');
    expect((await readJson(path.join(studioDir, 'project.json'))).review).toBe('required');
  } finally {
    await studio.stop();
  }
});

test('流れ図が読んでいる欄の部品を示す。構成を選び直すと承認が消え(「! 承認が消えた」と理由の 1 文)、図と数が変わる。数はお試しの AI で回した結果だけを出す', async ({ page, home }) => {
  test.setTimeout(90_000);
  const studio = await launchStudio(home);
  try {
    const id = await decidedProject(studio);
    expect((await studio.post(`/api/projects/${id}/design/start`, { guide: 'ai' })).status).toBe(200);
    await chooseAll(studio, id, 'fixed-flow');
    expect((await studio.post(`/api/projects/${id}/design/decide`)).status).toBe(200);
    await page.goto(studio.url);
    await selectProject(page, id);
    const v = r(page);
    await expect(v.mark).toHaveText('審査: 承認 0 / 4');
    await v.mark.click();
    const composition = v.item('エージェントの構成');
    await expect(composition.getByRole('img')).toHaveAttribute('aria-label', /受付\(コードの流れ\)/);
    await expect(composition).toContainText('まだ測っていない');

    // 流れ図: 構成を読んでいる間は、流れを決める部品(コード)を示す
    await expect(v.focused).toHaveText(['コード']);
    await v.approve('エージェントの構成').click();
    await expect(v.count).toHaveText('承認 1 / 4・あと 3 つ');
    // harness を読むと、「モデル」と「守り」の箱の縁が強くなる
    await expect(v.state('harness')).toHaveText('● 読んでいる');
    await expect(v.focused).toHaveText(['モデル', '守り']);
    await expect(page.locator('#review-flow .node[data-focus]').first()).toHaveCSS('border-top-width', '2px');
    // ほかの欄にカーソルを乗せると、その欄の部品を示す。離すと読んでいる欄に戻る
    await v.item('データと RAG').hover();
    await expect(v.focused).toHaveText(['データ']);
    await page.locator('#review-heading').hover();
    await expect(v.focused).toHaveText(['モデル', '守り']);

    // 選び直すと、承認した欄が「! 承認が消えた」になり、欄の頭に理由の 1 文が出て、承認の数が 1 つ減る。
    // Studio が構成のファイルを書き直し、図が変わる
    await v.peek('エージェントの構成').click();
    await v.switch('単一エージェント').click();
    await expect(v.switch('単一エージェント')).toHaveAttribute('aria-pressed', 'true');
    await expect(v.count).toHaveText('承認 0 / 4・あと 4 つ');
    await expect(v.state('エージェントの構成')).toHaveText('! 承認が消えた');
    await expect(composition.locator('.review-lost')).toHaveText('エージェントの構成を選び直したので、この欄の承認を消しました。読み直して承認してください。');
    await expect(v.reading).toHaveCount(1);
    await expect(composition).toHaveAttribute('data-reading', 'true');
    for (const label of LABELS.slice(1)) await expect(v.state(label)).toHaveText('○ まだ見ていない');
    await expect(page.locator('#review-message')).toContainText('4 つの承認は消えました');
    await expect(composition.getByRole('img')).toHaveAttribute('aria-label', /案内役/);
    // 色を外しても、状態は印と文で分かる(灰色にして文を読む)
    await page.locator('html').evaluate((el) => { el.style.filter = 'grayscale(1)'; });
    await expect(page.locator('#review-items .review-state')).toHaveText(['! 承認が消えた', '○ まだ見ていない', '○ まだ見ていない', '○ まだ見ていない']);
    await shootThemes(page, 'review-gray-lost');
    await page.locator('html').evaluate((el) => { el.style.filter = ''; });
    // 選び直した後の承認は、もう一度上から
    await expect(page.locator('#next-text')).toContainText('エージェントの構成を読み、違わなければ承認します。');
    await expectReadableText(page, '審査(承認が消えた)');
    await shootThemes(page, 'review-lost');
    const file = await readJson(path.join(projectRoot(home, id), 'app', 'composition.json'));
    expect(file.participants.map((p) => p.kind)).toEqual(['agent']);
    // データの段で選んだ表を引くツールを Studio が書き、データの欄の棚に出る(#426)
    expect(file.participants[0].tools?.length).toBeGreaterThan(0);
    // たたんだ欄の中身は「中身を見る」で開く
    await v.peek('データと RAG').click();
    const shelf = v.item('データと RAG').getByRole('table', { name: 'AI が読むデータの棚' });
    await expect(shelf.locator('thead th').last()).toHaveText('引くツール');
    await expect(shelf.locator('tbody tr[data-read="tool"]').first().locator('td').last()).toHaveText(/^search_table_\d+/);
    await expect(shelf).not.toContainText('まだない');

    // お試しの AI で回すと、数が出る。形の確かめだけと出す
    await page.getByRole('button', { name: 'お試しの AI で場面を回す' }).click();
    const metrics = composition.getByRole('table', { name: 'この構成の数' });
    await expect(metrics).toContainText('通った場面');
    await expect(metrics).toContainText(/\d+ \/ \d+/);
    await expect(composition).toContainText('形の確かめだけ');
    // お試しの AI でも、表を引く道具を呼ぶ(呼んだ回数が 0 でない)
    await expect(metrics).toContainText(/呼んだ回数 [1-9]/);
    await expect(v.switch('単一エージェント')).toContainText('お試しの AI');
    await expect(v.switch('固定の流れ')).toContainText('まだ測っていない');

    // マスターとサブも選べる。親と子の図になる
    await v.switch('マスターとサブ').click();
    await expect(v.switch('マスターとサブ')).toHaveAttribute('aria-pressed', 'true');
    await expect(composition.getByRole('img')).toHaveAttribute('aria-label', /調べる係.*仕事を任せる/);
    await v.peek('harness').click();
    await expect(v.item('harness').getByRole('table', { name: 'harness の部品' })).toContainText('子の AI に任せるか');
    await v.peek('データと RAG').click();
    await expect(v.item('データと RAG').getByRole('table', { name: 'AI が読むデータの棚' })).toContainText('search_table_1');
    await expect(composition).toContainText('まだ測っていない');
    await expect(v.count).toHaveText('承認 0 / 4・あと 4 つ');
    await expectNoDevWords(v.section);
    await page.screenshot({ path: path.join(UX_SHOTS, 'review-master-sub.png'), fullPage: true });
  } finally {
    await studio.stop();
  }
});

test('承認した後に構成を変えると、関門 GA で止まり、試す欄は前のまま。審査に戻ると変わった所だけ承認し直す', async ({ page, home }) => {
  test.setTimeout(120_000);
  const studio = await launchStudio(home);
  try {
    const id = await decidedProject(studio);
    await studio.post(`/api/projects/${id}/design/start`, { guide: 'ai' });
    await chooseAll(studio, id, 'fixed-flow');
    await studio.post(`/api/projects/${id}/design/decide`);
    for (const item of ['composition', 'harness', 'data', 'stack']) expect((await studio.post(`/api/projects/${id}/review/approve`, { item })).status).toBe(200);
    const built = await studio.post(`/api/projects/${id}/review/build`);
    expect(built.status, built.text).toBe(200);
    const before = (await studio.api('/api/projects')).projects.find((p) => p.id === id).previewUrl;

    // 作る AI が承認した構成を変える。GA で止まり、検査とビルドの関門(G2〜G4)は回らない
    const send = await studio.post(`/api/projects/${id}/build-requests`, { request: '構成の名前を「試しの構成」にして' });
    expect(send.status).toBe(200);
    await expect.poll(async () => (await studio.api(`/api/projects/${id}/build-requests`)).runs.at(-1)?.status, { timeout: 60_000 }).toBe('failed');
    const run = (await studio.api(`/api/projects/${id}/build-requests`)).runs.at(-1);
    const ga = run.gates.find((gate) => gate.id === 'GA');
    expect(ga.status).toBe('failed');
    expect(ga.changed).toEqual(['composition', 'harness']);
    expect(run.gates.find((gate) => gate.id === 'G2').status).toBe('skipped');
    expect((await studio.api('/api/projects')).projects.find((p) => p.id === id).previewUrl).toBe(before);

    // 次の依頼も、審査に戻るまで作る AI を起動しない
    const again = await studio.post(`/api/projects/${id}/build-requests`, { request: '見出しを「架空の図書館」にして' });
    expect(again.status).toBe(409);
    expect(JSON.parse(again.text).error.code).toBe('review-stopped');

    await page.goto(studio.url);
    await selectProject(page, id);
    const v = r(page);
    await expect(page.locator('body')).toContainText('承認した構成と違うので、止めました');
    await expect(v.mark).toHaveText('審査: 承認と違う構成');
    await v.mark.click();
    // 作業台の上に ⬢ の帯。強いボタン「審査に戻る」は次の一手の帯、弱いボタン「承認した構成に戻す」は ⬢ の帯
    const stopped = page.locator('#review-stopped');
    await expect(stopped).toContainText('⬢ 守りが止めました。承認の後に AI の作りが変わったので');
    await expect(stopped).toContainText('変わった所: エージェントの構成、harness');
    await expect(stopped.getByRole('button', { name: '承認した構成に戻す' })).toBeVisible();
    await expect(v.band.getByRole('button')).toHaveText(['審査に戻る']);
    await expect(v.build).toBeHidden();
    await expect(v.reading).toHaveCount(0);
    await expect(page.locator('#review-items .review-state')).toHaveText(['! 承認が消えた', '! 承認が消えた', '✓ 承認した', '✓ 承認した']);
    await expect(v.item('harness').locator('.review-lost')).toHaveText('承認の後に中身が変わったので、この欄の承認を消しました。読み直して承認してください。');
    await expectNoDevWords(v.section);
    await expectReadableText(page, '審査(止まった)');
    await shootThemes(page, 'review-stopped', '#review-stopped');

    // 審査に戻る: 新しい審査になり、変わらなかったデータと RAG、技術の組の承認は残る。変わった 2 つは理由つきで読み直す
    await v.band.getByRole('button', { name: '審査に戻る' }).click();
    await expect(stopped).toBeHidden();
    await expect(v.count).toHaveText('承認 2 / 4・あと 2 つ');
    await expect(v.item('データと RAG')).toHaveAttribute('data-approved', 'true');
    await expect(v.item('エージェントの構成')).toHaveAttribute('data-approved', 'false');
    await expect(v.item('エージェントの構成')).toHaveAttribute('data-reading', 'true');
    await expect(v.state('エージェントの構成')).toHaveText('! 承認が消えた');
    await v.approve('エージェントの構成').click();
    await v.approve('harness').click();
    await expect(v.build).toBeVisible();
    await expect(page.locator('#review-fingerprint code')).toHaveText(/^指紋 [0-9a-f]{4}…$/);
    const studioDir = path.join(projectRoot(home, id), '.studio', 'reviews');
    const current = await readJson(path.join(studioDir, 'current.json'));
    const doc = await readJson(path.join(studioDir, current.id, 'architecture.json'));
    expect(doc.previous).toBe(JSON.parse(built.text).review.id);
    // 前の AI 構成書は消さない
    expect((await readJson(path.join(studioDir, doc.previous, 'architecture.json'))).stopped.items).toEqual(['composition', 'harness']);
  } finally {
    await studio.stop();
  }
});
