import fs from 'node:fs/promises';
import path from 'node:path';

export const PROJECT_ID_PATTERN = /^[a-z0-9-]{1,64}$/;

export const SAMPLE_PROJECT_ID = 'sample-library';
const SAMPLE_TITLE = 'サンプル: 架空の図書室';

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

// 初回だけサンプルを写す。利用者が手を入れた後は上書きしない。
export async function ensureSampleProject(home, samplesRoot) {
  const paths = projectPaths(home, SAMPLE_PROJECT_ID);
  if (await exists(paths.root)) return false;
  await fs.mkdir(paths.studio, { recursive: true });
  await fs.cp(path.join(samplesRoot, 'library', 'app'), paths.app, { recursive: true });
  await fs.writeFile(paths.meta, `${JSON.stringify({ title: SAMPLE_TITLE }, null, 2)}\n`);
  return true;
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
