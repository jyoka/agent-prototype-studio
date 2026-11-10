#!/usr/bin/env node
// 実機の Claude Code で、案を出す AI(src/server/design-ai.js)に形の違う架空の題材 3 つを通し、AI 構成の審査の案を人が読むための記録を残す(task 422)。
// 題材は、手順が決まっている、道具を選ぶ必要がある、仕事を分けて並べられる、の 3 つ。いつも同じ構成を勧めるなら、案を出す AI を作り直す。
// 起動の引数、指示、やり直し、案の整え方は Studio と同じコード(createDesignAi、mergeAiOptions)を使う。審査の中身も Studio と同じコード(architecture.js)で書く。
// 案ごとの数は、Studio が書いた構成をお試しの AI(モック)で回した結果だけ(形の確かめ。案の良し悪しの根拠にしない)。本物の AI で場面は回さない。
// 実モデルを呼ぶので、--run と --limit-usd を付けたときだけ動く。npm test と npm run test:e2e からは呼ばない。
//
//   npm run check:review                              何を送るかを出すだけ(Claude Code を呼ばない)
//   npm run check:review -- --run --limit-usd 3       3 題材を 1 回ずつ通す(本人のログインで動くときだけ)
//   npm run check:review -- --run --limit-usd 3 --out <フォルダー>    記録の置き場所を変える
//   npm run check:review -- --recount <フォルダー>   残した AI の返事から、Studio の側(案の整え方、審査の中身、お試しの数)だけを書き直す(Claude Code を呼ばない)
//
// 同意: --run は、この題材を送ってよいと人が頼んだ印。Studio の同意の口(POST /api/real-ai/consent)は使わず、Studio も起動しない。
// 終了コード: 0 は 3 題材で勧めた構成が 2 種類以上、1 は始められなかった、2 は 3 題材で同じ構成を勧めた(作り直す)、3 は費用の上限で途中で止めた
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { resolveConnection } from '../src/server/agent-connection.js';
import { architectureFingerprint, compositionShape, harnessRows, harnessSummary, stackRows } from '../src/server/architecture.js';
import { STUDIO_ROOT } from '../src/server/config.js';
import { STEPS, desiredFiles, fixedOptions, mergeAiOptions } from '../src/server/design.js';
import { DESIGN_AI_LIMITS, DESIGN_SYSTEM_PROMPT, createDesignAi } from '../src/server/design-ai.js';
import { judgeRag, shelfFromDataDesign } from '../src/server/data-shelf.js';
import { readManifest } from '../src/server/manifest.js';
import { shownArgs } from '../src/server/product-ai/claude-code.js';
import { readAiDefinition } from '../src/server/product-ai/definition.js';
import { createMockConnection } from '../src/server/product-ai/mock.js';
import { createMockAgent } from '../src/server/sim/agent-mock.js';
import { readSimulation } from '../src/server/sim/composition.js';
import { runEvals } from '../src/server/sim/eval-run.js';

const SCRIPT = fileURLToPath(import.meta.url);
const DEFAULT_OUT = path.join(STUDIO_ROOT, 'docs', 'evidence', 'real-review', 'runs');
// カードの上限。--limit-usd はこれより上にできない
const LIMIT_USD_MAX = 3;
// 1 題材で使うかもしれない額(形が壊れたときのやり直しを入れた額)
const USD_PER_SUBJECT = DESIGN_AI_LIMITS.maxBudgetUsd * DESIGN_AI_LIMITS.attempts;

