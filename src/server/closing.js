import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { REVIEW_ITEMS, compositionFigure } from './architecture.js';
import { COMMENTS_FILE, COMMENT_KINDS, COMMENT_STATUS_WORDS, FIX_RECORD_FORMAT, readFixRecords } from './comments.js';
import { FIELD_KINDS } from './data-design.js';
import { describeDesign, describePurpose, describeReview } from './handoff-decisions.js';
import { IntentError } from './intent.js';
import { FIX_RECORDS_DIR, NOT_ERASABLE } from './meeting.js';
import { COLUMNS } from './organize-ai.js';
import { ORGANIZE_FILE, asksOf, isGuess } from './organize.js';
import { isValidProjectId } from './projects.js';
import { findRecords, redact, redactDeep } from './redact.js';
import { NotFoundError } from './store.js';
import { describeTimeline, durationWords, readTimeline } from './timeline.js';

// 会の終わりの成果物(docs/design/user-journey.md の K5、docs/design/field-session.md の段 7 と 3 節)。
// 7 つの成果物(要件の文書、データ設計、構成の図、AI 構成書、試作品、場面の一覧、未決事項)を、Studio が持つ記録から読んでまとめる。
// 読むだけで、AI は呼ばない。人が書くのは、未決事項の持ち主と期日だけ(.studio/closing.json)。
// 要件の文書は、目的の文書(J1)と整理の板(K1)と、2 人が承認した要件のコメント(K3)から作る。各項目に、元の要点か、承認したコメントを付ける。
// 引き継ぎ(handoff.js)は同じ関数で、要件の文書、データ設計、直した記録の一覧、7 つの成果物と未決事項の持ち主を書き出す。

export const CLOSING_FILE = 'closing.json';
const FORMAT = 1;
export const CLOSING_LIMITS = Object.freeze({ maxOwner: 40 });

// 7 つの成果物(field-session.md の 3 節の表の順)。where は引き継ぎの handoff.json の中の場所
export const DELIVERABLES = Object.freeze([
  { id: 'requirements', label: '要件の文書', where: ['requirements'] },
  { id: 'dataDesign', label: 'データ設計', where: ['dataDesign'] },
  { id: 'composition', label: '構成の図', where: ['closing.figure', 'simulation.compositions', 'design.composition'] },
  { id: 'review', label: 'AI 構成書', where: ['review'] },
  { id: 'prototype', label: '試作品', where: ['app/', 'evidence'] },
  { id: 'scenes', label: '場面の一覧', where: ['simulation.evals', 'simulation.latestRun', 'design.scenes'] },
  { id: 'openItems', label: '未決事項', where: ['closing.openItems'] },
]);

// 成果物の状態。ready はそろった、draft は下書き(あるが、確かめ切っていない)、missing はない
export const DELIVERABLE_STATUS = Object.freeze({ ready: 'そろった', draft: '下書き', missing: 'ない' });

// 要件の文書の節(field-session.md の 3 節の「中身」の順)
export const REQUIREMENT_SECTIONS = Object.freeze([
  { id: 'purpose', label: '目的' },
  { id: 'user', label: '使う人' },
  { id: 'scene', label: '場面' },
  { id: 'requirement', label: '要求' },
  { id: 'rule', label: '決まりごと' },
  { id: 'notDoing', label: 'しないこと' },
  { id: 'success', label: '成功の印' },
]);

// 未決事項の出どころ
export const OPEN_ITEM_FROM = Object.freeze({
  conflict: '整理の板(矛盾)',
  unasked: '整理の板(聞いていないこと)',
  guess: '整理の板(推測のまま)',
  empty: '整理の板(空の欄)',
  purpose: '目的の文書(決めていないこと)',
  design: '設計の案内',
  review: 'AI 構成の審査',
  comment: '画面へのコメント',
});

// 要件のコメントのうち、要件の文書に載せるもの(2 人が承認し、戻していない、落ちていない、閉じていない)。
// awaiting は共有の場で 2 人の承認がそろい、進行役が送るのを待つもの(K7 の 3 枚目)
const REQUIREMENT_LIVE = new Set(['awaiting', 'queued', 'fixing', 'review', 'resolved']);
// まだ片付いていないコメント(未決事項に出す)
const UNSETTLED = { open: 'まだ承認していない', awaiting: '承認はそろったが、進行役がまだ作る AI に送っていない', queued: '承認したが、列で待っている', fixing: '直している途中', review: '直した版を、まだ確かめていない(「直った」を押していない)', failed: '直せなかった。「元に戻す」か「開き直す」を選んでいない' };

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const objects = (value) => (Array.isArray(value) ? value.filter(isObject) : []);
const str = (value) => (typeof value === 'string' ? value : '');
const keyOf = (prefix, text) => `${prefix}:${crypto.createHash('sha256').update(text).digest('hex').slice(0, 12)}`;

