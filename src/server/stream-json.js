import path from 'node:path';

// Claude Code の stream-json の 1 行を、作る会話に出す項目に直す。
// 文はすべて画面で文字として出す(HTML にしない)。長さは切る。
const MAX_TEXT = 4000;

const TOOL_VERBS = {
  Read: '読む',
  Edit: '書き換える',
  MultiEdit: '書き換える',
  Write: '書く',
  Glob: 'ファイルを探す',
  Grep: '中身を探す',
  // 観察の道具(src/server/observe-mcp.js)。app/ は書き換えない
  mcp__observe__open: '観察: 開く',
  mcp__observe__read_page: '観察: ページを読む',
  mcp__observe__inspect: '観察: 要素を調べる',
  mcp__observe__click: '観察: 押す',
  mcp__observe__type: '観察: 入力する',
  mcp__observe__scroll: '観察: スクロールする',
  mcp__observe__set_viewport: '観察: 画面幅を変える',
  mcp__observe__screenshot: '観察: スクリーンショットを撮る',
  mcp__observe__run_scenarios: '観察: シナリオを回す',
};
const MAX_TOOL_NAME = 200;

function clip(text) {
  const value = String(text ?? '');
  return value.length > MAX_TEXT ? `${value.slice(0, MAX_TEXT)}…` : value;
}

// app/ の中なら app/ からのパスで、外なら外とわかる形で見せる。
// appDirs には app/ の見かけのパスと実パスを渡す(macOS の /var と /private/var など)。
export function showPath(appDirs, file) {
  if (typeof file !== 'string' || file === '') return '';
  const roots = [appDirs].flat();
  const absolute = path.resolve(roots[0], file);
  for (const root of roots) {
    const relative = path.relative(root, absolute);
    if (relative === '') return 'app/';
    if (!relative.startsWith('..') && !path.isAbsolute(relative)) return `app/${relative.split(path.sep).join('/')}`;
  }
  return `${absolute}(app/ の外)`;
}

// 観察の道具の対象(役割と名前、ラベル、文字、領域)と、画面幅を短く見せる
function observeDetail(input) {
  const target = input.target && typeof input.target === 'object' ? input.target : null;
  const parts = [];
  if (target) {
    for (const key of ['role', 'name', 'label', 'text', 'region']) {
      if (typeof target[key] === 'string') parts.push(`${key}=${target[key].slice(0, 80)}`);
    }
  }
  if (typeof input.viewport === 'string') parts.push(input.viewport.slice(0, 20));
  if (typeof input.to === 'string') parts.push(input.to.slice(0, 20));
  return parts.join(' ');
}

export function describeTool(appDirs, name, input = {}) {
  const verb = (Object.hasOwn(TOOL_VERBS, name) ? TOOL_VERBS[name] : null) ?? String(name ?? '').slice(0, MAX_TOOL_NAME);
  input = input && typeof input === 'object' ? input : {};
  if (typeof name === 'string' && name.startsWith('mcp__observe__')) {
    const detail = observeDetail(input);
    return detail ? `${verb}(${detail})` : verb;
  }
  const target = input.file_path ?? input.path ?? input.notebook_path;
  if (target) return `${verb}: ${showPath(appDirs, target)}`;
  if (input.pattern) return `${verb}: ${clip(input.pattern).slice(0, 200)}`;
  return verb;
}

function toolResultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((part) => part && part.type === 'text')
      .map((part) => part.text)
      .join('\n');
  }
  return '';
}

// 返すのは { items, init, result, toolUses }。init と result は実行の要約に、toolUses(呼んだ道具の名前)は回数の記録に使う。
export function readMessage(message, appDirs) {
  const out = { items: [], init: null, result: null, toolUses: [] };
  if (!message || typeof message !== 'object') return out;

  if (message.type === 'system' && message.subtype === 'init') {
    out.init = {
      model: typeof message.model === 'string' ? message.model : null,
      permissionMode: typeof message.permissionMode === 'string' ? message.permissionMode : null,
      apiKeySource: typeof message.apiKeySource === 'string' ? message.apiKeySource : null,
      tools: Array.isArray(message.tools) ? message.tools.filter((t) => typeof t === 'string').slice(0, 50) : [],
    };
    return out;
  }

  const content = message.message?.content;
  if (message.type === 'assistant' && Array.isArray(content)) {
    for (const part of content) {
      if (part?.type === 'text' && part.text?.trim()) out.items.push({ kind: 'assistant', text: clip(part.text.trim()) });
      if (part?.type === 'tool_use') {
        out.items.push({ kind: 'tool', text: describeTool(appDirs, part.name, part.input) });
        if (typeof part.name === 'string') out.toolUses.push(part.name.slice(0, MAX_TOOL_NAME));
      }
    }
    return out;
  }

  if (message.type === 'user' && Array.isArray(content)) {
    for (const part of content) {
      if (part?.type === 'tool_result' && part.is_error) {
        out.items.push({ kind: 'tool-error', text: clip(toolResultText(part.content) || 'ツールが失敗しました') });
      }
    }
    return out;
  }

  if (message.type === 'result') {
    const denials = Array.isArray(message.permission_denials) ? message.permission_denials : [];
    out.result = {
      ok: message.is_error !== true && message.subtype === 'success',
      subtype: typeof message.subtype === 'string' ? message.subtype : null,
      text: clip(message.result),
      numTurns: Number.isInteger(message.num_turns) ? message.num_turns : null,
      costUsd: typeof message.total_cost_usd === 'number' ? message.total_cost_usd : null,
      denials: denials.slice(0, 20).map((denial) => describeTool(appDirs, denial?.tool_name, denial?.tool_input ?? {})),
    };
  }
  return out;
}
