import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { STUDIO_ROOT } from '../../src/server/config.js';

// 伝え方の土台(docs/brand.md)が、README、package.json、バナー、画面の色と食い違わないことを確かめる

const JA = '思いつきを AI プロダクトにすると、どんな作りになるか。動かして測り、人が承認してから作る。';
const EN = 'See how your idea works as an AI product, test it, and approve the architecture before you build.';
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
    // 見える文も同じ。<desc> だけを直して、絵の文が古いまま残らないように
    const lines = (size) => [...svg.matchAll(new RegExp(`<text x="80" y="\\d+" font-size="${size}"[^>]*>([^<]+)</text>`, 'g'))].map((m) => m[1]);
    assert.equal(lines(38).join(''), JA, file);
    assert.equal(lines(22).join(' '), EN, file);
  }
});

test('LP(site/)の見出しとフッターと llms.txt は、同じ 1 文を使う', async () => {
  const html = await read('site/index.html');
  // 見出しの 1 文とフッターの 1 文。日本語と英語の両方
  for (const sentence of [JA, EN]) {
    const count = html.split(`<span data-lang="${sentence === JA ? 'ja' : 'en'}">${sentence}</span>`).length - 1;
    assert.equal(count, 2, sentence);
  }
  const llms = await read('site/llms.txt');
  assert.ok(llms.includes(`> ${JA}`) && llms.includes(`> ${EN}`));
  // タブの名前(HTML の title と、英語に切り替えたときの site.js の文)
  assert.ok(html.includes(`<title>Prototype Studio: ${JA}</title>`));
  const script = await read('site/site.js');
  assert.ok(script.includes(`'Prototype Studio: ${JA}'`) && script.includes(`'Prototype Studio: ${EN}'`));
});

