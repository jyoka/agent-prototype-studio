import fs from 'node:fs/promises';
import path from 'node:path';
import { chooseProject, chooseSample, expect, expectNoDevWords, expectReadableText, launchStudio, ROOT, SAMPLES, test } from './studio.js';

// 会の始めとお客さんのデータ(docs/design/field-session.md の段 0、docs/design/collaboration.md の 7 節、K4)。
// 実モデルは呼ばない。偽の claude(test/fixtures/fake-claude.js)か、偽接続(STUDIO_AGENT=fake)で動かす。

const FAKE_CLAUDE = path.join(ROOT, 'test', 'fixtures', 'fake-claude.js');
const UX_SHOTS = path.join(ROOT, 'test-results', 'ux');
const PURPOSE = '架空の配送会社の再配達の受付を考える会';
const PHONE = '090-0000-0000';
const RECORD_POINT = `先週、${PHONE} のお客さんから同じ荷物のことで 3 回電話があった`;

const claudeEnv = (log) => ({ STUDIO_AGENT: 'claude', STUDIO_CLAUDE_BIN: FAKE_CLAUDE, FAKE_CLAUDE_LOG: log });
// 偽の claude を、モデルを呼ぶ形で起動した回数(--version と auth status は数えない)
const launches = async (log) => (await fs.readFile(log, 'utf8').catch(() => '')).split('\n').filter(Boolean).map((line) => JSON.parse(line)).filter((entry) => entry.argv.includes('-p'));

const ui = (page) => ({
  section: page.locator('#meeting'),
  mark: page.locator('#meeting-mark'),
  state: page.locator('#meeting-state'),
  agree: page.getByRole('button', { name: '同意して始める' }),
  trial: page.getByRole('button', { name: 'お試しの AI だけで始める' }),
  erase: page.getByRole('button', { name: '会のデータを消す' }),
  confirm: page.getByRole('group', { name: '会のデータを消す前に' }),
  erased: page.getByRole('list', { name: '消した一覧' }),
  due: page.locator('#meeting-due'),
});

const boardUi = (page) => ({
  section: page.locator('#organize'),
  point: page.getByLabel('聞いた要点'),
  points: page.getByRole('list', { name: '打った要点' }),
  run: page.getByRole('button', { name: '整理する', exact: true }),
  items: page.locator('#organize-columns .organize-item'),
  note: page.locator('#organize-note'),
  error: page.locator('#organize-error'),
});

// 上の帯の一覧から会を用意する。作った試作品の ID を返す
async function prepareMeeting(page, studio, purpose = PURPOSE) {
  await page.goto(studio.url);
  await page.locator('#project-menu-button').click();
  await page.getByRole('button', { name: 'お客さんとの会を始める' }).click();
  const s = ui(page);
  await expect(page.getByRole('heading', { level: 2, name: '会の始め' })).toBeVisible();
  await page.getByLabel('会の目的').fill(purpose);
  await page.getByRole('button', { name: '会を用意する' }).click();
  await expect(s.mark).toHaveText('会: 同意の前');
  await expect(s.agree).toBeVisible();
  const { projects } = await studio.api('/api/projects');
  return projects.find((project) => project.meeting.status !== 'none').id;
}

// 置き場の全部のファイルから文字を探す
async function grepHome(dir, text) {
  const found = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await grepHome(full, text)));
    else if (entry.isFile() && (await fs.readFile(full)).includes(text)) found.push(full);
  }
  return found;
}

async function typePoint(s, text) {
  await s.point.fill(text);
  await s.point.press('Enter');
}

