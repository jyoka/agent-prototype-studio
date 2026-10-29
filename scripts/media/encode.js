import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

// 動く画像の撮り方。Chromium の画面の配信(CDP の Page.startScreencast)で、画面が変わるたびに PNG を 1 枚ずつ受け取り、
// 受け取った時刻から各コマの長さを決める。ffmpeg で GIF と WebM(VP9)にする。音は入れない。
// ffmpeg は npm の依存ではない。PATH にあるものを使う(STUDIO_MEDIA_FFMPEG で場所を指せる)

const FFMPEG_TIMEOUT_MS = 180_000;

export const ffmpegPath = () => process.env.STUDIO_MEDIA_FFMPEG || 'ffmpeg';

// ffmpeg があり、GIF と VP9 を書けるかを確かめる。なければ理由の文を返す
export function checkFfmpeg() {
  const bin = ffmpegPath();
  const version = spawnSync(bin, ['-hide_banner', '-version'], { encoding: 'utf8', timeout: 10_000 });
  if (version.error || version.status !== 0) {
    return `ffmpeg が見つかりません(${bin})。動く画像を書くのに使います。入れてから(macOS は brew install ffmpeg)、もう一度 npm run media を動かしてください`;
  }
  const encoders = spawnSync(bin, ['-hide_banner', '-encoders'], { encoding: 'utf8', timeout: 10_000 }).stdout ?? '';
  const missing = ['gif', 'libvpx-vp9'].filter((name) => !new RegExp(`\\s${name}\\s`).test(encoders));
  if (missing.length > 0) return `ffmpeg(${bin})が ${missing.join('、')} を書けません。書ける ffmpeg を入れてください`;
  return null;
}

// 画面の配信を始める。stop() で止め、コマの一覧 [{ file, seconds }] と全体の秒数を返す
export async function startFrames(page, dir, { width, height }) {
  await fs.mkdir(dir, { recursive: true });
  const cdp = await page.context().newCDPSession(page);
  const frames = [];
  const writes = [];
  cdp.on('Page.screencastFrame', ({ data, metadata, sessionId }) => {
    const file = path.join(dir, `frame-${String(frames.length).padStart(5, '0')}.png`);
    frames.push({ file, at: metadata.timestamp });
    writes.push(fs.writeFile(file, Buffer.from(data, 'base64')));
    cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
  });
  await cdp.send('Page.startScreencast', { format: 'png', maxWidth: width, maxHeight: height, everyNthFrame: 1 });
  return {
    // hold: 最後のコマを見せる秒数
    async stop({ hold = 0 } = {}) {
      const end = Date.now() / 1000 + hold;
      await cdp.send('Page.stopScreencast');
      await Promise.all(writes);
      await cdp.detach().catch(() => {});
      if (frames.length === 0) throw new Error('画面の配信からコマを 1 枚も受け取れませんでした');
      return { frames: toTicks(frames, end), seconds: end - frames[0].at };
    },
  };
}

// コマの数え方。受け取ったコマを TICK_FPS の刻みに並べ直し、刻みごとに、その時までに受け取った最後のコマを出す。
// 長さが刻みの倍数になるので、ffmpeg が短いコマを 1 刻みに伸ばして、全体が延びることがない
const TICK_FPS = 25;

export function toTicks(frames, end) {
  const start = frames[0].at;
  const total = Math.round((end - start) * TICK_FPS);
  const list = [];
  let index = 0;
  for (let tick = 0; tick < total; tick += 1) {
    const time = start + tick / TICK_FPS;
    while (index + 1 < frames.length && frames[index + 1].at <= time) index += 1;
    const last = list.at(-1);
    if (last?.file === frames[index].file) last.ticks += 1;
    else list.push({ file: frames[index].file, ticks: 1 });
  }
  return list.map(({ file, ticks }) => ({ file, seconds: ticks / TICK_FPS }));
}

function ffmpeg(args) {
  const result = spawnSync(ffmpegPath(), ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8', timeout: FFMPEG_TIMEOUT_MS });
  if (result.error) throw new Error(`ffmpeg が ${FFMPEG_TIMEOUT_MS / 1000} 秒で終わらないか、動きません: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`ffmpeg が失敗しました(${result.status}):\n${result.stderr}`);
}

// コマの一覧を ffmpeg の concat の書き方にする。ffmpeg は最後のコマの長さを、その前のコマの長さで決めるので、
// 最後に 1 刻みだけ同じコマを足し、書くときに全体の長さ(-t)で切る
async function writeConcatList(frames, file) {
  const lines = ['ffconcat version 1.0'];
  for (const frame of frames) lines.push(`file '${path.basename(frame.file)}'`, `duration ${frame.seconds.toFixed(3)}`);
  lines.push(`file '${path.basename(frames.at(-1).file)}'`, `duration ${(1 / TICK_FPS).toFixed(3)}`);
  await fs.writeFile(file, `${lines.join('\n')}\n`);
}

// 日時と道具の版を、ファイルに入れない
const NO_METADATA = ['-map_metadata', '-1', '-fflags', '+bitexact', '-flags:v', '+bitexact'];

// GIF と WebM を書く。gif: { fps, width }、webm: { fps, crf }
export async function encodeClip(frames, dir, { gif, webm }) {
  const list = path.join(dir, 'frames.ffconcat');
  await writeConcatList(frames, list);
  const total = frames.reduce((sum, frame) => sum + frame.seconds, 0);
  const input = ['-f', 'concat', '-safe', '0', '-i', list, '-t', total.toFixed(3)];
  const palette = 'palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle';
  ffmpeg([...input, '-vf', `fps=${gif.fps},scale=${gif.width}:-1:flags=lanczos,split[a][b];[a]${palette}`, '-loop', '0', ...NO_METADATA, gif.out]);
  ffmpeg([
    ...input,
    '-vf', `fps=${webm.fps},format=yuv420p`,
    '-c:v', 'libvpx-vp9', '-crf', String(webm.crf), '-b:v', '0', '-row-mt', '1', '-an',
    ...NO_METADATA,
    webm.out,
  ]);
}
