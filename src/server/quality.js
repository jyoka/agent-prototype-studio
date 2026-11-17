import fs from 'node:fs/promises';
import path from 'node:path';
import { cleanAudit } from '../observer/audit.js';
import { currentAppDigest } from './evidence.js';
import { materialChangedAt, readTokenMaterial } from './materials.js';
import { tableOf } from './scene-runs.js';

// 質の見直しの表(docs/design/user-journey.md の J6。段 6)。
// 測るもの(アクセシビリティの違反、字と地の差、素材に合わない色と部品、場面の結果、道具の呼び方の正しさ、守りの効き、費用、待ち時間)と、
// AI の判断(返事の自然さの採点、使いやすさの見直し)を分けて出す。各行に「なぜ大事か」と「直す」を付ける。
// 数はどれも Studio が持っている記録から読むだけで、ここでは何も動かさない。
// - アクセシビリティと字と地の差: 一番新しい観察の report の audit(src/observer/audit.js。「試作品を自動で確かめる」で作る)
// - 色と部品: app/ の文のファイルを形で探す(ここで読む)
// - 場面の結果から待ち時間まで: 一番新しい場面の回しの結果(scene-runs.js の latest。npm run evals の結果も入る)
// 見ていない項目は「まだ見ていない」(unseen)と出し、数を作らない

export const QUALITY_LIMITS = Object.freeze({
  // 読む観察の数(新しい順)。audit のある report が見つかるまで
  maxObservations: 30,
  // 行ごとに出す場所の数
  maxPlaces: 10,
  // 探すファイルの数と大きさ(inspect.js の上限と同じ考え。大きいファイルは読まない)
  maxFiles: 500,
  maxFileBytes: 1024 * 1024,
  maxLineText: 120,
});

// 行の状態。fix は「直す」がある、ok は直すことがない、info は測ったが目安がない(費用と待ち時間)、
// unseen はまだ見ていない、na は当てはまらない(AI のない試作品の、AI の行)
export const QUALITY_STATUSES = ['fix', 'ok', 'info', 'unseen', 'na'];
// 測ったもの(measured)と AI の判断(judged)
export const QUALITY_GROUPS = { measured: '測ったもの', judged: 'AI の判断' };

// 行の決まった中身。順もこの順
export const QUALITY_ROWS = Object.freeze([
  {
    id: 'a11y',
    group: 'measured',
    label: 'アクセシビリティの違反',
    why: 'ラベルや名前がないと、画面の読み上げを使う人には、何の欄か、何のボタンかが分かりません。',
    fix: '入力にはラベルを付けます。ボタンと画像には、名前か代わりの文を付けます。',
  },
  {
    id: 'contrast',
    group: 'measured',
    label: '字と地の差',
    why: '差が小さいと、目の弱い人や明るい場所では字が読めません。基準は 4.5:1、大きな字は 3:1 です。',
    fix: '字を濃くするか地を薄くして、差を基準より大きくします。',
  },
  {
    id: 'colors',
    group: 'measured',
    label: '素材に合わない色(値のまま書いた色)',
    why: '値のまま書いた色は、素材を替えても変わりません。画面ごとに色がずれます。',
    fix: '素材の色(つないだトークンか、既定の素材の色)の名前に置き換えます。',
  },
  {
    id: 'parts',
    group: 'measured',
    label: '素材に合わない部品',
    why: '素材の部品を使わずに書いた部品は、見た目と使い勝手がほかの所とそろいません。',
    fix: '既定の素材の部品(ボタン、入力、選ぶ欄)に置き換えます。',
  },
  {
    id: 'scenes',
    group: 'measured',
    label: '場面の結果',
    why: '場面の一覧は、この AI にできてほしい会話です。通らない場面は、使う人が困る所です。',
    fix: '通らない場面を、作る AI の欄で直します。場面の一覧と守りは弱めません。',
  },
  {
    id: 'tools',
    group: 'measured',
    label: '道具の呼び方の正しさ',
    why: '呼ぶべき道具を呼ばないと、AI は答えを作ってしまいます。呼ばなくてよい所で呼ぶと、費用と誤りが増えます。',
    fix: 'プロンプトと道具の説明に、呼ぶ場面と呼ばない場面をはっきり書きます。',
  },
  {
    id: 'guards',
    group: 'measured',
    label: '守りの効き',
    why: '危ない場面で止まらないと、使う人を傷つけたり、約束できないことを言ったりします。',
    fix: '止まらなかった危ない場面に、コードの守り(道具の守りか出口の確かめ)を足します。プロンプトの頼みだけに頼りません。',
  },
  {
    id: 'cost',
    group: 'measured',
    label: '費用',
    why: '1 つの会話の費用は、本番では会話の数だけかかります。',
    fix: '高いと感じたら、道具を呼ぶ回数を減らすか、小さいモデルの前提で比べます。',
  },
  {
    id: 'wait',
    group: 'measured',
    label: '待ち時間',
    why: '返事が遅いと、使う人は途中でやめます。',
    fix: '遅いと感じたら、道具を呼ぶ回数とプロンプトの長さを減らします。',
  },
  {
    id: 'natural',
    group: 'judged',
    label: '返事の自然さ(AI の採点)',
    why: '決まった確かめでは分からない、言い方の固さや分かりにくさを、AI が点で見ます。AI の判断なので、ぶれがあります。',
    fix: '点の低い場面の返事を読み、言い方の決まりをプロンプトに足します。',
  },
  {
    id: 'usability',
    group: 'judged',
    label: '使いやすさの見直し',
    why: '数では分からない、迷う所や分かりにくい言葉を見つけます。AI の判断なので、人が確かめます。',
    fix: '見直しの指摘を読み、直すかを人が決めます。',
  },
]);

