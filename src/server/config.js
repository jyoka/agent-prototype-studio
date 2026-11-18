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

// 中継のサーバー(STUDIO_RELAY_URL。共有の場、collaboration.md の 9.4)。書かなければ共有しない。
// HTTPS だけを受ける。手元の試し(127.0.0.1、localhost)だけ http を受ける
export function parseRelayUrl(value) {
  if (value === undefined || value === null || value === '') return null;
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigError(`STUDIO_RELAY_URL が URL として読めません(今の値: ${value})`);
  }
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new ConfigError('STUDIO_RELAY_URL は https:// で始めてください(手元の試しだけ http://127.0.0.1 を使えます)');
  }
  // 参加者のページは /s/ と /api/ を中継のサーバーの根から読むので、道(パス)は付けない
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new ConfigError('STUDIO_RELAY_URL は、https://<名前>(:<番号>) の形にしてください。利用者名、道(パス)、問い、# は入れません');
  return url.origin;
}

// 本物の AI(試作品の中の AI の Claude Code)を選べるか。既定は選べる(使う前に画面で同意する。real-ai.js)。
// 0 で選べなくする(会社として止めたいとき)。1 は前の決まりの名残りで、書いても既定と同じ
function parseAllowClaudeCode(value) {
  if (value === undefined || value === '' || value === '1') return true;
  if (value === '0') return false;
  throw new ConfigError(`STUDIO_ALLOW_CLAUDE_CODE は 0(本物の AI を選べなくする)か、書かないでください(今の値: ${value})`);
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
    // はじめの画面(目的の聞き出し)。STUDIO_START_SCREEN=0 で、起動のときに出さない。上の帯の「新しく作る」からは開ける
    startScreen: env.STUDIO_START_SCREEN !== '0',
    // 試作品の中の AI の本物の AI(Claude Code)。STUDIO_ALLOW_CLAUDE_CODE=0 のときだけ選べない
    allowClaudeCode: parseAllowClaudeCode(env.STUDIO_ALLOW_CLAUDE_CODE),
    // 作る AI。既定は auto。偽接続は STUDIO_AGENT=fake と書いたときだけ
    agent,
    claudeBin: env.STUDIO_CLAUDE_BIN || null,
    // API キーなど、サブスクの枠でないときに 1 回の依頼に付ける費用の上限
    maxBudgetUsd: parseBudget(env.STUDIO_MAX_BUDGET_USD),
    // 共有の場の中継のサーバー。null なら共有しない(Studio は外へつながない)
    relayUrl: parseRelayUrl(env.STUDIO_RELAY_URL),
  };
}
