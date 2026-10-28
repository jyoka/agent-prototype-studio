import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildApp } from '../../src/server/build.js';
import { BuildRequests } from '../../src/server/build-requests.js';
import { parseAiDefinition } from '../../src/server/product-ai/definition.js';
import { AiSessions } from '../../src/server/product-ai/session.js';
import { describeSimulationChanges, referencedFiles, weakenedAiRules } from '../../src/server/sim/changes.js';
import { compositionB } from '../../src/server/sim/composition.js';

// 構成のデータの形と検査、構成 B の読み替え(docs/design/agent-simulation.md の 2 節、7.3 の sim-1)。
// データは設計の 2.4、2.5、3.3、3.4、4.2 の例を元にした架空のもの

const MAIN = 'import { createRoot } from "react-dom/client";\ncreateRoot(document.body).render(<p>hi</p>);\n';

const AI = {
  name: '相談役(架空)',
  fields: [
    { key: 'area', label: '場所', options: [{ value: 'みなと町', keywords: ['みなと'] }, { value: 'もり台', keywords: ['もり'] }] },
    { key: 'minWage', label: '時給の下限', type: 'number', unit: '円', min: 900, max: 3000 },
  ],
};

const JOBS = [
  { id: 'j1', title: '架空の品出し', area: 'みなと町', wage: 1100, days: ['土', '日'], contact: '架空の窓口' },
  { id: 'j2', title: '架空の受付', area: 'もり台', wage: 1200, days: ['月'], contact: '架空の窓口' },
];

const TOOLS = {
  formatVersion: 1,
  owner: 'dip',
  tools: [
    {
      name: 'search_jobs',
      description: '架空の求人を、場所、時給、曜日で探す',
      inputSchema: {
        type: 'object',
        properties: {
          area: { type: 'string', enum: ['みなと町', 'もり台', 'かわべ市'] },
          minWage: { type: 'number', minimum: 900, maximum: 3000 },
          day: { type: 'string', enum: ['月', '火', '水', '木', '金', '土', '日'] },
        },
      },
      do: {
        op: 'search',
        data: 'data/jobs.json',
        match: { area: { field: 'area' }, minWage: { field: 'wage', atLeast: true }, day: { field: 'days', includes: true } },
        fields: ['id', 'title', 'area', 'wage'],
        limit: 5,
      },
      guards: { maxCallsPerConversation: 10 },
    },
    {
      name: 'get_job',
      description: '架空の求人を 1 つ、id で詳しく見る',
      inputSchema: { type: 'object', properties: { id: { type: 'string', maxLength: 10 } }, required: ['id'] },
      do: { op: 'get', data: 'data/jobs.json', key: 'id' },
      guards: { hideFields: ['contact'] },
    },
    {
      name: 'suggest_questions',
      description: 'DIP が聞いてほしいことの一覧を返す',
      inputSchema: { type: 'object', properties: {} },
      do: { op: 'fixed', data: 'data/questions.json' },
    },
    {
      name: 'record_consent',
      description: '希望を保存してよいと本人が言ったことを記録する',
      inputSchema: { type: 'object', properties: { agreed: { type: 'boolean' } }, required: ['agreed'] },
      do: { op: 'record', into: 'consent' },
    },
    {
      name: 'save_wish',
      description: '本人の希望を保存する',
      inputSchema: {
        type: 'object',
        properties: { area: { type: 'string', maxLength: 20 }, minWage: { type: 'number' }, note: { type: 'string', maxLength: 200 } },
      },
      do: { op: 'record', into: 'wishes' },
      guards: {
        requires: [{ recorded: 'consent', equals: { agreed: true } }],
        deny: [{ arg: 'note', looksLike: ['phone', 'email'], message: '電話番号とメールアドレスは保存できません' }],
      },
    },
    {
      name: 'handoff_to_consult',
      description: 'バイト探しの相談を相談役に引き継ぐ',
      inputSchema: { type: 'object', properties: { area: { type: 'string', maxLength: 20 }, minWage: { type: 'number' } } },
      do: { op: 'handoff', to: 'consult' },
    },
    {
      name: 'handoff_to_staff',
      description: '危ない話を担当者に引き継ぐ',
      do: { op: 'handoff', to: 'staff' },
    },
  ],
};

// 構成 A(2.2): 外のエージェントと DIP 役のツール
const COMPOSITION_A = {
  formatVersion: 1,
  name: '外のエージェントと DIP 役のツール(架空)',
  driver: 'partner',
  participants: [
    {
      id: 'partner',
      kind: 'agent',
      label: '相手のエージェント(模擬)',
      owner: 'partner',
      prompt: [
        { from: 'assumptions', key: 'hostPrompt', owner: 'partner' },
        { slot: 'dip-guide', owner: 'dip', file: 'prompts/dip-guide.md' },
      ],
      tools: ['search_jobs', 'get_job', 'suggest_questions', 'record_consent', 'save_wish'],
      mock: 'mocks/partner.json',
    },
  ],
  tools: 'tools.json',
  handoffs: [],
  guards: [
    { id: 'no-contact-ask', layer: 'prompt', owner: 'dip', on: 'partner', text: '電話番号やメールアドレスを聞かないでください。' },
    { id: 'facts-from-tools', layer: 'output', owner: 'partner', on: 'partner', enforce: false, rules: { noNewNumbers: true, forbidden: ['実在の会社名'] } },
  ],
  surface: { kind: 'talk', theme: 'talk' },
  assumptions: { dir: 'assumptions', default: 'partner-a' },
  limits: { maxTurns: 20, maxHandoffs: 3 },
};

