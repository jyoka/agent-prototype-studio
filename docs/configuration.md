# 設定とデータの置き場

環境変数、試作品の目録(`app/prototype.json`)、プロダクト内 AI の設定(`app/ai.json`)、データの置き場です。

## 環境変数

| 名前 | 既定 | 中身 |
|---|---|---|
| `STUDIO_HOME` | `~/PrototypeStudio` | データの置き場 |
| `STUDIO_PORT` | `4317` | Studio の画面のポート。`0` で空いている番号 |
| `STUDIO_PREVIEW_PORT` | `4318` | 試作品を配信するポート。`0` で空いている番号 |
| `STUDIO_NO_OPEN` | なし | `1` でブラウザを自動で開かない |
| `STUDIO_AGENT` | `fake` | 作る AI。`fake` は偽接続、`claude` は Claude Code |
| `STUDIO_ALLOW_CLAUDE_CODE` | なし | `1` でプロダクト内 AI に Claude Code(実モデル)を選べるようにする。社内の利用条件を確かめてから付ける |
| `STUDIO_CLAUDE_BIN` | PATH の `claude` | 起動する Claude Code の場所。作る AI(`STUDIO_AGENT=claude`)とプロダクト内 AI の両方で使う。テストでは偽の CLI を指す |
| `STUDIO_MAX_BUDGET_USD` | `1` | 作る AI で、API キーなど、サブスクの枠でないときに、1 回の依頼に付ける費用の上限(ドル)。プロダクト内 AI の上限(1 回の応答 0.1 ドル)は変えない |

指定のしかた(例: Studio の画面のポートを 4327 にする):

- macOS のターミナル: `STUDIO_PORT=4327 npm start`
- Windows の PowerShell: `$env:STUDIO_PORT=4327; npm start`

## 試作品の目録(`app/prototype.json`)

目録は、試作品が何を持つかを書いた成果物の契約の入口。入口、意図、制約、架空のデータ、AI の設定、シナリオの置き場所を書く。作る AI が依頼に沿って書く。見本は `samples/study-consult/app/prototype.json`。

| 項目 | 中身 | 書かないとき |
|---|---|---|
| `formatVersion` | 形の版。今は `1` だけ | 書く(なければ誤り) |
| `title` | 試作品の名前 | なし |
| `entry` | 入口のファイル。`.jsx`、`.tsx`、`.js`、`.ts` のどれか | `main.jsx`、`main.tsx`、`main.js`、`main.ts` の順に探す |
| `intent` | 意図。`purpose`(目的の文)と `tryThis`(試してほしいことの配列) | なし |
| `constraints` | 制約の配列(「データはすべて架空」など) | なし |
| `unimplemented` | 本番で作るもの(試作品では作っていないもの)の配列 | なし |
| `data` | 架空のデータを置いたファイルの宣言。`{ "file": …, "about": … }` の配列。`about` は中身の説明 | なし |
| `ai` | プロダクト内 AI の設定のファイル | `ai.json` があればそれ |
| `scenarios` | シナリオを置くフォルダー。まだなくてもよい | `scenarios` |

- パス(`entry`、`ai`、`data[].file`、`scenarios`)は `app/` からの相対で、`/` で区切って書く。`..` や絶対パスで `app/` の外は指せない。
- `entry`、`ai`、`data[].file` は、そのファイルが `app/` にあること。`scenarios` は、あるならフォルダーにする。
- 書ける項目は上の表のものだけ。文字列は空にしない。
- 目録は、ビルドのたびに検査する。誤りはビルドの失敗として、どの項目がどう違うかが右の「詳細」に出る(`ai.json` の誤りと同じ)。
- 目録がない試作品は、上の表の既定の値で読む。目録がないことは誤りにしない。

```json
{
  "formatVersion": 1,
  "title": "あおぞら学習相談(架空)",
  "entry": "main.jsx",
  "intent": { "purpose": "相談者が学びたいことを話すと、合う講座が出る体験を試す", "tryThis": ["学びたいことを話す", "読み取られた項目を直す"] },
  "constraints": ["データはすべて架空"],
  "unimplemented": ["ログイン", "講座の申し込み"],
  "data": [{ "file": "courses.js", "about": "架空の講座の一覧" }],
  "ai": "ai.json",
  "scenarios": "scenarios"
}
```

