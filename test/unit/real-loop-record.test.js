import assert from 'node:assert/strict';
import test from 'node:test';
import { agentRoundsOf, classifyOutsideStop, findLeaks, productAiTurnsOf, scrub, summarizeRun } from '../../scripts/real-loop-record.js';

// 実モデルの閉じたループの記録(scripts/check-loop.js)を作る部品。モデルも Studio も呼ばない。架空の値だけを使う
const APP = '/tmp/studio-home/projects/loop-broken/app';

const message = (round, msg) => ({ runId: 'r1', round, type: 'message', message: msg });
const toolUse = (id, name, input) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } });
const toolResult = (id, content, isError = false) => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }] } });
const result = (extra = {}) => ({ type: 'result', subtype: 'success', is_error: false, result: '終わりました', total_cost_usd: 0.12, duration_ms: 30_000, duration_api_ms: 25_000, num_turns: 6, permission_denials: [], ...extra });

test('作る AI のラウンドごとに、渡した文、費用、観察の道具とその結果(見たもの)を数える', () => {
  const events = [
    { runId: 'r1', round: 1, type: 'input', text: '見出しを変えて' },
    message(1, { type: 'system', subtype: 'init', model: 'claude-test' }),
    message(1, toolUse('a', 'Edit', { file_path: 'App.jsx' })),
    message(1, toolResult('a', 'ok')),
    message(1, toolUse('b', 'mcp__observe__open', { viewport: 'desktop' })),
    message(1, toolResult('b', [{ type: 'text', text: '{"opened": true}' }, { type: 'image', source: {} }])),
    message(1, result()),
    { runId: 'r1', round: 2, type: 'input', text: '前の依頼: 見出しを変えて\n…' },
    message(2, toolUse('c', 'mcp__observe__open', { viewport: 'mobile' })),
    message(2, toolResult('c', 'TypeError: 架空のエラー', true)),
    message(2, toolUse('d', 'mcp__observe__read_page', {})),
    message(2, result({ total_cost_usd: 0.2 })),
  ];
  const rounds = agentRoundsOf(events);
  assert.equal(rounds.length, 2);
  assert.equal(rounds[0].input, '見出しを変えて');
  assert.equal(rounds[0].model, 'claude-test');
  assert.equal(rounds[0].result.costUsd, 0.12);
  assert.equal(rounds[0].toolCount, 2);
  assert.deepEqual(rounds[0].observe.byTool, { mcp__observe__open: 1 });
  assert.equal(rounds[0].observe.calls[0].images, 1);
  assert.match(rounds[0].observe.calls[0].result, /opened/);
  assert.deepEqual(rounds[1].observe.byTool, { mcp__observe__open: 1, mcp__observe__read_page: 1 });
  assert.equal(rounds[1].observe.calls[0].isError, true);
  assert.equal(rounds[1].result.costUsd, 0.2);
});

test('run.json の要約に、ラウンドごとの節の列、関門の結果、起動ごとの時間と費用が残る', () => {
  const gates = (status) => [
    { id: 'G1', name: 'changes', label: '変更の確認', status: 'passed' },
    { id: 'G5', name: 'launch', label: '起動の確認', status, ...(status === 'failed' ? { summary: '起動の確認で実行時エラーがありました' } : {}), report: '.studio/runs/r1/rounds/1/report.json' },
    { id: 'G6', name: 'scenarios', label: 'シナリオ', status: 'skipped' },
  ];
  const summary = summarizeRun({
    id: 'r1',
    status: 'fixed',
    maxFixRounds: 2,
    rounds: [
      { round: 1, input: 'request', changedFiles: [{ file: 'app/App.jsx', change: 'modified' }], gates: gates('failed'), nodes: ['agent', 'launch', 'fix'] },
      { round: 2, input: 'fix', fixOf: { round: 1, gate: 'G5' }, changedFiles: [], gates: gates('passed'), nodes: ['agent', 'launch', 'evidence'] },
    ],
    agentLaunches: { count: 2, durationMs: 90_000, costUsd: 0.32, launches: [{ round: 1, outcome: 'passed', durationMs: 40_000, costUsd: 0.12, numTurns: 6 }, { round: 2, outcome: 'passed', durationMs: 50_000, costUsd: 0.2, numTurns: 8 }] },
    toolCalls: { count: 5, observe: 3, byTool: {} },
    scenariosChanged: [],
    reports: [{ gate: 'G5', round: 1, file: '.studio/runs/r1/rounds/1/report.json' }],
  });
  assert.equal(summary.status, 'fixed');
  assert.deepEqual(summary.rounds.map((round) => round.gates.map((gate) => `${gate.id} ${gate.status}`)), [['G1 passed', 'G5 failed'], ['G1 passed', 'G5 passed']]);
  assert.equal(summary.rounds[0].gates[1].summary, '起動の確認で実行時エラーがありました');
  assert.deepEqual(summary.rounds[1].fixOf, { round: 1, gate: 'G5' });
  assert.deepEqual(summary.rounds[0].changedFiles, ['app/App.jsx(modified)']);
  assert.deepEqual(summary.launches.map((launch) => launch.costUsd), [0.12, 0.2]);
  assert.equal(summary.launchCostUsd, 0.32);
});

