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
  createClaudeCodeConnection,
  extractInput,
  extractPrompt,
  extractSchema,
  extractionProblem,
  parseResult,
  phraseInput,
  phrasePrompt,
  phraseSchema,
  replyProblem,
} from '../../src/server/product-ai/claude-code.js';
import { INTENTS, parseAiDefinition } from '../../src/server/product-ai/definition.js';
import { createTurnMeter } from '../../src/server/product-ai/limits.js';
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

const valueOf = (args, name) => {
  const joined = args.find((arg) => arg.startsWith(`${name}=`));
  return joined ? joined.slice(name.length + 1) : args[args.indexOf(name) + 1];
};

test('起動の引数は、抽出も言い方も閉じ込めのフラグを必ず含み、道具を渡さず、発言は argv に入れない(S10)', () => {
  const definition = travel();
  for (const kind of ['extract', 'phrase']) {
    const args = buildArgs(definition, kind);
    for (const flag of ['-p', '--restricted', '--safe-mode', '--strict-mcp-config', '--no-session-persistence']) {
      assert.ok(args.includes(flag), `${kind}: ${flag}`);
    }
    // 道具は渡さない
    assert.equal(args[args.indexOf('--tools') + 1], '', kind);
    assert.equal(args[args.indexOf('--permission-mode') + 1], 'dontAsk');
    assert.equal(args[args.indexOf('--output-format') + 1], 'json');
    for (const forbidden of ['--dangerously-skip-permissions', '--allow-dangerously-skip-permissions', 'bypassPermissions', '--bare', '--resume', '--continue', '--mcp-config', '--allowedTools']) {
      assert.ok(!args.includes(forbidden), `${kind}: ${forbidden}`);
    }
    // ログインが Console のアカウントなら API キーがなくても従量課金なので、1 回の費用の上限はいつも付ける
    assert.equal(args[args.indexOf('--max-budget-usd') + 1], String(CLAUDE_CODE_LIMITS.maxBudgetUsd));
  }
  // 違うのは、応答の形と指示だけ
  const extract = buildArgs(definition, 'extract');
  const phrase = buildArgs(definition, 'phrase');
  assert.deepEqual(
    extract.filter((arg) => !/^--(json-schema|system-prompt)=/.test(arg)),
    phrase.filter((arg) => !/^--(json-schema|system-prompt)=/.test(arg)),
  );
  assert.deepEqual(JSON.parse(valueOf(extract, '--json-schema')), extractSchema(definition));
  assert.deepEqual(JSON.parse(valueOf(phrase, '--json-schema')), phraseSchema());
  // - で始まる指示も、フラグとして読まれない形で渡す。作り手の instructions は言い方にだけ渡す
  assert.ok(phrase.some((arg) => arg.startsWith('--system-prompt=- 架空の旅行会社の案内役です。')));
  assert.doesNotMatch(valueOf(extract, '--system-prompt'), /架空の旅行会社の案内役です/);
  assert.throws(() => buildArgs(definition, 'respond'), /知らない呼び出しの種類/);

  const input = extractInput({ definition, state: { place: null, nights: null }, messages: [], text: '--湖に行きたい' });
  assert.ok(!extract.some((arg) => arg.includes('--湖に行きたい')));
  assert.match(input, /<新しい発言>\n--湖に行きたい\n<\/新しい発言>/);
});