// 構成 C(2.5): 受付から相談役と担当者へ引き継ぐ
const COMPOSITION_C = {
  formatVersion: 1,
  name: '受付、相談役、担当者の引き継ぎ(架空)',
  driver: 'front',
  participants: [
    {
      id: 'front',
      kind: 'agent',
      label: '受付(模擬)',
      owner: 'partner',
      prompt: [{ from: 'assumptions', key: 'hostPrompt', owner: 'partner' }, { slot: 'dip-front', owner: 'dip', text: '用件を聞いてください。' }],
      tools: ['handoff_to_consult', 'handoff_to_staff'],
    },
    { id: 'consult', kind: 'harness', label: '相談役', owner: 'dip', ai: 'ai.json', returnTo: 'front' },
    { id: 'staff', kind: 'human', label: '担当者(模擬)', owner: 'dip', mock: { reply: '担当の者です。お話を伺います。(模擬の返事)' } },
  ],
  tools: 'tools.json',
  handoffs: [
    { from: 'front', to: 'consult', carry: ['area', 'minWage'] },
    { from: 'front', to: 'staff' },
    { from: 'consult', to: 'front' },
  ],
  guards: [{ id: 'risky-to-staff', layer: 'prompt', owner: 'dip', on: 'front', text: '体調やハラスメントの話をされたら、handoff_to_staff を呼んでください。' }],
  surface: { kind: 'talk', theme: 'talk' },
  assumptions: { dir: 'assumptions', default: 'partner-a' },
};

const ASSUMPTION = {
  formatVersion: 1,
  id: 'partner-a',
  name: '相手の仕様の推測 A(架空)',
  note: '本物の仕様ではない。推測を 1 か所に置くためのファイル',
  model: { name: 'claude-sonnet-5-5', standIn: true },
  hostPrompt: 'あなたはトークアプリの公式アカウントで話す案内役です。短く、やさしく話してください。(架空の推測)',
  slots: { 'dip-guide': { maxChars: 1500 } },
  messageTypes: ['text', 'buttons'],
  messageLimits: { textMaxChars: 500, buttonsMax: 4, partsMax: 3 },
  toolCalling: { maxPerReply: 4, resultMaxChars: 4000, auth: 'bound-user', delayMs: 300, faults: [] },
  logging: { partnerSees: ['messages', 'toolCalls'], dipSees: ['toolCalls'] },
};

const MOCK = {
  formatVersion: 1,
  rules: [
    {
      when: { contains: ['探'] },
      call: { tool: 'search_jobs', args: { area: 'みなと町' } },
      reply: [{ kind: 'text', text: '{result.count}件ありました。' }, { kind: 'buttons', items: ['詳しく見る', '条件を変える'] }],
    },
    { when: { action: 'save' }, call: { tool: 'save_wish', args: { area: 'みなと町' } }, reply: [{ kind: 'text', text: '保存しました。' }] },
  ],
  otherwise: [{ kind: 'text', text: 'どのあたりで探していますか?' }],
};

const EVAL_ASIDE = {
  formatVersion: 1,
  id: 'aside-weather-01',
  kind: 'aside',
  about: '探している途中で、天気の話をされる',
  entry: 'partner',
  history: [{ role: 'user', text: 'バイトを探してる' }, { role: 'assistant', text: 'どのあたりで探していますか?' }],
  records: {},
  turns: [{ user: '今日は雨で寒いね' }],
  expect: [
    { check: 'noToolCall' },
    { check: 'replyMaxChars', value: 200 },
    { check: 'judge', aspect: 'naturalness', rubric: '天気の話に 1 文で応じてから、探す話に戻っているか', passAtLeast: 4 },
  ],
};

const EVAL_TOOL = {
  formatVersion: 1,
  id: 'tool-deny-phone',
  kind: 'tool',
  records: { consent: { agreed: true } },
  call: { tool: 'save_wish', args: { note: '090-0000-0000 に電話して' } },
  expect: [{ check: 'guardBlocked', layer: 'tool', guard: 'deny' }],
};

function filesA() {
  return {
    'main.jsx': MAIN,
    'ai.json': AI,
    'composition.json': COMPOSITION_A,
    'compositions/c.json': COMPOSITION_C,
    'tools.json': TOOLS,
    'data/jobs.json': JOBS,
    'data/questions.json': ['希望の場所', '希望の時給'],
    'prompts/dip-guide.md': '求人は、かならず search_jobs で探してください。\n聞くことに迷ったら suggest_questions を呼んでください。\n',
    'assumptions/partner-a.json': ASSUMPTION,
    'mocks/partner.json': MOCK,
    'evals/aside-weather-01.json': EVAL_ASIDE,
    'evals/tool-deny-phone.json': EVAL_TOOL,
  };
}

async function makeApp(t, files) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-composition-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const appDir = path.join(root, 'project', 'app');
  await fs.mkdir(appDir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    if (content === undefined) continue;
    await fs.mkdir(path.dirname(path.join(appDir, name)), { recursive: true });
    await fs.writeFile(path.join(appDir, name), typeof content === 'string' ? content : JSON.stringify(content));
  }
  return { root, appDir, buildsDir: path.join(root, 'project', '.studio', 'builds') };
}

// files の 1 つの JSON を写して変える
function edit(files, name, change) {
  const copy = structuredClone(files[name]);
  change(copy);
  return { ...files, [name]: copy };
}

async function build(t, files) {
  const { appDir, buildsDir } = await makeApp(t, files);
  return buildApp({ appDir, buildsDir });
}

