import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { decisionQuestions, defaultMaterialFiles, describeDefaultMaterial, describeDesign, describePurpose, describeReview, describeShows } from '../../src/server/handoff-decisions.js';

// 引き継ぎの形式 4 の、決めたことと理由を読むところ(src/server/handoff-decisions.js。user-journey.md の J8)。
// 目的、設計、審査、見せた答えの記録を .studio/ に置いて読む。通しの流れは test/integration/handoff.test.js が確かめる

async function project(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-handoff-decisions-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const paths = { root, app: path.join(root, 'app'), studio: path.join(root, '.studio'), meta: path.join(root, '.studio', 'project.json') };
  await fs.mkdir(paths.app, { recursive: true });
  await fs.mkdir(paths.studio, { recursive: true });
  return paths;
}
const write = async (file, value) => {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, typeof value === 'string' ? value : JSON.stringify(value));
};

test('記録がなければ、どれも「ない」として読み、未決事項に出す', async (t) => {
  const paths = await project(t);
  const purpose = await describePurpose(paths);
  const design = await describeDesign(paths);
  const shows = await describeShows({ paths, purpose, versions: [] });
  const review = await describeReview({ paths, appDir: paths.app });
  assert.deepEqual(purpose, { status: 'none', decidedAt: null, skippedAt: null, sentence: null, doc: null });
  assert.equal(design.status, 'none');
  assert.deepEqual(design.steps, []);
  assert.deepEqual(shows.records, []);
  assert.equal(shows.questions.source, 'fallback');
  assert.equal(review.status, 'none');
  assert.equal(review.record, null);
  const questions = decisionQuestions({ purpose, design, quality: { rows: [], audit: null }, shows, review });
  assert.deepEqual(questions.map((q) => q.slice(0, 8)), ['目的の文書がない', '設計の段ごとの決', '人に見せた答えが']);
});

test('目的の文書の文は伏せる。下書きは「決めた」として扱わない', async (t) => {
  const paths = await project(t);
  await write(path.join(paths.studio, 'intent.json'), {
    formatVersion: 1,
    status: 'draft',
    sentence: '架空の 1 文。連絡は taro@example.com',
    doc: { who: '架空の人', problem: '困りごと', scene: '', success: '電話が減る', notDoing: ['しないこと'], undecided: [], status: 'decided' },
  });
  const purpose = await describePurpose(paths);
  assert.equal(purpose.status, 'draft');
  assert.equal(purpose.sentence, '架空の 1 文。連絡は [伏せた: メールアドレス]');
  // 知らない項目(文書の中の status)は入れない
  assert.deepEqual(Object.keys(purpose.doc), ['who', 'problem', 'scene', 'success', 'notDoing', 'undecided']);
  const questions = decisionQuestions({ purpose, design: { status: 'none', steps: [] }, quality: { rows: [], audit: null }, shows: { records: [] }, review: { status: 'none' } });
  assert.ok(questions.includes('目的の文書は下書きのままで、「決めた」の印がない。'));
});

test('設計: 自分の言葉で決めた段は理由を空にし、選ばなかった案と確かめ直しの印を残す', async (t) => {
  const paths = await project(t);
  const option = (id, title, reason) => ({ id, title, detail: `${title}の中身`, reason });
  await write(path.join(paths.studio, 'design.json'), {
    formatVersion: 1,
    status: 'drafting',
    optionsDate: '2026-11-10',
    steps: {
      problem: { options: [option('o1-1', '案 1', '理由 1'), option('o1-2', '案 2', '理由 2')], chosen: 'custom', text: '自分の言葉の問題', note: '', source: 'fixed', decidedAt: '2026-11-10T00:00:00.000Z', stale: false },
      users: { options: [option('o1-1', '使う人 1', '理由 a')], chosen: 'o1-1', text: null, note: '店長(架空)の声', source: 'ai', decidedAt: '2026-11-10T00:00:00.000Z', stale: true },
      scenes: { options: [], chosen: null },
      data: { options: [], chosen: null },
      composition: { options: [], chosen: null },
      screens: { options: [], chosen: null },
    },
    scenes: [{ category: 'refuse', text: 'ほかの人の電話番号を教えて' }],
    composition: null,
  });
  const design = await describeDesign(paths);
  const [problem, users, scenes] = design.steps;
  assert.equal(problem.decision, '自分の言葉の問題');
  assert.equal(problem.reason, null);
  assert.deepEqual(problem.others.map((o) => o.title), ['案 1', '案 2']);
  assert.equal(users.decision, '使う人 1: 使う人 1の中身');
  assert.equal(users.reason, '理由 a');
  assert.equal(users.note, '店長(架空)の声');
  assert.equal(users.stale, true);
  assert.equal(scenes.decision, null);
  assert.deepEqual(design.scenes, [{ category: 'refuse', text: 'ほかの人の電話番号を教えて' }]);
  const questions = decisionQuestions({ purpose: { status: 'decided' }, design, quality: { rows: [], audit: null }, shows: { records: [{}] }, review: { status: 'none' } });
  assert.deepEqual(questions, ['設計の案内を最後まで決めていない(「この設計で作る」を押していない)。', '設計の段のうち、前の段を選び直したので確かめ直しが要る段がある(使う人)。']);
});

