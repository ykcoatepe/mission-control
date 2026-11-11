const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const express = require('express');

const { createGuard, createAuditLog, auditWrites, parseOrigin } = require('../server/core/guard');

const PORT = 3333;
const quiet = { warn() {}, error() {}, log() {} };

function request(port, { method = 'GET', path: urlPath = '/api/x', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers, setHost: false }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: body ? JSON.parse(body) : null }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function withGuard(options, fn) {
  const reports = [];
  const guard = createGuard({ port: PORT, logger: quiet, onReport: (r) => reports.push(r), ...options });
  const app = express();
  app.use(guard.middleware);
  app.all(/.*/, (req, res) => res.json({ passed: true }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    await fn(server.address().port, { guard, reports });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const goodHost = { Host: `localhost:${PORT}` };

test('Host allowlist: own names pass, others and a missing Host are rejected', async () => {
  await withGuard({}, async (port) => {
    for (const host of [`localhost:${PORT}`, `127.0.0.1:${PORT}`, 'localhost', '127.0.0.1', `[::1]:${PORT}`]) {
      assert.equal((await request(port, { headers: { Host: host } })).status, 200, host);
    }
    for (const host of ['evil.com', `evil.com:${PORT}`, `localhost:${PORT}.evil.com`, `localhost:9999`]) {
      const response = await request(port, { headers: { Host: host } });
      assert.equal(response.status, 403, host);
      assert.equal(response.body.error.code, 'forbidden_host');
    }
  });
  // Node's HTTP/1.1 parser already answers 400 to a request without Host;
  // the guard rejects it as well.
  const guard = createGuard({ port: PORT, logger: quiet });
  assert.equal(guard.checkHost({ headers: {} }).ok, false);
});

test('counter-example: evil origins that pass a prefix check are rejected', async () => {
  await withGuard({ writeGuardMode: 'enforce' }, async (port) => {
    const evil = [
      `http://localhost:${PORT}.evil.com`,
      `http://localhost:${PORT}@evil.com`,
      `http://127.0.0.1:${PORT}0`,
      `http://localhost:${PORT}/path`,
      'http://evil.com',
      'null',
      'not a url',
      `file://localhost:${PORT}`,
    ];
    for (const origin of evil) {
      const response = await request(port, {
        method: 'POST',
        headers: { ...goodHost, Origin: origin, 'X-MC-Request': '1' },
      });
      assert.equal(response.status, 403, origin);
      assert.equal(response.body.error.code, 'forbidden_origin', origin);
    }
    const good = await request(port, {
      method: 'POST',
      headers: { ...goodHost, Origin: `http://localhost:${PORT}`, 'X-MC-Request': '1' },
    });
    assert.equal(good.status, 200);
  });
});

test('cross-site fetch metadata is rejected for writes', async () => {
  await withGuard({}, async (port) => {
    const response = await request(port, {
      method: 'DELETE',
      headers: { ...goodHost, 'Sec-Fetch-Site': 'cross-site', 'X-MC-Request': '1' },
    });
    assert.equal(response.status, 403);
  });
});

test('missing Origin: enforce mode needs the write header; report-only logs and passes', async () => {
  await withGuard({ writeGuardMode: 'enforce' }, async (port) => {
    const without = await request(port, { method: 'POST', headers: goodHost });
    assert.equal(without.status, 403);
    assert.equal(without.body.error.code, 'write_guard');
    const withHeader = await request(port, { method: 'POST', headers: { ...goodHost, 'X-MC-Request': '1' } });
    assert.equal(withHeader.status, 200);
    const get = await request(port, { method: 'GET', headers: goodHost });
    assert.equal(get.status, 200, 'reads never need the header');
    const nonApi = await request(port, { method: 'POST', path: '/not-api', headers: goodHost });
    assert.equal(nonApi.status, 200);
  });
  await withGuard({ writeGuardMode: 'report-only' }, async (port, { guard, reports }) => {
    const response = await request(port, { method: 'POST', path: '/api/tasks', headers: goodHost });
    assert.equal(response.status, 200);
    assert.deepEqual(reports, [{ method: 'POST', path: '/api/tasks', reason: 'missing_write_header' }]);
    assert.equal(guard.status().counters.writeReported, 1);
    assert.equal(guard.status().writeGuardMode, 'report-only');
  });
});

test('an unknown write guard mode fails closed to enforce', () => {
  const guard = createGuard({ port: PORT, writeGuardMode: 'off', logger: quiet });
  assert.equal(guard.mode, 'enforce');
});

test('counter-example: a guard error fails closed', async () => {
  // A port getter that throws stands in for any internal guard failure.
  const guard = createGuard({ port: () => { throw new Error('boom'); }, logger: quiet });
  const app = express();
  app.use(guard.middleware);
  app.all(/.*/, (req, res) => res.json({ passed: true }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    const response = await request(server.address().port, { headers: goodHost });
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'guard_error');
    assert.equal(guard.status().counters.guardErrors, 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('bind host is allowed; wildcard binds do not open every Host', () => {
  const lan = createGuard({ port: PORT, bindHost: '192.168.1.20', logger: quiet });
  assert.ok(lan.status().allowedHosts.includes(`192.168.1.20:${PORT}`));
  const wildcard = createGuard({ port: PORT, bindHost: '0.0.0.0', logger: quiet });
  assert.ok(!wildcard.status().allowedHosts.some((h) => h.startsWith('0.0.0.0')));
});

test('parseOrigin canonicalises and rejects non-origins', () => {
  assert.equal(parseOrigin('http://LOCALHOST:3333'), 'http://localhost:3333');
  assert.equal(parseOrigin('http://localhost'), 'http://localhost:80');
  assert.equal(parseOrigin('http://localhost:3333/'), null);
  assert.equal(parseOrigin('javascript:alert(1)'), null);
  assert.equal(parseOrigin(''), null);
});

test('audit log is append-only, bounded and atomic', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-audit-'));
  const file = path.join(dir, 'audit', 'events.json');
  let t = 0;
  const audit = createAuditLog({ file, maxEntries: 3, now: () => (t += 1000), logger: quiet });
  for (let i = 0; i < 5; i += 1) audit.record({ method: 'POST', path: `/api/x/${i}` });
  const entries = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(entries.map((e) => e.path), ['/api/x/2', '/api/x/3', '/api/x/4']);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['events.json'], 'no temp files left');

  // A failing rename leaves the previous file intact and no temp file.
  const failing = createAuditLog({
    file,
    logger: quiet,
    fsImpl: { ...fs, renameSync: () => { throw new Error('disk full'); } },
  });
  assert.equal(failing.record({ path: '/api/lost' }), null);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).map((e) => e.path), ['/api/x/2', '/api/x/3', '/api/x/4']);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['events.json']);
});

test('auditWrites records mutating /api requests only, without bodies', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-audit-'));
  const auditLog = createAuditLog({ file: path.join(dir, 'a.json'), logger: quiet });
  const app = express();
  app.use(auditWrites({ auditLog }));
  app.use(express.json());
  app.all(/.*/, (req, res) => res.json({ ok: true }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    await fetch(`${base}/api/read`);
    await fetch(`${base}/api/write`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"secret":"s3"}' });
    await new Promise((r) => setTimeout(r, 20));
    const entries = auditLog.readEntries();
    assert.equal(entries.length, 1);
    assert.equal(entries[0].method, 'POST');
    assert.equal(entries[0].path, '/api/write');
    assert.equal(entries[0].status, 200);
    assert.doesNotMatch(JSON.stringify(entries), /s3/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

// --- review round 1: API paths are matched like Express routes them ---------
const { isApiPath } = require('../server/core/http');

test('isApiPath follows Express: case, trailing slash, encoding, repeated slashes', () => {
  for (const p of ['/api', '/api/', '/API/settings/budget', '/Api/x/', '/api/settings/budget/', '//api/x', '/%61pi/x', '/%41PI/x', '/api%2Fx', '/api/x?y=1', '/%E0%A4%A']) {
    assert.equal(isApiPath(p), true, p);
  }
  for (const p of ['/', '/apix', '/assets/api.js', '/public/x', '/healthz']) {
    assert.equal(isApiPath(p), false, p);
  }
});

test('counter-example: case and slash variants cannot skip the write guard or the audit', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-audit-case-'));
  const auditLog = createAuditLog({ file: path.join(dir, 'a.json'), logger: quiet });
  const guard = createGuard({ port: PORT, writeGuardMode: 'enforce', logger: quiet });
  const app = express();
  app.use(auditWrites({ auditLog }));
  app.use(guard.middleware);
  // Express routing is case-insensitive and not strict about trailing slashes.
  app.post('/api/settings/budget', (req, res) => res.json({ reached: true }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    const port = server.address().port;
    const variants = ['/API/settings/budget', '/Api/Settings/Budget', '/api/settings/budget/', '/%61pi/settings/budget'];
    for (const urlPath of variants) {
      const response = await request(port, { method: 'POST', path: urlPath, headers: goodHost });
      assert.equal(response.status, 403, `${urlPath} must hit the write guard`);
      assert.equal(response.body.error.code, 'write_guard');
    }
    const reached = await request(port, { method: 'POST', path: '/API/settings/budget', headers: { ...goodHost, 'X-MC-Request': '1' } });
    assert.equal(reached.status, 200, 'the uppercase path really reaches the route');
    await new Promise((r) => setTimeout(r, 20));
    const audited = auditLog.readEntries().map((e) => [e.path, e.status]);
    assert.deepEqual(audited, [...variants.map((v) => [v, 403]), ['/API/settings/budget', 200]]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
