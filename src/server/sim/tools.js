import {
  KEY_PATTERN,
  Problems,
  SIM_LIMITS,
  TOOL_NAME_PATTERN,
  appFile,
  checkKeys,
  formatVersion,
  idOf,
  integer,
  isPlainObject,
  jsonValue,
  list,
  named,
  oneOf,
  ownerOf,
  readAppJson,
  show,
  text,
  texts,
  toolNameOf,
  unique,
} from './check.js';

// 試作品のツールの宣言(app/tools.json)。決まった 6 つの処理(op)の組み合わせだけで書き、Studio のコード(ツールの口)が解釈する。
// 生成コードをサーバーで読まない、動かさない(ADR-0001、ADR-0003)。形は docs/design/agent-simulation.md の 2.4 と 3.5。
export const TOOLS_FILE = 'tools.json';
export const TOOL_OPS = ['search', 'get', 'record', 'fixed', 'handoff', 'delegate'];
// 委任のツール(op: delegate。2.9)が必ず持つ引数。サブに渡す依頼の文
export const DELEGATE_TASK_ARG = 'task';
export const TOOL_GUARDS = ['requires', 'deny', 'hideFields', 'maxCallsPerConversation', 'maxResultChars'];
// search の match で使える比べ方。書かなければ equals
export const MATCH_KINDS = ['equals', 'atLeast', 'atMost', 'includes', 'contains'];
// deny の looksLike(src/server/redact.js の見分け方と同じ種類)
export const LOOKS_LIKE = ['phone', 'email', 'address', 'personName'];

export const TOOL_LIMITS = {
  maxTools: 30,
  maxDescription: 1000,
  maxProperties: 30,
  maxSchemaDepth: 3,
  maxEnum: 50,
  maxStringLength: 10_000,
  maxFields: 50,
  maxSearchLimit: 20,
  maxGuardItems: 10,
  maxCallsPerConversation: 100,
  maxResultChars: 20_000,
  maxFixedValue: 20_000,
};

const TOP_KEYS = ['formatVersion', 'owner', 'tools'];
const TOOL_KEYS = ['name', 'description', 'owner', 'inputSchema', 'do', 'guards'];
const OP_KEYS = {
  search: ['op', 'data', 'match', 'fields', 'sort', 'limit'],
  get: ['op', 'data', 'key', 'fields'],
  record: ['op', 'into', 'mode'],
  fixed: ['op', 'data', 'value'],
  handoff: ['op', 'to'],
  delegate: ['op', 'to'],
};
// inputSchema は、決まった部分だけを使える JSON Schema(2.7)
const SCHEMA_TYPES = ['object', 'string', 'number', 'integer', 'boolean', 'array'];
const SCHEMA_KEYS = {
  object: ['type', 'properties', 'required'],
  string: ['type', 'enum', 'maxLength'],
  number: ['type', 'enum', 'minimum', 'maximum'],
  integer: ['type', 'enum', 'minimum', 'maximum'],
  boolean: ['type'],
  array: ['type', 'items'],
};
const DATA_EXTENSIONS = ['.json'];

