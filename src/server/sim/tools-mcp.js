import { randomBytes } from 'node:crypto';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { isProcessAlive } from '../observe-temp.js';
import { redactDeep } from '../redact.js';
import { isPlainObject } from './check.js';
import { callTool, refusedEntry } from './tool-gate.js';
import { TOOL_LIMITS } from './tools.js';

// ツールの MCP サーバー(docs/design/agent-simulation.md の 3.6、7.3 の sim-3)。
// 試作品のツール(app/tools.json)を、ツールの口(tool-gate.js の callTool)を通して MCP の道具として出す。
// 作りは観察の道具の MCP サーバー(src/server/observe-mcp.js)と同じ: stdio の JSON-RPC(1 行に 1 つのメッセージ)で、
// initialize、tools/list、tools/call に答える。SDK は入れない。プロジェクトと会話は起動の引数でだけ受け取る。
// app/ は読むだけ(tools.json とデータ)。書くのは .studio/sim/<会話の ID>/ の中だけ:
//   store.json   … 記録の店の写し。起動のときに読み、呼び出しのたびに書く(Studio が返事の後にメモリーへ戻す)
//   counts.json  … ツールごとの呼び出しの数(callTool の context.calls)。maxCallsPerConversation を、起動し直しても続けて数える
//   calls.jsonl  … 呼び出しの記録(ツールの口が返した記録の 1 件に、伏せた結果の全文を足したもの)。1 回の呼び出しで 1 行
//   server.lock  … 動いているサーバーのプロセスの番号。同じ会話に 2 つのサーバーが同時に書かないようにする
//   context.json … 会話の進め方(Studio)が起動の前に書く文脈。呼んだ参加者、その参加者に渡すツールの名前、構成の引き継ぎの辺、
//                  前提のツールの呼び方、ツールの宣言のファイル、1 回の返事のツールの数の上限(sim-4。起動の引数は 3 つのまま)。
//                  なければ単独の起動
//   handoff.json … 引き継ぎのツールが通ったときの、行き先と受け渡す値(伏せない)。Studio が返事の後に読んで消す
//   delegate.json … 委任のツール(2.9)が通ったときの、任せる先と依頼の文と受け渡す値(伏せない)。Studio が返事の後に読んで消す
//   mcp.json     … 模擬のエージェントに渡す MCP の設定(Studio が書く。このサーバーは読まない)

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

export const SIM_FILES = Object.freeze({
  store: 'store.json',
  counts: 'counts.json',
  calls: 'calls.jsonl',
  lock: 'server.lock',
  context: 'context.json',
  handoff: 'handoff.json',
  delegate: 'delegate.json',
  mcp: 'mcp.json',
});

// 受け取る 1 行の長さ。ツールの引数はツールの口が 2 万文字で断るので、これより長いものは読まない
const MAX_LINE = 1024 * 1024;
// 書き途中のファイルの名前: <store.json か counts.json>.<書いたプロセスの番号>.<8 文字>.tmp
const TEMP_NAME = /^(?:store|counts|handoff|delegate)\.json\.([1-9]\d*)\.[0-9a-f]{8}\.tmp$/;

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

// 会話のフォルダー(.studio/sim/<会話の ID>/)を、.studio、sim、<会話の ID> と 1 段ずつ確かめてから作る
// (リンクの先に、フォルダーを作らないため)。中の記録のファイルが普通のファイルでなければ誤り。
// ツールの MCP サーバーと、起動の前に文脈を書く会話の進め方(Studio)の両方が使う
export async function ensureSimDir(projectDir, conversationId) {
  if (!CONVERSATION_ID_PATTERN.test(conversationId ?? '')) {
    throw new ToolsMcpError(`会話の ID が使えない形です: ${JSON.stringify(conversationId)}(英小文字、数字、- だけで 64 字まで)`);
  }
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
  for (const name of [SIM_FILES.store, SIM_FILES.counts, SIM_FILES.calls, SIM_FILES.context, SIM_FILES.handoff, SIM_FILES.delegate, SIM_FILES.mcp]) {
    const stat = await fs.lstat(path.join(dir, name)).catch(() => null);
    if (stat && !stat.isFile()) throw new ToolsMcpError(`${name} がファイルではありません`);
  }
  return dir;
}