// 形の違う架空の題材 3 つ。会社、人、地名はどれも架空。board は整理の板の項目(id は Studio の印の形)
export const SUBJECTS = [
  {
    id: 'fixed-steps',
    shapeHint: '手順が決まっている',
    sentence: '架空の市民プール「みなもプール」の個人レッスンの予約を、電話なしで受けたい',
    doc: { who: '個人レッスンを予約したい市民(架空)', problem: '予約の電話が受付に集中している', scene: '前の日の夜に翌週の予約をする', success: '予約の電話が半分になる', notDoing: ['料金の支払い', 'コーチの指名'], undecided: [] },
    board: [
      { id: 'i1', column: 'requirement', text: '日にち、時間帯、人数、泳げるかどうかを聞いて予約を取る' },
      { id: 'i2', column: 'rule', text: '予約は 7 日先まで。1 回 2 人まで' },
      { id: 'i3', column: 'rule', text: '聞く順番はいつも同じ。最後に内容を読み上げて確かめる' },
      { id: 'i4', column: 'scene', text: '空いている時間帯を聞かれる' },
      { id: 'i5', column: 'data', text: 'レッスンの枠(日にち、時間帯、空き)' },
      { id: 'i6', column: 'user', text: '子どもを通わせたい保護者' },
    ],
  },
  {
    id: 'choose-tools',
    shapeHint: '道具を選ぶ必要がある',
    sentence: '架空の家電店「ことぶき電機」の問い合わせに、在庫、修理の進み具合、取扱説明書を使い分けて答えたい',
    doc: { who: '家電を買った人と、買いたい人(架空)', problem: '問い合わせの中身がばらばらで、調べる所が毎回違う', scene: '閉店後に問い合わせが来る', success: '店員が調べる手間が減る', notDoing: ['修理の見積もり', '値引きの相談'], undecided: ['返品の扱い'] },
    board: [
      { id: 'i1', column: 'requirement', text: '在庫を聞かれたら在庫の表を、修理を聞かれたら修理の受付番号で進み具合を調べる' },
      { id: 'i2', column: 'requirement', text: '使い方を聞かれたら取扱説明書を探して答える' },
      { id: 'i3', column: 'scene', text: '1 つの問い合わせで、在庫と使い方を続けて聞かれることがある' },
      { id: 'i4', column: 'data', text: '商品の在庫の表(品番、店ごとの数)' },
      { id: 'i5', column: 'data', text: '修理の受付(受付番号、状態、戻る予定日)' },
      { id: 'i6', column: 'data', text: '取扱説明書(商品ごとの長い文書)' },
      { id: 'i7', column: 'rule', text: '分からないことは店員に回す' },
    ],
  },
  {
    id: 'split-work',
    shapeHint: '仕事を分けて並べられる',
    sentence: '架空の旅行会社「そらいろ旅行」で、宿、移動、観光の候補を別々に調べて、1 つの旅程の案にまとめたい',
    doc: { who: '家族旅行を考えている人(架空)', problem: '宿、移動、観光をそれぞれ調べて組み合わせるのに時間がかかる', scene: '週末の 2 泊 3 日の旅行を相談する', success: '最初の旅程の案が 1 回の相談で出る', notDoing: ['予約と支払い'], undecided: ['予算を超えたときの扱い'] },
    board: [
      { id: 'i1', column: 'requirement', text: '宿の候補、移動の手段と時間、観光の候補を、それぞれ別に調べる' },
      { id: 'i2', column: 'requirement', text: '調べた 3 つを、日ごとの旅程の案にまとめて見せる' },
      { id: 'i3', column: 'scene', text: '移動の時間が長すぎて、観光の候補を入れ替える' },
      { id: 'i4', column: 'data', text: '宿の一覧(地域、料金、空き)' },
      { id: 'i5', column: 'data', text: '移動の時刻表(区間、所要時間)' },
      { id: 'i6', column: 'data', text: '観光の場所(地域、所要時間、休みの日)' },
      { id: 'i7', column: 'user', text: '小さい子どものいる家族' },
    ],
  },
];

// 記録に残さないもの: メールアドレスの形、手元のパス
function masker(paths) {
  return (text) => paths.reduce((acc, value) => acc.replaceAll(value, '<手元>'), String(text)).replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[伏せた: メールアドレス]');
}

// 間に挟む記録係(scripts/check-organize.js と同じ)。受けた stdin を CLI に渡し、CLI の stdout をそのまま返し、両方を 1 行の JSON で記録に足す
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

