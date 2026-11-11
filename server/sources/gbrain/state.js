'use strict';

/** @typedef {'healthy'|'warning'|'critical'|'unavailable'|'inactive'} EvidenceState */
/**
 * All synoptic states pass through this function. One ordering everywhere
 * (server/core/state.js, shared with Operations and the frontend):
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
// The ordering itself lives in server/core/state.js.
const { STATE_RANK, worstState } = require('../../core/state');
function stateOf(snapshot, flags = {}) {
  return deriveState({ observed: snapshot?.data != null, failed: Boolean(snapshot?.meta?.error),
    stale: snapshot?.meta?.stale === true, ...flags });
}
module.exports = { deriveState, stateOf, worstState, STATE_RANK };
