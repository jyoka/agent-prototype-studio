# 伝え方: 1 文、名前、機能の文、見た目

Prototype Studio を外に伝えるときの土台です。README の絵、LP など、伝えるものを作るカードは、まずこれを読みます。

- 状態: 1 文、機能の文、分解の絵の台本、見た目、バナーは決めた(2026-10-29)。名前は運営者が決める(2 節)。決まるまでは今の名前 `agent-prototype-studio` を使う
- 置き場所: この文書と [`assets/brand/`](../assets/brand/)(`tokens.css`、`banner-dark.svg`、`banner-light.svg`)
- お手本は tuios の作りと書き方。文、絵、ロゴは写さない
- 例のデータは、どれも架空

## 結論

- 1 文は「**AI エージェントの試作品を、作る前に、構成ごと手元で試して測る。**」。英語は「**Try and measure an AI agent prototype, whole setup included, on your machine before you build it.**」
- この 1 文を、README の冒頭、LP の見出し、フッター、GitHub の説明、バナーで、同じ文のまま使う。変えるときは全部を一度に変える
- 機能は、名詞の見出しと 2 行の説明のカード 8 枚で伝える(3 節)。形容詞を使わず、ファイル、コマンド、数で書く
- 分解の絵は、1 回のトークを 6 つの層に分け、ツールの守りが保存を止める所を見せる(4 節)
- 見た目は `assets/brand/tokens.css` の CSS の変数で決める。ライトの色は今の画面(`src/ui/studio.css`)と同じ値にした
- 公開の前に直すものの一覧は 7 節。見本のデータと画面の文は、このカードで直した。docs と ADR は一覧だけにした

## 1. 1 文

Studio が何で、何が違うかを 1 文で言い切る。

### 案

| 案 | 日本語 | 英語 | 判断 |
|---|---|---|---|
| A | AI エージェントの試作品を、作る前に、構成ごと手元で試して測る。 | Try and measure an AI agent prototype, whole setup included, on your machine before you build it. | **採る** |
| B | AI エージェントの試作品を言葉で作り、守りの層まで手元で確かめる。 | Build an AI agent prototype in plain words, then check each guardrail layer on your machine. | 見送る。言葉で作る道具はほかにも多く、違いが伝わらない |
| C | 本番を作る前に、AI エージェントの組み方を模擬して、場面ごとに比べる。 | Before you build, simulate how an AI agent is put together and compare it eval by eval. | 見送る。「試作品」と「手元」が抜け、何の道具かが分からない |

### A を選んだ理由

- 何か: 「AI エージェントの試作品」を「手元で」試す道具だと分かる
- 何が違うか: 「構成ごと」で、エージェント、プロンプトの枠、ツール、ガードレールをまとめて試すことを言う。「測る」で、場面を回して比べることを言う
- いつ使うか: 「作る前に」で、本番の開発の前に使うものだと分かる
- 長さ: 日本語で 31 字。目安の 40 字に収まる

### 使う場所

| 場所 | 使う文 |
|---|---|
| README の冒頭の太字 | 日本語 |
| `package.json` の `description`、GitHub のリポジトリの説明 | 英語 |
| LP の見出し、フッター | 日本語(英語の LP は英語) |
| バナー(6 節) | 両方 |

`test/unit/brand.test.js` が、README の太字、`package.json` の `description`、バナー、この文書の文が同じかを確かめる。

### 英語の言葉

英語で書くときは、次の語を使う。同じものには毎回同じ語を使う。

| 日本語 | 英語 |
|---|---|
| 試作品 | prototype |
| 構成 | setup |
| 作る AI | maker AI |
| プロダクト内 AI | in-product AI |
| 模擬のエージェント | simulated agent |
| 前提 | assumption |
| ガードレール、守り | guardrail |
| ツールの守り、プロンプトの頼み、出口の確かめ | tool guard、prompt ask、output check |
| 場面 | eval |
| シナリオ | scenario |
| 実行の記録 | trace |
| 版 | version |
| 引き継ぎ | handoff |
| 関門 | gate |

## 2. 名前

決めるのは運営者。決まるまでは今の名前で作る。

| 案 | 中身 | 良い所 | 気になる所 |
|---|---|---|---|
| 1(おすすめ) | 今のまま。リポジトリと npm の名前は `agent-prototype-studio`、画面と文での呼び名は「Prototype Studio」 | 画面の見出し、コマンド(`prototype-studio`)、データの置き場(`~/PrototypeStudio`)、引き継ぎの README に、もう入っている。変える所がない | 一般の言葉の組み合わせで、検索で見つけにくい |
| 2 | 短い製品名「Rehearse」(本番の前の通し稽古) | 「作る前に、構成ごと試す」と意味が合う。短い | データの置き場、コマンド、画面の名前を変える。今の利用者のデータの置き場が変わる |
| 3 | 短い製品名「Maquette」(建てる前の模型) | 「試作品」と意味が合う | 英語圏以外では読み方が分かりにくい。2 と同じく変える所が多い |

