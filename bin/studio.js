#!/usr/bin/env node
// Prototype Studio の起動。失敗したときは、利用者が次に何をすればよいかを出す。
import { spawn } from 'node:child_process';

const MIN_NODE_MAJOR = 22;

function fail(lines) {
  console.error('');
  for (const line of lines) console.error(line);
  console.error('');
  process.exit(1);
}

const nodeMajor = Number(process.versions.node.split('.')[0]);
if (nodeMajor < MIN_NODE_MAJOR) {
  fail([
    `Prototype Studio を起動できません: Node.js ${MIN_NODE_MAJOR} 以上が要ります(今は ${process.versions.node})。`,
    'https://nodejs.org/ から LTS 版を入れてから、もう一度 npm start を実行してください。',
  ]);
}

try {
  await import('esbuild');
  await import('playwright-core');
} catch {
  fail([
    'Prototype Studio を起動できません: 必要な部品が入っていません。',
    'このフォルダーで npm install を実行してから、もう一度 npm start を実行してください。',
  ]);
}

const { ConfigError, loadConfig } = await import('../src/server/config.js');
const { HomeNotWritableError, PortInUseError, startStudio } = await import('../src/server/index.js');

function envExample(name, value) {
  return process.platform === 'win32'
    ? `PowerShell なら $env:${name}=${value}; npm start`
    : `${name}=${value} npm start`;
}

function openBrowser(url) {
  const [command, args, options] =
    process.platform === 'darwin'
      ? ['open', [url], {}]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '""', `"${url}"`], { windowsVerbatimArguments: true }]
        : ['xdg-open', [url], {}];
  const child = spawn(command, args, { stdio: 'ignore', detached: true, ...options });
  child.on('error', () => console.log('ブラウザを自動で開けませんでした。上の URL をブラウザに貼り付けてください。'));
  child.unref();
}

let config;
try {
  config = loadConfig();
} catch (error) {
  if (error instanceof ConfigError) fail([`Prototype Studio を起動できません: ${error.message}`]);
  throw error;
}

console.log('Prototype Studio を起動しています…');
let studio;
try {
  studio = await startStudio(config, { log: (line) => console.log(line) });
} catch (error) {
  if (error instanceof PortInUseError) {
    fail([
      `Prototype Studio を起動できません: ${error.message}。`,
      '別のターミナルで Studio が動いていないか確かめてください。動いていれば、そちらを使うか Ctrl+C で止めてください。',
      `他のアプリが使っているときは、${error.envName} で別の番号を指定してください(例: ${envExample(error.envName, 4327)})。`,
    ]);
  }
  if (error instanceof HomeNotWritableError) {
    fail([
      `Prototype Studio を起動できません: ${error.message}。`,
      `STUDIO_HOME で書き込める場所を指定してください(例: ${envExample('STUDIO_HOME', '<書き込めるフォルダー>')})。`,
    ]);
  }
  if (error.code === 'EACCES') {
    fail([
      `Prototype Studio を起動できません: ポートを使う許可がありません(${error.message})。`,
      `STUDIO_PORT と STUDIO_PREVIEW_PORT で別の番号を指定してください(例: ${envExample('STUDIO_PORT', 4327)})。`,
    ]);
  }
  throw error;
}

console.log('');
console.log('Prototype Studio を起動しました。');
console.log('ブラウザで次の URL を開いてください(自動で開かないとき):');
console.log(`  ${studio.url}`);
console.log(`データの置き場: ${config.home}`);
const { connection } = studio;
if (connection.kind === 'fake') {
  console.log('作る AI: 偽接続(STUDIO_AGENT=fake。決まった応答だけ。Claude Code とモデルは呼びません)');
} else if (connection.problem) {
  console.log(`作る AI: Claude Code を使えません。${connection.problem}`);
  if (connection.mode === 'auto') console.log('  試す、保存、本番開発への引き継ぎは使えます。');
} else {
  console.log(`作る AI: Claude Code ${connection.version}(${connection.command})`);
  console.log(`  ${connection.billing.text}`);
}
if (config.allowClaudeCode) {
  console.log('本物の AI(Claude Code)は、画面で送るものと料金を確かめて同意してから使います。同意は Studio を止めるまで有効です。');
} else {
  console.log('試作品の中の AI は、お試しの AI(モック)だけで動きます(STUDIO_ALLOW_CLAUDE_CODE=0)。');
}
console.log('止めるときは、このターミナルで Ctrl+C を押してください。');
console.log('');
if (config.openBrowser) openBrowser(studio.url);

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await studio.close();
  console.log('Prototype Studio を止めました。');
  process.exit(0);
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
// ターミナルを閉じたとき
process.on('SIGHUP', stop);
// 例外などで、止める手順を待たずに終わるとき。作る AI は別のプロセスグループなので、残さず止める
process.on('exit', () => studio.requests.killAllSync());
