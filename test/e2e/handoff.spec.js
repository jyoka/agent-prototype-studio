import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ROOT, SAMPLES, chooseSample, expect, launchStudio, test, writeProject } from './studio.js';

// 本番開発への引き継ぎを、画面の操作で書き出し、別の場所で確かめる。
// 作る AI は偽接続、プロダクト内 AI はモックと偽の Claude Code で、実モデルは呼ばない。

const FAKE = path.join(ROOT, 'test', 'fixtures', 'fake-claude.js');
const AFTER_JOB = '職種「カフェのホール」と理解しました。';

function fakeEnv(home) {
  return {
    STUDIO_ALLOW_CLAUDE_CODE: '1',
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

async function allFiles(dir) {
  const files = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) files.push(path.join(entry.parentPath ?? entry.path, entry.name));
  }
  return files.sort();
}

const tempDir = (prefix) => fs.mkdtemp(path.join(os.tmpdir(), prefix));

test('画面から書き出した引き継ぎを、別の場所で読み、モック・実機・未接続を区別できる。ソースは別の Studio で動く', async ({ page, home }) => {
  // Studio を 2 回起動するので、ほかのテストより長く待つ
  test.setTimeout(90_000);
  // 渡した先の場所と、渡した先の Studio のデータの置き場
  const other = await tempDir('prototype-studio-handed-over-');
  const otherHome = await tempDir('prototype-studio-e2e-other-');
  try {
    await exportAndCheck(page, home, other, otherHome);
  } finally {
    await fs.rm(other, { recursive: true, force: true });
    await fs.rm(otherHome, { recursive: true, force: true });
  }
});

