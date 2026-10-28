import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { STUDIO_ROOT } from '../../src/server/config.js';
import { redactDeep } from '../../src/server/redact.js';
import { callTool, loadToolData } from '../../src/server/sim/tool-gate.js';
import { readTools } from '../../src/server/sim/tools.js';

// ツールの MCP サーバー(npm run tools:mcp -- <プロジェクト>、docs/design/agent-simulation.md の 3.6、7.3 の sim-3)。
// 子プロセスで起動し、stdio の JSON-RPC でツールを呼ぶ。模擬のエージェント(Claude Code)が使う形と同じ。
// モデルは呼ばない。データは架空のもの
const SERVER = path.join(STUDIO_ROOT, 'bin', 'tools-mcp.js');
const REQUEST_TIMEOUT_MS = 10_000;
const EXIT_TIMEOUT_MS = 15_000;
const TEST_TIMEOUT_MS = 60_000;

const JOBS = [
  { id: 'j1', title: '架空の品出し', area: 'みなと町', wage: 1100, contact: '架空の窓口 A' },
  { id: 'j2', title: '架空の受付', area: 'もり台', wage: 1200, contact: '架空の窓口 B' },
  { id: 'j3', title: '架空の配膳', area: 'みなと町', wage: 1000, contact: '架空の窓口 C' },
];

const TOOLS = {
  formatVersion: 1,
  owner: 'dip',
  tools: [
    {
      name: 'search_jobs',
      description: '架空の求人を、場所で探す',
      inputSchema: { type: 'object', properties: { area: { type: 'string', enum: ['みなと町', 'もり台'] } } },
      do: { op: 'search', data: 'data/jobs.json', match: { area: { field: 'area' } }, fields: ['id', 'title', 'wage'], sort: { field: 'wage', order: 'desc' } },
      guards: { maxCallsPerConversation: 3 },
    },
    {
      name: 'get_job',
      description: '架空の求人を 1 つ、id で見る',
      inputSchema: { type: 'object', properties: { id: { type: 'string', maxLength: 10 } }, required: ['id'] },
      do: { op: 'get', data: 'data/jobs.json', key: 'id' },
      guards: { hideFields: ['contact'] },
    },
    {
      name: 'save_consent',
      description: '連絡の同意を記録する',
      inputSchema: { type: 'object', properties: { agreed: { type: 'boolean' } }, required: ['agreed'] },
      do: { op: 'record', into: 'consent', mode: 'append' },
    },
    {
      name: 'save_wish',
      description: '希望を記録する。同意の後だけ',
      inputSchema: { type: 'object', properties: { area: { type: 'string' }, note: { type: 'string', maxLength: 100 } } },
      do: { op: 'record', into: 'wish' },
      guards: {
        requires: [{ recorded: 'consent', equals: { agreed: true } }],
        deny: [{ arg: 'note', looksLike: ['phone', 'email'], message: '連絡先は書かないでください' }],
      },
    },
    {
      name: 'opening_hours',
      description: '架空の窓口の受付時間を返す',
      do: { op: 'fixed', value: { open: '10:00', close: '18:00' } },
    },
  ],
};
const TOOL_NAMES = TOOLS.tools.map((tool) => tool.name);

// 呼び出しの並び。結果、守り、誤り、知らないツール、形の誤りを一通り通す
const CALLS = [
  ['search_jobs', { area: 'みなと町' }],
  ['get_job', { id: 'j2' }],
  ['save_wish', { area: 'みなと町' }],
  ['save_consent', { agreed: true }],
  ['save_wish', { area: 'みなと町', note: '架空の 090-1234-5678 に' }],
  ['save_wish', { area: 'みなと町', note: '土日だけ' }],
  ['get_job', { id: 'j9' }],
  ['search_jobs', { area: 'かわべ市' }],
  ['search_jobs', { place: 'みなと町' }],
  ['search_jobs', {}],
  ['delete_all', {}],
  ['opening_hours', {}],
];

let tmp;
let home;

