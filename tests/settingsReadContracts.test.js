const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createSettingsService } = require('../server/services/settingsData');
const { buildSettingsRouter } = require('../server/routes/settings');

async function invoke(router, method, routePath, body, headers = {}) {
  const route = router.stack.find((layer) => layer.route?.path === routePath && layer.route.methods[method]).route;
  let payload;
  let failure;
  const response = { json(value) { payload = value; return this; }, setHeader(name, value) { headers[name] = value; } };
  await route.stack[0].handle({ body }, response, (error) => { failure = error; });
  if (failure) throw failure;
  return payload;
}

test('settings GETs never start a probe, write config, or serve a raw export', async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-settings-contract-'));
  const forbidden = () => { throw new Error('GET attempted an upstream probe or write'); };
  const service = createSettingsService({
    mcConfig: { name: 'Console', nested: { api_key: 'secret-sentinel' } },
    fsImpl: {
      existsSync: () => false,
      readFileSync: () => '{"version":"test"}',
      writeFileSync: forbidden, unlinkSync: forbidden,
    },
    openclawExec: forbidden,
    fetchImpl: forbidden,
    configStore: { persist: forbidden, importRaw: forbidden },
    homeDir: projectRoot,
    missionControlConfigPath: path.join(projectRoot, 'mc-config.json'),
  });
  try {
    const router = buildSettingsRouter({ settingsService: service, projectRoot });
    for (const routePath of ['/api/config', '/api/setup', '/api/settings', '/api/settings/model-routing', '/api/settings/heartbeat', '/api/settings/export']) {
      const payload = await invoke(router, 'get', routePath);
      assert.doesNotMatch(JSON.stringify(payload), /secret-sentinel/);
    }
    const exportHeaders = {};
    const exported = await invoke(router, 'get', '/api/settings/export', undefined, exportHeaders);
    assert.equal(Object.hasOwn(exported, 'meta'), false, 'download remains a config object');
    const exportMeta = JSON.parse(exportHeaders['X-MC-Source-Meta']);
    assert.equal(exportMeta.source, 'settings.local-config');
    assert.equal(exportMeta.ok, true);
    assert.equal(exportMeta.stale, false);
    assert.equal(exportMeta.ageMs, 0);
    assert.ok(Number.isFinite(Date.parse(exportMeta.observedAt)));
    assert.equal((await invoke(router, 'get', '/api/settings')).model, null);
    assert.equal((await invoke(router, 'get', '/api/settings/heartbeat')).interval, null);
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('settings client validation reaches the common error path', async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-settings-errors-'));
  const service = createSettingsService({ mcConfig: {} });
  try {
    const router = buildSettingsRouter({ settingsService: service, projectRoot });
    await assert.rejects(invoke(router, 'post', '/api/settings/heartbeat', { interval: { bad: true } }), { status: 400, code: 'invalid_interval' });
    await assert.rejects(invoke(router, 'post', '/api/settings/budget', { monthly: -1 }), { statusCode: 400 });
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});
