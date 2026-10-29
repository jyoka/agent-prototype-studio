import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ROOT, SAMPLES, chooseSample, closeMore, expect, launchStudio, openDevDetails, openMore, switchToRealAi, test } from './studio.js';

// 求人でも LINE でもない題材(架空の学習相談)で、求人相談と同じ流れが通るかを確かめる(#281)。
// 作成(サンプルを開く) → 試行(モックと偽の Claude Code) → 変更(画面と AI の振る舞い、試し直し) → 版 → 引き継ぎ。
// 作る AI は偽接続、プロダクト内 AI はモックと偽の CLI(test/fixtures/fake-claude.js)。実モデルも外部の API も呼ばない。
// Studio の側に求人の言葉が出ないことも確かめる。題材の言葉は samples/study-consult/app/ にだけある。

const FAKE = path.join(ROOT, 'test', 'fixtures', 'fake-claude.js');
const JOB_WORDS = /求人|求職|職種|雇用区分|勤務地|時給|案内役/;

const GREETING = 'こんにちは。あおぞら学習相談の相談役です(架空のサービスです)。';
const AFTER_SUBJECT = '学びたいこと「英会話」ですね。いまはどのくらい経験がありますか?';
const AFTER_SUBJECT_MINUTES_FIRST = '学びたいこと「英会話」ですね。1日に何分くらい使えますか?';
const COMPLETE =
  '直していただいたいまの段階「はじめて」に合わせます。学び方「動画で学ぶ」、1日に使える時間「30分」ですね。' +
  '学びたいこと「英会話」、いまの段階「はじめて」、学び方「動画で学ぶ」、1日に使える時間「30分」で、1 週間の進め方を作りました。';
const ASK_BY_EXAMPLE = 'すみません、うまく読み取れませんでした。たとえば「英会話」「はじめて」「動画で学ぶ」のように、短く教えてください。';

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

function parts(page) {
  const app = page.frameLocator('iframe[title="試作品"]');
  const message = app.getByLabel('メッセージ');
  const plan = app.getByRole('region', { name: '学習プラン' });
  return {
    app,
    plan,
    values: plan.locator('.value'),
    week: plan.getByLabel('1 週間の進め方'),
    courses: app.getByRole('region', { name: '合う講座' }).getByRole('listitem'),
    log: app.getByRole('region', { name: '会話' }).getByRole('listitem'),
    runs: page.getByRole('list', { name: '作る会話' }).locator('> li.run'),
    retryBar: page.getByRole('region', { name: '試し直す' }),
    comparison: page.getByRole('region', { name: '試し直す' }).getByRole('region', { name: '直す前と後の返事' }).getByRole('listitem'),
    async say(text) {
      await message.fill(text);
      await app.getByRole('button', { name: '送る' }).click();
      await expect(message).toHaveValue('');
    },
    async request(text) {
      // 「その他」の引き出しは直す欄に重なるので、閉じてから頼む
      await closeMore(page);
      await page.getByLabel('依頼').fill(text);
      await page.getByRole('button', { name: '送る' }).click();
      const run = this.runs.last();
      await expect(run.locator('.run-status')).toContainText('終わりました');
      return run;
    },
  };
}

// Studio の画面(試作品の一覧を除く)に、求人の題材の言葉が出ていない。「その他」の引き出しは、閉じていても中身を確かめる
async function expectNoJobWords(page) {
  for (const area of ['section.make', '.preview .toolbar', '#retry-bar', '#more-panel']) {
    expect(await page.locator(area).innerText(), `${area} に求人の言葉`).not.toMatch(JOB_WORDS);
  }
}

test('求人ではない題材(架空の学習相談)でも、作成・試行・変更・版・引き継ぎが同じ画面と手順で通る', async ({ page, home }) => {
  // Studio を 2 回起動するので、ほかのテストより長く待つ
  test.setTimeout(120_000);
  const other = await fs.mkdtemp(path.join(os.tmpdir(), 'prototype-studio-study-handed-over-'));
  const otherHome = await fs.mkdtemp(path.join(os.tmpdir(), 'prototype-studio-e2e-study-other-'));
  try {
    await runFlow(page, home, other, otherHome);
  } finally {
    await fs.rm(other, { recursive: true, force: true });
    await fs.rm(otherHome, { recursive: true, force: true });
  }
});

