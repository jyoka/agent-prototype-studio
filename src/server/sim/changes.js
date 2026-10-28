// 前と後のビルドの構成、ツール、ガードレールを比べ、どこが変わったかを利用者向けの文で返す(docs/design/agent-simulation.md の 2.7)。
// ガードレールが減った(なくした、弱めた)ところは weakened に分けて返し、作る会話で目立つ印を付ける。
// 作る AI の報告ではなく、Studio がビルドできたものどうしを比べる(describeDefinitionChanges と同じ考え)。

const KIND_LABELS = { agent: '模擬のエージェント', harness: 'harness', human: '人' };
const LAYER_LABELS = { prompt: 'プロンプトの頼み', output: '出口の確かめ' };
const AI_RULE_LABELS = {
  noNewNumbers: '数字を作らない(noNewNumbers)',
  noLeading: '誘導しない(noLeading)',
  mustAsk: '問いの原文を入れる(mustAsk)',
};

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const names = (items) => items.map((item) => `「${item}」`).join('、');
const declared = (composition) => Boolean(composition?.file);

function describeComposition(composition) {
  if (!composition) return 'なし';
  if (!composition.file) return '構成 B の読み替え(ai.json の harness 1 つ)';
  return `app/${composition.file}${composition.name ? `「${composition.name}」` : ''}`;
}

// 構成が使うツールの宣言(tools)の中のツール
function toolsIn(simulation, composition) {
  if (!composition?.tools) return [];
  return simulation?.tools?.[composition.tools]?.tools ?? [];
}

// 上限の値が緩んだか(なくした、大きくした)
const loosened = (was, now) => was !== undefined && was !== null && (now === undefined || now === null || now > was);

function describeToolGuards(tool, was, now, out) {
  const at = `ツール「${tool}」の守り`;
  for (const key of ['requires', 'deny']) {
    // deny の断るときの文(message)だけの違いは、守りを減らしたことにしない
    const rule = ({ message, ...rest }) => JSON.stringify(rest);
    const before = (was[key] ?? []).map(rule);
    const after = (now[key] ?? []).map(rule);
    const removed = before.filter((item) => !after.includes(item));
    const added = after.filter((item) => !before.includes(item));
    if (removed.length > 0) out.weakened.push(`${at} ${key} から外した: ${removed.join('、')}`);
    if (added.length > 0) out.lines.push(`${at} ${key} に足した: ${added.join('、')}`);
    if (removed.length === 0 && added.length === 0 && !same(was[key] ?? [], now[key] ?? [])) out.lines.push(`${at} ${key} の断るときの文を変えました`);
  }
  const hiddenBefore = was.hideFields ?? [];
  const hiddenAfter = now.hideFields ?? [];
  const shown = hiddenBefore.filter((field) => !hiddenAfter.includes(field));
  const hidden = hiddenAfter.filter((field) => !hiddenBefore.includes(field));
  if (shown.length > 0) out.weakened.push(`${at} hideFields から外した(結果に出るようになった項目): ${names(shown)}`);
  if (hidden.length > 0) out.lines.push(`${at} hideFields に足した: ${names(hidden)}`);
  for (const key of ['maxCallsPerConversation', 'maxResultChars']) {
    if (was[key] === now[key]) continue;
    const text = `${at} ${key}: ${was[key] ?? 'なし'} → ${now[key] ?? 'なし'}`;
    if (loosened(was[key], now[key])) out.weakened.push(text);
    else out.lines.push(text);
  }
}

