import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { projectPaths } from './projects.js';

// 会の段ごとの時刻(docs/design/user-journey.md の K6、docs/design/field-session.md の 3 節の「何で測るか」)。
// 段の成功の印が初めて付いた時刻を、Studio が .studio/timeline.json に残す。1 度残した時刻は上書きしない
// (後で板を直したり審査に戻ったりしても、最初に届いた時刻が測る値になる)。会ではない試作品と、同意の前の会には残さない。
// 残すのは時刻だけで、お客さんの話は入れない。会のデータを消すと、試作品と一緒に消える。

export const TIMELINE_FILE = 'timeline.json';
const FORMAT = 1;

// 段(field-session.md の 2 節の一覧の順)。plan は 60 分の型で、その段が終わる目安の分(仮)。mark は Studio が時刻を残す印
export const MEETING_STAGES = Object.freeze([
  { key: 'start', label: '始める', mark: '同意を押した(お試しの AI だけで始めたときも)', plan: 5 },
  { key: 'listen', label: '聞く', mark: '5 つの欄に 1 つずつ以上の項目が入った', plan: 18 },
  { key: 'organize', label: 'AI が整理する', mark: '「この理解で合っている」を押した', plan: 23 },
  { key: 'review', label: 'AI 構成の審査', mark: '4 つの承認がそろい、「この構成で作る」を押した', plan: 35 },
  { key: 'prototype', label: '試作品', mark: '自動の確かめが通った試作品ができた', plan: 45 },
  { key: 'show', label: '見せて、コメントをもらう', mark: '最初のコメントが付いた', plan: 52 },
  { key: 'fix', label: '承認して AI が直す', mark: '承認したコメントで直した版ができた', plan: 57 },
  { key: 'closing', label: '要件の文書と引き継ぎ', mark: '書き出した', plan: 60 },
]);
const STAGE_KEYS = MEETING_STAGES.map((stage) => stage.key);

// 測るもの(field-session.md の 3 節)。目安はどちらも仮の値
export const TIMELINE_TARGETS = Object.freeze({ showMinutes: 45, fixMinutes: 5 });

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const validAt = (value) => typeof value === 'string' && ISO.test(value) && !Number.isNaN(Date.parse(value));

export async function readTimeline(paths) {
  try {
    const raw = JSON.parse(await fs.readFile(path.join(paths.studio, TIMELINE_FILE), 'utf8'));
    if (raw?.formatVersion !== FORMAT || typeof raw.stages !== 'object' || raw.stages === null) return {};
    return Object.fromEntries(STAGE_KEYS.filter((key) => validAt(raw.stages[key])).map((key) => [key, raw.stages[key]]));
  } catch {
    return {};
  }
}

const span = (from, to) => (from && to ? Math.max(0, Date.parse(to) - Date.parse(from)) : null);

// 自動の確かめが通った run の状態(build-requests.js)。確かめられなかった直し(unverified)は、直った版に数えない
export const CHECKED_RUN = Object.freeze(['passed', 'fixed']);

// 承認から直った版まで。直した記録(comments.js の newFixRecord と applyRunToRecord)の、承認がそろった時刻と「直した版ができた」の時刻。
// 直した版ができても自動の確かめが通っていなければ、checked が false で、ms は null
export function fixDurations(records = []) {
  return records
    .filter((record) => record && typeof record === 'object')
    .map((record) => {
      const approvedAt = validAt(record.approval?.completedAt) ? record.approval.completedAt : null;
      const fixedAt = (Array.isArray(record.events) ? record.events : []).find((e) => e?.type === 'fixed' && validAt(e.at))?.at ?? null;
      const checked = Boolean(fixedAt) && CHECKED_RUN.includes(record.gates?.status);
      return { recordId: typeof record.id === 'string' ? record.id : null, comment: Number.isSafeInteger(record.comment?.number) ? record.comment.number : null, approvedAt, fixedAt, checked, ms: checked ? span(approvedAt, fixedAt) : null };
    })
    .filter((item) => item.approvedAt)
    .sort((a, b) => a.approvedAt.localeCompare(b.approvedAt));
}

// 画面と引き継ぎに出す形。elapsedMs は始め(同意)からの時間。toShowMs は見せられるまでの時間(同意から、確かめが通った最初の試作品まで)
// 会を始めていない試作品(start がない)では、直した記録があっても測らない
export function describeTimeline(stages = {}, records = []) {
  const start = stages.start ?? null;
  const fixes = start ? fixDurations(records) : [];
  const done = fixes.filter((item) => item.ms !== null);
  return {
    stages: MEETING_STAGES.map((stage) => ({ key: stage.key, label: stage.label, mark: stage.mark, planMinutes: stage.plan, at: stages[stage.key] ?? null, elapsedMs: span(start, stages[stage.key]) })),
    reached: STAGE_KEYS.filter((key) => stages[key]).length,
    toShowMs: span(start, stages.prototype),
    fixes,
    // 一番かかった直し(目安と比べる値)
    longestFixMs: done.length > 0 ? Math.max(...done.map((item) => item.ms)) : null,
    targets: TIMELINE_TARGETS,
  };
}

// 時間を「12 分 5 秒」の形にする
export function durationWords(ms) {
  if (ms === null || ms === undefined) return 'まだ測れていません';
  const seconds = Math.round(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  if (hours > 0) return `${hours} 時間 ${minutes % 60} 分`;
  return minutes > 0 ? `${minutes} 分 ${seconds % 60} 秒` : `${seconds} 秒`;
}

export class MeetingTimeline {
  // isOpen(id) は、同意の後(お試しの AI だけの会も)の会か(meeting.js)。そうでなければ残さない
  constructor({ home, isOpen = () => false, log = () => {} }) {
    this.home = home;
    this.isOpen = isOpen;
    this.log = log;
    this.queues = new Map();
  }

  // 段の印が付いた。初めてなら時刻を残す。at を渡さなければ今の時刻。失敗してもほかの操作は止めない(ターミナルに出す)
  mark(id, key, at = null) {
    if (!STAGE_KEYS.includes(key) || !this.isOpen(id)) return Promise.resolve(false);
    const time = validAt(at) ? at : new Date().toISOString();
    const run = async () => {
      const paths = projectPaths(this.home, id);
      const stages = await readTimeline(paths);
      if (stages[key]) return false;
      stages[key] = time;
      const file = path.join(paths.studio, TIMELINE_FILE);
      const tmp = `${file}.${crypto.randomBytes(4).toString('hex')}.tmp`;
      await fs.writeFile(tmp, `${JSON.stringify({ formatVersion: FORMAT, stages }, null, 2)}\n`);
      await fs.rename(tmp, file);
      return true;
    };
    const result = (this.queues.get(id) ?? Promise.resolve()).then(run, run).catch((error) => {
      this.log(`会の段の時刻を残せませんでした: ${id}(${key}。${error.message})`);
      return false;
    });
    this.queues.set(id, result);
    return result;
  }

  async view(id) {
    return readTimeline(projectPaths(this.home, id));
  }
}
