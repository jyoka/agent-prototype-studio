# 伝え方: 1 文、名前、機能の文、見た目

Prototype Studio を外に伝えるときの土台です。README の絵、LP など、伝えるものを作るカードは、まずこれを読みます。

- 状態: 見た目は決めた(2026-10-29)。1 文は運営者が 2026-10-31 に決めた(task 416)。機能のカード、英語の言葉、絵の位置は task 417 で直した(2026-11-02)。名前は運営者が決める(2 節)。決まるまでは今の名前 `agent-prototype-studio` を使う
- 置き場所: この文書と [`assets/brand/`](../assets/brand/)(`tokens.css`、`banner-dark.svg`、`banner-light.svg`)
- LP: [`site/`](../site/README.md) に作った。公開はしない。手元で `npm run site` で開く
- お手本は tuios の作りと書き方。文、絵、ロゴは写さない
- 例のデータは、どれも架空

## 結論

- 1 文は「**思いつきを AI プロダクトにすると、どんな作りになるか。動かして測り、人が承認してから作る。**」。英語は「**See how your idea works as an AI product, test it, and approve the architecture before you build.**」
- この 1 文を、README の冒頭、LP の見出し、フッター、GitHub の説明、バナーで、同じ文のまま使う。変えるときは全部を一度に変える
- 1 文は目的を言う。「人が承認してから作る」の段はまだないので、伝えるものには必ず「今できること」と「作っているもの」を分けて書く。全部のカードが終わったら jyoka/tasks#394 が「作っているもの」を畳む
- 機能は、名詞の見出しと 2 行の説明のカードで伝える。今できること 9 枚と、作っているもの 6 つ(3 節)
- 分解の絵は、AI の作りを 1 回のトークで見せる。本物の画面だけを使い、承認の段は絵にしない(4 節)
- 「理想の構成」と言わない。出すのは、日付と根拠のある、今日の一番良い推測と書く
- 見た目は `assets/brand/tokens.css` の CSS の変数で決める。ライトの色は今の画面(`src/ui/studio.css`)と同じ値にした
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

「人が承認してから作る」は目的で、その段はまだない。1 文のそばに、今できないことを必ず書く。

- README と LP は、1 文の後の 2〜3 行で、承認の段がまだ使えないと言う
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

