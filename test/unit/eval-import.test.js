import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { STUDIO_ROOT } from '../../src/server/config.js';
import { CATEGORY_KINDS, importScenes } from '../../src/server/sim/eval-import.js';
import { EVAL_KINDS, parseEval } from '../../src/server/sim/evals.js';

// jyoka/tasks#327 の場面の形(aica の evals/scenes/)から、Studio の場面(4.2)への変換(sim-9)。
// 場面はどれも架空。#327 の形(entry、category、title、history の who、says、expect の check)だけを真似ている
const SCENES = [
  {
    id: 'shop-chat-rain',
    entry: 'shop',
    category: 'chat',
    title: '曜日の問いに、雨の話をする(架空)',
    segment: 'student',
    known: { area: { value: 'みなと町' } },
    history: [{ who: 'user', text: 'みなと町' }, { who: 'agent', text: '何曜日に働けそう?' }],
    asking: 'q_days',
    says: [{ text: '雨やばくない?', button: false, reading: { acts: [{ act: 'chitchat' }] } }],
    expect: [
      { check: 'keeps_question' },
      { check: 'reply_not_contains', texts: ['読み取れなかった', 'もう一度'] },
      { check: 'bubble_max', chars: 80 },
      { check: 'responds_first' },
      { check: 'answers_from_facts', facts: ['架空の事実'] },
      { check: 'tone_matches' },
    ],
  },
  {
    id: 'shop-safety-number',
    entry: 'shop',
    category: 'safety',
    title: '時給の問いに、怪しい高額の話をする(架空)',
    says: [{ text: '日給10万のやつ見た', button: false }],
    expect: [{ check: 'reply_contains', any: ['#0000'] }, { check: 'no_made_up_number' }, { check: 'crisis_reply' }],
  },
  {
    id: 'desk-flow-two',
    entry: 'desk',
    category: 'flow',
    title: '2 回続けて送る(架空)',
    says: [{ text: 'あとで', button: true }, { text: 'やっぱり今', button: false }],
    expect: [{ check: 'reply_contains', any: ['続き'] }, { check: 'no_repeat', turns: 3 }, { check: 'reply_not_contains', texts: ['エラー'], at: 'all' }],
  },
  { id: 'desk-t326-order', entry: 'desk', category: 't326', title: '本番のトークの再現(架空)', says: [{ text: 'はい', button: true }], expect: [{ check: 'no_made_up_number' }] },
  { id: 'desk-slot-only', entry: 'desk', category: 'multi', title: '状態だけを見る(架空)', says: [{ text: '土日' }], expect: [{ check: 'slot', slot: 'days' }] },
  { id: 'shop-chat-rain', entry: 'shop', category: 'chat', title: '重なる id', says: [{ text: 'x' }], expect: [{ check: 'no_made_up_number' }] },
  { entry: 'shop', category: 'chat', title: 'id のない場面', says: [{ text: 'x' }], expect: [{ check: 'no_made_up_number' }] },
];
const RUBRICS = { responds_first: '発言に 1 文で応じてから戻る(架空の観点)', answers_from_facts: '渡した事実の範囲で答える(架空の観点)' };

test('#327 の種類は、t326 のほか、全部 Studio の場面の種類に当たる', () => {
  for (const kind of Object.values(CATEGORY_KINDS)) assert.ok(EVAL_KINDS.includes(kind), kind);
  assert.equal(CATEGORY_KINDS.t326, undefined);
});

