const assert = require('node:assert/strict');
const test = require('node:test');
const express = require('express');

const { buildOperationsRouter } = require('../server/routes/operations');

async function withServer(service, run) {
  const app = express();
  app.use(buildOperationsRouter({ operationsOverviewService: service }));
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
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), {
      ok: false,
      error: 'Operations overview unavailable',
    });
  });
});

test('requires an overview reader at router construction time', () => {
  assert.throws(
    () => buildOperationsRouter({ operationsOverviewService: {} }),
    /operationsOverviewService\.getOverview required/,
  );
});
