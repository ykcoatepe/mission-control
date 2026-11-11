const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  loadConfig,
  publicView,
  publicMcView,
  projectPublic,
  redactString,
  PUBLIC_MC_SCHEMA,
  PUBLIC_MODULE_IDS,
  PUBLIC_CONFIG_SCHEMA,
} = require('../server/core/config');
const { createSettingsService } = require('../server/services/settingsData');

function tempRoot(mc) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-public-root-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-public-home-'));
  fs.writeFileSync(path.join(root, 'mc-config.json'), JSON.stringify(mc));
  return { root, home };
}

// Every leaf path of a value, e.g. "modules.aws", "list[]".
function leafPaths(value, prefix = '') {
  if (Array.isArray(value)) return value.flatMap((item) => leafPaths(item, `${prefix}[]`));
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, inner]) => leafPaths(inner, prefix ? `${prefix}.${key}` : key));
  }
  return [prefix];
}

const ALLOWED = {
  name: 'Console',
  subtitle: 'Ops',
  modules: { dashboard: true, costs: false, aws: true },
  aws: { enabled: true },
};

test('the public mc-config allowlist is exactly this', () => {
  assert.deepEqual(PUBLIC_MC_SCHEMA, {
    name: { $string: { max: 120, fallback: 'Mission Control' } },
    subtitle: { $string: { max: 120, fallback: 'Mission Control' } },
    modules: Object.fromEntries(PUBLIC_MODULE_IDS.map((id) => [id, 'boolean'])),
    aws: { enabled: 'boolean' },
  });
  assert.deepEqual(Object.keys(PUBLIC_CONFIG_SCHEMA).sort(), ['gatewayTokenCheck', 'guard', 'load', 'mc', 'server']);
});

test('every allowlisted field round-trips unchanged', () => {
  assert.deepEqual(publicMcView(structuredClone(ALLOWED)), ALLOWED);
  const service = createSettingsService({ mcConfig: structuredClone(ALLOWED) });
  assert.deepEqual(service.getPublicConfig(), ALLOWED);
});

test('counter-example: unknown, secret-named and secret-valued fields are absent, not redacted', () => {
  const mc = {
    ...structuredClone(ALLOWED),
    futureField: 'UNKNOWN-TOP-LEVEL',
    aws: { enabled: true, bucket: 'UNKNOWN-NESTED', region: 'us-east-1', secretAccessKey: 'SECRET-NAMED', futureNested: { deep: 'UNKNOWN-DEEP' } },
    gateway: { port: 18789, token: 'SECRET-NAMED-TOKEN' },
    CLIENTKEY: 'SECRET-CAPS',
    notes: 'sk-proj-AbCdEf0123456789xyz',
    databaseUrl: 'postgresql://user@tenant:PASS-IN-URL@localhost/db',
    notion: { enabled: true, dbId: 'db', token: 'SECRET-NOTION' },
    scout: { braveApiKey: 'SECRET-BRAVE', queries: [{ q: 'UNKNOWN-ARRAY' }] },
    list: ['UNKNOWN-LIST'],
  };
  for (const view of [publicMcView(mc), createSettingsService({ mcConfig: mc }).getPublicConfig()]) {
    assert.deepEqual(view, ALLOWED);
    const text = JSON.stringify(view);
    assert.doesNotMatch(text, /UNKNOWN|SECRET|PASS-IN-URL|sk-proj|redacted|18789|us-east-1/);
    for (const key of ['futureField', 'gateway', 'CLIENTKEY', 'notes', 'databaseUrl', 'notion', 'scout', 'list']) {
      assert.equal(Object.hasOwn(view, key), false, `${key} must be omitted`);
    }
    assert.deepEqual(Object.keys(view.aws), ['enabled']);
  }
});

test('counter-example (the invariant): a field added to the config is not exposed until it is added to the allowlist', () => {
  // Build a config that has a value at every allowlisted path plus one new
  // field at every level; the view may contain allowlisted leaf paths only.
  const allowedLeaves = new Set(leafPaths(ALLOWED));
  const mc = structuredClone(ALLOWED);
  mc.addedLater = 'LEAK';
  mc.addedObject = { enabled: true, name: 'LEAK' };
  mc.aws.addedLater = 'LEAK';
  mc.modules.nested = { addedLater: 'LEAK' };
  mc.modules.asString = 'LEAK';
  const view = publicMcView(mc);
  assert.doesNotMatch(JSON.stringify(view), /LEAK|addedLater|addedObject/);
  for (const leaf of leafPaths(view)) assert.ok(allowedLeaves.has(leaf), `${leaf} is not on the allowlist`);

  // The same through the loaded config and the HTTP-facing service.
  const { root, home } = tempRoot({ ...mc, gateway: { port: 1, token: 'LEAK-TOKEN' } });
  const loaded = publicView(loadConfig({ rootDir: root, homeDir: home, env: { AWS_SECRET_ACCESS_KEY: 'LEAK-ENV' } }));
  assert.doesNotMatch(JSON.stringify(loaded), /LEAK|addedLater/);
  assert.deepEqual(Object.keys(loaded).sort(), ['gatewayTokenCheck', 'guard', 'load', 'mc', 'server']);
  assert.deepEqual(loaded.mc, ALLOWED);
  assert.equal(typeof loaded.server.port, 'number');
  for (const key of ['gateway', 'notion', 'aws', 'paths', 'homeDir', 'rootDir', 'openclawBin', 'workspacePath']) {
    assert.equal(Object.hasOwn(loaded, key), false, `${key} must be omitted from the loaded view`);
  }
});

