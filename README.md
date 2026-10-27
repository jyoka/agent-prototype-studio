# agent-prototype-studio
Prototype and explore AI agent product experiences

## 起動のしかた

いまは段階 0 です。固定のサンプル試作品を、自分の PC のブラウザで触れます。サンプルは 2 つあり、どちらも架空のデータを使います。

- 架空の図書室: 本を探す、借りる、登録する画面
- 架空の求人相談: 試作品の中の AI と話し、AI が理解した希望条件を確かめて直す画面

試作品の中の AI(プロダクト内 AI)は、既定では決まった規則で応答するモックです。許可して起動したときだけ、Claude Code(実際の AI モデル)に切り替えられます(下の「実モデル(Claude Code)と話す」)。作る AI はまだつなぎません。

### 要るもの

- Node.js 22 以上。ターミナルで `node --version` を実行して確かめる。なければ https://nodejs.org/ から LTS 版を入れる。
- Claude Code は要らない。実モデルと話すときだけ要る(下の「実モデル(Claude Code)と話す」)。

### 手順

1. ターミナルで、このリポジトリのフォルダーに移る。
2. 初回だけ、部品を入れる。

   ```sh
   npm install
   ```

3. 起動する。

   ```sh
   npm start
   ```

4. 既定のブラウザで Studio の画面が開く。開かないときは、ターミナルに出た `http://127.0.0.1:4317/#token=…` の URL をブラウザに貼り付ける。
5. 左の「試作品」から「サンプル: 架空の図書室」を選ぶ。中央の枠の中で、本を探す、借りる、登録するなどを試せる。
6. 左の「試作品」から「サンプル: 架空の求人相談(プロダクト内 AI)」を選ぶ。下の「モックの AI と話す」の順に試せる。
7. 止めるときは、ターミナルで Ctrl+C を押す。

### モックの AI と話す(架空の求人相談)

1. 中央の下の欄に希望を書いて「送る」を押す。例: `カフェで働きたいです`。
2. 案内役(モックの AI)が応答する。右の「希望条件」に、AI が理解した条件(職種、雇用区分、勤務地、時給の下限)が出る。足りない条件は、案内役が 1 つずつ聞く。
3. 違う条件は、「希望条件」の選択肢や数の欄で直す。会話の中に「あなたの修正」として残る。
4. 続けて話すと、案内役は直した条件を踏まえて応答する。例: 勤務地を「もみじ台」に直してから `時給は1100円以上がいいです` と送ると、「直していただいた勤務地「もみじ台」で進めます。」から始まる。
5. 「リセット」を押すと、会話と条件が最初に戻る。同じ順に同じ文を送れば、いつも同じ応答が返る。

試してみる文の例:

| 送る文 | 読み取られる条件 |
|---|---|
| `しおかぜ町でカフェのアルバイトを探しています` | 職種、雇用区分、勤務地 |
| `本屋の契約社員で、ひばり駅前がいい` | 職種、雇用区分、勤務地 |
| `時給は1200円以上` | 時給の下限 |

モックは、`app/ai.json` に書かれた言葉が文の中にあるかで条件を読み取る。言い回しを理解するわけではない。自由な文への応答は、次の「実モデル(Claude Code)と話す」で試す。

### 実モデル(Claude Code)と話す(許可したときだけ)

同じ試作品のまま、プロダクト内 AI の接続をモックから Claude Code に切り替えられる。会話と条件はそのまま引き継ぐ。

先に確かめること:

- 社内の利用条件とデータの扱い。会社として Claude の Commercial Terms に同意するかが決まるまでは、切り替えない。
- 架空のデータだけで試すこと。発言、会話の全体、`app/ai.json` の指示は Anthropic に送られる。
- 費用。環境変数 `ANTHROPIC_API_KEY` があると、API の従量課金になる。なければ、Claude Code にログインしている本人のアカウントで動く。Pro や Max のサブスクリプションならその枠を、Console のアカウントなら API の従量課金を使う。Studio はログインの情報を読まないので、どちらかは画面に出せない。`CLAUDE_CODE_USE_BEDROCK`、`CLAUDE_CODE_USE_VERTEX`、`CLAUDE_CODE_USE_FOUNDRY`、`ANTHROPIC_BASE_URL`、`ANTHROPIC_AUTH_TOKEN` があるときは、送り先と課金がその設定に従うことを出す。

