import path from 'node:path';
import { DEFAULT_COMPOSITION, DEFAULT_COMPOSITIONS, DEFAULT_EVALS, kindOf } from '../manifest.js';
import { AI_FILE, AI_LIMITS, readAiDefinition } from '../product-ai/definition.js';
import { ASSUMPTION_TEXT_KEYS, DEFAULT_ASSUMPTIONS, readAssumptions } from './assumptions.js';
import {
  KEY_PATTERN,
  Problems,
  SIM_LIMITS,
  appFile,
  appFolder,
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
  ownerOf,
  readAppJson,
  readAppText,
  text,
  texts,
  toolNameOf,
  unique,
} from './check.js';
import { readEvals } from './evals.js';
import { checkFlowParts, parseFlowParts } from './flow-check.js';
import { DEFAULT_MOCKS, readMocks } from './mocks.js';
import { loadToolData } from './tool-gate.js';
import { TOOLS_FILE, readTools } from './tools.js';

// 構成(app/composition.json)。試作品の中で、誰が会話を回し(driver)、どの参加者がどのツールとプロンプトの枠を持ち、
// ガードレールをどの層で守るかを表すデータ(docs/design/agent-simulation.md の 2 節、ADR-0003)。
// composition.json のない試作品は、ai.json の harness 1 つの構成(構成 B)として読む(2.3)。
export const COMPOSITION_FORMAT_VERSION = 1;
// 参加者の種類。増やせるのは Studio のコードだけ
export const PARTICIPANT_KINDS = ['agent', 'harness', 'human'];
// 構成に書くガードレールの層。ツールの守りは tools.json の guards に書く(3.7)
export const COMPOSITION_GUARD_LAYERS = ['prompt', 'output'];
export const SURFACE_KINDS = ['talk'];
export const SURFACE_THEMES = ['talk', 'web', 'plain'];
export const DEFAULT_OWNER = 'studio';

export const COMPOSITION_LIMITS = {
  maxParticipants: 8,
  maxPromptPieces: 10,
  maxParticipantTools: 30,
  maxHandoffs: 20,
  maxCarry: 20,
  maxGuards: 30,
  maxForbidden: AI_LIMITS.maxForbidden,
  maxTurns: 30,
  maxHandoffsPerConversation: 5,
  maxCompositions: 20,
  // マスターとサブの委任(2.9)。辺の数、1 ターンの委任の回数、深さの上限
  maxDelegationEdges: 20,
  maxDelegationsPerTurn: 10,
  maxDelegationDepth: 3,
};
export const DEFAULT_LIMITS = { maxTurns: 30, maxHandoffs: 3 };
// 委任の辺を書いた構成にだけ足す上限(今の構成の指紋と記録を変えないため。R2)
export const DEFAULT_DELEGATION_LIMITS = { maxDelegations: 3, maxDepth: 1 };

const TOP_KEYS = ['formatVersion', 'name', 'driver', 'participants', 'tools', 'handoffs', 'delegations', 'guards', 'surface', 'assumptions', 'limits'];
const PARTICIPANT_KEYS = {
  agent: ['id', 'kind', 'label', 'owner', 'prompt', 'tools', 'mock'],
  harness: ['id', 'kind', 'label', 'owner', 'ai', 'returnTo', 'model', 'flow', 'escalate'],
  human: ['id', 'kind', 'label', 'owner', 'mock'],
};
const GUARD_KEYS = {
  prompt: ['id', 'layer', 'owner', 'on', 'text'],
  output: ['id', 'layer', 'owner', 'on', 'enforce', 'rules'],
};
// 出口の確かめの決まり(ai.json の rules のうち、返事の形で確かめられるもの)
const OUTPUT_RULE_KEYS = ['noNewNumbers', 'maxReplyChars', 'forbidden'];
const PROMPT_EXTENSIONS = ['.md', '.txt'];

function parsePromptPiece(problems, where, raw) {
  if (!isPlainObject(raw)) {
    problems.add(where, '{ "from": "assumptions", "key": … } か { "slot": 枠の id, "file": … } の形で書いてください');
    return null;
  }
  if (raw.from !== undefined) {
    checkKeys(problems, where, raw, ['from', 'key', 'owner']);
    oneOf(problems, `${where}.from`, raw.from, ['assumptions'], { label: '読み先' });
    const key = oneOf(problems, `${where}.key`, raw.key, ASSUMPTION_TEXT_KEYS, { label: '前提の値' });
    return { from: 'assumptions', key, owner: ownerOf(problems, `${where}.owner`, raw.owner) };
  }
  if (raw.slot !== undefined) {
    checkKeys(problems, where, raw, ['slot', 'owner', 'file', 'text']);
    const slot = idOf(problems, `${where}.slot`, raw.slot);
    if ((raw.file === undefined) === (raw.text === undefined)) problems.add(where, 'file か text の、どちらか 1 つだけを書いてください');
    return { slot, owner: ownerOf(problems, `${where}.owner`, raw.owner), file: raw.file, text: raw.text };
  }
  problems.add(where, 'from か slot のどちらかを書いてください');
  return null;
}

