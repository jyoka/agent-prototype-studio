import { createHash, randomBytes } from 'node:crypto';
import { ConnectionError } from '../product-ai/claude-code.js';
import { normalizeValue } from '../product-ai/definition.js';
import { numbersIn } from '../product-ai/guards.js';
import { startFlowMemory, startProgress, turn } from '../product-ai/harness.js';
import { agentPrompt, agentStdin, maxPerReplyOf } from './agent-claude-code.js';
import { isPlainObject } from './check.js';
import { describeParts, fitParts, partKindsOf, partsToCheckedText, partsToText, replySchema } from './parts.js';
import { callTool, refusedEntry } from './tool-gate.js';

// 会話の進め方(orchestrator。docs/design/agent-simulation.md の 3.1、3.2)。構成(composition.json)のある試作品の 1 ターンを回す。
// 誰が話すか、引き継ぎを通すか(辺、1 ターン 1 回、limits.maxHandoffs)、上限、受け渡す値の検査、出口の確かめは、
// どれもここのコードが決める(S16 の構成 A、C)。モデルが決めるのは、返事の中身とツールの選び方だけ。
// 固定の流れ(harness の参加者の flow と escalate。2.8)では、harness の節の中でコードがツールを呼ぶ。モデルにはツールを渡さない。
// 1 ターンは決まった節の並びで回り、通った節を記録の nodes に残す(S9):
//   accept → (harness:<id> | prompt:<id> → agent:<id> → surface:<id> → output:<id> | human:<id>) → handoff → (引き継いだ先の 1 回) → reply
// モデル(接続)を呼ぶのは harness:<id> と agent:<id> の節の中だけ。ほかの節はコードだけで進む。
// 会話(conversation)は値で受け取り、新しい会話を返す。ファイルは読み書きしない(Claude Code の接続だけが .studio/sim/ に書く)。

// 出口の確かめで、やり直しても合わなかったときの決まった文(型の文。3.7)
export const OUTPUT_FALLBACK_TEXT = 'すみません、うまくお答えできませんでした。言い方を変えて、もう一度送ってください。';
// 担当者(human)の参加者にモックの返事がないときの文
export const HUMAN_FALLBACK_TEXT = '担当の者です。お話を伺います。(模擬の返事)';
// 1 ターンで引き継げる回数(3.2)
export const HANDOFFS_PER_TURN = 1;
// 1 回の返事の、出口の確かめと形の崩れのやり直しを含めた模擬のエージェントの呼び出しの数
export const AGENT_ATTEMPTS = 2;

export class SimError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export const digestOf = (value) => `sha256:${createHash('sha256').update(JSON.stringify(value ?? null)).digest('hex')}`;

// 会話の ID(.studio/sim/<会話の ID>/ の名前になる)。会話を最初からにするたびに新しくする(前の店を混ぜない。S15)
export const newSimConversationId = (prefix = 'user') => `${prefix}-${randomBytes(4).toString('hex')}`;

// ビルドで読んだもの(readSimulation の simulation)から、会話を回すのに使うものをそろえる。
// aiOf(file) は harness の参加者の ai.json の定義を返す。assumptionId を渡さなければ、構成の既定の前提を使う
export function prepareSimulation(simulation, { aiOf, dataNumbers = [], assumptionId } = {}) {
  const composition = simulation.composition;
  const toolsFile = composition.tools ?? null;
  const toolset = toolsFile ? simulation.tools?.[toolsFile] ?? null : null;
  const dir = composition.assumptions?.dir ?? null;
  const id = assumptionId ?? composition.assumptions?.default ?? null;
  const found = dir ? (simulation.assumptions ?? []).find((item) => item.file.startsWith(`${dir}/`) && item.assumption.id === id) ?? null : null;
  const ais = new Map();
  for (const participant of composition.participants) {
    if (participant.kind !== 'harness') continue;
    const definition = aiOf(participant.ai);
    if (!definition) throw new SimError('invalid', `参加者「${participant.id}」の harness の設定(app/${participant.ai})が読めていません`);
    ais.set(participant.id, definition);
  }
  const mocks = new Map((simulation.mocks ?? []).map((mock) => [mock.file, mock]));
  const prompts = simulation.prompts ?? {};
  return {
    composition,
    toolsFile,
    toolset,
    toolData: toolsFile ? simulation.toolData?.[toolsFile] ?? {} : {},
    assumption: found?.assumption ?? null,
    assumptionFile: found?.file ?? null,
    mocks,
    prompts,
    ais,
    dataNumbers,
    digest: digestOf({ composition, toolset, prompts }),
    assumptionDigest: found ? digestOf(found.assumption) : null,
  };
}

