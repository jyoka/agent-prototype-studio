import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { IntentError } from './intent.js';
import { isValidProjectId, listProjects, projectPaths } from './projects.js';
import { findRecords } from './redact.js';
import { NotFoundError } from './store.js';
import { aadOf, importKey, open, randomText, seal, ticketHash } from '../share-page/seal.js';

// 共有の場の Studio の側(docs/design/collaboration.md の 9.4、ADR 0004 の段 2 の層 4。K7 の 2 枚目)。
// Studio のサーバーは 127.0.0.1 のまま。中継のサーバーへは、ここから外へつなぐだけで、外から Studio には入らない。
// 中継のサーバーに置くのは、会の鍵で包んだ文書の写し(docs)と、参加者の書き込みの暗号文だけ。
// app/ のソース、ビルド、版、run の記録、作る AI の会話は、ここを通らない(docsOf が作る写しに入れない)。
// 文書の正は進行役の PC の Studio。参加者の書き込み(項目を足す、直す、消す)は、Studio が受け取って整理の板に当て、
// 新しい写しを配る。だから記録らしいものを断る決まり(K4)は、参加者の書き込みにも同じに効く。
// 中継のサーバーに届かない間も、手元の Studio はそのまま使える。つながり直すと、届いていない書き込みを当て、写しを置き直す。
// 置き場は .studio/share.json(会の鍵と札を持つ。.studio/ は Studio だけが書く場所で、作る AI は読み書きできない)。

export const SHARE_FILE = 'share.json';
// 消せなかった中継のサーバーの写し。プロジェクトの外に置き、次の起動で消すのをやり直す(collaboration.md の 9.4 の「消す」)
export const SHARE_PENDING_FILE = 'share-pending.json';
const FORMAT = 1;
// 役は 2 つ(K7 の 2 枚目)。決める人と承認は 3 枚目で足す
export const SHARE_ROLES = Object.freeze({ participant: '参加者(直せる)', viewer: '見るだけ' });
const MAX_NAME = 40;
const MAX_RESULTS = 30;
const RETRY_MS = [500, 1000, 2000, 4000];
const REQUEST_TIMEOUT_MS = 5000;
// 中継のサーバーは 15 秒ごとに心拍を送る。これだけ何も来なければ、切れたと見てつなぎ直す
const SILENCE_MS = 45_000;
// 同じ書き込みを 2 度当てないために覚えておく、書き込みの ID の数
const MAX_APPLIED = 500;
// 中継のサーバーの写しの名前(relay-server.js の FILE_NAME の形)
export const DOCS_FILE = 'docs';

export class ShareError extends IntentError {}

// 中継のサーバーの側で共有が終わったときの知らせ。手元の板はそのまま
const ENDED = {
  expired: '中継のサーバーの写しは、消す日を過ぎたので消えました。共有を続けるときは、もう一度始めてください',
  lost: '中継のサーバーに、この会がありません(中継のサーバーの写しが消えたか、別の中継のサーバーです)。共有を続けるときは、もう一度始めてください',
};

const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');
const sleep = (ms, signal) => new Promise((resolve) => {
  const timer = setTimeout(resolve, ms);
  timer.unref?.();
  signal?.addEventListener('abort', () => {
    clearTimeout(timer);
    resolve();
  }, { once: true });
});

async function atomicWrite(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`);
  await fs.rename(tmp, file);
}

class RelayRequestError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// 中継のサーバーに 1 つ頼む。届かないときは RelayRequestError(status 0)
async function relayFetch(fetchImpl, base, pathname, { method = 'GET', ticket, body, signal } = {}) {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  let response;
  try {
    response = await fetchImpl(`${base}${pathname}`, {
      method,
      headers: { ...(ticket ? { Authorization: `Bearer ${ticket}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
  } catch (error) {
    throw new RelayRequestError(0, 'offline', `中継のサーバーに届きません(${error.cause?.code ?? error.name})`);
  }
  let parsed = null;
  try {
    parsed = await response.json();
  } catch {
    // JSON でない返事は下で扱う
  }
  if (!response.ok) throw new RelayRequestError(response.status, parsed?.error?.code ?? 'http', parsed?.error?.message ?? `中継のサーバーが ${response.status} を返しました`);
  return parsed;
}

