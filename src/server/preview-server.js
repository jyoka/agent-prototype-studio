import fs from 'node:fs/promises';
import path from 'node:path';
import { isAllowedHost } from './security.js';
import { projectPaths } from './projects.js';

const ROUTE = /^\/p\/([a-z0-9-]{1,64})\/([a-f0-9]{32})\/([A-Za-z0-9][A-Za-z0-9._-]{0,127})?$/;

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
};

// CSP の sandbox は、プレビューの URL を直接開いたときにも効く。
// 'self' でなくパスつきの URL にして、他のプロジェクトや版を読ませない。
export function previewCsp({ base, studioPort }) {
  return [
    'sandbox allow-scripts allow-forms',
    "default-src 'none'",
    `script-src ${base}`,
    `style-src ${base} 'unsafe-inline'`,
    `img-src ${base} data: blob:`,
    `font-src ${base}`,
    "connect-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
    `frame-ancestors http://127.0.0.1:${studioPort} http://localhost:${studioPort}`,
  ].join('; ');
}

function notFound(res) {
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff' });
  res.end('見つかりません');
}

// プレビューは静的ファイルだけを返す。API は置かない(ADR-0001 の層 2)。
export function createPreviewHandler({ home, store, ports }) {
  return async (req, res) => {
    try {
      if (!isAllowedHost(req.headers.host, ports.preview)) {
        res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Host が正しくありません');
        return;
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { Allow: 'GET, HEAD' });
        res.end();
        return;
      }
      const url = new URL(req.url, 'http://preview.invalid');
      const match = ROUTE.exec(url.pathname);
      if (!match) return notFound(res);
      const [, projectId, buildId, fileName = 'index.html'] = match;
      // 表示中の版だけを返す
      if (store.previewBuildId(projectId) !== buildId) return notFound(res);

      const buildDir = path.join(projectPaths(home, projectId).builds, buildId);
      const file = path.join(buildDir, fileName);
      const stat = await fs.lstat(file).catch(() => null);
      if (!stat?.isFile()) return notFound(res);
      const [realDir, realFile] = await Promise.all([fs.realpath(buildDir), fs.realpath(file)]);
      if (path.dirname(realFile) !== realDir) return notFound(res);

      const base = `http://${req.headers.host.toLowerCase()}/p/${projectId}/${buildId}/`;
      const headers = {
        'Content-Type': CONTENT_TYPES[path.extname(fileName).toLowerCase()] ?? 'application/octet-stream',
        'Content-Security-Policy': previewCsp({ base, studioPort: ports.studio }),
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
        'Cache-Control': 'no-store',
        Vary: 'Origin',
      };
      // opaque origin の試作品が crossorigin 付きで読む script だけに許す。
      // これがないと実行時エラーの中身が "Script error." に隠れる。
      if (req.headers.origin === 'null') headers['Access-Control-Allow-Origin'] = 'null';
      const body = await fs.readFile(realFile);
      res.writeHead(200, headers);
      res.end(req.method === 'HEAD' ? undefined : body);
    } catch (error) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('プレビューの配信に失敗しました');
      console.error(error);
    }
  };
}
