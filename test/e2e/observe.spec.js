import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../../src/server/config.js';
import { startStudio } from '../../src/server/index.js';
import { expect, ROOT, test } from './studio.js';

// 観察器は Studio の画面を開かずに使う。このファイルのテストは page(Studio の画面)を開かない。
const FIXTURES = path.join(ROOT, 'test', 'fixtures', 'observe');
const NAMES = ['ok', 'build-error', 'render-error', 'console-error', 'infinite-loop', 'late-loop', 'navigate', 'unhandled-rejection', 'ai', 'ai-fresh'];

let home;
let studio;

// PNG の幅と高さ(IHDR)
async function pngSize(file) {
  const buffer = await fs.readFile(file);
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'prototype-studio-observe-'));
  for (const name of NAMES) {
    const root = path.join(home, 'projects', `obs-${name}`);
    await fs.cp(path.join(FIXTURES, name), path.join(root, 'app'), { recursive: true });
    await fs.mkdir(path.join(root, '.studio'), { recursive: true });
    await fs.writeFile(path.join(root, '.studio', 'project.json'), JSON.stringify({ title: `観察の見本: ${name}` }));
  }
  const config = loadConfig({ STUDIO_HOME: home, STUDIO_PORT: '0', STUDIO_PREVIEW_PORT: '0', STUDIO_NO_OPEN: '1' });
  studio = await startStudio(config, { env: {} });
});

test.afterAll(async () => {
  await studio?.close();
  if (home) await fs.rm(home, { recursive: true, force: true });
});

test('正常な見本は passed になり、読み込みの時間と、指定した画面幅のスクリーンショットを返す', async () => {
  const report = await studio.observe('obs-ok', { viewports: ['mobile', 'desktop'] });

  expect(report.format).toBe('prototype-studio-observation');
  expect(report.formatVersion).toBe(1);
  expect(report.verdict).toBe('passed');
  expect(report.errors).toEqual([]);
  expect(report.buildId).toMatch(/^[a-f0-9]{32}$/);
  expect(report.appDigest).toMatch(/^[a-f0-9]{64}$/);
  expect(report.browser.name).toBe('chromium');
  expect(report.browser.version).toMatch(/^\d+\./);
  expect(report.load.done).toBe(true);
  expect(report.load.durationMs).toBeGreaterThanOrEqual(0);
  expect(report.load.timeoutMs).toBe(15_000);
  expect(report).toMatchObject({ ai: [], scenarios: [], page: null });

  // 指定した 2 つだけ。tablet は撮らない
  expect(report.screenshots.map((s) => s.viewport)).toEqual(['mobile', 'desktop']);
  const observations = path.join(home, 'projects', 'obs-ok', '.studio', 'observations');
  for (const shot of report.screenshots) {
    expect(path.dirname(path.dirname(shot.file))).toBe(observations);
    expect(await pngSize(shot.file)).toEqual({ width: shot.width, height: shot.height });
  }
  expect(report.screenshots[0]).toMatchObject({ width: 390, height: 844 });
  expect(report.screenshots[1]).toMatchObject({ width: 1280, height: 800 });
});

test('ビルドの失敗は、ブラウザを開かずに build のエラーと failed を返す', async () => {
  const report = await studio.observe('obs-build-error');
  expect(report.verdict).toBe('failed');
  expect(report.buildId).toBeNull();
  expect(report.errors).toHaveLength(1);
  expect(report.errors[0]).toMatchObject({ kind: 'build', file: 'app/main.jsx', line: 2 });
  expect(report.screenshots).toEqual([]);
});

test('描画中の例外は runtime のエラーになり、failed を返す', async () => {
  const report = await studio.observe('obs-render-error');
  expect(report.verdict).toBe('failed');
  expect(report.load.done).toBe(true);
  const error = report.errors.find((e) => e.kind === 'runtime');
  expect(error.message).toContain('架空の在庫表が読めません');
  expect(error.stack).toContain('App');
});

test('console.error は console-error のエラーになり、failed を返す', async () => {
  const report = await studio.observe('obs-console-error');
  expect(report.verdict).toBe('failed');
  expect(report.errors).toEqual([
    expect.objectContaining({ kind: 'console-error', message: '架空の予約の一覧を取り込めませんでした' }),
  ]);
});

