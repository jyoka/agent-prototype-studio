#!/usr/bin/env node
// 決定的な偽接続。`claude -p --output-format stream-json` と同じ形の行を出す。
// モデルも外部の API も呼ばない。依頼の文の言葉で、決まった動きをする(fake-examples.js)。
// Studio が組み立てた引数をそのまま受け取り、ADR-0001 と ADR-0002 の守りが入っていなければ失敗する。
// 「画面で確かめて」があれば、--mcp-config の観察の道具のサーバーを起動し、open と read_page を 1 回ずつ呼ぶ。
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { AGENT_TOOLS, ALLOWED_TOOLS, OBSERVE_SERVER, OBSERVE_TOOLS } from '../server/claude-args.js';
import { readFixPrompt } from '../server/fix-prompt.js';

const STEP_MS = 120;
const SLOW_STEPS = 60;
const SLOW_STEP_MS = 500;
const BROKEN_LINE = 'const studioBroken = ; // 偽接続が「壊して」で入れた行\n';
// 直す依頼を受けても直せなかったときに残す跡。app/ は変わるが、壊れたまま
const tryMark = (n) => `// 偽接続が直そうとした跡(${n} 回目)\n`;
const TRY_MARKS = /\/\/ 偽接続が直そうとした跡\(\d+ 回目\)\n/g;
// 「見出しを崩して」で、見出しの文字の間に入れる印。消すと元の見出しに戻る
const SCRAMBLE = '〓';
// 「シナリオを足して」で書くシナリオ。題材の言葉は持たず、今の見出しの文字を確かめる
const HEADING_SCENARIO = 'heading.json';
const HEADING_PATTERN = /(<h1(?:\s[^>]*)?>)([^<{]*)(<\/h1>)/;
const SESSION_ID = '00000000-0000-4000-8000-000000000000';
// 観察の道具のサーバーとのやりとりの上限。open はビルドとブラウザの起動を含む(サーバーの上限は 90 秒)
const MCP_TIMEOUTS = { setupMs: 15_000, callMs: 120_000, closeMs: 30_000 };
const started = Date.now();
let turns = 0;
let toolSeq = 0;
// 引数で渡された MCP の設定のファイル(checkArgs で確かめる)
let mcpConfigFile = null;
// 「画面で確かめて」があれば、見出しを変えた後に観察の道具で確かめる
let observeAfterEdit = false;

function emit(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function finish({ isError = false, subtype = isError ? 'error_during_execution' : 'success', text = '', denials = [] }) {
  emit({
    type: 'result',
    subtype,
    is_error: isError,
    result: text,
    session_id: SESSION_ID,
    num_turns: turns,
    duration_ms: Date.now() - started,
    total_cost_usd: 0,
    permission_denials: denials,
  });
  process.exitCode = isError ? 1 : 0;
}

// 守りの引数がそろっているか。--safe-mode は --mcp-config のサーバーを外すので、代わりの引数を見る(ADR-0002)
async function checkArgs(argv) {
  const problems = [];
  const has = (flag) => argv.includes(flag);
  const value = (flag) => (has(flag) ? argv[argv.indexOf(flag) + 1] : undefined);
  for (const flag of ['-p', '--restricted', '--disable-slash-commands', '--strict-mcp-config', '--no-session-persistence', '--verbose']) {
    if (!has(flag)) problems.push(`${flag} がありません`);
  }
  const expected = {
    '--setting-sources': '',
    '--permission-mode': 'dontAsk',
    '--permission-prompts': 'none',
    '--output-format': 'stream-json',
    '--tools': AGENT_TOOLS,
    '--allowedTools': ALLOWED_TOOLS,
  };
  for (const [flag, want] of Object.entries(expected)) {
    if (value(flag) !== want) problems.push(`${flag} が ${JSON.stringify(want)} ではありません`);
  }
  for (const banned of ['--dangerously-skip-permissions', '--add-dir', 'bypassPermissions']) {
    if (has(banned)) problems.push(`${banned} は渡してはいけません`);
  }
  if (has('--safe-mode')) problems.push('--safe-mode があると、--mcp-config の観察の道具が外れます');
  if (argv.filter((arg) => arg === '--mcp-config').length !== 1) return [...problems, '--mcp-config がちょうど 1 つではありません'];
  // MCP の設定は app/ の外に置き、観察の道具のサーバーだけを持つ(S10、S13)
  const file = path.resolve(value('--mcp-config') ?? '');
  if (insideCwd(file)) problems.push('--mcp-config のファイルが作業ディレクトリ(app/)の中にあります');
  const config = await fs.readFile(file, 'utf8').then(JSON.parse).catch(() => null);
  const names = Object.keys(config?.mcpServers ?? {});
  if (names.length !== 1 || names[0] !== OBSERVE_SERVER) problems.push(`--mcp-config のサーバーが ${OBSERVE_SERVER} だけではありません`);
  else mcpConfigFile = file;
  return problems;
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function assistant(content) {
  await sleep(STEP_MS);
  turns += 1;
  emit({ type: 'assistant', session_id: SESSION_ID, message: { role: 'assistant', content } });
}

async function say(text) {
  await assistant([{ type: 'text', text }]);
}

async function useTool(name, input, { result, isError = false }) {
  toolSeq += 1;
  const id = `toolu_fake_${toolSeq}`;
  await assistant([{ type: 'tool_use', id, name, input }]);
  emit({
    type: 'user',
    session_id: SESSION_ID,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: result, is_error: isError }] },
  });
  return id;
}

