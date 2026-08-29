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
  let snapshotInFlight = null;

  function buildFromSnapshot(snapshot, extra = {}) {
    return buildGBrainOverview(snapshot.live, {
      integrationRuntime: snapshot.integrationRuntime,
      ...extra,
    });
  }

  async function readSnapshot() {
    // GBrain and Operations poll this service on overlapping refresh cycles.
    // Coalesce concurrent reads so the probe semaphore bounds actual database
    // pressure, not just pressure from one request.
    if (snapshotInFlight) return snapshotInFlight;

    snapshotInFlight = (async () => {
      // Most GBrain probes open their own database connection. A full fan-out
      // can exhaust the local runtime and report false outages, while serial
      // execution can outlive a consumer deadline. Two at a time bounds peak
      // database pressure without turning the operator refresh into a
      // long-running request.
      const probeEntries = [
        ['health', probes.health],
        ['sources', probes.sources],
        ['version', probes.version],
        ['tools', probes.tools],
        ['features', probes.features],
        ['providers', probes.providers],
        ['hermesProxy', probes.hermesProxy],
      ];
      const probeResults = new Map();
      let nextProbe = 0;

      const runWorker = async () => {
        while (nextProbe < probeEntries.length) {
          const [name, probe] = probeEntries[nextProbe];
          nextProbe += 1;
          probeResults.set(name, await probe());
        }
      };

      await Promise.all(Array.from(
        { length: Math.min(2, probeEntries.length) },
        () => runWorker(),
      ));
      const live = Object.fromEntries(probeEntries.map(([name]) => [name, probeResults.get(name)]));
      const integrationRuntime = buildIntegrationRuntime();
      const snapshot = {
        live,
        integrationRuntime,
      };

      return { ...snapshot, overview: buildFromSnapshot(snapshot) };
    })();

    try {
      return await snapshotInFlight;
    } finally {
      snapshotInFlight = null;
    }
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
