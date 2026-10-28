#!/usr/bin/env node
// 観察の CLI(npm run observe -- <プロジェクト>)。動いている Studio とは別に、作業中の app/ を一時フォルダーに
// ビルドして観察する。Studio の観察と同じ入口(src/server/observe-entry.js)を使い、同じ形の report を書く。
// プロダクト内 AI はいつもモック。実モデルは選べない。
// 終了コード: passed は 0、failed は 1、unverified(観察できなかった)は 2、引数やプロジェクトの誤りは 3
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';

const EXIT = { passed: 0, failed: 1, unverified: 2, usage: 3 };
const MAX_LISTED_ERRORS = 5;

const USAGE = [
  '使い方: npm run observe -- <プロジェクト> [--viewports mobile,tablet,desktop]',
  '',
  '  <プロジェクト>  データの置き場(STUDIO_HOME。既定は ~/PrototypeStudio)の projects/ の下の ID か、',
  '                  app/ を持つフォルダーのパス',
  '  --viewports     スクリーンショットを撮る画面幅(既定は mobile,tablet,desktop)',
  '',
  '作業中の app/ を一時フォルダーにビルドして観察します。動いている Studio の表示中のビルドには触れません。',
  'report とスクリーンショットは <プロジェクト>/.studio/observations/<観察の ID>/ に置きます。',
].join('\n');

function usageError(message) {
  console.error(`観察できません: ${message}`);
  console.error('');
  console.error(USAGE);
  process.exit(EXIT.usage);
}

try {
  await import('esbuild');
  await import('playwright-core');
} catch {
  console.error('観察できません: 必要な部品が入っていません。このフォルダーで npm install を実行してください。');
  process.exit(EXIT.usage);
}

const { studioHome } = await import('../src/server/config.js');
const { VIEWPORTS } = await import('../src/observer/observe.js');
const { observeProject, removeUnfinishedSync } = await import('../src/server/observe-entry.js');
const { isValidProjectId, projectPaths } = await import('../src/server/projects.js');

let parsed;
try {
  parsed = parseArgs({
    allowPositionals: true,
    options: { viewports: { type: 'string' }, help: { type: 'boolean', short: 'h' } },
  });
} catch (error) {
  usageError(error.message);
}
if (parsed.values.help) {
  console.log(USAGE);
  process.exit(0);
}
if (parsed.positionals.length !== 1) usageError('プロジェクトを 1 つ指定してください');

const viewports = (parsed.values.viewports ?? 'mobile,tablet,desktop').split(',').map((name) => name.trim()).filter(Boolean);
for (const name of viewports) {
  if (!Object.hasOwn(VIEWPORTS, name)) usageError(`画面幅の名前が正しくありません: ${name}(${Object.keys(VIEWPORTS).join('、')} から選ぶ)`);
}

const isDirectory = async (dir) => (await fs.stat(dir).catch(() => null))?.isDirectory() === true;

// ID ならデータの置き場の projects/<ID>/、そうでなければフォルダーのパスとして探す
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

// Ctrl+C で止めたときも、一時フォルダーと、report のない観察のフォルダーは残さない
const interrupted = () => {
  removeUnfinishedSync();
  console.error('観察を止めました。');
  process.exit(130);
};
process.on('SIGINT', interrupted);
process.on('SIGTERM', interrupted);

console.log(`観察しています: ${project.name}(作業中の app/ を一時フォルダーにビルドして見ます。プロダクト内 AI はモック)`);
let observed;
try {
  observed = await observeProject({
    projectDir: project.dir,
    mode: 'working',
    viewports,
    aiConnection: 'mock',
  });
} catch (error) {
  // .studio/ に書けないときなど。観察の合否は分からない
  console.error(`観察できませんでした: ${error?.message ?? error}`);
  process.exit(EXIT.unverified);
}
const { report, dir, reportFile } = observed;

const VERDICT_TEXT = { passed: '通った', failed: '失敗あり', unverified: '未確認(観察できなかった)' };
const lines = ['', `結果: ${report.verdict}(${VERDICT_TEXT[report.verdict] ?? report.verdict})`];
if (report.reason) lines.push(`理由: ${report.reason}`);
lines.push(`エラー: ${report.errors.length} 件`);
for (const error of report.errors.slice(0, MAX_LISTED_ERRORS)) {
  const where = error.file ? ` ${error.file}${error.line ? `:${error.line}` : ''}` : '';
  lines.push(`  [${error.kind}]${where} ${error.message.split('\n')[0]}`);
}
if (report.errors.length > MAX_LISTED_ERRORS) lines.push(`  ほか ${report.errors.length - MAX_LISTED_ERRORS} 件は report を見てください`);
const passedCount = report.scenarios.filter((scenario) => scenario.verdict === 'passed').length;
lines.push(`シナリオ: ${report.scenarios.length} 本のうち ${passedCount} 本が通った`);
for (const scenario of report.scenarios) {
  const mark = scenario.verdict === 'passed' ? '通った' : '失敗  ';
  const where = scenario.base ? '基本' : (scenario.file ?? 'app/');
  lines.push(`  ${mark} ${scenario.name}(${where})`);
  if (scenario.failed) lines.push(`         手順 ${scenario.failed.step ?? '-'}: ${scenario.failed.message}`);
}
lines.push(`report: ${reportFile}`);
const pictures = (await fs.readdir(dir).catch(() => [])).filter((name) => name.endsWith('.png')).sort();
lines.push(`スクリーンショット: ${pictures.length} 枚${pictures.length > 0 ? `(${dir})` : ''}`);
for (const name of pictures) lines.push(`  ${path.join(dir, name)}`);
console.log(lines.join('\n'));

// 出力を出し切ってから終わる(process.exit はパイプへの出力を切ることがある)
process.exitCode = EXIT[report.verdict] ?? EXIT.unverified;
