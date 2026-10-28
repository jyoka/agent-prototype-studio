import { randomBytes } from 'node:crypto';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { isProcessAlive } from '../observe-temp.js';
import { redactDeep } from '../redact.js';
import { isPlainObject } from './check.js';
import { callTool } from './tool-gate.js';

// ツールの MCP サーバー(docs/design/agent-simulation.md の 3.6、7.3 の sim-3)。
// 試作品のツール(app/tools.json)を、ツールの口(tool-gate.js の callTool)を通して MCP の道具として出す。
// 作りは観察の道具の MCP サーバー(src/server/observe-mcp.js)と同じ: stdio の JSON-RPC(1 行に 1 つのメッセージ)で、
// initialize、tools/list、tools/call に答える。SDK は入れない。プロジェクトと会話は起動の引数でだけ受け取る。
// app/ は読むだけ(tools.json とデータ)。書くのは .studio/sim/<会話の ID>/ の中だけ:
//   store.json   … 記録の店の写し。起動のときに読み、呼び出しのたびに書く(Studio が返事の後にメモリーへ戻す)
//   counts.json  … ツールごとの呼び出しの数(callTool の context.calls)。maxCallsPerConversation を、起動し直しても続けて数える
//   calls.jsonl  … 呼び出しの記録(ツールの口が返した記録の 1 件に、伏せた結果の全文を足したもの)。1 回の呼び出しで 1 行
//   server.lock  … 動いているサーバーのプロセスの番号。同じ会話に 2 つのサーバーが同時に書かないようにする

export const PROTOCOL_VERSIONS = Object.freeze(['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']);
export const SERVER_INFO = Object.freeze({ name: 'prototype-studio-tools', version: '0.1.0' });
// 模擬のエージェントに渡す MCP の設定の、サーバーの名前(道具は mcp__proto__<ツールの名前> になる)
export const MCP_SERVER_NAME = 'proto';
// 会話の ID。.studio/sim/ の下のフォルダーの名前になるので、区切りや . を入れさせない
export const CONVERSATION_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

export const TOOLS_MCP_LIMITS = Object.freeze({
  // サーバーの全体の上限。超えたら、受けた呼び出しを書き終えてから終わる
  serverMs: 30 * 60_000,
  // 終わるときに、動いている呼び出し(前提の遅れを含む)が終わるのを待つ時間
  shutdownMs: 15_000,
  // 起動のときに読む store.json と counts.json の大きさ
  maxStateBytes: 5 * 1024 * 1024,
});

export const SIM_FILES = Object.freeze({ store: 'store.json', counts: 'counts.json', calls: 'calls.jsonl', lock: 'server.lock' });

// 受け取る 1 行の長さ。ツールの引数はツールの口が 2 万文字で断るので、これより長いものは読まない
const MAX_LINE = 1024 * 1024;
// 書き途中のファイルの名前: <store.json か counts.json>.<書いたプロセスの番号>.<8 文字>.tmp
const TEMP_NAME = /^(?:store|counts)\.json\.([1-9]\d*)\.[0-9a-f]{8}\.tmp$/;

export class ToolsMcpError extends Error {}

export const simDirOf = (projectDir, conversationId) => path.join(projectDir, '.studio', 'sim', conversationId);

// 単独で起動したとき(--conversation なし)の会話の ID。起動ごとに新しい会話になる(S15)
export const newConversationId = () => `mcp-${randomBytes(4).toString('hex')}`;

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

