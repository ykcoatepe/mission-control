'use strict';

// Configuration: load and validate once, never write at import.
//
//   const config = loadConfig({ rootDir });   // frozen
//   publicView(config)                        // allowlisted fields only, safe to log or serve
//   publicMcView(mc)                          // the same for an mc-config document (/api/config)
//   const store = createConfigStore({ config });
//   store.legacyObject()                      // the one mutable mc-config object existing routers share
//   store.persist()                           // the only writer of mc-config.json (atomic tmp+rename)
//
// When mc-config.json is missing or unreadable, defaults are loaded in memory
// (from mc-config.default.json, else built-in) and the condition is reported
// in config.load.problems. Nothing is copied over the config file.
//
// Gateway token drift (mc-config gateway.token vs the OpenClaw gateway token)
// used to throw at import and crash the process before listen. It is now a
// reported state in config.gatewayTokenCheck, surfaced by /api/health and the
// startup log. No test pinned the throw.

const fsDefault = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const BUILTIN_DEFAULTS = Object.freeze({
  name: 'Mission Control',
  subtitle: 'Mission Control',
  modules: { dashboard: true, chat: true, workshop: true, costs: true, cron: true, agents: true, settings: true, skills: true },
  gateway: { port: 18789, token: '' },
  aws: { enabled: false, bucket: '', region: 'us-east-1' },
  notion: { enabled: false, dbId: '', token: '' },
  scout: { enabled: false, braveApiKey: '' },
  workspace: '',
  skillsPath: '',
  memoryPath: '',
});

// --- redaction ---------------------------------------------------------------
// redact() serves documents that must stay complete (the settings export)
// and redactString() free text. The PUBLIC config view uses neither: it is an
// allowlist (publicView / publicMcView below). Two independent layers:
//   1. by name: whatever sits under a credential-named key is replaced whole;
//   2. by value: every remaining string is scanned for credentials, whatever
//      its key is called (URL userinfo, Bearer tokens, well-known key formats,
//      name=value pairs with a credential-ish name).
//
// A key names a credential when, ignoring case and - _ . separators, it
// contains one of SECRET_WORDS or ends in one of SECRET_ENDINGS. Ordinary
// English words that happen to end in "key" are excepted.
const SECRET_WORDS = ['token', 'secret', 'password', 'passwd', 'passphrase', 'apikey', 'authorization',
  'cookie', 'credential', 'privatekey', 'accesskey', 'secretkey', 'sessionkey', 'sessionid', 'bearer'];
const SECRET_ENDINGS = ['key', 'pwd', 'auth', 'session', 'signature'];
const ORDINARY_KEY_WORDS = ['monkey', 'turkey', 'donkey', 'hotkey', 'hockey', 'jockey', 'whiskey'];
// Token counts are numbers, not credentials (maxTokens: 4096).
const TOKEN_COUNT_KEY = /(?:tokens|(?:max|min|total|input|output|prompt|completion|context|cache[d]?|reasoning)tokens?|token(?:count|limit|budget|usage))$/;

function squashKey(keyName) {
  return String(keyName || '').toLowerCase().replace(/[-_.\s]/g, '');
}

function isSecretKey(keyName) {
  const squashed = squashKey(keyName);
  if (!squashed) return false;
  if (SECRET_WORDS.some((word) => squashed.includes(word))) return true;
  if (ORDINARY_KEY_WORDS.some((word) => squashed.endsWith(word))) return false;
  return SECRET_ENDINGS.some((ending) => squashed.endsWith(ending));
}

const REDACTED = '[redacted]';
const KEY_FORMATS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\bsk-(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{12,}/g, // OpenAI / Anthropic style
  /\bxox[baprs]-[A-Za-z0-9-]{8,}/g, // Slack
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g, // GitHub
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bglpat-[A-Za-z0-9_-]{16,}/g, // GitLab
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, // AWS access key id
  /\bAIza[0-9A-Za-z_-]{30,}/g, // Google API key
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g, // JWT
  /\b\d{6,}:[A-Za-z0-9_-]{30,}/g, // Telegram bot token
];
// --- redactString: second line of defence for free text ----------------------
// (log lines, CLI error text, page bodies, the settings export). The public
// config view does NOT rely on it: that view is an allowlist (see below).