// 作業ディレクトリの外には書かない(Claude Code の --restricted と同じ閉じ込め)
function insideCwd(file) {
  const relative = path.relative(process.cwd(), file);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

async function findHeadingFile() {
  const found = [];
  async function walk(dir) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') await walk(full);
      else if (entry.isFile() && /\.(jsx|tsx|js|ts)$/.test(entry.name)) found.push(full);
    }
  }
  await walk(process.cwd());
  for (const file of found) {
    const text = await fs.readFile(file, 'utf8');
    if (/<h1(\s[^>]*)?>[^<{]*<\/h1>/.test(text) || text.includes(BROKEN_LINE)) return { file, text };
  }
  return null;
}

// next: 書き込む中身。Edit の表示(oldString → newString)と違うときだけ渡す
async function editFile(target, oldString, newString, next = target.text.replace(oldString, () => newString)) {
  if (!insideCwd(target.file)) throw new Error('作業ディレクトリの外です');
  await useTool('Read', { file_path: target.file }, { result: `${target.text.split('\n').length} 行を読みました` });
  await fs.writeFile(target.file, next);
  await useTool(
    'Edit',
    { file_path: target.file, old_string: oldString, new_string: newString },
    { result: `The file ${target.file} has been updated.` },
  );
}

async function changeHeading(request) {
  const wanted = /「([^」]{1,40})」/.exec(request)?.[1];
  if (!wanted) {
    await say('新しい見出しを「」で囲んで書いてください。例: 見出しを「ひだまり図書室」にして');
    return finish({ text: '見出しは変えていません' });
  }
  const target = await findHeadingFile();
  const match = target && /(<h1(?:\s[^>]*)?>)([^<{]*)(<\/h1>)/.exec(target.text);
  if (!match) {
    await say('app/ の中に見出し(<h1>)が見つかりませんでした。');
    return finish({ text: '見出しが見つかりませんでした' });
  }
  const safe = wanted.replace(/[<>{}&]/g, '');
  await editFile(target, match[0], `${match[1]}${safe}${match[3]}`);
  let text = `見出しを「${safe}」に変えました(${path.relative(process.cwd(), target.file)})。`;
  if (observeAfterEdit) text += `観察の道具で確かめると、${(await observeScreen()).text}。`;
  await say(text);
  return finish({ text });
}

// 観察の道具のサーバー(--mcp-config の observe)を起動し、MCP の JSON-RPC で呼ぶ。終わったら入力を閉じ、上限つきで終わりを待つ
async function connectObserve() {
  const config = JSON.parse(await fs.readFile(mcpConfigFile, 'utf8'));
  const server = config.mcpServers[OBSERVE_SERVER];
  const child = spawn(server.command, server.args ?? [], { stdio: ['pipe', 'pipe', 'ignore'], env: { ...process.env, ...(server.env ?? {}) } });
  // 起動できなかったとき(error)も、終わったとして扱う
  const exited = new Promise((resolve) => {
    child.once('exit', resolve);
    child.once('error', resolve);
  });
  const pending = new Map();
  let seq = 0;
  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    pending.get(message.id)?.(message);
  });
  const settleAll = () => {
    for (const settle of pending.values()) settle({ error: { message: '観察の道具のサーバーが終わりました' } });
  };
  child.once('exit', settleAll);
  child.once('error', settleAll);
  child.stdin.on('error', () => {});
  const send = (message) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  const request = (method, params, timeoutMs) =>
    new Promise((resolve) => {
      const id = (seq += 1);
      const timer = setTimeout(() => settle({ error: { message: `${method} が ${timeoutMs / 1000} 秒で終わりませんでした` } }), timeoutMs);
      function settle(message) {
        clearTimeout(timer);
        pending.delete(id);
        resolve(message);
      }
      pending.set(id, settle);
      send({ id, method, params });
    });
  const close = async () => {
    child.stdin.end();
    const timer = setTimeout(() => child.kill('SIGKILL'), MCP_TIMEOUTS.closeMs);
    await exited;
    clearTimeout(timer);
  };
  const init = await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fake-claude', version: '0' } }, MCP_TIMEOUTS.setupMs);
  if (init.error) {
    await close();
    throw new Error(init.error.message);
  }
  send({ method: 'notifications/initialized' });
  return { request, close };
}

