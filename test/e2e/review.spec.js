import fs from 'node:fs/promises';
import path from 'node:path';
import { ROOT, expect, expectNoDevWords, launchStudio, test } from './studio.js';

// AI 構成の審査(docs/design/ai-architecture-review.md、task 422)。4 つの承認がそろうまで作る AI が起動しない。
// 選び直すと承認が消える。承認後に構成を変えると関門 GA で止まり、審査に戻る。
// 実モデルは呼ばない。偽の claude(test/fixtures/fake-claude.js と src/agent/fake-claude.js)か、偽接続(STUDIO_AGENT=fake)で動かす

const SENTENCE = '架空の町の図書館で、本の取り置きの問い合わせに AI が答えられるようにしたい';
const UX_SHOTS = path.join(ROOT, 'test-results', 'ux');
const STEPS = ['problem', 'users', 'scenes', 'data', 'composition', 'screens'];

const readJson = async (file) => JSON.parse(await fs.readFile(file, 'utf8'));
const projectRoot = (home, id) => path.join(home, 'projects', id);

// 案を出す AI は偽の claude(test/fixtures/fake-claude.js)、作る AI は偽の直す AI(src/agent/fake-claude.js)。
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

const r = (page) => ({
  section: page.locator('#review'),
  count: page.locator('#review-count'),
  left: page.locator('#review-left'),
  build: page.getByRole('button', { name: 'この構成で作る' }),
  mark: page.locator('#review-mark'),
  item: (label) => page.getByRole('region', { name: new RegExp(`^\\d\\. ${label}`) }),
  approve: (label) => page.getByRole('button', { name: `「${label}」を承認する` }),
  switch: (label) => page.getByRole('group', { name: '構成を切り替える' }).getByRole('button', { name: new RegExp(`^${label}`) }),
});

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

    // 審査の画面。承認 0 / 4。4 つの欄が上から順に並び、作れない
    const v = r(page);
    await expect(page.getByRole('heading', { level: 2, name: 'AI 構成の審査' })).toBeVisible();
    await expect(v.count).toHaveText('承認 0 / 4');
    await expect(v.build).toBeDisabled();
    await expect(v.left).toHaveText('あと 4 つの承認で押せます。');
    await expect(page.locator('#review-items > section h3')).toHaveText([/^1\. エージェントの構成/, /^2\. harness/, /^3\. データと RAG/, /^4\. 技術の組/]);

    // 1. 構成: 3 つの切り替え、図、平たい言葉、おすすめと理由と日付、根拠の場面、まだ測っていない
    const composition = v.item('エージェントの構成');
    await expect(v.switch('固定の流れ')).toBeVisible();
    await expect(v.switch('単一エージェント')).toHaveAttribute('aria-pressed', 'true');
    await expect(v.switch('マスターとサブ')).toBeEnabled();
    await expect(composition.getByRole('img')).toHaveAttribute('aria-label', /使う人.*案内役/);
    await expect(composition).toContainText('1 つの AI が道具を選んで進む形');
    await expect(composition).toContainText('おすすめ: 単一エージェント');
    await expect(composition).toContainText('偽の構成の理由');
    await expect(composition).toContainText(/出した日: \d{4}-\d{2}-\d{2}/);
    await expect(composition).toContainText('根拠の場面: design-');
    await expect(composition).toContainText('まだ測っていない');
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
    // 3. データと RAG: データの棚と RAG の判定
    const data = v.item('データと RAG');
    await expect(data.getByRole('table', { name: 'AI が読むデータの棚' })).toBeVisible();
    await expect(data.getByRole('group', { name: 'RAG の判定(審査)' })).toContainText('RAG');
    // 4. 技術の組: 試作品で使うものと、本番の候補(案。未接続)
    const stack = v.item('技術の組').getByRole('table', { name: '技術の組' });
    await expect(stack.locator('thead th')).toHaveText(['部品', '試作品で使うもの', '本番の候補(案。未接続)']);
    for (const part of ['モデル', '回し方', 'ツールの接続', '知識(RAG)', '記憶', '評価', '記録']) await expect(stack).toContainText(part);
    await expect(stack).toContainText('代わりのモデル');
    await expectNoDevWords(v.section);
    await expect(v.section).not.toContainText('理想');
    await expect(v.section).not.toContainText('最適');
    await page.screenshot({ path: path.join(UX_SHOTS, 'review-0.png'), fullPage: true });

    // 3 つ承認しても作れない。作る欄から送っても、作る AI は起動しない
    for (const label of LABELS.slice(0, 3)) {
      await v.approve(label).click();
      await expect(v.item(label)).toHaveAttribute('data-approved', 'true');
    }
    await expect(v.count).toHaveText('承認 3 / 4');
    await expect(v.build).toBeDisabled();
    await expect(v.left).toHaveText('あと 1 つの承認で押せます。');
    const refused = await studio.post(`/api/projects/${id}/build-requests`, { request: '見出しを「架空の図書館」にして' });
    expect(refused.status).toBe(409);
    expect(JSON.parse(refused.text).error.code).toBe('review-not-approved');
    expect((await studio.api(`/api/projects/${id}/build-requests`)).runs).toHaveLength(0);
    await expect(v.mark).toHaveText('審査: 承認 3 / 4');

    // 4 つ目を承認すると押せる。押すと作る AI が動き、関門 GA が通る
    await page.getByLabel(/承認を押す人の名前/).fill('早瀬(架空)');
    await v.approve('技術の組').click();
    await expect(v.count).toHaveText('承認 4 / 4');
    await expect(v.build).toBeEnabled();
    await page.screenshot({ path: path.join(UX_SHOTS, 'review-4.png'), fullPage: true });
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

