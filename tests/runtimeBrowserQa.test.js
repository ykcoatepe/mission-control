const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createCronService } = require('../server/services/cronData');
const { createAutomationSource } = require('../server/sources/openclaw/automations');

function fixture(jobs) {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-runtime-browser-'));
  const calendarFile = path.join(homeDir, 'calendar.json');
  const service = createCronService({ homeDir, calendarFile, getOpenclawDefaultModelKey: () => '', openclawExec: async () => ({ stdout: JSON.stringify({ jobs }) }), fetchImpl: () => { throw new Error('No network'); } });
  return { service, homeDir, calendarFile, cleanup: () => fs.rmSync(homeDir, { recursive: true, force: true }) };
}

test('QA1 observed interval JSON retains cadence in cron and derived calendar entries', async () => {
  // Metadata-only shape observed via the existing reader: kind/everyMs/anchorMs.
  const f = fixture([{ id: 'interval', name: 'Interval', enabled: true, schedule: { kind: 'every', everyMs: 1800000, anchorMs: 1770000000000 } }]);
  try {
    const evidence = await f.service.fetchCronJobsForOperations();
    const job = f.service.mapCronJobForApi(evidence.jobs[0]);
    assert.equal(job.schedule, 'every 30m');
    assert.equal(job.scheduleKind, 'interval');
    assert.equal(job.everyMs, 1800000);
    const calendar = f.service.syncCalendarWithCronEvidence(evidence).entries[0];
    assert.equal(calendar.schedule, job.schedule);
    assert.equal(calendar.scheduleKind, job.scheduleKind);
    assert.equal(calendar.everyMs, job.everyMs);
    assert.equal(f.service.readCalendarDataSafe({ strict: true }).diagnostics.quarantined.count, 0);
  } finally { f.cleanup(); }
});

test('QA1 missing or invalid interval is unknown, never the bare every word', () => {
  const f = fixture([]);
  try {
    for (const everyMs of [undefined, null, 0, -1, '1800000', Infinity]) {
      const raw = { id: 'interval', scheduler: 'openclaw', schedule: { kind: 'every', everyMs } };
      const job = f.service.mapCronJobForApi(raw);
      assert.equal(job.schedule, null);
      assert.equal(job.scheduleKind, 'interval_unknown');
      assert.equal(job.everyMs, null);
      const calendar = f.service.syncCalendarWithCronEvidence({ jobs: [raw], operationsSource: { schedulers: { openclaw: { sourceSucceeded: true } } } }).entries[0];
      assert.equal(calendar.schedule, null);
      assert.equal(calendar.scheduleKind, 'interval_unknown');
      assert.equal(calendar.everyMs, null);
      f.service.updateCalendarEntry(calendar.id, { schedule: 'My display' });
      assert.equal(f.service.updateCalendarEntry(calendar.id, { schedule: null }).entry.schedule, null);
      assert.equal(f.service.readCalendarDataSafe({ strict: true }).entries.length, 1);
    }
  } finally { f.cleanup(); }
});

test('QA1 interval units stay exact and Hermes normalization does not drop everyMs', async () => {
  const f = fixture([]);
  try {
    for (const [everyMs, text] of [[120000, 'every 2m'], [86400000, 'every 1d'], [259200000, 'every 3d'], [1500, 'every 1500ms']]) {
      assert.equal(f.service.mapCronJobForApi({ id: 'job', schedule: { kind: 'every', everyMs } }).schedule, text);
    }
    const dir = path.join(f.homeDir, '.hermes/profiles/hmudur/cron');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'jobs.json'), JSON.stringify({ jobs: [{ id: 'hermes', schedule: { kind: 'every', everyMs: 120000 } }] }));
    const result = await f.service.fetchCronJobsForOperations();
    const job = f.service.mapCronJobForApi(result.jobs.find(row => row.scheduler === 'hermes'));
    assert.equal(job.everyMs, 120000);
    assert.equal(job.schedule, 'every 2m');
    assert.equal(f.service.mapCronJobForApi({ id: 'cron', schedule: { kind: 'cron', expr: '0 * * * *' } }).schedule, '0 * * * *');
  } finally { f.cleanup(); }
});

test('QA5 summary definitions explicitly describe failed as a subset of enabled active jobs', async () => {
  const jobs = [{ id: 'good', enabled: true, status: 'active' }, { id: 'bad', enabled: true, status: 'failed' }, { id: 'paused', enabled: false, status: 'failed' }];
  const source = createAutomationSource({ cronService: { fetchCronJobsForOperations: async () => ({ jobs, operationsSource: { schedulers: { openclaw: { sourceSucceeded: true } } } }), mapCronJobForApi: job => job } });
  const { data } = await source.refresh();
  assert.equal(data.cron.summary.active, 2);
  assert.equal(data.cron.summary.failed, 1);
  assert.match(data.cron.summary.definitions.active, /every enabled job/i);
  assert.match(data.cron.summary.definitions.failed, /subset of active/i);
});