// 時間内に終わらなければ timedOut を返す(observe-mcp.js と同じ)
async function within(promise, ms) {
  promise.catch(() => {});
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), ms);
  });
  try {
    return await Promise.race([promise.then((value) => ({ timedOut: false, value })), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function readState(dir, name, check, maxBytes) {
  const file = path.join(dir, name);
  const stat = await fs.lstat(file).catch((error) => (error.code === 'ENOENT' ? null : Promise.reject(error)));
  if (!stat) return {};
  if (!stat.isFile()) throw new ToolsMcpError(`${name} がファイルではありません`);
  if (stat.size > maxBytes) throw new ToolsMcpError(`${name} が大きすぎます(上限 ${maxBytes} バイト)`);
  let value;
  try {
    value = JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    throw new ToolsMcpError(`${name} を JSON として読めません`);
  }
  if (!check(value)) throw new ToolsMcpError(`${name} の形が正しくありません`);
  return value;
}

const isCounts = (value) => isPlainObject(value) && Object.values(value).every((count) => Number.isSafeInteger(count) && count >= 0);

// 会話のフォルダー(.studio/sim/<会話の ID>/)を開く。
// 作ったフォルダーの中を、シンボリックリンクでよそ(app/ など)へ向けられていないかを確かめ、
// 前の起動が強制終了されて残した書き途中のファイルを消し、ロックを取り、記録の店と呼び出しの数を読む。
// 返す release() は、ロックと書き途中のファイルを同期で消す(process の exit からも呼べる)
export async function openConversation({ projectDir, conversationId, limits = {}, isAlive = isProcessAlive }) {
  if (!CONVERSATION_ID_PATTERN.test(conversationId ?? '')) {
    throw new ToolsMcpError(`会話の ID が使えない形です: ${JSON.stringify(conversationId)}(英小文字、数字、- だけで 64 字まで)`);
  }
  const { maxStateBytes } = { ...TOOLS_MCP_LIMITS, ...limits };
  // .studio、sim、<会話の ID> を 1 段ずつ確かめてから作る(リンクの先に、フォルダーを作らないため)
  let dir = projectDir;
  for (const part of ['.studio', 'sim', conversationId]) {
    dir = path.join(dir, part);
    const stat = await fs.lstat(dir).catch((error) => (error.code === 'ENOENT' ? null : Promise.reject(error)));
    if (stat?.isSymbolicLink()) {
      throw new ToolsMcpError(`${path.relative(projectDir, dir)} がシンボリックリンクです。書く所がプロジェクトの .studio/ の外になるかもしれないので、起動しません`);
    }
    if (stat && !stat.isDirectory()) throw new ToolsMcpError(`${path.relative(projectDir, dir)} がフォルダーではありません`);
    if (!stat) await fs.mkdir(dir).catch((error) => (error.code === 'EEXIST' ? undefined : Promise.reject(error)));
  }
  for (const name of [SIM_FILES.store, SIM_FILES.counts, SIM_FILES.calls]) {
    const stat = await fs.lstat(path.join(dir, name)).catch(() => null);
    if (stat && !stat.isFile()) throw new ToolsMcpError(`${name} がファイルではありません`);
  }

  for (const name of await fs.readdir(dir)) {
    const pid = Number(TEMP_NAME.exec(name)?.[1]);
    if (!pid || pid === process.pid || isAlive(pid)) continue;
    await fs.rm(path.join(dir, name), { force: true }).catch(() => {});
  }

  // ロック。番号のプロセスがもう動いていなければ、前の起動の残りなので取り直す
  const lock = path.join(dir, SIM_FILES.lock);
  let locked = false;
  for (let attempt = 0; attempt < 2 && !locked; attempt += 1) {
    try {
      await fs.writeFile(lock, String(process.pid), { flag: 'wx' });
      locked = true;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const owner = Number((await fs.readFile(lock, 'utf8').catch(() => '')).trim());
      if (Number.isSafeInteger(owner) && owner > 0 && owner !== process.pid && isAlive(owner)) {
        throw new ToolsMcpError(`この会話のツールのサーバーが、もう動いています(プロセス ${owner})`);
      }
      await fs.rm(lock, { force: true });
    }
  }
  if (!locked) throw new ToolsMcpError('この会話のロックを取れませんでした');

  const temps = new Set();
  const release = () => {
    for (const file of temps) fsSync.rmSync(file, { force: true });
    temps.clear();
    try {
      if (fsSync.readFileSync(lock, 'utf8').trim() === String(process.pid)) fsSync.rmSync(lock, { force: true });
    } catch {
      // もうない
    }
  };
  try {
    const store = await readState(dir, SIM_FILES.store, isPlainObject, maxStateBytes);
    const counts = await readState(dir, SIM_FILES.counts, isCounts, maxStateBytes);
    return { dir, conversationId, store, counts, temps, release };
  } catch (error) {
    release();
    throw error;
  }
}

// 書き途中のファイルに書いてから名前を変える(Studio が書き途中の store.json を読まないため)
async function writeAtomic(conversation, name, value) {
  const file = path.join(conversation.dir, name);
  const temp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  conversation.temps.add(temp);
  try {
    await fs.writeFile(temp, `${JSON.stringify(value)}\n`);
    await fs.rename(temp, file);
  } finally {
    await fs.rm(temp, { force: true }).catch(() => {});
    conversation.temps.delete(temp);
  }
}

// MCP の道具の一覧に出す引数の形。ツールの口は inputSchema にない引数を断るので、それを additionalProperties: false で示す
function listedSchema(schema) {
  if (!isPlainObject(schema)) return schema;
  if (schema.type === 'object') {
    const properties = Object.fromEntries(Object.entries(schema.properties ?? {}).map(([key, child]) => [key, listedSchema(child)]));
    return { ...schema, properties, additionalProperties: false };
  }
  if (schema.type === 'array' && schema.items) return { ...schema, items: listedSchema(schema.items) };
  return { ...schema };
}

// 1 つの会話の、試作品のツール。呼び出しは 1 つずつ順に回し、毎回、記録を書いてから答える
export class ToolsSession {
  constructor({ toolset, data, conversation, limits = {} }) {
    this.toolset = toolset;
    this.data = data;
    this.conversation = conversation;
    this.store = conversation.store;
    this.counts = conversation.counts;
    this.limits = { ...TOOLS_MCP_LIMITS, ...limits };
    this.queue = Promise.resolve();
    this.closed = false;
  }

  list() {
    return this.toolset.tools.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: listedSchema(tool.inputSchema) }));
  }

  call(name, args) {
    const run = this.queue.then(() => this.dispatch(name, args));
    this.queue = run.catch(() => {});
    return run;
  }

  // ツールの口を呼び、記録(calls.jsonl)、記録の店(store.json)、呼び出しの数(counts.json)を書いてから、結果を返す。
  // 書けなければ、メモリーの店と数を進めずに誤りを返す
  async dispatch(name, args) {
    if (this.closed) return { content: [{ type: 'text', text: 'ツールのサーバーは終わるところです' }], isError: true };
    const outcome = await callTool({
      tools: this.toolset,
      data: this.data,
      store: this.store,
      context: { conversationId: this.conversation.conversationId, calls: this.counts },
      name,
      args,
    });
    const line = { at: new Date().toISOString(), ...outcome.entry, ...(outcome.ok ? { output: redactDeep(outcome.result ?? null) } : {}) };
    try {
      await fs.appendFile(path.join(this.conversation.dir, SIM_FILES.calls), `${JSON.stringify(line)}\n`);
      await writeAtomic(this.conversation, SIM_FILES.store, outcome.store);
      await writeAtomic(this.conversation, SIM_FILES.counts, outcome.calls);
    } catch (error) {
      return { content: [{ type: 'text', text: `呼び出しの記録を書けませんでした: ${String(error?.message ?? error).slice(0, 300)}` }], isError: true };
    }
    this.store = outcome.store;
    this.counts = outcome.calls;
    if (!outcome.ok) return { content: [{ type: 'text', text: outcome.error }], isError: true };
    return { content: [{ type: 'text', text: JSON.stringify(outcome.result ?? null) }] };
  }

  // 受けた呼び出し(順番を待っているものも)が書き終えるのを、上限まで待つ。その後の呼び出しは断る。
  // 呼ぶ側は先に入力を読むのを止めるので、待っている間に新しい呼び出しは来ない
  async close() {
    if (this.closed) return;
    await within(this.queue, this.limits.shutdownMs);
    this.closed = true;
  }
}

