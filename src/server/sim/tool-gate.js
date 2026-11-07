import path from 'node:path';
import { appPath } from '../manifest.js';
import { findPersonalData, redact } from '../redact.js';
import { Problems, SIM_LIMITS, isPlainObject, readAppJson } from './check.js';

// ツールの口(docs/design/agent-simulation.md の 3.5)。試作品のツールを、決まった手順で動かす Studio のコード。
// 形の検査 → ツールの守り → 実行 → 記録の順に進む。MCP サーバー、モックの模擬のエージェント、ツールだけの場面の
// どこから呼ばれても、この callTool を通る(S5)。
// callTool はファイルを読み書きせず、外へ通信しない。データと記録の店は値として受け取り、新しい記録の店を値で返す。
// ファイルを読むのは loadToolData(app/ の中の .json だけ)、書くのは呼ぶ側だけ(S21)。

// 引数の JSON の大きさの上限。inputSchema に maxLength がなくても、記録の店が大きくなりすぎないようにする
export const GATE_LIMITS = { maxArgsChars: 20_000 };

const FAULT_MESSAGE = 'ツールが一時的に失敗しました。少し待ってから、もう一度呼んでください';
// 委任のツールが通ったときに、任せた AI に返す文。サブの結果は、この返事の後に会話の進め方が渡す(2.9)
export const DELEGATE_NOTE = 'サブに任せました。結果は、この返事の後に渡します。この返事では、確かめていることだけを短く書いてください。';
const looksLikeKinds = { phone: '電話番号', email: 'メールアドレス', address: '住所', personName: '氏名' };

const sleepFor = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const clone = (value) => (value === undefined ? undefined : structuredClone(value));
const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);
// 引数、データ、記録の店の項目は、自分の項目だけを見る(constructor などの継ぎの項目を値と取り違えないため)
const has = (object, key) => isPlainObject(object) && Object.hasOwn(object, key);
const own = (object, key) => (has(object, key) ? object[key] : undefined);
// 記録に残す引数の写し。JSON にできないもの(形の検査で断った引数)は、残さない
function jsonCopy(value) {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? null : JSON.parse(serialized);
  } catch {
    return null;
  }
}

// tools.json のツールが読むデータを、JSON として読む。app/ の中の .json だけ。.js などのコードは読まない(S21)。
// 返す data は { 'data/jobs.json': 値 }。callTool に渡す。検査(parseTools)の後にファイルが変わっていても、形を確かめ直す
export async function loadToolData(appDir, toolset) {
  const data = {};
  const problems = new Problems('app/tools.json');
  const uses = new Map();
  for (const tool of toolset?.tools ?? []) {
    if (typeof tool.do?.data !== 'string') continue;
    const array = tool.do.op === 'search' || tool.do.op === 'get';
    uses.set(tool.do.data, (uses.get(tool.do.data) ?? false) || array);
  }
  for (const [file, array] of [...uses].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const relative = appPath(problems, file, file);
    if (relative === undefined) continue;
    if (path.posix.extname(relative) !== '.json') {
      problems.add(relative, '.json のファイルだけを読みます(.js などのコードは読みません)');
      continue;
    }
    const { value, error } = await readAppJson(appDir, relative, SIM_LIMITS.maxDataBytes);
    if (error) problems.add(relative, error);
    else if (array && (!Array.isArray(value) || value.some((item) => !isPlainObject(item)))) {
      problems.add(relative, 'search と get のデータは、オブジェクトの配列([{ … }, …])にしてください');
    } else data[file] = value;
  }
  return { data, errors: problems.list };
}