// 1 つの試作品の共有。中継のサーバーとのつながりを持ち、書き込みを受け取り、写しを置く
class ShareLink {
  constructor(shares, id, record) {
    this.shares = shares;
    this.id = id;
    this.record = record;
    this.state = 'connecting';
    this.lastSyncAt = null;
    this.problem = null;
    this.controller = new AbortController();
    // 受け取りと置き直しを 1 つずつ通す列
    this.queue = Promise.resolve();
    this.publishedHash = null;
    this.compactedUpTo = record.cursor;
    this.key = null;
  }

  get base() {
    return this.record.relayUrl;
  }

  request(pathname, options = {}) {
    return relayFetch(this.shares.fetchImpl, this.base, `/api/sessions/${this.record.sessionId}${pathname}`, { ticket: this.record.studioTicket, signal: this.controller.signal, ...options });
  }

  async start() {
    this.key = await importKey(this.record.key);
    this.loop().catch((error) => this.shares.log(`共有のつながりが止まりました: ${this.id}(${error.message})`));
    this.timer = setInterval(() => this.enqueue(() => this.publish()), this.shares.tickMs);
    this.timer.unref?.();
  }

  stop() {
    this.controller.abort();
    clearInterval(this.timer);
  }

  enqueue(work) {
    const run = async () => {
      if (this.controller.signal.aborted) return;
      try {
        await work();
      } catch (error) {
        this.noteFailure(error);
      }
    };
    this.queue = this.queue.then(run, run);
    return this.queue;
  }

  // つながりの状態(online、offline)を決めるのは loop だけ。ここでは知らせの文だけを残す(1 回の失敗で offline のままにしない)
  noteFailure(error) {
    if (error instanceof RelayRequestError && error.status === 410) return this.ended('expired');
    // 中継のサーバー自身が「その会はない」と答えたときだけ終える(前に置いた口の 404 では終えない)
    if (error instanceof RelayRequestError && error.status === 404 && error.code === 'not-found') return this.ended('lost');
    if (error instanceof RelayRequestError) {
      this.problem = error.message;
      return;
    }
    this.shares.log(`共有で失敗しました: ${this.id}(${error.message})`);
    this.problem = '共有の処理で失敗しました。ターミナルを見てください';
  }

  // 中継のサーバーが会を消していた(消す日を過ぎた)。手元の板はそのまま。共有は終わる
  ended(reason) {
    if (this.state === 'ended') return;
    this.state = 'ended';
    this.problem = ENDED[reason] ?? null;
    this.stop();
    this.shares.endedLink(this.id, reason);
  }

  // つながりを持ち続ける。切れたら、少し待ってつなぎ直す
  async loop() {
    let attempt = 0;
    const { signal } = this.controller;
    while (!signal.aborted) {
      // つながりごとの止め口。心拍が途切れたら、これで止めてつなぎ直す
      const connection = new AbortController();
      const stopConnection = () => connection.abort();
      signal.addEventListener('abort', stopConnection, { once: true });
      try {
        // 返事の頭が来るまでの上限。来なければ止めてつなぎ直す
        const connectTimer = setTimeout(stopConnection, REQUEST_TIMEOUT_MS * 2);
        connectTimer.unref?.();
        const response = await this.shares.fetchImpl(`${this.base}/api/sessions/${this.record.sessionId}/stream`, {
          headers: { Authorization: `Bearer ${this.record.studioTicket}`, Accept: 'text/event-stream' },
          signal: connection.signal,
        }).finally(() => clearTimeout(connectTimer));
        if (response.status === 410) {
          this.ended('expired');
          return;
        }
        if (response.status === 404 && (await response.json().catch(() => null))?.error?.code === 'not-found') {
          this.ended('lost');
          return;
        }
        if (!response.ok || !response.body) throw new RelayRequestError(response.status, 'http', `中継のサーバーが ${response.status} を返しました`);
        attempt = 0;
        this.state = 'online';
        this.problem = null;
        // つながったら、届いていない書き込みを受け取り、写しを置き直す(手元で直したものを合わせる)
        this.enqueue(() => this.pull());
        this.enqueue(() => this.publish({ force: true }));
        await this.read(response.body, connection);
      } catch (error) {
        if (signal.aborted) return;
        if (!(error instanceof RelayRequestError)) this.problem = `中継のサーバーに届きません(${error.cause?.code ?? error.name})`;
        else this.problem = error.message;
      } finally {
        signal.removeEventListener('abort', stopConnection);
        connection.abort();
      }
      if (signal.aborted || this.state === 'ended') return;
      this.state = 'offline';
      this.publishedHash = null;
      await sleep(RETRY_MS[Math.min(attempt, RETRY_MS.length - 1)], signal);
      attempt += 1;
    }
  }

