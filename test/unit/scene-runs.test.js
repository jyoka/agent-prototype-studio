import assert from 'node:assert/strict';
import test from 'node:test';
import { allCompositions, fixRequestOf, rowOf, stopTextOf, tableOf } from '../../src/server/scene-runs.js';

// 主の画面の比べる表(src/server/scene-runs.js、task 423)。結果(result.json)の形から、表の行と「直す」の依頼の文を作る。題材は架空

const evalOf = (id, verdict, extra = {}) => ({ id, file: `app/evals/${id}.json`, kind: 'aside', about: `${id} の場面(架空)`, verdict, checks: [], turns: [{ ms: 1000, costUsd: 0 }], costUsd: 0, tools: [], ...extra });

function resultOf({ real = false } = {}) {
  return {
    format: 'prototype-studio-evals',
    id: 'run-1',
    startedAt: '2026-11-10T00:00:00.000Z',
    finishedAt: '2026-11-10T00:01:00.000Z',
    status: 'done',
    stopReason: null,
    options: { real, limitUsd: real ? 1 : null, judge: null },
    totals: {},
    groups: [
      {
        composition: { file: 'composition.json', label: 'composition.json', name: '案内役(架空)', shape: 'single-agent' },
        assumption: { id: 'stand-in', model: 'claude-sonnet-5-5', standIn: true },
        connection: real ? 'claude-code' : 'mock',
        real,
        round: 1,
        summary: { toolRecall: 0.5, wrongCalls: 1, tools: { calls: 3 } },
        evals: [
          evalOf('hello', 'passed', { turns: [{ ms: 2000, costUsd: 0.01 }], costUsd: real ? 0.01 : 0 }),
          evalOf('save', 'failed', {
            turns: [{ ms: 4000, costUsd: 0.03 }],
            costUsd: real ? 0.03 : 0,
            tools: ['save_wish(tool の requires が止めた)'],
            checks: [
              { check: 'toolCalled', verdict: 'failed', expected: '「save_wish」を呼ぶ', actual: '呼ばれなかった' },
              { check: 'replyMaxChars', verdict: 'passed' },
            ],
          }),
          evalOf('broken', 'error', { reason: 'ツールの口が読めません' }),
          evalOf('other', 'n/a', { turns: [] }),
        ],
      },
      {
        // 構成 B(ファイルがない)
        composition: { file: undefined, label: '構成 B(app/ai.json)', name: null, shape: 'fixed-flow' },
        assumption: null,
        connection: 'mock',
        real: false,
        round: 1,
        summary: { toolRecall: null, wrongCalls: 0, tools: { calls: 0 } },
        evals: [evalOf('hello', 'passed')],
      },
    ],
  };
}

test('表の行: 通った数、当てはまらない数、道具の正しさ。お試しの AI では費用と待ち時間を出さない', () => {
  const table = tableOf(resultOf(), ['hello', 'save', 'broken', 'other']);
  assert.deepEqual(
    table.rows.map((row) => [row.composition.name, row.composition.file, row.passed, row.ran, row.failed, row.errors, row.notApplicable, row.toolRecall, row.costUsd, row.medianReplySeconds]),
    [
      ['案内役(架空)', 'composition.json', 1, 3, 1, 1, 1, 0.5, null, null],
      // 名前のない構成は形の名前、ファイルのない構成は ai.json(画面に app/ を出さない)
      ['固定の流れ', 'ai.json', 1, 1, 0, 0, 0, null, null, null],
    ],
  );
  assert.equal(table.stale, false);
  assert.equal(table.real, false);
});

test('本物の AI の行は、費用の合計、1 会話の費用、返事の待ち時間の中央値を出す', () => {
  const row = rowOf(resultOf({ real: true }).groups[0], 0);
  assert.equal(row.real, true);
  assert.equal(row.costUsd, 0.04);
  // 返事のあった会話(hello、save、broken)で割る。当てはまらない場面は数えない
  assert.equal(row.costPerConversationUsd, 0.04 / 3);
  assert.equal(row.medianReplySeconds, 2);
});