test('同意の前に偽の claude が起動しない。画面に目的、流れ、送り先、置き場、見られる人、消す日がある。同意すると動く', async ({ page, home }) => {
  test.skip(process.platform === 'win32', '偽の claude を直接起動するため');
  test.setTimeout(90_000);
  const log = path.join(home, 'claude.log');
  const studio = await launchStudio(home, { env: claudeEnv(log) });
  try {
    const id = await prepareMeeting(page, studio);
    const s = ui(page);
    const facts = page.locator('#meeting-facts');
    await expect(facts).toContainText(PURPOSE);
    await expect(facts).toContainText('AI が整理する');
    await expect(facts).toContainText('お客さんの話(打った要点)');
    await expect(facts).toContainText('Anthropic(Claude を作っている会社)');
    await expect(facts).toContainText(path.join('projects', id));
    await expect(facts).toContainText('この PC を使える人');
    await expect(facts).toContainText('お試しの AI だけで進めます');
    await expect(s.section).toContainText('本物のお客さんの会で使う前に、会社のデータの取り決めが要ります');
    // 消す日の既定は 30 日後
    const expected = new Date();
    expected.setDate(expected.getDate() + 30);
    const pad = (n) => String(n).padStart(2, '0');
    await expect(page.getByLabel('消す日', { exact: true })).toHaveValue(`${expected.getFullYear()}-${pad(expected.getMonth() + 1)}-${pad(expected.getDate())}`);
    await expectNoDevWords(s.section);
    await expectReadableText(page, '会の始め');
    await page.screenshot({ path: path.join(UX_SHOTS, 'K4-start.png'), fullPage: true });

    // ヒアリングの印を押しても、会の始めに戻る
    await page.locator('#organize-mark').click();
    await expect(boardUi(page).section).toBeHidden();
    await expect(s.section).toBeVisible();

    // 試作品の画面からの「言葉で直す」は断る。別の試作品で本物の AI に同意した後でも、この会は断る
    await page.getByRole('button', { name: '試作品の画面に戻る' }).click();
    const make = page.getByRole('region', { name: '言葉で直す' });
    await page.getByLabel('依頼').fill('見出しを大きくして');
    await make.getByRole('button', { name: '送る' }).click();
    await expect(make).toContainText('まだ同意の前です');
    expect((await studio.post('/api/real-ai/consent')).status).toBe(200);
    await make.getByRole('button', { name: '送る' }).click();
    await expect(make).toContainText('まだ同意の前です');

    // API を直接呼んでも、断る
    for (const pathname of [`/api/projects/${id}/organize/run`, `/api/projects/${id}/build-requests`]) {
      const refused = await studio.post(pathname, { request: '見出しを大きくして' });
      expect(refused.status, pathname).toBe(403);
      expect(JSON.parse(refused.text).error.code).toBe('meeting-consent-required');
    }
    expect((await studio.post(`/api/projects/${id}/organize/point`, { text: '同意の前の要点' })).status).toBe(403);
    expect((await launches(log)).length).toBe(0);

    // 同意すると、整理の板が開き、整理する AI が 1 回だけ動く
    await s.mark.click();
    await s.agree.click();
    const b = boardUi(page);
    await expect(b.section).toBeVisible();
    await expect(s.mark).toHaveText('会: 同意した');
    await typePoint(b, '再配達の受付を、電話なしで済ませたい');
    await expect(b.points.getByRole('listitem')).toHaveCount(1);
    await b.run.click();
    await expect(b.items.first()).toBeVisible();
    expect((await launches(log)).filter((entry) => entry.argv.some((arg) => arg.includes('toAsk')))).toHaveLength(1);
    expect((await launches(log)).length).toBe(1);
    await expectReadableText(page, '会の整理の板');
    await page.screenshot({ path: path.join(UX_SHOTS, 'K4-board.png'), fullPage: true });
  } finally {
    await studio.stop();
  }
});

test('同意しない道: お試しの AI だけで始めると、外の AI に送らず、手で振り分けて進む。後から同意できる', async ({ page, home }) => {
  test.skip(process.platform === 'win32', '偽の claude を直接起動するため');
  test.setTimeout(60_000);
  const log = path.join(home, 'claude.log');
  const studio = await launchStudio(home, { env: claudeEnv(log) });
  try {
    const id = await prepareMeeting(page, studio);
    const s = ui(page);
    await s.trial.click();
    const b = boardUi(page);
    await expect(b.section).toBeVisible();
    await expect(s.mark).toHaveText('会: お試しの AI だけ');
    await expect(page.locator('#organize-no-ai')).toBeVisible();
    await typePoint(b, 'お年寄りのお客さんも多い');
    await expect(b.points.getByRole('listitem')).toHaveCount(1);
    await expect(b.run).toBeDisabled();
    await page.getByLabel('要点 1 を入れる欄').selectOption({ label: '使う人' });
    await expect(page.getByRole('region', { name: '使う人', exact: true }).locator('.organize-item')).toContainText('お年寄りのお客さんも多い');

    const refused = await studio.post(`/api/projects/${id}/build-requests`, { request: '見出しを大きくして' });
    expect(refused.status).toBe(403);
    expect(JSON.parse(refused.text).error.code).toBe('meeting-trial');
    expect((await launches(log)).length).toBe(0);

    // 後から同意すると、整理する AI を呼べる
    await s.mark.click();
    await s.agree.click();
    await expect(s.mark).toHaveText('会: 同意した');
    await expect(b.run).toBeEnabled();
  } finally {
    await studio.stop();
  }
});

