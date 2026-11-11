'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createGBrainOverviewService } = require('../server/services/gbrainOverviewData');
const { deriveState } = require('../server/sources/gbrain/state');
const { runGBrainAction } = require('../server/routes/gbrain/actionsExecutor');

test('every W1 executor caller needs strict boolean confirmation', async () => {
  let calls = 0;
  for (const action of ['sync-sources', 'retry-failed-sync', 'embed-stale', 'embed-missing']) {
    for (const confirmed of [undefined, false, 'true', 1, {}, []]) {
      const r = await runGBrainAction(action, { confirmed, execFilePromise: async () => { calls++; return {}; } });
      assert.equal(r.status, 'confirmation-required');
    }
  }
  assert.equal(calls, 0);
});

test('one state function never turns failed, absent or stale evidence green', () => {
  assert.equal(deriveState({ observed: true }), 'healthy');
  assert.equal(deriveState({ observed: true, failed: true }), 'unavailable');
  assert.equal(deriveState({ observed: false }), 'unavailable');
  assert.equal(deriveState({ observed: true, ageMs: 101, staleAfterMs: 100 }), 'warning');
  assert.equal(deriveState({ observed: true, inactive: true }), 'inactive');
  assert.equal(deriveState({ observed: true, critical: true }), 'critical');
});

test('overview reads do not probe or capture; scheduled failure preserves last-good', async () => {
  let calls = 0; let captures = 0; let fail = false;
  const service = createGBrainOverviewService({
    probes: { health: async () => { calls++; if (fail) throw Error('private failure'); return { ok: true, score: 99, status: 'healthy', metrics: { pages: 12 } }; } },
    buildIntegrationRuntime: () => ({ systems: {} }),
    timelineService: { captureOverview: async () => { captures++; return {}; }, readTimeline: () => ({ entries: [] }) },
  });
  await service.getOverview(); await service.readSnapshot();
  assert.equal(calls, 0); assert.equal(captures, 0);
  await service.refresh();
  assert.equal(calls, 1); assert.equal(captures, 1);
  assert.equal(service.probeSnapshot('health').data.metrics.pages, 12);
  fail = true; await service.refresh();
  const snap = service.probeSnapshot('health');
  assert.equal(snap.data.metrics.pages, 12); assert.equal(snap.meta.ok, false); assert.equal(snap.meta.stale, true);
  assert.doesNotMatch(JSON.stringify(snap.meta), /private failure/);
  await service.getOverview(); assert.equal(calls, 2);
});

const { createExec } = require('../server/core/exec');
const { createGBrainClient } = require('../server/sources/gbrain/client');
const { createGBrainSources } = require('../server/sources/gbrain/probes');
const { createLookups } = require('../server/sources/gbrain/lookups');
const { createGraphCache } = require('../server/sources/gbrain/graph');
const { buildSynoptic } = require('../server/sources/gbrain/synoptic');
const { normalizeSourcesPayload, normalizeFeaturesPayload, findNumber } = require('../server/routes/gbrain/liveProbes');
const { readReaders } = require('../server/sources/gbrain/readers');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const { buildGBrainRouter } = require('../server/routes/gbrain/router');
const { errorHandler } = require('../server/core/http');

function rawFixture(args) {
  if (args.includes('get_health')) return { page_count: 12, brain_score: 100, stale_pages: 0, missing_embeddings: 0,
    embed_coverage: 1, embed_coverage_score: 35, link_density_score: 25, timeline_coverage_score: 15, no_orphans_score: 15, no_dead_links_score: 10 };
  if (args[0] === 'jobs') return { queue_health: { waiting: 0, active: 1, stalled: 0 } };
  if (args[0] === 'stats') return { page_count: 12, chunk_count: 34, embedded_count: 34 };
  if (args.includes('get_status_snapshot')) return { sync: { sources: [{ source_id: 'codex-memories', sync_enabled: true,
    last_sync_at: '2026-11-11T08:00:00.000Z', pages: 12, chunks_total: 34 }] } };
  if (args[0] === '--version') return 'gbrain 0.60.599.0';
  if (args[0] === '--tools-json') return [{ name: 'get_page' }];
  if (args[0] === 'features') return { recommendations: [] };
  if (args[0] === 'providers') return { options: [] };
  throw Error('Unexpected command');
}

