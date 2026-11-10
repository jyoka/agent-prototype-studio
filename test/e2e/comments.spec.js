import fs from 'node:fs/promises';
import path from 'node:path';
import { SAMPLES, chooseSample, expect, expectNoDevWordsOnScreen, launchStudio, openMore, test } from './studio.js';

// 画面へのコメント、反応、承認、列、直した記録、元に戻す(docs/design/user-journey.md の K3。collaboration.md の 3〜5 節)。
// 見せる画面(J7)の上で、1 台の PC の形で使う。作る AI は偽接続(偽の claude。src/agent/fake-claude.js)で、実モデルは呼ばない。題材は架空

const ID = SAMPLES.jobConsult.id;

function parts(page) {
  const comments = page.getByRole('region', { name: 'コメント' });
  return {
    app: page.frameLocator('iframe[title="試作品"]'),
    comments,
    list: comments.getByRole('list', { name: 'コメントの一覧' }),
    item: (n) => comments.getByRole('list', { name: 'コメントの一覧' }).locator(':scope > li').filter({ has: page.getByText(`コメント ${n}`, { exact: true }) }),
    status: page.locator('#comment-status'),
    queue: page.locator('#comment-queue'),
  };
}

async function startShow(page) {
  const panel = await openMore(page);
  await panel.getByRole('button', { name: '人に見せる' }).click();
  await expect(page.getByRole('region', { name: '確かめたい問い' })).toBeVisible();
}

async function writeComment(page, text, kind = '見た目と動き', { place = null } = {}) {
  const ui = parts(page);
  if (place) {
    await ui.comments.getByRole('button', { name: '画面の場所を選ぶ' }).click();
    const host = page.locator('#frame-host');
    const box = await host.boundingBox();
    await page.mouse.click(box.x + (box.width * place.x) / 100, box.y + (box.height * place.y) / 100);
    await expect(ui.comments).toContainText(`場所: 見えている画面の、左から ${place.x}%、上から ${place.y}% のあたり`);
  }
  await ui.comments.getByLabel('コメント', { exact: true }).fill(text);
  await ui.comments.getByRole('radio', { name: kind }).check();
  await ui.comments.getByRole('button', { name: 'コメントを書く' }).click();
  await expect(ui.status).toContainText('を書きました。承認するまで、直す AI には送りません。');
}

// 作る AI の起動の数(偽の claude を起動した回数。run ごとの起動の合計)と、run の数
async function launches(studio) {
  const { runs } = await studio.api(`/api/projects/${ID}/build-requests`);
  return { runs: runs.length, launches: runs.reduce((sum, run) => sum + run.launches.length, 0), list: runs };
}

// 待っても起動しないこと。列は承認の直後に進むので、少し待ってから数える
async function expectNoLaunch(studio, page) {
  await page.waitForTimeout(1500);
  expect((await launches(studio)).launches).toBe(0);
}

async function readRecords(home) {
  const dir = path.join(home, 'projects', ID, '.studio', 'fix-records');
  const names = await fs.readdir(dir).catch(() => []);
  return Promise.all(names.map(async (name) => JSON.parse(await fs.readFile(path.join(dir, name, 'record.json'), 'utf8'))));
}

