import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { checkTokenUse, countTokenReferences, parseDesignTokens, ROLES, tokensCss, tokensGuide, TOKEN_LIMITS } from './design-tokens.js';
import { checkGuideMaterial, GUIDE_LIMITS, guidesRule, KINDS, LICENSE_ANSWERS, licenseLabel, sha256 } from './guides.js';
import { LIMITS as APP_LIMITS } from './inspect.js';
import { checkPackage, digestFiles, isPackageName, PACKAGE_LIMITS, packagesRule, writeFiles } from './packages.js';

// 自分の素材の置き場所(docs/design/user-journey.md の J4、J5)。トークン(J4)と、部品と指針(J5)。
// 置き場所は .studio/materials/。.studio/ は Studio だけが書く場所で、作る AI は読み書きできない。
// 版で戻しても素材は戻らない(目的の文書や設計と同じ扱い)。つないだ理由と出典は source.json に残し、引き継ぎに入れる。
// 部品と指針は、作る AI が読めるように app/design/ にも写す。写しが変わっていないかを関門 G3 で確かめる。
// 「これからの試作品全部」に有効にした部品と指針は、データの置き場の materials/ に置き、新しい試作品を作るときに写す

const DIR = 'materials';
const TOKENS_FILE = 'tokens.json';
const SOURCE_FILE = 'source.json';
const FORMAT = 1;
const MAX_NAME = 200;
const MAX_SOURCE = 200;
const MAX_REASON = 300;
const MAX_HISTORY = 20;
// 画面の「作る AI が使う名前」に出すトークンの数
const MAX_LISTED = 200;
const SPEC = 'W3C Design Tokens 2025.10';
const ROLE_TYPES = new Set(ROLES.map((role) => role.type));

export class MaterialError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const sha = sha256;
const materialsDir = (root) => path.join(root, '.studio', DIR);
// Studio 全体の素材(これからの試作品全部)。home はデータの置き場
const studioMaterialsDir = (home) => path.join(home, DIR);
const GUIDE_KINDS = Object.keys(KINDS);
const SCOPES = new Set(['project', 'all']);

async function readRegularFile(file) {
  const stat = await fs.lstat(file).catch(() => null);
  if (!stat) return null;
  if (!stat.isFile()) throw new Error('ふつうのファイルではありません');
  return fs.readFile(file, 'utf8');
}

