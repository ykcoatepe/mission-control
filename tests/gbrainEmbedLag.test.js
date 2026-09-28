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
  EMBED_JOB_WAITING_TOLERANCE_MINUTES,
  EMBED_JOB_QUEUE,
  EMBED_JOB_TERMINAL_PAGE_LIMIT,
  EMBED_JOB_MAX_RUNTIME_MS,
  evaluateEmbedJobSignal,
} = require('../server/routes/gbrain/liveProbes');
const { normalizeSnapshot, buildActiveRegressionBanner } = require('../server/services/gbrainTimeline');

const HEALTHY_EMBED_JOB = {
  id: 1,
  name: 'embed',
  queue: 'default',
  status: 'completed',
  created_at: '2026-09-28T09:00:00.000Z',
  finished_at: '2026-09-28T09:00:05.000Z',
  result: { dry_run: false, embedded: 1, failures: 0, would_embed: 0 },
};

// Faithful stand-in for GBrain list_jobs (src/core/minions/queue.ts getJobs):
// filter by the given status / queue / name, ORDER BY created_at DESC, LIMIT
// (default 50) — the limit applies BEFORE any consumer-side selection.
function listJobs(rows, params) {
  return rows
    .filter((row) => (params.status === undefined || row.status === params.status)
      && (params.queue === undefined || row.queue === params.queue)
      && (params.name === undefined || row.name === params.name))
    .sort((x, y) => Date.parse(y.created_at) - Date.parse(x.created_at))
    .slice(0, params.limit || 50);
}

