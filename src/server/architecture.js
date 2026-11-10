import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { designTableShelfId } from './data-design.js';
import { judgeRag, shelfFromApp } from './data-shelf.js';
import { DEFAULT_ASSUMPTIONS } from './sim/assumptions.js';
import { compositionShape } from './sim/composition.js';

// AI 構成の審査の中身と、AI 構成書の指紋(docs/design/ai-architecture-review.md の 1、4、6 節)。
// 中身はどれも、今のファイルと場面の回しの結果から Studio のコードが書く。案を出す AI に書かせない(作り話の数と部品を防ぐ)。
// ファイルを読むだけで、書かない。外へ通信しない。

const OPTIONS = JSON.parse(fs.readFileSync(new URL('./review/options.json', import.meta.url), 'utf8'));
export const COMPOSITION_CHOICES = OPTIONS.compositions;
export const STACK_ROWS = OPTIONS.stack.rows;
export const STACK_NOTE = OPTIONS.stack.note;

// 審査の 4 つ(審査の項目そのものはコード。5 節の表の「要る」)
export const REVIEW_ITEMS = [
  { id: 'composition', label: 'エージェントの構成', plain: '誰が会話を回すか。どの形なら足りるか' },
  { id: 'harness', label: 'harness', plain: 'AI の周りで決まりを守らせるコード。何をモデルに任せ、何をコードで縛るか' },
  { id: 'data', label: 'データと RAG', plain: 'AI が何をどう読むか。RAG が要るか' },
  { id: 'stack', label: '技術の組', plain: '試作品で使うものと、本番の候補' },
];
export const REVIEW_ITEM_IDS = REVIEW_ITEMS.map((item) => item.id);

// 承認する役(9 節)。1 人で使うときは本人。会の中では、お客さんとの約束を変える harness とデータと RAG は 2 人
export const ROLE_LABELS = { owner: '本人', facilitator: '進行役', decider: '決める人' };
export function approvalNeeds(mode) {
  if (mode !== 'meeting') return Object.fromEntries(REVIEW_ITEM_IDS.map((item) => [item, ['owner']]));
  return { composition: ['facilitator'], harness: ['facilitator', 'decider'], data: ['facilitator', 'decider'], stack: ['facilitator'] };
}

// 構成の形の名前。handoff と none は選択肢にない(今の構成をそのまま見せる)
export const SHAPE_LABELS = {
  ...Object.fromEntries(COMPOSITION_CHOICES.map((choice) => [choice.id, choice.label])),
  handoff: 'AI 同士の引き継ぎ(今の構成。選択肢にはない)',
  none: 'AI なし',
};

const sha = (text) => crypto.createHash('sha256').update(text).digest('hex');
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
// 目録と構成の指し先は、読み込み(manifest.js の appPath)と同じく、前後の空白を削らずにそのまま使う。
// 削ると、「 ai.json」のように空白を足した指し先へ向け直しても指紋が変わらない
const raw = (value) => (typeof value === 'string' && value.trim() ? value : null);
const list = (value) => (Array.isArray(value) ? value : []);
const clip = (value, max) => String(value ?? '').slice(0, max);

// app/ からの相対のパスか。外を指すもの、絶対パス、\ を含むものは使わない(読まずに印だけ付ける)
function relativeInside(relative) {
  if (typeof relative !== 'string' || !relative || relative.length > 300) return null;
  if (relative.includes('\\') || path.isAbsolute(relative) || relative.includes('\0')) return null;
  const parts = relative.split('/').filter((part) => part !== '' && part !== '.');
  if (parts.length === 0 || parts.includes('..')) return null;
  return parts.join('/');
}

