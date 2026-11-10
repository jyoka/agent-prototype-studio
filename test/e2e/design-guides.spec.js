import fs from 'node:fs/promises';
import path from 'node:path';
import { ROOT, chooseProject, chooseTestRequest, closeMore, expect, expectNoDevWords, launchStudio, openMore, test, writeProject } from './studio.js';

// 部品と指針をつなぐ、取り込みの案内(docs/design/user-journey.md の J5)。作る AI は偽接続(STUDIO_AGENT=fake)。
// 部品集と指針の文は架空(test/fixtures/design-guides)
const FIXTURE = path.join(ROOT, 'test', 'fixtures', 'design-guides');
const GUIDE_FILES = [path.join(FIXTURE, 'guides', 'voice.md'), path.join(FIXTURE, 'guides', 'look.md')];
const STORYBOOK_DIR = path.join(FIXTURE, 'storybook-static');
const FONT_URL = 'https://fonts.example.com/minato-gothic.css';
const BANNER_URL = 'https://cdn.example.com/minato/banner.png';

async function writeSample(home, id = 'minato') {
  const files = Object.fromEntries(await Promise.all(
    (await fs.readdir(path.join(FIXTURE, 'app'))).map(async (name) => [name, await fs.readFile(path.join(FIXTURE, 'app', name), 'utf8')]),
  ));
  await writeProject(home, id, files, '部品と指針の見本');
  return path.join(home, 'projects', id);
}

// 1. 聞く。人と同じ操作で答える
async function ask(panel, { have, source = '架空のデザイン担当', license, licenseName = '' }) {
  await panel.getByRole('radio', { name: have }).check();
  await panel.getByLabel('誰の素材か').last().fill(source);
  await panel.getByLabel('使ってよいか').selectOption({ label: license });
  if (licenseName) await panel.getByLabel('ライセンスの名前').fill(licenseName);
  await panel.getByRole('button', { name: '次へ(確かめる)' }).click();
  await expect(panel.getByRole('group', { name: '2. 確かめる' })).toBeVisible();
}

const isOutside = (href) => {
  const url = new URL(href);
  return /^https?:$/.test(url.protocol) && !['127.0.0.1', 'localhost'].includes(url.hostname);
};

