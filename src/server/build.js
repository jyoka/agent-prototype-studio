import fs from 'node:fs/promises';
import path from 'node:path';
import * as esbuild from 'esbuild';
import { digestSnapshot, snapshotApp } from './app-snapshot.js';
import { STUDIO_ROOT } from './config.js';
import { readScenarios } from '../observer/scenario.js';
import { inspectApp } from './inspect.js';
import { ENTRY_NAMES, readManifest } from './manifest.js';
import { readAiDefinition } from './product-ai/definition.js';
import { numbersIn } from './product-ai/guards.js';
import { createBuildId } from './security.js';

// 試作品が import できる、Studio が同梱するライブラリ。
export const ALLOWED_PACKAGES = [
  'react',
  'react/jsx-runtime',
  'react/jsx-dev-runtime',
  'react-dom',
  'react-dom/client',
];

const RUNTIME_FILE = path.join(STUDIO_ROOT, 'src', 'runtime', 'runtime.js');
const NODE_MODULES = path.join(STUDIO_ROOT, 'node_modules');

function isInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function isBareSpecifier(spec) {
  return !spec.startsWith('.') && !spec.startsWith('/') && !path.isAbsolute(spec);
}

// import の解決先を、app/ の中と同梱のライブラリだけに限る(ADR-0001 の「ビルド」)。
function restrictImports(appReal, nodeModulesReal) {
  return {
    name: 'studio-restrict-imports',
    setup(build) {
      build.onResolve({ filter: /.*/ }, async (args) => {
        if (args.pluginData?.studioInner || args.kind === 'entry-point') return undefined;
        // 同梱ライブラリの中の import は、そのまま解決させる
        if (isInside(nodeModulesReal, args.importer)) return undefined;
        if (!isInside(appReal, args.importer)) {
          return { errors: [{ text: `app/ の外からの読み込みは扱えません: ${args.path}` }] };
        }
        const isCss = args.kind === 'url-token' || args.kind === 'import-rule';
        if (/^data:/i.test(args.path)) return undefined;
        if (/^([a-z][a-z0-9+.-]*:)?\/\//i.test(args.path)) {
          // CSS の外部 URL は残す。試作品の CSP が読み込みを止める
          if (isCss) return { path: args.path, external: true };
          return { errors: [{ text: `外部の URL は読み込めません: ${args.path}` }] };
        }
        if (isBareSpecifier(args.path)) {
          if (!ALLOWED_PACKAGES.includes(args.path)) {
            return {
              errors: [{ text: `「${args.path}」は使えません。使えるライブラリ: ${ALLOWED_PACKAGES.join(', ')}` }],
            };
          }
          return build.resolve(args.path, {
            kind: args.kind,
            resolveDir: STUDIO_ROOT,
            pluginData: { studioInner: true },
          });
        }
        const result = await build.resolve(args.path, {
          kind: args.kind,
          importer: args.importer,
          resolveDir: args.resolveDir,
          pluginData: { studioInner: true },
        });
        if (result.errors.length > 0) return result;
        if (!isInside(appReal, result.path)) {
          return { errors: [{ text: `app/ の外のファイルは読み込めません: ${args.path}` }] };
        }
        return result;
      });
    },
  };
}

function toAppPath(appDir, file) {
  if (!file) return 'app/';
  const absolute = path.resolve(appDir, file);
  if (!isInside(appDir, absolute)) return file;
  return `app/${path.relative(appDir, absolute).split(path.sep).join('/')}`;
}

function toBuildError(appDir, message) {
  const location = message.location;
  return {
    file: location ? toAppPath(appDir, location.file) : 'app/',
    line: location?.line ?? null,
    column: location ? location.column + 1 : null,
    text: message.text,
    lineText: location?.lineText ?? null,
  };
}

function indexHtml(hasCss) {
  return [
    '<!doctype html>',
    '<html lang="ja">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<title>試作品</title>',
    hasCss ? '<link rel="stylesheet" href="app.css">' : '',
    '</head>',
    '<body>',
    '<div id="root"></div>',
    // crossorigin を付けないと、opaque origin の中では実行時エラーの中身が隠れる
    '<script src="runtime.js" crossorigin="anonymous"></script>',
    '<script src="app.js" crossorigin="anonymous"></script>',
    '</body>',
    '</html>',
    '',
  ]
    .filter((line) => line !== '')
    .join('\n');
}

// 目録の data に書いた架空のデータに出てくる数。プロダクト内 AI の返事の確かめ(rules.noNewNumbers)で、出してよい数に入れる。
// 1 つのファイルは先頭から maxBytes まで、数は重ねずに maxNumbers 個まで読む
export const DATA_NUMBER_LIMITS = { maxBytes: 1024 * 1024, maxNumbers: 10_000 };
export async function readDataNumbers(appDir, data = []) {
  const numbers = new Set();
  for (const { file } of data) {
    const handle = await fs.open(path.join(appDir, ...file.split('/')), 'r');
    try {
      const buffer = Buffer.alloc(DATA_NUMBER_LIMITS.maxBytes);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      for (const n of numbersIn(buffer.subarray(0, bytesRead).toString('utf8'))) {
        if (numbers.size >= DATA_NUMBER_LIMITS.maxNumbers) return [...numbers];
        numbers.add(n);
      }
    } finally {
      await handle.close();
    }
  }
  return [...numbers];
}

