const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createCronService } = require('../server/services/cronData');
const { createCalendarSource } = require('../server/sources/openclaw/calendar');

function fixture() {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-refutation-'));
  const calendarFile = path.join(homeDir, 'calendar.json');
  const service = createCronService({ homeDir, calendarFile, now: () => Date.parse('2026-11-11T12:00:00Z'), getOpenclawDefaultModelKey: () => '' });
  return { service, calendarFile, homeDir, cleanup: () => fs.rmSync(homeDir, { recursive: true, force: true }) };
}
const evidence = jobs => ({ jobs, operationsSource: { schedulers: { openclaw: { sourceSucceeded: true } } } });
const good = { id: 'good', name: 'Good', schedule: { kind: 'cron', expr: '0 * * * *', tz: 'Europe/Istanbul', staggerMs: 0 } };

test('R4-1 real scheduler shapes preserve cron, Hermes interval and once cadence', () => {
  const f = fixture();
  try {
    // Structure-only copies of live Hermes and OpenClaw schedules, 2026-11-11.
    const shapes = [
      [{ kind: 'interval', minutes: 30, display: 'every 30m' }, 'every 30m', 'interval', 1800000, null],
      [{ kind: 'once', run_at: '2026-12-01T12:00:00Z', display: 'once at noon' }, 'once at noon', 'at', null, '2026-12-01T12:00:00.000Z'],
      [{ kind: 'cron', expr: '0 * * * *', display: 'hourly' }, '0 * * * *', 'cron', null, null],
      [good.schedule, '0 * * * *', 'cron', null, null],
      [{ kind: 'every', everyMs: 1800000, anchorMs: 1770000000000 }, 'every 30m', 'interval', 1800000, null],
    ];
    for (const [schedule, text, kind, everyMs, atIso] of shapes) {
      const job = { ...good, schedule };
      const mapped = f.service.mapCronJobForApi(job);
      const row = f.service.syncCalendarWithCronEvidence(evidence([job])).entries[0];
      for (const value of [mapped, row]) {
        assert.equal(value.schedule, text); assert.equal(value.scheduleKind, kind);
        assert.equal(value.everyMs, everyMs); assert.equal(value.atIso, atIso);
      }
    }
  } finally { f.cleanup(); }
});

test('R4-1 interval units, display-only cadence, at and unknown are explicit', () => {
  const f = fixture();
  try {
    for (const [schedule, expected] of [
      [{ kind: 'interval', seconds: 90 }, { schedule: 'every 90s', scheduleKind: 'interval', everyMs: 90000 }],
      [{ kind: 'interval', hours: 2 }, { schedule: 'every 2h', scheduleKind: 'interval', everyMs: 7200000 }],
      [{ kind: 'interval', display: 'every 45m' }, { schedule: 'every 45m', scheduleKind: 'interval', everyMs: 2700000 }],
      [{ kind: 'at', at: '2026-12-01T12:00:00Z' }, { schedule: '2026-12-01T12:00:00Z', scheduleKind: 'at', atIso: '2026-12-01T12:00:00.000Z' }],
      [{ kind: 'unexpected', display: 'upstream cadence' }, { schedule: 'upstream cadence', scheduleKind: 'unknown', everyMs: null }],
      [{ kind: 'every' }, { schedule: null, scheduleKind: 'unknown', everyMs: null }],
    ]) {
      const mapped = f.service.mapCronJobForApi({ ...good, schedule });
      for (const [key, value] of Object.entries(expected)) assert.equal(mapped[key], value);
    }
  } finally { f.cleanup(); }
});

