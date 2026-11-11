const fs = require('fs');
const path = require('path');
const os = require('os');
const { redact, validateMcConfig } = require('../core/config');
const { httpError } = require('../core/http');

function normalizeMonthlyBudget(monthly) {
  const normalized = Number(monthly ?? 0);
  if (!Number.isFinite(normalized) || normalized < 0) {
    const error = new Error('monthly budget must be zero or positive');
    error.statusCode = 400;
    throw error;
  }
  return normalized;
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

  function persistMcConfig(next) {
    if (!configStore) throw httpError(503, 'config_store_unavailable', 'Configuration store is unavailable');
    configStore.persist(next);
    Object.assign(mcConfig, next);
  }

  function readOpenclawConfigSafe() {
    if (!fs.existsSync(openclawConfigPath)) return null;
    try {
      return JSON.parse(fs.readFileSync(openclawConfigPath, 'utf8'));
    } catch {
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

  async function setDefaultModel(model) {
    const normalized = typeof model === 'string' ? model.trim() : '';
    if (!normalized) {
      throw httpError(400, 'invalid_model', 'model required');
    }

    await openclawExec(['config', 'set', 'agents.defaults.model.primary', normalized], 15000);
    await openclawExec(['config', 'set', 'agents.defaults.model.default', normalized], 15000);
    await reloadGatewayConfig();
    return { ok: true, model: normalized, message: `Model switched to ${normalized}` };
  }

  function getModelRouting() {
    const cfg = readOpenclawConfigSafe();
    const main = cfg?.agents?.defaults?.model?.primary || null;
    const subagent = cfg?.agents?.defaults?.subagents?.model?.primary || null;
    const heartbeat = cfg?.agents?.defaults?.heartbeat?.model || null;
    return { main, subagent, heartbeat };
  }

  async function setModelRouting({ main, subagent, heartbeat }) {
    if ([main, subagent, heartbeat].some((value) => value != null && typeof value !== 'string')) {
      throw httpError(400, 'invalid_model', 'Model fields must be strings');
    }
    if (main) {
      await openclawExec(['config', 'set', 'agents.defaults.model.primary', String(main)], 15000);
    }
    if (subagent) {
      await openclawExec(['config', 'set', 'agents.defaults.subagents.model.primary', String(subagent)], 15000);
    }
    if (heartbeat) {
      await openclawExec(['config', 'set', 'agents.defaults.heartbeat.model', String(heartbeat)], 15000);
    } else {
      try {
        await openclawExec(['config', 'unset', 'agents.defaults.heartbeat.model'], 15000);
      } catch {}
    }

    await reloadGatewayConfig();
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
    await openclawExec(['config', 'set', 'agents.defaults.heartbeat.every', normalized], 15000);
    await reloadGatewayConfig();
    return { status: 'saved' };
  }

  function updateBudget(monthly) {
    const next = { ...mcConfig, budget: { monthly: normalizeMonthlyBudget(monthly) } };
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
    const next = JSON.parse(JSON.stringify(mcConfig));
    if (dashboardName) {
      if (typeof dashboardName !== 'string') throw httpError(400, 'invalid_config', 'dashboardName must be a string');
      next.name = dashboardName;
      next.subtitle = dashboardName;
    }
    if (gateway != null) next.gateway = { ...next.gateway, ...gateway };
    if (modules != null) next.modules = { ...next.modules, ...modules };
    if (scout != null) next.scout = { ...next.scout, ...scout };
    if (validateMcConfig(next).length) throw httpError(400, 'invalid_config', 'Invalid configuration');
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
    if (validateMcConfig(imported).length) throw httpError(400, 'invalid_config', 'Invalid configuration');
    if (!configStore) throw httpError(503, 'config_store_unavailable', 'Configuration store is unavailable');
    configStore.importRaw(configContent);
    fs.unlinkSync(filePath);

    return {
      status: 'imported',
      message: 'Configuration imported successfully. Restart required.',
    };
  }

  return {
    getPublicConfig,
    getSettingsPayload,
    setDefaultModel,
    getModelRouting,
    setModelRouting,
    getHeartbeatSettings,
    setHeartbeatInterval,
    updateBudget,
    getSetupStatus,
    updateSetup,
    getMissionControlConfigPath,
    importMissionControlConfig,
    readOpenclawConfigSafe,
    reloadGatewayConfig,
  };
}

module.exports = {
  createSettingsService,
  normalizeMonthlyBudget,
};
