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
    nested: [{ id: 'note-a', note: 'Bearer SENTINEL_ARRAY_BEARER' }, { id: 'note-b', note: 'password=SENTINEL_INLINE' }],
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

test('R2 placeholder without an existing object-path value omits the field', () => {
  const f = fixture({ name: 'Console' });
  f.upload({ name: 'Renamed', providers: { apiKey: '[redacted]' }, authorization: 'Bearer [redacted]' });
  assert.deepEqual(f.writes, [{ name: 'Renamed', providers: {} }]);
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


test('array identity: reordered providers retain their own secrets', () => {
  const original = { providers: [{ name: 'alpha', apiKey: 'SECRET_ALPHA' }, { name: 'beta', apiKey: 'SECRET_BETA' }] };
  const f = fixture(original);
  const exported = f.service.getExportConfig();
  assert.doesNotMatch(JSON.stringify(exported), /SECRET_/);
  exported.providers.reverse();
  f.upload(exported);
  assert.deepEqual(f.writes, [{ providers: [original.providers[1], original.providers[0]] }]);
});

test('array identity: renamed, missing or redacted identities reject safely without write or delete', () => {
  const originals = [
    { name: 'IDENTITY_PRIVATE', apiKey: 'SECRET_PRIVATE' },
    { id: 'IDENTITY_PRIVATE', name: 'weaker', apiKey: 'SECRET_PRIVATE' },
    { key: 'IDENTITY_PRIVATE', apiKey: 'SECRET_PRIVATE' },
  ];
  for (const current of originals) {
    const f = fixture({ providers: [current] });
    const exported = f.service.getExportConfig();
    const identity = Object.hasOwn(current, 'id') ? 'id' : Object.hasOwn(current, 'name') ? 'name' : 'key';
    exported.providers[0][identity] = 'RENAMED_PRIVATE';
    assert.throws(() => f.upload(exported), (error) => {
      assert.equal(error.status, 400);
      assert.match(error.message, /\$.*\[0\]/);
      assert.doesNotMatch(error.message, /IDENTITY_PRIVATE|RENAMED_PRIVATE|SECRET_PRIVATE/);
      return true;
    });
    assert.equal(f.writes.length, 0);
    assert.equal(f.files.has('/fixture/upload.json'), true);
  }
});

test('array identity: a stronger id cannot fall back to a matching weaker name', () => {
  for (const imported of [
    { name: 'shared', apiKey: '[redacted]' },
    { id: 'changed', name: 'shared', apiKey: '[redacted]' },
  ]) {
    const f = fixture({ providers: [{ id: 'stable', name: 'shared', apiKey: 'SECRET_STABLE' }] });
    assert.throws(() => f.upload({ providers: [imported] }), { status: 400 });
    assert.equal(f.writes.length, 0);
    assert.equal(f.files.has('/fixture/upload.json'), true);
  }
});

test('array identity: duplicate imported or current identities reject before write or delete', () => {
  for (const duplicateCurrent of [false, true]) {
    const current = duplicateCurrent
      ? [{ id: 'same', apiKey: 'SECRET_ONE' }, { id: 'same', apiKey: 'SECRET_TWO' }]
      : [{ id: 'same', apiKey: 'SECRET_ONE' }, { id: 'other', apiKey: 'SECRET_TWO' }];
    const f = fixture({ providers: current });
    const imported = duplicateCurrent
      ? [{ id: 'same', apiKey: '[redacted]' }]
      : [{ id: 'same', apiKey: '[redacted]' }, { id: 'same', apiKey: '[redacted]' }];
    assert.throws(() => f.upload({ providers: imported }), { status: 400 });
    assert.equal(f.writes.length, 0);
    assert.equal(f.files.has('/fixture/upload.json'), true);
  }
});

test('array identity: new real secrets are accepted and removed providers stay removed', () => {
  const original = { providers: [{ id: 'alpha', apiKey: 'SECRET_ALPHA' }, { id: 'removed', apiKey: 'SECRET_REMOVED' }] };
  const f = fixture(original);
  f.upload({ providers: [{ id: 'new', apiKey: 'SECRET_NEW' }, { id: 'alpha', apiKey: '[redacted]' }] });
  assert.deepEqual(f.writes, [{ providers: [{ id: 'new', apiKey: 'SECRET_NEW' }, original.providers[0]] }]);
});

test('array identity: nested identified arrays restore independently after both reorderings', () => {
  const original = { providers: [
    { id: 'alpha', children: [{ id: 'x', apiKey: 'SECRET_AX' }, { id: 'y', apiKey: 'SECRET_AY' }] },
    { id: 'beta', children: [{ id: 'x', apiKey: 'SECRET_BX' }] },
  ] };
  const f = fixture(original);
  const exported = f.service.getExportConfig();
  exported.providers.reverse();
  exported.providers[1].children.reverse();
  f.upload(exported);
  assert.deepEqual(f.writes, [{ providers: [original.providers[1], { id: 'alpha', children: [...original.providers[0].children].reverse() }] }]);
});

test('array identity: anonymous array placeholders always reject rather than restore by index', () => {
  for (const providers of [['[redacted]'], [{ apiKey: '[redacted]' }], [{ name: '[redacted]', apiKey: '[redacted]' }]]) {
    const f = fixture({ providers: [{ apiKey: 'SECRET_ANONYMOUS' }] });
    assert.throws(() => f.upload({ providers }), { status: 400 });
    assert.equal(f.writes.length, 0);
    assert.equal(f.files.has('/fixture/upload.json'), true);
  }
});

test('array identity: scout query q is scoped to the real scout.queries path', () => {
  const original = { scout: { queries: [{ q: 'query one', category: 'a', source: 'b', weight: 1, apiKey: 'SECRET_QUERY' }] } };
  const f = fixture(original);
  f.upload(f.service.getExportConfig());
  assert.deepEqual(f.writes, [original]);
  const generic = fixture({ providers: [{ q: 'query one', apiKey: 'SECRET_QUERY' }] });
  assert.throws(() => generic.upload({ providers: [{ q: 'query one', apiKey: '[redacted]' }] }), { status: 400 });
  assert.equal(generic.writes.length, 0);
});

test('array identity: a missing placeholder field in a matched entity rejects with a useful safe path', () => {
  const f = fixture({ providers: [{ id: 'PRIVATE_IDENTITY', name: 'Provider' }] });
  assert.throws(() => f.upload({ providers: [{ id: 'PRIVATE_IDENTITY', name: 'Provider', apiKey: '[redacted]' }] }), (error) => {
    assert.equal(error.status, 400);
    assert.match(error.message, /\$\.providers\[0\]\.apiKey/);
    assert.doesNotMatch(error.message, /PRIVATE_IDENTITY|SENTINEL|SECRET/);
    return true;
  });
  assert.equal(f.writes.length, 0);
  assert.equal(f.files.has('/fixture/upload.json'), true);
});

test('array identity: a new real-secret element may lack identity or add a stronger identity field', () => {
  const original = { providers: [{ name: 'alpha', apiKey: 'SECRET_ALPHA' }] };
  const f = fixture(original);
  f.upload({ providers: [{ apiKey: 'SECRET_NEW_ANONYMOUS' }, { id: 'new', apiKey: 'SECRET_NEW_ID' }, { name: 'alpha', apiKey: '[redacted]' }] });
  assert.deepEqual(f.writes, [{ providers: [{ apiKey: 'SECRET_NEW_ANONYMOUS' }, { id: 'new', apiKey: 'SECRET_NEW_ID' }, original.providers[0]] }]);
});

test('array identity: nested anonymous array cannot inherit its parent identity', () => {
  const f = fixture({ providers: [{ id: 'alpha', nested: [{ apiKey: 'SECRET_NESTED' }] }] });
  assert.throws(() => f.upload({ providers: [{ id: 'alpha', nested: [{ apiKey: '[redacted]' }] }] }), { status: 400 });
  assert.equal(f.writes.length, 0);
  assert.equal(f.files.has('/fixture/upload.json'), true);
});

test('array identity: nonarray whole credential containers still restore whole', () => {
  const original = { apiKeys: ['SECRET_A', 'SECRET_B'], providers: [{ id: 'alpha', credentials: { nested: ['SECRET_C'] } }] };
  const f = fixture(original);
  const exported = f.service.getExportConfig();
  assert.equal(exported.apiKeys, '[redacted]');
  assert.equal(exported.providers[0].credentials, '[redacted]');
  f.upload(exported);
  assert.deepEqual(f.writes, [original]);
});


test('array identity: removed unidentified current records cannot supply or block restored secrets', () => {
  const original = { providers: [{ id: 'alpha', apiKey: 'SECRET_ALPHA' }, { apiKey: 'SECRET_REMOVED' }] };
  const f = fixture(original);
  f.upload({ providers: [{ id: 'alpha', apiKey: '[redacted]' }] });
  assert.deepEqual(f.writes, [{ providers: [original.providers[0]] }]);
  const unmatched = fixture(original);
  assert.throws(() => unmatched.upload({ providers: [{ id: 'new', apiKey: '[redacted]' }] }), { status: 400 });
  assert.equal(unmatched.writes.length, 0);
  assert.equal(unmatched.files.has('/fixture/upload.json'), true);
});

test('array identity: identity matching is typed and redacted key identities fail closed', () => {
  const typed = fixture({ providers: [{ id: 1, apiKey: 'SECRET_NUMERIC' }] });
  assert.throws(() => typed.upload({ providers: [{ id: '1', apiKey: '[redacted]' }] }), { status: 400 });
  assert.equal(typed.writes.length, 0);
  assert.equal(typed.files.has('/fixture/upload.json'), true);
  const keyed = fixture({ providers: [{ key: 'PRIVATE_IDENTITY', apiKey: 'SECRET_KEYED' }] });
  const exported = keyed.service.getExportConfig();
  assert.equal(exported.providers[0].key, '[redacted]');
  assert.throws(() => keyed.upload(exported), { status: 400 });
  assert.equal(keyed.writes.length, 0);
  assert.equal(keyed.files.has('/fixture/upload.json'), true);
});

test('array identity: unknown property labels and identity values are never reflected in errors', () => {
  const f = fixture({ providers: [{ id: 'PRIVATE_IDENTITY', apiKey: 'SECRET_KEYED' }] });
  assert.throws(() => f.upload({ providers: [{ id: 'PRIVATE_IDENTITY', PRIVATE_PROPERTY: { apiKey: '[redacted]' } }] }), (error) => {
    assert.equal(error.status, 400);
    assert.match(error.message, /\$\.providers\[0\]\.property\[1\]\.apiKey/);
    assert.doesNotMatch(error.message, /PRIVATE_PROPERTY|PRIVATE_IDENTITY|SECRET_KEYED/);
    return true;
  });
  assert.equal(f.writes.length, 0);
  assert.equal(f.files.has('/fixture/upload.json'), true);
});

test('array identity: a marker already stored as a current secret is never persisted as restored evidence', () => {
  for (const currentValue of ['[redacted]', 'Bearer [redacted]', { nested: ['[redacted]'] }]) {
    const f = fixture({ providers: [{ id: 'alpha', token: currentValue }] });
    assert.throws(() => f.upload({ providers: [{ id: 'alpha', token: '[redacted]' }] }), (error) => {
      assert.equal(error.status, 400);
      assert.match(error.message, /\$\.providers\[0\]\.token/);
      assert.doesNotMatch(error.message, /alpha/);
      return true;
    });
    assert.equal(f.writes.length, 0);
    assert.equal(f.files.has('/fixture/upload.json'), true);
  }
});

test('object restoration: a current marker is unavailable, including within a whole credential container', () => {
  for (const currentValue of ['[redacted]', { nested: ['Bearer [redacted]'] }]) {
    const f = fixture({ credentials: currentValue });
    assert.throws(() => f.upload({ credentials: '[redacted]' }), { status: 400 });
    assert.equal(f.writes.length, 0);
    assert.equal(f.files.has('/fixture/upload.json'), true);
  }
});
