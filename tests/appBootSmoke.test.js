// Boot smoke test: build the whole app through createApp on port 0 with
// injected fakes. No real CLI, no network, no writes outside temp dirs.
//
// Asserts: the mounted route table, the JSON 404 contract, /api/health, and
// that a representative set of GET routes never writes to disk.
//
// Every GET is pure: the sweep below covers the routes that compose from
// memory, and the contract sweep at the end forces a failure on every route.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const childProcess = require('node:child_process');

// --- sandbox: temp root + temp HOME, no PATH binaries, no network ----------
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-boot-root-'));
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-boot-home-'));
const EMPTY_BIN = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-boot-bin-'));
process.env.HOME = HOME;
process.env.MC_USER_HOME = HOME;
process.env.PATH = EMPTY_BIN;
process.env.HERMES_BIN = path.join(EMPTY_BIN, 'hermes');

fs.writeFileSync(path.join(ROOT, 'mc-config.json'), JSON.stringify({ name: 'Boot Test', gateway: { port: 1, token: '' }, modules: {} }, null, 2));
fs.writeFileSync(path.join(ROOT, 'package.json'), JSON.stringify({ name: 'mc-boot', version: '0.0.0-test' }));

// Any direct child-process use (bypassing the core runner) is a failure.
const directSpawns = [];
for (const name of ['exec', 'execFile', 'spawn', 'execSync', 'execFileSync', 'spawnSync', 'fork']) {
  const original = childProcess[name];
  childProcess[name] = function forbidden(...args) {
    directSpawns.push(`${name} ${String(args[0])}`);
    if (name.endsWith('Sync')) throw new Error(`child_process.${name} is forbidden in the boot smoke test`);
    const error = new Error(`child_process.${name} is forbidden in the boot smoke test`);
    const callback = args.find((arg) => typeof arg === 'function');
    if (callback) setImmediate(() => callback(error, '', ''));
    return { pid: 0, kill() {}, on() { return this; }, stdout: null, stderr: null };
  };
  childProcess[name].original = original;
}

const networkCalls = [];
global.fetch = async (url) => {
  networkCalls.push(String(url));
  throw new Error('network disabled in boot smoke test');
};

const { createApp } = require('../server/app');
const { loadConfig } = require('../server/core/config');
const { createExec } = require('../server/core/exec');
const { listRoutes } = require('../server/core/http');

const EXPECTED_ROUTES = [
  'GET /api/health', 'GET /healthz',
  'GET /api/gbrain/overview', 'GET /api/gbrain/health', 'GET /api/gbrain/sources', 'GET /api/gbrain/version',
  'GET /api/gbrain/integration-health', 'GET /api/gbrain/actions', 'POST /api/gbrain/actions', 'GET /api/gbrain/timeline',
  'GET /api/hermes-kanban',
  'GET /api/operations/overview',
  'GET /api/status',
  'GET /api/cron', 'POST /api/cron/:id/toggle', 'POST /api/cron/:id/run', 'POST /api/cron/create', 'DELETE /api/cron/:id',
  'PATCH /api/cron/:id/model',
  // runtime area: calendar route contract
  'GET /api/calendar', 'POST /api/calendar/repair', 'POST /api/calendar/sync-cron', 'POST /api/calendar', 'PATCH /api/calendar/:id',
  // end runtime area: calendar route contract
  'GET /cron-search',
  'GET /api/aws/costs',
  'GET /api/models',
  'GET /api/costs', 'GET /api/costs/codexbar', 'GET /api/costs/months',
  'GET /api/sessions',
  'POST /api/settings/budget', 'GET /api/config', 'GET /api/setup', 'POST /api/setup', 'GET /api/settings',
  'GET /api/settings/model-routing', 'POST /api/settings/model-routing', 'GET /api/settings/heartbeat', 'POST /api/settings/heartbeat',
  'GET /api/settings/export', 'POST /api/settings/import',
  'GET /api/ollama/telemetry', 'GET /api/ollama/telemetry/history', 'GET /api/ollama/telemetry/models',
  'GET /api/councils/summary', 'GET /api/councils/decisions', 'GET /api/councils/governance/scorecard',
  'GET /api/councils/decisions/:decisionId/timeline', 'POST /api/councils/decisions/:decisionId/action',
  'GET /^\\/(?!api(?:\\/|$)).*/',
];

const PURE_GET_SWEEP = [
  '/api/health',
  '/healthz',
  '/api/status',
  '/api/sessions',
  '/api/operations/overview',
  '/api/config',
  '/api/settings',
  '/api/setup',
  '/api/settings/model-routing',
  '/api/settings/heartbeat',
  '/api/models',
  '/api/gbrain/actions',
  '/api/hermes-kanban',
  '/api/aws/costs',
  '/api/councils/summary',
  '/api/councils/decisions',
  '/api/councils/governance/scorecard',
  '/api/councils/decisions/DEC-1/timeline',
  '/api/nope',
];

