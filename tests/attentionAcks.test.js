'use strict';

// Badge rule (alarm management): acknowledge / shelve, through the app
// factory. A badge counts only NEW items: not acknowledged, not shelved, not
// restricted. An acknowledgement is void when the item gets worse (severity
// or count rises); a shelve holds until `until` passes or the item becomes
// critical. Restricted items are never counted and never ackable. The store
// is a 0600 JSON file in the data directory, written atomically; GET never
// writes. Fake exec, fake overview, fake automations; no real CLI.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const { createApp } = require('../server/app');
const { loadConfig } = require('../server/core/config');
const { createMloopSource } = require('../server/sources/mloop');
const { withLiveLoop } = require('./helpers/liveLoop');

const T0 = Date.parse('2026-11-12T10:00:00Z');
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const SECRET = 'ARGUS-SECRET';
const silent = { log() {}, warn() {}, error() {}, info() {} };

function ok(body) {
  return { ok: true, code: 0, stdout: JSON.stringify(body), stderr: '', timedOut: false };
}

const okMeta = (source) => ({ ok: true, stale: false, observedAt: new Date(T0).toISOString(), ageMs: 0, error: null, latencyMs: 1, source });
const emptySource = (id) => ({
  id, refresh: async () => {}, status: () => ({ id }),
  snapshot: () => ({ data: null, meta: { ok: false, stale: true, observedAt: null, ageMs: null, error: null, latencyMs: null, source: id } }),
});

function system(id, state) {
  return { id, state, observedAt: new Date(T0).toISOString(), caveats: [], detailHref: '/services' };
}

function cronJob(id, { enabled = true, status = 'ok' } = {}) {
  return {
    id: `openclaw:${id}`, sourceId: id, name: `Job ${id}`, scheduler: 'openclaw', schedulerLabel: 'OpenClaw',
    status, enabled, lastRun: new Date(T0 - HOUR).toISOString(), nextRun: new Date(T0 + HOUR).toISOString(), history: [],
  };
}

