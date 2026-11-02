import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { checkTokenUse, countTokenReferences, parseDesignTokens, ROLES, tokensCss, tokensGuide, TOKEN_LIMITS } from './design-tokens.js';

// 自分の素材の置き場所(docs/design/user-journey.md の J4)。今はトークンだけ。
// 置き場所は .studio/materials/。.studio/ は Studio だけが書く場所で、作る AI は読み書きできない。
// 版で戻しても素材は戻らない(目的の文書や設計と同じ扱い)。つないだ理由と出典は source.json に残し、引き継ぎに入れる

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

const sha = (text) => crypto.createHash('sha256').update(text).digest('hex');
const materialsDir = (root) => path.join(root, '.studio', DIR);

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
  try {
    const text = await readRegularFile(path.join(materialsDir(root), SOURCE_FILE));
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
    const base = { roles: this.roleList(), limitBytes: TOKEN_LIMITS.maxBytes, history };
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

  // 作る AI に足す決まりの文。つないでいなければ null
  async guide(id) {
    const paths = await this.store.requireProject(id);
    return (await readTokenMaterial(paths.root))?.guide ?? null;
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
  async writeRecord(root, previous, fields, entry, tokensText) {
    const dir = materialsDir(root);
    await fs.mkdir(dir, { recursive: true });
    const history = [...(Array.isArray(previous?.history) ? previous.history : []), entry].slice(-MAX_HISTORY);
    const source = { formatVersion: FORMAT, ...fields, history };
    if (tokensText === null) await fs.rm(path.join(dir, TOKENS_FILE), { force: true });
    else await writeAtomic(path.join(dir, TOKENS_FILE), tokensText);
    await writeAtomic(path.join(dir, SOURCE_FILE), `${JSON.stringify(source, null, 2)}\n`);
  }
}

function buildView(build) {
  return { ok: build.ok, errorCount: build.errors?.length ?? 0, firstError: build.errors?.[0]?.text ?? null };
}
