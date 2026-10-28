// 観察用の親ページ。観察器(src/observer/)が、ヘッドレスの Chromium で開く。
// 試作品を Studio の画面と同じ sandbox の iframe に入れ、MessagePort で届く知らせを Node に渡す。
// Studio の API は呼ばず、トークンも持たない(CSP の connect-src も 'none')。
// Node へは、Playwright の exposeBinding が入れる 2 つの関数だけで渡す:
//   studioObserveEvent(event): 読み込み、エラー、console.error
//   studioObserveAi(request):  試作品からの AI の要求。返事({ ok, session | error })を返す
(function () {
  'use strict';
  var MAX_TEXT = 4000;
  var frame = null;
  var ready = false;

  function text(value) {
    try {
      return String(value).slice(0, MAX_TEXT);
    } catch (e) {
      return '(文字にできない値)';
    }
  }

  function notify(event) {
    try {
      Promise.resolve(window.studioObserveEvent(event)).catch(function () {});
    } catch (e) {
      // 観察器の外で開かれたときは、知らせる先がない
    }
  }

  // 試作品から届いた値は、決まった項目だけを写して Node に渡す
  function relayAi(port, data) {
    var request = { id: data.id, op: data.op };
    if (data.op === 'send') request.text = data.text;
    if (data.op === 'correct') request.changes = data.changes;
    var reply = function (result) {
      var message = { type: 'ai-response', id: data.id, ok: result.ok === true };
      if (message.ok) message.session = result.session;
      else message.error = result.error || { code: 'internal', message: 'AI への要求に失敗しました' };
      port.postMessage(message);
    };
    var failed = function () {
      reply({ ok: false, error: { code: 'internal', message: 'AI への要求に失敗しました' } });
    };
    try {
      Promise.resolve(window.studioObserveAi(request)).then(reply, failed);
    } catch (e) {
      failed();
    }
  }

  function connect(iframe) {
    var channel = new MessageChannel();
    var port = channel.port1;
    port.onmessage = function (event) {
      if (iframe !== frame) return;
      var data = event.data;
      if (!data || typeof data !== 'object') return;
      if (data.type === 'ai-request') {
        relayAi(port, data);
        return;
      }
      if (data.type === 'studio:ready') {
        if (!ready) notify({ type: 'load' });
        ready = true;
        return;
      }
      if (data.type !== 'runtime-error' && data.type !== 'console-error') return;
      // runtime は、処理されない reject を source で区別する
      var type = data.type === 'runtime-error' && data.source === 'unhandledrejection' ? 'unhandled-rejection' : data.type;
      notify({ type: type, message: text(data.message), stack: typeof data.stack === 'string' ? text(data.stack) : '' });
    };
    // opaque origin の相手には '*' しか指定できない。渡すのは port だけ
    iframe.contentWindow.postMessage({ type: 'studio:connect' }, '*', [channel.port2]);
  }

  // 試作品は sandbox の iframe(allow-same-origin なし)で、プレビューの配信から開く(ADR-0001 の層 2)
  function open(url) {
    var iframe = document.createElement('iframe');
    var loads = 0;
    iframe.title = '試作品';
    iframe.setAttribute('sandbox', 'allow-scripts allow-forms');
    iframe.referrerPolicy = 'no-referrer';
    iframe.style.border = '0';
    iframe.style.display = 'block';
    iframe.style.width = '100vw';
    iframe.style.height = '100vh';
    iframe.addEventListener('load', function () {
      if (iframe !== frame) return;
      loads += 1;
      if (loads === 1) {
        // 読み込みの終わりは、runtime から studio:ready が届いたときに知らせる。
        // 404 のページや、試作品が移った先のページには runtime がない
        notify({ type: 'frame-load' });
        connect(iframe);
      } else {
        // 試作品が自分で別の URL へ移動した。port は渡さない
        notify({ type: 'navigated' });
      }
    });
    // src を先に決めてから入れる。about:blank の load を起こさないため
    iframe.src = url;
    frame = iframe;
    document.documentElement.style.height = '100%';
    document.body.style.margin = '0';
    document.body.style.overflow = 'hidden';
    document.body.replaceChildren(iframe);
  }

  window.studioObserveHost = Object.freeze({ open: open });
})();