## プロダクト内 AI の設定(`app/ai.json`)

試作品の中で AI を使うときは、`app/ai.json` を置く。題材に依存しない形で、AI が覚える項目と、モックの応答の型を書く。見本は `samples/job-consult/app/ai.json`。

| 項目 | 中身 |
|---|---|
| `name` | AI の名前(詳細の欄に出る) |
| `instructions` | 実モデル(Claude Code)に渡す指示。モックは使わない |
| `fields` | AI が会話から読み取る項目。`type` は `choice`(`options` の `value` と `keywords` で読み取る)か `number`(`unit` が続く数を、`keywords` の後ろから読み取る。`min`、`max` で範囲を決める)。`question` は、その項目が未定のときに聞く文 |
| `initialState` | 項目の最初の値。書かない項目は未定 |
| `mock` | モックの応答の型。`greeting`(最初のあいさつ)、`understood`、`afterCorrection`、`notUnderstood`、`complete`。`{changes}` と `{summary}` が `項目名「値」` の並びに置き換わる |

試作品の画面からは `window.studio.ai` で呼ぶ。どれも、会話と状態の全体(`connection`、`fields`、`state`、`messages`)を返す。

| 呼び方 | 中身 |
|---|---|
| `studio.ai.session()` | 今の会話と状態 |
| `studio.ai.send(text)` | 利用者の発言を送り、AI の応答を受け取る |
| `studio.ai.correct({ key: 値 })` | AI が理解した状態を本人が直す。`null` で未定に戻す。次の応答はこの修正を踏まえる |
| `studio.ai.onChange(listener)` | Studio の画面で接続が切り替わったとき、新しい会話と状態を受け取る。戻り値の関数で受け取りをやめる |

会話の AI の発言には、応答した接続(`via`: `mock` か `claude-code`)と、待った時間(`elapsedMs`)が付く。Claude Code の応答には、CLI が返した費用の目安(`costUsd`、米ドル)も付く。

`ai.json` は、ビルドのたびに検査する。誤りは、ビルドの失敗として右の「詳細」に出る。

`ai.json` が変わったビルドに切り替わると、会話は新しい設定で最初から始まる。前の会話の試し直し(`/api/projects/<id>/ai/retry`)は Studio の画面だけが使え、試作品の `studio.ai` からは呼べない。

## データの置き場

- 試作品は `~/PrototypeStudio/projects/<試作品の ID>/app/` に置かれる(Windows は `%USERPROFILE%\PrototypeStudio`)。環境変数 `STUDIO_HOME` で変えられる。
- サンプルは、まだ置き場にないものだけが、起動のときに `sample-library`、`sample-job-consult`、`sample-study-consult` として写される。前の版で起動したことのある置き場にも、新しいサンプルだけが足される。手を入れた後は上書きしない。最初の状態に戻したいときは、`~/PrototypeStudio/projects/<サンプルの ID>` を消して起動し直す。
- 作業中のプロダクト内 AI との会話と条件は、Studio のメモリーにだけ置く。Studio を止めると消える。保存した版に入れた会話と条件は、ディスクに残る。
- 保存した版は `~/PrototypeStudio/projects/<試作品の ID>/.studio/versions/<版の ID>/` に置く。`app/` はファイルの写し、`version.json` はファイルの指紋(SHA-256)と、会話と状態。どの版から作業しているかは `.studio/working.json` に置く。`.studio/` は Studio だけが書く場所で、作る AI は読み書きしない。復元が途中で止まったときは、次の起動で `app/` を戻し、前の `app/` は `.studio/set-aside/` に置く。
- `app/` の入口は、目録の `entry`。目録がなければ `main.jsx`(または `main.tsx`、`main.js`、`main.ts`)。使えるライブラリは React(`react`、`react-dom`)だけ。
- 引き継ぎの書き出しは `~/PrototypeStudio/handoffs/` に置く。書き出すたびに新しいフォルダーを作る。要らなくなったら消してよい。書いたメモは `projects/<試作品の ID>/.studio/handoff-notes.json`。
- 自分で試作品を足すときは、`~/PrototypeStudio/projects/<英小文字・数字・ハイフンの名前>/app/main.jsx` を置き、画面で選んで「作り直す」を押す。