// ファイル 1 つの指紋。ないこと、ふつうのファイルでないこと、app/ の外へ出ることも指紋に入れる(6 節)。シンボリックリンクはたどらない
async function hashAppFile(appDir, relative) {
  const inside = relativeInside(relative);
  if (!inside) return 'invalid';
  const full = path.join(appDir, inside);
  const stat = await fsp.lstat(full).catch(() => null);
  if (!stat) return 'absent';
  if (stat.isSymbolicLink()) return 'symlink';
  if (!stat.isFile()) return 'other';
  const [realApp, realFile] = await Promise.all([fsp.realpath(appDir), fsp.realpath(full)]).catch(() => [null, null]);
  if (!realApp || !realFile || !realFile.startsWith(`${realApp}${path.sep}`)) return 'outside';
  const content = await fsp.readFile(full).catch(() => null);
  return content ? crypto.createHash('sha256').update(content).digest('hex') : 'unreadable';
}

async function readRawJson(appDir, relative) {
  const inside = relativeInside(relative);
  if (!inside) return null;
  try {
    const stat = await fsp.lstat(path.join(appDir, inside));
    if (!stat.isFile()) return null;
    return JSON.parse(await fsp.readFile(path.join(appDir, inside), 'utf8'));
  } catch {
    return null;
  }
}

async function jsonFilesIn(appDir, folder) {
  const inside = relativeInside(folder);
  if (!inside) return [];
  const stat = await fsp.lstat(path.join(appDir, inside)).catch(() => null);
  if (!stat?.isDirectory()) return [];
  const names = await fsp.readdir(path.join(appDir, inside)).catch(() => []);
  return names.filter((name) => name.endsWith('.json')).sort().map((name) => `${inside}/${name}`);
}

// 審査の項目ごとに、指紋に入れるファイル(6 節)。目録の全体は入れず、指し先(composition、ai)の値だけを入れる。
// 画面のソース、架空のデータの中身、モック、場面は入れない(作る AI が普通に直すもの)
export async function architectureFiles(appDir) {
  const manifest = await readRawJson(appDir, 'prototype.json');
  // 指し先の値は、文字列でなくてもそのまま指紋に入れる(形の誤りは G3 が落とす)
  const pointers = { composition: manifest?.composition ?? null, ai: manifest?.ai ?? null };
  const compositionFile = raw(pointers.composition) ?? 'composition.json';
  const composition = await readRawJson(appDir, compositionFile);
  const aiDefault = raw(pointers.ai) ?? 'ai.json';
  const aiFiles = new Set();
  const promptFiles = new Set();
  let toolsFile = null;
  let assumptionFiles = [];
  if (isObject(composition)) {
    toolsFile = raw(composition.tools) ?? 'tools.json';
    const participants = list(composition.participants);
    for (const participant of participants) {
      if (participant?.kind === 'harness') aiFiles.add(raw(participant.ai) ?? aiDefault);
      for (const piece of list(participant?.prompt)) if (raw(piece?.file)) promptFiles.add(piece.file);
    }
    const usesAssumptions = participants.some((p) => p?.kind === 'agent' || p?.model?.from === 'assumptions');
    if (usesAssumptions || isObject(composition.assumptions)) assumptionFiles = await jsonFilesIn(appDir, raw(composition.assumptions?.dir) ?? DEFAULT_ASSUMPTIONS);
  } else {
    // 構成のない試作品(構成 B)。ai.json の harness 1 つが会話を回す
    aiFiles.add(aiDefault);
  }
  const unique = (items) => [...new Set(items.filter(Boolean))].sort();
  return {
    pointers,
    items: {
      composition: unique([compositionFile]),
      harness: unique([compositionFile, ...aiFiles, toolsFile, ...promptFiles]),
      data: unique([toolsFile]),
      stack: unique(assumptionFiles),
    },
  };
}

// AI 構成書の指紋。項目ごとの指紋と、全体の指紋。構成と harness には目録の指し先の値も入れる
// (compositions/c.json へ向け直すだけで関門 GA を通れないようにするため)
export async function architectureFingerprint(appDir) {
  const { pointers, items } = await architectureFiles(appDir);
  // pointers は承認した構成に戻すとき(review.js の restore)に、目録の指し先を戻すのに使う
  const result = { algorithm: 'sha256', value: null, pointers, items: {} };
  for (const id of REVIEW_ITEM_IDS) {
    const files = items[id];
    const hashes = [];
    for (const file of files) hashes.push([file, await hashAppFile(appDir, file)]);
    const withPointers = id === 'composition' || id === 'harness';
    result.items[id] = { digest: sha(JSON.stringify({ ...(withPointers ? { pointers } : {}), files: hashes })), files };
  }
  result.value = sha(REVIEW_ITEM_IDS.map((id) => `${id}:${result.items[id].digest}`).join('\n'));
  return result;
}

