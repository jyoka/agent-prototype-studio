import fs from 'node:fs/promises';
import path from 'node:path';
import { ROOT, chooseProject, chooseTestRequest, closeMore, expect, launchStudio, openDevDetails, openMore, test, writeProject } from './studio.js';

// 自分のトークンをつなぐ(docs/design/user-journey.md の J4)。作る AI は偽接続(STUDIO_AGENT=fake)。トークンと見本は架空
const FIXTURE = path.join(ROOT, 'test', 'fixtures', 'design-tokens');
const TOKENS_FILE = path.join(FIXTURE, 'tokens.json');
const FAILED_TEXT = '終わりました。直す AI が直しきれませんでした。つないだ素材と合わないところがあります';
const FIXED_TEXT = '終わりました。確かめて見つけた問題を、直す AI が直しました';
const GREEN = 'rgb(0, 128, 64)';

async function writeSample(home, id = 'minato') {
  const files = Object.fromEntries(await Promise.all(
    (await fs.readdir(path.join(FIXTURE, 'app'))).map(async (name) => [name, await fs.readFile(path.join(FIXTURE, 'app', name), 'utf8')]),
  ));
  await writeProject(home, id, files, 'トークンの見本');
  return path.join(home, 'projects', id);
}

// その他の引き出しから、人と同じ操作でつなぐ
async function connectTokens(page, { source = '架空のデザイン担当', reason = '' } = {}) {
  const panel = await openMore(page);
  await panel.getByLabel('トークンのファイル').setInputFiles(TOKENS_FILE);
  await expect(panel.locator('#tokens-summary')).toContainText('形を確かめました');
  await panel.getByLabel('誰の素材か').fill(source);
  if (reason) await panel.getByLabel('つなぐ理由').fill(reason);
  await panel.getByRole('button', { name: 'つなぐ', exact: true }).click();
  await expect(panel.locator('#tokens-message')).toHaveText('つなぎました。試す欄の試作品に入れました。');
  return panel;
}

