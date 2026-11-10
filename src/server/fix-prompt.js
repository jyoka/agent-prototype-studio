// 直す依頼(docs/design/harness.md の 2.3)。関門の失敗を、決まった型の文にして作る AI に返す。
// 作る AI に渡す文脈を絞る(S14): 元の依頼、直前のラウンドで失敗した関門の名前と結果(8,000 文字まで。
// シナリオの失敗は、シナリオの名前、失敗した手順、期待と実際、そのときの画面の文字。
// 場面(関門 GE)の失敗は、場面の id、通らなかった確かめ、期待と実際、ツールの呼び出しの要約)、
// 変わったファイルの名前だけ。前の会話、全部の report、スクリーンショットの場所は入れない。

export const MAX_FAILURE_CHARS = 8000;
// 変わったファイルの名前は、この数までを書く
export const MAX_FIX_FILES = 100;
const REQUEST_HEAD = '前の依頼: ';
const GATE_HEAD = 'Studio が確かめたところ、次の関門で失敗しました: ';
const FILES_HEAD = '変わったファイル: ';
const CLOSING = '失敗だけを直してください。シナリオ(app/scenarios/)、場面(app/evals/)、ガードレール(構成の guards、tools.json の守り、ai.json の rules)を弱めたり消したりして通さないでください。';
// AI 構成の審査で承認した試作品だけに足す行(review.js)。CLOSING の前に置く(readFixPrompt は CLOSING で終わるかを見る)
export const REVIEW_LINE = 'AI 構成の審査で承認した構成のファイル(構成、AI の設定、ツールの宣言、プロンプトの枠、前提)は変えないでください。変えたいときは言葉で知らせてください。';
const CLIPPED = '\n(長いので、ここで切りました)';

export const ERROR_KIND_TEXT = {
  runtime: '実行時のエラー',
  'console-error': 'console.error',
  'unhandled-rejection': '処理されない reject',
  timeout: '時間切れ',
  build: 'ビルドのエラー',
  evals: '場面の回しの誤り',
};

function where(error) {
  if (!error.line) return error.file;
  return error.column ? `${error.file}:${error.line}:${error.column}` : `${error.file}:${error.line}`;
}

// シナリオ 1 本の失敗(関門 G6 の failures の 1 つ): シナリオの名前、失敗した手順、期待と実際、そのときの画面の文字
function describeScenarioFailure(failure) {
  const name = failure.base ? `Studio の基本のシナリオ「${failure.scenario}」` : `シナリオ「${failure.scenario}」${failure.file ? `(${failure.file})` : ''}`;
  const lines = [failure.step ? `${name}の ${failure.step} 番目の手順で失敗しました` : `${name}で失敗しました`];
  if (failure.expected) lines.push(`期待: ${failure.expected}`);
  lines.push(`実際: ${failure.actual}`);
  if (failure.pageText) lines.push(`そのときの画面の文字: ${failure.pageText}`);
  return lines;
}

// 場面 1 つの通らなかった確かめ(関門 GE の failures の 1 つ): 場面の id、確かめ、期待と実際、ツールの呼び出しの要約
function describeEvalFailure(failure) {
  const name = `場面「${failure.eval}」${failure.file ? `(${failure.file})` : ''}`;
  const lines = [failure.check ? `${name}の確かめ「${failure.check}」が通りませんでした` : `${name}を回せませんでした`];
  if (failure.expected) lines.push(`期待: ${failure.expected}`);
  lines.push(`実際: ${failure.actual}`);
  lines.push(`ツールの呼び出し: ${failure.tools || 'なし'}`);
  return lines;
}

// 関門の結果(run.gates の 1 つ)から、失敗の中身を文にする。ビルドの段はファイルと行とメッセージ、
// 起動の確認は要約とエラーの種類とメッセージ、シナリオは失敗したシナリオごとの手順と期待と実際。
// report の場所や読み込みの時間、スクリーンショットは入れない
export function describeFailure(gate) {
  const lines = [];
  // 要約はエラーやシナリオの 1 件目と重なるので、どちらもないとき(画面が空など)だけ書く
  if (gate.summary && !gate.errors?.length && !gate.failures?.length) lines.push(gate.summary);
  for (const failure of gate.failures ?? []) lines.push(...(failure.eval !== undefined ? describeEvalFailure(failure) : describeScenarioFailure(failure)));
  const moreScenarios = (gate.failedCount ?? 0) - (gate.failures?.length ?? 0);
  if (moreScenarios > 0) lines.push(gate.name === 'evals' ? `ほか ${moreScenarios} 件の確かめも通りませんでした` : `ほか ${moreScenarios} 本のシナリオも失敗しました`);
  for (const error of gate.errors ?? []) {
    if (error.text !== undefined) lines.push(`${where(error)} ${error.text}`);
    else lines.push(`${ERROR_KIND_TEXT[error.kind] ?? error.kind}: ${error.message}`);
  }
  const more = (gate.errorCount ?? 0) - (gate.errors?.length ?? 0);
  if (more > 0) lines.push(`ほか ${more} 件`);
  return lines.length > 0 ? lines.join('\n') : '失敗の中身は記録されていません';
}

export function clipFailure(text) {
  if (text.length <= MAX_FAILURE_CHARS) return text;
  return text.slice(0, MAX_FAILURE_CHARS - CLIPPED.length) + CLIPPED;
}

function fileNames(changedFiles) {
  if (changedFiles.length === 0) return 'なし';
  const names = changedFiles.slice(0, MAX_FIX_FILES).map((change) => change.file);
  const more = changedFiles.length - names.length;
  return `${names.join('、')}${more > 0 ? ` ほか ${more} 個` : ''}`;
}

// request: 利用者の依頼の文。gate: 直前のラウンドで失敗した関門(id、label と結果)。changedFiles: 依頼の前から変わったファイル。
// reviewed: AI 構成の審査で承認した試作品か
export function buildFixPrompt({ request, gate, changedFiles, reviewed = false }) {
  return [
    `${REQUEST_HEAD}${request}`,
    `${GATE_HEAD}${gate.id} ${gate.label}`,
    clipFailure(describeFailure(gate)),
    `${FILES_HEAD}${fileNames(changedFiles)}`,
    ...(reviewed ? [REVIEW_LINE] : []),
    CLOSING,
  ].join('\n');
}

// 直す依頼の文から、元の依頼と失敗した関門を読む。直す依頼でなければ null(偽接続とテストが使う)
export function readFixPrompt(text) {
  if (!text.startsWith(REQUEST_HEAD)) return null;
  // 元の依頼に同じ文が入っていても、Studio が書いた行(最後のもの)を読む
  const at = text.lastIndexOf(`\n${GATE_HEAD}`);
  if (at === -1 || !text.trimEnd().endsWith(CLOSING)) return null;
  const gateLine = text.slice(at + 1 + GATE_HEAD.length).split('\n')[0];
  return { request: text.slice(REQUEST_HEAD.length, at), gate: gateLine };
}