test('all scheduled CLI probes share the core gbrain lane, caps and last-good semantics', async () => {
  const calls = []; let failed = false; let active = 0; let max = 0;
  const runner = createExec({ execFileImpl: (_bin, args, options, callback) => {
    calls.push({ args, options }); active++; max = Math.max(max, active);
    setTimeout(() => { active--; callback(failed ? Error('secret stderr') : null,
      args[0] === '--version' ? rawFixture(args) : JSON.stringify(rawFixture(args)), 'private stderr'); }, 2);
    return { kill() {} };
  } });
  const runOptions = [];
  const { sources } = createGBrainSources({ exec: { run: (...args) => { runOptions.push(args[2]); return runner.run(...args); } }, buildIntegrationRuntime: () => ({ systems: {}, readers: [] }),
    // Do not open the proxy/network in tests.
    probes: undefined, hermesProxyBaseUrl: 'invalid:' });
  const cliSources = Object.entries(sources).filter(([k]) => !['runtime', 'hermesProxy'].includes(k));
  await Promise.all(cliSources.map(([, s]) => s.refresh()));
  assert.equal(max, 2); assert.equal(runner.status().lanes.gbrain.maxObservedRunning, 2);
  assert.ok(calls.every((c) => c.options.shell === false));
  assert.ok(runOptions.every((o) => o.lane === 'gbrain' && o.timeoutMs <= 60_000 && o.queueTimeoutMs + o.timeoutMs <= 60_000));
  assert.ok(cliSources.every(([, s]) => s.snapshot().data !== null));
  const before = new Map(cliSources.map(([k, s]) => [k, s.snapshot().data]));
  failed = true; await Promise.all(cliSources.map(([, s]) => s.refresh()));
  for (const [k, s] of cliSources) {
    assert.equal(s.snapshot().data, before.get(k)); assert.equal(s.snapshot().meta.ok, false);
    assert.doesNotMatch(JSON.stringify(s.snapshot().meta), /secret stderr|private stderr/);
  }
  runner.killAll();
});

test('null counters are unknown, never coerced to zero or a partial source total', () => {
  assert.equal(findNumber({ page_count: null }, ['page_count']), null);
  assert.equal(normalizeFeaturesPayload({ brain_score: null }).brainScore, null);
  const s = normalizeSourcesPayload([{ id: 'one', pages: 10 }, { id: 'two', pages: null, chunks: null }], new Date().toISOString());
  assert.equal(s.sources[1].pages, null); assert.equal(s.sources[1].chunks, null); assert.equal(s.totalPages, null);
});