  // Server-Sent Events を読む。row が来たら受け取り、deleted が来たら終える。
  // 心拍(SILENCE_MS の間に何も来ない)が途切れたら、つながりを止める(Wi-Fi が落ちた、PC が眠ったとき)
  async read(body, connection) {
    const decoder = new TextDecoder();
    let buffer = '';
    let watchdog = null;
    const arm = () => {
      clearTimeout(watchdog);
      watchdog = setTimeout(() => connection.abort(), SILENCE_MS);
      watchdog.unref?.();
    };
    arm();
    try {
      for await (const chunk of body) {
        arm();
        buffer += decoder.decode(chunk, { stream: true });
        let index;
        while ((index = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          const event = /^event: (.+)$/m.exec(block)?.[1];
          if (event === 'row') this.enqueue(() => this.pull());
          if (event === 'deleted') {
            this.ended('expired');
            return;
          }
        }
      }
    } finally {
      clearTimeout(watchdog);
    }
  }

  // 参加者の書き込みを受け取り、整理の板に当てる。当てた番号(cursor)を覚え、同じ書き込みを 2 度当てない
  async pull() {
    const { rows } = await this.request(`/rows?since=${this.record.cursor}`);
    for (const row of rows) {
      if (row.seq <= this.record.cursor) continue;
      if (!this.active) return;
      const { opId, ...result } = await this.applyRow(row);
      if (!this.active) return;
      this.record.results = [...(this.record.results ?? []), { seq: row.seq, member: row.member, ...result }].slice(-MAX_RESULTS);
      if (opId) this.record.applied = [...(this.record.applied ?? []), opId].slice(-MAX_APPLIED);
      this.record.cursor = row.seq;
      await this.shares.save(this.id, this.record);
    }
    this.lastSyncAt = new Date().toISOString();
    await this.publish();
  }

  // 止めた後と、別のつながりに替わった後は、記録を書かない(消した share.json を書き戻さない)
  get active() {
    return !this.controller.signal.aborted && this.shares.links.get(this.id) === this;
  }

  async applyRow(row) {
    const member = this.record.members.find((entry) => entry.id === row.member);
    // 役の表にない人と見るだけの人の書き込みは捨てる(中継のサーバーが断り損ねても)
    if (!member || member.role !== 'participant') return { ok: false, message: '書ける人の書き込みではないので、当てませんでした' };
    let op;
    try {
      op = await open(this.key, aadOf(this.record.sessionId, 'row'), row.data);
    } catch {
      return { ok: false, message: '書き込みを開けなかったので、当てませんでした' };
    }
    // 同じ書き込み(送り直し、中継のサーバーの送り直し)は 1 度だけ当てる
    const opId = typeof op?.opId === 'string' ? op.opId.slice(0, 64) : null;
    if (opId && (this.record.applied ?? []).includes(opId)) return { ok: true, op: op?.op ?? null, duplicate: true };
    try {
      await this.shares.apply(this.id, op, member);
      return { ok: true, op: op?.op ?? null, opId };
    } catch (error) {
      if (error instanceof IntentError || error?.code) return { ok: false, op: op?.op ?? null, message: error.message, opId };
      throw error;
    }
  }

  // 写しを置く。前に置いたものと同じなら置かない(force はつながり直したとき)
  async publish({ force = false } = {}) {
    if (this.state === 'ended') return;
    const docs = await this.shares.docsOf(this.id);
    const value = {
      format: FORMAT,
      ...docs,
      members: this.record.members.map((m) => ({ id: m.id, name: m.name, role: m.role, roleLabel: SHARE_ROLES[m.role] })),
      // ここまでの書き込みを当てた。参加者のページは、これより前の自分の書き込みの「送った」の印を外す
      seen: this.record.cursor,
      results: (this.record.results ?? []).map(({ seq, member, ok, message }) => ({ seq, member, ok, ...(message ? { message } : {}) })),
    };
    const hash = sha256(JSON.stringify(value));
    if (!force && hash === this.publishedHash) return;
    const data = await seal(this.key, aadOf(this.record.sessionId, `file:${DOCS_FILE}`), { ...value, at: new Date().toISOString() });
    await this.request(`/files/${DOCS_FILE}`, { method: 'PUT', body: { data } });
    this.publishedHash = hash;
    this.lastSyncAt = new Date().toISOString();
    if (this.state === 'online') this.problem = null;
    // 当てた書き込みは写しに入ったので、中継のサーバーから消す(消した字が古い書き込みに残らないように)
    if (this.record.cursor > this.compactedUpTo) {
      await this.request('/compact', { method: 'POST', body: { upTo: this.record.cursor } });
      this.compactedUpTo = this.record.cursor;
    }
  }
}

export class ProjectShares {
  // relayUrl は中継のサーバー(STUDIO_RELAY_URL。null なら共有できない)。
  // docsOf(id) は中継のサーバーに置く文書の写し。apply(id, op, member) は参加者の書き込みを整理の板に当てる。
  // gate(id) は会の同意の前と、消している間に断る。expiresOf(id) は消す日(YYYY-MM-DD。会でなければ null)
  constructor({ home, store, relayUrl = null, docsOf, apply, gate = () => {}, expiresOf = () => null, fetchImpl = globalThis.fetch, tickMs = 1000, log = () => {} }) {
    this.home = home;
    this.store = store;
    this.relayUrl = relayUrl;
    this.docsOf = docsOf;
    this.apply = apply;
    this.gate = gate;
    this.expiresOf = expiresOf;
    this.fetchImpl = fetchImpl;
    this.tickMs = tickMs;
    this.log = log;
    this.links = new Map();
    this.endedReasons = new Map();
    // 起動のときに読んだが、つながなかった共有(中継のサーバーの宛先が違う、決まっていない)。会のデータを消すときに、写しを消すのに使う
    this.dormant = new Map();
    // 始めている途中の試作品(2 つの「共有を始める」で会を 2 つ作らない)
    this.starting = new Map();
    this.closed = false;
  }

