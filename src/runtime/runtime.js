// Studio が試作品に配る runtime。試作品の中で起きたエラーを、親の Studio 画面に知らせる。
// 親画面は、自分が読み込ませた直後にだけ MessagePort を 1 つ渡す(ADR-0001)。
(function () {
  'use strict';
  var MAX_QUEUE = 50;
  var MAX_TEXT = 4000;
  var port = null;
  var queue = [];

  function text(value) {
    try {
      return String(value).slice(0, MAX_TEXT);
    } catch (e) {
      return '(文字にできない値)';
    }
  }

  function send(message) {
    if (port) {
      port.postMessage(message);
    } else if (queue.length < MAX_QUEUE) {
      queue.push(message);
    }
  }

  window.addEventListener('message', function (event) {
    if (port || event.source !== window.parent) return;
    var data = event.data;
    if (!data || data.type !== 'studio:connect' || !event.ports || !event.ports[0]) return;
    port = event.ports[0];
    queue.splice(0).forEach(function (message) {
      port.postMessage(message);
    });
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
    send({
      type: 'runtime-error',
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
