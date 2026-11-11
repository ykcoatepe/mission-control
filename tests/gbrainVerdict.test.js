'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createGBrainOverviewService } = require('../server/services/gbrainOverviewData');
const { normalizeSourcesPayload, sourceFreshnessStatus } = require('../server/routes/gbrain/liveProbes');
const { buildOperationsOverview, createOperationsReaders, createOperationsSources, createOperationsOverviewService } = require('../server/services/operationsOverview');
const { createSource } = require('../server/core/source');
const at = '2026-11-11T12:00:00.000Z';
function serviceFixture(kind) {
  let fail = false;
  const raw = kind === 'excluded-source'
    ? [{ source_id: 'tk-omc-ain', sync_enabled: false, status: 'unknown' }, { source_id: 'isolated', federated: false }]
    : [{ source_id: 'project', sync_enabled: true, last_sync_at: kind === 'one-stale-source' ? '2026-11-09T12:00:00.000Z' : at }];
  const service = createGBrainOverviewService({ now: () => Date.parse(at), probes: {
    health: async () => { if (fail) throw Error('private'); return { ok: true, status: 'healthy', score: 100, checkedAt: at,
      metrics: { missingEmbeddings: 0, stalePages: 0 } }; },
    sources: async () => normalizeSourcesPayload(raw, at),
    version: async () => ({ ok: true, version: '1.2.3' }), stats: async () => ({ pages: 12, chunks: 34, embedded: 34 }),
    jobs: async () => ({ waiting: 0, active: 0, stalled: 0 }),
  }, buildIntegrationRuntime: () => ({ readers: [] }), timelineService: { captureOverview: async () => ({}), readTimeline: () => ({ entries: [] }) } });
  return { service, fail: () => { fail = true; } };
}
for (const [kind, expected] of [['healthy', 'healthy'], ['one-stale-source', 'warning'], ['probe-unavailable', 'unavailable'], ['excluded-source', 'healthy']]) {
  test(`shared verdict agrees for ${kind}`, async () => {
    const fixture = serviceFixture(kind); await fixture.service.refresh();
    if (kind === 'probe-unavailable') { fixture.fail(); await fixture.service.refresh(); }
    const syn = fixture.service.synopticSnapshot().data;
    const overview = fixture.service.getOverview();
    const ops = buildOperationsOverview({ gbrain: overview }, { generatedAt: at }).systems.gbrain;
    assert.equal(syn.verdict.state, expected); assert.equal(syn.state, expected);
    assert.deepEqual(overview.verdict, syn.verdict); assert.equal(overview.trust.status, expected);
    assert.equal(ops.state, expected); assert.deepEqual(ops.caveats, overview.caveats);
    assert.deepEqual(overview.caveats, syn.verdict.reasons.filter((r) => ['warning', 'critical', 'unavailable'].includes(r.state)).map((r) => r.text));
    if (kind === 'excluded-source') {
      assert.equal(overview.nodes.find((node) => node.id === 'sources').status, 'inactive');
      assert.equal(overview.cockpit.freshness.value, 'Not applicable');
    }
    if (kind === 'excluded-source') for (const s of syn.sources.flatMap((g) => g.items)) {
      assert.equal(s.state, 'inactive'); assert.equal(s.excludedByPolicy, true); assert.ok(s.reason);
    }
    if (kind === 'one-stale-source') {
      const s = syn.sources[0].items[0]; assert.equal(s.ageHours, 48); assert.equal(s.thresholdHours, 24);
    }
  });
}
test('normalized not-applicable classification survives re-evaluation without local paths', () => {
  const input = [ { id: 'isolated', federated: false }, { id: 'default', local_path: '/private/curated', last_sync_at: at } ];
  const normalized = normalizeSourcesPayload(input, at);
  assert.equal(sourceFreshnessStatus(normalized.sources[0], null, at).syncTracked, false);
  assert.equal(sourceFreshnessStatus(normalized.sources[1], at, at).syncTracked, true);
  assert.doesNotMatch(JSON.stringify(normalized), /private\/curated/);
});
test('tracked sources without a sync timestamp say never synced', async () => {
  const service = createGBrainOverviewService({ now: () => Date.parse(at), probes: {
    sources: async () => normalizeSourcesPayload([{ id: 'pdfquickfix', sync_enabled: true }], at),
  }, buildIntegrationRuntime: () => ({}), timelineService: { captureOverview: async () => ({}), readTimeline: () => ({ entries: [] }) } });
  await service.refresh(); const s = service.synopticSnapshot().data.sources[0].items[0];
  assert.equal(s.state, 'warning'); assert.equal(s.reason, 'never synced'); assert.equal(s.excludedByPolicy, false);
});
test('Operations reads the current GBrain verdict without a second cache refresh', async () => {
  const fixture = serviceFixture('healthy'); await fixture.service.refresh();
  const readers = createOperationsReaders({ gbrainOverviewService: fixture.service });
  const entries = createOperationsSources({ readers, createSource, now: () => Date.parse(at) });
  await entries.gbrain.source.refresh();
  const sources = Object.fromEntries(Object.entries(entries).map(([name, value]) => [name, value.source]));
  const ops = createOperationsOverviewService({ sources, now: () => new Date(at) });
  assert.equal((await ops.getOverview()).systems.gbrain.state, 'healthy');
  fixture.fail(); await fixture.service.refresh();
  assert.equal((await ops.getOverview()).systems.gbrain.state, 'unavailable');
});