async function readJson(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

// 整理の板(.studio/organize.json)。形が違えば null(整理なし)
export async function readBoard(paths) {
  const board = await readJson(path.join(paths.studio, ORGANIZE_FILE));
  if (board?.formatVersion !== 1 || ![board.points, board.items, board.asks].every(Array.isArray)) return null;
  return {
    status: board.status === 'confirmed' ? 'confirmed' : 'draft',
    confirmedAt: typeof board.confirmedAt === 'string' ? board.confirmedAt : null,
    points: objects(board.points).filter((p) => Number.isSafeInteger(p.n) && typeof p.text === 'string'),
    items: objects(board.items)
      .filter((item) => typeof item.id === 'string' && typeof item.text === 'string' && Object.hasOwn(COLUMNS, item.column))
      .map((item) => ({ ...item, sources: Array.isArray(item.sources) ? item.sources.filter(Number.isSafeInteger) : [] })),
    asks: objects(board.asks).filter((ask) => typeof ask.id === 'string' && typeof ask.text === 'string'),
  };
}

// 画面へのコメント(.studio/comments.json)。読めなければ空
export async function readComments(paths) {
  const raw = await readJson(path.join(paths.studio, COMMENTS_FILE));
  return objects(raw?.comments).filter((c) => typeof c.id === 'string' && Number.isSafeInteger(c.number) && typeof c.text === 'string' && Object.hasOwn(COMMENT_KINDS, c.kind) && Object.hasOwn(COMMENT_STATUS_WORDS, c.status));
}

// 未決事項の持ち主と期日(.studio/closing.json)。{ [key]: { owner, due, at } }
export async function readOwners(paths) {
  const raw = await readJson(path.join(paths.studio, CLOSING_FILE));
  if (raw?.formatVersion !== FORMAT || !isObject(raw.owners)) return {};
  return Object.fromEntries(
    Object.entries(raw.owners)
      .filter(([, value]) => isObject(value) && typeof value.owner === 'string')
      .map(([key, value]) => [key, { owner: value.owner, due: typeof value.due === 'string' ? value.due : '', at: typeof value.at === 'string' ? value.at : null }]),
  );
}

// 要件の文書。目的の文書と整理の板と、2 人が承認した要件のコメントから作る。
// 各項目の from は purpose(目的の文書)、point(元の要点がある)、guess(推測。元の要点がなく、人も確かめていない)、checked(人が確かめた)、comment(承認したコメント)。
// データの欄はデータ設計に載せる(K2)ので、ここには入れない
export function describeRequirements({ purpose, board, comments = [], records = [] }) {
  const doc = purpose?.status && purpose.status !== 'none' && purpose.status !== 'skipped' ? purpose.doc : null;
  const pointText = new Map((board?.points ?? []).map((point) => [point.n, point.text]));
  const sections = Object.fromEntries(REQUIREMENT_SECTIONS.map((section) => [section.id, []]));
  const fromPurpose = (section, text, id) => {
    if (str(text).trim()) sections[section].push({ id, text: str(text), from: 'purpose', sources: [], guess: false, comment: null });
  };
  fromPurpose('purpose', doc?.problem || purpose?.sentence, 'purpose-problem');
  fromPurpose('user', doc?.who, 'purpose-who');
  fromPurpose('scene', doc?.scene, 'purpose-scene');
  (doc?.notDoing ?? []).forEach((text, i) => fromPurpose('notDoing', text, `purpose-not-${i + 1}`));
  fromPurpose('success', doc?.success, 'purpose-success');
  for (const item of board?.items ?? []) {
    if (item.column === 'data' || !sections[item.column]) continue;
    const guess = isGuess(item);
    sections[item.column].push({
      id: item.id,
      text: item.text,
      from: guess ? 'guess' : item.sources.length === 0 ? 'checked' : 'point',
      sources: item.sources.filter((n) => pointText.has(n)).map((n) => ({ n, text: pointText.get(n) })),
      guess,
      comment: null,
    });
  }
  // 2 人が承認した要件のコメント。項目から、そのコメントと直した記録へたどれるように、番号と記録の ID を付ける
  for (const comment of comments.filter((c) => c.kind === 'requirement' && REQUIREMENT_LIVE.has(c.status))) {
    const record = records.filter((r) => r.comment?.id === comment.id).at(-1) ?? null;
    sections.requirement.push({
      id: `comment-${comment.number}`,
      text: comment.text,
      from: 'comment',
      sources: [],
      guess: false,
      comment: { number: comment.number, status: comment.status, statusLabel: COMMENT_STATUS_WORDS[comment.status], recordId: record?.id ?? null },
    });
  }
  const all = Object.values(sections).flat();
  const guesses = all.filter((item) => item.guess).length;
  return {
    // confirmed は、決める人が整理の板で「この理解で合っている」を押した
    status: all.length === 0 ? 'none' : board?.status === 'confirmed' ? 'confirmed' : 'draft',
    confirmedAt: board?.confirmedAt ?? null,
    purposeStatus: purpose?.status ?? 'none',
    sections: REQUIREMENT_SECTIONS.map((section) => ({ ...section, items: sections[section.id] })),
    // 確かめた割合(field-session.md の 3 節の「何で測るか」)。推測の印が残っていない項目の割合
    counts: { items: all.length, guesses, checkedRatio: all.length === 0 ? null : Math.round(((all.length - guesses) / all.length) * 100) / 100 },
  };
}

// データ設計(.studio/design.json の steps.data。K2)。選んだ案の覚えておくもの、項目、つながり、誰が書くか。
// 整理の板のデータの欄も並べ、案に載っているかを付ける(案がなくても、聞いたことが落ちないように)
export async function describeDataDesign(paths, board) {
  const record = await readJson(path.join(paths.studio, 'design.json'));
  const step = isObject(record?.steps?.data) ? record.steps.data : null;
  const option = step && typeof step.chosen === 'string' ? objects(step.options).find((o) => o.id === step.chosen) ?? null : null;
  const entities = objects(option?.entities).map((entity) => ({
    name: str(entity.name),
    about: str(entity.about),
    writer: str(entity.writer),
    byStudio: entity.by === 'studio',
    fields: objects(entity.fields).map((field) => ({ name: str(field.name), kind: str(field.kind), kindLabel: FIELD_KINDS[field.kind] ?? str(field.kind), ...(field.to ? { to: str(field.to) } : {}), examples: Array.isArray(field.examples) ? field.examples.filter((e) => typeof e === 'string') : [], sources: Array.isArray(field.sources) ? field.sources.filter((s) => typeof s === 'string') : [] })),
  }));
  const cited = new Set(entities.flatMap((entity) => entity.fields.flatMap((field) => field.sources)));
  const heard = (board?.items ?? []).filter((item) => item.column === 'data').map((item) => ({ id: item.id, text: item.text, onDesign: cited.has(item.id) }));
  const status = record?.status === 'skipped' ? 'skipped' : !option ? 'none' : step.stale === true ? 'stale' : 'chosen';
  return {
    status,
    title: str(option?.title) || null,
    detail: str(option?.detail) || null,
    reason: str(option?.reason) || null,
    note: str(step?.note) || null,
    source: typeof step?.source === 'string' ? step.source : null,
    decidedAt: typeof step?.decidedAt === 'string' ? step.decidedAt : null,
    entities,
    links: objects(option?.links).map((link) => ({ from: str(link.from), to: str(link.to), label: str(link.label) })),
    heard,
  };
}

// 直した記録の一覧(K3。.studio/fix-records/)。コメント、承認、依頼、版、変わったもの、関門、確かめ。
// 要件のコメントの記録には、要件の文書の項目の ID(requirementItem)を付ける(項目から記録へ、記録から項目へたどれるように)
export function describeFixRecords(records, requirements = null) {
  const itemIds = new Set((requirements?.sections ?? []).flatMap((section) => section.items.map((item) => item.id)));
  return records
    .filter((record) => record?.format === FIX_RECORD_FORMAT && typeof record.id === 'string')
    .map((record) => {
      const comment = isObject(record.comment) ? record.comment : {};
      const itemId = comment.kind === 'requirement' ? `comment-${comment.number}` : null;
      return {
        id: record.id,
        status: str(record.status),
        createdAt: record.createdAt ?? null,
        comment: { number: comment.number ?? null, text: str(comment.text), kind: str(comment.kind), kindLabel: COMMENT_KINDS[comment.kind] ?? str(comment.kind), placeWords: str(comment.placeWords), author: typeof comment.author === 'string' ? comment.author : null, reactions: Number.isSafeInteger(comment.reactions) ? comment.reactions : 0 },
        approval: { approvers: objects(record.approval?.approvers).map((a) => ({ role: str(a.role), roleLabel: str(a.roleLabel), pressedBy: typeof a.pressedBy === 'string' ? a.pressedBy : null, spokenBy: typeof a.spokenBy === 'string' ? a.spokenBy : null, at: a.at ?? null })), completedAt: record.approval?.completedAt ?? null },
        request: str(record.request?.text),
        versions: { before: versionOf(record.versions?.before), after: versionOf(record.versions?.after) },
        changes: { files: Array.isArray(record.changes?.files) ? record.changes.files.filter((f) => typeof f === 'string') : [], summary: typeof record.changes?.summary === 'string' ? record.changes.summary : null, requirementItems: Array.isArray(record.changes?.requirementItems) ? record.changes.requirementItems.filter((item) => typeof item === 'string') : [] },
        // 要件の文書の中の項目。戻した、落ちた要件のコメントは文書に載らないので null
        requirementItem: itemId && itemIds.has(itemId) ? itemId : null,
        gates: { status: record.gates?.status ?? null, run: record.gates?.run ?? null, results: objects(record.gates?.results).map((g) => ({ id: g.id ?? null, label: str(g.label), status: str(g.status) })) },
        // 「直った」と「戻した」を押した人(押した人と声に出した人)と日時
        confirmation: isObject(record.confirmation) ? record.confirmation : {},
        events: objects(record.events).map((e) => ({ type: str(e.type), label: str(e.label), at: e.at ?? null, ...(typeof e.note === 'string' ? { note: e.note } : {}) })),
      };
    });
}

// 未決事項。整理の板の聞くこと(矛盾、聞いていないこと、推測のまま、空の欄)、目的の文書の決めていないこと、
// 設計の確かめ直し、AI 構成の審査の途中、片付いていないコメント。key は持ち主と期日を結ぶ印(文が変わると別の未決事項になる)
export function describeOpenItems({ board, purpose, design, review, comments = [], owners = {} }) {
  const items = [];
  const add = (key, from, text) => items.push({ key, from, fromLabel: OPEN_ITEM_FROM[from], text, owner: owners[key]?.owner ?? '', due: owners[key]?.due ?? '' });
  if (board) {
    for (const ask of asksOf(board)) {
      if (ask.kind === 'guess') add(`guess:${ask.id.replace(/^guess-/, '')}`, 'guess', ask.text);
      else if (ask.kind === 'empty') add(ask.id.replace(/^empty-/, 'empty:'), 'empty', ask.text);
      else add(keyOf('ask', ask.text), ask.kind === 'conflict' ? 'conflict' : 'unasked', ask.text);
    }
  }
  if (purpose?.status && purpose.status !== 'skipped') for (const text of purpose.doc?.undecided ?? []) add(keyOf('purpose', text), 'purpose', text);
  if (design?.status === 'drafting') add('design:undecided', 'design', '設計の案内を最後まで決めていない(「この設計で作る」を押していない)。');
  for (const step of design?.steps ?? []) if (step.stale) add(`design:stale:${step.id}`, 'design', `設計の段「${step.label}」は、前の段を選び直したので確かめ直しが要る。`);
  if (review?.status === 'drafting' || review?.status === 'stopped' || review?.status === 'missing') {
    const approved = (review.items ?? []).filter((item) => item.approved).map((item) => item.id);
    const left = REVIEW_ITEMS.filter((item) => !approved.includes(item.id)).map((item) => item.label);
    add('review:open', 'review', review.status === 'missing' ? 'AI 構成の審査が要るのに、AI 構成書を読めない。' : `AI 構成書の承認がそろっていない(まだの項目: ${left.join('、') || 'なし'}${review.matches === false ? '。今の構成は承認と違う' : ''})。`);
  }
  for (const comment of comments) {
    if (!Object.hasOwn(UNSETTLED, comment.status)) continue;
    add(`comment:${comment.id}`, 'comment', `コメント ${comment.number}(${COMMENT_KINDS[comment.kind]})「${comment.text}」は、${UNSETTLED[comment.status]}。`);
  }
  // 同じ key は 1 つにする(同じ文の聞くことが 2 つあるとき)
  const seen = new Set();
  return items.filter((item) => (seen.has(item.key) ? false : seen.add(item.key)));
}

const ok = (status, note) => ({ status, note });
const versionOf = (value) => (isObject(value) ? { id: typeof value.id === 'string' ? value.id : null, number: Number.isSafeInteger(value.number) ? value.number : null, name: typeof value.name === 'string' ? value.name : null } : null);

// 7 つの成果物の状態。どれも、ないことを隠さない(vision.md の原則 7)
// collected は、未決事項を集める元(整理の板か目的の文書)があったか
export function describeDeliverables({ requirements, dataDesign, simulation, ai = null, design, review, evidence, latestRun, openItems, collected = true }) {
  const state = {};
  const { counts } = requirements;
  state.requirements =
    requirements.status === 'none'
      ? ok('missing', '目的の文書も、整理の板の項目もない')
      : requirements.status === 'confirmed'
        ? ok(counts.guesses > 0 ? 'draft' : 'ready', `決める人が「この理解で合っている」を押した。項目 ${counts.items}、推測の印 ${counts.guesses}`)
        : ok('draft', `まだ「この理解で合っている」を押していない。項目 ${counts.items}、推測の印 ${counts.guesses}`);
  const notOnDesign = dataDesign.heard.filter((item) => !item.onDesign).length;
  state.dataDesign =
    dataDesign.status === 'chosen'
      ? ok(notOnDesign > 0 ? 'draft' : 'ready', `${dataDesign.title ?? '選んだ案'}。覚えておくもの ${dataDesign.entities.length}、つながり ${dataDesign.links.length}${notOnDesign > 0 ? `。案に載っていないデータの欄が ${notOnDesign}` : ''}。型と制約は会の後`)
      : dataDesign.status === 'stale'
        ? ok('draft', '前の段を選び直したので、確かめ直しが要る')
        : ok('missing', dataDesign.status === 'skipped' ? '設計の案内を飛ばした' : `データの案を選んでいない${dataDesign.heard.length > 0 ? `(整理の板のデータの欄は ${dataDesign.heard.length})` : ''}`);
  const rejected = design?.composition?.rejected?.length ?? 0;
  state.composition = simulation?.composition?.file
    ? ok('ready', `構成のファイル ${simulation.composition.file}${rejected > 0 ? `。選ばなかった形 ${rejected} つと理由` : ''}`)
    : ai
      ? ok('draft', 'AI の設定だけで、構成のファイルはない')
      : ok('missing', '構成のファイルがない(AI のない試作品)');
  state.review =
    review.status === 'approved'
      ? ok('ready', `4 つの承認がそろった${review.approvedUnmeasured ? '(場面の数を測らずに承認した)' : ''}`)
      : review.status === 'drafting' || review.status === 'stopped'
        ? ok('draft', `承認の途中(${(review.items ?? []).filter((item) => item.approved).length} / ${(review.items ?? []).length})${review.matches === false ? '。今の構成は承認と違う' : ''}`)
        : ok('missing', review.status === 'skipped' ? 'AI 構成の審査を飛ばした(審査なし)' : review.status === 'missing' ? '審査が要るのに、AI 構成書を読めない' : 'AI 構成の審査を受けていない');
  const run = evidence?.run ?? null;
  state.prototype = !run
    ? ok('draft', 'まだ自動の確かめを通していない')
    : ['passed', 'fixed'].includes(run.status) && run.stale === false
      ? ok('ready', '自動の確かめが通った版')
      : ok('draft', run.stale ? '最後に自動の確かめをした後に、試作品が変わった' : '最後の自動の確かめが通っていない');
  const evalCount = simulation?.evals?.length ?? 0;
  const designScenes = design?.scenes?.length ?? 0;
  state.scenes =
    evalCount === 0 && designScenes === 0
      ? ok('missing', '場面がない')
      : !latestRun
        ? ok('draft', `場面 ${evalCount || designScenes}。まだ回していない`)
        : ok(latestRun.stale ? 'draft' : 'ready', `場面 ${evalCount || designScenes}。${latestRun.stale ? '回した後に試作品が変わった' : '回した結果つき'}${latestRun.real ? '' : '(お試しの AI で回した)'}`);
  const unowned = openItems.filter((item) => !item.owner).length;
  state.openItems =
    !collected ? ok('missing', '整理の板も目的の文書もないので、未決事項を集めていない') :
    openItems.length === 0 ? ok('ready', '未決事項はない') : unowned === 0 ? ok('ready', `${openItems.length} 件。全部に持ち主がいる`) : ok('draft', `${openItems.length} 件。持ち主のない未決事項が ${unowned} 件`);
  return DELIVERABLES.map((item) => ({ id: item.id, label: item.label, where: item.where, ...state[item.id], statusLabel: DELIVERABLE_STATUS[state[item.id].status] }));
}

// 会の終わりの全体。画面(ProjectClosings.view)と引き継ぎ(handoff.js)が同じ関数で作る
// stages は段ごとの時刻(timeline.js。.studio/timeline.json)。会ではない試作品は空
export function describeClosing({ purpose, design, review, board, comments, records, dataDesign, simulation, ai, evidence, latestRun, owners, stages = {} }) {
  const requirements = describeRequirements({ purpose, board, comments, records });
  const openItems = describeOpenItems({ board, purpose, design, review, comments, owners });
  const collected = Boolean(board) || (purpose?.status && purpose.status !== 'none' && purpose.status !== 'skipped') || openItems.length > 0;
  const deliverables = describeDeliverables({ requirements, dataDesign, simulation, ai, design, review, evidence, latestRun, openItems, collected });
  return {
    deliverables,
    present: deliverables.filter((item) => item.status !== 'missing').length,
    requirements,
    dataDesign,
    figure: compositionFigure(simulation, ai),
    composition: design?.composition ?? null,
    fixRecords: describeFixRecords(records, requirements),
    openItems,
    unowned: openItems.filter((item) => !item.owner).length,
    // そろった成果物の数(「そろった 6 / 7」。ui-ux-v2.md の 4.8)。present は、ないもの(missing)のほかの数
    ready: deliverables.filter((item) => item.status === 'ready').length,
    timeline: describeTimeline(stages, records),
    // 渡した後や会のデータを消した後も、消せないもの(meeting.js の消す操作と同じ一覧)
    notErasable: [...NOT_ERASABLE],
  };
}

// 引き継ぎに入れる前に、人が書いた文を伏せる(redact.js)。版の ID、記録の ID、日時は伏せない
export function redactClosing(closing) {
  const r = (value) => (typeof value === 'string' ? redact(value) : value);
  return {
    ...closing,
    deliverables: closing.deliverables.map((item) => ({ ...item, note: r(item.note) })),
    requirements: { ...closing.requirements, sections: closing.requirements.sections.map((section) => ({ ...section, items: section.items.map((item) => ({ ...item, text: r(item.text), sources: item.sources.map((s) => ({ n: s.n, text: r(s.text) })) })) })) },
    dataDesign: {
      ...closing.dataDesign,
      title: r(closing.dataDesign.title),
      detail: r(closing.dataDesign.detail),
      reason: r(closing.dataDesign.reason),
      note: r(closing.dataDesign.note),
      entities: closing.dataDesign.entities.map((entity) => ({ ...entity, name: r(entity.name), about: r(entity.about), writer: r(entity.writer), fields: entity.fields.map((field) => ({ ...field, name: r(field.name), kindLabel: r(field.kindLabel), examples: field.examples.map(r), ...(field.to ? { to: r(field.to) } : {}) })) })),
      links: closing.dataDesign.links.map((link) => ({ from: r(link.from), to: r(link.to), label: r(link.label) })),
      heard: closing.dataDesign.heard.map((item) => ({ ...item, text: r(item.text) })),
    },
    figure: { ...closing.figure, nodes: closing.figure.nodes.map((node) => ({ ...node, label: r(node.label) })) },
    composition: closing.composition,
    fixRecords: closing.fixRecords.map((record) => ({
      ...record,
      comment: { ...record.comment, text: r(record.comment.text), author: r(record.comment.author) },
      approval: { ...record.approval, approvers: record.approval.approvers.map((a) => ({ ...a, pressedBy: r(a.pressedBy), spokenBy: r(a.spokenBy) })) },
      request: r(record.request),
      versions: { before: record.versions.before ? { ...record.versions.before, name: r(record.versions.before.name) } : null, after: record.versions.after ? { ...record.versions.after, name: r(record.versions.after.name) } : null },
      // 押した人は { pressedBy, spokenBy } の形なので、中まで伏せる
      confirmation: redactDeep(record.confirmation),
      events: record.events.map((e) => ({ ...e, ...(e.note ? { note: r(e.note) } : {}) })),
    })),
    openItems: closing.openItems.map((item) => ({ ...item, text: r(item.text), owner: r(item.owner) })),
  };
}

// ---- 引き継ぎの README の節 ----

const oneLine = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
const cell = (value) => oneLine(value).replace(/\|/g, '\\|') || '(なし)';
const localTime = (iso) => (iso ? new Date(iso).toLocaleString('ja-JP') : '');
const FROM_MARKS = { purpose: '目的の文書', point: '元の要点', checked: '人が確かめた', guess: '推測', comment: '承認したコメント' };

function itemSource(item) {
  if (item.from === 'comment') return `コメント ${item.comment.number}(${item.comment.statusLabel}${item.comment.recordId ? `。直した記録 ${item.comment.recordId}` : ''})`;
  if (item.from === 'point') return `元の要点 ${item.sources.map((s) => `${s.n}「${oneLine(s.text)}」`).join('、')}`;
  return FROM_MARKS[item.from];
}

// 項目の名前と種類。番号とつながりの番号は、名前に「番号」が入るので短く書く
const fieldWords = (f) => (f.kind === 'key' ? `${f.name}(主キー)` : f.kind === 'link' ? `${f.name}(${f.to}への外部キー)` : `${f.name}(${f.kindLabel})`);

// 段ごとの時刻(K6)。会で 1 つも時刻を残していなければ書かない
function timelineReadmeLines(timeline) {
  if (!timeline || timeline.reached === 0) return [];
  const lines = [
    '### 段ごとの時刻',
    '',
    `見せられるまでの時間(同意から、自動の確かめが通った最初の試作品まで): ${durationWords(timeline.toShowMs)}(目安 ${timeline.targets.showMinutes} 分以内、仮)。`,
    `承認から直った版まで: ${timeline.fixes.length === 0 ? '承認したコメントはありません' : timeline.fixes.map((f) => `コメント ${f.comment ?? '-'} は ${f.ms !== null ? durationWords(f.ms) : f.fixedAt ? '直した版の自動の確かめが通っていない' : 'まだ直っていない'}`).join('、')}(目安 ${timeline.targets.fixMinutes} 分以内、仮)。`,
    '',
    '| 段 | Studio が時刻を残す印 | 時刻 | 始めから | 60 分の型の目安(仮) |',
    '|---|---|---|---|---|',
    ...timeline.stages.map((stage) => `| ${stage.label} | ${stage.mark} | ${stage.at ? localTime(stage.at) : '(まだ)'} | ${stage.at ? durationWords(stage.elapsedMs) : '-'} | ${stage.planMinutes} 分まで |`),
    '',
  ];
  return lines;
}

export function closingReadmeLines(closing) {
  const { deliverables, requirements, dataDesign, fixRecords, openItems } = closing;
  const lines = [
    '## 会の終わりの成果物',
    '',
    `会の終わりの 7 つの成果物です(${closing.present} / 7 がある)。会の終わりの状態は「お客さんと確かめた下書き」で、清書と人が確かめ切る作業は会の後に残ります。`,
    '',
    '| 成果物 | 状態 | 中身 | handoff.json の場所 |',
    '|---|---|---|---|',
    ...deliverables.map((item) => `| ${item.label} | ${item.statusLabel} | ${cell(item.note)} | ${item.where.map((w) => `\`${w}\``).join('、')} |`),
    '',
    '### 要件の文書',
    '',
    requirements.status === 'none'
      ? '(目的の文書も、整理の板の項目もありません)'
      : `${requirements.status === 'confirmed' ? `決める人が「この理解で合っている」を押した(${localTime(requirements.confirmedAt)})。` : 'まだ「この理解で合っている」を押していない下書き。'}項目 ${requirements.counts.items}、推測の印 ${requirements.counts.guesses}、確かめた割合 ${requirements.counts.checkedRatio === null ? '-' : `${Math.round(requirements.counts.checkedRatio * 100)}%`}。各項目に、元の要点か、承認したコメントを付けた。`,
    '',
  ];
  if (requirements.status !== 'none') {
    lines.push('| 節 | 項目 | 元 |', '|---|---|---|');
    for (const section of requirements.sections) {
      if (section.items.length === 0) lines.push(`| ${section.label} | (なし) | |`);
      for (const item of section.items) lines.push(`| ${section.label} | ${cell(item.text)} | ${cell(itemSource(item))} |`);
    }
    lines.push('');
  }
  lines.push('### データ設計', '');
  if (dataDesign.status === 'chosen' || dataDesign.status === 'stale') {
    lines.push(`選んだ案: ${oneLine(dataDesign.title)}${dataDesign.status === 'stale' ? '(確かめ直しが要る)' : ''}。理由: ${oneLine(dataDesign.reason) || '(なし)'}。型と細かい決まりは会の後に決める。`, '');
    lines.push('| 覚えておくもの | 誰が書くか | 項目 |', '|---|---|---|');
    for (const entity of dataDesign.entities) lines.push(`| ${cell(entity.name)} | ${cell(entity.writer)} | ${cell(entity.fields.map(fieldWords).join('、'))} |`);
    lines.push('');
    if (dataDesign.links.length > 0) lines.push(`つながり: ${dataDesign.links.map((l) => `1 つの${oneLine(l.from)}に、いくつもの${oneLine(l.to)}(${oneLine(l.label)})`).join('、')}`, '');
  } else lines.push(dataDesign.status === 'skipped' ? '設計の案内を飛ばしたので、データ設計はありません。' : 'データの案を選んでいません。', '');
  if (dataDesign.heard.length > 0) lines.push(`整理の板のデータの欄: ${dataDesign.heard.map((item) => `「${oneLine(item.text)}」${item.onDesign ? '' : '(案に載っていない)'}`).join('、')}`, '');
  lines.push('### 直した記録の一覧', '');
  if (fixRecords.length === 0) lines.push('画面へのコメントから直した記録はありません。', '');
  else {
    lines.push('画面へのコメントを承認して、作る AI が直した記録です。全部は handoff.json の `fixRecords` にあります。', '', '| コメント | 種類 | 承認 | 状態 | 版 | 変わったもの | 要件の文書の項目 |', '|---|---|---|---|---|---|---|');
    for (const record of fixRecords) {
      const versions = `${record.versions.before ? `v${record.versions.before.number}` : '-'} → ${record.versions.after ? `v${record.versions.after.number}` : '-'}`;
      lines.push(`| ${record.comment.number}「${cell(record.comment.text)}」 | ${record.comment.kindLabel} | ${cell(record.approval.approvers.map((a) => a.roleLabel).join('、'))} | ${cell(record.events.at(-1)?.label ?? record.status)} | ${versions} | ${cell(record.changes.summary)} | ${record.requirementItem ?? '-'} |`);
    }
    lines.push('');
  }
  lines.push(...timelineReadmeLines(closing.timeline));
  lines.push('### 未決事項の持ち主と期日', '');
  if (openItems.length === 0) lines.push('(会の記録から見つけた未決事項はありません)', '');
  else {
    lines.push(`${openItems.length} 件。持ち主のないもの ${closing.unowned} 件。`, '', '| 未決事項 | 出どころ | 持ち主 | 期日 |', '|---|---|---|---|');
    for (const item of openItems) lines.push(`| ${cell(item.text)} | ${item.fromLabel} | ${item.owner ? cell(item.owner) : '(持ち主なし)'} | ${item.due || '-'} |`);
    lines.push('');
  }
  return lines;
}

// ---- 画面の口 ----

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
function validDue(value) {
  if (value === undefined || value === null || value === '') return '';
  const match = DATE.exec(typeof value === 'string' ? value : '');
  const date = match && new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  if (!date || date.toISOString().slice(0, 10) !== value) throw new IntentError(400, 'invalid', '期日は、年月日で選んでください');
  return value;
}

export class ProjectClosings {
  // store は試作品(ビルドの構成と AI の設定)。latestOf(paths) は { evidence: 最新の作る run の要約, latestRun: 最新の場面の回しの要約 }(handoff.js と同じ読み方)。
  // talkGate(id) は会の同意の前と、消している間に断る(index.js)
  constructor({ home, store, latestOf = async () => ({ evidence: { run: null }, latestRun: null }), talkGate = () => {}, log = () => {} }) {
    this.home = home;
    this.store = store;
    this.latestOf = latestOf;
    this.talkGate = talkGate;
    this.log = log;
    this.queues = new Map();
  }

  async requireProject(id) {
    if (!isValidProjectId(id)) throw new NotFoundError(`プロジェクトがありません: ${id}`);
    return this.store.requireProject(id);
  }

  // 画面に出す形。整理の板とコメントの文は伏せない(会の中で、その場で見せるため)。目的の文書は、引き継ぎと同じ読み方(describePurpose)なので伏せてある。
  // 全部を伏せるのは書き出すとき
  async view(id) {
    const paths = await this.requireProject(id);
    const board = await readBoard(paths);
    const simulation = this.store.simulation(id);
    const { evidence, latestRun } = await this.latestOf(paths);
    const closing = describeClosing({
      purpose: await describePurpose(paths),
      design: await describeDesign(paths),
      review: await describeReview({ paths, appDir: paths.app }),
      board,
      comments: await readComments(paths),
      records: await readFixRecords(path.join(paths.studio, FIX_RECORDS_DIR)),
      dataDesign: await describeDataDesign(paths, board),
      simulation,
      ai: this.store.aiDefinition(id),
      evidence,
      latestRun,
      owners: await readOwners(paths),
      stages: await readTimeline(paths),
    });
    return closing;
  }

  // 共有の場に置く写し(share.js。collaboration.md の 9.4 の「何を同期するか」)。要件の文書、データ設計、場面の一覧、未決事項の文だけ。
  // 元の要点、直した記録、AI 構成書の中身、試作品の要約(証拠、場面の回し)は入れない。中継のサーバーに置くものを少なくするため
  async shared(id) {
    const paths = await this.requireProject(id);
    const board = await readBoard(paths);
    const purpose = await describePurpose(paths);
    const design = await describeDesign(paths);
    const comments = await readComments(paths);
    const requirements = describeRequirements({ purpose, board, comments, records: await readFixRecords(path.join(paths.studio, FIX_RECORDS_DIR)) });
    const openItems = describeOpenItems({ board, purpose, design, review: await describeReview({ paths, appDir: paths.app }), comments, owners: await readOwners(paths) });
    const data = await describeDataDesign(paths, board);
    return {
      requirements: {
        status: requirements.status,
        sections: requirements.sections.map((section) => ({ label: section.label, items: section.items.map((item) => ({ text: item.text, guess: item.guess })) })),
      },
      dataDesign: data.status === 'chosen' || data.status === 'stale'
        ? { title: data.title, stale: data.status === 'stale', entities: data.entities.map((entity) => ({ name: entity.name, writer: entity.writer, fields: entity.fields.map(fieldWords) })) }
        : null,
      scenes: design.scenes.map((scene) => ({ category: scene.category, text: scene.text })),
      openItems: openItems.map((item) => ({ text: item.text, from: item.fromLabel, owner: item.owner, due: item.due })),
    };
  }

  // 未決事項の持ち主と期日を書く。owner が空なら消す。人が押したときだけ呼ぶ。
  // 持ち主は名前か役(進行役、決める人など)。記録らしいもの(電話番号やメールアドレス)は断る
  async setOwner(id, { key, owner, due } = {}) {
    const paths = await this.requireProject(id);
    this.talkGate(id);
    const name = typeof owner === 'string' ? owner.replace(/\s+/g, ' ').trim() : '';
    if (name.length > CLOSING_LIMITS.maxOwner) throw new IntentError(400, 'invalid', `持ち主は ${CLOSING_LIMITS.maxOwner} 文字までにしてください`);
    const kinds = findRecords(name);
    if (kinds.length > 0) throw new IntentError(422, 'record', `記録らしいものがあるので、入れませんでした(${kinds.join('、')})。名前か役だけを書いてください。`);
    const dueDate = validDue(due);
    const run = async () => {
      const current = await this.view(id);
      if (typeof key !== 'string' || !current.openItems.some((item) => item.key === key)) throw new IntentError(404, 'no-item', 'その未決事項はありません。画面を読み直してください');
      const owners = await readOwners(paths);
      if (name) owners[key] = { owner: name, due: dueDate, at: new Date().toISOString() };
      else delete owners[key];
      await this.store.requireProject(id);
      const file = path.join(paths.studio, CLOSING_FILE);
      await fs.mkdir(paths.studio, { recursive: true });
      const tmp = `${file}.${crypto.randomBytes(4).toString('hex')}.tmp`;
      await fs.writeFile(tmp, `${JSON.stringify({ formatVersion: FORMAT, owners }, null, 2)}\n`);
      await fs.rename(tmp, file);
      return this.view(id);
    };
    const result = (this.queues.get(id) ?? Promise.resolve()).then(run, run);
    this.queues.set(id, result.catch(() => {}));
    return result;
  }
}

