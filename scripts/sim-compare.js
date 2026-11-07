#!/usr/bin/env node
// 場面の回しの結果(npm run evals の result.json)をいくつか並べ、1 つの比べる表(4.3)と点(4.4)にする(sim-9)。
// 構成ごと、前提ごとに分けて回した結果と、--without prompt-guards の回し直しを、同じ表で読むため。モデルは呼ばない。
// --recount <app/> を付けると、その app/ の今の場面の確かめで数え直してから並べる(task 367。前の回しを新しい数え方で読むため)。
// 数え直しは src/server/sim/eval-recount.js。記録(result.json の隣の traces/)があれば、ツールの呼び出しから新しい確かめを決める
// 使い方: node scripts/sim-compare.js <result.json>… [--recount <app/>] [--out <report.md>] [--title <題>]
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { EVAL_RUN_FORMAT, renderComparison } from '../src/server/sim/eval-run.js';
import { recountResult } from '../src/server/sim/eval-recount.js';
import { readEvals } from '../src/server/sim/evals.js';

const USAGE = '使い方: node scripts/sim-compare.js <result.json>… [--recount <app/>] [--out <report.md>] [--title <題>]';
let parsed;
try {
  parsed = parseArgs({ allowPositionals: true, options: { out: { type: 'string' }, title: { type: 'string' }, recount: { type: 'string' }, help: { type: 'boolean', short: 'h' } } });
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
const readJson = async (file) => JSON.parse(await fs.readFile(file, 'utf8'));

// 数え直しに使う、今の app/ の場面と、組ごとの構成のツールと引き継ぎ
async function recounter(appDir) {
  const manifest = await readJson(path.join(appDir, 'prototype.json')).catch(() => ({}));
  // 場面の検査に使うツールの名前: 構成(composition.json と compositions/)が指すツールの宣言の全部
  const compositionFiles = ['composition.json', ...(await fs.readdir(path.join(appDir, 'compositions')).catch(() => [])).filter((f) => f.endsWith('.json')).map((f) => `compositions/${f}`)];
  const toolFiles = new Set();
  for (const file of compositionFiles) {
    const composition = await readJson(path.join(appDir, file)).catch(() => null);
    if (typeof composition?.tools === 'string') toolFiles.add(composition.tools);
  }
  const toolNames = new Set();
  for (const file of toolFiles) for (const tool of (await readJson(path.join(appDir, file))).tools ?? []) toolNames.add(tool.name);
  const { evals, errors } = await readEvals(appDir, manifest.evals ?? 'evals', { toolNames });
  if (errors.length > 0) {
    console.error(`場面を読めません: ${errors.map((e) => `${e.file} ${e.text}`).join(' / ')}`);
    process.exit(3);
  }
  const scenarios = new Map(evals.map(({ scenario }) => [scenario.id, scenario]));
  // 構成のファイル → { toolNames, retrieveTools, hasHandoffs, recordWriters }。構成のファイルのない組(構成 B の読み替え)は、ツールも引き継ぎもない
  const facts = new Map([[null, { toolNames: new Set(), retrieveTools: new Set(), hasHandoffs: false, recordWriters: new Map() }]]);
  const factsOf = async (file) => {
    if (facts.has(file)) return;
    const composition = await readJson(path.join(appDir, file));
    const tools = composition.tools ? (await readJson(path.join(appDir, composition.tools))).tools ?? [] : [];
    const recordWriters = new Map();
    for (const tool of tools.filter((t) => t.do?.op === 'record')) recordWriters.set(tool.do.into, [...(recordWriters.get(tool.do.into) ?? []), tool.name]);
    const toolNames = new Set(composition.participants.flatMap((p) => p.tools ?? []));
    // 文書の検索(op: retrieve)のツール。retrieved を記録から決め直すため(task 421)
    const retrieveTools = new Set(tools.filter((t) => t.do?.op === 'retrieve' && toolNames.has(t.name)).map((t) => t.name));
    facts.set(file, { toolNames, retrieveTools, hasHandoffs: (composition.handoffs ?? []).length > 0, recordWriters });
  };
  return async (result, dir) => {
    for (const group of result.groups) await factsOf(group.composition.file ?? null);
    const traces = new Map();
    for (const e of result.groups.flatMap((g) => g.evals)) {
      if (!e.trace || traces.has(e.trace)) continue;
      traces.set(e.trace, await readJson(path.join(dir, e.trace)).catch(() => null));
    }
    return recountResult(result, { scenarios, groupOf: (group) => facts.get(group.composition.file ?? null), traceOf: (e) => traces.get(e.trace) ?? null });
  };
}

const recount = parsed.values.recount ? await recounter(path.resolve(parsed.values.recount)) : null;
const results = [];
for (const file of parsed.positionals) {
  const result = await readJson(path.resolve(file));
  if (result.format !== EVAL_RUN_FORMAT) {
    console.error(`${file} は場面の回しの結果ではありません`);
    process.exit(3);
  }
  results.push(recount ? await recount(result, path.dirname(path.resolve(file))) : result);
}
const text = renderComparison(results, parsed.values.title ? { title: parsed.values.title } : {});
if (parsed.values.out) await fs.writeFile(path.resolve(parsed.values.out), text);
else process.stdout.write(text);
