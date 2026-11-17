import crypto from 'node:crypto';
import { findPersonalData, findSecrets } from './redact.js';

// 部品と指針の取り込み(docs/design/user-journey.md の J5、docs/design/design-materials.md の 5 節)。
// 受け取るのは 2 つの形。指針の文(Markdown のファイル)と、Storybook の静的なビルド(部品の一覧と使い方の文だけ)。
// ここは決まった手順の検査と、作る AI が読む写しの文を作るだけ。ファイルを書かない、外へ通信しない(原則 7、ADR 0001)

export const KINDS = {
  guides: { label: '指針の文', copyDir: 'design/guides' },
  storybook: { label: 'Storybook の部品の一覧', copyDir: 'design' },
};

// 上限(仮)。写しは app/ に入るので、app/ の検査の上限(1 ファイル 1 MB、合計 5 MB)より十分小さくする
export const GUIDE_LIMITS = {
  maxFiles: 30,
  maxFileBytes: 200 * 1024,
  maxTotalBytes: 1024 * 1024,
  // Storybook の index.json は物語の数だけ大きくなる
  maxIndexBytes: 4 * 1024 * 1024,
  maxComponents: 300,
  maxDescription: 1000,
  // 部品の一覧の写し(components.md)。app/ の 1 ファイルの上限(1 MB)より小さくする
  maxListBytes: 512 * 1024,
  maxUrls: 50,
};

// 使ってよいかの答え。分からないときは有効にできない(受け入れ条件)
export const LICENSE_ANSWERS = {
  listed: '公開のライセンスがある',
  internal: '社内の素材で、使う許可がある',
  unknown: '分からない',
};

