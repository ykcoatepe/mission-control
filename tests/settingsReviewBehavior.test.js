const assert = require('node:assert/strict');
const test = require('node:test');
const { createSettingsService, normalizeMonthlyBudget } = require('../server/services/settingsData');

function fixture(config = {}, { currentError, openclawError, openclaw = '{}' } = {}) {
  const files = new Map([['/fixture/mc-config.json', JSON.stringify(config)], ['/fixture/upload.json', '{}'], ['/fixture/.openclaw/openclaw.json', openclaw]]);
  const writes = [];
  const calls = [];
  const service = createSettingsService({
    mcConfig: structuredClone(config), missionControlConfigPath: '/fixture/mc-config.json', homeDir: '/fixture',
    fsImpl: {
      existsSync: (file) => files.has(file),
      readFileSync(file) {
        if (file === '/fixture/.openclaw/openclaw.json' && openclawError) throw Object.assign(new Error('unreadable'), { code: openclawError });
        if (file === '/fixture/mc-config.json' && currentError) throw Object.assign(new Error('unreadable'), { code: currentError });
        if (!files.has(file)) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
        return files.get(file);
      },
      unlinkSync: (file) => files.delete(file),
    },
    configStore: { persist: (value) => writes.push(structuredClone(value)), importRaw: (value) => writes.push(JSON.parse(value)) },
    openclawExec: async (argv) => calls.push(argv), fetchImpl: async () => ({ ok: true }),
  });
  return { service, files, writes, calls, upload(value) { files.set('/fixture/upload.json', JSON.stringify(value)); return service.importMissionControlConfig('/fixture/upload.json'); } };
}

test('R2 export/import restores redacted scalars, containers and embedded forms byte-identically', () => {
  const original = {
    name: 'Console', gateway: { token: 'SENTINEL_GATEWAY', port: 1234 },
    providers: { apiKeys: ['SENTINEL_ARRAY'], tokens: { primary: 'SENTINEL_OBJECT' } },
    connection: 'postgres://tester:SENTINEL_PASSWORD@localhost/db',
    prose: 'Authorization: Bearer SENTINEL_BEARER',
    nested: [{ note: 'Bearer SENTINEL_ARRAY_BEARER' }, 'password=SENTINEL_INLINE'],
  };
  const f = fixture(original);
  const exported = f.service.getExportConfig();
  assert.doesNotMatch(JSON.stringify(exported), /SENTINEL/);
  assert.match(exported.prose, /\[redacted\]/);
  f.upload(exported);
  assert.deepEqual(f.writes, [original]);
});

test('R2 embedded URL placeholders preserve the whole original value', () => {
  const original = { connection: 'postgres://tester:SENTINEL_PASSWORD@localhost/db' };
  const f = fixture(original);
  f.upload({ connection: 'postgres://tester:[redacted]@localhost/db' });
  assert.deepEqual(f.writes, [original]);
});

test('R2 placeholder without an existing value omits the field or array element', () => {
  const f = fixture({ name: 'Console' });
  f.upload({ name: 'Renamed', providers: { apiKey: '[redacted]' }, notes: ['Bearer [redacted]', 'public'], authorization: 'Bearer [redacted]' });
  assert.deepEqual(f.writes, [{ name: 'Renamed', providers: {}, notes: ['public'] }]);
});

test('R2 validates imported document before any write or upload deletion', () => {
  const f = fixture({ name: 'Console' });
  assert.throws(() => f.upload({ gateway: [] }), { code: 'invalid_config' });
  assert.equal(f.writes.length, 0);
  assert.equal(f.files.has('/fixture/upload.json'), true);
});

test('R4 partial model routing touches only provided fields', async () => {
  const f = fixture();
  await f.service.setModelRouting({ main: 'openai/gpt-6.1-sol' });
  assert.deepEqual(f.calls, [['config', 'set', 'agents.defaults.model.primary', 'openai/gpt-6.1-sol']]);
});

test('R4 explicitly empty heartbeat clears only heartbeat', async () => {
  const f = fixture();
  await f.service.setModelRouting({ heartbeat: '' });
  assert.deepEqual(f.calls, [['config', 'unset', 'agents.defaults.heartbeat.model']]);
});

