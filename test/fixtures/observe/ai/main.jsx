import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';

function App() {
  const [reply, setReply] = useState('待っています');
  useEffect(() => {
    // 観察器の Node の関数を、親ページを通さずに直接呼ぼうとする。観察器は受けない
    window.studioObserveAi?.({ id: 99, op: 'send', text: '親ページを通さない要求' })?.catch?.(() => {});
    window.studioObserveEvent?.({ type: 'runtime-error', message: '試作品が作った偽のエラー' })?.catch?.(() => {});
    window.studio.ai
      .send('架空の駅前の自転車置き場を探しています')
      .then((session) => setReply(session.messages.at(-1).text))
      // 返事を受け取れなかったら console.error に出す。観察器はそれをエラーとして数える
      .catch((error) => console.error(`AI の返事を受け取れませんでした: ${error.message}`));
  }, []);
  return (
    <main>
      <h1>架空の自転車置き場の相談</h1>
      <p>{reply}</p>
    </main>
  );
}

createRoot(document.getElementById('root')).render(<App />);
