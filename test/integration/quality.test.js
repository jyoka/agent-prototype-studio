import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { observeProject } from '../../src/server/observe-entry.js';

// 質の見直しの画面の検査(src/observer/audit.js。docs/design/user-journey.md の J6)を、本物の観察器(Playwright の Chromium)で確かめる。
// 作業中の app/ を見るモードで観察し、report の audit を読む。試作品の中の AI はなく、モデルは呼ばない。題材は架空

const MAIN = `
import { createRoot } from 'react-dom/client';
import './style.css';

function App() {
  return (
    <main>
      <h1 className="big">大きな見出し(架空)</h1>
      <p className="ok">ふつうの字</p>
      <p className="faint">薄い字</p>
      <label htmlFor="name">お名前</label>
      <input id="name" type="text" />
      <label>町の名前 <input type="text" /></label>
      <input type="search" aria-label="本を探す" />
      <input type="text" placeholder="ラベルなし" />
      <div role="checkbox" aria-checked="false" tabIndex={0}>同意する</div>
      <button type="button">送る</button>
      <button type="button" className="icon"><svg width="10" height="10" /></button>
      <button type="button" className="faint" disabled>押せない</button>
      <img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" width="10" height="10" />
      <img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" alt="" width="10" height="10" />
      <div className="picture"><span>絵の上の字</span></div>
      <p hidden>隠れた薄い字</p>
    </main>
  );
}

createRoot(document.getElementById('root')).render(<App />);
`;

const STYLE = `
body { background: #ffffff; color: #111111; }
.big { font-size: 32px; color: #8a8a8a; }
.ok { color: #333333; }
.faint { color: #c8c8c8; }
.picture { background-image: linear-gradient(#000000, #ffffff); }
`;

let dir;

test.before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-quality-audit-'));
  await fs.mkdir(path.join(dir, 'app'), { recursive: true });
  await fs.writeFile(path.join(dir, 'app', 'main.jsx'), MAIN);
  await fs.writeFile(path.join(dir, 'app', 'style.css'), STYLE);
});

test.after(async () => {
  if (dir) await fs.rm(dir, { recursive: true, force: true });
});

test('観察の report に、ラベルのない入力、名前のないボタン、代わりの文のない画像、字と地の差が足りない所が入る', { timeout: 120_000 }, async () => {
  const { report } = await observeProject({ projectDir: dir, mode: 'working', viewports: [], base: false });
  assert.equal(report.verdict, 'passed', JSON.stringify(report.errors));
  // 作業中の app/ を見た観察。質の見直しの表は、表示中の試作品を見た観察(shown)だけを使う
  assert.equal(report.mode, 'working');
  const audit = report.audit;
  assert.ok(audit, 'audit がある');
  assert.equal(audit.viewport, 'desktop');
  // ラベルの付いた入力(for、包む label、aria-label)と、字を持つ自作のチェックは数えない。置き場所の字だけの入力は数える
  assert.deepEqual(audit.unlabeled, { count: 1, items: [{ what: '入力(text)', where: 'input', hint: 'ラベルなし' }] });
  // 字のないボタン(絵だけ)は名前がない。押せないボタンも名前は要る(字があるので数えない)
  assert.deepEqual(audit.unnamedButtons, { count: 1, items: [{ what: 'ボタン', where: 'button.icon', hint: '' }] });
  // alt のない画像だけ。alt="" は飾りの画像として通す
  assert.equal(audit.missingAlt.count, 1);
  // 薄い字だけが足りない。大きな字(32px)は 3:1 で見るので #8a8a8a(3.45:1)は通る。押せないボタンと隠れた字は基準の外
  assert.equal(audit.contrast.count, 1);
  assert.deepEqual(audit.contrast.items.map((item) => [item.text, item.where, item.required, item.color, item.background]), [['薄い字', 'p.faint', 4.5, '#c8c8c8', '#ffffff']]);
  assert.ok(audit.contrast.items[0].ratio > 1.5 && audit.contrast.items[0].ratio < 1.7, String(audit.contrast.items[0].ratio));
  assert.deepEqual(audit.contrast.lowest, { ratio: audit.contrast.items[0].ratio, required: 4.5 });
  // 絵の地の上の字は測れない
  assert.equal(audit.contrast.unknown, 1);
  assert.ok(audit.contrast.checked >= 5);
});