test('架空の電話番号を含む要点は、AI に送らず、一覧にも元の要点にもファイルにも残らず、「記録らしいものを省いた」と知らせる', async ({ page, home }) => {
  test.skip(process.platform === 'win32', '偽の claude を直接起動するため');
  test.setTimeout(60_000);
  const log = path.join(home, 'claude.log');
  const studio = await launchStudio(home, { env: claudeEnv(log) });
  try {
    await page.goto(studio.url);
    await page.locator('#project-menu-button').click();
    await chooseSample(page, SAMPLES.library);
    const id = SAMPLES.library.id;
    await page.locator('#organize-mark').click();
    const b = boardUi(page);
    await typePoint(b, '再配達の受付を、電話なしで済ませたい');
    await expect(b.points.getByRole('listitem')).toHaveCount(1);

    // 打つと断り、知らせる。直せるように、文は欄に戻す
    await typePoint(b, RECORD_POINT);
    await expect(b.error).toContainText('記録らしいものを省きました(電話番号)');
    await expect(b.error).not.toContainText(PHONE);
    await expect(b.point).toHaveValue(RECORD_POINT);
    await expect(b.points.getByRole('listitem')).toHaveCount(1);
    await expect(b.points).not.toContainText(PHONE);
    await b.point.fill('');

    // 全角と空白で打っても同じ
    await typePoint(b, '０９０　００００　００００ に電話があった');
    await expect(b.error).toContainText('記録らしいものを省きました(電話番号)');
    await expect(b.points.getByRole('listitem')).toHaveCount(1);

    // 項目を足す欄でも入らない
    await page.getByLabel('足す欄').selectOption({ label: '場面' });
    await page.getByLabel('足す項目').fill(`${PHONE} から電話`);
    await page.getByRole('button', { name: '項目を足す' }).click();
    await expect(b.error).toContainText('記録らしいものを省きました');
    await expect(b.items).toHaveCount(0);
    await page.getByLabel('足す項目').fill('');

    // 番号を抜いて打ち直すと入る
    await typePoint(b, '先週、同じ荷物のことで 3 回電話があった');
    await expect(b.points.getByRole('listitem')).toHaveCount(2);
    await expect(b.error).toBeHidden();

    // 整理する。AI が返した記録らしい項目と、記録らしいと言った要点も、板に入らない
    await typePoint(b, '[記録を返す] 架空の要点');
    await expect(b.points.getByRole('listitem')).toHaveCount(3);
    await b.run.click();
    await page.getByRole('group', { name: '本物の AI を使う前に' }).getByRole('button', { name: '同意して使う' }).click();
    await expect(b.items.first()).toBeVisible();
    await expect(b.note).toContainText('記録らしいものを省きました');
    await expect(b.section).not.toContainText(PHONE);
    await expect(b.points.getByRole('listitem')).toHaveCount(2);
    // 一覧にも、カードの下の「元の要点」の行にもない
    await expect(b.section).not.toContainText('[記録を返す]');
    await expect(b.section.locator('.organize-source', { hasText: '元の要点' }).first()).toBeVisible();
    await page.screenshot({ path: path.join(UX_SHOTS, 'K4-omitted.png'), fullPage: true });

    // AI に送った本文にない
    const sent = await launches(log);
    expect(sent).toHaveLength(1);
    expect(sent[0].stdin).not.toContain(PHONE);
    expect(sent[0].stdin).not.toContain('００００');
    expect(sent[0].stdin).toContain('先週、同じ荷物のことで 3 回電話があった');

    // ファイルにない
    const saved = await fs.readFile(path.join(home, 'projects', id, '.studio', 'organize.json'), 'utf8');
    expect(saved).not.toContain(PHONE);
    expect(saved).not.toContain('[記録を返す]');
  } finally {
    await studio.stop();
  }
});

