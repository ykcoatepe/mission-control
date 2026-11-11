'use strict';
const test = require('node:test'); const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createApp } = require('../server/app'); const { loadConfig } = require('../server/core/config');
const { createGBrainOverviewService } = require('../server/services/gbrainOverviewData');
const { normalizeSourcesPayload } = require('../server/routes/gbrain/liveProbes');
const { withLiveLoop } = require('./helpers/liveLoop');
const run = (fn) => withLiveLoop(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-gbrain-ryw-'));
  let now = Date.now() + 1000; let version = 1; let fail = false; let gate = null; let entered;
  const controls = { actionFail: false, actionNoChange: false, reads: 0, activeReads: 0, maxReads: 0, actions: 0, lanes: [], captures: 0 };
  const exec = { async run(_bin, args, options) {
    if (options.lane === 'gbrain-action') {
      if (args[0] === 'embed') return { ok: true, code: 0, stdout: '{}', stderr: '', error: null };
      controls.actions++; now += 100; if (!controls.actionNoChange) version++;
      return { ok: !controls.actionFail, code: controls.actionFail ? 2 : 0, stdout: controls.actionFail ? 'garbage' : JSON.stringify({ schema_version: 2, status: 'unhealthy', health_score: 45, checks: [{ name: 'resolver', status: 'fail', message: 'Findings' }] }), stderr: '', error: null };
    }
    assert.equal(options.lane, 'gbrain'); controls.lanes.push(options.lane); controls.reads++;
    controls.activeReads++; controls.maxReads = Math.max(controls.maxReads, controls.activeReads);
    const captured = version; now++;
    try { if (gate) { entered?.(); await gate; } if (fail) throw Error('private probe failure'); return { version: captured }; }
    finally { controls.activeReads--; now++; }
  }, killAll() {}, drain: async () => true, status: () => ({ lanes: {}, children: 0, quarantined: [] }) };
  const read = async (name) => (await exec.run('fake-gbrain', [name], { lane: 'gbrain' })).version;
  const probes = {
    health: async () => { const v = await read('health'); return { ok: true, status: 'healthy', score: 101 - v, checkedAt: new Date(now).toISOString(), metrics: { missingEmbeddings: 0, stalePages: 0 } }; },
    stats: async () => { const v = await read('stats'); return { pages: v, chunks: v * 2, embedded: v * 2 }; },
    jobs: async () => { await read('jobs'); return { waiting: 0, active: 0, stalled: 0 }; },
    sources: async () => { const v = await read('sources'); return normalizeSourcesPayload([{ id: 'project', pages: v, sync_enabled: true, last_sync_at: new Date(now).toISOString() }], new Date(now).toISOString()); },
    version: async () => ({ ok: true, version: `v${await read('version')}` }),
  };
  const service = createGBrainOverviewService({ now: () => now, projectRoot: root, exec, probes,
    actionRefreshWaitMs: 30, buildIntegrationRuntime: () => ({ readers: [] }) });
  const capture = service.timelineService.captureOverview.bind(service.timelineService);
  service.timelineService.captureOverview = async (...args) => { controls.captures++; return capture(...args); };
  await service.refresh();
  const config = loadConfig({ rootDir: root, homeDir: root, env: { PORT: '0' } });
  const app = createApp({ config, exec, clock: { now: () => now }, fetch: async () => { throw Error('No network'); },
    logger: { log() {}, warn() {}, error() {} }, scheduler: { register() {}, start() {}, stop() {}, status: () => [] },
    services: { gbrainOverviewService: service, usageService: { summary: () => ({ data: null, meta: {} }), costs: () => ({}), months: () => ({}), codexbar: () => ({}), dispose() {} } } });
  const server = app.listen(0, '127.0.0.1'); await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  const port = server.address().port; app.locals.runtime.setBoundPort(port);
  const request = async (method, url, body) => { const r = await fetch(`http://127.0.0.1:${port}${url}`, { method,
    headers: { Origin: `http://127.0.0.1:${port}`, 'X-MC-Request': '1', 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, body: await r.json() }; };
  let release;
  const f = { service, controls, request,
    setFail: (v) => { fail = v; },
    block() { gate = new Promise((r) => { release = r; }); return new Promise((r) => { entered = r; }); },
    unblock() { const r = release; entered?.(); gate = null; entered = null; release = null; r?.(); },
  };
  let watchdog;
  try { await Promise.race([fn(f), new Promise((_, reject) => { watchdog = setTimeout(() => reject(Error('App RYW test exceeded its hard wait budget')), 2000); })]); } finally { clearTimeout(watchdog); f.unblock(); await service.refresh().catch(() => {}); app.locals.runtime.dispose(); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); }
});
for (const action of ['doctor-fast', 'sync-sources']) test(`app RYW completed ${action} publishes immediate newer readings and one timeline entry`, () => run(async (f) => {
  const before = (await f.request('GET', '/api/gbrain/synoptic')).body;
  const writes = await f.request('POST', '/api/gbrain/actions', { action, confirmed: true });
  assert.equal(writes.status, 200); assert.equal(writes.body.status, 'completed');
  assert.equal(writes.body.refreshPending, false); assert.equal(writes.body.meta.stale, false);
  assert.ok(Date.parse(writes.body.observedAt) > Date.parse(writes.body.checkedAt));
  assert.ok(Date.parse(writes.body.observedAt) > Date.parse(before.meta.observedAt));
  const at = writes.body.observedAt; const reads = f.controls.reads;
  for (const url of ['gbrain/synoptic', 'gbrain/overview', 'gbrain/health', 'gbrain/sources', 'gbrain/timeline', 'operations/overview', 'signals']) {
    const r = await f.request('GET', '/api/' + url); assert.equal(r.status, 200, url);
    if (url === 'operations/overview') assert.ok(Date.parse(r.body.systems.gbrain.observedAt) >= Date.parse(at));
    else if (url === 'signals') assert.ok(Date.parse(r.body.data.systems.gbrain.observedAt) >= Date.parse(at));
    else { assert.equal(r.body.meta.stale, false, url); assert.ok(Date.parse(r.body.meta.observedAt) >= Date.parse(at), url); }
  }
  const syn = (await f.request('GET', '/api/gbrain/synoptic')).body.data; assert.equal(syn.core.pages.value, 2);
  const history = (await f.request('GET', '/api/gbrain/timeline')).body.entries;
  assert.equal(history.length, 2); assert.equal(history[0].trust.score, 99); assert.equal(history[0].trust.status, 'healthy');
  assert.equal(f.controls.captures, 2); assert.equal(f.controls.reads, reads, 'GET must not spawn a refresh');
  assert.ok(f.controls.maxReads <= 2);
}));
test('app RYW failed probes preserve action success and mark last-good snapshots stale', () => run(async (f) => {
  f.setFail(true);
  const r = await f.request('POST', '/api/gbrain/actions', { action: 'doctor-fast' });
  assert.equal(r.status, 200); assert.equal(r.body.outcome, 'findings'); assert.equal(r.body.meta.stale, true);
  const get = (await f.request('GET', '/api/gbrain/synoptic')).body;
  assert.equal(get.data.core.pages.value, 1); assert.equal(get.meta.stale, true);
}));
test('app RYW bounded wait returns pending/stale while the same refresh continues', () => run(async (f) => {
  const blocked = f.block();
  const pending = f.request('POST', '/api/gbrain/actions', { action: 'doctor-fast' });
  await Promise.race([blocked, pending]);
  const r = await pending;
  assert.equal(r.status, 200); assert.equal(r.body.status, 'completed'); assert.equal(r.body.refreshPending, true);
  assert.equal(r.body.meta.stale, true);
  const stale = (await f.request('GET', '/api/gbrain/synoptic')).body;
  assert.equal(stale.meta.stale, true); assert.equal(stale.data.core.pages.value, 1);
  const same = f.service.refresh(); assert.equal(f.service.refresh(), same);
  f.unblock(); await same;
  const fresh = (await f.request('GET', '/api/gbrain/synoptic')).body;
  assert.equal(fresh.meta.stale, false); assert.equal(fresh.data.core.pages.value, 2); assert.ok(f.controls.maxReads <= 2);
}));
test('app RYW an action overlapping an older refresh queues one later pass, never a concurrent pass', () => run(async (f) => {
  const blocked = f.block(); const old = f.service.refresh(); await blocked;
  const pending = f.request('POST', '/api/gbrain/actions', { action: 'doctor-fast' });
  const r = await pending; assert.equal(r.status, 200); assert.equal(r.body.refreshPending, true);
  f.unblock(); await old;
  const syn = (await f.request('GET', '/api/gbrain/synoptic')).body;
  assert.equal(syn.data.core.pages.value, 2); assert.equal(syn.meta.stale, false);
  assert.ok(f.controls.maxReads <= 2); assert.equal(f.controls.captures, 3);
  assert.equal((await f.request('GET', '/api/gbrain/timeline')).body.entries.length, 2);
}));
test('app RYW failed actions and refreshAfter false never start a reading refresh', () => run(async (f) => {
  const reads = f.controls.reads; f.controls.actionFail = true;
  assert.equal((await f.request('POST', '/api/gbrain/actions', { action: 'doctor-fast' })).status, 502);
  f.controls.actionFail = false;
  assert.equal((await f.request('POST', '/api/gbrain/actions', { action: 'preview-sync' })).status, 200);
  assert.equal(f.controls.reads, reads); assert.equal(f.controls.captures, 1);
}));
test('app RYW a rejected refresh never rejects the completed action or leaks its exception', () => run(async (f) => {
  f.service.timelineService.captureOverview = async () => { throw Error('private failed ledger write'); };
  const r = await f.request('POST', '/api/gbrain/actions', { action: 'doctor-fast' });
  assert.equal(r.status, 200); assert.equal(r.body.status, 'completed'); assert.equal(r.body.meta.stale, true);
  assert.equal(r.body.refreshPending, false); assert.equal(r.body.meta.error.code, 'gbrain_refresh_failed');
  assert.doesNotMatch(JSON.stringify(r.body), /private failed ledger/);
}));
test('app RYW simultaneous action refresh requests coalesce while preserving the latest write', () => run(async (f) => {
  const entered = f.block();
  const first = f.request('POST', '/api/gbrain/actions', { action: 'doctor-fast' }); await entered;
  const second = f.request('POST', '/api/gbrain/actions', { action: 'doctor-fast' });
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.status, 200); assert.equal(b.status, 200);
  assert.equal(a.body.refreshPending, true); assert.equal(b.body.refreshPending, true);
  const shared = f.service.refresh(); f.unblock(); await shared;
  const syn = (await f.request('GET', '/api/gbrain/synoptic')).body;
  assert.equal(syn.data.core.pages.value, 3); assert.equal(syn.meta.stale, false);
  assert.ok(f.controls.maxReads <= 2); assert.equal(f.controls.captures, 3);
}));
test('app RYW a newer unchanged reading does not append a duplicate ledger entry', () => run(async (f) => {
  const a = await f.request('POST', '/api/gbrain/actions', { action: 'doctor-fast' });
  f.controls.actionNoChange = true;
  const b = await f.request('POST', '/api/gbrain/actions', { action: 'doctor-fast' });
  assert.equal(a.status, 200); assert.equal(b.status, 200); assert.equal(b.body.meta.stale, false);
  assert.ok(Date.parse(b.body.observedAt) > Date.parse(a.body.observedAt));
  assert.equal((await f.request('GET', '/api/gbrain/timeline')).body.entries.length, 2);
}));
test('app RYW the scheduler can clear a failed action barrier with a later good reading', () => run(async (f) => {
  f.setFail(true);
  const r = await f.request('POST', '/api/gbrain/actions', { action: 'doctor-fast' });
  assert.equal(r.body.meta.stale, true);
  f.setFail(false); await f.service.refresh();
  const next = (await f.request('GET', '/api/gbrain/synoptic')).body;
  assert.equal(next.meta.stale, false); assert.equal(next.meta.ok, true);
  assert.equal(next.meta.error, null); assert.equal(next.data.core.pages.value, 2);
  assert.ok(Date.parse(next.meta.observedAt) > Date.parse(r.body.observedAt));
}));
