import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { STUDIO_ROOT } from '../../src/server/config.js';
import {
  CLAUDE_CODE_LIMITS,
  billingOf,
  buildArgs,
  conversationPrompt,
  createClaudeCodeConnection,
  parseResult,
  responseSchema,
} from '../../src/server/product-ai/claude-code.js';
import { parseAiDefinition } from '../../src/server/product-ai/definition.js';
import { createMockConnection } from '../../src/server/product-ai/mock.js';
import { AiSessions, SESSION_LIMITS } from '../../src/server/product-ai/session.js';

// 実モデルは呼ばない。Claude Code は偽の CLI に差し替える
const FAKE = path.join(STUDIO_ROOT, 'test', 'fixtures', 'fake-claude.js');
const WAIT_MS = 5000;

// 求人ではない題材(架空の旅の相談)
function travel() {
  const { definition, errors } = parseAiDefinition(
    JSON.stringify({
      name: '旅の相談(架空)',
      instructions: '- 架空の旅行会社の案内役です。',
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

async function withLog(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-fake-claude-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const log = path.join(dir, 'calls.jsonl');
  const env = { PATH: process.env.PATH, STUDIO_CLAUDE_BIN: FAKE, FAKE_CLAUDE_LOG: log };
  const calls = async () => {
    const text = await fs.readFile(log, 'utf8').catch(() => '');
    return text.split('\n').filter(Boolean).map((line) => JSON.parse(line));
  };
  return { env, calls };
}

async function until(check, what) {
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`${WAIT_MS}ms 待っても ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test('起動の引数は閉じ込めのフラグを必ず含み、発言は argv に入れない', () => {
  const definition = travel();
  const args = buildArgs(definition);
  for (const flag of ['-p', '--restricted', '--safe-mode', '--strict-mcp-config', '--no-session-persistence']) {
    assert.ok(args.includes(flag), flag);
  }
  assert.equal(args[args.indexOf('--tools') + 1], '');
  assert.equal(args[args.indexOf('--permission-mode') + 1], 'dontAsk');
  assert.equal(args[args.indexOf('--output-format') + 1], 'json');
  // - で始まる指示も、フラグとして読まれない形で渡す
  assert.ok(args.some((arg) => arg.startsWith('--system-prompt=- 架空の旅行会社の案内役です。')));
  for (const forbidden of ['--dangerously-skip-permissions', '--allow-dangerously-skip-permissions', 'bypassPermissions', '--bare', '--resume', '--continue']) {
    assert.ok(!args.includes(forbidden), forbidden);
  }
  const prompt = conversationPrompt({ definition, state: { place: null, nights: null }, messages: [], text: '--湖に行きたい' });
  assert.ok(!args.some((arg) => arg.includes('--湖に行きたい')));
  assert.match(prompt, /<新しい発言>\n--湖に行きたい\n<\/新しい発言>/);

  // ログインが Console のアカウントなら API キーがなくても従量課金なので、1 回の費用の上限はいつも付ける
  assert.equal(args[args.indexOf('--max-budget-usd') + 1], String(CLAUDE_CODE_LIMITS.maxBudgetUsd));
});

test('ANTHROPIC_API_KEY の有無で、どちらで課金されるかを返す', () => {
  assert.equal(billingOf({}).kind, 'subscription');
  // ログインの種類は分からないので、両方の場合を書く
  assert.match(billingOf({}).text, /サブスクリプション/);
  assert.match(billingOf({}).text, /Console のアカウント/);
  assert.equal(billingOf({ ANTHROPIC_API_KEY: '' }).kind, 'subscription');
  assert.equal(billingOf({ ANTHROPIC_API_KEY: 'x' }).kind, 'api-key');
  assert.match(billingOf({ ANTHROPIC_API_KEY: 'x' }).text, /従量で課金/);
  // 送り先を変える設定があれば、そちらを優先して出す
  const other = billingOf({ ANTHROPIC_API_KEY: 'x', CLAUDE_CODE_USE_BEDROCK: '1' });
  assert.equal(other.kind, 'other');
  assert.deepEqual(other.providers, ['CLAUDE_CODE_USE_BEDROCK']);
  const sends = createClaudeCodeConnection({ env: { ANTHROPIC_BASE_URL: 'http://example.invalid' } }).sends(travel());
  assert.match(sends.to, /ANTHROPIC_BASE_URL/);
  assert.doesNotMatch(sends.to, /example\.invalid/);
  // 値そのものは返さない
  assert.ok(!JSON.stringify(billingOf({ ANTHROPIC_API_KEY: 'sk-secret' })).includes('sk-secret'));
  assert.ok(!JSON.stringify(billingOf({ ANTHROPIC_AUTH_TOKEN: 'tok-secret' })).includes('tok-secret'));
});

test('応答の形は ai.json の項目から作る', () => {
  const schema = responseSchema(travel());
  assert.deepEqual(schema.required, ['reply', 'updates']);
  assert.deepEqual(schema.properties.updates.properties.place, { enum: ['湖の町', '山の村', null] });
  assert.deepEqual(schema.properties.updates.properties.nights, { type: ['number', 'null'], minimum: 1, maximum: 14 });
  assert.equal(schema.properties.updates.additionalProperties, false);
});

test('CLI の結果を読む: 構造化出力、本文の JSON、ただの文、上限、費用、ログイン、壊れた出力', () => {
  const ok = (extra) => JSON.stringify({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.01, ...extra });
  assert.deepEqual(parseResult(ok({ structured_output: { reply: 'はい', updates: { place: '湖の町' } } })), {
    reply: 'はい',
    updates: { place: '湖の町' },
    meta: { costUsd: 0.01, structured: true },
  });
  assert.deepEqual(parseResult(ok({ result: '```json\n{"reply":"本文","updates":{}}\n```' })).reply, '本文');
  assert.equal(parseResult(ok({ result: '{"reply":"本文","updates":{}}' })).meta.structured, false);
  assert.deepEqual(parseResult(ok({ result: 'JSON ではない返事' })).updates, {});

  const code = (stdout) => {
    try {
      parseResult(stdout);
    } catch (error) {
      return error.code;
    }
    return 'ok';
  };
  assert.equal(code(JSON.stringify({ is_error: true, result: "You've hit your limit · resets 3am" })), 'limit');
  assert.equal(code(JSON.stringify({ is_error: true, result: 'Claude AI usage limit reached|1761700000' })), 'limit');
  assert.equal(code(JSON.stringify({ subtype: 'error_max_budget_usd', is_error: true })), 'budget');
  assert.equal(code(JSON.stringify({ is_error: true, result: 'Not logged in · Please run /login' })), 'auth');
  assert.equal(code('壊れた出力'), 'failed');
  assert.equal(code(ok({ result: '' })), 'failed');
});

test('偽の CLI で応答する: 会話の全体を毎回渡し、空の作業フォルダーで動かす', async (t) => {
  const { env, calls } = await withLog(t);
  const connection = createClaudeCodeConnection({ env, allowed: true });
  t.after(() => connection.close());
  assert.deepEqual(connection.availability(), { available: true, reason: '' });
  const definition = travel();
  const messages = [
    { role: 'assistant', text: 'ようこそ。' },
    { role: 'user', text: '湖に行きたい' },
    { role: 'assistant', text: '湖ですね。', via: 'mock' },
    { role: 'correction', text: '行き先を「山の村」に直しました。', changes: [] },
  ];
  const result = await connection.respond({ definition, state: { place: '山の村', nights: null }, messages, text: '3泊したい' });
  assert.equal(result.reply, '偽の Claude Code です。これまでの会話 4 件(修正 1 件)を受け取りました。「3泊したい」への返事です。');
  assert.deepEqual(result.updates, { nights: 3 });
  assert.deepEqual(result.meta, { costUsd: 0.0012, structured: true });

  const [call] = await calls();
  assert.match(call.stdin, /\[利用者の修正\] 行き先を「山の村」に直しました。/);
  assert.match(call.stdin, /- place\(行き先\): 山の村/);
  assert.deepEqual(await fs.readdir(call.cwd), []);
  assert.ok(path.basename(call.cwd).startsWith('studio-product-ai-'));
  // 資格情報を足さない。渡すのは利用者の環境変数そのもの
  assert.deepEqual(call.envNames, ['FAKE_CLAUDE_LOG', 'STUDIO_CLAUDE_BIN']);

  // 構造化出力がないときは、本文の JSON を読む
  const fallback = await connection.respond({ definition, state: {}, messages: [], text: '湖の町に[文だけ]' });
  assert.deepEqual(fallback.updates, { place: '湖の町' });
  assert.equal(fallback.meta.structured, false);
});

test('偽の CLI の失敗: 上限、異常終了、見つからない、時間切れ、中断', async (t) => {
  const { env, calls } = await withLog(t);
  const definition = travel();
  const ask = (connection, text, signal) => connection.respond({ definition, state: {}, messages: [], text, signal });
  const connection = createClaudeCodeConnection({ env, allowed: true });
  t.after(() => connection.close());

  await assert.rejects(ask(connection, '[上限]'), { code: 'limit', message: /利用の上限/ });
  await assert.rejects(ask(connection, '[壊れる]'), { code: 'failed', message: /途中で止まりました/ });

  const missing = createClaudeCodeConnection({ env: { ...env, STUDIO_CLAUDE_BIN: path.join(os.tmpdir(), 'no-such-claude') }, allowed: true });
  assert.equal(missing.availability().available, false);
  assert.match(missing.availability().reason, /見つかりません/);
  await assert.rejects(ask(missing, 'こんにちは'), { code: 'not-found' });

  const short = createClaudeCodeConnection({ env, allowed: true, limits: { ...CLAUDE_CODE_LIMITS, timeoutMs: 300, stopGraceMs: 200 } });
  t.after(() => short.close());
  await assert.rejects(ask(short, '[遅い] 時間切れ'), { code: 'timeout' });
  const timedOut = (await calls()).at(-1);
  assert.equal(alive(timedOut.pid), false);

  const controller = new AbortController();
  const pending = ask(connection, '[遅い] 止める', controller.signal);
  const started = await until(async () => (await calls()).find((call) => call.stdin.includes('[遅い] 止める')), 'CLI が起動しません');
  assert.equal(alive(started.pid), true);
  controller.abort();
  await assert.rejects(pending, { code: 'cancelled', message: '応答を止めました' });
  assert.equal(alive(started.pid), false);
});

test('閉じると、SIGINT を無視する CLI も止まるまで待ってから、作業フォルダーを消す', async (t) => {
  const { env, calls } = await withLog(t);
  const connection = createClaudeCodeConnection({ env, allowed: true, limits: { ...CLAUDE_CODE_LIMITS, stopGraceMs: 200 } });
  const pending = connection.respond({ definition: travel(), state: {}, messages: [], text: '[しぶとい]' });
  const started = await until(async () => (await calls())[0], 'CLI が起動しません');
  await connection.close();
  await assert.rejects(pending, { code: 'cancelled' });
  assert.equal(alive(started.pid), false);
  await assert.rejects(fs.access(started.cwd));
});

test('許されていなければ選べず、切り替えには確認が要り、会話は切り替えても続く', async (t) => {
  const { env, calls } = await withLog(t);
  const definition = travel();
  const blocked = new AiSessions({ definitionOf: () => definition, connections: [createMockConnection(), createClaudeCodeConnection({ env })] });
  const choices = blocked.connectionChoices('p');
  assert.equal(choices.selected, 'mock');
  assert.equal(choices.options[1].available, false);
  assert.match(choices.options[1].reason, /STUDIO_ALLOW_CLAUDE_CODE=1/);
  assert.throws(() => blocked.select('p', 'claude-code', { confirmed: true }), { code: 'unavailable' });

  const real = createClaudeCodeConnection({ env, allowed: true });
  const sessions = new AiSessions({ definitionOf: () => definition, connections: [createMockConnection(), real] });
  t.after(() => sessions.close());
  const option = sessions.connectionChoices('p').options[1];
  assert.equal(option.billing.kind, 'subscription');
  assert.match(option.sends.items.join('\n'), /会話の全体/);
  assert.match(option.sends.systemPrompt, /架空の旅行会社の案内役です/);

  await sessions.send('p', '湖に行きたい');
  assert.throws(() => sessions.select('p', 'claude-code'), { code: 'not-confirmed' });
  assert.throws(() => sessions.select('p', 'nothing'), { code: 'invalid' });
  assert.equal(sessions.select('p', 'claude-code', { confirmed: true }).connection.kind, 'claude-code');

  const view = await sessions.send('p', '山の村で2泊');
  assert.deepEqual(view.state, { place: '山の村', nights: 2 });
  assert.deepEqual(
    view.messages.map((m) => [m.role, m.via]),
    [['assistant', undefined], ['user', undefined], ['assistant', 'mock'], ['user', undefined], ['assistant', 'claude-code']],
  );
  assert.match(view.messages.at(-1).text, /これまでの会話 3 件/);
  assert.equal(view.messages.at(-1).costUsd, 0.0012);
  assert.ok(Number.isFinite(view.messages.at(-1).elapsedMs));

  // 失敗しても会話は変わらない
  await assert.rejects(sessions.send('p', '[上限]'), { code: 'limit' });
  assert.equal(sessions.view('p').messages.length, 5);

  // 中断: 止めた発言は残さず、CLI は終わる。リセットでも止まる。接続の選択はリセットで変えない
  const pending = sessions.send('p', '[遅い] 待つ');
  const started = await until(async () => (await calls()).find((call) => call.stdin.includes('[遅い] 待つ')), 'CLI が起動しません');
  assert.equal(sessions.view('p').busy, true);
  assert.throws(() => sessions.select('p', 'mock'), { code: 'busy' });
  sessions.cancel('p');
  await assert.rejects(pending, { code: 'cancelled' });
  assert.equal(alive(started.pid), false);
  assert.equal(sessions.view('p').messages.length, 5);

  const again = sessions.send('p', '[遅い] リセット');
  const second = await until(async () => (await calls()).find((call) => call.stdin.includes('[遅い] リセット')), 'CLI が起動しません');
  const reset = sessions.reset('p');
  await assert.rejects(again, { code: 'reset' });
  await until(() => !alive(second.pid), 'リセットしても CLI が止まりません');
  assert.equal(reset.connection.kind, 'claude-code');
  assert.equal(reset.messages.length, 1);

  // モックに戻すのに確認は要らない
  assert.equal(sessions.select('p', 'mock').connection.kind, 'mock');
});

test('費用のかかる接続の応答は、1 つの会話で上限の回数まで。モックは数えない', async (t) => {
  const { env } = await withLog(t);
  const sessions = new AiSessions({
    definitionOf: () => travel(),
    connections: [createMockConnection(), createClaudeCodeConnection({ env, allowed: true })],
  });
  t.after(() => sessions.close());
  await sessions.send('p', '湖');
  sessions.select('p', 'claude-code', { confirmed: true });
  // 上限の手前まで、記録だけを足す(CLI を 30 回起動しないため)
  const session = sessions.session('p');
  for (let i = 0; i < SESSION_LIMITS.maxPaidReplies - 1; i += 1) {
    session.messages.push({ role: 'user', text: 'x' }, { role: 'assistant', text: 'y', via: 'claude-code' });
  }
  await sessions.send('p', '山');
  await assert.rejects(sessions.send('p', '山'), { code: 'paid-limit', message: /30 回まで/ });
  sessions.select('p', 'mock');
  assert.equal((await sessions.send('p', '山')).messages.at(-1).via, 'mock');
  sessions.reset('p');
  sessions.select('p', 'claude-code', { confirmed: true });
  assert.equal((await sessions.send('p', '山')).messages.at(-1).via, 'claude-code');
});
