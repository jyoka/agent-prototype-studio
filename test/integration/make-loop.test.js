import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { FAKE_CLI } from '../../src/server/agent-connection.js';
import { BuildRequests, MAX_FIX_ROUNDS } from '../../src/server/build-requests.js';
import { describeBilling } from '../../src/server/claude-args.js';
import { STUDIO_ROOT } from '../../src/server/config.js';
import { readFixPrompt } from '../../src/server/fix-prompt.js';
import { ensureSampleProjects } from '../../src/server/projects.js';
import { ProjectStore } from '../../src/server/store.js';

// 作るループを閉じる(docs/design/harness.md の 2.1〜2.4、S1、S12、S14)。
// 作る AI は偽接続か、決まった手順で app/ を書く小さな台本(どちらもモデルを呼ばない)。
// 観察器(関門 G5)は、呼ぶ側が渡す observe 関数を差し替えて確かめる
const PROJECT = 'sample-library';
const ENV = { PATH: process.env.PATH };
const BROKEN_LINE = 'const studioBroken = ; // 偽接続が「壊して」で入れた行\n';

function passedReport() {
  return { verdict: 'passed', reason: null, errors: [], load: { done: true, durationMs: 120 }, page: { text: '架空の図書室', empty: false }, screenshots: [] };
}

function failedReport(message = '架空の在庫表が読めません') {
  return { ...passedReport(), verdict: 'failed', errors: [{ kind: 'runtime', message, stack: '' }] };
}

// 台本の作る AI。呼ばれるたびに、受け取ったもの(引数、cwd、stdin、環境変数の名前)を RECORD_FILE に 1 行で残し、
// STEPS の n 番目の動きをする。break: App.jsx にビルドできない行を足す。touch: その行を消し、コメントを 1 行足す。
// hang: 止められるまで終わらない
const SCRIPT = `import fs from 'node:fs';
const stdin = fs.readFileSync(0, 'utf8');
const log = process.env.RECORD_FILE;
const n = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\\n').filter(Boolean).length : 0;
fs.appendFileSync(log, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), stdin, envNames: Object.keys(process.env).sort() }) + '\\n');
const step = JSON.parse(process.env.STEPS)[n];
const BAD = 'const scriptedBroken = ;\\n';
const text = fs.readFileSync('App.jsx', 'utf8');
if (step === 'hang') {
  setInterval(() => {}, 1000);
} else {
  if (step === 'break') fs.writeFileSync('App.jsx', text + BAD);
  if (step === 'touch') fs.writeFileSync('App.jsx', text.replace(BAD, '') + '// 手直し ' + n + '\\n');
  console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'ok', permission_denials: [] }));
}
`;

async function setup(t, { steps, observe = passedReport, timeoutMs } = {}) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-make-loop-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  await ensureSampleProjects(home, path.join(STUDIO_ROOT, 'samples'));
  const store = new ProjectStore(home);
  // Studio の起動と同じく、先に 1 回ビルドしておく
  await store.build(PROJECT);
  const recordFile = path.join(home, 'record.ndjson');
  let env = ENV;
  let connection = { kind: 'fake', label: '偽接続', command: process.execPath, prefixArgs: [FAKE_CLI], billing: describeBilling(ENV), problem: null };
  if (steps) {
    const script = path.join(home, 'scripted-agent.mjs');
    await fs.writeFile(script, SCRIPT);
    env = { ...ENV, RECORD_FILE: recordFile, STEPS: JSON.stringify(steps) };
    connection = { kind: 'claude', label: '台本', command: process.execPath, prefixArgs: [script], billing: describeBilling(env), problem: null };
  }
  const calls = [];
  const requests = new BuildRequests({
    store,
    connection,
    env,
    ...(timeoutMs ? { timeoutMs } : {}),
    observe: async (id, options) => {
      calls.push(options);
      return observe(calls.length);
    },
  });
  const root = path.join(home, 'projects', PROJECT);
  const start = async (text) => {
    const started = await requests.start(PROJECT, text);
    return { run: started.run, ended: new Promise((resolve) => started.subscribe(() => {}, resolve)) };
  };
  const send = async (text) => (await start(text)).ended;
  const readRun = async (run) => JSON.parse(await fs.readFile(path.join(root, '.studio', 'runs', run.id, 'run.json'), 'utf8'));
  const records = async () =>
    (await fs.readFile(recordFile, 'utf8').catch(() => ''))
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  const appFile = () => fs.readFile(path.join(root, 'app', 'App.jsx'), 'utf8');
  return { home, root, store, requests, calls, start, send, readRun, records, appFile };
}

