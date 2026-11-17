import fs from 'node:fs/promises';
import path from 'node:path';
import { ROOT, chooseProject, closeMore, expect, expectNoDevWords, launchStudio, openMore, test, writeProject } from './studio.js';
import { packFixture } from '../fixtures/design-packages/pack.js';

// 部品のパッケージをつなぐ(docs/design/user-journey.md の J5 の後半)。作る AI は偽接続(STUDIO_AGENT=fake)。
// パッケージと試作品は架空(test/fixtures/design-packages)。.tgz は npm を動かさずにテストの中で作る
const FIXTURE = path.join(ROOT, 'test', 'fixtures', 'design-packages');
const PACKAGE_DIR = path.join(FIXTURE, 'minato-ui');
const TRACK_URL = 'https://api.example.com/minato/track';
const LOGO_URL = 'https://cdn.example.com/minato/logo.png';
const projectView = async (studio, id) => (await studio.api('/api/projects')).projects.find((project) => project.id === id);

async function writeSample(home, id, title) {
  const files = Object.fromEntries(await Promise.all(
    (await fs.readdir(path.join(FIXTURE, 'app'))).map(async (name) => [name, await fs.readFile(path.join(FIXTURE, 'app', name), 'utf8')]),
  ));
  await writeProject(home, id, files, title);
  return path.join(home, 'projects', id);
}

const tgzFile = async (extra) => ({ name: 'minato-ui-1.2.0.tgz', mimeType: 'application/gzip', buffer: await packFixture(PACKAGE_DIR, extra) });

// 1. 聞く。人と同じ操作で答える
async function ask(section, { license, licenseName = '' }) {
  await section.getByRole('radio', { name: 'npm のパッケージ(部品のコード)' }).check();
  await expect(section.locator('#guides-have-note')).toContainText('npm pack を動かして作ったファイル(.tgz)');
  await section.getByLabel('誰の素材か').last().fill('架空のデザイン担当');
  await section.getByLabel('使ってよいか').selectOption({ label: license });
  if (licenseName) await section.getByLabel('ライセンスの名前').fill(licenseName);
  await section.getByRole('button', { name: '次へ(確かめる)' }).click();
  await expect(section.getByRole('group', { name: '2. 確かめる' })).toBeVisible();
}

const isOutside = (href) => {
  const url = new URL(href);
  return /^https?:$/.test(url.protocol) && !['127.0.0.1', 'localhost'].includes(url.hostname);
};