// 引数を inputSchema(決まった部分だけの JSON Schema。2.7)で確かめる。合わなければ理由の文を返す
function argsProblem(schema, value, where) {
  const at = where || '引数';
  switch (schema.type) {
    case 'object': {
      if (!isPlainObject(value)) return `${at} はオブジェクトにしてください`;
      const properties = schema.properties ?? {};
      for (const key of Object.keys(value)) {
        if (!Object.hasOwn(properties, key)) return `「${where ? `${where}.${key}` : key}」は知らない引数です`;
      }
      for (const key of schema.required ?? []) {
        if (own(value, key) === undefined) return `「${where ? `${where}.${key}` : key}」がありません`;
      }
      for (const [key, child] of Object.entries(properties)) {
        if (own(value, key) === undefined) continue;
        const problem = argsProblem(child, value[key], where ? `${where}.${key}` : key);
        if (problem) return problem;
      }
      return null;
    }
    case 'array': {
      if (!Array.isArray(value)) return `「${at}」は配列にしてください`;
      if (!schema.items) return null;
      for (const [i, item] of value.entries()) {
        const problem = argsProblem(schema.items, item, `${at}[${i}]`);
        if (problem) return problem;
      }
      return null;
    }
    case 'string':
      if (typeof value !== 'string') return `「${at}」は文字列にしてください`;
      if (schema.maxLength !== undefined && value.length > schema.maxLength) return `「${at}」は ${schema.maxLength} 文字までです`;
      break;
    case 'number':
    case 'integer':
      if (typeof value !== 'number' || !Number.isFinite(value)) return `「${at}」は数にしてください`;
      if (schema.type === 'integer' && !Number.isInteger(value)) return `「${at}」は整数にしてください`;
      if (schema.minimum !== undefined && value < schema.minimum) return `「${at}」は ${schema.minimum} 以上にしてください`;
      if (schema.maximum !== undefined && value > schema.maximum) return `「${at}」は ${schema.maximum} 以下にしてください`;
      break;
    case 'boolean':
      if (typeof value !== 'boolean') return `「${at}」は true か false にしてください`;
      break;
    default:
      return `「${at}」の形が分かりません`;
  }
  if (schema.enum && !schema.enum.includes(value)) return `「${at}」は ${schema.enum.join('、')} のどれかにしてください`;
  return null;
}

// 引数の中の文字列と数を、全部並べる(deny で見るため)
function textsIn(value) {
  if (typeof value === 'string') return [value];
  if (typeof value === 'number') return [String(value)];
  if (Array.isArray(value)) return value.flatMap(textsIn);
  if (isPlainObject(value)) return Object.values(value).flatMap(textsIn);
  return [];
}

const normalize = (value) => value.normalize('NFKC').toLowerCase();

// 全角の数字や記号(０９０－…、＠)も見分けるよう、NFKC にそろえてから見る。
// 合った条件(「住所らしい形」「言葉「住所」」など)を返す。記録の理由に残し、止めすぎたときに分かるようにする
function denied(rule, args) {
  const found = textsIn(own(args, rule.arg)).map(normalize);
  if (found.length === 0) return null;
  const kinds = new Set(found.flatMap((value) => findPersonalData(value).map((item) => item.kind)));
  const kind = (rule.looksLike ?? []).map((name) => looksLikeKinds[name]).find((label) => kinds.has(label));
  if (kind) return `${kind}らしい形`;
  const word = (rule.containsAny ?? []).find((item) => found.some((value) => value.includes(normalize(item))));
  return word === undefined ? null : `言葉「${word}」`;
}

// requires: 記録の店に、決まった記録があるか。append の記録は、最後の 1 件で見る
function requirementProblem(rule, store) {
  if (!has(store, rule.recorded)) return `記録「${rule.recorded}」がありません`;
  if (!rule.equals) return null;
  const saved = store[rule.recorded];
  const latest = Array.isArray(saved) ? saved.at(-1) : saved;
  const matches = isPlainObject(latest) && Object.entries(rule.equals).every(([key, value]) => has(latest, key) && sameJson(latest[key], value));
  return matches ? null : `記録「${rule.recorded}」が条件(${JSON.stringify(rule.equals)})に合いません`;
}

