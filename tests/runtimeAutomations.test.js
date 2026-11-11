const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { createAutomationSource } = require('../server/sources/openclaw/automations');
const { createCalendarSource } = require('../server/sources/openclaw/calendar');
const { buildCronRouter } = require('../server/routes/cron');
const { buildCalendarRouter } = require('../server/routes/calendar');
const { buildSignalsRouter } = require('../server/routes/signals');
const { errorHandler } = require('../server/core/http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createCronService } = require('../server/services/cronData');

const proof = { sourceSucceeded: true, observedAt: '2026-11-11T00:00:00Z' };
function fixture() {
  let fail = false;
  let reads = 0;
  let writes = 0;
  const service = {
    async fetchCronJobsForOperations() {
      reads++;
      if (fail) throw new Error('sensitive child stderr');
      return { jobs: [{ id: 'x', enabled: true }], operationsSource: { schedulers: { openclaw: proof, hermes: proof } } };
    },
    mapCronJobForApi: () => ({ id: 'openclaw:x', enabled: true, status: 'failed', nextRun: '2026-11-12T00:00:00Z' }),
    syncCalendarWithCronEvidence() { writes++; return { entries: [{ id: 'cron-x' }], updatedAt: null, lastCronSyncAt: null }; },
    readCalendarDataSafe() { return { entries: [{ id: 'cron-x' }], updatedAt: null, lastCronSyncAt: null }; },
  };
  return { service, fail: () => { fail = true; }, counts: () => ({ reads, writes }) };
}

test('automation source keeps last good with typed stale failure; never invents unknown jobs', async () => {
  const f = fixture();
  const source = createAutomationSource({ cronService: f.service, now: () => Date.parse('2026-11-11T00:00:00Z') });
  assert.equal(source.snapshot().data, null);
  await source.refresh();
  const first = source.snapshot();
  assert.deepEqual(first.data.cron.summary, { active: 1, paused: 0, failed: 1, nextRunAt: '2026-11-12T00:00:00Z' });
  f.fail();
  await source.refresh();
  const after = source.snapshot();
  assert.deepEqual(after.data, first.data);
  assert.equal(after.meta.stale, true);
  assert.equal(after.meta.error.code, 'automations_unavailable');
  assert.doesNotMatch(JSON.stringify(after.meta), /sensitive/);
});

test('summary next run ignores past, paused, invalid and clock-boundary times, including while cached', async () => {
  let clock = Date.parse('2026-11-11T12:00:00Z');
  const f = fixture();
  const jobs = [
    { enabled: true, nextRun: '2026-06-07T15:20:00Z' },
    { enabled: false, nextRun: '2026-11-11T12:00:01Z' },
    { enabled: true, nextRun: '2026-11-11T12:00:00Z' },
    { enabled: true, nextRun: 'not-a-date' },
    { enabled: true, nextRun: null },
    { enabled: true, nextRun: '2026-11-11T12:02:00Z' },
    { enabled: true, nextRun: '2026-11-11T12:01:00Z' },
  ];
  f.service.fetchCronJobsForOperations = async () => ({ jobs, operationsSource: { schedulers: { openclaw: proof, hermes: proof } } });
  f.service.mapCronJobForApi = job => job;
  const source = createAutomationSource({ cronService: f.service, now: () => clock });
  assert.equal((await source.refresh()).data.cron.summary.nextRunAt, '2026-11-11T12:01:00Z');
  clock = Date.parse('2026-11-11T12:01:00Z');
  assert.equal(source.snapshot().data.cron.summary.nextRunAt, '2026-11-11T12:02:00Z');
  clock = Date.parse('2026-11-11T12:02:01Z');
  assert.equal(source.snapshot().data.cron.summary.nextRunAt, null);
});

test('summary failures match enabled last-run status rules, never paused or unknown history entries', async () => {
  const f = fixture();
  const jobs = [
    { enabled: false, status: 'failed' },
    { enabled: false, status: 'error' },
    { enabled: true, status: 'unknown', history: [{ status: 'unknown' }] },
    { enabled: true, status: undefined },
    { enabled: true, status: 'active', history: [{ status: 'ok' }, { status: 'failed' }] },
    { enabled: true, status: 'failed' },
    { enabled: true, status: ' ERROR ' },
    { enabled: true, status: 'errored' },
  ];
  f.service.fetchCronJobsForOperations = async () => ({ jobs, operationsSource: { schedulers: { openclaw: proof, hermes: proof } } });
  f.service.mapCronJobForApi = job => job;
  const source = createAutomationSource({ cronService: f.service });
  assert.equal((await source.refresh()).data.cron.summary.failed, 3);
  jobs.splice(5);
  assert.equal((await source.refresh()).data.cron.summary.failed, 0);
});

test('cron/calendar GETs never read upstream or write, including cold and stale snapshots', async () => {
  const f = fixture();
  const source = createAutomationSource({ cronService: f.service });
  const calendarSource = createCalendarSource({ cronService: f.service, automationSource: source });
  const app = express();
  app.use(express.json());
  app.use(buildCronRouter({ cronService: f.service, automationSource: source, openclawExec: () => { throw new Error('GET spawned'); } }));
  app.use(buildCalendarRouter({ calendarService: f.service, calendarSource }));
  const unavailableSource = { snapshot: () => ({ data: null, meta: { ok: false, stale: true } }) };
  app.use(buildSignalsRouter({
    operationsOverviewService: { getOverview: async () => null },
    loopsSource: unavailableSource, launchdSource: unavailableSource, reachabilitySource: unavailableSource,
    automationsSnapshot: () => source.snapshot(),
  }));
  app.use(errorHandler({ logger: { error() {} } }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const path of ['/api/cron', '/api/calendar']) {
      const response = await fetch(base + path);
      assert.equal(response.status, 503);
      assert.equal(typeof (await response.json()).error.code, 'string');
    }
    assert.deepEqual(f.counts(), { reads: 0, writes: 0 });
    await source.refresh();
    await calendarSource.refresh();
    f.fail();
    await source.refresh();
    await calendarSource.refresh();
    const before = f.counts();
    for (const path of ['/api/cron', '/api/calendar']) {
      const response = await fetch(base + path);
      assert.equal(response.status, 200);
      assert.equal((await response.json()).meta.stale, true);
    }
    const signals = await (await fetch(base + '/api/signals')).json();
    assert.deepEqual(signals.data.automations, {
      failed: source.snapshot().data.cron.summary.failed,
      nextRunAt: source.snapshot().data.cron.summary.nextRunAt,
    });
    assert.deepEqual(f.counts(), before);
    const invalid = await fetch(base + '/api/cron/x/toggle', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"enabled":"false"}' });
    assert.equal(invalid.status, 400);
  } finally { await new Promise(r => server.close(r)); }
});

test('calendar refresh prunes only freshly observed scheduler jobs and namespaces colliding IDs', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-runtime-calendar-'));
  const calendarFile = path.join(home, 'calendar.json');
  const service = createCronService({ homeDir: home, calendarFile, getOpenclawDefaultModelKey: () => '', openclawExec: () => { throw new Error('not called'); } });
  const entry = (id, source = 'cron') => ({ id, source, title: id, linkedJobId: source === 'cron' ? id : null });
  try {
    service.writeCalendarDataSafe({ entries: [entry('openclaw:old'), entry('hermes:old'), entry('manual', 'manual')] });
    service.syncCalendarWithCronEvidence({ jobs: [{ id: 'same', scheduler: 'hermes' }], operationsSource: { schedulers: { openclaw: { sourceSucceeded: false }, hermes: proof } } });
    const first = service.readCalendarDataSafe();
    assert.deepEqual(first.entries.map(e => e.linkedJobId).filter(Boolean).sort(), ['hermes:same', 'openclaw:old']);
    assert.ok(first.entries.some(e => e.id === 'manual'));
    const both = service.syncCalendarWithCronEvidence({ jobs: [{ id: 'same', scheduler: 'hermes' }, { id: 'same', scheduler: 'openclaw' }], operationsSource: { schedulers: { openclaw: proof, hermes: proof } } });
    assert.equal(new Set(both.entries.map(e => e.id)).size, both.entries.length);
    const before = fs.readFileSync(calendarFile, 'utf8');
    assert.throws(() => service.syncCalendarWithCronEvidence({ jobs: [], operationsSource: { schedulers: { hermes: { ...proof, stale: true } } } }), { code: 'calendar_scheduler_unavailable' });
    assert.equal(fs.readFileSync(calendarFile, 'utf8'), before);
    const cleared = service.syncCalendarWithCronEvidence({ jobs: [], operationsSource: { schedulers: { hermes: proof } } });
    assert.deepEqual(cleared.entries.filter(e => e.source === 'cron').map(e => e.linkedJobId), ['openclaw:same']);
    fs.writeFileSync(calendarFile, '{broken');
    assert.throws(() => service.syncCalendarWithCronEvidence({ jobs: [], operationsSource: { schedulers: { hermes: proof } } }), { code: 'calendar_unavailable' });
    assert.equal(fs.readFileSync(calendarFile, 'utf8'), '{broken');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('unrecognized empty CLI output never becomes evidence of zero OpenClaw jobs', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-runtime-empty-'));
  try {
    const service = createCronService({ homeDir: home, calendarFile: path.join(home, 'calendar.json'), openclawExec: async () => ({ stdout: 'gateway unavailable', stderr: '' }), fetchImpl: async () => ({ ok: false }) });
    const result = await service.fetchCronJobsForOperations();
    assert.equal(result.operationsSource.schedulers.openclaw.sourceSucceeded, false);
    assert.equal(result.operationsSource.schedulers.openclaw.observedAt, null);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('partial scheduler failure marks refresh, snapshots and scheduler health stale consistently', async () => {
  const f = fixture();
  f.service.fetchCronJobsForOperations = async () => ({ jobs: [], operationsSource: { schedulers: { openclaw: { sourceSucceeded: false }, hermes: proof } } });
  const source = createAutomationSource({ cronService: f.service });
  const refreshed = await source.refresh();
  assert.equal(refreshed.meta.stale, true);
  assert.equal(source.snapshot().meta.ok, false);
  assert.equal(source.status().ok, false);
  assert.equal(source.status().stale, true);
  assert.equal(source.status().error.code, 'scheduler_stale');
});

test('namespacing legacy calendar links retains operator edits and stable entry identity', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-runtime-legacy-calendar-'));
  const service = createCronService({ homeDir: home, calendarFile: path.join(home, 'calendar.json') });
  try {
    service.writeCalendarDataSafe({ entries: [{ id: 'custom-id', linkedJobId: 'same', source: 'cron', title: 'old', assignee: 'Operator', notes: 'keep', createdAt: '2026-01-01T00:00:00Z' }] });
    const result = service.syncCalendarWithCronEvidence({ jobs: [{ id: 'same', scheduler: 'openclaw' }], operationsSource: { schedulers: { openclaw: proof } } });
    assert.equal(result.entries.length, 1);
    assert.equal(result.entries[0].id, 'custom-id');
    assert.equal(result.entries[0].assignee, 'Operator');
    assert.equal(result.entries[0].notes, 'keep');
    assert.equal(result.entries[0].createdAt, '2026-01-01T00:00:00.000Z');
    assert.equal(result.entries[0].linkedJobId, 'openclaw:same');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('accepted fresh scheduler cache remains usable for calendar and does not become falsely stale', async () => {
  const f = fixture();
  f.service.fetchCronJobsForOperations = async () => ({ jobs: [], operationsSource: { schedulers: { openclaw: { ...proof, cacheAgeMs: 17_000 }, hermes: proof } } });
  const source = createAutomationSource({ cronService: f.service });
  assert.equal((await source.refresh()).meta.stale, false);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-runtime-fresh-calendar-'));
  const service = createCronService({ homeDir: home, calendarFile: path.join(home, 'calendar.json') });
  try {
    const result = service.syncCalendarWithCronEvidence({ jobs: [{ id: 'slow', scheduler: 'openclaw' }], operationsSource: { schedulers: { openclaw: { ...proof, cacheAgeMs: 17_000 } } } });
    assert.equal(result.entries[0].linkedJobId, 'openclaw:slow');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