test('search/page validate before execution, single-flight, cache per query, redact and keep failed last-good', async () => {
  let time = 1_000; let calls = 0; let fail = false;
  const client = { run: async (args) => {
    calls++; await new Promise((r) => setTimeout(r, 1)); if (fail) throw Error('private failure');
    const p = JSON.parse(args[4]);
    if (args[3] === 'search') return [{ slug: 'notes/a', title: p.query, type: 'note', chunk_text: 'password=private postgres://user:pw@host/db', token: 'private' },
      { slug: 'transcripts/private', type: 'transcript', chunk_text: 'do not disclose' },
      { slug: 'notes/raw-record', type: 'session', chunk_text: 'do not disclose' }];
    assert.equal(p.include_content, undefined); assert.equal(p.body, 'window');
    assert.deepEqual(p.bytes, { offset: 0, length: 40_000 });
    return { slug: p.slug, title: 'Page', window: { text: 'safe body' }, frontmatter: { token: 'private' }, source_path: '/private', revision: 'rev' };
  } };
  const lookups = createLookups({ client, now: () => time, ttlMs: 100 });
  for (const q of ['', undefined, ['q'], 'x'.repeat(301), '\n']) await assert.rejects(() => lookups.search(q, '2'), { code: 'invalid_query' });
  for (const slug of ['../a', '-x', 'a//b', 'a.b', 'a b', '--help', 'a/'.repeat(150)]) await assert.rejects(() => lookups.page(slug), { code: 'invalid_slug' });
  for (const limit of ['0', '-1', '101', '1.5', ['2']]) await assert.rejects(() => lookups.search('q', limit), { code: 'invalid_limit' });
  assert.equal(calls, 0);
  const [a, b] = await Promise.all([lookups.search('q', '2'), lookups.search('q', '2')]);
  assert.equal(calls, 1); assert.deepEqual(a, b); assert.equal(a.data.results.length, 1);
  assert.doesNotMatch(JSON.stringify(a), /private|do not disclose|postgres:\/\//);
  await lookups.search('q', '2'); assert.equal(calls, 1);
  await lookups.search('other', '2'); assert.equal(calls, 2);
  const page = await lookups.page('notes/a'); assert.equal(page.data.content, 'safe body');
  assert.doesNotMatch(JSON.stringify(page), /frontmatter|source_path|private/);
  time += 101; fail = true; const stale = await lookups.search('q', '2');
  assert.equal(stale.data.results[0].slug, 'notes/a'); assert.equal(stale.meta.ok, false); assert.equal(stale.meta.stale, true);
  const failedCalls = calls; await lookups.search('q', '2'); assert.equal(calls, failedCalls, 'failed reads also have a brief cache');
});

test('graph GET never runs CLI; scheduler caches directed neighbourhood and deduplicates edges', async () => {
  let calls = 0; let fail = false; let time = 1000;
  const graph = createGraphCache({ now: () => time, client: { run: async (args) => {
    calls++; if (fail) throw Error('private failure');
    assert.deepEqual(JSON.parse(args[4]), { slug: 'notes/a', depth: 1, direction: 'both' });
    return [{ from_slug: 'notes/a', to_slug: 'notes/b', context: 'private' },
      { from_slug: 'notes/a', to_slug: 'notes/b' }, { from_slug: 'notes/c', to_slug: 'notes/a' }];
  } } });
  assert.equal(graph.request('notes/a', '2').data, null); assert.equal(calls, 0);
  await graph.refresh(); assert.equal(calls, 1);
  const snap = graph.request('notes/a', '2'); assert.equal(snap.data.nodes.length, 2); assert.equal(snap.data.links.length, 1);
  assert.equal(snap.data.nodes[0].degree, 1); assert.equal(snap.data.nodes[0].title, null);
  assert.equal(snap.data.degreeScope, 'returned-subgraph'); assert.doesNotMatch(JSON.stringify(snap), /private/);
  await graph.refresh(); assert.equal(calls, 1);
  time += 900_001; fail = true; await graph.refresh();
  assert.equal(graph.request('notes/a').meta.ok, false); assert.ok(graph.request('notes/a').data);
});

test('synoptic whitelists per-reader config, omits unobservable counts, propagates failed and stale states', async () => {
  let time = Date.parse('2026-11-11T08:00:00.000Z'); let failed = false;
  const probes = {
    health: async () => { if (failed) throw Error('private'); return { ok: true, status: 'healthy', score: 100, components: { embed_coverage_score: 35 } }; },
    sources: async () => ({ ok: true, sources: [{ id: 'codex-memories', syncEnabled: true, lastSyncAt: new Date(time).toISOString(), behind: null, excludedByPolicy: null }] }),
    stats: async () => ({ pages: 12, chunks: 34, embedded: 34 }), jobs: async () => ({ waiting: 0, active: 1, stalled: 0 }),
    version: async () => ({ ok: true, version: '1.2' }),
  };
  const service = createGBrainOverviewService({ now: () => time, probes,
    buildIntegrationRuntime: () => ({ readers: [{ id: 'codex', label: 'Codex', observed: true, configured: true, evidence: 'local config', token: 'private' }] }),
    timelineService: { captureOverview: async () => ({}), readTimeline: () => ({ entries: [] }) } });
  assert.equal(service.synopticSnapshot().data, null);
  await service.refresh(); let syn = service.synopticSnapshot();
  assert.equal(syn.data.core.pages.value, 12); assert.equal(syn.data.readers[0].integration.state, 'healthy');
  assert.equal(Object.hasOwn(syn.data.readers[0], 'connection'), false);
  assert.equal(syn.data.readers[0].state, 'healthy');
  assert.doesNotMatch(JSON.stringify(syn), /private|callCount|lastCallAt/);
  failed = true; await service.refresh(); syn = service.synopticSnapshot();
  assert.equal(syn.data.core.quality.value, 100); assert.equal(syn.data.core.quality.state, 'unavailable');
  time += 360_001; syn = service.synopticSnapshot(); assert.equal(syn.data.core.pages.state, 'warning');
});

test('reader discovery returns metadata only and cannot fabricate call activity from config', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-gbrain-readers-'));
  fs.mkdirSync(path.join(home, '.codex')); fs.writeFileSync(path.join(home, '.codex/config.toml'), '[mcp_servers.gbrain]\ntoken="private"');
  const readers = readReaders({ homeDir: home });
  assert.equal(readers.find((r) => r.id === 'codex').configured, true);
  assert.equal(readers.find((r) => r.id === 'hermes').observed, false);
  assert.doesNotMatch(JSON.stringify(readers), /private|token|callCount|lastCallAt|connection/);
  fs.rmSync(home, { recursive: true });
});

