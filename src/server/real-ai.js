import { describeBilling, needsBudget } from './claude-args.js';
import { CLAUDE_CODE_LIMITS, PROVIDER_ENV } from './product-ai/claude-code.js';
import { CALL_LIMITS } from './product-ai/limits.js';
import { DESIGN_AI_LIMITS } from './design-ai.js';
import { INTENT_AI_LIMITS } from './intent-ai.js';
import { ORGANIZE_AI_LIMITS } from './organize-ai.js';

// 本物の AI(利用者の Claude Code)を使う前の同意(docs/design/ux-redesign.md の 6 節、ADR-0001 の T6)。
// 同意は 1 つで、直す AI の送信、試作品の中の AI の本物への切り替え、人の「確かめる」、目的の聞き出し、ヒアリングの整理、設計の案の全部に効く。
// Studio のメモリーにだけ持ち、Studio を起動し直すと消える(ディスクには覚えない。ux-redesign.md の 11 節)。
// 偽接続とお試しの AI(モック)は、同意なしで使える。

// 同意の前に断るときの理由のコード
export const CONSENT_REQUIRED = 'consent-required';

// 何に使おうとして断ったか。断る文に入れる
const USES = {
  fix: '言葉で直す',
  product: '試作品の中の AI を本物の AI にする',
  check: '本物の AI で確かめる',
  intent: '本物の AI で目的を聞き出す',
  organize: '本物の AI でヒアリングを整理する',
  design: '本物の AI で設計の案を出す',
};

export class ConsentRequiredError extends Error {
  constructor(use) {
    super(`${USES[use] ?? '本物の AI を使う'}には、本物の AI を使うことへの同意が要ります`);
    this.code = CONSENT_REQUIRED;
    this.use = use;
    this.next = '送るもの、送り先、料金を確かめて同意してから、もう一度試してください。同意は Studio を止めるまで有効です。';
  }
}

const present = (env, name) => typeof env[name] === 'string' && env[name] !== '';

// claude auth status の方式(agent-connection.js の parseAuthStatus)ごとの、料金の 1 文
const METHOD_TEXT = {
  'claude.ai': 'Claude のアカウントでログインしているので、そのプランの利用枠を使います。',
  api_key: 'API キーで動くので、使った分だけ料金がかかります。',
  oauth_token: 'ログインのトークンで動くので、Claude のプランの利用枠を使います。',
  third_party: '送り先と料金は、あなたの PC の設定に従います。',
};
const UNKNOWN_TEXT = 'Claude の定額プランなら、その利用枠を使います。従量課金のアカウントなら、使った分だけかかります。どちらかは、この画面からは分かりません。';
const TO_ANTHROPIC = 'Anthropic(Claude を作っている会社)';
const TO_SETTINGS = 'あなたの PC の設定で決まった送り先';

const perTurnTotal = () => Object.values(CALL_LIMITS.perTurn).reduce((sum, n) => sum + n, 0);

// 上限の文。数は設定の値から作る(直すときは STUDIO_MAX_BUDGET_USD と、1 つの依頼の起動の回数。話すときは CLAUDE_CODE_LIMITS と CALL_LIMITS)。
// 直す AI の費用の上限(--max-budget-usd)は起動ごとに効き、定額プランの枠で動く見込みのときは付けない(claude-args.js の needsBudget)
export function limitsText({ fixBudgetUsd, fixLaunches, fixHasBudget }) {
  const launches = `1 つの依頼で多くて ${fixLaunches} 回起動します`;
  const fix = fixHasBudget
    ? `直すときは、直す AI の 1 回の起動で ${fixBudgetUsd} ドルまでです(${launches})。`
    : `直すときの 1 回の起動で ${fixBudgetUsd} ドルの上限は、API キーなどの設定で動くときに付けます(${launches})。`;
  const hours = CALL_LIMITS.windowMs / (60 * 60 * 1000);
  const product = `試作品の中の AI と話すときは 1 回の呼び出しで ${CLAUDE_CODE_LIMITS.maxBudgetUsd} ドルまで、1 ターンで ${perTurnTotal()} 回まで、試作品ごとに ${hours} 時間に ${CALL_LIMITS.perProject} 回まで呼びます。`;
  return `${fix}${product}`;
}

