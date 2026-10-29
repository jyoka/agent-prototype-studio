import assert from 'node:assert/strict';
import test from 'node:test';
import { compareTableHtml, dropColumns, readTable } from '../../scripts/media/compare-table.js';
import { toTicks } from '../../scripts/media/encode.js';
import { findLeaks, findLeaksInBytes } from '../../scripts/media/privacy.js';

// npm run media の部品(CONTRIBUTING.md の「画像と動く画像を撮り直す」)。ブラウザと ffmpeg は使わない

const OPTIONS = { paths: ['/Users/mihon/studio-work'], user: 'mihon' };

test('写してはいけないもの: 日付、作業ディレクトリ、メールアドレスを見つける', () => {
  const kinds = (text) => findLeaks(text, OPTIONS).map((leak) => leak.kind);
  assert.deepEqual(kinds('保存しました(2026/10/29 15:04:05)'), ['日付']);
  assert.deepEqual(kinds('回しの ID 20261029-151230-44c79e'), ['日付']);
  assert.deepEqual(kinds('2026年10月29日に回しました'), ['日付', '日付']);
  assert.deepEqual(kinds('10月29日'), ['日付']);
  assert.deepEqual(kinds('連絡は sample@example.com へ'), ['メールアドレス']);
  assert.deepEqual(kinds('置き場所: /Users/mihon/studio-work/projects'), ['作業ディレクトリ', '作業ディレクトリ', '利用者の名前']);
  assert.deepEqual(kinds('/var/folders/ab/T/prototype-studio-e2e-1'), ['作業ディレクトリ']);
  assert.deepEqual(kinds('C:\\Users\\someone\\PrototypeStudio'), ['作業ディレクトリ']);
  assert.deepEqual(kinds('mihon さんの画面'), ['利用者の名前']);
});

test('写してよいもの: 時刻、時給、指紋、架空の会話は当たらない', () => {
  const text = [
    '15:16:01 発言 → モック(AI モデルは呼んでいません)',
    '終わりました、0.2 秒',
    'みなと町・時給 1100 円・土日',
    '指紋 sha256:9b0bfedb080b…',
    '35(n/a 9) 81/81 0.0000',
    '記録「consent」がありません',
  ].join('\n');
  assert.deepEqual(findLeaks(text, OPTIONS), []);
});

test('ファイルの中身は、決まった文字(今日の日付、パス、名前、メールアドレス)だけを調べる', () => {
  const now = new Date(2026, 9, 29);
  const options = { ...OPTIONS, emails: ['mihon@example.com'], now };
  // 圧縮したデータに偶然できる、メールアドレスに似た並びは数えない
  assert.deepEqual(findLeaksInBytes(Buffer.from('\x89PNG B@O.Tf 1999-01-01'), options), []);
  const found = findLeaksInBytes(Buffer.from('creation_time=2026-10-29 by mihon@example.com in /Users/mihon/studio-work'), options);
  assert.deepEqual(
    found.map((leak) => leak.kind),
    ['日付', '作業ディレクトリ', 'メールアドレス', '利用者の名前'],
  );
});

const REPORT = `# 構成ごとの比べる表

## 回し

| 回しの ID | 状態 |
|---|---|
| \`20261029-151725-d15a65\` | 終わった |

## 比べる表(4.3)

| 構成 / 前提 | 接続 | 費用(USD) | 待ち時間の中央値(秒) |
|---|---|---|---|
| composition.json / partner-a | モック | 0.0000 | 0.2 |
| compositions/b.json | モック | 0.0000 | 0 |

## 点(4.4)

| 構成 / 前提 | 起動 |
|---|---|
| composition.json / partner-a | 0 |
`;

test('比べる表: report.md の節の表だけを読み、回すたびに変わる列を外す', () => {
  const table = dropColumns(readTable(REPORT, '比べる表'), ['待ち時間の中央値(秒)']);
  assert.deepEqual(table, {
    head: ['構成 / 前提', '接続', '費用(USD)'],
    rows: [
      ['composition.json / partner-a', 'モック', '0.0000'],
      ['compositions/b.json', 'モック', '0.0000'],
    ],
  });
  assert.throws(() => readTable(REPORT, '危ない場面'), /「危ない場面」の節がありません/);
});

test('比べる表の HTML: 文字を逃がし、外から何も読み込まない。回しの ID と日時を入れない', () => {
  const html = compareTableHtml(
    { head: ['構成 / 前提', '接続'], rows: [['<b>x</b>', 'モック']] },
    { title: '場面を回した比べる表', lead: '見本の結果', tokensCss: ':root { --bg: #f6f6f4; }' },
  );
  assert.match(html, /<th scope="row">&lt;b&gt;x&lt;\/b&gt;<\/th>/);
  assert.match(html, /--bg: #f6f6f4/);
  assert.doesNotMatch(html, /https?:|@import|url\(|<script|<link/);
  assert.deepEqual(findLeaks(compareTableHtml(dropColumns(readTable(REPORT, '比べる表'), []), { title: 't', lead: 'l', tokensCss: '' }), OPTIONS), []);
});

test('動く画像のコマ: 受け取ったコマを 25 刻みに並べ直し、全体の長さを変えない', () => {
  const frames = [
    { file: 'a', at: 100 },
    { file: 'b', at: 100.5 },
    // 1 刻みより短いコマは、次のコマに飲まれる
    { file: 'c', at: 100.51 },
    { file: 'd', at: 101 },
  ];
  const ticks = toTicks(frames, 103);
  assert.deepEqual(ticks.map((t) => t.file), ['a', 'c', 'd']);
  assert.deepEqual(ticks.map((t) => t.seconds), [0.52, 0.48, 2]);
  assert.equal(ticks.reduce((sum, t) => sum + t.seconds, 0).toFixed(3), '3.000');
});
