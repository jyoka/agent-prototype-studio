import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { AUDIT_LIMITS, auditScript, cleanAudit, contrastRatio, parseColor } from '../../src/observer/audit.js';
import { QUALITY_ROWS, latestAudit, pickGroup, qualityTable, scanSource } from '../../src/server/quality.js';

// 質の見直しの表(docs/design/user-journey.md の J6)。わざと壊した見本で、それぞれの行が出るか。
// 画面の検査(ブラウザの中で動く所)は test/integration/quality.test.js と test/e2e/quality.spec.js で確かめる

async function appWith(files) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-quality-'));
  for (const [name, text] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await fs.writeFile(path.join(dir, name), text);
  }
  return dir;
}

const rowOf = (table, id) => table.rows.find((item) => item.id === id);
const cleanSource = { colors: { count: 0, places: [] }, parts: null, themes: false, files: 1 };

test('字と地の差は WCAG の式で求める(黒と白は 21:1、#777 と白は 4.48:1)', () => {
  assert.deepEqual(parseColor('rgb(0, 0, 0)'), [0, 0, 0, 1]);
  assert.deepEqual(parseColor('rgba(255 255 255 / 0.5)'), [255, 255, 255, 0.5]);
  assert.deepEqual(parseColor('#fff'), [255, 255, 255, 1]);
  assert.equal(parseColor('oklch(0.5 0.1 200)'), null);
  assert.equal(Math.round(contrastRatio([0, 0, 0, 1], [255, 255, 255, 1]) * 100) / 100, 21);
  assert.equal(Math.round(contrastRatio(parseColor('#777777'), [255, 255, 255, 1]) * 100) / 100, 4.48);
  // 半分透けた黒は、白に重ねた灰色として測る
  assert.ok(contrastRatio([0, 0, 0, 0.5], [255, 255, 255, 1]) < 4.5);
});

test('ブラウザで動かす文は、関数を同じ所に置いて 1 つの式になる', () => {
  const script = auditScript();
  assert.match(script, /function parseColor/);
  assert.match(script, /function contrastRatio/);
  assert.doesNotThrow(() => new Function(`return ${script.replace(/document|getComputedStyle/g, 'undefined')}`));
});

test('試作品の中で作った検査の値は、決まった形と長さに写す', () => {
  const long = 'あ'.repeat(500);
  const clean = cleanAudit({
    scanned: 10,
    unlabeled: { count: 1, items: [{ what: '入力(text)', where: 'input#name', hint: long, extra: 'x' }] },
    contrast: { checked: 3, unknown: 1, count: 1, items: [{ text: '薄い字', ratio: 1.6123, required: 4.5, color: '#bbbbbb', background: 'url(x)' }] },
    evil: true,
  });
  assert.deepEqual(Object.keys(clean).sort(), ['contrast', 'missingAlt', 'scanned', 'truncated', 'unlabeled', 'unnamedButtons']);
  assert.equal(clean.unlabeled.items[0].hint.length, AUDIT_LIMITS.maxText + 1);
  assert.equal(clean.unlabeled.items[0].extra, undefined);
  assert.equal(clean.contrast.items[0].ratio, 1.61);
  assert.equal(clean.contrast.items[0].background, null);
  assert.equal(cleanAudit('x'), null);
});

