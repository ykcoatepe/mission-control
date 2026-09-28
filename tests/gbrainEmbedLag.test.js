const assert = require('node:assert/strict');
const test = require('node:test');

const {
  buildGBrainOverview,
  buildLiveGBrainHealth,
} = require('../server/routes/gbrain');
const {
  MISSING_EMBEDDINGS_LAG_TOLERANCE_SECONDS,
  STALE_PAGES_LAG_TOLERANCE_SECONDS,
  splitMissingEmbeddings,
  readMissingEmbeddingsRecord,
  readStaleRecord,
  liveHealthStatus,
  normalizeHealthText,
} = require('../server/routes/gbrain/liveProbes');
const { normalizeSnapshot, buildActiveRegressionBanner } = require('../server/services/gbrainTimeline');

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

function healthPayload(missingEmbeddings, extra = {}) {
  return {
    brain_score: 98,
    page_count: 100,
    chunk_count: 200,
    embedded_count: 200,
    missing_embeddings: missingEmbeddings,
    embed_coverage: 1,
    stale_pages: 0,
    stale_pages_oldest_lag_seconds: null,
    ...extra,
  };
}

async function overviewFor(payload) {
  const health = await buildLiveGBrainHealth({ execFilePromise: execWithHealth(payload) });
  const overview = buildGBrainOverview({ health });
  const core = overview.nodes.find((node) => node.id === 'gbrain-core');
  const queues = overview.nodes.find((node) => node.id === 'queues');
  return { health, overview, core, queues };
}

function missingMetric(queues) {
  return queues.metrics.find((metric) => metric.label === 'Missing')?.value;
}

function assertDegraded({ overview, core, queues }, count) {
  assert.equal(core.status, 'warning');
  assert.equal(queues.status, 'warning');
  assert.equal(overview.cockpit.embeddings.status, 'warning');
  assert.equal(overview.cockpit.queue.status, 'warning');
  assert.equal(overview.trust.status, 'warning');
  assert.equal(overview.trust.label, 'Live with caveats');
  assert.match(overview.caveats.join(' '), new RegExp(`${count} missing embedding`));
}

function assertUnavailable({ health, overview, core, queues }, label) {
  assert.equal(health.metrics.missingEmbeddings, null, label);
  assert.equal(health.metrics.missingEmbeddingsUnavailable, true, label);
  assert.equal(health.status, 'warning', label);
  assert.equal(core.status, 'warning', label);
  assert.equal(queues.status, 'warning', label);
  assert.equal(overview.trust.status, 'warning', label);
  assert.match(overview.caveats.join(' '), /did not report a valid missing-embedding count/, label);
  assert.equal(missingMetric(queues), 'Unavailable', label);
  assert.equal(overview.cockpit.embeddings.detail, 'missing-embedding count unavailable', label);
}

test('tolerance is 1200s (2 autopilot ticks), separate from the stale-page constant', () => {
  assert.equal(MISSING_EMBEDDINGS_LAG_TOLERANCE_SECONDS, 1200);
  assert.equal(STALE_PAGES_LAG_TOLERANCE_SECONDS, 1200);
});

test('splitMissingEmbeddings: inside tolerance is catching up; beyond it, or without a numeric age, overdue', () => {
  assert.deepEqual(splitMissingEmbeddings(1, 120), { overdue: 0, catchingUp: 1 });
  assert.deepEqual(splitMissingEmbeddings(4, 1200), { overdue: 0, catchingUp: 4 });
  assert.deepEqual(splitMissingEmbeddings(4, 1201), { overdue: 4, catchingUp: 0 });
  for (const bad of [null, undefined, -5, NaN, Infinity, '120', '', false, 0n]) {
    assert.deepEqual(splitMissingEmbeddings(4, bad), { overdue: 4, catchingUp: 0 }, `age ${String(bad)}`);
  }
  assert.deepEqual(splitMissingEmbeddings(0, null), { overdue: 0, catchingUp: 0 });
  assert.deepEqual(splitMissingEmbeddings(null, 120), { overdue: null, catchingUp: 0 });
});

