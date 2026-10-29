import fs from 'node:fs/promises';
import path from 'node:path';
import { STUDIO_ROOT } from './config.js';
import { isAllowedHost, tokensEqual } from './security.js';
import { AgentUnavailableError, RequestError } from './build-requests.js';
import { CheckError } from './checks.js';
import { AiError } from './product-ai/session.js';
import { EvidenceError, evidenceState, readEvidenceImage } from './evidence.js';
import { ConsentRequiredError } from './real-ai.js';
import { BusyError, NotFoundError } from './store.js';
import { HandoffError } from './handoff.js';
import { VersionError } from './versions.js';

const MAX_BODY_BYTES = 64 * 1024;

const UI_DIR = path.join(STUDIO_ROOT, 'src', 'ui');
const UI_FILES = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/studio.js': ['studio.js', 'text/javascript; charset=utf-8'],
  '/studio.css': ['studio.css', 'text/css; charset=utf-8'],
  // 観察用の親ページ(src/observer/ が開く)
  '/observe.html': ['observe.html', 'text/html; charset=utf-8', 'observe'],
  '/observe.js': ['observe.js', 'text/javascript; charset=utf-8', 'observe'],
};

function sendJson(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(JSON.stringify(body));
}

function sendError(res, status, code, message, next) {
  sendJson(res, status, { error: next ? { code, message, next } : { code, message } });
}

export function studioCsp(previewPort) {
  return [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "connect-src 'self'",
    `frame-src http://localhost:${previewPort}`,
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');
}

// 観察用の親ページは Studio の API を呼ばない。だから connect-src も 'none' にする
export function observeCsp(previewPort) {
  return [
    "default-src 'none'",
    "script-src 'self'",
    "connect-src 'none'",
    `frame-src http://localhost:${previewPort}`,
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');
}

class BodyError extends Error {}

// 中身のない POST(リセットなど)は {} として読む。中身があるときは JSON の Content-Type を求める
async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new BodyError(`送る内容が大きすぎます(上限 ${MAX_BODY_BYTES} バイト)`);
    chunks.push(chunk);
  }
  if (size === 0) return {};
  if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) {
    throw new BodyError('Content-Type は application/json にしてください');
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new BodyError('送る内容が JSON として読めません');
  }
}

function projectView(project, previewPort, runs, checks, firstSteps) {
  return {
    id: project.id,
    title: project.title,
    appDir: project.appDir,
    building: project.building,
    versioning: project.versioning,
    running: runs.running,
    runsVersion: runs.version,
    // 人の「確かめる」をしている最中か。checksVersion が変わったら、画面は確かめの一覧を読み直す
    checking: checks.checking,
    checksVersion: checks.version,
    lastBuild: project.lastBuild,
    // 最初の一歩の案内の、この試作品の手順の済み(first-steps.js)
    firstSteps: firstSteps.view(project.id),
    previewUrl: project.previewBuildId
      ? `http://localhost:${previewPort}/p/${project.id}/${project.previewBuildId}/`
      : null,
  };
}

