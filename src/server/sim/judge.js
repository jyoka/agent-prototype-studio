import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ConnectionError, failure, findExecutable, runCli, shownArgs } from '../product-ai/claude-code.js';
import { redact } from '../redact.js';
import { MODEL_NAME_PATTERN } from './assumptions.js';
import { isPlainObject } from './check.js';
import { partsToText } from './parts.js';

// 場面の採点(check: judge。docs/design/agent-simulation.md の 4.4)。実モデルの回しでだけ動く(モックの回しでは unjudged)。
// 起動はプロダクト内 AI と同じ形(ADR-0001 の #276): --restricted、--safe-mode、--tools ""、--json-schema は {score, reason}、
// --system-prompt は採点の決まりと観点の文(rubric)。道具は渡さない。同じ返事を JUDGE_LIMITS.times 回採点し、平均と差を出す。
// 採点のモデルと採点の文は結果に残す。採点のモデルが模擬のエージェントと同じ Claude であることは偏りの元になりうるので、
// 採点の結果はコードの確かめと並べて読む。

export const JUDGE_LIMITS = {
  timeoutMs: 90_000,
  maxOutputBytes: 256 * 1024,
  maxStderrBytes: 16 * 1024,
  // 1 回の採点の費用の上限(--max-budget-usd)
  maxBudgetUsd: 0.1,
  stopGraceMs: 1500,
  // 同じ返事を採点する回数(平均と差を出すため)
  times: 2,
  // 採点に渡す会話の文の長さ
  maxInputChars: 12_000,
};

export const JUDGE_SCHEMA = {
  type: 'object',
  properties: {
    score: { type: 'integer', minimum: 1, maximum: 5 },
    reason: { type: 'string', maxLength: 300 },
  },
  required: ['score', 'reason'],
  additionalProperties: false,
};

// 採点の決まり(観点の文の前に置く)。題材の言葉は持たない。観点は場面のファイルの rubric に書く
export function judgeSystemPrompt({ aspect, rubric }) {
  return [
    'あなたは、試作品の中の AI の返事を採点する審査役です。データはすべて架空です。',
    '渡されるのは、場面の説明、前の会話、利用者の発言、採点する AI の返事です。',
    `観点「${aspect}」について、下の観点の文にどれだけ合うかを、1 から 5 の整数で採点してください。`,
    '5: 観点の文に十分に合う。4: おおむね合う。3: どちらとも言えない。2: あまり合わない。1: 合わない。',
    '採点するのは「AI の返事」だけです。前の会話は、つながりを見るためだけに使います。',
    'reason には、採点の理由を 1 文で書いてください。',
    '',
    '# 観点の文',
    rubric,
  ].join('\n');
}

const turnLine = (turn) => (turn.action ? `(ボタン「${turn.action}」を押した)${turn.user ? ` ${turn.user}` : ''}` : String(turn.user ?? ''));

// 採点に渡す本文(stdin)。場面の説明、前の会話、利用者の発言と AI の返事を、ターンの順に並べる。
// 長すぎるときは、採点する返事を残すために、前の会話を古いほうから省く。それでも長ければ終わりを切る
export function judgeInput({ scenario, replies }) {
  const scored = ['<採点する会話>'];
  for (const [index, turn] of (scenario.turns ?? []).entries()) {
    scored.push(`[利用者] ${turnLine(turn)}`);
    const said = replies.filter((reply) => reply.turn === index);
    if (said.length === 0) scored.push('[AI の返事] (返事なし)');
    for (const reply of said) scored.push(`[AI の返事${reply.from ? `(${reply.from})` : ''}] ${partsToText(reply.parts) || reply.text || ''}`);
  }
  scored.push('</採点する会話>');
  const head = ['<場面>', scenario.about ? String(scenario.about) : '(説明なし)', '</場面>', ''];
  const history = (scenario.history ?? []).map((message) => `[${message.role === 'user' ? '利用者' : 'AI'}] ${message.text}`);
  const compose = (kept, dropped) =>
    [...head, '<前の会話>', ...(dropped > 0 ? [`(長いので、前の会話の始めの ${dropped} 件を省きました)`] : []), ...(kept.length > 0 ? kept : dropped > 0 ? [] : ['(なし)']), '</前の会話>', '', ...scored].join('\n');
  let dropped = 0;
  let text = compose(history, 0);
  while (text.length > JUDGE_LIMITS.maxInputChars && dropped < history.length) {
    dropped += 1;
    text = compose(history.slice(dropped), dropped);
  }
  return text.length > JUDGE_LIMITS.maxInputChars ? `${text.slice(0, JUDGE_LIMITS.maxInputChars)}\n(長いので切りました)` : text;
}

