import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { defaultDeleteOn, isOverdue, localDate, MeetingRefusedError, ProjectMeetings, removeErasing, validDeleteOn } from '../../src/server/meeting.js';
import { applyOrganized, emptyBoard, ProjectOrganizes, scrubRecords } from '../../src/server/organize.js';
import { ORGANIZE_SCHEMA, ORGANIZE_SYSTEM_PROMPT, organizeOutputProblem } from '../../src/server/organize-ai.js';
import { findRecords } from '../../src/server/redact.js';
import { HARD_POINTS, POINTS, RECORD_POINT as SCRIPT_RECORD } from '../../scripts/check-organize.js';

// 会の始めとお客さんのデータ(src/server/meeting.js、docs/design/collaboration.md の 7 節、K4)。実モデルは呼ばない。
const PHONE = '090-0000-0000';
const RECORD_POINT = `先週、${PHONE} のお客さんから同じ荷物のことで 3 回電話があった`;

const boardWith = (texts) => ({ ...emptyBoard(), points: texts.map((text, index) => ({ n: index + 1, text, at: 'x' })), nextPoint: texts.length + 1 });

async function organizes(t, ai = { organize: async () => ({ items: [], toAsk: [] }), close: async () => {} }) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-meeting-unit-'));
  const organize = new ProjectOrganizes({ home, store: { requireProject: async () => ({}) }, ai, consent: { require() {} }, aiMode: () => 'real' });
  t.after(async () => {
    await organize.close();
    await fs.rm(home, { recursive: true, force: true });
  });
  return { organize, home, file: path.join(home, 'projects', 'p', '.studio', 'organize.json') };
}

test('記録らしいものの形: 電話番号の打ち方の違い、メールアドレス、住所、名乗り、フルネーム、長い番号', () => {
  for (const text of ['090-0000-0000', '09000000000', '090 0000 0000', '０９０－００００－００００', '０９０　００００　００００', '(03)1234-5678', '+81 90 0000 0000', '090ー0000ー0000', '090 - 0000 - 0000', 'TEL-090-0000-0000', '090-0000-0000-', '090/0000/0000', '090・0000・0000', '090\u200b0000\u200b0000']) {
    assert.deepEqual(findRecords(`先週 ${text} から電話`), ['電話番号'], text);
  }
  assert.deepEqual(findRecords('hanako@example.com に送る'), ['メールアドレス']);
  assert.ok(findRecords('お届け先は東京都みほん区かわせみ町12-3').includes('住所'));
  assert.ok(findRecords('お名前は山田太郎です').includes('氏名'));
  assert.ok(findRecords('山田太郎さんから電話があった').includes('氏名'));
  assert.ok(findRecords('山田 太郎様の荷物').includes('氏名'));
  assert.ok(findRecords('山田\n太郎さんの荷物').includes('氏名'));
  assert.ok(findRecords('田中太郎部長さんに聞く').includes('氏名'));
  assert.ok(findRecords('佐藤花子先生の話').includes('氏名'));
  assert.ok(findRecords('大学生の山田太郎と申します').includes('氏名'));
  assert.deepEqual(findRecords('カード 1234 5678 9012 3456'), ['長い番号']);
  assert.deepEqual(findRecords('荷物の番号は 123456789012 です'), ['長い番号']);
});

test('記録らしくないものは止めない: 架空の台本の要点、会に出た人の呼び名、役職、日付、数', () => {
  assert.ok(findRecords(SCRIPT_RECORD).length > 0);
  for (const text of [...POINTS, ...HARD_POINTS.filter((point) => point !== SCRIPT_RECORD), '宇田さん「電話の半分は再配達」', '野上さんが決める', '受付担当者さんに聞く', '業務部長さんの話', 'お客様の電話番号を聞いている', 'お名前と電話番号を聞く', '2026-11-02 までに決める', '2026-11-02 10 時に決める', '10-18 時の間に電話が 30 件', '料金は 1,200 円',
    '運送業者さんに渡す', '協力会社さんに頼む', '販売代理店様の分', 'お名前は受付で聞いている', 'お名前は必須です', '氏名は必須項目', 'あの紙を不在票といいます', '東京都新宿区の店舗で受け付ける', '三丁目の店まで']) {
    assert.deepEqual(findRecords(text), [], text);
  }
});

test('架空の電話番号を含む要点は、断り、板にもファイルにも残らない。ほかの要点は残る', async (t) => {
  const { organize, file } = await organizes(t);
  await organize.addPoint('p', { text: '不在票に荷物の番号がある' });
  await assert.rejects(organize.addPoint('p', { text: RECORD_POINT }), (error) => {
    assert.equal(error.code, 'record');
    assert.equal(error.status, 422);
    assert.ok(error.message.startsWith('電話番号らしいものは省きます。'));
    assert.doesNotMatch(error.message, /090/);
    return true;
  });
  const view = await organize.view('p');
  assert.deepEqual(view.points.map((point) => point.text), ['不在票に荷物の番号がある']);
  assert.doesNotMatch(await fs.readFile(file, 'utf8'), /090/);
  // 500 文字で切る前に見る
  await assert.rejects(organize.addPoint('p', { text: `${'あ'.repeat(495)}${PHONE}` }), { code: 'record' });
});

