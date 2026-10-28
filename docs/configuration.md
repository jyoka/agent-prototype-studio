# 設定とデータの置き場

環境変数、プロダクト内 AI の設定(`app/ai.json`)、データの置き場です。

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

## プロダクト内 AI の設定(`app/ai.json`)

試作品の中で AI を使うときは、`app/ai.json` を置く。題材に依存しない形で、AI が覚える項目と、モックの応答の型を書く。見本は `samples/job-consult/app/ai.json`。

| 項目 | 中身 |
|---|---|
| `name` | AI の名前(詳細の欄に出る) |
| `instructions` | 実モデル(Claude Code)に渡す指示。モックは使わない |
| `fields` | AI が会話から読み取る項目。`type` は `choice`(`options` の `value` と `keywords` で読み取る)か `number`(`unit` が続く数を、`keywords` の後ろから読み取る。`min`、`max` で範囲を決める)。`question` は、その項目が未定のときに聞く文 |
| `initialState` | 項目の最初の値。書かない項目は未定 |
| `mock` | モックの応答の型。`greeting`(最初のあいさつ)、`understood`、`afterCorrection`、`notUnderstood`、`complete`。`{changes}` と `{summary}` が `項目名「値」` の並びに置き換わる |

### 版 2(段、終わる条件、守ること)

`"formatVersion": 2` と書くと、何を聞くか、いつ段を切り替えるか、いつ終えるかを `ai.json` に書ける。決めるのは `ai.json` と Studio のコードで、モデルには決めさせない。版 1 の項目は、そのまま使える。

```json
{
  "formatVersion": 2,
  "name": "旅の相談(架空)",
  "fields": [
    { "key": "place", "label": "行き先", "required": true, "options": [{ "value": "湖の町", "keywords": ["湖"] }] },
    { "key": "nights", "label": "泊数", "type": "number", "unit": "泊", "min": 1, "max": 14, "required": false }
  ],
  "flow": {
    "steps": [
      { "id": "hear", "ask": ["place", "nights"], "next": [{ "when": { "filled": "required" }, "to": "confirm" }] },
      { "id": "confirm", "say": "summary", "next": [{ "when": { "intent": "yes" }, "to": "done" }, { "when": { "intent": "no" }, "to": "hear" }] }
    ],
    "maxTurns": 15
  },
  "end": { "say": "complete" },
  "rules": { "noNewNumbers": true, "noLeading": true, "mustAsk": true, "maxReplyChars": 300, "forbidden": ["実在の宿の名前"] },
  "mock": { "intents": { "yes": ["はい", "それで"], "no": ["ちがう"] } }
}
```

| 項目 | 中身 | 書かないとき |
|---|---|---|
| `formatVersion` | 設定の版。`1` か `2` | 版 1 |
| `fields[].required` | 終わる条件に入る項目か。`true` か `false` | `true` |
| `flow.steps[]` | 段。最初の段から始まる。`id` は英字で始まる名前(`done` は使えない) | 段は 1 つ(`hear`)。全部の項目を並びの順に聞き、必須の項目が全部埋まったら終わる |
| `flow.steps[].ask` | その段で聞く項目の `key` を、聞く順に並べる | 聞かない |
| `flow.steps[].say` | その段で言うこと。`summary`(条件のまとめ、型は `mock.confirm`)か `complete`(終わりの文、型は `mock.complete`) | 言わない |
| `flow.steps[].next[]` | 遷移。`when` の条件を満たすと `to` の段へ移る。`to` に `"done"` を書くと終わる。上から順に確かめ、最初に満たしたもので移る | 移らない |
| `flow.maxTurns` | この回数で会話を終える。30 を超える値は 30 として読む | 30 |
| `end.say` | 終わったときに言うこと。`summary` か `complete` | `complete` |
| `rules` | 守ること。`noNewNumbers`(数字を作らない)、`noLeading`(誘導しない)、`mustAsk`(問いの原文を入れる)、`maxReplyChars`(返事の長さの上限、2000 まで)、`forbidden`(禁止の言葉、1 つ 100 文字までで 20 個まで) | 3 つの `true`、`maxReplyChars` は 1000、`forbidden` はなし |
| `mock.intents` | モックが利用者の発言の種類(`intent`)を読むときの言葉。実モデルは使わない | なし |
| `mock.confirm` | モックが条件のまとめ(`say` の `summary`)を言うときの型。`{summary}` が置き換わる | `今の条件は{summary}です。これでよいですか?` |

遷移の条件(`when`)に書ける語は 3 つだけ。式や関数は書けない。1 つの `when` に 2 つ以上書くと、どれも満たすときに移る。

| 語 | 満たすとき |
|---|---|
| `filled` | `"required"`(必須の項目が全部埋まった)か、項目の `key` の配列(その項目が全部埋まった) |
| `intent` | 利用者の発言の種類が、書いた種類のとき。種類は `answer`、`yes`、`no`、`clarify`(質問を返した)、`aside`(関係のない話)、`restart`(最初から)。種類を増やせるのは Studio のコードだけ |
| `turnsAtLeast` | 会話がこのターン数以上になった |

- 版 1 の `ai.json`(`formatVersion` がない)は、上の「書かないとき」の版 2 として読む。全部の項目が必須になるので、全部が埋まったら終わる。今のモックと同じ振る舞いになる。
- 版 1 のまま `flow`、`end`、`rules`、`fields[].required`、`mock.intents`、`mock.confirm` を書くと、検査の誤りになる。`"formatVersion": 2` を足して直す。
- 存在しない段への遷移、`fields` にない項目を `ask` や `filled` に書くこと、知らない条件の語、知らない `intent` は、どれも検査の誤りになる。
- 満たされ方のおかしい条件も誤りになる。必須の項目が 1 つもないのに `"filled": "required"` を使う(最初から満たされる)、`turnsAtLeast` が `flow.maxTurns` より大きい(満たされない)、の 2 つ。
- 版 2 で会話を動かす作り(harness)は、まだない。今のモックと実モデルは、段と遷移を読まずに版 1 と同じく動く。

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
- `app/` の入口は `main.jsx`(または `main.tsx`、`main.js`、`main.ts`)。使えるライブラリは React(`react`、`react-dom`)だけ。
- 引き継ぎの書き出しは `~/PrototypeStudio/handoffs/` に置く。書き出すたびに新しいフォルダーを作る。要らなくなったら消してよい。書いたメモは `projects/<試作品の ID>/.studio/handoff-notes.json`。
- 自分で試作品を足すときは、`~/PrototypeStudio/projects/<英小文字・数字・ハイフンの名前>/app/main.jsx` を置き、画面で選んで「作り直す」を押す。
