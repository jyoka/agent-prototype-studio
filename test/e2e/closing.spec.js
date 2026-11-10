import fs from 'node:fs/promises';
import path from 'node:path';
import { ROOT, expect, expectNoDevWords, launchStudio, test } from './studio.js';

// 会の終わりの成果物(docs/design/user-journey.md の K5、docs/design/field-session.md の段 7)。
// 偽接続(STUDIO_AGENT=fake)で動かす。会はお試しの AI だけで始め、要点は手で振り分ける。実モデルは呼ばない。題材は架空

const UX_SHOTS = path.join(ROOT, 'test-results', 'ux');
const PURPOSE = '架空の配送店の再配達の受付を考える会';

test('持ち主のない未決事項があると、会の終わりの画面に出る。持ち主と期日を決めると減り、書き出しに 7 つの成果物と持ち主が入る', async ({ page, home }) => {
  test.setTimeout(90_000);
  const studio = await launchStudio(home);
  try {
    // 会を用意し、お試しの AI だけで始める
    await page.goto(studio.url);
    await page.locator('#project-menu-button').click();
    await page.getByRole('button', { name: 'お客さんとの会を始める' }).click();
    await page.getByLabel('会の目的').fill(PURPOSE);
    await page.getByRole('button', { name: '会を用意する' }).click();
    await page.getByRole('button', { name: 'お試しの AI だけで始める' }).click();
    await expect(page.locator('#organize')).toBeVisible();
    const { projects } = await studio.api('/api/projects');
    const id = projects.find((project) => project.meeting.status !== 'none').id;

    // 要点を 1 つ打ち、使う人の欄に手で入れる。ほかの 4 つの欄は空のまま(聞いていないこと)
    const point = page.getByLabel('聞いた要点');
    await point.fill('店の受付係が電話を受けている');
    await point.press('Enter');
    await page.getByLabel('要点 1 を入れる欄').selectOption({ label: '使う人' });
    await expect(page.getByRole('region', { name: '使う人', exact: true }).locator('.organize-item')).toContainText('店の受付係が電話を受けている');

    // 会の画面から、会の終わりへ
    await page.locator('#meeting-mark').click();
    await page.getByRole('button', { name: '会の終わりへ' }).click();
    const section = page.locator('#meeting');
    await expect(page.getByRole('heading', { level: 2, name: '会の終わり' })).toBeVisible();

    // 7 つの成果物
    const deliverables = page.getByRole('list', { name: '7 つの成果物' }).getByRole('listitem');
    await expect(deliverables).toHaveCount(7);
    await expect(deliverables.locator('strong')).toHaveText(['要件の文書', 'データ設計', '構成の図', 'AI 構成書', '試作品', '場面の一覧', '未決事項']);
    await expect(deliverables.last()).toContainText('持ち主のない未決事項が 4 件');

    // 持ち主のない未決事項が出る
    const unowned = page.locator('#closing-unowned');
    await expect(unowned).toBeVisible();
    await expect(unowned).toHaveText('持ち主のない未決事項が 4 件あります。');
    const open = page.getByRole('list', { name: '未決事項の持ち主と期日' }).getByRole('listitem');
    await expect(open).toHaveCount(4);
    await expect(open.first()).toContainText('「要求」の話をまだ聞いていません。');
    await expect(open.first()).toContainText('持ち主なし');
    await expect(section.locator('li[data-unowned="true"]')).toHaveCount(4);

    // 要件の文書: 使う人の項目に、元の要点が付く
    await expect(page.locator('#closing-requirements')).toContainText('店の受付係が電話を受けている (元の要点 1「店の受付係が電話を受けている」)');
    await expectNoDevWords(section);
    await page.screenshot({ path: path.join(UX_SHOTS, 'K5-closing.png'), fullPage: true });

    // 記録らしいもの(電話番号)は持ち主に入れない
    await open.first().getByLabel('持ち主').fill('090-0000-0000');
    await open.first().getByRole('button', { name: '決める' }).click();
    await expect(page.locator('#meeting-error')).toContainText('記録らしいもの');
    await expect(unowned).toHaveText('持ち主のない未決事項が 4 件あります。');

    // 持ち主と期日を決めると、持ち主のない未決事項が減る
    await open.first().getByLabel('持ち主').fill('進行役');
    await open.first().getByLabel('期日').fill('2026-11-20');
    await open.first().getByRole('button', { name: '決める' }).click();
    await expect(unowned).toHaveText('持ち主のない未決事項が 3 件あります。');
    await expect(open.first().getByLabel('持ち主')).toHaveValue('進行役');
    await expect(section.locator('li[data-unowned="true"]')).toHaveCount(3);

    // 書き出すと、7 つの成果物と持ち主と期日が入る
    await page.getByRole('button', { name: '書き出す' }).click();
    await expect(page.locator('#closing-exported')).toContainText('書き出しました');
    const dir = await page.locator('#closing-exported code').innerText();
    const manifest = JSON.parse(await fs.readFile(path.join(dir, 'handoff.json'), 'utf8'));
    expect(manifest.project.id).toBe(id);
    expect(manifest.closing.deliverables.map((item) => item.label)).toEqual(['要件の文書', 'データ設計', '構成の図', 'AI 構成書', '試作品', '場面の一覧', '未決事項']);
    expect(manifest.closing.unowned).toBe(3);
    expect(manifest.closing.openItems.find((item) => item.key === 'empty:requirement')).toMatchObject({ owner: '進行役', due: '2026-11-20' });
    expect(manifest.requirements.sections.find((s) => s.id === 'user').items[0]).toMatchObject({ text: '店の受付係が電話を受けている', from: 'point' });
    const readme = await fs.readFile(path.join(dir, 'README.md'), 'utf8');
    expect(readme).toContain('## 会の終わりの成果物');

    // 会の始めに戻れる
    await page.getByRole('button', { name: '会の始めに戻る' }).click();
    await expect(page.getByRole('heading', { level: 2, name: '会の始め' })).toBeVisible();
  } finally {
    await studio.stop();
  }
});
