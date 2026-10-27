import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { diffSnapshots, snapshotApp } from '../../src/server/app-snapshot.js';

test('作る AI の前と後で、足された、変わった、消えたファイルを確かめる', async (t) => {
  const appDir = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-snapshot-'));
  t.after(() => fs.rm(appDir, { recursive: true, force: true }));
  await fs.mkdir(path.join(appDir, 'src'));
  await fs.writeFile(path.join(appDir, 'main.jsx'), 'a');
  await fs.writeFile(path.join(appDir, 'src', 'keep.js'), 'k');
  await fs.writeFile(path.join(appDir, 'gone.css'), 'g');
  const before = await snapshotApp(appDir);

  // 大きさが同じでも、中身が変われば気づく
  await fs.writeFile(path.join(appDir, 'main.jsx'), 'b');
  await fs.writeFile(path.join(appDir, 'src', 'new.js'), 'n');
  await fs.rm(path.join(appDir, 'gone.css'));
  const after = await snapshotApp(appDir);

  assert.deepEqual(diffSnapshots(before, after), [
    { file: 'app/gone.css', change: 'removed' },
    { file: 'app/main.jsx', change: 'modified' },
    { file: 'app/src/new.js', change: 'added' },
  ]);
  assert.deepEqual(diffSnapshots(after, await snapshotApp(appDir)), []);
});
