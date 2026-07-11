'use strict';

const {
  REQUIRED_GBRAIN_TOOLS,
  GBRAIN_BASE_TOOL_IDS,
  GBRAIN_INTEGRATION_CONTRACT,
} = require('./constants');
const { liveHealthStatus, liveSourceStatus, isWarningSourceStatus } = require('./liveProbes');

function normalizeSourceKey(value) {
  return String(value || '').replace(/[^a-z0-9]/gi, '').toLowerCase();
}

function sourceById(liveSources, ids) {
  const wanted = new Set(ids.map((id) => normalizeSourceKey(id)));
  return (liveSources?.sources || []).find((source) => wanted.has(normalizeSourceKey(source.id))) || null;
}

function sourceStatusFor(source, sourcesUnavailable) {
  if (sourcesUnavailable) return 'warning';
  if (!source) return 'warning';
  if (source.freshness?.status === 'warning') return 'warning';
  return isWarningSourceStatus(source.status) ? 'warning' : 'healthy';
}

function buildGBrainIntegrationHealth(live = {}, runtime = {}) {
  const liveHealth = live.health?.ok ? live.health : null;
  const liveSources = live.sources?.ok ? live.sources : null;
  const liveTools = live.tools?.ok ? live.tools : null;
  const liveFeatures = live.features?.ok ? live.features : null;
  const liveProviders = live.providers?.ok ? live.providers : null;
  const liveHermesProxy = live.hermesProxy?.ok ? live.hermesProxy : null;
  const toolsUnavailable = Boolean(live.tools && !live.tools.ok);
  const sourcesUnavailable = Boolean(live.sources && !live.sources.ok);
  const requiredTools = liveTools?.requiredTools || REQUIRED_GBRAIN_TOOLS.map((tool) => ({ ...tool, present: false }));
  const presentTools = requiredTools.filter((tool) => tool.present);
  const missingTools = requiredTools.filter((tool) => !tool.present);
  const hermesSource = sourceById(liveSources, ['hermes-agent', 'hermes']);
  const openclawSource = sourceById(liveSources, ['clawd', 'openclaw']);
  const runtimeSystems = runtime?.systems || {};
  const featureGaps = liveFeatures?.recommendations || [];
  const blockingFeatureGaps = featureGaps.filter((item) => item.severity !== 'optional');
  const optionalFeatureGaps = featureGaps.filter((item) => item.severity === 'optional');
  const baseTools = requiredTools.filter((tool) => GBRAIN_BASE_TOOL_IDS.has(tool.id));
  const presentBaseTools = baseTools.filter((tool) => tool.present);
  const missingBaseTools = baseTools.filter((tool) => !tool.present);
  const readSmokeStatus = liveHealth && missingBaseTools.length === 0 ? 'healthy' : 'warning';
  const thinkTool = requiredTools.find((tool) => tool.id === 'think');
  const thinkConfig = runtime?.think || {};
  const thinkProbeAttempted = Boolean(live.tools || live.providers);
  const hasHermesProxyThinkPath = Boolean(liveHermesProxy);
  const thinkRuntimeStatus = !thinkProbeAttempted
    ? 'inactive'
    : !thinkTool?.present
    ? 'critical'
    : (!thinkConfig.configured && !hasHermesProxyThinkPath) || !liveHealth
    ? 'warning'
    : 'healthy';
  const thinkRuntime = {
    status: thinkRuntimeStatus,
    label: thinkRuntimeStatus === 'healthy'
      ? 'think runtime configured'
      : thinkRuntimeStatus === 'critical'
      ? 'think tool missing'
      : thinkRuntimeStatus === 'warning'
      ? 'think exposed but not runtime-ready'
      : 'think runtime not probed',
    detail: !thinkProbeAttempted
      ? 'Live tool/provider probes have not run yet.'
      : !thinkTool?.present
      ? 'GBrain tool discovery did not advertise think.'
      : !thinkConfig.configured && !hasHermesProxyThinkPath
      ? 'Tool discovery advertises think, but no active chat model, provider proxy, or healthy Hermes proxy path is configured for the brain.'
      : !liveHealth
      ? 'A provider path is configured, but live GBrain health proof is unavailable; do not rely on think synthesis yet.'
      : hasHermesProxyThinkPath && !thinkConfig.configured
      ? liveHermesProxy.detail
      : 'Tool discovery, provider configuration, and live health proof are present.',
    proof: [
      'gbrain --tools-json',
      live.providers ? 'gbrain providers explain --json' : '',
      liveHermesProxy ? 'Hermes proxy /health' : '',
      thinkConfig.proof || 'think runtime config not checked',
    ].filter(Boolean).join(' + '),
    checkedAt: liveProviders?.checkedAt || live.providers?.checkedAt || liveTools?.checkedAt || runtime?.checkedAt || null,
    toolPresent: Boolean(thinkTool?.present),
    activeModelConfigured: thinkConfig.modelConfigured === true,
    proxyConfigured: thinkConfig.proxyConfigured === true || hasHermesProxyThinkPath,
    readyChatProviderCount: liveProviders?.readyChatCount ?? 0,
    readyChatProviders: liveProviders?.readyChatProviders || [],
  };

  const systems = GBRAIN_INTEGRATION_CONTRACT.systems.map((system) => {
    const source = system.id === 'hermes' ? hermesSource : openclawSource;
    const runtimeSystem = runtimeSystems[system.id] || {};
    const mcpStatus = runtimeSystem.mcpConfigured === true ? 'healthy' : runtimeSystem.mcpConfigured === false ? 'warning' : 'inactive';
    const contractStatus = runtimeSystem.runtimeContract?.status || 'warning';
    const durableStatus = runtimeSystem.durablePipeline?.status || (system.id === 'hermes' ? 'warning' : 'warning');
    const sourceStatus = sourceStatusFor(source, sourcesUnavailable);
    // Runtime readiness is about the live read/runtime path: MCP config,
    // shared-brain contract, source visibility, read smoke, and think readiness.
    // The curated write/export pipeline is deliberately surfaced as writeSmoke,
    // but an incomplete optional exporter must not keep the whole dashboard in
    // "Live with caveats" when the runtime path is otherwise healthy.
    const statusInputs = [mcpStatus, contractStatus, sourceStatus, readSmokeStatus, thinkRuntime.status].filter((item) => item !== 'inactive');
    const status = statusInputs.includes('critical')
      ? 'critical'
      : statusInputs.includes('warning')
      ? 'warning'
      : 'healthy';

    return {
      id: system.id,
      label: system.label,
      status,
      mcp: {
        configured: runtimeSystem.mcpConfigured === true,
        status: mcpStatus,
        proof: runtimeSystem.mcpProof || system.proof,
      },
      runtimeContract: {
        status: contractStatus,
        proof: runtimeSystem.runtimeContract?.proof || 'runtime contract not verified',
        label: runtimeSystem.runtimeContract?.label || 'GBrain shared-brain contract not verified',
      },
      source: {
        id: source?.id || (system.id === 'hermes' ? 'hermes-agent' : 'clawd'),
        status: sourceStatus,
        lastSyncAt: source?.lastSyncAt || null,
        pages: source?.pages ?? null,
        proof: source ? 'gbrain sources list' : 'source not found in live GBrain list',
      },
      tools: requiredTools.map((tool) => ({ id: tool.id, label: tool.label, present: tool.present, mode: tool.mode })),
      thinkRuntime,
      readSmoke: {
        status: readSmokeStatus,
        proof: liveHealth ? 'gbrain call get_health + gbrain --tools-json' : 'health/tool discovery unavailable',
        checkedAt: liveHealth?.checkedAt || live.tools?.checkedAt || null,
      },
      writeSmoke: {
        status: durableStatus,
        proof: runtimeSystem.durablePipeline?.proof || system.proof,
        label: runtimeSystem.durablePipeline?.label || 'Curated write path not verified',
      },
    };
  });

  const connectedCount = systems.filter((system) => system.mcp.configured).length;
  const healthyCount = systems.filter((system) => system.status === 'healthy').length;
  const status = toolsUnavailable
    ? 'warning'
    : missingTools.length > 0 || thinkRuntime.status === 'critical' || thinkRuntime.status === 'warning' || healthyCount < systems.length
    ? 'warning'
    : 'healthy';

  return {
    ok: true,
    status,
    checkedAt: liveHealth?.checkedAt || liveTools?.checkedAt || runtime?.checkedAt || new Date().toISOString(),
    systems,
    connectedCount,
    systemCount: systems.length,
    healthyCount,
    toolContract: {
      status: toolsUnavailable ? 'warning' : missingTools.length > 0 || thinkRuntime.status === 'warning' || thinkRuntime.status === 'critical' ? 'warning' : 'healthy',
      checkedAt: liveTools?.checkedAt || null,
      requiredCount: requiredTools.length,
      presentCount: presentTools.length,
      missingCount: missingTools.length,
      tools: requiredTools,
      baseRequiredCount: baseTools.length,
      basePresentCount: presentBaseTools.length,
      baseMissingCount: missingBaseTools.length,
    },
    thinkRuntime,
    featureGaps: {
      status: blockingFeatureGaps.length > 0 ? 'warning' : live.features && !liveFeatures ? 'warning' : 'healthy',
      checkedAt: liveFeatures?.checkedAt || live.features?.checkedAt || null,
      count: featureGaps.length,
      blockingCount: blockingFeatureGaps.length,
      optionalCount: optionalFeatureGaps.length,
      recommendations: featureGaps,
    },
  };
}

module.exports = { sourceById, sourceStatusFor, buildGBrainIntegrationHealth };
