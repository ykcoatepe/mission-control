'use strict';
const { createSource } = require('../core/source');
const { createGBrainTimelineService } = require('./gbrainTimeline');
const { createGBrainSources, REFRESH_INTERVAL_MS } = require('../sources/gbrain/probes');
const { buildGBrainOverview } = require('../routes/gbrain/overview');
const { buildGBrainIntegrationHealth } = require('../routes/gbrain/integrationHealth');
const { buildSynoptic } = require('../sources/gbrain/synoptic');
const { summarizeSourceFreshness } = require('../routes/gbrain/liveProbes');
const { classifySource } = require('../sources/gbrain/freshness');
const { createLookups } = require('../sources/gbrain/lookups');
const { createGraphCache } = require('../sources/gbrain/graph');
const ACTION_REFRESH_WAIT_MS = 20_000;

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
  let actionGeneration = 0;
  let verifiedGeneration = 0;
  let refreshFailure = null;
  const waitMs = Number.isFinite(options.actionRefreshWaitMs)
    ? Math.max(1, Math.min(ACTION_REFRESH_WAIT_MS, options.actionRefreshWaitMs)) : ACTION_REFRESH_WAIT_MS;
  const empty = (name) => ({ data: null, meta: { ok: false, stale: true, observedAt: null, ageMs: null, error: null, latencyMs: null, source: `gbrain.${name}` } });
  const rawProbeSnapshot = (name) => name === 'timeline' ? timeline.snapshot() : sources[name]?.snapshot() || empty(name);
  const markUnverified = (snap) => actionGeneration > verifiedGeneration
    ? { ...snap, meta: { ...snap.meta, stale: true } } : snap;
  const probeSnapshot = (name) => markUnverified(rawProbeSnapshot(name));
  function legacy(name, probe) {
    const s = probe(name);
    return s.data ? { ...s.data, meta: s.meta } : { ok: false, status: 'unavailable', mode: 'live-read-only', checkedAt: null, error: 'GBrain reading unavailable', meta: s.meta };
  }
  function readSnapshot({ capture = false } = {}) {
    // A ledger capture records probe evidence, not the temporary post-action
    // cache barrier (nor the previous timeline reading's barrier).
    const probe = capture ? rawProbeSnapshot : probeSnapshot;
    const live = Object.fromEntries(['health', 'sources', 'version', 'tools', 'features', 'providers', 'hermesProxy'].map((k) => [k, legacy(k, probe)]));
    if (live.health.ok) {
      const stats = probe('stats'); const jobs = probe('jobs');
      live.health = { ...live.health, metrics: { ...live.health.metrics,
        ...(stats.data || {}), queue: jobs.data || { waiting: null, active: null, stalled: null } },
        meta: combineMeta([probe('health'), stats, jobs], 'gbrain.health') };
    }
    if (live.sources.ok && Array.isArray(live.sources.sources)) {
      const at = new Date(now()).toISOString();
      live.sources = { ...live.sources, sources: live.sources.sources.map((s) => {
        const classified = classifySource(s, probe('sources'), now);
        return { ...s, freshness: classified.freshness,
          excludedByPolicy: classified.excludedByPolicy, reason: classified.reason };
      }) };
      live.sources.freshness = summarizeSourceFreshness(live.sources.sources, at);
    }
    const runtime = probe('runtime');
    const timelineSnapshot = probe('timeline');
    const parts = Object.keys(sources).map(probe);
    if (timelineSnapshot.data !== null || timelineSnapshot.meta.error) parts.push(timelineSnapshot);
    const meta = combineMeta(parts, 'gbrain.overview');
    if (!capture && actionGeneration > verifiedGeneration && refreshFailure) {
      meta.ok = false; meta.error ||= refreshFailure; meta.stale = true;
    }
    const snapshot = { live, integrationRuntime: { ...(runtime.data || {}), meta: runtime.meta }, meta };
    return { ...snapshot, overview: buildFromSnapshot(snapshot, {}, probe) };
  }
  function buildFromSnapshot(snapshot, extra = {}, probe = probeSnapshot) {
    const synoptic = buildSynoptic({ probeSnapshot: probe, live: snapshot.live, now });
    const summary = timelineSummary && timeline.snapshot().meta.error
      ? { ...timelineSummary, status: 'warning', warning: 'Timeline ledger unavailable', lastCaptureReason: 'failed' } : timelineSummary;
    return { ...buildGBrainOverview(snapshot.live, { integrationRuntime: snapshot.integrationRuntime,
      ...(summary ? { timelineSummary: summary, incidentBanner: summary.incidentBanner || null, incidentBanners: summary.incidentBanners || [] } : {}),
      ...extra, verdict: synoptic.verdict, sourcesState: synoptic.sourcesState }),
      unavailable: synoptic.verdict.state === 'unavailable', meta: snapshot.meta };
  }
  function overviewSnapshot() { const s = readSnapshot(); return { data: s.overview, meta: s.meta }; }
  function sourcesSnapshot() {
    const s = readSnapshot();
    return { data: s.live.sources, meta: probeSnapshot('sources').meta };
  }
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
    const snap = probeSnapshot('timeline');
    if (!snap.data) return snap;
    const entries = snap.data.entries || [];
    return { ...snap, data: { ...snap.data, entries: entries.slice(0, limit), limit,
      truncated: snap.data.truncated || entries.length > limit } };
  }
  async function refreshPass() {
    const pending = Object.values(sources); let index = 0;
    await Promise.all(Array.from({ length: 2 }, async () => {
      while (index < pending.length) await pending[index++].refresh();
    }));
    // Sole ledger writer: scheduler and explicit post-action refresh use this
    // same pass. Material changes only; retention and lock rules stay intact.
    try {
      if (rawProbeSnapshot('health').data || rawProbeSnapshot('sources').data) {
        const result = await timelineService.captureOverview(readSnapshot({ capture: true }).overview);
        timelineSummary = result?.timelineSummary || null;
      }
    } finally {
      // Capture failure must not leave an earlier healthy timeline visible.
      await timeline.refresh();
    }
  }
  function refresh() {
    if (refreshInFlight) return refreshInFlight;
    refreshInFlight = (async () => {
      let generation; let failure;
      do {
        generation = actionGeneration;
        try { await refreshPass(); failure = null; } catch (error) { failure = error; }
        const metas = [...Object.values(sources).map((s) => s.snapshot().meta), timeline.snapshot().meta];
        if (!failure && timelineSummary?.lastCaptureReason !== 'failed' && metas.every((m) => m.ok && !m.stale)) {
          verifiedGeneration = generation; refreshFailure = null;
        } else if (actionGeneration > verifiedGeneration) {
          refreshFailure = { code: 'gbrain_refresh_failed', message: 'GBrain readings could not be refreshed' };
        }
        // An action that completed during an older pass needs a pass whose
        // upstream reads START after that action. Coalesce queued actions.
      } while (generation < actionGeneration);
      if (failure) throw failure;
      return readSnapshot();
    })().finally(() => { refreshInFlight = null; });
    return refreshInFlight;
  }
  function refreshAfterAction() {
    actionGeneration++; refreshFailure = null;
    const work = refresh();
    return new Promise((resolve) => {
      let done = false; let timer;
      const finish = () => {
        if (done) return;
        done = true; clearTimeout(timer);
        let meta;
        try { meta = readSnapshot().meta; } catch {
          meta = { ok: false, stale: true, observedAt: null, ageMs: null, latencyMs: null,
            source: 'gbrain.overview', error: { code: 'gbrain_refresh_failed', message: 'GBrain readings could not be refreshed' } };
        }
        resolve({ observedAt: meta.observedAt, refreshPending: Boolean(refreshInFlight), meta });
      };
      timer = setTimeout(finish, waitMs); timer.unref?.();
      // A timeout ends only the HTTP wait; the shared refresh owns its work.
      // Attach both handlers now, including after a timed-out caller leaves.
      work.then(finish, finish);
    });
  }
  function register(scheduler) {
    scheduler.register({ id: 'gbrain.refresh', run: refresh,
      status: () => ({ sources: Object.values(sources).map((source) => source.status()) }) }, { intervalMs: REFRESH_INTERVAL_MS, jitterMs: 1500 });
    scheduler.register(graph, { intervalMs: 120_000, jitterMs: 1500 });
  }
  return { actionExec: options.exec, readSnapshot, getOverview, buildFromSnapshot, timelineService, probeSnapshot, refresh, refreshAfterAction, register,
    integrationSnapshot, synopticSnapshot, overviewSnapshot, sourcesSnapshot, timelineSnapshot, lookups, graph, sources };
}
module.exports = { createGBrainOverviewService, combineMeta };
