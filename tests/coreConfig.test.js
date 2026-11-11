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
  // Allowlist (whole-path decision after review 3): absent, not redacted.
  for (const key of ['gateway', 'notion', 'aws', 'paths']) assert.equal(Object.hasOwn(view, key), false, key);
  assert.deepEqual(view.mc, {});
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

// --- review round 2: case-insensitive names, value-based redaction ---------
const { redactString } = require('../server/core/config');

test('counter-example: publicView does not leak CLIENTKEY or URL credentials (reviewer reproductions)', () => {
  const { root, home } = tempRoot({
    mc: { CLIENTKEY: 'SECRET', databaseUrl: 'postgresql://user:PASS@localhost/db' },
  });
  const view = publicView(loadConfig({ rootDir: root, homeDir: home, env: {} }));
  const text = JSON.stringify(view);
  assert.doesNotMatch(text, /SECRET|PASS/);
  // Allowlist (whole-path decision after review 3): unknown fields are omitted.
  assert.equal(Object.hasOwn(view.mc, 'CLIENTKEY'), false);
  assert.equal(Object.hasOwn(view.mc, 'databaseUrl'), false);
  assert.equal(redactString('postgresql://user:PASS@localhost/db'), 'postgresql://user:[redacted]@localhost/db', 'free text: only the password is removed');
});

test('isSecretKey is case-insensitive across caps, snake, kebab and camel variants', () => {
  for (const key of ['CLIENTKEY', 'clientkey', 'ClientKey', 'CLIENT_KEY', 'client-key', 'APIKEY', 'SECRETKEY', 'MYTOKEN', 'my_token',
    'DB_PASSWORD', 'dbPasswd', 'DBPWD', 'db_pwd', 'adminPwd', 'CREDENTIAL', 'aws_credentials', 'AUTH', 'auth', 'basicAuth',
    'PROXY_AUTH', 'proxy-auth', 'AUTHORIZATION', 'Proxy-Authorization', 'COOKIE', 'Set-Cookie', 'session', 'SESSION',
    'user_session', 'sessionId', 'SESSION_ID', 'signingKey', 'SIGNING_KEY', 'webhookSecret', 'WEBHOOK_SECRET', 'key', 'KEY']) {
    assert.equal(isSecretKey(key), true, key);
  }
  for (const key of ['name', 'port', 'keyboard', 'monkey', 'MONKEY', 'hotkey', 'turkey', 'author', 'authors', 'keys', 'workspace',
    'sessions', 'sessionsPath', 'model', 'region', 'enabled', 'path', 'host', 'databaseUrl', 'passive', 'bypass']) {
    assert.equal(isSecretKey(key), false, key);
  }
});

test('counter-example: credentials inside values are redacted whatever the key is called', () => {
  const blob = 'A1b2C3d4E5f6A1b2C3d4E5f6A1b2C3d4E5f6A1b2';
  const input = {
    databaseUrl: 'postgresql://user:PASSWORD1@localhost:5432/db?sslmode=require',
    mirror: 'https://deploy:p@ss:w0rd-NOPE@example.com/repo.git',
    redis: 'redis://:ONLYPASS@127.0.0.1:6379/0',
    note: 'call with Authorization: Bearer abc.DEF-123_tok and retry',
    header: 'bearer LOWERCASETOKEN99',
    openai: 'sk-proj-AbCdEf0123456789xyz',
    slack: 'use xoxb-FFFFFFFFFFFF-ABCDEFGHIJKL please',
    github: 'ghp_0123456789abcdefghijABCDEFGHIJ012345',
    command: `curl -H "x-api-key: ${blob}" https://example.com`,
    query: `https://example.com/hook?token=${blob}&mode=fast`,
    line: 'password=hunter2 user=admin',
    list: ['plain', 'mysql://root:ROOTPW@db/x'],
    pem: '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----',
  };
  const out = redact(JSON.parse(JSON.stringify(input)));
  const text = JSON.stringify(out);
  assert.doesNotMatch(text, /PASSWORD1|p@ss|w0rd-NOPE|ONLYPASS|abc\.DEF|LOWERCASETOKEN99|AbCdEf0123456789|xoxb-1234|ghp_0123|A1b2C3d4|hunter2|ROOTPW|MIIEvQ/);
  assert.equal(out.databaseUrl, 'postgresql://user:[redacted]@localhost:5432/db?sslmode=require');
  assert.equal(out.redis, 'redis://:[redacted]@127.0.0.1:6379/0');
  assert.equal(out.note, 'call with Authorization: Bearer [redacted] and retry');
  assert.equal(out.query, 'https://example.com/hook?token=[redacted]&mode=fast');
  assert.equal(out.line, 'password=[redacted] user=admin');
  assert.equal(out.list[0], 'plain');
});

test('ordinary values are not redacted', () => {
  const input = {
    port: 18789,
    enabled: true,
    disabled: false,
    nothing: null,
    path: '/Users/someone/clawd/mission-control/data',
    model: 'claude-fable-5-2',
    models: ['anthropic/claude-sonnet-5.5', 'gpt-6.1-sol', 'openai:gpt-6-luna', 'ollama/qwen3:32b'],
    region: 'us-east-1',
    url: 'http://localhost:18789/api/x?y=1',
    hostPort: 'http://127.0.0.1:3333',
    db: 'postgresql://localhost:5432/db',
    git: 'ssh://git@github.com/owner/repo.git',
    email: 'someone@example.com',
    mailto: 'mailto:someone@example.com',
    atInPath: 'http://host:8080/path@x',
    atInQuery: 'http://host:8080?mention=a@b',
    checksum: '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
    commit: '5c7be00a1b2c3d4e5f60718293a4b5c6d7e8f901',
    project: 'task-management-system',
    library: 'sk-learn',
    remarkOne: 'the bearer of this note',
    keyNote: 'press any key: enter',
    remarkTwo: 'token: none',
    time: '2026-11-11T10:00:00.000Z',
    maxTokens: 4096,
    totalTokens: 123456,
    contextTokens: 200000,
    name: 'Mission Control',
    author: 'OpenClaw Community',
    schedule: '*/5 * * * *',
    version: '1.0.0',
  };
  const out = redact(JSON.parse(JSON.stringify(input)));
  assert.deepEqual(out, input);
  assert.equal(redactString('plain text'), 'plain text');
});
