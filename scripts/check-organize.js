#!/usr/bin/env node
// 実機の Claude Code で、整理する AI(src/server/organize-ai.js)に架空の台本を通し、整理の質を人が読むための記録を残す(jyoka/tasks#418)。
// 起動の引数、指示、やり直し、板に入れるところは Studio と同じコード(createOrganizeAi と ProjectOrganizes)を使う。ブラウザーと HTTP の層は通らない。
// 実モデルを呼ぶので、--run と --limit-usd を付けたときだけ動く。npm test と npm run test:e2e からは呼ばない。
//
//   npm run check:organize                            何を送るかを出すだけ(Claude Code を呼ばない)
//   npm run check:organize -- --run --limit-usd 3     3 回通す(本人のログインで動くときだけ)
//   npm run check:organize -- --run --limit-usd 3 --out <フォルダー>    記録の置き場所を変える
//
// 同意: --run は、この台本を送ってよいと人が頼んだ印。Studio の同意の口(POST /api/real-ai/consent)は使わず、Studio も起動しない。
// 終了コード: 0 は 3 回とも板に出た、1 は始められなかった、2 は板に出なかった回がある、3 は費用の上限で途中で止めた
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveConnection } from '../src/server/agent-connection.js';
import { STUDIO_ROOT } from '../src/server/config.js';
import { ProjectOrganizes } from '../src/server/organize.js';
import { COLUMNS, ORGANIZE_AI_LIMITS, ORGANIZE_SYSTEM_PROMPT, createOrganizeAi } from '../src/server/organize-ai.js';
import { shownArgs } from '../src/server/product-ai/claude-code.js';
import { findPersonalData } from '../src/server/redact.js';

const SCRIPT = fileURLToPath(import.meta.url);
const DEFAULT_OUT = path.join(STUDIO_ROOT, 'docs', 'evidence', 'real-organize', 'runs');
const PROJECT = 'shiokaze';
const RUNS = 3;
// sim-7 と同じ値。--limit-usd はこれより上にできない
const LIMIT_USD_MAX = 3;
// 1 回の整理で使うかもしれない額(形が壊れたときのやり直しを入れた額)。起動の前に、これを足しても上限を超えないことを確かめる
const USD_PER_RUN = ORGANIZE_AI_LIMITS.maxBudgetUsd * ORGANIZE_AI_LIMITS.attempts;

// 架空の「しおかぜ便」の会の要点 10 個(test/e2e/organize.spec.js の POINTS と同じ)
export const POINTS = [
  '再配達の受付を、電話なしで済ませたい',
  'お年寄りのお客さんも多い',
  '夕方に電話が集中する',
  '再配達の受付は、その日の 17 時まで',
  '不在票に荷物の番号がある',
  '「荷物はいつ届くか」の電話も多い',
  '受付の担当は 2 人で回している',
  '不在票を見て、今日の夜に届けてほしい人がいる',
  '17 時を過ぎたら翌日の受付にする',
  'お届け先と希望の日時を聞いている',
];
// 記録の確かめの要点。10 個には電話番号の形がないので 11 個目に足す。番号は架空
export const RECORD_POINT = '先週、090-0000-0000 のお客さんから同じ荷物のことで 3 回電話があった';
export const SCRIPT_POINTS = [...POINTS, RECORD_POINT];
const RECORD_N = SCRIPT_POINTS.length;
// 台本に仕込んだ穴(荷物の番号を忘れた人)を拾ったらしい文。候補を出すだけで、拾えたかは人が読んで決める
const HOLE = /(番号|不在票).*(忘|なくし|無くし|紛失|分から|わから|手元にない|ない場合|ないとき|ない人|持っていない)/;

const hasPhone = (text) => findPersonalData(text).some((found) => found.kind === '電話番号');

