// 作る AI(Claude Code)の起動引数。偽接続でも実接続でも同じものを使う(ADR-0001 の「作る AI の起動」、ADR-0002)。
// 依頼の文は argv に入れず、stdin で渡す。
import { readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// コマンド実行と Web は名前で入れない。読み書きと検索だけ
export const AGENT_TOOLS = 'Read,Edit,Write,Glob,Grep';
// 観察の道具の MCP サーバー(jyoka/tasks#311)の名前と、その道具の決まった名前(src/server/observe-mcp.js の TOOL_NAMES)。
// 許可はワイルドカードを使わず、名前を並べる(S10)。道具が増えたら、ここも直さないと渡らない
export const OBSERVE_SERVER = 'observe';
export const OBSERVE_TOOL_NAMES = Object.freeze(['open', 'read_page', 'inspect', 'click', 'type', 'scroll', 'set_viewport', 'screenshot', 'run_scenarios']);
export const OBSERVE_TOOLS = Object.freeze(OBSERVE_TOOL_NAMES.map((name) => `mcp__${OBSERVE_SERVER}__${name}`));
export const ALLOWED_TOOLS = [AGENT_TOOLS, ...OBSERVE_TOOLS].join(',');
// 作る run ごとの MCP の設定のファイルの名前。.studio/runs/<run-id>/ に置く(app/ の外)
export const MCP_CONFIG_FILE = 'mcp.json';
const OBSERVE_MCP_BIN = fileURLToPath(new URL('../../bin/observe-mcp.js', import.meta.url));
export const MAX_TURNS = 30;
export const DEFAULT_MAX_BUDGET_USD = 1;

// 既定の素材の指針の要約(docs/design/design-materials.md の 3 節)。起動のたびに同じ文を渡す
export const DEFAULT_MATERIAL_GUIDE = readFileSync(new URL('../../materials/default/guide.md', import.meta.url), 'utf8').trim();

export const STUDIO_SYSTEM_PROMPT = [
  'あなたは Prototype Studio の「作る AI」です。利用者の依頼に沿って、作業ディレクトリ(試作品の app/)の中のファイルだけを読み書きしてください。',
  '- 入口は main.jsx(または main.tsx、main.js、main.ts)です。Studio が esbuild で 1 つの script に束ね、ブラウザの sandbox の中で動かします。',
  '- 目録 prototype.json を app/ の直下に置き、依頼に沿って更新してください。形: {"formatVersion": 1, "title": 名前, "entry": "main.jsx", "intent": {"purpose": 目的, "tryThis": [試してほしいこと]}, "constraints": [制約], "unimplemented": [本番で作るもの], "data": [{"file": 架空のデータのファイル, "about": 中身}], "ai": "ai.json", "scenarios": "scenarios"}。',
  '  パスは app/ からの相対で、app/ の外は指せません。プロダクト内 AI を使わないなら ai は書きません。形が誤っているとビルドが止まります。',
  '- import できるライブラリは、react、react-dom、Studio が同梱するトーク風の会話の枠 studio-talk(import { Talk } from "studio-talk")と、下の既定の素材だけです。npm install はできません。',
  '- fetch や外部の URL は使えません。データは架空のものを app/ の中に書いてください。実在の人物や会社のデータは使わないでください。',
  '- CLAUDE.md、.claude/、.mcp.json、.git、node_modules、シンボリックリンクは作らないでください。Studio のビルドが止まります。',
  '- コマンドは実行できません。ビルドと最後の確認は Studio が行い、結果を利用者に見せます。',
  '- 観察の道具(mcp__observe__ で始まる道具)で、作業中の app/ を開いて画面を確かめられます。直した後は open で開き、read_page や screenshot で画面を見て、run_scenarios でシナリオを回してください。',
  '  観察の道具は app/ を書き換えません。通ったかを決めるのは Studio の確かめです。',
  '',
  DEFAULT_MATERIAL_GUIDE,
].join('\n');

// AI 構成の審査で 4 つを承認した試作品だけに足す決まり(docs/design/ai-architecture-review.md の 6 節。review.js)。
// 審査のない試作品には足さない(今の振る舞いを変えない。R2)
export const REVIEW_RULE = '- この試作品は、AI 構成の審査で人が構成を承認しています。承認した構成のファイル(構成 composition.json、AI の設定、ツールの宣言、プロンプトの枠、前提)は変えないでください。変えたいときは、変えずに言葉で知らせてください。変えると Studio の確かめで止まり、審査に戻ります。';

function present(env, name) {
  return typeof env[name] === 'string' && env[name] !== '';
}

// どの認証と課金で動くかを、環境変数の「有無」だけから見積もる。値は読まない、保存しない。
// 順番は Claude Code の認証の優先順位(クラウド、ANTHROPIC_AUTH_TOKEN、ANTHROPIC_API_KEY、
// CLAUDE_CODE_OAUTH_TOKEN、本人のログイン)に合わせた。実際に使われたものは、実行の後に
// Claude Code が報告する apiKeySource で確かめる。
export function describeBilling(env = process.env) {
  for (const name of ['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY']) {
    if (present(env, name)) {
      return { mode: 'cloud', envName: name, text: `クラウド経由(${name})で動きます。料金はそのクラウドの契約にかかります。` };
    }
  }
  if (present(env, 'ANTHROPIC_AUTH_TOKEN')) {
    return { mode: 'auth-token', envName: 'ANTHROPIC_AUTH_TOKEN', text: 'ANTHROPIC_AUTH_TOKEN で動きます。料金は、そのトークンを出した先の契約にかかります。' };
  }
  if (present(env, 'ANTHROPIC_API_KEY')) {
    return {
      mode: 'api-key',
      envName: 'ANTHROPIC_API_KEY',
      text: 'API キー(ANTHROPIC_API_KEY)で動きます。API の料金がかかります。サブスクの枠では動きません。',
    };
  }
  if (present(env, 'CLAUDE_CODE_OAUTH_TOKEN')) {
    return { mode: 'oauth-token', envName: 'CLAUDE_CODE_OAUTH_TOKEN', text: '本人のトークン(CLAUDE_CODE_OAUTH_TOKEN)で、サブスクの枠で動く見込みです。' };
  }
  return {
    mode: 'login',
    envName: null,
    text: '本人のログイン(claude で /login したもの)で動く見込みです。ANTHROPIC_API_KEY はありません。claude.ai のサブスクでログインしていればサブスクの枠で、Console(API)のアカウントでログインしていれば API の料金で動きます。',
  };
}

// サブスクの枠でないときは、費用の上限も付ける
export function needsBudget(billing) {
  return billing.mode !== 'login' && billing.mode !== 'oauth-token';
}

// 観察の道具の MCP サーバーを 1 つだけ持つ設定。プロジェクトの場所は起動の引数でだけ渡す(bin/observe-mcp.js)。
// サーバーは作る AI の子として動き、作る AI が終われば入力が閉じて終わる。maxSeconds は、その前に止まる上限
export function observeMcpConfig({ projectDir, maxSeconds }) {
  return {
    mcpServers: {
      [OBSERVE_SERVER]: {
        type: 'stdio',
        command: process.execPath,
        args: [OBSERVE_MCP_BIN, projectDir, '--max-seconds', String(Math.max(1, Math.ceil(maxSeconds)))],
      },
    },
  };
}

// MCP の設定のファイルを dir(app/ の外。作る run のフォルダー)に書き、そのパスを返す
export async function writeObserveMcpConfig({ dir, projectDir, maxSeconds }) {
  const file = path.join(dir, MCP_CONFIG_FILE);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(observeMcpConfig({ projectDir, maxSeconds }), null, 2)}\n`);
  return file;
}

// 守り(ADR-0002 の「--safe-mode の代わり」): --safe-mode は --mcp-config のサーバーも外すので使わない。
// 利用者の設定を持ち込まないことは、公開の引数の組み合わせで保つ。
//   --restricted: 利用者、プロジェクト、手元の設定のファイルを読まない(hooks、設定で有効にした plugins、CLAUDE.md)。
//                 コマンドと Web の道具を外し、ファイルの道具を作業ディレクトリ(app/)に閉じ込める
//   --setting-sources "": 設定の読み込み元を 1 つも使わない(CLAUDE.md の読み込みもこれに従う)
//   --disable-slash-commands: skills と commands を外す
//   --strict-mcp-config --mcp-config <file>: MCP は観察の道具のサーバーだけ
// materialGuide はつないだ素材の決まり(design-tokens.js の tokensGuide と guides.js の guidesRule。materials.js の materialRule)。つないでいなければ足さない
// reviewed は、AI 構成の審査で承認した試作品か(REVIEW_RULE を足す)
export function buildClaudeArgs({ billing, mcpConfig, maxBudgetUsd = DEFAULT_MAX_BUDGET_USD, materialGuide = null, reviewed = false }) {
  if (typeof mcpConfig !== 'string' || mcpConfig === '') throw new TypeError('mcpConfig(MCP の設定のファイル)を渡してください');
  const args = [
    '-p',
    '--restricted',
    '--setting-sources',
    '',
    '--disable-slash-commands',
    '--tools',
    AGENT_TOOLS,
    '--allowedTools',
    ALLOWED_TOOLS,
    '--permission-mode',
    'dontAsk',
    '--permission-prompts',
    'none',
    '--strict-mcp-config',
    '--mcp-config',
    mcpConfig,
    '--no-session-persistence',
    '--output-format',
    'stream-json',
    '--verbose',
    '--max-turns',
    String(MAX_TURNS),
    '--append-system-prompt',
    [STUDIO_SYSTEM_PROMPT, materialGuide, reviewed ? REVIEW_RULE : null].filter(Boolean).join('\n'),
  ];
  if (needsBudget(billing)) args.push('--max-budget-usd', String(maxBudgetUsd));
  return args;
}
