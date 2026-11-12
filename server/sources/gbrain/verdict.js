'use strict';
const { worstState, isState, stateRank } = require('../../core/state');
/** The reading limitation when the embed-job probe fails; shared with the overview's own wording. */
const EMBED_JOB_PROBE_TEXT = "Embedding job status couldn't be read, so missing embeddings are judged by age only.";
/**
 * Every reason is either something to act on or something to know. This is the one place that
 * decides: an inactive reason never asks anything of anyone, and a reason flagged `info` is a
 * limitation of the reading, not a fault. Everything else is an action.
 */
const REASON_KINDS = Object.freeze(['action', 'info']);
/** Reasons that name why the core is not healthy. A core line next to one of these only restates it. */
const CORE_CAUSE_IDS = new Set(['link-extraction', 'missing-embeddings', 'stale-pages', 'gbrain.health', 'gbrain.stats', 'gbrain.version']);
/** GBrain's own score threshold for a healthy brain (liveProbes.js derives the same 90 when GBrain sends no status). */
const HEALTHY_SCORE = 90;
const caveatStates = new Set(['warning', 'critical', 'unavailable']);
function verdictCaveats(verdict) {
  return verdict.reasons.filter((r) => caveatStates.has(r.state)).map((r) => r.text);
}
function isGBrainVerdict(value) {
  return value && isState(value.state) && Array.isArray(value.reasons)
    && value.reasons.every((r) => r && typeof r.elementId === 'string' && isState(r.state)
      && typeof r.text === 'string' && r.text.length > 0
      && (r.kind === undefined || REASON_KINDS.includes(r.kind)));
}
const listNames = (names) => (names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`);
/**
 * Why the core is not healthy when no other reason says so. Names the cause GBrain reported; the
 * quality score is mentioned only when it is below GBrain's own healthy line.
 */
function coreCauseText(core, live) {
  if (core.state === 'unavailable') return 'GBrain core reading unavailable.';
  const status = String(live?.health?.status || '').toLowerCase();
  const score = core.quality?.value;
  if (typeof score === 'number' && Number.isFinite(score) && score < HEALTHY_SCORE) return `GBrain's quality score is ${score}/100.`;
  if (status && status !== 'healthy' && status !== 'unknown') return `GBrain's own health check reports ${status}.`;
  return 'Some GBrain core readings were not reported.';
}
/** The sole aggregate verdict. Every HTTP consumer transports this result unchanged. */
function buildGBrainVerdict({ core, sources, sourcesState, queue, readers, readersState, live, probes = {}, legacyOverview }) {
  const reasons = [];
  function add(elementId, state, text, { info = false } = {}) {
    reasons.push({ elementId, state, text, kind: state === 'inactive' || info ? 'info' : 'action' });
  }
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
  if (m.embedJobProbeUnavailable === true) add('embed-job-probe', 'unavailable', EMBED_JOB_PROBE_TEXT, { info: true });
  if (m.missingEmbeddingsUnavailable === true) add('missing-embeddings', 'unavailable', 'Missing-embedding count unavailable.');
  if (m.stalePagesUnavailable === true) add('stale-pages', 'unavailable', 'Stale-page count unavailable.');
  // The core line is only worth a line when it says something no other reason does: a reason that
  // already names the cause at the same severity or worse makes it a restatement. The state is
  // the same either way (the core's own state is counted below, line or no line).
  if (core.state !== 'healthy') {
    const explained = reasons.some((r) => CORE_CAUSE_IDS.has(r.elementId) && r.state !== 'inactive'
      && stateRank(r.state) >= stateRank(core.state));
    if (!explained) add('gbrain-core', core.state, coreCauseText(core, live));
  }
  for (const group of sources) for (const s of group.items) {
    if (s.state === 'inactive') add(s.id, 'inactive', `${s.label}: ${s.reason}.`);
    else if (s.state === 'warning') add(s.id, 'warning', `${s.label}: ${s.reason || 'source evidence is stale'}.`);
  }
  if (sourcesState === 'unavailable' && !reasons.some((r) => r.elementId === 'gbrain.sources')) add('sources', sourcesState, 'Source inventory unavailable.');
  if (!['healthy', 'inactive'].includes(queue.state)) add('queue', queue.state,
    queue.state === 'unavailable' ? 'Queue reading unavailable.' : 'Queue requires attention.');
  // Readers that are set up are one line: their connections cannot be read from here, and that is
  // a fact about this machine, not about each reader. A reader that is not set up, or has a real
  // state, keeps its own line.
  const setUp = [];
  for (const r of readers) {
    if (r.state === 'healthy') continue;
    if (r.state === 'inactive' && r.observation === 'configured') setUp.push(r.label);
    else add(r.id, r.state, r.state === 'inactive' ? `${r.label}: integration not configured.` : `${r.label}: integration ${r.state}.`);
  }
  if (setUp.length) {
    add('readers', 'inactive', `${listNames(setUp)} ${setUp.length === 1 ? 'is' : 'are'} set up. Live connections can't be read from this machine.`);
  }
  if (readersState === 'unavailable' && !readers.length) add('readers', readersState, 'Reader integration reading unavailable.');
  // Inactive reasons and information (a limitation of the reading, not a fault) are listed but never
  // degrade the verdict: the state follows the core and the reasons that ask for action.
  const counted = [core.state, ...reasons.filter((r) => r.kind !== 'info').map((r) => r.state)].filter((state) => state !== 'inactive');
  return { state: worstState(['healthy', ...counted]), reasons };
}
module.exports = { buildGBrainVerdict, verdictCaveats, isGBrainVerdict, EMBED_JOB_PROBE_TEXT };
