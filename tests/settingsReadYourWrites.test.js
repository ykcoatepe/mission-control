'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { createApp } = require('../server/app');
const { loadConfig, createConfigStore } = require('../server/core/config');
const { createSettingsService } = require('../server/services/settingsData');
const { createUsageService } = require('../server/sources/usage');
const { withLiveLoop } = require('./helpers/liveLoop');

async function fixture({ lag = false, failReadAfterWrite = false, failMcAfterWrite = false } = {}) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-settings-ryw-'));
  const mcPath = path.join(rootDir, 'mc-config.json');
  const ocPath = path.join(rootDir, '.openclaw/openclaw.json');
  fs.mkdirSync(path.dirname(ocPath), { recursive: true });
  fs.writeFileSync(mcPath, JSON.stringify({ name: 'Before', budget: { monthly: 5 } }));
  fs.writeFileSync(path.join(rootDir, 'mc-config.default.json'), '{}');
  fs.writeFileSync(path.join(rootDir, 'package.json'), '{"version":"test"}');
  const initial = { agents: { defaults: { model: { primary: 'provider/before' }, subagents: { model: { primary: 'provider/child' } }, heartbeat: { model: 'provider/heartbeat', every: '30m' } } } };
  fs.writeFileSync(ocPath, JSON.stringify(initial));
  const config = loadConfig({ rootDir, homeDir: rootDir, env: { PORT: '0' } });
  const quiet = { log() {}, warn() {}, error() {} };
  const configStore = createConfigStore({ config, logger: quiet });
  const mcConfig = configStore.legacyObject();
  let mcStored = false;
  for (const method of ['persist', 'importRaw']) {
    const operation = configStore[method];
    configStore[method] = (...args) => { const value = operation(...args); mcStored = true; return value; };
  }
  let cliCalls = 0;
  let written = false, readFailure = failReadAfterWrite;
  const fsImpl = new Proxy(fs, { get(target, key) {
    if (key === 'readFileSync') return (file, ...args) => {
      if (file === mcPath && failMcAfterWrite && mcStored) throw new Error('injected committed config read failure');
      if (file === ocPath && readFailure && written) throw new Error('injected post-write read failure');
      return target.readFileSync(file, ...args);
    };
    return target[key];
  } });
  const settingsService = createSettingsService({ mcConfig, configStore, homeDir: rootDir, fsImpl,
    missionControlConfigPath: mcPath, missionControlDefaultConfigPath: path.join(rootDir, 'mc-config.default.json'),
    missionControlPackagePath: path.join(rootDir, 'package.json'), missionControlRoot: rootDir,
    memoryPath: rootDir, skillsPath: rootDir, gatewayPort: 1, fetchImpl: async () => ({ ok: true }),
    openclawExec: async argv => {
      cliCalls++;
      if (argv[1] === 'get') {
        if (readFailure && written) throw new Error('injected upstream config read failure');
        return { stdout: JSON.stringify(JSON.parse(fs.readFileSync(ocPath, 'utf8')).agents.defaults), stderr: '' };
      }
      if (!lag) {
        const value = JSON.parse(fs.readFileSync(ocPath, 'utf8'));
        const parts = argv[2].split('.'); let parent = value;
        for (const key of parts.slice(0, -1)) parent = parent[key] ||= {};
        if (argv[1] === 'unset') delete parent[parts.at(-1)]; else parent[parts.at(-1)] = argv[3];
        fs.writeFileSync(ocPath, JSON.stringify(value));
      }
      written = true; return { stdout: '', stderr: '' };
    },
  });
  const scheduler = { register() {}, start() {}, stop() {}, status: () => ({ jobs: [] }) };
  const runner = { run: async () => ({ ok: false, error: { code: 'test_disabled' }, stdout: '', stderr: '' }), killAll() {}, drain: async () => true, status: () => ({ lanes: {}, children: 0 }) };
  let usageReads = 0;
  const usageService = createUsageService({ providers: [{ id: 'openclaw', label: 'OpenClaw', read: async () => { usageReads++; return { days: [], observedAt: new Date().toISOString(), coverage: 'complete', note: 'Fixture' }; } }], exec: runner, budget: () => mcConfig.budget || {}, scheduler });
  await usageService.refresh();
  const app = createApp({ config, configStore, exec: runner, scheduler, logger: quiet, services: { settingsService, usageService } });
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const port = server.address().port; app.locals.runtime.setBoundPort(port);
  async function request(method, urlPath, value, multipart = false) {
    const boundary = 'mc-settings-test-boundary';
    const body = value === undefined ? null : multipart
      ? `--${boundary}\r\nContent-Disposition: form-data; name="config"; filename="config.json"\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(value)}\r\n--${boundary}--\r\n`
      : JSON.stringify(value);
    return new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: urlPath, method,
        headers: { 'X-MC-Request': '1', Connection: 'close', ...(body ? { 'Content-Type': multipart ? `multipart/form-data; boundary=${boundary}` : 'application/json', 'Content-Length': Buffer.byteLength(body) } : {}) },
      }, res => { let text = ''; res.setEncoding('utf8'); res.on('data', chunk => { text += chunk; }); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text) })); });
      req.on('error', reject); req.end(body);
    });
  }
  return { request, mcPath, ocPath, rootDir, settingsService, usageReads: () => usageReads, cliCalls: () => cliCalls, failReads() { readFailure = true; }, async close() { app.locals.runtime.dispose(); await new Promise(resolve => server.close(resolve)); fs.rmSync(rootDir, { recursive: true, force: true }); } };
}

