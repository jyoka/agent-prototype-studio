import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { StepFailure } from '../observer/operations.js';
import { SCROLL_ENDS, VIEWPORT_NAMES, checkScenario } from '../observer/scenario.js';
import { observeProject, removeUnfinishedSync } from './observe-entry.js';

// 観察の道具の MCP サーバー(docs/design/harness.md の 3.1、6、S4、S5)。
// 観察器の 7 つの操作とシナリオを回すことを、決まった名前の道具として作る AI に出す。
// stdio の JSON-RPC(1 行に 1 つのメッセージ)で、initialize、tools/list、tools/call に答える。
// 観察は CLI と同じ入口(observe-entry.js の observeProject)を、作業中の app/ を一時にビルドして見るモードで呼ぶ。
// プロジェクトの場所は起動の引数でだけ受け取る。道具の引数に場所はなく、app/ に書かない。
// report とスクリーンショットは .studio/observations/<obs-id>/ に書く。プロダクト内 AI はいつもモック。
// SDK は入れない(道具の数が少なく、形が決まっているため)

export const PROTOCOL_VERSIONS = Object.freeze(['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']);
export const SERVER_INFO = Object.freeze({ name: 'prototype-studio-observe', version: '0.1.0' });

export const MCP_LIMITS = Object.freeze({
  // open の上限(ビルド、ブラウザの起動、読み込み)
  openTimeoutMs: 90_000,
  // read_page などの操作 1 回の上限。操作の中の待ちは、観察器の手順の上限(5 秒)
  callTimeoutMs: 30_000,
  // run_scenarios の観察の上限。呼び出しの上限は、これにビルドと後片付けの分を足す
  scenariosTimeoutMs: 300_000,
  // open で開いた文脈を使える時間。観察器の operate の上限で、10 分を超えられない
  sessionMs: 600_000,
  // サーバーの全体の上限。超えたら文脈とブラウザを閉じ、一時フォルダーを消して終わる
  serverMs: 30 * 60_000,
  // 終わるときに、観察が片付くのを待つ時間
  shutdownMs: 20_000,
});

// 返す画像の大きさの上限。超えたら JPEG で撮り直し、それでも超えたら画像は返さない
const MAX_IMAGE_BYTES = 1_000_000;
const JPEG_QUALITY = 60;
// 道具の結果の文の長さ。ページの文字(read_page)は観察器が先に切る(operations.js の PAGE_LIMITS)
const MAX_RESULT_TEXT = 20_000;
const MAX_LISTED_ERRORS = 20;
const MAX_ERROR_MESSAGE = 500;
// 受け取る 1 行の長さ。道具の引数は短いので、これより長いものは読まない
const MAX_LINE = 1024 * 1024;

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

// 対象の指し方は、シナリオの手順と同じ(役割と名前、ラベル、文字、領域)
const TARGET_SCHEMA = {
  type: 'object',
  description: '対象。{ "role": "button", "name": "送る" }、{ "label": "メッセージ" }、{ "text": "…" }、{ "region": "…" } のどれか 1 つ。CSS のセレクターは使えない',
  properties: {
    role: { type: 'string', description: 'ARIA の役割(button、link、textbox など)' },
    name: { type: 'string', description: '役割と一緒に使う、要素の名前' },
    label: { type: 'string', description: '入力欄などのラベル' },
    text: { type: 'string', description: '画面の文字' },
    region: { type: 'string', description: '名前の付いた領域(aria-label のある section など)' },
  },
  additionalProperties: false,
};

const objectSchema = (properties = {}, required = []) => ({ type: 'object', properties, required, additionalProperties: false });

