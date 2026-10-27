# agent-prototype-studio
Prototype and explore AI agent product experiences

## 起動のしかた

いまは段階 0 です。固定のサンプル試作品(架空のデータを使う図書室の画面)を、自分の PC のブラウザで触れます。作る AI(Claude Code)と外部の API はまだつなぎません。

### 要るもの

- Node.js 22 以上。ターミナルで `node --version` を実行して確かめる。なければ https://nodejs.org/ から LTS 版を入れる。
- Claude Code は要らない。

### 手順

1. ターミナルで、このリポジトリのフォルダーに移る。
2. 初回だけ、部品を入れる。

   ```sh
   npm install
   ```

3. 起動する。

   ```sh
   npm start
   ```

4. 既定のブラウザで Studio の画面が開く。開かないときは、ターミナルに出た `http://127.0.0.1:4317/#token=…` の URL をブラウザに貼り付ける。
5. 左の「試作品」から「サンプル: 架空の図書室」を選ぶ。中央の枠の中で、本を探す、借りる、登録するなどを試せる。
6. 止めるときは、ターミナルで Ctrl+C を押す。

### 画面の見方

| 場所 | 中身 |
|---|---|
| 左「試作品」 | 試作品の一覧。ビルドに失敗したものは「ビルドに失敗」と出る |
| 中央 | 試作品そのもの。「開き直す」で最初の状態に戻す。「作り直す」で `app/` のファイルからビルドし直す |
| 右「詳細」 | ビルドの結果と、試作品の中で起きたエラー |

### うまくいかないとき

| 出るもの | すること |
|---|---|
| ターミナルに「Node.js 22 以上が要ります」 | Node.js を入れ直す |
| ターミナルに「必要な部品が入っていません」 | `npm install` を実行してから `npm start` |
| ターミナルに「ポート 4317 は使われています」 | 別のターミナルで Studio が動いていないか確かめる。他のアプリが使っているなら、番号を変えて起動する(下の「環境変数」)。プレビュー用の 4318 は `STUDIO_PREVIEW_PORT` |
| 画面に「鍵がありません」「鍵が合いません」 | ターミナルに出た最新の URL(`#token=` を含む)を開き直す。起動し直すたびに鍵は変わる |
| 画面に「Studio のサーバーにつながりません」 | `npm start` のターミナルが開いたままか確かめる。止めたなら、もう一度 `npm start` |
| 右に「ビルドに失敗しました」 | 出ているファイルと行を直し、「作り直す」を押す |

### データの置き場

- 試作品は `~/PrototypeStudio/projects/<試作品の ID>/app/` に置かれる(Windows は `%USERPROFILE%\PrototypeStudio`)。環境変数 `STUDIO_HOME` で変えられる。
- サンプルは初回の起動で `sample-library` として写される。手を入れた後は上書きしない。最初の状態に戻したいときは、`~/PrototypeStudio/projects/sample-library` を消して起動し直す。
- `app/` の入口は `main.jsx`(または `main.tsx`、`main.js`、`main.ts`)。使えるライブラリは React(`react`、`react-dom`)だけ。
- 自分で試作品を足すときは、`~/PrototypeStudio/projects/<英小文字・数字・ハイフンの名前>/app/main.jsx` を置き、画面で選んで「作り直す」を押す。

### 環境変数

| 名前 | 既定 | 中身 |
|---|---|---|
| `STUDIO_HOME` | `~/PrototypeStudio` | データの置き場 |
| `STUDIO_PORT` | `4317` | Studio の画面のポート。`0` で空いている番号 |
| `STUDIO_PREVIEW_PORT` | `4318` | 試作品を配信するポート。`0` で空いている番号 |
| `STUDIO_NO_OPEN` | なし | `1` でブラウザを自動で開かない |

指定のしかた(例: Studio の画面のポートを 4327 にする):

- macOS のターミナル: `STUDIO_PORT=4327 npm start`
- Windows の PowerShell: `$env:STUDIO_PORT=4327; npm start`

## 開発

| コマンド | 中身 | 時間の目安 |
|---|---|---|
| `npm test` | 単体と結合のテスト(Node の test runner) | 数秒 |
| `npm run test:e2e` | ブラウザの E2E(Playwright の Chromium)。起動手順、サンプルの操作、失敗の表示、試作品の隔離を確かめる | 30 秒以内 |

E2E のブラウザがないときは、`npx playwright install chromium` で入れる。どのテストも実モデルと外部の API を呼ばない。

### 構成

```
bin/studio.js          起動。失敗したときの案内もここで出す
src/server/            Studio のサーバー(画面と API、プレビューの配信、ビルド、app/ の検査)
src/ui/                Studio の画面
src/runtime/runtime.js 試作品に配る runtime。試作品のエラーを Studio の画面に知らせる
samples/library/app/   固定のサンプル試作品(架空のデータ)
test/                  unit、integration、e2e
```

隔離の方式は ADR-0001 に従う。Studio の画面は `127.0.0.1:4317`、試作品は別ポートの `localhost:4318` から、`sandbox` 属性つきの iframe と CSP で開く。

## 設計の記録

- [ADR-0001: ローカル実行と隔離の方式](docs/adr/0001-local-runtime-and-isolation.md)(仮採用)
