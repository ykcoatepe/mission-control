const test = require('node:test');
const assert = require('node:assert/strict');

const { createScheduler } = require('../server/core/scheduler');

// Manual timer queue so tests control time.
function manualTimers() {
  let seq = 0;
  const timers = new Map();
  return {
    setTimeoutImpl(fn, ms) {
      seq += 1;
      const handle = { id: seq, ms, fn, unref() { this.unrefd = true; return this; } };
      timers.set(seq, handle);
      return handle;
    },
    clearTimeoutImpl(handle) {
      if (handle) timers.delete(handle.id);
    },
    pending: () => [...timers.values()],
    async fireAll() {
      const due = [...timers.values()];
      for (const handle of due) {
        timers.delete(handle.id);
        handle.fn();
      }
      await new Promise((r) => setImmediate(r));
    },
  };
}

const quiet = { warn() {}, log() {}, error() {} };

test('first run is jittered within jitterMs and timers are unref\'d', () => {
  const timers = manualTimers();
  const scheduler = createScheduler({ ...timers, random: () => 0.5, logger: quiet });
  scheduler.register({ id: 'a', run: async () => {} }, { intervalMs: 60_000, jitterMs: 2000 });
  scheduler.start();
  const [handle] = timers.pending();
  assert.equal(handle.ms, 1000);
  assert.equal(handle.unrefd, true);
});

test('runs never overlap: the next run is armed only after the current one settles', async () => {
  const timers = manualTimers();
  const scheduler = createScheduler({ ...timers, random: () => 0, logger: quiet });
  let active = 0;
  let maxActive = 0;
  let release;
  scheduler.register({
    id: 'slow',
    run: () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      return new Promise((resolve) => { release = () => { active -= 1; resolve(); }; });
    },
  }, { intervalMs: 10 });
  scheduler.start();
  await timers.fireAll();
  assert.equal(active, 1);
  assert.equal(timers.pending().length, 0, 'no timer while a run is in progress');
  await assert.doesNotReject(scheduler.runNow('slow').then((ran) => assert.equal(ran, false)));
  release();
  await new Promise((r) => setImmediate(r));
  assert.equal(timers.pending().length, 1);
  assert.equal(timers.pending()[0].ms, 10);
  assert.equal(maxActive, 1);
});

test('a throwing run is recorded and does not stop the schedule', async () => {
  const timers = manualTimers();
  const scheduler = createScheduler({ ...timers, random: () => 0, logger: quiet });
  scheduler.register({ id: 'bad', run: async () => { throw new Error('boom'); } }, { intervalMs: 50 });
  scheduler.start();
  await timers.fireAll();
  const [job] = scheduler.status().jobs;
  assert.equal(job.errors, 1);
  assert.equal(job.lastError, 'boom');
  assert.equal(timers.pending().length, 1);
});

test('sources register by refresh() and expose their status', async () => {
  const timers = manualTimers();
  const scheduler = createScheduler({ ...timers, random: () => 0, logger: quiet });
  let refreshed = 0;
  scheduler.register({ id: 'src', refresh: async () => { refreshed += 1; }, status: () => ({ ok: true }) }, { intervalMs: 100 });
  scheduler.start();
  await timers.fireAll();
  assert.equal(refreshed, 1);
  assert.deepEqual(scheduler.status().jobs[0].source, { ok: true });
});

test('pause, resume and stop', async () => {
  const timers = manualTimers();
  const scheduler = createScheduler({ ...timers, random: () => 0, logger: quiet });
  let runs = 0;
  scheduler.register({ id: 'a', run: async () => { runs += 1; } }, { intervalMs: 100 });
  scheduler.start();
  scheduler.pause('a');
  assert.equal(timers.pending().length, 0);
  scheduler.resume('a');
  assert.equal(timers.pending().length, 1);
  scheduler.stop();
  assert.equal(timers.pending().length, 0);
  await timers.fireAll();
  assert.equal(runs, 0);
  assert.equal(scheduler.status().stopped, true);
});

test('duplicate ids and bad registrations are rejected', () => {
  const scheduler = createScheduler({ logger: quiet });
  scheduler.register({ id: 'a', run: async () => {} }, { intervalMs: 1 });
  assert.throws(() => scheduler.register({ id: 'a', run: async () => {} }, { intervalMs: 1 }), /already registered/);
  assert.throws(() => scheduler.register({ id: 'b' }, { intervalMs: 1 }), TypeError);
  assert.throws(() => scheduler.register({ id: 'c', run: async () => {} }, { intervalMs: 0 }), TypeError);
});
