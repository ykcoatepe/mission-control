'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const { createApp } = require('../server/app');
const { loadConfig, createConfigStore } = require('../server/core/config');
const { createSettingsService } = require('../server/services/settingsData');
const { withLiveLoop } = require('./helpers/liveLoop');

async function fixture(mode = 'observed') {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-settings-verified-'));
  const ocPath = path.join(rootDir, '.openclaw/openclaw.json'); fs.mkdirSync(path.dirname(ocPath), { recursive: true });
  const mcPath = path.join(rootDir, 'mc-config.json'); fs.writeFileSync(mcPath, '{"name":"Test"}');
  fs.writeFileSync(path.join(rootDir, 'package.json'), '{"version":"test"}');
  const initial = { agents: { defaults: { model: { primary: 'provider/before' }, subagents: { model: { primary: 'provider/child' } }, heartbeat: { model: 'provider/heartbeat', every: '30m' } } } };
  let upstream = structuredClone(initial); fs.writeFileSync(ocPath, JSON.stringify(initial));
  const calls = []; let behavior = mode, heldRead = null;
  const runner = { async run(bin, argv, options) {
    calls.push({ bin, argv, options });
    if (argv[0] !== 'config') return { ok: false, error: { code: 'test_disabled' } };
    if (argv[1] === 'get') {
      if (heldRead && !heldRead.started) {
        heldRead.started = true;
        const result = heldRead.result || { ok: true, stdout: JSON.stringify(upstream.agents.defaults), stderr: '' };
        heldRead.onStart();
        await heldRead.promise;
        heldRead = null;
        return result;
      }
      if (behavior === 'read-failed') return { ok: false, error: { code: 'fake_read_failure' } };
      if (behavior === 'malformed') return { ok: true, stdout: 'not JSON', stderr: '' };
      if (behavior === 'private-field') return { ok: true, stdout: JSON.stringify({ model: { primary: 'sk-SENTINEL123456789012345678901234567890' } }), stderr: '' };
      return { ok: true, stdout: JSON.stringify(upstream.agents.defaults), stderr: '' };
    }
    if (behavior === 'command-failed') return { ok: false, error: { code: 'fake_command_failure' } };
    if (behavior !== 'rejected') {
      const keys = argv[2].split('.'); let value = upstream;
      for (const key of keys.slice(0, -1)) value = value[key] ||= {};
      if (argv[1] === 'unset') delete value[keys.at(-1)]; else value[keys.at(-1)] = argv[3];
      fs.writeFileSync(ocPath, JSON.stringify(upstream));
    }
    return { ok: true, stdout: '', stderr: '' };
  }, killAll() {}, drain: async () => true, status: () => ({ lanes: {}, children: 0 }) };
  const config = loadConfig({ rootDir, homeDir: rootDir, env: { PORT: '0' } });
  const quiet = { log() {}, warn() {}, error() {} };
  const configStore = createConfigStore({ config, logger: quiet });
  const settingsService = createSettingsService({ mcConfig: configStore.legacyObject(), configStore, homeDir: rootDir,
    missionControlConfigPath: mcPath, missionControlPackagePath: path.join(rootDir, 'package.json'), missionControlRoot: rootDir,
    fetchImpl: async () => ({ ok: true }),
    openclawExec: async (args, timeoutMs) => {
      const result = await runner.run('fake-openclaw', args, { lane: 'openclaw', timeoutMs });
      if (!result.ok) throw Object.assign(new Error('The fake command failed'), { code: result.error.code });
      return result;
    },
  });
  const app = createApp({ config, configStore, exec: runner, scheduler: { register() {}, start() {}, stop() {}, status: () => [] }, services: { settingsService }, logger: quiet });
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const port = server.address().port; app.locals.runtime.setBoundPort(port);
  const request = (method, url, data) => new Promise((resolve, reject) => {
    const body = data === undefined ? '' : JSON.stringify(data);
    const req = http.request({ host: '127.0.0.1', port, path: url, method, headers: { 'X-MC-Request': '1', 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), Connection: 'close' } }, res => {
      let text = ''; res.on('data', part => { text += part; }); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text) }));
    }); req.on('error', reject); req.end(body);
  });
  return { request, calls, settingsService, setMode(value) { behavior = value; }, holdNextRead(result = null) {
    let release, started;
    const promise = new Promise(resolve => { release = resolve; });
    const whenStarted = new Promise(resolve => { started = resolve; });
    heldRead = { promise, onStart: started, started: false, result };
    return { release, whenStarted };
  }, upstream: () => upstream, async close() { app.locals.runtime.dispose(); await new Promise(resolve => server.close(resolve)); fs.rmSync(rootDir, { recursive: true, force: true }); } };
}

