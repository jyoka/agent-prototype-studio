import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConnectionError, billingOf, failure, findExecutable, runCli, shownArgs } from '../product-ai/claude-code.js';
import { ASSUMPTION_LIMITS, MODEL_NAME_PATTERN } from './assumptions.js';
import { SIM_LIMITS, TOOL_NAME_PATTERN, isPlainObject } from './check.js';
import { refusedEntry } from './tool-gate.js';
import { MCP_SERVER_NAME, SIM_FILES, ensureSimDir, removeSimDir, writeAtomic } from './tools-mcp.js';

// 模擬のエージェントを、利用者が入れた Claude Code で動かす接続(docs/design/agent-simulation.md の 3.3、ADR-0003)。
// 返事ごとに `claude -p` を 1 回起動する。ツールの呼び出しの繰り返しは CLI の中で回り、ツールは MCP サーバー
// (bin/tools-mcp.js)を通してツールの口を呼ぶ。作る AI の buildClaudeArgs(claude-args.js)とプロダクト内 AI の
// buildArgs(product-ai/claude-code.js)とは分け、どれにも当てはまらない引数が混ざらないようにする。
// 模擬のエージェントに渡すのは、組んだプロンプト、ツールの説明(MCP の道具の一覧)、会話、前提の長さで切ったツールの結果だけ(S14)。

export const SIM_AGENT_LIMITS = {
  timeoutMs: 120_000,
  maxOutputBytes: 2 * 1024 * 1024,
  maxStderrBytes: 16 * 1024,
  // 1 回の起動(返事 1 回。ツールの繰り返しを含む)の費用の上限(--max-budget-usd)
  maxBudgetUsd: 0.2,
  stopGraceMs: 1500,
};
// 前提に toolCalling.maxPerReply がないときの、1 回の返事のツールの呼び出しの数
export const DEFAULT_MAX_PER_REPLY = 4;

const TOOLS_MCP_BIN = fileURLToPath(new URL('../../../bin/tools-mcp.js', import.meta.url));
const PERMISSION_PREFIX = `mcp__${MCP_SERVER_NAME}__`;

// 許可する道具の名前。構成の tools の名前だけを並べる(ワイルドカードは使わない)
export function permissionNames(tools) {
  for (const name of tools) {
    if (typeof name !== 'string' || !TOOL_NAME_PATTERN.test(name)) throw new TypeError(`ツールの名前の形が正しくありません: ${JSON.stringify(name)}`);
  }
  return tools.map((name) => `${PERMISSION_PREFIX}${name}`);
}

// 前提の 1 回の返事のツールの数。上限(8)で切る
export function maxPerReplyOf(assumption) {
  const value = assumption?.toolCalling?.maxPerReply;
  return Number.isInteger(value) && value >= 1 ? Math.min(value, ASSUMPTION_LIMITS.maxPerReply) : DEFAULT_MAX_PER_REPLY;
}

const studioRules = (kinds) => [
  '# Studio の決まり(Prototype Studio が付け足しています)',
  'あなたは試作品の中で、構成の参加者の 1 人を演じる AI です。データはすべて架空です。実在の人や会社の情報を求めないでください。',
  '使えるのは、渡された試作品のツールだけです。ツールが断ったときは、返ってきた文を読んで、呼び方を変えるか、利用者に伝えてください。',
  `返事は JSON だけにしてください。形: {"parts": [部品, …]}。使える部品の種類: ${kinds.join('、')}。`,
];

// プロンプトを組む(3.2 の「前提の土台 + 枠 + 頼み + Studio の決まり」)。
// 部品は構成の prompt の順。前提の値と枠の文は上限で切る。プロンプトの頼み(layer: prompt)は、外す指定がなければ足す。
// 返す: { text, pieces(記録に残す。部品ごとの持ち主と文字数), asked(足した頼みの id) }
export function agentPrompt({ participant, assumption, prompts = {}, guards = [], withoutPromptGuards = false, kinds = ['text'] }) {
  const blocks = [];
  const pieces = [];
  for (const piece of participant.prompt ?? []) {
    let body;
    if (piece.from === 'assumptions') {
      body = typeof assumption?.[piece.key] === 'string' ? assumption[piece.key].slice(0, SIM_LIMITS.maxPromptChars) : '';
      pieces.push({ from: 'assumptions', key: piece.key, owner: piece.owner, chars: body.length });
    } else {
      const source = typeof piece.text === 'string' ? piece.text : prompts[piece.file];
      body = typeof source === 'string' ? source.slice(0, SIM_LIMITS.maxPromptChars) : '';
      pieces.push({ slot: piece.slot, owner: piece.owner, chars: body.length });
    }
    if (body.trim() !== '') blocks.push(body.trim());
  }
  const asked = withoutPromptGuards ? [] : guards.filter((guard) => guard.layer === 'prompt' && guard.on === participant.id);
  if (asked.length > 0) blocks.push(['# 守ってほしいこと', ...asked.map((guard) => `- ${guard.text}`)].join('\n'));
  blocks.push(studioRules(kinds).join('\n'));
  return { text: blocks.join('\n\n'), pieces, asked: asked.map((guard) => guard.id) };
}