test('処理されない reject は unhandled-rejection のエラーになり、failed を返す', async () => {
  const report = await studio.observe('obs-unhandled-rejection');
  expect(report.verdict).toBe('failed');
  expect(report.errors).toEqual([
    expect.objectContaining({ kind: 'unhandled-rejection', message: '架空の天気の取り込みに失敗しました' }),
  ]);
});

test('無限ループは読み込みの時間切れのエラーになり、failed を返す。次の観察は回る', async () => {
  const report = await studio.observe('obs-infinite-loop', { limits: { loadTimeoutMs: 3_000 } });
  expect(report.verdict).toBe('failed');
  expect(report.load).toMatchObject({ done: false, durationMs: null, timeoutMs: 3_000 });
  expect(report.errors).toEqual([expect.objectContaining({ kind: 'timeout', message: expect.stringContaining('3 秒') })]);
  expect(report.screenshots).toEqual([]);

  // 止まった試作品の文脈は閉じてある。同じブラウザで次の観察が回る
  const next = await studio.observe('obs-ok', { viewports: [] });
  expect(next.verdict).toBe('passed');
});

test('読み込みの後に止まる試作品も、時間切れのエラーと failed を返す。観察そのものは止まらない', async () => {
  const report = await studio.observe('obs-late-loop', { viewports: ['mobile', 'desktop'] });
  expect(report.verdict).toBe('failed');
  expect(report.load.done).toBe(true);
  expect(report.errors).toEqual([expect.objectContaining({ kind: 'timeout', message: expect.stringContaining('mobile の画面を撮れませんでした') })]);
  expect(report.screenshots).toEqual([]);
  expect(report.durationMs).toBeLessThan(15_000);

  const next = await studio.observe('obs-ok', { viewports: [] });
  expect(next.verdict).toBe('passed');
});

test('読み込みの途中で別のページへ移る試作品は、runtime がないので passed にしない', async () => {
  const report = await studio.observe('obs-navigate', { viewports: [], limits: { loadTimeoutMs: 2_000 } });
  expect(report.verdict).toBe('failed');
  expect(report.load.done).toBe(false);
  expect(report.errors).toEqual([expect.objectContaining({ kind: 'runtime', message: expect.stringContaining('別のページへ移動しました') })]);
});

test('観察の間にビルドが作り直されて開けなければ、unverified と理由を返す(通ったとは返さない)', async () => {
  // 古いビルドの ID。プレビューの配信は表示中のビルドしか返さない(404)
  const stale = 'f'.repeat(32);
  const report = await studio.observer.observe({
    build: {
      result: { ok: true, buildId: stale, errors: [] },
      previewUrl: `http://localhost:${studio.ports.preview}/p/obs-ok/${stale}/`,
      hostUrl: `http://127.0.0.1:${studio.ports.studio}/observe.html`,
    },
    viewports: [],
    limits: { loadTimeoutMs: 2_000 },
  });
  expect(report.verdict).toBe('unverified');
  expect(report.reason).toContain('404');
  expect(report.reason).toContain('もう一度観察してください');
});

test('試作品からの AI の要求は、親ページから呼ぶ側の ai 関数に渡る。iframe から直接は呼べない', async () => {
  const requests = [];
  const ai = async (request) => {
    requests.push(request);
    return { messages: [{ role: 'assistant', text: '架空の駅の東口に 20 台分あります' }] };
  };
  const report = await studio.observe('obs-ai', { ai, viewports: [] });
  expect(requests).toEqual([{ op: 'send', text: '架空の駅前の自転車置き場を探しています' }]);
  // 試作品は返事を受け取った(受け取れなければ console.error を出す)。試作品が直接呼んだ偽のエラーは入らない
  expect(report.errors).toEqual([]);
  expect(report.verdict).toBe('passed');

  // ai 関数を渡さなければ、要求は断られ、試作品はその理由を受け取る
  const without = await studio.observe('obs-ai', { viewports: [] });
  expect(without.verdict).toBe('failed');
  expect(without.errors).toEqual([
    expect.objectContaining({ kind: 'console-error', message: 'AI の返事を受け取れませんでした: この観察では AI を使えません' }),
  ]);
});