async function writeAtomic(file, content) {
  const tmp = `${file}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  await fs.writeFile(tmp, content);
  await fs.rename(tmp, file);
}

async function readSource(root) {
  return readSourceIn(materialsDir(root));
}

async function readSourceIn(dir) {
  try {
    const text = await readRegularFile(path.join(dir, SOURCE_FILE));
    const parsed = text === null ? null : JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch {
    // 読めない記録は、ないものとして扱う。トークンのファイルがあれば readTokenMaterial が誤りにする
  }
  return null;
}

// locked は作る AI には直せない誤りの印。ファイルが app/ の外にあるので、直すラウンドに回さない(build-requests.js の node_fix)
const materialProblem = (text) => ({ file: `.studio/${DIR}/${TOKENS_FILE}`, line: null, column: null, lineText: null, text, locked: true });

// プロジェクトのつないだトークンを読む。つないでいなければ null。
// 関門 G3 で確かめるので、記録の指紋と中身が違う、形が壊れている、というときは problems に入れて返す
export async function readTokenMaterial(root) {
  let text;
  try {
    text = await readRegularFile(path.join(materialsDir(root), TOKENS_FILE));
  } catch {
    return { problems: [materialProblem('つないだトークンのファイルが、ふつうのファイルではありません。その他の「自分のトークン」から外して、つなぎ直してください')] };
  }
  const source = await readSource(root);
  const record = source?.tokens;
  if (text === null) {
    if (!record) return null;
    return { problems: [materialProblem('つないだトークンのファイルがなくなっています。その他の「自分のトークン」から外して、つなぎ直してください')] };
  }
  if (!record || record.sha256 !== sha(text)) {
    return { problems: [materialProblem('つないだトークンのファイルが、つないだときから変わっています。素材は Studio の外から変えられません。その他の「自分のトークン」から外して、つなぎ直してください')] };
  }
  const parsed = parseDesignTokens(text);
  if (!parsed.ok) {
    return { problems: parsed.errors.map((error) => materialProblem(`つないだトークンの形に誤りがあります。${error.text}`)) };
  }
  const roles = record.roles ?? {};
  return {
    problems: [],
    text,
    source,
    record,
    tokens: parsed.tokens,
    roles,
    css: tokensCss(parsed.tokens, roles),
    guide: tokensGuide(parsed.tokens, roles),
  };
}

// 素材を最後に変えた時刻。これより前の確かめは、今の見た目を確かめていない(evidence.js)
export async function materialChangedAt(root) {
  const source = await readSource(root);
  const at = source?.changedAt;
  return typeof at === 'string' ? at : null;
}

// 部品と指針の元の置き場所(.studio/materials/<kind>/<name>)と、写しの場所(app/<copy>)
const originalPath = (dir, kind, name) => path.join(dir, kind, name);
const copyPath = (appDir, copy) => path.join(appDir, ...copy.split('/'));
const guideProblem = (file, text) => ({ file, line: null, column: null, lineText: null, text, locked: true });
const RESTORE_WORDS = 'その他の「部品と指針をつなぐ」で、写しを戻すか外してください';

// app/ の中のフォルダーを、シンボリックリンクをたどらずに用意する。途中がリンクかファイルなら消して作り直す(app/ の外に書かない)
async function ensureAppDir(appDir, relDir) {
  let current = appDir;
  for (const part of relDir.split('/').filter(Boolean)) {
    current = path.join(current, part);
    const stat = await fs.lstat(current).catch(() => null);
    if (stat?.isDirectory()) continue;
    if (stat) await fs.rm(current, { force: true });
    await fs.mkdir(current);
  }
  return current;
}

// 途中のフォルダーの場所に、フォルダーでないもの(ファイル、リンク)があれば、その場所を返す
async function blockingParent(appDir, copy) {
  let current = appDir;
  const parts = path.posix.dirname(copy).split('/').filter(Boolean);
  for (let i = 0; i < parts.length; i += 1) {
    current = path.join(current, parts[i]);
    const stat = await fs.lstat(current).catch(() => null);
    if (!stat) return null;
    if (!stat.isDirectory()) return parts.slice(0, i + 1).join('/');
  }
  return null;
}

// 試作品のフォルダーのファイルの数と大きさ(inspect.js と同じ数え方。リンクは数えない)
async function appSize(appDir) {
  let files = 0;
  let bytes = 0;
  async function walk(dir) {
    for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) {
        files += 1;
        bytes += (await fs.lstat(full)).size;
      }
    }
  }
  await walk(appDir);
  return { files, bytes };
}

async function copiesBytes(appDir, files) {
  let total = 0;
  for (const file of files) {
    const stat = await fs.lstat(copyPath(appDir, file.copy)).catch(() => null);
    if (stat?.isFile()) total += stat.size;
  }
  return total;
}

// 写しを書く。rename で置くので、写しの場所がリンクでも、たどらずに置き換わる
async function writeCopy(appDir, copy, text) {
  const dir = await ensureAppDir(appDir, path.posix.dirname(copy));
  await writeAtomic(path.join(dir, path.posix.basename(copy)), text);
}

// 写しを消す。途中がリンクのときは消さない(app/ の外を消さない)
async function removeCopy(appDir, copy) {
  let current = appDir;
  for (const part of path.posix.dirname(copy).split('/').filter(Boolean)) {
    current = path.join(current, part);
    const stat = await fs.lstat(current).catch(() => null);
    if (!stat?.isDirectory()) return;
  }
  await fs.rm(path.join(current, path.posix.basename(copy)), { force: true, recursive: true });
}

function guideRecords(source) {
  return GUIDE_KINDS.map((kind) => source?.[kind]).filter((record) => record && Array.isArray(record.files));
}

// 有効にした部品と指針を読む。有効にしていなければ null。
// 関門 G3 で確かめるので、元が記録の指紋と違う、写しが元と違う、というときは problems に入れて返す。
// 写しは app/ にあるが、作る AI は元を読めないので直せない(locked)。人が「写しを戻す」で戻す
export async function readGuideMaterial(root) {
  const source = await readSource(root);
  const records = guideRecords(source);
  if (records.length === 0) return null;
  const problems = [];
  const dir = materialsDir(root);
  for (const record of records) {
    for (const file of record.files) {
      const original = await readRegularFile(originalPath(dir, record.kind, file.name)).catch(() => undefined);
      if (original === undefined || original === null || sha(original) !== file.sha256) {
        problems.push(guideProblem(`.studio/${DIR}/${record.kind}/${file.name}`, `有効にした${KINDS[record.kind].label}の元のファイルが、有効にしたときから変わっているか、なくなっています。素材は Studio の外から変えられません。その他の「部品と指針をつなぐ」で外して、有効にし直してください`));
        continue;
      }
      const copy = await readRegularFile(copyPath(path.join(root, 'app'), file.copy)).catch(() => undefined);
      if (copy === null || copy === undefined) problems.push(guideProblem(`app/${file.copy}`, `${KINDS[record.kind].label}の写し(試作品のフォルダーの ${file.copy})がなくなっています。${RESTORE_WORDS}`));
      else if (sha(copy) !== file.sha256) problems.push(guideProblem(`app/${file.copy}`, `${KINDS[record.kind].label}の写し(試作品のフォルダーの ${file.copy})が、有効にしたときから変わっています。写しは Studio だけが書きます。${RESTORE_WORDS}`));
    }
  }
  return { records, problems, source, rule: guidesRule(records) };
}

// 部品のパッケージ(J5 の後半)の置き場所。.studio/materials/packages/node_modules/<名前>/ に展開した中身、
// tarballs/<指紋>.tgz に受け取ったファイルを置く。作る AI は読めない(app/ の外)。ビルドが import をここから解く
const packagesDir = (root) => path.join(materialsDir(root), 'packages');
const packageDir = (root, name) => path.join(packagesDir(root), 'node_modules', ...name.split('/'));
const tarballPath = (root, sha256Hex) => path.join(packagesDir(root), 'tarballs', `${sha256Hex}.tgz`);
// 引き継ぎが受け取ったファイルを写すときに使う
export const packageTarballPath = tarballPath;

function packageRecords(source) {
  return Array.isArray(source?.packages) ? source.packages.filter((record) => record && isPackageName(record.name) && typeof record.digest === 'string') : [];
}

// フォルダーの中のファイルを読む。リンクやふつうでないファイルがあれば null(Studio はリンクを置かない)
async function readPackageTree(dir) {
  const files = [];
  async function walk(current, prefix) {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(full, rel);
      else if (entry.isFile()) files.push({ path: rel, data: await fs.readFile(full) });
      else throw new Error('ふつうのファイルではありません');
    }
  }
  const stat = await fs.lstat(dir).catch(() => null);
  if (!stat?.isDirectory()) return null;
  try {
    await walk(dir, '');
  } catch {
    return null;
  }
  return files;
}

// 有効にした部品のパッケージを読む。有効にしていなければ null。
// 関門 G3 で確かめるので、中身が記録の指紋と違う、なくなった、というときは problems に入れて返す(作る AI には直せない。locked)
export async function readPackageMaterial(root) {
  const source = await readSource(root);
  const records = packageRecords(source);
  if (records.length === 0) return null;
  const problems = [];
  for (const record of records) {
    const files = await readPackageTree(packageDir(root, record.name));
    // 受け取ったファイルは引き継ぎに写すので、なくなっていないかも確かめる
    const tarball = typeof record.sha256 === 'string' && /^[0-9a-f]{64}$/.test(record.sha256) ? await fs.readFile(tarballPath(root, record.sha256)).catch(() => null) : null;
    if (!files || digestFiles(files) !== record.digest || !tarball || sha(tarball) !== record.sha256) {
      problems.push(guideProblem(`.studio/${DIR}/packages/node_modules/${record.name}`, `有効にした部品のパッケージ「${record.name}」の中身が、有効にしたときから変わっているか、なくなっています。素材は Studio の外から変えられません。その他の「部品と指針をつなぐ」で外して、有効にし直してください`));
    }
  }
  return { items: records, problems, source, root: packagesDir(root), modulesDir: path.join(packagesDir(root), 'node_modules'), rule: packagesRule(records) };
}

// 外した写し、置き換えた写しの場所と指紋。版で戻すと、版の中から戻ってくることがある
const MAX_RETIRED = 200;
function retiredWith(source, files) {
  const current = Array.isArray(source?.retired) ? source.retired : [];
  const added = files.map((file) => ({ copy: file.copy, sha256: file.sha256 }));
  const seen = new Set();
  return [...added, ...current].filter((file) => {
    const key = `${file.copy}:${file.sha256}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, MAX_RETIRED);
}