test('項目を足す口と直す口でも、記録らしいものを断る', async (t) => {
  const { organize } = await organizes(t);
  await organize.addItem('p', { column: 'data', text: '不在票の番号' });
  await assert.rejects(organize.addItem('p', { column: 'data', text: `${PHONE} に電話` }), { code: 'record' });
  await assert.rejects(organize.editItem('p', { id: 'i1', text: `${PHONE} に電話` }), { code: 'record' });
  const view = await organize.view('p');
  assert.deepEqual(view.items.map((item) => item.text), ['不在票の番号']);
  assert.equal(view.points.length, 1);
});

test('AI の返事: 記録らしい項目と聞くことは板の項目にならず、記録と言った要点を消して、知らせる', () => {
  const board = boardWith(['不在票に荷物の番号がある', '山本さんの荷物のこと']);
  const next = applyOrganized(board, {
    items: [
      { column: 'data', text: '不在票の番号', sources: [1] },
      { column: 'scene', text: `${PHONE} のお客さん`, sources: [1] },
      { column: 'scene', text: '山本さんの荷物', sources: [2] },
    ],
    toAsk: [{ kind: 'unasked', text: `${PHONE} に聞きますか`, sources: [] }, { kind: 'unasked', text: '時間帯は', sources: [] }],
    recordPoints: [2, 99],
  });
  assert.deepEqual(next.points.map((point) => point.n), [1]);
  // 記録があると言った要点を元にした項目は、番号を抜いた文でも作らない
  assert.deepEqual(next.items.map((item) => item.text), ['不在票の番号']);
  assert.deepEqual(next.asks.map((ask) => ask.text), ['時間帯は']);
  assert.ok(next.note.startsWith('個人の記録らしいものは省きます(3 件)'));
  assert.doesNotMatch(JSON.stringify(next), /090/);
});

test('AI の返事: 手で欄に置いた項目と、人が消したものの中の、記録があると言った要点と同じ文も消す', () => {
  const text = '佐藤はなこの家は坂の上にある';
  const board = { ...boardWith([text]), items: [{ id: 'i1', column: 'scene', text, sources: [1], by: 'person', held: true, checkedAt: null }], dismissed: { items: [text, '残す文'], asks: [] }, nextItem: 2 };
  const next = applyOrganized(board, { items: [], toAsk: [], recordPoints: [1] });
  assert.deepEqual(next.points, []);
  assert.deepEqual(next.items, []);
  assert.deepEqual(next.dismissed.items, ['残す文']);
  assert.ok(!JSON.stringify(next).includes('佐藤'));
});

test('全部の要点が記録のときの返事を受け、要点を消す。知らない番号だけなら受けない', async (t) => {
  const output = { items: [], toAsk: [], recordPoints: [1] };
  assert.equal(organizeOutputProblem(output, { needItems: true, known: new Set([1]) }), null);
  assert.equal(organizeOutputProblem(output, { needItems: true, known: new Set([2]) }), '使える項目がなかった');
  const { organize } = await organizes(t, { organize: async () => output, close: async () => {} });
  await organize.addPoint('p', { text: '佐藤はなこの家は坂の上にある' });
  const view = await organize.run('p');
  assert.deepEqual(view.points, []);
  assert.ok(view.note.startsWith('個人の記録らしいものは省きます(1 件)'));
});

test('AI の返事: 記録があると言った要点を元にしていた、人が決めた項目は残り、元の番号だけが消える', () => {
  const board = { ...boardWith(['山本さんの荷物のこと']), items: [{ id: 'i1', column: 'scene', text: '人が直した文', sources: [1], by: 'person', held: true, checkedAt: null }], nextItem: 2 };
  const next = applyOrganized(board, { items: [], toAsk: [], recordPoints: [1] });
  assert.deepEqual(next.points, []);
  assert.deepEqual(next.items.map((item) => [item.text, item.sources]), [['人が直した文', []]]);
});

test('AI の返事に記録がなければ、知らせない。recordPoints がない返事も受ける', () => {
  const next = applyOrganized(boardWith(['不在票に荷物の番号がある']), { items: [{ column: 'data', text: '不在票の番号', sources: [1] }], toAsk: [] });
  assert.equal(next.note, null);
  assert.equal(next.points.length, 1);
});

test('記録らしい項目しかない返事は、使える項目がないとする(板を空にしない)', () => {
  const output = { items: [{ column: 'data', text: `${PHONE} の人`, sources: [] }], toAsk: [] };
  assert.equal(organizeOutputProblem(output, { needItems: true }), '使える項目がなかった');
  assert.equal(organizeOutputProblem(output, { needItems: false }), null);
});