function matches(item, rule, wanted) {
  const value = own(item, rule.field);
  if (rule.atLeast) return typeof value === 'number' && value >= wanted;
  if (rule.atMost) return typeof value === 'number' && value <= wanted;
  if (rule.includes) return Array.isArray(value) && value.some((element) => sameJson(element, wanted));
  if (rule.contains) return typeof value === 'string' && typeof wanted === 'string' && normalize(value).includes(normalize(wanted));
  return sameJson(value, wanted);
}

function pick(item, fields) {
  if (!fields || !isPlainObject(item)) return clone(item);
  return Object.fromEntries(fields.filter((field) => Object.hasOwn(item, field)).map((field) => [field, clone(item[field])]));
}

// 並べ方は、文字列も数も、< と > だけで比べる(環境の言語の設定で順が変わらないようにする)。
// 値のないもの(null も)は、どちらの向きでも後ろ。型の違う値は、型の名前の順(number が string より前)
function compareBy(field, order) {
  const sign = order === 'desc' ? -1 : 1;
  const missing = (value) => value === undefined || value === null;
  return (a, b) => {
    const x = own(a, field);
    const y = own(b, field);
    if (missing(x) || missing(y)) return missing(x) - missing(y);
    if (typeof x !== typeof y) return typeof x < typeof y ? -1 : 1;
    return x < y ? -sign : x > y ? sign : 0;
  };
}

// 処理(op)を動かす。値を返すだけで、ファイルにも app/ にも書かない
function run(tool, args, data, store, context) {
  const action = tool.do;
  const source = action.data === undefined ? undefined : data?.[action.data];
  if (action.data !== undefined && source === undefined) {
    return { ok: false, error: `データ app/${action.data} が読めていません` };
  }
  if ((action.op === 'search' || action.op === 'get') && !Array.isArray(source)) {
    return { ok: false, error: `データ app/${action.data} が配列ではありません` };
  }
  switch (action.op) {
    case 'search': {
      const rules = Object.entries(action.match ?? {}).filter(([arg]) => own(args, arg) !== undefined);
      // 並べる前に順を写す(sort は安定なので、同じ値どうしはデータの順のまま)
      let found = source.filter((item) => rules.every(([arg, rule]) => matches(item, rule, args[arg])));
      if (action.sort) found = [...found].sort(compareBy(action.sort.field, action.sort.order));
      return { ok: true, result: { count: found.length, items: found.slice(0, action.limit).map((item) => pick(item, action.fields)) } };
    }
    case 'get': {
      const wanted = own(args, action.key);
      if (wanted === undefined) return { ok: false, error: `「${action.key}」を渡してください` };
      const item = source.find((candidate) => has(candidate, action.key) && sameJson(candidate[action.key], wanted));
      if (item === undefined) return { ok: false, error: `${action.key} が ${JSON.stringify(wanted)} のものは見つかりません` };
      return { ok: true, result: pick(item, action.fields) };
    }
    case 'record': {
      const value = clone(args);
      const before = own(store, action.into);
      const saved = action.mode === 'append' ? [...(Array.isArray(before) ? before : []), value] : value;
      return { ok: true, result: { recorded: action.into }, store: { ...store, [action.into]: saved } };
    }
    case 'fixed':
      return { ok: true, result: clone(action.data === undefined ? action.value : source) };
    case 'handoff': {
      // 辺があれば、辺の carry の名前の引数だけを渡す(carry がなければ何も渡さない)。
      // 辺が渡されなければ(会話の進め方の外から呼ぶとき)、引数をそのまま返し、絞るのは呼ぶ側に任せる
      const edge = (Array.isArray(context.handoffs) ? context.handoffs : []).find((item) => item.from === context.by && item.to === action.to);
      const carry = edge
        ? Object.fromEntries((edge.carry ?? []).filter((name) => own(args, name) !== undefined).map((name) => [name, clone(args[name])]))
        : clone(args);
      return { ok: true, result: { handoff: action.to }, handoff: { to: action.to, carry } };
    }
    case 'delegate': {
      // 委任(2.9)。依頼の文(task)と、辺の carry の名前の引数だけをサブに渡す。サブを回すのは会話の進め方
      const edge = (Array.isArray(context.delegations) ? context.delegations : []).find((item) => item.from === context.by && item.to === action.to);
      const values = Object.fromEntries(Object.entries(isPlainObject(args) ? args : {}).filter(([name]) => name !== 'task'));
      const carry = edge
        ? Object.fromEntries((edge.carry ?? []).filter((name) => own(values, name) !== undefined).map((name) => [name, clone(values[name])]))
        : clone(values);
      const task = typeof own(args, 'task') === 'string' ? args.task : '';
      return { ok: true, result: { delegated: action.to, note: DELEGATE_NOTE }, delegate: { to: action.to, task, carry } };
    }
    default:
      return { ok: false, error: `知らない処理です: ${action.op}` };
  }
}