test('構成 A と C、ツール、前提、モック、場面を読み、既定の値で埋める', async (t) => {
  const result = await build(t, filesA());
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  const { composition, compositions, tools, assumptions, mocks, evals } = result.simulation;
  assert.equal(composition.file, 'composition.json');
  assert.equal(composition.driver, 'partner');
  assert.deepEqual(composition.participants[0].prompt.map((p) => p.owner), ['partner', 'dip']);
  assert.equal(composition.participants[0].mock, 'mocks/partner.json');
  assert.deepEqual(composition.limits, { maxTurns: 20, maxHandoffs: 3 });
  assert.equal(composition.guards[1].enforce, false);
  assert.deepEqual(compositions.map((c) => c.file), ['compositions/c.json']);
  const c = compositions[0].composition;
  // 書かなかった項目は既定の値(持ち主は studio、上限は 30 と 3)
  assert.deepEqual(c.limits, { maxTurns: 30, maxHandoffs: 3 });
  assert.equal(c.participants.find((p) => p.id === 'staff').mock.reply, '担当の者です。お話を伺います。(模擬の返事)');
  assert.deepEqual(Object.keys(tools), ['tools.json']);
  assert.equal(tools['tools.json'].tools.length, 7);
  assert.equal(tools['tools.json'].tools.find((tool) => tool.name === 'handoff_to_staff').owner, 'dip');
  assert.deepEqual(tools['tools.json'].tools.find((tool) => tool.name === 'handoff_to_staff').inputSchema, { type: 'object', properties: {} });
  assert.deepEqual(assumptions.map((a) => a.assumption.id), ['partner-a']);
  assert.deepEqual(mocks.map((m) => m.file), ['mocks/partner.json']);
  assert.deepEqual(evals.map((e) => e.scenario.id), ['aside-weather-01', 'tool-deny-phone']);
  // 今のプロダクト内 AI(試す画面)は、構成があっても ai.json の harness のまま(会話の進め方は sim-4)
  assert.equal(result.ai.name, '相談役(架空)');
});

test('composition.json のない試作品は、ai.json の harness 1 つの構成(構成 B)として読む', async (t) => {
  const result = await build(t, { 'main.jsx': MAIN, 'ai.json': AI });
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.deepEqual(result.simulation.composition, {
    formatVersion: 1,
    name: '相談役(架空)',
    driver: 'main',
    participants: [{ id: 'main', kind: 'harness', label: '相談役(架空)', owner: 'studio', ai: 'ai.json', returnTo: null }],
    tools: null,
    handoffs: [],
    guards: [],
    surface: null,
    assumptions: null,
    limits: { maxTurns: 30, maxHandoffs: 3 },
    file: null,
  });
  assert.deepEqual(result.simulation.compositions, []);
  assert.deepEqual(result.simulation.evals, []);

  // ai.json もなければ、AI のない試作品
  const plain = await build(t, { 'main.jsx': MAIN });
  assert.equal(plain.ok, true);
  assert.equal(plain.simulation.composition, null);
  assert.equal(compositionB(null), null);
});

test('構成 B の studio.ai が返す会話の形は今と同じ(R2)', async (t) => {
  const result = await build(t, { 'main.jsx': MAIN, 'ai.json': AI });
  const { definition } = parseAiDefinition(JSON.stringify(AI));
  // ビルドが返す AI の設定は、ai.json をそのまま読んだものと同じ
  assert.deepEqual(result.ai, definition);
  const sessions = new AiSessions({ definitionOf: () => result.ai });
  const view = sessions.view('p');
  assert.deepEqual(Object.keys(view), ['connection', 'name', 'fields', 'state', 'messages', 'busy']);
  for (const key of ['participants', 'active', 'records']) assert.equal(Object.hasOwn(view, key), false, key);
  assert.ok(view.messages.every((message) => !Object.hasOwn(message, 'from') && !Object.hasOwn(message, 'parts')));
});

