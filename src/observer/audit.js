// 質の見直しの、画面の検査(docs/design/user-journey.md の J6)。観察器が最後の画面で 1 回だけ動かす。
// 見るのは 2 つ。アクセシビリティの違反(ラベルのない入力、名前のないボタン、代わりの文のない画像)と、字と地の差。
// 外の検査の道具は使わない(ライセンスを確かめるまで選ばない。7 節)。決まった手順の小さな検査で、全部の規則を見るものではない。
// 字と地の差は、文字を持つ要素の色と、祖先をたどって重ねた地の色から求める(WCAG 2.2 の 1.4.3 の式)。
// 地に絵(background-image)があるもの、色を読めないものは「測れない」に数え、違反にしない。重なり(position)は見ない

// 1 つの種類で report に入れる数。数(count)は全部を数える
export const AUDIT_LIMITS = Object.freeze({ maxItems: 20, maxElements: 3000, maxText: 60, maxWhere: 80 });
// 字と地の差の基準(WCAG 2.2 の 1.4.3。大きな字は 3:1)
export const CONTRAST_MIN = Object.freeze({ normal: 4.5, large: 3 });

// CSS の色の文字(rgb()、rgba()、#rgb、#rrggbb など)を [r, g, b, a] にする。読めなければ null。
// 観察器はブラウザの中でもこの関数を使う(auditScript)。そのため、外の名前を使わない
export function parseColor(value) {
  const text = String(value ?? '').trim().toLowerCase();
  if (text === 'transparent') return [0, 0, 0, 0];
  const hex = /^#([0-9a-f]{3,8})$/.exec(text);
  if (hex) {
    let digits = hex[1];
    if (digits.length === 3 || digits.length === 4) digits = [...digits].map((d) => d + d).join('');
    if (digits.length !== 6 && digits.length !== 8) return null;
    const n = (i) => parseInt(digits.slice(i, i + 2), 16);
    return [n(0), n(2), n(4), digits.length === 8 ? Math.round((n(6) / 255) * 1000) / 1000 : 1];
  }
  const fn = /^rgba?\(([^)]*)\)$/.exec(text);
  if (!fn) return null;
  const parts = fn[1].split(/[\s,/]+/).filter(Boolean);
  if (parts.length !== 3 && parts.length !== 4) return null;
  const channel = (part) => (part.endsWith('%') ? (parseFloat(part) / 100) * 255 : parseFloat(part));
  const rgb = parts.slice(0, 3).map(channel);
  const alpha = parts[3] === undefined ? 1 : parts[3].endsWith('%') ? parseFloat(parts[3]) / 100 : parseFloat(parts[3]);
  if ([...rgb, alpha].some((v) => !Number.isFinite(v))) return null;
  return [...rgb.map((v) => Math.min(255, Math.max(0, v))), Math.min(1, Math.max(0, alpha))];
}

// 上の色(top)を下の色(bottom。不透明)に重ねた色
export function blendColor(top, bottom) {
  const a = top[3];
  return [0, 1, 2].map((i) => top[i] * a + bottom[i] * (1 - a)).concat(1);
}

