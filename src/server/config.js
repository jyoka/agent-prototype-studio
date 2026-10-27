import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

// 設定は環境変数だけから読む。データの置き場は ADR-0001 の既定(~/PrototypeStudio)。
export function loadConfig(env = process.env) {
  const studioPort = parsePort(env.STUDIO_PORT, DEFAULT_STUDIO_PORT, 'STUDIO_PORT');
  const previewPort = parsePort(env.STUDIO_PREVIEW_PORT, DEFAULT_PREVIEW_PORT, 'STUDIO_PREVIEW_PORT');
  if (studioPort !== 0 && studioPort === previewPort) {
    throw new ConfigError('STUDIO_PORT と STUDIO_PREVIEW_PORT には別の番号を指定してください');
  }
  return {
    home: path.resolve(env.STUDIO_HOME || path.join(os.homedir(), 'PrototypeStudio')),
    studioPort,
    previewPort,
    openBrowser: env.STUDIO_NO_OPEN !== '1',
    // 実モデル(Claude Code)は、社内の利用条件を確かめた人が明示して許すまで選べない
    allowClaudeCode: env.STUDIO_ALLOW_CLAUDE_CODE === '1',
  };
}
