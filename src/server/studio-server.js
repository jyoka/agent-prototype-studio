import fs from 'node:fs/promises';
import path from 'node:path';
import { STUDIO_ROOT } from './config.js';
import { isAllowedHost, tokensEqual } from './security.js';
import { AgentUnavailableError, RequestError } from './build-requests.js';
import { AiError } from './product-ai/session.js';
import { BusyError, NotFoundError } from './store.js';
import { VersionError } from './versions.js';

const MAX_BODY_BYTES = 64 * 1024;

const UI_DIR = path.join(STUDIO_ROOT, 'src', 'ui');
const UI_FILES = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/studio.js': ['studio.js', 'text/javascript; charset=utf-8'],
  '/studio.css': ['studio.css', 'text/css; charset=utf-8'],
};

function sendJson(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(JSON.stringify(body));
}

function sendError(res, status, code, message) {
  sendJson(res, status, { error: { code, message } });
}

export function studioCsp(previewPort) {
  return [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "connect-src 'self'",
    `frame-src http://localhost:${previewPort}`,
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');
}

class BodyError extends Error {}

// 中身のない POST(リセットなど)は {} として読む。中身があるときは JSON の Content-Type を求める
async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new BodyError(`送る内容が大きすぎます(上限 ${MAX_BODY_BYTES} バイト)`);
    chunks.push(chunk);
  }
  if (size === 0) return {};
  if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) {
    throw new BodyError('Content-Type は application/json にしてください');
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new BodyError('送る内容が JSON として読めません');
  }
}

function projectView(project, previewPort, runs) {
  return {
    id: project.id,
    title: project.title,
    appDir: project.appDir,
    building: project.building,
    versioning: project.versioning,
    running: runs.running,
    runsVersion: runs.version,
    lastBuild: project.lastBuild,
    previewUrl: project.previewBuildId
      ? `http://localhost:${previewPort}/p/${project.id}/${project.previewBuildId}/`
      : null,
  };
}

