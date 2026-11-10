import fs from 'node:fs/promises';
import path from 'node:path';
import { REVIEW_ITEMS, ROLE_LABELS, architectureFingerprint, changedItems } from './architecture.js';
import { STUDIO_ROOT } from './config.js';
import { STEPS } from './design.js';
import { DOC_FIELDS, FIELD_LABELS, INTENT_FILE } from './intent.js';
import { QUALITY_LIMITS, readQuality } from './quality.js';
import { redact, redactDeep } from './redact.js';
import { itemApproved, readReviewState } from './review.js';
import { SHOW_FILE, questionsFrom, readShowFile } from './show.js';

// 引き継ぎの形式 4(docs/design/user-journey.md の J8)。決めたことと理由を、引き継ぎまで残す(vision.md の原則 5「理由を残す」)。
// 目的の文書(J1)、設計の段ごとの決定と理由(J2)、質の見直しの結果(J6)、人に見せた答え(J7)、
// AI 構成書と承認の記録(task 422)、既定の素材の出典とライセンス(J3)を、Studio が持つ記録から読む。
// どれも読むだけで、何も動かさない。AI の判断は入れない。人が書いた文は伏せる(redact.js)。
// 指紋(長い符号の形)は伏せると照合できなくなるので、AI 構成書は指紋の欄を除いて伏せる処理を通す。版の ID と日時も伏せない。

// 壊れた記録(手で直したファイルなど)でも、書き出し全体を止めない。形の違う要素は捨てて読む
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const objects = (value) => (Array.isArray(value) ? value.filter(isObject) : []);
const strings = (value) => (Array.isArray(value) ? value.filter((item) => typeof item === 'string') : []);
// 人が書いた文(か AI が書いた文)。文字列でなければ null。伏せてから入れる
const text = (value) => (typeof value === 'string' && value ? redact(value) : null);

const readJson = async (file) => {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return null;
  }
};

// 既定の素材の出典(materials/default/source.json)と、書き出しに写すライセンスの文のフォルダー
export const DEFAULT_MATERIAL_DIR = path.join(STUDIO_ROOT, 'materials', 'default');
export const DEFAULT_MATERIAL_COPY = 'materials/default';
const DEFAULT_MATERIAL_PARTS = ['source.json', 'licenses', 'licenses-upstream'];

// 目的の文書(.studio/intent.json)。status は none(聞き出していない)、interviewing、draft、decided(人が「これで決める」を押した)、skipped
export async function describePurpose(paths) {
  const record = await readJson(path.join(paths.studio, INTENT_FILE));
  if (record?.formatVersion !== 1 || typeof record.status !== 'string') return { status: 'none', decidedAt: null, skippedAt: null, sentence: null, doc: null };
  const doc = isObject(record.doc) ? record.doc : {};
  return {
    status: record.status,
    decidedAt: typeof record.decidedAt === 'string' ? record.decidedAt : null,
    skippedAt: typeof record.skippedAt === 'string' ? record.skippedAt : null,
    // 最初の 1 文(はじめの画面で書いたもの)
    sentence: text(record.sentence),
    doc: {
      ...Object.fromEntries(DOC_FIELDS.map((field) => [field, text(doc[field]) ?? ''])),
      notDoing: strings(doc.notDoing).map(redact),
      undecided: strings(doc.undecided).map(redact),
    },
  };
}

export const PURPOSE_LABELS = FIELD_LABELS;

const optionText = (option) => [option?.title, option?.detail].filter((value) => typeof value === 'string' && value).join(': ');

