'use strict';

const os = require('os');
const fs = require('fs');
const path = require('path');
const { GBRAIN_RUNTIME_CONTRACT_MARKER } = require('./constants');

function resolveHomePath(homeDir, suffix) {
  return path.join(homeDir || os.homedir(), suffix);
}

function fileExists(filePath) {
  try {
    return fs.existsSync(filePath);
  } catch {
    return false;
  }
}

function readTextFile(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

function parseJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function resolveClawdRoot(options = {}, homeDir = os.homedir()) {
  if (options.clawdRoot) return options.clawdRoot;
  if (options.workspaceRoot) return options.workspaceRoot;
  const configuredWorkspace = options.mcConfig?.workspace || options.workspacePath;
  if (configuredWorkspace) return configuredWorkspace;
  const openclawConfig = parseJsonFile(resolveHomePath(homeDir, '.openclaw/openclaw.json'));
  const openclawWorkspace = openclawConfig?.agents?.defaults?.workspace;
  if (openclawWorkspace) return openclawWorkspace;
  if (options.projectRoot) return path.resolve(options.projectRoot, '..');
  return resolveHomePath(homeDir, 'clawd');
}

function detectHermesGBrainConfig(homeDir = os.homedir()) {
  const configPath = resolveHomePath(homeDir, '.hermes/profiles/hmudur/config.yaml');
  const text = readTextFile(configPath);
  const configured = Boolean(text && /mcp_servers:\s*[\s\S]*?\bgbrain:\s*[\s\S]*?\bserve\b/i.test(text));
  return {
    configured,
    source: configured ? 'Hermes profile mcp_servers.gbrain' : 'Hermes profile mcp_servers.gbrain missing',
  };
}

function detectOpenClawGBrainConfig(homeDir = os.homedir()) {
  const configPath = resolveHomePath(homeDir, '.openclaw/openclaw.json');
  const config = parseJsonFile(configPath);
  const server = config?.mcp?.servers?.gbrain || null;
  const command = String(server?.command || '');
  const args = Array.isArray(server?.args) ? server.args.map(String) : [];
  const configured = Boolean(server && /gbrain(?:$|[\\/])?/i.test(command) && args.includes('serve'));
  return {
    configured,
    source: configured ? 'OpenClaw mcp.servers.gbrain' : 'OpenClaw mcp.servers.gbrain missing',
  };
}

function detectGBrainThinkConfig(homeDir = os.homedir(), processEnv = process.env) {
  const configPath = resolveHomePath(homeDir, '.gbrain/config.json');
  const config = parseJsonFile(configPath) || {};
  const activeModel = config?.chat_model || config?.models?.think || config?.models?.default || processEnv.GBRAIN_MODEL || null;
  const proxyBaseUrl = config?.provider_base_urls?.litellm || config?.provider_base_urls?.openrouter || processEnv.LITELLM_BASE_URL || processEnv.OPENROUTER_BASE_URL || null;
  const configured = Boolean(activeModel || proxyBaseUrl);
  return {
    configured,
    modelConfigured: Boolean(activeModel),
    proxyConfigured: Boolean(proxyBaseUrl),
    proof: configured
      ? [
          activeModel ? 'GBrain chat model configured' : '',
          proxyBaseUrl ? 'provider proxy base URL configured' : '',
        ].filter(Boolean).join(' + ')
      : 'No GBrain chat_model, models.think, GBRAIN_MODEL, or provider proxy base URL configured',
  };
}

function hasManagedGBrainContract(text) {
  return String(text || '').includes(`${GBRAIN_RUNTIME_CONTRACT_MARKER}:start`);
}

function hasHermesSemanticGBrainContract(text) {
  const normalized = String(text || '').replace(/\s+/g, ' ');
  return /GBrain shared-brain(?: tool)? contract/i.test(normalized)
    && /keep (private|local) memory local/i.test(normalized)
    && /curated/i.test(normalized)
    && /(cross-agent|handoffs?|playbooks?|verified outcomes?)/i.test(normalized)
    && /never (store|put)[^.]*raw transcripts/i.test(normalized)
    && /secrets/i.test(normalized)
    && /(bridge scripts|hermes_hmudur_memory_bridge\.py)/i.test(normalized);
}

function detectHermesRuntimeContract(text) {
  if (hasManagedGBrainContract(text)) {
    return {
      installed: true,
      proof: 'Hermes hmudur MEMORY.md managed block',
    };
  }
  if (hasHermesSemanticGBrainContract(text)) {
    return {
      installed: true,
      proof: 'Hermes hmudur MEMORY.md semantic contract',
    };
  }
  return {
    installed: false,
    proof: 'Hermes hmudur MEMORY.md has no managed or semantic GBrain contract block',
  };
}

function buildLocalGBrainIntegrationRuntime(options = {}) {
  const homeDir = options.homeDir || os.homedir();
  const clawdRoot = resolveClawdRoot(options, homeDir);
  const hermesConfig = detectHermesGBrainConfig(homeDir);
  const openclawConfig = detectOpenClawGBrainConfig(homeDir);
  const thinkConfig = detectGBrainThinkConfig(homeDir, options.processEnv || process.env);
  const hermesBridgeScript = resolveHomePath(homeDir, '.hermes/profiles/hmudur/scripts/hermes_hmudur_memory_bridge.py');
  const hermesBridgeState = path.join(clawdRoot, 'shared-memory/state/hermes-hmudur-memory-bridge.json');
  const sharedMemorySyncScript = path.join(clawdRoot, 'scripts/gbrain_sync_and_embed.sh');
  const openclawBridgeScript = path.join(clawdRoot, 'scripts/main_memory_to_gbrain_bridge.py');
  const sharedMemoryHandoffs = path.join(clawdRoot, 'shared-memory/handoffs.md');
  const clawdSharedMemory = path.join(clawdRoot, 'shared-memory');
  const openclawAgents = path.join(clawdRoot, 'AGENTS.md');
  const hermesMemory = resolveHomePath(homeDir, '.hermes/profiles/hmudur/memories/MEMORY.md');
  const syncWrapper = readTextFile(sharedMemorySyncScript);
  const handoffsText = readTextFile(sharedMemoryHandoffs);
  const openclawAgentsText = readTextFile(openclawAgents);
  const hermesMemoryText = readTextFile(hermesMemory);
  const openclawBridgeLinked = syncWrapper.includes('main_memory_to_gbrain_bridge.py');
  const openclawBridgeBlockPresent = handoffsText.includes('main-memory-gbrain-bridge:start');
  const openclawContractInstalled = hasManagedGBrainContract(openclawAgentsText);
  const hermesContract = detectHermesRuntimeContract(hermesMemoryText);
  const openclawBridgeReady = fileExists(openclawBridgeScript) && openclawBridgeLinked && openclawBridgeBlockPresent;

  return {
    checkedAt: new Date().toISOString(),
    think: thinkConfig,
    systems: {
      hermes: {
        mcpConfigured: hermesConfig.configured,
        mcpProof: hermesConfig.source,
        runtimeContract: {
          status: hermesContract.installed ? 'healthy' : 'warning',
          label: hermesContract.installed ? 'GBrain shared-brain contract installed' : 'GBrain shared-brain contract missing',
          proof: hermesContract.proof,
        },
        durablePipeline: {
          status: fileExists(hermesBridgeScript) && fileExists(sharedMemorySyncScript) ? 'healthy' : 'warning',
          label: fileExists(hermesBridgeScript) ? 'Curated bridge script present' : 'Curated bridge script missing',
          proof: fileExists(hermesBridgeState) ? 'Hermes bridge state file present' : hermesConfig.source,
        },
      },
      openclaw: {
        mcpConfigured: openclawConfig.configured,
        mcpProof: openclawConfig.source,
        runtimeContract: {
          status: openclawContractInstalled ? 'healthy' : 'warning',
          label: openclawContractInstalled ? 'GBrain shared-brain contract installed' : 'GBrain shared-brain contract missing',
          proof: openclawContractInstalled ? 'OpenClaw AGENTS.md managed block' : 'OpenClaw AGENTS.md has no managed GBrain contract block',
        },
        durablePipeline: {
          status: openclawBridgeReady ? 'healthy' : fileExists(clawdSharedMemory) ? 'warning' : 'critical',
          label: openclawBridgeReady
            ? 'Tagged OpenClaw main-memory bridge linked into GBrain sync'
            : fileExists(openclawBridgeScript)
            ? 'OpenClaw bridge script present; latest managed block or sync linkage not verified'
            : 'Tagged OpenClaw bridge script missing',
          proof: openclawBridgeReady
            ? 'main_memory_to_gbrain_bridge.py + gbrain_sync_and_embed.sh + shared-memory/handoffs.md managed block'
            : 'OpenClaw uses GBrain through MCP; curated exporter proof is incomplete',
        },
      },
    },
  };
}

module.exports = {
  resolveHomePath,
  fileExists,
  readTextFile,
  parseJsonFile,
  resolveClawdRoot,
  detectHermesGBrainConfig,
  detectOpenClawGBrainConfig,
  detectGBrainThinkConfig,
  hasHermesSemanticGBrainContract,
  buildLocalGBrainIntegrationRuntime,
};