// 指紋が変わった項目
export const changedItems = (before, after) => REVIEW_ITEM_IDS.filter((id) => before?.items?.[id]?.digest !== after?.items?.[id]?.digest);

// 場面の一覧の指紋。変わっても止めず、数を「古い」と出す(4 節)
export function evalsDigest(simulation) {
  const evals = (simulation?.evals ?? []).map((item) => ({ id: item.scenario?.id ?? null, scenario: item.scenario ?? null })).sort((a, b) => String(a.id).localeCompare(String(b.id)));
  return sha(JSON.stringify(evals));
}

// ---- 1. エージェントの構成 ----

// 構成の図(人、AI、ツールの箱と矢印)。画面が SVG で描く。kind は person、ai、code、tool
export function compositionFigure(simulation, ai = null) {
  const composition = simulation?.composition;
  if (!composition) return { nodes: [{ id: 'user', kind: 'person', label: '使う人' }], edges: [] };
  const nodes = [{ id: 'user', kind: 'person', label: '使う人' }];
  const edges = [];
  const toolsets = Object.values(simulation.tools ?? {});
  const toolOf = (name) => toolsets.flatMap((set) => set.tools ?? []).find((tool) => tool.name === name) ?? null;
  const driver = composition.participants.find((p) => p.id === composition.driver) ?? composition.participants[0];
  for (const participant of composition.participants) {
    if (participant.kind === 'human') nodes.push({ id: participant.id, kind: 'person', label: participant.label });
    else if (participant.kind === 'harness') {
      nodes.push({ id: participant.id, kind: 'code', label: `${participant.label}(コードの流れ)` });
      nodes.push({ id: `${participant.id}-model`, kind: 'ai', label: 'AI(読み取りと言い方だけ)' });
      edges.push({ from: participant.id, to: `${participant.id}-model`, label: '読み取りを頼む' });
    } else nodes.push({ id: participant.id, kind: 'ai', label: participant.label });
  }
  if (driver) edges.unshift({ from: 'user', to: driver.id, label: '話しかける' });
  const seenTools = new Set();
  for (const participant of composition.participants) {
    // 固定の流れでは、流れの段(flow)の calls のツールをコードが呼ぶ(agent-simulation.md の 2.8)
    const names = participant.kind === 'agent' ? participant.tools ?? [] : list(participant.flow).flatMap((entry) => list(entry?.calls).map((call) => call?.tool)).filter((name) => typeof name === 'string');
    for (const name of names) {
      const tool = toolOf(name);
      if (tool?.do?.op === 'delegate' || tool?.do?.op === 'handoff') continue;
      const id = `tool:${name}`;
      if (!seenTools.has(id)) nodes.push({ id, kind: 'tool', label: `ツール ${name}` });
      seenTools.add(id);
      edges.push({ from: participant.id, to: id, label: participant.kind === 'harness' ? 'コードが呼ぶ' : '選んで呼ぶ' });
    }
  }
  for (const edge of composition.delegations ?? []) edges.push({ from: edge.from, to: edge.to, label: '仕事を任せる' });
  for (const edge of composition.handoffs ?? []) edges.push({ from: edge.from, to: edge.to, label: '引き継ぐ' });
  for (const participant of composition.participants) {
    for (const item of participant.escalate ?? []) {
      if (!nodes.some((node) => node.id === item.to)) nodes.push({ id: item.to, kind: 'person', label: '担当の人' });
      edges.push({ from: participant.id, to: item.to, label: '条件で人に渡す' });
    }
  }
  if (ai && !composition.file && nodes.length === 1) nodes.push({ id: 'desk', kind: 'code', label: 'AI の設定の流れ' });
  return { nodes, edges };
}

