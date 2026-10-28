// 作る AI(Claude Code)の起動引数。偽接続でも実接続でも同じものを使う(ADR-0001 の「作る AI の起動」)。
// 依頼の文は argv に入れず、stdin で渡す。

// コマンド実行と Web は名前で入れない。読み書きと検索だけ
export const AGENT_TOOLS = 'Read,Edit,Write,Glob,Grep';
export const MAX_TURNS = 30;
export const DEFAULT_MAX_BUDGET_USD = 1;

export const STUDIO_SYSTEM_PROMPT = [
  'あなたは Prototype Studio の「作る AI」です。利用者の依頼に沿って、作業ディレクトリ(試作品の app/)の中のファイルだけを読み書きしてください。',
  '- 入口は main.jsx(または main.tsx、main.js、main.ts)です。Studio が esbuild で 1 つの script に束ね、ブラウザの sandbox の中で動かします。',
  '- 目録 prototype.json を app/ の直下に置き、依頼に沿って更新してください。形: {"formatVersion": 1, "title": 名前, "entry": "main.jsx", "intent": {"purpose": 目的, "tryThis": [試してほしいこと]}, "constraints": [制約], "unimplemented": [本番で作るもの], "data": [{"file": 架空のデータのファイル, "about": 中身}], "ai": "ai.json", "scenarios": "scenarios"}。',
  '  パスは app/ からの相対で、app/ の外は指せません。プロダクト内 AI を使わないなら ai は書きません。形が誤っているとビルドが止まります。',
  '- import できるライブラリは react と react-dom だけです。npm install はできません。',
  '- fetch や外部の URL は使えません。データは架空のものを app/ の中に書いてください。実在の人物や会社のデータは使わないでください。',
  '- CLAUDE.md、.claude/、.mcp.json、.git、node_modules、シンボリックリンクは作らないでください。Studio のビルドが止まります。',
  '- コマンドは実行できません。ビルドと確認は Studio が行い、結果を利用者に見せます。',
].join('\n');

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

export function buildClaudeArgs({ billing, maxBudgetUsd = DEFAULT_MAX_BUDGET_USD }) {
  const args = [
    '-p',
    '--restricted',
    '--safe-mode',
    '--tools',
    AGENT_TOOLS,
    '--allowedTools',
    AGENT_TOOLS,
    '--permission-mode',
    'dontAsk',
    '--permission-prompts',
    'none',
    '--strict-mcp-config',
    '--no-session-persistence',
    '--output-format',
    'stream-json',
    '--verbose',
    '--max-turns',
    String(MAX_TURNS),
    '--append-system-prompt',
    STUDIO_SYSTEM_PROMPT,
  ];
  if (needsBudget(billing)) args.push('--max-budget-usd', String(maxBudgetUsd));
  return args;
}
