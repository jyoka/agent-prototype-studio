import { createRoot } from 'react-dom/client';

// 描画の途中で例外を投げる
function App() {
  throw new Error('架空の在庫表が読めません');
}

createRoot(document.getElementById('root')).render(<App />);