test('real router composes memory, encoded slugs work, invalid inputs use central errors; GETs write no ledger', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-gbrain-get-'));
  let calls = 0;
  const exec = { run: async (_bin, args) => { calls++; return { ok: true, stdout: JSON.stringify({ slug: JSON.parse(args[4]).slug, window: { text: 'body' } }) }; } };
  const service = createGBrainOverviewService({ projectRoot: root, exec, probes: {}, buildIntegrationRuntime: () => ({}) });
  const app = express(); app.use(buildGBrainRouter({ gbrainOverviewService: service }));
  app.use(errorHandler({ logger: { error() {} } }));
  const server = app.listen(0, '127.0.0.1'); await new Promise((r) => server.once('listening', r));
  try {
    const base = `http://127.0.0.1:${server.address().port}/api/gbrain`;
    for (const url of ['overview', 'health', 'sources', 'version', 'integration-health', 'timeline', 'synoptic', 'graph?around=notes%2Fa']) {
      const r = await fetch(`${base}/${url}`); assert.ok([200, 503].includes(r.status), `${url}: ${r.status}`); await r.json();
    }
    assert.equal(calls, 0); assert.deepEqual(fs.readdirSync(root), []);
    assert.equal((await fetch(`${base}/pages/notes%2Fa`)).status, 200); assert.equal(calls, 1);
    const invalid = await fetch(`${base}/pages/..%2Fa`); assert.equal(invalid.status, 400); assert.equal((await invalid.json()).error.code, 'invalid_slug');
    assert.equal((await fetch(`${base}/graph`)).status, 400); assert.equal(calls, 1);
    assert.deepEqual(fs.readdirSync(root), []);
  } finally { await new Promise((r) => server.close(r)); fs.rmSync(root, { recursive: true }); }
});

