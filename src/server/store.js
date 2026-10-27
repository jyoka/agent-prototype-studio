import fs from 'node:fs/promises';
import { buildApp, removeBuildsExcept } from './build.js';
import { isValidProjectId, listProjects, projectPaths } from './projects.js';

export class BusyError extends Error {}
export class NotFoundError extends Error {}

// プロジェクトごとの最後のビルドの結果と、表示できる版を持つ。
export class ProjectStore {
  constructor(home, log = () => {}) {
    this.home = home;
    this.log = log;
    this.state = new Map();
  }

  entry(id) {
    if (!this.state.has(id)) this.state.set(id, { building: false, lastBuild: null, previewBuildId: null });
    return this.state.get(id);
  }

  async list() {
    const projects = await listProjects(this.home);
    return projects.map((project) => {
      const entry = this.entry(project.id);
      return {
        id: project.id,
        title: project.title,
        appDir: project.paths.app,
        building: entry.building,
        lastBuild: entry.lastBuild,
        previewBuildId: entry.previewBuildId,
      };
    });
  }

  previewBuildId(id) {
    return this.state.get(id)?.previewBuildId ?? null;
  }

  async build(id) {
    if (!isValidProjectId(id)) throw new NotFoundError(`プロジェクトがありません: ${id}`);
    const paths = projectPaths(this.home, id);
    const appStat = await fs.lstat(paths.app).catch(() => null);
    if (!appStat?.isDirectory()) throw new NotFoundError(`プロジェクトがありません: ${id}`);
    const entry = this.entry(id);
    // 1 プロジェクト 1 実行
    if (entry.building) throw new BusyError('このプロジェクトは今ビルド中です。終わるまで待ってください');
    entry.building = true;
    try {
      await fs.mkdir(paths.builds, { recursive: true });
      let result;
      try {
        result = await buildApp({ appDir: paths.app, buildsDir: paths.builds });
      } catch (error) {
        // 読めないファイルなど。1 つのプロジェクトの問題で Studio 全体を止めない
        result = {
          ok: false,
          errors: [{ file: 'app/', line: null, column: null, lineText: null, text: `ビルドの途中で問題が起きました: ${error.message}` }],
          finishedAt: new Date().toISOString(),
        };
      }
      entry.lastBuild = result;
      if (result.ok) {
        entry.previewBuildId = result.buildId;
        await removeBuildsExcept(paths.builds, [result.buildId]);
        this.log(`ビルド成功: ${id}(${result.durationMs}ms)`);
      } else {
        this.log(`ビルド失敗: ${id}`);
        for (const error of result.errors) {
          const where = error.line ? `${error.file}:${error.line}:${error.column}` : error.file;
          this.log(`  ${where} ${error.text}`);
        }
      }
      return result;
    } finally {
      entry.building = false;
    }
  }

  async buildAll() {
    for (const project of await listProjects(this.home)) {
      try {
        // 前回の起動のビルド結果は使わない
        await fs.rm(project.paths.builds, { recursive: true, force: true });
        await this.build(project.id);
      } catch (error) {
        this.log(`ビルドできませんでした: ${project.id}(${error.message})`);
      }
    }
  }
}
