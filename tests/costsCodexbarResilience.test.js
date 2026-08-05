const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// ---------------------------------------------------------------------------
// /api/costs/codexbar resilience: a failing re-scan must serve the last good
// result (typed as stale) instead of a user-visible 500, while a failure with
// no good result to fall back on still surfaces as an error.
//
// Root cause being guarded (2026-08-05): `codexbar cost --days 70` measures
// ~15s warm on this host and exceeded the old 30s exec timeout whenever it
// queued behind detailed refresh scans, producing repeated 500s in the
// launchd error log while a perfectly good scan result sat in cache.
// ---------------------------------------------------------------------------

const FAKE_REPORT = {
  provider: 'both',
  updatedAt: '2026-08-01T00:00:00Z',
  last30DaysCostUSD: 10,
  last30DaysTokens: 1000,
  sessionCostUSD: 1,
  sessionTokens: 100,
  totals: { totalCost: 10, totalTokens: 1000, inputTokens: 900, outputTokens: 100 },
  daily: [
    {
      date: '2026-08-01',
      totalCost: 10,
      totalTokens: 1000,
      inputTokens: 900,
      outputTokens: 100,
      modelBreakdowns: [{ modelName: 'claude-fable-5', cost: 10, totalTokens: 1000 }],
    },
  ],
};

function writeFakeCodexbar(binDir, modeFile, payloadFile) {
  fs.writeFileSync(payloadFile, JSON.stringify(FAKE_REPORT));
  fs.writeFileSync(modeFile, 'ok');
  const script = [
    '#!/bin/sh',
    `MODE=$(cat ${JSON.stringify(modeFile)})`,
    'if [ "$MODE" = "fail" ]; then',
    '  echo "synthetic codexbar failure" >&2',
    '  exit 1',
    'fi',
    'if [ "$MODE" = "garbage" ]; then',
    '  echo "this is not json {"',
    '  exit 0',
    'fi',
    'if [ "$MODE" = "semantic" ]; then',
    '  echo "{\\"error\\":\\"scanner failed\\"}"',
    '  exit 0',
    'fi',
    'if [ "$MODE" = "structured-error" ]; then',
    '  echo "[{\\"provider\\":\\"codex\\",\\"daily\\":[],\\"error\\":{\\"message\\":\\"auth expired\\"}}]"',
    '  exit 0',
    'fi',
    `cat ${JSON.stringify(payloadFile)}`,
  ].join('\n');
  const binPath = path.join(binDir, 'codexbar');
  fs.writeFileSync(binPath, script);
  fs.chmodSync(binPath, 0o755);
}