// 写しを元から書き直す。元が壊れていれば書かない(problems を返す)。
// pruneRetired を付けると、前に外した写しのうち、中身がそのときのままのものを消す(版で戻したとき。今は有効でない素材を残さない)
export async function restoreGuideCopies(root, { pruneRetired = false } = {}) {
  const source = await readSource(root);
  const dir = materialsDir(root);
  const problems = [];
  let restored = 0;
  if (pruneRetired) {
    const live = new Set(guideRecords(source).flatMap((record) => record.files.map((file) => file.copy)));
    for (const file of Array.isArray(source?.retired) ? source.retired : []) {
      if (typeof file?.copy !== 'string' || live.has(file.copy) || !file.copy.startsWith('design/')) continue;
      const text = await readRegularFile(copyPath(path.join(root, 'app'), file.copy)).catch(() => null);
      if (text !== null && sha(text) === file.sha256) await removeCopy(path.join(root, 'app'), file.copy);
    }
  }
  for (const record of guideRecords(source)) {
    for (const file of record.files) {
      const original = await readRegularFile(originalPath(dir, record.kind, file.name)).catch(() => null);
      if (original === null || sha(original) !== file.sha256) {
        problems.push(`${KINDS[record.kind].label}の元のファイル(${file.name})が変わっているので、写しを戻せません。外して、有効にし直してください`);
        continue;
      }
      const current = await readRegularFile(copyPath(path.join(root, 'app'), file.copy)).catch(() => undefined);
      if (current !== null && current !== undefined && sha(current) === file.sha256) continue;
      // フォルダーに置き換わっていたら、消してから書く
      if (current === undefined) await removeCopy(path.join(root, 'app'), file.copy);
      await writeCopy(path.join(root, 'app'), file.copy, original);
      restored += 1;
    }
  }
  return { restored, problems };
}

