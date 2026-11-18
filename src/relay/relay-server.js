import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 中継のサーバー(docs/design/collaboration.md の 9.4、ADR 0004 の段 2 の層 4)。
// 暗号文を預かって配るだけ。会の鍵を持たないので、文書もコメントも試作品も読めない。作る AI を動かす口もない。
// 見えるのは、会の ID、人の ID(ランダム)、書けるか読むだけか、暗号文の大きさと時刻、消す日だけ。
// 口は送る(HTTP)と受け取る(Server-Sent Events)だけ。Node の標準の部品だけで書く。
// 入るときは、招待のリンクの札を Authorization: Bearer で送る。中継のサーバーは札の SHA-256 だけを持つ。
// 置き場(dataDir)を渡すと、会ごとに 1 つの JSON に書き、止めて起こし直しても続きから配る。渡さなければメモリーだけ。

const PAGE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'share-page');
// 参加者のページ。鍵は持たない(鍵はリンクのフラグメントにあり、ブラウザは中継のサーバーに送らない)
const PAGE_FILES = {
  'index.html': 'text/html; charset=utf-8',
  'share.js': 'text/javascript; charset=utf-8',
  'seal.js': 'text/javascript; charset=utf-8',
  'share.css': 'text/css; charset=utf-8',
};

// 上限。暗号文 1 つの大きさ、会ごとの数、人ごとの速さ(collaboration.md の 9.4 の終わり。値はこのカードで決めた)
export const RELAY_LIMITS = Object.freeze({
  maxSessions: 200,
  maxRowBytes: 64 * 1024,
  maxRows: 5000,
  maxFileBytes: 4 * 1024 * 1024,
  maxFiles: 20,
  maxMembers: 50,
  // 人ごとに、windowMs の間に送れる書き込みの数
  rowsPerWindow: 60,
  windowMs: 10_000,
  // 消した会の ID に「消した」と返す長さ
  tombstoneMs: 31 * 24 * 60 * 60 * 1000,
  // 消す日の上限(作る日から)
  maxLifetimeMs: 366 * 24 * 60 * 60 * 1000,
  sweepMs: 60_000,
  heartbeatMs: 15_000,
});

const ID = /^[A-Za-z0-9_-]{8,64}$/;
const FILE_NAME = /^[a-z0-9-]{1,40}$/;
const HASH = /^[0-9a-f]{64}$/;
const B64URL = /^[A-Za-z0-9_-]+$/;

class RelayError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');
const sameHash = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

function send(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(JSON.stringify(body));
}

// 参加者のページの守り。外の場所を読まない。試作品の iframe は 3 枚目で足す(collaboration.md の 9.5)
export const PAGE_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "connect-src 'self'",
  "img-src 'self' data:",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

async function readBody(req, max) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > max) throw new RelayError(413, 'too-large', `送る内容が大きすぎます(上限 ${max} バイト)`);
    chunks.push(chunk);
  }
  if (size === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new RelayError(400, 'invalid', '送る内容が JSON として読めません');
  }
}

