import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { STUDIO_ROOT } from '../../src/server/config.js';
import { redact, redactDeep } from '../../src/server/redact.js';
import { createClaudeCodeConnection } from '../../src/server/product-ai/claude-code.js';
import { parseAiDefinition } from '../../src/server/product-ai/definition.js';
import { createMockConnection } from '../../src/server/product-ai/mock.js';
import { AiSessions, SESSION_LIMITS, nextAction } from '../../src/server/product-ai/session.js';

// 実モデルは呼ばない。Claude Code は偽の CLI に差し替える
const FAKE = path.join(STUDIO_ROOT, 'test', 'fixtures', 'fake-claude.js');

// 求人ではない題材(架空の旅の相談)
function travel() {
  const { definition, errors } = parseAiDefinition(
    JSON.stringify({
      name: '旅の相談(架空)',
      instructions: '架空の旅行会社の案内役です。',
      fields: [
        { key: 'place', label: '行き先', options: [{ value: '湖の町', keywords: ['湖'] }, { value: '山の村', keywords: ['山'] }] },
        { key: 'nights', label: '泊数', type: 'number', unit: '泊', min: 1, max: 14 },
      ],
      mock: { greeting: 'ようこそ。' },
    }),
  );
  assert.deepEqual(errors, []);
  return definition;
}

async function fakeEnv(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-trace-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return { PATH: process.env.PATH, STUDIO_CLAUDE_BIN: FAKE, FAKE_CLAUDE_LOG: path.join(dir, 'calls.jsonl') };
}

test('秘密らしい文字列と、要らない個人のデータを伏せる。ふつうの文、数、ファイルの場所は変えない', () => {
  const cases = [
    ['Invalid API key sk-ant-api03-abcdefgh_ijkl-1234', 'Invalid API key [伏せた: API キーらしい文字列]'],
    ['Authorization: Bearer abc.def-ghijklmnop', 'Authorization: Bearer [伏せた]'],
    ['ANTHROPIC_API_KEY=xyz123 で失敗', 'ANTHROPIC_API_KEY=[伏せた] で失敗'],
    ['{"token": "abcd1234"}', '{"token": "[伏せた]"}'],
    [`鍵 ${'a1'.repeat(32)}`, '鍵 [伏せた: 長い符号]'],
    ['連絡は taro@example.com へ', '連絡は [伏せた: メールアドレス] へ'],
    ['電話 090-1234-5678 か 0312345678', '電話 [伏せた: 電話番号] か [伏せた: 電話番号]'],
    ['+81-90-1234-5678', '[伏せた: 電話番号]'],
  ];
  for (const [input, expected] of cases) assert.equal(redact(input), expected, input);
  for (const keep of [
    '時給1100円以上、$0.0012、2026-10-28 に 3泊',
    '/Users/someone/.local/share/task-hub/worktrees/277/src/server/product-ai/claude-code',
    "You've hit your limit · resets 3am",
    'Claude AI usage limit reached|1761700000',
    '--json-schema=…(512 文字)',
    // 電話番号や鍵に似ているが違うもの
    '郵便番号 060-0001、金額 05000000円、2026 0101 1200',
    'basic settings、max_tokens: 100',
  ]) {
    assert.equal(redact(keep), keep);
  }
  assert.deepEqual(redactDeep({ a: ['x@example.com', 1, null], b: { c: 'sk-ant-api03-zzzzzzzzzz' } }), {
    a: ['[伏せた: メールアドレス]', 1, null],
    b: { c: '[伏せた: API キーらしい文字列]' },
  });
});

test('モックの発言、修正、リセットを記録する。モックは外へ送らず、ツールがないことも記録に出る', async () => {
  const sessions = new AiSessions({ definitionOf: () => travel() });
  assert.deepEqual(sessions.trace('p').entries, []);

  await sessions.send('p', '湖で3泊したい');
  sessions.correct('p', { place: '山の村' });
  sessions.reset('p');

  const [reset, correction, reply] = sessions.trace('p').entries;
  assert.equal(reply.type, 'reply');
  assert.equal(reply.from, 'prototype');
  assert.equal(reply.status, 'ok');
  assert.deepEqual(reply.connection, { kind: 'mock', label: 'モック', real: false });
  assert.equal(reply.text, '湖で3泊したい');
  assert.equal(reply.input.to, null);
  assert.match(reply.input.tools, /ツールがありません/);
  assert.match(reply.input.rule, /keywords/);
  assert.equal(reply.input.history, 1);
  assert.deepEqual(reply.input.state, [
    { key: 'place', label: '行き先', value: '未定' },
    { key: 'nights', label: '泊数', value: '未定' },
  ]);
  assert.equal(reply.input.command, undefined);
  assert.match(reply.output.reply, /行き先「湖の町」、泊数「3泊」と理解しました/);
  assert.equal(reply.output.updates, '{"place":"湖の町","nights":3}');
  // モックは費用も CLI の形もない。ないものを出さない
  assert.equal(reply.output.costUsd, null);
  assert.equal(reply.output.format, null);
  assert.deepEqual(reply.changes, [
    { key: 'place', label: '行き先', from: '未定', to: '湖の町' },
    { key: 'nights', label: '泊数', from: '未定', to: '3泊' },
  ]);
  assert.deepEqual(reply.rejected, []);
  assert.ok(Number.isFinite(reply.elapsedMs));

  assert.equal(correction.type, 'correction');
  assert.deepEqual(correction.requested, [{ key: 'place', value: '山の村' }]);
  assert.deepEqual(correction.changes, [{ key: 'place', label: '行き先', from: '湖の町', to: '山の村' }]);

  assert.equal(reset.type, 'reset');
  assert.equal(reset.from, 'studio');
  assert.deepEqual(reset.state.map((s) => s.value), ['未定', '未定']);

  // 記録はリセットしても残り、消すと空になる
  assert.equal(sessions.clearTrace('p').entries.length, 0);
});