function fixture({ storeContent } = {}) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-acks-'));
  fs.writeFileSync(path.join(rootDir, 'mc-config.json'), JSON.stringify({ name: 'Acks Test', gateway: { port: 1, token: '' }, modules: {} }));
  fs.writeFileSync(path.join(rootDir, 'package.json'), '{"version":"test"}');
  const storeFile = path.join(rootDir, 'data', 'attention', 'acks.json');
  if (storeContent !== undefined) {
    fs.mkdirSync(path.dirname(storeFile), { recursive: true });
    fs.writeFileSync(storeFile, storeContent);
  }
  const clock = { ms: T0 };
  const now = () => clock.ms;
  const state = {
    systems: { gbrain: system('gbrain', 'healthy'), hermes: system('hermes', 'healthy'), openclaw: system('openclaw', 'healthy') },
    checkRows: [],
    teyit: [],
    cron: [],
  };
  const overview = {
    async getOverview() {
      return {
        systems: structuredClone(state.systems), attention: [], evidence: [],
        meta: { ok: true, stale: false, observedAt: new Date(T0).toISOString(), ageMs: 0, error: null, latencyMs: null, source: 'operations.overview' },
      };
    },
  };
  const exec = {
    async run(file, args) {
      if (args[0] === 'check') return ok(state.checkRows);
      const [, project, , command] = args;
      if (command === 'status') return ok(`# ${project}\nOutcome: keep going\n`);
      if (command === 'teyit') return ok(state.teyit.filter((row) => row.project === project));
      if (command === 'participants') return ok([]);
      return { ok: false, code: 1, stdout: '', stderr: '', timedOut: false };
    },
    killAll() {},
    drain: async () => true,
    status: () => ({ lanes: {}, children: 0, quarantined: [] }),
  };
  const fsImpl = {
    async readdir() { return [...new Set(state.checkRows.map((row) => row.project))].map((name) => ({ name, isDirectory: () => true })); },
    async stat() { return { isFile: () => true, mtimeMs: T0 }; },
  };
  const loops = createMloopSource({ exec, fsImpl, ledgerDir: '/fake', bin: '/fake/mloop', now });
  const automations = {
    id: 'openclaw.automations',
    refresh: async () => {},
    status: () => ({ id: 'openclaw.automations' }),
    snapshot: () => {
      const jobs = structuredClone(state.cron);
      const failed = jobs.filter((job) => job.enabled && job.status === 'failed').length;
      return {
        data: { cron: { jobs, summary: { active: jobs.filter((job) => job.enabled).length, paused: 0, failed, nextRunAt: new Date(T0 + HOUR).toISOString() }, schedulers: { openclaw: { sourceSucceeded: true } } } },
        meta: okMeta('openclaw.automations'),
      };
    },
  };
  const app = createApp({
    config: loadConfig({ rootDir, homeDir: rootDir, env: { PORT: '0' } }),
    exec,
    clock: { now },
    fetch: async () => { throw new Error('No network'); },
    logger: silent,
    scheduler: { register() {}, start() {}, stop() {}, status: () => ({ jobs: [] }) },
    services: {
      operationsOverviewService: overview,
      usageService: { summary: () => ({ data: null, meta: {} }), dispose() {} },
    },
    sources: {
      loops, automations,
      launchd: emptySource('launchd.services'), reachability: emptySource('services.reachability'),
      calendar: emptySource('openclaw.calendar'), models: emptySource('openclaw.models'),
      ollama: emptySource('ollama.telemetry'), awsCosts: emptySource('aws.costs'),
    },
  });
  let server;
  let port;
  async function start() {
    await loops.refresh();
    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    port = server.address().port;
    app.locals.runtime.setBoundPort(port);
  }
  function request(method, url, body) {
    const text = body === undefined ? '' : JSON.stringify(body);
    return new Promise((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1', port, path: url, method,
        headers: { 'X-MC-Request': '1', 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) },
      }, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(data); } catch {}
          resolve({ status: res.statusCode, body: json, text: data });
        });
      });
      req.on('error', reject);
      req.end(text);
    });
  }
  const get = async (url) => {
    const response = await request('GET', url);
    assert.equal(response.status, 200, `${url} -> ${response.status} ${response.text.slice(0, 300)}`);
    return response.body;
  };
  return {
    rootDir, storeFile, clock, state, loops, request, get, start,
    async signals() { return (await get('/api/signals')).data; },
    async loopsData() { return (await get('/api/loops')).data; },
    async cron() { return get('/api/cron'); },
    async both() {
      const signals = (await get('/api/signals')).data;
      const loopsData = (await get('/api/loops')).data;
      assert.deepEqual(loopsData.totals.needsOperator, signals.attention, '/api/signals and /api/loops agree');
      return { signals, loops: loopsData };
    },
    ack(key, kind = 'ack', until) {
      return request('POST', '/api/attention/acks', { key, kind, ...(until !== undefined ? { until } : {}) });
    },
    async cleanup() {
      app.locals.runtime.dispose();
      if (server) {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
      }
      fs.rmSync(rootDir, { recursive: true, force: true });
    },
  };
}

const run = (options, fn) => withLiveLoop(async () => {
  const f = fixture(options);
  try {
    await f.start();
    await fn(f);
  } finally {
    await f.cleanup();
  }
});

const finding = (project, code, subject, severity = 'warning', extra = {}) => ({
  project, code, subject, severity, detail: `${code} ${subject}`, ts: '2026-11-11T00:00:00Z', ...extra,
});
const attentionRow = (loops, code) => loops.attention.find((item) => item.code === code);
const storeKeys = (f) => JSON.parse(fs.readFileSync(f.storeFile, 'utf8')).acks.map((entry) => entry.key).sort();

