const assert = require('node:assert/strict');
const test = require('node:test');

const { createHermesKanbanService } = require('../server/services/hermesKanbanData');

function makeExec({ delayMs = 0, failWhen = () => false, onCall } = {}) {
  const state = { inFlight: 0, maxInFlight: 0, calls: 0 };
  const exec = async (_bin, args) => {
    state.calls += 1;
    state.inFlight += 1;
    state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
    try {
      if (onCall) await onCall(state);
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      if (failWhen(state, args)) throw new Error('Command failed: timed out');
      const key = args.slice(3).join(' ');
      const out = key.startsWith('list') ? [{ id: 't', status: 'todo' }] : key.startsWith('stats') ? { total: 1 } : [];
      return { stdout: JSON.stringify(out), stderr: '' };
    } finally {
      state.inFlight -= 1;
    }
  };
  return { exec, state };
}

function build(exec, extra = {}) {
  let t = 1_000_000;
  const clock = { advance: (ms) => { t += ms; }, now: () => t };
  const service = createHermesKanbanService({
    execFilePromise: exec,
    processEnv: { HOME: '/tmp/home', HERMES_PROFILE: 'hmudur' },
    now: clock.now,
    ...extra,
  });
  return { service, clock };
}

test('board CLI calls are concurrency-limited', async () => {
  const { exec, state } = makeExec({ delayMs: 5 });
  const { service } = build(exec);
  const board = await service.getBoard();
  assert.equal(board.ok, true);
  assert.equal(state.calls, 8);
  assert.ok(state.maxInFlight <= 2, `max in flight was ${state.maxInFlight}`);
  assert.equal(board.stale, undefined);
});

test('a failed refresh drains its workers before an immediate retry and stops scheduling calls', async () => {
  const firstError = new Error('first list failed');
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let calls = 0;
  let active = 0;
  let peak = 0;
  let activeAtSettlement;
  const exec = async (_bin, args) => {
    const call = ++calls;
    active += 1;
    peak = Math.max(peak, active);
    try {
      if (call === 1) throw firstError;
      await gate;
      const key = args[3];
      return { stdout: JSON.stringify(key === 'stats' ? { total: 0 } : []), stderr: '' };
    } finally {
      active -= 1;
    }
  };
  const { service } = build(exec);
  const retry = service.getBoard().then(
    () => { throw new Error('first refresh must reject'); },
    (error) => {
      assert.equal(error, firstError);
      activeAtSettlement = active;
      return service.getBoard(); // next request as soon as the first settles
    },
  );
  // A referenced immediate advances the failure handlers without sleeps or
  // relying on a bare pending promise to keep the event loop alive.
  try {
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    release();
  }
  assert.equal((await retry).ok, true);
  assert.ok(peak <= 2, `peak across failure and retry was ${peak}`);
  assert.equal(activeAtSettlement, 0, 'no outstanding CLI call when a refresh settles');
  assert.equal(calls, 10, 'failed batch stops at two calls; retry performs eight');
  const callsAtSettlement = calls;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, callsAtSettlement, 'no detached worker issues calls after settlement');
  assert.equal(active, 0);
});

test('a failed refresh preserves the first error while draining another failed worker', async () => {
  const firstError = new Error('first worker failed');
  const laterError = new Error('later worker failed');
  let calls = 0;
  let siblingSettled = false;
  const { service } = build(async () => {
    calls += 1;
    if (calls === 1) throw firstError;
    await new Promise((resolve) => setImmediate(resolve));
    siblingSettled = true;
    throw laterError;
  });
  await assert.rejects(service.getBoard(), (error) => error === firstError);
  assert.equal(siblingSettled, true);
  assert.equal(calls, 2, 'no queued call starts after the first failure');
});

test('a failed refresh serves the last good board as stale with its age', async () => {
  let fail = false;
  const { exec } = makeExec({ failWhen: () => fail });
  const { service, clock } = build(exec);
  const good = await service.getBoard();
  fail = true;
  clock.advance(6 * 60_000);
  const stale = await service.getBoard();
  assert.equal(stale.ok, true);
  assert.equal(stale.stale, true);
  assert.equal(stale.staleAgeMs, 6 * 60_000);
  assert.equal(stale.refreshedAt, good.refreshedAt);
  assert.equal(stale.summary.total, good.summary.total);
});

test('a cache older than the stale limit is not served', async () => {
  let fail = false;
  const { exec } = makeExec({ failWhen: () => fail });
  const { service, clock } = build(exec, { maxStaleMs: 600_000 });
  await service.getBoard();
  fail = true;
  clock.advance(600_001);
  await assert.rejects(service.getBoard(), /timed out/);
});

test('failure with no cache still rejects', async () => {
  const { exec } = makeExec({ failWhen: () => true });
  const { service } = build(exec);
  await assert.rejects(service.getBoard(), /timed out/);
});

test('soft deadline returns the stale cache while the refresh continues, and concurrent callers share it', async () => {
  let slow = false;
  let release;
  const gate = new Promise((r) => { release = r; });
  const { exec, state } = makeExec({ onCall: async () => { if (slow) await gate; } });
  const { service, clock } = build(exec);
  await service.getBoard();
  const callsAfterFirst = state.calls;
  slow = true;
  clock.advance(30_000);
  // The fake CLI has no child-process handle. Keep the loop alive while its
  // gate is closed so the production unref'd soft deadlines can fire. This
  // interval never releases the gate or determines when an assertion runs.
  const keepAlive = setInterval(() => {}, 60_000);
  try {
    const [a, b] = await Promise.all([
      service.getBoard({ softDeadlineMs: 20 }),
      service.getBoard({ softDeadlineMs: 20 }),
    ]);
    assert.equal(a.ok, true);
    assert.equal(a.cacheAgeMs, 30_000);
    assert.equal(b.cacheAgeMs, 30_000);
  } finally {
    release();
    clearInterval(keepAlive);
    await service.getBoard(); // joins/finishes the shared refresh, even on failure
  }
  assert.equal(state.calls - callsAfterFirst, 8, 'only one refresh ran');
});

test('a cache younger than the freshness threshold is served as fresh, still carrying its age', async () => {
  let fail = false;
  const { exec } = makeExec({ failWhen: () => fail });
  const { service, clock } = build(exec);
  await service.getBoard();
  fail = true;
  clock.advance(17_000);
  const board = await service.getBoard();
  assert.equal(board.ok, true);
  assert.equal(board.stale, undefined);
  assert.equal(board.cacheAgeMs, 17_000);
});

test('freshness threshold is configurable and separate from maxStaleMs', async () => {
  let fail = false;
  const { exec } = makeExec({ failWhen: () => fail });
  const { service, clock } = build(exec, { freshMs: 10_000, maxStaleMs: 600_000 });
  await service.getBoard();
  fail = true;
  clock.advance(17_000);
  const board = await service.getBoard();
  assert.equal(board.stale, true);
  assert.equal(board.staleAgeMs, 17_000);
});

test('age 17s fresh, 6min stale, beyond maxStaleMs rejected', async () => {
  let fail = false;
  const { exec } = makeExec({ failWhen: () => fail });
  const { service, clock } = build(exec);
  await service.getBoard();
  fail = true;
  clock.advance(17_000);
  assert.equal((await service.getBoard()).stale, undefined);
  clock.advance(343_000); // 6 min total
  assert.equal((await service.getBoard()).stale, true);
  clock.advance(5 * 60_000); // 11 min total
  await assert.rejects(service.getBoard(), /timed out/);
});