const MAX_LICENSE_NAME = 100;
const COMPONENTS_FILE = 'components.md';
// app/ に置けない名前(inspect.js の FORBIDDEN_NAMES)と、作る AI が指示として読む名前は、写しの名前にしない
const RESERVED_NAMES = new Set(['claude.md', 'claude.local.md', 'agents.md', COMPONENTS_FILE]);
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const URL_PATTERN = /\bhttps?:\/\/[^\s<>"'`)\]]+/gi;

export const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');
const bytes = (text) => Buffer.byteLength(text, 'utf8');
const problem = (file, text, line = null) => ({ file, line, text });

// 外への URL を、ファイルと行で返す。試作品の CSP は外への読み込みを止めるので、字や画像は出ない(design-materials.md の 1 節)
export function findExternalUrls(text, file) {
  const found = [];
  text.split(/\r?\n/).forEach((lineText, index) => {
    for (const match of lineText.matchAll(URL_PATTERN)) {
      let host;
      try {
        host = new URL(match[0]).host.toLowerCase();
      } catch {
        continue;
      }
      if (LOCAL_HOSTS.has(host.replace(/:\d+$/, ''))) continue;
      found.push({ file, line: index + 1, url: match[0].slice(0, 200) });
    }
  });
  return found;
}

// 写しの名前。フォルダーの名前を落とし、使える字だけにする。作る AI が指示として読む名前や、隠しファイルにはしない
export function copyName(name, taken = new Set()) {
  const base = String(name ?? '').split(/[\\/]/).pop().normalize('NFC');
  let stem = base.replace(/\.(md|markdown)$/i, '').replace(/[^\p{L}\p{N}_-]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'guide';
  if (RESERVED_NAMES.has(`${stem.toLowerCase()}.md`) || stem.startsWith('.')) stem = `guide-${stem}`;
  let candidate = `${stem}.md`;
  for (let n = 2; taken.has(candidate.toLowerCase()); n += 1) candidate = `${stem}-${n}.md`;
  taken.add(candidate.toLowerCase());
  return candidate;
}

function cleanAnswers(answers) {
  const license = Object.hasOwn(LICENSE_ANSWERS, answers?.license) ? answers.license : 'unknown';
  const licenseName = typeof answers?.licenseName === 'string' ? answers.licenseName.trim().slice(0, MAX_LICENSE_NAME) : '';
  return { license, licenseName };
}

// ライセンスの判断。ファイルの中の書き方は、人の答えの手がかりとして出すだけで、決めない(法律の判断はしない)
export function licenseView(answers, detected = null) {
  const { license, licenseName } = cleanAnswers(answers);
  if (license === 'unknown') {
    return { ok: false, license, licenseName: '', detected, reason: 'ライセンスが分かりません。素材の持ち主に、試作品に使ってよいかを確かめてください。分かったら「1. 聞く」の「使ってよいか」を選び直してください' };
  }
  if (license === 'listed' && !licenseName) {
    return { ok: false, license, licenseName: '', detected, reason: 'ライセンスの名前を書いてください(例: MIT)。引き継ぎの出典になります' };
  }
  return { ok: true, license, licenseName: license === 'listed' ? licenseName : '', detected, reason: null };
}

export function licenseLabel(record) {
  if (record?.license === 'listed') return `公開のライセンス(${record.licenseName})`;
  return LICENSE_ANSWERS[record?.license] ?? LICENSE_ANSWERS.unknown;
}

// フォルダーの中の LICENSE と package.json の書き方を読む。見つけた名前を返すだけ
function detectLicense(files) {
  const pkg = files.find((f) => /(^|\/)package\.json$/i.test(f.path) && f.path.split('/').length <= 2);
  if (pkg) {
    try {
      const value = JSON.parse(pkg.text).license;
      if (typeof value === 'string' && value.trim()) return value.trim().slice(0, MAX_LICENSE_NAME);
    } catch {
      // 読めなければ手がかりにしない
    }
  }
  const file = files.find((f) => /(^|\/)(license|licence)(\.[a-z]+)?$/i.test(f.path));
  const first = file?.text.split(/\r?\n/).find((line) => line.trim())?.trim();
  return first ? first.slice(0, MAX_LICENSE_NAME) : null;
}

function scanText(text, file, errors, warnings) {
  if (text.includes('\u0000')) {
    errors.push(problem(file, '文字のファイルではありません。Markdown のファイルを選んでください'));
    return;
  }
  for (const found of findSecrets(text)) errors.push(problem(file, `秘密らしい文字列(${found.kind})があります。消してから選び直してください`, found.line));
  for (const found of findPersonalData(text)) warnings.push({ kind: 'personal', file, line: found.line, text: `個人の情報らしい文字列(${found.kind})があります。架空の例なら、そのまま進めます` });
}

function inputFiles(files) {
  if (!Array.isArray(files)) return [];
  return files
    .filter((f) => f && typeof f.path === 'string' && typeof f.text === 'string')
    .map((f) => ({ path: f.path.replace(/\\/g, '/').replace(/^\/+/, '').slice(0, 300), text: f.text }));
}

function checkGuides(files) {
  const errors = [];
  const warnings = [];
  const markdown = files.filter((f) => /\.(md|markdown)$/i.test(f.path));
  if (markdown.length === 0) errors.push(problem('', 'Markdown のファイル(.md)がありません。指針の文を書いたファイルを選んでください'));
  if (markdown.length > GUIDE_LIMITS.maxFiles) errors.push(problem('', `ファイルが多すぎます(${markdown.length} 個。上限 ${GUIDE_LIMITS.maxFiles} 個)`));
  let total = 0;
  const taken = new Set();
  const copies = [];
  for (const file of markdown.slice(0, GUIDE_LIMITS.maxFiles)) {
    const size = bytes(file.text);
    total += size;
    if (size > GUIDE_LIMITS.maxFileBytes) {
      errors.push(problem(file.path, `ファイルが大きすぎます(上限 ${GUIDE_LIMITS.maxFileBytes / 1024} KB)`));
      continue;
    }
    scanText(file.text, file.path, errors, warnings);
    const name = copyName(file.path, taken);
    const title = /^#\s+(.+)$/m.exec(file.text)?.[1].trim().slice(0, 120) ?? name;
    copies.push({ from: file.path, name, title, text: file.text, urls: findExternalUrls(file.text, file.path) });
  }
  if (total > GUIDE_LIMITS.maxTotalBytes) errors.push(problem('', `ファイルの合計が大きすぎます(上限 ${GUIDE_LIMITS.maxTotalBytes / 1024} KB)`));
  return { errors, warnings, copies, components: [], detected: null };
}

function parseJson(file, label, errors) {
  try {
    return JSON.parse(file.text);
  } catch {
    errors.push(problem(file.path, `${label}を JSON として読めません。Storybook を書き出したフォルダー(storybook build で作ったもの)を選んでください`));
    return null;
  }
}

// manifests/components.json はプレビューの機能で、形が決まっていない(design-materials.md の 4 節)。名前と使い方の文だけを、ゆるく読む
function manifestDescriptions(manifest) {
  const map = new Map();
  const list = Array.isArray(manifest?.components) ? manifest.components : manifest?.components && typeof manifest.components === 'object' ? Object.entries(manifest.components).map(([id, value]) => ({ id, ...value })) : [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const text = [item.description, item.summary].find((value) => typeof value === 'string' && value.trim());
    if (!text) continue;
    for (const key of [item.id, item.name, item.displayName, item.title]) {
      if (typeof key === 'string' && key) map.set(key.toLowerCase(), text.trim().slice(0, GUIDE_LIMITS.maxDescription));
    }
  }
  return map;
}

function checkStorybook(files) {
  const errors = [];
  const warnings = [];
  // フォルダーを選ぶと、先頭にフォルダーの名前が付く(storybook-static/index.json)
  const depth = (f) => f.path.split('/').length;
  const index = files.filter((f) => /(^|\/)index\.json$/.test(f.path)).sort((a, b) => depth(a) - depth(b))[0];
  if (!index) {
    errors.push(problem('', 'index.json がありません。Storybook を書き出したフォルダー(storybook build で作ったもの)を選んでください'));
    return { errors, warnings, copies: [], components: [], detected: null };
  }
  if (bytes(index.text) > GUIDE_LIMITS.maxIndexBytes) {
    errors.push(problem(index.path, `index.json が大きすぎます(上限 ${GUIDE_LIMITS.maxIndexBytes / 1024 / 1024} MB)`));
    return { errors, warnings, copies: [], components: [], detected: null };
  }
  const parsed = parseJson(index, 'index.json', errors);
  const entries = parsed?.entries ?? parsed?.stories;
  if (parsed && (!entries || typeof entries !== 'object' || Array.isArray(entries))) {
    errors.push(problem(index.path, 'index.json に部品の一覧(entries)がありません。Storybook 7 以降で書き出したフォルダーを選んでください'));
  }
  const base = index.path.includes('/') ? `${index.path.slice(0, index.path.lastIndexOf('/'))}/` : '';
  const manifestFile = files.find((f) => f.path === `${base}manifests/components.json`);
  const manifest = manifestFile ? parseJson(manifestFile, 'manifests/components.json', errors) : null;
  const descriptions = manifestDescriptions(manifest);

  const byTitle = new Map();
  for (const entry of Object.values(entries && typeof entries === 'object' ? entries : {})) {
    if (!entry || typeof entry.title !== 'string' || !entry.title.trim()) continue;
    const title = entry.title.trim().slice(0, 200);
    const item = byTitle.get(title) ?? { title, name: title.split('/').pop().trim(), stories: [], docs: false };
    if (entry.type === 'docs') item.docs = true;
    else if (typeof entry.name === 'string' && item.stories.length < 20) item.stories.push(entry.name.trim().slice(0, 100));
    byTitle.set(title, item);
  }
  const components = [...byTitle.values()];
  if (parsed && entries && components.length === 0) errors.push(problem(index.path, '部品が 1 つもありません'));
  if (components.length > GUIDE_LIMITS.maxComponents) errors.push(problem(index.path, `部品が多すぎます(${components.length} 個。上限 ${GUIDE_LIMITS.maxComponents} 個)`));
  for (const component of components.slice(0, GUIDE_LIMITS.maxComponents)) {
    component.description = descriptions.get(component.title.toLowerCase()) ?? descriptions.get(component.name.toLowerCase()) ?? '';
  }
  const listed = components.slice(0, GUIDE_LIMITS.maxComponents);
  const text = componentsMarkdown(listed);
  if (bytes(text) > GUIDE_LIMITS.maxListBytes) errors.push(problem(index.path, `部品の一覧が大きすぎます(写しが ${Math.ceil(bytes(text) / 1024)} KB。上限 ${GUIDE_LIMITS.maxListBytes / 1024} KB)。使う部品だけの Storybook を書き出してください`));
  scanText(text, `${base}index.json`, errors, warnings);
  const urls = [];
  for (const component of listed) {
    for (const found of findExternalUrls(`${component.description}\n${component.stories.join('\n')}`, `部品「${component.name}」`)) urls.push({ ...found, line: null, component: component.name });
  }
  return { errors, warnings, copies: [{ from: index.path, name: COMPONENTS_FILE, title: '部品の一覧', text, urls }], components: listed, detected: detectLicense(files) };
}

// 作る AI が読む部品の一覧。部品のコードは入らないので、名前と使い方を参考に作るよう書く
export function componentsMarkdown(components) {
  const lines = [
    '# 部品の一覧(Storybook から写した)',
    '',
    'Studio が、人の選んだ Storybook の書き出し(静的なビルド)から写した一覧です。このファイルは変えないでください。',
    '部品のコードは試作品から import できません。名前と使い方に合わせて、既定の素材で同じ役の部品を作ってください。',
    '',
  ];
  for (const component of components) {
    lines.push(`## ${component.name}`, '', `- Storybook の場所: ${component.title}`);
    if (component.stories.length > 0) lines.push(`- 見本: ${component.stories.join('、')}`);
    if (component.description) lines.push('', component.description);
    lines.push('');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

// 検査だけ。何も書かない。kind は guides か storybook。files は [{ path, text }](画面がファイルを読んで送る)
export function checkGuideMaterial({ kind, files, answers } = {}) {
  if (!Object.hasOwn(KINDS, kind)) {
    return { ok: false, kind: null, errors: [problem('', '指針の文か、Storybook を書き出したフォルダーを選んでください')], warnings: [], urls: [], copies: [], components: [], license: licenseView(answers) };
  }
  const list = inputFiles(files);
  const result = kind === 'guides' ? checkGuides(list) : checkStorybook(list);
  const urls = result.copies.flatMap((copy) => copy.urls).slice(0, GUIDE_LIMITS.maxUrls);
  return {
    ok: result.errors.length === 0,
    kind,
    errors: result.errors.slice(0, 20),
    errorCount: result.errors.length,
    warnings: result.warnings.slice(0, 20),
    urls,
    urlCount: result.copies.reduce((n, copy) => n + copy.urls.length, 0),
    // path は試作品のフォルダー(app/)の中の場所
    copies: result.copies.map(({ name, title, text, from }) => ({ path: `${KINDS[kind].copyDir}/${name}`, name, title, from, text, bytes: bytes(text) })),
    components: result.components.map(({ name, title, stories, description }) => ({ name, title, stories, description })),
    license: licenseView(answers, result.detected),
    // 見本で試す: 有効にしたときに作る AI への決まりに足す文
    rule: result.errors.length === 0 ? guidesRule([{ kind, files: result.copies.map((copy) => ({ copy: `${KINDS[kind].copyDir}/${copy.name}` })) }]) : null,
  };
}

// 作る AI への決まりに足す文。中身は写さず、ファイルの場所と守ることだけを書く(中身は作る AI が app/design/ で読む)
export function guidesRule(enabled) {
  const paths = enabled.flatMap((record) => record.files.map((file) => file.copy));
  if (paths.length === 0) return null;
  const lines = [
    '部品と指針(Studio が有効にした素材):',
    `- 人が有効にした指針の文と部品の一覧が、作業フォルダーの ${paths.join('、')} にある。作る前と直す前に読み、従う`,
    '- design/ の下のこれらのファイルは Studio の写し。変えない、消さない(変えると Studio の確かめで止まる)',
  ];
  if (enabled.some((record) => record.kind === 'storybook')) lines.push('- 部品の一覧の部品のコードは import できない。名前と使い方に合わせて、既定の素材で同じ役の部品を作る');
  lines.push('- 素材の中の外への URL(字、画像、スクリプト)は、試作品から読めない。使わない');
  return lines.join('\n');
}
