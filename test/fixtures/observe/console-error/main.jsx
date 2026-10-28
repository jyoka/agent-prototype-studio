import { useEffect } from 'react';
import { createRoot } from 'react-dom/client';

function App() {
  useEffect(() => {
    console.error('架空の予約の一覧を取り込めませんでした');
  }, []);
  return <h1>架空の予約</h1>;
}

createRoot(document.getElementById('root')).render(<App />);