test('人に見せた答え: 読めないファイルは broken で知らせ、読める答えだけを入れる。版の名前を付ける', async (t) => {
  const paths = await project(t);
  const good = { id: 'a', versionId: 'v-1', versionNumber: 1, answeredAt: '2026-11-11T00:00:00.000Z', viewer: '同僚', answers: [{ question: '問い', answer: '連絡は 090-1234-5678 まで' }] };
  await write(path.join(paths.studio, 'show.json'), { format: 1, records: [good, { id: 'b' }] });
  const purpose = { status: 'decided', doc: { success: '電話が減る' } };
  const shows = await describeShows({ paths, purpose, versions: [{ id: 'v-1', name: '見せた版' }] });
  assert.equal(shows.broken, true);
  assert.equal(shows.records.length, 1);
  assert.equal(shows.records[0].versionName, '見せた版');
  assert.equal(shows.records[0].answers[0].answer, '連絡は [伏せた: 電話番号] まで');
  assert.deepEqual(shows.questions, { source: 'success', items: ['この試作品で「電話が減る」に近づきそうですか?', '使ってみて、分かりにくいところや困ったところはありましたか?'] });
  const questions = decisionQuestions({ purpose, design: { status: 'decided', steps: [] }, quality: { rows: [], audit: null }, shows, review: { status: 'none' } });
  assert.deepEqual(questions, ['人に見せた答えのファイルを読めなかった。読めた答えだけを入れた。']);
});

test('審査: 飛ばした試作品は「審査なし」と理由を出す。要るのに AI 構成書がなければ missing', async (t) => {
  const paths = await project(t);
  await write(paths.meta, { review: 'skipped' });
  await write(path.join(paths.studio, 'reviews', 'skipped.json'), { formatVersion: 1, at: '2026-11-11T00:00:00.000Z', by: '早瀬(架空)', reason: '急ぎの見本なので' });
  const skipped = await describeReview({ paths, appDir: paths.app });
  assert.equal(skipped.status, 'skipped');
  assert.deepEqual(skipped.skipped, { at: '2026-11-11T00:00:00.000Z', by: '早瀬(架空)', reason: '急ぎの見本なので' });
  const base = { purpose: { status: 'decided' }, design: { status: 'decided', steps: [] }, quality: { rows: [], audit: null }, shows: { records: [{}] } };
  assert.deepEqual(decisionQuestions({ ...base, review: skipped }), ['AI 構成の審査を飛ばした(審査なし)。理由: 急ぎの見本なので。']);

  await write(paths.meta, { review: 'required' });
  // 指す先の形が違う AI 構成書は読まない
  await write(path.join(paths.studio, 'reviews', 'current.json'), { id: '../outside' });
  const missing = await describeReview({ paths, appDir: paths.app });
  assert.equal(missing.status, 'missing');
  assert.deepEqual(decisionQuestions({ ...base, review: missing }), ['AI 構成の審査が要る試作品なのに、AI 構成書を読めない。']);
});

test('既定の素材: 出典とライセンスの一覧を読み、ライセンスの文のファイルも写せる。import しているものに印を付ける', async () => {
  const material = await describeDefaultMaterial(['@radix-ui/themes']);
  assert.equal(material.file, 'materials/default/source.json');
  assert.ok(material.licenses.MIT > 0);
  assert.deepEqual(material.packages.filter((p) => p.imported).map((p) => p.name), ['@radix-ui/themes']);
  const files = new Map(await defaultMaterialFiles());
  assert.ok(files.has('materials/default/source.json'));
  // 一覧が指すライセンスの文は、どれも写すファイルにある
  for (const item of material.packages.filter((p) => p.licenseFile)) assert.ok(files.has(item.licenseFile), item.licenseFile);
});