// URL-looking substrings: the userinfo runs through the FINAL "@" of the
// authority, as the WHATWG URL parser reads it, so "user@tenant:PASS@host" and
// passwords containing "@" or ":" are covered. A candidate the parser rejects
// gets the widest reading (through its last "@").
const URL_CANDIDATE = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>`]+/gi;
const OPAQUE_USER = /^[A-Za-z0-9+/_=.~%-]{20,}$/;

function redactUrlUserinfo(candidate) {
  const schemeEnd = candidate.indexOf('://') + 3;
  let parsed = null;
  try {
    parsed = new URL(candidate);
  } catch {}
  let authorityEnd = candidate.length;
  if (parsed) {
    const terminator = candidate.slice(schemeEnd).search(/[/?#]/);
    if (terminator !== -1) authorityEnd = schemeEnd + terminator;
  }
  const at = candidate.lastIndexOf('@', authorityEnd - 1);
  if (at < schemeEnd) return candidate;
  const userinfo = candidate.slice(schemeEnd, at);
  // As the parser reads it: user = up to the first ":", password = the rest
  // (so "user@tenant:PASS" and "user:p@ss:w0rd" both lose the password).
  const colon = userinfo.indexOf(':');
  if (colon === -1) {
    if (!OPAQUE_USER.test(userinfo)) return candidate; // ssh://git@host
    return `${candidate.slice(0, schemeEnd)}${REDACTED}${candidate.slice(at)}`;
  }
  if (userinfo.slice(colon + 1) === REDACTED) return candidate;
  return `${candidate.slice(0, schemeEnd)}${userinfo.slice(0, colon + 1)}${REDACTED}${candidate.slice(at)}`;
}

// name=value / name: value. The COMPLETE name is split into words (separators
// and camelCase) and each whole word is classified; a credential word inside
// a longer word (author, tokenizer, keyboard, monkey, secretary) never
// matches. "Strong" names hide any value; "weak" names (token, key, auth...)
// hide only a long opaque blob, so "press any key: enter" survives.
const STRONG_WORDS = new Set(['password', 'passwords', 'passwd', 'passphrase', 'pwd', 'secret', 'secrets']);
const STRONG_SUFFIXES = ['password', 'passwd', 'passphrase', 'pwd', 'secret'];
const WEAK_WORDS = new Set(['token', 'tokens', 'key', 'keys', 'auth', 'oauth', 'authorization', 'credential', 'credentials',
  'cookie', 'cookies', 'session', 'sessions', 'signature', 'bearer', 'apikey', 'apikeys',
  // run-together compounds (CLIENTKEY, sessionid): listed, never guessed from a "key" suffix
  'clientkey', 'secretkey', 'accesskey', 'privatekey', 'sessionkey', 'authkey', 'signingkey', 'masterkey',
  'encryptionkey', 'appkey', 'licensekey', 'sessionid']);
const WEAK_SUFFIXES = ['token', 'apikey', 'credential', 'credentials'];
const ASSIGN_NAME = /(?<![A-Za-z0-9_.-])([A-Za-z0-9_.-]+)(["']?\s*[:=]\s*)/g;
const ASSIGN_VALUE = /"[^"]*"|'[^']*'|[^\s"',;&}\]]+/y;
const OPAQUE_BLOB = /^["']?[A-Za-z0-9+/_=.~%-]{16,}["']?$/;

function nameWords(name) {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((word) => word.toLowerCase());
}

// 'strong' | 'weak' | null
function classifyAssignmentName(name) {
  const words = nameWords(name);
  if (words.some((word) => STRONG_WORDS.has(word) || STRONG_SUFFIXES.some((suffix) => word.endsWith(suffix)))) return 'strong';
  if (words.some((word) => WEAK_WORDS.has(word) || WEAK_SUFFIXES.some((suffix) => word.endsWith(suffix)))) return 'weak';
  return null;
}

function redactAssignments(text) {
  let out = '';
  let cursor = 0;
  ASSIGN_NAME.lastIndex = 0;
  for (let match = ASSIGN_NAME.exec(text); match; match = ASSIGN_NAME.exec(text)) {
    const valueStart = match.index + match[0].length;
    const strength = classifyAssignmentName(match[1]);
    if (!strength) continue; // the value is scanned again: it may hold its own name=value
    ASSIGN_VALUE.lastIndex = valueStart;
    const value = ASSIGN_VALUE.exec(text)?.[0];
    if (!value || text.startsWith(REDACTED, /^["']/.test(value) ? valueStart + 1 : valueStart)) continue;
    if (strength === 'weak' && !OPAQUE_BLOB.test(value)) continue;
    out += text.slice(cursor, valueStart) + REDACTED;
    cursor = valueStart + value.length;
    ASSIGN_NAME.lastIndex = cursor;
  }
  return out + text.slice(cursor);
}

// Redact credentials inside one string. Idempotent; never throws.
function redactString(input) {
  if (typeof input !== 'string' || input.length < 6) return input;
  let text = input.replace(URL_CANDIDATE, redactUrlUserinfo);
  // Authorization values and Bearer tokens. "Bearer" spelled as the HTTP
  // scheme always hides what follows; other casings need a token-like word.
  text = text.replace(/(authorization["']?\s*[:=]\s*["']?(?:basic|bearer|token|digest)\s+)(?!\[redacted\])[^\s"',;]+/gi, `$1${REDACTED}`);
  text = text.replace(/\bBearer\s+(?!\[redacted\])[A-Za-z0-9._~+/=-]+/g, `Bearer ${REDACTED}`);
  text = text.replace(/\b(bearer\s+)(?!\[redacted\])([A-Za-z0-9._~+/=-]{8,})/gi,
    (match, lead, token) => (/\d/.test(token) || token.length >= 20 ? `${lead}${REDACTED}` : match));
  for (const pattern of KEY_FORMATS) text = text.replace(pattern, REDACTED);
  return redactAssignments(text);
}

// --- public view: an allowlist ---------------------------------------------
// What may leave the process as "the config" is listed here, path by path.
// Anything not listed is OMITTED (not redacted): unknown fields, future
// fields, wrong types. No credential-bearing field may ever be added.
//
// Shapes:  'number' | 'boolean'
//          { $string: { max, fallback? } }
//                                a display string: control characters are
//                                stripped, it is cut to `max` characters, and
//                                it must survive redactString unchanged. If
//                                redaction would change it (it carries a
//                                credential) or nothing printable is left, the
//                                field becomes `fallback`, or is omitted when
//                                there is none. `max` is required: there is
//                                no unbounded string type.
//          'url'                 parsed with the WHATWG URL parser, username
//                                and password stripped; omitted if it does
//                                not parse as scheme://host
//          { key: shape, ... }   an object; only the listed children
//          { $array: shape }     an array of that element shape
// There is no open-ended map: every key that can appear is written down.
//
// Derived from the consumers of GET /api/config:
//   name, subtitle   sidebar / document title (frontend/src/lib/useNavigation.ts)
//   modules          route and sidebar filtering (appRoutes.tsx isRouteEnabled)
//   aws.enabled      Usage page AWS toggle (pages/costs/lib.ts awsIntegrationEnabled)

// Every module id that may appear in the public view: the `module` /
// `anyModule` keys of the route registry (frontend/src/appRoutes.tsx) plus the
// flags server/ reads (modules.aws, modules.gbrainTimeline). A new module id
// must be added here; tests/corePublicView.test.js fails when the frontend
// registry or server/ uses one that is missing.
const PUBLIC_MODULE_IDS = Object.freeze([
  'dashboard', 'attention', 'cron', 'costs', 'services', 'ollamaMonitor', 'settings', 'councils', 'gbrain',
  'calendar', 'workshop', 'chat', 'agents', 'office', 'team', 'docs', 'scout', 'aws', 'skills', 'gbrainTimeline',
]);

const DISPLAY_LABEL = { $string: { max: 120, fallback: BUILTIN_DEFAULTS.name } };
const PUBLIC_MC_SCHEMA = deepFreeze({
  name: DISPLAY_LABEL,
  subtitle: DISPLAY_LABEL,
  modules: Object.fromEntries(PUBLIC_MODULE_IDS.map((id) => [id, 'boolean'])),
  aws: { enabled: 'boolean' },
});

// The loaded config (publicView). server/index.js logs `.server`; the rest is
// what /api/health already reports.
const PUBLIC_CONFIG_SCHEMA = deepFreeze({
  server: { port: 'number', host: { $string: { max: 255 } } },
  guard: { writeGuardMode: { $string: { max: 32 } } },
  load: { source: { $string: { max: 64 } }, problems: { $array: { $string: { max: 300 } } } },
  gatewayTokenCheck: { state: { $string: { max: 32 } }, ok: 'boolean', message: { $string: { max: 300 } } },
  mc: PUBLIC_MC_SCHEMA,
});

const OMIT = Symbol('omit');
// C0/C1 controls, DEL, line/paragraph separators, bidi and zero-width marks.
const UNPRINTABLE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;
const DISPLAY_SCAN_CHARS = 4096;

function publicString(value, rule) {
  if (!Number.isInteger(rule?.max) || rule.max < 1 || rule.max > DISPLAY_SCAN_CHARS) {
    throw new TypeError('public schema: $string needs an integer max between 1 and 4096');
  }
  const fallback = typeof rule.fallback === 'string' ? rule.fallback : OMIT;
  if (typeof value !== 'string') return OMIT;
  // Scan well past `max`, so a credential cut by the length bound is still
  // seen whole; control characters go first so they cannot split a pattern.
  const cleaned = value.slice(0, DISPLAY_SCAN_CHARS).replace(UNPRINTABLE, '').trim();
  if (!cleaned) return fallback;
  if (redactString(cleaned) !== cleaned) return fallback;
  return Array.from(cleaned.slice(0, rule.max * 2)).slice(0, rule.max).join('');
}

function publicUrl(value) {
  if (typeof value !== 'string') return OMIT;
  let url;
  try {
    url = new URL(value);
  } catch {
    return OMIT;
  }
  if (!url.host) return OMIT; // "user:pass@host", mailto:, opaque paths
  try {
    url.username = '';
    url.password = '';
  } catch {
    return OMIT;
  }
  if (url.username || url.password) return OMIT;
  return url.href;
}

function projectValue(value, shape) {
  if (shape === 'number') return typeof value === 'number' && Number.isFinite(value) ? value : OMIT;
  if (shape === 'boolean') return typeof value === 'boolean' ? value : OMIT;
  if (shape === 'url') return publicUrl(value);
  if (shape === 'string') throw new TypeError('public schema: use { $string: { max } }; there is no unbounded string type (max is required)');
  if (!isPlainObject(shape)) throw new TypeError('public schema: unknown shape');
  if (Object.hasOwn(shape, '$string')) return publicString(value, shape.$string);
  if (Object.hasOwn(shape, '$array')) {
    if (!Array.isArray(value)) return OMIT;
    return value.map((item) => projectValue(item, shape.$array)).filter((item) => item !== OMIT);
  }
  const reserved = Object.keys(shape).find((key) => key.startsWith('$'));
  if (reserved) throw new TypeError(`public schema: unknown shape ${reserved}`);
  if (!isPlainObject(value)) return OMIT;
  const out = {};
  for (const key of Object.keys(shape)) {
    if (!Object.hasOwn(value, key)) continue;
    const inner = projectValue(value[key], shape[key]);
    if (inner !== OMIT) out[key] = inner;
  }
  return out;
}

// A schema is checked whole before use, so a bad entry fails even when the
// config has no value at that path.
function assertPublicSchema(shape) {
  if (shape === 'number' || shape === 'boolean' || shape === 'url') return;
  if (shape === 'string') throw new TypeError('public schema: use { $string: { max } }; there is no unbounded string type (max is required)');
  if (!isPlainObject(shape)) throw new TypeError('public schema: unknown shape');
  if (Object.hasOwn(shape, '$string')) {
    const max = shape.$string?.max;
    if (!Number.isInteger(max) || max < 1 || max > DISPLAY_SCAN_CHARS) throw new TypeError('public schema: $string needs an integer max between 1 and 4096');
    return;
  }
  if (Object.hasOwn(shape, '$array')) return assertPublicSchema(shape.$array);
  for (const [key, inner] of Object.entries(shape)) {
    if (key.startsWith('$')) throw new TypeError(`public schema: unknown shape ${key}`);
    assertPublicSchema(inner);
  }
  return undefined;
}

// Project a value onto an allowlist shape. Always returns a fresh object.
function projectPublic(value, shape) {
  assertPublicSchema(shape);
  const out = projectValue(value, shape);
  return out === OMIT ? {} : out;
}

// The public form of an mc-config document (GET /api/config).
function publicMcView(mc) {
  return projectPublic(mc, PUBLIC_MC_SCHEMA);
}

function resolveEnvPlaceholders(value, env = process.env) {
  if (typeof value !== 'string') return value;
  return value.replace(/\$\{([A-Z0-9_]+)\}/gi, (_, name) => env[name] || '');
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function readJson(fsImpl, file) {
  return JSON.parse(fsImpl.readFileSync(file, 'utf8'));
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

// Light schema check: wrong types are reported, never fatal. Returns problems.
function validateMcConfig(raw) {
  const problems = [];
  if (!isPlainObject(raw)) return ['mc-config is not a JSON object'];
  const expectObject = (key) => {
    if (raw[key] !== undefined && !isPlainObject(raw[key])) problems.push(`${key} must be an object`);
  };
  const expectString = (key) => {
    if (raw[key] !== undefined && typeof raw[key] !== 'string') problems.push(`${key} must be a string`);
  };
  ['modules', 'gateway', 'aws', 'notion', 'scout', 'budget', 'ollama', 'hermes', 'security'].forEach(expectObject);
  ['name', 'subtitle', 'workspace', 'skillsPath', 'memoryPath'].forEach(expectString);
  const gwPort = raw.gateway?.port;
  if (gwPort !== undefined && !(Number.isInteger(Number(gwPort)) && Number(gwPort) > 0 && Number(gwPort) < 65536)) {
    problems.push('gateway.port must be a TCP port');
  }
  const mode = raw.security?.writeGuard;
  if (mode !== undefined && mode !== 'report-only' && mode !== 'enforce') {
    problems.push('security.writeGuard must be "report-only" or "enforce"');
  }
  return problems;
}

function checkGatewayToken({ openclawConfig, openclawConfigError, mcConfig }) {
  if (openclawConfigError) {
    if (openclawConfigError.code === 'ENOENT') {
      return { state: 'skipped', ok: true, message: 'OpenClaw config not found; gateway token validation skipped until setup completes' };
    }
    return { state: 'unreadable', ok: false, message: 'OpenClaw config could not be read' };
  }
  const authMode = openclawConfig?.gateway?.auth?.mode || openclawConfig?.gateway?.http?.auth?.mode || '';
  const authToken = openclawConfig?.gateway?.auth?.token || openclawConfig?.gateway?.http?.auth?.token || '';
  const remoteToken = openclawConfig?.gateway?.remote?.token || '';
  const mcToken = mcConfig?.gateway?.token || '';
  if (authMode === 'none') return { state: 'ok', ok: true, message: 'Gateway auth disabled' };
  if (authToken && remoteToken && authToken !== remoteToken) {
    return { state: 'mismatch', ok: false, message: 'Gateway token mismatch: openclaw gateway.auth.token != gateway.remote.token' };
  }
  if (authToken && mcToken && authToken !== mcToken) {
    return { state: 'drift', ok: false, message: 'Mission Control token drift: mc-config gateway.token does not match openclaw gateway auth token' };
  }
  return { state: 'ok', ok: true, message: 'Gateway token consistent' };
}

function resolveOpenclawBin(fsImpl) {
  return ['/opt/homebrew/bin/openclaw', '/usr/local/bin/openclaw', 'openclaw'].find((candidate) => {
    try {
      return candidate === 'openclaw' || fsImpl.existsSync(candidate);
    } catch {
      return candidate === 'openclaw';
    }
  });
}

function loadConfig({
  rootDir,
  env = process.env,
  homeDir = os.homedir(),
  fsImpl = fsDefault,
} = {}) {
  if (!rootDir) throw new TypeError('loadConfig: rootDir is required');
  const problems = [];
  const mcConfigPath = path.join(rootDir, 'mc-config.json');
  const mcDefaultConfigPath = path.join(rootDir, 'mc-config.default.json');

  let mc;
  let source;
  try {
    mc = readJson(fsImpl, mcConfigPath);
    source = 'file';
  } catch (error) {
    problems.push(error?.code === 'ENOENT'
      ? 'mc-config.json not found; running on in-memory defaults (not written)'
      : 'mc-config.json could not be parsed; running on in-memory defaults (file left untouched)');
    try {
      mc = readJson(fsImpl, mcDefaultConfigPath);
      source = 'default-template';
    } catch {
      mc = clone(BUILTIN_DEFAULTS);
      source = 'builtin-defaults';
    }
  }
  if (!isPlainObject(mc)) {
    problems.push('mc-config root is not an object; using built-in defaults');
    mc = clone(BUILTIN_DEFAULTS);
    source = 'builtin-defaults';
  }
  problems.push(...validateMcConfig(mc));

  const openclawConfigPath = path.join(homeDir, '.openclaw/openclaw.json');
  let openclawConfig = null;
  let openclawConfigError = null;
  try {
    openclawConfig = readJson(fsImpl, openclawConfigPath);
  } catch (error) {
    openclawConfigError = error;
  }

  const gatewayPort = Number(mc.gateway?.port) || 18789;
  let gatewayToken = openclawConfig?.gateway?.auth?.token || openclawConfig?.gateway?.http?.auth?.token || '';
  if (!gatewayToken) gatewayToken = resolveEnvPlaceholders(mc.gateway?.token || '', env);
  const workspacePath = mc.workspace || openclawConfig?.agents?.defaults?.workspace || path.join(homeDir, 'clawd');

  const envMode = String(env.MC_WRITE_GUARD || '').trim();
  const writeGuardMode = envMode === 'enforce' || envMode === 'report-only'
    ? envMode
    : (mc.security?.writeGuard === 'enforce' ? 'enforce' : 'report-only');

  const config = {
    rootDir,
    homeDir,
    server: {
      port: Number(env.PORT) || 3333,
      host: env.MISSION_CONTROL_HOST || '127.0.0.1',
    },
    paths: {
      mcConfig: mcConfigPath,
      mcDefaultConfig: mcDefaultConfigPath,
      openclawConfig: openclawConfigPath,
      dataDir: path.join(rootDir, 'data'),
      runtimeDir: path.join(rootDir, 'data/runtime'),
      auditFile: path.join(rootDir, 'data/audit/write-events.json'),
      frontendDist: path.join(rootDir, 'frontend/dist'),
      publicDir: path.join(rootDir, 'public'),
    },
    gateway: { port: gatewayPort, token: gatewayToken },
    notion: {
      dbId: mc.notion?.dbId || '',
      token: resolveEnvPlaceholders(mc.notion?.token || '', env),
    },
    aws: {
      bucket: mc.aws?.bucket || '',
      region: resolveEnvPlaceholders(mc.aws?.region || env.AWS_REGION || 'us-east-1', env),
      accessKeyId: resolveEnvPlaceholders(mc.aws?.accessKeyId || env.AWS_ACCESS_KEY_ID || '', env),
      secretAccessKey: resolveEnvPlaceholders(mc.aws?.secretAccessKey || env.AWS_SECRET_ACCESS_KEY || '', env),
    },
    workspacePath,
    skillsPath: mc.skillsPath || path.join(workspacePath, 'skills'),
    memoryPath: mc.memoryPath || path.join(workspacePath, 'memory'),
    openclawBin: resolveOpenclawBin(fsImpl),
    guard: { writeGuardMode },
    load: { source, problems },
    gatewayTokenCheck: checkGatewayToken({ openclawConfig, openclawConfigError, mcConfig: mc }),
    mc: clone(mc),
  };
  return deepFreeze(config);
}

function existingMode(fsImpl, file) {
  try {
    return fsImpl.statSync(file).mode & 0o777;
  } catch {
    return null;
  }
}

function redactSecretValue(value) {
  if (value === '' || value === null || value === undefined) return value;
  if (typeof value === 'boolean') return value; // "is configured" flags are not secrets
  return REDACTED;
}

// Redact by key first, then recurse: whatever sits under a credential key
// (string, number, array, object) is replaced whole. Every other string is
// scanned by value.
function redact(value, keyName = '') {
  if (keyName && isSecretKey(keyName)
    && !(typeof value === 'number' && TOKEN_COUNT_KEY.test(squashKey(keyName)))) {
    return redactSecretValue(value);
  }
  if (typeof value === 'string') return redactString(value);
  if (Array.isArray(value)) return value.map((item) => redact(item));
  if (isPlainObject(value)) {
    const out = {};
    for (const [key, inner] of Object.entries(value)) out[key] = redact(inner, key);
    return out;
  }
  return value;
}

// The public form of a loaded config: the allowlist above, nothing else.
function publicView(config) {
  return projectPublic(config, PUBLIC_CONFIG_SCHEMA);
}

// The only writer of mc-config.json. Writes are synchronous (so two writes in
// this process can never interleave), go to a unique temp file in the same
// directory, and are renamed over the target only when complete. On any
// failure the temp file is removed and the target is untouched.
function createConfigStore({ config, fsImpl = fsDefault, logger = console } = {}) {
  if (!config?.paths?.mcConfig) throw new TypeError('createConfigStore: config is required');
  const filePath = config.paths.mcConfig;
  const working = clone(config.mc);
  let current = deepFreeze(clone(working));
  let seq = 0;
  let writes = 0;

  function atomicWrite(text) {
    seq += 1;
    const tmp = `${filePath}.tmp-${process.pid}-${seq}-${crypto.randomBytes(4).toString('hex')}`;
    try {
      // The temp file is created 0600 (never world-readable, whatever the
      // umask) and takes the target's existing mode before the rename, so a
      // 0600 config stays 0600. A new config file is 0600.
      const mode = existingMode(fsImpl, filePath) ?? 0o600;
      fsImpl.writeFileSync(tmp, text, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      fsImpl.chmodSync(tmp, mode);
      fsImpl.renameSync(tmp, filePath);
      writes += 1;
    } catch (error) {
      try {
        fsImpl.rmSync(tmp, { force: true });
      } catch {}
      logger?.error?.(`[config] write failed: ${error?.message || error}`);
      throw error;
    }
  }

  // Persist the shared legacy object (or a replacement object).
  function persist(next = working) {
    if (!isPlainObject(next)) throw new TypeError('config persist: object required');
    const text = JSON.stringify(next, null, 2);
    atomicWrite(text);
    current = deepFreeze(clone(next));
    return current;
  }

  // Replace the file with raw JSON text (settings import). Keeps a backup of
  // the previous file. The in-memory config is not swapped: import requires a
  // restart, as before.
  function importRaw(text, { backup = true, now = Date.now } = {}) {
    JSON.parse(text);
    if (backup && fsImpl.existsSync(filePath)) {
      fsImpl.copyFileSync(filePath, `${filePath}.backup.${now()}`);
    }
    atomicWrite(text);
  }

  return {
    filePath,
    legacyObject: () => working,
    current: () => current,
    persist,
    importRaw,
    status: () => ({ filePath, writes }),
  };
}

assertPublicSchema(PUBLIC_CONFIG_SCHEMA);

module.exports = {
  loadConfig,
  createConfigStore,
  publicView,
  redact,
  isSecretKey,
  redactString,
  publicMcView,
  projectPublic,
  PUBLIC_MC_SCHEMA,
  PUBLIC_MODULE_IDS,
  PUBLIC_CONFIG_SCHEMA,
  resolveEnvPlaceholders,
  validateMcConfig,
  checkGatewayToken,
  deepFreeze,
  existingMode,
  BUILTIN_DEFAULTS,
};
