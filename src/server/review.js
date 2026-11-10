import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {
  COMPOSITION_CHOICES,
  REVIEW_ITEMS,
  REVIEW_ITEM_IDS,
  ROLE_LABELS,
  SHAPE_LABELS,
  STACK_NOTE,
  approvalNeeds,
  architectureFiles,
  architectureFingerprint,
  changedItems,
  compositionFigure,
  compositionShape,
  dataReview,
  evalsDigest,
  harnessRows,
  harnessSummary,
  metricsFor,
  promptTexts,
  stackRows,
} from './architecture.js';
import { IntentError } from './intent.js';
import { isValidProjectId, listProjects, projectPaths } from './projects.js';
import { createMockConnection } from './product-ai/mock.js';
import { createMockAgent } from './sim/agent-mock.js';
import { createEvalWriter, newEvalRunId, pruneEvalRuns, runEvals } from './sim/eval-run.js';
import { BusyError, NotFoundError } from './store.js';

// AI 構成の審査(docs/design/ai-architecture-review.md)。作る前に、エージェントの構成、harness、データと RAG、技術の組の 4 つを人が読んで承認する。
// 結果は AI 構成書にして .studio/reviews/<審査の ID>/architecture.json に置く。.studio/ は Studio だけが書く場所で、作る AI は書けない(ADR 0001)。
// 4 つの承認がそろうまで、作る AI を起動しない(build-requests.js の節 accept)。承認した後に構成が変われば、関門 GA で止めて審査に戻す。
// 審査を要るかは .studio/project.json の review に書く。書いていない試作品(今ある試作品、見本)では何もしない(agent-simulation.md の R2)。
// 中身は今のファイルから Studio のコードが書く(architecture.js)。AI を呼ばない。案を出す AI は設計の案内(design.js)が同意の後に呼ぶ。

const FORMAT = 1;
const REVIEWS = 'reviews';
const CURRENT = 'current.json';
const SKIPPED = 'skipped.json';
const MAX_NAME = 40;
const MAX_REASON = 300;
// 場面の回しの結果を読む数(新しい順)
const MAX_RESULTS = 20;

const jsonFile = (value) => `${JSON.stringify(value, null, 2)}\n`;
const clip = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : '');
const sha = (text) => crypto.createHash('sha256').update(text).digest('hex');
const pad = (n) => String(n).padStart(2, '0');

export function newReviewId(date = new Date()) {
  return `review-${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}-${crypto.randomBytes(3).toString('hex')}`;
}
const REVIEW_ID = /^review-\d{8}-\d{6}-[0-9a-f]{6}$/;

async function readJson(file) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

async function writeAtomic(file, content) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  await fsp.writeFile(tmp, content);
  await fsp.rename(tmp, file);
}

// app/ の中の、ふつうのフォルダーだけをたどれるか。途中にシンボリックリンクがあれば false(app/ の外に書かないため)
async function plainParents(root, relative) {
  let current = root;
  for (const part of relative.split('/').slice(0, -1)) {
    current = path.join(current, part);
    const stat = await fsp.lstat(current).catch(() => null);
    if (stat && !stat.isDirectory()) return false;
  }
  return true;
}

const validRelative = (relative) => typeof relative === 'string' && relative.length > 0 && !relative.includes('\\') && !path.isAbsolute(relative) && !relative.split('/').includes('..');

// 承認がそろった項目か。要る役の全部が、今の指紋で承認している
function itemApproved(approval, digest) {
  return approval.needs.every((role) => approval.by.some((entry) => entry.role === role && entry.digest === digest));
}

export class ProjectReviews {
  // designs は設計の案内(design.js)。modeOf(id) は 'meeting'(会の中)か 'single'(1 人で使う)
  constructor({ home, store, designs, modeOf = () => 'single', log = () => {} }) {
    this.home = home;
    this.store = store;
    this.designs = designs;
    this.modeOf = modeOf;
    this.log = log;
    // 一覧に載せる短い形(projectView が同期で読む)
    this.summaries = new Map();
    this.locked = new Set();
  }

