import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ConfigError, loadConfig } from '../../src/server/config.js';

test('既定はホームの PrototypeStudio と 4317、4318 番', () => {
  const config = loadConfig({});
  assert.equal(config.home, path.join(os.homedir(), 'PrototypeStudio'));
  assert.equal(config.studioPort, 4317);
  assert.equal(config.previewPort, 4318);
  assert.equal(config.openBrowser, true);
  assert.equal(config.allowClaudeCode, false);
});

test('実モデル(Claude Code)は STUDIO_ALLOW_CLAUDE_CODE=1 のときだけ許す', () => {
  assert.equal(loadConfig({ STUDIO_ALLOW_CLAUDE_CODE: '1' }).allowClaudeCode, true);
  for (const value of ['', '0', 'true', 'yes']) assert.equal(loadConfig({ STUDIO_ALLOW_CLAUDE_CODE: value }).allowClaudeCode, false, value);
});

test('環境変数で置き場とポートを変えられる', () => {
  const config = loadConfig({ STUDIO_HOME: 'tmp/studio', STUDIO_PORT: '5000', STUDIO_PREVIEW_PORT: '0', STUDIO_NO_OPEN: '1' });
  assert.equal(config.home, path.resolve('tmp/studio'));
  assert.equal(config.studioPort, 5000);
  assert.equal(config.previewPort, 0);
  assert.equal(config.openBrowser, false);
});

test('ポートの値が正しくなければ、わかる文で止める', () => {
  assert.throws(() => loadConfig({ STUDIO_PORT: 'abc' }), ConfigError);
  assert.throws(() => loadConfig({ STUDIO_PORT: '70000' }), ConfigError);
  assert.throws(() => loadConfig({ STUDIO_PORT: '5000', STUDIO_PREVIEW_PORT: '5000' }), /別の番号/);
});

test('作る AI の既定は自動。偽接続は STUDIO_AGENT=fake、Claude Code の固定は STUDIO_AGENT=claude で明示したときだけ', () => {
  const config = loadConfig({});
  assert.equal(config.agent, 'auto');
  assert.equal(loadConfig({ STUDIO_AGENT: '' }).agent, 'auto');
  assert.equal(loadConfig({ STUDIO_AGENT: 'fake' }).agent, 'fake');
  assert.equal(loadConfig({ STUDIO_AGENT: 'auto' }).agent, 'auto');
  assert.equal(config.claudeBin, null);
  assert.equal(config.maxBudgetUsd, 1);
  const claude = loadConfig({ STUDIO_AGENT: 'claude', STUDIO_CLAUDE_BIN: '/opt/claude', STUDIO_MAX_BUDGET_USD: '0.5' });
  assert.equal(claude.agent, 'claude');
  assert.equal(claude.claudeBin, '/opt/claude');
  assert.equal(claude.maxBudgetUsd, 0.5);
  assert.throws(() => loadConfig({ STUDIO_AGENT: 'gpt' }), /STUDIO_AGENT/);
  assert.throws(() => loadConfig({ STUDIO_MAX_BUDGET_USD: '-1' }), ConfigError);
});
