# agent-prototype-studio
Prototype and explore AI agent product experiences

## 起動のしかた

いまは段階 0 です。サンプル試作品(架空のデータを使う図書室の画面)を、自分の PC のブラウザで触れます。「作る」欄に依頼を書くと、作る AI が試作品のファイルを変え、「試す」画面に反映されます。

作る AI の既定は**偽接続**です。決まった依頼にだけ、決まった動きをします。Claude Code もモデルも外部の API も呼ばないので、料金はかかりません。本物の Claude Code につなぐ方法は、下の「作る AI を Claude Code に切り替える」に書きました。会社として利用条件が決まるまでは、切り替えないでください。

### 要るもの

- Node.js 22 以上。ターミナルで `node --version` を実行して確かめる。なければ https://nodejs.org/ から LTS 版を入れる。
- 偽接続で試すだけなら、Claude Code は要らない。

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
5. 左の「試作品」から「サンプル: 架空の図書室」を選ぶ。「試す」の枠の中で、本を探す、借りる、登録するなどを試せる。
6. 「作る」欄の「依頼」に、試作品の変え方を書いて「送る」を押す。偽接続で試せる依頼は、欄の下に並んでいる。押すと依頼の欄に入る。
   - 「見出しを「ひだまり図書室」にして」: `app/App.jsx` の見出しが変わり、「試す」画面に反映される。
   - 「app/ の外にメモを書いて」: 権限の確認で断られる様子が出る。ファイルは書かれない。
   - 「壊して」「直して」: ビルドに失敗したときの出方と、直し方を試せる。
   - 「失敗して」「ログインしていないふりをして」: 作る AI が失敗したときの出方を試せる。
   - 「ゆっくり進めて」: 30 秒かかる。作業中に「中断」を押せる。
7. 止めるときは、ターミナルで Ctrl+C を押す。

### 画面の見方

| 場所 | 中身 |
|---|---|
| 左「試作品」 | 試作品の一覧。ビルドに失敗したものは「ビルドに失敗」、作る AI が動いているものは「作る AI が作業中」と出る |
| 「作る」 | 作る AI への依頼と、その様子。上の枠に、どの接続で、どの認証で動くかを出す。会話には、AI の返事、読み書きしたファイル、断られた操作、失敗、Studio が確かめた「変わったファイル」とビルドの結果が出る |
| 「試す」 | 試作品そのもの。「開き直す」で最初の状態に戻す。「作り直す」で `app/` のファイルからビルドし直す |
| 右「詳細」 | ビルドの結果と、試作品の中で起きたエラー |

「作る」の依頼で動くのは作る AI だけです。「試す」の中の操作では、作る AI は動きません。作る会話は Studio を止めると消えます(ファイルの変更は残ります)。

### うまくいかないとき

| 出るもの | すること |
|---|---|
| ターミナルに「Node.js 22 以上が要ります」 | Node.js を入れ直す |
| ターミナルに「必要な部品が入っていません」 | `npm install` を実行してから `npm start` |
| ターミナルに「ポート 4317 は使われています」 | 別のターミナルで Studio が動いていないか確かめる。他のアプリが使っているなら、番号を変えて起動する(下の「環境変数」)。プレビュー用の 4318 は `STUDIO_PREVIEW_PORT` |
| 画面に「鍵がありません」「鍵が合いません」 | ターミナルに出た最新の URL(`#token=` を含む)を開き直す。起動し直すたびに鍵は変わる |
| 画面に「Studio のサーバーにつながりません」 | `npm start` のターミナルが開いたままか確かめる。止めたなら、もう一度 `npm start` |
| 右に「ビルドに失敗しました」 | 出ているファイルと行を直し、「作り直す」を押す。作る欄で直す依頼を送ってもよい |
| 作る欄に「送れませんでした: … 作業中です」 | 前の依頼が終わるか、「中断」を押すまで待つ。1 つの試作品で動く依頼は 1 つだけ |
| 作る欄に「時間の上限(10 分)を超えたので止めました」 | 依頼を小さく分けて送る |
| 作る欄に「Claude Code にログインしていないか…」 | ターミナルで `claude` を起動し、`/login` でログインしてから送り直す。Studio はログインの情報を扱わない |
| 作る欄の上の枠に「claude が見つかりません」「古すぎます」 | Claude Code を入れる、または `claude update` で更新する。別の場所にあるときは `STUDIO_CLAUDE_BIN` |

### データの置き場

- 試作品は `~/PrototypeStudio/projects/<試作品の ID>/app/` に置かれる(Windows は `%USERPROFILE%\PrototypeStudio`)。環境変数 `STUDIO_HOME` で変えられる。
- サンプルは初回の起動で `sample-library` として写される。手を入れた後は上書きしない。最初の状態に戻したいときは、`~/PrototypeStudio/projects/sample-library` を消して起動し直す。
- `app/` の入口は `main.jsx`(または `main.tsx`、`main.js`、`main.ts`)。使えるライブラリは React(`react`、`react-dom`)だけ。
- 自分で試作品を足すときは、`~/PrototypeStudio/projects/<英小文字・数字・ハイフンの名前>/app/main.jsx` を置き、画面で選んで「作り直す」を押す。

### 環境変数

