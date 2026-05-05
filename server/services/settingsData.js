const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');

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
}) {
  const openclawConfigPath = path.join(os.homedir(), '.openclaw/openclaw.json');

  function readOpenclawConfigSafe() {
    if (!fs.existsSync(openclawConfigPath)) return {};
    return JSON.parse(fs.readFileSync(openclawConfigPath, 'utf8'));
  }

  async function reloadGatewayConfig() {
    try {
      await fetch(`http://127.0.0.1:${gatewayPort}/config/reload`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${gatewayToken}` },
      });
    } catch {}
  }

  function readMissionControlVersion() {
    try {
      const pkg = JSON.parse(fs.readFileSync(missionControlPackagePath, 'utf8'));
      return pkg.version || 'unknown';
    } catch {
      return 'unknown';
    }
  }

  function getPublicConfig() {
    const safe = JSON.parse(JSON.stringify(mcConfig));
    if (safe.gateway) safe.gateway = { port: safe.gateway.port };
    if (safe.notion) delete safe.notion.token;
    if (safe.scout) delete safe.scout.braveApiKey;
    return safe;
  }

  function getSettingsPayload() {
    const configData = readOpenclawConfigSafe();
    const defaultModel = configData?.agents?.defaults?.model?.primary
      || configData?.agents?.defaults?.model?.default
      || configData?.model?.default
      || configData?.model
      || 'openai-codex/gpt-5.3-codex';

    return {
      model: defaultModel,
      gateway_port: gatewayPort,
      memory_path: memoryPath,
      skills_path: skillsPath,
      bedrock_region: bedrockRegion,
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
    const normalized = String(model || '').trim();
    if (!normalized) {
      throw new Error('model required');
    }

    const config = readOpenclawConfigSafe();
    if (!config.agents) config.agents = {};
    if (!config.agents.defaults) config.agents.defaults = {};
    if (!config.agents.defaults.model) config.agents.defaults.model = {};

    config.agents.defaults.model.primary = normalized;
    config.agents.defaults.model.default = normalized;

    fs.writeFileSync(openclawConfigPath, JSON.stringify(config, null, 2));
    await reloadGatewayConfig();
    return { ok: true, model: normalized, message: `Model switched to ${normalized}` };
  }

  function getModelRouting() {
    const cfg = readOpenclawConfigSafe();
    const main = cfg?.agents?.defaults?.model?.primary || '';
    const subagent = cfg?.agents?.defaults?.subagents?.model?.primary || main || '';
    const heartbeat = cfg?.agents?.defaults?.heartbeat?.model || '';
    return { main, subagent, heartbeat };
  }

  async function setModelRouting({ main, subagent, heartbeat }) {
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
    return { interval: cfg?.agents?.defaults?.heartbeat?.every || '1h' };
  }

  async function setHeartbeatInterval(interval) {
    const normalized = String(interval || '').trim();
    if (!normalized) {
      throw new Error('interval required');
    }
    await openclawExec(['config', 'set', 'agents.defaults.heartbeat.every', normalized], 15000);
    await reloadGatewayConfig();
    return { status: 'saved' };
  }

  function updateBudget(monthly) {
    mcConfig.budget = { monthly: monthly || 0 };
    fs.writeFileSync(missionControlConfigPath, JSON.stringify(mcConfig, null, 2));
    return { status: 'saved', budget: mcConfig.budget };
  }

  async function getSetupStatus() {
    let gatewayRunning = false;
    let gatewayVersion = '';
    try {
      const response = await fetch(`http://127.0.0.1:${gatewayPort}/status`, {
        method: 'GET',
        timeout: 3000,
      });
      if (response.ok) {
        gatewayRunning = true;
        const status = await response.json();
        gatewayVersion = status.version || '';
      }
    } catch {
      gatewayRunning = false;
    }

    let needsSetup = !fs.existsSync(missionControlConfigPath);
    if (!needsSetup && fs.existsSync(missionControlDefaultConfigPath)) {
      const currentConfig = fs.readFileSync(missionControlConfigPath, 'utf8');
      const defaultConfig = fs.readFileSync(missionControlDefaultConfigPath, 'utf8');
      needsSetup = currentConfig === defaultConfig;
    }

    const detectedConfig = {
      model: '',
      channels: [],
      agentName: '',
      workspacePath: '',
      gatewayTokenConfigured: false,
    };

    try {
      if (fs.existsSync(openclawConfigPath)) {
        const openclawConfig = JSON.parse(fs.readFileSync(openclawConfigPath, 'utf8'));
        detectedConfig.model = openclawConfig.agents?.defaults?.model?.primary || '';
        detectedConfig.workspacePath = openclawConfig.agents?.defaults?.workspace || '';
        detectedConfig.gatewayTokenConfigured = !!(openclawConfig.gateway?.auth?.token || openclawConfig.gateway?.http?.auth?.token);

        if (openclawConfig.channels) {
          detectedConfig.channels = Object.keys(openclawConfig.channels).filter((channel) => openclawConfig.channels[channel]?.enabled !== false);
        }

        const ws = detectedConfig.workspacePath || process.env.HOME;
        try {
          const identity = fs.readFileSync(path.join(ws, 'IDENTITY.md'), 'utf8');
          const nameMatch = identity.match(/\*\*Name:\*\*\s*(.+)/);
          detectedConfig.agentName = nameMatch ? nameMatch[1].trim() : 'OpenClaw Agent';
        } catch {
          detectedConfig.agentName = 'OpenClaw Agent';
        }
      }
    } catch (error) {
      console.warn('Could not read OpenClaw config:', error.message);
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
    if (dashboardName) {
      mcConfig.name = dashboardName;
      mcConfig.subtitle = dashboardName;
    }

    if (gateway && typeof gateway === 'object') {
      if (gateway.port) mcConfig.gateway.port = gateway.port;
      if (gateway.token) mcConfig.gateway.token = gateway.token;
    }

    if (modules && typeof modules === 'object') {
      mcConfig.modules = { ...mcConfig.modules, ...modules };
    }

    if (scout && typeof scout === 'object') {
      mcConfig.scout = { ...mcConfig.scout, ...scout };
    }

    fs.writeFileSync(missionControlConfigPath, JSON.stringify(mcConfig, null, 2));

    const scoutResultsPath = path.join(missionControlRoot, 'scout-results.json');
    if (fs.existsSync(scoutResultsPath)) {
      fs.writeFileSync(scoutResultsPath, JSON.stringify({ results: [], lastScan: null, queries: scout?.queries?.length || 0 }, null, 2));
      console.log('[Setup] Cleared scout results for fresh scan');
    }

    if (scout?.enabled && scout?.queries?.length) {
      setTimeout(() => {
        execFile('node', [path.join(missionControlRoot, 'scout-engine.js')], { timeout: 60000 }, (error) => {
          if (error) console.error('[Setup] Scout scan failed:', error.message);
          else console.log('[Setup] First scout scan completed');
        });
      }, 1000);
    }

    return { success: true, config: getPublicConfig() };
  }

  function getMissionControlConfigPath() {
    return missionControlConfigPath;
  }

  function importMissionControlConfig(filePath) {
    const configContent = fs.readFileSync(filePath, 'utf8');
    JSON.parse(configContent);

    fs.copyFileSync(missionControlConfigPath, `${missionControlConfigPath}.backup.${Date.now()}`);
    fs.writeFileSync(missionControlConfigPath, configContent);
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
};
