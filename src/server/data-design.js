import { findRecords } from './redact.js';

// データ設計(docs/design/user-journey.md の K2)。設計の案内の「データ」の段で使う。
// 案は、覚えておくもの(表)、項目、つながりの 3 つで書く。日常の言葉で書き、主キーと外部キーの言葉も隠さない(field-session.md の段 3)。
// 形は Studio が整える。番号(主キー)とつながりの番号(外部キー)は Studio が付け、AI の文は名前と例にしか入れない。
// 整理の板のデータの欄は、全部どこかの項目に載せる。AI が落とした欄は、Studio が「聞いたことのメモ」に足す。
// 選んだ案から、試作品の架空のデータ(DATA_FILE)を作る。作るのは Studio で、値は AI の例か決まった形の文だけ。

// 架空のデータの置き場所(app/ からの相対パス)。作る AI に、この中身を読んで画面を描くよう頼む
export const DATA_FILE = 'data/design-data.json';
// 表を引くツールが読む、表ごとの架空のデータ(行の配列)。Studio が単一エージェントとマスターとサブの構成に書く(ai-architecture-review.md の 16 節)。
// 番号は案の表の順(1 から)。データの棚の表の id(data-shelf.js の table-<番号>)と同じ番号
export const designTableFile = (index) => `data/design-table-${index + 1}.json`;
const DESIGN_TABLE_PATTERN = /^data\/design-table-([1-9][0-9]?)\.json$/;
// 表のデータのファイルから、棚の表の id を返す。表のデータのファイルでなければ null
export function designTableShelfId(file) {
  const found = typeof file === 'string' ? DESIGN_TABLE_PATTERN.exec(file) : null;
  return found ? `table-${found[1]}` : null;
}

// 項目の種類。key は主キー、link は外部キー(つながりの先の番号)で、どちらも Studio が付ける
export const FIELD_KINDS = {
  key: '番号(主キー)',
  link: 'つながりの番号(外部キー)',
  text: '文',
  number: '数',
  date: '日付',
  choice: '選ぶもの',
};
const AI_KINDS = ['text', 'number', 'date', 'choice'];

export const KEY_FIELD = '番号';
// Studio が足す、覚えておくものの名前(AI の案に載っていなかった整理の板のデータの欄)
export const NOTE_ENTITY = '聞いたことのメモ';
export const SAMPLE_ROWS = 3;

const MAX_TITLE = 60;
const MAX_DETAIL = 300;
const MAX_REASON = 200;
const MAX_NAME = 30;
const MAX_ABOUT = 100;
const MAX_WRITER = 40;
const MAX_LABEL = 20;
const MAX_EXAMPLE = 40;
const MAX_EXAMPLES = 5;
const MAX_ENTITIES = 8;
const MAX_FIELDS = 12;
const MAX_LINKS = 12;

