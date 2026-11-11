'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createCronService } = require('../server/services/cronData');
const { ENTRY_SCHEMA } = require('../server/services/calendarEntrySchema');
const { createHermesKanbanService } = require('../server/services/hermesKanbanData');
const { createExec } = require('../server/core/exec');
const { withLiveLoop } = require('./helpers/liveLoop');
const { createSource } = require('../server/core/source');
const { createOperationsReaders, createOperationsSources } = require('../server/services/operationsOverview');
const tick = () => new Promise(resolve => setImmediate(resolve));

const cron = () => createCronService({ getOpenclawDefaultModelKey: () => '' });
test('R5-1 kindless schedules distinguish intervals, parsed cron expressions and unknown text', () => {
  for (const [expr, kind, everyMs] of [
    ['every 30m', 'interval', 1800000], ['every 1.5h', 'interval', 5400000], ['every 0s', 'unknown', null],
    ['0 * * * *', 'cron', null], ['*/5 9-17 * JAN,MAR MON-FRI', 'cron', null],
    ['0 0 9 * * MON', 'cron', null], ['61 * * * *', 'unknown', null],
    ['*/0 * * * *', 'unknown', null], ['1 2 3 4 5 6 7', 'unknown', null],
    ['not a cron expression here', 'unknown', null], ['daily-ish', 'unknown', null],
  ]) {
    const job = cron().mapCronJobForApi({ id: 'job', schedule: { expr } });
    assert.equal(job.scheduleKind, kind, expr); assert.equal(job.everyMs, everyMs, expr);
    assert.equal(job.schedule, expr);
  }
});
test('R5-2 calendar normalisation preserves every schema-accepted schedule kind', () => {
  for (const scheduleKind of ENTRY_SCHEMA.scheduleKind.values) {
    assert.equal(cron().normalizeCalendarEntry({ id: 'entry', title: 'Entry', scheduleKind }).scheduleKind, scheduleKind);
  }
});

function fakeProcess() {
  const calls = [];
  let active = 0, peak = 0, auto = true;
  function execFileImpl(bin, args, options, callback) {
    active++; peak = Math.max(peak, active);
    const call = { bin, args, options, done: false, finish(error) {
      if (call.done) return; call.done = true; active--;
      callback(error, JSON.stringify(args.includes('stats') ? { total: 0 } : []), '');
    } };
    calls.push(call);
    if (auto) setImmediate(() => call.finish(null));
    return { pid: 10000 + calls.length, kill(signal) { call.signal = signal; call.finish(Object.assign(new Error('killed'), { signal })); } };
  }
  return { execFileImpl, calls, stop: () => { auto = false; }, stats: () => ({ active, peak }) };
}
function kanban(runner, extra = {}) {
  return createHermesKanbanService({ runner, processEnv: { HOME: '/unused', HERMES_BIN: 'fake-hermes', HERMES_PROFILE: 'test' },
    // RED safety: the unfixed service ignores runner; never spawn a real CLI.
    execFilePromise: async () => { throw new Error('legacy bypass was used'); }, ...extra });
}

test('K1 Kanban uses argv, profile env, timeout and single-flight keys on the shared Hermes lane', async () => {
  const calls = [];
  const service = kanban({ run: async (bin, argv, options) => {
    calls.push({ bin, argv, options }); return { ok: true, stdout: JSON.stringify(argv.includes('stats') ? {} : []), stderr: '' };
  } });
  assert.equal((await service.getBoard()).ok, true); assert.equal(calls.length, 8);
  for (const call of calls) {
    assert.equal(call.bin, 'fake-hermes'); assert.deepEqual(call.argv.slice(0, 3), ['--profile', 'test', 'kanban']);
    assert.equal(call.options.lane, 'hermes'); assert.equal(call.options.timeoutMs, 15000);
    assert.equal(call.options.env.HERMES_PROFILE, 'test'); assert.equal(call.options.env.HOME, '/unused');
    assert.equal(typeof call.options.key, 'string'); assert.ok(call.options.key.length > 0);
  }
  assert.equal(new Set(calls.map(call => call.options.key)).size, 8);
});

