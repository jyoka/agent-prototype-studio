import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { snapshotApp } from './app-snapshot.js';
import { BusyError } from './store.js';
import { buildApp } from './build.js';
import { inspectApp, LIMITS } from './inspect.js';
import { restoreGuideCopies } from './materials.js';
import { isValidProjectId, projectPaths, projectsDir } from './projects.js';

// 利用者が保存した版の上限。自動の版は、新しいものから MAX_AUTO_VERSIONS 個だけ残す(復元を上限で止めないため)
export const MAX_VERSIONS = 100;
export const MAX_AUTO_VERSIONS = 30;
export const MAX_VERSION_NAME = 60;
const VERSION_ID = /^[a-f0-9]{16}$/;
const FORMAT = 1;
// 画面の札に出る名前。「作業中」は利用者の画面では「今の状態」と言う(ux-redesign.md 4 節)
const AUTO_NAME = '戻す前の状態(自動)';
// 表示できない状態は保存しない。誤りの場所(ファイルの名前)はターミナルにだけ出す。画面では 7-6 の知らせの開発者向けで見られる
const CANNOT_SAVE = '表示できない状態は保存できません。「作る AI」の欄で直してもらってから保存してください';

export class VersionError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// app/ の写し。普通のファイルとフォルダーだけを写し、シンボリックリンクなどはたどらずに省く。
// 大きさは app/ の検査(inspect.js)と同じ上限で止める。skip(app/ からの相対パス)が true のファイルは写さない
export async function copyTree(from, to, { skip = () => false } = {}) {
  let files = 0;
  let bytes = 0;
  async function walk(src, dest) {
    await fs.mkdir(dest, { recursive: true });
    for (const entry of await fs.readdir(src, { withFileTypes: true })) {
      const source = path.join(src, entry.name);
      const target = path.join(dest, entry.name);
      if (entry.isDirectory()) {
        await walk(source, target);
      } else if (entry.isFile()) {
        if (skip(path.relative(from, source).split(path.sep).join('/'))) continue;
        const { size } = await fs.lstat(source);
        files += 1;
        bytes += size;
        if (files > LIMITS.maxFiles || bytes > LIMITS.maxTotalBytes || size > LIMITS.maxFileBytes) {
          throw new VersionError(
            413,
            'too-large',
            `試作品のファイルが大きすぎるので保存できません(上限は ${LIMITS.maxFiles} 個、合計 ${LIMITS.maxTotalBytes} バイト)`,
          );
        }
        await fs.copyFile(source, target);
      }
    }
  }
  await walk(from, to);
}

function filesKey(files) {
  return JSON.stringify(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)));
}

const sameAi = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

function cleanName(name) {
  if (name === undefined || name === null) return '';
  if (typeof name !== 'string') throw new VersionError(400, 'invalid', '保存の名前は文字で書いてください');
  // 改行や制御文字は、一覧で 1 行に出すために空白にする
  const cleaned = name.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  if (cleaned.length > MAX_VERSION_NAME) throw new VersionError(400, 'invalid', `保存の名前は ${MAX_VERSION_NAME} 文字までにしてください`);
  return cleaned;
}

function isVersionRecord(record, id) {
  return (
    record !== null &&
    typeof record === 'object' &&
    record.format === FORMAT &&
    record.id === id &&
    Number.isSafeInteger(record.number) &&
    record.number > 0 &&
    typeof record.name === 'string' &&
    typeof record.savedAt === 'string' &&
    record.files !== null &&
    typeof record.files === 'object'
  );
}

// 壊れた版や、書きかけ(.tmp)は一覧に出さない。新しい順に返す
async function readVersions(paths) {
  const entries = await fs.readdir(paths.versions, { withFileTypes: true }).catch(() => []);
  const versions = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !VERSION_ID.test(entry.name)) continue;
    try {
      const record = JSON.parse(await fs.readFile(path.join(paths.versions, entry.name, 'version.json'), 'utf8'));
      if (isVersionRecord(record, entry.name)) versions.push(record);
    } catch {
      // version.json がない、または読めない
    }
  }
  return versions.sort((a, b) => b.number - a.number);
}

// working.json: 作業中がどの版から始まったか(baseVersionId)と、最後に付けた番号(lastNumber)。
// 番号を覚えておくのは、版のフォルダーを消した後に、同じ番号を別の版に付けないため
async function readWorking(paths) {
  try {
    const { baseVersionId, lastNumber } = JSON.parse(await fs.readFile(paths.working, 'utf8'));
    return {
      baseVersionId: typeof baseVersionId === 'string' && VERSION_ID.test(baseVersionId) ? baseVersionId : null,
      lastNumber: Number.isSafeInteger(lastNumber) && lastNumber > 0 ? lastNumber : 0,
    };
  } catch {
    return { baseVersionId: null, lastNumber: 0 };
  }
}