| # | 見出し | 説明(日本語) | Heading | Description | 詳しく |
|---|---|---|---|---|---|
| 1 | 目的の聞き出し | 思いつきを 1 文書くと、問いが 1 つずつ返り、目的の文書になる。<br>決まるのは「これで決める」を押したときだけ。文書は `.studio/intent.json` に残る。 | Purpose interview | Write your idea in one sentence. Studio asks one question at a time and turns the answers into a purpose document.<br>Nothing is decided until you press the button. The document stays in `.studio/intent.json`. | [usage.md の「目的を聞き出す」](usage.md#目的を聞き出すはじめの画面) |
| 2 | 設計の案内 | 問題、使う人、場面、データ、構成、画面の 6 つの段で、2〜3 の案から選ぶ。<br>案は出した日付つきの今日の推測で、まだ測っていない。選んだ場面と構成と架空のデータを Studio が書き、設計は `.studio/design.json` に残る。 | Design guide | Pick from two or three proposals at each of six steps: problem, users, scenes, data, setup, and screens.<br>Each proposal is today's guess, dated, and not measured yet. Studio writes the chosen scenes, setup, and sample data, and the design stays in `.studio/design.json`. | [usage.md の「設計の案内」](usage.md#設計の案内6-つの段) |
| 3 | ヒアリングの整理 | 打った要点を AI が 5 つの欄に振り分け、決める人が確かめる。<br>本物の AI は同意の後だけ動き、同意しないときは手で振り分ける。本物のお客さんの会には、まだ使わない。板は `.studio/organize.json` に残る。 | Hearing notes | The AI sorts the notes you type into five columns, and the person who decides checks them.<br>The real model runs only after you consent. Without consent, you sort the notes by hand. Do not use it in real customer sessions yet. The board stays in `.studio/organize.json`. | [usage.md の「ヒアリングを整理する」](usage.md#ヒアリングを整理する聞き取りの欄と整理の板) |
| 4 | 構成の模擬 | 構成と前提を選ぶと、同じ試作品が別の組み方で話す。模擬のエージェントがツールを自分で選んで呼ぶ。<br>構成はデータで、`app/composition.json` に書く。 | Simulated setups | Pick a setup and assumptions, and the same prototype talks in a different arrangement. A simulated agent picks and calls the tools itself.<br>A setup is data, written in `app/composition.json`. | [design/agent-simulation.md](design/agent-simulation.md) |
| 5 | 守りの層 | どの層の守りが止めたかと、その理由を実行の記録で読む。<br>層はツールの守り、プロンプトの頼み、出口の確かめの 3 つ。記録は「開発者向けの詳細」にある。 | Guardrail layers | Read in the trace which guardrail layer stopped a turn, and why.<br>The layers are tool guards, prompt asks, and output checks. The trace is under developer details. | [design/agent-simulation.md](design/agent-simulation.md) |
| 6 | 場面の比較 | 同じ場面の一覧を構成と前提ごとに回し、1 つの表で比べる。<br>今はターミナルで回す(`npm run evals`)。モックの数は形の確かめで、振る舞いの差は実モデルで測る。 | Eval runs | Run the same evals across setups and assumptions, and compare them in one table.<br>Run it in the terminal today (`npm run evals`). Mock numbers only check the shape. Differences in behavior need the real model. | [usage.md の「場面を回す」](usage.md#場面を回すnpm-run-evals) |
| 7 | 言葉で直す欄 | 試しながら、画面や AI の振る舞いの直したい所を言葉で頼む。<br>作る AI が書けるのは、試作品の `app/` だけ。 | Plain-word edits | While you try the prototype, ask in plain words for changes to the screens or the AI's behavior.<br>The maker AI can write only to the prototype's `app/`. | [usage.md](usage.md) |
| 8 | 版と引き継ぎ | 良い状態を版として保存し、いつでも戻す。本番開発に渡すものを 1 つのフォルダーに書き出す。<br>ソース、AI の設定、試した会話、証拠の要約が入る。 | Versions and handoff | Save a good state as a version and restore it any time. Export what the production team needs to one folder.<br>It holds the source, AI settings, tried conversations, and an evidence summary. | [handoff.md](handoff.md) |
| 9 | 作るループの関門 | 作る AI が直すたびに、Studio が決まった順に確かめる。落ちたら失敗を返し、2 回まで直させる。<br>順は検査、ビルド、場面、起動、シナリオ。 | Build-loop gates | After each edit by the maker AI, Studio runs its checks in a fixed order. On failure, it sends the result back for up to two fix rounds.<br>The order is checks, build, evals, launch, and scenarios. | [architecture/hld.md](architecture/hld.md) |

前のカードのうち、「データだけの流用」と「モックと実モデル」を LP のカードから外した。流用は開発者に向けた話で、AI の作りを読む人の判断に要らない。モックと実モデルは、LP の見出しの下の文と README の特長に残した。

### 作っているもの

どれも、人の確かめが済んでいない。今の Studio で完成したと書かない。全部のカードが終わったら jyoka/tasks#394 が畳み、「今できること」に本物の画面で移す。

| 見出し | 説明(日本語) | Heading | Description | カード |
|---|---|---|---|---|
| AI 構成の審査 | エージェントの構成、harness、データと RAG、技術の組の案を見せる。人が 4 つを承認するまで、作る AI を起動しない。結果は AI 構成書に残す。審査の画面がある。人の確かめと、本物の AI で案ごとの数を測る段はまだ。 | AI architecture review | Shows a proposal for the agent setup, harness, data and RAG, and tech stack. The maker AI does not start until a person approves all four. The result stays in an AI architecture record. There is a review screen. It has not been checked with people, and measuring each proposal with the real model is not built yet. | #422(画面、AI 構成書、関門 GA は済) |
| 3 つの形の比べ | 固定の流れ、単一エージェント、マスターとサブを、同じ場面の一覧で比べる。簡単な方から問い、足りたら止まる。3 つの形とも構成に書け、審査の画面で切り替えて、お試しの AI で形を確かめられる。本物の AI で比べるのはターミナルだけ。 | Three architecture shapes | Compares a fixed flow, a single agent, and a master with sub-agents on the same evals. It asks about the simplest shape first and stops when that is enough. All three shapes can be written as a composition. You can switch between them on the review screen and check the shape with the mock AI. Comparing them with the real model is terminal only. | #420(済)、#422(済) |
| データの棚と RAG の判定 | AI が何をどう読むかを見せ、RAG が要るかを判定する。「要らない」とも言える。データの段と審査の画面で見て、審査の画面で承認できる。本物の AI で RAG ありとなしを比べるのはターミナルだけ。 | Data shelf and RAG check | Shows what the AI reads and how, and checks whether RAG is needed. The answer can be no. You can see it in the data step and on the review screen, and approve it on the review screen. Comparing with and without RAG on the real model is terminal only. | #421(済)、#422(済) |
| 記録と比べる表を主の画面に | 今、記録は開発者向けの詳細に、比べる表はターミナルにある。主の画面で読めるようにする。 | Traces and tables on the main screen | Today the trace is under developer details and the comparison table is in the terminal. This moves them to the main screen. | #423 |
| 質の見直し | 使いやすさ、アクセシビリティ、素材に合っているか、場面の結果をまとめて見る。 | Quality review | Reviews usability, accessibility, fit with the design materials, and eval results together. | J6 |
| みんなで作る | コメントと反応を付け、承認したコメントだけを作る AI が直す。まず 1 台の PC でみんなで使う形から作る。 | Building together | People comment and react, and the maker AI acts only on approved comments. It starts with a group sharing one PC. | K3 |

### 3 つの問い

LP の「3 つの問い」は、Studio が何をするかを自分の言葉で書く。ほかの道具とは比べない。
個人のプロジェクトには、企業名とサービス名を書かない決まりがあるため(2026-11-06 に運営者が決めた)。

- 問い: AI の作りを見せるか、人が承認するか、測るか
- 答えも、今できることと作っているものを分ける
- 「ほかの道具」「一般的な道具」のような、名前を伏せた比べる欄も作らない

## 4. 分解の絵の台本

AI の作りを、1 回のトークで層に分けて見せる絵。LP の真ん中に置く(`site/index.html` の「分解」。動かし方は [site/README.md](../site/README.md))。

- 位置: 真ん中のまま(2026-11-02 に決めた)。AI の作りを本物の画面で見せる、今ある唯一の絵で、新しい目的と合う
- 中身: 変えない。「人が承認する」は絵にしない。承認の画面がまだなく、想像図を本物の画面として載せないため。絵の下の文で、承認の段の画面はまだないと言う。審査ができたら jyoka/tasks#394 が本物の画面で撮り直す
- 見出し: 「AI の作りを、1 回のトークで見る。」/「See the AI architecture in one turn of a talk.」
- 絵の中身は、Studio が自分で撮った本物の画面にする(試す画面と、実行の記録)。下の例は、見本の「バイト探し(架空)」で、モックのまま出せる
- 層ごとの画面は `npm run media` が撮り、[`assets/media/layers/`](../assets/media/layers/) に置く(`1-talk` から `6-record` まで、下の表の順。ダークとライト)。撮り方は [CONTRIBUTING.md の「画像と動く画像を撮り直す」](../CONTRIBUTING.md#画像と動く画像を撮り直す)

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

### 動きと幅

- スクロールに合わせて層を 1 枚ずつ離す。止めた層(ガードレール)だけ、枠を `--layer-guard` にして「止めた」の印を付ける
- `prefers-reduced-motion` のときは動かさない。6 層を縦に並べた止まった絵を出す
- スマホの幅では、層を縦 1 列に並べる。横に並べない

## 5. 見た目

決まりは [`assets/brand/tokens.css`](../assets/brand/tokens.css) の CSS の変数に書いた。

- 色: ライトの値は、今の画面の `src/ui/studio.css` の `:root` と同じ。同じ名前の変数は同じ値にする(`test/unit/brand.test.js` が確かめる)。画面で値のまま書いている色(`#eef3fd` など)には名前を付けた
- ダーク: `tokens.css` で値を決め、画面(`src/ui/studio.css`)も同じ値で切り替わる(`test/unit/brand.test.js` が確かめる)。どの意味の色も、地との差(コントラスト比)が 4.5 以上。試作品(iframe の中)の色は、試作品が決める
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
- 中身: 名前 `agent-prototype-studio`、1 文(日本語と英語)、分解の絵の 6 層(ガードレールに「止めた」の印)。6 層は今の Studio にあるものなので残した。審査ができたら jyoka/tasks#394 が直す
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
