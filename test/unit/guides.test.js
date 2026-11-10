import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import { checkGuideMaterial, componentsMarkdown, copyName, findExternalUrls, guidesRule, licenseView } from '../../src/server/guides.js';

// 部品と指針の取り込みの検査(docs/design/user-journey.md の J5)。素材はどれも架空
const FIXTURE = new URL('../fixtures/design-guides/', import.meta.url);
const read = (name) => fs.readFile(new URL(name, FIXTURE), 'utf8');
const GUIDES = [
  { path: 'voice.md', text: await read('guides/voice.md') },
  { path: 'look.md', text: await read('guides/look.md') },
];
const STORYBOOK = [
  { path: 'storybook-static/index.json', text: await read('storybook-static/index.json') },
  { path: 'storybook-static/manifests/components.json', text: await read('storybook-static/manifests/components.json') },
];
const OK = { license: 'listed', licenseName: 'MIT' };

test('指針の文は Markdown ごとに写しを作り、外への URL をファイルと行で返す', () => {
  const check = checkGuideMaterial({ kind: 'guides', files: GUIDES, answers: OK });
  assert.equal(check.ok, true);
  assert.deepEqual(check.copies.map((copy) => copy.path), ['design/guides/voice.md', 'design/guides/look.md']);
  assert.equal(check.copies[0].title, '架空の会社の文の決まり');
  assert.equal(check.copies[0].text, GUIDES[0].text);
  assert.deepEqual(check.urls, [{ file: 'look.md', line: 4, url: 'https://fonts.example.com/minato-gothic.css' }]);
  assert.equal(check.license.ok, true);
  assert.match(check.rule, /design\/guides\/voice\.md、design\/guides\/look\.md/);
  assert.match(check.rule, /外への URL/);
});

test('Storybook の書き出し(静的なビルド)から、部品の名前、見本、使い方の文を読む。部品の中の外への URL を部品の名前で返す', () => {
  const check = checkGuideMaterial({ kind: 'storybook', files: STORYBOOK, answers: { license: 'internal' } });
  assert.equal(check.ok, true);
  assert.deepEqual(check.components.map((c) => c.name), ['Button', 'ShopCard', 'Banner']);
  assert.deepEqual(check.components[0].stories, ['Primary', 'Disabled']);
  assert.match(check.components[2].description, /上に出す知らせ/);
  assert.deepEqual(check.copies.map((copy) => copy.path), ['design/components.md']);
  assert.match(check.copies[0].text, /## Banner/);
  assert.match(check.copies[0].text, /import できません/);
  assert.equal(check.urlCount, 1);
  assert.equal(check.urls[0].component, 'Banner');
  assert.equal(check.urls[0].url, 'https://cdn.example.com/minato/banner.png');
  assert.match(check.rule, /import できない/);
});

test('ライセンスが分からないとき、名前のない公開のライセンスのときは、有効にできない理由を返す', () => {
  const unknown = checkGuideMaterial({ kind: 'guides', files: GUIDES, answers: { license: 'unknown' } });
  assert.equal(unknown.ok, true, '確かめと見本は進める');
  assert.equal(unknown.license.ok, false);
  assert.match(unknown.license.reason, /ライセンスが分かりません/);
  assert.equal(licenseView({}).ok, false, '答えがなければ分からないと同じ');
  assert.match(licenseView({ license: 'listed', licenseName: ' ' }).reason, /ライセンスの名前/);
  assert.equal(licenseView({ license: 'internal' }).ok, true);
});

test('形が違う、秘密らしい文字列がある、大きすぎるときは、利用者の言葉で断る', () => {
  assert.match(checkGuideMaterial({ kind: 'guides', files: [{ path: 'a.txt', text: 'x' }] }).errors[0].text, /Markdown のファイル/);
  assert.match(checkGuideMaterial({ kind: 'storybook', files: GUIDES }).errors[0].text, /index\.json がありません/);
  assert.match(checkGuideMaterial({ kind: 'storybook', files: [{ path: 'sb/index.json', text: '{oops' }] }).errors[0].text, /JSON として読めません/);
  assert.match(checkGuideMaterial({ kind: 'storybook', files: [{ path: 'sb/index.json', text: '{"v":5}' }] }).errors[0].text, /entries/);
  const secret = checkGuideMaterial({ kind: 'guides', files: [{ path: 'a.md', text: `# 決まり\n\nキー: sk-ant-api03-${'a'.repeat(40)}\n` }] });
  assert.equal(secret.ok, false);
  assert.match(secret.errors[0].text, /秘密らしい文字列/);
  assert.equal(secret.errors[0].line, 3);
  const big = checkGuideMaterial({ kind: 'guides', files: [{ path: 'a.md', text: 'あ'.repeat(80 * 1024) }] });
  assert.match(big.errors[0].text, /大きすぎます/);
  assert.match(checkGuideMaterial({ kind: 'npm', files: [] }).errors[0].text, /指針の文か、Storybook/);
});

test('写しの名前は、作る AI が指示として読む名前と隠しファイルにしない。同じ名前は番号を付ける', () => {
  const taken = new Set();
  assert.equal(copyName('docs/CLAUDE.md', taken), 'guide-CLAUDE.md');
  assert.equal(copyName('AGENTS.md', taken), 'guide-AGENTS.md');
  assert.equal(copyName('.hidden.md', taken), 'hidden.md');
  assert.equal(copyName('../../見た目 の決まり.md', taken), '見た目-の決まり.md');
  assert.equal(copyName('a/voice.md', taken), 'voice.md');
  assert.equal(copyName('b/voice.md', taken), 'voice-2.md');
  assert.equal(copyName('components.md', taken), 'guide-components.md', 'Storybook の一覧の名前と重ねない');
});

test('外への URL は、手元(localhost)を除いて数える', () => {
  assert.deepEqual(findExternalUrls('http://localhost:6006/x と http://127.0.0.1/y', 'a.md'), []);
  assert.deepEqual(findExternalUrls('行 1\n画像 https://cdn.example.com/a.png)', 'a.md'), [{ file: 'a.md', line: 2, url: 'https://cdn.example.com/a.png' }]);
});

test('作る AI への決まりは、写しの場所と守ることだけ。中身は入れない', () => {
  const rule = guidesRule([{ kind: 'guides', files: [{ copy: 'design/guides/voice.md' }] }]);
  assert.match(rule, /design\/guides\/voice\.md/);
  assert.match(rule, /変えない/);
  assert.doesNotMatch(rule, /import できない/);
  assert.equal(guidesRule([]), null);
  assert.match(componentsMarkdown([{ name: 'X', title: 'A/X', stories: [], description: '' }]), /## X\n\n- Storybook の場所: A\/X/);
});

test('部品の一覧の写しが大きすぎるときは、有効にする前に断る', () => {
  const entries = Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`c${i}--a`, { id: `c${i}--a`, title: `Minato/Part${i}`, name: 'A'.repeat(100), type: 'story' }]));
  const components = Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`c${i}`, { name: `Part${i}`, description: 'あ'.repeat(1000) }]));
  const check = checkGuideMaterial({
    kind: 'storybook',
    files: [{ path: 'sb/index.json', text: JSON.stringify({ v: 5, entries }) }, { path: 'sb/manifests/components.json', text: JSON.stringify({ components }) }],
    answers: OK,
  });
  assert.equal(check.ok, false);
  assert.match(check.errors.at(-1).text, /部品の一覧が大きすぎます/);
});