// 道具を 1 回呼び、stream-json の道具の項目(tool_use と tool_result)として出す。画像は出さず、文字だけを返す
async function callObserveTool(client, name, args = {}) {
  toolSeq += 1;
  const id = `toolu_fake_${toolSeq}`;
  await assistant([{ type: 'tool_use', id, name: `mcp__${OBSERVE_SERVER}__${name}`, input: args }]);
  const reply = await client.request('tools/call', { name, arguments: args }, MCP_TIMEOUTS.callMs);
  const text = reply.error ? reply.error.message : (reply.result?.content ?? []).filter((part) => part.type === 'text').map((part) => part.text).join('\n');
  const isError = Boolean(reply.error || reply.result?.isError);
  emit({ type: 'user', session_id: SESSION_ID, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text, is_error: isError }] } });
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // 誤りの文
  }
  return { isError, text, json };
}

// open と read_page を 1 回ずつ呼び、画面の見出し(アクセシビリティの木の level=1)を返す
async function observeScreen() {
  let client;
  try {
    client = await connectObserve();
  } catch (error) {
    return { ok: false, text: `観察の道具を使えませんでした(${error.message})` };
  }
  try {
    const opened = await callObserveTool(client, 'open');
    if (opened.isError || opened.json?.opened !== true) return { ok: false, text: '観察の道具で開けませんでした' };
    const page = await callObserveTool(client, 'read_page');
    if (page.isError) return { ok: false, text: '観察の道具で画面を読めませんでした' };
    const heading = /heading "([^"]*)" \[level=1\]/.exec(page.json?.tree ?? '')?.[1] ?? null;
    return { ok: true, heading, text: heading ? `画面の見出しは「${heading}」でした` : '画面に見出しが見つかりませんでした' };
  } finally {
    await client.close();
  }
}