// Studio 画面と API。API はすべてトークンを要求する(ADR-0001 の層 3)。
export function createStudioHandler({ store, requests, agent, aiSessions, versions, token, ports }) {
  const view = (project) => projectView(project, ports.preview, requests.summary(project.id));

  // 作る欄の依頼。実行の様子を、1 行 1 つの JSON(NDJSON)で流す。
  // EventSource はヘッダーにトークンを付けられないので、画面は fetch の応答をストリームで読む(ADR-0001)。
  async function handleBuildRequest(req, res, id) {
    let started;
    try {
      const body = await readJson(req);
      started = await requests.start(id, body?.request);
    } catch (error) {
      if (error instanceof NotFoundError) return sendError(res, 404, 'not-found', `プロジェクトがありません: ${id}`);
      if (error instanceof BusyError) return sendError(res, 409, 'busy', error.message);
      if (error instanceof RequestError || error instanceof BodyError) return sendError(res, 400, 'request', error.message);
      if (error instanceof AgentUnavailableError) return sendError(res, 503, 'agent', error.message);
      throw error;
    }
    res.writeHead(200, {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    const write = (run) => {
      if (!res.writableEnded) res.write(`${JSON.stringify({ run })}\n`);
    };
    write(started.run);
    // 画面を閉じても、実行は続ける。結果は一覧の API で読める
    const unsubscribe = started.subscribe(write, (run) => {
      write(run);
      res.end();
    });
    res.on('close', unsubscribe);
  }

  async function handleApi(req, res, url) {
    if (!tokensEqual(req.headers['x-studio-token'], token)) {
      return sendError(res, 401, 'token', '鍵が合いません。ターミナルに表示された URL から開き直してください');
    }
    if (req.method !== 'GET' && req.headers.origin !== `http://${req.headers.host.toLowerCase()}`) {
      return sendError(res, 403, 'origin', 'Studio の画面以外からの操作は受け付けません');
    }
    if (req.method === 'GET' && url.pathname === '/api/projects') {
      const projects = await store.list();
      return sendJson(res, 200, { projects: projects.map(view), agent });
    }
    const requestsMatch = /^\/api\/projects\/([a-z0-9-]{1,64})\/build-requests$/.exec(url.pathname);
    if (requestsMatch && req.method === 'GET') {
      try {
        await store.requireProject(requestsMatch[1]);
      } catch (error) {
        if (error instanceof NotFoundError) return sendError(res, 404, 'not-found', error.message);
        throw error;
      }
      return sendJson(res, 200, { runs: requests.list(requestsMatch[1]) });
    }
    if (requestsMatch && req.method === 'POST') return handleBuildRequest(req, res, requestsMatch[1]);
    const cancelMatch = /^\/api\/projects\/([a-z0-9-]{1,64})\/build-requests\/([a-f0-9]{16})\/cancel$/.exec(url.pathname);
    if (cancelMatch && req.method === 'POST') {
      const run = requests.cancel(cancelMatch[1], cancelMatch[2]);
      if (!run) return sendError(res, 409, 'not-running', 'その依頼は、もう動いていません');
      return sendJson(res, 200, { run });
    }
    const buildMatch = /^\/api\/projects\/([^/]+)\/builds$/.exec(url.pathname);
    if (req.method === 'POST' && buildMatch) {
      let id;
      try {
        id = decodeURIComponent(buildMatch[1]);
        await store.build(id);
      } catch (error) {
        if (error instanceof NotFoundError || error instanceof URIError) {
          return sendError(res, 404, 'not-found', `プロジェクトがありません: ${buildMatch[1]}`);
        }
        if (error instanceof BusyError) return sendError(res, 409, 'busy', error.message);
        throw error;
      }
      const project = (await store.list()).find((p) => p.id === id);
      return sendJson(res, 200, { project: view(project) });
    }
    const versionsMatch = /^\/api\/projects\/([a-z0-9-]{1,64})\/versions(?:\/([^/]+)\/(restore))?$/.exec(url.pathname);
    if (versionsMatch) {
      const [, id, versionId, restore] = versionsMatch;
      if (req.method === 'GET' && !restore) return handleVersions(req, res, id, null);
      if (req.method === 'POST') return handleVersions(req, res, id, restore ? versionId : undefined);
    }
    const aiMatch = /^\/api\/projects\/([^/]+)\/ai(?:\/(messages|corrections|reset))?$/.exec(url.pathname);
    if (aiMatch && (aiMatch[2] ? req.method === 'POST' : req.method === 'GET')) {
      return handleAi(req, res, aiMatch[1], aiMatch[2]);
    }
    return sendError(res, 404, 'not-found', 'その API はありません');
  }

  // 版。versionId が null なら一覧、undefined なら保存、文字列ならその版の復元
  async function handleVersions(req, res, id, versionId) {
    try {
      if (versionId === null) return sendJson(res, 200, await versions.list(id));
      const body = await readJson(req);
      if (versionId === undefined) return sendJson(res, 200, await versions.save(id, { name: body?.name }));
      return sendJson(res, 200, await versions.restore(id, versionId));
    } catch (error) {
      if (error instanceof NotFoundError) return sendError(res, 404, 'not-found', error.message);
      if (error instanceof BusyError) return sendError(res, 409, 'busy', error.message);
      if (error instanceof VersionError) return sendError(res, error.status, error.code, error.message);
      if (error instanceof BodyError) return sendError(res, 400, 'invalid', error.message);
      throw error;
    }
  }

  // プロダクト内 AI。試作品からの要求は、Studio 画面が形を確かめてから、ここへ送る
  async function handleAi(req, res, rawId, action) {
    let id;
    try {
      id = decodeURIComponent(rawId);
    } catch {
      id = null;
    }
    if (!(await store.list()).some((p) => p.id === id)) {
      return sendError(res, 404, 'not-found', `プロジェクトがありません: ${rawId}`);
    }
    // 版の保存と復元の間は、会話を変えない(戻した会話や自動の版から、発言が抜け落ちないように)
    if (action && store.isVersioning(id)) {
      return sendError(res, 409, 'busy', '版を保存か復元しているところです。終わってから試してください');
    }
    try {
      const body = action ? await readJson(req) : null;
      // 本文を読んでいる間に、版の操作が始まったかもしれない
      if (action && store.isVersioning(id)) {
        return sendError(res, 409, 'busy', '版を保存か復元しているところです。終わってから試してください');
      }
      let session;
      if (!action) session = aiSessions.view(id);
      else if (action === 'messages') session = await aiSessions.send(id, body?.text);
      else if (action === 'corrections') session = aiSessions.correct(id, body?.changes);
      else session = aiSessions.reset(id);
      return sendJson(res, 200, { session });
    } catch (error) {
      if (error instanceof AiError) return sendError(res, error.status, error.code, error.message);
      if (error instanceof BodyError) return sendError(res, 400, 'invalid', error.message);
      throw error;
    }
  }

  return async (req, res) => {
    try {
      if (!isAllowedHost(req.headers.host, ports.studio)) {
        res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Host が正しくありません');
        return;
      }
      const url = new URL(req.url, 'http://studio.invalid');
      if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);

      const uiFile = UI_FILES[url.pathname];
      if (!uiFile || req.method !== 'GET') {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('見つかりません');
        return;
      }
      const body = await fs.readFile(path.join(UI_DIR, uiFile[0]));
      res.writeHead(200, {
        'Content-Type': uiFile[1],
        'Content-Security-Policy': studioCsp(ports.preview),
        'X-Frame-Options': 'DENY',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
        'Cache-Control': 'no-store',
      });
      res.end(body);
    } catch (error) {
      console.error(error);
      if (!res.headersSent) sendError(res, 500, 'internal', 'Studio のサーバーで問題が起きました。ターミナルの表示を確かめてください');
    }
  };
}