test('架空のトークンをつなぐと、見本の色と字が変わる。外への通信はなく、外すと戻る', async ({ page, request, home }) => {
  const studio = await launchStudio(home);
  try {
    const root = await writeSample(home);
    const appFiles = async () => Object.fromEntries(await Promise.all(
      (await fs.readdir(path.join(root, 'app'))).map(async (name) => [name, await fs.readFile(path.join(root, 'app', name), 'utf8')]),
    ));
    const appBefore = await appFiles();

    const requests = [];
    page.on('request', (req) => requests.push(req));

    await page.goto(studio.url);
    await chooseProject(page, /トークンの見本/);
    await openDevDetails(page);
    await page.getByRole('button', { name: 'ファイルから作り直す' }).click();
    await expect(page.locator('#build-status')).toContainText('ビルドに成功しました');

    const app = page.frameLocator('iframe[title="試作品"]');
    const action = app.getByTestId('action');
    const body = app.getByTestId('body');
    const own = app.getByTestId('own');
    await expect(action).toBeVisible();
    const beforeBackground = await action.evaluate((node) => getComputedStyle(node).backgroundColor);
    const beforeFont = await body.evaluate((node) => getComputedStyle(node).fontFamily);
    expect(beforeBackground).not.toBe(GREEN);
    expect(beforeFont).not.toContain('Minato Gothic');
    await expect(own).toHaveCSS('color', 'rgb(120, 120, 120)');

    // 形の誤りは、利用者の言葉で返し、つなげない
    const panel = await openMore(page);
    const fileInput = panel.getByLabel('トークンのファイル');
    await fileInput.setInputFiles({
      name: 'broken.tokens.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify({ color: { accent: { $value: '#ff0000' } }, size: { $type: 'dimension', gap: { $value: '16px' } } })),
    });
    const problems = panel.locator('#tokens-problems');
    await expect(problems).toContainText('「color.accent」: 種類がありません');
    await expect(problems).toContainText('「size.gap」: 大きさが 16px と書かれています');
    await expect(panel.getByRole('button', { name: 'つなぐ', exact: true })).toBeHidden();
    await expect(action).toHaveCSS('background-color', beforeBackground);
    await fileInput.setInputFiles({ name: 'not-json.json', mimeType: 'application/json', buffer: Buffer.from('{"a": 1,\n oops') });
    await expect(problems).toContainText('JSON として読めません(2 行目のあたり)');

    // 正しいファイルを選ぶと、役割の見立てが出る。誰の素材かを書くまで押せない
    await fileInput.setInputFiles(TOKENS_FILE);
    await expect(problems).toBeHidden();
    await expect(panel.locator('#tokens-summary')).toContainText('形を確かめました');
    await expect(panel.getByRole('combobox', { name: '押せる所' })).toHaveValue('color.accent');
    await expect(panel.getByRole('combobox', { name: '字の種類' })).toHaveValue('font.body');
    await expect(panel.locator('#tokens-missing')).toBeHidden();
    const connect = panel.getByRole('button', { name: 'つなぐ', exact: true });
    await expect(connect).toBeDisabled();
    // 選んだだけでは変わらない
    await expect(action).toHaveCSS('background-color', beforeBackground);
    // 足りない役割を聞く
    await panel.getByRole('combobox', { name: '失敗' }).selectOption('');
    await expect(panel.locator('#tokens-missing')).toContainText('足りない役割: 失敗');
    await panel.getByRole('combobox', { name: '失敗' }).selectOption('color.error');

    await panel.getByLabel('誰の素材か').fill('架空のデザイン担当');
    await panel.getByLabel('つなぐ理由').fill('架空の会社の色で見せるため');
    await expect(connect).toBeEnabled();
    await connect.click();
    await expect(panel.locator('#tokens-message')).toHaveText('つなぎました。試す欄の試作品に入れました。');
    await expect(panel.locator('#tokens-connected')).toContainText('つないでいます: tokens.json');
    await expect(panel.locator('#tokens-connected')).toContainText('誰の素材か: 架空のデザイン担当');
    await expect(panel.locator('#tokens-connected')).toContainText('つなぐ理由: 架空の会社の色で見せるため');
    await closeMore(page);

    // 見本の色と字が変わる。部品も、自分で書いた所も
    await expect(action).toHaveCSS('background-color', GREEN);
    await expect(action).toHaveCSS('color', 'rgb(255, 255, 255)');
    await expect(body).toHaveCSS('font-family', /Minato Gothic/);
    await expect(app.getByRole('heading', { name: 'くらし案内の見本(架空)' })).toHaveCSS('font-family', /Minato Gothic/);
    await expect(body).toHaveCSS('color', 'rgb(26, 26, 77)');
    await expect(app.getByTestId('danger')).toHaveCSS('background-color', 'rgb(179, 0, 0)');
    await expect(own).toHaveCSS('color', GREEN);
    await expect(own).toHaveCSS('font-family', /Minato Gothic/);
    await expect(own).toHaveCSS('padding-top', '24px');
    // 値のまま書いていない: 色は変数から来る
    const accentVar = await own.evaluate((node) => getComputedStyle(node).getPropertyValue('--token-color-accent').trim());
    expect(accentVar).toBe('rgb(0 128 64)');

    // 隔離の E2E と同じ確かめ方: CSP に止められたものがない。iframe が読むのは自分の版の 4 つのファイルだけ
    await expect(app.getByTestId('violations')).toHaveText('');
    const src = await page.locator('iframe[title="試作品"]').getAttribute('src');
    const base = new URL('./', new URL(src, studio.url)).href;
    const frame = page.frames().find((candidate) => candidate.url().startsWith(base));
    const loaded = requests.filter((req) => req.frame() === frame).map((req) => req.url()).filter((url) => !url.startsWith('data:') && !url.startsWith('blob:'));
    expect(new Set(loaded.map((url) => url.slice(base.length)))).toEqual(new Set(['', 'runtime.js', 'app.js', 'app.css']));
    const outside = requests.map((req) => new URL(req.url())).filter((url) => /^https?:$/.test(url.protocol) && !['127.0.0.1', 'localhost'].includes(url.hostname));
    expect(outside.map((url) => url.href)).toEqual([]);
    const csp = (await request.get(base)).headers()['content-security-policy'];
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("connect-src 'none'");

    // 素材は Studio の持つ場所に置く。作る AI が読み書きする app/ は変わらない
    expect(await appFiles()).toEqual(appBefore);
    expect(await fs.readFile(path.join(root, '.studio', 'materials', 'tokens.json'), 'utf8')).toBe(await fs.readFile(TOKENS_FILE, 'utf8'));

    // 引き継ぎに出典と理由が入る
    const handoff = JSON.parse((await studio.post('/api/projects/minato/handoff', { purpose: '架空の目的' })).text);
    const handoffJson = JSON.parse(await fs.readFile(path.join(handoff.handoff.dir, 'handoff.json'), 'utf8'));
    expect(handoffJson.materials.tokens.source).toBe('架空のデザイン担当');
    expect(handoffJson.materials.tokens.reason).toBe('架空の会社の色で見せるため');
    expect(handoffJson.materials.tokens.spec).toBe('W3C Design Tokens 2025.10');
    expect(handoffJson.materials.tokens.variables).toContain('--token-color-accent');
    // 指紋は伏せない。受け取った人が写しと照合できる
    expect(handoffJson.materials.tokens.sha256).toMatch(/^[a-f0-9]{64}$/);
    const handoffSource = JSON.parse(await fs.readFile(path.join(handoff.handoff.dir, 'materials', 'source.json'), 'utf8'));
    expect(handoffSource.history[0].sha256).toBe(handoffJson.materials.tokens.sha256);
    expect(await fs.readFile(path.join(handoff.handoff.dir, 'materials', 'tokens.css'), 'utf8')).toContain('--token-color-accent: rgb(0 128 64);');
    expect(await fs.readFile(path.join(handoff.handoff.dir, 'materials', 'tokens.json'), 'utf8')).toBe(await fs.readFile(TOKENS_FILE, 'utf8'));
    const readme = await fs.readFile(path.join(handoff.handoff.dir, 'README.md'), 'utf8');
    expect(readme).toContain('## 素材(自分のトークン)');
    expect(readme).toContain('出典: 架空のデザイン担当');

    // 外すと、前の見た目に戻る
    const panelAgain = await openMore(page);
    await panelAgain.locator('#tokens-connected').getByRole('button', { name: '外す' }).click();
    await expect(panelAgain.locator('#tokens-message')).toContainText('外しました。既定の素材の部品の見た目に戻しました。');
    // 見本は自分で書いた所でトークンの変数を読んでいる。残っていることを隠さない
    await expect(panelAgain.locator('#tokens-message')).toContainText('トークンの変数を読む所が 3 か所残っていて');
    await expect(panelAgain.locator('#tokens-connected')).toBeHidden();
    await closeMore(page);
    await expect(action).toHaveCSS('background-color', beforeBackground);
    await expect(own).toHaveCSS('color', 'rgb(120, 120, 120)');
  } finally {
    await studio.stop();
  }
});