// 会話のフォルダーを消す(会話を最初からにしたとき、版を戻したとき)。.studio と sim がシンボリックリンクなら消さない
// (リンクの先の、別の場所のフォルダーを消さないため)。動いているサーバーがあっても、消すのは呼ぶ側が止めた後
export function removeSimDir(projectDir, conversationId) {
  if (!projectDir || !CONVERSATION_ID_PATTERN.test(conversationId ?? '')) return;
  let dir = projectDir;
  for (const part of ['.studio', 'sim', conversationId]) {
    dir = path.join(dir, part);
    let stat;
    try {
      stat = fsSync.lstatSync(dir);
    } catch {
      return;
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) return;
  }
  fsSync.rmSync(dir, { recursive: true, force: true });
}

// プロジェクトの模擬の会話の作業の場所(.studio/sim/)を全部消す。Studio の起動のとき(前の起動の会話は、メモリーにもう残っていない)
export async function removeAllSimDirs(projectDir) {
  let dir = projectDir;
  for (const part of ['.studio', 'sim']) {
    dir = path.join(dir, part);
    const stat = await fs.lstat(dir).catch(() => null);
    if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) return;
  }
  await fs.rm(dir, { recursive: true, force: true });
}

const ID = /^[a-z][a-z0-9-]{0,39}$/;
const TOOL_NAME = /^[a-z][a-z0-9_]{0,39}$/;
const KEY = /^[A-Za-z][A-Za-z0-9_]{0,31}$/;
const intIn = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;
const toolsFileOk = (value) =>
  typeof value === 'string' && value.endsWith('.json') && value.length <= 200 && !/[\\\0]/.test(value) && !value.startsWith('/') && !value.split('/').some((part) => part === '..' || part === '' || part === '.');

// context.json(会話の進め方が書く文脈)を確かめる。Studio だけが書くファイルだが、形と上限をここでも確かめ、合わなければ起動しない
export function parseContext(value) {
  const fail = (what) => {
    throw new ToolsMcpError(`${SIM_FILES.context} の ${what} の形が正しくありません`);
  };
  if (!isPlainObject(value) || value.formatVersion !== 1) fail('formatVersion');
  const context = {};
  if (value.by !== undefined) {
    if (typeof value.by !== 'string' || !ID.test(value.by)) fail('by');
    context.by = value.by;
  }
  // 呼んだ参加者に渡すツールの名前(構成の参加者の tools)。あれば、道具の一覧に出すのも、呼べるのも、この名前だけ(S14)
  if (value.allowedTools !== undefined) {
    const ok = Array.isArray(value.allowedTools) && value.allowedTools.length <= TOOL_LIMITS.maxTools
      && value.allowedTools.every((name) => typeof name === 'string' && TOOL_NAME.test(name));
    if (!ok) fail('allowedTools');
    context.allowedTools = [...value.allowedTools];
  }
  if (value.handoffs !== undefined) {
    if (!Array.isArray(value.handoffs) || value.handoffs.length > 20) fail('handoffs');
    context.handoffs = value.handoffs.map((edge) => {
      const ok = isPlainObject(edge) && ID.test(edge.from ?? '') && ID.test(edge.to ?? '')
        && Array.isArray(edge.carry) && edge.carry.length <= 20 && edge.carry.every((key) => typeof key === 'string' && KEY.test(key));
      if (!ok) fail('handoffs');
      return { from: edge.from, to: edge.to, carry: [...edge.carry] };
    });
  }
  // 委任の辺と上限(2.9)。辺は from、to、carry、history。上限は会話の進め方が数えた残り
  if (value.delegations !== undefined) {
    if (!Array.isArray(value.delegations) || value.delegations.length > 20) fail('delegations');
    context.delegations = value.delegations.map((edge) => {
      const ok = isPlainObject(edge) && ID.test(edge.from ?? '') && ID.test(edge.to ?? '') && typeof edge.history === 'boolean'
        && Array.isArray(edge.carry) && edge.carry.length <= 20 && edge.carry.every((key) => typeof key === 'string' && KEY.test(key));
      if (!ok) fail('delegations');
      return { from: edge.from, to: edge.to, carry: [...edge.carry], history: edge.history };
    });
    if (!intIn(value.depthLeft, 0, 3)) fail('depthLeft');
    if (!intIn(value.delegationsLeft, 0, 10)) fail('delegationsLeft');
    context.depthLeft = value.depthLeft;
    context.delegationsLeft = value.delegationsLeft;
  } else if (value.depthLeft !== undefined || value.delegationsLeft !== undefined) fail('delegations');
  if (value.toolCalling !== undefined) {
    const calling = value.toolCalling;
    if (!isPlainObject(calling)) fail('toolCalling');
    const checked = {};
    if (calling.delayMs !== undefined) {
      if (!intIn(calling.delayMs, 0, 10_000)) fail('toolCalling.delayMs');
      checked.delayMs = calling.delayMs;
    }
    if (calling.resultMaxChars !== undefined) {
      if (!intIn(calling.resultMaxChars, 1, 20_000)) fail('toolCalling.resultMaxChars');
      checked.resultMaxChars = calling.resultMaxChars;
    }
    if (calling.faults !== undefined) {
      const ok = Array.isArray(calling.faults) && calling.faults.length <= 10
        && calling.faults.every((fault) => isPlainObject(fault) && TOOL_NAME.test(fault.tool ?? '') && intIn(fault.onCall, 1, 100));
      if (!ok) fail('toolCalling.faults');
      checked.faults = calling.faults.map((fault) => ({ tool: fault.tool, onCall: fault.onCall }));
    }
    context.assumption = { toolCalling: checked };
  }
  if (value.maxPerReply !== undefined) {
    if (!intIn(value.maxPerReply, 1, 8)) fail('maxPerReply');
    context.maxPerReply = value.maxPerReply;
  }
  if (value.userId !== undefined) {
    if (typeof value.userId !== 'string' || !/^[a-z0-9-]{1,64}$/.test(value.userId)) fail('userId');
    context.userId = value.userId;
  }
  if (value.tools !== undefined) {
    if (!toolsFileOk(value.tools)) fail('tools');
    context.tools = value.tools;
  }
  return context;
}

