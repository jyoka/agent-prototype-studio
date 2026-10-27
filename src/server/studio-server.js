import fs from 'node:fs/promises';
import path from 'node:path';
import { STUDIO_ROOT } from './config.js';
import { isAllowedHost, tokensEqual } from './security.js';
import { BusyError, NotFoundError } from './store.js';

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

function projectView(project, previewPort) {
  return {
    id: project.id,
    title: project.title,
    appDir: project.appDir,
    building: project.building,
    lastBuild: project.lastBuild,
    previewUrl: project.previewBuildId
      ? `http://localhost:${previewPort}/p/${project.id}/${project.previewBuildId}/`
      : null,
  };
}

// Studio 画面と API。API はすべてトークンを要求する(ADR-0001 の層 3)。
export function createStudioHandler({ store, token, ports }) {
  async function handleApi(req, res, url) {
    if (!tokensEqual(req.headers['x-studio-token'], token)) {
      return sendError(res, 401, 'token', '鍵が合いません。ターミナルに表示された URL から開き直してください');
    }
    if (req.method !== 'GET' && req.headers.origin !== `http://${req.headers.host.toLowerCase()}`) {
      return sendError(res, 403, 'origin', 'Studio の画面以外からの操作は受け付けません');
    }
    if (req.method === 'GET' && url.pathname === '/api/projects') {
      const projects = await store.list();
      return sendJson(res, 200, { projects: projects.map((p) => projectView(p, ports.preview)) });
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
      return sendJson(res, 200, { project: projectView(project, ports.preview) });
    }
    return sendError(res, 404, 'not-found', 'その API はありません');
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
