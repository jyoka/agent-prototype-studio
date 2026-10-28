#!/usr/bin/env node
// ツールの MCP サーバー(npm run tools:mcp -- <プロジェクト>)。stdio で MCP の JSON-RPC に答える。
// 試作品の app/tools.json のツールを、ツールの口を通して出す(src/server/sim/tools-mcp.js)。
// プロジェクトと会話は、この起動の引数でだけ受け取る。標準出力は MCP のメッセージだけに使い、知らせは標準エラーに書く。
// 終了コード: 0 は入力が閉じたか時間の上限で終わった、3 は引数やプロジェクトの誤り、130 は止められた
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { studioHome } from '../src/server/config.js';
import { kindOf } from '../src/server/manifest.js';
import { isValidProjectId, projectPaths } from '../src/server/projects.js';
import { loadToolData } from '../src/server/sim/tool-gate.js';
import {
  CONVERSATION_ID_PATTERN,
  ToolsMcpError,
  ToolsSession,
  newConversationId,
  openConversation,
  serveToolsMcp,
} from '../src/server/sim/tools-mcp.js';
import { TOOLS_FILE, readTools } from '../src/server/sim/tools.js';

const EXIT_USAGE = 3;

const USAGE = [
  '使い方: npm run tools:mcp -- <プロジェクト> [--conversation <会話の ID>] [--max-seconds <秒>]',
  '',
  '  <プロジェクト>    データの置き場(STUDIO_HOME。既定は ~/PrototypeStudio)の projects/ の下の ID か、',
  '                    app/ を持つフォルダーのパス',
  '  --conversation    会話の ID(英小文字、数字、- だけで 64 字まで)。同じ ID なら、前の起動の記録の店の続きから始める。',
  '                    なければ、起動ごとに新しい会話になる',
  '  --max-seconds     サーバーの全体の時間の上限(既定は 1800 秒)。超えたら、受けた呼び出しを書き終えてから終わる',
  '',
  '標準入力と標準出力で MCP(JSON-RPC)に答えます。道具は app/tools.json(Studio が文脈で渡したときは構成の tools のファイル)のツールだけで、app/ を書き換えません。',
  '記録の店と呼び出しの記録は <プロジェクト>/.studio/sim/<会話の ID>/ に置きます。',
].join('\n');

function usageError(message) {
  console.error(`ツールのサーバーを起動できません: ${message}`);
  console.error('');
  console.error(USAGE);
  process.exit(EXIT_USAGE);
}

let parsed;
try {
  parsed = parseArgs({
    allowPositionals: true,
    options: {
      conversation: { type: 'string' },
      'max-seconds': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
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
const conversationId = parsed.values.conversation ?? newConversationId();
if (!CONVERSATION_ID_PATTERN.test(conversationId)) usageError(`--conversation の形が違います: ${JSON.stringify(conversationId)}(英小文字、数字、- だけで 64 字まで)`);

// 動き出す前に止められたときも、exit を通してロックを消す(シグナルの既定の動きでは exit を通らない)
const stopBeforeStart = () => process.exit(130);
process.on('SIGINT', stopBeforeStart);
process.on('SIGTERM', stopBeforeStart);

const isDirectory = async (dir) => (await fs.stat(dir).catch(() => null))?.isDirectory() === true;

// ID ならデータの置き場の projects/<ID>/、そうでなければフォルダーのパスとして探す(bin/observe-mcp.js と同じ)
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
const appDir = path.join(projectDir, 'app');

let conversation;
try {
  conversation = await openConversation({ projectDir, conversationId, limits });
} catch (error) {
  if (error instanceof ToolsMcpError) usageError(error.message);
  usageError(`.studio/sim/${conversationId}/ を開けません: ${String(error?.message ?? error).slice(0, 300)}`);
}
// どう終わっても、ロックと書き途中のファイルは残さない。強制終了で残ったものは、次の起動で消す
process.on('exit', conversation.release);

// ツールの宣言とデータは、起動のときに 1 回だけ読む(app/ は読むだけ)。誤りがあれば起動しない。
// 会話の進め方が文脈(.studio/sim/<会話の ID>/context.json)で構成の tools のファイルを渡したら、それを読む
const toolsFile = conversation.context?.tools ?? TOOLS_FILE;
if ((await kindOf(appDir, toolsFile)) !== 'file') usageError(`app/${toolsFile} がありません`);
const { toolset, errors } = await readTools(appDir, toolsFile);
if (!toolset) usageError(`app/${toolsFile} に誤りがあります:\n${errors.map((error) => `  ${error.text}`).join('\n')}`);
const loaded = await loadToolData(appDir, toolset);
if (loaded.errors.length > 0) usageError(`ツールのデータを読めません:\n${loaded.errors.map((error) => `  ${error.text}`).join('\n')}`);

const session = new ToolsSession({ toolset, data: loaded.data, conversation, limits });
const server = serveToolsMcp({ session, input: process.stdin, output: process.stdout, log: (message) => console.error(message) });
console.error(`ツールのサーバー: ${toolset.tools.length} 個のツール、会話 ${conversationId}(.studio/sim/${conversationId}/)`);

// 止められたときも、受けた呼び出しを書き終えてから終わる。2 回目はすぐ終わる
let stopping = false;
const stop = () => {
  if (stopping) process.exit(130);
  stopping = true;
  server.stop();
};
process.off('SIGINT', stopBeforeStart);
process.off('SIGTERM', stopBeforeStart);
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

const reason = await server.done;
// 書いた答えを出し切ってから終わる(process.exit はパイプへの出力を切ることがある)
await new Promise((resolve) => (process.stdout.destroyed ? resolve() : process.stdout.write('', resolve)));
process.exit(reason === 'stop' ? 130 : 0);