test('ack removes an item from the count and adds it to standing; unack brings it back', () => run({}, async (f) => {
  f.state.systems.hermes = system('hermes', 'warning');
  f.state.checkRows = [finding('alpha', 'BINDING_DEAD', 'w1')];
  await f.loops.refresh();
  let { signals, loops } = await f.both();
  assert.equal(signals.attention.count, 2);
  assert.equal(signals.attention.standing, 0);
  const row = attentionRow(loops, 'BINDING_DEAD');
  assert.match(row.key, /^finding:alpha:BINDING_DEAD:/);
  assert.equal(row.ackable, true);
  assert.equal(row.ack, null);

  const posted = await f.ack(row.key);
  assert.equal(posted.status, 200, posted.text);
  assert.equal(posted.body.ack.kind, 'ack');
  assert.equal(posted.body.ack.until, null);
  assert.equal(posted.body.ack.at, new Date(T0).toISOString());

  ({ signals, loops } = await f.both());
  assert.equal(signals.attention.count, 1, 'read-your-writes: the acknowledged finding leaves the count at once');
  assert.equal(signals.attention.standing, 1);
  assert.equal(signals.attention.worst, 'warning');
  assert.deepEqual(signals.attention.breakdown.findings, 0);
  assert.deepEqual(attentionRow(loops, 'BINDING_DEAD').ack, posted.body.ack);

  const hermes = loops.systems.find((entry) => entry.id === 'hermes');
  assert.equal(hermes.key, 'system:hermes');
  assert.equal(hermes.ackable, true);
  assert.equal((await f.ack('system:hermes', 'shelve', null)).status, 200);
  ({ signals } = await f.both());
  assert.equal(signals.attention.count, 0);
  assert.equal(signals.attention.worst, 'healthy', 'no new items: worst is healthy');
  assert.equal(signals.attention.standing, 2);

  const removed = await f.request('DELETE', `/api/attention/acks/${encodeURIComponent(row.key)}`);
  assert.equal(removed.status, 200, removed.text);
  ({ signals } = await f.both());
  assert.equal(signals.attention.count, 1);
  assert.equal(signals.attention.standing, 1);
  assert.equal((fs.statSync(f.storeFile).mode & 0o777), 0o600, 'the store file is 0600');
}));

test('a severity rise voids an acknowledgement, and it stays void when the severity falls back', () => run({}, async (f) => {
  f.state.systems.hermes = system('hermes', 'warning');
  assert.equal((await f.ack('system:hermes')).status, 200);
  assert.equal((await f.both()).signals.attention.count, 0);

  f.state.systems.hermes = system('hermes', 'critical');
  let { signals, loops } = await f.both();
  assert.equal(signals.attention.count, 1, 'worse than acknowledged: counts again');
  assert.equal(signals.attention.worst, 'critical');
  assert.equal(signals.attention.standing, 0);
  assert.equal(loops.systems.find((entry) => entry.id === 'hermes').ack, null);

  f.state.systems.hermes = system('hermes', 'warning');
  ({ signals } = await f.both());
  assert.equal(signals.attention.count, 1, 'a voided acknowledgement does not come back');
}));

test('a count rise voids an acknowledgement', () => run({}, async (f) => {
  f.state.checkRows = [finding('alpha', 'BINDING_DEAD', 'BINDING_DEAD', 'warning', { count: 3 })];
  await f.loops.refresh();
  const { loops } = await f.both();
  const key = attentionRow(loops, 'BINDING_DEAD').key;
  assert.equal((await f.ack(key)).status, 200);
  assert.equal((await f.both()).signals.attention.count, 0);

  f.state.checkRows = [finding('alpha', 'BINDING_DEAD', 'BINDING_DEAD', 'warning', { count: 3 })];
  await f.loops.refresh();
  assert.equal((await f.both()).signals.attention.count, 0, 'the same count stays acknowledged');

  f.state.checkRows = [finding('alpha', 'BINDING_DEAD', 'BINDING_DEAD', 'warning', { count: 5 })];
  await f.loops.refresh();
  const { signals } = await f.both();
  assert.equal(signals.attention.count, 1);
  assert.equal(signals.attention.standing, 0);
}));