test.before(async () => {
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'prototype-studio-tools-mcp-test-')));
  home = path.join(tmp, 'home');
  await fs.mkdir(home);
});

test.after(async () => {
  if (tmp) await fs.rm(tmp, { recursive: true, force: true });
});

let projectCount = 0;
async function makeProject({ tools = TOOLS, parent = tmp, name } = {}) {
  projectCount += 1;
  const root = path.join(parent, name ?? `project-${projectCount}`);
  await fs.mkdir(path.join(root, 'app', 'data'), { recursive: true });
  if (tools !== null) await fs.writeFile(path.join(root, 'app', 'tools.json'), typeof tools === 'string' ? tools : JSON.stringify(tools, null, 2));
  await fs.writeFile(path.join(root, 'app', 'data', 'jobs.json'), JSON.stringify(JOBS, null, 2));
  return root;
}

const simDir = (project, conversation) => path.join(project, '.studio', 'sim', conversation);
const readJson = async (file) => JSON.parse(await fs.readFile(file, 'utf8'));
const readLines = async (file) => (await fs.readFile(file, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
const exists = (file) => fs.lstat(file).then(() => true, () => false);

// 動いていないプロセスの番号(すぐ終わる子プロセスの番号)
function deadPid() {
  const { pid } = spawnSync(process.execPath, ['-e', '']);
  return pid;
}

// MCP の相手(模擬のエージェントの代わり)。1 行に 1 つのメッセージを書き、id ごとに答えを待つ
function startServer(args, { command = process.execPath, prefix = [SERVER], cwd = STUDIO_ROOT } = {}) {
  const child = spawn(command, [...prefix, ...args], {
    cwd,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, STUDIO_HOME: home, STUDIO_AGENT: 'fake' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const waiting = new Map();
  const others = [];
  let stderr = '';
  let buffer = '';
  let nextId = 0;
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  child.stdin.on('error', () => {});
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const message = JSON.parse(buffer.slice(0, index));
      buffer = buffer.slice(index + 1);
      if (waiting.has(message.id)) waiting.get(message.id)(message);
      else others.push(message);
    }
  });
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));

  const send = (line) => child.stdin.write(`${line}\n`);
  const rpc = (method, params) => {
    nextId += 1;
    const id = nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiting.delete(id);
        reject(new Error(`${method} の答えが ${REQUEST_TIMEOUT_MS / 1000} 秒で来ません。stderr: ${stderr}`));
      }, REQUEST_TIMEOUT_MS);
      timer.unref();
      waiting.set(id, (message) => {
        clearTimeout(timer);
        waiting.delete(id);
        resolve(message);
      });
      send(JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) }));
    });
  };

  // ツールを呼び、文の結果と、JSON として読めたときはその値を返す
  const call = async (name, args = {}) => {
    const response = await rpc('tools/call', { name, arguments: args });
    assert.equal(response.error, undefined, JSON.stringify(response.error));
    const { content, isError = false } = response.result;
    assert.equal(content.length, 1);
    assert.equal(content[0].type, 'text');
    return { isError, text: content[0].text };
  };

  // 終わるのを待つ。時間内に終わらなければ止める(失敗として扱う)
  const waitExit = async () => {
    let timer;
    const result = await Promise.race([
      exited,
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(null), EXIT_TIMEOUT_MS);
      }),
    ]);
    clearTimeout(timer);
    if (result === null) {
      child.kill('SIGKILL');
      await exited;
      throw new Error(`ツールのサーバーが ${EXIT_TIMEOUT_MS / 1000} 秒で終わりません。stderr: ${stderr}`);
    }
    return result;
  };
  const stop = () => {
    child.stdin.end();
    return waitExit();
  };

  const initialize = () => rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'tools-mcp-test', version: '1' } });
  return { child, rpc, send, call, stop, waitExit, exited, initialize, others, stderr: () => stderr };
}