test('wrong types are omitted, never coerced or passed through', () => {
  const view = publicMcView({
    name: { toString: 'x', secret: 'LEAK' },
    subtitle: ['LEAK'],
    modules: ['LEAK'],
    aws: { enabled: 'LEAK' },
  });
  assert.deepEqual(view, { aws: {} });
  assert.deepEqual(publicMcView(null), {});
  assert.deepEqual(publicMcView('LEAK'), {});
  assert.deepEqual(publicMcView({ modules: { costs: true, 'bad key': true, __proto__x: true, cron: 1, chat: 'LEAK', agents: { a: true } } }), { modules: { costs: true } });
});

test('a url-typed field is rendered without userinfo, or omitted when it does not parse', () => {
  const schema = { endpoint: 'url', mirrors: { $array: 'url' }, items: { $array: { label: { $string: { max: 10 } } } }, port: 'number' };
  const view = projectPublic({
    endpoint: 'https://deploy:TOPSECRET@example.com:8443/hook?x=1#frag',
    mirrors: [
      'postgresql://user@tenant:PASS@localhost/db',
      'http://user:p@ss:w0rd@[::1]:8080/x',
      'http://localhost:11434',
      'not a url',
      'user:PASS@host',
      'mailto:someone:PASS@example.com',
      42,
    ],
    items: [{ label: 'a', secret: 'LEAK' }, 'LEAK', { label: 7 }],
    port: '8080',
  }, schema);
  assert.equal(view.endpoint, 'https://example.com:8443/hook?x=1#frag');
  assert.deepEqual(view.mirrors, ['postgresql://localhost/db', 'http://[::1]:8080/x', 'http://localhost:11434/']);
  assert.deepEqual(view.items, [{ label: 'a' }, {}]);
  assert.equal(Object.hasOwn(view, 'port'), false);
  assert.doesNotMatch(JSON.stringify(view), /TOPSECRET|PASS|p@ss|w0rd|LEAK|deploy|tenant/);
});

test('settings export stays a complete document with placeholders; only the public view is allowlisted', () => {
  const mc = { name: 'Console', gateway: { port: 1234, token: 'SENTINEL' }, custom: { keep: 'me' }, modules: { costs: true } };
  const service = createSettingsService({ mcConfig: mc });
  const exported = service.getExportConfig();
  assert.deepEqual(exported, { name: 'Console', gateway: { port: 1234, token: '[redacted]' }, custom: { keep: 'me' }, modules: { costs: true } });
  assert.deepEqual(service.getPublicConfig(), { name: 'Console', modules: { costs: true } });
});

// --- redactString: second line of defence for free text ---------------------
const BLOB = 'A1b2C3d4E5f6A1b2C3d4E5f6A1b2C3d4';