// 道具の一覧。名前はこれで決まりで、増やさない
export const TOOLS = Object.freeze([
  {
    name: 'open',
    description:
      '作業中の app/ を一時フォルダーにビルドし、ヘッドレスのブラウザで開く。ビルドの失敗、読み込み、エラー、最初のスクリーンショットを返す。' +
      '開いた画面は、次に open を呼ぶまで、ほかの道具で読んで操作できる。app/ を直したら、もう一度 open を呼ぶ',
    inputSchema: objectSchema({ viewport: { type: 'string', enum: VIEWPORT_NAMES, description: '最初の画面幅(既定は desktop)' } }),
  },
  {
    name: 'read_page',
    description: '開いた画面の文字と、アクセシビリティの木の要約を読む。長いときは切る',
    inputSchema: objectSchema(),
  },
  {
    name: 'inspect',
    description: '要素の役割、名前、見えているか、押せるかを調べる。target がなければ、操作できる要素の一覧',
    inputSchema: objectSchema({ target: TARGET_SCHEMA }),
  },
  {
    name: 'click',
    description: '対象を押す',
    inputSchema: objectSchema({ target: TARGET_SCHEMA }, ['target']),
  },
  {
    name: 'type',
    description: '対象(入力欄)の文字を、text に入れ替える',
    inputSchema: objectSchema({ target: TARGET_SCHEMA, text: { type: 'string' } }, ['target', 'text']),
  },
  {
    name: 'scroll',
    description: '対象が見えるまでスクロールする。target がなければ、ページの端(to: top か bottom。既定は bottom)まで',
    inputSchema: objectSchema({ target: TARGET_SCHEMA, to: { type: 'string', enum: SCROLL_ENDS } }),
  },
  {
    name: 'set_viewport',
    description: '画面幅を変える(mobile 390x844、tablet 820x1180、desktop 1280x800)',
    inputSchema: objectSchema({ viewport: { type: 'string', enum: VIEWPORT_NAMES } }, ['viewport']),
  },
  {
    name: 'screenshot',
    description: '今の画面を撮って、画像で返す',
    inputSchema: objectSchema({ name: { type: 'string', description: '画面の名前(記録に残す)' } }),
  },
  {
    name: 'run_scenarios',
    description:
      '作業中の app/ を新しくビルドし、Studio の基本のシナリオと app/scenarios/ のシナリオを、関門と同じ形で回す。' +
      'シナリオごとの合否と、失敗した手順を返す。open で開いた画面とは別の、新しいブラウザで回す',
    inputSchema: objectSchema(),
  },
]);

export const TOOL_NAMES = Object.freeze(TOOLS.map((tool) => tool.name));

// 7 つの操作の道具と、シナリオの手順の対応。引数はシナリオの手順と同じ検査(scenario.js)を通す
const STEP_TOOLS = {
  read_page: { do: 'read', keys: [] },
  inspect: { do: 'inspect', keys: ['target'] },
  click: { do: 'click', keys: ['target'] },
  type: { do: 'type', keys: ['target', 'text'] },
  scroll: { do: 'scroll', keys: ['target', 'to'] },
  set_viewport: { do: 'viewport', keys: ['viewport'] },
  screenshot: { do: 'screenshot', keys: ['name'] },
};

class ToolError extends Error {}

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

