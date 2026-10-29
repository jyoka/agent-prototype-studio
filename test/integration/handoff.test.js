import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { FAKE_CLI } from '../../src/server/agent-connection.js';
import { BuildRequests } from '../../src/server/build-requests.js';
import { describeBilling } from '../../src/server/claude-args.js';
import { STUDIO_ROOT } from '../../src/server/config.js';
import { HANDOFF_FORMAT, HandoffError, ProjectHandoffs } from '../../src/server/handoff.js';
import { ensureSampleProjects } from '../../src/server/projects.js';
import { AiSessions } from '../../src/server/product-ai/session.js';
import { createMockConnection } from '../../src/server/product-ai/mock.js';
import { ProjectStore } from '../../src/server/store.js';
import { ProjectVersions } from '../../src/server/versions.js';
import { RealAiConsent } from '../../src/server/real-ai.js';

function agreedConsent() {
  const consent = new RealAiConsent();
  consent.agree();
  return consent;
}

// 求人ではない題材。引き継ぎの仕組みが題材に依存しないことを確かめる
const TRAVEL_AI = {
  name: '旅の相談(架空)',
  instructions: 'あなたは架空の旅の相談役です。',
  fields: [
    { key: 'place', label: '行き先', options: [{ value: '湖の町', keywords: ['湖'] }, { value: '山の村', keywords: ['山'] }] },
    { key: 'nights', label: '泊数', type: 'number', unit: '泊', keywords: ['泊'], min: 1, max: 14 },
  ],
  mock: { greeting: '旅の相談です。' },
};

const MAIN = [
  "import { PLACES } from './places-data.js';",
  "document.getElementById('root').textContent = PLACES.join('、');",
  '// TODO: 予約の画面',
  "fetch('https://example.invalid/api');",
  '',
].join('\n');

// 実モデルの代わり。Studio の画面で「実際の AI モデル」と扱われる接続(billing がある)
function fakeRealConnection() {
  return {
    kind: 'real-fake',
    label: '偽の実モデル',
    billing: { kind: 'test' },
    async respond() {
      return { reply: '湖の町で 2 泊ですね。', updates: { nights: 2 } };
    },
  };
}

async function makeStudio(t, files = {}) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-handoff-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const app = path.join(home, 'projects', 'travel', 'app');
  await fs.mkdir(app, { recursive: true });
  const all = {
    'main.js': MAIN,
    'places-data.js': "// 架空の行き先\nexport const PLACES = ['湖の町', '山の村'];\n",
    'ai.json': JSON.stringify(TRAVEL_AI),
    ...files,
  };
  for (const [name, content] of Object.entries(all)) await fs.writeFile(path.join(app, name), content);
  const store = new ProjectStore(home);
  await store.buildAll();
  const aiSessions = new AiSessions({
    definitionOf: (id) => store.aiDefinition(id),
    connections: [createMockConnection(), fakeRealConnection()],
  });
  const versions = new ProjectVersions({ store, aiSessions });
  const runs = [{ request: '見出しを変えて。連絡先は taro@example.com', status: 'succeeded', startedAt: '2026-10-28T00:00:00.000Z', changedFiles: [{ file: 'app/main.js', change: 'modified' }] }];
  const handoffs = new ProjectHandoffs({ home, store, aiSessions, versions, requests: { list: () => structuredClone(runs) } });
  return { home, app, store, aiSessions, versions, handoffs };
}

const NOTES = { purpose: '湖の旅を相談で決められるか確かめる', decided: '泊数は 14 泊まで', undecided: '予約までつなぐか' };