test('an overdue confirmation can be acknowledged; more overdue confirmations count as new', () => run({}, async (f) => {
  f.state.checkRows = [finding('alpha', 'TEYIT_DUE', 'T1', 'info')];
  f.state.teyit = [{ project: 'alpha', id: 'T1', unit: 'u', how: 'h', deadline: '2026-11-10T00:00:00Z', state: 'open', closed: false }];
  await f.loops.refresh();
  let { signals, loops } = await f.both();
  assert.equal(signals.attention.breakdown.overdueConfirmations, 1);
  const pending = loops.projects.find((project) => project.id === 'alpha').pendingConfirmations[0];
  assert.equal(pending.key, 'confirmation:alpha:T1');
  assert.equal(pending.ackable, true);
  assert.equal(attentionRow(loops, 'TEYIT_DUE').key, 'confirmation:alpha:T1', 'a finding about T1 shares its key');
  assert.equal((await f.ack(pending.key)).status, 200);
  ({ signals } = await f.both());
  assert.equal(signals.attention.count, 0);
  assert.equal(signals.attention.standing, 1);

  f.state.teyit.push({ project: 'alpha', id: 'T2', unit: 'u', how: 'h', deadline: '2026-11-09T00:00:00Z', state: 'open', closed: false });
  await f.loops.refresh();
  ({ signals } = await f.both());
  assert.equal(signals.attention.count, 1, 'T2 is new');
  assert.equal(signals.attention.standing, 1);
}));

test('a shelve holds until `until` passes, then the item counts again', () => run({}, async (f) => {
  f.state.systems.openclaw = system('openclaw', 'warning');
  const until = new Date(T0 + 2 * HOUR).toISOString();
  const posted = await f.ack('system:openclaw', 'shelve', until);
  assert.equal(posted.status, 200, posted.text);
  assert.deepEqual(posted.body.ack, { kind: 'shelve', at: new Date(T0).toISOString(), until });
  assert.equal((await f.both()).signals.attention.count, 0);

  f.clock.ms = T0 + 3 * HOUR;
  const { signals, loops } = await f.both();
  assert.equal(signals.attention.count, 1, 'the shelve expired');
  assert.equal(signals.attention.standing, 0);
  assert.equal(loops.systems.find((entry) => entry.id === 'openclaw').ack, null);

  const past = await f.ack('system:openclaw', 'shelve', new Date(T0).toISOString());
  assert.equal(past.status, 400, 'until must be in the future');
  assert.equal(past.body.error.code, 'invalid_until');
}));

test('a shelved item that becomes critical counts again', () => run({}, async (f) => {
  f.state.checkRows = [finding('alpha', 'ESCALATED_ROUNDS', 'P1', 'warning')];
  await f.loops.refresh();
  const key = attentionRow(await f.loopsData(), 'ESCALATED_ROUNDS').key;
  assert.equal((await f.ack(key, 'shelve', null)).status, 200);
  assert.equal((await f.both()).signals.attention.count, 0);

  f.state.checkRows = [finding('alpha', 'ESCALATED_ROUNDS', 'P1', 'error')];
  await f.loops.refresh();
  const { signals } = await f.both();
  assert.equal(signals.attention.count, 1);
  assert.equal(signals.attention.worst, 'critical');
  assert.equal(signals.attention.standing, 0);
}));

test('restricted items are never counted, never keyed and never ackable', () => run({}, async (f) => {
  f.state.checkRows = [
    finding('argus-live', 'BINDING_DEAD', `${SECRET}-b`, 'warning', { detail: SECRET }),
    finding('argus-live', 'TEYIT_STALE', `${SECRET}-a`, 'error', { detail: SECRET, count: 3 }),
    finding('alpha', 'BINDING_DEAD', 'w1'),
  ];
  await f.loops.refresh();
  const { signals, loops } = await f.both();
  assert.equal(signals.attention.restricted, 4, 'restricted by count: 1 finding + 3 overdue');
  assert.equal(signals.attention.count, 1, 'only alpha counts');
  assert.equal(signals.attention.worst, 'warning', 'a restricted error does not colour the badge');
  const restrictedRow = loops.attention.find((item) => item.restricted);
  assert.equal(restrictedRow.key, null);
  assert.equal(restrictedRow.ackable, false);
  assert.equal(restrictedRow.ack, null);
  const guesses = [
    'finding:argus-live:BINDING_DEAD:000000000000',
    'confirmation:argus-live:TEYIT_STALE',
    'confirmation:argus-live:#0',
  ];
  for (const key of guesses) {
    const response = await f.ack(key);
    assert.ok([400, 404].includes(response.status), `${key} -> ${response.status}`);
    assert.doesNotMatch(response.text, new RegExp(SECRET));
  }
  const cron = await f.cron();
  assert.doesNotMatch(JSON.stringify(signals) + JSON.stringify(loops) + JSON.stringify(cron), new RegExp(SECRET));
}));

