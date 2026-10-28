import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';

// 開いたときの会話が、あいさつだけかを確かめてから話す。前の観察の会話が残っていれば console.error を出す
function App() {
  const [reply, setReply] = useState('待っています');
  useEffect(() => {
    window.studio.ai
      .session()
      .then((session) => {
        if (session.messages.length !== 1 || session.state.plant !== null) console.error('前の観察の会話が残っています');
        return window.studio.ai.send('つるの植木を探しています');
      })
      .then((session) => setReply(session.messages.at(-1).text))
      .catch((error) => console.error(`AI の返事を受け取れませんでした: ${error.message}`));
  }, []);
  return (
    <main>
      <h1>架空の植木の相談</h1>
      <p>{reply}</p>
    </main>
  );
}

createRoot(document.getElementById('root')).render(<App />);
