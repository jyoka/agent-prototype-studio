# デザインシステムの素材の作戦

試作品の見た目と使いやすさを、誰でも少しの「良い味」から始められるようにする作戦です。既定の素材の候補とライセンス、自分の素材をつなぐ形、取り込みの案内を書きます。

- 状態: 案(task 378)。書いた日: 2026-10-29。実装は [user-journey.md の 6 節](user-journey.md#6-実装のカードの分け方)の J3〜J5
- 前提: [vision.md](../vision.md) の原則 6「素材を流用できる」、[ADR 0001](../adr/0001-local-runtime-and-isolation.md)。隔離は弱めない
- 出典はどれも 2026-10-29 に読んだ。ライセンスは一次資料(リポジトリの LICENSE、公式の規約、npm の登録)で確かめた。確かめられなかったものは「未確認」と書いた
- ライセンスの読み方は、法律の助言ではない。同梱を決める前に、運営者が原文を読む

## 結論

- 素材とは、部品(コード)、トークン(色、字、間隔などの値)、アイコン、字、指針の文のこと
- Apple の素材(Apple Design Resources、SF Pro、SF Symbols)は使えない。Apple のプラットフォームの画面の下書きにしか使えず、ほかのソフトに埋め込めないため(2 節)
- 既定の部品のおすすめは Radix Themes(MIT)。ほかに Material 3(Material Web、Apache-2.0)を選べる素材として足す。アイコンは Lucide(ISC)、字は OS の字(3 節)
- 自分の素材は、つなぎやすい順に、トークン、指針の文、Storybook、npm のパッケージ、Figma にする(4 節)
- 作る AI は `app/` の外を読めず、MCP は Studio の観察の道具だけ。だから素材は Studio が受け取り、検査し、作る AI に渡す。作る AI に外の Figma や Storybook を直接つながない(4 節)
- 取り込みの案内は、聞く、確かめる、見本で試す、有効にするの 4 歩(5 節)

## 1. 今の決まりと、素材への影響

| 今の決まり | 出典 | 素材への影響 |
|---|---|---|
| ビルドの import は、`app/` の中と、Studio が同梱するライブラリ(今は `react`、`react-dom`)だけ | ADR 0001 の 77 行、`src/server/build.js` の `ALLOWED_PACKAGES` | 部品のパッケージは、Studio が同梱するか、検査して許したものしか使えない |
| 試作品の CSP は `default-src 'none'`、`connect-src 'none'`。画像はそのビルドの URL と `data:`、`blob:` だけ | ADR 0001 の 152 行 | 字、アイコン、画像を外(CDN、Google Fonts など)から読めない。全部を同梱する |
| CSS の中の外の URL はビルドで残すが、CSP が止める | `src/server/build.js` | 外の字を読む部品は、見た目が崩れる。検査で知らせる |
| サーバーで `npm install` も package.json の scripts も動かさない | ADR 0001 の 149 行 | 利用者のパッケージを入れるときも、スクリプトは動かさない |
| 作る AI は `--restricted` で、ファイルの道具は `app/` の中だけ。Web の道具はない。MCP は観察の道具のサーバーだけ(`--strict-mcp-config`)。skills はない | `src/server/claude-args.js` の `buildClaudeArgs` | 作る AI は、Figma や Storybook の MCP、Web の指針を直接読めない。指針は `app/` の中か、Studio の決まり(`--append-system-prompt`)で渡す |
| 同梱するライブラリの範囲(UI の部品まで入れるか)は後のカード | ADR 0001 の 441 行 | 既定の素材を同梱するときに、ADR 0001 を直す |

## 2. 既定の素材の候補とライセンス

### 使える候補

| 候補 | ライセンス | 出典 | Studio に同梱 | 試作品で使う | 気をつけること |
|---|---|---|---|---|---|
| Radix Primitives、Radix Themes、Radix Colors | MIT | https://github.com/radix-ui/primitives 、https://github.com/radix-ui/themes 、https://github.com/radix-ui/colors | できる | できる | React の部品。Themes は CSS のファイルを読む。今のビルドがパッケージの CSS を import できるかは確かめていない(J3 で確かめる) |
| shadcn/ui | MIT | https://github.com/shadcn-ui/ui | できる | できる | 部品のコードを自分のプロジェクトに写す形なので、`app/` に置ける。ただし Tailwind CSS と Radix などの土台が要る。Tailwind の CSS を作る手順は今のビルドにない |
| Material Web(`@material/web`) | Apache-2.0 | https://github.com/material-components/material-web | できる | できる | Web Components(React の部品ではない)。README に「maintenance mode」とある(2024-06 の告知: https://github.com/material-components/material-web/discussions/5642) |
| Material Symbols、Material Icons | Apache-2.0 | https://github.com/google/material-design-icons | できる | できる | 字のファイルを同梱する。Google Fonts からは読めない |
| Roboto | OFL-1.1 | https://github.com/googlefonts/roboto-3-classic | できる | できる | 日本語の字はない |
| Material の色の作り方(`@material/material-color-utilities`) | Apache-2.0 | https://github.com/material-foundation/material-color-utilities | できる | できる | 1 つの色から、役割ごとの色を作れる |
| Material 3 の指針の文 | 未確認 | https://m3.material.io/ | 未確認 | 未確認 | 検索の抜き出しに「Apache 2.0 か CC BY 4.0」とあったが、ページの本文では確かめられなかった。確かめるまでは、文を写さず、自分の言葉で要約する |
| Fluent UI React v9(`@fluentui/react-components`) | MIT | https://github.com/microsoft/fluentui | できる | できる | 参照する字とアイコンは別のライセンス(下の「使えないもの」)。Replica の見本の 1 つが使っている(5 節) |
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

## 3. 既定の素材のおすすめ

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
| Radix Themes + Radix Colors + Lucide(おすすめ) | MIT、ISC | React の部品 | 字は OS の字で済む見込み(推測) | 続いている見込み(Themes 3.3.0。頻度は確かめていない) | 中立 | 既定にする |
| Material Web + Material Symbols + Roboto | Apache-2.0、OFL-1.1 | Web Components。React 19 は custom elements を扱えるが、Studio では確かめていない | 字とアイコンの同梱が要る | maintenance mode | Google の見た目 | 「Google の見た目」を選べる素材として足す。既定にはしない |
| Fluent UI React v9 + Fluent System Icons | MIT | React の部品 | Segoe を同梱できない。OS の字に落とす | 続いている(9.75.0) | Microsoft の見た目 | 第 3 の候補。Replica と比べるときの見本にもなる |
| shadcn/ui | MIT | React の部品 | Tailwind の CSS を作る手順が要る | 続いている | 中立 | 今のビルドに Tailwind がないので、後にする |

### おすすめ

- 既定の部品: Radix Themes。色は Radix Colors。アイコンは Lucide。字は OS の字(`assets/brand/tokens.css` と同じ決まり)
- 選べる素材: 「Google の見た目」(Material Web、Material Symbols、Roboto、色は material-color-utilities)。maintenance mode なので、画面に「手入れが止まっている素材です」と出す
- 作る AI への指針: 素材ごとに 1 枚の指針の要約(部品の選び方、色の役割、字の大きさ、間隔、アクセシビリティ)を Studio が持つ。ライセンスが確かめられない指針の文は写さず、自分の言葉で書く
- 同梱の大きさと、ビルドの時間への影響は測っていない(不明)。J3 で測る

どれを既定にするかは、運営者が決めます。

## 4. 自分の素材をつなぐ形

### 置き場所の案

作る AI は `app/` の中を読み書きできます。素材を `app/` に置くと、作る AI が書き換えるおそれがあります。そこで、次のように分けます(案)。

| もの | 置き場所 | 作る AI | 理由 |
|---|---|---|---|
| トークンの CSS、部品のパッケージ | Studio が持つ場所(試作品の `.studio/` の下か、データの置き場)。ビルドが決まった名前の import(例: `studio:design/tokens.css`)で解く | 読めない。import の名前で使う | 書き換えられない |
| 指針の文、部品の一覧の文 | `app/design/` に写す | 読める | 作る AI は `app/` の外を読めない |
| 写しが変わっていないか | 関門(検査の G3 の仲間)で写しのハッシュを確かめる | | 作る AI が指針を書き換えても気づける |
| 出典とライセンス | 素材ごとの一覧(`source.json` など。名前は J3 で決める) | 読める | 引き継ぎと見直しで使う |

### 形ごとの道

| 形 | 利用者が渡すもの | Studio がすること | 作る AI が `app/` で使う道 | 隔離との関係 | 順 |
|---|---|---|---|---|---|
| デザイントークン | W3C の Design Tokens の形の JSON(2025.10 が初めての安定版。https://www.designtokens.org/tr/2025.10/ 、告知: https://www.w3.org/community/design-tokens/2025/10/28/design-tokens-specification-reaches-first-stable-version/) | 形を検査し、CSS の変数に変える。色の役割(地、字、押せる所、失敗)が足りなければ聞く。変換は Style Dictionary(Apache-2.0。DTCG の形を扱うが、2025.10 の全部にはまだ対応していないと書いてある: https://styledictionary.com/info/dtcg/)か、自前の小さな変換 | 変数だけを使う。値のまま書いた色は質の見直しで数える | ファイルの中身だけ。外への通信なし。一番易しい | 1 |
| 指針の文 | Markdown のファイル(デザインの決まり、文の決まり、アクセシビリティの決まり) | 大きさと秘密を検査し(今の `redact.js` の秘密の検査を使う)、`app/design/` に写す。要約を Studio の決まりに入れる | `app/design/` の文を読む | ファイルだけ | 2 |
| Storybook | 静的なビルドのフォルダー(`storybook-static` など)か、公開の URL | 部品の一覧を読む。静的なビルドには `index.json` があり(合成の機能の前提: https://storybook.js.org/docs/sharing/storybook-composition)、`/manifests/components.json` もある(プレビューで、公開の API ではないと書いてある: https://storybook.js.org/docs/ai/manifests)。部品の名前、使い方の文、見本の引数を `app/design/components.md` にする | 部品の一覧と使い方を読む。部品のコードそのものは、静的なビルドからは import できない。使うには下の npm のパッケージの道が要る | フォルダーなら外への通信なし。URL なら Studio のサーバーが外へ読みに行く。今の Studio は Claude Code 以外の外に出ないので、新しい外への呼び出しになる。同意と送り先の表示が要る。フォルダーを先にする | 3 |
| Storybook の MCP(`@storybook/addon-mcp`) | 利用者の Storybook の開発サーバー(`http://localhost:6006/mcp`)。プレビュー(https://storybook.js.org/docs/ai/mcp/overview) | 使わない(今は) | なし | 作る AI の MCP は Studio の観察の道具だけ。利用者の開発サーバーを動かすと、利用者のコードが PC で動く(ADR 0001 の T2)。同じ役は、Studio の持つ「素材の道具」の MCP サーバー(観察の道具と同じ形)で、写した一覧から答えればできる | 後 |
| npm のパッケージ(自分の部品) | パッケージのファイル(`npm pack` で作った tgz)か、フォルダー | 展開するだけで、スクリプトは動かさない。ライセンスの欄、依存の数、外への URL(字の CDN など)、大きさを検査する。試作品ごとに import を許す一覧に足す | 許された名前で import する | 部品のコードは、試作品の `sandbox` の iframe の中だけで動く。外へ通信できない。ビルド(esbuild)はコードを動かさない。ADR 0001 の「同梱するライブラリだけ」を「同梱するものと、検査して許したもの」に直す | 4 |
| Figma | 変数を書き出した JSON(トークンの道へ)、画面の絵(PNG) | トークンの道に乗せる。絵は見本として `app/design/` に置く | 見本の絵を見る(作る AI が絵を読めるかは、作る AI の道具しだい。未確認) | Studio は Figma を呼ばない。Figma の MCP サーバー(https://developers.figma.com/docs/figma-mcp-server/)は、リモートは外への通信と Figma のログインが要る。デスクトップは有料のプランの Dev か Full の席が要る。変数の REST API は Enterprise の Full の席が要る(https://developers.figma.com/docs/rest-api/variables/)。多くの利用者には、書き出しの道が現実的 | 5 |

Figma の変数を W3C の形で書き出す道具(プラグインなど)があるかは、確かめていない(不明)。J4 で確かめる。

## 5. 取り込みを案内する流れ

### 4 歩

| 歩 | 聞くこと、すること | 確かめること | うまくいかないとき |
|---|---|---|---|
| 1. 聞く | 何を持っているか(なし、トークン、指針の文、Storybook、npm のパッケージ、Figma)。誰の素材か。使ってよいか(ライセンス、社内の許可) | 答えから、4 節のどの道かを決める | 「なし」なら既定の素材を勧める。分からないときは、デザイナーに聞く問いの文を出す |
| 2. 確かめる | ファイルかフォルダーを選んでもらう | 形、足りないもの(色の役割、字、間隔)、ライセンスの欄、外への URL、秘密らしい文字列、大きさ | 何が足りないかと、既定の素材で補うかを聞く。ライセンスが分からないときは「有効にする」を押せない |
| 3. 見本で試す | 見本の画面(ボタン、入力、カード、会話の枠、失敗の表示)を、新しい素材と今の素材で並べて描く | 字と地の差、外への通信がないこと、崩れ | 崩れた所を指し、直し方(足りないトークンなど)を 1 文で出す |
| 4. 有効にする | この試作品だけか、これからの試作品全部か | 有効にした素材の出典とライセンスの一覧 | 前の素材にいつでも戻せる(版と同じ考え) |

有効にした後は、作る AI への依頼に指針の要約が入り、質の見直し(J6)が「素材に合っているか」を数えます。

### Replica と比べる

GitHub の Replica は、GitHub Design が作った、AI で試作品を作る道具です(MIT。https://github.com/github/replica)。GitHub Copilot のアプリの中で動きます。Studio と同じく、デザインシステムの指針を入れて試作品を作ります。

| 点 | Replica | Studio(この案) |
|---|---|---|
| 誰が素材を入れるか | チームが、`/setup-skills` で「承認された出典」(製品の文書、デザインシステムの文書、部品やトークンのパッケージ)を渡す。Copilot が出典を見て、試作品を作る指示を下書きする(https://github.com/github/replica/blob/main/docs/local-prototyping.md) | 利用者本人かデザイナーが、取り込みの案内で渡す。検査は Studio が決まった手順で行い、AI に任せない |
| 指針の置き場所 | リポジトリのファイル。見本(starters/coreai)では `.agents/context/` に `DESIGN-SYSTEM.md`、`ACCESSIBILITY.md`、`BROWSER-VALIDATION.md` など、`.agents/skills/` に部品ごとの skill がある | `app/design/` の写しと、Studio が持つ素材。写しが変わっていないかを関門で確かめる |
| 部品のパッケージ | Copilot がパッケージを入れる前に許可を聞く | 作る AI はパッケージを入れられない。Studio が検査して、import を許す |
| 既定の素材 | 見本が 2 つ。Minimal(自分のデザインシステムに合わせる小さな例)と CoreAI Sandbox(できあいの配置と部品。skill の名前から Fluent UI React を使う) | Radix Themes(おすすめ)と、選べる Material 3 |
| 隔離 | 確かめていない(不明) | ADR 0001 のまま。試作品は外へ通信しない |
| 質の確かめ | ブラウザで確かめる指針のファイルがある。中身は読んでいない(不明) | 関門、観察器、質の見直し(J6)で数を出す |

Replica から学ぶこと:

- 指針をファイルにして、作る AI が毎回読む形。Studio の `app/design/` と同じ考え
- 素材を入れる人(デザイナー)と、それで作る人を分ける形。Studio でも、素材を「これからの試作品全部」に有効にすれば同じになる

Studio が違えること:

- 素材の検査とライセンスの確かめを、AI ではなく決まった手順で行う(原則 7)
- 素材に合っているかを、見直しで数として出す(原則 4)
- 素材より前に、目的の聞き出しと設計の案内がある(原則 1)

## 6. 決めていないこと、確かめていないこと

- 既定の素材をどれにするか: 運営者が決める。おすすめは 3 節
- Material 3 の指針の文のライセンス: 未確認。確かめるまでは写さない
- SF Pro と SF Symbols の契約の全文: 未確認。どちらにしても同梱しない
- 同梱の大きさと、ビルドの時間: 測っていない。J3 で測る
- 今のビルドが、パッケージの CSS(Radix Themes の CSS など)を import できるか: 確かめていない。J3 で確かめる
- React 19 での Material Web の動き: Studio では確かめていない
- アクセシビリティの検査の道具と、そのライセンス: 選んでいない。J6 で確かめる
- Storybook の URL を読むための、Studio の新しい外への呼び出し: 入れるかを決めていない。入れるなら同意と送り先の表示を、今の本物の AI の同意と同じ形で作る
