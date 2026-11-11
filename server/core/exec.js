'use strict';

// The one async process runner. Every child process Mission Control starts for
// a read or a bounded action goes through here:
//   - spawn with an argv array, never a shell string;
//   - a per-call timeout and a maximum output size;
//   - named lanes with concurrency limits (OpenClaw corrupts its own state
//     under parallel CLI calls, so its lane runs one call at a time);
//   - single flight by key, so identical concurrent reads share one child;
//   - every command runs in its own process group; timeout and shutdown signal
//     the whole group (TERM, then KILL), and a lane slot is freed only when the
//     group is verified gone. If that cannot be verified the lane is
//     quarantined: no new command starts on it, calls fail with
//     lane_quarantined, drain() is false and /api/health shows it.
// A call resolves to a typed result and never throws for a non-zero exit, a
// timeout, a missing binary, a full queue (lane_busy) or a quarantined lane. It throws only for programming
// errors (bad argv, unknown lane, shell requested).

const childProcess = require('child_process');

const DEFAULT_LANES = Object.freeze({
  openclaw: { concurrency: 1, queueTimeoutMs: 30_000 },
  gbrain: { concurrency: 2, queueTimeoutMs: 60_000 },
  hermes: { concurrency: 2, queueTimeoutMs: 30_000 },
  default: { concurrency: 4, queueTimeoutMs: 60_000 },
  // User-initiated lookups (search boxes and the like). Kept apart from the
  // lanes scheduled probes use, with a small bounded queue: when it is full a
  // call fails at once with lane_busy instead of piling up.
  lookup: { concurrency: 2, queueTimeoutMs: 10_000, maxQueue: 4 },
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

function defaultSignalGroup(pgid, signal) {
  process.kill(-pgid, signal);
}

// Gone only on ESRCH. Success means a member is alive; EPERM means a member
// exists that this process may not signal. Neither is "gone".
function defaultVerifyGroupGone(pgid) {
  try {
    process.kill(-pgid, 0);
    return false;
  } catch (error) {
    return error?.code === 'ESRCH';
  }
}

function createExec({
  // Test seam: execFile(file, args, options, callback). When given, the
  // runner uses it instead of spawning a process group.
  execFileImpl = null,
  lanes = {},
  now = Date.now,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
  defaultTimeoutMs = DEFAULT_TIMEOUT_MS,
  defaultMaxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
  killSignal = 'SIGTERM',
  // Wait after SIGTERM before SIGKILL, and after SIGKILL before quarantine.
  killGraceMs = 2_000,
  spawnImpl = childProcess.spawn,
  signalGroup = defaultSignalGroup,
  verifyGroupGone = defaultVerifyGroupGone,
  // How often a lingering group is re-verified, how long closed-group pipes
  // may stay open, and how often a quarantined lane is rechecked.
  groupPollMs = 25,
  stdioGraceMs = 250,
  quarantineRecheckMs = 5_000,
} = {}) {
  // `lanes` adds lanes or overrides fields of the built-in ones:
  //   { name: { concurrency, queueTimeoutMs?, maxQueue? } }
  // maxQueue bounds the waiting calls (0 = never queue); omitted = unbounded.
  const laneConfig = { ...DEFAULT_LANES };
  for (const [name, cfg] of Object.entries(lanes || {})) laneConfig[name] = { ...DEFAULT_LANES[name], ...cfg };
  const laneState = new Map();
  for (const [name, cfg] of Object.entries(laneConfig)) {
    const concurrency = Number(cfg?.concurrency);
    if (!Number.isInteger(concurrency) || concurrency < 1) {
      throw new TypeError(`exec lane ${name}: concurrency must be a positive integer`);
    }
    const maxQueue = cfg.maxQueue == null ? null : Number(cfg.maxQueue);
    if (maxQueue !== null && (!Number.isInteger(maxQueue) || maxQueue < 0)) {
      throw new TypeError(`exec lane ${name}: maxQueue must be a non-negative integer`);
    }
    laneState.set(name, {
      name,
      concurrency,
      queueTimeoutMs: Number(cfg.queueTimeoutMs) > 0 ? Number(cfg.queueTimeoutMs) : 60_000,
      maxQueue,
      running: 0,
      queue: [],
      completed: 0,
      failed: 0,
      maxObservedRunning: 0,
      quarantined: new Set(),
      rejectedBusy: 0,
    });
  }

  // Process-group mode is the real runner. An injected execFileImpl (tests)
  // has no real process group, so signalling and verification fall back to
  // the injected child object and its callback.
  const groupMode = !execFileImpl && process.platform !== 'win32';
  const legacyExecFile = execFileImpl || childProcess.execFile;

  const children = new Map(); // tracked command -> terminate(reason)
  const inFlightByKey = new Map();
  let closed = false;

  function later(fn, ms, { keepAlive = true } = {}) {
    const handle = setTimeoutImpl(fn, ms);
    if (!keepAlive) handle?.unref?.();
    return handle;
  }

  function quarantineFailure(lane, extra = {}) {
    return failure('lane_quarantined',
      `The ${lane.name} lane is quarantined: an earlier command could not be verified as exited`, extra);
  }

  function pump(lane) {
    if (lane.quarantined.size) return;
    while (lane.running < lane.concurrency && lane.queue.length) {
      const job = lane.queue.shift();
      if (job.queueTimer) clearTimeoutImpl(job.queueTimer);
      lane.running += 1;
      lane.maxObservedRunning = Math.max(lane.maxObservedRunning, lane.running);
      start(lane, job);
    }
  }

  // Resolve the caller's promise. Does NOT free the lane slot.
  function resolveJob(lane, job, result) {
    if (job.settled) return;
    job.settled = true;
    if (result.ok) lane.completed += 1;
    else lane.failed += 1;
    job.resolve(result);
  }

  function failQueued(lane, makeResult) {
    for (const job of lane.queue.splice(0)) {
      if (job.queueTimer) clearTimeoutImpl(job.queueTimer);
      job.settled = true;
      lane.failed += 1;
      job.resolve(makeResult(job));
    }
  }

  function start(lane, job) {
    const startedAt = now();
    const queuedMs = startedAt - job.enqueuedAt;
    let slotHeld = true;
    const releaseSlot = () => {
      if (!slotHeld) return;
      slotHeld = false;
      lane.running -= 1;
      pump(lane);
    };
    if (closed) {
      resolveJob(lane, job, failure('shutdown', 'Process runner is shut down', { queuedMs }));
      releaseSlot();
      return;
    }

    // What has been observed about this command. The lane slot is freed only
    // by complete(), and complete() runs only when the whole process group is
    // verified gone (never merely because the direct child exited).
    const st = {
      child: null,
      pgid: null,
      leaderExited: false,
      stdioClosed: false,
      closeWaitOver: false,
      gone: false,
      code: null,
      signal: null,
      spawnError: null,
      truncated: false,
      out: '',
      err: '',
      quarantine: null,
    };
    // Set when this runner decides to end the command. The classification of
    // the result depends on it, never on the exit code: a child that exits 0
    // from its SIGTERM handler still timed out.
    let killReason = null; // 'timeout' | 'shutdown' | 'max_output'
    let timer = null;
    let pollTimer = null;
    let closeTimer = null;
    let recheckTimer = null;
    const killTimers = [];
    let completed = false;

    const clearTimers = () => {
      if (timer) clearTimeoutImpl(timer);
      if (pollTimer) clearTimeoutImpl(pollTimer);
      if (closeTimer) clearTimeoutImpl(closeTimer);
      if (recheckTimer) clearTimeoutImpl(recheckTimer);
      while (killTimers.length) clearTimeoutImpl(killTimers.pop());
    };

    const buildResult = (override) => {
      const base = {
        ok: false, code: st.code, signal: st.signal, stdout: st.out, stderr: st.err,
        timedOut: killReason === 'timeout', truncated: st.truncated,
        latencyMs: now() - startedAt, queuedMs, error: null,
      };
      if (override) return { ...base, error: override };
      if (killReason === 'timeout') return { ...base, error: { code: 'timeout', message: `Timed out after ${job.timeoutMs} ms` } };
      if (killReason === 'shutdown') return { ...base, error: { code: 'shutdown', message: 'Killed during shutdown' } };
      if (st.truncated) return { ...base, error: { code: 'max_output', message: `Output exceeded ${job.maxOutputBytes} bytes` } };
      if (st.spawnError) return { ...base, code: null, error: { code: String(st.spawnError), message: 'Process could not be run' } };
      if (st.code === 0) return { ...base, ok: true };
      if (st.code == null && st.signal) return { ...base, error: { code: 'signal', message: `Terminated by ${st.signal}` } };
      if (st.code == null) return { ...base, error: { code: 'spawn_failed', message: 'Process could not be run' } };
      return base;
    };

    // True only when the process group is verified gone. An exception from the
    // verifier is "not verified".
    const checkGone = () => {
      if (st.gone) return true;
      if (!groupMode) return false; // legacy: only the callback sets st.gone
      if (st.pgid == null) return false;
      try {
        st.gone = verifyGroupGone(st.pgid) === true;
      } catch {
        st.gone = false;
      }
      return st.gone;
    };

    // Signal the whole group. Never signals a group already verified gone
    // (its id may have been reused).
    const sendSignal = (signal) => {
      if (st.gone) return;
      try {
        if (groupMode) {
          if (st.pgid != null) signalGroup(st.pgid, signal);
        } else {
          st.child?.kill(signal);
        }
      } catch {}
    };

    const complete = () => {
      if (completed) return;
      completed = true;
      clearTimers();
      children.delete(st);
      if (groupMode && st.child && !st.stdioClosed) {
        // Someone outside the group still holds the pipes; stop reading.
        for (const stream of [st.child.stdout, st.child.stderr, st.child.stdin]) {
          try {
            stream?.destroy();
          } catch {}
        }
      }
      resolveJob(lane, job, buildResult());
      if (st.quarantine) {
        lane.quarantined.delete(st.quarantine);
        st.quarantine = null;
      }
      releaseSlot();
    };

    const evaluate = () => {
      if (completed || !st.leaderExited) return;
      if (!checkGone()) {
        if (!pollTimer && !st.quarantine) {
          pollTimer = later(() => {
            pollTimer = null;
            evaluate();
          }, groupPollMs);
        }
        return;
      }
      if (!st.stdioClosed && !st.closeWaitOver) {
        // Group gone; give the pipes a moment to deliver their last bytes.
        if (!closeTimer) {
          closeTimer = later(() => {
            st.closeWaitOver = true;
            evaluate();
          }, stdioGraceMs);
        }
        return;
      }
      complete();
    };

    // Exit could not be verified: answer the caller, keep the slot and the
    // tracking, close the lane, and keep rechecking in the background.
    const quarantine = () => {
      if (completed || st.quarantine) return;
      st.quarantine = { pid: st.pgid ?? st.child?.pid ?? null, reason: killReason, since: new Date(now()).toISOString() };
      lane.quarantined.add(st.quarantine);
      resolveJob(lane, job, buildResult({ code: 'kill_unverified', message: 'Process group could not be verified as exited after SIGKILL' }));
      failQueued(lane, (queuedJob) => quarantineFailure(lane, { queuedMs: now() - queuedJob.enqueuedAt }));
      const recheck = () => {
        recheckTimer = null;
        if (completed) return;
        if (checkGone()) {
          st.leaderExited = true;
          st.closeWaitOver = true;
          complete();
          return;
        }
        recheckTimer = later(recheck, quarantineRecheckMs, { keepAlive: false });
      };
      recheckTimer = later(recheck, quarantineRecheckMs, { keepAlive: false });
    };

    // Bounded TERM -> KILL escalation against the whole process group. The
    // escalation timers keep the event loop alive: the group must not outlive
    // this process just because the direct child already exited.
    const terminate = (reason, { immediateKill = false } = {}) => {
      if (killReason || completed) return;
      if (st.leaderExited && checkGone()) return; // already over; completing
      killReason = reason;
      if (timer) clearTimeoutImpl(timer);
      sendSignal(immediateKill ? 'SIGKILL' : killSignal);
      if (completed) return; // a fake child may call back synchronously
      killTimers.push(later(() => {
        if (completed) return;
        if (st.leaderExited && checkGone()) return evaluate();
        sendSignal('SIGKILL');
        if (completed) return undefined;
        killTimers.push(later(() => {
          if (completed) return;
          if (st.leaderExited && checkGone()) evaluate();
          else quarantine();
        }, killGraceMs));
        return undefined;
      }, killGraceMs));
    };

    const onSpawnFailure = (code) => {
      st.spawnError = code || 'spawn_failed';
      st.leaderExited = true;
      st.stdioClosed = true;
      st.gone = true;
      complete();
    };

    if (!groupMode) {
      // Injected execFile(file, args, options, callback): the callback is the
      // one proof of exit.
      const done = (error, stdout, stderr) => {
        if (completed) return;
        st.out = stdout == null ? '' : String(stdout);
        st.err = stderr == null ? '' : String(stderr);
        if (!error) st.code = 0;
        else if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') st.truncated = true;
        else if (Number.isInteger(error.code)) st.code = error.code;
        else if (!error.signal) st.spawnError = error.code || 'spawn_failed';
        st.signal = error?.signal || null;
        st.leaderExited = true;
        st.stdioClosed = true;
        st.gone = true;
        complete();
      };
      try {
        st.child = legacyExecFile(job.file, job.args, {
          cwd: job.cwd,
          env: job.env,
          encoding: 'utf8',
          maxBuffer: job.maxOutputBytes,
          killSignal: 'SIGKILL',
          windowsHide: true,
          shell: false,
        }, done);
      } catch (error) {
        onSpawnFailure(error?.code);
        return;
      }
      if (completed) return; // the callback ran synchronously
    } else {
      let child;
      try {
        // detached: the child becomes the leader of a new session and process
        // group (setsid), so the whole tree can be signalled and verified.
        child = spawnImpl(job.file, job.args, {
          cwd: job.cwd,
          env: job.env,
          detached: true,
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
          shell: false,
        });
      } catch (error) {
        onSpawnFailure(error?.code);
        return;
      }
      st.child = child;
      st.pgid = Number.isInteger(child.pid) ? child.pid : null;
      const chunks = { out: [], err: [] };
      let bytes = 0;
      const collect = (name) => (chunk) => {
        if (st.truncated) return;
        const room = job.maxOutputBytes - bytes;
        if (chunk.length > room) {
          if (room > 0) chunks[name].push(chunk.subarray(0, room));
          bytes = job.maxOutputBytes;
          st.out = Buffer.concat(chunks.out).toString('utf8');
          st.err = Buffer.concat(chunks.err).toString('utf8');
          st.truncated = true;
          terminate('max_output', { immediateKill: true });
          return;
        }
        bytes += chunk.length;
        chunks[name].push(chunk);
      };
      const flush = () => {
        if (st.truncated) return;
        st.out = Buffer.concat(chunks.out).toString('utf8');
        st.err = Buffer.concat(chunks.err).toString('utf8');
      };
      child.stdout?.on('data', collect('out'));
      child.stderr?.on('data', collect('err'));
      for (const stream of [child.stdin, child.stdout, child.stderr]) stream?.on('error', () => {});
      child.on('error', (error) => {
        // With no pid the process never started. With a pid this is a failed
        // signal or stdio error; exit handling is unchanged.
        if (st.pgid == null) onSpawnFailure(error?.code);
      });
      child.on('exit', (code, signal) => {
        st.code = Number.isInteger(code) ? code : null;
        st.signal = signal || null;
        st.leaderExited = true;
        flush();
        evaluate();
      });
      child.on('close', () => {
        st.stdioClosed = true;
        flush();
        evaluate();
      });
      if (completed) return;
    }
    children.set(st, terminate);
    timer = later(() => terminate('timeout'), job.timeoutMs, { keepAlive: false });
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
      if (lane.quarantined.size) {
        lane.failed += 1;
        resolve(quarantineFailure(lane));
        return;
      }
      if (lane.maxQueue !== null && lane.running >= lane.concurrency && lane.queue.length >= lane.maxQueue) {
        lane.failed += 1;
        lane.rejectedBusy += 1;
        resolve(failure('lane_busy', `The ${laneName} lane is full (${lane.concurrency} running, ${lane.queue.length} waiting)`));
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

  // Terminate every tracked process group (TERM, then KILL after killGraceMs)
  // and fail every queued call. After this the runner refuses new work.
  // Returns the number of commands signalled; drain() tells when they are gone.
  function killAll() {
    closed = true;
    for (const lane of laneState.values()) {
      failQueued(lane, (job) => failure('shutdown', 'Process runner is shut down', { queuedMs: now() - job.enqueuedAt }));
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

  // Resolves true when every process group is verified gone, false after
  // timeoutMs (always false while a lane is quarantined). The poll keeps the
  // event loop alive (it is bounded by timeoutMs): shutdown awaits this after
  // the server closed, and an unref'd poll let the process exit as the last
  // child went, before the caller heard the verdict.
  function drain(timeoutMs = 3 * killGraceMs) {
    const deadline = now() + timeoutMs;
    return new Promise((resolve) => {
      const check = () => {
        if (children.size === 0) return resolve(true);
        if (now() >= deadline) return resolve(false);
        later(check, 25);
        return undefined;
      };
      check();
    });
  }

  function status() {
    const out = {};
    const quarantined = [];
    for (const lane of laneState.values()) {
      out[lane.name] = {
        concurrency: lane.concurrency,
        running: lane.running,
        queued: lane.queue.length,
        completed: lane.completed,
        failed: lane.failed,
        maxObservedRunning: lane.maxObservedRunning,
        maxQueue: lane.maxQueue,
        rejectedBusy: lane.rejectedBusy,
        quarantined: lane.quarantined.size > 0,
        unverified: [...lane.quarantined].map((entry) => ({ ...entry })),
      };
      if (lane.quarantined.size) quarantined.push(lane.name);
    }
    return { closed, children: children.size, quarantined, lanes: out };
  }

  return { run, killAll, drain, status, lanes: Object.freeze(Object.keys(laneConfig)) };
}

module.exports = { createExec, DEFAULT_LANES };
