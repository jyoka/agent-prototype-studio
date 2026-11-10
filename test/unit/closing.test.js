import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DELIVERABLES, describeDeliverables, describeOpenItems, describeRequirements, readOwners } from '../../src/server/closing.js';
import { newFixRecord } from '../../src/server/comments.js';
import { ProjectHandoffs } from '../../src/server/handoff.js';
import { createMockConnection } from '../../src/server/product-ai/mock.js';
import { AiSessions } from '../../src/server/product-ai/session.js';
import { ProjectStore } from '../../src/server/store.js';
import { ProjectVersions } from '../../src/server/versions.js';

// 会の終わりの成果物(src/server/closing.js。user-journey.md の K5)。
// 7 つの成果物(要件の文書、データ設計、構成の図、AI 構成書、試作品、場面の一覧、未決事項)と、直した記録の一覧が書き出しに入るかを確かめる。
// 題材と名前はすべて架空

const SEVEN = ['requirements', 'dataDesign', 'composition', 'review', 'prototype', 'scenes', 'openItems'];

const BOARD = {
  formatVersion: 1,
  status: 'confirmed',
  rev: 4,
  nextPoint: 4,
  nextItem: 5,
  nextAsk: 2,
  points: [
    { n: 1, text: '再配達の電話が半分', at: '2026-11-11T00:00:00.000Z' },
    { n: 2, text: '17 時を過ぎたら翌日', at: '2026-11-11T00:00:00.000Z' },
    { n: 3, text: '配達の予定を覚えておく', at: '2026-11-11T00:00:00.000Z' },
  ],
  items: [
    { id: 'i1', column: 'requirement', text: '再配達の受付を AI が答える', sources: [1], by: 'ai', held: false, checkedAt: null },
    { id: 'i2', column: 'rule', text: '17 時を過ぎたら翌日の扱い', sources: [2], by: 'ai', held: false, checkedAt: null },
    { id: 'i3', column: 'user', text: '店の受付係', sources: [], by: 'ai', held: false, checkedAt: null },
    { id: 'i4', column: 'data', text: '配達の予定', sources: [3], by: 'ai', held: false, checkedAt: null },
  ],
  asks: [{ id: 'a1', kind: 'unasked', text: '土日の扱いを聞いていない', sources: [] }],
  dismissed: { items: [], asks: [] },
  note: null,
  organizedAt: '2026-11-11T00:00:00.000Z',
  confirmedAt: '2026-11-11T00:10:00.000Z',
};

const PURPOSE = {
  status: 'decided',
  sentence: '架空の配送店で、再配達の問い合わせに答えたい',
  doc: { who: '配送店の利用者(架空)', problem: '再配達の電話に何度も答えている', scene: '夕方の問い合わせ', success: '電話が減る', notDoing: ['料金の払い戻し'], undecided: ['雨の日の扱い'] },
};

const REQUIREMENT_COMMENT = {
  id: 'aaaaaaaaaaaaaaaa',
  number: 2,
  text: '受付の締めを 18 時にしたい',
  kind: 'requirement',
  status: 'resolved',
  place: null,
  author: '',
  reactions: 1,
  approvals: [
    { role: 'facilitator', pressedBy: '早瀬(架空)', spokenBy: null, at: '2026-11-11T00:20:00.000Z' },
    { role: 'decider', pressedBy: '早瀬(架空)', spokenBy: '宇田(架空)', at: '2026-11-11T00:21:00.000Z' },
  ],
  queuedAt: '2026-11-11T00:21:00.000Z',
};
const OPEN_COMMENT = { ...REQUIREMENT_COMMENT, id: 'bbbbbbbbbbbbbbbb', number: 3, text: '見出しを大きく', kind: 'look', status: 'open', approvals: [], queuedAt: null };

const DATA_OPTION = {
  id: 'by-delivery',
  title: '配達ごとに分ける',
  detail: '配達と再配達の頼みを分ける',
  reason: '再配達の頼みが配達ごとに付くため(今日の推測)',
  entities: [
    { name: '配達', about: '配達の予定', writer: '店', fields: [{ name: '番号', kind: 'key', examples: [], sources: [] }, { name: '予定日', kind: 'date', examples: ['11 月 12 日'], sources: ['i4'] }], sources: ['i4'] },
    { name: '再配達の頼み', about: '利用者からの頼み', writer: '利用者', fields: [{ name: '番号', kind: 'key', examples: [], sources: [] }, { name: '配達の番号', kind: 'link', to: '配達', examples: [], sources: [] }, { name: '希望の時間', kind: 'choice', examples: ['夕方'], sources: [] }], sources: [] },
  ],
  links: [{ from: '配達', to: '再配達の頼み', label: '頼まれる' }],
  added: [],
};

