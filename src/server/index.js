import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { connectionView, resolveConnection } from './agent-connection.js';
import { Observer } from '../observer/observe.js';
import { BuildRequests } from './build-requests.js';
import { STUDIO_ROOT } from './config.js';
import { ProjectHandoffs } from './handoff.js';
import { createPreviewHandler } from './preview-server.js';
import { createClaudeCodeConnection } from './product-ai/claude-code.js';
import { createMockConnection } from './product-ai/mock.js';
import { AiSessions } from './product-ai/session.js';
import { observeProject } from './observe-entry.js';
import { ensureSampleProjects, projectsDir } from './projects.js';
import { createToken } from './security.js';
import { createStudioHandler } from './studio-server.js';
import { ProjectStore } from './store.js';
import { ProjectVersions, recoverInterrupted } from './versions.js';

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve(server.address().port);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

export class HomeNotWritableError extends Error {
  constructor(home, cause) {
    super(`データの置き場に書き込めません(${home})`, { cause });
  }
}

export class PortInUseError extends Error {
  constructor(port, name) {
    super(`ポート ${port} は使われています`);
    this.port = port;
    this.envName = name;
  }
}

async function listenOrExplain(server, port, host, envName) {
  try {
    return await listen(server, port, host);
  } catch (error) {
    if (error.code === 'EADDRINUSE') throw new PortInUseError(port, envName);
    throw error;
  }
}