要るもの:

- Claude Code 2.1.248 以上(`--restricted` を使うため)。ターミナルで `claude --version` を実行して確かめる。
- Claude Code へのログイン。ターミナルで一度 `claude` を起動し、本人のアカウントでログインしておく。Studio はログインの情報を読まない、保存しない、渡さない。

手順:

1. Studio を、実モデルを許す印を付けて起動する。
   - macOS のターミナル: `STUDIO_ALLOW_CLAUDE_CODE=1 npm start`
   - Windows の PowerShell: `$env:STUDIO_ALLOW_CLAUDE_CODE=1; npm start`
2. 「サンプル: 架空の求人相談(プロダクト内 AI)」を選ぶ。
3. 右の「詳細」の「接続を選ぶ」で「Claude Code」を選ぶ。送り先、送るもの、送らないもの、費用が出る。「送る指示の全文を見る」で、AI に渡す指示を全部読める。
4. 確かめたら、チェックを入れて「Claude Code に切り替える」を押す。中央の上が「AI: Claude Code」になる。
5. 試作品の欄に、自由な文で希望を書いて送る。例: `駅の近くで、本に囲まれて働けたらうれしいです`。各応答には「モック」か「Claude Code」の印が付く。右の「詳細」に、最後の応答にかかった秒数と、費用の目安(CLI が返したもの)が出る。
6. 応答を待つ間は、右の「詳細」に「応答を止める」が出る。押すと Claude Code を止め、その発言は会話に残らない。書いた文は欄に残る。
7. モックに戻すときは、「接続を選ぶ」で「モック」を選ぶ。

決まり:

- 1 回の応答は 90 秒まで。超えたら止める。
- 1 回の応答の費用の上限として、$0.1 を Claude Code に渡す(`--max-budget-usd`)。
- Claude Code の応答は、1 つの会話で 30 回まで。試作品のコードが勝手に送り続けても、ここで止まる。「リセット」で数え直す。
- Studio を止めると(Ctrl+C)、応答を待っている Claude Code も止める。
- 接続の選択は試作品ごとに覚える。「リセット」しても変わらない。Studio を止めると、モックに戻る。
- 試作品の中のコードからは、接続を切り替えられない。切り替えと「応答を止める」は Studio の画面だけでできる。

Claude Code の起動のしかた(どれも Claude Code の CLI のフラグで、CLI は改変しない):

| フラグ | 理由 |
|---|---|
| `-p --output-format json --json-schema=…` | 1 回ずつ応答させ、`{ reply, updates }` の形で受け取る。形は `ai.json` の `fields` から作る。形どおりでないときは、本文の JSON を読み、それもなければ本文を返事にして条件は変えない |
| `--system-prompt=…` | `ai.json` の `instructions` に、Studio の決まり(覚える項目、本人の修正を優先する、など)を足して渡す |
| `--tools ""` | ツールを渡さない。ファイルもコマンドも Web も使わせない |
| `--restricted --safe-mode --strict-mcp-config --permission-mode dontAsk` | 利用者とプロジェクトの設定、CLAUDE.md、skills、plugins、hooks、MCP を読ませない |
| `--no-session-persistence` | `~/.claude/projects/` に会話を残さない。会話は Studio が持ち、毎回すべてを渡す |

発言と会話は argv に入れず、標準入力で渡す。作業フォルダーは、空の一時フォルダーにする。

### 画面の見方

| 場所 | 中身 |
|---|---|
| 左「試作品」 | 試作品の一覧。ビルドに失敗したものは「ビルドに失敗」と出る |
| 中央 | 試作品そのもの。「開き直す」で画面を読み直す(AI との会話と条件はそのまま)。「リセット」で AI との会話と条件を最初に戻してから開き直す。「作り直す」で `app/` のファイルからビルドし直す。「AI: モック」「AI: Claude Code」は、試作品の中の AI の接続を示す |
| 右「詳細」 | ビルドの結果、プロダクト内 AI の接続と切り替え、送るものと費用、最後の応答の秒数、AI が理解した状態、試作品の中で起きたエラーと知らせ |

