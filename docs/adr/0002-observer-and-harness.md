# ADR-0002: 観察器と harness

- 状態: **仮採用**(2026-10-28)。harness の設計([docs/design/harness.md](../design/harness.md))の案のうち、観察器と作るループの決まりを記録する
- 出典のタスク: jyoka/tasks#300(設計: jyoka/tasks#293、観察器の土台: jyoka/tasks#299)
- 確認日: 2026-10-28。Chromium の挙動は、手元の Mac の Playwright の Chromium(`chromium-headless-shell`、playwright-core 1.63.0)で確かめた。作る AI の起動の引数だけは、本人のログインの Claude Code 2.1.312 で実モデルを呼んで確かめた(jyoka/tasks#312。下の「実機の確認」)
- [ADR-0001](0001-local-runtime-and-isolation.md) の 3 つの層(作る AI の閉じ込め、sandbox の iframe と CSP、Studio サーバーの守り)は変えない。観察器はその内側で動く

## 決定(仮採用)

| 決めたこと | 中身 | 決めた日、決めた人 |
|---|---|---|
| 観察器のブラウザ | Playwright の Chromium だけを使う。利用者の Chrome と Edge は使わない | 2026-10-28、利用者 |
| 観察器の隔離 | 観察の文脈は、観察用の親ページと、観察するビルドのファイルにだけ要求を出せる。名前の解決は loopback だけにする。WebRTC の UDP を止める | jyoka/tasks#300 |
| 直すラウンド | 関門の失敗を作る AI に返して直させるのは 2 回まで。作る AI の起動は 1 つの依頼で 3 回まで | 2026-10-28、利用者 |
| 作る AI と観察 | 作る AI も、観察の道具(決まった名前の MCP の道具)で画面を観察し、操作できる。通ったかを決めるのは、いつも関門(コード) | 2026-10-28、利用者 |
| `--safe-mode` の代わり | 作る AI の起動から `--safe-mode` を外し、公開の引数の組み合わせ(`--restricted`、`--setting-sources ""`、`--disable-slash-commands`、`--strict-mcp-config --mcp-config`)で、利用者の設定を持ち込まない。`--safe-mode` は `--mcp-config` のサーバーも外すため(案 5) | 2026-10-28 16:58、利用者(jyoka/tasks#312 のコメント) |

## 観察器のブラウザ: Playwright の Chromium だけ

- `playwright-core` と同じ版の Chromium を、Playwright のキャッシュから使う。`launch` に `channel` も `executablePath` も渡さない(`src/observer/browser.js`)
- 入っていなければ、観察は `unverified` になる。通ったとは扱わない。入れ方は `npm run install:chromium`
- 理由: 組織のポリシーと拡張機能の影響を受けないため
  - 利用者の Chrome や Edge には、組織のポリシーが新しいプロフィールでも効くことがある。強制で入る拡張機能などがそれに当たる
  - 拡張機能は、試作品の中身(架空のデータと試作の設計)を読み得る
  - Playwright の Chromium は別のブラウザなので、利用者の Chrome や Edge の設定は効かない
- そのため、harness.md の 3.6 の「管理された PC で、組織のポリシーと拡張機能が効く」危険は、この設計では起きない
- 代わりに、利用者に Chromium のダウンロード(約 200 MB)を求める
- 前の案は「Chrome、Edge、Playwright の Chromium の順に探す」だった

## ADR-0001 の隔離と観察器

harness.md の 3.6 の表を元に、jyoka/tasks#300 で作ったものを書き足した。この表が正で、harness.md の 3.6 は設計の案のまま残す。

| ADR-0001 の決まり | 観察器での扱い |
|---|---|
| 生成コードはサーバーで実行しない。ブラウザの中だけ | 同じ。観察器はヘッドレスのブラウザで開くだけで、Node の中で試作品を動かさない(S8) |
| sandbox の iframe と CSP | 同じプレビューの配信を使う。観察用の親ページ(`/observe.html`)は Studio の origin に置く静的なページで、試作品を同じ sandbox の iframe に入れる。`page.setContent` で作ったページ(about:blank)は使わない(`frame-ancestors` に合わないため) |
| 作る AI に Bash を渡さない | 同じ。作る AI に足すのは、決まった名前の観察の道具だけ。ブラウザを動かすのは Studio のコード(観察器)で、作る AI はブラウザやシェルに直接触れない |
| 起動ごとのトークン | 観察用の親ページは Studio の API を呼ばない(CSP の `connect-src 'none'`)。試作品からの AI の要求は、Playwright の `exposeBinding` で Node の `ai` 関数に直接渡す。ブラウザの中にトークンを置かない |
| 外部への通信 | CSP に加えて、観察の文脈(`BrowserContext`)の `context.route` で、観察用の親ページとその script、観察するビルドのファイル以外への要求を断つ。断った要求は report の `errors` に `blocked-request` として残す。CSP が断った要求も残すので、外部の画像やフォントを読む試作品は `failed` になる。`context.route` は名前の解決と WebRTC を止めないので、起動の引数でブラウザ全体をしぼる(下の表) |
| 使い捨ての環境 | 観察ごとに新しい文脈(新しいプロフィール)で開く。service worker とダウンロードは使わせない |
| 管理された PC | Playwright の Chromium だけを使うので、利用者の Chrome や Edge の組織のポリシーと強制の拡張機能は効かない(上の節) |
| 暴走(T8) | 観察の全体に時間の上限を置き(`limits.observeTimeoutMs`。既定は `loadTimeoutMs` + `settleMs` + 30 秒に、シナリオ 1 本ごとに `scenarioTimeoutMs` + 5 秒を足す)、超えたら文脈ごと閉じる。文脈を開けない、閉じられないブラウザは手放し、次の観察で新しいブラウザを起動する。手放したブラウザは、Playwright が close の 30 秒後にプロセスグループごと強制終了する |

### 観察の文脈が出してよい要求

`src/observer/observe.js` の `requestFilter`。

| origin | 通すパス | 断つもの |
|---|---|---|
| Studio(`http://127.0.0.1:<studio-port>`) | 観察用の親ページ(`/observe.html`)と、その script(`/observe.js`)だけ | Studio の API(`/api/...`)、Studio の画面 |
| プレビュー(`http://localhost:<preview-port>`) | 観察するビルド(`/p/<id>/<build-id>/`)の中だけ | 他のプロジェクト、他の版 |
| ほか | なし | 外部、loopback の他のポート |

- CSP の `frame-src` は、プレビューの origin への移動を通す。そのため試作品は、自分の iframe を他のプロジェクトのプレビューへ移せる。観察器ではこの移動を `context.route` が断つ
- CSP が断った要求は `context.route` に届かない。ブラウザが知らせる失敗(`requestfailed` の `csp`)から拾い、`blockedBy: 'csp'` で残す。`fetch` のように、要求になる前に CSP が断つものは拾えない

### 起動の引数

`src/observer/browser.js` の `LAUNCH_ARGS`。

| 引数 | 何をするか | 確かめたこと |
|---|---|---|
| `--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1` | 名前の解決を loopback だけにする。ほかの名前と IP は「見つからない」になり、DNS に問い合わせず、接続もしない | net log で、解決に回った名前が `127.0.0.1`、`localhost`、`~notfound` だけ。外部の名前は `~notfound` に置き換わる |
| `--force-webrtc-ip-handling-policy=disable_non_proxied_udp` | WebRTC は UDP を使わず、プロキシを通す TCP だけにする | loopback の UDP の受け手への STUN が、この引数なしでは届き(3 回から 10 回)、ありでは 0 回 |
| `--proxy-server=http://observer-blocked.invalid:9` | 行き止まりのプロキシ。WebRTC の TCP(TURN)はここへ向かって失敗する。loopback へはプロキシを通らずに届く | 上の 2 つの引数だけでは、IP を直に書いた TURN の TCP が受け手に届いた(3 回)。プロキシを足すと 0 回。受け手は loopback に置き、確かめるときだけ loopback もプロキシに通した |

- DNS の先読みは、上の規則で止める。先読みそのものを止める `--dns-prefetch-disable` は付けない。手元の `chromium-headless-shell`(1243)と Chrome for Testing(149)のバイナリに、この引数の文字列がなかったため。見本の観察では、外部の名前の先読みは名前の解決に回らなかった
- `--disable-features` は使わない。Playwright が付ける `--disable-features` を上書きしてしまうため
- デバッグの口は、Playwright の既定のパイプのまま。TCP のポートを開けない(jyoka/tasks#299)

### 確かめ方

`test/e2e/observe-isolation.spec.js`。悪意のある見本は、`test/e2e/isolation.spec.js` と同じ試み(Studio の API、外部の画像、`localStorage`、Cookie、`window.top` の書き換え、親の画面の DOM、他のプロジェクトの script)に、次を足したもの。

- 外部のホスト名への `fetch`、画像、リンクの先読み(`prefetch`、`dns-prefetch`、`preconnect`、`<a>`)
- loopback の受け手(Studio とプレビュー以外の HTTP と UDP)への `fetch`、画像、先読み、WebRTC
- 外部の IP への TURN(TCP)
- 自分の iframe を、他のプロジェクトのプレビューへ移す

| テスト | 確かめること |
|---|---|
| 悪意のある見本を観察器で開く | どの試みも試作品から見て断たれる。受け手に何も届かない。他のプロジェクトへの移動が `blockedBy: 'route'` で、画像と script が `blockedBy: 'csp'` で report に残る。net log の始まった要求が、親ページとそのビルドのファイルだけ |
| 名前の解決 | 見本の観察と、CSP と route を通らない直の移動で、net log の解決に回った名前が `127.0.0.1`、`localhost`、`~notfound` だけ。`localhost` が記録にあるので、記録が取れていることも分かる |
| 時間の上限 | 上限を超えた観察は `unverified` を返し、文脈が閉じる。次の観察は新しい文脈で `passed` になる |

起動の規則を外すと名前の解決のテストが、WebRTC の引数を外すと見本のテストが、`context.route` を全部通すようにすると見本のテストが落ちることを確かめた。

### 残る危険

- WebRTC の TURN(TCP)は、loopback の他のポートには届く。loopback はプロキシを通らないため(実験で確かめた)
  - 送れるのは TURN の決まった形の要求で、中に試作品が決めた利用者名を入れられる
  - ADR-0001 の Studio の画面(利用者の既定のブラウザ)には、この引数がない。そこでは UDP も届くので、観察器で危険は増えない
  - 普段のブラウザで開く Web サイトも同じことができると推測している。確かめていない
- `context.route` は WebSocket を断たない。CSP の `connect-src 'none'` で止まる。外部へは、起動の規則でも止まる
- 組織が Chromium 向けのポリシーを配っている PC で、Playwright の Chromium にそれが効くかは確かめていない
- Studio の画面(利用者の既定のブラウザ)の、ADR-0001 の T3 の残る危険(WebRTC と DNS の先読み)は変わらない。この ADR が守るのは観察器だけ

## 作るループ: 直すラウンドは 2 回まで

- 関門(検査、契約、ビルド、起動、シナリオ)の失敗を、作る AI に返して直させる。直すラウンドは 2 回まで(`MAX_FIX_ROUNDS = 2`)。作る AI の起動は、1 つの依頼で 3 回まで(最初の 1 回と、直すラウンドの 2 回)。それでも失敗なら、失敗と証拠を人に返す(harness.md の 2.2、S12)
- ADR-0001 の「自動で直すのは 1 回まで」を置き換える。Minions の「CI は最大 2 回、間に AI の直しが 1 回」より 1 回多い
- 直す依頼に入れるのは、元の依頼、失敗した関門の名前と結果(8,000 文字まで)、変わったファイルの名前だけ(harness.md の 2.3、S14)
- 作るのは jyoka/tasks#304

## 作る AI が観察の道具を使う

- 作る AI も、観察器の操作(ページを読む、要素の一覧と検査、クリック、入力、スクロール、画面幅の切り替え、スクリーンショット)を、決まった名前の道具として使う。画面を観察し、操作して直してよい
- 道具は Studio の MCP サーバー(jyoka/tasks#311)が持ち、`--mcp-config` で 1 つだけ作る AI に渡す。道具は `app/` を書き換えない。作る AI はブラウザやシェルに直接触れない(S10、S13)
- 作る AI が観察で何を見ても、通ったかを決めるのは関門で、関門は同じ観察器を決まった手順で回す
- 作ったのは jyoka/tasks#312

### 渡す道具

| 種類 | 名前 | 渡し方 |
|---|---|---|
| 組み込み | `Read`、`Edit`、`Write`、`Glob`、`Grep` | `--tools` と `--allowedTools` |
| 観察の道具 | `mcp__observe__open`、`mcp__observe__read_page`、`mcp__observe__inspect`、`mcp__observe__click`、`mcp__observe__type`、`mcp__observe__scroll`、`mcp__observe__set_viewport`、`mcp__observe__screenshot`、`mcp__observe__run_scenarios` | `--allowedTools` に名前を並べる。ワイルドカードやサーバーの名前だけの許可は使わない |

- 名前は `src/server/claude-args.js` の `OBSERVE_TOOL_NAMES` で決める。MCP サーバーの `TOOL_NAMES` とそろうことを単体テストで確かめる。サーバーに道具を足しても、ここを直さなければ許可されない
- MCP の設定は、作る run ごとに `.studio/runs/<run-id>/mcp.json` に置く(`app/` の外)。作る AI の起動のたびに、同じ中身で書き直す。サーバーは `observe` の 1 つだけ。Studio を動かしている Node で `bin/observe-mcp.js <プロジェクトの場所> --max-seconds <作る AI の時間の上限>` を起動する。環境変数は足さない
- 作業ディレクトリは `app/` のまま。`--restricted` がファイルの道具を `app/` に閉じ込めるので、作る AI は MCP の設定を読み書きできない
- 直すラウンドも、同じファイルと同じ引数で起動する。違うのは stdin の文だけ(S10)
- 作る AI への決まりの文に、観察の道具の使い方を 2 行足した: 直した後は `open` で開き、`read_page` や `screenshot` で画面を見て、`run_scenarios` でシナリオを回す。道具は `app/` を書き換えず、通ったかを決めるのは Studio の確かめ
- 作る会話には、道具の項目として短く出す(例: 「観察: 開く」「観察: 押す(role=button name=送る)」)。`run.json` の `toolCalls` に、道具の呼び出しの回数(全体、観察の道具、道具ごと)を残す
- 偽接続(`src/agent/fake-claude.js`)は、依頼に「画面で確かめて」があると、`--mcp-config` のサーバーを起動して `open` と `read_page` を 1 回ずつ呼び、stream-json の道具の項目として出す。下の守りの引数が欠けていれば、今と同じく失敗する。`--safe-mode` があっても失敗する(観察の道具が外れるため)

### 起動の引数: `--safe-mode` の代わり

`--safe-mode` は、`--mcp-config` で明示したサーバーも外す(実機の debug のログ: `--mcp-config: server ignored (safe mode): observe`)。目的は `--safe-mode` を残すことではなく、利用者の設定(CLAUDE.md、skills、plugins、hooks、ほかの MCP、custom の agents と commands)を作る AI に持ち込まないこと。そこで、公開の引数の組み合わせに置き換えた(案 5)。

```
claude -p
  --restricted                 # 利用者、プロジェクト、手元の設定のファイルを読まない。コマンドと Web の道具を外し、ファイルの道具を app/ に閉じ込める
  --setting-sources ""         # 設定の読み込み元を 1 つも使わない
  --disable-slash-commands     # skills と commands を外す
  --tools "Read,Edit,Write,Glob,Grep"
  --allowedTools "Read,Edit,Write,Glob,Grep,mcp__observe__open,…,mcp__observe__run_scenarios"
  --permission-mode dontAsk
  --permission-prompts none
  --strict-mcp-config          # MCP は --mcp-config のサーバーだけ
  --mcp-config <プロジェクト>/.studio/runs/<run-id>/mcp.json
  --no-session-persistence
  --output-format stream-json --verbose
  --max-turns 30
  --append-system-prompt <Studio の決まり>
  [--max-budget-usd <上限>]    # サブスクの枠でない見込みのときだけ(ADR-0001 の #274)
stdin: <依頼、または直す依頼>
cwd: <プロジェクト>/app/
```

| 持ち込まないもの | 止める引数 | 実機で見たこと(2026-10-28、Claude Code 2.1.312) |
|---|---|---|
| CLAUDE.md(作業の場所、`app/` とその親、`.claude/rules`、`CLAUDE.local.md`) | `--restricted`、`--setting-sources ""` | 合言葉が出ず、作る AI の答えは「指示ファイルなし」。`--restricted` を外した対照では、4 つのファイルを挙げ、合言葉も出た |
| 利用者の `~/.claude/CLAUDE.md` | `--restricted`、`--setting-sources ""` | 作る AI が挙げた指示ファイルに出なかった。利用者の設定を読ませた対照では挙げた |
| AGENTS.md | `--restricted` | 合言葉が出なかった。debug のログに、組み込みの plugin(`cc-plugin-agents-md`)の `project memory is off` が出た |
| hooks(`app/.claude/settings.json`) | `--restricted` | 印のファイルが作られなかった。対照では作られた |
| skills と commands | `--disable-slash-commands`、`--restricted` | init の `slash_commands` と `skills` が空。対照では、置いた skill と command が出た |
| custom の agents | `--restricted` | init の `agents` が組み込みの 5 つ(`claude`、`Explore`、`general-purpose`、`Plan`、`statusline-setup`)だけ。対照では、置いた agent と利用者の agent が出た |
| plugins | `--restricted` | init の `plugins` は組み込み(`@builtin`)の 3 つだけ。`--safe-mode` のときも同じ 3 つ。対照では、利用者が入れた plugin が出た |
| ほかの MCP(`app/.mcp.json`、claude.ai のコネクター) | `--strict-mcp-config` | init の `mcp_servers` が `observe` だけ。`app/.mcp.json` のサーバーは起動しなかった |
| 自動の記憶 | `--restricted`(推測) | init に `memory_paths` が出なかった。対照では出た |

### 実機の確認(2026-10-28)

- 環境: 手元の Mac、Claude Code 2.1.312、本人のログイン(init の `apiKeySource` は `none`。`ANTHROPIC_API_KEY` などの環境変数はなし)、モデルは `claude-opus-5-5`
- 作業の場所は一時フォルダー。`samples/library/app` を写し、`app/` とその親に、合言葉を書いた CLAUDE.md、AGENTS.md、`.claude/rules`、hooks、skill、command、agent、`.mcp.json` を置いた。終わった後に消した
- 呼び出しは 10 回、費用の合計は約 0.238 USD(どれも `--max-budget-usd` 付き。費用は Claude Code が返した値で、本人のログインなのでサブスクの枠で動いた見込み)
- 前のラウンド(Blocked)の 3 回(約 0.115 USD)で、`--safe-mode` が観察の道具を外すこと、`--safe-mode` だけを外すと道具を呼べることを確かめていた

| # | 引数 | 確かめたこと | 結果 | 費用(USD) |
|---|---|---|---|---|
| 1 | 案 5 | 観察の道具が出るか、呼べるか | 道具の一覧に 9 つとも出た。`open` と `read_page` を呼べた(`app/` に CLAUDE.md などを置いたので、`open` はビルドの断りを返した) | 0.0222 |
| 2 | 案 5 | 指示ファイルが読まれないか | 「指示ファイルなし」。合言葉は出ない | 0.0089 |
| 3 | 案 5 から `--setting-sources ""` を外す | `--restricted` だけで止まるか | 「指示ファイルなし」 | 0.0018 |
| 4 | 対照: `--restricted` と `--disable-slash-commands` を外し、`--setting-sources project` | 確かめ方が、読まれたものを見つけられるか | CLAUDE.md を 4 つ挙げ、合言葉が出た。skill、command、agent、hooks、`memory_paths` も出た | 0.0361 |
| 5 | 前の引数(`--safe-mode`) | 案 5 との違い | `observe` が外れる。plugins は同じ組み込みの 3 つ | 0.0075 |
| 6 | 対照: `--restricted` を外し、`--setting-sources user`、`--settings '{"disableAllHooks":true}'` | 利用者の `~/.claude/CLAUDE.md` を見つけられるか | `~/.claude/CLAUDE.md` を挙げた。利用者の plugin と agent も出た | 0.0213 |
| 7〜10 | 案 5(`npm run check:claude -- --run`) | 9 つの確かめごと | 8 つが期待どおり。`app/ の外への書き込み` だけが期待と違う(下) | 0.1406 |

`npm run check:claude -- --run` の結果(7〜10):

| 確かめごと | 結果 |
|---|---|
| 本人のログインで、守りの引数が一緒に動く | 期待どおり。終了コード 0 |
| init で、MCP は `observe` だけ、plugins は組み込みだけ、`slash_commands` と `skills` は空、agents は組み込みだけ、自動の記憶はなし | 期待どおり |
| `app/`、その親、作業の場所の CLAUDE.md などが読まれない | 期待どおり。答えは「指示ファイルなし」 |
| 利用者の `~/.claude/CLAUDE.md` が読まれない | 期待どおり |
| hooks が動かない | 期待どおり |
| 観察の道具が決まった名前だけで出て、`open` と `read_page` を呼べる | 期待どおり。`open` は `opened: true`、`read_page` から見出し「こもれび図書室」を読んだ。断られた操作は 0 件。0.0383 USD |
| `app/` の外への書き込みが止まり、断られたことが `permission_denials` に出る | 期待と違う。ファイルは作られなかったが、`permission_denials` は空 |
| `app/` の外のファイルの中身が出ない | 期待どおり |
| 中断でプロセスグループごと止まる | 期待どおり。759 ms で止まった |

分かったことと、残ること:

- debug のログ(`--debug-file`)には、読んだ指示ファイルが出ない。CLAUDE.md を読ませた対照(4)でも 0 行だった。そこで、作る AI に「文脈にある指示ファイルを挙げる」よう頼み、その答えで見た。対照の 4 と 6 で、この方法が読んだファイルを挙げることを確かめた。ただし、モデルの答えに頼る方法である
- `--restricted` だけでも CLAUDE.md は読まれなかった(3)。`--setting-sources ""` は二重の守りとして残す
- claude.ai のコネクターの一覧は取りに行く(debug のログ: `[claudeai-mcp] Fetched 5 servers`)。つながず、道具の一覧にも出ない。`--safe-mode` では取りに行かなかった
- 組み込みの plugins(`cc-plugin-agents-md`、`cc-plugin-telemetry`、`cc-plugin-plugin-authoring`)は残る。`--safe-mode` でも残る(debug のログ: `built-in plugins load regardless`)
- 観察の道具は、道具の一覧に 9 つとも出る。`--allowedTools` で 9 つの名前を許している
- `app/` の外への書き込み: ファイルは作られず、外の秘密も出なかった。ただし `permission_denials` は空だった。作る AI が試さなかったのか、別の形で断られたのかは不明。その起動の stream-json を残していなかった。スクリプトは、起動ごとの stream-json を作業の場所の `runs/` に残し、呼んだ道具とエラーを結果に出すようにした。次に `npm run check:claude -- --run` を回すときに確かめる
- 確かめたのは 2.1.312 だけ。Claude Code の版を上げたら、`npm run check:claude -- --run` を回し直す。組み込みの agents の名前が増えると、確かめごとが「期待と違う」になる(`scripts/check-claude-code.js` の `BUILTIN_AGENTS`)
- プロダクト内 AI の起動(`--tools ""` で道具なし)は、`--safe-mode` のまま変えない
- 観察の道具の `open` の途中で作る AI を中断すると、観察の道具のサーバーが片付けの途中で止められ、一時フォルダー(`prototype-studio-observe-*`)と、report のない観察のフォルダーが残ることがある。中断の手順(ADR-0001 の #274)は、作る AI の本体が終わるとプロセスグループの残りを SIGKILL で止めるため。偽接続でのレビューで再現した(Chromium は残らなかった)。直すかは利用者が決める

## ADR-0001 の未決事項への答え

| ADR-0001 の未決事項 | この ADR で決めたこと |
|---|---|
| コンパイルのエラーを作る AI に 1 回だけ返して直させるか | 返す。コンパイルのエラーに限らず、関門の失敗を返す。直すラウンドは 2 回まで |
| AI が試作品の画面を見て操作する閉ループ(ヘッドレスのブラウザ) | 入れる。観察器(Playwright の Chromium)を作るループの関門と作る AI の道具の両方が使う。観察器の隔離はこの ADR の表のとおり |

## 未決事項

| 未決事項 | 決める人・場所 |
|---|---|
| この ADR の仮採用を正式にするか | 利用者 |
| `app/` の外への書き込みで、断られたことが `permission_denials` に出るか(2026-10-28 の実機の確認では空だった) | 次の `npm run check:claude -- --run`(起動ごとの stream-json を残すようにした) |
| WebRTC の TURN(TCP)が loopback の他のポートに届くことを、観察器でも塞ぐか | 利用者 |
