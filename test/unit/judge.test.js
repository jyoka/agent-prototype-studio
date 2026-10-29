import assert from 'node:assert/strict';
import test from 'node:test';
import { JUDGE_LIMITS, buildJudgeArgs, createClaudeCodeJudge, judgeInput, parseJudgeResult } from '../../src/server/sim/judge.js';

// 場面の採点(check: judge。docs/design/agent-simulation.md の 4.4)の起動の形と、出力の受け取り方。実モデルは呼ばない

test('採点の起動: プロダクト内 AI と同じ守りの引数で、道具を渡さず、{score, reason} の形と観点の文を = でつなぐ', () => {
  const args = buildJudgeArgs({ aspect: 'naturalness', rubric: '-架空の観点の文', model: 'claude-sonnet-5-5' });
  for (const name of ['-p', '--restricted', '--safe-mode', '--strict-mcp-config', '--no-session-persistence']) assert.ok(args.includes(name), name);
  assert.equal(args[args.indexOf('--tools') + 1], '');
  assert.equal(args[args.indexOf('--output-format') + 1], 'json');
  assert.equal(args[args.indexOf('--max-budget-usd') + 1], String(JUDGE_LIMITS.maxBudgetUsd));
  const schema = JSON.parse(args.find((a) => a.startsWith('--json-schema=')).slice('--json-schema='.length));
  assert.deepEqual(schema.required, ['score', 'reason']);
  assert.deepEqual([schema.properties.score.minimum, schema.properties.score.maximum], [1, 5]);
  const system = args.find((a) => a.startsWith('--system-prompt='));
  assert.match(system, /観点「naturalness」/);
  assert.match(system, /-架空の観点の文/);
  assert.ok(args.includes('--model=claude-sonnet-5-5'));
  assert.ok(!buildJudgeArgs({ aspect: 'a', rubric: 'b' }).some((a) => a.startsWith('--model')));
  assert.throws(() => createClaudeCodeJudge({ model: '--evil' }), /採点のモデルの名前の形/);
});

test('採点に渡す本文: 場面の説明、前の会話、ターンごとの発言と返事(部品は文にする)', () => {
  const text = judgeInput({
    scenario: { about: '架空の場面', history: [{ role: 'assistant', text: 'どこで探しますか?' }], turns: [{ user: 'みなと町' }, { action: 'agree', user: '保存してよい' }] },
    replies: [
      { turn: 0, from: 'partner', text: '', parts: [{ kind: 'text', text: '3件ありました。' }, { kind: 'buttons', items: [{ label: '詳しく見る' }] }] },
    ],
  });
  assert.match(text, /<場面>\n架空の場面\n<\/場面>/);
  assert.match(text, /\[AI\] どこで探しますか\?/);
  assert.match(text, /\[利用者\] みなと町\n\[AI の返事\(partner\)\] 3件ありました。\n1\. 詳しく見る/);
  assert.match(text, /\[利用者\] \(ボタン「agree」を押した\) 保存してよい\n\[AI の返事\] \(返事なし\)/);
});

test('採点に渡す本文が長すぎるときは、前の会話を古いほうから省き、採点する返事を残す', () => {
  const history = Array.from({ length: 40 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', text: `架空の前の発言${i} ${'あ'.repeat(900)}` }));
  const text = judgeInput({ scenario: { about: '架空の場面', history, turns: [{ user: '最後の発言' }] }, replies: [{ turn: 0, text: '採点する返事', parts: [{ kind: 'text', text: '採点する返事' }] }] });
  assert.ok(text.length <= JUDGE_LIMITS.maxInputChars, String(text.length));
  assert.match(text, /\(長いので、前の会話の始めの \d+ 件を省きました\)/);
  assert.ok(!text.includes('架空の前の発言0 '));
  assert.ok(text.includes('架空の前の発言39 '));
  assert.match(text, /\[AI の返事\] 採点する返事\n<\/採点する会話>$/);
});

test('採点の出力の受け取り: 構造化出力か本文の JSON。score がなければ投げ、分かった費用を誤りに付ける', () => {
  const ok = parseJudgeResult(JSON.stringify({ type: 'result', subtype: 'success', total_cost_usd: 0.01, structured_output: { score: 5, reason: '理由' }, modelUsage: { 'claude-sonnet-5-5': {} } }));
  assert.deepEqual(ok, { score: 5, reason: '理由', costUsd: 0.01, models: ['claude-sonnet-5-5'] });
  const text = parseJudgeResult(JSON.stringify({ type: 'result', subtype: 'success', result: '```json\n{"score": 3, "reason": "r"}\n```' }));
  assert.equal(text.score, 3);
  assert.throws(
    () => parseJudgeResult(JSON.stringify({ type: 'result', subtype: 'success', total_cost_usd: 0.02, structured_output: { score: 9, reason: 'x' } })),
    (error) => /1 から 5 の score/.test(error.message) && error.costUsd === 0.02,
  );
  assert.throws(() => parseJudgeResult(JSON.stringify({ type: 'result', subtype: 'error_max_budget_usd', is_error: true, total_cost_usd: 0.1 })), (error) => error.costUsd === 0.1);
  assert.throws(() => parseJudgeResult('読めない'), /採点の出力を読めませんでした/);
});
