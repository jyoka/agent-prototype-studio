import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ROOT, chooseProject, expect, launchStudio, openDevDetails, test } from './studio.js';

// マスターとサブ(docs/design/agent-simulation.md の 2.9)。親の AI が子の AI に仕事を任せ、結果を受け取って続ける。
// 深さと回数の上限はコードが守る。見本は架空のしおかぜ便の再配達(samples/redelivery)。
// 作る AI は偽接続、模擬のエージェントはモック。実モデルは呼ばない

const ID = 'redelivery';
const SAMPLE = path.join(ROOT, 'samples', 'redelivery', 'app');
const CLI = path.join(ROOT, 'bin', 'evals.js');
const FIXED = 'composition.json';
const SINGLE = 'compositions/single-agent.json';
const MASTER_SUB = 'compositions/master-sub.json';

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

async function latestRun(root) {
  const dir = path.join(root, '.studio', 'evals');
  const id = (await fs.readdir(dir)).filter((name) => name !== 'ledger.jsonl').sort().at(-1);
  return {
    dir: path.join(dir, id),
    result: JSON.parse(await fs.readFile(path.join(dir, id, 'result.json'), 'utf8')),
    report: await fs.readFile(path.join(dir, id, 'report.md'), 'utf8'),
  };
}

test('モックで、同じ場面の一覧を固定の流れ、単一エージェント、マスターとサブの 3 つで回し、比べる表に並ぶ', async ({ home }) => {
  const root = await placeSample(home);
  const out = await evals(root, ['--composition', `${FIXED},${SINGLE},${MASTER_SUB}`], { STUDIO_HOME: home });
  expect(out.code, out.stderr + out.stdout).toBe(0);
  const { dir, result, report } = await latestRun(root);
  expect(result.verdict).toBe('passed');
  expect(result.groups.map((group) => [group.composition.file, group.assumption?.id, group.connection])).toEqual([
    [FIXED, 'stand-in', 'mock'],
    [SINGLE, 'stand-in', 'mock'],
    [MASTER_SUB, 'stand-in', 'mock'],
  ]);
  // 同じ場面の一覧。どの構成でも全部が当てはまり(n/a がない)、通る
  const ids = result.groups[0].evals.map((scene) => scene.id);
  expect(ids).toHaveLength(10);
  for (const group of result.groups) {
    expect(group.evals.map((scene) => [scene.id, scene.verdict])).toEqual(ids.map((id) => [id, 'passed']));
  }
  // 比べる表に 3 つの構成が 1 行ずつ並ぶ
  const table = report.slice(report.indexOf('## 比べる表'), report.indexOf('## 点'));
  const rows = table.split('\n').filter((line) => line.startsWith('| ') && line.includes(' / stand-in '));
  expect(rows.map((line) => line.split(' | ')[0].slice(2))).toEqual([`${FIXED} / stand-in`, `${SINGLE} / stand-in`, `${MASTER_SUB} / stand-in`]);

  // 形の違いは記録で分かる: マスターは荷物を自分で引かず、荷物の係(サブ)が引く。危ない場面は、サブの書くツールをツールの守りが止める
  const [, single, masterSub] = result.groups;
  const scene = (group, id) => group.evals.find((item) => item.id === id);
  expect(scene(single, 'redeliver-ok').tools).toEqual(['get_parcel(tool の hideFields が止めた)', 'record_consent(通った)', 'save_redelivery(通った)']);
  expect(scene(masterSub, 'redeliver-ok').tools).toEqual([
    'ask_parcel_desk(通った)',
    'get_parcel(tool の hideFields が止めた)',
    'ask_booking_desk(通った)',
    'record_consent(通った)',
    'ask_booking_desk(通った)',
    'save_redelivery(通った)',
  ]);
  expect(scene(masterSub, 'risky-no-write-before-consent').stoppedBy).toBe('tool');
  const trace = JSON.parse(await fs.readFile(path.join(dir, scene(masterSub, 'redeliver-ok').trace), 'utf8'));
  expect(trace[0].delegations).toEqual([{ from: 'desk-master', to: 'parcel-sub', depth: 1, round: 1, effect: 'passed', reply: { chars: 27 } }]);
  const steps = trace[0].steps.filter((step) => step.kind === 'agent').map((step) => [step.participant, step.depth, step.parent ?? null]);
  expect(steps).toEqual([['desk-master', 0, null], ['parcel-sub', 1, 'desk-master'], ['desk-master', 0, null]]);
});

test('画面の会話でマスターとサブの構成を選ぶと、マスターがサブの結果で答え、記録に親子と委任が出る', async ({ page, home }) => {
  test.setTimeout(60_000);
  await placeSample(home);
  const studio = await launchStudio(home);
  try {
    await page.goto(studio.url);
    await chooseProject(page, /しおかぜ便の再配達/);
    const app = page.frameLocator('iframe[title="試作品"]');
    await expect(app.getByRole('heading', { name: 'しおかぜ便の再配達' })).toBeVisible();
    await openDevDetails(page);
    const choice = page.getByRole('region', { name: '構成と前提' });
    await choice.getByRole('group', { name: '構成を選ぶ' }).getByRole('radio', { name: /マスターとサブ/ }).check();
    await expect(choice).toContainText('再配達の受付(マスター、模擬)(模擬のエージェント)、荷物の係(サブ、模擬)(模擬のエージェント)');

    const items = app.getByRole('region', { name: '会話' }).getByRole('list', { name: 'やりとり' }).locator(':scope > li');
    await expect(items).toHaveCount(0);
    const message = app.getByLabel('メッセージ');
    await message.fill('番号は 1001 です');
    await app.getByRole('button', { name: '送る' }).click();
    await expect(message).toHaveValue('');
    // 利用者に見えるのは、サブの結果を受け取ったマスターの返事だけ
    await expect(items).toHaveCount(2);
    await expect(items.last()).toContainText('りんごの箱のお荷物が見つかりました。お届けは本日です。希望の時間帯を教えてください。');
    await expect(items.last()).not.toContainText('お調べします');

    const entries = page.locator('#ai-trace').getByRole('list', { name: 'AI の実行の記録' }).locator(':scope > li');
    const turn = entries.first();
    await turn.getByText('模擬の会話の中身: 参加者、ツール、守り(開発向け)').click();
    await expect(turn).toContainText('委任: 再配達の受付(マスター、模擬)(desk-master) → 荷物の係(サブ、模擬)(parcel-sub)(深さ 1): 通した');
    const steps = turn.getByRole('list', { name: '模擬の会話の段' });
    await expect(steps.locator('[data-step="agent"][data-depth="1"]')).toContainText(
      '参加者 荷物の係(サブ、模擬)(parcel-sub)(模擬のエージェント、サブ): 再配達の受付(マスター、模擬)(desk-master) から任された仕事(深さ 1)',
    );
    await expect(steps.locator('[data-step="tool"]').filter({ hasText: 'ツール get_parcel' })).toContainText('荷物の係(サブ、模擬)(parcel-sub) が呼びました');
    await expect(steps.locator('[data-step="tool"]').filter({ hasText: 'ツール ask_parcel_desk' })).toContainText('委任の頼み');
  } finally {
    await studio.stop();
  }
});