// 料金の文を利用者の言葉で返す(ux-redesign.md の 6 節)。分かることだけを出す。環境変数は「あるか」だけを見て、値も名前も出さない。
// 順番は Claude Code の認証の優先順位に合わせる: 送り先を変える設定、API キー、ログインの方式(claude auth status)
// kind: settings(Bedrock などの設定)、api-key(API キーの設定)、account(方式が分かる)、unknown(分からない)
export function describeCost({ env = {}, auth = null, fixBudgetUsd, fixLaunches }) {
  const limits = limitsText({ fixBudgetUsd, fixLaunches, fixHasBudget: needsBudget(describeBilling(env)) });
  if (PROVIDER_ENV.some((name) => present(env, name))) {
    return { kind: 'settings', to: TO_SETTINGS, text: METHOD_TEXT.third_party, limits };
  }
  if (present(env, 'ANTHROPIC_API_KEY')) {
    return { kind: 'api-key', to: TO_ANTHROPIC, text: 'API キーの設定があるので、使った分だけ料金がかかります。', limits };
  }
  const method = present(env, 'CLAUDE_CODE_OAUTH_TOKEN') ? 'oauth_token' : auth?.method;
  if (Object.hasOwn(METHOD_TEXT, method ?? '')) {
    return { kind: 'account', method, to: method === 'third_party' ? TO_SETTINGS : TO_ANTHROPIC, text: METHOD_TEXT[method], limits };
  }
  return { kind: 'unknown', to: TO_ANTHROPIC, text: UNKNOWN_TEXT, limits };
}

// 同意の状態。startStudio が 1 つ作り、直す AI(BuildRequests)と試作品の中の AI(AiSessions)に渡す。
// 本物の AI を使う口は、使う前に require() を呼ぶ
export class RealAiConsent {
  constructor() {
    this.agreedAt = null;
  }

  get agreed() {
    return this.agreedAt !== null;
  }

  // 同意する。2 回目からは、最初に同意した時刻のまま
  agree(now = new Date()) {
    this.agreedAt ??= now.toISOString();
    return this.state();
  }

  state() {
    return { agreed: this.agreed, agreedAt: this.agreedAt };
  }

  // 本物の AI を使う前に呼ぶ。同意の前は投げる。use は fix、product、check、intent、organize、design のどれか
  require(use) {
    if (!this.agreed) throw new ConsentRequiredError(use);
  }
}

// 直す AI の「詳しく」。送るものと、渡す道具と、作る AI に足す指示の全文
function fixDetails({ agent, systemPrompt }) {
  if (agent.kind !== 'claude') return null;
  return {
    items: ['頼んだ文', '試作品のファイル(直す AI が読み書きするもの)', '自動の確かめで見つかった問題(直し直すとき)'],
    notSent: 'PC のほかのファイル、ほかの試作品は送りません。直す AI は試作品のフォルダーの外を読み書きできません。',
    tools: '試作品のファイルの読み書きと検索、試作品の画面を見る道具だけを渡します。コマンドの実行と Web は渡しません。',
    systemPrompt,
  };
}

// 目的の聞き出しの「詳しく」。送るものと、渡す道具と、聞き出す AI への指示の全文
function intentDetails({ intentPrompt }) {
  return {
    items: ['書いた 1 文', 'これまでの問いと答え', '今の目的の文書の下書き'],
    notSent: '試作品のファイル、PC のほかのファイル、ほかの試作品は送りません。',
    tools: '聞き出す AI には道具を渡しません。ファイル、コマンド、Web は使えません。',
    limits: `1 回の呼び出しで ${INTENT_AI_LIMITS.maxBudgetUsd} ドルまで、1 回の答えで多くて ${INTENT_AI_LIMITS.attempts} 回呼びます。問いの数の上限は、案内の深さで決まります。`,
    systemPrompt: intentPrompt,
  };
}