function attemptOf(line, mask) {
  let result = null;
  try {
    result = JSON.parse(line.stdout);
  } catch {
    // 読めない出力は、そのまま少しだけ残す
  }
  return {
    ms: line.ms,
    exitCode: line.code,
    costUsd: Number.isFinite(result?.total_cost_usd) ? result.total_cost_usd : null,
    subtype: result?.subtype ?? null,
    isError: result?.is_error ?? null,
    numTurns: result?.num_turns ?? null,
    durationMs: result?.duration_ms ?? null,
    modelUsage: result?.modelUsage ? Object.keys(result.modelUsage) : null,
    structuredOutput: result?.structured_output ? JSON.parse(mask(JSON.stringify(result.structured_output))) : null,
    unreadableStdout: result ? null : mask(line.stdout.slice(0, 2000)),
  };
}

// AI のおすすめのとおりに選んだ設計(design.js の record の形)。人が選ぶ代わり
export function recommendedRecord(options) {
  const steps = {};
  for (const { id } of STEPS) {
    const list = options[id];
    const chosen = (list.find((option) => option.recommended) ?? list[0]).id;
    steps[id] = { options: list, chosen, text: null, note: '', decidedAt: null, stale: false };
  }
  const scenes = steps.scenes.options.find((option) => option.id === steps.scenes.chosen).scenes;
  return { steps, scenes };
}

// Studio が書く構成のファイルを一時フォルダーに書き、検査を通し、お試しの AI で場面を回す。審査の中身(architecture.js)も書く
async function reviewOf(record, work, board) {
  const appDir = await fs.mkdtemp(path.join(work, 'app-'));
  await fs.writeFile(path.join(appDir, 'prototype.json'), JSON.stringify({ formatVersion: 1, title: '架空', entry: 'main.jsx' }));
  await fs.writeFile(path.join(appDir, 'main.jsx'), 'export {};\n');
  for (const [relative, content] of desiredFiles(record)) {
    const file = path.join(appDir, ...relative.split('/'));
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content);
  }
  const { manifest } = await readManifest(appDir);
  const { definition: ai } = await readAiDefinition(appDir, manifest.ai ?? undefined);
  const { simulation, errors } = await readSimulation(appDir, manifest, ai);
  if (!simulation) return { errors: errors.slice(0, 5) };
  const mock = { kind: 'mock', real: false, agent: createMockAgent(), harness: createMockConnection() };
  const { result } = await runEvals({ simulation, aiOf: (file) => (file === manifest.ai ? ai : simulation.harnessAis?.[file] ?? ai), plan: { connections: ['mock'] }, connectionFor: () => mock, projectDir: work });
  const group = result.groups[0];
  const rows = harnessRows({ simulation, ai, evalsCount: simulation.evals.length });
  const data = record.steps.data.options.find((option) => option.id === record.steps.data.chosen);
  const shelf = shelfFromDataDesign(data, board);
  return {
    errors: [],
    shape: compositionShape(simulation.composition),
    fingerprint: (await architectureFingerprint(appDir)).value,
    mock: { passed: group?.summary?.passed ?? 0, total: group?.summary?.evals ?? 0, toolCalls: group?.summary?.tools?.calls ?? 0, verdict: result.verdict },
    harness: { rows: rows.map((row) => ({ part: row.part, content: row.content, decidedBy: row.decidedByLabel, modelOnly: row.modelOnly })), ...harnessSummary(rows) },
    data: { shelf, rag: judgeRag(shelf) },
    stack: stackRows({ simulation, evalsCount: simulation.evals.length }).map((row) => ({ part: row.part, prototype: row.prototype })),
  };
}

