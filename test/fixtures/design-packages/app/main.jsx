import { createRoot } from 'react-dom/client';
import { ShopCard, MinatoButton } from '@minato/ui';
import '@minato/ui/style.css';

// 部品のパッケージの見本(架空)。人が有効にした試作品だけが、@minato/ui を import できる。
// CSP に止められた読み込みを画面に書き出す(隔離の E2E と同じ確かめ方)
const violations = [];
document.addEventListener('securitypolicyviolation', (event) => {
  violations.push(event.blockedURI);
  document.getElementById('violations').textContent = violations.join(' ');
});

function App() {
  return (
    <main>
      <h1>架空の案内所</h1>
      <ShopCard title="みなと商店(架空)">架空のお店の案内です。</ShopCard>
      <MinatoButton>案内を見る</MinatoButton>
      <p id="violations" data-testid="violations" hidden />
    </main>
  );
}

createRoot(document.getElementById('root')).render(<App />);
