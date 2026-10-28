import { createRoot } from 'react-dom/client';

// 構成 C の確かめ用の試作品(架空)。画面は会話の枠を持たず、studio.ai の返す会話を文で並べるだけ
function App() {
  return <p>架空の受付と相談役(構成 C の確かめ用)</p>;
}

createRoot(document.getElementById('root') ?? document.body.appendChild(document.createElement('div'))).render(<App />);