test('R4-2 malformed upstream jobs are individually skipped with typed calendar metadata', async () => {
  const f = fixture();
  try {
    const invalid = [
      { id: 'blank', name: '' }, { id: 'numeric', name: 7 }, { id: 'long-name', name: 'n'.repeat(257) },
      { id: 'text', payload: { text: 7 } }, { id: 'expression', schedule: { kind: 'cron', expr: '*'.repeat(1025) } },
      { id: 'x'.repeat(257) }, { id: 'timestamp', state: { nextRunAtMs: 1e20 } },
    ];
    const ev = evidence([good, ...invalid]);
    const source = createCalendarSource({ cronService: f.service, automationSource: { snapshot: () => ({ data: { evidence: ev }, meta: { ageMs: 0 } }) } });
    const snap = await source.refresh();
    assert.ok(snap.data, 'valid rows remain available');
    assert.equal(snap.data.entries.length, 1); assert.equal(snap.data.entries[0].title, 'Good');
    assert.equal(snap.meta.upstream.count, invalid.length);
    assert.equal(snap.meta.upstream.ids.length, invalid.length);
    assert.ok(snap.meta.upstream.issues.every(issue => issue.code === 'calendar_upstream_entry_invalid' || issue.code === 'calendar_upstream_timestamp_invalid'));
    assert.equal(snap.meta.error.code, 'calendar_upstream_invalid');
    assert.equal(f.service.readCalendarDataSafe({ strict: true }).diagnostics.quarantined.count, 0);
    ev.jobs = [good];
    const recovered = await source.refresh();
    assert.equal(recovered.meta.upstream.count, 0); assert.equal(recovered.meta.ok, true);
  } finally { f.cleanup(); }
});

test('R4-2 upstream timestamp range and types never throw or fabricate dates', () => {
  const f = fixture();
  try {
    for (const value of [1e20, -1e20, Infinity, {}, [], true]) {
      const mapped = f.service.mapCronJobForApi({ ...good, state: { nextRunAtMs: value, lastRunAtMs: value } });
      assert.equal(mapped.nextRun, null); assert.equal(mapped.lastRun, null);
    }
  } finally { f.cleanup(); }
});

test('R4-3 repair refuses symlinks without replacing the link or changing its target', () => {
  const f = fixture();
  try {
    const target = path.join(f.homeDir, 'target.json'); const raw = '{"entries":[{"id":7}]}';
    fs.writeFileSync(target, raw); fs.symlinkSync(target, f.calendarFile);
    assert.throws(() => f.service.repairCalendarData(), { status: 409, code: 'calendar_symlink_unsupported' });
    assert.equal(fs.lstatSync(f.calendarFile).isSymbolicLink(), true); assert.equal(fs.readFileSync(target, 'utf8'), raw);
    assert.equal(fs.readdirSync(f.homeDir).length, 2);
  } finally { f.cleanup(); }
});

test('R4-3 repair keeps complete original bytes, private backups, bounded retention and safe outside-home paths', () => {
  const f = fixture();
  try {
    const homeDir = path.join(f.homeDir, 'home'); fs.mkdirSync(homeDir);
    const service = createCronService({ homeDir, calendarFile: f.calendarFile, getOpenclawDefaultModelKey: () => '' });
    const raw = '{\n "custom": {"keep":true}, "entries":[{"id":"ok","title":"Kept"},{"id":7}]\n}\n';
    for (let i = 0; i < 12; i++) {
      fs.writeFileSync(f.calendarFile, raw, { mode: 0o644 }); fs.chmodSync(f.calendarFile, 0o644);
      const result = service.repairCalendarData();
      assert.equal(result.backupPath.startsWith('~'), false);
      assert.equal(result.backupPath, path.join(path.basename(f.homeDir), path.basename(result.backupPath)));
      const backup = path.join(f.homeDir, path.basename(result.backupPath));
      assert.equal(fs.readFileSync(backup, 'utf8'), raw);
      assert.equal(fs.statSync(backup).mode & 0o777, 0o600);
      assert.equal(fs.statSync(f.calendarFile).mode & 0o777, 0o644);
      assert.deepEqual(JSON.parse(fs.readFileSync(f.calendarFile, 'utf8')).custom, { keep: true });
    }
    const backups = fs.readdirSync(f.homeDir).filter(name => name.includes('.repair-'));
    assert.equal(backups.length, 10);
    const before = fs.readdirSync(f.homeDir).sort();
    assert.equal(service.repairCalendarData().repaired, false); assert.deepEqual(fs.readdirSync(f.homeDir).sort(), before);
  } finally { f.cleanup(); }
});

for (const check of ['original', 'permissions', 'retention']) {
  test(`R4-3 repair ${check} counter-example`, () => {
    const f = fixture();
    try {
      const raw = '{ "extra":42, "entries":[{"id":7}] }\n';
      for (let i = 0; i < (check === 'retention' ? 12 : 1); i++) {
        fs.writeFileSync(f.calendarFile, raw, { mode: 0o644 });
        const result = f.service.repairCalendarData();
        const backup = path.resolve(f.homeDir, result.backupPath.slice(2));
        if (check === 'original') assert.equal(fs.readFileSync(backup, 'utf8'), raw);
        if (check === 'permissions') assert.equal(fs.statSync(backup).mode & 0o777, 0o600);
      }
      if (check === 'retention') assert.equal(fs.readdirSync(f.homeDir).filter(n => n.includes('.repair-')).length, 10);
    } finally { f.cleanup(); }
  });
}