test('ソース、意図、AI の設定、会話と状態、未接続と未決事項を書き出し、モックと実モデルの応答を区別する', async (t) => {
  const { home, app, aiSessions, versions, handoffs } = await makeStudio(t);
  await aiSessions.send('travel', '湖に行きたい');
  aiSessions.consent.agree();
  aiSessions.select('travel', 'real-fake');
  await aiSessions.send('travel', '2泊で');
  await versions.save('travel', { name: '湖の版' });

  const result = await handoffs.export('travel', NOTES);
  assert.equal(path.dirname(result.handoff.dir), path.join(home, 'handoffs'));
  assert.match(result.handoff.name, /^travel-\d{8}-\d{6}$/);
  assert.deepEqual(result.handoff.counts, { real: 2, mock: 3, missing: 5, questions: 3 });

  // 別の場所に写しても、中身だけで読める
  const other = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-handoff-other-'));
  t.after(() => fs.rm(other, { recursive: true, force: true }));
  await fs.cp(result.handoff.dir, other, { recursive: true });
  const manifest = JSON.parse(await fs.readFile(path.join(other, 'handoff.json'), 'utf8'));
  assert.equal(manifest.format, HANDOFF_FORMAT);
  assert.equal(manifest.formatVersion, 3);
  // 名前は試作品の一覧と同じ(目録がないので ID に、AI と話せるかを添える)
  assert.deepEqual(manifest.project, { id: 'travel', title: 'travel(AI と話せる)' });
  assert.deepEqual(manifest.notes, NOTES);
  assert.equal(manifest.working.text, '保存版 v1「湖の版」と同じ');

  // ソースはそのまま写す
  assert.equal(await fs.readFile(path.join(other, 'app', 'main.js'), 'utf8'), await fs.readFile(path.join(app, 'main.js'), 'utf8'));
  assert.deepEqual(manifest.source.files.map((f) => f.path), ['app/ai.json', 'app/main.js', 'app/places-data.js']);
  assert.equal(manifest.source.entry, 'app/main.js');
  // 目録がないので、架空のデータは推定のまま。目録は既定の値で、作る run の記録もない
  assert.deepEqual(manifest.source.dataFiles, ['app/places-data.js']);
  assert.equal(manifest.source.dataFrom, 'guess');
  assert.equal(manifest.prototype.file, null);
  assert.equal(manifest.prototype.entry, 'main.js');
  assert.deepEqual(manifest.scenarios.files, []);
  assert.deepEqual(manifest.scenarios.base.map((s) => s.name), ['起動して描画が空でなく、エラーがない', 'プロダクト内 AI のあいさつが出る']);
  assert.equal(manifest.evidence.run, null);
  assert.match(manifest.evidence.appDigest, /^[0-9a-f]{64}$/);
  assert.ok(manifest.openQuestions.some((q) => q.from === 'studio' && q.text.startsWith('作る run の記録がない。')));
  assert.deepEqual(manifest.source.signs.network.map((s) => `${s.file}:${s.line}`), ['app/main.js:4']);
  assert.deepEqual(manifest.source.signs.todo.map((s) => `${s.file}:${s.line}`), ['app/main.js:3']);

  // 会話の各応答に、モックか実モデルかが付く
  const replies = manifest.conversation.messages.filter((m) => m.role === 'assistant');
  assert.deepEqual(
    replies.map((m) => [m.viaLabel, m.real]),
    [
      ['設定の固定文(mock.greeting)', false],
      ['モック', false],
      ['偽の実モデル', true],
    ],
  );
  assert.deepEqual(manifest.conversation.state.map((s) => s.shown), ['湖の町', '2泊']);
  assert.equal(manifest.ai.connection.real, true);
  assert.deepEqual(manifest.capabilities.map((c) => `${c.kind}:${c.item}`), [
    'real:画面と操作',
    'real:プロダクト内 AI(実モデル)',
    'mock:プロダクト内 AI(モック)',
    'mock:会話と状態の置き場',
    'mock:データ',
    'missing:サーバーと保存',
    'missing:外部の API と通信',
    'missing:ログインと利用者の区別',
    'missing:プロダクト内 AI の本番の接続',
    'missing:本物のデータと個人情報',
  ]);
  assert.match(manifest.capabilities.find((c) => c.item === '外部の API と通信').prototype, /app\/main\.js:4/);

  // AI の設定と、実モデルに渡す指示
  // 実モデルは抽出と言い方の 2 種の呼び出しで動くので、指示と応答の形も 2 つずつ
  const prompts = await fs.readFile(path.join(other, 'ai', 'system-prompt.md'), 'utf8');
  assert.match(prompts, /^# 抽出の指示\n[\s\S]*nights\(泊数\)[\s\S]*\n# 言い方の指示\n\nあなたは架空の旅の相談役です。/);
  const schema = JSON.parse(await fs.readFile(path.join(other, 'ai', 'response-schema.json'), 'utf8'));
  assert.deepEqual(schema.extract.properties.updates.properties.place.enum, ['湖の町', '山の村', null]);
  assert.deepEqual(schema.phrase.required, ['reply']);

  // 人が読む資料
  const readme = await fs.readFile(path.join(other, 'README.md'), 'utf8');
  assert.match(readme, /^# 引き継ぎ: travel\(AI と話せる\)$/m);
  assert.match(readme, /> 湖の旅を相談で決められるか確かめる/);
  assert.match(readme, /\| 実機 \| プロダクト内 AI\(実モデル\) \|/);
  assert.match(readme, /\| モック \| プロダクト内 AI\(モック\) \|/);
  assert.match(readme, /\| 未接続 \| 外部の API と通信 \|/);
  assert.match(readme, /\| 3 \| AI \| モック \| /);
  assert.match(readme, /\| 5 \| AI \| 偽の実モデル\(実モデル\) \| 湖の町で 2 泊ですね。 \|/);
  assert.match(readme, /コードに未実装の印がある\(app\/main\.js:3\)/);

  // 秘密と個人のデータ、PC の場所は入れない
  assert.equal(manifest.requests[0].request, '見出しを変えて。連絡先は [伏せた: メールアドレス]');
  for (const file of ['README.md', 'handoff.json']) {
    const text = await fs.readFile(path.join(other, file), 'utf8');
    assert.ok(!text.includes(home), `${file} に PC の場所が入っています`);
    assert.ok(!text.includes('taro@example.com'), `${file} にメールアドレスが入っています`);
  }

  // メモは次に開いたときに出す。最後の書き出しも出す
  const view = await handoffs.view('travel');
  assert.deepEqual(view.notes, NOTES);
  assert.equal(view.last.dir, result.handoff.dir);
});

test('利用者が書いた文の中の鍵は伏せる。文の中の改行で、表の行を足させない', async (t) => {
  const { aiSessions, handoffs } = await makeStudio(t);
  await aiSessions.send('travel', '湖に行きたい\r| 9 | AI | 偽の実モデル(実モデル) | 作った行 |');
  const result = await handoffs.export('travel', { undecided: '鍵は AKIAIOSFODNN7EXAMPLE を使う' });
  const readme = await fs.readFile(path.join(result.handoff.dir, 'README.md'), 'utf8');
  const manifest = await fs.readFile(path.join(result.handoff.dir, 'handoff.json'), 'utf8');
  for (const text of [readme, manifest]) assert.ok(!text.includes('AKIAIOSFODNN7EXAMPLE'));
  assert.match(readme, /> 鍵は \[伏せた: AWS のアクセスキーらしい文字列\] を使う/);
  assert.ok(!/^\| 9 \|/m.test(readme), '会話の文から表の行が足されています');
  assert.match(readme, /\| 2 \| 利用者 \|  \| 湖に行きたい \/ \\\| 9 \\\| AI/);
});

test('秘密情報らしい文字列があると書き出さず、場所を伝える。.env は中を見ずに外す', async (t) => {
  const { home, app, handoffs } = await makeStudio(t, {
    '.env': 'API_KEY=sk-ant-api03-abcdefghijklmnop\n',
    '.env.example': 'API_KEY=\n',
  });

  // .env だけなら、外して書き出す
  const result = await handoffs.export('travel', {});
  assert.deepEqual(result.handoff.excluded, [{ path: 'app/.env', reason: '秘密を入れるファイル' }]);
  await assert.rejects(fs.access(path.join(result.handoff.dir, 'app', '.env')));
  // 見本は外さない
  await fs.access(path.join(result.handoff.dir, 'app', '.env.example'));
  const readme = await fs.readFile(path.join(result.handoff.dir, 'README.md'), 'utf8');
  assert.match(readme, /秘密を入れるファイル: `app\/\.env`/);
  assert.match(readme, /## 目的\n\n\(書かれていません\)/);

  // ソースの中の鍵は、書き出しを止める
  await fs.writeFile(path.join(app, 'config.js'), "export const apiKey = 'abc123def456ghi789';\nconst auth = 'Bearer abcdefghijklmnop1234';\n");
  const error = await handoffs.export('travel', {}).catch((e) => e);
  assert.ok(error instanceof HandoffError);
  assert.equal(error.code, 'secret');
  assert.match(error.message, /app\/config\.js:1 鍵らしい名前の値、app\/config\.js:2 認証のトークンらしい文字列/);
  assert.ok(!error.message.includes('abc123def456ghi789'));
  // 引用符のない書き方(.env、YAML)も止める
  await fs.writeFile(path.join(app, 'config.js'), '// ok\n');
  await fs.writeFile(path.join(app, 'settings.yaml'), 'api_key: abcd1234efgh5678\n');
  await assert.rejects(handoffs.export('travel', {}), /app\/settings\.yaml:1 鍵らしい名前の値/);
  // 書きかけは残さない
  const left = await fs.readdir(path.join(home, 'handoffs'));
  assert.deepEqual(left, [result.handoff.name]);
});

test('ビルドできない状態は書き出さない。AI のない試作品も書き出せる', async (t) => {
  const { app, store, handoffs } = await makeStudio(t);
  await fs.writeFile(path.join(app, 'main.js'), 'const = ;\n');
  const error = await handoffs.export('travel', {}).catch((e) => e);
  assert.equal(error.code, 'build');
  assert.match(error.message, /ビルドできない状態は書き出せません/);

  await fs.writeFile(path.join(app, 'main.js'), "document.getElementById('root').textContent = 'AI なし';\n");
  await fs.rm(path.join(app, 'ai.json'));
  await fs.rm(path.join(app, 'places-data.js'));
  await store.build('travel');
  const result = await handoffs.export('travel', { purpose: '画面だけ' });
  const manifest = JSON.parse(await fs.readFile(path.join(result.handoff.dir, 'handoff.json'), 'utf8'));
  assert.equal(manifest.ai, null);
  assert.equal(manifest.conversation, null);
  assert.deepEqual(manifest.capabilities.map((c) => c.kind), ['real', 'mock', 'missing', 'missing', 'missing', 'missing']);
  assert.equal(manifest.working.text, '版を保存していない作業中から書き出した');
  await assert.rejects(fs.access(path.join(result.handoff.dir, 'ai')));
  assert.match(await fs.readFile(path.join(result.handoff.dir, 'README.md'), 'utf8'), /プロダクト内 AI を使っていません/);
});

test('メモの形が違えば断る。書き出しの間は、版の操作と同じく他の操作を断る', async (t) => {
  const { store, handoffs } = await makeStudio(t);
  await assert.rejects(handoffs.export('travel', { purpose: 1 }), { code: 'invalid' });
  await assert.rejects(handoffs.export('travel', { purpose: 'あ'.repeat(4001) }), { code: 'invalid' });
  store.claimRun('travel');
  await assert.rejects(handoffs.export('travel', {}), /作る AI が作業中/);
  store.releaseRun('travel');
});

// 目録、シナリオ、作る run の記録がある試作品(見本の求人相談)。作る AI は偽接続で、観察器(関門 G5、G6)は差し替える
const JOB = 'sample-job-consult';
const ENV = { PATH: process.env.PATH };

async function makeSampleStudio(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-handoff-sample-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  await ensureSampleProjects(home, path.join(STUDIO_ROOT, 'samples'));
  const store = new ProjectStore(home);
  await store.buildAll();
  const aiSessions = new AiSessions({ definitionOf: (id) => store.aiDefinition(id), connections: [createMockConnection()] });
  const versions = new ProjectVersions({ store, aiSessions });
  // 観察器の report の代わり。本物と同じく、表示中のビルドの appDigest を持つ
  const report = async (scenarios) => ({
    format: 'prototype-studio-observation',
    formatVersion: 1,
    appDigest: (await store.list()).find((p) => p.id === JOB).lastBuild.appDigest,
    startedAt: new Date().toISOString(),
    verdict: 'passed',
    reason: null,
    errors: [],
    load: { done: true, durationMs: 100 },
    page: { text: 'しおかぜ求人相談', empty: false },
    scenarios,
    screenshots: [],
  });
  const requests = new BuildRequests({
    // 本物の AI を使う前の同意は済んでいるものとする(同意の確かめは test/integration/consent.test.js)
    consent: agreedConsent(),
    store,
    connection: { kind: 'fake', label: '偽接続', command: process.execPath, prefixArgs: [FAKE_CLI], billing: describeBilling(ENV), problem: null },
    env: ENV,
    observe: async (id, options) =>
      options.gate === 'scenarios'
        ? report([
            { name: '起動して描画が空でなく、エラーがない', base: true, file: null, verdict: 'passed', steps: [], failed: null },
            { name: '希望を話すと、希望条件が埋まり、合う求人が絞られる', base: false, file: 'app/scenarios/talk-and-narrow.json', verdict: 'passed', steps: [], failed: null },
          ])
        : report([]),
  });
  t.after(() => requests.closeAll());
  const handoffs = new ProjectHandoffs({ home, store, aiSessions, versions, requests });
  const send = async (text) => {
    const started = await requests.start(JOB, text);
    return new Promise((resolve) => started.subscribe(() => {}, resolve));
  };
  const app = path.join(home, 'projects', JOB, 'app');
  return { home, app, store, handoffs, send };
}

const readHandoff = async (result) => ({
  manifest: JSON.parse(await fs.readFile(path.join(result.handoff.dir, 'handoff.json'), 'utf8')),
  readme: await fs.readFile(path.join(result.handoff.dir, 'README.md'), 'utf8'),
});

test('目録、シナリオ、最新の作る run と観察の report の要約を入れる。目録の data を宣言として出し、未実装と制約を未接続の行に出す(S7)', async (t) => {
  const { handoffs, send } = await makeSampleStudio(t);
  const run = await send('見出しを「うみかぜ求人相談」にして');
  assert.equal(run.status, 'passed', JSON.stringify(run.items, null, 2));

  const result = await handoffs.export(JOB, { purpose: '求人を相談で絞れるか確かめる' });
  const { manifest, readme } = await readHandoff(result);
  assert.equal(manifest.formatVersion, 3);

  // 目録: 作る AI が書いた意図、制約、未実装、架空のデータ
  assert.equal(manifest.prototype.file, 'app/prototype.json');
  assert.equal(manifest.prototype.intent.purpose, '求職者が希望を話すと、案内役が条件を読み取り、合う求人が絞られる体験を試す');
  assert.deepEqual(manifest.prototype.unimplemented, ['ログイン', '求人への応募', '本物の求人データとのつなぎ込み']);
  assert.deepEqual(manifest.prototype.data, [{ file: 'jobs.js', about: '架空の求人の一覧(職種、雇用区分、勤務地、時給)' }]);
  assert.equal(manifest.source.entry, 'app/main.jsx');

  // 架空のデータは、推定ではなく目録の宣言
  assert.deepEqual(manifest.source.dataFiles, ['app/jobs.js']);
  assert.equal(manifest.source.dataFrom, 'manifest');
  const data = manifest.capabilities.find((c) => c.item === 'データ');
  assert.match(data.prototype, /目録\(app\/prototype\.json の data\)に書かれた架空のデータ: app\/jobs\.js\(架空の求人の一覧/);
  assert.ok(!data.prototype.includes('推定'));
  assert.ok(!readme.includes('手がかり(推定)'));

  // 未実装と制約は「未接続」の行
  const missing = manifest.capabilities.filter((c) => c.kind === 'missing').map((c) => c.item);
  assert.deepEqual(missing.slice(-4), ['ログイン', '求人への応募', '本物の求人データとのつなぎ込み', '試作品の制約(目録)']);
  assert.match(manifest.capabilities.at(-1).prototype, /データはすべて架空、実在の企業、店舗、地名とは関係ない/);
  assert.match(readme, /\| 未接続 \| 求人への応募 \| 目録\(app\/prototype\.json の unimplemented\)/);
  // 書き出した人のメモと、作る AI の意図を並べる
  assert.match(readme, /## 目的\n\n> 求人を相談で絞れるか確かめる\n\n## 作る AI が書いた意図と制約\(目録\)/);
  assert.match(readme, /- 意図: 求職者が希望を話すと/);

  // シナリオ: app/ のものと Studio の基本のもの。手順ごとに確かめることの文を付ける
  assert.equal(manifest.scenarios.folder, 'app/scenarios');
  assert.deepEqual(manifest.scenarios.files.map((s) => [s.file, s.name, s.steps.length]), [
    ['app/scenarios/talk-and-narrow.json', '希望を話すと、希望条件が埋まり、合う求人が絞られる', 9],
  ]);
  assert.equal(manifest.scenarios.files[0].checks[3], 'プロダクト内 AI の状態の「jobType」が "カフェのホール" になる');
  assert.equal(manifest.scenarios.base.length, 2);
  assert.match(readme, /\| `app\/scenarios\/talk-and-narrow\.json` \| 希望を話すと、希望条件が埋まり、合う求人が絞られる \| desktop \| 1\. /);

  // 最新の作る run の要約: 合否、関門ごとの結果、日時、appDigest。今の app/ と同じ中身で確かめた
  const evidence = manifest.evidence.run;
  assert.equal(evidence.id, run.id);
  assert.equal(evidence.file, `.studio/runs/${run.id}/run.json`);
  assert.equal(evidence.status, 'passed');
  assert.equal(evidence.startedAt, run.startedAt);
  assert.ok(evidence.finishedAt);
  assert.deepEqual(evidence.gates.map((g) => `${g.id}:${g.status}`), ['G1:passed', 'G2:passed', 'G3:passed', 'G4:passed', 'GE:passed', 'G5:passed', 'G6:passed']);
  assert.equal(evidence.appDigest, manifest.evidence.appDigest);
  assert.equal(evidence.stale, false);
  assert.deepEqual(evidence.reports.map((r) => [r.gate, r.verdict, r.stale]), [['G5', 'passed', false], ['G6', 'passed', false]]);
  assert.deepEqual(evidence.reports[1].scenarios.map((s) => [s.name, s.base, s.verdict]), [
    ['起動して描画が空でなく、エラーがない', true, 'passed'],
    ['希望を話すと、希望条件が埋まり、合う求人が絞られる', false, 'passed'],
  ]);
  assert.match(readme, /## 最新の証拠\n[\s\S]*- 結果: 通った\(ラウンド 1 回\)\n[\s\S]*- 確かめた app\/ の中身: 今の app\/ と同じ中身/);
  assert.match(readme, /\| G6 \| シナリオ \| 通った \|/);
  assert.ok(!manifest.openQuestions.some((q) => /証拠|作る run/.test(q.text)));
});

test('作る run の後に app/ が変わったら、証拠の要約に古い印を付ける', async (t) => {
  const { app, store, handoffs, send } = await makeSampleStudio(t);
  await send('見出しを「うみかぜ求人相談」にして');
  // 作る欄を通さずに app/ を変える(手で直したときなど)
  await fs.appendFile(path.join(app, 'App.jsx'), '// 手で直した\n');
  await store.build(JOB);

  const { manifest, readme } = await readHandoff(await handoffs.export(JOB, {}));
  assert.equal(manifest.evidence.run.stale, true);
  assert.notEqual(manifest.evidence.run.appDigest, manifest.evidence.appDigest);
  assert.deepEqual(manifest.evidence.run.reports.map((r) => r.stale), [true, true]);
  assert.match(readme, /- 確かめた app\/ の中身: \*\*古い\*\*\(今の app\/ と違う中身で確かめた\)/);
  assert.ok(manifest.openQuestions.some((q) => q.from === 'studio' && /今の app\/ と違う中身で確かめたもので、古い/.test(q.text)));
});

test('足した中身(証拠の要約)に秘密らしい文字列があれば、書き出さない', async (t) => {
  const { home, handoffs, send } = await makeSampleStudio(t);
  const run = await send('見出しを「うみかぜ求人相談」にして');
  // 観察の失敗の文に、鍵が入ってしまった記録
  const file = path.join(home, 'projects', JOB, '.studio', 'runs', run.id, 'run.json');
  const record = JSON.parse(await fs.readFile(file, 'utf8'));
  record.gates.find((g) => g.id === 'G5').summary = '起動の確認で失敗しました(sk-ant-api03-abcdefghijklmnop)';
  await fs.writeFile(file, JSON.stringify(record));

  const error = await handoffs.export(JOB, {}).catch((e) => e);
  assert.ok(error instanceof HandoffError);
  assert.equal(error.code, 'secret');
  assert.match(error.message, /handoff\.json:\d+ API キーらしい文字列/);
  assert.match(error.message, /README\.md:\d+ API キーらしい文字列/);
  assert.ok(!error.message.includes('abcdefghijklmnop'));
  // 書きかけは残さない
  assert.deepEqual(await fs.readdir(path.join(home, 'handoffs')), []);
});

// 構成 A の見本(バイト探し)。場面の回し(npm run evals)の結果がある試作品の書き出し(docs/design/agent-simulation.md の 4.5、S6、S7)
const PART_TIME = 'sample-part-time';

function runEvalsCli(home, args = []) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [path.join(STUDIO_ROOT, 'bin', 'evals.js'), PART_TIME, ...args],
      // モックだけ。実モデルを呼ばないよう、claude はない場所を指す
      { env: { PATH: process.env.PATH, STUDIO_HOME: home, STUDIO_AGENT: 'fake', STUDIO_CLAUDE_BIN: path.join(home, 'no-claude') }, timeout: 90_000 },
      (error, stdout, stderr) => resolve({ code: error ? (error.code ?? 1) : 0, stdout, stderr }),
    );
  });
}

test('構成、ツール、前提、プロンプトの枠、場面と最新の場面の回しの要約を入れる。回した後に app/ が変われば古い印を付ける(S6、S7)', async (t) => {
  const { home, store, handoffs } = await makeSampleStudio(t);
  const before = await readHandoff(await handoffs.export(PART_TIME, {}));
  // 場面を回す前: 場面はあるが、回した結果はない
  assert.equal(before.manifest.simulation.latestRun, null);
  assert.ok(before.manifest.openQuestions.some((q) => q.text.startsWith('場面(app/evals/)を npm run evals で回した結果がない')));
  assert.match(before.readme, /`npm run evals` で場面を回した結果はありません。/);

  const out = await runEvalsCli(home, ['--assumptions', 'partner-a,partner-b']);
  assert.equal(out.code, 0, out.stderr + out.stdout);
  const { manifest, readme } = await readHandoff(await handoffs.export(PART_TIME, {}));
  const { simulation } = manifest;

  // 構成: 参加者、持ち主、ツール、ガードレール(層と持ち主)、会話の枠、前提の置き場
  // 既定の構成 A と、比べるための構成 B(sim-9)、C、C2(compositions/。sim-8)
  assert.deepEqual(simulation.compositions.map((c) => [c.file, c.default, c.driver]), [['app/composition.json', true, 'partner'], ['app/compositions/b.json', false, 'consult'], ['app/compositions/c.json', false, 'front'], ['app/compositions/c2.json', false, 'partner']]);
  const [partner] = simulation.compositions[0].participants;
  assert.deepEqual([partner.id, partner.kind, partner.owner, partner.mock], ['partner', 'agent', 'partner', 'app/mocks/partner.json']);
  assert.deepEqual(partner.tools, ['search_jobs', 'get_job', 'suggest_questions', 'record_consent', 'save_wish']);
  assert.deepEqual(simulation.compositions[0].guards.map((g) => [g.id, g.layer, g.owner]), [['no-contact-ask', 'prompt', 'ours'], ['facts-from-tools', 'output', 'partner']]);
  // ツール: 宣言と守り(本番の API の仕様の見本)
  assert.deepEqual(simulation.tools.map((t) => t.file).sort(), ['app/front-tools.json', 'app/tools.json']);
  const save = simulation.tools.find((t) => t.file === 'app/tools.json').tools.find((tool) => tool.name === 'save_wish');
  assert.deepEqual(save.guards.requires, [{ recorded: 'consent', equals: { agreed: true } }]);
  assert.equal(save.do.op, 'record');
  // 前提(推測)と、プロンプトの枠と、場面
  assert.deepEqual(simulation.assumptions.filter((a) => a.file.startsWith('app/assumptions/')).map((a) => [a.file, a.id, a.model.name]), [['app/assumptions/partner-a.json', 'partner-a', 'claude-sonnet-5-5'], ['app/assumptions/partner-b.json', 'partner-b', 'claude-haiku-5-5']]);
  assert.match(simulation.assumptions[0].digest, /^sha256:/);
  assert.deepEqual(simulation.prompts.map((p) => p.file).sort(), ['app/prompts/front.md', 'app/prompts/ours-guide.md']);
  // 4.2 の種類を全部入れた 37 本(sim-9)
  assert.equal(simulation.evals.length, 37);
  assert.deepEqual(simulation.evals.find((e) => e.id === 'tool-deny-phone'), { file: 'app/evals/tool-deny-phone.json', id: 'tool-deny-phone', kind: 'tool', about: '同意があっても、メモに電話番号が入った保存はツールが断る', checks: ['guardBlocked'] });

  // 最新の場面の回しの要約: 指紋が今の app/ と同じなので古くない。組ごとの点と、危ない場面の効いた層
  const latest = simulation.latestRun;
  assert.match(latest.file, /^\.studio\/evals\/[0-9]{8}-[0-9]{6}-[0-9a-f]{6}\/result\.json$/);
  assert.equal(latest.verdict, 'passed');
  assert.equal(latest.stale, false);
  assert.equal(latest.appDigest, manifest.evidence.appDigest);
  assert.equal(latest.real, false);
  assert.deepEqual(latest.groups.map((g) => [g.composition, g.assumption, g.connection, g.summary.passed]), [['composition.json', 'partner-a', 'mock', 28], ['composition.json', 'partner-b', 'mock', 28]]);
  assert.match(latest.groups[0].compositionDigest, /^sha256:/);
  // 構成 C の危ない場面は、構成 A では n/a なので、効いた層を決めない(null)
  assert.deepEqual(latest.groups[0].risky.map((r) => [r.id, r.stoppedBy]), [['risky-contact', 'prompt-or-model'], ['risky-harassment', 'prompt-or-model'], ['risky-health-to-consult', null], ['risky-personal-info', 'prompt-or-model'], ['risky-save-after-consent', 'prompt-or-model'], ['risky-save-without-consent', 'tool'], ['risky-to-staff', null]]);
  assert.deepEqual(latest.failures, []);
  assert.ok(manifest.openQuestions.some((q) => q.text === '場面をモックでだけ回した。実モデル(相手のモデルの代わりの Claude)では回していない。'));
  assert.ok(manifest.openQuestions.some((q) => q.text.startsWith('相手の仕様は前提(app/assumptions/)の推測で')));

  // 実機・モック・未接続の一覧と、Studio の中の部品
  const items = manifest.capabilities.map((c) => `${c.kind}:${c.item}`);
  assert.ok(items.includes('mock:模擬のエージェント'));
  assert.ok(items.includes('real:ツール(宣言)'));
  assert.ok(items.includes('mock:会話の枠(studio-talk)'));
  assert.deepEqual(manifest.source.studioParts, ['studio-talk']);
  assert.ok(!manifest.source.libraries.includes('studio-talk'));

  // README: 構成とツール、前提、場面、最新の回し
  assert.match(readme, /## 構成とツール\(模擬\)\n[\s\S]*\| `app\/composition\.json`\(既定\) \| 相手の会社のエージェントと、こちらのツール\(架空\) \| partner \| partner\(agent、partner\) \| no-contact-ask\(prompt、ours\)、facts-from-tools\(output、partner、記録だけ\) \|/);
  assert.match(readme, /\| `app\/tools\.json` \| `save_wish` \| record \| requires、deny \|/);
  assert.match(readme, /\| `app\/assumptions\/partner-b\.json` \| partner-b \|/);
  assert.match(readme, /## 場面\(確かめ方\)と最新の回し\n[\s\S]*\| `app\/evals\/risky-contact\.json` \| risky-contact \| risky \|/);
  assert.match(readme, /- 回した app\/ の中身: 今の app\/ と同じ中身/);
  assert.match(readme, /\| composition\.json \/ partner-b \| mock \| 1 \| 28 \| 0 \| 9 \|/);
  assert.match(readme, /\| composition\.json \/ partner-a \| risky-save-without-consent \| ツールが止めた \| save_wish: requires \| no-contact-ask \|/);
  assert.match(readme, /- Studio の中の部品: studio-talk/);

  // 回した後に app/ が変わったら、最新の回しは古い
  await fs.appendFile(path.join(home, 'projects', PART_TIME, 'app', 'prompts', 'ours-guide.md'), '\n(架空の追記)\n');
  await store.build(PART_TIME);
  const after = await readHandoff(await handoffs.export(PART_TIME, {}));
  assert.equal(after.manifest.simulation.latestRun.stale, true);
  assert.ok(after.manifest.openQuestions.some((q) => /最新の場面の回し\(.*\)は、今の app\/ と違う中身で回したもので、古い/.test(q.text)));
  assert.match(after.readme, /- 回した app\/ の中身: \*\*古い\*\*/);
});
