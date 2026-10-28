import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_MAX_BUDGET_USD } from './claude-args.js';

export const STUDIO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export const DEFAULT_STUDIO_PORT = 4317;
export const DEFAULT_PREVIEW_PORT = 4318;

export class ConfigError extends Error {}

function parsePort(value, fallback, name) {
  if (value === undefined || value === '') return fallback;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new ConfigError(`${name} は 0 から 65535 の整数で指定してください(今の値: ${value})`);
  }
  return port;
}

// 作る AI の接続(STUDIO_AGENT)。auto は Claude Code が使えれば Claude Code、使えなければ使えない状態(agent-connection.js)
export const AGENT_MODES = ['auto', 'claude', 'fake'];

function parseBudget(value) {
  if (value === undefined || value === '') return DEFAULT_MAX_BUDGET_USD;
  const budget = Number(value);
  if (!Number.isFinite(budget) || budget <= 0 || budget > 100) {
    throw new ConfigError(`STUDIO_MAX_BUDGET_USD は 0 より大きく 100 以下の数で指定してください(今の値: ${value})`);
  }
  return budget;
}

// データの置き場。ADR-0001 の既定は ~/PrototypeStudio
export function studioHome(env = process.env) {
  return path.resolve(env.STUDIO_HOME || path.join(os.homedir(), 'PrototypeStudio'));
}

// 設定は環境変数だけから読む。
export function loadConfig(env = process.env) {
  const studioPort = parsePort(env.STUDIO_PORT, DEFAULT_STUDIO_PORT, 'STUDIO_PORT');
  const previewPort = parsePort(env.STUDIO_PREVIEW_PORT, DEFAULT_PREVIEW_PORT, 'STUDIO_PREVIEW_PORT');
  if (studioPort !== 0 && studioPort === previewPort) {
    throw new ConfigError('STUDIO_PORT と STUDIO_PREVIEW_PORT には別の番号を指定してください');
  }
  const agent = env.STUDIO_AGENT || 'auto';
  if (!AGENT_MODES.includes(agent)) {
    throw new ConfigError(`STUDIO_AGENT は ${AGENT_MODES.join('、')} のどれかで指定してください(今の値: ${agent})`);
  }
  return {
    home: studioHome(env),
    studioPort,
    previewPort,
    openBrowser: env.STUDIO_NO_OPEN !== '1',
    // プロダクト内 AI の実モデル(Claude Code)は、社内の利用条件を確かめた人が明示して許すまで選べない
    allowClaudeCode: env.STUDIO_ALLOW_CLAUDE_CODE === '1',
    // 作る AI。既定は auto。偽接続は STUDIO_AGENT=fake と書いたときだけ
    agent,
    claudeBin: env.STUDIO_CLAUDE_BIN || null,
    // API キーなど、サブスクの枠でないときに 1 回の依頼に付ける費用の上限
    maxBudgetUsd: parseBudget(env.STUDIO_MAX_BUDGET_USD),
  };
}