// 模擬のエージェントに渡す本文(stdin)。会話の全体(Studio が持つ履歴)、新しい発言、押したボタン、引き継ぎの知らせ。
// 記録の店、harness の状態、ほかの参加者のツールなど、Studio の内側の情報は渡さない(S14)。
// labels は参加者の id → 表示の名前。problem は、前の返事が使えなかったところ(やり直すときだけ)
export function agentStdin({ messages = [], labels = {}, input, handedOff = null, problem = null }) {
  const line = (message) => {
    if (message.role === 'user') return `[利用者] ${message.text}`;
    if (message.role === 'correction') return `[利用者の修正] ${message.text}`;
    return `[${labels[message.from] ?? 'AI'}] ${message.text}`;
  };
  const carried = handedOff?.carry ? Object.entries(handedOff.carry) : [];
  return [
    '<これまでの会話>',
    ...(messages.length > 0 ? messages.map(line) : ['(まだありません)']),
    '</これまでの会話>',
    '',
    '<新しい発言>',
    input.text,
    '</新しい発言>',
    ...(input.action ? ['', '<押したボタン>', input.action, '</押したボタン>'] : []),
    ...(handedOff
      ? ['', '<引き継ぎ>', `${labels[handedOff.from] ?? handedOff.from} から引き継ぎました。`, ...carried.map(([key, value]) => `- ${key}: ${JSON.stringify(value)}`), '</引き継ぎ>']
      : []),
    ...(problem?.length ? ['', '<前の返事の問題>', '前の返事は使えませんでした。次の点を直して、返事を作り直してください。', ...problem, '</前の返事の問題>'] : []),
  ].join('\n');
}

// 道具の一覧に出るもの(ツールの MCP サーバーが context.json の allowedTools で絞った tools/list と同じ名前)。参加者の tools の名前だけ
export function toolDescriptions(toolset, names) {
  return names
    .map((name) => toolset?.tools.find((tool) => tool.name === name))
    .filter(Boolean)
    .map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema }));
}

// ツールの MCP サーバーを 1 つだけ持つ設定。プロジェクトと会話は起動の引数でだけ渡す(引数は 3 つのまま。3.6)
export function simMcpConfig({ projectDir, conversationId, maxSeconds }) {
  return {
    mcpServers: {
      [MCP_SERVER_NAME]: {
        type: 'stdio',
        command: process.execPath,
        args: [TOOLS_MCP_BIN, projectDir, '--conversation', conversationId, '--max-seconds', String(Math.max(1, Math.ceil(maxSeconds)))],
      },
    },
  };
}