  dirs(id) {
    const { root, studio, app, meta } = projectPaths(this.home, id);
    const reviews = path.join(studio, REVIEWS);
    return { root, studio, app, meta, reviews, current: path.join(reviews, CURRENT), skipped: path.join(reviews, SKIPPED) };
  }

  async load() {
    for (const project of await listProjects(this.home)) {
      const flag = await this.flag(project.id);
      if (flag === 'none') continue;
      await this.refreshSummary(project.id).catch(() => {});
    }
  }

  // 審査が要るか(.studio/project.json の review)。none は書いていない試作品
  async flag(id) {
    const meta = await readJson(this.dirs(id).meta);
    return meta?.review === 'required' || meta?.review === 'skipped' ? meta.review : 'none';
  }

  async setFlag(id, value) {
    const { meta } = this.dirs(id);
    const current = (await readJson(meta)) ?? {};
    await writeAtomic(meta, jsonFile({ ...current, review: value }));
  }

  async currentId(id) {
    const pointer = await readJson(this.dirs(id).current);
    return typeof pointer?.id === 'string' && REVIEW_ID.test(pointer.id) ? pointer.id : null;
  }

  file(id, reviewId) {
    return path.join(this.dirs(id).reviews, reviewId, 'architecture.json');
  }

  async current(id) {
    const reviewId = await this.currentId(id);
    if (!reviewId) return null;
    const record = await readJson(this.file(id, reviewId));
    return record?.formatVersion === FORMAT && record.id === reviewId ? record : null;
  }

  async write(id, record) {
    await this.store.requireProject(id);
    record.updatedAt = new Date().toISOString();
    await writeAtomic(this.file(id, record.id), jsonFile(record));
    await writeAtomic(this.dirs(id).current, jsonFile({ id: record.id }));
    await this.refreshSummary(id, record);
  }

  // 一覧の印。none(審査なし)、skipped(飛ばした)、drafting(承認の途中)、approved(4 つの承認)、stopped(承認と違う構成)
  async refreshSummary(id, given = null) {
    const flag = await this.flag(id);
    if (flag === 'none') {
      this.summaries.delete(id);
      return;
    }
    if (flag === 'skipped') {
      this.summaries.set(id, { status: 'skipped', approved: 0, total: REVIEW_ITEM_IDS.length });
      return;
    }
    const record = given ?? (await this.current(id));
    if (!record) {
      this.summaries.set(id, { status: 'missing', approved: 0, total: REVIEW_ITEM_IDS.length });
      return;
    }
    const fingerprint = await architectureFingerprint(this.dirs(id).app);
    const approved = REVIEW_ITEM_IDS.filter((item) => itemApproved(record.approvals[item], fingerprint.items[item].digest)).length;
    const status = record.stopped ? 'stopped' : record.approvedAt && record.fingerprint.value === fingerprint.value ? 'approved' : 'drafting';
    this.summaries.set(id, { status, approved, total: REVIEW_ITEM_IDS.length });
  }

  summary(id) {
    return this.summaries.get(id) ?? { status: 'none', approved: 0, total: REVIEW_ITEM_IDS.length };
  }

  // 一覧の印を、今のファイルで取り直す(版を戻す、ビルドし直すなど、審査の外でファイルが変わったときのため)。審査のある試作品だけ
  async refreshAll() {
    for (const id of [...this.summaries.keys()]) {
      if (this.locked.has(id)) continue;
      await this.refreshSummary(id).catch(() => {});
    }
  }

  statusOf(id) {
    return this.summary(id).status;
  }

  forget(id) {
    this.summaries.delete(id);
  }

  async requireProject(id) {
    if (!isValidProjectId(id)) throw new NotFoundError(`プロジェクトがありません: ${id}`);
    return this.store.requireProject(id);
  }

  async exclusive(id, work) {
    await this.requireProject(id);
    if (this.locked.has(id)) throw new BusyError('前の操作の途中です。終わるまで待ってください');
    this.locked.add(id);
    try {
      const result = await work();
      return result ?? (await this.view(id));
    } finally {
      this.locked.delete(id);
    }
  }

