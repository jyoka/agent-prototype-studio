import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ROOT, expect, launchStudio, test } from '../../test/e2e/studio.js';
import {
  SCENE_VIEWPORT,
  askToSave,
  expectNoLeaks,
  hideDevOnlyMarks,
  openPartTime,
  scrollDrawerTo,
  searchJobs,
  showSimChoice,
  showSimTrace,
  talkOf,
  writeFixRequest,
} from '../../test/e2e/scenes.js';
import { compareTableHtml, dropColumns, readTable } from './compare-table.js';
import { checkFfmpeg, encodeClip, startFrames } from './encode.js';
import { defaultPaths, describeLeaks, findLeaksInBytes } from './privacy.js';

// npm run media: README と LP に使う画像と動く画像を、Studio に自分で撮らせる(CONTRIBUTING.md の「画像と動く画像を撮り直す」)。
// Studio は偽接続(STUDIO_AGENT=fake)、試作品の中の AI はモックで動かす。費用はかからず、文と会話は毎回同じ。
// 撮るたびに、画面の見える文字と書いたファイルに、日付、作業ディレクトリ、メールアドレスがないことを確かめる

const OUT = path.join(ROOT, 'assets', 'media');
const THEMES = ['light', 'dark'];
const MB = 1024 * 1024;
// 大きさの上限。超えたら失敗にする(README と LP が重くならないように)
const LIMITS = { gif: 5 * MB, webm: 2 * MB, png: 1 * MB, layer: 512 * 1024 };
// 動く画像の長さ(秒)。この幅から外れたら、間の置き方を直す
const CLIP_SECONDS = { min: 12, max: 18 };

// 書いたファイルの大きさと中身(メタデータ)を確かめる
async function expectFileOk(file, limit, home) {
  const bytes = await fs.readFile(file);
  expect(bytes.length, `${path.relative(ROOT, file)} が ${Math.round(bytes.length / 1024)} KB で、上限の ${Math.round(limit / 1024)} KB を超えました`).toBeLessThanOrEqual(limit);
  const leaks = findLeaksInBytes(bytes, { paths: defaultPaths([home, ROOT]) });
  expect(leaks, describeLeaks(path.relative(ROOT, file), leaks)).toEqual([]);
}

async function shoot(page, name, home, options = {}) {
  const file = path.join(OUT, name);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await page.screenshot({ path: file, animations: 'disabled', caret: 'hide', ...options });
  await expectFileOk(file, name.startsWith('layers/') ? LIMITS.layer : LIMITS.png, home);
  return file;
}

// 部品をまとめて囲む範囲(画面の座標)。周りに余白を足し、画面の外に出ない。
// 上下の余白は、隣の行の字が入らないように小さくする。左右は、番号の印(1. など)が入るように広くする
async function unionClip(page, locators, { x: padX = 24, y: padY = 3 } = {}) {
  const boxes = [];
  for (const locator of locators) {
    const box = await locator.boundingBox();
    if (!box) throw new Error(`撮る部品が見えません: ${locator}`);
    boxes.push(box);
  }
  const viewport = page.viewportSize();
  const x = Math.max(0, Math.min(...boxes.map((b) => b.x)) - padX);
  const y = Math.max(0, Math.min(...boxes.map((b) => b.y)) - padY);
  const right = Math.min(viewport.width, Math.max(...boxes.map((b) => b.x + b.width)) + padX);
  const bottom = Math.min(viewport.height, Math.max(...boxes.map((b) => b.y + b.height)) + padY);
  return { x, y, width: right - x, height: bottom - y };
}

// 見本のバイト探しを、決まった手順で進める(トークで探し、保存を頼み、ツールの守りが止める)
async function talkScene(page, studio, home) {
  await openPartTime(page, studio);
  await hideDevOnlyMarks(page);
  await searchJobs(page);
  await askToSave(page);
  await expectNoLeaks(page, 'トークの後の画面', home);
}