async function checkBudget(f, monthly) {
  assert.equal(f.usageReads(), 1, 'no usage refresh happened after the write');
  assert.equal((await f.request('GET', '/api/settings')).body.budget.monthly, monthly);
  assert.equal((await f.request('GET', '/api/usage/summary')).body.data.budget.monthly, monthly);
  assert.equal((await f.request('GET', '/api/costs')).body.budget.monthly, monthly);
}

test('settings HTTP budget write is already visible to settings, usage summary and costs without a scheduler tick', async () => withLiveLoop(async () => {
  const f = await fixture();
  try {
    const saved = await f.request('POST', '/api/settings/budget', { monthly: 41 }); assert.equal(saved.status, 200); assert.equal(saved.body.budget.monthly, 41); assert.equal(saved.body.meta.stale, false);
    await checkBudget(f, 41);
  } finally { await f.close(); }
}));

test('settings HTTP import publishes the new config and budget to every immediate consumer', async () => withLiveLoop(async () => {
  const f = await fixture();
  try {
    const saved = await f.request('POST', '/api/settings/import', { name: 'Imported', budget: { monthly: 71 } }, true); assert.equal(saved.status, 200);
    assert.equal(saved.body.config.name, 'Imported'); assert.equal(saved.body.meta.stale, false);
    assert.equal((await f.request('GET', '/api/config')).body.name, 'Imported');
    assert.equal((await f.request('GET', '/api/setup')).body.detectedConfig.dashboardName, 'Imported');
    await checkBudget(f, 71);
  } finally { await f.close(); }
}));

