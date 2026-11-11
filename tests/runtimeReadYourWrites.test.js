'use strict';
const test = require('node:test'); const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const { createApp } = require('../server/app'); const { loadConfig } = require('../server/core/config');
const { createCronService } = require('../server/services/cronData');
const { withLiveLoop } = require('./helpers/liveLoop');
const clone = value => structuredClone(value);
async function fixture() {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-runtime-ryw-'));
  const calendarFile = path.join(rootDir, 'data/calendar-entries.json');
  fs.mkdirSync(path.dirname(calendarFile), { recursive: true });
  fs.writeFileSync(path.join(rootDir, 'mc-config.json'), '{"name":"Test"}');
  fs.writeFileSync(path.join(rootDir, 'package.json'), '{"version":"test"}');
  const hermesFile = path.join(rootDir, '.hermes/profiles/hmudur/cron/jobs.json'); fs.mkdirSync(path.dirname(hermesFile), { recursive: true });
  fs.writeFileSync(hermesFile, JSON.stringify({ jobs: [{ id: 'h1', name: 'Hermes', enabled: true, schedule: { kind: 'interval', minutes: 30, display: 'every 30m' }, model: 'old', provider: 'local' }] }));
  let jobs = [{ id: 'one', name: 'One', enabled: true, schedule: { kind: 'cron', expr: '0 * * * *' }, payload: { kind: 'agentTurn', message: 'Task', model: 'old' }, state: { lastRunAtMs: Date.parse('2026-11-11T10:00:00Z'), lastStatus: 'ok' } }];
  const oldJobs = clone(jobs); const controls = { readFail: false, lag: false, refreshFail: false, reads: 0, mutations: 0, block: null, runStatus: 'ok', plainAck: false, calendarReadFail: false };
  const runner = { async run(_bin, args) {
    if (args[0] === '--profile') {
      const cmd = args[3], id = args[4];
      const doc = JSON.parse(fs.readFileSync(hermesFile, 'utf8')), job = doc.jobs.find(job => job.id === id);
      if (cmd === 'list') return controls.readFailAfterMutation && controls.mutations ? { ok: false, error: { code: 'fake_read' } } : { ok: true, stdout: 'Listed' };
      controls.mutations++;
      if (cmd === 'pause' || cmd === 'resume') { job.enabled = cmd === 'resume'; job.state = job.enabled ? 'scheduled' : 'paused'; }
      if (cmd === 'edit') for (const field of ['provider', 'model']) { const flag = args.find(arg => arg.startsWith('--' + field + '=')); if (flag) job[field] = flag.slice(field.length + 3); }
      fs.writeFileSync(hermesFile, JSON.stringify(doc)); return { ok: true, stdout: 'ok' };
    }
    if (args[0] !== 'cron') return { ok: false, error: { code: 'fake_disabled' } };
    if (args[1] === 'list') { controls.reads++; if (controls.block) { const block = controls.block; controls.block = null; const captured = clone(jobs); block.enter(); await block.gate; return { ok: true, stdout: JSON.stringify({ jobs: captured }) }; } return controls.readFail || (controls.readFailAfterMutation && controls.mutations) ? { ok: false, error: { code: 'fake_read' } } : { ok: true, stdout: JSON.stringify({ jobs: controls.lag ? oldJobs : jobs }) }; }
    controls.mutations++;
    const id = args[2], item = jobs.find(job => job.id === id);
    if (args[1] === 'enable' || args[1] === 'disable') item.enabled = args[1] === 'enable';
    if (args[1] === 'edit') { if (args.includes('--model')) item.payload.model = args[args.indexOf('--model') + 1]; if (args.includes('--thinking')) item.payload.thinking = args[args.indexOf('--thinking') + 1]; }
    if (args[1] === 'run') item.state = { ...item.state, lastRunAtMs: item.state.lastRunAtMs + 60000, lastStatus: controls.runStatus };
    if (args[1] === 'rm') jobs = jobs.filter(job => job.id !== id);
    let result = item || {};
    if (args[1] === 'add') { result = { id: 'new', sessionTarget: args[args.indexOf('--session') + 1], name: args[args.indexOf('--name') + 1], enabled: !args.includes('--disabled'), schedule: { kind: 'cron', expr: args[args.indexOf('--cron') + 1] }, payload: { kind: 'agentTurn', message: args[args.indexOf('--message') + 1], model: 'new-model' } }; jobs.push(result); }
    return { ok: true, stdout: controls.plainAck ? 'ok' : JSON.stringify(result), stderr: '' };
  }, killAll() {}, drain: async () => true, status: () => ({ lanes: {}, children: 0, quarantined: [] }) };
  const openclawExec = async args => { const result = await runner.run('fake', args); if (!result.ok) throw new Error('fake CLI unavailable'); return result; };
  const cronService = createCronService({ runner, homeDir: rootDir, calendarFile, getOpenclawDefaultModelKey: () => '', openclawExec, fetchImpl: async () => { throw new Error('No network'); } });
  const readCalendar = cronService.readCalendarDataSafe.bind(cronService);
  cronService.readCalendarDataSafe = options => { if (controls.calendarReadFail && options?.tolerateEntries) throw new Error('fake calendar read failure'); return readCalendar(options); };
  const registered = [];
  const app = createApp({ config: loadConfig({ rootDir, homeDir: rootDir, env: { PORT: '0' } }), exec: runner,
    fetch: async () => { throw new Error('No network'); }, logger: { log() {}, warn() {}, error() {} },
    scheduler: { register: source => registered.push(source), start() {}, stop() {}, status: () => [] },
    services: { cronService, usageService: { summary: () => ({ data: null, meta: {} }), costs: () => ({}), months: () => ({}), codexbar: () => ({}), dispose() {} } },
  });
  const automation = registered.find(source => source.id === 'openclaw.automations'), calendar = registered.find(source => source.id === 'openclaw.calendar');
  await automation.refresh(); await calendar.refresh();
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const port = server.address().port; app.locals.runtime.setBoundPort(port);
  async function request(method, url, body) {
    const text = body === undefined ? '' : JSON.stringify(body);
    return new Promise((resolve, reject) => { const req = http.request({ host: '127.0.0.1', port, path: url, method,
      headers: { Origin: `http://127.0.0.1:${port}`, 'X-MC-Request': '1', 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) } }, res => {
      let data = ''; res.on('data', chunk => { data += chunk; }); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(data) }));
    }); req.on('error', reject); req.end(text); });
  }
  return { request, controls, automation, calendar, operations: registered.find(source => source.id === 'operations.cron'), cronService, calendarFile, jobs: () => jobs,
    failRefresh(source) { source.refresh = async () => { throw new Error('fake post-write refresh'); }; },
    async cleanup() { app.locals.runtime.dispose(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); fs.rmSync(rootDir, { recursive: true, force: true }); } };
}
const run = fn => withLiveLoop(async () => { const f = await fixture(); try { await fn(f); } finally { await f.cleanup(); } });