function describeTools(wasTools, nowTools, out) {
  const wasNames = wasTools.map((tool) => tool.name);
  const nowNames = nowTools.map((tool) => tool.name);
  const added = nowNames.filter((name) => !wasNames.includes(name));
  const removed = wasNames.filter((name) => !nowNames.includes(name));
  if (added.length > 0) out.lines.push(`足したツール: ${names(added)}`);
  if (removed.length > 0) out.lines.push(`なくしたツール: ${names(removed)}`);
  for (const now of nowTools) {
    const was = wasTools.find((tool) => tool.name === now.name);
    if (!was) continue;
    if (was.description !== now.description) out.lines.push(`ツール「${now.name}」の説明を変えました`);
    if (!same(was.inputSchema, now.inputSchema)) out.lines.push(`ツール「${now.name}」の引数の形(inputSchema)を変えました`);
    if (was.do.op !== now.do.op) out.lines.push(`ツール「${now.name}」の処理: ${was.do.op} → ${now.do.op}`);
    else if (!same(was.do, now.do)) out.lines.push(`ツール「${now.name}」の処理(${now.do.op})の中身を変えました`);
    if (was.owner !== now.owner) out.lines.push(`ツール「${now.name}」の持ち主: ${was.owner} → ${now.owner}`);
    describeToolGuards(now.name, was.guards, now.guards, out);
  }
}

function describeGuards(was, now, out) {
  const ids = (composition) => (composition?.guards ?? []).map((guard) => guard.id);
  const label = (guard) => `守り「${guard.id}」(${LAYER_LABELS[guard.layer]}、持ち主 ${guard.owner}、${guard.on} に)`;
  for (const guard of now?.guards ?? []) {
    if (!ids(was).includes(guard.id)) out.lines.push(`足した${label(guard)}`);
  }
  for (const guard of was?.guards ?? []) {
    if (!ids(now).includes(guard.id)) out.weakened.push(`なくした${label(guard)}`);
  }
  for (const guardNow of now?.guards ?? []) {
    const guardWas = (was?.guards ?? []).find((guard) => guard.id === guardNow.id);
    if (!guardWas || same(guardWas, guardNow)) continue;
    const at = `守り「${guardNow.id}」`;
    if (guardWas.layer !== guardNow.layer) {
      // 出口の確かめ(コードが確かめる)からプロンプトの頼み(相手しだい)にするのは、守りを弱めたことになる
      const text = `${at}の層: ${LAYER_LABELS[guardWas.layer]} → ${LAYER_LABELS[guardNow.layer]}`;
      if (guardWas.layer === 'output') out.weakened.push(text);
      else out.lines.push(text);
      continue;
    }
    // 付ける参加者を替えると、前の参加者には効かなくなる
    if (guardWas.on !== guardNow.on) out.weakened.push(`${at}を付ける参加者: ${guardWas.on} → ${guardNow.on}(${guardWas.on} には効かなくなります)`);
    if (guardWas.owner !== guardNow.owner) out.lines.push(`${at}の持ち主: ${guardWas.owner} → ${guardNow.owner}`);
    if (guardNow.layer === 'prompt' && guardWas.text !== guardNow.text) out.lines.push(`${at}の頼みの文を変えました`);
    if (guardNow.layer === 'output') {
      if (guardWas.enforce && !guardNow.enforce) out.weakened.push(`${at}: 止める → 記録だけ(enforce: false)`);
      if (!guardWas.enforce && guardNow.enforce) out.lines.push(`${at}: 記録だけ → 止める(enforce: true)`);
      describeOutputRules(at, guardWas.rules, guardNow.rules, out);
    }
  }
}

function describeOutputRules(at, was, now, out) {
  if (was.noNewNumbers && !now.noNewNumbers) out.weakened.push(`${at}の数字を作らない(noNewNumbers): する → しない`);
  if (!was.noNewNumbers && now.noNewNumbers) out.lines.push(`${at}の数字を作らない(noNewNumbers): しない → する`);
  if (was.maxReplyChars !== now.maxReplyChars) {
    const text = `${at}の返事の長さの上限(maxReplyChars): ${was.maxReplyChars ?? 'なし'} → ${now.maxReplyChars ?? 'なし'}`;
    if (loosened(was.maxReplyChars, now.maxReplyChars)) out.weakened.push(text);
    else out.lines.push(text);
  }
  const removed = was.forbidden.filter((word) => !now.forbidden.includes(word));
  const added = now.forbidden.filter((word) => !was.forbidden.includes(word));
  if (removed.length > 0) out.weakened.push(`${at}の禁止の言葉(forbidden)から外した: ${names(removed)}`);
  if (added.length > 0) out.lines.push(`${at}の禁止の言葉(forbidden)に足した: ${names(added)}`);
}

