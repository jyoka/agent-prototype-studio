import assert from 'node:assert/strict';
import test from 'node:test';
import { AGENT_TOOLS, buildClaudeArgs, describeBilling } from '../../src/server/claude-args.js';
import { buildFixPrompt } from '../../src/server/fix-prompt.js';

function valueOf(args, flag) {
  return args[args.indexOf(flag) + 1];
}

test('起動引数には ADR-0001 の守りが必ず入り、権限の確認を外すものは入らない', () => {
  const args = buildClaudeArgs({ billing: describeBilling({}) });
  for (const flag of ['-p', '--restricted', '--safe-mode', '--strict-mcp-config', '--no-session-persistence', '--verbose']) {
    assert.ok(args.includes(flag), flag);
  }
  assert.equal(valueOf(args, '--permission-mode'), 'dontAsk');
  assert.equal(valueOf(args, '--permission-prompts'), 'none');
  assert.equal(valueOf(args, '--output-format'), 'stream-json');
  assert.equal(valueOf(args, '--tools'), AGENT_TOOLS);
  assert.equal(valueOf(args, '--allowedTools'), AGENT_TOOLS);
  assert.doesNotMatch(AGENT_TOOLS, /Bash|PowerShell|WebFetch|WebSearch/);
  for (const banned of ['--dangerously-skip-permissions', 'bypassPermissions', '--add-dir', '--mcp-config', '--resume', '--continue']) {
    assert.ok(!args.includes(banned), banned);
  }
  // サブスクの枠では費用の上限を付けない
  assert.ok(!args.includes('--max-budget-usd'));
});

test('API キーなどで動くときは、費用の上限を付ける', () => {
  const args = buildClaudeArgs({ billing: describeBilling({ ANTHROPIC_API_KEY: 'x' }), maxBudgetUsd: 0.5 });
  assert.equal(valueOf(args, '--max-budget-usd'), '0.5');
  const cloud = buildClaudeArgs({ billing: describeBilling({ CLAUDE_CODE_USE_BEDROCK: '1' }) });
  assert.equal(valueOf(cloud, '--max-budget-usd'), '1');
  const token = buildClaudeArgs({ billing: describeBilling({ CLAUDE_CODE_OAUTH_TOKEN: 'x' }) });
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
  const args = buildClaudeArgs({ billing: describeBilling({}) });
  const prompt = valueOf(args, '--append-system-prompt');
  assert.match(prompt, /目録 prototype\.json を app\/ の直下に置き/);
  for (const key of ['formatVersion', 'entry', 'intent', 'constraints', 'unimplemented', 'data', 'ai', 'scenarios']) {
    assert.ok(prompt.includes(`"${key}"`), key);
  }
});

test('直すラウンドも同じ引数で起動する。直す依頼は引数に入れず、前の会話を引き継ぐ引数も入らない', () => {
  const billing = describeBilling({});
  const first = buildClaudeArgs({ billing });
  const fixPrompt = buildFixPrompt({
    request: '見出しを「架空の図書室」にして',
    gate: { id: 'G4', name: 'compile', label: 'ビルド', status: 'failed', errors: [{ file: 'app/App.jsx', line: 2, column: 1, text: 'x' }] },
    changedFiles: [{ file: 'app/App.jsx', change: 'modified' }],
  });
  // 起動引数は依頼の文を受け取らない。直すラウンドでも同じ値になる(S10)
  assert.equal(buildClaudeArgs.length, 1);
  assert.deepEqual(buildClaudeArgs({ billing }), first);
  assert.equal(valueOf(first, '--tools'), AGENT_TOOLS);
  assert.ok(first.every((arg) => !arg.includes('前の依頼') && !arg.includes(fixPrompt)));
  // 前の会話は持ち込まない(S14)
  for (const flag of ['--resume', '--continue', '--session-id', '--fork-session']) assert.ok(!first.includes(flag), flag);
  assert.ok(first.includes('--no-session-persistence'));
});
