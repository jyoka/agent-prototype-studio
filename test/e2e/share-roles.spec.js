import { startRelay } from '../../src/relay/relay-server.js';
import { aadOf, generateSigner, importKey, importSigner, randomText, seal, signEvent, textPrint } from '../../src/share-page/seal.js';
import { chooseSample, expect, expectNoDevWords, launchStudio, SAMPLES, test } from './studio.js';

// 共有の場の招待と役と承認(docs/design/collaboration.md の 9.4 と 9.8、K7 の 3 枚目)。中継のサーバーはテストの中で 127.0.0.1 に起こす。
// 作る AI は偽接続(STUDIO_AGENT=fake。偽の claude)。実モデルは呼ばない。題材は架空の図書室

const ID = SAMPLES.library.id;

// 進行役の画面で整理の板を開き、共有を始める
async function startSharing(page, studio) {
  await page.goto(studio.url);
  await page.locator('#project-menu-button').click();
  await chooseSample(page, SAMPLES.library);
  await page.locator('#organize-mark').click();
  await expect(page.getByRole('heading', { level: 2, name: 'ヒアリングの整理' })).toBeVisible();
  const share = page.locator('#share');
  await share.getByRole('button', { name: '共有を始める' }).click();
  await expect(share.locator('#share-state')).toContainText('共有しています');
  return share;
}

async function invite(share, name, role) {
  await share.getByLabel('招く人の呼び名').fill(name);
  await share.getByLabel('役').selectOption({ label: role });
  await share.getByRole('button', { name: '招待のリンクを作る' }).click();
  const link = share.getByLabel(`${name}の招待のリンク`);
  await expect(link).toHaveValue(/\/s\/[A-Za-z0-9_-]+#k=/);
  return link.inputValue();
}

async function openPage(browser, link, { connected = true } = {}) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(link);
  if (connected) await expect(page.locator('#share-status')).toHaveText(/つながっています/);
  return { context, page };
}

function readLink(link) {
  const url = new URL(link);
  const params = new URLSearchParams(url.hash.slice(1));
  return { origin: url.origin, sessionId: url.pathname.split('/').pop(), key: params.get('k'), ticket: params.get('t'), member: params.get('m'), signingKey: params.get('s') };
}

// 参加者のページと同じに署名して包み、中継のサーバーに送る。signAs はその人の鍵で署名する。by は書き込みの中の人
async function sealRow(link, op, { signAs = link, by } = {}) {
  const { sessionId, key, member } = readLink(link);
  const signed = await signEvent(await importSigner(readLink(signAs).signingKey ?? (await generateSigner()).privateKey), sessionId, { ...op, opId: randomText(9), at: new Date().toISOString(), by: by ?? member });
  return seal(await importKey(key), aadOf(sessionId, 'row'), signed);
}