const TEXT_FILE = /\.(css|js|jsx|mjs|cjs|ts|tsx|mts|cts|html?)$/i;
const CSS_FILE = /\.css$/i;
const MARKUP_FILE = /\.(jsx|tsx|html?|js|mjs|ts)$/i;
// 値のまま書いた色。#rgb、#rgba、#rrggbb、#rrggbbaa と、色の関数。名前の色(red など)は数えない
const HEX_COLOR = /(?<![\w&#-])#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{3,4})(?![\w-])/gi;
const COLOR_FUNCTION = /(?<![\w-])(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(/gi;
// 既定の素材の部品(Radix Themes)を読んでいるか
const THEMES_IMPORT = /(?:from\s*|import\s*\(?\s*)['"]@radix-ui\/themes['"]/;
// 素材の部品の代わりに、じかに書いた部品(小文字の要素)
const RAW_PART = /<(button|input|select|textarea)(?=[\s/>])/g;
const PART_WORDS = { button: 'ボタン', input: '入力', select: '選ぶ欄', textarea: '文の欄' };

// コメントを、行の数を変えずに空白にする。CSS と JS のブロックのコメント、HTML のコメント、JS の行のコメント。
// 行のコメントは、行の頭か空白などの後の // だけ(URL の https:// は残す)。文字列の中の // も消えるが、色を見落とすだけで誤りは増えない
function stripComments(text, css) {
  const blank = (block) => block.replace(/[^\n]/g, ' ');
  let out = text.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/<!--[\s\S]*?-->/g, blank);
  if (!css) out = out.replace(/(^|[\s;,{}()])(\/\/.*)$/gm, (all, head, comment) => head + ' '.repeat(comment.length));
  return out;
}

// var(--x, 値) の後ろの値(読めないときの代わり)は数えない。素材の名前を読んでいるので
function insideVarFallback(before) {
  const at = before.lastIndexOf('var(');
  return at !== -1 && !before.slice(at).includes(')');
}

// CSS の色が宣言の値の中か。直前の区切り({ ; })からの文が「名前:」で始まり、次の区切りが { でない(選ぶ所ではない)
function inCssValue(text, index) {
  const from = Math.max(text.lastIndexOf('{', index), text.lastIndexOf(';', index), text.lastIndexOf('}', index)) + 1;
  if (!/^\s*-?[a-zA-Z][-\w]*\s*:/.test(text.slice(from, index))) return false;
  const next = /[{;}]/.exec(text.slice(index));
  return !next || next[0] !== '{';
}

// JS と HTML の色が値として書かれた所か。文字列がその色だけ('#fff')か、直前が「名前: 値」の形(color: '#fff'、'1px solid #ccc' の border: の後、style="color:#ccc")。
// リンク(href="#…")と要素を選ぶ所(querySelector('#…'))は数えない。「注文 #1024」のような文の中の番号は、名前: の形がないので数えない
const QUOTE = /['"`]/;
const SELECTOR_CALL = /(?:\b(?:href|to|src)\s*=\s*\{?\s*|(?:querySelector(?:All)?|getElementById|closest|matches)\(\s*)['"`]$/;
const PROPERTY_BEFORE = /-?[a-zA-Z][-\w]*\s*:\s*['"`]?[-\w\s.,%()/]*$/;
function inScriptValue(line, index, length) {
  const before = line.slice(0, index);
  if (SELECTOR_CALL.test(before)) return false;
  const after = line[index + length];
  if (QUOTE.test(before.at(-1) ?? '') && after === before.at(-1)) return true;
  return PROPERTY_BEFORE.test(before);
}

async function* sourceFiles(appDir, limits, dir = appDir, seen = { count: 0 }) {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (seen.count >= limits.maxFiles) return;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* sourceFiles(appDir, limits, full, seen);
    else if (entry.isFile() && TEXT_FILE.test(entry.name)) {
      seen.count += 1;
      const stat = await fs.lstat(full).catch(() => null);
      if (!stat || stat.size > limits.maxFileBytes) continue;
      yield { name: path.relative(appDir, full).split(path.sep).join('/'), text: await fs.readFile(full, 'utf8') };
    }
  }
}

const clipLine = (text, max) => {
  const value = String(text ?? '').trim();
  return value.length > max ? `${value.slice(0, max)}…` : value;
};

// 文の中の位置の行の番号(1 から)。starts は行の頭の位置の並び
function lineAt(starts, index) {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (starts[mid] <= index) low = mid;
    else high = mid - 1;
  }
  return low + 1;
}

// app/ の文のファイルから、値のまま書いた色と、素材の部品を使わずに書いた部品を探す。
// 形で探すので、文字列を組み立てた色と名前の色(red など)は数えない。値の形に見える文の中の番号(label: 'Order #1024')は数えることがある。
// 部品は、既定の素材の部品(Radix Themes)を読んでいる試作品でだけ数える(素材が入っていなければ、比べる部品がない)
export async function scanSource(appDir, limits = QUALITY_LIMITS) {
  const colors = { count: 0, places: [] };
  const parts = { count: 0, places: [] };
  let themes = false;
  const files = [];
  for await (const file of sourceFiles(appDir, limits)) {
    files.push(file);
    if (THEMES_IMPORT.test(file.text)) themes = true;
  }
  for (const { name, text } of files) {
    const css = CSS_FILE.test(name);
    const clean = stripComments(text, css);
    const raw = text.split('\n');
    const starts = [0];
    for (let i = clean.indexOf('\n'); i !== -1; i = clean.indexOf('\n', i + 1)) starts.push(i + 1);
    const matches = [...clean.matchAll(HEX_COLOR), ...[...clean.matchAll(COLOR_FUNCTION)].map((m) => Object.assign(m, { fn: true }))].sort((a, b) => a.index - b.index);
    for (const match of matches) {
      const line = lineAt(starts, match.index);
      const lineText = clean.slice(starts[line - 1], match.index);
      if (insideVarFallback(lineText)) continue;
      const counted = css ? inCssValue(clean, match.index) : inScriptValue(clean.slice(starts[line - 1], starts[line] ?? clean.length), lineText.length, match[0].length);
      if (!counted) continue;
      colors.count += 1;
      if (colors.places.length < limits.maxPlaces) colors.places.push({ file: name, line, value: match.fn ? `${match[0]}…)` : match[0], text: clipLine(raw[line - 1], limits.maxLineText) });
    }
    if (themes && MARKUP_FILE.test(name)) {
      clean.split('\n').forEach((lineText, i) => {
        for (const match of lineText.matchAll(RAW_PART)) {
          // 文字列の中の `<input>` のような文は数えない
          if (QUOTE.test(lineText[match.index - 1] ?? '')) continue;
          parts.count += 1;
          if (parts.places.length < limits.maxPlaces) parts.places.push({ file: name, line: i + 1, value: match[1], text: clipLine(raw[i], limits.maxLineText) });
        }
      });
    }
  }
  return { colors, parts: themes ? parts : null, themes, files: files.length };
}

// 一番新しい、表示中の試作品を見た確かめ(mode: shown)の report の audit(.studio/observations/<観察の ID>/report.json)。観察の ID は時刻から始まる。
// 作る AI の観察の道具とターミナルの観察(mode: working)は、開いたままの画面や途中の画面を見ているので使わない。
// 値は書いたときに整えてあるが、手で直した report でも崩れないよう、もう一度決まった形に写す
export async function latestAudit(projectRoot, limits = QUALITY_LIMITS) {
  const dir = path.join(projectRoot, '.studio', 'observations');
  const names = (await fs.readdir(dir, { withFileTypes: true }).catch(() => [])).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort().reverse();
  for (const name of names.slice(0, limits.maxObservations)) {
    const report = await fs
      .readFile(path.join(dir, name, 'report.json'), 'utf8')
      .then((text) => JSON.parse(text))
      .catch(() => null);
    if (report?.format !== 'prototype-studio-observation' || report.mode !== 'shown') continue;
    const audit = cleanAudit(report.audit);
    if (!audit) continue;
    return {
      id: name,
      report: `.studio/observations/${name}/report.json`,
      startedAt: typeof report.startedAt === 'string' ? report.startedAt : null,
      appDigest: typeof report.appDigest === 'string' ? report.appDigest : null,
      audit: { ...audit, viewport: typeof report.audit.viewport === 'string' ? report.audit.viewport : null, at: typeof report.audit.at === 'string' ? report.audit.at : null },
    };
  }
  return null;
}

const plural = (items, word) => (items.length > 0 ? `${word} ${items.length}` : null);
const percent = (value) => `${Math.round(value * 100)}%`;
const usd = (value) => `${value.toFixed(value < 0.01 ? 4 : 2)} USD`;

function row(id, status, result, { request = null, places = [], note = null } = {}) {
  const base = QUALITY_ROWS.find((item) => item.id === id);
  return { ...base, status, result, request, places, note };
}

// 観察の audit から、アクセシビリティの違反と字と地の差の行
function auditRows(observation) {
  const unseen = 'まだ見ていない。「画面を確かめて見直す」を押すと測ります。';
  if (!observation) return [row('a11y', 'unseen', unseen), row('contrast', 'unseen', unseen)];
  const audit = observation.audit;
  const kinds = [
    ['unlabeled', 'ラベルのない入力'],
    ['unnamedButtons', '名前のないボタン'],
    ['missingAlt', '代わりの文のない画像'],
  ];
  const total = kinds.reduce((n, [key]) => n + (audit[key]?.count ?? 0), 0);
  const a11yPlaces = kinds.flatMap(([key, word]) => (audit[key]?.items ?? []).map((item) => `${word}: ${item.where}${item.hint ? `(${item.hint})` : ''}`));
  const a11yResult = total === 0
    ? '違反はありません(ラベル、ボタンの名前、画像の代わりの文を見た)'
    : `違反 ${total}(${kinds.map(([key, word]) => `${word} ${audit[key]?.count ?? 0}`).join('、')})`;
  const a11yRequest = total === 0 ? null : [
    `質の見直しで、アクセシビリティの違反が ${total} つありました。`,
    ...a11yPlaces.slice(0, QUALITY_LIMITS.maxPlaces).map((text) => `- ${text}`),
    '入力にはラベル(label 要素か aria-label)を付け、ボタンと画像には名前か代わりの文(alt)を付けてください。見た目と動きは変えないでください。',
  ].join('\n');
  const contrast = audit.contrast ?? { count: 0, checked: 0, unknown: 0, items: [] };
  // 一番小さい差は、report に入れなかった所も含めて検査が数えたもの(古い report にはないので、入れた所から求める)
  const lowest = contrast.lowest ?? contrast.items.reduce((min, item) => (item.ratio !== null && (min === null || item.ratio < min.ratio) ? item : min), null);
  const contrastPlaces = contrast.items.map((item) => `「${item.text}」: ${item.ratio}:1(基準 ${item.required}:1。字 ${item.color ?? '?'}、地 ${item.background ?? '?'})${item.where ? ` ${item.where}` : ''}`);
  const unknownText = contrast.unknown > 0 ? `。地に絵があるなどで測れない所 ${contrast.unknown}` : '';
  const contrastResult = contrast.count === 0
    ? `足りない所はありません(字のある所 ${contrast.checked} を見た${unknownText})`
    : `足りない所 ${contrast.count}(一番小さい差 ${lowest?.ratio ?? '?'}:1。基準 ${lowest?.required ?? 4.5}:1${unknownText})`;
  const contrastRequest = contrast.count === 0 ? null : [
    `質の見直しで、字と地の差が基準に足りない所が ${contrast.count} つありました。`,
    ...contrastPlaces.slice(0, QUALITY_LIMITS.maxPlaces).map((text) => `- ${text}`),
    '字の色か地の色を変えて、差を基準(ふつうの字は 4.5:1、大きな字は 3:1)より大きくしてください。素材の色の名前があれば、それを使ってください。',
  ].join('\n');
  return [
    row('a11y', total > 0 ? 'fix' : 'ok', a11yResult, { request: a11yRequest, places: a11yPlaces }),
    row('contrast', contrast.count > 0 ? 'fix' : 'ok', contrastResult, { request: contrastRequest, places: contrastPlaces }),
  ];
}

// app/ の文から、素材に合わない色と部品の行
function sourceRows(source, { tokens }) {
  const where = (place) => `${place.file} の ${place.line} 行目: ${place.text}`;
  const colorPlaces = source.colors.places.map(where);
  const name = tokens ? 'つないだトークンの名前(var(--token-…))' : '既定の素材の色の名前(Radix Colors の var(--blue-9) など)か、トークンをつないでその名前';
  const colors = source.colors.count === 0
    ? row('colors', 'ok', `値のまま書いた色はありません(${source.files} つのファイルを見た)`)
    : row('colors', 'fix', `値のまま書いた色 ${source.colors.count}`, {
        places: colorPlaces,
        request: [
          `質の見直しで、値のまま書いた色が ${source.colors.count} か所ありました。`,
          ...colorPlaces.map((text) => `- app/${text}`),
          `${name}に置き換えてください。見た目はなるべく変えないでください。`,
        ].join('\n'),
      });
  let parts;
  if (!source.parts) {
    parts = row('parts', 'unseen', 'まだ見ていない。この試作品には部品の素材(既定の素材)が入っていないので、比べる部品がありません。');
  } else if (source.parts.count === 0) {
    parts = row('parts', 'ok', '素材の部品を使わずに書いた部品はありません');
  } else {
    const places = source.parts.places.map(where);
    const counts = Object.entries(PART_WORDS).map(([tag, word]) => plural(source.parts.places.filter((p) => p.value === tag), word)).filter(Boolean);
    parts = row('parts', 'fix', `素材の部品を使わずに書いた部品 ${source.parts.count}${counts.length > 0 ? `(${counts.join('、')} など)` : ''}`, {
      places,
      request: [
        `質の見直しで、既定の素材の部品を使わずに書いた部品が ${source.parts.count} か所ありました。`,
        ...places.map((text) => `- app/${text}`),
        '既定の素材(@radix-ui/themes)の部品(Button、TextField.Root、Select、TextArea、Checkbox など)に置き換えてください。動きは変えないでください。',
      ].join('\n'),
    });
  }
  return [colors, parts];
}

// 場面の回しの結果から、場面の結果、道具の呼び方、守りの効き、費用、待ち時間、返事の自然さの行
// 行に使う組。今の既定の構成の組を選び、本物の AI の組、1 回目の組を先にする(npm run evals は、構成、前提、接続、回数の組を並べる)
export function pickGroup(groups, defaultFile = null) {
  const candidates = (groups ?? []).map((group, index) => ({ group, index })).filter(({ group }) => (group.evals ?? []).length > 0);
  const own = candidates.filter(({ group }) => defaultFile && group.composition?.file === defaultFile);
  const pool = own.length > 0 ? own : candidates;
  return [...pool].sort((a, b) => Number(Boolean(b.group.real)) - Number(Boolean(a.group.real)) || (a.group.round ?? 1) - (b.group.round ?? 1) || a.index - b.index)[0] ?? null;
}

// 場面の「直す」の依頼。通らない場面を 3 つまで並べ、作る AI の欄の上限(4000 字)より短く切る
const MAX_SCENE_REQUESTS = 3;
const MAX_REQUEST_CHARS = 3800;
function sceneRequest(failures, failing) {
  const parts = failures.slice(0, MAX_SCENE_REQUESTS).map((item) => item.request);
  if (failing > parts.length) parts.push(`ほかに ${failing - parts.length} つの場面も通りませんでした。場面の一覧と比べる表で見られます。`);
  const text = parts.join('\n\n');
  return text.length > MAX_REQUEST_CHARS ? `${text.slice(0, MAX_REQUEST_CHARS)}…` : text;
}

function sceneRows({ hasAi, result, sceneIds, defaultFile = null }) {
  const ids = ['scenes', 'tools', 'guards', 'cost', 'wait', 'natural'];
  if (!hasAi) return ids.map((id) => row(id, 'na', '当てはまらない(この試作品には、場面を回す構成がありません)'));
  if (!result) return ids.map((id) => row(id, 'unseen', 'まだ見ていない。「場面の一覧と比べる表」で場面を回すと測ります。'));
  const table = tableOf(result, sceneIds);
  const picked = pickGroup(result.groups, defaultFile);
  const group = picked?.group;
  const tableRow = picked ? table.rows[picked.index] : null;
  if (!group || !tableRow) return ids.map((id) => row(id, 'unseen', 'まだ見ていない。場面の回しの結果に、測った場面がありません。'));
  // 回している最中か、途中で止めた回し。数は出すが、全部の場面を見ていないので「問題なし」にはしない
  const partial = result.status === 'running' ? '回している最中' : result.status !== 'done' ? '途中で止めた回し' : null;
  const settle = (item) => (partial && item.status === 'ok' ? { ...item, status: 'unseen', result: `まだ見ていない(${partial}で、全部の場面を見ていない)。${item.result}` } : item);
  const evals = group.evals ?? [];
  const summary = group.summary ?? {};
  const by = `構成「${tableRow.composition.name}」を${tableRow.real ? '本物の AI' : 'お試しの AI'} で回した結果`;
  const rows = [];

  // 場面の結果
  const failures = table.failures.filter((item) => item.row === tableRow.key);
  const failing = tableRow.failed + tableRow.errors;
  const sceneText = `${tableRow.passed} / ${tableRow.ran} 通った${failing > 0 ? `(通らない ${failing})` : ''}${tableRow.notApplicable > 0 ? `(当てはまらない ${tableRow.notApplicable})` : ''}。${by}`;
  rows.push(failing > 0
    ? row('scenes', 'fix', sceneText, { places: failures.map((item) => `場面「${item.id}」${item.about ? `(${item.about})` : ''}: ${item.verdictLabel}`), request: sceneRequest(failures, failing) })
    : row('scenes', tableRow.ran > 0 ? 'ok' : 'unseen', tableRow.ran > 0 ? sceneText : 'まだ見ていない。当てはまる場面がありません。'));

  // 道具の呼び方の正しさ。呼ぶべき場面で呼んだ率(toolCalled)と、誤った呼び出し(呼ぶべきでない場面の呼び出し、断られた呼び出し)
  const recall = summary.toolRecall ?? null;
  const wrong = summary.wrongCalls ?? 0;
  const missed = evals.filter((item) => (item.checks ?? []).some((check) => check.check === 'toolCalled' && check.verdict === 'failed')).map((item) => `場面「${item.id}」: 呼ぶべき道具を呼ばなかったか、引数が違った`);
  const extra = evals.filter((item) => item.kind === 'no-tool' && (item.calls?.count ?? 0) > 0).map((item) => `場面「${item.id}」: 呼ばなくてよい所で ${item.calls.count} 回呼んだ。呼んだ道具: ${(item.tools ?? []).join('、') || '不明'}`);
  const refused = evals.filter((item) => item.kind !== 'no-tool' && (item.calls?.refused ?? 0) > 0).map((item) => `場面「${item.id}」: 形か名前が違い、断られた呼び出し ${item.calls.refused} 回`);
  const toolPlaces = [...missed, ...extra, ...refused];
  const checkedTools = recall !== null || (summary.tools?.noToolScenes ?? 0) > 0;
  if (!checkedTools && wrong === 0) {
    rows.push(row('tools', 'unseen', 'まだ見ていない。道具を呼ぶかを確かめる場面がありません(場面の一覧に、道具を呼ぶ場面か呼ばない場面を足すと測れます)。'));
  } else {
    const text = `${recall !== null ? `呼ぶべき場面で正しく呼んだ ${percent(recall)}` : '呼ぶべき場面の確かめなし'}、誤った呼び出し ${wrong}。${by}`;
    const bad = (recall !== null && recall < 1) || wrong > 0;
    rows.push(row('tools', bad ? 'fix' : 'ok', text, {
      places: toolPlaces,
      request: bad
        ? [`質の見直しで、AI の道具の呼び方が正しくありませんでした(${text})。`, ...toolPlaces.map((t) => `- ${t}`), '場面の一覧と守り(ガードレール)は弱めずに、プロンプトと道具の説明に、呼ぶ場面と呼ばない場面をはっきり書いて直してください。'].join('\n')
        : null,
    }));
  }

  // 守りの効き。危ない場面(kind: risky)が止まったか
  const risky = summary.risky ?? { count: 0 };
  if (!risky.count) {
    rows.push(row('guards', 'unseen', 'まだ見ていない。止まるかを確かめる危ない場面がありません(場面の一覧に危ない場面を足すと測れます)。'));
  } else {
    const notStopped = evals.filter((item) => item.kind === 'risky' && (item.outcome === 'not-stopped' || item.stoppedBy === 'not-stopped'));
    const layers = [['tool', 'ツールの守り'], ['output', '出口の確かめ'], ['flow', '固定の流れ'], ['prompt-or-model', 'プロンプトかモデル']].map(([key, word]) => (risky[key] ? `${word} ${risky[key]}` : null)).filter(Boolean);
    const text = `危ない場面 ${risky.count} のうち、止まった ${risky.stopped ?? 0}${layers.length > 0 ? `(${layers.join('、')})` : ''}、止まらなかった ${risky['not-stopped'] ?? 0}。${by}`;
    const places = notStopped.map((item) => `場面「${item.id}」${item.about ? `(${item.about})` : ''}: 止まらなかった`);
    const modelOnly = (risky['prompt-or-model'] ?? 0) > 0;
    rows.push(row('guards', notStopped.length > 0 ? 'fix' : 'ok', text, {
      places,
      note: modelOnly && notStopped.length === 0 ? 'プロンプトかモデルが止めた場面は、モデルを替えると止まらないことがあります。' : null,
      request: notStopped.length > 0
        ? [`質の見直しで、危ない場面が止まりませんでした(${text})。`, ...places.map((t) => `- ${t}`), '場面の一覧は弱めずに、AI の構成にコードの守り(道具の守りか出口の確かめ)を足して、この場面で止まるようにしてください。構成を変えるときは、AI 構成の審査に戻ります。'].join('\n')
        : null,
    }));
  }

  // 費用と待ち時間。お試しの AI では測れない
  if (!tableRow.real) {
    rows.push(row('cost', 'unseen', 'まだ見ていない。お試しの AI では費用がかかりません。本物の AI で場面を回すと測ります。'));
    rows.push(row('wait', 'unseen', 'まだ見ていない。お試しの AI の待ち時間は、本物と比べられません。本物の AI で場面を回すと測ります。'));
  } else {
    rows.push(row('cost', 'info', tableRow.costPerConversationUsd !== null ? `1 つの会話 ${usd(tableRow.costPerConversationUsd)}(全部で ${usd(tableRow.costUsd ?? 0)})。${by}` : `全部で ${usd(tableRow.costUsd ?? 0)}。${by}`));
    rows.push(row('wait', tableRow.medianReplySeconds === null ? 'unseen' : 'info', tableRow.medianReplySeconds === null ? 'まだ見ていない。返事の時間を測れた場面がありません。' : `返事の中央値 ${tableRow.medianReplySeconds} 秒。${by}`));
  }

  // 返事の自然さ(AI の採点)。採点したときだけ
  const judge = summary.judge ?? { judged: 0 };
  if (!result.options?.judge || !judge.judged) {
    rows.push(row('natural', 'unseen', 'まだ見ていない。採点は、本物の AI で場面を回して採点したときだけ出ます。画面から回すときは採点しません。'));
  } else {
    const low = evals.filter((item) => (item.checks ?? []).some((check) => check.check === 'judge' && check.verdict === 'failed')).map((item) => `場面「${item.id}」: 点が足りない`);
    const text = `採点 ${judge.judged} のうち合格 ${judge.passed}${judge.meanScore !== null ? `(平均 ${judge.meanScore} 点)` : ''}。${by}`;
    rows.push(row('natural', judge.passed < judge.judged ? 'fix' : 'ok', text, {
      places: low,
      request: judge.passed < judge.judged ? [`質の見直しで、返事の自然さの採点が足りない場面がありました(${text})。`, ...low.map((t) => `- ${t}`), '場面の一覧と守りは弱めずに、プロンプトの言い方の決まりを直してください。'].join('\n') : null,
    }));
  }
  return rows.map(settle);
}

// 表の全部。入力はどれも読んだ値で、ここでは読み書きしない(単体で確かめるため)
export function qualityTable({ observation = null, auditStale = false, source, tokens = false, hasAi = false, result = null, sceneIds = [], defaultFile = null }) {
  const byId = new Map([...auditRows(observation), ...sourceRows(source, { tokens }), ...sceneRows({ hasAi, result, sceneIds, defaultFile })].map((item) => [item.id, item]));
  byId.set('usability', row('usability', 'unseen', 'まだ見ていない。AI が画面を見て使いやすさを判断する見直しは、今の Studio にはまだありません。'));
  const rows = QUALITY_ROWS.map((item) => byId.get(item.id));
  const count = (status) => rows.filter((item) => item.status === status).length;
  return {
    rows,
    summary: { fix: count('fix'), ok: count('ok'), info: count('info'), unseen: count('unseen'), na: count('na') },
    audit: observation ? { at: observation.audit.at ?? observation.startedAt, viewport: observation.audit.viewport ?? null, stale: auditStale, truncated: observation.audit.truncated === true } : null,
    scenes: result ? { at: result.startedAt ?? null, real: Boolean(result.options?.real), status: result.status ?? null, stale: tableOf(result, sceneIds).stale } : null,
  };
}

// 表の入力を記録から読んで、表を作る。画面(ProjectQuality)と引き継ぎ(handoff.js)が同じ表を出すため。
// simulation は今のビルドの構成と場面、result は一番新しい場面の回しの結果(なければ null)
export async function readQuality({ paths, simulation, result }) {
  const [source, material, observation, digest, changedAt] = await Promise.all([
    scanSource(paths.app),
    readTokenMaterial(paths.root).catch(() => null),
    latestAudit(paths.root),
    currentAppDigest(paths),
    materialChangedAt(paths.root),
  ]);
  // 確かめた後に app/ か素材が変わったら、画面の検査の結果は古い
  const auditStale = Boolean(observation) && (observation.appDigest !== digest || (changedAt !== null && typeof observation.startedAt === 'string' && observation.startedAt < changedAt));
  return qualityTable({
    observation,
    auditStale,
    source,
    tokens: Boolean(material && material.problems?.length === 0),
    hasAi: Boolean(simulation?.composition),
    result,
    sceneIds: (simulation?.evals ?? []).map(({ scenario }) => scenario.id),
    defaultFile: simulation?.composition?.file ?? null,
  });
}

export class ProjectQuality {
  // sceneRuns は場面の回し(一番新しい結果を読む)。checks は人の「確かめる」(確かめている最中か)
  constructor({ store, sceneRuns, checks }) {
    this.store = store;
    this.sceneRuns = sceneRuns;
    this.checks = checks;
  }

  async view(id) {
    const paths = await this.store.requireProject(id);
    const table = await readQuality({ paths, simulation: this.store.simulation(id), result: await this.sceneRuns.latest(id) });
    return { ...table, checking: this.checks.summary(id).checking };
  }
}
