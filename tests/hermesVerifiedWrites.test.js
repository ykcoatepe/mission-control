'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const { createApp } = require('../server/app'); const { loadConfig } = require('../server/core/config');
const { createCronService } = require('../server/services/cronData'); const { withLiveLoop } = require('./helpers/liveLoop');
async function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-verified-cron-'));
  fs.writeFileSync(path.join(root, 'mc-config.json'), '{"name":"Test"}'); fs.writeFileSync(path.join(root, 'package.json'), '{"version":"test"}');
  const jobsFile = path.join(root, '.hermes/profiles/hmudur/cron/jobs.json'); fs.mkdirSync(path.dirname(jobsFile), { recursive: true });
  const hermes = [{ id: 'h1', name: 'Hermes job', enabled: false, state: 'paused', paused_reason: 'Operator paused', paused_at: '2026-11-01T00:00:00Z', schedule: { kind: 'interval', minutes: 30, display: 'every 30m' }, model: 'old', provider: 'local', next_run_at: '2026-08-15T00:00:00Z' }];
  const oc = [{ id: 'o1', name: 'OC job', enabled: false, schedule: { kind: 'cron', expr: '0 * * * *' }, payload: { kind: 'agentTurn', model: 'old', message: 'Task' }, state: { lastStatus: 'ok', lastRunAtMs: Date.parse('2026-11-01T00:00:00Z') } }];
  const persist = () => fs.writeFileSync(jobsFile, JSON.stringify({ jobs: hermes })); persist();
  const clock = { value: Date.parse('2026-11-11T12:00:00Z') };
  const mode = { value: 'success', mutated: false }; const calls = [];
  const runner = { async run(bin, argv, options) {
    calls.push({ bin, argv, options });
    const isHermes = argv[0] === '--profile'; const args = isHermes ? argv.slice(2) : argv;
    if (args[0] !== 'cron') return { ok: false, error: { code: 'fake_disabled' } };
    const command = args[1], id = args[2], rows = isHermes ? hermes : oc;
    if (command === 'list') {
      if (mode.mutated && mode.value === 'read-failed') return { ok: false, error: { code: 'timeout' } };
      return { ok: true, stdout: isHermes ? 'Hermes jobs listed' : JSON.stringify({ jobs: rows }) };
    }
    if (mode.value === 'cli-failed') return { ok: false, error: { code: 'command_failed' }, stderr: 'unsafe failure' };
    mode.mutated = true;
    const job = rows.find(job => job.id === id);
    if (mode.value !== 'rejected') {
      if (isHermes) {
        if (['resume', 'pause'].includes(command)) { job.enabled = command === 'resume'; job.state = job.enabled ? (mode.resumeState || 'scheduled') : 'paused'; job.paused_reason = job.enabled ? null : 'Operator paused'; job.paused_at = job.enabled && !mode.keepPauseMarker ? null : '2026-11-11T00:00:00Z'; }
        if (command === 'edit') for (const [flag, field] of [['--model', 'model'], ['--provider', 'provider']]) { const value = args.find(arg => arg.startsWith(flag + '=')); if (value) job[field] = value.slice(flag.length + 1); else if (args.includes(flag)) job[field] = args[args.indexOf(flag) + 1]; }
        persist();
      } else {
        if (['enable', 'disable'].includes(command)) job.enabled = command === 'enable';
        if (command === 'edit') { if (args.includes('--model')) job.payload.model = args[args.indexOf('--model') + 1]; if (args.includes('--thinking')) job.payload.thinking = args[args.indexOf('--thinking') + 1]; }
        if (command === 'run') { job.state.lastRunAtMs += 60000; if (mode.invalidTimeField) job.state[mode.invalidTimeField] = 1e20; }
        if (command === 'rm') rows.splice(rows.indexOf(job), 1);
        if (command === 'add') rows.push({ ...structuredClone(oc[0]), ...(mode.wrongSchedule ? { schedule: { kind: 'cron', expr: '30 * * * *' } } : {}), id: 'created', sessionTarget: mode.ignoreTarget ? 'main' : args[args.indexOf('--session') + 1], name: args[args.indexOf('--name') + 1], enabled: true });
      }
    } else if (isHermes) { job.paused_reason = 'auto-disabled: enabled+paused contradiction'; persist(); }
    return { ok: true, stdout: JSON.stringify(job || { id: 'created' }) };
  }, killAll() {}, drain: async () => true, status: () => ({ lanes: {}, children: 0, quarantined: [] }) };
  const exec = async args => { const result = await runner.run('openclaw', args, { lane: 'openclaw' }); if (!result.ok) throw new Error('CLI failed'); return result; };
  const cronService = createCronService({ runner, now: () => clock.value, hermesBin: 'fake-hermes', homeDir: root, calendarFile: path.join(root, 'calendar.json'), getOpenclawDefaultModelKey: () => '', openclawExec: exec, fetchImpl: async () => { throw new Error('No network'); } });
  const registered = [];
  const app = createApp({ clock: { now: () => clock.value }, config: loadConfig({ rootDir: root, homeDir: root, env: { PORT: '0' } }), exec: runner,
    logger: { log() {}, warn() {}, error() {} }, fetch: async () => { throw new Error('No network'); },
    scheduler: { register: source => registered.push(source), start() {}, stop() {}, status: () => [] },
    services: { cronService, usageService: { summary: () => ({ data: null, meta: {} }), costs: () => ({}), months: () => ({}), codexbar: () => ({}), dispose() {} } },
  });
  await registered.find(source => source.id === 'openclaw.automations').refresh();
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve)); const port = server.address().port; app.locals.runtime.setBoundPort(port);
  async function request(method, url, body = {}) { const data = method === 'GET' ? '' : JSON.stringify(body); return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: url, headers: { Origin: `http://127.0.0.1:${port}`, 'X-MC-Request': '1', 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, res => { let out = ''; res.on('data', chunk => { out += chunk; }); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(out) })); }); req.on('error', reject); req.end(data);
  }); }
  return { request, mode, calls, jobsFile, calendarFile: path.join(root, 'calendar.json'), hermes, oc, registered, cronService, clock,
    async close() { app.locals.runtime.dispose(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); } };
}
const run = fn => withLiveLoop(async () => { const f = await fixture(); try { await fn(f); } finally { await f.close(); } });
for (const scheduler of ['hermes', 'openclaw']) for (const mode of ['success', 'rejected', 'cli-failed', 'read-failed']) {
  test(`verify ${scheduler} toggle ${mode}: only observed state is published`, () => run(async f => {
    f.mode.value = mode; const id = scheduler === 'hermes' ? 'h1' : 'o1';
    const response = await f.request('POST', `/api/cron/${scheduler}:${id}/toggle`, { enabled: true });
    const read = await f.request('GET', '/api/cron'); const job = read.body.jobs.find(row => row.id === `${scheduler}:${id}`);
    if (mode === 'success') { assert.equal(response.status, 200); assert.equal(response.body.verified, true); assert.equal(response.body.job.verified, true); assert.equal(job.enabled, true); }
    if (mode === 'rejected') { assert.equal(response.status, 409); assert.equal(response.body.error.code, 'upstream_rejected'); assert.equal(job.enabled, false); if (scheduler === 'hermes') assert.match(response.body.error.message, /auto-disabled/); }
    if (mode === 'cli-failed') { assert.ok(response.status >= 400); assert.equal(job.enabled, false); }
    if (mode === 'read-failed') { assert.equal(response.status, 200); assert.equal(response.body.verified, false); assert.equal(response.body.job.verified, false); assert.equal(response.body.meta.stale, true); assert.equal(job.enabled, false); }
    if (scheduler === 'hermes') {
      const mutation = f.calls.find(call => call.argv.includes('resume'));
      assert.ok(mutation); assert.equal(mutation.options.lane, 'hermes'); assert.deepEqual(mutation.argv.slice(0, 3), ['--profile', 'hmudur', 'cron']);
      assert.equal(JSON.parse(fs.readFileSync(f.jobsFile, 'utf8')).jobs[0].enabled, mode === 'success' || mode === 'read-failed');
    }
  }));
}
test('verified Hermes model edits use supported CLI flags and preserve lifecycle state', () => run(async f => {
  const response = await f.request('PATCH', '/api/cron/hermes:h1/model', { model: 'openai-codex/gpt-5.5' });
  assert.equal(response.status, 200); assert.equal(response.body.verified, true);
  assert.ok(f.calls.some(call => call.argv.includes('edit') && call.argv.some(arg => arg === '--model=openai/gpt-5.5')));
  const raw = JSON.parse(fs.readFileSync(f.jobsFile, 'utf8')).jobs[0]; assert.equal(raw.state, 'paused'); assert.equal(raw.enabled, false);
}));
test('past next-run is overdue evidence, not a future summary candidate', () => run(async f => {
  const response = await f.request('POST', '/api/cron/hermes:h1/toggle', { enabled: true }); assert.equal(response.status, 200);
  const read = (await f.request('GET', '/api/cron')).body; const job = read.jobs.find(job => job.id === 'hermes:h1');
  assert.equal(job.nextRun, '2026-08-15T00:00:00.000Z'); assert.equal(job.nextRunOverdue, true); assert.equal(read.summary.nextRunAt, null);
}));

