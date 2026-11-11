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

  const children = new Set();
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
    let timedOut = false;
    let timer = null;
    const done = (error, stdout, stderr) => {
      if (timer) clearTimeoutImpl(timer);
      if (child) children.delete(child);
      const latencyMs = now() - startedAt;
      const out = stdout == null ? '' : String(stdout);
      const err = stderr == null ? '' : String(stderr);
      if (!error) {
        settle(lane, job, {
          ok: true, code: 0, signal: null, stdout: out, stderr: err,
          timedOut: false, truncated: false, latencyMs, queuedMs, error: null,
        });
        return;
      }
      const truncated = error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
      const exitCode = Number.isInteger(error.code) ? error.code : null;
      const wasTimeout = timedOut && !truncated;
      let errorInfo = null;
      if (truncated) errorInfo = { code: 'max_output', message: `Output exceeded ${job.maxOutputBytes} bytes` };
      else if (wasTimeout) errorInfo = { code: 'timeout', message: `Timed out after ${job.timeoutMs} ms` };
      else if (closed) errorInfo = { code: 'shutdown', message: 'Killed during shutdown' };
      else if (exitCode == null && error.signal) errorInfo = { code: 'signal', message: `Terminated by ${error.signal}` };
      else if (exitCode == null) errorInfo = { code: String(error.code || 'spawn_failed'), message: 'Process could not be run' };
      settle(lane, job, {
        ok: false,
        code: exitCode,
        signal: error.signal || null,
        stdout: out,
        stderr: err,
        timedOut: wasTimeout,
        truncated,
        latencyMs,
        queuedMs,
        error: errorInfo,
      });
    };

    try {
      child = execFileImpl(job.file, job.args, {
        cwd: job.cwd,
        env: job.env,
        encoding: 'utf8',
        maxBuffer: job.maxOutputBytes,
        windowsHide: true,
        shell: false,
      }, done);
    } catch (error) {
      done(Object.assign(new Error('spawn failed'), { code: error?.code || 'spawn_failed' }), '', '');
      return;
    }
    if (job.settled) return; // the callback ran synchronously
    if (child) children.add(child);
    timer = setTimeoutImpl(() => {
      timedOut = true;
      try {
        child?.kill(killSignal);
      } catch {}
    }, job.timeoutMs);
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

  // Kill every running child and fail every queued call. After this the
  // runner refuses new work.
  function killAll(signal = killSignal) {
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
    let killed = 0;
    for (const child of children) {
      try {
        child.kill(signal);
        killed += 1;
      } catch {}
    }
    return killed;
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

  return { run, killAll, status, lanes: Object.freeze(Object.keys(laneConfig)) };
}

module.exports = { createExec, DEFAULT_LANES };