async function writeWorking(paths, changes) {
  const next = { ...(await readWorking(paths)), ...changes };
  await fs.mkdir(path.dirname(paths.working), { recursive: true });
  await fs.writeFile(paths.working, `${JSON.stringify(next, null, 2)}\n`);
}

function versionView(record) {
  const messages = record.ai?.messages ?? [];
  return {
    id: record.id,
    number: record.number,
    name: record.name,
    kind: record.kind,
    savedAt: record.savedAt,
    builds: record.builds,
    fileCount: Object.keys(record.files).length,
    ai: record.ai ? { messages: messages.length, userMessages: messages.filter((m) => m.role === 'user').length } : null,
  };
}

// 試作品の版。保存と復元は AI の判断を入れない、決まった手順として行う(ADR-0001、Stripe の Minions)。
// 版は .studio/versions/<版の ID>/ に、app/ の写しと version.json(ファイルの指紋、プロダクト内 AI の会話と状態)を置く。
// .studio/ はツールだけが書く場所で、作る AI は読み書きできない。git は使わない。
export class ProjectVersions {
  // answersOf(id) は、版の ID ごとの人に見せた答え(show.js)。答えは版の写しの外にあるので、版を戻しても消えない
  constructor({ store, aiSessions, log = () => {}, maxVersions = MAX_VERSIONS, maxAutoVersions = MAX_AUTO_VERSIONS, answersOf = async () => ({}) }) {
    this.store = store;
    this.aiSessions = aiSessions;
    this.answersOf = answersOf;
    this.log = log;
    this.maxVersions = maxVersions;
    this.maxAutoVersions = maxAutoVersions;
  }

  // 作業中(app/ と、メモリーにある会話と状態)が、どの保存版と同じか
  async working(id, paths, versions) {
    const files = Object.fromEntries(await snapshotApp(paths.app));
    const key = filesKey(files);
    const sameFiles = versions.filter((v) => filesKey(v.files) === key);
    const hasAi = Boolean(this.store.aiDefinition(id));
    const current = hasAi ? this.aiSessions.snapshot(id) : null;
    const sameAll = sameFiles.filter((v) => sameAi(v.ai, current));
    const { baseVersionId: base } = await readWorking(paths);
    const pick = (list) => list.find((v) => v.id === base) ?? list[0] ?? null;
    const match = pick(sameAll) ?? pick(sameFiles);
    return {
      // 保存版のどれかとファイルが同じで、会話と状態も同じか最初のままなら、復元で失うものはない
      saved: sameFiles.length > 0 && (current === null || sameAll.length > 0),
      view: {
        files: versions.length === 0 ? 'none' : match ? 'saved' : 'changed',
        versionId: match?.id ?? null,
        conversation: !hasAi ? null : match && sameAi(match.ai, current) ? 'saved' : current === null ? 'initial' : 'changed',
        baseVersionId: versions.some((v) => v.id === base) ? base : null,
      },
    };
  }

  async list(id) {
    const paths = await this.store.requireProject(id);
    const versions = await readVersions(paths);
    const { view } = await this.working(id, paths, versions);
    const answers = await this.answersOf(id);
    return { versions: versions.map((record) => ({ ...versionView(record), shows: answers[record.id] ?? [] })), working: view };
  }

  async save(id, { name } = {}) {
    const cleaned = cleanName(name);
    const paths = await this.store.requireProject(id);
    this.store.claimVersions(id);
    try {
      // 写しはシンボリックリンクなどを省くので、作業中そのものを先に検査する
      const problems = await inspectApp(paths.app);
      if (problems.length > 0) {
        this.log(`保存しませんでした(ビルドできない状態): ${id}(${problems[0].file}: ${problems[0].text})`);
        // 理由(シンボリックリンク、大きすぎるなど)は添える。ファイルの名前はターミナルにだけ出す
        throw new VersionError(422, 'build', `${CANNOT_SAVE}(${problems[0].text.replaceAll('app/ フォルダー', '試作品のフォルダー').replaceAll('app/', '試作品のフォルダー')})`);
      }
      const record = await this.write(id, paths, await readVersions(paths), { name: cleaned, kind: 'manual' });
      this.log(`版を保存しました: ${id}(v${record.number})`);
      return { version: versionView(record), ...(await this.list(id)) };
    } finally {
      this.store.releaseVersions(id);
    }
  }

