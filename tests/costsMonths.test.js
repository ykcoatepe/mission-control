const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const path = require('node:path');

const { buildCostsRouter } = require('../server/routes/costs');

function shiftMonth(month, delta) {
  const [year, number] = month.split('-').map(Number);
  const date = new Date(year, number - 1 + delta, 1);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

async function withCostsApp(monthAvailabilitySources, run) {
  const app = express();
  app.use(buildCostsRouter({
    mcConfig: { budget: { monthly: 0 } },
    projectRoot: path.join(__dirname, '..'),
    sessionsService: { listVisibleSessions: async () => ({ sessions: [] }) },
    monthAvailabilitySources,
  }));
  const server = await new Promise((resolve) => {
    const created = app.listen(0, '127.0.0.1', () => resolve(created));
  });
  try {
    await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function emptyCachedDetailedMonths() {
  return { data: new Set(), confirmedEmpty: new Set(), hasEntries: false };
}

function cleanCachedDetailedMonths({ data = [], confirmedEmpty = [] } = {}) {
  return { data: new Set(data), confirmedEmpty: new Set(confirmedEmpty), hasEntries: true };
}

test('GET /api/costs/months returns bounded newest-first availability', async () => {
  const current = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}`;
  const prior = shiftMonth(current, -1);

  await withCostsApp({
    hermes: async () => [current, prior],
    codexbar: async () => [current],
    hermesConfigured: () => true,
    codexbarConfigured: () => true,
    cachedDetailedMonths: emptyCachedDetailedMonths,
  }, async (base) => {
    const response = await fetch(`${base}/api/costs/months`);
    assert.equal(response.status, 200);
    const body = await response.json();

    assert.equal(typeof body.generatedAt, 'string');
    assert.equal(typeof body.partial, 'boolean');
    assert.deepEqual(body.sourceStatus, { hermes: 'ready', codexbar: 'ready', cached: 'no_usage' });
    assert.equal(body.months.length, 25);
    assert.equal(body.months[0].month, current, 'the current month is first');
    assert.equal(body.months.at(-1).month, shiftMonth(current, -24), 'the 24-month floor is included');
    assert.ok(body.months.every((entry) => entry.month <= current), 'future months are never offered');
    assert.ok(body.months.every((entry, index, rows) => index === 0 || entry.month < rows[index - 1].month), 'months are newest first');
    assert.deepEqual(body.months[0], { month: current, hasData: true, sources: ['hermes', 'codexbar'] });
    assert.deepEqual(body.months[1], { month: prior, hasData: true, sources: ['hermes'] });
  });
});

test('GET /api/costs/months degrades to unknown selectable months when a source fails', async () => {
  const current = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}`;
  const prior = shiftMonth(current, -1);

  await withCostsApp({
    hermes: async () => { throw new Error('Hermes database unavailable'); },
    codexbar: async () => [current],
    hermesConfigured: () => true,
    codexbarConfigured: () => true,
    cachedDetailedMonths: emptyCachedDetailedMonths,
  }, async (base) => {
    const response = await fetch(`${base}/api/costs/months`);
    assert.equal(response.status, 200);
    const body = await response.json();

    assert.equal(body.partial, true);
    assert.deepEqual(body.sourceStatus, { hermes: 'unavailable', codexbar: 'ready', cached: 'no_usage' });
    assert.deepEqual(body.months[0], { month: current, hasData: true, sources: ['codexbar'] });
    assert.deepEqual(body.months.find((entry) => entry.month === prior), {
      month: prior,
      hasData: false,
      sources: [],
      unknown: true,
    });
  });
});

test('OpenClaw-only months remain unknown until detailed cache evidence is available', async () => {
  const current = '2026-08';
  const openclawOnly = '2026-05';

  await withCostsApp({
    now: () => new Date('2026-08-15T12:00:00'),
    hermes: async () => [],
    codexbar: async () => [],
    hermesConfigured: () => true,
    codexbarConfigured: () => true,
    cachedDetailedMonths: emptyCachedDetailedMonths,
  }, async (base) => {
    const body = await (await fetch(`${base}/api/costs/months`)).json();
    assert.deepEqual(body.months.find((entry) => entry.month === openclawOnly), {
      month: openclawOnly,
      hasData: false,
      sources: [],
      unknown: true,
    });
    assert.equal(body.sourceStatus.cached, 'no_usage');
  });
});

test('detailed cache supplies positive and the only confirmed-empty month evidence', async () => {
  const current = '2026-08';
  const confirmedEmpty = '2026-07';
  const stillUnknown = '2026-06';

  await withCostsApp({
    now: () => new Date('2026-08-15T12:00:00'),
    hermes: async () => [],
    codexbar: async () => [],
    hermesConfigured: () => true,
    codexbarConfigured: () => true,
    cachedDetailedMonths: () => cleanCachedDetailedMonths({ data: [current], confirmedEmpty: [confirmedEmpty] }),
  }, async (base) => {
    const body = await (await fetch(`${base}/api/costs/months`)).json();
    assert.deepEqual(body.months.find((entry) => entry.month === current), {
      month: current,
      hasData: true,
      sources: ['cached'],
    });
    assert.deepEqual(body.months.find((entry) => entry.month === confirmedEmpty), {
      month: confirmedEmpty,
      hasData: false,
      sources: ['cached'],
    });
    assert.equal(body.months.find((entry) => entry.month === stillUnknown).unknown, true);
    assert.equal(body.sourceStatus.cached, 'ready');
  });
});

test('the partially covered CodexBar floor month remains unknown and marks the response partial', async () => {
  await withCostsApp({
    now: () => new Date('2026-08-15T12:00:00'),
    hermes: async () => [],
    codexbar: async () => [],
    hermesConfigured: () => true,
    codexbarConfigured: () => true,
    cachedDetailedMonths: emptyCachedDetailedMonths,
  }, async (base) => {
    const body = await (await fetch(`${base}/api/costs/months`)).json();
    assert.equal(body.partial, true);
    assert.equal(body.months.find((entry) => entry.month === '2026-06').unknown, true);
  });
});

test('month availability distinguishes unconfigured producers from unavailable ones', async () => {
  await withCostsApp({
    now: () => new Date('2026-08-15T12:00:00'),
    hermes: async () => { throw new Error('must not run'); },
    codexbar: async () => { throw new Error('schema drift'); },
    hermesConfigured: () => false,
    codexbarConfigured: () => true,
    cachedDetailedMonths: emptyCachedDetailedMonths,
  }, async (base) => {
    const body = await (await fetch(`${base}/api/costs/months`)).json();
    assert.deepEqual(body.sourceStatus, { hermes: 'not_configured', codexbar: 'unavailable', cached: 'no_usage' });
    assert.equal(body.months[0].unknown, true);
  });
});

test('an unconfigured CodexBar producer is not reported as a flaky unavailable source', async () => {
  let codexbarCalls = 0;
  await withCostsApp({
    now: () => new Date('2026-08-15T12:00:00'),
    hermes: async () => [],
    codexbar: async () => { codexbarCalls += 1; return []; },
    hermesConfigured: () => true,
    codexbarConfigured: () => false,
    cachedDetailedMonths: emptyCachedDetailedMonths,
  }, async (base) => {
    const body = await (await fetch(`${base}/api/costs/months`)).json();
    assert.equal(body.sourceStatus.codexbar, 'not_configured');
    assert.equal(codexbarCalls, 0);
  });
});

test('malformed CodexBar results are unavailable rather than settled no_usage', async () => {
  await withCostsApp({
    now: () => new Date('2026-08-15T12:00:00'),
    hermes: async () => [],
    codexbar: async () => { throw new Error('CodexBar returned an invalid usage report'); },
    hermesConfigured: () => true,
    codexbarConfigured: () => true,
    cachedDetailedMonths: emptyCachedDetailedMonths,
  }, async (base) => {
    const body = await (await fetch(`${base}/api/costs/months`)).json();
    assert.equal(body.sourceStatus.codexbar, 'unavailable');
    assert.notEqual(body.sourceStatus.codexbar, 'no_usage');
  });
});

test('month availability deduplicates concurrent source scans', async () => {
  let hermesCalls = 0;
  let releaseHermes;
  const hermesGate = new Promise((resolve) => { releaseHermes = resolve; });
  await withCostsApp({
    now: () => new Date('2026-08-15T12:00:00'),
    hermes: async () => {
      hermesCalls += 1;
      await hermesGate;
      return [];
    },
    codexbar: async () => [],
    hermesConfigured: () => true,
    codexbarConfigured: () => true,
    cachedDetailedMonths: emptyCachedDetailedMonths,
  }, async (base) => {
    const first = fetch(`${base}/api/costs/months`);
    const second = fetch(`${base}/api/costs/months`);
    await new Promise((resolve) => setImmediate(resolve));
    releaseHermes();
    const [firstResponse, secondResponse] = await Promise.all([first, second]);
    assert.equal(firstResponse.status, 200);
    assert.equal(secondResponse.status, 200);
    assert.equal(hermesCalls, 1);
  });
});

test('Hermes month query excludes zero-token and zero-spend sessions', () => {
  const routeSource = require('node:fs').readFileSync(path.join(__dirname, '..', 'server', 'routes', 'costs.js'), 'utf8');
  assert.match(routeSource, /COALESCE\(input_tokens, 0\).*COALESCE\(actual_cost_usd, estimated_cost_usd, 0\) > 0/s);
});

test('month availability cache is invalidated when the server month rolls over', () => {
  const routeSource = require('node:fs').readFileSync(path.join(__dirname, '..', 'server', 'routes', 'costs.js'), 'utf8');
  assert.match(
    routeSource,
    /monthsAvailabilityCache\.month === monthKeyOf\(new Date\(\)\)/,
    'a cache generated just before a month rollover must not confirm the new current month empty',
  );
  assert.match(
    routeSource,
    /monthsAvailabilityCache = \{ time: Date\.now\(\), month: monthKeyOf\(new Date\(\)\), value \}/,
    'the cache must record which server month generated its availability result',
  );
});