// hideFields: 結果から、決まった名前の項目を、入れ子の中まで除く。除いた項目の名前を返す
function hide(result, fields) {
  const hidden = new Set();
  const strip = (value) => {
    if (Array.isArray(value)) return value.map(strip);
    if (!isPlainObject(value)) return value;
    // Object.fromEntries で作る(データの "__proto__" の項目を、ただの項目として扱うため)
    return Object.fromEntries(Object.entries(value).filter(([key]) => {
      if (!fields.includes(key)) return true;
      hidden.add(key);
      return false;
    }).map(([key, item]) => [key, strip(item)]));
  };
  return { value: strip(result), hidden: fields.filter((field) => hidden.has(field)) };
}

// 記録に残す値を伏せる。文字列の値に加えて、項目の名前も伏せる(知らない引数の名前に、電話番号などを書かれても残さないため)
function redactRecord(value) {
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map(redactRecord);
  if (isPlainObject(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [redact(key), redactRecord(item)]));
  return value;
}

// 記録に残す結果の要約。全文は残さず、長さと数と項目の名前だけ(4.1)
function summarize(outcome) {
  if (!outcome.ok) return { ok: false, error: outcome.error };
  const chars = JSON.stringify(outcome.result ?? null).length;
  const summary = { ok: true, chars };
  const { result } = outcome;
  if (isPlainObject(result) && typeof result.count === 'number' && Array.isArray(result.items)) summary.count = result.count;
  else if (Array.isArray(result)) summary.count = result.length;
  if (isPlainObject(result)) summary.keys = Object.keys(result);
  return summary;
}

// ツールの口の外で断った呼び出し(1 回の返事のツールの数の上限、許可していない名前)の、記録の 1 件。
// ツールの口の記録(callTool の entry)と同じ形で、同じく伏せる。layer は tool(前提の上限)か permission(許可していない名前)
export function refusedEntry({ name, args, by, layer = 'tool', guard, reason, owner = 'studio' }) {
  return redactRecord({
    tool: String(name),
    ...(by ? { by } : {}),
    args: jsonCopy(args),
    result: { ok: false, error: reason },
    ms: 0,
    guards: [{ layer, guard, effect: 'blocked', owner, reason }],
  });
}

