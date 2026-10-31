<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/brand/banner-dark.svg">
  <img alt="agent-prototype-studio のバナー。左に 1 文「AI エージェントの試作品を、作る前に、構成ごと手元で試して測る。」と英語の同じ文。右にトークの画面、模擬のエージェント、プロンプトの枠、ツール(MCP)、ガードレール、記録の 6 つの層が縦に並び、ガードレールに「止めた」の印が付いている" src="assets/brand/banner-light.svg">
</picture>

# agent-prototype-studio

**AI エージェントの試作品を、作る前に、構成ごと手元で試して測る。**

<picture>
  <source media="(prefers-reduced-motion: reduce) and (prefers-color-scheme: dark)" srcset="assets/media/sim-trace-dark.png">
  <source media="(prefers-reduced-motion: reduce)" srcset="assets/media/sim-trace-light.png">
  <source type="image/avif" srcset="assets/media/talk-guard.avif">
  <img alt="架空のバイト探しの試作品で「みなと町でバイトを探しています」と送ると、案内役が求人のカードを出す。「そのまま保存して」と送ると「記録「consent」がありません」と返る。右の記録の画面で、ツール save_wish の呼び出しと、ツールの守り requires が保存を止めたところが赤い字で出る" src="assets/media/talk-guard.gif">
</picture>

社内の企画担当など、エンジニアでない人のためのローカルのツールです。
構成とは、誰が会話を回し、誰がどのツールを持ち、守りをどこに置くかです。その構成で、会話、ツールの呼び方、守りがどう効くかが分かります。
言葉で画面の試作品を作る道具(GitHub の Replica など)とは、試作品の中の AI とエージェントの構成を模擬して測れる点が違います。

## しくみ

```mermaid
flowchart LR
    you(["利用者"]) -- "言葉で直す欄に頼む" --> maker["作る AI<br/>Claude Code / 偽接続"]
    maker -- "app/ を書き換える" --> app[("試作品 app/<br/>画面、構成、ツール、場面")]
    app -- "ビルドして iframe に出す" --> try["試す画面"]
    you -- "話す、ボタンを押す" --> try
    try --> comp{{"構成 composition.json<br/>回し手、参加者、守り"}}
    evals["場面の回し<br/>npm run evals"] -- "場面を構成 × 前提で流す" --> comp
    comp -- "harness" --> pai["プロダクト内 AI<br/>モック / Claude Code"]
    comp -- "agent" --> sim["模擬のエージェント<br/>モック / Claude Code"]
    sim -- "MCP(決まった名前だけ)" --> tools["ツールの MCP サーバー<br/>ツールの守り"]
    comp --> trace[("AI の実行の記録<br/>比べる表 report.md")]
```

- AI は 2 種類あります。作る AI は試作品のファイル(`app/`)を変えます。プロダクト内 AI は試作品の中で話し、構成を書いた試作品では参加者(模擬のエージェント、harness、人)の組になります
- 構成はデータです。`app/composition.json` に回し手と参加者と守りを、`app/tools.json` にツールを書きます。Studio のコード(ツールの口)が、ツールの守りを必ず効かせます([agent-simulation.md](docs/design/agent-simulation.md))
- 既定は料金なしです。プロダクト内 AI と場面の回しはモックで動きます。実モデルは、画面で同意したときと、`--real` に費用の上限を付けたときだけです。試作品は `sandbox` の iframe で動き、作る AI が書けるのは `app/` だけです([ADR 0001](docs/adr/0001-local-runtime-and-isolation.md))

## 特長