  file(id) {
    return path.join(projectPaths(this.home, id).studio, SHARE_FILE);
  }

  pendingFile() {
    return path.join(this.home, SHARE_PENDING_FILE);
  }

  // 起動のときに読む。共有していた試作品は、つなぎ直す。前に消せなかった写しを、消すのをやり直す
  async load() {
    for (const project of await listProjects(this.home)) {
      try {
        const record = JSON.parse(await fs.readFile(this.file(project.id), 'utf8'));
        if (record?.formatVersion !== FORMAT || typeof record.sessionId !== 'string' || !Array.isArray(record.members)) throw new Error('形が違います');
        if (!this.relayUrl || record.relayUrl !== this.relayUrl) {
          this.dormant.set(project.id, record);
          this.log(`共有は止めています(中継のサーバーの宛先が、始めたときと違います): ${project.id}`);
          continue;
        }
        await this.open(project.id, record);
      } catch (error) {
        if (error.code !== 'ENOENT') this.log(`共有の記録を読めませんでした: ${project.id}(${error.message})`);
      }
    }
    await this.retryPending();
  }

  async open(id, record) {
    const link = new ShareLink(this, id, record);
    this.links.set(id, link);
    this.endedReasons.delete(id);
    await link.start();
    return link;
  }

  async save(id, record) {
    if (this.closed) return;
    await this.store.requireProject(id);
    await atomicWrite(this.file(id), record);
  }

  endedLink(id, reason) {
    const link = this.links.get(id);
    this.links.delete(id);
    this.endedReasons.set(id, reason);
    fs.rm(this.file(id), { force: true }).catch(() => {});
    // 会がないと答えた中継のサーバーが、本当は写しを持っているかもしれない。消すのを後でやり直す(ないと分かれば表から外れる)
    if (reason === 'lost' && link) {
      const { relayUrl, sessionId, studioTicket } = link.record;
      this.addPending({ relayUrl, sessionId, studioTicket }).catch(() => {});
    }
    this.log(`共有が終わりました: ${id}(${reason})`);
  }

  async requireProject(id) {
    if (!isValidProjectId(id)) throw new NotFoundError(`プロジェクトがありません: ${id}`);
    return this.store.requireProject(id);
  }

  // 文書が変わった(整理の板を書いた)。すぐに写しを置き直す
  changed(id) {
    const link = this.links.get(id);
    if (link) link.enqueue(() => link.publish());
  }

