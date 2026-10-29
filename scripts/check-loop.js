#!/usr/bin/env node
// 実モデルで閉じたループ(作る → 観察 → 失敗 → 直す → 通る)が回るかを確かめる(jyoka/tasks#314、
// docs/design/harness.md の 8 節のカード 13。S1、S4、S12、S19 の実機の側)。架空のデータだけを使う。
// 実モデルを呼ぶので、--real を付けたときだけ動く。
//
//   npm run check:loop                      何をするかを出すだけ(Claude Code を呼ばない)
//   npm run check:loop -- --real            本人のログインの Claude Code で回し、記録を docs/evidence/real-loop/ に書く
//   npm run check:loop -- --real --allow-api-billing   API キーなどで動くときも回す
//   npm run check:loop -- --real --out <dir>           記録の置き場を変える
//
// 回すものは 3 つ。どれも、Studio を一時フォルダーで起動し(startStudio)、利用者と同じ入口を使う。
//   1. 作るループ: 実行時エラーを仕込んだ見本(test/fixtures/loop-broken/)に、関係のない小さな依頼を送る。
//      見本は狭い画面(mobile)で開いたときだけ落ちる。関門 G5 は mobile から開くので、1 回目の関門で失敗する見込み
//   2. プロダクト内 AI: 同じ見本のシナリオを、プロダクト内 AI を実モデル(Claude Code)にして 1 本回す。
//      会話は harness の 4 つの段(抽出、決定、言い方、守ることの検証)を通り、記録に残る
//   3. app/ の外への書き込み: 作る AI に app/ の外へ書かせる依頼を 1 回送り、何が止めたかを記録する(jyoka/tasks#312 の追記)
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveConnection } from '../src/server/agent-connection.js';
import { STUDIO_ROOT } from '../src/server/config.js';
import { startStudio } from '../src/server/index.js';
import { CALL_LIMITS } from '../src/server/product-ai/limits.js';
import { agentRoundsOf, classifyOutsideStop, findLeaks, OUTSIDE_REQUEST, productAiTurnsOf, REQUEST, scrub, summarizeRun } from './real-loop-record.js';

const PROJECT = 'loop-broken';
const PROJECT_TITLE = '確かめ用: 壊れた学習相談(架空)';
const OUTSIDE_PROJECT = 'sample-library';
const FIXTURE = path.join(STUDIO_ROOT, 'test', 'fixtures', 'loop-broken', 'app');
const DEFAULT_OUT = path.join(STUDIO_ROOT, 'docs', 'evidence', 'real-loop');
// 作るループ全体の上限。作る AI の起動は 3 回まで、1 回 10 分(DEFAULT_AGENT_TIMEOUT_MS)と、関門の時間
const LOOP_DEADLINE_MS = 45 * 60_000;
const OUTSIDE_DEADLINE_MS = 12 * 60_000;
// 実モデルのプロダクト内 AI は 1 ターンに数十秒かかり得る。観察の手順の上限を、1 ターンの期限(240 秒)に合わせて広げる
const REAL_AI_LIMITS = { stepTimeoutMs: 270_000, scenarioTimeoutMs: 400_000, observeTimeoutMs: 540_000 };

const args = process.argv.slice(2);

function printPlan() {
  console.log('実モデル(本人のログインの Claude Code)で、閉じたループが回るかを架空データだけで確かめます。');
  console.log(`  1. 作るループ: 実行時エラーを仕込んだ見本(test/fixtures/loop-broken/)に「${REQUEST}」を送る。`);
  console.log('     1 回目の関門で G5 か G6 が失敗し、直すラウンドの後に全関門が通る(fixed)かを見る。作る AI の起動は 3 回まで');
  console.log('  2. 同じ見本のシナリオを、プロダクト内 AI を実モデルにして 1 本回し、4 つの段の記録を見る');
  console.log('  3. 作る AI に app/ の外へ書かせる依頼を 1 回送り、何が止めたかを見る');
  console.log('');
  console.log('記録(依頼、ラウンドごとの関門、直す依頼、スクリーンショット、費用と時間)は docs/evidence/real-loop/ に書きます。');
  console.log('実モデルを呼ぶので、社内の利用条件を確かめてから、--real を付けて実行してください:');
  console.log('  npm run check:loop -- --real');
}

