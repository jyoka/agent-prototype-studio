import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import * as esbuild from 'esbuild';
import { NPM_LIBRARIES, STUDIO_PACKAGES, isAllowedPackage } from './build-libraries.js';
import { findExternalUrls, licenseView, sha256 } from './guides.js';
import { findSecrets } from './redact.js';

// 部品のパッケージ(npm のパッケージ)の取り込み(docs/design/user-journey.md の J5 の後半、
// docs/design/design-materials.md の 5 節「J5 の後半で決めたこと」、ADR 0001 の「J5 の後半で決めたこと」)。
// 受け取るのは npm pack で作ったファイル(.tgz)だけ。展開はこのファイルの中の決まった手順で行い、
// npm も、パッケージのスクリプトも、パッケージのコードも動かさない。外へ通信しない。
// ここは検査と、展開した中身を返すだけ。置くのは materials.js

// 上限(仮)。展開した中身は app/ の外(.studio/materials/packages/)に置くので、app/ の上限とは別に決める
export const PACKAGE_LIMITS = {
  maxTarballBytes: 5 * 1024 * 1024,
  maxUnpackedBytes: 20 * 1024 * 1024,
  maxFiles: 2000,
  maxFileBytes: 5 * 1024 * 1024,
  maxFindings: 50,
  maxExports: 200,
  // 試作品ごとに有効にできるパッケージの数
  maxPackages: 10,
};

