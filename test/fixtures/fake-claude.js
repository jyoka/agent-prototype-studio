#!/usr/bin/env node
// 偽の Claude Code。実モデルは呼ばない。STUDIO_CLAUDE_BIN でこのファイルを指すと、Studio はこれを起動する。
// 本物と同じ `-p --output-format json --json-schema …` の結果を出す。発言の中の合図で、失敗と遅延を再現する。
// 呼び出しは 2 種(jyoka/tasks#308)。--json-schema に updates があれば抽出({updates, intent})、reply があれば言い方({reply})を返す。
//   [遅い]   止められるまで応答しない(中断と時間切れ)
//   [しぶとい] [遅い] に加えて SIGINT を無視する(SIGTERM、SIGKILL まで段階を進めるか)
//   [少し遅い] 1.5 秒待ってから応答する(待つ間の画面の操作)
//   [上限]   利用の上限に当たったときの結果を出す
//   [壊れる] 終了コード 2 で止まる
//   [文だけ] 構造化出力を出さず、本文に JSON を書く(代わりの方法)
//   [鍵を出す] API キーらしい文字列を含むエラーを出して終了コード 1 で止まる(画面と記録で伏せるか)
//   [範囲外] 項目の決まりに合わない値と、ない項目を返す(状態に入れないか)
//   [抽出が壊れる] [言い方が壊れる]       その呼び出しで、いつも形の合わない出力を返す(やり直しと代わりの値)
//   [抽出が一度壊れる] [言い方が一度壊れる] やり直し(stdin の <前の出力の問題>)でなければ、形の合わない出力を返す
//   [数を作る]     言い方で、どこにも出てこない数(987)を書く(守ることの確かめ。やり直しても直らない)
//   [一度数を作る] 守ることのやり直し(stdin の <前の返事の問題>)でなければ、どこにも出てこない数を書く
//   [問いを抜く]   言い方で、<言うこと> の聞く問いの原文を返事に入れない
//   [JSON の文]    言い方の返事(reply)の中に、さらに {"reply": "…"} の JSON の文を入れて返す(jyoka/tasks#365。sim-9 の実モデルで出た形)
//   [前後に文]     JSON の前後に文を付ける。[文だけ] と一緒なら本文の全体に、そうでなければ言い方の reply の中の JSON の文に付ける
//   [壊れた JSON] [一度壊れた JSON] 言い方の reply に、閉じていない JSON の文を入れる。「一度」は守ることのやり直しでなければ
// 言い方の返事は、ふだんは Studio の守ること(数字を作らない、聞く問いの原文を入れる)に合う。
// FAKE_CLAUDE_EXTRACTIONS があれば、そのファイル(JSON の { 発言: { updates, intent } })に書いた抽出を返す(モックと同じ抽出を返すため)。
// FAKE_CLAUDE_LOG があれば、受け取った argv、cwd、stdin、関係する環境変数の「名前」を 1 行ずつ書く(値は書かない)。
// 模擬のエージェント(src/server/sim/agent-claude-code.js の buildSimArgs)の起動(--output-format stream-json と --json-schema の parts)には、
// 本物と同じく --mcp-config のツールの MCP サーバーを子として起動し、tools/list と tools/call で道具を呼び、stream-json を出す。
// 呼ぶ道具は FAKE_CLAUDE_TOOL_CALLS のファイル(JSON の { 発言: [{ "tool": 名前, "args": { … } }] })に書いたもの。
// ボタンの action があれば、キーは "action:<action>"。--allowedTools にない名前は、本物と同じくサーバーを呼ばずに断る。
// 呼びすぎ(--max-turns - 1 を超える)は、本物と同じく error_max_turns で止まる。題材の言葉は持たない。返事は文の部品 1 つ。
//   [数を作る] [一度数を作る] は言い方と同じく、どこにも出てこない数(987)を返事に書く(出口の確かめ)
//   --system-prompt に「合言葉は <語> です」があれば、返事の文の始めにその語を書く(本物がシステムの指示に従う代わり。check:sim)
// 採点(src/server/sim/judge.js。--json-schema に score がある)には {score, reason} を返す。点はふだん 4。
//   stdin に [採点 N](N は 1〜5)があれば N 点、[採点が壊れる] があれば score のない出力を返す。modelUsage に --model の名前を出す
// 聞き出す AI(src/server/intent-ai.js。--json-schema に draft がある)には、残りの問いの数によらず、いつも次の問いを返す(上限を数えるのは Studio だと確かめるため)。
//   stdin に [問いを 2 つ] があれば、1 回の問いに 2 つの問いを書く。[決めた印] があれば、形にない status: decided を足して返す
//   [聞き出しが遅い] は止められるまで応答しない。[聞き出しが失敗] は終了コード 2 で止まる
//   [聞き出しが壊れる] はいつも、[聞き出しが一度壊れる] は やり直し(stdin の <前の出力の問題>)でなければ、形の合わない出力を返す
//   [問いなし] は最初から問いを空にする(最初の 1 問は Studio が必ず返すかの確かめ)
// 整理する AI(src/server/organize-ai.js。--json-schema に toAsk がある)には、要点を順に 5 つの欄へ振り分け、元の要点のない項目と、ない要点を指す項目と、聞くことを返す。
//   stdin に [整理が遅い] があれば止められるまで応答しない。[整理が失敗] は終了コード 2 で止まる
//   [整理が壊れる] はいつも、[整理が一度壊れる] はやり直しでなければ、形の合わない出力を返す。[印を書く] があれば、形にない guess: false、held、checkedAt、status: confirmed を足す
// init には本物と同じ項目(model、plugins、slash_commands、skills、agents)を空で出し、断った呼び出しは result の permission_denials に出す
// 作る AI の接続の判定(agent-connection.js)のために、`--version` と `auth status` にも答える。
// auth status は本物(2.1.312)と同じ形で、架空のメールアドレスと組織を含む(Studio が出さないかの確かめ)。
// 案を出す AI(src/server/design-ai.js。--json-schema に screens がある)には、決まった案を返す。
//   stdin に [案が遅い]、[案が失敗]、[案が壊れる]、[案が一度壊れる]、[案に理想]、[難しい形]、[印を書く] があれば、その振る舞いをする
// FAKE_CLAUDE_AUTH=logged-out なら、ログインしていない形を終了コード 1 で返す。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import readline from 'node:readline';

