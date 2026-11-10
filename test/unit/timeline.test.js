import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { MEETING_FLOW } from '../../src/server/meeting.js';
import { MEETING_STAGES, MeetingTimeline, TIMELINE_FILE, describeTimeline, durationWords, fixDurations, readTimeline } from '../../src/server/timeline.js';

// 会の段ごとの時刻(docs/design/user-journey.md の K6)。題材は架空

async function tempProject(t, id = 'meeting-test') {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-timeline-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const studio = path.join(home, 'projects', id, '.studio');
  await fs.mkdir(studio, { recursive: true });
  return { home, id, studio };
}

const at = (minutes) => new Date(Date.UTC(2026, 10, 11, 1, 0, 0) + minutes * 60_000).toISOString();

test('段は field-session.md の 2 節の順。会の始めの流れは、始めるを除いた 7 段で、どれも「まだ作っていません」がない', () => {
  assert.deepEqual(
    MEETING_STAGES.map((stage) => stage.key),
    ['start', 'listen', 'organize', 'review', 'prototype', 'show', 'fix', 'closing'],
  );
  assert.deepEqual(MEETING_STAGES.map((stage) => stage.plan), [5, 18, 23, 35, 45, 52, 57, 60]);
  assert.deepEqual(MEETING_FLOW.map((step) => step.label), ['聞く', 'AI が整理する', 'AI 構成の審査', '試作品', '見せて、コメントをもらう', '承認して AI が直す', '要件の文書と引き継ぎ']);
  assert.ok(MEETING_FLOW.every((step) => !('ready' in step)));
});

test('時刻は同意の後の会だけに、初めての 1 回だけ残す。後から印が付き直しても上書きしない', async (t) => {
  const { home, id, studio } = await tempProject(t);
  let status = 'waiting';
  const timeline = new MeetingTimeline({ home, isOpen: () => status !== 'waiting' });
  assert.equal(await timeline.mark(id, 'start', at(0)), false);
  await assert.rejects(fs.readFile(path.join(studio, TIMELINE_FILE)), { code: 'ENOENT' });

  status = 'trial';
  assert.equal(await timeline.mark(id, 'start', at(0)), true);
  assert.equal(await timeline.mark(id, 'start', at(9)), false);
  // 知らない段は残さない
  assert.equal(await timeline.mark(id, 'lunch', at(1)), false);
  // 並べて呼んでも、どれも残る(書き込みを並べる)
  await Promise.all([timeline.mark(id, 'listen', at(10)), timeline.mark(id, 'organize', at(12)), timeline.mark(id, 'review', at(20))]);
  assert.deepEqual(await timeline.view(id), { start: at(0), listen: at(10), organize: at(12), review: at(20) });
  const saved = JSON.parse(await fs.readFile(path.join(studio, TIMELINE_FILE), 'utf8'));
  assert.equal(saved.formatVersion, 1);
  // 時刻の形でない at は、今の時刻にする
  const before = Date.now();
  await timeline.mark(id, 'prototype', 'きのう');
  assert.ok(Date.parse((await timeline.view(id)).prototype) >= before - 1000);
});

test('読めない記録と、形の違う時刻は読まない', async (t) => {
  const { studio } = await tempProject(t);
  const paths = { studio };
  await fs.writeFile(path.join(studio, TIMELINE_FILE), '{壊れた');
  assert.deepEqual(await readTimeline(paths), {});
  await fs.writeFile(path.join(studio, TIMELINE_FILE), JSON.stringify({ formatVersion: 1, stages: { start: at(0), listen: '10 時', extra: at(1) } }));
  assert.deepEqual(await readTimeline(paths), { start: at(0) });
  await fs.writeFile(path.join(studio, TIMELINE_FILE), JSON.stringify({ formatVersion: 2, stages: { start: at(0) } }));
  assert.deepEqual(await readTimeline(paths), {});
});

test('見せられるまでの時間は同意から確かめが通った試作品まで。承認から直った版までは、直した記録ごとに出す', () => {
  const records = [
    { id: 'b', comment: { number: 2 }, approval: { completedAt: at(50) }, gates: { status: 'failed' }, events: [{ type: 'requested', at: at(50) }, { type: 'failed', at: at(51) }] },
    { id: 'a', comment: { number: 1 }, approval: { completedAt: at(48) }, gates: { status: 'passed' }, events: [{ type: 'requested', at: at(48) }, { type: 'fixed', at: at(51.5) }] },
    { id: 'c', comment: { number: 3 }, approval: {}, events: [] },
    // 直した版はできたが、自動の確かめができなかった(unverified)。直った版に数えない
    { id: 'd', comment: { number: 4 }, approval: { completedAt: at(52) }, gates: { status: 'unverified' }, events: [{ type: 'fixed', at: at(53) }] },
  ];
  const view = describeTimeline({ start: at(0), listen: at(14), prototype: at(41), closing: at(59) }, records);
  assert.equal(view.reached, 4);
  assert.equal(view.toShowMs, 41 * 60_000);
  assert.deepEqual(view.stages.map((stage) => stage.elapsedMs), [0, 14 * 60_000, null, null, 41 * 60_000, null, null, 59 * 60_000]);
  assert.equal(view.stages[1].label, '聞く');
  assert.equal(view.stages[1].planMinutes, 18);
  // 承認した順。直っていないものは ms が null。承認の時刻がない記録は入れない
  assert.deepEqual(view.fixes.map((fix) => [fix.comment, fix.checked, fix.ms]), [[1, true, 3.5 * 60_000], [2, false, null], [4, false, null]]);
  assert.equal(view.fixes[2].fixedAt, at(53));
  assert.equal(view.longestFixMs, 3.5 * 60_000);
  assert.deepEqual(view.targets, { showMinutes: 45, fixMinutes: 5 });

  // 会ではない試作品(時刻がない)。直した記録があっても測らない
  const none = describeTimeline({}, records);
  assert.equal(none.reached, 0);
  assert.equal(none.toShowMs, null);
  assert.deepEqual(none.fixes, []);
  assert.equal(none.longestFixMs, null);
  assert.deepEqual(fixDurations([null, 'x']), []);
});

test('時間の言葉', () => {
  assert.equal(durationWords(null), 'まだ測れていません');
  assert.equal(durationWords(4_400), '4 秒');
  assert.equal(durationWords(12 * 60_000 + 5_000), '12 分 5 秒');
  assert.equal(durationWords(75 * 60_000), '1 時間 15 分');
});
