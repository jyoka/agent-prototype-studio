import { PART_KINDS } from './assumptions.js';
import {
  ACTION_PATTERN,
  KEY_PATTERN,
  Problems,
  SIM_LIMITS,
  TOOL_NAME_PATTERN,
  checkKeys,
  formatVersion,
  idOf,
  integer,
  isPlainObject,
  jsonValue,
  list,
  listJsonFiles,
  named,
  oneOf,
  readAppJson,
  text,
  texts,
  toolNameOf,
} from './check.js';

// 場面(app/evals/*.json)。会話の確かめの 1 単位(docs/design/agent-simulation.md の 4.2)。
// 場面の種類(kind)と確かめ(check)は決まった語だけ。増やせるのは Studio のコードだけ。
export const EVAL_KINDS = [
  'aside', 'question', 'multi', 'correct', 'emotion', 'risky', 'short',
  'control', 'switch', 'no-tool', 'tool-fault', 'surface', 'tool',
];
// 確かめの語と、それぞれに書ける項目(check のほか)
export const CHECK_KEYS = {
  toolCalled: ['tool', 'args'],
  noToolCall: ['tool'],
  noToolRun: ['tool'],
  guardBlocked: ['layer', 'guard'],
  noGuardBlock: ['layer', 'guard'],
  replyContains: ['text'],
  replyNotContains: ['text'],
  replyMaxChars: ['value'],
  noNewNumbers: [],
  partKinds: ['kinds'],
  handoffTo: ['to'],
  recordHas: ['record', 'equals'],
  noRecord: ['record', 'equals'],
  stateHas: ['field', 'equals'],
  noAskAgain: ['words'],
  noRepeat: ['times'],
  judge: ['aspect', 'rubric', 'passAtLeast'],
};
export const CHECKS = Object.keys(CHECK_KEYS);
// どの確かめにも書ける only: その接続の回しでだけ見る(ほかの接続では n/a)。モックの決まった文を見る確かめを、実モデルの回しから外すため
export const CHECK_ONLY = ['mock', 'claude-code'];
// 結果の確かめ: 危ないことが起きなかったかを、どの層が止めたかによらずに見る。危ない場面の「止まったか」は、これと出口の確かめの違反だけで決める(3.7)
export const RESULT_CHECKS = ['noToolRun', 'noRecord', 'replyNotContains'];
// 守りの層。permission は、許可していない名前のツールを模擬のエージェントが呼ぼうとしたときの断り(3.6)
export const GUARD_LAYERS_SEEN = ['tool', 'prompt', 'output', 'permission'];

export const EVAL_LIMITS = {
  maxFiles: 200,
  maxHistory: 50,
  maxTurns: 20,
  maxExpect: 20,
};

const TOP_KEYS = ['formatVersion', 'id', 'kind', 'about', 'entry', 'history', 'records', 'turns', 'call', 'expect'];

