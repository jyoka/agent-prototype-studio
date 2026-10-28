import fs from 'node:fs/promises';
import path from 'node:path';
import { MANIFEST_FILE } from './manifest.js';

export const PROJECT_ID_PATTERN = /^[a-z0-9-]{1,64}$/;

// 初回の起動で写すサンプル。dir は samples/ の下のフォルダー。
// この順が試作品の一覧の順になる(AI と話せるものを先に。ux-redesign.md 5 節)。名前は目録の title から作る
export const SAMPLES = [
  { id: 'sample-job-consult', dir: 'job-consult' },
  // 求人ではない題材で、同じ作成・試行・変更・引き継ぎの流れが通るかを確かめるサンプル(#281)
  { id: 'sample-study-consult', dir: 'study-consult' },
  // 構成 A の見本。相手の会社のエージェント(模擬)がトークを回し、こちらのツールを呼ぶ(docs/design/agent-simulation.md の 2.4)
  { id: 'sample-part-time', dir: 'part-time' },
  { id: 'sample-library', dir: 'library' },
];

const MAX_TITLE = 200;

// 一覧の名前。目録の title に、試作品の中の AI と話せるかを添える(題材の言葉は Studio に持たない)。
// title が「…(架空)」のように括弧で終わるときは、その括弧の中に足す: 「…(架空・AI と話せる)」
export function projectName(title, hasAi) {
  const note = hasAi ? 'AI と話せる' : 'AI なし';
  const match = /^(.*\S)\s*\(([^()]+)\)$/su.exec(title);
  return match ? `${match[1]}(${match[2]}・${note})` : `${title}(${note})`;
}

export function isValidProjectId(id) {
  return typeof id === 'string' && PROJECT_ID_PATTERN.test(id);
}

export function projectsDir(home) {
  return path.join(home, 'projects');
}

// app/ は作る AI が書ける唯一の場所、.studio/ はツールだけが書く場所(ADR-0001)。
export function projectPaths(home, id) {
  if (!isValidProjectId(id)) throw new Error(`プロジェクト ID の形が正しくありません: ${id}`);
  const root = path.join(projectsDir(home), id);
  return {
    root,
    app: path.join(root, 'app'),
    studio: path.join(root, '.studio'),
    builds: path.join(root, '.studio', 'builds'),
    versions: path.join(root, '.studio', 'versions'),
    working: path.join(root, '.studio', 'working.json'),
    meta: path.join(root, '.studio', 'project.json'),
  };
}

async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

// まだないサンプルだけを写し、写した ID を返す。利用者が手を入れた後は上書きしない。
export async function ensureSampleProjects(home, samplesRoot) {
  const copied = [];
  for (const sample of SAMPLES) {
    const paths = projectPaths(home, sample.id);
    if (await exists(paths.root)) continue;
    await fs.mkdir(paths.studio, { recursive: true });
    await fs.cp(path.join(samplesRoot, sample.dir, 'app'), paths.app, { recursive: true });
    // 最初のビルドが終わるまでの名前。ビルドの後は、目録から作った名前を出す(store.js)
    const title = await readManifestTitle(paths.app);
    await fs.writeFile(paths.meta, `${JSON.stringify(title ? { title } : {}, null, 2)}\n`);
    copied.push(sample.id);
  }
  return copied;
}

async function readManifestTitle(appDir) {
  try {
    const { title } = JSON.parse(await fs.readFile(path.join(appDir, MANIFEST_FILE), 'utf8'));
    if (typeof title === 'string' && title.trim()) return title.trim().slice(0, MAX_TITLE);
  } catch {
    // 目録がない、または読めないときは名前を付けない
  }
  return null;
}

async function readTitle(paths, id) {
  try {
    const meta = JSON.parse(await fs.readFile(paths.meta, 'utf8'));
    if (typeof meta.title === 'string' && meta.title.trim()) return meta.title.trim().slice(0, MAX_TITLE);
  } catch {
    // project.json がない、または壊れているときは ID を名前にする
  }
  return id;
}

export async function listProjects(home) {
  let entries;
  try {
    entries = await fs.readdir(projectsDir(home), { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const projects = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !isValidProjectId(entry.name)) continue;
    const paths = projectPaths(home, entry.name);
    // app/ がシンボリックリンクやファイルのものは扱わない
    const appStat = await fs.lstat(paths.app).catch(() => null);
    if (!appStat?.isDirectory()) continue;
    projects.push({ id: entry.name, title: await readTitle(paths, entry.name), paths });
  }
  // サンプルを SAMPLES の順で先に、ほかは ID の順で後に並べる
  const rank = (id) => {
    const i = SAMPLES.findIndex((sample) => sample.id === id);
    return i === -1 ? SAMPLES.length : i;
  };
  projects.sort((a, b) => rank(a.id) - rank(b.id) || a.id.localeCompare(b.id));
  return projects;
}
