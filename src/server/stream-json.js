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
};

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

export function describeTool(appDirs, name, input = {}) {
  const verb = TOOL_VERBS[name] ?? name;
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

// 返すのは { items, init, result }。init と result は、実行の要約に使う。
export function readMessage(message, appDirs) {
  const out = { items: [], init: null, result: null };
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
      if (part?.type === 'tool_use') out.items.push({ kind: 'tool', text: describeTool(appDirs, part.name, part.input) });
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
