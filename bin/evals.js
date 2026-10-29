#!/usr/bin/env node
// 場面の回しの CLI(npm run evals -- <プロジェクト>。docs/design/agent-simulation.md の 4.3)。
// 動いている Studio とは別に、作業中の app/ を一時フォルダーにビルドし、場面の一覧(app/evals/)を
// 構成 × 前提 × 接続 × 回数で回す。結果は <プロジェクト>/.studio/evals/<回しの ID>/ の result.json と report.md。
// 既定はモック(費用なし)。実モデル(--real)は STUDIO_ALLOW_CLAUDE_CODE=1 と --limit-usd がなければ始めない。
// 実モデルの回しでは、場面の judge を Claude Code で採点する(src/server/sim/judge.js。--skip-judge で外す)。
// 終了コード: 全部通った 0、通らない場面があった 1、上限で止めた 2、引数やプロジェクトの誤り 3、止められた 130
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';

const EXIT = { passed: 0, failed: 1, stopped: 2, usage: 3, interrupted: 130 };

const USAGE = [
  '使い方: npm run evals -- <プロジェクト> [オプション]',
  '',
  '  <プロジェクト>        データの置き場(STUDIO_HOME。既定は ~/PrototypeStudio)の projects/ の下の ID か、',
  '                        app/ を持つフォルダーのパス',
  '  --composition <並び>  回す構成のファイル(app/ からの相対。, で区切る)。既定は既定の構成',
  '  --assumptions <並び>  回す前提の id(, で区切る)。既定は構成の既定の前提',
  '  --eval <並び>         回す場面の id(, で区切る)。既定は場面の一覧の全部',
  '  --repeat <回数>       同じ組を回す回数(1 から 10。既定は 1)',
  '  --without prompt-guards  プロンプトの頼みを外して回す(効いた層を分けるため)',
  '  --real                実モデル(Claude Code)で回す。STUDIO_ALLOW_CLAUDE_CODE=1 と --limit-usd が要る',
  '  --connection <並び>   接続(mock、claude-code)。既定は mock(--real なら claude-code)',
  '  --limit-usd <USD>     実モデルの費用の上限。台帳の累計がこれに達したら、次の返事を始めずに止める',
  '  --max-launches <回数> 実モデルの起動の数の上限(既定は 200。採点の起動も数える)',
  '  --judge-model <名前>  採点(judge)のモデル(既定は Claude Code の既定のモデル)。--real のときだけ',
  '  --skip-judge          実モデルの回しで、採点(judge)をしない(未採点のまま)',
  '',
  '作業中の app/ を一時フォルダーにビルドして回します。動いている Studio の表示中のビルドには触れません。',
  '結果は <プロジェクト>/.studio/evals/<回しの ID>/ の result.json と report.md に置きます。',
].join('\n');

function usageError(message) {
  console.error(`場面を回せません: ${message}`);
  console.error('');
  console.error(USAGE);
  process.exit(EXIT.usage);
}

try {
  await import('esbuild');
} catch {
  console.error('場面を回せません: 必要な部品が入っていません。このフォルダーで npm install を実行してください。');
  process.exit(EXIT.usage);
}

const { studioHome } = await import('../src/server/config.js');
const { isValidProjectId, projectPaths } = await import('../src/server/projects.js');
const { buildApp } = await import('../src/server/build.js');
const { createMockConnection } = await import('../src/server/product-ai/mock.js');
const { CLAUDE_CODE_LIMITS, createClaudeCodeConnection } = await import('../src/server/product-ai/claude-code.js');
const { createMockAgent } = await import('../src/server/sim/agent-mock.js');
const { SIM_AGENT_LIMITS, createClaudeCodeAgent } = await import('../src/server/sim/agent-claude-code.js');
const { JUDGE_LIMITS, createClaudeCodeJudge } = await import('../src/server/sim/judge.js');
const { MODEL_NAME_PATTERN } = await import('../src/server/sim/assumptions.js');
const evalRun = await import('../src/server/sim/eval-run.js');
const { EVAL_RUN_LIMITS, EvalPlanError, createBudget, createEvalWriter, newEvalRunId, planGroups, pruneEvalRuns, runEvals } = evalRun;

