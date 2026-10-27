import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { startAgentProcess, STOP_STEPS_MS } from './agent-process.js';
import { diffSnapshots, MAX_SNAPSHOT_ENTRIES, snapshotApp } from './app-snapshot.js';
import { buildClaudeArgs, DEFAULT_MAX_BUDGET_USD, MAX_TURNS } from './claude-args.js';
import { readMessage } from './stream-json.js';

export const MAX_REQUEST_CHARS = 4000;
export const DEFAULT_AGENT_TIMEOUT_MS = 10 * 60_000;
const MAX_RUNS_PER_PROJECT = 20;
const MAX_ITEMS_PER_RUN = 300;
// 作る AI の出力から作る項目。数が多いときに省くのはこれだけで、Studio の結果の項目は省かない
const AGENT_ITEM_KINDS = new Set(['assistant', 'tool', 'tool-error']);
const LOGIN_PATTERN = /not logged in|please run \/login|invalid api key|authentication_error|oauth token has expired/i;

export class RequestError extends Error {}
export class AgentUnavailableError extends Error {}

// 作る欄の依頼を受け、作る AI を動かし、決まった手順(変更の確認、検査、ビルド)を行う。
// AI の判断と決まった手順を分ける(ADR-0001、Stripe の Minions)。
export class BuildRequests {
  constructor({ store, connection, env = process.env, log = () => {}, timeoutMs = DEFAULT_AGENT_TIMEOUT_MS, maxBudgetUsd = DEFAULT_MAX_BUDGET_USD }) {
    this.store = store;
    this.connection = connection;
    this.env = env;
    this.log = log;
    this.timeoutMs = timeoutMs;
    this.maxBudgetUsd = maxBudgetUsd;
    this.runs = new Map();
    this.active = new Map();
    this.versions = new Map();
    this.closing = false;
  }

  summary(id) {
    return { running: this.active.has(id), version: this.versions.get(id) ?? 0 };
  }

  list(id) {
    return (this.runs.get(id) ?? []).map((run) => structuredClone(run));
  }

  touch(id, run) {
    this.versions.set(id, (this.versions.get(id) ?? 0) + 1);
    this.active.get(id)?.emitter.emit('update', structuredClone(run));
  }

  addItem(id, run, kind, text) {
    if (AGENT_ITEM_KINDS.has(kind) && run.items.filter((item) => AGENT_ITEM_KINDS.has(item.kind)).length >= MAX_ITEMS_PER_RUN) {
      if (!run.items.some((item) => item.kind === 'skipped')) {
        run.items.push({ kind: 'skipped', text: '作る AI の知らせが多すぎるので、ここから先は省きます。', at: new Date().toISOString() });
        this.touch(id, run);
      }
      return;
    }
    run.items.push({ kind, text, at: new Date().toISOString() });
    this.touch(id, run);
  }