const median = (values) => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

// 場面の回しの結果(新しい順)から、その形の数を読む(4 節)。回していなければ null(「まだ測っていない」)。
// 場面の一覧が回したときと違えば stale(古い)。モックの数は「お試しの AI で回した。形の確かめだけ」で、案の順位に使わない
export function metricsFor(results, shape, sceneIds) {
  for (const result of results) {
    const group = (result.groups ?? []).find((item) => item.composition?.shape === shape && (item.evals ?? []).length > 0);
    if (!group) continue;
    const evals = group.evals;
    const summary = group.summary ?? {};
    const conversations = evals.length;
    const replyMs = evals.flatMap((item) => (item.turns ?? []).map((turn) => turn.ms)).filter(Number.isFinite);
    const ran = new Set(evals.map((item) => item.id));
    const now = new Set(sceneIds);
    const stale = ran.size !== now.size || [...now].some((id) => !ran.has(id));
    return {
      runId: result.id,
      measuredAt: result.finishedAt ?? result.startedAt ?? null,
      connection: group.connection,
      real: Boolean(group.real),
      model: group.assumption?.model ?? null,
      round: group.round ?? 1,
      passed: evals.filter((item) => item.verdict === 'passed').length,
      decided: evals.filter((item) => item.verdict === 'passed' || item.verdict === 'failed').length,
      total: conversations,
      toolRecall: summary.toolRecall ?? null,
      wrongCalls: summary.wrongCalls ?? 0,
      toolCalls: summary.tools?.calls ?? evals.reduce((n, item) => n + (item.calls?.count ?? 0), 0),
      costPerConversationUsd: group.real && conversations > 0 ? evals.reduce((sum, item) => sum + (item.costUsd ?? 0), 0) / conversations : null,
      medianReplySeconds: replyMs.length > 0 ? Math.round(median(replyMs) / 10) / 100 : null,
      scenes: evals.map((item) => ({ id: item.id, verdict: item.verdict })),
      stale,
    };
  }
  return null;
}

// ---- 2. harness ----

const DECIDERS = { code: 'コード', model: 'モデル', human: '人' };

// プロンプトの全文(読むためのもの)。agent の参加者は前提の文と枠、harness の参加者は AI の設定の指示
export function promptTexts(simulation, ai = null, aiOf = () => null) {
  const composition = simulation?.composition;
  const texts = [];
  if (!composition) return texts;
  const assumption = (simulation.assumptions ?? []).find((item) => item.assumption?.id === composition.assumptions?.default)?.assumption ?? null;
  for (const participant of composition.participants) {
    if (participant.kind === 'agent') {
      const pieces = (participant.prompt ?? []).map((piece) => {
        if (piece.from === 'assumptions') return `[前提の ${piece.key}]\n${assumption?.[piece.key] ?? '(前提が読めません)'}`;
        const body = piece.file ? simulation.prompts?.[piece.file] : piece.text;
        return `[枠 ${piece.slot}${piece.file ? `(${piece.file})` : ''}]\n${body ?? '(読めません)'}`;
      });
      texts.push({ participant: participant.id, label: participant.label, text: clip(pieces.join('\n\n'), 12_000) });
    } else if (participant.kind === 'harness') {
      const definition = (participant.ai ? aiOf(participant.ai) : null) ?? ai;
      texts.push({ participant: participant.id, label: participant.label, text: clip(definition?.instructions ?? '(AI の設定に指示の文がありません)', 12_000) });
    }
  }
  return texts;
}

function toolLines(simulation) {
  const lines = [];
  for (const [file, toolset] of Object.entries(simulation?.tools ?? {})) {
    for (const tool of toolset.tools ?? []) {
      const guards = Object.keys(tool.guards ?? {});
      const op = tool.do?.op;
      const what = { search: '探す(読むだけ)', get: '1 件を引く(読むだけ)', record: '記録に書く', fixed: '決まった値を返す', handoff: `「${tool.do?.to}」に引き継ぐ`, delegate: `「${tool.do?.to}」に仕事を任せる`, retrieve: '文書を探して読む(読むだけ)' }[op] ?? op;
      lines.push({ name: tool.name, file, op, what, guards, text: `${tool.name}: ${what}${guards.length > 0 ? `。守り: ${guards.join('、')}` : ''}` });
    }
  }
  return lines;
}

