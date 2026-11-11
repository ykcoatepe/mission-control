'use strict';

// Owns every background refresh timer. Area code registers a source (or a
// plain task) with an interval; nothing else should call setInterval.
//
//   scheduler.register(source, { intervalMs, jitterMs });
//   scheduler.register({ id: 'snapshot-writer', run: async () => {...} }, { intervalMs });
//   scheduler.start();  scheduler.pause(id);  scheduler.resume(id);  scheduler.stop();
//
// Runs never overlap: the next run is armed only after the current one
// settles. The first run starts after a random delay up to jitterMs so
// sources do not all spawn at boot. Timers are unref'd, so the scheduler
// never keeps the process alive on its own.

function createScheduler({
  now = Date.now,
  random = Math.random,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
  logger = console,
} = {}) {
  const jobs = new Map();
  let running = false;
  let stopped = false;

  function register(target, { intervalMs, jitterMs, runOnStart = true } = {}) {
    const id = target?.id;
    if (typeof id !== 'string' || !id) throw new TypeError('scheduler.register: target needs an id');
    if (jobs.has(id)) throw new Error(`scheduler.register: "${id}" is already registered`);
    const run = typeof target.run === 'function'
      ? () => target.run()
      : typeof target.refresh === 'function'
        ? () => target.refresh()
        : null;
    if (!run) throw new TypeError(`scheduler.register(${id}): target needs run() or refresh()`);
    if (!(Number(intervalMs) > 0)) throw new TypeError(`scheduler.register(${id}): intervalMs must be positive`);
    const job = {
      id,
      target,
      run,
      intervalMs: Number(intervalMs),
      jitterMs: Number.isFinite(jitterMs) ? Math.max(0, jitterMs) : Math.min(Number(intervalMs), 5_000),
      runOnStart,
      timer: null,
      paused: false,
      inRun: false,
      runs: 0,
      errors: 0,
      lastRunAt: null,
      lastDurationMs: null,
      lastError: null,
      nextRunAt: null,
    };
    jobs.set(id, job);
    if (running) arm(job, job.runOnStart ? Math.floor(random() * job.jitterMs) : job.intervalMs);
    return id;
  }

  function arm(job, delayMs) {
    if (stopped || job.paused) return;
    if (job.timer) clearTimeoutImpl(job.timer);
    job.nextRunAt = now() + delayMs;
    job.timer = setTimeoutImpl(() => {
      job.timer = null;
      execute(job);
    }, delayMs);
    job.timer?.unref?.();
  }

  async function execute(job) {
    if (stopped || job.paused || job.inRun) return;
    job.inRun = true;
    job.nextRunAt = null;
    const startedAt = now();
    try {
      await job.run();
      job.lastError = null;
    } catch (error) {
      job.errors += 1;
      job.lastError = String(error?.message || error).split('\n')[0].slice(0, 300);
      logger?.warn?.(`[scheduler:${job.id}] run failed: ${job.lastError}`);
    } finally {
      job.inRun = false;
      job.runs += 1;
      job.lastRunAt = new Date(startedAt).toISOString();
      job.lastDurationMs = now() - startedAt;
      if (running) arm(job, job.intervalMs);
    }
  }

  function start() {
    if (running || stopped) return;
    running = true;
    for (const job of jobs.values()) {
      arm(job, job.runOnStart ? Math.floor(random() * job.jitterMs) : job.intervalMs);
    }
  }

  function pause(id) {
    const targets = id ? [jobs.get(id)].filter(Boolean) : [...jobs.values()];
    for (const job of targets) {
      job.paused = true;
      if (job.timer) clearTimeoutImpl(job.timer);
      job.timer = null;
      job.nextRunAt = null;
    }
  }

  function resume(id) {
    const targets = id ? [jobs.get(id)].filter(Boolean) : [...jobs.values()];
    for (const job of targets) {
      if (!job.paused) continue;
      job.paused = false;
      if (running && !job.inRun) arm(job, 0);
    }
  }

  function stop() {
    stopped = true;
    running = false;
    for (const job of jobs.values()) {
      if (job.timer) clearTimeoutImpl(job.timer);
      job.timer = null;
      job.nextRunAt = null;
    }
  }

  // Run one job now (outside its timer) without overlapping a running run.
  async function runNow(id) {
    const job = jobs.get(id);
    if (!job) throw new Error(`scheduler.runNow: unknown job "${id}"`);
    if (job.inRun) return false;
    if (job.timer) clearTimeoutImpl(job.timer);
    job.timer = null;
    await execute(job);
    return true;
  }

  function status() {
    return {
      running,
      stopped,
      jobs: [...jobs.values()].map((job) => ({
        id: job.id,
        intervalMs: job.intervalMs,
        paused: job.paused,
        inRun: job.inRun,
        runs: job.runs,
        errors: job.errors,
        lastRunAt: job.lastRunAt,
        lastDurationMs: job.lastDurationMs,
        lastError: job.lastError,
        nextRunAt: job.nextRunAt == null ? null : new Date(job.nextRunAt).toISOString(),
        source: typeof job.target.status === 'function' ? job.target.status() : null,
      })),
    };
  }

  return { register, start, pause, resume, stop, runNow, status };
}

module.exports = { createScheduler };