test('a corrupt store file is kept as a .corrupt copy and the app starts empty', () => run({ storeContent: '{ not json' }, async (f) => {
  f.state.systems.hermes = system('hermes', 'warning');
  const { signals } = await f.both();
  assert.equal(signals.attention.count, 1);
  assert.equal(fs.readFileSync(f.storeFile, 'utf8'), '{ not json', 'a GET never touches the store');
  assert.equal((await f.ack('system:hermes')).status, 200);
  const dir = path.dirname(f.storeFile);
  const copies = fs.readdirSync(dir).filter((name) => name.startsWith('acks.json.corrupt'));
  assert.equal(copies.length, 1);
  assert.equal(fs.readFileSync(path.join(dir, copies[0]), 'utf8'), '{ not json', 'the unreadable content is kept');
  assert.deepEqual(storeKeys(f), ['system:hermes']);
  assert.equal((await f.both()).signals.attention.count, 0);
  assert.deepEqual(fs.readdirSync(dir).filter((name) => name.includes('.tmp')), [], 'no temp file left behind');
}));

test('concurrent POSTs do not lose an entry', () => run({}, async (f) => {
  f.state.systems = { gbrain: system('gbrain', 'warning'), hermes: system('hermes', 'warning'), openclaw: system('openclaw', 'critical') };
  const responses = await Promise.all(['system:gbrain', 'system:hermes', 'system:openclaw'].map((key) => f.ack(key)));
  assert.deepEqual(responses.map((response) => response.status), [200, 200, 200]);
  assert.deepEqual(storeKeys(f), ['system:gbrain', 'system:hermes', 'system:openclaw']);
  const { signals } = await f.both();
  assert.equal(signals.attention.count, 0);
  assert.equal(signals.attention.standing, 3);
}));

test('invalid and unknown keys: 400 for a bad shape or body, 404 for an unknown item, 409 for one that is not ackable', () => run({}, async (f) => {
  f.state.systems.hermes = system('hermes', 'warning');
  f.state.checkRows = [finding('alpha', 'TEYIT_DUE', 'T9', 'info')];
  await f.loops.refresh();
  const cases = [
    [{ key: 'nope', kind: 'ack' }, 400, 'invalid_key'],
    [{ key: `system:${'x'.repeat(400)}`, kind: 'ack' }, 400, 'invalid_key'],
    [{ key: 42, kind: 'ack' }, 400, 'invalid_key'],
    [{ key: 'system:hermes', kind: 'mute' }, 400, 'invalid_kind'],
    [{ key: 'system:hermes', kind: 'shelve', until: 'tomorrow' }, 400, 'invalid_until'],
    [{ key: 'system:hermes', kind: 'ack', until: new Date(T0 + DAY).toISOString() }, 400, 'invalid_until'],
    [{ key: 'system:nosuch', kind: 'ack' }, 404, 'ack_key_not_found'],
    [{ key: 'cron:openclaw:ghost', kind: 'ack' }, 404, 'ack_key_not_found'],
    [{ key: 'system:gbrain', kind: 'ack' }, 409, 'not_ackable'],
    [{ key: 'confirmation:alpha:T9', kind: 'ack' }, 409, 'not_ackable'],
  ];
  for (const [body, status, code] of cases) {
    const response = await f.request('POST', '/api/attention/acks', body);
    assert.equal(response.status, status, `${JSON.stringify(body).slice(0, 80)} -> ${response.text}`);
    assert.equal(response.body.error.code, code);
    assert.equal(typeof response.body.error.message, 'string');
  }
  const badDelete = await f.request('DELETE', '/api/attention/acks/nope');
  assert.equal(badDelete.status, 400);
  assert.equal(badDelete.body.error.code, 'invalid_key');
  const missing = await f.request('DELETE', '/api/attention/acks/system%3Ahermes');
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error.code, 'ack_not_found');
  assert.equal(fs.existsSync(f.storeFile), false, 'no rejected request wrote the store');
}));