// フォルダーの中のファイルと、その中身と時刻(指紋。変わっていないかを比べる)
async function fingerprint(dir) {
  const files = {};
  for (const name of (await fs.readdir(dir, { recursive: true })).sort()) {
    const file = path.join(dir, name);
    const stat = await fs.lstat(file);
    files[name] = stat.isFile() ? { mtimeMs: stat.mtimeMs, body: (await fs.readFile(file)).toString('base64') } : { kind: stat.isDirectory() ? 'dir' : 'other' };
  }
  return files;
}

// 同じ呼び出しの並びを、ツールの口に直接渡したときの結果と記録(呼び出しの数と記録の店をつないで回す)
async function directCalls(project, calls, { conversationId }) {
  const appDir = path.join(project, 'app');
  const { toolset } = await readTools(appDir, 'tools.json');
  const { data } = await loadToolData(appDir, toolset);
  let store = {};
  let counts = {};
  const results = [];
  for (const [name, args] of calls) {
    const outcome = await callTool({ tools: toolset, data, store, context: { conversationId, calls: counts }, name, args });
    store = outcome.store;
    counts = outcome.calls;
    results.push(outcome);
  }
  return { results, store, counts };
}

const withoutMs = ({ ms, ...rest }) => rest;

test('stdio の JSON-RPC で initialize、tools/list、tools/call に答え、一覧は tools.json の名前だけ', { timeout: TEST_TIMEOUT_MS }, async () => {
  const project = await makeProject();
  const server = startServer([project, '--conversation', 'list-1']);
  try {
    const init = await server.initialize();
    assert.equal(init.result.protocolVersion, '2025-06-18');
    assert.deepEqual(init.result.capabilities, { tools: { listChanged: false } });
    assert.equal(init.result.serverInfo.name, 'prototype-studio-tools');
    // 知らない版を頼まれたら、サーバーの新しい版を返す
    const other = await server.rpc('initialize', { protocolVersion: '1999-01-01' });
    assert.equal(other.result.protocolVersion, '2025-11-25');

    // 通知には答えない
    server.send(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }));
    assert.deepEqual((await server.rpc('ping')).result, {});

    const listed = (await server.rpc('tools/list')).result.tools;
    assert.deepEqual(listed.map((tool) => tool.name), TOOL_NAMES);
    for (const [i, tool] of listed.entries()) {
      assert.equal(tool.description, TOOLS.tools[i].description);
      assert.equal(tool.inputSchema.type, 'object');
      // ツールの口は inputSchema にない引数を断るので、一覧でもそれを示す
      assert.equal(tool.inputSchema.additionalProperties, false);
      assert.deepEqual(Object.keys(tool.inputSchema.properties), Object.keys(TOOLS.tools[i].inputSchema?.properties ?? {}));
    }
    // 観察の道具は出さない(3.6 の「一緒に渡さない」)
    for (const name of ['open', 'read_page', 'click', 'run_scenarios']) assert.ok(!listed.some((tool) => tool.name === name));

    const called = await server.call('opening_hours');
    assert.deepEqual({ isError: called.isError, value: JSON.parse(called.text) }, { isError: false, value: { open: '10:00', close: '18:00' } });

    assert.equal((await server.rpc('resources/list')).error.code, -32601);
    assert.equal((await server.rpc('tools/call', { arguments: {} })).error.code, -32602);
    server.send('{ 読めない');
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.ok(server.others.some((message) => message.error?.code === -32700));
    assert.ok(!server.others.some((message) => message.result !== undefined), '通知に答えを返しました');

    const exit = await server.stop();
    assert.deepEqual(exit, { code: 0, signal: null }, server.stderr());
  } finally {
    server.child.kill('SIGKILL');
  }
});

