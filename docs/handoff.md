# 引き継ぎの形(handoff、形式 4)

- 状態: **仮**(2026-10-28)。出典のタスク: jyoka/tasks#280(親 PRD: jyoka/tasks#269)。形式 2 は jyoka/tasks#313([harness.md](design/harness.md) の 5 節、基準 S7)。形式 3 は jyoka/tasks#344([agent-simulation.md](design/agent-simulation.md) の 4.5、基準 S6、S7)。形式 4 は jyoka/tasks#392([user-journey.md](design/user-journey.md) の J8。原則 5「理由を残す」、原則 7「信頼できる」)
- 作るところ: `src/server/handoff.js`。形式 4 で足した中身を読むところは `src/server/handoff-decisions.js`。会の終わりの成果物(K5、jyoka/tasks#395)を読むところは `src/server/closing.js`。画面は段の道筋の「9 渡す」の「本番開発へ渡す」と、会の終わりの画面の「書き出す」(どちらも同じものを書き出す)

試作品を本番開発の担当者に渡すときに、Studio が書き出すフォルダーの形です。中身は決まった手順で作ります。AI の判断は入れません(ADR-0001、Stripe の Minions の考え方)。標準化する契約は、使われ方を見て直します(親 PRD)。

形式 2 では、目録(`app/prototype.json`)、シナリオ(`app/scenarios/`)、最新の証拠の要約を、`handoff.json` に機械が読める形で入れます。本番で作る人や AI が、試作品の意図、制約、確かめ方を、手で写さずに受け取れるようにするためです。

形式 3 では、構成(`app/composition.json`、`app/compositions/`)、ツールの宣言、前提、プロンプトの枠、場面(`app/evals/`)と、最新の場面の回し(`npm run evals`)の要約を足しました。本番の担当者が、ツールの仕様と、ガードレールのどの層が効いたかを、そのまま読めるようにするためです。

形式 4 では、決めたことと理由を足しました。目的の文書、設計の段ごとの決定と理由、質の見直しの結果、人に見せた答え、AI 構成書と承認の記録、既定の素材の出典とライセンスです。開発の担当者が、何を、なぜこの作りにしたのか、何を確かめていないのかを、聞き返さずに読めるようにするためです。どれも Studio が持つ記録(`.studio/`)から読むだけで、AI の判断は入れません。

形式 4 には、会の終わりの成果物も足しました(K5)。7 つの成果物(要件の文書、データ設計、構成の図、AI 構成書、試作品、場面の一覧、未決事項)の状態、要件の文書、データ設計、構成の図、直した記録の一覧、未決事項の持ち主と期日です。要件の文書の項目から、元の要点か、それを変えたコメントと直した記録へたどれます。項目を足しただけで、前の項目の形は変えていないので、`formatVersion` は 4 のままです。

## 置き場所

`<STUDIO_HOME>/handoffs/<試作品の ID>-<年月日>-<時分秒>/`(既定は `~/PrototypeStudio/handoffs/`)

- 作る AI が書ける `app/` とも、Studio だけが書く `.studio/` とも別の場所にする。
- 書き出すたびに新しいフォルダーを作る。前のものは消さない。
- 書きかけは `.<名前>.tmp` に作り、終わってから名前を変える。失敗したら消す。

## 中身

| ファイル | 中身 |
|---|---|
| `README.md` | 人が読む資料。目的、目的の文書、作る AI が書いた意図と制約(目録)、会の終わりの成果物(7 つの状態、要件の文書、データ設計、直した記録の一覧、未決事項の持ち主と期日)、設計の段ごとの決定と理由、AI 構成の審査(AI 構成書)、決まったこと、未決事項、実機・モック・未接続の一覧、プロダクト内 AI の設定、試した会話と状態、構成とツール(模擬)、場面と最新の回し、シナリオ、最新の証拠、質の見直し、人に見せた答え、素材の出典とライセンス、ソースの一覧、版、変更の経緯、確かめていないこと、入れていないもの |
| `handoff.json` | 機械が読む資料。下の「handoff.json」 |
| `app/` | 試作品のソース(作業中の `app/` の写し)。目録の `app/prototype.json` とシナリオの `app/scenarios/` も入る。秘密を入れるファイルは外す |
| `ai/system-prompt.md` | プロダクト内 AI を実モデルで動かすときの指示の全文。抽出の指示と、言い方の指示(`ai.json` の `instructions` と Studio の決まり)の 2 つ。AI のない試作品にはない |
| `ai/response-schema.json` | 実モデルに求める応答の形(JSON スキーマ)。`extract` は抽出の形(`updates` と `intent`)、`phrase` は言い方の形(`reply`)。AI のない試作品にはない |
| `materials/default/` | 既定の素材の出典の記録(`source.json`)とライセンスの文(`licenses/`、`licenses-upstream/`)。Studio の `materials/default/` の写し。どの書き出しにも入る |
| `materials/tokens.json`、`tokens.css`、`source.json` | つないだトークンか、有効にした部品と指針があるときだけ(下の「materials」) |

## 区分

| 区分 | `kind` | 意味 |
|---|---|---|
| 実機 | `real` | 試作品の中で、本物が動いている(画面のコード、実モデルで確かめた応答) |
| モック | `mock` | 決まった規則や架空のデータが、本物の代わりをしている |
| 未接続 | `missing` | 試作品にはない。本番で作る |

どの試作品にも出る行(画面と操作、データ、サーバーと保存、外部の API と通信、ログイン、本物のデータ)と、見つけたものから出る行(プロダクト内 AI の実モデルとモック、会話と状態の置き場、AI の本番の接続、模擬のエージェント、ツール(宣言)、会話の枠(`studio-talk`))がある。題材(求人など)には依存しない。

構成のある試作品では、次の行も足す。

- 「模擬のエージェント」(モック): 構成の `agent` の参加者は、モックの決まりか、相手のモデルの代わりの Claude Code で動く。相手の本物のエージェントではない。
- 「ツール(宣言)」(実機): `tools.json` の宣言を Studio のツールの口が動かし、ツールの守りは試作品の中で実際に効く。本番の API の仕様の見本になる。
- 「会話の枠(studio-talk)」(モック): 試作品が `studio-talk` を import しているとき。部品のコードは Studio の中にあり、書き出しに入らない。

目録があれば、次の行も足す。

- 「データ」の行は、目録の `data`(架空のデータの宣言)を出す。目録に `data` がなければ、今までどおりファイルの名前と中から推し量る(手がかり、推定)。
- 目録の `unimplemented` の 1 つずつを、「未接続」の行にする(`item` はその文)。
- 目録の `constraints` を、「未接続」の「試作品の制約(目録)」の行にまとめる。

書き出した人のメモ(`notes` の目的、決まったこと、未決事項)と、作る AI が目録に書いた `intent` は別のもの。両方を残し、README では並べる。

## handoff.json

| 項目 | 中身 |
|---|---|
| `format`、`formatVersion` | `"prototype-studio-handoff"`、`4`。形を変えるときは `formatVersion` を上げる |
| `createdAt`、`studioVersion` | 書き出した日時(UTC)と、Studio の版 |
| `project` | `id`、`title` |
| `notes` | 書き出した人のメモ。`purpose`(目的)、`decided`(決まったこと)、`undecided`(未決事項) |
| `working` | 作業中が保存版と同じか(`files`、`versionId`、`conversation`)と、その説明(`text`) |
| `capabilities[]` | `kind`、`item`、`prototype`(試作品での中身)、`production`(本番でやること)、`evidence`(根拠のファイルと行) |
| `prototype` | 目録。下の「prototype」 |
| `scenarios` | シナリオ。下の「scenarios」 |
| `evidence` | 最新の証拠の要約。下の「evidence」 |
| `simulation` | 構成、ツール、前提、プロンプトの枠、場面と、最新の場面の回しの要約。下の「simulation」 |
| `materials` | 素材の出典とライセンス。既定の素材(`default`)はいつも入る。つないだトークン(`tokens`、J4)と有効にした部品と指針(`guides`、J5)と部品のパッケージ(`packages`、J5 の後半)は、あるときだけ。下の「materials」 |
| `purpose` | 目的の文書(J1)。下の「purpose」 |
| `design` | 設計の段ごとの決定と理由(J2)。下の「design」 |
| `quality` | 質の見直しの結果(J6)。下の「quality」 |
| `shows` | 人に見せた答え(J7)。下の「shows」 |
| `review` | AI 構成の審査の状態と、AI 構成書の写しと承認の記録。下の「review」 |
| `requirements` | 要件の文書(K5)。下の「requirements」 |
| `dataDesign` | データ設計(K2 で選んだ案。K5)。下の「dataDesign」 |
| `fixRecords[]` | 直した記録の一覧(K3 の記録。K5)。下の「fixRecords」 |
| `closing` | 会の終わりの 7 つの成果物の状態、構成の図、未決事項の持ち主と期日(K5)。下の「closing」 |
| `openQuestions[]` | 未決事項。`from` は `person`(書き出した人)か `studio`(Studio が見つけたもの) |
| `ai` | プロダクト内 AI の設定(`fields`、`initialState`、`mock`)、書き出したときの接続(`real` は実際の AI モデルか)。なければ `null` |
| `conversation` | 書き出したときの会話と状態。AI の発言には `via`(接続)、`viaLabel`、`real` が付く。`via` が `null` の発言は、設定の固定文(あいさつ) |
| `source` | 入口(目録の `entry`)、使えるライブラリ(npm のパッケージだけ)、試作品が import している Studio の中の部品(`studioParts`。例: `studio-talk`。コードは書き出しに入らない)、ファイル(パス、バイト、SHA-256)、本番でつなぐ必要があるコードの印(`signs`: `network`、`storage`、`todo`)、架空のデータのファイル(`dataFiles`)とその出どころ(`dataFrom`: 目録の宣言なら `manifest`、推定なら `guess`)、メールアドレスと電話番号らしいものの場所(`personalData`) |
| `versions[]` | 保存した版の番号、名前、種類、日時 |
| `requests[]` | 作る AI の欄の依頼(Studio を起動してからのもの)と、変わったファイル |
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
| `run.gates[]` | 最後のラウンドの関門ごとの結果。`id`(G1〜G4、GE、G5、G6)、`label`、`status`(`passed`、`failed`、`unverified`、`unchanged`、`skipped`)、あれば `summary`(失敗の要約)、`reason`(未確認の理由)、`errorCount` |
| `run.reports[]` | 最後のラウンドの観察の report と、関門 GE の場面の結果の要約。`gate`、`file`、`verdict`、`startedAt`、`appDigest`、`stale`、`errorCount`、`scenarios[]`(`name`、`base`、`file`、`verdict`。GE は空) |

証拠が古いとき、分からないとき、記録がないとき、関門をすべては通っていないときは、Studio が `openQuestions` にも書く。

### simulation

書き出した `app/` の写しをビルドして読んだもの(ビルドの検査を通ったもの)と、最新の場面の回しの要約。構成のファイルのない試作品(構成 B)では `compositions` が空で、AI の設定は `ai` にある。

| 項目 | 中身 |
|---|---|
| `compositions[]` | 構成。`file`、`default`(既定の構成か)、`name`、`driver`、`participants[]`(`id`、`kind`、`label`、`owner`。`agent` は `prompt`、`tools`、`mock`。`harness` は `ai`、`returnTo`)、`tools`(ツールの宣言のファイル)、`handoffs`、`delegations`(マスターとサブの委任の辺。書いた構成だけ)、`guards`(層、持ち主、`enforce`)、`surface`、`assumptions`、`limits` |
| `tools[]` | ツールの宣言のファイルごと。`file`、`owner`、`tools[]`(`name`、`description`、`owner`、`inputSchema`、`do`、`guards`) |
| `assumptions[]` | 前提(相手の仕様の推測)。ファイルの中身のままと、`file`、`digest`(SHA-256) |
| `prompts[]` | プロンプトの枠の文のファイル。`file`、`chars`(中身は写した `app/` にある) |
| `evals[]` | 場面。`file`、`id`、`kind`、`about`、`checks`(確かめの名前の並び) |
| `latestRun` | 最新の場面の回し(`.studio/evals/<回しの ID>/result.json` のうち、始めた日時が最も新しいもの)の要約。なければ `null` |
| `latestRun.file`、`report`、`id` | 結果と比べる表の場所(試作品のフォルダーからの相対)と、回しの ID。全体は引き継ぎに入れない |
| `latestRun.status`、`verdict`、`stopReason` | `done` か `stopped`(上限か中断で止めた)と、その理由。`verdict` は `passed`、`failed`、`stopped` |
| `latestRun.appDigest`、`stale` | 回した `app/` の指紋と、古いか(`evidence.run.stale` と同じ決まり) |
| `latestRun.real`、`withoutPromptGuards`、`totals` | 実モデルで回したか、プロンプトの頼みを外したか、場面の数の合計 |
| `latestRun.groups[]` | 組ごと。`composition`、`compositionDigest`、`assumption`、`assumptionDigest`、`connection`、`real`、`round`、`summary`(比べる表の 1 行の値)、`risky[]`(危ない場面の `id`、`verdict`、`outcome`(止まったか。`stopped`、`not-stopped`、決まらなければ `null`)、`stoppedBy`(止めた層。`tool`、`output`、`prompt-or-model`。止まったときだけ)、`toolBlocks`、`asked`) |
| `latestRun.failures[]` | 通らなかった確かめ(20 件まで)。`eval`、`file`、`check`、`expected`、`actual` |

場面があるのに回した結果がないとき、最新の回しが古いとき、モックでだけ回したとき、途中で止まったとき、前提(推測)があるときは、Studio が `openQuestions` にも書く。

### purpose

`.studio/intent.json`(目的の画面)を読んだもの。文は伏せてから入れる。聞き出しの問いと答えの全部は入れない。

| 項目 | 中身 |
|---|---|
| `status` | `none`(聞き出していない)、`interviewing`(聞き出しの途中)、`draft`(下書き)、`decided`(人が「これで決める」を押した)、`skipped`(飛ばした) |
| `decidedAt`、`skippedAt` | 決めた日時と、飛ばした日時 |
| `sentence` | 最初の 1 文 |
| `doc` | `who`(誰)、`problem`(何の問題)、`scene`(場面)、`success`(成功の印)、`notDoing[]`(しないこと)、`undecided[]`(決めていないこと)。`none` のときは `null` |

### design

`.studio/design.json`(設計の案内)を読んだもの。理由は選んだ案に付いていた理由で、案を出した日の推測。測った結果ではない。

| 項目 | 中身 |
|---|---|
| `status`、`decidedAt`、`skippedAt` | `none`(使っていない)、`drafting`(決めている途中)、`decided`(「この設計で作る」を押した)、`skipped`(飛ばした)と、その日時 |
| `optionsDate` | 案を出した日 |
| `steps[]` | 6 つの段(問題、使う人、場面、データ、エージェントの構成、画面)。`none` のときは空。`id`、`label`、`question`、`chosen`(選んだ案の ID。`custom` は自分の言葉、`keep` は今の構成のまま)、`decision`(決めたこと)、`reason`(選んだ案の理由)、`note`(選んだ人のメモ)、`source`(`ai` か Studio の決まった案の `fixed`)、`decidedAt`、`stale`(前の段を選び直したので確かめ直しが要る)、`others[]`(選ばなかった案の `title` と `reason`) |
| `scenes[]` | 場面の段で決めた場面。`category`(`normal`、`unknown`、`refuse`、`slow`、`human`)と `text` |
| `composition` | 構成の段の決定。`chosen`、`rejected[]`(選ばなかった形の `option` と `reason`)、`outOfOrder`(簡単な形から順の問いを飛ばした)、`at` |

### quality

画面の「質の見直し」と同じ表(`src/server/quality.js` の `readQuality`)。「直す」の依頼の文は、作る AI への頼みなので入れない。

| 項目 | 中身 |
|---|---|
| `summary` | 状態ごとの行の数。`fix`(直す)、`ok`(問題なし)、`info`(目安なし)、`unseen`(まだ見ていない)、`na`(当てはまらない) |
| `audit` | 画面の検査(人の「確かめる」の観察)の日時、画面幅、古いか(`stale`)。測っていなければ `null` |
| `scenes` | 表が使った場面の回しの日時、本物の AI か、状態、古いか。回していなければ `null` |
| `rows[]` | 11 行。`id`、`group`(`measured` か `judged`)、`label`、`status`、`result`、`why`(なぜ大事か)、`fix`(直し方)、`places[]`(場所。10 まで)、`note` |

### shows

`.studio/show.json`(人に見せる)を読んだもの。文は伏せてから入れる。版の ID と日時は伏せない。見せた相手は役で書く決まりだが、名前を書いても見分けられない。

| 項目 | 中身 |
|---|---|
| `questions` | 今の目的の文書から作る問い。`source`(`success` か `fallback`)と `items[]` |
| `broken` | 答えのファイルを読めなかったか。読めた答えだけを入れる |
| `records[]` | 見せて残した答え。`versionId`、`versionNumber`、`versionName`(版が消えていれば `null`)、`answeredAt`、`viewer`(相手の役)、`answers[]`(`question`、`answer`) |

### review

AI 構成の審査([ai-architecture-review.md の 6 節](design/ai-architecture-review.md#6-ai-構成書))。書き出す `app/` の写しの指紋を、AI 構成書の指紋と比べる。人が手で `app/` を直した場合もここで分かる。

| 項目 | 中身 |
|---|---|
| `flag` | `.studio/project.json` の `review`。`none`(審査を受けていない)、`required`、`skipped` |
| `status` | `none`、`skipped`(審査なし)、`missing`(要るのに AI 構成書を読めない)、`drafting`(承認の途中か、承認と違う)、`approved`(承認済みで、今の構成と同じ)、`stopped`(関門 GA で止めた) |
| `matches`、`changed[]` | 今の構成が AI 構成書と同じか(AI 構成書がなければ `null`)と、指紋が変わった項目 |
| `items[]` | 4 つの項目(`composition`、`harness`、`data`、`stack`)。`label`、`needs`(要る役)、`approved`(今の指紋で承認がそろっているか)、`by[]`(`role`、`roleLabel`、`pressedBy`、`spokenBy`、`at`、`valid`) |
| `approvedAt`、`approvedUnmeasured` | 4 つの承認がそろった日時と、場面の数がないまま承認したか |
| `skipped` | 審査を飛ばしたときの `at`、`by`、`reason` |
| `record` | AI 構成書(`.studio/reviews/<審査の ID>/architecture.json`)の写し。文は伏せる処理を通す。押した人と声に出した人の名前は承認の記録なので残る(申告の名前。伏せる処理はメールアドレスなどの形だけを伏せ、名前だけの文字列は見分けられない)。指紋(`basis`、`evidence`、`fingerprint`、承認の `digest`)は伏せない(伏せると照合できない)。画面へのコメント(種類が「構成」)から審査に戻したときだけ、戻したコメント(`comments`。番号、文、時刻)が入る(K3) |

### requirements

要件の文書(field-session.md の 3 節)。目的の文書(`.studio/intent.json`)、整理の板(`.studio/organize.json`)の項目、2 人が承認した要件のコメント(`.studio/comments.json`)から作る。整理の板のデータの欄は入れない(`dataDesign` に載る)。文は伏せる。

| 項目 | 中身 |
|---|---|
| `status` | `none`(目的の文書も板の項目もない)、`draft`(下書き)、`confirmed`(決める人が整理の板で「この理解で合っている」を押した) |
| `confirmedAt`、`purposeStatus` | 押した日時と、目的の文書の状態(`purpose.status` と同じ) |
| `sections[]` | 7 つの節。`id`(`purpose`、`user`、`scene`、`requirement`、`rule`、`notDoing`、`success`)、`label`、`items[]` |
| `sections[].items[]` | `id`(板の項目は `i<n>`、目的の文書は `purpose-…`、コメントは `comment-<番号>`)、`text`、`from`(`purpose` 目的の文書、`point` 元の要点がある、`checked` 人が確かめた、`guess` 推測、`comment` 承認したコメント)、`sources[]`(元の要点の `n` と `text`)、`guess`、`comment`(`number`、`status`、`statusLabel`、`recordId`。コメントから来た項目だけ) |
| `counts` | `items`(項目の数)、`guesses`(推測の印の数)、`checkedRatio`(推測の印が残っていない割合。項目がなければ `null`) |

### dataDesign

データ設計(`.studio/design.json` の `steps.data` で選んだ案。K2)。型と細かい決まりは会の後に決めるので入れない。文は伏せる。

| 項目 | 中身 |
|---|---|
| `status` | `none`(選んでいない)、`chosen`(選んだ)、`stale`(前の段を選び直したので確かめ直しが要る)、`skipped`(設計の案内を飛ばした) |
| `title`、`detail`、`reason`、`note`、`source`、`decidedAt` | 選んだ案の題、中身、理由(案を出した日の推測)、選んだ人のメモ、案を出したのが AI か Studio の決まった案か、選んだ日時 |
| `entities[]` | 覚えておくもの。`name`、`about`、`writer`(誰が書くか)、`byStudio`(Studio が足した「聞いたことのメモ」か)、`fields[]`(`name`、`kind`、`kindLabel`、`to`(つながりの先)、`examples`、`sources`(元にした整理の板の項目の ID)) |
| `links[]` | つながり。`from`(1 の側)、`to`(多の側)、`label` |
| `heard[]` | 整理の板のデータの欄。`id`、`text`、`onDesign`(選んだ案に載っているか) |

### fixRecords

直した記録(`.studio/fix-records/<記録の ID>/record.json`。K3、collaboration.md の 5 節)を、作った順に並べたもの。前と後の画面の写しは入れない。文と名前は伏せる。

| 項目 | 中身 |
|---|---|
| `id`、`status`、`createdAt` | 記録の ID、状態、作った日時 |
| `comment` | `number`、`text`、`kind`、`kindLabel`、`placeWords`(画面の場所)、`author`、`reactions` |
| `approval` | `approvers[]`(`role`、`roleLabel`、`pressedBy`、`spokenBy`、`at`)と、そろった日時 `completedAt` |
| `request` | 作る AI に渡した依頼の文 |
| `versions` | 直す前と後の版(`id`、`number`、`name`) |
| `changes` | 変わったファイル(`files`)、要約(`summary`)、記録が持つ「変えた要件の項目」(`requirementItems`。K3 では空) |
| `requirementItem` | 要件の文書の中の項目の ID(要件のコメントで、文書に載っているときだけ。ほかは `null`) |
| `gates` | 関門の結果(`status`、`run`、`results[]`) |
| `confirmation`、`events[]` | 「直った」か「戻した」を押した人と日時、起きたことの並び |

### closing

会の終わりの成果物(field-session.md の段 7、user-journey.md の K5)。画面の会の終わりと同じ関数(`closing.js` の `describeClosing`)で作る。

| 項目 | 中身 |
|---|---|
| `present` | 7 つのうち、ある(`missing` でない)成果物の数 |
| `deliverables[]` | 7 つの成果物。`id`(`requirements`、`dataDesign`、`composition`、`review`、`prototype`、`scenes`、`openItems`)、`label`、`status`(`ready` そろった、`draft` 下書き、`missing` ない)、`statusLabel`、`note`(中身の 1 行)、`where`(handoff.json の中の場所) |
| `figure` | 構成の図。`nodes[]`(`id`、`kind`(`person`、`ai`、`code`、`tool`)、`label`)と `edges[]`(`from`、`to`、`label`)。AI 構成の審査の画面の図と同じ作り |
| `openItems[]` | 未決事項。`key`(持ち主を結ぶ印)、`from`(`conflict`、`unasked`、`guess`、`empty`、`purpose`、`design`、`review`、`comment`)、`fromLabel`、`text`、`owner`(持ち主。なければ空)、`due`(期日 `YYYY-MM-DD`。なければ空) |
| `unowned` | 持ち主のない未決事項の数。1 以上なら、Studio が `openQuestions` にも書く |
| `timeline` | 段ごとの時刻(K6)。`stages[]`(`key`(`start`、`listen`、`organize`、`review`、`prototype`、`show`、`fix`、`closing`)、`label`、`mark`(時刻を残す印)、`planMinutes`(60 分の型の目安。仮)、`at`、`elapsedMs`(同意からの時間))、`reached`(時刻のある段の数)、`toShowMs`(見せられるまでの時間)、`fixes[]`(`recordId`、`comment`、`approvedAt`、`fixedAt`、`checked`(直した版の自動の確かめが通ったか)、`ms`。承認から直った版まで。`checked` が false なら null)、`longestFixMs`、`targets`(`showMinutes`、`fixMinutes`。どちらも仮)。会ではない試作品は `reached` が 0 で、`fixes` は空 |

持ち主と期日は `.studio/closing.json`(`formatVersion`、`owners`: `{ key: { owner, due, at } }`)に置く。未決事項の文が変わると `key` が変わり、持ち主なしに戻る。

段ごとの時刻は `.studio/timeline.json`(`formatVersion`、`stages`: `{ key: 時刻 }`)に置く。Studio が、段の印が初めて付いたときに残し、上書きしない。会を始めた試作品では、書き出しそのものを会の終わりの印にする(まだ残っていなければ、書き出した時刻を入れる)。README には、時刻が 1 つ以上あるときだけ「段ごとの時刻」の節を書く。

### materials

| 項目 | 中身 |
|---|---|
| `default.name`、`decidedIn` | 既定の素材の名前と、決めた文書 |
| `default.file` | 書き出しの中の出典の記録(`materials/default/source.json`) |
| `default.roles[]` | 役(土台、部品、色、アイコン、字)と、そのパッケージと中身 |
| `default.licenses` | ライセンスごとのパッケージの数 |
| `default.packages[]` | `name`、`version`、`license`、`source`(出典のリポジトリ)、`licenseFile`(書き出しの中のライセンスの文)、`imported`(試作品が直に import しているか) |
| `tokens.files` | 書き出しの中のファイル。`tokens`(`materials/tokens.json`。元のファイルの写し)、`css`(`materials/tokens.css`。Studio がビルドで足す CSS)、`source`(`materials/source.json`。つないだ、外したの履歴) |
| `tokens.spec`、`fileName`、`sha256`、`count` | 形の名前、元のファイルの名前、中身の指紋、トークンの数 |
| `tokens.source`、`reason`、`connectedAt` | 誰の素材か、つないだ理由、つないだ日時 |
| `tokens.roles` | 役割(`background`、`text`、`action`、`danger`、`font`)に当てたトークンの場所。既定の素材のままなら `null` |
| `tokens.variables[]` | CSS の変数の名前 |
| `guides[]` | 有効にした部品と指針(J5)。1 つの種類に 1 つ。写しは `app/design/` にあり、ソースに入っている |
| `guides[].kind` | `guides`(指針の文)か `storybook`(Storybook の部品の一覧) |
| `guides[].source`、`license`、`reason`、`scope`、`enabledAt` | 誰の素材か、使ってよいか(ライセンスの答え)、有効にした理由、範囲(`project` か `all`)、有効にした日時 |
| `guides[].files[]` | 写しの場所(`copy`)と中身の指紋(`sha256`) |
| `guides[].componentCount`、`externalUrls` | 部品の数、外への URL の数 |
| `packages[]` | 有効にした部品のパッケージ(J5 の後半)。ソースはこの名前で import している |
| `packages[].name`、`version`、`file`、`sha256` | パッケージの名前と版、書き出しの中の受け取ったファイル(`materials/packages/<名前>-<版>.tgz`。`@scope/` の名前はフォルダーになる)、その指紋 |
| `packages[].source`、`license`、`detectedLicense`、`reason`、`enabledAt` | 誰の素材か、使ってよいか(ライセンスの答え)、パッケージに書いてあったライセンス、有効にした理由、有効にした日時 |
| `packages[].exports`、`externalCalls` | 使える名前(export)、外への通信(URL と通信の道具)の数 |

`materials/source.json` には、トークンと部品と指針と部品のパッケージの、つないだ・外したの履歴が入る。人が書いた文(誰の素材か、理由、ライセンスの名前)は伏せる。

## 決まり

- ビルドできない状態は書き出さない(版の保存と同じ)。
- 秘密情報らしい文字列(API キー、トークン、秘密鍵、鍵らしい名前の変数に入れた値)が `app/` にあると、書き出さない。画面には場所と種類だけを出し、値は出さない。
- 同じ探し方を、Studio が `app/` の外から足す中身(`README.md`、`handoff.json`、`ai/`。証拠の要約を含む)にも使う。見つけたら書き出さず、`handoff.json:行` の形で場所を出す。
- 証拠の要約の文(関門の `summary` や `reason`)は、作る run の記録のまま入れる。伏せずに、上の探し方で秘密を止める。
- `.env`、`.env.*`、`*.pem`、`*.key`、`*.p12`、`*.pfx`、`id_rsa` などは、中を見ずに外す。外したことは README と `excluded` に書く。見本の `.env.example`、`.env.sample`、`.env.template` は外さず、ほかのファイルと同じく中を調べる。
- 会話、メモ、依頼の文、試作品の名前、版の名前、目的の文書、設計の案と人のメモ、人に見せた答え、AI 構成書の文、要件の文書、データ設計、直した記録、未決事項と持ち主の中の、鍵らしい文字列と、メールアドレス、電話番号、住所、氏名らしい文字列は伏せる(`src/server/redact.js`)。改行は 1 行にまとめ、表の行を足させない。ソースの中のものは変えずに、未決事項に場所を書く。
- AI の実行の記録、作る AI の返事、ログインの情報、環境変数、PC のフォルダーの場所は入れない。
- 書き出しの間は、版の保存と同じ印を使い、作る AI、ビルド、版の操作、プロダクト内 AI への発言を断る。
- 形で見分けるので、秘密や個人のデータを見落とすことがある。架空のデータだけで試す決まりは変わらない。

## 形式 1 からの変更

- `formatVersion` を `2` にした。
- `prototype`、`scenarios`、`evidence` を足した。
- `source.dataFrom` を足した。`source.dataFiles` は、目録の `data` があればその宣言になる。`source.entry` は目録の `entry` を使う。
- 目録の `unimplemented` と `constraints` から、「未接続」の行を足した。

## 形式 2 からの変更

- `formatVersion` を `3` にした。
- `simulation` を足した。`source.studioParts` を足した(`source.libraries` は npm のパッケージだけのまま)。
- 構成のある試作品で、「模擬のエージェント」「ツール(宣言)」「会話の枠(studio-talk)」の行を足した。
- `evidence.run.gates[]` に関門 GE が入る。`evidence.run.reports[]` に GE の場面の結果の要約が入る。

## 形式 3 からの変更

- `formatVersion` を `4` にした。
- `purpose`、`design`、`quality`、`shows`、`review` を足した。形の違う記録(手で直したファイルなど)は、形の違う要素を捨てて読み、書き出しは止めない。
- `materials` はいつも入れ、既定の素材の出典とライセンス(`materials.default`)を足した。書き出しに `materials/default/` を足した。
- Studio が見つけたこと(`openQuestions` の `studio`)に、次を足した。目的の文書がない、または決めていない。設計の決定がない、または決めていない。確かめ直しの要る段がある。質の見直しに「直す」がある。画面の検査が古い。人に見せた答えがない。今の構成が AI 構成書の承認と違う。審査が承認の途中、審査なし、AI 構成書を読めない、測らずに承認した。
- README に「目的の文書」「設計の段ごとの決定と理由」「AI 構成の審査(AI 構成書)」「質の見直し」「人に見せた答え」「素材の出典とライセンス」「確かめていないこと」の節を足した。
- K5 で、`requirements`、`dataDesign`、`fixRecords`、`closing` を足した。`openQuestions` に「持ち主のない未決事項がある」を足した。README に「会の終わりの成果物」の節(7 つの成果物、要件の文書、データ設計、直した記録の一覧、未決事項の持ち主と期日)を足した。前の項目の形は変えていないので、`formatVersion` は 4 のまま。
- K6 で、`closing.timeline`(段ごとの時刻、見せられるまでの時間、承認から直った版までの時間)と、README の「段ごとの時刻」の節を足した。`formatVersion` は 4 のまま。

## まだしないこと

- zip などの 1 ファイルにまとめる書き出しと、ブラウザからのダウンロード。
- 保存した版を選んで書き出すこと(いまは作業中だけ)。
- 書き出したものを Studio に読み込む画面(いまは `app/` を手で写す)。
- 利用者の「確かめる」の report の要約。Studio がまだ report を残さない([harness.md の 8 節](design/harness.md#8-実装のカード)の P27 で足す)。
- 版に report の要約を入れること。
- 目的の聞き出しの問いと答えの全部。決めた文書だけを入れる。