let parsed;
try {
  parsed = parseArgs({
    allowPositionals: true,
    options: {
      composition: { type: 'string' },
      assumptions: { type: 'string' },
      eval: { type: 'string' },
      repeat: { type: 'string' },
      without: { type: 'string' },
      real: { type: 'boolean' },
      connection: { type: 'string' },
      'limit-usd': { type: 'string' },
      'max-launches': { type: 'string' },
      'judge-model': { type: 'string' },
      'skip-judge': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
} catch (error) {
  usageError(error.message);
}
const options = parsed.values;
if (options.help) {
  console.log(USAGE);
  process.exit(0);
}
if (parsed.positionals.length !== 1) usageError('プロジェクトを 1 つ指定してください');

const listOf = (value, name) => {
  if (value === undefined) return undefined;
  const items = value.split(',').map((item) => item.trim()).filter(Boolean);
  if (items.length === 0) usageError(`--${name} に 1 つ以上の値を書いてください`);
  return items;
};
const compositions = listOf(options.composition, 'composition');
const assumptions = listOf(options.assumptions, 'assumptions');
const evalIds = listOf(options.eval, 'eval');
const repeat = options.repeat === undefined ? 1 : Number(options.repeat);
if (!Number.isInteger(repeat) || repeat < 1 || repeat > EVAL_RUN_LIMITS.maxRepeat) usageError(`--repeat は 1 から ${EVAL_RUN_LIMITS.maxRepeat} までの整数にしてください`);
if (options.without !== undefined && options.without !== 'prompt-guards') usageError('--without に書けるのは prompt-guards だけです');
const connections = listOf(options.connection, 'connection') ?? [options.real ? 'claude-code' : 'mock'];
for (const kind of connections) {
  if (!['mock', 'claude-code'].includes(kind)) usageError(`接続「${kind}」は使えません(mock、claude-code)`);
}

// 実モデルの回しは、明示の許可と費用の上限がなければ始めない(ADR-0003。画面の同意のカードを通らないため)
const real = connections.includes('claude-code');
let limitUsd = null;
let maxLaunches = EVAL_RUN_LIMITS.maxLaunches;
if (real) {
  if (!options.real) usageError('実モデルの接続(claude-code)は、--real を付けたときだけ使えます');
  if (process.env.STUDIO_ALLOW_CLAUDE_CODE !== '1') usageError('実モデルで回すには、環境変数 STUDIO_ALLOW_CLAUDE_CODE=1 が要ります(人に頼まれたときだけ付けてください)');
  if (options['limit-usd'] === undefined) usageError('実モデルで回すには、--limit-usd で費用の上限(USD)を指定してください');
  limitUsd = Number(options['limit-usd']);
  if (!Number.isFinite(limitUsd) || limitUsd <= 0 || limitUsd > EVAL_RUN_LIMITS.limitUsdMax) usageError(`--limit-usd は 0 より大きく ${EVAL_RUN_LIMITS.limitUsdMax} 以下の数にしてください`);
  if (options['max-launches'] !== undefined) {
    maxLaunches = Number(options['max-launches']);
    if (!Number.isInteger(maxLaunches) || maxLaunches < 1 || maxLaunches > 10_000) usageError('--max-launches は 1 から 10000 までの整数にしてください');
  }
  if (options['judge-model'] !== undefined && (options['skip-judge'] || !MODEL_NAME_PATTERN.test(options['judge-model']))) {
    usageError('--judge-model には、英小文字、数字、.、- のモデルの名前を書いてください(--skip-judge とは一緒に使えません)');
  }
} else if (options.real) {
  usageError('--real と --connection mock は一緒に使えません。実モデルで回すなら --connection claude-code か、--connection を書かないでください');
} else if (options['limit-usd'] !== undefined || options['max-launches'] !== undefined || options['judge-model'] !== undefined || options['skip-judge']) {
  usageError('--limit-usd、--max-launches、--judge-model、--skip-judge は、--real のときだけ使えます');
}

const isDirectory = async (dir) => (await fs.stat(dir).catch(() => null))?.isDirectory() === true;

// ID ならデータの置き場の projects/<ID>/、そうでなければフォルダーのパスとして探す(観察の CLI と同じ)
async function resolveProject(arg) {
  if (isValidProjectId(arg)) {
    const root = projectPaths(studioHome(), arg).root;
    if (await isDirectory(path.join(root, 'app'))) return { dir: root, name: arg };
  }
  // npm run は package.json のフォルダーで動くので、相対パスは npm を呼んだフォルダー(INIT_CWD)から探す
  const root = path.resolve(process.env.INIT_CWD ?? process.cwd(), arg);
  if (await isDirectory(path.join(root, 'app'))) return { dir: root, name: path.basename(root) };
  return usageError(`プロジェクトが見つかりません: ${arg}(データの置き場の projects/ の下の ID か、app/ を持つフォルダーを指定してください)`);
}

const project = await resolveProject(parsed.positionals[0]);
const appDir = path.join(project.dir, 'app');

// 作業中の app/ を一時フォルダーにビルドする(検査、構成、ツール、前提、モック、場面を読む)
const buildsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-evals-build-'));
let build;
try {
  build = await buildApp({ appDir, buildsDir });
} finally {
  await fs.rm(buildsDir, { recursive: true, force: true });
}
if (!build.ok) {
  console.error('場面を回せません: app/ をビルドできません。直してから回してください。');
  for (const error of build.errors.slice(0, 5)) console.error(`  ${error.file}${error.line ? `:${error.line}` : ''} ${error.text}`);
  process.exit(EXIT.usage);
}
const { simulation } = build;
if (!simulation?.composition) usageError('この試作品には AI がありません(app/composition.json も app/ai.json もありません)');
if ((simulation.evals ?? []).length === 0) {
  console.log(`場面がありません(app/${build.manifest.evals ?? 'evals'}/)。回すものはありません。`);
  process.exit(EXIT.passed);
}
// --eval で、回す場面を id で絞る(実モデルで一部だけを回すため)。ない id は誤り
if (evalIds) {
  const known = new Set(simulation.evals.map(({ scenario }) => scenario.id));
  const unknown = evalIds.filter((id) => !known.has(id));
  if (unknown.length > 0) usageError(`場面「${unknown.join('、')}」はありません(app/${build.manifest.evals ?? 'evals'}/ の id を書いてください)`);
  simulation.evals = simulation.evals.filter(({ scenario }) => evalIds.includes(scenario.id));
}
const aiOf = (file) => simulation.harnessAis?.[file] ?? (file === build.manifest.ai ? build.ai : null);

const env = process.env;
const made = new Map();
function connectionFor(kind) {
  if (!made.has(kind)) {
    made.set(
      kind,
      kind === 'mock'
        ? { kind, real: false, agent: createMockAgent(), harness: createMockConnection() }
        : {
            kind,
            real: true,
            agent: createClaudeCodeAgent({ env }),
            harness: createClaudeCodeConnection({ env, allowed: true }),
            // 費用の分からない失敗した起動に数える額(1 回の起動の上限)
            launchCapUsd: Math.max(SIM_AGENT_LIMITS.maxBudgetUsd, CLAUDE_CODE_LIMITS.maxBudgetUsd),
          },
    );
  }
  return made.get(kind);
}

// 組を先に確かめる(誤りなら、結果のフォルダーを作らずに終わる)
try {
  planGroups(simulation, { compositions, assumptions, connections, repeat });
} catch (error) {
  if (error instanceof EvalPlanError) usageError(error.message);
  throw error;
}

const id = newEvalRunId();
const evalsDir = path.join(project.dir, '.studio', 'evals');
let writer;
try {
  writer = await createEvalWriter({ root: project.dir, parts: ['.studio', 'evals', id] });
} catch (error) {
  console.error(`場面を回せません: 結果を書く場所を作れません(${error.message})`);
  process.exit(EXIT.usage);
}
// 採点の接続(実モデルの回しだけ)。費用の分からない失敗した採点は、1 回の採点の上限を数える
const judge = real && !options['skip-judge'] ? Object.assign(createClaudeCodeJudge({ env, model: options['judge-model'] ?? null }), { launchCapUsd: JUDGE_LIMITS.maxBudgetUsd }) : null;
const budget = real ? createBudget({ ledgerFile: path.join(evalsDir, 'ledger.jsonl'), runId: id, limitUsd, maxLaunches }) : null;

const controller = new AbortController();
let interrupted = false;
const stop = () => {
  if (interrupted) process.exit(EXIT.interrupted);
  interrupted = true;
  console.error('止めています…(今の返事が終わったら、それまでの結果を書きます)');
  controller.abort();
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

const how = real ? `実モデル(Claude Code。上限 ${limitUsd} USD、起動 ${maxLaunches} 回まで)` : 'モック(費用なし)';
console.log(`場面を回しています: ${project.name}(${simulation.evals.length} 本。${how})`);
let ran;
try {
  ran = await runEvals({
    simulation,
    aiOf,
    dataNumbers: build.dataNumbers ?? [],
    appDigest: build.appDigest,
    project: project.name,
    plan: { compositions, assumptions, connections, repeat },
    connectionFor,
    withoutPromptGuards: options.without === 'prompt-guards',
    projectDir: project.dir,
    budget,
    judge,
    signal: controller.signal,
    id,
    onEval: (result, traces) => writer.write(result, traces),
  });
} catch (error) {
  if (error instanceof EvalPlanError) usageError(error.message);
  console.error(`場面を回せませんでした: ${error?.message ?? error}`);
  process.exitCode = EXIT.failed;
} finally {
  for (const connection of made.values()) {
    await connection.agent.close?.();
    await connection.harness.close?.();
  }
  await judge?.close();
}
if (ran) {
  const { result, traces } = ran;
  await writer.write(result, traces, { report: true });
  await pruneEvalRuns(evalsDir, id).catch(() => {});
  const t = result.totals;
  const lines = [
    '',
    `結果: ${result.verdict}(通った ${t.passed}、失敗 ${t.failed}、回せなかった ${t.errors}、n/a ${t.notApplicable}、未採点だけ ${t.unjudged}${t.stopped ? `、途中で止めた ${t.stopped}` : ''})`,
  ];
  if (result.stopReason) lines.push(`${result.status === 'error' ? '失敗の理由' : '止めた理由'}: ${result.stopReason}`);
  if (real) {
    lines.push(`費用: 会話 ${t.costUsd.toFixed(4)} USD(起動 ${t.launches} 回)、採点 ${t.judgeCostUsd.toFixed(4)} USD(起動 ${t.judgeLaunches} 回)。台帳: ${path.join(evalsDir, 'ledger.jsonl')}`);
  }
  for (const failure of evalRun.failuresOf(result).slice(0, 10)) {
    lines.push(`  失敗 ${failure.eval}${failure.check ? ` の ${failure.check}` : ''}: ${failure.actual ?? ''}`);
  }
  lines.push(`result: ${path.join(writer.dir, 'result.json')}`, `report: ${path.join(writer.dir, 'report.md')}`);
  console.log(lines.join('\n'));
  if (interrupted) process.exitCode = EXIT.interrupted;
  else process.exitCode = EXIT[result.verdict] ?? EXIT.failed;
}