### うまくいかないとき

| 出るもの | すること |
|---|---|
| ターミナルに「Node.js 22 以上が要ります」 | Node.js を入れ直す |
| ターミナルに「必要な部品が入っていません」 | `npm install` を実行してから `npm start` |
| ターミナルに「ポート 4317 は使われています」 | 別のターミナルで Studio が動いていないか確かめる。他のアプリが使っているなら、番号を変えて起動する(下の「環境変数」)。プレビュー用の 4318 は `STUDIO_PREVIEW_PORT` |
| 画面に「鍵がありません」「鍵が合いません」 | ターミナルに出た最新の URL(`#token=` を含む)を開き直す。起動し直すたびに鍵は変わる |
| 画面に「Studio のサーバーにつながりません」 | `npm start` のターミナルが開いたままか確かめる。止めたなら、もう一度 `npm start` |
| 右に「ビルドに失敗しました」 | 出ているファイルと行を直し、「作り直す」を押す。`app/ai.json` の誤りも、ここに項目の場所つきで出る |
| 試作品に「この試作品はプロダクト内 AI を使っていません」 | `app/ai.json` を置いて「作り直す」を押す(下の「プロダクト内 AI の設定」) |
| 試作品に「会話が長くなりすぎました」 | 「リセット」を押す(1 つの会話は 200 件まで) |
| 「接続を選ぶ」で Claude Code を選べず「まだ使えない設定です」 | 社内の利用条件を確かめてから、`STUDIO_ALLOW_CLAUDE_CODE=1 npm start` で起動し直す |
| 「Claude Code が見つかりません」 | Claude Code を入れる。入れた場所が PATH にないときは、`STUDIO_CLAUDE_BIN` に実行ファイルの場所を指定する |
| 「Claude Code にログインできていません」 | ターミナルで `claude` を起動してログインしてから、もう一度送る |
| 「Claude Code の利用の上限に当たりました」 | 時間をおいて送り直すか、「接続を選ぶ」でモックに戻す。会話は変わらない |
| 「1 回の応答の費用の上限に当たった」 | 指示や会話を短くするか、リセットしてから送る |
| 「Claude Code への発言は、1 つの会話で 30 回までです」 | 「リセット」で最初からやり直すか、モックに戻す |
| 「90 秒で応答しなかったので止めました」 | もう一度送る。続くときは、モックに戻す |

### データの置き場

- 試作品は `~/PrototypeStudio/projects/<試作品の ID>/app/` に置かれる(Windows は `%USERPROFILE%\PrototypeStudio`)。環境変数 `STUDIO_HOME` で変えられる。
- サンプルは、まだ置き場にないものだけが、起動のときに `sample-library` と `sample-job-consult` として写される。手を入れた後は上書きしない。最初の状態に戻したいときは、`~/PrototypeStudio/projects/<サンプルの ID>` を消して起動し直す。
- プロダクト内 AI との会話と条件は、Studio のメモリーにだけ置く。Studio を止めると消える。
- `app/` の入口は `main.jsx`(または `main.tsx`、`main.js`、`main.ts`)。使えるライブラリは React(`react`、`react-dom`)だけ。
- 自分で試作品を足すときは、`~/PrototypeStudio/projects/<英小文字・数字・ハイフンの名前>/app/main.jsx` を置き、画面で選んで「作り直す」を押す。

### プロダクト内 AI の設定(`app/ai.json`)

試作品の中で AI を使うときは、`app/ai.json` を置く。題材に依存しない形で、AI が覚える項目と、モックの応答の型を書く。見本は `samples/job-consult/app/ai.json`。

| 項目 | 中身 |
|---|---|
| `name` | AI の名前(詳細の欄に出る) |
| `instructions` | 実モデル(Claude Code)に渡す指示。モックは使わない |
| `fields` | AI が会話から読み取る項目。`type` は `choice`(`options` の `value` と `keywords` で読み取る)か `number`(`unit` が続く数を、`keywords` の後ろから読み取る。`min`、`max` で範囲を決める)。`question` は、その項目が未定のときに聞く文 |
| `initialState` | 項目の最初の値。書かない項目は未定 |
| `mock` | モックの応答の型。`greeting`(最初のあいさつ)、`understood`、`afterCorrection`、`notUnderstood`、`complete`。`{changes}` と `{summary}` が `項目名「値」` の並びに置き換わる |

