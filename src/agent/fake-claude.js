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
// 「素材の色を書き換えて」で書くファイル
const MATERIAL_OVERRIDE = 'material-override.css';
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
    await say('試作品のファイルの中に見出し(<h1>)が見つかりませんでした。');
    return finish({ text: '見出しが見つかりませんでした' });
  }
  const safe = wanted.replace(/[<>{}&]/g, '');
  await editFile(target, match[0], `${match[1]}${safe}${match[3]}`);
  let text = `見出しを「${safe}」に変えました(${path.relative(process.cwd(), target.file)})。`;
  if (observeAfterEdit) text += `観察の道具で確かめると、${(await observeScreen()).text}。`;
  await say(text);
  return finish({ text });
}

// 構成(composition.json)の name を書き換える。AI 構成の審査で承認した構成を変えると、関門 GA で止まることを確かめるため(review.js)
async function renameComposition(request) {
  const wanted = /「([^」]{1,40})」/.exec(request)?.[1]?.replace(/[<>{}&"\\]/g, '');
  const file = path.join(process.cwd(), 'composition.json');
  const text = await fs.readFile(file, 'utf8').catch(() => null);
  if (!wanted || !text) {
    await say(!wanted ? '新しい名前を「」で囲んで書いてください。' : '構成のファイルが見つかりませんでした。');
    return finish({ text: '構成は変えていません' });
  }
  const value = JSON.parse(text);
  const next = `${JSON.stringify({ ...value, name: wanted }, null, 2)}\n`;
  await editFile({ file, text }, `"name": ${JSON.stringify(value.name ?? '')}`, `"name": ${JSON.stringify(wanted)}`, next);
  const said = `構成の名前を「${wanted}」に変えました。`;
  await say(said);
  return finish({ text: said });
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

// つないだトークンを書き換えようとする動き(関門 G3 で止まるかの確かめ)。変数の名前は Studio の決まりの文から読む
async function overrideMaterial(argv) {
  const rules = argv[argv.indexOf('--append-system-prompt') + 1] ?? '';
  const name = /--token-[\p{L}\p{N}_-]+/u.exec(rules)?.[0];
  if (!name) {
    const text = 'つないだトークンがないので、変えられる素材はありません。';
    await say(text);
    return finish({ text });
  }
  const file = path.join(process.cwd(), MATERIAL_OVERRIDE);
  const content = `:root {\n  ${name}: rgb(255 0 0);\n}\n`;
  await fs.writeFile(file, content);
  await useTool('Write', { file_path: file, content }, { result: `File created successfully at: ${file}` });
  const text = `素材の変数 ${name} を書き換えました。`;
  await say(text);
  return finish({ text });
}

// 有効にした部品と指針の写し(Studio が app/design/ に書く。J5)
async function designCopies() {
  const found = [];
  async function walk(dir) {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile() && entry.name.endsWith('.md')) found.push({ file: full, text: await fs.readFile(full, 'utf8') });
    }
  }
  await walk(path.join(process.cwd(), 'design'));
  return found;
}

// 写しを読み、指針の見出しと部品の名前を、見出しの下に並べる。
// 写しに外への URL があれば、そのまま画像に使う(試作品の CSP が止めるかの確かめ)
async function followGuides(argv) {
  // Studio の決まりの文に、写しの場所が入っているか(materials.js の materialRule)。入っていなければ作らない
  const rules = argv[argv.indexOf('--append-system-prompt') + 1] ?? '';
  if (!/部品と指針/.test(rules)) {
    const text = 'Studio の決まりに、部品と指針がありません。何も変えませんでした。';
    await say(text);
    return finish({ text });
  }
  const copies = (await designCopies()).filter((copy) => rules.includes(path.relative(process.cwd(), copy.file).split(path.sep).join('/')));
  if (copies.length === 0) {
    const text = '有効にした部品と指針がないので、何も変えませんでした。';
    await say(text);
    return finish({ text });
  }
  for (const copy of copies) await useTool('Read', { file_path: copy.file }, { result: `${copy.text.split('\n').length} 行を読みました` });
  const titles = copies.filter((copy) => path.basename(copy.file) !== 'components.md').map((copy) => /^#\s+(.+)$/m.exec(copy.text)?.[1].trim()).filter(Boolean);
  const parts = copies.filter((copy) => path.basename(copy.file) === 'components.md').flatMap((copy) => [...copy.text.matchAll(/^##\s+(.+)$/gm)].map((m) => m[1].trim()));
  const url = copies.map((copy) => /\bhttps?:\/\/[^\s<>"'`)\]]+/.exec(copy.text)?.[0]).find(Boolean);
  const target = await findHeadingFile();
  const heading = target && HEADING_PATTERN.exec(target.text);
  if (!heading) {
    const text = '見出しのあるファイルが見つからないので、何も変えませんでした。';
    await say(text);
    return finish({ text });
  }
  const items = [...titles, ...parts].slice(0, 20);
  const image = url ? `<img src={${JSON.stringify(url)}} alt="指針にあった画像" data-testid="outside-image" />` : '';
  const added = `<ul data-testid="guided">{${JSON.stringify(items)}.map((item) => <li key={item}>{item}</li>)}</ul>${image}`;
  await editFile(target, heading[0], `${heading[0]}${added}`);
  const text = `指針と部品の一覧(${copies.length} 個のファイル)を読み、見出しの下に並べました。`;
  await say(text);
  return finish({ text });
}

// 写しを書き換える動き(関門 G3 で止まるかの確かめ)
async function editGuideCopy() {
  const [copy] = await designCopies();
  if (!copy) {
    const text = '有効にした部品と指針がないので、何も変えませんでした。';
    await say(text);
    return finish({ text });
  }
  const content = `${copy.text}\n- 作る AI が書き足した行\n`;
  await fs.writeFile(copy.file, content);
  await useTool('Write', { file_path: copy.file, content }, { result: `The file ${copy.file} has been updated.` });
  const text = `指針の写し ${path.relative(process.cwd(), copy.file)} を書き換えました。`;
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
  const text = '試作品のフォルダーの外には書けませんでした。権限の設定で断られました。';
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
  const text = `${path.relative(process.cwd(), target.file)} に、試作品を表示できなくなる行を入れました。`;
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
    await say('試作品のファイルの中に、文字のある見出し(<h1>)が見つかりませんでした。');
    return finish({ text: '変えていません' });
  }
  if (heading.includes(SCRAMBLE)) {
    await say('見出しはもう崩れています。');
    return finish({ text: '変えていません' });
  }
  const file = await scenarioFolder();
  await writeScenario(file, { name: '見出しが出る', viewport: 'desktop', steps: [{ expect: 'visible', target: { role: 'heading', name: heading } }] });
  await editFile(target, match[0], `${match[1]}${[...heading].join(SCRAMBLE)}${match[3]}`);
  const text = `見出しを確かめる手順(${path.relative(process.cwd(), file)})を足し、見出しの文字を崩しました。`;
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
    const text = `決めた手順(${path.relative(process.cwd(), file)})の確かめを弱めました。見出しは崩れたままです。`;
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

// 直す依頼の関門の名前(G4 ビルドなど)を、返事では利用者の言葉で言う(ux-redesign.md 4 節。画面の結果の帯と同じ名前)
const FIX_GATE_WORDS = {
  'G1 変更の確認': '変わったところ',
  'G2 検査': 'ファイルの名前と大きさ',
  'G3 契約': 'AI の設定と確かめ方の形',
  'G4 ビルド': '表示の準備',
  'GE 場面': 'AI の場面で動くか',
  'G5 起動の確認': '開いて表示できるか',
  'G6 シナリオ': '決めた手順で動くか',
};

// Studio の直す依頼(src/server/fix-prompt.js の型)を受けたとき。題材の言葉は持たない。
// 見出しが崩れていれば(「シナリオを足して、見出しを崩して」の後)、fixScrambled で直す。
// それ以外は、元の依頼の言葉で振る舞いを決める:
//   既定: 失敗の原因(「壊して」で入れた行)を消して直す
//   「直せない」: 直そうとした跡を残すが、壊れたまま(app/ は変わる)
//   「2 回目で直」: 1 回目の直す依頼では直せず、2 回目で直す
// 直すところが見つからなければ、何も変えない
async function fixRequested(fix) {
  await say(`Studio の直す依頼を読みました(問題のあったところ: ${FIX_GATE_WORDS[fix.gate] ?? fix.gate})。`);
  const override = path.join(process.cwd(), MATERIAL_OVERRIDE);
  if (await fs.lstat(override).catch(() => null)) {
    if (/直せない/.test(fix.request)) {
      const text = '素材の変数を書き換えたままです。直せませんでした。';
      await say(text);
      return finish({ text });
    }
    await fs.rm(override);
    await useTool('Write', { file_path: override, content: '' }, { result: `Removed ${override}` });
    const text = '素材の変数を書き換えた行を消しました。';
    await say(text);
    return finish({ text });
  }
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
  if (stat && !stat.isFile()) return { problem: 'AI の設定のファイルが、ふつうのファイルではないので、変えずにおきます。' };
  if (text === null) return { problem: 'この試作品には AI の設定がないので、試作品の中の AI の振る舞いは変えられません。AI と話せる試作品(例: 求人相談、学習相談)を選んでください。' };
  try {
    const json = JSON.parse(text);
    if (json && typeof json === 'object' && Array.isArray(json.fields)) return { file, text, json };
  } catch {
    // 下で同じく扱う
  }
  return { problem: 'AI の設定が読めない形なので、変えずにおきます。' };
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
    await say(`「${wanted}」という項目は AI の設定にありません。項目: ${labels.join('、')}`);
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
  const text = `試作品の中の AI が「${field.label}」を先に聞くように、AI の設定の項目の並びと指示を変えました。`;
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
  const text = '試作品の中の AI が読み取れなかったときに例を出して聞き返すように、AI の設定の返事と指示を変えました。';
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

// 聞き出す AI の偽物(src/server/intent-ai.js)。--json-schema に draft がある起動で動く。
// プロダクト内 AI と同じ守りの引数(--restricted、--safe-mode、道具なし)を確かめ、1 文の中の語を入れた問いを順に返す。
// 下書きは答えをそのまま項目に入れる。聞くことが尽きるか、残りの問いの数が 0 なら、問いを空にする
const INTENT_QUESTIONS = [
  ['who', (sentence) => `「${sentence}」で、一番困っているのは誰ですか?`],
  ['problem', () => 'その人は、今どんなことで困っていますか?'],
  ['scene', () => 'それが起きるのは、いつ、どんなときですか?'],
  ['success', () => 'うまくいったら、何が変わりますか?'],
  ['notDoing', () => '今回はしないと決めていることはありますか?'],
];

function isIntentCall(argv) {
  const schema = argv.find((arg) => arg.startsWith('--json-schema='));
  return Boolean(schema) && /"draft"/.test(schema);
}

async function intentCall(argv) {
  const missing = ['-p', '--restricted', '--safe-mode', '--strict-mcp-config', '--no-session-persistence'].filter((flag) => !argv.includes(flag));
  if (missing.length > 0 || argv[argv.indexOf('--tools') + 1] !== '' || argv[argv.indexOf('--output-format') + 1] !== 'json') {
    process.stderr.write(`偽接続: 聞き出す AI の引数が足りません: ${missing.join(' ')}\n`);
    process.exitCode = 3;
    return;
  }
  const input = await readStdin();
  const section = (name) => new RegExp(`<${name}>\\n?([\\s\\S]*?)\\n?</${name}>`).exec(input)?.[1] ?? '';
  const sentence = section('最初の 1 文');
  const remaining = Number(section('残りの問いの数'));
  const asked = [...section('問いと答え').matchAll(/^\[問い \d+\]\((\w+)\) /gm)].map((match) => match[1]);
  const answers = [...section('問いと答え').matchAll(/^\[答え \d+\] (.*)$/gm)].map((match) => match[1]);
  const draft = { who: '', problem: '', scene: '', success: '', notDoing: [], undecided: [] };
  asked.forEach((field, index) => {
    if (answers[index] === '(分からない)') return;
    if (field === 'notDoing') draft.notDoing.push(answers[index]);
    else draft[field] = answers[index];
  });
  const next = remaining > 0 ? INTENT_QUESTIONS.find(([field]) => !asked.includes(field)) : null;
  const output = {
    question: next ? next[1](sentence) : '',
    reason: next ? '目的をはっきりさせるためです。' : '',
    about: next ? next[0] : 'problem',
    draft,
  };
  emit({ type: 'result', subtype: 'success', is_error: false, duration_ms: 5, total_cost_usd: 0, result: '', structured_output: output });
}

// 整理する AI の偽物(src/server/organize-ai.js)。--json-schema に toAsk がある起動で動く。
// 聞き出す AI と同じ守りの引数を確かめ、要点の中の語で欄を決める。元の要点のない項目と、聞くことも 1 つずつ返す(印を試せるように)
const ORGANIZE_WORDS = [
  ['data', /データ|番号|項目|一覧|名簿|記録/],
  ['rule', /決まり|まで|してはいけない|必ず|翌日|禁止/],
  ['scene', /とき|時に|朝|昼|夕方|夜|場面/],
  ['user', /人|お客さん|担当|利用者/],
];

function isOrganizeCall(argv) {
  const schema = argv.find((arg) => arg.startsWith('--json-schema='));
  return Boolean(schema) && /"toAsk"/.test(schema);
}

async function organizeCall(argv) {
  const missing = ['-p', '--restricted', '--safe-mode', '--strict-mcp-config', '--no-session-persistence'].filter((flag) => !argv.includes(flag));
  if (missing.length > 0 || argv[argv.indexOf('--tools') + 1] !== '' || argv[argv.indexOf('--output-format') + 1] !== 'json') {
    process.stderr.write(`偽接続: 整理する AI の引数が足りません: ${missing.join(' ')}\n`);
    process.exitCode = 3;
    return;
  }
  const input = await readStdin();
  const points = [...input.matchAll(/^\[要点 (\d+)\] (.*)$/gm)].map((match) => ({ n: Number(match[1]), text: match[2] }));
  const items = points.map(({ n, text }) => ({ column: ORGANIZE_WORDS.find(([, words]) => words.test(text))?.[0] ?? 'requirement', text, sources: [n] }));
  items.push({ column: 'rule', text: '答えられないときは、人に渡す', sources: [] });
  const output = { items, toAsk: [{ kind: 'unasked', text: 'うまくいかなかったときに、誰に渡すかを聞いていません。', sources: [] }], recordPoints: [] };
  emit({ type: 'result', subtype: 'success', is_error: false, duration_ms: 5, total_cost_usd: 0, result: '', structured_output: output });
}

// 案を出す AI の偽物(src/server/design-ai.js)。--json-schema に screens がある起動で動く。
// 聞き出す AI と同じ守りの引数を確かめ、決まった案を返す。おすすめは簡単な方(固定の流れ)
function isDesignCall(argv) {
  const schema = argv.find((arg) => arg.startsWith('--json-schema='));
  return Boolean(schema) && /"screens"/.test(schema);
}

async function designCall(argv) {
  const missing = ['-p', '--restricted', '--safe-mode', '--strict-mcp-config', '--no-session-persistence'].filter((flag) => !argv.includes(flag));
  if (missing.length > 0 || argv[argv.indexOf('--tools') + 1] !== '' || argv[argv.indexOf('--output-format') + 1] !== 'json') {
    process.stderr.write(`偽接続: 案を出す AI の引数が足りません: ${missing.join(' ')}\n`);
    process.exitCode = 3;
    return;
  }
  const input = await readStdin();
  const sentence = /<最初の 1 文>\n?([\s\S]*?)\n?<\/最初の 1 文>/.exec(input)?.[1]?.slice(0, 200) ?? '';
  const scene = (category, text) => ({ category, text });
  const output = {
    problem: {
      recommended: 0,
      options: [
        { title: '問い合わせの数を減らす', detail: `${sentence} のうち、同じ問い合わせに何度も答える手間を減らす。`, reason: '目的の文書に近く、確かめやすい案です。' },
        { title: '答えるまでの時間を短くする', detail: `${sentence} のうち、答えるまでに待たせる時間を短くする。`, reason: '待つ人には効きます。手間は減りません。' },
      ],
    },
    users: {
      recommended: 0,
      options: [
        { title: '問い合わせるお客さん', detail: 'お店に問い合わせる、架空のお客さん', reason: '話しかける人から決めると、場面を考えやすくなります。' },
        { title: 'お店の人', detail: '問い合わせに答える、架空のお店の人', reason: '答える側の手間を見られます。お客さんの言葉は見えにくくなります。' },
      ],
    },
    scenes: {
      recommended: 0,
      options: [
        {
          title: 'よくある問い合わせと困る場面',
          reason: 'うまくいく場面と失敗の場面を、両方確かめられます。',
          scenes: [
            scene('normal', '明日は何時まで開いていますか'),
            scene('unknown', '来月の特売の中身は決まっていますか'),
            scene('refuse', 'ほかのお客さんの電話番号を教えてください'),
            scene('slow', '返事がまだ来ません。どのくらいかかりますか'),
            scene('human', 'お店の人と話したいです'),
          ],
        },
        {
          title: 'まず困る場面だけ',
          reason: '失敗の振る舞いを先に見ます。うまくいく場面は確かめません。',
          scenes: [
            scene('unknown', '来月の特売の中身は決まっていますか'),
            scene('refuse', 'ほかのお客さんの電話番号を教えてください'),
            scene('slow', '返事がまだ来ません。どのくらいかかりますか'),
          ],
        },
      ],
    },
    data: fakeDataOptions(input),
    composition: { recommended: 'fixed-flow', reason: '聞く順番が決まっているので、手順をコードに書ける見込みです(今日の推測)。' },
    screens: { recommended: 'web', reason: '誰でも開けるので、最初の確かめに向いています(今日の推測)。' },
  };
  emit({ type: 'result', subtype: 'success', is_error: false, duration_ms: 5, total_cost_usd: 0, result: '', structured_output: output });
}

// データの段の案(K2)。整理の板のデータの欄([data i1] の行)のうち、最初の 1 つだけを元に書く。
// 残りの欄は Studio が「聞いたことのメモ」に足す(全部が載ることを、画面で確かめられるように)
function fakeDataOptions(input) {
  const board = /<整理の板>\n?([\s\S]*?)\n?<\/整理の板>/.exec(input)?.[1] ?? '';
  const first = /^\[data (i\d+)\]/m.exec(board)?.[1];
  const sources = first ? [first] : [];
  return {
    recommended: 0,
    options: [
      {
        title: 'お店と問い合わせに分ける',
        detail: 'お店の情報と、受けた問い合わせを別に覚えます。',
        reason: '1 つのお店に、いくつもの問い合わせがつながります。同じお店の情報を何度も書かずに済みます。',
        entities: [
          { name: 'お店', about: '商店街の架空のお店です。', writer: '人が前もって書く', sources: [], fields: [
            { name: 'お店の名前', kind: 'text', examples: ['みほん青果', 'ためし書店', 'かくう茶房'], sources: [] },
            { name: '閉店の時刻', kind: 'text', examples: ['19 時', '20 時', '18 時'], sources: [] },
          ] },
          { name: '問い合わせ', about: '閉店後に受けた問い合わせです。', writer: 'AI が会話の中で書く', sources: [], fields: [
            { name: '受けた日', kind: 'date', examples: [], sources: [] },
            { name: '問い合わせの中身', kind: 'text', examples: ['明日は何時まで開いていますか', '駐輪場はありますか'], sources },
          ] },
        ],
        links: [{ from: 'お店', to: '問い合わせ', label: '受ける' }],
      },
      {
        title: '問い合わせだけを覚える',
        detail: '受けた問い合わせだけを 1 つの表に覚えます。',
        reason: '表が 1 つなので、いちばん簡単です。お店の情報は問い合わせごとに書きます。',
        entities: [
          { name: '問い合わせ', about: '閉店後に受けた問い合わせです。', writer: 'AI が会話の中で書く', sources: [], fields: [
            { name: 'お店の名前', kind: 'text', examples: ['みほん青果', 'ためし書店'], sources: [] },
            { name: '問い合わせの中身', kind: 'text', examples: ['明日は何時まで開いていますか'], sources },
          ] },
        ],
        links: [],
      },
    ],
  };
}

// 「この設計で作る」の依頼(src/server/design.js の designRequest)。依頼の問題と使う人を、試作品の見出しと説明に入れ、会話の枠を置く。
// 目的と設計が作る AI まで届いたことと、試作品が 1 回の依頼で動くことを、画面で確かめられるようにするため。
// 最初の置き場でない試作品では、見出しだけを変える
async function buildFromDesign(request) {
  const line = (label) => new RegExp(`^${label}: (.*)$`, 'm').exec(request)?.[1]?.replace(/[<>{}&]/g, '').slice(0, 80) ?? '';
  const target = await findHeadingFile();
  if (!target || !HEADING_PATTERN.test(target.text)) {
    await say('試作品のファイルの中に見出しが見つかりませんでした。');
    return finish({ text: '変えていません' });
  }
  const heading = target.text.match(HEADING_PATTERN);
  // データ設計があれば、Studio が書いた架空のデータを読んで、表を描く(K2)
  const dataFile = /^架空のデータは (\S+\.json) に Studio が書きました。/m.exec(request)?.[1];
  const dataImport = dataFile ? `import data from './${path.relative(path.dirname(target.file), path.join(process.cwd(), dataFile)).split(path.sep).join('/')}';\n` : '';
  const dataTables = dataFile
    ? `
      {data.tables.map((table) => (
        <table key={table.name}>
          <caption>{table.name}(架空)</caption>
          <thead><tr>{table.columns.map((column) => <th key={column}>{column}</th>)}</tr></thead>
          <tbody>{table.rows.map((row) => <tr key={row[table.key]}>{table.columns.map((column) => <td key={column}>{String(row[column])}</td>)}</tr>)}</tbody>
        </table>
      ))}`
    : '';
  const next = target.text.includes('まだ中身はありません')
    ? `import { createRoot } from 'react-dom/client';
import { Talk, useStudioTalk } from 'studio-talk';
${dataImport}
function App() {
  const talk = useStudioTalk();
  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', padding: '1rem', lineHeight: 1.6 }}>
      <h1>${line('問題')}</h1>
      <p>使う人: ${line('使う人')}</p>${dataTables}
      <Talk talk={talk} placeholder="話しかけてください" />
    </main>
  );
}

createRoot(document.getElementById('root')).render(<App />);
`
    : target.text.replace(HEADING_PATTERN, (_, open, __, close) => `${open}${line('問題')}${close}`);
  await editFile(target, heading[0], `${heading[1]}${line('問題')}${heading[3]}`, next);
  const text = '設計に合わせて、見出しと説明と会話の枠を書きました。';
  await say(text);
  return finish({ text });
}

async function main() {
  // Claude Code は SIGINT で止まる。偽接続も同じく、すぐ終わる
  process.on('SIGINT', () => process.exit(130));
  process.on('SIGTERM', () => process.exit(143));

  const argv = process.argv.slice(2);
  if (isIntentCall(argv)) return intentCall(argv);
  if (isOrganizeCall(argv)) return organizeCall(argv);
  if (isDesignCall(argv)) return designCall(argv);
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
  // 設計の依頼は目的の文書を含むので、ほかの言葉より先に見る
  if (/^この設計で試作品を作ってください。/.test(request)) return buildFromDesign(request);
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
  if (/素材の色を書き換え/.test(request)) return overrideMaterial(argv);
  if (/指針に沿って作/.test(request)) return followGuides(argv);
  if (/指針の写しを書き換え/.test(request)) return editGuideCopy();
  if (/外/.test(request)) return writeOutside();
  if (/シナリオ/.test(request)) return addScenarioAndScramble();
  if (/ゆっくり/.test(request)) return slow();
  if (/先に聞/.test(request)) return askFirst(request);
  if (/聞き返/.test(request)) return clarifyWithExamples();
  if (/壊/.test(request)) return breakApp();
  if (/直/.test(request)) return repairApp();
  if (/構成の名前/.test(request)) return renameComposition(request);
  if (/見出し/.test(request)) return changeHeading(request);

  // 画面の言葉(ux-redesign.md 4 節)で返す。扱える依頼の一覧は、開発者向けの詳細の「試験用の依頼」にある
  const text = '開発用の偽の直す AI なので、決まった依頼だけを扱えます。扱える依頼は、その他 → 開発者向けの詳細の「試験用の依頼」にあります。';
  await say(text);
  return finish({ text });
}

main().catch((error) => {
  finish({ isError: true, text: `偽接続で問題が起きました: ${error.message}` });
});