function describeParticipants(was, now, out) {
  const wasList = was?.participants ?? [];
  const nowList = now?.participants ?? [];
  const label = (p) => `「${p.label}」(${p.id}、${KIND_LABELS[p.kind]})`;
  const added = nowList.filter((p) => !wasList.some((q) => q.id === p.id));
  const removed = wasList.filter((p) => !nowList.some((q) => q.id === p.id));
  if (added.length > 0) out.lines.push(`足した参加者: ${added.map(label).join('、')}`);
  if (removed.length > 0) out.lines.push(`なくした参加者: ${removed.map(label).join('、')}`);
  if (was?.driver !== now?.driver && was && now) out.lines.push(`回し手(driver): ${was.driver} → ${now.driver}`);
  for (const p of nowList) {
    const q = wasList.find((item) => item.id === p.id);
    if (!q || same(p, q)) continue;
    const at = `参加者「${p.label}」(${p.id})`;
    if (q.kind !== p.kind) {
      out.lines.push(`${at}の種類: ${KIND_LABELS[q.kind]} → ${KIND_LABELS[p.kind]}`);
      continue;
    }
    if (q.label !== p.label) out.lines.push(`${at}の名前: 「${q.label}」 → 「${p.label}」`);
    if (q.owner !== p.owner) out.lines.push(`${at}の持ち主: ${q.owner} → ${p.owner}`);
    const givenBefore = q.tools ?? [];
    const givenAfter = p.tools ?? [];
    const given = givenAfter.filter((name) => !givenBefore.includes(name));
    const taken = givenBefore.filter((name) => !givenAfter.includes(name));
    if (given.length > 0) out.lines.push(`${at}に渡すツールに足した: ${names(given)}`);
    if (taken.length > 0) out.lines.push(`${at}に渡すツールから外した: ${names(taken)}`);
    if (!same(q.prompt, p.prompt)) out.lines.push(`${at}のプロンプトの組み方(prompt)を変えました`);
    if (!same(q.mock, p.mock)) out.lines.push(`${at}のモック: ${JSON.stringify(q.mock)} → ${JSON.stringify(p.mock)}`);
    if (q.ai !== p.ai) out.lines.push(`${at}の harness の設定: app/${q.ai} → app/${p.ai}`);
    if (q.returnTo !== p.returnTo) out.lines.push(`${at}の戻り先(returnTo): ${q.returnTo ?? 'なし'} → ${p.returnTo ?? 'なし'}`);
  }
}

function describeHandoffs(was, now, out) {
  const key = (edge) => `${edge.from} → ${edge.to}`;
  const wasEdges = was?.handoffs ?? [];
  const nowEdges = now?.handoffs ?? [];
  const added = nowEdges.filter((edge) => !wasEdges.some((e) => key(e) === key(edge)));
  const removed = wasEdges.filter((edge) => !nowEdges.some((e) => key(e) === key(edge)));
  if (added.length > 0) out.lines.push(`足した引き継ぎの辺: ${added.map(key).join('、')}`);
  if (removed.length > 0) out.lines.push(`なくした引き継ぎの辺: ${removed.map(key).join('、')}`);
  for (const edge of nowEdges) {
    const before = wasEdges.find((e) => key(e) === key(edge));
    if (before && !same(before.carry, edge.carry)) {
      out.lines.push(`辺 ${key(edge)} で受け渡す値(carry): ${before.carry.join('、') || 'なし'} → ${edge.carry.join('、') || 'なし'}`);
    }
  }
}

