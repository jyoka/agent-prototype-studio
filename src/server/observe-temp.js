import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 観察の道具の MCP サーバーの一時フォルダー(bin/observe-mcp.js)。
// サーバーは起動ごとに 1 つ、OS の一時フォルダーの下に作り、TMPDIR をそこに向ける。
// 作業中の app/ のビルド(observe-entry.js)も、Playwright が作るブラウザのプロフィールなども、この中にできる。
// 終わるときはこのフォルダーごと消す。片付けの途中で強制終了されて残ったものは、次の起動で消す。
// 名前の決まり: prototype-studio-observe-mcp-<作ったプロセスの番号>-<6 文字>。
// このモジュールは Playwright を import しない(TMPDIR を向ける前に読むため)
export const SERVER_TEMP_PREFIX = 'prototype-studio-observe-mcp-';
const SERVER_TEMP_NAME = /^prototype-studio-observe-mcp-([1-9]\d*)-[A-Za-z0-9]{6}$/;

// プロセスが動いているか。ほかの利用者のプロセス(EPERM)も動いているとみなす
export function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

export function createServerTemp(base = os.tmpdir()) {
  return fs.mkdtempSync(path.join(base, `${SERVER_TEMP_PREFIX}${process.pid}-`));
}

// 子プロセス(esbuild、ブラウザ)にも同じ一時フォルダーを使わせる。Windows は TEMP と TMP を見る
export function useTempDir(dir) {
  for (const name of ['TMPDIR', 'TMP', 'TEMP']) process.env[name] = dir;
}

// 前の起動が残した一時フォルダーを消し、消したフォルダーを返す。消すのは、次のすべてに当たるものだけ:
// 名前の決まりに合う、シンボリックリンクではないフォルダー、同じ利用者のもの、作ったプロセスがもう動いていない。
// 動いているほかのサーバーのもの、CLI(bin/observe.js)のもの、ほかのプログラムのものは消さない
export function sweepServerTemps(base = os.tmpdir(), { isAlive = isProcessAlive } = {}) {
  let names;
  try {
    names = fs.readdirSync(base);
  } catch {
    return [];
  }
  const removed = [];
  for (const name of names) {
    const pid = Number(SERVER_TEMP_NAME.exec(name)?.[1]);
    if (!pid || pid === process.pid || isAlive(pid)) continue;
    const dir = path.join(base, name);
    try {
      const stat = fs.lstatSync(dir);
      if (!stat.isDirectory()) continue;
      if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) continue;
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 2 });
      removed.push(dir);
    } catch {
      // 消せないものは次の起動でまた試す。起動は止めない
    }
  }
  return removed;
}