test('scheduler alone captures timeline changes; GET cannot append, heartbeat and ledger format survive', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-gbrain-ledger-'));
  const { createScheduler } = require('../server/core/scheduler');
  const { normalizeSnapshot } = require('../server/services/gbrainTimeline');
  let pages = 12; let fail = false;
  const service = createGBrainOverviewService({ projectRoot: root, probes: {
    health: async () => { if (fail) throw Error('down'); return { ok: true, checkedAt: new Date().toISOString(), status: 'healthy', score: 100,
      metrics: { pages, chunks: 34, embedded: 34, stalePages: 0, missingEmbeddings: 0 } }; },
    sources: async () => ({ ok: true, sources: [], count: 0, freshness: { status: 'inactive', staleCount: 0 } }),
    stats: async () => ({ pages, chunks: 34, embedded: 34 }),
    jobs: async () => ({ waiting: 0, active: 0, stalled: 0 }),
  }, buildIntegrationRuntime: () => ({}) });
  const scheduler = createScheduler({ logger: null }); service.register(scheduler);
  const jobs = scheduler.status().jobs;
  assert.equal(jobs.find((j) => j.id === 'gbrain.refresh').intervalMs, 180_000);
  assert.equal(normalizeSnapshot({ trust: { score: null } }).trust.score, null);
  await service.getOverview(); assert.equal(fs.existsSync(service.timelineService.ledgerPath), false);
  await scheduler.runNow('gbrain.refresh');
  const before = fs.readFileSync(service.timelineService.ledgerPath, 'utf8');
  await service.getOverview(); service.timelineSnapshot(1); service.synopticSnapshot();
  assert.equal(fs.readFileSync(service.timelineService.ledgerPath, 'utf8'), before);
  await scheduler.runNow('gbrain.refresh');
  assert.equal(fs.readFileSync(service.timelineService.ledgerPath, 'utf8'), before, 'unchanged refresh does not append');
  fail = true; await scheduler.runNow('gbrain.refresh');
  const rows = fs.readFileSync(service.timelineService.ledgerPath, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(rows.length, 2); assert.ok(rows.every((r) => r.schemaVersion && r.fingerprint));
  scheduler.stop(); fs.rmSync(root, { recursive: true });
});

test('health root counters cannot borrow a nested gate status or invent a missing score', async () => {
  let payload = { page_count: 12, brain_score: 5, missing_embeddings: 0, stale_pages: 0, nested: { status: 'healthy' } };
  const { sources } = createGBrainSources({ client: { run: async () => payload }, buildIntegrationRuntime: () => ({}), homeDir: '/nonexistent' });
  await sources.health.refresh(); assert.equal(sources.health.snapshot().data.score, 5);
  assert.equal(sources.health.snapshot().data.status, 'warning');
  payload = { page_count: 12, missing_embeddings: 0, stale_pages: 0, nested: { status: 'healthy', score: 100 } };
  await sources.health.refresh(); assert.equal(sources.health.snapshot().data.score, null);
  payload = {}; await sources.health.refresh();
  assert.equal(sources.health.snapshot().meta.ok, false); assert.equal(sources.health.snapshot().data.score, null);
});

test('Operations contract treats failed last-good GBrain readings as unavailable', async () => {
  let failed = false;
  const service = createGBrainOverviewService({ probes: {
    health: async () => { if (failed) throw Error('down'); return { ok: true, status: 'healthy', score: 100 }; },
    sources: async () => ({ ok: true, sources: [], count: 0 }),
    stats: async () => ({ pages: 12, chunks: 34, embedded: 34 }), jobs: async () => ({ waiting: 0, active: 0, stalled: 0 }),
  }, buildIntegrationRuntime: () => ({}), timelineService: { captureOverview: async () => ({}), readTimeline: () => ({ entries: [] }) } });
  await service.refresh(); assert.equal((await service.readSnapshot()).overview.unavailable, false);
  failed = true; await service.refresh(); const snap = await service.readSnapshot();
  assert.equal(snap.overview.unavailable, true); assert.equal(snap.overview.trust.score, 100);
});

