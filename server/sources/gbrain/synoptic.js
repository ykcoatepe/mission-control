'use strict';
const { deriveState, stateOf } = require('./state');
const { number, COMPONENT_KEYS } = require('./probes');
const { sourceFreshnessStatus } = require('../../routes/gbrain/liveProbes');

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
    const fresh = sourceFreshnessStatus(s, s.lastSyncAt, new Date(now()).toISOString());
    const state = stateOf(ss, { inactive: s.syncEnabled === false || s.excludedByPolicy === true,
      critical: /critical|corrupt/i.test(s.status), warning: fresh.status === 'warning' || /error|failed|behind|dirty/i.test(s.status) });
    const item = { id: s.id, label: s.id, state, observedAt: ss.meta.observedAt, lastSyncAt: s.lastSyncAt,
      behind: number(s.behind), excludedByPolicy: s.excludedByPolicy ?? null };
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
  const readers = (runtime.data?.readers || []).map((r) => ({ id: r.id, label: r.label,
    state: stateOf(runtime, { observed: r.observed, warning: true }), observedAt: runtime.meta.observedAt,
    integration: { configured: r.configured, state: stateOf(runtime, { observed: r.observed, warning: r.configured !== true }),
      observedAt: runtime.meta.observedAt, evidence: r.evidence }, connection: { state: deriveState({ observed: false }), observedAt: null } }));
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
  for (const r of readers) edge(r.id, 'gbrain', 'connection not observed', { value: null, unit: 'connection', state: 'unavailable', observedAt: null });
  const sourcesState = stateOf(ss, { critical: sources.some((s) => s.state === 'critical'),
    warning: sources.some((s) => s.state === 'warning') });
  const readersState = stateOf(runtime, { warning: readers.some((r) => r.state !== 'healthy') });
  const states = [core.state, sourcesState, queue.state];
  return { schemaVersion: '1', state: deriveState({ observed: true,
    failed: states.includes('unavailable'), critical: states.includes('critical'),
    warning: states.includes('warning') || readersState !== 'healthy' }),
    core, sources, sourcesState, queue, readers, readersState, edges };
}
module.exports = { buildSynoptic };