// 中継のサーバーの本体。handler を http.createServer に渡す。
// onBody(entry) は受け取った中身を知らせる(テストで、届いたものを全部確かめるため)
export function createRelay({ dataDir = null, limits = {}, now = () => Date.now(), onBody = () => {}, log = () => {} } = {}) {
  const L = { ...RELAY_LIMITS, ...limits };
  const sessions = new Map();
  // 消した会の ID と、消した時刻
  const tombstones = new Map();
  // 会ごとの、受け取りを待つ人(Server-Sent Events)
  const listeners = new Map();
  // 人ごとの書き込みの時刻(速さの上限)
  const rates = new Map();
  // 会ごとの書き込みの列(置き場に順に書く)
  const writes = new Map();
  let sweepTimer = null;

  const fileOf = (id) => path.join(dataDir, `${id}.json`);
  const tombFile = () => path.join(dataDir, 'deleted.json');

  async function atomicWrite(file, text) {
    const tmp = `${file}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    await fs.writeFile(tmp, text);
    await fs.rename(tmp, file);
  }

  function persist(id) {
    if (!dataDir) return Promise.resolve();
    const run = async () => {
      const session = sessions.get(id);
      if (session) await atomicWrite(fileOf(id), JSON.stringify(session));
      else await fs.rm(fileOf(id), { force: true });
      await atomicWrite(tombFile(), JSON.stringify([...tombstones]));
    };
    const next = (writes.get(id) ?? Promise.resolve()).then(run, run);
    writes.set(id, next.catch((error) => log(`中継のサーバーの置き場に書けませんでした: ${error.message}`)));
    return next;
  }

  async function load() {
    if (!dataDir) return;
    await fs.mkdir(dataDir, { recursive: true });
    try {
      for (const [id, at] of JSON.parse(await fs.readFile(tombFile(), 'utf8'))) tombstones.set(id, at);
    } catch (error) {
      if (error.code !== 'ENOENT') log(`消した会の一覧を読めませんでした: ${error.message}`);
    }
    for (const name of await fs.readdir(dataDir)) {
      const match = /^([A-Za-z0-9_-]{8,64})\.json$/.exec(name);
      if (!match) continue;
      try {
        const session = JSON.parse(await fs.readFile(path.join(dataDir, name), 'utf8'));
        if (session?.id === match[1] && Array.isArray(session.rows)) sessions.set(session.id, session);
      } catch (error) {
        log(`会を読めませんでした: ${name}(${error.message})`);
      }
    }
    await sweep();
  }

  function emit(id, event, data) {
    for (const res of listeners.get(id) ?? []) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  function closeListeners(id) {
    for (const res of listeners.get(id) ?? []) res.end();
    listeners.delete(id);
  }

  async function removeSession(id) {
    const session = sessions.get(id);
    if (!session) return null;
    const removed = { rows: session.rows.length, files: Object.keys(session.files).length };
    sessions.delete(id);
    tombstones.set(id, now());
    emit(id, 'deleted', {});
    closeListeners(id);
    await persist(id);
    return removed;
  }

  // 消す日を過ぎた会を消す。消した会の印も、長く残さない
  async function sweep() {
    const t = now();
    for (const [id, session] of sessions) {
      if (session.expiresAt <= t) {
        await removeSession(id);
        log(`消す日を過ぎた会を消しました: ${id}`);
      }
    }
    let changed = false;
    for (const [id, at] of tombstones) {
      if (t - at > L.tombstoneMs) {
        tombstones.delete(id);
        changed = true;
      }
    }
    if (changed && dataDir) await atomicWrite(tombFile(), JSON.stringify([...tombstones]));
  }

  function requireSession(id) {
    if (tombstones.has(id)) throw new RelayError(410, 'deleted', 'この会のデータは消しました');
    const session = sessions.get(id);
    if (!session) throw new RelayError(404, 'not-found', 'その会はありません');
    if (session.expiresAt <= now()) throw new RelayError(410, 'deleted', 'この会のデータは消しました');
    return session;
  }

  // 札から、誰かを決める。Studio か、足した人か
  function who(req, session) {
    const match = /^Bearer ([A-Za-z0-9_-]{16,128})$/.exec(req.headers.authorization ?? '');
    if (!match) throw new RelayError(401, 'ticket', '入る札がありません');
    const hash = sha256(match[1]);
    if (sameHash(hash, session.studioHash)) return { member: 'studio', studio: true, write: true };
    for (const [member, entry] of Object.entries(session.members)) {
      if (sameHash(hash, entry.hash)) return { member, studio: false, write: entry.write === true };
    }
    throw new RelayError(403, 'ticket', 'この会に入る札ではありません');
  }

  function requireStudio(actor) {
    if (!actor.studio) throw new RelayError(403, 'studio-only', 'Studio だけが使える口です');
  }

  function checkRate(id, member) {
    const key = `${id}:${member}`;
    const t = now();
    const recent = (rates.get(key) ?? []).filter((at) => t - at < L.windowMs);
    if (recent.length >= L.rowsPerWindow) throw new RelayError(429, 'too-fast', '書き込みが速すぎます。少し待ってください');
    recent.push(t);
    rates.set(key, recent);
  }

  const cipher = (value, max) => {
    if (typeof value !== 'string' || !B64URL.test(value)) throw new RelayError(400, 'invalid', 'data は暗号文(base64url)です');
    if (value.length > max) throw new RelayError(413, 'too-large', `暗号文が大きすぎます(上限 ${max} 文字)`);
    return value;
  };

  async function createSession(body) {
    if (sessions.size >= L.maxSessions) throw new RelayError(503, 'full', '中継のサーバーの会の数が上限です');
    const expiresAt = Date.parse(body?.expiresAt ?? '');
    if (!Number.isFinite(expiresAt) || expiresAt <= now() || expiresAt - now() > L.maxLifetimeMs) throw new RelayError(400, 'invalid', 'expiresAt は、これから先の日時にしてください');
    if (!HASH.test(body?.studioTicketHash ?? '')) throw new RelayError(400, 'invalid', 'studioTicketHash は SHA-256 の 16 進です');
    const id = crypto.randomBytes(16).toString('base64url');
    sessions.set(id, { id, createdAt: now(), expiresAt, studioHash: body.studioTicketHash, members: {}, rows: [], nextSeq: 1, files: {} });
    await persist(id);
    return { id, expiresAt: new Date(expiresAt).toISOString() };
  }

  function stream(req, res, id, session) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      Connection: 'keep-alive',
    });
    const files = Object.fromEntries(Object.entries(session.files).map(([name, file]) => [name, file.version]));
    res.write(`event: hello\ndata: ${JSON.stringify({ last: session.nextSeq - 1, files })}\n\n`);
    const set = listeners.get(id) ?? new Set();
    set.add(res);
    listeners.set(id, set);
    const beat = setInterval(() => res.write(': beat\n\n'), L.heartbeatMs);
    beat.unref?.();
    const done = () => {
      clearInterval(beat);
      set.delete(res);
    };
    req.on('close', done);
    res.on('close', done);
  }

  async function handleApi(req, res, url) {
    if (req.method === 'POST' && url.pathname === '/api/sessions') {
      const body = await readBody(req, 4096);
      onBody({ method: req.method, path: url.pathname, body });
      return send(res, 201, await createSession(body));
    }
    const match = /^\/api\/sessions\/([^/]+)(?:\/(members|rows|stream|compact|files)(?:\/([^/]+))?)?$/.exec(url.pathname);
    if (!match || !ID.test(match[1])) throw new RelayError(404, 'not-found', 'その口はありません');
    const [, id, part, name] = match;
    const session = requireSession(id);
    const actor = who(req, session);

    if (!part && req.method === 'DELETE') {
      requireStudio(actor);
      return send(res, 200, { removed: await removeSession(id) });
    }
    if (part === 'members' && name && (req.method === 'PUT' || req.method === 'DELETE')) {
      requireStudio(actor);
      if (!ID.test(name) || name === 'studio') throw new RelayError(400, 'invalid', '人の ID の形が違います');
      if (req.method === 'DELETE') {
        delete session.members[name];
      } else {
        const body = await readBody(req, 4096);
        onBody({ method: req.method, path: url.pathname, body });
        if (!HASH.test(body?.ticketHash ?? '')) throw new RelayError(400, 'invalid', 'ticketHash は SHA-256 の 16 進です');
        if (!session.members[name] && Object.keys(session.members).length >= L.maxMembers) throw new RelayError(409, 'full', `人は ${L.maxMembers} 人までです`);
        session.members[name] = { hash: body.ticketHash, write: body.write === true };
      }
      await persist(id);
      return send(res, 200, { ok: true });
    }
    if (part === 'rows' && !name && req.method === 'POST') {
      if (!actor.write) throw new RelayError(403, 'read-only', '見るだけの人は書けません');
      checkRate(id, actor.member);
      const body = await readBody(req, L.maxRowBytes + 1024);
      onBody({ method: req.method, path: url.pathname, body, member: actor.member });
      const data = cipher(body?.data, L.maxRowBytes);
      if (session.rows.length >= L.maxRows) throw new RelayError(409, 'full', '会の書き込みの数が上限です。進行役の Studio が詰め直すまで待ってください');
      const row = { seq: session.nextSeq, member: actor.member, at: new Date(now()).toISOString(), data };
      session.nextSeq += 1;
      session.rows.push(row);
      await persist(id);
      emit(id, 'row', { seq: row.seq });
      return send(res, 201, { seq: row.seq });
    }
    if (part === 'rows' && !name && req.method === 'GET') {
      const since = Number(url.searchParams.get('since') ?? 0);
      if (!Number.isInteger(since) || since < 0) throw new RelayError(400, 'invalid', 'since は 0 以上の整数です');
      return send(res, 200, { rows: session.rows.filter((row) => row.seq > since), last: session.nextSeq - 1 });
    }
    if (part === 'stream' && !name && req.method === 'GET') return stream(req, res, id, session);
    if (part === 'compact' && !name && req.method === 'POST') {
      requireStudio(actor);
      const body = await readBody(req, 1024);
      const upTo = Number(body?.upTo);
      if (!Number.isInteger(upTo) || upTo < 0) throw new RelayError(400, 'invalid', 'upTo は 0 以上の整数です');
      const before = session.rows.length;
      session.rows = session.rows.filter((row) => row.seq > upTo);
      await persist(id);
      return send(res, 200, { removed: before - session.rows.length });
    }
    if (part === 'files' && name) {
      if (!FILE_NAME.test(name)) throw new RelayError(400, 'invalid', 'ファイルの名前の形が違います');
      if (req.method === 'PUT') {
        requireStudio(actor);
        const body = await readBody(req, L.maxFileBytes + 1024);
        onBody({ method: req.method, path: url.pathname, body });
        const data = cipher(body?.data, L.maxFileBytes);
        if (!session.files[name] && Object.keys(session.files).length >= L.maxFiles) throw new RelayError(409, 'full', `ファイルは ${L.maxFiles} 個までです`);
        const version = (session.files[name]?.version ?? 0) + 1;
        session.files[name] = { version, at: new Date(now()).toISOString(), data };
        await persist(id);
        emit(id, 'file', { name, version });
        return send(res, 200, { version });
      }
      if (req.method === 'GET') {
        const file = session.files[name];
        if (!file) throw new RelayError(404, 'not-found', 'そのファイルはまだありません');
        return send(res, 200, file);
      }
    }
    throw new RelayError(405, 'method', 'その口では使えない操作です');
  }

  async function servePage(res, name) {
    const body = await fs.readFile(path.join(PAGE_DIR, name));
    res.writeHead(200, {
      'Content-Type': PAGE_FILES[name],
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': PAGE_CSP,
    });
    res.end(body);
  }

  async function handler(req, res) {
    let url;
    try {
      url = new URL(req.url, 'http://relay.invalid');
    } catch {
      return send(res, 400, { error: { code: 'invalid', message: 'URL が読めません' } });
    }
    try {
      if (req.method === 'GET' && /^\/s\/[A-Za-z0-9_-]{8,64}$/.test(url.pathname)) return await servePage(res, 'index.html');
      const asset = /^\/s\/([a-z]+\.(?:js|css))$/.exec(url.pathname);
      if (req.method === 'GET' && asset && Object.hasOwn(PAGE_FILES, asset[1])) return await servePage(res, asset[1]);
      if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
      return send(res, 404, { error: { code: 'not-found', message: 'ありません' } });
    } catch (error) {
      if (error instanceof RelayError) return send(res, error.status, { error: { code: error.code, message: error.message } });
      log(`中継のサーバーで失敗しました: ${error.message}`);
      if (!res.headersSent) send(res, 500, { error: { code: 'failed', message: '中継のサーバーで失敗しました' } });
      else res.end();
    }
  }

  return {
    handler,
    load,
    sweep,
    startSweeping() {
      sweepTimer = setInterval(() => sweep().catch((error) => log(error.message)), L.sweepMs);
      sweepTimer.unref?.();
    },
    // テストと運用の確かめ。中身は暗号文のまま
    sessions,
    async close() {
      clearInterval(sweepTimer);
      for (const id of [...listeners.keys()]) closeListeners(id);
      await Promise.all([...writes.values()]);
    },
  };
}

// 中継のサーバーを起こす。テストと bin/relay.js から使う。待ち受けの既定は 127.0.0.1
export async function startRelay({ port = 0, host = '127.0.0.1', ...options } = {}) {
  const relay = createRelay(options);
  await relay.load();
  relay.startSweeping();
  const server = http.createServer(relay.handler);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const actual = server.address().port;
  const shownHost = host.includes(':') ? `[${host}]` : host;
  return {
    url: `http://${shownHost}:${actual}`,
    port: actual,
    relay,
    async close() {
      await relay.close();
      await new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      });
    },
  };
}