const argv = process.argv.slice(2);
const FAKE_AUTH_SECRETS = ['fictional-user@example.com', '架空の組織', 'fictional-org-0000'];

if (argv[0] === '--version') {
  process.stdout.write('2.1.311 (Claude Code)\n');
  process.exit(0);
}
if (argv[0] === 'auth' && argv[1] === 'status') {
  const loggedOut = process.env.FAKE_CLAUDE_AUTH === 'logged-out';
  const status = loggedOut
    ? { loggedIn: false, authMethod: 'none', apiProvider: 'firstParty' }
    : {
        loggedIn: true,
        authMethod: 'claude.ai',
        apiProvider: 'firstParty',
        email: FAKE_AUTH_SECRETS[0],
        orgName: FAKE_AUTH_SECRETS[1],
        orgId: FAKE_AUTH_SECRETS[2],
        subscriptionType: 'max',
      };
  process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
  process.exit(loggedOut ? 1 : 0);
}
const REQUIRED = ['-p', '--restricted', '--safe-mode', '--strict-mcp-config', '--no-session-persistence'];

function option(name) {
  const joined = argv.find((arg) => arg.startsWith(`${name}=`));
  if (joined) return joined.slice(name.length + 1);
  const at = argv.indexOf(name);
  return at >= 0 ? argv[at + 1] : undefined;
}

let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => (stdin += chunk));
process.stdin.on('end', main);

function section(name) {
  const match = new RegExp(`<${name}>\\n([\\s\\S]*?)\\n</${name}>`).exec(stdin);
  return match ? match[1] : '';
}

