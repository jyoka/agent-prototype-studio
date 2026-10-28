# sim-5 の実機: 構成 A の見本とモックの模擬のエージェント

見本「バイト探し(架空・AI と話せる)」を開き、お試しの AI(モックの模擬のエージェント)と話した画面です。2026-10-29 に撮りました。実モデルは呼んでいません。

- 起動: `STUDIO_AGENT=fake` で Studio を起動し、新しい置き場(`STUDIO_HOME` は一時フォルダー)で開いた
- 操作: 「みなと町でバイトを探しています」→「品出しの詳細」→「この求人で希望を保存」→「保存してよい」→「希望を保存する」の順に押した
- データと相手の仕様は、どれも架空

| ファイル | 中身 |
|---|---|
| [studio-part-time-mock.png](studio-part-time-mock.png) | Studio の画面の全体。左の試す欄で、会話の枠(見た目 talk)と、右に「受け取った記録」(記録の店)が出ている。前のターンの選択肢は押せない印になっている |
| [prototype-carousel.png](prototype-carousel.png) | 試作品の枠だけ。検索の返事のカルーセル(カードとボタン)と、詳細のカード |
| [prototype-theme-web.png](prototype-theme-web.png) | 同じ会話を、見た目 web にしたもの |
