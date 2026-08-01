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

test('GET /api/costs/months returns bounded newest-first availability', async () => {
  const current = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}`;
  const prior = shiftMonth(current, -1);

  await withCostsApp({
    hermes: async () => [current, prior],
    codexbar: async () => [current],
  }, async (base) => {
    const response = await fetch(`${base}/api/costs/months`);
    assert.equal(response.status, 200);
    const body = await response.json();

    assert.equal(typeof body.generatedAt, 'string');
    assert.equal(typeof body.partial, 'boolean');
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
  }, async (base) => {
    const response = await fetch(`${base}/api/costs/months`);
    assert.equal(response.status, 200);
    const body = await response.json();

    assert.equal(body.partial, true);
    assert.deepEqual(body.months[0], { month: current, hasData: true, sources: ['codexbar'] });
    assert.deepEqual(body.months.find((entry) => entry.month === prior), {
      month: prior,
      hasData: false,
      sources: [],
      unknown: true,
    });
  });
});
