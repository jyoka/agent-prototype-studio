import fs from 'node:fs/promises';
import path from 'node:path';
import { ROOT, SAMPLES, chooseProject, chooseSample, expect, launchStudio, test, writeProject } from './studio.js';

// 会話の枠(同梱の studio-talk)と、構成 A の見本(架空のバイト探し)。模擬のエージェントはモック(お試しの AI)で答える。
// カードを使えない前提は、既定を替えた写しで確かめる(開発者向けの詳細で前提を選ぶ形は test/e2e/sim-choice.spec.js)
const SAMPLE_APP = path.join(ROOT, 'samples', 'part-time', 'app');
const TEXT_ONLY = { id: 'talk-text-only', name: 'バイト探し カードなし(架空・AI と話せる)' };

async function sampleFiles(edit) {
  const files = {};
  for (const name of await fs.readdir(SAMPLE_APP, { recursive: true })) {
    const file = path.join(SAMPLE_APP, name);
    if ((await fs.stat(file)).isFile()) files[name.split(path.sep).join('/')] = await fs.readFile(file, 'utf8');
  }
  return edit(files);
}

function talkOf(page) {
  const app = page.frameLocator('iframe[title="試作品"]');
  const talk = app.getByRole('region', { name: '会話' });
  const items = talk.getByRole('list', { name: 'やりとり' }).locator(':scope > li');
  const message = app.getByLabel('メッセージ');
  const say = async (text) => {
    await message.fill(text);
    await app.getByRole('button', { name: '送る' }).click();
    await expect(message).toHaveValue('');
  };
  return { app, talk, items, say };
}

test('カードを使えない前提では、カードが文に落ちて描かれる。ボタンを押すと action が送られる(S4)', async ({ page, home }) => {
  await writeProject(
    home,
    TEXT_ONLY.id,
    await sampleFiles((files) => {
      const composition = JSON.parse(files['composition.json']);
      composition.assumptions.default = 'partner-b';
      const manifest = JSON.parse(files['prototype.json']);
      manifest.title = 'バイト探し カードなし(架空)';
      return { ...files, 'composition.json': JSON.stringify(composition), 'prototype.json': JSON.stringify(manifest) };
    }),
  );
  const studio = await launchStudio(home);
  try {
    await page.goto(studio.url);
    await chooseProject(page, TEXT_ONLY.name);
    const { app, talk, items, say } = talkOf(page);
    await expect(talk).toContainText('いまの案内役はお試しの AI です');

    // カードは、見出し、本文、番号つきの選択肢の文になる。カードの枠もボタンも描かない
    await say('詳しく見せて');
    await expect(items.last()).toContainText('架空の品出し\nみなと町・時給 1100 円・土日\n1. この求人で希望を保存\n2. 条件を変える');
    await expect(talk.getByRole('article')).toHaveCount(0);
    await expect(talk.getByRole('button', { name: 'この求人で希望を保存' })).toHaveCount(0);

    // 前提で使えるボタンは、ボタンとして描く。押すと、ボタンの文と action が送られる
    await say('希望を保存したい');
    await expect(items.last().getByRole('button')).toHaveText(['保存してよい', 'やめておく']);
    await talk.getByRole('button', { name: '保存してよい' }).click();
    // action(agree)の決まりで答えた。文の「保存してよい」だけでは、この返事にならない
    await expect(items.last()).toContainText('保存してよいと記録しました');
    await expect(items.nth(-2)).toContainText('保存してよい');
    const trace = await studio.api(`/api/projects/${TEXT_ONLY.id}/ai/trace`);
    expect(trace.entries[0]).toMatchObject({ kind: 'sim-turn', input: { text: '保存してよい', action: 'agree' } });
    // 前のターンの選択肢は、押せない印になる(同じ名前のボタンが並ばない)
    await expect(talk.getByRole('button', { name: 'やめておく' })).toHaveCount(0);

    await talk.getByRole('button', { name: '希望を保存する' }).click();
    await expect(items.last()).toContainText('希望を保存しました');
    const records = app.getByRole('region', { name: '受け取った記録' });
    await expect(records).toContainText('保存してよい');
    await expect(records.getByRole('listitem')).toHaveText(['みなと町']);
    await expect(app.locator('body')).not.toContainText('モック');
  } finally {
    await studio.stop();
  }
});