const gateStatus = (gates) => Object.fromEntries(gates.map((gate) => [gate.id, gate.status]));
const kinds = (run) => run.items.map((item) => item.kind);

test('関門の失敗を直す依頼にして作る AI に返し、直った版で関門が通ると fixed になる', async (t) => {
  const { root, calls, send, readRun, appFile } = await setup(t);
  const run = await send('壊して');
  assert.equal(run.status, 'fixed', JSON.stringify(run.items, null, 2));
  assert.ok(!(await appFile()).includes(BROKEN_LINE));

  const record = await readRun(run);
  assert.equal(record.status, 'fixed');
  assert.equal(record.maxFixRounds, 2);
  assert.equal(record.agentLaunches.count, 2);
  assert.deepEqual(record.agentLaunches.launches.map((launch) => [launch.round, launch.outcome]), [[1, 'passed'], [2, 'passed']]);
  // ラウンドごとの節の列。直した後は G1 から回し直す
  assert.deepEqual(record.rounds.map((round) => round.nodes), [
    ['accept', 'fingerprint', 'agent', 'changes', 'inspect', 'contract', 'compile', 'fix'],
    ['agent', 'changes', 'inspect', 'contract', 'compile', 'launch', 'evidence'],
  ]);
  assert.deepEqual(gateStatus(record.rounds[0].gates), { G1: 'passed', G2: 'passed', G3: 'passed', G4: 'failed', G5: 'skipped' });
  assert.deepEqual(gateStatus(record.rounds[1].gates), { G1: 'passed', G2: 'passed', G3: 'passed', G4: 'passed', G5: 'passed' });
  assert.deepEqual(record.gates, record.rounds[1].gates);
  assert.equal(record.rounds[1].input, 'fix');
  assert.equal(record.rounds[1].fixOf.round, 1);
  assert.equal(record.rounds[1].fixOf.gate, 'G4');
  assert.deepEqual(record.rounds[1].changedFiles, [{ file: 'app/App.jsx', change: 'modified' }]);
  // 起動の確認は直した版だけで行い、report はそのラウンドのフォルダーに置く
  assert.equal(calls.length, 1);
  assert.equal(calls[0].outDir, path.join(root, '.studio', 'runs', run.id, 'rounds', '2'));
  assert.deepEqual(record.reports, [{ gate: 'G5', round: 2, file: `.studio/runs/${run.id}/rounds/2/report.json` }]);
  // 依頼の文と直す依頼の文は run.json に入れない
  assert.ok(!JSON.stringify(record).includes('壊して'));

  // 作る会話に、ラウンドの区切りと直す依頼の要約を出す
  assert.deepEqual(
    kinds(run).filter((kind) => ['changes', 'build-failed', 'round', 'fix-request', 'build-ok', 'launch-ok', 'gates'].includes(kind)),
    ['changes', 'build-failed', 'round', 'fix-request', 'changes', 'build-ok', 'launch-ok', 'gates'],
  );
  assert.equal(run.items.find((item) => item.kind === 'round').text, '直すラウンド 1/2: 作る AI を起動し直します(起動 2/3 回目)。');
  assert.match(run.items.find((item) => item.kind === 'fix-request').text, /^G4 ビルドの失敗\(app\/App\.jsx:2:\d+ .+\)を作る AI に返しました。添えたのは、元の依頼、失敗の中身、変わったファイルの名前\(1 個\)だけです。$/);
  assert.ok(run.items.some((item) => item.kind === 'assistant' && item.text.startsWith('Studio の直す依頼を読みました(失敗した関門: G4 ビルド)')));
  assert.equal(run.items.find((item) => item.kind === 'gates').text, 'Studio が確かめた結果(直すラウンド 1 の後): G1 変更の確認: 通った、G2 検査: 通った、G3 契約: 通った、G4 ビルド: 通った、G5 起動の確認: 通った');
});