test('前の板の記録らしいものを、要点、項目、聞くこと、人が消したものから取り除く。起動のときにファイルも直す', async (t) => {
  const board = {
    ...boardWith(['不在票に荷物の番号がある', RECORD_POINT]),
    items: [
      { id: 'i1', column: 'data', text: '不在票の番号', sources: [1, 2], by: 'ai', held: false, checkedAt: null },
      { id: 'i2', column: 'scene', text: `${PHONE} の電話`, sources: [2], by: 'ai', held: false, checkedAt: null },
    ],
    asks: [{ id: 'a1', kind: 'unasked', text: `${PHONE} は誰か`, sources: [] }],
    dismissed: { items: [`${PHONE} の項目`, '残す文'], asks: [] },
  };
  const scrubbed = scrubRecords(board);
  assert.deepEqual(scrubbed.points.map((point) => point.n), [1]);
  assert.deepEqual(scrubbed.items.map((item) => [item.id, item.sources]), [['i1', [1]]]);
  assert.deepEqual(scrubbed.asks, []);
  assert.deepEqual(scrubbed.dismissed.items, ['残す文']);
  assert.match(scrubbed.note, /個人の記録らしいものは省きます/);
  assert.doesNotMatch(JSON.stringify(scrubbed), /090/);
  // 何もなければ同じ板
  const clean = boardWith(['不在票に荷物の番号がある']);
  assert.equal(scrubRecords(clean), clean);
});

test('指示: 記録のある要点の例外、例外を聞くこと、決まりと希望のぶつかりがある。仕込んだ穴そのものは書かない', () => {
  assert.match(ORGANIZE_SYSTEM_PROMPT, /項目の元にしなくてよいのは、下の記録のある要点だけ/);
  assert.doesNotMatch(ORGANIZE_SYSTEM_PROMPT, /1 つも落とさず/);
  assert.match(ORGANIZE_SYSTEM_PROMPT, /recordPoints/);
  assert.match(ORGANIZE_SYSTEM_PROMPT, /書類やデータがないとき、忘れたとき、間違えたとき/);
  assert.match(ORGANIZE_SYSTEM_PROMPT, /決まりと希望がぶつかるとき/);
  assert.doesNotMatch(ORGANIZE_SYSTEM_PROMPT, /荷物|不在票/);
  assert.ok(ORGANIZE_SCHEMA.required.includes('recordPoints'));
  assert.ok(ORGANIZE_SCHEMA.properties.recordPoints);
});

test('消す日: 既定は 30 日後。形と過去の日を断る。過ぎたかは手元の日付で比べる', () => {
  assert.equal(defaultDeleteOn(new Date(2026, 10, 2)), '2026-12-02');
  assert.equal(validDeleteOn('2026-11-02', '2026-11-02'), '2026-11-02');
  for (const bad of ['2026-11-01', '2026-13-01', '2026-02-30', '明日', '', null, 20261201]) {
    assert.throws(() => validDeleteOn(bad, '2026-11-02'), { code: 'invalid' }, String(bad));
  }
  assert.equal(isOverdue({ deleteOn: '2026-11-01' }, '2026-11-02'), true);
  assert.equal(isOverdue({ deleteOn: '2026-11-02' }, '2026-11-02'), false);
  assert.equal(localDate(new Date(2026, 0, 5)), '2026-01-05');
});

test('同意の前はどの AI も呼ばない。お試しだけの会は外の AI に送らない。会ではない試作品は今までどおり', () => {
  const meetings = new ProjectMeetings({ home: os.tmpdir(), store: {}, consent: {} });
  meetings.records.set('w', { status: 'waiting' });
  meetings.records.set('t', { status: 'trial' });
  meetings.records.set('a', { status: 'agreed' });
  const table = [['w', 'real', false], ['w', 'fake', false], ['t', 'real', false], ['t', 'fake', true], ['a', 'real', true], ['a', 'fake', true], ['x', 'real', true]];
  for (const [id, mode, allowed] of table) {
    assert.equal(meetings.mayCall(id, mode), allowed, `${id} ${mode}`);
    if (allowed) meetings.require(id, mode);
    else assert.throws(() => meetings.require(id, mode), MeetingRefusedError, `${id} ${mode}`);
  }
  assert.throws(() => meetings.requireDecided('w'), { code: 'meeting-consent-required' });
  assert.throws(() => meetings.require('t', 'real'), { code: 'meeting-trial' });
  meetings.requireDecided('t');
});

test('消している途中で止まった置き場は、起動のときに消す。ほかは触らない', async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-meeting-unit-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  await fs.mkdir(path.join(home, 'projects', '.erasing-meeting-1-0a1b2c3d', 'app'), { recursive: true });
  await fs.mkdir(path.join(home, 'projects', 'idea-1', 'app'), { recursive: true });
  // 途中で止まった試作品の書き出しも消す。ID の頭が同じ別の試作品の書き出しは消さない
  for (const name of ['meeting-1-20261102-141411', '.meeting-1-20261102-141412.tmp', 'meeting-1-2-20261102-141411', 'idea-1-20261102-141411']) await fs.mkdir(path.join(home, 'handoffs', name), { recursive: true });
  await removeErasing(home);
  assert.deepEqual(await fs.readdir(path.join(home, 'projects')), ['idea-1']);
  assert.deepEqual((await fs.readdir(path.join(home, 'handoffs'))).sort(), ['idea-1-20261102-141411', 'meeting-1-2-20261102-141411']);
});
