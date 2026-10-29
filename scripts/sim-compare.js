#!/usr/bin/env node
// 場面の回しの結果(npm run evals の result.json)をいくつか並べ、1 つの比べる表(4.3)と点(4.4)にする(sim-9)。
// 構成ごと、前提ごとに分けて回した結果と、--without prompt-guards の回し直しを、同じ表で読むため。モデルは呼ばない。
// 使い方: node scripts/sim-compare.js <result.json>… [--out <report.md>] [--title <題>]
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { EVAL_RUN_FORMAT, renderComparison } from '../src/server/sim/eval-run.js';

const USAGE = '使い方: node scripts/sim-compare.js <result.json>… [--out <report.md>] [--title <題>]';
let parsed;
try {
  parsed = parseArgs({ allowPositionals: true, options: { out: { type: 'string' }, title: { type: 'string' }, help: { type: 'boolean', short: 'h' } } });
} catch (error) {
  console.error(`${error.message}\n${USAGE}`);
  process.exit(3);
}
if (parsed.values.help) {
  console.log(USAGE);
  process.exit(0);
}
if (parsed.positionals.length === 0) {
  console.error(USAGE);
  process.exit(3);
}
const results = [];
for (const file of parsed.positionals) {
  const result = JSON.parse(await fs.readFile(path.resolve(file), 'utf8'));
  if (result.format !== EVAL_RUN_FORMAT) {
    console.error(`${file} は場面の回しの結果ではありません`);
    process.exit(3);
  }
  results.push(result);
}
const text = renderComparison(results, parsed.values.title ? { title: parsed.values.title } : {});
if (parsed.values.out) await fs.writeFile(path.resolve(parsed.values.out), text);
else process.stdout.write(text);