const participantOf = (sim, id) => sim.composition.participants.find((p) => p.id === id);

// 新しい会話。harness の参加者ごとに状態と進み具合を持つ。回し手が harness なら、そのあいさつから始める
export function startConversation(sim, { id = newSimConversationId() } = {}) {
  const harness = {};
  for (const [pid, definition] of sim.ais) harness[pid] = { state: { ...definition.initialState }, progress: startProgress(definition) };
  const messages = [];
  const driver = participantOf(sim, sim.composition.driver);
  const greeting = driver?.kind === 'harness' ? sim.ais.get(driver.id).mock.greeting : null;
  if (greeting) messages.push({ role: 'assistant', from: driver.id, text: greeting, parts: [{ kind: 'text', text: greeting }] });
  return { id, active: sim.composition.driver, turns: 0, handoffs: 0, store: {}, calls: {}, harness, messages };
}

// 出口の確かめ(layer: output。3.7)。返事の文を、数字を作らない、長さ、禁止の言葉で確かめる(意味までは見ない)
export function checkOutput(text, rules, allowedNumbers) {
  const failed = [];
  const body = String(text ?? '').normalize('NFKC');
  if (rules.noNewNumbers) {
    const made = [...new Set(numbersIn(body).filter((n) => !allowedNumbers.has(n)))];
    if (made.length > 0) failed.push({ rule: 'noNewNumbers', detail: `「${made.join('」「')}」は、発言、記録の店、ツールの結果、データのどれにも出てこない数` });
  }
  const length = [...String(text ?? '')].length;
  if (rules.maxReplyChars && length > rules.maxReplyChars) failed.push({ rule: 'maxReplyChars', detail: `${length} 文字で、上限の ${rules.maxReplyChars} 文字を超えている` });
  const words = (rules.forbidden ?? []).filter((word) => body.includes(word.normalize('NFKC')));
  if (words.length > 0) failed.push({ rule: 'forbidden', detail: `禁止の言葉「${words.join('」「')}」を含む` });
  return failed;
}

const historyOf = (messages) => messages.filter((m) => m.role === 'user' || m.role === 'assistant' || m.role === 'correction');