test('架空のパッケージで案内の 4 歩が通る。外への通信は警告が出て、試作品から外へ通信しない。許していない試作品からは import できない', async ({ page, request, home }) => {
  test.setTimeout(90_000);
  const root = await writeSample(home, 'minato', '部品のパッケージの見本');
  await writeSample(home, 'other', 'ほかの試作品');
  const studio = await launchStudio(home);
  try {
    // 網に出ようとした読み込みは、ここで捕まえて止める(本当に外へは出さない)
    const reached = [];
    await page.context().route((url) => isOutside(url.href), (route) => {
      reached.push(route.request().url());
      return route.abort();
    });
    await page.goto(studio.url);
    // 有効にする前は、どちらの試作品も import できない
    expect((await projectView(studio, 'minato')).lastBuild.errors[0].text).toContain('「@minato/ui」は使えません');
    await chooseProject(page, /部品のパッケージの見本/);
    const panel = await openMore(page);
    const section = panel.getByRole('region', { name: '部品と指針をつなぐ' });
    const steps = section.getByRole('list', { name: '取り込みの案内の歩' });
    await ask(section, { license: '公開のライセンスがある', licenseName: 'MIT' });
    await expect(steps.locator('[aria-current="step"]')).toHaveText('確かめる');

    // 2. 確かめる: インストールの時のスクリプトがあると断る。Studio は展開して読むだけで、何も動かさない
    const input = section.getByLabel('npm pack で作ったファイル(.tgz)');
    await input.setInputFiles(await tgzFile({ 'package.json': JSON.stringify({ name: '@minato/ui', version: '1.2.0', license: 'MIT', scripts: { postinstall: 'node setup.js' } }) }));
    await expect(section.locator('#guides-problems')).toContainText('インストールの時に動くスクリプトがあります(postinstall)');
    await expect(section.getByRole('button', { name: '次へ(見本で試す)' })).toBeDisabled();
    await input.setInputFiles(await tgzFile());
    await expect(section.locator('#guides-checked')).toContainText('部品のパッケージ「@minato/ui」(1.2.0)を確かめました。ファイルが 5 個あります。');
    await expect(section.locator('#guides-checked')).toContainText('外への通信が 3 か所あります');
    await expect(section.locator('#guides-checked')).toContainText('フォルダーの中のライセンスの書き方: 「MIT」');
    await section.getByRole('button', { name: '次へ(見本で試す)' }).click();

    // 3. 見本で試す: 外への通信の場所と、試作品での使い方と、直す AI への決まりが、有効にする前に見える
    const tryStep = section.getByRole('group', { name: '3. 見本で試す' });
    const alert = tryStep.getByRole('alert');
    await expect(alert).toContainText('外への通信が 3 か所あります。試作品は外へ通信できないので、この通信は届きません');
    await expect(alert).toContainText(`index.js 7 行目: ${TRACK_URL}`);
    await expect(alert).toContainText(`index.js 12 行目: ${LOGO_URL}`);
    await expect(alert).toContainText('index.js 7 行目: 通信の道具(fetch)');
    await expect(tryStep).toContainText("import { MinatoButton, ShopCard } from '@minato/ui';");
    await expect(tryStep.locator('pre').last()).toContainText('「@minato/ui」(1.2.0)を import できる。使える名前: MinatoButton, ShopCard');
    // 有効にする前は、何も置かない
    await expect(fs.lstat(path.join(root, '.studio', 'materials'))).rejects.toThrow();
    await tryStep.getByRole('button', { name: '次へ(有効にする)' }).click();

    // 4. 有効にする: 出典とライセンスの一覧を見てから押す。部品のパッケージは、この試作品だけ
    const enableStep = section.getByRole('form', { name: '4. 有効にする' });
    await expect(enableStep.locator('.guides-facts')).toContainText('公開のライセンス(MIT)');
    await expect(enableStep.locator('.guides-facts')).toContainText('3 か所(試作品からは届きません)');
    await expect(enableStep.getByRole('radio', { name: 'これからの試作品全部(この試作品にも入れます)' })).toBeDisabled();
    await expect(enableStep.locator('#guides-blocked')).toBeHidden();
    await expectNoDevWords(section);
    await enableStep.getByRole('button', { name: '有効にする' }).click();
    await expect(section.locator('#guides-message')).toHaveText('有効にしました。この試作品は「@minato/ui」を import できます。直す AI は次の依頼から使えます。');
    await expect(section.locator('#guides-enabled')).toContainText('有効にしています: 部品のパッケージ「@minato/ui」(1.2.0)');
    await expect(section.locator('#guides-enabled')).toContainText('外への通信が 3 か所あります。試作品からは届きません。');
    await expect(steps.locator('[aria-current="step"]')).toHaveText('聞く');
    // 中身は試作品のフォルダーの外(作る AI が読めない所)に置く
    await expect(fs.lstat(path.join(root, 'app', 'node_modules'))).rejects.toThrow();
    expect((await fs.stat(path.join(root, '.studio', 'materials', 'packages', 'node_modules', '@minato', 'ui', 'index.js'))).isFile()).toBe(true);
    await closeMore(page);

    // 試作品は部品を使って描ける。部品の中の外への通信は、CSP が止めて外へ出ない
    const app = page.frameLocator('iframe[title="試作品"]');
    await expect(app.getByTestId('minato-card')).toContainText('みなと商店(架空)');
    await expect(app.getByRole('button', { name: '案内を見る' })).toBeVisible();
    await expect.poll(async () => (await app.getByTestId('violations').textContent()) ?? '').toContain(LOGO_URL);
    await expect.poll(async () => (await app.getByTestId('violations').textContent()) ?? '').toContain(TRACK_URL);
    expect(reached).toEqual([]);
    const src = await page.locator('iframe[title="試作品"]').getAttribute('src');
    const csp = (await request.get(new URL('./', new URL(src, studio.url)).href)).headers()['content-security-policy'];
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("connect-src 'none'");

    // 許していない試作品からは import できない
    const otherRow = await chooseProject(page, /ほかの試作品/);
    await expect(otherRow).toContainText('表示できません');
    const other = await projectView(studio, 'other');
    expect(other.lastBuild.ok).toBe(false);
    expect(other.lastBuild.errors[0].text).toContain('「@minato/ui」は使えません');

    // 引き継ぎに、出典とライセンスと、受け取ったファイルが入る
    const handoff = JSON.parse((await studio.post('/api/projects/minato/handoff', { purpose: '架空の目的' })).text);
    const handoffJson = JSON.parse(await fs.readFile(path.join(handoff.handoff.dir, 'handoff.json'), 'utf8'));
    expect(handoffJson.materials.packages[0]).toMatchObject({ name: '@minato/ui', version: '1.2.0', source: '架空のデザイン担当', license: '公開のライセンス(MIT)', externalCalls: 3 });
    expect((await fs.stat(path.join(handoff.handoff.dir, handoffJson.materials.packages[0].file))).isFile()).toBe(true);
    const readme = await fs.readFile(path.join(handoff.handoff.dir, 'README.md'), 'utf8');
    expect(readme).toContain('## 素材(部品のパッケージ)');
  } finally {
    await studio.stop();
  }
});

