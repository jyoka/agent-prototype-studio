import { defaultPaths, describeLeaks, findLeaks } from '../../scripts/media/privacy.js';
import { ROOT, SAMPLES, chooseSample, closeMore, expect, goStage, openDevDetails, openMechanism } from './studio.js';

// 画像と動く画像に撮る場面(npm run media、CONTRIBUTING.md の「画像と動く画像を撮り直す」)。
// 撮る仕組みの scripts/media/media.spec.js と、場面が動くかを確かめる test/e2e/media.spec.js が使う。
// 画面のスクリーンショットの E2E(jyoka/tasks#353 の P31)も、同じ場面ならここを使う。
// 文と会話は架空で、モック(お試しの AI)が答えるので毎回同じになる。

// 撮るときの発言と依頼。見本「バイト探し(架空・AI と話せる)」の分解の絵の台本(docs/brand.md の 4 節)と同じ
export const SCENE_TEXT = {
  search: 'みなと町でバイトを探しています',
  save: 'そのまま保存して',
  fixRequest: '保存する前に、保存してよいかを必ず聞くようにして',
};

// 撮る画面の大きさ。README の幅で読める大きさにする
export const SCENE_VIEWPORT = { width: 1280, height: 800 };

// 利用者の画面に出ない印を隠す。偽接続(STUDIO_AGENT=fake)の「開発用: 偽の作る AI」は、Studio を開発する人にだけ出る
export async function hideDevOnlyMarks(page) {
  // 画面の CSP は style の要素を通さないので、要素の style で隠す
  await page.locator('#dev-agent-mark').evaluate((el) => el.style.setProperty('display', 'none', 'important'));
}

// 画面の見える文字(Studio の画面と、iframe の中の試作品)に、日付、作業ディレクトリ、メールアドレスがない。
// home は launchStudio に渡したデータの置き場
export async function expectNoLeaks(page, where, home) {
  const texts = [];
  for (const frame of page.frames()) texts.push(await frame.locator('body').innerText());
  const leaks = findLeaks(texts.join('\n'), { paths: defaultPaths([home, ROOT]) });
  expect(leaks, describeLeaks(where, leaks)).toEqual([]);
}

// 試作品の中の会話の部品
export function talkOf(page) {
  const app = page.frameLocator('iframe[title="試作品"]');
  const talk = app.getByRole('region', { name: '会話' });
  const items = talk.getByRole('list', { name: 'やりとり' }).locator(':scope > li');
  const message = app.getByLabel('メッセージ');
  return { app, talk, items, message };
}

// 間を置く。pace が 0 なら待たない(E2E は 0、動く画像は 1)
const pause = (page, ms, pace) => (pace > 0 ? page.waitForTimeout(ms * pace) : Promise.resolve());

// 試作品の欄に、1 文字ずつ打って送る(pace が 0 なら一度に入れる)
async function say(page, text, pace) {
  const { app, message } = talkOf(page);
  if (pace > 0) {
    await message.click();
    await message.pressSequentially(text, { delay: 60 * pace });
    await pause(page, 300, pace);
  } else {
    await message.fill(text);
  }
  await app.getByRole('button', { name: '送る' }).click();
  await expect(message).toHaveValue('');
}

// 見本のバイト探しを開く
export async function openPartTime(page, studio) {
  await page.goto(studio.url);
  await chooseSample(page, SAMPLES.partTime);
  const { talk } = talkOf(page);
  await expect(talk).toBeVisible();
}

// 1. 求人を探して、カードを 3 枚出す
export async function searchJobs(page, { pace = 0 } = {}) {
  const { talk, items } = talkOf(page);
  await say(page, SCENE_TEXT.search, pace);
  await expect(items.last()).toContainText('みなと町では3件ありました。');
  await expect(talk.getByRole('group', { name: 'カードの一覧' }).getByRole('article')).toHaveCount(3);
  await pause(page, 2000, pace);
}

// 2. 同意の前に保存を頼み、ツールの守り(requires)が止める。受け取った記録は「まだありません」のまま
export async function askToSave(page, { pace = 0 } = {}) {
  const { app, items } = talkOf(page);
  await say(page, SCENE_TEXT.save, pace);
  await expect(items.last()).toContainText('記録「consent」がありません');
  await expect(app.getByRole('region', { name: '受け取った記録' })).toContainText('まだありません');
  await pause(page, 2000, pace);
}

// 作る AI の欄に依頼を書く(送らない)
export async function writeFixRequest(page) {
  await closeMore(page);
  const request = page.getByLabel('依頼');
  await expect(request).toBeEnabled();
  await request.fill(SCENE_TEXT.fixRequest);
  await expect(request).toHaveValue(SCENE_TEXT.fixRequest);
}