test('ブラウザは 1 つを使い回し、同時に頼まれた観察もそれぞれの結果を返す', async () => {
  const first = await studio.observe('obs-ok', { viewports: [] });
  const browser = studio.observer.browser.browser;
  expect(browser).not.toBeNull();
  const [a, b] = await Promise.all([
    studio.observe('obs-ok', { viewports: [] }),
    studio.observe('obs-console-error', { viewports: [] }),
  ]);
  expect([first.verdict, a.verdict, b.verdict]).toEqual(['passed', 'passed', 'failed']);
  expect(studio.observer.browser.browser).toBe(browser);
});

test('見本の求人相談を観察すると、report の ai にあいさつのやり取りが入る。観察の会話は終わると消え、利用者の会話は変わらない', async () => {
  const id = 'sample-job-consult';
  // 利用者が試す画面で話している途中
  await studio.aiSessions.send(id, 'しおかぜ町でカフェのアルバイトを探しています');
  const before = studio.aiSessions.view(id);

  const report = await studio.observe(id, { aiConnection: 'mock', viewports: [] });
  expect(report.verdict).toBe('passed');
  expect(report.errors).toEqual([]);
  const [open, ...rest] = report.ai;
  expect(rest).toEqual([]);
  expect(open).toMatchObject({
    type: 'open',
    from: 'prototype',
    status: 'ok',
    observation: expect.stringMatching(/^observation-/),
    connection: { kind: 'mock', label: 'モック', real: false },
    greeting: expect.stringContaining('しおかぜ求人相談の案内役です'),
  });
  expect(open.state.map((s) => s.value)).toEqual(['未定', '未定', '未定', '未定']);

  // 観察の会話は消え、記録には「観察から」の印で残る
  expect(studio.aiSessions.conversations(id)).toEqual(['user']);
  const recorded = studio.aiSessions.trace(id).entries.find((entry) => entry.observation === open.observation);
  expect(recorded).toMatchObject({ type: 'open', greeting: open.greeting });
  expect(studio.aiSessions.view(id)).toEqual(before);
});

test('続けて 2 回観察しても、前の観察の会話とブラウザの状態(Cookie、localStorage)が残らない', async () => {
  const browser = studio.observer.browser;
  const original = browser.withContext;
  const seen = [];
  // 観察の終わり(文脈を閉じる前)に、その文脈の Cookie と localStorage を調べてから、次の観察に残りそうなものを置く
  browser.withContext = (options, work) =>
    original.call(browser, options, async (context, launched) => {
      const result = await work(context, launched);
      const [page] = context.pages();
      seen.push({ context, cookies: await context.cookies(), storage: await page.evaluate(() => localStorage.length) });
      await context.addCookies([
        { name: 'left', value: '1', url: `http://127.0.0.1:${studio.ports.studio}` },
        { name: 'left', value: '1', url: `http://localhost:${studio.ports.preview}` },
      ]);
      await page.evaluate(() => localStorage.setItem('left', '1'));
      expect(await context.cookies()).toHaveLength(2);
      return result;
    });
  try {
    const first = await studio.observe('obs-ai-fresh', { aiConnection: 'mock', viewports: [] });
    const second = await studio.observe('obs-ai-fresh', { aiConnection: 'mock', viewports: [] });

    // どちらの観察も、あいさつだけの新しい会話から始まった(残っていれば試作品が console.error を出す)
    for (const report of [first, second]) {
      expect(report.errors).toEqual([]);
      expect(report.verdict).toBe('passed');
      expect(report.ai.map((entry) => [entry.type, entry.text ?? null])).toEqual([
        ['open', null],
        ['reply', 'つるの植木を探しています'],
      ]);
      expect(report.ai[1].changes).toEqual([{ key: 'plant', label: '植木', from: '未定', to: '架空のつる草' }]);
    }
    expect(second.ai[0].observation).not.toBe(first.ai[0].observation);

    // 2 回目は新しい文脈。1 回目に置いた Cookie と localStorage はない
    expect(seen).toHaveLength(2);
    expect(seen[1].context).not.toBe(seen[0].context);
    expect(seen.map(({ cookies, storage }) => [cookies, storage])).toEqual([
      [[], 0],
      [[], 0],
    ]);
    expect(studio.aiSessions.conversations('obs-ai-fresh')).toEqual([]);
  } finally {
    browser.withContext = original;
  }
});
