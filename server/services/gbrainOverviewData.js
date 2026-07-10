'use strict';

const { createGBrainTimelineService } = require('./gbrainTimeline');
const {
  buildLiveGBrainHealth,
  buildLiveGBrainSources,
  buildLiveGBrainVersion,
  buildLiveGBrainTools,
  buildLiveGBrainFeatures,
  buildLiveGBrainProviders,
  buildLiveHermesProxyStatus,
} = require('../routes/gbrain/liveProbes');
const { buildLocalGBrainIntegrationRuntime } = require('../routes/gbrain/integrationRuntime');
const { buildGBrainOverview } = require('../routes/gbrain/overview');

function createGBrainOverviewService(options = {}) {
  const probes = options.probes || {
    health: () => buildLiveGBrainHealth(options),
    sources: () => buildLiveGBrainSources(options),
    version: () => buildLiveGBrainVersion(options),
    tools: () => buildLiveGBrainTools(options),
    features: () => buildLiveGBrainFeatures(options),
    providers: () => buildLiveGBrainProviders(options),
    hermesProxy: () => buildLiveHermesProxyStatus(options),
  };
  const buildIntegrationRuntime = options.buildIntegrationRuntime
    || (() => buildLocalGBrainIntegrationRuntime(options));
  const timelineService = options.timelineService || createGBrainTimelineService({
    projectRoot: options.projectRoot,
    enabled: options.mcConfig?.modules?.gbrainTimeline !== false,
    ledgerPath: options.timelineLedgerPath,
  });

  function buildFromSnapshot(snapshot, extra = {}) {
    return buildGBrainOverview(snapshot.live, {
      integrationRuntime: snapshot.integrationRuntime,
      ...extra,
    });
  }

  async function readSnapshot() {
    const [health, sources, version, tools, features, providers, hermesProxy] = await Promise.all([
      probes.health(),
      probes.sources(),
      probes.version(),
      probes.tools(),
      probes.features(),
      probes.providers(),
      probes.hermesProxy(),
    ]);
    const integrationRuntime = buildIntegrationRuntime();
    const snapshot = {
      live: { health, sources, version, tools, features, providers, hermesProxy },
      integrationRuntime,
    };

    return { ...snapshot, overview: buildFromSnapshot(snapshot) };
  }

  async function getOverview() {
    const snapshot = await readSnapshot();
    const result = await timelineService.captureOverview(snapshot.overview);

    return buildFromSnapshot(snapshot, {
      timelineSummary: result.timelineSummary,
      incidentBanner: result.timelineSummary?.incidentBanner || null,
      incidentBanners: result.timelineSummary?.incidentBanners || [],
    });
  }

  return { readSnapshot, getOverview, buildFromSnapshot, timelineService };
}

module.exports = { createGBrainOverviewService };