test('架空の指針の文で、案内の 4 歩が通る。外への URL は警告が出て、作る AI が使っても試作品から外へ通信しない', async ({ page, request, home }) => {
  test.setTimeout(90_000);
  const studio = await launchStudio(home);
  try {
    const root = await writeSample(home);
    // 外への通信がない。CSP が止めた読み込みも request の知らせは出るので、網に出たものと、止められた理由を分けて見る。
    // 網に出ようとした読み込みは、ここで捕まえて止める(本当に外へは出さない)
    const reached = [];
    await page.context().route((url) => isOutside(url.href), (route) => {
      reached.push(route.request().url());
      return route.abort();
    });
    const failed = [];
    page.on('requestfailed', (req) => {
      if (isOutside(req.url())) failed.push({ url: req.url(), error: req.failure()?.errorText ?? '' });
    });
    await page.goto(studio.url);
    await chooseProject(page, /部品と指針の見本/);
    const panel = await openMore(page);
    const section = panel.getByRole('region', { name: '部品と指針をつなぐ' });
    const steps = section.getByRole('list', { name: '取り込みの案内の歩' });
    await expect(steps.locator('[aria-current="step"]')).toHaveText('聞く');

    // 1. 聞く: 持っていないもの、まだつなげないものは、次にすることを出して進まない
    await section.getByRole('radio', { name: 'npm のパッケージ(部品のコード)' }).check();
    await expect(section.locator('#guides-have-note')).toContainText('npm のパッケージ(部品のコード)は、まだつなげません');
    await expect(section.getByRole('button', { name: '次へ(確かめる)' })).toBeDisabled();
    await section.getByRole('radio', { name: '分からない' }).check();
    await expect(section.locator('#guides-have-note')).toContainText('デザイナーに、次のように聞いてください');
    await section.getByRole('radio', { name: 'まだ持っていない' }).check();
    await expect(section.locator('#guides-have-note')).toContainText('既定の素材');
    await ask(section, { have: '指針の文(Markdown のファイル)', license: '公開のライセンスがある', licenseName: 'MIT' });
    await expect(steps.locator('[aria-current="step"]')).toHaveText('確かめる');

    // 2. 確かめる: 形の誤りは利用者の言葉で返す
    const files = section.getByLabel('指針の文のファイル(.md。いくつでも選べます)');
    await files.setInputFiles({ name: 'key.md', mimeType: 'text/markdown', buffer: Buffer.from(`# 決まり\n\nsk-ant-api03-${'a'.repeat(40)}\n`) });
    await expect(section.locator('#guides-problems')).toContainText('秘密らしい文字列');
    await expect(section.getByRole('button', { name: '次へ(見本で試す)' })).toBeDisabled();
    await files.setInputFiles(GUIDE_FILES);
    await expect(section.locator('#guides-checked')).toContainText('指針の文を確かめました。ファイルが 2 個あります。');
    await expect(section.locator('#guides-checked')).toContainText('外への URL が 1 個あります');
    await section.getByRole('button', { name: '次へ(見本で試す)' }).click();

    // 3. 見本で試す: 外への URL の場所と、直す AI が読む写しと決まりの文が、有効にする前に見える
    const tryStep = section.getByRole('group', { name: '3. 見本で試す' });
    await expect(tryStep.getByRole('alert')).toContainText('外への URL が 1 個あります。試作品は外へ通信できないので');
    await expect(tryStep.getByRole('alert')).toContainText(`look.md 4 行目: ${FONT_URL}`);
    await expect(tryStep).toContainText('design/guides/voice.md(架空の会社の文の決まり)');
    await expect(tryStep).toContainText('ボタンの文は「〜する」の形にする');
    await expect(tryStep.locator('pre').last()).toContainText('作る前と直す前に読み、従う');
    // 有効にする前は、写しを置かない
    await expect(fs.lstat(path.join(root, 'app', 'design'))).rejects.toThrow();
    await tryStep.getByRole('button', { name: '次へ(有効にする)' }).click();

    // 4. 有効にする: 出典とライセンスの一覧を見てから押す
    const enableStep = section.getByRole('form', { name: '4. 有効にする' });
    await expect(enableStep.locator('.guides-facts')).toContainText('公開のライセンス(MIT)');
    await expect(enableStep.locator('.guides-facts')).toContainText('架空のデザイン担当');
    await expect(enableStep.locator('#guides-blocked')).toBeHidden();
    await expectNoDevWords(section);
    await enableStep.getByLabel('有効にする理由(書かなくても進めます)').fill('架空の会社の決まりで作るため');
    await enableStep.getByRole('button', { name: '有効にする' }).click();
    await expect(section.locator('#guides-message')).toHaveText('有効にしました。直す AI は次の依頼から、指針の文を読みます。');
    await expect(section.locator('#guides-enabled')).toContainText('有効にしています: 指針の文(ファイル 2 個)');
    await expect(section.locator('#guides-enabled')).toContainText('使ってよいか: 公開のライセンス(MIT)');
    await expect(section.locator('#guides-enabled')).toContainText('外への URL が 1 個あります。試作品からは読めません。');
    await expect(steps.locator('[aria-current="step"]')).toHaveText('聞く');
    expect(await fs.readFile(path.join(root, 'app', 'design', 'guides', 'look.md'), 'utf8')).toBe(await fs.readFile(GUIDE_FILES[1], 'utf8'));
    await closeMore(page);

    // 作る AI(偽接続)は写しを読んで作る。写しの外への URL をそのまま画像に使っても、試作品から外へ通信しない
    await chooseTestRequest(page, '指針に沿って作って');
    await page.getByRole('button', { name: '送る' }).click();
    const run = page.getByRole('list', { name: '作る会話' }).locator('> li.run').last();
    await expect(run.locator('.run-status')).toContainText('終わりました', { timeout: 30_000 });
    const app = page.frameLocator('iframe[title="試作品"]');
    await expect(app.getByTestId('guided')).toContainText('架空の会社の文の決まり');
    await expect(app.getByTestId('guided')).toContainText('架空の会社の見た目の決まり');
    await expect(app.getByTestId('outside-image')).toHaveAttribute('src', FONT_URL);
    await expect(app.getByTestId('violations')).toContainText(FONT_URL);
    await expect.poll(() => failed.length).toBeGreaterThan(0);
    // Chromium の止めた理由は csp と出る
    expect(failed).toEqual([{ url: FONT_URL, error: 'csp' }]);
    expect(reached).toEqual([]);
    const src = await page.locator('iframe[title="試作品"]').getAttribute('src');
    const csp = (await request.get(new URL('./', new URL(src, studio.url)).href)).headers()['content-security-policy'];
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("connect-src 'none'");

    // 引き継ぎに出典とライセンスが入る
    const handoff = JSON.parse((await studio.post('/api/projects/minato/handoff', { purpose: '架空の目的' })).text);
    const handoffJson = JSON.parse(await fs.readFile(path.join(handoff.handoff.dir, 'handoff.json'), 'utf8'));
    expect(handoffJson.materials.guides[0].source).toBe('架空のデザイン担当');
    expect(handoffJson.materials.guides[0].license).toBe('公開のライセンス(MIT)');
    expect(handoffJson.materials.guides[0].files.map((file) => file.copy)).toEqual(['app/design/guides/voice.md', 'app/design/guides/look.md']);
    const readme = await fs.readFile(path.join(handoff.handoff.dir, 'README.md'), 'utf8');
    expect(readme).toContain('## 素材(部品と指針)');
    expect(readme).toContain('外への URL が 1 個あった');
  } finally {
    await studio.stop();
  }
});