function parseParticipant(problems, where, raw) {
  if (!isPlainObject(raw)) {
    problems.add(where, `{ "id": …, "kind": … } の形で書いてください。kind: ${PARTICIPANT_KINDS.join(', ')}`);
    return null;
  }
  const kind = oneOf(problems, `${where}.kind`, raw.kind, PARTICIPANT_KINDS);
  const id = idOf(problems, `${where}.id`, raw.id);
  if (!kind) return null;
  checkKeys(problems, where, raw, PARTICIPANT_KEYS[kind]);
  const participant = {
    id,
    kind,
    label: text(problems, `${where}.label`, raw.label) ?? id,
    owner: ownerOf(problems, `${where}.owner`, raw.owner) ?? DEFAULT_OWNER,
  };
  if (kind === 'agent') {
    const pieces = list(problems, `${where}.prompt`, raw.prompt, { min: 1, max: COMPOSITION_LIMITS.maxPromptPieces, of: 'プロンプトの部品の' }) ?? [];
    participant.prompt = pieces
      .map((piece, i) => parsePromptPiece(problems, `${where}.prompt[${i}]`, piece))
      .filter(Boolean)
      .map((piece) => ({ ...piece, owner: piece.owner ?? participant.owner }));
    unique(problems, `${where}.prompt`, participant.prompt.map((piece) => piece.slot), '枠');
    participant.tools = [];
    if (raw.tools !== undefined) {
      const names = list(problems, `${where}.tools`, raw.tools, { max: COMPOSITION_LIMITS.maxParticipantTools, of: 'ツールの名前の' }) ?? [];
      participant.tools = names.map((name, i) => toolNameOf(problems, `${where}.tools[${i}]`, name)).filter(Boolean);
      unique(problems, `${where}.tools`, participant.tools, 'ツール');
    }
    participant.mock = raw.mock === undefined ? null : raw.mock;
  }
  if (kind === 'harness') {
    participant.ai = raw.ai;
    participant.returnTo = idOf(problems, `${where}.returnTo`, raw.returnTo, { required: false }) ?? null;
    // 固定の流れ(2.8)。書いた参加者にだけ項目を足す(今の構成の指紋と記録を変えないため。R2)
    Object.assign(participant, parseFlowParts(problems, where, raw));
  }
  if (kind === 'human') {
    participant.mock = null;
    if (raw.mock !== undefined) {
      if (!isPlainObject(raw.mock)) problems.add(`${where}.mock`, '{ "reply": 返事の文 } の形で書いてください');
      else {
        checkKeys(problems, `${where}.mock`, raw.mock, ['reply']);
        const reply = text(problems, `${where}.mock.reply`, raw.mock.reply, { required: true, max: SIM_LIMITS.maxText });
        if (reply !== undefined) participant.mock = { reply };
      }
    }
  }
  return participant;
}

function parseGuard(problems, where, raw) {
  if (!isPlainObject(raw)) {
    problems.add(where, '{ "id": …, "layer": "prompt" か "output", "on": 参加者, … } の形で書いてください');
    return null;
  }
  if (raw.layer === 'tool') {
    problems.add(`${where}.layer`, 'ツールの守りは、tools.json の各ツールの guards に書いてください');
    return null;
  }
  const layer = oneOf(problems, `${where}.layer`, raw.layer, COMPOSITION_GUARD_LAYERS, { label: '層' });
  const id = idOf(problems, `${where}.id`, raw.id);
  if (!layer) return null;
  checkKeys(problems, where, raw, GUARD_KEYS[layer]);
  const guard = { id, layer, owner: ownerOf(problems, `${where}.owner`, raw.owner) ?? DEFAULT_OWNER, on: idOf(problems, `${where}.on`, raw.on) };
  if (layer === 'prompt') guard.text = text(problems, `${where}.text`, raw.text, { required: true, max: SIM_LIMITS.maxText });
  if (layer === 'output') {
    // 持ち主が本番で持てない確かめは、記録だけ(enforce: false)にする。書かなければ止める
    guard.enforce = bool(problems, `${where}.enforce`, raw.enforce) ?? true;
    if (!isPlainObject(raw.rules) || Object.keys(raw.rules).length === 0) {
      problems.add(`${where}.rules`, `{ ${OUTPUT_RULE_KEYS.join('、')} のどれか } の形で書いてください`);
    } else {
      checkKeys(problems, `${where}.rules`, raw.rules, OUTPUT_RULE_KEYS);
      const rules = {};
      rules.noNewNumbers = bool(problems, `${where}.rules.noNewNumbers`, raw.rules.noNewNumbers) ?? false;
      rules.maxReplyChars = integer(problems, `${where}.rules.maxReplyChars`, raw.rules.maxReplyChars, { min: 1, max: AI_LIMITS.maxReplyChars }) ?? null;
      rules.forbidden = raw.rules.forbidden === undefined
        ? []
        : texts(problems, `${where}.rules.forbidden`, raw.rules.forbidden, { max: COMPOSITION_LIMITS.maxForbidden, maxChars: 50 });
      guard.rules = rules;
    }
  }
  return guard;
}

