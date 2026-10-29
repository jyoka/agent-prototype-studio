#!/usr/bin/env node
// LP(site/)を手元で開く(npm run site)。公開はしない。公開の手順は site/README.md。
// 配るのは site/ と assets/brand/、assets/media/ だけ。127.0.0.1 だけで待ち、外から読み込むものはない。
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_PORT = 4319;

// URL の頭 → 配るフォルダー。上から順に見る
const MOUNTS = [
  ['/assets/brand/', path.join(ROOT, 'assets/brand')],
  ['/assets/media/', path.join(ROOT, 'assets/media')],
  ['/', path.join(ROOT, 'site')],
];

// 配るのはこの形だけ。site/README.md(公開の手順)は配らない
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webm': 'video/webm',
};

// URL のパスを、配ってよいファイルの場所にする。配らないものは null
export function resolveSitePath(urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;
  if (decoded.endsWith('/')) decoded += 'index.html';
  const [prefix, dir] = MOUNTS.find(([head]) => decoded.startsWith(head));
  const file = path.resolve(dir, decoded.slice(prefix.length));
  if (!file.startsWith(dir + path.sep)) return null;
  if (!TYPES[path.extname(file)]) return null;
  return file;
}

export async function startSite({ port = DEFAULT_PORT, host = '127.0.0.1' } = {}) {
  const server = http.createServer(async (req, res) => {
    const headers = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store' };
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { ...headers, Allow: 'GET, HEAD' }).end();
      return;
    }
    let body;
    let file;
    try {
      // 壊れた要求の行(GET http://[ など)でも、落ちずに 404 を返す
      file = resolveSitePath(new URL(req.url, 'http://localhost').pathname);
      if (!file) throw new Error('配らないパス');
      body = await fs.readFile(file);
    } catch {
      res.writeHead(404, { ...headers, 'Content-Type': 'text/plain; charset=utf-8' }).end('見つかりません');
      return;
    }
    res.writeHead(200, { ...headers, 'Content-Type': TYPES[path.extname(file)], 'Content-Length': body.length });
    res.end(req.method === 'HEAD' ? undefined : body);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  const url = `http://${host}:${server.address().port}/`;
  return {
    url,
    stop: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

function openBrowser(url) {
  const [command, args, options] =
    process.platform === 'darwin'
      ? ['open', [url], {}]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '""', `"${url}"`], { windowsVerbatimArguments: true }]
        : ['xdg-open', [url], {}];
  const child = spawn(command, args, { stdio: 'ignore', detached: true, ...options });
  child.on('error', () => console.log('ブラウザを自動で開けませんでした。上の URL をブラウザに貼り付けてください。'));
  child.unref();
}

async function main() {
  const port = process.env.STUDIO_SITE_PORT ? Number(process.env.STUDIO_SITE_PORT) : DEFAULT_PORT;
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error(`LP を開けません: STUDIO_SITE_PORT は 0 から 65535 の数にしてください(今は ${process.env.STUDIO_SITE_PORT})。`);
    process.exit(1);
  }
  let site;
  try {
    site = await startSite({ port });
  } catch (error) {
    if (error.code !== 'EADDRINUSE') throw error;
    console.error(`LP を開けません: ポート ${port} が使われています。STUDIO_SITE_PORT=4320 npm run site のように別のポートを選んでください。`);
    process.exit(1);
  }
  console.log(`LP: ${site.url}(手元だけ。公開はしていません)`);
  console.log('止めるときは Ctrl+C です。');
  if (process.env.STUDIO_NO_OPEN !== '1') openBrowser(site.url);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