// 形の誤りは、ビルドの失敗(関門 G3、contract の段)として、どのファイルのどこがどう違うかを返す(S20)
const BROKEN = [
  // 知らない種類(kind、op、layer、check)
  ['参加者の kind が知らない種類', (f) => edit(f, 'composition.json', (c) => { c.participants[0].kind = 'bot'; }),
    'app/composition.json', /^participants\[0\]\.kind: "bot" は知らない種類です。使える種類: agent, harness, human/],
  ['ツールの op が知らない処理', (f) => edit(f, 'tools.json', (c) => { c.tools[2].do = { op: 'eval', value: 1 }; }),
    'app/tools.json', /^tools\[2\]\.do\.op: "eval" は知らない処理です。使える処理: search, get, record, fixed, handoff/],
  ['守りの layer が知らない層', (f) => edit(f, 'composition.json', (c) => { c.guards[0].layer = 'magic'; }),
    'app/composition.json', /^guards\[0\]\.layer: "magic" は知らない層です/],
  ['構成の守りに layer: tool', (f) => edit(f, 'composition.json', (c) => { c.guards[0].layer = 'tool'; }),
    'app/composition.json', /^guards\[0\]\.layer: ツールの守りは、tools\.json の各ツールの guards に書いてください/],
  ['場面の check が知らない確かめ', (f) => edit(f, 'evals/aside-weather-01.json', (c) => { c.expect[0] = { check: 'looksGood' }; }),
    'app/evals/aside-weather-01.json', /^expect\[0\]\.check: "looksGood" は知らない確かめです/],
  ['場面の kind が知らない種類', (f) => edit(f, 'evals/aside-weather-01.json', (c) => { c.kind = 'chat'; }),
    'app/evals/aside-weather-01.json', /^kind: "chat" は知らない場面の種類です/],
  ['ツールの守りが知らない守り', (f) => edit(f, 'tools.json', (c) => { c.tools[0].guards = { rateLimit: 3 }; }),
    'app/tools.json', /^tools\[0\]\.guards: "rateLimit" は知らない守りです/],
  ['モックの部品が知らない種類', (f) => edit(f, 'mocks/partner.json', (c) => { c.otherwise = [{ kind: 'video' }]; }),
    'app/mocks/partner.json', /^otherwise\[0\]\.kind: "video" は知らない部品の種類です/],
  // ない参加者とツール
  ['driver がない参加者', (f) => edit(f, 'composition.json', (c) => { c.driver = 'nobody'; }),
    'app/composition.json', /^driver: 「nobody」は participants にない参加者です/],
  ['辺の to がない参加者', (f) => edit(f, 'compositions/c.json', (c) => { c.handoffs[1].to = 'boss'; }),
    'app/compositions/c.json', /^handoffs\[1\]\.to: 「boss」は participants にない参加者です/],
  ['守りの on がない参加者', (f) => edit(f, 'composition.json', (c) => { c.guards[0].on = 'nobody'; }),
    'app/composition.json', /^guards\[0\]\.on: 「nobody」は participants にない参加者です/],
  ['渡すツールが tools.json にない', (f) => edit(f, 'composition.json', (c) => { c.participants[0].tools.push('delete_all'); }),
    'app/composition.json', /^participants\[0\]\.tools\[5\]: 「delete_all」は app\/tools\.json にないツールです/],
  ['モックが参加者の持たないツールを呼ぶ', (f) => edit(f, 'mocks/partner.json', (c) => { c.rules[0].call.tool = 'handoff_to_staff'; }),
    'app/composition.json', /^participants\[0\]\.mock: app\/mocks\/partner\.json の rules\[0\] が呼ぶ「handoff_to_staff」は、この参加者の tools にありません/],
  ['ツールだけの場面が tools.json にないツールを呼ぶ', (f) => edit(f, 'evals/tool-deny-phone.json', (c) => { c.call.tool = 'drop_table'; }),
    'app/evals/tool-deny-phone.json', /^call\.tool: 「drop_table」は tools\.json にないツールです/],
  ['前提の faults が tools.json にないツール', (f) => edit(f, 'assumptions/partner-a.json', (c) => { c.toolCalling.faults = [{ tool: 'nothing', onCall: 1 }]; }),
    'app/assumptions/partner-a.json', /^toolCalling\.faults\[0\]\.tool: 「nothing」は tools\.json にないツールです/],
  ['既定の前提がない', (f) => edit(f, 'composition.json', (c) => { c.assumptions.default = 'partner-z'; }),
    'app/composition.json', /^assumptions\.default: 「partner-z」は app\/assumptions\/ にない前提です/],
  ['agent がいるのに前提がない', (f) => edit(f, 'composition.json', (c) => { delete c.assumptions; }),
    'app/composition.json', /^assumptions: agent の参加者がいるときは/],
  ['受け渡す値が受け取る harness の項目にない', (f) => edit(f, 'compositions/c.json', (c) => { c.handoffs[0].carry.push('phone'); }),
    'app/compositions/c.json', /^handoffs\[0\]\.carry: 「phone」は app\/ai\.json の fields にない項目です/],
  ['requires が書く record のない記録を指す', (f) => edit(f, 'tools.json', (c) => { c.tools[4].guards.requires[0].recorded = 'agreement'; }),
    'app/tools.json', /^tools\[4\]\.guards\.requires\[0\]\.recorded: 「agreement」に書く record のツールがありません/],
  ['deny の arg が引数にない', (f) => edit(f, 'tools.json', (c) => { c.tools[4].guards.deny[0].arg = 'memo'; }),
    'app/tools.json', /^tools\[4\]\.guards\.deny\[0\]\.arg: "memo" は inputSchema の properties にない引数です/],
  ['search の match が引数にない', (f) => edit(f, 'tools.json', (c) => { c.tools[0].do.match.city = { field: 'area' }; }),
    'app/tools.json', /^tools\[0\]\.do\.match\.city: 「city」は inputSchema の properties にない引数です/],
  // 辺にない引き継ぎのツール
  ['引き継ぎのツールが辺にない', (f) => edit(f, 'compositions/c.json', (c) => { c.handoffs.splice(1, 1); }),
    'app/compositions/c.json', /^participants\[0\]\.tools\[1\]: 引き継ぎのツール「handoff_to_staff」は辺にありません。handoffs に \{ "from": "front", "to": "staff" \} を書いてください/],
  ['引き継ぎのツールの行き先がいない', (f) => edit(f, 'compositions/c.json', (c) => {
    c.participants.splice(2, 1);
    c.handoffs.splice(1, 1);
  }),
  'app/compositions/c.json', /^participants\[0\]\.tools\[1\]: 引き継ぎのツール「handoff_to_staff」の行き先「staff」は participants にない参加者です/],
  ['戻り先への辺がない', (f) => edit(f, 'compositions/c.json', (c) => { c.handoffs.splice(2, 1); }),
    'app/compositions/c.json', /^participants\[1\]\.returnTo: 戻るのも引き継ぎです/],
  // app/ の外のファイル
  ['ツールのデータが app/ の外', (f) => edit(f, 'tools.json', (c) => { c.tools[0].do.data = '../jobs.json'; }),
    'app/tools.json', /^tools\[0\]\.do\.data: app\/ の外は指せません/],
  ['構成の tools が app/ の外', (f) => edit(f, 'composition.json', (c) => { c.tools = '../../tools.json'; }),
    'app/composition.json', /^tools: app\/ の外は指せません/],
  ['プロンプトの枠のファイルが app/ の外', (f) => edit(f, 'composition.json', (c) => { c.participants[0].prompt[1].file = '/etc/hosts.md'; }),
    'app/composition.json', /^participants\[0\]\.prompt\[1\]\.file: .*絶対パスは使えません/],
  ['モックが app/ の外', (f) => edit(f, 'composition.json', (c) => { c.participants[0].mock = '../mocks/partner.json'; }),
    'app/composition.json', /^participants\[0\]\.mock: app\/ の外は指せません/],
  ['harness の ai が app/ の外', (f) => edit(f, 'compositions/c.json', (c) => { c.participants[1].ai = '../ai.json'; }),
    'app/compositions/c.json', /^participants\[1\]\.ai: app\/ の外は指せません/],
  ['前提の置き場所が app/ の外', (f) => edit(f, 'composition.json', (c) => { c.assumptions.dir = '../assumptions'; }),
    'app/composition.json', /^assumptions\.dir: app\/ の外は指せません/],
  // .js のデータ
  ['ツールのデータが .js', (f) => ({ ...edit(f, 'tools.json', (c) => { c.tools[0].do.data = 'data/jobs.js'; }), 'data/jobs.js': 'export default [];\n' }),
    'app/tools.json', /^tools\[0\]\.do\.data: \.json のファイルを指してください\(\.js などのコードは読みません\): data\/jobs\.js/],
  ['モックが .js', (f) => ({ ...edit(f, 'composition.json', (c) => { c.participants[0].mock = 'mocks/partner.js'; }), 'mocks/partner.js': 'export default {};\n' }),
    'app/composition.json', /^participants\[0\]\.mock: \.json のファイルを指してください/],
  ['場面のフォルダーに .js', (f) => ({ ...f, 'evals/more.js': 'export default [];\n' }),
    'app/evals/more.js', /^場面は \.json で書いてください\(\.js などのコードは読みません\)/],
  ['構成のフォルダーに .js', (f) => ({ ...f, 'compositions/d.js': 'export default {};\n' }),
    'app/compositions/d.js', /^構成は \.json で書いてください/],
  ['プロンプトの枠が .js', (f) => ({ ...edit(f, 'composition.json', (c) => { c.participants[0].prompt[1].file = 'prompts/guide.js'; }), 'prompts/guide.js': '1;\n' }),
    'app/composition.json', /^participants\[0\]\.prompt\[1\]\.file: \.md、\.txt のファイルを指してください/],
  ['search のデータが配列でない', (f) => ({ ...f, 'data/jobs.json': { items: [] } }),
    'app/tools.json', /^tools\[0\]\.do\.data: app\/data\/jobs\.json は、オブジェクトの配列/],
  // 名前と上限
  ['ツールの名前に , と空白', (f) => edit(f, 'tools.json', (c) => { c.tools[2].name = 'a,b c'; }),
    'app/tools.json', /^tools\[2\]\.name: "a,b c" は使えない名前です/],
  ['ツールの名前に *', (f) => edit(f, 'tools.json', (c) => { c.tools[2].name = 'mcp__*'; }),
    'app/tools.json', /^tools\[2\]\.name: "mcp__\*" は使えない名前です/],
  ['inputSchema に決まっていないキー', (f) => edit(f, 'tools.json', (c) => { c.tools[1].inputSchema.properties.id.pattern = '^j'; }),
    'app/tools.json', /^tools\[1\]\.inputSchema\.properties\.id: 「pattern」は使えない項目です/],
  ['inputSchema の外が object でない', (f) => edit(f, 'tools.json', (c) => { c.tools[1].inputSchema = { type: 'string' }; }),
    'app/tools.json', /^tools\[1\]\.inputSchema\.type: 一番外は "object" に/],
  ['前提の maxPerReply が上限を超える', (f) => edit(f, 'assumptions/partner-a.json', (c) => { c.toolCalling.maxPerReply = 9; }),
    'app/assumptions/partner-a.json', /^toolCalling\.maxPerReply: 1 から 8 までの整数/],
  ['前提の model.name が - で始まる', (f) => edit(f, 'assumptions/partner-a.json', (c) => { c.model.name = '--dangerously'; }),
    'app/assumptions/partner-a.json', /^model\.name: "--dangerously" は使えない名前です/],
  ['前提の hostPrompt が長すぎる', (f) => edit(f, 'assumptions/partner-a.json', (c) => { c.hostPrompt = 'あ'.repeat(8001); }),
    'app/assumptions/partner-a.json', /^hostPrompt: 長すぎます\(上限 8000 文字\)/],
  ['プロンプトの枠が前提の上限を超える', (f) => edit(f, 'assumptions/partner-a.json', (c) => { c.slots['dip-guide'].maxChars = 10; }),
    'app/composition.json', /^participants\[0\]\.prompt\[1\]: 枠「dip-guide」の文が、前提「partner-a」の上限を超えています/],
  ['参加者が 8 人を超える', (f) => edit(f, 'composition.json', (c) => {
    for (let i = 0; i < 8; i += 1) c.participants.push({ id: `extra-${i}`, kind: 'human' });
  }),
  'app/composition.json', /^participants: 1 個から 8 個までの参加者の配列/],
  ['モックの置き換えが決まっていない', (f) => edit(f, 'mocks/partner.json', (c) => { c.rules[0].reply[0].text = '{result.all}'; }),
    'app/mocks/partner.json', /^rules\[0\]\.reply\[0\]\.text: \{result\.all\} は使えない置き換えです/],
  ['構成に知らないキー', (f) => edit(f, 'composition.json', (c) => { c.script = 'run()'; }),
    'app/composition.json', /「script」は使えない項目です/],
  ['構成の formatVersion が違う', (f) => edit(f, 'composition.json', (c) => { c.formatVersion = 2; }),
    'app/composition.json', /^formatVersion: 1 にしてください\(今は 2\)/],
  ['構成の守りを harness に付ける', (f) => edit(f, 'compositions/c.json', (c) => { c.guards[0].on = 'consult'; }),
    'app/compositions/c.json', /^guards\[0\]\.on: 構成の guards は agent の参加者にだけ付けられます/],
  ['場面の id が重なる', (f) => edit(f, 'evals/tool-deny-phone.json', (c) => { c.id = 'aside-weather-01'; }),
    'app/evals/tool-deny-phone.json', /^id: 「aside-weather-01」は app\/evals\/aside-weather-01\.json と重なっています/],
  ['tools.json が JSON として読めない', (f) => ({ ...f, 'tools.json': '{ "formatVersion": 1,' }),
    'app/tools.json', /^JSON として読めません/],
];