async function exportAndCheck(page, home, other, otherHome) {
  let handedOver;
  const studio = await launchStudio(home, { env: fakeEnv(home) });
  try {
    await page.goto(studio.url);
    await chooseSample(page, SAMPLES.jobConsult);
    const app = page.frameLocator('iframe[title="試作品"]');
    const log = app.getByRole('region', { name: '会話' }).getByRole('listitem');
    const message = app.getByLabel('メッセージ');
    const say = async (text) => {
      await message.fill(text);
      await app.getByRole('button', { name: '送る' }).click();
      await expect(message).toHaveValue('');
    };

    // 作る欄で変える(変更の経緯に残る)
    await page.getByLabel('依頼').fill('見出しを「うみかぜ求人相談」にして');
    await page.getByRole('button', { name: '送る' }).click();
    await expect(app.getByRole('heading', { name: 'うみかぜ求人相談' })).toBeVisible();

    // モックで話し、本人が直し、Claude Code(偽)でも話す
    await say('カフェで働きたいです');
    await expect(log.last()).toContainText(AFTER_JOB);
    await app.getByLabel('勤務地を直す').selectOption('もみじ台');
    await expect(log.last()).toHaveText('あなたの修正: 勤務地を「もみじ台」に直しました。');
    await page.getByRole('radio', { name: 'Claude Code' }).check();
    const confirm = page.getByRole('group', { name: 'Claude Code に切り替える前の確認' });
    await confirm.getByRole('checkbox').check();
    await confirm.getByRole('button', { name: 'Claude Code に切り替える' }).click();
    await expect(page.locator('#ai-badge')).toHaveText('AI: Claude Code');
    await say('雇用は正社員がいいです');
    await expect(log.last()).toContainText('偽の Claude Code です');

    await page.getByLabel('版の名前(なくてもよい)').fill('引き継ぐ版');
    await page.getByRole('button', { name: '今の作業中を保存' }).click();
    await expect(page.locator('#work-badge')).toHaveText('作業中 = 保存版 v1');

    // 意図と未決事項を書いて、書き出す
    const handoff = page.getByRole('region', { name: '本番開発への引き継ぎ' });
    await handoff.getByLabel('目的(この試作品で確かめたいこと)').fill('求職者が、AI の理解した条件を直しながら相談を続けられるか確かめる');
    await handoff.getByLabel('決まったこと').fill('条件は 職種、雇用区分、勤務地、時給の下限 の 4 つ');
    await handoff.getByLabel('未決事項').fill('求人の検索を本物の API にするか。問い合わせ先 hanako@example.com');
    await handoff.getByRole('button', { name: '引き継ぎ用に書き出す' }).click();
    const result = page.locator('#handoff-result');
    await expect(result).toContainText('書き出しました。実機 2 件、モック 3 件、未接続 9 件、未決事項 1 件。');
    const dir = await result.locator('code').textContent();
    expect(path.dirname(dir)).toBe(path.join(home, 'handoffs'));
    await page.screenshot({ path: test.info().outputPath('1-exported.png'), fullPage: true });

    // 開き直すと、書いたメモと、前に書き出した場所が出る
    await page.reload();
    await chooseSample(page, SAMPLES.jobConsult);
    await expect(handoff.getByLabel('決まったこと')).toHaveValue('条件は 職種、雇用区分、勤務地、時給の下限 の 4 つ');
    await expect(result).toContainText(`前に書き出したもの`);
    await expect(result).toContainText(dir);

    // 開発の担当者に渡す: フォルダーを別の場所に写し、元は消す
    await fs.cp(dir, other, { recursive: true });
    await fs.rm(path.join(home, 'handoffs'), { recursive: true, force: true });

    // 秘密と PC の情報は、どのファイルにも入っていない
    for (const file of await allFiles(other)) {
      const text = await fs.readFile(file, 'utf8');
      const name = path.relative(other, file);
      expect(text, `${name} に起動の鍵`).not.toContain(studio.token);
      expect(text, `${name} に PC の場所`).not.toContain(home);
      expect(text, `${name} にメールアドレス`).not.toContain('hanako@example.com');
    }
    handedOver = await fs.readFile(path.join(other, 'README.md'), 'utf8');
  } finally {
    await studio.stop();
  }

  {
    // 別の場所で、資料だけを読んで区別できる
    const files = (await allFiles(other)).map((file) => path.relative(other, file).split(path.sep).join('/'));
    expect(files).toEqual([
      'README.md',
      'ai/response-schema.json',
      'ai/system-prompt.md',
      'app/App.jsx',
      'app/ai.json',
      'app/jobs.js',
      'app/main.jsx',
      'app/prototype.json',
      'app/scenarios/talk-and-narrow.json',
      'app/style.css',
      'handoff.json',
    ]);
    const readme = handedOver;
    await fs.writeFile(test.info().outputPath('handed-over-README.md'), readme);
    expect(readme).toContain('# 引き継ぎ: 求人相談(架空・AI と話せる)');
    expect(readme).toContain('> 求職者が、AI の理解した条件を直しながら相談を続けられるか確かめる');
    expect(readme).toContain('> 求人の検索を本物の API にするか。問い合わせ先 [伏せた: メールアドレス]');
    expect(readme).toMatch(/\| 実機 \| 画面と操作 \|/);
    expect(readme).toMatch(/\| 実機 \| プロダクト内 AI\(実モデル\) \| Claude Code で 1 回応答した。/);
    expect(readme).toMatch(/\| モック \| プロダクト内 AI\(モック\) \| .*モックの応答: 1 回。/);
    expect(readme).toMatch(/\| モック \| データ \| .*app\/jobs\.js/);
    expect(readme).toMatch(/\| 未接続 \| 外部の API と通信 \|/);
    expect(readme).toMatch(/\| 未接続 \| プロダクト内 AI の本番の接続 \|/);
    // 会話の各応答が、どの接続のものか
    expect(readme).toMatch(/\| 3 \| AI \| モック \| 職種「カフェのホール」と理解しました。/);
    expect(readme).toMatch(/\| 4 \| 利用者の修正 \|  \| 勤務地を「もみじ台」に直しました。 \|/);
    expect(readme).toMatch(/\| 6 \| AI \| Claude Code\(実モデル\) \| 偽の Claude Code です/);
    expect(readme).toContain('| `employmentType` | 雇用区分 | 正社員 |');
    expect(readme).toContain('- 版: 保存版 v1「引き継ぐ版」と同じ');
    expect(readme).toMatch(/\| 見出しを「うみかぜ求人相談」にして \| 通った \| app\/App\.jsx \|/);

    const manifest = JSON.parse(await fs.readFile(path.join(other, 'handoff.json'), 'utf8'));
    expect(manifest.format).toBe('prototype-studio-handoff');
    expect(manifest.formatVersion).toBe(2);
    // 目録の未実装 3 つと制約が、未接続の行に足される
    expect(manifest.capabilities.map((c) => c.kind)).toEqual(['real', 'real', 'mock', 'mock', 'mock', ...Array(9).fill('missing')]);
    expect(manifest.prototype.file).toBe('app/prototype.json');
    expect(manifest.source.dataFrom).toBe('manifest');
    expect(manifest.scenarios.files.map((s) => s.file)).toEqual(['app/scenarios/talk-and-narrow.json']);
    // 最新の作る run(見出しの変更)は、本物の観察器で全関門が通り、今の app/ と同じ中身で確かめた
    expect(manifest.evidence.run.status).toBe('passed');
    expect(manifest.evidence.run.gates.map((g) => g.status)).toEqual(Array(6).fill('passed'));
    expect(manifest.evidence.run.stale).toBe(false);
    expect(manifest.evidence.run.reports.map((r) => [r.gate, r.verdict])).toEqual([['G5', 'passed'], ['G6', 'passed']]);
    expect(manifest.conversation.messages.filter((m) => m.role === 'assistant').map((m) => [m.via, m.real])).toEqual([
      [null, false],
      ['mock', false],
      ['claude-code', true],
    ]);
    expect(await fs.readFile(path.join(other, 'ai', 'system-prompt.md'), 'utf8')).toContain('しおかぜ求人相談');

    // ソースは、別の PC の Studio に置けば、そのまま動く(README の「試作品を動かす」の手順)
    await fs.cp(path.join(other, 'app'), path.join(otherHome, 'projects', 'handed-over', 'app'), { recursive: true });
    const elsewhere = await launchStudio(otherHome);
    try {
      await page.goto(elsewhere.url);
      // 名前は目録の title から作るので、サンプルと同じ名前になる。ID で選ぶ
      await page.locator('[data-project-id="handed-over"]').click();
      const app = page.frameLocator('iframe[title="試作品"]');
      await expect(app.getByRole('heading', { name: 'うみかぜ求人相談' })).toBeVisible();
      await expect(page.locator('#ai-badge')).toHaveText('AI: モック');
      const message = app.getByLabel('メッセージ');
      await message.fill('カフェで働きたいです');
      await app.getByRole('button', { name: '送る' }).click();
      await expect(app.getByRole('region', { name: '会話' }).getByRole('listitem').last()).toContainText(AFTER_JOB);
      await page.screenshot({ path: test.info().outputPath('2-running-elsewhere.png'), fullPage: true });
    } finally {
      await elsewhere.stop();
    }
  }
}

