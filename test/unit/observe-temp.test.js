import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { SERVER_TEMP_PREFIX, createServerTemp, isProcessAlive, sweepServerTemps } from '../../src/server/observe-temp.js';

// 観察の道具の MCP サーバーの一時フォルダー(src/server/observe-temp.js)。
// 次の起動で消すのは、名前の決まりに合い、作ったプロセスがもう動いていない、自分のフォルダーだけ
let base;

test.beforeEach(async () => {
  base = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-observe-temp-'));
});

test.afterEach(async () => {
  await fs.rm(base, { recursive: true, force: true });
});

const exists = (name) => fs.access(path.join(base, name)).then(() => true, () => false);

test('一時フォルダーの名前は、決まりの頭とこのプロセスの番号で始まる', async () => {
  const dir = createServerTemp(base);
  assert.equal(path.dirname(dir), base);
  assert.match(path.basename(dir), new RegExp(`^${SERVER_TEMP_PREFIX}${process.pid}-[A-Za-z0-9]{6}$`));
  assert.ok((await fs.stat(dir)).isDirectory());
});

test('作ったプロセスが終わった自分の一時フォルダーは中身ごと消し、自分のものでないものは消さない', async () => {
  const dead = 999_999;
  const stale = `${SERVER_TEMP_PREFIX}${dead}-AbC123`;
  await fs.mkdir(path.join(base, stale, 'prototype-studio-observe-xYz789'), { recursive: true });
  await fs.mkdir(path.join(base, stale, 'playwright_chromiumdev_profile-q1w2e3'));
  await fs.writeFile(path.join(base, stale, 'playwright_chromiumdev_profile-q1w2e3', 'Cookies'), 'fictional');

  // 消さないもの
  const target = path.join(base, 'linked-target');
  await fs.mkdir(target);
  await fs.writeFile(path.join(target, 'keep.txt'), 'fictional');
  const kept = [
    // 動いているサーバーのもの(このテストのプロセス)
    `${SERVER_TEMP_PREFIX}${process.pid}-AbC123`,
    // CLI(bin/observe.js)の作業中のビルド
    'prototype-studio-observe-AbC123',
    // ほかのプログラムのもの
    'playwright_chromiumdev_profile-AbC123',
    'some-other-tool-AbC123',
    // 名前の決まりに合わないもの
    `${SERVER_TEMP_PREFIX}abc-AbC123`,
    `${SERVER_TEMP_PREFIX}${dead}-AbC1234`,
    `${SERVER_TEMP_PREFIX}0-AbC123`,
    `x-${SERVER_TEMP_PREFIX}${dead}-AbC123`,
  ];
  for (const name of kept) await fs.mkdir(path.join(base, name));
  // 名前は合うがフォルダーでないもの、シンボリックリンク(先のフォルダーをたどって消さない)
  const file = `${SERVER_TEMP_PREFIX}${dead}-File12`;
  const link = `${SERVER_TEMP_PREFIX}${dead}-Link12`;
  await fs.writeFile(path.join(base, file), 'fictional');
  await fs.symlink(target, path.join(base, link), 'dir');

  const asked = [];
  const removed = sweepServerTemps(base, {
    isAlive: (pid) => {
      asked.push(pid);
      return pid !== dead;
    },
  });
  assert.deepEqual(removed, [path.join(base, stale)]);
  assert.equal(await exists(stale), false);
  for (const name of [...kept, file, link, 'linked-target']) assert.equal(await exists(name), true, name);
  assert.equal(await fs.readFile(path.join(target, 'keep.txt'), 'utf8'), 'fictional');
  // 動いているかは、名前の決まりに合うものだけ尋ねる。このプロセスの番号は尋ねずに残す
  assert.ok(asked.every((pid) => pid === dead), JSON.stringify(asked));
});

test('既定では、終わったプロセスのものだけを消し、動いているプロセスのものは残す', async () => {
  const ended = spawnSync(process.execPath, ['-e', '']).pid;
  assert.equal(isProcessAlive(ended), false);
  assert.equal(isProcessAlive(process.pid), true);
  const stale = `${SERVER_TEMP_PREFIX}${ended}-AbC123`;
  const live = `${SERVER_TEMP_PREFIX}${process.ppid}-AbC123`;
  await fs.mkdir(path.join(base, stale));
  await fs.mkdir(path.join(base, live));
  sweepServerTemps(base);
  assert.equal(await exists(stale), false);
  assert.equal(await exists(live), true);
});

test('一時フォルダーの置き場が読めなくても、起動は止めない', () => {
  assert.deepEqual(sweepServerTemps(path.join(base, 'missing')), []);
});