// 作る AI に足す決まりの文。トークン(J4)と、部品と指針と、部品のパッケージ(J5)。どれもなければ null
export async function materialRule(root) {
  const tokens = await readTokenMaterial(root);
  const guides = await readGuideMaterial(root);
  const packages = await readPackageMaterial(root);
  const parts = [tokens?.guide, guides?.rule, packages?.rule].filter(Boolean);
  return parts.length > 0 ? parts.join('\n') : null;
}

// 新しい試作品に、Studio 全体の部品と指針(これからの試作品全部)を写す。intent.js の createStarterProject から呼ぶ
export async function applyStudioMaterials(home, root) {
  const studioDir = studioMaterialsDir(home);
  const studioSource = await readSourceIn(studioDir);
  const records = guideRecords(studioSource);
  if (records.length === 0) return 0;
  const dir = materialsDir(root);
  const previous = await readSource(root);
  const now = new Date().toISOString();
  const fields = { changedAt: now };
  const entries = [];
  for (const record of records) {
    const files = [];
    for (const file of record.files) {
      const text = await readRegularFile(originalPath(studioDir, record.kind, file.name)).catch(() => null);
      if (text === null || sha(text) !== file.sha256) continue;
      files.push({ ...file, text });
    }
    if (files.length !== record.files.length) continue;
    await fs.mkdir(path.join(dir, record.kind), { recursive: true });
    for (const file of files) {
      await writeAtomic(originalPath(dir, record.kind, file.name), file.text);
      await writeCopy(path.join(root, 'app'), file.copy, file.text);
    }
    fields[record.kind] = { ...record, enabledAt: now, from: 'studio' };
    entries.push({ action: 'enable', kind: record.kind, at: now, source: record.source, reason: record.reason, scope: 'all', from: 'studio' });
  }
  if (entries.length === 0) return 0;
  await writeSourceIn(dir, previous, fields, entries);
  return entries.length;
}

async function writeSourceIn(dir, previous, fields, entries) {
  await fs.mkdir(dir, { recursive: true });
  const { history: oldHistory, formatVersion: _format, ...kept } = previous ?? {};
  const history = [...(Array.isArray(oldHistory) ? oldHistory : []), ...entries].slice(-MAX_HISTORY);
  await writeAtomic(path.join(dir, SOURCE_FILE), `${JSON.stringify({ formatVersion: FORMAT, ...kept, ...fields, history }, null, 2)}\n`);
}

function guideRecordView(record) {
  if (!record) return null;
  return {
    kind: record.kind,
    label: KINDS[record.kind].label,
    source: record.source,
    license: record.license,
    licenseLabel: licenseLabel(record),
    reason: record.reason,
    scope: record.scope,
    from: record.from ?? 'project',
    enabledAt: record.enabledAt,
    files: record.files.map((file) => ({ name: file.name, copy: file.copy, title: file.title })),
    componentCount: record.componentCount ?? 0,
    urlCount: record.urlCount ?? 0,
  };
}

function packageRecordView(record) {
  return {
    name: record.name,
    version: record.version,
    source: record.source,
    license: record.license,
    licenseLabel: licenseLabel(record),
    reason: record.reason,
    enabledAt: record.enabledAt,
    fileCount: record.fileCount ?? 0,
    exports: (record.exports ?? []).slice(0, 60),
    networkCount: record.networkCount ?? 0,
  };
}

// 検査の結果のうち、画面に返すもの(展開した中身は返さない)
function packageCheckView(check) {
  const { files: _files, ...view } = check;
  return view;
}

function decodeTarball(value) {
  if (typeof value !== 'string' || value.length === 0) throw new MaterialError(400, 'invalid', 'npm pack で作ったファイル(.tgz)を選んでください');
  if (value.length > Math.ceil((PACKAGE_LIMITS.maxTarballBytes * 4) / 3) + 4) throw new MaterialError(413, 'too-large', `ファイルが大きすぎます(上限 ${PACKAGE_LIMITS.maxTarballBytes / 1024 / 1024} MB)`);
  return Buffer.from(value, 'base64');
}

function cleanText(value, max) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

const checkView = (parsed) => ({
  ok: parsed.ok,
  errors: parsed.errors,
  errorCount: parsed.errorCount,
  warnings: parsed.warnings,
  count: parsed.tokens.length,
  // 役割に選べるトークンは全部出す。切ると、見立てた役割が画面で選べずに外れる
  candidates: parsed.tokens.filter((token) => ROLE_TYPES.has(token.type)).map(({ path: tokenPath, type }) => ({ path: tokenPath, type })),
  roles: parsed.roles,
});

function tokenView(token) {
  return { path: token.path, type: token.type, variables: token.variables };
}

function missingRoles(roles) {
  return ROLES.filter((role) => !roles?.[role.id]).map((role) => role.label);
}

export class ProjectMaterials {
  constructor({ store, log = () => {} }) {
    this.store = store;
    this.log = log;
  }

  roleList() {
    return ROLES.map(({ id, label, type }) => ({ id, label, type }));
  }