for (const [method, url, body] of [
  ['PATCH', '/api/cron/openclaw:o1/model', { model: 'new' }],
  ['POST', '/api/cron/openclaw:o1/run', {}],
  ['DELETE', '/api/cron/openclaw:o1', {}],
  ['POST', '/api/cron/create', { job: { name: 'Created', schedule: { kind: 'cron', expr: '0 * * * *' }, payload: { kind: 'agentTurn', message: 'Task' } } }],
]) for (const mode of ['success', 'rejected', 'cli-failed', 'read-failed']) {
  test(`verify ${method} ${url} ${mode}`, () => run(async f => {
    f.mode.value = mode;
    const prior = (await f.request('GET', '/api/cron')).body.jobs;
    const response = await f.request(method, url, body);
    const after = (await f.request('GET', '/api/cron')).body.jobs;
    if (mode === 'success') { assert.equal(response.status, 200); assert.equal(response.body.verified, true); assert.equal(response.body.job.verified, true); }
    if (mode === 'rejected') { assert.equal(response.status, 409); assert.equal(response.body.error.code, 'upstream_rejected'); assert.deepEqual(after, prior); }
    if (mode === 'cli-failed') { assert.ok(response.status >= 400); assert.deepEqual(after, prior); }
    if (mode === 'read-failed') {
      assert.equal(response.status, 200); assert.equal(response.body.verified, false); assert.equal(response.body.job.verified, false); assert.equal(response.body.meta.stale, true);
      assert.deepEqual(after.map(({ verified, ...job }) => job), prior.map(({ verified, ...job }) => job));
    }
  }));
}
test('pausing cannot erase the known outcome when a later enabled reading has older history', () => run(async f => {
  f.oc[0].enabled = true; f.oc[0].state.lastStatus = 'failed';
  await f.registered.find(source => source.id === 'openclaw.automations').refresh();
  const known = f.oc[0].state.lastRunAtMs;
  await f.request('POST', '/api/cron/openclaw:o1/toggle', { enabled: false });
  f.oc[0].state.lastRunAtMs -= 60000; f.oc[0].state.lastStatus = 'ok';
  await f.request('POST', '/api/cron/openclaw:o1/toggle', { enabled: true });
  const actual = (await f.request('GET', '/api/cron')).body.jobs.find(job => job.sourceId === 'o1');
  assert.equal(Date.parse(actual.lastRun), known); assert.equal(actual.status, 'failed');
}));