test('前の板に残っていた記録らしいものは、起動のときに板とファイルから取り除く', async ({ page, home }) => {
  test.setTimeout(60_000);
  const first = await launchStudio(home);
  await first.stop();
  const file = path.join(home, 'projects', SAMPLES.library.id, '.studio', 'organize.json');
  const at = '2026-10-31T00:00:00.000Z';
  await fs.writeFile(file, JSON.stringify({
    formatVersion: 1, status: 'confirmed', rev: 3, nextPoint: 3, nextItem: 2, nextAsk: 1,
    points: [{ n: 1, text: '不在票に荷物の番号がある', at }, { n: 2, text: RECORD_POINT, at }],
    items: [{ id: 'i1', column: 'scene', text: '先週の電話', sources: [2], by: 'ai', held: false, checkedAt: null }],
    asks: [], dismissed: { items: [], asks: [] }, note: null, organizedAt: at, confirmedAt: at,
  }));
  const studio = await launchStudio(home);
  try {
    await page.goto(studio.url);
    await page.locator('#project-menu-button').click();
    await chooseSample(page, SAMPLES.library);
    await page.locator('#organize-mark').click();
    const b = boardUi(page);
    await expect(b.points.getByRole('listitem')).toHaveCount(1);
    await expect(b.section).not.toContainText(PHONE);
    await expect(b.note).toContainText('記録らしいものを省きました');
    expect(await fs.readFile(file, 'utf8')).not.toContain(PHONE);
  } finally {
    await studio.stop();
  }
});

