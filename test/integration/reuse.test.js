import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildApp } from '../../src/server/build.js';
import { STUDIO_ROOT } from '../../src/server/config.js';
import { createMockConnection } from '../../src/server/product-ai/mock.js';
import { createMockAgent } from '../../src/server/sim/agent-mock.js';
import { runEvals } from '../../src/server/sim/eval-run.js';

// 流用できること(docs/design/agent-simulation.md の 1.1 の R1、R3 と 5.3 の S24。sim-8)。
// samples/*/app/ のどの構成も、同じ Studio のコードで、検査(ビルドの G3)と場面の回し(モック)を通る。
// 見本ごとの分岐は書かない。見本を足しても、構成を足しても、このテストは変えずに回る。実モデルは呼ばない
const SAMPLES_DIR = path.join(STUDIO_ROOT, 'samples');
const VERDICTS_OK = new Set(['passed', 'unjudged', 'n/a']);

async function sampleNames() {
  const names = [];
  for (const entry of await fs.readdir(SAMPLES_DIR, { withFileTypes: true })) {
    if (entry.isDirectory() && (await fs.stat(path.join(SAMPLES_DIR, entry.name, 'app')).catch(() => null))?.isDirectory()) names.push(entry.name);
  }
  return names.sort();
}

async function build(t, name) {
  const buildsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-reuse-'));
  t.after(() => fs.rm(buildsDir, { recursive: true, force: true }));
  return buildApp({ appDir: path.join(SAMPLES_DIR, name, 'app'), buildsDir });
}

// 既定の構成と compositions/ の全部、それぞれの構成の前提の全部を、モックで 1 回ずつ回す
async function runAll(built) {
  const { simulation } = built;
  const files = [null, ...simulation.compositions.map((c) => c.file)];
  const ids = [...new Set((simulation.assumptions ?? []).map((item) => item.assumption.id))];
  const mock = { kind: 'mock', real: false, agent: createMockAgent(), harness: createMockConnection() };
  const aiOf = (file) => simulation.harnessAis?.[file] ?? (file === built.manifest.ai ? built.ai : null);
  const { result } = await runEvals({
    simulation,
    aiOf,
    dataNumbers: built.dataNumbers ?? [],
    appDigest: built.appDigest,
    plan: { compositions: files, ...(ids.length > 0 ? { assumptions: ids } : {}), connections: ['mock'] },
    connectionFor: () => mock,
  });
  return result;
}

const names = await sampleNames();

test('見本は 1 つ以上あり、構成 C(agent、harness、human が 1 つの会話に混ざる構成)をデータだけで持つ見本がある(R1)', async (t) => {
  assert.ok(names.length > 0);
  const kinds = [];
  for (const name of names) {
    const built = await build(t, name);
    assert.ok(built.ok, `${name}: ${JSON.stringify(built.errors)}`);
    const all = built.simulation?.composition ? [built.simulation.composition, ...built.simulation.compositions.map((c) => c.composition)] : [];
    for (const composition of all) kinds.push(new Set(composition.participants.map((p) => p.kind)));
  }
  assert.ok(kinds.some((set) => set.has('agent') && set.has('harness') && set.has('human')), '構成 C の形の構成がありません');
});

for (const name of names) {
  test(`${name}: どの構成も、同じコードで検査と場面の回し(モック)を通る(R1、R3、S24)`, async (t) => {
    const built = await build(t, name);
    // 検査(関門 G3。構成、ツール、前提、モック、場面の形)を通ってビルドできる
    assert.ok(built.ok, JSON.stringify(built.errors));
    if (!built.simulation?.composition) {
      // AI のない見本。回す構成がないことだけを確かめる(場面も置けない)
      assert.equal(built.simulation?.evals?.length ?? 0, 0);
      return;
    }
    const result = await runAll(built);
    assert.equal(result.status, 'done', result.stopReason ?? '');
    const groups = result.groups.map((g) => `${g.composition.file ?? 'default'} / ${g.assumption?.id ?? '-'}`);
    // 構成ごと、前提ごとに 1 組
    const expected = [built.simulation.composition, ...built.simulation.compositions.map((c) => c.composition)]
      .map((c) => {
        const agent = c.participants.some((p) => p.kind === 'agent');
        if (!agent) return 1;
        return built.simulation.assumptions.filter((item) => item.file.startsWith(`${c.assumptions.dir}/`)).length;
      })
      .reduce((a, b) => a + b, 0);
    assert.equal(result.groups.length, expected, groups.join('、'));

    for (const group of result.groups) {
      for (const scene of group.evals) {
        const failed = scene.checks.filter((c) => c.verdict === 'failed').map((c) => `${c.check}: ${c.actual ?? ''}`);
        assert.ok(VERDICTS_OK.has(scene.verdict), `${groups[result.groups.indexOf(group)]} の場面 ${scene.id} が ${scene.verdict}: ${failed.join(' / ')}`);
      }
    }
    // どの場面も、どれかの構成で当てはまる(n/a だけの場面は、確かめになっていない)
    for (const { scenario } of built.simulation.evals) {
      const verdicts = result.groups.map((g) => g.evals.find((e) => e.id === scenario.id)?.verdict);
      assert.ok(verdicts.some((v) => v !== 'n/a'), `場面 ${scenario.id} は、どの構成でも n/a です`);
    }
  });
}
