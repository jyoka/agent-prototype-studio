# site: Prototype Studio の LP

Prototype Studio の LP(1 ページ)です。今は公開しません。手元で `npm run site` で開きます。

```sh
npm run site    # http://127.0.0.1:4319/ が既定のブラウザで開く。止めるときは Ctrl+C
```

- ポートを変えるときは `STUDIO_SITE_PORT=4320 npm run site`。ブラウザを開かないときは `STUDIO_NO_OPEN=1`
- 配るのは `site/` と、`assets/brand/`、`assets/media/` だけです(`scripts/site.js`)。127.0.0.1 だけで待ちます
- 外から読み込むもの(CDN のスクリプト、Web フォント)はありません。`index.html` の CSP(meta)が、ほかの場所からの読み込みを止めます
- 文と絵の元は [docs/brand.md](../docs/brand.md) と [assets/](../assets/) です。1 文を変えるときは、brand.md の決まりどおり全部を一度に変えます

## 中身

| ファイル | 中身 |
|---|---|
| `index.html` | ページ。見出し、分解のアニメ、今できること、作っているもの、3 手で始める、3 つの問い、フッターの順。日本語と英語を両方書き、`<html lang>` で出し分ける |
| `site.css` | 見た目。色と字は `assets/brand/tokens.css` の変数を使う |
| `site.js` | 言葉と見た目の切り替えと、分解のアニメ。ライブラリは使わない |
| `llms.txt` | ページの中身を文にしたもの |
| `favicon.svg` | タブの絵 |

- 分解のアニメは、スクロールの位置から `--sep`(層の離れ方)と今の層を決め、CSS の 3D の変形で動かします。`prefers-reduced-motion` のときと、高さが 600 px より低い画面(横にしたスマホなど)では動かさず、6 つの層を止まった絵で並べます
- 日本語と英語は、右上のボタンか `?lang=en` で切り替えます。ダークとライトは OS の設定に従い、右上のボタンで切り替えます。どちらも `localStorage` に残します
- 「作っているもの」には画像を載せません。まだ画面がないためです。想像図を本物の画面として載せません
- 画像は `npm run media` が撮った本物の画面です([CONTRIBUTING.md の「画像と動く画像を撮り直す」](../CONTRIBUTING.md#画像と動く画像を撮り直す))。撮り直すと、LP の絵も変わります
- docs へのリンクは、GitHub のリポジトリ(`https://github.com/jyoka/agent-prototype-studio`)を指します。リポジトリが private の間は、外の人は開けません

## 確かめる

```sh
npx playwright test test/e2e/site.spec.js
```

ページが開くこと、ボタンとリンクの先があること、「今できること」と「作っているもの」が分かれていること、3 つの問い(ほかの道具の名前と欄がないこと)、スクロールで層の番号が進むこと、`prefers-reduced-motion` で動かないこと、
スマホの幅(390 と 320)で横にはみ出さないこと、外への通信がないこと、配るのが `site/` と `assets/` だけなことを確かめます。
`npm run test:e2e` にも入っています。

## 公開するとき(運営者が決めたとき)

今はしません。公開を決めたら、次の順で行います。

1. [docs/brand.md の 7 節](../docs/brand.md#7-公開の前に直すもの)の「公開の前に直すもの」を直す。名前を変えるなら、LP の名前の文字も変える
2. リポジトリを public にする。docs へのリンクは、それまで外の人には開けない
3. 出すフォルダーを作る。LP は `assets/` を同じ場所の `assets/` から読むので、写して 1 つにする

   ```sh
   rm -rf _site && mkdir _site
   cp site/index.html site/site.css site/site.js site/llms.txt site/favicon.svg _site/
   mkdir -p _site/assets && cp -R assets/brand assets/media _site/assets/
   ```

4. GitHub Pages に出す。リポジトリの Settings → Pages で、出し方を「GitHub Actions」にし、`_site` を `actions/upload-pages-artifact` と `actions/deploy-pages` で出す workflow を足す。workflow はそのときに作る
5. 出したページを、ダークとライト、日本語と英語、スマホの幅で開いて確かめる。`npx playwright test test/e2e/site.spec.js` と同じことを、出した URL でも見る

`_site/` はコミットしません。独自のドメインを使うかは、そのときに決めます。
