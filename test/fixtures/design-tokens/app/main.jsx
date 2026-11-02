import { createRoot } from 'react-dom/client';
import { Button, Card, Flex, Heading, Text, Theme } from '@radix-ui/themes';
import '@radix-ui/themes/styles.css';
import './sample.css';

// トークンの見本。部品(既定の素材の変数を読む)と、自分で書いた所(トークンの変数を読む)の両方を置く。
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
        <Heading as="h2" size="6">くらし案内の見本(架空)</Heading>
        <Card>
          <Flex direction="column" gap="3">
            <Text as="p" size="3" data-testid="body">架空のお店の案内です。</Text>
            <Button data-testid="action">予約する</Button>
            <Button color="red" data-testid="danger">取り消す</Button>
            <p className="own-note" data-testid="own">自分で書いた所もトークンの変数を読みます。</p>
          </Flex>
        </Card>
      </Flex>
      <p id="violations" data-testid="violations" hidden />
    </Theme>
  );
}

createRoot(document.getElementById('root')).render(<App />);
