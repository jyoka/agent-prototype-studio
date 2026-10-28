import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { snapshotApp } from '../../src/server/app-snapshot.js';
import { createMockConnection } from '../../src/server/product-ai/mock.js';
import { createClaudeCodeAgent } from '../../src/server/sim/agent-claude-code.js';
import { createMockAgent } from '../../src/server/sim/agent-mock.js';
import { OUTPUT_FALLBACK_TEXT, runTurn, startConversation } from '../../src/server/sim/orchestrator.js';
import { FAKE_CLAUDE, buildSim, readJson } from '../fixtures/sim.js';

// 模擬のエージェントを Claude Code の接続で動かす(偽の claude。実モデルは呼ばない)。
// 偽の CLI は本物と同じく --mcp-config のツールの MCP サーバー(bin/tools-mcp.js)を子として起動し、道具を呼ぶ。
// モックの模擬のエージェントと同じツールの呼び出しなら、ツールの結果と守りの判定の列が同じになる(S19)
const posixOnly = { skip: process.platform === 'win32' ? '偽の claude をシェルスクリプトでつなぐため' : false };

async function fakeAgent(t, root, calls) {
  const bin = path.join(root, 'bin', 'claude');
  await fs.mkdir(path.dirname(bin), { recursive: true });
  await fs.writeFile(bin, `#!/bin/sh\nexec "${process.execPath}" "${FAKE_CLAUDE}" "$@"\n`, { mode: 0o755 });
  const callsFile = path.join(root, 'bin', 'tool-calls.json');
  await fs.writeFile(callsFile, JSON.stringify(calls));
  const log = path.join(root, 'bin', 'log.jsonl');
  const agent = createClaudeCodeAgent({ env: { PATH: process.env.PATH, STUDIO_CLAUDE_BIN: bin, FAKE_CLAUDE_TOOL_CALLS: callsFile, FAKE_CLAUDE_LOG: log } });
  t.after(() => agent.close());
  return { agent, log };
}

async function talk(sim, texts, { agent, projectDir }) {
  let conversation = startConversation(sim, { id: 'user-sim00001' });
  const turns = [];
  for (const item of texts) {
    const input = typeof item === 'string' ? { text: item } : item;
    const result = await runTurn({ sim, conversation, input, agent, harnessConnection: createMockConnection(), context: { projectDir, userId: 'fictional-user' } });
    conversation = result.conversation;
    turns.push(result);
  }
  return { conversation, turns };
}

const toolShape = (turns) =>
  turns.flatMap((turn) => turn.record.steps.filter((step) => step.tool !== undefined)).map(({ tool, by, args, result, guards }) => ({ tool, by, args, result, guards }));

// モックの決まり(test/fixtures/sim-a/app/mocks/partner.json)と同じ呼び出しを、偽の CLI に頼む
const SAME_CALLS = {
  探して: [{ tool: 'search_jobs', args: { area: 'みなと町' } }],
  詳しく: [{ tool: 'get_job', args: { id: 'j1' } }],
  'action:save': [{ tool: 'save_wish', args: { area: 'みなと町' } }],
  保存してよいです: [{ tool: 'record_consent', args: { agreed: true } }],
  電話して: [{ tool: 'save_wish', args: { note: '090-0000-0000 に電話して' } }],
};
const TEXTS = ['探して', '詳しく', { text: '保存する', action: 'save' }, '保存してよいです', { text: '保存する', action: 'save' }, '電話して'];

