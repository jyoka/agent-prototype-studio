import path from 'node:path';
import { ROOT, SAMPLES, chooseSample, expect, launchStudio, openDevDetails, test } from './studio.js';

// 「分かるか」の確かめ(ux-redesign.md 9 節)のスクリーンショットの置き場。test-results/ は git が無視する
const UX_SHOTS = path.join(ROOT, 'test-results', 'ux');

// 偽の claude。--version と auth status に答え、auth status には架空のメールアドレスと組織を含む
const FAKE = path.join(ROOT, 'test', 'fixtures', 'fake-claude.js');
const FAKE_SECRETS = ['fictional-user@example.com', '架空の組織', 'fictional-org-0000'];

test('U1: 新しい置き場で開くと、AI と話せる求人相談が選ばれ、一覧は利用者の言葉の名前で並ぶ', async ({ page, home }) => {
  const studio = await launchStudio(home);
  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(studio.url);

    // 一覧の順と名前。名前は目録の title と、試作品の中の AI があるかから作る。一覧は上の帯のメニューで、最初は閉じている
    const list = page.getByRole('navigation', { name: '試作品の一覧', includeHidden: true }).getByRole('list', { includeHidden: true }).getByRole('button', { includeHidden: true });
    const names = [SAMPLES.jobConsult, SAMPLES.studyConsult, SAMPLES.partTime, SAMPLES.library].map((sample) => sample.name);
    await expect(list).toHaveText(names.map((name) => new RegExp(`^${name.replace(/[()]/g, '\\$&')}`)));

    // 最初に選ばれているのは求人相談
    await expect(list.first()).toHaveAttribute('aria-current', 'true');
    await expect(page.locator('#project-title')).toHaveText(SAMPLES.jobConsult.name);
    const iframe = page.locator('iframe[title="試作品"]');
    expect(await iframe.getAttribute('src')).toMatch(/\/p\/sample-job-consult\/[a-f0-9]{32}\/$/);
    const app = page.frameLocator('iframe[title="試作品"]');
    await expect(app.getByRole('heading', { name: 'しおかぜ求人相談' })).toBeVisible();
    await expect(app.getByRole('region', { name: '会話' }).getByRole('listitem').first()).toContainText('しおかぜ求人相談の案内役です');

    // 最初の画面を 1440x900 で撮る(人の 5 秒の確かめと、新しい文脈のエージェントに見せるため)
    await page.screenshot({ path: path.join(UX_SHOTS, 'P20-first.png') });
  } finally {
    await studio.stop();
  }
});

test('npm start で起動し、ブラウザでサンプルの試作品を操作できる', async ({ page, home }) => {
  const studio = await launchStudio(home, { useNpm: true });
  try {
    expect(studio.output()).toContain('Prototype Studio を起動しました。');
    expect(studio.output()).toContain('ビルド成功: sample-library');

    await page.goto(studio.url);
    await expect(page.locator('#connection')).toBeHidden();
    // 鍵は URL から消え、履歴に残らない
    expect(new URL(page.url()).hash).toBe('');
    // 図書室(AI のない試作品)を明示して選ぶ
    await chooseSample(page, SAMPLES.library);
    await expect(page.locator('#build-status')).toContainText('ビルドに成功しました');

    const iframe = page.locator('iframe[title="試作品"]');
    await expect(iframe).toHaveAttribute('sandbox', 'allow-scripts allow-forms');
    expect(await iframe.getAttribute('src')).toMatch(/^http:\/\/localhost:\d+\/p\/sample-library\/[a-f0-9]{32}\/$/);

    const app = page.frameLocator('iframe[title="試作品"]');
    await expect(app.getByRole('heading', { name: 'こもれび図書室' })).toBeVisible();
    await expect(app.getByText('架空のデータです。')).toBeVisible();
    await expect(app.locator('.summary')).toHaveText('全 8 冊、貸出できる本 6 冊');

    // 探す
    await app.getByLabel('書名か著者で探す').fill('雲');
    const list = app.getByRole('list', { name: '本の一覧' });
    await expect(list.getByRole('listitem')).toHaveCount(1);
    await list.getByRole('button', { name: /まちの雲図鑑/ }).click();

    // 借りる、返す
    const detail = app.getByRole('region', { name: '本の詳細' });
    await expect(detail.getByRole('heading', { name: 'まちの雲図鑑' })).toBeVisible();
    await detail.getByRole('button', { name: '借りる' }).click();
    await expect(detail.getByText('この本は貸出中です。')).toBeVisible();
    await expect(app.locator('.summary')).toHaveText('全 8 冊、貸出できる本 5 冊');
    await detail.getByRole('button', { name: '返す' }).click();
    await expect(app.locator('.summary')).toHaveText('全 8 冊、貸出できる本 6 冊');

    // 分野で絞る
    await app.getByLabel('書名か著者で探す').fill('');
    await app.getByRole('group', { name: '分野' }).getByRole('button', { name: '小説' }).click();
    await expect(list.getByRole('listitem')).toHaveCount(2);

    // 登録する
    await app.getByRole('group', { name: '分野' }).getByRole('button', { name: 'すべて' }).click();
    const form = app.getByRole('form', { name: '本を登録する' });
    await form.getByLabel('書名').fill('架空の星座あつめ');
    await form.getByLabel('著者').fill('夜空 ひかる');
    await form.getByRole('button', { name: '登録する' }).click();
    await expect(app.locator('.summary')).toHaveText('全 9 冊、貸出できる本 7 冊');
    await expect(detail.getByRole('heading', { name: '架空の星座あつめ' })).toBeVisible();

    // 試作品からエラーは届いていない(仕組みの引き出しの「試作品からの知らせ」)
    await openDevDetails(page);
    await expect(page.locator('#events-empty')).toBeVisible();

    // 再読み込みしても、同じタブなら使い続けられる
    await page.reload();
    await expect(page.locator('#connection')).toBeHidden();
    await chooseSample(page, SAMPLES.library);
    await expect(app.getByRole('heading', { name: 'こもれび図書室' })).toBeVisible();
  } finally {
    await studio.stop();
  }
});