test('起動の確認(G5)の失敗も直す依頼にして返す。2 回目の直す依頼には、直前のラウンドの失敗だけを入れる', async (t) => {
  // 1 回目: ビルドできない行を足す(G4 で失敗)。2 回目: 直すが、起動の確認で落ちる(G5)。3 回目: 直す
  const { send, readRun, records } = await setup(t, {
    steps: ['break', 'touch', 'touch'],
    observe: (n) => (n === 1 ? failedReport('架空の棚が見つかりません') : passedReport()),
  });
  const run = await send('見出しを「台本の図書室」にして');
  assert.equal(run.status, 'fixed', JSON.stringify(run.items, null, 2));
  const record = await readRun(run);
  assert.equal(record.agentLaunches.count, 3);
  assert.deepEqual(record.rounds.map((round) => round.fixOf?.gate ?? null), [null, 'G4', 'G5']);
  assert.deepEqual(gateStatus(record.rounds[1].gates).G5, 'failed');
  assert.deepEqual(record.reports.map((report) => report.round), [2, 3]);

  const [first, second, third] = await records();
  assert.equal(first.stdin, '見出しを「台本の図書室」にして');
  assert.deepEqual(readFixPrompt(second.stdin), { request: '見出しを「台本の図書室」にして', gate: 'G4 ビルド' });
  assert.match(second.stdin, /app\/App\.jsx:\d+:\d+ /);
  assert.deepEqual(readFixPrompt(third.stdin), { request: '見出しを「台本の図書室」にして', gate: 'G5 起動の確認' });
  assert.match(third.stdin, /^実行時のエラー: 架空の棚が見つかりません$/m);
  // 直前のラウンドの失敗だけ。1 回目のビルドの誤りは入れない
  assert.ok(!third.stdin.includes('G4'));
  assert.ok(!third.stdin.includes('app/App.jsx:'));
  assert.match(third.stdin, /^変わったファイル: app\/App\.jsx$/m);
});

test('1 回目の直すラウンドで直らず、2 回目で直ると fixed になる', async (t) => {
  const { send, readRun, appFile } = await setup(t);
  const run = await send('壊して、2 回目で直して');
  assert.equal(run.status, 'fixed', JSON.stringify(run.items, null, 2));
  const record = await readRun(run);
  assert.equal(record.agentLaunches.count, 3);
  assert.deepEqual(record.rounds.map((round) => gateStatus(round.gates).G4), ['failed', 'failed', 'passed']);
  assert.deepEqual(record.rounds.map((round) => round.fixOf?.round ?? null), [null, 1, 2]);
  assert.deepEqual(kinds(run).filter((kind) => kind === 'round').length, 2);
  assert.equal(run.items.filter((item) => item.kind === 'round').at(-1).text, '直すラウンド 2/2: 作る AI を起動し直します(起動 3/3 回目)。');
  assert.ok(!(await appFile()).includes('偽接続が直そうとした跡'));
});

test('直せない作る AI では、起動は 3 回で止まり、failed と証拠を返す', async (t) => {
  const { store, calls, send, readRun, appFile } = await setup(t);
  const before = store.previewBuildId(PROJECT);
  const run = await send('壊して、直せないふりをして');
  assert.equal(run.status, 'failed');
  assert.equal(MAX_FIX_ROUNDS, 2);
  assert.equal(run.launches.length, MAX_FIX_ROUNDS + 1);
  assert.equal(calls.length, 0);
  // 試す画面は、前にビルドできた版のまま
  assert.equal(store.previewBuildId(PROJECT), before);
  assert.match(await appFile(), /偽接続が直そうとした跡\(2 回目\)/);

  const record = await readRun(run);
  assert.equal(record.status, 'failed');
  assert.equal(record.agentLaunches.count, 3);
  assert.deepEqual(record.rounds.map((round) => round.round), [1, 2, 3]);
  assert.deepEqual(record.rounds.map((round) => gateStatus(round.gates).G4), ['failed', 'failed', 'failed']);
  assert.equal(record.rounds[2].nodes.at(-2), 'fix');
  assert.equal(record.nodes.find((node) => node.name === 'fix' && node.round === 3).outcome, 'gave-up');
  // 証拠: 失敗した関門と場所が run.json に残る
  const g4 = record.gates.find((gate) => gate.id === 'G4');
  assert.equal(g4.status, 'failed');
  assert.equal(g4.errors[0].file, 'app/App.jsx');
  assert.deepEqual(run.evidence, { run: `.studio/runs/${run.id}/run.json` });
  const gaveUp = run.items.find((item) => item.kind === 'gave-up');
  assert.equal(
    gaveUp.text,
    '直すラウンドを 2 回行いましたが、G4 ビルドで失敗したままです。ここで止めて、失敗と証拠を返します。詳細の欄で場所を確かめ、直す依頼を送ってください。',
  );
  assert.ok(run.items.some((item) => item.kind === 'gates' && item.text.includes('G4 ビルド: 失敗')));
});