// 1 つの構成の前と後を比べる。ツールの宣言は、指すファイルを替えたときだけここで比べる(同じファイルの中の変化は describeSimulationChanges がファイルごとに 1 回比べる)
function describeCompositionPair(before, after, was, now, out) {
  describeParticipants(was, now, out);
  describeHandoffs(was, now, out);
  describeGuards(was, now, out);
  const wasFile = was?.tools ?? null;
  const nowFile = now?.tools ?? null;
  if (wasFile !== nowFile) {
    if (declared(was) && declared(now)) out.lines.push(`使うツールの宣言(tools): ${wasFile ? `app/${wasFile}` : 'なし'} → ${nowFile ? `app/${nowFile}` : 'なし'}`);
    describeTools(toolsIn(before, was), toolsIn(after, now), out);
  }
  if (!same(was?.surface ?? null, now?.surface ?? null)) {
    out.lines.push(`会話の枠(surface): ${JSON.stringify(was?.surface ?? null)} → ${JSON.stringify(now?.surface ?? null)}`);
  }
  if (!same(was?.assumptions ?? null, now?.assumptions ?? null)) {
    out.lines.push(`前提の置き場所と既定(assumptions): ${JSON.stringify(was?.assumptions ?? null)} → ${JSON.stringify(now?.assumptions ?? null)}`);
  }
  if (was && now && !same(was.limits, now.limits)) {
    out.lines.push(`会話の上限(limits): ${JSON.stringify(was.limits)} → ${JSON.stringify(now.limits)}`);
  }
}

// out に、行の頭に prefix を付けて足す
function describeWithPrefix(prefix, out, describe) {
  const part = { lines: [], weakened: [] };
  describe(part);
  out.lines.push(...part.lines.map((line) => `${prefix}${line}`));
  out.weakened.push(...part.weakened.map((line) => `${prefix}${line}`));
}

// 前と後のビルドの読んだもの(readSimulation の simulation)を比べる。
// 既定の構成、比べるための構成(compositions/ の同じファイルどうし)、ツールの宣言(ファイルごと)を比べる。
// 既定の構成のものでない行には、どのファイルの変化かを頭に付ける。
// どちらも構成 B の読み替え(composition.json がない)で、ほかの構成もなければ、何も返さない。ai.json の変化は describeDefinitionChanges が出す
export function describeSimulationChanges(before, after) {
  const out = { lines: [], weakened: [] };
  const was = before?.composition ?? null;
  const now = after?.composition ?? null;
  if (declared(was) || declared(now)) {
    if (declared(was) !== declared(now) || was?.file !== now?.file) {
      out.lines.push(`既定の構成: ${describeComposition(was)} → ${describeComposition(now)}`);
    } else if (was.name !== now.name) {
      out.lines.push(`構成の名前: 「${was.name ?? ''}」 → 「${now.name ?? ''}」`);
    }
    describeCompositionPair(before, after, was, now, out);
  }
  // 比べるための構成。後の場面で点を比べる相手なので、中身の変化(守りを外すことも)を既定の構成と同じに比べる
  const others = (simulation) => simulation?.compositions ?? [];
  for (const { file, composition } of others(after)) {
    const previous = others(before).find((item) => item.file === file);
    if (!previous || same(previous.composition, composition)) continue;
    describeWithPrefix(`app/${file}: `, out, (part) => describeCompositionPair(before, after, previous.composition, composition, part));
  }
  // ツールの宣言は、ファイルごとに比べる(既定の構成が使わず、比べるための構成だけが使うものも)
  const users = (simulation, file) => [simulation?.composition, ...others(simulation).map((item) => item.composition)]
    .filter((composition) => composition?.file && composition.tools === file)
    .map((composition) => `app/${composition.file}`);
  for (const [file, toolset] of Object.entries(after?.tools ?? {})) {
    const previous = before?.tools?.[file];
    if (!previous || same(previous.tools, toolset.tools)) continue;
    // 既定の構成が前も後も使うファイルは、頭に何も付けない
    const byDefault = was?.tools === file && now?.tools === file;
    const usedBy = users(after, file);
    const prefix = byDefault ? '' : `app/${file}${usedBy.length > 0 ? `(${usedBy.join('、')} が使う)` : ''}: `;
    describeWithPrefix(prefix, out, (part) => describeTools(previous.tools, toolset.tools, part));
  }
  // harness の参加者が使う、目録の ai でない ai.json(目録の ai は describeDefinitionChanges と weakenedAiRules が見る)
  for (const [file, definition] of Object.entries(after?.harnessAis ?? {})) {
    const previous = before?.harnessAis?.[file];
    if (!previous || same(previous, definition)) continue;
    out.lines.push(`harness の設定 app/${file} を変えました`);
    out.weakened.push(...weakenedAiRules(previous, definition, `app/${file}`));
  }
  const files = (simulation) => others(simulation).map((item) => item.file);
  const addedFiles = files(after).filter((file) => !files(before).includes(file));
  const removedFiles = files(before).filter((file) => !files(after).includes(file));
  if (addedFiles.length > 0) out.lines.push(`比べるための構成に足した: ${addedFiles.map((f) => `app/${f}`).join('、')}`);
  if (removedFiles.length > 0) out.lines.push(`比べるための構成からなくした: ${removedFiles.map((f) => `app/${f}`).join('、')}`);
  return out;
}

