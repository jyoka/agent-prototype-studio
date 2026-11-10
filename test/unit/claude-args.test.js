import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import {
  AGENT_TOOLS,
  ALLOWED_TOOLS,
  buildClaudeArgs,
  describeBilling,
  MCP_CONFIG_FILE,
  OBSERVE_SERVER,
  OBSERVE_TOOLS,
  observeMcpConfig,
  REVIEW_RULE,
} from '../../src/server/claude-args.js';
import { STUDIO_ROOT } from '../../src/server/config.js';
import { buildFixPrompt } from '../../src/server/fix-prompt.js';
import { TOOL_NAMES } from '../../src/server/observe-mcp.js';

// 作る run のフォルダー(app/ の外)の MCP の設定。中身は読まないので、パスだけでよい
const MCP_CONFIG = path.join('/fictional', 'projects', 'p', '.studio', 'runs', 'r1', MCP_CONFIG_FILE);

function valueOf(args, flag) {
  return args[args.indexOf(flag) + 1];
}

test('起動引数には ADR-0001 の守りが必ず入り、権限の確認を外すものは入らない', () => {
  const args = buildClaudeArgs({ billing: describeBilling({}), mcpConfig: MCP_CONFIG });
  for (const flag of ['-p', '--restricted', '--strict-mcp-config', '--no-session-persistence', '--verbose']) {
    assert.ok(args.includes(flag), flag);
  }
  assert.equal(valueOf(args, '--permission-mode'), 'dontAsk');
  assert.equal(valueOf(args, '--permission-prompts'), 'none');
  assert.equal(valueOf(args, '--output-format'), 'stream-json');
  assert.equal(valueOf(args, '--tools'), AGENT_TOOLS);
  assert.doesNotMatch(AGENT_TOOLS, /Bash|PowerShell|WebFetch|WebSearch/);
  for (const banned of ['--dangerously-skip-permissions', 'bypassPermissions', '--add-dir', '--resume', '--continue', '--settings', '--plugin-dir', '--agents']) {
    assert.ok(!args.includes(banned), banned);
  }
  // サブスクの枠では費用の上限を付けない
  assert.ok(!args.includes('--max-budget-usd'));
});

test('--safe-mode の代わりの引数がそろう。--safe-mode は --mcp-config のサーバーを外すので入れない(ADR-0002)', () => {
  const args = buildClaudeArgs({ billing: describeBilling({}), mcpConfig: MCP_CONFIG });
  assert.ok(!args.includes('--safe-mode'));
  // 利用者、プロジェクト、手元の設定のファイル(hooks、plugins、CLAUDE.md)を読まない
  assert.ok(args.includes('--restricted'));
  // 設定の読み込み元を 1 つも使わない。空の文字の値が 1 つの引数として渡る
  assert.equal(valueOf(args, '--setting-sources'), '');
  // skills と commands を外す
  assert.ok(args.includes('--disable-slash-commands'));
  // MCP は渡したファイルのサーバーだけ
  assert.ok(args.includes('--strict-mcp-config'));
  assert.equal(args.filter((arg) => arg === '--mcp-config').length, 1);
  assert.equal(valueOf(args, '--mcp-config'), MCP_CONFIG);
});

test('許可する道具は Read、Edit、Write、Glob、Grep と、観察の道具の決まった名前だけ(S10)', () => {
  const args = buildClaudeArgs({ billing: describeBilling({}), mcpConfig: MCP_CONFIG });
  const allowed = valueOf(args, '--allowedTools').split(',');
  assert.deepEqual(allowed, [
    'Read',
    'Edit',
    'Write',
    'Glob',
    'Grep',
    'mcp__observe__open',
    'mcp__observe__read_page',
    'mcp__observe__inspect',
    'mcp__observe__click',
    'mcp__observe__type',
    'mcp__observe__scroll',
    'mcp__observe__set_viewport',
    'mcp__observe__screenshot',
    'mcp__observe__run_scenarios',
  ]);
  assert.equal(valueOf(args, '--allowedTools'), ALLOWED_TOOLS);
  // ワイルドカードやサーバーの名前だけの許可(サーバーの道具をすべて許す)を使わない
  assert.ok(allowed.every((name) => !/[*?]/.test(name) && name !== `mcp__${OBSERVE_SERVER}`));
  // 観察の道具の名前は、MCP サーバー(jyoka/tasks#311)が出す名前とそろう
  assert.deepEqual(OBSERVE_TOOLS, TOOL_NAMES.map((name) => `mcp__${OBSERVE_SERVER}__${name}`));
  // 組み込みの道具は読み書きと検索だけのまま
  assert.equal(valueOf(args, '--tools'), AGENT_TOOLS);
});

test('MCP の設定のファイルなしでは起動引数を作らない', () => {
  assert.throws(() => buildClaudeArgs({ billing: describeBilling({}) }), /mcpConfig/);
  assert.throws(() => buildClaudeArgs({ billing: describeBilling({}), mcpConfig: '' }), /mcpConfig/);
});

test('MCP の設定は観察の道具のサーバー 1 つだけで、プロジェクトの場所は起動の引数でだけ渡す', () => {
  const projectDir = path.join('/fictional', 'projects', 'p');
  const config = observeMcpConfig({ projectDir, maxSeconds: 600 });
  assert.deepEqual(Object.keys(config.mcpServers), [OBSERVE_SERVER]);
  const server = config.mcpServers[OBSERVE_SERVER];
  assert.equal(server.type, 'stdio');
  assert.equal(server.command, process.execPath);
  assert.deepEqual(server.args, [path.join(STUDIO_ROOT, 'bin', 'observe-mcp.js'), projectDir, '--max-seconds', '600']);
  // 環境変数は足さない(利用者のものをそのまま渡す)
  assert.equal(server.env, undefined);
});