test('反応を 10 個付けても起動しない。承認で 1 回だけ起動し、前と後を比べられる。元に戻すと前の版になり、記録に「戻した」が足される', async ({ page, home }) => {
  test.setTimeout(150_000);
  const studio = await launchStudio(home);
  try {
    await page.goto(studio.url);
    await chooseSample(page, SAMPLES.jobConsult);
    const ui = parts(page);
    await expect(ui.app.getByRole('heading', { name: 'しおかぜ求人相談' })).toBeVisible();
    await startShow(page);

    // 画面の場所を選んでコメントを書く。枠の上に番号の印が出る
    await writeComment(page, '見出しを「うみかぜ求人相談」にして', '見た目と動き', { place: { x: 30, y: 10 } });
    const first = ui.item(1);
    await expect(first).toContainText('開いている');
    await expect(first).toContainText('場所: 見えている画面の、左から 30%、上から 10% のあたり');
    await expect(page.locator('#frame-host .comment-pin')).toHaveText(['1']);

    // 反応を 10 個付けても、作る AI は起動しない
    for (let i = 0; i < 10; i += 1) {
      await first.getByRole('button', { name: /に反応を付ける/ }).click();
      await expect(first.getByRole('button', { name: /に反応を付ける/ })).toHaveAccessibleName(`コメント 1 に反応を付ける(今 ${i + 1})`);
    }
    await expectNoLaunch(studio, page);
    await expect(first).toContainText('開いている');
    await expectNoDevWordsOnScreen(page);

    // 決める人が声に出し、進行役が押す。1 人の承認で列に並び、1 回だけ起動する
    await ui.comments.getByLabel('押した人').fill('担当');
    await ui.comments.getByLabel('声に出した人').fill('店長');
    await first.getByRole('button', { name: '決める人として承認' }).click();
    await expect(ui.status).toContainText('コメント 1 を承認しました。列に並べ、順に直す AI に送ります。');
    await expect(first).toContainText('確かめる', { timeout: 60_000 });
    await expect(ui.app.getByRole('heading', { name: 'うみかぜ求人相談' })).toBeVisible();
    const once = await launches(studio);
    expect(once.runs).toBe(1);
    expect(once.launches).toBe(1);
    // 依頼は決まった形に包む(コメントの文はそのまま渡さない)
    expect(once.list[0].request).toMatch(/^画面へのコメントから頼みます。/);
    expect(once.list[0].request).toContain('どうなってほしいか: 見出しを「うみかぜ求人相談」にして');

    // 直した記録: 前と後の画面を並べ、起きたことを出す。答えを残す先は、直した後の版になる
    const record = first.getByRole('region', { name: '直した記録(コメント 1)' });
    // 直す前は、見せ始めたときに保存した版(今の状態と同じなので、新しく保存しない)
    await expect(record).toContainText('直す前: 保存 1「人に見せた状態」。直した後: 保存 2「コメント 1 で変えた状態」');
    await expect(record.getByRole('img', { name: '直す前の画面(コメント 1)' })).toBeVisible();
    await expect(record.getByRole('img', { name: '直した後の画面(コメント 1)' })).toBeVisible();
    await expect(record.getByRole('list', { name: '起きたこと(コメント 1)' }).getByRole('listitem')).toHaveText([/作る AI に送った/, /直した版ができた/]);
    await expect(page.locator('#show-lead')).toContainText('答えは保存 2「コメント 1 で変えた状態」に残します。');
    await expectNoDevWordsOnScreen(page);
    await page.screenshot({ path: test.info().outputPath('1-fixed.png'), fullPage: true });

    // 直した記録の項目(collaboration.md の 5 節)がファイルにそろう
    const [saved] = await readRecords(home);
    expect(saved.comment).toMatchObject({ number: 1, text: '見出しを「うみかぜ求人相談」にして', place: { x: 30, y: 10 }, kind: 'look', reactions: 10 });
    expect(saved.approval.approvers).toMatchObject([{ role: 'decider', pressedBy: '担当', spokenBy: '店長' }]);
    expect(saved.request.text).toBe(once.list[0].request);
    expect(saved.versions.before.number).toBe(1);
    expect(saved.versions.after.number).toBe(2);
    expect(saved.changes.files.length).toBeGreaterThan(0);
    expect(saved.gates.results.length).toBeGreaterThan(0);
    expect(saved.gates.run).toBe(`.studio/runs/${once.list[0].id}/run.json`);

    // 元に戻す: 直す前の版になり、記録に「戻した」が足される(記録は消えない)。起動は増えない
    await first.getByRole('button', { name: '元に戻す' }).click();
    await expect(ui.status).toContainText('保存 1「人に見せた状態」に戻しました。直した記録に「戻した」を足しました。');
    await expect(ui.app.getByRole('heading', { name: 'しおかぜ求人相談' })).toBeVisible();
    await expect(first).toContainText('戻した');
    await expect(record.getByRole('list', { name: '起きたこと(コメント 1)' }).getByRole('listitem')).toHaveText([/作る AI に送った/, /直した版ができた/, /戻した\(押した人: 担当、声に出した人: 店長\)/]);
    const [afterRevert] = await readRecords(home);
    expect(afterRevert.id).toBe(saved.id);
    expect(afterRevert.events.map((e) => e.label)).toEqual(['作る AI に送った', '直した版ができた', '戻した']);
    expect(afterRevert.confirmation.revertedAt).toBeTruthy();
    expect((await launches(studio)).launches).toBe(1);
    await expectNoDevWordsOnScreen(page);
    await page.screenshot({ path: test.info().outputPath('2-reverted.png'), fullPage: true });
  } finally {
    await studio.stop();
  }
});

