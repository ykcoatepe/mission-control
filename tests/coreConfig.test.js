const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  loadConfig,
  createConfigStore,
  publicView,
} = require('../server/core/config');

const quiet = { warn() {}, error() {}, log() {} };

function tempRoot({ mc, defaults, openclaw } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-config-root-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-config-home-'));
  if (mc !== undefined) fs.writeFileSync(path.join(root, 'mc-config.json'), typeof mc === 'string' ? mc : JSON.stringify(mc));
  if (defaults !== undefined) fs.writeFileSync(path.join(root, 'mc-config.default.json'), JSON.stringify(defaults));
  if (openclaw !== undefined) {
    fs.mkdirSync(path.join(home, '.openclaw'), { recursive: true });
    fs.writeFileSync(path.join(home, '.openclaw', 'openclaw.json'), JSON.stringify(openclaw));
  }
  return { root, home };
}

test('missing mc-config.json loads defaults in memory and never writes the file', () => {
  const { root, home } = tempRoot({ defaults: { name: 'From template', gateway: { port: 18800 } } });
  const config = loadConfig({ rootDir: root, homeDir: home, env: {} });
  assert.equal(config.load.source, 'default-template');
  assert.match(config.load.problems[0], /not found/);
  assert.equal(config.mc.name, 'From template');
  assert.equal(config.gateway.port, 18800);
  assert.equal(fs.existsSync(path.join(root, 'mc-config.json')), false, 'counter-example: config written at load');
});

test('a corrupt mc-config.json is reported and left untouched', () => {
  const { root, home } = tempRoot({ mc: '{not json' });
  const config = loadConfig({ rootDir: root, homeDir: home, env: {} });
  assert.equal(config.load.source, 'builtin-defaults');
  assert.equal(fs.readFileSync(path.join(root, 'mc-config.json'), 'utf8'), '{not json');
});

test('config is deeply frozen', () => {
  const { root, home } = tempRoot({ mc: { name: 'X', gateway: { port: 18789, token: 't' } } });
  const config = loadConfig({ rootDir: root, homeDir: home, env: {} });
  assert.ok(Object.isFrozen(config));
  assert.ok(Object.isFrozen(config.gateway));
  assert.ok(Object.isFrozen(config.mc.gateway));
  assert.throws(() => { 'use strict'; config.gateway.port = 1; }, TypeError);
});

test('schema problems are reported, not fatal', () => {
  const { root, home } = tempRoot({ mc: { gateway: { port: 'abc' }, modules: [], security: { writeGuard: 'off' } } });
  const config = loadConfig({ rootDir: root, homeDir: home, env: {} });
  assert.ok(config.load.problems.includes('gateway.port must be a TCP port'));
  assert.ok(config.load.problems.includes('modules must be an object'));
  assert.ok(config.load.problems.some((p) => p.startsWith('security.writeGuard')));
  assert.equal(config.guard.writeGuardMode, 'report-only');
});

test('write guard mode: report-only by default; config or env can enforce', () => {
  const plain = tempRoot({ mc: {} });
  assert.equal(loadConfig({ rootDir: plain.root, homeDir: plain.home, env: {} }).guard.writeGuardMode, 'report-only');
  const enforced = tempRoot({ mc: { security: { writeGuard: 'enforce' } } });
  assert.equal(loadConfig({ rootDir: enforced.root, homeDir: enforced.home, env: {} }).guard.writeGuardMode, 'enforce');
  assert.equal(loadConfig({ rootDir: plain.root, homeDir: plain.home, env: { MC_WRITE_GUARD: 'enforce' } }).guard.writeGuardMode, 'enforce');
});

test('gateway token drift is a reported state, not a crash', () => {
  const { root, home } = tempRoot({
    mc: { gateway: { port: 18789, token: 'mc-token' } },
    openclaw: { gateway: { auth: { token: 'oc-token' } } },
  });
  const config = loadConfig({ rootDir: root, homeDir: home, env: {} });
  assert.equal(config.gatewayTokenCheck.state, 'drift');
  assert.equal(config.gatewayTokenCheck.ok, false);
  assert.equal(config.gateway.token, 'oc-token', 'the OpenClaw token wins, as before');

  const mismatch = tempRoot({ mc: {}, openclaw: { gateway: { auth: { token: 'a' }, remote: { token: 'b' } } } });
  assert.equal(loadConfig({ rootDir: mismatch.root, homeDir: mismatch.home, env: {} }).gatewayTokenCheck.state, 'mismatch');

  const noneMode = tempRoot({ mc: { gateway: { token: 'x' } }, openclaw: { gateway: { auth: { mode: 'none', token: 'y' } } } });
  assert.equal(loadConfig({ rootDir: noneMode.root, homeDir: noneMode.home, env: {} }).gatewayTokenCheck.ok, true);

  const missing = tempRoot({ mc: {} });
  assert.equal(loadConfig({ rootDir: missing.root, homeDir: missing.home, env: {} }).gatewayTokenCheck.state, 'skipped');
});

