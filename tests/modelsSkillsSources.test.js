const test = require('node:test');
const assert = require('node:assert/strict');
const { createOpenclawModelsSource } = require('../server/sources/openclaw/models');
const { createOpenclawSkillsSource } = require('../server/sources/openclaw/skills');
const { createOpenclawCli } = require('../server/services/openclawClient');
const { buildModelsRouter } = require('../server/routes/models');
const { buildSkillsRouter } = require('../server/routes/skills');
const { errorHandler } = require('../server/core/http');
const { parseFirstJson } = require('../server/services/cronData');

const quiet = { error() {}, warn() {}, log() {} };
const settingsService = {
  getSettingsPayload: () => ({ model: 'observed/model' }),
  readOpenclawConfigSafe: () => ({ skills: { entries: { sleeping: { enabled: false } } } }),
};

function invoke(router, method, path, extra = {}) {
  const route = router.stack.find((layer) => layer.route?.path === path && layer.route.methods[method]);
  assert.ok(route, `${method} ${path} exists`);
  return new Promise((resolve, reject) => {
    const req = { method: method.toUpperCase(), originalUrl: path, params: {}, body: {}, ...extra };
    const res = {
      statusCode: 200,
      headers: {},
      set(key, value) { this.headers[key] = value; return this; },
      status(code) { this.statusCode = code; return this; },
      json(body) { resolve({ status: this.statusCode, headers: this.headers, body }); return this; },
    };
    const next = (error) => {
      if (!error) return reject(new Error('Unexpected route fallthrough'));
      errorHandler({ logger: quiet })(error, req, res, reject);
    };
    try { route.route.stack[0].handle(req, res, next); } catch (error) { next(error); }
  });
}

for (const [name, factory, property, observed] of [
  ['models', createOpenclawModelsSource, 'models', [{ key: 'observed/model', name: 'Observed', local: true, available: true, contextWindow: 4096, input: ['text'], tags: ['local'], secret: 'never-copy' }]],
  ['skills', createOpenclawSkillsSource, 'skills', [{ name: 'sleeping', eligible: true, disabled: false, blockedByAllowlist: false, source: 'openclaw-workspace', secret: 'never-copy' }]],
]) {
  test(`${name}: failed and malformed reads retain last-good, never invent a list`, async () => {
    let output = { ok: false, stdout: '', stderr: 'token=never-copy' };
    let now = 1_700_000_000_000;
    const calls = [];
    const cli = createOpenclawCli({ runner: { run: async (bin, args, options) => { calls.push({ bin, args, options }); return output; } }, bin: 'fake-openclaw', configPath: '/fake/config', processEnv: {} });
    const source = factory({ openclawCli: cli, parseFirstJson, settingsService, now: () => now });
    await source.refresh();
    assert.equal(source.snapshot().data, null);
    assert.equal(source.snapshot().meta.stale, true);
    assert.ok(source.snapshot().meta.error.code.endsWith('_unavailable'));
    assert.doesNotMatch(JSON.stringify(source.snapshot()), /never-copy|gpt-5\.5/);
    output = { ok: true, stdout: JSON.stringify({ [property]: observed }), stderr: '' };
    await source.refresh();
    const good = source.snapshot().data;
    assert.notEqual(good, null);
    assert.doesNotMatch(JSON.stringify(good), /never-copy/);
    assert.ok(calls.every((call) => call.options.lane === 'openclaw'));
    assert.deepEqual(calls[0].args, [name, 'list', '--json']);
    now += 60_000;
    for (const broken of [
      { ok: false, stdout: JSON.stringify({ [property]: [] }), stderr: 'secret failure' },
      { ok: true, stdout: '{}', stderr: '' },
      { ok: true, stdout: JSON.stringify({ [property]: [{}] }), stderr: '' },
      { ok: true, stdout: JSON.stringify({ [property]: [] }), truncated: true },
    ]) {
      output = broken;
      await source.refresh();
      assert.deepEqual(source.snapshot().data, good);
      assert.equal(source.snapshot().meta.ok, false);
      assert.equal(source.snapshot().meta.stale, true);
      assert.doesNotMatch(JSON.stringify(source.snapshot()), /secret failure/);
    }
    output = { ok: true, stdout: JSON.stringify({ [property]: [] }) };
    await source.refresh();
    assert.equal(source.snapshot().meta.ok, true, 'observed empty is a valid result');
  });
}