// jobs: array of job rows (all names / queues), or a function(params) that
// returns { stdout } / throws; byType: `jobs stats --json` by_type rows.
function execWithHealth(healthPayload, { jobs = [HEALTHY_EMBED_JOB], byType = [], calls = [], onCall } = {}) {
  const jobsFor = typeof jobs === 'function'
    ? jobs
    : (params) => ({ stdout: JSON.stringify(listJobs(jobs, params)) });
  return async (bin, args) => {
    assert.equal(bin, 'gbrain');
    calls.push(args.join(' '));
    if (onCall) await onCall(args);
    if (args.join(' ') === 'call --source __all__ get_health') {
      return { stdout: JSON.stringify(healthPayload), stderr: '' };
    }
    if (args.join(' ') === 'jobs stats --json') {
      return { stdout: JSON.stringify({ waiting: 0, active: 0, stalled: 0, by_type: byType }), stderr: '' };
    }
    if (args[0] === 'call' && args[1] === 'list_jobs' && args.length === 3) {
      return { stderr: '', ...jobsFor(JSON.parse(args[2])) };
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

async function overviewFor(payload, execOptions) {
  const health = await buildLiveGBrainHealth({ execFilePromise: execWithHealth(payload, execOptions) });
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

// ---- Embed-job health signal -------------------------------------------

function clock(iso) {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

const YOUNG = { missing_embeddings_oldest_age_seconds: 118 };

function job(overrides) {
  return { ...HEALTHY_EMBED_JOB, ...overrides };
}

function assertJobOverdue(r, count, reasonPattern) {
  assert.equal(r.health.metrics.missingEmbeddingsOverdue, count);
  assert.equal(r.health.metrics.missingEmbeddingsCatchingUp, 0);
  assert.equal(r.health.status, 'warning');
  assert.equal(r.core.status, 'warning');
  assert.equal(r.queues.status, 'warning');
  assert.equal(r.overview.trust.status, 'warning');
  assert.match(r.overview.caveats.join(' '), reasonPattern);
  assert.match(r.queues.summary, reasonPattern);
}

// Young age + unavailable job signal: age-only verdict (catching up) plus the
// caveat — never a clean "Live trusted".
function assertJobUnavailable(r, count, label) {
  assert.equal(r.health.metrics.embedJobProbeUnavailable, true, label);
  assert.equal(r.health.metrics.missingEmbeddingsOverdue, 0, label);
  assert.equal(r.health.metrics.missingEmbeddingsCatchingUp, count, label);
  assert.equal(r.overview.trust.status, 'warning', label);
  assert.match(r.overview.caveats.join(' '), /Embed-job probe unavailable; the missing-embedding verdict uses embedding age only/, label);
}

test('embed-job waiting tolerance is 20 minutes; queue scope is default', () => {
  assert.equal(EMBED_JOB_WAITING_TOLERANCE_MINUTES, 20);
  assert.equal(EMBED_JOB_QUEUE, 'default');
});

test('failed / dead latest terminal embed job -> overdue even with a young age, reason with HH:MM', async () => {
  for (const status of ['failed', 'dead']) {
    const finished = '2026-09-28T10:07:00.000Z';
    const r = await overviewFor(healthPayload(2, YOUNG), {
      jobs: [HEALTHY_EMBED_JOB, job({ id: 9, status, created_at: '2026-09-28T10:00:00.000Z', finished_at: finished, result: null })],
    });
    assertJobOverdue(r, 2, new RegExp(`embed job ${status} at ${clock(finished)}`));
    assert.deepEqual(r.health.metrics.missingEmbeddingsJobReasons, [`embed job ${status} at ${clock(finished)}`]);
    assert.equal(r.health.metrics.embedJobProbeUnavailable, false);
  }
});

test('counterexample: five newer non-terminal jobs hide an older failed terminal job from a limit-5 query -> overdue, never healthy', async () => {
  const failedAt = '2026-09-28T10:05:00.000Z';
  const rows = [
    job({ id: 1, created_at: '2026-09-28T09:00:00.000Z', finished_at: '2026-09-28T09:00:05.000Z' }),
    job({ id: 2, status: 'failed', created_at: '2026-09-28T10:00:00.000Z', finished_at: failedAt, result: null }),
    ...[3, 4, 5, 6, 7].map((id) => job({ id, status: 'active', created_at: `2026-09-28T11:0${id}:00.000Z`, finished_at: null, result: null })),
  ];
  // The old name-only limit-5 query would see only the five active rows.
  assert.equal(listJobs(rows, { name: 'embed', limit: 5 }).some((row) => row.status === 'failed'), false);
  const r = await overviewFor(healthPayload(1, YOUNG), { jobs: rows });
  assertJobOverdue(r, 1, new RegExp(`embed job failed at ${clock(failedAt)}`));
});

test('no terminal embed job at all (only non-terminal rows) -> job signal unavailable, never clean', async () => {
  const rows = [1, 2, 3].map((id) => job({ id, status: 'active', created_at: `2026-09-28T11:0${id}:00.000Z`, finished_at: null, result: null }));
  assertJobUnavailable(await overviewFor(healthPayload(1, YOUNG), { jobs: rows }), 1, 'no terminal');
  assertJobUnavailable(await overviewFor(healthPayload(1, YOUNG), { jobs: [] }), 1, 'no jobs');
});

test('latest embed-catch-up job completed with failures > 0 -> overdue', async () => {
  const finished = '2026-09-28T11:30:00.000Z';
  const r = await overviewFor(healthPayload(4, YOUNG), {
    jobs: [
      HEALTHY_EMBED_JOB,
      job({ id: 12, name: 'embed-catch-up', created_at: '2026-09-28T11:29:00.000Z', finished_at: finished, result: { embedded: 3, failures: 2 } }),
    ],
  });
  assertJobOverdue(r, 4, new RegExp(`embed-catch-up job completed with 2 failures at ${clock(finished)}`));
});

test('only the MOST RECENT terminal job counts: an older failure followed by a clean run is healthy', async () => {
  const r = await overviewFor(healthPayload(1, YOUNG), {
    jobs: [
      job({ id: 3, status: 'active', created_at: '2026-09-28T10:20:00.000Z', finished_at: null }),
      job({ id: 2, created_at: '2026-09-28T10:09:00.000Z', finished_at: '2026-09-28T10:10:00.000Z' }),
      job({ id: 1, status: 'failed', created_at: '2026-09-28T09:09:00.000Z', finished_at: '2026-09-28T09:10:00.000Z' }),
      job({ id: 7, name: 'embed-catch-up', status: 'dead', created_at: '2026-09-27T09:00:00.000Z', finished_at: '2026-09-27T09:10:00.000Z' }),
    ],
  });
  assert.equal(r.health.metrics.missingEmbeddingsOverdue, 0);
  assert.equal(r.health.metrics.missingEmbeddingsCatchingUp, 1);
  assert.equal(r.core.status, 'healthy');
  assert.deepEqual(r.overview.caveats, []);
});

test('counterexample: a newer clean job in a FOREIGN queue cannot clear a default-queue failure', async () => {
  const failedAt = '2026-09-28T10:05:00.000Z';
  const r = await overviewFor(healthPayload(1, YOUNG), {
    jobs: [
      job({ id: 2, status: 'failed', created_at: '2026-09-28T10:00:00.000Z', finished_at: failedAt, result: null }),
      job({ id: 3, queue: 'shell', created_at: '2026-09-28T10:30:00.000Z', finished_at: '2026-09-28T10:31:00.000Z' }),
    ],
  });
  assertJobOverdue(r, 1, new RegExp(`embed job failed at ${clock(failedAt)}`));
});

test('a foreign-queue failure does not add overdue; foreign-queue waiting does not add waiting', async () => {
  const now = Date.now();
  const r = await overviewFor(healthPayload(1, YOUNG), {
    jobs: [
      HEALTHY_EMBED_JOB,
      job({ id: 5, queue: 'shell', status: 'failed', created_at: '2026-09-28T10:00:00.000Z', finished_at: '2026-09-28T10:05:00.000Z' }),
      job({ id: 6, queue: 'shell', status: 'waiting', created_at: new Date(now - 90 * 60000).toISOString(), finished_at: null }),
    ],
    // Global stats see the foreign waiting job (by_type is not queue scoped).
    byType: [{ name: 'embed', waiting_now: 1, oldest_waiting_minutes: 90 }],
  });
  assert.equal(r.health.metrics.missingEmbeddingsOverdue, 0);
  assert.deepEqual(r.health.metrics.missingEmbeddingsJobReasons, []);
  assert.equal(r.health.metrics.embedJobProbeUnavailable, false);
  assert.equal(r.core.status, 'healthy');
  assert.deepEqual(r.overview.caveats, []);
});

test('default-queue embed job waiting > 20m -> overdue with "waiting Nm"; <= 20m is not', async () => {
  const now = Date.now();
  const r = await overviewFor(healthPayload(3, YOUNG), {
    jobs: [HEALTHY_EMBED_JOB, job({ id: 8, status: 'waiting', created_at: new Date(now - 25 * 60000 - 5000).toISOString(), finished_at: null })],
    byType: [{ name: 'embed', waiting_now: 1, oldest_waiting_minutes: 25 }, { name: 'sync', waiting_now: 5, oldest_waiting_minutes: 300 }],
  });
  assertJobOverdue(r, 3, /embed job waiting 25m/);

  // A published (rounded) 19 proves nothing waits >= 19m30s: no waiting call.
  const calls = [];
  const below = await overviewFor(healthPayload(3, YOUNG), {
    byType: [{ name: 'embed-catch-up', waiting_now: 1, oldest_waiting_minutes: 19 }, { name: 'sync', waiting_now: 5, oldest_waiting_minutes: 300 }],
    calls,
  });
  assert.equal(below.health.metrics.missingEmbeddingsOverdue, 0);
  assert.equal(below.core.status, 'healthy');
  assert.ok(!calls.some((c) => c.includes('"status":"waiting"')), calls.join(' | '));
});

test('counterexample: GBrain rounds oldest_waiting_minutes — 20m29s published as 20 is queue-checked -> overdue', async () => {
  const now = Date.now();
  const waitingSeconds = 20 * 60 + 29;
  const calls = [];
  const r = await overviewFor(healthPayload(1, YOUNG), {
    jobs: [HEALTHY_EMBED_JOB, job({ id: 8, status: 'waiting', created_at: new Date(now - waitingSeconds * 1000).toISOString(), finished_at: null })],
    // Exactly what GBrain getStats publishes for that job.
    byType: [{ name: 'embed', waiting_now: 1, oldest_waiting_minutes: Math.round(waitingSeconds / 60) }],
    calls,
  });
  assert.equal(Math.round(waitingSeconds / 60), 20);
  assert.ok(calls.some((c) => c.includes('"name":"embed","status":"waiting"')), calls.join(' | '));
  assertJobOverdue(r, 1, /embed job waiting 20m/);
});

test('counterexample: reverse completion under worker concurrency — older-created job finished LATER with failures -> overdue', async () => {
  // A created 10:00, completed 10:30 with failures:2; B created 10:10,
  // completed cleanly 10:20. created_at DESC + limit 1 would return only B.
  const a = job({ id: 21, created_at: '2026-09-28T10:00:00.000Z', finished_at: '2026-09-28T10:30:00.000Z', result: { embedded: 5, failures: 2 } });
  const b = job({ id: 22, created_at: '2026-09-28T10:10:00.000Z', finished_at: '2026-09-28T10:20:00.000Z' });
  assert.deepEqual(listJobs([a, b], { name: 'embed', status: 'completed', queue: 'default', limit: 1 }).map((row) => row.id), [22]);
  const r = await overviewFor(healthPayload(1, YOUNG), { jobs: [a, b] });
  assertJobOverdue(r, 1, new RegExp(`embed job completed with 2 failures at ${clock(a.finished_at)}`));
  // Mirror: the hidden later completion is clean, the earlier-finished one failed -> clean (no false Degraded).
  const c = job({ id: 23, created_at: '2026-09-28T10:00:00.000Z', finished_at: '2026-09-28T10:30:00.000Z' });
  const d = job({ id: 24, created_at: '2026-09-28T10:10:00.000Z', finished_at: '2026-09-28T10:20:00.000Z', result: { embedded: 1, failures: 1 } });
  const clean = await overviewFor(healthPayload(1, YOUNG), { jobs: [c, d] });
  assert.equal(clean.health.metrics.missingEmbeddingsOverdue, 0);
  assert.equal(clean.core.status, 'healthy');
});

test('full terminal page that could hide a later-finished older job -> unavailable; a page spanning > max runtime is trusted', async () => {
  assert.equal(EMBED_JOB_TERMINAL_PAGE_LIMIT, 10);
  assert.equal(EMBED_JOB_MAX_RUNTIME_MS, 60 * 60 * 1000);
  const base = Date.parse('2026-09-28T10:00:00.000Z');
  const page = (stepMinutes) => Array.from({ length: 10 }, (_, i) => job({
    id: 100 + i,
    created_at: new Date(base + i * stepMinutes * 60000).toISOString(),
    finished_at: new Date(base + i * stepMinutes * 60000 + 60000).toISOString(),
  }));
  // Hidden 11th (older-created) completed row that finished last and failed.
  const hidden = job({ id: 99, created_at: new Date(base - 60000).toISOString(), finished_at: new Date(base + 40 * 60000).toISOString(), result: { failures: 3 } });
  const dense = await overviewFor(healthPayload(1, YOUNG), { jobs: [hidden, ...page(1)] });
  assertJobUnavailable(dense, 1, 'dense full page');
  // 10 ticks apart (spans 91 min > 60 min): the page is trusted.
  const sparse = await overviewFor(healthPayload(1, YOUNG), { jobs: page(10) });
  assert.equal(sparse.health.metrics.embedJobProbeUnavailable, false);
  assert.equal(sparse.core.status, 'healthy');
});

test('healthy latest embed job + young age -> catching up, no caveats', async () => {
  const r = await overviewFor(healthPayload(1, YOUNG), {
    byType: [{ name: 'embed', waiting_now: 1, oldest_waiting_minutes: 3 }],
  });
  assert.equal(r.health.metrics.missingEmbeddingsOverdue, 0);
  assert.equal(r.health.metrics.missingEmbeddingsCatchingUp, 1);
  assert.deepEqual(r.health.metrics.missingEmbeddingsJobReasons, []);
  assert.equal(r.health.metrics.embedJobProbeUnavailable, false);
  assert.equal(r.core.status, 'healthy');
  assert.equal(r.overview.trust.label, 'Live trusted');
  assert.deepEqual(r.overview.caveats, []);
});

test('seam: completed job with present-but-invalid result.failures -> unavailable + caveat, never clean', async () => {
  for (const failures of ['3', null, -1, NaN, true, {}]) {
    const rows = [job({ result: { embedded: 1, failures } })];
    assertJobUnavailable(await overviewFor(healthPayload(2, YOUNG), { jobs: rows }), 2, `failures ${JSON.stringify(failures)}`);
  }
  // Absent failures key is not a failure signal.
  const ok = await overviewFor(healthPayload(2, YOUNG), { jobs: [job({ result: { embedded: 1 } })] });
  assert.equal(ok.health.metrics.embedJobProbeUnavailable, false);
  assert.equal(ok.core.status, 'healthy');
});

test('job probe failure / unparseable -> age-only verdict + caveat; never healthier than the age rule', async () => {
  const failures = {
    throws: () => { throw Object.assign(new Error('boom'), { stderr: 'db busy' }); },
    notJson: () => ({ stdout: 'not json' }),
    object: () => ({ stdout: JSON.stringify({ jobs: [] }) }),
    badEntry: () => ({ stdout: JSON.stringify(['x']) }),
    badTimestamp: (params) => ({ stdout: JSON.stringify(listJobs([job({ finished_at: 'nope' })], params)) }),
    wrongQueueRow: (params) => ({ stdout: JSON.stringify(params.status === 'completed' && params.name === 'embed' ? [job({ queue: 'shell' })] : []) }),
  };
  for (const [label, jobs] of Object.entries(failures)) {
    assertJobUnavailable(await overviewFor(healthPayload(2, YOUNG), { jobs }), 2, label);
    // Old age: still overdue — the outage cannot relax the age rule.
    const old = await overviewFor(healthPayload(2, { missing_embeddings_oldest_age_seconds: 1500 }), { jobs });
    assert.equal(old.health.metrics.missingEmbeddingsOverdue, 2, label);
    assertDegraded(old, 2);
    assert.match(old.overview.caveats.join(' '), /Embed-job probe unavailable/, label);
  }
});

test('jobs stats without by_type -> queue-scoped waiting call decides; its failure is a caveat', async () => {
  const noByType = (listing) => async (bin, args) => {
    if (args.join(' ') === 'call --source __all__ get_health') return { stdout: JSON.stringify(healthPayload(1, YOUNG)), stderr: '' };
    if (args.join(' ') === 'jobs stats --json') return { stdout: JSON.stringify({ waiting: 0, active: 0, stalled: 0 }), stderr: '' };
    if (args[1] === 'list_jobs') return listing(JSON.parse(args[2]));
    throw new Error(`Unexpected command ${args.join(' ')}`);
  };
  const clean = await buildLiveGBrainHealth({ execFilePromise: noByType((params) => ({ stdout: JSON.stringify(listJobs([HEALTHY_EMBED_JOB], params)) })) });
  assert.equal(clean.metrics.embedJobProbeUnavailable, false);
  assert.equal(clean.metrics.missingEmbeddingsOverdue, 0);
  const broken = await buildLiveGBrainHealth({ execFilePromise: noByType((params) => {
    if (params.status === 'waiting') throw new Error('down');
    return { stdout: JSON.stringify(listJobs([job({ status: 'failed' })], params)) };
  }) });
  assert.equal(broken.metrics.embedJobProbeUnavailable, true);
});

test('missing = 0 ignores job state and does not spawn the job probes', async () => {
  const calls = [];
  const r = await overviewFor(healthPayload(0, { missing_embeddings_oldest_age_seconds: null }), {
    jobs: [job({ status: 'failed' })],
    byType: [{ name: 'embed', waiting_now: 4, oldest_waiting_minutes: 90 }],
    calls,
  });
  assert.equal(r.health.metrics.missingEmbeddingsOverdue, 0);
  assert.deepEqual(r.health.metrics.missingEmbeddingsJobReasons, []);
  assert.equal(r.health.metrics.embedJobProbeUnavailable, false);
  assert.equal(r.core.status, 'healthy');
  assert.deepEqual(r.overview.caveats, []);
  assert.ok(!calls.some((c) => c.includes('list_jobs')), calls.join(' | '));
});

test('job probes are bounded: serialized, queue-scoped per (name, status), first failure stops the chain', async () => {
  const calls = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const exec = execWithHealth(healthPayload(1, YOUNG), { calls });
  const wrapped = async (bin, args) => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try { await new Promise((resolve) => setImmediate(resolve)); return await exec(bin, args); } finally { inFlight -= 1; }
  };
  await buildLiveGBrainHealth({ execFilePromise: wrapped });
  assert.equal(maxInFlight, 1);
  assert.deepEqual(calls.filter((c) => c.includes('list_jobs')), [
    'call list_jobs {"name":"embed","status":"completed","queue":"default","limit":10}',
    'call list_jobs {"name":"embed","status":"failed","queue":"default","limit":10}',
    'call list_jobs {"name":"embed","status":"dead","queue":"default","limit":10}',
    'call list_jobs {"name":"embed-catch-up","status":"completed","queue":"default","limit":10}',
    'call list_jobs {"name":"embed-catch-up","status":"failed","queue":"default","limit":10}',
    'call list_jobs {"name":"embed-catch-up","status":"dead","queue":"default","limit":10}',
  ]);

  const failCalls = [];
  await buildLiveGBrainHealth({ execFilePromise: execWithHealth(healthPayload(1, YOUNG), {
    calls: failCalls,
    jobs: () => { throw new Error('down'); },
  }) });
  assert.equal(failCalls.filter((c) => c.includes('list_jobs')).length, 1);
});

test('slow chain: embed-job probes stop at the shared budget, report unavailable, and fit the Operations deadline', async () => {
  const gbrainConstants = require('../server/routes/gbrain/constants');
  let clockMs = 0;
  const calls = [];
  // Every command takes just under the soft window on a loaded machine.
  const perCallMs = gbrainConstants.HEALTH_PROBE_SOFT_TIMEOUT_MS - 1;
  const health = await buildLiveGBrainHealth({
    now: () => clockMs,
    execFilePromise: execWithHealth(healthPayload(1, YOUNG), { calls, onCall: () => { clockMs += perCallMs; } }),
  });
  const jobCalls = calls.filter((c) => c.includes('list_jobs')).length;
  assert.ok(jobCalls >= 1 && jobCalls <= Math.ceil(gbrainConstants.EMBED_JOB_PROBE_BUDGET_MS / perCallMs), `job calls ${jobCalls}`);
  assert.equal(health.metrics.embedJobProbeUnavailable, true);
  assert.equal(health.metrics.missingEmbeddingsOverdue, 0);
  // Whole chain (health + jobs + budgeted job probes + stats backfill) stays
  // inside the Operations reader deadline with room for the hard-kill tail.
  assert.ok(clockMs + gbrainConstants.HEALTH_PROBE_HARD_KILL_DELAY_MS < gbrainConstants.GBRAIN_OPERATIONS_SOURCE_TIMEOUT_MS,
    `chain ${clockMs}ms vs deadline ${gbrainConstants.GBRAIN_OPERATIONS_SOURCE_TIMEOUT_MS}ms`);
});

test('a timed-out (pending) embed-job probe stops the chain, including the stats backfill', async () => {
  const calls = [];
  const payload = healthPayload(1, YOUNG);
  delete payload.chunk_count;
  const health = await buildLiveGBrainHealth({
    execFilePromise: async () => { throw new Error('unused'); },
    probeCommand: async (_exec, args) => {
      calls.push(args.join(' '));
      if (args.join(' ') === 'call --source __all__ get_health') return { ok: true, stdout: JSON.stringify(payload) };
      if (args.join(' ') === 'jobs stats --json') return { ok: true, stdout: JSON.stringify({ waiting: 0, active: 0, stalled: 0, by_type: [] }) };
      if (args[1] === 'list_jobs') return { ok: false, pending: true, error: 'soft timeout' };
      throw new Error(`Unexpected command ${args.join(' ')}`);
    },
  });
  assert.equal(health.metrics.embedJobProbeUnavailable, true);
  assert.equal(calls.filter((c) => c.includes('list_jobs')).length, 1);
  assert.ok(!calls.some((c) => c.startsWith('stats')), calls.join(' | '));
});

test('evaluateEmbedJobSignal: undefined job input is unavailable, never a pass', () => {
  assert.deepEqual(evaluateEmbedJobSignal(undefined, { by_type: [] }), { available: false, reasons: [] });
  const empty = { available: true, terminal: {}, waiting: {} };
  assert.equal(evaluateEmbedJobSignal(empty, { by_type: [] }).available, false);
});

test('counterexample: equal finished_at with conflicting outcomes -> the worse outcome wins (review round 3)', async () => {
  const same = '2026-09-28T10:30:00.123Z';
  for (const order of [0, 1]) {
    const clean = job({ id: 41, created_at: '2026-09-28T10:00:00.000Z', finished_at: same });
    const failed = job({ id: 42, status: 'failed', created_at: '2026-09-28T10:01:00.000Z', finished_at: same, result: null });
    const r = await overviewFor(healthPayload(1, YOUNG), { jobs: order ? [failed, clean] : [clean, failed] });
    assertJobOverdue(r, 1, new RegExp(`embed job failed at ${clock(same)}`));
  }
  const cleanA = job({ id: 43, created_at: '2026-09-28T10:00:00.000Z', finished_at: same });
  const withFailures = job({ id: 44, created_at: '2026-09-28T10:01:00.000Z', finished_at: same, result: { embedded: 1, failures: 3 } });
  const r2 = await overviewFor(healthPayload(1, YOUNG), { jobs: [cleanA, withFailures] });
  assertJobOverdue(r2, 1, /embed job completed with 3 failures/);
});