// Studio を起動する。待ち受けは loopback だけ(0.0.0.0 にはしない)。
// env は作る AI とプロダクト内 AI に渡す環境変数。既定は利用者のもの(ADR-0001: そのまま渡し、値は読まない)。
// scenarioLimits は関門 G6 の時間の上限(build-requests.js の SCENARIO_GATE_LIMITS)。テストで短くするときだけ渡す
export async function startStudio(config, { log = () => {}, env = process.env, scenarioLimits } = {}) {
  try {
    await fs.mkdir(projectsDir(config.home), { recursive: true });
    for (const id of await ensureSampleProjects(config.home, path.join(STUDIO_ROOT, 'samples'))) {
      log(`サンプルの試作品を用意しました: ${id}`);
    }
    await recoverInterrupted(config.home, log);
  } catch (error) {
    // ENOTDIR と EEXIST は、置き場の途中にふつうのファイルがあるとき
    if (['EACCES', 'EPERM', 'EROFS', 'ENOTDIR', 'EEXIST'].includes(error.code)) {
      throw new HomeNotWritableError(config.home, error);
    }
    throw error;
  }

  const connection = await resolveConnection(config, env);
  const token = createToken();
  const store = new ProjectStore(config.home, log);
  const ports = { studio: config.studioPort, preview: config.previewPort };
  // 観察器のブラウザは、Studio の中で 1 つだけ。最初の観察のときに起動する
  const observer = new Observer();

  // 表示中のビルドを観察する。呼ぶ所(作る run の関門 G5、G6 と、下の observe())は、どれも観察の入口
  // (observe-entry.js の observeProject)を通す。返すのは { report, dir, reportFile }
  async function observeShown(id, options) {
    const paths = await store.requireProject(id);
    const project = (await store.list()).find((p) => p.id === id);
    const last = project.lastBuild ?? { ok: false, errors: [{ file: 'app/', text: 'まだビルドしていません' }] };
    // 基本のシナリオ(あいさつ)のために、表示中の版の AI の設定を添える
    const result = last.ok ? { ...last, ai: store.aiDefinition(id) } : last;
    return observeProject({
      ...options,
      mode: 'shown',
      projectDir: paths.root,
      projectId: id,
      shown: {
        result,
        previewUrl: result.ok ? `http://localhost:${ports.preview}/p/${id}/${project.previewBuildId}/` : null,
        hostUrl: `http://127.0.0.1:${ports.studio}/observe.html`,
        manifest: store.manifest(id),
      },
      aiSessions,
      observer,
    });
  }

  // プロダクト内 AI の接続の既定はモック。Claude Code は、利用者が画面で送るものと費用を確かめてから切り替える
  const aiSessions = new AiSessions({
    definitionOf: (id) => store.aiDefinition(id),
    dataNumbersOf: (id) => store.dataNumbers(id),
    connections: [createMockConnection(), createClaudeCodeConnection({ env, allowed: config.allowClaudeCode === true })],
  });

  // 作る run の関門の観察。G5 は基本のシナリオとアプリのシナリオなしで観察し、プロダクト内 AI の要求は断る(ai を渡さない)。
  // G6 は app/ のシナリオと基本のシナリオを回す。プロダクト内 AI は、利用者が選んだ接続によらず、いつもモックの
  // 観察用の会話で答え、終わったら会話を捨てる(同じ入力で同じ結果になり、費用がかからない。ADR-0001 の T6)
  async function observeGate(id, { gate, viewports, outDir, limits }) {
    const options = gate === 'scenarios' ? { viewports: [], aiConnection: 'mock', limits, outDir } : { scenarios: [], base: false, viewports, outDir };
    return (await observeShown(id, options)).report;
  }

  const requests = new BuildRequests({
    store,
    connection,
    observe: observeGate,
    env,
    log,
    maxBudgetUsd: config.maxBudgetUsd,
    ...(scenarioLimits ? { scenarioLimits } : {}),
  });
  const servers = [];
  const versions = new ProjectVersions({ store, aiSessions, log });
  const handoffs = new ProjectHandoffs({ home: config.home, store, aiSessions, versions, requests, log });
  const studioServer = http.createServer(
    createStudioHandler({ store, requests, agent: connectionView(connection), aiSessions, versions, handoffs, token, ports }),
  );
  servers.push(studioServer);
  const previewHandler = createPreviewHandler({ home: config.home, store, ports });
  const previewServer = http.createServer(previewHandler);
  servers.push(previewServer);

  try {
    ports.studio = await listenOrExplain(studioServer, config.studioPort, '127.0.0.1', 'STUDIO_PORT');
    ports.preview = await listenOrExplain(previewServer, config.previewPort, '127.0.0.1', 'STUDIO_PREVIEW_PORT');
    // ブラウザが localhost を ::1 で引いても届くようにする
    const previewServerV6 = http.createServer(previewHandler);
    try {
      await listen(previewServerV6, ports.preview, '::1');
      servers.push(previewServerV6);
    } catch (error) {
      // 他のプロセスが ::1 の同じポートにいると、ブラウザはそちらを試作品として開いてしまう
      if (error.code === 'EADDRINUSE') throw new PortInUseError(`${ports.preview}(::1)`, 'STUDIO_PREVIEW_PORT');
      log(`::1 では待ち受けません(${error.code ?? error.message})`);
    }
  } catch (error) {
    await Promise.all(servers.map((server) => new Promise((resolve) => server.close(() => resolve()))));
    await aiSessions.close();
    throw error;
  }

  await store.buildAll();

  const url = `http://127.0.0.1:${ports.studio}/#token=${token}`;
  return {
    url,
    ports,
    store,
    requests,
    connection,
    aiSessions,
    versions,
    handoffs,
    observer,
    // 表示中のビルドを観察する。report とスクリーンショットは .studio/observations/<観察の ID>/ に置く。
    // シナリオは、渡さなければ app/ の目録の scenarios(既定は app/scenarios/)から読む。
    // Studio の基本のシナリオは、観察器がいつも先に回す。
    // プロダクト内 AI は、aiConnection(接続の種類。'mock' など)を渡すと、観察用の新しい会話で答え、
    // 観察が終わったら会話を捨てる(S15)。自分で作った ai 関数を渡してもよい
    async observe(id, { scenarios, viewports, ai, aiConnection, operate, limits } = {}) {
      return (await observeShown(id, { scenarios, viewports, ai, aiConnection, operate, limits })).report;
    },
    async close() {
      // 作る AI と、応答を待っているプロダクト内 AI の Claude Code と、観察器のブラウザを止め、終わるまで待つ
      await Promise.all([requests.closeAll(), aiSessions.close(), observer.close()]);
      await Promise.all(
        servers.map(
          (server) =>
            new Promise((resolve) => {
              server.close(() => resolve());
              server.closeAllConnections?.();
            }),
        ),
      );
    },
  };
}