// 設計の段ごとの決定と理由(.studio/design.json)。理由は選んだ案の理由(AI か Studio の決まった案が書いたもの)と、人のメモ。
// 選ばなかった案も、題と理由を残す(後で「なぜこちらでないか」を読めるように)
export async function describeDesign(paths) {
  const record = await readJson(path.join(paths.studio, 'design.json'));
  if (record?.formatVersion !== 1 || !record.steps || typeof record.status !== 'string') return { status: 'none', decidedAt: null, skippedAt: null, optionsDate: null, steps: [], scenes: [], composition: null };
  const steps = STEPS.map((step) => {
    const value = isObject(record.steps[step.id]) ? record.steps[step.id] : {};
    const options = objects(value.options);
    const chosen = typeof value.chosen === 'string' ? value.chosen : null;
    const picked = options.find((option) => option.id === chosen) ?? null;
    const custom = chosen === 'custom';
    const decision = custom ? value.text : picked ? optionText(picked) : chosen === 'keep' ? '今の構成のまま(書き換えない)' : null;
    return {
      id: step.id,
      label: step.label,
      question: step.question,
      chosen,
      decision: text(decision),
      // 自分の言葉で決めたときは、案の理由がない
      reason: custom ? null : text(picked?.reason),
      note: text(value.note),
      // 案を出したのが AI か、Studio の決まった案か
      source: typeof value.source === 'string' ? value.source : null,
      decidedAt: typeof value.decidedAt === 'string' ? value.decidedAt : null,
      // 前の段を選び直したので、確かめ直しが要る
      stale: value.stale === true,
      others: options.filter((option) => option.id !== chosen).map((option) => ({ title: text(option.title) ?? '', reason: text(option.reason) })),
    };
  });
  const composition = isObject(record.composition)
    ? {
        chosen: typeof record.composition.chosen === 'string' ? record.composition.chosen : null,
        rejected: objects(record.composition.rejected).map((item) => ({ option: typeof item.option === 'string' ? item.option : null, reason: text(item.reason) })),
        outOfOrder: record.composition.outOfOrder === true,
        at: typeof record.composition.at === 'string' ? record.composition.at : null,
      }
    : null;
  return {
    status: record.status,
    decidedAt: record.decidedAt ?? null,
    skippedAt: record.skippedAt ?? null,
    // 案を出した日(案の理由の「今日の推測」は、この日の推測)
    optionsDate: record.optionsDate ?? null,
    steps,
    scenes: objects(record.scenes).filter((scene) => typeof scene.category === 'string' && typeof scene.text === 'string').map((scene) => ({ category: scene.category, text: redact(scene.text) })),
    composition,
  };
}

// 質の見直しの表(画面の表と同じ。quality.js の readQuality)。「直す」の依頼の文は作る AI への頼みなので入れない
export async function describeQuality({ paths, simulation, result }) {
  const table = await readQuality({ paths, simulation, result });
  return {
    summary: table.summary,
    audit: table.audit,
    scenes: table.scenes,
    rows: table.rows.map((row) => ({
      id: row.id,
      group: row.group,
      label: row.label,
      status: row.status,
      result: redact(row.result),
      why: row.why,
      fix: row.fix,
      places: row.places.slice(0, QUALITY_LIMITS.maxPlaces).map(redact),
      note: row.note ?? null,
    })),
  };
}

// 人に見せた答え(.studio/show.json)と、今の目的の文書から作る問い。答えは見せた版の番号と名前を付ける
export async function describeShows({ paths, purpose, versions }) {
  const { records, broken } = await readShowFile(path.join(paths.studio, SHOW_FILE));
  const names = new Map(versions.map((v) => [v.id, v.name]));
  const { source, questions } = questionsFrom(purpose.status === 'skipped' ? null : purpose.doc);
  return {
    questions: { source, items: questions.map(redact) },
    broken,
    // 版の ID と日時は伏せない(伏せる処理は数字の並びを電話番号として伏せることがあり、ID が壊れる)
    records: records.map((record) => ({
      versionId: record.versionId,
      versionNumber: record.versionNumber,
      // 版が消えていれば null(自動の版は古いものから消える。見せた版は自分で保存した版)
      versionName: names.has(record.versionId) ? text(names.get(record.versionId)) : null,
      answeredAt: record.answeredAt,
      viewer: text(record.viewer) ?? '',
      answers: objects(record.answers).map((item) => ({ question: text(item.question) ?? '', answer: text(item.answer) ?? '' })),
    })),
  };
}

