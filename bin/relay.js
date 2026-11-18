#!/usr/bin/env node
// 中継のサーバーを手元で起こす(docs/design/collaboration.md の 9.4)。
// 暗号文を預かって配るだけ。中身は読めない。外へ出すときは、前に HTTPS の口(逆向きの proxy など)を置く。
// RELAY_HOST(既定 127.0.0.1)、RELAY_PORT(既定 4320)、RELAY_DATA(置き場。書かなければメモリーだけ)
import path from 'node:path';
import { startRelay } from '../src/relay/relay-server.js';

const host = process.env.RELAY_HOST || '127.0.0.1';
const port = Number(process.env.RELAY_PORT || 4320);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  console.error(`RELAY_PORT は 0 から 65535 の番号にしてください(今の値: ${process.env.RELAY_PORT})`);
  process.exit(1);
}
const dataDir = process.env.RELAY_DATA ? path.resolve(process.env.RELAY_DATA) : null;
const relay = await startRelay({ host, port, dataDir, log: (line) => console.log(line) });
console.log(`中継のサーバーを起動しました: ${relay.url}`);
console.log(dataDir ? `置き場: ${dataDir}` : '置き場: メモリーだけ(止めると消えます)');
console.log('Studio は STUDIO_RELAY_URL にこの URL を書いて起動します。止めるときは Ctrl+C を押してください。');

async function stop() {
  await relay.close();
  process.exit(0);
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
