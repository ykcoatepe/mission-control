const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  attachOperationsSource,
  createFetchSessions,
  createSessionsService,
} = require('../server/services/sessionsData');
const { createStatusService } = require('../server/services/statusData');
const { createOpenclawStatusSource } = require('../server/sources/openclaw/status');
const { createExec } = require('../server/core/exec');
const { createOpenclawExec } = require('../server/services/openclawClient');

const quiet = { log() {}, warn() {}, error() {} };
const settle = () => new Promise((resolve) => setImmediate(resolve));

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function ok(sessions) {
  return attachOperationsSource({ count: sessions.length, sessions }, {
    sourceSucceeded: true, provenance: 'openclaw-sessions-cli', observedAt: new Date().toISOString(),
  });
}

function failed() {
  return attachOperationsSource({ count: 0, sessions: [] }, {
    sourceSucceeded: false, provenance: 'openclaw-sessions-unavailable', observedAt: null,
  });
}

function makeSessions(fetchSessions, extra = {}) {
  const dir = tempDir('mc-sessions-');
  return createSessionsService({
    fetchSessions,
    hiddenSessionsPath: path.join(dir, 'hidden-sessions.json'),
    openclawConfigPath: path.join(dir, 'openclaw.json'),
    homeDir: dir,
    gatewayPort: 1,
    gatewayToken: '',
    ...extra,
  });
}

test('counter-example: a failed sessions read is never served as an authoritative empty list', async () => {
  let mode = 'ok';
  let t = Date.parse('2026-11-11T10:00:00Z');
  const recent = new Date(t - 60_000).toISOString();
  const service = makeSessions(async () => (mode === 'ok' ? ok([{ key: 'agent:main:main', updatedAt: recent }]) : failed()), {
    now: () => t,
  });

  await service.listVisibleSessions(25);
  await settle();
  let list = await service.listVisibleSessions(25);
  assert.equal(list.count, 1);
  assert.equal(list.meta.ok, true);

  mode = 'fail';
  t += 31_000; // past the 30 s TTL: the next read refreshes
  await service.listVisibleSessions(25);
  await settle();
  await settle();
  list = await service.listVisibleSessions(25);
  assert.equal(list.count, 1, 'last-good sessions survive the failed read');
  assert.equal(list.sessions[0].key, 'agent:main:main');
  assert.equal(list.meta.ok, false);
  assert.equal(list.meta.stale, true);
  assert.equal(list.meta.error.code, 'openclaw-sessions-unavailable');
});

test('with no good read yet, the file fallback is served and labelled as not ok', async () => {
  const service = makeSessions(async () => failed());
  await service.listVisibleSessions(25);
  await settle();
  const list = await service.listVisibleSessions(25);
  assert.deepEqual(list.sessions, []);
  assert.equal(list.meta.ok, false);
  assert.equal(list.meta.source, 'openclaw.sessions.file-fallback');
});

test('a hidden session disappears from the held list immediately', async () => {
  const service = makeSessions(async () => ok([{ key: 'a' }, { key: 'b' }]));
  await service.visibleSessionsSource.refresh();
  service.hideSession('a');
  const list = await service.listVisibleSessions(25);
  assert.deepEqual(list.sessions.map((s) => s.key), ['b']);
});

test('fetchSessions reports provenance; failure falls through to the gateway', async () => {
  const fetchSessions = createFetchSessions({
    openclawExec: async () => { throw Object.assign(new Error('state undergoing offline maintenance'), { stdout: '' }); },
    fetchImpl: async () => { throw new Error('ECONNREFUSED'); },
    gatewayPort: 1,
    gatewayToken: '',
    logger: quiet,
  });
  const service = makeSessions(fetchSessions);
  const snap = await service.visibleSessionsSource.refresh();
  assert.equal(snap.data, null);
  assert.equal(snap.meta.ok, false);
});