// 1 ターン。input は { text, action }。agent は模擬のエージェントの接続(モックか Claude Code)、harnessConnection は
// harness の参加者の接続(プロダクト内 AI と同じ。モックか Claude Code)。meter は harness の実モデルの呼び出しの上限。
// context は Claude Code の接続に渡すもの({ projectDir, userId, onLaunch })。record に記録(sim-turn。4.1)を書き足す。
// 途中で失敗しても、そこまでの記録が残る。onNode は節に入るたびに呼ぶ(テストで、決まった節でモデルを呼ばないことを確かめる)。
// 返す: { conversation(新しい会話), said(このターンの返事のメッセージ), record }
export async function runTurn({
  sim,
  conversation,
  input,
  agent,
  harnessConnection,
  signal,
  meter = null,
  deadlineMs = null,
  context = {},
  record = {},
  onNode = () => {},
  withoutPromptGuards = false,
  callToolImpl = callTool,
}) {
  const { composition, assumption } = sim;
  const text = String(input.text ?? '').trim();
  const action = input.action ?? null;
  Object.assign(record, {
    kind: 'sim-turn',
    composition: { name: composition.name, file: composition.file ?? null, digest: sim.digest },
    assumptions: assumption ? { id: assumption.id, file: sim.assumptionFile, digest: sim.assumptionDigest, standIn: assumption.model?.standIn ?? null } : null,
    turn: conversation.turns + 1,
    // history は渡した会話の件数(今の画面の記録の「渡した会話」に出る)
    input: { text, action, history: historyOf(conversation.messages).length },
    nodes: [],
    steps: [],
    handoff: null,
    active: { before: conversation.active, after: conversation.active },
    views: assumption?.logging ?? null,
  });
  const node = (name) => {
    record.nodes.push(name);
    onNode(name);
  };
  const next = structuredClone(conversation);
  const labels = Object.fromEntries(composition.participants.map((p) => [p.id, p.label]));
  const history = historyOf(conversation.messages);
  // 出口の確かめで許す数: 発言、記録の店、このターンのツールの結果、ツールのデータ、架空のデータ、プロンプトの部品
  const toolResults = [];
  const allowedNumbers = () => {
    const texts = [
      ...history.filter((m) => m.role !== 'assistant').map((m) => m.text),
      text,
      JSON.stringify(next.store),
      ...toolResults.map((result) => JSON.stringify(result ?? null)),
      JSON.stringify(sim.toolData),
      ...Object.values(sim.prompts),
      typeof assumption?.hostPrompt === 'string' ? assumption.hostPrompt : '',
    ];
    return new Set([...texts.flatMap(numbersIn), ...(sim.dataNumbers ?? []).flatMap(numbersIn)]);
  };

  node('accept');
  if (next.turns >= composition.limits.maxTurns) {
    throw new SimError('too-long', `この構成の会話は ${composition.limits.maxTurns} ターンまでです(limits.maxTurns)。Studio の「会話を最初から」でやり直してください`);
  }
  next.turns += 1;

  // 同じプロセスの中のツールの口。モックの模擬のエージェントが使う。呼んだ参加者、構成の辺、前提を渡す(MCP サーバーと同じ文脈)
  const inProcessTools = (participant, handoffs) => {
    let calls = 0;
    const max = maxPerReplyOf(assumption);
    return {
      async call(name, args) {
        calls += 1;
        if (!participant.tools.includes(name)) {
          const entry = refusedEntry({ name, args, by: participant.id, layer: 'permission', guard: 'allowedTools', reason: '構成でこの参加者に渡していないツール' });
          record.steps.push(entry);
          return { ok: false, error: `「${name}」は使えないツールです` };
        }
        if (calls > max) {
          const reason = `1 回の返事で呼べるツールは ${max} 回までです`;
          record.steps.push(refusedEntry({ name, args, by: participant.id, guard: 'maxPerReply', reason }));
          return { ok: false, error: reason };
        }
        const outcome = await callToolImpl({
          tools: sim.toolset,
          data: sim.toolData,
          store: next.store,
          context: {
            conversationId: next.id,
            userId: context.userId,
            by: participant.id,
            calls: next.calls,
            assumption,
            handoffs: composition.handoffs,
          },
          name,
          args,
        });
        next.store = outcome.store;
        next.calls = outcome.calls;
        record.steps.push(outcome.entry);
        if (outcome.ok) toolResults.push(outcome.result);
        if (outcome.handoff) handoffs.push(outcome.handoff);
        return outcome;
      },
    };
  };

  // 模擬のエージェントが 1 回話す。形の崩れと、止める出口の確かめ(enforce)に合わなければ 1 回やり直し、だめなら型の文
  async function speakAgent(participant, handedOff) {
    const { id } = participant;
    node(`prompt:${id}`);
    const kinds = partKindsOf(assumption);
    const prompt = agentPrompt({ participant, assumption, prompts: sim.prompts, guards: composition.guards, withoutPromptGuards, kinds });
    const schema = replySchema(assumption);
    const guards = composition.guards.filter((guard) => guard.layer === 'output' && guard.on === id);
    const step = { participant: id, kind: 'agent', connection: agent.kind, real: Boolean(agent.real), ms: 0, costUsd: null, prompt: { pieces: prompt.pieces, asked: prompt.asked } };
    record.steps.push(step);
    // 引き継ぎは、使った返事の回のものだけを使う。やり直した回と、決まった文に代えた回の引き継ぎは使わない。
    // 記録の店と呼び出しの数は、本番のツールと同じく、やり直した回の分も残る
    let handoffs = [];
    let problem = null;
    let parts = null;
    for (let attempt = 1; attempt <= AGENT_ATTEMPTS; attempt += 1) {
      node(`agent:${id}`);
      handoffs = [];
      const started = Date.now();
      const stdin = agentStdin({ messages: history, labels, input: { text, action }, handedOff, problem });
      if (attempt === 1) step.command = agent.describe?.({ tools: participant.tools, schema, systemPrompt: prompt.text, assumption })?.command;
      const mock = participant.mock ? sim.mocks.get(participant.mock) ?? null : null;
      if (agent.kind === 'mock' && !mock) {
        throw new SimError('no-mock', `参加者「${participant.label}」にはモックの決まり(mock)がないので、お試しの AI(モック)では話せません`);
      }
      const replied = await agent.reply({
        participant,
        mock,
        input: { text, action },
        turns: next.turns,
        tools: inProcessTools(participant, handoffs),
        systemPrompt: prompt.text,
        stdin,
        schema,
        signal,
        context: {
          projectDir: context.projectDir,
          conversationId: next.id,
          by: id,
          toolsFile: sim.toolsFile,
          handoffs: composition.handoffs,
          assumption,
          userId: context.userId,
          store: next.store,
          calls: next.calls,
          onLaunch: context.onLaunch,
        },
      });
      step.ms += Date.now() - started;
      if (Number.isFinite(replied.meta?.costUsd)) step.costUsd = (step.costUsd ?? 0) + replied.meta.costUsd;
      // 別のプロセスでツールを呼んだ接続(Claude Code)は、呼び出しの記録と新しい店をまとめて返す
      if (replied.steps) record.steps.push(...replied.steps);
      if (replied.results) toolResults.push(...replied.results);
      if (replied.store) next.store = replied.store;
      if (replied.calls) next.calls = replied.calls;
      if (replied.handoffs) handoffs.push(...replied.handoffs);
      if (replied.command) step.command = replied.command;

      node(`surface:${id}`);
      const raw = replied.parts ?? replied.output?.parts;
      const fitted = fitParts(raw, assumption);
      const out = { participant: id, attempt, output: { parts: describeParts(fitted.parts) }, guards: [] };
      for (const downgrade of fitted.downgrades) {
        out.guards.push({ layer: 'surface', guard: 'surface-downgrade', effect: downgrade.to ? 'replaced' : 'removed', owner: 'studio', from: downgrade.from, to: downgrade.to, reason: downgrade.reason });
      }
      record.steps.push(out);

      node(`output:${id}`);
      // ボタンの並びの番号は Studio が付けたもので、返事の数ではないので、確かめる文に入れない
      const body = partsToCheckedText(fitted.parts);
      const problems = [];
      if (fitted.parts.length === 0) problems.push(`- 返事の部品がなかった(${replied.problem ?? '使える部品が 1 つもなかった'})`);
      let enforcedFailed = false;
      // 部品のない返事は確かめない(決まった文に代わるので、出口の確かめが効いたとは記録しない)
      for (const guard of fitted.parts.length === 0 ? [] : guards) {
        const failed = checkOutput(body, guard.rules, allowedNumbers());
        if (failed.length === 0) {
          out.guards.push({ layer: 'output', guard: guard.id, effect: 'passed', owner: guard.owner });
          continue;
        }
        const last = attempt === AGENT_ATTEMPTS;
        const effect = !guard.enforce ? 'violated' : last ? 'replaced' : 'retried';
        out.guards.push({ layer: 'output', guard: guard.id, effect, owner: guard.owner, failed: failed.map((f) => f.rule) });
        if (guard.enforce) {
          enforcedFailed = true;
          problems.push(...failed.map((f) => `- ${f.rule}: ${f.detail}`));
        }
      }
      if (problems.length === 0 && !enforcedFailed) {
        parts = fitted.parts;
        break;
      }
      problem = problems;
    }
    if (!parts) {
      parts = [{ kind: 'text', text: OUTPUT_FALLBACK_TEXT }];
      if (handoffs.length > 0) record.steps.push({ participant: id, handoffIgnored: handoffs.map((h) => h.to), reason: '決まった文に代えた返事の引き継ぎは使わない' });
      handoffs = [];
      record.steps.push({ participant: id, fallback: true, output: { parts: describeParts(parts) }, reason: '形が崩れているか、止める出口の確かめに、やり直しても合わなかったので、決まった文に代えた' });
    }
    return { message: { role: 'assistant', from: id, text: partsToText(parts), parts }, handoffs };
  }

  // harness の参加者が 1 回話す。harness の turn() をそのまま使う(抽出 → 決定 → 言い方 → rules)
  async function speakHarness(participant, handedOff = null) {
    const { id } = participant;
    node(`harness:${id}`);
    const definition = sim.ais.get(id);
    const own = next.harness[id];
    const stages = {};
    // モデルの指定は、書いた参加者だけ前提から読む(構成 B と今の構成の harness は接続の既定のまま。R2)
    const model = participant.model?.from === 'assumptions' ? assumption?.model?.name ?? null : null;
    const step = { participant: id, kind: 'harness', connection: harnessConnection.kind, real: Boolean(harnessConnection.billing), ...(model ? { model } : {}), harness: stages };
    record.steps.push(step);
    const started = Date.now();
    const flow = participant.flow || participant.escalate
      ? {
          spec: { flow: participant.flow ?? [], escalate: participant.escalate ?? [] },
          memory: own.flow ?? startFlowMemory(),
          // 1 ターンに引き継げるのは 1 回、1 つの会話では limits.maxHandoffs 回まで
          canEscalate: !handedOff && next.handoffs < composition.limits.maxHandoffs,
          isWrite: (name) => sim.toolset?.tools.find((tool) => tool.name === name)?.do.op === 'record',
          // ツールの口を呼ぶのは、ここのコードだけ。記録には via: 'flow' を残す
          call: async (name, args) => {
            if (signal?.aborted) throw new ConnectionError('cancelled', '応答を止めました');
            const outcome = await callToolImpl({
              tools: sim.toolset,
              data: sim.toolData,
              store: next.store,
              context: { conversationId: next.id, userId: context.userId, by: id, via: 'flow', calls: next.calls, assumption, handoffs: composition.handoffs },
              name,
              args,
            });
            next.store = outcome.store;
            next.calls = outcome.calls;
            record.steps.push(outcome.entry);
            if (outcome.ok) toolResults.push(outcome.result);
            return outcome;
          },
        }
      : null;
    const result = await turn({
      connection: harnessConnection,
      definition,
      progress: { ...own.progress },
      state: { ...own.state },
      messages: history.map((m) => (m.role === 'assistant' ? { role: 'assistant', text: m.text } : m)),
      text,
      signal,
      meter,
      trace: stages,
      dataNumbers: sim.dataNumbers ?? [],
      deadlineMs,
      flow,
      model,
    });
    step.ms = Date.now() - started;
    next.harness[id] = { state: result.state, progress: result.progress, ...(result.flow ? { flow: result.flow.memory } : {}) };
    // 人に渡す条件を満たしたら、辺の carry の名前の値を渡す。通すかは、下の引き継ぎの節がほかの引き継ぎと同じく決める
    const escalate = result.flow?.escalate;
    const edge = escalate ? composition.handoffs.find((item) => item.from === id && item.to === escalate.to) : null;
    const carry = Object.fromEntries((edge?.carry ?? []).filter((key) => (result.state[key] ?? null) !== null).map((key) => [key, result.state[key]]));
    return { message: { role: 'assistant', from: id, text: result.reply, parts: [{ kind: 'text', text: result.reply }] }, handoffs: escalate ? [{ to: escalate.to, carry }] : [] };
  }

  function speakHuman(participant) {
    node(`human:${participant.id}`);
    const reply = participant.mock?.reply ?? HUMAN_FALLBACK_TEXT;
    record.steps.push({ participant: participant.id, kind: 'human', mock: true });
    return { message: { role: 'assistant', from: participant.id, text: reply, parts: [{ kind: 'text', text: reply }] }, handoffs: [] };
  }

  const speak = (participant, handedOff = null) => {
    if (participant.kind === 'agent') return speakAgent(participant, handedOff);
    if (participant.kind === 'harness') return speakHarness(participant, handedOff);
    return speakHuman(participant);
  };

  // 受け渡す値を、受け取る harness の項目の決まり(選択肢、数の範囲)で確かめて状態に入れる。合わない値は入れずに記録に残す
  function carryInto(target, carry) {
    const accepted = [];
    const rejected = [];
    const definition = target.kind === 'harness' ? sim.ais.get(target.id) : null;
    for (const [key, value] of Object.entries(isPlainObject(carry) ? carry : {})) {
      if (!definition) {
        accepted.push(key);
        continue;
      }
      const field = definition.fields.find((f) => f.key === key);
      const normalized = field ? normalizeValue(field, value) : undefined;
      if (normalized === undefined || normalized === null) {
        rejected.push({ key, reason: field ? '項目の決まりに合わない値' : `app/${target.ai} にない項目` });
        continue;
      }
      next.harness[target.id].state[key] = normalized;
      accepted.push(key);
    }
    // 終わった相談役にもう一度引き継いだら、入った値はそのままに、最初の段から始める(聞き直さない。未定の項目だけを聞く)
    if (definition && next.harness[target.id].progress.done) {
      next.harness[target.id].progress = startProgress(definition);
      // 固定の流れは、呼んだ段と結果も最初からにする
      delete next.harness[target.id].flow;
    }
    return { accepted, rejected };
  }

  const said = [];
  const speaker = participantOf(sim, next.active);
  if (!speaker) throw new SimError('invalid', `今話す参加者「${next.active}」が構成にいません`);
  const first = await speak(speaker);
  said.push(first.message);

  node('handoff');
  const asked = first.handoffs[0] ?? null;
  if (asked) {
    const target = participantOf(sim, asked.to);
    const edge = composition.handoffs.find((e) => e.from === speaker.id && e.to === asked.to);
    record.handoff = { from: speaker.id, to: asked.to, effect: 'passed' };
    if (!target || !edge) {
      Object.assign(record.handoff, { effect: 'blocked', reason: '構成の handoffs にない引き継ぎ' });
    } else if (next.handoffs >= composition.limits.maxHandoffs) {
      Object.assign(record.handoff, { effect: 'blocked', reason: `1 つの会話の引き継ぎは ${composition.limits.maxHandoffs} 回まで(limits.maxHandoffs)` });
    } else {
      record.handoff.carry = carryInto(target, asked.carry);
      next.handoffs += 1;
      next.active = target.id;
      // 引き継いだ先が、同じターンで 1 回だけ話す
      const second = await speak(target, { from: speaker.id, carry: asked.carry });
      said.push(second.message);
      if (second.handoffs.length > 0) {
        record.handoff.refused = { to: second.handoffs[0].to, reason: `1 ターンで引き継げるのは ${HANDOFFS_PER_TURN} 回まで` };
      }
    }
    if (first.handoffs.length > 1) record.handoff.ignored = first.handoffs.slice(1).map((h) => h.to);
  }

  // harness が会話を終えたら(done)、戻り先に戻す。戻るのも引き継ぎに数える。そのターンでは戻り先は話さず、次の発言を受ける(2.5)
  const current = participantOf(sim, next.active);
  if (current.kind === 'harness' && current.returnTo && next.harness[current.id].progress.done) {
    if (next.handoffs >= composition.limits.maxHandoffs) {
      record.returned = { from: current.id, to: current.returnTo, effect: 'blocked', reason: `1 つの会話の引き継ぎは ${composition.limits.maxHandoffs} 回まで(limits.maxHandoffs)` };
    } else {
      next.handoffs += 1;
      next.active = current.returnTo;
      record.returned = { from: current.id, to: current.returnTo, effect: 'passed' };
    }
  }

  node('reply');
  next.messages.push({ role: 'user', text, ...(action ? { action } : {}) }, ...said);
  record.active.after = next.active;
  record.output = { parts: said.map((message) => ({ from: message.from, parts: describeParts(message.parts) })) };
  return { conversation: next, said, record };
}
