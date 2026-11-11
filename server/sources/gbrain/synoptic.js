'use strict';
const { deriveState, stateOf } = require('./state');
const { number, COMPONENT_KEYS } = require('./probes');
const { classifySource } = require('./freshness');
const { buildGBrainVerdict } = require('./verdict');

/**
 * @typedef {{state: import('./state').EvidenceState, observedAt: string|null}} Evidence
 * @typedef {Evidence & {value: number|string|null, unit: string}} Measurement
 * @typedef {Evidence & {id:string,label:string,lastSyncAt:string|null,behind:number|null,excludedByPolicy:boolean|null}} Source
 * @typedef {{schemaVersion:'1',state:string,core:object,sources:Array,queue:object,readers:Array,edges:Array}} Synoptic
 * Every metric, node and edge has an evidence state; null means not observed.
 * Reader configuration is observable; connection and per-reader usage are not.
 */
function groupFor(id) {
  if (/hermes|codex|claude|openclaw|memor/i.test(id)) return 'agent-memory';
  if (/aviation|a320|manual|standard/i.test(id)) return 'reference';
  if (id === 'default') return 'curated';
  return 'projects';
}
/** @returns {import('./contract').GBrainSynoptic} */
function buildSynoptic({ probeSnapshot, live, now = Date.now }) {
  const h = probeSnapshot('health'); const st = probeSnapshot('stats');
  const ss = probeSnapshot('sources'); const v = probeSnapshot('version');
  const j = probeSnapshot('jobs'); const runtime = probeSnapshot('runtime');
  function metric(value, unit, snapshot, flags = {}) {
    return { value: value ?? null, unit, observedAt: snapshot.meta.observedAt,
      state: stateOf(snapshot, { observed: value != null && snapshot.data != null, ...flags }) };
  }
  const core = {
    version: metric(v.data?.version, 'version', v), pages: metric(st.data?.pages, 'pages', st),
    chunks: metric(st.data?.chunks, 'chunks', st), embedded: metric(st.data?.embedded, 'chunks', st),
    quality: { ...metric(h.data?.score, 'points/100', h, { critical: live.health?.status === 'critical', warning: live.health?.status !== 'healthy' }),
      components: COMPONENT_KEYS.map((id) => ({ id, ...metric(h.data?.components?.[id], 'points', h) })) },
  };
  core.state = deriveState({ observed: [h, st, v].some((s) => s.data),
    failed: [h, st, v].some((s) => s.meta.error), critical: Object.values(core).some((m) => m.state === 'critical'), warning: Object.values(core).some((m) => m.state !== 'healthy') });
  core.observedAt = h.meta.observedAt;
  const groups = new Map();
  for (const s of ss.data?.sources || []) {
    const classification = classifySource(s, ss, now);
    const item = { id: s.id, label: s.id, state: classification.state, observedAt: ss.meta.observedAt,
      lastSyncAt: classification.freshness.lastSyncAt, behind: number(s.behind),
      excludedByPolicy: classification.excludedByPolicy, reason: classification.reason,
      syncTracked: classification.freshness.syncTracked, ageHours: classification.freshness.ageHours,
      thresholdHours: classification.freshness.thresholdHours };
    const group = groupFor(s.id);
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(item);
  }
  const sources = [...groups].map(([id, items]) => ({ id, label: id, state: deriveState({ observed: true,
    failed: items.some((s) => s.state === 'unavailable'), critical: items.some((s) => s.state === 'critical'), warning: items.some((s) => s.state === 'warning'),
    inactive: items.every((s) => s.state === 'inactive') }), observedAt: ss.meta.observedAt, items }));
  const queue = { state: stateOf(j, { warning: j.data?.stalled > 0 }), observedAt: j.meta.observedAt,
    waiting: metric(j.data?.waiting, 'jobs', j), active: metric(j.data?.active, 'jobs', j),
    stalled: metric(j.data?.stalled, 'jobs', j, { warning: j.data?.stalled > 0 }) };
  const readers = (runtime.data?.readers || []).map((r) => {
    const integration = { configured: r.configured,
      state: stateOf(runtime, { observed: r.observed === true && typeof r.configured === 'boolean',
        inactive: r.configured === false }),
      observedAt: runtime.meta.observedAt, evidence: r.evidence };
    return { id: r.id, label: r.label, state: integration.state,
      observedAt: integration.observedAt, integration };
  });
  const edges = [];
  function edge(from, to, label, measurement, state = measurement.state) {
    edges.push({ from, to, state: deriveState({ observed: state !== 'unavailable', inactive: state === 'inactive',
      warning: state === 'warning', critical: state === 'critical' }), label, unit: measurement.unit,
      observedAt: measurement.observedAt, measurement });
  }
  for (const group of sources) for (const s of group.items) {
    const age = s.lastSyncAt ? Math.max(0, Math.floor((now() - Date.parse(s.lastSyncAt)) / 1000)) : null;
    edge(s.id, 'gbrain', 'time since source sync', metric(age, 'seconds', ss), s.state);
  }
  edge('queue', 'gbrain', 'embedding jobs waiting', queue.waiting, queue.state);
  for (const r of readers) edges.push({ from: r.id, to: 'gbrain', label: 'configured',
    state: r.integration.state, observedAt: r.integration.observedAt });
  const sourcesState = stateOf(ss, { critical: sources.some((s) => s.state === 'critical'),
    warning: sources.some((s) => s.state === 'warning'),
    inactive: sources.length > 0 && sources.every((s) => s.state === 'inactive') });
  const readersState = !runtime.data && !runtime.meta.error
    ? deriveState({ observed: true, inactive: true })
    : stateOf(runtime, { failed: Boolean(runtime.meta.error) || readers.some((r) => r.state === 'unavailable'),
      warning: readers.some((r) => r.state === 'warning'),
      inactive: readers.length === 0 || readers.every((r) => r.state === 'inactive') });
  const verdict = buildGBrainVerdict({ core, sources, sourcesState, queue, readers, readersState, live,
    probes: Object.fromEntries(['health', 'stats', 'jobs', 'sources', 'version', 'tools', 'features', 'providers', 'hermesProxy', 'runtime']
      .map((name) => [name, probeSnapshot(name)])) });
  return { schemaVersion: '1', state: verdict.state, verdict,
    core, sources, sourcesState, queue, readers, readersState,
    readersNote: 'connection telemetry is not observable locally', edges };
}
module.exports = { buildSynoptic };