test('create is rejected when upstream creates the name but ignores the requested schedule', () => run(async f => {
  f.mode.wrongSchedule = true;
  const response = await f.request('POST', '/api/cron/create', { job: { name: 'Created', schedule: { kind: 'cron', expr: '0 * * * *' }, payload: { kind: 'agentTurn', message: 'Task' } } });
  assert.equal(response.status, 409); assert.equal(response.body.error.code, 'upstream_rejected');
  const created = (await f.request('GET', '/api/cron')).body.jobs.find(job => job.sourceId === 'created');
  assert.equal(created.schedule, '30 * * * *');
}));

test('overdue evidence advances with the injected clock without a scheduler tick', async () => {
  const { createAutomationSource } = require('../server/sources/openclaw/automations');
  let now = 1000;
  const service = createCronService({ now: () => now, getOpenclawDefaultModelKey: () => '' });
  service.fetchCronJobsForOperations = async () => ({ jobs: [{ id: 'clock', enabled: true, state: { nextRunAtMs: 2000 } }], operationsSource: { schedulers: { openclaw: { sourceSucceeded: true } } } });
  const source = createAutomationSource({ cronService: service, now: () => now });
  await source.refresh(); assert.equal(source.snapshot().data.cron.jobs[0].nextRunOverdue, false);
  now = 3000;
  assert.equal(source.snapshot().data.cron.jobs[0].nextRunOverdue, true); assert.equal(source.snapshot().data.cron.summary.nextRunAt, null);
});