test('直すラウンドで app/ が変わらなかったら、そこで failed になり、前の失敗を隠さない', async (t) => {
  // 起動の確認がいつも失敗する。偽接続は直す依頼を受けても、失敗の原因が見つからず何も変えない
  const { calls, send, readRun } = await setup(t, { observe: () => failedReport() });
  const run = await send('見出しを「変わらない図書室」にして');
  assert.equal(run.status, 'failed');
  assert.equal(run.launches.length, 2);
  assert.equal(calls.length, 1);
  const record = await readRun(run);
  assert.deepEqual(record.rounds[1].nodes, ['agent', 'changes', 'evidence']);
  assert.deepEqual(gateStatus(record.rounds[1].gates), { G1: 'unchanged', G2: 'skipped', G3: 'skipped', G4: 'skipped', G5: 'skipped' });
  assert.deepEqual(record.rounds[1].changedFiles, []);
  // 結果には、前のラウンドの G5 の失敗が残る
  assert.deepEqual(gateStatus(record.gates), { G1: 'unchanged', G2: 'passed', G3: 'passed', G4: 'passed', G5: 'failed' });
  assert.equal(record.gates.find((gate) => gate.id === 'G1').detail, '直すラウンドで app/ が変わりませんでした');
  const gaveUp = run.items.find((item) => item.kind === 'gave-up');
  assert.match(gaveUp.text, /^直すラウンドで app\/ が変わらなかったので、ここで止めました。前のラウンドの失敗\(G5 起動の確認\)は直っていません。/);
  assert.ok(run.items.some((item) => item.kind === 'assistant' && item.text === '失敗の原因が見つからなかったので、何も変えていません。'));
});

test('依頼の前から同じ失敗が出ていたら、印を付ける', async (t) => {
  const { send, readRun } = await setup(t);
  // 前の依頼で壊れたまま終わる
  assert.equal((await send('壊して、直せないふりをして')).status, 'failed');
  // 次の依頼は見出しだけを変える。ビルドの誤りは依頼の前と同じ
  const run = await send('見出しを「前からの図書室」にして');
  assert.equal(run.status, 'fixed', JSON.stringify(run.items, null, 2));
  const record = await readRun(run);
  const g4 = record.rounds[0].gates.find((gate) => gate.id === 'G4');
  assert.equal(g4.status, 'failed');
  assert.equal(g4.preexisting, true);
  assert.equal(record.rounds[1].fixOf.preexisting, true);
  assert.deepEqual(
    run.items.filter((item) => item.kind === 'preexisting').map((item) => item.text),
    ['G4 ビルドの失敗は、依頼の前のビルドでも同じ形で出ていました(依頼の前から壊れていました)。'],
  );

  // 依頼の前は通っていたなら、印は付けない
  const fresh = await send('壊して');
  assert.equal(fresh.status, 'fixed');
  assert.ok(!kinds(fresh).includes('preexisting'));
  assert.equal((await readRun(fresh)).rounds[0].gates.find((gate) => gate.id === 'G4').preexisting, undefined);
});

