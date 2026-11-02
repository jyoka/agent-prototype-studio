import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ROOT, chooseProject, expect, launchStudio, openDevDetails, test } from './studio.js';

// 固定の流れ(docs/design/agent-simulation.md の 2.8)。順番はコードが決め、モデルは言葉の読み取りと言い方だけ。
// 見本は架空のしおかぜ便の再配達(samples/redelivery)。作る AI は偽接続、プロダクト内 AI はモックと偽の claude。実モデルは呼ばない

const ID = 'redelivery';
const SAMPLE = path.join(ROOT, 'samples', 'redelivery', 'app');
const FAKE = path.join(ROOT, 'test', 'fixtures', 'fake-claude.js');
const CLI = path.join(ROOT, 'bin', 'evals.js');
const FIXED = 'composition.json';
const SINGLE = 'compositions/single-agent.json';

// 見本を試作品の 1 つとして置く(見本の一覧 SAMPLES には足していない。2.8)
async function placeSample(home) {
  const root = path.join(home, 'projects', ID);
  await fs.cp(SAMPLE, path.join(root, 'app'), { recursive: true });
  await fs.mkdir(path.join(root, '.studio'), { recursive: true });
  await fs.writeFile(path.join(root, '.studio', 'project.json'), JSON.stringify({ title: 'しおかぜ便の再配達(架空)' }));
  return root;
}

function evals(root, args, env = {}) {
  const base = { PATH: process.env.PATH, STUDIO_AGENT: 'fake', STUDIO_CLAUDE_BIN: path.join(root, 'no-claude') };
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, root, ...args], { env: { ...base, ...env }, timeout: 90_000 }, (error, stdout, stderr) => {
      resolve({ code: error ? (error.code ?? 1) : 0, stdout, stderr });
    });
  });
}

async function latestResult(root) {
  const dir = path.join(root, '.studio', 'evals');
  const id = (await fs.readdir(dir)).filter((name) => name !== 'ledger.jsonl').sort().at(-1);
  return {
    result: JSON.parse(await fs.readFile(path.join(dir, id, 'result.json'), 'utf8')),
    report: await fs.readFile(path.join(dir, id, 'report.md'), 'utf8'),
  };
}

test('見本の場面が関門 GE で通り、画面の会話では、番号、時間帯、確かめの順で書かれる', async ({ page, home }) => {
  test.setTimeout(90_000);
  const root = await placeSample(home);
  const studio = await launchStudio(home);
  try {
    await page.goto(studio.url);
    await chooseProject(page, /しおかぜ便の再配達/);
    const app = page.frameLocator('iframe[title="試作品"]');
    await expect(app.getByRole('heading', { name: 'しおかぜ便の再配達' })).toBeVisible();

    // 作る依頼を 1 回通す。関門 GE は G4 の後、G5 の前に、既定の構成(固定の流れ)をモックで回す
    const sent = await studio.post(`/api/projects/${ID}/build-requests`, { request: '見出しを「しおかぜ便の再配達の受付」にして' });
    expect(sent.status).toBeLessThan(300);
    await expect.poll(async () => (await studio.api(`/api/projects/${ID}/build-requests`)).runs.at(-1)?.status, { timeout: 60_000 }).toBe('passed');
    const run = (await studio.api(`/api/projects/${ID}/build-requests`)).runs.at(-1);
    const ge = run.gates.find((gate) => gate.id === 'GE');
    expect(ge.status).toBe('passed');
    expect(ge.evalCount).toBe(10);
    expect(ge.passedCount).toBe(10);
    expect(ge.failedCount ?? 0).toBe(0);
    const record = JSON.parse(await fs.readFile(path.join(root, run.evidence.run), 'utf8'));
    expect(record.rounds[0].nodes).toContain('evals');
    expect(record.rounds[0].gates.find((gate) => gate.id === 'GE').status).toBe('passed');

    await expect(app.getByRole('heading', { name: 'しおかぜ便の再配達の受付' })).toBeVisible({ timeout: 20_000 });
    const talk = app.getByRole('region', { name: '会話' });
    const items = talk.getByRole('list', { name: 'やりとり' }).locator(':scope > li');
    const message = app.getByLabel('メッセージ');
    const say = async (text) => {
      await message.fill(text);
      await app.getByRole('button', { name: '送る' }).click();
      await expect(message).toHaveValue('');
    };
    const received = app.getByRole('region', { name: '受け付けた内容' });

    await say('番号は 1001 です');
    await expect(items.last()).toContainText('りんごの箱のお荷物が見つかりました');
    await expect(items.last()).toContainText('希望の時間帯を教えてください');

    // 確かめの前は書かない
    await say('午前中でお願いします');
    await expect(items.last()).toContainText('りんごの箱を本日の午前中にお届けします');
    await expect(received).toContainText('まだありません');

    await say('はい');
    await expect(items.last()).toContainText('再配達を受け付けました');
    await expect(received).toContainText('荷物 1001、午前中');

    // 記録に、コードが段の順に呼んだツールが残る
    const { entries } = await studio.api(`/api/projects/${ID}/ai/trace`);
    // 記録は新しい順に返る
    const tools = [...entries].reverse().flatMap((entry) => (entry.steps ?? []).filter((step) => step.tool).map((step) => [step.tool, step.via, step.by]));
    expect(tools).toEqual([
      ['get_parcel', 'flow', 'desk'],
      ['record_consent', 'flow', 'desk'],
      ['save_redelivery', 'flow', 'desk'],
    ]);

    // 開発者向けの詳細で、ツールを持つ単一エージェントの構成に替えて話せる
    await openDevDetails(page);
    const choice = page.getByRole('region', { name: '構成と前提' });
    await choice.getByRole('group', { name: '構成を選ぶ' }).getByRole('radio', { name: /単一エージェント/ }).check();
    // 選ぶと会話が最初からになる。単一エージェントの構成にはあいさつがない
    await expect(items).toHaveCount(0);
    await expect(received).toContainText('まだありません');
    await say('番号は 1001 です');
    await expect(items.last()).toContainText('りんごの箱のお荷物が見つかりました');
  } finally {
    await studio.stop();
  }
});

