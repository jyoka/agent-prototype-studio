#!/usr/bin/env node
// 決定的な偽接続。`claude -p --output-format stream-json` と同じ形の行を出す。
// モデルも外部の API も呼ばない。依頼の文の言葉で、決まった動きをする(fake-examples.js)。
// Studio が組み立てた引数をそのまま受け取り、ADR-0001 の守りが入っていなければ失敗する。
import fs from 'node:fs/promises';
import path from 'node:path';
import { AGENT_TOOLS } from '../server/claude-args.js';

const STEP_MS = 120;
const SLOW_STEPS = 60;
const SLOW_STEP_MS = 500;
const BROKEN_LINE = 'const studioBroken = ; // 偽接続が「壊して」で入れた行\n';
const SESSION_ID = '00000000-0000-4000-8000-000000000000';
const started = Date.now();
let turns = 0;
let toolSeq = 0;

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

function checkArgs(argv) {
  const problems = [];
  const has = (flag) => argv.includes(flag);
  const value = (flag) => (has(flag) ? argv[argv.indexOf(flag) + 1] : undefined);
  for (const flag of ['-p', '--restricted', '--safe-mode', '--strict-mcp-config', '--no-session-persistence', '--verbose']) {
    if (!has(flag)) problems.push(`${flag} がありません`);
  }
  const expected = {
    '--permission-mode': 'dontAsk',
    '--permission-prompts': 'none',
    '--output-format': 'stream-json',
    '--tools': AGENT_TOOLS,
    '--allowedTools': AGENT_TOOLS,
  };
  for (const [flag, want] of Object.entries(expected)) {
    if (value(flag) !== want) problems.push(`${flag} が ${want} ではありません`);
  }
  for (const banned of ['--dangerously-skip-permissions', '--add-dir', '--mcp-config', 'bypassPermissions']) {
    if (has(banned)) problems.push(`${banned} は渡してはいけません`);
  }
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

async function editFile(target, oldString, newString) {
  if (!insideCwd(target.file)) throw new Error('作業ディレクトリの外です');
  await useTool('Read', { file_path: target.file }, { result: `${target.text.split('\n').length} 行を読みました` });
  await fs.writeFile(target.file, target.text.replace(oldString, newString));
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
  const text = `見出しを「${safe}」に変えました(${path.relative(process.cwd(), target.file)})。`;
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

async function repairApp() {
  const target = await findHeadingFile();
  if (!target?.text.includes(BROKEN_LINE)) {
    await say('直すところはありませんでした。');
    return finish({ text: '変えていません' });
  }
  await editFile(target, BROKEN_LINE, '');
  const text = '「壊して」で入れた行を消しました。';
  await say(text);
  return finish({ text });
}

async function slow() {
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
  const problems = checkArgs(argv);
  const request = (await readStdin()).trim();
  emit({
    type: 'system',
    subtype: 'init',
    session_id: SESSION_ID,
    cwd: process.cwd(),
    model: 'fake',
    permissionMode: argv[argv.indexOf('--permission-mode') + 1],
    tools: AGENT_TOOLS.split(','),
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

  if (/ログイン/.test(request)) {
    return finish({ isError: true, text: 'Not logged in · Please run /login' });
  }
  if (/失敗/.test(request)) {
    await say('依頼を読みました。これから失敗します。');
    return finish({ isError: true, text: '偽接続: 依頼どおりに失敗しました' });
  }
  if (/外/.test(request)) return writeOutside();
  if (/ゆっくり/.test(request)) return slow();
  if (/壊/.test(request)) return breakApp();
  if (/直/.test(request)) return repairApp();
  if (/見出し/.test(request)) return changeHeading(request);

  const text = '偽接続なので、決まった依頼だけを扱えます。例: 見出しを「ひだまり図書室」にして、app/ の外にメモを書いて、壊して、直して、失敗して、ゆっくり進めて';
  await say(text);
  return finish({ text });
}

main().catch((error) => {
  finish({ isError: true, text: `偽接続で問題が起きました: ${error.message}` });
});
