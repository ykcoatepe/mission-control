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

test('Apple GPU tiler and allocated memory stay distinct from device use and hardware totals across probes', async () => {
  const samples = [
    { device: 13, renderer: 19, tiler: 71, allocatedMiB: 8, usedMiB: 2 },
    { device: 29, renderer: 37, tiler: 83, allocatedMiB: 16, usedMiB: 6 },
  ];
  let index = 0;
  const f = fixture({ platform: 'darwin', runner: { async run() {
    const sample = samples[index++];
    return { ok: true, stdout: [
      `"Device Utilization %" = ${sample.device}`,
      `"Renderer Utilization %" = ${sample.renderer}`,
      `"Tiler Utilization %" = ${sample.tiler}`,
      `"Alloc system memory" = ${sample.allocatedMiB * 1024 * 1024}`,
      `"In use system memory" = ${sample.usedMiB * 1024 * 1024}`,
    ].join('\n') };
  } } });

  for (const sample of samples) {
    await f.source.refresh();
    const device = f.source.snapshot().data.gpu.devices[0];
    assert.equal(device.utilGpu, sample.device);
    assert.equal(device.tilerUtilPercent, sample.tiler);
    assert.notEqual(device.tilerUtilPercent, device.utilGpu);
    assert.equal(device.memAllocatedMiB, sample.allocatedMiB);
    assert.equal(device.memUsedMiB, sample.usedMiB);
    assert.equal(device.memHardwareTotalMiB, null, 'ioreg allocation does not measure hardware capacity');
    assert.equal(device.memFreeMiB, null, 'allocated minus used is not hardware free memory');
    assert.equal(device.utilMemory, sample.tiler, 'retain the deprecated alias');
    assert.equal(device.memTotalMiB, sample.allocatedMiB, 'retain the deprecated alias');
    assert.equal(device.metricSource, 'apple-ioreg');
    assert.match(device.metricSourceNote, /allocated.*not.*hardware total/i);
    assert.equal(device.deprecatedAliases.utilMemory.replacement, 'tilerUtilPercent');
    assert.match(device.deprecatedAliases.utilMemory.note, /tiler/i);
    assert.equal(device.deprecatedAliases.memTotalMiB.replacement, 'memAllocatedMiB');
    assert.match(device.deprecatedAliases.memTotalMiB.note, /not.*hardware total/i);
    assert.match(device.deprecatedAliases.memFreeMiB.note, /not measured/i);
  }
  assert.equal(index, 2);
  assert.deepEqual(f.source.history().map((point) => point.gpuUtilPercent), [13, 29]);
  assert.deepEqual(f.source.history().map((point) => point.gpuMemoryPercent), [null, null], 'allocation changes must not create hardware usage percentages');
});

test('Apple GPU absent tiler and allocation readings remain null', async () => {
  const f = fixture({ platform: 'darwin', runner: { async run() {
    return { ok: true, stdout: '"Device Utilization %" = 7' };
  } } });
  await f.source.refresh();
  const device = f.source.snapshot().data.gpu.devices[0];
  assert.equal(device.utilGpu, 7);
  for (const field of ['tilerUtilPercent', 'utilMemory', 'memAllocatedMiB', 'memTotalMiB', 'memUsedMiB', 'memHardwareTotalMiB', 'memFreeMiB']) {
    assert.equal(device[field], null, `${field} is unknown rather than zero or inferred`);
  }
  assert.equal(f.source.history()[0].gpuMemoryPercent, null);
});

test('malformed inventory is unknown, never an authoritative empty list', async () => {
  const source = createOllamaSource({ platform: 'linux', fetchImpl: async () => ({ ok: true, json: async () => ({}) }) });
  await source.refresh();
  assert.equal(source.snapshot().data, null);
  assert.equal(source.snapshot().meta.error.code, 'ollama_invalid_payload');
});

test('Ollama source only exports whitelisted scalar model metadata', async () => {
  const source = createOllamaSource({ platform: 'linux', fetchImpl: async (url) => ({ ok: true, json: async () => url.endsWith('/api/version') ? { version: '1.2.3', token: 'private' } : { models: [{ name: 'qwen', transcript: 'private', details: { family: { transcript: 'private' } } }] } }) });
  await source.refresh();
  const snapshot = source.snapshot();
  assert.equal(snapshot.meta.ok, true);
  assert.equal(snapshot.data.models[0].family, null);
  assert.doesNotMatch(JSON.stringify(snapshot), /private|transcript|token/);
});
