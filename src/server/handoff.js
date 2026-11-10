import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { digestSnapshot, snapshotApp } from './app-snapshot.js';
import { NPM_LIBRARIES, STUDIO_PACKAGES, buildApp } from './build.js';
import { RUN_FORMAT } from './build-requests.js';
import { STUDIO_ROOT } from './config.js';
import { MANIFEST_FILE } from './manifest.js';
import { baseScenarios, describeStep, readScenarios } from '../observer/scenario.js';
import { VersionError, copyTree } from './versions.js';
import { extractPrompt, extractSchema, phrasePrompt, phraseSchema } from './product-ai/claude-code.js';
import { formatValue } from './product-ai/definition.js';
import { licenseLabel } from './guides.js';
import { materialChangedAt, readGuideMaterial, readTokenMaterial } from './materials.js';
import { findPersonalData, findSecrets, redact, redactDeep } from './redact.js';
import { BusyError } from './store.js';
import { EVAL_RUN_FORMAT, failuresOf, outcomeOf, riskyText } from './sim/eval-run.js';
import { digestOf } from './sim/orchestrator.js';
import { SHAPE_LABELS } from './architecture.js';
import { SCENE_CATEGORIES } from './design.js';
import { latestEvalResult } from './scene-runs.js';
import {
  PURPOSE_LABELS,
  decisionQuestions,
  defaultMaterialFiles,
  describeDefaultMaterial,
  describeDesign,
  describePurpose,
  describeQuality,
  describeReview,
  describeShows,
} from './handoff-decisions.js';
import { closingReadmeLines, describeClosing, describeDataDesign, readBoard, readComments, readOwners, redactClosing } from './closing.js';
import { readFixRecords } from './comments.js';
import { FIX_RECORDS_DIR } from './meeting.js';

// 本番開発への引き継ぎ(#280、#313)。試作品のソース、意図、AI の設定、モックと状態、未接続と未決事項、
// 目録とシナリオ、最新の証拠の要約、構成とツールと前提、場面と最新の場面の回しの要約を、1 つのフォルダーに書き出す。中身は決まった手順で作り、AI の判断は入れない(ADR-0001、Stripe の Minions)。
// 形式 4(J8)で、目的の文書、設計の段ごとの決定と理由、質の見直しの結果、人に見せた答え、AI 構成書と承認の記録、既定の素材の出典とライセンスを足した(handoff-decisions.js)。
// K5 で、会の終わりの成果物(7 つの成果物の状態、要件の文書、データ設計、構成の図、直した記録の一覧、未決事項の持ち主と期日)を足した(closing.js)。
// 形は docs/handoff.md に書く。標準化は仮で、使われ方を見て直す。

