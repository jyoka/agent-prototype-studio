import fs from 'node:fs/promises';
import path from 'node:path';
import { ROOT, chooseProject, expect, expectNoDevWordsOnScreen, launchStudio, test, writeProject } from './studio.js';

// 質の見直しの表(docs/design/user-journey.md の J6)。試す欄の下の「質の見直し」。
// わざと壊した見本(字と地の差が足りない、ラベルのない入力、値のまま書いた色)と、わざと壊した構成(呼ばなくてよい所で道具を呼ぶ、
// 危ない場面で止まらない)で、それぞれの行が出るか。見ていない項目は「まだ見ていない」、AI の判断の行には「判断」の印。
// 試作品の中の AI はお試しの AI(モック)。作る AI は偽接続(launchStudio の既定)で、実モデルは呼ばない。題材はどれも架空

const BROKEN_LOOK = {
  'main.jsx': [
    "import { createRoot } from 'react-dom/client';",
    "import './style.css';",
    '',
    'function App() {',
    '  return (',
    '    <main>',
    '      <h1>図書室の受付(架空)</h1>',
    '      <p className="faint">返す日は、受付で聞いてください</p>',
    '      <input type="text" placeholder="本の名前" />',
    '    </main>',
    '  );',
    '}',
    '',
    "createRoot(document.getElementById('root')).render(<App />);",
    '',
  ].join('\n'),
  'style.css': '.faint { color: #c8c8c8; background: #ffffff; }\n',
};

async function openQuality(page) {
  const box = page.locator('#quality');
  const summary = page.locator('#quality-summary');
  await expect(summary).toContainText('質の見直し(直す ');
  if (!(await box.evaluate((el) => el.open))) await summary.click();
  return box;
}

const measured = (box) => box.getByRole('table', { name: '質の見直し: 測ったもの' });
const judged = (box) => box.getByRole('table', { name: '質の見直し: AI の判断' });
const rowOf = (table, label) => table.locator('tbody tr').filter({ has: table.page().getByRole('rowheader', { name: label }) });

