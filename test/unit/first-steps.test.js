import assert from 'node:assert/strict';
import test from 'node:test';
import { FirstSteps } from '../../src/server/first-steps.js';

// 最初の一歩の案内の進み方(src/server/first-steps.js、docs/design/ux-redesign.md の 2 節)

function stepsWith(statuses = {}) {
  return new FirstSteps({ statusesOf: (id) => statuses[id] ?? [] });
}

test('最初は、どの手順も済んでいない。案内は閉じていない', () => {
  const steps = stepsWith();
  assert.deepEqual(steps.view('a'), { tried: false, fixed: false, triedFixed: false, lastRun: null });
  assert.deepEqual(steps.state(), { dismissed: false });
});

test('試すと 1 番が済む。直す前に試しても、3 番は済まない', () => {
  const steps = stepsWith();
  steps.tried('a');
  assert.deepEqual(steps.view('a'), { tried: true, fixed: false, triedFixed: false, lastRun: null });
  // 試作品ごとに分かれる
  assert.equal(steps.view('b').tried, false);
});

test('2 番は passed、fixed、unverified で済む。failed、unchanged、作業中では済まない', () => {
  for (const status of ['passed', 'fixed', 'unverified']) assert.equal(stepsWith({ a: [status] }).view('a').fixed, true, status);
  for (const status of ['failed', 'unchanged', 'agent-failed', 'cancelled', 'running']) {
    assert.equal(stepsWith({ a: [status] }).view('a').fixed, false, status);
  }
});

test('lastRun は、終わった最後の依頼の状態。作業中の依頼は飛ばす', () => {
  assert.equal(stepsWith({ a: ['passed', 'failed'] }).view('a').lastRun, 'failed');
  assert.equal(stepsWith({ a: ['failed', 'running'] }).view('a').lastRun, 'failed');
  assert.equal(stepsWith({ a: ['running'] }).view('a').lastRun, null);
});

test('直した後に試すと、3 番も済む', () => {
  const statuses = { a: [] };
  const steps = stepsWith(statuses);
  steps.tried('a');
  statuses.a.push('failed');
  steps.tried('a');
  assert.equal(steps.view('a').triedFixed, false);
  statuses.a.push('passed');
  steps.tried('a');
  assert.deepEqual(steps.view('a'), { tried: true, fixed: true, triedFixed: true, lastRun: 'passed' });
});

test('閉じたことを覚える', () => {
  const steps = stepsWith();
  assert.deepEqual(steps.dismiss(), { dismissed: true });
  assert.deepEqual(steps.state(), { dismissed: true });
});
