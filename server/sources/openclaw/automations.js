'use strict';
const { createSource, SourceReadError } = require('../../core/source');

const AUTOMATIONS_REFRESH_INTERVAL_MS = 30_000;

function summarizeJobs(jobs, nowMs) {
  const enabled = jobs.filter(job => job.enabled);
  const nextRuns = enabled.map(job => job.nextRun)
    .filter(value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && Date.parse(value) > nowMs)
    .sort((a, b) => Date.parse(a) - Date.parse(b));
  return {
    active: enabled.length,
    paused: jobs.length - enabled.length,
    // Match the page/sidebar normalizeCronStatus rule; unknown history is
    // not evidence of a failed last run.
    failed: enabled.filter(job => ['failed', 'error', 'errored'].includes(String(job.status || '').trim().toLowerCase())).length,
    nextRunAt: nextRuns[0] || null,
  };
}

function createAutomationSource({ cronService, now = Date.now, logger } = {}) {
  const source = createSource({
    id: 'openclaw.automations', now, logger,
    ttlMs: AUTOMATIONS_REFRESH_INTERVAL_MS, timeoutMs: 60_000,
    staleAfterMs: 90_000,
    async read() {
      try {
        const evidence = await cronService.fetchCronJobsForOperations();
        const schedulers = evidence?.operationsSource?.schedulers;
        if (!Array.isArray(evidence?.jobs) || !schedulers || !Object.values(schedulers).some(p => p.sourceSucceeded)) {
          throw new Error('No scheduler observed');
        }
        const jobs = evidence.jobs.map(job => cronService.mapCronJobForApi(job));
        const summary = summarizeJobs(jobs, now());
        const calendar = cronService.syncCalendarWithCronEvidence(evidence);
        return { cron: { jobs, summary, schedulers }, calendar };
      } catch {
        throw new SourceReadError('Automation sources could not be refreshed', { code: 'automations_unavailable' });
      }
    },
  });
  const snapshot = source.snapshot;
  source.snapshot = () => {
    const stored = snapshot();
    // A next-run can expire between scheduled reads, including while serving
    // last-good evidence. Project its summary against the clock without IO.
    const snap = stored.data ? { ...stored, data: { ...stored.data, cron: {
      ...stored.data.cron, summary: summarizeJobs(stored.data.cron.jobs, now()),
    } } } : stored;
    const proofs = Object.values(snap.data?.cron.schedulers || {});
    if (proofs.some(p => !p.sourceSucceeded || p.stale)) {
      return { ...snap, meta: { ...snap.meta, ok: false, stale: true, error: snap.meta.error || { code: 'scheduler_stale', message: 'One or more scheduler readings are unavailable or cached' } } };
    }
    return snap;
  };
  const refresh = source.refresh;
  source.refresh = async () => { await refresh(); return source.snapshot(); };
  const status = source.status;
  source.status = () => {
    const state = status();
    const { ok, stale, error } = source.snapshot().meta;
    return { ...state, ok, stale, error };
  };
  return source;
}
module.exports = { createAutomationSource, AUTOMATIONS_REFRESH_INTERVAL_MS };
