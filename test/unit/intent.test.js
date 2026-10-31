import assert from 'node:assert/strict';
import test from 'node:test';
import { cleanDoc, draftFromTurns, mergeDraft, singleQuestion } from '../../src/server/intent.js';
import { buildIntentArgs, intentInput, intentOutputProblem } from '../../src/server/intent-ai.js';

const turn = (field, answer, unknown = false) => ({ field, question: `${field} の問い?`, reason: '', answer, unknown });

test('答えの下書き: 答えは項目に入り、分からないは決めていないことに入る。問題を聞く前は最初の 1 文を問題にする', () => {
  const doc = draftFromTurns({ sentence: '架空の 1 文', turns: [turn('who', 'お店の人'), turn('scene', '', true), turn('notDoing', '予約はしない')] });
  assert.equal(doc.who, 'お店の人');
  assert.equal(doc.problem, '架空の 1 文');
  assert.equal(doc.scene, '');
  assert.deepEqual(doc.notDoing, ['予約はしない']);
  assert.deepEqual(doc.undecided, ['scene の問い?']);
});

test('AI の下書きを合わせる: AI が書かなくても、分からないの問いと答えは消えない', () => {
  const record = { sentence: '架空の 1 文', turns: [turn('who', 'お店の人'), turn('scene', '', true)] };
  const merged = mergeDraft(record, { who: '', problem: 'AI が書いた問題', scene: '', success: '', notDoing: [], undecided: ['AI が書いた未決'] });
  assert.equal(merged.who, 'お店の人');
  assert.equal(merged.problem, 'AI が書いた問題');
  assert.deepEqual(merged.undecided, ['scene の問い?', 'AI が書いた未決']);
});

test('文書の形: 知らない項目(status など)は捨てる', () => {
  const clean = cleanDoc({ who: ' 人 ', status: 'decided', decidedAt: 'x', notDoing: ['a', 'a', '', 3] });
  assert.deepEqual(Object.keys(clean).sort(), ['notDoing', 'problem', 'scene', 'success', 'undecided', 'who']);
  assert.equal(clean.who, '人');
  assert.deepEqual(clean.notDoing, ['a']);
  assert.deepEqual(cleanDoc('文字'), cleanDoc({}));
});

test('問いは 1 つだけにする', () => {
  assert.equal(singleQuestion('誰ですか?いつですか?'), '誰ですか?');
  assert.equal(singleQuestion('誰ですか? いつですか?'), '誰ですか?');
  assert.equal(singleQuestion('教えてください'), '教えてください');
  assert.equal(singleQuestion('誰が困っていますか。何に困っていますか?'), '誰が困っていますか。');
  assert.equal(singleQuestion('誰か教えてください。場面も教えてください。'), '誰か教えてください。');
  assert.equal(singleQuestion('1 文を読みました。誰が困っていますか?'), '誰が困っていますか?');
  assert.equal(singleQuestion(''), '');
});

test('起動の引数: 道具を渡さず、設定を読まず、費用の上限を付ける', () => {
  const args = buildIntentArgs();
  for (const flag of ['-p', '--restricted', '--safe-mode', '--strict-mcp-config', '--no-session-persistence']) assert.ok(args.includes(flag), flag);
  assert.equal(args[args.indexOf('--tools') + 1], '');
  assert.equal(args[args.indexOf('--permission-mode') + 1], 'dontAsk');
  assert.ok(args.includes('--max-budget-usd'));
  assert.ok(!args.includes('--mcp-config'));
  assert.ok(!args.includes('--dangerously-skip-permissions'));
  // 答えは argv に入れない
  assert.ok(!args.some((arg) => arg.includes('架空の答え')));
  assert.match(intentInput({ sentence: '1 文', turns: [turn('who', '架空の答え')], doc: {}, depthLabel: '速く', remaining: 1 }), /\[答え 1\] 架空の答え/);
});

test('出力の形の検査', () => {
  assert.ok(intentOutputProblem(null));
  assert.ok(intentOutputProblem({ draft: {} }));
  assert.ok(intentOutputProblem({ question: '?' }));
  assert.equal(intentOutputProblem({ question: '', draft: {} }), null);
});
