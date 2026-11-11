const fs = require('fs');
const path = require('path');
const os = require('os');
const { redact, validateMcConfig } = require('../core/config');
const { httpError } = require('../core/http');

function normalizeMonthlyBudget(monthly) {
  if (monthly === null) return null;
  if (typeof monthly !== 'number' || !Number.isFinite(monthly) || monthly < 0) {
    const error = httpError(400, 'invalid_budget', 'monthly budget must be a finite number, zero or positive, or null');
    error.statusCode = 400;
    throw error;
  }
  return monthly;
}

function validateSettingsDocument(document) {
  if (validateMcConfig(document).length) throw httpError(400, 'invalid_config', 'Invalid configuration');
  if (Object.hasOwn(document.budget || {}, 'monthly')) normalizeMonthlyBudget(document.budget.monthly);
}

// The exporter may replace a whole credential container or a substring of an
// ordinary string. Importing either form keeps the current value as a whole;
// never combine a redacted prefix/suffix with a secret from another document.
const OMIT_REDACTED = Symbol('omit-redacted');
function restoreRedactedValues(imported, current, hasCurrent = false) {
  if (typeof imported === 'string' && /\[redacted\]/i.test(imported)) {
    return hasCurrent ? structuredClone(current) : OMIT_REDACTED;
  }
  if (Array.isArray(imported)) {
    return imported.map((value, index) => restoreRedactedValues(value, current?.[index], Array.isArray(current) && Object.hasOwn(current, index)))
      .filter((value) => value !== OMIT_REDACTED);
  }
  if (imported && typeof imported === 'object') {
    return Object.fromEntries(Object.entries(imported).map(([key, value]) => [key,
      restoreRedactedValues(value, current?.[key], current != null && typeof current === 'object' && Object.hasOwn(current, key)),
    ]).filter(([, value]) => value !== OMIT_REDACTED));
  }
  return imported;
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
}) {
  const fs = fsImpl;
  const openclawConfigPath = path.join(homeDir, '.openclaw/openclaw.json');

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
    for (const key of Object.keys(mcConfig)) if (!Object.hasOwn(next, key)) delete mcConfig[key];
    Object.assign(mcConfig, next);
  }

  function readOpenclawConfigSafe() {
    try {
      const parsed = JSON.parse(fs.readFileSync(openclawConfigPath, 'utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid config document');
      return parsed;
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw httpError(503, 'settings_config_unavailable', 'OpenClaw configuration could not be read');
    }
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

  function getPublicConfig() {
    // Check names before recursing: secrets may be arrays or objects, and
    // ConfigStore's scalar redactor cannot preserve that parent-key context.
    function stripCredentials(value, key = '') {
      if (/(token|secret|password|api[_-]?key|access[_-]?key|credential|authorization|private[_-]?key|connection[_-]?string|(?:database|db)[_-]?url|dsn)/i.test(key)) return value == null ? null : '[redacted]';
      if (Array.isArray(value)) return value.map((item) => stripCredentials(item));
      if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, stripCredentials(item, name)]));
      if (typeof value === 'string' && /[a-z][a-z0-9+.-]*:\/\/[^/\s]*:[^/\s]*@/i.test(value)) return '[redacted]';
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
      gateway_port: gatewayPort ?? null,
      memory_path: memoryPath || null,
      skills_path: skillsPath || null,
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
    const cfg = readOpenclawConfigSafe();
    const main = cfg?.agents?.defaults?.model?.primary || null;
    const subagent = cfg?.agents?.defaults?.subagents?.model?.primary || null;
    const heartbeat = cfg?.agents?.defaults?.heartbeat?.model || null;
    return { main, subagent, heartbeat };
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
    if (provided.length) readOpenclawConfigSafe();
    for (const field of provided) {
      const value = body[field];
      await openclawExec(value === ''
        ? ['config', 'unset', paths[field]]
        : ['config', 'set', paths[field], value], 15000);
    }
    if (provided.length) await reloadGatewayConfig();
    return { status: 'saved' };
  }

  function getHeartbeatSettings() {
    const cfg = readOpenclawConfigSafe();
    return { interval: cfg?.agents?.defaults?.heartbeat?.every || null };
  }

  async function setHeartbeatInterval(interval) {
    const normalized = typeof interval === 'string' ? interval.trim() : '';
    if (!/^\d+(?:ms|s|m|h|d)$/.test(normalized)) {
      throw httpError(400, 'invalid_interval', 'interval must be a duration such as 30m');
    }
    readOpenclawConfigSafe();
    await openclawExec(['config', 'set', 'agents.defaults.heartbeat.every', normalized], 15000);
    await reloadGatewayConfig();
    return { status: 'saved' };
  }

  function updateBudget(monthly) {
    const normalized = normalizeMonthlyBudget(monthly);
    const current = readCurrentMcConfig();
    const next = { ...current, budget: { ...current.budget, monthly: normalized } };
    persistMcConfig(next);
    return { status: 'saved', budget: mcConfig.budget };
  }

  async function getSetupStatus() {
    // Gateway reachability has not been measured by this local config reader.
    const gatewayRunning = null;
    const gatewayVersion = null;

    let needsSetup = !fs.existsSync(missionControlConfigPath);
    if (!needsSetup && fs.existsSync(missionControlDefaultConfigPath)) {
      const currentConfig = fs.readFileSync(missionControlConfigPath, 'utf8');
      const defaultConfig = fs.readFileSync(missionControlDefaultConfigPath, 'utf8');
      needsSetup = currentConfig === defaultConfig;
    }

    const detectedConfig = {
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
        detectedConfig.workspacePath = openclawConfig.agents?.defaults?.workspace || null;
        detectedConfig.gatewayTokenConfigured = !!(openclawConfig.gateway?.auth?.token || openclawConfig.gateway?.http?.auth?.token);

        if (openclawConfig.channels) {
          detectedConfig.channels = Object.keys(openclawConfig.channels).filter((channel) => openclawConfig.channels[channel]?.enabled !== false);
        }

        const ws = detectedConfig.workspacePath;
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
      needsSetup,
      gatewayRunning,
      gatewayPort,
      gatewayVersion,
      detectedConfig,
    };
  }

  function updateSetup({ dashboardName, gateway, modules, scout }) {
    const next = readCurrentMcConfig();
    if (dashboardName) {
      if (typeof dashboardName !== 'string') throw httpError(400, 'invalid_config', 'dashboardName must be a string');
      next.name = dashboardName;
      next.subtitle = dashboardName;
    }
    if (gateway != null) next.gateway = { ...next.gateway, ...gateway };
    if (modules != null) next.modules = { ...next.modules, ...modules };
    if (scout != null) next.scout = { ...next.scout, ...scout };
    persistMcConfig(next);
    return { success: true, config: getPublicConfig() };
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
    fs.unlinkSync(filePath);

    return {
      status: 'imported',
      message: 'Configuration imported successfully. Restart required.',
    };
  }

  return {
    getPublicConfig,
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