test('tools/call はツールの口と同じ結果と記録を返す(S5)', { timeout: TEST_TIMEOUT_MS }, async () => {
  const project = await makeProject();
  const conversationId = 'same-1';
  const server = startServer([project, '--conversation', conversationId]);
  const mcp = [];
  try {
    await server.initialize();
    for (const [name, args] of CALLS) mcp.push(await server.call(name, args));
    assert.deepEqual(await server.stop(), { code: 0, signal: null }, server.stderr());
  } finally {
    server.child.kill('SIGKILL');
  }

  const direct = await directCalls(project, CALLS, { conversationId });
  for (const [i, outcome] of direct.results.entries()) {
    const label = `${i + 1} 番目の呼び出し(${CALLS[i][0]})`;
    assert.equal(mcp[i].isError, !outcome.ok, label);
    if (outcome.ok) assert.deepEqual(JSON.parse(mcp[i].text), outcome.result, label);
    else assert.equal(mcp[i].text, outcome.error, label);
  }
  // 並びの中に、通った守り、断った守り、項目を除いた守り、ないツール、形の誤りが入っている
  const guardsSeen = direct.results.flatMap((outcome) => outcome.guards.map((guard) => `${guard.guard}:${guard.effect}`));
  for (const seen of ['requires:blocked', 'requires:passed', 'deny:blocked', 'deny:passed', 'hideFields:blocked', 'schema:blocked', 'maxCallsPerConversation:blocked']) {
    assert.ok(guardsSeen.includes(seen), `${seen} が並びにありません`);
  }

  // 呼び出しの記録(calls.jsonl)は、ツールの口の記録の 1 件と同じ。ほかに時刻と、伏せた結果の全文がある
  const dir = simDir(project, conversationId);
  const lines = await readLines(path.join(dir, 'calls.jsonl'));
  assert.equal(lines.length, CALLS.length);
  for (const [i, line] of lines.entries()) {
    const { at, output, ...entry } = line;
    assert.ok(!Number.isNaN(Date.parse(at)));
    assert.deepEqual(withoutMs(entry), withoutMs(direct.results[i].entry), `${i + 1} 番目の記録`);
    assert.deepEqual(output, direct.results[i].ok ? redactDeep(direct.results[i].result) : undefined);
  }
  // 引数の電話番号らしい文字は、記録では伏せる
  assert.ok(!JSON.stringify(lines).includes('090-1234-5678'));
  assert.ok(lines[4].args.note.includes('[伏せた: 電話番号]'));

  assert.deepEqual(await readJson(path.join(dir, 'store.json')), direct.store);
  assert.deepEqual(await readJson(path.join(dir, 'counts.json')), direct.counts);
});

