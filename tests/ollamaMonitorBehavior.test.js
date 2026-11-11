const assert = require('node:assert/strict');
const { test } = require('node:test');
const express = require('express');
const { createOllamaSource } = require('../server/sources/ollama/telemetry');
const { buildOllamaRouter } = require('../server/routes/ollama');
const { errorHandler } = require('../server/core/http');

const silent = { error() {} };
function fixture({ fail = () => false, platform = 'linux', runner, mcConfig = {} } = {}) {
  let calls = 0;
  const source = createOllamaSource({ mcConfig, platform, runner, fetchImpl: async (url) => {
    calls += 1;
    if (fail()) throw new Error('secret-token-must-not-be-returned');
    const payload = url.endsWith('/api/version') ? { version: '1.2.3' } : { models: url.endsWith('/api/ps') ? [{ name: 'qwen:latest' }] : [{ name: 'qwen:latest' }, { name: 'unlisted:latest' }, { name: 'embed:latest', details: { family: 'bert' } }] };
    return { ok: true, json: async () => payload };
  } });
  return { source, calls: () => calls };
}
async function withServer(router, run) {
  const app = express();
  app.use(express.json()); app.use(router); app.use(errorHandler({ logger: silent }));
  const server = await new Promise((resolve) => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); });
  try { await run(`http://127.0.0.1:${server.address().port}`); } finally { await new Promise((resolve) => server.close(resolve)); }
}

test('Ollama GET routes only use source memory, retain all inventory and never fabricate model metrics', async () => {
  const f = fixture();
  await f.source.refresh();
  assert.equal(f.calls(), 3);
  await withServer(buildOllamaRouter({ ollamaSource: f.source, mcConfig: {} }), async (base) => {
    for (let n = 0; n < 2; n++) {
      const telemetry = await (await fetch(`${base}/api/ollama/telemetry`)).json();
      assert.deepEqual(telemetry.models.map((m) => m.name), ['qwen:latest', 'unlisted:latest', 'embed:latest']);
      assert.equal(telemetry.runtime.runningModels, 1);
      assert.equal(telemetry.meta.stale, false);
      const modelMetrics = await (await fetch(`${base}/api/ollama/telemetry/models`)).json();
      assert.equal(modelMetrics.telemetrySource, 'unmeasured');
      for (const model of modelMetrics.models) {
        for (const field of ['requestCount', 'errorCount', 'errorRate', 'avgLatencyMs', 'p95LatencyMs', 'requestsPerMinute']) assert.equal(model[field], null);
        assert.match(model.note, /Not measured/);
      }
      const history = await (await fetch(`${base}/api/ollama/telemetry/history`)).json();
      assert.equal(history.total, 1, 'GET does not generate history samples');
    }
    assert.equal(f.calls(), 3, 'requests must not probe upstream');
  });
});

test('failed Ollama read preserves last good data with stale flag and sanitized error', async () => {
  let fail = false;
  const f = fixture({ fail: () => fail });
  await f.source.refresh();
  const previous = f.source.snapshot().data;
  fail = true;
  await f.source.refresh();
  assert.strictEqual(f.source.snapshot().data, previous);
  assert.equal(f.source.snapshot().meta.stale, true);
  assert.equal(f.source.snapshot().meta.error.code, 'ollama_probe_failed');
  assert.doesNotMatch(JSON.stringify(f.source.snapshot()), /secret-token/);
  assert.equal(f.source.history().length, 1, 'a failure is not a successful sample');
});

test('cold GET returns the core error contract without starting any probe', async () => {
  const f = fixture();
  await withServer(buildOllamaRouter({ ollamaSource: f.source, mcConfig: {} }), async (base) => {
    for (const suffix of ['', '/history', '/models']) {
      const response = await fetch(`${base}/api/ollama/telemetry${suffix}`);
      assert.equal(response.status, 503);
      assert.deepEqual(await response.json(), { error: { code: 'ollama_unavailable', message: 'Ollama telemetry has not been observed' } });
    }
    assert.equal(f.calls(), 0);
  });
});

