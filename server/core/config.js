'use strict';

// Configuration: load and validate once, never write at import.
//
//   const config = loadConfig({ rootDir });   // frozen
//   publicView(config)                        // redacted, safe to log or serve
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
// One implementation for structured data (redact) and for strings
// (redactString). Two independent layers:
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
// name=value / name: value inside a string. "Strong" names hide any value;
// "weak" names (token, key, ...) hide only a long opaque blob, so prose such
// as "press any key: enter" survives.
const ASSIGN_VALUE = '("[^"]*"|\'[^\']*\'|[^\\s"\',;&}\\]]+)';
const STRONG_ASSIGN = new RegExp(`([A-Za-z0-9_.-]*(?:password|passwd|passphrase|pwd|secret)[A-Za-z0-9_.-]*["']?\\s*[:=]\\s*)${ASSIGN_VALUE}`, 'gi');
const WEAK_ASSIGN = new RegExp(`([A-Za-z0-9_.-]*(?:token|key|auth|authorization|credential|cookie|session|signature)[A-Za-z0-9_.-]*["']?\\s*[:=]\\s*)${ASSIGN_VALUE}`, 'gi');
const OPAQUE_BLOB = /^["']?[A-Za-z0-9+/_=.~%-]{16,}["']?$/;

// Redact credentials inside one string. Idempotent; never throws.
function redactString(input) {
  if (typeof input !== 'string' || input.length < 6) return input;
  let text = input;
  // scheme://user:password@host -> the password only. The password runs to
  // the last "@" of the authority, so an unencoded "@" or ":" stays hidden.
  text = text.replace(/\b([a-z][a-z0-9+.-]*:\/\/[^\s/:@?#]*:)[^\s/?#]*@/gi, `$1${REDACTED}@`);
  // Authorization values and Bearer tokens. "Bearer" spelled as the HTTP
  // scheme always hides what follows; other casings need a token-like word.
  text = text.replace(/(authorization["']?\s*[:=]\s*["']?(?:basic|bearer|token|digest)\s+)[^\s"',;]+/gi, `$1${REDACTED}`);
  text = text.replace(/\bBearer\s+(?!\[redacted\])[A-Za-z0-9._~+/=-]+/g, `Bearer ${REDACTED}`);
  text = text.replace(/\b(bearer\s+)(?!\[redacted\])([A-Za-z0-9._~+/=-]{8,})/gi,
    (match, lead, token) => (/\d/.test(token) || token.length >= 20 ? `${lead}${REDACTED}` : match));
  for (const pattern of KEY_FORMATS) text = text.replace(pattern, REDACTED);
  text = text.replace(STRONG_ASSIGN, (match, lead, value) => (value ? `${lead}${REDACTED}` : match));
  text = text.replace(WEAK_ASSIGN, (match, lead, value) => (OPAQUE_BLOB.test(value) ? `${lead}${REDACTED}` : match));
  return text;
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

function publicView(config) {
  return redact(clone(config));
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

module.exports = {
  loadConfig,
  createConfigStore,
  publicView,
  redact,
  isSecretKey,
  redactString,
  resolveEnvPlaceholders,
  validateMcConfig,
  checkGatewayToken,
  deepFreeze,
  existingMode,
  BUILTIN_DEFAULTS,
};