// 要素を、仕組みの引き出しの中で見える所まで動かす。引き出しの上の見出しは動かないので、その下に来るようにする。
// 実行の記録の一覧のように、引き出しの中で別に動く欄があれば、その欄を引き出しの上に寄せ、欄の中で要素を動かす。
// block は 'start'(上に寄せる)か 'center'(真ん中)。pace が 0 より大きければ、滑らかに動かして待つ
export async function scrollDrawerTo(locator, { pace = 0, block = 'start' } = {}) {
  const page = locator.page();
  // 引き出しを開いた後は、中の欄が順に描かれて高さが変わる。高さが落ち着いてから動かす
  let last = -1;
  await expect
    .poll(async () => {
      const height = await page.locator('#mechanism').evaluate((panel) => panel.scrollHeight);
      const stable = height === last;
      last = height;
      return stable;
    }, { intervals: [150] })
    .toBe(true);
  await expect(async () => {
    await locator.evaluate(scrollInDrawer, { block, smooth: pace > 0 });
    await pause(page, 900, pace);
    await expect(locator).toBeInViewport({ timeout: 1000 });
  }).toPass({ timeout: 10_000 });
}

// scrollDrawerTo の中身。ブラウザの中で動く
function scrollInDrawer(el, { block, smooth }) {
  const behavior = smooth ? 'smooth' : 'instant';
  const panel = document.getElementById('mechanism');
  const head = panel.querySelector('.drawer-head');
  const offset = (target, top, height) => {
    const rect = target.getBoundingClientRect();
    const start = rect.top - top - 8;
    return block === 'center' ? start - (height - rect.height) / 2 + 8 : start;
  };
  let target = el;
  for (let node = el.parentElement; node && node !== panel; node = node.parentElement) {
    const overflow = getComputedStyle(node).overflowY;
    if ((overflow === 'auto' || overflow === 'scroll') && node.scrollHeight > node.clientHeight) {
      node.scrollBy({ top: offset(target, node.getBoundingClientRect().top, node.clientHeight), behavior });
      target = node;
      // 欄は引き出しの上に寄せる
      block = 'start';
    }
  }
  const top = panel.getBoundingClientRect().top + head.offsetHeight;
  panel.scrollBy({ top: offset(target, top, panel.clientHeight - head.offsetHeight), behavior });
}

// 仕組みの引き出しを開く。pace が 0 より大きければ、押した後に間を置く
async function openDevDetailsPaced(page, pace) {
  if (pace === 0) return openDevDetails(page);
  await openMechanism(page);
  await pause(page, 600, pace);
  await expect(page.locator('#build-status')).toBeVisible();
  await pause(page, 400, pace);
}

// 仕組みの引き出しの「構成と前提」を出す
export async function showSimChoice(page) {
  await openDevDetails(page);
  const choice = page.getByRole('region', { name: '構成と前提' });
  await expect(choice.getByRole('group', { name: '構成を選ぶ' }).getByRole('radio')).toHaveCount(4);
  await expect(choice.getByRole('group', { name: '前提を選ぶ' }).getByRole('radio')).toHaveCount(2);
  await scrollDrawerTo(choice);
  return choice;
}

// 仕組みの引き出しの「AI の実行の記録」で、保存を止めたターンの中身を開き、ツールの呼び出しを見せる。
// 返す部品は、分解の絵の層(docs/brand.md の 4 節)に使う
export async function showSimTrace(page, { pace = 0 } = {}) {
  await openDevDetailsPaced(page, pace);
  const trace = page.locator('#ai-trace');
  const entry = trace.getByRole('list', { name: 'AI の実行の記録' }).locator(':scope > li').first();
  await expect(entry).toContainText(`発言: ${SCENE_TEXT.save}`);
  await scrollDrawerTo(entry, { pace });
  const summary = entry.getByText('模擬の会話の中身: 参加者、ツール、守り(開発向け)');
  await summary.click();
  const steps = entry.getByRole('list', { name: '模擬の会話の段' }).locator(':scope > li');
  const agent = steps.filter({ hasText: '参加者 そよかぜの案内役(模擬)(partner)(模擬のエージェント)' });
  const tool = steps.filter({ hasText: 'ツール save_wish' });
  const blocked = tool.getByRole('list', { name: '守りの層と判定' }).locator('li[data-effect="blocked"]');
  await expect(agent).toContainText('枠 ours-guide(持ち主 ours、');
  await expect(tool).toContainText('引数: {"area":"みなと町"}');
  await expect(blocked).toHaveText('ツールの守り「requires」: 止めた、持ち主 ours、理由 記録「consent」がありません');
  await pause(page, 600, pace);
  return { trace, entry, summary, agent, tool, blocked };
}

// AI 構成の審査の場面(docs/design/ai-architecture-review.md)。見本には設計がないので、架空の題材のプロジェクトを API で作り、
// 目的を決め、設計の 6 段をお試しの AI の案で選び、固定の流れで審査に進む。2 つを承認したところで止める(作る AI は起動しない)
export const REVIEW_SCENE = {
  sentence: '架空の町の図書館で、本の取り置きの問い合わせに AI が答えられるようにしたい',
  doc: { who: '図書館の利用者(架空)', problem: '取り置きの問い合わせに何度も答えている', scene: '開館前の問い合わせ', success: '電話が減る', notDoing: ['貸し出しの手続き'], undecided: [] },
  steps: ['problem', 'users', 'scenes', 'data', 'composition', 'screens'],
  composition: 'fixed-flow',
  approved: ['エージェントの構成', 'harness'],
};

