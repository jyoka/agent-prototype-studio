import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildApp } from '../../src/server/build.js';
import { STUDIO_ROOT } from '../../src/server/config.js';
import { createMockConnection } from '../../src/server/product-ai/mock.js';
import { createMockAgent } from '../../src/server/sim/agent-mock.js';
import { recountEval } from '../../src/server/sim/eval-recount.js';
import { judgeCheck, renderReport, runEvals, summarizeGroup } from '../../src/server/sim/eval-run.js';
import { parseEval } from '../../src/server/sim/evals.js';
import { documentProblems, searchDocuments, tokensOf } from '../../src/server/sim/retrieve.js';
import { callTool, loadToolData } from '../../src/server/sim/tool-gate.js';
import { parseTools } from '../../src/server/sim/tools.js';

// 文書の検索(op: retrieve。task 421)。手元で動かし、外へ通信しない。
// 見本は samples/terms-help(架空のしおかぜ便の運送約款)。データはすべて架空

const SAMPLE = path.join(STUDIO_ROOT, 'samples', 'terms-help', 'app');
const TERMS = JSON.parse(await fs.readFile(path.join(SAMPLE, 'data', 'terms.json'), 'utf8'));

async function sampleTools() {
  const raw = JSON.parse(await fs.readFile(path.join(SAMPLE, 'tools.json'), 'utf8'));
  const { toolset, errors } = await parseTools(raw, { file: 'tools.json', appDir: SAMPLE });
  assert.deepEqual(errors, []);
  const { data, errors: dataErrors } = await loadToolData(SAMPLE, toolset);
  assert.deepEqual(dataErrors, []);
  return { toolset, data };
}

test('架空の約款で、文書の検索は問いに合う条を一番に返し、引用の文(条の見出し)を付ける', async () => {
  const { toolset, data } = await sampleTools();
  const cases = [
    ['荷物が壊れていたら、補償はいくらまでですか', 'terms-7', '第7条(壊れた荷物の補償)'],
    ['再配達は何回まで無料ですか', 'terms-4', '第4条(再配達)'],
    ['届け先が受け取りを断ったらどうなりますか', 'terms-6', '第6条(受け取りを断られたとき)'],
    ['持ち帰った荷物は何日保管しますか', 'terms-5', '第5条(保管の期間)'],
    ['生きた動物は送れますか', 'terms-2', '第2条(引き受けない荷物)'],
  ];
  for (const [question, id, cite] of cases) {
    const outcome = await callTool({ tools: toolset, data, name: 'search_terms', args: { question } });
    assert.equal(outcome.ok, true, question);
    assert.equal(outcome.result.items[0].id, id, question);
    assert.equal(outcome.result.items[0].cite, cite, question);
    assert.equal(outcome.result.items[0].text, TERMS.find((doc) => doc.id === id).text);
    // 宣言の limit(2)まで。記録には文書の id と引用の文だけを残す(本文は残さない)
    assert.ok(outcome.result.items.length <= 2);
    assert.deepEqual(outcome.entry.result.docs, outcome.result.items.map((item) => item.id));
    assert.deepEqual(outcome.entry.result.cites, outcome.result.items.map((item) => item.cite));
    assert.equal(JSON.stringify(outcome.entry).includes(outcome.result.items[0].text), false);
  }
});

test('文書の検索は、同じ問いならいつも同じ順で返し、空の問いは誤りにする', async () => {
  const { toolset, data } = await sampleTools();
  const first = searchDocuments(TERMS, '荷物の補償', { limit: 5 });
  assert.deepEqual(searchDocuments(TERMS, '荷物の補償', { limit: 5 }), first);
  // 全角と半角、大文字と小文字をそろえて数える
  assert.deepEqual(tokensOf('ＦＡＱの約款'), ['fa', 'aq', 'qの', 'の約', '約款']);
  assert.deepEqual(tokensOf('A。約款'), ['a', '約款']);
  // 合う文書がなければ 0 件
  assert.deepEqual(searchDocuments(TERMS, 'xyz'), { count: 0, items: [] });
  // 1 文字の問いは、文書の中の 1 文字ずつも数える(「金」は第2条の「現金」に当たる)
  assert.deepEqual(searchDocuments(TERMS, '金').items.map((item) => item.id), ['terms-2']);
  const empty = await callTool({ tools: toolset, data, name: 'search_terms', args: { question: '   ' } });
  assert.equal(empty.ok, false);
  assert.match(empty.error, /探したいこと/);
});