// ヒアリングの整理の「詳しく」。送るものと、渡す道具と、整理する AI への指示の全文
function organizeDetails({ organizePrompt }) {
  return {
    items: ['打った要点', '人が決めた項目', '人が消したもの'],
    notSent: '試作品のファイル、PC のほかのファイル、ほかの試作品は送りません。',
    tools: '整理する AI には道具を渡しません。ファイル、コマンド、Web は使えません。',
    limits: `1 回の呼び出しで ${ORGANIZE_AI_LIMITS.maxBudgetUsd} ドルまで、「整理する」を 1 回押すごとに多くて ${ORGANIZE_AI_LIMITS.attempts} 回呼びます。Studio が勝手には呼びません。`,
    systemPrompt: organizePrompt,
  };
}

// 設計の案の「詳しく」。送るものと、渡す道具と、案を出す AI への指示の全文
function designDetails({ designPrompt }) {
  return {
    items: ['書いた 1 文(なければ、試作品の名前と目的の 1 文)', '決めた目的の文書', '整理の板の項目'],
    notSent: '試作品の画面のソース、PC のほかのファイル、ほかの試作品は送りません。',
    tools: '案を出す AI には道具を渡しません。ファイル、コマンド、Web は使えません。',
    limits: `1 回の呼び出しで ${DESIGN_AI_LIMITS.maxBudgetUsd} ドルまで、案を作るごとに多くて ${DESIGN_AI_LIMITS.attempts} 回呼びます。Studio が勝手には呼びません。`,
    systemPrompt: designPrompt,
  };
}

// 「詳しく」の記録の扱い。直す AI の結果は build-requests.js の evidence、試作品の中の AI の記録は AiSessions の trace(ADR-0001 の #277)
const RECORDS = [
  '言葉で直したときの結果(変えたファイル、確かめた結果、かかった時間と費用)は、試作品のフォルダーの中の .studio/runs に残ります。',
  '試作品の中の AI とのやりとりの記録は、Studio のメモリーにだけ置き、Studio を止めると消えます。記録では、メールアドレスや API キーらしい文字列を伏せます。',
  '目的の聞き出しの 1 文、問いと答え、目的の文書は、試作品のフォルダーの中の .studio/intent.json に残ります。',
  'ヒアリングの要点と整理の板は、試作品のフォルダーの中の .studio/organize.json に残ります。',
  '設計の案と選んだ案は、試作品のフォルダーの中の .studio/design.json に残ります。',
];

// 同意のカード(画面は P25)に出す中身。product は試作品の中の AI の「詳しく」(AiSessions.realDetails)で、試作品を選んだときだけ
// fixLaunches は、1 つの依頼で直す AI を起動する回数の上限(build-requests.js の MAX_FIX_ROUNDS + 1)
export function consentView({ consent, env, agent, fixBudgetUsd, fixLaunches, systemPrompt, intentPrompt, organizePrompt, designPrompt, productAllowed, product = null }) {
  const cost = describeCost({ env, auth: agent.auth, fixBudgetUsd, fixLaunches });
  return {
    consent: consent.state(),
    // 本物の AI を使える口。直す AI は作る AI の接続が Claude Code で、使えるとき。試作品の中の AI は STUDIO_ALLOW_CLAUDE_CODE=0 でないとき
    uses: {
      fix: { real: agent.kind === 'claude', ready: agent.kind === 'claude' && !agent.problem },
      product: { allowed: productAllowed },
    },
    summary: {
      runsOn: 'AI は、あなたの Claude Code で動きます。',
      sends: ['頼んだ文と試作品のファイル(言葉で直すとき)', '試作品の中の会話と AI の設定(本物の AI と話すとき)', '書いた 1 文と問いへの答え(目的を聞き出すとき)', '打った要点と整理の板の項目(ヒアリングを整理するとき)', '書いた 1 文、目的の文書、整理の板の項目(設計の案を出すとき)'],
      notSent: 'PC のほかのファイル、ほかの試作品',
      to: cost.to,
      cost,
      note: '架空のデータだけで試してください。実在の人や会社の情報は入れないでください。',
    },
    details: { fix: fixDetails({ agent, systemPrompt }), intent: agent.kind === 'claude' && intentPrompt ? intentDetails({ intentPrompt }) : null, organize: agent.kind === 'claude' && organizePrompt ? organizeDetails({ organizePrompt }) : null, design: agent.kind === 'claude' && designPrompt ? designDetails({ designPrompt }) : null, product, records: RECORDS },
  };
}
