# ADR-0002: 観察器と harness

- 状態: **仮採用**(2026-10-28)。harness の設計([docs/design/harness.md](../design/harness.md))の案のうち、観察器と作るループの決まりを記録する
- 出典のタスク: jyoka/tasks#300(設計: jyoka/tasks#293、観察器の土台: jyoka/tasks#299)
- 確認日: 2026-10-28。Chromium の挙動は、手元の Mac の Playwright の Chromium(`chromium-headless-shell`、playwright-core 1.63.0)で確かめた。実モデルは呼んでいない
- [ADR-0001](0001-local-runtime-and-isolation.md) の 3 つの層(作る AI の閉じ込め、sandbox の iframe と CSP、Studio サーバーの守り)は変えない。観察器はその内側で動く

## 決定(仮採用)

| 決めたこと | 中身 | 決めた日、決めた人 |
|---|---|---|
| 観察器のブラウザ | Playwright の Chromium だけを使う。利用者の Chrome と Edge は使わない | 2026-10-28、利用者 |
| 観察器の隔離 | 観察の文脈は、観察用の親ページと、観察するビルドのファイルにだけ要求を出せる。名前の解決は loopback だけにする。WebRTC の UDP を止める | jyoka/tasks#300 |
| 直すラウンド | 関門の失敗を作る AI に返して直させるのは 2 回まで。作る AI の起動は 1 つの依頼で 3 回まで | 2026-10-28、利用者 |
| 作る AI と観察 | 作る AI も、観察の道具(決まった名前の MCP の道具)で画面を観察し、操作できる。通ったかを決めるのは、いつも関門(コード) | 2026-10-28、利用者 |

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
| 暴走(T8) | 観察の全体に時間の上限を置き(`limits.observeTimeoutMs`。既定は `loadTimeoutMs` + `settleMs` + 30 秒)、超えたら文脈ごと閉じる。文脈を開けない、閉じられないブラウザは手放し、次の観察で新しいブラウザを起動する。手放したブラウザは、Playwright が close の 30 秒後にプロセスグループごと強制終了する |

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
- 渡し方と道具の中身は、jyoka/tasks#312 でこの ADR に書き足す

## ADR-0001 の未決事項への答え

| ADR-0001 の未決事項 | この ADR で決めたこと |
|---|---|
| コンパイルのエラーを作る AI に 1 回だけ返して直させるか | 返す。コンパイルのエラーに限らず、関門の失敗を返す。直すラウンドは 2 回まで |
| AI が試作品の画面を見て操作する閉ループ(ヘッドレスのブラウザ) | 入れる。観察器(Playwright の Chromium)を作るループの関門と作る AI の道具の両方が使う。観察器の隔離はこの ADR の表のとおり |

## 未決事項

| 未決事項 | 決める人・場所 |
|---|---|
| この ADR の仮採用を正式にするか | 利用者 |
| 作る AI に観察の道具を渡す形(`--mcp-config` が `--restricted`、`--safe-mode`、`--strict-mcp-config` と一緒に動くか) | jyoka/tasks#312 の実機の確認 |
| WebRTC の TURN(TCP)が loopback の他のポートに届くことを、観察器でも塞ぐか | 利用者 |