// 起動の引数(3.3)。--safe-mode は付けない(--mcp-config のサーバーも外すため。ADR-0002)。代わりに作る AI と同じ組み合わせ
// (--restricted、--setting-sources ""、--disable-slash-commands、--strict-mcp-config)を使い、組み込みの道具は渡さない(--tools "")。
// 前提から来る値は上限で切り、値を持つもの(--json-schema、--system-prompt、--model)は = でつなぐ(- で始まってもフラグにしない)。
// ツールがない参加者には MCP の設定も許可も渡さない
export function buildSimArgs({ mcpConfig, tools = [], schema, systemPrompt, assumption, maxBudgetUsd = SIM_AGENT_LIMITS.maxBudgetUsd }) {
  const allowed = permissionNames(tools);
  if (allowed.length > 0 && (typeof mcpConfig !== 'string' || mcpConfig === '')) throw new TypeError('mcpConfig(MCP の設定のファイル)を渡してください');
  const args = ['-p', '--restricted', '--setting-sources', '', '--disable-slash-commands', '--tools', '', '--strict-mcp-config'];
  if (allowed.length > 0) args.push('--mcp-config', mcpConfig, '--allowedTools', allowed.join(','));
  args.push(
    '--permission-mode',
    'dontAsk',
    '--permission-prompts',
    'none',
    '--no-session-persistence',
    '--output-format',
    'stream-json',
    '--verbose',
    `--json-schema=${JSON.stringify(schema)}`,
    `--system-prompt=${systemPrompt}`,
    '--max-turns',
    String(maxPerReplyOf(assumption) + 1),
    '--max-budget-usd',
    String(Math.min(Math.max(Number(maxBudgetUsd) || SIM_AGENT_LIMITS.maxBudgetUsd, 0.01), 1)),
  );
  const model = assumption?.model?.name;
  if (typeof model === 'string' && model !== '' && MODEL_NAME_PATTERN.test(model)) args.push(`--model=${model}`);
  return args;
}

function parseJsonObject(text) {
  if (typeof text !== 'string') return null;
  const body = text.trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/, '$1');
  try {
    const value = JSON.parse(body);
    return isPlainObject(value) ? value : null;
  } catch {
    return null;
  }
}

// stream-json の出力を読む。道具の呼び出し(モデルが呼ぼうとしたもの)と、最後の結果。
// 返す: { output, format, problem, meta, toolUses: [{ id, name, input, isError }] }
export function parseSimStream(stdout) {
  const toolUses = [];
  const results = new Map();
  let result = null;
  for (const line of String(stdout ?? '').split('\n')) {
    if (line.trim() === '') continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isPlainObject(event)) continue;
    const blocks = Array.isArray(event.message?.content) ? event.message.content : [];
    if (event.type === 'assistant') {
      for (const block of blocks) {
        if (block?.type === 'tool_use') toolUses.push({ id: String(block.id ?? ''), name: String(block.name ?? '').slice(0, 200), input: block.input ?? {} });
      }
    }
    if (event.type === 'user') {
      for (const block of blocks) if (block?.type === 'tool_result') results.set(String(block.tool_use_id ?? ''), Boolean(block.is_error));
    }
    if (event.type === 'result') result = event;
  }
  for (const use of toolUses) use.isError = results.get(use.id) ?? null;
  if (!result) throw failure(String(stdout ?? '').slice(-2000), 'Claude Code の出力を読めませんでした');
  const meta = {
    costUsd: Number.isFinite(result.total_cost_usd) ? result.total_cost_usd : null,
    durationMs: Number.isFinite(result.duration_ms) ? result.duration_ms : null,
  };
  // ツールを呼びすぎて返事の前に止まったときは、返事なし(会話の進め方がやり直すか、決まった文にする)
  // CLI はこのとき 0 でない終了コードで終わりうるので、acceptNonZero で失敗にしないよう runCli に伝える
  if (result.subtype === 'error_max_turns') {
    return { output: null, format: 'broken', problem: '1 回の返事のツールの呼び出しが、前提の上限に達した', meta, toolUses, acceptNonZero: true };
  }
  if (result.is_error || (typeof result.subtype === 'string' && result.subtype !== 'success')) {
    // 失敗した起動の費用も、場面の回しの台帳に数えられるよう、誤りに付ける
    const error = result.subtype === 'error_max_budget_usd'
      ? new ConnectionError('budget', `1 回の起動の費用の上限($${SIM_AGENT_LIMITS.maxBudgetUsd})に当たったので止めました`)
      : failure(result.result ?? result.subtype, 'Claude Code がエラーを返しました');
    error.costUsd = meta.costUsd;
    throw error;
  }
  if (isPlainObject(result.structured_output)) return { output: result.structured_output, format: 'structured', problem: null, meta, toolUses };
  const output = parseJsonObject(result.result);
  if (output) return { output, format: 'text-json', problem: null, meta, toolUses };
  return { output: null, format: 'broken', problem: 'JSON の出力がなかった', meta, toolUses };
}