async function withCodexbarRouter(run, envOverrides = {}) {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-codexbar-resilience-'));
  const binDir = path.join(workDir, 'bin');
  fs.mkdirSync(binDir);
  const modeFile = path.join(workDir, 'mode');
  const payloadFile = path.join(workDir, 'payload.json');
  writeFakeCodexbar(binDir, modeFile, payloadFile);

  const previousEnv = {
    PATH: process.env.PATH,
    MC_COSTS_CACHE_DIR: process.env.MC_COSTS_CACHE_DIR,
    MC_CODEXBAR_SCAN_TTL_MS: process.env.MC_CODEXBAR_SCAN_TTL_MS,
    MC_CODEXBAR_LAST_GOOD_MAX_AGE_MS: process.env.MC_CODEXBAR_LAST_GOOD_MAX_AGE_MS,
  };
  process.env.PATH = `${binDir}:${process.env.PATH}`;
  process.env.MC_COSTS_CACHE_DIR = path.join(workDir, 'cache');
  // TTL 0 forces every request through a fresh exec, so the failure path is
  // reachable without waiting out the production 30s reuse window.
  process.env.MC_CODEXBAR_SCAN_TTL_MS = '0';
  delete process.env.MC_CODEXBAR_LAST_GOOD_MAX_AGE_MS;
  Object.entries(envOverrides).forEach(([envKey, envValue]) => {
    process.env[envKey] = envValue;
  });

  const express = require('express');
  const { buildCostsRouter } = require('../server/routes/costs');
  const app = express();
  app.use(buildCostsRouter({
    mcConfig: { budget: { monthly: 0 } },
    projectRoot: path.join(__dirname, '..'),
    sessionsService: { listVisibleSessions: async () => ({ sessions: [] }) },
  }));
  const server = await new Promise((resolve) => {
    const created = app.listen(0, '127.0.0.1', () => resolve(created));
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    await run({ base, modeFile });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    Object.entries(previousEnv).forEach(([key, value]) => {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    });
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

test('a failing re-scan serves the last good codexbar result, typed as stale', async () => {
  await withCodexbarRouter(async ({ base, modeFile }) => {
    const fresh = await fetch(`${base}/api/costs/codexbar`);
    assert.equal(fresh.status, 200);
    const freshBody = await fresh.json();
    assert.equal(freshBody.stale, undefined, 'a fresh scan must not be marked stale');
    assert.equal(freshBody.totals.totalCost, 10);

    fs.writeFileSync(modeFile, 'fail');
    const fallback = await fetch(`${base}/api/costs/codexbar`);
    assert.equal(fallback.status, 200, 'a failing re-scan with a last good result must not 500');
    const fallbackBody = await fallback.json();
    assert.equal(fallbackBody.stale, true);
    assert.equal(fallbackBody.staleReason, 'scan_failed_served_last_good');
    assert.ok(Number.isFinite(fallbackBody.staleAgeMs));
    assert.equal(fallbackBody.totals.totalCost, 10, 'the payload must be the last good scan');
  });
});

test('an exit-0 scan with garbage output falls back and does NOT poison the last good cache', async () => {
  await withCodexbarRouter(async ({ base, modeFile }) => {
    const fresh = await fetch(`${base}/api/costs/codexbar`);
    assert.equal(fresh.status, 200);

    fs.writeFileSync(modeFile, 'garbage');
    const fallback = await fetch(`${base}/api/costs/codexbar`);
    assert.equal(fallback.status, 200, 'garbage output with exit 0 must fall back like a failed scan');
    const fallbackBody = await fallback.json();
    assert.equal(fallbackBody.stale, true);
    assert.equal(fallbackBody.totals.totalCost, 10, 'the served payload must be the last GOOD scan, not the garbage');

    // The recovery request proves the cache held the good scan, not the garbage.
    fs.writeFileSync(modeFile, 'ok');
    const recovered = await fetch(`${base}/api/costs/codexbar`);
    assert.equal(recovered.status, 200);
    const recoveredBody = await recovered.json();
    assert.equal(recoveredBody.stale, undefined, 'a healthy re-scan must serve fresh again');
    assert.equal(recoveredBody.totals.totalCost, 10);
  });
});

test('exit-0 SEMANTIC garbage (valid JSON, hollow shape) falls back instead of storing zeros', async () => {
  await withCodexbarRouter(async ({ base, modeFile }) => {
    const fresh = await fetch(`${base}/api/costs/codexbar`);
    assert.equal(fresh.status, 200);

    // {"error":"scanner failed"} parses fine and merges into a zero-valued
    // report; without shape validation it would silently replace the last
    // good scan with zeros.
    fs.writeFileSync(modeFile, 'semantic');
    const fallback = await fetch(`${base}/api/costs/codexbar`);
    assert.equal(fallback.status, 200);
    const fallbackBody = await fallback.json();
    assert.equal(fallbackBody.stale, true, 'a hollow report must be treated as a failed scan');
    assert.equal(fallbackBody.totals.totalCost, 10, 'the last good totals must survive, not zeros');

    fs.writeFileSync(modeFile, 'ok');
    const recovered = await fetch(`${base}/api/costs/codexbar`);
    const recoveredBody = await recovered.json();
    assert.equal(recoveredBody.stale, undefined);
    assert.equal(recoveredBody.totals.totalCost, 10);
  });
});

test('CodexBar\'s structured error shape (provider + empty daily + error) falls back too', async () => {
  await withCodexbarRouter(async ({ base, modeFile }) => {
    const fresh = await fetch(`${base}/api/costs/codexbar`);
    assert.equal(fresh.status, 200);

    // The CLI's error builder emits provider + daily:[] + error; if that ever
    // exits 0 it must be treated as a failed scan, not a zero-usage report.
    fs.writeFileSync(modeFile, 'structured-error');
    const fallback = await fetch(`${base}/api/costs/codexbar`);
    assert.equal(fallback.status, 200);
    const fallbackBody = await fallback.json();
    assert.equal(fallbackBody.stale, true, 'an error-carrying report must not read as fresh zeros');
    assert.equal(fallbackBody.totals.totalCost, 10, 'last good totals must survive the structured error');

    fs.writeFileSync(modeFile, 'ok');
    const recovered = await fetch(`${base}/api/costs/codexbar`);
    const recoveredBody = await recovered.json();
    assert.equal(recoveredBody.stale, undefined);
    assert.equal(recoveredBody.totals.totalCost, 10);
  });
});

test('a stale codexbar scan marks month availability partial while keeping its months', async () => {
  await withCodexbarRouter(async ({ base, modeFile }) => {
    const fresh = await fetch(`${base}/api/costs/codexbar`);
    assert.equal(fresh.status, 200);

    fs.writeFileSync(modeFile, 'fail');
    const months = await fetch(`${base}/api/costs/months`);
    assert.equal(months.status, 200);
    const body = await months.json();
    // The stale scan's months are real usage and stay listed…
    assert.equal(body.sourceStatus.codexbar, 'ready');
    assert.ok(body.months.some((entry) => entry.sources.includes('codexbar')),
      'months from the last good scan must remain available');
    // …but the payload must not claim a fully fresh scan.
    assert.equal(body.partial, true);
  });
});

test('the last good fallback expires at the age ceiling instead of masking a dead scanner forever', async () => {
  await withCodexbarRouter(async ({ base, modeFile }) => {
    const fresh = await fetch(`${base}/api/costs/codexbar`);
    assert.equal(fresh.status, 200);

    fs.writeFileSync(modeFile, 'fail');
    const expired = await fetch(`${base}/api/costs/codexbar`);
    assert.equal(expired.status, 500, 'past the age ceiling the failure must surface, not the frozen result');
  }, { MC_CODEXBAR_LAST_GOOD_MAX_AGE_MS: '0' });
});

test('a failure with no last good result still surfaces as an error', async () => {
  await withCodexbarRouter(async ({ base, modeFile }) => {
    fs.writeFileSync(modeFile, 'fail');
    const response = await fetch(`${base}/api/costs/codexbar`);
    assert.equal(response.status, 500, 'nothing good to serve: the failure must stay visible');
    const body = await response.json();
    assert.match(String(body.error || ''), /Failed to load CodexBar cost data/);
  });
});

// ---------------------------------------------------------------------------
// Mechanized guard: both codexbar execs must use the shared, env-tunable
// timeout — a literal 30s ceiling on this seam is the regression under guard.
// ---------------------------------------------------------------------------

test('codexbar execs use the env-tunable timeout, not a hardcoded ceiling', () => {
  const routeSource = fs.readFileSync(path.join(__dirname, '..', 'server', 'routes', 'costs.js'), 'utf8');
  assert.match(routeSource, /const codexbarTimeoutMs = Number\(process\.env\.MC_CODEXBAR_TIMEOUT_MS \|\| 120000\);/);
  assert.match(routeSource, /--provider both --days \$\{scanDays\}`, \{\s*timeout: codexbarTimeoutMs,/);
  assert.match(routeSource, /--provider claude --days \$\{days\}`, \{\s*timeout: codexbarTimeoutMs,/);
});
