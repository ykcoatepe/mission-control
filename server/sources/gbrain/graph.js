'use strict';
const { createSource } = require('../../core/source');
const { httpError } = require('../../core/http');
const { slugInput, limitInput } = require('./lookups');
const { readError } = require('./client');
const GRAPH_TTL_MS = 15 * 60_000;
function normalizeGraph(rows, around) {
  if (!Array.isArray(rows) || rows.some((r) => typeof r?.from_slug !== 'string' || typeof r?.to_slug !== 'string')) throw readError('gbrain_invalid_payload');
  const links = [...new Map(rows.map((r) => [`${r.from_slug}\u0000${r.to_slug}`, { source: r.from_slug, target: r.to_slug }])).values()];
  const degrees = new Map([[around, 0]]);
  for (const link of links) for (const slug of [link.source, link.target]) degrees.set(slug, (degrees.get(slug) || 0) + 1);
  return { mode: 'neighbourhood', around, degreeScope: 'returned-subgraph',
    nodes: [...degrees].map(([slug, degree]) => ({ slug, title: null, type: null, degree })), links };
}
function createGraphCache({ client, now = Date.now, capacity = 16 } = {}) {
  const cache = new Map();
  function request(around, rawLimit) {
    around = slugInput(around); const limit = limitInput(rawLimit, 100, 500);
    let source = cache.get(around);
    if (!source) {
      if (cache.size >= capacity) {
        const victim = [...cache].find(([, s]) => !s.status().refreshing);
        if (!victim) throw httpError(503, 'gbrain_graph_busy', 'Graph capacity reached');
        cache.delete(victim[0]);
      }
      source = createSource({ id: 'gbrain.graph', now, ttlMs: GRAPH_TTL_MS, staleAfterMs: GRAPH_TTL_MS, timeoutMs: 60_000,
        read: async () => {
          try { return normalizeGraph(await client.run(['call', '--source', '__all__', 'traverse_graph',
            JSON.stringify({ slug: around, depth: 1, direction: 'both' })]), around); }
          catch (error) { throw readError(/^gbrain_[a-z_]+$/.test(error?.code) ? error.code : 'gbrain_read_failed'); }
        } });
      cache.set(around, source);
    }
    const snap = source.snapshot(); // A GET records bounded interest in memory, never starts a read.
    if (!snap.data) return { ...snap, meta: { ...snap.meta, error: snap.meta.error || { code: 'gbrain_graph_pending', message: 'Neighbourhood queued for scheduled refresh (within two minutes)' } } };
    const nodes = snap.data.nodes.slice(0, limit); const slugs = new Set(nodes.map((n) => n.slug));
    const links = snap.data.links.filter((l) => slugs.has(l.source) && slugs.has(l.target));
    const degree = new Map(nodes.map((n) => [n.slug, 0]));
    for (const l of links) for (const s of [l.source, l.target]) degree.set(s, degree.get(s) + 1);
    return { ...snap, data: { ...snap.data, nodes: nodes.map((n) => ({ ...n, degree: degree.get(n.slug) })), links,
      limit, truncated: nodes.length < snap.data.nodes.length } };
  }
  async function refresh() {
    const pending = [...cache.values()].filter((s) => s.snapshot().meta.stale);
    let index = 0;
    await Promise.all(Array.from({ length: 2 }, async () => { while (index < pending.length) await pending[index++].refresh(); }));
  }
  return { id: 'gbrain.graph', request, refresh, status: () => ({ neighbourhoods: [...cache.values()].map((s) => s.status()) }) };
}
module.exports = { createGraphCache, normalizeGraph, GRAPH_TTL_MS };