test('app/ を書き換えず、書くのは .studio/sim/<会話の ID>/ だけ。記録の店を起動のときに読み、呼び出しのたびに書く(S13、S15)', { timeout: TEST_TIMEOUT_MS }, async () => {
  const project = await makeProject();
  const appBefore = await fingerprint(path.join(project, 'app'));
  const dir = simDir(project, 'talk-1');

  // 1 回目の起動(模擬のエージェントの 1 回目の返事)
  const first = startServer([project, '--conversation', 'talk-1']);
  try {
    await first.initialize();
    assert.equal((await first.call('save_wish', { area: 'みなと町' })).isError, true);
    // 答えが来た時点で、記録の店と呼び出しの数はもう書いてある
    assert.deepEqual(await readJson(path.join(dir, 'store.json')), {});
    assert.deepEqual(await readJson(path.join(dir, 'counts.json')), { save_wish: 1 });
    assert.equal((await first.call('save_consent', { agreed: true })).isError, false);
    assert.deepEqual(await readJson(path.join(dir, 'store.json')), { consent: [{ agreed: true }] });
    for (let i = 0; i < 3; i += 1) assert.equal((await first.call('search_jobs', {})).isError, false);
    assert.deepEqual(await readJson(path.join(dir, 'counts.json')), { save_wish: 1, save_consent: 1, search_jobs: 3 });
    // 動いている間は、ロックにこのサーバーのプロセスの番号がある
    assert.equal((await fs.readFile(path.join(dir, 'server.lock'), 'utf8')).trim(), String(first.child.pid));
    assert.deepEqual(await first.stop(), { code: 0, signal: null }, first.stderr());
  } finally {
    first.child.kill('SIGKILL');
  }

  // 2 回目の起動(同じ会話の次の返事)。前の起動の記録の店と呼び出しの数の続きから始める
  const second = startServer([project, '--conversation', 'talk-1']);
  try {
    await second.initialize();
    const saved = await second.call('save_wish', { area: 'もり台' });
    assert.deepEqual({ isError: saved.isError, value: JSON.parse(saved.text) }, { isError: false, value: { recorded: 'wish' } });
    const limited = await second.call('search_jobs', {});
    assert.equal(limited.isError, true);
    assert.match(limited.text, /3 回まで/);
    assert.deepEqual(await readJson(path.join(dir, 'store.json')), { consent: [{ agreed: true }], wish: { area: 'もり台' } });
    assert.deepEqual(await second.stop(), { code: 0, signal: null }, second.stderr());
  } finally {
    second.child.kill('SIGKILL');
  }
  assert.equal((await readLines(path.join(dir, 'calls.jsonl'))).length, 7);

  // 別の会話は、新しい記録の店と呼び出しの数で始める(S15)
  const fresh = startServer([project, '--conversation', 'talk-2']);
  try {
    await fresh.initialize();
    const blocked = await fresh.call('save_wish', { area: 'みなと町' });
    assert.equal(blocked.isError, true);
    assert.match(blocked.text, /記録「consent」がありません/);
    assert.equal((await fresh.call('search_jobs', {})).isError, false);
    assert.deepEqual(await fresh.stop(), { code: 0, signal: null }, fresh.stderr());
  } finally {
    fresh.child.kill('SIGKILL');
  }

  // Studio がメモリーの店を書いた store.json からも始められる
  const seeded = simDir(project, 'talk-3');
  await fs.mkdir(seeded, { recursive: true });
  await fs.writeFile(path.join(seeded, 'store.json'), JSON.stringify({ consent: [{ agreed: true }, { agreed: false }] }));
  const third = startServer([project, '--conversation', 'talk-3']);
  try {
    await third.initialize();
    // 最後の同意が取り消しなので、断る
    assert.equal((await third.call('save_wish', { area: 'みなと町' })).isError, true);
    assert.deepEqual(await third.stop(), { code: 0, signal: null }, third.stderr());
  } finally {
    third.child.kill('SIGKILL');
  }

  // app/ は変わらない。プロジェクトに増えたのは .studio/sim/<会話の ID>/ の 3 つのファイルだけ(ロックは消えている)
  assert.deepEqual(await fingerprint(path.join(project, 'app')), appBefore);
  const added = (await fs.readdir(project, { recursive: true })).filter((name) => !name.startsWith('app')).sort();
  const expected = ['.studio', '.studio/sim'];
  for (const conversation of ['talk-1', 'talk-2', 'talk-3']) {
    expected.push(`.studio/sim/${conversation}`, ...['calls.jsonl', 'counts.json', 'store.json'].map((file) => `.studio/sim/${conversation}/${file}`));
  }
  assert.deepEqual(added, expected.sort());
});

test('.studio/ の中のシンボリックリンクで app/ に向けられたら、起動せずに何も書かない(S13)', { timeout: TEST_TIMEOUT_MS }, async () => {
  // 会話のフォルダー、.studio/ そのもの、呼び出しの記録のファイルを、app/ に向ける
  const links = [
    { at: path.join('.studio', 'sim', 'evil'), to: 'app' },
    { at: '.studio', to: 'app' },
    { at: path.join('.studio', 'sim', 'evil', 'calls.jsonl'), to: path.join('app', 'tools.json') },
  ];
  for (const link of links) {
    const project = await makeProject();
    const appBefore = await fingerprint(path.join(project, 'app'));
    await fs.mkdir(path.dirname(path.join(project, link.at)), { recursive: true });
    await fs.symlink(path.join(project, link.to), path.join(project, link.at));
    const server = startServer([project, '--conversation', 'evil']);
    const exit = await server.waitExit();
    assert.equal(exit.code, 3, `${link.at}: ${server.stderr()}`);
    assert.match(server.stderr(), /シンボリックリンク|ファイルではありません/);
    assert.deepEqual(await fingerprint(path.join(project, 'app')), appBefore, link.at);
  }
});