async function runSubject({ subject, connection, logFile, mask, work }) {
  await fs.writeFile(logFile, '');
  const recording = { ...connection, command: process.execPath, prefixArgs: [SCRIPT, '--tee', logFile, connection.command, ...connection.prefixArgs] };
  const ai = createDesignAi({ connection: recording });
  const material = { sentence: subject.sentence, doc: subject.doc, board: subject.board };
  const started = Date.now();
  let output = null;
  let failure = null;
  try {
    output = await ai.propose(material);
  } catch (error) {
    failure = error.message;
  } finally {
    await ai.close();
  }
  const seconds = (Date.now() - started) / 1000;
  const lines = (await fs.readFile(logFile, 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const attempts = lines.map((line) => attemptOf(line, mask));
  return studioSide({ subject, output, failure, seconds, attempts, work });
}

// AI の返事から、Studio の側を書く。案の整え方、おすすめのとおりに選んだ設計、審査の中身、お試しの AI の数
async function studioSide({ subject, output, failure, seconds, attempts, work }) {
  const material = { sentence: subject.sentence, doc: subject.doc, board: subject.board };
  const options = mergeAiOptions(fixedOptions(material), output, 1, subject.board);
  const composition = options.composition.find((option) => option.recommended);
  const record = recommendedRecord(options);
  return {
    id: subject.id,
    shapeHint: subject.shapeHint,
    sentence: subject.sentence,
    seconds,
    failure,
    costUsd: attempts.reduce((sum, attempt) => sum + (attempt.costUsd ?? 0), 0),
    attempts,
    // AI が返した構成のおすすめと理由(Studio が整える前)と、Studio が整えた後のおすすめ
    aiComposition: output?.composition ?? null,
    recommended: { id: composition.id, label: composition.title, reason: composition.reason },
    steps: Object.fromEntries(STEPS.map(({ id }) => [id, { source: id === 'composition' || id === 'screens' ? (output ? 'ai' : 'fixed') : options[id] === fixedOptions(material)[id] ? 'fixed' : 'ai', chosen: (options[id].find((option) => option.recommended) ?? options[id][0]).title }])),
    scenes: record.scenes,
    review: await reviewOf(record, work, subject.board),
  };
}

const summaryOf = (result) => ({ id: result.id, shapeHint: result.shapeHint, recommended: result.recommended, aiComposition: result.aiComposition, costUsd: result.costUsd, seconds: result.seconds, attempts: result.attempts.length, failure: result.failure, mock: result.review.mock ?? null, shape: result.review.shape ?? null, rag: result.review.data?.rag?.verdict ?? null, errors: result.review.errors });

// 残した記録の AI の返事(最後の起動の structuredOutput)から、Studio の側だけを書き直す。費用と時間と起動の記録はそのまま
async function recount(dir) {
  const work = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'prototype-studio-check-review-')));
  try {
    const summaryFile = path.join(dir, 'summary.json');
    const summary = JSON.parse(await fs.readFile(summaryFile, 'utf8'));
    summary.subjects = [];
    for (const subject of SUBJECTS) {
      const file = path.join(dir, `${subject.id}.json`);
      const before = JSON.parse(await fs.readFile(file, 'utf8').catch(() => 'null'));
      if (!before) continue;
      const output = [...before.attempts].reverse().find((attempt) => attempt.structuredOutput)?.structuredOutput ?? null;
      const result = await studioSide({ subject, output: before.failure ? null : output, failure: before.failure, seconds: before.seconds, attempts: before.attempts, work });
      await fs.writeFile(file, `${JSON.stringify(result, null, 2)}\n`);
      summary.subjects.push(summaryOf(result));
      console.log(`${subject.shapeHint}: ${result.recommended.label}。RAG ${result.review.data?.rag?.verdict ?? '不明'}。お試しの AI ${result.review.mock?.passed ?? '-'} / ${result.review.mock?.total ?? '-'}`);
    }
    summary.distinctRecommendations = [...new Set(summary.subjects.map((subject) => subject.recommended.id))];
    summary.recountedAt = new Date().toISOString();
    await fs.writeFile(summaryFile, `${JSON.stringify(summary, null, 2)}\n`);
  } finally {
    await fs.rm(work, { recursive: true, force: true });
  }
}

function printPlan() {
  console.log(`案を出す AI に、形の違う架空の題材を ${SUBJECTS.length} つ通します(各 1 回)。`);
  for (const subject of SUBJECTS) console.log(`  - ${subject.shapeHint}: ${subject.sentence}`);
  console.log('');
  console.log(`1 題材で多くて ${DESIGN_AI_LIMITS.attempts} 回起動し、起動ごとに Studio と同じ費用の上限(--max-budget-usd ${DESIGN_AI_LIMITS.maxBudgetUsd})を付けます。`);
  console.log(`使った額に ${USD_PER_SUBJECT.toFixed(1)} USD を足すと --limit-usd を超えるなら、その題材を始めずに止めます。`);
  console.log('案ごとの数は、お試しの AI で回した結果だけです(本物の AI で場面は回しません)。');
  console.log('実モデルを呼ぶので、社内の利用条件を確かめてから、--run と --limit-usd を付けて実行してください:');
  console.log(`  npm run check:review -- --run --limit-usd ${LIMIT_USD_MAX}`);
}