// 場面を回した比べる表。見本の写しを一時フォルダーに置き、モックで回し(npm run evals)、
// scripts/sim-compare.js で 1 つの表にする。回しの ID と日時は表の外にあるので、絵に入らない
async function compareReport(work) {
  const sample = path.join(ROOT, 'samples', 'part-time');
  const project = path.join(work, 'sample-part-time');
  // 見本を観察したときの .studio/ は写さない
  await fs.cp(sample, project, { recursive: true, filter: (src) => !path.relative(sample, src).split(path.sep).includes('.studio') });
  const env = { ...process.env, STUDIO_HOME: path.join(work, 'home'), STUDIO_AGENT: 'fake' };
  delete env.STUDIO_ALLOW_CLAUDE_CODE;
  const runs = [
    ['--composition', 'composition.json', '--assumptions', 'partner-a,partner-b'],
    ['--composition', 'compositions/b.json,compositions/c.json'],
  ];
  for (const args of runs) {
    const run = spawnSync(process.execPath, ['bin/evals.js', project, ...args], { cwd: ROOT, env, encoding: 'utf8', timeout: 60_000 });
    if (run.status !== 0) throw new Error(`場面の回しが通りませんでした(${run.status ?? run.error?.message}):\n${run.stdout}${run.stderr}`);
  }
  const evals = path.join(project, '.studio', 'evals');
  const results = (await fs.readdir(evals, { recursive: true }))
    .filter((name) => path.basename(name) === 'result.json')
    .map((name) => path.join(evals, name))
    .sort();
  const out = path.join(work, 'report.md');
  const compare = spawnSync(process.execPath, ['scripts/sim-compare.js', ...results, '--out', out], { cwd: ROOT, encoding: 'utf8', timeout: 60_000 });
  if (compare.status !== 0) throw new Error(`比べる表を書けませんでした(${compare.status ?? compare.error?.message}):\n${compare.stderr}`);
  return out;
}

test.describe.configure({ mode: 'serial' });

let compareHtml;
test.beforeAll(async () => {
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'prototype-studio-media-evals-'));
  try {
    const report = await fs.readFile(await compareReport(work), 'utf8');
    const table = dropColumns(readTable(report, '比べる表'), ['待ち時間の中央値(秒)']);
    compareHtml = compareTableHtml(table, {
      title: '場面を回した比べる表',
      lead: '見本「バイト探し(架空)」の場面(app/evals/)を、構成と前提ごとにモックで回した結果です(npm run evals)。',
      tokensCss: await fs.readFile(path.join(ROOT, 'assets', 'brand', 'tokens.css'), 'utf8'),
    });
  } finally {
    await fs.rm(work, { recursive: true, force: true });
  }
});