test('API キーなどで動くときは、費用の上限を付ける', () => {
  const args = buildClaudeArgs({ billing: describeBilling({ ANTHROPIC_API_KEY: 'x' }), mcpConfig: MCP_CONFIG, maxBudgetUsd: 0.5 });
  assert.equal(valueOf(args, '--max-budget-usd'), '0.5');
  const cloud = buildClaudeArgs({ billing: describeBilling({ CLAUDE_CODE_USE_BEDROCK: '1' }), mcpConfig: MCP_CONFIG });
  assert.equal(valueOf(cloud, '--max-budget-usd'), '1');
  const token = buildClaudeArgs({ billing: describeBilling({ CLAUDE_CODE_OAUTH_TOKEN: 'x' }), mcpConfig: MCP_CONFIG });
  assert.ok(!token.includes('--max-budget-usd'));
});

test('認証の見込みは Claude Code の優先順位に合わせ、値を出さない', () => {
  const secret = 'sk-ant-fictional-should-not-appear';
  assert.equal(describeBilling({}).mode, 'login');
  assert.equal(describeBilling({ ANTHROPIC_API_KEY: '' }).mode, 'login');
  assert.equal(describeBilling({ CLAUDE_CODE_OAUTH_TOKEN: secret }).mode, 'oauth-token');
  assert.equal(describeBilling({ ANTHROPIC_API_KEY: secret, CLAUDE_CODE_OAUTH_TOKEN: secret }).mode, 'api-key');
  assert.equal(describeBilling({ ANTHROPIC_API_KEY: secret, ANTHROPIC_AUTH_TOKEN: secret }).mode, 'auth-token');
  assert.equal(describeBilling({ ANTHROPIC_API_KEY: secret, CLAUDE_CODE_USE_VERTEX: '1' }).mode, 'cloud');
  for (const env of [{ ANTHROPIC_API_KEY: secret }, { ANTHROPIC_AUTH_TOKEN: secret }, { CLAUDE_CODE_OAUTH_TOKEN: secret }]) {
    assert.ok(!JSON.stringify(describeBilling(env)).includes(secret));
  }
});

test('作る AI への決まりに、目録の置き場所と形が入る', () => {
  const args = buildClaudeArgs({ billing: describeBilling({}), mcpConfig: MCP_CONFIG });
  const prompt = valueOf(args, '--append-system-prompt');
  assert.match(prompt, /目録 prototype\.json を app\/ の直下に置き/);
  for (const key of ['formatVersion', 'entry', 'intent', 'constraints', 'unimplemented', 'data', 'ai', 'scenarios']) {
    assert.ok(prompt.includes(`"${key}"`), key);
  }
});

test('作る AI への決まりに、観察の道具の使い方が入る', () => {
  const prompt = valueOf(buildClaudeArgs({ billing: describeBilling({}), mcpConfig: MCP_CONFIG }), '--append-system-prompt');
  assert.match(prompt, /mcp__observe__/);
  assert.match(prompt, /直した後は open で開き/);
  assert.match(prompt, /run_scenarios/);
  assert.match(prompt, /app\/ を書き換えません/);
});

test('直すラウンドも同じ引数で起動する。直す依頼は引数に入れず、前の会話を引き継ぐ引数も入らない', () => {
  const billing = describeBilling({});
  const first = buildClaudeArgs({ billing, mcpConfig: MCP_CONFIG });
  const fixPrompt = buildFixPrompt({
    request: '見出しを「架空の図書室」にして',
    gate: { id: 'G4', name: 'compile', label: 'ビルド', status: 'failed', errors: [{ file: 'app/App.jsx', line: 2, column: 1, text: 'x' }] },
    changedFiles: [{ file: 'app/App.jsx', change: 'modified' }],
  });
  // 起動引数は依頼の文を受け取らない。直すラウンドでも同じ値になる(S10)
  assert.equal(buildClaudeArgs.length, 1);
  assert.deepEqual(buildClaudeArgs({ billing, mcpConfig: MCP_CONFIG }), first);
  assert.equal(valueOf(first, '--tools'), AGENT_TOOLS);
  // 観察の道具も、直すラウンドで増やさない(S10)
  assert.equal(valueOf(first, '--allowedTools'), ALLOWED_TOOLS);
  assert.equal(valueOf(first, '--mcp-config'), MCP_CONFIG);
  assert.ok(first.every((arg) => !arg.includes('前の依頼') && !arg.includes(fixPrompt)));
  // 前の会話は持ち込まない(S14)
  for (const flag of ['--resume', '--continue', '--session-id', '--fork-session']) assert.ok(!first.includes(flag), flag);
  assert.ok(first.includes('--no-session-persistence'));
});

test('AI 構成の審査で承認した試作品だけ、承認した構成を変えない決まりを足す。審査のない試作品の決まりは変えない', () => {
  const plain = valueOf(buildClaudeArgs({ billing: describeBilling({}), mcpConfig: MCP_CONFIG }), '--append-system-prompt');
  const reviewed = valueOf(buildClaudeArgs({ billing: describeBilling({}), mcpConfig: MCP_CONFIG, reviewed: true }), '--append-system-prompt');
  assert.ok(!plain.includes(REVIEW_RULE));
  assert.ok(!plain.includes('AI 構成の審査'));
  assert.equal(reviewed, `${plain}\n${REVIEW_RULE}`);
  assert.match(REVIEW_RULE, /変えないでください。変えたいときは、変えずに言葉で知らせてください/);
});
