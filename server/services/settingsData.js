const fs = require('fs');
const path = require('path');
const os = require('os');
const { redact, publicMcView, validateMcConfig, PUBLIC_MODULE_IDS } = require('../core/config');
const { httpError } = require('../core/http');
const { homeRelativePath } = require('../core/scrub');

// The core scanner deliberately bounds URL schemes. Exports must also hide
// userinfo behind longer schemes. Scan separators instead of retrying an
// unbounded scheme pattern at every letter. Backward scheme runs are disjoint
// (a previous :// stops them); forward authority runs end at the next slash or
// whitespace, before another candidate's authority can start. Total work O(n).
function hasUrlCredentials(value) {
  const isLetter = code => (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
  for (let separator = value.indexOf('://'); separator >= 0; separator = value.indexOf('://', separator + 3)) {
    let letter = false;
    for (let i = separator - 1; i >= 0; i--) {
      const code = value.charCodeAt(i);
      if (isLetter(code)) letter = true;
      else if (!((code >= 48 && code <= 57) || code === 43 || code === 45 || code === 46)) break;
    }
    if (!letter) continue;
    let colon = false;
    for (let i = separator + 3; i < value.length; i++) {
      const char = value[i];
      if (char === '/' || /^\s$/.test(char)) break;
      if (char === ':') colon = true;
      if (char === '@' && colon) return true;
    }
  }
  return false;
}

function normalizeMonthlyBudget(monthly) {
  if (monthly === null) return null;
  if (typeof monthly !== 'number' || !Number.isFinite(monthly) || monthly < 0) {
    throw httpError(400, 'invalid_budget', 'monthly budget must be a finite number, zero or positive, or null');
  }
  return monthly;
}

function validateSettingsDocument(document) {
  if (validateMcConfig(document).length) throw httpError(400, 'invalid_config', 'Invalid configuration');
  if (Object.hasOwn(document.budget || {}, 'monthly')) normalizeMonthlyBudget(document.budget.monthly);
}

// Object-path placeholders preserve an existing value whole, including whole
// credential containers. Array entries need a stable identity: their position
// is never evidence that they refer to the same entity after an edit.
const OMIT_REDACTED = Symbol('omit-redacted');
function containsRedactedValue(value) {
  if (typeof value === 'string') return /\[redacted\]/i.test(value);
  if (Array.isArray(value)) return value.some(containsRedactedValue);
  return value != null && typeof value === 'object' && Object.values(value).some(containsRedactedValue);
}

function isIdentityObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function arrayIdentity(value, field) {
  if (!field || !isIdentityObject(value) || !Object.hasOwn(value, field)) return null;
  const identity = value[field];
  if (typeof identity === 'string' && identity.trim() && !containsRedactedValue(identity)) return `string:${identity}`;
  if (typeof identity === 'number' && Number.isFinite(identity)) return `number:${identity}`;
  return null;
}

// Public structural labels make failures useful; unknown property names use
// ordinals, since arbitrary extension keys can themselves contain secrets.
const SAFE_IMPORT_PATH_FIELDS = new Set([
  'providers', 'provider', 'nested', 'children', 'items', 'groups', 'scout',
  'queries', 'q', 'category', 'source', 'weight', 'id', 'name', 'key', 'apiKey',
  'apiKeys', 'api_key', 'api_keys', 'token', 'tokens', 'secret', 'password',
  'credentials', 'authorization', 'connection', 'gateway', 'auth', 'budget',
  'monthly', 'modules', 'ollama', 'hermes', 'security', 'aws', 'notion',
]);
function importFieldPath(parent, key, index) {
  return SAFE_IMPORT_PATH_FIELDS.has(key) ? `${parent}.${key}` : `${parent}.property[${index}]`;
}

function arrayIdentityError(path) {
  // Paths contain public structural labels/ordinals and array indices, never
  // identity values or untrusted property names.
  return httpError(400, 'redacted_identity_required', `Redacted array value requires a unique matching identity at ${path}`);
}

function restoreRedactedValues(imported, current, hasCurrent = false, path = [], safePath = '$', inArrayEntry = false) {
  if (typeof imported === 'string' && /\[redacted\]/i.test(imported)) {
    if (!hasCurrent && inArrayEntry) throw arrayIdentityError(safePath);
    // A previously persisted marker is not a genuine secret. This also checks
    // whole containers so a backup cannot re-save unknown nested credentials.
    if (hasCurrent && containsRedactedValue(current)) {
      throw httpError(400, 'redacted_value_unavailable', `Current value cannot restore a redacted field at ${safePath}`);
    }
    return hasCurrent ? structuredClone(current) : OMIT_REDACTED;
  }
  if (Array.isArray(imported)) {
    if (!containsRedactedValue(imported)) return structuredClone(imported);
    const previous = Array.isArray(current) ? current : [];
    // Existing identity policy dominates. A new real-secret entry with an id
    // must not change a name-based array's established matching policy.
    const fields = path.length === 2 && path[0] === 'scout' && path[1] === 'queries'
      ? ['id', 'name', 'key', 'q'] : ['id', 'name', 'key'];
    const field = fields.find((candidate) => previous.some((entry) => isIdentityObject(entry) && Object.hasOwn(entry, candidate)));
    const currentByIdentity = new Map();
    for (const [index, entry] of previous.entries()) {
      const identity = arrayIdentity(entry, field);
      // An unidentified old entry may simply have been removed. It can never
      // supply a restored value, so leave it out of the matching index.
      if (identity === null) continue;
      if (currentByIdentity.has(identity)) throw arrayIdentityError(`${safePath}[${index}]`);
      currentByIdentity.set(identity, entry);
    }
    const importedIdentities = new Set();
    for (const [index, entry] of imported.entries()) {
      const identity = arrayIdentity(entry, field);
      if (identity !== null && importedIdentities.has(identity)) throw arrayIdentityError(`${safePath}[${index}]`);
      if (identity !== null) importedIdentities.add(identity);
      if (containsRedactedValue(entry) && (identity === null || !currentByIdentity.has(identity))) throw arrayIdentityError(`${safePath}[${index}]`);
    }
    return imported.map((entry, index) => {
      if (!containsRedactedValue(entry)) return structuredClone(entry);
      const matched = currentByIdentity.get(arrayIdentity(entry, field));
      return restoreRedactedValues(entry, matched, true, [...path, index], `${safePath}[${index}]`, true);
    });
  }
  if (imported && typeof imported === 'object') {
    return Object.fromEntries(Object.entries(imported).map(([key, value], index) => [key,
      restoreRedactedValues(value, current?.[key], current != null && typeof current === 'object' && Object.hasOwn(current, key), [...path, key], importFieldPath(safePath, key, index), inArrayEntry),
    ]).filter(([, value]) => value !== OMIT_REDACTED));
  }
  return imported;
}

const SETUP_FIELDS = new Set(['dashboardName', 'gateway', 'modules']);
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function createSettingsService({
  mcConfig,
  missionControlConfigPath,
  missionControlDefaultConfigPath,
  missionControlPackagePath,
  missionControlRoot,
  gatewayPort,
  gatewayToken,
  memoryPath,
  skillsPath,
  bedrockRegion,
  openclawExec,
  // Missing stores fail closed; tests inject the same core store.
  configStore = null,
  fsImpl = fs,
  homeDir = os.homedir(),
  fetchImpl = (...args) => fetch(...args),
  // () => reachability snapshot ({ data: { gateways: { openclaw: { state } } }, meta }).
  // Read from memory only; setup never probes the gateway itself.
  gatewayReachability = null,
}) {
  const fs = fsImpl;
  // Display paths are home-relative (core/scrub.js): no absolute home path
  // in a response, whichever alias of home the config uses.
  const homeRelative = (value) => (value ? homeRelativePath(value, { homeDir }) : null);
  const openclawConfigPath = path.join(homeDir, '.openclaw/openclaw.json');
  const committedOpenclawFields = new Map();
  let lastOpenclawConfig = null;
  let hasOpenclawMutation = false;
  let openclawReadMeta = null;
  let committedMcText = null;

  function localMeta(error = null) {
    return { ok: !error, stale: Boolean(error), observedAt: new Date().toISOString(), ageMs: 0,
      error, latencyMs: null, source: 'settings.local-config' };
  }

  function configuredGatewayPort() {
    const port = mcConfig.gateway?.port;
    return Number.isInteger(port) && port > 0 && port < 65536 ? port : null;
  }

  function replaceSharedConfig(next) {
    for (const key of Object.keys(mcConfig)) if (!Object.hasOwn(next, key)) delete mcConfig[key];
    Object.assign(mcConfig, next);
    committedMcText = JSON.stringify(next, null, 2);
  }

  function readCurrentMcConfig() {
    if (!missionControlConfigPath) return structuredClone(mcConfig);
    let current;
    try {
      current = JSON.parse(fs.readFileSync(missionControlConfigPath, 'utf8'));
      validateSettingsDocument(current);
    } catch (error) {
      if (error?.code === 'ENOENT') return structuredClone(mcConfig);
      throw httpError(503, 'settings_config_unavailable', 'Current configuration could not be read safely');
    }
    return current;
  }

  function persistMcConfig(next) {
    validateSettingsDocument(next);
    if (!configStore) throw httpError(503, 'config_store_unavailable', 'Configuration store is unavailable');
    configStore.persist(next);
    replaceSharedConfig(next);
  }

  function readOpenclawConfigRaw() {
    try {
      const parsed = JSON.parse(fs.readFileSync(openclawConfigPath, 'utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid config document');
      return parsed;
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw httpError(503, 'settings_config_unavailable', 'OpenClaw configuration could not be read');
    }
  }

  function readOpenclawConfigSafe() {
    let cfg, failed = false;
    try {
      cfg = readOpenclawConfigRaw();
      if (cfg) lastOpenclawConfig = structuredClone(cfg);
      else if (hasOpenclawMutation || committedMcText !== null) {
        cfg = lastOpenclawConfig === null ? null : structuredClone(lastOpenclawConfig);
        failed = true;
      }
    } catch (error) {
      if (!hasOpenclawMutation && committedMcText === null) throw error;
      cfg = lastOpenclawConfig === null ? null : structuredClone(lastOpenclawConfig);
      failed = true;
    }
    const projected = cfg == null && !committedOpenclawFields.size ? null : structuredClone(cfg || {});
    for (const [field, expected] of committedOpenclawFields) {
      const keys = field.split('.');
      let observed = cfg;
      for (const key of keys) observed = observed?.[key];
      if (!failed && (expected === null ? observed == null || observed === '' : observed === expected)) {
        committedOpenclawFields.delete(field);
        continue;
      }
      let target = projected;
      for (const key of keys.slice(0, -1)) {
        if (!target[key] || typeof target[key] !== 'object' || Array.isArray(target[key])) target[key] = {};
        target = target[key];
      }
      if (expected === null) delete target[keys.at(-1)]; else target[keys.at(-1)] = expected;
    }
    openclawReadMeta = localMeta(failed || committedOpenclawFields.size ? {
      code: failed ? 'settings_config_unavailable' : 'settings_refresh_pending',
      message: 'Saved values are visible; waiting for the local configuration read to confirm them',
    } : null);
    return projected;
  }

  async function reloadGatewayConfig() {
    try {
      await fetchImpl(`http://127.0.0.1:${gatewayPort}/config/reload`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${gatewayToken}` },
      });
    } catch {}
  }

  function readMissionControlVersion() {
    try {
      const pkg = JSON.parse(fs.readFileSync(missionControlPackagePath, 'utf8'));
      return pkg.version || null;
    } catch {
      return null;
    }
  }

  // GET /api/config: the allowlisted public view. Anything not on the core
  // allowlist (PUBLIC_MC_SCHEMA) is omitted, not redacted.
  function getPublicConfig() {
    return publicMcView(mcConfig);
  }

  // GET /api/settings/export: a backup, so the document stays complete and
  // secrets become redaction placeholders (the import restores them).
  function getExportConfig() {
    // Check names before recursing: secrets may be arrays or objects, and
    // ConfigStore's scalar redactor cannot preserve that parent-key context.
    function stripCredentials(value, key = '') {
      if (/(token|secret|password|api[_-]?key|access[_-]?key|credential|authorization|private[_-]?key|connection[_-]?string|(?:database|db)[_-]?url|dsn)/i.test(key)) return value == null ? null : '[redacted]';
      if (Array.isArray(value)) return value.map((item) => stripCredentials(item));
      if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, stripCredentials(item, name)]));
      if (typeof value === 'string' && hasUrlCredentials(value)) return '[redacted]';
      return value;
    }
    return stripCredentials(redact(mcConfig));
  }

  function getSettingsPayload() {
    const configData = readOpenclawConfigSafe();
    const defaultModel = configData?.agents?.defaults?.model?.primary
      || configData?.agents?.defaults?.model?.default
      || configData?.model?.default
      || (typeof configData?.model === 'string' ? configData.model : null);

    return {
      model: defaultModel,
      budget: { monthly: Number.isFinite(mcConfig.budget?.monthly) && mcConfig.budget.monthly >= 0 ? mcConfig.budget.monthly : null },
      ...(hasOpenclawMutation || committedMcText !== null ? { meta: openclawReadMeta } : {}),
      gateway_port: gatewayPort ?? null,
      configuredGatewayPort: configuredGatewayPort(),
      memory_path: homeRelative(memoryPath),
      skills_path: homeRelative(skillsPath),
      bedrock_region: bedrockRegion || null,
      system: {
        mission_control_version: readMissionControlVersion(),
        openclaw_version: configData?.meta?.openclawVersion || null,
        node_version: process.version,
        platform: process.platform,
        arch: process.arch,
      },
    };
  }

  function getModelRouting() {
    let cfg = null;
    try { cfg = readOpenclawConfigSafe(); } catch { /* Read failures stay visible below. */ }
    const observed = cfg !== null;
    const field = (keys) => {
      if (!observed) return { value: null, source: 'unreadable' };
      let value = cfg;
      for (const key of keys) {
        if (value == null) return { value: null, source: 'unset' };
        if (typeof value !== 'object' || Array.isArray(value)) return { value: null, source: 'unreadable' };
        value = Object.hasOwn(value, key) ? value[key] : undefined;
      }
      if (value == null || (typeof value === 'string' && !value.trim())) return { value: null, source: 'unset' };
      return typeof value === 'string'
        ? { value, source: 'set' }
        : { value: null, source: 'unreadable' };
    };
    const main = field(['agents', 'defaults', 'model', 'primary']);
    const subagent = field(['agents', 'defaults', 'subagents', 'model', 'primary']);
    const heartbeat = field(['agents', 'defaults', 'heartbeat', 'model']);
    const unreadable = [main, subagent, heartbeat].some((entry) => entry.source === 'unreadable');
    return {
      main: main.value, subagent: subagent.value, heartbeat: heartbeat.value,
      mainSource: main.source, subagentSource: subagent.source, heartbeatSource: heartbeat.source,
      meta: {
        ok: !unreadable, stale: unreadable,
        observedAt: observed ? new Date().toISOString() : null,
        ageMs: observed ? 0 : null, latencyMs: null, source: 'settings.local-config',
        error: unreadable ? {
          code: observed ? 'invalid_model_routing' : 'settings_config_unavailable',
          message: observed ? 'Some model routing fields could not be read' : 'OpenClaw configuration could not be read',
        } : null,
        ...((hasOpenclawMutation || committedMcText !== null) && openclawReadMeta?.stale ? openclawReadMeta : {}),
      },
    };
  }

  async function setModelRouting(body = {}) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw httpError(400, 'invalid_model', 'Model fields must be strings');
    const paths = {
      main: 'agents.defaults.model.primary',
      subagent: 'agents.defaults.subagents.model.primary',
      heartbeat: 'agents.defaults.heartbeat.model',
    };
    const provided = Object.keys(paths).filter((field) => Object.hasOwn(body, field));
    // Validate the complete patch before executing its first mutation.
    for (const field of provided) {
      const value = body[field];
      if (field === 'heartbeat' && value === '') continue;
      if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,255}$/.test(value)) {
        throw httpError(400, 'invalid_model', 'Model fields must contain a valid model identifier');
      }
    }
    if (provided.length) {
      const cfg = readOpenclawConfigRaw();
      if (cfg) lastOpenclawConfig = structuredClone(cfg);
    }
    for (const field of provided) {
      const value = body[field];
      await openclawExec(value === ''
        ? ['config', 'unset', paths[field]]
        : ['config', 'set', paths[field], value], 15000);
      committedOpenclawFields.set(paths[field], value === '' ? null : value);
      hasOpenclawMutation = true;
    }
    if (provided.length) await reloadGatewayConfig();
    return { status: 'saved', ...getModelRouting() };
  }

  function getHeartbeatSettings() {
    const cfg = readOpenclawConfigSafe();
    return { interval: cfg?.agents?.defaults?.heartbeat?.every || null,
      ...(hasOpenclawMutation || committedMcText !== null ? { meta: openclawReadMeta } : {}) };
  }

  async function setHeartbeatInterval(interval) {
    const normalized = typeof interval === 'string' ? interval.trim() : '';
    if (!/^\d+(?:ms|s|m|h|d)$/.test(normalized)) {
      throw httpError(400, 'invalid_interval', 'interval must be a duration such as 30m');
    }
    const cfg = readOpenclawConfigRaw();
    if (cfg) lastOpenclawConfig = structuredClone(cfg);
    await openclawExec(['config', 'set', 'agents.defaults.heartbeat.every', normalized], 15000);
    committedOpenclawFields.set('agents.defaults.heartbeat.every', normalized);
    hasOpenclawMutation = true;
    await reloadGatewayConfig();
    return { status: 'saved', ...getHeartbeatSettings() };
  }

  function updateBudget(monthly) {
    const normalized = normalizeMonthlyBudget(monthly);
    const current = readCurrentMcConfig();
    const next = { ...current, budget: { ...current.budget, monthly: normalized } };
    persistMcConfig(next);
    return { status: 'saved', budget: mcConfig.budget };
  }

  async function getSetupStatus() {
    const gatewayRunning = readGatewayRunning();
    const gatewayVersion = null;
    let setupMeta = null;

    let needsSetup = !fs.existsSync(missionControlConfigPath);
    if (!needsSetup && fs.existsSync(missionControlDefaultConfigPath)) {
      let currentConfig, defaultConfig;
      try {
        currentConfig = fs.readFileSync(missionControlConfigPath, 'utf8');
        defaultConfig = fs.readFileSync(missionControlDefaultConfigPath, 'utf8');
      } catch (error) {
        if (committedMcText === null) throw error;
        currentConfig = committedMcText;
        // The validated committed state is sufficient to display saved setup
        // fields even if a following file read fails. Do not fail the save.
        try { defaultConfig = fs.readFileSync(missionControlDefaultConfigPath, 'utf8'); } catch { defaultConfig = null; }
        setupMeta = localMeta({ code: 'settings_config_unavailable', message: 'Saved configuration is visible; the following file read could not be confirmed' });
      }
      needsSetup = currentConfig === defaultConfig;
    }

    const publicName = getPublicConfig().name;
    const detectedConfig = {
      dashboardName: typeof mcConfig.name === 'string' && mcConfig.name.trim() && typeof publicName === 'string' ? publicName : null,
      model: null,
      channels: null,
      agentName: null,
      workspacePath: null,
      gatewayTokenConfigured: null,
    };

    try {
      if (fs.existsSync(openclawConfigPath)) {
        const openclawConfig = JSON.parse(fs.readFileSync(openclawConfigPath, 'utf8'));
        detectedConfig.model = openclawConfig.agents?.defaults?.model?.primary || null;
        detectedConfig.workspacePath = homeRelative(openclawConfig.agents?.defaults?.workspace || null);
        detectedConfig.gatewayTokenConfigured = !!(openclawConfig.gateway?.auth?.token || openclawConfig.gateway?.http?.auth?.token);

        if (openclawConfig.channels) {
          detectedConfig.channels = Object.keys(openclawConfig.channels).filter((channel) => openclawConfig.channels[channel]?.enabled !== false);
        }

        const ws = openclawConfig.agents?.defaults?.workspace || null;
        try {
          const identity = fs.readFileSync(path.join(ws, 'IDENTITY.md'), 'utf8');
          const nameMatch = identity.match(/\*\*Name:\*\*\s*(.+)/);
          detectedConfig.agentName = nameMatch ? nameMatch[1].trim() : null;
        } catch {
          detectedConfig.agentName = null;
        }
      }
    } catch (error) {
      console.warn('OpenClaw setup configuration could not be read');
    }

    return {
      ...(setupMeta ? { meta: setupMeta } : {}),
      needsSetup,
      gatewayRunning,
      gatewayPort,
      configuredGatewayPort: configuredGatewayPort(),
      gatewayVersion,
      detectedConfig,
    };
  }

  // The OpenClaw gateway reading the scheduled reachability source holds:
  // true (up), false (down), null when it is not a current reading.
  function readGatewayRunning() {
    let snapshot = null;
    try {
      snapshot = typeof gatewayReachability === 'function' ? gatewayReachability() : null;
    } catch {
      snapshot = null;
    }
    if (!snapshot?.data || snapshot.meta?.stale !== false) return null;
    const state = snapshot.data.gateways?.openclaw?.state;
    return state === 'up' ? true : state === 'down' ? false : null;
  }

  // POST /api/setup accepts exactly what the Setup page sends. Blocks of
  // removed modules (scout, ...) and unknown module ids are refused; blocks an
  // existing config already holds are left untouched on write.
  function updateSetup(body = {}) {
    if (!isPlainObject(body)) throw httpError(400, 'invalid_setup', 'Setup body must be an object');
    for (const key of Object.keys(body)) {
      if (!SETUP_FIELDS.has(key)) {
        const label = /^[A-Za-z][A-Za-z0-9_]{0,40}$/.test(key) ? `"${key}"` : 'that field';
        throw httpError(400, 'unsupported_setup_field', `Setup does not accept ${label}`);
      }
    }
    const { dashboardName, gateway, modules } = body;
    if (dashboardName !== undefined && dashboardName !== null && dashboardName !== '' && typeof dashboardName !== 'string') {
      throw httpError(400, 'invalid_config', 'dashboardName must be a string');
    }
    if (gateway != null) {
      if (!isPlainObject(gateway) || Object.keys(gateway).some((key) => !['port', 'token'].includes(key))) {
        throw httpError(400, 'invalid_gateway', 'gateway accepts only port and token');
      }
      if (gateway.port !== undefined && !(Number.isInteger(gateway.port) && gateway.port > 0 && gateway.port < 65536)) {
        throw httpError(400, 'invalid_gateway', 'gateway.port must be a port number');
      }
      if (gateway.token !== undefined && (typeof gateway.token !== 'string' || gateway.token.length > 4096)) {
        throw httpError(400, 'invalid_gateway', 'gateway.token must be a string');
      }
    }
    if (modules != null) {
      if (!isPlainObject(modules)) throw httpError(400, 'invalid_module_flag', 'modules must be an object');
      for (const [id, flag] of Object.entries(modules)) {
        if (!PUBLIC_MODULE_IDS.includes(id)) throw httpError(400, 'unknown_module', 'Unknown module id');
        if (typeof flag !== 'boolean') throw httpError(400, 'invalid_module_flag', 'Module flags must be true or false');
      }
    }
    const next = readCurrentMcConfig();
    if (dashboardName) {
      next.name = dashboardName;
      next.subtitle = dashboardName;
    }
    if (gateway != null) next.gateway = { ...next.gateway, ...gateway };
    if (modules != null) next.modules = { ...next.modules, ...modules };
    persistMcConfig(next);
    return { success: true, config: getPublicConfig(), configuredGatewayPort: configuredGatewayPort() };
  }

  function getMissionControlConfigPath() {
    return missionControlConfigPath;
  }

  function importMissionControlConfig(filePath) {
    const configContent = fs.readFileSync(filePath, 'utf8');
    let imported;
    try { imported = JSON.parse(configContent); } catch { throw httpError(400, 'invalid_config', 'Invalid configuration JSON'); }
    validateSettingsDocument(imported);
    const current = readCurrentMcConfig();
    const resolved = restoreRedactedValues(imported, current, true);
    validateSettingsDocument(resolved);
    if (!configStore) throw httpError(503, 'config_store_unavailable', 'Configuration store is unavailable');
    configStore.importRaw(JSON.stringify(resolved, null, 2));
    replaceSharedConfig(resolved);
    // Upload cleanup cannot turn a committed config write into a failed save.
    try { fs.unlinkSync(filePath); } catch {}

    return {
      status: 'imported',
      message: 'Configuration imported successfully. Restart required for startup-only settings.',
      config: getPublicConfig(),
      configuredGatewayPort: configuredGatewayPort(),
      budget: { monthly: mcConfig.budget?.monthly ?? null },
      meta: localMeta(),
    };
  }

  return {
    getPublicConfig,
    getExportConfig,
    getSettingsPayload,
    getModelRouting,
    setModelRouting,
    getHeartbeatSettings,
    setHeartbeatInterval,
    updateBudget,
    getSetupStatus,
    updateSetup,
    getMissionControlConfigPath,
    importMissionControlConfig,
  };
}

module.exports = {
  createSettingsService,
  normalizeMonthlyBudget,
};