// 会話のフォルダーの文脈を読む。なければ null(単独の起動)
export async function readContext(dir) {
  const file = path.join(dir, SIM_FILES.context);
  const stat = await fs.lstat(file).catch((error) => (error.code === 'ENOENT' ? null : Promise.reject(error)));
  if (!stat) return null;
  if (!stat.isFile()) throw new ToolsMcpError(`${SIM_FILES.context} がファイルではありません`);
  if (stat.size > 64 * 1024) throw new ToolsMcpError(`${SIM_FILES.context} が大きすぎます`);
  let value;
  try {
    value = JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    throw new ToolsMcpError(`${SIM_FILES.context} を JSON として読めません`);
  }
  return parseContext(value);
}

// 会話のフォルダー(.studio/sim/<会話の ID>/)を開く。
// 作ったフォルダーの中を、シンボリックリンクでよそ(app/ など)へ向けられていないかを確かめ、
// 前の起動が強制終了されて残した書き途中のファイルを消し、ロックを取り、記録の店と呼び出しの数を読む。
// 返す release() は、ロックと書き途中のファイルを同期で消す(process の exit からも呼べる)
export async function openConversation({ projectDir, conversationId, limits = {}, isAlive = isProcessAlive }) {
  if (!CONVERSATION_ID_PATTERN.test(conversationId ?? '')) {
    throw new ToolsMcpError(`会話の ID が使えない形です: ${JSON.stringify(conversationId)}(英小文字、数字、- だけで 64 字まで)`);
  }
  const { maxStateBytes } = { ...TOOLS_MCP_LIMITS, ...limits };
  const dir = await ensureSimDir(projectDir, conversationId);

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
    const context = await readContext(dir);
    return { dir, conversationId, store, counts, context, temps, release };
  } catch (error) {
    release();
    throw error;
  }
}