// この構成が前提を使うか。agent の参加者と、モデルを前提から読む harness の参加者が使う(今の harness の参加者は使わない。R2)
export const usesAssumptions = (composition) => composition.participants.some((p) => p.kind === 'agent' || p.model?.from === 'assumptions');

// 構成の形だけを検査する(ほかのファイルを指す所は crossCheck で確かめる)
function parseComposition(raw, problems) {
  if (!isPlainObject(raw)) {
    problems.add('', '全体を { … } のオブジェクトで書いてください');
    return null;
  }
  checkKeys(problems, '', raw, TOP_KEYS);
  formatVersion(problems, raw, COMPOSITION_FORMAT_VERSION);
  const composition = {
    formatVersion: COMPOSITION_FORMAT_VERSION,
    name: text(problems, 'name', raw.name) ?? null,
    driver: idOf(problems, 'driver', raw.driver),
    participants: [],
    tools: null,
    handoffs: [],
    guards: [],
    surface: null,
    assumptions: null,
    limits: { ...DEFAULT_LIMITS },
  };
  const participants = list(problems, 'participants', raw.participants, { min: 1, max: COMPOSITION_LIMITS.maxParticipants, of: '参加者の' }) ?? [];
  composition.participants = participants.map((item, i) => parseParticipant(problems, `participants[${i}]`, item)).filter(Boolean);
  unique(problems, 'participants', composition.participants.map((p) => p.id), '参加者の id');
  if (raw.tools !== undefined) composition.tools = raw.tools;

  if (raw.handoffs !== undefined) {
    const edges = list(problems, 'handoffs', raw.handoffs, { max: COMPOSITION_LIMITS.maxHandoffs, of: '辺の' }) ?? [];
    for (const [i, edge] of edges.entries()) {
      const where = `handoffs[${i}]`;
      if (!isPlainObject(edge)) {
        problems.add(where, '{ "from": 参加者, "to": 参加者, "carry": [値の名前] } の形で書いてください');
        continue;
      }
      checkKeys(problems, where, edge, ['from', 'to', 'carry']);
      const from = idOf(problems, `${where}.from`, edge.from);
      const to = idOf(problems, `${where}.to`, edge.to);
      if (from && from === to) problems.add(where, '自分への引き継ぎは書けません');
      let carry = [];
      if (edge.carry !== undefined) {
        carry = (list(problems, `${where}.carry`, edge.carry, { max: COMPOSITION_LIMITS.maxCarry, of: '値の名前の' }) ?? [])
          .map((key, j) => named(problems, `${where}.carry[${j}]`, key, KEY_PATTERN, { hint: '英字で始め、英数字と _ だけで 32 字まで' }))
          .filter(Boolean);
      }
      composition.handoffs.push({ from, to, carry });
    }
    unique(problems, 'handoffs', composition.handoffs.map((e) => `${e.from} → ${e.to}`), '辺');
  }

  // 委任の辺(マスターとサブ。2.9)。書いた構成にだけ、delegations と上限の項目を足す
  if (raw.delegations !== undefined) {
    composition.delegations = [];
    Object.assign(composition.limits, DEFAULT_DELEGATION_LIMITS);
    const edges = list(problems, 'delegations', raw.delegations, { min: 1, max: COMPOSITION_LIMITS.maxDelegationEdges, of: '委任の辺の' }) ?? [];
    for (const [i, edge] of edges.entries()) {
      const where = `delegations[${i}]`;
      if (!isPlainObject(edge)) {
        problems.add(where, '{ "from": 任せる参加者, "to": 任される参加者, "carry": [引数の名前], "history": true か false } の形で書いてください');
        continue;
      }
      checkKeys(problems, where, edge, ['from', 'to', 'carry', 'history']);
      const from = idOf(problems, `${where}.from`, edge.from);
      const to = idOf(problems, `${where}.to`, edge.to);
      if (from && from === to) problems.add(where, '自分への委任は書けません');
      let carry = [];
      if (edge.carry !== undefined) {
        carry = (list(problems, `${where}.carry`, edge.carry, { max: COMPOSITION_LIMITS.maxCarry, of: '引数の名前の' }) ?? [])
          .map((key, j) => named(problems, `${where}.carry[${j}]`, key, KEY_PATTERN, { hint: '英字で始め、英数字と _ だけで 32 字まで' }))
          .filter(Boolean);
        if (carry.includes('task')) problems.add(`${where}.carry`, '依頼の文(task)は、いつもサブに渡します。carry には書かないでください');
      }
      composition.delegations.push({ from, to, carry, history: bool(problems, `${where}.history`, edge.history) ?? false });
    }
    unique(problems, 'delegations', composition.delegations.map((e) => `${e.from} → ${e.to}`), '委任の辺');
  }

  if (raw.guards !== undefined) {
    const guards = list(problems, 'guards', raw.guards, { max: COMPOSITION_LIMITS.maxGuards, of: '守りの' }) ?? [];
    composition.guards = guards.map((item, i) => parseGuard(problems, `guards[${i}]`, item)).filter(Boolean);
    unique(problems, 'guards', composition.guards.map((g) => g.id), '守りの id');
  }

  if (raw.surface !== undefined) {
    if (!isPlainObject(raw.surface)) problems.add('surface', '{ "kind": "talk", "theme": … } の形で書いてください');
    else {
      checkKeys(problems, 'surface', raw.surface, ['kind', 'theme']);
      composition.surface = {
        kind: oneOf(problems, 'surface.kind', raw.surface.kind, SURFACE_KINDS, { label: '会話の枠' }),
        theme: oneOf(problems, 'surface.theme', raw.surface.theme, SURFACE_THEMES, { required: false, label: '見た目' }) ?? 'talk',
      };
    }
  }

  if (raw.assumptions !== undefined) {
    if (!isPlainObject(raw.assumptions)) problems.add('assumptions', '{ "dir": フォルダー, "default": 前提の id } の形で書いてください');
    else {
      checkKeys(problems, 'assumptions', raw.assumptions, ['dir', 'default']);
      composition.assumptions = {
        dir: raw.assumptions.dir === undefined ? DEFAULT_ASSUMPTIONS : appFolder(problems, 'assumptions.dir', raw.assumptions.dir),
        default: idOf(problems, 'assumptions.default', raw.assumptions.default),
      };
    }
  }

  if (raw.limits !== undefined) {
    if (!isPlainObject(raw.limits)) problems.add('limits', '{ "maxTurns": …, "maxHandoffs": … } の形で書いてください');
    else {
      const delegating = composition.delegations !== undefined;
      checkKeys(problems, 'limits', raw.limits, ['maxTurns', 'maxHandoffs', 'maxDelegations', 'maxDepth']);
      if (!delegating) {
        for (const key of ['maxDelegations', 'maxDepth']) {
          if (raw.limits[key] !== undefined) problems.add(`limits.${key}`, '委任の上限は、委任の辺(delegations)を書いた構成にだけ書けます');
        }
      }
      composition.limits = {
        maxTurns: integer(problems, 'limits.maxTurns', raw.limits.maxTurns, { min: 1, max: COMPOSITION_LIMITS.maxTurns }) ?? DEFAULT_LIMITS.maxTurns,
        maxHandoffs: integer(problems, 'limits.maxHandoffs', raw.limits.maxHandoffs, { min: 0, max: COMPOSITION_LIMITS.maxHandoffsPerConversation })
          ?? DEFAULT_LIMITS.maxHandoffs,
        ...(delegating
          ? {
              maxDelegations: integer(problems, 'limits.maxDelegations', raw.limits.maxDelegations, { min: 1, max: COMPOSITION_LIMITS.maxDelegationsPerTurn })
                ?? DEFAULT_DELEGATION_LIMITS.maxDelegations,
              maxDepth: integer(problems, 'limits.maxDepth', raw.limits.maxDepth, { min: 1, max: COMPOSITION_LIMITS.maxDelegationDepth }) ?? DEFAULT_DELEGATION_LIMITS.maxDepth,
            }
          : {}),
      };
    }
  }
  return composition;
}

