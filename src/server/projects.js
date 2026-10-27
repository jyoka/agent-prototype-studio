import fs from 'node:fs/promises';
import path from 'node:path';

export const PROJECT_ID_PATTERN = /^[a-z0-9-]{1,64}$/;

// 初回の起動で写すサンプル。dir は samples/ の下のフォルダー
export const SAMPLES = [
  { id: 'sample-library', dir: 'library', title: 'サンプル: 架空の図書室' },
  { id: 'sample-job-consult', dir: 'job-consult', title: 'サンプル: 架空の求人相談(モック AI)' },
];

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
    await fs.writeFile(paths.meta, `${JSON.stringify({ title: sample.title }, null, 2)}\n`);
    copied.push(sample.id);
  }
  return copied;
}

async function readTitle(paths, id) {
  try {
    const meta = JSON.parse(await fs.readFile(paths.meta, 'utf8'));
    if (typeof meta.title === 'string' && meta.title.trim()) return meta.title.trim().slice(0, 200);
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
  projects.sort((a, b) => a.id.localeCompare(b.id));
  return projects;
}