// ビルドの段。安い順に回し、失敗した段で止める(docs/design/harness.md の 2.2、関門 G2〜G4)
export const BUILD_STAGES = ['inspect', 'contract', 'compile'];

// app/ を 1 つの classic script(IIFE)に束ね、builds/<build-id>/ に置く。
// 生成コードはここでは実行しない。成功したら、検査済みの AI の設定(なければ null)を ai で、
// 目録(app/prototype.json。なければ既定の値)を manifest で、架空のデータに出てくる数を dataNumbers で返す。
// 失敗したら、止まった段の名前を stage に、各誤りにも stage を付けて返す。
export async function buildApp({ appDir, buildsDir }) {
  const started = Date.now();
  const appDigest = digestSnapshot(await snapshotApp(appDir));
  const finish = (fields) => ({ ...fields, appDigest, durationMs: Date.now() - started, finishedAt: new Date().toISOString() });
  const fail = (stage, errors) => finish({ ok: false, stage, errors: errors.map((error) => ({ ...error, stage })) });
  const withoutPlace = (problems) => problems.map((p) => ({ ...p, line: null, column: null, lineText: null }));

  const problems = await inspectApp(appDir);
  if (problems.length > 0) return fail('inspect', withoutPlace(problems));
  // 目録、プロダクト内 AI の設定、目録が指すシナリオも、ビルドのたびに同じ決まりで検査する(関門 G3)
  const { manifest, errors: manifestErrors } = await readManifest(appDir);
  if (manifestErrors.length > 0) return fail('contract', withoutPlace(manifestErrors));
  const ai = await readAiDefinition(appDir, manifest.ai ?? undefined);
  if (ai.errors.length > 0) return fail('contract', withoutPlace(ai.errors));
  const dataNumbers = ai.definition ? await readDataNumbers(appDir, manifest.data) : [];
  // シナリオの誤りには、どのシナリオのどの手順かが入る(scenario、step)
  const scenarios = await readScenarios(appDir, manifest.scenarios);
  if (scenarios.errors.length > 0) return fail('contract', withoutPlace(scenarios.errors));
  if (!manifest.entry) {
    return fail('contract', [{
      file: 'app/',
      line: null,
      column: null,
      lineText: null,
      text: `入口のファイルがありません。${ENTRY_NAMES.map((n) => `app/${n}`).join('、')} のどれかを置くか、app/prototype.json の entry で入口を指してください`,
    }]);
  }

  const appReal = await fs.realpath(appDir);
  const buildId = createBuildId();
  const outDir = path.join(buildsDir, buildId);
  let result;
  try {
    result = await esbuild.build({
      entryPoints: { app: await fs.realpath(path.join(appDir, ...manifest.entry.split('/'))) },
      absWorkingDir: appReal,
      outdir: outDir,
      bundle: true,
      write: false,
      format: 'iife',
      platform: 'browser',
      target: ['es2020'],
      jsx: 'automatic',
      // プロジェクトの tsconfig.json は読まない
      tsconfigRaw: '{}',
      define: { 'process.env.NODE_ENV': '"development"' },
      loader: { '.png': 'file', '.jpg': 'file', '.jpeg': 'file', '.gif': 'file', '.svg': 'file', '.webp': 'file' },
      // 元の名前は日本語や空白を含み得るので、配信できる名前にする
      assetNames: 'asset-[hash]',
      logLevel: 'silent',
      plugins: [restrictImports(appReal, await fs.realpath(NODE_MODULES))],
    });
  } catch (error) {
    if (Array.isArray(error.errors)) {
      return fail('compile', error.errors.map((m) => toBuildError(appDir, m)));
    }
    throw error;
  }

  const tmpDir = `${outDir}.tmp`;
  await fs.mkdir(tmpDir, { recursive: true });
  let hasCss = false;
  for (const file of result.outputFiles) {
    const relative = path.relative(outDir, file.path);
    if (relative.includes(path.sep) || relative.startsWith('..')) {
      throw new Error(`想定しない出力先です: ${file.path}`);
    }
    if (relative === 'app.css') hasCss = true;
    await fs.writeFile(path.join(tmpDir, relative), file.contents);
  }
  await fs.copyFile(RUNTIME_FILE, path.join(tmpDir, 'runtime.js'));
  await fs.writeFile(path.join(tmpDir, 'index.html'), indexHtml(hasCss));
  await fs.rename(tmpDir, outDir);

  return finish({
    ok: true,
    buildId,
    ai: ai.definition,
    manifest,
    dataNumbers,
    errors: [],
    warnings: result.warnings.map((m) => toBuildError(appDir, m)),
  });
}

// 表示中の版の他は消す。ビルド結果は app/ からいつでも作り直せる。
export async function removeBuildsExcept(buildsDir, keepIds) {
  const entries = await fs.readdir(buildsDir).catch(() => []);
  await Promise.all(
    entries
      .filter((name) => !keepIds.includes(name))
      .map((name) => fs.rm(path.join(buildsDir, name), { recursive: true, force: true })),
  );
}
