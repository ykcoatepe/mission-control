const assert = require('node:assert/strict');
const test = require('node:test');
const express = require('express');

const { buildGBrainRouter } = require('../server/routes/gbrain');

test('rejects W1 action API calls without explicit confirmation', async () => {
  const app = express();
  app.use(express.json());
  app.use(buildGBrainRouter({
    gbrainOverviewService: { timelineService: { readTimeline: () => ({}) } },
  }));
  const server = app.listen(0);
  try {
    const { port } = server.address();
    const response = await fetch(`http://127.0.0.1:${port}/api/gbrain/actions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'sync-sources' }),
    });
    assert.equal(response.status, 400);
    const payload = await response.json();
    assert.deepEqual({
      ok: false,
      action: 'sync-sources',
      status: 'confirmation-required',
      error: 'Explicit confirmation is required for this action.',
    }, {
      ok: payload.ok,
      action: payload.action,
      status: payload.status,
      error: payload.error,
    });
    assert.match(payload.checkedAt, /^\d{4}-\d{2}-\d{2}T/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
