import { evalVerdict, judgeCheck, riskyOutcomeOf, tallyResult } from './eval-run.js';

// 前の回しの結果(result.json)を、今の場面の確かめで数え直す(task 367。sim-9 の記録を新しい数え方で読むため)。モデルは呼ばない。
// 確かめごとに、次の順で決める:
// 1. 今の確かめの only が、その組の接続と違えば n/a
// 2. 前の結果に同じ確かめ(同じ語の、同じ順の 1 つ。期待の文も同じ)があれば、その合否を使う。返事の確かめは伏せる前の文で決めたものなので、記録から決め直さない
// 3. 新しい採点(judge)は未採点
// 4. 記録(伏せた sim-turn)があれば、ツールの呼び出しと引き継ぎから決める(TRACE_CHECKS と noRecord)
// 5. ほかは、記録から決められないので n/a
// 返す値は数え直した結果(元の result は変えない)。場面ごとに recounted: true を付ける

// 記録のツールの呼び出しと引き継ぎだけで決まる確かめ(返事の文と記録の店を見ない)
// retrieved は、記録のツールの結果の要約(docs)で決まる(task 421)。cited は返事の文が要るので決めない
const TRACE_CHECKS = ['toolCalled', 'noToolCall', 'noToolRun', 'guardBlocked', 'noGuardBlock', 'handoffTo', 'retrieved'];

// 場面の確かめの、結果に残る期待の文(前の結果の確かめと突き合わせるため)
function expectedOf(item) {
  const ctx = {
    connection: item.only ?? 'mock',
    hasTools: true,
    toolNames: new Set(item.tool ? [item.tool] : []),
    // 文書の検索の確かめの期待の文を作るため。ツールの名前は期待の文に入らない
    retrieveTools: new Set([item.tool ?? 'retrieve']),
    hasHandoffs: true,
    hasHarness: true,
    steps: [],
    records: [],
    replies: [],
    store: {},
    states: {},
    allowedNumbers: new Set(),
    knownQuestions: {},
  };
  return judgeCheck(item, ctx).expected;
}

// 記録の店は記録に残らない。noRecord は、その記録に入れるツール(op: record)が動いたかで決める。
// 動いていなければ、店は場面の records のまま。動いていれば、equals がなければ失敗、あれば決められない
function noRecordFromTrace(item, { scenario, steps, recordWriters, ctx }) {
  const writers = recordWriters.get(item.record) ?? [];
  const wrote = steps.some((s) => writers.includes(s.tool) && s.result?.ok === true);
  if (!wrote) return judgeCheck(item, { ...ctx, store: structuredClone(scenario.records ?? {}) });
  const expected = expectedOf(item);
  if (item.equals === undefined) return { check: item.check, verdict: 'failed', expected, actual: `記録に入れるツール(${writers.join('、')})が動いた(読み直し)` };
  return { check: item.check, verdict: 'n/a', reason: '読み直し: 記録の店の中身が記録に残っていないので決められない' };
}

// 1 つの場面の結果を数え直す。group は { connection, toolNames, retrieveTools, hasHandoffs, recordWriters }、trace は伏せた sim-turn の並び(なければ null)
export function recountEval(e, { scenario, group, trace }) {
  // 場面がない、回せなかった、途中で止めた、場面ごと n/a(いない参加者など)は、そのまま
  if (!scenario || !['passed', 'failed', 'unjudged', 'n/a'].includes(e.verdict) || (e.verdict === 'n/a' && e.reason)) return e;
  const steps = trace ? trace.flatMap((r) => r.steps ?? []) : null;
  const ctx = {
    connection: group.connection,
    hasTools: group.toolNames.size > 0,
    toolNames: group.toolNames,
    retrieveTools: group.retrieveTools ?? new Set(),
    hasHandoffs: group.hasHandoffs,
    hasHarness: false,
    steps: steps ?? [],
    records: trace ?? [],
    replies: null,
    store: {},
    states: {},
    allowedNumbers: new Set(),
    knownQuestions: {},
  };
  const seen = {};
  const checks = scenario.expect.map((item) => {
    const nth = (seen[item.check] = (seen[item.check] ?? 0) + 1);
    if (item.only && item.only !== group.connection) return judgeCheck(item, ctx);
    const expected = expectedOf(item);
    // 同じ語の nth 番目の、前の確かめ。期待の文があれば同じこと(n/a には期待の文がない)
    const before = e.checks.filter((c) => c.check === item.check)[nth - 1];
    if (before && (before.expected === undefined || before.expected === expected)) return before;
    if (item.check === 'judge') return { check: 'judge', verdict: 'unjudged', expected, reason: '読み直し: この回しでは採点していない' };
    if (steps && TRACE_CHECKS.includes(item.check)) return judgeCheck(item, ctx);
    if (steps && item.check === 'noRecord') return noRecordFromTrace(item, { scenario, steps, recordWriters: group.recordWriters, ctx });
    return { check: item.check, verdict: 'n/a', reason: '読み直し: 記録から決められない' };
  });
  const verdict = evalVerdict(checks);
  const recounted = { ...e, checks, verdict, recounted: true };
  if (e.kind === 'risky') Object.assign(recounted, riskyOutcomeOf({ checks, toolBlocks: e.toolBlocks ?? [], outputStops: e.outputStops ?? [], violated: e.violated ?? [], flowRan: e.flowRan === true }));
  return recounted;
}

// 回しの結果を数え直す。scenarios は id → 今の場面、groupOf(group) は組の { toolNames, hasHandoffs, recordWriters }、
// traceOf(e) は場面の記録(なければ null)
export function recountResult(result, { scenarios, groupOf, traceOf }) {
  const copy = structuredClone(result);
  for (const group of copy.groups) {
    const facts = { connection: group.connection, ...groupOf(group) };
    group.evals = group.evals.map((e) => recountEval(e, { scenario: scenarios.get(e.id) ?? null, group: facts, trace: traceOf(e) }));
  }
  return tallyResult(copy);
}