// npm がインストールの時に動かすスクリプト。Studio は動かさないが、本番の npm install では動く
const INSTALL_SCRIPTS = ['preinstall', 'install', 'postinstall', 'preprepare', 'prepare', 'postprepare'];
// npm のパッケージの名前の形(https://docs.npmjs.com/cli/v11/configuring-npm/package-json#name)
const NAME_PATTERN = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;
// 版の形(semver)。直す AI への決まりの文に入るので、ほかの文字を入れない
const VERSION_PATTERN = /^\d{1,9}\.\d{1,9}\.\d{1,9}(?:-[0-9A-Za-z.-]{1,30})?(?:\+[0-9A-Za-z.-]{1,30})?$/;
// pax の見出しで受ける項目。大きさ(size)などを pax で変えるファイルは、展開する道具ごとに読み方が違うので断る
const PAX_KEYS = new Set(['path', 'mtime', 'atime', 'ctime', 'uid', 'gid', 'uname', 'gname', 'comment', 'charset', 'hdrcharset', 'SCHILY.dev', 'SCHILY.ino', 'SCHILY.nlink', 'LIBARCHIVE.creationtime']);
const TEXT_FILE = /\.(?:m?js|cjs|jsx|ts|tsx|css|json|html?|svg|md|txt)$/i;
const CODE_FILE = /\.(?:m?js|cjs|jsx|css|html?|svg)$/i;
// 外へ通信する道具の名前。ブラウザの中で動くので、試作品の CSP が止める。知らせるために探す
const NETWORK_APIS = [
  [/\bfetch\s*\(/, 'fetch'],
  [/\bXMLHttpRequest\b/, 'XMLHttpRequest'],
  [/\bWebSocket\b/, 'WebSocket'],
  [/\bEventSource\b/, 'EventSource'],
  [/\bsendBeacon\b/, 'sendBeacon'],
  [/\bRTCPeerConnection\b/, 'RTCPeerConnection'],
  [/\bimportScripts\s*\(/, 'importScripts'],
];

const problem = (file, text, line = null) => ({ file, line, text });

export class PackageReadError extends Error {}

function tarString(block, start, length) {
  const raw = block.subarray(start, start + length);
  const end = raw.indexOf(0);
  return raw.subarray(0, end === -1 ? raw.length : end).toString('utf8');
}

function tarNumber(block, start, length) {
  const text = tarString(block, start, length).trim();
  if (text === '') return 0;
  if (!/^[0-7]+$/.test(text)) throw new PackageReadError('ファイルの中の大きさの欄が読めません');
  return Number.parseInt(text, 8);
}

// pax の拡張の見出し(path=...)を読む。受けない項目があれば断る
function paxPath(data) {
  const text = data.toString('utf8');
  let offset = 0;
  let found = null;
  while (offset < text.length) {
    const space = text.indexOf(' ', offset);
    if (space === -1) break;
    const length = Number.parseInt(text.slice(offset, space), 10);
    if (!Number.isFinite(length) || length <= 0) break;
    const record = text.slice(space + 1, offset + length - 1);
    const key = record.slice(0, record.indexOf('='));
    if (!PAX_KEYS.has(key)) throw new PackageReadError(`読めない形の見出し(${key.slice(0, 40)})があります。npm pack で作り直してください`);
    if (key === 'path') found = record.slice(5);
    offset += length;
  }
  return found;
}

// .tgz を、決まった手順で展開する。ふつうのファイルとフォルダーだけを受け、リンクと特殊なファイルは断る。
// 返す path は、先頭の package/ を落とした、パッケージの中の場所
export function readTarball(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new PackageReadError('ファイルが空です');
  if (buffer.length > PACKAGE_LIMITS.maxTarballBytes) throw new PackageReadError(`ファイルが大きすぎます(上限 ${PACKAGE_LIMITS.maxTarballBytes / 1024 / 1024} MB)`);
  let tar;
  try {
    // 展開した大きさに上限をつける(小さなファイルが大きく膨らむもの)。tar の見出しの分を足す
    tar = zlib.gunzipSync(buffer, { maxOutputLength: PACKAGE_LIMITS.maxUnpackedBytes + PACKAGE_LIMITS.maxFiles * 1024 + 1024 * 1024 });
  } catch (error) {
    if (error?.code === 'ERR_BUFFER_TOO_LARGE' || /larger than/i.test(error?.message ?? '')) throw new PackageReadError(`展開すると大きすぎます(上限 ${PACKAGE_LIMITS.maxUnpackedBytes / 1024 / 1024} MB)`);
    throw new PackageReadError('npm pack で作ったファイル(.tgz)として読めません');
  }
  const files = [];
  // 大文字と小文字だけが違う名前は、macOS や Windows では 1 つのファイルになる。置いた後の指紋が合わなくなるので断る
  const lowerNames = new Map();
  let total = 0;
  let offset = 0;
  let longName = null;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const size = tarNumber(header, 124, 12);
    const type = String.fromCharCode(header[156] || 48);
    const prefix = tarString(header, 345, 155);
    const name = longName ?? (prefix ? `${prefix}/${tarString(header, 0, 100)}` : tarString(header, 0, 100));
    longName = null;
    const dataStart = offset + 512;
    if (dataStart + size > tar.length) throw new PackageReadError('ファイルが途中で切れています');
    const data = tar.subarray(dataStart, dataStart + size);
    offset = dataStart + Math.ceil(size / 512) * 512;
    if (type === 'x') {
      longName = paxPath(data);
      continue;
    }
    if (type === 'g') continue;
    if (type === 'L') {
      longName = tarString(data, 0, data.length);
      continue;
    }
    if (type === '5') continue;
    if (type !== '0' && type !== '7') throw new PackageReadError(`ふつうのファイルでないもの(リンクなど)があります: ${name.slice(0, 200)}`);
    const clean = name.replace(/\\/g, '/');
    const parts = clean.split('/').filter((part) => part !== '' && part !== '.');
    if (clean.startsWith('/') || parts.some((part) => part === '..') || /^[a-z]:/i.test(clean)) {
      throw new PackageReadError(`パッケージの外を指す名前があります: ${clean.slice(0, 200)}`);
    }
    // npm pack は package/ の下に入れる。ほかの名前のフォルダーで作ったものも、先頭の 1 段を落とす
    const inner = parts.slice(1).join('/');
    if (!inner) continue;
    // 名前に制御文字を含むもの、長すぎるものは、置く所で止まるので先に断る
    if (/[\u0000-\u001f\u007f]/.test(inner) || inner.length > 300 || parts.some((part) => part.length > 200)) throw new PackageReadError('使えない名前のファイルがあります');
    // 中に入れた別のパッケージ(bundleDependencies)は受けない。そのインストールの時のスクリプトを確かめられないため
    if (parts.slice(1).includes('node_modules')) throw new PackageReadError('中に別のパッケージ(node_modules)があります。中で使うものは 1 つのファイルにまとめて(bundle して)から npm pack してください');
    if (files.length >= PACKAGE_LIMITS.maxFiles) throw new PackageReadError(`ファイルが多すぎます(上限 ${PACKAGE_LIMITS.maxFiles} 個)`);
    if (size > PACKAGE_LIMITS.maxFileBytes) throw new PackageReadError(`大きすぎるファイルがあります: ${inner.slice(0, 200)}(上限 ${PACKAGE_LIMITS.maxFileBytes / 1024 / 1024} MB)`);
    total += size;
    if (total > PACKAGE_LIMITS.maxUnpackedBytes) throw new PackageReadError(`展開すると大きすぎます(上限 ${PACKAGE_LIMITS.maxUnpackedBytes / 1024 / 1024} MB)`);
    const lower = inner.normalize('NFC').toLowerCase();
    if (lowerNames.has(lower) && lowerNames.get(lower) !== inner) throw new PackageReadError(`大文字と小文字だけが違う名前があります: ${inner.slice(0, 200)}`);
    lowerNames.set(lower, inner);
    const existing = files.findIndex((file) => file.path === inner);
    const entry = { path: inner, data: Buffer.from(data) };
    if (existing >= 0) files[existing] = entry;
    else files.push(entry);
  }
  // ファイルと同じ名前のフォルダーの中にファイルがあるもの(a と a/b.js)は、置けない
  const names = new Set(files.map((file) => file.path.normalize('NFC').toLowerCase()));
  for (const file of files) {
    const parts = file.path.normalize('NFC').toLowerCase().split('/');
    for (let i = 1; i < parts.length; i += 1) {
      if (names.has(parts.slice(0, i).join('/'))) throw new PackageReadError(`ファイルと同じ名前のフォルダーがあります: ${file.path.slice(0, 200)}`);
    }
  }
  return files;
}

export const isPackageName = (name) => typeof name === 'string' && name.length <= 214 && NAME_PATTERN.test(name);

// パッケージの中のファイルの並びの指紋。置いた後に中身が変わっていないかを、関門 G3 で比べる
export function digestFiles(files) {
  const hash = crypto.createHash('sha256');
  for (const file of [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    hash.update(file.path).update('\0').update(crypto.createHash('sha256').update(file.data).digest('hex')).update('\0');
  }
  return hash.digest('hex');
}

// import の名前のうち、パッケージの名前の部分(@scope/name か name)
export function packageNameOf(spec) {
  const parts = spec.split('/');
  return spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

// Studio が同梱するライブラリの名前か(react/jsx-runtime も react の中)
export function isBundledName(name) {
  return NPM_LIBRARIES.includes(name) || STUDIO_PACKAGES.includes(name);
}

function scanNetwork(file, text) {
  const found = findExternalUrls(text, file).map((item) => ({ file, line: item.line, kind: 'url', text: item.url }));
  // CSS の // で始まる外の場所(url(//fonts.example.com/...))
  text.split(/\r?\n/).forEach((lineText, index) => {
    for (const match of lineText.matchAll(/url\(\s*['"]?(\/\/[^)'"\s]+)/gi)) found.push({ file, line: index + 1, kind: 'url', text: match[1].slice(0, 200) });
    for (const [pattern, name] of NETWORK_APIS) {
      if (pattern.test(lineText)) found.push({ file, line: index + 1, kind: 'api', text: name });
    }
  });
  return found;
}

function readManifestFile(files, errors) {
  const file = files.find((f) => f.path === 'package.json');
  if (!file) {
    errors.push(problem('', 'package.json がありません。部品のパッケージのフォルダーで npm pack を動かして作ったファイルを選んでください'));
    return null;
  }
  try {
    const parsed = JSON.parse(file.data.toString('utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch {
    // 下で誤りにする
  }
  errors.push(problem('package.json', 'package.json を JSON として読めません'));
  return null;
}

function stringMap(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value) : [];
}

// パッケージの manifest の決まり。名前、同梱の名前との重なり、インストールの時のスクリプト、中で使うパッケージ
function checkManifest(manifest, files, errors, warnings) {
  const name = typeof manifest.name === 'string' ? manifest.name.trim() : '';
  if (!isPackageName(name)) {
    errors.push(problem('package.json', 'package.json の name が、npm のパッケージの名前の形ではありません'));
  } else if (isBundledName(name) || name.startsWith('@radix-ui/')) {
    errors.push(problem('package.json', `「${name}」は Studio が同梱するライブラリと同じ名前です。別の名前のパッケージにしてください`));
  }
  const version = typeof manifest.version === 'string' ? manifest.version.trim() : '';
  if (!VERSION_PATTERN.test(version)) errors.push(problem('package.json', 'package.json の version が、版の形(1.2.0 など)ではありません'));
  const scripts = manifest.scripts && typeof manifest.scripts === 'object' ? manifest.scripts : {};
  const install = INSTALL_SCRIPTS.filter((key) => typeof scripts[key] === 'string' && scripts[key].trim());
  // binding.gyp があると、npm は書いていなくても node-gyp rebuild を動かす
  if (files.some((f) => f.path === 'binding.gyp') || manifest.gypfile === true) install.push('binding.gyp(node-gyp rebuild)');
  for (const key of install) {
    errors.push(problem('package.json', `インストールの時に動くスクリプトがあります(${key})。Studio はスクリプトを動かしません。本番の npm install では動くので、スクリプトのない形にしてから選んでください`));
  }
  // 中で使うパッケージは、Studio が同梱するものだけ。Studio は npm install を動かさないので、ほかは見つからない
  const needs = [...new Set([...stringMap(manifest.dependencies), ...stringMap(manifest.peerDependencies)])];
  const missing = needs.filter((dep) => !isBundledName(dep));
  for (const dep of missing.slice(0, 10)) {
    errors.push(problem('package.json', `中で使うパッケージ「${dep}」は、Studio に入っていません。使えるのは ${NPM_LIBRARIES.join('、')} です。中で使うものを 1 つのファイルにまとめて(bundle して)から、npm pack してください`));
  }
  const bundled = manifest.bundleDependencies ?? manifest.bundledDependencies;
  if ((Array.isArray(bundled) && bundled.length > 0) || bundled === true) {
    errors.push(problem('package.json', '中に別のパッケージを入れる形(bundleDependencies)は受けません。中で使うものは 1 つのファイルにまとめて(bundle して)から npm pack してください'));
  }
  if (stringMap(manifest.optionalDependencies).length > 0) warnings.push({ kind: 'package', file: 'package.json', line: null, text: 'optionalDependencies は入れません。なくても動く形か確かめてください' });
  return { name, version: VERSION_PATTERN.test(version) ? version : '', installScripts: install, dependencies: needs };
}

function detectedLicense(manifest, files) {
  if (typeof manifest?.license === 'string' && manifest.license.trim()) return manifest.license.trim().slice(0, 100);
  const file = files.find((f) => /^(license|licence)(\.[a-z]+)?$/i.test(f.path));
  const first = file?.data.toString('utf8').split(/\r?\n/).find((line) => line.trim())?.trim();
  return first ? first.slice(0, 100) : null;
}

// 展開した中身を一時フォルダーに置き、試しにビルドする。パッケージのコードは動かさない(esbuild は読むだけ)。
// import できるか、中の import が同梱のライブラリだけか、使える名前(export)を確かめる
export async function trialBuild(name, files) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-package-'));
  try {
    const dir = path.join(tmp, 'node_modules', ...name.split('/'));
    await writeFiles(dir, files);
    const packageReal = await fs.realpath(dir);
    const errors = [];
    let result;
    try {
      result = await esbuild.build({
        stdin: { contents: `export * from ${JSON.stringify(name)};`, resolveDir: tmp, loader: 'js' },
        absWorkingDir: tmp,
        bundle: true,
        write: false,
        format: 'esm',
        platform: 'browser',
        target: ['es2020'],
        metafile: true,
        outdir: path.join(tmp, 'out'),
        logLevel: 'silent',
        tsconfigRaw: '{}',
        loader: { '.png': 'empty', '.jpg': 'empty', '.jpeg': 'empty', '.gif': 'empty', '.svg': 'empty', '.webp': 'empty' },
        plugins: [{
          name: 'studio-trial-imports',
          setup(build) {
            build.onResolve({ filter: /.*/ }, (args) => {
              if (args.pluginData?.inner || args.importer === '<stdin>' || args.kind === 'entry-point') return undefined;
              if (/^data:/i.test(args.path)) return undefined;
              if (/^([a-z][a-z0-9+.-]*:)?\/\//i.test(args.path)) {
                if (args.kind === 'url-token' || args.kind === 'import-rule') return { path: args.path, external: true };
                return { errors: [{ text: `外部の URL は読み込めません: ${args.path}` }] };
              }
              if (!args.path.startsWith('.') && !args.path.startsWith('/')) {
                const dep = packageNameOf(args.path);
                if (dep === name) return undefined;
                // 同梱のライブラリは、試作品と同じ名前だけ(ビルドの決まりと同じ)
                if (isAllowedPackage(args.path)) return { path: args.path, external: true };
                if (isBundledName(dep)) return { errors: [{ text: `「${args.path}」は使えません。同梱のライブラリは ${dep} の名前のまま import してください` }] };
                return { errors: [{ text: `中で使うパッケージ「${dep}」は、Studio に入っていません` }] };
              }
              return undefined;
            });
            build.onLoad({ filter: /.*/ }, (args) => {
              if (args.namespace !== 'file') return undefined;
              const relative = path.relative(packageReal, args.path);
              if (relative.startsWith('..') || path.isAbsolute(relative)) return { errors: [{ text: 'パッケージの外のファイルは読み込めません' }] };
              return undefined;
            });
          },
        }],
      });
    } catch (error) {
      if (!Array.isArray(error.errors)) throw error;
      for (const message of error.errors.slice(0, 10)) {
        const file = message.location ? path.relative(packageReal, path.resolve(tmp, message.location.file)).split(path.sep).join('/') : '';
        errors.push(problem(file.startsWith('..') ? '' : file, `試しに組み立てられません: ${message.text}`, message.location?.line ?? null));
      }
      return { ok: false, errors, exports: [] };
    }
    const output = Object.values(result.metafile.outputs).find((item) => item.entryPoint === '<stdin>') ?? Object.values(result.metafile.outputs)[0];
    const exports = (output?.exports ?? []).filter((item) => item !== 'default').slice(0, PACKAGE_LIMITS.maxExports);
    return { ok: true, errors, exports, bytes: result.outputFiles.reduce((n, file) => n + file.contents.length, 0) };
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

// 中身をフォルダーに書く。名前は readTarball で確かめたもの(.. や絶対の場所はない)
export async function writeFiles(dir, files) {
  await fs.mkdir(dir, { recursive: true });
  for (const file of files) {
    const target = path.join(dir, ...file.path.split('/'));
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, file.data);
  }
}

// 検査だけ。何も残さない。tarball は Buffer(画面は base64 で送り、materials.js が Buffer にする)
export async function checkPackage({ tarball, answers, fileName = '' } = {}) {
  const errors = [];
  const warnings = [];
  let files = [];
  try {
    files = readTarball(tarball);
  } catch (error) {
    if (!(error instanceof PackageReadError)) throw error;
    errors.push(problem(fileName, error.message));
  }
  const manifest = files.length > 0 ? readManifestFile(files, errors) : null;
  const facts = manifest ? checkManifest(manifest, files, errors, warnings) : { name: '', version: '', installScripts: [], dependencies: [] };
  const network = [];
  for (const file of files) {
    if (!TEXT_FILE.test(file.path)) continue;
    const text = file.data.toString('utf8');
    for (const found of findSecrets(text)) errors.push(problem(file.path, `秘密らしい文字列(${found.kind})があります。消してから npm pack し直してください`, found.line));
    if (CODE_FILE.test(file.path)) network.push(...scanNetwork(file.path, text));
  }
  let trial = { ok: false, errors: [], exports: [] };
  if (errors.length === 0 && facts.name) {
    try {
      trial = await trialBuild(facts.name, files);
    } catch (error) {
      // 置けない名前など、展開の検査で拾えなかったもの。生の誤りは画面に出さない
      trial = { ok: false, errors: [problem(fileName, `試しに組み立てられません(${error?.code ?? '展開できない形'})。npm pack で作り直してください`)], exports: [] };
    }
    errors.push(...trial.errors);
  }
  const ok = errors.length === 0;
  const detected = detectedLicense(manifest, files);
  return {
    ok,
    kind: 'package',
    name: facts.name,
    version: facts.version,
    errors: errors.slice(0, 20),
    errorCount: errors.length,
    warnings: warnings.slice(0, 20),
    network: network.slice(0, PACKAGE_LIMITS.maxFindings),
    networkCount: network.length,
    installScripts: facts.installScripts,
    dependencies: facts.dependencies,
    fileCount: files.length,
    bytes: files.reduce((n, file) => n + file.data.length, 0),
    exports: trial.exports,
    license: licenseView(answers, detected),
    sha256: Buffer.isBuffer(tarball) ? sha256(tarball) : null,
    // 見本で試す: 有効にしたときに直す AI への決まりに足す文
    rule: ok ? packagesRule([{ name: facts.name, version: facts.version, exports: trial.exports, networkCount: network.length }]) : null,
    // 置くときに使う。画面には返さない(materials.js が外す)
    files: ok ? files : [],
  };
}

// 作る AI への決まりに足す文。パッケージのコードは作業フォルダーの外にあり、作る AI は読めない。名前と使い方だけを渡す
export function packagesRule(items) {
  if (!Array.isArray(items) || items.length === 0) return null;
  const lines = ['部品のパッケージ(Studio が有効にした素材):'];
  for (const item of items) {
    const names = (item.exports ?? []).slice(0, 60);
    lines.push(`- 「${item.name}」(${item.version})を import できる${names.length > 0 ? `。使える名前: ${names.join(', ')}` : ''}`);
  }
  lines.push(
    '- これらのパッケージのコードは作業フォルダーの外にあり、読めない、変えられない。作業フォルダーに写さない',
    '- ここにないパッケージは import できない(Studio が同梱するライブラリは今までどおり使える)',
  );
  if (items.some((item) => item.networkCount > 0)) lines.push('- パッケージの中の外への通信(URL、fetch など)は、試作品から届かない。それに頼る作りにしない');
  return lines.join('\n');
}
