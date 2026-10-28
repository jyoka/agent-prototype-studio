# 引き継ぎの形(handoff、形式 2)

- 状態: **仮**(2026-10-28)。出典のタスク: jyoka/tasks#280(親 PRD: jyoka/tasks#269)。形式 2 は jyoka/tasks#313([harness.md](design/harness.md) の 5 節、基準 S7)
- 作るところ: `src/server/handoff.js`。画面は右の「詳細」の「本番開発への引き継ぎ」

試作品を本番開発の担当者に渡すときに、Studio が書き出すフォルダーの形です。中身は決まった手順で作ります。AI の判断は入れません(ADR-0001、Stripe の Minions の考え方)。標準化する契約は、使われ方を見て直します(親 PRD)。

形式 2 では、目録(`app/prototype.json`)、シナリオ(`app/scenarios/`)、最新の証拠の要約を、`handoff.json` に機械が読める形で入れます。本番で作る人や AI が、試作品の意図、制約、確かめ方を、手で写さずに受け取れるようにするためです。

## 置き場所

`<STUDIO_HOME>/handoffs/<試作品の ID>-<年月日>-<時分秒>/`(既定は `~/PrototypeStudio/handoffs/`)

- 作る AI が書ける `app/` とも、Studio だけが書く `.studio/` とも別の場所にする。
- 書き出すたびに新しいフォルダーを作る。前のものは消さない。
- 書きかけは `.<名前>.tmp` に作り、終わってから名前を変える。失敗したら消す。

## 中身

| ファイル | 中身 |
|---|---|
| `README.md` | 人が読む資料。目的、作る AI が書いた意図と制約(目録)、決まったこと、未決事項、実機・モック・未接続の一覧、プロダクト内 AI の設定、試した会話と状態、シナリオ、最新の証拠、ソースの一覧、版、変更の経緯、入れていないもの |
| `handoff.json` | 機械が読む資料。下の「handoff.json」 |
| `app/` | 試作品のソース(作業中の `app/` の写し)。目録の `app/prototype.json` とシナリオの `app/scenarios/` も入る。秘密を入れるファイルは外す |
| `ai/system-prompt.md` | プロダクト内 AI を実モデルで動かすときの指示の全文。抽出の指示と、言い方の指示(`ai.json` の `instructions` と Studio の決まり)の 2 つ。AI のない試作品にはない |
| `ai/response-schema.json` | 実モデルに求める応答の形(JSON スキーマ)。`extract` は抽出の形(`updates` と `intent`)、`phrase` は言い方の形(`reply`)。AI のない試作品にはない |

## 区分

| 区分 | `kind` | 意味 |
|---|---|---|
| 実機 | `real` | 試作品の中で、本物が動いている(画面のコード、実モデルで確かめた応答) |
| モック | `mock` | 決まった規則や架空のデータが、本物の代わりをしている |
| 未接続 | `missing` | 試作品にはない。本番で作る |

どの試作品にも出る行(画面と操作、データ、サーバーと保存、外部の API と通信、ログイン、本物のデータ)と、見つけたものから出る行(プロダクト内 AI の実モデルとモック、会話と状態の置き場、AI の本番の接続)がある。題材(求人など)には依存しない。

目録があれば、次の行も足す。

- 「データ」の行は、目録の `data`(架空のデータの宣言)を出す。目録に `data` がなければ、今までどおりファイルの名前と中から推し量る(手がかり、推定)。
- 目録の `unimplemented` の 1 つずつを、「未接続」の行にする(`item` はその文)。
- 目録の `constraints` を、「未接続」の「試作品の制約(目録)」の行にまとめる。

書き出した人のメモ(`notes` の目的、決まったこと、未決事項)と、作る AI が目録に書いた `intent` は別のもの。両方を残し、README では並べる。

## handoff.json

| 項目 | 中身 |
|---|---|
| `format`、`formatVersion` | `"prototype-studio-handoff"`、`2`。形を変えるときは `formatVersion` を上げる |
| `createdAt`、`studioVersion` | 書き出した日時(UTC)と、Studio の版 |
| `project` | `id`、`title` |
| `notes` | 書き出した人のメモ。`purpose`(目的)、`decided`(決まったこと)、`undecided`(未決事項) |
| `working` | 作業中が保存版と同じか(`files`、`versionId`、`conversation`)と、その説明(`text`) |
| `capabilities[]` | `kind`、`item`、`prototype`(試作品での中身)、`production`(本番でやること)、`evidence`(根拠のファイルと行) |
| `prototype` | 目録。下の「prototype」 |
| `scenarios` | シナリオ。下の「scenarios」 |
| `evidence` | 最新の証拠の要約。下の「evidence」 |
| `openQuestions[]` | 未決事項。`from` は `person`(書き出した人)か `studio`(Studio が見つけたもの) |
| `ai` | プロダクト内 AI の設定(`fields`、`initialState`、`mock`)、書き出したときの接続(`real` は実際の AI モデルか)。なければ `null` |
| `conversation` | 書き出したときの会話と状態。AI の発言には `via`(接続)、`viaLabel`、`real` が付く。`via` が `null` の発言は、設定の固定文(あいさつ) |
| `source` | 入口(目録の `entry`)、使えるライブラリ、ファイル(パス、バイト、SHA-256)、本番でつなぐ必要があるコードの印(`signs`: `network`、`storage`、`todo`)、架空のデータのファイル(`dataFiles`)とその出どころ(`dataFrom`: 目録の宣言なら `manifest`、推定なら `guess`)、メールアドレスと電話番号らしいものの場所(`personalData`) |
| `versions[]` | 保存した版の番号、名前、種類、日時 |
| `requests[]` | 作る欄の依頼(Studio を起動してからのもの)と、変わったファイル |
| `excluded[]` | 書き出しから外したファイルと理由 |