test('embed-job unavailability is an unavailable reason in every verdict and caveat list', async () => {
  const service = createGBrainOverviewService({ now: () => Date.parse(at), probes: {
    health: async () => ({ ok: true, status: 'healthy', score: 100, metrics: { embedJobProbeUnavailable: true } }),
    sources: async () => normalizeSourcesPayload([{ id: 'project', last_sync_at: at }], at),
    stats: async () => ({ pages: 12, chunks: 34, embedded: 34 }), jobs: async () => ({ waiting: 0, active: 0, stalled: 0 }),
    version: async () => ({ version: '1.2.3', ok: true }),
  }, buildIntegrationRuntime: () => ({ readers: [] }), timelineService: { captureOverview: async () => ({}), readTimeline: () => ({ entries: [] }) } });
  await service.refresh();
  const syn = service.synopticSnapshot().data; const overview = service.getOverview();
  const ops = buildOperationsOverview({ gbrain: overview }, { generatedAt: at }).systems.gbrain;
  const reason = syn.verdict.reasons.find((r) => r.elementId === 'embed-job-probe');
  assert.equal(reason.state, 'unavailable'); assert.equal(syn.state, 'unavailable');
  assert.equal(overview.state, syn.state); assert.equal(ops.state, syn.state);
  assert.ok(overview.caveats.includes(reason.text)); assert.deepEqual(ops.caveats, overview.caveats);
});

test('GET synoptic, GBrain overview, Operations and signals agree on the same four fixtures', async () => {
  const express = require('express');
  const { buildGBrainRouter } = require('../server/routes/gbrain/router');
  const { buildOperationsRouter } = require('../server/routes/operations');
  const { buildSignalsRouter } = require('../server/routes/signals');
  for (const [kind, expected] of [['healthy', 'healthy'], ['one-stale-source', 'warning'], ['probe-unavailable', 'unavailable'], ['excluded-source', 'healthy']]) {
    const fixture = serviceFixture(kind); await fixture.service.refresh();
    const readers = createOperationsReaders({ gbrainOverviewService: fixture.service });
    const entries = createOperationsSources({ readers, createSource });
    const sources = Object.fromEntries(Object.entries(entries).map(([key, value]) => [key, value.source]));
    const operations = createOperationsOverviewService({ sources, now: () => new Date(at) });
    const unknown = { snapshot: () => ({ data: null, meta: { ok: false, stale: true, observedAt: null } }) };
    const app = express();
    app.use(buildGBrainRouter({ gbrainOverviewService: fixture.service }));
    app.use(buildOperationsRouter({ operationsOverviewService: operations }));
    app.use(buildSignalsRouter({ operationsOverviewService: operations, operationsSources: sources,
      loopsSource: unknown, launchdSource: unknown, reachabilitySource: unknown }));
    const server = app.listen(0, '127.0.0.1'); await new Promise((resolve) => server.once('listening', resolve));
    try {
      if (kind === 'probe-unavailable') { fixture.fail(); await fixture.service.refresh(); }
      const base = `http://127.0.0.1:${server.address().port}/api`;
      const [syn, overview, ops, signals] = await Promise.all(['gbrain/synoptic', 'gbrain/overview', 'operations/overview', 'signals']
        .map(async (url) => { const response = await fetch(`${base}/${url}`); assert.equal(response.status, 200); return response.json(); }));
      assert.equal(syn.data.verdict.state, expected, kind); assert.equal(overview.state, expected, kind);
      assert.equal(ops.systems.gbrain.state, expected, kind); assert.equal(signals.data.systems.gbrain.state, expected, kind);
      assert.deepEqual(overview.verdict.reasons, syn.data.verdict.reasons); assert.deepEqual(ops.systems.gbrain.caveats, overview.caveats);
    } finally { await new Promise((resolve) => server.close(resolve)); }
  }
});