// Studio 画面と API。API はすべてトークンを要求する(ADR-0001 の層 3)。
// realAi(projectId) は本物の AI を使う前の同意のカードの中身(real-ai.js の consentView)、consent は同意の状態。
// firstSteps は最初の一歩の案内の進み方と、閉じたこと(first-steps.js)
export function createStudioHandler({ store, requests, checks, agent, aiSessions, versions, handoffs, token, ports, realAi, consent, firstSteps }) {
  const view = (project) => projectView(project, ports.preview, requests.summary(project.id), checks.summary(project.id), firstSteps);

  // 作る欄の依頼。実行の様子を、1 行 1 つの JSON(NDJSON)で流す。
  // EventSource はヘッダーにトークンを付けられないので、画面は fetch の応答をストリームで読む(ADR-0001)。
  async function handleBuildRequest(req, res, id) {
    let started;
    try {
      const body = await readJson(req);
      started = await requests.start(id, body?.request);
    } catch (error) {
      if (error instanceof NotFoundError) return sendError(res, 404, 'not-found', `プロジェクトがありません: ${id}`);
      if (error instanceof BusyError) return sendError(res, 409, 'busy', error.message);
      if (error instanceof RequestError || error instanceof BodyError) return sendError(res, 400, 'request', error.message);
      if (error instanceof AgentUnavailableError) return sendError(res, 503, 'agent', error.message);
      if (error instanceof ConsentRequiredError) return sendError(res, 403, error.code, error.message, error.next);
      throw error;
    }
    res.writeHead(200, {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    const write = (run) => {
      if (!res.writableEnded) res.write(`${JSON.stringify({ run })}\n`);
    };
    write(started.run);
    // 画面を閉じても、実行は続ける。結果は一覧の API で読める
    const unsubscribe = started.subscribe(write, (run) => {
      write(run);
      res.end();
    });
    res.on('close', unsubscribe);
  }

  async function handleApi(req, res, url) {
    if (!tokensEqual(req.headers['x-studio-token'], token)) {
      return sendError(res, 401, 'token', '鍵が合いません。ターミナルに表示された URL から開き直してください');
    }
    if (req.method !== 'GET' && req.headers.origin !== `http://${req.headers.host.toLowerCase()}`) {
      return sendError(res, 403, 'origin', 'Studio の画面以外からの操作は受け付けません');
    }
    if (req.method === 'GET' && url.pathname === '/api/projects') {
      const projects = await store.list();
      // consent は本物の AI を使う前の同意の状態。画面は、本物の AI を使っている間の印を、これで出す。
      // firstSteps は最初の一歩の案内を閉じたか(手順の済みは、試作品ごとの firstSteps)
      return sendJson(res, 200, { projects: projects.map(view), agent, consent: consent.state(), firstSteps: firstSteps.state() });
    }
    // 最初の一歩の案内。{ dismiss: true } で閉じる。{ touched: 試作品の ID } は、AI のない試作品の画面を触ったこと(画面が送る)
    if (url.pathname === '/api/first-steps' && req.method === 'POST') return handleFirstSteps(req, res);
    // 本物の AI を使う前の同意。GET はカードの中身(?project= で、その試作品の中の AI の「詳しく」も入れる)、
    // POST の consent は同意する。ほかの API と同じく、トークンと Origin(Studio の画面から)を確かめた後にだけ届く
    if (url.pathname === '/api/real-ai' || url.pathname === '/api/real-ai/consent') {
      const consenting = url.pathname === '/api/real-ai/consent';
      if (req.method !== (consenting ? 'POST' : 'GET')) return sendError(res, 404, 'not-found', 'その API はありません');
      return handleRealAi(req, res, url, consenting);
    }
    const requestsMatch = /^\/api\/projects\/([a-z0-9-]{1,64})\/build-requests$/.exec(url.pathname);
    if (requestsMatch && req.method === 'GET') {
      try {
        await store.requireProject(requestsMatch[1]);
      } catch (error) {
        if (error instanceof NotFoundError) return sendError(res, 404, 'not-found', error.message);
        throw error;
      }
      return sendJson(res, 200, { runs: requests.list(requestsMatch[1]) });
    }
    if (requestsMatch && req.method === 'POST') return handleBuildRequest(req, res, requestsMatch[1]);
    // 作るループの証拠。evidence は、終わった run ごとに証拠が古いか(今の app/ の指紋と比べる。S6)、
    // evidence/screenshot は、結果の帯に出すスクリーンショット(.studio/runs/ と .studio/observations/ の中の画像だけ)
    const evidenceMatch = /^\/api\/projects\/([a-z0-9-]{1,64})\/evidence(\/screenshot)?$/.exec(url.pathname);
    if (evidenceMatch && req.method === 'GET') return handleEvidence(res, evidenceMatch[1], evidenceMatch[2] ? url.searchParams.get('file') : undefined);
    // 人の「確かめる」(P27)。GET は確かめの一覧、POST は確かめを始める({ connection: 'mock' | 'claude-code' })
    const checksMatch = /^\/api\/projects\/([a-z0-9-]{1,64})\/checks$/.exec(url.pathname);
    if (checksMatch && (req.method === 'GET' || req.method === 'POST')) return handleChecks(req, res, checksMatch[1]);
    const cancelMatch = /^\/api\/projects\/([a-z0-9-]{1,64})\/build-requests\/([a-f0-9]{16})\/cancel$/.exec(url.pathname);
    if (cancelMatch && req.method === 'POST') {
      const run = requests.cancel(cancelMatch[1], cancelMatch[2]);
      if (!run) return sendError(res, 409, 'not-running', 'その依頼は、もう動いていません');
      return sendJson(res, 200, { run });
    }
    const buildMatch = /^\/api\/projects\/([^/]+)\/builds$/.exec(url.pathname);
    if (req.method === 'POST' && buildMatch) {
      let id;
      try {
        id = decodeURIComponent(buildMatch[1]);
        await store.build(id);
      } catch (error) {
        if (error instanceof NotFoundError || error instanceof URIError) {
          return sendError(res, 404, 'not-found', `プロジェクトがありません: ${buildMatch[1]}`);
        }
        if (error instanceof BusyError) return sendError(res, 409, 'busy', error.message);
        throw error;
      }
      const project = (await store.list()).find((p) => p.id === id);
      return sendJson(res, 200, { project: view(project) });
    }
    const versionsMatch = /^\/api\/projects\/([a-z0-9-]{1,64})\/versions(?:\/([^/]+)\/(restore))?$/.exec(url.pathname);
    if (versionsMatch) {
      const [, id, versionId, restore] = versionsMatch;
      if (req.method === 'GET' && !restore) return handleVersions(req, res, id, null);
      if (req.method === 'POST') return handleVersions(req, res, id, restore ? versionId : undefined);
    }
    const handoffMatch = /^\/api\/projects\/([a-z0-9-]{1,64})\/handoff$/.exec(url.pathname);
    if (handoffMatch && (req.method === 'GET' || req.method === 'POST')) return handleHandoff(req, res, handoffMatch[1]);
    const aiMatch = /^\/api\/projects\/([^/]+)\/ai(?:\/(messages|corrections|reset|connections|connection|simulation|cancel|retry|trace|clear-trace))?$/.exec(
      url.pathname,
    );
    const aiGet = !aiMatch?.[2] || aiMatch[2] === 'connections' || aiMatch[2] === 'trace';
    if (aiMatch && (aiGet ? req.method === 'GET' : req.method === 'POST')) {
      return handleAi(req, res, aiMatch[1], aiMatch[2]);
    }
    return sendError(res, 404, 'not-found', 'その API はありません');
  }

  // file が undefined なら、run ごとの古いかの印。文字列か null なら、その画像
  async function handleEvidence(res, id, file) {
    let paths;
    try {
      paths = await store.requireProject(id);
    } catch (error) {
      if (error instanceof NotFoundError) return sendError(res, 404, 'not-found', error.message);
      throw error;
    }
    if (file === undefined) return sendJson(res, 200, await evidenceState(paths, requests.list(id), checks.list(id)));
    let body;
    try {
      body = await readEvidenceImage(paths, file);
    } catch (error) {
      if (error instanceof EvidenceError) return sendError(res, error.status, error.code, error.message);
      throw error;
    }
    res.writeHead(200, {
      'Content-Type': 'image/png',
      'Content-Length': body.length,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'",
    });
    res.end(body);
  }

  // 確かめは、作る run、ビルド、版の操作の間は 409 で断る。本物の AI は、同意の前は 403(consent-required)で断る
  async function handleChecks(req, res, id) {
    try {
      if (req.method === 'GET') {
        await store.requireProject(id);
        return sendJson(res, 200, { checks: checks.list(id) });
      }
      const body = await readJson(req);
      return sendJson(res, 200, { check: await checks.start(id, { connection: body?.connection ?? 'mock' }) });
    } catch (error) {
      if (error instanceof NotFoundError) return sendError(res, 404, 'not-found', error.message);
      if (error instanceof BusyError) return sendError(res, 409, 'busy', error.message);
      if (error instanceof BodyError) return sendError(res, 400, 'invalid', error.message);
      if (error instanceof CheckError) return sendError(res, error.status, error.code, error.message);
      if (error instanceof AiError) return sendError(res, error.status, error.code, error.message, error.next);
      throw error;
    }
  }

  async function handleFirstSteps(req, res) {
    let body;
    try {
      body = await readJson(req);
    } catch (error) {
      if (error instanceof BodyError) return sendError(res, 400, 'invalid', error.message);
      throw error;
    }
    if (body?.dismiss === true) firstSteps.dismiss();
    else if (typeof body?.touched === 'string' && (await store.list()).some((p) => p.id === body.touched)) firstSteps.tried(body.touched);
    else return sendError(res, 400, 'invalid', '{ dismiss: true } か、{ touched: 試作品の ID } を送ってください');
    return sendJson(res, 200, { firstSteps: firstSteps.state() });
  }

  async function handleRealAi(req, res, url, consenting) {
    const projectId = url.searchParams.get('project');
    if (projectId !== null && !(await store.list()).some((p) => p.id === projectId)) {
      return sendError(res, 404, 'not-found', `プロジェクトがありません: ${projectId}`);
    }
    if (consenting) {
      try {
        await readJson(req);
      } catch (error) {
        if (error instanceof BodyError) return sendError(res, 400, 'invalid', error.message);
        throw error;
      }
      consent.agree();
    }
    return sendJson(res, 200, realAi(projectId));
  }

  // 版。versionId が null なら一覧、undefined なら保存、文字列ならその版の復元
  async function handleVersions(req, res, id, versionId) {
    try {
      if (versionId === null) return sendJson(res, 200, await versions.list(id));
      const body = await readJson(req);
      if (versionId === undefined) return sendJson(res, 200, await versions.save(id, { name: body?.name }));
      return sendJson(res, 200, await versions.restore(id, versionId));
    } catch (error) {
      if (error instanceof NotFoundError) return sendError(res, 404, 'not-found', error.message);
      if (error instanceof BusyError) return sendError(res, 409, 'busy', error.message);
      if (error instanceof VersionError) return sendError(res, error.status, error.code, error.message);
      if (error instanceof BodyError) return sendError(res, 400, 'invalid', error.message);
      throw error;
    }
  }

  // 本番開発への引き継ぎ。GET は前に書いたメモと最後の書き出し、POST は書き出し
  async function handleHandoff(req, res, id) {
    try {
      if (req.method === 'GET') return sendJson(res, 200, await handoffs.view(id));
      const body = await readJson(req);
      return sendJson(res, 200, await handoffs.export(id, body));
    } catch (error) {
      if (error instanceof NotFoundError) return sendError(res, 404, 'not-found', error.message);
      if (error instanceof BusyError) return sendError(res, 409, 'busy', error.message);
      if (error instanceof HandoffError) return sendError(res, error.status, error.code, error.message);
      if (error instanceof BodyError) return sendError(res, 400, 'invalid', error.message);
      throw error;
    }
  }

  // プロダクト内 AI。試作品からの要求は、Studio 画面が形を確かめてから、ここへ送る。
  // 接続の切り替えと中断と試し直し(connections、connection、cancel、retry)、構成と前提の選び方(simulation)と実行の記録(trace、clear-trace)は、
  // Studio 画面だけが送る。試作品からは届かない。
  // 本物の接続への切り替えは、同意の前は断る(AiSessions.useReal。理由のコードは consent-required)。
  // retry は試し直せる会話と結果で、Studio 画面だけが使う(画面は試作品に session だけを渡す)
  async function handleAi(req, res, rawId, action) {
    let id;
    try {
      id = decodeURIComponent(rawId);
    } catch {
      id = null;
    }
    if (!(await store.list()).some((p) => p.id === id)) {
      return sendError(res, 404, 'not-found', `プロジェクトがありません: ${rawId}`);
    }
    // 版の保存と復元の間は、会話を変えない(戻した会話や自動の版から、発言が抜け落ちないように)。
    // 接続の一覧と中断、実行の記録は会話を変えないので通す。実モデルの応答はいつでも止められる
    const changesConversation = action && !['connections', 'cancel', 'trace', 'clear-trace'].includes(action);
    if (changesConversation && store.isVersioning(id)) {
      return sendError(res, 409, 'busy', '保存か、保存した状態に戻すか、本番開発へ渡すフォルダーを作っているところです。終わってから試してください');
    }
    try {
      if (action === 'connections') return sendJson(res, 200, aiSessions.connectionChoices(id));
      if (action === 'trace') return sendJson(res, 200, aiSessions.trace(id));
      if (action === 'clear-trace') {
        await readJson(req);
        return sendJson(res, 200, aiSessions.clearTrace(id));
      }
      const body = action ? await readJson(req) : null;
      // 本文を読んでいる間に、版の操作が始まったかもしれない
      if (changesConversation && store.isVersioning(id)) {
        return sendError(res, 409, 'busy', '保存か、保存した状態に戻すか、本番開発へ渡すフォルダーを作っているところです。終わってから試してください');
      }
      let session;
      if (!action) session = aiSessions.view(id);
      else if (action === 'connection') session = aiSessions.select(id, body?.kind);
      // 構成と前提を選ぶ(開発者向けの詳細)。会話は最初からになる。選び方も返す
      else if (action === 'simulation') session = aiSessions.chooseSimulation(id, { composition: body?.composition, assumptions: body?.assumptions });
      else if (action === 'cancel') session = aiSessions.cancel(id);
      // action はボタンの action(構成のある会話で使う。studio.ai.send(text, { action }))
      else if (action === 'messages') session = await aiSessions.send(id, body?.text, { action: body?.action });
      else if (action === 'corrections') session = aiSessions.correct(id, body?.changes);
      else if (action === 'retry') session = await aiSessions.retry(id);
      else session = aiSessions.reset(id);
      // 話したことと試し直したことは、最初の一歩の案内の手順を進める(1 番、直した後なら 3 番)
      if (action === 'messages' || action === 'retry') firstSteps.tried(id);
      if (action === 'simulation') return sendJson(res, 200, { session, retry: aiSessions.retryInfo(id), simulation: aiSessions.simulationChoices(id) });
      return sendJson(res, 200, { session, retry: aiSessions.retryInfo(id) });
    } catch (error) {
      if (error instanceof AiError) return sendError(res, error.status, error.code, error.message, error.next);
      if (error instanceof BodyError) return sendError(res, 400, 'invalid', error.message);
      throw error;
    }
  }

  return async (req, res) => {
    try {
      if (!isAllowedHost(req.headers.host, ports.studio)) {
        res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Host が正しくありません');
        return;
      }
      const url = new URL(req.url, 'http://studio.invalid');
      if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);

      await sendUiFile(req, res, UI_FILES[url.pathname], ports);
    } catch (error) {
      console.error(error);
      if (!res.headersSent) sendError(res, 500, 'internal', 'Studio のサーバーで問題が起きました。ターミナルの表示を確かめてください');
    }
  };
}

async function sendUiFile(req, res, uiFile, ports) {
  if (!uiFile || req.method !== 'GET') {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('見つかりません');
    return;
  }
  const body = await fs.readFile(path.join(UI_DIR, uiFile[0]));
  res.writeHead(200, {
    'Content-Type': uiFile[1],
    'Content-Security-Policy': uiFile[2] === 'observe' ? observeCsp(ports.preview) : studioCsp(ports.preview),
    'X-Frame-Options': 'DENY',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

// 観察用の親ページだけを出す。Studio とは別に動く観察(CLI など。observe-entry.js の working)が、自分の loopback のポートで使う。
// API はなく、起動ごとのトークンも持たない
export function createObserveHostHandler({ ports }) {
  return async (req, res) => {
    try {
      if (!isAllowedHost(req.headers.host, ports.studio)) {
        res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Host が正しくありません');
        return;
      }
      const uiFile = UI_FILES[new URL(req.url, 'http://observe.invalid').pathname];
      await sendUiFile(req, res, uiFile?.[2] === 'observe' ? uiFile : undefined, ports);
    } catch (error) {
      console.error(error);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('観察用の親ページを出せませんでした');
      }
    }
  };
}
