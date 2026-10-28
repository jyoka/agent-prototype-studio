#!/usr/bin/env node
// 観察の道具の MCP サーバー(npm run observe:mcp -- <プロジェクト>)。stdio で MCP の JSON-RPC に答える。
// 作業中の app/ を一時フォルダーにビルドして観察する道具を、決まった名前で出す(src/server/observe-mcp.js)。
// プロジェクトの場所は、この起動の引数でだけ受け取る。標準出力は MCP のメッセージだけに使い、知らせは標準エラーに書く。
// 終了コード: 0 は入力が閉じたか時間の上限で終わった、3 は引数やプロジェクトの誤り
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';

const EXIT_USAGE = 3;

const USAGE = [
  '使い方: npm run observe:mcp -- <プロジェクト> [--max-seconds <秒>]',
  '',
  '  <プロジェクト>   データの置き場(STUDIO_HOME。既定は ~/PrototypeStudio)の projects/ の下の ID か、',
  '                   app/ を持つフォルダーのパス',
  '  --max-seconds    サーバーの全体の時間の上限(既定は 1800 秒)。超えたらブラウザと一時フォルダーを片付けて終わる',
  '',
  '標準入力と標準出力で MCP(JSON-RPC)に答えます。道具は app/ を書き換えません。',
  'report とスクリーンショットは <プロジェクト>/.studio/observations/<観察の ID>/ に置きます。',
].join('\n');

function usageError(message) {
  console.error(`観察の道具のサーバーを起動できません: ${message}`);
  console.error('');
  console.error(USAGE);
  process.exit(EXIT_USAGE);
}

try {
  await import('esbuild');
  await import('playwright-core');
} catch {
  console.error('観察の道具のサーバーを起動できません: 必要な部品が入っていません。このフォルダーで npm install を実行してください。');
  process.exit(EXIT_USAGE);
}

const { studioHome } = await import('../src/server/config.js');
const { serveObserveMcp } = await import('../src/server/observe-mcp.js');
const { removeUnfinishedSync } = await import('../src/server/observe-entry.js');
const { isValidProjectId, projectPaths } = await import('../src/server/projects.js');

let parsed;
try {
  parsed = parseArgs({
    allowPositionals: true,
    options: { 'max-seconds': { type: 'string' }, help: { type: 'boolean', short: 'h' } },
  });
} catch (error) {
  usageError(error.message);
}
if (parsed.values.help) {
  console.error(USAGE);
  process.exit(0);
}
if (parsed.positionals.length !== 1) usageError('プロジェクトを 1 つ指定してください');

const limits = {};
if (parsed.values['max-seconds'] !== undefined) {
  const seconds = Number(parsed.values['max-seconds']);
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 24 * 60 * 60) usageError('--max-seconds は 1 から 86400 の秒で指定してください');
  limits.serverMs = Math.round(seconds * 1000);
}

const isDirectory = async (dir) => (await fs.stat(dir).catch(() => null))?.isDirectory() === true;

// ID ならデータの置き場の projects/<ID>/、そうでなければフォルダーのパスとして探す(CLI の bin/observe.js と同じ)
async function resolveProject(arg) {
  if (isValidProjectId(arg)) {
    const root = projectPaths(studioHome(), arg).root;
    if (await isDirectory(path.join(root, 'app'))) return root;
  }
  const root = path.resolve(process.env.INIT_CWD ?? process.cwd(), arg);
  if (await isDirectory(path.join(root, 'app'))) return root;
  return usageError(`プロジェクトが見つかりません: ${arg}(データの置き場の projects/ の下の ID か、app/ を持つフォルダーを指定してください)`);
}

const projectDir = await resolveProject(parsed.positionals[0]);
const server = serveObserveMcp({
  projectDir,
  input: process.stdin,
  output: process.stdout,
  limits,
  log: (message) => console.error(message),
});

// どう終わっても(Playwright の SIGINT の処理が先に process.exit を呼ぶときも)、一時フォルダーと report のない観察のフォルダーは残さない
process.on('exit', () => removeUnfinishedSync());

// 止められたときも、ブラウザと一時フォルダーを片付けてから終わる。2 回目はすぐ終わる
let stopping = false;
const stop = () => {
  if (stopping) {
    removeUnfinishedSync();
    process.exit(130);
  }
  stopping = true;
  server.stop();
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

const reason = await server.done;
// 片付けの後に残ったもの(終わらなかった観察)は消す。ブラウザは Playwright がプロセスの終わりに止める
removeUnfinishedSync();
// 書いた答えを出し切ってから終わる(process.exit はパイプへの出力を切ることがある)
await new Promise((resolve) => (process.stdout.destroyed ? resolve() : process.stdout.write('', resolve)));
process.exit(reason === 'stop' ? 130 : 0);