test('RYW calendar create is immediately visible through app GET without a scheduler tick', () => run(async f => {
  const written = await f.request('POST', '/api/calendar', { title: 'Written now' }); assert.equal(written.status, 200);
  const read = await f.request('GET', '/api/calendar'); assert.ok(read.body.entries.some(entry => entry.id === written.body.entry.id));
  assert.ok(written.body.meta);
}));
test('RYW calendar patch immediately returns the updated snapshot', () => run(async f => {
  const created = await f.request('POST', '/api/calendar', { title: 'Before' }); await f.calendar.refresh();
  const updated = await f.request('PATCH', `/api/calendar/${created.body.entry.id}`, { title: 'After' }); assert.equal(updated.status, 200);
  const read = await f.request('GET', '/api/calendar'); assert.equal(read.body.entries.find(entry => entry.id === created.body.entry.id).title, 'After');
}));
for (const action of ['repair', 'sync-cron']) test(`RYW calendar ${action} publishes its resulting entries`, () => run(async f => {
  if (action === 'repair') fs.writeFileSync(f.calendarFile, JSON.stringify({ entries: [{ id: 'manual', title: 'Recovered' }, { id: 7 }] }));
  else f.jobs().push({ id: 'two', name: 'New cron', enabled: true, schedule: { kind: 'cron', expr: '0 * * * *' } });
  const written = await f.request('POST', `/api/calendar/${action}`, {}); assert.equal(written.status, 200);
  const read = await f.request('GET', '/api/calendar');
  assert.ok(read.body.entries.some(entry => action === 'repair' ? entry.id === 'manual' : entry.linkedJobId === 'openclaw:two'));
  assert.ok(Array.isArray(written.body.entries));
}));
const cronCases = [
  ['POST', '/api/cron/create', { job: { name: 'New', schedule: { kind: 'cron', expr: '0 * * * *' }, payload: { kind: 'agentTurn', message: 'Task' } } }, rows => rows.some(row => row.sourceId === 'new')],
  ['PATCH', '/api/cron/openclaw:one/model', { model: 'changed' }, rows => rows.find(row => row.sourceId === 'one').model === 'changed'],
  ['DELETE', '/api/cron/openclaw:one', {}, rows => !rows.some(row => row.sourceId === 'one')],
  ['POST', '/api/cron/openclaw:one/toggle', { enabled: false }, rows => rows.find(row => row.sourceId === 'one').enabled === false],
  ['POST', '/api/cron/openclaw:one/run', {}, rows => rows.find(row => row.sourceId === 'one').lastRun === '2026-11-11T10:01:00.000Z'],
  ['POST', '/api/cron/hermes:h1/toggle', { enabled: false }, rows => rows.find(row => row.sourceId === 'h1').enabled === false],
  ['PATCH', '/api/cron/hermes:h1/model', { model: 'local/changed' }, rows => rows.find(row => row.sourceId === 'h1').model === 'local/changed'],
];
for (const [method, url, body, matches] of cronCases) test(`RYW ${method} ${url} is immediately visible`, () => run(async f => {
  const written = await f.request(method, url, body); assert.equal(written.status, 200);
  const read = await f.request('GET', '/api/cron'); assert.ok(matches(read.body.jobs), JSON.stringify(read.body.jobs.map(row => ({ id: row.id, enabled: row.enabled, model: row.model, lastRun: row.lastRun }))));
  assert.ok(written.body.job); assert.ok(written.body.meta);
}));
test('RYW successful calendar write survives failed post-write refresh with a visible entity and stale meta', () => run(async f => {
  f.failRefresh(f.calendar);
  const written = await f.request('POST', '/api/calendar', { title: 'Committed' }); assert.equal(written.status, 200);
  assert.equal(written.body.meta.stale, true);
  const read = await f.request('GET', '/api/calendar'); assert.ok(read.body.entries.some(entry => entry.id === written.body.entry.id));
}));
test('RYW lagging observed state is rejected rather than published as committed', () => run(async f => {
  f.controls.lag = true;
  const written = await f.request('POST', '/api/cron/openclaw:one/toggle', { enabled: false });
  assert.equal(written.status, 409); assert.equal(written.body.error.code, 'upstream_rejected');
  assert.equal((await f.request('GET', '/api/cron')).body.jobs.find(job => job.sourceId === 'one').enabled, true);
  await f.automation.refresh();
  assert.equal((await f.request('GET', '/api/cron')).body.jobs.find(job => job.sourceId === 'one').enabled, true);
}));
test('RYW run-now never regresses lastRun to an older scheduler reading', () => run(async f => {
  const before = (await f.request('GET', '/api/cron')).body.jobs.find(job => job.sourceId === 'one').lastRun;
  f.jobs()[0].state.lastRunAtMs -= 600000;
  f.controls.lag = false;
  const written = await f.request('POST', '/api/cron/openclaw:one/run', {}); assert.equal(written.status, 200);
  await f.automation.refresh();
  const current = (await f.request('GET', '/api/cron')).body.jobs.find(job => job.sourceId === 'one');
  assert.ok(Date.parse(current.lastRun) >= Date.parse(before));
}));

