import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildApp } from '../../src/server/build.js';
import { STUDIO_ROOT } from '../../src/server/config.js';
import { fixedDataOptions } from '../../src/server/data-design.js';
import { RAG_OPTIONS, judgeRag, ragEvidenceOf, renderShelfSection, shelfFromApp, shelfFromDataDesign, shelfProblems } from '../../src/server/data-shelf.js';

// データの棚と RAG の判定(docs/design/ai-architecture-review.md の 1 節「データと RAG」、task 421)。データはすべて架空

const item = (fields = {}) => ({ id: 'parcels', name: '荷物の表', shape: 'table', read: 'tool', change: 'minutes', personal: true, personalKinds: ['氏名'], prototype: '架空の 10 件', source: 'app', ...fields });

test('棚の形の検査: 決まった語だけ、id は重ならない、RAG で読めるのは長い文書だけ', () => {
  assert.deepEqual(shelfProblems([item(), item({ id: 'terms', name: '約款', shape: 'document', read: 'rag', change: 'rarely', personal: false, personalKinds: undefined })]), []);
  assert.deepEqual(shelfProblems([]), []);
  assert.deepEqual(shelfProblems({}), ['棚は配列にしてください']);
  const problems = shelfProblems([
    item({ shape: 'video' }),
    item({ read: 'rag' }),
    item({ id: 'b', change: 'often', personal: 'yes' }),
    item({ id: 'c', personal: false }),
    item({ id: 'd', name: '', prototype: '', extra: 1 }),
  ]);
  const text = problems.join('\n');
  assert.match(text, /棚の 1 番目: 形は table、rules、document のどれか/);
  assert.match(text, /棚の 2 番目: id「parcels」が重なっています/);
  assert.match(text, /棚の 2 番目: RAG で読めるのは長い文書だけです/);
  assert.match(text, /棚の 3 番目: 変わる速さは minutes、daily、rarely、unknown のどれか/);
  assert.match(text, /棚の 3 番目: 個人情報は true、false、null\(不明\)のどれか/);
  assert.match(text, /棚の 4 番目: 個人情報の種類を書くなら、個人情報は true にしてください/);
  assert.match(text, /棚の 5 番目: 「extra」は書けません/);
  assert.match(text, /棚の 5 番目: 名前は 60 文字までの文/);
  assert.match(text, /棚の 5 番目: 試作品での扱いは 100 文字までの文/);
});

test('データ設計の案と整理の板から下書きを作る: 表はツールで引き、決まりごとはプロンプトに入れ、約款は RAG の候補にする', () => {
  const board = [
    { id: 'i1', column: 'data', text: 'お客さんの名前と電話' },
    { id: 'i2', column: 'rule', text: '取り置きは 3 日まで' },
    { id: 'i3', column: 'rule', text: '閉店は 19 時' },
  ];
  const option = {
    entities: [
      { name: 'お店', fields: [{ name: '番号', kind: 'key' }, { name: 'お店の名前', kind: 'text' }] },
      { name: 'お客さん', fields: [{ name: '番号', kind: 'key' }, { name: '名前', kind: 'text' }, { name: '電話', kind: 'text' }] },
    ],
  };
  const shelf = shelfFromDataDesign(option, board);
  assert.deepEqual(shelfProblems(shelf), []);
  assert.deepEqual(shelf.map((s) => [s.name, s.shape, s.read, s.change, s.personal, s.personalKinds ?? null, s.source]), [
    ['お店', 'table', 'tool', 'unknown', null, null, 'data-design'],
    ['お客さん', 'table', 'tool', 'unknown', true, ['氏名', '電話番号'], 'data-design'],
    ['整理の板の決まりごと', 'rules', 'prompt', 'unknown', null, null, 'board'],
  ]);
  assert.equal(shelf[2].prototype, '決まりごと 2 つを、そのまま入れる');
  // 約款らしいデータの欄は、長い文書として RAG の候補になる
  const withTerms = shelfFromDataDesign(option, [...board, { id: 'i4', column: 'data', text: '貸し出しの約款' }]);
  assert.deepEqual(withTerms.at(-1), { id: 'document-1', name: '貸し出しの約款', shape: 'document', read: 'rag', change: 'unknown', personal: null, prototype: '架空の文書を、条や見出しごとに作る', source: 'board' });
  // 決まった案(K2)でも、棚の形の検査を通る
  for (const fixed of fixedDataOptions(board)) assert.deepEqual(shelfProblems(shelfFromDataDesign(fixed, board)), []);
});

test('RAG の判定: 短い決まりと表だけなら「要らない」。理由と足す条件を書き、問いは簡単な方から順に並ぶ', () => {
  const shelf = [item(), item({ id: 'rules', name: '決まりごと', shape: 'rules', read: 'prompt', personal: false, personalKinds: undefined })];
  const rag = judgeRag(shelf);
  assert.equal(rag.needed, false);
  assert.equal(rag.verdict, '要らない');
  assert.equal(rag.measured, false);
  assert.equal(rag.note, '今日の推測。まだ測っていない');
  assert.match(rag.reason, /AI が読むのは表と短い決まりだけ。表はツールで引ける。決まりは短いのでプロンプトに入れられる/);
  assert.equal(rag.addWhen, RAG_OPTIONS.addWhen);
  assert.equal(rag.decide, undefined);
  assert.deepEqual(rag.steps.map((step) => [step.order, step.read, step.items]), [[1, 'none', []], [2, 'tool', ['荷物の表']], [3, 'prompt', ['決まりごと']], [4, 'rag', []]]);
  // AI が読むデータがなくても「要らない」
  assert.equal(judgeRag([]).needed, false);
  // 判定の文に、使わない言葉を入れない(4 節)
  assert.doesNotMatch(JSON.stringify([rag, RAG_OPTIONS]), /理想の構成|最適|ベストプラクティス|最新の正解/);
});

