# 設定とデータの置き場

環境変数、試作品の目録(`app/prototype.json`)、プロダクト内 AI の設定(`app/ai.json`)、構成(`app/composition.json`)、データの置き場です。

## 環境変数

| 名前 | 既定 | 中身 |
|---|---|---|
| `STUDIO_HOME` | `~/PrototypeStudio` | データの置き場 |
| `STUDIO_PORT` | `4317` | Studio の画面のポート。`0` で空いている番号 |
| `STUDIO_PREVIEW_PORT` | `4318` | 試作品を配信するポート。`0` で空いている番号 |
| `STUDIO_NO_OPEN` | なし | `1` でブラウザを自動で開かない |
| `STUDIO_AGENT` | `auto` | 作る AI。`auto`(自動)は、Claude Code が見つかり、版が足り、ログインしていれば Claude Code を使い、そうでなければ言葉で直す欄を使えない状態にして理由を出す。`claude` は Claude Code に固定する(判定は自動と同じ)。`fake` は偽接続で、モデルを呼ばない。テストと開発では `fake` か偽の `claude` を明示する |
| `STUDIO_ALLOW_CLAUDE_CODE` | なし | `0` でプロダクト内 AI に Claude Code(本物の AI)を選べなくする(会社として止めたいとき)。書かなければ選べる。使う前に画面で同意する([claude-code.md](claude-code.md#本物の-ai-を使う前の同意))。`0` と `1`(前の決まりの名残りで、書かないのと同じ)のほかの値では起動しない |
| `STUDIO_CLAUDE_BIN` | PATH の `claude` | 起動する Claude Code の場所。作る AI(`STUDIO_AGENT` が `auto` か `claude`)とプロダクト内 AI の両方で使う。ない場所を指すと、作る AI は「ない」になる。テストでは偽の CLI を指す |
| `STUDIO_MAX_BUDGET_USD` | `1` | 作る AI で、API キーなど、サブスクの枠でないときに、作る AI の 1 回の起動に付ける費用の上限(ドル)。直すラウンドを合わせて、1 つの依頼で 3 回まで起動するので、1 つの依頼では最大でこの 3 倍になる。プロダクト内 AI の上限(1 回の呼び出し 0.1 ドル)は変えない |

指定のしかた(例: Studio の画面のポートを 4327 にする):

- macOS のターミナル: `STUDIO_PORT=4327 npm start`
- Windows の PowerShell: `$env:STUDIO_PORT=4327; npm start`

## 試作品の目録(`app/prototype.json`)

目録は、試作品が何を持つかを書いた成果物の契約の入口。入口、意図、制約、架空のデータ、AI の設定、シナリオの置き場所を書く。作る AI が依頼に沿って書く。見本は `samples/study-consult/app/prototype.json`。

| 項目 | 中身 | 書かないとき |
|---|---|---|
| `formatVersion` | 形の版。`1` か `2`。版 2 で `composition`、`compositions`、`evals` を書ける | 書く(なければ誤り) |
| `title` | 試作品の名前。試作品の一覧には、この名前に AI と話せるかを添えて出す(例: `学習相談(架空)` は「学習相談(架空・AI と話せる)」) | 試作品の ID |
| `entry` | 入口のファイル。`.jsx`、`.tsx`、`.js`、`.ts` のどれか | `main.jsx`、`main.tsx`、`main.js`、`main.ts` の順に探す |
| `intent` | 意図。`purpose`(目的の文)と `tryThis`(試してほしいことの配列) | なし |
| `constraints` | 制約の配列(「データはすべて架空」など) | なし |
| `unimplemented` | 本番で作るもの(試作品では作っていないもの)の配列 | なし |
| `data` | 架空のデータを置いたファイルの宣言。`{ "file": …, "about": … }` の配列。`about` は中身の説明 | なし |
| `ai` | プロダクト内 AI の設定のファイル | `ai.json` があればそれ |
| `scenarios` | シナリオを置くフォルダー。まだなくてもよい | `scenarios` |
| `composition`(版 2) | 既定の構成のファイル([構成](#構成appcompositionjson)) | `composition.json` があればそれ |
| `compositions`(版 2) | 比べるためのほかの構成を置くフォルダー。まだなくてもよい | `compositions` |
| `evals`(版 2) | 場面を置くフォルダー。まだなくてもよい | `evals` |

- パス(`entry`、`ai`、`data[].file`、`scenarios`)は `app/` からの相対で、`/` で区切って書く。`..` や絶対パスで `app/` の外は指せない。
- `entry`、`ai`、`data[].file` は、そのファイルが `app/` にあること。`scenarios` は、あるならフォルダーにする。
- 書ける項目は上の表のものだけ。文字列は空にしない。版 1 の目録に `composition`、`compositions`、`evals` を書くと誤り(使うなら版 2 にする)。版 1 の目録と目録のない試作品も、既定の場所(`composition.json`、`compositions/`、`evals/`)は読む。
- 目録は、ビルドのたびに検査する。誤りはビルドの失敗として、どの項目がどう違うかが「その他」の「開発者向けの詳細」に出る(`ai.json` の誤りと同じ)。
- 目録がない試作品は、上の表の既定の値で読む。目録がないことは誤りにしない。

```json
{
  "formatVersion": 1,
  "title": "学習相談(架空)",
  "entry": "main.jsx",
  "intent": { "purpose": "相談者が学びたいことを話すと、合う講座が出る体験を試す", "tryThis": ["学びたいことを話す", "読み取られた項目を直す"] },
  "constraints": ["データはすべて架空"],
  "unimplemented": ["ログイン", "講座の申し込み"],
  "data": [{ "file": "courses.js", "about": "架空の講座の一覧" }],
  "ai": "ai.json",
  "scenarios": "scenarios"
}
```

## シナリオ(`app/scenarios/*.json`)

シナリオは、観察器で試作品を動かして確かめる手順。1 ファイルに 1 本書く。置き場所は目録の `scenarios`(既定は `app/scenarios/`)で、ファイルの名前の順に回す。見本は `samples/study-consult/app/scenarios/talk-and-plan.json`。

```json
{
  "name": "学びたいことを話すと、学習プランの項目に出る",
  "viewport": "mobile",
  "steps": [
    { "do": "type", "target": { "label": "メッセージ" }, "text": "英会話を始めたいです" },
    { "do": "click", "target": { "role": "button", "name": "送る" } },
    { "expect": "aiState", "key": "subject", "equals": "英会話" },
    { "expect": "text", "target": { "region": "学習プラン" }, "contains": "英会話" },
    { "do": "screenshot", "name": "学習プランが出た" }
  ]
}
```

| 項目 | 中身 | 書かないとき |
|---|---|---|
| `name` | シナリオの名前(100 文字まで) | 書く(なければ誤り) |
| `viewport` | 始めるときの画面幅。`mobile`(390x844)、`tablet`(820x1180)、`desktop`(1280x800) | `desktop` |
| `steps` | 手順の配列(1〜50 個)。1 つの手順に `do`(操作)か `expect`(確かめ)のどちらか 1 つを書く | 書く(なければ誤り) |

操作(`do`)は、観察器の 7 つの操作。

| `do` | 書く項目 | すること |
|---|---|---|
| `read` | なし | 画面の文字と、アクセシビリティの木の要約を読む |
| `inspect` | `target`(書かなくてよい) | 対象の要素の役割、名前、見えているか、押せるかを調べる。`target` がなければ、押せる要素と入力欄の一覧 |
| `click` | `target` | 対象を押す |
| `type` | `target`、`text` | 対象の入力欄の文字を `text` に入れ替える |
| `scroll` | `target` か `to`(どちらも書かなくてよい) | 対象が見えるまでスクロールする。`to` は `top` か `bottom`(既定は `bottom`) |
| `viewport` | `viewport` | 画面幅を `mobile`、`tablet`、`desktop` に切り替える |
| `screenshot` | `name` | 画面を撮り、名前を付けて `.studio/observations/<観察の ID>/` に置く |

確かめ(`expect`)は 4 つ。

| `expect` | 書く項目 | 通る条件 |
|---|---|---|
| `text` | `contains`、`target`(書かなくてよい) | 対象(なければ画面全体)の文字に `contains` がある。空白の違いは見ない |
| `visible` | `target`(書かなくてよい) | 対象が見えている。`target` がなければ、描画が空でない |
| `noErrors` | なし | ここまでにエラー(実行時のエラー、`console.error` など)がない |
| `aiState` | `key`、`equals` | プロダクト内 AI の状態の項目 `key` が `equals`(文字列、数、`null`)になる |

- 対象(`target`)は、次のどれか 1 つで指す。CSS のセレクターは使えない。作る AI と人が読めるため。
  - `{ "role": "button", "name": "送る" }`: 役割と名前。`name` は書かなくてよい
  - `{ "label": "メッセージ" }`: 入力欄のラベル
  - `{ "text": "合う講座" }`: 画面の文字
  - `{ "region": "学習プラン" }`: 名前の付いた領域(`aria-label` の付いた `section` など)
- 名前、ラベル、文字は、その文字を含めば合う。いくつも合うときは、最初の 1 つを使う。
- 操作と確かめは、1 つ 5 秒まで待つ。AI の返事を待つ確かめ(`text`、`aiState`)も、5 秒のうちに通ればよい。シナリオ 1 本は 60 秒まで。
- 失敗した手順で止める。残りの手順は回さない。report の `scenarios[]` に、失敗した手順、理由、そのときのスクリーンショットが入る。
- 形の誤り(知らない `do`、対象がない、`viewport` の値が違う、など)は、どのファイルの何番目の手順がどう違うかを返す。誤りのあるシナリオは回さず、失敗として扱う。作る run では、ビルドのたびに契約の検査(G3)で形を確かめ、誤りはビルドの失敗として作る AI に返す。
- 作る run は、起動の確認(G5)が通った後に、シナリオの確かめ(G6)でシナリオを回す。時間の上限は 1 本 60 秒、全体で 3 分。失敗したら、シナリオの名前、失敗した手順、期待と実際、そのときの画面の文字を作る AI に返して直させる。
- 題材の言葉(相談の中身、項目の値)は、シナリオの中にだけ書く。
- Studio の基本のシナリオは、`app/` のシナリオより先に、いつも回す。起動して描画が空でなく、エラーがないこと。AI のある試作品では、`ai.json` の `mock.greeting`(あいさつ)が画面に出ること。基本のシナリオは Studio のコード(`src/observer/scenario.js`)にあり、`app/` からは変えられない。
- 観察の中のプロダクト内 AI は、観察用の新しい会話で答える。今はモックだけで回す。作る run の G6 では、利用者が試す画面で実モデルを選んでいても、いつもモックで回す。

## プロダクト内 AI の設定(`app/ai.json`)

試作品の中で AI を使うときは、`app/ai.json` を置く。題材に依存しない形で、AI が覚える項目と、モックの応答の型を書く。見本は `samples/job-consult/app/ai.json`。

| 項目 | 中身 |
|---|---|
| `name` | AI の名前(「その他」の「開発者向けの詳細」に出る) |
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
| `rules` | 守ること。`noNewNumbers`(数字を作らない)、`noLeading`(誘導しない)、`mustAsk`(問いの原文を入れる)、`maxReplyChars`(返事の長さの上限、2000 まで)、`forbidden`(禁止の言葉、1 つ 100 文字までで 20 個まで)。確かめ方は下の「守ること(`rules`)の確かめ方」 | 3 つの `true`、`maxReplyChars` は 1000、`forbidden` はなし |
| `mock.intents` | モックが利用者の発言の種類(`intent`)を読むときの言葉。実モデルは使わない | なし |
| `mock.confirm` | モックが条件のまとめ(`say` の `summary`)を言うときの型。`{summary}` が置き換わる | `今の条件は{summary}です。これでよいですか?` |

遷移の条件(`when`)に書ける語は 3 つだけ。式や関数は書けない。1 つの `when` に 2 つ以上書くと、どれも満たすときに移る。

| 語 | 満たすとき |
|---|---|
| `filled` | `"required"`(必須の項目が全部埋まった)か、項目の `key` の配列(その項目が全部埋まった) |
| `intent` | 利用者の発言の種類が、書いた種類のとき。種類は `answer`、`yes`、`no`、`clarify`(質問を返した)、`aside`(関係のない話)、`restart`(最初から)。種類を増やせるのは Studio のコードだけ |
| `turnsAtLeast` | 会話がこのターン数以上になった |

- 版 1 の `ai.json`(`formatVersion` がない)は、上の「書かないとき」の版 2 として読む。全部の項目が必須になるので、全部が埋まったら終わる。前のモックとほぼ同じ振る舞いになる(違いは下に書いた)。
- 版 1 のまま `flow`、`end`、`rules`、`fields[].required`、`mock.intents`、`mock.confirm` を書くと、検査の誤りになる。`"formatVersion": 2` を足して直す。
- 存在しない段への遷移、`fields` にない項目を `ask` や `filled` に書くこと、知らない条件の語、知らない `intent` は、どれも検査の誤りになる。
- 満たされ方のおかしい条件も誤りになる。必須の項目が 1 つもないのに `"filled": "required"` を使う(最初から満たされる)、`turnsAtLeast` が `flow.maxTurns` より大きい(満たされない)、の 2 つ。

会話は Studio の harness が動かす。1 ターンは「抽出 → 決定 → 言い方」の 3 段。何を聞くか、段の遷移、終わるかは、`ai.json` と Studio のコードが決める。接続は、抽出(項目の値と発言の種類)と言い方(返事の文)だけを返す。

- 決定: 抽出の値を状態に入れてから、今の段の `next` を上から確かめ、満たした最初のものへ移る。1 ターンで移るのは 1 回だけ。次に聞くのは、移った後の段の `ask` で、未定の最初の項目
- 聞く項目が全部埋まっても次の段へ移らないとき、`say` を書いていない段では、今の条件のまとめ(`mock.confirm` の型)を言う
- 終わった会話(`done`、または `flow.maxTurns` に達した)は、それ以上聞かない。発言は読み取って状態に入れ、`end.say` の文を返す
- 今聞いている項目への、選択肢の文字そのもの(例: `湖の町`)と数だけの答え(例: `3`、`3泊`)は、抽出を呼ばずに読む。数の項目の `keywords` がなくても読む
- 項目の決まり(選択肢、数の範囲、型)に合わない抽出の値と、知らない `intent` は、状態に入れない。入れなかったことは AI の実行の記録に残る
- モックは、選択肢と `keywords` の言葉で値を、`mock.intents` の言葉で発言の種類を読む(一番前に出てきた言葉の種類。言葉がなく値を読めたら `answer`)。言い方は `mock` の型に当てはめる
- Claude Code の接続も、抽出と言い方の 2 種の呼び出しに分かれている。抽出は項目の値と発言の種類(`intent`)を返すので、`intent` の条件でも移る。言い方は決定の後に呼ぶので、返事の文は段の遷移と終わりに合う。詳しくは [claude-code.md](claude-code.md)
- 進み具合(今の段、ターンの数、終わったか)は、会話と状態といっしょに版に入る

#### 守ること(`rules`)の確かめ方

言い方の返事は、harness のコードが `rules` で確かめる。確かめるのは文の形だけで、意味は確かめない。たとえば「誘導しない」は選択肢の値の文字があるかを、「数字を作らない」は数の文字があるかを見る。言い換えや漢数字(三、十)は見ない。

| `rules` | 合わない返事 |
|---|---|
| `noNewNumbers` | 算用数字の数(`1,300` と `1300` は同じ数)が、次のどれにも出てこない: 今の状態の値、利用者の発言(本人の修正を含む)、`ai.json` の作り手の文(名前、項目の名前、問いの原文、選択肢、単位、`min` と `max`、`mock` の型)、試作品の架空のデータ(`prototype.json` の `data` に書いたファイル) |
| `noLeading` | 利用者がまだ言っていない選択肢の値がある。言ったとみなすのは、今の状態の値と、利用者の発言に出てきた値。今聞いている項目の問いの原文の中の選択肢は除く |
| `mustAsk` | 決定が項目を聞くのに、その問いの原文(`question`)がない。この決まりはやり直さず、harness が原文を返事の後ろに足す |
| `maxReplyChars` | 文字数が上限を超える(問いの原文を足した後の文字数) |
| `forbidden` | 禁止の言葉を含む。全角と半角の違いはそろえてから、書いた言葉がそのまま入っているかを見る。「実在の宿の名前」のような説明は、その文字のときだけ見つかる |

- 合わなければ、合わなかったところを渡して、言い方を 1 回やり直す。2 回目も合わなければ、モックの言い方の型(決まった文)で返す
- やり直しも、1 ターンの呼び出しの上限(言い方 2 回)に数える。出力の形が壊れたやり直しで 2 回を使い切っていたら、やり直さずに決まった文で返す
- モックの返事は、`mock` の型と状態の値と問いの原文でできているので、ふつうは合う。`mock` の型に禁止の言葉を書いたときなどは合わず、記録に「決まった文に代えた」と出る
- 結果は AI の実行の記録の「harness の段」に出る: 合格、やり直して合格、決まった文に代えた、のどれかと、合わなかった決まりの名前と理由
- 1 ターンには期限(240 秒)がある。過ぎたら接続を止め、決まった文で返し、記録に時間切れと残す。抽出の途中で過ぎたら、状態は変えない

版 1 の `ai.json` は、前のモックとほぼ同じに動く。違うのは次の 3 つ。

- 30 ターン(`flow.maxTurns` の既定)で会話を終える
- 終わった後に、本人の修正で項目を未定に戻しても、もう聞かない
- 今聞いている数の項目に、数だけ(例: `1100`)で答えても読む

試作品の画面からは `window.studio.ai` で呼ぶ。どれも、会話と状態の全体(`connection`、`fields`、`state`、`messages`)を返す。

| 呼び方 | 中身 |
|---|---|
| `studio.ai.session()` | 今の会話と状態 |
| `studio.ai.send(text, { action })` | 利用者の発言を送り、AI の応答を受け取る。`action` はボタンの名前(英小文字で始め、英小文字、数字、`_`、`-` だけで 40 字まで)で、構成のある試作品だけが使う。書かなくてよい。構成 B では受け取っても使わない |
| `studio.ai.correct({ key: 値 })` | AI が理解した状態を本人が直す。`null` で未定に戻す。次の応答はこの修正を踏まえる |
| `studio.ai.onChange(listener)` | Studio の画面で接続が切り替わったとき、新しい会話と状態を受け取る。戻り値の関数で受け取りをやめる |

会話の AI の発言には、応答した接続(`via`: `mock` か `claude-code`)と、待った時間(`elapsedMs`)が付く。Claude Code の応答には、CLI が返した費用の目安(`costUsd`、米ドル。そのターンの抽出と言い方の呼び出しの合計)も付く。

`ai.json` は、ビルドのたびに検査する。誤りは、ビルドの失敗として「その他」の「開発者向けの詳細」に出る。

`ai.json` が変わったビルドに切り替わると、会話は新しい設定で最初から始まる。前の会話の試し直し(`/api/projects/<id>/ai/retry`)は Studio の画面だけが使え、試作品の `studio.ai` からは呼べない。

## 構成(`app/composition.json`)

構成は、試作品の中で誰が会話を回し、誰が何を持つかを書いたデータ。設計は [agent-simulation.md の 2 節](design/agent-simulation.md#2-構成の書き方)、決定は [ADR-0003](adr/0003-agent-simulation.md)(案)。今は、形の検査と構成 B の読み替えと、ツールの口(ツールを宣言どおりに動かすコード)と、ツールの MCP サーバー(`npm run tools:mcp`。[usage.md](usage.md#ツールの-mcp-サーバーnpm-run-toolsmcp))と、会話の進め方と模擬のエージェントと、会話の枠の部品(`studio-talk`)を作った。`composition.json` のある試作品は、試す画面で構成どおりに会話が回る(下の「構成のある会話」)。場面の回しは、まだない。見本は `samples/part-time/app/`(バイト探し。構成 A)。

- `composition.json` のない試作品は、`ai.json` の harness 1 つの構成(構成 B)として読む。今の試作品と見本は、何も書き足さずに今までどおり動く。`ai.json` もなければ、AI のない試作品
- 置き場所と形は次のとおり。形の例は設計の 2.2〜2.5、3.3、3.4、4.2 にある

| ファイル | 中身 | 形 |
|---|---|---|
| `composition.json`、`compositions/*.json` | 構成。回し手(`driver`)、参加者(`agent`、`harness`、`human`)、ツールの宣言のファイル、引き継ぎの辺(`handoffs`)、ガードレール(`guards`。`prompt` と `output` の層)、会話の枠、前提、上限 | 設計の 2.2 |
| `tools.json` | ツールの宣言。決まった処理(`search`、`get`、`record`、`fixed`、`handoff`)とツールの守りだけで書く | 設計の 2.4、3.5 |
| `data/*.json` など | ツールが読む架空のデータ。`.json` だけ。`search` と `get` はオブジェクトの配列 | 設計の 3.5 |
| `prompts/*.md` | プロンプトの枠の文(`.md` か `.txt`) | 設計の 2.4 |
| `assumptions/*.json` | 前提。1 ファイル 1 組 | 設計の 3.4 |
| `mocks/*.json` | 模擬のエージェントのモックの決まり | 設計の 3.3 |
| `evals/*.json` | 場面 | 設計の 4.2 |

- どれもビルドのたびに検査する(関門 G3)。誤りはビルドの失敗として、ファイルと項目の場所が「その他」の「開発者向けの詳細」に出る(`ai.json` の誤りと同じ)
- `composition.json` と `compositions/` のすべての構成を検査する。構成のファイルが 1 つでもあれば、使われていない `tools.json`、`assumptions/`、`mocks/` も検査する。構成のファイルがない試作品では、この 3 つを読まない(画面のデータに同じ名前を使っている今の試作品を壊さないため)。`evals/` はいつも検査する
- 次は誤り: 知らないキー、知らない種類(参加者の `kind`、ツールの `op`、守りの `layer`、場面の `kind` と `check`、部品の `kind`)、ない参加者やツールを指す、辺(`handoffs`)にない引き継ぎのツールを渡す、`app/` の外のファイルを指す、データやモックに `.js` などのコードを使う、上限を超える値
- ツールの名前は `^[a-z][a-z0-9_]{0,39}$` だけ。参加者、前提、守り、枠、場面の `id` は `^[a-z][a-z0-9-]{0,39}$`
- 場面の `entry` の参加者が、ある構成にいなくても誤りにしない(その構成では、その場面を当てはまらないものとして扱う)
- ツールの守り(`requires`、`deny`、`hideFields`、`maxCallsPerConversation`、`maxResultChars`)は、ツールの口のコードが守る。当たった呼び出しは実行せず、守りの名前と理由を記録に残す。`inputSchema` にない引数も断る。`hideFields` は呼び出しを断らず、項目を除いて返す。細かい振る舞いは [設計の 3.5](design/agent-simulation.md#35-ツールの口)
- 作る AI が構成、ツール、ガードレールを変えたビルドでは、前と比べた結果を言葉で直す欄に出す。ガードレールを外したり弱めたりしたときは、先頭に「【ガードレールが減りました】」の印を付ける。`ai.json` の `rules` を弱めたときも同じ。比べるのは、既定の構成、`compositions/` の同じファイルの構成どうし、ツールの宣言のファイルどうし。既定の構成のものでない行には、どのファイルの変化かを頭に付ける

### 構成のある会話

`composition.json` のある試作品は、`studio.ai` の会話を会話の進め方(`src/server/sim/orchestrator.js`)が回す。決まりは [agent-simulation.md の 3.2 と「sim-4 で決めた細かい振る舞い」](design/agent-simulation.md#32-1-ターンの進め方)にある。

- 誰が話すか、引き継ぎ(辺にあるものだけ、1 ターン 1 回、`limits.maxHandoffs` まで。戻るのも数える)、受け渡す値の検査、`limits.maxTurns` は Studio のコードが決める。模擬のエージェントが決めるのは、返事の中身とツールの選び方だけ
- 接続は、プロダクト内 AI と同じく「AI: モック」か「AI: Claude Code」。既定はモック(`app/mocks/*.json` の決まりで返す)。Claude Code に切り替えるときも、本物の AI を使う前の同意が要る
- 前提は、構成の `assumptions.default`。返事の部品は、前提の `messageTypes` にあるものだけ。ないものは文に落とし、記録に残す
- 返る会話には、構成 B の形(`connection`、`name`、`fields`、`state`、`messages`、`busy`)に加えて、次が入る。ツールの呼び出しの中身は返さない(「AI の実行の記録」にだけ出る)

| キー | 中身 |
|---|---|
| `participants` | 参加者(`id`、`label`、`kind`) |
| `surface` | 会話の枠(構成の `surface`。書いていなければ `null`)。`studio-talk` が見た目の既定に使う |
| `active` | 今話す参加者(次の発言を受ける参加者)の `id` |
| `records` | 記録の店(`record` のツールが入れたもの) |
| `messages[].from`、`messages[].parts` | AI の発言の、話した参加者と返事の部品。`text` は部品を文にしたもの。1 ターンで引き継いだときは、2 人分の発言が続く |
| `fields`、`state` | harness の参加者(最初の 1 人)の項目と状態。harness がいなければ空 |

- `studio.ai.correct` は、構成のある会話では使えない(`not-supported` で断る)
- 構成のある会話は、まだ版に入れない。版を戻すと、会話は最初から始まる
- 試作品の一覧では、`composition.json` のある試作品も「AI と話せる」と出る(`ai.json` がなくても)

### 会話の枠(`studio-talk`)

Studio が同梱するトーク風の部品。試作品は React と同じく import して使う。試作品の iframe の中で動き、`window.studio.ai` だけを呼ぶ。設計は [agent-simulation.md の 3.8](design/agent-simulation.md#38-会話の枠)。

```jsx
import { Talk } from 'studio-talk';

export default function App() {
  return <Talk theme="talk" title="そよかぜバイト探し(架空)" />;
}
```

| 書き出すもの | 中身 |
|---|---|
| `Talk` | 会話の枠の全体。発言の一覧、返事の部品、入力欄(ラベル「メッセージ」)と「送る」。属性は `theme`(`talk`、`web`、`plain`。書かなければ構成の `surface.theme`、それもなければ `talk`)、`title`、`note`(注意書き)、`starters`(会話がまだないときに出す、押すと送れる発言の例)、`placeholder`、`talk`(下の `useStudioTalk()` の戻り値) |
| `useStudioTalk()` | 会話の状態と送り方(`session`、`busy`、`error`、`send(text, { action })`)。試作品の画面で記録の店(`session.records`)も出すときは、これを `Talk` の `talk` に渡し、同じ会話を使う |
| `TalkPart` | 返事の部品を 1 つ描く |
| `TALK_PART_KINDS`、`TALK_THEMES` | 部品の種類と見た目の名前 |

- 部品は `text`(文)、`buttons`(ボタン)、`card`(見出し、本文、ボタン)、`carousel`(横に並ぶカード)、`notice`(知らせ)。どれを返すかは前提の `messageTypes` で決まり、使えない部品はサーバーで文に落ちて届く
- ボタンを押すと、ボタンの文を発言として、`action` があれば一緒に送る。ボタンは役割 `button` と名前(ボタンの文)で指せるので、観察器のシナリオの `click` で押せる。前のターンの選択肢は押せない印になる(シナリオの `click` が前のターンのボタンを押さないため)。1 つのターンの返事の中(カルーセルのカード、引き継いだ 2 人分の返事)では、ボタンの名前を重ねないようにする
- カードは役割 `article` と見出しの名前、カルーセルは「カードの一覧」、例の発言は「話しかける例」のまとまり(`group`)で指せる
- 話す参加者が替わったら(引き継ぎ)、「〜に代わりました」の知らせを挟む。返事には接続の印(「お試しの AI」か「本物の AI」)を付ける
- 使わなくてもよい。試作品は自分で描いてもよい(`messages[].parts` を読む)

## データの置き場

- 試作品は `~/PrototypeStudio/projects/<試作品の ID>/app/` に置かれる(Windows は `%USERPROFILE%\PrototypeStudio`)。環境変数 `STUDIO_HOME` で変えられる。
- サンプルは、まだ置き場にないものだけが、起動のときに `sample-library`、`sample-job-consult`、`sample-study-consult`、`sample-part-time` として写される。前の版で起動したことのある置き場にも、新しいサンプルだけが足される。手を入れた後は上書きしない。最初の状態に戻したいときは、`~/PrototypeStudio/projects/<サンプルの ID>` を消して起動し直す。
- 作業中のプロダクト内 AI との会話と条件は、Studio のメモリーにだけ置く。Studio を止めると消える。保存した版に入れた会話と条件は、ディスクに残る。
- 保存した版は `~/PrototypeStudio/projects/<試作品の ID>/.studio/versions/<版の ID>/` に置く。`app/` はファイルの写し、`version.json` はファイルの指紋(SHA-256)と、会話と状態。どの版から作業しているかは `.studio/working.json` に置く。`.studio/` は Studio だけが書く場所で、作る AI は読み書きしない。復元が途中で止まったときは、次の起動で `app/` を戻し、前の `app/` は `.studio/set-aside/` に置く。
- `app/` の入口は、目録の `entry`。目録がなければ `main.jsx`(または `main.tsx`、`main.js`、`main.ts`)。使えるライブラリは React(`react`、`react-dom`)と、会話の枠(`studio-talk`。上の「会話の枠」)だけ。
- 引き継ぎの書き出しは `~/PrototypeStudio/handoffs/` に置く。書き出すたびに新しいフォルダーを作る。要らなくなったら消してよい。書いたメモは `projects/<試作品の ID>/.studio/handoff-notes.json`。
- 自分で試作品を足すときは、`~/PrototypeStudio/projects/<英小文字・数字・ハイフンの名前>/app/main.jsx` を置き、画面で選んで、「その他」の「開発者向けの詳細」の「ファイルから作り直す」を押す。