  async view(id) {
    const paths = await this.store.requireProject(id);
    const material = await readTokenMaterial(paths.root);
    const source = await readSource(paths.root);
    const history = Array.isArray(source?.history) ? source.history.slice(-5) : [];
    const base = { roles: this.roleList(), limitBytes: TOKEN_LIMITS.maxBytes, history, guides: await this.guidesView(paths.root, source), packages: await this.packagesView(paths.root) };
    if (!material) return { ...base, connected: null, problems: [] };
    if (material.problems.length > 0) return { ...base, connected: null, problems: material.problems.map((p) => p.text) };
    const { record } = material;
    return {
      ...base,
      problems: [],
      connected: {
        fileName: record.fileName,
        source: record.source,
        reason: record.reason,
        connectedAt: record.connectedAt,
        count: material.tokens.length,
        roles: record.roles,
        missingRoles: missingRoles(record.roles),
        tokens: material.tokens.slice(0, MAX_LISTED).map(tokenView),
      },
    };
  }

  // 部品と指針の画面の中身。この試作品のものと、これからの試作品全部のもの
  async guidesView(root, source) {
    const material = await readGuideMaterial(root);
    const studio = await readSourceIn(studioMaterialsDir(this.store.home));
    return {
      kinds: Object.fromEntries(GUIDE_KINDS.map((kind) => [kind, guideRecordView(source?.[kind])])),
      studioWide: Object.fromEntries(GUIDE_KINDS.map((kind) => [kind, guideRecordView(studio?.[kind])])),
      problems: material?.problems.map((p) => p.text) ?? [],
      licenseAnswers: LICENSE_ANSWERS,
      limits: { maxFiles: GUIDE_LIMITS.maxFiles, maxFileBytes: GUIDE_LIMITS.maxFileBytes, maxTotalBytes: GUIDE_LIMITS.maxTotalBytes, maxIndexBytes: GUIDE_LIMITS.maxIndexBytes },
    };
  }

  // 部品のパッケージの画面の中身(J5 の後半)。この試作品で有効にしたものだけ
  async packagesView(root) {
    const material = await readPackageMaterial(root);
    return {
      items: (material?.items ?? []).map(packageRecordView),
      problems: material?.problems.map((p) => p.text) ?? [],
      limits: { maxTarballBytes: PACKAGE_LIMITS.maxTarballBytes, maxPackages: PACKAGE_LIMITS.maxPackages },
    };
  }

  // 部品のパッケージの検査だけ。何も残さない(案内の「2. 確かめる」と「3. 見本で試す」)
  async checkPackage(id, { tarball, fileName, answers } = {}) {
    await this.store.requireProject(id);
    return { check: packageCheckView(await checkPackage({ tarball: decodeTarball(tarball), fileName: cleanText(fileName, MAX_NAME), answers })) };
  }

  // 部品のパッケージを、この試作品だけに有効にする(案内の「4. 有効にする」)。検査をもう一度行い、ライセンスが分からなければ断る。
  // パッケージのスクリプトもコードも動かさない。中身は .studio/ に置くので、作る AI は読めない
  async enablePackage(id, { tarball, fileName, answers, source, reason, scope = 'project' } = {}) {
    const paths = await this.store.requireProject(id);
    if (scope !== 'project') throw new MaterialError(400, 'invalid', '部品のパッケージは、今はこの試作品だけに有効にできます');
    const buffer = decodeTarball(tarball);
    const check = await checkPackage({ tarball: buffer, fileName: cleanText(fileName, MAX_NAME), answers });
    if (!check.ok) return { enabled: false, check: packageCheckView(check), materials: await this.view(id) };
    if (!check.license.ok) throw new MaterialError(409, 'license-unknown', check.license.reason);
    const owner = cleanText(source, MAX_SOURCE);
    if (!owner) throw new MaterialError(400, 'invalid', '誰の素材かを書いてください。引き継ぎの出典になります');
    this.store.claimVersions(id);
    try {
      const previous = await readSource(paths.root);
      const others = packageRecords(previous).filter((record) => record.name !== check.name);
      if (others.length >= PACKAGE_LIMITS.maxPackages) throw new MaterialError(409, 'too-many', `部品のパッケージは、1 つの試作品に ${PACKAGE_LIMITS.maxPackages} 個までです。使わないものを外してください`);
      const before = packageRecords(previous).find((record) => record.name === check.name);
      const now = new Date().toISOString();
      const record = {
        kind: 'package',
        name: check.name,
        version: check.version,
        source: owner,
        license: check.license.license,
        licenseName: check.license.licenseName,
        detectedLicense: check.license.detected,
        reason: cleanText(reason, MAX_REASON),
        scope: 'project',
        enabledAt: now,
        fileName: cleanText(fileName, MAX_NAME),
        sha256: check.sha256,
        digest: digestFiles(check.files),
        fileCount: check.fileCount,
        bytes: check.bytes,
        exports: check.exports,
        networkCount: check.networkCount,
      };
      // 中身と元のファイルを置いてから、記録を書く(途中で止まっても、関門が気づいて止める)
      await fs.rm(packageDir(paths.root, check.name), { recursive: true, force: true });
      await writeFiles(packageDir(paths.root, check.name), check.files);
      await fs.mkdir(path.dirname(tarballPath(paths.root, check.sha256)), { recursive: true });
      await writeAtomic(tarballPath(paths.root, check.sha256), buffer);
      if (before?.sha256 && before.sha256 !== check.sha256) await fs.rm(tarballPath(paths.root, before.sha256), { force: true });
      const entry = { action: 'enable', kind: 'package', name: record.name, version: record.version, at: now, source: record.source, reason: record.reason, scope: 'project', license: licenseLabel(record), sha256: record.sha256 };
      await writeSourceIn(materialsDir(paths.root), previous, { packages: [...others, record], changedAt: now }, [entry]);
      this.log(`部品のパッケージを有効にしました: ${id}(${record.name} ${record.version})`);
      const build = await this.store.build(id, { byVersions: true });
      return { enabled: true, check: packageCheckView(check), build: buildView(build), materials: await this.view(id) };
    } finally {
      this.store.releaseVersions(id);
    }
  }