  // 場面の回しの結果(.studio/evals/<回しの ID>/result.json)。新しい順
  async results(id) {
    const dir = path.join(this.dirs(id).studio, 'evals');
    const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
    const found = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const result = await readJson(path.join(dir, entry.name, 'result.json'));
      if (result?.format === 'prototype-studio-evals' && Array.isArray(result.groups)) found.push(result);
    }
    found.sort((a, b) => String(b.finishedAt ?? b.startedAt ?? '').localeCompare(String(a.finishedAt ?? a.startedAt ?? '')));
    return found.slice(0, MAX_RESULTS);
  }

  // 今のファイルと設計から、審査の中身を書く(AI を呼ばない)
  async content(id) {
    const simulation = this.store.simulation(id);
    const context = this.store.simulationContext(id);
    const ai = this.store.aiDefinition(id);
    const aiOf = context?.aiOf ?? (() => null);
    const design = this.designs.records.has(id) ? await this.designs.view(id) : null;
    const shape = compositionShape(simulation?.composition ?? null);
    const sceneIds = (simulation?.evals ?? []).map((item) => item.scenario?.id).filter(Boolean);
    const results = await this.results(id);
    const compositionStep = design?.steps?.find((step) => step.id === 'composition') ?? null;
    const recommended = compositionStep?.options?.find((option) => option.recommended) ?? null;
    const chosen = compositionStep?.chosen ?? null;
    const metrics = Object.fromEntries(COMPOSITION_CHOICES.map((choice) => [choice.id, metricsFor(results, choice.id, sceneIds)]));
    const current = metricsFor(results, shape, sceneIds);
    // 簡単な方から順の問いと答え(2 節)。下の形で通らなかった場面の id を根拠にする。数がなければ推測
    const chosenOrder = COMPOSITION_CHOICES.find((choice) => choice.id === shape)?.order ?? null;
    const answers = chosenOrder === null ? [] : COMPOSITION_CHOICES.filter((choice) => choice.order <= chosenOrder).map((choice) => {
      const measured = metrics[choice.id];
      const failed = measured ? measured.scenes.filter((scene) => scene.verdict === 'failed').map((scene) => scene.id) : [];
      const enough = choice.order === chosenOrder;
      return {
        order: choice.order,
        option: choice.id,
        question: choice.question,
        answer: enough ? '足りる見込み' : '足りない見込み',
        evalIds: failed,
        basis: measured ? (measured.real ? '本物の AI で回した' : 'お試しの AI で回した。形の確かめだけ') : 'まだ測っていない(今日の推測)',
      };
    });
    const designShelf = design?.steps?.find((step) => step.id === 'data')?.options?.find((option) => option.id === design.steps.find((step) => step.id === 'data').chosen)?.shelf ?? null;
    const rows = harnessRows({ simulation, ai, aiOf, evalsCount: sceneIds.length });
    const data = dataReview({ simulation, manifest: this.store.manifest(id), designShelf });
    return {
      composition: {
        chosen: chosen === 'keep' ? 'keep' : shape,
        shape,
        label: SHAPE_LABELS[shape] ?? shape,
        choosable: Boolean(design && design.status === 'decided' && chosen !== 'keep' && !design.ownerComposition),
        recommended: recommended && recommended.id !== 'keep' ? { option: recommended.id, label: recommended.title, reason: recommended.reason, date: design.optionsDate ?? null, source: compositionStep.source } : null,
        // 根拠の場面。回していれば結果の場面、回していなければ場面の一覧の id(下書き。まだ回していない)
        basisScenes: current ? current.scenes : sceneIds.map((sceneId) => ({ id: sceneId, verdict: null })),
        answers,
        rejected: design?.composition?.rejected ?? [],
        outOfOrder: Boolean(design?.composition?.outOfOrder),
        figure: compositionFigure(simulation, ai),
        options: COMPOSITION_CHOICES.map((choice) => ({ id: choice.id, label: choice.label, plain: choice.plain, question: choice.question, decidedBy: choice.decidedBy, modelRole: choice.modelRole, available: choice.available, metrics: metrics[choice.id] })),
        metrics: current,
      },
      harness: {
        rows,
        ...harnessSummary(rows),
        prompts: promptTexts(simulation, ai, aiOf),
        escalate: (simulation?.composition?.participants ?? []).flatMap((p) => (p.escalate ?? []).map((item) => item.id)),
      },
      data,
      stack: { rows: stackRows({ simulation, evalsCount: sceneIds.length }), note: STACK_NOTE },
      evidence: {
        status: current ? (current.real ? 'real' : 'mock') : 'unmeasured',
        measuredAt: current?.measuredAt ?? null,
        runIds: current ? [current.runId] : [],
        evalsDigest: evalsDigest(simulation),
        stale: current?.stale ?? false,
      },
      basis: {
        purposeDigest: design ? sha(JSON.stringify(this.designs.intentOf(id)?.doc ?? null)) : null,
        boardDigest: design ? sha(JSON.stringify(this.designs.boardOf(id) ?? [])) : null,
      },
      built: Boolean(simulation),
    };
  }

  // 審査を始める。設計の案内の「この設計で作る」(studio-server.js)か、人が頼んだとき(今の構成を審査する)。
  // 承認の途中か、承認して構成が変わっていなければ、今の審査を続ける。それ以外は新しい審査にする(承認はやり直し)
  async start(id, { origin = 'design' } = {}) {
    return this.exclusive(id, async () => {
      const existing = await this.current(id);
      const fingerprint = await architectureFingerprint(this.dirs(id).app);
      // 続けるのは、止めていなくて、最後に書いたときから構成のファイルが変わっていないときだけ(変わっていれば、承認は全部やり直す)
      if (existing && !existing.stopped && existing.fingerprint.value === fingerprint.value) {
        if ((await this.flag(id)) !== 'required') await this.setFlag(id, 'required');
        await this.refreshSummary(id, existing);
        return null;
      }
      await this.setFlag(id, 'required');
      await this.write(id, await this.fresh(id, { origin, previous: existing?.id ?? null }));
      return null;
    });
  }

  async fresh(id, { origin, previous = null, approvals = null }) {
    const now = new Date().toISOString();
    const content = await this.content(id);
    const fingerprint = await architectureFingerprint(this.dirs(id).app);
    const mode = this.modeOf(id);
    const needs = approvalNeeds(mode);
    return {
      formatVersion: FORMAT,
      id: newReviewId(),
      createdAt: now,
      updatedAt: now,
      origin,
      mode,
      previous,
      ...this.recordContent(content),
      fingerprint,
      approvals: approvals ?? Object.fromEntries(REVIEW_ITEM_IDS.map((item) => [item, { needs: needs[item], by: [] }])),
      approvedAt: null,
      approvedUnmeasured: null,
      stopped: null,
    };
  }

  // 中身のうち、AI 構成書に残すもの(6 節の形)
  recordContent(content) {
    const { composition, harness, data, stack, evidence, basis } = content;
    return {
      basis,
      composition: { chosen: composition.chosen, shape: composition.shape, recommended: composition.recommended, answers: composition.answers, rejected: composition.rejected, outOfOrder: composition.outOfOrder, basisScenes: composition.basisScenes, figure: composition.figure },
      harness: { rows: harness.rows, modelDecides: harness.modelDecides, codeBinds: harness.codeBinds, humanDecides: harness.humanDecides, modelOnly: harness.modelOnly, escalate: harness.escalate, prompts: harness.prompts },
      data: { shelf: data.shelf, rag: data.rag, source: data.source },
      stack: { prototype: stack.rows.map((row) => ({ kind: row.id, name: row.prototype, standIn: row.id === 'model' })), productionCandidates: stack.rows.map((row) => ({ kind: row.id, candidates: row.candidates, verified: false })), note: stack.note },
      evidence: { status: evidence.status, measuredAt: evidence.measuredAt, runIds: evidence.runIds, evalsDigest: evidence.evalsDigest },
    };
  }

  // 画面に出す形。指紋は今のファイルで取り直し、承認がまだ効くかを項目ごとに出す
  async view(id) {
    await this.requireProject(id);
    const flag = await this.flag(id);
    const record = await this.current(id);
    const skipped = flag === 'skipped' ? await readJson(this.dirs(id).skipped) : null;
    if (!record) return { status: flag === 'skipped' ? 'skipped' : flag === 'required' ? 'missing' : 'none', flag, skipped, items: REVIEW_ITEMS, roles: ROLE_LABELS };
    const content = await this.content(id);
    const fingerprint = await architectureFingerprint(this.dirs(id).app);
    const changed = changedItems(record.fingerprint, fingerprint);
    const items = REVIEW_ITEMS.map((item) => {
      const approval = record.approvals[item.id];
      const digest = fingerprint.items[item.id].digest;
      return {
        ...item,
        needs: approval.needs,
        by: approval.by.map((entry) => ({ ...entry, valid: entry.digest === digest })),
        approved: itemApproved(approval, digest),
        changed: changed.includes(item.id),
      };
    });
    const approvedCount = items.filter((item) => item.approved).length;
    const approvedNow = Boolean(record.approvedAt) && record.fingerprint.value === fingerprint.value;
    return {
      id: record.id,
      status: flag === 'skipped' ? 'skipped' : record.stopped ? 'stopped' : approvedNow ? 'approved' : 'drafting',
      flag,
      skipped,
      mode: record.mode,
      createdAt: record.createdAt,
      approvedAt: record.approvedAt,
      approvedUnmeasured: record.approvedUnmeasured,
      stopped: record.stopped,
      previous: record.previous,
      origin: record.origin,
      items,
      roles: ROLE_LABELS,
      approvedCount,
      total: items.length,
      ready: approvedCount === items.length && !record.stopped,
      fingerprint: { value: fingerprint.value, approved: record.approvedAt ? record.fingerprint.value : null },
      hasCopy: Boolean(record.approvedAt),
      ...content,
    };
  }

  // 構成を選び直す。設計の構成の段を変えてファイルを書き直し、4 つの承認を全部消す(想像図の決まり)
  async choose(id, { composition }) {
    return this.exclusive(id, async () => {
      const record = await this.current(id);
      if (!record) throw new IntentError(409, 'no-review', 'まだ審査を始めていません');
      if (record.stopped) throw new IntentError(409, 'review-stopped', '承認と違う構成になっています。先に「審査に戻る」か「承認した構成に戻す」を押してください');
      if (!this.designs.records.has(id)) throw new IntentError(409, 'owner-composition', '今の構成は書き換えません');
      if (typeof composition !== 'string' || !COMPOSITION_CHOICES.some((choice) => choice.id === composition)) throw new IntentError(400, 'invalid', '知らない構成です');
      await this.designs.chooseComposition(id, composition);
      const next = await this.fresh(id, { origin: record.origin, previous: record.id });
      await this.write(id, next);
      return null;
    });
  }

  // 承認する。役は 1 人で使うときは owner、会の中では進行役(facilitator)か決める人(decider)。名前は申告で、Studio は本人を確かめない
  async approve(id, { item, role, pressedBy, spokenBy }) {
    return this.exclusive(id, async () => {
      const record = await this.current(id);
      if (!record) throw new IntentError(409, 'no-review', 'まだ審査を始めていません');
      if (record.stopped) throw new IntentError(409, 'review-stopped', '承認と違う構成になっています。先に「審査に戻る」か「承認した構成に戻す」を押してください');
      if (!REVIEW_ITEM_IDS.includes(item)) throw new IntentError(400, 'invalid', '知らない項目です');
      const approval = record.approvals[item];
      const asRole = role ?? approval.needs[0];
      if (!approval.needs.includes(asRole)) throw new IntentError(400, 'invalid', `この項目は ${approval.needs.map((r) => ROLE_LABELS[r]).join('と')}が承認します`);
      const fingerprint = await architectureFingerprint(this.dirs(id).app);
      const next = structuredClone(record);
      next.approvals[item].by = [
        ...approval.by.filter((entry) => entry.role !== asRole),
        { role: asRole, pressedBy: clip(pressedBy, MAX_NAME) || null, spokenBy: clip(spokenBy, MAX_NAME) || null, at: new Date().toISOString(), digest: fingerprint.items[item].digest },
      ];
      // 承認したときの中身を残す(何を読んで承認したか)
      Object.assign(next, this.recordContent(await this.content(id)));
      next.fingerprint = fingerprint;
      // 承認した後に別の項目を承認し直したら、4 つの承認の時刻は取り直す
      next.approvedAt = null;
      await this.write(id, next);
      return null;
    });
  }

  // 「この構成で作る」。4 つの承認がそろっていれば、承認の時刻を入れ、構成のファイルの写しを files/ に置き、作る AI への依頼の文を返す。
  // 依頼を送るのは画面(言葉で直す欄と同じ道。本物の AI の同意もその道で取る)
  async build(id) {
    return this.exclusive(id, async () => {
      const record = await this.current(id);
      if (!record) throw new IntentError(409, 'no-review', 'まだ審査を始めていません');
      if (record.stopped) throw new IntentError(409, 'review-stopped', '承認と違う構成になっています。先に「審査に戻る」か「承認した構成に戻す」を押してください');
      const fingerprint = await architectureFingerprint(this.dirs(id).app);
      const missing = REVIEW_ITEMS.filter((item) => !itemApproved(record.approvals[item.id], fingerprint.items[item.id].digest));
      if (missing.length > 0) throw new IntentError(409, 'not-approved', `あと ${missing.length} つの承認で押せます(${missing.map((item) => item.label).join('、')})`);
      const next = structuredClone(record);
      Object.assign(next, this.recordContent(await this.content(id)));
      next.fingerprint = fingerprint;
      next.approvedAt = new Date().toISOString();
      // 数がないまま承認した印(4 節。「測らずに承認した」)
      next.approvedUnmeasured = next.evidence.status === 'unmeasured';
      await this.copyFiles(id, next);
      await this.write(id, next);
      const request = this.designs.records.get(id)?.status === 'decided' ? await this.designs.requestFor(id, { reviewed: true }).catch(() => null) : null;
      return { review: await this.view(id), request };
    });
  }

  // 承認した構成のファイルの写し(比べる元と、戻す元)
  async copyFiles(id, record) {
    const { app, reviews } = this.dirs(id);
    const dir = path.join(reviews, record.id, 'files');
    await fsp.rm(dir, { recursive: true, force: true });
    const files = [...new Set(Object.values(record.fingerprint.items).flatMap((item) => item.files))];
    for (const relative of files) {
      if (!validRelative(relative)) continue;
      const source = path.join(app, relative);
      const stat = await fsp.lstat(source).catch(() => null);
      if (!stat?.isFile() || !(await plainParents(app, relative))) continue;
      await fsp.mkdir(path.dirname(path.join(dir, relative)), { recursive: true });
      await fsp.copyFile(source, path.join(dir, relative));
    }
  }

  // 審査を飛ばす。飛ばした人、時刻、理由を残し、「審査なし」の印にする(6 節の「審査が要る試作品」)
  async skip(id, { reason, by } = {}) {
    return this.exclusive(id, async () => {
      const text = clip(reason, MAX_REASON);
      if (!text) throw new IntentError(400, 'invalid', '飛ばす理由を書いてください');
      await writeAtomic(this.dirs(id).skipped, jsonFile({ formatVersion: FORMAT, at: new Date().toISOString(), by: clip(by, MAX_NAME) || null, reason: text }));
      await this.setFlag(id, 'skipped');
      await this.refreshSummary(id);
      const request = this.designs.records.get(id)?.status === 'decided' ? await this.designs.requestFor(id).catch(() => null) : null;
      return { review: await this.view(id), request };
    });
  }

  // お試しの AI(モック)で、今の構成の場面の一覧を回す。費用はかからない。数は「形の確かめだけ」で、案の良し悪しの根拠にしない(4 節)。
  // 結果は npm run evals と同じ所(.studio/evals/)に置く
  async measure(id) {
    return this.exclusive(id, async () => {
      const context = this.store.simulationContext(id);
      if (!context?.simulation?.composition) throw new IntentError(409, 'no-composition', '構成を読めないので、回せません。試作品が表示できるか確かめてください');
      if ((context.simulation.evals ?? []).length === 0) throw new IntentError(409, 'no-scenes', '場面の一覧がないので、回せません');
      const { root } = this.dirs(id);
      const mock = { kind: 'mock', real: false, agent: createMockAgent(), harness: createMockConnection() };
      const runId = newEvalRunId();
      const writer = await createEvalWriter({ root, parts: ['.studio', 'evals', runId] });
      const { result, traces } = await runEvals({
        simulation: context.simulation,
        aiOf: context.aiOf,
        dataNumbers: context.dataNumbers,
        project: id,
        plan: { connections: ['mock'] },
        connectionFor: () => mock,
        projectDir: root,
        id: runId,
      });
      await writer.write(result, traces, { report: true });
      await pruneEvalRuns(path.join(root, '.studio', 'evals'), runId).catch(() => {});
      await this.writeEvidence(id);
      return null;
    });
  }

  // 審査の記録の数(evidence)を、今の場面の回しの結果で取り直す
  async writeEvidence(id) {
    const record = await this.current(id);
    if (!record) return;
    const next = structuredClone(record);
    next.evidence = this.recordContent(await this.content(id)).evidence;
    await this.write(id, next);
  }

  // 主の画面で場面を回した後(scene-runs.js)。審査のない試作品では何もしない。審査の操作の途中なら、次の操作に任せる
  async noteMeasured(id) {
    if ((await this.flag(id)) !== 'required' || this.locked.has(id)) return;
    this.locked.add(id);
    try {
      await this.writeEvidence(id);
    } finally {
      this.locked.delete(id);
    }
  }

  // 関門 GA と節 accept が使う比べ(build-requests.js)。applies が false なら何もしない(今の試作品。R2)
  async check(id) {
    const flag = await this.flag(id);
    if (flag !== 'required') return { applies: false };
    const record = await this.current(id);
    if (!record) return { applies: true, ok: false, code: 'review-missing', message: 'AI 構成の審査の記録を読めません。審査をやり直してください' };
    if (record.stopped) return { applies: true, ok: false, code: 'review-stopped', reviewId: record.id, message: '承認した構成と違うので止めた審査です。AI 構成の審査で「審査に戻る」か「承認した構成に戻す」を押してください' };
    if (!record.approvedAt) return { applies: true, ok: false, code: 'review-not-approved', message: `AI 構成の審査で、4 つを承認してから作ってください(承認 ${REVIEW_ITEM_IDS.filter((item) => record.approvals[item].by.length > 0).length} / 4)` };
    const fingerprint = await architectureFingerprint(this.dirs(id).app);
    const changed = changedItems(record.fingerprint, fingerprint);
    if (changed.length === 0) return { applies: true, ok: true, reviewId: record.id, fingerprint: fingerprint.value };
    const labels = changed.map((item) => REVIEW_ITEMS.find((r) => r.id === item).label);
    return {
      applies: true,
      ok: false,
      code: 'review-changed',
      reviewId: record.id,
      changed,
      fingerprint: fingerprint.value,
      approvedFingerprint: record.fingerprint.value,
      message: `承認した構成と違います(変わった所: ${labels.join('、')})。AI 構成の審査に戻ってください`,
    };
  }

  // 関門 GA が止めたことを残す。審査の画面に違いを出し、審査に戻るまで作る AI を起動しない
  async markStopped(id, { runId = null, changed = [], fingerprint = null } = {}) {
    const record = await this.current(id);
    if (!record || record.stopped) return;
    const next = structuredClone(record);
    next.stopped = { at: new Date().toISOString(), runId, items: changed, fingerprint };
    await this.write(id, next);
  }

  // 審査に戻る(6 節の「止めた後の道」)。新しい審査の ID を作る。指紋が同じ項目の承認は写し、変わった項目は承認し直す。前の AI 構成書は残す
  async back(id) {
    return this.exclusive(id, async () => {
      const record = await this.current(id);
      if (!record) throw new IntentError(409, 'no-review', 'まだ審査を始めていません');
      const fingerprint = await architectureFingerprint(this.dirs(id).app);
      const approvals = Object.fromEntries(REVIEW_ITEM_IDS.map((item) => {
        const approval = record.approvals[item];
        const same = record.fingerprint.items[item].digest === fingerprint.items[item].digest;
        return [item, { needs: approval.needs, by: same ? approval.by : [] }];
      }));
      await this.write(id, await this.fresh(id, { origin: record.origin, previous: record.id, approvals }));
      return null;
    });
  }

  // 承認した構成に戻す。目録の指し先と、構成のファイルを files/ の写しに戻す。画面のソースはそのまま。作る AI、ビルド、版の操作とは同時に動かない。
  // 戻した後の指紋が承認したものと同じときだけビルドし直す(違えば試す欄を替えずに断る)
  async restore(id) {
    return this.exclusive(id, async () => {
      const record = await this.current(id);
      if (!record?.approvedAt) throw new IntentError(409, 'no-copy', '承認した構成の写しがありません');
      const { app, reviews } = this.dirs(id);
      const copies = path.join(reviews, record.id, 'files');
      const approvedFiles = new Set(Object.values(record.fingerprint.items).flatMap((item) => item.files).filter(validRelative));
      this.store.claimVersions(id);
      try {
        await this.restorePointers(app, record.fingerprint.pointers);
        for (const relative of approvedFiles) {
          if (!(await plainParents(app, relative))) continue;
          const target = path.join(app, relative);
          const targetStat = await fsp.lstat(target).catch(() => null);
          if (targetStat && !targetStat.isFile()) continue;
          const copy = path.join(copies, relative);
          const copyStat = await fsp.lstat(copy).catch(() => null);
          // 先に消してから写す(ハードリンクの先へ書き込まない)
          if (targetStat) await fsp.rm(target, { force: true });
          if (copyStat?.isFile()) {
            await fsp.mkdir(path.dirname(target), { recursive: true });
            await fsp.copyFile(copy, target, fsp.constants?.COPYFILE_EXCL ?? 1);
          }
        }
        // 承認した後に足された構成のファイル(前提のフォルダーの新しい JSON など)は取り除く
        const { items } = await architectureFiles(app);
        for (const relative of new Set(Object.values(items).flat())) {
          if (approvedFiles.has(relative) || !validRelative(relative) || !(await plainParents(app, relative))) continue;
          const target = path.join(app, relative);
          if ((await fsp.lstat(target).catch(() => null))?.isFile()) await fsp.rm(target, { force: true });
        }
        const fingerprint = await architectureFingerprint(app);
        if (fingerprint.value !== record.fingerprint.value) throw new IntentError(409, 'restore-failed', '承認した構成に戻せませんでした。試す欄は替えていません。審査に戻ってください');
        await this.store.build(id, { byVersions: true });
      } finally {
        this.store.releaseVersions(id);
      }
      const next = structuredClone(record);
      next.stopped = null;
      await this.write(id, next);
      return null;
    });
  }

  // 目録(prototype.json)の composition と ai だけを、承認したときの値に戻す。ほかの項目(題名など)はそのまま
  async restorePointers(app, pointers) {
    if (!pointers) return;
    const file = path.join(app, 'prototype.json');
    const stat = await fsp.lstat(file).catch(() => null);
    if (!stat?.isFile()) return;
    let manifest;
    try {
      manifest = JSON.parse(await fsp.readFile(file, 'utf8'));
    } catch {
      return;
    }
    if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) return;
    let changed = false;
    for (const key of ['composition', 'ai']) {
      const want = pointers[key] ?? null;
      if (JSON.stringify(manifest[key] ?? null) === JSON.stringify(want)) continue;
      if (want === null) delete manifest[key];
      else manifest[key] = want;
      changed = true;
    }
    if (!changed) return;
    await fsp.rm(file, { force: true });
    await fsp.writeFile(file, jsonFile(manifest), { flag: 'wx' });
  }
}
