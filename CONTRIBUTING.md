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
| 1 | `# agent-prototype-studio` | 太字の一言の説明と、何をするものか 2〜3 行 |
| 2 | `## しくみ` | Mermaid の図 1 枚と箇条書き 3 つ |
| 3 | `## 特長` | 1 行ずつ、7 つまで |
| 4 | `## はじめる` | 要るもの、コマンド 3 つ前後、実モデルを使う前に読むものへの案内 |
| 5 | `## 使い方` | 最初の 1 分の流れとサンプルの表。詳しくは docs/usage.md |
| 6 | `## ドキュメント` | docs への案内の表 |
| 7 | `## 開発` | テストのコマンドと AGENTS.md への案内 |

新しい見出しを足したくなったら、まず docs のどこかに置けないかを考えます。

## 置き場所

| 内容 | 場所 |
|---|---|
| 何ができるか、始め方、最初の 1 分 | [README.md](README.md) |
| 何を作るか | [docs/prd.md](docs/prd.md) |
| 使い方の全部(モックと話す、振る舞いを直す、別の題材、実行の記録、版、引き継ぎ、画面の見方) | [docs/usage.md](docs/usage.md) |
| 実モデル(Claude Code)を使う(プロダクト内 AI、作る AI、実機で確かめる) | [docs/claude-code.md](docs/claude-code.md) |
| 環境変数、`app/ai.json`、データの置き場 | [docs/configuration.md](docs/configuration.md) |
| うまくいかないとき | [docs/troubleshooting.md](docs/troubleshooting.md) |
| 引き継ぎの書き出しの形 | [docs/handoff.md](docs/handoff.md) |
| 部品とデータの流れ | [docs/architecture/hld.md](docs/architecture/hld.md) |
| 1 つの決定とその理由 | [docs/adr/](docs/adr/) |
| 機能ごとの設計 | [docs/design/](docs/design/) |

関数、ファイルの形式、守る約束を書く `docs/architecture/lld.md` は、harness の作り直し(#293)の後で作ります。

## リポジトリの中身

```
AGENTS.md              エージェント向けの入口(CLAUDE.md はこれを読み込むだけ)
bin/studio.js          起動。失敗したときの案内もここで出す
src/server/            Studio のサーバー(画面と API、プレビューの配信、ビルド、app/ の検査、作る AI の起動、版の保存と復元)
src/server/product-ai/ プロダクト内 AI。ai.json の検査、モックと Claude Code の接続、プロジェクトごとの会話と状態、実行の記録
src/server/redact.js   記録と表示の前に、秘密らしい文字列と個人のデータを伏せる。書き出す前に秘密を探す
src/server/handoff.js  本番開発への引き継ぎの書き出し(docs/handoff.md)
src/observer/          観察器。表示中のビルドを Playwright の Chromium で開き、エラー、スクリーンショット、合否を report で返す
src/agent/             偽接続(Claude Code の代わりに、決まった動きをする CLI)
scripts/               実機の Claude Code で守りを確かめるスクリプト
src/ui/                Studio の画面と、観察用の親ページ(observe.html、observe.js)
src/runtime/runtime.js 試作品に配る runtime。試作品のエラーを Studio の画面に知らせ、window.studio.ai を配る
samples/library/app/   固定のサンプル試作品(架空の図書室)
samples/job-consult/app/ 固定のサンプル試作品(架空の求人相談とモックの AI)
samples/study-consult/app/ 固定のサンプル試作品(架空の学習相談とモックの AI。求人ではない題材で汎用性を確かめる)
test/                  unit、integration、e2e。fixtures/ に偽の Claude Code と、観察器の見本(fixtures/observe/)
docs/                  使い方、設定、困ったとき、設計(architecture、adr、design)
```

隔離の方式は ADR-0001 に従う。Studio の画面は `127.0.0.1:4317`、試作品は別ポートの `localhost:4318` から、`sandbox` 属性つきの iframe と CSP で開く。

## テスト

| コマンド | 中身 | 時間の目安 |
|---|---|---|
| `npm test` | 単体と結合のテスト(Node の test runner)。作る欄の API、偽の CLI に渡る引数と stdin、確認スクリプトの空回しを含む | 数秒 |
| `npm run test:e2e` | ブラウザの E2E(Playwright の Chromium)。起動手順、サンプルの操作、モックの AI との会話と修正とリセット、偽の Claude Code への切り替えと履歴と失敗と中断、AI の実行の記録(正常と失敗、次にすること、伏せる文字列)、失敗の表示、試作品の隔離、作る欄の依頼・変更・反映・拒否・失敗・中断、作る欄で AI の振る舞いを変えて前の発言で試し直すこと、版の保存・変更・復元・起動し直した後の再開、引き継ぎの書き出しと、別の場所での確認(資料を読む、ソースを別の Studio で動かす)と秘密での停止、求人ではない題材(架空の学習相談)での作成・試行・変更・版・引き継ぎの通しと、Studio の画面と書き出しに求人の言葉が出ないこと、観察器の report(正常と、壊した見本のエラー、AI の要求の中継)と、観察器の隔離(悪意のある見本、名前の解決、時間の上限)を確かめる | 1 分以内 |

E2E と観察器のブラウザがないときは、`npm run install:chromium` で入れる。どのテストも実モデルと外部の API を呼ばない。作る AI は偽接続(`src/agent/fake-claude.js`)か、それを呼ぶ偽の `claude` に差し替える。プロダクト内 AI の Claude Code は、偽の CLI(`test/fixtures/fake-claude.js`)に差し替える。

- 不具合は、利用者から見た動きを再現する E2E を先に書き、失敗するのを見てから直します
- 実モデルで守りが効くかは、`npm run check:claude` で確かめます。実モデルを呼ぶので、人が決めたときだけ動かします([docs/claude-code.md の「実機で確かめる」](docs/claude-code.md#実機で確かめる))