// 相対輝度(WCAG 2.2 の定義)
export function luminance(color) {
  const [r, g, b] = color.slice(0, 3).map((v) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

// 字と地の差(1 から 21)。地は不透明の色で渡す
export function contrastRatio(fg, bg) {
  const a = luminance(fg[3] < 1 ? blendColor(fg, bg) : fg);
  const b = luminance(bg);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

// 色を #rrggbb で書く(画面に出すため)
export function hexOf(color) {
  return `#${color.slice(0, 3).map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
}

// 試作品の iframe の中で動かす。上の関数(parseColor など)は auditScript が同じ所に置く
function auditPage(limits, minimum) {
  const skip = new Set(['SCRIPT', 'STYLE', 'LINK', 'META', 'TEMPLATE', 'NOSCRIPT', 'HEAD', 'TITLE']);
  const clip = (text, max) => {
    const value = String(text ?? '').replace(/\s+/g, ' ').trim();
    return value.length > max ? `${value.slice(0, max)}…` : value;
  };
  const whereOf = (el) => {
    let where = el.tagName.toLowerCase();
    if (el.id) where += `#${el.id}`;
    else if (typeof el.className === 'string' && el.className.trim()) where += `.${el.className.trim().split(/\s+/).slice(0, 2).join('.')}`;
    return clip(where, limits.maxWhere);
  };
  const shown = (el) => {
    if (el.closest('[aria-hidden="true"], [inert]')) return false;
    if (el.getClientRects().length === 0) return false;
    const style = getComputedStyle(el);
    return style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) !== 0;
  };
  const textOf = (el) => clip(el?.textContent ?? '', 200);
  // 名前の求め方は、アクセシビリティの名前の計算を小さくしたもの(aria-labelledby、aria-label、ラベル、代わりの文、title の順)
  const labelledBy = (el) => (el.getAttribute('aria-labelledby') ?? '').split(/\s+/).filter(Boolean).map((id) => textOf(document.getElementById(id))).join(' ').trim();
  const nameOf = (el) => {
    const by = labelledBy(el);
    if (by) return by;
    const aria = (el.getAttribute('aria-label') ?? '').trim();
    if (aria) return aria;
    if (el.labels && el.labels.length > 0) {
      const text = [...el.labels].map(textOf).join(' ').trim();
      if (text) return text;
    }
    const tag = el.tagName;
    if (tag === 'IMG') return (el.getAttribute('alt') ?? '').trim();
    if (tag === 'INPUT' && ['submit', 'reset', 'button'].includes(el.type)) return el.value || (el.type === 'button' ? '' : el.type);
    if (tag === 'INPUT' && el.type === 'image') return (el.getAttribute('alt') ?? '').trim();
    // 中の字が名前になる役(ボタン、リンク、自作のチェックなど)
    if (tag === 'BUTTON' || tag === 'A' || ['button', 'checkbox', 'radio', 'switch', 'link', 'tab', 'option', 'menuitem'].includes(el.getAttribute('role'))) {
      const inner = textOf(el) || [...el.querySelectorAll('img[alt], [aria-label]')].map((x) => x.getAttribute('alt') || x.getAttribute('aria-label')).join(' ').trim();
      if (inner) return inner;
    }
    return (el.getAttribute('title') ?? '').trim();
  };
  const kinds = { unlabeled: [], unnamedButtons: [], missingAlt: [] };
  const counts = { unlabeled: 0, unnamedButtons: 0, missingAlt: 0, contrast: 0 };
  const push = (kind, item) => {
    counts[kind] += 1;
    if (kinds[kind].length < limits.maxItems) kinds[kind].push(item);
  };
  const contrast = [];
  let checked = 0;
  let unknown = 0;
  // 足りない所のうち、一番小さい差(report に入れない所も含めて)
  let lowest = null;
  let scanned = 0;
  let truncated = false;
  const canvas = document.createElement('canvas');
  canvas.width = 1;
  canvas.height = 1;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  // 計算した色が rgb() でない形(oklch など)なら、1 画素に描いて読む
  const colorOf = (value) => {
    const parsed = parseColor(value);
    if (parsed || !ctx) return parsed;
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = '#000';
    ctx.fillStyle = value;
    ctx.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
    return [r, g, b, Math.round((a / 255) * 1000) / 1000];
  };
  // 祖先をたどって地の色を重ねる。絵の地があれば null(測れない)
  const backgroundOf = (el) => {
    const layers = [];
    for (let node = el; node && node.nodeType === 1; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.backgroundImage && style.backgroundImage !== 'none') return null;
      const color = colorOf(style.backgroundColor);
      if (!color) return null;
      if (color[3] > 0) layers.push(color);
      if (color[3] >= 1) break;
    }
    let bg = [255, 255, 255, 1];
    for (const layer of layers.reverse()) bg = blendColor(layer, bg);
    return bg;
  };
  const textControls = 'input:not([type="hidden"]):not([type="button"]):not([type="submit"]):not([type="reset"]):not([type="image"]), select, textarea, [role="textbox"], [role="combobox"], [role="searchbox"], [role="checkbox"], [role="radio"], [role="switch"], [role="slider"]';
  const body = document.body;
  if (!body) return null;
  for (const el of body.querySelectorAll('*')) {
    if (skip.has(el.tagName)) continue;
    scanned += 1;
    if (scanned > limits.maxElements) {
      truncated = true;
      break;
    }
    if (!shown(el)) continue;
    const disabled = el.matches(':disabled') || Boolean(el.closest('[aria-disabled="true"]'));
    if (el.matches(textControls) && !nameOf(el)) {
      push('unlabeled', { what: el.tagName === 'INPUT' ? `入力(${el.type || 'text'})` : el.tagName === 'SELECT' ? '選ぶ欄' : el.tagName === 'TEXTAREA' ? '文の欄' : `入力(${el.getAttribute('role')})`, where: whereOf(el), hint: clip(el.getAttribute('placeholder') ?? el.getAttribute('name') ?? '', limits.maxText) });
    } else if ((el.tagName === 'BUTTON' || el.getAttribute('role') === 'button' || (el.tagName === 'INPUT' && ['button', 'image'].includes(el.type))) && !nameOf(el)) {
      push('unnamedButtons', { what: 'ボタン', where: whereOf(el), hint: '' });
    } else if (el.tagName === 'IMG' && !el.hasAttribute('alt') && !el.getAttribute('aria-label') && !labelledBy(el) && el.getAttribute('role') !== 'presentation') {
      push('missingAlt', { what: '画像', where: whereOf(el), hint: clip((el.getAttribute('src') ?? '').split('/').pop(), limits.maxText) });
    }
    // 字と地の差。じかに文字を持つ要素だけ。押せない部品(disabled)は基準の外
    const own = [...el.childNodes].filter((node) => node.nodeType === 3).map((node) => node.textContent).join('').trim();
    if (!own || disabled) continue;
    const style = getComputedStyle(el);
    const fg = colorOf(style.color);
    const bg = backgroundOf(el);
    if (!fg || !bg) {
      unknown += 1;
      continue;
    }
    checked += 1;
    const size = parseFloat(style.fontSize) || 16;
    const weight = Number(style.fontWeight) || (style.fontWeight === 'bold' ? 700 : 400);
    const large = size >= 24 || (size >= 18.66 && weight >= 700);
    const ratio = contrastRatio(fg, bg);
    const required = large ? minimum.large : minimum.normal;
    if (ratio + 1e-9 < required) {
      counts.contrast += 1;
      if (lowest === null || ratio < lowest.ratio) lowest = { ratio: Math.floor(ratio * 100) / 100, required };
      if (contrast.length < limits.maxItems) {
        contrast.push({ text: clip(own, limits.maxText), where: whereOf(el), ratio: Math.floor(ratio * 100) / 100, required, large, color: hexOf(fg[3] < 1 ? blendColor(fg, bg) : fg), background: hexOf(bg) });
      }
    }
  }
  return {
    scanned: Math.min(scanned, limits.maxElements),
    truncated,
    unlabeled: { count: counts.unlabeled, items: kinds.unlabeled },
    unnamedButtons: { count: counts.unnamedButtons, items: kinds.unnamedButtons },
    missingAlt: { count: counts.missingAlt, items: kinds.missingAlt },
    contrast: { checked, unknown, count: counts.contrast, lowest, items: contrast },
  };
}