test('失敗の行き先が前の段でも、画面の会話で、荷物が見つからないまま再配達が書かれない', async ({ page, home }) => {
  test.setTimeout(60_000);
  const root = await placeSample(home);
  // 番号の次に確かめの段(pre)を挟み、荷物を引く段の失敗の行き先を pre にする。人に渡す条件は外す
  const aiFile = path.join(root, 'app', 'ai.json');
  const ai = JSON.parse(await fs.readFile(aiFile, 'utf8'));
  ai.flow.steps[0].next[0].to = 'pre';
  ai.flow.steps.splice(1, 0, { id: 'pre', next: [{ when: { filled: ['parcel_no'] }, to: 'pick_slot' }] });
  await fs.writeFile(aiFile, JSON.stringify(ai));
  const compositionFile = path.join(root, 'app', 'composition.json');
  const composition = JSON.parse(await fs.readFile(compositionFile, 'utf8'));
  const desk = composition.participants[0];
  delete desk.escalate;
  composition.handoffs = [];
  desk.flow.unshift({ step: 'pre', tell: '番号を確かめます。', then: 'pick_slot' });
  desk.flow.find((entry) => entry.step === 'pick_slot').onFail = { to: 'pre', tell: 'その番号のお荷物は見つかりませんでした。' };
  await fs.writeFile(compositionFile, JSON.stringify(composition));

  const studio = await launchStudio(home);
  try {
    await page.goto(studio.url);
    await chooseProject(page, /しおかぜ便の再配達/);
    const app = page.frameLocator('iframe[title="試作品"]');
    const items = app.getByRole('region', { name: '会話' }).getByRole('list', { name: 'やりとり' }).locator(':scope > li');
    const message = app.getByLabel('メッセージ');
    const received = app.getByRole('region', { name: '受け付けた内容' });
    for (const text of ['番号は 9999 です', '午前中で', 'はい']) {
      await message.fill(text);
      await app.getByRole('button', { name: '送る' }).click();
      await expect(message).toHaveValue('');
      await expect(items.last()).toContainText('その番号のお荷物は見つかりませんでした');
      await expect(items.last()).not.toContainText('再配達を受け付けました');
      await expect(received).toContainText('まだありません');
    }
    const { entries } = await studio.api(`/api/projects/${ID}/ai/trace`);
    const tools = entries.flatMap((entry) => (entry.steps ?? []).filter((step) => step.tool).map((step) => step.tool));
    expect(tools).toEqual(['get_parcel', 'get_parcel', 'get_parcel']);
  } finally {
    await studio.stop();
  }
});

