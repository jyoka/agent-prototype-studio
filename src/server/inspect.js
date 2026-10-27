import fs from 'node:fs/promises';
import path from 'node:path';

// 作る AI の設定や命令として読まれ得る名前。app/ に置かせない(ADR-0001 の T1、T2)。
const FORBIDDEN_NAMES = new Set([
  '.claude',
  '.mcp.json',
  '.git',
  '.gitmodules',
  '.npmrc',
  'claude.md',
  'claude.local.md',
  'node_modules',
]);

export const LIMITS = {
  maxFiles: 500,
  maxFileBytes: 1024 * 1024,
  maxTotalBytes: 5 * 1024 * 1024,
};

function toAppPath(appDir, file) {
  return `app/${path.relative(appDir, file).split(path.sep).join('/')}`;
}

// ビルドの前に必ず行う決まった検査。問題は利用者に見せる文で返す。
export async function inspectApp(appDir, limits = LIMITS) {
  const problems = [];
  let fileCount = 0;
  let totalBytes = 0;

  const rootStat = await fs.lstat(appDir).catch(() => null);
  if (!rootStat || !rootStat.isDirectory()) {
    return [{ file: 'app/', text: 'app/ フォルダーがありません' }];
  }

  async function walk(dir) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const shown = toAppPath(appDir, full);
      if (FORBIDDEN_NAMES.has(entry.name.toLowerCase())) {
        problems.push({ file: shown, text: 'この名前のファイルやフォルダーは app/ に置けません' });
        continue;
      }
      if (entry.isSymbolicLink()) {
        problems.push({ file: shown, text: 'シンボリックリンクは使えません' });
        continue;
      }
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      if (!entry.isFile()) {
        problems.push({ file: shown, text: '普通のファイルではないので使えません' });
        continue;
      }
      const { size } = await fs.lstat(full);
      fileCount += 1;
      totalBytes += size;
      if (size > limits.maxFileBytes) {
        problems.push({ file: shown, text: `ファイルが大きすぎます(上限 ${limits.maxFileBytes} バイト)` });
      }
    }
  }

  await walk(appDir);
  if (fileCount > limits.maxFiles) {
    problems.push({ file: 'app/', text: `ファイルが多すぎます(${fileCount} 個。上限 ${limits.maxFiles} 個)` });
  }
  if (totalBytes > limits.maxTotalBytes) {
    problems.push({ file: 'app/', text: `ファイルの合計が大きすぎます(上限 ${limits.maxTotalBytes} バイト)` });
  }
  return problems;
}
