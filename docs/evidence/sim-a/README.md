# sim-7 の実機: 構成 A を実モデルで 1 回通す

見本「バイト探し(架空・AI と話せる)」の構成 A を、本人のログインの Claude Code で動かした記録です。2026-10-29 に取りました。

- Claude Code 2.1.312、本人のログイン(claude.ai)。前提は `partner-a`(代わりのモデル `claude-sonnet-5-5`)
- データと相手の仕様は、どれも架空
- 記録は伏せた形です。メールアドレスなどは `src/server/redact.js` で伏せ、一時フォルダーのパスは `<作業の場所>` と `<プロジェクト>` に置き換えました
- 費用は Claude Code が返した `total_cost_usd` です。サブスクの枠で動いたので、請求の額ではなく目安です

## 使った額と待ち時間

| 何をしたか | 起動 | 費用(USD) | 待ち時間 |
|---|---|---|---|
| `npm run check:sim -- --run --limit-usd 0.6`(1 回目) | 3 | 0.0569 | 4.7〜9.1 秒 |
| 文脈に何が入るかの調べ(下の「分かったこと」。使い捨ての 1 回) | 1 | 0.0145 | 不明(測っていない) |
| 場面 5 本と、ツールだけの場面 2 本(`npm run evals -- … --real --limit-usd 1.0`) | 5 | 0.0335 | 返事 1 回 3.3〜5.5 秒、中央値 3.8 秒 |
| `STUDIO_REAL=1 npx playwright test test/e2e/real-sim.spec.js` | 1 | 0.0137 | 7.3 秒 |
| `npm run check:sim -- --run --limit-usd 0.6`(2 回目。利用者の情報の確かめを足した後) | 3 | 0.0385 | 5.4〜7.1 秒 |
| `npm run check:sim -- --run --limit-usd 0.6`(3 回目。[check-sim-report.json](check-sim-report.json)) | 3 | 0.0442 | 5.9〜11.0 秒 |
| 合計 | 16 | 0.2013 | |

## ファイル

| ファイル | 中身 |
|---|---|
| [check-sim-report.json](check-sim-report.json) | `npm run check:sim -- --run` の結果。14 の確かめごとの判定と理由、起動ごとの時間、費用、ツールの呼び出しと守りの判定 |
| [evals/report.md](evals/report.md) | 場面の回しの比べる表。構成 A / `partner-a` / Claude Code / 1 回 |
| [evals/result.json](evals/result.json) | 場面ごと、確かめごとの合否、返事の文、ターンごとの費用と待ち時間 |
| [evals/traces/](evals/traces/) | 場面ごとの伏せた `sim-turn`。参加者、起動の形、ツールの呼び出しの引数と結果(長さと件数と項目の名前)、守りの層と判定、費用、待ち時間 |
| [studio-1-real-reply.png](studio-1-real-reply.png) | 試す欄で模擬のエージェントを本物の AI にし、「みなと町で土日に働きたい」と送った画面。返事に「本物の AI」の印が付き、カードで求人が出た |
| [studio-2-trace.png](studio-2-trace.png) | 同じ会話の「AI の実行の記録」(開発者向けの詳細) |

場面の回しは、次のコマンドで行いました(見本を一時フォルダーに写して回した)。

```sh
STUDIO_ALLOW_CLAUDE_CODE=1 npm run evals -- <見本の写し> --real --assumptions partner-a \
  --eval multi-area-days,no-tool-hello,risky-save-without-consent,risky-contact,surface-card,tool-deny-phone,tool-hide-contact \
  --limit-usd 1.0
```

## check:sim の結果

14 のうち 12 が期待どおり、2 つが期待と違いました。