test('会のデータを消すと、プロジェクト、版、直した記録、run、引き継ぎの書き出しが消え、消した一覧が出る。ほかの試作品は残る', async ({ page, home }) => {
  // 作る AI の依頼を 1 回終えるまで待つ
  test.setTimeout(120_000);
  const studio = await launchStudio(home);
  try {
    const id = await prepareMeeting(page, studio);
    const s = ui(page);
    await s.agree.click();
    await expect(s.mark).toHaveText('会: 同意した');

    // 消すものを作る。直した記録は K3 が書くので、置き場に架空のファイルを置く
    const root = path.join(home, 'projects', id);
    expect((await studio.post(`/api/projects/${id}/organize/point`, { text: '架空の要点' })).status).toBe(200);
    expect((await studio.post(`/api/projects/${id}/versions`, { name: '架空の版' })).status).toBe(200);
    await studio.post(`/api/projects/${id}/build-requests`, { request: '見出しを大きくして' });
    await fs.mkdir(path.join(root, '.studio', 'fix-records'), { recursive: true });
    await fs.writeFile(path.join(root, '.studio', 'fix-records', 'r1.json'), '{}');
    expect((await studio.post(`/api/projects/${id}/handoff`, {})).status).toBe(200);
    // ほかの試作品の書き出し。こちらは消えない
    expect((await studio.post(`/api/projects/${SAMPLES.library.id}/handoff`, {})).status).toBe(200);
    const handoffsDir = path.join(home, 'handoffs');
    const handoffs = await fs.readdir(handoffsDir);
    expect(handoffs.filter((name) => name.startsWith(id))).toHaveLength(1);
    expect((await fs.readdir(path.join(root, '.studio', 'versions'))).length).toBeGreaterThan(0);
    expect((await fs.readdir(path.join(root, '.studio', 'runs'))).length).toBeGreaterThan(0);

    // 押す前に、消すものと、元に戻せないことを出す。やめると消えない
    await s.mark.click();
    await s.erase.click();
    await expect(s.confirm).toContainText('元に戻せません');
    await expect(s.confirm).toContainText('保存した版: ');
    await expect(s.confirm).toContainText('引き継ぎの書き出し: 1 個');
    await s.confirm.getByRole('button', { name: 'やめる' }).click();
    await expect(s.confirm).toBeHidden();
    expect(await fs.lstat(root).then(() => true)).toBe(true);

    // ID を間違えると消えない
    expect((await studio.post(`/api/projects/${id}/meeting/erase`, { confirm: 'sample-library' })).status).toBe(400);
    expect(await fs.lstat(root).then(() => true)).toBe(true);

    // 打った言葉を、消した後に置き場の全部から探すための目印
    const marker = '架空の目印しおかぜ';
    expect((await studio.post(`/api/projects/${id}/organize/point`, { text: marker })).status).toBe(200);
    expect(await grepHome(home, marker)).not.toEqual([]);

    // 消す
    await s.erase.click();
    await expect(s.confirm).toBeVisible();
    await s.confirm.getByRole('button', { name: '消す', exact: true }).click();
    await expect(page.getByRole('heading', { level: 2, name: '会のデータを消しました' })).toBeVisible();
    await expect(s.erased).toContainText('プロジェクト(試作品のファイル): ');
    await expect(s.erased).toContainText('保存した版: 1 個');
    await expect(s.erased).toContainText('直した記録: 1 個');
    await expect(s.erased).toContainText('作る AI の実行の記録(run): 1 個');
    await expect(s.erased).toContainText('引き継ぎの書き出し: 1 個');
    await expect(s.section).toContainText('外の AI の送り先に届いた分は、この操作では消せません');
    await expectNoDevWords(s.section);
    await page.screenshot({ path: path.join(UX_SHOTS, 'K4-erased.png'), fullPage: true });

    // 本当に消えた。置き場のどこにも、打った言葉も会の目的も残らない
    expect(await grepHome(home, marker)).toEqual([]);
    expect(await grepHome(home, PURPOSE)).toEqual([]);
    await expect(fs.lstat(root)).rejects.toThrow();
    const left = await fs.readdir(path.join(home, 'projects'));
    expect(left.filter((name) => name.includes(id))).toEqual([]);
    const handoffsAfter = await fs.readdir(handoffsDir);
    expect(handoffsAfter.filter((name) => name.includes(id))).toEqual([]);
    expect(handoffsAfter.filter((name) => name.startsWith(SAMPLES.library.id))).toHaveLength(1);
    expect((await studio.api(`/api/projects/${id}/organize`)).error.code).toBe('not-found');
    expect((await studio.api('/api/projects')).projects.some((project) => project.id === id)).toBe(false);
    await expect(fs.lstat(path.join(home, 'projects', SAMPLES.library.id))).resolves.toBeTruthy();

    // 閉じると、ほかの試作品の画面に戻る。一覧に消した会はない
    await page.getByRole('button', { name: '閉じる', exact: true }).click();
    await expect(s.section).toBeHidden();
    await expect(s.mark).toBeHidden();
    await page.locator('#project-menu-button').click();
    await expect(page.getByRole('navigation', { name: '試作品の一覧' })).not.toContainText(PURPOSE.slice(0, 8));
    // 同じ消し方は、会ではない試作品には使えない
    expect((await studio.post(`/api/projects/${SAMPLES.library.id}/meeting/erase`, { confirm: SAMPLES.library.id })).status).toBe(404);
  } finally {
    await studio.stop();
  }
  // 起動し直しても、戻らない
  const again = await launchStudio(home);
  try {
    expect((await again.api('/api/projects')).projects.some((project) => project.meeting.status !== 'none')).toBe(false);
  } finally {
    await again.stop();
  }
});

