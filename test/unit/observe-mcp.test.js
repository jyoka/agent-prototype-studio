import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { ObserveTools, PROTOCOL_VERSIONS, TOOL_NAMES, handleMessage, serveObserveMcp } from '../../src/server/observe-mcp.js';

// 観察の道具の MCP サーバー(docs/design/harness.md の 3.1、S4、S5)の、ブラウザを使わない部分。
// 道具の一覧、JSON-RPC の答え方、引数の検査、開く前の呼び出し、サーバーの終わり方を確かめる。
// ブラウザで開くところは test/integration/observe-mcp.test.js
const PROJECT = '/nonexistent/prototype-studio-observe-mcp-unit';
const FIXED_NAMES = ['open', 'read_page', 'inspect', 'click', 'type', 'scroll', 'set_viewport', 'screenshot', 'run_scenarios'];

const request = (id, method, params) => ({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });

test('tools/list は決まった名前の道具だけを返し、どの道具もプロジェクトの場所を引数に取らない', async () => {
  const tools = new ObserveTools({ projectDir: PROJECT });
  const listed = await handleMessage(tools, request(1, 'tools/list'));
  assert.equal(listed.id, 1);
  const names = listed.result.tools.map((tool) => tool.name);
  assert.deepEqual(names, FIXED_NAMES);
  assert.deepEqual([...TOOL_NAMES], FIXED_NAMES);
  for (const tool of listed.result.tools) {
    assert.equal(typeof tool.description, 'string');
    assert.equal(tool.inputSchema.type, 'object');
    assert.equal(tool.inputSchema.additionalProperties, false);
    // 場所、パス、スクリプトを受け取る引数はない
    for (const key of Object.keys(tool.inputSchema.properties)) {
      assert.ok(['viewport', 'target', 'text', 'to', 'name'].includes(key), `${tool.name} の引数 ${key}`);
    }
  }
  // 返した一覧を書き換えても、次の一覧は変わらない
  listed.result.tools.pop();
  assert.deepEqual((await handleMessage(tools, request(2, 'tools/list'))).result.tools.map((tool) => tool.name), FIXED_NAMES);
});

test('initialize は道具の能力と、求められた版(知らない版なら新しい版)を返す。ping と通知にも答える', async () => {
  const tools = new ObserveTools({ projectDir: PROJECT });
  const known = await handleMessage(tools, request(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } }));
  assert.equal(known.result.protocolVersion, '2025-06-18');
  assert.deepEqual(known.result.capabilities, { tools: { listChanged: false } });
  assert.equal(known.result.serverInfo.name, 'prototype-studio-observe');
  const unknown = await handleMessage(tools, request('a', 'initialize', { protocolVersion: '1999-01-01' }));
  assert.equal(unknown.id, 'a');
  assert.equal(unknown.result.protocolVersion, PROTOCOL_VERSIONS[0]);
  assert.deepEqual((await handleMessage(tools, request(2, 'ping'))).result, {});
  // 通知(id がない)には答えない
  assert.equal(await handleMessage(tools, { jsonrpc: '2.0', method: 'notifications/initialized' }), null);
});

test('知らないメソッド、知らない道具、形の違う要求は、JSON-RPC のエラーで返す', async () => {
  const tools = new ObserveTools({ projectDir: PROJECT });
  assert.equal((await handleMessage(tools, request(1, 'resources/list'))).error.code, -32601);
  const unknownTool = await handleMessage(tools, request(2, 'tools/call', { name: 'run_script', arguments: { code: '1' } }));
  assert.equal(unknownTool.error.code, -32602);
  assert.match(unknownTool.error.message, /知らない道具です: run_script/);
  assert.equal((await handleMessage(tools, { id: 3, method: 'tools/list' })).error.code, -32600);
  assert.equal((await handleMessage(tools, request(4, 'tools/call', ['open']))).error.code, -32602);
  assert.equal((await handleMessage(tools, null)).error.code, -32600);
});