test('失敗は理由と次にすることを記録し、決まりに合わない値は状態に入れなかったことを残す', async () => {
  const definition = travel();
  let answer = { reply: 'はい', updates: { place: '海の町', nights: 3, unknown: 'x' } };
  const connection = {
    ...createMockConnection(),
    async respond() {
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
  const sessions = new AiSessions({ definitionOf: () => definition, connections: [connection] });
  await sessions.send('p', 'どこでも');
  const [ok] = sessions.trace('p').entries;
  assert.deepEqual(ok.changes, [{ key: 'nights', label: '泊数', from: '未定', to: '3泊' }]);
  assert.deepEqual(ok.rejected, [
    { key: 'place', label: '行き先', value: '海の町', reason: '項目の決まりに合わない値' },
    { key: 'unknown', label: null, value: 'x', reason: 'app/ai.json にない項目' },
  ]);

  answer = new Error('つながらない');
  await assert.rejects(sessions.send('p', '湖'), { code: 'connection' });
  await assert.rejects(sessions.send('p', '   '), { code: 'invalid' });
  assert.throws(() => sessions.correct('p', { place: '海の町' }), { code: 'invalid' });
  const [badCorrection, badText, failed] = sessions.trace('p').entries;
  assert.equal(failed.status, 'failed');
  assert.match(failed.error.message, /つながらない/);
  assert.match(failed.error.next, /モックに戻して試し、この記録を開発の担当者に見せてください/);
  assert.equal(badText.error.code, 'invalid');
  assert.match(badText.error.next, /500 文字までの文/);
  assert.equal(badText.input, undefined);
  assert.equal(badCorrection.error.code, 'invalid');
  assert.match(badCorrection.error.next, /選べる値に直してください/);

  // 失敗の種類ごとに、画面の言葉で次にすることがある
  for (const code of ['cancelled', 'reset', 'limit', 'budget', 'timeout', 'auth', 'not-found', 'paid-limit', 'too-long', 'busy']) {
    assert.notEqual(nextAction(code), nextAction('something-else'), code);
  }
});

test('記録は件数の上限まで。発言の中の秘密らしい文字列と個人のデータは伏せて残す', async () => {
  const sessions = new AiSessions({ definitionOf: () => travel() });
  await sessions.send('p', '湖へ。連絡は taro@example.com、鍵は sk-ant-api03-abcdefghijk');
  const [entry] = sessions.trace('p').entries;
  assert.equal(entry.text, '湖へ。連絡は [伏せた: メールアドレス]、鍵は [伏せた: API キーらしい文字列]');
  assert.doesNotMatch(JSON.stringify(entry), /taro@example\.com|sk-ant-api03/);
  // 会話そのもの(試作品が出すもの)は変えない
  assert.match(sessions.view('p').messages[1].text, /taro@example\.com/);

  for (let i = 0; i < SESSION_LIMITS.maxTraceEntries + 5; i += 1) sessions.correct('p', { nights: (i % 14) + 1 });
  const { entries } = sessions.trace('p');
  assert.equal(entries.length, SESSION_LIMITS.maxTraceEntries);
  assert.ok(entries[0].id > entries.at(-1).id);
});

test('Claude Code(偽)に渡したもの、受け取ったもの、切り替え、失敗を記録する。CLI のエラーの鍵は伏せる', async (t) => {
  const env = await fakeEnv(t);
  const sessions = new AiSessions({
    definitionOf: () => travel(),
    connections: [createMockConnection(), createClaudeCodeConnection({ env, allowed: true })],
  });
  t.after(() => sessions.close());
  assert.match(sessions.connectionChoices('p').options[1].tools, /ツールを渡していません/);
  sessions.select('p', 'claude-code', { confirmed: true });
  // 同じ接続を選び直しても、記録は増やさない
  sessions.select('p', 'claude-code', { confirmed: true });

  await sessions.send('p', '山の村で2泊');
  await assert.rejects(sessions.send('p', '[鍵を出す]'), (error) => {
    assert.equal(error.code, 'auth');
    assert.doesNotMatch(error.message, /FAKEKEY/);
    return true;
  });
  await sessions.send('p', '[範囲外]');

  const [outOfRange, keyError, reply, switched] = sessions.trace('p').entries;
  assert.equal(switched.type, 'connection');
  assert.deepEqual(switched.previous, { kind: 'mock', label: 'モック', real: false });
  assert.deepEqual(switched.connection, { kind: 'claude-code', label: 'Claude Code', real: true });

  assert.equal(reply.connection.real, true);
  assert.match(reply.input.to, /Anthropic/);
  assert.match(reply.input.tools, /--tools ""/);
  assert.equal(reply.input.command[0], 'fake-claude.js');
  assert.ok(reply.input.command.includes('--restricted'));
  assert.ok(reply.input.command.some((arg) => /^--system-prompt=…\(\d+ 文字\)$/.test(arg)));
  assert.match(reply.input.systemPrompt, /架空の旅行会社の案内役です。/);
  assert.match(reply.input.stdin, /<新しい発言>\n山の村で2泊\n<\/新しい発言>/);
  assert.equal(reply.output.format, 'structured');
  assert.equal(reply.output.costUsd, 0.0012);
  assert.equal(reply.output.durationMs, 5);
  assert.deepEqual(reply.changes.map((c) => c.to), ['山の村', '2泊']);

  assert.equal(keyError.status, 'failed');
  assert.match(keyError.error.message, /\[伏せた: API キーらしい文字列\]/);
  assert.match(keyError.error.next, /ログインしてから/);
  assert.doesNotMatch(JSON.stringify(sessions.trace('p')), /FAKEKEY/);

  assert.deepEqual(outOfRange.changes, []);
  assert.deepEqual(
    outOfRange.rejected.map((r) => [r.key, r.value]),
    [['place', 'ない選択肢'], ['nights', '15'], ['unknownField', 'x']],
  );
  assert.deepEqual(sessions.view('p').state, { place: '山の村', nights: 2 });
});

test('応答を待つ間は「待っています」と渡したものが見え、止めると理由と次にすることが残る', async (t) => {
  const env = await fakeEnv(t);
  const sessions = new AiSessions({
    definitionOf: () => travel(),
    connections: [createMockConnection(), createClaudeCodeConnection({ env, allowed: true })],
  });
  t.after(() => sessions.close());
  sessions.select('p', 'claude-code', { confirmed: true });
  const pending = sessions.send('p', '[遅い] 待つ');
  const [running] = sessions.trace('p').entries;
  assert.equal(running.status, 'running');
  assert.match(running.input.stdin, /\[遅い\] 待つ/);
  sessions.cancel('p');
  await assert.rejects(pending, { code: 'cancelled' });
  const [cancelled] = sessions.trace('p').entries;
  assert.equal(cancelled.status, 'cancelled');
  assert.match(cancelled.error.next, /もう一度送れます/);
});

test('Claude Code を起動できなかったときは、渡すはずだったものを「送っていない」と記録し、失敗には記録と同じ次にすることを付ける', async (t) => {
  const env = await fakeEnv(t);
  const missing = createClaudeCodeConnection({ env: { ...env, STUDIO_CLAUDE_BIN: path.join(os.tmpdir(), 'no-such-claude') }, allowed: true });
  // 選んだ後に Claude Code が消えた、という場面にする
  missing.availability = () => ({ available: true, reason: '' });
  const sessions = new AiSessions({ definitionOf: () => travel(), connections: [createMockConnection(), missing] });
  sessions.select('p', 'claude-code', { confirmed: true });
  await assert.rejects(sessions.send('p', '湖'), { code: 'not-found' });
  const [entry] = sessions.trace('p').entries;
  assert.equal(entry.input.notSent, true);
  assert.match(entry.error.next, /Claude Code を入れてください/);

  // 発言の決まりの誤りは、API の応答にも記録と同じ次にすることを付ける
  await assert.rejects(sessions.send('p', ''), (error) => {
    assert.match(error.next, /500 文字までの文/);
    return true;
  });
  assert.throws(() => sessions.correct('p', { place: '海の町' }), (error) => {
    assert.match(error.next, /選べる値に直してください/);
    return true;
  });
});

test('版を戻しても、記録は消さない。戻した会話は記録の前の発言を書き換えない', async () => {
  const definition = travel();
  const sessions = new AiSessions({ definitionOf: () => definition });
  await sessions.send('p', '湖に行きたい');
  const saved = sessions.snapshot('p');
  await sessions.send('p', '山にします');
  assert.equal(sessions.restore('p', saved), true);
  assert.equal(sessions.view('p').state.place, '湖の町');
  const { entries } = sessions.trace('p');
  assert.deepEqual(
    entries.map((entry) => [entry.type, entry.status, entry.text]),
    [
      ['reply', 'ok', '山にします'],
      ['reply', 'ok', '湖に行きたい'],
    ],
  );
});