test('malformed upstream model metadata is never promoted as a private object', () => run(async f => {
  f.mode.value = 'rejected'; f.oc[0].payload.model = { apiKey: 'synthetic-private-sentinel' };
  const response = await f.request('PATCH', '/api/cron/openclaw:o1/model', { model: 'new' });
  const actual = await f.request('GET', '/api/cron');
  assert.equal(JSON.stringify(actual.body).includes('synthetic-private-sentinel'), false);
  assert.equal(response.status, 409); assert.equal(response.body.error.code, 'upstream_unverified');
}));


test('a partial resume with paused_at still present is rejected even when state says scheduled', () => run(async f => {
  f.mode.keepPauseMarker = true;
  const response = await f.request('POST', '/api/cron/hermes:h1/toggle', { enabled: true });
  assert.equal(response.status, 409); assert.equal(response.body.error.code, 'upstream_rejected');
  const actual = (await f.request('GET', '/api/cron')).body.jobs.find(job => job.id === 'hermes:h1');
  assert.equal(actual.enabled, false); assert.equal(actual.upstreamEnabled, true);
  assert.equal(actual.pausedAt, '2026-11-11T00:00:00.000Z');
  const calendar = (await f.request('GET', '/api/calendar')).body;
  assert.equal(calendar.entries.find(entry => entry.linkedJobId === 'hermes:h1').status, 'disabled');
}));


for (const state of ['completed', 'error', ' paused ']) test(`resume cannot verify non-runnable lifecycle ${state}`, () => run(async f => {
  f.mode.resumeState = state;
  const response = await f.request('POST', '/api/cron/hermes:h1/toggle', { enabled: true });
  assert.equal(response.status, 409); assert.equal(response.body.error.code, 'upstream_rejected');
  const actual = (await f.request('GET', '/api/cron')).body.jobs.find(job => job.id === 'hermes:h1'); assert.equal(actual.enabled, false);
}));
for (const field of ['lastRunAtMs', 'runningAtMs']) test(`out-of-Date-domain ${field} is not proof that a run occurred`, () => run(async f => {
  f.mode.invalidTimeField = field;
  const response = await f.request('POST', '/api/cron/openclaw:o1/run', {});
  assert.equal(response.status, 409); assert.equal(response.body.error.code, 'upstream_unverified');
}));


for (const failure of ['thrown', 'cached']) test(`verified state survives a ${failure} scheduled refresh and ages honestly`, () => run(async f => {
  const response = await f.request('POST', '/api/cron/openclaw:o1/toggle', { enabled: true }); assert.equal(response.body.verified, true);
  f.clock.value += 1000;
  if (failure === 'thrown') f.cronService.fetchCronJobsForOperations = async () => { throw new Error('upstream failed'); };
  else f.mode.value = 'read-failed';
  await f.registered.find(source => source.id === 'openclaw.automations').refresh();
  const read = (await f.request('GET', '/api/cron')).body;
  assert.equal(read.jobs.find(job => job.id === 'openclaw:o1').enabled, true);
  assert.equal(read.meta.stale, true); assert.equal(read.meta.ok, false); assert.equal(read.meta.ageMs, 1000);
}));


test('create verifies the isolated session default sent to OpenClaw', () => run(async f => {
  f.mode.ignoreTarget = true;
  const response = await f.request('POST', '/api/cron/create', { job: { name: 'Created', schedule: { kind: 'cron', expr: '0 * * * *' }, payload: { kind: 'agentTurn', message: 'Task' } } });
  assert.equal(response.status, 409); assert.equal(response.body.error.code, 'upstream_rejected');
  assert.equal((await f.request('GET', '/api/cron')).body.jobs.find(job => job.sourceId === 'created').target, 'main');
}));