for (const [label, result] of [
  ['failed', { ok: false, error: { code: 'fake_read_failure' } }],
  ['malformed', { ok: true, stdout: 'not JSON', stderr: '' }],
]) {
  test(`verified settings late ${label} reconciliation cannot downgrade a newer verified observation`, async () => withLiveLoop(async () => {
    const f = await fixture('read-failed'); let held, oldRead;
    try {
      await f.request('POST', '/api/settings/model-routing', { main: 'provider/first' });
      f.setMode('observed'); held = f.holdNextRead(result);
      oldRead = f.settingsService.refreshExternalWrites();
      await held.whenStarted;
      const saved = await f.request('POST', '/api/settings/model-routing', { main: 'provider/latest' });
      assert.equal(saved.status, 200); assert.equal(saved.body.verified, true);
      held.release(); await oldRead;
      const current = await f.request('GET', '/api/settings/model-routing');
      assert.equal(current.body.main, 'provider/latest'); assert.equal(current.body.verified, true);
      assert.deepEqual(await f.settingsService.refreshExternalWrites(), { verified: true, pending: false });
    } finally {
      held?.release(); if (oldRead) await oldRead;
      await f.close();
    }
  }));
}
for (const kind of ['model-routing', 'heartbeat']) for (const mode of ['observed', 'rejected', 'command-failed', 'read-failed']) {
  test(`verified settings HTTP ${kind}: ${mode}`, async () => withLiveLoop(async () => {
    const f = await fixture(mode);
    try {
      const field = kind === 'heartbeat' ? 'interval' : 'main';
      const before = kind === 'heartbeat' ? '30m' : 'provider/before';
      const requested = kind === 'heartbeat' ? '17m' : 'provider/after';
      const saved = await f.request('POST', '/api/settings/' + kind, { [field]: requested });
      if (mode === 'observed') {
        assert.equal(saved.status, 200); assert.equal(saved.body.verified, true); assert.equal(saved.body.entity.verified, true); assert.equal(saved.body[field], requested);
        assert.equal((await f.request('GET', '/api/settings/' + kind)).body[field], requested);
      } else if (mode === 'rejected') {
        assert.equal(saved.status, 409); assert.equal(saved.body.error.code, 'upstream_rejected');
        assert.match(saved.body.error.message, /OpenClaw reports/);
        const actual = await f.request('GET', '/api/settings/' + kind); assert.equal(actual.body[field], before);
      } else if (mode === 'command-failed') {
        assert.ok(saved.status >= 400); assert.equal((await f.request('GET', '/api/settings/' + kind)).body[field], before);
        assert.equal(f.calls.filter(call => call.argv[1] === 'get').length, 0);
      } else {
        assert.equal(saved.status, 200); assert.equal(saved.body.verified, false); assert.equal(saved.body.entity.verified, false); assert.equal(saved.body.meta.stale, true);
        assert.equal(saved.body[field], before, 'an unconfirmed request is never published as observed');
        assert.equal((await f.request('GET', '/api/settings/' + kind)).body[field], before);
      }
      if (mode !== 'command-failed') {
        const read = f.calls.find(call => call.argv[1] === 'get'); assert.ok(read);
        assert.deepEqual(read.argv, ['config', 'get', 'agents.defaults', '--json']);
        assert.equal(read.options.lane, 'openclaw'); assert.ok(read.options.timeoutMs > 0 && read.options.timeoutMs <= 10000);
      }
    } finally { await f.close(); }
  }));
}
for (const mode of ['observed', 'rejected']) test(`verified settings heartbeat model unset: ${mode}`, async () => withLiveLoop(async () => {
  const f = await fixture(mode);
  try {
    const saved = await f.request('POST', '/api/settings/model-routing', { heartbeat: '' });
    assert.equal(saved.status, mode === 'observed' ? 200 : 409);
    assert.equal((await f.request('GET', '/api/settings/model-routing')).body.heartbeat, mode === 'observed' ? null : 'provider/heartbeat');
  } finally { await f.close(); }
}));