// 承認の記録。名前の欄は伏せる処理を通す(メールアドレスなどの形を伏せる。名前は承認の記録なので残る)。指紋は伏せない
function cleanApprovals(approvals) {
  return Object.fromEntries(
    Object.entries(isObject(approvals) ? approvals : {}).map(([item, approval]) => [
      item,
      {
        needs: strings(approval?.needs),
        by: objects(approval?.by).map((entry) => ({ ...entry, pressedBy: text(entry.pressedBy), spokenBy: text(entry.spokenBy) })),
      },
    ]),
  );
}

const withoutDigests = ({ basis, evidence, fingerprint, approvals, ...rest }) => rest;

// AI 構成書と承認の記録(.studio/reviews/。docs/design/ai-architecture-review.md の 6 節)。
// 書き出す app/ の写しの指紋を AI 構成書の指紋と比べ、違えば「承認と違う」(matches: false)。人が手で app/ を直した場合もここで分かる
export async function describeReview({ paths, appDir }) {
  const { flag, record, skipped } = await readReviewState(paths);
  const skippedRecord = isObject(skipped) ? { at: typeof skipped.at === 'string' ? skipped.at : null, by: text(skipped.by), reason: text(skipped.reason) ?? '' } : null;
  if (!record) {
    return { flag, status: flag === 'skipped' ? 'skipped' : flag === 'required' ? 'missing' : 'none', matches: null, changed: [], items: [], approvedAt: null, approvedUnmeasured: null, skipped: skippedRecord, record: null };
  }
  const fingerprint = await architectureFingerprint(appDir);
  const changed = changedItems(record.fingerprint, fingerprint);
  const approvals = cleanApprovals(record.approvals);
  const items = REVIEW_ITEMS.map((item) => {
    const approval = { needs: [], by: [], ...approvals[item.id] };
    const digest = fingerprint.items[item.id].digest;
    return {
      id: item.id,
      label: item.label,
      needs: approval.needs,
      // 要る役のない項目(壊れた記録)は、承認したことにしない
      approved: approval.needs.length > 0 && itemApproved(approval, digest),
      by: approval.by.map((entry) => ({ role: entry.role, roleLabel: ROLE_LABELS[entry.role] ?? entry.role, pressedBy: entry.pressedBy, spokenBy: entry.spokenBy, at: entry.at, valid: entry.digest === digest })),
    };
  });
  const matches = record.fingerprint?.value === fingerprint.value;
  const status = flag === 'skipped' ? 'skipped' : record.stopped ? 'stopped' : record.approvedAt && matches ? 'approved' : 'drafting';
  return {
    flag,
    status,
    matches,
    changed,
    items,
    approvedAt: record.approvedAt ?? null,
    approvedUnmeasured: record.approvedUnmeasured ?? null,
    skipped: skippedRecord,
    // AI 構成書の写し。文は伏せる処理を通す。指紋(basis、evidence、fingerprint、承認の digest)は伏せない(伏せると照合できない)
    record: { ...redactDeep(withoutDigests(record)), basis: record.basis ?? null, evidence: record.evidence ?? null, fingerprint: record.fingerprint ?? null, approvals },
  };
}

// 既定の素材(J3)の出典とライセンス。試作品が import しているパッケージに印を付ける
export async function describeDefaultMaterial(imported) {
  const source = await readJson(path.join(DEFAULT_MATERIAL_DIR, 'source.json'));
  if (!source) return null;
  const used = new Set(imported);
  const packages = (source.packages ?? []).map((item) => ({ name: item.name, version: item.version, license: item.license, source: item.source, licenseFile: item.licenseFile ? `${DEFAULT_MATERIAL_COPY}/${item.licenseFile}` : null, imported: used.has(item.name) }));
  const licenses = {};
  for (const item of packages) licenses[item.license] = (licenses[item.license] ?? 0) + 1;
  return {
    name: source.material ?? '既定の素材',
    decidedIn: source.decidedIn ?? null,
    file: `${DEFAULT_MATERIAL_COPY}/source.json`,
    roles: (source.roles ?? []).map((role) => ({ role: role.role, package: role.package ?? null, about: role.about ?? '' })),
    licenses,
    packages,
  };
}