test('RYW sequential rejected edits never accumulate requested fields', () => run(async f => {
  f.controls.lag = true;
  await f.request('POST', '/api/cron/openclaw:one/toggle', { enabled: false });
  await f.request('PATCH', '/api/cron/openclaw:one/model', { model: 'changed' });
  const actual = (await f.request('GET', '/api/cron')).body.jobs.find(job => job.sourceId === 'one');
  assert.equal(actual.enabled, true); assert.equal(actual.model, 'old');
}));

for (const [method, url, body] of cronCases) test(`RYW failed verification after ${method} ${url} stays unverified and keeps observed state`, () => run(async f => {
  const prior = (await f.request('GET', '/api/cron')).body.jobs.map(({ verified, ...job }) => job);
  f.controls.readFailAfterMutation = true;
  const written = await f.request(method, url, body);
  assert.equal(written.status, 200); assert.equal(written.body.meta.stale, true);
  assert.equal(written.body.verified, false); assert.equal(written.body.job.verified, false);
  assert.deepEqual((await f.request('GET', '/api/cron')).body.jobs.map(({ verified, ...job }) => job), prior);
}));
for (const action of ['patch', 'repair', 'sync-cron']) test(`RYW calendar ${action} survives failed confirmation`, () => run(async f => {
  let url = '/api/calendar/' + action, method = 'POST', body = {};
  if (action === 'patch') {
    const created = await f.request('POST', '/api/calendar', { title: 'Before failure' });
    url = '/api/calendar/' + created.body.entry.id; method = 'PATCH'; body = { title: 'After failure' };
  } else if (action === 'repair') fs.writeFileSync(f.calendarFile, JSON.stringify({ entries: [{ id: 'kept', title: 'Kept' }, { id: 7 }] }));
  else f.jobs().push({ id: 'two', name: 'Two', enabled: true, schedule: { kind: 'cron', expr: '0 * * * *' } });
  f.failRefresh(f.calendar);
  const written = await f.request(method, url, body); assert.equal(written.status, 200); assert.equal(written.body.meta.stale, true);
  const read = (await f.request('GET', '/api/calendar')).body;
  assert.ok(read.entries.some(entry => action === 'patch' ? entry.title === 'After failure' : action === 'repair' ? entry.id === 'kept' : entry.linkedJobId === 'openclaw:two'));
  if (action === 'repair') assert.equal(read.meta.repairAvailable, false);
}));
test('RYW cron mutations update derived calendar and operations snapshots too', () => run(async f => {
  f.controls.lag = true;
  await f.request('POST', '/api/cron/openclaw:one/toggle', { enabled: false });
  const calendar = (await f.request('GET', '/api/calendar')).body;
  assert.equal(f.operations.snapshot().data.jobs.find(job => job.sourceId === 'one').enabled, true);
  assert.equal(calendar.entries.find(entry => entry.linkedJobId === 'openclaw:one').status, 'active');
}));
test('RYW post-write confirmation retires projections so later scheduler changes remain visible', () => run(async f => {
  f.controls.lag = true;
  await f.request('POST', '/api/cron/openclaw:one/toggle', { enabled: false });
  f.controls.lag = false; await f.automation.refresh();
  f.jobs()[0].enabled = true; await f.automation.refresh();
  assert.equal((await f.request('GET', '/api/cron')).body.jobs.find(job => job.sourceId === 'one').enabled, true);
}));