test('秘密情報らしい文字列があると書き出さず、場所を画面に出す', async ({ page, home }) => {
  await writeProject(
    home,
    'with-secret',
    {
      'main.jsx': "import { KEY } from './config.js';\ndocument.getElementById('root').textContent = KEY ? '鍵あり' : '鍵なし';\n",
      'config.js': "export const KEY = 'sk-ant-api03-abcdefghijklmnopqrstuvwx';\n",
    },
    '鍵を書いた試作品',
  );
  const studio = await launchStudio(home);
  try {
    await page.goto(studio.url);
    await page.getByRole('button', { name: /鍵を書いた試作品/ }).click();
    await expect(page.frameLocator('iframe[title="試作品"]').locator('#root')).toHaveText('鍵あり');
    const handoff = page.getByRole('region', { name: '本番開発への引き継ぎ' });
    await handoff.getByRole('button', { name: '引き継ぎ用に書き出す' }).click();
    const result = page.locator('#handoff-result');
    await expect(result).toContainText('書き出せませんでした: 秘密情報らしい文字列があるので、書き出しませんでした。消してから書き出してください(app/config.js:1 API キーらしい文字列)');
    await expect(result).not.toContainText('sk-ant-');
    expect(await fs.readdir(path.join(home, 'handoffs')).catch(() => [])).toEqual([]);
  } finally {
    await studio.stop();
  }
});