test('要件の文書: 目的の文書と整理の板と承認した要件のコメントから作り、各項目に元の要点か推測かコメントを付ける。データの欄は入れない', () => {
  const requirements = describeRequirements({ purpose: PURPOSE, board: BOARD, comments: [REQUIREMENT_COMMENT, OPEN_COMMENT], records: [{ id: 'rec1', comment: { id: REQUIREMENT_COMMENT.id } }] });
  assert.deepEqual(requirements.sections.map((s) => s.label), ['目的', '使う人', '場面', '要求', '決まりごと', 'しないこと', '成功の印']);
  const section = (id) => requirements.sections.find((s) => s.id === id).items;
  assert.deepEqual(section('requirement').map((item) => [item.text, item.from]), [
    ['再配達の受付を AI が答える', 'point'],
    ['受付の締めを 18 時にしたい', 'comment'],
  ]);
  assert.deepEqual(section('requirement')[0].sources, [{ n: 1, text: '再配達の電話が半分' }]);
  // 要件の文書の項目から、変えたコメントと直した記録へたどれる
  assert.deepEqual(section('requirement')[1].comment, { number: 2, status: 'resolved', statusLabel: '直った', recordId: 'rec1' });
  assert.equal(section('user').find((item) => item.id === 'i3').from, 'guess');
  assert.equal(section('notDoing')[0].text, '料金の払い戻し');
  assert.ok(!requirements.sections.some((s) => s.items.some((item) => item.text === '配達の予定')));
  assert.equal(requirements.status, 'confirmed');
  assert.equal(requirements.counts.guesses, 1);
});

test('未決事項: 聞いていないこと、推測のまま、空の欄、目的の決めていないこと、片付いていないコメントを集め、持ち主と期日を結ぶ', () => {
  const items = describeOpenItems({ board: BOARD, purpose: PURPOSE, design: { status: 'decided', steps: [] }, review: { status: 'none' }, comments: [REQUIREMENT_COMMENT, OPEN_COMMENT], owners: { 'guess:i3': { owner: '進行役', due: '2026-11-20' } } });
  const froms = items.map((item) => item.from);
  for (const from of ['unasked', 'guess', 'empty', 'purpose', 'comment']) assert.ok(froms.includes(from), from);
  assert.equal(items.find((item) => item.key === 'guess:i3').owner, '進行役');
  assert.equal(items.find((item) => item.key === 'guess:i3').due, '2026-11-20');
  // 直ったコメントは未決事項にしない。承認していないコメントは出す
  assert.ok(items.some((item) => item.key === `comment:${OPEN_COMMENT.id}`));
  assert.ok(!items.some((item) => item.key === `comment:${REQUIREMENT_COMMENT.id}`));
  const deliverables = describeDeliverables({
    requirements: describeRequirements({ purpose: PURPOSE, board: BOARD }),
    dataDesign: { status: 'none', heard: [], entities: [], links: [] },
    simulation: null,
    design: null,
    review: { status: 'none' },
    evidence: { run: null },
    latestRun: null,
    openItems: items,
  });
  assert.deepEqual(deliverables.map((item) => item.id), SEVEN);
  const open = deliverables.find((item) => item.id === 'openItems');
  assert.equal(open.status, 'draft');
  assert.match(open.note, new RegExp(`持ち主のない未決事項が ${items.length - 1} 件`));
});