| 名前 | 既定 | 中身 |
|---|---|---|
| `STUDIO_HOME` | `~/PrototypeStudio` | データの置き場 |
| `STUDIO_PORT` | `4317` | Studio の画面のポート。`0` で空いている番号 |
| `STUDIO_PREVIEW_PORT` | `4318` | 試作品を配信するポート。`0` で空いている番号 |
| `STUDIO_NO_OPEN` | なし | `1` でブラウザを自動で開かない |
| `STUDIO_AGENT` | `fake` | 作る AI。`fake` は偽接続、`claude` は Claude Code |
| `STUDIO_CLAUDE_BIN` | PATH の `claude` | `STUDIO_AGENT=claude` のときに起動する Claude Code の場所 |
| `STUDIO_MAX_BUDGET_USD` | `1` | API キーなど、サブスクの枠でないときに、1 回の依頼に付ける費用の上限(ドル) |

指定のしかた(例: Studio の画面のポートを 4327 にする):

- macOS のターミナル: `STUDIO_PORT=4327 npm start`
- Windows の PowerShell: `$env:STUDIO_PORT=4327; npm start`

## 作る AI を Claude Code に切り替える

実モデルを呼ぶので、次の 2 つが決まるまでは切り替えないでください。会社として Anthropic の Commercial Terms に同意するか。社内の利用条件とデータの扱い。試作には架空のデータだけを使ってください。

1. Claude Code 2.1.248 以上を入れ、ターミナルで `claude` を起動して、本人のアカウントでログインしておく。
2. `STUDIO_AGENT=claude npm start`(Windows の PowerShell は `$env:STUDIO_AGENT='claude'; npm start`)で起動する。
3. 「作る」欄の上の枠で、版と「認証と課金」を確かめてから送る。
   - 環境に `ANTHROPIC_API_KEY` があると、サブスクの枠ではなく API の料金がかかる。枠にそう出る。そのときは 1 回の依頼に費用の上限(`STUDIO_MAX_BUDGET_USD`)を付ける。
   - 見込みは環境変数の有無だけから出す。Console(API)のアカウントで `claude` にログインしているときも API の料金がかかるが、送る前には見分けられない。
   - 実際にどれで動いたかは、会話の各依頼の終わりに「認証の報告」として出る(Claude Code が報告する `apiKeySource`)。

Studio が Claude Code をどう動かすか:

- 利用者が入れた `claude` を、改変せずに子プロセスとして起動する。ログインは Claude Code 自身のものを使う。Studio は資格情報やトークンを読まない、保存しない、仲介しない。環境変数は利用者のものをそのまま渡す。
- `claude -p --restricted --safe-mode --tools Read,Edit,Write,Glob,Grep --permission-mode dontAsk --permission-prompts none --strict-mcp-config --no-session-persistence --output-format stream-json` で起動する。作業ディレクトリは試作品の `app/`。依頼の文は stdin で渡す。
- 読み書きを `app/` の中に限り、コマンドの実行と Web の取得をさせない設定で起動する。権限の確認は Claude Code が行い、確認が要る操作は断られる。断られた操作は会話に出す。この守りが実機で効くかは、まだ確かめていない(下の「実機で確かめる」)。
- 依頼ごとに新しい会話で動かす。前の依頼の内容は、`app/` のファイルを通じて引き継がれる。
- 1 回の依頼は 10 分、やりとりは 30 回まで。中断や時間切れでは、SIGINT、SIGTERM、強制終了の順に止める。本体が終わった後に残った子のプロセスも止める。Studio を止めたとき(Ctrl+C、ターミナルを閉じたとき)も、動いている作る AI を止める。

Windows の npm 版(`claude.cmd`)は使えない。ネイティブ版の `claude.exe` を入れる。

### 実機で確かめる

`--restricted` などの守りが実機で効くかを、架空のデータだけで確かめるスクリプトがある。実モデルを呼ぶので、上の 2 つが決まってから実行する。

```sh
npm run check:claude            # 何を確かめるかを出すだけ
npm run check:claude -- --run   # 実機で確かめる
```

確かめること: 本人のログインのまま非対話で動くか、`app/CLAUDE.md` と `app/.claude/settings.json` の hooks が効かないか、`app/` の外への書き込みと読み出しが止まるか、断られたことが出るか、中断で止まるか。API の料金がかかる見込みのときは、`--allow-api-billing` を付けない限り止まる。

## 開発

| コマンド | 中身 | 時間の目安 |
|---|---|---|
| `npm test` | 単体と結合のテスト(Node の test runner)。作る欄の API、偽の CLI に渡る引数と stdin、確認スクリプトの空回しを含む | 数秒 |
| `npm run test:e2e` | ブラウザの E2E(Playwright の Chromium)。起動手順、サンプルの操作、失敗の表示、試作品の隔離、作る欄の依頼・変更・反映・拒否・失敗・中断を確かめる | 1 分以内 |

E2E のブラウザがないときは、`npx playwright install chromium` で入れる。どのテストも実モデルと外部の API を呼ばない。作る AI は偽接続(`src/agent/fake-claude.js`)か、それを呼ぶ偽の `claude` に差し替える。

### 構成

```
bin/studio.js          起動。失敗したときの案内もここで出す
src/server/            Studio のサーバー(画面と API、プレビューの配信、ビルド、app/ の検査、作る AI の起動)
src/agent/             偽接続(Claude Code の代わりに、決まった動きをする CLI)
scripts/               実機の Claude Code で守りを確かめるスクリプト
src/ui/                Studio の画面
src/runtime/runtime.js 試作品に配る runtime。試作品のエラーを Studio の画面に知らせる
samples/library/app/   固定のサンプル試作品(架空のデータ)
test/                  unit、integration、e2e
```

隔離の方式は ADR-0001 に従う。Studio の画面は `127.0.0.1:4317`、試作品は別ポートの `localhost:4318` から、`sandbox` 属性つきの iframe と CSP で開く。

## 設計の記録

- [ADR-0001: ローカル実行と隔離の方式](docs/adr/0001-local-runtime-and-isolation.md)(仮採用)
