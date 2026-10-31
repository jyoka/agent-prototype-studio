import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Badge, Button, Card, Dialog, Flex, Heading, Text, TextField, Theme } from '@radix-ui/themes';
import '@radix-ui/themes/styles.css';
import '@radix-ui/colors/blue.css';
import { blue } from '@radix-ui/colors';
import { BookOpen, CalendarCheck } from 'lucide-react';

// 既定の素材の見本。CSP に止められた読み込みを画面に書き出す(隔離の E2E と同じ確かめ方)
const violations = [];
document.addEventListener('securitypolicyviolation', (event) => {
  violations.push(event.blockedURI);
  document.getElementById('violations').textContent = violations.join(' ');
});

function App() {
  const [name, setName] = useState('');
  const [open, setOpen] = useState(false);
  useEffect(() => { document.title = '図書室の予約(架空)'; }, []);
  return (
    <Theme accentColor="indigo" grayColor="slate">
      <Flex direction="column" gap="4" p="5">
        <Heading as="h1" size="6"><BookOpen aria-hidden="true" data-testid="icon" /> 図書室の予約(架空)</Heading>
        <Card data-testid="card">
          <Flex direction="column" gap="3">
            <Text as="p" size="3">架空の本「海辺の時計」を予約します。</Text>
            <Badge color="green" data-testid="badge">貸し出しできます</Badge>
            <Text as="label" size="2">
              予約する人の名前
              <TextField.Root value={name} onChange={(event) => setName(event.target.value)} placeholder="架空の名前" />
            </Text>
            <Dialog.Root open={open} onOpenChange={setOpen}>
              <Dialog.Trigger>
                <Button data-testid="reserve"><CalendarCheck aria-hidden="true" /> 予約する</Button>
              </Dialog.Trigger>
              <Dialog.Content>
                <Dialog.Title>予約を確かめる</Dialog.Title>
                <Dialog.Description size="2">{name || '名前なし'} さんの予約です。</Dialog.Description>
                <Dialog.Close><Button variant="soft">閉じる</Button></Dialog.Close>
              </Dialog.Content>
            </Dialog.Root>
          </Flex>
        </Card>
        <div data-testid="color-step" style={{ width: 40, height: 16, background: blue.blue9 }} />
        <p id="violations" data-testid="violations" />
      </Flex>
    </Theme>
  );
}

createRoot(document.getElementById('root')).render(<App />);