function main() {
  if (process.env.FAKE_CLAUDE_LOG) {
    const envNames = Object.keys(process.env).filter((name) => /ANTHROPIC|CLAUDE/.test(name)).sort();
    fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, `${JSON.stringify({ pid: process.pid, argv, cwd: process.cwd(), envNames, stdin })}\n`);
  }
  if (option('--output-format') === 'stream-json' && /"parts"/.test(option('--json-schema') ?? '')) {
    simAgent().catch((error) => {
      process.stderr.write(`偽の CLI: ${error.message}\n`);
      process.exit(4);
    });
    return;
  }
  const missing = REQUIRED.filter((name) => !argv.includes(name));
  if (missing.length > 0 || option('--tools') !== '' || option('--output-format') !== 'json') {
    process.stderr.write(`偽の CLI: 引数が足りません: ${missing.join(' ')}\n`);
    process.exit(3);
  }
  if (/"score"/.test(option('--json-schema') ?? '')) {
    judgeAnswer();
    return;
  }
  if (/"draft"/.test(option('--json-schema') ?? '')) {
    intentAnswer();
    return;
  }
  if (/"toAsk"/.test(option('--json-schema') ?? '')) {
    organizeAnswer();
    return;
  }
  if (/"screens"/.test(option('--json-schema') ?? '')) {
    designAnswer();
    return;
  }
  const text = section('新しい発言');
  if (text.includes('[しぶとい]')) process.on('SIGINT', () => {});
  if (text.includes('[遅い]') || text.includes('[しぶとい]')) {
    setInterval(() => {}, 1000);
    return;
  }
  if (text.includes('[少し遅い]')) {
    setTimeout(answer, 1500, text);
    return;
  }
  if (text.includes('[上限]')) {
    process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: "You've hit your limit · resets 3am" }));
    process.exit(1);
  }
  if (text.includes('[鍵を出す]')) {
    process.stderr.write('Invalid API key: sk-ant-api03-FAKEKEYFAKEKEY1234 (fake)\n');
    process.exit(1);
  }
  if (text.includes('[壊れる]')) {
    process.stderr.write('偽の CLI: 途中で止まりました\n');
    process.exit(2);
  }

  answer(text);
}

function answer(text) {
  const schema = JSON.parse(option('--json-schema'));
  const kind = schema.properties.reply ? 'phrase' : 'extract';
  const retrying = stdin.includes('<前の出力の問題>');
  const label = kind === 'phrase' ? '言い方' : '抽出';
  let output = kind === 'phrase' ? phrase(text) : extract(schema, text);
  if (text.includes(`[${label}が壊れる]`) || (text.includes(`[${label}が一度壊れる]`) && !retrying)) {
    output = kind === 'phrase' ? { reply: '' } : { intent: 'answer' };
  }
  const textOnly = text.includes('[文だけ]');
  if (kind === 'phrase' && output.reply) output = { reply: wrapReply(text, output.reply, textOnly) };
  const result = { type: 'result', subtype: 'success', is_error: false, duration_ms: 5, total_cost_usd: 0.0012 };
  if (textOnly) result.result = text.includes('[前後に文]') ? `返事を作りました。\n${JSON.stringify(output)}\n以上です。` : JSON.stringify(output);
  else Object.assign(result, { result: '', structured_output: output });
  process.stdout.write(JSON.stringify(result));
}

// 言い方の reply を、モデルが形を崩したときの文に変える([JSON の文] [前後に文] [壊れた JSON] [一度壊れた JSON])
function wrapReply(text, reply, textOnly) {
  const guardRetry = stdin.includes('<前の返事の問題>');
  if (text.includes('[壊れた JSON]') || (text.includes('[一度壊れた JSON]') && !guardRetry)) return `{"reply": "${reply}`;
  const nested = text.includes('[JSON の文]') || (text.includes('[前後に文]') && !textOnly);
  if (!nested) return reply;
  const json = JSON.stringify({ reply });
  return text.includes('[前後に文]') && !textOnly ? `返事はこちらです。\n${json}\nよろしくお願いします。` : json;
}

