import {
  Problems,
  SIM_LIMITS,
  bool,
  checkKeys,
  formatVersion,
  idOf,
  integer,
  isPlainObject,
  list,
  listJsonFiles,
  named,
  oneOf,
  readAppJson,
  text,
  toolNameOf,
  unique,
} from './check.js';

// 前提(app/assumptions/*.json)。相手の仕様の分からない所を、差し替えられる値にしたもの。1 ファイル 1 組。
// 作る AI が書くので、値には上限を置く(docs/design/agent-simulation.md の 3.4)。
export const DEFAULT_ASSUMPTIONS = 'assumptions';
// 会話の枠の部品の種類(3.8)。前提の messageTypes とモックの返事で使う
export const PART_KINDS = ['text', 'buttons', 'card', 'carousel', 'notice'];
export const TOOL_AUTH = ['none', 'bound-user'];
export const LOG_VIEWS = ['messages', 'toolCalls', 'records'];
// 構成の prompt の from: "assumptions" で読める前提の値
export const ASSUMPTION_TEXT_KEYS = ['hostPrompt'];
// model.name は --model= でつなぐので、形を決める
export const MODEL_NAME_PATTERN = /^[a-z0-9][a-z0-9.-]{0,63}$/;

export const ASSUMPTION_LIMITS = {
  maxFiles: 20,
  maxSlots: 10,
  textMaxChars: 2000,
  buttonsMax: 13,
  partsMax: 5,
  maxPerReply: 8,
  resultMaxChars: 20_000,
  delayMs: 10_000,
  maxFaults: 10,
  maxFaultCall: 100,
};

const TOP_KEYS = ['formatVersion', 'id', 'name', 'note', 'model', 'hostPrompt', 'slots', 'messageTypes', 'messageLimits', 'toolCalling', 'logging'];

function section(problems, where, value, keys) {
  if (value === undefined) return undefined;
  if (!isPlainObject(value)) {
    problems.add(where, `{ ${keys.join(', ')} } の形で書いてください`);
    return undefined;
  }
  checkKeys(problems, where, value, keys);
  return value;
}