// モデルが呼ぼうとした道具の並びと、ツールの MCP サーバーが書いた呼び出しの記録(正)を合わせる。
// 記録にない呼び出し(許可していない名前など)は、layer: permission の断りとして記録する(3.6)
export function matchToolSteps(toolUses, entries, by) {
  const queue = [...entries];
  const steps = [];
  for (const use of toolUses) {
    // 返事の形(--json-schema)は、CLI が StructuredOutput という道具の呼び出しで受け取る(sim-7 で実機で確かめた)。ツールの呼び出しには数えない
    if (use.name === 'StructuredOutput') continue;
    const name = use.name.startsWith(PERMISSION_PREFIX) ? use.name.slice(PERMISSION_PREFIX.length) : null;
    const at = name ? queue.findIndex((entry) => entry.tool === name) : -1;
    if (at >= 0) {
      steps.push(...queue.splice(0, at + 1));
      continue;
    }
    steps.push(refusedEntry({ name: use.name, args: use.input, by, layer: 'permission', guard: 'allowedTools', reason: '許可していない名前の道具なので、Claude Code が呼ばなかった' }));
  }
  return [...steps, ...queue];
}

async function readJsonFile(file, fallback) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

async function countLines(file) {
  const text = await fsp.readFile(file, 'utf8').catch((error) => (error.code === 'ENOENT' ? '' : Promise.reject(error)));
  return text === '' ? 0 : text.split('\n').filter((line) => line.trim() !== '').length;
}