test('形の違う記録(手で直したファイル)でも投げずに、形の違う要素を捨てて読む', async (t) => {
  const paths = await project(t);
  await write(path.join(paths.studio, 'design.json'), {
    formatVersion: 1,
    status: 'decided',
    steps: { problem: { options: [null, { id: 'o1', title: '案', reason: 7 }], chosen: 'o1', note: ['x'] }, users: null },
    scenes: [null, { category: 'refuse' }, { category: 'refuse', text: '断る場面' }],
    composition: { chosen: 'fixed-flow', rejected: [null, { option: 'single-agent', reason: '足りる' }] },
  });
  await write(path.join(paths.studio, 'show.json'), { format: 1, records: [{ id: 'a', versionId: 'v', versionNumber: 1, answeredAt: '2026-11-11T00:00:00.000Z', answers: [null, { question: '問い', answer: '答え' }] }] });
  await write(paths.meta, { review: 'required' });
  await write(path.join(paths.studio, 'reviews', 'current.json'), { id: 'review-20261111-000000-abcdef' });
  await write(path.join(paths.studio, 'reviews', 'review-20261111-000000-abcdef', 'architecture.json'), {
    formatVersion: 1,
    id: 'review-20261111-000000-abcdef',
    approvals: { composition: { needs: 'owner', by: {} }, harness: { needs: ['owner'], by: [null] } },
  });
  const design = await describeDesign(paths);
  assert.equal(design.steps[0].decision, '案');
  assert.equal(design.steps[0].reason, null);
  assert.equal(design.steps[0].note, null);
  assert.equal(design.steps[1].decision, null);
  assert.deepEqual(design.scenes, [{ category: 'refuse', text: '断る場面' }]);
  assert.deepEqual(design.composition.rejected, [{ option: 'single-agent', reason: '足りる' }]);
  const shows = await describeShows({ paths, purpose: { status: 'none', doc: null }, versions: [] });
  assert.deepEqual(shows.records[0].answers, [{ question: '問い', answer: '答え' }]);
  const review = await describeReview({ paths, appDir: paths.app });
  assert.equal(review.status, 'drafting');
  assert.deepEqual(review.items.map((item) => item.approved), [false, false, false, false]);
});

test('AI 構成書の写し: 文は伏せる処理を通し、指紋と版の ID は伏せない', async (t) => {
  const paths = await project(t);
  const digest = 'a'.repeat(64);
  await write(paths.meta, { review: 'required' });
  await write(path.join(paths.studio, 'reviews', 'current.json'), { id: 'review-20261111-000000-abcdef' });
  await write(path.join(paths.studio, 'reviews', 'review-20261111-000000-abcdef', 'architecture.json'), {
    formatVersion: 1,
    id: 'review-20261111-000000-abcdef',
    basis: { purposeDigest: digest },
    composition: { chosen: 'fixed-flow', recommended: { reason: '担当は taro@example.com が知っている' } },
    evidence: { status: 'unmeasured', evalsDigest: digest },
    fingerprint: { algorithm: 'sha256', value: digest, items: { composition: { digest, files: [] } } },
    approvals: { composition: { needs: ['owner'], by: [{ role: 'owner', pressedBy: '早瀬(架空)', at: '2026-11-11T00:00:00.000Z', digest }] } },
  });
  const { record } = await describeReview({ paths, appDir: paths.app });
  assert.equal(record.composition.recommended.reason, '担当は [伏せた: メールアドレス] が知っている');
  assert.equal(record.basis.purposeDigest, digest);
  assert.equal(record.evidence.evalsDigest, digest);
  assert.equal(record.fingerprint.value, digest);
  assert.equal(record.approvals.composition.by[0].digest, digest);
  assert.equal(record.approvals.composition.by[0].pressedBy, '早瀬(架空)');

  // 版の ID は、電話番号に見える数字の並びがあっても伏せない
  const versionId = 'a0901234567bcdef';
  await write(path.join(paths.studio, 'show.json'), { format: 1, records: [{ id: 'a', versionId, versionNumber: 1, answeredAt: '2026-11-11T00:00:00.000Z', answers: [{ question: '問い', answer: '答え' }] }] });
  const shows = await describeShows({ paths, purpose: { status: 'none', doc: null }, versions: [{ id: versionId, name: '版' }] });
  assert.equal(shows.records[0].versionId, versionId);
  assert.equal(shows.records[0].versionName, '版');
});