<table>
  <tr>
    <td width="50%" valign="top">
      <a href="docs/usage.md#ai-の振る舞いを言葉で直す架空の求人相談"><picture><source media="(prefers-color-scheme: dark)" srcset="assets/media/try-and-fix-dark.png"><img width="400" alt="左の試す画面で、架空のバイト探しの会話が進んでいる。「そのまま保存して」に「記録「consent」がありません」と返っている。右の言葉で直す欄の依頼に「保存する前に、保存してよいかを必ず聞くようにして」と書いてある" src="assets/media/try-and-fix-light.png"></picture></a><br>
      <b>言葉で直す欄</b><br>
      試す画面で話しながら、直したいことを右の欄に言葉で頼む。
    </td>
    <td width="50%" valign="top">
      <a href="docs/usage.md#構成と前提を選ぶ"><picture><source media="(prefers-color-scheme: dark)" srcset="assets/media/sim-choice-dark.png"><img width="400" alt="その他の引き出しの「構成と前提」。構成を選ぶ欄に、相手の会社のエージェントとこちらのツール、自社の harness だけ、受付と相談役と担当者の引き継ぎ、ツールだけを出す構成の 4 つ。前提を選ぶ欄に、カードを使える相手と、文とボタンだけの相手の 2 つ" src="assets/media/sim-choice-light.png"></picture></a><br>
      <b>構成の模擬</b><br>
      構成と前提を選ぶと、同じ試作品が別の組み方で話す。
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <a href="docs/usage.md#ai-の実行の記録を見る"><picture><source media="(prefers-color-scheme: dark)" srcset="assets/media/sim-trace-dark.png"><img width="400" alt="AI の実行の記録。模擬の案内役のプロンプトの部品、ツール save_wish の引数と失敗の結果、ツールの守り schema は通した、requires は止めたと理由が赤い字で並ぶ。最後に出口の確かめ 2 つが通した" src="assets/media/sim-trace-light.png"></picture></a><br>
      <b>守りの層</b><br>
      どの層の守りが止めたかと、その理由が記録に出る。
    </td>
    <td width="50%" valign="top">
      <a href="docs/usage.md#場面を回すnpm-run-evals"><picture><source media="(prefers-color-scheme: dark)" srcset="assets/media/evals-compare-dark.png"><img width="400" alt="場面を回した比べる表。構成と前提の組 4 行に、接続(モック)、場面の数、確かめの合格、自然さ、ツールの再現率、誤った呼び出し、ツールが止めた数、止まらなかった数、費用 0 ドルが並ぶ" src="assets/media/evals-compare-light.png"></picture></a><br>
      <b>場面の比較</b><br>
      場面を構成と前提ごとに回し、1 つの表で比べる(<code>npm run evals</code>)。
    </td>
  </tr>
</table>