for (const [name, change, file, expected] of BROKEN) {
  test(`構成の誤りはビルドの失敗になる: ${name}`, async (t) => {
    const result = await build(t, change(filesA()));
    assert.equal(result.ok, false, name);
    assert.equal(result.stage, 'contract');
    assert.ok(
      result.errors.some((e) => e.file === file && expected.test(e.text)),
      JSON.stringify(result.errors, null, 1),
    );
    assert.ok(result.errors.every((e) => e.stage === 'contract'));
  });
}

test('app/ の外の harness の設定は、受け渡す値の確かめでも読まない', async (t) => {
  const files = edit(filesA(), 'compositions/c.json', (c) => { c.participants[1].ai = '../../secret.json'; });
  const { root, appDir, buildsDir } = await makeApp(t, files);
  // app/ の外に、読まれてはいけない架空のファイルを置く
  await fs.writeFile(path.join(root, 'secret.json'), '架空の秘密 TOP-SECRET');
  const result = await buildApp({ appDir, buildsDir });
  assert.equal(result.ok, false);
  assert.equal(result.stage, 'contract');
  assert.ok(result.errors.some((e) => e.file === 'app/compositions/c.json' && /^participants\[1\]\.ai: app\/ の外は指せません/.test(e.text)));
  assert.ok(result.errors.every((e) => !e.file.includes('..') && !e.text.includes('TOP-SECRET')), JSON.stringify(result.errors));
});

