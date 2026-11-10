import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  COMMENT_KINDS,
  FIX_RECORD_FIELDS,
  ProjectComments,
  approvalSatisfied,
  cleanPlace,
  heldReason,
  nearNumbers,
  placeWords,
  requestFor,
} from '../../src/server/comments.js';

// 画面へのコメントと直した記録(user-journey.md の K3、collaboration.md の 3〜5 節)。作る AI と版は偽物にして、決まりだけを確かめる

test('承認がそろうか: 見た目と動きと構成は 1 人、要件は進行役と決める人の 2 人', () => {
  const by = (...roles) => roles.map((role) => ({ role }));
  assert.equal(approvalSatisfied('look', []), false);
  assert.equal(approvalSatisfied('look', by('facilitator')), true);
  assert.equal(approvalSatisfied('look', by('decider')), true);
  assert.equal(approvalSatisfied('architecture', by('decider')), true);
  assert.equal(approvalSatisfied('requirement', by('facilitator')), false);
  assert.equal(approvalSatisfied('requirement', by('decider')), false);
  assert.equal(approvalSatisfied('requirement', by('facilitator', 'decider')), true);
  assert.deepEqual(Object.keys(COMMENT_KINDS), ['look', 'requirement', 'architecture']);
});

test('画面の場所は、見えている枠の中の % だけを受ける', () => {
  assert.deepEqual(cleanPlace({ x: 12.4, y: 87.6 }), { x: 12, y: 88 });
  assert.equal(cleanPlace(null), null);
  for (const bad of [{ x: -1, y: 0 }, { x: 0, y: 101 }, { x: 'a', y: 1 }, {}]) assert.throws(() => cleanPlace(bad), /画面の場所/);
  assert.equal(placeWords(null), '画面の全体');
  assert.equal(placeWords({ x: 20, y: 10 }), '見えている画面の、左から 20%、上から 10% のあたり');
});

test('同じ所に向いた開いたコメントを並べる', () => {
  const c = (number, place, status = 'open') => ({ id: `c${number}`, number, place, status });
  const list = [c(1, { x: 10, y: 10 }), c(2, { x: 15, y: 12 }), c(3, { x: 80, y: 80 }), c(4, { x: 11, y: 9 }, 'closed'), c(5, null)];
  assert.deepEqual(nearNumbers(list[0], list), [2]);
  assert.deepEqual(nearNumbers(list[4], list), []);
});

test('依頼の文は決まった形に包む。コメントの文が先に来て、要件では整理の板の項目を足す', () => {
  const comment = { number: 3, text: '見出しを「うみかぜ求人相談」にして', kind: 'requirement', place: { x: 50, y: 5 } };
  const text = requestFor(comment, { purpose: { who: '仕事を探す人(架空)', success: '3 分で条件を伝えられる' }, board: [{ column: 'rule', text: '勤務地は 3 つまで選べる' }] });
  const lines = text.split('\n');
  assert.equal(lines[1], 'どうなってほしいか: 見出しを「うみかぜ求人相談」にして');
  assert.match(text, /画面の場所: 見えている画面の、左から 50%、上から 5% のあたり/);
  assert.match(text, /進行役と決める人の 2 人が承認しました/);
  assert.match(text, /- 成功の印: 3 分で条件を伝えられる/);
  assert.match(text, /- 勤務地は 3 つまで選べる/);
  // コメントの文より前に「」を置かない(偽接続は最初の「」を読む)
  assert.equal(text.indexOf('「'), text.indexOf('「うみかぜ'));
  // 見た目と動きでは、整理の板を入れない
  assert.doesNotMatch(requestFor({ ...comment, kind: 'look' }, { board: [{ text: '勤務地は 3 つまで選べる' }] }), /整理の板/);
  assert.ok(requestFor({ ...comment, text: 'あ'.repeat(5000) }).length <= 4000);
});

