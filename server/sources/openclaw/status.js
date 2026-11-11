'use strict';

// Worked example of the source pattern (see server/core/README.md).
//
// The OpenClaw status/heartbeat read: `openclaw status` and
// `openclaw system heartbeat last --json` on the serialized `openclaw` exec
// lane, refreshed by the scheduler, held as last-good data. GET /api/status
// composes from memory and never starts a process.

const { createSource } = require('../../core/source');

const STATUS_SOURCE_ID = 'openclaw.status';
const STATUS_REFRESH_INTERVAL_MS = 45_000;

function createOpenclawStatusSource({ statusService, now = Date.now, logger = null } = {}) {
  if (typeof statusService?.readObservedStatus !== 'function') {
    throw new TypeError('createOpenclawStatusSource: statusService.readObservedStatus required');
  }
  return createSource({
    id: STATUS_SOURCE_ID,
    // Throws unless the status CLI was actually observed, so a failed
    // refresh keeps the previous payload (stale) instead of replacing it
    // with parser defaults.
    read: () => statusService.readObservedStatus(),
    ttlMs: 60_000,
    // status (15 s) + heartbeat (10 s) + sessions budget, serialized on the
    // openclaw lane, plus lane wait.
    timeoutMs: 60_000,
    staleAfterMs: 3 * 60_000,
    now,
    logger,
  });
}

module.exports = {
  createOpenclawStatusSource,
  STATUS_SOURCE_ID,
  STATUS_REFRESH_INTERVAL_MS,
};