test('RYW a pre-write in-flight scheduler read cannot overwrite the committed toggle', () => run(async f => {
  let release, enter;
  const gate = new Promise(resolve => { release = resolve; });
  const entered = new Promise(resolve => { enter = resolve; });
  f.controls.block = { gate, enter };
  const oldRefresh = f.automation.refresh();
  let write;
  try {
    await entered;
    write = f.request('POST', '/api/cron/openclaw:one/toggle', { enabled: false });
    for (let i = 0; !f.controls.mutations && i < 100; i++) await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.controls.mutations, 1);
    release();
    assert.equal((await write).status, 200); await oldRefresh;
    const job = (await f.request('GET', '/api/cron')).body.jobs.find(row => row.sourceId === 'one');
    assert.equal(job.enabled, false);
  } finally { release(); await oldRefresh; if (write) await write; }
}));

for (const action of ['repair', 'sync-cron']) test(`RYW a newer patch supersedes an unconfirmed ${action} document`, () => run(async f => {
  const created = await f.request('POST', '/api/calendar', { title: 'Old document title' });
  if (action === 'repair') {
    const data = JSON.parse(fs.readFileSync(f.calendarFile, 'utf8')); data.entries.push({ id: 7 }); fs.writeFileSync(f.calendarFile, JSON.stringify(data));
  }
  const refresh = f.calendar.refresh; f.failRefresh(f.calendar);
  assert.equal((await f.request('POST', '/api/calendar/' + action, {})).status, 200);
  f.calendar.refresh = refresh;
  assert.equal((await f.request('PATCH', '/api/calendar/' + created.body.entry.id, { title: 'Newer patch title' })).status, 200);
  const row = (await f.request('GET', '/api/calendar')).body.entries.find(entry => entry.id === created.body.entry.id);
  assert.equal(row.title, 'Newer patch title');
}));


test('RYW pause and resume preserve an observed failed last run with plain CLI acknowledgments', () => run(async f => {
  f.controls.runStatus = 'failed';
  assert.equal((await f.request('POST', '/api/cron/openclaw:one/run', {})).status, 200);
  f.controls.plainAck = true;
  await f.request('POST', '/api/cron/openclaw:one/toggle', { enabled: false });
  await f.request('POST', '/api/cron/openclaw:one/toggle', { enabled: true });
  const payload = (await f.request('GET', '/api/cron')).body;
  assert.equal(payload.jobs.find(job => job.sourceId === 'one').status, 'failed');
  assert.equal(payload.summary.failed, 1);
}));


test('RYW calendar sync retains changed scheduler fields when refresh resolves with last-good data', () => run(async f => {
  f.jobs()[0].name = 'Scheduler changed'; f.jobs()[0].state.lastStatus = 'failed';
  f.controls.calendarReadFail = true;
  const written = await f.request('POST', '/api/calendar/sync-cron', {}); assert.equal(written.status, 200);
  assert.equal(written.body.meta.stale, true);
  const entry = (await f.request('GET', '/api/calendar')).body.entries.find(row => row.linkedJobId === 'openclaw:one');
  assert.equal(entry.title, 'Scheduler changed'); assert.equal(entry.status, 'failed');
}));
