// Studio が試作品に配る runtime。試作品の中で起きたエラーを、親の Studio 画面に知らせる。
// プロダクト内 AI は window.studio.ai から呼ぶ。返事は親画面が Studio のサーバーから受け取って返す。
// 親画面は、自分が読み込ませた直後にだけ MessagePort を 1 つ渡す(ADR-0001)。
(function () {
  'use strict';
  var MAX_QUEUE = 50;
  var MAX_TEXT = 4000;
  // Studio のサーバーは、1 ターンが期限(240 秒。src/server/product-ai/limits.js の TURN_LIMITS)を過ぎたら、決まった文で返す。
  // それより少し長く待つ(期限の後に返る決まった文を、先に「返事がありません」で捨てないため)
  var AI_TIMEOUT_MS = 270000;
  var port = null;
  var queue = [];
  var pending = {};
  var nextId = 1;

  function text(value) {
    try {
      return String(value).slice(0, MAX_TEXT);
    } catch (e) {
      return '(文字にできない値)';
    }
  }

  // 送れたか、つながるまで預けられたら true
  function send(message) {
    if (port) {
      port.postMessage(message);
      return true;
    }
    if (queue.length >= MAX_QUEUE) return false;
    queue.push(message);
    return true;
  }

  window.addEventListener('message', function (event) {
    if (port || event.source !== window.parent) return;
    var data = event.data;
    if (!data || data.type !== 'studio:connect' || !event.ports || !event.ports[0]) return;
    port = event.ports[0];
    port.onmessage = onReply;
    queue.splice(0).forEach(function (message) {
      try {
        port.postMessage(message);
      } catch (e) {
        // 送れない値は捨て、残りは送る
      }
    });
    // runtime が動いてつながったことを知らせる。観察器は、これを読み込みの終わりとして数える
    port.postMessage({ type: 'studio:ready' });
  });

  var listeners = [];

  function onReply(event) {
    var data = event.data;
    // Studio の画面で接続を切り替えたときなど、試作品が頼んでいない変化の知らせ
    if (data && data.type === 'ai-session' && data.session) {
      listeners.slice().forEach(function (listener) {
        try {
          listener(data.session);
        } catch (e) {
          setTimeout(function () {
            throw e;
          });
        }
      });
      return;
    }
    if (!data || data.type !== 'ai-response' || !Object.prototype.hasOwnProperty.call(pending, data.id)) return;
    var request = pending[data.id];
    delete pending[data.id];
    clearTimeout(request.timer);
    if (data.ok) {
      request.resolve(data.session);
    } else {
      var error = new Error(data.error && data.error.message ? data.error.message : 'AI への要求に失敗しました');
      error.code = data.error && data.error.code ? data.error.code : 'unknown';
      request.reject(error);
    }
  }

  function requestAi(op, fields) {
    return new Promise(function (resolve, reject) {
      var id = nextId++;
      var timer = setTimeout(function () {
        delete pending[id];
        var error = new Error('Studio から返事がありません。Studio の画面で「開き直す」を押してください');
        error.code = 'timeout';
        reject(error);
      }, AI_TIMEOUT_MS);
      pending[id] = { resolve: resolve, reject: reject, timer: timer };
      var message = { type: 'ai-request', id: id, op: op };
      for (var key in fields) message[key] = fields[key];
      var error;
      try {
        if (!send(message)) {
          error = new Error('Studio とまだつながっていません。少し待ってから試してください');
          error.code = 'not-connected';
        }
      } catch (e) {
        error = new Error('送れない値が含まれています: ' + text(e && e.message ? e.message : e));
        error.code = 'invalid';
      }
      if (error) {
        delete pending[id];
        clearTimeout(timer);
        reject(error);
      }
    });
  }

  // 試作品から使う口。どれも、会話と状態の全体(session)を返す Promise を返す。
  //   session():         今の会話と状態
  //   send(text):        利用者の発言を送り、AI の応答を受け取る
  //   correct(changes):  AI が理解した状態を本人が直す。例: correct({ area: 'もみじ台' })。null は「未定」
  //   onChange(listener): Studio の画面で接続が切り替わったとき、新しい session を受け取る。戻り値で受け取りをやめる
  window.studio = Object.freeze({
    ai: Object.freeze({
      onChange: function (listener) {
        if (typeof listener !== 'function') throw new TypeError('onChange には関数を渡してください');
        listeners.push(listener);
        return function () {
          var at = listeners.indexOf(listener);
          if (at >= 0) listeners.splice(at, 1);
        };
      },
      session: function () {
        return requestAi('session', {});
      },
      send: function (text) {
        return requestAi('send', { text: text === undefined || text === null ? '' : String(text) });
      },
      correct: function (changes) {
        return requestAi('correct', { changes: changes });
      },
    }),
  });

  window.addEventListener('error', function (event) {
    send({
      type: 'runtime-error',
      message: text(event.message || 'エラーが起きました'),
      stack: event.error && event.error.stack ? text(event.error.stack) : '',
    });
  });

  window.addEventListener('unhandledrejection', function (event) {
    var reason = event.reason;
    // Studio の画面は実行時エラーとして出す。観察器は source で、処理されない reject と分ける
    send({
      type: 'runtime-error',
      source: 'unhandledrejection',
      message: text(reason && reason.message ? reason.message : reason),
      stack: reason && reason.stack ? text(reason.stack) : '',
    });
  });

  var originalError = console.error;
  console.error = function () {
    var parts = [];
    for (var i = 0; i < arguments.length; i++) {
      var value = arguments[i];
      parts.push(value && value.stack ? value.stack : value);
    }
    send({ type: 'console-error', message: text(parts.join(' ')), stack: '' });
    return originalError.apply(console, arguments);
  };
})();