// gbrain area: new read envelopes and all memory-only dashboard GETs.
EXPECTED_ROUTES.splice(EXPECTED_ROUTES.indexOf('GET /api/gbrain/timeline') + 1, 0,
  'GET /api/gbrain/synoptic', 'GET /api/gbrain/search', 'GET /api/gbrain/pages/:slug', 'GET /api/gbrain/graph');
PURE_GET_SWEEP.push('/api/gbrain/overview', '/api/gbrain/health', '/api/gbrain/sources',
  '/api/gbrain/version', '/api/gbrain/integration-health', '/api/gbrain/timeline',
  '/api/gbrain/synoptic', '/api/gbrain/graph?around=projects%2Fmission-control');
// end gbrain area

// usage area: route contract and pure-GET sweep.
EXPECTED_ROUTES.splice(EXPECTED_ROUTES.indexOf('GET /api/costs/months') + 1, 0, 'GET /api/usage/summary');
PURE_GET_SWEEP.push('/api/costs', '/api/costs/months', '/api/costs/codexbar', '/api/usage/summary');
// end usage area

// attention area: loops/services/signals mount with the operations sources
// (before /api/health); all four are memory-only GETs.
EXPECTED_ROUTES.unshift('GET /api/loops', 'GET /api/loops/:project', 'GET /api/services', 'GET /api/signals');
PURE_GET_SWEEP.push('/api/loops', '/api/loops/some-project', '/api/services', '/api/signals');
test('boot smoke (attention area): sources are scheduled, GETs compose from memory, refresh goes through the runner', async () => {
  const calls = [];
  const exec = createExec({
    execFileImpl(file, args, options, callback) {
      calls.push([file, ...args]);
      setImmediate(() => callback(Object.assign(new Error('fake CLI'), { code: 1 }), '', 'unavailable'));
      return { pid: 0, kill() {} };
    },
  });
  // Own project root, so the shared ROOT's boot-time expectations stay intact.
  const attentionRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-boot-attention-'));
  for (const name of ['mc-config.json', 'package.json']) fs.copyFileSync(path.join(ROOT, name), path.join(attentionRoot, name));
  const app = createApp({
    config: loadConfig({ rootDir: attentionRoot, homeDir: HOME, env: { PORT: '0' } }),
    exec,
    logger: { log() {}, warn() {}, error() {} },
    services: {
      gbrainOverviewService: { readSnapshot: unavailable },
      hermesKanbanService: { profile: 'test', getBoard: unavailable, getTask: unavailable, runAction: unavailable },
      hermesGatewayHealthService: { getHealth: async () => ({ ok: false, unavailable: true }) },
      notionActivity: { fetchNotionActivity: async () => null },
    },
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address();
  app.locals.runtime.setBoundPort(port);
  const before = { root: treeState(attentionRoot), home: treeState(HOME) };
  try {
    const jobIds = app.locals.runtime.scheduler.status().jobs.map((job) => job.id);
    for (const id of ['operations.status', 'operations.sessions', 'operations.cron', 'operations.hermes',
      'operations.hermesGateway', 'operations.gbrain', 'mloop.loops', 'launchd.services', 'services.reachability']) {
      assert.ok(jobIds.includes(id), `${id} is not scheduled`);
    }
    const loops = await request(port, { urlPath: '/api/loops' });
    assert.equal(loops.status, 503);
    assert.equal(loops.json.data, null);
    assert.equal(loops.json.meta.source, 'mloop.loops');
    const services = await request(port, { urlPath: '/api/services' });
    assert.equal(services.status, 503);
    const signals = await request(port, { urlPath: '/api/signals' });
    assert.equal(signals.status, 200);
    assert.equal(signals.json.data.loops, null);
    assert.equal(signals.json.data.services, null);
    assert.equal(signals.json.data.systems.gbrain.state, 'unavailable');
    const overview = await request(port, { urlPath: '/api/operations/overview' });
    assert.equal(overview.json.meta.source, 'operations.overview');
    assert.deepEqual(calls, [], 'a GET started a process');

    await app.locals.runtime.scheduler.runNow('mloop.loops');
    await app.locals.runtime.scheduler.runNow('launchd.services');
    assert.deepEqual(calls.map(([file, ...args]) => [path.basename(file), args.join(' ')]), [
      ['mloop', 'check --all-projects --json'],
      ['launchctl', 'list'],
    ]);
    const after = await request(port, { urlPath: '/api/loops' });
    assert.equal(after.json.meta.error.code, 'mloop_failed');
    assert.doesNotMatch(after.body, /fake CLI|unavailable/);
    assert.deepEqual(treeState(attentionRoot), before.root);
    assert.deepEqual(treeState(HOME), before.home);
  } finally {
    app.locals.runtime.dispose();
    await new Promise((resolve) => server.close(resolve));
  }
});
// end attention area

function treeState(dir) {
  const out = {};
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        out[`${full}/`] = 'dir';
        walk(full);
      } else {
        const stat = fs.statSync(full);
        out[full] = `${stat.size}:${stat.mtimeMs}`;
      }
    }
  };
  walk(dir);
  return out;
}

