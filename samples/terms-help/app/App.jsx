import { Talk, useStudioTalk } from 'studio-talk';

// 文書の検索(RAG)の見本。約款を条ごとの架空の文書にし、AI が探して読み、条の見出しを書いて答える。
// 会話は Studio が持つ。この画面は、同梱の会話の枠(studio-talk)を描くだけにする。
export default function App() {
  const talk = useStudioTalk();

  return (
    <div className="app">
      <header>
        <h1>しおかぜ便の約款の相談</h1>
        <p className="note">架空のサービスと架空の約款です。実在の会社や人、地名とは関係ありません。</p>
      </header>

      <div className="columns">
        <Talk talk={talk} starters={['荷物が壊れていたら、補償はいくらまでですか']} placeholder="例: 再配達は何回まで無料ですか" />

        <aside className="side">
          <section aria-label="この相談について">
            <h2>この相談について</h2>
            <p className="hint">AI は約款から近い条を探して読み、答えに条の見出しを書きます。</p>
          </section>
        </aside>
      </div>
    </div>
  );
}
