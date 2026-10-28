// 会話の進め方と模擬のエージェントのテストの部品。架空の試作品(test/fixtures/sim-a、sim-c)を一時フォルダーに写してビルドする
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from '../../src/server/build.js';
import { prepareSimulation } from '../../src/server/sim/orchestrator.js';

const FIXTURES = path.dirname(fileURLToPath(import.meta.url));
export const FAKE_CLAUDE = path.join(FIXTURES, 'fake-claude.js');

// name は sim-a か sim-c。edit(appDir) で、ビルドの前にファイルを書き換えられる
export async function buildSim(t, name, edit = async () => {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `studio-${name}-`));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const appDir = path.join(root, 'app');
  await fs.cp(path.join(FIXTURES, name, 'app'), appDir, { recursive: true });
  await edit(appDir);
  const result = await buildApp({ appDir, buildsDir: path.join(root, '.studio', 'builds') });
  if (!result.ok) throw new Error(`ビルドに失敗しました: ${JSON.stringify(result.errors)}`);
  const aiOf = (file) => result.simulation.harnessAis[file] ?? (file === result.manifest.ai ? result.ai : null);
  return {
    root,
    appDir,
    result,
    simulation: result.simulation,
    aiOf,
    prepare: (options = {}) => prepareSimulation(result.simulation, { aiOf, ...options }),
  };
}

export const readJson = async (file) => JSON.parse(await fs.readFile(file, 'utf8'));