  // 呼ぶ側が claimVersions で印を付けていること。keep に渡した版は、自動の版の整理で消さない
  async write(id, paths, versions, { name, kind, keep = null }) {
    if (kind === 'manual' && versions.filter((v) => v.kind !== 'auto').length >= this.maxVersions) {
      throw new VersionError(
        409,
        'too-many',
        `保存できるのは ${this.maxVersions} 個までです。Studio を止めて、要らない保存のフォルダーを ${paths.versions} から消してください`,
      );
    }
    const versionId = crypto.randomBytes(8).toString('hex');
    const tmp = path.join(paths.versions, `${versionId}.tmp`);
    const appCopy = path.join(tmp, 'app');
    try {
      await copyTree(paths.app, appCopy);
      // 写しをビルドして確かめる。表示中の版と会話には触れない
      const build = await buildApp({ appDir: appCopy, buildsDir: path.join(tmp, 'builds'), projectRoot: paths.root }).catch((error) => ({
        ok: false,
        errors: [{ file: 'app/', text: error.message }],
      }));
      await fs.rm(path.join(tmp, 'builds'), { recursive: true, force: true });
      if (!build.ok && kind === 'manual') {
        const first = build.errors[0];
        this.log(`保存しませんでした(ビルドできない状態): ${id}(${first ? `${first.file}: ${first.text}` : '理由はわかりません'})`);
        throw new VersionError(422, 'build', CANNOT_SAVE);
      }
      const record = {
        format: FORMAT,
        id: versionId,
        number: Math.max(versions[0]?.number ?? 0, (await readWorking(paths)).lastNumber) + 1,
        name,
        kind,
        savedAt: new Date().toISOString(),
        builds: build.ok,
        files: Object.fromEntries(await snapshotApp(appCopy)),
        // 保存するファイルの AI の設定に合う会話だけを入れる。ビルドできない自動の版は、表示中の設定の会話を入れる
        ai: build.ok ? this.aiSessions.snapshot(id, build.ai) : this.aiSessions.snapshot(id),
      };
      await fs.writeFile(path.join(tmp, 'version.json'), `${JSON.stringify(record, null, 2)}\n`);
      await fs.rename(tmp, path.join(paths.versions, versionId));
      await writeWorking(paths, { baseVersionId: versionId, lastNumber: record.number });
      if (kind === 'auto') await this.pruneAuto(paths, [record, ...versions], keep);
      return record;
    } catch (error) {
      await fs.rm(tmp, { recursive: true, force: true });
      throw error;
    }
  }

  // 古い自動の版を消す。利用者が保存した版と、これから復元する版(keep)は消さない
  async pruneAuto(paths, versions, keep) {
    const old = versions.filter((v) => v.kind === 'auto').slice(this.maxAutoVersions).filter((v) => v.id !== keep);
    for (const version of old) {
      await fs.rm(path.join(paths.versions, version.id), { recursive: true, force: true });
      this.log(`古い自動の版を消しました: v${version.number}`);
    }
  }

  // 版のファイルと、会話と状態に戻す。今の作業中がどの版とも違えば、先に自動で保存する(戻す操作で失わない)
  async restore(id, versionId) {
    const paths = await this.store.requireProject(id);
    if (typeof versionId !== 'string' || !VERSION_ID.test(versionId)) throw new VersionError(404, 'not-found', 'その保存はありません');
    this.store.claimVersions(id);
    try {
      const versions = await readVersions(paths);
      const version = versions.find((v) => v.id === versionId);
      if (!version) throw new VersionError(404, 'not-found', 'その保存はありません');
      // 応答を待っている会話を自動の版に入れそこねないよう、待つ
      if (this.aiSessions.isBusy(id)) throw new BusyError('試作品の中の AI が返事をしているところです。終わってから戻してください');
      const source = path.join(paths.versions, versionId, 'app');
      const { saved } = await this.working(id, paths, versions);
      let autoSaved = null;
      let setAside = null;
      if (!saved) {
        try {
          autoSaved = await this.write(id, paths, versions, { name: AUTO_NAME, kind: 'auto', keep: versionId });
        } catch (error) {
          if (!(error instanceof VersionError && error.code === 'too-large')) throw error;
          // 版にできないほど大きい作業中は、消さずに .studio/set-aside/ へ移す
          setAside = path.join(paths.studio, 'set-aside', `${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(2).toString('hex')}`);
        }
      }
      await replaceApp(paths, source, { setAside, log: this.log });
      // 版で戻しても素材は戻らない。有効にしている部品と指針の写し(app/design/)を、今の素材で書き直す(J5)
      // 前に外した写しが版から戻っていれば消す
      await restoreGuideCopies(paths.root, { pruneRetired: true });
      await writeWorking(paths, { baseVersionId: versionId });
      const build = await this.store.build(id, { byVersions: true });
      // ビルドできなければ、試す画面は前の版のまま。会話もそのままにする。
      // ただし、ビルドできない状態を自動で保存した版は、表示中の設定で会話を取ったので、会話だけ戻す
      const conversation =
        build.ok || !version.builds ? (this.aiSessions.restore(id, version.ai) ? 'restored' : 'initial') : 'kept';
      this.log(`版を復元しました: ${id}(v${version.number}${autoSaved ? `。復元の前の作業中を v${autoSaved.number} に保存` : ''})`);
      return {
        restored: versionView(version),
        autoSaved: autoSaved ? versionView(autoSaved) : null,
        setAside,
        build: { ok: build.ok, errorCount: build.errors?.length ?? 0 },
        conversation,
        ...(await this.list(id)),
      };
    } finally {
      this.store.releaseVersions(id);
    }
  }
}