function checkSchema(problems, where, schema, depth) {
  if (!isPlainObject(schema)) {
    problems.add(where, '{ "type": … } の形で書いてください');
    return null;
  }
  const type = oneOf(problems, `${where}.type`, schema.type, SCHEMA_TYPES, { label: '型' });
  if (!type) return null;
  checkKeys(problems, where, schema, SCHEMA_KEYS[type]);
  if (type === 'object') {
    const properties = schema.properties ?? {};
    if (!isPlainObject(properties) || Object.keys(properties).length > TOOL_LIMITS.maxProperties) {
      problems.add(`${where}.properties`, `${TOOL_LIMITS.maxProperties} 個までの { 名前: 形 } で書いてください`);
      return null;
    }
    if (depth >= TOOL_LIMITS.maxSchemaDepth && Object.keys(properties).length > 0) {
      problems.add(where, `入れ子は ${TOOL_LIMITS.maxSchemaDepth} 段までにしてください`);
      return null;
    }
    for (const [key, child] of Object.entries(properties)) {
      named(problems, `${where}.properties`, key, KEY_PATTERN, { hint: '英字で始め、英数字と _ だけで 32 字まで' });
      checkSchema(problems, `${where}.properties.${key}`, child, depth + 1);
    }
    if (schema.required !== undefined) {
      const required = list(problems, `${where}.required`, schema.required, { max: TOOL_LIMITS.maxProperties, of: '名前の' }) ?? [];
      for (const key of required) {
        if (typeof key !== 'string') problems.add(`${where}.required`, '引数の名前(文字列)を並べてください');
        else if (!Object.hasOwn(properties, key)) problems.add(`${where}.required`, `「${key}」は properties にありません`);
      }
    }
  }
  if (type === 'array') {
    if (depth >= TOOL_LIMITS.maxSchemaDepth) problems.add(where, `入れ子は ${TOOL_LIMITS.maxSchemaDepth} 段までにしてください`);
    else if (schema.items !== undefined) checkSchema(problems, `${where}.items`, schema.items, depth + 1);
  }
  if (schema.enum !== undefined) {
    const values = list(problems, `${where}.enum`, schema.enum, { min: 1, max: TOOL_LIMITS.maxEnum, of: '値の' }) ?? [];
    const scalar = type === 'string' ? 'string' : 'number';
    if (values.some((value) => typeof value !== scalar || (scalar === 'number' && !Number.isFinite(value)))) {
      problems.add(`${where}.enum`, `型 ${type} の値だけを並べてください`);
    }
  }
  integer(problems, `${where}.maxLength`, schema.maxLength, { min: 1, max: TOOL_LIMITS.maxStringLength });
  for (const key of ['minimum', 'maximum']) {
    if (schema[key] !== undefined && (typeof schema[key] !== 'number' || !Number.isFinite(schema[key]))) {
      problems.add(`${where}.${key}`, '数で書いてください');
    }
  }
  if (typeof schema.minimum === 'number' && typeof schema.maximum === 'number' && schema.minimum > schema.maximum) {
    problems.add(where, 'minimum が maximum より大きくなっています');
  }
  return schema;
}

// ツールが読むデータ。app/ の中の JSON だけを、JSON として読む。search と get は配列のデータを読む
async function checkData(problems, where, value, appDir, { array }) {
  const file = await appFile(problems, where, value, appDir, { extensions: DATA_EXTENSIONS });
  if (file === undefined) return undefined;
  const { value: data, error } = await readAppJson(appDir, file, SIM_LIMITS.maxDataBytes);
  if (error) {
    problems.add(where, `app/${file}: ${error}`);
    return undefined;
  }
  if (array && (!Array.isArray(data) || data.some((item) => !isPlainObject(item)))) {
    problems.add(where, `app/${file} は、オブジェクトの配列([{ … }, …])にしてください`);
    return undefined;
  }
  return file;
}

const fieldNames = (problems, where, value) =>
  value === undefined ? undefined : texts(problems, where, value, { max: TOOL_LIMITS.maxFields, maxChars: 40 });

