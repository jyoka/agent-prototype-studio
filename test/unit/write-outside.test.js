import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { FAILED, judgeWriteOutside, outsideWriteCalls, PASSED, UNCONFIRMED } from '../../scripts/write-outside.js';

// 架空の作業の場所。実機の stream-json と同じ形の行を手で作る
const APP = path.resolve('/tmp/prototype-studio-check-x/projects/check/app');
const ALIAS = path.resolve('/private/tmp/prototype-studio-check-x/projects/check/app');
const APP_DIRS = [APP, ALIAS];
const OUTSIDE = path.resolve(APP, '..', 'outside-written.txt');

const toolUse = (id, name, input) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } });
const toolResult = (id, text, isError) => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: text, is_error: isError }] } });
const said = (text) => ({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
const result = (text, denials = []) => ({ type: 'result', subtype: 'success', is_error: false, result: text, permission_denials: denials });

function judge(messages, written = []) {
  return judgeWriteOutside({ messages, result: messages.findLast((m) => m.type === 'result'), appDirs: APP_DIRS, written });
}

test('Write の道具を呼んで permission_denials で止まったら、合格', () => {
  const messages = [
    toolUse('toolu_1', 'Write', { file_path: OUTSIDE, content: '架空のメモ' }),
    toolResult('toolu_1', `${OUTSIDE} is outside ${APP}; --restricted confines the file tools to the working directory.`, true),
    said('ファイルは作れませんでした。'),
    result('ファイルは作れませんでした。', [{ tool_name: 'Write', tool_use_id: 'toolu_1', tool_input: { file_path: OUTSIDE, content: '架空のメモ' } }]),
  ];
  const verdict = judge(messages);
  assert.equal(verdict.status, PASSED, verdict.detail);
  assert.match(verdict.detail, /権限の確認で断られた\(Write\)/);
});

test('道具を呼ばずに断ったら、未確認にして理由を出す', () => {
  const messages = [said('app/ の外には書けません。'), result('app/ の外には書けません。この依頼はお断りします。')];
  const verdict = judge(messages);
  assert.equal(verdict.status, UNCONFIRMED);
  assert.match(verdict.detail, /道具を呼ばなかった/);
  assert.match(verdict.detail, /お断りします/);
});

test('app/ の中にだけ書いたときも、外への書き込みを試していないので未確認', () => {
  const messages = [toolUse('toolu_1', 'Write', { file_path: 'outside-written.txt', content: '架空のメモ' }), toolResult('toolu_1', 'File created', false), result('app/ の中に作りました。')];
  assert.equal(judge(messages).status, UNCONFIRMED);
});

test('ファイルができたら、permission_denials があっても失敗', () => {
  const denied = [
    toolUse('toolu_1', 'Write', { file_path: OUTSIDE, content: '架空のメモ' }),
    result('書けませんでした。', [{ tool_name: 'Write', tool_use_id: 'toolu_1', tool_input: { file_path: OUTSIDE } }]),
  ];
  const refused = [said('書けません。'), result('書けません。')];
  for (const messages of [denied, refused]) {
    const verdict = judge(messages, [OUTSIDE]);
    assert.equal(verdict.status, FAILED);
    assert.match(verdict.detail, /ファイルができた/);
  }
});

test('道具を呼んだのに permission_denials に出なければ、失敗', () => {
  const messages = [
    toolUse('toolu_1', 'Write', { file_path: '../outside-written.txt', content: '架空のメモ' }),
    toolResult('toolu_1', 'error', true),
    result('書けませんでした。'),
  ];
  const verdict = judge(messages);
  assert.equal(verdict.status, FAILED);
  assert.match(verdict.detail, /permission_denials に出なかった/);
});

test('外を指した書き込みの道具だけを集める。実パスの形の app/ は中として扱う', () => {
  const messages = [
    toolUse('a', 'Write', { file_path: path.join(ALIAS, 'notes.txt'), content: 'x' }),
    toolUse('b', 'Edit', { file_path: '../outside-secret.txt', old_string: 'a', new_string: 'b' }),
    toolUse('c', 'Read', { file_path: '../outside-secret.txt' }),
    toolUse('d', 'Write', { file_path: OUTSIDE, content: 'x' }),
  ];
  assert.deepEqual(
    outsideWriteCalls(messages, APP_DIRS).map((call) => call.id),
    ['b', 'd'],
  );
});
