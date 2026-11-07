import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildApp } from '../../src/server/build.js';
import { STUDIO_ROOT } from '../../src/server/config.js';
import { createMockConnection } from '../../src/server/product-ai/mock.js';
import { createClaudeCodeAgent } from '../../src/server/sim/agent-claude-code.js';
import { prepareSimulation, runTurn, startConversation } from '../../src/server/sim/orchestrator.js';
import { FAKE_CLAUDE, readJson } from '../fixtures/sim.js';

// マスターとサブの委任(docs/design/agent-simulation.md の 2.9)を、Claude Code の接続で回す(偽の claude。実モデルは呼ばない)。
// 委任のツールはツールの MCP サーバー(bin/tools-mcp.js)を通り、通った頼みを delegate.json で Studio に返す。
// サブを起動するのは会話の進め方で、サブの起動に渡すツールはサブの tools だけ。見本は samples/redelivery(架空)
const posixOnly = { skip: process.platform === 'win32' ? '偽の claude をシェルスクリプトでつなぐため' : false };
const MASTER_SUB = 'compositions/master-sub.json';

async function setup(t, calls) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-delegate-cli-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const appDir = path.join(root, 'app');
  await fs.cp(path.join(STUDIO_ROOT, 'samples', 'redelivery', 'app'), appDir, { recursive: true });
  const built = await buildApp({ appDir, buildsDir: path.join(root, '.studio', 'builds') });
  assert.ok(built.ok, JSON.stringify(built.errors));
  const aiOf = (file) => built.simulation.harnessAis?.[file] ?? (file === built.manifest.ai ? built.ai : null);
  const composition = built.simulation.compositions.find((item) => item.file === MASTER_SUB).composition;
  const sim = prepareSimulation({ ...built.simulation, composition }, { aiOf, dataNumbers: built.dataNumbers ?? [] });

  const bin = path.join(root, 'bin', 'claude');
  await fs.mkdir(path.dirname(bin), { recursive: true });
  await fs.writeFile(bin, `#!/bin/sh\nexec "${process.execPath}" "${FAKE_CLAUDE}" "$@"\n`, { mode: 0o755 });
  const callsFile = path.join(root, 'bin', 'tool-calls.json');
  await fs.writeFile(callsFile, JSON.stringify(calls));
  const log = path.join(root, 'bin', 'log.jsonl');
  const agent = createClaudeCodeAgent({ env: { PATH: process.env.PATH, STUDIO_CLAUDE_BIN: bin, FAKE_CLAUDE_TOOL_CALLS: callsFile, FAKE_CLAUDE_LOG: log } });
  t.after(() => agent.close());
  const say = async (text) => runTurn({
    sim,
    conversation: startConversation(sim, { id: 'user-deleg001' }),
    input: { text },
    agent,
    harnessConnection: createMockConnection(),
    context: { projectDir: root, userId: 'fictional-user' },
  });
  const launches = async () => (await fs.readFile(log, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  return { root, say, launches };
}

const allowedOf = (launch) => launch.argv[launch.argv.indexOf('--allowedTools') + 1];

test('Claude Code の接続: マスターの委任のツールが MCP を通り、Studio がサブを起動し、結果を足してマスターをもう一度起動する', posixOnly, async (t) => {
  const { root, say, launches } = await setup(t, {
    '番号は 1001 です': [{ tool: 'ask_parcel_desk', args: { task: '荷物 1001 を調べてください', parcel_no: 1001 } }],
    '荷物 1001 を調べてください': [{ tool: 'get_parcel', args: { parcel_no: 1001 } }],
  });
  const { record, said } = await say('番号は 1001 です');
  assert.deepEqual(record.delegations, [{ from: 'desk-master', to: 'parcel-sub', depth: 1, round: 1, effect: 'passed', reply: { chars: record.delegations[0].reply.chars } }]);
  assert.deepEqual(record.steps.filter((step) => step.tool).map((step) => [step.tool, step.by, step.result.ok]), [
    ['ask_parcel_desk', 'desk-master', true],
    ['get_parcel', 'parcel-sub', true],
  ]);
  assert.deepEqual(record.steps.filter((step) => step.kind === 'agent').map((step) => [step.participant, step.depth, step.parent ?? null, step.costUsd]), [
    ['desk-master', 0, null, 0.002],
    ['parcel-sub', 1, 'desk-master', 0.002],
    ['desk-master', 0, null, 0.002],
  ]);
  assert.match(said[0].text, /「番号は 1001 です」への返事/);

  // 起動は 3 回。サブの起動に許可するのはサブのツールだけ。サブには会話でなく依頼の文を渡す
  const [master, sub, again] = await launches();
  assert.equal(allowedOf(master), 'mcp__proto__ask_parcel_desk,mcp__proto__ask_booking_desk,mcp__proto__handoff_to_staff');
  assert.equal(allowedOf(sub), 'mcp__proto__get_parcel');
  assert.match(sub.stdin, /<依頼の文>\n荷物 1001 を調べてください\n<\/依頼の文>/);
  assert.doesNotMatch(sub.stdin, /<これまでの会話>|番号は 1001 です/);
  assert.match(again.stdin, /<任せた仕事の結果>\n\[荷物の係\(サブ、模擬\)\] 偽の Claude Code です。「荷物 1001 を調べてください」への返事です。\n<\/任せた仕事の結果>/);
  // 文脈のファイルには、最後に起動した参加者の委任の辺と残りが入る。delegate.json は読んだ後に消す
  const dir = path.join(root, '.studio', 'sim', 'user-deleg001');
  const context = await readJson(path.join(dir, 'context.json'));
  assert.equal(context.by, 'desk-master');
  assert.deepEqual(context.delegations.map((edge) => [edge.from, edge.to]), [['desk-master', 'parcel-sub'], ['desk-master', 'booking-sub']]);
  assert.equal(context.delegationsLeft, 1);
  assert.equal(context.depthLeft, 1);
  assert.equal(await fs.stat(path.join(dir, 'delegate.json')).catch(() => null), null);
});

test('Claude Code の接続: 1 回の返事で上限より多く任せても、ツールの MCP サーバーが断り、サブは上限の回数だけ起動する', posixOnly, async (t) => {
  const ask = { tool: 'ask_parcel_desk', args: { task: '荷物 1001 を調べてください', parcel_no: 1001 } };
  const { say, launches } = await setup(t, { '番号は 1001 です': [ask, ask, ask] });
  const { record } = await say('番号は 1001 です');
  const asks = record.steps.filter((step) => step.tool === 'ask_parcel_desk');
  const limitOf = (step) => step.guards.find((guard) => guard.guard === 'maxDelegations')?.effect;
  assert.deepEqual(asks.map((step) => [step.result.ok, limitOf(step)]), [
    [true, 'passed'],
    [true, 'passed'],
    [false, 'blocked'],
  ]);
  assert.deepEqual(record.delegations.map((d) => d.effect), ['passed', 'passed']);
  // マスター 1 回、サブ 2 回、結果を受け取ったマスター 1 回
  assert.equal((await launches()).length, 4);
});
