import fs from 'node:fs/promises';
import path from 'node:path';
import { STUDIO_ROOT } from './config.js';
import { isAllowedHost, tokensEqual } from './security.js';
import { AgentUnavailableError, RequestError, ReviewRequiredError } from './build-requests.js';
import { CheckError } from './checks.js';
import { AiError } from './product-ai/session.js';
import { EvidenceError, evidenceState, readEvidenceImage } from './evidence.js';
import { ConsentRequiredError } from './real-ai.js';
import { BusyError, NotFoundError } from './store.js';
import { HandoffError } from './handoff.js';
import { IntentError } from './intent.js';
import { MaterialError } from './materials.js';
import { MeetingRefusedError } from './meeting.js';
import { SceneRunError } from './scene-runs.js';
import { ShowError } from './show.js';
import { CommentError } from './comments.js';
import { VersionError } from './versions.js';
import { COLUMNS } from './organize-ai.js';
import { Hints } from './hints.js';

const MAX_BODY_BYTES = 64 * 1024;
// トークンのファイルは大きいので、その API だけ広げる(上限は design-tokens.js の TOKEN_LIMITS。JSON の中に入れると伸びる分を見る)
const MAX_TOKENS_BODY_BYTES = 2 * 1024 * 1024;
// 部品と指針の取り込み。Storybook の index.json(上限 4 MB)と、JSON に入れたときに増える分。
// 部品のパッケージ(.tgz、上限 5 MB)も、base64 にして同じ上限で受ける
const MAX_GUIDES_BODY_BYTES = 8 * 1024 * 1024;

const UI_DIR = path.join(STUDIO_ROOT, 'src', 'ui');
const UI_FILES = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/studio.js': ['studio.js', 'text/javascript; charset=utf-8'],
  '/studio.css': ['studio.css', 'text/css; charset=utf-8'],
  // 案内の部品(12 の状態と「これは何?」の言葉)。studio.js が読む
  '/guide.js': ['guide.js', 'text/javascript; charset=utf-8'],
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
async function readJson(req, maxBytes = MAX_BODY_BYTES) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new BodyError(`送る内容が大きすぎます(上限 ${maxBytes} バイト)`);
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

// ヒアリングの整理の操作(URL の名前と organize.js の関数)。cancel は別に扱う
const ORGANIZE_ACTIONS = {
  point: 'addPoint',
  'point-remove': 'removePoint',
  place: 'placePoint',
  item: 'addItem',
  'item-edit': 'editItem',
  'item-remove': 'removeItem',
  'item-check': 'checkItem',
  'ask-remove': 'removeAsk',
  run: 'run',
  confirm: 'confirm',
  cancel: 'cancel',
};

function projectView(project, previewPort, runs, checks, firstSteps, intents, organizes, designs, meetings, reviews, sceneRuns) {
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
    // 目的の文書の状態(intent.js)。none と skipped は「目的なし」の印
    intent: intents.summary(project.id),
    // 整理の板の状態(organize.js)。confirmed は「確かめた」の印
    organize: organizes.summary(project.id),
    // 設計の案内の状態(design.js)。none と skipped は「設計なし」の印
    design: designs.summary(project.id),
    // AI 構成の審査の状態(review.js)。none は審査なし。approved と total は承認の数
    review: reviews.summary(project.id),
    // 会の状態(meeting.js)。none は会ではない試作品
    meeting: meetings.summary(project.id),
    // 主の画面の場面の回し(scene-runs.js)。count は場面の数。version が変わったら、画面は比べる表を読み直す
    scenes: sceneRuns.summary(project.id),
    previewUrl: project.previewBuildId
      ? `http://localhost:${previewPort}/p/${project.id}/${project.previewBuildId}/`
      : null,
  };
}