test('構成を選び直すと、4 つの承認が全部消え、図と数が変わる。数はお試しの AI で回した結果だけを出す', async ({ page, home }) => {
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

    await v.approve('エージェントの構成').click();
    await v.approve('harness').click();
    await expect(v.count).toHaveText('承認 2 / 4');

    // 選び直すと、承認は全部消える。Studio が構成のファイルを書き直し、図が変わる
    await v.switch('単一エージェント').click();
    await expect(v.switch('単一エージェント')).toHaveAttribute('aria-pressed', 'true');
    await expect(v.count).toHaveText('承認 0 / 4');
    await expect(page.locator('#review-message')).toContainText('4 つの承認は消えました');
    await expect(composition.getByRole('img')).toHaveAttribute('aria-label', /案内役/);
    const file = await readJson(path.join(projectRoot(home, id), 'app', 'composition.json'));
    expect(file.participants.map((p) => p.kind)).toEqual(['agent']);
    // データの段で選んだ表を引くツールを Studio が書き、データの欄の棚に出る(#426)
    expect(file.participants[0].tools?.length).toBeGreaterThan(0);
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
    await expect(v.item('harness').getByRole('table', { name: 'harness の部品' })).toContainText('子の AI に任せるか');
    await expect(v.item('データと RAG').getByRole('table', { name: 'AI が読むデータの棚' })).toContainText('search_table_1');
    await expect(composition).toContainText('まだ測っていない');
    await expect(v.count).toHaveText('承認 0 / 4');
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
    await expect(page.locator('#review-stopped')).toContainText('変わった所: エージェントの構成、harness');
    await expect(v.build).toBeDisabled();
    await expectNoDevWords(v.section);
    await page.screenshot({ path: path.join(UX_SHOTS, 'review-stopped.png'), fullPage: true });

    // 審査に戻る: 新しい審査になり、変わらなかったデータと RAG、技術の組の承認は残る
    await page.getByRole('button', { name: '審査に戻る' }).click();
    await expect(v.count).toHaveText('承認 2 / 4');
    await expect(v.item('データと RAG')).toHaveAttribute('data-approved', 'true');
    await expect(v.item('エージェントの構成')).toHaveAttribute('data-approved', 'false');
    await v.approve('エージェントの構成').click();
    await v.approve('harness').click();
    await expect(v.build).toBeEnabled();
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