// 時間内に終わらなければ timedOut を返す。元の promise は止められないので、後で失敗しても捨てる
async function within(promise, ms) {
  promise.catch(() => {});
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), ms);
  });
  try {
    return await Promise.race([promise.then((value) => ({ timedOut: false, value })), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function errorsOf(list) {
  return list.slice(0, MAX_LISTED_ERRORS).map((error) => ({
    kind: error.kind,
    message: String(error.message ?? '').slice(0, MAX_ERROR_MESSAGE),
    ...(error.file ? { file: error.file, line: error.line ?? null } : {}),
    ...(error.url ? { url: error.url, blockedBy: error.blockedBy } : {}),
  }));
}

function textContent(value) {
  let body = JSON.stringify(value, null, 2);
  if (body.length > MAX_RESULT_TEXT) body = `${body.slice(0, MAX_RESULT_TEXT)}\n…(長いので切りました)`;
  return { type: 'text', text: body };
}

// 道具の引数を、シナリオの手順の形にして検査する。誤りは作る AI が読んで直せる文で返す
function stepOf(tool, args) {
  const { do: action, keys } = STEP_TOOLS[tool];
  for (const key of Object.keys(args)) {
    if (!keys.includes(key)) throw new ToolError(`${tool} に「${key}」は渡せません${keys.length > 0 ? `。渡せる引数: ${keys.join('、')}` : ''}`);
  }
  const step = { do: action, ...args };
  if (tool === 'screenshot' && step.name === undefined) step.name = '画面';
  if (tool === 'scroll' && step.target === undefined && step.to === undefined) step.to = 'bottom';
  const checked = checkScenario({ name: tool, steps: [step] });
  if (!checked.scenario) throw new ToolError(checked.errors.map((error) => error.text.replace(/^1 番目の手順: /, '')).join(' / '));
  return checked.scenario.steps[0];
}

// 撮った画像を、上限の大きさの中で MCP の画像の内容にする
async function imageOf(file, page) {
  const png = await fs.readFile(file);
  if (png.length <= MAX_IMAGE_BYTES) return { image: { type: 'image', data: png.toString('base64'), mimeType: 'image/png' }, note: null };
  const jpeg = page ? await page.screenshot({ type: 'jpeg', quality: JPEG_QUALITY, timeout: 5_000 }).catch(() => null) : null;
  if (jpeg && jpeg.length <= MAX_IMAGE_BYTES) {
    return { image: { type: 'image', data: jpeg.toString('base64'), mimeType: 'image/jpeg' }, note: 'PNG が大きいので、JPEG で返しました' };
  }
  return { image: null, note: `画像が大きすぎるので返しません(上限 ${MAX_IMAGE_BYTES} バイト)。file を見てください` };
}

// 観察の道具。1 つのサーバーの中で、open で開いた 1 つの観察の文脈(セッション)を使い続ける
export class ObserveTools {
  constructor({ projectDir, limits = {} }) {
    if (typeof projectDir !== 'string' || projectDir === '') throw new TypeError('projectDir を渡してください');
    this.projectDir = projectDir;
    this.limits = { ...MCP_LIMITS, ...limits };
    this.session = null;
    // 終わっていない観察(開いた文脈と run_scenarios)。close() はどれも閉じて待つ。
    // 開いた文脈は、時間切れで手放したものも入る
    this.running = new Set();
    this.queue = Promise.resolve();
    this.closed = false;
  }

  // 道具の呼び出しは 1 つずつ順に回す(同じ文脈の操作が混ざらない)
  call(name, args = {}) {
    const run = this.queue.then(() => this.dispatch(name, args));
    this.queue = run.catch(() => {});
    return run;
  }

  async dispatch(name, args) {
    if (!isPlainObject(args)) return this.failure('引数はオブジェクトで渡してください');
    if (this.closed) return this.failure('観察の道具のサーバーは終わるところです');
    try {
      if (name === 'open') return await this.open(args);
      if (name === 'run_scenarios') return await this.runScenarios(args);
      return await this.operate(name, args);
    } catch (error) {
      if (error instanceof ToolError || error instanceof StepFailure) return this.failure(error.message);
      return this.failure(`道具の途中で問題が起きました: ${String(error?.message ?? error).slice(0, 300)}`);
    }
  }

  failure(message) {
    return { content: [{ type: 'text', text: message }], isError: true };
  }

  // 作業中の app/ を一時にビルドして開く。前に開いた文脈は閉じる(report を書く)
  async open(args) {
    for (const key of Object.keys(args)) if (key !== 'viewport') throw new ToolError(`open に「${key}」は渡せません。渡せる引数: viewport`);
    const viewport = args.viewport ?? 'desktop';
    if (!VIEWPORT_NAMES.includes(viewport)) throw new ToolError(`viewport の値が違います: ${JSON.stringify(viewport)}(${VIEWPORT_NAMES.join('、')} から選ぶ)`);
    await this.closeSession();
    // 前の文脈を閉じている間に、サーバーが終わり始めたかもしれない
    if (this.closed) throw new ToolError('観察の道具のサーバーは終わるところです');

    const ready = deferred();
    const session = { ops: null, end: deferred(), finished: null, ended: false, seen: 0 };
    // 観察器は operate が返るまで文脈を開いたままにする。end を解くと、最後の画面を読んで report を書く
    session.finished = observeProject({
      projectDir: this.projectDir,
      mode: 'working',
      scenarios: [],
      base: false,
      viewports: [viewport],
      aiConnection: 'mock',
      limits: { scenarioTimeoutMs: this.limits.sessionMs },
      operate: (ops) => {
        session.ops = ops;
        ready.resolve();
        return session.end.promise;
      },
    });
    const running = { end: session.end, work: session.finished };
    this.running.add(running);
    session.finished
      .catch(() => {})
      .finally(() => {
        session.ended = true;
        this.running.delete(running);
      });
    this.session = session;

    let opened;
    try {
      opened = await within(Promise.race([ready.promise.then(() => null), session.finished]), this.limits.openTimeoutMs);
    } catch (error) {
      // .studio/ に書けないときなど。観察しなかった
      this.session = null;
      throw error;
    }
    if (opened.timedOut) {
      await this.closeSession();
      throw new ToolError(`${Math.round(this.limits.openTimeoutMs / 1000)} 秒で開けませんでした。ビルドか読み込みが終わりません`);
    }
    if (opened.value) {
      // 開く前に観察が終わった: ビルドの失敗、読み込みの時間切れ、ブラウザがない、など
      this.session = null;
      const { report, reportFile } = opened.value;
      return {
        content: [
          textContent({
            opened: false,
            verdict: report.verdict,
            reason: report.reason,
            errors: errorsOf(report.errors),
            report: reportFile,
          }),
        ],
      };
    }
    const { ops } = session;
    const errors = ops.errors();
    session.seen = errors.length;
    const file = path.join(ops.outDir, `${viewport}.png`);
    const shot = await imageOf(file, ops.page);
    return {
      content: [
        textContent({
          opened: true,
          load: 'done',
          viewport,
          errors: errorsOf(errors),
          screenshot: file,
          ...(shot.note ? { note: shot.note } : {}),
        }),
        ...(shot.image ? [shot.image] : []),
      ],
    };
  }

  // 7 つの操作。観察器のシナリオの手順と同じ関数(Operations.step)を呼ぶ
  async operate(name, args) {
    if (!Object.hasOwn(STEP_TOOLS, name)) throw new ToolError(`知らない道具です: ${name}`);
    const step = stepOf(name, args);
    const session = this.session;
    if (!session) throw new ToolError('まだ開いていません。先に open を呼んでください');
    if (session.ended) {
      this.session = null;
      throw new ToolError(`開いた画面はもう閉じています(使えるのは開いてから ${Math.round(this.limits.sessionMs / 60_000)} 分まで)。open で開き直してください`);
    }
    const { ops } = session;
    const done = await within(ops.step(step), this.limits.callTimeoutMs);
    if (done.timedOut) {
      // 試作品が止まっている。文脈ごと閉じる
      await this.closeSession();
      throw new ToolError(`${Math.round(this.limits.callTimeoutMs / 1000)} 秒で終わりませんでした。試作品が応答していません。app/ を直して open で開き直してください`);
    }
    const result = done.value ?? null;
    // この呼び出しの間に出たエラー(実行時、console.error、断った要求)
    const errors = ops.errors();
    const newErrors = errorsOf(errors.slice(session.seen));
    session.seen = errors.length;
    if (name !== 'screenshot') return { content: [textContent({ ...result, newErrors })] };
    const shot = await imageOf(result.file, ops.page);
    return {
      content: [
        textContent({ ...result, newErrors, ...(shot.note ? { note: shot.note } : {}) }),
        ...(shot.image ? [shot.image] : []),
      ],
    };
  }

  // 基本のシナリオと app/scenarios/ を、新しいビルドと新しいブラウザで回す。開いた文脈はそのまま
  async runScenarios(args) {
    if (Object.keys(args).length > 0) throw new ToolError('run_scenarios は引数を取りません');
    const work = observeProject({
      projectDir: this.projectDir,
      mode: 'working',
      viewports: [],
      aiConnection: 'mock',
      limits: { observeTimeoutMs: this.limits.scenariosTimeoutMs },
    });
    const running = { end: null, work };
    this.running.add(running);
    work.catch(() => {}).finally(() => this.running.delete(running));
    const done = await within(work, this.limits.scenariosTimeoutMs + this.limits.openTimeoutMs);
    if (done.timedOut) throw new ToolError('シナリオが時間内に終わりませんでした');
    const { report, reportFile } = done.value;
    const scenarios = report.scenarios.map((scenario) => ({
      name: scenario.name,
      base: scenario.base,
      file: scenario.file,
      verdict: scenario.verdict,
      ...(scenario.failed ? { failed: { step: scenario.failed.step, message: scenario.failed.message, pageText: scenario.failed.pageText } } : {}),
    }));
    // 最初に失敗したシナリオの、そのときの画面を 1 枚だけ返す
    const failedShot = report.scenarios.find((scenario) => scenario.failed?.screenshot)?.failed.screenshot;
    const shot = failedShot ? await imageOf(failedShot.file, null).catch(() => ({ image: null, note: null })) : { image: null, note: null };
    return {
      content: [
        textContent({
          verdict: report.verdict,
          reason: report.reason,
          errors: errorsOf(report.errors),
          scenarios,
          report: reportFile,
          ...(shot.note ? { note: shot.note } : {}),
        }),
        ...(shot.image ? [shot.image] : []),
      ],
    };
  }

  // 開いた文脈を閉じる。観察器は最後の画面を読み、report を書き、ブラウザと一時フォルダーを片付ける
  async closeSession() {
    const session = this.session;
    this.session = null;
    if (!session) return;
    session.end.resolve();
    await within(session.finished, this.limits.shutdownMs);
  }

  // サーバーを終える。片付けが終わらなければ、一時フォルダーと report のない観察のフォルダーを消す
  async close() {
    if (this.closed) return;
    this.closed = true;
    this.session = null;
    for (const { end } of this.running) end?.resolve();
    const waits = await Promise.all([...this.running].map(({ work }) => within(work, this.limits.shutdownMs).catch(() => ({ timedOut: false }))));
    if (waits.some((wait) => wait.timedOut)) removeUnfinishedSync();
  }
}

// JSON-RPC の 1 つのメッセージに答える。通知(id がない)には何も返さない(null)
export async function handleMessage(tools, message) {
  const reply = (result) => ({ jsonrpc: '2.0', id: message.id, result });
  const fail = (code, text) => ({ jsonrpc: '2.0', id: message?.id ?? null, error: { code, message: text } });
  if (!isPlainObject(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
    return fail(-32600, '要求の形が正しくありません');
  }
  const isRequest = Object.hasOwn(message, 'id') && (typeof message.id === 'string' || Number.isSafeInteger(message.id));
  if (!isRequest) return null;
  const params = message.params ?? {};
  if (!isPlainObject(params)) return fail(-32602, 'params はオブジェクトで渡してください');
  switch (message.method) {
    case 'initialize': {
      const asked = params.protocolVersion;
      return reply({
        protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { ...SERVER_INFO },
        instructions:
          '試作品(作業中の app/)を観察する道具です。open で開き、read_page、inspect、click、type、scroll、set_viewport、screenshot で読んで操作します。' +
          'run_scenarios でシナリオを回します。道具は app/ を書き換えません',
      });
    }
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools: structuredClone(TOOLS) });
    case 'tools/call': {
      if (typeof params.name !== 'string' || !TOOL_NAMES.includes(params.name)) return fail(-32602, `知らない道具です: ${params.name}`);
      return reply(await tools.call(params.name, params.arguments ?? {}));
    }
    default:
      return fail(-32601, `知らないメソッドです: ${message.method}`);
  }
}

// stdio で MCP サーバーを動かす。input が閉じるか、全体の上限を超えるか、stop() を呼ぶと、片付けて終わる。
// 返す done は、片付けが終わると reason(end、timeout、stop)で解ける
export function serveObserveMcp({ projectDir, input, output, limits = {}, log = () => {} }) {
  const tools = new ObserveTools({ projectDir, limits });
  // 相手が先に終わると、書き込みが EPIPE で失敗する。そのときは入力が閉じたのと同じに片付けて終わる
  let broken = false;
  const write = (message) => {
    if (!broken && !output.destroyed) output.write(`${JSON.stringify(message)}\n`);
  };
  const pending = new Set();
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  lines.on('line', (line) => {
    if (line.trim() === '') return;
    if (line.length > MAX_LINE) {
      write({ jsonrpc: '2.0', id: null, error: { code: -32600, message: '要求が長すぎます' } });
      return;
    }
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'JSON として読めません' } });
      return;
    }
    const work = handleMessage(tools, message).then(
      (response) => response && write(response),
      (error) => write({ jsonrpc: '2.0', id: message?.id ?? null, error: { code: -32603, message: String(error?.message ?? error).slice(0, 300) } }),
    );
    pending.add(work);
    work.finally(() => pending.delete(work));
  });

  const done = deferred();
  let finishing = null;
  const finish = (reason) => {
    finishing ??= (async () => {
      clearTimeout(timer);
      lines.close();
      await tools.close();
      // 終わる前に受けた要求には、答えを書いてから終わる
      await within(Promise.allSettled([...pending]), 1_000);
      done.resolve(reason);
      return reason;
    })();
    return finishing;
  };
  const maxMs = tools.limits.serverMs;
  const timer = setTimeout(() => {
    log(`観察の道具のサーバーを、時間の上限(${Math.round(maxMs / 1000)} 秒)で止めます`);
    finish('timeout');
  }, maxMs);
  input.once('end', () => finish('end'));
  input.once('close', () => finish('end'));
  input.on('error', () => finish('end'));
  output.on('error', () => {
    broken = true;
    finish('end');
  });
  return { tools, done: done.promise, stop: () => finish('stop') };
}