どの画像も、Studio が自分で撮ったものです(`npm run media`。撮り方は [CONTRIBUTING.md](CONTRIBUTING.md#画像と動く画像を撮り直す))。

- **言葉で直す**: 画面も AI の振る舞いも「言葉で直す」欄で変え、同じ発言で試し直して前と後を比べられます
- **構成を模擬する**: 構成 A(相手の会社のエージェントがこちらのツールを呼ぶ)、B(自社の harness が回す)、C(受付から相談役と担当者へ引き継ぐ)を、同じ試作品で選んで話せます
- **場面の一覧で比べる**: `app/evals/` の場面を構成 × 前提 × 接続で回し、ツールの呼び方、守り、費用、待ち時間を 1 つの表で比べます([実機の例](docs/evidence/sim-compare/README.md))
- **守りの層が記録で分かる**: ツールの守り(必ず効く)、プロンプトの頼み(相手しだい)、出口の確かめのどれが効いたかが、記録と場面の結果に出ます
- **データだけで流用できる**: 新しい構成とツールは `app/` のデータで足します。構成 C と C2 は、Studio のコードを変えずに足しました
- **モックと実モデル**: 同じ試作品のまま、モックと Claude Code を切り替えられます。モックはいつも同じ応答を返します
- **版と引き継ぎ**: 版を保存していつでも戻せます。ソース、AI の設定、構成、場面の回しの要約を、1 つのフォルダーに書き出します

## はじめる

要るもの: Node.js 22 以上(`node --version` で確かめる)。言葉で直すには、Claude Code 2.1.248 以上とログインが要ります([docs/claude-code.md](docs/claude-code.md))。なくても、試す、場面の回し、保存、本番開発へ渡すは使えます。

```sh
npm install                # 初回だけ
npm run install:chromium   # 初回だけ。直した試作品を自動で確かめるブラウザー(Playwright の Chromium、約 200 MB)を入れる
npm start                  # 既定のブラウザで Studio が開く
```

入れるブラウザーは、Studio が試作品を開いて確かめるためだけに使います。利用者の Chrome や Edge は使いません。入れていないと、結果の帯に「自動の確かめができませんでした」と出ます([docs/troubleshooting.md](docs/troubleshooting.md))。

ブラウザが開かないときは、ターミナルに出た `http://127.0.0.1:4317/#token=…` を開きます。止めるときは Ctrl+C です。

Claude Code が見つからない、古い、ログインしていないときは、右の「言葉で直す」に理由と手順のカードが出ます([画面](docs/evidence/ux/final/U10-07-unavailable.png))。Claude Code を入れてログインし、Studio を起動し直してください。

本物の AI(Claude Code)を使う前に、Studio は「本物の AI を使う前に」のカードで、送るもの、送り先、料金を見せます。同意すると、頼んだ文や試作品のファイルが Anthropic に送られ、料金がかかります。先に [docs/claude-code.md](docs/claude-code.md) の「先に確かめること」を読んでください。

## 使い方

開くと、はじめの画面が出ます。作りたいものを 1 文で書くと、Studio が問いを 1 つずつ返し、目的の文書(誰、何の問題、場面、成功の印、しないこと、決めていないこと)を作ります。決めるのは「これで決める」を押したときです。詳しくは [docs/usage.md の「目的を聞き出す」](docs/usage.md#目的を聞き出すはじめの画面)にあります。サンプルを試すときは、何も書かずに「飛ばす」を押します。

ヒアリングで使うときは、上の帯の「ヒアリングの整理」を開きます。打った要点を AI が 5 つの欄に振り分け、決める人が確かめます。詳しくは [docs/usage.md の「ヒアリングを整理する」](docs/usage.md#ヒアリングを整理する聞き取りの欄と整理の板)にあります。

サンプルの最初の 1 分は 2 つあります。どちらも `npm start` のまま、お試しの AI で料金なしに試せます。費用がかかるのは、カードで同意して本物の AI を使ったときだけです。画面の全体は [docs/usage.md の「画面の見方」](docs/usage.md#画面の見方)にあります。

![最初の画面。上に 1 行の説明と 3 つの手順、左に「試す」、右に「言葉で直す」](docs/evidence/ux/final/U10-01-first.png)

**(a) 試作品を試して、言葉で直す**

「飛ばす」の後は、上の帯の「試作品: … ▾」で「求人相談(架空・AI と話せる)」が選ばれています。その下の案内の 3 つの手順(1 試す → 2 言葉で直す → 3 直った結果を試す)のとおりに進めます。

1. 試す: 左の「試す」の試作品の欄に `カフェで働きたいです` と書いて送る。案内役が返事をし、試作品の右の「希望条件」に、AI が理解した条件が出る。案内は 2 番に進む([画面](docs/evidence/ux/final/U10-02-talked.png))
2. 言葉で直す: 右の「言葉で直す」の例「時給の下限を先に聞くようにして」を押して「送る」を押す。初めてのときは「本物の AI を使う前に」のカードが出る。「同意して使う」で直す AI が直し始める([カード](docs/evidence/ux/final/U10-03-consent.png)、[作業中](docs/evidence/ux/final/U10-04-fixing.png))
3. 終わると、依頼の下に結果の帯(「確かめました。問題は見つかりませんでした」など)が出る。試作品の上には「AI の設定が変わりました」の帯が出て、案内は 3 番に進む([画面](docs/evidence/ux/final/U10-05-fixed.png))
4. 直った結果を試す: 「同じ発言で試し直す」を押す。「直す前と後の返事」に、同じ発言への前と後の返事が並ぶ([画面](docs/evidence/ux/final/U10-06-retried.png))
5. 良い状態になったら、上の帯の「保存」を押す

直しきれなかったときは、結果の帯に「直す AI が直しきれませんでした」と、何がうまくいかないかが出ます([直せたとき](docs/evidence/ux/final/U10-09-band-fixed.png)、[直しきれなかったとき](docs/evidence/ux/final/U10-10-band-failed.png))。料金なしで言葉で直す流れを試すときは、`STUDIO_AGENT=fake npm start` で起動します。直す AI が偽接続になり、決まった依頼にだけ反応します。依頼は「その他」→「開発者向けの詳細」の「試験用の依頼」にあります([docs/usage.md の「手順」](docs/usage.md#手順))。

**(b) 構成 A を試して、場面を回す**

1. 上の帯の「試作品: … ▾」から「バイト探し(架空・AI と話せる)」を選ぶ。相手の会社のエージェント(模擬)がトークを回す構成 A で、お試しの AI が答える
2. 試作品の中の「みなと町でバイトを探しています」を押す。案内役がツール `search_jobs` で探し、カードの一覧が出る([画面](docs/evidence/ux/final/U10-11-talk-cards.png))
3. `そのまま保存して` と送る。同意の前なので、ツールの守り(`requires`)が保存を止め、「記録「consent」がありません」と返る([画面](docs/evidence/ux/final/U10-12-talk-guard.png))
4. 上の帯の「その他」→「開発者向けの詳細」の「AI の実行の記録」で、「模擬の会話の中身: 参加者、ツール、守り(開発向け)」を開く。ツールの呼び出しと、どの守りが止めたかが出る([画面](docs/evidence/ux/final/U10-13-dev-record.png))
5. 別のターミナルで、場面の一覧(44 本)をお試しの AI で回す。結果の `report.md` の場所が出る

```sh
npm run evals -- sample-part-time
npm run evals -- sample-part-time --composition composition.json,compositions/b.json,compositions/c.json   # 構成 A、B、C を比べる
```

`sample-part-time` は、Studio を一度起動するとデータの置き場に写されます。構成と前提の選び方と、結果の読み方は [docs/usage.md の「トーク風の画面で試す」](docs/usage.md#トーク風の画面で試す架空のバイト探し)と[「場面を回す」](docs/usage.md#場面を回すnpm-run-evals)にあります。

サンプルは 4 つあります。一覧の順に並べました。

| サンプル(一覧の名前) | 試せること |
|---|---|
| 求人相談(架空・AI と話せる) | 試作品の中の AI と話し、AI が理解した希望条件を確かめて直す。最初に開く |
| 学習相談(架空・AI と話せる) | 求人ではない題材で、同じ仕組みを使う |
| バイト探し(架空・AI と話せる) | 相手の会社のエージェント(模擬)がトークを回し、こちらのツールを呼ぶ形を、トーク風の画面で試す。構成 A、B、C と場面 44 本がある |
| 図書室(架空・AI なし) | 本を探す、借りる、登録する画面。直す AI で画面を変える |

保存した状態への戻し方、本番開発への引き継ぎ、実行の記録は [docs/usage.md](docs/usage.md) にあります。試作品を自動で確かめるときは、上の帯の「その他」の「試作品を自動で確かめる」を押します([docs/usage.md の「試作品を自動で確かめる」](docs/usage.md#試作品を自動で確かめる画面の確かめる))。

## ドキュメント

| はじめる・使う | 設定、記録、困ったとき | 仕組みと決定 | 開発する |
|---|---|---|---|
| [usage.md](docs/usage.md) 使い方の全部 | [configuration.md](docs/configuration.md) 環境変数、`app/prototype.json`、`app/ai.json`、`app/composition.json`、データの置き場 | [architecture/hld.md](docs/architecture/hld.md) 部品とデータの流れ | [AGENTS.md](AGENTS.md) エージェント向けの入口 |
| [claude-code.md](docs/claude-code.md) 実モデル(Claude Code)を使う | [troubleshooting.md](docs/troubleshooting.md) うまくいかないとき | [prd.md](docs/prd.md) 何を作るか | [CONTRIBUTING.md](CONTRIBUTING.md) 書き方、置き場所、テスト |
| [handoff.md](docs/handoff.md) 引き継ぎの形(形式 3、仮) | [evidence/sim-a](docs/evidence/sim-a/README.md) 構成 A を実モデルで 1 回通した記録 | [design/agent-simulation.md](docs/design/agent-simulation.md) エージェントの構成を模擬して効果を見る基盤の設計(案) | |
| | [evidence/sim-compare](docs/evidence/sim-compare/README.md) 場面の一覧を構成ごとに実モデルで回して比べた記録 | [ADR 0001](docs/adr/0001-local-runtime-and-isolation.md) ローカル実行と隔離の方式(仮採用) | |
| | [evidence/](docs/evidence/) ほかの実機の記録 | [ADR 0003](docs/adr/0003-agent-simulation.md) エージェントの構成を模擬する基盤(案) | |
| | | [design/ux-redesign.md](docs/design/ux-redesign.md) 初見で分かる画面の設計(設計。実装は別のカード) | [brand.md](docs/brand.md) 伝え方(1 文、名前、機能の文、見た目) |

## 開発

```sh
npm test            # 単体と結合のテスト(1 分ほど)
npm run test:e2e    # ブラウザの E2E(Playwright、全体でおよそ 3 分半)
npm run site        # LP(site/)を手元で開く。公開はしていない(site/README.md)
```

どのテストも実モデルと外部の API を呼びません。テストの中身とコードの構成は [CONTRIBUTING.md](CONTRIBUTING.md) にあります。エージェントで作業するときは [AGENTS.md](AGENTS.md) を読んでください。
