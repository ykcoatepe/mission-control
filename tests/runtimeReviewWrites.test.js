const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const { createCronService } = require('../server/services/cronData');
const { buildCalendarRouter } = require('../server/routes/calendar');
const { buildCronRouter } = require('../server/routes/cron');
const { errorHandler } = require('../server/core/http');

function fixture() {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-review-writes-'));
  const calendarFile = path.join(homeDir, 'calendar.json');
  const jobsFile = path.join(homeDir, '.hermes/profiles/hmudur/cron/jobs.json');
  const service = createCronService({ homeDir, calendarFile });
  return { service, calendarFile, jobsFile, cleanup: () => fs.rmSync(homeDir, { recursive: true, force: true }) };
}

test('R1 all calendar mutations refuse corrupt files without losing bytes', () => {
  const f = fixture();
  try {
    for (const raw of ['{"entries":[{"id":"one"},', '{"entries":{}}', '{"entries":[null]}']) {
      for (const write of [() => f.service.createCalendarEntry({ title: 'new' }), () => f.service.updateCalendarEntry('one', { title: 'new' })]) {
        fs.writeFileSync(f.calendarFile, raw);
        assert.throws(write, { status: 409, code: 'calendar_unavailable' });
        assert.equal(fs.readFileSync(f.calendarFile, 'utf8'), raw);
      }
    }
  } finally { f.cleanup(); }
});