function optionValue(name) {
  const at = args.indexOf(name);
  return at === -1 ? null : (args[at + 1] ?? null);
}

// 作る run の終わりを待つ。上限を超えたら中断し、止まるまで待つ
function waitForRun(requests, id, started, deadlineMs) {
  return new Promise((resolve) => {
    let timer = null;
    const off = started.subscribe(
      () => {},
      (run) => {
        clearTimeout(timer);
        off();
        resolve(run);
      },
    );
    timer = setTimeout(() => {
      console.log(`  上限(${Math.round(deadlineMs / 60_000)} 分)を超えたので中断します`);
      requests.cancel(id, started.run.id);
    }, deadlineMs);
  });
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

async function pngsIn(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  return entries.filter((entry) => entry.isFile() && entry.name.endsWith('.png')).map((entry) => path.join(dir, entry.name)).sort();
}

// 1. 作るループ
async function runLoop(studio, events, projectDir) {
  console.log(`作るループ: ${PROJECT} に依頼を送ります`);
  const started = await studio.requests.start(PROJECT, REQUEST);
  const run = await waitForRun(studio.requests, PROJECT, started, LOOP_DEADLINE_MS);
  const record = await readJson(path.join(projectDir, run.evidence.run));
  const summary = summarizeRun(record);
  const rounds = agentRoundsOf(events.filter((event) => event.runId === run.id));
  // ラウンドごとの関門の report と、そのスクリーンショット
  const shots = [];
  for (const report of record.reports) {
    const file = path.join(projectDir, report.file);
    for (const png of await pngsIn(path.dirname(file))) shots.push({ round: report.round, gate: report.gate, file: png });
  }
  const items = run.items.filter((item) => ['round', 'fix-request', 'gave-up', 'launch-failed', 'scenarios-failed', 'gates', 'denied', 'tool-error'].includes(item.kind));
  console.log(`  結果: ${summary.status}(起動 ${summary.launchCount} 回)`);
  return { summary, record, rounds, shots, items };
}

// 2. プロダクト内 AI を実モデルにして、見本のシナリオを 1 本回す。
// 観察用の会話(createObservationAi)は実モデルを断る(画面の「確かめる」で同意を通すまで作らない、harness.md の 3.3)。
// ここでは利用者が試す画面で Claude Code を選んだときと同じ入口(select と AiSessions.send)を、ai 関数で観察器に渡す。
// 呼び出しは同じ harness の turn を通り、プロジェクトごとの上限にも数える
async function runProductAi(studio) {
  console.log('プロダクト内 AI(実モデル): 見本のシナリオを 1 本回します');
  const sessions = studio.aiSessions;
  sessions.select(PROJECT, 'claude-code');
  sessions.reset(PROJECT);
  const firstId = Math.max(0, ...sessions.trace(PROJECT).entries.map((entry) => entry.id));
  const entries = () =>
    sessions
      .trace(PROJECT)
      .entries.filter((entry) => entry.id > firstId)
      .reverse();
  const ai = async (request) => {
    if (request.op === 'send') return sessions.send(PROJECT, request.text);
    if (request.op === 'correct') return sessions.correct(PROJECT, request.changes);
    return sessions.view(PROJECT);
  };
  ai.state = () => sessions.view(PROJECT).state;
  ai.entries = entries;
  const started = Date.now();
  const report = await studio.observe(PROJECT, { ai, viewports: ['desktop'], limits: REAL_AI_LIMITS });
  const durationMs = Date.now() - started;
  const turns = productAiTurnsOf(entries());
  const used = sessions.projectCalls.count(PROJECT);
  const shots = report.screenshots.map((shot) => shot.file);
  for (const scenario of report.scenarios) {
    for (const step of scenario.steps ?? []) if (step.result?.file) shots.push(step.result.file);
    if (scenario.failed?.screenshot?.file) shots.push(scenario.failed.screenshot.file);
  }
  console.log(`  観察: ${report.verdict}、実モデルのターン ${turns.length} 回、4 つの段: ${turns.every((t) => t.fourStages) && turns.length > 0 ? 'すべてある' : '欠けあり'}`);
  return {
    verdict: report.verdict,
    durationMs,
    scenarios: report.scenarios.map((scenario) => ({
      name: scenario.name,
      base: scenario.base,
      verdict: scenario.verdict,
      ...(scenario.failed ? { failed: { step: scenario.failed.step, message: scenario.failed.message } } : {}),
    })),
    errors: report.errors.map((error) => ({ kind: error.kind, message: error.message })),
    turns,
    projectCalls: { used, limit: CALL_LIMITS.perProject, windowMinutes: CALL_LIMITS.windowMs / 60_000, remaining: CALL_LIMITS.perProject - used },
    shots: [...new Set(shots)],
  };
}

// 3. app/ の外への書き込み
async function runOutside(studio, events, home) {
  console.log(`app/ の外への書き込み: ${OUTSIDE_PROJECT} に依頼を送ります`);
  const paths = await studio.store.requireProject(OUTSIDE_PROJECT);
  const target = path.join(paths.root, 'outside-written.txt');
  const started = await studio.requests.start(OUTSIDE_PROJECT, OUTSIDE_REQUEST);
  const run = await waitForRun(studio.requests, OUTSIDE_PROJECT, started, OUTSIDE_DEADLINE_MS);
  const fileCreated = await fs.access(target).then(
    () => true,
    () => false,
  );
  const strayFiles = (await fs.readdir(path.join(home, 'projects'))).filter((name) => name.includes('outside'));
  const rounds = agentRoundsOf(events.filter((event) => event.runId === run.id));
  const stop = classifyOutsideStop({ rounds, fileCreated: fileCreated || strayFiles.length > 0, appDir: paths.app });
  console.log(`  ファイル: ${fileCreated ? '作られた' : '作られなかった'}、止めたもの: ${stop.stoppedBy}`);
  return {
    request: OUTSIDE_REQUEST,
    status: run.status,
    fileCreated,
    stop,
    items: run.items.filter((item) => ['tool', 'tool-error', 'denied', 'assistant', 'failed'].includes(item.kind)).map((item) => ({ kind: item.kind, text: item.text.slice(0, 600), ...(item.detail ? { detail: item.detail.slice(0, 600) } : {}) })),
    launch: rounds.map((round) => ({ round: round.round, model: round.model, result: round.result, steps: round.steps })),
  };
}

const seconds = (ms) => (Number.isFinite(ms) ? (ms / 1000).toFixed(1) : '不明');
const usd = (value) => (Number.isFinite(value) ? value.toFixed(4) : '不明');
const cell = (text) => String(text ?? '').replace(/\|/g, '\\|').replace(/\s+/g, ' ');

function readme({ when, version, billing, loop, productAi, outside, shotNames, fixFiles }) {
  const lines = [];
  const push = (...more) => lines.push(...more);
  const launchCost = loop.rounds.reduce((sum, round) => sum + (round.result?.costUsd ?? 0), 0);
  const aiCost = productAi.turns.reduce((sum, turn) => sum + (turn.calls?.costUsd ?? 0), 0);
  push('# 実モデルで閉じたループを確かめた記録', '');
  push(`\`npm run check:loop -- --real\`(scripts/check-loop.js)が書いた。架空のデータだけを使った。`, '');
  push(`- 日時: ${when}`, `- Claude Code: ${version}(認証の見込み: ${billing})`, `- 作る AI のモデル: ${[...new Set(loop.rounds.map((r) => r.model).filter(Boolean))].join('、') || '不明'}`);
  push(`- 見本: \`test/fixtures/loop-broken/\`(狭い画面で開いたときだけ、実行時エラーで落ちる)`, `- 依頼の文: [request.txt](request.txt)`, '');
  push('## 結果', '');
  push(`- 作るループ: **${loop.summary.status}**(作る AI の起動 ${loop.summary.launchCount} 回、直すラウンドの上限 ${loop.summary.maxFixRounds} 回)`);
  push(`- 作る AI が呼んだ観察の道具: ${loop.rounds.reduce((sum, r) => sum + r.observe.count, 0)} 回(下の表)`);
  push(`- プロダクト内 AI(実モデル)のシナリオ: 観察 ${productAi.verdict}、実モデルのターン ${productAi.turns.length} 回、4 つの段の記録: ${productAi.turns.length > 0 && productAi.turns.every((t) => t.fourStages) ? 'すべてある' : '欠けあり'}`);
  push(`- app/ の外への書き込み: ファイルは${outside.fileCreated ? '作られた' : '作られなかった'}。止めたもの: ${outside.stop.stoppedBy}(${cell(outside.stop.detail)})`, '');
  push('## ラウンドごとの関門', '', '要約の全体は [run-summary.json](run-summary.json)、Studio が書いた run.json は [run.json](run.json)。', '');
  push('| ラウンド | 入力 | 節の列 | 関門の結果 |', '|---|---|---|---|');
  for (const round of loop.summary.rounds) {
    const gates = round.gates.map((gate) => `${gate.id} ${gate.status}${gate.summary ? `(${gate.summary})` : ''}`).join('、');
    push(`| ${round.round} | ${round.input === 'fix' ? `直す依頼(${round.fixOf?.gate} の失敗)` : '依頼'} | ${round.nodes.join(' → ')} | ${cell(gates)} |`);
  }
  push('', fixFiles.length > 0 ? `直す依頼の文: ${fixFiles.map((file) => `[${file}](${file})`).join('、')}` : '直す依頼はなかった。', '');
  push('## 作る AI の起動ごとの時間と費用', '', '時間は Studio が測った起動から終わりまで。費用とやりとりの回数は Claude Code の result の値(total_cost_usd、num_turns)。', '');
  push('| 起動 | ラウンド | 結果 | 時間(秒) | API の時間(秒) | 費用(USD) | やりとり | 道具の呼び出し |', '|---|---|---|---|---|---|---|---|');
  loop.summary.launches.forEach((launch, index) => {
    const round = loop.rounds.find((r) => r.round === launch.round);
    push(`| ${index + 1} | ${launch.round} | ${launch.outcome} | ${seconds(launch.durationMs)} | ${seconds(round?.result?.durationApiMs)} | ${usd(launch.costUsd)} | ${launch.numTurns ?? '不明'} | ${round?.toolCount ?? 0} |`);
  });
  push(`| 計 | | | ${seconds(loop.summary.launchDurationMs)} | | ${usd(launchCost)} | | |`, '');
  push('## 作る AI が呼んだ観察の道具', '');
  for (const round of loop.rounds) {
    const names = Object.entries(round.observe.byTool).map(([name, n]) => `${name.replace('mcp__observe__', '')} ${n} 回`);
    push(`- ラウンド ${round.round}: ${round.observe.count} 回${names.length > 0 ? `(${names.join('、')})` : '(呼ばなかった)'}`);
    for (const call of round.observe.calls) {
      push(`  - \`${call.name.replace('mcp__observe__', '')}\` ${cell(call.input)} → ${call.isError ? 'エラー: ' : ''}${cell(call.result ?? '').slice(0, 240)}${call.images > 0 ? `(画像 ${call.images} 枚)` : ''}`);
    }
  }
  push('', '道具の呼び出しと結果の全体は [agent-rounds.json](agent-rounds.json)。', '');
  push('## プロダクト内 AI(実モデル)のシナリオ', '');
  push(`観察の時間 ${seconds(productAi.durationMs)} 秒。シナリオ: ${productAi.scenarios.map((s) => `${s.name}(${s.verdict}${s.failed ? `: ${s.failed.message}` : ''})`).join('、')}`, '');
  push('| ターン | 発言 | 抽出 | 決定 | 言い方 | 守ることの検証 | 呼び出し | 待ち時間(秒) | CLI の時間(秒) | 費用(USD) |', '|---|---|---|---|---|---|---|---|---|---|');
  productAi.turns.forEach((turn, index) => {
    const { extract, decision, phrase, guards } = turn.stages;
    push(
      `| ${index + 1} | ${cell(turn.text)} | ${extract ? extract.via : 'なし'} | ${decision ? `段 ${decision.step}、聞く ${decision.ask ?? 'なし'}、終わり ${decision.done}` : 'なし'} | ${phrase ? phrase.via : 'なし'} | ${guards ? guards.result : 'なし'} | ${turn.calls ? `${turn.calls.count} 回(抽出 ${turn.calls.extract}、言い方 ${turn.calls.phrase})` : '不明'} | ${seconds(turn.elapsedMs)} | ${seconds(turn.calls?.durationMs)} | ${usd(turn.calls?.costUsd)} |`,
    );
  });
  push(`| 計 | | | | | | | | | ${usd(aiCost)} |`, '');
  push(
    `プロジェクトごとの上限(${productAi.projectCalls.windowMinutes} 分に ${productAi.projectCalls.limit} 回)のうち、この確かめで ${productAi.projectCalls.used} 回使い、残りは ${productAi.projectCalls.remaining} 回。`,
    '',
    '段ごとの記録の全体は [product-ai-trace.json](product-ai-trace.json)。',
    '',
  );
  push('## app/ の外への書き込み', '', `依頼の文: ${OUTSIDE_REQUEST}`, '', `- 結果の状態: ${outside.status}`, `- ファイル: ${outside.fileCreated ? '作られた' : '作られなかった'}`, `- 止めたもの: ${outside.stop.stoppedBy}`, `- 中身: ${cell(outside.stop.detail)}`, '', '全体は [outside-write.json](outside-write.json)。', '');
  push('## スクリーンショット', '');
  for (const name of shotNames) push(`- [${name}](screenshots/${name})`);
  push('', '## 伏せたこと', '', '書く前に `src/server/redact.js` の redact で伏せ、利用者のホームと一時フォルダーの場所を置き換えた。書いた後に findSecrets と findPersonalData で探し、見つからないことを確かめた。', '');
  return lines.join('\n');
}

async function main() {
  if (!args.includes('--real')) {
    printPlan();
    return;
  }
  const outDir = path.resolve(optionValue('--out') ?? DEFAULT_OUT);
  // 本物の AI を止める設定は、画面を通らないこの確かめにも効かせる(docs/design/agent-simulation.md の 8.2 の P24)
  if (process.env.STUDIO_ALLOW_CLAUDE_CODE === '0') {
    console.error('STUDIO_ALLOW_CLAUDE_CODE=0 なので、試作品の中の AI に本物の AI を使えません。止めました。');
    process.exitCode = 1;
    return;
  }
  const connection = await resolveConnection({ agent: 'claude', claudeBin: process.env.STUDIO_CLAUDE_BIN || null });
  if (connection.problem) {
    console.error(`確かめられません: ${connection.problem}`);
    process.exitCode = 1;
    return;
  }
  console.log(`Claude Code ${connection.version}(${connection.command})`);
  console.log(`認証の見込み: ${connection.billing.text}`);
  if (!['login', 'oauth-token'].includes(connection.billing.mode) && !args.includes('--allow-api-billing')) {
    console.error('サブスクの枠ではなく、API などの料金がかかる見込みです。止めました。');
    console.error('かまわないときだけ、--allow-api-billing を付けてください。');
    process.exitCode = 1;
    return;
  }

  const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'prototype-studio-real-loop-')));
  const projectDir = path.join(home, 'projects', PROJECT);
  await fs.cp(FIXTURE, path.join(projectDir, 'app'), { recursive: true });
  await fs.mkdir(path.join(projectDir, '.studio'), { recursive: true });
  await fs.writeFile(path.join(projectDir, '.studio', 'project.json'), `${JSON.stringify({ title: PROJECT_TITLE }, null, 2)}\n`);
  console.log(`作業の場所: ${home}`);

  const events = [];
  const studio = await startStudio(
    { home, studioPort: 0, previewPort: 0, agent: 'claude', claudeBin: process.env.STUDIO_CLAUDE_BIN || null, allowClaudeCode: true, maxBudgetUsd: 1 },
    { env: process.env, onAgentEvent: (event) => events.push(event) },
  );
  // この確かめは画面を通らない。--real を付けて起動したことを、本物の AI を使う同意にする(src/server/real-ai.js)
  studio.consent.agree();
  let loop;
  let productAi;
  let outside;
  try {
    loop = await runLoop(studio, events, projectDir);
    productAi = await runProductAi(studio);
    outside = await runOutside(studio, events, home);
  } finally {
    await studio.close();
  }

  // 記録を書く。前の記録は消して書き直す
  const tmp = await fs.realpath(os.tmpdir());
  const places = [
    [home, '<作業の場所>'],
    [tmp, '<一時フォルダー>'],
    [os.tmpdir(), '<一時フォルダー>'],
    [os.homedir(), '~'],
  ];
  await fs.rm(outDir, { recursive: true, force: true });
  await fs.mkdir(path.join(outDir, 'screenshots'), { recursive: true });
  const written = [];
  const write = async (name, value) => {
    const text = typeof value === 'string' ? scrub(value, places) : `${JSON.stringify(scrub(value, places), null, 2)}\n`;
    await fs.writeFile(path.join(outDir, name), text);
    written.push(name);
  };
  await write('request.txt', `${REQUEST}\n`);
  const fixFiles = [];
  for (const round of loop.rounds.filter((r) => r.round > 1 && r.input)) {
    const name = `fix-request-${round.round - 1}.txt`;
    await write(name, `${round.input}\n`);
    fixFiles.push(name);
  }
  await write('run.json', loop.record);
  await write('run-summary.json', { ...loop.summary, items: loop.items });
  await write('agent-rounds.json', loop.rounds.map(({ input, ...round }) => ({ ...round, inputChars: input?.length ?? null })));
  await write('product-ai-trace.json', { ...productAi, shots: productAi.shots.map((file) => `screenshots/product-ai-${path.basename(file)}`) });
  await write('outside-write.json', outside);
  const shotNames = [];
  for (const shot of loop.shots) {
    const name = `round-${shot.round}-${shot.gate}-${path.basename(shot.file)}`;
    await fs.copyFile(shot.file, path.join(outDir, 'screenshots', name));
    shotNames.push(name);
  }
  for (const file of productAi.shots) {
    const name = `product-ai-${path.basename(file)}`;
    await fs.copyFile(file, path.join(outDir, 'screenshots', name)).catch(() => {});
    shotNames.push(name);
  }
  await write(
    'README.md',
    readme({ when: new Date().toISOString(), version: connection.version, billing: connection.billing.mode, loop, productAi, outside, shotNames, fixFiles }),
  );

  // 書いたものに、秘密らしい文字列と個人のデータが残っていないかを探す
  const leaks = [];
  for (const name of written) {
    const found = findLeaks(await fs.readFile(path.join(outDir, name), 'utf8'));
    for (const leak of found) leaks.push(`${name}:${leak.line} ${leak.kind}`);
  }
  console.log('');
  console.log(`記録: ${path.relative(process.cwd(), outDir) || outDir}(${written.length} 個のファイルと、スクリーンショット ${shotNames.length} 枚)`);
  if (leaks.length > 0) {
    console.error(`秘密らしい文字列か個人のデータが残っています。PR に入れないでください: ${leaks.join('、')}`);
    process.exitCode = 3;
    return;
  }
  console.log('秘密らしい文字列と個人のデータ: 見つからなかった');
  const ok =
    loop.summary.status === 'fixed' &&
    productAi.turns.length > 0 &&
    productAi.turns.every((turn) => turn.fourStages) &&
    !['unknown', 'not-stopped'].includes(outside.stop.stoppedBy);
  console.log(`作るループ ${loop.summary.status}、プロダクト内 AI の 4 つの段 ${productAi.turns.every((t) => t.fourStages) ? 'あり' : '欠けあり'}、app/ の外 ${outside.stop.stoppedBy}`);
  console.log(`作業の場所(${home})は、中身を見終えたら消してかまいません。`);
  if (!ok) process.exitCode = 2;
}

await main();