  // 依頼を受けて実行を始める。返す subscribe で、実行の様子を受け取れる。
  async start(id, requestText) {
    const request = typeof requestText === 'string' ? requestText.trim() : '';
    if (!request) throw new RequestError('依頼を書いてください');
    if (request.length > MAX_REQUEST_CHARS) throw new RequestError(`依頼は ${MAX_REQUEST_CHARS} 文字までにしてください`);
    if (this.closing) throw new AgentUnavailableError('Studio を止めているところです');
    const paths = await this.store.requireProject(id);
    if (this.closing) throw new AgentUnavailableError('Studio を止めているところです');
    if (this.connection.problem) throw new AgentUnavailableError(this.connection.problem);
    this.store.claimRun(id);

    const run = {
      id: crypto.randomBytes(8).toString('hex'),
      request,
      agent: this.connection.label,
      status: 'running',
      startedAt: new Date().toISOString(),
      finishedAt: null,
      auth: null,
      items: [],
      changedFiles: [],
      build: null,
    };
    const emitter = new EventEmitter();
    const runs = this.runs.get(id) ?? [];
    runs.push(run);
    if (runs.length > MAX_RUNS_PER_PROJECT) runs.splice(0, runs.length - MAX_RUNS_PER_PROJECT);
    this.runs.set(id, runs);
    const active = { run, emitter, handle: null };
    this.active.set(id, active);
    this.touch(id, run);
    this.log(`作る AI に依頼しました: ${id}(${this.connection.label})`);

    active.done = this.execute(id, paths, active).catch((error) => {
      this.log(`作る AI の実行で問題が起きました: ${id}(${error.message})`);
      run.status = 'failed';
      this.addItem(id, run, 'failed', `Studio の中で問題が起きました: ${error.message}`);
    }).finally(() => {
      run.finishedAt ??= new Date().toISOString();
      this.active.delete(id);
      this.store.releaseRun(id);
      this.touch(id, run);
      emitter.emit('end', structuredClone(run));
    });

    return {
      run: structuredClone(run),
      subscribe(onUpdate, onEnd) {
        emitter.on('update', onUpdate);
        emitter.once('end', onEnd);
        return () => {
          emitter.off('update', onUpdate);
          emitter.off('end', onEnd);
        };
      },
    };
  }

  async execute(id, paths, active) {
    const { run } = active;
    const label = this.connection.label;
    const before = await snapshotApp(paths.app);
    const appDirs = [paths.app, await fs.realpath(paths.app)];
    let result = null;

    if (active.cancelRequested) {
      run.status = 'cancelled';
      this.addItem(id, run, 'cancelled', '起動する前に中断しました。');
      return;
    }
    let handle;
    try {
      handle = startAgentProcess({
        command: this.connection.command,
        args: [...this.connection.prefixArgs, ...buildClaudeArgs({ billing: this.connection.billing, maxBudgetUsd: this.maxBudgetUsd })],
        cwd: paths.app,
        // 利用者の環境変数をそのまま渡す。値は読まない、残さない
        env: this.env,
        input: run.request,
        timeoutMs: this.timeoutMs,
        onMessage: (message) => {
          const read = readMessage(message, appDirs);
          if (read.init) {
            run.auth = read.init.apiKeySource;
            this.touch(id, run);
          }
          if (read.result) result = read.result;
          for (const item of read.items) this.addItem(id, run, item.kind, item.text);
        },
      });
    } catch (error) {
      run.status = 'failed';
      this.addItem(id, run, 'failed', `${label} を起動できませんでした(${error.code ?? error.message})`);
      return;
    }
    active.handle = handle;
    // 起動の前に中断が押されていたとき
    if (active.cancelRequested) handle.stop('cancel');
    const exit = await handle.done;
    // ここから先は決まった手順だけ。中断は受けない
    active.exited = true;

    if (exit.stopReason === 'cancel') {
      run.status = 'cancelled';
      this.addItem(id, run, 'cancelled', '中断しました。途中まで書かれたファイルは、そのまま残っています。');
    } else if (exit.stopReason === 'timeout') {
      run.status = 'timed-out';
      this.addItem(id, run, 'failed', `時間の上限(${Math.round(this.timeoutMs / 60_000)} 分)を超えたので止めました。依頼を小さく分けて送ってください。`);
    } else if (exit.spawnError) {
      run.status = 'failed';
      this.addItem(id, run, 'failed', `${label} を起動できませんでした(${exit.spawnError.code ?? exit.spawnError.message})`);
    } else if (result?.ok && exit.code === 0) {
      run.status = 'done';
    } else {
      run.status = 'failed';
      this.addItem(id, run, 'failed', this.failureText(result, exit));
    }

    for (const denial of result?.denials ?? []) {
      this.addItem(id, run, 'denied', `権限の確認で断られました: ${denial}`);
    }
    const loginText = `${result?.text ?? ''}\n${exit.stderrTail}`;
    if (run.status === 'failed' && LOGIN_PATTERN.test(loginText)) {
      this.addItem(
        id,
        run,
        'hint',
        'Claude Code にログインしていないか、ログインが切れています。ターミナルで claude を起動して /login でログインしてから、もう一度送ってください。Studio はログインの情報を扱いません。',
      );
    }

    // 決まった手順: 変わったファイルをツール自身が確かめ、変わっていればビルドする
    const after = await snapshotApp(paths.app);
    run.changedFiles = diffSnapshots(before, after);
    if (before.size >= MAX_SNAPSHOT_ENTRIES || after.size >= MAX_SNAPSHOT_ENTRIES) {
      this.addItem(id, run, 'info', `app/ のファイルが ${MAX_SNAPSHOT_ENTRIES} 個を超えているので、変わったファイルを確かめきれません。ビルドし直します。`);
    } else if (run.changedFiles.length === 0) {
      this.addItem(id, run, 'info', 'app/ のファイルは変わっていません。');
      return;
    }
    if (run.changedFiles.length > 0) {
      this.addItem(id, run, 'changes', `変わったファイル: ${run.changedFiles.slice(0, 50).map((c) => c.file).join('、')}${run.changedFiles.length > 50 ? ` ほか ${run.changedFiles.length - 50} 個` : ''}`);
    }
    const build = await this.store.build(id, { byRun: true });
    run.build = { ok: build.ok, errorCount: build.errors?.length ?? 0 };
    if (build.ok) {
      this.addItem(id, run, 'build-ok', 'ビルドに成功しました。試す画面に反映しました。');
    } else {
      this.addItem(id, run, 'build-failed', 'ビルドに失敗しました。試す画面は、前にビルドできた版のままです。詳細の欄で場所を確かめ、直す依頼を送ってください。');
    }
    this.log(`作る AI の実行が終わりました: ${id}(${run.status}、変わったファイル ${run.changedFiles.length} 個)`);
  }