test('時間の上限で終わり、ロックと書き途中のファイルを残さない', { timeout: TEST_TIMEOUT_MS }, async () => {
  const project = await makeProject();
  const dir = simDir(project, 'limit-1');
  const started = Date.now();
  const server = startServer([project, '--conversation', 'limit-1', '--max-seconds', '1']);
  try {
    await server.initialize();
    assert.equal((await server.call('save_consent', { agreed: true })).isError, false);
    // 入力は閉じないまま。上限で自分から終わる
    const exit = await server.waitExit();
    assert.deepEqual(exit, { code: 0, signal: null }, server.stderr());
    assert.ok(Date.now() - started < 10_000);
    assert.ok(server.stderr().includes('時間の上限(1 秒)で止めます'), server.stderr());
  } finally {
    server.child.kill('SIGKILL');
  }
  assert.deepEqual((await fs.readdir(dir)).sort(), ['calls.jsonl', 'counts.json', 'store.json']);
  assert.deepEqual(await readJson(path.join(dir, 'store.json')), { consent: [{ agreed: true }] });
});

test('SIGTERM と SIGINT で止められても、ロックを消して終わる', { timeout: TEST_TIMEOUT_MS }, async () => {
  const project = await makeProject();
  for (const signal of ['SIGTERM', 'SIGINT']) {
    const conversation = `stop-${signal.toLowerCase()}`;
    const server = startServer([project, '--conversation', conversation]);
    try {
      await server.initialize();
      assert.equal((await server.call('save_consent', { agreed: true })).isError, false);
      server.child.kill(signal);
      assert.deepEqual(await server.waitExit(), { code: 130, signal: null }, server.stderr());
    } finally {
      server.child.kill('SIGKILL');
    }
    const dir = simDir(project, conversation);
    assert.deepEqual((await fs.readdir(dir)).sort(), ['calls.jsonl', 'counts.json', 'store.json']);
    assert.deepEqual(await readJson(path.join(dir, 'store.json')), { consent: [{ agreed: true }] });
  }
});

test('前の起動が強制終了で残したロックと書き途中のファイルは、次の起動で消す。動いているサーバーの会話には起動しない', { timeout: TEST_TIMEOUT_MS }, async () => {
  const project = await makeProject();
  const dir = simDir(project, 'left-1');
  await fs.mkdir(dir, { recursive: true });
  const dead = deadPid();
  await fs.writeFile(path.join(dir, 'server.lock'), String(dead));
  await fs.writeFile(path.join(dir, `store.json.${dead}.0123abcd.tmp`), '{"half');
  // 動いているプロセス(このテスト)の書き途中のファイルと、名前の決まりに合わないファイルは消さない
  await fs.writeFile(path.join(dir, `counts.json.${process.pid}.89abcdef.tmp`), '{}');
  await fs.writeFile(path.join(dir, 'note.txt'), '架空のメモ');

  // 強制終了されたサーバー(SIGKILL では exit を通らない)
  const killed = startServer([project, '--conversation', 'left-2']);
  await killed.initialize();
  killed.child.kill('SIGKILL');
  await killed.exited;
  assert.ok(await exists(path.join(simDir(project, 'left-2'), 'server.lock')));

  for (const conversation of ['left-1', 'left-2']) {
    const server = startServer([project, '--conversation', conversation]);
    try {
      await server.initialize();
      assert.equal((await server.call('opening_hours')).isError, false);
      assert.deepEqual(await server.stop(), { code: 0, signal: null }, server.stderr());
    } finally {
      server.child.kill('SIGKILL');
    }
  }
  assert.deepEqual((await fs.readdir(dir)).sort(), ['calls.jsonl', 'counts.json', `counts.json.${process.pid}.89abcdef.tmp`, 'note.txt', 'store.json']);
  assert.ok(!(await exists(path.join(simDir(project, 'left-2'), 'server.lock'))));

  // 動いているプロセスがロックを持つ会話には、起動しない(同じ記録の店を 2 つのサーバーが書かないため)
  await fs.writeFile(path.join(dir, 'server.lock'), String(process.pid));
  const refused = startServer([project, '--conversation', 'left-1']);
  assert.equal((await refused.waitExit()).code, 3);
  assert.ok(refused.stderr().includes(`もう動いています(プロセス ${process.pid})`), refused.stderr());
  assert.equal(await fs.readFile(path.join(dir, 'server.lock'), 'utf8'), String(process.pid));
});