test('要件のコメントは 2 人の承認がそろうまで起動しない。承認を取り消すと起動しない。列に並んだものも取り消せる', async ({ page, home }) => {
  test.setTimeout(150_000);
  const studio = await launchStudio(home);
  try {
    await page.goto(studio.url);
    await chooseSample(page, SAMPLES.jobConsult);
    const ui = parts(page);
    await startShow(page);

    // 要件: 進行役だけでは送らない。取り消して、決める人だけでも送らない
    await writeComment(page, '見出しを「はまかぜ求人相談」にして', '要件');
    const req = ui.item(1);
    await req.getByRole('button', { name: '進行役として承認' }).click();
    await expect(ui.status).toContainText('コメント 1 に承認を 1 つ付けました。もう 1 人の承認がそろうまで送りません。');
    await expect(req).toContainText('承認(2 人が要ります): 進行役 済み、決める人 まだ');
    await expectNoLaunch(studio, page);
    await req.getByRole('button', { name: '承認を取り消す' }).click();
    await expect(ui.status).toContainText('コメント 1 の承認を取り消しました。直す AI には送りません。');
    await req.getByRole('button', { name: '決める人として承認' }).click();
    await expect(req).toContainText('承認(2 人が要ります): 進行役 まだ、決める人 済み');
    await expectNoLaunch(studio, page);

    // 2 人がそろうと 1 回だけ起動する
    await req.getByRole('button', { name: '進行役として承認' }).click();
    await expect(req).toContainText('確かめる', { timeout: 60_000 });
    await expect(ui.app.getByRole('heading', { name: 'はまかぜ求人相談' })).toBeVisible();
    expect((await launches(studio)).launches).toBe(1);

    // 列: 直している間に承認したものは列に並ぶ。取り消すと、前の直しが終わっても起動しない
    await writeComment(page, 'ゆっくり進めて');
    await writeComment(page, '見出しを「なみかぜ求人相談」にして');
    await ui.item(2).getByRole('button', { name: '進行役として承認' }).click();
    await expect(ui.item(2)).toContainText('直している', { timeout: 30_000 });
    await ui.item(3).getByRole('button', { name: '進行役として承認' }).click();
    await expect(ui.item(3)).toContainText('待っている(列の 1 番目)');
    await expect(ui.queue).toContainText('列に 1 件が待っています(コメント 3)');
    await ui.item(3).getByRole('button', { name: '承認を取り消す' }).click();
    await expect(ui.item(3)).toContainText('開いている');
    await expectNoDevWordsOnScreen(page);
    // 遅い直しは止める(待たない)。止まった後も、取り消したコメントは起動しない
    const running = (await launches(studio)).list.at(-1);
    expect((await studio.post(`/api/projects/${ID}/build-requests/${running.id}/cancel`, {})).status).toBe(200);
    await expect(ui.item(2)).toContainText('落ちた', { timeout: 30_000 });
    await page.waitForTimeout(1500);
    const after = await launches(studio);
    expect(after.runs).toBe(2);
    expect(after.launches).toBe(2);
    await expect(ui.app.getByRole('heading', { name: 'はまかぜ求人相談' })).toBeVisible();
  } finally {
    await studio.stop();
  }
});

test('構成のコメントは承認しても起動せず、AI 構成の審査に戻る。審査の承認がそろうまで作る AI は動かない', async ({ page, home }) => {
  test.setTimeout(90_000);
  const studio = await launchStudio(home);
  try {
    await page.goto(studio.url);
    await chooseSample(page, SAMPLES.jobConsult);
    const ui = parts(page);
    await startShow(page);
    await writeComment(page, '答えに迷ったら、担当の人に渡すようにして', '構成');
    const arch = ui.item(1);
    await arch.getByRole('button', { name: '進行役として承認' }).click();
    await expect(ui.status).toContainText('構成のコメントなので、直す AI には送らず、AI 構成の審査に戻しました。');
    await expect(arch).toContainText('審査に戻した');
    await expectNoLaunch(studio, page);
    const project = (await studio.api('/api/projects')).projects.find((p) => p.id === ID);
    expect(project.review.status).toBe('drafting');
    await expectNoDevWordsOnScreen(page);

    // 審査を開くと、戻したコメントが出る
    await arch.getByRole('button', { name: '審査を開く' }).click();
    await expect(page.getByRole('region', { name: '確かめたい問い' })).toBeHidden();
    const review = page.locator('#review');
    await expect(review).toBeVisible();
    await expect(review.getByRole('list', { name: '審査に戻したコメント' })).toContainText('コメント 1): 答えに迷ったら、担当の人に渡すようにして');
    await expect(page.locator('#review-count')).toHaveText('承認 0 / 4');

    // 審査の承認がそろうまで、言葉で直す依頼でも作る AI は起動しない
    const refused = await studio.post(`/api/projects/${ID}/build-requests`, { request: '見出しを「あさかぜ求人相談」にして' });
    expect(refused.status).toBe(409);
    expect((await launches(studio)).launches).toBe(0);
  } finally {
    await studio.stop();
  }
});