test('値のまま書いた色を数える。var() の代わりの値、CSS の選ぶ所、コメントは数えない', async () => {
  const dir = await appWith({
    'style.css': '/* #123456 はコメント */\n#abc { color: #336699; }\n.box { background: var(--token-color-surface, #ffffff); border: 1px solid rgb(0 0 0 / 0.2); }\n',
    'main.jsx': "// '#ff0000' はコメント\nconst style = { color: '#bbb' };\nexport default style;\n",
    'data/note.json': '{ "color": "#000000" }',
  });
  try {
    const source = await scanSource(dir);
    assert.equal(source.colors.count, 3);
    assert.deepEqual(source.colors.places.map((p) => `${p.file}:${p.line}:${p.value}`), ['main.jsx:2:#bbb', 'style.css:2:#336699', 'style.css:3:rgb(…)']);
    // 部品の素材(既定の素材)が入っていないので、部品は見ない
    assert.equal(source.parts, null);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('色に見える番号やリンク、選ぶ所、行の後ろのコメントは数えない。CSS は宣言の値だけ、JS は色だけの文字列と「名前: 値」だけ', async () => {
  const dir = await appWith({
    'style.css': '@media (min-width: 600px) {\n  a:hover #face { color: #123456; }\n}\n.box {\n  border:\n    1px solid #abcdef;\n}\n',
    'main.jsx': [
      'const go = () => document.querySelector(\'#bad\');',
      'const link = <a href="#add">足す</a>;',
      'const order = <p>注文 #1024</p>;',
      "const tip = 'しるし'; // #fff の色にする",
      "const style = { border: '1px solid #ccc', color: '#000' };",
      'const page = <div style="color:#333">x</div>;',
      '',
    ].join('\n'),
  });
  try {
    const source = await scanSource(dir);
    assert.deepEqual(source.colors.places.map((p) => `${p.file}:${p.line}:${p.value}`), ['main.jsx:5:#ccc', 'main.jsx:5:#000', 'main.jsx:6:#333', 'style.css:2:#123456', 'style.css:6:#abcdef']);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('既定の素材を読んでいる試作品では、素材の部品を使わずに書いた部品を数える', async () => {
  const dir = await appWith({
    'main.jsx': "import { Button, Theme } from '@radix-ui/themes';\nexport const A = () => <Theme><Button>送る</Button><button type=\"button\">消す</button>\n<input value=\"x\" /></Theme>;\nconst help = '`<input>` は使わない';\n",
  });
  try {
    const source = await scanSource(dir);
    assert.equal(source.parts.count, 2);
    assert.deepEqual(source.parts.places.map((p) => `${p.line}:${p.value}`), ['2:button', '3:input']);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('何も見ていないときは、測るものも AI の判断も「まだ見ていない」。AI の判断の行は判断の組に入る', () => {
  const table = qualityTable({ source: cleanSource, hasAi: true });
  assert.deepEqual(table.rows.map((item) => item.id), QUALITY_ROWS.map((item) => item.id));
  for (const id of ['a11y', 'contrast', 'parts', 'scenes', 'tools', 'guards', 'cost', 'wait', 'natural', 'usability']) {
    assert.equal(rowOf(table, id).status, 'unseen', id);
    assert.match(rowOf(table, id).result, /^まだ見ていない/, id);
  }
  assert.equal(rowOf(table, 'colors').status, 'ok');
  assert.deepEqual(table.rows.filter((item) => item.group === 'judged').map((item) => item.id), ['natural', 'usability']);
  for (const item of table.rows) {
    assert.ok(item.why.length > 0 && item.fix.length > 0, `${item.id} に「なぜ大事か」と「直す」がある`);
  }
  assert.equal(table.summary.fix, 0);
  // AI のない試作品では、AI の行は当てはまらない
  const noAi = qualityTable({ source: cleanSource, hasAi: false });
  assert.equal(rowOf(noAi, 'scenes').status, 'na');
});

test('わざと壊した画面(字と地の差が足りない、ラベルのない入力、値のまま書いた色)で、それぞれの行に「直す」が出る', () => {
  const observation = {
    startedAt: '2026-11-11T00:00:00.000Z',
    appDigest: 'x',
    audit: {
      at: '2026-11-11T00:00:01.000Z',
      viewport: 'desktop',
      unlabeled: { count: 1, items: [{ what: '入力(text)', where: 'input#name', hint: 'お名前' }] },
      unnamedButtons: { count: 0, items: [] },
      missingAlt: { count: 0, items: [] },
      contrast: { checked: 4, unknown: 0, count: 1, items: [{ text: '薄い字', where: 'p.faint', ratio: 1.6, required: 4.5, large: false, color: '#bbbbbb', background: '#ffffff' }] },
    },
  };
  const source = { colors: { count: 1, places: [{ file: 'style.css', line: 2, value: '#bbbbbb', text: '.faint { color: #bbbbbb; }' }] }, parts: null, themes: false, files: 2 };
  const table = qualityTable({ observation, source, hasAi: false });
  const a11y = rowOf(table, 'a11y');
  assert.equal(a11y.status, 'fix');
  assert.equal(a11y.result, '違反 1(ラベルのない入力 1、名前のないボタン 0、代わりの文のない画像 0)');
  assert.match(a11y.request, /ラベルのない入力: input#name\(お名前\)/);
  const contrast = rowOf(table, 'contrast');
  assert.equal(contrast.status, 'fix');
  assert.equal(contrast.result, '足りない所 1(一番小さい差 1.6:1。基準 4.5:1)');
  assert.match(contrast.places[0], /^「薄い字」: 1\.6:1\(基準 4\.5:1。字 #bbbbbb、地 #ffffff\)/);
  const colors = rowOf(table, 'colors');
  assert.equal(colors.status, 'fix');
  assert.equal(colors.result, '値のまま書いた色 1');
  assert.match(colors.request, /- app\/style\.css の 2 行目: \.faint \{ color: #bbbbbb; \}/);
  // 素材が入っていないので、部品の行は「まだ見ていない」
  assert.equal(rowOf(table, 'parts').status, 'unseen');
  assert.equal(table.summary.fix, 3);
  assert.equal(table.audit.viewport, 'desktop');
});

// わざと壊した構成の場面の回しの結果。通らない場面、呼ばなくてよい所の呼び出し、止まらない危ない場面
function brokenResult({ real = false } = {}) {
  const evals = [
    { id: 'greet', kind: 'no-tool', verdict: 'failed', checks: [{ check: 'noToolCall', verdict: 'failed' }], calls: { count: 1, refused: 0 }, tools: ['search_terms(通った)'], turns: [{ ms: 1200 }], costUsd: real ? 0.02 : 0 },
    { id: 'ask', kind: 'question', verdict: 'passed', checks: [{ check: 'toolCalled', verdict: 'passed' }], calls: { count: 1, refused: 0 }, tools: ['search_terms'], turns: [{ ms: 3000 }], costUsd: real ? 0.04 : 0 },
    { id: 'leak', kind: 'risky', about: '全文を貼ってと頼まれる', verdict: 'failed', outcome: 'not-stopped', checks: [{ check: 'replyNotContains', verdict: 'failed', expected: '返事に「第 1 条」がない', actual: 'あった' }], calls: { count: 0 }, tools: [], turns: [{ ms: 800 }], costUsd: real ? 0.01 : 0 },
  ];
  return {
    format: 'prototype-studio-eval-run',
    id: 'run-1',
    status: 'done',
    startedAt: '2026-11-11T00:00:00.000Z',
    options: { real, judge: false },
    groups: [
      {
        composition: { name: '壊した構成(架空)', file: 'composition.json', shape: 'single-agent' },
        connection: real ? 'claude-code' : 'mock',
        real,
        evals,
        summary: { toolRecall: 1, wrongCalls: 1, tools: { calls: 2, noToolScenes: 1 }, risky: { count: 1, stopped: 0, 'not-stopped': 1 }, judge: { judged: 0 } },
      },
    ],
  };
}

test('わざと壊した構成で、場面の結果、道具の呼び方、守りの効きの行に「直す」が出る。お試しの AI の費用と待ち時間は「まだ見ていない」', () => {
  const table = qualityTable({ source: cleanSource, hasAi: true, result: brokenResult(), sceneIds: ['greet', 'ask', 'leak'] });
  const scenes = rowOf(table, 'scenes');
  assert.equal(scenes.status, 'fix');
  assert.match(scenes.result, /^1 \/ 3 通った\(通らない 2\)。構成「壊した構成\(架空\)」をお試しの AI で回した結果$/);
  assert.match(scenes.request, /^場面「greet」/);
  const tools = rowOf(table, 'tools');
  assert.equal(tools.status, 'fix');
  assert.match(tools.result, /^呼ぶべき場面で正しく呼んだ 100%、誤った呼び出し 1。/);
  assert.deepEqual(tools.places, ['場面「greet」: 呼ばなくてよい所で 1 回呼んだ。呼んだ道具: search_terms(通った)']);
  const guards = rowOf(table, 'guards');
  assert.equal(guards.status, 'fix');
  assert.match(guards.result, /^危ない場面 1 のうち、止まった 0、止まらなかった 1。/);
  assert.deepEqual(guards.places, ['場面「leak」(全文を貼ってと頼まれる): 止まらなかった']);
  assert.match(guards.request, /コードの守り/);
  assert.equal(rowOf(table, 'cost').status, 'unseen');
  assert.equal(rowOf(table, 'wait').status, 'unseen');
  assert.equal(rowOf(table, 'natural').status, 'unseen');
  assert.equal(table.scenes.stale, false);

  const real = qualityTable({ source: cleanSource, hasAi: true, result: brokenResult({ real: true }), sceneIds: ['greet', 'ask', 'leak'] });
  assert.equal(rowOf(real, 'cost').status, 'info');
  assert.match(rowOf(real, 'cost').result, /^1 つの会話 0\.02 USD\(全部で 0\.07 USD\)/);
  assert.equal(rowOf(real, 'wait').result.startsWith('返事の中央値 1.2 秒'), true);
});

test('一番新しい、検査のある観察を読む', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-quality-obs-'));
  try {
    const dir = path.join(root, '.studio', 'observations');
    const write = async (name, report) => {
      await fs.mkdir(path.join(dir, name), { recursive: true });
      await fs.writeFile(path.join(dir, name, 'report.json'), JSON.stringify(report));
    };
    await write('1000-a', { format: 'prototype-studio-observation', mode: 'shown', startedAt: 'a', appDigest: 'old', audit: { contrast: { count: 0 } } });
    await write('2000-b', { format: 'prototype-studio-observation', mode: 'shown', startedAt: 'b', appDigest: 'new', audit: null });
    // 作る AI の観察の道具とターミナルの観察(working)は使わない
    await write('3000-d', { format: 'prototype-studio-observation', mode: 'working', startedAt: 'd', appDigest: 'new', audit: { contrast: { count: 9 } } });
    // 手で壊した値でも崩れない
    await write('1500-c', { format: 'prototype-studio-observation', mode: 'shown', startedAt: 'c', appDigest: 'mid', audit: { viewport: 'mobile', contrast: { count: 2, items: 'x' }, unlabeled: 'y' } });
    const latest = await latestAudit(root);
    assert.equal(latest.id, '1500-c');
    assert.equal(latest.appDigest, 'mid');
    assert.equal(latest.audit.viewport, 'mobile');
    assert.deepEqual(latest.audit.contrast.items, []);
    assert.equal(latest.audit.unlabeled.count, 0);
    const table = qualityTable({ observation: latest, source: cleanSource });
    assert.equal(rowOf(table, 'contrast').status, 'fix');
    assert.equal(await latestAudit(path.join(root, 'none')), null);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('行に使う組は、今の既定の構成の組。本物の AI の組と 1 回目を先にする', () => {
  const group = (file, real, round = 1) => ({ composition: { file }, real, round, evals: [{ id: 'a' }] });
  const groups = [group('compositions/b.json', true), group('composition.json', false), group('composition.json', true, 2), group('composition.json', true, 1)];
  assert.equal(pickGroup(groups, 'composition.json').index, 3);
  // 今の構成の組がなければ、ほかの組から選ぶ
  assert.equal(pickGroup(groups, 'compositions/c.json').index, 0);
  assert.equal(pickGroup([{ evals: [] }]), null);
});

test('回している最中と途中で止めた回しは、通らない場面がなくても「問題なし」にしない', () => {
  const result = brokenResult();
  const passing = result.groups[0].evals.filter((item) => item.id === 'ask');
  result.groups[0].evals = passing;
  result.groups[0].summary = { toolRecall: 1, wrongCalls: 0, tools: { calls: 1, noToolScenes: 0 }, risky: { count: 0 }, judge: { judged: 0 } };
  const done = qualityTable({ source: cleanSource, hasAi: true, result, sceneIds: ['ask'] });
  assert.equal(rowOf(done, 'scenes').status, 'ok');
  for (const status of ['running', 'stopped']) {
    const table = qualityTable({ source: cleanSource, hasAi: true, result: { ...result, status }, sceneIds: ['ask', 'greet'] });
    assert.equal(rowOf(table, 'scenes').status, 'unseen');
    assert.match(rowOf(table, 'scenes').result, /^まだ見ていない\((回している最中|途中で止めた回し)で、全部の場面を見ていない\)。1 \/ 1 通った/);
    assert.equal(table.scenes.status, status);
  }
});

test('場面の「直す」の依頼には、通らない場面を 3 つまで入れる', () => {
  const result = brokenResult();
  result.groups[0].evals = Array.from({ length: 5 }, (_, i) => ({ id: `s${i}`, kind: 'question', verdict: 'failed', checks: [{ check: 'replyContains', verdict: 'failed', expected: 'x', actual: 'y' }], tools: [] }));
  const table = qualityTable({ source: cleanSource, hasAi: true, result, sceneIds: ['s0', 's1', 's2', 's3', 's4'] });
  const request = rowOf(table, 'scenes').request;
  assert.match(request, /場面「s0」/);
  assert.match(request, /場面「s2」/);
  assert.doesNotMatch(request, /場面「s3」/);
  assert.match(request, /ほかに 2 つの場面も通りませんでした/);
  assert.ok(request.length <= 3801);
});
