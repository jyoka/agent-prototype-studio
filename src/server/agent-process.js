import { spawn, spawnSync } from 'node:child_process';
import readline from 'node:readline';

// 止めるときの間合い(ADR-0001): SIGINT、待って SIGTERM、最後にプロセスグループごと強制終了。
export const STOP_STEPS_MS = { interrupt: 3000, terminate: 3000 };
const STDERR_TAIL = 4000;
const STREAM_CLOSE_GRACE_MS = 2000;

function sendSignal(child, name) {
  try {
    if (process.platform === 'win32') {
      // Windows にはシグナルとプロセスグループがない。プロセスの木ごと止める
      const force = name === 'SIGKILL' ? ['/F'] : [];
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', ...force], { stdio: 'ignore', timeout: 5000, windowsHide: true });
    } else {
      // detached で起動したので、子が作ったプロセスにも届く
      process.kill(-child.pid, name);
    }
  } catch {
    // すでに終わっている
  }
}

// 作る AI を 1 回動かす。依頼の文は stdin で渡す。stdout の 1 行ごとに onMessage を呼ぶ。
// 返す done は、プロセスが終わり、出力を読み終えたら解決する。そのとき、プロセスグループに
// 残ったもの(作る AI が起動した子)も強制終了する。
export function startAgentProcess({ command, args, cwd, env, input, timeoutMs, onMessage, onInvalidLine = () => {} }) {
  let stopReason = null;
  let exited = false;
  let stderrTail = '';
  const timers = new Set();
  const later = (ms, fn) => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      fn();
    }, ms);
    timers.add(timer);
  };

  const child = spawn(command, args, {
    cwd,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
    windowsHide: true,
  });

  function stop(reason) {
    if (exited || stopReason) return;
    stopReason = reason;
    sendSignal(child, 'SIGINT');
    later(STOP_STEPS_MS.interrupt, () => {
      if (exited) return;
      sendSignal(child, 'SIGTERM');
      later(STOP_STEPS_MS.terminate, () => {
        if (!exited) sendSignal(child, 'SIGKILL');
      });
    });
  }

  const done = new Promise((resolve) => {
    let spawnError = null;
    let exitInfo = { code: null, signal: null };
    let resolved = false;
    const finish = () => {
      if (resolved) return;
      resolved = true;
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      // 本体が SIGINT で終わっても、SIGINT を無視する子が残り得る。親のいなくなった残りを止める
      if (child.pid !== undefined && process.platform !== 'win32') sendSignal(child, 'SIGKILL');
      resolve({ ...exitInfo, spawnError, stopReason, stderrTail: stderrTail.trim() });
    };

    child.on('error', (error) => {
      spawnError = error;
      exited = true;
      finish();
    });
    child.on('exit', (code, signal) => {
      exited = true;
      exitInfo = { code, signal };
      // 孫のプロセスが出力を握ったままでも、待ち続けない
      later(STREAM_CLOSE_GRACE_MS, () => {
        child.stdout.destroy();
        child.stderr.destroy();
        finish();
      });
    });
    child.on('close', () => {
      exited = true;
      finish();
    });
  });

  if (child.pid !== undefined) {
    later(timeoutMs, () => stop('timeout'));
  }

  const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  lines.on('line', (line) => {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      onInvalidLine(line.slice(0, 500));
      return;
    }
    onMessage(message);
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL);
  });
  // 依頼を書いたら閉じる。相手が先に終わったときの EPIPE は無視する
  child.stdin.on('error', () => {});
  child.stdin.end(input);

  // kill: Studio のプロセスが終わる直前に、同期で止めるとき
  return { done, stop, kill: () => child.pid !== undefined && sendSignal(child, 'SIGKILL'), pid: child.pid };
}
