# デザインシステムの素材の作戦

試作品の見た目と使いやすさを、誰でも少しの「良い味」から始められるようにする作戦です。既定の素材の候補とライセンス、自分の素材をつなぐ形、取り込みの案内を書きます。

- 状態: 案(task 378)。書いた日: 2026-10-29。既定の素材(3 節)は、運営者が 2026-10-29 に決めた(task 381)。実装は [user-journey.md の 6 節](user-journey.md#6-実装のカードの分け方)の J3〜J5。J3 の結果は 3 節の「J3 で確かめたこと」(2026-10-31)。J4 の結果は 4 節の「J4 で決めたこと」(2026-11-02)。J5 の前半の結果は 5 節の「J5 で決めたこと」(2026-11-07)
- 前提: [vision.md](../vision.md) の原則 6「素材を流用できる」、[ADR 0001](../adr/0001-local-runtime-and-isolation.md)。隔離は弱めない
- 出典はどれも 2026-10-29 に読んだ。ライセンスは一次資料(リポジトリの LICENSE、公式の規約、npm の登録)で確かめた。確かめられなかったものは「未確認」と書いた
- ライセンスの読み方は、法律の助言ではない。同梱を決める前に、運営者が原文を読む

## 結論

- 素材とは、部品(コード)、トークン(色、字、間隔などの値)、アイコン、字、指針の文のこと
- Apple の素材(Apple Design Resources、SF Pro、SF Symbols)は使えない。Apple のプラットフォームの画面の下書きにしか使えず、ほかのソフトに埋め込めないため(2 節)
- 既定の素材は、Radix Themes + Radix Colors(MIT)、Lucide(ISC)、OS の字に決めた(3 節)
- Material 3 は「Google の見た目」として選べる素材にする。Material Web は既定にしない。同梱の前に、運営者がライセンスの原文を読む(J3 で止まって確かめる)
- 自分の素材は、つなぎやすい順に、トークン、指針の文、Storybook、npm のパッケージ、Figma にする(4 節)
- 自分のトークンは J4 でつなげるようになった。Studio が検査して `.studio/materials/` に置き、ビルドで CSS の変数にする。作る AI が書き換えると関門 G3 で止まる(4 節)
- 作る AI は `app/` の外を読めず、MCP は Studio の観察の道具だけ。だから素材は Studio が受け取り、検査し、作る AI に渡す。作る AI に外の Figma や Storybook を直接つながない(4 節)
- 取り込みの案内は、聞く、確かめる、見本で試す、有効にするの 4 歩(5 節)
- J5 の前半で、指針の文と Storybook の部品の一覧を、案内の 4 歩でつなげるようになった。元は `.studio/materials/`、写しは `app/design/`。写しが変わると関門 G3 で止まる。npm のパッケージは後半のカードに分けた(5 節)

## 1. 今の決まりと、素材への影響

| 今の決まり | 出典 | 素材への影響 |
|---|---|---|
| ビルドの import は、`app/` の中と、Studio が同梱するライブラリ(`react`、`react-dom`、`studio-talk`、既定の素材)だけ | ADR 0001 の 77 行、`src/server/build.js` の `ALLOWED_PACKAGES` | 部品のパッケージは、Studio が同梱するか、検査して許したものしか使えない |
| 試作品の CSP は `default-src 'none'`、`connect-src 'none'`。画像はそのビルドの URL と `data:`、`blob:` だけ | ADR 0001 の 152 行 | 字、アイコン、画像を外(CDN、Google Fonts など)から読めない。全部を同梱する |
| CSS の中の外の URL はビルドで残すが、CSP が止める | `src/server/build.js` | 外の字を読む部品は、見た目が崩れる。検査で知らせる |
| サーバーで `npm install` も package.json の scripts も動かさない | ADR 0001 の 149 行 | 利用者のパッケージを入れるときも、スクリプトは動かさない |
| 作る AI は `--restricted` で、ファイルの道具は `app/` の中だけ。Web の道具はない。MCP は観察の道具のサーバーだけ(`--strict-mcp-config`)。skills はない | `src/server/claude-args.js` の `buildClaudeArgs` | 作る AI は、Figma や Storybook の MCP、Web の指針を直接読めない。指針は `app/` の中か、Studio の決まり(`--append-system-prompt`)で渡す |
| 同梱するライブラリの範囲は、既定の素材まで | [ADR 0001 の「J3 で決めたこと」](../adr/0001-local-runtime-and-isolation.md#j3-で決めたこと2026-10-31) | 自分の部品のパッケージは、J5 で ADR 0001 を直してから足す。トークンはコードではなく CSS の値だけなので、J4 では ADR 0001 を直さない |

## 2. 既定の素材の候補とライセンス

### 使える候補

| 候補 | ライセンス | 出典 | Studio に同梱 | 試作品で使う | 気をつけること |
|---|---|---|---|---|---|
| Radix Primitives、Radix Themes、Radix Colors | MIT | https://github.com/radix-ui/primitives 、https://github.com/radix-ui/themes 、https://github.com/radix-ui/colors | できる | できる | React の部品。Themes は CSS のファイルを読む。今のビルドで読める(J3 で確かめた) |
| shadcn/ui | MIT | https://github.com/shadcn-ui/ui | できる | できる | 部品のコードを自分のプロジェクトに写す形なので、`app/` に置ける。ただし Tailwind CSS と Radix などの土台が要る。Tailwind の CSS を作る手順は今のビルドにない |
| Material Web(`@material/web`) | Apache-2.0 | https://github.com/material-components/material-web | できる | できる | Web Components(React の部品ではない)。README に「maintenance mode」とある(2024-06 の告知: https://github.com/material-components/material-web/discussions/5642) |
| Material Symbols、Material Icons | Apache-2.0 | https://github.com/google/material-design-icons | できる | できる | 字のファイルを同梱する。Google Fonts からは読めない |
| Roboto | OFL-1.1 | https://github.com/googlefonts/roboto-3-classic | できる | できる | 日本語の字はない |
| Material の色の作り方(`@material/material-color-utilities`) | Apache-2.0 | https://github.com/material-foundation/material-color-utilities | できる | できる | 1 つの色から、役割ごとの色を作れる |
| Material 3 の指針の文 | 未確認 | https://m3.material.io/ | 未確認 | 未確認 | 検索の抜き出しに「Apache 2.0 か CC BY 4.0」とあったが、ページの本文では確かめられなかった。確かめるまでは、文を写さず、自分の言葉で要約する |
| Fluent UI React v9(`@fluentui/react-components`) | MIT | https://github.com/microsoft/fluentui | できる | できる | 参照する字とアイコンは別のライセンス(下の「使えないもの」) |
| Fluent System Icons | MIT | https://github.com/microsoft/fluentui-system-icons | できる | できる | |
| Primer(`@primer/react`、Primer Primitives) | MIT | https://github.com/primer/react 、https://github.com/primer/primitives | できる | できる | GitHub の見た目 |
| Carbon(`@carbon/react`) | Apache-2.0 | https://github.com/carbon-design-system/carbon | できる | できる | IBM の見た目 |
| React Spectrum、Spectrum 2 | Apache-2.0 | https://github.com/adobe/react-spectrum | できる | 一部 | Spectrum 2 の字(Adobe Clean)は外(`use.typekit.net`)から読むので、CSP で止まる。字のライセンスは未確認 |
| Lucide(`lucide-react`) | ISC(Feather から来たアイコンは MIT) | https://github.com/lucide-icons/lucide | できる | できる | |
| Inter、IBM Plex、Noto Sans CJK | OFL-1.1 | https://github.com/rsms/inter 、https://github.com/IBM/plex 、https://github.com/notofonts/noto-cjk | できる | できる | 日本語の字のファイルは大きい。大きさは測っていない(不明) |
| Figma の Community の無料のファイル(UI キット) | CC BY 4.0(既定) | https://help.figma.com/hc/en-us/articles/360042296374-Figma-Community-copyright-and-licensing | 絵と値の参考 | 出典の表示つきで | 有料のファイルは別のライセンス。作り手が別の条件を足すこともあるので、1 つずつ確かめる。Figma のファイルはコードではないので、そのまま部品にはならない |

### 使えないもの

| もの | ライセンス | 出典 | 理由 |
|---|---|---|---|
| Apple Design Resources(Figma、Sketch の UI キット) | Apple の独自の契約 | https://developer.apple.com/support/downloads/terms/apple-design-resources/Apple-Design-Resources-License-20230621-English.pdf | 2A: Apple の OS だけで動くソフトの画面の下書き(mock-ups)にだけ使える。2B: Apple 以外の OS 向けの下書きに使えない。ほかのソフトに埋め込めない。Web の中身にも使えない。再配布できない。2C: 中の絵や部品を取り出して使えない(2026-10-29 に原文を読んだ) |
| SF Pro などの San Francisco の字 | 別の契約 | 上の契約の 1B、https://developer.apple.com/fonts/ | 上の契約の 1B で、字は別の契約とされている。今の字の契約の全文は未確認。Studio に同梱しない |
| SF Symbols | Apple の独自の契約 | https://developer.apple.com/design/human-interface-guidelines/sf-symbols | アプリのアイコンやロゴなどに使うことを禁じる文がある。全文は未確認。Studio に同梱しない |
| Human Interface Guidelines の文 | 開いたライセンスは見つからなかった(調べの担当が読んだ) | https://www.apple.com/legal/internet-services/terms/site.html | 文を写さない |
| Microsoft の Fabric の素材(Segoe の字、Office のアイコン) | Microsoft の独自の契約 | https://static2.sharepointonline.com/files/fabric/assets/microsoft_fabric_assets_license_agreement_nov_2019.pdf | Microsoft の API や製品とつなぐアプリにだけ使える |
| Segoe UI | 再配布できない | https://learn.microsoft.com/en-us/typography/fonts/font-faq | 同梱しない。CSS の字の並びに名前を書くだけなら、OS にある字を使う |
| Atlassian の素材(`@atlaskit/*`) | npm では Apache-2.0、サイトの契約は別 | https://atlassian.design/license | サイトの契約は、Atlassian の拡張を作る用に限り、変えて配ることを禁じている。どちらが効くかは未確認。使わない |

### Apple の素材の代わり

Apple の見た目を求める人には、次の代わりを使います。どれも推測を含む案です。

| 求めるもの | 代わり |
|---|---|
| Apple の画面の落ち着いた見た目 | Radix Themes の中立の見た目と、OS の字(`system-ui`)。Apple の端末では OS の字で描かれる。字を同梱しないので、Apple の字の契約に触れない見込み(推測) |
| SF Symbols | Lucide か Material Symbols |
| HIG の考え方(明快さ、余白、触れる大きさなど) | 文を写さず、Studio の質の見直しの項目として自分の言葉で書く。項目ごとに、測り方(字と地の差、触れる所の大きさなど)を決める |
| iPhone の画面の枠 | 試作品の幅を端末の幅にする表示(Studio の機能として作る。Apple の絵は使わない) |

## 3. 既定の素材

運営者が 2026-10-29 に決めた。決めたことは、この節の最後の「決めたこと」にある。

### 選ぶ基準

| 基準 | なぜ |
|---|---|
| 同梱と、生成した試作品での利用を、ライセンスが許す | 原則 7「信頼できる」。あいまいなものは入れない |
| React 19 で使える | Studio が同梱する React は 19.3.1 |
| 外への通信なしで描ける | 試作品の CSP。字とアイコンを同梱できる |
| 手入れが続いている | 止まった素材を既定にすると、直せない不具合が残る |
| アクセシビリティの土台がある | 原則 4「質を測る」で、見直しの違反を減らす |
| 見た目が中立で、トークンで変えやすい | 既定のままの試作品がどれも同じ顔になるのを避け、自分の素材に替えやすくする |

### 候補を比べる

| 候補 | ライセンス | React 19 | 外への通信なし | 手入れ | 中立 | 見立て |
|---|---|---|---|---|---|---|
| Radix Themes + Radix Colors + Lucide(決めた) | MIT、ISC | React の部品 | 字は OS の字で済む(J3 で確かめた) | 続いている見込み(Themes 3.3.0。頻度は確かめていない) | 中立 | 既定にする |
| Material Web + Material Symbols + Roboto | Apache-2.0、OFL-1.1 | Web Components。React 19 は custom elements を扱えるが、Studio では確かめていない | 字とアイコンの同梱が要る | maintenance mode | Google の見た目 | 「Google の見た目」を選べる素材として足す。既定にはしない |
| Fluent UI React v9 + Fluent System Icons | MIT | React の部品 | Segoe を同梱できない。OS の字に落とす | 続いている(9.75.0) | Microsoft の見た目 | 第 3 の候補 |
| shadcn/ui | MIT | React の部品 | Tailwind の CSS を作る手順が要る | 続いている | 中立 | 今のビルドに Tailwind がないので、後にする |

### 決めたこと

運営者が 2026-10-29 に、おすすめのとおりに決めた(task 381)。

- 既定の素材: 部品は Radix Themes。色は Radix Colors。アイコンは Lucide。字は OS の字(`assets/brand/tokens.css` と同じ決まり)
- 選べる素材: Material 3 を「Google の見た目」(Material Web、Material Symbols、Roboto、色は material-color-utilities)として足す。Material Web は既定にしない。maintenance mode なので、画面に「手入れが止まっている素材です」と出す
- ライセンスの確かめ: 同梱の前に、運営者がライセンスの原文を読む。J3 は同梱の前で止まり、運営者が読み終えてから同梱に進む(J3 の PR を merge して確定する)
- 作る AI への指針: 素材ごとに 1 枚の指針の要約(部品の選び方、色の役割、字の大きさ、間隔、アクセシビリティ)を Studio が持つ。ライセンスが確かめられない指針の文は写さず、自分の言葉で書く
- 同梱の大きさと、ビルドの時間への影響は、下の「J3 で確かめたこと」で測った

### J3 で確かめたこと

2026-10-31 に、`test/fixtures/default-material/app/` の見本で確かめた。

| 問い | 結果 |
|---|---|
| 今のビルドがパッケージの CSS を読めるか | 読める。JS の `import` でも、CSS の `@import` でも通る |
| 外への通信なしで描けるか | 描ける。iframe が読むのは自分の版の 4 つのファイルだけ。CSP に止められたものはない |
| 字を同梱しなくてよいか | よい。Radix Themes の CSS に `url()` はなく、`@font-face` は `local()` だけ。Segoe などの字のファイルは同梱しない |
| React 19 で動くか | 動く。Radix Themes 3.3.0 と Lucide 1.65.0 を React 19.3.1 で動かした。Dialog は `sandbox` の中で開いて閉じる |
| 同梱の大きさ | `node_modules` が約 64 MB 増える(Lucide 48 MB、`@radix-ui` 16 MB)。入るパッケージは 78 個 |
| 試作品の大きさ | `app.js` は 1.25 MB から 1.50 MB、`app.css` は 2 KB から 815 KB(図書室の見本と、部品を 9 つ使う見本を比べた) |
| ビルドの時間 | 約 40 ms から約 300 ms(同じ比べ方。手元の Mac で 5 回。別の機械では測っていない) |

置き場所も決めた。

| もの | 置き場所 |
|---|---|
| 出典とライセンスの一覧 | `materials/default/source.json`。`npm run materials:sources` で作る。中で使うパッケージも全部載せる |
| ライセンスの原文 | `materials/default/licenses/`。同じ原文は 1 つにまとめる |
| npm のパッケージに原文がないものの写し | `materials/default/licenses-upstream/`(出典のリポジトリから写す) |
| 指針の要約 | `materials/default/guide.md`。作る AI の決まりに入る |

Material 3 は J3 では同梱しない。選ぶ画面と「手入れが止まっている素材です」の表示が要り、J3 の受け入れ条件の外にあるため。選ぶ形を別のカードで作るときに、そのカードで運営者がライセンスの原文を読む。

## 4. 自分の素材をつなぐ形

### 置き場所の案

作る AI は `app/` の中を読み書きできます。素材を `app/` に置くと、作る AI が書き換えるおそれがあります。そこで、次のように分けます(案)。

| もの | 置き場所 | 作る AI | 理由 |
|---|---|---|---|
| トークン | `.studio/materials/`(J4 で決めた)。ビルドが CSS の変数にして `app.css` の最後に足す | 読めない。変数の名前を Studio の決まりで受け取り、`var()` で読む | 書き換えられない |
| 部品のパッケージ | Studio が持つ場所(試作品の `.studio/` の下か、データの置き場)。ビルドが決まった名前の import(例: `studio:design/...`)で解く(案。J5 の後半) | 読めない。import の名前で使う | 書き換えられない |
| 指針の文、部品の一覧の文 | `app/design/` に写す | 読める | 作る AI は `app/` の外を読めない |
| 写しが変わっていないか | 関門(検査の G3 の仲間)で写しのハッシュを確かめる | | 作る AI が指針を書き換えても気づける |
| 出典とライセンス | 素材ごとの一覧(`source.json`。既定の素材は `materials/default/source.json`) | 読める | 引き継ぎと見直しで使う |

### 形ごとの道

| 形 | 利用者が渡すもの | Studio がすること | 作る AI が `app/` で使う道 | 隔離との関係 | 順 |
|---|---|---|---|---|---|
| デザイントークン | W3C の Design Tokens の形の JSON(2025.10 が初めての安定版。https://www.designtokens.org/tr/2025.10/ 、告知: https://www.w3.org/community/design-tokens/2025/10/28/design-tokens-specification-reaches-first-stable-version/) | 形を検査し、CSS の変数に変える。色の役割(地、字、押せる所、失敗)が足りなければ聞く。変換は Style Dictionary(Apache-2.0。DTCG の形を扱うが、2025.10 の全部にはまだ対応していないと書いてある: https://styledictionary.com/info/dtcg/)か、自前の小さな変換 | 変数だけを使う。値のまま書いた色は質の見直しで数える | ファイルの中身だけ。外への通信なし。一番易しい | 1 |
| 指針の文 | Markdown のファイル(デザインの決まり、文の決まり、アクセシビリティの決まり) | 大きさと秘密を検査し(今の `redact.js` の秘密の検査を使う)、`app/design/` に写す。要約を Studio の決まりに入れる | `app/design/` の文を読む | ファイルだけ | 2 |
| Storybook | 静的なビルドのフォルダー(`storybook-static` など)か、公開の URL | 部品の一覧を読む。静的なビルドには `index.json` があり(合成の機能の前提: https://storybook.js.org/docs/sharing/storybook-composition)、`/manifests/components.json` もある(プレビューで、公開の API ではないと書いてある: https://storybook.js.org/docs/ai/manifests)。部品の名前、使い方の文、見本の引数を `app/design/components.md` にする | 部品の一覧と使い方を読む。部品のコードそのものは、静的なビルドからは import できない。使うには下の npm のパッケージの道が要る | フォルダーなら外への通信なし。URL なら Studio のサーバーが外へ読みに行く。今の Studio は Claude Code 以外の外に出ないので、新しい外への呼び出しになる。同意と送り先の表示が要る。フォルダーを先にする | 3 |
| Storybook の MCP(`@storybook/addon-mcp`) | 利用者の Storybook の開発サーバー(`http://localhost:6006/mcp`)。プレビュー(https://storybook.js.org/docs/ai/mcp/overview) | 使わない(今は) | なし | 作る AI の MCP は Studio の観察の道具だけ。利用者の開発サーバーを動かすと、利用者のコードが PC で動く(ADR 0001 の T2)。同じ役は、Studio の持つ「素材の道具」の MCP サーバー(観察の道具と同じ形)で、写した一覧から答えればできる | 後 |
| npm のパッケージ(自分の部品) | パッケージのファイル(`npm pack` で作った tgz)か、フォルダー | 展開するだけで、スクリプトは動かさない。ライセンスの欄、依存の数、外への URL(字の CDN など)、大きさを検査する。試作品ごとに import を許す一覧に足す | 許された名前で import する | 部品のコードは、試作品の `sandbox` の iframe の中だけで動く。外へ通信できない。ビルド(esbuild)はコードを動かさない。ADR 0001 の「同梱するライブラリだけ」を「同梱するものと、検査して許したもの」に直す | 4 |
| Figma | 変数を書き出した JSON(トークンの道へ)、画面の絵(PNG) | トークンの道に乗せる。絵は見本として `app/design/` に置く | 見本の絵を見る(作る AI が絵を読めるかは、作る AI の道具しだい。未確認) | Studio は Figma を呼ばない。Figma の MCP サーバー(https://developers.figma.com/docs/figma-mcp-server/)は、リモートは外への通信と Figma のログインが要る。デスクトップは有料のプランの Dev か Full の席が要る。変数の REST API は Enterprise の Full の席が要る(https://developers.figma.com/docs/rest-api/variables/)。多くの利用者には、書き出しの道が現実的 | 5 |

### J4 で決めたこと

カードに書いていなかったことを、エージェントが決めた。運営者の確かめは PR で受ける。

| 決めたこと | 中身 | 理由 | 採らなかった案 |
|---|---|---|---|
| どう試作品に入れるか | ビルドが `app.css` の最後に足す。import の名前(上の表の前の案 `studio:design/tokens.css`)はやめた | 作る AI が読み込みを消せない。今ある試作品も、ソースを変えずに既定の素材の部品の色と字が変わる。書き出したソースが Studio だけの名前を持たない | import の名前。消されると素材が効かない。Studio の外でビルドできなくなる |
| 既定の素材とのつなぎ | 役割(地、字、押せる所、失敗、字の種類)に当てたトークンを、Radix Themes の変数に当てる。段のある色は 1 色から `color-mix` で作る | 既定の素材の部品が、そのまま自分の色になる。「部品の色を直して」を頼まなくて済む | `--token-*` だけを出す。部品が変わらず、受け入れ条件の「見本の色と字」が自分で書いた所だけになる |
| 変換 | 自前の小さな変換(`src/server/design-tokens.js`)。Style Dictionary を使わない | 2025.10 の全部にはまだ対応していないと書いてある(4 節の表)。依存を増やさない。誤りを利用者の言葉で返せる | Style Dictionary |
| 作る AI が素材を変えたか | 関門 G3 で 2 つを確かめる。(1) `app/` の CSS、JS、HTML の中で `--token-*` と、役割に当てた既定の素材の変数を定義していないか。(2) `.studio/materials/tokens.json` が、つないだときの指紋と同じか。ほかに、つないでいない `--token-*` を読むと止める | 作る AI のファイルの道具は `app/` の外に書けないので、変える道は `app/` の中の上書きが主。(2) は手で変えたときと、万一の守り | 写しを `app/design/` に置いてハッシュで確かめる。写しは J5 の指針の文で使う。トークンは写さなくても名前を渡せる |
| 作る AI に何を渡すか | 変数の名前、種類、役割だけ。値とトークンの説明の文は渡さない | 値を写して書かせないため。説明の文はファイルの持ち主の文で、指示として読ませたくない | 値も渡す |
| 古い書き方の色と大きさ | 文字列(`#ff0000`、`16px`)は誤りにし、2025.10 の形を案内する | カードは 2025.10 の形。仕様は種類を値から推測しないよう求めている | 文字列も受ける。形がゆるみ、受けた値の検査が増える |
| 役割が足りないとき | 既定の素材のままにできる。足りない役割を画面に出し、選び直せる | 5 節の「既定の素材で補うかを聞く」に合わせた | 足りないと断る |
| 誰の素材か | 書かないとつなげない。理由は書かなくても進める | 引き継ぎの出典になる。J5 の「ライセンスが分からないと有効にできない」の手前 | どちらも任意 |
| 届く範囲 | この試作品だけ。「これからの試作品全部」は J5 の案内で足す | J4 は案内の 4 歩の前の段 | Studio 全体に置く |
| 版との関係 | 版で戻しても素材は戻らない。素材を変えたら、前の確かめは「古い」と出る | 目的の文書や設計と同じ扱い。`app/` の指紋に素材は入らないので、時刻で比べる | 版に素材を入れる |
| 引き継ぎ | 形式 3 のまま、つないでいるときだけ `materials` と `materials/` のファイルを足す | J8 が形式 4 にする。ソースだけでは同じ見た目にならないので、先に足す | J8 まで入れない |

作って決めた細かいこと:

- 変数の名前は `--token-` にトークンの場所をハイフンでつないだもの(`color.brandPrimary` は `--token-color-brand-primary`)。`typography` は `--token-x-font-size` のように分ける。別の場所から同じ名前になると誤りにする
- 値は種類ごとに形を確かめてから Studio が CSS の文を組み立てる。字の名前だけは引用符の中の文字列にする。`url()` や別の宣言は値に混ざらない(外への通信なしを保つ)。`$extensions` は読まない
- `{a.b}`、`$ref`(このファイルの中だけ)、`$extends`、`$root` を解く。輪は誤り。重ねて倍々に膨らむファイルは、たどる回数の上限で断る
- 上限はファイル 512 KB、トークン 2000 個、入れ子 20 段、変数の名前 120 文字(仮)
- 定義の検査は形で探す。行をまたぐ形は見つけるが、文字列を組み立てた名前、CSS のエスケープやコメントを挟んだ形は見つけない。わざと隠す相手の守りではなく、うっかりの上書きを止めるもの。逆に `cond ? '--token-a' : 'b'` のような文は止まることがある。値のまま書いた色を数えるのは J6 で、J4 は作る AI への決まりだけ
- 読む所は `var(--token-x)` の形だけを見る。`.badge--token-count` のような語や、文の中の名前では止めない
- 素材のファイル自体の問題(指紋が違う、ない、形が壊れた)は `app/` の外にあり、作る AI には直せない。関門で止めたら直すラウンドに回さず、人に「外して、つなぎ直す」を案内する。料金をかけないため
- 外すと、`var(--token-x)` を読む所には値がなくなる。止めず、残りの数を画面で知らせる(後の値を書いていれば、それで描く)。外した状態の版を戻すときは知らせない
- 秘密らしい文字列と、個人の情報らしい文字列があると断る。素材のファイルは引き継ぎにそのまま入るため。探すのは名前と文字列の値で、色の成分などの数は探さない
- 仕様より緩く受ける所: `shadow` の `blur` と `spread` は、なければ 0 にする。`typography` は項目が欠けていても、ある分だけ変数にする。仕様にない `$` の項目は使わないと知らせて進む
- 仕様の `$ref` は、トークンの値の中のほかに、`$value` のない `$ref` も受ける(トークンを指せば別名、グループを指せば `$extends` と同じ)
- グラデーションの変数は色の並びだけ。仕様に種類の項目がないので、`linear-gradient(var(--token-x))` のように読む
- 試作品がつないでいない変数を読んでいると、つなぐ前に場所を出して断る。読んでいない変数が足りないだけなら断らない
- 場面の回し(`npm run evals`)のビルドは素材を見ない。見た目を使わないため

確かめていないこと:

- Figma の変数を W3C の形で書き出す道具: 検索では、TokensBruecke(README に 2025.10 と互換と書いてある。https://cdn.jsdelivr.net/npm/tokens-bruecke@3.15.1/README.md )、Token Forge(https://figma-web.pages.dev/plugins/1560757977662930693 )、`@tfk-samf/figma-to-dtcg`(https://npmjs.com/package/@tfk-samf/figma-to-dtcg )が見つかった。どれも動かしていない。Figma の標準の書き出しは、フォーラムに一部のアカウントで出たとの書き込みがあるだけで、一般に使えるかと 2025.10 の形かは不明(https://forum.figma.com/ask-the-community-7/native-variable-export-feature-47831/index2.html )。古い形の色の文字列を出す道具があるので、誤りの文で 2025.10 の形を案内する
- 本物の書き出しのファイルで通るか: 架空のファイルだけで確かめた
- 明るい地と暗い地を切り替える素材: 1 つの値だけを扱う。2025.10 の Resolver の仕組みは読んでいない。暗い地の Theme では、淡い段が合わない見込み(推測)
- 字と地の差: 検査していない。J5 の「見本で試す」と J6

## 5. 取り込みを案内する流れ

### 4 歩

| 歩 | 聞くこと、すること | 確かめること | うまくいかないとき |
|---|---|---|---|
| 1. 聞く | 何を持っているか(なし、トークン、指針の文、Storybook、npm のパッケージ、Figma)。誰の素材か。使ってよいか(ライセンス、社内の許可) | 答えから、4 節のどの道かを決める | 「なし」なら既定の素材を勧める。分からないときは、デザイナーに聞く問いの文を出す |
| 2. 確かめる | ファイルかフォルダーを選んでもらう | 形、足りないもの(色の役割、字、間隔)、ライセンスの欄、外への URL、秘密らしい文字列、大きさ | 何が足りないかと、既定の素材で補うかを聞く。ライセンスが分からないときは「有効にする」を押せない |
| 3. 見本で試す | 見本の画面(ボタン、入力、カード、会話の枠、失敗の表示)を、新しい素材と今の素材で並べて描く | 字と地の差、外への通信がないこと、崩れ | 崩れた所を指し、直し方(足りないトークンなど)を 1 文で出す |
| 4. 有効にする | この試作品だけか、これからの試作品全部か | 有効にした素材の出典とライセンスの一覧 | 前の素材にいつでも戻せる(版と同じ考え) |

有効にした後は、作る AI への依頼に指針の要約が入り、質の見直し(J6)が「素材に合っているか」を数えます。

### 取り込みの形で決めたこと

ほかの道具とは比べず、Studio の形だけを書く。個人のプロジェクトには、企業名とサービス名を書かない決まりがあるため(2026-11-06 に運営者が決めた)。

- 指針をファイルにして、作る AI が毎回読む。置き場所は `app/design/` の写しと、Studio が持つ素材。写しが変わっていないかを関門で確かめる
- 素材を入れる人(デザイナー)と、それで作る人を分けられる。素材を「これからの試作品全部」に有効にすれば、そうなる
- 作る AI はパッケージを入れられない。Studio が検査して、import を許す
- 素材の検査とライセンスの確かめを、AI ではなく決まった手順で行う(原則 7)
- 素材に合っているかを、見直しで数として出す(原則 4)
- 素材より前に、目的の聞き出しと設計の案内がある(原則 1)

### J5 で決めたこと

task 388(2026-11-07)。カードに書いていなかったことを、エージェントが決めた。運営者の確かめは PR で受ける。

| 決めたこと | 中身 | 理由 | 採らなかった案 |
|---|---|---|---|
| カードの分け方 | 前半(このカード)は、案内の 4 歩、指針の文、Storybook。後半は npm のパッケージ | カードが 2 枚に分けてよいとしている。npm のパッケージは ADR 0001 の「同梱するライブラリだけ」を直す必要があり、隔離の判断を別の PR で見られるようにする | 1 枚で全部作る。隔離の変更と画面の変更が 1 つの PR に混ざる |
| 置き場所 | 元は `.studio/materials/guides/` と `storybook/`。写しは `app/design/guides/<名前>.md` と `app/design/components.md`。記録はトークンと同じ `source.json` | 4 節の表のとおり。作る AI は `app/` の外を読めない | 写しを置かず、決まりの文に中身を入れる。長い指針で決まりの文が膨らむ |
| 写しが変わったとき | 関門 G3 で止め、作る AI には直せない印(locked)を付ける。人が「写しを戻す」で戻す | 作る AI は元を読めないので、直すラウンドは料金がかかるだけ。J4 の素材のファイルと同じ扱い | 毎回のビルドの前に黙って書き直す。作る AI が変えたことに気づけない |
| 版で戻すとき | 版の `app/` に替えた後、今の写しを書き直し、前に外した写しを消す | 「版で戻しても素材は戻らない」(J4)に合わせる。写しのない版に戻すと関門で止まるのを防ぐ | 写しも版と一緒に戻す。記録と写しがずれる |
| 見本で試す | 指針の文と部品の一覧は、見た目を変えないので、直す AI が読む写しと、決まりに足す文を、文字だけで見せる。外への URL の場所もここで出す | 5 節の表の「新しい素材と今の素材で並べて描く」は、見た目の変わる素材(トークン、npm のパッケージ)の形。文の素材では、何が作る AI に渡るかを確かめるのが試すことになる | 見本の画面を描く。文の素材では見た目が変わらず、比べる中身がない |
| ライセンス | 人の答え(公開のライセンスの名前、社内の許可、分からない)で決める。フォルダーの `LICENSE` と `package.json` の書き方は手がかりとして出すだけ。「分からない」と、名前のない公開のライセンスは、有効にできない。サーバーも 409 で断る | 法律の判断を機械に任せない(この文書の前提)。受け入れ条件 | ファイルの書き方で自動に決める |
| 外への URL | 警告にし、写しには残す。試作品の CSP が止める。直す AI への決まりに「使わない」と書く | 指針の文の中の URL は、説明の一部のことが多い。消すと文の意味が変わる | 写しから消す。断る |
| 個人の情報らしい文字列 | 警告にする。秘密らしい文字列は断る | 指針の文には、入力欄の例として架空の電話番号などが入りやすい。トークン(J4)は値の並びなので断った | トークンと同じく断る |
| これからの試作品全部 | データの置き場の `materials/` に置き、`createStarterProject` が新しい試作品に写す。外しても、今ある試作品の写しはそのまま | 素材を入れる人と、それで作る人を分けられる(5 節)。今ある試作品を勝手に変えない | 今ある試作品にも全部写す |
| 写しの名前 | フォルダーの名前を落とし、使える字だけにする。`CLAUDE.md`、`AGENTS.md`、`components.md` と隠しファイルの名前には `guide-` を付ける。写す場所に人が置いたファイルがあれば、上書きせずに断る | 作る AI(Claude Code)は下のフォルダーの `CLAUDE.md` も指示として読む。inspect の検査で止まる名前もある | 名前をそのまま使う |
| Storybook から読むもの | `index.json` の部品(`title` ごと)と見本の名前、`manifests/components.json` があれば使い方の文(`description` か `summary`)。形が決まっていないので、ゆるく読む | 4 節の表のとおり。部品のコードは静的なビルドからは import できない | MDX の文を読む。ビルドの JS の中にあり、読むにはコードを動かす |

作って決めた細かいこと:

- 上限は 1 ファイル 200 KB、合計 1 MB、30 個。Storybook の `index.json` は 4 MB、部品は 300 個、部品の一覧の写しは 512 KB(仮)。写しは `app/` に入るので、`app/` の検査の上限より十分小さくした。写しを足すと `app/` の上限(5 MB、500 個)を超えるときは、書く前に断る。超えるとビルドが止まり、作る AI にも直せないため
- 写しを書くときは、`app/` の中のリンクをたどらない。「写しを戻す」で途中がリンクかファイルなら、消して作り直す(作る AI のすり替え)。有効にするときに途中がファイルなら、人のファイルとして断る。消すときは、途中がリンクなら消さない
- 外した写しと置き換えた写しの場所と指紋を `source.json` の `retired` に残す(200 個まで)。版で戻した後、戻ってきた写しの中身がそのときのままなら消す。今は有効でない素材が、出典もライセンスの記録もないまま残らないようにするため
- 作る AI への決まりには、写しの場所と守ることだけを書く。中身は書かない(作る AI が写しを読む)
- 案内の「1. 聞く」で、トークンは J4 の欄へ、npm のパッケージは「まだつなげない」と案内する。できていない機能を約束しない(user-journey.md の 3 節)
- 作る AI が写しを変えたことを素材の欄にも出すため、画面はビルドのたびに素材の中身を読み直す

確かめていないこと:

- 本物の Storybook の静的なビルドで通るか: 架空の `index.json` と `manifests/components.json` だけで確かめた。`manifests/components.json` の形はプレビューの機能で、変わることがある
- 本物の AI が写しを読んで、指針に沿って作るか: 実モデルで確かめていない(偽接続で、写しを読んで画面に出す動きだけを確かめた)
- 人の確かめ: デザイナーが案内だけで素材をつなげるか(10 分以内、仮)。人を待つ

## 6. 決めたこと、決めていないこと、確かめていないこと

### 決めたこと

| 日付 | 決めたこと | 書いた所 |
|---|---|---|
| 2026-10-29 | 既定の素材は Radix Themes + Radix Colors + Lucide + OS の字。Material 3 は「Google の見た目」として選べる素材にする。Material Web は既定にしない | 3 節 |
| 2026-10-29 | 同梱の前に、運営者がライセンスの原文を読む。J3 は止まって確かめる | 3 節 |
| 2026-10-31 | J3 では Material 3 を同梱しない。選ぶ画面と一緒に別のカードで足す(J3 の担当が決めた。運営者が PR で確かめる) | 3 節 |
| 2026-11-02 | トークンは `.studio/materials/` に置き、ビルドが `app.css` の最後に足す。import の名前の案をやめた(J4 の担当が決めた。運営者が PR で確かめる) | 4 節 |
| 2026-11-07 | J5 を 2 枚に分けた。前半は案内の 4 歩、指針の文、Storybook。写しは `app/design/`、変わると関門 G3 で止まる(J5 の担当が決めた。運営者が PR で確かめる) | 5 節 |

### 決めていないこと、確かめていないこと

- Material 3 の指針の文のライセンス: 未確認。確かめるまでは写さない
- SF Pro と SF Symbols の契約の全文: 未確認。どちらにしても同梱しない
- 既定の素材の指針の要約で、作る AI の試作品が良くなるか: 実モデルで確かめていない
- React 19 での Material Web の動き: Studio では確かめていない
- アクセシビリティの検査の道具と、そのライセンス: 選んでいない。J6 で確かめる
- Storybook の URL を読むための、Studio の新しい外への呼び出し: 入れるかを決めていない。入れるなら同意と送り先の表示を、今の本物の AI の同意と同じ形で作る