// JSON-RPC の 1 つのメッセージに答える。通知(id がない)には何も返さない(null)
export async function handleMessage(session, message) {
  const reply = (result) => ({ jsonrpc: '2.0', id: message.id, result });
  const fail = (code, text) => ({ jsonrpc: '2.0', id: message?.id ?? null, error: { code, message: text } });
  if (!isPlainObject(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
    return fail(-32600, '要求の形が正しくありません');
  }
  const isRequest = Object.hasOwn(message, 'id') && (typeof message.id === 'string' || Number.isSafeInteger(message.id));
  if (!isRequest) return null;
  const params = message.params ?? {};
  if (!isPlainObject(params)) return fail(-32602, 'params はオブジェクトで渡してください');
  switch (message.method) {
    case 'initialize': {
      const asked = params.protocolVersion;
      return reply({
        protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { ...SERVER_INFO },
        instructions: '試作品のツールです。データはどれも架空です。断られたときは、返ってきた文を読んで呼び方を変えてください',
      });
    }
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools: session.list() });
    case 'tools/call':
      // ないツールの名前も、ツールの口に渡す(形の検査で断り、記録に残す)
      if (typeof params.name !== 'string') return fail(-32602, 'name にツールの名前を渡してください');
      return reply(await session.call(params.name, params.arguments ?? {}));
    default:
      return fail(-32601, `知らないメソッドです: ${message.method}`);
  }
}