test('env placeholders resolve; public view redacts every secret', () => {
  const { root, home } = tempRoot({
    mc: { gateway: { token: '${MC_TEST_TOKEN}' }, notion: { dbId: 'db', token: 'n-secret' }, scout: { braveApiKey: 'zz-brave-value' } },
  });
  const config = loadConfig({ rootDir: root, homeDir: home, env: { MC_TEST_TOKEN: 'from-env' } });
  assert.equal(config.gateway.token, 'from-env');
  const view = publicView(config);
  const text = JSON.stringify(view);
  for (const secret of ['from-env', 'n-secret', 'zz-brave-value']) assert.doesNotMatch(text, new RegExp(secret));
  assert.equal(view.gateway.token, '[redacted]');
  assert.equal(view.notion.dbId, 'db');
});

test('ConfigStore writes atomically and updates the frozen view', () => {
  const { root, home } = tempRoot({ mc: { name: 'Before' } });
  const config = loadConfig({ rootDir: root, homeDir: home, env: {} });
  const store = createConfigStore({ config, logger: quiet });
  const legacy = store.legacyObject();
  assert.equal(Object.isFrozen(legacy), false, 'existing routers mutate this object');
  legacy.name = 'After';
  store.persist();
  assert.equal(JSON.parse(fs.readFileSync(config.paths.mcConfig, 'utf8')).name, 'After');
  assert.equal(store.current().name, 'After');
  assert.ok(Object.isFrozen(store.current()));
  assert.deepEqual(fs.readdirSync(root), ['mc-config.json']);
});

test('counter-example: the config store never leaves a partial file', () => {
  const { root, home } = tempRoot({ mc: { name: 'Original' } });
  const config = loadConfig({ rootDir: root, homeDir: home, env: {} });
  const original = fs.readFileSync(config.paths.mcConfig, 'utf8');

  // The write dies half-way through the temp file.
  const partialFs = {
    ...fs,
    writeFileSync(file, text, enc) {
      fs.writeFileSync(file, String(text).slice(0, 5), enc);
      throw new Error('ENOSPC');
    },
  };
  const store = createConfigStore({ config, fsImpl: partialFs, logger: quiet });
  store.legacyObject().name = 'Changed';
  assert.throws(() => store.persist(), /ENOSPC/);
  assert.equal(fs.readFileSync(config.paths.mcConfig, 'utf8'), original);
  assert.deepEqual(fs.readdirSync(root), ['mc-config.json'], 'temp file removed');
  assert.equal(store.current().name, 'Original', 'the in-memory view did not move');

  // The rename fails.
  const renameFs = { ...fs, renameSync() { throw new Error('EXDEV'); } };
  const store2 = createConfigStore({ config, fsImpl: renameFs, logger: quiet });
  assert.throws(() => store2.persist({ name: 'X' }), /EXDEV/);
  assert.equal(fs.readFileSync(config.paths.mcConfig, 'utf8'), original);
  assert.deepEqual(fs.readdirSync(root), ['mc-config.json']);
});

test('importRaw validates JSON, keeps a backup and writes atomically', () => {
  const { root, home } = tempRoot({ mc: { name: 'Old' } });
  const config = loadConfig({ rootDir: root, homeDir: home, env: {} });
  const store = createConfigStore({ config, logger: quiet });
  assert.throws(() => store.importRaw('{broken'), SyntaxError);
  assert.equal(JSON.parse(fs.readFileSync(config.paths.mcConfig, 'utf8')).name, 'Old');
  store.importRaw('{"name":"New"}', { now: () => 42 });
  assert.equal(JSON.parse(fs.readFileSync(config.paths.mcConfig, 'utf8')).name, 'New');
  assert.equal(JSON.parse(fs.readFileSync(`${config.paths.mcConfig}.backup.42`, 'utf8')).name, 'Old');
});

// --- review round 1: atomic writers keep restrictive modes ---------------
const { createAuditLog } = require('../server/core/guard');
const { writeJsonFileAtomic } = require('../server/services/jsonFiles');

function withUmask(mask, fn) {
  const previous = process.umask(mask);
  try {
    return fn();
  } finally {
    process.umask(previous);
  }
}
const modeOf = (file) => fs.statSync(file).mode & 0o777;