test('app/ の外へ書かせる依頼で、何が止めたかを見分ける。どれでもなければ unknown', () => {
  const round = (steps, denials = []) => [{ round: 1, steps, result: { permissionDenials: denials, text: '' } }];
  const write = (file, extra = {}) => ({ kind: 'tool', name: 'Write', input: JSON.stringify({ file_path: file, content: '架空のメモ' }), result: null, isError: false, images: 0, ...extra });
  assert.equal(classifyOutsideStop({ rounds: round([write('../outside-written.txt')], [{ tool: 'Write', input: '{}' }]), fileCreated: false, appDir: APP }).stoppedBy, 'permission_denials');
  assert.equal(classifyOutsideStop({ rounds: round([write('../outside-written.txt', { isError: true, result: 'Permission denied' })]), fileCreated: false, appDir: APP }).stoppedBy, 'tool-error');
  assert.equal(classifyOutsideStop({ rounds: round([{ kind: 'text', text: 'app/ の外には書けません' }]), fileCreated: false, appDir: APP }).stoppedBy, 'model-refused');
  // app/ の中に書いたのは、外への書き込みとして数えない
  assert.equal(classifyOutsideStop({ rounds: round([write(`${APP}/note.txt`)]), fileCreated: false, appDir: APP }).stoppedBy, 'model-refused');
  assert.equal(classifyOutsideStop({ rounds: round([write('../outside-written.txt')]), fileCreated: false, appDir: APP }).stoppedBy, 'unknown');
  assert.equal(classifyOutsideStop({ rounds: round([]), fileCreated: true, appDir: APP }).stoppedBy, 'not-stopped');
});

test('プロダクト内 AI の実モデルのターンごとに、4 つの段の記録があるかと、呼び出しの回数と費用を出す', () => {
  const entries = [
    { type: 'open', connection: { real: false } },
    { type: 'reply', connection: { real: false }, harness: {} },
    {
      type: 'reply',
      status: 'ok',
      text: '英会話を始めたい',
      connection: { kind: 'claude-code', real: true },
      output: { reply: '英会話ですね。' },
      harness: { extract: { via: 'connection', output: { updates: '{}' } }, decision: { step: 'hear', ask: { key: 'level' }, done: false }, phrase: { via: 'connection' }, guards: { result: 'passed', failed: [] } },
      calls: { count: 2, extract: 1, phrase: 1, waitMs: 9000, durationMs: 7000, costUsd: 0.03 },
      elapsedMs: 9100,
    },
    { type: 'reply', status: 'failed', connection: { real: true }, harness: { extract: { via: 'connection' } }, error: { code: 'timeout', message: '時間切れ' } },
  ];
  const turns = productAiTurnsOf(entries);
  assert.equal(turns.length, 2);
  assert.equal(turns[0].fourStages, true);
  assert.deepEqual(turns[0].stages.decision, { step: 'hear', ask: 'level', say: null, done: false, reason: null });
  assert.equal(turns[0].calls.costUsd, 0.03);
  assert.equal(turns[1].fourStages, false);
  assert.equal(turns[1].error.code, 'timeout');
});

test('書く前に、鍵らしい文字列、メールアドレス、ホームと作業の場所を伏せ、書いた後に探して見つからない', () => {
  const value = {
    note: '架空の鍵 sk-ant-abcdefghijklmnop と taro@example.com',
    file: '/Users/someone/tmp/home/projects/loop-broken/app/App.jsx',
  };
  const out = scrub(value, [
    ['/Users/someone/tmp/home', '<作業の場所>'],
    ['/Users/someone', '~'],
  ]);
  assert.doesNotMatch(out.note, /sk-ant-|example\.com/);
  assert.equal(out.file, '<作業の場所>/projects/loop-broken/app/App.jsx');
  assert.deepEqual(findLeaks(JSON.stringify(out)), []);
  assert.deepEqual(
    findLeaks('token: "abc123def456ghi789"\nmail: taro@example.com').map((leak) => leak.kind),
    ['鍵らしい名前の値', 'メールアドレス'],
  );
});
