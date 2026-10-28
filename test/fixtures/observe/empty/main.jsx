import { createRoot } from 'react-dom/client';

// 何も描かない試作品。エラーは出ないが、画面は空
function App() {
  return null;
}

createRoot(document.getElementById('root')).render(<App />);