test('文書の検索の宣言とデータの形を検査する(問いの引数、id、本文の長さ)', async (t) => {
  const appDir = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-retrieve-'));
  t.after(() => fs.rm(appDir, { recursive: true, force: true }));
  await fs.mkdir(path.join(appDir, 'data'));
  await fs.writeFile(path.join(appDir, 'data', 'docs.json'), JSON.stringify([{ id: 'a', text: '本文' }, { id: 'a', text: '' }, { id: '-x', text: 'x'.repeat(2001), note: 1 }]));
  const tool = (props, extra = {}) => ({ formatVersion: 1, tools: [{ name: 'find_docs', description: '探す', inputSchema: { type: 'object', properties: props }, do: { op: 'retrieve', data: 'data/docs.json', query: 'q', ...extra } }] });
  const { errors } = await parseTools(tool({ q: { type: 'string' } }, { limit: 50 }), { file: 'tools.json', appDir });
  const text = errors.map((error) => `${error.where ?? ''} ${error.text}`).join('\n');
  assert.match(text, /「q」は、inputSchema の properties に \{ "type": "string", "maxLength": … \}/);
  assert.match(text, /1 から 20 までの整数/);
  assert.match(text, /「a」が重なっています/);
  assert.match(text, /文書の本文を書いてください/);
  assert.match(text, /2000 文字までです。条や見出しごとに分けてください/);
  assert.match(text, /「note」は書けません/);
  assert.deepEqual(documentProblems([{ id: 'ok-1', title: '見出し', text: '本文' }]), []);
  assert.deepEqual(documentProblems({ id: 'x' }), ['文書のデータは、オブジェクトの配列([{ "id": …, "title": …, "text": … }, …])にしてください']);
});

test('場面の確かめ retrieved と cited: 再現率と引用の有無を決め、文書の検索のない構成では n/a', () => {
  const step = (docs, cites) => ({ tool: 'search_terms', args: {}, result: { ok: true, docs, cites } });
  const ctx = (steps, texts, retrieve = true) => ({
    connection: 'mock',
    hasTools: true,
    toolNames: new Set(['search_terms']),
    retrieveTools: new Set(retrieve ? ['search_terms'] : []),
    steps,
    replies: texts.map((text) => ({ text })),
  });
  const found = ctx([step(['terms-7', 'terms-8'], ['第7条(壊れた荷物の補償)', '第8条(遅れたときの補償)'])], ['第7条(壊れた荷物の補償)によると 30 万円までです']);
  const both = { check: 'retrieved', docs: ['terms-7', 'terms-4'] };
  assert.deepEqual(judgeCheck(both, found).recall, { found: 1, expected: 2 });
  assert.equal(judgeCheck(both, found).verdict, 'failed');
  assert.equal(judgeCheck({ check: 'retrieved', docs: ['terms-7'] }, found).verdict, 'passed');
  assert.equal(judgeCheck({ check: 'cited' }, found).verdict, 'passed');
  // 引いたのに返事に見出しも id もない
  assert.equal(judgeCheck({ check: 'cited' }, ctx(found.steps, ['30 万円までです'])).verdict, 'failed');
  // 引いていない
  assert.equal(judgeCheck({ check: 'cited' }, ctx([], ['30 万円までです'])).actual, '文書を引いていない');
  assert.equal(judgeCheck({ check: 'retrieved', docs: ['terms-7'] }, ctx([], ['a'])).actual, '検索を呼ばなかった');
  // 守りで止まった検索は「返さなかった」と言わず、止めた守りを出す
  const blocked = { tool: 'search_terms', args: {}, result: { ok: false }, guards: [{ layer: 'tool', guard: 'maxResultChars', effect: 'blocked' }] };
  assert.equal(judgeCheck({ check: 'retrieved', docs: ['terms-7'] }, ctx([blocked], ['a'])).actual, '検索が動かなかった(search_terms(tool の maxResultChars が止めた))');
  // 引用は引用の文(見出し)で見る。記録では伏せた見出しも、返事を伏せて比べる
  const masked = ctx([step(['t1'], ['[伏せた: 電話番号] の窓口'])], ['090-1234-5678 の窓口に聞いてください']);
  assert.equal(judgeCheck({ check: 'cited' }, masked).verdict, 'passed');
  // 文書の検索でないツールを指した retrieved は n/a
  assert.equal(judgeCheck({ check: 'retrieved', tool: 'other', docs: ['a'] }, { ...ctx([], ['a']), toolNames: new Set(['search_terms', 'other']) }).verdict, 'n/a');
  // 文書の検索のない構成(RAG なし)
  for (const item of [both, { check: 'cited' }]) {
    const none = judgeCheck(item, ctx([], ['分かりません'], false));
    assert.equal(none.verdict, 'n/a');
    assert.equal(none.reason, 'この構成には文書の検索がない');
  }
  // 場面の形の検査: docs は 1 つ以上の id
  const parse = (expect) => parseEval({ formatVersion: 1, id: 'x', kind: 'question', turns: [{ user: 'a' }], expect }, { file: 'evals/x.json', toolNames: new Set(['search_terms']) });
  assert.deepEqual(parse([{ check: 'retrieved', docs: ['terms-7'] }, { check: 'cited' }]).errors, []);
  assert.equal(parse([{ check: 'retrieved', docs: [] }]).errors.length, 1);
  assert.equal(parse([{ check: 'retrieved', tool: 'nope', docs: ['a'] }]).errors.length, 1);
});

