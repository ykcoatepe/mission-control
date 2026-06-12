'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

function resolveEnvPlaceholders(value) {
  if (typeof value !== 'string') return value;
  return value.replace(/\$\{([A-Z0-9_]+)\}/gi, (_, name) => process.env[name] || '');
}

function loadBootstrap({ rootDir }) {
  const MC_CONFIG_PATH = path.join(rootDir, 'mc-config.json');
  const MC_DEFAULT_CONFIG_PATH = path.join(rootDir, 'mc-config.default.json');

  let mcConfig;
  try {
    mcConfig = JSON.parse(fs.readFileSync(MC_CONFIG_PATH, 'utf8'));
  } catch {
    if (fs.existsSync(MC_DEFAULT_CONFIG_PATH)) {
      fs.copyFileSync(MC_DEFAULT_CONFIG_PATH, MC_CONFIG_PATH);
      mcConfig = JSON.parse(fs.readFileSync(MC_CONFIG_PATH, 'utf8'));
    } else {
      mcConfig = {
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
      };
    }
  }

  const OPENCLAW_CONFIG_PATH = path.join(os.homedir(), '.openclaw/openclaw.json');
  const GATEWAY_PORT = mcConfig.gateway?.port || 18789;

  let detectedGatewayToken = '';
  try {
    const ocConfig = JSON.parse(fs.readFileSync(OPENCLAW_CONFIG_PATH, 'utf8'));
    detectedGatewayToken = ocConfig.gateway?.auth?.token || ocConfig.gateway?.http?.auth?.token || '';
  } catch {}
  if (!detectedGatewayToken) {
    detectedGatewayToken = resolveEnvPlaceholders(mcConfig.gateway?.token || '');
  }
  const GATEWAY_TOKEN = detectedGatewayToken;
  const NOTION_DB_ID = mcConfig.notion?.dbId || '';
  const NOTION_TOKEN = resolveEnvPlaceholders(mcConfig.notion?.token || '');
  let detectedWorkspace = mcConfig.workspace || '';
  if (!detectedWorkspace) {
    try {
      const ocConfig = JSON.parse(fs.readFileSync(OPENCLAW_CONFIG_PATH, 'utf8'));
      detectedWorkspace = ocConfig.agents?.defaults?.workspace || '';
    } catch {}
  }
  const WORKSPACE_PATH = detectedWorkspace || path.join(os.homedir(), 'clawd');
  const SKILLS_PATH = mcConfig.skillsPath || path.join(WORKSPACE_PATH, 'skills');
  const MEMORY_PATH = mcConfig.memoryPath || path.join(WORKSPACE_PATH, 'memory');
  const S3_BUCKET = mcConfig.aws?.bucket || '';
  const S3_REGION = resolveEnvPlaceholders(mcConfig.aws?.region || process.env.AWS_REGION || 'us-east-1');
  const AWS_ACCESS_KEY_ID = resolveEnvPlaceholders(mcConfig.aws?.accessKeyId || process.env.AWS_ACCESS_KEY_ID || '');
  const AWS_SECRET_ACCESS_KEY = resolveEnvPlaceholders(mcConfig.aws?.secretAccessKey || process.env.AWS_SECRET_ACCESS_KEY || '');
  const OPENCLAW_BIN = ['/opt/homebrew/bin/openclaw', '/usr/local/bin/openclaw', 'openclaw'].find((candidate) => {
    try {
      return candidate === 'openclaw' || fs.existsSync(candidate);
    } catch {
      return candidate === 'openclaw';
    }
  });

  function validateGatewayTokenConfig() {
    try {
      const ocConfig = JSON.parse(fs.readFileSync(OPENCLAW_CONFIG_PATH, 'utf8'));
      const authMode = ocConfig?.gateway?.auth?.mode || ocConfig?.gateway?.http?.auth?.mode || '';
      const authToken = ocConfig?.gateway?.auth?.token || ocConfig?.gateway?.http?.auth?.token || '';
      const remoteToken = ocConfig?.gateway?.remote?.token || '';
      const mcToken = mcConfig?.gateway?.token || '';

      if (authMode === 'none') return;
      if (authToken && remoteToken && authToken !== remoteToken) {
        throw new Error('Gateway token mismatch: openclaw gateway.auth.token != gateway.remote.token');
      }
      if (authToken && mcToken && authToken !== mcToken) {
        throw new Error('Mission Control token drift: mc-config gateway.token does not match openclaw gateway auth token');
      }
    } catch (error) {
      if (error?.code === 'ENOENT') {
        console.warn('[startup] OpenClaw config not found; skipping gateway token validation until setup completes');
        return;
      }
      console.error('[startup] gateway token validation failed:', error.message);
      throw error;
    }
  }

  validateGatewayTokenConfig();

  return {
    mcConfig,
    MC_CONFIG_PATH,
    MC_DEFAULT_CONFIG_PATH,
    OPENCLAW_CONFIG_PATH,
    GATEWAY_PORT,
    GATEWAY_TOKEN,
    NOTION_DB_ID,
    NOTION_TOKEN,
    WORKSPACE_PATH,
    SKILLS_PATH,
    MEMORY_PATH,
    S3_BUCKET,
    S3_REGION,
    AWS_ACCESS_KEY_ID,
    AWS_SECRET_ACCESS_KEY,
    OPENCLAW_BIN,
  };
}

module.exports = { loadBootstrap, resolveEnvPlaceholders };