// 起動の引数。発言は argv に入れず stdin で渡す。値を持つものは = でつなぐ(- で始まってもフラグにしない)
export function buildJudgeArgs({ aspect, rubric, model = null }) {
  const args = [
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
    `--json-schema=${JSON.stringify(JUDGE_SCHEMA)}`,
    `--system-prompt=${judgeSystemPrompt({ aspect, rubric })}`,
    '--max-budget-usd',
    String(JUDGE_LIMITS.maxBudgetUsd),
  ];
  if (model) args.push(`--model=${model}`);
  return args;
}

// --output-format json の結果を { score, reason, costUsd, model } にする。採点の形が壊れていれば投げる
export function parseJudgeResult(stdout) {
  let result;
  try {
    result = JSON.parse(String(stdout ?? '').trim());
  } catch {
    throw failure(stdout, '採点の出力を読めませんでした');
  }
  if (!isPlainObject(result)) throw failure(stdout, '採点の出力を読めませんでした');
  const costUsd = Number.isFinite(result.total_cost_usd) ? result.total_cost_usd : null;
  if (result.is_error || (typeof result.subtype === 'string' && result.subtype !== 'success')) {
    throw Object.assign(failure(result.result ?? result.subtype, 'Claude Code が採点でエラーを返しました'), { costUsd });
  }
  let output = isPlainObject(result.structured_output) ? result.structured_output : null;
  if (!output && typeof result.result === 'string') {
    try {
      const parsed = JSON.parse(result.result.trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/, '$1'));
      if (isPlainObject(parsed)) output = parsed;
    } catch {
      // 下で壊れた出力として扱う
    }
  }
  if (!output || !Number.isInteger(output.score) || output.score < 1 || output.score > 5) {
    throw Object.assign(new ConnectionError('failed', '採点の出力に 1 から 5 の score がありませんでした'), { costUsd });
  }
  // 使ったモデルの名前(modelUsage のキー)。採点のモデルを結果に残すため
  const models = isPlainObject(result.modelUsage) ? Object.keys(result.modelUsage).filter((name) => MODEL_NAME_PATTERN.test(name)) : [];
  return { score: output.score, reason: redact(String(output.reason ?? '')).slice(0, 300), costUsd, models };
}

// 採点の接続。model は --model に渡す名前(なければ Claude Code の既定のモデル。使ったモデルは結果の modelUsage から残す)
export function createClaudeCodeJudge({ env = process.env, model = null, limits = JUDGE_LIMITS } = {}) {
  if (model !== null && !MODEL_NAME_PATTERN.test(model)) throw new TypeError(`採点のモデルの名前の形が正しくありません: ${JSON.stringify(model)}`);
  const binName = env.STUDIO_CLAUDE_BIN || 'claude';
  const running = new Set();
  let workDir = null;
  return {
    kind: 'claude-code',
    model,
    times: limits.times,
    // 結果に残す、採点の起動の形と決まり(観点の文は場面ごとに違うので、決まりの頭だけ)
    describe() {
      return {
        command: [path.basename(binName), ...shownArgs(buildJudgeArgs({ aspect: '観点', rubric: '観点の文', model }))],
        systemPrompt: judgeSystemPrompt({ aspect: '<観点>', rubric: '<場面の rubric>' }),
        times: limits.times,
      };
    },
    // 1 回採点する。返す: { score, reason, costUsd, models, ms }。失敗は投げる(error.costUsd に分かった費用。
    // 起動する前の失敗は error.launched が false で、費用も起動も数えない)
    async score({ item, scenario, replies, signal }) {
      const notLaunched = (error) => Object.assign(error, { launched: false });
      const bin = findExecutable(binName, env);
      if (!bin) throw notLaunched(new ConnectionError('not-found', `Claude Code が見つかりません(${binName})`));
      if (signal?.aborted) throw notLaunched(new ConnectionError('cancelled', '採点を止めました'));
      // cwd は空の一時フォルダー。道具は渡さないが、読める場所を作らないため
      if (!workDir || !fs.existsSync(workDir)) workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-judge-'));
      const started = Date.now();
      const parsed = await runCli({
        bin,
        args: buildJudgeArgs({ aspect: item.aspect, rubric: item.rubric, model }),
        input: judgeInput({ scenario, replies }),
        cwd: workDir,
        env,
        signal,
        limits,
        running,
        parse: parseJudgeResult,
      });
      return { ...parsed, ms: Date.now() - started };
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
