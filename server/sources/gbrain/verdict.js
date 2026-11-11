'use strict';
const { worstState, isState } = require('../../core/state');
const caveatStates = new Set(['warning', 'critical', 'unavailable']);
function verdictCaveats(verdict) {
  return verdict.reasons.filter((r) => caveatStates.has(r.state)).map((r) => r.text);
}
function isGBrainVerdict(value) {
  return value && isState(value.state) && Array.isArray(value.reasons)
    && value.reasons.every((r) => r && typeof r.elementId === 'string' && isState(r.state)
      && typeof r.text === 'string' && r.text.length > 0);
}
/** The sole aggregate verdict. Every HTTP consumer transports this result unchanged. */
function buildGBrainVerdict({ core, sources, sourcesState, queue, readers, readersState, live, probes = {}, legacyOverview }) {
  const reasons = [];
  function add(elementId, state, text) { reasons.push({ elementId, state, text }); }
  // Legacy callers supply the old presentation contract. Adapt it to the same
  // reason model here; no consumer may independently reconstruct its state.
  if (legacyOverview) {
    core = { state: legacyOverview.trust.status, quality: { value: legacyOverview.trust.score } };
    sources = []; sourcesState = 'healthy'; queue = { state: 'inactive' };
    readers = []; readersState = 'inactive'; live = legacyOverview.live || {};
    for (const text of legacyOverview.caveats) add('legacy-caveat', core.state === 'critical' ? 'critical' : 'warning', text);
    if (live.sources?.freshness?.staleCount > 0) add('sources', 'warning', 'Source freshness threshold exceeded.');
  }
  for (const [name, snapshot] of Object.entries(probes)) {
    if (snapshot.meta.error) add(`gbrain.${name}`, 'unavailable', `${name} probe unavailable.`);
    else if (snapshot.data !== null && snapshot.meta.stale) add(`gbrain.${name}`, 'warning', `${name} evidence is stale.`);
  }
  const m = live.health?.metrics || {};
  // Every reading the page shows as a state is a reason here, whatever status
  // GBrain itself reports: link extraction and missing embeddings past their
  // tolerance are named separately from the quality score.
  const overdue = (value) => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0);
  const staleOverdue = overdue(m.stalePagesOverdue ?? (m.stalePagesCatchingUp === undefined ? m.stalePages : 0));
  if (m.stalePagesUnavailable !== true && staleOverdue > 0) {
    add('link-extraction', 'warning', `Link extraction is behind: ${staleOverdue} ${staleOverdue === 1 ? 'page' : 'pages'} past the tolerance.`);
  }
  const missingOverdue = overdue(m.missingEmbeddingsOverdue ?? (m.missingEmbeddingsCatchingUp === undefined ? m.missingEmbeddings : 0));
  if (m.missingEmbeddingsUnavailable !== true && missingOverdue > 0) {
    add('missing-embeddings', 'warning', `${missingOverdue} ${missingOverdue === 1 ? 'chunk is' : 'chunks are'} missing embeddings past the tolerance.`);
  }
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
    r.state === 'inactive' ? r.observation === 'configured'
      ? `${r.label}: configured; connection telemetry is not observable locally.`
      : `${r.label}: integration not configured.` : `${r.label}: integration ${r.state}.`);
  if (readersState === 'unavailable' && !readers.length) add('readers', readersState, 'Reader integration reading unavailable.');
  // Inactive reasons are listed but never degrade the verdict.
  return { state: worstState(['healthy', ...reasons.map((r) => r.state).filter((state) => state !== 'inactive')]), reasons };
}
module.exports = { buildGBrainVerdict, verdictCaveats, isGBrainVerdict };