async function reviewProject(studio) {
  const { sentence, doc, steps, composition } = REVIEW_SCENE;
  const ok = (result) => {
    expect(result.status, result.text).toBe(200);
    return JSON.parse(result.text);
  };
  const { id } = ok(await studio.post('/api/projects', { sentence, guide: 'fixed' })).project;
  ok(await studio.post(`/api/projects/${id}/intent/start`, { sentence, guide: 'fixed', depth: 'quick' }));
  ok(await studio.post(`/api/projects/${id}/intent/decide`, { doc }));
  ok(await studio.post(`/api/projects/${id}/design/start`, { guide: 'ai' }));
  for (const step of steps) {
    const { design } = await studio.api(`/api/projects/${id}/design`);
    const options = design.steps.find((item) => item.id === step).options;
    const option = step === 'composition' ? composition : (options.find((item) => item.recommended) ?? options[0]).id;
    ok(await studio.post(`/api/projects/${id}/design/choose`, { step, option }));
  }
  ok(await studio.post(`/api/projects/${id}/design/go`, { step: 'screens' }));
  ok(await studio.post(`/api/projects/${id}/design/decide`));
  return id;
}

// 審査の画面を開き、上の 2 つを承認する。返すのは審査の欄
export async function showReview(page, studio) {
  const id = await reviewProject(studio);
  await page.goto(studio.url);
  await page.locator('#project-menu-button').click();
  await page.locator(`[data-project-id="${id}"]`).click();
  const mark = page.locator('#review-mark');
  await expect(mark).toHaveText('審査: 承認 0 / 4');
  await mark.click();
  const review = page.locator('#review');
  await expect(review).toBeVisible();
  // 承認は次の一手の帯で、読んでいる欄から順に押す(英字で終わる名前の後ろには空白)
  const band = page.getByRole('region', { name: '次の一手' });
  for (const label of REVIEW_SCENE.approved) await band.getByRole('button', { name: `${label}${/[A-Za-z]$/.test(label) ? ' ' : ''}を承認する` }).click();
  await expect(page.locator('#review-count')).toHaveText(`承認 ${REVIEW_SCENE.approved.length} / 4・あと ${4 - REVIEW_SCENE.approved.length} つ`);
  await page.locator('#review-heading').evaluate((el) => el.scrollIntoView({ block: 'start', behavior: 'instant' }));
  return review;
}

// 撮る範囲(clip。画面の座標)に描かれた文字だけを返す。範囲の外の文字(審査の案の日付など)は撮らないので数えない
export async function textInClip(page, clip) {
  return page.evaluate(({ x, y, width, height }) => {
    const texts = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const range = document.createRange();
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!node.textContent.trim() || !node.parentElement?.checkVisibility()) continue;
      range.selectNodeContents(node);
      const hit = [...range.getClientRects()].some((r) => r.width > 0 && r.right > x && r.left < x + width && r.bottom > y && r.top < y + height);
      if (hit) texts.push(node.textContent);
    }
    return texts.join('\n');
  }, clip);
}

// 撮る範囲の文字に、日付、作業ディレクトリ、メールアドレスがない
export async function expectNoLeaksInClip(page, clip, where, home) {
  const leaks = findLeaks(await textInClip(page, clip), { paths: defaultPaths([home, ROOT]) });
  expect(leaks, describeLeaks(where, leaks)).toEqual([]);
}

// 審査の画面のうち、撮る範囲。上の帯から、流れ図まで(図の下の案の文には、案を出した日付が入るので撮らない)
export async function reviewClip(page) {
  const diagram = page.getByRole('figure', { name: 'この試作品の中で、1 回の問い合わせが流れる道' });
  await expect(diagram).toBeInViewport();
  // 欄の一覧の下までを撮る(一覧の下の案の日付は撮らない)
  const box = await page.locator('#review-items').boundingBox();
  const viewport = page.viewportSize();
  return { x: 0, y: 0, width: viewport.width, height: Math.min(viewport.height, Math.ceil(box.y + box.height + 8)) };
}

// 段 7「質」の右の列の「質の見直し」を開いて、見える所まで動かす
export async function showQuality(page) {
  await closeMore(page);
  await goStage(page, '質');
  const box = page.locator('#quality');
  await expect(page.locator('#quality-summary')).toContainText('質の見直し(直す ');
  if (!(await box.evaluate((el) => el.open))) await page.locator('#quality-summary').click();
  const table = box.getByRole('table', { name: '質の見直し: 測ったもの' });
  await expect(table).toBeVisible();
  // 画面を確かめる(観察器が試作品を開く)。確かめた後は、アクセシビリティの行が「まだ見ていない」でなくなる
  await box.getByRole('button', { name: '画面を確かめて見直す' }).click();
  const a11y = table.locator('tbody tr').filter({ has: page.getByRole('rowheader', { name: 'アクセシビリティの違反' }) });
  await expect(a11y.locator('td').first()).not.toHaveText(/^まだ見ていない/, { timeout: 60_000 });
  await page.locator('#quality-summary').evaluate((el) => el.scrollIntoView({ block: 'start', behavior: 'instant' }));
  return { box, table };
}