test('K1 shared runner bounds multiple Kanban services to the Hermes lane concurrency', async () => withLiveLoop(async () => {
  const fake = fakeProcess(); const runner = createExec({ execFileImpl: fake.execFileImpl });
  try {
    await Promise.all(['A', 'B'].map(profile => kanban(runner, { maxConcurrency: 8, processEnv: { HERMES_BIN: 'fake-hermes', HERMES_PROFILE: profile, HOME: '/unused' } }).getBoard()));
    assert.equal(fake.calls.length, 16); assert.equal(fake.stats().peak, 2);
    assert.equal(runner.status().lanes.hermes.maxObservedRunning, 2);
  } finally { runner.killAll(); await runner.drain(200); }
}));

test('K1 identical Kanban reads share core single-flight children across service instances', async () => withLiveLoop(async () => {
  const fake = fakeProcess(); const runner = createExec({ execFileImpl: fake.execFileImpl });
  try {
    await Promise.all([kanban(runner).getBoard(), kanban(runner).getBoard()]);
    assert.equal(fake.calls.length, 8);
  } finally { runner.killAll(); await runner.drain(200); }
}));

test('K1 killAll and drain cover in-flight Kanban children and stop further scheduling', async () => withLiveLoop(async () => {
  const fake = fakeProcess(); fake.stop(); const runner = createExec({ execFileImpl: fake.execFileImpl });
  const service = kanban(runner); const pending = service.getBoard().then(value => value, error => error);
  try {
    await tick(); assert.equal(fake.calls.length, 2); assert.equal(runner.killAll(), 2);
    assert.equal(await runner.drain(200), true);
    const error = await pending; assert.equal(error.code, 'shutdown');
    assert.equal(fake.stats().active, 0); assert.equal(fake.calls.length, 2);
    assert.ok(fake.calls.every(call => call.signal === 'SIGTERM'));
  } finally { runner.killAll(); await runner.drain(200); await pending; }
}));

for (const code of ['lane_busy', 'lane_quarantined']) {
  test(`K1 ${code} is typed unavailable and keeps the last-good board through the source seam`, async () => {
    let failure = false;
    const service = kanban({ run: async (_bin, args) => failure
      ? { ok: false, stdout: 'unsafe upstream detail', stderr: 'unsafe', error: { code, message: 'unsafe upstream detail' } }
      : { ok: true, stdout: JSON.stringify(args.includes('stats') ? {} : []), stderr: '' } });
    const readers = createOperationsReaders({ hermesKanbanService: service });
    const source = createOperationsSources({ readers, createSource }).hermes.source;
    const good = await source.refresh(); assert.ok(good.data);
    failure = true;
    const cached = await service.getBoard();
    assert.equal(cached.unavailable, true); assert.equal(cached.error.code, code);
    assert.equal(cached.refreshedAt, good.data.refreshedAt);
    assert.equal(JSON.stringify(cached).includes('unsafe'), false);
    const failed = await source.refresh(); assert.deepEqual(failed.data, good.data);
    assert.equal(failed.meta.ok, false); assert.equal(failed.meta.stale, true);
    assert.equal(typeof failed.meta.error.code, 'string');
    const cold = kanban({ run: async () => ({ ok: false, error: { code, message: 'unsafe' } }) });
    await assert.rejects(cold.getBoard(), { code });
  });
}

test('R5-1 actual cron-table fallback preserves a kindless interval cadence', async () => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-table-cadence-'));
  const widths = [40, 20, 45, 12, 12, 12, 12, 12, 12];
  const line = fields => fields.map((value, i) => value.padEnd(widths[i])).join('');
  const table = line(['ID', 'Name', 'Schedule', 'Next', 'Last', 'Status', 'Target', 'Agent', 'Model']) + '\n'
    + line(['abcdef01-0000', 'Interval', 'every 30m', '-', '-', 'ok', 'isolated', 'main', '']);
  try {
    const service = createCronService({ homeDir, calendarFile: path.join(homeDir, 'calendar.json'), getOpenclawDefaultModelKey: () => '',
      openclawExec: async args => { if (args.includes('--json')) throw new Error('JSON unsupported'); return { stdout: table }; },
      fetchImpl: async () => { throw new Error('No network'); },
    });
    const evidence = await service.fetchCronJobsForOperations();
    assert.equal(evidence.operationsSource.schedulers.openclaw.provenance, 'openclaw-cron-cli-table');
    const mapped = service.mapCronJobForApi(evidence.jobs[0]);
    assert.equal(mapped.scheduleKind, 'interval'); assert.equal(mapped.everyMs, 1800000);
    const entry = service.syncCalendarWithCronEvidence(evidence).entries[0];
    assert.equal(entry.scheduleKind, 'interval'); assert.equal(entry.everyMs, 1800000);
  } finally { fs.rmSync(homeDir, { recursive: true, force: true }); }
});