test('引数、tools.json、記録の店の誤りでは起動しない(終了コード 3)', { timeout: TEST_TIMEOUT_MS }, async () => {
  const cases = [];
  const good = await makeProject();
  cases.push({ args: [], text: /プロジェクトを 1 つ指定してください/ });
  cases.push({ args: [path.join(tmp, 'no-such-project')], text: /プロジェクトが見つかりません/ });
  cases.push({ args: [good, '--conversation', '../escape'], text: /--conversation の形が違います/ });
  cases.push({ args: [good, '--conversation', 'Upper'], text: /--conversation の形が違います/ });
  cases.push({ args: [good, '--max-seconds', '0'], text: /--max-seconds/ });
  cases.push({ args: [await makeProject({ tools: null })], text: /app\/tools\.json がありません/ });
  cases.push({ args: [await makeProject({ tools: '{ 壊れた' })], text: /tools\.json/ });
  const unknownOp = structuredClone(TOOLS);
  unknownOp.tools[0].do = { op: 'exec', command: 'ls' };
  cases.push({ args: [await makeProject({ tools: unknownOp })], text: /知らない処理|exec/ });
  const codeData = structuredClone(TOOLS);
  codeData.tools[0].do.data = 'data/jobs.js';
  cases.push({ args: [await makeProject({ tools: codeData })], text: /\.json/ });
  const brokenStore = await makeProject();
  await fs.mkdir(simDir(brokenStore, 'broken'), { recursive: true });
  await fs.writeFile(path.join(simDir(brokenStore, 'broken'), 'store.json'), '[1, 2]');
  cases.push({ args: [brokenStore, '--conversation', 'broken'], text: /store\.json の形が正しくありません/ });

  for (const { args, text } of cases) {
    const server = startServer(args);
    const exit = await server.waitExit();
    assert.equal(exit.code, 3, `${args.join(' ')}: ${server.stderr()}`);
    assert.match(server.stderr(), text, args.join(' '));
  }
  // 誤りの store.json の会話は、ロックを残さない
  assert.deepEqual(await fs.readdir(simDir(brokenStore, 'broken')), ['store.json']);
});

test('npm run tools:mcp -- <ID> で、データの置き場の試作品を起動できる。会話を渡さなければ起動ごとに新しい会話', { timeout: TEST_TIMEOUT_MS }, async () => {
  await fs.mkdir(path.join(home, 'projects'), { recursive: true });
  const project = await makeProject({ parent: path.join(home, 'projects'), name: 'tools-sample' });
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const ids = [];
  for (let i = 0; i < 2; i += 1) {
    const server = startServer(['tools-sample'], { command: npm, prefix: ['run', '--silent', 'tools:mcp', '--'] });
    try {
      await server.initialize();
      assert.deepEqual((await server.rpc('tools/list')).result.tools.map((tool) => tool.name), TOOL_NAMES);
      assert.equal((await server.call('save_consent', { agreed: true })).isError, false);
      assert.deepEqual(await server.stop(), { code: 0, signal: null }, server.stderr());
      ids.push(/会話 (mcp-[0-9a-f]{8})/.exec(server.stderr())?.[1]);
    } finally {
      server.child.kill('SIGKILL');
    }
  }
  assert.ok(ids.every(Boolean));
  assert.notEqual(ids[0], ids[1]);
  assert.deepEqual((await fs.readdir(path.join(project, '.studio', 'sim'))).sort(), [...ids].sort());
  for (const id of ids) assert.deepEqual(await readJson(path.join(simDir(project, id), 'store.json')), { consent: [{ agreed: true }] });
});
