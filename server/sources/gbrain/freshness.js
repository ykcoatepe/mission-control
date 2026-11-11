'use strict';
const { sourceFreshnessStatus } = require('../../routes/gbrain/liveProbes');
const { deriveState, stateOf } = require('./state');

// Preserve the existing policy decision after raw local paths have been discarded.
function classifySource(source, snapshot, now = Date.now) {
  const freshness = sourceFreshnessStatus(source, source.lastSyncAt, new Date(now()).toISOString());
  const excludedByPolicy = freshness.syncTracked === false;
  const reason = excludedByPolicy
    ? source.syncEnabled === false ? 'sync disabled' : 'not sync-tracked'
    : !freshness.lastSyncAt ? 'never synced'
    : freshness.status === 'warning' ? `sync age exceeds ${freshness.thresholdHours}h threshold` : null;
  return { freshness, excludedByPolicy, reason,
    state: excludedByPolicy ? deriveState({ observed: true, inactive: true })
      : stateOf(snapshot, { warning: freshness.status === 'warning' }) };
}
module.exports = { classifySource };