async function setup({ reviews = null } = {}) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-comments-'));
  const id = 'demo';
  await fs.mkdir(path.join(home, 'projects', id, '.studio'), { recursive: true });
  const started = [];
  const restored = [];
  let ended = null;
  let number = 0;
  const saved = [];
  const versions = {
    list: async () => ({ versions: saved, working: { files: saved.length === 0 ? 'none' : 'changed', versionId: null, conversation: null } }),
    save: async (_id, { name }) => {
      number += 1;
      const version = { id: `${String(number).padStart(16, '0')}`, number, name, kind: 'manual', builds: true };
      saved.unshift(version);
      return { version };
    },
    restore: async (_id, versionId) => {
      restored.push(versionId);
      return { restored: saved.find((v) => v.id === versionId), build: { ok: true } };
    },
  };
  const requests = {
    summary: () => ({ running: ended !== null && started.length > 0 && !ended.done }),
    start: async (_id, text) => {
      started.push(text);
      ended = { done: false };
      return {
        run: { id: 'a1b2c3d4e5f60718' },
        subscribe(_onUpdate, onEnd) {
          ended.finish = (run) => {
            ended.done = true;
            onEnd(run);
          };
          return () => {};
        },
      };
    },
  };
  const comments = new ProjectComments({ home, store: { requireProject: async () => ({}) }, requests, versions, reviews });
  return { home, id, comments, started, restored, end: (run) => ended.finish(run) };
}