// stdio で MCP サーバーを動かす。input が閉じるか、全体の上限を超えるか、stop() を呼ぶと、新しい要求を読むのを止め、
// 受けた呼び出しを書き終えて(上限は limits.shutdownMs)終わる。
// 返す done は、終わると reason(end、timeout、stop)で解ける
export function serveToolsMcp({ session, input, output, log = () => {} }) {
  let broken = false;
  const write = (message) => {
    if (!broken && !output.destroyed) output.write(`${JSON.stringify(message)}\n`);
  };
  const pending = new Set();
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  lines.on('line', (line) => {
    if (line.trim() === '') return;
    if (line.length > MAX_LINE) {
      write({ jsonrpc: '2.0', id: null, error: { code: -32600, message: '要求が長すぎます' } });
      return;
    }
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'JSON として読めません' } });
      return;
    }
    const work = handleMessage(session, message).then(
      (response) => response && write(response),
      (error) => write({ jsonrpc: '2.0', id: message?.id ?? null, error: { code: -32603, message: String(error?.message ?? error).slice(0, 300) } }),
    );
    pending.add(work);
    work.finally(() => pending.delete(work));
  });

  const done = deferred();
  let finishing = null;
  const finish = (reason) => {
    finishing ??= (async () => {
      clearTimeout(timer);
      lines.close();
      await session.close();
      // 終わる前に受けた要求には、答えを書いてから終わる
      await within(Promise.allSettled([...pending]), 1_000);
      done.resolve(reason);
      return reason;
    })();
    return finishing;
  };
  const maxMs = session.limits.serverMs;
  const timer = setTimeout(() => {
    log(`ツールのサーバーを、時間の上限(${Math.round(maxMs / 1000)} 秒)で止めます`);
    finish('timeout');
  }, maxMs);
  input.once('end', () => finish('end'));
  input.once('close', () => finish('end'));
  input.on('error', () => finish('end'));
  output.on('error', () => {
    broken = true;
    finish('end');
  });
  return { done: done.promise, stop: () => finish('stop') };
}
