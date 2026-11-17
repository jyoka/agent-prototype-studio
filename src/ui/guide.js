// 案内の部品(docs/design/ui-ux-v2.md の 5 節)。12 の状態の印と言葉(5.4)と、「これは何?」の 3 つの問い(5.2)。
// 画面(studio.js)が使う。言葉はここにまとめ、ui-ux-v2.md の 5.4 の表と同じにする。
// どの状態も「何が起きたか、今どうなっているか、次に何をするか」を、この順に 1 文ずつ出す。
// 読み込んだだけでは画面に触らない(単体のテストが Node で読むため)。作る関数は呼んだときだけ document を使う

// 12 の状態。mark は 5.4 の印(画面では CSS の ::before で出す。読み上げは 3 つの文で足りるので読ませない)。
// words は 3 つの文を返す。文の中の数と名前は、呼ぶ側が渡す
export const STATES = {
  first: {
    name: 'はじめて',
    mark: '─',
    // none は、試作品が 1 つもないか。ほかの試作品があるときは、新しく始めることを言う
    words: ({ none = true } = {}) => [
      none ? 'まだ試作品はありません。' : '新しい試作品を、1 文から始めます。',
      'ラフな 1 文で大丈夫です。',
      'たとえば「お店への問い合わせに AI が答えられるようにしたい」と書いて、送りますか。',
    ],
  },
  working: {
    name: 'AI が作業中',
    mark: '●',
    words: ({ who = '作る AI ', doing = '試作品を書いています', now = '止めても、前の版は残ります。', next = 'その間に、足りない場面がないか見てみませんか。' } = {}) => [`${who}が${doing}。`, now, next],
  },
  'gate-failed': {
    name: '関門で落ちた',
    mark: '× ⬢',
    words: ({ gate = null } = {}) => [
      `${gate ? `「${gate}」で落ち、` : ''}作る AI が直しきれませんでした。`,
      '前に動いた版を出しています。',
      '頼み方を変えて、もう一度試しますか。',
    ],
  },
  'guard-stopped': {
    name: '守りが止めた',
    mark: '⬢ 止めました',
    words: ({ what = '試作品のフォルダーの外を触る操作', now = '失敗ではなく守りが働いた印で、試作品は前のままです。', next = '試作品の中で済む頼み方に、言い換えますか。' } = {}) => [`守りが、${what}を止めました。`, now, next],
  },
  'mode-trial': {
    name: 'お試しか本物か',
    mark: '○',
    words: () => ['今は、お試しの AI だけを使っています。', '料金はかからず、外には何も送っていません。', '本物の AI を使うときは、送る前に同意を聞きます。'],
  },
  'mode-real': {
    name: 'お試しか本物か',
    mark: '◉',
    words: ({ at = null } = {}) => [
      `${at ? `${at}に、` : ''}本物の AI を使うことに同意しました。`,
      'AI はあなたの Claude Code で動き、同意は Studio を止めるまで効きます。',
      '送るものと料金は、下の中身で読み直せます。',
    ],
  },
  consent: {
    name: '同意',
    mark: '◉',
    words: () => ['本物の AI を使うには、あなたの同意が要ります。', 'まだ何も送っていません。', '送るもの、送り先、料金と上限を読み、同意して使いますか。'],
  },
  guess: {
    name: 'AI の推測',
    mark: '推測',
    words: ({ count = 1 } = {}) => [
      `話に出ていない ${count} つの項目を、推測で埋めました。`,
      '「推測」の札の項目は、まだ誰も確かめていません。',
      '違えば直し、合っていれば「この項目は合っている」を押しますか。',
    ],
  },
  unseen: {
    name: 'まだ見ていない',
    mark: '○',
    words: ({ count = 1, total = 4 } = {}) => [`${total} つの欄のうち、${count} つはまだ見ていません。`, '承認は、上の欄から 1 つずつ進みます。', '読んでいる欄から読みますか。'],
  },
  waiting: {
    name: '人を待っている',
    mark: '●',
    words: ({ approved = 0, total = 4, label = '' } = {}) => [
      'あなたの承認を待っています。',
      `承認は ${approved} / ${total} で、そろうまで作る AI は動きません。`,
      `${label}を読み、違わなければ承認しますか。`,
    ],
  },
  lost: {
    name: '承認が消えた',
    mark: '!',
    words: ({ because = '中身が変わった' } = {}) => [`${because}ので、この欄の承認を消しました。`, 'この欄は、まだ承認していない形に戻っています。', '読み直して、承認し直しますか。'],
  },
  reverted: {
    name: '元に戻した',
    mark: '↶',
    words: ({ at = '', kept = true } = {}) => [
      `${at ? `${at} の` : '前の'}版に戻しました。`,
      kept ? '戻す前の版と記録は残っています。' : '戻す前の状態は、別の場所に移して残しています。',
      '戻した試作品を試しますか。',
    ],
  },
  customer: {
    name: 'お客さんの前',
    mark: '架空',
    words: () => ['これは試作品です。', '出てくるデータは、すべて架空です。', '触ってみて、下の問いに答えてもらえますか。'],
  },
};