// ai.json の rules(構成 B の出口の確かめ)のうち、弱めたもの。変化の文そのものは describeDefinitionChanges が出す
export function weakenedAiRules(before, after, file = 'ai.json') {
  if (!before || !after) return [];
  const lines = [];
  for (const [key, label] of Object.entries(AI_RULE_LABELS)) {
    if (before.rules[key] && !after.rules[key]) lines.push(`${file} の守ること「${label}」: する → しない`);
  }
  if (after.rules.maxReplyChars > before.rules.maxReplyChars) {
    lines.push(`${file} の守ること「返事の長さの上限(maxReplyChars)」: ${before.rules.maxReplyChars} 文字 → ${after.rules.maxReplyChars} 文字`);
  }
  const removed = before.rules.forbidden.filter((word) => !after.rules.forbidden.includes(word));
  if (removed.length > 0) lines.push(`${file} の守ること「禁止の言葉(forbidden)」から外した: ${names(removed)}`);
  return lines;
}

// 構成が指すファイル(ツールのデータ、プロンプトの枠、モック、harness の設定)。作る run で変わったかを見るのに使う
export function referencedFiles(simulation) {
  if (!simulation) return [];
  // 構成 B の読み替え(file がない)は ai.json だけを指し、その変化は今の文で出すので入れない
  const compositions = [simulation.composition, ...(simulation.compositions ?? []).map((item) => item.composition)].filter((c) => c?.file);
  const files = new Set();
  for (const composition of compositions) {
    for (const participant of composition.participants) {
      for (const piece of participant.prompt ?? []) if (piece.file) files.add(piece.file);
      if (typeof participant.mock === 'string') files.add(participant.mock);
      if (participant.ai) files.add(participant.ai);
    }
  }
  for (const toolset of Object.values(simulation.tools ?? {})) {
    for (const tool of toolset.tools) if (tool.do.data) files.add(tool.do.data);
  }
  return [...files].map((file) => `app/${file}`);
}

// ガードレールの指紋。直すラウンドでガードレールが変わったか(guardsChanged の印)を見るのに使う。
// 中身: 構成ごとの守り(guards)、引き継ぎの辺(handoffs)、参加者に渡すツールの名前、ツールごとの守り、harness の ai.json の rules(目録の ai も)
export function guardFingerprint(simulation, ai) {
  if (!simulation) return JSON.stringify({ ai: ai?.rules ?? null });
  const compositions = [simulation.composition, ...(simulation.compositions ?? []).map((item) => item.composition)].filter(Boolean);
  return JSON.stringify({
    // 参加者に渡すツールの名前も守り(許可していない名前は permission の層で断る)。外すと、その確かめが n/a になるため
    compositions: compositions.map((c) => [c.file ?? null, c.guards ?? [], c.handoffs ?? [], c.participants.map((p) => [p.id, p.kind, p.tools ?? null])]),
    tools: Object.entries(simulation.tools ?? {}).sort(([a], [b]) => (a < b ? -1 : 1)).map(([file, toolset]) => [file, toolset.tools.map((tool) => [tool.name, tool.guards ?? null])]),
    ai: ai?.rules ?? null,
    harness: Object.entries(simulation.harnessAis ?? {}).sort(([a], [b]) => (a < b ? -1 : 1)).map(([file, definition]) => [file, definition.rules]),
  });
}
