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
  // 本物の AI は既定で選べる(使う前に画面で同意する)
  assert.equal(config.allowClaudeCode, true);
});

test('本物の AI(Claude Code)は STUDIO_ALLOW_CLAUDE_CODE=0 のときだけ選べない。ほかの値は誤りにする', () => {
  assert.equal(loadConfig({ STUDIO_ALLOW_CLAUDE_CODE: '0' }).allowClaudeCode, false);
  // 1 は前の決まりの名残り。書いても既定と同じ
  for (const value of [undefined, '', '1']) assert.equal(loadConfig({ STUDIO_ALLOW_CLAUDE_CODE: value }).allowClaudeCode, true, String(value));
  // 止めるつもりで書いた値を、黙って「選べる」にしない
  for (const value of ['false', 'no', 'true', 'yes']) {
    assert.throws(() => loadConfig({ STUDIO_ALLOW_CLAUDE_CODE: value }), (error) => error instanceof ConfigError && /STUDIO_ALLOW_CLAUDE_CODE は 0/.test(error.message), value);
  }
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