// 人が読むための数のうち、機械で数えられるもの。振り分けと根拠の正しさは数えない(人が読む)
export function countsOf(view, raw, points = SCRIPT_POINTS) {
  const known = new Set(points.map((_, index) => index + 1));
  const rawItems = Array.isArray(raw?.items) ? raw.items : [];
  const rawAsks = Array.isArray(raw?.toAsk) ? raw.toAsk : [];
  const cited = new Set(view.items.flatMap((item) => item.sources));
  const byColumn = Object.fromEntries(Object.keys(COLUMNS).map((column) => [column, view.items.filter((item) => item.column === column).length]));
  const asks = (kind) => view.asks.filter((ask) => ask.kind === kind);
  return {
    items: view.items.length,
    byColumn,
    withSources: view.items.filter((item) => item.sources.length > 0).length,
    guesses: view.items.filter((item) => item.guess).length,
    // 今ない要点を指していた番号。Studio が捨てる。捨てて空になった項目は「推測」になる
    unknownSources: [...rawItems, ...rawAsks].flatMap((item) => (Array.isArray(item?.sources) ? item.sources.filter((n) => !known.has(n)) : [])),
    // AI が返した項目のうち、Studio が板に入れなかった数
    droppedItems: raw ? rawItems.length - view.items.length : null,
    uncitedPoints: [...known].filter((n) => !cited.has(n)),
    asks: { conflict: asks('conflict').length, unasked: asks('unasked').length, guess: asks('guess').length, empty: asks('empty').length },
    holeCandidates: view.asks.filter((ask) => HOLE.test(ask.text)).map((ask) => ask.text),
    record: {
      itemsWithPhone: view.items.filter((item) => hasPhone(item.text)).map((item) => item.text),
      asksWithPhone: view.asks.filter((ask) => hasPhone(ask.text)).map((ask) => ask.text),
      itemsCitingPoint: view.items.filter((item) => item.sources.includes(RECORD_N)).map((item) => item.text),
      asksCitingPoint: view.asks.filter((ask) => ask.sources.includes(RECORD_N)).map((ask) => ask.text),
    },
  };
}

// 記録に残さないもの: メールアドレスの形(Claude Code が文脈に足すことがある)、手元のパス。電話番号は台本の架空の番号なので残す
function masker(paths) {
  return (text) => paths.reduce((acc, value) => acc.replaceAll(value, '<手元>'), String(text)).replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[伏せた: メールアドレス]');
}

// 間に挟む記録係。受けた stdin を CLI に渡し、CLI の stdout をそのまま返し、両方を 1 行の JSON で記録に足す。
// runCli は別のプロセスグループで起動し、グループへシグナルを送るので、止めるときは CLI にも届く。ここは CLI の終わりを待つ
async function tee([logFile, command, ...args]) {
  for (const name of ['SIGINT', 'SIGTERM']) process.on(name, () => {});
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const input = Buffer.concat(chunks).toString('utf8');
  const started = Date.now();
  const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'inherit'] });
  const out = [];
  child.stdout.on('data', (chunk) => {
    out.push(chunk);
    process.stdout.write(chunk);
  });
  child.stdin.on('error', () => {});
  child.stdin.end(input);
  const [code, signal] = await new Promise((resolve) => {
    child.on('error', () => resolve([127, null]));
    child.on('close', (...result) => resolve(result));
  });
  await fs.appendFile(logFile, `${JSON.stringify({ ms: Date.now() - started, code, signal, shownArgs: shownArgs(args), input, stdout: Buffer.concat(out).toString('utf8') })}\n`);
  process.exitCode = code ?? 1;
}

