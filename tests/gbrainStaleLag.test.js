const assert = require('node:assert/strict');
const test = require('node:test');

const {
  buildGBrainOverview,
  buildLiveGBrainHealth,
} = require('../server/routes/gbrain');
const {
  STALE_PAGES_LAG_TOLERANCE_SECONDS,
  splitStalePages,
  readStaleLag,
} = require('../server/routes/gbrain/liveProbes');
const { normalizeSnapshot } = require('../server/services/gbrainTimeline');

function execWithHealth(healthPayload) {
  return async (bin, args) => {
    assert.equal(bin, 'gbrain');
    if (args.join(' ') === 'call --source __all__ get_health') {
      return { stdout: JSON.stringify(healthPayload), stderr: '' };
    }
    if (args.join(' ') === 'jobs stats --json') {
      return { stdout: JSON.stringify({ waiting: 0, active: 0, stalled: 0 }), stderr: '' };
    }
    throw new Error(`Unexpected command ${args.join(' ')}`);
  };
}

function healthPayload(stalePages, extra = {}) {
  return {
    brain_score: 98,
    page_count: 100,
    chunk_count: 200,
    embedded_count: 200,
    missing_embeddings: 0,
    embed_coverage: 1,
    stale_pages: stalePages,
    ...extra,
  };
}

async function overviewFor(payload) {
  const health = await buildLiveGBrainHealth({ execFilePromise: execWithHealth(payload) });
  const overview = buildGBrainOverview({ health });
  const core = overview.nodes.find((node) => node.id === 'gbrain-core');
  return { health, overview, core };
}

function assertDegraded({ overview, core }, count) {
  assert.equal(core.status, 'warning');
  assert.equal(overview.trust.label, 'Live data stale');
  assert.match(overview.caveats.join(' '), new RegExp(`${count} stale page`));
}

test('tolerance is 2 autopilot ticks (600s each)', () => {
  assert.equal(STALE_PAGES_LAG_TOLERANCE_SECONDS, 1200);
});

test('splitStalePages: inside tolerance is catching up; beyond it, or without a numeric lag, overdue', () => {
  assert.deepEqual(splitStalePages(3, 300), { overdue: 0, catchingUp: 3 });
  assert.deepEqual(splitStalePages(3, 1200), { overdue: 0, catchingUp: 3 });
  assert.deepEqual(splitStalePages(3, 1201), { overdue: 3, catchingUp: 0 });
  for (const bad of [null, undefined, -5, NaN, Infinity, '300', '', false, 0n]) {
    assert.deepEqual(splitStalePages(3, bad), { overdue: 3, catchingUp: 0 }, `lag ${String(bad)}`);
  }
  assert.deepEqual(splitStalePages(0, null), { overdue: 0, catchingUp: 0 });
  assert.deepEqual(splitStalePages(null, 300), { overdue: null, catchingUp: 0 });
});

test('readStaleLag only trusts the lag on the record that owns stale_pages with the same count', () => {
  assert.equal(readStaleLag({ stale_pages: 3, stale_pages_oldest_lag_seconds: 240 }, 3), 240);
  // Nested unrelated lag with no lag on the owning record.
  assert.equal(readStaleLag({ stale_pages: 3, details: { stale_pages_oldest_lag_seconds: 30 } }, 3), null);
  // Lag on a different record than the one owning the count.
  assert.equal(readStaleLag({ health: { stale_pages: 3 }, other: { stale_pages_oldest_lag_seconds: 30 } }, 3), null);
  // Count mismatch (count resolved from a different record).
  assert.equal(readStaleLag({ stale_pages: 1, stale_pages_oldest_lag_seconds: 30 }, 3), null);
  for (const bad of [null, '', false, '240', -1]) {
    assert.equal(readStaleLag({ stale_pages: 3, stale_pages_oldest_lag_seconds: bad }, 3), null, `lag ${String(bad)}`);
  }
});

test('young stale pages: GBrain Core stays healthy, raw count kept and shown as catching up', async () => {
  const r = await overviewFor(healthPayload(3, { stale_pages_oldest_lag_seconds: 240 }));
  assert.equal(r.health.metrics.stalePages, 3);
  assert.equal(r.health.metrics.stalePagesOverdue, 0);
  assert.equal(r.health.metrics.stalePagesCatchingUp, 3);
  assert.equal(r.health.metrics.stalePagesOldestLagSeconds, 240);
  assert.equal(r.core.status, 'healthy');
  assert.notEqual(r.overview.trust.label, 'Live data stale');
  assert.doesNotMatch(r.overview.caveats.join(' '), /stale page/i);
  assert.equal(r.core.metrics.find((metric) => metric.label === 'Stale pages')?.value, '3 catching up (oldest 4m)');
});

test('stale pages older than tolerance degrade GBrain Core', async () => {
  const r = await overviewFor(healthPayload(3, { stale_pages_oldest_lag_seconds: 1500 }));
  assert.equal(r.health.metrics.stalePagesOverdue, 3);
  assertDegraded(r, 3);
  assert.equal(r.core.metrics.find((metric) => metric.label === 'Stale pages')?.value, '3');
});

test('explicit null / non-number lag degrades end to end (review P1)', async () => {
  for (const lag of [null, '', false, '240']) {
    const r = await overviewFor(healthPayload(3, { stale_pages_oldest_lag_seconds: lag }));
    assert.equal(r.health.metrics.stalePagesOverdue, 3, `lag ${JSON.stringify(lag)}`);
    assertDegraded(r, 3);
  }
});

test('nested unrelated lag key cannot make Core healthy (review P2)', async () => {
  const r = await overviewFor(healthPayload(3, { details: { stale_pages_oldest_lag_seconds: 30 } }));
  assert.equal(r.health.metrics.stalePagesOverdue, 3);
  assertDegraded(r, 3);
});

test('GBrain without the lag field keeps any-stale-degrades behavior', async () => {
  const r = await overviewFor(healthPayload(3));
  assert.equal(r.health.metrics.stalePagesOldestLagSeconds, null);
  assertDegraded(r, 3);
});

test('zero stale pages with null lag is healthy', async () => {
  const r = await overviewFor(healthPayload(0, { stale_pages_oldest_lag_seconds: null }));
  assert.equal(r.health.metrics.stalePagesOverdue, 0);
  assert.equal(r.core.status, 'healthy');
});

test('timeline keeps the raw count and scores only overdue pages as a regression', async () => {
  const young = await overviewFor(healthPayload(3, { stale_pages_oldest_lag_seconds: 240 }));
  const old = await overviewFor(healthPayload(3, { stale_pages_oldest_lag_seconds: 1500 }));
  const youngEntry = normalizeSnapshot(young.overview, { capturedAt: '2026-09-27T17:00:00.000Z' });
  const oldEntry = normalizeSnapshot(old.overview, { capturedAt: '2026-09-27T17:20:00.000Z' });
  assert.equal(youngEntry.metrics.stalePages, 3);
  assert.equal(youngEntry.metrics.stalePagesOverdue, 0);
  assert.equal(oldEntry.metrics.stalePagesOverdue, 3);
});

test('two records owning the same stale count are ambiguous: lag ignored, pages overdue (review round 2)', async () => {
  const payload = {
    health: healthPayload(3, { stale_pages_oldest_lag_seconds: null }),
    debug: { stale_pages: 3, stale_pages_oldest_lag_seconds: 30 },
  };
  assert.equal(readStaleLag(payload, 3), null);
  const r = await overviewFor(payload);
  assert.equal(r.health.metrics.stalePagesOverdue, 3);
  assertDegraded(r, 3);
});