function intentAnswer() {
  if (stdin.includes('[聞き出しが遅い]')) {
    setInterval(() => {}, 1000);
    return;
  }
  if (stdin.includes('[聞き出しが失敗]')) {
    process.stderr.write('偽の CLI: 途中で止まりました\n');
    process.exit(2);
  }
  const count = [...stdin.matchAll(/^\[問い \d+\]/gm)].length;
  const retrying = stdin.includes('<前の出力の問題>');
  const broken = stdin.includes('[聞き出しが壊れる]') || (stdin.includes('[聞き出しが一度壊れる]') && !retrying);
  const fields = ['who', 'problem', 'scene', 'success', 'notDoing'];
  const question = stdin.includes('[問いなし]') ? '' : `偽の問い ${count + 1} は何ですか?${stdin.includes('[問いを 2 つ]') ? '2 つ目の問いは何ですか?' : ''}`;
  const output = broken
    ? { reason: '形が壊れています' }
    : {
        question,
        reason: '偽の理由です。',
        about: fields[count % fields.length],
        draft: { who: count > 0 ? '偽の下書きの人' : '', problem: '', scene: '', success: '', notDoing: [], undecided: [] },
        ...(stdin.includes('[決めた印]') ? { status: 'decided', decidedAt: '2026-10-31T00:00:00.000Z' } : {}),
      };
  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, duration_ms: 5, total_cost_usd: 0.0012, result: '', structured_output: output }));
}

// 案を出す AI の偽物。stdin の 1 文の印で振る舞いを変える
function designAnswer() {
  if (stdin.includes('[案が遅い]')) {
    setInterval(() => {}, 1000);
    return;
  }
  if (stdin.includes('[案が失敗]')) {
    process.stderr.write('偽の CLI: 途中で止まりました\n');
    process.exit(2);
  }
  const retrying = stdin.includes('<前の出力の問題>');
  const broken = stdin.includes('[案が壊れる]') || (stdin.includes('[案が一度壊れる]') && !retrying);
  const banned = stdin.includes('[案に理想]');
  const marks = stdin.includes('[印を書く]') ? { status: 'decided', decidedAt: '2026-10-31T00:00:00.000Z', file: '../outside.json' } : {};
  const option = (name) => ({ title: `偽の${name}`, detail: `偽の${name}の中身`, reason: `偽の${name}の理由` });
  const output = broken
    ? { problem: '形が壊れています' }
    : {
        problem: { recommended: 1, options: banned ? [{ title: '理想の問題', detail: '最適な中身', reason: 'ベストプラクティス' }, option('問題 2')] : [option('問題 1'), option('問題 2'), option('問題 3')] },
        users: { recommended: 0, options: [option('人 1'), option('人 2')] },
        // 分からない、遅いを落とした案。足りない種類は Studio が足す
        scenes: { recommended: 0, options: [
          { title: '偽の場面の組 1', reason: '偽の理由', scenes: [{ category: 'normal', text: '偽のよくある発言' }, { category: 'refuse', text: '偽の断る発言' }] },
          { title: '偽の場面の組 2', reason: '偽の理由', scenes: [{ category: 'unknown', text: '偽の分からない発言' }, { category: 'refuse', text: '偽の断る発言' }, { category: 'slow', text: '偽の遅い発言' }] },
        ] },
        composition: { recommended: stdin.includes('[難しい形]') ? 'master-sub' : 'single-agent', reason: '偽の構成の理由' },
        screens: { recommended: 'talk', reason: '偽の画面の理由' },
        ...marks,
      };
  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, duration_ms: 5, total_cost_usd: 0.0012, result: '', structured_output: output }));
}

function organizeAnswer() {
  if (stdin.includes('[整理が遅い]')) {
    setInterval(() => {}, 1000);
    return;
  }
  if (stdin.includes('[整理が失敗]')) {
    process.stderr.write('偽の CLI: 途中で止まりました\n');
    process.exit(2);
  }
  const retrying = stdin.includes('<前の出力の問題>');
  const broken = stdin.includes('[整理が壊れる]') || (stdin.includes('[整理が一度壊れる]') && !retrying);
  const points = [...section('要点').matchAll(/^\[要点 (\d+)\] (.*)$/gm)].map((match) => ({ n: Number(match[1]), text: match[2] }));
  const columns = ['requirement', 'user', 'scene', 'rule', 'data'];
  const marks = stdin.includes('[印を書く]') ? { guess: false, held: true, by: 'person', checkedAt: '2026-10-31T00:00:00.000Z', status: 'confirmed', confirmedAt: '2026-10-31T00:00:00.000Z' } : {};
  const items = [
    ...points.map(({ n, text }, index) => ({ column: columns[index % columns.length], text, sources: [n] })),
    { column: 'data', text: '偽の話に出ていない項目', sources: [], ...marks },
    { column: 'rule', text: '偽のない要点を指す項目', sources: [9999], ...marks },
  ];
  const toAsk = [
    { kind: 'conflict', text: '偽の食い違いがあります', sources: points.slice(0, 2).map((point) => point.n) },
    { kind: 'unasked', text: '偽の聞いていないことがあります', sources: [] },
  ];
  const output = broken ? { items: '形が壊れています' } : { items, toAsk, ...marks };
  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, duration_ms: 5, total_cost_usd: 0.0012, result: '', structured_output: output }));
}

