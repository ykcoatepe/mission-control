// Operations overview composed from scheduled sources (memory only), plus
// GET /api/signals. Counter-examples for: no request-time read, failed read
// keeps last-good, aged-out evidence is unavailable (never healthy), no
// fabricated values.

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { createSource } = require('../server/core/source');
const { errorHandler } = require('../server/core/http');
const {
  OPERATIONS_SOURCE_NAMES,
  createOperationsSources,
  createOperationsOverviewService,
} = require('../server/services/operationsOverview');
const { buildOperationsRouter } = require('../server/routes/operations');
const { buildSignalsRouter, usageFromSibling } = require('../server/routes/signals');

const T0 = Date.parse('2026-07-10T12:00:00.000Z');
const generatedAt = new Date(T0).toISOString();

function healthyValues() {
  const proof = (provenance) => ({ sourceSucceeded: true, provenance, observedAt: generatedAt });
  return {
    status: { generatedAt, operationsSource: proof('openclaw-status-cli'), agent: { activeSessions: 2, channels: ['telegram'] }, heartbeat: { lastHeartbeat: T0 } },
    sessions: { generatedAt, operationsSource: proof('openclaw-sessions-cli'), count: 2, sessions: [{ key: 'a', isActive: true }, { key: 'b', isActive: true }] },
    cron: {
      operationsSource: { ...proof('scheduler-readers'), schedulers: { openclaw: proof('openclaw-cron-cli'), hermes: proof('hermes-cron-disk') } },
      jobs: [
        { id: 'openclaw:a', scheduler: 'openclaw', enabled: true, status: 'failed', nextRun: '2026-07-10T13:00:00.000Z' },
        { id: 'hermes:a', scheduler: 'hermes', enabled: true, status: 'active', nextRun: '2026-07-10T12:30:00.000Z' },
      ],
    },
    hermes: { ok: true, refreshedAt: generatedAt, summary: { active: 2, running: 1, blocked: 0, total: 9 } },
    hermesGateway: { ok: true, status: 'running', pid: 42, observedAt: generatedAt, heartbeatAt: generatedAt },
    gbrain: {
      ok: true,
      trust: { status: 'healthy', score: 100, label: 'Live trusted', lastVerifiedAt: generatedAt },
      caveats: [],
      live: { sources: { freshness: { staleCount: 0 } } },
    },
  };
}

function harness({ values = healthyValues(), overrides = {} } = {}) {
  let nowMs = T0;
  const calls = Object.fromEntries(OPERATIONS_SOURCE_NAMES.map((name) => [name, 0]));
  const behaviour = {};
  const readers = Object.fromEntries(OPERATIONS_SOURCE_NAMES.map((name) => [name, async () => {
    calls[name] += 1;
    if (behaviour[name]) return behaviour[name]();
    return values[name];
  }]));
  const entries = createOperationsSources({ readers, createSource, now: () => nowMs, sourceTimeoutMsOverrides: overrides });
  const sources = Object.fromEntries(Object.entries(entries).map(([name, entry]) => [name, entry.source]));
  const service = createOperationsOverviewService({ sources, listCapabilities: () => [], now: () => new Date(nowMs) });
  return {
    entries,
    sources,
    service,
    calls,
    behaviour,
    setNow(ms) { nowMs = ms; },
    async refreshAll() { await Promise.all(Object.values(sources).map((source) => source.refresh())); },
  };
}

test('every Operations reader becomes a source with the budgeted interval and GBrain deadline', () => {
  const { entries } = harness({ overrides: { gbrain: 285_000 } });
  assert.deepEqual(Object.keys(entries), ['status', 'sessions', 'cron', 'hermes', 'hermesGateway', 'gbrain']);
  assert.equal(entries.gbrain.source.status().timeoutMs, 285_000);
  assert.equal(entries.gbrain.intervalMs, 60_000);
  assert.equal(entries.hermes.intervalMs, 30_000);
  assert.equal(entries.status.source.id, 'operations.status');
  assert.throws(() => createOperationsOverviewService({ sources: { status: entries.status.source } }), /sources missing/);
});

test('the overview composes from memory: a GET runs no reader, and unobserved systems are unavailable, never healthy', async () => {
  const h = harness();
  const overview = await h.service.getOverview();
  assert.deepEqual(Object.values(h.calls), [0, 0, 0, 0, 0, 0], 'a request ran a reader');
  for (const id of ['openclaw', 'hermes', 'gbrain']) assert.equal(overview.systems[id].state, 'unavailable');
  assert.equal(overview.systems.openclaw.metrics.activeSessions, undefined);
  assert.equal(overview.meta.ok, false);
  assert.equal(overview.meta.stale, true);
});

