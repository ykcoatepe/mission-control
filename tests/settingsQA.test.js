const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createSettingsService } = require('../server/services/settingsData');
const { buildSettingsRouter } = require('../server/routes/settings');

function fixture({ config = {}, raw, readError, mcConfig = {}, identityName = null } = {}) {
  const calls = [];
  const openclawPath = '/fixture/.openclaw/openclaw.json';
  return {
    calls,
    service: createSettingsService({
      mcConfig, homeDir: '/fixture', missionControlConfigPath: '/fixture/mc-config.json',
      fsImpl: {
        existsSync: (file) => file === openclawPath,
        readFileSync(file) {
          if (file === '/fixture/workspace/IDENTITY.md' && identityName) return `**Name:** ${identityName}`;
          if (file !== openclawPath) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
          if (readError) throw Object.assign(new Error('SENTINEL_SECRET'), { code: readError });
          return raw ?? JSON.stringify(config);
        },
      },
      openclawExec: async (...args) => calls.push(args),
      fetchImpl: async () => { throw new Error('No network allowed'); },
    }),
  };
}

async function routePayload(service) {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-settings-qa-'));
  try {
    const router = buildSettingsRouter({ settingsService: service, projectRoot });
    const layer = router.stack.find((entry) => entry.route?.path === '/api/settings/model-routing' && entry.route.methods.get);
    let payload;
    let failure;
    await layer.route.stack[0].handle({}, { json(value) { payload = value; } }, (error) => { failure = error; });
    if (failure) throw failure;
    return payload;
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
}

test('settings QA: unset inherited models remain null with unset origins rather than copying main', async () => {
  const f = fixture({ config: { agents: { defaults: { model: { primary: 'provider/main' }, heartbeat: { model: null } } } } });
  const payload = await routePayload(f.service);
  assert.equal(payload.main, 'provider/main');
  assert.equal(payload.mainSource, 'set');
  assert.equal(payload.subagent, null);
  assert.equal(payload.subagentSource, 'unset');
  assert.equal(payload.heartbeat, null);
  assert.equal(payload.heartbeatSource, 'unset');
  assert.equal(payload.meta.ok, true);
  assert.equal(payload.meta.stale, false);
  assert.equal(f.calls.length, 0);
});

test('settings QA: all configured routing strings carry set origins', async () => {
  const f = fixture({ config: { agents: { defaults: { model: { primary: 'provider/main' }, subagents: { model: { primary: 'provider/child' } }, heartbeat: { model: 'provider/heartbeat' } } } } });
  const payload = await routePayload(f.service);
  assert.deepEqual([payload.main, payload.subagent, payload.heartbeat], ['provider/main', 'provider/child', 'provider/heartbeat']);
  assert.deepEqual([payload.mainSource, payload.subagentSource, payload.heartbeatSource], ['set', 'set', 'set']);
  assert.equal(payload.meta.ok, true);
});

test('settings QA: unreadable or missing config gives null/unreadable fields and honest metadata; writes still fail closed', async () => {
  for (const options of [{ readError: 'EACCES' }, { readError: 'ENOENT' }, { raw: '{' }, { raw: '[]' }]) {
    const f = fixture(options);
    const payload = await routePayload(f.service);
    assert.deepEqual([payload.main, payload.subagent, payload.heartbeat], [null, null, null]);
    assert.deepEqual([payload.mainSource, payload.subagentSource, payload.heartbeatSource], ['unreadable', 'unreadable', 'unreadable']);
    assert.equal(payload.meta.ok, false);
    assert.equal(payload.meta.stale, true);
    assert.equal(payload.meta.observedAt, null);
    assert.equal(payload.meta.error.code, 'settings_config_unavailable');
    assert.doesNotMatch(JSON.stringify(payload), /SENTINEL/);
    if (options.readError !== 'ENOENT') {
      await assert.rejects(f.service.setModelRouting({ main: 'provider/new' }), { code: 'settings_config_unavailable' });
      assert.equal(f.calls.length, 0);
    }
  }
});

test('settings QA: invalid field types are unreadable while valid siblings remain observed', async () => {
  for (const invalid of [[], {}, 42, true]) {
    const f = fixture({ config: { agents: { defaults: { model: { primary: 'provider/main' }, subagents: { model: { primary: invalid } }, heartbeat: { model: 'provider/heartbeat' } } } } });
    const payload = await routePayload(f.service);
    assert.equal(payload.mainSource, 'set');
    assert.equal(payload.subagent, null);
    assert.equal(payload.subagentSource, 'unreadable');
    assert.equal(payload.heartbeatSource, 'set');
    assert.equal(payload.meta.ok, false);
    assert.equal(payload.meta.stale, true);
    assert.ok(Number.isFinite(Date.parse(payload.meta.observedAt)));
  }
  const malformedParent = await routePayload(fixture({ config: { agents: { defaults: { model: [], subagents: null, heartbeat: { model: null } } } } }).service);
  assert.equal(malformedParent.mainSource, 'unreadable');
  assert.equal(malformedParent.subagentSource, 'unset');
  assert.equal(malformedParent.heartbeatSource, 'unset');
});

test('settings QA: setup dashboard name comes only from configured public dashboard name', async () => {
  for (const [mcConfig, expected] of [[{}, null], [{ name: '' }, null], [{ name: 42 }, null], [{ name: 'My Console' }, 'My Console'], [{ name: 'Mission Control' }, 'Mission Control']]) {
    const f = fixture({ mcConfig, identityName: 'Configured Agent', config: { agents: { defaults: { workspace: '/fixture/workspace' } } } });
    const setup = await f.service.getSetupStatus();
    assert.equal(setup.detectedConfig.dashboardName, expected);
    assert.equal(setup.detectedConfig.agentName, 'Configured Agent');
  }
});


test('settings QA: readable empty routing is unset and configured dashboard changes are read currently', async () => {
  const mcConfig = { name: 'Original Console' };
  const f = fixture({ mcConfig, config: {} });
  const payload = await routePayload(f.service);
  assert.deepEqual([payload.main, payload.subagent, payload.heartbeat], [null, null, null]);
  assert.deepEqual([payload.mainSource, payload.subagentSource, payload.heartbeatSource], ['unset', 'unset', 'unset']);
  assert.equal(payload.meta.ok, true);
  assert.equal(payload.meta.error, null);
  assert.equal((await f.service.getSetupStatus()).detectedConfig.dashboardName, 'Original Console');
  mcConfig.name = 'Current Console';
  assert.equal((await f.service.getSetupStatus()).detectedConfig.dashboardName, 'Current Console');
});