test('counter-example: persisting a 0600 config under umask 022 keeps it 0600', () => {
  const { root, home } = tempRoot({ mc: { name: 'Secret', gateway: { token: 't' } } });
  const config = loadConfig({ rootDir: root, homeDir: home, env: {} });
  fs.chmodSync(config.paths.mcConfig, 0o600);
  withUmask(0o022, () => {
    const store = createConfigStore({ config, logger: quiet });
    store.legacyObject().name = 'Changed';
    store.persist();
    assert.equal(modeOf(config.paths.mcConfig), 0o600);
    store.importRaw('{"name":"Imported"}', { now: () => 7 });
    assert.equal(modeOf(config.paths.mcConfig), 0o600);
  });
});

test('a new config file is created 0600; an existing mode is preserved', () => {
  const { root, home } = tempRoot({ defaults: { name: 'T' } });
  const config = loadConfig({ rootDir: root, homeDir: home, env: {} });
  withUmask(0o022, () => createConfigStore({ config, logger: quiet }).persist());
  assert.equal(modeOf(config.paths.mcConfig), 0o600);
  fs.chmodSync(config.paths.mcConfig, 0o640);
  withUmask(0o022, () => createConfigStore({ config, logger: quiet }).persist({ name: 'U' }));
  assert.equal(modeOf(config.paths.mcConfig), 0o640);
});

test('audit log and JSON file writers create 0600 files and keep existing modes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-modes-'));
  const auditFile = path.join(dir, 'audit', 'events.json');
  withUmask(0o022, () => {
    createAuditLog({ file: auditFile, logger: quiet }).record({ path: '/api/x' });
    assert.equal(modeOf(auditFile), 0o600);
    const jsonFile = path.join(dir, 'hidden.json');
    writeJsonFileAtomic(jsonFile, ['a']);
    assert.equal(modeOf(jsonFile), 0o600);
    fs.chmodSync(jsonFile, 0o600);
    writeJsonFileAtomic(jsonFile, ['a', 'b']);
    assert.equal(modeOf(jsonFile), 0o600);
  });
  assert.deepEqual(fs.readdirSync(dir).sort(), ['audit', 'hidden.json']);
});

// --- review round 1: structured secrets -----------------------------------
const { redact, isSecretKey } = require('../server/core/config');

test('counter-example: secrets inside arrays and objects under credential keys are redacted', () => {
  const input = {
    gateway: { token: ['secret-a'], auth: { token: { value: 'secret-b' } }, port: 18789 },
    apiKey: { value: 'secret-c' },
    'api-key': 'secret-d',
    api_key: 'secret-e',
    Authorization: 'Bearer secret-f',
    headers: [{ cookie: 'sid=secret-g' }, { name: 'x', authorization: ['secret-h'] }],
    credentials: { user: 'u', pass: 'secret-i' },
    privateKey: '-----BEGIN secret-j',
    braveApiKey: 'secret-k',
    clientToken: 12345,
    sessionKey: 'secret-l',
    nested: [[{ password: 'secret-m' }]],
    tokenConfigured: true,
    name: 'Mission Control',
    keyboard: 'not-a-secret',
    emptyToken: '',
  };
  const out = redact(JSON.parse(JSON.stringify(input)));
  const text = JSON.stringify(out);
  assert.doesNotMatch(text, /secret-|12345/);
  assert.equal(out.gateway.port, 18789);
  assert.equal(out.gateway.token, '[redacted]');
  assert.equal(out.apiKey, '[redacted]');
  assert.equal(out.headers[1].name, 'x');
  assert.equal(out.tokenConfigured, true, 'boolean flags stay');
  assert.equal(out.name, 'Mission Control');
  assert.equal(out.keyboard, 'not-a-secret');
  assert.equal(out.emptyToken, '');
});

test('isSecretKey covers credential names and leaves ordinary keys', () => {
  for (const key of ['token', 'gatewayToken', 'GATEWAY_TOKEN', 'secret', 'clientSecret', 'password', 'apiKey', 'api-key',
    'api_key', 'API_KEY', 'authorization', 'Authorization', 'cookie', 'set-cookie', 'credential', 'credentials',
    'privateKey', 'private_key', 'braveApiKey', 'accessKeyId', 'secretAccessKey', 'refreshToken', 'x-api-key']) {
    assert.equal(isSecretKey(key), true, key);
  }
  for (const key of ['name', 'port', 'keyboard', 'monkeyPatch', 'modules', 'author', 'keys', 'workspace']) {
    assert.equal(isSecretKey(key), false, key);
  }
});
