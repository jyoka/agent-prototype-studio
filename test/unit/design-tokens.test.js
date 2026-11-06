import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { checkTokenUse, guardedRoleVariables, parseDesignTokens, tokensCss, tokensGuide, TOKEN_LIMITS } from '../../src/server/design-tokens.js';

const srgb = (r, g, b, more = {}) => ({ colorSpace: 'srgb', components: [r, g, b], ...more });
const parse = (json) => parseDesignTokens(JSON.stringify(json));
const onlyError = (json) => {
  const result = parse(json);
  assert.equal(result.ok, false, '誤りになるはず');
  return result.errors.map((error) => error.text).join('\n');
};
const valueOf = (result, name) => result.tokens.flatMap((t) => t.variables).find((v) => v.name === name)?.value;

test('見本のファイルが通り、種類ごとの CSS の値になる', async () => {
  const text = await fs.readFile(new URL('../fixtures/design-tokens/tokens.json', import.meta.url), 'utf8');
  const result = parseDesignTokens(text);
  assert.deepEqual(result.errors, []);
  assert.equal(result.ok, true);
  assert.equal(valueOf(result, '--token-color-accent'), 'rgb(0 128 64)');
  assert.equal(valueOf(result, '--token-color-brand'), 'rgb(0 128 64)', '参照は先の値になる');
  assert.equal(valueOf(result, '--token-font-body'), '"Minato Gothic", monospace');
  assert.equal(valueOf(result, '--token-size-gap'), '24px');
  assert.equal(valueOf(result, '--token-heading-font-size'), '32px');
  assert.equal(valueOf(result, '--token-heading-font-weight'), '700');
  assert.equal(valueOf(result, '--token-heading-line-height'), '1.2');
  assert.equal(valueOf(result, '--token-elevation'), '0px 2px 8px 0px rgb(26 26 77)');
  assert.deepEqual(result.roles, { background: 'color.background', text: 'color.text', action: 'color.accent', danger: 'color.error', font: 'font.body' });
});

test('残りの種類と色の空間も CSS の値になる', () => {
  const result = parse({
    a: { $type: 'color', $value: { colorSpace: 'oklch', components: [0.5, 0.1, 120], alpha: 0.5 } },
    b: { $type: 'color', $value: { colorSpace: 'hsl', components: ['none', 50, 40] } },
    c: { $type: 'color', $value: { colorSpace: 'display-p3', components: [1, 0, 0] } },
    d: { $type: 'duration', $value: { value: 200, unit: 'ms' } },
    e: { $type: 'cubicBezier', $value: [0.2, 0, 0.8, 1.5] },
    f: { $type: 'number', $value: 1.5 },
    g: { $type: 'fontWeight', $value: 'semi-bold' },
    h: { $type: 'strokeStyle', $value: 'dashed' },
    i: { $type: 'border', $value: { color: srgb(0, 0, 0), width: { value: 1, unit: 'px' }, style: { dashArray: [{ value: 2, unit: 'px' }], lineCap: 'round' } } },
    j: { $type: 'transition', $value: { duration: '{d}', delay: { value: 0, unit: 's' }, timingFunction: '{e}' } },
    k: { $type: 'gradient', $value: [{ color: srgb(1, 1, 1), position: 0 }, { color: srgb(0, 0, 0), position: 2 }] },
    l: { $type: 'shadow', $value: [{ color: srgb(0, 0, 0), offsetX: { value: 0, unit: 'rem' }, offsetY: { value: 1, unit: 'rem' }, inset: true }] },
  });
  assert.deepEqual(result.errors, []);
  assert.equal(valueOf(result, '--token-a'), 'oklch(0.5 0.1 120 / 0.5)');
  assert.equal(valueOf(result, '--token-b'), 'hsl(none 50% 40%)');
  assert.equal(valueOf(result, '--token-c'), 'color(display-p3 1 0 0)');
  assert.equal(valueOf(result, '--token-d'), '200ms');
  assert.equal(valueOf(result, '--token-e'), 'cubic-bezier(0.2, 0, 0.8, 1.5)');
  assert.equal(valueOf(result, '--token-g'), '600');
  assert.equal(valueOf(result, '--token-i'), '1px dashed rgb(0 0 0)');
  assert.equal(valueOf(result, '--token-j'), '200ms cubic-bezier(0.2, 0, 0.8, 1.5) 0s');
  assert.equal(valueOf(result, '--token-k'), 'rgb(255 255 255) 0%, rgb(0 0 0) 100%', 'position は 0 から 1 に切る');
  assert.equal(valueOf(result, '--token-l'), 'inset 0rem 1rem 0px 0px rgb(0 0 0)');
});