test('readMissingEmbeddingsRecord reads count and age together from the single owning record', () => {
  assert.deepEqual(readMissingEmbeddingsRecord({ missing_embeddings: 3, missing_embeddings_oldest_age_seconds: 240 }), { count: 3, age: 240 });
  assert.deepEqual(readMissingEmbeddingsRecord({ missing_embeddings: 0, missing_embeddings_oldest_age_seconds: null }), { count: 0, age: null });
  // Nested unrelated age with no age on the owning record.
  assert.deepEqual(readMissingEmbeddingsRecord({ missing_embeddings: 3, details: { missing_embeddings_oldest_age_seconds: 30 } }), { count: 3, age: null });
  for (const bad of [null, '', false, '240', -1, NaN, Infinity]) {
    assert.deepEqual(readMissingEmbeddingsRecord({ missing_embeddings: 3, missing_embeddings_oldest_age_seconds: bad }), { count: 3, age: null }, `age ${String(bad)}`);
  }
  for (const bad of [null, false, true, '', '3', -1, 2.5, NaN, Infinity, [3], { n: 3 }]) {
    assert.deepEqual(readMissingEmbeddingsRecord({ missing_embeddings: bad, missing_embeddings_oldest_age_seconds: 30 }), { count: null, age: null }, `count ${String(bad)}`);
  }
  // Absent count; camelCase / short aliases are not owners.
  assert.deepEqual(readMissingEmbeddingsRecord({ brain_score: 98 }), { count: null, age: null });
  assert.deepEqual(readMissingEmbeddingsRecord({ missingEmbeddings: 0, missing: 0 }), { count: null, age: null });
  // Two owners are ambiguous.
  assert.deepEqual(readMissingEmbeddingsRecord({ a: { missing_embeddings: 3 }, b: { missing_embeddings: 3, missing_embeddings_oldest_age_seconds: 30 } }), { count: null, age: null });
});

test('young missing embeddings: Core and queue stay healthy, raw count kept and shown as catching up', async () => {
  const r = await overviewFor(healthPayload(1, { missing_embeddings_oldest_age_seconds: 118 }));
  assert.equal(r.health.metrics.missingEmbeddings, 1);
  assert.equal(r.health.metrics.missingEmbeddingsOverdue, 0);
  assert.equal(r.health.metrics.missingEmbeddingsCatchingUp, 1);
  assert.equal(r.health.metrics.missingEmbeddingsOldestAgeSeconds, 118);
  assert.equal(r.health.metrics.missingEmbeddingsUnavailable, false);
  assert.equal(r.health.status, 'healthy');
  assert.equal(r.core.status, 'healthy');
  assert.equal(r.queues.status, 'healthy');
  assert.equal(r.overview.trust.status, 'healthy');
  assert.equal(r.overview.trust.label, 'Live trusted');
  assert.deepEqual(r.overview.caveats, []);
  assert.deepEqual(r.queues.risks, []);
  assert.equal(missingMetric(r.queues), '1 catching up (oldest 2m)');
  assert.equal(r.overview.cockpit.embeddings.detail, '1 missing, catching up (oldest 2m)');
  assert.equal(r.overview.cockpit.embeddings.status, 'healthy');
  assert.match(r.queues.summary, /catching up/);
});

test('exactly at the tolerance is still catching up', async () => {
  const r = await overviewFor(healthPayload(2, { missing_embeddings_oldest_age_seconds: 1200 }));
  assert.equal(r.health.metrics.missingEmbeddingsOverdue, 0);
  assert.equal(r.core.status, 'healthy');
});

test('missing embeddings older than tolerance degrade Core, queue and trust with raw count + oldest age', async () => {
  const r = await overviewFor(healthPayload(3, { missing_embeddings_oldest_age_seconds: 1500 }));
  assert.equal(r.health.metrics.missingEmbeddings, 3);
  assert.equal(r.health.metrics.missingEmbeddingsOverdue, 3);
  assert.equal(r.health.metrics.missingEmbeddingsCatchingUp, 0);
  assert.equal(r.health.status, 'warning');
  assertDegraded(r, 3);
  assert.equal(missingMetric(r.queues), '3 (oldest 25m)');
  assert.match(r.overview.caveats.join(' '), /3 missing embeddings \(oldest 25m\)/);
  assert.equal(r.overview.cockpit.embeddings.detail, '3 missing (oldest 25m)');
  assert.match(r.queues.nextSafeAction, /backfill/);
});

