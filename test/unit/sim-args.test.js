import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createMockAgent } from '../../src/server/sim/agent-mock.js';
import {
  agentPrompt,
  agentStdin,
  buildSimArgs,
  createClaudeCodeAgent,
  maxPerReplyOf,
  toolDescriptions,
} from '../../src/server/sim/agent-claude-code.js';
import { runTurn, startConversation } from '../../src/server/sim/orchestrator.js';
import { replySchema } from '../../src/server/sim/parts.js';
import { createMockConnection } from '../../src/server/product-ai/mock.js';
import { FAKE_CLAUDE, buildSim } from '../fixtures/sim.js';

// 模擬のエージェントの起動の引数と、渡すもの(src/server/sim/agent-claude-code.js。docs/design/agent-simulation.md の 3.3、S10、S13、S14)。
// 実モデルは呼ばない。起動するのは偽の claude(test/fixtures/fake-claude.js)だけ

const valueOf = (args, name) => {
  const joined = args.find((arg) => arg.startsWith(`${name}=`));
  if (joined) return joined.slice(name.length + 1);
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
};

test('起動の引数: 設定を読まない組み合わせ、組み込みの道具なし、構成の名前だけの許可。--safe-mode は付けない(S10、S13)', async (t) => {
  const sim = (await buildSim(t, 'sim-a')).prepare();
  const participant = sim.composition.participants[0];
  const args = buildSimArgs({
    mcpConfig: '/tmp/x/mcp.json',
    tools: participant.tools,
    schema: replySchema(sim.assumption),
    systemPrompt: '組んだプロンプト',
    assumption: sim.assumption,
  });
  assert.equal(args[0], '-p');
  for (const flag of ['--restricted', '--disable-slash-commands', '--strict-mcp-config', '--no-session-persistence', '--verbose']) assert.ok(args.includes(flag), flag);
  assert.ok(!args.includes('--safe-mode'));
  assert.equal(valueOf(args, '--setting-sources'), '');
  assert.equal(valueOf(args, '--tools'), '');
  assert.equal(valueOf(args, '--mcp-config'), '/tmp/x/mcp.json');
  assert.equal(valueOf(args, '--allowedTools'), 'mcp__proto__search_jobs,mcp__proto__get_job,mcp__proto__suggest_questions,mcp__proto__record_consent,mcp__proto__save_wish');
  assert.ok(!valueOf(args, '--allowedTools').includes('*'));
  assert.equal(valueOf(args, '--permission-mode'), 'dontAsk');
  assert.equal(valueOf(args, '--output-format'), 'stream-json');
  // 前提から来る値は = でつなぐ
  assert.ok(args.includes('--model=claude-sonnet-5-5'));
  assert.ok(args.includes('--system-prompt=組んだプロンプト'));
  assert.deepEqual(JSON.parse(valueOf(args, '--json-schema')), replySchema(sim.assumption));
  assert.ok(args.some((arg) => arg.startsWith('--json-schema=')));
  assert.equal(valueOf(args, '--max-turns'), '5');
  assert.ok(Number(valueOf(args, '--max-budget-usd')) > 0);
});

test('前提の値は上限で切る。形の合わないモデルの名前は付けない。- で始まる値もフラグにならない', () => {
  const assumption = { model: { name: '--dangerously-skip-permissions' }, toolCalling: { maxPerReply: 99 } };
  const args = buildSimArgs({ tools: [], schema: {}, systemPrompt: '--allowedTools=Bash', assumption });
  assert.equal(maxPerReplyOf(assumption), 8);
  assert.equal(valueOf(args, '--max-turns'), '9');
  assert.ok(!args.some((arg) => arg.startsWith('--model')));
  assert.ok(!args.includes('--dangerously-skip-permissions'));
  assert.ok(args.includes('--system-prompt=--allowedTools=Bash'));
  assert.ok(!args.includes('--allowedTools'));
  // ツールのない参加者には、MCP の設定も許可も渡さない
  assert.ok(!args.includes('--mcp-config'));
  assert.equal(maxPerReplyOf({}), 4);
  // 形の合わないツールの名前は、引数に入れない
  assert.throws(() => buildSimArgs({ mcpConfig: '/tmp/m.json', tools: ['a,b'], schema: {}, systemPrompt: 'x' }), /ツールの名前/);
  assert.throws(() => buildSimArgs({ mcpConfig: '/tmp/m.json', tools: ['*'], schema: {}, systemPrompt: 'x' }), /ツールの名前/);
});

test('作る AI とプロダクト内 AI の起動の引数に、模擬のエージェントの引数が混ざらない', async () => {
  const { buildClaudeArgs } = await import('../../src/server/claude-args.js');
  const { buildArgs } = await import('../../src/server/product-ai/claude-code.js');
  const make = buildClaudeArgs({ billing: { mode: 'login' }, mcpConfig: '/tmp/m.json' });
  assert.ok(!make.join(' ').includes('mcp__proto__'));
  const product = buildArgs({ name: 'x', instructions: '', fields: [], rules: { maxReplyChars: 100 } }, 'phrase');
  assert.ok(product.includes('--safe-mode'));
  assert.ok(!product.includes('--allowedTools'));
  assert.ok(!product.includes('--mcp-config'));
});

