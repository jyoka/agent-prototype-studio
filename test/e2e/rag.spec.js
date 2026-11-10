import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ROOT, expect, test } from './studio.js';

// 文書の検索(RAG)の見本(task 421)。同じ場面の一覧を、RAG ありの構成となしの構成で回し、比べる表に差が出るかを見る。
// 見本は架空のしおかぜ便の運送約款(samples/terms-help)。模擬のエージェントはモック。実モデルは呼ばない

const SAMPLE = path.join(ROOT, 'samples', 'terms-help', 'app');
const CLI = path.join(ROOT, 'bin', 'evals.js');
const WITH_RAG = 'composition.json';
const WITHOUT_RAG = 'compositions/no-rag.json';

// RAG なしの構成は見本の外(samples/terms-help/compare/)にある。比べるときは app/ に写す(docs/usage.md の手順と同じ)
async function placeSample(home, { compare = true } = {}) {
  const root = path.join(home, 'projects', 'terms-help');
  await fs.cp(SAMPLE, path.join(root, 'app'), { recursive: true });
  if (compare) {
    for (const dir of ['compositions', 'mocks', 'prompts']) await fs.cp(path.join(SAMPLE, '..', 'compare', dir), path.join(root, 'app', dir), { recursive: true });
  }
  await fs.mkdir(path.join(root, '.studio'), { recursive: true });
  await fs.writeFile(path.join(root, '.studio', 'project.json'), JSON.stringify({ title: 'しおかぜ便の約款の相談(架空)' }));
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
    result: JSON.parse(await fs.readFile(path.join(dir, id, 'result.json'), 'utf8')),
    report: await fs.readFile(path.join(dir, id, 'report.md'), 'utf8'),
  };
}

const rowOf = (table, label) => {
  const header = table.split('\n').find((line) => line.startsWith('| 構成 / 前提 |')).split(' | ');
  const row = table.split('\n').find((line) => line.startsWith(`| ${label} |`)).split(' | ');
  return Object.fromEntries(header.map((name, i) => [name.replace(/^\| /, '').replace(/ \|$/, ''), row[i].replace(/^\| /, '').replace(/ \|$/, '')]));
};

test('同じ場面を RAG ありとなしで回すと、比べる表の検索の再現率、引用あり、確かめの合格に差が出て、判定は「要る」になる', async ({ home }) => {
  const root = await placeSample(home);
  const out = await evals(root, ['--composition', `${WITH_RAG},${WITHOUT_RAG}`], { STUDIO_HOME: home });
  // RAG なしでは約款を読む場面が通らないので、終了コードは 1(通らない場面があった)
  expect(out.code, out.stderr + out.stdout).toBe(1);
  const { result, report } = await latestRun(root);
  expect(result.groups.map((group) => group.composition.file)).toEqual([WITH_RAG, WITHOUT_RAG]);
  // 同じ場面の一覧
  expect(result.groups[0].evals.map((scene) => scene.id)).toEqual(result.groups[1].evals.map((scene) => scene.id));

  const table = report.slice(report.indexOf('## 比べる表'), report.indexOf('## 点'));
  const withRag = rowOf(table, `${WITH_RAG} / stand-in`);
  const withoutRag = rowOf(table, `${WITHOUT_RAG} / stand-in`);
  expect([withRag['検索の再現率'], withRag['引用あり'], withRag['確かめの合格']]).toEqual(['100%(3/3)', '2/2', '10/10']);
  expect([withoutRag['検索の再現率'], withoutRag['引用あり'], withoutRag['確かめの合格']]).toEqual(['-', '-', '2/4']);

  // 場面ごと: 約款を読む場面は、RAG ありで通り、なしで通らない
  const scenes = report.slice(report.indexOf('## 場面ごとの結果'), report.indexOf('## データの棚と RAG の判定'));
  expect(scenes).toContain('| terms-damage | question | 通った | 失敗 |');
  expect(scenes).toContain('| terms-redelivery-fee | question | 通った | 失敗 |');

  // データの棚と RAG の判定: 通らない場面の id を根拠に「要る」。足すなら決めることが並ぶ
  const shelf = report.slice(report.indexOf('## データの棚と RAG の判定'), report.indexOf('## 通らなかった確かめ'));
  expect(shelf).toContain('| 架空の運送約款(条ごとに 1 件) | 長い文書 | RAG(文書を探して読む) | まだ決めていない | 不明 | 架空の文書 8 件 |');
  // モックの回しなので、形の確かめだけと書く
  expect(shelf).toContain('- RAG: 要る(お試しの AI で場面を回して比べた結果。形の確かめだけで、振る舞いの差は本物の AI で測る)');
  expect(shelf).toContain('- 根拠の場面: `terms-damage`、`terms-redelivery-fee`');
  for (const label of ['分割', '埋め込み', '置き場', '引用', '再現率の測り方']) expect(shelf).toContain(`| ${label} |`);
  expect(result.dataShelf.rag).toMatchObject({ needed: true, evalIds: ['terms-damage', 'terms-redelivery-fee'], measured: true });
});

test('見本のまま(RAG ありの構成だけ)回すと、場面は全部通り、判定は根拠がないので「まだ決めていない」', async ({ home }) => {
  const root = await placeSample(home, { compare: false });
  const out = await evals(root, [], { STUDIO_HOME: home });
  expect(out.code, out.stderr + out.stdout).toBe(0);
  const { result, report } = await latestRun(root);
  expect(result.verdict).toBe('passed');
  expect(report).toContain('- RAG: まだ決めていない(今日の推測。まだ測っていない)');
});