test('固定の流れと、ツールを持つ単一エージェントの構成で、同じ場面の一覧を回して比べられる', async ({ home }) => {
  const root = await placeSample(home);
  const out = await evals(root, ['--composition', `${FIXED},${SINGLE}`], { STUDIO_HOME: home });
  expect(out.code, out.stderr + out.stdout).toBe(0);
  const { result, report } = await latestResult(root);
  expect(result.verdict).toBe('passed');
  expect(result.groups.map((group) => [group.composition.file, group.assumption?.id, group.connection])).toEqual([
    [FIXED, 'stand-in', 'mock'],
    [SINGLE, 'stand-in', 'mock'],
  ]);
  const [fixed, single] = result.groups;
  // 同じ場面の一覧。どの場面も当てはまる(n/a がない)
  expect(single.evals.map((scene) => scene.id)).toEqual(fixed.evals.map((scene) => scene.id));
  expect(fixed.evals).toHaveLength(10);
  for (const group of result.groups) {
    expect(group.evals.map((scene) => [scene.id, scene.verdict])).toEqual(group.evals.map((scene) => [scene.id, 'passed']));
  }
  // 比べる表に 2 つの構成が並ぶ
  expect(report).toContain(FIXED);
  expect(report).toContain(SINGLE);
  // 形の違いは記録で分かる: 固定の流れは同意の前に書くツールを呼ばない。単一エージェントは呼んで、ツールの守りが断る
  const scene = (group) => group.evals.find((item) => item.id === 'risky-no-write-before-consent');
  expect(scene(fixed).tools).toEqual(['get_parcel(tool の hideFields が止めた)']);
  expect(scene(fixed).stoppedBy).toBe('flow');
  expect(scene(single).tools).toEqual(['save_redelivery(tool の requires が止めた)']);
  expect(scene(single).stoppedBy).toBe('tool');
});

test('偽の claude で回すと、前提ごとのモデルで起動し、モデルにはツールを渡さず、順番は同じ', async ({ home }) => {
  const root = await placeSample(home);
  const assumptions = path.join(root, 'app', 'assumptions');
  const base = JSON.parse(await fs.readFile(path.join(assumptions, 'stand-in.json'), 'utf8'));
  await fs.writeFile(path.join(assumptions, 'other.json'), JSON.stringify({ ...base, id: 'other', model: { name: 'claude-haiku-5-5', standIn: true } }));
  const log = path.join(home, 'fake-claude.jsonl');
  const bin = path.join(home, 'claude');
  await fs.writeFile(bin, `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" "$@"\n`, { mode: 0o755 });
  // 「はい」を読み取りで返す(偽の claude は決まった読み取りを返す)
  const extractions = path.join(home, 'extractions.json');
  await fs.writeFile(extractions, JSON.stringify({ はい: { updates: {}, intent: 'yes' }, 午前中で: { updates: { slot: '午前中' }, intent: 'answer' }, '番号は 1001 です': { updates: { parcel_no: 1001 }, intent: 'answer' }, お願いします: { updates: {}, intent: 'yes' } }));

  const out = await evals(root, ['--real', '--limit-usd', '1', '--skip-judge', '--eval', 'redeliver-ok', '--assumptions', 'stand-in,other'], {
    STUDIO_HOME: home,
    STUDIO_ALLOW_CLAUDE_CODE: '1',
    STUDIO_CLAUDE_BIN: bin,
    FAKE_CLAUDE_LOG: log,
    FAKE_CLAUDE_EXTRACTIONS: extractions,
  });
  expect(out.code, out.stderr + out.stdout).toBe(0);
  const { result } = await latestResult(root);
  expect(result.groups.map((group) => [group.assumption.id, group.assumption.model, group.evals[0].verdict])).toEqual([
    ['stand-in', 'claude-sonnet-5-5', 'passed'],
    ['other', 'claude-haiku-5-5', 'passed'],
  ]);
  // どのモデルでも、呼ぶ順は同じ
  for (const group of result.groups) expect(group.evals[0].tools).toEqual(['get_parcel(tool の hideFields が止めた)', 'record_consent(通った)', 'save_redelivery(通った)']);

  const launches = (await fs.readFile(log, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  const models = new Set(launches.map(({ argv }) => argv.find((arg) => arg.startsWith('--model='))));
  expect([...models].sort()).toEqual(['--model=claude-haiku-5-5', '--model=claude-sonnet-5-5']);
  for (const { argv } of launches) {
    expect(argv[argv.indexOf('--tools') + 1]).toBe('');
    expect(argv).toContain('--safe-mode');
    expect(argv.some((arg) => arg.startsWith('--mcp-config') || arg.startsWith('--allowedTools'))).toBe(false);
  }
});
