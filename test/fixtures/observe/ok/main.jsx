import { createRoot } from 'react-dom/client';
import './style.css';

// 架空の花屋の品ぞろえ。実在の店や人とは関係ない
const FLOWERS = [
  { name: 'ひまわり', price: 300 },
  { name: 'すずらん', price: 450 },
  { name: 'コスモス', price: 250 },
];

function App() {
  return (
    <main>
      <h1>架空の花屋 ひだまり</h1>
      <ul>
        {FLOWERS.map((flower) => (
          <li key={flower.name}>
            {flower.name} {flower.price} 円
          </li>
        ))}
      </ul>
    </main>
  );
}

createRoot(document.getElementById('root')).render(<App />);
