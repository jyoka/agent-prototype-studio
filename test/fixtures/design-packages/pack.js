import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';

// テストの fixtures のフォルダーを、npm pack と同じ形(package/ の下に入れた tar を gzip したもの)にする。
// npm を動かさないので、スクリプトは動かない。extra で足すか変えるファイルを渡せる({ 'package.json': '...' })。
// links には、リンクの名前と指す先を渡せる(断ることを確かめるため)
function header(name, size, type = '0', linkName = '') {
  const block = Buffer.alloc(512);
  block.write(name, 0, 100, 'utf8');
  block.write('0000644\0', 100);
  block.write('0000000\0', 108);
  block.write('0000000\0', 116);
  block.write(`${size.toString(8).padStart(11, '0')}\0`, 124);
  block.write('00000000000\0', 136);
  block.write('        ', 148);
  block.write(type, 156);
  block.write(linkName, 157, 100, 'utf8');
  block.write('ustar\0', 257);
  block.write('00', 263);
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
  return block;
}

// pax には、pax の見出しの項目を渡せる({ 'package.json': { size: '10' } })
function paxBlock(records) {
  const body = Object.entries(records).map(([key, value]) => {
    const line = ` ${key}=${value}\n`;
    let length = line.length + 1;
    while (`${length}${line}`.length !== length) length += 1;
    return `${length}${line}`;
  }).join('');
  const data = Buffer.from(body);
  return [header('PaxHeader', data.length, 'x'), data, Buffer.alloc((512 - (data.length % 512)) % 512)];
}

export function tarball(files, { links = {}, pax = {} } = {}) {
  const parts = [];
  for (const [name, records] of Object.entries(pax)) parts.push(...paxBlock({ path: `package/${name}`, ...records }));
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content);
    parts.push(header(`package/${name}`, data.length), data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  for (const [name, target] of Object.entries(links)) parts.push(header(`package/${name}`, 0, '2', target));
  parts.push(Buffer.alloc(1024));
  return zlib.gzipSync(Buffer.concat(parts));
}

export async function readFixture(dir) {
  const files = {};
  for (const name of (await fs.readdir(dir)).sort()) files[name] = await fs.readFile(path.join(dir, name));
  return files;
}

export async function packFixture(dir, extra = {}, options = {}) {
  return tarball({ ...(await readFixture(dir)), ...extra }, options);
}
