const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createCronService } = require('../server/services/cronData');
const { createAutomationSource } = require('../server/sources/openclaw/automations');
const express = require('express');
const { buildCronRouter } = require('../server/routes/cron');
const { buildCalendarRouter } = require('../server/routes/calendar');
const { errorHandler } = require('../server/core/http');

const evidence = (extra = {}) => ({ jobs: [{ id: 'one', scheduler: 'openclaw', name: 'Cron title', payload: { message: 'Cron notes' }, state: { nextRunAtMs: Date.parse('2026-12-01T00:00:00Z') }, ...extra }], operationsSource: { schedulers: { openclaw: { sourceSucceeded: true } } } });
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-final-review-'));
  const calendarFile = path.join(root, 'calendar.json');
  const service = createCronService({ homeDir: root, calendarFile, getOpenclawDefaultModelKey: () => '' });
  return { service, calendarFile, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('N2 linked status and startsAt reject edits without writing', () => {
  const f = fixture();
  try {
    const entry = f.service.syncCalendarWithCronEvidence(evidence()).entries[0];
    const before = fs.readFileSync(f.calendarFile, 'utf8');
    for (const field of ['status', 'startsAt', 'nextRun', 'nextRunAt', 'nextRunAtMs']) {
      assert.throws(() => f.service.updateCalendarEntry(entry.id, { [field]: field === 'status' ? 'scheduled' : null }), { status: 400, code: 'calendar_scheduler_owned' });
      assert.equal(fs.readFileSync(f.calendarFile, 'utf8'), before);
    }
  } finally { f.cleanup(); }
});

test('N2 sync strips legacy time/status pins and null clears display overrides immediately', () => {
  const f = fixture();
  try {
    const entry = f.service.syncCalendarWithCronEvidence(evidence()).entries[0];
    const stored = JSON.parse(fs.readFileSync(f.calendarFile, 'utf8'));
    stored.entries[0].status = 'scheduled';
    stored.entries[0].userOverrides = ['status', 'startsAt'];
    fs.writeFileSync(f.calendarFile, JSON.stringify(stored));
    const synced = f.service.syncCalendarWithCronEvidence(evidence({ state: { lastStatus: 'failed', nextRunAtMs: null } })).entries[0];
    assert.equal(synced.status, 'failed');
    assert.equal(synced.startsAt, null);
    assert.deepEqual(synced.userOverrides, []);
    f.service.updateCalendarEntry(entry.id, { title: 'User title', notes: 'User notes', assignee: 'Operator' });
    const reset = f.service.updateCalendarEntry(entry.id, { title: null, notes: null, assignee: null }).entry;
    assert.equal(reset.title, 'Cron title');
    assert.equal(reset.notes, 'Cron notes');
    assert.equal(reset.assignee, 'Mudur');
    assert.deepEqual(reset.userOverrides, []);
  } finally { f.cleanup(); }
});

test('N3 cron refresh is independent of an unreadable calendar and never syncs it', async () => {
  let writes = 0;
  const source = createAutomationSource({ cronService: {
    fetchCronJobsForOperations: async () => evidence(), mapCronJobForApi: job => ({ ...job, enabled: true }),
    syncCalendarWithCronEvidence() { writes++; throw new Error('Calendar unavailable'); },
  } });
  const result = await source.refresh();
  assert.equal(result.meta.ok, true);
  assert.equal(result.data.cron.jobs.length, 1);
  assert.equal(writes, 0);
});

test('N3 malformed entries are quarantined individually without discarding valid entries', () => {
  const f = fixture();
  try {
    const raw = JSON.stringify({ entries: [{ id: 'valid', title: 'Keep' }, { id: 7, title: 'Invalid' }, null] });
    fs.writeFileSync(f.calendarFile, raw);
    const result = f.service.readCalendarDataSafe({ strict: true, tolerateEntries: true });
    assert.deepEqual(result.entries.map(entry => entry.id), ['valid']);
    assert.deepEqual(result.diagnostics.quarantined, { count: 2, ids: [7, null] });
    assert.equal(fs.readFileSync(f.calendarFile, 'utf8'), raw);
    assert.throws(() => f.service.createCalendarEntry({ title: 'New' }), { code: 'calendar_unavailable' });
  } finally { f.cleanup(); }
});

test('N5 create ignores client IDs and duplicate reads serve the first file entry with diagnostics', () => {
  const f = fixture();
  try {
    const first = f.service.createCalendarEntry({ id: 'client', title: 'First' }).entry;
    const second = f.service.createCalendarEntry({ id: first.id, title: 'Second' }).entry;
    assert.notEqual(first.id, 'client');
    assert.notEqual(second.id, first.id);
    const raw = JSON.stringify({ entries: [{ id: 'same', title: 'First in file', startsAt: '2026-12-02T00:00:00Z' }, { id: 'same', title: 'Earlier time but second in file', startsAt: '2026-12-01T00:00:00Z' }] });
    fs.writeFileSync(f.calendarFile, raw);
    const result = f.service.readCalendarDataSafe({ strict: true, tolerateEntries: true });
    assert.equal(result.entries.length, 1);
    assert.equal(result.entries[0].title, 'First in file');
    assert.deepEqual(result.diagnostics.duplicates, { count: 1, ids: ['same'] });
    assert.equal(fs.readFileSync(f.calendarFile, 'utf8'), raw);
  } finally { f.cleanup(); }
});

test('N3 calendar has independent scheduled failure metadata and GETs never refresh or write', async () => {
  const { createCalendarSource } = require('../server/sources/openclaw/calendar');
  const f = fixture();
  let cronReads = 0;
  f.service.fetchCronJobsForOperations = async () => { cronReads++; return evidence(); };
  const automationSource = createAutomationSource({ cronService: f.service });
  const calendarSource = createCalendarSource({ cronService: f.service, automationSource });
  const app = express();
  app.use(buildCronRouter({ cronService: f.service, automationSource }));
  app.use(buildCalendarRouter({ calendarService: f.service, calendarSource }));
  app.use(errorHandler({ logger: { error() {} } }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await automationSource.refresh();
    const raw = JSON.stringify({ entries: [{ id: 'valid', title: 'Keep' }, { id: 7, title: 'Quarantined' }] });
    fs.writeFileSync(f.calendarFile, raw);
    await calendarSource.refresh();
    const cron = await (await fetch(base + '/api/cron')).json();
    const calendar = await (await fetch(base + '/api/calendar')).json();
    assert.equal(cron.meta.ok, true);
    assert.equal(calendar.entries[0].id, 'valid');
    assert.equal(calendar.meta.ok, false);
    assert.equal(calendar.meta.error.code, 'calendar_entries_quarantined');
    assert.deepEqual(calendar.diagnostics.quarantined, { count: 1, ids: [7] });
    assert.equal(calendarSource.status().error.code, calendar.meta.error.code);
    assert.equal(fs.readFileSync(f.calendarFile, 'utf8'), raw);
    fs.writeFileSync(f.calendarFile, '{truncated');
    await calendarSource.refresh();
    const failed = await (await fetch(base + '/api/calendar')).json();
    assert.equal(failed.meta.error.code, 'calendar_unavailable');
    assert.equal(failed.meta.stale, true);
    assert.equal(failed.entries[0].id, 'valid');
    assert.equal((await (await fetch(base + '/api/cron')).json()).meta.ok, true);
    assert.equal(fs.readFileSync(f.calendarFile, 'utf8'), '{truncated');
    assert.equal(cronReads, 1);
  } finally { await new Promise(r => server.close(r)); f.cleanup(); }
});

test('N3 malformed field types and invalid dates quarantine only their own rows', () => {
  const f = fixture();
  try {
    fs.writeFileSync(f.calendarFile, JSON.stringify({ entries: [
      { id: 'valid', title: 'Keep' },
      { id: 'title-object', title: { value: 'Invalid' } },
      { id: 'bad-time', startsAt: 'not-a-date' },
      { id: 'bad-link', source: 'cron', linkedJobId: 7 },
    ] }));
    const result = f.service.readCalendarDataSafe({ strict: true, tolerateEntries: true });
    assert.deepEqual(result.entries.map(entry => entry.id), ['valid']);
    assert.deepEqual(result.diagnostics.quarantined, { count: 3, ids: ['title-object', 'bad-time', 'bad-link'] });
  } finally { f.cleanup(); }
});

test('N3 partial scheduler sync preserves unavailable rows and marks calendar evidence stale', async () => {
  const { createCalendarSource } = require('../server/sources/openclaw/calendar');
  const f = fixture();
  const ok = { sourceSucceeded: true };
  let current = { jobs: [{ id: 'old', scheduler: 'openclaw', name: 'Retained' }, { id: 'hermes', scheduler: 'hermes', name: 'Before' }], operationsSource: { schedulers: { openclaw: ok, hermes: ok } } };
  f.service.fetchCronJobsForOperations = async () => current;
  const cron = createAutomationSource({ cronService: f.service });
  const calendar = createCalendarSource({ cronService: f.service, automationSource: cron });
  try {
    await cron.refresh();
    assert.equal((await calendar.refresh()).meta.ok, true);
    current = { jobs: [{ id: 'hermes', scheduler: 'hermes', name: 'After' }], operationsSource: { schedulers: { openclaw: { sourceSucceeded: false }, hermes: ok } } };
    await cron.refresh();
    const result = await calendar.refresh();
    assert.equal(result.entries, undefined);
    assert.equal(result.data.entries.length, 2);
    assert.ok(result.data.entries.some(entry => entry.title === 'Retained'));
    assert.ok(result.data.entries.some(entry => entry.title === 'After'));
    assert.equal(result.meta.ok, false);
    assert.equal(result.meta.stale, true);
    assert.equal(result.meta.error.code, 'calendar_scheduler_stale');
    assert.equal(calendar.status().error.code, 'calendar_scheduler_stale');
  } finally { f.cleanup(); }
});

test('N2 sync strips every legacy next-run override label instead of quarantining its entry', () => {
  const f = fixture();
  try {
    const entry = f.service.syncCalendarWithCronEvidence(evidence()).entries[0];
    const stored = JSON.parse(fs.readFileSync(f.calendarFile, 'utf8'));
    stored.entries[0].userOverrides = ['status', 'startsAt', 'nextRun', 'nextRunAt', 'nextRunAtMs', 'title'];
    stored.entries[0].title = 'Keep user title';
    fs.writeFileSync(f.calendarFile, JSON.stringify(stored));
    const next = f.service.syncCalendarWithCronEvidence(evidence({ state: { lastStatus: 'failed', nextRunAtMs: null } })).entries[0];
    assert.equal(next.id, entry.id);
    assert.equal(next.status, 'failed');
    assert.equal(next.startsAt, null);
    assert.equal(next.title, 'Keep user title');
    assert.deepEqual(next.userOverrides, ['title']);
  } finally { f.cleanup(); }
});