test('source single-flights background probes and uses async argv runner for ioreg', async () => {
  let release;
  const wait = new Promise((resolve) => { release = resolve; });
  let gpuCalls = 0;
  const f = fixture({ platform: 'darwin', runner: { async run(bin, argv, options) {
    gpuCalls += 1;
    assert.equal(bin, 'ioreg');
    assert.deepEqual(argv, ['-r', '-d', '1', '-w', '0', '-c', 'IOAccelerator']);
    assert.equal(options.lane, 'default'); assert.equal(options.timeoutMs, 1500);
    await wait;
    return { ok: true, stdout: '"Device Utilization %" = 13\n"In use system memory" = 1048576\n"Alloc system memory" = 2097152' };
  } } });
  const first = f.source.refresh();
  const second = f.source.refresh();
  assert.strictEqual(first, second);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(gpuCalls, 1);
  assert.equal(f.source.snapshot().data, null);
  release(); await first;
  assert.equal(f.source.snapshot().data.gpu.devices[0].utilGpu, 13);
  assert.equal(f.source.snapshot().data.gpu.devices[0].memTotalMiB, 2);
});

test('malformed inventory is unknown, never an authoritative empty list', async () => {
  const source = createOllamaSource({ platform: 'linux', fetchImpl: async () => ({ ok: true, json: async () => ({}) }) });
  await source.refresh();
  assert.equal(source.snapshot().data, null);
  assert.equal(source.snapshot().meta.error.code, 'ollama_invalid_payload');
});

test('optimization persists only through ConfigStore and reports pending verification without probes', async () => {
  const mcConfig = {};
  const f = fixture({ mcConfig });
  let writes = 0;
  await withServer(buildOllamaRouter({ ollamaSource: f.source, mcConfig, persistMcConfig: async () => { writes += 1; } }), async (base) => {
    const response = await fetch(`${base}/api/ollama/optimization`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'apply', confirm: true, profile: { strategy: 'performance' } }) });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).verification.pending, true);
    assert.equal(writes, 1); assert.equal(f.calls(), 0);
    assert.equal(mcConfig.ollama.optimization.strategy, 'performance');
  });
  await withServer(buildOllamaRouter({ ollamaSource: f.source, mcConfig }), async (base) => {
    const response = await fetch(`${base}/api/ollama/optimization`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirm: true }) });
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error.code, 'config_store_unavailable');
  });
});

test('failed ConfigStore persistence restores the prior in-memory config', async () => {
  const mcConfig = { ollama: { host: 'localhost', optimization: { strategy: 'balanced' } } };
  const previous = mcConfig.ollama;
  const f = fixture({ mcConfig });
  await withServer(buildOllamaRouter({ ollamaSource: f.source, mcConfig, persistMcConfig: () => { throw new Error('private path must not leak'); } }), async (base) => {
    const response = await fetch(`${base}/api/ollama/optimization`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirm: true, profile: { strategy: 'performance' } }) });
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { error: { code: 'internal_error', message: 'Internal server error' } });
    assert.strictEqual(mcConfig.ollama, previous);
  });
});

test('Ollama source only exports whitelisted scalar model metadata', async () => {
  const source = createOllamaSource({ platform: 'linux', fetchImpl: async (url) => ({ ok: true, json: async () => url.endsWith('/api/version') ? { version: '1.2.3', token: 'private' } : { models: [{ name: 'qwen', transcript: 'private', details: { family: { transcript: 'private' } } }] } }) });
  await source.refresh();
  const snapshot = source.snapshot();
  assert.equal(snapshot.meta.ok, true);
  assert.equal(snapshot.data.models[0].family, null);
  assert.doesNotMatch(JSON.stringify(snapshot), /private|transcript|token/);
});
