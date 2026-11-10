import { createRoot } from 'react-dom/client';
import { Card, Flex, Text, Theme } from '@radix-ui/themes';
import '@radix-ui/themes/styles.css';

// 部品と指針の見本。偽の作る AI が、写しを読んで見出しの下に指針と部品の名前を並べる。
// CSP に止められた読み込みを画面に書き出す(隔離の E2E と同じ確かめ方)
const violations = [];
document.addEventListener('securitypolicyviolation', (event) => {
  violations.push(event.blockedURI);
  document.getElementById('violations').textContent = violations.join(' ');
});

function App() {
  return (
    <Theme accentColor="indigo" grayColor="slate">
      <Flex direction="column" gap="4" p="5">
        <h1>架空の案内所</h1>
        <Card>
          <Text as="p" size="3">架空のお店の案内です。</Text>
        </Card>
      </Flex>
      <p id="violations" data-testid="violations" hidden />
    </Theme>
  );
}

createRoot(document.getElementById('root')).render(<App />);