async function checkDo(problems, where, raw, appDir, properties) {
  if (!isPlainObject(raw)) {
    problems.add(where, `{ "op": … } の形で書いてください。op: ${TOOL_OPS.join(', ')}`);
    return null;
  }
  const op = oneOf(problems, `${where}.op`, raw.op, TOOL_OPS, { label: '処理' });
  if (!op) return null;
  checkKeys(problems, where, raw, OP_KEYS[op]);
  const result = { op };
  if (op === 'search' || op === 'get') {
    result.data = await checkData(problems, `${where}.data`, raw.data, appDir, { array: true });
    result.fields = fieldNames(problems, `${where}.fields`, raw.fields);
  }
  if (op === 'search') {
    result.match = {};
    if (raw.match !== undefined) {
      if (!isPlainObject(raw.match)) problems.add(`${where}.match`, '{ 引数の名前: { "field": … } } の形で書いてください');
      else {
        for (const [arg, rule] of Object.entries(raw.match)) {
          const at = `${where}.match.${arg}`;
          if (!Object.hasOwn(properties, arg)) problems.add(at, `「${arg}」は inputSchema の properties にない引数です`);
          if (!isPlainObject(rule)) {
            problems.add(at, '{ "field": データの項目, 比べ方: true } の形で書いてください');
            continue;
          }
          checkKeys(problems, at, rule, ['field', ...MATCH_KINDS]);
          text(problems, `${at}.field`, rule.field, { required: true, max: 40 });
          const kinds = MATCH_KINDS.filter((kind) => Object.hasOwn(rule, kind));
          if (kinds.length > 1) problems.add(at, `比べ方は 1 つだけ書いてください(${kinds.join('、')})`);
          for (const kind of kinds) if (rule[kind] !== true) problems.add(`${at}.${kind}`, 'true で書いてください');
          result.match[arg] = rule;
        }
      }
    }
    if (raw.sort !== undefined) {
      if (!isPlainObject(raw.sort)) problems.add(`${where}.sort`, '{ "field": …, "order": "asc" か "desc" } の形で書いてください');
      else {
        checkKeys(problems, `${where}.sort`, raw.sort, ['field', 'order']);
        text(problems, `${where}.sort.field`, raw.sort.field, { required: true, max: 40 });
        oneOf(problems, `${where}.sort.order`, raw.sort.order, ['asc', 'desc'], { required: false, label: '並べ方' });
        result.sort = raw.sort;
      }
    }
    result.limit = integer(problems, `${where}.limit`, raw.limit, { min: 1, max: TOOL_LIMITS.maxSearchLimit }) ?? TOOL_LIMITS.maxSearchLimit;
  }
  if (op === 'get') result.key = text(problems, `${where}.key`, raw.key, { required: true, max: 40 });
  if (op === 'record') {
    result.into = toolNameOf(problems, `${where}.into`, raw.into);
    result.mode = oneOf(problems, `${where}.mode`, raw.mode, ['replace', 'append'], { required: false, label: '書き方' }) ?? 'replace';
  }
  if (op === 'fixed') {
    const hasData = raw.data !== undefined;
    const hasValue = Object.hasOwn(raw, 'value');
    if (hasData === hasValue) problems.add(where, 'data か value の、どちらか 1 つだけを書いてください');
    else if (hasData) result.data = await checkData(problems, `${where}.data`, raw.data, appDir, { array: false });
    else result.value = jsonValue(problems, `${where}.value`, raw.value, { max: TOOL_LIMITS.maxFixedValue });
  }
  if (op === 'handoff') result.to = idOf(problems, `${where}.to`, raw.to);
  if (op === 'delegate') {
    result.to = idOf(problems, `${where}.to`, raw.to);
    // サブに渡す依頼の文。モデルが書く文なので、長さの上限を宣言に書かせる
    const task = properties[DELEGATE_TASK_ARG];
    if (!isPlainObject(task) || task.type !== 'string' || !Number.isInteger(task.maxLength)) {
      problems.add(where, `委任のツールは、inputSchema の properties に { "${DELEGATE_TASK_ARG}": { "type": "string", "maxLength": … } }(サブへの依頼の文)を書いてください`);
    }
  }
  return result;
}

function checkGuards(problems, where, raw, properties) {
  if (raw === undefined) return {};
  if (!isPlainObject(raw)) {
    problems.add(where, `{ 守りの名前: … } の形で書いてください。守り: ${TOOL_GUARDS.join(', ')}`);
    return {};
  }
  for (const key of Object.keys(raw)) {
    if (!TOOL_GUARDS.includes(key)) problems.add(where, `${JSON.stringify(key)} は知らない守りです。使える守り: ${TOOL_GUARDS.join(', ')}`);
  }
  const guards = {};
  if (raw.requires !== undefined) {
    const items = list(problems, `${where}.requires`, raw.requires, { min: 1, max: TOOL_LIMITS.maxGuardItems }) ?? [];
    guards.requires = items.map((item, i) => {
      const at = `${where}.requires[${i}]`;
      if (!isPlainObject(item)) {
        problems.add(at, '{ "recorded": 記録の名前, "equals": { … } } の形で書いてください');
        return null;
      }
      checkKeys(problems, at, item, ['recorded', 'equals']);
      toolNameOf(problems, `${at}.recorded`, item.recorded);
      if (item.equals !== undefined && !isPlainObject(item.equals)) problems.add(`${at}.equals`, '{ 名前: 値 } の形で書いてください');
      else if (item.equals !== undefined) jsonValue(problems, `${at}.equals`, item.equals);
      return item;
    });
  }
  if (raw.deny !== undefined) {
    const items = list(problems, `${where}.deny`, raw.deny, { min: 1, max: TOOL_LIMITS.maxGuardItems }) ?? [];
    guards.deny = items.map((item, i) => {
      const at = `${where}.deny[${i}]`;
      if (!isPlainObject(item)) {
        problems.add(at, '{ "arg": 引数の名前, "looksLike": […], "message": 断るときの文 } の形で書いてください');
        return null;
      }
      checkKeys(problems, at, item, ['arg', 'looksLike', 'containsAny', 'message']);
      if (typeof item.arg !== 'string' || !Object.hasOwn(properties, item.arg)) {
        problems.add(`${at}.arg`, `${show(item.arg)} は inputSchema の properties にない引数です`);
      }
      if (item.looksLike === undefined && item.containsAny === undefined) problems.add(at, 'looksLike か containsAny を書いてください');
      if (item.looksLike !== undefined) {
        const kinds = list(problems, `${at}.looksLike`, item.looksLike, { min: 1, max: LOOKS_LIKE.length }) ?? [];
        kinds.forEach((kind, j) => oneOf(problems, `${at}.looksLike[${j}]`, kind, LOOKS_LIKE, { label: '見分け方' }));
      }
      if (item.containsAny !== undefined) texts(problems, `${at}.containsAny`, item.containsAny, { min: 1, max: 50, maxChars: 40 });
      text(problems, `${at}.message`, item.message, { required: true, max: 200 });
      return item;
    });
  }
  if (raw.hideFields !== undefined) guards.hideFields = fieldNames(problems, `${where}.hideFields`, raw.hideFields);
  if (raw.maxCallsPerConversation !== undefined) {
    guards.maxCallsPerConversation = integer(problems, `${where}.maxCallsPerConversation`, raw.maxCallsPerConversation, {
      min: 1,
      max: TOOL_LIMITS.maxCallsPerConversation,
    });
  }
  if (raw.maxResultChars !== undefined) {
    guards.maxResultChars = integer(problems, `${where}.maxResultChars`, raw.maxResultChars, { min: 1, max: TOOL_LIMITS.maxResultChars });
  }
  return guards;
}