test('見本のバイト探しでは、カード、カルーセル、ボタンが部品のまま描かれ、見た目を 3 つから選べる', async ({ page, home }) => {
  const studio = await launchStudio(home);
  try {
    await page.goto(studio.url);
    await chooseSample(page, SAMPLES.partTime);
    const { app, talk, items, say } = talkOf(page);
    await expect(app.getByRole('heading', { name: 'そよかぜバイト探し' })).toBeVisible();

    // 会話がまだないときは、押すと送れる例が出る
    await talk.getByRole('group', { name: '話しかける例' }).getByRole('button', { name: 'みなと町でバイトを探しています' }).click();
    await expect(items.last()).toContainText('みなと町では3件ありました。');
    await expect(items.last().locator('.studio-talk__via')).toHaveText('お試しの AI');
    await expect(items.last().locator('.studio-talk__who')).toContainText('そよかぜの案内役(模擬)');
    const carousel = talk.getByRole('group', { name: 'カードの一覧' });
    await expect(carousel.getByRole('article')).toHaveText([/架空の品出し/, /架空の配膳/, /架空のパン屋の店番/]);

    // カードの中のボタンも、役割 button と名前で押せる
    await carousel.getByRole('button', { name: '品出しの詳細' }).click();
    const card = items.last().getByRole('article', { name: '架空の品出し' });
    await expect(card.getByRole('heading', { name: '架空の品出し' })).toBeVisible();
    await expect(card).toContainText('みなと町・時給 1100 円・土日');
    await expect(card.getByRole('button')).toHaveText(['この求人で希望を保存', '条件を変える']);

    // 同意の前に保存を頼むと、ツールの守り(requires)が止め、記録の店は変わらない
    await say('そのまま保存して');
    await expect(items.last()).toContainText('記録「consent」がありません');
    const records = app.getByRole('region', { name: '受け取った記録' });
    await expect(records).toContainText('まだ聞いていません');
    await expect(records).toContainText('まだありません');

    // 見た目は talk、web、plain。選ぶまでは構成の surface.theme(talk)
    const surface = app.locator('section.studio-talk');
    await expect(surface).toHaveClass(/studio-talk--talk/);
    await expect(app.getByLabel('会話の枠の見た目')).toHaveValue('talk');
    await app.getByLabel('会話の枠の見た目').selectOption('web');
    await expect(surface).toHaveClass(/studio-talk--web/);
    await app.getByLabel('会話の枠の見た目').selectOption('plain');
    await expect(surface).toHaveClass(/studio-talk--plain/);
    await expect(app.locator('body')).not.toContainText('モック');
  } finally {
    await studio.stop();
  }
});

// 構成 A の守り(jyoka/tasks#366)。お試しの AI は、同意の後に名前、電話番号、住所(どれも架空)をメモに保存しようとする。
// プロンプトの頼みに頼らず、ツールの守り(deny)が止め、受け取った記録に希望は入らない。ハラスメントの話には相談窓口(架空)を案内する
test('見本のバイト探しでは、同意の後でも、名前、電話番号、住所の保存をツールの守りが止め、つらい話には相談窓口を案内する', async ({ page, home }) => {
  const studio = await launchStudio(home);
  try {
    await page.goto(studio.url);
    await chooseSample(page, SAMPLES.partTime);
    const { app, talk, items, say } = talkOf(page);
    const records = app.getByRole('region', { name: '受け取った記録' });

    // カードから「この求人で希望を保存」→「保存してよい」で、保存してよいと記録する
    await talk.getByRole('group', { name: '話しかける例' }).getByRole('button', { name: 'みなと町でバイトを探しています' }).click();
    await talk.getByRole('group', { name: 'カードの一覧' }).getByRole('button', { name: '品出しの詳細' }).click();
    await items.last().getByRole('button', { name: 'この求人で希望を保存' }).click();
    await items.last().getByRole('button', { name: '保存してよい' }).click();
    await expect(records).toContainText('保存してよい');

    await say('みほん太郎です。名前もメモに残しておいて');
    await expect(items.last()).toContainText('名前は保存できません');
    await say('連絡用に 090-0000-1111 もメモに残しておいて');
    await expect(items.last()).toContainText('電話番号とメールアドレスは保存できません');
    await say('家はかわせみ町1-2-3 なので、それもメモに残しておいて');
    await expect(items.last()).toContainText('住所は保存できません');
    await expect(records).toContainText('まだありません');

    await say('前の店長にどなられてつらい');
    await expect(items.last()).toContainText('こもれび相談窓口(架空)');
    await expect(records).toContainText('まだありません');
  } finally {
    await studio.stop();
  }
});