test('null / invalid / missing age with a positive count is overdue (fail closed)', async () => {
  for (const age of [null, '', false, '240', -1]) {
    const r = await overviewFor(healthPayload(3, { missing_embeddings_oldest_age_seconds: age }));
    assert.equal(r.health.metrics.missingEmbeddingsOverdue, 3, `age ${JSON.stringify(age)}`);
    assert.equal(r.health.metrics.missingEmbeddingsOldestAgeSeconds, null);
    assertDegraded(r, 3);
    assert.equal(missingMetric(r.queues), '3');
  }
  // Older GBrain without the age field.
  const r = await overviewFor(healthPayload(3));
  assert.equal(r.health.metrics.missingEmbeddingsOverdue, 3);
  assertDegraded(r, 3);
});

test('zero missing embeddings with null age is healthy', async () => {
  const r = await overviewFor(healthPayload(0, { missing_embeddings_oldest_age_seconds: null }));
  assert.equal(r.health.metrics.missingEmbeddingsOverdue, 0);
  assert.equal(r.health.metrics.missingEmbeddingsUnavailable, false);
  assert.equal(r.core.status, 'healthy');
  assert.equal(missingMetric(r.queues), '0');
  assert.equal(r.overview.cockpit.embeddings.detail, '0 missing');
});

test('invalid or missing count is unavailable -> warning, never healthy or zero', async () => {
  for (const bad of [null, false, true, '', '0', -1, 2.5]) {
    assertUnavailable(await overviewFor(healthPayload(bad, { missing_embeddings_oldest_age_seconds: 30 })), `count ${JSON.stringify(bad)}`);
  }
  const absent = healthPayload(0);
  delete absent.missing_embeddings;
  assertUnavailable(await overviewFor(absent), 'absent');
});

test('nested unrelated age key cannot make Core healthy', async () => {
  const r = await overviewFor(healthPayload(3, { details: { missing_embeddings_oldest_age_seconds: 30 } }));
  assert.equal(r.health.metrics.missingEmbeddingsOverdue, 3);
  assertDegraded(r, 3);
});

test('two records owning the missing-embedding count are ambiguous: unavailable, never healthy', async () => {
  const payload = {
    health: healthPayload(3, { missing_embeddings_oldest_age_seconds: null }),
    debug: { missing_embeddings: 3, missing_embeddings_oldest_age_seconds: 30 },
  };
  assert.deepEqual(readMissingEmbeddingsRecord(payload), { count: null, age: null });
  assertUnavailable(await overviewFor(payload), 'ambiguous');
});

test('liveHealthStatus uses the overdue/unavailable verdict; legacy health objects count every missing embedding', () => {
  const base = { ok: true, status: 'healthy', score: 98 };
  const metrics = { stalePages: 0 };
  assert.equal(liveHealthStatus({ ...base, metrics: { ...metrics, missingEmbeddings: 2, missingEmbeddingsOverdue: 0 } }), 'healthy');
  assert.equal(liveHealthStatus({ ...base, metrics: { ...metrics, missingEmbeddings: 2, missingEmbeddingsOverdue: 2 } }), 'warning');
  assert.equal(liveHealthStatus({ ...base, metrics: { ...metrics, missingEmbeddings: 2 } }), 'warning');
  assert.equal(liveHealthStatus({ ...base, metrics: { ...metrics, missingEmbeddings: null, missingEmbeddingsUnavailable: true } }), 'warning');
});

test('stale-page behaviour is unchanged alongside catching-up embeddings', async () => {
  const r = await overviewFor(healthPayload(1, {
    missing_embeddings_oldest_age_seconds: 60,
    stale_pages: 3,
    stale_pages_oldest_lag_seconds: 1500,
  }));
  assert.equal(r.health.metrics.stalePagesOverdue, 3);
  assert.equal(r.health.status, 'stale');
  assert.equal(r.core.status, 'warning');
  assert.equal(r.overview.trust.label, 'Live data stale');
  assert.match(r.overview.caveats.join(' '), /3 stale pages \(oldest 25m\)/);
  assert.doesNotMatch(r.overview.caveats.join(' '), /missing embedding/);
  assert.deepEqual(readStaleRecord(healthPayload(0, { stale_pages: 3, stale_pages_oldest_lag_seconds: 240 })), { count: 3, lag: 240 });
});