test('R4-2 heartbeat timestamps outside the Date domain are discarded before merging', () => {
  const { mergeHeartbeatPayloads, heartbeatEventToPayload } = require('../server/services/statusData');
  assert.deepEqual(mergeHeartbeatPayloads({ lastHeartbeat: -1e20 }, {}), {});
  assert.deepEqual(heartbeatEventToPayload({ ts: -1e20 }), {});
});

test('R4-2 numeric/missing job identities and duplicate upstream IDs cannot poison valid sync', () => {
  const f = fixture();
  try {
    const jobs = [good, { id: 7, name: 'Numeric identity' }, null, {}, { ...good, name: 'Duplicate' }];
    const result = f.service.syncCalendarWithCronEvidence(evidence(jobs));
    assert.deepEqual(result.entries.map(row => row.title), ['Good']);
    assert.equal(result.upstream.count, 4);
    assert.equal(result.upstream.issues.at(-1).code, 'calendar_upstream_duplicate_id');
  } finally { f.cleanup(); }
});

test('R4-2 invalid replacements retain valid last-good rows without masking bad notes', () => {
  const f = fixture();
  try {
    const first = f.service.syncCalendarWithCronEvidence(evidence([good]));
    f.service.updateCalendarEntry(first.entries[0].id, { notes: 'User notes' });
    const result = f.service.syncCalendarWithCronEvidence(evidence([{ ...good, payload: { text: {} } }]));
    assert.equal(result.entries.length, 1); assert.equal(result.entries[0].notes, 'User notes');
    assert.equal(result.upstream.count, 1);
    assert.equal(f.service.readCalendarDataSafe({ strict: true }).diagnostics.quarantined.count, 0);
  } finally { f.cleanup(); }
});

test('R4-2 real reader to automation to calendar isolates malformed scheduler records', async () => {
  const { createAutomationSource } = require('../server/sources/openclaw/automations');
  const f = fixture();
  try {
    const service = createCronService({ homeDir: f.homeDir, calendarFile: f.calendarFile,
      getOpenclawDefaultModelKey: () => '',
      openclawExec: async () => ({ stdout: JSON.stringify({ jobs: [good, null] }) }),
      fetchImpl: async () => { throw new Error('No network'); } });
    const dir = path.join(f.homeDir, '.hermes/profiles/hmudur/cron'); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'jobs.json'), JSON.stringify({ jobs: [
      { id: 'hermes', name: 'Hermes', schedule: { kind: 'interval', minutes: 30, display: 'every 30m' } }, null,
    ] }));
    const automation = createAutomationSource({ cronService: service });
    const cron = await automation.refresh();
    assert.equal(cron.data.cron.schedulers.openclaw.sourceSucceeded, true);
    assert.equal(cron.data.cron.schedulers.hermes.sourceSucceeded, true);
    const calendar = await createCalendarSource({ cronService: service, automationSource: automation }).refresh();
    assert.deepEqual(calendar.data.entries.map(row => row.title).sort(), ['Good', 'Hermes']);
    assert.equal(calendar.meta.upstream.count, 2);
  } finally { f.cleanup(); }
});

test('R4-2 null payload text and string millisecond timestamps are invalid upstream data', () => {
  const f = fixture();
  try {
    for (const job of [{ ...good, payload: { text: null } }, { ...good, state: { nextRunAtMs: '2026-12-01' } }]) {
      const result = f.service.syncCalendarWithCronEvidence(evidence([job]));
      assert.equal(result.entries.length, 0); assert.equal(result.upstream.count, 1);
    }
  } finally { f.cleanup(); }
});

test('R4-3 backup preserves original bytes even when JSON decoding replaces an invalid UTF8 byte', () => {
  const f = fixture();
  try {
    const raw = Buffer.concat([Buffer.from('{"extra":"'), Buffer.from([255]), Buffer.from('","entries":[{"id":7}]}')]);
    fs.writeFileSync(f.calendarFile, raw);
    const result = f.service.repairCalendarData();
    assert.deepEqual(fs.readFileSync(path.resolve(f.homeDir, result.backupPath.slice(2))), raw);
  } finally { f.cleanup(); }
});
