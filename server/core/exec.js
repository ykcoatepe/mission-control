'use strict';

// The one async process runner. Every child process Mission Control starts for
// a read or a bounded action goes through here:
//   - execFile with an argv array, never a shell string;
//   - a per-call timeout and a maximum output size;
//   - named lanes with concurrency limits (OpenClaw corrupts its own state
//     under parallel CLI calls, so its lane runs one call at a time);
//   - single flight by key, so identical concurrent reads share one child;
//   - every running child is tracked and killed on shutdown.
// A call resolves to a typed result and never throws for a non-zero exit, a
// timeout, a missing binary or a full queue. It throws only for programming
// errors (bad argv, unknown lane, shell requested).

const childProcess = require('child_process');

const DEFAULT_LANES = Object.freeze({
  openclaw: { concurrency: 1, queueTimeoutMs: 30_000 },
  gbrain: { concurrency: 2, queueTimeoutMs: 60_000 },
  hermes: { concurrency: 2, queueTimeoutMs: 30_000 },
  default: { concurrency: 4, queueTimeoutMs: 60_000 },
});

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_OUTPUT_BYTES = 10 * 1024 * 1024;

function failure(code, message, extra = {}) {
  return {
    ok: false,
    code: null,
    signal: null,
    stdout: '',
    stderr: '',
    timedOut: false,
    truncated: false,
    latencyMs: 0,
    queuedMs: 0,
    error: { code, message },
    ...extra,
  };
}