// [input, a substring that must be gone]
const POSITIVE = [
  ['postgresql://user@tenant:PASS@localhost/db', 'PASS'], // third-review reproduction (a)
  ['postgresql://user:PASS@localhost/db', 'PASS'],
  ['https://deploy:p@ss@example.com/repo.git', 'p@ss'],
  ['https://deploy:p@ss:w0rd@example.com/repo.git', 'w0rd'],
  ['mysql://root:R00T@db.internal:3306/x?ssl=1', 'R00T'],
  ['redis://:ONLYPASS@127.0.0.1:6379/0', 'ONLYPASS'],
  ['http://user:pw123@[::1]:8080/x', 'pw123'],
  ['http://user:pw123@[2001:db8::1]/x', 'pw123'],
  ['connect to amqp://guest:GUESTPW@mq:5672/vhost failed', 'GUESTPW'],
  ['(see https://u:TOPSECRET@host/path).', 'TOPSECRET'],
  ['"url":"mongodb+srv://app:M0ngoPW@cluster0.example.net/db"', 'M0ngoPW'],
  ['https://u:pa/ss@host/x', 'ss@'], // does not parse: widest reading
  ['git clone https://ghp_0123456789abcdefghijABCDEFGHIJ012345@github.com/o/r.git', 'ghp_0123'],
  ['Authorization: Bearer abc.DEF-123_tok', 'abc.DEF'],
  ['authorization: Basic dXNlcjpwYXNzd29yZA==', 'dXNlcjpw'],
  ['bearer LOWERCASETOKEN99', 'LOWERCASETOKEN99'],
  ['sk-proj-AbCdEf0123456789xyz', 'AbCdEf0123456789'],
  ['use xoxb-FFFFFFFFFFFF-ABCDEFGHIJKL please', 'xoxb-1234'],
  ['ghp_0123456789abcdefghijABCDEFGHIJ012345', 'ghp_0123'],
  ['AKIAIOSFODNN7EXAMPLE', 'AKIAIOSFODNN7'],
  ['eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcDEF123', 'eyJzdWIi'],
  ['password=hunter2 user=admin', 'hunter2'],
  ['PASSWORD: hunter2', 'hunter2'],
  ['db_password = "two words"', 'two words'],
  ['{"clientSecret":"shh-very"}', 'shh-very'],
  ['DBPWD=abc', 'abc'],
  ['the passphrase: correct-horse', 'correct-horse'],
  [`token=${BLOB}`, BLOB],
  [`https://example.com/hook?token=${BLOB}&mode=fast`, BLOB],
  [`x-api-key: ${BLOB}`, BLOB],
  [`auth=${BLOB}`, BLOB],
  [`AUTH_TOKEN="${BLOB}"`, BLOB],
  [`apiKey: '${BLOB}'`, BLOB],
  [`CLIENTKEY=${BLOB}`, BLOB],
  [`session_id=${BLOB}; Path=/`, BLOB],
  [`secretAccessKey=${BLOB}`, BLOB],
  ['-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----', 'MIIEvQ'],
];

const NEGATIVE = [
  'author=OpenClawCommunity', // third-review reproduction (b)
  `author=${BLOB}`,
  `authors: ${BLOB}`,
  `authority=${BLOB}`,
  `authentication_method=${BLOB}`,
  `tokenizer=${BLOB}`,
  `tokenizerPath: ${BLOB}`,
  `keyboard=${BLOB}`,
  `keyboard_layout: ${BLOB}`,
  `monkey=${BLOB}`,
  `MONKEY=${BLOB}`,
  `turkey: ${BLOB}`,
  `hotkey=${BLOB}`,
  'secretary=Alice',
  'secretary: Alice Example',
  'passwordless=true',
  'compass=north',
  'bypass=true',
  'max_tokens=4096',
  'maxTokens: 200000',
  'token: none',
  'press any key: enter',
  'the bearer of this note',
  'http://localhost:18789/api/x?y=1',
  'http://127.0.0.1:3333',
  'postgresql://localhost:5432/db',
  'ssh://git@github.com/owner/repo.git',
  'http://[::1]:8080/x',
  'http://[2001:db8::1]:8080/a@b',
  'http://host:8080/path@x',
  'http://host:8080?mention=a@b',
  'https://example.com/a:b@c',
  'someone@example.com',
  'mailto:someone@example.com',
  'meet me @ 12:30, room 4',
  'claude-fable-5-2',
  'anthropic/claude-sonnet-5.5',
  'ollama/qwen3:32b',
  'task-management-system',
  'sk-learn',
  '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
  '/Users/someone/clawd/mission-control/data',
  '2026-11-11T10:00:00.000Z',
  'The quick brown fox: it jumps over the lazy dog = fine.',
  'key findings: authentication works; tokens are counted per session',
  '*/5 * * * *',
];

test('redactString table: 30+ strings that must lose their credential', () => {
  assert.ok(POSITIVE.length >= 30);
  for (const [input, secret] of POSITIVE) {
    const out = redactString(input);
    assert.equal(out.includes(secret), false, `${JSON.stringify(input)} -> ${JSON.stringify(out)} still contains ${secret}`);
    assert.match(out, /\[redacted\]/, input);
    assert.equal(redactString(out), out, `idempotent: ${input}`);
  }
  assert.equal(redactString('postgresql://user@tenant:PASS@localhost/db'), 'postgresql://user@tenant:[redacted]@localhost/db');
  assert.equal(redactString('http://user:pw123@[::1]:8080/x'), 'http://user:[redacted]@[::1]:8080/x');
});

test('redactString table: 30+ ordinary strings that must stay exactly as they are', () => {
  assert.ok(NEGATIVE.length >= 30);
  for (const input of NEGATIVE) assert.equal(redactString(input), input);
});

