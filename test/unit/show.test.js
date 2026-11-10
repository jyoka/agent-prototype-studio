import assert from 'node:assert/strict';
import test from 'node:test';
import { CLOSING_QUESTION, FALLBACK_QUESTIONS, SHOW_LIMITS, byVersion, questionsFrom, successItems } from '../../src/server/show.js';

// 見せる画面の問い(user-journey.md の J7)。問いは目的の文書の成功の印から、Studio が決まった形で作る

test('成功の印を、改行と句点で 1 つずつに分け、行の頭の箇条書きの印を外す', () => {
  assert.deepEqual(successItems('受付の人が 1 分で予約を探せる。\n- 電話の問い合わせが減る\n・ 月末の集計が 1 日で済む'), [
    '受付の人が 1 分で予約を探せる',
    '電話の問い合わせが減る',
    '月末の集計が 1 日で済む',
  ]);
  // 文の中の中黒では分けない
  assert.deepEqual(successItems('勤務地・職種を 3 分で伝えられる'), ['勤務地・職種を 3 分で伝えられる']);
  assert.deepEqual(successItems('同じ印。同じ印。'), ['同じ印']);
  assert.deepEqual(successItems(''), []);
  assert.deepEqual(successItems(undefined), []);
  assert.deepEqual(successItems(['配列']), []);
});

test('成功の印の数は上限で止める', () => {
  const many = Array.from({ length: 9 }, (_, i) => `印 ${i + 1}`).join('\n');
  assert.equal(successItems(many).length, SHOW_LIMITS.maxSuccessQuestions);
});

test('問いは成功の印ごとに 1 つと、最後に困ったところを聞く問い', () => {
  const { source, questions } = questionsFrom({ success: '受付の人が 1 分で予約を探せる。電話の問い合わせが減る' });
  assert.equal(source, 'success');
  assert.deepEqual(questions, [
    'この試作品で「受付の人が 1 分で予約を探せる」に近づきそうですか?',
    'この試作品で「電話の問い合わせが減る」に近づきそうですか?',
    CLOSING_QUESTION,
  ]);
});

test('成功の印がない(目的の文書がない、飛ばした)ときは、決まった問い', () => {
  for (const doc of [null, undefined, {}, { success: '  ' }]) {
    const { source, questions } = questionsFrom(doc);
    assert.equal(source, 'fallback');
    assert.deepEqual(questions, [...FALLBACK_QUESTIONS, CLOSING_QUESTION]);
  }
});

test('答えの記録を、版の ID ごとにまとめる', () => {
  const records = [
    { id: 'a', versionId: 'v1' },
    { id: 'b', versionId: 'v2' },
    { id: 'c', versionId: 'v1' },
  ];
  assert.deepEqual(byVersion(records), { v1: [records[0], records[2]], v2: [records[1]] });
});
