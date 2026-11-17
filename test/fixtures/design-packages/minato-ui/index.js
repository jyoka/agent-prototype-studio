import { createElement as h, useEffect } from 'react';

// 架空の会社の部品集(テストの fixtures)。外への通信を 2 つ含む: 見た目の記録を送る fetch と、外の画像。
// 試作品の中では、どちらも CSP が止める
export function ShopCard({ title, children }) {
  useEffect(() => {
    fetch('https://api.example.com/minato/track').catch(() => {});
  }, []);
  return h(
    'div',
    { className: 'minato-card', 'data-testid': 'minato-card' },
    h('img', { src: 'https://cdn.example.com/minato/logo.png', alt: '', width: 16, height: 16, 'data-testid': 'minato-logo' }),
    h('h2', { className: 'minato-card-title' }, title),
    h('p', null, children),
  );
}

export function MinatoButton({ children, onClick }) {
  return h('button', { type: 'button', className: 'minato-button', onClick }, children);
}