test('書き出しに 7 つの成果物と直した記録が入る(要件の文書、データ設計、AI 構成書、未決事項の持ち主と期日)', async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-closing-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const root = path.join(home, 'projects', 'meeting-closing');
  const studioDir = path.join(root, '.studio');
  const write = async (file, value) => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, typeof value === 'string' ? value : JSON.stringify(value));
  };
  await write(path.join(root, 'app', 'main.js'), "document.getElementById('root').textContent = '再配達の受付(架空)';\n");
  await write(path.join(studioDir, 'organize.json'), BOARD);
  await write(path.join(studioDir, 'intent.json'), { formatVersion: 1, ...PURPOSE, decidedAt: '2026-11-11T00:05:00.000Z' });
  await write(path.join(studioDir, 'design.json'), { formatVersion: 1, status: 'decided', decidedAt: '2026-11-11T00:15:00.000Z', optionsDate: '2026-11-11', steps: { data: { options: [DATA_OPTION], chosen: DATA_OPTION.id, source: 'fixed', decidedAt: '2026-11-11T00:12:00.000Z', stale: false } }, scenes: [{ category: 'unknown', text: '土日の配達を聞かれる' }] });
  await write(path.join(studioDir, 'comments.json'), { format: 1, lastNumber: 3, comments: [REQUIREMENT_COMMENT, OPEN_COMMENT] });
  const record = newFixRecord({ comment: REQUIREMENT_COMMENT, request: '画面へのコメントから頼みます。', before: { id: 'v-before', number: 1, name: 'コメント 2 の前' }, id: '0123456789abcdef', at: '2026-11-11T00:22:00.000Z' });
  record.status = 'resolved';
  record.events.push({ type: 'resolved', label: '直った', at: '2026-11-11T00:25:00.000Z' });
  // 押した人の欄に記録らしい形を書いても、書き出しでは伏せる(架空のメールアドレス)
  record.confirmation = { ...record.confirmation, resolvedBy: { pressedBy: 'hayase@example.com', spokenBy: null }, resolvedAt: '2026-11-11T00:25:00.000Z' };
  await write(path.join(studioDir, 'fix-records', record.id, 'record.json'), record);
  await write(path.join(studioDir, 'closing.json'), { formatVersion: 1, owners: { 'empty:scene': { owner: '進行役', due: '2026-11-20', at: '2026-11-11T00:30:00.000Z' } } });

  const store = new ProjectStore(home);
  await store.buildAll();
  const aiSessions = new AiSessions({ definitionOf: (id) => store.aiDefinition(id), connections: [createMockConnection()] });
  const versions = new ProjectVersions({ store, aiSessions });
  const handoffs = new ProjectHandoffs({ home, store, aiSessions, versions, requests: { list: () => [] } });
  const result = await handoffs.export('meeting-closing', {});
  const manifest = JSON.parse(await fs.readFile(path.join(result.handoff.dir, 'handoff.json'), 'utf8'));
  const readme = await fs.readFile(path.join(result.handoff.dir, 'README.md'), 'utf8');

  // 7 つの成果物。どれも状態と、handoff.json の中の場所を持つ
  assert.deepEqual(manifest.closing.deliverables.map((item) => item.label), ['要件の文書', 'データ設計', '構成の図', 'AI 構成書', '試作品', '場面の一覧', '未決事項']);
  assert.deepEqual(manifest.closing.deliverables.map((item) => item.id), DELIVERABLES.map((item) => item.id));
  for (const item of manifest.closing.deliverables) assert.ok(['ready', 'draft', 'missing'].includes(item.status) && item.note && item.where.length > 0, item.id);
  // 1. 要件の文書
  const requirement = manifest.requirements.sections.find((s) => s.id === 'requirement').items;
  assert.equal(manifest.requirements.status, 'confirmed');
  assert.deepEqual(requirement.map((item) => item.from), ['point', 'comment']);
  assert.equal(requirement[1].comment.recordId, record.id);
  // 2. データ設計
  assert.equal(manifest.dataDesign.status, 'chosen');
  assert.deepEqual(manifest.dataDesign.entities.map((e) => e.name), ['配達', '再配達の頼み']);
  assert.deepEqual(manifest.dataDesign.heard, [{ id: 'i4', text: '配達の予定', onDesign: true }]);
  // 3. 構成の図
  assert.ok(manifest.closing.figure.nodes.length > 0);
  // 4. AI 構成書(審査を受けていないので、ないことが分かる)
  assert.equal(manifest.review.status, 'none');
  assert.equal(manifest.closing.deliverables.find((item) => item.id === 'review').status, 'missing');
  // 5. 試作品(ソース)と 6. 場面の一覧
  assert.ok(manifest.source.files.some((file) => file.path === 'app/main.js'));
  assert.equal(manifest.closing.deliverables.find((item) => item.id === 'scenes').status, 'draft');
  // 7. 未決事項と持ち主と期日
  const owned = manifest.closing.openItems.find((item) => item.key === 'empty:scene');
  assert.deepEqual([owned.owner, owned.due], ['進行役', '2026-11-20']);
  assert.equal(manifest.closing.unowned, manifest.closing.openItems.length - 1);
  assert.ok(manifest.openQuestions.some((q) => q.text.startsWith(`持ち主のない未決事項が ${manifest.closing.unowned} 件`)));
  // 直した記録の一覧。要件の文書の項目へたどれる
  assert.equal(manifest.fixRecords.length, 1);
  assert.equal(manifest.fixRecords[0].comment.number, 2);
  assert.equal(manifest.fixRecords[0].requirementItem, 'comment-2');
  assert.deepEqual(manifest.fixRecords[0].approval.approvers.map((a) => a.role), ['facilitator', 'decider']);
  assert.equal(manifest.fixRecords[0].confirmation.resolvedBy.pressedBy, '[伏せた: メールアドレス]');
  assert.ok(!JSON.stringify(manifest).includes('hayase@example.com'));
  // README にも、人が読める形で入る
  for (const heading of ['## 会の終わりの成果物', '### 要件の文書', '### データ設計', '### 直した記録の一覧', '### 未決事項の持ち主と期日']) assert.ok(readme.includes(heading), heading);
  assert.match(readme, /\| 要求 \| 受付の締めを 18 時にしたい \| コメント 2\(直った。直した記録 0123456789abcdef\) \|/);
  assert.match(readme, /\| 再配達の頼み \| 利用者 \| 番号\(主キー\)、配達の番号\(配達への外部キー\)、希望の時間\(選ぶもの\) \|/);
  assert.match(readme, /\| 2「受付の締めを 18 時にしたい」 \| 要件 \| 進行役、決める人 \|/);
  assert.equal(Object.keys(await readOwners({ studio: studioDir })).length, 1);
});