// 構成が指すもの(参加者、ツール、辺、前提、モック、harness の設定、プロンプトの枠)が、あってつながっているかを確かめる
async function crossCheck(problems, composition, ctx) {
  const { appDir } = ctx;
  const byId = new Map(composition.participants.map((p) => [p.id, p]));
  const has = (id) => byId.has(id);
  const edge = (from, to) => composition.handoffs.some((e) => e.from === from && e.to === to);
  const delegations = composition.delegations ?? [];
  const delegationEdge = (from, to) => delegations.some((e) => e.from === from && e.to === to);
  // 任される参加者(サブ)。会話を回さないので、回し手にも、引き継ぎの行き先にもならない
  const subs = new Set(delegations.map((e) => e.to));
  const where = (participant) => `participants[${composition.participants.indexOf(participant)}]`;

  if (composition.driver && !has(composition.driver)) problems.add('driver', `「${composition.driver}」は participants にない参加者です`);

  for (const [i, e] of composition.handoffs.entries()) {
    if (e.from && !has(e.from)) problems.add(`handoffs[${i}].from`, `「${e.from}」は participants にない参加者です`);
    if (e.to && !has(e.to)) problems.add(`handoffs[${i}].to`, `「${e.to}」は participants にない参加者です`);
    if (subs.has(e.from) || subs.has(e.to)) problems.add(`handoffs[${i}]`, '任される参加者(delegations の to)は、会話を引き継げません。サブは結果を任せた参加者に返します');
  }

  for (const [i, e] of delegations.entries()) {
    for (const key of ['from', 'to']) {
      if (!e[key]) continue;
      if (!has(e[key])) problems.add(`delegations[${i}].${key}`, `「${e[key]}」は participants にない参加者です`);
      else if (byId.get(e[key]).kind !== 'agent') problems.add(`delegations[${i}].${key}`, '委任は agent の参加者どうしだけで書けます(固定の流れと人には任せられません)');
    }
  }
  if (composition.driver && subs.has(composition.driver)) problems.add('driver', '任される参加者(delegations の to)は回し手になれません');

  // ツールの宣言
  let toolset = null;
  if (composition.tools !== null) {
    const file = await appFile(problems, 'tools', composition.tools, appDir, { extensions: ['.json'] });
    if (file !== undefined) {
      composition.tools = file;
      toolset = ctx.toolsets.get(file) ?? null;
    }
  }
  const toolByName = new Map((toolset?.tools ?? []).map((tool) => [tool.name, tool]));

  // 前提
  const agents = composition.participants.filter((p) => p.kind === 'agent');
  let assumptions = [];
  if (composition.assumptions) {
    assumptions = ctx.assumptionsByDir.get(composition.assumptions.dir) ?? [];
    const found = assumptions.some((item) => item.assumption.id === composition.assumptions.default);
    if (composition.assumptions.default && !found) {
      problems.add('assumptions.default', `「${composition.assumptions.default}」は app/${composition.assumptions.dir}/ にない前提です`);
    }
  } else if (agents.length > 0) {
    problems.add('assumptions', 'agent の参加者がいるときは、前提の置き場所と既定の前提を書いてください');
  } else if (usesAssumptions(composition)) {
    problems.add('assumptions', 'harness の参加者のモデルを前提から読むときは、前提の置き場所と既定の前提を書いてください');
  }

  for (const participant of composition.participants) {
    const at = where(participant);
    if (participant.kind === 'agent') {
      if (participant.tools.length > 0 && composition.tools === null) problems.add(`${at}.tools`, '構成の tools で、ツールの宣言のファイルを指してください');
      for (const [i, name] of participant.tools.entries()) {
        const tool = toolByName.get(name);
        if (!tool) {
          if (toolset) problems.add(`${at}.tools[${i}]`, `「${name}」は app/${toolset.file} にないツールです`);
          continue;
        }
        // 引き継ぎのツールは、handoffs の辺にあるものだけ渡せる(辺にない引き継ぎは、ツールの守りが断るため、書いた時点で誤りにする)
        if (tool.do.op === 'handoff') {
          if (!has(tool.do.to)) problems.add(`${at}.tools[${i}]`, `引き継ぎのツール「${name}」の行き先「${tool.do.to}」は participants にない参加者です`);
          else if (!edge(participant.id, tool.do.to)) {
            problems.add(`${at}.tools[${i}]`, `引き継ぎのツール「${name}」は辺にありません。handoffs に { "from": "${participant.id}", "to": "${tool.do.to}" } を書いてください`);
          }
        }
        // 委任のツールも、delegations の辺にあるものだけ渡せる
        if (tool.do.op === 'delegate') {
          if (!has(tool.do.to)) problems.add(`${at}.tools[${i}]`, `委任のツール「${name}」の任せる先「${tool.do.to}」は participants にない参加者です`);
          else if (!delegationEdge(participant.id, tool.do.to)) {
            problems.add(`${at}.tools[${i}]`, `委任のツール「${name}」は辺にありません。delegations に { "from": "${participant.id}", "to": "${tool.do.to}" } を書いてください`);
          }
        }
      }
      if (participant.mock !== null) {
        const file = await appFile(problems, `${at}.mock`, participant.mock, appDir, { extensions: ['.json'] });
        const mock = file === undefined ? null : ctx.mocks.get(file);
        if (file !== undefined) participant.mock = file;
        for (const [i, rule] of (mock?.rules ?? []).entries()) {
          if (rule.call?.tool && !participant.tools.includes(rule.call.tool)) {
            problems.add(`${at}.mock`, `app/${file} の rules[${i}] が呼ぶ「${rule.call.tool}」は、この参加者の tools にありません`);
          }
          if (rule.when?.delegated !== undefined && !delegationEdge(participant.id, rule.when.delegated)) {
            problems.add(`${at}.mock`, `app/${file} の rules[${i}] の delegated「${rule.when.delegated}」は、この参加者が任せる先(delegations の to)ではありません`);
          }
        }
      }
      for (const [i, piece] of participant.prompt.entries()) {
        if (piece.slot === undefined) {
          if (piece.from === 'assumptions' && composition.assumptions) {
            const missing = assumptions.filter((item) => typeof item.assumption[piece.key] !== 'string').map((item) => item.assumption.id);
            if (missing.length > 0) problems.add(`${at}.prompt[${i}].key`, `前提 ${missing.join('、')} に「${piece.key}」がありません`);
          }
          continue;
        }
        await checkSlot(problems, `${at}.prompt[${i}]`, piece, assumptions, appDir, ctx.prompts);
      }
    }
    if (participant.kind === 'harness') {
      const file = participant.ai === undefined
        ? (ctx.defaultAi ?? AI_FILE)
        : await appFile(problems, `${at}.ai`, participant.ai, appDir, { extensions: ['.json'] });
      // 検査で通らなかったパスは、ほかの確かめ(carry)でも読まない
      participant.ai = file ?? null;
      if (file !== undefined && (await ctx.aiOf(file)) === undefined) problems.add(`${at}.ai`, `app/${file} がありません`);
      if (participant.returnTo) {
        if (!has(participant.returnTo)) problems.add(`${at}.returnTo`, `「${participant.returnTo}」は participants にない参加者です`);
        else if (!edge(participant.id, participant.returnTo)) {
          problems.add(`${at}.returnTo`, `戻るのも引き継ぎです。handoffs に { "from": "${participant.id}", "to": "${participant.returnTo}" } を書いてください`);
        }
      }
      if (file !== undefined) await checkFlowParts(problems, at, participant, { definition: await ctx.aiOf(file), composition, toolset, toolByName, byId, edge });
    }
  }

  // 委任で渡す値(carry)は、その辺の委任のツールの引数だけ。委任のツールのない辺は、使われない辺として誤りにする
  for (const [i, e] of delegations.entries()) {
    const from = byId.get(e.from);
    if (from?.kind !== 'agent') continue;
    const tools = from.tools.map((name) => toolByName.get(name)).filter((tool) => tool?.do.op === 'delegate' && tool.do.to === e.to);
    if (tools.length === 0) {
      problems.add(`delegations[${i}]`, `「${e.from}」の tools に、「${e.to}」へ任せる委任のツール(op: delegate)がありません`);
      continue;
    }
    for (const key of e.carry) {
      if (!tools.some((tool) => Object.hasOwn(tool.inputSchema?.properties ?? {}, key))) {
        problems.add(`delegations[${i}].carry`, `「${key}」は「${e.to}」へ任せる委任のツールの引数にありません`);
      }
    }
  }

  // 委任の深さ。任される参加者でないもの(回し手と引き継ぎの行き先)を 0 とし、辺をたどった一番浅い深さを数える。
  // 任せた先の深さが limits.maxDepth を超える辺は、ツールの口がいつも断るので、使われない辺として誤りにする
  if (delegations.length > 0) {
    const depthOf = new Map(composition.participants.filter((p) => !subs.has(p.id)).map((p) => [p.id, 0]));
    for (let changed = true; changed;) {
      changed = false;
      for (const e of delegations) {
        const from = depthOf.get(e.from);
        if (from === undefined) continue;
        if (!depthOf.has(e.to) || depthOf.get(e.to) > from + 1) {
          depthOf.set(e.to, from + 1);
          changed = true;
        }
      }
    }
    for (const [i, e] of delegations.entries()) {
      const from = depthOf.get(e.from);
      if (from === undefined) problems.add(`delegations[${i}]`, `「${e.from}」は、回し手からたどれない参加者です。この辺は使われません`);
      else if (from + 1 > composition.limits.maxDepth) {
        problems.add(`delegations[${i}]`, `この辺の委任は深さ ${from + 1} で、limits.maxDepth(${composition.limits.maxDepth})を超えます。使われない辺なので、外すか limits.maxDepth を上げてください`);
      }
    }
  }

  // 受け渡す値は、受け取る harness の ai.json の項目だけ
  for (const [i, e] of composition.handoffs.entries()) {
    const target = byId.get(e.to);
    if (target?.kind !== 'harness' || !target.ai || e.carry.length === 0) continue;
    const ai = await ctx.aiOf(target.ai);
    if (!ai) continue;
    for (const key of e.carry) {
      if (!ai.fields.some((field) => field.key === key)) problems.add(`handoffs[${i}].carry`, `「${key}」は app/${target.ai} の fields にない項目です`);
    }
  }

  for (const [i, guard] of composition.guards.entries()) {
    if (!guard.on) continue;
    const target = byId.get(guard.on);
    if (!target) problems.add(`guards[${i}].on`, `「${guard.on}」は participants にない参加者です`);
    else if (target.kind !== 'agent') problems.add(`guards[${i}].on`, '構成の guards は agent の参加者にだけ付けられます(harness の出口の確かめは ai.json の rules に書きます)');
  }
}

