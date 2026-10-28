import { useState } from 'react';
import { Talk, useStudioTalk } from 'studio-talk';

// 構成 A の見本。相手の会社のエージェント(模擬)がトークを回し、こちらのツール(app/tools.json)を選んで呼ぶ。
// 会話と記録の店は Studio が持つ。この画面は、同梱の会話の枠(studio-talk)と、記録の店(session.records)を描くだけにする。
const THEMES = [
  { value: 'talk', label: 'トークのアプリ風' },
  { value: 'web', label: 'Web のチャット風' },
  { value: 'plain', label: '飾りなし' },
];

const consentText = (consent) => (consent === undefined ? 'まだ聞いていません' : consent.agreed ? '保存してよい' : '保存しない');

function wishText(wish) {
  const parts = [wish.area, wish.minWage !== undefined ? `時給 ${wish.minWage.toLocaleString('ja-JP')} 円以上` : null, wish.note].filter(Boolean);
  return parts.length > 0 ? parts.join('・') : '(中身なし)';
}

export default function App() {
  const talk = useStudioTalk();
  // 見た目。選ぶまでは構成の surface.theme(app/composition.json)
  const [theme, setTheme] = useState(null);
  const records = talk.session?.records ?? {};
  const wishes = records.wishes === undefined ? [] : [].concat(records.wishes);

  return (
    <div className="app">
      <header>
        <h1>そよかぜバイト探し</h1>
        <p className="note">架空のサービスと架空の求人です。実在の会社や店、地名とは関係ありません。相手の会社のエージェントの役は、推測で作った模擬です。</p>
      </header>

      <div className="columns">
        <Talk talk={talk} theme={theme ?? undefined} starters={['みなと町でバイトを探しています', '何を話せばいい?']} placeholder="例: もり台で探しています" />

        <aside className="side">
          <section aria-label="受け取った記録">
            <h2>受け取った記録</h2>
            <p className="hint">案内役がこちらのツールを呼ぶと、ここに記録が入ります。ツールの呼び出しの中身は、Studio の「AI の実行の記録」に残ります。</p>
            <dl>
              <dt>保存してよいか</dt>
              <dd>{consentText(records.consent)}</dd>
              <dt>保存した希望</dt>
              <dd>
                {wishes.length === 0 ? (
                  'まだありません'
                ) : (
                  <ul>
                    {wishes.map((wish, i) => (
                      <li key={i}>{wishText(wish)}</li>
                    ))}
                  </ul>
                )}
              </dd>
            </dl>
          </section>
          <section aria-label="見た目">
            <h2>見た目</h2>
            <label>
              <span className="sr">会話の枠の見た目</span>
              <select value={theme ?? talk.session?.surface?.theme ?? 'talk'} onChange={(e) => setTheme(e.target.value)}>
                {THEMES.map((item) => (
                  <option key={item.value} value={item.value}>
                    {item.label}
                  </option>
                ))}
              </select>
            </label>
          </section>
        </aside>
      </div>
    </div>
  );
}
