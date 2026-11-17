import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Hints, SEEN_LIMIT } from '../../src/server/hints.js';

// 「その場で」の 1 行を覚えた回数(src/server/hints.js、docs/design/ui-ux-v2.md の 5.1)

async function tempHome() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'prototype-studio-hints-'));
}

test('操作の種類ごとに数え、上限(2 回)より上は数えない。Studio のデータの置き場の hints.json に残る', async () => {
  const home = await tempHome();
  try {
    const hints = new Hints({ home });
    await hints.load();
    assert.deepEqual(hints.state(), { limit: SEEN_LIMIT, counts: {} });
    await hints.seen('organize-point');
    await hints.seen('organize-point');
    await hints.seen('organize-point');
    await hints.seen('make-request');
    assert.deepEqual(hints.state().counts, { 'organize-point': 2, 'make-request': 1 });
    const saved = JSON.parse(await fs.readFile(path.join(home, 'hints.json'), 'utf8'));
    assert.deepEqual(saved, { counts: { 'organize-point': 2, 'make-request': 1 } });

    // 起動し直しても覚えている
    const again = new Hints({ home });
    await again.load();
    assert.deepEqual(again.state().counts, { 'organize-point': 2, 'make-request': 1 });

    // 「案内をもう一度出す」で全部を 0 に戻す
    await again.reset();
    assert.deepEqual(again.state().counts, {});
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(home, 'hints.json'), 'utf8')), { counts: {} });
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});

test('種類の名前は決まった形だけ。壊れたファイルや変な値は読まず、どの 1 行も出す方に倒す', async () => {
  const home = await tempHome();
  try {
    const hints = new Hints({ home });
    for (const kind of ['', 'Organize', '../x', 'a'.repeat(41), 3, null]) {
      assert.equal(Hints.validKind(kind), false);
      await assert.rejects(hints.seen(kind), TypeError);
    }
    await fs.writeFile(path.join(home, 'hints.json'), '{ 壊れた');
    await hints.load();
    assert.deepEqual(hints.state().counts, {});
    await fs.writeFile(path.join(home, 'hints.json'), JSON.stringify({ counts: { ok: 5, 'Bad Kind': 1, neg: -1, frac: 1.5 } }));
    await hints.load();
    assert.deepEqual(hints.state().counts, { ok: SEEN_LIMIT });
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});

test('置き場がないとき(home が null)は、メモリーにだけ持つ', async () => {
  const hints = new Hints();
  await hints.load();
  await hints.seen('make-request');
  assert.deepEqual(hints.state().counts, { 'make-request': 1 });
});

test('同時に数えても、ファイルは壊れず、最後の回数が残る。constructor のような名前も、ふつうの種類として数える', async () => {
  const home = await tempHome();
  try {
    const hints = new Hints({ home });
    await hints.load();
    await Promise.all([hints.seen('make-request'), hints.seen('organize-point'), hints.seen('constructor'), hints.seen('make-request')]);
    assert.deepEqual(hints.state().counts, { 'make-request': 2, 'organize-point': 1, constructor: 1 });
    const again = new Hints({ home });
    await again.load();
    assert.deepEqual(again.state().counts, { 'make-request': 2, 'organize-point': 1, constructor: 1 });
    assert.deepEqual((await fs.readdir(home)).sort(), ['hints.json']);
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});

test('置き場の hints.json が読めない(フォルダーになっている)ときも、起動を止めず、どの 1 行も出す', async () => {
  const home = await tempHome();
  try {
    await fs.mkdir(path.join(home, 'hints.json'));
    const hints = new Hints({ home });
    await hints.load();
    assert.deepEqual(hints.state().counts, {});
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});