test('synoptic aggregates source warnings and propagates explicit critical quality', () => {
  const now = Date.parse('2026-11-11T08:00:00.000Z');
  const snap = (data) => ({ data, meta: { ok: true, stale: false, error: null, observedAt: new Date(now).toISOString(), ageMs: 0 } });
  const values = {
    health: { score: 100, components: {} }, stats: { pages: 12, chunks: 34, embedded: 34 }, version: { version: '1.2' },
    sources: { sources: [{ id: 'hermes-agent', syncEnabled: true, lastSyncAt: '2026-01-01T00:00:00.000Z' }] },
    jobs: { waiting: 0, active: 0, stalled: 0 }, runtime: { readers: [] },
  };
  const input = { probeSnapshot: (name) => snap(values[name]), live: { health: { status: 'healthy' } }, now: () => now };
  let s = buildSynoptic(input); assert.equal(s.sourcesState, 'warning'); assert.equal(s.state, 'warning');
  input.live.health.status = 'critical'; s = buildSynoptic(input);
  assert.equal(s.core.quality.state, 'critical'); assert.equal(s.core.state, 'critical'); assert.equal(s.state, 'critical');
});

function readerSynopticFixture(readers, runtimeMeta = {}) {
  const now = Date.parse('2026-11-11T08:00:00.000Z');
  const values = {
    health: { score: 100, components: {} }, stats: { pages: 12, chunks: 34, embedded: 34 }, version: { version: '1.2' },
    sources: { sources: [{ id: 'project', syncEnabled: true, lastSyncAt: new Date(now).toISOString() }] },
    jobs: { waiting: 0, active: 0, stalled: 0 }, runtime: { readers },
  };
  return buildSynoptic({ now: () => now, live: { health: { status: 'healthy' } }, probeSnapshot: (name) => ({
    data: values[name], meta: { ok: true, stale: false, error: null, observedAt: new Date(now).toISOString(), ageMs: 0,
      ...(name === 'runtime' ? runtimeMeta : {}) },
  }) });
}

test('unobservable connection telemetry never degrades configured readers or the synoptic', () => {
  const readers = ['hermes', 'codex', 'claude-code', 'openclaw'].map((id) => ({
    id, label: id, configured: true, observed: true, evidence: 'local configuration',
  }));
  readers.push({ id: 'disabled', label: 'Disabled', configured: false, observed: true, evidence: 'local configuration' });
  const s = readerSynopticFixture(readers);
  assert.equal(s.state, 'healthy'); assert.equal(s.readersState, 'healthy');
  assert.equal(s.readersNote, 'connection telemetry is not observable locally');
  for (const reader of s.readers) {
    assert.equal(reader.state, reader.integration.configured ? 'healthy' : 'inactive');
    assert.equal(reader.state, reader.integration.state);
    assert.equal(Object.hasOwn(reader, 'connection'), false);
    const edge = s.edges.find((e) => e.from === reader.id);
    assert.equal(edge.state, reader.state); assert.equal(edge.label, 'configured');
    assert.equal(Object.hasOwn(edge, 'measurement'), false); assert.equal(Object.hasOwn(edge, 'unit'), false);
  }
  const inactive = readerSynopticFixture([readers.at(-1)]);
  assert.equal(inactive.readersState, 'inactive'); assert.equal(inactive.state, 'healthy');
});

test('failed integration readings remain unavailable, including cached configured readers', () => {
  for (const [reader, meta] of [
    [{ id: 'codex', label: 'Codex', observed: false, configured: null, evidence: 'configuration read failed' }, {}],
    [{ id: 'codex', label: 'Codex', observed: true, configured: true, evidence: 'cached configuration' },
      { ok: false, stale: true, error: { code: 'gbrain_read_failed', message: 'Read failed' } }],
  ]) {
    const s = readerSynopticFixture([reader], meta);
    assert.equal(s.readers[0].state, 'unavailable'); assert.equal(s.readers[0].integration.state, 'unavailable');
    assert.equal(s.readersState, 'unavailable'); assert.equal(s.state, 'unavailable');
    assert.equal(s.edges.find((e) => e.from === 'codex').state, 'unavailable');
    assert.equal(Object.hasOwn(s.readers[0], 'connection'), false);
  }
});