// 記録の 1 行を、残す形にする。session_id などは残さない
export function attemptOf(line, mask) {
  let result = null;
  try {
    result = JSON.parse(line.stdout);
  } catch {
    // 読めない出力は、そのまま少しだけ残す
  }
  return {
    ms: line.ms,
    exitCode: line.code,
    signal: line.signal,
    costUsd: Number.isFinite(result?.total_cost_usd) ? result.total_cost_usd : null,
    subtype: result?.subtype ?? null,
    isError: result?.is_error ?? null,
    numTurns: result?.num_turns ?? null,
    durationMs: result?.duration_ms ?? null,
    durationApiMs: result?.duration_api_ms ?? null,
    usage: result?.usage ?? null,
    modelUsage: result?.modelUsage ?? null,
    args: line.shownArgs.map(mask),
    input: mask(line.input),
    structuredOutput: result?.structured_output ? JSON.parse(mask(JSON.stringify(result.structured_output))) : null,
    resultText: typeof result?.result === 'string' ? mask(result.result) : null,
    unreadableStdout: result ? null : mask(line.stdout.slice(0, 2000)),
  };
}

// 1 回通す。毎回、空の板から始める。要点は Studio と同じ口(addPoint)で 1 つずつ足す
async function runOnce({ connection, home, logFile, mask }) {
  await fs.writeFile(logFile, '');
  const recording = { ...connection, command: process.execPath, prefixArgs: [SCRIPT, '--tee', logFile, connection.command, ...connection.prefixArgs] };
  const ai = createOrganizeAi({ connection: recording });
  // 同意の口は通らない(頭の「同意」)。aiMode は 'real' にして、Studio の本物の AI と同じ道を通す
  const organizes = new ProjectOrganizes({ home, store: { requireProject: async (id) => ({ id }) }, ai, consent: { require() {} }, aiMode: () => 'real', log: (text) => console.log(`  ${text}`) });
  try {
    for (const text of SCRIPT_POINTS) await organizes.addPoint(PROJECT, { text });
    const started = Date.now();
    const view = await organizes.run(PROJECT);
    const seconds = (Date.now() - started) / 1000;
    const lines = (await fs.readFile(logFile, 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line));
    return { seconds, view, attempts: lines.map((line) => attemptOf(line, mask)) };
  } finally {
    await organizes.close();
  }
}

function printPlan() {
  console.log(`整理する AI に、架空の台本を ${RUNS} 回通します。毎回、空の板から始めます。送る要点は次の ${SCRIPT_POINTS.length} 個です。`);
  SCRIPT_POINTS.forEach((text, index) => console.log(`  ${index + 1}. ${text}`));
  console.log('');
  console.log(`1 回の整理で多くて ${ORGANIZE_AI_LIMITS.attempts} 回起動し、起動ごとに Studio と同じ費用の上限(--max-budget-usd ${ORGANIZE_AI_LIMITS.maxBudgetUsd})を付けます。`);
  console.log(`使った額に ${USD_PER_RUN.toFixed(1)} USD を足すと --limit-usd を超えるなら、その回を始めずに止めます。`);
  console.log('実モデルを呼ぶので、社内の利用条件を確かめてから、--run と --limit-usd を付けて実行してください:');
  console.log(`  npm run check:organize -- --run --limit-usd ${LIMIT_USD_MAX}`);
}

