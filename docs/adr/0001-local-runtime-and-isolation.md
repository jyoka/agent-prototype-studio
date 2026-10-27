# ADR-0001: ローカル実行と隔離の方式

- 状態: **仮採用**(2026-10-28)。#273 以降はこの方式で進める。利用者が 2026-10-28 の朝に確かめ、変えるなら別のカードで直す。
- 出典のタスク: jyoka/tasks#272(親 PRD: jyoka/tasks#269、前提の調査: jyoka/tasks#270)
- 確認日: 2026-10-28。Claude Code の記述は公式ドキュメント([cli-reference](https://code.claude.com/docs/en/cli-reference)、[permissions](https://code.claude.com/docs/en/permissions)、[permission-modes](https://code.claude.com/docs/en/permission-modes)、[headless](https://code.claude.com/docs/en/headless))と、手元の `claude --help`(v2.1.311)で確かめた。実モデルは呼んでいない。

## 決定(仮採用)

利用者の PC で、loopback(127.0.0.1)だけで待ち受けるローカルのサーバーを動かし、既定のブラウザで操作する。守りを 3 つの層に分ける。

| 層 | 何を閉じ込めるか | 方法 |
|---|---|---|
| 1. 作る AI(Claude Code) | ファイルの読み書きを、そのプロジェクトの `app/` だけにする。コマンド実行と Web 取得はさせない | 未改変の `claude -p` を `--restricted` で起動する。作業ディレクトリは `app/`、使えるツールは読み書きだけにする |
| 2. 生成コード | ブラウザの中だけで動かす。サーバー側では実行しない。ネットワーク、Studio の API、他のプロジェクトに触れさせない | 別ポートから配信し、`sandbox` 属性つきの iframe(opaque origin)と CSP で表示する。外とのやり取りは親画面経由の決まったメッセージだけにする。残る危険は「生成コードの隔離」の節に書く |
| 3. Studio のサーバー | 他の PC、他の Web サイト、他のローカルのプロセスから操作させない | 127.0.0.1 だけで待ち受ける。Host と Origin を確かめ、起動ごとのトークンを要求する |

その上で、AI の判断と、決まった手順で必ず行う処理を分ける。決まった手順とは、パスの検査、ビルド、診断、版の保存を指す。Stripe の Minions の考え方に合わせている。

## 背景と前提

- 親 PRD(#269): 独立した汎用ツール。最初は利用者自身の PC で動かす。生成コードとエージェントのファイル・ネットワーク・外部コマンドは、脅威モデルに基づいて制限する。「ブラウザ内実行だけで安全とみなさない」。実データは使わず、架空データを使う。
- 接続先(#269 のコメント、2026-10-27 に利用者が決めた): 最初の作る AI は Claude Code。
- #270 で確かめた条件(#274 の Ready conditions に転記済み):
  - 未改変の CLI を、利用者本人のログインで動かす。
  - ツールは資格情報を集めない、保存しない、仲介しない。
  - `ANTHROPIC_API_KEY` があると API 課金になる。
  - `-p` は `--bare` なしだと、作業ディレクトリの `.claude/settings.json` の hooks と `.mcp.json` を、信頼の確認なしに動かす。ただし `--bare` は OAuth を読まないので、本人ログインと両立しない。
  - Claude Code のサンドボックスはシェルだけが対象で、ネイティブ Windows では効かない。
- 2026-10-28 に確かめた新しい事実: Claude Code v2.1.248 以降に `--restricted` がある([cli-reference](https://code.claude.com/docs/en/cli-reference))。#270 の「安全と本人認証がぶつかる」を解く鍵になる。詳しくは「作る AI の起動」の節に書く。

## 構成要素

```
ブラウザ(既定のブラウザ)
├─ Studio 画面  http://127.0.0.1:<studio-port>    … 作る会話、試す画面の枠、詳細
│   └─ iframe   http://localhost:<preview-port>/p/<project>/<build>/
│                 sandbox="allow-scripts allow-forms"(allow-same-origin なし)
│                 … 生成された試作品
│
Studio サーバー(Node.js、1 プロセス、利用者の権限で動く)
├─ Studio API(127.0.0.1:<studio-port>)  … トークン必須
├─ プレビュー配信(<preview-port>)       … 静的ファイルだけ。API なし
├─ ビルド(esbuild を API として使う)    … 生成コードを実行しない
├─ 作る AI の接続(Claude Code の子プロセス、または偽接続)
└─ プロダクト内 AI の接続(モック、または実モデル)

データの置き場: ~/PrototypeStudio/projects/<project-id>/
├─ app/       … 作る AI が書ける唯一の場所。Claude Code の作業ディレクトリ
└─ .studio/   … ツールだけが書く。設定、ビルド結果、版、ログ
```

- サーバーの言語は Node.js(LTS、22 以上を想定)にする。理由は 3 つある。
  - ビルド(esbuild)とブラウザの E2E(Playwright)が同じ言語で揃う。
  - macOS と Windows で同じコードが動く。
  - 手元の Mac には Node v23 がある。
- データの置き場は `~/PrototypeStudio`(Windows は `%USERPROFILE%\PrototypeStudio`)を既定にする。環境変数 `STUDIO_HOME` で変えられるようにする。
  - Finder から見える場所にする。非エンジニアが自分のファイルを見つけられるようにするため。
  - `~/Documents`、`~/Desktop`、`~/Downloads` は避ける。macOS の保護フォルダーで、アクセスの許可を求められることがある([permissions](https://code.claude.com/docs/en/permissions) の Working directories 節)。OneDrive で同期されるフォルダーも避ける。

## データの経路(ブラウザの操作からプレビューまで)

### 作る(試作品を変える)

1. 利用者が Studio 画面の作る欄に依頼を書く。
2. 画面が `POST /api/projects/<id>/build-requests` を送る。ヘッダーに起動ごとのトークンを付ける(すべての API で必須。層 3)。
3. サーバーが検査する(決まった処理)。
   - Host、Origin、トークン。
   - プロジェクト ID の形(`[a-z0-9-]` だけ)。
   - 同じプロジェクトで実行中の依頼がないこと(1 プロジェクト 1 実行)。
4. サーバーが作る AI を起動する。偽接続のときは偽の CLI を起動する。作業ディレクトリは `projects/<id>/app/`。
5. AI の出力(stream-json)を、サーバーが画面に流す。画面は `fetch` の応答をストリームで読む。`EventSource` はヘッダーにトークンを付けられないので使わない。AI の文章は、画面では文字として出す(HTML として埋め込まない)。
6. AI が `app/` のファイルを読み書きする。Anthropic に送られるのは、依頼の文、AI が読んだ `app/` のファイル、会話、Claude Code のシステムプロンプトになる。システムプロンプトには、作業ディレクトリの絶対パスや OS の情報も入る。
   - AI のツールは `app/` の外を読めない(層 1)。
   - ただし、`--bare` なしの `-p` は、`~/.claude/CLAUDE.md` などの CLAUDE.md、skills、auto memory を自動で読み込む(headless)。`--restricted` が外すのは設定ファイルだけなので、これらは送られ得る。`--safe-mode` で止める(下の「作る AI の起動」)。
7. AI の実行が終わったら、サーバーが決まった手順を行う。
   - `app/` の検査: シンボリックリンク、許可しない名前(`.claude/`、`.mcp.json`、`.git`、`CLAUDE.md` など)、大きさとファイル数の上限。`CLAUDE.md` は保護されたパスではないので、AI が書けてしまう。書かれると、次の実行の指示に混ざる。
   - ビルド: esbuild で `app/` を 1 つの classic script(IIFE)に束ね、`.studio/builds/<build-id>/` に置く。`<build-id>` は推測できない乱数にする。import の解決先は、`app/` の中と、Studio が同梱するライブラリだけに限る。プロジェクトの `tsconfig.json` やビルドの設定は読まない。ES modules にしないのは、opaque origin からの module の読み込みが CORS の要求(`Origin: null`)になり、`Access-Control-Allow-Origin` を付ける必要が出るため。
   - 診断: コンパイルのエラーを集める。
8. 画面がプレビューの iframe を新しいビルドに切り替える。
9. 試作品の実行時エラーと console は、iframe から親画面へメッセージで送る。親画面がサーバーに渡し、詳細の欄に出す。次の依頼で、AI に診断として渡せる。

### 試す(試作品を操作する)

1. 利用者が iframe の中の試作品を操作する。
2. 試作品からプロダクト内 AI を呼ぶときは、Studio が配る小さな runtime を使う。試作品は `fetch` を使えない(CSP の `connect-src 'none'`)。
3. 親画面と試作品は `MessageChannel` でやり取りする。
   - 親画面は、自分が iframe に読み込ませた直後の `load` でだけ、port を 1 つ渡す。それ以外の `load`(試作品が自分で別の URL へ移動した場合)が来たら、iframe を作り直して警告を出す。
   - 理由: opaque origin なので `event.origin` は `"null"` になり、判定に使えない。`event.source` が iframe の `contentWindow` かどうかの判定も、iframe が自分で移動すると移動先のページでも通ってしまう。
   - 親画面はメッセージの形を確かめてからサーバーへ送る。`postMessage(..., '*')` で返事をしない。
4. サーバーが、モック(既定)か実モデルに渡し、結果を親画面経由で iframe に返す。
5. 状態(会話、架空データ)は、サーバー側のプロジェクトごとの場所に置く。試作品の `localStorage` は使えない(opaque origin)。こうすると、リセット、状態の表示、版の保存をツール側で決まった手順として扱える。

試作品から届くメッセージで、作る AI は動かない。作る AI を動かせるのは、利用者が作る欄に書いた依頼だけにする。PRD の「作る AI への指示と、プロダクト内 AI への発話を混同しない」に合わせる。

## 作る AI(Claude Code)の起動

偽接続でも実接続でも、組み立てる引数は同じにする。偽接続では、実行ファイルを偽の CLI に差し替えるだけにする。

```
claude -p
  --restricted                         # 下の箇条書き
  --safe-mode                          # CLAUDE.md、skills、plugins、hooks、MCP、auto memory を読まない
  --tools "Read,Edit,Write,Glob,Grep"  # コマンド実行と Web を名前で入れない
  --permission-mode dontAsk            # 確認が要る操作は拒否する
  --permission-prompts none            # 誰も答えない。拒否を AI に伝え、再試行させない
  --allowedTools "Read,Edit,Write,Glob,Grep"
  --strict-mcp-config                  # .mcp.json を読まない(--mcp-config は渡さない)
  --output-format stream-json --verbose
  --max-turns <上限>
  --append-system-prompt <Studio の制約: 使えるライブラリ、runtime の使い方など>
stdin: <利用者の依頼>                  # argv に入れない
cwd: ~/PrototypeStudio/projects/<id>/app/
```

- 依頼の文は stdin で渡す。argv に入れると、`-` で始まる依頼がフラグとして読まれる。Windows で npm 版の `claude.cmd` を起動するときは cmd.exe を通るので、argv の文字がコマンドとして解釈される恐れもある。
- `--safe-mode` は、CLAUDE.md、skills、installed plugins、hooks、MCP servers などを外し、認証と組み込みのツールと権限はそのまま動かす(`claude --help`)。`--restricted` と一緒に使えるかは要実機。
- 「作る」会話の続き: #274 で、依頼ごとに新しい会話で動かすことにした(仮)。`--resume` は使わず、`--no-session-persistence` を付ける。前の依頼の内容は `app/` のファイルを通じて引き継ぐ。下の「#274 で決めたこと」。

`--restricted` について公式に書かれていること(cli-reference、permission-modes):

- 命令やコードを実行する組み込みツール(Bash、PowerShell など)と WebFetch を外す。`--tools` で個別に名前を挙げたときだけ戻る。
- 組み込みのファイル操作を、作業ディレクトリ(と `--add-dir`)の中に閉じ込める。
- 読み込む設定は managed settings と `--settings` だけ。利用者とプロジェクトの設定ファイルは読まない。したがって、`app/.claude/settings.json` の hooks は読まれない。
- `bypassPermissions` を拒む。保護されたパス(`.git`、`.claude`、`.mcp.json`、`.npmrc` など)への書き込みを、分類器が許すこともない。`dontAsk` では、保護されたパスへの書き込みは拒否される。
- シンボリックリンク: 許可のルールは、要求したパスと実体の両方が合うときだけ効く。Edit と Write は、シンボリックリンクそのものへの書き込みを拒む。

公式に書かれていないので実機で確かめること(#274):

- `--restricted` が本人の OAuth ログインを使うか。`--bare` と違い、認証を変えるとは書かれていない。私は使うと推測している。
- 作業ディレクトリの外への読み書きが、実際に拒否されるか。
- `--safe-mode` で、`~/.claude/CLAUDE.md` と `app/CLAUDE.md` が読み込まれなくなるか。
- 本人が入れた mod が動かないか。`dontAsk` でも「入れた mod は一部の呼び出しを許可できる」と書かれている(permission-modes)。`--safe-mode` で外れると推測している。
- managed settings(組織の管理者の設定)は、`--restricted` でも読まれ、どのフラグよりも優先される。組織の設定は信頼する前提にする。

方式全体で守ること:

- 起動するのは利用者が入れた `claude` そのもので、改変しない。シェルの alias は効かない(子プロセスとして直接起動するため)。場所は PATH で探し、`STUDIO_CLAUDE_BIN` で変えられるようにする。偽接続はこの変数で差し替える。
- 資格情報は扱わない。環境変数は利用者のものをそのまま渡す。ただし、ログに出さない。`ANTHROPIC_API_KEY` の有無は、実行の前に画面に出す(#274)。
- 時間の上限を超えたら止める。macOS では、SIGINT、少し待って SIGTERM、最後にプロセスグループごと強制終了する。CLI は SIGTERM で 143 を返す(headless)。Windows にはシグナルとプロセスグループがないので、`taskkill /T /F` でプロセスの木ごと止める。
- 自動で直すのは 1 回までにする。コンパイルのエラーを AI に返して直させるのは 1 回だけで、それでも直らなければ利用者に返す。Minions の考え方に合わせる。

## 生成コードの隔離(層 2)

| 守り | 中身 | 防ぐもの |
|---|---|---|
| サーバーで実行しない | `npm install`、package.json の scripts、プロジェクトのビルド設定は使わない。使えるライブラリは Studio が同梱するもの(React など)だけ | 依存パッケージやスクリプト経由で PC 上でコードが動くこと |
| 別ポートから配信 | プレビューは `<preview-port>` から、静的ファイルだけを配信する。Studio の API はこのポートに置かない | 試作品が Studio の API を同一 origin として呼ぶこと |
| iframe の `sandbox` | `allow-scripts allow-forms`。`allow-same-origin`、`allow-top-navigation`、`allow-popups` は付けない | 親画面の DOM とストレージへのアクセス、ページの乗っ取り、新しいウィンドウ |
| 試作品の CSP ヘッダー | `sandbox allow-scripts allow-forms; default-src 'none'; script-src <そのビルドの URL>; style-src <そのビルドの URL> 'unsafe-inline'; img-src <そのビルドの URL> data: blob:; connect-src 'none'; form-action 'none'; frame-ancestors http://127.0.0.1:<studio-port>`。CSP の `sandbox` は、プレビューの URL を直接開いても効く。`'self'` ではなくパスつきの URL にするのは、他のプロジェクトのビルドを読ませないため | 外部への通信(fetch、XHR、WebSocket、sendBeacon)、外部の画像やスクリプト、他のプロジェクトのファイル、Studio 以外の画面への埋め込み |
| Studio 画面の CSP ヘッダー | `frame-src http://localhost:<preview-port>`、`frame-ancestors 'none'` | 試作品が iframe ごと外部の URL へ移動して、URL にデータを載せて送ること。Studio 画面が他のサイトに埋め込まれること |
| 配信の検査 | Host ヘッダーを確かめる。URL のパスを実パスに直し、`.studio/builds/<build-id>/` の中だけを返す。シンボリックリンクはたどらない | DNS rebinding、パス・トラバーサル、リンク経由での PC のファイルの読み出し |
| 親画面のメッセージ検査 | `MessageChannel` の port を、親画面が始めた読み込みにだけ渡す。形を確かめ、回数を制限する | 試作品からの実モデルの連打、移動先のページからのなりすまし、作る AI の起動 |

この表の守りでも防げない通信がある(残る危険)。WebRTC(STUN への接続)は `connect-src` で止まらない。DNS の先読みで、ホスト名にデータを載せられる恐れもある。漏れ得るのは試作品の中にあるもの、つまり架空データと試作の設計だけになる。PC のファイルと資格情報は試作品から見えない。

プロジェクト間の隔離:

- ファイル: 作る AI の作業ディレクトリは、そのプロジェクトの `app/` だけ。
- ブラウザ: opaque origin なので、プロジェクトどうしでストレージを共有しない。CSP のパスと、推測できない `<build-id>` で、他のプロジェクトのビルドを読ませない。
- 状態: サーバーがプロジェクト ID ごとに分けて置く。

## Studio サーバーの守り(層 3)

- 待ち受けは loopback だけにする(`127.0.0.1`、プレビューは `localhost` で引けるよう `::1` も)。`0.0.0.0` にはしない。同じネットワークの他の PC から届かないようにするため。
- Host ヘッダーは、自分の `127.0.0.1:<port>` と `localhost:<port>` だけを受ける。Studio とプレビューの両方のポートで確かめる。DNS rebinding で、外のサイトに localhost を呼ばせないようにするため。
- Studio の API は、読むだけのものも含めて、すべて `X-Studio-Token` ヘッダーを要求する。状態を変える API は、Origin が Studio 画面であることも確かめる。CORS は許可しない。
  - トークンは起動ごとに乱数で作る。起動時に開く URL のフラグメント(`#token=`)で画面に渡す。フラグメントはサーバーにもログにも届かない。画面は読んだ後に `history.replaceState` でフラグメントを消し、履歴に残さない。
  - Cookie は使わない。Cookie はポートで分かれないので、プレビューのポートに届いてしまうため。
- AI の文章、ファイル名、試作品からのエラー文は、Studio 画面で文字として出す。Studio 画面はトークンを持つ特権の画面なので、ここでの XSS が一番危ない。

## 脅威モデル

守るもの: 利用者のファイル(ホームディレクトリ)、Claude の資格情報、他のプロジェクト、サブスクの枠と費用、Studio そのもの、試作のアイデア(社内情報)。

| # | 脅威(誰が、何を) | 主な守り | 残る危険 |
|---|---|---|---|
| T1 | 作る AI が `app/` の外へ書く、または外を読んで送る(AI の誤り、取り込んだファイルの prompt injection) | `--restricted`、`--safe-mode`、`--tools` を読み書きだけにする、`dontAsk`。AI の実行後に `CLAUDE.md` などを検査する | Claude Code の実装の不具合。要実機(#274) |
| T2 | プロジェクトに置かれた設定が、PC で命令を動かす(`.claude/settings.json` の hooks、`.mcp.json`、git hooks、npm scripts) | `--restricted` は利用者とプロジェクトの設定を読まない。`--strict-mcp-config`。保護されたパスへの書き込みは拒否。ツールは npm を動かさない。版の保存は git を使わず、`.studio/` にファイルの写しを置く(#278) | 将来、外から試作品を取り込むときの検査。未設計 |
| T3 | 生成コードが Studio の API、他のプロジェクト、外部へ届く | 層 2 の表 | WebRTC と DNS の先読みによる外部への通信(架空データと試作の設計が漏れ得る)。ブラウザの不具合 |
| T4 | 他の Web サイトや同じネットワークの PC が、Studio を操作する(CSRF、DNS rebinding) | 層 3 | 同じ利用者の権限で動くマルウェアは対象外 |
| T5 | 生成コードやメッセージが、Studio 画面で XSS を起こす | 文字として出す。試作品は別ポートかつ opaque origin | Markdown の表示を足すときに、無害化が要る |
| T6 | 意図しない課金、枠の使い切り | 既定はモック。実モデルは利用者が明示して切り替える。`ANTHROPIC_API_KEY` の有無を画面に出す。`--max-turns`、時間の上限、メッセージの回数制限。プロダクト内 AI の Claude Code は、`--max-budget-usd` を付け、1 つの会話で 30 回までにする(#276) | サブスクの枠は量が非公開で、事前に見積もれない(#270) |
| T7 | 資格情報の漏れ | ツールは資格情報を読まない、保存しない、ログに環境変数を出さない。`--restricted` は `app/` の外を読ませない | Claude Code の会話の記録(`~/.claude/projects/`)に試作の中身が残る。利用者の PC の中に限る |
| T8 | 暴走(大量のファイル、無限ループ) | AI の実行後に、大きさと数の上限を確かめる。時間の上限。試作品の無限ループには、iframe の作り直しで対処 | 試作品が Studio 画面と同じプロセスで動くと、画面ごと固まる。プレビューを別ホスト名(`localhost`)にすると、Chrome のサイト分離で別プロセスになると推測している。要実機 |

対象外: 同じ利用者の権限で動くマルウェア、PC への物理的なアクセス、Claude Code や Anthropic そのものが悪意を持つ場合。

## macOS と Windows

| 項目 | macOS | Windows |
|---|---|---|
| Studio サーバー | Node.js で動く | 同じコードで動く(パスは `path` で扱う) |
| 作る AI の閉じ込め | `--restricted` は Claude Code 自身の制限で、OS のサンドボックスに頼らない | 同じ。ネイティブ Windows で Claude Code のサンドボックスが効かないこと(#270)の影響を受けない(推測。要実機) |
| パスの検査 | 実パス(`realpath`)で比べる。APFS は既定で大文字と小文字を区別しない | 大文字と小文字、`\` と `/`、ジャンクション、8.3 形式の短い名前に注意する。Claude Code はジャンクションもシンボリックリンクとして扱う(permissions の Symlinks 節) |
| ファイアウォール | loopback だけの待ち受けなら、受信の許可を求められないと推測している | 同じ(推測) |
| 起動 | ターミナルで `npm start`。後に、ダブルクリックで起動するファイルを用意する | 同じ。`.cmd` を用意する |
| 確かめ | 手元の Mac で確かめる | CI(windows-latest)で単体と偽接続の E2E を回す。実機の Claude Code は未確認 |

## 非エンジニアの導入(段階)

| 段階 | 中身 | 利用者の手間 |
|---|---|---|
| 0(2026-10-28 の朝) | リポジトリを clone して `npm install`、`npm start`。ブラウザが開く。固定のサンプルを偽接続とモックで触る | ターミナルが要る。Claude Code は要らない |
| 1(#274 以降) | 起動時に「前提の確認」の画面を出す。Node、`claude` の有無と版(2.1.248 以上)、ログインの状態(`claude auth status --json` を候補にする。モデルを呼ぶかは要確認)、`ANTHROPIC_API_KEY` の有無を見せる。ダブルクリックで起動するファイルを用意する | Claude Code の導入と最初のログインは、まだターミナルが要る |
| 2(未決) | 署名つきのアプリにする(Electron、Tauri、Node の単一実行ファイルなど)。中の隔離の方式は同じ | ターミナルが要らない。Claude Code の導入は残る |

## 検討した候補とトレードオフ

| 候補 | 長所 | 短所 | 判断 |
|---|---|---|---|
| A. ローカルのサーバーとブラウザ、`--restricted` の CLI、sandbox の iframe(この ADR) | 追加の導入なし。macOS と Windows で同じ。本人ログインと両立する(推測)。偽接続で E2E を組める | `--restricted` と iframe の仕組みに頼る。OS のレベルの隔離ではない | **仮採用** |
| B. A に、OS のサンドボックス(macOS の Seatbelt など)で CLI を包む | ファイルの閉じ込めが二重になる | macOS だけ。`sandbox-exec` は非推奨。Claude Code のキーチェーンの読み出しとぶつかる恐れ | 後の強化の候補 |
| C. プロジェクトごとのコンテナや VM(Docker、Lima、devcontainer) | 隔離が最も強い。Minions の devbox に近い | Docker Desktop の導入と契約。管理者権限、資源。本人のログインをコンテナに持ち込むと、資格情報を仲介する形になる(#270 の条件に触れる恐れ) | 今は採らない |
| D. デスクトップアプリ(Electron、Tauri) | 非エンジニアが導入しやすい | 配布、署名、更新の手間。隔離の方式は A と同じ | A の配布の形として段階 2 で検討 |
| E. クラウドで動かす(Harbor 型) | 導入がない | PRD は「最初は利用者の PC」。ホストする形は Claude の規約の条件が重い(#270) | 範囲外 |
| F. ブラウザだけ(WebContainers など) | サーバーが要らない | 作る AI の CLI はブラウザで動かない | 採らない |
| A'. A で、作る AI に Bash を許す(acceptEdits と Claude Code のサンドボックス) | AI が自分でテストやビルドを回せる | ネイティブ Windows でサンドボックスが効かない。サンドボックスが起動できないと隔離なしで動く(#270) | 採らない。ビルドと診断はツールが決まった手順で行う |

## テストの方法

実モデルは呼ばない。作る AI は偽の CLI に差し替える。

| 層 | テスト | 確かめること |
|---|---|---|
| 単体 | パスの検査 | `..`、絶対パス、シンボリックリンク、Windows の区切りと大文字小文字で、`app/` と builds の外に出られない |
| 単体 | CLI の引数の組み立て | `--restricted`、`--safe-mode`、`--tools`、`--permission-mode dontAsk`、`--strict-mcp-config`、cwd が必ず入る。依頼の文が argv に入らない。`--dangerously-skip-permissions`、`bypassPermissions` が入らない |
| 結合 | Studio サーバーの守り | Host が違えば 403。Origin とトークンがなければ 403。待ち受けが loopback だけ(LAN のアドレスからつながらない) |
| 結合 | 偽の CLI | 偽の CLI が stream-json を出し、ファイルを書き、受け取った argv、cwd、環境変数の名前を記録する。成功、失敗、時間切れ、拒否(`permission_denied`)、中断を再現する |
| ブラウザ E2E(Playwright) | 作る、試す | 依頼、偽の CLI による変更、プレビューへの反映、エラーの表示 |
| ブラウザ E2E | 悪意のある試作品 | 見本の試作品が、Studio の API への `fetch`、外部の画像、`localStorage`、`window.top` の書き換え、親画面の DOM の読み出し、自分自身の外部への移動、他のプロジェクトのビルドの読み込みを試みる。すべて失敗する。移動したときは iframe が作り直され、警告が出る |
| ビルド | import の制限 | `app/` の外のファイルや、同梱していないパッケージを import すると、ビルドが失敗する |
| 実機(許可と予算があるときだけ。#274) | Claude Code | 本人ログインで `--restricted` と `--safe-mode` が一緒に動く。`app/` の外への読み書きが拒否される。`app/.claude/settings.json` の hooks と `CLAUDE.md` が読まれない。中断の挙動 |

## Stripe の設計思想と範囲

- Harbor と Drydock: 「成果物(複数ファイル)」と「描画・実行の能力」の間の境界をはっきりさせる。この ADR では、ビルド結果と runtime のメッセージがその境界になる。プレビューは特定の製品や題材に依存しない。
- Minions: AI の判断(ファイルの編集)と、決まった手順(検査、ビルド、診断、版)を分ける。隔離した作業場所で、渡すツールを小さく選び、直す回数に上限を置く。
- 範囲: 求人、LINE、aica を前提にしない。プロジェクトは汎用のディレクトリで、題材ごとの差は `app/` の中身だけにする。Stripe の内部の実装は推測していない。

## #273 で分かったこと(2026-10-28)

- 試作品の script には `crossorigin="anonymous"` を付け、プレビューは `Origin: null` の要求にだけ `Access-Control-Allow-Origin: null` を返す。
  - 理由: opaque origin の文書から読んだ script は、すべて別 origin になる。CORS なしだと、実行時エラーの中身が `Script error.` に隠れ、詳細の欄で利用者に伝えられない。
  - 影響: 他の opaque origin の文書も、版の URL を知っていればファイルを読める。版の ID は推測できない乱数で、表示中の版だけを返すので、受け入れた。classic script(IIFE)のままにする理由は変わらない。
- 起動ごとのトークンは、画面が `sessionStorage` に置く。再読み込みしても使い続けるため。プレビューは別 origin(かつ opaque origin)なので読めない。
- 同梱するライブラリは、まず React(`react`、`react-dom`)だけにした。

## #274 で決めたこと(2026-10-28、仮)

利用者が朝まで答えないので、推奨の既定で仮に決めた。変えるなら別のカードで直す。

- 作る AI の既定は偽接続(`src/agent/fake-claude.js`)。Claude Code は `STUDIO_AGENT=claude` で利用者が明示したときだけ起動する。会社の利用条件が決まるまで、実モデルを呼ばないため。`STUDIO_CLAUDE_BIN` は Claude Code の場所を変える変数にした(上の「方式全体で守ること」では偽接続の差し替えにも使う想定だった)。
- 偽接続は、Studio が組み立てた引数をそのまま受け取る。上の「作る AI の起動」の守り(`--restricted`、`--safe-mode`、`dontAsk` など)が欠けていれば、失敗して終わる。偽接続と実接続で引数が同じであることを、E2E のたびに確かめるため。
- 引数は上の「作る AI の起動」のとおり。加えて `--no-session-persistence` を付ける。`--max-budget-usd` は、サブスクの枠でない見込み(`ANTHROPIC_API_KEY`、`ANTHROPIC_AUTH_TOKEN`、クラウド経由)のときだけ付ける。既定は 1 ドルで、`STUDIO_MAX_BUDGET_USD` で変えられる。
- 権限の確認: `--permission-mode dontAsk --permission-prompts none` のままにした。画面で許可を受ける形(SDK の `canUseTool` や `--permission-prompt-tool`)は採らない。断られた操作は、stream-json の `result.permission_denials` と、エラーになったツールの結果から、作る会話に出す。
  - 理由: 許可を画面で受けると、利用者が意味のわからない許可を押し、閉じ込めを自分で外す道ができる。`--restricted` では、設定や git のファイルへの書き込みを人が許可できてしまう。
- 認証と課金の表示: 実行の前に、環境変数の「有無」だけから見込みを出す。値は読まない。順番は Claude Code の認証の優先順位(クラウド、`ANTHROPIC_AUTH_TOKEN`、`ANTHROPIC_API_KEY`、`CLAUDE_CODE_OAUTH_TOKEN`、本人のログイン)に合わせた。実行の後は、Claude Code が `init` で報告する `apiKeySource` を出す。組織の管理設定の `apiKeyHelper` と、Console(API)のアカウントでのログインは、見込みに入っていない(送る前には見分けられない)。
- 版の確認: 起動のときに `claude --version` を 1 回だけ実行し、2.1.248 未満なら作る欄を使えなくする。モデルは呼ばない。ログインの状態(`claude auth status`)は確かめない。ログインしていないときは、実行の結果の文から見分けて、ログインの手順を出す。
- 変わったファイルは、AI の報告ではなく、Studio が実行の前と後の `app/` の中身(SHA-256)を比べて確かめる。変わっていればビルドする。中断や失敗のときも、途中まで変わったファイルがあればビルドする。
- 止め方: 中断と時間切れ(10 分)では、SIGINT、3 秒待って SIGTERM、さらに 3 秒待ってプロセスグループごと SIGKILL。本体が終わった時点で、プロセスグループに残ったものは SIGKILL で止める。Studio を止めるとき(SIGINT、SIGTERM、SIGHUP)も、動いている作る AI を同じ手順で止める。例外などで止める手順を待てないときは、終わる直前に同期で SIGKILL を送る。
- 1 プロジェクト 1 実行: 作る AI が動いている間は、同じプロジェクトの依頼と「作り直す」を断る(409)。
- 作る会話は Studio のサーバーのメモリーに置く(プロジェクトごとに直近 20 件)。画面を再読み込みしても残り、Studio を止めると消える。ディスクには書かない。ターミナルのログにも依頼の文を出さない。
- Windows: npm 版の `claude.cmd` は使えなくした。cmd.exe を通ると、`--append-system-prompt` の文が命令として読まれる恐れがあるため。ネイティブ版の `claude.exe` を使う。
- 自動で直す(コンパイルのエラーを AI に 1 回だけ返す)は、#274 では入れていない。ビルドに失敗したら、場所を詳細の欄に出し、利用者が直す依頼を送る。

実機で確かめていないこと(`npm run check:claude -- --run` で確かめられるようにした。会社の利用条件が決まってから実行する):

- 非対話(`-p`)で、本人のログインのまま `--restricted` と `--safe-mode` が一緒に動くか。
- `app/` の外への書き込みと読み出しが止まるか。断られたことが `permission_denials` に出るか。
- `app/CLAUDE.md` と `app/.claude/settings.json` の hooks が効かないか。
- 中断の手順で、プロセスグループごと止まるか。
- Claude Code の実際の stream-json の形が、偽接続の形と合うか(特に、断られたときのツールの結果の文)。

## #275 で決めたこと(2026-10-28、仮)

「試す」の経路のうち、プロダクト内 AI の部分をモックで作った。実モデルは #276 で同じ口につなぐ。

```
試作品  window.studio.ai.session() / send(text) / correct({ key: 値 })
  │ MessagePort(親画面が渡したもの)
Studio 画面  形の検査、5 秒に 10 回・同時 3 件まで。どのプロジェクトかは親画面が決める
  │ /api/projects/<id>/ai[/messages|/corrections|/reset](トークン、POST は Origin も)
AiSessions(決まった処理)  値の検査、状態の更新、会話の記録、リセット
  │ respond({ definition, state, messages, text }) -> { reply, updates }
接続  モック(既定。#276 で実モデルを足す)
```

- AI の設定は `app/ai.json` に置く。成果物の一部なので、作る AI が書ける場所にした。ビルドのたびに検査し、誤りはビルドの失敗として出す。使うのは表示中の版の設定だけ。
- 設定の形は題材に依存させない。決めるのは「覚える項目(`choice` か `number`)」「最初の値」「モックの応答の型」だけ。題材の言葉は `ai.json` と `app/` にだけ書く。Studio のコードは求人の言葉を持たない。求人ではない題材(架空の旅の相談)でも E2E で確かめた。
- 接続が返した `updates` は、AiSessions が項目の決まりで検査してから状態に入れる。実モデルが決まりに合わない値を返しても、状態は壊れない。Minions の「AI の判断」と「決まった手順」の分け方に合わせた。
- 本人の修正は、会話に `correction` の記録として残す。修正だけでは AI を呼ばない。実モデルの費用を使わないため。次の発言のときに、履歴として接続に渡す。
- 会話と状態は、Studio のメモリーにだけ置く。Studio を止めると消える。`ai.json` が変わった版に切り替わったら、その初期状態から始める。保存と復元は #278 で決める。
- リセットは、応答を待っている途中でも会話を取り替える。後から届いた応答は捨てる。
- モックは、時刻にも乱数にも依存しない。同じ設定、同じ順の入力なら、いつも同じ応答になる。
- 上限: 発言は 500 文字、会話は 200 件まで。超えたら理由と次の手順(リセット)を返す。

## #276 で決めたこと(2026-10-28、仮)

#275 の口(`respond({ definition, state, messages, text }) -> { reply, updates }`)に、Claude Code の接続をつないだ。実モデルは呼んでいない。偽の CLI で確かめた。

```
Studio 画面  接続を選ぶ(試作品ごと)、送るものと費用の確認、応答を止める
  │ /api/projects/<id>/ai/connections(GET)、/connection、/cancel(POST)… Studio 画面だけが送る
AiSessions  選んだ接続に渡す。失敗と中断でも会話を変えない。応答した接続を発言に残す(via)
  │ respond({ …, signal })
Claude Code の接続  未改変の claude -p を、発言ごとに 1 回起動する
```

- 起動の形: `claude -p --restricted --safe-mode --tools "" --strict-mcp-config --permission-mode dontAsk --no-session-persistence --output-format json --json-schema=<fields から作る> --system-prompt=<instructions と Studio の決まり>`。`--max-budget-usd 0.1` はいつも付ける。`ANTHROPIC_API_KEY` がなくても、Console のアカウントでログインしていれば従量課金になり、Studio はログインの種類を読めない(資格情報を読まない)ため。Bedrock、Vertex、Foundry、`ANTHROPIC_BASE_URL`、`ANTHROPIC_AUTH_TOKEN` の環境変数があるときは送り先も変わるので、画面の送り先をその環境変数の名前にする(値は読まない)。
  - 発言と会話は stdin で渡す。`--json-schema` と `--system-prompt` は `=` でつなぎ、`-` で始まる指示がフラグとして読まれないようにした。
  - cwd は空の一時フォルダー(`os.tmpdir()` の下)。ツールを渡さないので、ファイルは読ませない。
  - `--system-prompt` で Claude Code の既定のシステムプロンプトを置き換える。作業ディレクトリや OS の情報を送らず、コーディング用の指示も混ぜないため。サブスクのログインで置き換えが効くかは要実機。
- 履歴: Studio が会話を持ち、毎回すべてを stdin で渡す。`--resume` は使わない。理由は 3 つある。
  - モックとの会話と本人の修正を、そのまま引き継げる。
  - `~/.claude/projects/` に試作の中身を残さない(T7)。
  - リセットと版の保存(#278)をツール側の決まった処理にできる。
  - 代わりに、会話が長くなるほど 1 回に送る量と費用が増える。上限は会話 200 件、発言 500 文字(#275)のまま。
- 構造化出力: `--json-schema` の `structured_output` を優先する。なければ本文を JSON として読む。それもなければ本文を返事にして、状態は変えない。値は AiSessions が項目の決まりで検査してから状態に入れる(#275 と同じ)。
- 実モデルを使えるようにする印: 環境変数 `STUDIO_ALLOW_CLAUDE_CODE=1`。ない限り、Claude Code は選べない。会社として Commercial Terms に同意するかが決まるまで実モデルを呼ばない、という条件(#276 の Ready conditions)を、既定で守るため。
- 実行の前に出すもの: 送り先、送るもの(指示の全文を含む)、送らないもの、費用(`ANTHROPIC_API_KEY` があれば API 課金。なければログインしているアカウントで、サブスクの枠か Console の従量課金かは分からないと書く)。切り替えには、確認のチェックが要る。Claude Code を選んでいる間は、送り先と費用をいつも出す。モックへ戻すのに確認は要らない。
- 中断: Studio 画面の「応答を止める」、リセット、Studio の停止で、CLI を止める。macOS と Linux はプロセスグループに SIGINT、1.5 秒後に SIGTERM、さらに 1.5 秒後に SIGKILL。Windows は `taskkill /T /F`。Studio の停止では、CLI が終わるまで(最長 4 秒)待ってから終了する。1 回の応答は 90 秒まで。
- 回数: 費用のかかる接続の応答は、1 つの会話で 30 回まで。試作品のコードは利用者の操作なしに `studio.ai.send()` を呼べるので、その上限にした(T6)。
- 失敗の分け方: 利用の上限(`limit`)、費用の上限(`budget`)、ログイン(`auth`)、見つからない(`not-found`)、時間切れ(`timeout`)、中断(`cancelled`)、その他(`connection`)。上限とログインは、CLI の出力の文で見分ける。本物の文は要実機。
- 接続の切り替えを、試作品(iframe)からはできないようにした。費用のかかる接続を、生成コードが勝手に選ばないため(T6)。切り替えは `studio.ai.onChange` で試作品に知らせる。
- Windows で npm 版の `claude.cmd` は起動しない(cmd.exe を通すと argv が解釈されるため)。ネイティブ版の `claude.exe` を前提にする。要実機。
- 作る AI(#274)とは別の接続で、別に切り替える。作る AI は `STUDIO_AGENT=claude`、プロダクト内 AI は `STUDIO_ALLOW_CLAUDE_CODE=1` と画面での確認で、Claude Code を使う。Claude Code の場所(`STUDIO_CLAUDE_BIN`)は両方で共用する。

## #278 で決めたこと(2026-10-28、仮)

利用者が朝まで答えないので、推奨の既定で仮に決めた。変えるなら別のカードで直す。

- 版の保存は、git ではなくファイルの写しにした。`.studio/versions/<版の ID>/` に、`app/` の写しと `version.json` を置く。
  - 理由: git の導入が要らない(非エンジニア、Windows)。git hooks や設定ファイル(T2)を気にしなくてよい。`app/` は 500 個、5 MB までなので、写しでも小さい。
  - `version.json` には、ファイルの指紋(SHA-256)、番号(v1、v2…)、名前、保存の時刻、ビルドできたか、プロダクト内 AI の会話と状態を入れる。
  - `.studio/` は作る AI の作業ディレクトリ(`app/`)の外なので、作る AI は版を読み書きしない。
- 版に、プロダクト内 AI の会話と状態を入れる。復元すると、ファイルと一緒に戻す。
  - 理由: PRD の「同じ初期条件からやり直す」(10)と「良い版を保存し、後から開き、変更前に戻る」(11)を、1 つの操作で満たすため。戻した会話から続けると、モックは保存したときと同じ応答を返す(E2E で確かめた)。
  - 入れるのは、保存するファイルの `ai.json` に合う会話だけ。会話が最初のままなら入れない(復元すると、その設定の初期状態から始まる)。
  - 復元では、表示中の設定の決まりで会話と状態を確かめ直す。合わなければ(手で直された `version.json` など)、初期状態から始める。
- 作る欄の会話(依頼の履歴)は版に入れない。メモリーにだけ置くまま(#274 の決定)。作業中のプロダクト内 AI の会話も、メモリーにだけ置くまま(#275 の決定)。Studio を止めると消え、保存した版から戻せる。
- 「作業中」と「保存版」を分ける。作業中は今の `app/` と、メモリーにある会話と状態。保存版は後から変わらない写し。
  - 作業中がどの保存版と同じかは、ツールが `app/` の指紋と会話を比べて決める。AI の報告や、操作の記録には頼らない。`app/` を Studio の外で直しても正しく出る。
  - 「試す」は、いつも作業中を表示する。保存版を作業中に戻さずに見る形(読むだけの表示)は入れていない。下の復元の自動保存で、戻しても失わないため。
- 保存と復元は、AI の判断を入れない決まった手順にした(Minions の分け方)。
  - 保存: 写しを作り、写しをビルドして確かめる。ビルドできない状態は保存しない(「良い版」だけを残す)。表示中の版と会話には触れない。
  - 復元: 作業中がどの保存版とも同じでなければ、先に「復元の前の作業中(自動)」として保存する。この自動の保存は、ビルドできない状態も残す。次に、写しを先に作ってから `app/` と名前を入れ替え、ビルドし、会話と状態を戻す。ビルドに失敗したら、試す画面と会話は前のまま。ただし、ビルドできない状態の自動の版に戻すときは、会話だけ戻す(その会話は表示中の設定で取ったもの)。
  - 版にできないほど大きい作業中は、自動の版にせず `.studio/set-aside/` へ移してから戻す。上限で復元を止めると、壊れた作業中から抜け出せないため。
  - 復元が途中で止まったときは、次の起動で直す。`app/` がなければ、取り替える前の `app/` を戻す。取り替えが済んでいれば、前の `app/` を `.studio/set-aside/` に置く。
  - 保存と復元の間は、同じプロジェクトの作る AI の依頼、「作り直す」、プロダクト内 AI への発言・修正・リセットを断る(409。本文を読む前と後の両方で確かめる)。プロダクト内 AI が応答を待っている間は、復元を断る。自動の版や戻した会話から、発言が抜け落ちないようにするため。1 プロジェクト 1 実行の決まりにも合わせた。
- 上限: 利用者が保存する版は 1 プロジェクト 100 個まで。自動の版は新しいものから 30 個だけ残す。ただし、復元の前の自動の保存で整理するとき、復元する版そのものは消さない(上限を 1 個超えることがある。次の自動の保存で整理する)。写しは `app/` の検査と同じ上限(500 個、1 ファイル 1 MB、合計 5 MB)。版を消す画面はまだない。版の番号は `.studio/working.json` に覚え、版のフォルダーを消しても使い回さない。
- 保存の前に、作業中そのものを `app/` の検査にかける。写しはシンボリックリンクなどを省くので、写しだけを確かめると、検査に通らない作業中を保存できてしまうため。
- 範囲: 版の形は題材に依存しない。求人ではない題材(架空の旅の相談)でも結合テストで確かめた。
- #276 の接続とのつなぎ(main への取り込みで足した): 版には、応答した接続(`via`)、待った時間、費用の目安も会話と一緒に入れて戻す。戻した直後も「作業中 = 保存版」と出し、有料の応答の回数(30 回まで)も戻した会話で数えるため。選んだ接続は版に入れない(リセットと同じく、復元しても変えない)。保存と復元の間も、接続の一覧と「応答を止める」は断らない。

## 未決事項

| 未決事項 | 決める人・場所 |
|---|---|
| この ADR の仮採用を正式にするか | 利用者(2026-10-28 の朝) |
| `--restricted` と `--safe-mode` が本人ログインで一緒に動くか、閉じ込めが実際に効くか | 利用者が `npm run check:claude -- --run` で確かめる(会社の利用条件が決まってから) |
| WebRTC と DNS の先読みの残る危険を受け入れるか | 利用者(実データを使う前に) |
| 作る AI の権限の確認を画面で受けるか(SDK の `canUseTool` など)、`dontAsk` で拒否だけにするか | #274 で `dontAsk` で拒否だけに仮決め。利用者が確かめる |
| プロダクト内 AI の Claude Code の起動の形(#276 で仮に決めた)が、実機で動くか。`--restricted` と `--safe-mode` と `--tools ""` と `--json-schema` を一緒に使えるか、`--system-prompt` がサブスクのログインで効くか、応答の速さ、上限に当たったときの出力 | 実機の確認(許可と予算が要る) |
| 会社として Claude の Commercial Terms に同意するか(それまで `STUDIO_ALLOW_CLAUDE_CODE` を付けず、`STUDIO_AGENT=claude` にしない) | 社内 |
| プロダクト内 AI の会話と状態を保存するか、版と一緒に戻すか | #278 で、版に入れて一緒に戻すことに仮決め。利用者が確かめる |
| `ai.json` の形(項目の種類を `choice` と `number` から増やすか) | 別の題材で使ってから(#281) |
| 版の保存の方式(git を `app/` の外に置くか、ファイルの写しか) | #278 でファイルの写しに仮決め。利用者が確かめる |
| 版を消す画面、版どうしの差分、保存版を読むだけで開く表示、共有のための書き出し | 後のカード(書き出しは引き継ぎの #280 を想定) |
| 同梱するライブラリの範囲(#273 では React だけ。UI 部品まで入れるか) | #274 では React だけのまま。後のカード |
| コンパイルのエラーを作る AI に 1 回だけ返して直させるか | 後のカード |
| AI が試作品の画面を見て操作する閉ループ(ヘッドレスのブラウザ) | 後のカード |
| 配布の形(段階 2) | 利用者 |
| 外から試作品を取り込むときの検査 | 共有を扱うカード |