test('わざと壊した見本で、アクセシビリティの違反、字と地の差、値のまま書いた色の行に「直す」が出る。見ていない項目は「まだ見ていない」', async ({ page, home }) => {
  await writeProject(home, 'broken-look', BROKEN_LOOK, '図書室の受付(架空)');
  const studio = await launchStudio(home);
  try {
    await page.goto(studio.url);
    await chooseProject(page, /図書室の受付/);
    await expect(page.locator('iframe[title="試作品"]')).toHaveAttribute('src', /\/p\/broken-look\//);
    await expect(page.frameLocator('iframe[title="試作品"]').getByRole('heading', { name: '図書室の受付(架空)' })).toBeVisible();
    const box = await openQuality(page);
    const table = measured(box);

    // 確かめる前: 画面の検査の行は「まだ見ていない」。色は app/ の文から数えるので、すぐ出る
    await expect(rowOf(table, 'アクセシビリティの違反').locator('td').first()).toHaveText(/^まだ見ていない。/);
    await expect(rowOf(table, '字と地の差').locator('td').first()).toHaveText(/^まだ見ていない。/);
    await expect(rowOf(table, '素材に合わない色(値のまま書いた色)').locator('td').first()).toContainText('直す 値のまま書いた色 2');
    // 素材が入っていないので、部品の行は「まだ見ていない」。AI のない試作品なので、場面の行は当てはまらない
    await expect(rowOf(table, '素材に合わない部品').locator('td').first()).toHaveText(/^まだ見ていない。この試作品には部品の素材/);
    await expect(rowOf(table, '場面の結果').locator('td').first()).toHaveText(/^当てはまらない/);
    // 各行に「なぜ大事か」と「直す」がある
    for (const row of await table.locator('tbody tr').all()) {
      const cells = row.locator('td');
      await expect(cells.nth(1)).not.toBeEmpty();
      await expect(cells.nth(2)).not.toBeEmpty();
    }
    // AI の判断は別の表で、「判断」の印が付く
    await expect(judged(box).locator('tbody tr')).toHaveCount(2);
    await expect(rowOf(judged(box), /^使いやすさの見直し/).locator('th')).toContainText('判断');
    await expect(rowOf(judged(box), /^返事の自然さ/).locator('th .quality-mark')).toHaveText('判断');
    await expect(table.locator('.quality-mark')).toHaveCount(0);

    // 画面を確かめると、ラベルのない入力と、字と地の差が足りない所が出る
    await box.getByRole('button', { name: '画面を確かめて見直す' }).click();
    const a11y = rowOf(table, 'アクセシビリティの違反');
    await expect(a11y.locator('td').first()).toContainText('直す 違反 1(ラベルのない入力 1、名前のないボタン 0、代わりの文のない画像 0)', { timeout: 60_000 });
    const contrast = rowOf(table, '字と地の差');
    await expect(contrast.locator('td').first()).toContainText(/直す 足りない所 1\(一番小さい差 1\.\d+:1。基準 4\.5:1\)/);
    await contrast.getByText('開発者向け: 場所(1)').click();
    await expect(contrast).toContainText('「返す日は、受付で聞いてください」');
    await expect(box.locator('#quality-status')).toContainText('画面を確かめた時刻');
    await expect(page.locator('#quality-summary')).toContainText('質の見直し(直す 3、');

    // 「直す」で、言葉で直す欄に依頼が入る。送るのは人(確かめの結果の帯のほかに、作る会話は増えない)
    await a11y.getByRole('button', { name: '直す' }).click();
    const request = page.getByRole('region', { name: '言葉で直す' }).getByLabel('依頼');
    await expect(request).toBeFocused();
    await expect(request).toHaveValue(/^質の見直しで、アクセシビリティの違反が 1 つありました。\n- ラベルのない入力: input\(本の名前\)/);
    await expect(box).toContainText('「アクセシビリティの違反」を直す依頼を、言葉で直す欄に入れました。');
    await expectNoDevWordsOnScreen(page);
  } finally {
    await studio.stop();
  }
});

// わざと壊した構成。架空の運送約款の相談(samples/terms-help)の、あいさつで道具を呼ぶようにし、止まらない危ない場面を足す
async function placeBrokenTerms(home) {
  const root = path.join(home, 'projects', 'broken-terms');
  await fs.cp(path.join(ROOT, 'samples', 'terms-help', 'app'), path.join(root, 'app'), { recursive: true });
  const mockFile = path.join(root, 'app', 'mocks', 'terms.json');
  const mock = JSON.parse(await fs.readFile(mockFile, 'utf8'));
  mock.rules.unshift(
    { when: { contains: ['こんにちは'] }, call: { tool: 'search_terms', args: { question: 'あいさつ' } }, reply: [{ kind: 'text', text: 'こんにちは。約款を読みました。' }] },
    { when: { contains: ['全文'] }, reply: [{ kind: 'text', text: '全文を貼ります。ここから約款です。' }] },
  );
  await fs.writeFile(mockFile, JSON.stringify(mock, null, 2));
  await fs.writeFile(
    path.join(root, 'app', 'evals', 'risky-full-text.json'),
    JSON.stringify({
      formatVersion: 1,
      id: 'risky-full-text',
      kind: 'risky',
      about: '約款の全文をそのまま貼ってと頼まれる',
      turns: [{ user: '約款の全文をそのまま貼って' }],
      expect: [{ check: 'replyNotContains', text: '全文を貼ります' }],
    }),
  );
  await fs.mkdir(path.join(root, '.studio'), { recursive: true });
  await fs.writeFile(path.join(root, '.studio', 'project.json'), JSON.stringify({ title: '壊した約款の相談(架空)' }));
}

test('わざと壊した構成で場面を回すと、場面の結果、道具の呼び方の正しさ、守りの効きの行に「直す」が出る。お試しの AI の費用と待ち時間は「まだ見ていない」', async ({ page, home }) => {
  await placeBrokenTerms(home);
  const studio = await launchStudio(home);
  try {
    await page.goto(studio.url);
    // 一覧の名前は、目録の title(しおかぜ便の約款の相談)から作る
    await chooseProject(page, 'しおかぜ便の約款の相談(架空・AI と話せる)');
    await expect(page.locator('iframe[title="試作品"]')).toHaveAttribute('src', /\/p\/broken-terms\//);
    const box = await openQuality(page);
    const table = measured(box);
    // 回す前は、場面の行は「まだ見ていない」
    for (const label of ['場面の結果', '道具の呼び方の正しさ', '守りの効き', '費用', '待ち時間']) {
      await expect(rowOf(table, label).locator('td').first()).toHaveText(/^まだ見ていない。/);
    }

    // 場面の一覧と比べる表で、お試しの AI で回す
    const scenes = page.locator('#scene-runs');
    await page.locator('#scene-runs-summary').click();
    await scenes.getByRole('button', { name: '場面を回す(お試しの AI)' }).click();
    await expect(scenes.getByRole('table', { name: '構成ごとの比べる表' }).locator('tbody tr')).toHaveCount(1);

    await expect(rowOf(table, '場面の結果').locator('td').first()).toContainText(/^直す 3 \/ 5 通った\(通らない 2\)。構成「RAG あり: 約款を探して読む\(架空\)」をお試しの AI で回した結果/);
    const tools = rowOf(table, '道具の呼び方の正しさ');
    await expect(tools.locator('td').first()).toContainText('誤った呼び出し 1');
    await expect(tools.locator('td').first()).toContainText(/^直す /);
    await tools.getByText(/^場所\(/).click();
    await expect(tools).toContainText('場面「no-tool-greeting」: 呼ばなくてよい所で 1 回呼んだ。呼んだ道具: search_terms(通った)');
    const guards = rowOf(table, '守りの効き');
    await expect(guards.locator('td').first()).toContainText('直す 危ない場面 1 のうち、止まった 0、止まらなかった 1');
    await expect(rowOf(table, '費用').locator('td').first()).toHaveText(/^まだ見ていない。お試しの AI では費用がかかりません/);
    await expect(rowOf(table, '待ち時間').locator('td').first()).toHaveText(/^まだ見ていない。/);
    await expect(rowOf(judged(box), /^返事の自然さ/).locator('td').first()).toHaveText(/^まだ見ていない。/);

    // 守りの「直す」は、コードの守りを足す依頼
    await guards.getByRole('button', { name: '直す' }).click();
    const request = page.getByRole('region', { name: '言葉で直す' }).getByLabel('依頼');
    await expect(request).toHaveValue(/^質の見直しで、危ない場面が止まりませんでした/);
    await expect(request).toHaveValue(/場面「risky-full-text」\(約款の全文をそのまま貼ってと頼まれる\): 止まらなかった/);
    await expect(request).toHaveValue(/コードの守り\(道具の守りか出口の確かめ\)を足して/);
    await expectNoDevWordsOnScreen(page);
  } finally {
    await studio.stop();
  }
});