async function main() {
  if (process.argv[2] === '--tee') return tee(process.argv.slice(3));
  let options;
  try {
    ({ values: options } = parseArgs({ args: process.argv.slice(2), options: { run: { type: 'boolean' }, 'limit-usd': { type: 'string' }, 'allow-api-billing': { type: 'boolean' }, out: { type: 'string' }, recount: { type: 'string' } } }));
  } catch (error) {
    console.error(`始められません: ${error.message}`);
    process.exitCode = 1;
    return;
  }
  if (options.recount) {
    await recount(path.resolve(options.recount));
    return;
  }
  if (!options.run) {
    printPlan();
    return;
  }
  const limitUsd = Number(options['limit-usd']);
  if (options['limit-usd'] === undefined || !Number.isFinite(limitUsd) || limitUsd <= 0 || limitUsd > LIMIT_USD_MAX) {
    console.error(`始められません: --limit-usd で、3 題材の合計の費用の上限(0 より大きく ${LIMIT_USD_MAX} 以下の USD)を指定してください`);
    process.exitCode = 1;
    return;
  }
  const out = path.resolve(options.out ?? DEFAULT_OUT);
  if ((await fs.readdir(out).catch(() => [])).length > 0) {
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
  const work = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'prototype-studio-check-review-')));
  const mask = masker([work, work.replace(/^\/private\//, '/'), os.tmpdir(), os.homedir()]);
  await fs.mkdir(out, { recursive: true });
  const summary = { claudeCode: connection.version, billing: connection.billing.mode, limitUsd, usdPerSubject: USD_PER_SUBJECT, systemPrompt: DESIGN_SYSTEM_PROMPT, subjects: [], totalCostUsd: 0, stopped: null, startedAt: new Date().toISOString() };
  let spent = 0;
  try {
    for (const subject of SUBJECTS) {
      if (spent + USD_PER_SUBJECT > limitUsd + 1e-9) {
        summary.stopped = `使った額 ${spent.toFixed(4)} USD に ${USD_PER_SUBJECT.toFixed(1)} USD を足すと --limit-usd ${limitUsd} を超えるので、「${subject.shapeHint}」を始めませんでした`;
        console.log(summary.stopped);
        break;
      }
      console.log(`${subject.shapeHint}: 案を出す AI を呼びます…`);
      const result = await runSubject({ subject, connection, logFile: path.join(work, `${subject.id}.jsonl`), mask, work });
      spent += result.costUsd;
      await fs.writeFile(path.join(out, `${subject.id}.json`), `${JSON.stringify(result, null, 2)}\n`);
      summary.subjects.push(summaryOf(result));
      console.log(`  勧めた構成: ${result.recommended.label}(${result.recommended.reason})。費用 ${result.costUsd.toFixed(4)} USD、${result.seconds.toFixed(1)} 秒、起動 ${result.attempts.length} 回`);
      if (result.review.mock) console.log(`  お試しの AI: ${result.review.mock.passed} / ${result.review.mock.total} 通った(形の確かめだけ)`);
    }
  } finally {
    summary.totalCostUsd = spent;
    summary.finishedAt = new Date().toISOString();
    const kinds = new Set(summary.subjects.map((subject) => subject.recommended.id));
    summary.distinctRecommendations = [...kinds];
    await fs.writeFile(path.join(out, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
    await fs.rm(work, { recursive: true, force: true });
  }
  console.log(`合計 ${spent.toFixed(4)} USD。記録: ${out}`);
  if (summary.stopped) process.exitCode = 3;
  else if (summary.subjects.length === SUBJECTS.length && summary.distinctRecommendations.length < 2) {
    console.log('3 題材で同じ構成を勧めました。案を出す AI を作り直してください。');
    process.exitCode = 2;
  }
}

await main();
