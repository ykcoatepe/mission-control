'use strict';
const { createSource, SourceReadError } = require('../../core/source');
const { isNextRunOverdue, isNextRunDue } = require('./overdue');
const { cronKey } = require('../mloop/attention');
const { stateRank } = require('../../core/state');

const AUTOMATIONS_REFRESH_INTERVAL_MS = 30_000;

// Match the page/sidebar normalizeCronStatus rule; unknown history is not
// evidence of a failed last run.
function isFailedJob(job) {
  return Boolean(job?.enabled) && ['failed', 'error', 'errored'].includes(String(job.status || '').trim().toLowerCase());
}

// acks (optional): the attention ack store. A failed job whose
// acknowledgement holds is standing, not failed (badge rule).
function cronAckItem(job) {
  return { key: cronKey(job?.id), rank: stateRank('warning'), count: 1 };
}

function summarizeJobs(jobs, nowMs, { acks = null } = {}) {
  const enabled = jobs.filter(job => job.enabled);
  const nextRuns = enabled.map(job => job.nextRun)
    .filter(value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && Date.parse(value) > nowMs)
    .sort((a, b) => Date.parse(a) - Date.parse(b));
  const failedJobs = enabled.filter(isFailedJob);
  const standing = acks ? failedJobs.filter(job => cronAckItem(job).key && acks.resolve(cronAckItem(job)).holds).length : 0;
  return {
    active: enabled.length,
    paused: jobs.length - enabled.length,
    failed: failedJobs.length - standing,
    standingFailed: standing,
    nextRunAt: nextRuns[0] || null,
    definitions: {
      active: 'Counts every enabled job, including enabled jobs whose last run failed.',
      failed: 'Enabled jobs whose last run failed and that are not acknowledged or shelved; a subset of active.',
      standingFailed: 'Enabled jobs whose last run failed and that are acknowledged or shelved.',
    },
  };
}

// The cron list as routes show it: every job carries ackKey (cron:<job id>)
// and ack (null | { kind, at, until }); summary.failed / standingFailed split
// by the acknowledgements. Pure: the summary's other fields are kept.
function projectCronAcks(cron, acks = null) {
  if (!cron || !Array.isArray(cron.jobs)) return cron;
  const jobs = cron.jobs.map((job) => {
    const item = cronAckItem(job);
    let ack = null;
    if (acks && item.key) ack = isFailedJob(job) ? acks.resolve(item).ack : acks.peek(item.key);
    return { ...job, ackKey: item.key, ack };
  });
  const failedJobs = jobs.filter(isFailedJob);
  const standing = failedJobs.filter(job => job.ack !== null).length;
  const summary = cron.summary && typeof cron.summary === 'object'
    ? {
      ...cron.summary,
      failed: failedJobs.length - standing,
      standingFailed: standing,
      definitions: { ...cron.summary.definitions, ...summarizeJobs([], 0).definitions },
    }
    : cron.summary;
  return { ...cron, jobs, summary };
}

function createAutomationSource({ cronService, now = Date.now, logger } = {}) {
  const observedRuns = new Map();
  function preserveObservedRuns(jobs) {
    const present = new Set(jobs.map(job => job.id));
    for (const id of observedRuns.keys()) if (!present.has(id)) observedRuns.delete(id);
    return jobs.map(job => {
      job = { ...job, nextRunOverdue: isNextRunOverdue(job.enabled, job.nextRun, now()), nextRunDue: isNextRunDue(job.enabled, job.nextRun, now()) };
      const known = observedRuns.get(job.id);
      if (known && !(Date.parse(job.lastRun) >= Date.parse(known.lastRun))) {
        return { ...job, lastRun: known.lastRun, history: known.history,
          status: job.enabled === false ? 'disabled' : known.status === 'disabled' ? 'unknown' : known.status };
      }
      if (Number.isFinite(Date.parse(job.lastRun)) && (!known || Date.parse(job.lastRun) > Date.parse(known.lastRun) || job.enabled !== false)) observedRuns.set(job.id, job);
      return job;
    });
  }
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
        const jobs = evidence.jobs.map(job => cronService.mapCronJobForApi(job)).filter(Boolean);
        const summary = summarizeJobs(jobs, now());
        return { cron: { jobs, summary, schedulers }, evidence };
      } catch {
        throw new SourceReadError('Automation sources could not be refreshed', { code: 'automations_unavailable' });
      }
    },
  });
  const snapshot = source.snapshot;
  source.projectJobs = (data, jobs) => {
    jobs = preserveObservedRuns(jobs);
    return { ...data, cron: { ...data?.cron, jobs, summary: summarizeJobs(jobs, now()) } };
  };
  source.snapshot = () => {
    const stored = snapshot();
    // A next-run can expire between scheduled reads, including while serving
    // last-good evidence. Project its summary against the clock without IO.
    const snap = stored.data ? { ...stored, data: source.projectJobs(stored.data, stored.data.cron.jobs) } : stored;
    const proofs = Object.values(snap.data?.cron.schedulers || {});
    if (proofs.some(p => !p.sourceSucceeded || p.stale)) {
      return { ...snap, meta: { ...snap.meta, ok: false, stale: true, error: snap.meta.error || { code: 'scheduler_stale', message: 'One or more scheduler readings are unavailable or cached' } } };
    }
    return snap;
  };
  const refresh = source.refresh;
  source.refresh = async () => { await refresh(); return source.snapshot(); };
  const status = source.status;
  source.readState = status;
  source.nowMs = now;
  source.status = () => {
    const state = status();
    const { ok, stale, error } = source.snapshot().meta;
    return { ...state, ok, stale, error };
  };
  return source;
}
module.exports = { createAutomationSource, AUTOMATIONS_REFRESH_INTERVAL_MS, isFailedJob, projectCronAcks, summarizeJobs };