### prototype

`app/prototype.json` を、ビルドと同じ決まりで読んだもの。形は [configuration.md の目録](configuration.md#試作品の目録appprototypejson)。

| 項目 | 中身 |
|---|---|
| `file` | `"app/prototype.json"`。目録がなければ `null` で、ほかの項目はビルドが使う既定の値 |
| `formatVersion`、`title`、`entry`、`intent`(`purpose`、`tryThis`)、`constraints`、`unimplemented`、`data`(`file`、`about`)、`ai`、`scenarios` | 目録のまま。パスは `app/` からの相対 |

### scenarios

| 項目 | 中身 |
|---|---|
| `folder` | シナリオの置き場所(`app/scenarios` など。目録の `scenarios`) |
| `files[]` | `app/` のシナリオ。`file`、`name`、`viewport`、`steps`(シナリオの手順のまま)、`checks`(手順ごとに確かめることの文) |
| `base[]` | Studio の基本のシナリオ(起動、AI のある試作品ではあいさつ)。`app/` にはなく、関門 G6 がいつも先に回す。形は `files[]` と同じで、`file` はない |

### evidence

最新の作る run(`.studio/runs/<run-id>/run.json` のうち、始めた日時が最も新しいもの)の要約。記録の全体とスクリーンショットは入れない。

| 項目 | 中身 |
|---|---|
| `appDigest` | 書き出したときの `app/` の指紋(ビルドと観察の report と同じ計算) |
| `run` | 作る run の要約。記録がなければ `null` |
| `run.file`、`run.id` | 記録の場所(試作品のフォルダーからの相対)と run の ID |
| `run.status`、`run.rounds` | 結果(`passed`、`fixed`、`failed`、`unverified`、`unchanged` など)と、ラウンドの数 |
| `run.startedAt`、`run.finishedAt` | 始めた日時と終えた日時(UTC) |
| `run.appDigest`、`run.stale` | 確かめた `app/` の指紋と、古いか。`stale` は、指紋が今の `appDigest` と違えば `true`、同じなら `false`、分からなければ `null` |
| `run.gates[]` | 最後のラウンドの関門ごとの結果。`id`(G1〜G6)、`label`、`status`(`passed`、`failed`、`unverified`、`unchanged`、`skipped`)、あれば `summary`(失敗の要約)、`reason`(未確認の理由)、`errorCount` |
| `run.reports[]` | 最後のラウンドの観察の report の要約。`gate`、`file`、`verdict`、`startedAt`、`appDigest`、`stale`、`errorCount`、`scenarios[]`(`name`、`base`、`file`、`verdict`) |

証拠が古いとき、分からないとき、記録がないとき、関門をすべては通っていないときは、Studio が `openQuestions` にも書く。

## 決まり

- ビルドできない状態は書き出さない(版の保存と同じ)。
- 秘密情報らしい文字列(API キー、トークン、秘密鍵、鍵らしい名前の変数に入れた値)が `app/` にあると、書き出さない。画面には場所と種類だけを出し、値は出さない。
- 同じ探し方を、Studio が `app/` の外から足す中身(`README.md`、`handoff.json`、`ai/`。証拠の要約を含む)にも使う。見つけたら書き出さず、`handoff.json:行` の形で場所を出す。
- 証拠の要約の文(関門の `summary` や `reason`)は、作る run の記録のまま入れる。伏せずに、上の探し方で秘密を止める。
- `.env`、`.env.*`、`*.pem`、`*.key`、`*.p12`、`*.pfx`、`id_rsa` などは、中を見ずに外す。外したことは README と `excluded` に書く。見本の `.env.example`、`.env.sample`、`.env.template` は外さず、ほかのファイルと同じく中を調べる。
- 会話、メモ、依頼の文、試作品の名前、版の名前の中の、鍵らしい文字列とメールアドレスと電話番号らしい文字列は伏せる(`src/server/redact.js`)。改行は 1 行にまとめ、表の行を足させない。ソースの中のものは変えずに、未決事項に場所を書く。
- AI の実行の記録、作る AI の返事、ログインの情報、環境変数、PC のフォルダーの場所は入れない。
- 書き出しの間は、版の保存と同じ印を使い、作る AI、ビルド、版の操作、プロダクト内 AI への発言を断る。
- 形で見分けるので、秘密や個人のデータを見落とすことがある。架空のデータだけで試す決まりは変わらない。

## 形式 1 からの変更

- `formatVersion` を `2` にした。
- `prototype`、`scenarios`、`evidence` を足した。
- `source.dataFrom` を足した。`source.dataFiles` は、目録の `data` があればその宣言になる。`source.entry` は目録の `entry` を使う。
- 目録の `unimplemented` と `constraints` から、「未接続」の行を足した。

## まだしないこと

- zip などの 1 ファイルにまとめる書き出しと、ブラウザからのダウンロード。
- 保存した版を選んで書き出すこと(いまは作業中だけ)。
- 書き出したものを Studio に読み込む画面(いまは `app/` を手で写す)。
- 利用者の「確かめる」の report の要約。Studio がまだ report を残さない([harness.md の 8 節](design/harness.md#8-実装のカード)の P27 で足す)。
- 版に report の要約を入れること。
