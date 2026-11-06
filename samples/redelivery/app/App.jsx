import { Talk, useStudioTalk } from 'studio-talk';

// 固定の流れの見本。順番はコードが決め、モデルは言葉の読み取りと言い方だけを担当する。
// 会話と記録の店は Studio が持つ。この画面は、同梱の会話の枠(studio-talk)と、記録の店(session.records)を描くだけにする。
export default function App() {
  const talk = useStudioTalk();
  const records = talk.session?.records ?? {};

  return (
    <div className="app">
      <header>
        <h1>しおかぜ便の再配達</h1>
        <p className="note">架空のサービスと架空の荷物です。実在の会社や人、地名とは関係ありません。</p>
      </header>

      <div className="columns">
        <Talk talk={talk} starters={['番号は 1001 です']} placeholder="例: 番号は 1001 です" />

        <aside className="side">
          <section aria-label="受け付けた内容">
            <h2>受け付けた内容</h2>
            <p className="hint">同意の記録がないと、再配達は書かれません。</p>
            <dl>
              <dt>書いてよいか</dt>
              <dd>{records.consent?.agreed ? '書いてよい' : 'まだ聞いていません'}</dd>
              <dt>再配達</dt>
              <dd>{records.redelivery ? `荷物 ${records.redelivery.parcel_no}、${records.redelivery.slot}` : 'まだありません'}</dd>
            </dl>
          </section>
        </aside>
      </div>
    </div>
  );
}