test('R4 validates every model before the first command, including unsafe later fields', async () => {
  for (const invalid of ['--flag', ' model', 'model name', 'model;echo', 'model\nother', true, null, {}, '']) {
    for (const field of ['main', 'subagent', 'heartbeat']) {
      if (field === 'heartbeat' && invalid === '') continue;
      const f = fixture();
      await assert.rejects(f.service.setModelRouting({ main: 'valid/model:latest', [field]: invalid }), { code: 'invalid_model' });
      assert.equal(f.calls.length, 0, `${field} must reject before writes`);
    }
  }
});

test('R4 budget is a finite nonnegative number or explicit null, without coercion', () => {
  for (const invalid of [undefined, '', [], true, false, '12', {}, -1, NaN, Infinity, -Infinity]) {
    assert.throws(() => normalizeMonthlyBudget(invalid), { statusCode: 400 });
    const f = fixture({ budget: { monthly: 7 } });
    assert.throws(() => f.service.updateBudget(invalid), { statusCode: 400 });
    assert.equal(f.writes.length, 0);
  }
  const f = fixture({ budget: { monthly: 7 } });
  assert.deepEqual(f.service.updateBudget(null), { status: 'saved', budget: { monthly: null } });
  assert.deepEqual(f.writes, [{ budget: { monthly: null } }]);
});

test('R4 invalid budget inside an imported document is rejected before write', () => {
  for (const monthly of ['', '12', true, []]) {
    const f = fixture({ budget: { monthly: 1 } });
    assert.throws(() => f.upload({ budget: { monthly } }), { statusCode: 400 });
    assert.equal(f.writes.length, 0);
  }
});

test('R1 settings RMW rejects corrupted or unreadable current config without overwriting', () => {
  for (const corrupt of ['{', 'null', '[]', '{"gateway":[]}']) {
    for (const mutation of [(f) => f.service.updateBudget(10), (f) => f.service.updateSetup({ dashboardName: 'Changed' }), (f) => f.upload({ name: 'Imported' })]) {
      const f = fixture({ name: 'Loaded fallback' });
      f.files.set('/fixture/mc-config.json', corrupt);
      assert.throws(() => mutation(f), { code: 'settings_config_unavailable' });
      assert.equal(f.writes.length, 0);
      assert.equal(f.files.get('/fixture/mc-config.json'), corrupt);
    }
  }
  const f = fixture({}, { currentError: 'EACCES' });
  assert.throws(() => f.service.updateBudget(10), { code: 'settings_config_unavailable' });
  assert.equal(f.writes.length, 0);
});

test('R1 RMW starts from fresh validated file, preserving other edits', () => {
  const f = fixture({ name: 'Old', modules: { dashboard: true } });
  f.files.set('/fixture/mc-config.json', JSON.stringify({ name: 'Fresh', modules: { dashboard: true, usage: true } }));
  f.service.updateBudget(10);
  assert.deepEqual(f.writes, [{ name: 'Fresh', modules: { dashboard: true, usage: true }, budget: { monthly: 10 } }]);
});

test('R1 corrupt OpenClaw config prevents model and heartbeat CLI writes', async () => {
  for (const openclaw of ['{', 'null', '[]']) {
    const f = fixture({}, { openclaw });
    await assert.rejects(f.service.setModelRouting({ main: 'valid/model' }), { code: 'settings_config_unavailable' });
    await assert.rejects(f.service.setHeartbeatInterval('30m'), { code: 'settings_config_unavailable' });
    assert.equal(f.calls.length, 0);
  }
});

test('R1 unreadable OpenClaw config is not mistaken for a missing config', async () => {
  const f = fixture({}, { openclawError: 'EACCES' });
  await assert.rejects(f.service.setModelRouting({ main: 'valid/model' }), { code: 'settings_config_unavailable' });
  await assert.rejects(f.service.setHeartbeatInterval('30m'), { code: 'settings_config_unavailable' });
  assert.equal(f.calls.length, 0);
});