test('text fallback: whole-line integer count only (no age -> any missing is overdue); malformed is unavailable', () => {
  const at = '2026-09-28T10:00:00.000Z';
  const ok = normalizeHealthText('Health score: 9.8/10\nMissing embeddings: 0\nStale pages: 0\n', '', at);
  assert.equal(ok.metrics.missingEmbeddings, 0);
  assert.equal(ok.metrics.missingEmbeddingsOverdue, 0);
  assert.equal(ok.metrics.missingEmbeddingsUnavailable, false);
  assert.equal(ok.status, 'healthy');
  const one = normalizeHealthText('Health score: 9.8/10\nMissing embeddings: 1\nStale pages: 0\n', '', at);
  assert.equal(one.metrics.missingEmbeddings, 1);
  assert.equal(one.metrics.missingEmbeddingsOverdue, 1);
  assert.equal(one.metrics.missingEmbeddingsOldestAgeSeconds, null);
  assert.equal(one.status, 'warning');
  assert.equal(liveHealthStatus(one), 'warning');
  for (const bad of ['0.5', '0junk', '0e3', '-1', '']) {
    const r = normalizeHealthText(`Health score: 9.8/10\nMissing embeddings: ${bad}\nStale pages: 0\n`, '', at);
    assert.equal(r.metrics.missingEmbeddings, null, `text ${JSON.stringify(bad)}`);
    assert.equal(r.metrics.missingEmbeddingsUnavailable, true);
    assert.equal(r.status, 'warning');
    assert.equal(liveHealthStatus(r), 'warning');
  }
  const absent = normalizeHealthText('Health score: 9.8/10\nStale pages: 0\n', '', at);
  assert.equal(absent.metrics.missingEmbeddingsUnavailable, true);
  assert.equal(liveHealthStatus(absent), 'warning');
});

test('timeline keeps the raw count and scores only overdue missing embeddings as a regression', async () => {
  const young = await overviewFor(healthPayload(3, { missing_embeddings_oldest_age_seconds: 240 }));
  const old = await overviewFor(healthPayload(3, { missing_embeddings_oldest_age_seconds: 1500 }));
  const clean = await overviewFor(healthPayload(0, { missing_embeddings_oldest_age_seconds: null }));
  const youngEntry = normalizeSnapshot(young.overview, { capturedAt: '2026-09-28T10:00:00.000Z' });
  const oldEntry = normalizeSnapshot(old.overview, { capturedAt: '2026-09-28T10:20:00.000Z' });
  const cleanEntry = normalizeSnapshot(clean.overview, { capturedAt: '2026-09-28T09:40:00.000Z' });
  assert.equal(youngEntry.metrics.missingEmbeddings, 3);
  assert.equal(youngEntry.metrics.missingEmbeddingsOverdue, 0);
  assert.equal(youngEntry.metrics.missingEmbeddingsOldestAgeSeconds, 240);
  assert.equal(oldEntry.metrics.missingEmbeddings, 3);
  assert.equal(oldEntry.metrics.missingEmbeddingsOverdue, 3);
  assert.equal(oldEntry.metrics.missingEmbeddingsOldestAgeSeconds, 1500);

  // A catching-up snapshot is not a regression; an overdue one is.
  assert.equal(buildActiveRegressionBanner(youngEntry), null);
  assert.equal(buildActiveRegressionBanner(cleanEntry), null);
  const overdue = buildActiveRegressionBanner(oldEntry);
  assert.ok(overdue, 'overdue missing embeddings are a regression');
  assert.match(overdue.detail, /3 missing embeddings/);

  // Older snapshots without the overdue field count every missing embedding.
  const legacy = JSON.parse(JSON.stringify(youngEntry));
  delete legacy.metrics.missingEmbeddingsOverdue;
  delete legacy.metrics.missingEmbeddingsOldestAgeSeconds;
  assert.match(buildActiveRegressionBanner(legacy)?.detail || '', /3 missing embeddings/);
});
