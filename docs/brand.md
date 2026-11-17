# 伝え方: 1 文、名前、機能の文、見た目

Prototype Studio を外に伝えるときの土台です。README の絵、LP など、伝えるものを作るカードは、まずこれを読みます。

- 状態: 見た目は決めた(2026-10-29)。1 文は運営者が 2026-10-31 に決めた(task 416)。機能のカード、英語の言葉、絵の位置は task 417 で直した(2026-11-02)。task 394(2026-11-11)で「作っているもの」を畳み、機能のカード、分解の絵、バナー、画像を審査を含む本物の画面で撮り直した。名前は運営者が決める(2 節)。決まるまでは今の名前 `agent-prototype-studio` を使う
- 置き場所: この文書と [`assets/brand/`](../assets/brand/)(`tokens.css`、`banner-dark.svg`、`banner-light.svg`)
- LP: [`site/`](../site/README.md) に作った。公開はしない。手元で `npm run site` で開く
- お手本は tuios の作りと書き方。文、絵、ロゴは写さない
- 例のデータは、どれも架空

## 結論

- 1 文は「**思いつきを AI プロダクトにすると、どんな作りになるか。動かして測り、人が承認してから作る。**」。英語は「**See how your idea works as an AI product, test it, and approve the architecture before you build.**」
- この 1 文を、README の冒頭、LP の見出し、フッター、GitHub の説明、バナーで、同じ文のまま使う。変えるときは全部を一度に変える
- 1 文は目的を言う。承認の段(AI 構成の審査)は動くが、どの機能も人の確かめがまだなので、1 文のそばにそう書く。伝えるものには「今できること」と「作っているもの」を分けて書く。jyoka/tasks#394 で、作っていたものの多くを今できることに畳んだ
- 機能は、名詞の見出しと 2 行の説明のカードで伝える。今できること 14 枚と、作っているもの 4 つ(3 節)。「部品のコードをつなぐ」は jyoka/tasks#427 で作ったので、作っているものから外した。素材をつなぐ機能(トークン、指針、部品のパッケージ)は、LP のカードにせず README の特長に書く
- 分解の絵は、AI の作りを 1 回のトークで見せ、7 つ目で人が承認する。本物の画面だけを使う(4 節)
- 「理想の構成」と言わない。出すのは、日付と根拠のある、今日の一番良い推測と書く
- 見た目は `assets/brand/tokens.css` の CSS の変数で決める。Studio の画面(`src/ui/studio.css`)は 2026-11 に A 製図のトークン([ui-ux-v2.md の 10 節](design/ui-ux-v2.md#10-色字部品の決まり))に移った。`tokens.css`、LP、バナーは UI/UX の 8 枚目で A 製図の色に合わせる(ui-ux-v2.md の 14 節)
- 公開の前に直すものの一覧は 7 節。見本のデータと画面の文は、このカードで直した。docs と ADR は一覧だけにした

## 1. 1 文

Studio が何で、何が違うかを 1 文で言い切る。運営者が 2026-10-31 に D に決めた(task 416)。

### 案

| 案 | 日本語 | 英語 | 判断 |
|---|---|---|---|
| D | 思いつきを AI プロダクトにすると、どんな作りになるか。動かして測り、人が承認してから作る。 | See how your idea works as an AI product, test it, and approve the architecture before you build. | **採る** |
| A | AI エージェントの試作品を、作る前に、構成ごと手元で試して測る。 | Try and measure an AI agent prototype, whole setup included, on your machine before you build it. | 2026-10-29 から 2026-11-02 まで使った。「人が承認してから作る」が入らない |
| B | AI エージェントの試作品を言葉で作り、守りの層まで手元で確かめる。 | Build an AI agent prototype in plain words, then check each guardrail layer on your machine. | 見送った。言葉で作る道具はほかにも多く、違いが伝わらない |
| C | 本番を作る前に、AI エージェントの組み方を模擬して、場面ごとに比べる。 | Before you build, simulate how an AI agent is put together and compare it eval by eval. | 見送った。「試作品」と「手元」が抜け、何の道具かが分からない |

### D を選んだ理由

- 何か: 思いつきを AI プロダクトにしたときの「作り」を見せる道具だと分かる
- 何が違うか: 「動かして測り」で測ることを言う。「人が承認してから作る」で、人が決めることを言う
- いつ使うか: 「作る」の前に使うものだと分かる
- 長さ: 2 文で 45 字。前の文が 27 字、後の文が 18 字で、1 文の目安の 40 字に収まる

### 今できないことを書かないために

「人が承認してから作る」の段(AI 構成の審査)は動く。ただし、どの機能も人の確かめ(初めての人や現場の会で使えるか)がまだ。1 文のそばに、確かめていないことを必ず書く。

- README と LP は、1 文の後の 2〜3 行で、動く範囲と、人の確かめがまだなことを言う
- README と LP は「今できること」と「作っているもの」を分ける
- 画像は本物の画面だけ。作っているものに画像を載せない

### 使う場所

| 場所 | 使う文 |
|---|---|
| README の冒頭の太字 | 日本語 |
| `package.json` の `description`、GitHub のリポジトリの説明 | 英語 |
| LP の見出し、フッター、`site/llms.txt` | 日本語(英語の LP は英語) |
| バナー(6 節) | 両方 |

`test/unit/brand.test.js` が、README の太字、`package.json` の `description`、バナー、LP、この文書の文が同じかを確かめる。

### 英語の言葉

英語で書くときは、次の語を使う。同じものには毎回同じ語を使う。

| 日本語 | 英語 |
|---|---|
| 思いつき | idea |
| AI の作り | AI architecture |
| 試作品 | prototype |
| 構成 | setup |
| 作る AI | maker AI |
| プロダクト内 AI | in-product AI |
| 模擬のエージェント | simulated agent |
| 前提 | assumption |
| ガードレール、守り | guardrail |
| ツールの守り、プロンプトの頼み、出口の確かめ | tool guard、prompt ask、output check |
| 場面(回して確かめるもの) | eval |
| 場面(目的の文書、整理の板、設計の段の欄) | scene |
| シナリオ | scenario |
| 実行の記録 | trace |
| 版 | version |
| 引き継ぎ | handoff |
| 関門 | gate |
| 目的の聞き出し | purpose interview |
| ヒアリングの整理 | hearing notes |
| 設計の案内 | design guide |
| 質の見直し | quality review |
| 素材 | design materials |
| AI 構成の審査 | AI architecture review |
| AI 構成書 | AI architecture record |
| 固定の流れ、単一エージェント、マスターとサブ | fixed flow、single agent、master with sub-agents |
| データの棚 | data shelf |
| 今日の一番良い推測 | today's best guess |
| 今できること、作っているもの | What it does today、In progress |

## 2. 名前

決めるのは運営者。決まるまでは今の名前で作る。

| 案 | 中身 | 良い所 | 気になる所 |
|---|---|---|---|
| 1(おすすめ) | 今のまま。リポジトリと npm の名前は `agent-prototype-studio`、画面と文での呼び名は「Prototype Studio」 | 画面の見出し、コマンド(`prototype-studio`)、データの置き場(`~/PrototypeStudio`)、引き継ぎの README に、もう入っている。変える所がない | 一般の言葉の組み合わせで、検索で見つけにくい |
| 2 | 短い製品名「Rehearse」(本番の前の通し稽古) | 「作る前に、構成ごと試す」と意味が合う。短い | データの置き場、コマンド、画面の名前を変える。今の利用者のデータの置き場が変わる |
| 3 | 短い製品名「Maquette」(建てる前の模型) | 「試作品」と意味が合う | 英語圏以外では読み方が分かりにくい。2 と同じく変える所が多い |

おすすめは 1。公開の前に名前を変えるなら、データの置き場を移す手順を同じカードで作る。2 と 3 の名前が、npm、GitHub、商標でほかと重ならないかは、確かめていない(不明)。

## 3. 機能のカード

書き方の決まり:

- 見出しは名詞 2〜3 語。形容詞を使わない
- 説明は 2 行。1 行目は利用者のすること、2 行目は具体(ファイル、コマンド、数)。ファイルとコマンドは AI にも設計にも詳しくない人に伝わらないので、1 行目に書かない
- カードの絵は Studio の本物の画面か文字だけにし、押すと「詳しく」の docs に飛ぶ
- 「今できること」と「作っているもの」を分ける。作っているものには、絵も押す先も付けない

### 今できること

どれも、人の確かめ(初めての人や現場の会で使えるか)はまだ。LP と README の今できることの見出しの下で、そう書く。

| # | 見出し | 説明(日本語) | Heading | Description | 詳しく | 絵 |
|---|---|---|---|---|---|---|
| 1 | 目的の聞き出し | 思いつきを 1 文書くと、問いが 1 つずつ返り、目的の文書になる。<br>決まるのは「これで決める」を押したときだけ。文書は `.studio/intent.json` に残る。 | Purpose interview | Write your idea in one sentence. Studio asks one question at a time and turns the answers into a purpose document.<br>Nothing is decided until you press the button. The document stays in `.studio/intent.json`. | [usage.md の「目的を聞き出す」](usage.md#目的を聞き出すはじめの画面) | 文字 |
| 2 | ヒアリングの整理 | 打った要点を AI が 5 つの欄に振り分け、決める人が確かめる。<br>本物の AI は同意の後だけ動き、同意しないときは手で振り分ける。本物のお客さんの会には、まだ使わない。板は `.studio/organize.json` に残る。 | Hearing notes | The AI sorts the notes you type into five columns, and the person who decides checks them.<br>The real model runs only after you consent. Without consent, you sort the notes by hand. Do not use it in real customer sessions yet. The board stays in `.studio/organize.json`. | [usage.md の「ヒアリングを整理する」](usage.md#ヒアリングを整理する聞き取りの欄と整理の板) | 文字 |
| 3 | 設計の案内 | 問題、使う人、場面、データ、構成、画面の 6 つの段で、2〜3 の案から選ぶ。<br>案は出した日付つきの今日の推測で、まだ測っていない。選んだ場面と構成と架空のデータを Studio が書き、設計は `.studio/design.json` に残る。 | Design guide | Pick from two or three proposals at each of six steps: problem, users, scenes, data, setup, and screens.<br>Each proposal is today's guess, dated, and not measured yet. Studio writes the chosen scenes, setup, and sample data, and the design stays in `.studio/design.json`. | [usage.md の「設計の案内」](usage.md#設計の案内6-つの段) | 文字 |
| 4 | AI 構成の審査 | エージェントの構成、harness、データと RAG、技術の組の 4 つを読み、欄ごとに承認する。4 つそろうまで作る AI は動かない。<br>構成は固定の流れ、単一エージェント、マスターとサブから選び直せる。承認は AI 構成書(`.studio/reviews/`)に残り、承認の後に構成が変わると関門で止まる。 | AI architecture review | Read the agent setup, harness, data and RAG, and tech stack, and approve each one. The maker AI waits until all four are approved.<br>You can switch between a fixed flow, a single agent, and a master with sub-agents. Approvals stay in the AI architecture record (`.studio/reviews/`), and a later change to the setup stops at a gate. | [usage.md の「AI 構成の審査」](usage.md#ai-構成の審査で-4-つを承認する) | `review` |
| 5 | データの棚と RAG の判定 | AI が何をどう読むかを棚で見せ、RAG が要るかを判定する。「要らない」とも言う。<br>最初の判定は今日の推測。RAG ありとなしを同じ場面の一覧で回すと、回した結果を根拠に判定し直す。 | Data shelf and RAG check | A shelf shows what the AI reads and how, and checks whether RAG is needed. The answer can be no.<br>The first check is today's guess. Run the same evals with and without RAG, and the check is redone from those results. | [usage.md の「設計の案内」](usage.md#設計の案内6-つの段) | 文字 |
| 6 | 構成の模擬 | 構成と前提を選ぶと、同じ試作品が別の組み方で話す。模擬のエージェントがツールを自分で選んで呼ぶ。<br>構成はデータで、`app/composition.json` に書く。 | Simulated setups | Pick a setup and assumptions, and the same prototype talks in a different arrangement. A simulated agent picks and calls the tools itself.<br>A setup is data, written in `app/composition.json`. | [design/agent-simulation.md](design/agent-simulation.md) | `sim-choice` |
| 7 | 守りの層 | どの層の守りが止めたかと、その理由を実行の記録で読む。<br>層はツールの守り、プロンプトの頼み、出口の確かめの 3 つ。1 ターンの要約は試す欄の下、全部は仕組みの引き出しにある。 | Guardrail layers | Read in the trace which guardrail layer stopped a turn, and why.<br>The layers are tool guards, prompt asks, and output checks. A one-turn summary sits under the try pane, and the full trace is under developer details. | [design/agent-simulation.md](design/agent-simulation.md) | `sim-trace` |
| 8 | 場面の比較 | 同じ場面の一覧を構成と前提ごとに回し、1 つの表で比べる。<br>試す欄の下の表か、ターミナル(`npm run evals`)で回す。モックの数は形の確かめで、振る舞いの差は実モデルで測る。 | Eval runs | Run the same evals across setups and assumptions, and compare them in one table.<br>Run it from the table under the try pane or in the terminal (`npm run evals`). Mock numbers only check the shape. Differences in behavior need the real model. | [usage.md の「場面を回す」](usage.md#場面を回すnpm-run-evals) | `evals-compare` |
| 9 | 質の見直し | アクセシビリティ、字と地の差、素材に合うか、場面の結果、費用を 1 つの表で見る。各行に「なぜ大事か」と「直す」が付く。<br>測ったものと AI の判断を分け、見ていない項目は「まだ見ていない」と出す。アクセシビリティは Studio の小さな検査だけ。 | Quality review | See accessibility, text contrast, fit with the design materials, eval results, and cost in one table. Each row says why it matters and how to fix it.<br>Measured items are kept apart from AI judgments, and unchecked items say so. Accessibility uses only a small check built into Studio. | [usage.md の「質の見直し」](usage.md#質の見直し) | `quality` |
| 10 | 言葉で直す欄 | 試しながら、画面や AI の振る舞いの直したい所を言葉で頼む。<br>作る AI が書けるのは、試作品の `app/` だけ。 | Plain-word edits | While you try the prototype, ask in plain words for changes to the screens or the AI's behavior.<br>The maker AI can write only to the prototype's `app/`. | [usage.md](usage.md) | `try-and-fix` |
| 11 | 人に見せる | 試作品と確かめたい問いだけの画面にして、相手に触ってもらう。開発の欄は隠れる。<br>問いは目的の文書の成功の印から作り、答えは見せた版に残る。手元の PC で見せる形だけで、公開はしない。 | Showing people | Switch to a screen with only the prototype and the questions to check, and let people try it. The developer panels are hidden.<br>The questions come from the success signs in the purpose document, and the answers stay with the version you showed. It works only on your own PC, with no public sharing. | [usage.md の「人に見せる」](usage.md#人に見せる) | 文字 |
| 12 | みんなで作る | 見せる画面の場所にコメントを付け、承認したコメントだけを作る AI が直す。反応をいくつ付けても動かない。<br>1 台の PC でみんなで使う形。直した記録、前と後の比べ、元に戻すがある。構成のコメントは審査に戻す。 | Building together | Comment on a place in the showing screen. The maker AI acts only on approved comments, no matter how many reactions there are.<br>A group shares one PC. It keeps a fix record, a before-and-after view, and undo. Architecture comments go back to the review. | [usage.md の「画面へのコメントと承認」](usage.md#画面へのコメントと承認) | 文字 |
| 13 | 版と引き継ぎ | 良い状態を版として保存し、いつでも戻す。本番開発に渡すものを 1 つのフォルダーに書き出す。<br>ソース、AI の設定、試した会話、証拠の要約が入る。 | Versions and handoff | Save a good state as a version and restore it any time. Export what the production team needs to one folder.<br>It holds the source, AI settings, tried conversations, and an evidence summary. | [handoff.md](handoff.md) | 文字 |
| 14 | 作るループの関門 | 作る AI が直すたびに、Studio が決まった順に確かめる。落ちたら失敗を返し、2 回まで直させる。<br>順は検査、ビルド、場面、起動、シナリオ。 | Build-loop gates | After each edit by the maker AI, Studio runs its checks in a fixed order. On failure, it sends the result back for up to two fix rounds.<br>The order is checks, build, evals, launch, and scenarios. | [architecture/hld.md](architecture/hld.md) | 文字 |

絵の列は `assets/media/` の画像の名前(`npm run media` が撮る)。「文字」のカードは、流れを文字で書いた枠にする。

前のカードのうち、「データだけの流用」と「モックと実モデル」を LP のカードから外した。流用は開発者に向けた話で、AI の作りを読む人の判断に要らない。モックと実モデルは、LP の見出しの下の文と README の特長に残した。

作っていたもののうち、「3 つの形の比べ」は AI 構成の審査のカードに、「記録と比べる表を主の画面に」は守りの層と場面の比較のカードに入れた(task 394)。

### 作っているもの

どれも、まだ使えない。作っているものには、絵も押す先も付けない。できたら本物の画面を撮って、今できることに移す。

| 見出し | 説明(日本語) | Heading | Description | カード |
|---|---|---|---|---|
| 人の確かめと現場の通し | 初めての人が説明なしで進めるか、架空の題材の 1 時間の会で見せられるまでの時間を、人が通して測る。今の機能は、どれも人の確かめがまだ。 | Checks with people and a full session | People run a one-hour session on a fictional subject to see whether first-time users can follow it without help, and how long it takes to show something. No feature has been checked with people yet. | K6(jyoka/tasks#396) |
| 本物の AI で案ごとに測る | 審査の画面から、構成の案ごとに本物の AI で場面を回して比べる。今の審査の画面から回せるのはお試しの AI だけで、本物の AI の数は試す欄の下の表かターミナルで回したときに出る。 | Measuring each proposal with the real model | Run evals for each setup proposal with the real model, right from the review screen. Today the review screen runs only the mock AI. Real-model numbers appear after you run them from the table under the try pane or in the terminal. | まだない(後のカード) |
| AI の使いやすさの見直し | AI が試作品の画面を見て、使いやすさを判断する。質の見直しの表に行はあるが、今は「まだ見ていない」と出る。 | AI usability review | The AI looks at the prototype screens and judges usability. The quality review has a row for it, but today it says the item has not been checked. | まだない(後のカード) |
| 何台もの PC で同時に作る | 何人もが自分の PC から同じ試作品にコメントし、同時に直す。今は 1 台の PC でみんなで使う形だけ。 | Building together on several devices | Several people comment on and edit the same prototype from their own devices at the same time. Today it works only with a group sharing one PC. | K7(まだない) |

### 3 つの問い

LP の「3 つの問い」は、Studio が何をするかを自分の言葉で書く。ほかの道具とは比べない。
個人のプロジェクトには、企業名とサービス名を書かない決まりがあるため(2026-11-06 に運営者が決めた)。

- 問い: AI の作りを見せるか、人が承認するか、測るか
- 答えも、今できることと作っているものを分ける。どの答えにも、人の確かめがまだなことを書く
- 「ほかの道具」「一般的な道具」のような、名前を伏せた比べる欄も作らない

## 4. 分解の絵の台本

AI の作りを、1 回のトークで層に分けて見せ、7 つ目で人が承認する絵。LP の真ん中に置く(`site/index.html` の「分解」。動かし方は [site/README.md](../site/README.md))。

- 位置: 真ん中のまま(2026-11-02 に決めた)。AI の作りを本物の画面で見せる、今ある唯一の絵で、新しい目的と合う
- 中身: 6 つの層の後に、7 つ目として「AI 構成の審査」を足した(task 394)。記録と構成を人が読み、承認する所。審査の画面ができたので、本物の画面で撮った。見本には設計がないので、7 つ目だけは設計の案内を通した別の架空の題材(図書館の取り置き)で撮り、絵の上の文でそう言う
- 見出し: 「AI の作りを、1 回のトークで見る。」/「See the AI architecture in one turn of a talk.」
- 絵の中身は、Studio が自分で撮った本物の画面にする(試す画面と、実行の記録)。下の例は、見本の「バイト探し(架空)」で、モックのまま出せる
- 層ごとの画面は `npm run media` が撮り、[`assets/media/layers/`](../assets/media/layers/) に置く(`1-talk` から `7-review` まで、下の表の順。ダークとライト)。撮り方は [CONTRIBUTING.md の「画像と動く画像を撮り直す」](../CONTRIBUTING.md#画像と動く画像を撮り直す)

### 例の会話(架空)

見本「バイト探し(架空)」の既定の構成(相手の会社のエージェントと、こちらのツール)で、モックのまま回す。

1. 利用者: 「みなと町でバイトを探しています」。案内役がツール `search_jobs` を呼び、架空の求人のカードを 3 枚出す
2. 利用者: 「そのまま保存して」。案内役は、保存してよいかを聞かずに `save_wish` を呼ぶ
3. ツールの守り `requires` が止める。会話に「記録「consent」がありません」が出る。受け取った記録は「まだありません」のまま

この例で見せたいこと: プロンプトの枠で「保存の前に聞いて」と頼んでも、守るかは相手のエージェントしだい。ツールの守りは、相手によらず必ず効く。どちらが効いたかは、記録で分かる。

### 層の順と 1 行

上から下へ、1 枚ずつ離して見せる。色は `tokens.css` の層の変数を使う。

| 順 | 層 | 1 行 | Line | この例で見えるもの | 色 |
|---|---|---|---|---|---|
| 1 | トークの画面 | 利用者が送り、返事を受け取る所。 | Where the user sends a message and gets a reply. | 「そのまま保存して」と、止めた理由の文 | `--layer-talk` |
| 2 | 模擬のエージェント | 相手の会社のエージェントの役。ツールを自分で選ぶ。 | Plays the partner's agent and picks tools itself. | そよかぜの案内役(模擬)が `save_wish` を選ぶ | `--layer-agent` |
| 3 | プロンプトの枠 | 相手が書く土台と、こちらが書ける枠。頼みは守られるとは限らない。 | The partner's base prompt plus the slot you can write. An ask is not a guarantee. | 土台(前提の `hostPrompt`)と、こちらの枠 `ours-guide` | `--layer-prompt` |
| 4 | ツール(MCP) | こちらが出すツール。データで書き、Studio のツールの口が動かす。 | Your tools, written as data and run by Studio's tool gate. | `save_wish`(場所: みなと町) | `--layer-tool` |
| 5 | ガードレール | 3 つの層の守り。どの層が止めたかが分かる。 | Guardrails in three layers. You see which one stopped the turn. | ツールの守り `requires` が「止めた」 | `--layer-guard` |
| 6 | 記録 | 渡したもの、呼んだツール、守りの判定を残す。 | Keeps what was sent, which tools ran, and each guardrail verdict. | 止めた層、持ち主、理由 | `--layer-record` |
| 7 | AI 構成の審査 | 人が作りを読み、4 つを承認する。承認するまで、作る AI は動かない。 | A person reads the architecture and approves four parts. The maker AI waits until then. | 別の架空の題材で、エージェントの構成(固定の流れ)を承認した欄 | `--layer-review` |

### 動きと幅

- スクロールに合わせて層を 1 枚ずつ離す。止めた層(ガードレール)だけ、枠を `--layer-guard` にして「止めた」の印を付ける
- `prefers-reduced-motion` のときは動かさない。7 つの層を縦に並べた止まった絵を出す
- スマホの幅では、層を縦 1 列に並べる。横に並べない

## 5. 見た目

決まりは [`assets/brand/tokens.css`](../assets/brand/tokens.css) の CSS の変数に書いた。LP(`site/`)、バナー、README の比べる表の画像(`scripts/media/compare-table.js`)が使う。

- Studio の画面: 2026-11(task 432)に、A 製図のトークン([ui-ux-v2.md の 10 節](design/ui-ux-v2.md#10-色字部品の決まり))に移った。画面の色、字、余白、動きの正は ui-ux-v2.md の 10 節で、`test/unit/brand.test.js` が `src/ui/studio.css` と 10.6 の値が同じかを確かめる
- これから: `tokens.css`、LP、バナーは、UI/UX の 8 枚目で A 製図の名前と値に移す(ui-ux-v2.md の 14 節)。下の表は、それまでの LP とバナーの値
- 色: 前の画面(task 432 より前)の色の値。画面で値のまま書いていた色(`#eef3fd` など)には名前を付けた
- ダーク: どの意味の色も、地との差(コントラスト比)が 4.5 以上。試作品(iframe の中)の色は、試作品が決める
- 切り替え: OS の設定(`prefers-color-scheme`)に従う。`<html data-theme="dark">` か `data-theme="light"` を書くと、OS の設定より優先する
- 字: OS に入っている字だけを使う(`--font-sans`、`--font-mono`)。リポジトリに入れられる字は入れない。Web フォントは読み込まない
- 角丸: 4、6、8、12 px と丸(999 px)。画面と見本の会話の枠で使っている値
- 動き: `--motion-fast`、`--motion-slow`。`prefers-reduced-motion` のときは 0 になる

| 変数 | ライト | ダーク | 使う所 |
|---|---|---|---|
| `--bg` | `#f6f6f4` | `#161614` | 地 |
| `--panel` | `#ffffff` | `#1f1f1d` | 板、カード |
| `--line` | `#d9d9d4` | `#3a3a36` | 線 |
| `--text` | `#1f1f1d` | `#ecece8` | 字 |
| `--muted` | `#6b6b66` | `#a3a39c` | 添える字 |
| `--accent` | `#2459c4` | `#7ea6ff` | 押せる所、トークの層 |
| `--on-accent` | `#ffffff` | `#161614` | 押せる所の色の上の字(「送る」など) |
| `--ok` | `#1d7a43` | `#4cc184` | 通った、ツールの層 |
| `--error` | `#b42318` | `#f97066` | 止めた、失敗、ガードレールの層 |
| `--warn` | `#c77700` | `#f0a53a` | 気をつける所の線、プロンプトの層 |
| `--violet` | `#7a3fb4` | `#b48ae6` | AI の設定、エージェントの層 |

## 6. バナー

- ファイル: [`assets/brand/banner-dark.svg`](../assets/brand/banner-dark.svg)、[`assets/brand/banner-light.svg`](../assets/brand/banner-light.svg)。1280 × 640(GitHub の共有の絵の大きさ)
- 中身: 名前 `agent-prototype-studio`、1 文(日本語と英語)、分解の絵の 6 層(ガードレールに「止めた」の印)と、その下の AI 構成の審査(「承認」の印)。審査は task 394 で足した
- 動きはない。外から読み込むものはない
- 字は、見る人の OS の字で描かれる。字の形を固定したいとき(GitHub の共有の絵に上げるときなど)は、PNG に書き出す。書き出しはまだしていない
- 名前が決まったら、2 つのファイルの名前の文字を差し替える

README の一番上で、ダークとライトを `<picture>` で出し分けている(下の形。alt は README を見る)。

```html
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/brand/banner-dark.svg">
  <img alt="agent-prototype-studio: 思いつきを AI プロダクトにすると、どんな作りになるか。動かして測り、人が承認してから作る。" src="assets/brand/banner-light.svg">
</picture>
```

## 7. 公開の前に直すもの

仕事の POC の名前(LINE、DIP、dipAIAG、バイトル)が出る所の一覧。2026-10-29 に、次の検索で調べた。

```sh
rg -n -e 'LINE' -e 'DIP' -e 'dipAIAG' -e 'バイトル' -e '\bdip\b' -e 'dip-' -e 'dip_' -e 'dipSees' --glob '!node_modules'
```

`MAX_LINE`、`DEADLINE`、`BROKEN_LINE` など、英語の line を含むだけの名前は数えない。「バイト探し」は一般の言葉なので数えない。

### 出ない所

- README.md、CONTRIBUTING.md、AGENTS.md、docs/usage.md、docs/configuration.md、docs/claude-code.md、docs/troubleshooting.md、docs/handoff.md、docs/architecture/hld.md、docs/design/ux-redesign.md
- dipAIAG とバイトルは、リポジトリのどこにも出ない
- 見本の `samples/job-consult/`、`samples/study-consult/`、`samples/library/`

### このカードで直した所

データと画面の文だけを直した。コードの名前は変えていない。

| 場所 | 前 | 後 |
|---|---|---|
| `samples/part-time/app/` の `tools.json`、`front-tools.json`、`composition.json`、`compositions/b.json`、`compositions/c.json` | 持ち主 `"owner": "dip"` | `"owner": "ours"` |
| `samples/part-time/app/composition.json`、`compositions/c.json`、`assumptions/partner-a.json`、`assumptions/partner-b.json` | 枠 `dip-guide`、`dip-front` | `ours-guide`、`ours-front` |
| `samples/part-time/app/prompts/` | `dip-guide.md` | `ours-guide.md` |
| `src/ui/studio.js` の実行の記録(見える記録) | 「相手から …、DIP から …」 | 「相手から …、こちらから …」 |

`test/unit/brand.test.js` が、見本のデータ、画面(`src/ui/`)、README に、この名前が戻っていないかを確かめる。

前からある試作品(`~/PrototypeStudio/projects/sample-part-time/`)は、Studio が上書きしない。新しい見本を見るには、そのフォルダーを消してから起動し直す。

### 残した所: コードの名前

| 場所 | 中身 | 直し方 |
|---|---|---|
| `src/server/sim/assumptions.js`(131、133 行)、`src/ui/studio.js`(2690 行) | 前提の `logging` の鍵 `dipSees` | 鍵の名前を変えるコードの変更が要る。古い鍵を読めるようにするかも決める。別のカードにする |
| `samples/part-time/app/assumptions/*.json`、`samples/part-time/app/callers/*.json` | 上の鍵 `dipSees` を使う値 | 上と同じカードで直す |

### 残した所: docs と ADR(公開を決めたときに直す)

| ファイル | 行 | 中身 |
|---|---|---|
| `docs/prd.md` | 15、57、87 | 「LINE に限定しない」「LINE への展開」「LINE / LIFF 接続」 |
| `docs/adr/0001-local-runtime-and-isolation.md` | 241 | 「求人、LINE、aica を前提にしない」 |
| `docs/adr/0003-agent-simulation.md` | 11、12、34 | 仕事の POC の形(LINE のトーク、DIP のツール) |
| `docs/design/agent-simulation.md` | 30、61、63〜66、113、123、132、163、184、191、218、243、253、268、271、272、282、312、323、327、500、517、521、529、534、550、661、732、746、752、758、763、941、1030、1354 | 持ち主の例 `dip`、「DIP 役のツール」、「LINE の POC」、「LINE 社のエージェント」、枠 `dip-guide`、鍵 `dipSees` |
| `docs/design/harness.md` | 4 | 読んだもののパス(`dip_mcp/baito/harness.py`) |
| `docs/evidence/sim-compare/README.md` | 83 | 枠 `dip-guide` |
| `docs/evidence/sim-a/`、`docs/evidence/sim-compare/runs/` の `traces/*.json`(29 ファイル) | 全体 | 回した時の記録。持ち主 `dip`、枠 `dip-guide`、鍵 `dipSees`。直すなら、新しい見本で回し直す |

`docs/design/agent-simulation.md` の構成 A の例は、見本の前の名前(`dip-guide` など)のまま。見本と合わせるのも、公開を決めたときに行う。

### 残した所: テスト(画面に出ない)

`test/fixtures/sim-a/`(`prompts/dip-guide.md` を含む)、`test/fixtures/sim-c/`、`test/unit/composition.test.js`、`test/unit/tool-gate.test.js`、`test/unit/trace.test.js`、`test/unit/sim-args.test.js`、`test/unit/build.test.js`、`test/integration/tools-mcp.test.js`、`test/e2e/generality.spec.js`(コメントの「LINE」)。テストのデータは画面と見本に出ないので、このカードでは直していない。

### 参考: POC の名前ではないが、公開の前に見るもの

- 運営者の別のリポジトリ `jyoka/aica` と、タスクの番号 `jyoka/tasks#…` への言及が、docs(prd.md、usage.md、design/、evidence/)と `src/server/sim/eval-import.js`、`bin/evals-import.js` にある。どちらも private のリポジトリを指すので、公開のときに外の人が開けない