for (const kind of ['model-routing', 'heartbeat']) test(`verified settings scheduled reconciliation confirms a previously unreadable ${kind} result`, async () => withLiveLoop(async () => {
  const f = await fixture('read-failed');
  try {
    const field = kind === 'heartbeat' ? 'interval' : 'main';
    const value = kind === 'heartbeat' ? '13m' : 'provider/confirmed';
    const sent = await f.request('POST', '/api/settings/' + kind, { [field]: value });
    assert.equal(sent.status, 200); assert.equal(sent.body.verified, false);
    f.setMode('observed');
    assert.deepEqual(await f.settingsService.refreshExternalWrites(), { verified: true, pending: false });
    const confirmed = await f.request('GET', '/api/settings/' + kind);
    assert.equal(confirmed.body[field], value); assert.equal(confirmed.body.verified, true);
    const calls = f.calls.length;
    await f.settingsService.refreshExternalWrites();
    assert.equal(f.calls.length, calls, 'settled writes cause no background CLI polling');
    assert.equal(f.calls.filter(call => call.argv[1] === 'set').length, 1, 'reconciliation never repeats a mutation');
  } finally { await f.close(); }
}));
for (const mode of ['malformed', 'private-field']) test(`verified settings ${mode} read-back never leaks or claims the requested model`, async () => withLiveLoop(async () => {
  const f = await fixture(mode);
  try {
    const write = await f.request('POST', '/api/settings/model-routing', { main: 'provider/clean' });
    assert.equal(write.status, 409); assert.equal(write.body.error.code, 'upstream_unverified');
    const current = await f.request('GET', '/api/settings/model-routing');
    assert.equal(current.body.main, 'provider/before'); assert.equal(current.body.verified, false);
    assert.equal(JSON.stringify([write.body, current.body]).includes('SENTINEL'), false);
  } finally { await f.close(); }
}));

for (const [firstKind, lastKind] of [['model-routing', 'model-routing'], ['heartbeat', 'heartbeat'], ['model-routing', 'heartbeat']]) {
  test(`verified settings ${firstKind} old in-flight reconciliation cannot replace newer ${lastKind} observation`, async () => withLiveLoop(async () => {
    const f = await fixture('read-failed'); let held, oldRead;
    try {
      const firstField = firstKind === 'heartbeat' ? 'interval' : 'main';
      const lastField = lastKind === 'heartbeat' ? 'interval' : 'main';
      const firstValue = firstKind === 'heartbeat' ? '11m' : 'provider/first';
      const lastValue = lastKind === 'heartbeat' ? '19m' : 'provider/latest';
      const sent = await f.request('POST', '/api/settings/' + firstKind, { [firstField]: firstValue });
      assert.equal(sent.status, 200); assert.equal(sent.body.verified, false);
      f.setMode('observed'); held = f.holdNextRead();
      oldRead = f.settingsService.refreshExternalWrites();
      await held.whenStarted;
      const latest = await f.request('POST', '/api/settings/' + lastKind, { [lastField]: lastValue });
      assert.equal(latest.status, 200); assert.equal(latest.body.verified, true);
      held.release(); await oldRead;
      const current = await f.request('GET', '/api/settings/' + lastKind);
      assert.equal(current.body[lastField], lastValue, 'a pre-observation read must not roll back a verified config field');
      assert.equal(current.body.verified, true);
    } finally {
      held?.release(); if (oldRead) await oldRead;
      await f.close();
    }
  }));
}