  async view(id) {
    await this.requireProject(id);
    const link = this.links.get(id);
    const ended = this.endedReasons.get(id);
    if (!link) {
      return {
        available: Boolean(this.relayUrl),
        relay: this.relayUrl,
        state: ended ? 'ended' : 'none',
        problem: ENDED[ended] ?? (this.dormant.has(id) ? '前に始めた共有は、中継のサーバーの宛先が違うので止めています。もう一度始めると、前の写しを消してから始めます' : null),
        members: [],
      };
    }
    const { record } = link;
    return {
      available: true,
      relay: record.relayUrl,
      state: link.state,
      problem: link.problem,
      startedAt: record.createdAt,
      expiresAt: record.expiresAt,
      lastSyncAt: link.lastSyncAt,
      members: record.members.map((m) => ({ id: m.id, name: m.name, role: m.role, roleLabel: SHARE_ROLES[m.role], link: this.linkOf(record, m) })),
      refused: (record.results ?? []).filter((r) => !r.ok).slice(-5).map((r) => ({ seq: r.seq, name: record.members.find((m) => m.id === r.member)?.name ?? '(外した人)', message: r.message })),
    };
  }

  // 招待のリンク。鍵と札はフラグメント(# の後)に入れる。ブラウザは中継のサーバーに送らない
  linkOf(record, member) {
    return `${record.relayUrl}/s/${record.sessionId}#k=${record.key}&t=${member.ticket}&m=${member.id}`;
  }

  // 共有を始める。人が押したときだけ呼ぶ。会の同意の前は断る。同じ試作品で始めている途中なら、それを待つ
  async start(id) {
    if (this.starting.has(id)) {
      await this.starting.get(id).catch(() => {});
      return this.view(id);
    }
    const work = this.startOnce(id);
    this.starting.set(id, work);
    try {
      return await work;
    } finally {
      this.starting.delete(id);
    }
  }

  async startOnce(id) {
    await this.requireProject(id);
    this.gate(id);
    if (!this.relayUrl) throw new ShareError(409, 'no-relay', '中継のサーバーが決まっていないので、共有できません。STUDIO_RELAY_URL を決めて、Studio を起動し直してください');
    if (this.links.has(id)) return this.view(id);
    // 前の起動でつながなかった共有があれば、その写しを先に消す(会を 2 つ残さない)
    if (this.dormant.has(id)) await this.forget(id);
    const key = randomText(32);
    const studioTicket = randomText(32);
    const deleteOn = this.expiresOf(id);
    // 消す日の終わりまで。会でなければ 30 日(会の消す日の既定と同じ)
    const expiresAt = deleteOn ? new Date(`${deleteOn}T23:59:59`).toISOString() : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    let created;
    try {
      created = await relayFetch(this.fetchImpl, this.relayUrl, '/api/sessions', { method: 'POST', body: { expiresAt, studioTicketHash: await ticketHash(studioTicket) } });
    } catch (error) {
      throw new ShareError(502, 'relay', `共有を始められませんでした。${error.message}`);
    }
    const record = { formatVersion: FORMAT, relayUrl: this.relayUrl, sessionId: created.id, key, studioTicket, expiresAt: created.expiresAt, createdAt: new Date().toISOString(), cursor: 0, members: [], results: [] };
    await this.save(id, record);
    await this.open(id, record);
    this.log(`共有を始めました: ${id}`);
    return this.view(id);
  }

  requireLink(id) {
    const link = this.links.get(id);
    if (!link) throw new ShareError(409, 'not-sharing', 'この試作品は、まだ共有していません。先に「共有を始める」を押してください');
    return link;
  }

  // 人を招く。呼び名と役。リンクは画面に出し、進行役が手渡す
  async invite(id, { name, role } = {}) {
    await this.requireProject(id);
    this.gate(id);
    const link = this.requireLink(id);
    const clean = typeof name === 'string' ? name.replace(/\s+/g, ' ').trim() : '';
    if (!clean) throw new ShareError(400, 'invalid', '招く人の呼び名を書いてください');
    if (clean.length > MAX_NAME) throw new ShareError(400, 'invalid', `呼び名は ${MAX_NAME} 文字までにしてください`);
    const kinds = findRecords(clean);
    if (kinds.length > 0) throw new ShareError(422, 'record', `記録らしいものがあるので、入れませんでした(${kinds.join('、')})。呼び名か役だけを書いてください。`);
    if (!Object.hasOwn(SHARE_ROLES, role ?? '')) throw new ShareError(400, 'invalid', `役は ${Object.values(SHARE_ROLES).join('、')} のどれかです`);
    const member = { id: randomText(12), name: clean, role, ticket: randomText(32), invitedAt: new Date().toISOString() };
    try {
      await link.request(`/members/${member.id}`, { method: 'PUT', body: { ticketHash: await ticketHash(member.ticket), write: role === 'participant' } });
    } catch (error) {
      throw new ShareError(502, 'relay', `招けませんでした。${error.message}`);
    }
    link.record.members = [...link.record.members, member];
    await this.save(id, link.record);
    link.enqueue(() => link.publish());
    return this.view(id);
  }

