import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { STUDIO_ROOT } from '../../src/server/config.js';
import { ensureSampleProjects, isValidProjectId, listProjects, projectName, projectPaths } from '../../src/server/projects.js';

test('プロジェクト ID は英小文字、数字、ハイフンだけ', () => {
  assert.equal(isValidProjectId('sample-library'), true);
  for (const id of ['', '../x', 'A', 'a/b', 'a.b', 'a'.repeat(65), 'a\\b']) {
    assert.equal(isValidProjectId(id), false, id);
  }
  assert.throws(() => projectPaths('/tmp', '../etc'));
});

test('サンプルは初回だけ写し、利用者の変更を上書きしない', async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-projects-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const samples = path.join(STUDIO_ROOT, 'samples');

  assert.deepEqual(await ensureSampleProjects(home, samples), ['sample-job-consult', 'sample-study-consult', 'sample-part-time', 'sample-library']);
  const main = path.join(home, 'projects', 'sample-library', 'app', 'main.jsx');
  await fs.writeFile(main, '// changed');
  assert.deepEqual(await ensureSampleProjects(home, samples), []);
  assert.equal(await fs.readFile(main, 'utf8'), '// changed');

  // 後から足したサンプルだけを写す(前の版で起動したことのある置き場)
  await fs.rm(path.join(home, 'projects', 'sample-job-consult'), { recursive: true });
  assert.deepEqual(await ensureSampleProjects(home, samples), ['sample-job-consult']);
  assert.equal(await fs.readFile(main, 'utf8'), '// changed');

  // ビルドの前の名前は、サンプルの目録の title。一覧の順は求人相談、学習相談、バイト探し、図書室
  const projects = await listProjects(home);
  assert.deepEqual(
    projects.map((p) => [p.id, p.title]),
    [
      ['sample-job-consult', '求人相談(架空)'],
      ['sample-study-consult', '学習相談(架空)'],
      ['sample-part-time', 'バイト探し(架空)'],
      ['sample-library', '図書室(架空)'],
    ],
  );
});

test('一覧の名前は、目録の title に AI と話せるかを添える', () => {
  assert.equal(projectName('求人相談(架空)', true), '求人相談(架空・AI と話せる)');
  assert.equal(projectName('図書室(架空)', false), '図書室(架空・AI なし)');
  assert.equal(projectName('図書室 (架空)', false), '図書室(架空・AI なし)');
  // 括弧で終わらない名前は、後ろに括弧で足す
  assert.equal(projectName('my-app', true), 'my-app(AI と話せる)');
  assert.equal(projectName('(架空)', false), '(架空)(AI なし)');
});

test('サンプルを決まった順で先に、ほかの試作品を ID の順で後に並べる', async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-projects-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  for (const id of ['zz-mine', 'sample-library', 'aa-mine', 'sample-job-consult']) {
    await fs.mkdir(path.join(home, 'projects', id, 'app'), { recursive: true });
  }
  assert.deepEqual(
    (await listProjects(home)).map((p) => p.id),
    ['sample-job-consult', 'sample-library', 'aa-mine', 'zz-mine'],
  );
});

test('一覧には、正しい ID で app/ を持つものだけを出す', async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-projects-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  await fs.mkdir(path.join(home, 'projects', 'ok-one', 'app'), { recursive: true });
  await fs.mkdir(path.join(home, 'projects', 'Bad_Name', 'app'), { recursive: true });
  await fs.mkdir(path.join(home, 'projects', 'no-app'), { recursive: true });
  assert.deepEqual(
    (await listProjects(home)).map((p) => [p.id, p.title]),
    [['ok-one', 'ok-one']],
  );
});
