const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createCronService } = require('../server/services/cronData');
const { createAutomationSource } = require('../server/sources/openclaw/automations');
const { createCalendarSource } = require('../server/sources/openclaw/calendar');
const { buildCalendarRouter } = require('../server/routes/calendar');

function fixture(fsImpl = fs) {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-calendar-repair-'));
  const calendarFile = path.join(homeDir, 'calendar.json');
  const service = createCronService({ calendarFile, homeDir, fsImpl, getOpenclawDefaultModelKey: () => '' });
  return { service, calendarFile, homeDir, cleanup: () => fs.rmSync(homeDir, { recursive: true, force: true }) };
}

test('calendar schema rejects the reproduced linkedTaskId numeric write before it can quarantine itself', () => {
  const f = fixture();
  try {
    f.service.createCalendarEntry({ title: 'Existing' });
    const before = fs.readFileSync(f.calendarFile, 'utf8');
    assert.throws(() => f.service.createCalendarEntry({ title: 'x', linkedTaskId: 5 }), { status: 400 });
    assert.equal(fs.readFileSync(f.calendarFile, 'utf8'), before);
    assert.equal(f.service.readCalendarDataSafe({ strict: true }).entries.length, 1);
  } finally { f.cleanup(); }
});

test('calendar schema validates cron output and direct writers before touching the file', () => {
  const f = fixture();
  try {
    f.service.createCalendarEntry({ title: 'Existing' });
    const before = fs.readFileSync(f.calendarFile, 'utf8');
    for (const write of [
      () => f.service.writeCalendarDataSafe({ entries: [{ id: 'bad', title: 'Bad', linkedTaskId: {} }] }),
      () => f.service.syncCalendarWithCronEvidence({ jobs: [{ id: 'one', scheduler: 'openclaw', name: 'n'.repeat(100000) }], operationsSource: { schedulers: { openclaw: { sourceSucceeded: true } } } }),
    ]) {
      assert.throws(write, { status: 400 });
      assert.equal(fs.readFileSync(f.calendarFile, 'utf8'), before);
    }
  } finally { f.cleanup(); }
});

test('repair atomically backs up rejected rows, preserves file modes, and is idempotent', () => {
  const f = fixture();
  try {
    const kept = { id: 'same', title: 'First' };
    const duplicate = { id: 'same', title: 'Duplicate' };
    const invalid = { id: 'bad', title: 'Bad', linkedTaskId: 5 };
    fs.writeFileSync(f.calendarFile, JSON.stringify({ entries: [kept, duplicate, invalid, null] }), { mode: 0o600 });
    const repaired = f.service.repairCalendarData();
    assert.deepEqual(repaired.counts, { kept: 1, quarantined: 2, duplicates: 1 });
    assert.equal(repaired.repaired, true);
    assert.match(repaired.backupPath, /^~\//);
    assert.doesNotMatch(repaired.backupPath, new RegExp(os.homedir().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    const backup = path.resolve(f.homeDir, repaired.backupPath.slice(2));
    assert.equal(path.dirname(backup), path.dirname(f.calendarFile));
    const data = JSON.parse(fs.readFileSync(backup, 'utf8'));
    assert.deepEqual(data.quarantined, [invalid, null]);
    assert.deepEqual(data.duplicates, [duplicate]);
    assert.equal(fs.statSync(backup).mode & 0o777, 0o600);
    assert.equal(fs.statSync(f.calendarFile).mode & 0o777, 0o600);
    const after = fs.readFileSync(f.calendarFile, 'utf8');
    assert.equal(f.service.readCalendarDataSafe({ strict: true }).entries[0].title, 'First');
    const files = fs.readdirSync(f.homeDir).sort();
    const again = f.service.repairCalendarData();
    assert.equal(again.repaired, false);
    assert.equal(again.backupPath, null);
    assert.equal(fs.readFileSync(f.calendarFile, 'utf8'), after);
    assert.deepEqual(fs.readdirSync(f.homeDir).sort(), files);
    f.service.createCalendarEntry({ title: 'No longer trapped' });
  } finally { f.cleanup(); }
});

test('repair refuses an unparseable file and never creates a backup', () => {
  const f = fixture();
  try {
    fs.writeFileSync(f.calendarFile, '{truncated');
    assert.throws(() => f.service.repairCalendarData(), { status: 409, code: 'calendar_unavailable' });
    assert.equal(fs.readFileSync(f.calendarFile, 'utf8'), '{truncated');
    assert.deepEqual(fs.readdirSync(f.homeDir), ['calendar.json']);
  } finally { f.cleanup(); }
});

test('repair backup failure and calendar-rename failure never lose original rows', () => {
  for (const stage of ['backup', 'calendar']) {
    let calendarFile;
    const fsImpl = new Proxy(fs, { get(target, key) {
      if (key === 'renameSync') return (from, to) => {
        if ((stage === 'backup' && to.includes('.repair-')) || (stage === 'calendar' && to === calendarFile)) throw new Error('injected rename failure');
        return target.renameSync(from, to);
      };
      return target[key];
    } });
    const f = fixture(fsImpl); calendarFile = f.calendarFile;
    try {
      const raw = '{"entries":[{"id":"good","title":"Good"},{"id":7}]}';
      fs.writeFileSync(calendarFile, raw);
      assert.throws(() => f.service.repairCalendarData(), { status: 503, code: 'calendar_repair_failed' });
      assert.equal(fs.readFileSync(calendarFile, 'utf8'), raw);
      assert.ok(fs.readdirSync(f.homeDir).every(name => !name.includes('.tmp-')));
      const backups = fs.readdirSync(f.homeDir).filter(name => name.includes('.repair-'));
      assert.equal(backups.length, stage === 'backup' ? 0 : 1);
    } finally { f.cleanup(); }
  }
});

test('calendar metadata advertises repair only for quarantined or duplicate rows', async () => {
  const f = fixture();
  try {
    f.service.fetchCronJobsForOperations = async () => ({ jobs: [], operationsSource: { schedulers: { openclaw: { sourceSucceeded: true } } } });
    const cron = createAutomationSource({ cronService: f.service });
    const calendar = createCalendarSource({ cronService: f.service, automationSource: cron });
    await cron.refresh();
    fs.writeFileSync(f.calendarFile, '{"entries":[{"id":"good","title":"Good"},{"id":7}]}');
    assert.equal((await calendar.refresh()).meta.repairAvailable, true);
    f.service.repairCalendarData();
    assert.equal((await calendar.refresh()).meta.repairAvailable, false);
    const router = buildCalendarRouter({ calendarService: f.service, calendarSource: calendar });
    assert.ok(router.stack.some(layer => layer.route?.path === '/api/calendar/repair' && layer.route.methods.post));
  } finally { f.cleanup(); }
});