function judgeAnswer() {
  const given = /\[採点 ([1-5])\]/.exec(stdin);
  const output = stdin.includes('[採点が壊れる]') ? { reason: '点を付けませんでした' } : { score: given ? Number(given[1]) : 4, reason: '偽の採点です。' };
  const model = option('--model') ?? 'fake-judge-model';
  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, duration_ms: 5, total_cost_usd: 0.0007, result: '', structured_output: output, modelUsage: { [model]: {} } }));
}

function extract(schema, text) {
  if (process.env.FAKE_CLAUDE_EXTRACTIONS) {
    const given = JSON.parse(fs.readFileSync(process.env.FAKE_CLAUDE_EXTRACTIONS, 'utf8'));
    if (Object.hasOwn(given, text)) return given[text];
  }
  // 本物のモデルの代わりに、スキーマの選択肢と数の範囲だけで値を読み取る
  const updates = {};
  for (const [key, property] of Object.entries(schema.properties.updates.properties)) {
    if (property.enum) {
      const found = property.enum.find((value) => value !== null && text.includes(value));
      if (found) updates[key] = found;
    } else {
      const numbers = [...text.matchAll(/\d+/g)].map((m) => Number(m[0]));
      const found = numbers.find((n) => (property.minimum ?? -Infinity) <= n && n <= (property.maximum ?? Infinity));
      if (found !== undefined) updates[key] = found;
    }
  }
  if (text.includes('[範囲外]')) {
    for (const [key, property] of Object.entries(schema.properties.updates.properties)) {
      updates[key] = property.enum ? 'ない選択肢' : (property.maximum ?? 0) + 1;
    }
    updates.unknownField = 'x';
  }
  return { updates, intent: Object.keys(updates).length > 0 ? 'answer' : null };
}

// 渡された会話に修正の記録があったかを返事に書く(会話の数は書かない。どこにも出てこない数になるため)
function phrase(text) {
  const history = section('これまでの会話').split('\n').filter((line) => line.startsWith('['));
  const corrected = history.some((line) => line.startsWith('[利用者の修正]'));
  const question = /^- 聞く問い\(この文をそのまま入れる\): (.*)$/m.exec(section('言うこと'))?.[1] ?? '';
  const guardRetry = stdin.includes('<前の返事の問題>');
  const made = text.includes('[数を作る]') || (text.includes('[一度数を作る]') && !guardRetry) ? '合う候補は 987 件です。' : '';
  const asked = text.includes('[問いを抜く]') ? '' : question;
  return { reply: `偽の Claude Code です。これまでの会話を受け取りました(修正の記録${corrected ? 'あり' : 'なし'})。「${text}」への返事です。${made}${asked}` };
}

// 模擬のエージェントの起動。引数の守り(--safe-mode なし、組み込みの道具なし、設定を読まない)を確かめてから動く
const SIM_REQUIRED = ['-p', '--restricted', '--disable-slash-commands', '--strict-mcp-config', '--no-session-persistence', '--verbose'];