// 「画面で確かめて」だけの依頼。ファイルは変えずに、観察の道具で画面を読む
async function observeOnly() {
  const seen = await observeScreen();
  const text = `観察の道具で画面を確かめました。${seen.text}。ファイルは変えていません。`;
  await say(text);
  return finish({ text });
}

async function writeOutside() {
  const target = path.resolve(process.cwd(), '..', 'outside-note.txt');
  const id = await useTool(
    'Write',
    { file_path: target, content: '架空のメモ' },
    { result: `偽接続: 作業ディレクトリの外(${target})への書き込みは許可されていません。`, isError: true },
  );
  const text = 'app/ の外には書けませんでした。権限の設定で断られました。';
  await say(text);
  return finish({ text, denials: [{ tool_name: 'Write', tool_use_id: id, tool_input: { file_path: target } }] });
}

async function breakApp() {
  const target = await findHeadingFile();
  if (!target) {
    await say('壊す先のファイルが見つかりませんでした。');
    return finish({ text: '変えていません' });
  }
  if (target.text.includes(BROKEN_LINE)) {
    await say('もう壊れています。「直して」で元に戻せます。');
    return finish({ text: '変えていません' });
  }
  const firstLine = target.text.split('\n')[0] + '\n';
  await editFile(target, firstLine, firstLine + BROKEN_LINE);
  const text = `${path.relative(process.cwd(), target.file)} に、ビルドに失敗する行を入れました。`;
  await say(text);
  return finish({ text });
}

// 目録(prototype.json)が指すシナリオの置き場所。読めなければ既定の scenarios
async function scenarioFolder() {
  const manifest = await fs.readFile(path.join(process.cwd(), 'prototype.json'), 'utf8').then(JSON.parse).catch(() => null);
  const folder = typeof manifest?.scenarios === 'string' ? manifest.scenarios.replace(/\/$/, '') : 'scenarios';
  return path.join(process.cwd(), ...folder.split('/'), HEADING_SCENARIO);
}

async function writeScenario(file, scenario) {
  if (!insideCwd(file)) throw new Error('作業ディレクトリの外です');
  const content = `${JSON.stringify(scenario, null, 2)}\n`;
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content);
  await useTool('Write', { file_path: file, content }, { result: `File created successfully at: ${file}` });
}

// 見出しを確かめるシナリオを足し、見出しの文字を崩す。関門 G6 のシナリオで失敗する
async function addScenarioAndScramble() {
  const target = await findHeadingFile();
  const match = target && HEADING_PATTERN.exec(target.text);
  const heading = match?.[2].trim();
  if (!heading) {
    await say('app/ の中に、文字のある見出し(<h1>)が見つかりませんでした。');
    return finish({ text: '変えていません' });
  }
  if (heading.includes(SCRAMBLE)) {
    await say('見出しはもう崩れています。');
    return finish({ text: '変えていません' });
  }
  const file = await scenarioFolder();
  await writeScenario(file, { name: '見出しが出る', viewport: 'desktop', steps: [{ expect: 'visible', target: { role: 'heading', name: heading } }] });
  await editFile(target, match[0], `${match[1]}${[...heading].join(SCRAMBLE)}${match[3]}`);
  const text = `見出しを確かめるシナリオ(${path.relative(process.cwd(), file)})を足し、見出しの文字を崩しました。`;
  await say(text);
  return finish({ text });
}

// シナリオの失敗を受けて直す。既定は、崩した見出しを元に戻す。
// 元の依頼に「弱めて」があれば、見出しは戻さずに、シナリオの確かめを弱めて通す(Studio が「確かめ方が変わりました」と出す)
async function fixScrambled(target, fix) {
  const match = HEADING_PATTERN.exec(target.text);
  if (/弱めて/.test(fix.request)) {
    const file = await scenarioFolder();
    await writeScenario(file, { name: '見出しが出る', viewport: 'desktop', steps: [{ expect: 'visible' }] });
    const text = `シナリオ(${path.relative(process.cwd(), file)})の確かめを弱めました。見出しは崩れたままです。`;
    await say(text);
    return finish({ text });
  }
  await editFile(target, match[0], `${match[1]}${match[2].split(SCRAMBLE).join('')}${match[3]}`);
  const text = `崩れていた見出しを元に戻しました(${path.relative(process.cwd(), target.file)})。`;
  await say(text);
  return finish({ text });
}