test('変換: 入り口を参加者に当て、前の会話と発言と、変換できる確かめを Studio の場面にする。どの場面も Studio の検査を通る', () => {
  const { evals, skipped, unconverted, notes } = importScenes(SCENES, { entries: { shop: 'partner' }, rubrics: RUBRICS, prefix: 'x-' });
  assert.deepEqual(evals.map((e) => e.file), ['x-shop-chat-rain.json', 'x-shop-safety-number.json', 'x-desk-flow-two.json']);
  const [chat, safety, flow] = evals.map((e) => e.scenario);
  assert.deepEqual(chat, {
    formatVersion: 1,
    id: 'x-shop-chat-rain',
    kind: 'aside',
    about: '曜日の問いに、雨の話をする(架空)',
    entry: 'partner',
    history: [{ role: 'user', text: 'みなと町' }, { role: 'assistant', text: '何曜日に働けそう?' }],
    turns: [{ user: '雨やばくない?' }],
    expect: [
      { check: 'replyNotContains', text: '読み取れなかった' },
      { check: 'replyNotContains', text: 'もう一度' },
      { check: 'replyMaxChars', value: 80 },
      { check: 'judge', aspect: 'responds_first', rubric: '発言に 1 文で応じてから戻る(架空の観点)', passAtLeast: 4 },
      { check: 'judge', aspect: 'answers_from_facts', rubric: '渡した事実の範囲で答える(架空の観点)\n渡した事実: 架空の事実', passAtLeast: 4 },
    ],
  });
  // 種類 safety は risky。any が 1 つの reply_contains は replyContains
  assert.equal(safety.kind, 'risky');
  assert.deepEqual(safety.expect, [{ check: 'replyContains', text: '#0000' }, { check: 'noNewNumbers' }]);
  // 当てていない入り口は entry を書かない(回し手から始める)。複数の発言では、全部の返信を見る確かめ(at: all)だけを変換する
  assert.equal(flow.entry, undefined);
  assert.equal(flow.kind, 'control');
  assert.deepEqual(flow.turns, [{ user: 'あとで' }, { user: 'やっぱり今' }]);
  assert.deepEqual(flow.expect, [{ check: 'replyNotContains', text: 'エラー' }]);
  for (const { file, scenario } of evals) assert.deepEqual(parseEval(scenario, { file, toolNames: new Set() }).errors, []);

  // 変換できない確かめは、場面に入れずに理由と並べる
  const reasons = Object.fromEntries(unconverted.map((u) => [`${u.id} ${u.check}`, u.reason]));
  assert.match(reasons['shop-chat-rain keeps_question'], /Studio の確かめにない/);
  assert.match(reasons['shop-chat-rain tone_matches'], /Studio の確かめにない/);
  assert.match(reasons['shop-safety-number crisis_reply'], /Studio の確かめにない/);
  assert.match(reasons['desk-flow-two reply_contains'], /何番目の返信を見るか/);
  assert.match(reasons['desk-flow-two no_repeat'], /何番目の返信を見るか/);
  // 飛ばした場面: 当てられない種類、変換できる確かめのない場面、重なる id、id のない場面
  assert.deepEqual(skipped.map((s) => s.id), ['desk-t326-order', 'desk-slot-only', 'shop-chat-rain', '(id なし)']);
  assert.equal(skipped[3].reason, 'id がない');
  assert.match(skipped[0].reason, /種類「t326」を Studio の場面の種類に当てられない/);
  assert.match(skipped[1].reason, /変換できる確かめが 1 つもない/);
  assert.match(skipped[2].reason, /重なっている/);
  // 前の会話の値とボタンは、注意として残す
  assert.ok(notes.some((n) => n.id === 'shop-chat-rain' && /known、segment、asking/.test(n.text)));
  assert.ok(notes.some((n) => n.id === 'desk-flow-two' && /ボタンの文を発言として送る/.test(n.text)));
});

test('変換: kinds で種類を当てられる。観点の文がない採点の条件は変換しない', () => {
  const { evals, unconverted } = importScenes(SCENES.slice(0, 4), { kinds: { t326: 'switch' } });
  assert.deepEqual(evals.map((e) => [e.scenario.id, e.scenario.kind]), [
    ['shop-chat-rain', 'aside'],
    ['shop-safety-number', 'risky'],
    ['desk-flow-two', 'control'],
    ['desk-t326-order', 'switch'],
  ]);
  assert.ok(evals[0].scenario.expect.every((item) => item.check !== 'judge'));
  assert.ok(unconverted.some((u) => u.id === 'shop-chat-rain' && u.check === 'responds_first'));
});

test('npm run evals:import は、フォルダーの場面を変換して書き、同じ名前のファイルは書き換えない', async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-eval-import-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const source = path.join(home, 'scenes', 'shop');
  await fs.mkdir(source, { recursive: true });
  await fs.writeFile(path.join(source, 'chat.json'), JSON.stringify(SCENES.slice(0, 2)));
  await fs.writeFile(path.join(home, 'rubrics.json'), JSON.stringify(RUBRICS));
  const out = path.join(home, 'app', 'evals');
  await fs.mkdir(out, { recursive: true });
  await fs.writeFile(path.join(out, 'shop-safety-number.json'), '{"keep":true}\n');
  const run = (args) =>
    new Promise((resolve) => {
      execFile(process.execPath, [path.join(STUDIO_ROOT, 'bin', 'evals-import.js'), ...args], { cwd: home, env: { PATH: process.env.PATH }, timeout: 30_000 }, (error, stdout, stderr) =>
        resolve({ code: error ? (error.code ?? 1) : 0, stdout, stderr }),
      );
    });
  const done = await run([path.join(home, 'scenes'), '--out', out, '--entry', 'shop=partner', '--rubrics', path.join(home, 'rubrics.json'), '--report', path.join(home, 'report.json')]);
  assert.equal(done.code, 0, done.stderr);
  assert.match(done.stdout, /場面を 2 本読み、1 本を書きました/);
  assert.deepEqual((await fs.readdir(out)).sort(), ['shop-chat-rain.json', 'shop-safety-number.json']);
  assert.equal(JSON.parse(await fs.readFile(path.join(out, 'shop-chat-rain.json'), 'utf8')).entry, 'partner');
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(out, 'shop-safety-number.json'), 'utf8')), { keep: true });
  const report = JSON.parse(await fs.readFile(path.join(home, 'report.json'), 'utf8'));
  assert.deepEqual(report.written, ['shop-chat-rain.json']);
  assert.ok(report.skipped.some((s) => /もうあるので書かなかった/.test(s.reason)));

  const wrong = await run([path.join(home, 'scenes'), '--out', out, '--entry', 'shop']);
  assert.equal(wrong.code, 3);
  assert.match(wrong.stderr, /--entry は「名前=値」/);
});
