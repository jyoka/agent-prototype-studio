import crypto from 'node:crypto';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Observer } from '../observer/observe.js';
import { readScenarios } from '../observer/scenario.js';
import { buildApp } from './build.js';
import { createPreviewHandler } from './preview-server.js';
import { createMockConnection } from './product-ai/mock.js';
import { createObservationAi } from './product-ai/observation.js';
import { AiSessions } from './product-ai/session.js';
import { isValidProjectId, projectPaths } from './projects.js';
import { createObserveHostHandler } from './studio-server.js';

// 観察の入口(docs/design/harness.md の 3.1、S5)。観察を呼ぶ所は、どれもこの observeProject を使い、
// 同じ形の report(観察器の report)を返す。今の呼ぶ所は、作るループの関門 G5 と G6、画面の「確かめる」(P27。checks.js)、
// Studio の observe()、CLI(bin/observe.js)、観察の道具の MCP サーバー(observe-mcp.js)。
// 観察器(src/observer/)は会話の実装を import しない(S2)ので、AI の会話を作るこの入口は src/server/ に置く。
//
// モードは 2 つ:
//   shown:   表示中のビルドを見る。動いている Studio の中から呼ぶ(作るループ、画面の「確かめる」、Studio の observe())。
//            ビルドとプレビューの配信は、呼ぶ側(Studio)が shown で渡す
//   working: 作業中の app/ を一時フォルダー(os.tmpdir() の下)にビルドし、loopback の空いているポートに
//            自分のプレビューの配信と観察用の親ページを立てて見る(CLI、観察の道具の MCP サーバー)。
//            プロジェクトの .studio/builds/ と表示中のビルドには触れない。Studio の起動ごとのトークンも使わない。
//            プロダクト内 AI は、この観察だけのモックの会話にする(実モデルは選べない)
export const OBSERVE_MODES = ['shown', 'working'];

// working のプレビューの配信の中で使う、プロジェクトの ID(一時フォルダーの中だけの名前)
const WORKING_ID = 'working';
const TEMP_PREFIX = 'prototype-studio-observe-';

// 終わっていない観察の一時フォルダーと、report をまだ書いていない観察のフォルダー。CLI が Ctrl+C で止まるときに消す
const unfinished = new Set();

export function removeUnfinishedSync() {
  for (const dir of unfinished) fsSync.rmSync(dir, { recursive: true, force: true });
  unfinished.clear();
}

export function createObservationId() {
  return `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
}

// .studio/observations/<obs-id>/ を新しく作る。あるフォルダーは使わない(上書きしない)
async function newObservationDir(projectDir) {
  const parent = path.join(projectDir, '.studio', 'observations');
  await fs.mkdir(parent, { recursive: true });
  for (;;) {
    const dir = path.join(parent, createObservationId());
    try {
      await fs.mkdir(dir);
      return dir;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }
}

// シナリオを渡されなければ、目録の scenarios(既定は app/scenarios/)から読む。
// 形の誤りがあるシナリオは、ファイルごとに 1 つの failed の結果にする
async function scenariosOf(appDir, manifest) {
  const loaded = await readScenarios(appDir, manifest?.scenarios);
  const broken = Map.groupBy(loaded.errors, (error) => error.file);
  return [...loaded.scenarios, ...[...broken].map(([file, errors]) => ({ file, errors }))];
}

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

const closeServer = (server) =>
  new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections?.();
  });

// loopback の空いているポートで待ち受ける。プレビューは localhost で開くので、::1 の同じポートでも待ち受ける
// (他のプロセスが ::1 の同じポートにいると、ブラウザはそちらを試作品として開いてしまう。そのときは別のポートにする)
async function listenLoopback(handler, servers) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const server = http.createServer(handler);
    const port = await listen(server, 0, '127.0.0.1');
    servers.push(server);
    const v6 = http.createServer(handler);
    try {
      await listen(v6, port, '::1');
      servers.push(v6);
      return port;
    } catch (error) {
      // IPv6 がない PC では 127.0.0.1 だけにする
      if (error.code !== 'EADDRINUSE') return port;
      servers.pop();
      await closeServer(server);
    }
  }
  throw new Error('観察に使うポートを用意できませんでした');
}

// 作業中の app/ を一時フォルダーにビルドし、その配信を立てて観察する。終わったら配信を止め、一時フォルダーを消す
async function observeWorking({ projectDir, observe }) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), TEMP_PREFIX));
  unfinished.add(tmp);
  const servers = [];
  try {
    const buildsDir = projectPaths(tmp, WORKING_ID).builds;
    await fs.mkdir(buildsDir, { recursive: true });
    let result;
    try {
      result = await buildApp({ appDir: path.join(projectDir, 'app'), buildsDir, projectRoot: projectDir });
    } catch (error) {
      // 読めないファイルなど。Studio のビルド(store.js)と同じく、ビルドの失敗にする
      result = {
        ok: false,
        errors: [{ file: 'app/', line: null, column: null, lineText: null, text: `ビルドの途中で問題が起きました: ${error.message}` }],
        finishedAt: new Date().toISOString(),
      };
    }
    // ビルドに失敗していれば、観察器はブラウザを開かずに failed を返す。配信は立てない
    if (!result.ok) return await observe({ result, previewUrl: null, hostUrl: null }, null);

    const ports = { studio: null, preview: null };
    const store = { previewBuildId: (id) => (id === WORKING_ID ? result.buildId : null) };
    ports.studio = await listenLoopback(createObserveHostHandler({ ports }), servers);
    ports.preview = await listenLoopback(createPreviewHandler({ home: tmp, store, ports }), servers);
    return await observe(
      {
        result,
        previewUrl: `http://localhost:${ports.preview}/p/${WORKING_ID}/${result.buildId}/`,
        hostUrl: `http://127.0.0.1:${ports.studio}/observe.html`,
      },
      result.manifest,
    );
  } finally {
    await Promise.all(servers.map(closeServer));
    await fs.rm(tmp, { recursive: true, force: true });
    unfinished.delete(tmp);
  }
}