// tools.json の中身を検査し、既定の値で埋めた宣言を返す。データのファイルの有無と形も、app/ の中で確かめる
export async function parseTools(raw, { file, appDir }) {
  const problems = new Problems(`app/${file}`);
  if (!isPlainObject(raw)) {
    problems.add('', '全体を { … } のオブジェクトで書いてください');
    return { toolset: null, errors: problems.list };
  }
  checkKeys(problems, '', raw, TOP_KEYS);
  formatVersion(problems, raw);
  const owner = ownerOf(problems, 'owner', raw.owner) ?? 'studio';
  const items = list(problems, 'tools', raw.tools, { min: 1, max: TOOL_LIMITS.maxTools, of: 'ツールの' }) ?? [];
  const tools = [];
  for (const [i, item] of items.entries()) {
    const where = `tools[${i}]`;
    if (!isPlainObject(item)) {
      problems.add(where, '{ "name": …, "description": …, "do": { … } } の形で書いてください');
      continue;
    }
    checkKeys(problems, where, item, TOOL_KEYS);
    const name = toolNameOf(problems, `${where}.name`, item.name);
    const description = text(problems, `${where}.description`, item.description, { required: true, max: TOOL_LIMITS.maxDescription });
    const inputSchema = item.inputSchema === undefined
      ? { type: 'object', properties: {} }
      : checkSchema(problems, `${where}.inputSchema`, item.inputSchema, 1);
    if (inputSchema && inputSchema.type !== 'object') problems.add(`${where}.inputSchema.type`, '一番外は "object" にしてください');
    const properties = isPlainObject(inputSchema?.properties) ? inputSchema.properties : {};
    const action = await checkDo(problems, `${where}.do`, item.do, appDir, properties);
    const guards = checkGuards(problems, `${where}.guards`, item.guards, properties);
    if (action?.op === 'delegate' && !(inputSchema?.required ?? []).includes(DELEGATE_TASK_ARG)) {
      problems.add(`${where}.inputSchema.required`, `委任のツールは「${DELEGATE_TASK_ARG}」を required に入れてください(依頼の文のない委任は書けません)`);
    }
    tools.push({
      name,
      description,
      owner: ownerOf(problems, `${where}.owner`, item.owner) ?? owner,
      inputSchema,
      do: action,
      guards,
    });
  }
  unique(problems, 'tools', tools.map((tool) => tool.name), 'ツールの名前');
  // requires が指す記録は、どれかのツールの record が書くもの
  const records = new Set(tools.filter((tool) => tool.do?.op === 'record').map((tool) => tool.do.into));
  for (const [i, tool] of tools.entries()) {
    for (const [j, rule] of (tool.guards.requires ?? []).entries()) {
      if (rule && typeof rule.recorded === 'string' && TOOL_NAME_PATTERN.test(rule.recorded) && !records.has(rule.recorded)) {
        problems.add(`tools[${i}].guards.requires[${j}].recorded`, `「${rule.recorded}」に書く record のツールがありません`);
      }
    }
  }
  if (problems.list.length > 0) return { toolset: null, errors: problems.list };
  return { toolset: { file, owner, tools }, errors: [] };
}

export async function readTools(appDir, file) {
  const { value, error } = await readAppJson(appDir, file);
  if (error) return { toolset: null, errors: [{ file: `app/${file}`, text: error }] };
  return parseTools(value, { file, appDir });
}