// --- review of cb9630e: allowlisted VALUES are constrained too --------------
test('counter-example: credentials inside allowlisted values do not pass (reviewer reproduction)', () => {
  const input = {
    name: 'Bearer SENTINEL1234567890',
    subtitle: 'postgresql://u:PASS@host/db',
    modules: { AKIAIOSFODNN7EXAMPLE: true, costs: true },
  };
  for (const view of [publicMcView(input), createSettingsService({ mcConfig: input }).getPublicConfig()]) {
    assert.deepEqual(view, { name: 'Mission Control', subtitle: 'Mission Control', modules: { costs: true } });
    assert.doesNotMatch(JSON.stringify(view), /SENTINEL|PASS|AKIA|redacted|Bearer|postgresql/);
  }
  // A secret that would be cut by the length bound is still caught whole.
  const straddling = `${'a'.repeat(110)} sk-proj-AbCdEf0123456789xyz`;
  assert.equal(publicMcView({ name: straddling }).name, 'Mission Control');
});

test('display strings are bounded and lose control characters', () => {
  const long = publicMcView({ name: 'x'.repeat(1_000_000), subtitle: 'é'.repeat(500) });
  assert.equal(long.name, 'x'.repeat(120));
  assert.equal(long.subtitle, 'é'.repeat(120));
  const dirty = publicMcView({ name: 'Mission\u0000 \u001b[31mControl\r\n\u0007\u007f\u0085 ‮!', subtitle: '\u0000\n\t' });
  assert.equal(dirty.name, 'Mission [31mControl!');
  assert.equal(dirty.subtitle, 'Mission Control', 'nothing printable left: the default label');
  assert.doesNotMatch(JSON.stringify(dirty), /\\u00|\\n|\\r|\\t|\\u2028|\\u202e/);
});

test('ordinary names and every real module id pass unchanged', () => {
  const modules = Object.fromEntries(PUBLIC_MODULE_IDS.map((id, index) => [id, index % 2 === 0]));
  for (const name of ['Mission Control', 'Müdür console', 'Ops — İstanbul 🚀', 'key: value board', 'Auth & Tokens (team 2)', 'a']) {
    const input = { name, subtitle: name, modules, aws: { enabled: false } };
    assert.deepEqual(publicMcView(structuredClone(input)), input, name);
  }
});

test('counter-example: an unknown module key is omitted; the list covers the frontend route registry and server reads', () => {
  assert.deepEqual(publicMcView({ modules: { costs: false, brandNewModule: true, Costs: true, constructor: true } }), { modules: { costs: false } });
  assert.equal(Object.isFrozen(PUBLIC_MODULE_IDS), true);
  assert.equal(new Set(PUBLIC_MODULE_IDS).size, PUBLIC_MODULE_IDS.length);
  const repo = path.join(__dirname, '..');
  const routes = fs.readFileSync(path.join(repo, 'frontend/src/appRoutes.tsx'), 'utf8');
  const used = new Set();
  for (const match of routes.matchAll(/\bmodule:\s*['"]([^'"]+)['"]/g)) used.add(match[1]);
  for (const match of routes.matchAll(/\banyModule:\s*\[([^\]]*)\]/g)) {
    for (const id of match[1].matchAll(/['"]([^'"]+)['"]/g)) used.add(id[1]);
  }
  assert.ok(used.size >= 10, 'the route registry was parsed');
  // What server/ reads from mcConfig.modules.
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (
    entry.isDirectory() ? walk(path.join(dir, entry.name)) : entry.name.endsWith('.js') ? [path.join(dir, entry.name)] : []));
  for (const file of walk(path.join(repo, 'server'))) {
    for (const match of fs.readFileSync(file, 'utf8').matchAll(/[cC]onfig\??\.modules\??\.([A-Za-z][A-Za-z0-9]*)\b/g)) used.add(match[1]);
  }
  for (const id of used) {
    assert.ok(PUBLIC_MODULE_IDS.includes(id), `module "${id}" is used but missing from PUBLIC_MODULE_IDS in server/core/config.js`);
  }
});

test('the schema refuses an unbounded string type', () => {
  assert.throws(() => projectPublic({ a: 'x' }, { a: 'string' }), /max/);
  assert.throws(() => projectPublic({ a: 'x' }, { a: { $string: {} } }), /max/);
  assert.throws(() => projectPublic({ a: {} }, { a: { $map: 'boolean' } }), /shape/);
  assert.deepEqual(projectPublic({ a: 'hello world', b: 'Bearer SENTINEL1234567890' }, { a: { $string: { max: 5 } }, b: { $string: { max: 50 } } }), { a: 'hello' });
});

test('a bad schema entry fails even when the config has no value there', () => {
  assert.throws(() => projectPublic({}, { deep: { label: 'string' } }), /max/);
  assert.throws(() => projectPublic({}, { list: { $array: { $string: { max: 0 } } } }), /max/);
});
