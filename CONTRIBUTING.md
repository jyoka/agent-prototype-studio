# CONTRIBUTING

agent-prototype-studio で作業する人への決まりです。エージェント向けの入口は [AGENTS.md](AGENTS.md) です。

## PR の決まり

- `main` からブランチを切り、1 つの PR は 1 つの関心ごとにします
- 本文には、何を、なぜ変えたか、どう確かめたか(コマンドと結果)、確かめていないことを書きます
- 使い方が変わる変更は、同じ PR で README と関係する docs も直します。部品や流れが変わるなら
  [docs/architecture/hld.md](docs/architecture/hld.md) も直します

## 書き方

README と `docs/` は日本語です。読むのは、Studio を使う人と、このリポジトリで作業するエージェントです。

- 結論を先に書きます。前置きは書きません
- 1 文は短くします(目安は 40 字)
- 同じものには、毎回同じ語を使います。途中で言い換えません(作る AI、プロダクト内 AI、試作品、版、偽接続、モックなど)
- 3 つ以上の並び、手順、比較は、箇条書きか表にします
- ハイフンは半角の `-` を使います。em ダッシュや en ダッシュは使いません
- コマンド、ファイル名、環境変数は `` ` `` で囲みます
- 確かめていないことは、確かめていないと書きます
- 使い方が変わる変更は、同じ PR で README と関係する docs も直します

コメント、画面とターミナルの文も日本語です。名前(変数、関数)は英語です。周りのコードの書き方に合わせてください。

## README の構成

README は、初めて来た人が最初の画面で「何か」「なぜ使うか」「どう始めるか」をつかむためのページです。
詳しいことは docs に置き、README からリンクします。150 行前後、多くても 180 行に収めます。

| 順 | 見出し | 中身 |
|---|---|---|
| 1 | `# agent-prototype-studio` | 見出しの上にバナー(`assets/brand/`、ダークとライト)。見出しの下に太字の一言の説明、動く画像(`assets/media/`)、何をするものか 2〜3 行 |
| 2 | `## しくみ` | Mermaid の図 1 枚と箇条書き 3 つ |
| 3 | `## 特長` | 画面 4 枚の 2 列の表(画像は docs の該当の節へのリンク)と、1 行ずつ 7 つまで |
| 4 | `## はじめる` | 要るもの、コマンド 3 つ前後、実モデルを使う前に読むものへの案内 |
| 5 | `## 使い方` | 最初の 1 分の流れとサンプルの表。詳しくは docs/usage.md |
| 6 | `## ドキュメント` | docs への案内の表 |
| 7 | `## 開発` | テストのコマンドと AGENTS.md への案内 |

画像には、絵の中身が分かる alt を付けます。動く画像は、`prefers-reduced-motion` のときは止まった画像に替えます(`<picture>` の `media`)。

新しい見出しを足したくなったら、まず docs のどこかに置けないかを考えます。

## 置き場所

| 内容 | 場所 |
|---|---|
| 何ができるか、始め方、最初の 1 分 | [README.md](README.md) |
| 何のためにあるか(目的、原則、しないこと、調子と声) | [docs/vision.md](docs/vision.md) |
| 何を作るか | [docs/prd.md](docs/prd.md) |
| 使い方の全部(モックと話す、振る舞いを直す、別の題材、実行の記録、版、引き継ぎ、ターミナルで観察する、画面の見方) | [docs/usage.md](docs/usage.md) |
| 実モデル(Claude Code)を使う(プロダクト内 AI、作る AI、実機で確かめる) | [docs/claude-code.md](docs/claude-code.md) |
| 環境変数、`app/ai.json`、データの置き場 | [docs/configuration.md](docs/configuration.md) |
| うまくいかないとき | [docs/troubleshooting.md](docs/troubleshooting.md) |
| 引き継ぎの書き出しの形 | [docs/handoff.md](docs/handoff.md) |
| 部品とデータの流れ | [docs/architecture/hld.md](docs/architecture/hld.md) |
| 1 つの決定とその理由 | [docs/adr/](docs/adr/) |
| 機能ごとの設計 | [docs/design/](docs/design/) |
| 伝え方(1 文、名前、機能の文、見た目、公開の前に直すもの) | [docs/brand.md](docs/brand.md)、[assets/brand/](assets/brand/) |
| README と LP の画像と動く画像(`npm run media` で撮る) | [assets/media/](assets/media/)。撮り方は下の「画像と動く画像を撮り直す」 |
| LP(1 ページ。公開しない。`npm run site` で開く) | [site/](site/README.md)。公開の手順も site/README.md |