// 出口の確かめの決まりの、平たい言葉。値のある決まりだけを出す
const OUTPUT_RULE_WORDS = { noNewNumbers: '数字を作らない', maxReplyChars: '返事の長さの上限', forbidden: '禁止の言葉' };
const outputRuleTexts = (rules) => Object.entries(rules ?? {})
  .filter(([, value]) => (Array.isArray(value) ? value.length > 0 : Boolean(value)))
  .map(([key, value]) => (key === 'maxReplyChars' ? `返事は ${value} 文字まで` : key === 'forbidden' ? `禁止の言葉 ${value.length} 個` : OUTPUT_RULE_WORDS[key] ?? key));
const sentence = (text) => String(text ?? '').replace(/[。.]+$/, '');

const whenText = (when) => {
  if (!when) return '条件なし';
  if (when.unreadAfter) return `「${when.unreadAfter.field}」を ${when.unreadAfter.times} 回読めなかったら`;
  if (when.toolFailed) return `ツール ${when.toolFailed.tool ?? when.toolFailed} が失敗したら`;
  if (when.fieldIs) return `「${when.fieldIs.field}」が決まった値なら`;
  if (when.resultIs) return 'ツールの結果が決まった値なら';
  return '決まった条件で';
};

// harness の表(想像図の 2)。列は部品、この案での中身、決めるのは(コード / モデル / 人)、今の Studio にあるか。
// modelOnly はコードで縛れず、モデルに頼るしかない行(1 節の「モデル頼み」の印)
export function harnessRows({ simulation, ai = null, aiOf = () => null, evalsCount = 0 }) {
  const composition = simulation?.composition ?? null;
  const shape = compositionShape(composition);
  const participants = composition?.participants ?? [];
  const harness = participants.filter((p) => p.kind === 'harness');
  const definitionOf = (participant) => (participant.ai ? aiOf(participant.ai) : null) ?? ai;
  const tools = toolLines(simulation);
  const guards = composition?.guards ?? [];
  const promptGuards = guards.filter((g) => g.layer === 'prompt');
  const outputGuards = guards.filter((g) => g.layer === 'output' && outputRuleTexts(g.rules).length > 0);
  const toolGuards = tools.filter((tool) => tool.guards.length > 0);
  const outputRules = harness.flatMap((p) => {
    const rules = definitionOf(p)?.rules ?? {};
    return [rules.noNewNumbers ? '数字を作らない' : null, rules.maxReplyChars ? `返事は ${rules.maxReplyChars} 文字まで` : null, (rules.forbidden ?? []).length > 0 ? `禁止の言葉 ${rules.forbidden.length} 個` : null].filter(Boolean);
  });
  const escalates = harness.flatMap((p) => (p.escalate ?? []).map((item) => `${item.id}: ${whenText(item.when)}、${item.to} に渡す`));
  const handoffTools = tools.filter((tool) => tool.op === 'handoff');
  const limits = composition?.limits ?? {};
  const limitTexts = [
    limits.maxTurns ? `1 つの会話は ${limits.maxTurns} ターンまで` : null,
    limits.maxHandoffs !== undefined ? `引き継ぎは ${limits.maxHandoffs} 回まで` : null,
    limits.maxDelegations !== undefined ? `1 ターンの委任は ${limits.maxDelegations} 回まで、深さ ${limits.maxDepth}` : null,
    ...tools.filter((tool) => tool.guards.includes('maxCallsPerConversation')).map((tool) => `${tool.name} は会話ごとに回数の上限あり`),
  ].filter(Boolean);
  const fields = harness.flatMap((p) => (definitionOf(p)?.fields ?? []).map((field) => field.label ?? field.key));
  const turn = {
    'fixed-flow': ['コードが流れの段を順に進める。モデルは発言の読み取りと、文を作るだけ', 'code'],
    'single-agent': ['1 つの AI が返事ごとに、道具を呼ぶか答えるかを選ぶ', 'model'],
    'master-sub': ['親の AI が、子の AI に任せるかを選ぶ。任せる深さと回数はコードが数える', 'model'],
    handoff: ['AI が会話を別の AI に引き継ぐ(今の構成。選択肢にはない)', 'model'],
    none: ['AI はない', 'code'],
  }[shape];
  const rows = [
    { id: 'turn', part: '1 ターンの回し方', content: turn[0], decidedBy: turn[1], inStudio: 'ある', modelOnly: turn[1] === 'model' },
    shape === 'fixed-flow'
      ? { id: 'ask', part: '何を聞くか・いつ終えるか', content: fields.length > 0 ? `聞く項目: ${fields.join('、')}。全部そろったら終える` : 'AI の設定の流れのとおり', decidedBy: 'code', inStudio: 'ある', modelOnly: false }
      : { id: 'ask', part: '何を聞くか・いつ終えるか', content: `AI が決める。会話の上限(${limits.maxTurns ?? '既定の'} ターン)で必ず終わる`, decidedBy: 'model', inStudio: 'ある', modelOnly: true },
    { id: 'prompt', part: 'プロンプト(AI に渡す指示の文)', content: `${promptTexts(simulation, ai, aiOf).length} つ。全文は下で読める`, decidedBy: 'human', inStudio: 'ある', modelOnly: false },
    { id: 'tools', part: '道具と権限', content: tools.length > 0 ? tools.map((tool) => tool.text).join(' / ') : '道具なし。AI は何も呼べない', decidedBy: 'code', inStudio: 'ある', modelOnly: false },
    {
      id: 'guards',
      part: '守り(ガードレール)の 3 層',
      content: [
        `ツールの守り(コード): ${toolGuards.length > 0 ? toolGuards.map((tool) => `${tool.name} の ${tool.guards.join('、')}`).join('、') : 'なし'}`,
        `プロンプトの頼み(モデル頼み): ${promptGuards.length > 0 ? promptGuards.map((g) => sentence(g.text)).join(' / ') : 'なし'}`,
        `出口の確かめ(コード): ${[...outputGuards.flatMap((g) => outputRuleTexts(g.rules)), ...outputRules].filter(Boolean).join('、') || 'なし'}`,
      ].join('。'),
      decidedBy: 'code',
      inStudio: 'ある',
      modelOnly: promptGuards.length > 0 && toolGuards.length === 0 && outputGuards.length === 0 && outputRules.length === 0,
    },
    escalates.length > 0
      ? { id: 'escalate', part: '人に渡す条件', content: escalates.join(' / '), decidedBy: 'code', inStudio: 'ある', modelOnly: false }
      : handoffTools.length > 0
        ? { id: 'escalate', part: '人に渡す条件', content: `AI が引き継ぎのツールを選ぶ(${handoffTools.map((tool) => tool.name).join('、')})`, decidedBy: 'model', inStudio: 'ある', modelOnly: true }
        : { id: 'escalate', part: '人に渡す条件', content: 'まだ決めていない。人に渡す条件はない', decidedBy: 'human', inStudio: 'ある(固定の流れの条件と、引き継ぎのツール)', modelOnly: false },
    { id: 'limits', part: '上限', content: limitTexts.length > 0 ? limitTexts.join('、') : '既定の上限', decidedBy: 'code', inStudio: 'ある', modelOnly: false },
    { id: 'context', part: '文脈と記憶', content: `1 つの会話の中だけ覚える。会話をまたいでは覚えない${tools.some((tool) => tool.op === 'record') ? '。記録のツールで、会話の中の値を書く' : ''}`, decidedBy: 'code', inStudio: '一部(会話をまたぐ記憶はない)', modelOnly: false },
    { id: 'trace', part: '記録と評価', content: `実行の記録を試す画面で読める。場面の一覧(${evalsCount} 本)で同じように測る`, decidedBy: 'code', inStudio: 'ある', modelOnly: false },
  ];
  return rows.map((row) => ({ ...row, decidedByLabel: DECIDERS[row.decidedBy] }));
}

