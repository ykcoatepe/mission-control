'use strict';

// Final-integration counter-examples for the one HTTP contract
// (docs/explanation-backend-redesign.md rule 5): every error is
// { error: { code, message } } with a real status; a deliberate client error
// keeps its message; nothing internal (stack, child-process text, home paths)
// reaches a response.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');

const { httpError, errorHandler, asyncHandler } = require('../server/core/http');
const { PUBLIC_MODULE_IDS } = require('../server/core/config');
const { buildCronRouter } = require('../server/routes/cron');
const { buildCalendarRouter } = require('../server/routes/calendar');
const { buildGBrainRouter } = require('../server/routes/gbrain');
const { createCronService } = require('../server/services/cronData');
const { createSettingsService } = require('../server/services/settingsData');
const { buildGBrainVerdict } = require('../server/sources/gbrain/verdict');

const quietLogger = { log() {}, warn() {}, error() {} };

async function serve(build, run) {
  const app = express();
  app.use(express.json());
  build(app);
  app.use(errorHandler({ logger: quietLogger }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function call(base, method, urlPath, body) {
  const response = await fetch(`${base}${urlPath}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: response.status, json, text };
}

function assertErrorContract(response, status, code) {
  assert.equal(response.status, status, response.text);
  assert.equal(typeof response.json?.error, 'object', `error must be an object: ${response.text}`);
  assert.equal(response.json.error.code, code);
  assert.equal(typeof response.json.error.message, 'string');
  assert.ok(response.json.error.message.length > 0);
  assert.doesNotMatch(response.text, /\/Users\/|\/home\/|\bat \S+:\d+:\d+|Bearer |stderr/);
}

// --- item 4: the final error handler ------------------------------------

test('item 4: httpError 501 and 4xx expose their message; foreign errors never do', async () => {
  await serve((app) => {
    app.get('/api/not-implemented', () => { throw httpError(501, 'not_implemented', 'Hermes jobs are read-only here'); });
    app.get('/api/send-enoent', () => {
      // What `send`/static produce: http-errors style, expose true, a filesystem path.
      const error = new Error("ENOENT: no such file or directory, stat '/Users/someone/app/frontend/dist/index.html'");
      error.status = 404;
      error.statusCode = 404;
      error.expose = true;
      throw error;
    });
    app.get('/api/raw-502', () => { const e = new Error('upstream said /Users/x'); e.status = 502; throw e; });
    app.get('/api/http-502', () => { throw httpError(502, 'upstream_failed', 'Upstream failed'); });
  }, async (base) => {
    const notImplemented = await call(base, 'GET', '/api/not-implemented');
    assertErrorContract(notImplemented, 501, 'not_implemented');
    assert.equal(notImplemented.json.error.message, 'Hermes jobs are read-only here');

    const enoent = await call(base, 'GET', '/api/send-enoent');
    assertErrorContract(enoent, 404, 'not_found');
    assert.doesNotMatch(enoent.json.error.message, /ENOENT|index\.html/);

    const raw502 = await call(base, 'GET', '/api/raw-502');
    assertErrorContract(raw502, 502, 'internal_error');
    assert.equal(raw502.json.error.message, 'Internal server error');

    const http502 = await call(base, 'GET', '/api/http-502');
    assertErrorContract(http502, 502, 'internal_error');
  });
});

test('item 4: cron validation, Hermes read-only 501 and calendar 400/404 keep their messages', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-contract-cron-'));
  const cronService = createCronService({
    openclawExec: async () => { throw Object.assign(new Error('openclaw: /Users/x/.openclaw broke'), { code: 1 }); },
    gatewayPort: 1,
    gatewayToken: '',
    getOpenclawDefaultModelKey: () => '',
    calendarFile: path.join(home, 'calendar-entries.json'),
    homeDir: home,
    fetchImpl: async () => { throw new Error('network disabled'); },
    operationsSoftDeadlineMs: 200,
  });
  const automationSource = { snapshot: () => ({ data: null, meta: { ok: false } }) };
  const calendarSource = { snapshot: () => ({ data: null, meta: { ok: false } }) };
  await serve((app) => {
    app.use(buildCronRouter({ cronService, openclawExec: async () => ({ stdout: '' }), automationSource }));
    app.use(buildCalendarRouter({ calendarService: cronService, calendarSource }));
  }, async (base) => {
    const readOnly = await call(base, 'POST', '/api/cron/hermes:job-1/run', {});
    assertErrorContract(readOnly, 501, 'hermes_cron_read_only');
    assert.match(readOnly.json.error.message, /read-only/);

    const badId = await call(base, 'DELETE', '/api/cron/-rf', {});
    assertErrorContract(badId, 400, 'invalid_cron_id');
    assert.equal(badId.json.error.message, 'Invalid cron job id');

    const missingHermes = await call(base, 'POST', '/api/cron/hermes:job-1/toggle', { enabled: true });
    assert.ok([404, 409].includes(missingHermes.status), missingHermes.text);
    assert.equal(typeof missingHermes.json.error.code, 'string');

    const noTitle = await call(base, 'POST', '/api/calendar', { title: '  ' });
    assertErrorContract(noTitle, 400, 'calendar_title_required');
    assert.equal(noTitle.json.error.message, 'title required');

    const missing = await call(base, 'PATCH', '/api/calendar/entry-nope', { title: 'x' });
    assertErrorContract(missing, 404, 'calendar_entry_not_found');
    assert.equal(missing.json.error.message, 'Calendar entry not found');

    // item 5: no fresh scheduler evidence is a typed 503, not a generic 500.
    const sync = await call(base, 'POST', '/api/calendar/sync-cron', {});
    assertErrorContract(sync, 503, 'calendar_scheduler_unavailable');
    assert.match(sync.json.error.message, /scheduler/i);
    assert.equal(fs.existsSync(path.join(home, 'calendar-entries.json')), false, 'a failed sync wrote nothing');
  });
});

// --- items 1 and 2: GBrain reads and actions ------------------------------

function gbrainServiceFixture({ health = null, sources = null, error = null } = {}) {
  const meta = (name) => ({
    ok: !error, stale: Boolean(error), observedAt: health || sources ? '2026-11-11T12:00:00.000Z' : null,
    ageMs: null, error, latencyMs: null, source: `gbrain.${name}`,
  });
  const snap = (name, data) => ({ data, meta: meta(name) });
  return {
    probeSnapshot: (name) => snap(name, name === 'health' ? health : name === 'sources' ? sources : null),
    readSnapshot: async () => ({ live: { health: health ? { ...health, meta: meta('health') }
      : { ok: false, status: 'unavailable', mode: 'live-read-only', checkedAt: null, error: 'GBrain reading unavailable', meta: meta('health') } } }),
    timelineService: { readTimeline: () => ({}) },
  };
}

test('item 1: GBrain health/sources/version without a reading answer the unavailable contract, not 200 ok:false', async () => {
  const error = { code: 'gbrain_timeout', message: 'GBrain read timed out' };
  await serve((app) => app.use(buildGBrainRouter({ gbrainOverviewService: gbrainServiceFixture({ error }) })), async (base) => {
    for (const name of ['health', 'sources', 'version']) {
      const response = await call(base, 'GET', `/api/gbrain/${name}`);
      assertErrorContract(response, 503, `gbrain_${name}_unavailable`);
      assert.equal(response.json.meta.source, `gbrain.${name}`, 'meta travels with the 503');
      assert.equal('ok' in response.json, false, 'no 200-style ok:false body');
    }
  });
});

test('item 1: a failed refresh keeps the last good GBrain reading, marked stale', async () => {
  const error = { code: 'gbrain_timeout', message: 'GBrain read timed out' };
  const health = { ok: true, mode: 'live-read-only', status: 'healthy', score: 98, metrics: { stalePages: 0 } };
  const sources = { ok: true, mode: 'live-read-only', sources: [{ id: 'default' }] };
  await serve((app) => app.use(buildGBrainRouter({ gbrainOverviewService: gbrainServiceFixture({ health, sources, error }) })), async (base) => {
    const h = await call(base, 'GET', '/api/gbrain/health');
    assert.equal(h.status, 200);
    assert.equal(h.json.score, 98);
    assert.equal(h.json.meta.stale, true);
    assert.equal(h.json.meta.error.code, 'gbrain_timeout');
    const s = await call(base, 'GET', '/api/gbrain/sources');
    assert.equal(s.status, 200);
    assert.deepEqual(s.json.sources, [{ id: 'default' }]);
  });
});

function fakeActionExec(result) {
  const calls = [];
  return {
    calls,
    run: async (bin, args, options) => {
      calls.push({ bin, args, lane: options.lane });
      return typeof result === 'function' ? result(args) : result;
    },
  };
}

test('item 2: POST /api/gbrain/actions errors use { error: { code, message } } and keep status codes and fields', async () => {
  const cases = [
    { body: { action: 'sync-sources' }, status: 400, code: 'confirmation_required', exec: null,
      fields: { ok: false, action: 'sync-sources', status: 'confirmation-required' } },
    { body: { action: 'rm-rf' }, status: 400, code: 'gbrain_action_rejected', exec: null,
      fields: { ok: false, status: 'rejected' } },
    { body: { action: 'doctor-fast' }, status: 504, code: 'gbrain_action_timed_out',
      exec: { ok: false, timedOut: true, stdout: '', stderr: '', code: null, error: { code: 'timeout' } },
      fields: { ok: false, status: 'timed-out', pending: false, refreshAfter: true } },
    { body: { action: 'doctor-fast' }, status: 502, code: 'gbrain_action_failed',
      exec: { ok: false, timedOut: false, stdout: '', stderr: 'boom', code: 1 },
      fields: { ok: false, status: 'failed' } },
  ];
  for (const testCase of cases) {
    const exec = fakeActionExec(testCase.exec);
    await serve((app) => app.use(buildGBrainRouter({ gbrainOverviewService: gbrainServiceFixture(), exec })), async (base) => {
      const response = await call(base, 'POST', '/api/gbrain/actions', testCase.body);
      assertErrorContract(response, testCase.status, testCase.code);
      for (const [key, value] of Object.entries(testCase.fields)) assert.deepEqual(response.json[key], value, `${testCase.code}.${key}`);
      assert.match(response.json.checkedAt, /^\d{4}-/);
      if (testCase.status === 504) assert.equal(typeof response.json.summary, 'string');
      if (testCase.exec === null) assert.equal(exec.calls.length, 0, 'nothing ran');
    });
  }
});

test('item 2: busy is 409 in the unified shape; a success carries no error field', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const exec = fakeActionExec(async () => { await gate; return { ok: true, stdout: '{"ok":true}', stderr: '', code: 0 }; });
  await serve((app) => app.use(buildGBrainRouter({ gbrainOverviewService: gbrainServiceFixture(), exec })), async (base) => {
    const first = call(base, 'POST', '/api/gbrain/actions', { action: 'doctor-fast' });
    await new Promise((resolve) => setTimeout(resolve, 50));
    let busy;
    try {
      busy = await call(base, 'POST', '/api/gbrain/actions', { action: 'doctor-fast' });
    } finally {
      release();
    }
    const done = await first;
    assertErrorContract(busy, 409, 'gbrain_action_busy');
    assert.equal(busy.json.status, 'busy');
    assert.equal(done.status, 200);
    assert.equal(done.json.ok, true);
    assert.equal(done.json.status, 'completed');
    assert.equal('error' in done.json, false);
    assert.deepEqual(exec.calls.map((c) => [c.bin, c.lane]), [['gbrain', 'gbrain-action']]);
  });
});

// --- item 3: operations overview -----------------------------------------

test('item 3: a failed operations overview is a 503 in the error contract', async () => {
  const { buildOperationsRouter } = require('../server/routes/operations');
  await serve((app) => app.use(buildOperationsRouter({
    operationsOverviewService: { getOverview: async () => { throw new Error('Bearer secret from /Users/example/private'); } },
  })), async (base) => {
    const response = await call(base, 'GET', '/api/operations/overview');
    assertErrorContract(response, 503, 'operations_unavailable');
    assert.equal('ok' in response.json, false);
  });
});

// --- items 6 and 7: setup ------------------------------------------------

function settingsFixture(extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-contract-setup-'));
  const configPath = path.join(dir, 'mc-config.json');
  const existing = {
    name: 'Ops', modules: { costs: true, scout: true, workshop: false },
    scout: { enabled: true, queries: [{ q: 'keep me' }] }, gateway: { port: 1, token: '' },
  };
  fs.writeFileSync(configPath, JSON.stringify(existing));
  const writes = [];
  const mcConfig = structuredClone(existing);
  const service = createSettingsService({
    mcConfig,
    configStore: { persist(next) { writes.push(structuredClone(next)); fs.writeFileSync(configPath, JSON.stringify(next)); } },
    homeDir: dir,
    missionControlConfigPath: configPath,
    missionControlDefaultConfigPath: path.join(dir, 'missing-default.json'),
    missionControlPackagePath: path.join(dir, 'package.json'),
    missionControlRoot: dir,
    gatewayPort: 1,
    gatewayToken: '',
    fetchImpl: async () => { throw new Error('no network'); },
    ...extra,
  });
  return { service, writes, configPath };
}

test('item 6: setup refuses removed-module blocks and unknown module ids; unknown stored blocks survive a write', () => {
  const { service, writes, configPath } = settingsFixture();
  assert.throws(() => service.updateSetup({ scout: { enabled: true } }), { status: 400, code: 'unsupported_setup_field' });
  assert.throws(() => service.updateSetup({ modules: { scout: true } }), { status: 400, code: 'unknown_module' });
  assert.throws(() => service.updateSetup({ modules: { costs: 'yes' } }), { status: 400, code: 'invalid_module_flag' });
  assert.equal(writes.length, 0, 'a refused setup writes nothing');
  service.updateSetup({ dashboardName: 'Ops 2', modules: { costs: false } });
  const saved = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.equal(saved.name, 'Ops 2');
  assert.equal(saved.modules.costs, false);
  assert.deepEqual(saved.scout, { enabled: true, queries: [{ q: 'keep me' }] }, 'an existing operator block is preserved');
  assert.equal(saved.modules.scout, true, 'an existing removed flag is preserved, not an error');
});

test('item 6: module ids and the default config list only what exists now', () => {
  for (const removed of ['scout', 'docs', 'skills', 'office', 'team', 'workshop', 'chat', 'agents']) {
    assert.equal(PUBLIC_MODULE_IDS.includes(removed), false, `${removed} is still a public module id`);
  }
  const defaults = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'mc-config.default.json'), 'utf8'));
  for (const removed of ['scout', 'docs', 'skills', 'office', 'team', 'workshop', 'chat', 'agents']) {
    assert.equal(removed in (defaults.modules || {}), false, `default modules.${removed}`);
  }
  assert.equal('scout' in defaults, false);
  assert.equal('bucket' in (defaults.aws || {}), false);
  for (const id of Object.keys(defaults.modules)) assert.ok(PUBLIC_MODULE_IDS.includes(id), id);
});

test('item 7: gatewayRunning comes from the in-memory reachability reading, never a request-time probe', async () => {
  let reading = { data: { gateways: { openclaw: { state: 'up' } } }, meta: { ok: true, stale: false } };
  const { service } = settingsFixture({ gatewayReachability: () => reading });
  assert.equal((await service.getSetupStatus()).gatewayRunning, true);
  reading = { data: { gateways: { openclaw: { state: 'down' } } }, meta: { ok: true, stale: false } };
  assert.equal((await service.getSetupStatus()).gatewayRunning, false);
  reading = { data: { gateways: { openclaw: { state: 'up' } } }, meta: { ok: false, stale: true } };
  assert.equal((await service.getSetupStatus()).gatewayRunning, null, 'stale evidence is not a reading');
  reading = { data: null, meta: { ok: false, stale: true } };
  assert.equal((await service.getSetupStatus()).gatewayRunning, null);
});

// --- items 8 and 9: the GBrain verdict -------------------------------------

function verdictInput(overrides = {}) {
  return {
    core: { state: 'healthy', quality: { value: 100 } },
    sources: [], sourcesState: 'healthy',
    queue: { state: 'healthy' },
    readers: [], readersState: 'inactive',
    live: { health: { status: 'healthy', metrics: {} } },
    probes: {},
    ...overrides,
  };
}
const failedProbe = { data: null, meta: { error: { code: 'x' }, stale: true } };

test('item 8: one ordering — critical > warning > unavailable > healthy > inactive', () => {
  assert.equal(buildGBrainVerdict(verdictInput({ core: { state: 'critical', quality: { value: 10 } }, probes: { stats: failedProbe } })).state, 'critical');
  assert.equal(buildGBrainVerdict(verdictInput({ queue: { state: 'warning' }, probes: { stats: failedProbe } })).state, 'warning');
  assert.equal(buildGBrainVerdict(verdictInput({ probes: { stats: failedProbe } })).state, 'unavailable');
  assert.equal(buildGBrainVerdict(verdictInput()).state, 'healthy');
  const frontend = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'src', 'lib', 'state.ts'), 'utf8');
  assert.match(frontend, /critical > warning > unavailable > healthy > inactive/);
});

test('item 9: overdue link extraction and missing embeddings are verdict reasons even when GBrain says healthy', () => {
  const verdict = buildGBrainVerdict(verdictInput({
    live: { health: { status: 'healthy', metrics: { stalePages: 7, stalePagesOverdue: 5, missingEmbeddings: 3, missingEmbeddingsOverdue: 2 } } },
  }));
  assert.equal(verdict.state, 'warning');
  const ids = verdict.reasons.map((r) => r.elementId);
  assert.ok(ids.includes('link-extraction'), JSON.stringify(verdict.reasons));
  assert.ok(ids.includes('missing-embeddings'), JSON.stringify(verdict.reasons));
  const catchingUp = buildGBrainVerdict(verdictInput({
    live: { health: { status: 'healthy', metrics: { stalePages: 7, stalePagesOverdue: 0, stalePagesCatchingUp: 7 } } },
  }));
  assert.equal(catchingUp.state, 'healthy', 'pages still inside the tolerance are not overdue');
});

// --- the generic handler still wraps async rejections --------------------

test('asyncHandler rejection with a home path never leaks', async () => {
  await serve((app) => app.get('/api/x', asyncHandler(async () => { throw new Error(`${os.homedir()}/secret`); })), async (base) => {
    const response = await call(base, 'GET', '/api/x');
    assertErrorContract(response, 500, 'internal_error');
  });
});