  // 部品のパッケージを外す。試作品がまだ import していれば、ビルドが止まる(画面で知らせる)
  async disablePackage(id, { name, reason } = {}) {
    const paths = await this.store.requireProject(id);
    if (!isPackageName(name)) throw new MaterialError(400, 'invalid', '外す部品のパッケージを選んでください');
    this.store.claimVersions(id);
    try {
      const previous = await readSource(paths.root);
      const record = packageRecords(previous).find((item) => item.name === name);
      if (!record) throw new MaterialError(404, 'not-found', `部品のパッケージ「${name}」は有効になっていません`);
      const now = new Date().toISOString();
      await fs.rm(packageDir(paths.root, name), { recursive: true, force: true });
      // @scope/ のフォルダーが空になったら消す
      if (name.startsWith('@')) await fs.rmdir(path.dirname(packageDir(paths.root, name))).catch(() => {});
      if (record.sha256) await fs.rm(tarballPath(paths.root, record.sha256), { force: true });
      const rest = packageRecords(previous).filter((item) => item.name !== name);
      await writeSourceIn(materialsDir(paths.root), previous, { packages: rest.length > 0 ? rest : null, changedAt: now }, [{ action: 'disable', kind: 'package', name, version: record.version, at: now, source: record.source, reason: cleanText(reason, MAX_REASON), scope: 'project' }]);
      this.log(`部品のパッケージを外しました: ${id}(${name})`);
      const build = await this.store.build(id, { byVersions: true });
      return { build: buildView(build), materials: await this.view(id) };
    } finally {
      this.store.releaseVersions(id);
    }
  }

  // 作る AI に足す決まりの文。トークンと、部品と指針と、部品のパッケージ。どれもなければ null
  async guide(id) {
    const paths = await this.store.requireProject(id);
    return materialRule(paths.root);
  }

  // 部品と指針の検査だけ。何も書かない(案内の「2. 確かめる」)
  async checkGuides(id, { kind, files, answers } = {}) {
    await this.store.requireProject(id);
    return { check: checkGuideMaterial({ kind, files, answers }) };
  }