const deep = (depth) => `${'['.repeat(depth)}1${']'.repeat(depth)}`;

// 形のおかしな値でも、ビルドの途中の問題(例外)でなく、契約の誤りとして返す
const ODD = [
  ['harness の ai が数', (f) => edit(f, 'compositions/c.json', (c) => { c.participants[1].ai = 5; }), /participants\[1\]\.ai: app\/ からの相対パスを/],
  ['inputSchema の required にオブジェクト', (f) => edit(f, 'tools.json', (c) => { c.tools[1].inputSchema.required = [{ toString: 1 }]; }), /required: 引数の名前\(文字列\)を並べてください/],
  ['前提の置き場所に \\0', (f) => edit(f, 'composition.json', (c) => { c.assumptions.dir = 'as\u0000x'; }), /assumptions\.dir: /],
  // JSON.stringify で書けない深さなので、ファイルの文を直に作る
  ['fixed の value の入れ子が深すぎる', (f) => {
    const tools = edit(f, 'tools.json', (c) => { c.tools[2].do = { op: 'fixed', value: 'DEEP' }; })['tools.json'];
    return { ...f, 'tools.json': JSON.stringify(tools).replace('"DEEP"', deep(100_000)) };
  }, /tools\[2\]\.do\.value: (入れ子が深すぎます|大きすぎます)/],
  ['driver に深い入れ子', (f) => ({ ...f, 'composition.json': JSON.stringify({ ...COMPOSITION_A, driver: 'DEEP' }).replace('"DEEP"', deep(100_000)) }),
    /^driver: \(読めない値\) は使えない名前です/],
];

for (const [name, change, expected] of ODD) {
  test(`形のおかしな値も契約の誤りになる: ${name}`, async (t) => {
    const result = await build(t, change(filesA()));
    assert.equal(result.ok, false);
    assert.equal(result.stage, 'contract', JSON.stringify(result.errors).slice(0, 500));
    assert.ok(result.errors.some((e) => expected.test(e.text)), JSON.stringify(result.errors).slice(0, 1000));
  });
}

test('構成のファイルがあれば、使われていない tools.json、前提、モックも検査する', async (t) => {
  const result = await build(t, {
    'main.jsx': MAIN,
    'ai.json': AI,
    'compositions/b.json': { formatVersion: 1, driver: 'main', participants: [{ id: 'main', kind: 'harness' }] },
    'tools.json': { formatVersion: 1, tools: [{ name: 'x', description: '架空', do: { op: 'nothing' } }] },
    'assumptions/a.json': { formatVersion: 1, id: 'Bad Id' },
    'mocks/m.json': { formatVersion: 1 },
  });
  assert.equal(result.ok, false);
  const found = result.errors.map((e) => `${e.file} ${e.text}`);
  assert.ok(found.some((line) => /^app\/tools\.json tools\[0\]\.do\.op: "nothing" は知らない処理です/.test(line)), found.join('\n'));
  assert.ok(found.some((line) => /^app\/assumptions\/a\.json id: "Bad Id" は使えない名前です/.test(line)), found.join('\n'));
  assert.ok(found.some((line) => /^app\/mocks\/m\.json otherwise: 1 個から 5 個までの部品の配列/.test(line)), found.join('\n'));
});

test('構成のファイルがない試作品は、画面のデータの tools.json、mocks/、assumptions/ を読まない(R2)', async (t) => {
  // 今の試作品が、画面のための架空のデータを同じ名前で置いていても、ビルドは今までどおり通る
  const result = await build(t, {
    'main.jsx': MAIN,
    'ai.json': AI,
    'tools.json': [{ name: '架空の金づち' }],
    'mocks/users.json': [{ name: '架空の利用者' }],
    'mocks/api.js': 'export const users = [];\n',
    'assumptions/notes.json': { memo: '架空' },
  });
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(result.simulation.composition.file, null);
  assert.deepEqual(result.simulation.tools, {});
  assert.deepEqual(result.simulation.mocks, []);
});

test('場面の entry の参加者が構成にいなくても誤りにしない(その構成では n/a にする。R5)', async (t) => {
  const result = await build(t, edit(filesA(), 'evals/aside-weather-01.json', (c) => { c.entry = 'front'; }));
  assert.equal(result.ok, true, JSON.stringify(result.errors));
});

// 構成とガードレールの変化を、作る会話に出す。ガードレールが減ったら印を付ける
async function simulationOf(t, files) {
  const result = await build(t, files);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  return result;
}