function createExec({
  execFileImpl = childProcess.execFile,
  lanes = {},
  now = Date.now,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
  defaultTimeoutMs = DEFAULT_TIMEOUT_MS,
  defaultMaxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
  killSignal = 'SIGTERM',
  // Wait after SIGTERM before SIGKILL, and after SIGKILL before giving up.
  killGraceMs = 2_000,
} = {}) {
  const laneConfig = { ...DEFAULT_LANES, ...lanes };
  const laneState = new Map();
  for (const [name, cfg] of Object.entries(laneConfig)) {
    const concurrency = Number(cfg?.concurrency);
    if (!Number.isInteger(concurrency) || concurrency < 1) {
      throw new TypeError(`exec lane ${name}: concurrency must be a positive integer`);
    }
    laneState.set(name, {
      name,
      concurrency,
      queueTimeoutMs: Number(cfg.queueTimeoutMs) > 0 ? Number(cfg.queueTimeoutMs) : 60_000,
      running: 0,
      queue: [],
      completed: 0,
      failed: 0,
      maxObservedRunning: 0,
    });
  }

  const children = new Map(); // child -> terminate(reason)
  const inFlightByKey = new Map();
  let closed = false;

  function pump(lane) {
    while (lane.running < lane.concurrency && lane.queue.length) {
      const job = lane.queue.shift();
      if (job.queueTimer) clearTimeoutImpl(job.queueTimer);
      lane.running += 1;
      lane.maxObservedRunning = Math.max(lane.maxObservedRunning, lane.running);
      start(lane, job);
    }
  }

  function settle(lane, job, result) {
    if (job.settled) return;
    job.settled = true;
    lane.running -= 1;
    if (result.ok) lane.completed += 1;
    else lane.failed += 1;
    job.resolve(result);
    pump(lane);
  }

  function start(lane, job) {
    const startedAt = now();
    const queuedMs = startedAt - job.enqueuedAt;
    if (closed) {
      settle(lane, job, failure('shutdown', 'Process runner is shut down', { queuedMs }));
      return;
    }
    let child;
    let timer = null;
    // Set when this runner decides to end the child. The classification of
    // the result depends on it, never on the exit code: a child that exits 0
    // from its SIGTERM handler still timed out.
    let killReason = null; // 'timeout' | 'shutdown'
    const killTimers = [];
    let exited = false;

    const clearTimers = () => {
      if (timer) clearTimeoutImpl(timer);
      while (killTimers.length) clearTimeoutImpl(killTimers.pop());
    };

    const killedResult = (out, err, extra = {}) => ({
      ok: false,
      code: null,
      signal: null,
      stdout: out,
      stderr: err,
      timedOut: killReason === 'timeout',
      truncated: false,
      latencyMs: now() - startedAt,
      queuedMs,
      error: killReason === 'timeout'
        ? { code: 'timeout', message: `Timed out after ${job.timeoutMs} ms` }
        : { code: 'shutdown', message: 'Killed during shutdown' },
      ...extra,
    });

    const done = (error, stdout, stderr) => {
      clearTimers();
      if (child) children.delete(child);
      if (job.settled) return;
      const latencyMs = now() - startedAt;
      const out = stdout == null ? '' : String(stdout);
      const err = stderr == null ? '' : String(stderr);
      if (killReason) {
        settle(lane, job, killedResult(out, err, {
          code: Number.isInteger(error?.code) ? error.code : (error ? null : 0),
          signal: error?.signal || null,
          latencyMs,
        }));
        return;
      }
      if (!error) {
        settle(lane, job, {
          ok: true, code: 0, signal: null, stdout: out, stderr: err,
          timedOut: false, truncated: false, latencyMs, queuedMs, error: null,
        });
        return;
      }
      const truncated = error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
      const exitCode = Number.isInteger(error.code) ? error.code : null;
      let errorInfo = null;
      if (truncated) errorInfo = { code: 'max_output', message: `Output exceeded ${job.maxOutputBytes} bytes` };
      else if (exitCode == null && error.signal) errorInfo = { code: 'signal', message: `Terminated by ${error.signal}` };
      else if (exitCode == null) errorInfo = { code: String(error.code || 'spawn_failed'), message: 'Process could not be run' };
      settle(lane, job, {
        ok: false,
        code: exitCode,
        signal: error.signal || null,
        stdout: out,
        stderr: err,
        timedOut: false,
        truncated,
        latencyMs,
        queuedMs,
        error: errorInfo,
      });
    };

    // Bounded TERM -> KILL escalation. The lane is released when the child's
    // exit is observed (the normal callback, or the 'exit' event when a
    // grandchild keeps the pipes open). If even SIGKILL cannot be verified
    // within the grace period, the call settles with kill_unverified so the
    // lane is never held forever.
    const terminate = (reason) => {
      if (killReason || job.settled) return;
      killReason = reason;
      if (timer) clearTimeoutImpl(timer);
      try {
        child?.kill(killSignal);
      } catch {}
      const escalate = setTimeoutImpl(() => {
        if (job.settled) return;
        if (!exited) {
          try {
            child?.kill('SIGKILL');
          } catch {}
        }
        const giveUp = setTimeoutImpl(() => {
          if (job.settled) return;
          if (child) children.delete(child);
          settle(lane, job, killedResult('', '', {
            error: exited
              ? (killReason === 'timeout'
                ? { code: 'timeout', message: `Timed out after ${job.timeoutMs} ms` }
                : { code: 'shutdown', message: 'Killed during shutdown' })
              : { code: 'kill_unverified', message: 'Child did not exit after SIGKILL' },
          }));
        }, killGraceMs);
        giveUp?.unref?.();
        killTimers.push(giveUp);
      }, killGraceMs);
      escalate?.unref?.();
      killTimers.push(escalate);
    };

    try {
      child = execFileImpl(job.file, job.args, {
        cwd: job.cwd,
        env: job.env,
        encoding: 'utf8',
        maxBuffer: job.maxOutputBytes,
        // Used by execFile only when maxBuffer is exceeded.
        killSignal: 'SIGKILL',
        windowsHide: true,
        shell: false,
      }, done);
    } catch (error) {
      done(Object.assign(new Error('spawn failed'), { code: error?.code || 'spawn_failed' }), '', '');
      return;
    }
    if (job.settled) return; // the callback ran synchronously
    if (child) {
      children.set(child, terminate);
      if (typeof child.once === 'function') {
        child.once('exit', () => {
          exited = true;
          if (!killReason) return;
          // Killed and exited: give the close callback a moment to deliver
          // output, then release the lane regardless.
          const closeWait = setTimeoutImpl(() => {
            if (job.settled) return;
            children.delete(child);
            settle(lane, job, killedResult('', ''));
          }, 250);
          closeWait?.unref?.();
          killTimers.push(closeWait);
        });
      }
    }
    timer = setTimeoutImpl(() => terminate('timeout'), job.timeoutMs);
    timer?.unref?.();
  }

  function run(file, args = [], options = {}) {
    if (typeof file !== 'string' || !file) throw new TypeError('exec.run: file must be a non-empty string');
    if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string')) {
      throw new TypeError('exec.run: args must be an array of strings');
    }
    if (options.shell) throw new TypeError('exec.run: shell execution is not allowed');
    const laneName = options.lane || 'default';
    const lane = laneState.get(laneName);
    if (!lane) throw new TypeError(`exec.run: unknown lane "${laneName}"`);

    const key = options.key ? `${laneName}\u0000${options.key}` : null;
    if (key && inFlightByKey.has(key)) return inFlightByKey.get(key);

    const promise = new Promise((resolve) => {
      if (closed) {
        resolve(failure('shutdown', 'Process runner is shut down'));
        return;
      }
      const job = {
        file,
        args: args.slice(),
        cwd: options.cwd,
        env: options.env,
        timeoutMs: Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : defaultTimeoutMs,
        maxOutputBytes: Number(options.maxOutputBytes) > 0 ? Number(options.maxOutputBytes) : defaultMaxOutputBytes,
        enqueuedAt: now(),
        resolve,
        settled: false,
        queueTimer: null,
      };
      const queueTimeoutMs = Number(options.queueTimeoutMs) > 0 ? Number(options.queueTimeoutMs) : lane.queueTimeoutMs;
      lane.queue.push(job);
      if (lane.running >= lane.concurrency) {
        job.queueTimer = setTimeoutImpl(() => {
          const index = lane.queue.indexOf(job);
          if (index === -1) return;
          lane.queue.splice(index, 1);
          lane.failed += 1;
          job.settled = true;
          resolve(failure('queue_timeout', `Waited ${queueTimeoutMs} ms for the ${laneName} lane`, {
            timedOut: true,
            queuedMs: now() - job.enqueuedAt,
          }));
        }, queueTimeoutMs);
        job.queueTimer?.unref?.();
      }
      pump(lane);
    });

    if (key) {
      inFlightByKey.set(key, promise);
      promise.then(() => {
        if (inFlightByKey.get(key) === promise) inFlightByKey.delete(key);
      });
    }
    return promise;
  }

  // Terminate every running child (TERM, then KILL after killGraceMs) and
  // fail every queued call. After this the runner refuses new work. Returns
  // the number of children signalled; drain() resolves when they are gone.
  function killAll() {
    closed = true;
    for (const lane of laneState.values()) {
      const queued = lane.queue.splice(0);
      for (const job of queued) {
        if (job.queueTimer) clearTimeoutImpl(job.queueTimer);
        job.settled = true;
        lane.failed += 1;
        job.resolve(failure('shutdown', 'Process runner is shut down', { queuedMs: now() - job.enqueuedAt }));
      }
    }
    let signalled = 0;
    for (const terminate of [...children.values()]) {
      try {
        terminate('shutdown');
        signalled += 1;
      } catch {}
    }
    return signalled;
  }

  // Resolves true when no child is left, false after timeoutMs.
  function drain(timeoutMs = 3 * killGraceMs) {
    const deadline = now() + timeoutMs;
    return new Promise((resolve) => {
      const check = () => {
        if (children.size === 0) return resolve(true);
        if (now() >= deadline) return resolve(false);
        const t = setTimeoutImpl(check, 25);
        t?.unref?.();
        return undefined;
      };
      check();
    });
  }

  function status() {
    const out = {};
    for (const lane of laneState.values()) {
      out[lane.name] = {
        concurrency: lane.concurrency,
        running: lane.running,
        queued: lane.queue.length,
        completed: lane.completed,
        failed: lane.failed,
        maxObservedRunning: lane.maxObservedRunning,
      };
    }
    return { closed, children: children.size, lanes: out };
  }

  return { run, killAll, drain, status, lanes: Object.freeze(Object.keys(laneConfig)) };
}

module.exports = { createExec, DEFAULT_LANES };