  // 部品と指針を有効にする(案内の「4. 有効にする」)。検査をもう一度行い、ライセンスが分からなければ断る
  async enableGuides(id, { kind, files, answers, source, reason, scope = 'project' } = {}) {
    const paths = await this.store.requireProject(id);
    const check = checkGuideMaterial({ kind, files, answers });
    if (!check.ok) return { enabled: false, check, materials: await this.view(id) };
    if (!check.license.ok) throw new MaterialError(409, 'license-unknown', check.license.reason);
    const owner = cleanText(source, MAX_SOURCE);
    if (!owner) throw new MaterialError(400, 'invalid', '誰の素材かを書いてください。引き継ぎの出典になります');
    if (!SCOPES.has(scope)) throw new MaterialError(400, 'invalid', '有効にする範囲は、この試作品だけか、これからの試作品全部です');
    this.store.claimVersions(id);
    try {
      const previous = await readSource(paths.root);
      const before = previous?.[kind];
      const ownCopies = new Set((before?.files ?? []).map((file) => file.copy));
      // 人が置いたファイルを上書きしない。前に Studio が写したものだけを置き換える。
      // 途中のフォルダー(design/ など)がファイルのときも、消さずに断る
      const clashes = [];
      for (const copy of check.copies) {
        const rel = copy.path;
        const parent = await blockingParent(paths.app, rel);
        if (parent) {
          clashes.push(parent);
          continue;
        }
        if (ownCopies.has(rel) || !(await fs.lstat(copyPath(paths.app, rel)).catch(() => null))) continue;
        // 前に外した写しが版から戻ったときなど、中身が同じなら置き換えてよい
        const same = await readRegularFile(copyPath(paths.app, rel)).then((text) => text === copy.text, () => false);
        if (!same) clashes.push(rel);
      }
      if (clashes.length > 0) {
        throw new MaterialError(409, 'clash', `写す場所に、ほかのファイルがあります: ${[...new Set(clashes)].slice(0, 5).join('、')}。名前を変えるか、そのファイルを動かしてから、もう一度有効にしてください`);
      }
      // 写しを足すと試作品のフォルダーの上限を超えるなら、書く前に断る(超えるとビルドが止まり、作る AI にも直せない)
      const size = await appSize(paths.app);
      const oldBytes = await copiesBytes(paths.app, before?.files ?? []);
      const newBytes = check.copies.reduce((n, copy) => n + Buffer.byteLength(copy.text, 'utf8'), 0);
      const files = size.files - (before?.files.length ?? 0) + check.copies.length;
      if (size.bytes - oldBytes + newBytes > APP_LIMITS.maxTotalBytes || files > APP_LIMITS.maxFiles) {
        throw new MaterialError(409, 'too-large', `写しを足すと、試作品のフォルダーが上限(${APP_LIMITS.maxTotalBytes / 1024 / 1024} MB、${APP_LIMITS.maxFiles} 個)を超えます。素材を小さくしてください`);
      }
      const now = new Date().toISOString();
      const record = {
        kind,
        source: owner,
        license: check.license.license,
        licenseName: check.license.licenseName,
        reason: cleanText(reason, MAX_REASON),
        scope,
        enabledAt: now,
        files: check.copies.map((copy) => ({ name: copy.name, copy: copy.path, title: copy.title, from: cleanText(copy.from, MAX_NAME), sha256: sha(copy.text) })),
        componentCount: check.components.length,
        urlCount: check.urlCount,
      };
      const dir = materialsDir(paths.root);
      // 前の写しと元を消してから書く。記録は最後に書く(途中で止まっても、関門が気づいて止める)
      for (const file of before?.files ?? []) await removeCopy(paths.app, file.copy);
      await fs.rm(path.join(dir, kind), { recursive: true, force: true });
      await fs.mkdir(path.join(dir, kind), { recursive: true });
      for (const copy of check.copies) {
        await writeAtomic(originalPath(dir, kind, copy.name), copy.text);
        await writeCopy(paths.app, copy.path, copy.text);
      }
      const entry = { action: 'enable', kind, at: now, source: record.source, reason: record.reason, scope, license: licenseLabel(record) };
      await writeSourceIn(dir, previous, { [kind]: record, changedAt: now, retired: retiredWith(previous, (before?.files ?? []).filter((file) => !record.files.some((next) => next.copy === file.copy && next.sha256 === file.sha256))) }, [entry]);
      if (scope === 'all') await this.writeStudioWide(kind, record, check.copies, entry);
      this.log(`${KINDS[kind].label}を有効にしました: ${id}(${record.files.length} 個${scope === 'all' ? '。これからの試作品全部' : ''})`);
      const build = await this.store.build(id, { byVersions: true });
      return { enabled: true, check, build: buildView(build), materials: await this.view(id) };
    } finally {
      this.store.releaseVersions(id);
    }
  }

  async writeStudioWide(kind, record, copies, entry) {
    const dir = studioMaterialsDir(this.store.home);
    const previous = await readSourceIn(dir);
    await fs.rm(path.join(dir, kind), { recursive: true, force: true });
    await fs.mkdir(path.join(dir, kind), { recursive: true });
    for (const copy of copies) await writeAtomic(originalPath(dir, kind, copy.name), copy.text);
    await writeSourceIn(dir, previous, { [kind]: record, changedAt: record.enabledAt }, [entry]);
  }

  // 外す。from が studio なら、これからの試作品全部の分だけを外す(今ある試作品の写しはそのまま)
  async disableGuides(id, { kind, from = 'project', reason } = {}) {
    const paths = await this.store.requireProject(id);
    if (!Object.hasOwn(KINDS, kind)) throw new MaterialError(400, 'invalid', '外す素材を選んでください');
    const now = new Date().toISOString();
    const entry = { action: 'disable', kind, at: now, reason: cleanText(reason, MAX_REASON), scope: from === 'studio' ? 'all' : 'project' };
    if (from === 'studio') {
      const dir = studioMaterialsDir(this.store.home);
      const previous = await readSourceIn(dir);
      await fs.rm(path.join(dir, kind), { recursive: true, force: true });
      await writeSourceIn(dir, previous, { [kind]: null, changedAt: now }, [{ ...entry, source: previous?.[kind]?.source ?? null }]);
      this.log(`これからの試作品全部の${KINDS[kind].label}を外しました`);
      return { materials: await this.view(id) };
    }
    this.store.claimVersions(id);
    try {
      const previous = await readSource(paths.root);
      const dir = materialsDir(paths.root);
      for (const file of previous?.[kind]?.files ?? []) await removeCopy(paths.app, file.copy);
      await fs.rm(path.join(dir, kind), { recursive: true, force: true });
      await writeSourceIn(dir, previous, { [kind]: null, changedAt: now, retired: retiredWith(previous, previous?.[kind]?.files ?? []) }, [{ ...entry, source: previous?.[kind]?.source ?? null }]);
      this.log(`${KINDS[kind].label}を外しました: ${id}`);
      const build = await this.store.build(id, { byVersions: true });
      return { build: buildView(build), materials: await this.view(id) };
    } finally {
      this.store.releaseVersions(id);
    }
  }

