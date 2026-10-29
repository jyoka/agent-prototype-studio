# U10: 新しい画面のスクリーンショット(P31)

初見で分かる画面([ux-redesign.md](../../../design/ux-redesign.md))がそろった後の画面です。2026-10-29 に撮りました。
人の確かめの手順書は [check.md](check.md) にあります。

- 撮り方: `test/e2e/screenshots.spec.js`(U10)。どれも 1440x900 で、データの置き場は一時フォルダー
- 直す AI は偽の `claude`(既定の起動と同じ形なので、上の帯に開発用の印は出ない)。試作品の中の AI はお試しの AI。実モデルは呼んでいない
- データは、どれも架空
- 見える文字に開発の言葉がないこと(U3)を、撮る前に確かめている。開発者向けの詳細の画像(13)だけは除く

| ファイル | 場面 |
|---|---|
| [U10-01-first.png](U10-01-first.png) | U7: 最初の画面。人の確かめの 5 秒の確かめで見せる |
| [U10-02-talked.png](U10-02-talked.png) | U7: 試作品の中で「カフェで働きたいです」と送った後。案内は 2 番 |
| [U10-03-consent.png](U10-03-consent.png) | U7: 直す欄の例を送ったときの「本物の AI を使う前に」のカード |
| [U10-04-fixing.png](U10-04-fixing.png) | U7: 同意の後、直す AI が作業している |
| [U10-05-fixed.png](U10-05-fixed.png) | U7: 直す AI が終わった後。結果の帯と試し直しの帯。案内は 3 番 |
| [U10-06-retried.png](U10-06-retried.png) | U7: 「同じ発言で試し直す」の後。直す前と後の返事。案内の手順が全部済み |
| [U10-07-unavailable.png](U10-07-unavailable.png) | U8: Claude Code が見つからないときの、直す欄のカード |
| [U10-08-unavailable-talked.png](U10-08-unavailable-talked.png) | U8: カードが出ていても、試作品と話せる |
| [U10-09-band-fixed.png](U10-09-band-fixed.png) | 結果の帯 `fixed`(図書室で「壊して」) |
| [U10-10-band-failed.png](U10-10-band-failed.png) | 結果の帯 `failed`(図書室で「壊して、直せないふりをして」)。試す欄には「試作品を表示できません」 |
| [U10-11-talk-cards.png](U10-11-talk-cards.png) | 見本 A(バイト探し)のトークの枠。カードの一覧 |
| [U10-12-talk-guard.png](U10-12-talk-guard.png) | 見本 A: 同意の前の保存を、ツールの守りが止めた |
| [U10-13-dev-record.png](U10-13-dev-record.png) | 見本 A: その他 → 開発者向けの詳細の「AI の実行の記録」。模擬の会話の中身(参加者、ツール、守り)を開いた |

## 撮り直し方

```sh
npx playwright test test/e2e/screenshots.spec.js
cp test-results/ux/U10-*.png docs/evidence/ux/final/
```

画像は `test-results/ux/` に出ます(git は無視する)。画面を変えたときだけ、ここへ写し直します。