test('起動の確認の失敗も、表示中のビルドで前から出ていたら印を付ける', async (t) => {
  const { send, readRun } = await setup(t, { observe: () => failedReport() });
  assert.equal((await send('見出しを「一つ目の図書室」にして')).status, 'failed');
  const run = await send('見出しを「二つ目の図書室」にして');
  assert.equal(run.status, 'failed');
  const g5 = (await readRun(run)).rounds[0].gates.find((gate) => gate.id === 'G5');
  assert.equal(g5.preexisting, true);
  assert.ok(run.items.some((item) => item.kind === 'preexisting' && item.text.startsWith('G5 起動の確認の失敗は')));
});

test('直すラウンドの作る AI も、時間の上限で止まる。上限は 1 回の起動ごとに効く', async (t) => {
  const { send, readRun, records } = await setup(t, { steps: ['break', 'hang'], timeoutMs: 1500 });
  const begin = Date.now();
  const run = await send('見出しを「時間切れの図書室」にして');
  assert.equal(run.status, 'timed-out');
  assert.ok(Date.now() - begin < 10_000, `${Date.now() - begin}ms`);
  const record = await readRun(run);
  assert.deepEqual(record.agentLaunches.launches.map((launch) => [launch.round, launch.outcome]), [[1, 'passed'], [2, 'timed-out']]);
  assert.equal((await records()).length, 2);
  // 止めた run は、それ以上直させない
  assert.ok(!run.items.some((item) => item.kind === 'gave-up'));
});

test('関門を回している間に中断すると、今の関門は終わりまで回し、直すラウンドは行わない', async (t) => {
  let release;
  const observing = new Promise((resolve) => (release = resolve));
  let entered;
  const inObserve = new Promise((resolve) => (entered = resolve));
  const { requests, start, readRun } = await setup(t, {
    observe: async () => {
      entered();
      await observing;
      return failedReport();
    },
  });
  const { run: started, ended } = await start('見出しを「中断の間の図書室」にして');
  await inObserve;
  const cancelled = requests.cancel(PROJECT, started.id);
  assert.ok(cancelled, '関門の間の中断を断った');
  assert.ok(cancelled.items.some((item) => item.text === '中断しています…(今の確かめが終わったら止め、直すラウンドは行いません)'));
  release();
  const run = await ended;
  assert.equal(run.status, 'cancelled');
  assert.equal(run.launches.length, 1);
  assert.ok(run.items.some((item) => item.kind === 'cancelled' && item.text === '中断しました。直すラウンドは行いません。G5 起動の確認の失敗は直っていません。'));
  const record = await readRun(run);
  assert.equal(record.nodes.find((node) => node.name === 'fix').outcome, 'cancelled');
  assert.equal(record.gates.find((gate) => gate.id === 'G5').status, 'failed');
});

test('最後のラウンドの作る AI が終わった後は、止めるものがないので中断を断る', async (t) => {
  let release;
  const observing = new Promise((resolve) => (release = resolve));
  let entered;
  const inThirdObserve = new Promise((resolve) => (entered = resolve));
  const { requests, start } = await setup(t, {
    steps: ['touch', 'touch', 'touch'],
    observe: async (n) => {
      if (n === 3) {
        entered();
        await observing;
      }
      return failedReport();
    },
  });
  const { run: started, ended } = await start('見出しを「最後の図書室」にして');
  await inThirdObserve;
  assert.equal(requests.cancel(PROJECT, started.id), null);
  release();
  const run = await ended;
  assert.equal(run.status, 'failed');
  assert.equal(run.launches.length, 3);
});

test('直すラウンドの作る AI も、中断できる', async (t) => {
  const { requests, start, readRun } = await setup(t, { steps: ['break', 'hang'] });
  const { run: started, ended } = await start('見出しを「中断の図書室」にして');
  let cancelled = null;
  for (let i = 0; i < 100 && !cancelled; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    const current = requests.list(PROJECT).find((run) => run.id === started.id);
    if (current.round === 2) cancelled = requests.cancel(PROJECT, started.id);
  }
  assert.ok(cancelled, '直すラウンドで中断できない');
  const run = await ended;
  assert.equal(run.status, 'cancelled');
  const record = await readRun(run);
  assert.deepEqual(record.agentLaunches.launches.map((launch) => [launch.round, launch.outcome]), [[1, 'passed'], [2, 'cancelled']]);
});