function checkExpect(problems, where, item, { knownTool }) {
  if (!isPlainObject(item)) {
    problems.add(where, `{ "check": … } の形で書いてください。check: ${CHECKS.join(', ')}`);
    return;
  }
  const check = oneOf(problems, `${where}.check`, item.check, CHECKS, { label: '確かめ' });
  if (!check) return;
  checkKeys(problems, where, item, ['check', ...CHECK_KEYS[check], 'only']);
  if (item.only !== undefined) oneOf(problems, `${where}.only`, item.only, CHECK_ONLY, { label: '接続' });
  const required = check === 'toolCalled' || check === 'noToolRun';
  if (check === 'toolCalled' || check === 'noToolCall' || check === 'noToolRun') {
    const tool = toolNameOf(problems, `${where}.tool`, item.tool, { required });
    if (tool) knownTool(`${where}.tool`, tool);
  }
  if (item.args !== undefined) {
    if (!isPlainObject(item.args)) problems.add(`${where}.args`, '{ 引数の名前: 値 } の形で書いてください');
    else jsonValue(problems, `${where}.args`, item.args);
  }
  if (check === 'guardBlocked' || check === 'noGuardBlock') {
    oneOf(problems, `${where}.layer`, item.layer, GUARD_LAYERS_SEEN, { label: '守りの層' });
    text(problems, `${where}.guard`, item.guard, { required: check === 'guardBlocked', max: 40 });
  }
  if (check === 'replyContains' || check === 'replyNotContains') text(problems, `${where}.text`, item.text, { required: true, max: 200 });
  if (check === 'replyMaxChars') integer(problems, `${where}.value`, item.value, { min: 1, max: 10_000, required: true });
  if (check === 'partKinds') {
    const kinds = list(problems, `${where}.kinds`, item.kinds, { min: 1, max: PART_KINDS.length, of: '部品の種類の' }) ?? [];
    kinds.forEach((kind, i) => oneOf(problems, `${where}.kinds[${i}]`, kind, PART_KINDS, { label: '部品の種類' }));
  }
  if (check === 'handoffTo') idOf(problems, `${where}.to`, item.to);
  if (check === 'recordHas' || check === 'noRecord') toolNameOf(problems, `${where}.record`, item.record);
  if (check === 'stateHas') named(problems, `${where}.field`, item.field, KEY_PATTERN, { hint: 'ai.json の項目の key' });
  if ((check === 'recordHas' || check === 'noRecord' || check === 'stateHas') && item.equals !== undefined) jsonValue(problems, `${where}.equals`, item.equals);
  if (check === 'noAskAgain' && item.words !== undefined) texts(problems, `${where}.words`, item.words, { min: 1, max: 20, maxChars: 100 });
  if (check === 'noRepeat') integer(problems, `${where}.times`, item.times, { min: 1, max: 10 });
  if (check === 'judge') {
    text(problems, `${where}.aspect`, item.aspect, { required: true, max: 40 });
    text(problems, `${where}.rubric`, item.rubric, { required: true, max: SIM_LIMITS.maxText });
    integer(problems, `${where}.passAtLeast`, item.passAtLeast, { min: 1, max: 5, required: true });
  }
}

function checkCall(problems, where, value, knownTool) {
  if (!isPlainObject(value)) {
    problems.add(where, '{ "tool": ツールの名前, "args": { … } } の形で書いてください');
    return;
  }
  checkKeys(problems, where, value, ['tool', 'args']);
  const tool = toolNameOf(problems, `${where}.tool`, value.tool);
  if (tool) knownTool(`${where}.tool`, tool);
  if (value.args !== undefined && !isPlainObject(value.args)) problems.add(`${where}.args`, '{ 引数の名前: 値 } の形で書いてください');
  else if (value.args !== undefined) jsonValue(problems, `${where}.args`, value.args);
}

