import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { STUDIO_ROOT } from '../../src/server/config.js';
import { ensureSampleProjects, isValidProjectId, listProjects, projectPaths } from '../../src/server/projects.js';

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

  assert.deepEqual(await ensureSampleProjects(home, samples), ['sample-library', 'sample-job-consult']);
  const main = path.join(home, 'projects', 'sample-library', 'app', 'main.jsx');
  await fs.writeFile(main, '// changed');
  assert.deepEqual(await ensureSampleProjects(home, samples), []);
  assert.equal(await fs.readFile(main, 'utf8'), '// changed');

  // 後から足したサンプルだけを写す(前の版で起動したことのある置き場)
  await fs.rm(path.join(home, 'projects', 'sample-job-consult'), { recursive: true });
  assert.deepEqual(await ensureSampleProjects(home, samples), ['sample-job-consult']);
  assert.equal(await fs.readFile(main, 'utf8'), '// changed');

  const projects = await listProjects(home);
  assert.deepEqual(
    projects.map((p) => [p.id, p.title]),
    [
      ['sample-job-consult', 'サンプル: 架空の求人相談(モック AI)'],
      ['sample-library', 'サンプル: 架空の図書室'],
    ],
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