test('通らない場面と回せなかった場面に、「直す」の依頼の文を付ける。通った確かめは書かない', () => {
  const { failures } = tableOf(resultOf(), null);
  assert.deepEqual(failures.map((f) => [f.row, f.id, f.verdictLabel]), [['0', 'save', '通らなかった'], ['0', 'broken', '回せなかった']]);
  assert.deepEqual(failures[0].checks, [{ check: 'toolCalled', expected: '「save_wish」を呼ぶ', actual: '呼ばれなかった' }]);
  assert.equal(
    failures[0].request,
    [
      '場面「save」(save の場面(架空))が、構成「案内役(架空)」をお試しの AI で回したときに通りませんでした。',
      '- 確かめ「toolCalled」: 期待 「save_wish」を呼ぶ、実際 呼ばれなかった',
      'ツールの呼び出し: save_wish(tool の requires が止めた)',
      '場面の一覧と守り(ガードレール)は弱めずに、AI の作り(プロンプト、ツール、決まった返事)を直して、この場面が通るようにしてください。',
    ].join('\n'),
  );
  assert.match(failures[1].request, /理由: ツールの口が読めません\nツールの呼び出し: なし/);
});

test('回した後に場面の一覧が変わったら、古いと出す', () => {
  assert.equal(tableOf(resultOf(), ['hello', 'save', 'broken']).stale, true);
  assert.equal(tableOf(resultOf(), ['hello', 'save', 'broken', 'other', 'new']).stale, true);
});

test('回している途中と途中で止めた結果は、場面がそろわなくても古いと出さない', () => {
  for (const status of ['running', 'stopped', 'error']) {
    assert.equal(tableOf({ ...resultOf(), status }, ['hello', 'save', 'broken', 'other', 'new']).stale, false, status);
  }
});

test('止めた理由は平たい言葉にする。CLI の引数の名前(--limit-usd など)は画面の文に入れない', () => {
  const stopped = (stopReason) => stopTextOf({ status: 'stopped', stopReason });
  assert.equal(stopped('台帳の累計(0.0020 USD)が上限(--limit-usd 0.001)に達したので、次の返事を始めずに止めました'), '使った費用が上限に達したので、次の返事を始めずに止めました');
  assert.equal(stopped('起動の数が上限(--max-launches 200)に達したので、次の返事を始めずに止めました'), '本物の AI を呼んだ回数が上限に達したので、次の返事を始めずに止めました');
  assert.equal(stopped('回しを止めました'), '止めました。それまでの結果を残しています');
  assert.equal(stopTextOf({ status: 'error', stopReason: 'app/tools.json が読めません' }), '途中で回せなくなりました。それまでの結果を残しています');
  assert.equal(stopTextOf({ status: 'done', stopReason: null }), null);
  const table = tableOf({ ...resultOf(), status: 'stopped', stopReason: '上限(--limit-usd 1)' });
  assert.equal(table.stopText, '使った費用が上限に達したので、次の返事を始めずに止めました');
});

test('通らない場面は 30 まで出し、全部の数は別に返す', () => {
  const result = resultOf();
  result.groups[0].evals = Array.from({ length: 35 }, (_, i) => evalOf(`s${i}`, 'failed'));
  const table = tableOf(result, null);
  assert.equal(table.failures.length, 30);
  assert.equal(table.failureCount, 35);
});

test('依頼の文は、本物の AI で回したことも書く', () => {
  const row = rowOf(resultOf({ real: true }).groups[0], 0);
  assert.match(fixRequestOf({ scene: { id: 'x', about: null, reason: null, checks: [], tools: [] }, row }), /^場面「x」が、構成「案内役\(架空\)」を本物の AI で回したときに/);
});

test('回す構成は、既定の構成と compositions/ の構成の全部(既定と同じファイルは 1 つにする)', () => {
  const simulation = {
    composition: { file: 'composition.json' },
    compositions: [{ composition: { file: 'compositions/b.json' } }, { composition: { file: 'composition.json' } }, { composition: { file: 'compositions/c.json' } }],
  };
  assert.deepEqual(allCompositions(simulation), ['default', 'compositions/b.json', 'compositions/c.json']);
  assert.deepEqual(allCompositions({ composition: { participants: [] } }), ['default']);
});
