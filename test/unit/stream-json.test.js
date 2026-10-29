import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { readMessage, showPath, summarizeTool } from '../../src/server/stream-json.js';

const APP = path.resolve('/home/u/PrototypeStudio/projects/demo/app');
const REAL = path.resolve('/private/home/u/PrototypeStudio/projects/demo/app');

test('パスは app/ からの形で見せ、外は外とわかる形にする', () => {
  assert.equal(showPath(APP, path.join(APP, 'src', 'App.jsx')), 'app/src/App.jsx');
  assert.equal(showPath(APP, 'main.jsx'), 'app/main.jsx');
  assert.equal(showPath([APP, REAL], path.join(REAL, 'App.jsx')), 'app/App.jsx');
  assert.equal(showPath(APP, '../secret.txt'), `${path.resolve(APP, '..', 'secret.txt')}(app/ の外)`);
  assert.equal(showPath(APP, path.join(APP, '..', 'app-other', 'x.js')).endsWith('(app/ の外)'), true);
});

test('stream-json の行を、作る会話の項目に直す', () => {
  const init = readMessage({ type: 'system', subtype: 'init', apiKeySource: 'none', permissionMode: 'dontAsk', tools: ['Read'] }, APP);
  assert.equal(init.init.apiKeySource, 'none');

  const assistant = readMessage(
    {
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: '  変えます  ' },
          { type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: path.join(APP, 'App.jsx') } },
          { type: 'tool_use', id: 't2', name: 'Grep', input: { pattern: 'h1' } },
        ],
      },
    },
    APP,
  );
  assert.deepEqual(assistant.items, [
    { kind: 'assistant', text: '変えます' },
    { kind: 'tool', text: '書き換える: app/App.jsx', summary: '試作品のファイルを書き換えました' },
    { kind: 'tool', text: '中身を探す: h1', summary: '試作品のファイルの中を探しました' },
  ]);
  assert.deepEqual(assistant.toolUses, ['Edit', 'Grep']);

  const toolError = readMessage(
    { type: 'user', message: { content: [{ type: 'tool_result', is_error: true, content: [{ type: 'text', text: 'denied' }] }, { type: 'tool_result', content: 'ok' }] } },
    APP,
  );
  assert.deepEqual(toolError.items, [{ kind: 'tool-error', text: '直す AI の操作が、うまくいきませんでした。', detail: 'denied' }]);

  const result = readMessage(
    {
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: '終わり',
      permission_denials: [{ tool_name: 'Write', tool_input: { file_path: '/etc/hosts' } }],
    },
    APP,
  );
  assert.equal(result.result.ok, true);
  assert.deepEqual(result.result.denials, [`書く: ${path.resolve('/etc/hosts')}(app/ の外)`]);

  assert.equal(readMessage({ type: 'result', subtype: 'error_max_turns', is_error: true }, APP).result.ok, false);
  assert.equal(readMessage({ type: 'result', subtype: 'success', is_error: true }, APP).result.ok, false);
});

test('知らない形の行は無視する', () => {
  for (const message of [null, 'x', { type: 'stream_event' }, { type: 'assistant', message: { content: 'x' } }]) {
    assert.deepEqual(readMessage(message, APP), { items: [], init: null, result: null, toolUses: [] });
  }
});

test('観察の道具の呼び出しは、作る会話に短く出し、名前を回数の記録に渡す', () => {
  const read = readMessage(
    {
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', id: 't1', name: 'mcp__observe__open', input: {} },
          { type: 'tool_use', id: 't2', name: 'mcp__observe__click', input: { target: { role: 'button', name: '送る' } } },
          { type: 'tool_use', id: 't3', name: 'mcp__observe__set_viewport', input: { viewport: 'mobile' } },
        ],
      },
    },
    APP,
  );
  assert.deepEqual(read.items, [
    { kind: 'tool', text: '観察: 開く', summary: '試作品の画面を開いて確かめました' },
    { kind: 'tool', text: '観察: 押す(role=button name=送る)', summary: '試作品の画面を操作しました' },
    { kind: 'tool', text: '観察: 画面幅を変える(mobile)', summary: '画面の幅を変えて確かめました' },
  ]);
  assert.deepEqual(read.toolUses, ['mcp__observe__open', 'mcp__observe__click', 'mcp__observe__set_viewport']);
});

test('操作の短い文には、ファイルの名前も道具の名前も入れない', () => {
  assert.equal(summarizeTool(APP, 'Read', { file_path: path.join(APP, 'ai.json') }), 'AI の設定を読みました');
  assert.equal(summarizeTool([APP, REAL], 'Edit', { file_path: path.join(REAL, 'ai.json') }), 'AI の設定を書き換えました');
  assert.equal(summarizeTool(APP, 'Write', { file_path: path.join(APP, 'scenarios', 'x.json') }), '試作品のファイルを書きました');
  // app/ の外は断られるので、したとは言わない
  assert.equal(summarizeTool(APP, 'Write', { file_path: '/etc/hosts' }), '試作品のフォルダーの外のファイルに書こうとしました');
  assert.equal(summarizeTool(APP, 'Edit', { file_path: '/etc/hosts' }), '試作品のフォルダーの外のファイルを書き換えようとしました');
  assert.equal(summarizeTool(APP, 'Read', { file_path: '/etc/hosts' }), '試作品のフォルダーの外のファイルを読もうとしました');
  assert.equal(summarizeTool(APP, 'Grep', { path: '/etc' }), '試作品のフォルダーの外を見ようとしました');
  assert.equal(summarizeTool(APP, 'Read', {}), '試作品のファイルを読みました');
  for (const name of ['Bash', 'mcp__other__tool', undefined, '__proto__']) {
    assert.equal(summarizeTool(APP, name, { file_path: path.join(APP, 'App.jsx') }), '作業を進めました');
  }
});
