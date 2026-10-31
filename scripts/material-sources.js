// 同梱の素材の一覧を作る。materials/default/source.json と licenses/ を、入っているパッケージから書き直す。
// 依存を変えたら `npm run materials:sources` で作り直し、差分を見てからコミットする。
// test/unit/materials.test.js が、一覧と入っているものの差を確かめる
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { NPM_LIBRARIES } from '../src/server/build.js';
import { STUDIO_ROOT } from '../src/server/config.js';

export const MATERIAL_DIR = path.join(STUDIO_ROOT, 'materials', 'default');
const LICENSES_DIR = path.join(MATERIAL_DIR, 'licenses');
const UPSTREAM_DIR = path.join(MATERIAL_DIR, 'licenses-upstream');
const LICENSE_FILE = /^(licen[sc]e|copying)(\.(md|txt))?$/i;

// npm のパッケージに repository の欄がないものの出典(design-materials.md の 2 節で読んだ所)
const SOURCE_OVERRIDES = { '@radix-ui/colors': 'https://github.com/radix-ui/colors' };
// 人が読むための役。ここにないものは、役のあるパッケージが中で使うもの
const ROLES = [
  { role: '土台', package: 'react', about: '試作品の画面を動かす' },
  { role: '土台', package: 'react-dom', about: '試作品の画面を動かす' },
  { role: '部品', package: '@radix-ui/themes', about: '既定の部品' },
  { role: '色', package: '@radix-ui/colors', about: '既定の色の段' },
  { role: 'アイコン', package: 'lucide-react', about: '既定のアイコン。Feather から来たアイコンは MIT で、LICENSE の後半に一覧がある' },
  { role: '字', package: null, about: 'OS の字を使う。字のファイルは同梱せず、外からも読まない' },
];

const readPackage = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));

// node の解決と同じく、近い node_modules から順に探す
function findPackage(fromDir, name, root) {
  for (let dir = fromDir; ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, 'node_modules', name);
    if (fs.existsSync(path.join(candidate, 'package.json'))) return candidate;
    if (dir === root) return null;
  }
}

// 同梱の npm のパッケージと、それが使う全部を、入っているものから集める。任意の相手(@types など)は束に入らないので飛ばす
export function collectBundledPackages({ root = STUDIO_ROOT, libraries = NPM_LIBRARIES } = {}) {
  const found = new Map();
  const visit = (dir) => {
    if (found.has(dir)) return;
    const pkg = readPackage(dir);
    found.set(dir, pkg);
    for (const name of Object.keys({ ...pkg.dependencies, ...pkg.peerDependencies })) {
      if (pkg.peerDependenciesMeta?.[name]?.optional) continue;
      const next = findPackage(dir, name, root);
      if (next) visit(next);
    }
  };
  for (const name of libraries) {
    const dir = findPackage(root, name, root);
    if (!dir) throw new Error(`同梱のパッケージが入っていません: ${name}。npm install を動かしてください`);
    visit(dir);
  }
  return [...found].map(([dir, pkg]) => ({ dir, name: pkg.name, version: pkg.version, license: pkg.license, repository: pkg.repository }));
}

export function sourceUrl({ name, repository }) {
  if (Object.hasOwn(SOURCE_OVERRIDES, name)) return SOURCE_OVERRIDES[name];
  const raw = typeof repository === 'string' ? repository : repository?.url;
  if (!raw) throw new Error(`出典が分かりません: ${name}。SOURCE_OVERRIDES に足してください`);
  return raw.replace(/^git\+/, '').replace(/^git@github\.com:/, 'https://github.com/').replace(/\.git$/, '').replace(/\/$/, '');
}

const licenseName = (name) => name.replace(/^@/, '').replaceAll('/', '-');

function readLicense({ dir, name }) {
  const file = fs.readdirSync(dir).find((f) => LICENSE_FILE.test(f));
  if (file) return { text: fs.readFileSync(path.join(dir, file), 'utf8'), from: 'package' };
  // npm のパッケージに入っていないものは、出典のリポジトリから写したものを licenses-upstream/ に置く
  const upstream = path.join(UPSTREAM_DIR, `${licenseName(name)}.txt`);
  if (fs.existsSync(upstream)) return { text: fs.readFileSync(upstream, 'utf8'), from: 'upstream' };
  throw new Error(`ライセンスの原文が見つかりません: ${name}。出典から写して ${path.relative(STUDIO_ROOT, upstream)} に置いてください`);
}

// 一覧を組み立てる。同じ原文は 1 つのファイルにまとめる
export function buildSourceList(packages = collectBundledPackages()) {
  const texts = new Map();
  // 手元の言語の設定で順が変わらないように、文字のコードで並べる
  const key = (pkg) => `${pkg.name}@${pkg.version}`;
  const rows = [...packages].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0)).map((pkg) => {
    const { text, from } = readLicense(pkg);
    const hash = crypto.createHash('sha256').update(text).digest('hex');
    if (!texts.has(hash)) {
      // 同じ名前の別の版で原文が違うときは、上書きしないように版を足す
      const taken = [...texts.values()].some((entry) => entry.file === `licenses/${licenseName(pkg.name)}.txt`);
      texts.set(hash, { file: `licenses/${licenseName(pkg.name)}${taken ? `-${pkg.version}` : ''}.txt`, text });
    }
    return {
      name: pkg.name,
      version: pkg.version,
      license: pkg.license,
      source: sourceUrl(pkg),
      licenseFile: texts.get(hash).file,
      licenseFrom: from,
    };
  });
  return {
    list: {
      formatVersion: 1,
      material: '既定の素材',
      decidedIn: 'docs/design/design-materials.md の 3 節',
      roles: ROLES,
      packages: rows,
    },
    licenses: [...texts.values()],
  };
}

function main() {
  const { list, licenses } = buildSourceList();
  fs.rmSync(LICENSES_DIR, { recursive: true, force: true });
  fs.mkdirSync(LICENSES_DIR, { recursive: true });
  for (const { file, text } of licenses) fs.writeFileSync(path.join(MATERIAL_DIR, file), text);
  fs.writeFileSync(path.join(MATERIAL_DIR, 'source.json'), `${JSON.stringify(list, null, 2)}\n`);
  console.log(`${list.packages.length} 個のパッケージと、${licenses.length} 個のライセンスの原文を書きました: ${path.relative(STUDIO_ROOT, MATERIAL_DIR)}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