// AI 構成書の harness の 2 列(モデルに任せる、コードで縛る)と、モデル頼みの印
export function harnessSummary(rows) {
  return {
    modelDecides: rows.filter((row) => row.decidedBy === 'model').map((row) => row.part),
    codeBinds: rows.filter((row) => row.decidedBy === 'code').map((row) => row.part),
    humanDecides: rows.filter((row) => row.decidedBy === 'human').map((row) => row.part),
    modelOnly: rows.filter((row) => row.modelOnly).map((row) => row.part),
  };
}

// ---- 3. データと RAG ----

// 棚は、設計の案内で選んだデータ設計の棚があればそれ、なければ試作品のツールとデータから作る(data-shelf.js。#421)。
// 行ごとに、そのデータを読むツールの名前を付ける(#426)。Studio が設計の表から書いたツール(data/design-table-<番号>.json を読む)は、
// 設計の棚の同じ表の行に付け、同じ表を 2 行に出さない
export function dataReview({ simulation, manifest = null, designShelf = null }) {
  const fromDesign = Array.isArray(designShelf) && designShelf.length > 0;
  const toolsets = simulation?.tools ?? {};
  const tableTools = new Map();
  const rest = {};
  for (const [file, toolset] of Object.entries(toolsets)) {
    const kept = [];
    for (const tool of toolset?.tools ?? []) {
      const id = fromDesign ? designTableShelfId(tool.do?.data) : null;
      if (id && designShelf.some((item) => item.id === id)) tableTools.set(id, [...(tableTools.get(id) ?? []), tool.name]);
      else kept.push(tool);
    }
    rest[file] = { ...toolset, tools: kept };
  }
  const appShelf = shelfFromApp({ toolsets: rest, toolData: simulation?.toolData ?? {}, manifestData: manifest?.data ?? [] });
  const shelf = fromDesign
    ? [...designShelf.map((item) => ({ ...item, tools: [...new Set(tableTools.get(item.id) ?? [])].sort() })), ...appShelf.filter((item) => item.read !== 'none')]
    : appShelf;
  return { shelf, rag: judgeRag(shelf), source: fromDesign ? 'data-design' : 'app' };
}