test('構成 B どうしなら、構成の変化は出さない(ai.json の変化は今の文のまま)', async (t) => {
  const before = await simulationOf(t, { 'main.jsx': MAIN, 'ai.json': AI });
  const after = await simulationOf(t, { 'main.jsx': MAIN, 'ai.json': { ...AI, name: '別の相談役(架空)' } });
  assert.deepEqual(describeSimulationChanges(before.simulation, after.simulation), { lines: [], weakened: [] });
});

test('構成 B から構成 A にすると、既定の構成と足したツールを出す', async (t) => {
  const before = await simulationOf(t, { 'main.jsx': MAIN, 'ai.json': AI });
  const after = await simulationOf(t, filesA());
  const { lines, weakened } = describeSimulationChanges(before.simulation, after.simulation);
  assert.equal(lines[0], '既定の構成: 構成 B の読み替え(ai.json の harness 1 つ) → app/composition.json「外のエージェントと DIP 役のツール(架空)」');
  assert.ok(lines.includes('足した参加者: 「相手のエージェント(模擬)」(partner、模擬のエージェント)'), lines.join('\n'));
  assert.ok(lines.includes('なくした参加者: 「相談役(架空)」(main、harness)'), lines.join('\n'));
  assert.ok(lines.some((line) => /^足した守り「no-contact-ask」\(プロンプトの頼み、持ち主 dip、partner に\)/.test(line)), lines.join('\n'));
  assert.ok(lines.some((line) => /^足したツール: 「search_jobs」、「get_job」/.test(line)), lines.join('\n'));
  assert.ok(lines.includes('比べるための構成に足した: app/compositions/c.json'), lines.join('\n'));
  assert.deepEqual(weakened, []);
});

test('ガードレールを外す、弱めると、weakened に分けて出す', async (t) => {
  const before = await simulationOf(t, filesA());
  let files = edit(filesA(), 'tools.json', (c) => {
    delete c.tools[4].guards.requires;
    c.tools[1].guards = {};
    c.tools[0].guards.maxCallsPerConversation = 50;
  });
  files = edit(files, 'composition.json', (c) => {
    c.guards = c.guards.filter((g) => g.id !== 'no-contact-ask');
    c.guards[0].rules.forbidden = [];
    c.guards.push({ id: 'short', layer: 'output', on: 'partner', rules: { maxReplyChars: 300 } });
    c.participants[0].tools = c.participants[0].tools.filter((name) => name !== 'get_job');
  });
  const after = await simulationOf(t, files);
  const { lines, weakened } = describeSimulationChanges(before.simulation, after.simulation);
  assert.deepEqual(weakened, [
    'なくした守り「no-contact-ask」(プロンプトの頼み、持ち主 dip、partner に)',
    '守り「facts-from-tools」の禁止の言葉(forbidden)から外した: 「実在の会社名」',
    'ツール「search_jobs」の守り maxCallsPerConversation: 10 → 50',
    'ツール「get_job」の守り hideFields から外した(結果に出るようになった項目): 「contact」',
    'ツール「save_wish」の守り requires から外した: {"recorded":"consent","equals":{"agreed":true}}',
  ]);
  assert.ok(lines.includes('足した守り「short」(出口の確かめ、持ち主 studio、partner に)'), lines.join('\n'));
  assert.ok(lines.includes('参加者「相手のエージェント(模擬)」(partner)に渡すツールから外した: 「get_job」'), lines.join('\n'));

  // 止める確かめを記録だけにするのも、弱めたことになる
  const enforced = await simulationOf(t, edit(filesA(), 'composition.json', (c) => { c.guards[1].enforce = true; }));
  const recorded = await simulationOf(t, filesA());
  assert.deepEqual(describeSimulationChanges(enforced.simulation, recorded.simulation).weakened, [
    '守り「facts-from-tools」: 止める → 記録だけ(enforce: false)',
  ]);

  // 構成をなくすと、構成のガードレールもなくなる
  // (構成がなければツールの宣言を読まないので、ツールだけの場面も外す)
  const removed = await simulationOf(t, { ...filesA(), 'composition.json': undefined, 'compositions/c.json': undefined, 'evals/tool-deny-phone.json': undefined });
  const change = describeSimulationChanges(before.simulation, removed.simulation);
  assert.equal(change.lines[0], '既定の構成: app/composition.json「外のエージェントと DIP 役のツール(架空)」 → 構成 B の読み替え(ai.json の harness 1 つ)');
  assert.equal(change.weakened.length, 2);
});

test('出口の確かめを頼みに替える、付ける参加者を替える、ほかの harness の rules を弱めると、weakened に出す。断る文だけの変更は出さない', async (t) => {
  const before = await simulationOf(t, filesA());
  const after = await simulationOf(t, edit(edit(filesA(), 'composition.json', (c) => {
    c.guards[1] = { id: 'facts-from-tools', layer: 'prompt', on: 'partner', owner: 'partner', text: 'ツールの結果だけを話してください。' };
    c.participants.push({ id: 'partner-b', kind: 'agent', prompt: [{ from: 'assumptions', key: 'hostPrompt' }] });
    c.guards[0].on = 'partner-b';
  }), 'tools.json', (c) => { c.tools[4].guards.deny[0].message = '架空の別の断る文'; }));
  const { lines, weakened } = describeSimulationChanges(before.simulation, after.simulation);
  assert.deepEqual(weakened, [
    '守り「no-contact-ask」を付ける参加者: partner → partner-b(partner には効かなくなります)',
    '守り「facts-from-tools」の層: 出口の確かめ → プロンプトの頼み',
  ]);
  assert.ok(lines.includes('ツール「save_wish」の守り deny の断るときの文を変えました'), lines.join('\n'));

  // 目録の ai でない harness の設定(構成 C の相談役が別のファイルを使うとき)
  const withConsult = (rules) => edit({ ...filesA(), 'agents/consult.json': { ...AI, formatVersion: 2, rules } }, 'compositions/c.json', (c) => {
    c.participants[1].ai = 'agents/consult.json';
  });
  const strict = await simulationOf(t, withConsult({ noNewNumbers: true }));
  const loose = await simulationOf(t, withConsult({ noNewNumbers: false }));
  const change = describeSimulationChanges(strict.simulation, loose.simulation);
  assert.ok(change.lines.includes('harness の設定 app/agents/consult.json を変えました'), change.lines.join('\n'));
  assert.deepEqual(change.weakened, ['app/agents/consult.json の守ること「数字を作らない(noNewNumbers)」: する → しない']);
  // 構成が指すファイル(ツールのデータ、プロンプトの枠、モック、harness の設定)。構成 B の読み替えは入れない
  assert.deepEqual(referencedFiles(strict.simulation).sort(), [
    'app/agents/consult.json', 'app/data/jobs.json', 'app/data/questions.json', 'app/mocks/partner.json', 'app/prompts/dip-guide.md',
  ]);
  assert.deepEqual(referencedFiles((await simulationOf(t, { 'main.jsx': MAIN, 'ai.json': AI })).simulation), []);
});

