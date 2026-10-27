import assert from 'node:assert/strict';
import test from 'node:test';
import { findPersonalData, findSecrets } from '../../src/server/redact.js';

test('書き出しを止める秘密は、取り違えにくい形だけを、行と種類で返す(値は返さない)', () => {
  const text = [
    "const KEY = 'sk-ant-api03-abcdefghijklmnop';",
    "const apiKey = 'abc123def456ghi';",
    'headers: { Authorization: "Bearer abcdefghijklmnop1234" }',
    '-----BEGIN RSA PRIVATE KEY-----',
    'API_KEY=abcd1234efgh5678',
    "stripe: 'sk_live_abcdefghij123'",
    '//registry.npmjs.org/:_authToken=npm_abcdefghijklmnopqrstuvwxyz0123456789',
  ].join('\n');
  assert.deepEqual(findSecrets(text), [
    { line: 1, kind: 'API キーらしい文字列' },
    { line: 2, kind: '鍵らしい名前の値' },
    { line: 3, kind: '認証のトークンらしい文字列' },
    { line: 4, kind: '秘密鍵' },
    { line: 5, kind: '鍵らしい名前の値' },
    { line: 6, kind: 'API キーらしい文字列' },
    { line: 7, kind: 'npm のトークンらしい文字列' },
    { line: 7, kind: '鍵らしい名前の値' },
  ]);
});

test('試作品によくある書き方は、秘密とみなさない', () => {
  const text = [
    "const [password, setPassword] = useState('');",
    "const apiKey = 'your-api-key-here';",
    'const maxTokens = 1000;',
    'const apiKey = config.apiKey2abcdefghijk;',
    "author: '水野 しずく'",
    '<input type="password" name="password" />',
    `const logo = 'data:image/png;base64,${'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk'.repeat(2)}';`,
    'const hash = "3f2a9c0b7e6d5a4f3e2d1c0b9a8f7e6d5c4b3a29";',
  ].join('\n');
  assert.deepEqual(findSecrets(text), []);
});

test('メールアドレスと電話番号らしいものの場所を返す。郵便番号や金額は返さない', () => {
  const text = ['連絡: taro@example.com', '電話 090-1234-5678', '〒123-4567', '時給 1,200 円'].join('\n');
  assert.deepEqual(findPersonalData(text), [
    { line: 1, kind: 'メールアドレス' },
    { line: 2, kind: '電話番号' },
  ]);
});