async function repairApp() {
  const target = await findHeadingFile();
  if (!target?.text.includes(BROKEN_LINE)) {
    await say('直すところはありませんでした。');
    return finish({ text: '変えていません' });
  }
  await editFile(target, BROKEN_LINE, '', target.text.replace(BROKEN_LINE, '').replace(TRY_MARKS, ''));
  const text = '「壊して」で入れた行を消しました。';
  await say(text);
  return finish({ text });
}

// Studio の直す依頼(src/server/fix-prompt.js の型)を受けたとき。題材の言葉は持たない。
// 見出しが崩れていれば(「シナリオを足して、見出しを崩して」の後)、fixScrambled で直す。
// それ以外は、元の依頼の言葉で振る舞いを決める:
//   既定: 失敗の原因(「壊して」で入れた行)を消して直す
//   「直せない」: 直そうとした跡を残すが、壊れたまま(app/ は変わる)
//   「2 回目で直」: 1 回目の直す依頼では直せず、2 回目で直す
// 直すところが見つからなければ、何も変えない
async function fixRequested(fix) {
  await say(`Studio の直す依頼を読みました(失敗した関門: ${fix.gate})。`);
  const target = await findHeadingFile();
  if (target && HEADING_PATTERN.exec(target.text)?.[2].includes(SCRAMBLE)) return fixScrambled(target, fix);
  if (!target?.text.includes(BROKEN_LINE)) {
    await say('失敗の原因が見つからなかったので、何も変えていません。');
    return finish({ text: '変えていません' });
  }
  const tries = target.text.match(TRY_MARKS)?.length ?? 0;
  if (/直せない/.test(fix.request) || (/2 回目で直/.test(fix.request) && tries === 0)) {
    await editFile(target, BROKEN_LINE, BROKEN_LINE + tryMark(tries + 1));
    const text = `直そうとしましたが、直せませんでした(${tries + 1} 回目)。`;
    await say(text);
    return finish({ text });
  }
  await editFile(target, BROKEN_LINE, '', target.text.replace(BROKEN_LINE, '').replace(TRY_MARKS, ''));
  const text = `失敗の原因だった行を消しました(${path.relative(process.cwd(), target.file)})。`;
  await say(text);
  return finish({ text });
}

// プロダクト内 AI の設定(app/ai.json)。作る AI が変えるのは設定のファイルで、応答するのはプロダクト内 AI
async function readAiFile() {
  const file = path.join(process.cwd(), 'ai.json');
  // シンボリックリンクの先(app/ の外かもしれない)には書かない
  const stat = await fs.lstat(file).catch(() => null);
  const text = stat?.isFile() ? await fs.readFile(file, 'utf8').catch(() => null) : null;
  if (stat && !stat.isFile()) return { problem: 'app/ai.json がふつうのファイルではないので、変えずにおきます。' };
  if (text === null) return { problem: 'この試作品には app/ai.json がないので、プロダクト内 AI の振る舞いは変えられません。AI を使う試作品(例: サンプル: 架空の求人相談、サンプル: 架空の学習相談)を選んでください。' };
  try {
    const json = JSON.parse(text);
    if (json && typeof json === 'object' && Array.isArray(json.fields)) return { file, text, json };
  } catch {
    // 下で同じく扱う
  }
  return { problem: 'app/ai.json が読めない形なので、変えずにおきます。詳細の欄のビルドの結果を見てください。' };
}