test('K1 app wires Kanban refreshes to its injected runner without starting other sources', async () => withLiveLoop(async () => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const { createApp } = require('../server/app');
  const { loadConfig } = require('../server/core/config');
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-kanban-wiring-'));
  const registered = [];
  const calls = [];
  const runner = createExec({ execFileImpl(bin, args, options, callback) {
    calls.push({ bin, args, options }); setImmediate(() => callback(null, JSON.stringify(args.includes('stats') ? {} : []), ''));
    return { pid: 1000 + calls.length, kill() {} };
  } });
  let app;
  try {
    fs.writeFileSync(path.join(rootDir, 'mc-config.json'), '{"name":"Test"}');
    fs.writeFileSync(path.join(rootDir, 'package.json'), '{"version":"test"}');
    app = createApp({ config: loadConfig({ rootDir, homeDir: rootDir, env: { PORT: '0' } }), exec: runner,
      logger: { log() {}, warn() {}, error() {} },
      scheduler: { register: source => registered.push(source), start() {}, stop() {}, status: () => [] },
    });
    const source = registered.find(source => source.id === 'operations.hermes'); assert.ok(source);
    const board = await source.refresh(); assert.ok(board.data);
    assert.equal(calls.length, 8); assert.ok(calls.every(call => call.args[2] === 'kanban'));
    assert.equal(runner.status().lanes.hermes.completed, 8);
  } finally {
    app?.locals.runtime.dispose(); runner.killAll(); await runner.drain(200);
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
}));

test('K1 actual bounded Hermes lane rejects a busy Kanban refresh without losing cache', async () => withLiveLoop(async () => {
  const fake = fakeProcess(); const runner = createExec({ execFileImpl: fake.execFileImpl, lanes: { hermes: { maxQueue: 0 } } });
  const service = kanban(runner); const occupied = [];
  try {
    const good = await service.getBoard(); fake.stop();
    occupied.push(runner.run('fake-hermes', ['occupy-1'], { lane: 'hermes' }), runner.run('fake-hermes', ['occupy-2'], { lane: 'hermes' }));
    await tick();
    const board = await service.getBoard(); assert.equal(board.error.code, 'lane_busy'); assert.equal(board.unavailable, true);
    assert.equal(board.refreshedAt, good.refreshedAt); assert.equal(fake.stats().active, 2);
  } finally {
    fake.calls.filter(call => !call.done).forEach(call => call.finish(null)); await Promise.all(occupied);
    runner.killAll(); await runner.drain(200);
  }
}));

test('K1 actual quarantined Hermes lane rejects Kanban until the tracked child is verified gone', async () => withLiveLoop(async () => {
  const fake = fakeProcess(); let stuck = false, release;
  const runner = createExec({ killGraceMs: 5, quarantineRecheckMs: 5, execFileImpl: (...args) => {
    if (!stuck) return fake.execFileImpl(...args);
    release = () => args[3](null, '[]', ''); return { pid: 77, kill() {} };
  } });
  try {
    const service = kanban(runner); const good = await service.getBoard(); stuck = true;
    const timed = await runner.run('fake-hermes', ['stuck'], { lane: 'hermes', timeoutMs: 5 });
    assert.equal(timed.error.code, 'kill_unverified'); assert.equal(runner.status().lanes.hermes.quarantined, true);
    const cached = await service.getBoard(); assert.equal(cached.error.code, 'lane_quarantined');
    assert.equal(cached.refreshedAt, good.refreshedAt); assert.equal(cached.unavailable, true);
    assert.equal(await runner.drain(10), false);
  } finally { release?.(); runner.killAll(); assert.equal(await runner.drain(200), true); }
}));
