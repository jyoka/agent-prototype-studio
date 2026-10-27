import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { FAKE_CLI, findOnPath, isAtLeast, parseVersion, resolveConnection } from '../../src/server/agent-connection.js';

const posixOnly = { skip: process.platform === 'win32' ? '偽の claude をシェルスクリプトで作るため' : false };

async function fakeClaude(t, version) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-connection-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'claude');
  await fs.writeFile(bin, `#!/bin/sh\necho "${version} (Claude Code)"\n`, { mode: 0o755 });
  return { dir, bin };
}

test('版を読み、下限と比べる', () => {
  assert.deepEqual(parseVersion('2.1.311 (Claude Code)'), [2, 1, 311]);
  assert.equal(parseVersion('unknown'), null);
  assert.equal(isAtLeast([2, 1, 248], [2, 1, 248]), true);
  assert.equal(isAtLeast([2, 1, 247], [2, 1, 248]), false);
  assert.equal(isAtLeast([2, 2, 0], [2, 1, 248]), true);
  assert.equal(isAtLeast([3, 0, 0], [2, 1, 248]), true);
});

test('既定は偽接続で、Claude Code を探さない', async () => {
  const connection = await resolveConnection({}, { PATH: '' });
  assert.equal(connection.kind, 'fake');
  assert.equal(connection.command, process.execPath);
  assert.deepEqual(connection.prefixArgs, [FAKE_CLI]);
  assert.equal(connection.problem, null);
  assert.ok(connection.examples.length > 0);
});

test('claude を PATH から探す。実行できないファイルは飛ばす', posixOnly, async (t) => {
  const { dir, bin } = await fakeClaude(t, '2.1.311');
  const other = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-connection-'));
  t.after(() => fs.rm(other, { recursive: true, force: true }));
  await fs.writeFile(path.join(other, 'claude'), '', { mode: 0o644 });
  assert.equal(await findOnPath('claude', { PATH: [other, dir].join(path.delimiter) }), bin);
  assert.equal(await findOnPath('claude', { PATH: other }), null);

  const connection = await resolveConnection({ agent: 'claude' }, { PATH: [other, dir].join(path.delimiter) });
  assert.equal(connection.kind, 'claude');
  assert.equal(connection.command, bin);
  assert.equal(connection.version, '2.1.311');
  assert.equal(connection.problem, null);
});

test('古い Claude Code や、見つからないときは理由を返す', posixOnly, async (t) => {
  const { bin } = await fakeClaude(t, '2.1.100');
  const old = await resolveConnection({ agent: 'claude', claudeBin: bin }, {});
  assert.match(old.problem, /2\.1\.100 は古すぎます/);
  const missing = await resolveConnection({ agent: 'claude' }, { PATH: '' });
  assert.match(missing.problem, /claude が見つかりません/);
});