const BANNED_WORDS = /理想の構成|理想|最適|ベストプラクティス|最新の正解/;
const isBanned = (...texts) => texts.some((value) => BANNED_WORDS.test(value ?? ''));
const clip = (value, max) => (typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').slice(0, max) : '');
const hasRecord = (text) => findRecords(text).length > 0;

// つながりの番号の項目の名前。つながりの元(1 の側)の番号を持つ
export const linkFieldName = (from) => `${from}の番号`;

// 名前を重ならないようにする。重なったら (2)、(3) を付ける
function uniqueName(name, taken, max = MAX_NAME) {
  if (!taken.has(name)) return name;
  for (let n = 2; ; n += 1) {
    const suffix = `(${n})`;
    const candidate = `${name.slice(0, max - suffix.length)}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}

// 欄の文から作る名前。記録らしいもの(名前や電話番号の形)があれば、文を使わない(架空のデータに本物の記録を入れないため)
const itemName = (item) => (hasRecord(item.text) ? '' : clip(item.text, MAX_NAME)) || '聞いたこと';

// 整理の板のデータの欄。id と文だけを使う
export const dataItemsOf = (board) => (Array.isArray(board) ? board : []).filter((item) => item?.column === 'data' && typeof item.id === 'string' && typeof item.text === 'string');

// 案の中で、整理の板の項目を元にしている所(項目と、覚えておくもの)
export function citedItems(option) {
  const cited = new Set();
  for (const entity of option?.entities ?? []) {
    for (const source of entity.sources ?? []) cited.add(source);
    for (const field of entity.fields ?? []) for (const source of field.sources ?? []) cited.add(source);
  }
  return cited;
}

// 整理の板のデータの欄が、案のどこに載ったか。載っていないものは where が空
export function dataCoverage(option, board) {
  return dataItemsOf(board).map((item) => {
    const where = [];
    for (const entity of option?.entities ?? []) {
      if ((entity.sources ?? []).includes(item.id)) where.push(entity.name);
      for (const field of entity.fields ?? []) if ((field.sources ?? []).includes(item.id)) where.push(`${entity.name}の${field.name}`);
    }
    return { id: item.id, text: item.text, where };
  });
}

// 案の形の検査。問題の文の一覧を返す(空なら正しい形)。
// 覚えておくものの名前が重ならない、項目の名前が重ならない、主キーが 1 つ、つながりの先がある、外部キーがつながりと合う
export function dataDesignProblems(option) {
  const problems = [];
  const entities = Array.isArray(option?.entities) ? option.entities : [];
  if (entities.length === 0) problems.push('覚えておくものがありません');
  const names = new Set();
  for (const entity of entities) {
    if (!entity?.name) {
      problems.push('名前のない覚えておくものがあります');
      continue;
    }
    if (names.has(entity.name)) problems.push(`覚えておくもの「${entity.name}」が重なっています`);
    names.add(entity.name);
  }
  const links = Array.isArray(option?.links) ? option.links : [];
  const pairs = new Set();
  for (const link of links) {
    if (!names.has(link?.from)) problems.push(`つながりの元「${link?.from}」がありません`);
    if (!names.has(link?.to)) problems.push(`つながりの先「${link?.to}」がありません`);
    if (link?.from === link?.to) problems.push(`「${link?.from}」が自分につながっています`);
    const pair = `${link?.from}\n${link?.to}`;
    if (pairs.has(pair)) problems.push(`「${link?.from}」から「${link?.to}」へのつながりが重なっています`);
    pairs.add(pair);
  }
  for (const entity of entities) {
    const fields = Array.isArray(entity?.fields) ? entity.fields : [];
    const fieldNames = new Set();
    for (const field of fields) {
      if (!field?.name) problems.push(`「${entity.name}」に名前のない項目があります`);
      else if (fieldNames.has(field.name)) problems.push(`「${entity.name}」の項目「${field.name}」が重なっています`);
      fieldNames.add(field?.name);
      if (!Object.hasOwn(FIELD_KINDS, field?.kind)) problems.push(`「${entity.name}」の項目「${field?.name}」の種類が分かりません`);
      if (field?.kind === 'link') {
        if (!names.has(field.to)) problems.push(`「${entity.name}」の項目「${field.name}」のつながりの先「${field.to}」がありません`);
        else if (!links.some((link) => link.from === field.to && link.to === entity.name)) problems.push(`「${entity.name}」の項目「${field.name}」に合うつながりがありません`);
      }
    }
    if (fields.filter((field) => field?.kind === 'key').length !== 1) problems.push(`「${entity.name}」の番号(主キー)が 1 つではありません`);
    for (const link of links.filter((item) => item?.to === entity.name)) {
      if (!fields.some((field) => field?.kind === 'link' && field.to === link.from)) problems.push(`「${entity.name}」に「${link.from}」へのつながりの番号がありません`);
    }
  }
  return problems;
}

// 例の文をそろえる。記録らしいもの(名前や電話番号の形)は捨てる。架空のデータだけを使うため
function cleanExamples(value) {
  if (!Array.isArray(value)) return [];
  const examples = [];
  for (const raw of value) {
    const text = typeof raw === 'number' && Number.isFinite(raw) ? String(raw) : clip(raw, MAX_EXAMPLE);
    if (!text || hasRecord(text) || examples.includes(text)) continue;
    examples.push(text);
    if (examples.length >= MAX_EXAMPLES) break;
  }
  return examples;
}

const knownSources = (value, known) => (Array.isArray(value) ? [...new Set(value.filter((source) => known.has(source)))] : []);

// 覚えておくものとつながりから、形の整った案を作る。番号(主キー)とつながりの番号(外部キー)を Studio が付ける。
// 重なる名前は捨て、先のないつながりは捨てる。整理の板のデータの欄で載っていないものは、「聞いたことのメモ」に足す
export function shapeDataOption({ title, detail, reason, entities: rawEntities, links: rawLinks }, board) {
  const items = dataItemsOf(board);
  const known = new Set(items.map((item) => item.id));
  const entities = [];
  const names = new Set();
  for (const raw of Array.isArray(rawEntities) ? rawEntities : []) {
    if (entities.length >= MAX_ENTITIES) break;
    const name = clip(raw?.name, MAX_NAME);
    if (!name || names.has(name) || hasRecord(name)) continue;
    names.add(name);
    const fields = [{ name: KEY_FIELD, kind: 'key', examples: [], sources: [] }];
    const fieldNames = new Set([KEY_FIELD]);
    for (const rawField of Array.isArray(raw?.fields) ? raw.fields : []) {
      if (fields.length >= MAX_FIELDS) break;
      const fieldName = clip(rawField?.name, MAX_NAME);
      if (!fieldName || fieldNames.has(fieldName) || hasRecord(fieldName)) continue;
      fieldNames.add(fieldName);
      const kind = AI_KINDS.includes(rawField?.kind) ? rawField.kind : 'text';
      fields.push({ name: fieldName, kind, examples: cleanExamples(rawField?.examples), sources: knownSources(rawField?.sources, known) });
    }
    entities.push({ name, about: clip(raw?.about, MAX_ABOUT), writer: clip(raw?.writer, MAX_WRITER), fields, sources: knownSources(raw?.sources, known) });
  }
  const links = [];
  for (const raw of Array.isArray(rawLinks) ? rawLinks : []) {
    if (links.length >= MAX_LINKS) break;
    const from = clip(raw?.from, MAX_NAME);
    const to = clip(raw?.to, MAX_NAME);
    // つながりの先がないもの、自分へのつながり、重なるつながりは捨てる
    if (!names.has(from) || !names.has(to) || from === to || links.some((link) => link.from === from && link.to === to)) continue;
    links.push({ from, to, label: clip(raw?.label, MAX_LABEL) || 'つながる' });
  }
  // つながりの先(多の側)に、元の番号の項目を足す。同じ名前の項目があれば、それを外部キーにする
  for (const link of links) {
    const entity = entities.find((item) => item.name === link.to);
    // 切らずに付ける(切ると、架空のデータのつながりの印と名前が合わなくなる)
    const fieldName = linkFieldName(link.from);
    const at = entity.fields.findIndex((field) => field.name === fieldName);
    // 名前は「〜の番号」なので、主キー(番号)とは重ならない
    const linkField = { name: fieldName, kind: 'link', to: link.from, examples: [], sources: at === -1 ? [] : entity.fields[at].sources };
    if (at === -1) entity.fields.splice(1, 0, linkField);
    else entity.fields[at] = linkField;
  }
  // 載っていない整理の板のデータの欄を、メモに足す。どの欄も、どこかに載るように
  const added = [];
  if (entities.length > 0) {
    const cited = citedItems({ entities });
    const missing = items.filter((item) => !cited.has(item.id));
    if (missing.length > 0) {
      const note = { name: uniqueName(NOTE_ENTITY, names), about: '案に載っていなかった、整理の板のデータの欄です。Studio が足しました。', writer: '人', fields: [{ name: KEY_FIELD, kind: 'key', examples: [], sources: [] }], sources: [], by: 'studio' };
      entities.push(note);
      const taken = new Set(note.fields.map((field) => field.name));
      for (const item of missing) {
        const name = uniqueName(itemName(item), taken);
        taken.add(name);
        note.fields.push({ name, kind: 'text', examples: [], sources: [item.id], by: 'studio' });
        added.push(item.id);
      }
    }
  }
  return {
    title: clip(title, MAX_TITLE),
    detail: clip(detail, MAX_DETAIL) || `覚えておくもの ${entities.length} つ、つながり ${links.length} つ`,
    reason: clip(reason, MAX_REASON),
    entities,
    links,
    added,
  };
}

// 前に選んだ案を、今の整理の板で整え直す(「案を作り直す」のとき)。Studio が付けた番号、つながりの番号、メモを外してから整える。
// 案を作った後に板に足した欄が、選んだ案にも載るように
export function reshapeDataOption(option, board) {
  const entities = (option?.entities ?? [])
    .filter((entity) => entity.by !== 'studio')
    .map((entity) => ({ ...entity, fields: entity.fields.filter((field) => AI_KINDS.includes(field.kind) && field.by !== 'studio') }));
  return { ...option, ...shapeDataOption({ ...option, entities }, board) };
}

// AI の案を検査する。使える案が 2 つそろわなければ null(決まった案を使う)
export function aiDataOptions(raw, board) {
  const all = (Array.isArray(raw?.options) ? raw.options : []).map((option) => (option && typeof option === 'object' ? shapeDataOption(option, board) : null));
  const textsOf = (option) => [
    option.title, option.detail, option.reason,
    ...option.entities.flatMap((entity) => [entity.name, entity.about, entity.writer, ...entity.fields.flatMap((field) => [field.name, ...field.examples])]),
    ...option.links.map((link) => link.label),
  ];
  const list = all.filter((option) => option && option.title && option.entities.length > 0 && !isBanned(...textsOf(option)) && dataDesignProblems(option).length === 0).slice(0, 3);
  if (list.length < 2) return null;
  const wanted = all[raw.recommended];
  return { options: list, recommended: Math.max(0, list.indexOf(wanted)) };
}

// Studio の決まった案。AI を使わないときと、AI の返事を使えないときに出す。整理の板のデータの欄を、どの案にも全部載せる
export function fixedDataOptions(board) {
  const items = dataItemsOf(board);
  const people = (Array.isArray(board) ? board : []).filter((item) => item?.column === 'user').map((item) => item.text);
  const record = { name: '相談の記録', about: '話しかけられた 1 回ごとの記録です。', writer: 'AI が会話の中で書く' };
  const recordFields = [
    { name: '受けた日', kind: 'date' },
    { name: '用件', kind: 'text', examples: ['問い合わせ', '申し込み', 'そのほか'] },
  ];
  // 欄の文を項目にする。名前は欄の文を短くしたもの
  const itemFields = (taken) => items.map((item) => {
    const name = uniqueName(itemName(item), taken);
    taken.add(name);
    return { name, kind: 'text', sources: [item.id] };
  });
  if (items.length === 0) {
    return [
      shapeDataOption({
        title: '相談の記録だけ',
        reason: '整理の板にデータの欄がないので、話しかけられたことだけを覚えます。いちばん小さく始められます。',
        entities: [{ ...record, fields: [...recordFields, { name: '答えたこと', kind: 'text' }, { name: '人に渡したか', kind: 'choice', examples: ['渡した', '渡していない'] }] }],
        links: [],
      }, board),
      shapeDataOption({
        title: '相談の記録と、よくある問いと答え',
        reason: '答えの元を別に持つので、同じ問いに同じ答えを返せます。覚えるものは 2 つに増えます。',
        entities: [
          { name: 'よくある問いと答え', about: '答えの元にする、決まった問いと答えです。', writer: '人が前もって書く', fields: [{ name: '問い', kind: 'text' }, { name: '答え', kind: 'text' }] },
          { ...record, fields: recordFields },
        ],
        links: [{ from: 'よくある問いと答え', to: '相談の記録', label: '答えに使う' }],
      }, board),
    ];
  }
  // 欄を 1 つずつ覚えておくものにする。相談の記録からつなぐ(1 つの相談で、いくつも書く)
  const taken = new Set([record.name, NOTE_ENTITY]);
  const split = items.map((item) => {
    const name = uniqueName(itemName(item), taken);
    taken.add(name);
    return { name, about: hasRecord(item.text) ? '整理の板のデータの欄です。' : `整理の板の「${clip(item.text, 60)}」です。`, writer: 'AI が会話の中で書く', sources: [item.id], fields: [{ name: '中身', kind: 'text', sources: [item.id] }] };
  });
  const options = [
    shapeDataOption({
      title: '聞いたデータごとに分ける',
      reason: '整理の板のデータの欄を、1 つずつ覚えておくものにします。つながりが見えやすくなります。表の数は増えます。',
      entities: [{ ...record, fields: recordFields }, ...split],
      links: split.map((entity) => ({ from: record.name, to: entity.name, label: '会話の中で書く' })),
    }, board),
    shapeDataOption({
      title: '1 つの表にまとめる',
      reason: '表が 1 つなので、いちばん簡単です。同じことを何度も書くことがあります。',
      entities: [{ ...record, fields: [...recordFields, ...itemFields(new Set([KEY_FIELD, ...recordFields.map((field) => field.name)]))] }],
      links: [],
    }, board),
  ];
  if (people.length > 0) {
    options.push(shapeDataOption({
      title: '使う人ごとにまとめる',
      reason: '整理の板の使う人を覚えておくものにします。同じ人の相談を並べて見られます。人の名前は架空のものだけを使います。',
      entities: [
        { name: '使う人', about: `整理の板の使う人(${clip(people.slice(0, 2).join('、'), 60)})です。`, writer: '人が前もって書く', fields: [{ name: '呼び名', kind: 'text', examples: ['架空の人 A', '架空の人 B', '架空の人 C'] }, { name: '種類', kind: 'choice', examples: people.slice(0, 3).map((text) => clip(text, MAX_EXAMPLE)) }] },
        { ...record, fields: [...recordFields, ...itemFields(new Set([KEY_FIELD, ...recordFields.map((field) => field.name), linkFieldName('使う人')]))] },
      ],
      links: [{ from: '使う人', to: '相談の記録', label: '相談する' }],
    }, board));
  }
  return options;
}

// 架空の値。例があれば順に使い、なければ決まった形の文にする
function sampleValue(field, row, entityIndex, keysOf) {
  const n = row + 1;
  if (field.kind === 'key') return (entityIndex + 1) * 1000 + n;
  if (field.kind === 'link') {
    const keys = keysOf(field.to);
    return keys.length > 0 ? keys[row % keys.length] : null;
  }
  const examples = field.examples ?? [];
  if (field.kind === 'number') {
    const numbers = examples.map(Number).filter(Number.isFinite);
    return numbers.length > 0 ? numbers[row % numbers.length] : n;
  }
  if (examples.length > 0) return examples[row % examples.length];
  if (field.kind === 'date') return `2030-01-${String(n).padStart(2, '0')}`;
  if (field.kind === 'choice') return n % 2 === 1 ? 'はい' : 'いいえ';
  return `${field.name}の例 ${n}(架空)`;
}

// 選んだ案から、試作品の架空のデータを作る。表ごとに SAMPLE_ROWS 行。つながりの番号は、つながりの元の番号を指す
export function sampleData(option) {
  const entities = option?.entities ?? [];
  const keysOf = (name) => {
    const index = entities.findIndex((entity) => entity.name === name);
    return index === -1 ? [] : Array.from({ length: SAMPLE_ROWS }, (_, row) => (index + 1) * 1000 + row + 1);
  };
  return {
    formatVersion: 1,
    note: '架空のデータです。Studio が設計の案から作りました。実在の人、会社、場所とは関係ありません。',
    design: option?.title ?? '',
    tables: entities.map((entity, index) => ({
      name: entity.name,
      about: entity.about,
      key: KEY_FIELD,
      columns: entity.fields.map((field) => field.name),
      rows: Array.from({ length: SAMPLE_ROWS }, (_, row) => Object.fromEntries(entity.fields.map((field) => [field.name, sampleValue(field, row, index, keysOf)]))),
    })),
    links: (option?.links ?? []).map((link) => ({ from: link.from, to: link.to, label: link.label, field: entities.find((entity) => entity.name === link.to)?.fields.find((field) => field.kind === 'link' && field.to === link.from)?.name ?? linkFieldName(link.from) })),
  };
}

// 依頼に入れるデータ設計の上限(文字)。依頼の全体は 4000 文字までで、後ろの場面の決まりの文を押し出さないように
export const MAX_DATA_REQUEST = 1200;

// 作る AI への依頼に入れる行(design.js の designRequest)。written は、Studio が架空のデータを書けたか(持ち主が直したファイルは書き換えない)
export function dataRequestLines(option, { written = true } = {}) {
  if (!option) return [];
  const lines = [
    `データ: ${option.title}`,
    written
      ? `架空のデータは ${DATA_FILE} に Studio が書きました。試作品の画面は、このデータを読んで描いてください。中身は変えないでください。prototype.json の data に、このファイルを書いてください。`
      : `${DATA_FILE} は持ち主が直したので、Studio は書き換えていません。選んだ案の表と項目は次のとおりです。`,
  ];
  const details = [
    ...option.entities.map((entity) => `- ${entity.name}: ${entity.fields.map((field) => field.name).join('、')}`.slice(0, 200)),
    ...option.links.map((link) => `- つながり: 1 つの${link.from}に、いくつもの${link.to}(${link.label})`.slice(0, 120)),
  ];
  let used = lines.join('\n').length;
  for (const [index, line] of details.entries()) {
    if (used + line.length + 1 > MAX_DATA_REQUEST) {
      lines.push(`- ほか ${details.length - index} 行(全部は ${DATA_FILE} にあります)`);
      break;
    }
    lines.push(line);
    used += line.length + 1;
  }
  return lines;
}
