const assert = require('node:assert/strict');
const test = require('node:test');
const express = require('express');

const { buildOperationsRouter } = require('../server/routes/operations');
const { errorHandler } = require('../server/core/http');
const { createOperationsOverviewService } = require('../server/services/operationsOverview');

async function withServer(service, run) {
  const app = express();
  app.use(buildOperationsRouter({ operationsOverviewService: service }));
  app.use(errorHandler({ logger: { error() {} } }));
  const server = app.listen(0);
  try {
    const { port } = server.address();
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('serves the read-only Operations overview and exposes no mutation route', async () => {
  await withServer({
    getOverview: async () => ({ ok: true, schemaVersion: '1', systems: {} }),
  }, async (base) => {
    const getResponse = await fetch(`${base}/api/operations/overview`);
    assert.equal(getResponse.status, 200);
    assert.equal((await getResponse.json()).schemaVersion, '1');

    const postResponse = await fetch(`${base}/api/operations/overview`, { method: 'POST' });
    assert.equal(postResponse.status, 404);
  });
});

test('returns a bounded response when overview construction fails catastrophically', async () => {
  await withServer({
    getOverview: async () => {
      throw new Error('Bearer secret from /Users/example/private');
    },
  }, async (base) => {
    const response = await fetch(`${base}/api/operations/overview`);
    assert.equal(response.status, 503);
    const text = await response.text();
    assert.deepEqual(JSON.parse(text), {
      error: { code: 'operations_unavailable', message: 'Operations overview unavailable' },
    });
    assert.doesNotMatch(text, /Bearer|Users/);
  });
});

test('requires an overview reader at router construction time', () => {
  assert.throws(
    () => buildOperationsRouter({ operationsOverviewService: {} }),
    /operationsOverviewService\.getOverview required/,
  );
});

test('route end-to-end: gateway down is critical while a timed-out Kanban refresh is served stale', async () => {
  const at = new Date().toISOString();
  const staleAt = new Date(Date.now() - 90_000).toISOString();
  const proof = { sourceSucceeded: true, provenance: 'fixture', observedAt: at };
  const service = createOperationsOverviewService({
    readers: {
      status: async () => ({
        generatedAt: at, operationsSource: proof,
        agent: { activeSessions: 0, channels: [] }, heartbeat: { lastHeartbeat: Date.now() },
      }),
      sessions: async () => ({ operationsSource: proof, count: 0, sessions: [] }),
      cron: async () => ({
        operationsSource: { ...proof, schedulers: { openclaw: proof, hermes: proof } },
        jobs: [],
      }),
      hermes: async () => ({
        ok: true, stale: true, staleAgeMs: 90_000, refreshedAt: staleAt,
        summary: { total: 3, active: 1, running: 1, blocked: 0 },
      }),
      hermesGateway: async () => ({ ok: true, status: 'down', pid: 1, observedAt: at, heartbeatAt: staleAt }),
      gbrain: async () => ({ unavailable: true }),
    },
  });
  await withServer(service, async (base) => {
    const body = await (await fetch(`${base}/api/operations/overview`)).json();
    assert.equal(body.systems.hermes.state, 'critical');
    assert.equal(body.systems.hermes.freshness, 'stale');
  });

  const up = createOperationsOverviewService({
    readers: {
      cron: async () => ({
        operationsSource: { ...proof, schedulers: { openclaw: proof, hermes: proof } },
        jobs: [],
      }),
      hermes: async () => ({
        ok: true, stale: true, staleAgeMs: 90_000, refreshedAt: staleAt,
        summary: { total: 3, active: 1, running: 1, blocked: 0 },
      }),
      hermesGateway: async () => ({ ok: true, status: 'running', pid: 1, observedAt: at, heartbeatAt: at }),
    },
  });
  await withServer(up, async (base) => {
    const body = await (await fetch(`${base}/api/operations/overview`)).json();
    assert.equal(body.systems.hermes.state, 'healthy');
    assert.equal(body.systems.hermes.freshness, 'stale');
  });
});
