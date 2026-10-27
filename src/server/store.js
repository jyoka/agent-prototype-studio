import fs from 'node:fs/promises';
import { buildApp, removeBuildsExcept } from './build.js';
import { isValidProjectId, listProjects, projectPaths } from './projects.js';

export class BusyError extends Error {}

const BUSY = {
  running: 'このプロジェクトでは今、作る AI が作業中です。終わるか中断するまで待ってください',
  building: 'このプロジェクトは今ビルド中です。終わるまで待ってください',
  versioning: 'このプロジェクトは今、版の保存か復元、または引き継ぎの書き出しをしているところです。終わるまで待ってください',
};
export class NotFoundError extends Error {}

// プロジェクトごとの最後のビルドの結果と、表示できる版を持つ。
export class ProjectStore {
  constructor(home, log = () => {}) {
    this.home = home;
    this.log = log;
    this.state = new Map();
  }

  entry(id) {
    if (!this.state.has(id)) {
      this.state.set(id, { building: false, running: false, versioning: false, lastBuild: null, previewBuildId: null, ai: null });
    }
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
        running: entry.running,
        versioning: entry.versioning,
        lastBuild: entry.lastBuild,
        previewBuildId: entry.previewBuildId,
      };
    });
  }

  previewBuildId(id) {
    return this.state.get(id)?.previewBuildId ?? null;
  }

  // 表示中の版の AI の設定。失敗したビルドの設定は使わない
  aiDefinition(id) {
    return this.state.get(id)?.ai ?? null;
  }

  async requireProject(id) {
    if (!isValidProjectId(id)) throw new NotFoundError(`プロジェクトがありません: ${id}`);
    const paths = projectPaths(this.home, id);
    const appStat = await fs.lstat(paths.app).catch(() => null);
    if (!appStat?.isDirectory()) throw new NotFoundError(`プロジェクトがありません: ${id}`);
    return paths;
  }

  // 作る AI の実行を始める印。ビルド中や実行中なら断る(1 プロジェクト 1 実行)
  claimRun(id) {
    const entry = this.entry(id);
    if (entry.running) throw new BusyError(BUSY.running);
    if (entry.building) throw new BusyError(BUSY.building);
    if (entry.versioning) throw new BusyError(BUSY.versioning);
    entry.running = true;
  }

  releaseRun(id) {
    this.entry(id).running = false;
  }

  // 版の保存と復元、引き継ぎの書き出しを始める印。作る AI やビルドと同時には app/ を読み書きしない
  claimVersions(id) {
    const entry = this.entry(id);
    if (entry.running) throw new BusyError(BUSY.running);
    if (entry.building) throw new BusyError(BUSY.building);
    if (entry.versioning) throw new BusyError(BUSY.versioning);
    entry.versioning = true;
  }

  releaseVersions(id) {
    this.entry(id).versioning = false;
  }

  isVersioning(id) {
    return Boolean(this.state.get(id)?.versioning);
  }

  // byRun: 作る AI の実行の後に、その実行の中から呼ぶとき。byVersions: 版の復元の中から呼ぶとき
  async build(id, { byRun = false, byVersions = false } = {}) {
    const paths = await this.requireProject(id);
    const entry = this.entry(id);
    // 1 プロジェクト 1 実行
    if (entry.building) throw new BusyError(BUSY.building);
    if (entry.running && !byRun) throw new BusyError(BUSY.running);
    if (entry.versioning && !byVersions) throw new BusyError(BUSY.versioning);
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
      const { ai = null, ...summary } = result;
      entry.lastBuild = summary;
      if (result.ok) {
        entry.previewBuildId = result.buildId;
        entry.ai = ai;
        await removeBuildsExcept(paths.builds, [result.buildId]);
        this.log(`ビルド成功: ${id}(${result.durationMs}ms)`);
      } else {
        this.log(`ビルド失敗: ${id}`);
        for (const error of result.errors) {
          const where = error.line ? `${error.file}:${error.line}:${error.column}` : error.file;
          this.log(`  ${where} ${error.text}`);
        }
      }
      return summary;
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
