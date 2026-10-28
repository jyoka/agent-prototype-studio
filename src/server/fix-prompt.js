// 直す依頼(docs/design/harness.md の 2.3)。関門の失敗を、決まった型の文にして作る AI に返す。
// 作る AI に渡す文脈を絞る(S14): 元の依頼、直前のラウンドで失敗した関門の名前と結果(8,000 文字まで)、
// 変わったファイルの名前だけ。前の会話、全部の report、スクリーンショットの場所は入れない。

export const MAX_FAILURE_CHARS = 8000;
// 変わったファイルの名前は、この数までを書く
export const MAX_FIX_FILES = 100;
const REQUEST_HEAD = '前の依頼: ';
const GATE_HEAD = 'Studio が確かめたところ、次の関門で失敗しました: ';
const FILES_HEAD = '変わったファイル: ';
const CLOSING = '失敗だけを直してください。シナリオ(app/scenarios/)を弱めたり消したりして通さないでください。';
const CLIPPED = '\n(長いので、ここで切りました)';

export const ERROR_KIND_TEXT = {
  runtime: '実行時のエラー',
  'console-error': 'console.error',
  'unhandled-rejection': '処理されない reject',
  timeout: '時間切れ',
  build: 'ビルドのエラー',
};

function where(error) {
  if (!error.line) return error.file;
  return error.column ? `${error.file}:${error.line}:${error.column}` : `${error.file}:${error.line}`;
}

// 関門の結果(run.gates の 1 つ)から、失敗の中身を文にする。ビルドの段はファイルと行とメッセージ、
// 起動の確認は要約とエラーの種類とメッセージ。report の場所や読み込みの時間は入れない
export function describeFailure(gate) {
  const lines = [];
  // 要約はエラーの 1 件目と重なるので、エラーがないとき(画面が空など)だけ書く
  if (gate.summary && !gate.errors?.length) lines.push(gate.summary);
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

// request: 利用者の依頼の文。gate: 直前のラウンドで失敗した関門(id、label と結果)。changedFiles: 依頼の前から変わったファイル
export function buildFixPrompt({ request, gate, changedFiles }) {
  return [
    `${REQUEST_HEAD}${request}`,
    `${GATE_HEAD}${gate.id} ${gate.label}`,
    clipFailure(describeFailure(gate)),
    `${FILES_HEAD}${fileNames(changedFiles)}`,
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