function request(port, { method = 'GET', urlPath, headers = {} }) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      method,
      path: urlPath,
      headers: { Host: `127.0.0.1:${port}`, ...headers },
    }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        let json = null;
        try {
          json = JSON.parse(body);
        } catch {}
        resolve({ status: res.statusCode, headers: res.headers, json, body });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

const execCalls = [];
function fakeExecFile(file, args, options, callback) {
  execCalls.push({ file, args: args.join(' ') });
  const error = Object.assign(new Error('fake CLI: not available in tests'), { code: 1 });
  setImmediate(() => callback(error, '', 'unavailable'));
  return { pid: 0, kill() {} };
}

const unavailable = () => Promise.reject(Object.assign(new Error('fake upstream unavailable'), { code: 'fake_unavailable' }));

test('boot smoke: route table, JSON 404, health and pure GETs', async () => {
  const before = { root: treeState(ROOT), home: treeState(HOME) };
  const logLines = [];
  const logger = { log: (line) => logLines.push(String(line)), warn: () => {}, error: () => {} };
  const config = loadConfig({ rootDir: ROOT, homeDir: HOME, env: { PORT: '0' } });
  const exec = createExec({ execFileImpl: fakeExecFile });

  const app = createApp({
    config,
    exec,
    logger,
    services: {
      gbrainOverviewService: { readSnapshot: unavailable },
      hermesKanbanService: { profile: 'test', getBoard: unavailable, getTask: unavailable, runAction: unavailable },
      hermesGatewayHealthService: { getHealth: async () => ({ ok: false, unavailable: true, error: 'fake' }) },
      notionActivity: { fetchNotionActivity: async () => null },
    },
  });
  const runtime = app.locals.runtime;
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address();
  runtime.setBoundPort(port);

  try {
    // Building the app writes nothing except the empty multer upload
    // directory of the settings import, as before.
    const afterBoot = { root: treeState(ROOT), home: treeState(HOME) };
    const bootCreated = Object.keys(afterBoot.root).filter((key) => !(key in before.root)).map((key) => path.relative(ROOT, key));
    assert.deepEqual(bootCreated.sort(), ['documents', 'documents/.tmp-settings']);
    assert.deepEqual(afterBoot.home, before.home);
    for (const key of Object.keys(before.root)) assert.equal(afterBoot.root[key], before.root[key], `boot changed ${key}`);
    before.root = afterBoot.root;

    assert.deepEqual(listRoutes(app), EXPECTED_ROUTES);
    assert.equal(execCalls.length, 0, 'building the app must not start a process');

    const results = {};
    for (const urlPath of PURE_GET_SWEEP) {
      results[urlPath] = await request(port, { urlPath });
      assert.notEqual(results[urlPath].status, undefined);
      assert.match(String(results[urlPath].headers['content-type']), /application\/json/, `${urlPath} must answer JSON`);
    }
    // Let any background work a GET may have kicked off finish.
    await new Promise((resolve) => setTimeout(resolve, 300));

    assert.deepEqual(treeState(ROOT), before.root, 'a GET wrote under the project root');
    assert.deepEqual(treeState(HOME), before.home, 'a GET wrote under HOME');
    assert.deepEqual(directSpawns, [], 'a route spawned a process outside the core runner');
    // A request never spawns: not directly, and not through the runner.
    assert.deepEqual(execCalls, [], 'a swept GET started a process through the core runner');
    assert.deepEqual(networkCalls.filter((url) => !/^http:\/\/127\.0\.0\.1:1\//.test(url)), [], 'no network beyond the (fake) local gateway');

    // JSON 404 contract.
    assert.equal(results['/api/nope'].status, 404);
    assert.deepEqual(results['/api/nope'].json, { error: { code: 'not_found', message: 'No API route for GET /api/nope' } });
    const post404 = await request(port, { method: 'POST', urlPath: '/api/nope/deeper', headers: { 'X-MC-Request': '1' } });
    assert.equal(post404.status, 404);
    assert.equal(post404.json.error.code, 'not_found');

    // Health: liveness plus scheduler, sources, lanes and event-loop lag.
    const health = results['/api/health'].json;
    assert.equal(health.ok, true);
    assert.equal(health.status, 'ok');
    assert.equal(health.service, 'mission-control');
    assert.ok('meanMs' in health.eventLoop);
    // --- runtime area: source registration and extended pure-GET sweep ----
    const runtimeSourceIds = ['openclaw.status', 'openclaw.automations', 'openclaw.calendar', 'openclaw.models', 'ollama.telemetry'];
    assert.deepEqual(health.scheduler.jobs.map((job) => job.id).filter(id => runtimeSourceIds.includes(id)), runtimeSourceIds);
    const runtimeGetBefore = { root: treeState(ROOT), home: treeState(HOME), exec: execCalls.length, network: networkCalls.length };
    for (const urlPath of ['/api/cron', '/api/calendar', '/api/models', '/api/settings/export', '/api/ollama/telemetry', '/api/ollama/telemetry/history', '/api/ollama/telemetry/models']) {
      const response = await request(port, { urlPath });
      assert.ok([200, 503].includes(response.status), `${urlPath} uses a typed unavailable response`);
    }
    assert.deepEqual(treeState(ROOT), runtimeGetBefore.root);
    assert.deepEqual(treeState(HOME), runtimeGetBefore.home);
    assert.equal(execCalls.length, runtimeGetBefore.exec, 'runtime GET never starts a process');
    assert.equal(networkCalls.length, runtimeGetBefore.network, 'runtime GET never probes upstream');
    const deniedRepair = await request(port, { method: 'POST', urlPath: '/api/calendar/repair', headers: { Origin: 'https://untrusted.invalid' } });
    assert.equal(deniedRepair.status, 403, 'repair uses the core write guard');
    const repair = await request(port, { method: 'POST', urlPath: '/api/calendar/repair', headers: { 'X-MC-Request': '1', Origin: `http://localhost:${port}` } });
    assert.equal(repair.status, 200);
    assert.equal(repair.json.repaired, false);
    assert.deepEqual(repair.json.counts, { kept: 0, quarantined: 0, duplicates: 0 });
    assert.ok(runtime.auditLog.readEntries().some(entry => entry.method === 'POST' && entry.path === '/api/calendar/repair' && entry.status === 200), 'repair is audited');
    // --- end runtime area ------------------------------------------------
    assert.equal(health.exec.lanes.openclaw.concurrency, 1);
    assert.equal(health.guard.writeGuardMode, 'report-only');
    assert.doesNotMatch(JSON.stringify(health), /token":\s*"[^"[]/);

    // Existing payload shapes stay, meta is added alongside.
    const status = results['/api/status'].json;
    assert.equal(status.agent.name, 'Boot Test');
    assert.equal(status.meta.source, 'openclaw.status');
    assert.equal(status.meta.ok, false, 'no observed status yet');
    const sessions = results['/api/sessions'].json;
    assert.ok(Array.isArray(sessions.sessions));
    assert.equal(typeof sessions.count, 'number');
    assert.equal(sessions.meta.ok, false);
    const overview = results['/api/operations/overview'].json;
    assert.ok(overview.systems && overview.systems.openclaw);

    // Every request was logged as one structured line.
    const logged = logLines.filter((line) => line.startsWith('{')).map((line) => JSON.parse(line));
    assert.ok(logged.some((entry) => entry.path === '/api/status' && entry.status === 200));

    // The scheduler owns the status refresh: running it goes through the
    // openclaw lane (fake CLI fails), and the source reports the failure.
    const callsBefore = execCalls.length;
    await runtime.scheduler.runNow('openclaw.status');
    const statusCalls = execCalls.slice(callsBefore).map((call) => call.args);
    assert.ok(statusCalls.includes('status'));
    assert.ok(statusCalls.includes('system heartbeat last --json'));
    const after = runtime.sources.status.snapshot();
    assert.equal(after.data, null);
    assert.equal(after.meta.error.code, 'openclaw_status_unavailable');
    assert.equal(exec.status().lanes.openclaw.maxObservedRunning, 1);
  } finally {
    runtime.dispose();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('boot smoke: mutating requests are audited; report-only guard passes them', async () => {
  const config = loadConfig({ rootDir: ROOT, homeDir: HOME, env: {} });
  const app = createApp({
    config,
    exec: createExec({ execFileImpl: fakeExecFile }),
    logger: { log() {}, warn() {}, error() {} },
    services: {
      gbrainOverviewService: { readSnapshot: unavailable },
      hermesKanbanService: { profile: 'test', getBoard: unavailable },
      hermesGatewayHealthService: { getHealth: async () => ({ ok: false }) },
      notionActivity: { fetchNotionActivity: async () => null },
    },
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address();
  app.locals.runtime.setBoundPort(port);
  try {
    const evil = await request(port, { method: 'POST', urlPath: '/api/nope/audit', headers: { Origin: `http://localhost:${port}.evil.com` } });
    assert.equal(evil.status, 403);
    assert.equal(evil.json.error.code, 'forbidden_origin');

    const reported = await request(port, { method: 'POST', urlPath: '/api/nope/audit', headers: { Origin: `http://localhost:${port}` } });
    assert.equal(reported.status, 404, 'report-only mode lets the request through to routing');

    const badHost = await request(port, { urlPath: '/api/health', headers: { Host: 'evil.com' } });
    assert.equal(badHost.status, 403);

    await new Promise((resolve) => setTimeout(resolve, 20));
    const entries = app.locals.runtime.auditLog.readEntries().filter((e) => e.path === '/api/nope/audit');
    assert.deepEqual(entries.map((e) => [e.method, e.path, e.status, e.writeHeader]), [
      ['POST', '/api/nope/audit', 403, false],
      ['POST', '/api/nope/audit', 404, false],
    ]);
    assert.equal(app.locals.runtime.guard.status().counters.writeReported, 1);
  } finally {
    app.locals.runtime.dispose();
    await new Promise((resolve) => server.close(resolve));
  }
});

// --- review round 1: static files and the SPA never answer /api/* ----------
test('boot smoke: a file at frontend/dist/api/health cannot shadow the API', async () => {
  const distRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-boot-dist-'));
  fs.writeFileSync(path.join(distRoot, 'mc-config.json'), JSON.stringify({ name: 'Dist Test', gateway: { port: 1 } }));
  fs.mkdirSync(path.join(distRoot, 'frontend', 'dist', 'api', 'nope'), { recursive: true });
  fs.writeFileSync(path.join(distRoot, 'frontend', 'dist', 'api', 'health'), 'SHADOW');
  fs.writeFileSync(path.join(distRoot, 'frontend', 'dist', 'api', 'nope', 'index.html'), 'SHADOW');
  fs.writeFileSync(path.join(distRoot, 'frontend', 'dist', 'index.html'), '<!doctype html>SPA');
  fs.writeFileSync(path.join(distRoot, 'frontend', 'dist', 'app.js'), 'console.log(1)');
  const config = loadConfig({ rootDir: distRoot, homeDir: HOME, env: {} });
  const app = createApp({
    config,
    exec: createExec({ execFileImpl: fakeExecFile }),
    logger: { log() {}, warn() {}, error() {} },
    services: {
      gbrainOverviewService: { readSnapshot: unavailable },
      hermesKanbanService: { profile: 'test', getBoard: unavailable },
      hermesGatewayHealthService: { getHealth: async () => ({ ok: false }) },
      notionActivity: { fetchNotionActivity: async () => null },
    },
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address();
  app.locals.runtime.setBoundPort(port);
  try {
    for (const urlPath of ['/api/health', '/API/health', '/api/health/']) {
      const response = await request(port, { urlPath });
      assert.equal(response.status, 200, urlPath);
      assert.equal(response.json?.service, 'mission-control', `${urlPath} must come from the API, not the file`);
    }
    for (const urlPath of ['/api/nope', '/api/nope/', '/API/nope', '/%61pi/nope']) {
      const response = await request(port, { urlPath });
      assert.equal(response.status, 404, urlPath);
      assert.equal(response.json?.error?.code, 'not_found', `${urlPath} must be the JSON 404`);
      assert.doesNotMatch(response.body, /SHADOW|SPA/);
    }
    const asset = await request(port, { urlPath: '/app.js' });
    assert.equal(asset.status, 200, 'ordinary static files still serve');
    const spa = await request(port, { urlPath: '/attention' });
    assert.match(spa.body, /SPA/, 'non-API paths still get the SPA');
  } finally {
    app.locals.runtime.dispose();
    await new Promise((resolve) => server.close(resolve));
  }
});

// --- review round 2: one canonical API classification, any method ----------
test('boot smoke: no encoding, dot-segment or method variant lets static files or the SPA answer an API path', async () => {
  const distRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-boot-dist2-'));
  fs.writeFileSync(path.join(distRoot, 'mc-config.json'), JSON.stringify({ name: 'Dist Test', gateway: { port: 1 } }));
  fs.mkdirSync(path.join(distRoot, 'frontend', 'dist', 'api', 'nope'), { recursive: true });
  fs.mkdirSync(path.join(distRoot, 'public', 'api'), { recursive: true });
  fs.writeFileSync(path.join(distRoot, 'frontend', 'dist', 'api', 'health'), 'SHADOW');
  fs.writeFileSync(path.join(distRoot, 'frontend', 'dist', 'api', 'nope', 'index.html'), 'SHADOW');
  fs.writeFileSync(path.join(distRoot, 'frontend', 'dist', 'api%2Fnope'), 'SHADOW');
  fs.writeFileSync(path.join(distRoot, 'public', 'api', 'health'), 'SHADOW');
  fs.writeFileSync(path.join(distRoot, 'frontend', 'dist', 'index.html'), '<!doctype html>SPA');
  fs.writeFileSync(path.join(distRoot, 'frontend', 'dist', 'app.js'), 'console.log(1)');
  const config = loadConfig({ rootDir: distRoot, homeDir: HOME, env: {} });
  const app = createApp({
    config,
    exec: createExec({ execFileImpl: fakeExecFile }),
    logger: { log() {}, warn() {}, error() {} },
    services: {
      gbrainOverviewService: { readSnapshot: unavailable },
      hermesKanbanService: { profile: 'test', getBoard: unavailable },
      hermesGatewayHealthService: { getHealth: async () => ({ ok: false }) },
      notionActivity: { fetchNotionActivity: async () => null },
    },
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address();
  app.locals.runtime.setBoundPort(port);
  try {
    const apiPaths = [
      '/x/../api/health', '/x/../api/nope', '/x/../api/nope/', '/API/', '/API', '//api/health', '///api//health',
      '/api/../api/health', '/x/%2e%2e/api/health', '/x/%2E%2E/api/health', '/x/%2e%2e%2fapi/health', '/x/.%2e/api/health',
      '/x/%2e./api/nope', '/./api/health', '/%2e/api/health', '/api%2Fnope', '/api%2fhealth', '/%61pi%2Fnope',
      '/api/../index.html', '/api/../app.js', '/API/../app.js', '/public/../api/health', '/data/../api/health',
      '/%5Capi/health', '/x/..%5Capi/health', '/api/status', '/api/health', '/api/nope',
      `http://127.0.0.1:${port}/api/nope`,
    ];
    for (const method of ['GET', 'HEAD', 'OPTIONS', 'DELETE']) {
      for (const urlPath of apiPaths) {
        const response = await request(port, { method, urlPath, headers: { 'X-MC-Request': '1' } });
        const label = `${method} ${urlPath}`;
        assert.doesNotMatch(response.body, /SHADOW|SPA|GET, ?HEAD/, `${label} was answered by static/SPA/default OPTIONS`);
        assert.match(String(response.headers['content-type']), /application\/json/, `${label} must be JSON, got ${response.status} ${response.headers['content-type']}`);
        if (response.status !== 200) {
          assert.ok([404, 405].includes(response.status), `${label} -> ${response.status}`);
          if (method !== 'HEAD') assert.match(response.json?.error?.code || '', /^(not_found|method_not_allowed)$/, label);
        }
        if (method === 'OPTIONS') assert.notEqual(response.status, 200, `${label} must not be a default 200`);
      }
    }
    // The reviewer's reproductions, pinned exactly.
    const dotted = await request(port, { urlPath: '/x/../api/health' });
    assert.notEqual(dotted.body, 'SHADOW');
    const options = await request(port, { method: 'OPTIONS', urlPath: '/api%2Fnope' });
    assert.ok([404, 405].includes(options.status));
    assert.ok(options.json?.error?.code);

    for (const urlPath of ['/%E0%A4%A', '/api/%zz', '/assets/%', '/x/%', '/api/sessions/%E0%A4%A']) {
      for (const method of ['GET', 'HEAD', 'OPTIONS', 'POST']) {
        const response = await request(port, { method, urlPath, headers: { 'X-MC-Request': '1' } });
        assert.equal(response.status, 400, `${method} ${urlPath}`);
        assert.match(String(response.headers['content-type']), /application\/json/);
        if (method !== 'HEAD') assert.equal(response.json?.error?.code, 'bad_request', `${method} ${urlPath}`);
      }
    }

    for (const urlPath of ['/apix', '/apix/y', '/attention', '/x/../attention', '/x/%252e%252e/api/health', '/api-docs', '/apis']) {
      const response = await request(port, { urlPath });
      assert.equal(response.status, 200, urlPath);
      assert.match(response.body, /SPA/, `${urlPath} is not an API path and must get the SPA`);
    }
    assert.equal((await request(port, { urlPath: '/app.js' })).status, 200, 'ordinary static files still serve');
    assert.match((await request(port, { method: 'OPTIONS', urlPath: '/apix' })).body, /GET/, 'non-API OPTIONS is untouched');
  } finally {
    app.locals.runtime.dispose();
    await new Promise((resolve) => server.close(resolve));
  }
});

// --- final integration: one error contract on every route ------------------
// For every route in EXPECTED_ROUTES, a forced failure (a throwing source,
// service, scheduler, clock, unreadable archive or failing CLI) answers a
// non-200 status with { error: { code, message } } and no stack, path or
// secret text. The only route without a failing dependency is the static
// GBrain action catalog.
const LEAK = 'Bearer sk-SENTINEL1234567890 at /Users/someone/private/file.js:1:1';
function failingService(overrides = {}) {
  return new Proxy(overrides, {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (typeof prop === 'symbol' || prop === 'then' || prop === 'register' || prop === 'toJSON') return undefined;
      return () => { throw new Error(`${String(prop)} failed: ${LEAK}`); };
    },
  });
}
function throwingSource(id) {
  const fail = () => { throw new Error(`${id} snapshot failed: ${LEAK}`); };
  return { id, refresh: async () => {}, snapshot: fail, history: fail, status: () => ({ id }) };
}

const CONTRACT_SWEEP = [
  ['GET /api/loops', '/api/loops'], ['GET /api/loops/:project', '/api/loops/some-project'],
  ['GET /api/services', '/api/services'], ['GET /api/signals', '/api/signals'],
  ['GET /api/health', '/api/health'], ['GET /healthz', '/healthz', { clock: true }],
  ['GET /api/gbrain/overview', '/api/gbrain/overview'], ['GET /api/gbrain/health', '/api/gbrain/health'],
  ['GET /api/gbrain/sources', '/api/gbrain/sources'], ['GET /api/gbrain/version', '/api/gbrain/version'],
  ['GET /api/gbrain/integration-health', '/api/gbrain/integration-health'],
  ['POST /api/gbrain/actions', '/api/gbrain/actions', { body: { action: 'doctor-fast' } }],
  ['GET /api/gbrain/timeline', '/api/gbrain/timeline'], ['GET /api/gbrain/synoptic', '/api/gbrain/synoptic'],
  ['GET /api/gbrain/search', '/api/gbrain/search?q=x'], ['GET /api/gbrain/pages/:slug', '/api/gbrain/pages/projects'],
  ['GET /api/gbrain/graph', '/api/gbrain/graph?around=projects'],
  ['GET /api/hermes-kanban', '/api/hermes-kanban'], ['GET /api/operations/overview', '/api/operations/overview'],
  ['GET /api/status', '/api/status'], ['GET /api/cron', '/api/cron'],
  ['POST /api/cron/:id/toggle', '/api/cron/job-1/toggle', { body: { enabled: true } }],
  ['POST /api/cron/:id/run', '/api/cron/job-1/run', { body: {} }],
  ['POST /api/cron/create', '/api/cron/create', { body: { job: { name: 'n', schedule: { kind: 'every', everyMs: 60000 }, payload: { kind: 'agentTurn', message: 'hi' } } } }],
  ['DELETE /api/cron/:id', '/api/cron/job-1', { body: {} }],
  ['PATCH /api/cron/:id/model', '/api/cron/job-1/model', { body: { model: 'openai/gpt-5' } }],
  ['GET /api/calendar', '/api/calendar'], ['POST /api/calendar/sync-cron', '/api/calendar/sync-cron', { body: {} }],
  // runtime area: repair is covered by the same forced-failure contract
  ['POST /api/calendar/repair', '/api/calendar/repair', { body: {} }],
  // end runtime area: repair contract
  ['POST /api/calendar', '/api/calendar', { body: { title: 'x' } }], ['PATCH /api/calendar/:id', '/api/calendar/entry-1', { body: { title: 'x' } }],
  ['GET /cron-search', '/cron-search'], ['GET /api/aws/costs', '/api/aws/costs'], ['GET /api/models', '/api/models'],
  ['GET /api/costs', '/api/costs'], ['GET /api/costs/codexbar', '/api/costs/codexbar'], ['GET /api/costs/months', '/api/costs/months'],
  ['GET /api/usage/summary', '/api/usage/summary'], ['GET /api/sessions', '/api/sessions'],
  ['POST /api/settings/budget', '/api/settings/budget', { body: { monthly: 5 } }], ['GET /api/config', '/api/config'],
  ['GET /api/setup', '/api/setup'], ['POST /api/setup', '/api/setup', { body: { dashboardName: 'x' } }],
  ['GET /api/settings', '/api/settings'], ['GET /api/settings/model-routing', '/api/settings/model-routing'],
  ['POST /api/settings/model-routing', '/api/settings/model-routing', { body: { main: 'openai/gpt-5' } }],
  ['GET /api/settings/heartbeat', '/api/settings/heartbeat'], ['POST /api/settings/heartbeat', '/api/settings/heartbeat', { body: { interval: '30m' } }],
  ['GET /api/settings/export', '/api/settings/export'], ['POST /api/settings/import', '/api/settings/import', { body: {} }],
  ['GET /api/ollama/telemetry', '/api/ollama/telemetry'], ['GET /api/ollama/telemetry/history', '/api/ollama/telemetry/history'],
  ['GET /api/ollama/telemetry/models', '/api/ollama/telemetry/models'],
  ['GET /api/councils/summary', '/api/councils/summary'], ['GET /api/councils/decisions', '/api/councils/decisions'],
  ['GET /api/councils/governance/scorecard', '/api/councils/governance/scorecard'],
  ['GET /api/councils/decisions/:decisionId/timeline', '/api/councils/decisions/DEC-1/timeline'],
  ['POST /api/councils/decisions/:decisionId/action', '/api/councils/decisions/DEC-1/action', { body: { action: 'approve', note: 'x' } }],
  ['GET /^\\/(?!api(?:\\/|$)).*/', '/attention'],
];
const CONTRACT_EXEMPT = { 'GET /api/gbrain/actions': 'static allowlist catalog; it has no dependency that can fail' };

function sendJson(port, { method, urlPath, body }) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port, method, path: urlPath,
      headers: { Host: `127.0.0.1:${port}`, 'X-MC-Request': '1', ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}) },
    }, (res) => {
      let text = '';
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, headers: res.headers, json, body: text });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

test('boot smoke: contract sweep — every route answers the error contract on a forced failure', async () => {
  const sweepRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-boot-contract-'));
  for (const name of ['mc-config.json', 'package.json']) fs.copyFileSync(path.join(ROOT, name), path.join(sweepRoot, name));
  fs.mkdirSync(path.join(sweepRoot, 'data'), { recursive: true });
  fs.writeFileSync(path.join(sweepRoot, 'data', 'decision-log.json'), '{ not json');
  fs.writeFileSync(path.join(sweepRoot, 'data', 'ops-events.json'), '{ not json');
  const { createScheduler } = require('../server/core/scheduler');
  const { createSource } = require('../server/core/source');
  const scheduler = createScheduler({ logger: { log() {}, warn() {}, error() {} } });
  scheduler.status = () => { throw new Error(`scheduler status failed: ${LEAK}`); };
  let clockFails = false;
  const clock = { now: () => { if (clockFails) throw new Error(`clock failed: ${LEAK}`); return Date.now(); } };
  const sessionsSource = createSource({ id: 'openclaw.sessions', read: () => Promise.reject(new Error(LEAK)) });

  const app = createApp({
    config: loadConfig({ rootDir: sweepRoot, homeDir: HOME, env: { PORT: '0' } }),
    exec: createExec({ execFileImpl: fakeExecFile }),
    scheduler,
    clock,
    logger: { log() {}, warn() {}, error() {} },
    services: {
      gbrainOverviewService: failingService(),
      hermesKanbanService: failingService({ profile: 'test' }),
      hermesGatewayHealthService: failingService(),
      notionActivity: failingService(),
      usageService: failingService({ dispose() {}, ownedExec: null }),
      settingsService: failingService(),
      statusService: failingService(),
      cronService: failingService(),
      sessionsService: failingService({ visibleSessionsSource: sessionsSource }),
      operationsOverviewService: failingService(),
    },
    sources: Object.fromEntries(['automations', 'calendar', 'models', 'ollama', 'loops', 'launchd', 'reachability', 'awsCosts']
      .map((name) => [name, throwingSource(`sweep.${name}`)])),
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address();
  app.locals.runtime.setBoundPort(port);
  try {
    const swept = new Set(CONTRACT_SWEEP.map(([route]) => route));
    for (const route of EXPECTED_ROUTES) {
      assert.ok(swept.has(route) || route in CONTRACT_EXEMPT, `${route} has no forced-failure case in the contract sweep`);
    }
    for (const [route, urlPath, options = {}] of CONTRACT_SWEEP) {
      const method = route.split(' ')[0];
      clockFails = Boolean(options.clock);
      let response;
      try {
        response = await sendJson(port, { method, urlPath, body: options.body });
      } finally {
        clockFails = false;
      }
      const label = `${route} (${urlPath}) -> ${response.status} ${response.body.slice(0, 200)}`;
      assert.ok(response.status >= 400 && response.status <= 599, label);
      assert.match(String(response.headers['content-type']), /application\/json/, label);
      assert.equal(typeof response.json?.error, 'object', label);
      assert.match(response.json.error.code, /^[a-z][a-z0-9_]{1,63}$/, label);
      assert.equal(typeof response.json.error.message, 'string', label);
      assert.ok(response.json.error.message.length > 0, label);
      assert.doesNotMatch(response.body, /SENTINEL|Bearer |\/Users\/|\/private\/|\/var\/folders|\bat \S+:\d+:\d+|stack/i, label);
      assert.equal(response.body.includes(sweepRoot), false, label);
      assert.equal(response.body.includes(HOME), false, label);
    }
    const catalog = await sendJson(port, { method: 'GET', urlPath: '/api/gbrain/actions' });
    assert.equal(catalog.status, 200);
    assert.equal(fs.readFileSync(path.join(sweepRoot, 'data', 'decision-log.json'), 'utf8'), '{ not json', 'an unreadable archive is never overwritten');
  } finally {
    app.locals.runtime.dispose();
    await new Promise((resolve) => server.close(resolve));
  }
});