function postRow(link, data) {
  const { origin, sessionId, ticket } = readLink(link);
  return fetch(`${origin}/api/sessions/${sessionId}/rows`, { method: 'POST', headers: { Authorization: `Bearer ${ticket}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ data }) });
}

// 作る AI の起動の数(偽の claude を起動した回数。run ごとの起動の合計)
async function launches(studio) {
  const { runs } = await studio.api(`/api/projects/${ID}/build-requests`);
  return runs.reduce((sum, run) => sum + run.launches.length, 0);
}

const commentItem = (page, n) => page.getByRole('list', { name: 'コメントの一覧' }).locator(':scope > li').filter({ has: page.getByText(`コメント ${n}`, { exact: true }) });

async function writeComment(page, text, kind = '見た目と動き') {
  await page.getByRole('textbox', { name: 'コメント', exact: true }).fill(text);
  await page.getByRole('radio', { name: kind }).check();
  await page.getByRole('button', { name: 'コメントを書く' }).click();
}

test('招待していない人と外した人は入れない。見るだけの人はコメントを書けない', async ({ page, browser, home }) => {
  test.setTimeout(60_000);
  const relay = await startRelay();
  const studio = await launchStudio(home, { env: { STUDIO_RELAY_URL: relay.url } });
  const opened = [];
  try {
    const share = await startSharing(page, studio);
    const writer = await invite(share, 'しおり', '参加者(直せる)');
    const viewer = await invite(share, 'つばさ', '見るだけ');
    const leaving = await invite(share, 'みなと', '参加者(直せる)');
    const { sessionId, origin } = readLink(writer);

    // 参加者はコメントを書ける
    const a = await openPage(browser, writer);
    opened.push(a);
    await writeComment(a.page, '貸出の画面に返す日を出して');
    await expect(commentItem(a.page, 1)).toContainText('貸出の画面に返す日を出して');
    await expect(commentItem(a.page, 1)).toContainText('書いた人: しおり');

    // 招待のリンクを持たない人: 鍵がないので、何も読めない
    const bare = await openPage(browser, `${origin}/s/${sessionId}`, { connected: false });
    opened.push(bare);
    await expect(bare.page.locator('#share-status')).toHaveText(/招待のリンクの鍵がありません/);
    await expect(bare.page.locator('#share-main')).toBeHidden();
    // 鍵と札をでたらめに作ったリンク: 中継のサーバーが入れない
    const forged = await openPage(browser, `${origin}/s/${sessionId}#k=${randomText(32)}&t=${randomText(32)}&m=${randomText(12)}`, { connected: false });
    opened.push(forged);
    await expect(forged.page.locator('#share-status')).toHaveText(/この招待のリンクでは入れません/);
    await expect(forged.page.locator('#share-main')).toBeHidden();
    for (const headers of [{}, { Authorization: `Bearer ${randomText(32)}` }]) {
      const response = await fetch(`${origin}/api/sessions/${sessionId}/files/docs`, { headers });
      expect([401, 403]).toContain(response.status);
    }

    // 外した人: 前のリンクでは入れない
    await share.getByRole('listitem').filter({ hasText: 'みなと' }).getByRole('button', { name: '外す' }).click();
    await expect(share.getByLabel('みなとの招待のリンク')).toHaveCount(0);
    const left = await openPage(browser, leaving, { connected: false });
    opened.push(left);
    await expect(left.page.locator('#share-status')).toHaveText(/この招待のリンクでは入れません/);
    await expect(left.page.locator('#share-main')).toBeHidden();

    // 見るだけの人: コメントは読めるが、書く口、反応、承認の口がない
    const c = await openPage(browser, viewer);
    opened.push(c);
    await expect(c.page.getByText('見るだけの役です')).toBeVisible();
    await expect(commentItem(c.page, 1)).toContainText('貸出の画面に返す日を出して');
    await expect(c.page.locator('#share-comment-form')).toBeHidden();
    await expect(c.page.getByRole('button', { name: /反応を付ける|承認/ })).toHaveCount(0);
    // 見るだけの人が、ページを使わずに書き込みを作って送っても、中継のサーバーが断る
    const refused = await postRow(viewer, await sealRow(viewer, { op: 'comment-add', kind: 'look', text: '見るだけの人のコメント' }));
    expect(refused.status).toBe(403);
    await page.waitForTimeout(1000);
    const { comments } = await studio.api(`/api/projects/${ID}/comments`);
    expect(comments.comments.map((comment) => comment.text)).toEqual(['貸出の画面に返す日を出して']);
    await expectNoDevWords(c.page.locator('main'));
  } finally {
    for (const { context } of opened) await context.close();
    await studio.stop();
    await relay.close();
  }
});

test('参加者の画面で承認しても、Studio が役で確かめ、進行役が送るまで偽の claude は起動しない。役の足りない承認と中継のサーバーの偽の承認では起動しない', async ({ page, browser, home }) => {
  test.setTimeout(150_000);
  const bodies = [];
  const relay = await startRelay({ onBody: (entry) => bodies.push(entry) });
  const studio = await launchStudio(home, { env: { STUDIO_RELAY_URL: relay.url } });
  const opened = [];
  try {
    const share = await startSharing(page, studio);
    const writerLink = await invite(share, 'しおり', '参加者(直せる)');
    const deciderLink = await invite(share, 'みなと', '決める人(承認できる)');
    const decider = readLink(deciderLink);
    const a = await openPage(browser, writerLink);
    const d = await openPage(browser, deciderLink);
    opened.push(a, d);
    await expect(d.page.locator('#share-who')).toHaveText('あなた: みなと(決める人(承認できる))');

    // 参加者が見た目と動きのコメントを書く。参加者には承認の口がない
    await writeComment(a.page, '見出しを「ひだまり図書室」にして');
    await expect(commentItem(d.page, 1)).toContainText('見出しを「ひだまり図書室」にして');
    await expect(commentItem(a.page, 1).getByRole('button', { name: '決める人として承認' })).toHaveCount(0);
    await expect(commentItem(d.page, 1).getByRole('button', { name: '決める人として承認' })).toBeVisible();
    const { comments: first } = await studio.api(`/api/projects/${ID}/comments`);
    const comment = first.comments[0];
    const print = await textPrint(comment.text);

    // 役の足りない承認: 参加者がページを使わずに承認を作る(自分の鍵で正しく署名)。Studio が役で断る
    expect((await postRow(writerLink, await sealRow(writerLink, { op: 'comment-approve', comment: comment.id, textPrint: print }))).status).toBe(201);
    await expect(share.locator('#share-refused')).toContainText('しおりさんの書き込みを当てませんでした: 決める人の役ではないので、承認として数えませんでした');

    // 中継のサーバーが作った偽の承認。中継のサーバーは会の鍵も署名の鍵も持たない。
    // (1) 鍵なしで作った暗号文を、決める人の書き込みとして並べる
    // (2) 会の鍵が漏れたとしても、決める人の署名の鍵はないので、別の人の鍵で署名した承認を決める人の書き込みとして並べる
    const session = relay.relay.sessions.get(decider.sessionId);
    const forge = (data) => session.rows.push({ seq: session.nextSeq++, member: decider.member, at: new Date().toISOString(), data });
    forge(randomText(80));
    forge(await sealRow(deciderLink, { op: 'comment-approve', comment: comment.id, textPrint: print }, { signAs: writerLink }));
    // 中継のサーバーは列に足しただけで知らせない。参加者の本当の書き込み(反応)で、Studio が続きを受け取る
    await commentItem(a.page, 1).getByRole('button', { name: /に反応を付ける/ }).click();
    await expect(share.locator('#share-refused')).toContainText('みなとさんの書き込みを当てませんでした: 書き込みを開けなかったので、当てませんでした');
    await expect(share.locator('#share-refused')).toContainText('みなとさんの書き込みを当てませんでした: 署名が合わないので、当てませんでした');
    await expect(commentItem(d.page, 1)).toContainText('反応 1');
    await expect(commentItem(d.page, 1)).toContainText('開いている');
    expect(await launches(studio)).toBe(0);

    // 要件のコメントは、決める人の承認だけでは送る待ちにならない(進行役と 2 人が要る)
    await writeComment(a.page, '貸出の上限を 5 冊にして', '要件');
    await expect(commentItem(d.page, 2)).toContainText('貸出の上限を 5 冊にして');
    await commentItem(d.page, 2).getByRole('button', { name: '決める人として承認' }).click();
    await expect(commentItem(d.page, 2)).toContainText('承認 1 / 2(進行役と決める人): みなと(決める人)');
    await expect(commentItem(d.page, 2)).toContainText('開いている');

    // 決める人が自分の画面で承認する。Studio が確かめ、「進行役が送る待ち」で止まる。起動しない
    await commentItem(d.page, 1).getByRole('button', { name: '決める人として承認' }).click();
    await expect(d.page.locator('#share-comment-status')).toContainText('承認を送りました');
    await expect(commentItem(d.page, 1)).toContainText('進行役が送る待ち');
    await expect(commentItem(a.page, 1)).toContainText('進行役が自分の PC で「作る AI に送る」を押すと、作る AI が直します。');
    const awaiting = share.getByRole('list', { name: '送る待ちのコメント' });
    await expect(awaiting).toContainText('コメント 1「見出しを「ひだまり図書室」にして」(見た目と動き)。承認: みなと(決める人、共有の場から)');
    await expect(awaiting).not.toContainText('コメント 2');
    await page.waitForTimeout(1500);
    expect(await launches(studio)).toBe(0);
    await expectNoDevWords(share);
    await page.screenshot({ path: test.info().outputPath('1-awaiting.png'), fullPage: true });

    // 同じ承認の暗号文を送り直しても、2 度は数えない
    const approvalRow = bodies.filter((entry) => entry.member === decider.member && entry.path.endsWith('/rows')).at(-1);
    expect((await postRow(deciderLink, approvalRow.body.data)).status).toBe(201);
    await page.waitForTimeout(1000);
    expect(await launches(studio)).toBe(0);

    // 進行役が自分の PC で「作る AI に送る」を押すと、1 回だけ起動する
    await awaiting.getByRole('button', { name: 'コメント 1 を作る AI に送る' }).click();
    await expect(commentItem(d.page, 1)).toContainText('確かめる', { timeout: 90_000 });
    expect(await launches(studio)).toBe(1);
    await expect(share.locator('#share-awaiting-box')).toBeHidden();
    const { comments: after } = await studio.api(`/api/projects/${ID}/comments`);
    const record = after.comments.find((c) => c.id === comment.id).records[0];
    expect(record.approval.approvers).toMatchObject([{ role: 'decider', via: 'shared', pressedBy: 'みなと', member: decider.member }]);
    expect(record.approval.sentBy).toMatchObject({ role: 'facilitator' });

    // 送った後に同じ承認を送り直しても、もう 1 度は起動しない
    expect((await postRow(deciderLink, approvalRow.body.data)).status).toBe(201);
    await page.waitForTimeout(1500);
    expect(await launches(studio)).toBe(1);
  } finally {
    for (const { context } of opened) await context.close();
    await studio.stop();
    await relay.close();
  }
});

test('「会のデータを消す」で、中継のサーバーの写しも消え、参加者の画面の写しも消える', async ({ page, browser, home }) => {
  test.setTimeout(60_000);
  const relay = await startRelay();
  const studio = await launchStudio(home, { env: { STUDIO_RELAY_URL: relay.url } });
  let participant;
  try {
    // 会を用意し、同意する
    await page.goto(studio.url);
    await page.locator('#project-menu-button').click();
    await page.getByRole('button', { name: 'お客さんとの会を始める' }).click();
    await page.getByLabel('会の目的').fill('架空の図書室の貸出を考える会');
    await page.getByRole('button', { name: '会を用意する' }).click();
    await page.getByRole('button', { name: '同意して始める' }).click();
    await expect(page.locator('#meeting-mark')).toHaveText('会: 同意した');
    const { projects } = await studio.api('/api/projects');
    const id = projects.find((project) => project.meeting.status !== 'none').id;

    // 共有を始め、参加者を招く
    expect((await studio.post(`/api/projects/${id}/share/start`)).status).toBe(200);
    const invited = await studio.post(`/api/projects/${id}/share/invite`, { name: 'しおり', role: 'participant' });
    expect(invited.status).toBe(200);
    const link = JSON.parse(invited.text).share.members[0].link;
    const { sessionId, ticket, origin } = readLink(link);
    participant = await openPage(browser, link);
    await writeComment(participant.page, '返す日を大きく出して');
    await expect(commentItem(participant.page, 1)).toContainText('返す日を大きく出して');
    expect(relay.relay.sessions.has(sessionId)).toBe(true);

    // 会のデータを消す。消すものの一覧に、中継のサーバーの写しが載る
    await page.locator('#meeting-mark').click();
    await page.getByRole('button', { name: '会のデータを消す' }).click();
    const confirm = page.getByRole('group', { name: '会のデータを消す前に' });
    await expect(confirm).toContainText('中継のサーバーの写し');
    await confirm.getByRole('button', { name: '消す', exact: true }).click();
    await expect(page.getByRole('heading', { level: 2, name: '会のデータを消しました' })).toBeVisible();
    await expect(page.getByRole('list', { name: '消した一覧' })).toContainText('中継のサーバーの写し');

    // 中継のサーバーの写しが消え、その会には「消した」と返す。参加者の画面の写しと sessionStorage も消える
    expect(relay.relay.sessions.has(sessionId)).toBe(false);
    const gone = await fetch(`${origin}/api/sessions/${sessionId}/files/docs`, { headers: { Authorization: `Bearer ${ticket}` } });
    expect(gone.status).toBe(410);
    await expect(participant.page.locator('#share-gone')).toHaveText(/この会のデータは消しました/);
    await expect(participant.page.locator('#share-main')).toBeHidden();
    expect(await participant.page.evaluate(() => sessionStorage.length)).toBe(0);
  } finally {
    await participant?.context.close();
    await studio.stop();
    await relay.close();
  }
});