async function writeAiFile(target, json) {
  if (!insideCwd(target.file)) throw new Error('作業ディレクトリの外です');
  await useTool('Read', { file_path: target.file }, { result: `${target.text.split('\n').length} 行を読みました` });
  const content = `${JSON.stringify(json, null, 2)}\n`;
  await fs.writeFile(target.file, content);
  await useTool('Write', { file_path: target.file, content }, { result: `File created successfully at: ${target.file}` });
}

// 実モデル向けの指示にも、同じ振る舞いを書き足す(モックは指示を読まない)
function addInstruction(json, sentence) {
  const current = typeof json.instructions === 'string' ? json.instructions.trimEnd() : '';
  if (current.includes(sentence)) return;
  json.instructions = current ? `${current}\n${sentence}` : sentence;
}

async function askFirst(request) {
  const target = await readAiFile();
  if (target.problem) {
    await say(target.problem);
    return finish({ text: '変えていません' });
  }
  const labels = target.json.fields.map((field) => field?.label).filter((label) => typeof label === 'string');
  // 「」で囲んだ名前か、囲まずに書いた項目の名前(画面の依頼の例「時給の下限を先に聞くようにして」の形)
  const wanted = /「([^」]{1,40})」/.exec(request)?.[1] ?? labels.find((label) => request.includes(`${label}を先に聞`));
  if (!wanted) {
    await say(`先に聞く項目の名前を「」で囲んで書いてください。項目: ${labels.join('、')}`);
    return finish({ text: '変えていません' });
  }
  const at = target.json.fields.findIndex((field) => field?.label === wanted || field?.key === wanted);
  if (at === -1) {
    await say(`「${wanted}」という項目は app/ai.json にありません。項目: ${labels.join('、')}`);
    return finish({ text: '変えていません' });
  }
  const field = target.json.fields[at];
  if (at === 0) {
    await say(`「${field.label}」は、もう最初に聞くようになっています。`);
    return finish({ text: '変えていません' });
  }
  target.json.fields.splice(at, 1);
  target.json.fields.unshift(field);
  addInstruction(target.json, `足りない項目は、「${field.label}」から先に聞いてください。`);
  await writeAiFile(target, target.json);
  const text = `プロダクト内 AI が「${field.label}」を先に聞くように、app/ai.json の項目の並びと指示を変えました。`;
  await say(text);
  return finish({ text });
}

async function clarifyWithExamples() {
  const target = await readAiFile();
  if (target.problem) {
    await say(target.problem);
    return finish({ text: '変えていません' });
  }
  const { json } = target;
  // 例は、設定の選択肢から作る(題材に依存しない)
  const examples = json.fields
    .filter((field) => Array.isArray(field?.options) && typeof field.options[0]?.value === 'string')
    .slice(0, 3)
    .map((field) => `「${field.options[0].value}」`)
    .join('');
  const reply = examples
    ? `すみません、うまく読み取れませんでした。たとえば${examples}のように、短く教えてください。`
    : 'すみません、うまく読み取れませんでした。もう少し短く、言い換えて教えてください。';
  const mock = json.mock && typeof json.mock === 'object' && !Array.isArray(json.mock) ? json.mock : {};
  if (mock.notUnderstood === reply) {
    await say('もう、例を出して聞き返すようになっています。');
    return finish({ text: '変えていません' });
  }
  json.mock = { ...mock, notUnderstood: reply };
  addInstruction(json, '読み取れなかったときは、選べる値の例を挙げて聞き返してください。');
  await writeAiFile(target, json);
  const text = 'プロダクト内 AI が読み取れなかったときに例を出して聞き返すように、app/ai.json のモックの返事と指示を変えました。';
  await say(text);
  return finish({ text });
}

async function slow() {
  // 作業中の表示(操作の短い文)を見られるよう、先に 1 回だけ道具を使う
  await useTool('Glob', { pattern: '**/*' }, { result: 'ファイルを探しました' });
  for (let step = 1; step <= SLOW_STEPS; step += 1) {
    await sleep(SLOW_STEP_MS);
    emit({ type: 'assistant', session_id: SESSION_ID, message: { role: 'assistant', content: [{ type: 'text', text: `少しずつ進めています(${step}/${SLOW_STEPS})` }] } });
  }
  return finish({ text: 'ゆっくり終わりました。何も変えていません。' });
}

