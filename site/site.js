// LP の動き。外から何も読み込まない。ライブラリも使わない。
// 1. 言葉(日本語と英語)と見た目(ダークとライト)を、描く前に <html> に付ける
// 2. 分解のアニメ: スクロールの位置で層を離し、今の層の番号と説明を出す。
//    prefers-reduced-motion のときと、背の低い画面(横にしたスマホなど)では <html> に .motion を付けず、
//    分けた絵を止まったまま並べる(site.css)
(() => {
  const root = document.documentElement;
  const LANG_KEY = 'prototype-studio-site-lang';
  const THEME_KEY = 'prototype-studio-site-theme';
  const TITLES = {
    ja: 'Prototype Studio: 思いつきを AI プロダクトにすると、どんな作りになるか。動かして測り、人が承認してから作る。',
    en: 'Prototype Studio: See how your idea works as an AI product, test it, and approve the architecture before you build.',
  };
  // 言葉で切り替える属性。HTML には日本語を書き、英語は data-en-<属性> に書く
  const ATTRS = ['alt', 'aria-label', 'title'];
  // 層を離し終える所(スクロールの割合)。その後を 7 つの層で等しく分ける
  const SPLIT = 0.1;
  // これより背の低い画面では、層と説明が 1 画面に収まらないので動かさない
  const MIN_HEIGHT = 600;

  // localStorage が使えないブラウザ(file:// や設定で止めたとき)でも、切り替えだけは動かす
  function stored(key) {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  }
  function store(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch {
      // 残せなくても、今のページでは切り替わる
    }
  }

  const asked = new URLSearchParams(location.search).get('lang');
  root.lang = asked === 'en' || asked === 'ja' ? asked : stored(LANG_KEY) === 'en' ? 'en' : 'ja';
  const theme = stored(THEME_KEY);
  if (theme === 'dark' || theme === 'light') root.dataset.theme = theme;

  function applyLang(lang) {
    root.lang = lang;
    document.title = TITLES[lang];
    for (const attr of ATTRS) {
      for (const el of document.querySelectorAll(`[data-en-${attr}]`)) {
        if (!el.hasAttribute(`data-ja-${attr}`)) el.setAttribute(`data-ja-${attr}`, el.getAttribute(attr) ?? '');
        el.setAttribute(attr, el.getAttribute(`data-${lang}-${attr}`));
      }
    }
    const toggle = document.getElementById('lang-toggle');
    toggle.textContent = lang === 'en' ? '日本語' : 'English';
    toggle.lang = lang === 'en' ? 'ja' : 'en';
  }

  function currentTheme() {
    if (root.dataset.theme) return root.dataset.theme;
    return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  const clamp = (value) => Math.min(1, Math.max(0, value));

  function setupLayers() {
    const track = document.querySelector('.layers-track');
    const stage = document.querySelector('.layers-stage');
    const stack = document.querySelector('.layers-stack');
    const layers = [...document.querySelectorAll('.layer')];
    const now = document.querySelector('.layer-now');
    const text = document.querySelector('.layer-text');
    const reduce = matchMedia('(prefers-reduced-motion: reduce)');
    const tall = matchMedia(`(min-height: ${MIN_HEIGHT}px)`);
    let active = -1;
    let frame = 0;

    function show(index) {
      if (index === active) return;
      active = index;
      layers.forEach((layer, i) => layer.classList.toggle('is-active', i === index));
      now.textContent = String(index + 1).padStart(2, '0');
      // 今の層の名前と 2 行の説明は、その層の figcaption を写して出す(日本語と英語の両方を写す)
      text.replaceChildren(...layers[index].querySelector('figcaption').cloneNode(true).childNodes);
      stage.dataset.active = String(index + 1);
      // ガードレール(5 番目)に届いたら、止めた層と例の会話の「止める」を光らせる
      stage.classList.toggle('is-stopped', index >= 4);
    }

    function update() {
      frame = 0;
      const range = track.offsetHeight - stage.offsetHeight;
      const progress = range > 0 ? clamp(-track.getBoundingClientRect().top / range) : 0;
      const sep = clamp(progress / SPLIT);
      stack.style.setProperty('--sep', sep.toFixed(3));
      stage.classList.toggle('is-split', sep > 0.5);
      show(progress < SPLIT ? 0 : Math.min(layers.length - 1, Math.floor(((progress - SPLIT) / (1 - SPLIT)) * layers.length)));
    }

    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };

    function setMotion(on) {
      root.classList.toggle('motion', on);
      if (on) {
        addEventListener('scroll', onScroll, { passive: true });
        addEventListener('resize', onScroll);
        active = -1;
        update();
      } else {
        removeEventListener('scroll', onScroll);
        removeEventListener('resize', onScroll);
        cancelAnimationFrame(frame);
        frame = 0;
        stack.style.removeProperty('--sep');
        stage.classList.remove('is-split', 'is-stopped');
        layers.forEach((layer) => layer.classList.remove('is-active'));
      }
    }

    const follow = () => setMotion(!reduce.matches && tall.matches);
    follow();
    reduce.addEventListener('change', follow);
    tall.addEventListener('change', follow);
  }

  document.addEventListener('DOMContentLoaded', () => {
    applyLang(root.lang);
    document.getElementById('lang-toggle').addEventListener('click', () => {
      const lang = root.lang === 'en' ? 'ja' : 'en';
      applyLang(lang);
      store(LANG_KEY, lang);
    });
    document.getElementById('theme-toggle').addEventListener('click', () => {
      const next = currentTheme() === 'dark' ? 'light' : 'dark';
      root.dataset.theme = next;
      store(THEME_KEY, next);
    });
    setupLayers();
  });
})();