test('status and heartbeat CLI calls run serialized on the openclaw lane, never through execSync', async () => {
  let running = 0;
  let maxRunning = 0;
  const seen = [];
  const execFileImpl = (file, args, options, callback) => {
    running += 1;
    maxRunning = Math.max(maxRunning, running);
    seen.push(args.join(' '));
    const out = args[0] === 'status'
      ? 'Agents │ 3\nHeartbeat │ 30m\n'
      : args[0] === 'sessions'
        ? JSON.stringify({ sessions: [] })
        : JSON.stringify({ ts: Date.now() - 1000, status: 'sent' });
    setTimeout(() => {
      running -= 1;
      callback(null, out, '');
    }, 5);
    return { pid: 1, kill() {} };
  };
  const exec = createExec({ execFileImpl });
  const openclawExec = createOpenclawExec({ runner: exec, bin: 'openclaw', configPath: '/dev/null' });
  const { createOpenclawCli } = require('../server/services/openclawClient');
  const openclawCli = createOpenclawCli({ runner: exec, bin: 'openclaw', configPath: '/dev/null' });
  const fetchSessions = createFetchSessions({ openclawExec, fetchImpl: async () => { throw new Error('no network'); }, gatewayPort: 1, gatewayToken: '', logger: quiet });
  const memoryPath = tempDir('mc-status-');
  const writes = [];
  const originalFetch = global.fetch;
  global.fetch = async () => { throw new Error('no network'); };
  try {
    const statusService = createStatusService({
      mcConfig: { name: 'MC' },
      memoryPath,
      prettyModelName: (m) => m || '—',
      getOpenclawDefaultModelKey: () => '',
      fetchNotionActivity: async () => null,
      fetchSessions,
      readRuntimeSnapshot: () => null,
      writeRuntimeSnapshot: (name, value) => writes.push(name),
      runtimeSnapshotTtl: { status: 60_000 },
      gatewayPort: 1,
      openclawCli,
      fs,
      path,
      processEnv: { HOME: memoryPath },
      refreshOnRead: false,
      sessionRefreshBudgetMs: 5_000,
    });
    const source = createOpenclawStatusSource({ statusService });
    const snap = await source.refresh();
    assert.equal(snap.meta.ok, true);
    assert.equal(snap.data.agent.totalAgents, 3);
    assert.equal(snap.data.agent.heartbeatInterval, '30m');
    assert.ok(snap.data.heartbeat.lastHeartbeat > 0);
    assert.equal(maxRunning, 1, 'counter-example: OpenClaw CLI calls overlapped');
    assert.deepEqual(seen.sort(), ['sessions --json --all-agents', 'status', 'system heartbeat last --json'].sort());

    // GET path is pure and does not start a refresh.
    const before = seen.length;
    const writesBefore = writes.length;
    await statusService.getStatusResponse();
    await statusService.getOperationsStatusResponse();
    await settle();
    assert.equal(seen.length, before, 'a read started a CLI call');
    assert.equal(writes.length, writesBefore, 'a read wrote the snapshot');
  } finally {
    global.fetch = originalFetch;
  }
  const source = fs.readFileSync(path.join(__dirname, '..', 'server', 'services', 'statusData.js'), 'utf8');
  assert.doesNotMatch(source, /execSync|spawnSync/);
});

test('status source keeps the last observed status when the CLI later fails', async () => {
  let cliOk = true;
  const memoryPath = tempDir('mc-status-');
  const originalFetch = global.fetch;
  global.fetch = async () => { throw new Error('no network'); };
  try {
    const statusService = createStatusService({
      mcConfig: { name: 'MC' },
      memoryPath,
      prettyModelName: (m) => m || '—',
      getOpenclawDefaultModelKey: () => '',
      fetchNotionActivity: async () => null,
      fetchSessions: async () => ({ count: 0, sessions: [] }),
      readRuntimeSnapshot: () => null,
      writeRuntimeSnapshot: () => {},
      runtimeSnapshotTtl: { status: 60_000 },
      gatewayPort: 1,
      openclawCli: async (args) => (args[0] === 'status' && cliOk
        ? { ok: true, stdout: 'Agents │ 9\n', stderr: '' }
        : { ok: false, code: 1, stdout: '', stderr: 'offline maintenance' }),
      fs,
      path,
      processEnv: { HOME: memoryPath },
      refreshOnRead: false,
    });
    const source = createOpenclawStatusSource({ statusService });
    await source.refresh();
    cliOk = false;
    const snap = await source.refresh();
    assert.equal(snap.data.agent.totalAgents, 9, 'last observed value, not the parser default');
    assert.equal(snap.meta.ok, false);
    assert.equal(snap.meta.stale, true);
    assert.equal(snap.meta.error.code, 'openclaw_status_unavailable');
  } finally {
    global.fetch = originalFetch;
  }
});
