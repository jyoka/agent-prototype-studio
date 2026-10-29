import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { STUDIO_ROOT } from '../../src/server/config.js';

// 伝え方の土台(docs/brand.md)が、README、package.json、バナー、画面の色と食い違わないことを確かめる

const JA = 'AI エージェントの試作品を、作る前に、構成ごと手元で試して測る。';
const EN = 'Try and measure an AI agent prototype, whole setup included, on your machine before you build it.';
const BANNERS = ['assets/brand/banner-dark.svg', 'assets/brand/banner-light.svg'];

const read = (file) => fs.readFile(path.join(STUDIO_ROOT, file), 'utf8');

// 最初の :root { … } の中の変数を { 名前: 値 } で返す
function rootVariables(css) {
  const block = /:root\s*\{([^}]*)\}/.exec(css)[1];
  return Object.fromEntries([...block.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
}

test('1 文は README の太字、package.json の description、バナー、brand.md で同じ', async () => {
  assert.ok((await read('README.md')).split('\n').includes(`**${JA}**`));
  assert.equal(JSON.parse(await read('package.json')).description, EN);
  const brand = await read('docs/brand.md');
  assert.ok(brand.includes(JA) && brand.includes(EN));
  for (const file of BANNERS) {
    const svg = await read(file);
    assert.ok(svg.includes(`<desc id="desc">${JA} ${EN}</desc>`), file);
    assert.ok(svg.includes('agent-prototype-studio'), file);
  }
});

test('tokens.css のライトの色は、今の画面(studio.css)と同じ名前なら同じ値', async () => {
  const studio = rootVariables(await read('src/ui/studio.css'));
  const tokens = rootVariables(await read('assets/brand/tokens.css'));
  const shared = Object.keys(studio).filter((name) => name in tokens);
  assert.ok(shared.length >= 10, `同じ名前の変数が少ない: ${shared.join(', ')}`);
  for (const name of shared) assert.equal(tokens[name], studio[name], name);
});

test('tokens.css はダークと動きを止める設定を持ち、バナーと合わせて外から何も読み込まない', async () => {
  const css = await read('assets/brand/tokens.css');
  assert.match(css, /@media \(prefers-color-scheme: dark\)/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  for (const file of ['assets/brand/tokens.css', ...BANNERS]) {
    const text = (await read(file)).replace('xmlns="http://www.w3.org/2000/svg"', '');
    assert.doesNotMatch(text, /https?:|@import|url\(|<script|<image/i, file);
  }
});

test('見本のデータ、画面の文、README に、仕事の POC の名前が出ない(brand.md の 7 節)', async () => {
  // dipSees は前提の鍵(コードの名前)なので、このカードでは残す。\b で切れるので当たらない
  const poc = /\b(LINE|DIP|dip|dipAIAG)\b|バイトル/;
  const files = ['README.md'];
  for (const dir of ['samples', 'src/ui']) {
    for (const entry of await fs.readdir(path.join(STUDIO_ROOT, dir), { recursive: true, withFileTypes: true })) {
      if (entry.isFile()) files.push(path.relative(STUDIO_ROOT, path.join(entry.parentPath, entry.name)));
    }
  }
  assert.ok(files.length > 20);
  for (const file of files) {
    const lines = (await read(file)).split('\n');
    const hit = lines.findIndex((line) => poc.test(line));
    assert.equal(hit, -1, `${file}:${hit + 1}: ${lines[hit]}`);
  }
});