// プロンプトの枠の文。前提が決める長さを超えたら、切らずに誤りにする(長さの違いで結果が変わったことを隠さないため。3.4)
// 検査を通った枠の文は prompts(ファイルの名前 → 文)に入れる。会話の進め方がプロンプトを組むときに使う
async function checkSlot(problems, where, piece, assumptions, appDir, prompts) {
  let body = piece.text;
  if (piece.file !== undefined) {
    const file = await appFile(problems, `${where}.file`, piece.file, appDir, { extensions: PROMPT_EXTENSIONS });
    if (file === undefined) return;
    piece.file = file;
    const read = await readAppText(appDir, file, SIM_LIMITS.maxPromptChars * 4);
    if (read.error) {
      problems.add(`${where}.file`, `app/${file}: ${read.error}`);
      return;
    }
    body = read.text;
  }
  if (typeof body !== 'string' || body.trim() === '') {
    problems.add(where, '枠の文を空でない文字列で書いてください');
    return;
  }
  if (body.length > SIM_LIMITS.maxPromptChars) {
    problems.add(where, `枠「${piece.slot}」の文が長すぎます(${body.length} 文字。上限 ${SIM_LIMITS.maxPromptChars} 文字)`);
    return;
  }
  for (const { assumption } of assumptions) {
    const max = assumption.slots[piece.slot]?.maxChars;
    if (max !== undefined && body.length > max) {
      problems.add(where, `枠「${piece.slot}」の文が、前提「${assumption.id}」の上限を超えています(${body.length} 文字。上限 ${max} 文字)`);
      return;
    }
  }
  if (piece.file !== undefined) prompts?.set(piece.file, body);
}