for (const mode of ['immediate', 'lagged', 'failed']) {
  test(`settings HTTP model routing is observed rather than requested with ${mode} post-write read`, async () => withLiveLoop(async () => {
    const f = await fixture({ lag: mode === 'lagged', failReadAfterWrite: mode === 'failed' });
    try {
      const saved = await f.request('POST', '/api/settings/model-routing', { main: 'provider/saved', heartbeat: '' });
      assert.equal(saved.status, mode === 'lagged' ? 409 : 200);
      if (mode === 'lagged') assert.equal(saved.body.error.code, 'upstream_rejected');
      else {
        assert.equal(saved.body.verified, mode === 'immediate');
        assert.equal(saved.body.entity.verified, mode === 'immediate');
        assert.equal(saved.body.meta.stale, mode === 'failed');
      }
      const read = await f.request('GET', '/api/settings/model-routing');
      assert.equal(read.status, 200); assert.equal(read.body.main, mode === 'immediate' ? 'provider/saved' : 'provider/before');
      assert.equal(read.body.heartbeat, mode === 'immediate' ? null : 'provider/heartbeat');
      const settings = await f.request('GET', '/api/settings'); assert.equal(settings.status, 200);
      assert.equal(settings.body.model, mode === 'immediate' ? 'provider/saved' : 'provider/before');
    } finally { await f.close(); }
  }));
  test(`settings HTTP heartbeat is observed rather than requested with ${mode} post-write read`, async () => withLiveLoop(async () => {
    const f = await fixture({ lag: mode === 'lagged', failReadAfterWrite: mode === 'failed' });
    try {
      const saved = await f.request('POST', '/api/settings/heartbeat', { interval: '17m' });
      assert.equal(saved.status, mode === 'lagged' ? 409 : 200);
      if (mode === 'lagged') assert.equal(saved.body.error.code, 'upstream_rejected');
      else { assert.equal(saved.body.verified, mode === 'immediate'); assert.equal(saved.body.meta.stale, mode === 'failed'); }
      const read = await f.request('GET', '/api/settings/heartbeat'); assert.equal(read.status, 200);
      assert.equal(read.body.interval, mode === 'immediate' ? '17m' : '30m');
    } finally { await f.close(); }
  }));
}

test('settings HTTP setup write is already visible immediately and returns public fields only', async () => withLiveLoop(async () => {
  const f = await fixture();
  try {
    const saved = await f.request('POST', '/api/setup', { dashboardName: 'Saved setup' }); assert.equal(saved.status, 200);
    assert.equal(saved.body.config.name, 'Saved setup');
    assert.equal((await f.request('GET', '/api/setup')).body.detectedConfig.dashboardName, 'Saved setup');
    assert.equal((await f.request('GET', '/api/config')).body.name, 'Saved setup');
  } finally { await f.close(); }
}));

for (const kind of ['model', 'heartbeat']) {
  test(`settings HTTP confirmed ${kind} remains last-good when a later local read fails`, async () => withLiveLoop(async () => {
    const f = await fixture();
    try {
      const url = kind === 'model' ? '/api/settings/model-routing' : '/api/settings/heartbeat';
      const body = kind === 'model' ? { main: 'provider/confirmed' } : { interval: '21m' };
      assert.equal((await f.request('POST', url, body)).status, 200);
      f.failReads();
      const read = await f.request('GET', url);
      assert.equal(read.status, 200);
      assert.equal(read.body[kind === 'model' ? 'main' : 'interval'], kind === 'model' ? 'provider/confirmed' : '21m');
      assert.equal(read.body.meta.stale, true);
    } finally { await f.close(); }
  }));
}

test('settings HTTP write projection retires on confirmation and preserves independent physical-file edits', async () => withLiveLoop(async () => {
  const f = await fixture();
  try {
    const written = await f.request('POST', '/api/settings/model-routing', { main: 'provider/saved' });
    assert.equal(written.body.verified, true);
    const physical = JSON.parse(fs.readFileSync(f.ocPath, 'utf8'));
    physical.agents.defaults.model.primary = 'provider/saved';
    physical.agents.defaults.subagents.model.primary = 'provider/external-child';
    fs.writeFileSync(f.ocPath, JSON.stringify(physical));
    let read = await f.request('GET', '/api/settings/model-routing');
    assert.equal(read.body.main, 'provider/saved'); assert.equal(read.body.subagent, 'provider/external-child'); assert.equal(read.body.meta.stale, false);
    physical.agents.defaults.model.primary = 'provider/external-main'; fs.writeFileSync(f.ocPath, JSON.stringify(physical));
    read = await f.request('GET', '/api/settings/model-routing'); assert.equal(read.body.main, 'provider/external-main');
  } finally { await f.close(); }
}));