async function until(check, ms = 2000) {
  const start = Date.now();
  while (!(await check())) {
    if (Date.now() - start > ms) throw new Error('待っても変わりませんでした');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test('反応では動かず、承認で 1 回だけ作る AI に渡す。直した記録の項目(collaboration.md の 5 節)がそろい、戻すと「戻した」が足される', async () => {
  const t = await setup();
  try {
    const { comment } = await t.comments.create(t.id, { text: '見出しを「うみかぜ求人相談」にして', kind: 'look', place: { x: 40, y: 8 }, author: 'お店の人' });
    for (let i = 0; i < 10; i += 1) await t.comments.react(t.id, comment.id);
    assert.equal(t.started.length, 0);

    await t.comments.approve(t.id, comment.id, { role: 'decider', pressedBy: '進行役(架空)', spokenBy: '店長(架空)' });
    await until(() => t.started.length === 1);
    // 動き出した後は、承認を取り消せない
    await until(async () => (await t.comments.view(t.id)).comments[0].status === 'fixing');
    await assert.rejects(t.comments.unapprove(t.id, comment.id), /取り消せません/);

    t.end({
      id: 'a1b2c3d4e5f60718',
      status: 'passed',
      changedFiles: [{ file: 'app/index.html' }],
      gates: [
        { id: 'G1', name: 'changes', label: '変更の確認', status: 'passed' },
        { id: 'G5', name: 'launch', label: '起動の確認', status: 'passed', screenshots: [] },
        { id: 'G6', name: 'scenarios', label: 'シナリオ', status: 'skipped' },
      ],
      evidence: { run: '.studio/runs/a1b2c3d4e5f60718/run.json' },
    });
    await until(async () => (await t.comments.view(t.id)).comments[0].status === 'review');
    assert.equal(t.started.length, 1);

    const [record] = (await t.comments.view(t.id)).comments[0].records;
    for (const field of FIX_RECORD_FIELDS) assert.ok(record[field], `直した記録に ${field} がありません`);
    // コメント: ID、文、画面の場所、種類、書いた人、反応の数
    assert.deepEqual(
      { id: record.comment.id, text: record.comment.text, place: record.comment.place, kind: record.comment.kind, author: record.comment.author, reactions: record.comment.reactions },
      { id: comment.id, text: '見出しを「うみかぜ求人相談」にして', place: { x: 40, y: 8 }, kind: 'look', author: 'お店の人', reactions: 10 },
    );
    // 承認: 承認した人、時刻。押した人と声に出した人
    assert.equal(record.approval.approvers.length, 1);
    assert.equal(record.approval.approvers[0].role, 'decider');
    assert.equal(record.approval.approvers[0].pressedBy, '進行役(架空)');
    assert.equal(record.approval.approvers[0].spokenBy, '店長(架空)');
    assert.ok(record.approval.approvers[0].at);
    // 依頼: 作る AI に渡した文の全部
    assert.equal(record.request.text, t.started[0]);
    // 版: 直す前と直した後の版の ID
    assert.equal(record.versions.before.name, 'コメント 1 の前');
    assert.equal(record.versions.after.name, 'コメント 1 で変えた状態');
    assert.notEqual(record.versions.before.id, record.versions.after.id);
    // 変わったもの: ファイルの一覧と要約。要件の文書の項目
    assert.deepEqual(record.changes.files, ['app/index.html']);
    assert.match(record.changes.summary, /1 個のファイルが変わりました/);
    assert.deepEqual(record.changes.requirementItems, []);
    // 関門: 関門ごとの結果と run の記録への参照(行わなかった関門は入れない)
    assert.deepEqual(record.gates.results.map((g) => g.id), ['G1', 'G5']);
    assert.equal(record.gates.run, '.studio/runs/a1b2c3d4e5f60718/run.json');
    // 確かめ: まだ押していない
    assert.deepEqual(Object.keys(record.confirmation).sort(), ['resolvedAt', 'resolvedBy', 'revertedAt', 'revertedBy']);

    // 元に戻す: 直す前の版に戻し、記録は消さずに「戻した」を足す
    const reverted = await t.comments.revert(t.id, comment.id, { pressedBy: '進行役(架空)' });
    assert.equal(reverted.comment.status, 'reverted');
    assert.deepEqual(t.restored, [record.versions.before.id]);
    const [after] = (await t.comments.view(t.id)).comments[0].records;
    assert.equal(after.id, record.id);
    assert.deepEqual(after.events.map((e) => e.label), ['作る AI に送った', '直した版ができた', '戻した']);
    assert.ok(after.confirmation.revertedAt);
    assert.equal(after.confirmation.revertedBy.pressedBy, '進行役(架空)');
    assert.equal(t.started.length, 1);
  } finally {
    await fs.rm(t.home, { recursive: true, force: true });
  }
});

test('要件は 2 人の承認がそろうまで渡さない。取り消すと渡さない。構成は審査がなければ断る', async () => {
  const t = await setup();
  try {
    const { comment } = await t.comments.create(t.id, { text: '勤務地は 3 つまで選べるようにして', kind: 'requirement' });
    await t.comments.approve(t.id, comment.id, { role: 'facilitator' });
    await t.comments.approve(t.id, comment.id, { role: 'facilitator' });
    await t.comments.unapprove(t.id, comment.id);
    await t.comments.approve(t.id, comment.id, { role: 'decider' });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(t.started.length, 0);
    assert.equal((await t.comments.view(t.id)).comments[0].status, 'open');
    await t.comments.approve(t.id, comment.id, { role: 'facilitator' });
    await until(() => t.started.length === 1);

    const { comment: arch } = await t.comments.create(t.id, { text: '人に渡す条件を足して', kind: 'architecture' });
    await assert.rejects(t.comments.approve(t.id, arch.id, { role: 'facilitator' }), /審査を使えません/);
    assert.equal(t.started.length, 1);
  } finally {
    await fs.rm(t.home, { recursive: true, force: true });
  }
});

test('記録らしいもの(電話番号など)のあるコメントは残さない', async () => {
  const t = await setup();
  try {
    await assert.rejects(t.comments.create(t.id, { text: '090-1234-5678 に電話するボタンを足して' }), /記録らしいもの/);
    assert.equal((await t.comments.view(t.id)).comments.length, 0);
  } finally {
    await fs.rm(t.home, { recursive: true, force: true });
  }
});

test('構成のコメントは審査に戻せたときだけ承認が残る。戻せなければ承認しなかったことにする', async () => {
  let fail = true;
  const returned = [];
  const reviews = {
    reopenFromComment: async (_id, comment) => {
      if (fail) throw new Error('前の操作の途中です');
      returned.push(comment);
      return { status: 'drafting' };
    },
  };
  const t = await setup({ reviews });
  try {
    const { comment } = await t.comments.create(t.id, { text: '人に渡す条件を足して', kind: 'architecture' });
    await assert.rejects(t.comments.approve(t.id, comment.id, { role: 'facilitator' }), /前の操作の途中/);
    let view = (await t.comments.view(t.id)).comments[0];
    assert.equal(view.status, 'open');
    assert.deepEqual(view.approvals, []);
    fail = false;
    await t.comments.approve(t.id, comment.id, { role: 'facilitator' });
    view = (await t.comments.view(t.id)).comments[0];
    assert.equal(view.status, 'returned');
    assert.equal(returned.length, 1);
    assert.equal(returned[0].number, 1);
    assert.equal(t.started.length, 0);
  } finally {
    await fs.rm(t.home, { recursive: true, force: true });
  }
});

test('列の先頭が止まっていれば、後ろも送らない。起動し直すと、直している途中だったものは落ちた(記録にも残す)', async () => {
  const t = await setup();
  try {
    const a = (await t.comments.create(t.id, { text: '見出しを「あさかぜ」にして' })).comment;
    const b = (await t.comments.create(t.id, { text: '見出しを「ゆうかぜ」にして' })).comment;
    const data = await t.comments.load(t.id);
    // 先頭(a)を止めた状態で列に並べる
    Object.assign(data.comments[0], { status: 'queued', queuedAt: '2026-11-11T00:00:00.000Z', approvals: [{ role: 'decider' }], held: { code: 'busy', message: '止めた' } });
    Object.assign(data.comments[1], { status: 'queued', queuedAt: '2026-11-11T00:00:01.000Z', approvals: [{ role: 'decider' }] });
    await t.comments.pump(t.id);
    assert.equal(t.started.length, 0);
    // 「列を進める」で先頭から送る
    await t.comments.resume(t.id);
    await until(() => t.started.length === 1);
    assert.match(t.started[0], /あさかぜ/);
    await until(async () => (await t.comments.view(t.id)).comments.find((c) => c.id === a.id).status === 'fixing');

    // 起動し直したことにする(メモリーを捨てて読み直す)
    const fresh = new ProjectComments({ home: t.home, store: { requireProject: async () => ({}) }, requests: { summary: () => ({ running: false }) }, versions: {} });
    const view = await fresh.view(t.id);
    const first = view.comments.find((c) => c.id === a.id);
    assert.equal(first.status, 'failed');
    assert.equal(first.records[0].status, 'failed');
    assert.equal(first.records[0].events.at(-1).label, '直せなかった');
    const second = view.comments.find((c) => c.id === b.id);
    assert.equal(second.status, 'queued');
    assert.equal(second.held.code, 'restarted');
  } finally {
    await fs.rm(t.home, { recursive: true, force: true });
  }
});

test('列で止めた理由は、見せる画面に出せる平たい文にする(元の文は detail に残す)', () => {
  const busy = heldReason(Object.assign(new Error('このプロジェクトは今ビルド中です'), {}));
  assert.equal(busy.code, 'error');
  assert.doesNotMatch(busy.message, /ビルド/);
  assert.equal(busy.detail, 'このプロジェクトは今ビルド中です');
  const consent = heldReason(Object.assign(new Error('直す AI を使うには、同意が要ります'), { code: 'consent-required', next: '同意してから' }));
  assert.deepEqual(consent, { code: 'consent-required', message: '直す AI を使うには、同意が要ります', next: '同意してから' });
});
