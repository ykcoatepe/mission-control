'use strict';

/** @typedef {'healthy'|'warning'|'critical'|'unavailable'|'inactive'} EvidenceState */
/** All synoptic states pass through this function. Failure takes precedence over inactivity. */
function deriveState({ observed = false, failed = false, inactive = false, critical = false,
  warning = false, stale = false, ageMs = null, staleAfterMs = Infinity } = {}) {
  if (failed || !observed) return 'unavailable';
  if (stale || (ageMs !== null && ageMs > staleAfterMs)) return 'warning';
  if (inactive) return 'inactive';
  if (critical) return 'critical';
  if (warning) return 'warning';
  return 'healthy';
}
function stateOf(snapshot, flags = {}) {
  return deriveState({ observed: snapshot?.data != null, failed: Boolean(snapshot?.meta?.error),
    stale: snapshot?.meta?.stale === true, ...flags });
}
module.exports = { deriveState, stateOf };
