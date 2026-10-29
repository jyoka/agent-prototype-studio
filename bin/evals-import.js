#!/usr/bin/env node
// jyoka/tasks#327 の場面の一覧(aica の evals/scenes/)を、Studio の場面(app/evals/*.json)に変換して書く
// (npm run evals:import。docs/design/agent-simulation.md の 4.2)。変換は src/server/sim/eval-import.js。
// 変換できない確かめは場面に入れず、終わりに一覧で出す。題材の言葉(入り口の名前、観点の文)は引数で渡す。
// 終了コード: 書いた 0、書けるものがなかった 1、引数の誤り 3
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { importScenes } from '../src/server/sim/eval-import.js';

const USAGE = [
  '使い方: npm run evals:import -- <場面の JSON かフォルダー>… --out <書くフォルダー> [オプション]',
  '',
  '  <場面の JSON かフォルダー>  #327 の形の場面の配列を持つ JSON。フォルダーなら、その下の *.json を全部読む',
  '  --out <フォルダー>          変換した場面を書くフォルダー(試作品の app/evals/ の下など)。同じ名前のファイルがあれば書かない',
  '  --entry <入り口=参加者>     入り口を構成の参加者に当てる(, で区切る。例: baito=partner)。書かない入り口は回し手から始める',
  '  --kind <種類=場面の種類>    種類を Studio の場面の種類に当てる(, で区切る。例: t326=control)',
  '  --rubrics <JSON>            採点の条件の名前と観点の文({ 名前: 文 })。書いていない採点の条件は変換しない',
  '  --prefix <語>               場面の id の頭に付ける語(例: aica-)',
  '  --pass-at-least <点>        採点の合格の点(1 から 5。既定は 4)',
  '  --report <JSON>             変換の結果(書いた場面、飛ばした場面、変換できない確かめ)を書くファイル',
].join('\n');

function usageError(message) {
  console.error(`場面を取り込めません: ${message}`);
  console.error('');
  console.error(USAGE);
  process.exit(3);
}

let parsed;
try {
  parsed = parseArgs({
    allowPositionals: true,
    options: {
      out: { type: 'string' },
      entry: { type: 'string' },
      kind: { type: 'string' },
      rubrics: { type: 'string' },
      prefix: { type: 'string' },
      'pass-at-least': { type: 'string' },
      report: { type: 'string' },
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
if (parsed.positionals.length === 0) usageError('場面の JSON かフォルダーを 1 つ以上指定してください');
if (!options.out) usageError('--out で書くフォルダーを指定してください');

// npm run は package.json のフォルダーで動くので、相対パスは npm を呼んだフォルダー(INIT_CWD)から読む
const resolve = (file) => path.resolve(process.env.INIT_CWD ?? process.cwd(), file);
const pairs = (value, name) => {
  const map = {};
  for (const item of (value ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const [key, to, ...rest] = item.split('=');
    if (!key || !to || rest.length > 0) usageError(`--${name} は「名前=値」を , で区切って書いてください`);
    map[key] = to;
  }
  return map;
};
const passAtLeast = options['pass-at-least'] === undefined ? 4 : Number(options['pass-at-least']);
if (!Number.isInteger(passAtLeast) || passAtLeast < 1 || passAtLeast > 5) usageError('--pass-at-least は 1 から 5 の整数にしてください');
let rubrics = {};
if (options.rubrics) {
  try {
    rubrics = JSON.parse(await fs.readFile(resolve(options.rubrics), 'utf8'));
  } catch (error) {
    usageError(`--rubrics を読めません(${error.message})`);
  }
  if (!rubrics || typeof rubrics !== 'object' || Array.isArray(rubrics)) usageError('--rubrics は { 名前: 観点の文 } の JSON にしてください');
}

async function jsonFiles(target) {
  const stat = await fs.stat(target).catch(() => null);
  if (!stat) usageError(`見つかりません: ${target}`);
  if (stat.isFile()) return [target];
  const found = [];
  for (const entry of await fs.readdir(target, { withFileTypes: true, recursive: true })) {
    if (entry.isFile() && entry.name.endsWith('.json')) found.push(path.join(entry.parentPath ?? entry.path, entry.name));
  }
  return found.sort();
}

const scenes = [];
for (const source of parsed.positionals) {
  for (const file of await jsonFiles(resolve(source))) {
    let value;
    try {
      value = JSON.parse(await fs.readFile(file, 'utf8'));
    } catch (error) {
      usageError(`${file} を JSON として読めません(${error.message})`);
    }
    if (!Array.isArray(value)) usageError(`${file} は場面の配列ではありません`);
    scenes.push(...value);
  }
}

const result = importScenes(scenes, { entries: pairs(options.entry, 'entry'), kinds: pairs(options.kind, 'kind'), rubrics, prefix: options.prefix ?? '', passAtLeast });
const outDir = resolve(options.out);
await fs.mkdir(outDir, { recursive: true });
const written = [];
for (const { file, scenario } of result.evals) {
  const target = path.join(outDir, file);
  if (await fs.stat(target).catch(() => null)) {
    result.skipped.push({ id: scenario.id, reason: `${file} がもうあるので書かなかった` });
    continue;
  }
  await fs.writeFile(target, `${JSON.stringify(scenario, null, 2)}\n`);
  written.push(file);
}

const checks = result.evals.reduce((n, e) => n + e.scenario.expect.length, 0);
console.log(`場面を ${scenes.length} 本読み、${written.length} 本を書きました(${outDir})。変換した確かめ ${checks}、変換できない確かめ ${result.unconverted.length}、飛ばした場面 ${result.skipped.length}。`);
const byCheck = {};
for (const item of result.unconverted) byCheck[item.check] = (byCheck[item.check] ?? 0) + 1;
if (Object.keys(byCheck).length > 0) {
  console.log(`変換できない確かめ: ${Object.entries(byCheck).sort((a, b) => b[1] - a[1]).map(([name, n]) => `${name} ${n}`).join('、')}`);
}
for (const item of result.skipped.slice(0, 20)) console.log(`  飛ばした ${item.id}: ${item.reason}`);
if (options.report) {
  await fs.writeFile(resolve(options.report), `${JSON.stringify({ source: parsed.positionals, written, ...result, evals: undefined }, null, 2)}\n`);
}
process.exit(written.length > 0 ? 0 : 1);