// composition.json のない試作品の構成(構成 B)。ai.json の harness 1 つが会話を回す。ai.json もなければ null(AI のない試作品)
export function compositionB(ai, aiFile = AI_FILE) {
  if (!ai) return null;
  return {
    formatVersion: COMPOSITION_FORMAT_VERSION,
    name: ai.name,
    driver: 'main',
    participants: [{ id: 'main', kind: 'harness', label: ai.name, owner: DEFAULT_OWNER, ai: aiFile, returnTo: null }],
    tools: null,
    handoffs: [],
    guards: [],
    surface: null,
    assumptions: null,
    limits: { ...DEFAULT_LIMITS },
    // 読み替えた構成には、構成のファイルがない
    file: null,
  };
}

async function readComposition(appDir, file, ctx) {
  const problems = new Problems(`app/${file}`);
  const { value, error } = await readAppJson(appDir, file);
  if (error) {
    problems.add('', error);
    return { composition: null, errors: problems.list };
  }
  const composition = parseComposition(value, problems);
  if (composition && problems.list.length === 0) await crossCheck(problems, composition, ctx);
  if (problems.list.length > 0) return { composition: null, errors: problems.list };
  return { composition: { ...composition, file }, errors: [] };
}

// 構成、ツール、前提、モック、場面を読み、全部を検査する(関門 G3)。
// manifest は検査済みの目録、ai は検査済みの目録の ai の設定(なければ null)。
// 返す composition は既定の構成(composition.json。なければ構成 B の読み替え。AI もなければ null)。
// 誤りがあれば errors に入れ、ほかは空にして返す
export async function readSimulation(appDir, manifest, ai) {
  const errors = [];
  const defaultFile = manifest.composition !== undefined
    ? manifest.composition
    : ((await kindOf(appDir, DEFAULT_COMPOSITION)) === 'none' ? null : DEFAULT_COMPOSITION);
  const listed = await listJsonFiles(appDir, manifest.compositions ?? DEFAULT_COMPOSITIONS, { max: COMPOSITION_LIMITS.maxCompositions, label: '構成' });
  errors.push(...listed.errors);
  const compositionFiles = [...new Set([defaultFile, ...listed.files].filter(Boolean))];

  // 構成の形を先に読み、どのツール、前提、モックのファイルを読むかを集める
  const raws = [];
  for (const file of compositionFiles) {
    const { value } = await readAppJson(appDir, file);
    raws.push(isPlainObject(value) ? value : {});
  }
  // 検査の前の値なので、app/ の中を指す形のものだけを、検査の後と同じ形にそろえて使う(ほかは構成の検査が誤りにする)
  const inside = (relative) => {
    if (typeof relative !== 'string' || /[\\\0]/.test(relative) || /^([/]|[A-Za-z]:)/.test(relative) || relative.split('/').includes('..')) return null;
    const normalized = path.posix.normalize(relative).replace(/\/$/, '');
    return normalized === '.' || normalized === '' ? null : normalized;
  };
  const jsonInside = (relative) => (inside(relative)?.endsWith('.json') ? inside(relative) : null);

  // 構成のファイルが 1 つもない試作品(構成 B)では、既定の場所の tools.json、assumptions/、mocks/ を読まない。
  // 今の試作品が、画面のデータとして同じ名前のファイルを使っていることがあるため(R2)
  const simulated = compositionFiles.length > 0;
  const toolsets = new Map();
  const toolFiles = new Set(raws.map((raw) => jsonInside(raw.tools)).filter(Boolean));
  if (simulated && (await kindOf(appDir, TOOLS_FILE)) === 'file') toolFiles.add(TOOLS_FILE);
  for (const file of [...toolFiles].sort()) {
    if ((await kindOf(appDir, file)) !== 'file') continue;
    const read = await readTools(appDir, file);
    errors.push(...read.errors);
    if (read.toolset) toolsets.set(file, read.toolset);
  }
  const toolNames = new Set([...toolsets.values()].flatMap((toolset) => toolset.tools.map((tool) => tool.name)));
  // ツールが読む架空のデータ。会話の進め方が、モックの模擬のエージェントのツールの呼び出し(同じプロセスの中のツールの口)に使う
  const toolData = new Map();
  for (const [file, toolset] of toolsets) {
    const loaded = await loadToolData(appDir, toolset);
    errors.push(...loaded.errors.map((error) => ({ ...error, file: `app/${file}` })));
    toolData.set(file, loaded.data);
  }

  const assumptionsByDir = new Map();
  const dirs = new Set(simulated ? [DEFAULT_ASSUMPTIONS] : []);
  for (const raw of raws) {
    const dir = isPlainObject(raw.assumptions) ? inside(raw.assumptions.dir) : null;
    if (dir) dirs.add(dir);
  }
  for (const dir of [...dirs].sort()) {
    const read = await readAssumptions(appDir, dir, { toolNames });
    errors.push(...read.errors);
    assumptionsByDir.set(dir, read.assumptions);
  }

  const mockFiles = raws.flatMap((raw) => (Array.isArray(raw.participants) ? raw.participants : []))
    .map((p) => (isPlainObject(p) && p.kind === 'agent' ? jsonInside(p.mock) : null))
    .filter(Boolean);
  const existingMocks = [];
  for (const file of mockFiles) if ((await kindOf(appDir, file)) === 'file') existingMocks.push(file);
  const mockRead = simulated ? await readMocks(appDir, DEFAULT_MOCKS, existingMocks) : { mocks: new Map(), errors: [] };
  errors.push(...mockRead.errors);

  // harness の参加者の ai.json。目録の ai は検査済みのものを使う。ほかは読んで検査する
  const aiCache = new Map(manifest.ai ? [[manifest.ai, ai]] : []);
  const aiOf = async (file) => {
    // 検査を通った app/ の中のパスだけを読む(念のため、ここでも app/ の外を指すものは読まない)
    if (inside(file) !== file) return undefined;
    if (!aiCache.has(file)) {
      const read = await readAiDefinition(appDir, file);
      errors.push(...read.errors);
      const exists = read.definition !== null || read.errors.length > 0;
      aiCache.set(file, exists ? read.definition : undefined);
    }
    return aiCache.get(file);
  };

  const prompts = new Map();
  const ctx = { appDir, toolsets, assumptionsByDir, mocks: mockRead.mocks, aiOf, defaultAi: manifest.ai, prompts };
  let composition = null;
  const compositions = [];
  for (const file of compositionFiles) {
    const read = await readComposition(appDir, file, ctx);
    errors.push(...read.errors);
    if (!read.composition) continue;
    if (file === defaultFile) composition = read.composition;
    else compositions.push({ file, composition: read.composition });
  }

  const evalRead = await readEvals(appDir, manifest.evals ?? DEFAULT_EVALS, { toolNames });
  errors.push(...evalRead.errors);

  if (errors.length > 0) return { simulation: null, errors: dedupe(errors) };
  return {
    simulation: {
      composition: defaultFile ? composition : compositionB(ai, manifest.ai ?? AI_FILE),
      compositions,
      tools: Object.fromEntries(toolsets),
      toolData: Object.fromEntries(toolData),
      // プロンプトの枠の文(ファイルの名前 → 文)。検査を通ったものだけ
      prompts: Object.fromEntries(prompts),
      assumptions: [...assumptionsByDir.values()].flat(),
      mocks: [...mockRead.mocks.values()],
      evals: evalRead.evals,
      // harness の参加者が使う ai.json のうち、目録の ai でないもの(目録の ai は build の ai で返す)。変化の説明で比べる
      harnessAis: Object.fromEntries([...aiCache].filter(([file, definition]) => file !== manifest.ai && definition)),
    },
    errors: [],
  };
}

function dedupe(errors) {
  const seen = new Set();
  return errors.filter((error) => {
    const key = `${error.file}\n${error.text}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