test('settings HTTP confirmed routing does not regress when the local config temporarily disappears', async () => withLiveLoop(async () => {
  const f = await fixture();
  try {
    await f.request('POST', '/api/settings/model-routing', { main: 'provider/confirmed' });
    fs.unlinkSync(f.ocPath);
    const read = await f.request('GET', '/api/settings/model-routing');
    assert.equal(read.status, 200); assert.equal(read.body.main, 'provider/confirmed'); assert.equal(read.body.meta.stale, true);
  } finally { await f.close(); }
}));


test('settings HTTP an unverified successful command never permits another write through a corrupt config', async () => withLiveLoop(async () => {
  const f = await fixture({ failReadAfterWrite: true });
  try {
    const sent = await f.request('POST', '/api/settings/model-routing', { main: 'provider/saved' });
    assert.equal(sent.status, 200); assert.equal(sent.body.verified, false);
    const calls = f.cliCalls();
    fs.writeFileSync(f.ocPath, '{truncated');
    const refused = await f.request('POST', '/api/settings/heartbeat', { interval: '18m' });
    assert.equal(refused.status, 503); assert.equal(f.cliCalls(), calls);
    const read = await f.request('GET', '/api/settings');
    assert.equal(read.status, 200); assert.equal(read.body.model, 'provider/before'); assert.equal(read.body.meta.stale, true);
  } finally { await f.close(); }
}));

test('settings HTTP import removal removes old in-memory fields and budget consumers do not invent zero', async () => withLiveLoop(async () => {
  const f = await fixture();
  try {
    const saved = await f.request('POST', '/api/settings/import', { name: 'No budget' }, true);
    assert.equal(saved.status, 200); assert.equal(saved.body.budget.monthly, null);
    assert.equal((await f.request('GET', '/api/settings')).body.budget.monthly, null);
    assert.equal((await f.request('GET', '/api/usage/summary')).body.data.budget.monthly, null);
    assert.equal(Object.hasOwn((await f.request('GET', '/api/costs')).body.budget, 'monthly'), false);
    assert.equal(f.usageReads(), 1);
  } finally { await f.close(); }
}));


for (const route of ['budget', 'setup', 'import']) {
  test(`settings HTTP ${route} committed state survives a failed following setup read`, async () => withLiveLoop(async () => {
    const f = await fixture({ failMcAfterWrite: true });
    try {
      const writePath = route === 'setup' ? '/api/setup' : `/api/settings/${route}`;
      const body = route === 'budget' ? { monthly: 81 } : route === 'setup' ? { dashboardName: 'Saved' } : { name: 'Saved', budget: { monthly: 82 } };
      const saved = await f.request('POST', writePath, body, route === 'import'); assert.equal(saved.status, 200);
      const setup = await f.request('GET', '/api/setup');
      assert.equal(setup.status, 200); assert.equal(setup.body.detectedConfig.dashboardName, route === 'budget' ? 'Before' : 'Saved');
      assert.equal(setup.body.meta.stale, true);
      const config = await f.request('GET', '/api/config'); assert.equal(config.body.name, route === 'budget' ? 'Before' : 'Saved');
      if (route !== 'setup') await checkBudget(f, route === 'budget' ? 81 : 82);
    } finally { await f.close(); }
  }));
}

