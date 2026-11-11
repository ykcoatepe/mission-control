const test = require('node:test');
const assert = require('node:assert/strict');
const { createOpenclawModelsSource } = require('../server/sources/openclaw/models');
const { createOpenclawCli } = require('../server/services/openclawClient');
const { buildModelsRouter } = require('../server/routes/models');
const { errorHandler } = require('../server/core/http');
const { parseFirstJson } = require('../server/services/cronData');

const quiet = { error() {}, warn() {}, log() {} };
const settingsService = {
  getSettingsPayload: () => ({ model: 'observed/model' }),
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

test('GET models only reads the snapshot; no CLI, config reads, refresh or writes', async () => {
  const fail = () => { throw new Error('GET attempted upstream read or write'); };
  const meta = { ok: false, stale: true, source: 'test', error: { code: 'unavailable', message: 'Unavailable' } };
  const models = [{ id: 'real' }];
  const modelsSource = { snapshot: () => ({ data: { models, model: 'real' }, meta }), refresh: fail };
  const router = buildModelsRouter({ modelsSource });
  const list = await invoke(router, 'get', '/api/models');
  assert.equal(list.status, 200);
  assert.deepEqual(list.body, models);
  assert.deepEqual(JSON.parse(list.headers['X-MC-Source-Meta']), meta);
});

test('a cold models source returns a typed 503 without an invented list', async () => {
  const router = buildModelsRouter({ modelsSource: { snapshot: () => ({ data: null, meta: {} }) } });
  const response = await invoke(router, 'get', '/api/models');
  assert.equal(response.status, 503);
  assert.equal(typeof response.body.error.code, 'string');
  assert.deepEqual(Object.keys(response.body), ['error']);
});

test('the models router exposes no mutation routes', () => {
  const router = buildModelsRouter({ modelsSource: { snapshot: () => ({ data: null, meta: {} }) } });
  assert.deepEqual(
    router.stack.filter((layer) => layer.route).map((layer) => `${Object.keys(layer.route.methods).join(',')} ${layer.route.path}`),
    ['get /api/models'],
  );
});