  // 人を外す。中継のサーバーで札を消す。会の鍵の作り直しは 3 枚目(collaboration.md の 9.5)
  async remove(id, { member } = {}) {
    await this.requireProject(id);
    const link = this.requireLink(id);
    if (!link.record.members.some((m) => m.id === member)) throw new ShareError(404, 'no-member', 'その人は招いていません');
    try {
      await link.request(`/members/${member}`, { method: 'DELETE' });
    } catch (error) {
      throw new ShareError(502, 'relay', `外せませんでした。${error.message}`);
    }
    link.record.members = link.record.members.filter((m) => m.id !== member);
    await this.save(id, link.record);
    link.enqueue(() => link.publish());
    return this.view(id);
  }

  // 共有をやめる。中継のサーバーの写しを消す。手元の板はそのまま
  async stop(id) {
    await this.requireProject(id);
    const link = this.requireLink(id);
    const result = await this.drop(id, link);
    if (result === 'left') throw new ShareError(502, 'relay', '中継のサーバーに届かないので、写しを消せませんでした。共有は止めました。消す日に中継のサーバーが消します。次に Studio を起動したときにも、消すのをやり直します');
    return this.view(id);
  }

  // つながりを止め、中継のサーバーの写しを消す。届かなければ、プロジェクトの外の表に残して後でやり直す。
  // 返すのは 'erased'(消した)、'left'(消せなかった)、null(共有していない)
  async drop(id, link = this.links.get(id)) {
    if (!link) return null;
    link.stop();
    this.links.delete(id);
    const result = await this.deleteRemote(link.record, id);
    await fs.rm(this.file(id), { force: true }).catch(() => {});
    return result;
  }

  // 会のデータを消したとき(meeting.js の erase)。置き場はもう移してあるので、記録はメモリーのものを使う。
  // つないでいなかった共有(宛先が違う起動)も、記録の宛先へ消しに行く。届かなければ後でやり直す
  async forget(id) {
    let result = await this.drop(id);
    const dormant = this.dormant.get(id);
    this.dormant.delete(id);
    if (!result && dormant) result = await this.deleteRemote(dormant, id);
    this.endedReasons.delete(id);
    return result;
  }

  async deleteRemote({ relayUrl, sessionId, studioTicket }, id) {
    try {
      await relayFetch(this.fetchImpl, relayUrl, `/api/sessions/${sessionId}`, { method: 'DELETE', ticket: studioTicket });
      return 'erased';
    } catch (error) {
      if (error instanceof RelayRequestError && (error.status === 410 || error.status === 404)) return 'erased';
      await this.addPending({ relayUrl, sessionId, studioTicket });
      this.log(`中継のサーバーの写しを消せませんでした。後でやり直します: ${id}(${error.message})`);
      return 'left';
    }
  }

  async readPending() {
    try {
      const list = JSON.parse(await fs.readFile(this.pendingFile(), 'utf8'));
      return Array.isArray(list) ? list : [];
    } catch {
      return [];
    }
  }

  async addPending(entry) {
    const list = await this.readPending();
    if (!list.some((e) => e.sessionId === entry.sessionId)) list.push({ ...entry, at: new Date().toISOString() });
    await atomicWrite(this.pendingFile(), list);
  }

  // 前に消せなかった写しを消す。消せたものと、もう消えていたものは表から外す
  async retryPending() {
    const list = await this.readPending();
    if (list.length === 0) return;
    const left = [];
    for (const entry of list) {
      try {
        await relayFetch(this.fetchImpl, entry.relayUrl, `/api/sessions/${entry.sessionId}`, { method: 'DELETE', ticket: entry.studioTicket });
        this.log('前に消せなかった中継のサーバーの写しを消しました');
      } catch (error) {
        if (!(error instanceof RelayRequestError && (error.status === 410 || error.status === 404))) left.push(entry);
      }
    }
    if (left.length === 0) await fs.rm(this.pendingFile(), { force: true });
    else await atomicWrite(this.pendingFile(), left);
  }

  // 中継のサーバーに写しがあるかもしれないか(消す一覧に載せる)
  isSharing(id) {
    return this.links.has(id) || this.dormant.has(id);
  }

  async close() {
    this.closed = true;
    for (const link of this.links.values()) link.stop();
    await Promise.all([...this.links.values()].map((link) => link.queue));
  }
}