test('小数を丸めた色は電話番号と取り違えずにつなぐ。色の空間がなければ直し方を返す', async ({ page, home }) => {
  const studio = await launchStudio(home);
  try {
    await writeSample(home);
    await page.goto(studio.url);
    await chooseProject(page, /トークンの見本/);
    const panel = await openMore(page);
    const fileInput = panel.getByLabel('トークンのファイル');
    const problems = panel.locator('#tokens-problems');
    const choose = (name, json) => fileInput.setInputFiles({ name, mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(json)) });
    const tokens = JSON.parse(await fs.readFile(TOKENS_FILE, 'utf8'));

    // 古い書き方の色は、何をどう書くかを利用者の言葉で返す
    await choose('no-space.tokens.json', { ...tokens, color: { ...tokens.color, accent: { $value: { hex: '#ff0000' } } } });
    await expect(problems).toContainText('「color.accent」: 色に colorSpace がありません');
    await expect(problems).not.toContainText('undefined');

    // 説明の文の電話番号は、これまでどおり断る(架空の番号)
    await choose('phone.tokens.json', { ...tokens, $description: '担当 090-0000-0000' });
    await expect(problems).toContainText('個人の情報らしい文字列(電話番号)');

    // #111111 を小数 10 桁に丸めた色。正しいファイルなので通り、試作品の色が変わる
    const rounded = { colorSpace: 'srgb', components: [0.0666666667, 0.0666666667, 0.0666666667] };
    await choose('rounded.tokens.json', { ...tokens, color: { ...tokens.color, accent: { $value: rounded } } });
    await expect(problems).toBeHidden();
    await expect(panel.locator('#tokens-summary')).toContainText('形を確かめました');
    await panel.getByLabel('誰の素材か').fill('架空のデザイン担当');
    await panel.getByRole('button', { name: 'つなぐ', exact: true }).click();
    await expect(panel.locator('#tokens-message')).toHaveText('つなぎました。試す欄の試作品に入れました。');
    await closeMore(page);
    await expect(page.frameLocator('iframe[title="試作品"]').getByTestId('action')).toHaveCSS('background-color', 'rgb(17, 17, 17)');
  } finally {
    await studio.stop();
  }
});

