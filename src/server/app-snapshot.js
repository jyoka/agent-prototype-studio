import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export const MAX_SNAPSHOT_ENTRIES = 5000;
const MAX_HASH_BYTES = 2 * 1024 * 1024;

// app/ の中身の指紋。作る AI の前と後で比べ、変わったファイルをツール自身が確かめる
// (AI の報告をうのみにしない)。シンボリックリンクはたどらない。
export async function snapshotApp(appDir) {
  const files = new Map();
  async function walk(dir) {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (files.size >= MAX_SNAPSHOT_ENTRIES) return;
      const full = path.join(dir, entry.name);
      const key = path.relative(appDir, full).split(path.sep).join('/');
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        const stat = await fs.lstat(full).catch(() => null);
        if (!stat) continue;
        if (stat.size > MAX_HASH_BYTES) {
          files.set(key, `size:${stat.size}:${stat.mtimeMs}`);
        } else {
          const content = await fs.readFile(full).catch(() => null);
          files.set(key, content ? crypto.createHash('sha256').update(content).digest('hex') : 'unreadable');
        }
      } else {
        files.set(key, entry.isSymbolicLink() ? 'symlink' : 'other');
      }
    }
  }
  await walk(appDir);
  return files;
}

export function diffSnapshots(before, after) {
  const changed = [];
  for (const [key, value] of after) {
    if (!before.has(key)) changed.push({ file: `app/${key}`, change: 'added' });
    else if (before.get(key) !== value) changed.push({ file: `app/${key}`, change: 'modified' });
  }
  for (const key of before.keys()) {
    if (!after.has(key)) changed.push({ file: `app/${key}`, change: 'removed' });
  }
  return changed.sort((a, b) => a.file.localeCompare(b.file));
}