// frame.evaluate に渡す文。上の関数を同じ所に置き、auditPage を呼ぶ
export function auditScript(limits = AUDIT_LIMITS, minimum = CONTRAST_MIN) {
  const helpers = [parseColor, blendColor, luminance, contrastRatio, hexOf].map(String).join('\n');
  return `(() => {\n${helpers}\nreturn (${auditPage})(${JSON.stringify(limits)}, ${JSON.stringify(minimum)});\n})()`;
}

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const cleanText = (value, max) => String(value ?? '').slice(0, max);
const cleanCount = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : 0);

// 試作品の中で作った値なので、決まった形と長さに写す(試作品のコードが値を変えても、report の形は崩れない)
export function cleanAudit(raw, limits = AUDIT_LIMITS) {
  if (!isPlainObject(raw)) return null;
  const items = (list, keys) => (Array.isArray(list) ? list.slice(0, limits.maxItems) : []).filter(isPlainObject).map((item) => Object.fromEntries(keys.map((key) => [key, cleanText(item[key], key === 'where' ? limits.maxWhere : limits.maxText + 1)])));
  const kind = (value) => ({ count: cleanCount(value?.count), items: items(value?.items, ['what', 'where', 'hint']) });
  const contrast = isPlainObject(raw.contrast) ? raw.contrast : {};
  const number = (value) => (Number.isFinite(value) ? Math.round(value * 100) / 100 : null);
  return {
    scanned: cleanCount(raw.scanned),
    truncated: raw.truncated === true,
    unlabeled: kind(raw.unlabeled),
    unnamedButtons: kind(raw.unnamedButtons),
    missingAlt: kind(raw.missingAlt),
    contrast: {
      checked: cleanCount(contrast.checked),
      unknown: cleanCount(contrast.unknown),
      count: cleanCount(contrast.count),
      lowest: isPlainObject(contrast.lowest) && Number.isFinite(contrast.lowest.ratio) ? { ratio: number(contrast.lowest.ratio), required: number(contrast.lowest.required) } : null,
      items: (Array.isArray(contrast.items) ? contrast.items.slice(0, limits.maxItems) : []).filter(isPlainObject).map((item) => ({
        text: cleanText(item.text, limits.maxText + 1),
        where: cleanText(item.where, limits.maxWhere),
        ratio: number(item.ratio),
        required: number(item.required),
        large: item.large === true,
        color: /^#[0-9a-f]{6}$/.test(item.color) ? item.color : null,
        background: /^#[0-9a-f]{6}$/.test(item.background) ? item.background : null,
      })),
    },
  };
}