// 5.4 の 12 の状態の名前(お試しか本物かは、印が 2 つで状態は 1 つ)
export const STATE_KINDS = ['first', 'working', 'gate-failed', 'guard-stopped', 'mode', 'consent', 'guess', 'unseen', 'waiting', 'lost', 'reverted', 'customer'];

const PARTS = ['happened', 'now', 'next'];

// 要素を状態の 1 行にする。3 つの文は span で分け、data-part で何の文かを示す。印は data-mark(CSS が出す)
export function fillState(node, kind, options = {}) {
  const state = STATES[kind];
  if (!state) throw new Error(`状態がありません: ${kind}`);
  const words = state.words(options);
  node.classList.add('state-line', ...(options.className ? options.className.split(' ') : []));
  node.dataset.state = kind;
  node.dataset.mark = options.mark ?? state.mark;
  node.replaceChildren(
    ...words.map((text, index) => {
      const span = document.createElement('span');
      span.className = 'state-part';
      span.dataset.part = PARTS[index];
      span.textContent = text;
      return span;
    }),
  );
  return node;
}

// 状態の 1 行の要素を作る
export function stateLine(kind, options = {}) {
  return fillState(document.createElement(options.tag ?? 'p'), kind, options);
}

// 状態の 1 行をやめて、ふつうの文に戻す
export function clearState(node, text) {
  node.classList.remove('state-line');
  delete node.dataset.state;
  delete node.dataset.mark;
  node.textContent = text;
}