// app/ を版の写しに取り替える。写しを先に作ってから名前を入れ替え、途中で失敗したら元に戻す。
// 途中で Studio が止まったときは、次の起動で recoverInterrupted が直す。
// setAside を渡すと、元の app/ を消さずにそこへ移す
async function replaceApp(paths, source, { setAside = null, log = () => {} } = {}) {
  const suffix = crypto.randomBytes(4).toString('hex');
  const incoming = path.join(paths.studio, `restoring-${suffix}`);
  const outgoing = path.join(paths.studio, `replaced-${suffix}`);
  try {
    await copyTree(source, incoming);
    await fs.rename(paths.app, outgoing);
  } catch (error) {
    await fs.rm(incoming, { recursive: true, force: true });
    throw error;
  }
  try {
    await fs.rename(incoming, paths.app);
  } catch (error) {
    try {
      await fs.rename(outgoing, paths.app);
    } catch {
      throw new Error(`試作品のファイルを戻せませんでした。元のファイルは ${outgoing} にあります(${error.message})`);
    }
    await fs.rm(incoming, { recursive: true, force: true });
    throw error;
  }
  try {
    if (setAside) {
      await fs.mkdir(setAside, { recursive: true });
      await fs.rename(outgoing, path.join(setAside, 'app'));
    } else {
      // 元の app/ は、版のどれかと同じか、自動の版に保存してある
      await fs.rm(outgoing, { recursive: true, force: true });
    }
  } catch (error) {
    // 取り替えは済んでいる。残ったフォルダーは、次の起動で片付ける
    log(`前の app/ を片付けられませんでした: ${outgoing}(${error.message})`);
  }
}

// 起動のときに、途中で止まった保存と復元の跡を片付ける。app/ がなく、取り替える前の app/ が残っていれば戻す
export async function recoverInterrupted(home, log = () => {}) {
  const entries = await fs.readdir(projectsDir(home), { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory() || !isValidProjectId(entry.name)) continue;
    const paths = projectPaths(home, entry.name);
    const studioEntries = await fs.readdir(paths.studio).catch(() => []);
    const replaced = studioEntries.filter((name) => name.startsWith('replaced-')).sort();
    const hasApp = Boolean(await fs.lstat(paths.app).catch(() => null));
    try {
      if (!hasApp && replaced.length > 0) {
        await fs.rename(path.join(paths.studio, replaced.pop()), paths.app);
        log(`途中で止まった復元を戻しました: ${entry.name}`);
      }
      for (const name of studioEntries.filter((n) => n.startsWith('restoring-'))) {
        await fs.rm(path.join(paths.studio, name), { recursive: true, force: true });
      }
      // 取り替えは済んでいた。前の app/ は消さずに脇へ置く(版にできなかった作業中かもしれないため)
      for (const name of replaced) {
        const target = path.join(paths.studio, 'set-aside', `recovered-${name}`);
        await fs.mkdir(target, { recursive: true });
        await fs.rename(path.join(paths.studio, name), path.join(target, 'app'));
        log(`途中で止まった復元の、前の app/ を脇へ置きました: ${target}`);
      }
      for (const name of await fs.readdir(paths.versions).catch(() => [])) {
        if (name.endsWith('.tmp')) await fs.rm(path.join(paths.versions, name), { recursive: true, force: true });
      }
    } catch (error) {
      log(`途中で止まった保存と復元の跡を片付けられませんでした: ${entry.name}(${error.message})`);
    }
  }
}
