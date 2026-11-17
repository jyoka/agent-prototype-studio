// 試作品が import できる、Studio が同梱するライブラリの名前(ADR 0001 の「J3 で決めたこと」)。
// build.js(import の制限)と packages.js(部品のパッケージの検査)が使う。互いに読み合わないよう、ここに置く。
// studio-talk は Studio のコードの中の会話の枠(docs/design/agent-simulation.md の 3.8。src/runtime/studio-talk/)
// @radix-ui と lucide-react は既定の素材(docs/design/design-materials.md の 3 節)。出典とライセンスは materials/default/source.json
export const ALLOWED_PACKAGES = [
  'react',
  'react/jsx-runtime',
  'react/jsx-dev-runtime',
  'react-dom',
  'react-dom/client',
  'studio-talk',
  '@radix-ui/themes',
  '@radix-ui/themes/styles.css',
  '@radix-ui/colors',
  'lucide-react',
];

// Radix Colors の色ごとの CSS。ファイルは 100 を超えるので、形で許す。色の名前の外には出られない
export const RADIX_COLOR_CSS = /^@radix-ui\/colors\/[a-z]+(-dark)?(-alpha)?\.css$/;
export const RADIX_COLOR_CSS_LABEL = '@radix-ui/colors/<色>.css';

// 試作品と部品のパッケージが import してよい、同梱のライブラリの名前か。パッケージの中のファイル(.. を含む形も)は許さない
export function isAllowedPackage(spec) {
  return ALLOWED_PACKAGES.includes(spec) || RADIX_COLOR_CSS.test(spec);
}

// 同梱のライブラリのうち、npm のパッケージでなく Studio のコードの中にあるものの名前
export const STUDIO_PACKAGES = ['studio-talk'];

// 同梱の npm のパッケージの名前(react/jsx-runtime のような中のファイルを除く)
export const NPM_LIBRARIES = ALLOWED_PACKAGES.filter(
  (p) => p.split('/').length === (p.startsWith('@') ? 2 : 1) && !STUDIO_PACKAGES.includes(p),
);