test('LP(site/)は外から何も読み込まない', async () => {
  const html = await read('site/index.html');
  // 読み込むもの(src、link の href)は、どれもリポジトリの中を指す
  for (const [, url] of html.matchAll(/\b(?:src|srcset)="([^"]*)"/g)) assert.doesNotMatch(url, /^(https?:)?\/\//, url);
  for (const [tag] of html.matchAll(/<link\b[^>]*>/g)) assert.doesNotMatch(tag, /href="(https?:)?\/\//, tag);
  for (const file of ['site/site.css', 'site/site.js', 'site/favicon.svg']) {
    const text = (await read(file)).replace('xmlns="http://www.w3.org/2000/svg"', '');
    assert.doesNotMatch(text, /https?:|@import|url\(|fetch\(|XMLHttpRequest|<script/i, file);
  }
});

test('tokens.css のライトの色は、今の画面(studio.css)と同じ名前なら同じ値', async () => {
  const studio = rootVariables(await read('src/ui/studio.css'));
  const tokens = rootVariables(await read('assets/brand/tokens.css'));
  const shared = Object.keys(studio).filter((name) => name in tokens);
  assert.ok(shared.length >= 10, `同じ名前の変数が少ない: ${shared.join(', ')}`);
  for (const name of shared) assert.equal(tokens[name], studio[name], name);
});

// セレクターの { … } の中の変数を { 名前: 値 } で返す
function blockVariables(css, selector) {
  const at = css.indexOf(`${selector} {`);
  assert.notEqual(at, -1, `${selector} がありません`);
  const block = css.slice(at, css.indexOf('}', at));
  return Object.fromEntries([...block.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
}

test('画面(studio.css)のダークは、tokens.css のダークと同じ値。OS の設定と data-theme の両方で切り替わる', async () => {
  const studio = await read('src/ui/studio.css');
  const tokens = await read('assets/brand/tokens.css');
  const light = rootVariables(studio);
  for (const selector of [':root[data-theme="dark"]', ':root:not([data-theme="light"])']) {
    const dark = blockVariables(studio, selector);
    const expected = blockVariables(tokens, selector);
    // ライトで決めた色の変数は、ダークでも全部決める
    assert.deepEqual(Object.keys(dark).sort(), Object.keys(light).sort(), selector);
    for (const [name, value] of Object.entries(dark)) assert.equal(value, expected[name], `${selector} ${name}`);
  }
  assert.match(studio, /@media \(prefers-color-scheme: dark\)/);
  // 色は :root の変数で書く。値のまま書いた色は、ダークで変わらない(試作品の iframe の地だけは白のまま)
  const rules = studio.slice(studio.indexOf('* { box-sizing'));
  assert.deepEqual(rules.match(/#[0-9a-f]{3,8}\b/gi), ['#fff']);
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
  const files = ['README.md', 'package.json', ...BANNERS];
  for (const dir of ['samples', 'src/ui', 'site']) {
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

test('README は「今できること」と「作っているもの」を分け、作っているものに画像を載せない', async () => {
  const readme = await read('README.md');
  const today = readme.indexOf('### 今できること');
  const building = readme.indexOf('### 作っているもの');
  const start = readme.indexOf('## はじめる');
  assert.ok(readme.indexOf('## 特長') < today && today < building && building < start);
  assert.doesNotMatch(readme.slice(building, start), /<img|<picture|!\[/);
  for (const word of ['AI 構成の審査', '3 つの形の比べ', 'データの棚と RAG の判定', '記録と比べる表を主の画面に', '質の見直し', 'みんなで作る']) {
    assert.ok(readme.slice(building, start).includes(word), word);
  }
  // 動くもの(設計の案内、ツールを呼ぶ固定の流れ)を、作っているものに「まだない」と書かない
  assert.ok(readme.slice(today, building).includes('設計の案内'));
  assert.doesNotMatch(readme.slice(building, start), /設計の案内|固定の流れからツールを呼ぶことと/);
  // 1 文の後の 2〜3 行で、承認の段は人の確かめがまだだと言う(1 文だけを読んで、できあがったと思わせない)
  const lead = readme.slice(readme.indexOf(`**${JA}**`), readme.indexOf('## しくみ'));
  assert.match(lead, /承認する段(.*)は、設計の案内の後に入りましたが、人の確かめはまだ/);
});

test('README と LP は「理想の構成」と言わず、日付と根拠のある今日の一番良い推測と書く', async () => {
  const llms = await read('site/llms.txt');
  for (const file of ['README.md', 'site/index.html', 'site/llms.txt']) {
    const text = await read(file);
    assert.doesNotMatch(text, /理想の構成|最適な構成|ベストプラクティス|ideal (architecture|setup)|best practice/i, file);
    assert.ok(text.includes('日付と根拠のある、今日の一番良い推測'), file);
  }
  assert.ok((await read('site/index.html')).includes("today's best guess, with a date and evidence"));
  assert.ok(llms.includes('## 今できること') && llms.includes('## 作っているもの'));
});

test('README、LP、伝え方の文書は、比べる相手の道具の名前を出さない(2026-11-06 の運営者の決定)', async () => {
  // 名前そのものをこのファイルにも書かないため、文字の組で探す。名前を伏せた比べる欄も LP に置かない
  const names = /r[e]plica|c[o]pilot/i;
  const files = ['README.md', 'package.json', 'site/index.html', 'site/llms.txt', 'docs/brand.md', 'docs/vision.md', 'docs/design/design-materials.md'];
  for (const file of files) {
    const lines = (await read(file)).split('\n');
    const hit = lines.findIndex((line) => names.test(line));
    assert.equal(hit, -1, `${file}:${hit + 1}: ${lines[hit]}`);
  }
  assert.doesNotMatch(await read('site/index.html'), /ほかの道具の欄|一般的な道具の欄|記載なし/);
});

// GitHub の見出しのリンク名(小文字にし、記号を除き、空白を - にする)
const slug = (heading) => heading.trim().toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, '').replace(/\s/g, '-');

test('README の上: バナー、1 文、動く画像の順。特長の画面 4 枚は docs の節へのリンク。画像は全部リポジトリの中にある', async () => {
  const readme = await read('README.md');
  const lines = readme.split('\n');
  assert.ok(lines.length <= 180, `README が ${lines.length} 行です(多くても 180 行。CONTRIBUTING.md の「README の構成」)`);
  const at = (text) => {
    const index = readme.indexOf(text);
    assert.notEqual(index, -1, text);
    return index;
  };
  assert.equal(lines[0], '<picture>');
  const order = [
    'srcset="assets/brand/banner-dark.svg"',
    'src="assets/brand/banner-light.svg"',
    '# agent-prototype-studio\n',
    `**${JA}**`,
    'media="(prefers-reduced-motion: reduce)"',
    'type="image/avif" srcset="assets/media/talk-guard.avif"',
    'src="assets/media/talk-guard.gif"',
    '## しくみ',
    '## 特長',
  ].map(at);
  assert.deepEqual(order, [...order].sort((a, b) => a - b));

  // 画像は外から読み込まず、全部ある
  const files = [...readme.matchAll(/\b(?:src|srcset)="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(files.length >= 14, files.join(', '));
  for (const file of files) {
    assert.doesNotMatch(file, /^https?:/, file);
    await fs.access(path.join(STUDIO_ROOT, file));
  }
  // alt は絵の中身が分かる文にする(ファイル名や空ではない)
  const imgs = [...readme.matchAll(/<img\b[^>]*>/g)].map((m) => m[0]);
  assert.equal(imgs.length, 6);
  for (const img of imgs) {
    const alt = /\balt="([^"]*)"/.exec(img)?.[1] ?? '';
    assert.ok(alt.length >= 40 && !/\.(png|gif|svg|avif)\b/.test(alt), img);
  }

  // 特長の画面 4 枚。押すと docs の該当の節に飛ぶ
  const features = readme.slice(at('## 特長'), at('## はじめる'));
  const links = [...features.matchAll(/<a href="([^"#]+)#([^"]+)"><picture><source media="\(prefers-color-scheme: dark\)" srcset="assets\/media\/([\w-]+)-dark\.png"><img [^>]*src="assets\/media\/([\w-]+)-light\.png"><\/picture><\/a><br>\s*<b>[^<]+<\/b><br>/g)];
  assert.deepEqual(links.map((m) => m[3]), ['sim-choice', 'sim-trace', 'evals-compare', 'try-and-fix']);
  for (const [, doc, anchor, dark, light] of links) {
    assert.equal(dark, light);
    const headings = (await read(doc)).split('\n').filter((line) => /^#{1,6} /.test(line)).map((line) => slug(line.replace(/^#+ /, '')));
    assert.ok(headings.includes(anchor), `${doc}#${anchor} の節がありません`);
  }
  assert.match(features, /どの画像も、Studio が自分で撮ったものです\(`npm run media`/);
});