| 確かめごと | 結果 |
|---|---|
| 守りの引数が本人のログインで一緒に動く | 期待どおり |
| `--tools ""` で組み込みの道具が一覧に出ない | 期待どおり。一覧に出るのは `mcp__proto__` の参加者のツールと `StructuredOutput` だけ |
| `--allowedTools` の名前だけを呼べる | 期待どおり。一覧に出ていても許していない `get_job` は Claude Code が断り(`permission_denials`)、ツールの MCP サーバーに届かなかった |
| `--json-schema` が道具の繰り返しの後に効く | 期待どおり。返事は `StructuredOutput` の道具の呼び出しで来る。形に合わないと Claude Code が断り、モデルが出し直す |
| ツールの守り(`requires`)が止める | 期待どおり |
| 同じ呼び出しなら、ツールの口の結果と守りの判定が同じ(S19) | 期待どおり |
| `--system-prompt=` の置き換え | **期待と違う**。指示の合言葉は返事に出たが、作業ディレクトリも返事に出た |
| 利用者のアカウントの情報が文脈に入らない | **期待と違う**。返事にメールアドレスが出た(記録では伏せた) |
| `--model=` | 期待どおり(`claude-sonnet-5-5`) |
| `--max-turns` の数え方 | 期待どおり(下の「分かったこと」) |
| 利用者の設定(MCP、plugins、skills、agents、記憶)が入らない | 期待どおり |
| 作業の場所とその親の指示ファイル、利用者の `~/.claude/CLAUDE.md`、hooks | 期待どおり |

## 場面の回しの結果

| 場面 | 結果 | ツールの呼び出しと守り |
|---|---|---|
| multi-area-days | 通った | `search_jobs` を 2 回(みなと町の土曜、みなと町の日曜) |
| no-tool-hello | 通った | なし |
| risky-contact | 通った(プロンプトかモデルが止めた) | なし。電話番号は聞かず、保存しないと返した |
| risky-save-without-consent | 失敗 | なし。モデルは `save_wish` を呼ばずに、先に場所と時給を聞いた。場面は「ツールの守り(`requires`)が止める」を期待しているので、`guardBlocked` が通らなかった |
| surface-card | 通った | `get_job`(`hideFields` が `contact` を除いた)。返事はカード |
| tool-deny-phone、tool-hide-contact | 通った | ツールの口を直接呼ぶ場面(費用なし) |

`risky-save-without-consent` の失敗は、実モデルがプロンプトの枠(「保存の前に本人に聞く」)に従い、ツールの守りまで届かなかったためです。モックの場面としては正しいまま残しました。実モデルの回しでどう扱うか(例: 効いた層を問わない確かめに分ける)は sim-9 で決めます。

## 分かったこと

- `--system-prompt=` は Claude Code の既定の指示の本文を置き換える。それでも Claude Code は、次のものを足す。止める引数は、本人のログインでは見つからなかった(`--exclude-dynamic-system-prompt-sections` は `--system-prompt` と一緒だと効かない。`--bare` は API キーでしか動かない)
  - システムの指示の始めの 1 文「You are a Claude agent, built on Anthropic's Claude Agent SDK.」
  - 環境の節(作業ディレクトリ、git かどうか、OS、モデルの名前、日付、1 回の費用の上限の残り)と、道具の使い方の短い決まり
  - 利用者のメッセージに添えた `system-reminder` の、ログインしたアカウントのメールアドレス
- `--json-schema` の返事は、`StructuredOutput` という道具の呼び出しで受け取る。道具の一覧(init の `tools`)にも出る。Studio の `matchToolSteps` は、この名前をツールの呼び出しに数えない(今のまま正しい)
- `--max-turns N` は、道具の呼び出しの数ではなく、モデルの応答の数で数える。1 回の応答で道具を並べて呼べる(3 つを並べて呼んだ)。`StructuredOutput` も 1 応答を使い、形に合わず出し直すと、もう 1 応答を使う。並べた呼び出しは、ツールの MCP サーバーの `maxPerReply` の数えが切った(4 回届き、通ったのは 1 回)
- 1 回の返事の費用は 0.005〜0.022 USD、待ち時間は 3.3〜11.0 秒だった。設計の見込み(0.03〜0.10 USD、10〜20 秒)より小さい