test('STUDIO_AGENT を書かずに起動すると自動で、Claude Code がなければ直す AI は使えないと出す', async ({ page, home }) => {
  const studio = await launchStudio(home, { env: { STUDIO_AGENT: undefined, STUDIO_CLAUDE_BIN: path.join(home, 'no-such-claude') } });
  try {
    // URL の行の後の表示は、別の書き込みで少し遅れて届くことがある(macOS のパイプは非同期)
    await expect.poll(() => studio.output()).toContain('作る AI: Claude Code を使えません。claude が見つかりません');
    const { agent } = await studio.api('/api/projects');
    expect(agent).toMatchObject({ mode: 'auto', kind: 'claude', status: 'missing', ready: false, auth: null });

    await page.goto(studio.url);
    await chooseSample(page, SAMPLES.library);
    await expect(page.locator('#agent-status')).toContainText('claude が見つかりません');
    await expect(page.getByRole('button', { name: '送る' })).toBeDisabled();
    // 偽接続には落とさない。試験用の依頼の例は出ない
    await expect(page.locator('#examples')).toBeHidden();
    // 試す画面は使える
    await expect(page.frameLocator('iframe[title="試作品"]').getByRole('heading', { name: 'こもれび図書室' })).toBeVisible();
  } finally {
    await studio.stop();
  }
});

test('自動で偽の claude を指すと、ログインしていれば Claude Code を使い、ログインの値は出さない', async ({ page, home }) => {
  test.skip(process.platform === 'win32', '偽の claude(Node のスクリプト)を直接起動できないため');
  const studio = await launchStudio(home, { env: { STUDIO_AGENT: undefined, STUDIO_CLAUDE_BIN: FAKE } });
  try {
    const data = await studio.api('/api/projects');
    expect(data.agent).toMatchObject({ mode: 'auto', kind: 'claude', status: 'ready', ready: true, version: '2.1.311' });
    expect(data.agent.auth).toEqual({ loggedIn: true, method: 'claude.ai' });
    await page.goto(studio.url);
    await expect(page.locator('#agent-status')).toContainText('接続: Claude Code 2.1.311');
    for (const secret of FAKE_SECRETS) {
      expect(JSON.stringify(data)).not.toContain(secret);
      expect(studio.output()).not.toContain(secret);
      await expect(page.locator('body')).not.toContainText(secret);
    }
  } finally {
    await studio.stop();
  }
});

test('自動で Claude Code にログインしていなければ、直す AI は使えないと出す', async ({ page, home }) => {
  test.skip(process.platform === 'win32', '偽の claude(Node のスクリプト)を直接起動できないため');
  const studio = await launchStudio(home, { env: { STUDIO_AGENT: undefined, STUDIO_CLAUDE_BIN: FAKE, FAKE_CLAUDE_AUTH: 'logged-out' } });
  try {
    const { agent } = await studio.api('/api/projects');
    expect(agent).toMatchObject({ mode: 'auto', status: 'not-logged-in', ready: false, auth: { loggedIn: false, method: 'none' } });
    await page.goto(studio.url);
    await expect(page.locator('#agent-status')).toContainText('Claude Code にログインしていません');
    await expect(page.getByRole('button', { name: '送る' })).toBeDisabled();
  } finally {
    await studio.stop();
  }
});

test('STUDIO_AGENT を消すか claude にするテストが、偽の claude もない場所も指さなければ、起動しない', async ({ home }) => {
  await expect(launchStudio(home, { env: { STUDIO_AGENT: undefined } })).rejects.toThrow(/STUDIO_CLAUDE_BIN/);
  await expect(launchStudio(home, { env: { STUDIO_AGENT: 'claude' } })).rejects.toThrow(/STUDIO_CLAUDE_BIN/);
});

test('launchStudio の既定は偽接続', async ({ home }) => {
  const studio = await launchStudio(home);
  try {
    const { agent } = await studio.api('/api/projects');
    expect(agent).toMatchObject({ mode: 'fake', kind: 'fake', status: 'ready' });
  } finally {
    await studio.stop();
  }
});