test('同じ場面を RAG ありとなしで回すと、検索の再現率と引用あり、確かめの合格に差が出る', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-rag-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  // RAG なしの構成は、見本の外(compare/)から写す(見本のどの構成も場面を全部通す決まりがあるため。reuse.test.js)
  const appDir = path.join(root, 'app');
  await fs.cp(SAMPLE, appDir, { recursive: true });
  await fs.cp(path.join(SAMPLE, '..', 'compare'), appDir, { recursive: true, filter: (from) => !from.endsWith('README.md') });
  const built = await buildApp({ appDir, buildsDir: path.join(root, 'builds') });
  assert.ok(built.ok, JSON.stringify(built.errors));
  const connection = { kind: 'mock', real: false, agent: createMockAgent(), harness: createMockConnection() };
  const { result } = await runEvals({
    simulation: built.simulation,
    aiOf: () => null,
    dataNumbers: built.dataNumbers ?? [],
    plan: { compositions: ['composition.json', 'compositions/no-rag.json'] },
    connectionFor: () => connection,
  });
  const [withRag, withoutRag] = result.groups.map((group) => group.summary);
  assert.deepEqual(withRag.retrieval, { found: 3, expected: 3, recall: 1, cited: { passed: 2, decided: 2 } });
  assert.equal(withoutRag.retrieval, undefined);
  assert.deepEqual([withRag.failed, withoutRag.failed], [0, 2]);
  const report = renderReport(result);
  const table = report.slice(report.indexOf('## 比べる表'), report.indexOf('## 点'));
  assert.match(table, /\| 検索の再現率 \| 引用あり \|/);
  assert.match(table, /\| composition\.json \/ stand-in \|.*\| 100%\(3\/3\) \| 2\/2 \|/);
  assert.match(table, /\| compositions\/no-rag\.json \/ stand-in \|.*\| - \| - \|/);
  // 文書の検索の確かめがない組だけなら、列を足さない(今の報告の形のまま。R2)
  assert.equal(summarizeGroup([]).retrieval, undefined);
  assert.doesNotMatch(renderReport({ ...result, groups: result.groups.slice(1) }), /検索の再現率 \|/);
});

test('前の回しの数え直し(eval-recount): retrieved は記録の検索の結果から決め、前の合否もそのまま使う', () => {
  const scenario = { id: 'terms-damage', kind: 'question', expect: [{ check: 'retrieved', docs: ['terms-7'] }, { check: 'cited' }] };
  const group = { connection: 'mock', toolNames: new Set(['search_terms']), retrieveTools: new Set(['search_terms']), hasHandoffs: false, recordWriters: new Map() };
  const trace = [{ steps: [{ tool: 'search_terms', args: {}, result: { ok: true, docs: ['terms-7'], cites: ['第7条(壊れた荷物の補償)'] } }] }];
  // 前の結果に確かめがない(新しく足した確かめ)
  const fresh = recountEval({ id: 'terms-damage', kind: 'question', verdict: 'passed', checks: [] }, { scenario, group, trace });
  assert.deepEqual(fresh.checks.map((c) => [c.check, c.verdict]), [['retrieved', 'passed'], ['cited', 'n/a']]);
  // 前の結果に同じ確かめがあれば、その合否を使う
  const before = { id: 'terms-damage', kind: 'question', verdict: 'passed', checks: [judgeCheck(scenario.expect[0], { connection: 'mock', toolNames: group.toolNames, retrieveTools: group.retrieveTools, steps: trace[0].steps, replies: [] }), { check: 'cited', verdict: 'passed', expected: '返事が、検索で引いた文書を引用する' }] };
  const kept = recountEval(before, { scenario, group, trace });
  assert.deepEqual(kept.checks.map((c) => [c.check, c.verdict]), [['retrieved', 'passed'], ['cited', 'passed']]);
  assert.deepEqual(summarizeGroup([kept]).retrieval, { found: 1, expected: 1, recall: 1, cited: { passed: 1, decided: 1 } });
});