test('作る AI が素材を変えると関門で止まる。直せなければ前の版のまま、直せば通る', async ({ page, home }) => {
  // 直すラウンドと、起動の確認とシナリオの観察を回す
  test.setTimeout(120_000);
  const studio = await launchStudio(home);
  try {
    const root = await writeSample(home);
    await page.goto(studio.url);
    await chooseProject(page, /トークンの見本/);
    await connectTokens(page);
    await closeMore(page);
    const app = page.frameLocator('iframe[title="試作品"]');
    await expect(app.getByTestId('action')).toHaveCSS('background-color', GREEN);

    // 偽接続は、Studio の決まりの文から変数の名前を読み、app/ で上書きする。直さないので 2 回で止まる
    await chooseTestRequest(page, '素材の色を書き換えて、直せないふりをして');
    await page.getByRole('button', { name: '送る' }).click();
    const run = page.getByRole('list', { name: '作る会話' }).locator('> li.run').last();
    await expect(run.locator('.run-status')).toHaveText(FAILED_TEXT, { timeout: 30_000 });
    await expect(run.locator('[data-kind="build-failed"]')).toContainText('試作品を表示できません');

    // どの関門で、何が理由で止まったかが残る
    const { runs } = await studio.api('/api/projects/minato/build-requests');
    const failed = runs.at(-1);
    expect(failed.status).toBe('failed');
    const contract = failed.gates.find((gate) => gate.name === 'contract');
    expect(contract.id).toBe('G3');
    expect(contract.status).toBe('failed');
    expect(contract.errors[0].file).toBe('app/material-override.css');
    expect(contract.errors[0].text).toContain('--token-color-background を書き換えています');
    expect(failed.gates.find((gate) => gate.name === 'compile').status).toBe('skipped');
    const band = run.getByRole('group', { name: '確かめた結果' });
    await band.locator('details.evidence-more > summary').click();
    await expect(band.getByRole('list', { name: '確かめたこと' }).locator('> li[data-status="failed"]')).toContainText('つないだ素材の変数');

    // 試す欄は前の版のまま。素材は変わっていない
    await expect(app.getByTestId('action')).toHaveCSS('background-color', GREEN);
    await expect(app.getByTestId('body')).toHaveCSS('color', 'rgb(26, 26, 77)');
    expect(await fs.readFile(path.join(root, '.studio', 'materials', 'tokens.json'), 'utf8')).toBe(await fs.readFile(TOKENS_FILE, 'utf8'));

    // 上書きのファイルを消して、次は直すラウンドで消す道も通す
    await fs.rm(path.join(root, 'app', 'material-override.css'));
    await chooseTestRequest(page, '素材の色を書き換えて');
    await page.getByRole('button', { name: '送る' }).click();
    const second = page.getByRole('list', { name: '作る会話' }).locator('> li.run').last();
    await expect(second.locator('.run-status')).toHaveText(FIXED_TEXT, { timeout: 60_000 });
    await expect(app.getByTestId('action')).toHaveCSS('background-color', GREEN);
    await expect(fs.lstat(path.join(root, 'app', 'material-override.css'))).rejects.toThrow();
  } finally {
    await studio.stop();
  }
});

test('Studio の持つ素材のファイルが変わると、作り直しが止まり、理由が出る', async ({ page, home }) => {
  const studio = await launchStudio(home);
  try {
    const root = await writeSample(home);
    await page.goto(studio.url);
    await chooseProject(page, /トークンの見本/);
    await connectTokens(page);
    await closeMore(page);
    const app = page.frameLocator('iframe[title="試作品"]');
    await expect(app.getByTestId('action')).toHaveCSS('background-color', GREEN);

    const file = path.join(root, '.studio', 'materials', 'tokens.json');
    await fs.writeFile(file, (await fs.readFile(file, 'utf8')).replace('[0, 0.5, 0.25]', '[1, 0, 0]'));
    await openDevDetails(page);
    await page.getByRole('button', { name: 'ファイルから作り直す' }).click();
    await expect(page.locator('#build-status')).toContainText('つないだときから変わっています');
    await closeMore(page);
    await expect(app.getByTestId('action')).toHaveCSS('background-color', GREEN);

    // 作る AI には直せないので、依頼しても起動し直さない(1 回だけ起動して止まる)
    await chooseTestRequest(page, '見出しを「ひだまり図書室」にして');
    await page.getByRole('button', { name: '送る' }).click();
    const run = page.getByRole('list', { name: '作る会話' }).locator('> li.run').last();
    await expect(run.locator('[data-kind="gave-up"]')).toContainText('つないだ素材のファイルに問題があります', { timeout: 20_000 });
    const { runs } = await studio.api('/api/projects/minato/build-requests');
    expect(runs.at(-1).status).toBe('failed');
    expect(runs.at(-1).launches).toHaveLength(1);
  } finally {
    await studio.stop();
  }
});