// 場面を検査する。toolNames は、どこかの tools.json にあるツールの名前。
// tools.json が 1 つもなければ、ツールの名前は確かめない(その構成では、ツールの確かめは n/a になる。R5)。
// entry の参加者がいるかも、構成ごとに n/a にするので、ここでは形だけを見る(2.7)
export function parseEval(raw, { file, toolNames }) {
  const problems = new Problems(`app/${file}`);
  if (!isPlainObject(raw)) {
    problems.add('', '全体を { … } のオブジェクトで書いてください');
    return { scenario: null, errors: problems.list };
  }
  checkKeys(problems, '', raw, TOP_KEYS);
  formatVersion(problems, raw);
  const id = idOf(problems, 'id', raw.id);
  const kind = oneOf(problems, 'kind', raw.kind, EVAL_KINDS, { label: '場面の種類' });
  text(problems, 'about', raw.about, { max: 200 });
  const knownTool = (where, tool) => {
    if (toolNames.size > 0 && !toolNames.has(tool)) problems.add(where, `「${tool}」は tools.json にないツールです`);
  };

  if (kind === 'tool') {
    // ツールだけの場面は、エージェントを通さず、ツールの口を直接呼ぶ
    for (const key of ['entry', 'history', 'turns'].filter((k) => raw[k] !== undefined)) {
      problems.add(key, 'ツールだけの場面(kind: "tool")には書けません');
    }
    if (toolNames.size === 0) problems.add('call', 'ツールの宣言(tools.json)がないので、ツールだけの場面は回せません');
    checkCall(problems, 'call', raw.call, knownTool);
  } else if (kind) {
    if (raw.call !== undefined) problems.add('call', 'ツールだけの場面(kind: "tool")でだけ書けます');
    idOf(problems, 'entry', raw.entry, { required: false });
    if (raw.history !== undefined) {
      const history = list(problems, 'history', raw.history, { max: EVAL_LIMITS.maxHistory, of: '発言の' }) ?? [];
      for (const [i, item] of history.entries()) {
        if (!isPlainObject(item)) {
          problems.add(`history[${i}]`, '{ "role": "user" か "assistant", "text": … } の形で書いてください');
          continue;
        }
        checkKeys(problems, `history[${i}]`, item, ['role', 'text']);
        oneOf(problems, `history[${i}].role`, item.role, ['user', 'assistant'], { label: '話し手' });
        text(problems, `history[${i}].text`, item.text, { required: true, max: SIM_LIMITS.maxText });
      }
    }
    const turns = list(problems, 'turns', raw.turns, { min: 1, max: EVAL_LIMITS.maxTurns, of: '発言の' }) ?? [];
    for (const [i, turn] of turns.entries()) {
      if (!isPlainObject(turn) || (turn.user === undefined && turn.action === undefined)) {
        problems.add(`turns[${i}]`, '{ "user": 発言 } か { "action": ボタンの名前 } の形で書いてください');
        continue;
      }
      checkKeys(problems, `turns[${i}]`, turn, ['user', 'action']);
      text(problems, `turns[${i}].user`, turn.user, { max: SIM_LIMITS.maxText });
      named(problems, `turns[${i}].action`, turn.action, ACTION_PATTERN, { required: false, hint: '英小文字で始め、英小文字、数字、_、- だけで 40 字まで' });
    }
  }

  if (raw.records !== undefined) {
    if (!isPlainObject(raw.records)) problems.add('records', '{ 記録の名前: 値 } の形で書いてください');
    else {
      for (const name of Object.keys(raw.records)) {
        if (!TOOL_NAME_PATTERN.test(name)) problems.add('records', `「${name}」は使えない記録の名前です`);
      }
      jsonValue(problems, 'records', raw.records, { max: 10_000 });
    }
  }
  const expect = list(problems, 'expect', raw.expect, { min: 1, max: EVAL_LIMITS.maxExpect, of: '確かめの' }) ?? [];
  expect.forEach((item, i) => checkExpect(problems, `expect[${i}]`, item, { knownTool }));

  if (problems.list.length > 0) return { scenario: null, errors: problems.list };
  return { scenario: { ...raw, id, kind }, errors: [] };
}

// 場面の置き場所(目録の evals。既定は evals/)の場面を全部読む。id は重ならない
export async function readEvals(appDir, folder, { toolNames }) {
  const { files, errors } = await listJsonFiles(appDir, folder, { max: EVAL_LIMITS.maxFiles, label: '場面' });
  const evals = [];
  for (const file of files) {
    const { value, error } = await readAppJson(appDir, file);
    if (error) {
      errors.push({ file: `app/${file}`, text: error });
      continue;
    }
    const parsed = parseEval(value, { file, toolNames });
    errors.push(...parsed.errors);
    if (!parsed.scenario) continue;
    const same = evals.find((item) => item.scenario.id === parsed.scenario.id);
    if (same) errors.push({ file: `app/${file}`, text: `id: 「${parsed.scenario.id}」は app/${same.file} と重なっています` });
    else evals.push({ file, scenario: parsed.scenario });
  }
  return { evals, errors };
}
