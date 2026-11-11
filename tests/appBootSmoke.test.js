// Boot smoke test: build the whole app through createApp on port 0 with
// injected fakes. No real CLI, no network, no writes outside temp dirs.
//
// Asserts: the mounted route table, the JSON 404 contract, /api/health, and
// that a representative set of GET routes never writes to disk.
//
// Known GET writers left for their area units (not in the sweep below):
//   GET /api/cron                         runtime snapshot data/runtime/cron.json
//   GET /api/calendar                     calendar sync writes calendar-entries.json
//   GET /api/tasks, /api/tasks/board      task reconcile rewrites tasks.json
//   GET /api/councils/summary, /governance/scorecard   runtime snapshots
//   GET /api/gbrain/timeline              timeline ledger
// Routes that spawn their own CLIs (costs, ollama, gbrain probes, hermes
// kanban, agents roster) are also outside this sweep.

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
fs.mkdirSync(path.join(ROOT, 'docs'));
fs.writeFileSync(path.join(ROOT, 'docs', 'readme.md'), '# test doc\n');

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
  'GET /api/hermes-kanban', 'GET /api/hermes-kanban/tasks/:taskId', 'POST /api/hermes-kanban/actions',
  'POST /api/chat',
  'GET /api/operations/overview',
  'GET /api/status',
  'GET /api/cron', 'POST /api/cron/:id/toggle', 'POST /api/cron/:id/run', 'POST /api/cron/create', 'DELETE /api/cron/:id',
  'PATCH /api/cron/:id/model',
  'GET /api/calendar', 'POST /api/calendar/sync-cron', 'POST /api/calendar', 'PATCH /api/calendar/:id',
  'GET /api/activity', 'GET /api/tasks', 'GET /api/tasks/board', 'GET /api/tasks/:taskId', 'POST /api/tasks', 'POST /api/tasks/add',
  'POST /api/tasks/assistant', 'PATCH /api/tasks/:taskId', 'DELETE /api/tasks/:taskId', 'POST /api/tasks/:taskId/execute',
  'GET /api/scout', 'POST /api/scout/deploy', 'POST /api/scout/dismiss', 'POST /api/scout/scan', 'GET /api/scout/status',
  'GET /api/agents', 'POST /api/agents/create', 'GET /api/team/structure', 'POST /api/team/structure/bootstrap',
  'GET /api/office/telemetry', 'POST /api/agents/:agentId/model',
  'GET /api/skills', 'POST /api/skills/:name/toggle', 'POST /api/skills/:name/install', 'POST /api/skills/:name/uninstall',
  'GET /api/aws/services', 'GET /api/aws/bedrock-models', 'POST /api/aws/generate-image', 'GET /api/aws/image/:id',
  'GET /api/aws/gallery', 'GET /^\\/api\\/aws\\/s3-image\\/(.+)$/', 'GET /api/aws/costs',
  'GET /api/models', 'GET /api/model', 'POST /api/model',
  'GET /api/costs', 'GET /api/costs/codexbar', 'GET /api/costs/months',
  'GET /api/sessions', 'GET /api/sessions/:sessionKey/history', 'POST /api/sessions/:sessionKey/send', 'DELETE /api/sessions/:key/close',
  'POST /api/settings/budget', 'GET /api/config', 'GET /api/setup', 'POST /api/setup', 'GET /api/settings',
  'GET /api/settings/model-routing', 'POST /api/settings/model-routing', 'GET /api/settings/heartbeat', 'POST /api/settings/heartbeat',
  'GET /api/settings/export', 'POST /api/settings/import',
  'GET /api/docs', 'POST /api/docs/upload', 'GET /cron-search',
  'GET /api/memory',
  'POST /api/heartbeat/run', 'POST /api/quick/emails', 'POST /api/quick/schedule',
  'GET /api/ollama/telemetry', 'GET /api/ollama/telemetry/history', 'GET /api/ollama/telemetry/models', 'POST /api/ollama/optimization',
  'GET /api/councils/summary', 'GET /api/councils/decisions', 'GET /api/councils/agents', 'GET /api/councils/governance/scorecard',
  'GET /api/councils/decisions/:decisionId/timeline', 'POST /api/councils/decisions/:decisionId/action',
  'GET /api/ops/events', 'POST /api/ops/openclaw/self-heal',
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
  '/api/memory',
  '/api/docs',
  '/api/ops/events',
  '/api/models',
  '/api/skills',
  '/api/gbrain/actions',
  '/api/nope',
];

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
    // directories (docs and settings import), as before.
    const afterBoot = { root: treeState(ROOT), home: treeState(HOME) };
    const bootCreated = Object.keys(afterBoot.root).filter((key) => !(key in before.root)).map((key) => path.relative(ROOT, key));
    assert.deepEqual(bootCreated.sort(), ['documents', 'documents/.tmp', 'documents/.tmp-settings']);
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
    assert.ok(execCalls.every((call) => call.file === config.openclawBin), 'only OpenClaw went through the runner in this sweep');
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
    assert.deepEqual(health.scheduler.jobs.map((job) => job.id), ['openclaw.status']);
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
    const evil = await request(port, { method: 'POST', urlPath: '/api/quick/emails', headers: { Origin: `http://localhost:${port}.evil.com` } });
    assert.equal(evil.status, 403);
    assert.equal(evil.json.error.code, 'forbidden_origin');

    const reported = await request(port, { method: 'POST', urlPath: '/api/quick/emails', headers: { Origin: `http://localhost:${port}` } });
    assert.equal(reported.status, 200, 'report-only mode keeps the current frontend working');

    const badHost = await request(port, { urlPath: '/api/health', headers: { Host: 'evil.com' } });
    assert.equal(badHost.status, 403);

    await new Promise((resolve) => setTimeout(resolve, 20));
    const entries = app.locals.runtime.auditLog.readEntries().filter((e) => e.path === '/api/quick/emails');
    assert.deepEqual(entries.map((e) => [e.method, e.path, e.status, e.writeHeader]), [
      ['POST', '/api/quick/emails', 403, false],
      ['POST', '/api/quick/emails', 200, false],
    ]);
    assert.equal(app.locals.runtime.guard.status().counters.writeReported, 1);
  } finally {
    app.locals.runtime.dispose();
    await new Promise((resolve) => server.close(resolve));
  }
});