おすすめは 1。公開の前に名前を変えるなら、データの置き場を移す手順を同じカードで作る。2 と 3 の名前が、npm、GitHub、商標でほかと重ならないかは、確かめていない(不明)。

## 3. 機能のカード 8 枚

書き方の決まり:

- 見出しは名詞 2〜3 語。形容詞を使わない
- 説明は 2 行。1 行目は何ができるか、2 行目は具体(ファイル、コマンド、数)
- カードの絵は Studio の本物の画面にし、押すと「詳しく」の docs に飛ぶ

| # | 見出し | 説明(日本語) | Heading | Description | 詳しく |
|---|---|---|---|---|---|
| 1 | 言葉で直す欄 | 画面も AI の振る舞い(`app/ai.json`)も、欄に書いた依頼で変わる。<br>作る AI が書けるのは、試作品の `app/` だけ。 | Plain-word edits | Type a request to change the screens or the AI's behavior (`app/ai.json`).<br>The maker AI can write only to the prototype's `app/`. | [usage.md](usage.md) |
| 2 | 構成の模擬 | 相手のエージェント、こちらのツール、人への引き継ぎを `app/composition.json` に書く。<br>模擬のエージェントが、ツールを自分で選んで呼ぶ。 | Simulated setups | Write the partner's agent, your tools, and handoffs to people in `app/composition.json`.<br>A simulated agent picks and calls the tools itself. | [design/agent-simulation.md](design/agent-simulation.md) |
| 3 | 守りの層 | ツールの守り、プロンプトの頼み、出口の確かめの 3 つの層に分けて書く。<br>実行の記録に、どの層が止めたかと理由が出る。 | Guardrail layers | Write guardrails in three layers: tool guards, prompt asks, and output checks.<br>The trace shows which layer stopped a turn, and why. | [design/agent-simulation.md](design/agent-simulation.md) |
| 4 | 場面の比較 | `app/evals/` の場面を、構成と前提を替えて回す(`npm run evals`)。<br>自然さ、ツールの呼び方、守り、費用と待ち時間を並べて比べる。 | Eval runs | Run the evals in `app/evals/` across setups and assumptions (`npm run evals`).<br>Compare naturalness, tool use, guardrails, and cost and latency side by side. | [usage.md の「場面を回す」](usage.md#場面を回すnpm-run-evals) |
| 5 | データだけの流用 | 新しい構成は、構成、ツール、前提、プロンプトの JSON と文で足す。<br>Studio のコードは変えない。ツールは探す、取る、記録するなどの決まった処理を組む。 | Data-only setups | Add a setup with JSON and text files: composition, tools, assumptions, prompts.<br>Studio's code stays the same. Tools combine fixed steps such as search, get, and record. | [configuration.md](configuration.md) |
| 6 | モックと実モデル | 同じ試作品のまま、モックと Claude Code を切り替える。<br>モックはモデルを呼ばず、料金はかからない。実モデルは同意の後だけ。 | Mock and real model | Switch the same prototype between a mock and Claude Code.<br>The mock calls no model and costs nothing. The real model runs only after you consent. | [claude-code.md](claude-code.md) |
| 7 | 版と引き継ぎ | `app/` のファイルと会話と状態を版として保存し、いつでも戻す。<br>ソース、AI の設定、試した会話、証拠の要約を 1 つのフォルダーに書き出す。 | Versions and handoff | Save `app/`, conversations, and state as a version, and restore any of them.<br>Export source, AI settings, tried conversations, and an evidence summary to one folder. | [handoff.md](handoff.md) |
| 8 | 作るループの関門 | 作る AI が直すたびに、検査、ビルド、場面、起動、シナリオの関門を回す。<br>落ちたら失敗を作る AI に返し、2 回まで直させる。 | Build-loop gates | After each edit by the maker AI, Studio runs gates: checks, build, evals, launch, and scenarios.<br>On failure, it sends the result back to the maker AI for up to two fix rounds. | [architecture/hld.md](architecture/hld.md) |

運営者の例(「言葉で直す」「構成を模擬する」など)は動詞の形だったので、見出しの決まりに合わせて名詞の形にした。1 枚目は、画面の欄の名前「言葉で直す」に合わせて「言葉で直す欄」にした。

## 4. 分解の絵の台本

1 回のトークを、層に分けて見せる絵。LP の真ん中に置く。

- 見出し: 「1 回のトークを、層ごとに見る。」/「One turn of a talk, layer by layer.」
- 絵の中身は、Studio が自分で撮った本物の画面にする(試す画面と、実行の記録)。下の例は、見本の「バイト探し(架空)」で、モックのまま出せる

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
- ダーク: 今の画面にはまだない。`tokens.css` で値を決めた。どの意味の色も、地との差(コントラスト比)が 4.5 以上
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
| `--ok` | `#1d7a43` | `#4cc184` | 通った、ツールの層 |
| `--error` | `#b42318` | `#f97066` | 止めた、失敗、ガードレールの層 |
| `--warn` | `#c77700` | `#f0a53a` | 気をつける所の線、プロンプトの層 |
| `--violet` | `#7a3fb4` | `#b48ae6` | AI の設定、エージェントの層 |

## 6. バナー

- ファイル: [`assets/brand/banner-dark.svg`](../assets/brand/banner-dark.svg)、[`assets/brand/banner-light.svg`](../assets/brand/banner-light.svg)。1280 × 640(GitHub の共有の絵の大きさ)
- 中身: 名前 `agent-prototype-studio`、1 文(日本語と英語)、分解の絵の 6 層(ガードレールに「止めた」の印)
- 動きはない。外から読み込むものはない
- 字は、見る人の OS の字で描かれる。字の形を固定したいとき(GitHub の共有の絵に上げるときなど)は、PNG に書き出す。書き出しは README の絵のカードで行う
- 名前が決まったら、2 つのファイルの名前の文字を差し替える

README で出すときは、ダークとライトを `<picture>` で出し分ける(README の絵のカードで行う)。

```html
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/brand/banner-dark.svg">
  <img alt="agent-prototype-studio: AI エージェントの試作品を、作る前に、構成ごと手元で試して測る。" src="assets/brand/banner-light.svg">
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
| `src/server/sim/assumptions.js`(131、133 行)、`src/ui/studio.js`(2673 行) | 前提の `logging` の鍵 `dipSees` | 鍵の名前を変えるコードの変更が要る。古い鍵を読めるようにするかも決める。別のカードにする |
| `samples/part-time/app/assumptions/*.json`、`samples/part-time/app/callers/*.json` | 上の鍵 `dipSees` を使う値 | 上と同じカードで直す |

### 残した所: docs と ADR(公開を決めたときに直す)

| ファイル | 行 | 中身 |
|---|---|---|
| `docs/prd.md` | 15、57、87 | 「LINE に限定しない」「LINE への展開」「LINE / LIFF 接続」 |
| `docs/adr/0001-local-runtime-and-isolation.md` | 241 | 「求人、LINE、aica を前提にしない」 |
| `docs/adr/0003-agent-simulation.md` | 11、12、34 | 仕事の POC の形(LINE のトーク、DIP のツール) |
| `docs/design/agent-simulation.md` | 30、61、63〜66、113、123、132、163、184、191、218、243、253、268、271、272、282、312、323、327、500、517、521、529、534、550、661、726、740、746、752、757、992 | 持ち主の例 `dip`、「DIP 役のツール」、「LINE の POC」、「LINE 社のエージェント」、枠 `dip-guide`、鍵 `dipSees` |
| `docs/design/harness.md` | 4 | 読んだもののパス(`dip_mcp/baito/harness.py`) |
| `docs/evidence/sim-compare/README.md` | 76 | 枠 `dip-guide` |
| `docs/evidence/sim-a/`、`docs/evidence/sim-compare/runs/` の `traces/*.json`(29 ファイル) | 全体 | 回した時の記録。持ち主 `dip`、枠 `dip-guide`、鍵 `dipSees`。直すなら、新しい見本で回し直す |

`docs/design/agent-simulation.md` の構成 A の例は、見本の前の名前(`dip-guide` など)のまま。見本と合わせるのも、公開を決めたときに行う。

### 残した所: テスト(画面に出ない)

`test/fixtures/sim-a/`(`prompts/dip-guide.md` を含む)、`test/fixtures/sim-c/`、`test/unit/composition.test.js`、`test/unit/tool-gate.test.js`、`test/unit/trace.test.js`、`test/unit/sim-args.test.js`、`test/unit/build.test.js`、`test/integration/tools-mcp.test.js`、`test/e2e/generality.spec.js`(コメントの「LINE」)。テストのデータは画面と見本に出ないので、このカードでは直していない。

### 参考: POC の名前ではないが、公開の前に見るもの

- 運営者の別のリポジトリ `jyoka/aica` と、タスクの番号 `jyoka/tasks#…` への言及が、docs(prd.md、usage.md、design/、evidence/)と `src/server/sim/eval-import.js`、`bin/evals-import.js` にある。どちらも private のリポジトリを指すので、公開のときに外の人が開けない