// 1 回のツールの呼び出し。
// tools: 検査した tools.json(parseTools の toolset)。data: loadToolData の data。store: 会話ごとの記録の店({ 記録の名前: 値 })。
// context: { conversationId, userId, by(呼んだ参加者), calls({ ツールの名前: これまでの回数 }), assumption(前提。toolCalling を見る),
//            handoffs(構成の辺), delegations(委任の辺), depthLeft(あと何段任せられるか), delegationsLeft(このターンにあと何回任せられるか),
//            via(モデルでなくコードが呼んだとき 'flow'。記録に残す), sleep(テスト用) }
// 返す値: { ok, result | error, guards[], ms, store(新しい記録の店), calls(新しい回数), handoff?, delegate?, fault?, entry(記録の 1 件) }。
// 同じ tools、data、store、context.calls、args なら、ms のほかは同じ値を返す
export async function callTool({ tools, data = {}, store = {}, context = {}, name, args = {} }) {
  const started = performance.now();
  const calls = { ...(context.calls ?? {}) };
  const tool = (tools?.tools ?? []).find((item) => item.name === name);
  const owner = tool?.owner ?? tools?.owner ?? 'studio';
  const guards = [];
  const mark = (guard, effect, reason) => guards.push({ layer: 'tool', guard, effect, owner, ...(reason ? { reason } : {}) });
  let outcome;

  if (!tool) {
    mark('schema', 'blocked', `「${name}」というツールはありません`);
    outcome = { ok: false, error: `「${name}」というツールはありません` };
  } else {
    // 回数は、断ったものも含めて、そのツールが呼ばれた回で数える(faults の onCall も同じ回で見る)
    const count = (own(calls, name) ?? 0) + 1;
    calls[name] = count;
    const calling = context.assumption?.toolCalling ?? {};
    if (calling.delayMs > 0) await (context.sleep ?? sleepFor)(calling.delayMs);
    outcome = gate(tool, { args, data, store, context, count, calling, mark });
  }

  const ms = Math.round(performance.now() - started);
  const nextStore = outcome.store ?? store;
  // 記録の 1 件は、引数、誤りの文、守りの理由、ツールの名前まで伏せてから返す(4.1)
  const entry = redactRecord({
    tool: String(name),
    ...(context.by ? { by: context.by } : {}),
    ...(context.via ? { via: context.via } : {}),
    args: jsonCopy(args),
    result: summarize(outcome),
    ms,
    guards: jsonCopy(guards),
    ...(outcome.fault ? { fault: true } : {}),
    ...(outcome.handoff ? { handoff: { to: outcome.handoff.to } } : {}),
    ...(outcome.delegate ? { delegate: { to: outcome.delegate.to } } : {}),
  });
  return {
    ok: outcome.ok,
    ...(outcome.ok ? { result: outcome.result } : { error: outcome.error }),
    guards,
    ms,
    store: nextStore,
    calls,
    ...(outcome.handoff ? { handoff: outcome.handoff } : {}),
    ...(outcome.delegate ? { delegate: outcome.delegate } : {}),
    ...(outcome.fault ? { fault: true } : {}),
    entry,
  };
}

