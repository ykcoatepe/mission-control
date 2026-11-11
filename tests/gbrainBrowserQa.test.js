'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { normalizeSnapshot, readTimeline, captureSnapshotIfNeeded, fingerprintSnapshot } = require('../server/services/gbrainTimeline');
const { createGBrainOverviewService } = require('../server/services/gbrainOverviewData');
const { normalizeSourcesPayload } = require('../server/routes/gbrain/liveProbes');
const { worstState, STATE_ORDER } = require('../server/core/state');
const { buildOperationsOverview } = require('../server/services/operationsOverview');
const at = '2026-11-11T12:00:00.000Z';
function fixture({ readers = [], sources = [], failRuntime = false } = {}) {
  return createGBrainOverviewService({ now: () => Date.parse(at), probes: {
    health: async () => ({ ok: true, status: 'healthy', score: 100, metrics: { missingEmbeddings: 4, missingEmbeddingsOverdue: 0, stalePages: 0 } }),
    stats: async () => ({ pages: 63000, chunks: 420000, embedded: 419084 }),
    sources: async () => normalizeSourcesPayload(sources, at),
    version: async () => ({ ok: true, version: 'test' }), jobs: async () => ({ waiting: 0, active: 0, stalled: 0 }),
  }, buildIntegrationRuntime: () => { if (failRuntime) throw Error('private'); return { readers }; },
  timelineService: { captureOverview: async () => ({}), readTimeline: () => ({ entries: [] }) } });
}
function reading(age, state = 'unavailable', count = 4, reason = 'Health probe unavailable.') {
  return { refreshedAt: new Date(Date.parse(at) + age * 1000).toISOString(),
    verdict: { state, reasons: [{ elementId: 'gbrain.health', state, text: reason }] },
    // A legacy tile cannot override the single verdict.
    trust: { status: 'critical', label: 'GBrain unavailable', score: null },
    cockpit: { embeddings: { value: '99%', detail: `${count} missing; oldest ${age}s` }, queue: { value: '0 / 0 / 0' } },
    live: { health: { metrics: { missingEmbeddings: count, missingEmbeddingsOldestAgeSeconds: age } } } };
}
function ledger(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-gbrain-qa-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return path.join(dir, 'timeline.jsonl'); }
test('QA1 new timeline entries preserve every shared verdict state', () => {
  for (const state of STATE_ORDER) assert.equal(normalizeSnapshot(reading(1, state)).trust.status, worstState([state]));
});
test('QA1 legacy unavailable entries map on read without rewriting the ledger', (t) => {
  const p = ledger(t); const old = { trust: { status: 'critical', label: 'GBrain unavailable' } };
  const bytes = [JSON.stringify(old), JSON.stringify({ trust: { status: 'critical', label: 'Actual critical condition' } })].join('\n');
  fs.writeFileSync(p, bytes);
  assert.deepEqual(readTimeline({ ledgerPath: p }).entries.map((e) => e.trust.status), ['unavailable', 'critical']);
  assert.equal(fs.readFileSync(p, 'utf8'), bytes);
});
test('QA2 age-only refresh sequence never appends, even after an hour; counts, states and reasons do', async (t) => {
  const p = ledger(t);
  for (const [index, age] of [1, 181, 361, 4001].entries()) {
    const result = await captureSnapshotIfNeeded(reading(age), { ledgerPath: p });
    assert.equal(result.captured, index === 0, `age ${age}`);
  }
  for (const next of [reading(4200, 'unavailable', 5), reading(4380, 'warning', 5), reading(4560, 'warning', 5, 'A new verdict reason.')]) {
    assert.equal((await captureSnapshotIfNeeded(next, { ledgerPath: p })).captured, true);
  }
  assert.equal(readTimeline({ ledgerPath: p }).entries.length, 4);
});
test('QA2 derived presentation text is excluded but verdict reasons remain material', () => {
  const a = normalizeSnapshot(reading(1)); const b = normalizeSnapshot(reading(181));
  b.trust.label = 'Presentation change'; b.bridgeProof = [];
  assert.equal(fingerprintSnapshot(a), fingerprintSnapshot(b));
  const c = normalizeSnapshot(reading(181, 'unavailable', 4, 'Different reason.'));
  assert.notEqual(fingerprintSnapshot(a), fingerprintSnapshot(c));
});
test('QA3 configuration alone is inactive, unreadable stays unavailable and no chip borrows reader proof', async () => {
  for (const failRuntime of [false, true]) {
    const service = fixture({ failRuntime, readers: [
      { id: 'hermes', label: 'Hermes', configured: true, observed: true, evidence: 'local MCP configuration' },
      { id: 'openclaw', label: 'OpenClaw', configured: false, observed: true, evidence: 'local MCP configuration' },
      { id: 'codex', label: 'Codex', configured: null, observed: false, evidence: 'configuration not read' },
    ] });
    await service.refresh(); const s = service.synopticSnapshot().data;
    if (failRuntime) { assert.equal(s.readersState, 'unavailable'); continue; }
    assert.deepEqual(s.readers.map((r) => r.observation), ['configured', 'not_configured', 'unreadable']);
    assert.deepEqual(s.readers.map((r) => r.state), ['inactive', 'inactive', 'unavailable']);
    assert.equal(s.readersState, worstState(s.readers.map((r) => r.state)));
    assert.equal(s.readers[0].integration.state, 'healthy');
    assert.equal(s.edges.find((e) => e.from === 'hermes').state, 'inactive');
    const ops = buildOperationsOverview({ gbrain: service.getOverview() }, { generatedAt: at });
    assert.equal(ops.systems.hermes.state, 'unavailable'); assert.equal(ops.systems.openclaw.state, 'unavailable');
    assert.ok(!ops.systems.gbrain.caveats.some((text) => /not configured/.test(text)));
  }
  const service = fixture({ readers: [{ id: 'hermes', label: 'Hermes', configured: true, observed: true }] });
  await service.refresh(); assert.equal(service.synopticSnapshot().data.readersState, 'inactive');
  assert.equal(service.synopticSnapshot().data.state, 'healthy');
});
test('QA4 sources GET and synoptic use identical sync-disabled classification', async (t) => {
  const express = require('express'); const { buildGBrainRouter } = require('../server/routes/gbrain/router');
  const service = fixture({ sources: [{ id: 'disabled', sync_enabled: false, excluded_by_policy: false }, { id: 'tracked', sync_enabled: true, last_sync_at: at }] });
  await service.refresh(); const app = express(); app.use(buildGBrainRouter({ gbrainOverviewService: service }));
  const server = app.listen(0, '127.0.0.1'); await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const legacy = await (await fetch(base + '/api/gbrain/sources')).json();
  const syn = await (await fetch(base + '/api/gbrain/synoptic')).json();
  for (const source of legacy.sources) {
    const item = syn.data.sources.flatMap((g) => g.items).find((s) => s.id === source.id);
    assert.equal(source.excludedByPolicy, item.excludedByPolicy); assert.equal(source.reason, item.reason);
  }
  assert.equal(legacy.sources[0].excludedByPolicy, true); assert.equal(legacy.sources[0].reason, 'sync disabled');
});
test('QA5 unexplained chunk delta never becomes an invented not-embeddable count', async () => {
  const service = fixture(); await service.refresh(); const core = service.synopticSnapshot().data.core;
  assert.equal(core.chunks.value - core.embedded.value, 916);
  assert.equal(Object.hasOwn(core, 'notEmbeddable'), false);
});
test('QA3 synoptic-to-Operations-to-Signals seam keeps system chips on their own evidence', async (t) => {
  const express = require('express');
  const { buildGBrainRouter } = require('../server/routes/gbrain/router');
  const { buildOperationsRouter } = require('../server/routes/operations');
  const { buildSignalsRouter } = require('../server/routes/signals');
  const { errorHandler } = require('../server/core/http');
  const service = fixture({ readers: ['hermes', 'openclaw'].map((id) => ({ id, label: id, configured: true, observed: true })) });
  await service.refresh();
  let own = {};
  const operations = { getOverview: () => buildOperationsOverview({ ...own, gbrain: service.getOverview() }, { generatedAt: at }) };
  const unknown = { snapshot: () => ({ data: null, meta: { ok: false, stale: true, observedAt: null } }) };
  const app = express(); app.use(buildGBrainRouter({ gbrainOverviewService: service }));
  app.use(buildOperationsRouter({ operationsOverviewService: operations }));
  app.use(buildSignalsRouter({ operationsOverviewService: operations, loopsSource: unknown, launchdSource: unknown, reachabilitySource: unknown }));
  app.use(errorHandler({ logger: { error() {} } }));
  const server = app.listen(0, '127.0.0.1'); await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const proof = (provenance) => ({ sourceSucceeded: true, provenance, observedAt: at });
  for (const input of [{}, {
    status: { generatedAt: at, operationsSource: proof('openclaw-status-cli'), agent: { activeSessions: 0 }, heartbeat: { lastHeartbeat: Date.parse(at) } },
    sessions: { generatedAt: at, operationsSource: proof('openclaw-sessions-cli'), sessions: [] },
    cron: { generatedAt: at, operationsSource: { ...proof('scheduler-readers'), schedulers: { openclaw: proof('openclaw-cron-cli'), hermes: proof('hermes-cron-disk') } }, jobs: [] },
    hermes: { ok: true, refreshedAt: at, summary: { active: 0, running: 0, blocked: 0, total: 0 } },
    hermesGateway: { ok: true, status: 'running', pid: 1234, observedAt: at, heartbeatAt: at },
  }]) {
    own = input;
    const baseline = buildOperationsOverview(own, { generatedAt: at });
    const [syn, overview, ops, signals] = await Promise.all(['gbrain/synoptic', 'gbrain/overview', 'operations/overview', 'signals']
      .map(async (route) => { const r = await fetch(`${base}/${route}`); assert.equal(r.status, 200); return r.json(); }));
    assert.equal(syn.data.readersState, 'inactive'); assert.ok(syn.data.readers.every((r) => r.observation === 'configured' && r.state === 'inactive'));
    assert.equal(syn.data.state, 'healthy'); assert.equal(overview.state, 'healthy');
    assert.equal(ops.systems.gbrain.state, 'healthy'); assert.equal(signals.data.systems.gbrain.state, 'healthy');
    for (const id of ['hermes', 'openclaw']) {
      assert.equal(ops.systems[id].state, baseline.systems[id].state);
      assert.equal(signals.data.systems[id].state, baseline.systems[id].state);
      if (!Object.keys(input).length) assert.equal(signals.data.systems[id].state, 'unavailable');
    }
  }
});
test('QA1 legacy label migration cannot override a new entry verdict', async (t) => {
  const p = ledger(t);
  await captureSnapshotIfNeeded(reading(1, 'critical'), { ledgerPath: p });
  assert.equal(readTimeline({ ledgerPath: p }).entries[0].trust.status, 'critical');
});
test('QA2 formatted metric labels do not create events when counts and verdict are identical', () => {
  const first = normalizeSnapshot(reading(1)); const second = normalizeSnapshot(reading(181));
  second.metrics.health = 'Score label refreshed'; second.metrics.embeddings = 'Embedding coverage label refreshed';
  second.metrics.queue = 'waiting 0, active 0, stalled 0';
  assert.equal(fingerprintSnapshot(first), fingerprintSnapshot(second));
  second.metrics.queue = 'waiting 1, active 0, stalled 0';
  assert.notEqual(fingerprintSnapshot(first), fingerprintSnapshot(second));
});