test('応答の形は 2 つだけ: 抽出は全部の項目と intent、言い方は {reply}(S17)', () => {
  const definition = travel();
  const schema = extractSchema(definition);
  assert.deepEqual(Object.keys(schema.properties), ['updates', 'intent']);
  assert.deepEqual(schema.required, ['updates', 'intent']);
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.properties.updates.properties.place, { enum: ['湖の町', '山の村', null] });
  assert.deepEqual(schema.properties.updates.properties.nights, { type: ['number', 'null'], minimum: 1, maximum: 14 });
  assert.equal(schema.properties.updates.additionalProperties, false);
  assert.deepEqual(schema.properties.intent, { enum: [...INTENTS, null] });
  assert.deepEqual(phraseSchema(), { type: 'object', properties: { reply: { type: 'string' } }, required: ['reply'], additionalProperties: false });

  // 抽出の指示は項目と intent を、言い方の指示は作り手の instructions と、決定に従うことを書く
  assert.match(extractPrompt(definition), /nights\(泊数\): 数、単位は泊、1 以上、14 以下/);
  assert.match(extractPrompt(definition), /- clarify: 質問を返した/);
  assert.match(phrasePrompt(definition), /^- 架空の旅行会社の案内役です。/);
  assert.match(phrasePrompt(definition), /何を聞くか、何を言うか、会話を終えるかは Studio が決めて/);

  // 言い方の本文は、決定の中身(何を聞くか、何を言うか)を渡す
  const decision = { step: 'hear', ask: 'nights', say: null, changes: [{ key: 'place' }], corrected: [], intent: 'answer', done: false, mustInclude: ['何泊しますか?'] };
  const said = phraseInput({ definition, decision, state: { place: '湖の町', nights: null }, messages: [], text: '湖がいい' });
  assert.match(said, /<新しい発言>\n湖がいい\n<\/新しい発言>/);
  assert.match(said, /- place\(行き先\): 湖の町/);
  assert.match(said, /<言うこと>\n- 今の発言から読み取った値\(理解したと伝える\): 行き先「湖の町」\n- 聞く問い\(この文をそのまま入れる\): 何泊しますか\?\n<\/言うこと>/);
  const ending = phraseInput({ definition, decision: { ...decision, ask: null, say: 'complete', changes: [], done: true, mustInclude: [] }, state: {}, messages: [] });
  assert.match(ending, /- 会話を終える/);
  assert.doesNotMatch(ending, /聞く問い/);
  // やり直しのときだけ、前の出力の問題を足す
  assert.doesNotMatch(said, /前の出力の問題/);
  assert.match(phraseInput({ definition, decision, state: {}, messages: [], problem: 'reply が空か、文でなかった' }), /<前の出力の問題>\n前の出力はreply が空か、文でなかったので/);
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

test('CLI の結果を読む: 構造化出力、本文の JSON、壊れた出力、上限、費用、ログイン、読めない出力', () => {
  const ok = (extra) => JSON.stringify({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.01, ...extra });
  assert.deepEqual(parseResult(ok({ structured_output: { updates: { place: '湖の町' }, intent: 'answer' } })), {
    output: { updates: { place: '湖の町' }, intent: 'answer' },
    format: 'structured',
    meta: { costUsd: 0.01, durationMs: null },
  });
  assert.deepEqual(parseResult(ok({ result: '```json\n{"reply":"本文"}\n```' })).output, { reply: '本文' });
  const textJson = parseResult(ok({ result: '{"reply":"本文"}', duration_ms: 1200 }));
  assert.equal(textJson.format, 'text-json');
  assert.equal(textJson.meta.durationMs, 1200);
  // JSON で返さなかったとき、空のときは、モデルの出力が壊れている(やり直すかは呼ぶ側が決める)
  assert.deepEqual(parseResult(ok({ result: 'JSON ではない返事' })), { output: null, format: 'broken', meta: { costUsd: 0.01, durationMs: null } });
  assert.equal(parseResult(ok({ result: '' })).format, 'broken');

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

  // 形の検査。値が項目の決まりに合うかは harness が確かめる
  assert.equal(extractionProblem({ updates: { place: 'ない選択肢' }, intent: 'maybe' }), null);
  assert.equal(extractionProblem({ updates: {} }), null);
  assert.equal(extractionProblem(null), 'JSON の出力がなかった');
  assert.equal(extractionProblem({ intent: 'answer' }), 'updates が { 項目の key: 値 } の形でなかった');
  assert.equal(extractionProblem({ updates: [] }), 'updates が { 項目の key: 値 } の形でなかった');
  assert.equal(extractionProblem({ updates: {}, intent: 1 }), 'intent が文字列でなかった');
  assert.equal(replyProblem({ reply: 'はい' }), null);
  assert.equal(replyProblem({ reply: ' ' }), 'reply が空か、文でなかった');
  assert.equal(replyProblem({ updates: {} }), 'reply が空か、文でなかった');
});

const decisionAsking = (definition, key) => ({
  step: 'hear',
  ask: key,
  say: null,
  changes: [],
  corrected: [],
  intent: 'answer',
  done: false,
  mustInclude: [definition.fields.find((f) => f.key === key).question],
});

test('偽の CLI で抽出と言い方を呼ぶ: 会話の全体を毎回渡し、空の作業フォルダーで動かし、回数と待ち時間を数える', async (t) => {
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
  const meter = createTurnMeter();
  const extracted = await connection.extract({ definition, state: { place: '山の村', nights: null }, messages, text: '3泊したい', meter });
  assert.deepEqual(extracted, { updates: { nights: 3 }, intent: 'answer' });
  const said = await connection.phrase({ definition, decision: decisionAsking(definition, 'place'), state: { place: '山の村', nights: 3 }, messages, text: '3泊したい', meter });
  assert.deepEqual(said, { reply: `偽の Claude Code です。これまでの会話を受け取りました(修正の記録あり)。「3泊したい」への返事です。${definition.fields[0].question}` });

  const [first, second] = await calls();
  assert.match(first.stdin, /\[利用者の修正\] 行き先を「山の村」に直しました。/);
  assert.match(first.stdin, /- place\(行き先\): 山の村/);
  assert.ok(JSON.parse(first.argv.find((a) => a.startsWith('--json-schema=')).slice(14)).properties.updates);
  assert.deepEqual(Object.keys(JSON.parse(second.argv.find((a) => a.startsWith('--json-schema=')).slice(14)).properties), ['reply']);
  assert.match(second.stdin, /<言うこと>[\s\S]*聞く問い/);
  for (const call of [first, second]) {
    assert.deepEqual(await fs.readdir(call.cwd), []);
    assert.ok(path.basename(call.cwd).startsWith('studio-product-ai-'));
    // 資格情報を足さない。渡すのは利用者の環境変数そのもの
    assert.deepEqual(call.envNames, ['FAKE_CLAUDE_LOG', 'STUDIO_CLAUDE_BIN']);
  }
  const summary = meter.summary();
  assert.deepEqual([summary.count, summary.extract, summary.phrase, summary.costUsd, summary.durationMs, summary.format], [2, 1, 1, 0.0024, 10, 'structured']);
  assert.ok(summary.calls.every((call) => Number.isFinite(call.waitMs) && call.waitMs >= 0));
  assert.deepEqual(summary.calls.map((c) => [c.kind, c.attempt, c.problem]), [['extract', 1, null], ['phrase', 1, null]]);

  // 構造化出力がないときは、本文の JSON を読む
  const fallback = await connection.extract({ definition, state: {}, messages: [], text: '湖の町に[文だけ]' });
  assert.deepEqual(fallback.updates, { place: '湖の町' });
});

test('出力が壊れたら 1 回やり直し、だめなら抽出は「変更なし」、言い方はモックの型で返り、どちらになったかが記録に残る', async (t) => {
  const { env, calls } = await withLog(t);
  const connection = createClaudeCodeConnection({ env, allowed: true });
  t.after(() => connection.close());
  const definition = travel();
  const state = { place: null, nights: null };

  // 1 回目だけ壊れる: やり直しの本文に前の出力の問題を足し、2 回目の出力を使う
  let meter = createTurnMeter();
  const once = await connection.extract({ definition, state, messages: [], text: '湖の町 [抽出が一度壊れる]', meter });
  assert.deepEqual(once.updates, { place: '湖の町' });
  assert.match(once.retry, /1 回目の出力はupdates が \{ 項目の key: 値 \} の形でなかったので、やり直した/);
  assert.equal(once.fallback, undefined);
  const [, retried] = await calls();
  assert.match(retried.stdin, /<前の出力の問題>/);
  assert.deepEqual(meter.summary().calls.map((c) => [c.kind, c.attempt, c.format, c.problem]), [
    ['extract', 1, 'broken', 'updates が { 項目の key: 値 } の形でなかった'],
    ['extract', 2, 'structured', null],
  ]);

  // 2 回とも壊れる: 抽出は変更なし、言い方は reply なし(harness がモックの型に代える)
  meter = createTurnMeter();
  const broken = await connection.extract({ definition, state, messages: [], text: '湖の町 [抽出が壊れる]', meter });
  assert.deepEqual([broken.updates, broken.intent], [{}, null]);
  assert.match(broken.fallback, /2 回とも出力が壊れていた\(.*\)ので、変更なしにした/);
  const silent = await connection.phrase({ definition, decision: decisionAsking(definition, 'place'), state, messages: [], text: '[言い方が壊れる]', meter });
  assert.equal(silent.reply, null);
  assert.match(silent.fallback, /2 回とも出力が壊れていた\(reply が空か、文でなかった、reply が空か、文でなかった\)/);
  assert.deepEqual([meter.summary().extract, meter.summary().phrase, meter.summary().format], [2, 2, 'broken']);

  // 会話を通すと: 状態は変えず、返事はモックの型の文。記録にどちらになったかが残る
  const sessions = new AiSessions({ definitionOf: () => definition, connections: [connection] });
  const view = await sessions.send('p', '湖の町で3泊 [抽出が壊れる] [言い方が壊れる]');
  assert.deepEqual(view.state, { place: null, nights: null });
  assert.equal(view.messages.at(-1).text, 'すみません、条件として読み取れませんでした。行き先を教えてください。');
  assert.equal(view.messages.at(-1).via, 'claude-code');
  const [entry] = sessions.trace('p').entries;
  assert.equal(entry.status, 'ok');
  assert.match(entry.harness.extract.fallback, /変更なしにした/);
  assert.match(entry.harness.phrase.fallback, /2 回とも出力が壊れていた.*ので、mock の型の文に代えた/);
  assert.equal(entry.output.format, 'broken');
  assert.deepEqual([entry.calls.count, entry.calls.extract, entry.calls.phrase], [4, 2, 2]);

  const fixed = await sessions.send('p', '湖の町で3泊 [言い方が一度壊れる]');
  assert.deepEqual(fixed.state, { place: '湖の町', nights: 3 });
  assert.match(fixed.messages.at(-1).text, /^偽の Claude Code です。/);
  const [again] = sessions.trace('p').entries;
  assert.match(again.harness.phrase.retry, /やり直した/);
  assert.equal(again.harness.phrase.fallback, undefined);
  assert.deepEqual([again.calls.extract, again.calls.phrase], [1, 2]);
});

test('偽の CLI の失敗: 上限、異常終了、見つからない、時間切れ、中断', async (t) => {
  const { env, calls } = await withLog(t);
  const definition = travel();
  const ask = (connection, text, signal) => connection.extract({ definition, state: {}, messages: [], text, signal });
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
  const pending = connection.extract({ definition: travel(), state: {}, messages: [], text: '[しぶとい]' });
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
  assert.match(option.sends.systemPrompt, /^【抽出の指示】\n[\s\S]*\n【言い方の指示】\n- 架空の旅行会社の案内役です/);

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
  assert.match(view.messages.at(-1).text, /これまでの会話を受け取りました/);
  // 抽出と言い方の 2 回の合計
  assert.equal(view.messages.at(-1).costUsd, 0.0024);
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