test('消す日を過ぎた会を知らせる。勝手には消さない。開いて消せる', async ({ page, home }) => {
  test.setTimeout(60_000);
  const first = await launchStudio(home);
  let id;
  try {
    const created = await first.post('/api/meetings', { purpose: PURPOSE });
    ({ id } = JSON.parse(created.text).project);
  } finally {
    await first.stop();
  }
  const file = path.join(home, 'projects', id, '.studio', 'meeting.json');
  const record = JSON.parse(await fs.readFile(file, 'utf8'));
  await fs.writeFile(file, JSON.stringify({ ...record, status: 'agreed', deleteOn: '2026-01-31' }));

  const studio = await launchStudio(home);
  try {
    expect(studio.output()).toContain(`消す日を過ぎた会があります: ${id}`);
    await page.goto(studio.url);
    const s = ui(page);
    await expect(s.due).toContainText('消す日を過ぎた会があります');
    await expect(s.due).toContainText('消す日 2026-01-31');
    // ほかのお客さんの前で、別の会の目的を出さない
    await expect(s.due).not.toContainText(PURPOSE);
    // 勝手には消さない
    expect(await fs.lstat(file).then(() => true)).toBe(true);
    await s.due.getByRole('button', { name: '開く' }).click();
    await expect(s.state).toContainText('消す日(2026-01-31)を過ぎました');
    await expect(s.mark).toHaveText('会: 消す日を過ぎた');
    await expectNoDevWords(s.section);

    // 過去の日には変えられない。先の日に変えると、知らせが消える
    const refused = await studio.post(`/api/projects/${id}/meeting/delete-on`, { deleteOn: '2026-01-01' });
    expect(refused.status).toBe(400);
    const later = new Date();
    later.setFullYear(later.getFullYear() + 1);
    const pad = (n) => String(n).padStart(2, '0');
    await page.getByLabel('消す日', { exact: true }).fill(`${later.getFullYear()}-${pad(later.getMonth() + 1)}-${pad(later.getDate())}`);
    await page.getByRole('button', { name: '消す日を変える' }).click();
    await expect(s.due).toBeHidden();
    await expect(s.mark).toHaveText('会: 同意した');

    // 消すと一覧から消える
    await s.erase.click();
    await s.confirm.getByRole('button', { name: '消す', exact: true }).click();
    await expect(s.erased).toBeVisible();
    await expect(fs.lstat(file)).rejects.toThrow();
  } finally {
    await studio.stop();
  }
});

test('目的に記録らしいものがあると会を作らない。止めても同意の前のまま。試作品を切り替えられる', async ({ page, home }) => {
  test.setTimeout(60_000);
  const studio = await launchStudio(home);
  let id;
  try {
    await page.goto(studio.url);
    await page.locator('#project-menu-button').click();
    await page.getByRole('button', { name: 'お客さんとの会を始める' }).click();
    await page.getByLabel('会の目的').fill(`${PHONE} のお客さんの会`);
    await page.getByRole('button', { name: '会を用意する' }).click();
    await expect(page.locator('#meeting-error')).toContainText('記録らしいものがある');
    expect((await studio.api('/api/projects')).projects.every((project) => project.meeting.status === 'none')).toBe(true);
    await page.getByRole('button', { name: 'やめる' }).click();
    await expect(page.locator('#meeting')).toBeHidden();
    id = await prepareMeeting(page, studio);
  } finally {
    await studio.stop();
  }
  const again = await launchStudio(home);
  try {
    await page.goto(again.url);
    const s = ui(page);
    await expect(s.mark).toHaveText('会: 同意の前');
    expect((await again.post(`/api/projects/${id}/organize/run`)).status).toBe(403);
    await chooseProject(page, SAMPLES.library.name);
    await expect(s.mark).toBeHidden();
    await expect(page.locator('#organize-mark')).toBeVisible();
  } finally {
    await again.stop();
  }
});

for (const [width, height] of [[1024, 700], [390, 700]]) {
  test(`幅 ${width} の窓でも、会の始めの全部を読み、同意まで進める`, async ({ page, home }) => {
    test.setTimeout(60_000);
    const studio = await launchStudio(home);
    try {
      await page.setViewportSize({ width, height });
      await prepareMeeting(page, studio);
      const s = ui(page);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow).toBeLessThanOrEqual(1);
      const bar = await page.getByRole('banner').boundingBox();
      const heading = await page.getByRole('heading', { level: 2, name: '会の始め' }).boundingBox();
      expect(bar.y + bar.height).toBeLessThanOrEqual(heading.y + 1);
      // 狭い窓でも、中身がつぶれない
      await expect(s.state).toBeInViewport();
      await page.screenshot({ path: path.join(UX_SHOTS, `K4-${width}.png`) });
      // 全部を読んで、一番下の同意まで進める
      await s.agree.scrollIntoViewIfNeeded();
      await expect(s.agree).toBeInViewport();
      await s.agree.click();
      await expect(s.mark).toHaveText('会: 同意した');
    } finally {
      await studio.stop();
    }
  });
}
