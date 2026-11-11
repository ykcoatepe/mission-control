'use strict';
const { createSource, SourceReadError } = require('../../core/source');
const CALENDAR_REFRESH_INTERVAL_MS = 30_000;

function createCalendarSource({ cronService, automationSource, now = Date.now, logger } = {}) {
  const source = createSource({
    id: 'openclaw.calendar', now, logger,
    ttlMs: CALENDAR_REFRESH_INTERVAL_MS, timeoutMs: 10_000, staleAfterMs: 90_000,
    read() {
      try {
        const current = cronService.readCalendarDataSafe({ strict: true, tolerateEntries: true });
        // Quarantine is a read projection. Preserve every physical row for
        // correction; never rewrite a file whose rows were excluded.
        if (current.diagnostics?.quarantined.count || current.diagnostics?.duplicates.count) return current;
        const cron = automationSource.snapshot();
        const evidence = cron.data?.evidence;
        const freshSchedulers = Object.values(evidence?.operationsSource?.schedulers || {}).some(proof => proof.sourceSucceeded && !proof.stale);
        const currentCron = cron.data && cron.meta.ageMs <= 90_000
          && (!cron.meta.error || cron.meta.error.code === 'scheduler_stale');
        if (!currentCron || !freshSchedulers) {
          return { ...current, sync: { ok: false, error: { code: 'calendar_scheduler_unavailable', message: 'Waiting for current scheduler evidence' } } };
        }
        const synced = cronService.syncCalendarWithCronEvidence(evidence);
        const partial = cron.meta.stale || Object.values(evidence.operationsSource.schedulers).some(proof => !proof.sourceSucceeded || proof.stale);
        const error = partial ? { code: 'calendar_scheduler_stale', message: 'Unavailable scheduler rows were retained from last-good calendar data' } : null;
        return { ...synced, diagnostics: current.diagnostics, sync: { ok: !partial, error } };
      } catch {
        throw new SourceReadError('Calendar data could not be refreshed safely', { code: 'calendar_unavailable' });
      }
    },
  });
  const snapshot = source.snapshot;
  source.snapshot = () => {
    const snap = snapshot();
    // Preserve a failed read's error even if its last-good payload was partial.
    if (snap.meta.error || !snap.data) return snap;
    const diagnostics = snap.data.diagnostics;
    const error = diagnostics?.quarantined.count
      ? { code: 'calendar_entries_quarantined', message: 'Malformed calendar entries were quarantined; the file was preserved' }
      : diagnostics?.duplicates.count
        ? { code: 'calendar_duplicate_ids', message: 'Duplicate calendar IDs were found; only their first row is served' }
        : snap.data.sync?.error;
    return error ? { ...snap, meta: { ...snap.meta, ok: false, stale: true, error } } : snap;
  };
  const refresh = source.refresh;
  source.refresh = async () => { await refresh(); return source.snapshot(); };
  const status = source.status;
  source.status = () => ({ ...status(), ...source.snapshot().meta, id: source.id });
  return source;
}

module.exports = { createCalendarSource, CALENDAR_REFRESH_INTERVAL_MS };
