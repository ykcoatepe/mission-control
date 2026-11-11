'use strict';
const { createSource } = require('../../core/source');
const { createGBrainClient, readError } = require('./client');
const { buildLocalGBrainIntegrationRuntime } = require('../../routes/gbrain/integrationRuntime');
const { readReaders } = require('./readers');
const { normalizeHealthPayload, normalizeSourcesPayload, normalizeStatsPayload, normalizeToolsPayload,
  normalizeFeaturesPayload, normalizeProvidersPayload, parseVersionOutput, liveHealthStatus, buildLiveHermesProxyStatus } = require('../../routes/gbrain/liveProbes');

// Measured sequentially on 2026-11-11: health 1914ms, status 1161ms, jobs 892ms,
// stats 1060ms, features 3702ms, tools 348ms, providers 414ms. A 3-minute cycle
// avoids request fan-out; all CLI reads have a 45s execution + 10s lane wait cap.
const REFRESH_INTERVAL_MS = 180_000;
const STALE_AFTER_MS = 360_000;
const COMPONENT_KEYS = ['embed_coverage_score', 'link_density_score', 'timeline_coverage_score', 'no_orphans_score', 'no_dead_links_score'];
const number = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
function requireShape(ok) { if (!ok) throw readError('gbrain_invalid_payload'); }
function createGBrainSources(options = {}) {
  const { now = Date.now } = options;
  const client = options.client || createGBrainClient(options);
  const checkedAt = () => new Date(now()).toISOString();
  const reads = {
    health: async () => {
      const p = await client.run(['call', '--source', '__all__', 'get_health']);
      requireShape(number(p.page_count) !== null || number(p.brain_score) !== null);
      // Normalize only root health fields: a nested migration/graph gate's
      // status is not the brain's health status. No raw upstream object leaves this reader.
      const healthKeys = ['status', 'health_status', 'brain_score', 'health_score', 'page_count', 'chunk_count',
        'embedded_count', 'missing_embeddings', 'missing_embeddings_oldest_age_seconds', 'stale_pages',
        'stale_pages_oldest_lag_seconds', 'embed_coverage'];
      const data = normalizeHealthPayload(Object.fromEntries(healthKeys.filter((k) => k in p).map((k) => [k, p[k]])), null, checkedAt());
      data.score = number(p.brain_score) !== null && p.brain_score <= 100 ? p.brain_score : null;
      data.status = liveHealthStatus(data);
      data.components = Object.fromEntries(COMPONENT_KEYS.map((k) => [k, number(p[k])]));
      data.computedAt = typeof p.computed_at === 'string' ? p.computed_at : null;
      return data;
    },
    jobs: async () => {
      const p = await client.run(['jobs', 'stats', '--json']);
      const q = p.queue_health;
      requireShape(q && ['waiting', 'active', 'stalled'].every((k) => Number.isInteger(q[k]) && q[k] >= 0));
      return { waiting: q.waiting, active: q.active, stalled: q.stalled };
    },
    stats: async () => {
      const p = await client.run(['stats', '--source', '__all__', '--json']);
      requireShape(['page_count', 'chunk_count', 'embedded_count'].every((k) => Number.isInteger(p[k]) && p[k] >= 0));
      return normalizeStatsPayload(p);
    },
    sources: async () => {
      const p = await client.run(['call', '--source', '__all__', 'get_status_snapshot']);
      requireShape(Array.isArray(p.sync?.sources));
      const data = normalizeSourcesPayload(p.sync.sources, checkedAt());
      for (const s of data.sources) {
        const raw = p.sync.sources.find((r) => (r.source_id || r.id) === s.id);
        // Behind/exclusion are only known when explicitly reported, never inferred from zero pages.
        s.behind = number(raw?.behind ?? raw?.commits_behind);
        s.excludedByPolicy = typeof raw?.excluded_by_policy === 'boolean' ? raw.excluded_by_policy : null;
      }
      return data;
    },
    version: async () => {
      const version = parseVersionOutput(await client.run(['--version'], { json: false }));
      requireShape(Boolean(version));
      return { ok: true, mode: 'live-read-only', checkedAt: checkedAt(), version, source: 'gbrain --version' };
    },
    tools: async () => {
      const p = await client.run(['--tools-json']);
      requireShape(Array.isArray(p) || Array.isArray(p.tools));
      const data = normalizeToolsPayload(p, checkedAt()); requireShape(data.ok); return data;
    },
    features: async () => {
      const p = await client.run(['features', '--json']); requireShape(Array.isArray(p.recommendations));
      return normalizeFeaturesPayload(p, checkedAt());
    },
    providers: async () => {
      const p = await client.run(['providers', 'explain', '--json']); requireShape(Array.isArray(p.options));
      return normalizeProvidersPayload(p, checkedAt());
    },
    hermesProxy: () => buildLiveHermesProxyStatus(options),
    runtime: () => {
      const runtime = (options.buildIntegrationRuntime || (() => buildLocalGBrainIntegrationRuntime(options)))();
      return { ...runtime, readers: runtime.readers || (options.probes ? [] : readReaders(options)) };
    },
  };
  // Tests may supply a bounded set of probe functions without ever calling a real upstream.
  const selected = options.probes ? { ...options.probes, runtime: reads.runtime } : reads;
  const sources = Object.fromEntries(Object.entries(selected).map(([name, read]) => [name, createSource({
    id: `gbrain.${name}`, now, ttlMs: REFRESH_INTERVAL_MS, staleAfterMs: STALE_AFTER_MS, timeoutMs: 60_000,
    read: async () => {
      try {
        const value = await read();
        if (value == null || value.ok === false) throw readError();
        return value;
      } catch { throw readError(); }
    },
  })]));
  return { sources, client };
}
module.exports = { createGBrainSources, REFRESH_INTERVAL_MS, STALE_AFTER_MS, COMPONENT_KEYS, number };