async function main() {
  if (process.argv[2] === '--tee') return tee(process.argv.slice(3));
  let options;
  try {
    ({ values: options } = parseArgs({ args: process.argv.slice(2), options: { run: { type: 'boolean' }, 'limit-usd': { type: 'string' }, 'allow-api-billing': { type: 'boolean' }, out: { type: 'string' } } }));
  } catch (error) {
    console.error(`始められません: ${error.message}`);
    process.exitCode = 1;
    return;
  }
  if (!options.run) {
    printPlan();
    return;
  }
  const limitUsd = Number(options['limit-usd']);
  if (options['limit-usd'] === undefined || !Number.isFinite(limitUsd) || limitUsd <= 0 || limitUsd > LIMIT_USD_MAX) {
    console.error(`始められません: --limit-usd で、3 回の合計の費用の上限(0 より大きく ${LIMIT_USD_MAX} 以下の USD)を指定してください`);
    process.exitCode = 1;
    return;
  }
  const out = path.resolve(options.out ?? DEFAULT_OUT);
  const existing = await fs.readdir(out).catch(() => []);
  if (existing.length > 0) {
    console.error(`始められません: 記録の置き場所が空ではありません(${out})。前の記録を上書きしないため`);
    process.exitCode = 1;
    return;
  }
  const connection = await resolveConnection({ agent: 'claude', claudeBin: process.env.STUDIO_CLAUDE_BIN || null });
  if (connection.problem) {
    console.error(`始められません: ${connection.problem}`);
    process.exitCode = 1;
    return;
  }
  console.log(`Claude Code ${connection.version}`);
  console.log(`認証の見込み: ${connection.billing.text}`);
  if (!['login', 'oauth-token'].includes(connection.billing.mode) && !options['allow-api-billing']) {
    console.error('本人のログインではなく、API などの料金がかかる見込みです。止めました。かまわないときだけ、--allow-api-billing を付けてください。');
    process.exitCode = 1;
    return;
  }

  const work = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'prototype-studio-check-organize-')));
  const mask = masker([work, work.replace(/^\/private\//, '/'), os.tmpdir(), os.homedir()]);
  await fs.mkdir(out, { recursive: true });
  const summary = { claudeCode: connection.version, billing: connection.billing.mode, limitUsd, usdPerRun: USD_PER_RUN, points: SCRIPT_POINTS, systemPrompt: ORGANIZE_SYSTEM_PROMPT, runs: [], totalCostUsd: 0, stopped: null };
  let spent = 0;
  try {
    for (let n = 1; n <= RUNS; n += 1) {
      if (spent + USD_PER_RUN > limitUsd + 1e-9) {
        summary.stopped = `使った額 ${spent.toFixed(4)} USD に ${USD_PER_RUN.toFixed(1)} USD を足すと --limit-usd ${limitUsd} を超えるので、${n} 回目を始めませんでした`;
        console.log(summary.stopped);
        break;
      }
      console.log(`${n} 回目を始めます…`);
      const home = path.join(work, `home-${n}`);
      const { seconds, view, attempts } = await runOnce({ connection, home, logFile: path.join(work, `log-${n}.jsonl`), mask });
      const costUsd = attempts.reduce((sum, attempt) => sum + (attempt.costUsd ?? 0), 0);
      // 費用が分からない起動は、1 回の上限を数える(少なく数えないため)
      spent += attempts.reduce((sum, attempt) => sum + (attempt.costUsd ?? ORGANIZE_AI_LIMITS.maxBudgetUsd), 0);
      const raw = attempts.at(-1)?.structuredOutput ?? null;
      const onBoard = view.items.length > 0;
      const record = { run: n, seconds, costUsd, attemptCount: attempts.length, models: [...new Set(attempts.flatMap((attempt) => Object.keys(attempt.modelUsage ?? {})))], onBoard, note: view.note, counts: countsOf(view, raw), board: { items: view.items, asks: view.asks, points: view.points }, attempts };
      await fs.writeFile(path.join(out, `run-${n}.json`), `${JSON.stringify(record, null, 2)}\n`);
      summary.runs.push({ run: n, seconds, costUsd, attemptCount: attempts.length, models: record.models, onBoard, note: view.note, counts: record.counts });
      console.log(`  ${seconds.toFixed(1)} 秒、${costUsd.toFixed(4)} USD、起動 ${attempts.length} 回、項目 ${view.items.length}、推測 ${record.counts.guesses}、聞くこと ${view.asks.length}、${onBoard ? '板に出た' : `板に出なかった(${view.note})`}`);
    }
  } finally {
    summary.totalCostUsd = Number(spent.toFixed(4));
    await fs.writeFile(path.join(out, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
    await fs.rm(work, { recursive: true, force: true });
  }
  console.log(`合計 ${spent.toFixed(4)} USD(上限 ${limitUsd} USD)。記録: ${path.relative(STUDIO_ROOT, out)}`);
  if (summary.runs.some((run) => !run.onBoard)) process.exitCode = 2;
  else if (summary.stopped) process.exitCode = 3;
}

// 直接起動したときだけ動かす
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
