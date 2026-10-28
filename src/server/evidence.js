import fs from 'node:fs/promises';
import path from 'node:path';
import { digestSnapshot, snapshotApp } from './app-snapshot.js';

// 作るループの証拠(docs/design/harness.md の 7.2、S6)。
// 証拠が古いかは、関門が確かめた app/ の中身の指紋(run.appDigest)と、今の app/ の指紋を比べて決める。
// 次の依頼、版の復元、手で変えたときのどれでも、app/ の中身が変われば古くなる

// 画面に出せる画像の置き場(プロジェクトのフォルダーから)。作る run と、観察(CLI、人の「確かめる」)の結果だけ
export const EVIDENCE_FOLDERS = ['.studio/runs', '.studio/observations'];
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const IMAGE_PATTERN = /^\.studio\/(?:runs|observations)\/(?:[A-Za-z0-9_-][A-Za-z0-9._-]*\/)*[A-Za-z0-9_-][A-Za-z0-9._-]*\.png$/;

export class EvidenceError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export async function currentAppDigest(paths) {
  return digestSnapshot(await snapshotApp(paths.app));
}

// 終わった run ごとの、確かめた指紋と古いか。動いている run と、指紋のない run(関門まで進まなかった)の stale は null
export async function evidenceState(paths, runs) {
  const appDigest = await currentAppDigest(paths);
  return {
    appDigest,
    runs: runs.map((run) => {
      const digest = typeof run.appDigest === 'string' ? run.appDigest : null;
      const stale = run.status === 'running' || digest === null ? null : digest !== appDigest;
      return { id: run.id, appDigest: digest, stale };
    }),
  };
}

// 証拠の画像を読む。file はプロジェクトのフォルダーからの場所(run の gates にある形)。
// .studio/runs/ と .studio/observations/ の中の .png だけ。シンボリックリンクでその外を指していても読まない
export async function readEvidenceImage(paths, file) {
  if (typeof file !== 'string' || file.length > 300 || !IMAGE_PATTERN.test(file) || file.split('/').some((part) => part === '..' || part === '.')) {
    throw new EvidenceError(400, 'invalid', '画像の場所が正しくありません');
  }
  const target = path.join(paths.root, ...file.split('/'));
  const folder = EVIDENCE_FOLDERS.find((name) => file.startsWith(`${name}/`));
  let real;
  let root;
  try {
    [real, root] = await Promise.all([fs.realpath(target), fs.realpath(paths.root)]);
  } catch {
    throw new EvidenceError(404, 'not-found', '画像がありません');
  }
  // 置き場のフォルダー(.studio と、その中の runs か observations)がシンボリックリンクでも、外は読まない
  if (!real.startsWith(path.join(root, ...folder.split('/')) + path.sep)) throw new EvidenceError(404, 'not-found', '画像がありません');
  const stat = await fs.stat(real).catch(() => null);
  if (!stat?.isFile()) throw new EvidenceError(404, 'not-found', '画像がありません');
  if (stat.size > MAX_IMAGE_BYTES) throw new EvidenceError(413, 'too-large', '画像が大きすぎます');
  const body = await fs.readFile(real);
  if (!body.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) throw new EvidenceError(404, 'not-found', '画像がありません');
  return body;
}
