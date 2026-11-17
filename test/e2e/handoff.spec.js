import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ROOT, SAMPLES, chooseProject, chooseSample, expect, launchStudio, openHandoff, openVersions, switchToRealAi, test, writeProject } from './studio.js';

// 本番開発への引き継ぎを、画面の操作で書き出し、別の場所で確かめる。
// 作る AI は偽接続、プロダクト内 AI はモックと偽の Claude Code で、実モデルは呼ばない。
// 保存した状態は試作品の名前のメニューに、本番開発へ渡す欄は段 9「渡す」の作業台にある

const FAKE = path.join(ROOT, 'test', 'fixtures', 'fake-claude.js');
const AFTER_JOB = '職種「カフェのホール」と理解しました。';

function fakeEnv(home) {
  return {
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
    await switchToRealAi(page);
    await say('雇用は正社員がいいです');
    await expect(log.last()).toContainText('偽の Claude Code です');

    await openVersions(page);
    await page.getByLabel('名前(なくてもよい)').fill('引き継ぐ版');
    await page.locator('#save-version').click();
    await expect(page.locator('#working-status')).toHaveText('今の状態は保存 1「引き継ぐ版」と同じです。');

    // 意図と未決事項を書いて、書き出す(段 9「渡す」の作業台。書き出すボタンは次の一手の帯にある)
    const handoff = await openHandoff(page);
    await handoff.getByLabel('目的(この試作品で確かめたいこと)').fill('求職者が、AI の理解した条件を直しながら相談を続けられるか確かめる');
    await handoff.getByLabel('決まったこと').fill('条件は 職種、雇用区分、勤務地、時給の下限 の 4 つ');
    await handoff.getByLabel('未決事項').fill('求人の検索を本物の API にするか。問い合わせ先 hanako@example.com');
    await page.getByRole('region', { name: '次の一手' }).getByRole('button', { name: '渡すフォルダーを作る' }).click();
    const result = page.locator('#handoff-result');
    // 未決事項は、書いた 1 件と、形式 4 で Studio が足す 4 件(目的の文書がない、設計の決定がない、質の見直しの「直す」、人に見せた答えがない)
    await expect(result).toContainText('渡すフォルダーを作りました。本物につないだもの 2 件、お試しのもの 3 件、つないでいないもの 9 件、未決事項 5 件。');
    const dir = await result.locator('code').textContent();
    expect(path.dirname(dir)).toBe(path.join(home, 'handoffs'));
    await page.screenshot({ path: test.info().outputPath('1-exported.png'), fullPage: true });

    // 開き直すと、書いたメモと、前に書き出した場所が出る
    await page.reload();
    await chooseSample(page, SAMPLES.jobConsult);
    await openHandoff(page);
    await expect(handoff.getByLabel('決まったこと')).toHaveValue('条件は 職種、雇用区分、勤務地、時給の下限 の 4 つ');
    await expect(result).toContainText('前に作ったフォルダー');
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
    // 別の場所で、資料だけを読んで区別できる。既定の素材の出典とライセンスの文は materials/default/ に入る(形式 4)
    const all = (await allFiles(other)).map((file) => path.relative(other, file).split(path.sep).join('/'));
    expect(all).toContain('materials/default/source.json');
    expect(all).toContain('materials/default/licenses/radix-ui-themes.txt');
    const files = all.filter((file) => !file.startsWith('materials/default/'));
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
    expect(manifest.formatVersion).toBe(4);
    // 目的の文書、設計、審査、見せた答えのない試作品では、ないことを書く(形式 4)
    expect(manifest.purpose.status).toBe('none');
    expect(manifest.review.status).toBe('none');
    expect(readme).toContain('目的の文書はありません');
    expect(readme).toContain('設計の段ごとの決定はありません');
    expect(readme).toContain('- 状態: 審査なし(この試作品は審査を受けていない)');
    expect(readme).toContain('試作品を人に見せた答えはありません。');
    expect(readme).toMatch(/## 素材の出典とライセンス\n[\s\S]*- 試作品が import しているもの: .*react \d/);
    expect(readme).toMatch(/## 確かめていないこと\n/);
    // 目録の未実装 3 つと制約が、未接続の行に足される
    expect(manifest.capabilities.map((c) => c.kind)).toEqual(['real', 'real', 'mock', 'mock', 'mock', ...Array(9).fill('missing')]);
    expect(manifest.prototype.file).toBe('app/prototype.json');
    expect(manifest.source.dataFrom).toBe('manifest');
    expect(manifest.scenarios.files.map((s) => s.file)).toEqual(['app/scenarios/talk-and-narrow.json']);
    // 最新の作る run(見出しの変更)は、本物の観察器で全関門が通り、今の app/ と同じ中身で確かめた
    expect(manifest.evidence.run.status).toBe('passed');
    expect(manifest.evidence.run.gates.map((g) => g.status)).toEqual(Array(7).fill('passed'));
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
      await page.locator('#project-menu-button').click();
      await page.locator('[data-project-id="handed-over"]').click();
      const app = page.frameLocator('iframe[title="試作品"]');
      await expect(app.getByRole('heading', { name: 'うみかぜ求人相談' })).toBeVisible();
      await expect(page.locator('#ai-badge')).toHaveText('AI: お試し');
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
    await chooseProject(page, /鍵を書いた試作品/);
    await expect(page.frameLocator('iframe[title="試作品"]').locator('#root')).toHaveText('鍵あり');
    const handoff = await openHandoff(page);
    await page.getByRole('region', { name: '次の一手' }).getByRole('button', { name: '渡すフォルダーを作る' }).click();
    const result = page.locator('#handoff-result');
    await expect(result).toContainText('渡すフォルダーを作れませんでした: 秘密情報らしい文字列があるので、書き出しませんでした。消してから書き出してください(app/config.js:1 API キーらしい文字列)');
    await expect(result).not.toContainText('sk-ant-');
    expect(await fs.readdir(path.join(home, 'handoffs')).catch(() => [])).toEqual([]);
  } finally {
    await studio.stop();
  }
});

// 形式 4(J8)。目的の文書、設計の段ごとの決定と理由、質の見直し、AI 構成書と承認の記録、人に見せた答えのある試作品を、
// 画面から書き出し、別の場所で README だけを読んで分かる。前の段(目的、設計、審査、見せる)は、それぞれの E2E が画面で確かめているので、
// ここでは画面と同じ API で済ませる。作る AI と試作品の中の AI は偽接続とお試しの AI で、実モデルは呼ばない
const LIBRARY = '架空の町の図書館で、本の取り置きの問い合わせに AI が答えられるようにしたい';
const DESIGN_STEPS = ['problem', 'users', 'scenes', 'data', 'composition', 'screens'];

async function decidedLibrary(studio) {
  const created = await studio.post('/api/projects', { sentence: LIBRARY, guide: 'fixed' });
  const { id } = JSON.parse(created.text).project;
  expect((await studio.post(`/api/projects/${id}/intent/start`, { sentence: LIBRARY, guide: 'fixed', depth: 'quick' })).status).toBe(200);
  const doc = { who: '図書館の利用者(架空)', problem: '取り置きの問い合わせに何度も答えている', scene: '開館前の問い合わせ', success: '電話が減る', notDoing: ['貸し出しの手続き'], undecided: ['休館日の扱い'] };
  expect((await studio.post(`/api/projects/${id}/intent/decide`, { doc })).status).toBe(200);
  expect((await studio.post(`/api/projects/${id}/design/start`, { guide: 'ai' })).status).toBe(200);
  for (const step of DESIGN_STEPS) {
    const { design } = await studio.api(`/api/projects/${id}/design`);
    const options = design.steps.find((item) => item.id === step).options;
    const option = step === 'composition' ? 'fixed-flow' : (options.find((item) => item.recommended) ?? options[0]).id;
    const note = step === 'problem' ? { note: '館長(架空)と話して、取り置きに絞った' } : {};
    const chosen = await studio.post(`/api/projects/${id}/design/choose`, { step, option, ...note });
    expect(chosen.status, chosen.text).toBe(200);
  }
  expect((await studio.post(`/api/projects/${id}/design/decide`)).status).toBe(200);
  // お試しの AI で場面を回してから、4 つを承認する(数は「形の確かめだけ」)
  const measured = await studio.post(`/api/projects/${id}/review/measure`);
  expect(measured.status, measured.text).toBe(200);
  for (const item of ['composition', 'harness', 'data', 'stack']) {
    expect((await studio.post(`/api/projects/${id}/review/approve`, { item, pressedBy: '早瀬(架空)' })).status).toBe(200);
  }
  const built = await studio.post(`/api/projects/${id}/review/build`);
  expect(built.status, built.text).toBe(200);
  // 人に見せて、答えを残す
  const { show } = JSON.parse((await studio.post(`/api/projects/${id}/show/start`)).text);
  const answers = [
    { question: show.questions[0], answer: '開館前の電話は減りそう' },
    { question: show.questions.at(-1), answer: '取り置きの期限が分かりにくい' },
  ];
  expect((await studio.post(`/api/projects/${id}/show/answer`, { versionId: show.version.id, viewer: '同僚', answers })).status).toBe(200);
  return id;
}

test('目的の文書、設計の決定と理由、質の見直し、AI 構成書と承認、人に見せた答えを、書き出した先の README だけで読める', async ({ page, home }) => {
  test.setTimeout(90_000);
  const other = await tempDir('prototype-studio-handed-over-j8-');
  try {
    let dir;
    const studio = await launchStudio(home);
    try {
      const id = await decidedLibrary(studio);
      await page.goto(studio.url);
      await page.locator('#project-menu-button').click();
      await page.locator(`[data-project-id="${id}"]`).click();
      const handoff = await openHandoff(page);
      await handoff.getByLabel('目的(この試作品で確かめたいこと)').fill('取り置きの問い合わせを AI で減らせるか確かめる');
      await page.getByRole('region', { name: '次の一手' }).getByRole('button', { name: '渡すフォルダーを作る' }).click();
      const result = page.locator('#handoff-result');
      await expect(result).toContainText('渡すフォルダーを作りました。');
      dir = await result.locator('code').textContent();
    } finally {
      await studio.stop();
    }
    // 開発の担当者に渡す: フォルダーを別の場所に写し、元は消す
    await fs.cp(dir, other, { recursive: true });
    await fs.rm(path.join(home, 'handoffs'), { recursive: true, force: true });

    const readme = await fs.readFile(path.join(other, 'README.md'), 'utf8');
    await fs.writeFile(test.info().outputPath('handed-over-README.md'), readme);
    // 1. 目的の文書(決めた印と中身)
    expect(readme).toMatch(/## 目的の文書\n[\s\S]*- 状態: 決めた/);
    expect(readme).toContain('| 誰 | 図書館の利用者(架空) |');
    expect(readme).toContain('| 決めていないこと | 休館日の扱い |');
    // 2. 設計の段ごとの決定と理由。人のメモと、選ばなかった形の理由
    expect(readme).toMatch(/## 設計の段ごとの決定と理由\n[\s\S]*- 状態: 決めた/);
    expect(readme).toMatch(/\| 問題 \| .+ \| .+ \| 館長\(架空\)と話して、取り置きに絞った \| .+ \|/);
    expect(readme).toMatch(/\| エージェントの構成 \| 固定の流れ/);
    expect(readme).toMatch(/構成の段で選ばなかった形と理由:\n\n- 単一エージェント: /);
    // 3. AI 構成書と承認の記録。今の構成は承認したまま
    expect(readme).toMatch(/## AI 構成の審査\(AI 構成書\)\n\n- 状態: 承認済み\n- 今の構成と AI 構成書: 同じ/);
    expect(readme).toContain('- 数: お試しの AI で回した(形の確かめだけ)');
    expect(readme).toMatch(/\| エージェントの構成 \| 承認済み \| 早瀬\(架空\)\(本人\) \|/);
    // 4. 質の見直し(場面はお試しの AI で回した結果)
    expect(readme).toMatch(/## 質の見直し\n[\s\S]*- 場面の回し: .+、お試しの AI/);
    expect(readme).toMatch(/\| 測ったもの \| 場面の結果 \| (問題なし|直す) \| \d+ \/ \d+ 通った/);
    expect(readme).toMatch(/\| AI の判断 \| 使いやすさの見直し \| まだ見ていない \|/);
    // 5. 人に見せた答え
    expect(readme).toMatch(/## 人に見せた答え\n[\s\S]*相手: 同僚[\s\S]*\| 取り置きの期限が分かりにくい \|/);
    // 6. 素材の出典とライセンス
    expect(readme).toMatch(/## 素材の出典とライセンス\n[\s\S]*- ライセンス: MIT \d+ 個/);
    expect(await fs.readFile(path.join(other, 'materials', 'default', 'licenses', 'radix-ui-themes.txt'), 'utf8')).toMatch(/MIT/);
    // 確かめていないこと(費用と待ち時間はお試しの AI では測れない)
    expect(readme).toMatch(/## 確かめていないこと\n[\s\S]*- 費用: まだ見ていない/);

    const manifest = JSON.parse(await fs.readFile(path.join(other, 'handoff.json'), 'utf8'));
    expect(manifest.formatVersion).toBe(4);
    expect(manifest.review.record.approvals.composition.by[0].digest).toBe(manifest.review.record.fingerprint.items.composition.digest);
    expect(manifest.review.record.evidence.status).toBe('mock');
  } finally {
    await fs.rm(other, { recursive: true, force: true });
  }
});