test('R1 corrupt calendar write reaches the centralized 409 error contract', async () => {
  const f = fixture();
  fs.writeFileSync(f.calendarFile, '{truncated');
  const app = express();
  app.use(express.json());
  app.use(buildCalendarRouter({ calendarService: f.service }));
  app.use(errorHandler({ logger: { error() {} } }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/calendar`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"title":"new"}' });
    assert.equal(response.status, 409);
    assert.equal((await response.json()).error.code, 'calendar_unavailable');
    assert.equal(fs.readFileSync(f.calendarFile, 'utf8'), '{truncated');
  } finally { await new Promise(r => server.close(r)); f.cleanup(); }
});

test('R1 Hermes read-modify-write rejects corrupt or malformed jobs without rewriting', () => {
  const f = fixture();
  try {
    fs.mkdirSync(path.dirname(f.jobsFile), { recursive: true });
    for (const raw of ['{truncated', '{"jobs":{}}', '{"jobs":[null]}']) {
      fs.writeFileSync(f.jobsFile, raw);
      assert.throws(() => f.service.updateHermesCronJobEnabled('one', true), { status: 409, code: 'hermes_cron_unavailable' });
      assert.equal(fs.readFileSync(f.jobsFile, 'utf8'), raw);
    }
  } finally { f.cleanup(); }
});

test('R3 edit-then-sync preserves explicit user fields and refreshes remaining cron fields', () => {
  const f = fixture();
  const evidence = job => ({ jobs: [{ id: 'one', scheduler: 'openclaw', ...job }], operationsSource: { schedulers: { openclaw: { sourceSucceeded: true } } } });
  try {
    const initial = f.service.syncCalendarWithCronEvidence(evidence({ name: 'original', schedule: { expr: '0 * * * *' }, payload: { message: 'original note' } }));
    const id = initial.entries[0].id;
    const edits = { title: 'My title', schedule: 'custom schedule', status: 'review', notes: '', assignee: 'Operator' };
    f.service.updateCalendarEntry(id, edits);
    const next = f.service.syncCalendarWithCronEvidence(evidence({ name: 'upstream title', schedule: { expr: '* * * * *' }, payload: { message: 'upstream note' }, state: { nextRunAtMs: Date.parse('2026-12-01T00:00:00Z'), lastStatus: 'failed' } }));
    for (const [key, value] of Object.entries(edits)) assert.equal(next.entries[0][key], value, key);
    assert.equal(next.entries[0].startsAt, '2026-12-01T00:00:00.000Z');
    assert.deepEqual(new Set(next.entries[0].userOverrides), new Set(Object.keys(edits)));
    assert.equal(next.entries[0].id, id);
    f.service.updateCalendarEntry(id, { startsAt: '2026-12-02T00:00:00Z', userOverrides: [], source: 'manual', linkedJobId: 'forged' });
    const last = f.service.syncCalendarWithCronEvidence(evidence({ name: 'another', state: { nextRunAtMs: Date.parse('2026-12-03T00:00:00Z') } }));
    assert.equal(last.entries[0].startsAt, '2026-12-02T00:00:00.000Z');
    assert.equal(last.entries[0].source, 'cron');
    assert.equal(last.entries[0].linkedJobId, 'openclaw:one');
    assert.equal(last.entries[0].title, 'My title');
  } finally { f.cleanup(); }
});

test('R5 dash-leading cron values are rejected before argv invocation', async () => {
  let calls = 0;
  const router = buildCronRouter({ cronService: { parseFirstJson: () => ({}), mapCronJobForApi: x => x }, openclawExec: async () => { calls++; return {}; } });
  async function invoke(method, routePath, body) {
    const layer = router.stack.find(l => l.route?.path === routePath && l.route.methods[method]);
    let failure;
    await layer.route.stack[0].handle({ body, params: { id: 'openclaw:one' } }, { json() {} }, error => { failure = error; });
    assert.equal(failure?.status, 400);
  }
  const job = { name: 'safe', schedule: { kind: 'cron', expr: '* * * * *' }, payload: { kind: 'agentTurn', message: 'safe', model: 'provider/model' } };
  for (const unsafe of [
    { ...job, name: '--disabled' },
    { ...job, payload: { ...job.payload, message: ' --json' } },
    { ...job, payload: { ...job.payload, model: '--model=evil' } },
    { ...job, payload: { kind: 'systemEvent', text: '--disabled' } },
  ]) await invoke('post', '/api/cron/create', { job: unsafe });
  await invoke('patch', '/api/cron/:id/model', { model: '--json' });
  assert.equal(calls, 0);
});

test('R3 unchanged form fields stay cron-owned when only notes were edited', () => {
  const f = fixture();
  const evidence = name => ({ jobs: [{ id: 'one', scheduler: 'openclaw', name }], operationsSource: { schedulers: { openclaw: { sourceSucceeded: true } } } });
  try {
    const entry = f.service.syncCalendarWithCronEvidence(evidence('original')).entries[0];
    f.service.updateCalendarEntry(entry.id, { ...entry, notes: 'edited' });
    const next = f.service.syncCalendarWithCronEvidence(evidence('new upstream title')).entries[0];
    assert.equal(next.title, 'new upstream title');
    assert.equal(next.notes, 'edited');
    assert.deepEqual(next.userOverrides, ['notes']);
  } finally { f.cleanup(); }
});

test('R5 non-string cron model identifiers are rejected before any argv invocation', async () => {
  let calls = 0;
  const router = buildCronRouter({ cronService: { parseFirstJson: () => ({}) }, openclawExec: async () => { calls++; return {}; } });
  const route = router.stack.find(layer => layer.route?.path === '/api/cron/create').route;
  for (const model of [123, true, null, ['valid/model']]) {
    let failure;
    await route.stack[0].handle({ body: { job: { name: 'safe', schedule: { kind: 'every', everyMs: 1000 }, payload: { kind: 'agentTurn', message: 'safe', model } } } }, { json() {} }, error => { failure = error; });
    assert.equal(failure?.status, 400);
  }
  assert.equal(calls, 0);
});

test('R3 fresh absent cron next-run clears the unedited calendar time', () => {
  const f = fixture();
  const evidence = nextRunAtMs => ({ jobs: [{ id: 'one', scheduler: 'openclaw', state: { nextRunAtMs } }], operationsSource: { schedulers: { openclaw: { sourceSucceeded: true } } } });
  try {
    const entry = f.service.syncCalendarWithCronEvidence(evidence(Date.parse('2026-12-01T00:00:00Z'))).entries[0];
    f.service.updateCalendarEntry(entry.id, { notes: 'edited' });
    const next = f.service.syncCalendarWithCronEvidence(evidence(null)).entries[0];
    assert.equal(next.startsAt, null);
    assert.equal(next.notes, 'edited');
    assert.deepEqual(next.userOverrides, ['notes']);
  } finally { f.cleanup(); }
});

test('R3 new manual entries cannot claim scheduler linkage or seed its overrides', () => {
  const f = fixture();
  try {
    f.service.createCalendarEntry({ title: 'Existing manual entry' });
    const before = fs.readFileSync(f.calendarFile, 'utf8');
    assert.throws(() => f.service.createCalendarEntry({ title: 'forged', source: 'cron', linkedJobId: 'openclaw:one', userOverrides: ['title'] }), { status: 400, code: 'invalid_calendar_link' });
    assert.equal(fs.readFileSync(f.calendarFile, 'utf8'), before);
  } finally { f.cleanup(); }
});