test('架空の Storybook で、ライセンスが分からないと「有効にする」が押せず、理由が出る。答え直すと、これからの試作品全部に有効にできる', async ({ page, home }) => {
  test.setTimeout(90_000);
  const studio = await launchStudio(home);
  try {
    const root = await writeSample(home);
    await page.goto(studio.url);
    await chooseProject(page, /部品と指針の見本/);
    const panel = await openMore(page);
    const section = panel.getByRole('region', { name: '部品と指針をつなぐ' });

    await ask(section, { have: 'Storybook を書き出したフォルダー(storybook build で作ったもの)', license: '分からない' });
    await section.getByLabel('Storybook を書き出したフォルダー', { exact: true }).setInputFiles(STORYBOOK_DIR);
    await expect(section.locator('#guides-checked')).toContainText('部品の一覧を確かめました。部品が 3 個あります。');
    await section.getByRole('button', { name: '次へ(見本で試す)' }).click();

    // 外への URL を含む部品は、部品の名前で警告が出る
    const tryStep = section.getByRole('group', { name: '3. 見本で試す' });
    await expect(tryStep.getByRole('alert')).toContainText(`部品「Banner」: ${BANNER_URL}`);
    const table = tryStep.getByRole('table', { name: '部品の一覧の見本' });
    await expect(table.getByRole('row')).toHaveCount(4);
    await expect(table.getByRole('row', { name: /ShopCard/ })).toContainText('お店の名前と案内の文を並べるカード');
    await expect(table.getByRole('row', { name: /Button/ })).toContainText('Primary、Disabled');
    await tryStep.getByRole('button', { name: '次へ(有効にする)' }).click();

    // ライセンスが分からないときは押せず、理由が出る
    const enableStep = section.getByRole('form', { name: '4. 有効にする' });
    const enable = enableStep.getByRole('button', { name: '有効にする' });
    await expect(enable).toBeDisabled();
    await expect(enableStep.locator('#guides-blocked')).toHaveText('有効にできません。ライセンスが分かりません。素材の持ち主に、試作品に使ってよいかを確かめてください。分かったら「1. 聞く」の「使ってよいか」を選び直してください');
    await expect(enableStep.locator('.guides-facts')).toContainText('分からない');
    // 画面を通さずに送っても、サーバーが断る
    const direct = await studio.post('/api/projects/minato/materials/guides', {
      kind: 'storybook',
      files: [{ path: 'sb/index.json', text: await fs.readFile(path.join(STORYBOOK_DIR, 'index.json'), 'utf8') }],
      answers: { license: 'unknown' },
      source: '架空',
    });
    expect(direct.status).toBe(409);
    await expect(fs.lstat(path.join(root, 'app', 'design'))).rejects.toThrow();

    // 1. 聞く に戻って答え直す。選んだフォルダーはそのままで、確かめ直す
    await enableStep.getByRole('button', { name: '戻る' }).click();
    await section.getByRole('group', { name: '3. 見本で試す' }).getByRole('button', { name: '戻る' }).click();
    await section.getByRole('group', { name: '2. 確かめる' }).getByRole('button', { name: '戻る' }).click();
    await section.getByLabel('使ってよいか').selectOption({ label: '社内の素材で、使う許可がある' });
    await section.getByRole('button', { name: '次へ(確かめる)' }).click();
    await expect(section.locator('#guides-checked')).toContainText('部品が 3 個あります。');
    await section.getByRole('button', { name: '次へ(見本で試す)' }).click();
    await section.getByRole('button', { name: '次へ(有効にする)' }).click();
    await expect(enableStep.locator('#guides-blocked')).toBeHidden();
    await enableStep.getByRole('radio', { name: 'これからの試作品全部(この試作品にも入れます)' }).check();
    await expect(enable).toBeEnabled();
    await enable.click();
    await expect(section.locator('#guides-message')).toHaveText('有効にしました。これからの試作品にも入れます。直す AI は次の依頼から、Storybook の部品の一覧を読みます。');
    await expect(section.locator('#guides-enabled')).toContainText('これからの試作品全部に入れます: Storybook の部品の一覧');
    expect(await fs.readFile(path.join(root, 'app', 'design', 'components.md'), 'utf8')).toContain('## Banner');

    // 新しい試作品にも写す
    const created = JSON.parse((await studio.post('/api/projects', { sentence: '架空のお店の案内を作りたい', guide: 'fixed' })).text);
    expect(await fs.readFile(path.join(home, 'projects', created.project.id, 'app', 'design', 'components.md'), 'utf8')).toContain('## ShopCard');

    // 作る AI が写しを変えると止まる。作る AI には直せないので、人が「写しを戻す」で戻す
    await closeMore(page);
    await chooseTestRequest(page, '指針の写しを書き換えて');
    await page.getByRole('button', { name: '送る' }).click();
    const run = page.getByRole('list', { name: '作る会話' }).locator('> li.run').last();
    await expect(run.locator('[data-kind="gave-up"]')).toContainText('つないだ素材のファイルに問題があります', { timeout: 30_000 });
    const { runs } = await studio.api('/api/projects/minato/build-requests');
    expect(runs.at(-1).launches).toHaveLength(1);
    await openMore(page);
    await expect(section.locator('#guides-enabled')).toContainText('有効にしたときから変わっています');
    await section.getByRole('button', { name: '写しを戻す' }).click();
    await expect(section.locator('#guides-message')).toHaveText('写しを戻しました。試す欄の試作品を作り直しました。');
    await expect(section.getByRole('button', { name: '写しを戻す' })).toBeHidden();

    // 外すと写しを消す。これからの試作品の分は、別に外す
    await section.getByRole('button', { name: 'Storybook の部品の一覧を外す' }).click();
    await expect(section.locator('#guides-message')).toContainText('Storybook の部品の一覧を外しました');
    await expect(fs.lstat(path.join(root, 'app', 'design', 'components.md'))).rejects.toThrow();
    await section.getByRole('button', { name: 'Storybook の部品の一覧を、これからの試作品から外す' }).click();
    await expect(section.locator('#guides-message')).toContainText('これからの試作品には、Storybook の部品の一覧を入れません');
    await expect(section.locator('#guides-enabled')).toBeHidden();
  } finally {
    await studio.stop();
  }
});
