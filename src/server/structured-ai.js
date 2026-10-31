import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ConnectionError, parseResult, runCli, shownArgs } from './product-ai/claude-code.js';

// 道具を渡さず、決まった形の JSON だけを返す役(聞き出す AI、整理する AI)の起動。
// 起動は採点(sim/judge.js)とプロダクト内 AI と同じ形(ADR-0001 の #276): --restricted、--safe-mode、--tools ""。cwd は空の一時フォルダー。
// 道具がないので、app/ の外にも中にも書けない。守りを 1 か所に置き、役を足しても弱まらないようにする。

// 起動の引数。偽接続でも実接続でも同じにする。材料は argv に入れず stdin で渡す。値を持つものは = でつなぐ(- で始まってもフラグにしない)
export function buildStructuredArgs({ schema, systemPrompt, maxBudgetUsd }) {
  return [
    '-p',
    '--restricted',
    '--safe-mode',
    '--tools',
    '',
    '--strict-mcp-config',
    '--permission-mode',
    'dontAsk',
    '--no-session-persistence',
    '--output-format',
    'json',
    `--json-schema=${JSON.stringify(schema)}`,
    `--system-prompt=${systemPrompt}`,
    '--max-budget-usd',
    String(maxBudgetUsd),
  ];
}

// connection は作る AI と同じ判定の結果(agent-connection.js の resolveConnection)。
// 偽接続は src/agent/fake-claude.js に、実接続は利用者の Claude Code に、同じ引数を渡す
export function createStructuredAi({ connection, env = process.env, limits, args, systemPrompt, tmpPrefix, name }) {
  const running = new Set();
  let workDir = null;
  return {
    // 記録と同意のカードの「詳しく」に出す
    describe() {
      return { command: [path.basename(connection.command ?? 'claude'), ...shownArgs(args())], systemPrompt };
    },
    // 1 回もらう。形が壊れていたら 1 回やり直す。2 回とも壊れていたら投げる(どうするかは呼ぶ側が決める)。
    // input(problem) は渡す本文で、problem は前の出力の問題。problemOf(output) は形の検査で、壊れていれば理由を返す
    async ask({ input, problemOf, signal }) {
      if (signal?.aborted) throw new ConnectionError('cancelled', '応答を止めました');
      if (!workDir || !fs.existsSync(workDir)) workDir = fs.mkdtempSync(path.join(os.tmpdir(), tmpPrefix));
      let problem = null;
      for (let attempt = 1; attempt <= limits.attempts; attempt += 1) {
        const { output } = await runCli({
          bin: connection.command,
          args: [...connection.prefixArgs, ...args()],
          input: input(problem),
          cwd: workDir,
          env,
          signal,
          limits,
          running,
          parse: parseResult,
        });
        problem = problemOf(output);
        if (!problem) return output;
      }
      throw new ConnectionError('failed', `${name}の出力が 2 回とも壊れていました(${problem})`);
    },
    // 動いている CLI を止め、終わるまで待ってから作業フォルダーを消す
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