test('models keep unknown fields null and cached configured model rather than fabricated capability defaults', async () => {
  const source = createOpenclawModelsSource({ openclawCli: async () => ({ ok: true, stdout: '{"models":[{"key":"known","input":{"secret":"no"}}]}' }), parseFirstJson });
  await source.refresh();
  assert.deepEqual(source.snapshot().data, { models: [{ id: 'known', name: 'known', contextWindow: null, input: null, local: null, available: null, tags: null }], model: null });
});

test('GET models/model/skills only read snapshots; no CLI, config reads, refresh or writes', async () => {
  const fail = () => { throw new Error('GET attempted upstream read or write'); };
  const meta = { ok: false, stale: true, source: 'test', error: { code: 'unavailable', message: 'Unavailable' } };
  const models = [{ id: 'real' }];
  const modelsSource = { snapshot: () => ({ data: { models, model: 'real' }, meta }), refresh: fail };
  const skillsSource = { snapshot: () => ({ data: { installed: [{ name: 'real' }], available: [] }, meta }), refresh: fail };
  const deps = { openclawExec: fail, openclawCli: fail, parseFirstJson: fail, settingsService: { getSettingsPayload: fail, readOpenclawConfigSafe: fail, setDefaultModel: fail } };
  const mr = buildModelsRouter({ ...deps, modelsSource });
  const sr = buildSkillsRouter({ ...deps, skillsSource });
  const list = await invoke(mr, 'get', '/api/models');
  assert.equal(list.status, 200);
  assert.deepEqual(list.body, models);
  assert.deepEqual(JSON.parse(list.headers['X-MC-Source-Meta']), meta);
  assert.deepEqual((await invoke(mr, 'get', '/api/model')).body, { model: 'real', meta });
  assert.deepEqual((await invoke(sr, 'get', '/api/skills')).body, { installed: [{ name: 'real' }], available: [], meta });
});

test('cold models/model/skills return typed 503 errors without an invented list or request read', async () => {
  const source = { snapshot: () => ({ data: null, meta: {} }) };
  const mr = buildModelsRouter({ modelsSource: source });
  const sr = buildSkillsRouter({ skillsSource: source });
  for (const [router, path] of [[mr, '/api/models'], [mr, '/api/model'], [sr, '/api/skills']]) {
    const response = await invoke(router, 'get', path);
    assert.equal(response.status, 503);
    assert.equal(typeof response.body.error.code, 'string');
    assert.deepEqual(Object.keys(response.body), ['error']);
  }
});

test('unimplemented skill mutations return 501 through the centralized error contract', async () => {
  const router = buildSkillsRouter({});
  for (const action of ['install', 'uninstall']) {
    const response = await invoke(router, 'post', `/api/skills/:name/${action}`, { params: { name: 'known' } });
    assert.equal(response.status, 501);
    assert.equal(typeof response.body.error.code, 'string');
    assert.equal(typeof response.body.error.message, 'string');
    assert.equal(response.body.success, undefined);
  }
});

test('skill toggle rejects config-path injection and nonboolean enabled before mutation', async () => {
  let calls = 0;
  const router = buildSkillsRouter({ openclawExec: async () => { calls += 1; } });
  for (const [name, enabled] of [['bad"].other', true], ['known', 'true']]) {
    const response = await invoke(router, 'post', '/api/skills/:name/toggle', { params: { name }, body: { enabled } });
    assert.equal(response.status, 400);
  }
  assert.equal(calls, 0);
});

test('model mutation rejects invalid input and sanitizes upstream failures', async () => {
  let calls = 0;
  const router = buildModelsRouter({ settingsService: { setDefaultModel: async () => { calls += 1; throw new Error('token=never-copy'); } } });
  const invalid = await invoke(router, 'post', '/api/model', { body: { model: {} } });
  assert.equal(invalid.status, 400);
  assert.equal(calls, 0);
  const failed = await invoke(router, 'post', '/api/model', { body: { model: 'real' } });
  assert.equal(failed.status, 503);
  assert.doesNotMatch(JSON.stringify(failed.body), /never-copy/);
});
