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
import { buildSim } from '../fixtures/sim.js';

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

test('返事の守ることの確かめの結果(合格、やり直し、決まった文に代えた)と、合わなかった決まりの名前が記録に残る(S18)', async (t) => {
  const env = await fakeEnv(t);
  const sessions = new AiSessions({
    definitionOf: () => travel(),
    connections: [createMockConnection(), createClaudeCodeConnection({ env, allowed: true })],
  });
  t.after(() => sessions.close());
  // モックの返事はいつも合う
  await sessions.send('p', '湖に行きたい');
  sessions.consent.agree();
  sessions.select('p', 'claude-code');
  await sessions.send('p', '[一度数を作る] 何泊がいいかな');
  await sessions.send('p', '[数を作る] 2泊で');
  const [fallback, retried, , passed] = sessions.trace('p').entries;
  assert.equal(passed.harness.guards.result, 'passed');
  assert.deepEqual(passed.harness.guards.failed, []);
  assert.equal(retried.harness.guards.result, 'retried');
  assert.deepEqual(retried.harness.guards.failed, ['noNewNumbers']);
  assert.match(retried.harness.guards.checks[0].failed[0].detail, /「987」/);
  assert.deepEqual(retried.harness.guards.checks[1].failed, []);
  assert.match(retried.harness.phrase.retryStdin, /<前の返事の問題>/);
  assert.equal(fallback.harness.guards.result, 'fallback');
  assert.deepEqual(fallback.harness.guards.failed, ['noNewNumbers']);
  assert.match(fallback.harness.guards.reason, /mock の型の文に代えた/);
  assert.equal(fallback.harness.phrase.fallback, fallback.harness.guards.reason);
  // 記録の返事は、決まった文に代えた後の返事
  assert.equal(fallback.output.reply, sessions.view('p').messages.at(-1).text);
  assert.doesNotMatch(fallback.output.reply, /987/);
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
  sessions.consent.agree();
  sessions.select('p', 'claude-code');
  // 同じ接続を選び直しても、記録は増やさない
  sessions.select('p', 'claude-code');

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
  // 抽出の指示は項目を、言い方の指示は作り手の instructions を持つ
  assert.match(reply.input.systemPrompt, /nights\(泊数\)/);
  assert.match(reply.input.phrase.systemPrompt, /架空の旅行会社の案内役です。/);
  assert.ok(reply.input.phrase.command.includes('--restricted'));
  assert.match(reply.input.stdin, /<新しい発言>\n山の村で2泊\n<\/新しい発言>/);
  assert.match(reply.harness.phrase.stdin, /<言うこと>\n- 今の発言から読み取った値/);
  assert.equal(reply.output.format, 'structured');
  // 抽出と言い方の 2 回の合計
  assert.equal(reply.output.costUsd, 0.0024);
  assert.equal(reply.output.durationMs, 10);
  assert.deepEqual([reply.calls.count, reply.calls.extract, reply.calls.phrase], [2, 1, 1]);
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
  sessions.consent.agree();
  sessions.select('p', 'claude-code');
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
  sessions.consent.agree();
  sessions.select('p', 'claude-code');
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

test('観察の会話は「観察から」の印で記録に残る。利用者の会話の記録と同じ一覧に入り、観察ごとにも取り出せる', async () => {
  const sessions = new AiSessions({ definitionOf: () => travel() });
  await sessions.send('p', '湖に行きたい');

  const conversation = sessions.openObservation('p');
  await sessions.send('p', '山で2泊', { conversation });
  sessions.correct('p', { nights: 3 }, { conversation });

  const [correction, reply, open, user] = sessions.trace('p').entries;
  // 利用者の発言には印がない
  assert.equal(user.observation, undefined);
  assert.equal(user.text, '湖に行きたい');
  // 観察の会話の始まり: あいさつ、最初の状態、接続(モック)
  assert.equal(open.type, 'open');
  assert.equal(open.observation, conversation);
  assert.equal(open.from, 'prototype');
  assert.equal(open.greeting, 'ようこそ。');
  assert.deepEqual(open.connection, { kind: 'mock', label: 'モック', real: false });
  assert.deepEqual(open.state.map((s) => s.value), ['未定', '未定']);
  // 発言、返事、状態の変化。形は利用者の会話の記録と同じ
  assert.equal(reply.type, 'reply');
  assert.equal(reply.observation, conversation);
  assert.equal(reply.from, 'prototype');
  assert.equal(reply.text, '山で2泊');
  assert.match(reply.output.reply, /行き先「山の村」、泊数「2泊」と理解しました/);
  assert.deepEqual(reply.changes, [
    { key: 'place', label: '行き先', from: '未定', to: '山の村' },
    { key: 'nights', label: '泊数', from: '未定', to: '2泊' },
  ]);
  assert.deepEqual(Object.keys(reply).sort(), Object.keys(user).concat('observation').sort());
  assert.equal(correction.observation, conversation);
  assert.deepEqual(correction.changes, [{ key: 'nights', label: '泊数', from: '2泊', to: '3泊' }]);

  // 観察ごとの記録は古い方から
  assert.deepEqual(
    sessions.observationTrace('p', conversation).map((entry) => entry.type),
    ['open', 'reply', 'correction'],
  );

  // 観察を閉じても、記録は残る
  assert.equal(sessions.closeObservation('p', conversation), true);
  assert.deepEqual(
    sessions.trace('p').entries.map((entry) => entry.observation ?? null),
    [conversation, conversation, conversation, null],
  );
});

test('観察の会話の記録は、利用者の記録を押し出さない。終わった観察の会話には記録を足さない', async () => {
  const sessions = new AiSessions({ definitionOf: () => travel() });
  await sessions.send('p', '湖に行きたい');
  const conversation = sessions.openObservation('p');
  for (let i = 0; i < SESSION_LIMITS.maxTraceEntries + 5; i += 1) await sessions.send('p', `湖で${(i % 14) + 1}泊`, { conversation });
  const { entries } = sessions.trace('p');
  // 観察の記録は観察の記録だけで上限まで。利用者の発言は残る
  assert.equal(entries.filter((entry) => entry.observation).length, SESSION_LIMITS.maxTraceEntries);
  assert.deepEqual(
    entries.filter((entry) => !entry.observation).map((entry) => entry.text),
    ['湖に行きたい'],
  );

  sessions.closeObservation('p', conversation);
  const before = sessions.trace('p').entries.length;
  await assert.rejects(sessions.send('p', '山にします', { conversation }), { code: 'closed' });
  assert.throws(() => sessions.correct('p', { nights: 2 }, { conversation }), { code: 'closed' });
  assert.equal(sessions.trace('p').entries.length, before);
  assert.deepEqual(sessions.view('p').state, { place: '湖の町', nights: null });
});

test('構成のある会話の 1 ターンは sim-turn の記録(4.1 の形)で残り、発言、ツールの引数、守りの理由は伏せてある', async (t) => {
  const fixture = await buildSim(t, 'sim-a');
  const sessions = new AiSessions({
    definitionOf: () => null,
    simulationOf: () => ({ simulation: fixture.simulation, aiOf: fixture.aiOf }),
    projectDirOf: () => fixture.root,
  });
  await sessions.send('p', 'みなと町で探して');
  await sessions.send('p', '090-1234-5678 に電話して');
  const [phone, search] = sessions.trace('p').entries;

  assert.equal(search.type, 'reply');
  assert.equal(search.kind, 'sim-turn');
  assert.equal(search.status, 'ok');
  assert.deepEqual(search.composition, { name: '外のエージェントと DIP 役のツール(架空)', file: 'composition.json', digest: search.composition.digest });
  assert.match(search.composition.digest, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(search.assumptions, { id: 'partner-a', file: 'assumptions/partner-a.json', digest: search.assumptions.digest, standIn: true });
  assert.equal(search.turn, 1);
  assert.deepEqual(search.input, { text: 'みなと町で探して', action: null, history: 0 });
  assert.deepEqual(search.nodes, ['accept', 'prompt:partner', 'agent:partner', 'surface:partner', 'output:partner', 'handoff', 'reply']);
  const [agentStep, toolStep, outputStep] = search.steps;
  assert.deepEqual(agentStep.prompt, {
    pieces: [{ from: 'assumptions', key: 'hostPrompt', owner: 'partner', chars: agentStep.prompt.pieces[0].chars }, { slot: 'dip-guide', owner: 'dip', chars: agentStep.prompt.pieces[1].chars }],
    asked: ['no-contact-ask'],
  });
  assert.equal(agentStep.connection, 'mock');
  assert.equal(agentStep.real, false);
  assert.equal(toolStep.tool, 'search_jobs');
  assert.equal(toolStep.by, 'partner');
  assert.deepEqual(toolStep.args, { area: 'みなと町' });
  // ツールの結果は、長さと数と項目の名前だけ
  assert.deepEqual(Object.keys(toolStep.result), ['ok', 'chars', 'count', 'keys']);
  assert.ok(!JSON.stringify(search).includes('架空の窓口'));
  assert.deepEqual(outputStep.output, { parts: [{ kind: 'text' }, { kind: 'buttons', items: 2 }] });
  assert.deepEqual(outputStep.guards, [{ layer: 'output', guard: 'facts-from-tools', effect: 'passed', owner: 'partner' }]);
  assert.equal(search.handoff, null);
  assert.deepEqual(search.views, { partnerSees: ['messages', 'toolCalls'], dipSees: ['toolCalls'] });
  assert.match(search.output.reply, /^2件ありました。/);

  // 発言とツールの引数に入った電話番号は、記録に残す前に伏せる
  const recorded = JSON.stringify(phone);
  assert.ok(!recorded.includes('090-1234-5678'));
  assert.ok(!recorded.includes('090-0000-0000'));
  assert.match(phone.text, /\[伏せた: 電話番号\]/);
  assert.match(phone.input.text, /\[伏せた: 電話番号\]/);
  const save = phone.steps.find((step) => step.tool === 'save_wish');
  assert.match(save.args.note, /\[伏せた: 電話番号\]/);
  assert.deepEqual(save.guards.map((g) => [g.guard, g.effect]), [['schema', 'passed'], ['requires', 'blocked']]);
});