test('a fresh target scheduler supersedes its observation while the other scheduler is unavailable', () => run(async f => {
  await f.request('POST', '/api/cron/openclaw:o1/toggle', { enabled: true });
  f.oc[0].enabled = false;
  f.cronService.fetchCronJobsForOperations = async () => ({ jobs: f.oc.map(job => ({ ...structuredClone(job), scheduler: 'openclaw', sourceId: job.id })),
    operationsSource: { schedulers: { openclaw: { sourceSucceeded: true }, hermes: { sourceSucceeded: false } } } });
  await f.registered.find(source => source.id === 'openclaw.automations').refresh();
  const read = (await f.request('GET', '/api/cron')).body;
  assert.equal(read.jobs.find(job => job.id === 'openclaw:o1').enabled, false); assert.equal(read.meta.stale, true);
}));

test('verifying one scheduler cannot hide the other retained observation becoming stale', () => run(async f => {
  await f.request('POST', '/api/cron/openclaw:o1/toggle', { enabled: true });
  const read = f.cronService.fetchCronJobsForOperations.bind(f.cronService);
  f.cronService.fetchCronJobsForOperations = async () => {
    const data = await read(); data.operationsSource.schedulers.openclaw = { ...data.operationsSource.schedulers.openclaw, stale: true, cacheAgeMs: 1000 }; return data;
  };
  f.clock.value += 1000;
  await f.registered.find(source => source.id === 'openclaw.automations').refresh();
  assert.equal((await f.request('GET', '/api/cron')).body.meta.stale, true);
  await f.request('POST', '/api/cron/hermes:h1/toggle', { enabled: true });
  const actual = (await f.request('GET', '/api/cron')).body;
  assert.equal(actual.meta.stale, true); assert.equal(actual.meta.ok, false); assert.equal(actual.meta.ageMs, 1000);
}));


for (const action of ['toggle', 'model']) test(`Hermes ${action} metadata verification preserves observed calendar notes`, () => run(async f => {
  f.hermes[0].prompt = 'Synthetic previously observed instruction';
  fs.writeFileSync(f.jobsFile, JSON.stringify({ jobs: f.hermes }));
  await f.registered.find(source => source.id === 'openclaw.automations').refresh();
  await f.registered.find(source => source.id === 'openclaw.calendar').refresh();
  const response = await f.request(action === 'toggle' ? 'POST' : 'PATCH', `/api/cron/hermes:h1/${action}`, action === 'toggle' ? { enabled: true } : { model: 'local/new' });
  assert.equal(response.status, 200); assert.equal(response.body.verified, true);
  const read = (await f.request('GET', '/api/calendar')).body;
  assert.equal(read.entries.find(row => row.linkedJobId === 'hermes:h1').notes, 'Synthetic previously observed instruction');
  assert.equal(JSON.parse(fs.readFileSync(f.calendarFile, 'utf8')).entries.find(row => row.linkedJobId === 'hermes:h1').notes, 'Synthetic previously observed instruction');
  assert.equal(JSON.parse(fs.readFileSync(f.jobsFile, 'utf8')).jobs[0].prompt, 'Synthetic previously observed instruction');
}));

test('metadata-only verification preserves a calendar baseline even without cached instructions', () => run(async f => {
  f.cronService.writeCalendarDataSafe({ entries: [{ id: 'cron-hermes:h1', title: 'Hermes job', source: 'cron', linkedJobId: 'hermes:h1', notes: 'Known calendar baseline',
    cronDerived: { title: 'Hermes job', schedule: 'every 30m', assignee: 'Mudur', notes: 'Known calendar baseline' }, userOverrides: [] }] });
  const response = await f.request('POST', '/api/cron/hermes:h1/toggle', { enabled: true }); assert.equal(response.status, 200);
  const row = JSON.parse(fs.readFileSync(f.calendarFile, 'utf8')).entries.find(row => row.linkedJobId === 'hermes:h1');
  assert.equal(row.notes, 'Known calendar baseline');
}));