// 前提の中身を検査する。toolNames は、faults が指してよいツールの名前(どこかの tools.json にあるもの)
export function parseAssumption(raw, { file, toolNames }) {
  const problems = new Problems(`app/${file}`);
  if (!isPlainObject(raw)) {
    problems.add('', '全体を { … } のオブジェクトで書いてください');
    return { assumption: null, errors: problems.list };
  }
  checkKeys(problems, '', raw, TOP_KEYS);
  formatVersion(problems, raw);
  const id = idOf(problems, 'id', raw.id);
  const name = text(problems, 'name', raw.name);
  text(problems, 'note', raw.note, { max: SIM_LIMITS.maxText });

  const model = section(problems, 'model', raw.model, ['name', 'standIn']);
  if (model) {
    // 空なら --model を付けない
    if (model.name !== undefined && model.name !== '') {
      named(problems, 'model.name', model.name, MODEL_NAME_PATTERN, { hint: '英小文字か数字で始め、英小文字、数字、.、- だけで 64 字まで' });
    }
    bool(problems, 'model.standIn', model.standIn);
  }
  text(problems, 'hostPrompt', raw.hostPrompt, { max: SIM_LIMITS.maxPromptChars });

  const slots = {};
  if (raw.slots !== undefined) {
    if (!isPlainObject(raw.slots) || Object.keys(raw.slots).length > ASSUMPTION_LIMITS.maxSlots) {
      problems.add('slots', `${ASSUMPTION_LIMITS.maxSlots} 個までの { 枠の id: { "maxChars": … } } で書いてください`);
    } else {
      for (const [slot, value] of Object.entries(raw.slots)) {
        idOf(problems, 'slots', slot);
        const item = section(problems, `slots.${slot}`, value, ['maxChars']);
        if (!item) continue;
        const maxChars = integer(problems, `slots.${slot}.maxChars`, item.maxChars, { min: 1, max: SIM_LIMITS.maxPromptChars, required: true });
        if (maxChars !== undefined) slots[slot] = { maxChars };
      }
    }
  }

  let messageTypes = ['text'];
  if (raw.messageTypes !== undefined) {
    const kinds = list(problems, 'messageTypes', raw.messageTypes, { min: 1, max: PART_KINDS.length, of: '部品の種類の' }) ?? [];
    kinds.forEach((kind, i) => oneOf(problems, `messageTypes[${i}]`, kind, PART_KINDS, { label: '部品の種類' }));
    unique(problems, 'messageTypes', kinds, '部品の種類');
    messageTypes = kinds;
  }
  const limits = section(problems, 'messageLimits', raw.messageLimits, ['textMaxChars', 'buttonsMax', 'partsMax']);
  if (limits) {
    integer(problems, 'messageLimits.textMaxChars', limits.textMaxChars, { min: 1, max: ASSUMPTION_LIMITS.textMaxChars });
    integer(problems, 'messageLimits.buttonsMax', limits.buttonsMax, { min: 1, max: ASSUMPTION_LIMITS.buttonsMax });
    integer(problems, 'messageLimits.partsMax', limits.partsMax, { min: 1, max: ASSUMPTION_LIMITS.partsMax });
  }

  const calling = section(problems, 'toolCalling', raw.toolCalling, ['maxPerReply', 'resultMaxChars', 'auth', 'delayMs', 'faults']);
  if (calling) {
    integer(problems, 'toolCalling.maxPerReply', calling.maxPerReply, { min: 1, max: ASSUMPTION_LIMITS.maxPerReply });
    integer(problems, 'toolCalling.resultMaxChars', calling.resultMaxChars, { min: 1, max: ASSUMPTION_LIMITS.resultMaxChars });
    oneOf(problems, 'toolCalling.auth', calling.auth, TOOL_AUTH, { required: false, label: '認証' });
    integer(problems, 'toolCalling.delayMs', calling.delayMs, { min: 0, max: ASSUMPTION_LIMITS.delayMs });
    if (calling.faults !== undefined) {
      const faults = list(problems, 'toolCalling.faults', calling.faults, { max: ASSUMPTION_LIMITS.maxFaults }) ?? [];
      for (const [i, fault] of faults.entries()) {
        const at = `toolCalling.faults[${i}]`;
        if (!isPlainObject(fault)) {
          problems.add(at, '{ "tool": ツールの名前, "onCall": 回 } の形で書いてください');
          continue;
        }
        checkKeys(problems, at, fault, ['tool', 'onCall']);
        const tool = toolNameOf(problems, `${at}.tool`, fault.tool);
        if (tool && !toolNames.has(tool)) problems.add(`${at}.tool`, `「${tool}」は tools.json にないツールです`);
        integer(problems, `${at}.onCall`, fault.onCall, { min: 1, max: ASSUMPTION_LIMITS.maxFaultCall, required: true });
      }
    }
  }

  const logging = section(problems, 'logging', raw.logging, ['partnerSees', 'dipSees']);
  if (logging) {
    for (const key of ['partnerSees', 'dipSees']) {
      if (logging[key] === undefined) continue;
      const views = list(problems, `logging.${key}`, logging[key], { max: LOG_VIEWS.length }) ?? [];
      views.forEach((view, i) => oneOf(problems, `logging.${key}[${i}]`, view, LOG_VIEWS, { label: '記録' }));
    }
  }

  if (problems.list.length > 0) return { assumption: null, errors: problems.list };
  return { assumption: { ...raw, id, name: name ?? id, slots, messageTypes }, errors: [] };
}

// フォルダーの前提を全部読む。id はフォルダーの中で重ならない
export async function readAssumptions(appDir, folder, { toolNames }) {
  const { files, errors } = await listJsonFiles(appDir, folder, { max: ASSUMPTION_LIMITS.maxFiles, label: '前提' });
  const assumptions = [];
  for (const file of files) {
    const { value, error } = await readAppJson(appDir, file);
    if (error) {
      errors.push({ file: `app/${file}`, text: error });
      continue;
    }
    const parsed = parseAssumption(value, { file, toolNames });
    errors.push(...parsed.errors);
    if (!parsed.assumption) continue;
    const same = assumptions.find((item) => item.assumption.id === parsed.assumption.id);
    if (same) errors.push({ file: `app/${file}`, text: `id: 「${parsed.assumption.id}」は app/${same.file} と重なっています` });
    else assumptions.push({ file, assumption: parsed.assumption });
  }
  return { assumptions, errors };
}