// 書き出しに写す既定の素材のファイル(出典の記録とライセンスの文)。[書き出しの中の場所, 中身]
export async function defaultMaterialFiles() {
  const files = [];
  async function walk(relative) {
    const full = path.join(DEFAULT_MATERIAL_DIR, relative);
    const stat = await fs.lstat(full).catch(() => null);
    if (!stat) return;
    if (stat.isDirectory()) {
      for (const name of (await fs.readdir(full)).sort()) await walk(path.posix.join(relative, name));
    } else if (stat.isFile()) {
      files.push([`${DEFAULT_MATERIAL_COPY}/${relative}`, await fs.readFile(full, 'utf8')]);
    }
  }
  for (const part of DEFAULT_MATERIAL_PARTS) await walk(part);
  return files;
}

const localTime = (iso) => (iso ? new Date(iso).toLocaleString('ja-JP') : '');

// Studio が見つけた、決める必要のあること(J8 の分)
export function decisionQuestions({ purpose, design, quality, shows, review }) {
  const questions = [];
  if (purpose.status === 'none') questions.push('目的の文書がない(目的の聞き出しをしていない)。誰の、何の問題を解く試作品かは、書き出した人のメモと目録の意図だけで読む。');
  else if (purpose.status === 'skipped') questions.push('目的の聞き出しを飛ばした。目的の文書はない。');
  else if (purpose.status !== 'decided') questions.push('目的の文書は下書きのままで、「決めた」の印がない。');
  if (design.status === 'none') questions.push('設計の段ごとの決定がない(設計の案内を使っていない)。');
  else if (design.status === 'skipped') questions.push('設計の案内を飛ばした。設計の段ごとの決定はない。');
  else if (design.status !== 'decided') questions.push('設計の案内を最後まで決めていない(「この設計で作る」を押していない)。');
  const stale = design.steps.filter((step) => step.stale).map((step) => step.label);
  if (stale.length > 0) questions.push(`設計の段のうち、前の段を選び直したので確かめ直しが要る段がある(${stale.join('、')})。`);
  const fix = quality.rows.filter((row) => row.status === 'fix').map((row) => row.label);
  if (fix.length > 0) questions.push(`質の見直しで「直す」が ${fix.length} つある(${fix.join('、')})。`);
  if (quality.audit?.stale) questions.push('質の見直しの画面の検査は、今の app/ か素材と違う状態で測ったもので、古い。');
  if (shows.broken) questions.push('人に見せた答えのファイルを読めなかった。読めた答えだけを入れた。');
  if (shows.records.length === 0) questions.push('人に見せた答えがない。試作品を人に見せて確かめていない。');
  if (review.status === 'missing') questions.push('AI 構成の審査が要る試作品なのに、AI 構成書を読めない。');
  if (review.status === 'skipped') questions.push(`AI 構成の審査を飛ばした(審査なし)。理由: ${review.skipped?.reason || '(書かれていない)'}。`);
  if (review.record && review.matches === false) questions.push(`今の構成は、AI 構成書で承認した構成と違う(変わった項目: ${review.changed.map((id) => REVIEW_ITEMS.find((item) => item.id === id)?.label ?? id).join('、')})。承認と違う。`);
  if (review.status === 'drafting' && review.matches !== false) questions.push(`AI 構成の審査は承認の途中(${review.items.filter((item) => item.approved).length} / ${review.items.length})。`);
  if (review.status === 'approved' && review.approvedUnmeasured) questions.push(`AI 構成書は、場面を回した数がないまま承認した(測らずに承認した。${localTime(review.approvedAt)})。`);
  return questions;
}
