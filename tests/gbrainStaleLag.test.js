const assert = require('node:assert/strict');
const test = require('node:test');

const {
  buildGBrainOverview,
  buildLiveGBrainHealth,
} = require('../server/routes/gbrain');
const {
  STALE_PAGES_LAG_TOLERANCE_SECONDS,
  splitStalePages,
} = require('../server/routes/gbrain/liveProbes');

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

test('tolerance is 2 autopilot ticks (600s each)', () => {
  assert.equal(STALE_PAGES_LAG_TOLERANCE_SECONDS, 1200);
});

test('splitStalePages: inside tolerance is catching up, beyond or unknown lag stays verdict-bearing', () => {
  assert.deepEqual(splitStalePages(3, 300), { lagging: 0, catchingUp: 3 });
  assert.deepEqual(splitStalePages(3, 1200), { lagging: 0, catchingUp: 3 });
  assert.deepEqual(splitStalePages(3, 1201), { lagging: 3, catchingUp: 0 });
  // Fail-closed: no lag field (older GBrain), null lag, or nonsense lag.
  assert.deepEqual(splitStalePages(3, null), { lagging: 3, catchingUp: 0 });
  assert.deepEqual(splitStalePages(3, undefined), { lagging: 3, catchingUp: 0 });
  assert.deepEqual(splitStalePages(3, -5), { lagging: 3, catchingUp: 0 });
  assert.deepEqual(splitStalePages(3, NaN), { lagging: 3, catchingUp: 0 });
  // Zero / unknown counts pass through untouched.
  assert.deepEqual(splitStalePages(0, null), { lagging: 0, catchingUp: 0 });
  assert.deepEqual(splitStalePages(null, 300), { lagging: null, catchingUp: 0 });
});

test('live health: young stale pages do not degrade GBrain Core', async () => {
  const health = await buildLiveGBrainHealth({
    execFilePromise: execWithHealth(healthPayload(3, { stale_pages_oldest_lag_seconds: 240 })),
  });
  assert.equal(health.metrics.stalePages, 0);
  assert.equal(health.metrics.stalePagesReported, 3);
  assert.equal(health.metrics.stalePagesCatchingUp, 3);
  assert.equal(health.metrics.stalePagesOldestLagSeconds, 240);

  const overview = buildGBrainOverview({ health });
  const core = overview.nodes.find((node) => node.id === 'gbrain-core');
  assert.equal(core.status, 'healthy');
  assert.notEqual(overview.trust.label, 'Live data stale');
  assert.doesNotMatch(overview.caveats.join(' '), /stale page/i);
  assert.equal(core.metrics.find((metric) => metric.label === 'Stale pages')?.value, '3 catching up (oldest 4m)');
});

test('live health: stale pages older than tolerance still degrade GBrain Core', async () => {
  const health = await buildLiveGBrainHealth({
    execFilePromise: execWithHealth(healthPayload(3, { stale_pages_oldest_lag_seconds: 1500 })),
  });
  assert.equal(health.metrics.stalePages, 3);
  assert.equal(health.metrics.stalePagesCatchingUp, 0);

  const overview = buildGBrainOverview({ health });
  const core = overview.nodes.find((node) => node.id === 'gbrain-core');
  assert.equal(core.status, 'warning');
  assert.equal(overview.trust.label, 'Live data stale');
  assert.match(overview.caveats.join(' '), /3 stale pages/);
  assert.equal(core.metrics.find((metric) => metric.label === 'Stale pages')?.value, '3');
});

test('live health: GBrain without the lag field keeps the old any-stale-degrades behavior', async () => {
  const health = await buildLiveGBrainHealth({ execFilePromise: execWithHealth(healthPayload(3)) });
  assert.equal(health.metrics.stalePages, 3);
  assert.equal(health.metrics.stalePagesOldestLagSeconds, null);
  const overview = buildGBrainOverview({ health });
  assert.equal(overview.nodes.find((node) => node.id === 'gbrain-core').status, 'warning');
});

test('live health: zero stale pages with null lag is healthy', async () => {
  const health = await buildLiveGBrainHealth({
    execFilePromise: execWithHealth(healthPayload(0, { stale_pages_oldest_lag_seconds: null })),
  });
  assert.equal(health.metrics.stalePages, 0);
  assert.equal(health.metrics.stalePagesCatchingUp, 0);
  const overview = buildGBrainOverview({ health });
  assert.equal(overview.nodes.find((node) => node.id === 'gbrain-core').status, 'healthy');
});