test('after the scheduled refresh the memory overview equals the live overview shape', async () => {
  const h = harness();
  await h.refreshAll();
  const fromMemory = await h.service.getOverview();
  const live = await createOperationsOverviewService({
    readers: Object.fromEntries(Object.entries(healthyValues()).map(([name, value]) => [name, async () => value])),
    listCapabilities: () => [],
    now: () => new Date(T0),
  }).getOverview();
  const { meta, ...withoutMeta } = fromMemory;
  assert.deepEqual(withoutMeta, live);
  assert.equal(meta.ok, true);
  assert.equal(meta.source, 'operations.overview');
  assert.deepEqual(Object.keys(meta.sources), OPERATIONS_SOURCE_NAMES);
  assert.equal(fromMemory.systems.hermes.state, 'healthy');
});

test('a failed or unavailable read keeps last-good evidence and marks the source stale', async () => {
  const h = harness();
  await h.refreshAll();
  h.behaviour.gbrain = async () => { throw new Error('Bearer secret at /Users/example'); };
  h.behaviour.hermesGateway = async () => ({ ok: false, unavailable: true, error: 'state unreadable' });
  h.setNow(T0 + 30_000);
  await h.sources.gbrain.refresh();
  await h.sources.hermesGateway.refresh();
  const overview = await h.service.getOverview();
  assert.equal(overview.systems.gbrain.state, 'healthy', 'last good GBrain evidence was dropped');
  assert.equal(overview.systems.hermes.state, 'healthy');
  assert.equal(overview.meta.sources.gbrain.stale, true);
  assert.equal(overview.meta.sources.hermesGateway.error.code, 'hermesGateway_unavailable');
  assert.equal(overview.meta.ok, false);
  assert.doesNotMatch(JSON.stringify(overview), /Bearer secret|\/Users\//);
});

test('evidence older than its freshness limit is unavailable, not silently current', async () => {
  const h = harness();
  await h.refreshAll();
  const limit = h.sources.hermesGateway.status().staleAfterMs;
  assert.ok(h.sources.gbrain.status().staleAfterMs > limit);
  h.setNow(T0 + limit + 1);
  const overview = await h.service.getOverview();
  // Hermes and OpenClaw status evidence aged out: unavailable, not their last
  // state. (Sessions refresh every 60 s, so their horizon is still open.)
  assert.equal(overview.systems.hermes.state, 'unavailable');
  assert.ok(overview.attention.some((item) => item.reasonCode === 'hermes_unavailable'));
  assert.ok(overview.attention.some((item) => item.reasonCode === 'openclaw_status_unavailable'));
  // GBrain refreshes every 3 minutes, so its horizon is longer.
  assert.equal(overview.systems.gbrain.state, 'healthy');
});

test('Hermes liveness-first semantics hold through the memory path', async () => {
  const values = healthyValues();
  values.hermesGateway = { ok: true, status: 'down', pid: 1, observedAt: generatedAt, heartbeatAt: generatedAt };
  values.hermes = { ok: true, stale: true, staleAgeMs: 90_000, refreshedAt: generatedAt, summary: { total: 3, active: 1, running: 1, blocked: 0 } };
  const h = harness({ values });
  await h.refreshAll();
  const overview = await h.service.getOverview();
  assert.equal(overview.systems.hermes.state, 'critical');
  assert.equal(overview.systems.hermes.freshness, 'stale');
});

test('GET /api/operations/overview answers from memory while every reader hangs', async () => {
  const h = harness();
  await h.refreshAll();
  for (const name of OPERATIONS_SOURCE_NAMES) h.behaviour[name] = () => new Promise(() => {});
  const app = express();
  app.use(buildOperationsRouter({ operationsOverviewService: h.service }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    const started = Date.now();
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/operations/overview`);
    const elapsed = Date.now() - started;
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.schemaVersion, '1');
    assert.ok(body.meta);
    // Every reader hangs forever, so any answer proves the route did not wait
    // on one; the bound only guards against a pathological stall and is wide
    // enough not to flake under full-suite load.
    assert.ok(elapsed < 2000, `overview took ${elapsed} ms`);
    assert.deepEqual(Object.values(h.calls), [1, 1, 1, 1, 1, 1]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

// --- signals ---------------------------------------------------------------

function snapshotSource(data, meta = {}) {
  return { snapshot: () => ({ data, meta: { ok: data != null, stale: data == null, observedAt: data ? generatedAt : null, ageMs: data ? 0 : null, error: null, latencyMs: 1, source: 'x', ...meta } }) };
}

async function getSignals(options) {
  const app = express();
  app.use(buildSignalsRouter(options));
  app.use(errorHandler({ logger: { error() {} } }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/signals`);
    return { status: response.status, body: await response.json() };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('signals: nothing observed yields nulls and unavailable systems, never zeros', async () => {
  const h = harness();
  const { status, body } = await getSignals({
    operationsOverviewService: h.service,
    operationsSources: h.sources,
    loopsSource: snapshotSource(null),
    launchdSource: snapshotSource(null),
    reachabilitySource: snapshotSource(null),
    now: () => T0,
  });
  assert.equal(status, 200);
  assert.deepEqual(Object.keys(body.data), ['generatedAt', 'systems', 'attention', 'automations', 'loops', 'services', 'usage']);
  assert.deepEqual(body.data.systems.gbrain, { state: 'unavailable', observedAt: null, reason: 'GBrain overview could not be read.', detailHref: '/gbrain' });
  assert.equal(body.data.automations, null);
  assert.equal(body.data.loops, null);
  assert.equal(body.data.services, null);
  assert.equal(body.data.usage, null);
  assert.equal(body.meta.ok, false);
  assert.deepEqual(Object.values(h.calls), [0, 0, 0, 0, 0, 0]);
});

test('signals compose loops, services, automations and usage from memory', async () => {
  const h = harness();
  await h.refreshAll();
  const loops = {
    observedAt: generatedAt,
    projects: [
      { id: 'argus-x', restricted: true, openFindings: 2, pendingConfirmations: 1, overdueConfirmations: 1, operatorFindings: 1, operatorConfirmations: 1, worstSeverity: 'warning', countsBasis: 'mloop-check' },
      {
        id: 'p', restricted: false, title: 'p', outcome: null, openFindings: { total: 1, bySeverity: { error: 1, warning: 0, info: 0 }, byCode: { X: 1 } },
        pendingConfirmations: [{ unit: 'u', verification: 'v', deadline: '2026-07-09T00:00:00Z', overdue: true }], participants: [], lastActivityAt: null, errors: [],
        findings: [{ code: 'X', severity: 'error', subject: 's', detail: 'd', summary: 'd' }], statusMarkdown: '',
      },
    ],
    attention: [
      { project: 'p', kind: 'finding', severity: 'error', code: 'X' },
      { project: 'p', kind: 'finding', severity: 'info', code: 'Y' },
      { project: 'argus-x', kind: 'restricted', restricted: true, severity: 'warning', count: 2 },
    ],
  };
  const { body } = await getSignals({
    operationsOverviewService: h.service,
    operationsSources: h.sources,
    loopsSource: snapshotSource(loops),
    launchdSource: snapshotSource({ services: [], counts: { total: 3, running: 1, idle: 0, down: 1, failed: 1 } }),
    reachabilitySource: snapshotSource({ gateways: { openclaw: { state: 'down' }, hermes: { state: 'up' } }, ollama: { state: 'unknown' } }),
    usageSummary: () => ({ todayUsd: 3.5, budgetUsedPct: 41 }),
    now: () => T0,
  });
  assert.deepEqual(body.data.systems.hermes, { state: 'healthy', observedAt: generatedAt, reason: null, detailHref: '/work' });
  assert.deepEqual(body.data.loops, { openFindings: 3, overdueConfirmations: 2 });
  assert.deepEqual(body.data.services, { down: 3 });
  assert.deepEqual(body.data.automations, { failed: 1, nextRunAt: '2026-07-10T12:30:00.000Z' });
  assert.deepEqual(body.data.usage, { todayUsd: 3.5, budgetUsedPct: 41 });
  // Systems are healthy: p's error finding + p's overdue confirmation +
  // argus-x by counts only (1 operator finding + 1 overdue).
  assert.deepEqual(body.data.attention, {
    count: 4, worst: 'critical', breakdown: { systems: 0, findings: 1, overdueConfirmations: 1, restricted: 2 }, partial: false, missing: [],
  });
  assert.doesNotMatch(JSON.stringify(body), /argus-x/, 'signals carry no restricted project identity');
});

test('signals prefer the automations source summary when one exists', async () => {
  const h = harness();
  const { body } = await getSignals({
    operationsOverviewService: h.service,
    loopsSource: snapshotSource(null),
    launchdSource: snapshotSource(null),
    reachabilitySource: snapshotSource(null),
    automationsSnapshot: () => ({ data: { cron: { summary: { active: 4, paused: 0, failed: 2, nextRunAt: '2026-07-10T14:00:00.000Z' } } }, meta: { ok: true } }),
  });
  assert.deepEqual(body.data.automations, { failed: 2, nextRunAt: '2026-07-10T14:00:00.000Z' });
});

test('usage lookup is defensive: absent, failing or non-numeric usage is null', () => {
  assert.equal(usageFromSibling(undefined), null);
  assert.equal(usageFromSibling({}), null);
  assert.equal(usageFromSibling({ summary: () => { throw new Error('boom'); } }), null);
  assert.equal(usageFromSibling({ summary: () => ({ data: null, meta: { ok: false } }) }), null);
  assert.deepEqual(
    usageFromSibling({ summary: () => ({ data: { today: { apiEquivalentUsd: 1.25 }, budget: { monthly: 100, usedPct: 12 } }, meta: { ok: true } }) }),
    { todayUsd: 1.25, budgetUsedPct: 12 },
  );
  assert.deepEqual(
    usageFromSibling({ snapshot: () => ({ data: { today: { apiEquivalentUsd: 'n/a' }, budget: { usedPct: null } }, meta: {} }) }),
    { todayUsd: null, budgetUsedPct: null },
  );
});