// 「これは何?」(5.2)。部品ごとの 3 つの問いの答え。1 つの答えは 1 文。推測は「(推測)」、確かめたことは「確かめました」と書き分ける。
// more は、専門の中身を仕組みの引き出しで見るリンクの文
export const EXPLAINS = {
  // 段 1 話す
  start: {
    name: '思いつきの 1 文',
    what: 'AI プロダクトにしたい思いつきを、1 文で書く欄です。',
    does: 'ラフな 1 文を書くか、例を押して欄に入れます。',
    next: '送ると、聞き出す AI が問いを 1 つずつ返します。',
  },
  depth: {
    name: '案内の深さ',
    what: '聞き出す問いの数の上限を決める選び方です。',
    does: '速く、ふつう、深くから 1 つ選びます。',
    next: '選んだ深さで問いの数が変わり、あとから聞き足せます。',
  },
  // 段 2 目的
  question: {
    name: '問い',
    what: '目的の文書を作るための、1 つずつの問いです。',
    does: '答えるか、分からなければ「分からない」を押します。',
    next: '答えると次の問いが出て、終わると目的の文書の下書きができます。',
  },
  'intent-doc': {
    name: '目的の文書',
    what: '誰の、何の問題を、どの場面で解くかをまとめた文書です。',
    does: '下書きを読み、違うところを直します。',
    next: '「これで決める」を押すと、この目的で設計に進めます。',
  },
  points: {
    name: '聞き取りの欄',
    what: 'ヒアリングで聞いた要点を、短く打つ欄です。',
    does: '聞いた要点を 1 つずつ打ち、Enter で足します。',
    next: '足した要点は、「整理する」で板に振り分けられます。',
  },
  board: {
    name: '整理の板',
    what: '聞いた要点を、欄ごとに振り分けた板です。',
    does: '項目を読み、違えば直し、「推測」の札の項目を確かめます。',
    next: '決める人が「この理解で合っている」を押すと、設計に進めます。',
  },
  asks: {
    name: '聞くこと',
    what: 'まだ聞いていないことと、話が食い違うことの一覧です。',
    does: '会の残りの時間で、上から聞きます。',
    next: '聞いて要点を足すと、次の整理で一覧が変わります。',
  },
  meeting: {
    name: '会の決まり',
    what: 'お客さんとの会の決まりと、データを消す日です。',
    does: 'お客さんに決まりを読み上げ、同意をもらいます。',
    next: '同意すると、聞き取りと整理の板に進めます。',
  },
  closing: {
    name: '会の終わり',
    what: '会で作った成果物と、未決事項の一覧です。',
    does: '未決事項の持ち主と期日を決めます。',
    next: '書き出すと、本番開発へ渡すフォルダーと同じものができます。',
  },
  // 段 3 設計
  design: {
    name: '設計の段',
    what: '問題から画面まで、6 つの段を順に決める案内です。',
    does: '段ごとに案を比べて、1 つ選びます。',
    next: '最後の段まで選ぶと、作る前に AI 構成の審査に進みます。',
  },
  'design-options': {
    name: '案の比べ',
    what: 'この段の案を 2〜3 つ並べた比べで、案は今日の推測です。',
    does: 'おすすめ(推測)と理由を読み、1 つ選ぶか自分の言葉で書きます。',
    next: '選ぶと次の段に進めて、あとから選び直せます。',
  },
  'design-scenes': {
    name: '場面の一覧',
    what: '使う人が言いそうな 1 文の一覧です。',
    does: '足りない場面を足し、違う文を直します。',
    next: 'この一覧で、あとで試作品の振る舞いを確かめます。',
  },
  'design-data': {
    name: 'データ設計',
    what: '覚えておくものと、その項目と、つながりの表です。',
    does: '名前がお客さんの言葉に合っているかを読みます。',
    next: '作る AI は、この表の架空のデータで画面を描きます。',
  },
  'design-shelf': {
    name: 'AI が読むデータの棚',
    what: 'AI が読むものと、その読み方の下書きです。',
    does: '変わる速さと個人情報の扱いを読みます。',
    next: '下の問いで、RAG が要るかを簡単な読み方から順に決めます。',
  },
  rag: {
    name: 'RAG の判定',
    what: '文書から探した部分を AI に読ませる仕組みが要るかの判定です。',
    does: '問いに順に答え、足りたらそこで止めます。',
    next: '判定は、AI 構成の審査の「データと RAG」に入ります。',
  },
  // 段 4 審査(欄ごと。審査の欄は studio.js が欄の中に置く)
  'review-composition': {
    name: 'エージェントの構成',
    what: '次の一手を、コードが決めるか、モデルが決めるかです。',
    does: '3 つから 1 つ選び、足りる中で一番簡単なものを勧めます。',
    next: '何を作るかが決まり、変えたら承認し直します。',
  },
  'review-harness': {
    name: 'harness',
    what: 'モデルの周りで、決め、縛り、記録するコードです。',
    does: '任せることと縛ることを読み、違えば直します。',
    next: 'この決まりで試作品が動き、記録に残ります。',
    more: 'プロンプトの全文を仕組みの引き出しで見る',
  },
  'review-data': {
    name: 'データと RAG',
    what: 'AI が読むものと、その読み方です。',
    does: '読むものと個人情報の扱いを確かめます。',
    next: '試作品は架空のデータで動きます。',
  },
  'review-stack': {
    name: '技術の組',
    what: '試作品と本番で使う候補で、案であって決定ではありません。',
    does: '候補を読み、違えば選び直します。',
    next: '選び直すと、この欄の承認は消えます。',
  },
  'review-flow': {
    name: '流れ図',
    what: 'この試作品の中で、1 回の問い合わせが流れる道の図です。',
    does: '読んでいる欄に関係する部品は縁が太くなるので、その場所を見ます。',
    next: 'この図を見ても、試作品は何も変わりません。',
  },
  // 段 5 作る
  preview: {
    name: '試作品',
    what: '作る AI が書いた、今の試作品です。',
    does: 'この中で話しかけて、動きを試します。',
    next: '試した会話は、段 6 の 1 ターンの記録に残ります。',
  },
  maker: {
    name: '作る AI',
    what: '作る AI に、試作品を書いて直すよう頼む欄です。',
    does: '気になる所を、ふだんの言葉で 1 つずつ頼みます。',
    next: '送ると作る AI が書き始め、多くは 3 分以内に新しい版が出ます(推測)。',
    more: '作る AI の接続と指示を仕組みの引き出しで見る',
  },
  'make-now': {
    name: '関門の列',
    what: '新しい試作品が通るべき自動の確かめで、AI ではなくコードです。',
    does: '何もしなくて大丈夫で、落ちたら作る AI が直します。',
    next: '全部通ると、新しい試作品が出ます。',
  },
  // 段 6 測る
  measure: {
    name: '測るのタブ',
    what: '試作品を試した結果を、3 つのタブで見る欄です。',
    does: 'この 1 ターン、場面、比べるを切り替えて読みます。',
    next: 'タブを切り替えても、試作品は変わりません。',
  },
  turn: {
    name: 'この 1 ターン',
    what: '1 回の返事で、どの部品が何をしたかの記録です。',
    does: '気になる行を開き、中身を見ます。',
    next: 'この記録を見ても、何も変わりません。',
    more: '全部の記録を仕組みの引き出しで見る',
  },
  scenes: {
    name: '場面',
    what: '期待する振る舞いを確かめる、1 つずつの状況です。',
    does: '足りない場面を足し、回して結果を見ます。',
    next: '通らない場面から、作る AI に直してもらえます。',
  },
  compare: {
    name: '比べる',
    what: '構成と前提ごとに、通った数、費用、待ちを並べた表です。',
    does: '同じ場面で測ったかを確かめてから比べます。',
    next: '構成を選び直すと、審査の承認が消えます。',
  },
  // 段 7 質
  check: {
    name: '自動の確かめ',
    what: '今の試作品を、決めた手順で自動で動かす確かめです。',
    does: '押して確かめ、結果は作る AI の欄で読みます。',
    next: '確かめても、試作品の中の会話は変わりません。',
  },
  quality: {
    name: '質の見直し',
    what: '試作品の質を、測った数と AI の判断に分けた表です。',
    does: '「直す」の行を、上から片付けます。',
    next: '「直す」を押すと作る AI の欄に頼む文が入り、送るのはあなたです。',
  },
  // 段 8 見せる
  'show-start': {
    name: '人に見せる',
    what: '試作品と確かめたい問いだけにする画面です。',
    does: '押して、相手に試作品を触ってもらいます。',
    next: '聞いた答えとコメントは、見せた版に残ります。',
  },
  'show-questions': {
    name: '確かめたい問い',
    what: '目的の文書の成功の印から作った問いです。',
    does: '試作品を触った相手に、1 つずつ聞きます。',
    next: '答えを残すと、見せた版に結び付きます。',
  },
  comments: {
    name: 'コメント',
    what: '画面の場所に付けるコメントの一覧です。',
    does: 'コメントを書き、進行役か決める人が承認します。',
    next: '承認したコメントだけを、作る AI に送ります。',
  },
  // 段 9 渡す
  handoff: {
    name: '本番開発へ渡す',
    what: '本番開発の担当者に渡すフォルダーを作る欄です。',
    does: '目的、決まったこと、未決事項を書きます。',
    next: '作ると試作品と記録がまとまり、秘密らしい文字列があれば止めます。',
  },
  // まだの段
  'stage-note': {
    name: 'この段で足りないもの',
    what: 'この段で、まだ足りないものを言う欄です。',
    does: '足りないものを読み、次の一手の帯から進みます。',
    next: 'この段を飛ばしても、ほかの段は使えます。',
  },
};