async function main() {
  // Claude Code は SIGINT で止まる。偽接続も同じく、すぐ終わる
  process.on('SIGINT', () => process.exit(130));
  process.on('SIGTERM', () => process.exit(143));

  const argv = process.argv.slice(2);
  const problems = await checkArgs(argv);
  const request = (await readStdin()).trim();
  // 実機の init と同じ項目。偽接続は利用者の設定を読まないので、MCP は渡された観察の道具だけで、ほかは空
  emit({
    type: 'system',
    subtype: 'init',
    session_id: SESSION_ID,
    cwd: process.cwd(),
    model: 'fake',
    permissionMode: argv[argv.indexOf('--permission-mode') + 1],
    tools: [...AGENT_TOOLS.split(','), ...(mcpConfigFile ? OBSERVE_TOOLS : [])],
    mcp_servers: mcpConfigFile ? [{ name: OBSERVE_SERVER, status: 'connected' }] : [],
    slash_commands: [],
    skills: [],
    agents: [],
    plugins: [],
    // 値は読まない。有無だけ
    apiKeySource: process.env.ANTHROPIC_API_KEY ? 'ANTHROPIC_API_KEY' : 'none',
  });
  if (problems.length > 0) {
    return finish({ isError: true, text: `偽接続: Studio の起動引数が ADR-0001 と違います: ${problems.join('、')}` });
  }
  if (!request) return finish({ isError: true, text: 'Error: Input must be provided either through stdin or as a prompt argument when using --print' });
  if (path.basename(process.cwd()) !== 'app') {
    return finish({ isError: true, text: `偽接続: 作業ディレクトリが app/ ではありません(${process.cwd()})` });
  }

  // 直す依頼は元の依頼の文を含むので、ほかの言葉より先に見る
  const fix = readFixPrompt(request);
  if (fix) return fixRequested(fix);
  // 偽接続は CLAUDE.md などの指示ファイルを読まない(実機の確かめ scripts/check-claude-code.js で使う)
  if (/指示ファイル/.test(request)) {
    await say('指示ファイルなし');
    return finish({ text: '指示ファイルなし' });
  }
  observeAfterEdit = /画面で確かめ/.test(request);
  if (observeAfterEdit && !/見出し/.test(request)) return observeOnly();
  if (/ログイン/.test(request)) {
    return finish({ isError: true, text: 'Not logged in · Please run /login' });
  }
  if (/失敗/.test(request)) {
    await say('依頼を読みました。これから失敗します。');
    return finish({ isError: true, text: '偽接続: 依頼どおりに失敗しました' });
  }
  if (/外/.test(request)) return writeOutside();
  if (/シナリオ/.test(request)) return addScenarioAndScramble();
  if (/ゆっくり/.test(request)) return slow();
  if (/先に聞/.test(request)) return askFirst(request);
  if (/聞き返/.test(request)) return clarifyWithExamples();
  if (/壊/.test(request)) return breakApp();
  if (/直/.test(request)) return repairApp();
  if (/見出し/.test(request)) return changeHeading(request);

  const text = '偽接続なので、決まった依頼だけを扱えます。例: 見出しを「ひだまり図書室」にして、見出しを「ひだまり図書室」にして画面で確かめて、シナリオを足して見出しを崩して、「項目の名前」を先に聞くようにして、読み取れなかったときは例を出して聞き返すようにして、app/ の外にメモを書いて、壊して、直して、失敗して、ゆっくり進めて。「壊して」には「2 回目で直して」「直せないふりをして」を添えられます';
  await say(text);
  return finish({ text });
}

main().catch((error) => {
  finish({ isError: true, text: `偽接続で問題が起きました: ${error.message}` });
});