function treeState(dir) {
  const out = {};
  const walk = (current) => {
    let entries = [];
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else {
        const stat = fs.statSync(full);
        out[path.relative(dir, full)] = `${stat.mtimeMs}:${stat.size}:${fs.readFileSync(full, 'utf8')}`;
      }
    }
  };
  walk(dir);
  return out;
}

test('GET never writes, not even when it voids an acknowledgement', () => run({}, async (f) => {
  f.state.systems.hermes = system('hermes', 'warning');
  f.state.cron = [cronJob('j1', { status: 'failed' })];
  assert.equal((await f.ack('system:hermes')).status, 200);
  assert.equal((await f.ack('cron:openclaw:j1')).status, 200);
  f.state.systems.hermes = system('hermes', 'critical');
  f.state.cron = [];
  f.clock.ms = T0 + 9 * DAY;
  const before = treeState(f.rootDir);
  for (const url of ['/api/signals', '/api/loops', '/api/cron', '/api/signals', '/api/loops']) await f.get(url);
  assert.equal((await f.signals()).attention.count, 1);
  assert.deepEqual(treeState(f.rootDir), before);
}));

test('an acknowledgement for an item that is gone is removed after 7 days absent, not at once', () => run({}, async (f) => {
  f.state.systems.hermes = system('hermes', 'warning');
  f.state.systems.gbrain = system('gbrain', 'warning');
  assert.equal((await f.ack('system:hermes')).status, 200);
  f.state.systems.hermes = system('hermes', 'healthy');
  f.clock.ms = T0 + DAY;
  assert.equal((await f.ack('system:gbrain')).status, 200);
  assert.deepEqual(storeKeys(f), ['system:gbrain', 'system:hermes'], 'one day absent: kept (items flap)');

  f.state.systems.hermes = system('hermes', 'warning');
  let { signals } = await f.both();
  assert.equal(signals.attention.count, 0, 'it came back at the same level: still acknowledged');
  f.state.systems.hermes = system('hermes', 'healthy');

  f.clock.ms = T0 + 7 * DAY;
  assert.equal((await f.request('DELETE', '/api/attention/acks/system%3Agbrain')).status, 200);
  assert.deepEqual(storeKeys(f), ['system:hermes'], 'last seen on day 1, now day 7: not yet 7 days absent');
  f.clock.ms = T0 + 9 * DAY;
  f.state.systems.gbrain = system('gbrain', 'warning');
  assert.equal((await f.ack('system:gbrain')).status, 200);
  assert.deepEqual(storeKeys(f), ['system:gbrain'], 'absent for more than 7 days: collected');
  ({ signals } = await f.both());
  assert.equal(signals.attention.standing, 1);
}));

test('cron: every job carries ackKey and ack; failed splits into failed and standingFailed', () => run({}, async (f) => {
  f.state.cron = [
    cronJob('j1', { status: 'failed' }),
    cronJob('j2', { status: 'failed' }),
    cronJob('j3', { status: 'ok' }),
    cronJob('j4', { status: 'failed', enabled: false }),
  ];
  let cron = await f.cron();
  assert.deepEqual(cron.jobs.map((job) => job.ackKey), ['cron:openclaw:j1', 'cron:openclaw:j2', 'cron:openclaw:j3', 'cron:openclaw:j4']);
  assert.ok(cron.jobs.every((job) => job.ack === null));
  assert.equal(cron.summary.failed, 2);
  assert.equal(cron.summary.standingFailed, 0);

  assert.equal((await f.ack('cron:openclaw:j1', 'shelve', null)).status, 200);
  cron = await f.cron();
  assert.equal(cron.summary.failed, 1);
  assert.equal(cron.summary.standingFailed, 1);
  assert.equal(cron.jobs[0].ack.kind, 'shelve');
  const { automations } = await f.signals();
  assert.equal(automations.failed, 1);
  assert.equal(automations.standingFailed, 1);

  const healthy = await f.ack('cron:openclaw:j3');
  assert.equal(healthy.status, 409, 'a job that did not fail is not ackable');
  const disabled = await f.ack('cron:openclaw:j4');
  assert.equal(disabled.status, 409, 'a disabled job is not counted, so not ackable');
}));
