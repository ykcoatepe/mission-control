'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const { createLookups, safeText } = require('../server/sources/gbrain/lookups');
const { createGBrainClient } = require('../server/sources/gbrain/client');
const { createGraphCache } = require('../server/sources/gbrain/graph');
const { createExec } = require('../server/core/exec');
const { runGBrainAction } = require('../server/routes/gbrain/actionsExecutor');
const { activeGBrainActions } = require('../server/routes/gbrain/constants');
const { buildGBrainRouter } = require('../server/routes/gbrain/router');
const { errorHandler } = require('../server/core/http');
const { readTimeline } = require('../server/services/gbrainTimeline');
const { buildGBrainOverview } = require('../server/routes/gbrain/overview');
const { buildGBrainVerdict } = require('../server/sources/gbrain/verdict');
const { buildOperationsOverview } = require('../server/services/operationsOverview');

const secrets = ['hunter2', 'short-secret-value', 'ghp_0123456789abcdefghijklmnopqrstuvABCD',
  'AKIA0123456789ABCDEF', 'xoxb-FFFFFFFFFFFF-FFFFFFFFFFFF-abcdefghijklmnop', 'dXNlcjpwYXNz', 'url-pass'];
const pageBody = `# Deployment notes\n\nExamples from the credential rotation receipt:\n\`\`\`json\n{"password": "${secrets[0]}"}\n\`\`\`\nsecret_key = "${secrets[1]}"\nGitHub ${secrets[2]}\nAWS ${secrets[3]}\nSlack ${secrets[4]}\nAuthorization: Basic ${secrets[5]}\nRemote https://operator:${secrets[6]}@example.test/path\n`;
test('G1 page and search redact real-looking credential bodies', async () => {
  const lookup = createLookups({ client: { run: async (args) => args[3] === 'get_page'
    ? { slug: 'notes/deployment', window: { text: pageBody }, title: 'Deployment' }
    : [{ slug: 'notes/deployment', title: pageBody, type: 'note', chunk_text: pageBody }] } });
  for (const response of [await lookup.page('notes/deployment'), await lookup.search('deployment', '2')]) {
    const serialized = JSON.stringify(response);
    for (const secret of secrets) assert.equal(serialized.includes(secret), false, 'credential must not appear');
    assert.match(serialized, /redacted/);
  }
});
test('G1 ordinary prose, slugs, counts and credential-free URLs survive redaction', () => {
  for (const text of ['projects/mission-control', 'notes/password-policy', 'The bearer of good news arrived.',
    'Token count: 12345; pages: 63273; max_tokens = 4096', 'Press any key: enter', 'https://example.test/docs?limit=20']) {
    assert.equal(safeText(text, 40_000), text);
  }
});
test('G2 all three lookup commands use lookup, while scheduled commands stay on gbrain', async () => {
  const calls = [];
  const client = createGBrainClient({ exec: { run: async (_bin, args, options) => {
    calls.push({ args, lane: options.lane });
    const p = args[4] ? JSON.parse(args[4]) : {};
    return { ok: true, stdout: JSON.stringify(args[3] === 'get_page' ? { slug: p.slug, window: { text: 'A public note.' } } : []) };
  } } });
  const lookup = createLookups({ client }); const graph = createGraphCache({ client });
  await lookup.search('gbrain', '1'); await lookup.page('notes/deployment'); graph.request('notes/deployment'); await graph.refresh();
  await client.run(['call', '--source', '__all__', 'get_health']);
  assert.deepEqual(calls.map((c) => c.lane), ['lookup', 'lookup', 'lookup', 'gbrain']);
});
test('G2 empty search results cannot evict a successful cached query', async () => {
  let goodCalls = 0;
  const lookups = createLookups({ capacity: 1, client: { run: async (args) => {
    const q = JSON.parse(args[4]).query;
    if (q === 'good') { goodCalls++; return [{ slug: 'notes/good', title: 'Useful result' }]; }
    return [];
  } } });
  await lookups.search('good'); await lookups.search('empty'); await lookups.search('good');
  assert.equal(goodCalls, 1);
});
test('G2 junk graph interests cannot evict a populated neighbourhood', async () => {
  const graph = createGraphCache({ capacity: 2, client: { run: async () => [{ from_slug: 'notes/good', to_slug: 'notes/other' }] } });
  graph.request('notes/good'); await graph.refresh();
  for (let i = 0; i < 16; i++) graph.request(`junk/${i}`);
  assert.ok(graph.request('notes/good').data);
});
async function serve(router, check) {
  const app = express(); app.use(express.json()); app.use(router); app.use(errorHandler({ logger: { error() {} } }));
  const server = app.listen(0, '127.0.0.1'); await new Promise((r) => server.once('listening', r));
  try { await check(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise((r) => server.close(r)); }
}
test('G2 lane_busy returns 429 error contract with Retry-After', async () => {
  const exec = { run: async () => ({ ok: false, error: { code: 'lane_busy', message: 'private queue details' } }) };
  const client = createGBrainClient({ exec }); const lookups = createLookups({ client });
  await serve(buildGBrainRouter({ gbrainOverviewService: { lookups } }), async (base) => {
    const response = await fetch(`${base}/api/gbrain/search?q=bounded`);
    assert.equal(response.status, 429); assert.match(response.headers.get('retry-after'), /^\d+$/);
    const body = await response.json(); assert.equal(body.error.code, 'gbrain_lookup_busy');
    assert.doesNotMatch(JSON.stringify(body), /private queue details/);
  });
});
test('G3 actions use core action lane, fixed argv, exact confirmation and release on timeout', async () => {
  const calls = [];
  const exec = { run: async (bin, args, options) => { calls.push({ bin, args, options }); return { ok: false, timedOut: true, stdout: '', error: { code: 'timeout' } }; } };
  const fakeLegacy = async () => ({ stdout: '{}' });
  const result = await runGBrainAction('doctor-fast', { exec, execFilePromise: fakeLegacy });
  assert.equal(calls.length, 1); assert.equal(calls[0].options.lane, 'gbrain-action');
  assert.deepEqual(calls[0].args, ['doctor', '--json', '--fast']); assert.equal(calls[0].options.timeoutMs, 30000);
  assert.equal(result.status, 'timed-out'); assert.equal(activeGBrainActions.size, 0);
  await runGBrainAction('embed-stale', { exec, confirmed: 'true', execFilePromise: fakeLegacy });
  assert.equal(calls.length, 1);
});
test('G3 quarantined action lane returns 503 and releases the application lock', async () => {
  const exec = { run: async () => ({ ok: false, stdout: '', error: { code: 'lane_quarantined' } }) };
  await serve(buildGBrainRouter({ exec, execFilePromise: async () => ({ stdout: '{}' }), gbrainOverviewService: {} }), async (base) => {
    const response = await fetch(`${base}/api/gbrain/actions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'doctor-fast' }) });
    assert.equal(response.status, 503); assert.equal((await response.json()).error.code, 'gbrain_action_quarantined');
    assert.equal(activeGBrainActions.size, 0);
  });
});
test('G4 unreadable timeline is a typed unavailable read, not an observed empty ledger', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-gbrain-unreadable-'));
  try { assert.throws(() => readTimeline({ ledgerPath: dir }), { code: 'gbrain_timeline_unavailable' }); }
  finally { fs.rmSync(dir, { recursive: true }); }
});
test('G4 overview health/version use the shared verdict and autopilot is not read', () => {
  const verdict = { state: 'unavailable', reasons: [{ elementId: 'gbrain.health', state: 'unavailable', text: 'Health unavailable.' }] };
  const overview = buildGBrainOverview({ health: { ok: true, status: 'healthy', score: 100 }, version: { ok: true, version: '1.2.3' } }, { verdict });
  assert.equal(overview.cockpit.health.status, verdict.state); assert.equal(overview.cockpit.version.status, verdict.state);
  assert.equal(overview.cockpit.autopilot.status, 'inactive');
});
test('G4 legacy Operations fallback uses the one verdict function', () => {
  const legacyOverview = { ok: true, trust: { status: 'healthy', score: 100, label: 'Trusted', lastVerifiedAt: '2026-11-11T12:00:00.000Z' }, caveats: ['Provider not verified.'], live: { sources: { freshness: { staleCount: 0 } } } };
  const verdict = buildGBrainVerdict({ legacyOverview });
  assert.equal(verdict.state, 'warning');
  assert.equal(buildOperationsOverview({ gbrain: legacyOverview }, { generatedAt: '2026-11-11T12:00:00.000Z' }).systems.gbrain.state, verdict.state);
});

test('G1 JSON-encoded page examples redact nested credential values', () => {
  const body = `The stored example is ${JSON.stringify(JSON.stringify({ password: 'encoded-credential-example' }))}.`;
  assert.equal(safeText(body, 40_000).includes('encoded-credential-example'), false);
  const ordinary = 'The example says "Press \\"enter\\" to continue"; notes/2026-11-11 has 63273 pages.';
  assert.equal(safeText(ordinary, 40_000), ordinary);
});
function within(promise) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('bounded settlement missed')), 1000); })])
    .finally(() => clearTimeout(timer));
}
test('G2 a 150-query flood is bounded and cannot block a scheduled probe', async () => {
  const callbacks = []; let running = 0; let maxRunning = 0;
  const exec = createExec({ execFileImpl: (_bin, args, _options, done) => {
    if (args[3] === 'get_health') { setImmediate(() => done(null, '{}', '')); return { kill() {} }; }
    running++; maxRunning = Math.max(maxRunning, running);
    callbacks.push(() => { running--; done(null, '[]', ''); });
    return { kill() {} };
  } });
  const client = createGBrainClient({ exec }); const lookup = createLookups({ client });
  const requests = Array.from({ length: 150 }, (_, i) => lookup.search(`distinct-${i}`).then(() => 200, (e) => e.status));
  await new Promise((r) => setImmediate(r));
  try {
    assert.equal(exec.status().lanes.lookup.running, 2); assert.equal(exec.status().lanes.lookup.queued, 4);
    await within(client.run(['call', '--source', '__all__', 'get_health']));
    while (callbacks.length) callbacks.shift()();
    const statuses = await within(Promise.all(requests));
    assert.equal(maxRunning, 2); assert.equal(statuses.filter((s) => s === 429).length, 144);
  } finally { while (callbacks.length) callbacks.shift()(); exec.killAll(); }
});
test('G3 TERM-ignoring action is killed by the core and the lock releases', async () => {
  const signals = [];
  const exec = createExec({ lanes: { 'gbrain-action': { concurrency: 1 } }, killGraceMs: 2,
    setTimeoutImpl: (fn, ms) => setTimeout(fn, ms === 30000 ? 1 : ms),
    execFileImpl: (_bin, _args, _options, done) => ({ kill(signal) { signals.push(signal); if (signal === 'SIGKILL') done({ signal }, '', ''); } }),
  });
  try {
    const result = await within(runGBrainAction('doctor-fast', { exec }));
    assert.equal(result.status, 'timed-out'); assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
    assert.equal(activeGBrainActions.size, 0); assert.equal(exec.status().lanes['gbrain-action'].running, 0);
  } finally { exec.killAll(); }
});
test('G3 unverified kill quarantines the lane, settles both calls and releases the lock', async () => {
  let done;
  const exec = createExec({ lanes: { 'gbrain-action': { concurrency: 1 } }, killGraceMs: 2,
    setTimeoutImpl: (fn, ms) => setTimeout(fn, ms === 30000 ? 1 : ms),
    execFileImpl: (_bin, _args, _options, callback) => { done = callback; return { kill() {} }; },
  });
  try {
    assert.equal((await within(runGBrainAction('doctor-fast', { exec }))).status, 'unavailable');
    assert.equal(exec.status().lanes['gbrain-action'].quarantined, true); assert.equal(activeGBrainActions.size, 0);
    assert.equal((await within(runGBrainAction('storage-status', { exec }))).status, 'unavailable');
  } finally { done?.({ signal: 'SIGKILL' }, '', ''); exec.killAll(); }
});
test('G3 shutdown kills actions through the same runner and preserves single flight', async () => {
  let calls = 0; const signals = [];
  const exec = createExec({ lanes: { 'gbrain-action': { concurrency: 1 } }, killGraceMs: 2,
    execFileImpl: (_bin, _args, _options, done) => { calls++; return { kill(signal) { signals.push(signal); if (signal === 'SIGKILL') done({ signal }, '', ''); } }; },
  });
  const first = runGBrainAction('doctor-fast', { exec });
  assert.equal((await runGBrainAction('storage-status', { exec })).status, 'busy'); assert.equal(calls, 1);
  exec.killAll(); const result = await within(first);
  assert.equal(result.ok, false); assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']); assert.equal(activeGBrainActions.size, 0);
});
test('G4 an unreadable scheduled timeline yields the central 503 error contract', async () => {
  const { createGBrainOverviewService } = require('../server/services/gbrainOverviewData');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-gbrain-timeline-http-'));
  const service = createGBrainOverviewService({ probes: {}, buildIntegrationRuntime: () => ({}), timelineLedgerPath: dir });
  try {
    await service.refresh(); assert.equal(service.timelineSnapshot().data, null);
    await serve(buildGBrainRouter({ gbrainOverviewService: service }), async (base) => {
      const r = await fetch(`${base}/api/gbrain/timeline`); assert.equal(r.status, 503);
      assert.equal((await r.json()).error.code, 'gbrain_timeline_unavailable');
    });
  } finally { fs.rmSync(dir, { recursive: true }); }
});
test('G4 legacy fallback cannot hide an unavailable embed-job reason behind a 100 score', () => {
  const legacyOverview = { ok: true, trust: { status: 'healthy', score: 100, label: 'Trusted', lastVerifiedAt: '2026-11-11T12:00:00.000Z' }, caveats: [],
    live: { sources: { freshness: { staleCount: 0 } }, health: { metrics: { embedJobProbeUnavailable: true } } } };
  assert.equal(buildOperationsOverview({ gbrain: legacyOverview }, { generatedAt: '2026-11-11T12:00:00.000Z' }).systems.gbrain.state, 'unavailable');
});

test('G3 createApp declares a single-concurrency action lane', () => {
  const { createApp } = require('../server/app');
  const { loadConfig } = require('../server/core/config');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-gbrain-action-lane-'));
  let app;
  try {
    const config = loadConfig({ rootDir: root, homeDir: root, env: { PORT: '0' } });
    app = createApp({ config, logger: { log() {}, warn() {}, error() {} } });
    const lane = app.locals.runtime.exec.status().lanes['gbrain-action'];
    assert.equal(lane.concurrency, 1); assert.equal(lane.maxQueue, 0);
  } finally { app?.locals.runtime.dispose(); fs.rmSync(root, { recursive: true }); }
});

test('G4 a failed timeline capture still refreshes its unavailable read state', async () => {
  const { createGBrainOverviewService } = require('../server/services/gbrainOverviewData');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-gbrain-timeline-capture-'));
  const service = createGBrainOverviewService({ probes: { health: async () => ({ ok: true, score: 100, status: 'healthy' }) },
    buildIntegrationRuntime: () => ({}), timelineLedgerPath: dir });
  try {
    await assert.rejects(() => service.refresh(), { code: 'gbrain_timeline_unavailable' });
    assert.equal(service.timelineSnapshot().meta.error?.code, 'gbrain_timeline_unavailable');
  } finally { fs.rmSync(dir, { recursive: true }); }
});

test('G3 app actions use its shutdown-owned runner even with an overridden read service', async () => {
  const { createApp } = require('../server/app'); const { loadConfig } = require('../server/core/config');
  const { GBRAIN_ACTION_EXEC_LANES } = require('../server/routes/gbrain/actionsExecutor');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-gbrain-bound-action-'));
  let calls = 0;
  const exec = createExec({ lanes: GBRAIN_ACTION_EXEC_LANES, execFileImpl: (bin, args, _options, done) => {
    assert.equal(bin, 'gbrain'); assert.deepEqual(args, ['doctor', '--json', '--fast']); calls++;
    setImmediate(() => done(null, '{}', '')); return { kill() {} };
  } });
  const config = loadConfig({ rootDir: root, homeDir: root, env: { PORT: '0' } });
  const app = createApp({ config, exec, services: { gbrainOverviewService: {} }, logger: { log() {}, warn() {}, error() {} } });
  const server = app.listen(0, '127.0.0.1'); await new Promise((r) => server.once('listening', r));
  app.locals.runtime.setBoundPort(server.address().port);
  try {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/api/gbrain/actions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-MC-Request': '1' }, body: JSON.stringify({ action: 'doctor-fast' }),
    });
    assert.equal(r.status, 200); assert.equal((await r.json()).ok, true);
    assert.equal(calls, 1); assert.equal(exec.status().lanes['gbrain-action'].completed, 1);
  } finally { app.locals.runtime.dispose(); await new Promise((r) => server.close(r)); fs.rmSync(root, { recursive: true }); }
});

test('G2 a failed staged refresh cannot evict current good data', () => {
  const { createEvidenceCache } = require('../server/sources/gbrain/cache');
  let refreshing = false; let error = null; let recreated = 0;
  const a = { status: () => ({ refreshing }), snapshot: () => ({ data: 'a', meta: { error: null } }) };
  const b = { status: () => ({ refreshing: false }), snapshot: () => ({ data: 'b', meta: { error } }) };
  const cache = createEvidenceCache({ capacity: 1, useful: (data) => data !== null });
  cache.get('a', () => a); refreshing = true; cache.get('b', () => b); cache.promote('b');
  refreshing = false; error = { code: 'read_failed' }; cache.promote('b');
  assert.equal(cache.get('a', () => { recreated++; return a; }), a); assert.equal(recreated, 0);
});