// ---- 4. 技術の組 ----

// 試作品で使うものは、今のファイルから Studio が書く。本番の候補は options.json の案(未接続)
export function stackRows({ simulation, evalsCount = 0 }) {
  const composition = simulation?.composition ?? null;
  const shape = compositionShape(composition);
  const assumption = (simulation?.assumptions ?? []).find((item) => item.assumption?.id === composition?.assumptions?.default)?.assumption ?? null;
  const model = assumption?.model?.name ? `${assumption.model.name}${assumption.model.standIn ? '(代わりのモデル)' : ''}` : shape === 'fixed-flow' || shape === 'none' ? 'Claude Code の既定のモデル(代わりのモデル。harness の読み取りと言い方)' : '前提に書いていない';
  const tools = toolLines(simulation);
  const retrieves = tools.some((tool) => tool.op === 'retrieve');
  const prototype = {
    model,
    runner: `Studio の会話の進め方(${SHAPE_LABELS[shape] ?? shape})`,
    tools: tools.length > 0 ? `Studio のツールの宣言(${tools.length} 個)。MCP で AI に渡す` : 'ツールなし',
    knowledge: retrieves ? '文字の 2 つ組の BM25(手元で探す。外へ通信しない)' : '使わない',
    memory: '1 つの会話の中だけ。会話をまたいで覚えない',
    evals: `場面の一覧(${evalsCount} 本)。お試しの AI と本物の AI で回せる`,
    trace: 'Studio の実行の記録(試す画面で読める)',
  };
  return STACK_ROWS.map((row) => ({ id: row.id, part: row.label, plain: row.plain, prototype: prototype[row.id] ?? '使わない', candidates: row.candidates }));
}

export { compositionShape };