const QUESTIONS = [
  ['what', 'これは何か'],
  ['does', '何をするのか'],
  ['next', '次に何が起きるか'],
];

// 「これは何?」の要素を作る。初めは閉じている。開くと 3 つの問いの dl。onMore があれば、仕組みの引き出しへのボタンを足す
export function explainBox(key, { open = false, onMore = null } = {}) {
  const texts = EXPLAINS[key];
  if (!texts) throw new Error(`「これは何?」の言葉がありません: ${key}`);
  const details = document.createElement('details');
  details.className = 'explain';
  details.dataset.explain = key;
  details.open = open;
  const summary = document.createElement('summary');
  summary.textContent = 'これは何?';
  // 同じ「これは何?」が並ぶので、読み上げでは何の部品かを添える
  summary.setAttribute('aria-label', `これは何?(${texts.name})`);
  const list = document.createElement('dl');
  for (const [part, label] of QUESTIONS) {
    const dt = document.createElement('dt');
    dt.textContent = label;
    const dd = document.createElement('dd');
    dd.textContent = texts[part];
    list.append(dt, dd);
  }
  details.append(summary, list);
  if (texts.more && onMore) {
    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'text-button';
    more.textContent = texts.more;
    more.addEventListener('click', onMore);
    details.append(more);
  }
  return details;
}
