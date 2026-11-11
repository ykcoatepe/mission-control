'use strict';
const { createSource } = require('../core/source');
const { createGBrainTimelineService } = require('./gbrainTimeline');
const { createGBrainSources, REFRESH_INTERVAL_MS } = require('../sources/gbrain/probes');
const { buildGBrainOverview } = require('../routes/gbrain/overview');
const { buildGBrainIntegrationHealth } = require('../routes/gbrain/integrationHealth');
const { buildSynoptic } = require('../sources/gbrain/synoptic');
const { sourceFreshnessStatus, summarizeSourceFreshness } = require('../routes/gbrain/liveProbes');
const { createLookups } = require('../sources/gbrain/lookups');
const { createGraphCache } = require('../sources/gbrain/graph');

function combineMeta(snapshots, source) {
  const metas = snapshots.map((s) => s.meta);
  const dates = metas.map((m) => m.observedAt).filter(Boolean).sort();
  return { ok: metas.length > 0 && metas.every((m) => m.ok), stale: metas.some((m) => m.stale),
    observedAt: dates[0] || null, ageMs: metas.some((m) => m.ageMs === null) ? null : Math.max(...metas.map((m) => m.ageMs)),
    error: metas.find((m) => m.error)?.error || null,
    latencyMs: metas.length ? Math.max(...metas.map((m) => m.latencyMs || 0)) : null, source };
}
function createGBrainOverviewService(options = {}) {
  const { now = Date.now } = options;
  const { sources, client } = createGBrainSources(options);
  const timelineService = options.timelineService || createGBrainTimelineService({ projectRoot: options.projectRoot,
    enabled: options.mcConfig?.modules?.gbrainTimeline !== false, ledgerPath: options.timelineLedgerPath });
  const timeline = createSource({ id: 'gbrain.timeline', now, ttlMs: REFRESH_INTERVAL_MS, timeoutMs: 60_000,
    read: () => timelineService.readTimeline({ limit: 200 }) });
  const lookups = createLookups({ client, now });
  const graph = createGraphCache({ client, now });
  let timelineSummary = null;
  let refreshInFlight = null;
  const empty = (name) => ({ data: null, meta: { ok: false, stale: true, observedAt: null, ageMs: null, error: null, latencyMs: null, source: `gbrain.${name}` } });
  const probeSnapshot = (name) => sources[name]?.snapshot() || empty(name);
  function legacy(name) {
    const s = probeSnapshot(name);
    return s.data ? { ...s.data, meta: s.meta } : { ok: false, status: 'unavailable', mode: 'live-read-only', checkedAt: null, error: 'GBrain reading unavailable', meta: s.meta };
  }
  function readSnapshot() {
    const live = Object.fromEntries(['health', 'sources', 'version', 'tools', 'features', 'providers', 'hermesProxy'].map((k) => [k, legacy(k)]));
    if (live.health.ok) {
      const stats = probeSnapshot('stats'); const jobs = probeSnapshot('jobs');
      live.health = { ...live.health, metrics: { ...live.health.metrics,
        ...(stats.data || {}), queue: jobs.data || { waiting: null, active: null, stalled: null } },
        meta: combineMeta([probeSnapshot('health'), stats, jobs], 'gbrain.health') };
    }
    if (live.sources.ok && Array.isArray(live.sources.sources)) {
      const at = new Date(now()).toISOString();
      live.sources = { ...live.sources, sources: live.sources.sources.map((s) => ({ ...s, freshness: sourceFreshnessStatus(s, s.lastSyncAt, at) })) };
      live.sources.freshness = summarizeSourceFreshness(live.sources.sources, at);
    }
    const runtime = probeSnapshot('runtime');
    const snapshot = { live, integrationRuntime: { ...(runtime.data || {}), meta: runtime.meta }, meta: combineMeta(Object.values(sources).map((s) => s.snapshot()), 'gbrain.overview') };
    return { ...snapshot, overview: buildFromSnapshot(snapshot) };
  }
  function buildFromSnapshot(snapshot, extra = {}) {
    const synoptic = buildSynoptic({ probeSnapshot, live: snapshot.live, now });
    return { ...buildGBrainOverview(snapshot.live, { integrationRuntime: snapshot.integrationRuntime,
      ...(timelineSummary ? { timelineSummary, incidentBanner: timelineSummary.incidentBanner || null, incidentBanners: timelineSummary.incidentBanners || [] } : {}),
      ...extra, verdict: synoptic.verdict, sourcesState: synoptic.sourcesState }),
      unavailable: synoptic.verdict.state === 'unavailable', meta: snapshot.meta };
  }
  function overviewSnapshot() { const s = readSnapshot(); return { data: s.overview, meta: s.meta }; }
  function getOverview() { return readSnapshot().overview; }
  function integrationSnapshot() {
    const s = readSnapshot();
    return { data: buildGBrainIntegrationHealth(s.live, s.integrationRuntime), meta: s.meta };
  }
  function synopticSnapshot() {
    const s = readSnapshot();
    const available = Object.values(sources).some((source) => source.snapshot().data !== null);
    return { data: available ? buildSynoptic({ probeSnapshot, live: s.live, now }) : null, meta: s.meta };
  }
  function timelineSnapshot(limit = 50) {
    const snap = timeline.snapshot();
    if (!snap.data) return snap;
    const entries = snap.data.entries || [];
    return { ...snap, data: { ...snap.data, entries: entries.slice(0, limit), limit,
      truncated: snap.data.truncated || entries.length > limit } };
  }
  function refresh() {
    if (refreshInFlight) return refreshInFlight;
    refreshInFlight = (async () => {
      const pending = Object.values(sources); let index = 0;
      await Promise.all(Array.from({ length: 2 }, async () => {
        while (index < pending.length) await pending[index++].refresh();
      }));
      // Sole ledger writer: only the scheduler/explicit refresh reaches here.
      // The ledger's change/heartbeat, retention, fingerprint and lock rules stay intact.
      if (probeSnapshot('health').data || probeSnapshot('sources').data) {
        const result = await timelineService.captureOverview(getOverview());
        timelineSummary = result?.timelineSummary || null;
      }
      await timeline.refresh();
      return readSnapshot();
    })().finally(() => { refreshInFlight = null; });
    return refreshInFlight;
  }
  function register(scheduler) {
    scheduler.register({ id: 'gbrain.refresh', run: refresh,
      status: () => ({ sources: Object.values(sources).map((source) => source.status()) }) }, { intervalMs: REFRESH_INTERVAL_MS, jitterMs: 1500 });
    scheduler.register(graph, { intervalMs: 120_000, jitterMs: 1500 });
  }
  return { readSnapshot, getOverview, buildFromSnapshot, timelineService, probeSnapshot, refresh, register,
    integrationSnapshot, synopticSnapshot, overviewSnapshot, timelineSnapshot, lookups, graph, sources };
}
module.exports = { createGBrainOverviewService, combineMeta };