// 書き途中のファイルに書いてから名前を変える(Studio が書き途中の store.json を読まないため)
export async function writeAtomic(conversation, name, value) {
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
    // 会話の進め方が書いた文脈(呼んだ参加者、辺、前提)。単独の起動では空
    this.context = conversation.context ?? {};
    // このサーバーの起動の間(模擬のエージェントの 1 回の返事)に呼ばれた数。context の maxPerReply で切る
    this.replyCalls = 0;
    this.handoffs = [];
    // この起動の間に通った委任の頼み。delegationsLeft から引いて、ツールの口に残りを渡す
    this.delegates = [];
  }

  // 道具の一覧。文脈に参加者のツールの名前があれば、その名前だけを出す(ほかの参加者のツールの説明を渡さない。S14)
  list() {
    const { allowedTools } = this.context;
    return this.toolset.tools.filter((tool) => !allowedTools || allowedTools.includes(tool.name)).map((tool) => ({ name: tool.name, description: tool.description, inputSchema: listedSchema(tool.inputSchema) }));
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
    const { by, handoffs, assumption, userId, maxPerReply, allowedTools, delegations, depthLeft, delegationsLeft } = this.context;
    this.replyCalls += 1;
    // 参加者に渡していないツールは、ツールの口に渡さず、記録だけ残す(模擬のエージェントのモックと同じ断り方。orchestrator.js)
    if (allowedTools && !allowedTools.includes(name)) {
      return this.refuse({ name, args, by, layer: 'permission', guard: 'allowedTools', reason: '構成でこの参加者に渡していないツール' }, `「${name}」は使えないツールです`);
    }
    // 1 回の返事で呼べる数(前提の toolCalling.maxPerReply)。超えた呼び出しはツールの口に渡さず、記録だけ残す
    if (maxPerReply !== undefined && this.replyCalls > maxPerReply) {
      const reason = `1 回の返事で呼べるツールは ${maxPerReply} 回までです`;
      return this.refuse({ name, args, by, guard: 'maxPerReply', reason }, reason);
    }
    const outcome = await callTool({
      tools: this.toolset,
      data: this.data,
      store: this.store,
      context: {
        conversationId: this.conversation.conversationId,
        calls: this.counts,
        ...(by ? { by } : {}),
        ...(handoffs ? { handoffs } : {}),
        ...(delegations ? { delegations, depthLeft, delegationsLeft: Math.max(0, delegationsLeft - this.delegates.length) } : {}),
        ...(assumption ? { assumption } : {}),
        ...(userId ? { userId } : {}),
      },
      name,
      args,
    });
    const line = { at: new Date().toISOString(), ...outcome.entry, ...(outcome.ok ? { output: redactDeep(outcome.result ?? null) } : {}) };
    try {
      await fs.appendFile(path.join(this.conversation.dir, SIM_FILES.calls), `${JSON.stringify(line)}\n`);
      await writeAtomic(this.conversation, SIM_FILES.store, outcome.store);
      await writeAtomic(this.conversation, SIM_FILES.counts, outcome.calls);
      // 引き継ぎの行き先と受け渡す値は、伏せずに別のファイルで Studio に渡す(記録の calls.jsonl は伏せた形のまま)
      if (outcome.handoff) await writeAtomic(this.conversation, SIM_FILES.handoff, [...this.handoffs, outcome.handoff]);
      if (outcome.delegate) await writeAtomic(this.conversation, SIM_FILES.delegate, [...this.delegates, outcome.delegate]);
    } catch (error) {
      return { content: [{ type: 'text', text: `呼び出しの記録を書けませんでした: ${String(error?.message ?? error).slice(0, 300)}` }], isError: true };
    }
    this.store = outcome.store;
    this.counts = outcome.calls;
    if (outcome.handoff) this.handoffs.push(outcome.handoff);
    if (outcome.delegate) this.delegates.push(outcome.delegate);
    if (!outcome.ok) return { content: [{ type: 'text', text: outcome.error }], isError: true };
    return { content: [{ type: 'text', text: JSON.stringify(outcome.result ?? null) }] };
  }

  // ツールの口に渡さずに断る。断りの記録を calls.jsonl に 1 行足し、text を誤りとして返す
  async refuse(refusal, text) {
    const line = { at: new Date().toISOString(), ...refusedEntry(refusal) };
    try {
      await fs.appendFile(path.join(this.conversation.dir, SIM_FILES.calls), `${JSON.stringify(line)}\n`);
    } catch {
      // 記録を書けなくても、断ることは変えない
    }
    return { content: [{ type: 'text', text }], isError: true };
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