async function runFlow(page, home, other, otherHome) {
  const studio = await launchStudio(home, { env: fakeEnv(home) });
  let exported;
  try {
    // 1. 作成: サンプルは、ほかのサンプルと同じく起動のときに置き場に写され、一覧から開ける
    expect(studio.output()).toContain('ビルド成功: sample-study-consult');
    await page.goto(studio.url);
    await chooseSample(page, SAMPLES.studyConsult);
    const ui = parts(page);
    await expect(ui.app.getByRole('heading', { name: 'あおぞら学習相談' })).toBeVisible();
    await expect(ui.log.first()).toContainText(GREETING);
    await expect(page.locator('#ai-badge')).toHaveText('AI: お試し');
    await expect(page.locator('dl.ai-state dt')).toHaveText(['学びたいこと', 'いまの段階', '学び方', '1日に使える時間']);
    // 直す欄の例も、試験用の依頼も、この試作品の項目から作る(求人の項目の名前は出ない)
    await expect(page.locator('#example-list')).toContainText('1日に使える時間を先に聞くようにして');
    await expect(page.locator('#test-request-list')).toContainText('「1日に使える時間」を先に聞くようにして');
    await expectNoJobWords(page);

    // 2. 試行: モックの AI と話し、本人が直し、その修正を踏まえて続ける
    await ui.say('英会話を始めたいです');
    await expect(ui.log.last()).toContainText(AFTER_SUBJECT);
    await ui.app.getByLabel('いまの段階を直す').selectOption('はじめて');
    await expect(ui.log.last()).toHaveText('あなたの修正: いまの段階を「はじめて」に直しました。');
    // 数の項目は、keywords なしで単位(分)だけで読み取る。「1日」の 1 は単位が続かないので読まない
    await ui.say('動画がいいです。1日30分くらい使えます');
    await expect(ui.log.last()).toContainText(COMPLETE);
    await expect(ui.values).toHaveText(['英会話', 'はじめて', '動画で学ぶ', '30分']);
    await expect(ui.courses).toHaveText([/そらいろ英会話 はじめの一歩/]);
    await expect(ui.week).toHaveText('1 週間で 210 分。「そらいろ英会話 はじめの一歩」を 1 日 2 回、週 14 回。');
    // 実行の記録も、題材の項目の名前で出る(その他 → 開発者向けの詳細)
    await openDevDetails(page);
    const entries = page.getByRole('list', { name: 'AI の実行の記録' }).getByRole('listitem');
    await expect(entries.first().getByRole('list', { name: '状態の変化' }).getByRole('listitem')).toHaveText(['学び方: 未定 → 動画で学ぶ', '1日に使える時間: 未定 → 30分']);
    await page.screenshot({ path: test.info().outputPath('1-tried-with-mock.png'), fullPage: true });

    // 3. 版: 良いところで保存する
    await page.getByLabel('名前(なくてもよい)').fill('学習相談の最初の版');
    await page.locator('#save-version').click();
    await expect(page.locator('#working-status')).toHaveText('今の状態は保存 1「学習相談の最初の版」と同じです。');

    // 4. 変更(画面): 作る欄で見出しを変え、試す画面に反映する
    let run = await ui.request('見出しを「そよかぜ学習相談」にして');
    await expect(run.locator('.run-dev')).toContainText('変わったファイル: app/App.jsx');
    await expect(ui.app.getByRole('heading', { name: 'そよかぜ学習相談' })).toBeVisible();

    // 5. 変更(AI の振る舞い): 直す欄の例を押して聞く順を変え、前の発言で試し直して比べる。引き出しは直す欄に重なるので閉じる
    await closeMore(page);
    await page.getByRole('list', { name: '直し方の例' }).getByRole('button', { name: '1日に使える時間を先に聞くようにして' }).click();
    await page.getByRole('button', { name: '送る' }).click();
    run = ui.runs.last();
    await expect(run.locator('.run-status')).toContainText('終わりました');
    await expect(run.locator('[data-kind="ai-settings"]')).toContainText(
      '聞く順と項目の並び: 学びたいこと、いまの段階、学び方、1日に使える時間 → 1日に使える時間、学びたいこと、いまの段階、学び方',
    );
    await expect(ui.log).toHaveCount(1);
    await expect(ui.plan.locator('dt')).toHaveText(['1日に使える時間', '学びたいこと', 'いまの段階', '学び方']);
    await expect(ui.retryBar).toContainText('前の会話(発言 2 件、修正 1 件)を、新しい設定で送り直せます。');
    await ui.retryBar.getByRole('button', { name: '同じ発言で試し直す' }).click();
    await expect(ui.log).toHaveCount(6);
    await expect(ui.log.nth(2)).toContainText(AFTER_SUBJECT_MINUTES_FIRST);
    await expect(ui.log.nth(3)).toHaveText('あなたの修正: いまの段階を「はじめて」に直しました。');
    await expect(ui.comparison.nth(0)).toContainText(`前: ${AFTER_SUBJECT}`);
    await expect(ui.comparison.nth(0)).toContainText(`後: ${AFTER_SUBJECT_MINUTES_FIRST}`);
    await expect(ui.comparison.nth(0)).toContainText('変わりました');
    await expect(ui.values).toHaveText(['30分', '英会話', 'はじめて', '動画で学ぶ']);

    // 読み取れなかったときの返事の例は、この題材の選択肢から作る
    await ui.request('読み取れなかったときは例を出して聞き返すようにして');
    // 新しい設定で、会話が最初から始まるのを待つ
    await expect(ui.log).toHaveCount(1);
    await ui.say('よろしくお願いします');
    await expect(ui.log.last()).toContainText(`${ASK_BY_EXAMPLE}1日に何分くらい使えますか?`);
    await expectNoJobWords(page);
    await page.screenshot({ path: test.info().outputPath('2-changed-and-retried.png'), fullPage: true });

    // 6. 試行(実モデルの経路): 偽の Claude Code に切り替える。応答の形と指示は、この題材の ai.json から作る
    await switchToRealAi(page);
    await ui.say('プログラミングを本で学ぶ形がいいです');
    await expect(ui.log.last()).toContainText('偽の Claude Code です');
    await expect(ui.values).toHaveText(['未定', 'プログラミング', '未定', '本で学ぶ']);
    const calls = (await fs.readFile(path.join(home, 'fake-claude.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    // 1 ターンは抽出と言い方の 2 回の呼び出し
    expect(calls).toHaveLength(2);
    const argv = calls[0].argv.join('\n');
    expect(argv).toContain('あおぞら学習相談');
    expect(argv).toContain('- minutes(1日に使える時間): 数、単位は分、5 以上、300 以下');
    for (const call of calls) {
      expect(call.argv.join('\n')).not.toMatch(JOB_WORDS);
      expect(call.stdin).not.toMatch(JOB_WORDS);
    }
    expect(calls[1].argv.join('\n')).toContain('あおぞら学習相談');

    // 7. 引き継ぎ: 書き出し、題材の項目と架空のデータの場所が出る。求人の言葉は入らない
    await openMore(page);
    const handoff = page.getByRole('region', { name: '本番開発へ渡す' });
    await handoff.getByLabel('目的(この試作品で確かめたいこと)').fill('学ぶ人が、AI の理解した学習プランを直しながら相談を続けられるか確かめる');
    await handoff.getByLabel('未決事項').fill('講座の一覧を本物のデータにするか');
    await handoff.getByRole('button', { name: '渡すフォルダーを作る' }).click();
    const result = page.locator('#handoff-result');
    // 未決事項は、書いた 1 件と、保存版と違う作業中から書き出したことを Studio が足した 1 件。未接続には、目録の未実装 3 つと制約が入る
    await expect(result).toContainText('渡すフォルダーを作りました。本物につないだもの 2 件、お試しのもの 3 件、つないでいないもの 9 件、未決事項 2 件。');
    exported = await result.locator('code').textContent();
    await fs.cp(exported, other, { recursive: true });

    // 8. 版: 保存した版に戻すと、変更前の画面と AI の設定、保存したときの会話に戻る
    await page.getByRole('button', { name: '保存 1 の状態に戻す' }).click();
    await expect(page.locator('#versions-message')).toHaveText('保存 1「学習相談の最初の版」に戻しました。戻す前の状態は、保存 2(自動)にしました。');
    await expect(ui.app.getByRole('heading', { name: 'あおぞら学習相談' })).toBeVisible();
    await expect(ui.plan.locator('dt')).toHaveText(['学びたいこと', 'いまの段階', '学び方', '1日に使える時間']);
    await expect(ui.values).toHaveText(['英会話', 'はじめて', '動画で学ぶ', '30分']);
    await expect(ui.log.last()).toContainText(COMPLETE);
    await page.screenshot({ path: test.info().outputPath('3-restored.png'), fullPage: true });
  } finally {
    await studio.stop();
  }

  // 渡した先で読む: 項目、データの場所、会話の接続の区別が、この題材のまま出る
  const files = (await allFiles(other)).map((file) => path.relative(other, file).split(path.sep).join('/'));
  expect(files).toEqual([
    'README.md',
    'ai/response-schema.json',
    'ai/system-prompt.md',
    'app/App.jsx',
    'app/ai.json',
    'app/courses.js',
    'app/main.jsx',
    'app/prototype.json',
    'app/scenarios/talk-and-plan.json',
    'app/style.css',
    'handoff.json',
  ]);
  const readme = await fs.readFile(path.join(other, 'README.md'), 'utf8');
  await fs.writeFile(test.info().outputPath('handed-over-README.md'), readme);
  expect(readme).toContain('# 引き継ぎ: 学習相談(架空・AI と話せる)');
  expect(readme).toMatch(/\| モック \| データ \| .*app\/courses\.js/);
  expect(readme).toContain('- 保存した版のどれとも違う作業中から書き出した。どの版を本番の基にするか決める。');
  expect(readme).toMatch(/\| 実機 \| プロダクト内 AI\(実モデル\) \| Claude Code で 1 回応答した。/);
  expect(readme).toContain('| `minutes` | 1日に使える時間 | 数(単位: 分)、5 以上、300 以下 | 未定 |');
  expect(readme).toContain('| `subject` | 学びたいこと | プログラミング |');
  expect(readme).toMatch(/\| 1日に使える時間を先に聞くようにして \| 通った \| app\/ai\.json \|/);
  for (const file of await allFiles(other)) {
    expect(await fs.readFile(file, 'utf8'), `${path.relative(other, file)} に求人の言葉`).not.toMatch(JOB_WORDS);
  }

  // ソースは、別の Studio に置けばそのまま動く(引き継ぎの README の手順)
  await fs.cp(path.join(other, 'app'), path.join(otherHome, 'projects', 'handed-over-study', 'app'), { recursive: true });
  const elsewhere = await launchStudio(otherHome);
  try {
    await page.goto(elsewhere.url);
    // 名前は目録の title から作るので、サンプルと同じ名前になる。ID で選ぶ
    await page.locator('#project-menu-button').click();
    await page.locator('[data-project-id="handed-over-study"]').click();
    const ui = parts(page);
    await expect(ui.app.getByRole('heading', { name: 'そよかぜ学習相談' })).toBeVisible();
    await ui.say('英会話を始めたいです');
    await expect(ui.log.last()).toContainText('学びたいこと「英会話」ですね。1日に何分くらい使えますか?');
  } finally {
    await elsewhere.stop();
  }
}
