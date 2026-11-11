const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const {
  asyncHandler,
  httpError,
  requestContext,
  apiNotFound,
  errorHandler,
  sendEnvelope,
  listRoutes,
} = require('../server/core/http');

async function withApp(build, fn) {
  const lines = [];
  const logger = { log: (line) => lines.push(line), error: () => {}, warn: () => {} };
  const app = express();
  app.use(requestContext({ logger }));
  app.use(express.json());
  build(app);
  app.use('/api', apiNotFound());
  app.use(errorHandler({ logger }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base, lines);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('unknown /api path returns the JSON error contract with 404', async () => {
  await withApp(() => {}, async (base) => {
    const response = await fetch(`${base}/api/nope?x=1`);
    assert.equal(response.status, 404);
    assert.match(response.headers.get('content-type'), /application\/json/);
    assert.deepEqual(await response.json(), {
      error: { code: 'not_found', message: 'No API route for GET /api/nope' },
    });
  });
});

test('a thrown 5xx never leaks stack or child-process text', async () => {
  await withApp((app) => {
    app.get('/api/boom', asyncHandler(async () => {
      const error = new Error('Command failed: openclaw status\n    at /Users/someone/secret.js:1:1');
      error.stderr = 'token=abc';
      throw error;
    }));
  }, async (base) => {
    const response = await fetch(`${base}/api/boom`);
    assert.equal(response.status, 500);
    const body = await response.json();
    assert.deepEqual(body, { error: { code: 'internal_error', message: 'Internal server error' } });
    assert.doesNotMatch(JSON.stringify(body), /openclaw|Users|token|at /);
  });
});

test('client errors keep their status; exposed messages pass through', async () => {
  await withApp((app) => {
    app.get('/api/missing', () => { throw httpError(404, 'task_not_found', 'Task not found'); });
    app.get('/api/plain400', () => {
      const error = new Error('internal detail /Users/x');
      error.statusCode = 400;
      throw error;
    });
    app.post('/api/echo', (req, res) => res.json(req.body));
  }, async (base) => {
    let response = await fetch(`${base}/api/missing`);
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: { code: 'task_not_found', message: 'Task not found' } });

    response = await fetch(`${base}/api/plain400`);
    assert.equal(response.status, 400);
    const plain = await response.json();
    assert.equal(plain.error.code, 'bad_request');
    assert.doesNotMatch(plain.error.message, /Users/);

    response = await fetch(`${base}/api/echo`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{bad' });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: { code: 'invalid_json', message: 'Request body is not valid JSON' } });
  });
});

test('request id header and one structured log line per /api request', async () => {
  await withApp((app) => {
    app.get('/api/ok', (req, res) => res.json({ id: req.id }));
    app.get('/asset.js', (req, res) => res.send('x'));
  }, async (base, lines) => {
    const response = await fetch(`${base}/api/ok?q=secret`);
    const body = await response.json();
    assert.equal(response.headers.get('x-request-id'), body.id);
    await fetch(`${base}/asset.js`);
    await new Promise((r) => setTimeout(r, 20));
    const apiLines = lines.map((line) => JSON.parse(line));
    assert.equal(apiLines.length, 1);
    assert.equal(apiLines[0].method, 'GET');
    assert.equal(apiLines[0].path, '/api/ok');
    assert.equal(apiLines[0].status, 200);
    assert.equal(typeof apiLines[0].ms, 'number');
    assert.equal(apiLines[0].id, body.id);
  });
});

test('sendEnvelope: 200 with data, 503 with null data', async () => {
  await withApp((app) => {
    app.get('/api/a', (req, res) => sendEnvelope(res, { data: { x: 1 }, meta: { ok: true, stale: false } }));
    app.get('/api/b', (req, res) => sendEnvelope(res, { data: null, meta: { ok: false, stale: true } }));
  }, async (base) => {
    let response = await fetch(`${base}/api/a`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { data: { x: 1 }, meta: { ok: true, stale: false } });
    response = await fetch(`${base}/api/b`);
    assert.equal(response.status, 503);
    assert.equal((await response.json()).data, null);
  });
});

test('listRoutes walks nested routers', () => {
  const app = express();
  const router = express.Router();
  router.get('/api/x', () => {});
  router.post('/api/x', () => {});
  app.use(router);
  app.get('/api/y', () => {});
  assert.deepEqual(listRoutes(app), ['GET /api/x', 'POST /api/x', 'GET /api/y']);
});
