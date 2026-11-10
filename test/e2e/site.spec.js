import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { startSite } from '../../scripts/site.js';
import { ROOT } from './studio.js';

// LP(site/、npm run site)を、見る人の側から確かめる。Studio は起動しない。
// ページが開く、ボタンとリンクの先がある、スクロールで層の番号が進む、prefers-reduced-motion で動かない、
// スマホの幅で横にはみ出さない、外への通信がない

const REPO = 'https://github.com/jyoka/agent-prototype-studio';
const JA = '思いつきを AI プロダクトにすると、どんな作りになるか。動かして測り、人が承認してから作る。';
const EN = 'See how your idea works as an AI product, test it, and approve the architecture before you build.';
const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };
// 日本語と英語の両方を書いてあるので、文は見えている方(innerText)で比べる
const SHOWN = { useInnerText: true };

let site;
test.beforeAll(async () => {
  site = await startSite({ port: 0 });
});
test.afterAll(async () => {
  await site?.stop();
});

// ページの外への通信を集める。同じ origin のものは、失敗(400 以上)を集める。
// CSP が外への読み込みを止めたときは通信にならず、コンソールのエラーになるので、それも集める
function watchRequests(page) {
  const outside = [];
  const failed = [];
  page.on('request', (request) => {
    if (!request.url().startsWith(site.url)) outside.push(request.url());
  });
  page.on('response', (response) => {
    if (response.status() >= 400) failed.push(`${response.status()} ${response.url()}`);
  });
  page.on('requestfailed', (request) => failed.push(`失敗 ${request.url()}`));
  page.on('console', (message) => {
    if (message.type() === 'error') failed.push(`コンソール ${message.text()}`);
  });
  page.on('pageerror', (error) => failed.push(`例外 ${error.message}`));
  return { outside, failed };
}

// 層の動きの区間(.layers-track)の中の、割合 fraction の位置まで、一気にスクロールする
async function scrollTrack(page, fraction) {
  await page.evaluate((f) => {
    const track = document.querySelector('.layers-track');
    const top = track.getBoundingClientRect().top + scrollY;
    scrollTo({ top: top + (track.offsetHeight - innerHeight) * f, behavior: 'instant' });
  }, fraction);
}

// ページの上から下まで、画面の高さの半分ずつスクロールし、各位置で fn を呼ぶ
async function scrollThrough(page, fn) {
  const height = await page.evaluate(() => document.documentElement.scrollHeight);
  const step = Math.floor((page.viewportSize().height) / 2);
  for (let y = 0; y <= height; y += step) {
    await page.evaluate((top) => scrollTo({ top, behavior: 'instant' }), y);
    await fn(y);
  }
}

// GitHub の見出しの id(アンカー)。句読点を消し、空白を - にする
function slug(heading) {
  return heading.trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-');
}