// allowed は本物の AI を選べるか(config.allowClaudeCode)。選べるか、同意の確かめは、プロダクト内 AI の接続と同じ口(AiSessions.useReal)で行う
export function createClaudeCodeAgent({ env = process.env, limits = SIM_AGENT_LIMITS } = {}) {
  const binName = env.STUDIO_CLAUDE_BIN || 'claude';
  const billing = billingOf(env);
  const running = new Set();
  let workDir = null;

  return {
    kind: 'claude-code',
    label: 'Claude Code',
    real: true,
    billing,
    tools: '模擬のエージェントには、構成に書いた試作品のツールだけを、1 つの MCP サーバー(proto)から名前を並べて渡します(--allowedTools)。ファイル、コマンド、Web の道具は渡しません(--tools "")。',
    // 実行の前に画面に出す。何が、どこへ送られるか
    sends(simulation) {
      const agents = (simulation?.composition?.participants ?? []).filter((p) => p.kind === 'agent');
      return {
        to: billing.providers ? `環境変数(${billing.providers.join('、')})で指定された提供元(Claude Code が送ります)` : 'Anthropic(Claude Code が送ります)',
        items: [
          `模擬のエージェント(${agents.map((p) => p.label).join('、') || 'なし'})の組んだプロンプト(前提の土台、枠、頼み、Studio の決まり)`,
          '構成に書いた試作品のツールの説明と、ツールの結果(前提の長さまで)',
          'この試作品で話した会話の全体と、新しく送る発言',
        ],
        notSent: 'app/ の他のファイル、記録の店の全体、他の試作品、PC のファイルは送りません。ファイル、コマンド、Web の道具は渡しません。',
      };
    },
    // 起動の形(記録に出す。送る前に作る)
    describe({ mcpConfig, tools, schema, systemPrompt, assumption }) {
      return { command: [path.basename(binName), ...shownArgs(buildSimArgs({ mcpConfig: mcpConfig ?? '<mcp.json>', tools, schema, systemPrompt, assumption }))] };
    },
    // 1 回の返事。context は会話の進め方が渡す: { projectDir, conversationId, by, toolsFile, handoffs, assumption, userId, store, calls, onLaunch }。
    // ツールがあれば、起動の前に .studio/sim/<会話の ID>/ に MCP の設定、文脈、記録の店、呼び出しの数を書き、
    // 起動の後に、呼び出しの記録(calls.jsonl のこの起動の分)、記録の店、呼び出しの数、引き継ぎを読み戻す。
    // 返す: { output, format, problem, meta, steps, results, store, calls, handoffs, command }
    async reply({ participant, systemPrompt, stdin, schema, signal, context }) {
      const bin = findExecutable(binName, env);
      if (!bin) {
        throw new ConnectionError('not-found', `Claude Code が見つかりません(${binName})。Claude Code を入れてログインするか、STUDIO_CLAUDE_BIN で場所を指定してください。`);
      }
      if (signal?.aborted) throw new ConnectionError('cancelled', '応答を止めました');
      const { projectDir, conversationId, by, toolsFile, handoffs, assumption, userId, store, calls, onLaunch } = context;
      const tools = participant.tools ?? [];
      let dir = null;
      let mcpConfig = null;
      let before = 0;
      if (tools.length > 0) {
        dir = await ensureSimDir(projectDir, conversationId);
        const conversation = { dir, temps: new Set() };
        mcpConfig = path.join(dir, SIM_FILES.mcp);
        const maxSeconds = limits.timeoutMs / 1000 + 30;
        await writeAtomic(conversation, SIM_FILES.mcp, simMcpConfig({ projectDir, conversationId, maxSeconds }));
        await writeAtomic(conversation, SIM_FILES.context, {
          formatVersion: 1,
          by,
          // 道具の一覧に出すのは、この参加者のツールだけ(--allowedTools は呼べるかを決めるだけで、一覧は変えないため)
          allowedTools: tools,
          handoffs,
          toolCalling: {
            ...(Number.isInteger(assumption?.toolCalling?.delayMs) ? { delayMs: assumption.toolCalling.delayMs } : {}),
            ...(Number.isInteger(assumption?.toolCalling?.resultMaxChars) ? { resultMaxChars: assumption.toolCalling.resultMaxChars } : {}),
            ...(Array.isArray(assumption?.toolCalling?.faults) ? { faults: assumption.toolCalling.faults } : {}),
          },
          maxPerReply: maxPerReplyOf(assumption),
          ...(userId ? { userId } : {}),
          ...(toolsFile ? { tools: toolsFile } : {}),
        });
        // 正はメモリーの店と数。起動のたびに写してから渡す
        await writeAtomic(conversation, SIM_FILES.store, store);
        await writeAtomic(conversation, SIM_FILES.counts, calls);
        await fsp.rm(path.join(dir, SIM_FILES.handoff), { force: true });
        before = await countLines(path.join(dir, SIM_FILES.calls));
      }
      if (!workDir || !fs.existsSync(workDir)) workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-sim-agent-'));
      const args = buildSimArgs({ mcpConfig, tools, schema, systemPrompt, assumption });
      // プロジェクトごとの呼び出しの上限に数える。上限なら起動しない(投げる)
      onLaunch?.();
      const parsed = await runCli({ bin, args, input: stdin, cwd: workDir, env, signal, limits, running, parse: parseSimStream });
      let entries = [];
      let results = [];
      let nextStore = store;
      let nextCalls = calls;
      let handoffList = [];
      if (dir) {
        const lines = (await fsp.readFile(path.join(dir, SIM_FILES.calls), 'utf8').catch(() => '')).split('\n').filter((line) => line.trim() !== '');
        for (const line of lines.slice(before)) {
          try {
            const { at, output, ...entry } = JSON.parse(line);
            entries.push(entry);
            if (entry.result?.ok) results.push(output);
          } catch {
            // 書き途中の行は読まない
          }
        }
        nextStore = await readJsonFile(path.join(dir, SIM_FILES.store), store);
        nextCalls = await readJsonFile(path.join(dir, SIM_FILES.counts), calls);
        handoffList = await readJsonFile(path.join(dir, SIM_FILES.handoff), []);
        await fsp.rm(path.join(dir, SIM_FILES.handoff), { force: true });
        if (!isPlainObject(nextStore)) nextStore = store;
        if (!isPlainObject(nextCalls)) nextCalls = calls;
        if (!Array.isArray(handoffList)) handoffList = [];
      }
      entries = matchToolSteps(parsed.toolUses, entries, by);
      return {
        output: parsed.output,
        format: parsed.format,
        problem: parsed.problem,
        meta: parsed.meta,
        steps: entries,
        results,
        store: nextStore,
        calls: nextCalls,
        handoffs: handoffList,
        command: [path.basename(binName), ...shownArgs(args)],
      };
    },
    // 会話のフォルダーを消す(会話を最初からにしたとき、版を戻したとき)
    forget(projectDir, conversationId) {
      removeSimDir(projectDir, conversationId);
    },
    async close() {
      const waits = [...running].map((entry) => {
        entry.stop();
        return entry.done;
      });
      let timer;
      const limit = new Promise((resolve) => (timer = setTimeout(resolve, limits.stopGraceMs * 2 + 1000)));
      await Promise.race([Promise.all(waits), limit]);
      clearTimeout(timer);
      if (workDir) fs.rmSync(workDir, { recursive: true, force: true });
      workDir = null;
    },
  };
}