関数、ファイルの形式、守る約束を書く `docs/architecture/lld.md` は、harness の作り直し(#293)の後で作ります。

## リポジトリの中身

```
AGENTS.md              エージェント向けの入口(CLAUDE.md はこれを読み込むだけ)
bin/studio.js          起動。失敗したときの案内もここで出す
src/server/            Studio のサーバー(画面と API、プレビューの配信、ビルド、app/ の検査、作る AI の起動、版の保存と復元)
src/server/product-ai/ プロダクト内 AI。ai.json の検査、モックと Claude Code の接続、プロジェクトごとの会話と状態、実行の記録
src/server/redact.js   記録と表示の前に、秘密らしい文字列と個人のデータを伏せる。書き出す前に秘密を探す
src/server/handoff.js  本番開発への引き継ぎの書き出し(docs/handoff.md)
src/observer/          観察器。表示中のビルドを Playwright の Chromium で開き、7 つの操作でシナリオを回し、エラー、スクリーンショット、合否を report で返す
src/agent/             偽接続(Claude Code の代わりに、決まった動きをする CLI)
scripts/               実機の Claude Code で守りを確かめるスクリプト
scripts/media/         npm run media。README と LP の画像と動く画像を撮る(撮る場面は test/e2e/scenes.js)
scripts/site.js        npm run site。LP(site/)を 127.0.0.1 で配る
site/                  LP(index.html、site.css、site.js、llms.txt)。公開しない
src/ui/                Studio の画面と、観察用の親ページ(observe.html、observe.js)
src/runtime/runtime.js 試作品に配る runtime。試作品のエラーを Studio の画面に知らせ、window.studio.ai を配る
samples/library/app/   固定のサンプル試作品(架空の図書室)
samples/job-consult/app/ 固定のサンプル試作品(架空の求人相談とモックの AI)
samples/study-consult/app/ 固定のサンプル試作品(架空の学習相談とモックの AI。求人ではない題材で汎用性を確かめる)
test/                  unit、integration、e2e。fixtures/ に偽の Claude Code と、観察器の見本(fixtures/observe/)
docs/                  使い方、設定、困ったとき、設計(architecture、adr、design)、伝え方(brand.md)
assets/brand/          見た目の決まり(tokens.css)とバナー(banner-dark.svg、banner-light.svg)
assets/media/          npm run media が撮った画像と動く画像(手で直さない)
```

隔離の方式は ADR-0001 に従う。Studio の画面は `127.0.0.1:4317`、試作品は別ポートの `localhost:4318` から、`sandbox` 属性つきの iframe と CSP で開く。

## テスト

| コマンド | 中身 | 時間の目安 |
|---|---|---|
| `npm test` | 単体と結合のテスト(Node の test runner)。作る欄の API、偽の CLI に渡る引数と stdin、確認スクリプトの空回しを含む | 1 分ほど |
| `npm run test:e2e` | ブラウザの E2E(Playwright の Chromium)。起動手順、サンプルの操作、モックの AI との会話と修正とリセット、偽の Claude Code への切り替えと履歴と失敗と中断、AI の実行の記録(正常と失敗、次にすること、伏せる文字列)、失敗の表示、試作品の隔離、作る欄の依頼・変更・反映・拒否・失敗・中断、作る欄で AI の振る舞いを変えて前の発言で試し直すこと、版の保存・変更・復元・起動し直した後の再開、引き継ぎの書き出しと、別の場所での確認(資料を読む、ソースを別の Studio で動かす)と秘密での停止、求人ではない題材(架空の学習相談)での作成・試行・変更・版・引き継ぎの通しと、Studio の画面と書き出しに求人の言葉が出ないこと、観察器の report(正常と、壊した見本のエラー、AI の要求の中継、7 つの操作とシナリオ、失敗した手順のスクリーンショット、見本のシナリオ)と、観察器の隔離(悪意のある見本、名前の解決、時間の上限)と、LP(`test/e2e/site.spec.js`。リンクの先、層のアニメ、動きを止める設定、スマホの幅、外への通信がないこと)を確かめる。「分かるか」の確かめの画面(U10)を `test-results/ux/` に撮る([docs/evidence/ux/final/](docs/evidence/ux/final/README.md)) | 全体でおよそ 3 分半(上限は 7 分) |

E2E と観察器のブラウザがないときは、`npm run install:chromium` で入れる。どのテストも実モデルと外部の API を呼ばない(`STUDIO_REAL=1` を付けた `test/e2e/real-loop.spec.js` だけが例外)。作る AI の既定は自動(手元の Claude Code を使う)なので、テストは `STUDIO_AGENT=fake`(偽接続、`src/agent/fake-claude.js`)か、偽の `claude`(`STUDIO_CLAUDE_BIN`)を必ず明示する。`STUDIO_AGENT` を消すテストは、`STUDIO_CLAUDE_BIN` を偽の `claude` か、ない場所に向ける。E2E の `launchStudio` は、指定がなければ `STUDIO_AGENT=fake` にする。プロダクト内 AI の Claude Code は、偽の CLI(`test/fixtures/fake-claude.js`)に差し替える。

- 不具合は、利用者から見た動きを再現する E2E を先に書き、失敗するのを見てから直します
- 実モデルで守りが効くかは、`npm run check:claude` で確かめます。実モデルを呼ぶので、人が決めたときだけ動かします([docs/claude-code.md の「実機で確かめる」](docs/claude-code.md#実機で確かめる))
- 場面を実モデルで回す `npm run evals -- <プロジェクト> --real`(`STUDIO_ALLOW_CLAUDE_CODE=1` と `--limit-usd` が要る)も、人が決めたときだけです。テストは偽の `claude` で回します([docs/usage.md の「場面を回す」](docs/usage.md#場面を回すnpm-run-evals))
- 実モデルで模擬のエージェントの起動が動くかは、`npm run check:sim -- --run --limit-usd <USD>` と `STUDIO_REAL=1 npx playwright test test/e2e/real-sim.spec.js` で確かめます。これも人が決めたときだけです。`npm run test:e2e` では、`real-sim.spec.js` は飛ばされます([docs/claude-code.md の「模擬のエージェントの起動を実機で確かめる」](docs/claude-code.md#模擬のエージェントの起動を実機で確かめる))
- 実モデルで閉じたループが回るかは、`npm run check:loop -- --real` と `STUDIO_REAL=1 npx playwright test test/e2e/real-loop.spec.js` で確かめます。これも人が決めたときだけです。`npm run test:e2e` では、`real-loop.spec.js` は飛ばされます([docs/claude-code.md の「閉じたループを実機で確かめる」](docs/claude-code.md#閉じたループを実機で確かめる))

## 画像と動く画像を撮り直す

README と LP に使う画像と動く画像は、Studio に自分で撮らせます。画面が変わったら、次の 1 回で撮り直します。

```sh
npm run media    # 40 秒ほど。assets/media/ を上書きする
```

- Studio は偽接続(`STUDIO_AGENT=fake`)で、試作品の中の AI はモックで動きます。実モデルは呼ばず、費用はかかりません
- 要るもの: E2E と同じ Chromium(`npm run install:chromium`)と、動く画像を書く `ffmpeg`(GIF、AV1(`libsvtav1` と AVIF)、VP9 を書けるもの。macOS は `brew install ffmpeg`)。`ffmpeg` は npm の依存ではありません。PATH にないときは `STUDIO_MEDIA_FFMPEG` で場所を指します。`ffmpeg` がなくても画像は撮れ、動く画像だけが失敗します
- 撮るのは見本「バイト探し(架空・AI と話せる)」です。文と会話は架空で、モックなので毎回同じです。記録の時刻(`15:04:05` など)と、かかった時間(`202 ミリ秒` など)だけは、撮るたびに変わります
- 撮った後に、画面とファイルを見て、変わり方がおかしくないかを確かめてからコミットします

撮るもの(ダークとライトは OS の設定を切り替えて撮ります):

| ファイル | 中身 | 大きさの上限 |
|---|---|---|
| `talk-guard.avif`、`talk-guard.gif`、`talk-guard.webm` | 動く画像(15 秒前後、ライト)。トークで探し、保存を頼み、記録の画面でツールの呼び出しと守りが止めたところまで。README は AVIF を出し、AVIF を出せないブラウザは GIF を出す。WebM は LP 用 | AVIF 2 MB、GIF 5 MB、WebM 2 MB |
| `try-and-fix-{light,dark}.png` | 試す画面と、言葉で直す欄(依頼を書いたところ) | 1 枚 1 MB |
| `sim-choice-{light,dark}.png` | その他 → 開発者向けの詳細の、構成と前提の選び方 | 1 枚 1 MB |
| `sim-trace-{light,dark}.png` | 模擬の会話の記録(ツール `save_wish` と、守り `requires` が止めたところ) | 1 枚 1 MB |
| `evals-compare-{light,dark}.png` | 場面を回した比べる表。見本の写しをモックで回し(`npm run evals`)、`scripts/sim-compare.js` で 1 つにした表。毎回変わる待ち時間の列は外す | 1 枚 1 MB |
| `layers/{1-talk,2-agent,3-prompt,4-tool,5-guard,6-record}-{light,dark}.png` | 分解の絵の素材。[docs/brand.md の 4 節](docs/brand.md#4-分解の絵の台本)の層の順。LP のカードが使うので、2 倍の細かさで撮る | 1 枚 512 KB |

写さないもの。撮るたびに確かめ、見つかったら失敗にします(`scripts/media/privacy.js`):

- 日付、作業ディレクトリ(ホーム、一時フォルダー、このリポジトリの場所)、メールアドレス、利用者の名前
- 画面の見える文字(Studio の画面と、試作品の iframe の中)を、撮る前に調べます。動く画像は、場面の区切りごとに調べます
- 書いたファイルの中身(メタデータ)に、今日の日付、上のパス、利用者の名前、git のメールアドレスがないことを調べます。`ffmpeg` には日時と版を書かせません(`-map_metadata -1` と `bitexact`)
- 偽接続のときだけ出る「開発用: 偽の直す AI」の印は、利用者の画面に出ないので、隠して撮ります

撮る場面(画面の操作)は `test/e2e/scenes.js` にまとめてあります。`npm run test:e2e` の `test/e2e/media.spec.js` が、画像を書かずに同じ場面を通すので、画面が変わって場面が通らなくなると E2E で分かります。画面のスクリーンショットを撮る E2E(P31)も、同じ場面はこの部品を使います。