test('モックと偽の CLI(MCP のツールを呼ぶ)で、ツールの結果と守りの判定の列と、記録の店が同じ(S19)', posixOnly, async (t) => {
  const fixture = await buildSim(t, 'sim-a');
  const before = await snapshotApp(fixture.appDir);
  const viaMock = await talk(fixture.prepare(), TEXTS, { agent: createMockAgent(), projectDir: fixture.root });
  const { agent, log } = await fakeAgent(t, fixture.root, SAME_CALLS);
  const viaCli = await talk(fixture.prepare(), TEXTS, { agent, projectDir: fixture.root });

  assert.deepEqual(toolShape(viaCli.turns), toolShape(viaMock.turns));
  assert.equal(toolShape(viaCli.turns).length, 6);
  assert.deepEqual(viaCli.conversation.store, viaMock.conversation.store);
  assert.deepEqual(viaCli.conversation.calls, viaMock.conversation.calls);
  // 記録の正は、ツールの MCP サーバーが書いた calls.jsonl(伏せた形)
  const dir = path.join(fixture.root, '.studio', 'sim', 'user-sim00001');
  const lines = (await fs.readFile(path.join(dir, 'calls.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(lines.map((line) => line.tool), ['search_jobs', 'get_job', 'save_wish', 'record_consent', 'save_wish', 'save_wish']);
  assert.ok(lines.every((line) => line.by === 'partner'));
  assert.ok(!JSON.stringify(lines).includes('090-0000-0000'));
  assert.deepEqual(await readJson(path.join(dir, 'store.json')), viaMock.conversation.store);
  // 呼んだ参加者、辺、前提は、起動の引数ではなく文脈のファイルで渡す(起動の引数は 3 つのまま)
  const context = await readJson(path.join(dir, 'context.json'));
  assert.equal(context.by, 'partner');
  assert.equal(context.tools, 'tools.json');
  assert.equal(context.maxPerReply, 4);
  const config = await readJson(path.join(dir, 'mcp.json'));
  assert.deepEqual(Object.keys(config.mcpServers), ['proto']);
  assert.deepEqual(config.mcpServers.proto.args.slice(1), [fixture.root, '--conversation', 'user-sim00001', '--max-seconds', config.mcpServers.proto.args.at(-1)]);
  // app/ は変わらない
  assert.deepEqual(await snapshotApp(fixture.appDir), before);
  // 起動ごとに、許可は構成の tools の名前だけ
  const launches = (await fs.readFile(log, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(launches.length, TEXTS.length);
  for (const launch of launches) {
    const allowed = launch.argv[launch.argv.indexOf('--allowedTools') + 1];
    assert.equal(allowed, 'mcp__proto__search_jobs,mcp__proto__get_job,mcp__proto__suggest_questions,mcp__proto__record_consent,mcp__proto__save_wish');
  }
  // 記録には、送った起動の形と費用が残る
  const agentStep = viaCli.turns[0].record.steps[0];
  assert.equal(agentStep.connection, 'claude-code');
  assert.equal(agentStep.real, true);
  assert.equal(agentStep.costUsd, 0.002);
  assert.ok(agentStep.command.includes('--strict-mcp-config'));
});

test('構成に渡していない名前の道具は、Claude Code が呼ばずに断り、記録に permission の断りとして残る', posixOnly, async (t) => {
  const fixture = await buildSim(t, 'sim-a');
  const sim = fixture.prepare();
  sim.composition.participants[0].tools = sim.composition.participants[0].tools.filter((name) => name !== 'get_job');
  const { agent } = await fakeAgent(t, fixture.root, { 詳しく: [{ tool: 'get_job', args: { id: 'j1' } }] });
  const { turns } = await talk(sim, ['詳しく'], { agent, projectDir: fixture.root });
  const [step] = turns[0].record.steps.filter((s) => s.tool !== undefined);
  assert.equal(step.tool, 'mcp__proto__get_job');
  assert.deepEqual(step.guards.map((g) => [g.layer, g.guard, g.effect]), [['permission', 'allowedTools', 'blocked']]);
  assert.equal(await fs.stat(path.join(fixture.root, '.studio', 'sim', 'user-sim00001', 'calls.jsonl')).catch(() => null), null);
});

test('ツールの MCP サーバーの道具の一覧に出るのは、呼んだ参加者のツールだけ。ほかの名前は呼んでも断る(S14)', posixOnly, async (t) => {
  const fixture = await buildSim(t, 'sim-a');
  const sim = fixture.prepare();
  sim.composition.participants[0].tools = ['search_jobs'];
  const { agent } = await fakeAgent(t, fixture.root, { 探して: [{ tool: 'search_jobs', args: { area: 'みなと町' } }] });
  await talk(sim, ['探して'], { agent, projectDir: fixture.root });
  const dir = path.join(fixture.root, '.studio', 'sim', 'user-sim00001');
  assert.deepEqual((await readJson(path.join(dir, 'context.json'))).allowedTools, ['search_jobs']);
  // Studio が書いた mcp.json のとおりにツールの MCP サーバーを起動し、模擬のエージェントの代わりに一覧を聞いて、ほかの名前を呼ぶ
  const { command, args } = (await readJson(path.join(dir, 'mcp.json'))).mcpServers.proto;
  const requests = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'sim-agent-test', version: '1' } } },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'get_job', arguments: { id: 'j1' } } },
  ];
  const run = spawnSync(command, args, {
    input: requests.map((request) => `${JSON.stringify(request)}\n`).join(''),
    env: { PATH: process.env.PATH, STUDIO_AGENT: 'fake' },
    encoding: 'utf8',
    timeout: 15_000,
  });
  assert.equal(run.status, 0, run.stderr);
  const answers = new Map(run.stdout.trim().split('\n').map((line) => JSON.parse(line)).map((message) => [message.id, message]));
  assert.deepEqual(answers.get(2).result.tools.map((tool) => tool.name), ['search_jobs']);
  assert.equal(answers.get(3).result.isError, true);
  const lines = (await fs.readFile(path.join(dir, 'calls.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  const refused = lines.at(-1);
  assert.equal(refused.tool, 'get_job');
  assert.deepEqual(refused.guards.map((g) => [g.layer, g.guard, g.effect]), [['permission', 'allowedTools', 'blocked']]);
});

test('偽の CLI でも、引き継ぎはツールの MCP サーバーから受け取り、相談役に値を渡して、そのターンに 1 回だけ話させる', posixOnly, async (t) => {
  const fixture = await buildSim(t, 'sim-c');
  const { agent } = await fakeAgent(t, fixture.root, { 全部お願い: [{ tool: 'handoff_to_consult', args: { area: 'みなと町', minWage: 1100 } }] });
  const { conversation, turns } = await talk(fixture.prepare(), ['全部お願い', 'こんにちは'], { agent, projectDir: fixture.root });
  assert.deepEqual(turns[0].said.map((m) => m.from), ['front', 'consult']);
  assert.deepEqual(turns[0].record.handoff.carry, { accepted: ['area', 'minWage'], rejected: [] });
  assert.deepEqual(conversation.harness.consult.state, { area: 'みなと町', minWage: 1100 });
  assert.equal(turns[0].record.returned.to, 'front');
  assert.deepEqual(turns[1].said.map((m) => m.from), ['front']);
  // 引き継ぎの受け渡しのファイルは、読んだら消す
  assert.equal(await fs.stat(path.join(fixture.root, '.studio', 'sim', 'user-sim00001', 'handoff.json')).catch(() => null), null);
});

test('ツールを呼びすぎて --max-turns で止まった返事(0 でない終了コード)は、失敗にせず 1 回やり直し、だめなら決まった文にする', posixOnly, async (t) => {
  const fixture = await buildSim(t, 'sim-a');
  // partner-b は 1 回の返事のツールが 2 回まで(--max-turns 3)。3 回呼ぼうとする
  const three = [1, 2, 3].map(() => ({ tool: 'suggest_questions', args: {} }));
  const { agent, log } = await fakeAgent(t, fixture.root, { 聞くことを全部: three });
  const { turns } = await talk(fixture.prepare({ assumptionId: 'partner-b' }), ['聞くことを全部'], { agent, projectDir: fixture.root });
  assert.equal(turns[0].said[0].text, OUTPUT_FALLBACK_TEXT);
  const launches = (await fs.readFile(log, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(launches.length, 2);
  assert.equal(launches[0].argv[launches[0].argv.indexOf('--max-turns') + 1], '3');
  assert.ok(turns[0].record.steps.some((step) => step.fallback));
});
