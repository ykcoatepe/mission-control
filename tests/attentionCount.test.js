// One "needs the operator" number for the shell: /api/signals attention.count
// and /api/loops totals.needsOperator come from the same function and agree,
// restricted (Argus) projects included by their counts only. Also the
// per-system reason in /api/signals. Fake exec only.

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { createMloopSource } = require('../server/sources/mloop');
const { needsOperator } = require('../server/sources/mloop/attention');
const { buildLoopsRouter } = require('../server/routes/loops');
const { buildSignalsRouter } = require('../server/routes/signals');
const { errorHandler } = require('../server/core/http');

const NOW = Date.parse('2026-11-11T10:00:00Z');
const SECRET = 'ARGUS-SECRET';

function ok(body) {
  return { ok: true, code: 0, stdout: JSON.stringify(body), stderr: '', timedOut: false };
}

function loopsSourceFor({ checkRows, teyit = [] }) {
  const projects = [...new Set(checkRows.map((row) => row.project))];
  const exec = {
    async run(file, args) {
      if (args[0] === 'check') return ok(checkRows);
      const [, project, , command] = args;
      if (command === 'status') return ok(`# ${project}\nOutcome: keep ${project} going\n`);
      if (command === 'teyit') return ok(teyit.filter((row) => row.project === project));
      if (command === 'participants') return ok([]);
      throw new Error(`unexpected ${args.join(' ')}`);
    },
  };
  const fsImpl = {
    async readdir() { return projects.map((name) => ({ name, isDirectory: () => true })); },
    async stat() { return { isFile: () => true, mtimeMs: NOW }; },
  };
  return createMloopSource({ exec, fsImpl, ledgerDir: '/fake', bin: '/fake/mloop', now: () => NOW });
}

function overviewWith(attention = [], systems = {}) {
  const system = (id, extra = {}) => ({ id, state: 'healthy', observedAt: '2026-11-11T09:59:00.000Z', caveats: [], detailHref: id === 'gbrain' ? '/' : '/services', ...extra });
  return {
    async getOverview() {
      return {
        systems: { gbrain: system('gbrain'), hermes: system('hermes'), openclaw: system('openclaw'), ...systems },
        attention,
        meta: { ok: true, stale: false, observedAt: '2026-11-11T09:59:00.000Z', ageMs: 0, error: null, latencyMs: null, source: 'operations.overview' },
      };
    },
  };
}

const empty = { snapshot: () => ({ data: null, meta: { ok: false, stale: true, observedAt: null, ageMs: null, error: null, latencyMs: null, source: 'x' } }) };