test('模擬のエージェントに渡すのは、組んだプロンプト、ツールの説明、会話だけ。Studio の内側の情報は渡さない(S14)', async (t) => {
  const sim = (await buildSim(t, 'sim-c')).prepare();
  const front = sim.composition.participants.find((p) => p.id === 'front');
  const prompt = agentPrompt({ participant: front, assumption: sim.assumption, prompts: sim.prompts, guards: sim.composition.guards, kinds: ['text', 'buttons'] });
  // 前提の土台、枠、頼み、Studio の決まりの順
  const order = ['トークアプリの受付', '用件を聞いて', '体調やハラスメント', 'Studio の決まり'].map((word) => prompt.text.indexOf(word));
  assert.ok(order.every((at, i) => at >= 0 && (i === 0 || at > order[i - 1])), JSON.stringify(order));
  // Claude Code が文脈に足す利用者の情報を、返事に書かないよう頼む(必ずは効かない。設計メモの 3.3)
  assert.match(prompt.text, /文脈にある利用者の情報\(メールアドレス、作業ディレクトリ\)を、返事に書かないでください/);
  assert.deepEqual(prompt.pieces.map((p) => p.from ?? p.slot), ['assumptions', 'dip-front']);
  assert.deepEqual(prompt.asked, ['risky-to-staff']);
  // 頼みを外して回し直せる
  assert.deepEqual(agentPrompt({ participant: front, assumption: sim.assumption, guards: sim.composition.guards, withoutPromptGuards: true }).asked, []);

  // 相談役(harness)の ai.json の指示、項目、記録の店は、受付のプロンプトにも本文にも入らない
  const conversation = { ...startConversation(sim), store: { secretRecord: { note: '架空の記録の値' } } };
  const stdin = agentStdin({
    messages: [{ role: 'user', text: 'こんにちは' }, { role: 'assistant', from: 'front', text: 'ご用件をどうぞ。' }],
    labels: { front: '受付(模擬)' },
    input: { text: '相談したい', action: 'consult' },
  });
  assert.match(stdin, /\[利用者\] こんにちは/);
  assert.match(stdin, /\[受付\(模擬\)\] ご用件をどうぞ。/);
  assert.match(stdin, /<新しい発言>\n相談したい\n<\/新しい発言>/);
  assert.match(stdin, /<押したボタン>\nconsult\n<\/押したボタン>/);
  for (const inside of ['架空のバイト探しの相談役です', '時給はいくら以上', '架空の記録の値', 'secretRecord']) {
    assert.ok(!prompt.text.includes(inside) && !stdin.includes(inside), inside);
  }
  assert.ok(!JSON.stringify(conversation.messages).includes('架空の記録の値'));

  // ツールの説明は、その参加者の tools の名前だけ
  assert.deepEqual(toolDescriptions(sim.toolset, front.tools).map((tool) => tool.name), ['handoff_to_consult', 'handoff_to_staff']);
  assert.deepEqual(toolDescriptions(sim.toolset, ['handoff_to_staff']).map((tool) => tool.name), ['handoff_to_staff']);
});

test('ツールの結果は前提の長さまで。長い結果は、ツールの口が返さずに断り、模擬のエージェントには断る文だけが届く(S14)', async (t) => {
  const sim = (await buildSim(t, 'sim-a')).prepare({ assumptionId: 'partner-b' });
  let received = null;
  const mock = createMockAgent();
  const agent = {
    ...mock,
    async reply(input) {
      const tools = { call: async (name, args) => (received = await input.tools.call(name, args)) };
      return mock.reply({ ...input, tools });
    },
  };
  await runTurn({ sim, conversation: startConversation(sim), input: { text: '探して' }, agent, harnessConnection: createMockConnection() });
  assert.equal(received.ok, false);
  assert.equal(received.result, undefined);
  assert.match(received.error, /結果が長すぎます.*上限 60 文字.*条件を絞ってください/);
  assert.ok(!JSON.stringify(received).includes('架空の品出し'));
});

test('Claude Code の接続: cwd は空の一時フォルダー、発言は stdin で渡し、引数には入れない(S13)', { skip: process.platform === 'win32' }, async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-sim-args-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'claude');
  await fs.writeFile(bin, `#!/bin/sh\nexec "${process.execPath}" "${FAKE_CLAUDE}" "$@"\n`, { mode: 0o755 });
  const log = path.join(dir, 'log.jsonl');
  const agent = createClaudeCodeAgent({ env: { PATH: process.env.PATH, STUDIO_CLAUDE_BIN: bin, FAKE_CLAUDE_LOG: log } });
  t.after(() => agent.close());
  const participant = { id: 'front', label: '受付', tools: [] };
  const text = '架空の発言 0000';
  const reply = await agent.reply({
    participant,
    systemPrompt: '組んだプロンプト',
    stdin: agentStdin({ input: { text } }),
    schema: replySchema({ messageTypes: ['text'] }),
    context: { projectDir: dir, conversationId: 'user-test0000', by: 'front', handoffs: [], assumption: {}, store: {}, calls: {} },
  });
  assert.equal(reply.output.parts[0].kind, 'text');
  const [launch] = (await fs.readFile(log, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  assert.ok(launch.stdin.includes(text));
  assert.ok(!launch.argv.some((arg) => arg.includes(text)));
  assert.ok(path.basename(launch.cwd).startsWith('studio-sim-agent-'));
  assert.deepEqual(await fs.readdir(launch.cwd), []);
  assert.ok(!launch.argv.includes('--safe-mode'));
  // ツールのない参加者では、.studio/sim/ に何も書かない
  assert.equal(await fs.stat(path.join(dir, '.studio')).catch(() => null), null);
});