test('道具の引数はシナリオの手順と同じ検査を通し、誤りは道具の結果(isError)の文で返す', async () => {
  const tools = new ObserveTools({ projectDir: PROJECT });
  const call = async (name, args) => (await handleMessage(tools, request(1, 'tools/call', { name, arguments: args }))).result;
  const cases = [
    ['click', { target: { selector: '#send' } }, /CSS のセレクターは使えません/],
    ['click', {}, /target が要ります/],
    ['type', { target: { label: 'メッセージ' } }, /text が要ります/],
    ['inspect', { target: { role: 'button', label: '送る' } }, /どれか 1 つ/],
    ['set_viewport', { viewport: 'watch' }, /viewport の値が違います/],
    ['scroll', { target: { text: '下' }, to: 'top' }, /target か to のどちらか 1 つ/],
    ['read_page', { path: '/etc/passwd' }, /read_page に「path」は渡せません/],
    ['open', { project: '/elsewhere' }, /open に「project」は渡せません/],
    ['open', { viewport: 'watch' }, /viewport の値が違います/],
    ['run_scenarios', { file: 'x.json' }, /引数を取りません/],
  ];
  for (const [name, args, message] of cases) {
    const result = await call(name, args);
    assert.equal(result.isError, true, name);
    assert.match(result.content[0].text, message);
  }
  // 正しい引数でも、open の前はどの操作も使えない
  for (const name of ['read_page', 'inspect', 'screenshot']) {
    const result = await call(name, {});
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /先に open を呼んでください/);
  }
});

// stdio の口(1 行に 1 つのメッセージ)。答えを id ごとに集める
function pipe(limits = {}) {
  const input = new PassThrough();
  const output = new PassThrough();
  const lines = [];
  let buffer = '';
  output.on('data', (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      lines.push(JSON.parse(buffer.slice(0, index)));
      buffer = buffer.slice(index + 1);
    }
  });
  const server = serveObserveMcp({ projectDir: PROJECT, input, output, limits });
  return { input, lines, server };
}

const until = async (check) => {
  const end = Date.now() + 2_000;
  while (!check()) {
    if (Date.now() > end) throw new Error('答えが来ません');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

test('stdio では 1 行に 1 つ答え、読めない行には parse error を返し、入力が閉じると終わる', async () => {
  const { input, lines, server } = pipe();
  input.write(`${JSON.stringify(request(1, 'tools/list'))}\n`);
  input.write('{これは JSON ではない\n');
  input.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  input.write(`${JSON.stringify(request(2, 'ping'))}\n`);
  await until(() => lines.length >= 3);
  assert.deepEqual(lines.find((line) => line.id === 1).result.tools.map((tool) => tool.name), FIXED_NAMES);
  assert.equal(lines.find((line) => line.id === null).error.code, -32700);
  assert.deepEqual(lines.find((line) => line.id === 2).result, {});
  input.end();
  assert.equal(await server.done, 'end');
  assert.equal(lines.length, 3);
});

test('サーバーの全体の時間の上限を超えると、入力が開いたままでも終わる', async () => {
  const { server } = pipe({ serverMs: 50 });
  const started = Date.now();
  assert.equal(await server.done, 'timeout');
  assert.ok(Date.now() - started < 2_000);
  assert.equal(server.tools.closed, true);
});

// 作業中のビルドは os.tmpdir() の下にできるので、TMPDIR をこのテストのフォルダーに向けて残り物を数える
async function withTempDir(work) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-observe-mcp-unit-'));
  const saved = process.env.TMPDIR;
  const tmp = path.join(base, 'tmp');
  await fs.mkdir(tmp);
  process.env.TMPDIR = tmp;
  try {
    return await work({ base, tmp });
  } finally {
    if (saved === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = saved;
    await fs.rm(base, { recursive: true, force: true });
  }
}

test('open の上限がビルドの途中で来ると、ブラウザを開かずに打ち切り、上限の文を返す。一時フォルダーと観察のフォルダーは残さない', async () => {
  await withTempDir(async ({ base, tmp }) => {
    const projectDir = path.join(base, 'project');
    await fs.mkdir(path.join(projectDir, 'app'), { recursive: true });
    await fs.writeFile(path.join(projectDir, 'app', 'main.js'), "document.getElementById('root').textContent = '架空の試作品';\n");
    const tools = new ObserveTools({ projectDir, limits: { openTimeoutMs: 1 } });
    const opened = await tools.call('open', {});
    assert.equal(opened.isError, true);
    assert.match(opened.content[0].text, /秒で開けませんでした/);
    await tools.close();
    assert.deepEqual(await fs.readdir(tmp), []);
    const observations = path.join(projectDir, '.studio', 'observations');
    assert.deepEqual(await fs.readdir(observations).catch(() => []), []);
  });
});
