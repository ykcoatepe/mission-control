'use strict';
const { deriveState } = require('./state');
const STATES = ['healthy', 'warning', 'critical', 'unavailable', 'inactive'];
const caveatStates = new Set(['warning', 'critical', 'unavailable']);
function verdictCaveats(verdict) {
  return verdict.reasons.filter((r) => caveatStates.has(r.state)).map((r) => r.text);
}
function isGBrainVerdict(value) {
  return value && STATES.includes(value.state) && Array.isArray(value.reasons)
    && value.reasons.every((r) => r && typeof r.elementId === 'string' && STATES.includes(r.state)
      && typeof r.text === 'string' && r.text.length > 0);
}
/** The sole aggregate verdict. Every HTTP consumer transports this result unchanged. */
function buildGBrainVerdict({ core, sources, sourcesState, queue, readers, readersState, live, probes = {} }) {
  const reasons = [];
  function add(elementId, state, text) { reasons.push({ elementId, state, text }); }
  for (const [name, snapshot] of Object.entries(probes)) {
    if (snapshot.meta.error) add(`gbrain.${name}`, 'unavailable', `${name} probe unavailable.`);
    else if (snapshot.data !== null && snapshot.meta.stale) add(`gbrain.${name}`, 'warning', `${name} evidence is stale.`);
  }
  const m = live.health?.metrics || {};
  if (m.embedJobProbeUnavailable === true) add('embed-job-probe', 'unavailable', 'Embed-job probe unavailable; the missing-embedding verdict uses embedding age only.');
  if (m.missingEmbeddingsUnavailable === true) add('missing-embeddings', 'unavailable', 'Missing-embedding count unavailable.');
  if (m.stalePagesUnavailable === true) add('stale-pages', 'unavailable', 'Stale-page count unavailable.');
  if (core.state !== 'healthy') add('gbrain-core', core.state,
    core.state === 'unavailable' ? 'GBrain core reading unavailable.' : `GBrain core requires attention (quality ${core.quality.value ?? 'unavailable'}).`);
  for (const group of sources) for (const s of group.items) {
    if (s.state === 'inactive') add(s.id, 'inactive', `${s.label}: ${s.reason}.`);
    else if (s.state === 'warning') add(s.id, 'warning', `${s.label}: ${s.reason || 'source evidence is stale'}.`);
  }
  if (sourcesState === 'unavailable' && !reasons.some((r) => r.elementId === 'gbrain.sources')) add('sources', sourcesState, 'Source inventory unavailable.');
  if (!['healthy', 'inactive'].includes(queue.state)) add('queue', queue.state,
    queue.state === 'unavailable' ? 'Queue reading unavailable.' : 'Queue requires attention.');
  for (const r of readers) if (r.state !== 'healthy') add(r.id, r.state,
    r.state === 'inactive' ? `${r.label}: integration not configured.` : `${r.label}: integration ${r.state}.`);
  if (readersState === 'unavailable' && !readers.length) add('readers', readersState, 'Reader integration reading unavailable.');
  return { state: deriveState({ observed: true, failed: reasons.some((r) => r.state === 'unavailable'),
    critical: reasons.some((r) => r.state === 'critical'), warning: reasons.some((r) => r.state === 'warning') }), reasons };
}
module.exports = { buildGBrainVerdict, verdictCaveats, isGBrainVerdict };