test('ライセンスが分からないときは「有効にする」が押せず、理由が出る。画面を通さずに送っても断る。外すと import できなくなる', async ({ page, home }) => {
  test.setTimeout(90_000);
  const root = await writeSample(home, 'minato', '部品のパッケージの見本');
  const studio = await launchStudio(home);
  try {
    await page.goto(studio.url);
    await chooseProject(page, /部品のパッケージの見本/);
    const panel = await openMore(page);
    const section = panel.getByRole('region', { name: '部品と指針をつなぐ' });
    await ask(section, { license: '分からない' });
    await section.getByLabel('npm pack で作ったファイル(.tgz)').setInputFiles(await tgzFile());
    await expect(section.locator('#guides-checked')).toContainText('部品のパッケージ「@minato/ui」(1.2.0)を確かめました');
    await section.getByRole('button', { name: '次へ(見本で試す)' }).click();
    await section.getByRole('button', { name: '次へ(有効にする)' }).click();

    const enableStep = section.getByRole('form', { name: '4. 有効にする' });
    await expect(enableStep.getByRole('button', { name: '有効にする' })).toBeDisabled();
    await expect(enableStep.locator('#guides-blocked')).toHaveText('有効にできません。ライセンスが分かりません。素材の持ち主に、試作品に使ってよいかを確かめてください。分かったら「1. 聞く」の「使ってよいか」を選び直してください');
    const direct = await studio.post('/api/projects/minato/materials/packages', {
      tarball: (await packFixture(PACKAGE_DIR)).toString('base64'),
      answers: { license: 'unknown' },
      source: '架空',
    });
    expect(direct.status).toBe(409);
    await expect(fs.lstat(path.join(root, '.studio', 'materials'))).rejects.toThrow();

    // 答え直すと有効にできる。外すと、試作品がまだ使っているので表示できないと知らせる
    await enableStep.getByRole('button', { name: '戻る' }).click();
    await section.getByRole('group', { name: '3. 見本で試す' }).getByRole('button', { name: '戻る' }).click();
    await section.getByRole('group', { name: '2. 確かめる' }).getByRole('button', { name: '戻る' }).click();
    await section.getByLabel('使ってよいか').selectOption({ label: '社内の素材で、使う許可がある' });
    await section.getByRole('button', { name: '次へ(確かめる)' }).click();
    await expect(section.locator('#guides-checked')).toContainText('ファイルが 5 個あります。');
    await section.getByRole('button', { name: '次へ(見本で試す)' }).click();
    await section.getByRole('button', { name: '次へ(有効にする)' }).click();
    await enableStep.getByRole('button', { name: '有効にする' }).click();
    await expect(section.locator('#guides-enabled')).toContainText('使ってよいか: 社内の素材で、使う許可がある');
    expect((await projectView(studio, 'minato')).lastBuild.ok).toBe(true);
    await section.getByRole('button', { name: '部品のパッケージ「@minato/ui」を外す' }).click();
    await expect(section.locator('#guides-message')).toContainText('部品のパッケージ「@minato/ui」を外しました。試作品がまだ使っているので、表示できません。');
    await expect(section.locator('#guides-enabled')).toBeHidden();
    expect((await projectView(studio, 'minato')).lastBuild.errors[0].text).toContain('「@minato/ui」は使えません');
  } finally {
    await studio.stop();
  }
});