// GitHub のリポジトリを指す URL が、リポジトリの中のファイルと見出しを指しているかを確かめる
async function expectRepoTarget(url) {
  const parsed = new URL(url);
  const rest = decodeURIComponent(parsed.pathname).replace(/^\/jyoka\/agent-prototype-studio/, '');
  const file = rest === '' || rest === '/' ? 'README.md' : rest.replace(/^\/blob\/main\//, '');
  expect(rest === '' || rest === '/' || rest.startsWith('/blob/main/'), url).toBe(true);
  const text = await fs.readFile(path.join(ROOT, file), 'utf8');
  const anchor = decodeURIComponent(parsed.hash.slice(1));
  if (!anchor || (anchor === 'readme' && file === 'README.md')) return;
  const ids = [...text.matchAll(/^#{1,6}\s+(.+)$/gm)].map((m) => slug(m[1]));
  expect(ids, `${url} の見出し`).toContain(anchor);
}

test.describe('LP', () => {
  test('ページが開き、名前と 1 文と 3 つのボタンが出る。外への通信がなく、絵はどれも読める', async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    const { outside, failed } = watchRequests(page);
    await page.goto(site.url);

    await expect(page.locator('h1')).toHaveText('Prototype Studio', SHOWN);
    await expect(page.locator('#sentence')).toHaveText(JA, SHOWN);
    await expect(page.locator('.foot-line')).toHaveText(JA, SHOWN);
    const actions = page.locator('.hero-actions a');
    await expect(actions).toHaveText(['始める', '動きを見る', 'GitHub'], SHOWN);

    // 下まで見て、遅れて読む絵も読ませる。言葉と見た目も切り替える(切り替えた先の絵も読む)
    await scrollThrough(page, async () => {});
    await page.locator('#lang-toggle').click();
    await page.locator('#theme-toggle').click();
    await scrollThrough(page, async () => {});

    // 見えている絵は、どれも読み終わって中身がある(遅れて読む絵は、読み終わるまで待つ)
    await expect
      .poll(() =>
        page.evaluate(() =>
          [...document.images].filter((img) => img.checkVisibility() && !(img.complete && img.naturalWidth > 0)).map((img) => img.src),
        ),
      )
      .toEqual([]);
    expect(outside).toEqual([]);
    expect(failed).toEqual([]);
  });

  test('ボタンとリンクの先がある。手元のものは配られ、GitHub のものはリポジトリの中のファイルと見出しを指す', async ({ page, request }) => {
    await page.goto(site.url);
    const buttons = Object.fromEntries(
      await page.locator('.hero-actions a').evaluateAll((links) => links.map((a) => [a.dataset.cta, a.href])),
    );
    // 始める = README の「はじめる」、動きを見る = 動く画像、GitHub = リポジトリ
    expect(decodeURIComponent(buttons.start)).toBe(`${REPO}#はじめる`);
    expect(buttons.demo).toBe(`${site.url}assets/media/talk-guard.webm`);
    expect(buttons.github).toBe(REPO);
    const demo = await request.get(buttons.demo);
    expect(demo.status()).toBe(200);
    expect(demo.headers()['content-type']).toBe('video/webm');

    // 機能のカード 14 枚と見出しの絵 1 枚は、押すと docs に飛ぶ
    const shots = await page.locator('.card-shot, .hero-shot').evaluateAll((links) => links.map((a) => a.href));
    expect(shots).toHaveLength(15);
    for (const href of shots) expect(href.startsWith(`${REPO}/blob/main/docs/`), href).toBe(true);

    const hrefs = await page.locator('a[href]').evaluateAll((links) => links.map((a) => a.href));
    const llms = await (await request.get(`${site.url}llms.txt`)).text();
    hrefs.push(...[...llms.matchAll(/\]\((https?:[^)]+)\)/g)].map((m) => m[1]));
    for (const href of new Set(hrefs)) {
      if (href.startsWith(site.url)) {
        const url = new URL(href);
        if (url.pathname === '/' && url.hash) {
          // ページの中の行き先
          await expect(page.locator(url.hash), href).toHaveCount(1);
        } else {
          expect((await request.get(href)).status(), href).toBe(200);
        }
      } else {
        // 外へのリンクは、このリポジトリだけ
        expect(href === REPO || href.startsWith(`${REPO}/`) || href.startsWith(`${REPO}#`), href).toBe(true);
        await expectRepoTarget(href);
      }
    }
  });

  for (const viewport of [DESKTOP, PHONE]) {
    test(`スクロールで層の番号が 01 から 07 へ進み、ガードレールで止めた印が光り、最後に人が承認する審査に届く(幅 ${viewport.width})`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await page.goto(site.url);
      await expect(page.locator('html')).toHaveClass(/\bmotion\b/);
      const now = page.locator('.layer-now');
      const stage = page.locator('.layers-stage');

      await scrollTrack(page, 0);
      await expect(now).toHaveText('01', SHOWN);
      await expect(page.locator('.layer-text .layer-name')).toHaveText('トークの画面', SHOWN);
      await expect(stage).not.toHaveClass(/is-stopped/);
      const flat = await page.locator('.layers-stack').evaluate((el) => getComputedStyle(el).transform);

      // 層ごとの区間の真ん中へ進む。番号は 1 つずつ進む
      const seen = [];
      for (let i = 0; i < 7; i += 1) {
        await scrollTrack(page, 0.1 + (0.9 * (i + 0.5)) / 7);
        const number = String(i + 1).padStart(2, '0');
        await expect(now).toHaveText(number, SHOWN);
        await expect(page.locator(`.layer[data-layer="${i + 1}"]`)).toHaveClass(/is-active/);
        seen.push(number);
        if (i === 4) {
          await expect(page.locator('.layer-text .layer-name')).toHaveText('ガードレール', SHOWN);
          await expect(stage).toHaveClass(/is-stopped/);
          await expect(page.locator('.layer-guard .stop-mark')).toHaveCSS('opacity', '1');
        }
        if (i === 6) await expect(page.locator('.layer-text .layer-name')).toHaveText('AI 構成の審査', SHOWN);
      }
      expect(seen).toEqual(['01', '02', '03', '04', '05', '06', '07']);
      // 層が離れて、3D の変形がかかっている
      const split = await page.locator('.layers-stack').evaluate((el) => getComputedStyle(el).transform);
      expect(split).not.toBe(flat);
      expect(split).toMatch(/^matrix3d\(/);

      // 戻ると番号も戻る
      await scrollTrack(page, 0);
      await expect(now).toHaveText('01', SHOWN);
      await expect(stage).not.toHaveClass(/is-stopped/);
    });
  }

  test('prefers-reduced-motion のときは動かさず、7 つの層を止まった絵で並べる', async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(site.url);
    await expect(page.locator('html')).not.toHaveClass(/\bmotion\b/);

    const layers = page.locator('.layer');
    await expect(layers).toHaveCount(7);
    await expect(page.locator('.layer .layer-num')).toHaveText(['01 / 07', '02 / 07', '03 / 07', '04 / 07', '05 / 07', '06 / 07', '07 / 07'], SHOWN);
    // 止めた層は、止まった絵でも印が出る
    await expect(page.locator('.layer-guard .stop-mark')).toBeVisible();
    await expect(page.locator('.layers-readout')).toBeHidden();

    const transforms = () =>
      page.evaluate(() => ({
        stack: getComputedStyle(document.querySelector('.layers-stack')).transform,
        layers: [...document.querySelectorAll('.layer')].map((el) => getComputedStyle(el).transform),
        stage: getComputedStyle(document.querySelector('.layers-stage')).position,
        animations: document.getAnimations().length,
      }));
    const before = await transforms();
    expect(before).toEqual({ stack: 'none', layers: Array(7).fill('none'), stage: 'static', animations: 0 });

    // 層をスクロールで通っても、何も変わらない
    await page.locator('#layers').scrollIntoViewIfNeeded();
    for (const layer of await layers.all()) {
      await layer.scrollIntoViewIfNeeded();
      await expect(layer.locator('figcaption')).toBeVisible();
      await expect(layer.locator('img').first()).toBeVisible();
    }
    expect(await transforms()).toEqual(before);
    // 区間は長くならない(スクロールを動きに使わない)
    const trackHeight = await page.locator('.layers-track').evaluate((el) => el.offsetHeight);
    expect(trackHeight).toBeLessThan(DESKTOP.height * 3);
  });

  test('見ている途中で prefers-reduced-motion に変わったら、止まった絵に変わる。背の低い画面(横にしたスマホ)でも動かさない', async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await page.goto(site.url);
    await scrollTrack(page, 0.7);
    await expect(page.locator('.layer-now')).toHaveText('05', SHOWN);
    await expect(page.locator('html')).toHaveClass(/\bmotion\b/);

    await page.emulateMedia({ reducedMotion: 'reduce' });
    await expect(page.locator('html')).not.toHaveClass(/\bmotion\b/);
    const state = await page.evaluate(() => ({
      stack: getComputedStyle(document.querySelector('.layers-stack')).transform,
      active: document.querySelectorAll('.layer.is-active').length,
      stopped: document.querySelector('.layers-stage').classList.contains('is-stopped'),
    }));
    expect(state).toEqual({ stack: 'none', active: 0, stopped: false });

    // 戻すと、また動く
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await expect(page.locator('html')).toHaveClass(/\bmotion\b/);

    // 横にしたスマホ(844 × 390)では、層と説明が 1 画面に収まらないので動かさない
    await page.setViewportSize({ width: 844, height: 390 });
    await expect(page.locator('html')).not.toHaveClass(/\bmotion\b/);
    await expect(page.locator('.layer-guard .stop-mark')).toBeAttached();
  });

  for (const reducedMotion of ['no-preference', 'reduce']) {
    test(`スマホの幅(390 と 320)で横にはみ出さない(reducedMotion: ${reducedMotion}、日本語と英語)`, async ({ page }) => {
      await page.emulateMedia({ reducedMotion });
      for (const viewport of [PHONE, { width: 320, height: 640 }]) {
        await page.setViewportSize(viewport);
        await page.goto(site.url);
        for (const lang of ['ja', 'en']) {
          if (lang === 'en') await page.locator('#lang-toggle').click();
          await expect(page.locator('html')).toHaveAttribute('lang', lang);
          await scrollThrough(page, async (y) => {
            const width = await page.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth));
            expect(width, `幅 ${viewport.width}、${lang} の ${y} px の位置`).toBeLessThanOrEqual(viewport.width);
          });
        }
        await page.evaluate(() => localStorage.clear());
      }
    });
  }

  test('今できることと作っているものが分かれて出る。作っていたものは今できることに畳み、まだできないものだけが残る。作っているものには絵も押す先もない', async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await page.goto(site.url);

    await expect(page.locator('#features h2')).toHaveText('今できること', SHOWN);
    await expect(page.locator('#building h2')).toHaveText('作っているもの', SHOWN);
    // 作っていたもの(審査、データの棚、質の見直し、人に見せる、みんなで作る)は、今できることのカードに畳んだ(jyoka/tasks#394)
    const cards = page.locator('#features .card h3');
    await expect(cards).toHaveText(
      ['目的の聞き出し', 'ヒアリングの整理', '設計の案内', 'AI 構成の審査', 'データの棚と RAG の判定', '構成の模擬', '守りの層', '場面の比較', '質の見直し', '言葉で直す欄', '人に見せる', 'みんなで作る', '版と引き継ぎ', '作るループの関門'],
      SHOWN,
    );
    // 審査と質の見直しのカードは、本物の画面の絵を持つ
    for (const name of ['AI 構成の審査', '質の見直し']) {
      const card = page.locator('#features .card').filter({ has: page.locator('h3', { hasText: name }) });
      await expect(card.locator('img.on-light')).toHaveAttribute('src', /^assets\/media\/(review|quality)-light\.png$/);
    }
    // 今できることでも、人の確かめはまだと言う
    await expect(page.locator('#features .section-head')).toContainText('人の確かめ(初めての人や現場の会で使えるか)は、まだです', SHOWN);

    const building = page.locator('#building .building-item');
    const names = ['人の確かめと現場の通し', '本物の AI で案ごとに測る', 'AI の使いやすさの見直し', '何台もの PC で同時に作る', '部品のコードをつなぐ'];
    await expect(building.locator('h3')).toHaveText(names, SHOWN);
    // どの項目にも「作っている」の印があり、絵と押す先はない(想像図を本物の画面として載せない)
    await expect(page.locator('#building .building-tag')).toHaveText(Array(names.length).fill('作っている'), SHOWN);
    await expect(page.locator('#building img')).toHaveCount(0);
    await expect(page.locator('#building a')).toHaveCount(0);
    // 今できることの方に、作っているものの名前を混ぜない。作っているものに、畳んだ機能の名前を残さない
    for (const name of names) await expect(page.locator('#features')).not.toContainText(name);
    for (const name of ['AI 構成の審査', '3 つの形の比べ', '記録と比べる表を主の画面に', '人に見せる', 'みんなで作る']) {
      await expect(building.locator('h3', { hasText: name })).toHaveCount(0);
    }

    // 見出しの下の文で、人の確かめはまだだと言い、作っているものへ飛べる。見出しの絵は審査の画面
    await expect(page.locator('.hero-text')).toContainText('どれも、人の確かめ(初めての人や現場の会で使えるか)はまだです', SHOWN);
    await expect(page.locator('.hero-shot img.on-light')).toHaveAttribute('src', 'assets/media/review-light.png');
    await page.locator('.hero-text a[href="#building"]:visible').click();
    await expect(page).toHaveURL(/#building$/);

    await page.locator('#lang-toggle').click();
    await expect(page.locator('#features h2')).toHaveText('What it does today', SHOWN);
    await expect(page.locator('#building h2')).toHaveText('In progress', SHOWN);
    await expect(building.first().locator('h3')).toHaveText('Checks with people and a full session', SHOWN);
    await expect(page.locator('.hero-text')).toContainText('None of it has been checked with people yet', SHOWN);
  });

  test('3 つの問いは Studio だけの欄で答え、ほかの道具と比べない。どの答えも、人の確かめはまだと言う', async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await page.goto(site.url);
    const rows = page.locator('.axes tbody tr');
    await expect(page.locator('#questions h2')).toHaveText('3 つの問い', SHOWN);
    await expect(page.locator('.axes tbody th')).toHaveText(['AI の作りを見せるか', '人が承認するか', '測るか'], SHOWN);
    // 列は「問い」と Studio の 2 つだけ。名前を伏せたほかの道具の欄も置かない
    await expect(page.locator('.axes thead th')).toHaveText(['問い', 'Prototype Studio'], SHOWN);
    for (let i = 0; i < 3; i += 1) await expect(rows.nth(i).locator('td')).toHaveCount(1);
    await expect(page.locator('#questions')).not.toContainText(/ほかの道具|一般的な道具|記載なし/, SHOWN);
    await expect(rows.nth(1).locator('td')).toContainText('承認する。', SHOWN);
    for (let i = 0; i < 2; i += 1) await expect(rows.nth(i).locator('td')).toContainText('人の確かめはまだ', SHOWN);
    await page.locator('.bar-nav a[href="#questions"]').click();
    await expect(page).toHaveURL(/#questions$/);

    await page.locator('#lang-toggle').click();
    await expect(page.locator('#questions h2')).toHaveText('Three questions', SHOWN);
    await expect(page.locator('.axes tbody th')).toHaveText(['Does it show the AI architecture?', 'Does a person approve it?', 'Does it measure?'], SHOWN);
    await expect(rows.nth(1).locator('td')).toContainText('Yes.', SHOWN);
    await expect(rows.nth(1).locator('td')).toContainText('not been checked with people yet', SHOWN);
  });

  test('日本語と英語、ダークとライトを切り替えられ、読み込み直しても残る', async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await page.emulateMedia({ colorScheme: 'light' });
    await page.goto(site.url);
    const background = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    expect(await background()).toBe('rgb(246, 246, 244)');
    await expect(page.locator('.hero-shot img.on-light')).toBeVisible();
    await expect(page.locator('.hero-shot img.on-dark')).toBeHidden();

    await page.locator('#lang-toggle').click();
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.locator('#sentence')).toHaveText(EN, SHOWN);
    await expect(page.locator('.hero-actions a')).toHaveText(['Get started', 'Watch it run', 'GitHub'], SHOWN);
    await expect(page.locator('#lang-toggle')).toHaveText('日本語', SHOWN);
    await expect(page).toHaveTitle(`Prototype Studio: ${EN}`);
    await expect(page.locator('.hero-shot img.on-light')).toHaveAttribute('alt', /^The Studio screen/);

    await page.locator('#theme-toggle').click();
    expect(await background()).toBe('rgb(22, 22, 20)');
    await expect(page.locator('.hero-shot img.on-dark')).toBeVisible();
    await expect(page.locator('.hero-shot img.on-light')).toBeHidden();

    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    expect(await background()).toBe('rgb(22, 22, 20)');

    // ?lang=ja が残した言葉より優先する。OS がダークなら、何もしなくてもダーク
    await page.evaluate(() => localStorage.clear());
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto(`${site.url}?lang=ja`);
    await expect(page.locator('#sentence')).toHaveText(JA, SHOWN);
    expect(await background()).toBe('rgb(22, 22, 20)');
  });

  test('配るのは site/ と assets/ だけ。ほかのファイルとリポジトリの外は見せない', async ({ request }) => {
    for (const [url, status] of [
      ['', 200],
      ['llms.txt', 200],
      ['assets/brand/tokens.css', 200],
      ['assets/media/layers/5-guard-dark.png', 200],
      ['README.md', 404],
      ['package.json', 404],
      ['assets/../package.json', 404],
      ['assets/media/%2e%2e/%2e%2e/package.json', 404],
      ['%2e%2e/package.json', 404],
      ['%2e%2e/scripts/site.js', 404],
      // %2f は URL の解釈で .. が消えないので、配る側の守りまで届く
      ['assets/brand/..%2f..%2fsite%2findex.html', 404],
      ['assets/media/..%2f..%2f..%2fscripts%2fsite.js', 404],
      ['..%2fscripts%2fsite.js', 404],
      ['%E0%A4%A', 404],
    ]) {
      expect((await request.get(site.url + url)).status(), url).toBe(status);
    }
    const head = await request.get(site.url);
    expect(head.headers()['x-content-type-options']).toBe('nosniff');
  });

  test('壊れた要求を受けても、LP のサーバーは止まらない', async ({ request }) => {
    const { port } = new URL(site.url);
    const reply = await new Promise((resolve, reject) => {
      const socket = net.connect(Number(port), '127.0.0.1', () => socket.end('GET http://[ HTTP/1.1\r\nHost: x\r\n\r\n'));
      let data = '';
      socket.setTimeout(5_000, () => socket.destroy(new Error('返事がない')));
      socket.on('data', (chunk) => (data += chunk));
      socket.on('end', () => resolve(data));
      socket.on('error', reject);
    });
    expect(reply).toMatch(/^HTTP\/1\.1 4\d\d /);
    expect((await request.get(site.url)).status()).toBe(200);
  });
});