async function both({ loopsSource, overview }) {
  const app = express();
  app.use(buildLoopsRouter({ loopsSource, operationsOverviewService: overview, now: () => NOW }));
  app.use(buildSignalsRouter({
    operationsOverviewService: overview, loopsSource, launchdSource: empty, reachabilitySource: empty, now: () => NOW,
  }));
  app.use(errorHandler({ logger: { error() {} } }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const loops = await (await fetch(`${base}/api/loops`)).json();
    const signals = await (await fetch(`${base}/api/signals`)).json();
    return { loops, signals };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const SYSTEM_ITEMS = [
  { id: 'hermes:gateway-down', system: 'hermes', severity: 'critical', reasonCode: 'hermes_gateway_down', title: 'Hermes gateway is down' },
  { id: 'gbrain:unavailable', system: 'gbrain', severity: 'unavailable', reasonCode: 'gbrain_unavailable', title: 'GBrain evidence unavailable' },
];

const FIXTURES = [
  {
    name: 'systems + findings + overdue + restricted',
    checkRows: [
      { project: 'alpha', code: 'TEYIT_STALE', subject: 'TEYIT_STALE', severity: 'warning', detail: 'count=2', ts: '2026-11-10T00:00:00Z', count: 2 },
      { project: 'alpha', code: 'BINDING_DEAD', subject: 'w1', severity: 'warning', detail: 'silent', ts: '2026-11-10T00:00:00Z' },
      { project: 'alpha', code: 'TEYIT_DUE', subject: 'T9', severity: 'info', detail: 'due soon', ts: '2026-11-10T00:00:00Z' },
      { project: 'beta', code: 'ESCALATED_ROUNDS', subject: 'P1', severity: 'error', detail: 'cap', ts: '2026-11-10T00:00:00Z' },
      { project: 'argus-live', code: 'TEYIT_STALE', subject: `${SECRET}-a`, severity: 'error', detail: `${SECRET}`, ts: '2026-11-10T00:00:00Z', count: 3 },
      { project: 'argus-live', code: 'BINDING_DEAD', subject: `${SECRET}-b`, severity: 'warning', detail: `${SECRET}`, ts: '2026-11-10T00:00:00Z' },
      { project: 'argus-live', code: 'TEYIT_DUE', subject: `${SECRET}-c`, severity: 'info', detail: `${SECRET}`, ts: '2026-11-10T00:00:00Z' },
    ],
    teyit: [
      { project: 'alpha', id: 'T1', unit: 'u1', how: 'h', deadline: '2026-11-09T00:00:00Z', state: 'open', closed: false },
      { project: 'alpha', id: 'T2', unit: 'u2', how: 'h', deadline: '2026-11-08T00:00:00Z', state: 'open', closed: false },
      { project: 'alpha', id: 'T3', unit: 'u3', how: 'h', deadline: '2026-12-01T00:00:00Z', state: 'open', closed: false },
    ],
    attention: SYSTEM_ITEMS,
    systems: { hermes: { id: 'hermes', state: 'critical', observedAt: null, caveats: [], detailHref: '/services' }, gbrain: { id: 'gbrain', state: 'unavailable', observedAt: null, caveats: [], detailHref: '/' } },
    // systems 1 (hermes critical; an unavailable reading is not counted, its
    // 2 reasons are systemReasons, outside the count); findings: alpha BINDING_DEAD + beta ESCALATED_ROUNDS (TEYIT_STALE is
    // the overdue confirmations, info is not operator work); overdue 2; restricted
    // argus: 1 finding + 3 overdue.
    expected: { count: 9, worst: 'critical', breakdown: { systems: 1, systemReasons: 2, findings: 2, overdueConfirmations: 2, restricted: 4 }, partial: false, missing: [] },
  },
  {
    name: 'restricted only',
    checkRows: [
      { project: 'argus-live', code: 'BINDING_DEAD', subject: `${SECRET}-b`, severity: 'warning', detail: `${SECRET}`, ts: '2026-11-10T00:00:00Z' },
      { project: 'argus-live', code: 'DEPLOYED_UNCONFIRMED', subject: 'P2', severity: 'warning', detail: `${SECRET}`, ts: '2026-11-10T00:00:00Z' },
    ],
    attention: [],
    expected: { count: 2, worst: 'warning', breakdown: { systems: 0, systemReasons: 0, findings: 0, overdueConfirmations: 0, restricted: 2 }, partial: false, missing: [] },
  },
  {
    name: 'nothing needs the operator',
    checkRows: [{ project: 'quiet', code: 'TEYIT_DUE', subject: 'T1', severity: 'info', detail: 'due', ts: '2026-11-10T00:00:00Z' }],
    attention: [],
    expected: { count: 0, worst: 'healthy', breakdown: { systems: 0, systemReasons: 0, findings: 0, overdueConfirmations: 0, restricted: 0 }, partial: false, missing: [] },
  },
];

for (const fixture of FIXTURES) {
  test(`one needs-operator number on /api/signals and /api/loops: ${fixture.name}`, async () => {
    const loopsSource = loopsSourceFor(fixture);
    await loopsSource.refresh();
    const { loops, signals } = await both({ loopsSource, overview: overviewWith(fixture.attention, fixture.systems) });
    assert.deepEqual(signals.data.attention, fixture.expected);
    assert.deepEqual(loops.data.totals.needsOperator, fixture.expected);
    assert.equal(signals.data.attention.count, loops.data.totals.needsOperator.count);
    assert.doesNotMatch(JSON.stringify(loops) + JSON.stringify(signals), new RegExp(SECRET));
  });
}

test('without a loop reading the number is partial: unknown parts are null, never zero', async () => {
  const { signals } = await both({ loopsSource: empty, overview: overviewWith(SYSTEM_ITEMS, FIXTURES[0].systems) });
  assert.deepEqual(signals.data.attention, {
    count: 1,
    worst: 'critical',
    breakdown: { systems: 1, systemReasons: 2, findings: null, overdueConfirmations: null, restricted: null },
    partial: true,
    missing: ['findings', 'overdueConfirmations', 'restricted'],
  });
});

test('signals give each non-healthy system a scrubbed reason and its detail link', async () => {
  const overview = overviewWith([
    { id: 'openclaw:heartbeat-stale', system: 'openclaw', severity: 'warning', reasonCode: 'openclaw_heartbeat_stale', title: 'OpenClaw heartbeat needs fresh proof' },
  ], {
    openclaw: {
      id: 'openclaw',
      state: 'warning',
      observedAt: '2026-11-11T09:59:00.000Z',
      caveats: ['Heartbeat proof is stale; see /Users/alice/.openclaw/heartbeat.json'],
      detailHref: '/services',
    },
    gbrain: { id: 'gbrain', state: 'unavailable', observedAt: null, caveats: [], detailHref: '/' },
  });
  const { signals } = await both({ loopsSource: empty, overview });
  assert.deepEqual(signals.data.systems.openclaw, {
    state: 'warning',
    observedAt: '2026-11-11T09:59:00.000Z',
    reason: 'Heartbeat proof is stale; see ~/.openclaw/heartbeat.json',
    detailHref: '/services',
  });
  // No caveat: the first attention item for the system, else a plain fallback.
  assert.equal(signals.data.systems.gbrain.reason, 'GBrain evidence is unavailable.');
  assert.equal(signals.data.systems.gbrain.detailHref, '/');
  assert.equal(signals.data.systems.hermes.reason, null);
  assert.equal(signals.data.systems.hermes.detailHref, '/services');
});

// --- review fix round 1: missing and overlapping evidence -----------------

function openProject(id, { findings = [], pendingConfirmations = [] } = {}) {
  return { id, restricted: false, findings, pendingConfirmations };
}

test('reproduced: a failed confirmation reading plus TEYIT_STALE is never a complete 0', async () => {
  // Through the source: the unreadable confirmations fail closed (counts
  // only) and the check's TEYIT_STALE is still one known overdue item.
  const checkRows = [{ project: 'alpha', code: 'TEYIT_STALE', subject: 'T1', severity: 'warning', detail: 'stale', ts: '2026-11-10T00:00:00Z' }];
  const exec = {
    async run(file, args) {
      if (args[0] === 'check') return ok(checkRows);
      if (args[3] === 'teyit') return { ok: false, code: 2, stdout: '', stderr: '{"code":"LEDGER_LOCKED","message":"busy"}', timedOut: false };
      if (args[3] === 'status') return ok('# alpha\n');
      return ok([]);
    },
  };
  const fsImpl = { async readdir() { return [{ name: 'alpha', isDirectory: () => true }]; }, async stat() { return { isFile: () => true, mtimeMs: NOW }; } };
  const loopsSource = createMloopSource({ exec, fsImpl, ledgerDir: '/fake', bin: '/fake/mloop', now: () => NOW });
  await loopsSource.refresh();
  const { loops, signals } = await both({ loopsSource, overview: overviewWith([]) });
  assert.deepEqual(signals.data.attention, {
    count: 1, worst: 'warning', breakdown: { systems: 0, systemReasons: 0, findings: 0, overdueConfirmations: 0, restricted: 1 }, partial: false, missing: [],
  });
  assert.deepEqual(loops.data.totals.needsOperator, signals.data.attention);

  // Directly: an unread confirmation list is unknown, never 0.
  const direct = needsOperator({
    systems: [],
    systemsAttention: [],
    loops: { projects: [openProject('alpha', { findings: [{ code: 'TEYIT_STALE', subject: 'T1', severity: 'warning' }], pendingConfirmations: null })] },
  });
  assert.equal(direct.breakdown.overdueConfirmations, null);
  assert.equal(direct.partial, true);
  assert.deepEqual(direct.missing, ['overdueConfirmations']);
});

test('reproduced: a TEYIT_UNRESOLVED finding and an overdue confirmation with the same id count once', () => {
  const result = needsOperator({
    systems: [],
    systemsAttention: [],
    loops: {
      projects: [openProject('alpha', {
        findings: [
          { code: 'TEYIT_UNRESOLVED', subject: 'T1', severity: 'warning' },
          { code: 'TEYIT_STALE', subject: 'T1', severity: 'warning' },
          { code: 'TEYIT_KEEP_KILL', subject: 'T1', severity: 'warning' },
        ],
        pendingConfirmations: [{ id: 'T1', overdue: true }],
      })],
    },
  });
  assert.deepEqual(result, {
    count: 1, worst: 'warning', breakdown: { systems: 0, systemReasons: 0, findings: 0, overdueConfirmations: 1, restricted: 0 }, partial: false, missing: [],
  });
});

test('an aggregated TEYIT_STALE row overlaps the known confirmation ids instead of adding to them', () => {
  const result = needsOperator({
    systemsAttention: null,
    loops: {
      projects: [openProject('alpha', {
        findings: [{ code: 'TEYIT_STALE', subject: 'TEYIT_STALE', severity: 'warning', count: 3 }],
        pendingConfirmations: [{ id: 'T1', overdue: true }, { id: 'T2', overdue: true }, { id: 'T3', overdue: true }, { id: 'T4', overdue: false }],
      })],
    },
  });
  assert.equal(result.breakdown.overdueConfirmations, 3);
  assert.deepEqual(result.missing, ['systems']);
});

test('unread parts are null and listed; a missing restricted count is null; nothing read is null', () => {
  assert.equal(needsOperator({ systemsAttention: null, loops: null }), null);
  assert.equal(needsOperator(), null);
  const restricted = needsOperator({
    systems: [{ id: 'hermes', state: 'warning' }, { id: 'gbrain', state: 'unavailable' }],
    systemsAttention: [{ severity: 'warning' }],
    loops: { projects: [{ id: 'argus-x', restricted: true, operatorFindings: 2 }] },
  });
  assert.deepEqual(restricted, {
    count: 1, worst: 'warning', breakdown: { systems: 1, systemReasons: 1, findings: 0, overdueConfirmations: 0, restricted: null }, partial: true, missing: ['restricted'],
  });
  const unreadFindings = needsOperator({ systems: [], systemsAttention: [], loops: { projects: [{ id: 'p', restricted: false, findings: null, pendingConfirmations: [] }] } });
  assert.equal(unreadFindings.breakdown.findings, null);
  assert.equal(unreadFindings.breakdown.overdueConfirmations, null, 'confirmation findings are unknown too');
  assert.equal(unreadFindings.partial, true);
});

// --- one system is one item; a refresh does not move the number ------------

function gbrainReasons(n, severity = 'warning') {
  return Array.from({ length: n }, (_, i) => ({
    id: `gbrain:caveat:${i}`, system: 'gbrain', severity, reasonCode: 'gbrain_active_caveat', title: 'GBrain requires attention', detail: `probe ${i} evidence is stale.`,
  }));
}

function sourceMetas(gbrain) {
  const fresh = { ok: true, stale: false, observedAt: '2026-11-11T09:59:00.000Z', ageMs: 1000, error: null, latencyMs: 5 };
  return { status: fresh, sessions: fresh, cron: fresh, hermes: fresh, hermesGateway: fresh, gbrain: { ...fresh, ...gbrain } };
}

// A mutable overview service: each call returns the current reading.
function overviewSequence() {
  let current = null;
  return {
    set(reading) { current = reading; },
    async getOverview() {
      const system = (id, state = 'healthy') => ({ id, state, observedAt: '2026-11-11T09:59:00.000Z', caveats: [], detailHref: id === 'gbrain' ? '/' : '/services' });
      return {
        systems: { gbrain: system('gbrain', current.gbrain), hermes: system('hermes', current.hermes || 'healthy'), openclaw: system('openclaw') },
        attention: current.attention,
        meta: { ok: true, stale: Boolean(current.meta.stale), observedAt: '2026-11-11T09:59:00.000Z', ageMs: 0, error: null, latencyMs: null, source: 'operations.overview', sources: sourceMetas(current.meta) },
      };
    },
  };
}

test('reproduced spike: one system with 30 reasons contributes 1, the reasons are reported apart', async () => {
  const loopsSource = loopsSourceFor(FIXTURES[2]);
  await loopsSource.refresh();
  const overview = overviewWith(gbrainReasons(30), { gbrain: { id: 'gbrain', state: 'warning', observedAt: null, caveats: [], detailHref: '/' } });
  const { loops, signals } = await both({ loopsSource, overview });
  assert.deepEqual(signals.data.attention, {
    count: 1, worst: 'warning', breakdown: { systems: 1, systemReasons: 30, findings: 0, overdueConfirmations: 0, restricted: 0 }, partial: false, missing: [],
  });
  assert.deepEqual(loops.data.totals.needsOperator, signals.data.attention);
});

test('a GBrain refresh in progress does not move the number; a finished reading does', async () => {
  const loopsSource = loopsSourceFor(FIXTURES[0]);
  await loopsSource.refresh();
  const overview = overviewSequence();
  // Settled and healthy.
  overview.set({ gbrain: 'healthy', attention: [], meta: { stale: false } });
  const before = (await both({ loopsSource, overview })).signals.data.attention;
  // After an action every probe is marked stale until a fresh pass lands:
  // 30 transient reasons, no error. The last good state is held.
  overview.set({ gbrain: 'warning', attention: gbrainReasons(30), meta: { stale: true } });
  const during = await both({ loopsSource, overview });
  assert.equal(during.signals.data.attention.count, before.count, 'the headline moved during a refresh');
  assert.equal(during.signals.data.attention.breakdown.systems, before.breakdown.systems);
  assert.equal(during.signals.data.attention.breakdown.systemReasons, 30, 'the transient reasons stay visible apart');
  assert.deepEqual(during.loops.data.totals.needsOperator, during.signals.data.attention);
  // The refresh finished and GBrain really is warning: now it counts, once.
  overview.set({ gbrain: 'warning', attention: gbrainReasons(30), meta: { stale: false } });
  const after = (await both({ loopsSource, overview })).signals.data.attention;
  assert.equal(after.count, before.count + 1);
  // A failed read is not a refresh: its state is used as is.
  overview.set({ gbrain: 'healthy', attention: [], meta: { stale: false } });
  await both({ loopsSource, overview });
  overview.set({ gbrain: 'critical', attention: gbrainReasons(2, 'critical'), meta: { stale: true, ok: false, error: { code: 'gbrain_refresh_failed', message: 'x' } } });
  const failed = (await both({ loopsSource, overview })).signals.data.attention;
  assert.equal(failed.count, before.count + 1);
});

// --- review fix: the hold never lowers a state ------------------------------

// Overview readings with per-source metas and the items/evidence that name
// their sources (evidenceRefs), as buildOperationsOverview emits them.
function overviewReadings() {
  let current = null;
  const fresh = { ok: true, stale: false, observedAt: '2026-11-11T09:59:00.000Z', ageMs: 1000, error: null, latencyMs: 5 };
  const refreshing = { ...fresh, stale: true };
  const failed = { ...fresh, ok: false, stale: true, error: { code: 'x_read_failed', message: 'x could not be read' } };
  const metaOf = { fresh, refreshing, failed };
  return {
    set(reading) { current = reading; },
    async getOverview() {
      const states = { gbrain: 'healthy', hermes: 'healthy', openclaw: 'healthy', ...current.states };
      const system = (id) => ({ id, state: states[id], observedAt: '2026-11-11T09:59:00.000Z', caveats: [], detailHref: id === 'gbrain' ? '/' : '/services' });
      const sources = Object.fromEntries(['status', 'sessions', 'cron', 'hermes', 'hermesGateway', 'gbrain']
        .map((name) => [name, metaOf[current.sources?.[name] || 'fresh']]));
      return {
        systems: { gbrain: system('gbrain'), hermes: system('hermes'), openclaw: system('openclaw') },
        attention: current.attention || [],
        evidence: current.evidence || [],
        meta: { ok: true, stale: false, observedAt: '2026-11-11T09:59:00.000Z', ageMs: 0, error: null, latencyMs: null, source: 'operations.overview', sources },
      };
    },
  };
}

async function settledThen(reading) {
  const loopsSource = loopsSourceFor(FIXTURES[2]);
  await loopsSource.refresh();
  const overview = overviewReadings();
  overview.set({});
  const before = await both({ loopsSource, overview });
  overview.set(reading);
  const after = await both({ loopsSource, overview });
  assert.deepEqual(after.loops.data.totals.needsOperator, after.signals.data.attention, 'signals and loops differ');
  return { before: before.signals.data.attention, after: after.signals.data.attention };
}

test('reproduced: a fresh Hermes critical counts while another Hermes source is only being re-read', async () => {
  const { before, after } = await settledThen({
    states: { hermes: 'critical' },
    sources: { hermes: 'refreshing' },
    attention: [{ id: 'hermes:gateway-down', system: 'hermes', severity: 'critical', reasonCode: 'hermes_gateway_down', title: 'Hermes gateway is down', evidenceRefs: ['hermes:gateway'] }],
    evidence: [{ id: 'hermes:gateway', system: 'hermes', status: 'critical' }, { id: 'hermes:kanban', system: 'hermes', status: 'healthy' }],
  });
  assert.equal(before.count, 0);
  assert.equal(after.count, 1);
  assert.equal(after.breakdown.systems, 1);
  assert.equal(after.worst, 'critical');
});

test('reproduced: a fresh OpenClaw warning counts while its session source is being re-read', async () => {
  const { after } = await settledThen({
    states: { openclaw: 'warning' },
    sources: { sessions: 'refreshing' },
    attention: [{ id: 'openclaw:heartbeat-stale', system: 'openclaw', severity: 'warning', reasonCode: 'openclaw_heartbeat_stale', title: 'OpenClaw heartbeat needs fresh proof', evidenceRefs: ['openclaw:heartbeat'] }],
    evidence: [{ id: 'openclaw:heartbeat', system: 'openclaw', status: 'warning' }],
  });
  assert.equal(after.count, 1);
  assert.equal(after.worst, 'warning');
});

test('only the re-read source is held: its stale-only warnings do not add while a fresh source stays healthy', async () => {
  const { before, after } = await settledThen({
    states: { hermes: 'warning' },
    sources: { hermesGateway: 'refreshing' },
    attention: [{ id: 'hermes:gateway-unverified', system: 'hermes', severity: 'warning', reasonCode: 'x', title: 'Hermes gateway heartbeat is stale', evidenceRefs: ['hermes:gateway'] }],
    evidence: [{ id: 'hermes:gateway', system: 'hermes', status: 'warning' }, { id: 'hermes:kanban', system: 'hermes', status: 'healthy' }],
  });
  assert.equal(after.count, before.count);
  assert.equal(after.breakdown.systemReasons, 1);
});

test('reproduced: a system whose source FAILED counts once; only refreshing does not', async () => {
  const { after } = await settledThen({
    states: { gbrain: 'unavailable' },
    sources: { gbrain: 'failed' },
    attention: [{ id: 'gbrain:unavailable', system: 'gbrain', severity: 'unavailable', reasonCode: 'gbrain_unavailable', title: 'GBrain evidence unavailable', evidenceRefs: ['gbrain:unavailable'] }],
  });
  assert.equal(after.count, 1);
  assert.equal(after.breakdown.systems, 1);
  assert.equal(after.breakdown.systemReasons, 1);
  assert.equal(after.worst, 'unavailable');
  const refreshingOnly = await settledThen({ states: { gbrain: 'unavailable' }, sources: { gbrain: 'refreshing' } });
  assert.equal(refreshingOnly.after.count, 0);
});

test('a critical system item is never hidden: count and worst follow it even from a source being re-read', async () => {
  const { after } = await settledThen({
    states: { gbrain: 'critical' },
    sources: { gbrain: 'refreshing' },
    attention: [{ id: 'gbrain:caveat:0', system: 'gbrain', severity: 'critical', reasonCode: 'gbrain_active_caveat', title: 'GBrain requires attention', evidenceRefs: ['gbrain:trust'] }],
  });
  assert.equal(after.worst, 'critical');
  assert.equal(after.count, 1);
});

test('a failed source over a healthy last reading counts once and is not shown healthy', async () => {
  const { after } = await settledThen({ sources: { hermesGateway: 'failed' } });
  assert.equal(after.count, 1);
  assert.equal(after.worst, 'unavailable');
});