for (const route of ['setup', 'import']) {
  for (const failMcAfterWrite of [false, true]) {
    test(`settings HTTP ${route} exposes the saved configured gateway port without claiming activation${failMcAfterWrite ? ' despite a failed file read' : ''}`, async () => withLiveLoop(async () => {
      const f = await fixture({ failMcAfterWrite });
      try {
        const value = route === 'setup' ? { gateway: { port: 18888, token: 'PRIVATE_PORT_SENTINEL' } } : { name: 'Port import', gateway: { port: 18888, token: 'PRIVATE_PORT_SENTINEL' } };
        const saved = await f.request('POST', route === 'setup' ? '/api/setup' : '/api/settings/import', value, route === 'import');
        assert.equal(saved.status, 200); assert.equal(saved.body.configuredGatewayPort, 18888);
        const setup = await f.request('GET', '/api/setup');
        assert.equal(setup.status, 200); assert.equal(setup.body.configuredGatewayPort, 18888); assert.equal(setup.body.gatewayPort, 1);
        const settings = await f.request('GET', '/api/settings');
        assert.equal(settings.body.configuredGatewayPort, 18888); assert.equal(settings.body.gateway_port, 1);
        const publicConfig = await f.request('GET', '/api/config');
        assert.equal(Object.hasOwn(publicConfig.body, 'gateway'), false, 'the core public-config allowlist still excludes gateway');
        assert.equal(JSON.stringify([saved.body, setup.body, settings.body, publicConfig.body]).includes('PRIVATE_PORT_SENTINEL'), false);
      } finally { await f.close(); }
    }));
  }
}

for (const mutation of ['budget', 'setup', 'import']) {
  for (const failure of ['corrupt', 'missing']) {
    test(`settings HTTP ${mutation} saved MC values remain visible when OC config is ${failure} before any OC mutation`, async () => withLiveLoop(async () => {
      const f = await fixture();
      try {
        const route = mutation === 'setup' ? '/api/setup' : `/api/settings/${mutation}`;
        const body = mutation === 'budget' ? { monthly: 42 }
          : mutation === 'setup' ? { dashboardName: 'Saved setup', gateway: { port: 18888 } }
            : { name: 'Saved import', budget: { monthly: 43 }, gateway: { port: 18889 } };
        assert.equal((await f.request('POST', route, body, mutation === 'import')).status, 200);
        assert.equal(f.cliCalls(), 0);
        if (failure === 'missing') fs.unlinkSync(f.ocPath); else fs.writeFileSync(f.ocPath, '{corrupt');
        const read = await f.request('GET', '/api/settings');
        assert.equal(read.status, 200);
        assert.equal(read.body.budget.monthly, mutation === 'budget' ? 42 : mutation === 'import' ? 43 : 5);
        assert.equal(read.body.configuredGatewayPort, mutation === 'setup' ? 18888 : mutation === 'import' ? 18889 : null);
        assert.equal(read.body.model, null); assert.equal(read.body.meta.stale, true);
        assert.equal(read.body.meta.error.code, 'settings_config_unavailable');
        if (failure === 'corrupt') {
          assert.equal((await f.request('POST', '/api/settings/heartbeat', { interval: '9m' })).status, 503);
        }
        assert.equal(f.cliCalls(), 0);
      } finally { await f.close(); }
    }));
  }
}


test('settings HTTP MC-only save retains an observed model when the following OC read fails', async () => withLiveLoop(async () => {
  const f = await fixture();
  try {
    assert.equal((await f.request('GET', '/api/settings')).body.model, 'provider/before');
    assert.equal((await f.request('POST', '/api/settings/budget', { monthly: 42 })).status, 200);
    fs.writeFileSync(f.ocPath, '{corrupt');
    const read = await f.request('GET', '/api/settings');
    assert.equal(read.status, 200); assert.equal(read.body.budget.monthly, 42);
    assert.equal(read.body.model, 'provider/before'); assert.equal(read.body.meta.stale, true);
    const routing = await f.request('GET', '/api/settings/model-routing');
    assert.equal(routing.body.main, 'provider/before'); assert.equal(routing.body.meta.stale, true);
    const heartbeat = await f.request('GET', '/api/settings/heartbeat');
    assert.equal(heartbeat.body.interval, '30m'); assert.equal(heartbeat.body.meta.stale, true);
    assert.equal(f.cliCalls(), 0);
  } finally { await f.close(); }
}));