// Studio 画面と API。API はすべてトークンを要求する(ADR-0001 の層 3)。
// realAi(projectId) は本物の AI を使う前の同意のカードの中身(real-ai.js の consentView)、consent は同意の状態。
// firstSteps は最初の一歩の案内の進み方と、閉じたこと(first-steps.js)
// intents は目的の聞き出しと目的の文書(intent.js)。organizes はヒアリングの整理(organize.js)。designs は設計の案内(design.js)
// reviews は AI 構成の審査と AI 構成書(review.js)。sceneRuns は主の画面の場面の回しと比べる表(scene-runs.js)。
// quality は質の見直しの表(quality.js)。shows は人に見せる画面の問いと答え(show.js)。
// comments は画面へのコメント、反応、承認、列、直した記録、元に戻す(comments.js)
// hints は「その場で」の 1 行を覚えた回数(hints.js。ui-ux-v2.md の 5.1)
export function createStudioHandler({ store, requests, checks, agent, aiSessions, versions, handoffs, closings, intents, organizes, designs, reviews, sceneRuns, quality, shows, comments, materials, meetings, timeline = { mark: async () => false }, token, ports, realAi, consent, firstSteps, hints = new Hints() }) {
  const view = (project) => projectView(project, ports.preview, requests.summary(project.id), checks.summary(project.id), firstSteps, intents, organizes, designs, meetings, reviews, sceneRuns);

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
      if (error instanceof ReviewRequiredError) return sendError(res, 409, error.code, error.message);
      if (error instanceof ConsentRequiredError || error instanceof MeetingRefusedError) return sendError(res, 403, error.code, error.message, error.next);
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
      // 審査の印を今のファイルで取り直す(版を戻すなど、審査の外でファイルが変わったときも、承認の数を正しく出す)
      await reviews.refreshAll();
      // consent は本物の AI を使う前の同意の状態。画面は、本物の AI を使っている間の印を、これで出す。
      // firstSteps は最初の一歩の案内を閉じたか(手順の済みは、試作品ごとの firstSteps)
      // start ははじめの画面を出すか
      // meetingsDue は消す日を過ぎた会の一覧(知らせるだけで、Studio は勝手に消さない)
      return sendJson(res, 200, { projects: projects.map(view), agent, consent: consent.state(), firstSteps: firstSteps.state(), start: intents.startState(), meetingsDue: meetings.due(projects) });
    }
    // はじめの画面。1 文から新しい試作品を作る({ sentence, guide })。本物の AI は、同意の前は 403(consent-required)で断り、試作品を作らない
    if (req.method === 'POST' && url.pathname === '/api/projects') return handleNewProject(req, res);
    // はじめの画面を閉じる。起動し直すと、文書のある試作品がなければまた出る
    if (req.method === 'POST' && url.pathname === '/api/start') {
      return sendJson(res, 200, { start: intents.dismissStart() });
    }
    // 会の始め。{ purpose } で新しい試作品と会を作る。同意はまだ
    if (req.method === 'POST' && url.pathname === '/api/meetings') return handleNewMeeting(req, res);
    // 会の中身と同意と消す日。erase は会のデータを消す({ confirm: 試作品の ID })
    const meetingMatch = /^\/api\/projects\/([a-z0-9-]{1,64})\/meeting(?:\/(decide|delete-on|erase))?$/.exec(url.pathname);
    if (meetingMatch && (meetingMatch[2] ? req.method === 'POST' : req.method === 'GET')) return handleMeeting(req, res, meetingMatch[1], meetingMatch[2]);
    // 目的の聞き出しと目的の文書。GET は今の状態。「決めた」の印は decide でだけ付く
    const intentMatch = /^\/api\/projects\/([a-z0-9-]{1,64})\/intent(?:\/(start|answer|finish|edit|decide|skip|cancel))?$/.exec(url.pathname);
    if (intentMatch && (intentMatch[2] ? req.method === 'POST' : req.method === 'GET')) return handleIntent(req, res, intentMatch[1], intentMatch[2]);
    // ヒアリングの整理。GET は今の板。「確かめた」の印は confirm でだけ付く
    const organizeMatch = /^\/api\/projects\/([a-z0-9-]{1,64})\/organize(?:\/([a-z-]+))?$/.exec(url.pathname);
    if (organizeMatch && (organizeMatch[2] ? req.method === 'POST' && Object.hasOwn(ORGANIZE_ACTIONS, organizeMatch[2]) : req.method === 'GET')) return handleOrganize(req, res, organizeMatch[1], organizeMatch[2]);
    // 設計の案内。GET は今の状態。「決めた」の印は decide でだけ付く
    const designMatch = /^\/api\/projects\/([a-z0-9-]{1,64})\/design(?:\/(start|choose|scenes|go|decide|skip|cancel))?$/.exec(url.pathname);
    if (designMatch && (designMatch[2] ? req.method === 'POST' : req.method === 'GET')) return handleDesign(req, res, designMatch[1], designMatch[2]);
    // AI 構成の審査。GET は今の状態。承認は approve、作る前の承認の確かめは build でだけ
    // 主の画面の場面の回しと比べる表。GET は場面の一覧と一番新しい表。run は回し始める({ connection, limitUsd })。cancel は止める
    const scenesMatch = /^\/api\/projects\/([a-z0-9-]{1,64})\/scenes(?:\/(run|cancel))?$/.exec(url.pathname);
    if (scenesMatch && (scenesMatch[2] ? req.method === 'POST' : req.method === 'GET')) return handleScenes(req, res, scenesMatch[1], scenesMatch[2]);
    // 質の見直しの表。GET だけ(測るのは「確かめる」と場面の回し。ここは読むだけ)
    const qualityMatch = /^\/api\/projects\/([a-z0-9-]{1,64})\/quality$/.exec(url.pathname);
    if (qualityMatch && req.method === 'GET') return handleQuality(res, qualityMatch[1]);
    // 人に見せる(J7)。GET は問いと答えの記録。start は見せ始める(今の状態を版に結び付ける)。answer は答えを残す
    const showMatch = /^\/api\/projects\/([a-z0-9-]{1,64})\/show(?:\/(start|answer))?$/.exec(url.pathname);
    if (showMatch && (showMatch[2] ? req.method === 'POST' : req.method === 'GET')) return handleShow(req, res, showMatch[1], showMatch[2]);
    // 画面へのコメント(K3)。GET は一覧と直した記録。POST はコメントを書く。resume は列を進める。
    // コメントごとの操作は react、approve、unapprove、close、reopen、resolve、revert。作る AI を動かすのは、承認がそろったときだけ
    const commentsMatch = /^\/api\/projects\/([a-z0-9-]{1,64})\/comments(?:\/(resume)|\/([a-f0-9]{16})\/(react|approve|unapprove|close|reopen|resolve|revert))?$/.exec(url.pathname);
    if (commentsMatch && (commentsMatch[2] || commentsMatch[3] ? req.method === 'POST' : req.method === 'GET' || req.method === 'POST')) {
      return handleComments(req, res, commentsMatch[1], commentsMatch[2] ?? commentsMatch[4] ?? null, commentsMatch[3] ?? null);
    }
    const reviewMatch = /^\/api\/projects\/([a-z0-9-]{1,64})\/review(?:\/(start|choose|approve|build|skip|measure|back|restore))?$/.exec(url.pathname);
    if (reviewMatch && (reviewMatch[2] ? req.method === 'POST' : req.method === 'GET')) return handleReview(req, res, reviewMatch[1], reviewMatch[2]);
    // 自分のトークンをつなぐ(J4)、部品と指針をつなぐ(J5)。GET は今の状態。check は検査だけで何も書かない
    const materialsMatch = /^\/api\/projects\/([a-z0-9-]{1,64})\/materials(?:\/(tokens|guides|packages)(?:\/(check|remove|restore))?)?$/.exec(url.pathname);
    if (materialsMatch && !(materialsMatch[2] !== 'guides' && materialsMatch[3] === 'restore')) {
      const isRoot = url.pathname.endsWith('/materials');
      const action = isRoot ? 'view' : `${materialsMatch[2]}:${materialsMatch[3] ?? 'connect'}`;
      if (isRoot ? req.method === 'GET' : req.method === 'POST') return handleMaterials(req, res, materialsMatch[1], action);
    }
    // 最初の一歩の案内。{ dismiss: true } で閉じる。{ touched: 試作品の ID } は、AI のない試作品の画面を触ったこと(画面が送る)
    if (url.pathname === '/api/first-steps' && req.method === 'POST') return handleFirstSteps(req, res);
    // 「その場で」の 1 行を覚えた回数。GET は回数、POST は { seen: 操作の種類 } で 1 回足すか、{ reset: true } で全部を戻す
    if (url.pathname === '/api/hints' && (req.method === 'GET' || req.method === 'POST')) return handleHints(req, res);
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
    // 会の終わりの成果物(closing.js、K5)。GET は 7 つの成果物と未決事項、POST owner は未決事項の持ち主と期日
    const closingMatch = /^\/api\/projects\/([a-z0-9-]{1,64})\/closing(?:\/(owner))?$/.exec(url.pathname);
    if (closingMatch && (closingMatch[2] ? req.method === 'POST' : req.method === 'GET')) return handleClosing(req, res, closingMatch[1], closingMatch[2]);
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

  function sendIntentError(res, error) {
    if (error instanceof NotFoundError) return sendError(res, 404, 'not-found', error.message);
    if (error instanceof BusyError) return sendError(res, 409, 'busy', error.message);
    if (error instanceof IntentError || error instanceof MaterialError) return sendError(res, error.status, error.code, error.message);
    if (error instanceof ConsentRequiredError || error instanceof MeetingRefusedError) return sendError(res, 403, error.code, error.message, error.next);
    if (error instanceof BodyError) return sendError(res, 400, 'invalid', error.message);
    throw error;
  }

  async function handleNewMeeting(req, res) {
    try {
      const body = await readJson(req);
      const id = await meetings.create({ purpose: body?.purpose });
      return sendJson(res, 200, { project: view((await store.list()).find((p) => p.id === id)), meeting: await meetings.view(id) });
    } catch (error) {
      return sendIntentError(res, error);
    }
  }

  async function handleMeeting(req, res, id, action) {
    try {
      if (!action) return sendJson(res, 200, { meeting: await meetings.view(id) });
      const body = (await readJson(req)) ?? {};
      if (action === 'erase') return sendJson(res, 200, await meetings.erase(id, body));
      const meeting = action === 'decide' ? await meetings.decide(id, body) : await meetings.setDeleteOn(id, body);
      // 会の段ごとの時刻(timeline.js)。始めの時刻は、初めて決めた時刻
      if (action === 'decide') await timeline.mark(id, 'start', meeting.decidedAt);
      return sendJson(res, 200, { meeting, consent: consent.state() });
    } catch (error) {
      return sendIntentError(res, error);
    }
  }

  async function handleNewProject(req, res) {
    try {
      const body = await readJson(req);
      const id = await intents.createProject({ sentence: body?.sentence, guide: body?.guide });
      const project = (await store.list()).find((p) => p.id === id);
      return sendJson(res, 200, { project: view(project) });
    } catch (error) {
      return sendIntentError(res, error);
    }
  }

  async function handleIntent(req, res, id, action) {
    try {
      if (!action) return sendJson(res, 200, { intent: await intents.view(id) });
      const body = await readJson(req);
      if (action === 'cancel') return sendJson(res, 200, { cancelled: intents.cancel(id) });
      return sendJson(res, 200, { intent: await intents[action](id, body ?? {}) });
    } catch (error) {
      return sendIntentError(res, error);
    }
  }

  // 整理の板の段の時刻(timeline.js)。5 つの欄がそろったら「聞く」、決める人が押したら「AI が整理する」。
  // 押した後に初めて欄がそろったと分かったときは、聞くの時刻を押した時刻にする(聞くが整理より後にならないように)
  async function markOrganize(id) {
    const board = organizes.boards.get(id);
    if (!board) return;
    const columns = new Set(board.items.map((item) => item.column));
    const confirmedAt = board.status === 'confirmed' ? board.confirmedAt : null;
    if (Object.keys(COLUMNS).every((column) => columns.has(column))) await timeline.mark(id, 'listen', confirmedAt);
    if (confirmedAt) await timeline.mark(id, 'organize', confirmedAt);
  }

  async function handleOrganize(req, res, id, action) {
    try {
      if (!action) return sendJson(res, 200, { organize: await organizes.view(id) });
      const body = await readJson(req);
      if (action === 'cancel') return sendJson(res, 200, { cancelled: organizes.cancel(id) });
      const organize = await organizes[ORGANIZE_ACTIONS[action]](id, body ?? {});
      await markOrganize(id);
      return sendJson(res, 200, { organize });
    } catch (error) {
      return sendIntentError(res, error);
    }
  }

  async function handleMaterials(req, res, id, action) {
    try {
      if (action === 'view') return sendJson(res, 200, { materials: await materials.view(id) });
      const large = action.startsWith('guides:') || action.startsWith('packages:');
      const body = await readJson(req, large ? MAX_GUIDES_BODY_BYTES : MAX_TOKENS_BODY_BYTES);
      if (action === 'tokens:check') return sendJson(res, 200, await materials.check(id, body ?? {}));
      if (action === 'guides:check') return sendJson(res, 200, await materials.checkGuides(id, body ?? {}));
      if (action === 'packages:check') return sendJson(res, 200, await materials.checkPackage(id, body ?? {}));
      const run = {
        'tokens:connect': () => materials.connect(id, body ?? {}),
        'tokens:remove': () => materials.disconnect(id, body ?? {}),
        'guides:connect': () => materials.enableGuides(id, body ?? {}),
        'guides:remove': () => materials.disableGuides(id, body ?? {}),
        'guides:restore': () => materials.restoreGuides(id),
        'packages:connect': () => materials.enablePackage(id, body ?? {}),
        'packages:remove': () => materials.disablePackage(id, body ?? {}),
      }[action];
      const result = await run();
      const project = (await store.list()).find((p) => p.id === id);
      return sendJson(res, 200, { ...result, project: view(project) });
    } catch (error) {
      return sendIntentError(res, error);
    }
  }

  async function handleDesign(req, res, id, action) {
    try {
      if (!action) return sendJson(res, 200, { design: await designs.view(id) });
      const body = await readJson(req);
      if (action === 'cancel') return sendJson(res, 200, { cancelled: designs.cancel(id) });
      // decide は依頼の文も返す。決めたら AI 構成の審査を始める(作る AI は 4 つの承認の後。review.js)
      if (action === 'decide') {
        const decided = await designs.decide(id);
        const review = await reviews.start(id, { origin: 'design' });
        return sendJson(res, 200, { ...decided, design: await designs.view(id), review });
      }
      const method = action === 'scenes' ? 'saveScenes' : action;
      return sendJson(res, 200, { design: await designs[method](id, body ?? {}) });
    } catch (error) {
      return sendIntentError(res, error);
    }
  }

  async function handleReview(req, res, id, action) {
    try {
      if (!action) return sendJson(res, 200, { review: await reviews.view(id) });
      const body = (await readJson(req)) ?? {};
      // build と skip は依頼の文も返す
      if (action === 'build' || action === 'skip') {
        const result = await reviews[action](id, body);
        // 4 つの承認がそろい、「この構成で作る」を押した時刻(timeline.js)
        if (action === 'build' && result.review?.approvedAt) await timeline.mark(id, 'review', result.review.approvedAt);
        return sendJson(res, 200, result);
      }
      if (action === 'start') return sendJson(res, 200, { review: await reviews.start(id, { origin: 'existing' }) });
      return sendJson(res, 200, { review: await reviews[action](id, body) });
    } catch (error) {
      return sendIntentError(res, error);
    }
  }

  async function handleQuality(res, id) {
    try {
      return sendJson(res, 200, { quality: await quality.view(id) });
    } catch (error) {
      if (error instanceof NotFoundError) return sendError(res, 404, 'not-found', error.message);
      throw error;
    }
  }

  async function handleShow(req, res, id, action) {
    try {
      if (!action) return sendJson(res, 200, { show: await shows.view(id) });
      const body = (await readJson(req)) ?? {};
      if (action === 'start') return sendJson(res, 200, { show: await shows.start(id) });
      return sendJson(res, 200, await shows.answer(id, body));
    } catch (error) {
      if (error instanceof NotFoundError) return sendError(res, 404, 'not-found', error.message);
      if (error instanceof BusyError) return sendError(res, 409, 'busy', error.message);
      if (error instanceof ShowError || error instanceof VersionError) return sendError(res, error.status, error.code, error.message);
      if (error instanceof BodyError) return sendError(res, 400, 'invalid', error.message);
      throw error;
    }
  }

  async function handleComments(req, res, id, action, commentId) {
    try {
      if (req.method === 'GET') return sendJson(res, 200, { comments: await comments.view(id) });
      const body = (await readJson(req)) ?? {};
      let result;
      if (!action) {
        result = await comments.create(id, body);
        // 最初のコメントが付いた時刻(timeline.js)
        await timeline.mark(id, 'show');
      }
      else if (action === 'resume') result = await comments.resume(id);
      else if (action === 'approve') result = await comments.approve(id, commentId, body);
      else if (action === 'resolve' || action === 'revert') result = await comments[action](id, commentId, body);
      else result = await comments[action](id, commentId);
      return sendJson(res, 200, { ...(action === 'resume' ? {} : result), comments: await comments.view(id) });
    } catch (error) {
      if (error instanceof NotFoundError) return sendError(res, 404, 'not-found', error.message);
      if (error instanceof BusyError) return sendError(res, 409, 'busy', error.message);
      if (error instanceof CommentError || error instanceof VersionError || error instanceof IntentError) return sendError(res, error.status, error.code, error.message);
      if (error instanceof ConsentRequiredError || error instanceof MeetingRefusedError) return sendError(res, 403, error.code, error.message, error.next);
      if (error instanceof BodyError) return sendError(res, 400, 'invalid', error.message);
      throw error;
    }
  }

  // 場面の回し。本物の AI は、選べないときと同意の前は 403(理由のコードつき。consent-required など)で断る
  async function handleScenes(req, res, id, action) {
    try {
      if (!action) return sendJson(res, 200, { scenes: await sceneRuns.view(id) });
      const body = (await readJson(req)) ?? {};
      if (action === 'cancel') {
        await store.requireProject(id);
        sceneRuns.cancel(id);
        return sendJson(res, 200, { scenes: await sceneRuns.view(id) });
      }
      return sendJson(res, 200, { scenes: await sceneRuns.start(id, { connection: body.connection ?? 'mock', limitUsd: body.limitUsd }) });
    } catch (error) {
      if (error instanceof NotFoundError) return sendError(res, 404, 'not-found', error.message);
      if (error instanceof BusyError) return sendError(res, 409, 'busy', error.message);
      if (error instanceof BodyError) return sendError(res, 400, 'invalid', error.message);
      if (error instanceof SceneRunError) return sendError(res, error.status, error.code, error.message);
      if (error instanceof AiError) return sendError(res, error.status, error.code, error.message, error.next);
      throw error;
    }
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

  async function handleHints(req, res) {
    if (req.method === 'GET') return sendJson(res, 200, { hints: hints.state() });
    let body;
    try {
      body = await readJson(req);
    } catch (error) {
      if (error instanceof BodyError) return sendError(res, 400, 'invalid', error.message);
      throw error;
    }
    if (body?.reset === true) return sendJson(res, 200, { hints: await hints.reset() });
    if (Hints.validKind(body?.seen)) return sendJson(res, 200, { hints: await hints.seen(body.seen) });
    return sendError(res, 400, 'invalid', '{ seen: 操作の種類 } か、{ reset: true } を送ってください');
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
    // つないだトークンがあれば、作る AI に足す決まりを「詳しく」にも出す
    return sendJson(res, 200, realAi(projectId, projectId !== null ? await materials.guide(projectId) : null));
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

  async function handleClosing(req, res, id, action) {
    try {
      if (!action) return sendJson(res, 200, { closing: await closings.view(id) });
      return sendJson(res, 200, { closing: await closings.setOwner(id, (await readJson(req)) ?? {}) });
    } catch (error) {
      return sendIntentError(res, error);
    }
  }

  // 本番開発への引き継ぎ。GET は前に書いたメモと最後の書き出し、POST は書き出し
  async function handleHandoff(req, res, id) {
    try {
      if (req.method === 'GET') return sendJson(res, 200, await handoffs.view(id));
      const body = await readJson(req);
      const exported = await handoffs.export(id, body);
      // 会の終わりの時刻(timeline.js)。書き出しの中に入れた時刻と同じにする
      await timeline.mark(id, 'closing', exported?.last?.createdAt);
      return sendJson(res, 200, exported);
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
