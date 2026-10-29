# LP(site/)の見た目: 幅 1440 と 390

`npm run site` で開く LP を、Playwright の Chromium で撮った記録です。2026-10-29 に取りました。

- 撮ったのは `scripts/site.js` の `startSite` で配ったページです。外への通信はありません
- 「layers」は、分解のアニメを 5 番目の層(ガードレール)までスクロールしたところです。止めた層が光り、「止めた」の印が出ます
- 画面の中の絵は、`npm run media` が撮った Studio の本物の画面です。例のデータは、どれも架空です
- LP を直したら、ここの絵は古くなります。撮り直すかは、そのときに決めます

| 幅 | ライト | ダーク |
|---|---|---|
| 1440、見出し | [lp-1440-light-top.png](lp-1440-light-top.png) | [lp-1440-dark-top.png](lp-1440-dark-top.png) |
| 1440、分解(05 / 06) | [lp-1440-light-layers.png](lp-1440-light-layers.png) | [lp-1440-dark-layers.png](lp-1440-dark-layers.png) |
| 390、見出し | [lp-390-light-top.png](lp-390-light-top.png) | [lp-390-dark-top.png](lp-390-dark-top.png) |
| 390、分解(05 / 06) | [lp-390-light-layers.png](lp-390-light-layers.png) | [lp-390-dark-layers.png](lp-390-dark-layers.png) |
| 390、`prefers-reduced-motion`(止まった絵) | [lp-390-reduced-motion.png](lp-390-reduced-motion.png) | |