test('形の誤りを、場所と直し方が分かる利用者の言葉で返す', () => {
  // 読めない
  assert.match(parseDesignTokens('').errors[0].text, /空です/);
  assert.match(parseDesignTokens('{"a": 1,\n  oops}').errors[0].text, /JSON として読めません.*2 行目/);
  assert.match(parseDesignTokens('[]').errors[0].text, /いちばん外は \{\}/);
  assert.match(parseDesignTokens('{}').errors[0].text, /トークンが 1 つもありません/);
  // 種類
  assert.match(onlyError({ color: { accent: { $value: srgb(0, 0, 0) } } }), /「color\.accent」: 種類がありません。\$type/);
  assert.match(onlyError({ a: { $type: 'colour', $value: srgb(0, 0, 0) } }), /種類「colour」は仕様にありません/);
  // 古い書き方は、何を選べばよいかを言う
  assert.match(onlyError({ a: { $type: 'color', $value: '#ff0000' } }), /「a」: 色が文字列.*2025\.10 の形/);
  assert.match(onlyError({ a: { $type: 'dimension', $value: '16px' } }), /「a」: 大きさが 16px と書かれています/);
  // 範囲
  assert.match(onlyError({ a: { $type: 'color', $value: srgb(2, 0, 0) } }), /1 つ目\(2\)が範囲の外/);
  assert.match(onlyError({ a: { $type: 'color', $value: { colorSpace: 'cmyk', components: [0, 0, 0] } } }), /色の空間「cmyk」は仕様にありません/);
  assert.match(onlyError({ a: { $type: 'color', $value: { colorSpace: 'hsl', components: [360, 0, 0] } } }), /範囲の外/);
  assert.match(onlyError({ a: { $type: 'fontWeight', $value: 2000 } }), /字の太さは 1 から 1000/);
  assert.match(onlyError({ a: { $type: 'cubicBezier', $value: [2, 0, 0, 0] } }), /x1 と x2 は 0 から 1/);
  // 名前と形
  assert.match(onlyError({ 'a.b': { $type: 'number', $value: 1 } }), /名前に \{、\}、\. は使えません/);
  assert.match(onlyError({ a: 1 }), /「a」: トークンかグループの形ではありません/);
  assert.match(onlyError({ a: { $type: 'number', $value: 1, b: { $value: 2 } } }), /トークンの中に別のトークン/);
  // 参照
  assert.match(onlyError({ a: { $type: 'color', $value: '{b}' } }), /参照の先「b」が見つかりません/);
  assert.match(onlyError({ a: { $type: 'color', $value: '{b}' }, b: { $type: 'color', $value: '{a}' } }), /参照が輪になっています/);
  assert.match(onlyError({ a: { $type: 'color', $value: '{n}' }, n: { $type: 'number', $value: 1 } }), /参照の先「n」は数です。色のトークンを指してください/);
  assert.match(onlyError({ a: { $type: 'shadow', $value: ['{a}'] } }), /参照が輪になっています/);
  assert.match(onlyError({ a: { $type: 'gradient', $value: ['{a}'] } }), /参照が輪になっています/);
  assert.match(onlyError({ a: { $type: 'shadow', $value: [{ $ref: '#/a/$value' }] } }), /参照が輪になっています/);
  for (const colorSpace of ['constructor', '__proto__', 'toString']) {
    assert.match(onlyError({ a: { $type: 'color', $value: { colorSpace, components: [0, 0, 0] } } }), /色の空間.*は仕様にありません/);
  }
  // colorSpace がない、文字列でない: 何をどう書くかを言う
  for (const value of [{ hex: '#ff0000' }, { components: [0, 0, 0] }, { colorSpace: ['hsl'], components: [0, 0, 0] }, { colorSpace: null, components: [0, 0, 0] }, { colorSpace: {}, components: [0, 0, 0] }]) {
    assert.match(onlyError({ a: { $type: 'color', $value: value } }), /「a」: 色に colorSpace がありません。\{"colorSpace": "srgb", "components": \[赤, 緑, 青\]\} の形で書いてください/);
  }
  // $type と $ref が文字列でない: 例外にせず、書き方を言う
  for (const $type of [7, ['color'], {}, { toString: 1, valueOf: 1 }, null]) {
    assert.match(onlyError({ a: { $type, b: { $value: 1 } } }), /「a\.b」: \$type は種類の名前を文字列で書いてください/);
  }
  assert.match(onlyError({ a: { $type: 'color', $value: '{b}' }, b: { $value: 1 } }), /参照の先「b」は種類の分からないトークンです。色のトークンを指してください/);
  assert.match(onlyError({ a: { $type: 'color', $value: '{b}' }, b: { $type: { toString: 1 }, $value: 1 } }), /参照の先「b」は種類の分からないトークンです/);
  assert.match(onlyError({ a: { $ref: { toString: 1 } } }), /「a」: \$ref は #\/ で始まるこのファイルの中の場所を、文字列で書いてください/);
  // 開発の言葉の例外の文を出さない
  assert.doesNotMatch(onlyError({ a: { $type: 'border', $value: {} } }), /undefined|TypeError|Cannot/);
});

test('どの種類に崩れた値を書いても、例外にならず、開発の言葉を見せない', () => {
  const broken = [null, true, 0, 'x', [], {}, [[]], [null], { value: null }, { colorSpace: null }, { color: null }, { $ref: 1 }, { $ref: {} }, { toString: 1, valueOf: 1 }];
  const types = ['color', 'dimension', 'fontFamily', 'fontWeight', 'duration', 'cubicBezier', 'number', 'strokeStyle', 'border', 'transition', 'shadow', 'gradient', 'typography'];
  for (const $type of types) {
    for (const $value of broken) {
      const { errors } = parse({ a: { $type, $value } });
      for (const { text } of errors) assert.doesNotMatch(text, /undefined|\[object |TypeError|Cannot/, `${$type} ${JSON.stringify($value)}: ${text}`);
    }
  }
});

test('変数の名前の決まりと、ぶつかる名前の誤り', () => {
  const result = parse({ colorScheme: { brandPrimary: { $type: 'number', $value: 1 } }, 色: { 地: { $type: 'number', $value: 2 } } });
  assert.deepEqual(result.tokens.flatMap((t) => t.variables.map((v) => v.name)), ['--token-color-scheme-brand-primary', '--token-色-地']);
  assert.match(onlyError({ a: { b: { $type: 'number', $value: 1 } }, 'a-b': { $type: 'number', $value: 2 } }), /同じ変数の名前\(--token-a-b\)/);
});

test('型はグループから受け継ぎ、参照は先の型を使う。$root と $ref と $extends を解く', () => {
  const result = parse({
    $schema: 'https://www.designtokens.org/schemas/2025.10/format.json',
    base: {
      $type: 'color',
      blue: { $root: { $value: srgb(0, 0, 1) }, light: { $value: srgb(0.5, 0.5, 1) } },
    },
    alias: { $value: '{base.blue.$root}' },
    component: { $type: 'color', $value: { colorSpace: 'srgb', components: [{ $ref: '#/base/blue/light/$value/components/0' }, 0, 0] } },
    theme: { $extends: '{base}', extra: { $value: srgb(1, 0, 0) } },
  });
  assert.deepEqual(result.errors, []);
  assert.equal(valueOf(result, '--token-base-blue'), 'rgb(0 0 255)');
  assert.equal(valueOf(result, '--token-alias'), 'rgb(0 0 255)');
  assert.equal(valueOf(result, '--token-component'), 'rgb(128 0 0)');
  assert.equal(valueOf(result, '--token-theme-blue'), 'rgb(0 0 255)', '$extends は写す');
  assert.equal(valueOf(result, '--token-theme-extra'), 'rgb(255 0 0)');
  assert.match(onlyError({ a: { $extends: '{b}', x: { $type: 'number', $value: 1 } }, b: { $extends: '{a}' } }), /\$extends が輪/);
  // $value のない $ref: トークンを指せば別名、グループを指せば $extends と同じ
  const refs = parse({
    base: { $type: 'color', blue: { $value: srgb(0, 0, 1) } },
    alias: { $ref: '#/base/blue' },
    copy: { $ref: '#/base', extra: { $value: srgb(1, 0, 0) } },
  });
  assert.deepEqual(refs.errors, []);
  assert.equal(valueOf(refs, '--token-alias'), 'rgb(0 0 255)');
  assert.equal(valueOf(refs, '--token-copy-blue'), 'rgb(0 0 255)');
  assert.equal(valueOf(refs, '--token-copy-extra'), 'rgb(255 0 0)');
  assert.match(onlyError({ a: { $ref: '#/nothing' } }), /\$ref の先「#\/nothing」が見つかりません/);
  assert.match(onlyError({ a: { $type: 'color', $value: { $ref: 'https://example.invalid/x' } } }), /\$ref は #\/ で始まる/);
});

test('仕様にない $ の項目は使わないと知らせ、$extensions と $description は黙って読み飛ばす', () => {
  const result = parse({
    $themes: [],
    a: { $type: 'number', $value: 1, $description: '架空', $extensions: { 'com.example': { css: 'url(https://example.invalid)' } }, $deprecated: true },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.warnings, ['$themes は仕様にないので使いません']);
});

test('値は CSS の文に混ざらない。外の URL も別の宣言も入らない', () => {
  const css = (json) => {
    const result = parse(json);
    return result.ok ? tokensCss(result.tokens, result.roles) : result.errors[0].text;
  };
  const font = css({ a: { $type: 'fontFamily', $value: 'x"; } body { background: url(https://example.invalid/a.png); } .y { --z: "' } });
  assert.match(font, /--token-a: "x\\"; \} body \{ background: url\(https:\/\/example\.invalid\/a\.png\); \} \.y \{ --z: \\"";/, '字の名前は引用符の中に閉じる');
  assert.match(css({ a: { $type: 'fontFamily', $value: 'x\n}' } }), /制御文字/);
  // 色、大きさ、名前の文字列は形で落ちる
  assert.equal(parse({ a: { $type: 'color', $value: 'url(https://example.invalid)' } }).ok, false);
  assert.equal(parse({ a: { $type: 'dimension', $value: { value: 1, unit: 'px;background:url(x)' } } }).ok, false);
  assert.equal(parse({ a: { $type: 'strokeStyle', $value: 'solid;background:url(x)' } }).ok, false);
  const named = parse({ 'a;b:url(x)': { $type: 'number', $value: 1 } });
  assert.deepEqual(named.tokens[0].variables.map((v) => v.name), ['--token-a-b-url-x']);
});

test('大きすぎるファイル、深すぎる入れ子、多すぎるトークン、秘密らしい文字列を断る', () => {
  assert.match(parseDesignTokens(`{"a":"${'x'.repeat(TOKEN_LIMITS.maxBytes)}"}`).errors[0].text, /大きすぎます/);
  let deep = { $type: 'number', $value: 1 };
  for (let i = 0; i < TOKEN_LIMITS.maxDepth + 2; i += 1) deep = { [`g${i}`]: deep };
  assert.equal(parse(deep).ok, false);
  const many = Object.fromEntries(Array.from({ length: TOKEN_LIMITS.maxTokens + 1 }, (_, i) => [`t${i}`, { $type: 'number', $value: i }]));
  assert.match(onlyError(many), /トークンが多すぎます/);
  // 検査の道具が見分ける形の、架空の鍵
  const secret = parseDesignTokens(JSON.stringify({ a: { $type: 'number', $value: 1, $description: `sk-ant-api03-${'a'.repeat(40)}` } }));
  assert.match(secret.errors[0].text, /秘密の値らしい文字列/);
  // JSON の文字の書き換えで隠れていても見つける
  const hidden = parseDesignTokens(`{"a": {"$type": "number", "$value": 1, "$description": "sk\\u002dant\\u002dapi03-${'a'.repeat(40)}"}}`);
  assert.match(hidden.errors[0].text, /秘密の値らしい文字列/);
  // 素材のファイルは引き継ぎにそのまま入るので、個人の情報らしい文字列も断る(架空の値)
  const personal = parse({ a: { $type: 'number', $value: 1, $description: '担当 kakuu@example.com' } });
  assert.match(personal.errors[0].text, /個人の情報らしい文字列\(メールアドレス\)/);
  assert.match(onlyError({ [`n${'x'.repeat(200)}`]: { $type: 'number', $value: 1 } }), /場所の名前が長すぎます/);
});

test('数は個人の情報として探さない。文字列の中は名前も値も探す', () => {
  // n/255 を小数 10 桁か 11 桁に丸めた色と、小さい大きさ(0 の後の桁が電話番号の形に当たる)
  for (const digits of [10, 11]) {
    const components = Array.from({ length: 255 }, (_, n) => Number((n / 255).toFixed(digits)));
    const colors = Object.fromEntries(components.map((c, n) => [`c${n}`, { $value: srgb(c, c, c) }]));
    assert.deepEqual(parse({ color: { $type: 'color', ...colors } }).errors, [], `小数 ${digits} 桁`);
  }
  const small = parse({ a: { $type: 'color', $value: srgb(0.0666666667, 0.0666666667, 0.0666666667) }, b: { $type: 'dimension', $value: { value: 0.0123456789, unit: 'rem' } } });
  assert.deepEqual(small.errors, []);
  assert.equal(valueOf(small, '--token-a'), 'rgb(17 17 17)');
  assert.equal(valueOf(small, '--token-b'), '0.012346rem');
  // 説明の文、名前、拡張の中の文字列は断る(架空の値)
  const refused = (json, kind) => assert.match(onlyError(json), new RegExp(`個人の情報らしい文字列\\(${kind}\\)`));
  refused({ a: { $type: 'number', $value: 1, $description: '担当 090-0000-1111' } }, '電話番号');
  refused({ a: { $type: 'number', $value: 1, $description: '担当 09000001111' } }, '電話番号');
  refused({ a: { $type: 'number', $value: 1, $description: '担当 kakuu@example.com' } }, 'メールアドレス');
  refused({ 'kakuu@example.com': { $type: 'number', $value: 1 } }, 'メールアドレス');
  refused({ a: { $type: 'number', $value: 1, $extensions: { 'com.example': { tel: '090-0000-1111' } } } }, '電話番号');
  refused({ a: { $type: 'number', $value: 1, $description: 'かわせみ町1-2-3 の店' } }, '住所');
  refused({ a: { $type: 'number', $value: 1, $description: 'みほん太郎と申します' } }, '氏名');
  // 字の名前に書いても断る。文字の書き換えで隠しても見つける
  refused({ a: { $type: 'fontFamily', $value: '090-0000-1111' } }, '電話番号');
  assert.match(parseDesignTokens('{"a": {"$type": "number", "$value": 1, "$description": "kakuu\\u0040example.com"}}').errors[0].text, /メールアドレス/);
});

test('参照や $extends を重ねて倍々に膨らむファイルは、止まらずに断る', () => {
  const shadows = {};
  const level = 40;
  for (let i = 0; i < level; i += 1) shadows[`s${i}`] = { $type: 'shadow', $value: [`{s${i + 1}}`, `{s${i + 1}}`] };
  shadows[`s${level}`] = { $type: 'shadow', $value: { color: srgb(0, 0, 0), offsetX: { value: 0, unit: 'px' }, offsetY: { value: 0, unit: 'px' } } };
  const started = Date.now();
  assert.match(onlyError(shadows), /重なりが多すぎます/);
  const groups = {};
  for (let i = 0; i < level; i += 1) groups[`g${i}`] = { a: { $extends: `{g${i + 1}}` }, b: { $extends: `{g${i + 1}}` } };
  groups[`g${level}`] = { t: { $type: 'number', $value: 1 } };
  assert.match(onlyError(groups), /重なりが多すぎます/);
  assert.ok(Date.now() - started < 10_000, '止まらずに終わる');
});

test('__proto__ の名前で Object を汚さない', () => {
  const result = parseDesignTokens('{"__proto__": {"a": {"$type": "number", "$value": 1}}}');
  assert.equal({}.a, undefined);
  assert.equal(result.ok, true);
  assert.match(onlyError({ a: { $type: 'constructor', $value: 1 }, b: { $type: 'color', $value: '{a}' } }), /「constructor」は仕様にありません/);
});

test('役割は既定の素材の変数に届く。足りない役割は書かない', () => {
  const { tokens } = parse({
    accent: { $type: 'color', $value: srgb(1, 1, 0) },
    body: { $type: 'fontFamily', $value: 'Minato Gothic' },
  });
  const css = tokensCss(tokens, { action: 'accent', font: 'body', background: null });
  assert.match(css, /:root \{\n {2}--token-accent: rgb\(255 255 0\);/);
  assert.match(css, /\.radix-themes\[data-accent-color\] \{/);
  assert.match(css, /--accent-9: var\(--token-accent\);/);
  assert.match(css, /--accent-contrast: black;/, '明るい色の上の字は黒');
  assert.match(css, /--default-font-family: var\(--token-body\);/);
  assert.doesNotMatch(css, /--color-background|--gray-12|--red-9/);
  // 作った変数は全部守る
  const guarded = guardedRoleVariables(tokens, { action: 'accent' });
  for (const name of ['--accent-9', '--accent-10', '--accent-a3', '--accent-indicator', '--accent-contrast']) assert.ok(guarded.includes(name), name);
  for (const name of guarded) assert.ok(css.includes(`${name}: `), `${name} は CSS にある`);
  // 種類の違うトークンは当てない
  assert.doesNotMatch(tokensCss(tokens, { action: 'body' }), /--accent-9/);
});

test('作る AI の決まりには、名前と役割を書き、値を書かない', () => {
  const { tokens, roles } = parse({ color: { $type: 'color', accent: { $value: srgb(0, 0.5, 0.25) } } });
  const guide = tokensGuide(tokens, roles);
  assert.match(guide, /押せる所: var\(--token-color-accent\)/);
  assert.match(guide, /- --token-color-accent\(色\)/);
  assert.doesNotMatch(guide, /rgb\(/);
  const many = Object.fromEntries(Array.from({ length: 1000 }, (_, i) => [`long-name-${i}`, { $type: 'number', $value: i }]));
  const long = tokensGuide(parse(many).tokens, {});
  assert.ok(long.length < 6100);
  assert.match(long, /ほかに \d+ 個あります/);
});

test('作る AI が素材の変数を書き換えると見つける。読むだけなら通す', async (t) => {
  const appDir = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-token-use-'));
  t.after(() => fs.rm(appDir, { recursive: true, force: true }));
  const { tokens, roles } = parse({ color: { $type: 'color', accent: { $value: srgb(0, 0.5, 0.25) } } });
  const check = async (name, content) => {
    await fs.writeFile(path.join(appDir, name), content);
    const problems = await checkTokenUse(appDir, tokens, roles);
    await fs.rm(path.join(appDir, name));
    return problems;
  };
  // 読むだけ
  assert.deepEqual(await check('ok.css', '.a { color: var(--token-color-accent); background: var(--token-color-accent, red); }\n'), []);
  assert.deepEqual(await check('ok.jsx', "const c = getComputedStyle(document.body).getPropertyValue('--token-color-accent');\nconst v = 'var(--token-color-accent)';\n"), []);
  assert.deepEqual(await check('template.js', 'const v = `var(--token-color-${name})`;\n'), [], '組み立てた名前は見分けない');
  assert.deepEqual(await check('data.json', '{"--token-color-accent": "red"}\n'), [], 'CSS と JS でないファイルは見ない');
  // 書き換え
  const inCss = await check('bad.css', 'html body {\n  --token-color-accent: red;\n}\n');
  assert.equal(inCss.length, 1);
  assert.equal(inCss[0].file, 'app/bad.css');
  assert.equal(inCss[0].line, 2);
  assert.equal(inCss[0].lineText, '  --token-color-accent: red;');
  assert.match(inCss[0].text, /つないだ素材の変数 --token-color-accent を書き換えています/);
  assert.equal((await check('bad.jsx', "<div style={{ '--token-color-accent': 'red' }} />\n")).length, 1);
  assert.equal((await check('bad.js', "document.documentElement.style.setProperty('--token-color-accent', 'red');\n")).length, 1);
  assert.equal((await check('bad.ts', 'const s = { ["--token-color-accent"]: "red" };\n')).length, 1);
  // 整形で改行が入っても見つける
  assert.equal((await check('wrapped.js', 'el.style.setProperty(\n  "--token-color-accent",\n  "red",\n);\n')).length, 1);
  assert.equal((await check('wrapped.css', ':root {\n  --token-color-accent\n    : red;\n}\n')).length, 1);
  assert.equal((await check('other.mts', "el.style.setProperty('--token-color-accent', 'red');\n")).length, 1);
  // 新しい名前を定義しても止める。役割を当てた既定の素材の変数も同じ
  assert.match((await check('new.css', ':root { --token-color-new: red; }\n'))[0].text, /書き換えています/);
  assert.match((await check('role.css', '.x { --accent-9: red; }\n'))[0].text, /--accent-9 を書き換えています/);
  assert.match((await check('step.css', '.x { --accent-10: red; }\n'))[0].text, /--accent-10 を書き換えています/);
  assert.deepEqual(await check('free.css', '.x { --gray-12: red; --my-own: 1px; }\n'), [], '当てていない役割と、自分の変数は止めない');
  // 変数ではない語で止めない
  assert.deepEqual(await check('class.css', '.badge--token-count { color: red; }\n.badge--token-count:hover { color: blue; }\n'), []);
  assert.deepEqual(await check('prose.jsx', 'const t = "--token-file を指定します";\n/* --token-color-accentを使う */\n'), []);
  // つないでいない変数の読み
  assert.match((await check('typo.css', '.x { color: var(--token-color-acent); }\n'))[0].text, /変数 --token-color-acent は、つないだトークンにありません/);
});