// 形の検査 → ツールの守り(回数、requires、deny、引き継ぎの辺、委任の辺と上限)→ 前提の失敗 → 実行 → 結果の守り(hideFields、maxResultChars)。
// 守りに当たったら、そこで止めて実行しない
function gate(tool, { args, data, store, context, count, calling, mark }) {
  const block = (guard, reason, error = reason) => {
    mark(guard, 'blocked', reason);
    return { ok: false, error };
  };
  const { guards } = tool;

  // 形の検査(いつも効く)
  let serialized;
  try {
    serialized = JSON.stringify(args);
  } catch {
    serialized = undefined;
  }
  const problem = serialized === undefined
    ? '引数を JSON にできません'
    : serialized.length > GATE_LIMITS.maxArgsChars
      ? `引数が大きすぎます(${serialized.length} 文字。上限 ${GATE_LIMITS.maxArgsChars} 文字)`
      : argsProblem(tool.inputSchema, args, '');
  if (problem) return block('schema', problem);
  mark('schema', 'passed');

  // 回数(maxCallsPerConversation)。形の検査で断った呼び出しも、回に数える
  if (guards.maxCallsPerConversation !== undefined) {
    if (count > guards.maxCallsPerConversation) {
      return block('maxCallsPerConversation', `このツールは 1 つの会話で ${guards.maxCallsPerConversation} 回までです`);
    }
    mark('maxCallsPerConversation', 'passed');
  }

  // requires(記録の店に、決まった記録があるときだけ動く)
  for (const rule of guards.requires ?? []) {
    const missing = requirementProblem(rule, store);
    if (missing) return block('requires', missing);
  }
  if (guards.requires) mark('requires', 'passed');

  // deny(引数が条件に合えば断る。断る文は宣言の message)
  for (const rule of guards.deny ?? []) {
    const matched = denied(rule, args);
    if (matched) return block('deny', `「${rule.arg}」が断る条件(${matched})に合いました`, rule.message);
  }
  if (guards.deny) mark('deny', 'passed');

  // 引き継ぎの辺(2.5)。会話の進め方が辺(context.handoffs)と呼んだ参加者(context.by)を渡したときだけ見る。
  // 辺にない引き継ぎは、モデルが頼んでも断る。回数の上限(limits.maxHandoffs)は会話の進め方が数える
  if (tool.do.op === 'handoff' && Array.isArray(context.handoffs) && context.by) {
    if (!context.handoffs.some((edge) => edge.from === context.by && edge.to === tool.do.to)) {
      return block('handoff', `「${context.by}」から「${tool.do.to}」への引き継ぎは、構成の handoffs にありません`);
    }
    mark('handoff', 'passed');
  }

  // 委任の辺と上限(2.9)。会話の進め方が辺(context.delegations)と呼んだ参加者を渡したときだけ見る。
  // 深さ(depthLeft)と 1 ターンの回数(delegationsLeft)は、会話の進め方が数えて渡す。会話の進め方も、サブを回す前に同じ上限を確かめ直す
  if (tool.do.op === 'delegate' && Array.isArray(context.delegations) && context.by) {
    if (!context.delegations.some((edge) => edge.from === context.by && edge.to === tool.do.to)) {
      return block('delegate', `「${context.by}」から「${tool.do.to}」への委任は、構成の delegations にありません`);
    }
    mark('delegate', 'passed');
    if (Number.isInteger(context.depthLeft)) {
      if (context.depthLeft <= 0) return block('maxDepth', '委任の深さの上限に達しました(limits.maxDepth)。これより先には任せられません。任せずに答えてください');
      mark('maxDepth', 'passed');
    }
    if (Number.isInteger(context.delegationsLeft)) {
      if (context.delegationsLeft <= 0) return block('maxDelegations', '1 ターンの委任の回数の上限に達しました(limits.maxDelegations)。任せずに答えてください');
      mark('maxDelegations', 'passed');
    }
  }

  // 前提の失敗(faults)。決まった回の呼び出しを、実行せずに失敗にする。守りではないので guards には入れない
  if ((calling.faults ?? []).some((fault) => fault.tool === tool.name && fault.onCall === count)) {
    return { ok: false, error: FAULT_MESSAGE, fault: true };
  }

  const outcome = run(tool, args, data, store, context);
  if (!outcome.ok) return outcome;

  // hideFields(結果から決まった項目を除く。除いた項目があれば blocked として残す)
  let { result } = outcome;
  if (guards.hideFields) {
    const { value, hidden } = hide(result, guards.hideFields);
    result = value;
    if (hidden.length > 0) mark('hideFields', 'blocked', `結果から ${hidden.join('、')} を除きました`);
    else mark('hideFields', 'passed');
  }

  // maxResultChars(宣言の上限と、前提の resultMaxChars の小さいほう)。超えたら結果を返さず、記録の店も変えない
  const limits = [guards.maxResultChars, calling.resultMaxChars].filter((value) => Number.isInteger(value));
  if (limits.length > 0) {
    const max = Math.min(...limits);
    const chars = JSON.stringify(result ?? null).length;
    if (chars > max) {
      const reason = `結果が長すぎます(${chars} 文字。上限 ${max} 文字)`;
      return block('maxResultChars', reason, `${reason}。条件を絞ってください`);
    }
    mark('maxResultChars', 'passed');
  }
  return { ...outcome, result };
}