// 観察する。返すのは { report, dir, reportFile }。
// projectDir:   プロジェクトのフォルダー(app/ と .studio/ を持つ)
// mode:         'shown' か 'working'(上の説明)
// shown:        mode が shown のときだけ。{ result, previewUrl, hostUrl, manifest }
//               result は表示中のビルドの結果(基本のシナリオのあいさつのために、AI の設定を ai に入れる)、
//               manifest は表示中の版の目録
// projectId:    プロジェクトの ID。aiConnection の会話を aiSessions に作るときに使う
// scenarios:    回すシナリオ。渡さなければ、目録の scenarios(既定は app/scenarios/)から読む
// viewports、operate、base、limits: 観察器(Observer.observe)と同じ
// ai:           試作品からの AI の要求に答える関数。aiConnection とどちらか 1 つ
// aiConnection: 接続の種類('mock' など)。観察用の新しい会話で答え、観察が終わったら捨てる(S15)。
//               shown では aiSessions(Studio のもの)に会話を作る。working ではいつも、この観察だけのモックの会話
// aiSessions:   shown で aiConnection を使うときの、会話の置き場
// outDir:       スクリーンショットを置くフォルダー(作るループは run のラウンドのフォルダー)。
//               渡さなければ .studio/observations/<obs-id>/ を新しく作り、report.json もそこに書く
// observer:     使う観察器。Studio はブラウザを 1 つ使い回すので渡す。なければこの観察だけのものを作って閉じる
// signal:       中断の AbortSignal(観察の道具のサーバーが終わるとき)。中断されたら、ブラウザを開く前なら開かずに
//               中断の誤りを投げる(観察のフォルダーは残さない)。開いた後なら、この観察だけの観察器のブラウザを待たずに閉じ、
//               観察は unverified で終わる。渡された observer(Studio のもの)は止めない
export async function observeProject({
  projectDir,
  mode,
  shown,
  projectId = null,
  scenarios,
  viewports,
  ai,
  aiConnection,
  aiSessions = null,
  operate,
  base,
  limits,
  outDir,
  observer = null,
  signal = null,
} = {}) {
  if (typeof projectDir !== 'string' || projectDir === '') throw new TypeError('projectDir を渡してください');
  if (!OBSERVE_MODES.includes(mode)) throw new TypeError(`mode は ${OBSERVE_MODES.join(' か ')} で渡してください`);
  if (mode === 'shown' && (shown === null || typeof shown !== 'object')) throw new TypeError('mode が shown のときは shown を渡してください');
  if (ai != null && aiConnection !== undefined) throw new TypeError('ai と aiConnection は、どちらか 1 つだけ渡してください');
  if (ai != null && typeof ai !== 'function') throw new TypeError('ai は関数で渡してください');
  signal?.throwIfAborted();

  // working の AI は、この観察だけの会話の置き場に、モックの接続だけで作る
  let ownSessions = null;
  let definition = null;
  if (aiConnection !== undefined && mode === 'working') {
    ownSessions = new AiSessions({ definitionOf: () => definition, connections: [createMockConnection()] });
  }
  const sessions = ownSessions ?? aiSessions;
  const sessionId = ownSessions ? WORKING_ID : projectId;
  if (aiConnection !== undefined) {
    if (!sessions) throw new TypeError('aiConnection を使うときは aiSessions を渡してください');
    // 使えない接続(ない接続、実モデル)は、観察を始める前に断る
    sessions.observationConnection(aiConnection);
    if (!isValidProjectId(sessionId)) throw new TypeError('aiConnection を使うときは projectId を渡してください');
  }

  const dir = outDir ?? (await newObservationDir(projectDir));
  if (!outDir) unfinished.add(dir);
  const appDir = path.join(projectDir, 'app');
  const ownObserver = observer ? null : new Observer();
  const abortOwn = () => ownObserver?.abort().catch(() => {});
  signal?.addEventListener('abort', abortOwn, { once: true });
  let observationAi = null;
  const observe = async (build, manifest) => {
    // ビルドの間に中断されたら、ブラウザを開かない
    signal?.throwIfAborted();
    definition = build.result?.ok ? (build.result.ai ?? null) : null;
    if (aiConnection !== undefined) observationAi = createObservationAi(sessions, sessionId, { connection: aiConnection });
    const list = scenarios === undefined && build.result?.ok ? await scenariosOf(appDir, manifest) : scenarios;
    return (observer ?? ownObserver).observe({
      build,
      scenarios: list,
      viewports,
      ai: observationAi ?? ai,
      operate,
      base,
      limits,
      outDir: dir,
    });
  };

  let report;
  try {
    report =
      mode === 'shown'
        ? await observe({ result: shown.result, previewUrl: shown.previewUrl, hostUrl: shown.hostUrl }, shown.manifest)
        : await observeWorking({ projectDir, observe });
  } catch (error) {
    // 引数の誤りなどで観察しなかったときは、作った観察のフォルダーを残さない
    if (!outDir) {
      await fs.rm(dir, { recursive: true, force: true });
      unfinished.delete(dir);
    }
    throw error;
  } finally {
    signal?.removeEventListener('abort', abortOwn);
    observationAi?.close();
    await ownSessions?.close();
    await ownObserver?.close();
  }

  let reportFile = null;
  if (!outDir) {
    reportFile = path.join(dir, 'report.json');
    await fs.writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`);
    unfinished.delete(dir);
  }
  return { report, dir, reportFile };
}
