'use strict';

/** @typedef {'healthy'|'warning'|'critical'|'unavailable'|'inactive'} EvidenceState */
/**
 * All synoptic states pass through this function. One ordering everywhere
 * (frontend/src/lib/state.ts worstState, Operations STATE_RANK):
 * critical > warning > unavailable > healthy > inactive. Nothing read at all
 * is unavailable (absence of evidence is not green); otherwise a condition
 * that was observed (critical, warning) outranks a failed or stale read,
 * which in turn outranks healthy and inactive.
 */
function deriveState({ observed = false, failed = false, inactive = false, critical = false,
  warning = false, stale = false, ageMs = null, staleAfterMs = Infinity } = {}) {
  if (!observed) return 'unavailable';
  if (critical) return 'critical';
  if (warning) return 'warning';
  if (failed) return 'unavailable';
  if (stale || (ageMs !== null && ageMs > staleAfterMs)) return 'warning';
  if (inactive) return 'inactive';
  return 'healthy';
}
const STATE_RANK = Object.freeze({ inactive: 0, healthy: 1, unavailable: 2, warning: 3, critical: 4 });
/** Worst of several states by the one ordering; an empty list was not read. */
function worstState(states) {
  const list = states.filter((s) => s in STATE_RANK);
  if (!list.length) return 'unavailable';
  return list.reduce((worst, s) => (STATE_RANK[s] > STATE_RANK[worst] ? s : worst));
}
function stateOf(snapshot, flags = {}) {
  return deriveState({ observed: snapshot?.data != null, failed: Boolean(snapshot?.meta?.error),
    stale: snapshot?.meta?.stale === true, ...flags });
}
module.exports = { deriveState, stateOf, worstState, STATE_RANK };