  // 写しを元から書き直す(作る AI が写しを変えたとき)
  async restoreGuides(id) {
    const paths = await this.store.requireProject(id);
    this.store.claimVersions(id);
    try {
      const { restored, problems } = await restoreGuideCopies(paths.root);
      if (problems.length > 0) throw new MaterialError(409, 'broken', problems[0]);
      this.log(`部品と指針の写しを戻しました: ${id}(${restored} 個)`);
      const build = await this.store.build(id, { byVersions: true });
      return { restored, build: buildView(build), materials: await this.view(id) };
    } finally {
      this.store.releaseVersions(id);
    }
  }

  // 検査だけ。何も書かない
  async check(id, { text } = {}) {
    await this.store.requireProject(id);
    return { check: checkView(parseDesignTokens(text)) };
  }

  // 役割は人が選ぶ。送らなければ見立てのまま。種類の違うトークンは当てない
  chosenRoles(parsed, roles) {
    const result = {};
    for (const role of ROLES) {
      const wanted = roles && Object.hasOwn(roles, role.id) ? roles[role.id] : parsed.roles[role.id];
      const token = parsed.tokens.find((t) => t.path === wanted && t.type === role.type);
      result[role.id] = token?.path ?? null;
    }
    return result;
  }

  // つなぐ。形の誤りと、今の試作品と合わないところがあれば、書かずに返す(connected: false)
  async connect(id, { text, fileName, roles, source, reason } = {}) {
    const paths = await this.store.requireProject(id);
    const parsed = parseDesignTokens(text);
    if (!parsed.ok) return { connected: false, check: checkView(parsed), materials: await this.view(id) };
    const owner = cleanText(source, MAX_SOURCE);
    if (!owner) throw new MaterialError(400, 'invalid', '誰の素材かを書いてください。引き継ぎの出典になります');
    const chosen = this.chosenRoles(parsed, roles);
    this.store.claimVersions(id);
    try {
      const conflicts = await checkTokenUse(paths.app, parsed.tokens, chosen);
      if (conflicts.length > 0) {
        return { connected: false, check: checkView(parsed), conflicts: conflicts.slice(0, 20).map((c) => `${c.file}${c.line ? ` ${c.line} 行目` : ''}: ${c.text}`), materials: await this.view(id) };
      }
      const now = new Date().toISOString();
      const previous = await readSource(paths.root);
      const record = {
        kind: 'design-tokens',
        spec: SPEC,
        fileName: cleanText(fileName, MAX_NAME) || TOKENS_FILE,
        source: owner,
        reason: cleanText(reason, MAX_REASON),
        connectedAt: now,
        sha256: sha(text),
        count: parsed.tokens.length,
        roles: chosen,
      };
      await this.writeRecord(paths.root, previous, { tokens: record, changedAt: now }, { action: 'connect', at: now, fileName: record.fileName, source: record.source, reason: record.reason, sha256: record.sha256 }, text);
      this.log(`トークンをつなぎました: ${id}(${record.count} 個)`);
      const build = await this.store.build(id, { byVersions: true });
      return { connected: true, build: buildView(build), materials: await this.view(id) };
    } finally {
      this.store.releaseVersions(id);
    }
  }

  async disconnect(id, { reason } = {}) {
    const paths = await this.store.requireProject(id);
    this.store.claimVersions(id);
    try {
      const previous = await readSource(paths.root);
      const now = new Date().toISOString();
      await this.writeRecord(paths.root, previous, { tokens: null, changedAt: now }, { action: 'disconnect', at: now, fileName: previous?.tokens?.fileName ?? null, source: previous?.tokens?.source ?? null, reason: cleanText(reason, MAX_REASON), sha256: previous?.tokens?.sha256 ?? null }, null);
      this.log(`トークンを外しました: ${id}`);
      const build = await this.store.build(id, { byVersions: true });
      return { build: buildView(build), references: await countTokenReferences(paths.app), materials: await this.view(id) };
    } finally {
      this.store.releaseVersions(id);
    }
  }

  // 記録を先に書かない。トークンのファイルと記録がずれた瞬間に止まっても、関門が気づいて止める
  // 部品と指針の記録(J5)は残す
  async writeRecord(root, previous, fields, entry, tokensText) {
    const dir = materialsDir(root);
    await fs.mkdir(dir, { recursive: true });
    if (tokensText === null) await fs.rm(path.join(dir, TOKENS_FILE), { force: true });
    else await writeAtomic(path.join(dir, TOKENS_FILE), tokensText);
    await writeSourceIn(dir, previous, fields, [{ kind: 'tokens', ...entry }]);
  }
}

function buildView(build) {
  return { ok: build.ok, errorCount: build.errors?.length ?? 0, firstError: build.errors?.[0]?.text ?? null };
}
