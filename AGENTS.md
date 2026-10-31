# AGENTS.md

このリポジトリ(agent-prototype-studio)で作業するエージェントへの案内です。人向けの決まりは [CONTRIBUTING.md](CONTRIBUTING.md)
にあり、ここはその入口です。食い違ったら CONTRIBUTING.md が正です。

## まず読むもの

| 知りたいこと | 読むもの |
|---|---|
| 何のためにあるか(目的、原則、調子) | [docs/vision.md](docs/vision.md)(2026-10-29 に決めた。2026-10-31 に中心を変える案を足した) |
| AI の作りを見せて、人が承認する | [docs/design/ai-architecture-review.md](docs/design/ai-architecture-review.md)、[ADR 0005](docs/adr/0005-ai-architecture-review.md)(案) |
| 何を作るか | [docs/prd.md](docs/prd.md)(最後の「PRD の後に決めたこと」が正) |
| 全体の部品とデータの流れ | [docs/architecture/hld.md](docs/architecture/hld.md) |
| なぜこの作りなのか(隔離、作る AI の起動) | [docs/adr/0001-local-runtime-and-isolation.md](docs/adr/0001-local-runtime-and-isolation.md) |
| これからの画面 | [docs/design/ux-redesign.md](docs/design/ux-redesign.md) |
| 利用者の流れと、これからのカード | [docs/design/user-journey.md](docs/design/user-journey.md)、[docs/design/design-materials.md](docs/design/design-materials.md)(案。決めたことは各文書の「決めたこと」) |
| ヒアリングの現場、同時に作ることとコメント | [docs/design/field-session.md](docs/design/field-session.md)、[docs/design/collaboration.md](docs/design/collaboration.md)、[ADR 0004](docs/adr/0004-shared-session-and-customer-data.md)(案。決めたことは各文書の「決めたこと」。ADR 0004 は段 1 を採用、段 2 は未決) |
| 使い方の全部 | [docs/usage.md](docs/usage.md)、[docs/claude-code.md](docs/claude-code.md) |

## 書き方

- コメント、画面とターミナルの文は日本語。名前(変数、関数)は英語。周りのコードに合わせる。Node.js 22 以上、ES modules
- README と docs は日本語。結論を先に、1 文は短く(目安 40 字)、同じものには同じ語。em ダッシュと en ダッシュは使わない。
  詳しくは [CONTRIBUTING.md の「書き方」](CONTRIBUTING.md#書き方)
- README の構成は決まっている([CONTRIBUTING.md の「README の構成」](CONTRIBUTING.md#readme-の構成))。
  詳しいことは README に足さず、docs に置いてリンクする
- 使い方が変わる変更は、同じ PR で README と関係する docs も直す。部品や流れが変わるなら hld.md も直す

## 確かめ方

```sh
npm test                                   # 単体と結合(1 分ほど)
node --test test/unit/<名前>.test.js       # 単体の 1 ファイルだけ(数秒)
node --test test/integration/<名前>.test.js  # 結合の 1 ファイルだけ(ブラウザを使うものは 1 分ほど)
npm run test:e2e                           # ブラウザの E2E(全体でおよそ 3 分半)
npx playwright test test/e2e/<名前>.spec.js  # E2E の一部だけ
```

作業中は、変えたところに関係するテストだけを動かす。画面や流れを変えたら、関係する E2E の spec だけを動かすのが基本。
E2E の全体は PR の前に 1 回回す。全体の上限は 7 分(`playwright.config.js` の `globalTimeout`)。
3 分を超えても、それだけで遅すぎるとは判断しない。上限で止まったときは、どの spec で止まったかを見てから直す。
`npm test` はファイルを並べて回す。全体の時間は、いちばん遅いファイル(make-loop と observe-mcp)で決まる。
1 つのテストだけなら `node --test --test-name-pattern="<名前の一部>" <ファイル>` で動かす。
不具合は、利用者から見た動きを再現する E2E を先に書いてから直す。

## してはいけないこと

- 実モデルを勝手に呼ばない。作る AI の既定は自動で、手元の Claude Code が使えれば実モデルを呼ぶ。
  `STUDIO_AGENT` を書かない起動、`STUDIO_AGENT=claude`、`npm run check:claude -- --run`、`npm run check:sim -- --run`、`npm run check:loop -- --real`、
  `npm run evals -- <プロジェクト> --real` は、
  人に頼まれたときだけ。自分で Studio を動かすときは `STUDIO_AGENT=fake` を付ける。
  本物の AI を使う前の同意(画面の「同意して送る」など、`POST /api/real-ai/consent`)を、人の代わりにしない
- テストは `STUDIO_AGENT=fake` か偽の `claude`(`STUDIO_CLAUDE_BIN`。偽の CLI は `test/fixtures/fake-claude.js`)を必ず明示する。
  `STUDIO_AGENT` を消すテストは、`STUDIO_CLAUDE_BIN` を偽の `claude` か、ない場所に向ける
- 実データ(本物の個人情報、社内のデータ)をサンプル、テスト、docs に入れない。架空のデータだけを使う
- ADR 0001 の守り(loopback だけ、トークン、`sandbox` の iframe と CSP、`app/` の外に書かせない)を弱めない
- 秘密の値(`.env`、API キー、Claude Code のログインの情報)を読まない、表示しない、コミットしない
