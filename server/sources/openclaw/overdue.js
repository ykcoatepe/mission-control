'use strict';

// A scheduler fires on its own tick and a run takes time to be recorded, so a
// next-run that passed moments ago is "due now", not overdue. Only a job that
// is still waiting after this window is evidence the scheduler missed it.
const NEXT_RUN_GRACE_MS = 5 * 60_000;

function isNextRunOverdue(enabled, nextRun, nowMs) {
  if (enabled !== true) return false;
  const due = Date.parse(nextRun);
  return Number.isFinite(due) && due + NEXT_RUN_GRACE_MS <= nowMs;
}

// Past its time but still inside the grace window: about to run.
function isNextRunDue(enabled, nextRun, nowMs) {
  if (enabled !== true) return false;
  const due = Date.parse(nextRun);
  return Number.isFinite(due) && due <= nowMs && !isNextRunOverdue(enabled, nextRun, nowMs);
}

module.exports = { NEXT_RUN_GRACE_MS, isNextRunOverdue, isNextRunDue };