for (const colorScheme of THEMES) {
  test.describe(`${colorScheme === 'dark' ? 'ダーク' : 'ライト'}`, () => {
    test.use({ colorScheme, viewport: SCENE_VIEWPORT, deviceScaleFactor: 1 });

    test('画面 4 枚: 試す画面と言葉で直す欄、構成と前提、模擬の会話の記録、比べる表', async ({ page, home }) => {
      const studio = await launchStudio(home);
      try {
        await talkScene(page, studio, home);
        await writeFixRequest(page);
        await expectNoLeaks(page, '試す画面と言葉で直す欄', home);
        await shoot(page, `try-and-fix-${colorScheme}.png`, home);

        await showSimChoice(page);
        await expectNoLeaks(page, '構成と前提', home);
        await shoot(page, `sim-choice-${colorScheme}.png`, home);

        const { tool } = await showSimTrace(page);
        await scrollDrawerTo(tool, { block: 'center' });
        await expectNoLeaks(page, '模擬の会話の記録', home);
        await shoot(page, `sim-trace-${colorScheme}.png`, home);
      } finally {
        await studio.stop();
      }

      // Studio の画面の CSP を引き継がないよう、空のページに移ってから表を書く
      await page.goto('about:blank');
      await page.setContent(compareHtml);
      await expectNoLeaks(page, '比べる表', home);
      await shoot(page, `evals-compare-${colorScheme}.png`, home, { clip: await unionClip(page, [page.locator('main')], { x: 40, y: 40 }) });
    });
  });

  test.describe(`${colorScheme === 'dark' ? 'ダーク' : 'ライト'}の層`, () => {
    // LP のカードが使う。小さく切り出すので、2 倍の細かさで撮る
    test.use({ colorScheme, viewport: { width: 1280, height: 1000 }, deviceScaleFactor: 2 });

    test('分解の絵の素材: 層ごとの画面(docs/brand.md の 4 節の順)', async ({ page, home }) => {
      const studio = await launchStudio(home);
      try {
        await talkScene(page, studio, home);
        const { items } = talkOf(page);
        await items.last().scrollIntoViewIfNeeded();
        await shoot(page, `layers/1-talk-${colorScheme}.png`, home, { clip: await unionClip(page, [items.nth(-2), items.last()]) });

        const { entry, agent, tool } = await showSimTrace(page);
        await expectNoLeaks(page, '層の記録', home);
        await scrollDrawerTo(agent);
        await shoot(page, `layers/2-agent-${colorScheme}.png`, home, { clip: await unionClip(page, [agent]) });
        const prompt = agent.locator(':scope > p').filter({ hasText: 'プロンプトの部品' });
        await shoot(page, `layers/3-prompt-${colorScheme}.png`, home, { clip: await unionClip(page, [prompt, agent.locator(':scope > ul')]) });
        const result = tool.locator(':scope > p').filter({ hasText: '結果:' });
        await shoot(page, `layers/4-tool-${colorScheme}.png`, home, { clip: await unionClip(page, [tool.locator(':scope > strong'), result]) });
        await shoot(page, `layers/5-guard-${colorScheme}.png`, home, { clip: await unionClip(page, [tool.locator(':scope > ul')]) });
        await scrollDrawerTo(entry);
        const head = entry.locator(':scope > .trace-head');
        const reply = entry.locator(':scope > p').filter({ hasText: '返事:' });
        await shoot(page, `layers/6-record-${colorScheme}.png`, home, { clip: await unionClip(page, [head, reply]) });
      } finally {
        await studio.stop();
      }
    });
  });
}

test.describe('動く画像', () => {
  test.use({ colorScheme: 'light', viewport: SCENE_VIEWPORT, deviceScaleFactor: 1 });

  test('トークから、記録の画面でツールの呼び出しと守りが効いたところまで(15 秒前後)', async ({ page, home }) => {
    const problem = checkFfmpeg();
    if (problem) throw new Error(problem);
    const work = await fs.mkdtemp(path.join(os.tmpdir(), 'prototype-studio-media-frames-'));
    const studio = await launchStudio(home);
    try {
      await openPartTime(page, studio);
      await hideDevOnlyMarks(page);
      const recording = await startFrames(page, work, SCENE_VIEWPORT);
      await page.waitForTimeout(1200);
      await searchJobs(page, { pace: 1 });
      await expectNoLeaks(page, '動く画像(探した後)', home);
      await askToSave(page, { pace: 1 });
      await expectNoLeaks(page, '動く画像(保存を頼んだ後)', home);
      const { tool, blocked } = await showSimTrace(page, { pace: 1 });
      await scrollDrawerTo(tool, { pace: 1, block: 'center' });
      await expect(blocked).toBeInViewport();
      await expectNoLeaks(page, '動く画像(記録)', home);
      const { frames, seconds } = await recording.stop({ hold: 3 });
      expect(seconds, `動く画像が ${seconds.toFixed(1)} 秒です`).toBeGreaterThanOrEqual(CLIP_SECONDS.min);
      expect(seconds, `動く画像が ${seconds.toFixed(1)} 秒です`).toBeLessThanOrEqual(CLIP_SECONDS.max);

      await fs.mkdir(OUT, { recursive: true });
      const gif = path.join(OUT, 'talk-guard.gif');
      const webm = path.join(OUT, 'talk-guard.webm');
      await encodeClip(frames, work, { gif: { out: gif, fps: 10, width: 960 }, webm: { out: webm, fps: 25, crf: 36 } });
      await expectFileOk(gif, LIMITS.gif, home);
      await expectFileOk(webm, LIMITS.webm, home);
      console.log(`動く画像: ${seconds.toFixed(1)} 秒、${frames.length} コマ`);
    } finally {
      await studio.stop();
      await fs.rm(work, { recursive: true, force: true });
    }
  });
});
