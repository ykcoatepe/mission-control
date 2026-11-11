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

const SECRET_KEY_PATTERN = /(token|secret|password|apikey|api_key|accesskey|access_key|braveapikey)/i;

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

function redact(value, keyName = '') {
  if (Array.isArray(value)) return value.map((item) => redact(item));
  if (isPlainObject(value)) {
    const out = {};
    for (const [key, inner] of Object.entries(value)) out[key] = redact(inner, key);
    return out;
  }
  if (SECRET_KEY_PATTERN.test(keyName) && typeof value === 'string') return value ? '[redacted]' : '';
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
      fsImpl.writeFileSync(tmp, text, 'utf8');
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
  resolveEnvPlaceholders,
  validateMcConfig,
  checkGatewayToken,
  deepFreeze,
  BUILTIN_DEFAULTS,
};