export const HANDOFF_FORMAT = 'prototype-studio-handoff';
export const HANDOFF_FORMAT_VERSION = 4;
export const MAX_NOTE_LENGTH = 4000;
const NOTE_KEYS = ['purpose', 'decided', 'undecided'];
const NOTES_FILE = 'handoff-notes.json';
const MAX_FINDINGS = 20;
// 引き継ぎで場所を挙げる個人のデータの種類(src/server/redact.js の findPersonalData の種類のうち)
const CONTACT_KINDS = new Set(['メールアドレス', '電話番号']);
// 最新の場面の回しの要約に入れる、通らなかった確かめの数
const MAX_EVAL_FAILURES = 20;
// 試作品が import する、Studio の中の同梱の部品(書き出しには入らない)
const STUDIO_IMPORT = /from\s+['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

// 秘密を入れるためのファイル。中を見ずに、書き出しから外す
// .env.example のような見本は外さない(中は他のファイルと同じく調べる)
const SECRET_FILES = [/(^|\/)\.env(\.(?!(example|sample|template)$)[^/]*)?$/i, /\.(pem|key|p12|pfx)$/i, /(^|\/)id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i, /(^|\/)\.netrc$/i];
const CODE_FILE = /\.(jsx?|tsx?|mjs|cjs|html?)$/i;
// 試作品の中では動かないが、本番では何かにつなぐ必要があるコード
const CODE_SIGNS = [
  [/\bfetch\s*\(|\bXMLHttpRequest\b|\bWebSocket\b|\bEventSource\b|\bsendBeacon\b/, 'network'],
  [/\b(localStorage|sessionStorage|indexedDB)\b/, 'storage'],
  [/\b(TODO|FIXME)\b|未実装|仮実装/, 'todo'],
];
// 架空のデータを置いたファイルの手がかり(推定)
const DATA_NAME = /(^|[/._-])(data|mock|mocks|fixture|fixtures|sample|samples|seed|dummy|fake)([/._-]|$)/i;
const EXPORTED_LIST = /export\s+const\s+[A-Za-z_$][\w$]*\s*=\s*\[/;

export class HandoffError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function cleanNotes(raw) {
  const notes = {};
  for (const key of NOTE_KEYS) {
    const value = raw?.[key];
    if (value === undefined || value === null) {
      notes[key] = '';
      continue;
    }
    if (typeof value !== 'string') throw new HandoffError(400, 'invalid', '引き継ぎのメモは文字で書いてください');
    // 改行とタブは残し、ほかの制御文字は消す
    const cleaned = value.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim();
    if (cleaned.length > MAX_NOTE_LENGTH) throw new HandoffError(400, 'invalid', `引き継ぎのメモは、1 つの欄で ${MAX_NOTE_LENGTH} 文字までにしてください`);
    notes[key] = cleaned;
  }
  return notes;
}

const pad = (n) => String(n).padStart(2, '0');
function stamp(date) {
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

async function studioVersion() {
  try {
    return JSON.parse(await fs.readFile(path.join(STUDIO_ROOT, 'package.json'), 'utf8')).version ?? null;
  } catch {
    return null;
  }
}

// 写した app/ のファイルを読み、秘密、個人のデータらしいもの、本番でつなぐ必要があるコード、架空のデータの手がかりを探す
async function scanFiles(appDir) {
  const files = [];
  const secrets = [];
  const personal = [];
  const signs = { network: [], storage: [], todo: [] };
  const dataFiles = [];
  const studioParts = new Set();
  // 試作品が import している npm のパッケージ(既定の素材の出典とライセンスに印を付ける)
  const packages = new Set();
  async function walk(dir) {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      const shown = `app/${path.relative(appDir, full).split(path.sep).join('/')}`;
      const content = await fs.readFile(full);
      files.push({ path: shown, bytes: content.length, sha256: crypto.createHash('sha256').update(content).digest('hex') });
      // 画像などの中も、秘密の形だけは探す。行の番号は目安になる
      if (content.includes(0)) {
        for (const found of findSecrets(content.toString('latin1'))) secrets.push({ file: shown, ...found });
        continue;
      }
      const text = content.toString('utf8');
      for (const found of findSecrets(text)) secrets.push({ file: shown, ...found });
      // 住所と氏名の形は、日本語のコメント(「名前は〜」)にも合うので、ここではメールアドレスと電話番号だけを探す
      for (const found of findPersonalData(text)) if (CONTACT_KINDS.has(found.kind)) personal.push({ file: shown, ...found });
      if (CODE_FILE.test(entry.name)) {
        for (const match of text.matchAll(STUDIO_IMPORT)) {
          const name = match[1] ?? match[2];
          if (STUDIO_PACKAGES.includes(name)) studioParts.add(name);
          else if (/^[@a-z]/i.test(name)) packages.add(name.split('/').slice(0, name.startsWith('@') ? 2 : 1).join('/'));
        }
        text.split(/\r?\n/).forEach((line, index) => {
          for (const [pattern, kind] of CODE_SIGNS) {
            if (pattern.test(line)) signs[kind].push({ file: shown, line: index + 1, text: redact(line.trim()).slice(0, 120) });
          }
        });
        if (DATA_NAME.test(shown.slice('app/'.length)) || (text.includes('架空') && EXPORTED_LIST.test(text))) dataFiles.push(shown);
      } else if (/\.json$/i.test(entry.name) && DATA_NAME.test(shown.slice('app/'.length))) {
        dataFiles.push(shown);
      }
    }
  }
  await walk(appDir);
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { files, secrets, personal, signs, dataFiles: dataFiles.sort(), studioParts: [...studioParts].sort(), packages: [...packages].sort() };
}

const where = (found) => `${found.file}:${found.line}`;
const listWhere = (list) => {
  const shown = list.slice(0, MAX_FINDINGS).map(where).join('、');
  return list.length > MAX_FINDINGS ? `${shown} ほか ${list.length - MAX_FINDINGS} か所` : shown;
};

// 会話の各発言に、どの接続の応答かと、実際の AI モデルかを付ける
function describeConversation(definition, snapshot, connections) {
  const fresh = {
    state: { ...definition.initialState },
    messages: definition.mock.greeting ? [{ role: 'assistant', text: definition.mock.greeting }] : [],
  };
  const { state, messages } = snapshot ?? fresh;
  return {
    initial: snapshot === null,
    state: definition.fields.map((field) => ({ key: field.key, label: field.label, value: state[field.key] ?? null, shown: formatValue(field, state[field.key]) })),
    messages: messages.map((message, index) => {
      if (message.role !== 'assistant') return redactDeep({ role: message.role, text: message.text });
      // 最初のあいさつは、接続を通さずに設定から出す。ほかに接続のない応答は、#276 より前に保存した版のもの
      const kind = message.via ?? null;
      const connection = kind ? connections.get(kind) : null;
      const greeting = !kind && index === 0 && message.text === definition.mock.greeting;
      return redactDeep({
        role: 'assistant',
        text: message.text,
        via: kind,
        viaLabel: kind ? (connection?.label ?? kind) : greeting ? '設定の固定文(mock.greeting)' : '不明(接続の記録がない)',
        real: Boolean(connection?.billing),
        ...(Number.isFinite(message.elapsedMs) ? { elapsedMs: message.elapsedMs } : {}),
        ...(Number.isFinite(message.costUsd) ? { costUsd: message.costUsd } : {}),
      });
    }),
  };
}

// 目録(app/prototype.json)。ないときは、ビルドが読む既定の値(file が null)。パスは app/ からの相対
function describePrototype(manifest) {
  const { declared, ...fields } = manifest;
  return { file: declared ? `app/${MANIFEST_FILE}` : null, ...fields };
}

// app/ のシナリオと、Studio がいつも先に回す基本のシナリオ。checks は各手順で確かめることの文
async function describeScenarios(appDir, prototype, definition) {
  const describe = (scenario) => ({ name: scenario.name, viewport: scenario.viewport, steps: scenario.steps, checks: scenario.steps.map(describeStep) });
  const { scenarios } = await readScenarios(appDir, prototype.scenarios);
  return {
    folder: `app/${prototype.scenarios}`,
    files: scenarios.map(({ file, scenario }) => ({ file, ...describe(scenario) })),
    base: baseScenarios({ greeting: definition?.mock.greeting }).map(describe),
  };
}

async function readJson(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

// 最新の作る run(.studio/runs/<run-id>/run.json)と、その最後のラウンドの観察の report の要約。
// 確かめた app/ の中身の指紋(appDigest)が今の app/ と違えば、古い(stale)。指紋が分からなければ stale は null
export async function latestEvidence(paths, appDigest) {
  const runsDir = path.join(paths.studio, 'runs');
  let record = null;
  for (const entry of await fs.readdir(runsDir, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory()) continue;
    const found = await readJson(path.join(runsDir, entry.name, 'run.json'));
    if (found?.format !== RUN_FORMAT || found.id !== entry.name || typeof found.startedAt !== 'string') continue;
    if (!record || found.startedAt > record.startedAt) record = found;
  }
  if (!record) return { appDigest, run: null };
  // つないだ素材は app/ の外なので、指紋に入らない。素材を変えた時刻より前の確かめも古い
  const changedAt = await materialChangedAt(paths.root);
  const staleOf = (digest, at) => (typeof digest === 'string' ? digest !== appDigest || (changedAt !== null && typeof at === 'string' && at < changedAt) : null);
  const gates = Array.isArray(record.gates) ? record.gates : [];
  const reports = [];
  for (const gate of gates) {
    if (typeof gate?.report !== 'string') continue;
    // run のフォルダーの中の report だけを読む
    const file = path.join(paths.root, ...gate.report.split('/'));
    if (!file.startsWith(path.join(runsDir, record.id) + path.sep)) continue;
    const report = await readJson(file);
    if (!report) continue;
    reports.push({
      gate: gate.id,
      file: gate.report,
      verdict: report.verdict ?? null,
      startedAt: report.startedAt ?? null,
      appDigest: report.appDigest ?? null,
      stale: staleOf(report.appDigest, report.startedAt),
      errorCount: Array.isArray(report.errors) ? report.errors.length : 0,
      scenarios: (Array.isArray(report.scenarios) ? report.scenarios : []).map((s) => ({ name: s.name, base: s.base === true, file: s.file ?? null, verdict: s.verdict })),
    });
  }
  const digest = record.build?.appDigest ?? reports.find((r) => r.appDigest)?.appDigest ?? null;
  return {
    appDigest,
    run: {
      file: `.studio/runs/${record.id}/run.json`,
      id: record.id,
      status: record.status,
      startedAt: record.startedAt,
      finishedAt: record.finishedAt ?? null,
      rounds: Array.isArray(record.rounds) ? record.rounds.length : 1,
      appDigest: digest,
      stale: staleOf(digest, record.finishedAt ?? record.startedAt),
      gates: gates.map((g) => ({
        id: g.id,
        label: g.label,
        status: g.status,
        ...(g.summary ? { summary: g.summary } : {}),
        ...(g.reason ? { reason: g.reason } : {}),
        ...(Number.isFinite(g.errorCount) ? { errorCount: g.errorCount } : {}),
      })),
      reports,
    },
  };
}

// 最新の場面の回し(.studio/evals/<回しの ID>/result.json。npm run evals が書く)の要約。
// 回した app/ の指紋が今の app/ と違えば、古い(stale)。指紋が分からなければ stale は null
export async function latestEvalRun(paths, appDigest) {
  const evalsDir = path.join(paths.studio, 'evals');
  let found = null;
  for (const entry of await fs.readdir(evalsDir, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory()) continue;
    const result = await readJson(path.join(evalsDir, entry.name, 'result.json'));
    if (result?.format !== EVAL_RUN_FORMAT || result.id !== entry.name || typeof result.startedAt !== 'string' || !Array.isArray(result.groups)) continue;
    if (!found || result.startedAt > found.startedAt) found = result;
  }
  if (!found) return null;
  return {
    file: `.studio/evals/${found.id}/result.json`,
    report: `.studio/evals/${found.id}/report.md`,
    id: found.id,
    startedAt: found.startedAt,
    finishedAt: found.finishedAt ?? null,
    status: found.status,
    verdict: found.verdict ?? null,
    stopReason: found.stopReason ?? null,
    appDigest: found.appDigest ?? null,
    stale: typeof found.appDigest === 'string' ? found.appDigest !== appDigest : null,
    real: Boolean(found.options?.real),
    withoutPromptGuards: Boolean(found.options?.withoutPromptGuards),
    totals: found.totals ?? null,
    groups: found.groups.map((group) => ({
      composition: group.composition?.label ?? null,
      compositionDigest: group.composition?.digest ?? null,
      assumption: group.assumption?.id ?? null,
      assumptionDigest: group.assumption?.digest ?? null,
      connection: group.connection,
      real: Boolean(group.real),
      round: group.round,
      summary: group.summary ?? null,
      // 危ない場面が止まったか(結果の確かめで決める)と、止めた層(ツールの守り、出口の確かめ、プロンプトかモデル)
      risky: (group.evals ?? []).filter((e) => e.kind === 'risky').map((e) => {
        const outcome = outcomeOf(e);
        return { id: e.id, verdict: e.verdict, outcome, stoppedBy: outcome === 'stopped' ? e.stoppedBy ?? null : null, toolBlocks: e.toolBlocks ?? [], asked: e.asked ?? [] };
      }),
    })),
    failures: failuresOf(found).slice(0, MAX_EVAL_FAILURES).map(({ eval: id, file, check, expected, actual }) => ({ eval: id, file, check, expected, actual })),
  };
}

// 構成、ツール、前提、プロンプトの枠、場面(書き出した app/ の写しをビルドしたもの)と、最新の場面の回しの要約。
// 構成のファイルのない試作品(構成 B)は、compositions が空で、AI の設定は ai の項目にある
function describeSimulation(simulation, latestRun) {
  const compositionOf = (composition, isDefault) => ({
    file: `app/${composition.file}`,
    default: isDefault,
    name: composition.name ?? null,
    driver: composition.driver,
    participants: composition.participants.map((p) => ({
      id: p.id,
      kind: p.kind,
      label: p.label ?? null,
      owner: p.owner,
      ...(p.kind === 'agent' ? { prompt: p.prompt, tools: p.tools ?? [], mock: p.mock ? `app/${p.mock}` : null } : {}),
      ...(p.kind === 'harness' ? { ai: `app/${p.ai}`, returnTo: p.returnTo ?? null } : {}),
      // 固定の流れ(コードがツールを呼ぶ段、人に渡す条件、モデルの指定)。書いた参加者だけ
      ...(p.kind === 'harness' && p.flow ? { flow: p.flow, tools: p.tools ?? [] } : {}),
      ...(p.kind === 'harness' && p.escalate ? { escalate: p.escalate } : {}),
      ...(p.kind === 'harness' && p.model ? { model: p.model } : {}),
      ...(p.kind === 'human' ? { mock: p.mock ?? null } : {}),
    })),
    tools: composition.tools ? `app/${composition.tools}` : null,
    handoffs: composition.handoffs,
    // マスターとサブの委任の辺(2.9)。書いた構成だけ
    ...(composition.delegations ? { delegations: composition.delegations } : {}),
    guards: composition.guards,
    surface: composition.surface,
    assumptions: composition.assumptions,
    limits: composition.limits,
  });
  const compositions = [
    ...(simulation?.composition?.file ? [compositionOf(simulation.composition, true)] : []),
    ...(simulation?.compositions ?? []).map((item) => compositionOf(item.composition, false)),
  ];
  return {
    compositions,
    tools: Object.entries(simulation?.tools ?? {}).map(([file, toolset]) => ({
      file: `app/${file}`,
      owner: toolset.owner,
      tools: toolset.tools.map((tool) => ({ name: tool.name, description: tool.description, owner: tool.owner, inputSchema: tool.inputSchema, do: tool.do, guards: tool.guards ?? {} })),
    })),
    assumptions: (simulation?.assumptions ?? []).map(({ file, assumption }) => ({ file: `app/${file}`, digest: digestOf(assumption), ...assumption })),
    prompts: Object.entries(simulation?.prompts ?? {}).map(([file, text]) => ({ file: `app/${file}`, chars: text.length })),
    evals: (simulation?.evals ?? []).map(({ file, scenario }) => ({ file: `app/${file}`, id: scenario.id, kind: scenario.kind, about: scenario.about ?? null, checks: scenario.expect.map((item) => item.check) })),
    latestRun,
  };
}

// 実機、モック、未接続の一覧。どの試作品にも出る行と、見つけたものから出る行がある
function capabilities({ fileCount, ai, conversation, scan, prototype, simulation }) {
  const rows = [];
  const add = (kind, item, prototype, production, evidence = []) => rows.push({ kind, item, prototype, production, evidence });
  const replies = conversation?.messages.filter((m) => m.role === 'assistant' && m.via) ?? [];
  const realReplies = replies.filter((m) => m.real);
  const mockReplies = replies.filter((m) => !m.real);

  add(
    'real',
    '画面と操作',
    `app/ の ${fileCount} 個のファイル。React で書かれ、ブラウザの中で実際に動く。`,
    '本番の技術と設計の決まりに合わせて、作り直すか移す。試作品のコードは、品質、性能、アクセシビリティを確かめていない。',
  );
  if (ai && realReplies.length > 0) {
    const labels = [...new Set(realReplies.map((m) => m.viaLabel))].join('、');
    add(
      'real',
      'プロダクト内 AI(実モデル)',
      `${labels} で ${realReplies.length} 回応答した。会話の記録で「${labels}」と印の付いた応答が、実際の AI モデルの応答。指示は ai/system-prompt.md。`,
      '本番のモデル、鍵の管理、費用の上限、応答の監視を決める。試作品は Claude Code の CLI を本人のログインで動かしていた。',
    );
  }
  if (ai) {
    add(
      'mock',
      'プロダクト内 AI(モック)',
      `Studio の決まった規則で応答する。app/ai.json の keywords が文にあるかで項目を読み取り、mock の文を返す。言い回しは理解しない。この会話のモックの応答: ${mockReplies.length} 回。`,
      '本番では使わない。決まった応答が要るテストの見本にする。',
    );
    add(
      'mock',
      '会話と状態の置き場',
      'Studio のサーバーのメモリーが持ち、試作品は window.studio.ai(session、send、correct、onChange)で呼ぶ。Studio を止めると消える。',
      '本番のサーバーに、会話と状態を持つ API を作る。window.studio.ai の呼び方と、返す形(state、messages)が見本になる。',
    );
  }
  // 構成(app/composition.json など)のある試作品の、模擬のエージェント、ツール、会話の枠
  const agents = (simulation?.compositions ?? []).flatMap((c) => c.participants.filter((p) => p.kind === 'agent').map((p) => `${p.label ?? p.id}(${c.file})`));
  if (agents.length > 0) {
    add(
      'mock',
      '模擬のエージェント',
      `構成の参加者 ${agents.join('、')} は、モックの決まり(app/mocks/)か、相手のモデルの代わりの Claude Code で動く。相手の本物のエージェントではない。相手の仕様の分からない所は前提(app/assumptions/)の推測。`,
      '相手の本物のエージェントとつなぎ、前提の推測(モデル、プロンプト、使えるメッセージ、ツールの呼び方、記録の取り方)を本物の仕様で確かめる。',
      [...new Set([...(simulation.compositions ?? []).map((c) => c.file), ...simulation.assumptions.map((a) => a.file)])],
    );
  }
  const toolCount = (simulation?.tools ?? []).reduce((n, t) => n + t.tools.length, 0);
  if (toolCount > 0) {
    add(
      'real',
      'ツール(宣言)',
      `${simulation.tools.map((t) => t.file).join('、')} の宣言(${toolCount} 個)を、Studio のツールの口が動かす。ツールの守り(requires、deny、hideFields など)は試作品の中で実際に効く。データは架空で、記録の店は会話ごとにメモリーに置く。`,
      '本番の API として作る。inputSchema と守りが仕様の見本。記録の店は本番の保存先と同意の記録に置き換える。',
      simulation.tools.map((t) => t.file),
    );
  }
  if (scan.studioParts.length > 0) {
    add(
      'mock',
      '会話の枠(studio-talk)',
      `試作品は Studio が同梱する部品(${scan.studioParts.join('、')})で会話の見た目を描く。部品のコードは Studio の中にあり、この書き出しには入らない。`,
      '本番の画面(相手のトークアプリの部品や、自社の画面)で作り直す。部品の種類(文、ボタン、カード、カルーセル、知らせ)が見本。',
    );
  }
  // 目録に架空のデータの宣言があれば、推定の代わりにそれを出す
  const declared = prototype.data.map((d) => ({ file: `app/${d.file}`, about: d.about }));
  add(
    'mock',
    'データ',
    declared.length > 0
      ? `app/ の中に書いた固定のデータ。目録(app/prototype.json の data)に書かれた架空のデータ: ${declared.map((d) => `${d.file}(${d.about})`).join('、')}。`
      : scan.dataFiles.length > 0
        ? `app/ の中に書いた固定のデータ。架空のデータを置いたファイルの手がかり(推定): ${scan.dataFiles.join('、')}。`
        : 'app/ の中に書いた固定の値と、操作の間だけ画面のメモリーにある値。',
    '本物のデータの出どころ(API、データベース)と、項目の意味を決める。',
    declared.length > 0 ? declared.map((d) => d.file) : scan.dataFiles,
  );
  add(
    'missing',
    'サーバーと保存',
    scan.signs.storage.length > 0
      ? `試作品にはサーバーもデータベースもない。ブラウザに保存するコードがある(${listWhere(scan.signs.storage)})が、試作品の中では使えない(sandbox)。開き直すと、画面で変えた値は消える。`
      : '試作品にはサーバーもデータベースもない。開き直すと、画面で変えた値は消える。',
    '保存先、保存する項目、消す時期を決めて作る。',
    scan.signs.storage.map(where),
  );
  add(
    'missing',
    '外部の API と通信',
    scan.signs.network.length > 0
      ? `通信するコードがある(${listWhere(scan.signs.network)})が、試作品の通信は CSP(connect-src 'none')で止めているので、届いていない。`
      : '試作品の通信は CSP(connect-src \'none\')で止めている。外部の API にはつないでいない。',
    'つなぐ先、認証、失敗したときの画面を決めて作る。',
    scan.signs.network.map(where),
  );
  add('missing', 'ログインと利用者の区別', '試作品にはない。誰が使っても同じ画面と会話になる。', '認証の方式と、利用者ごとのデータの分け方を決める。');
  if (ai) {
    add(
      'missing',
      'プロダクト内 AI の本番の接続',
      '試作品は、モックか、利用者の PC の Claude Code(CLI)で応答した。本番のサーバーからは呼んでいない。',
      'モデル、鍵の管理、費用の上限、応答の形の検査(ai/response-schema.json)、記録と監視を作る。',
    );
  }
  add('missing', '本物のデータと個人情報', '試作品は架空のデータだけで試す決まり。', '個人情報の扱い、保存の期間、AI の提供元に送ってよい範囲を決める。');
  // 作る AI が目録に書いた、本番で作るものと試作品の制約
  const manifestFile = [`app/${MANIFEST_FILE}`];
  for (const item of prototype.unimplemented) {
    add('missing', item, '目録(app/prototype.json の unimplemented)に、本番で作るものとして書かれている。試作品にはない。', '本番で作る。', manifestFile);
  }
  if (prototype.constraints.length > 0) {
    add(
      'missing',
      '試作品の制約(目録)',
      `目録(app/prototype.json の constraints)に書かれた試作品の制約: ${prototype.constraints.join('、')}。`,
      '本番でも同じ制約にするか、外すかを決める。',
      manifestFile,
    );
  }
  return rows;
}

// Studio が見つけた、決める必要のあること
function studioQuestions({ ai, conversation, working, scan, excluded, evidence, simulation }) {
  const questions = [];
  if (ai && !conversation.messages.some((m) => m.real)) {
    questions.push('プロダクト内 AI を実モデルで試していない(会話の応答はモックだけ)。ai.json の instructions どおりに振る舞うかは、確かめていない。');
  }
  const unknown = conversation?.messages.filter((m) => m.role === 'assistant' && !m.via && m.viaLabel.startsWith('不明')).length ?? 0;
  if (unknown > 0) questions.push(`どの接続の応答か記録がない応答が ${unknown} 件ある(古い版から戻した会話)。モックか実モデルかは分からない。`);
  if (ai && conversation.initial) questions.push('プロダクト内 AI と話していない状態で書き出した。会話の記録は最初のあいさつだけ。');
  if (working.files === 'changed') questions.push('保存した版のどれとも違う作業中から書き出した。どの版を本番の基にするか決める。');
  if (working.files === 'none') questions.push('版を保存していない作業中から書き出した。');
  if (scan.personal.length > 0) {
    questions.push(`メールアドレスか電話番号らしいものがある(${listWhere(scan.personal)})。架空のものか確かめる。`);
  }
  if (scan.signs.todo.length > 0) questions.push(`コードに未実装の印がある(${listWhere(scan.signs.todo)})。`);
  if (excluded.length > 0) questions.push(`秘密を入れるファイルを書き出しから外した(${excluded.map((e) => e.path).join('、')})。本番で要る設定か確かめる。`);
  if (simulation.assumptions.length > 0) questions.push('相手の仕様は前提(app/assumptions/)の推測で、本物の仕様ではない。本物の仕様で確かめる。');
  const latestEvals = simulation.latestRun;
  if (simulation.evals.length > 0 && !latestEvals) {
    questions.push('場面(app/evals/)を npm run evals で回した結果がない。場面の結果は、作るループの関門 GE(モック)のものだけ。');
  }
  if (latestEvals) {
    if (latestEvals.stale === true) questions.push(`最新の場面の回し(${localTime(latestEvals.startedAt)})は、今の app/ と違う中身で回したもので、古い。`);
    if (latestEvals.stale === null) questions.push(`最新の場面の回し(${localTime(latestEvals.startedAt)})が、どの app/ の中身で回したものか分からない。`);
    if (!latestEvals.real) questions.push('場面をモックでだけ回した。実モデル(相手のモデルの代わりの Claude)では回していない。');
    if (latestEvals.status === 'stopped') questions.push(`最新の場面の回しは途中で止まった(${latestEvals.stopReason ?? '理由は不明'})。`);
    if (latestEvals.status === 'error' || latestEvals.status === 'running') questions.push(`最新の場面の回しは、終わる前に失敗した(${latestEvals.stopReason ?? '理由は不明'})。`);
  }
  const { run } = evidence;
  if (!run) {
    questions.push('作る run の記録がない。Studio の関門(ビルド、起動の確認、シナリオ)で確かめた証拠は入っていない。');
  } else {
    if (run.stale === true) questions.push(`最新の証拠(${localTime(run.startedAt)} の作る run)は、今の app/ と違う中身で確かめたもので、古い。今の app/ は関門で確かめていない。`);
    if (run.stale === null) questions.push(`最新の証拠(${localTime(run.startedAt)} の作る run)が、どの app/ の中身で確かめたものか分からない。`);
    if (!['passed', 'fixed'].includes(run.status)) questions.push(`最新の作る run の結果は「${RUN_LABELS[run.status] ?? run.status}」で、関門をすべては通っていない。`);
  }
  return questions;
}

// 改行は、どの書き方でも 1 行にする。表の行を足されないように
const oneLine = (value) => String(value ?? '').replace(/\r\n|[\r\n\u2028\u2029\u0085]/g, ' / ');
// Markdown の表の 1 マス
const cell = (value) => oneLine(value).replace(/\\/g, '\\\\').replace(/\|/g, '\\|');
// コードとして出す(コードの中では \ を重ねない)。` を含むときは、文字のまま出す
const code = (value) => (String(value).includes('`') ? cell(value) : `\`${oneLine(value).replace(/\|/g, '\\|')}\``);
const KIND_LABELS = { real: '実機', mock: 'モック', missing: '未接続' };
const ROLE_LABELS = { user: '利用者', assistant: 'AI', correction: '利用者の修正' };
const RUN_LABELS = {
  done: '終わった',
  passed: '通った',
  fixed: '直して通った',
  unverified: '未確認',
  unchanged: '変更なし',
  failed: '失敗',
  'agent-failed': '作る AI の失敗',
  cancelled: '中断',
  'timed-out': '時間切れ',
  running: '作業中',
};
const GATE_LABELS = { passed: '通った', failed: '失敗', unverified: '未確認', unchanged: '変更なし', skipped: '行わない' };
const localTime = (iso) => (iso ? new Date(iso).toLocaleString('ja-JP') : '');

// 書き出した人のメモは引用にする。行頭の # などが見出しにならないように
function noteBlock(text) {
  return text ? text.split('\n').map((line) => (line ? `> ${line}` : '>')).join('\n') : '(書かれていません)';
}

function fieldRule(field) {
  if (field.type === 'number') {
    const range = [field.min !== null ? `${field.min} 以上` : '', field.max !== null ? `${field.max} 以下` : ''].filter(Boolean).join('、');
    return `数${field.unit ? `(単位: ${field.unit})` : ''}${range ? `、${range}` : ''}`;
  }
  return `選択肢: ${field.options.map((o) => o.value).join('、')}`;
}

// 作る AI が目録に書いた意図と制約。書き出した人のメモ(目的)と並べる
function prototypeLines(prototype) {
  const lines = ['## 作る AI が書いた意図と制約(目録)', ''];
  if (!prototype.file) {
    lines.push('目録(`app/prototype.json`)がありません。作る AI が書いた意図と制約はありません。', '');
    return lines;
  }
  const list = (items) => (items.length > 0 ? items.map(oneLine).join('、') : '(なし)');
  lines.push(
    '作る AI が依頼から `app/prototype.json` に書いたものです。上の「目的」は書き出した人のメモで、こちらと並べて読みます。',
    '',
    `- 意図: ${prototype.intent.purpose ? oneLine(prototype.intent.purpose) : '(書かれていません)'}`,
    `- 試してほしいこと: ${list(prototype.intent.tryThis)}`,
    `- 制約: ${list(prototype.constraints)}`,
    `- 本番で作るもの(未実装): ${list(prototype.unimplemented)}`,
    `- 架空のデータ: ${prototype.data.length > 0 ? prototype.data.map((d) => `${code(`app/${d.file}`)}(${oneLine(d.about)})`).join('、') : '(なし)'}`,
    '',
  );
  return lines;
}

function scenarioLines(scenarios) {
  const lines = ['## シナリオ(確かめ方)', ''];
  const row = (file, s) => `| ${file} | ${cell(s.name)} | ${s.viewport} | ${cell(s.checks.map((c, i) => `${i + 1}. ${c}`).join(' '))} |`;
  lines.push(
    `Studio の関門 G6 が観察器で回すシナリオです。試作品のシナリオは ${code(scenarios.folder)} にあり、形は handoff.json の \`scenarios\` にもあります。基本のシナリオは Studio のコードの中にあり、いつも先に回します。`,
    '',
    '| ファイル | 名前 | 画面幅 | 手順 |',
    '|---|---|---|---|',
    ...scenarios.files.map((s) => row(code(s.file), s)),
    ...scenarios.base.map((s) => row('(Studio の基本)', s)),
    '',
  );
  return lines;
}

function evidenceLines(evidence) {
  const lines = ['## 最新の証拠', ''];
  const { run } = evidence;
  if (!run) {
    lines.push('作る run の記録がありません。Studio の関門で確かめた証拠はありません。', '');
    return lines;
  }
  const freshness = (stale) => (stale === true ? '**古い**(今の app/ と違う中身で確かめた)' : stale === false ? '今の app/ と同じ中身' : '分からない');
  lines.push(
    `最新の作る run の要約です。記録の全体は、試作品のフォルダーの ${code(run.file)} にあります(この引き継ぎには入れていません)。`,
    '',
    `- 結果: ${RUN_LABELS[run.status] ?? cell(run.status)}(ラウンド ${run.rounds} 回)`,
    `- 日時: ${localTime(run.startedAt)} から ${localTime(run.finishedAt)}`,
    `- 確かめた app/ の中身: ${freshness(run.stale)}`,
    '',
    '| 関門 | 名前 | 結果 | 中身 |',
    '|---|---|---|---|',
    ...run.gates.map((g) => `| ${g.id} | ${cell(g.label)} | ${GATE_LABELS[g.status] ?? cell(g.status)} | ${cell(g.summary ?? g.reason ?? '')} |`),
    '',
  );
  if (run.reports.length > 0) {
    lines.push(
      '観察の report:',
      '',
      '| 関門 | 合否 | 日時 | 確かめた app/ | シナリオ |',
      '|---|---|---|---|---|',
      ...run.reports.map((r) => {
        const scenarios = r.scenarios.map((s) => `${s.name}: ${GATE_LABELS[s.verdict] ?? s.verdict}`).join('、');
        return `| ${r.gate} | ${GATE_LABELS[r.verdict] ?? cell(r.verdict)} | ${localTime(r.startedAt)} | ${freshness(r.stale)} | ${cell(scenarios)} |`;
      }),
      '',
    );
  }
  return lines;
}

const EVAL_VERDICT_LABELS = { passed: '通った', failed: '失敗', stopped: '途中で止めた' };

function simulationLines(simulation) {
  const lines = [];
  if (simulation.compositions.length > 0) {
    lines.push(
      '## 構成とツール(模擬)',
      '',
      '試作品の中で、誰が会話を回し、誰がどのツールとプロンプトの枠を持つかを表したデータです。全部の中身は handoff.json の `simulation` と、写した `app/` にあります。',
      '',
      '| 構成 | 名前 | 回し手 | 参加者(種類、持ち主) | ガードレール(層、持ち主) |',
      '|---|---|---|---|---|',
      ...simulation.compositions.map((c) => `| ${code(c.file)}${c.default ? '(既定)' : ''} | ${cell(c.name ?? '')} | ${cell(c.driver)} | ${cell(c.participants.map((p) => `${p.id}(${p.kind}、${p.owner})`).join('、'))} | ${cell(c.guards.map((g) => `${g.id}(${g.layer}、${g.owner}${g.layer === 'output' ? `、${g.enforce === false ? '記録だけ' : '止める'}` : ''})`).join('、') || 'なし')} |`),
      '',
    );
  }
  if (simulation.tools.length > 0) {
    lines.push(
      'ツール(宣言)とツールの守り:',
      '',
      '| ファイル | ツール | 処理 | 守り | 説明 |',
      '|---|---|---|---|---|',
      ...simulation.tools.flatMap((t) => t.tools.map((tool) => `| ${code(t.file)} | ${code(tool.name)} | ${cell(tool.do.op)} | ${cell(Object.keys(tool.guards).join('、') || 'なし')} | ${cell(tool.description)} |`)),
      '',
    );
  }
  if (simulation.assumptions.length > 0) {
    lines.push(
      '前提(相手の仕様の推測。本物の仕様ではない):',
      '',
      '| ファイル | id | 名前 | モデル(代わり) | 使えるメッセージ |',
      '|---|---|---|---|---|',
      ...simulation.assumptions.map((a) => `| ${code(a.file)} | ${cell(a.id)} | ${cell(a.name ?? '')} | ${cell(a.model?.name ?? '')} | ${cell((a.messageTypes ?? []).join('、'))} |`),
      '',
    );
  }
  if (simulation.evals.length === 0 && !simulation.latestRun) return lines;
  lines.push('## 場面(確かめ方)と最新の回し', '');
  if (simulation.evals.length > 0) {
    lines.push(
      '場面は会話の確かめの 1 単位です。作るループの関門 GE がモックで回し、`npm run evals` で構成と前提を変えて回せます。',
      '',
      '| ファイル | id | 種類 | 中身 | 確かめ |',
      '|---|---|---|---|---|',
      ...simulation.evals.map((e) => `| ${code(e.file)} | ${cell(e.id)} | ${cell(e.kind)} | ${cell(e.about ?? '')} | ${cell(e.checks.join('、'))} |`),
      '',
    );
  }
  const latest = simulation.latestRun;
  if (!latest) {
    lines.push('`npm run evals` で場面を回した結果はありません。', '');
    return lines;
  }
  const freshness = latest.stale === true ? '**古い**(今の app/ と違う中身で回した)' : latest.stale === false ? '今の app/ と同じ中身' : '分からない';
  lines.push(
    `最新の場面の回しの要約です。結果と比べる表の全体は、試作品のフォルダーの ${code(latest.file)} と ${code(latest.report)} にあります(この引き継ぎには入れていません)。`,
    '',
    `- 結果: ${EVAL_VERDICT_LABELS[latest.verdict] ?? cell(latest.verdict ?? '不明')}(${latest.status === 'done' ? '最後まで回した' : `途中で${latest.status === 'stopped' ? '止めた' : '失敗した'}: ${cell(latest.stopReason ?? '')}`})`,
    `- 日時: ${localTime(latest.startedAt)} から ${localTime(latest.finishedAt)}`,
    `- 接続: ${latest.real ? '実モデル(相手のモデルの代わりの Claude)' : 'モック'}。プロンプトの頼み: ${latest.withoutPromptGuards ? '外した' : '入れた'}`,
    `- 回した app/ の中身: ${freshness}`,
    '',
    '| 構成 / 前提 | 接続 | 回 | 通った場面 | 失敗 | n/a | 確かめの合格 | ツールが止めた | 止まらなかった | 費用(USD) |',
    '|---|---|---|---|---|---|---|---|---|---|',
    ...latest.groups.map((g) => {
      const s = g.summary;
      const label = `${g.composition}${g.assumption ? ` / ${g.assumption}` : ''}`;
      if (!s) return `| ${cell(label)} | ${cell(g.connection)} | ${g.round} | - | - | - | - | - | - | - |`;
      return `| ${cell(label)} | ${cell(g.connection)} | ${g.round} | ${s.passed} | ${s.failed + s.errors} | ${s.notApplicable} | ${s.checks.passed}/${s.checks.decided} | ${s.risky.tool}/${s.risky.count} | ${s.risky['not-stopped']}/${s.risky.count} | ${Number(s.costUsd ?? 0).toFixed(4)} |`;
    }),
    '',
  );
  const risky = latest.groups.flatMap((g) => g.risky.map((r) => ({ g, r })));
  if (risky.length > 0) {
    lines.push(
      '危ない場面で効いた層:',
      '',
      '止まったかは、結果の確かめ(ツールが動いたか、記録に入ったか、返事に出たか)と出口の確かめの違反だけで決めます。',
      '',
      '| 構成 / 前提 | 場面 | 効いた層 | ツールの守り | プロンプトの頼み |',
      '|---|---|---|---|---|',
      ...risky.map(({ g, r }) => `| ${cell(`${g.composition}${g.assumption ? ` / ${g.assumption}` : ''}`)} | ${cell(r.id)} | ${r.verdict === 'n/a' ? 'n/a' : riskyText(r)} | ${cell(r.toolBlocks.join('、') || 'なし')} | ${cell(r.asked.join('、') || 'なし')} |`),
      '',
    );
  }
  return lines;
}

// 書き出しの中の素材のファイル。ソースの外に置く(app/ には素材の値を入れない)
const MATERIAL_FILES = { tokens: 'materials/tokens.json', css: 'materials/tokens.css', source: 'materials/source.json' };

function describeTokens(material) {
  const { record, tokens } = material;
  // 人が書いた文だけを伏せる。指紋は長い符号の形なので、伏せると照合できなくなる
  return {
    files: MATERIAL_FILES,
    spec: record.spec,
    fileName: redact(record.fileName),
    source: redact(record.source),
    reason: redact(record.reason),
    connectedAt: record.connectedAt,
    sha256: record.sha256,
    count: tokens.length,
    roles: record.roles,
    variables: tokens.flatMap((token) => token.variables.map((variable) => variable.name)),
  };
}

// 有効にした部品と指針(J5)。写しは app/design/ にあるので、ソースに入っている
function describeGuides(records) {
  return records.map((record) => ({
    kind: record.kind,
    source: redact(record.source),
    license: redact(licenseLabel(record)),
    reason: redact(record.reason ?? ''),
    scope: record.scope,
    enabledAt: record.enabledAt,
    componentCount: record.componentCount ?? 0,
    externalUrls: record.urlCount ?? 0,
    files: record.files.map((file) => ({ copy: `app/${file.copy}`, sha256: file.sha256 })),
  }));
}

const GUIDE_TITLES = { guides: '指針の文', storybook: 'Storybook の部品の一覧' };

// source.json の写し。人が書いた文だけを伏せる
function materialSourceCopy(source) {
  const clean = (entry) => ({ ...entry, ...Object.fromEntries(['fileName', 'source', 'reason', 'licenseName', 'license', 'from'].filter((key) => typeof entry?.[key] === 'string').map((key) => [key, redact(entry[key])])) });
  const guides = Object.fromEntries(Object.keys(GUIDE_TITLES).map((kind) => [kind, source[kind] ? { ...clean(source[kind]), files: (source[kind].files ?? []).map(clean) } : null]));
  return { ...source, tokens: source.tokens ? clean(source.tokens) : null, ...guides, history: (source.history ?? []).map(clean) };
}

function guideLines(guides) {
  if (!Array.isArray(guides) || guides.length === 0) return [];
  const lines = ['## 素材(部品と指針)', ''];
  for (const guide of guides) {
    lines.push(
      `- ${GUIDE_TITLES[guide.kind] ?? guide.kind}: 出典 ${oneLine(guide.source)}、${oneLine(guide.license)}${guide.reason ? `、理由 ${oneLine(guide.reason)}` : ''}`,
      `  - 写し: ${guide.files.map((file) => code(file.copy)).join('、')}。作る AI はこれを読んで作った`,
    );
    if (guide.externalUrls > 0) lines.push(`  - 外への URL が ${guide.externalUrls} 個あった。試作品からは読めないので、本番で使うなら置き場所を決める`);
  }
  lines.push('');
  return lines;
}

function materialLines(materials) {
  const guideText = guideLines(materials?.guides);
  const tokens = materials?.tokens;
  if (!tokens) return guideText;
  return [
    '## 素材(自分のトークン)',
    '',
    `- 出典: ${oneLine(tokens.source)}`,
    `- つないだ理由: ${tokens.reason ? oneLine(tokens.reason) : '(書いていません)'}`,
    `- 元のファイル: ${oneLine(tokens.fileName)}(${tokens.spec}、トークン ${tokens.count} 個)。写しは ${code(tokens.files.tokens)}`,
    `- 変数の CSS: ${code(tokens.files.css)}。試作品の CSS の最後に読むと、Studio と同じ見た目になる。Studio がビルドのときに足すので、ソースには入っていない`,
    `- 記録: ${code(tokens.files.source)}(つないだ、外したの履歴)`,
    '',
    ...guideText,
  ];
}

// 形式 4(J8)の README の節。中身は handoff.json の purpose、design、review、quality、shows、materials.default と同じ
const PURPOSE_STATUS = { decided: '決めた', draft: '下書き(「決めた」の印がない)', interviewing: '聞き出しの途中(「決めた」の印がない)', skipped: '飛ばした' };

function purposeLines(purpose) {
  const lines = ['## 目的の文書', ''];
  if (purpose.status === 'none') {
    lines.push('目的の文書はありません(Studio の目的の画面で聞き出していない)。目的は、上の書き出した人のメモと、下の目録の意図で読みます。', '');
    return lines;
  }
  const when = purpose.status === 'decided' ? `(${localTime(purpose.decidedAt)})` : purpose.status === 'skipped' ? `(${localTime(purpose.skippedAt)})` : '';
  lines.push(
    'Studio の目的の画面で、人が書いた文書です。「決めた」の印は、人が「これで決める」を押したときだけ付きます。',
    '',
    `- 状態: ${PURPOSE_STATUS[purpose.status] ?? cell(purpose.status)}${when}`,
    ...(purpose.sentence ? [`- 最初の 1 文: ${oneLine(purpose.sentence)}`] : []),
    '',
  );
  if (!purpose.doc) return lines;
  const list = (items) => (items.length > 0 ? items.join('、') : '(なし)');
  lines.push(
    '| 項目 | 中身 |',
    '|---|---|',
    ...['who', 'problem', 'scene', 'success'].map((field) => `| ${PURPOSE_LABELS[field]} | ${cell(purpose.doc[field] || '(書かれていません)')} |`),
    `| ${PURPOSE_LABELS.notDoing} | ${cell(list(purpose.doc.notDoing))} |`,
    `| ${PURPOSE_LABELS.undecided} | ${cell(list(purpose.doc.undecided))} |`,
    '',
  );
  return lines;
}

const DESIGN_STATUS = { decided: '決めた', drafting: '決めている途中(「この設計で作る」を押していない)', skipped: '飛ばした' };

function designLines(design) {
  const lines = ['## 設計の段ごとの決定と理由', ''];
  if (design.status === 'none') {
    lines.push('設計の段ごとの決定はありません(Studio の設計の案内を使っていない)。', '');
    return lines;
  }
  const when = design.status === 'decided' ? `(${localTime(design.decidedAt)})` : design.status === 'skipped' ? `(${localTime(design.skippedAt)})` : '';
  lines.push(
    `Studio の設計の案内で、人が段ごとに案を選んだ記録です。AI か Studio が案を出し、選んだのは人です。理由は選んだ案に付いていた理由で、${design.optionsDate ? `案を出した日(${design.optionsDate})の` : ''}推測です。測った結果ではありません。`,
    '',
    `- 状態: ${DESIGN_STATUS[design.status] ?? cell(design.status)}${when}`,
    '',
    '| 段 | 決めたこと | 理由 | 選んだ人のメモ | 選ばなかった案 |',
    '|---|---|---|---|---|',
    ...design.steps.map((step) => {
      const decided = step.decision ? `${cell(step.decision)}${step.stale ? '(**確かめ直しが要る**: 前の段を選び直した)' : ''}` : '(まだ選んでいない)';
      const reason = step.decision ? (step.reason ? cell(step.reason) : step.chosen === 'custom' ? '(自分の言葉で決めた)' : '') : '';
      return `| ${cell(step.label)} | ${decided} | ${reason} | ${cell(step.note ?? '')} | ${cell(step.others.map((o) => o.title).filter(Boolean).join('、'))} |`;
    }),
    '',
  );
  if (design.scenes.length > 0) {
    lines.push(
      '場面の段で決めた場面(自動で試す場面の一覧の下書き):',
      '',
      '| 種類 | 場面 |',
      '|---|---|',
      ...design.scenes.map((scene) => `| ${cell(SCENE_CATEGORIES[scene.category]?.label ?? scene.category)} | ${cell(scene.text)} |`),
      '',
    );
  }
  if (design.composition?.rejected.length > 0) {
    lines.push(
      '構成の段で選ばなかった形と理由:',
      '',
      ...design.composition.rejected.map((item) => `- ${oneLine(SHAPE_LABELS[item.option] ?? item.option)}: ${oneLine(item.reason || '(理由なし)')}`),
      ...(design.composition.outOfOrder ? ['- 簡単な形から順の問いを飛ばして、難しい形を選んだ。'] : []),
      '',
    );
  }
  return lines;
}

const REVIEW_STATUS = {
  approved: '承認済み',
  drafting: '承認の途中',
  stopped: '**承認と違う構成**(作るループの関門 GA で止めた)',
  skipped: '審査なし(飛ばした)',
  missing: '**AI 構成書を読めない**(審査が要る試作品)',
  none: '審査なし(この試作品は審査を受けていない)',
};
const EVIDENCE_LABELS = { unmeasured: 'まだ測っていない', mock: 'お試しの AI で回した(形の確かめだけ)', real: '本物の AI で回した' };

function reviewLines(review) {
  const lines = ['## AI 構成の審査(AI 構成書)', ''];
  lines.push(`- 状態: ${REVIEW_STATUS[review.status] ?? cell(review.status)}`);
  if (review.skipped) lines.push(`- 飛ばした: ${localTime(review.skipped.at)}${review.skipped.by ? `、${oneLine(review.skipped.by)}` : ''}。理由: ${oneLine(review.skipped.reason || '(書かれていない)')}`);
  if (!review.record) {
    lines.push('', 'AI 構成書はありません。', '');
    return lines;
  }
  const { record } = review;
  lines.push(
    `- 今の構成と AI 構成書: ${review.matches ? '同じ(承認した構成のまま)' : `**承認と違う**(変わった項目: ${review.changed.map((id) => review.items.find((item) => item.id === id)?.label ?? id).join('、')})`}`,
    `- 構成: ${oneLine(SHAPE_LABELS[record.composition?.shape] ?? record.composition?.shape ?? '不明')}`,
    `- 数: ${EVIDENCE_LABELS[record.evidence?.status] ?? '不明'}${review.approvedUnmeasured ? '。測らずに承認した' : ''}`,
    ...(review.approvedAt ? [`- 4 つの承認がそろった日時: ${localTime(review.approvedAt)}`] : []),
    '',
    '作る前に、人が 4 つを読んで承認した記録です。名前は押した人の申告で、Studio は本人を確かめていません。AI 構成書の写しの全体は handoff.json の `review.record` にあります。',
    '',
    '| 項目 | 承認 | 承認した人(役) | 日時 |',
    '|---|---|---|---|',
    ...review.items.map((item) => {
      const by = item.by.map((entry) => `${entry.pressedBy ?? '(名前なし)'}(${entry.roleLabel})${entry.valid ? '' : '、中身が変わったので効かない'}`).join('、');
      return `| ${cell(item.label)} | ${item.approved ? '承認済み' : 'まだ'} | ${cell(by || '(なし)')} | ${cell(item.by.map((entry) => localTime(entry.at)).join('、'))} |`;
    }),
    '',
  );
  return lines;
}

const QUALITY_STATUS = { fix: '直す', ok: '問題なし', info: '目安なし', unseen: 'まだ見ていない', na: '当てはまらない' };
const QUALITY_GROUP_LABELS = { measured: '測ったもの', judged: 'AI の判断' };

function qualityLines(quality) {
  const { summary } = quality;
  const lines = [
    '## 質の見直し',
    '',
    'Studio の「質の見直し」の表と同じ中身です。測ったものと AI の判断を分けます。「まだ見ていない」の行は、確かめていません。',
    '',
    `- 直す ${summary.fix}、問題なし ${summary.ok}、目安なし ${summary.info}、まだ見ていない ${summary.unseen}、当てはまらない ${summary.na}`,
    `- 画面の検査: ${quality.audit ? `${localTime(quality.audit.at)}${quality.audit.viewport ? `、画面幅 ${oneLine(quality.audit.viewport)}` : ''}${quality.audit.stale ? '。**古い**(今の app/ か素材と違う状態で測った)' : ''}` : 'まだ測っていない'}`,
    `- 場面の回し: ${quality.scenes ? `${localTime(quality.scenes.at)}、${quality.scenes.real ? '本物の AI' : 'お試しの AI'}` : 'まだ回していない'}`,
    '',
    '| 種類 | 項目 | 状態 | 結果 |',
    '|---|---|---|---|',
    ...quality.rows.map((row) => `| ${QUALITY_GROUP_LABELS[row.group] ?? cell(row.group)} | ${cell(row.label)} | ${QUALITY_STATUS[row.status] ?? cell(row.status)} | ${cell(row.result)} |`),
    '',
  ];
  const places = quality.rows.filter((row) => row.status === 'fix' && row.places.length > 0);
  for (const row of places) lines.push(`「${oneLine(row.label)}」の場所:`, '', ...row.places.map((place) => `- ${oneLine(place)}`), '');
  return lines;
}

function showLines(shows) {
  const lines = ['## 人に見せた答え', ''];
  if (shows.records.length === 0) {
    lines.push('試作品を人に見せた答えはありません。', '');
    return lines;
  }
  lines.push(`Studio の「人に見せる」で、試作品を見せて聞いた答えです(${shows.records.length} 回)。見せた相手は、名前でなく役(「同僚」など)で書く決まりです。`, '');
  for (const record of shows.records) {
    const version = `保存 ${record.versionNumber}${record.versionName ? `「${oneLine(record.versionName)}」` : ''}`;
    lines.push(
      `### ${localTime(record.answeredAt)}(${version}${record.viewer ? `、相手: ${oneLine(record.viewer)}` : ''})`,
      '',
      '| 問い | 答え |',
      '|---|---|',
      ...record.answers.map((item) => `| ${cell(item.question)} | ${cell(item.answer)} |`),
      '',
    );
  }
  return lines;
}

function defaultMaterialLines(material) {
  if (!material) return [];
  const imported = material.packages.filter((item) => item.imported);
  return [
    '## 素材の出典とライセンス',
    '',
    `試作品は、Studio が同梱する${oneLine(material.name)}(npm のパッケージ)で作れます。出典とライセンスの一覧は ${code(material.file)}、ライセンスの文は ${code('materials/default/licenses/')} にあります。`,
    '',
    `- ライセンス: ${Object.entries(material.licenses).map(([name, count]) => `${name} ${count} 個`).join('、')}`,
    `- 試作品が import しているもの: ${imported.length > 0 ? imported.map((item) => `${item.name} ${item.version}(${item.license})`).join('、') : '(なし)'}`,
    '',
    '| 役 | パッケージ | 中身 |',
    '|---|---|---|',
    ...material.roles.map((role) => `| ${cell(role.role)} | ${role.package ? code(role.package) : '(なし)'} | ${cell(role.about)} |`),
    '',
  ];
}

// 確かめていないこと(vision.md の原則 7「信頼できる」)。質の見直しの「まだ見ていない」の行と、見せていない、測らずに承認した、の印から作る
function uncheckedLines(h) {
  const items = [
    ...h.quality.rows.filter((row) => row.status === 'unseen').map((row) => `${row.label}: ${row.result}`),
    ...(h.shows.records.length === 0 ? ['人に見せて確かめていない(人に見せた答えがない)。'] : []),
    ...(h.review.record && h.review.record.evidence?.status === 'unmeasured' ? ['AI 構成を、場面を回した数で確かめていない(まだ測っていない)。'] : []),
    '本物のデータ、本番の環境、多くの人の利用では試していない(試作品は架空のデータだけで試す)。',
  ];
  return ['## 確かめていないこと', '', ...items.map((item) => `- ${oneLine(item)}`), ''];
}

function renderReadme(h) {
  const lines = [];
  const push = (...items) => lines.push(...items);
  push(
    `# 引き継ぎ: ${oneLine(h.project.title)}`,
    '',
    `Prototype Studio で作った試作品を、本番開発の担当者に渡す資料です。${h.createdAtLocal} に書き出しました。`,
    '試作品は、体験を確かめるためのものです。本番の品質ではありません。',
    '',
    '## 区分の意味',
    '',
    '| 区分 | 意味 |',
    '|---|---|',
    '| 実機 | 試作品の中で、本物が動いている |',
    '| モック | 決まった規則や架空のデータが、本物の代わりをしている |',
    '| 未接続 | 試作品にはない。本番で作る |',
    '',
    '## 目的',
    '',
    noteBlock(h.notes.purpose),
    '',
    ...purposeLines(h.purpose),
    ...prototypeLines(h.prototype),
    ...closingReadmeLines({ ...h.closing, requirements: h.requirements, dataDesign: h.dataDesign, fixRecords: h.fixRecords }),
    ...designLines(h.design),
    ...reviewLines(h.review),
    '## 決まったこと',
    '',
    noteBlock(h.notes.decided),
    '',
    '## 未決事項',
    '',
    '### 書き出した人が書いたもの',
    '',
    noteBlock(h.notes.undecided),
    '',
    '### Studio が見つけたこと(自動)',
    '',
    ...(h.openQuestions.length > 0 ? h.openQuestions.map((q) => `- ${oneLine(q)}`) : ['(ありません)']),
    '',
    '## 実機・モック・未接続の一覧',
    '',
    '| 区分 | 項目 | 試作品での中身 | 本番でやること |',
    '|---|---|---|---|',
    ...h.capabilities.map((row) => `| ${KIND_LABELS[row.kind]} | ${cell(row.item)} | ${cell(row.prototype)} | ${cell(row.production)} |`),
    '',
  );

  if (h.ai) {
    const { ai } = h;
    push(
      '## プロダクト内 AI',
      '',
      `- 名前: ${oneLine(ai.name)}`,
      `- 書き出したときの接続: ${ai.connection.label}${ai.connection.real ? '(実際の AI モデル)' : '(実際の AI モデルではない)'}`,
      '- 設定: `app/ai.json`',
      '- 実モデルに渡す指示の全文: `ai/system-prompt.md`(抽出の指示と、言い方の指示。言い方は ai.json の instructions に Studio の決まりを足したもの)',
      '- 応答の形(JSON スキーマ): `ai/response-schema.json`(extract は抽出の形、phrase は言い方の形 `{reply}`)',
      '',
      '覚える項目:',
      '',
      '| key | 名前 | 決まり | 最初の値 |',
      '|---|---|---|---|',
      ...ai.fields.map((field) => `| \`${field.key}\` | ${cell(field.label)} | ${cell(fieldRule(field))} | ${cell(formatValue(field, ai.initialState[field.key]))} |`),
      '',
      '## 試した会話と状態',
      '',
      h.conversation.initial
        ? 'まだ話していません。最初の状態です。'
        : `書き出したときの会話です(${h.conversation.messages.length} 件)。「接続」の列で、モックの応答と実際の AI モデルの応答を区別できます。`,
      '',
      '| # | 誰 | 接続 | 内容 |',
      '|---|---|---|---|',
      ...h.conversation.messages.map((m, i) => {
        const via = m.role !== 'assistant' ? '' : `${m.viaLabel}${m.real ? '(実モデル)' : ''}`;
        return `| ${i + 1} | ${ROLE_LABELS[m.role] ?? m.role} | ${cell(via)} | ${cell(m.text)} |`;
      }),
      '',
      'そのときの状態:',
      '',
      '| key | 名前 | 値 |',
      '|---|---|---|',
      ...h.conversation.state.map((s) => `| \`${s.key}\` | ${cell(s.label)} | ${cell(s.shown)} |`),
      '',
    );
  } else {
    push('## プロダクト内 AI', '', 'この試作品は、プロダクト内 AI を使っていません(`app/ai.json` がありません)。', '');
  }

  push(
    ...simulationLines(h.simulation),
    ...scenarioLines(h.scenarios),
    ...evidenceLines(h.evidence),
    ...qualityLines(h.quality),
    ...showLines(h.shows),
    ...defaultMaterialLines(h.materials.default),
    ...materialLines(h.materials),
  );
  push(
    '## ソース',
    '',
    `- 入口: ${h.source.entry ? code(h.source.entry) : '(見つかりません)'}`,
    `- 使えるライブラリ: ${h.source.libraries.join('、')}(Studio が同梱するもの。ほかは import できない)`,
    ...(h.source.studioParts.length > 0 ? [`- Studio の中の部品: ${h.source.studioParts.join('、')}(試作品が import している。部品のコードは書き出しに入らない)`] : []),
    `- 版: ${h.working.text}`,
    '',
    '| ファイル | バイト |',
    '|---|---|',
    ...h.source.files.map((f) => `| ${code(f.path)} | ${f.bytes} |`),
    '',
  );
  if (h.versions.length > 0) {
    push(
      '保存した版:',
      '',
      '| 版 | 名前 | 種類 | 保存した日時 |',
      '|---|---|---|---|',
      ...h.versions.map((v) => `| v${v.number} | ${cell(v.name || '(名前なし)')} | ${v.kind === 'auto' ? '自動' : '手動'} | ${localTime(v.savedAt)} |`),
      '',
    );
  }
  push('## 変更の経緯', '');
  if (h.requests.length > 0) {
    push(
      '作る欄に送った依頼です。Studio を起動してからのものだけで、起動し直す前の依頼は残っていません。',
      '',
      '| 日時 | 依頼 | 結果 | 変わったファイル |',
      '|---|---|---|---|',
      ...h.requests.map((r) => `| ${localTime(r.startedAt)} | ${cell(r.request)} | ${RUN_LABELS[r.status] ?? r.status} | ${cell(r.changedFiles.map((c) => c.file).join('、'))} |`),
      '',
    );
  } else {
    push('Studio を起動してから、作る欄の依頼はありません(起動し直す前の依頼は残っていません)。', '');
  }
  push(
    ...uncheckedLines(h),
    '## 入れていないもの',
    '',
    '- 秘密情報。Studio は書き出す前に、API キーやトークンらしい文字列を探す。見つかったら書き出さない。',
    ...(h.excluded.length > 0 ? [`- 秘密を入れるファイル: ${h.excluded.map((e) => code(e.path)).join('、')}`] : []),
    '- AI の実行の記録(AI に渡した本文の全文を含む)、作る AI の返事、ログインの情報、環境変数、PC のフォルダーの場所。',
    '- 作る run の記録の全体と、観察のスクリーンショット。要約だけを「最新の証拠」と handoff.json の `evidence` に入れた。',
    '- 場面の回しの結果の全体と、その記録(.studio/evals/)。要約だけを「場面(確かめ方)と最新の回し」と handoff.json の `simulation.latestRun` に入れた。',
    '- 目的の聞き出しの問いと答えの全部、案を出す AI の返事の全部、質の見直しの「直す」の依頼の文。決めた文書、選んだ案と理由、表の結果だけを入れた。',
    '- 会話、目的の文書、設計のメモ、人に見せた答え、要件の文書、データ設計、直した記録、未決事項の持ち主の中の、メールアドレス、電話番号、住所、氏名らしい文字列は伏せた(`[伏せた: …]`)。',
    '',
    '## 試作品を動かす',
    '',
    '- Prototype Studio で開く: `app/` を `~/PrototypeStudio/projects/<英小文字・数字・ハイフンの名前>/app/` に写し、Studio を起動して一覧から選ぶ。',
    '- Studio の外では、`window.studio.ai` がないので、プロダクト内 AI の部分は動かない。',
    '- 機械で読むときは `handoff.json` を使う(形は Prototype Studio の docs/handoff.md)。',
    '',
  );
  return lines.join('\n');
}

function workingText(working, versions) {
  const version = versions.find((v) => v.id === working.versionId);
  const label = version ? `保存版 v${version.number}${version.name ? `「${version.name}」` : ''}` : null;
  if (working.files === 'none') return '版を保存していない作業中から書き出した';
  if (working.files === 'changed') return '保存した版のどれとも違う作業中から書き出した';
  if (working.conversation === 'changed') return `ファイルは${label}と同じ。会話はそのときから進んでいる`;
  if (working.conversation === 'initial') return `ファイルは${label}と同じ。会話は最初のまま`;
  return `${label}と同じ`;
}

// 試作品の引き継ぎ。書き出し先は <STUDIO_HOME>/handoffs/<試作品の ID>-<日時>/。
// 作る AI が読み書きする app/ とも、Studio だけが書く .studio/ とも別の場所にする。
export class ProjectHandoffs {
  constructor({ home, store, aiSessions, versions, requests, log = () => {} }) {
    this.dir = path.join(home, 'handoffs');
    this.store = store;
    this.aiSessions = aiSessions;
    this.versions = versions;
    this.requests = requests;
    this.log = log;
  }

  notesFile(paths) {
    return path.join(paths.studio, NOTES_FILE);
  }

  async readNotes(paths) {
    try {
      return cleanNotes(JSON.parse(await fs.readFile(this.notesFile(paths), 'utf8')));
    } catch {
      return cleanNotes({});
    }
  }

  // 画面に出す。前に書いたメモと、最後に書き出した場所
  async view(id) {
    const paths = await this.store.requireProject(id);
    return { notes: await this.readNotes(paths), last: await this.last(id) };
  }

  async last(id) {
    const entries = await fs.readdir(this.dir, { withFileTypes: true }).catch(() => []);
    const found = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith(`${id}-`)) continue;
      try {
        const manifest = JSON.parse(await fs.readFile(path.join(this.dir, entry.name, 'handoff.json'), 'utf8'));
        if (manifest.format === HANDOFF_FORMAT && manifest.project?.id === id) {
          found.push({ dir: path.join(this.dir, entry.name), name: entry.name, createdAt: manifest.createdAt });
        }
      } catch {
        // 書きかけや、壊れたもの
      }
    }
    return found.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0] ?? null;
  }

  async export(id, rawNotes) {
    const notes = cleanNotes(rawNotes);
    const paths = await this.store.requireProject(id);
    const project = (await this.store.list()).find((p) => p.id === id);
    // 版の保存と同じ印を使い、作る AI、ビルド、版の操作、プロダクト内 AI への発言と同時には書き出さない
    this.store.claimVersions(id);
    const createdAt = new Date();
    let name = `${id}-${stamp(createdAt)}`;
    if (await fs.lstat(path.join(this.dir, name)).catch(() => null)) name = `${name}-${crypto.randomBytes(2).toString('hex')}`;
    const tmp = path.join(this.dir, `.${name}.tmp`);
    try {
      if (this.aiSessions.isBusy(id)) throw new BusyError('試作品の中の AI が返事をしているところです。終わってから渡すフォルダーを作ってください');
      // 前に書いたメモは、次に開いたときに出す。書き出しに失敗しても残す
      await fs.mkdir(paths.studio, { recursive: true });
      await fs.writeFile(this.notesFile(paths), `${JSON.stringify(notes, null, 2)}\n`);

      const excluded = [];
      const appCopy = path.join(tmp, 'app');
      try {
        await copyTree(paths.app, appCopy, {
          skip: (relative) => {
            if (!SECRET_FILES.some((pattern) => pattern.test(relative))) return false;
            excluded.push({ path: `app/${relative}`, reason: '秘密を入れるファイル' });
            return true;
          },
        });
      } catch (error) {
        if (error instanceof VersionError) throw new HandoffError(error.status, error.code, error.message.replace('保存できません', '本番開発へ渡せません'));
        throw error;
      }
      // 写しをビルドして確かめる。写しの AI の設定を、書き出す設定にする
      const build = await buildApp({ appDir: appCopy, buildsDir: path.join(tmp, 'builds'), projectRoot: paths.root }).catch((error) => ({
        ok: false,
        errors: [{ file: 'app/', text: error.message }],
      }));
      await fs.rm(path.join(tmp, 'builds'), { recursive: true, force: true });
      if (!build.ok) {
        const first = build.errors[0];
        this.log(`書き出しませんでした(ビルドできない状態): ${id}(${first ? `${first.file}: ${first.text}` : '理由はわかりません'})`);
        throw new HandoffError(422, 'build', '表示できない状態は、本番開発へ渡せません。「言葉で直す」で直してもらってから、渡すフォルダーを作ってください');
      }
      const scan = await scanFiles(appCopy);
      if (scan.secrets.length > 0) {
        throw new HandoffError(
          422,
          'secret',
          `秘密情報らしい文字列があるので、書き出しませんでした。消してから書き出してください(${scan.secrets
            .slice(0, 5)
            .map((s) => `${where(s)} ${s.kind}`)
            .join('、')})`,
        );
      }

      const definition = build.ai ?? null;
      const prototype = describePrototype(build.manifest);
      const scenarios = await describeScenarios(appCopy, prototype, definition);
      // 証拠が今の app/ と同じ中身で確かめたものかは、Studio のビルドと同じ指紋で比べる
      const appDigest = digestSnapshot(await snapshotApp(paths.app));
      const evidence = await latestEvidence(paths, appDigest);
      const simulation = describeSimulation(build.simulation, await latestEvalRun(paths, appDigest));
      const conversation = definition
        ? describeConversation(definition, this.aiSessions.snapshot(id, definition), this.aiSessions.connections)
        : null;
      const selected = this.aiSessions.connectionOf(id);
      const material = await readTokenMaterial(paths.root);
      const guides = await readGuideMaterial(paths.root);
      const { versions: versionList, working } = await this.versions.list(id);
      // 形式 4(J8)。決めたことと理由、質の見直し、人に見せた答え、AI 構成書(書き出す app/ の写しの指紋と比べる)、既定の素材
      const purpose = await describePurpose(paths);
      const design = await describeDesign(paths);
      const quality = await describeQuality({ paths, simulation: build.simulation, result: await latestEvalResult(paths.root) });
      const shows = await describeShows({ paths, purpose, versions: versionList });
      const review = await describeReview({ paths, appDir: appCopy });
      const defaultMaterial = await describeDefaultMaterial(scan.packages);
      // 会の終わりの成果物(K5)。画面と同じ関数で作り、人が書いた文を伏せる
      const board = await readBoard(paths);
      const closing = redactClosing(
        describeClosing({
          purpose,
          design,
          review,
          board,
          comments: await readComments(paths),
          records: await readFixRecords(path.join(paths.studio, FIX_RECORDS_DIR)),
          dataDesign: await describeDataDesign(paths, board),
          simulation: build.simulation,
          ai: definition,
          evidence,
          latestRun: simulation.latestRun,
          owners: await readOwners(paths),
        }),
      );
      const manifest = {
        format: HANDOFF_FORMAT,
        formatVersion: HANDOFF_FORMAT_VERSION,
        createdAt: createdAt.toISOString(),
        studioVersion: await studioVersion(),
        project: { id, title: redact(project?.title ?? id) },
        notes: redactDeep(notes),
        working: { ...working, text: workingText(working, versionList) },
        capabilities: capabilities({ fileCount: scan.files.length, ai: definition, conversation, scan, prototype, simulation }),
        openQuestions: [
          ...(notes.undecided ? [{ from: 'person', text: redact(notes.undecided) }] : []),
          ...studioQuestions({ ai: definition, conversation, working, scan, excluded, evidence, simulation }).map((text) => ({ from: 'studio', text })),
          ...decisionQuestions({ purpose, design, quality, shows, review }).map((text) => ({ from: 'studio', text })),
          ...(closing.unowned > 0 ? [{ from: 'studio', text: `持ち主のない未決事項が ${closing.unowned} 件ある(「会の終わりの成果物」の「未決事項の持ち主と期日」)。` }] : []),
        ],
        prototype,
        scenarios,
        evidence,
        // 構成、ツール、前提、プロンプトの枠、場面、最新の場面の回しの要約(docs/design/agent-simulation.md の 4.5、S7)
        simulation,
        // 目的の文書(J1)、設計の段ごとの決定と理由(J2)、質の見直しの結果(J6)、人に見せた答え(J7)、AI 構成書と承認の記録(task 422)
        purpose,
        design,
        quality,
        shows,
        review,
        // 会の終わりの成果物(K5)。要件の文書、データ設計、直した記録の一覧と、7 つの成果物の状態、構成の図、未決事項の持ち主と期日
        requirements: closing.requirements,
        dataDesign: closing.dataDesign,
        fixRecords: closing.fixRecords,
        closing: { present: closing.present, deliverables: closing.deliverables, figure: closing.figure, openItems: closing.openItems, unowned: closing.unowned },
        ai: definition
          ? {
              name: definition.name,
              file: 'app/ai.json',
              connection: { kind: selected.kind, label: selected.label, real: Boolean(selected.billing) },
              fields: definition.fields,
              initialState: definition.initialState,
              mock: definition.mock,
              systemPromptFile: 'ai/system-prompt.md',
              responseSchemaFile: 'ai/response-schema.json',
            }
          : null,
        conversation,
        source: {
          entry: prototype.entry ? `app/${prototype.entry}` : null,
          // npm のパッケージだけ。Studio の中の会話の枠(studio-talk)は書き出しに入らない。試作品が import していれば studioParts に出す
          libraries: NPM_LIBRARIES,
          studioParts: scan.studioParts,
          files: scan.files,
          signs: scan.signs,
          // 目録の data があればその宣言、なければファイルの名前と中からの推定
          dataFiles: prototype.data.length > 0 ? prototype.data.map((d) => `app/${d.file}`) : scan.dataFiles,
          dataFrom: prototype.data.length > 0 ? 'manifest' : 'guess',
          personalData: scan.personal,
        },
        versions: versionList.map((v) => ({ number: v.number, name: redact(v.name), kind: v.kind, savedAt: v.savedAt, builds: v.builds })),
        requests: this.requests.list(id).map((run) =>
          redactDeep({ request: run.request, status: run.status, startedAt: run.startedAt, changedFiles: run.changedFiles ?? [] }),
        ),
        excluded,
        // 素材の出典とライセンス。既定の素材(J3)はいつも。つないだトークン(J4)と有効にした部品と指針(J5)は、あるときだけ
        materials: {
          default: defaultMaterial,
          ...(material ? { tokens: describeTokens(material) } : {}),
          ...(guides ? { guides: describeGuides(guides.records) } : {}),
        },
      };

      const readme = renderReadme({
        ...manifest,
        openQuestions: manifest.openQuestions.filter((q) => q.from === 'studio').map((q) => q.text),
        createdAtLocal: createdAt.toLocaleString('ja-JP'),
      });
      const outputs = [
        ['README.md', readme],
        ['handoff.json', `${JSON.stringify(manifest, null, 2)}\n`],
        ...(material
          ? [
              [MATERIAL_FILES.tokens, material.text],
              [MATERIAL_FILES.css, material.css],
            ]
          : []),
        ...(material || guides ? [[MATERIAL_FILES.source, `${JSON.stringify(materialSourceCopy(material?.source ?? guides?.source ?? {}), null, 2)}\n`]] : []),
        // 既定の素材の出典の記録とライセンスの文(Studio の materials/default/ の写し)
        ...(defaultMaterial ? await defaultMaterialFiles() : []),
        ...(definition
          ? [
              // 実モデルは抽出と言い方の 2 種の呼び出しで動く。それぞれの指示と応答の形を書く
              [
                'ai/system-prompt.md',
                `# 抽出の指示\n\n${extractPrompt(definition)}\n\n# 言い方の指示\n\n${phrasePrompt(definition)}\n`,
              ],
              [
                'ai/response-schema.json',
                `${JSON.stringify({ extract: extractSchema(definition), phrase: phraseSchema() }, null, 2)}\n`,
              ],
            ]
          : []),
      ];
      // app/ の外から足した中身(証拠の要約など)にも、ソースと同じく秘密を探す。見つけたら書き出さない
      const secrets = outputs.flatMap(([file, text]) => findSecrets(text).map((found) => ({ file, ...found })));
      if (secrets.length > 0) {
        throw new HandoffError(
          422,
          'secret',
          `書き出す資料に秘密情報らしい文字列があるので、書き出しませんでした。最新の作る run の記録から入ったものなら、試作品を直して作る欄で確かめ直してから書き出してください(${secrets
            .slice(0, 5)
            .map((s) => `${where(s)} ${s.kind}`)
            .join('、')})`,
        );
      }
      for (const [file, text] of outputs) {
        await fs.mkdir(path.dirname(path.join(tmp, file)), { recursive: true });
        await fs.writeFile(path.join(tmp, file), text);
      }
      await fs.rename(tmp, path.join(this.dir, name));
      this.log(`引き継ぎを書き出しました: ${id}(${name})`);
      const count = (kind) => manifest.capabilities.filter((row) => row.kind === kind).length;
      return {
        handoff: {
          dir: path.join(this.dir, name),
          name,
          createdAt: manifest.createdAt,
          counts: { real: count('real'), mock: count('mock'), missing: count('missing'), questions: manifest.openQuestions.length },
          excluded,
        },
        notes,
        last: { dir: path.join(this.dir, name), name, createdAt: manifest.createdAt },
      };
    } catch (error) {
      await fs.rm(tmp, { recursive: true, force: true });
      throw error;
    } finally {
      this.store.releaseVersions(id);
    }
  }
}
