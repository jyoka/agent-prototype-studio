# 実モデルの閉じたループの E2E の画面

`STUDIO_REAL=1 STUDIO_REAL_EVIDENCE=<このフォルダー> npx playwright test test/e2e/real-loop.spec.js` が撮った Studio の画面。架空のデータだけを使った。

- 日時: 2026-10-28。Claude Code 2.1.312、本人のログイン
- 結果: 通った(38 秒)。作る欄から依頼を送り、1 回目の関門で G5 が失敗し、直すラウンド 1 の後に全関門が通った(`fixed`)
- 起動の回数と費用は、この回の出力に出していない(後で `real-loop の結果:` の行を足した)。数は [real-loop/README.md](../real-loop/README.md) の `npm run check:loop -- --real` の回を見る

| ファイル | 中身 |
|---|---|
| [studio-1-gate-failed.png](studio-1-gate-failed.png) | 1 回目の関門の失敗が作る会話に出たとき |
| [studio-2-run-finished.png](studio-2-run-finished.png) | 直すラウンドの後に終わったとき。試す画面の見出しが変わっている |

画面の「実行ファイル」の欄に、Claude Code の場所(利用者のホームの下)が写っている。ログインの情報、メールアドレス、トークンは写っていない。