試作品の画面からは `window.studio.ai` で呼ぶ。どれも、会話と状態の全体(`connection`、`fields`、`state`、`messages`)を返す。

| 呼び方 | 中身 |
|---|---|
| `studio.ai.session()` | 今の会話と状態 |
| `studio.ai.send(text)` | 利用者の発言を送り、AI の応答を受け取る |
| `studio.ai.correct({ key: 値 })` | AI が理解した状態を本人が直す。`null` で未定に戻す。次の応答はこの修正を踏まえる |
| `studio.ai.onChange(listener)` | Studio の画面で接続が切り替わったとき、新しい会話と状態を受け取る。戻り値の関数で受け取りをやめる |

会話の AI の発言には、応答した接続(`via`: `mock` か `claude-code`)と、待った時間(`elapsedMs`)が付く。Claude Code の応答には、CLI が返した費用の目安(`costUsd`、米ドル)も付く。

`ai.json` は、ビルドのたびに検査する。誤りは、ビルドの失敗として右の「詳細」に出る。

### 環境変数

| 名前 | 既定 | 中身 |
|---|---|---|
| `STUDIO_HOME` | `~/PrototypeStudio` | データの置き場 |
| `STUDIO_PORT` | `4317` | Studio の画面のポート。`0` で空いている番号 |
| `STUDIO_PREVIEW_PORT` | `4318` | 試作品を配信するポート。`0` で空いている番号 |
| `STUDIO_NO_OPEN` | なし | `1` でブラウザを自動で開かない |
| `STUDIO_ALLOW_CLAUDE_CODE` | なし | `1` でプロダクト内 AI に Claude Code(実モデル)を選べるようにする。社内の利用条件を確かめてから付ける |
| `STUDIO_CLAUDE_BIN` | `claude`(PATH から探す) | 起動する Claude Code の実行ファイル。テストでは偽の CLI を指す |

指定のしかた(例: Studio の画面のポートを 4327 にする):

- macOS のターミナル: `STUDIO_PORT=4327 npm start`
- Windows の PowerShell: `$env:STUDIO_PORT=4327; npm start`

## 開発

| コマンド | 中身 | 時間の目安 |
|---|---|---|
| `npm test` | 単体と結合のテスト(Node の test runner) | 数秒 |
| `npm run test:e2e` | ブラウザの E2E(Playwright の Chromium)。起動手順、サンプルの操作、モックの AI との会話と修正とリセット、偽の Claude Code への切り替えと履歴と失敗と中断、失敗の表示、試作品の隔離を確かめる | 30 秒以内 |

E2E のブラウザがないときは、`npx playwright install chromium` で入れる。どのテストも実モデルと外部の API を呼ばない。Claude Code は偽の CLI(`test/fixtures/fake-claude.js`)に差し替える。

### 構成

```
bin/studio.js          起動。失敗したときの案内もここで出す
src/server/            Studio のサーバー(画面と API、プレビューの配信、ビルド、app/ の検査)
src/server/product-ai/ プロダクト内 AI。ai.json の検査、モックと Claude Code の接続、プロジェクトごとの会話と状態
src/ui/                Studio の画面
src/runtime/runtime.js 試作品に配る runtime。試作品のエラーを Studio の画面に知らせ、window.studio.ai を配る
samples/library/app/   固定のサンプル試作品(架空の図書室)
samples/job-consult/app/ 固定のサンプル試作品(架空の求人相談とモックの AI)
test/                  unit、integration、e2e。fixtures/ に偽の Claude Code
```

隔離の方式は ADR-0001 に従う。Studio の画面は `127.0.0.1:4317`、試作品は別ポートの `localhost:4318` から、`sandbox` 属性つきの iframe と CSP で開く。

## 設計の記録

- [ADR-0001: ローカル実行と隔離の方式](docs/adr/0001-local-runtime-and-isolation.md)(仮採用)