test('比べるための構成の守りを外すと、どの構成かを頭に付けて weakened に出す', async (t) => {
  const before = await simulationOf(t, filesA());
  const after = await simulationOf(t, edit(filesA(), 'compositions/c.json', (c) => {
    c.guards = [];
    c.handoffs[0].carry = ['area'];
  }));
  const { lines, weakened } = describeSimulationChanges(before.simulation, after.simulation);
  assert.deepEqual(weakened, ['app/compositions/c.json: なくした守り「risky-to-staff」(プロンプトの頼み、持ち主 dip、front に)']);
  assert.deepEqual(lines, ['app/compositions/c.json: 辺 front → consult で受け渡す値(carry): area、minWage → area']);
});

test('比べるための構成だけが使うツールの守りを外すと、ファイル名と使う構成を頭に付けて weakened に出す', async (t) => {
  // 既定の構成は構成 B の読み替え(composition.json がない)で、tools.json を使うのは構成 C だけ
  const withoutDefault = { ...filesA(), 'composition.json': undefined };
  const before = await simulationOf(t, withoutDefault);
  const after = await simulationOf(t, edit(withoutDefault, 'tools.json', (c) => { delete c.tools[4].guards.deny; }));
  const { lines, weakened } = describeSimulationChanges(before.simulation, after.simulation);
  assert.equal(weakened.length, 1);
  assert.match(weakened[0], /^app\/tools\.json\(app\/compositions\/c\.json が使う\): ツール「save_wish」の守り deny から外した: /);
  assert.deepEqual(lines, []);

  // 作る会話にも、印を付けて出す
  const items = [];
  const fake = {
    store: { aiDefinition: () => after.ai, simulation: () => after.simulation },
    addItem: (id, run, kind, text) => items.push({ kind, text }),
  };
  const run = { changedFiles: [{ file: 'app/tools.json', change: 'modified' }] };
  BuildRequests.prototype.reportAiChanges.call(fake, 'p', run, { ai: before.ai, simulation: before.simulation }, true);
  assert.equal(items.length, 1);
  assert.match(items[0].text, /^【ガードレールが減りました】/);
});

test('ai.json の rules(構成 B の出口の確かめ)を弱めると、weakened に出す', () => {
  const read = (rules) => {
    const { definition, errors } = parseAiDefinition(JSON.stringify({ ...AI, formatVersion: 2, rules }));
    assert.deepEqual(errors, []);
    return definition;
  };
  assert.deepEqual(weakenedAiRules(read({}), read({ noNewNumbers: false, maxReplyChars: 1500, forbidden: [] })), [
    'ai.json の守ること「数字を作らない(noNewNumbers)」: する → しない',
    'ai.json の守ること「返事の長さの上限(maxReplyChars)」: 1000 文字 → 1500 文字',
  ]);
  assert.deepEqual(weakenedAiRules(read({ forbidden: ['架空の禁句'] }), read({})), ['ai.json の守ること「禁止の言葉(forbidden)」から外した: 「架空の禁句」']);
  assert.deepEqual(weakenedAiRules(read({}), read({ maxReplyChars: 500 })), []);
});

test('作る会話には、構成の変化と、ガードレールが減った印を出す', async (t) => {
  const before = await simulationOf(t, filesA());
  const after = await simulationOf(t, edit(filesA(), 'tools.json', (c) => {
    delete c.tools[4].guards.deny;
    c.tools.push({ name: 'fixed_hello', description: '架空のあいさつ', do: { op: 'fixed', value: 'こんにちは' } });
  }));
  const items = [];
  const fake = {
    store: { aiDefinition: () => after.ai, simulation: () => after.simulation },
    addItem: (id, run, kind, text) => items.push({ kind, text }),
  };
  const run = { changedFiles: [{ file: 'app/tools.json', change: 'modified' }] };
  BuildRequests.prototype.reportAiChanges.call(fake, 'p', run, { ai: before.ai, simulation: before.simulation }, true);
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, 'ai-settings');
  const lines = items[0].text.split('\n');
  assert.match(lines[0], /^【ガードレールが減りました】/);
  assert.match(lines[1], /^- ツール「save_wish」の守り deny から外した: /);
  assert.ok(lines.includes('構成、ツール、ガードレールが変わりました。Studio が前と比べた結果:'), items[0].text);
  assert.ok(lines.includes('- 足したツール: 「fixed_hello」'), items[0].text);

  // ビルドに失敗したら、構成は前のままと出す
  items.length = 0;
  BuildRequests.prototype.reportAiChanges.call(fake, 'p', run, { ai: before.ai, simulation: before.simulation }, false);
  assert.deepEqual(items, [{ kind: 'ai-settings', text: 'app/tools.json が変わりましたが、ビルドに失敗したので、構成は前のままです。' }]);
});