test('RAG の判定: 長い文書があり、測っていなければ「まだ決めていない」。RAG なしで通らない場面があれば「要る」と場面の id を書く', () => {
  const shelf = [item(), item({ id: 'terms', name: '約款', shape: 'document', read: 'rag', personal: false, personalKinds: undefined })];
  const unmeasured = judgeRag(shelf);
  assert.equal(unmeasured.needed, null);
  assert.equal(unmeasured.verdict, 'まだ決めていない');
  assert.deepEqual(unmeasured.decide.map((d) => d.label), ['分割', '埋め込み', '置き場', '引用', '再現率の測り方']);
  const needed = judgeRag(shelf, { evidence: { failedWithout: ['a', 'b'], passedWith: ['a', 'b', 'c'] } });
  assert.deepEqual([needed.needed, needed.verdict, needed.evalIds, needed.measured], [true, '要る', ['a', 'b'], true]);
  const notNeeded = judgeRag(shelf, { evidence: { failedWithout: [], passedWith: ['a'] } });
  assert.deepEqual([notNeeded.needed, notNeeded.addWhen], [false, RAG_OPTIONS.addWhen]);
  const unhelped = judgeRag(shelf, { evidence: { failedWithout: ['a'], passedWith: [] } });
  assert.deepEqual([unhelped.needed, unhelped.evalIds], [null, ['a']]);
  const section = renderShelfSection({ shelf, rag: needed });
  assert.match(section, /\| 約款 \| 長い文書 \| RAG\(文書を探して読む\) \| 毎分 \| なし \| 架空の 10 件 \|/);
  assert.match(section, /- RAG: 要る\(お試しの AI で場面を回して比べた結果。形の確かめだけで、振る舞いの差は本物の AI で測る\)/);
  assert.equal(judgeRag(shelf, { evidence: { failedWithout: ['a'], passedWith: ['a'], connections: ['claude-code'] } }).note, '本物の AI で場面を回して比べた結果');
  assert.match(section, /- 根拠の場面: `a`、`b`/);
});

test('試作品のツールとデータから下書きを作る: 約款の見本は RAG、再配達の見本は表をツールで引くので「要らない」', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-shelf-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const shelfOf = async (sample) => {
    const built = await buildApp({ appDir: path.join(STUDIO_ROOT, 'samples', sample, 'app'), buildsDir: path.join(root, sample) });
    assert.ok(built.ok, JSON.stringify(built.errors));
    return shelfFromApp({ toolsets: built.simulation.tools, toolData: built.simulation.toolData, manifestData: built.manifest.data });
  };
  const terms = await shelfOf('terms-help');
  assert.deepEqual(shelfProblems(terms), []);
  assert.deepEqual(terms.map((s) => [s.name, s.shape, s.read, s.prototype]), [['架空の運送約款(条ごとに 1 件)', 'document', 'rag', '架空の文書 8 件']]);
  const parcels = await shelfOf('redelivery');
  assert.deepEqual(shelfProblems(parcels), []);
  assert.deepEqual(parcels.map((s) => [s.shape, s.read, s.personal, s.personalKinds]), [['table', 'tool', true, ['recipient']]]);
  assert.equal(judgeRag(parcels).verdict, '要らない');
});

test('場面の回しの結果から、RAG ありとなしの差を根拠に取り出す', () => {
  const scene = (id, verdict, checkVerdict) => ({ id, verdict, checks: [{ check: 'retrieved', verdict: checkVerdict }, { check: 'replyContains', verdict }] });
  const sceneWithout = (id, verdict) => ({ id, verdict, checks: [{ check: 'retrieved', verdict: 'n/a', reason: 'この構成には文書の検索がない' }, { check: 'replyContains', verdict }] });
  const result = {
    finishedAt: '2026-11-07T00:00:00Z',
    options: { connections: ['mock'] },
    groups: [
      { evals: [scene('a', 'passed', 'passed'), scene('b', 'passed', 'passed'), { id: 'other', verdict: 'passed', checks: [{ check: 'noToolCall', verdict: 'passed' }] }] },
      { evals: [sceneWithout('a', 'failed'), sceneWithout('b', 'passed'), { id: 'other', verdict: 'failed', checks: [{ check: 'noToolCall', verdict: 'failed' }] }] },
    ],
  };
  assert.deepEqual(ragEvidenceOf(result), { failedWithout: ['a'], passedWith: ['a', 'b'], measuredAt: '2026-11-07T00:00:00Z', connections: ['mock'] });
  // n/a の理由が「文書の検索がない」でなければ(接続の only など)、RAG なしの組に数えない
  const onlyReal = { ...result, groups: [result.groups[0], { evals: [{ id: 'a', verdict: 'failed', checks: [{ check: 'retrieved', verdict: 'n/a', reason: '実モデルの回しでだけ見る確かめ' }] }] }] };
  assert.equal(ragEvidenceOf(onlyReal), null);
  // 片方しか回していなければ、根拠にしない
  assert.equal(ragEvidenceOf({ groups: [result.groups[0]] }), null);
});