function writeEvent(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

// MCP サーバーを子として起動し、1 行 1 つの JSON-RPC で話す
function startServer(config) {
  const child = spawn(config.command, config.args, { stdio: ['pipe', 'pipe', 'inherit'] });
  const waiting = new Map();
  let nextId = 1;
  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    waiting.get(message.id)?.(message);
    waiting.delete(message.id);
  });
  const exited = new Promise((resolve) => child.once('exit', resolve));
  return {
    request(method, params) {
      const id = nextId++;
      return new Promise((resolve) => {
        waiting.set(id, resolve);
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      });
    },
    notify(method) {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`);
    },
    async close() {
      child.stdin.end();
      const timer = setTimeout(() => child.kill('SIGKILL'), 20_000);
      await exited;
      clearTimeout(timer);
    },
  };
}

async function simAgent() {
  const missing = SIM_REQUIRED.filter((name) => !argv.includes(name));
  if (missing.length > 0 || argv.includes('--safe-mode') || option('--tools') !== '' || option('--setting-sources') !== '') {
    process.stderr.write(`偽の CLI: 模擬のエージェントの引数が足りないか、違います: ${missing.join(' ')}\n`);
    process.exit(3);
  }
  const text = section('新しい発言');
  const action = section('押したボタン');
  const allowed = (option('--allowedTools') ?? '').split(',').filter(Boolean);
  const maxTurns = Number(option('--max-turns') ?? 2);
  const given = process.env.FAKE_CLAUDE_TOOL_CALLS ? JSON.parse(fs.readFileSync(process.env.FAKE_CLAUDE_TOOL_CALLS, 'utf8')) : {};
  const key = action ? `action:${action}` : text;
  const wanted = Object.hasOwn(given, key) ? given[key] : [];
  const configFile = option('--mcp-config');
  const config = configFile ? JSON.parse(fs.readFileSync(configFile, 'utf8')).mcpServers?.proto : null;
  const server = config && wanted.length > 0 ? startServer(config) : null;
  let listed = [];
  if (server) {
    await server.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fake-claude', version: '0' } });
    server.notify('notifications/initialized');
    listed = (await server.request('tools/list', {})).result.tools.map((tool) => `mcp__proto__${tool.name}`);
  }
  const model = option('--model') ?? 'fake-model';
  writeEvent({
    type: 'system',
    subtype: 'init',
    cwd: process.cwd(),
    model,
    apiKeySource: 'none',
    tools: listed.filter((name) => allowed.includes(name)),
    mcp_servers: server ? [{ name: 'proto', status: 'connected' }] : [],
    plugins: [],
    slash_commands: [],
    skills: [],
    agents: [],
  });
  const denials = [];
  let turns = 0;
  for (const [i, call] of wanted.entries()) {
    turns += 1;
    if (turns >= maxTurns) {
      if (server) await server.close();
      writeEvent({ type: 'result', subtype: 'error_max_turns', is_error: true, num_turns: turns, duration_ms: 5, total_cost_usd: 0.002 });
      process.exit(1);
    }
    const name = `mcp__proto__${call.tool}`;
    const id = `toolu_fake_${i}`;
    writeEvent({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input: call.args ?? {} }] } });
    if (!allowed.includes(name) || !listed.includes(name)) {
      denials.push({ tool_name: name, tool_use_id: id, tool_input: call.args ?? {} });
      writeEvent({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: true, content: `Permission to use ${name} has been denied.` }] } });
      continue;
    }
    const answer = (await server.request('tools/call', { name: call.tool, arguments: call.args ?? {} })).result;
    writeEvent({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: Boolean(answer.isError), content: answer.content }] } });
  }
  if (server) await server.close();
  const retrying = stdin.includes('<前の返事の問題>');
  const made = text.includes('[数を作る]') || (text.includes('[一度数を作る]') && !retrying) ? '合う候補は 987 件です。' : '';
  const word = /合言葉は (\S+) です/.exec(option('--system-prompt') ?? '')?.[1];
  const parts = [{ kind: 'text', text: `${word ? `${word} ` : ''}偽の Claude Code です。「${text}」への返事です。${made}` }];
  writeEvent({
    type: 'result',
    subtype: 'success',
    is_error: false,
    num_turns: turns + 1,
    duration_ms: 5,
    total_cost_usd: 0.002,
    modelUsage: { [model]: { costUSD: 0.002 } },
    permission_denials: denials,
    result: '',
    structured_output: { parts },
  });
}