  failureText(result, exit) {
    const label = this.connection.label;
    if (result && !result.ok) {
      if (result.subtype === 'error_max_turns') return `やりとりの回数の上限(${MAX_TURNS} 回)に達して止まりました。依頼を小さく分けて送ってください。`;
      if (result.subtype === 'error_max_budget_usd') return `費用の上限(${this.maxBudgetUsd} ドル)に達して止まりました。`;
      return `${label} が失敗しました: ${result.text || result.subtype || '理由はわかりません'}`;
    }
    const how = exit.signal ? `シグナル ${exit.signal}` : `終了コード ${exit.code}`;
    const detail = exit.stderrTail ? `\n${exit.stderrTail.slice(-1000)}` : '';
    return `${label} が途中で終わりました(${how})。${detail}`;
  }

  cancel(id, runId) {
    const active = this.active.get(id);
    if (!active || active.run.id !== runId || active.exited) return null;
    if (!active.cancelRequested) {
      active.cancelRequested = true;
      this.addItem(id, active.run, 'info', '中断しています…');
      active.handle?.stop('cancel');
    }
    return structuredClone(active.run);
  }

  // Studio のプロセスが終わる直前(SIGHUP や例外で、closeAll を待てないとき)。同期で強制終了する
  killAllSync() {
    for (const active of this.active.values()) active.handle?.kill();
  }

  // Studio を止めるとき。動いている作る AI も止め、終わるまで(上限つきで)待つ
  async closeAll() {
    this.closing = true;
    const waits = [];
    for (const active of this.active.values()) {
      // 起動の前なら、起動した直後に止まる(execute の中で見る)
      active.cancelRequested = true;
      active.handle?.stop('cancel');
      waits.push(active.done);
    }
    const limit = STOP_STEPS_MS.interrupt + STOP_STEPS_MS.terminate + 3000;
    await Promise.race([Promise.allSettled(waits), new Promise((resolve) => setTimeout(resolve, limit).unref())]);
  }
}
