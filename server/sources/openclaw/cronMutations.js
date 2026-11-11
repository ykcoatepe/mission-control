'use strict';
const { publishMutation } = require('./writeThrough');
const { httpError } = require('../../core/http');
const { redactString } = require('../../core/config');

function readStartedAfter(proof, observation) {
  // A new source refresh may join a probe that predates the write. Its source
  // generation/completion time says nothing about when upstream was read.
  return Number.isFinite(proof?.readStartedAtMs) && proof.readStartedAtMs >= observation.atMs
    && Number.isSafeInteger(proof.readStartedOrder) && proof.readStartedOrder > observation.order;
}

function freshReadingAfter(source, generation, scheduler, data, meta, observation) {
  const proof = data?.cron?.schedulers?.[scheduler];
  return (!meta?.error || meta.error.code === 'scheduler_stale')
    && (source?.readState?.().reads ?? source?.status?.().reads ?? 0) > generation && proof?.sourceSucceeded === true
    && !proof.stale && !Object.hasOwn(proof, 'cacheAgeMs') && readStartedAfter(proof, observation);
}

async function publishObserved(source, cronService, scheduler, rawJobs) {
  const generation = source?.readState?.().reads ?? source?.status?.().reads ?? 0;
  const observedAtMs = source?.nowMs?.() ?? Date.now();
  const observation = cronService.markCronObservation?.() || { atMs: observedAtMs, order: Infinity };
  const at = new Date(observedAtMs).toISOString();
  const before = source?.snapshot()?.data;
  rawJobs = rawJobs.map(job => {
    if (!job._verificationMetadataOnly) return job;
    const prior = before?.evidence?.jobs?.find(row => (row.scheduler || 'openclaw') === scheduler && String(row.sourceId ?? row.id) === String(job.sourceId ?? job.id));
    const instructionKnown = typeof prior?.prompt === 'string' || typeof prior?.payload?.text === 'string'
      || (typeof prior?.payload?.message === 'string' && prior.payload.message.length > 0);
    return { ...prior, ...job, ...(prior?.sessionTarget ? { sessionTarget: prior.sessionTarget } : {}),
      payload: { ...prior?.payload, model: job.payload?.model }, _verificationInstructionsKnown: instructionKnown };
  });
  const proof = { sourceSucceeded: true, provenance: `${scheduler}-write-readback`, observedAt: at };
  const schedulers = { ...before?.cron?.schedulers, [scheduler]: proof };
  const allCurrent = Object.values(schedulers).every(item => item.sourceSucceeded && !item.stale);
  const mapped = rawJobs.map(job => cronService.mapCronJobForApi(job)).filter(Boolean);
  function replaceScheduler(rows, replacement) {
    const result = []; let inserted = false;
    for (const row of rows) {
      if ((row.scheduler || 'openclaw') !== scheduler) result.push(row);
      else if (!inserted) { result.push(...replacement); inserted = true; }
    }
    if (!inserted) result.push(...replacement);
    return result;
  }
  return publishMutation(source, {
    key: `cron-observed:${scheduler}`, removePrefix: `cron:${scheduler}:`, observed: true,
    meta(base) {
      const state = source?.readState?.();
      const proof = base.data?.cron?.schedulers?.[scheduler];
      const ageMs = Math.max(0, (source?.nowMs?.() ?? Date.now()) - observedAtMs);
      const laterUnavailable = (state?.reads ?? generation) > generation
        && (base.meta?.error || !proof?.sourceSucceeded || proof.stale || Object.hasOwn(proof, 'cacheAgeMs') || !readStartedAfter(proof, observation));
      const stale = !allCurrent || Boolean(laterUnavailable) || ageMs > (state?.staleAfterMs ?? 90000);
      return { ok: !stale, stale, observedAt: at, ageMs, verified: true,
        error: laterUnavailable && base.meta?.error ? base.meta.error : stale ? { code: 'scheduler_stale', message: 'Current scheduler confirmation is unavailable' } : null };
    },
    apply(data) {
      const jobs = replaceScheduler(data?.cron?.jobs || [], mapped);
      const projected = source?.projectJobs ? source.projectJobs(data, jobs) : { ...data, cron: { ...data?.cron, jobs } };
      return { ...projected, cron: { ...projected.cron, schedulers }, evidence: {
        ...data?.evidence, jobs: replaceScheduler(data?.evidence?.jobs || [], rawJobs),
        operationsSource: { ...data?.evidence?.operationsSource, sourceSucceeded: true, provenance: 'scheduler-readers', observedAt: at, schedulers },
      } };
    },
    confirmed: (data, meta) => freshReadingAfter(source, generation, scheduler, data, meta, observation),
  }, { refresh: false });
}

async function commitCronMutation({ source, cronService, scheduler, sourceId, operation, rawJob, patch = {}, beforeRun, createJob, expectedBaseUrl }) {
  const before = source?.snapshot()?.data;
  const commandJob = rawJob?.job || rawJob;
  sourceId ||= commandJob?.id;
  const id = sourceId ? `${scheduler}:${sourceId}` : null;
  const previous = before?.cron?.jobs?.find(job => job.id === id);
  let rawJobs;
  try {
    if (typeof cronService.readCronJobsForVerification !== 'function') throw Object.assign(new Error('Read-back unavailable'), { code: 'upstream_read_failed' });
    rawJobs = await cronService.readCronJobsForVerification(scheduler);
  }
  catch (error) {
    if (error.code !== 'upstream_read_failed') throw error;
    const generation = source?.status?.().reads ?? 0;
    const observation = cronService.markCronObservation?.() || { atMs: source?.nowMs?.() ?? Date.now(), order: Infinity };
    const job = { ...previous, id, sourceId, scheduler, verified: false };
    const snap = await publishMutation(source, {
      key: `cron:${id}:verification`, meta: { verified: false },
      apply: data => ({ ...data, cron: { ...data?.cron,
        jobs: (data?.cron?.jobs || []).map(row => row.id === id ? { ...row, verified: false } : row) } }),
      confirmed: (data, meta) => freshReadingAfter(source, generation, scheduler, data, meta, observation),
    }, { refresh: false });
    return { job, verified: false, observed: false, requested: patch, meta: { ...snap.meta, stale: true } };
  }
  const snap = await publishObserved(source, cronService, scheduler, rawJobs);
  const actualRaw = rawJobs.find(job => String(job.sourceId ?? job.id) === String(sourceId));
  const actual = actualRaw ? cronService.mapCronJobForApi(actualRaw) : null;
  let matches = !!actual && Object.entries(patch).every(([field, value]) => actual[field] === value);
  if (scheduler === 'hermes' && expectedBaseUrl !== undefined) matches &&= (actualRaw?.base_url || null) === expectedBaseUrl;
  if (operation === 'delete') matches = !actual && !!sourceId;
  if (operation === 'create') {
    const schedule = actualRaw?.schedule, requested = createJob?.schedule;
    const scheduleMatches = schedule?.kind === requested?.kind && (requested?.kind === 'cron' ? schedule.expr?.trim() === requested.expr.trim()
      : requested?.kind === 'every' ? schedule.everyMs === requested.everyMs
        : requested?.kind === 'at' && Date.parse(schedule.at) === Date.parse(requested.at));
    const message = createJob?.payload?.text ?? createJob?.payload?.message;
    const actualMessage = actualRaw?.payload?.text ?? actualRaw?.payload?.message;
    matches = !!actual && matches && scheduleMatches && actualRaw?.payload?.kind === createJob?.payload?.kind && actualMessage === message
      && actualRaw.sessionTarget === (createJob?.sessionTarget || 'isolated');
  }
  if (operation === 'run') {
    const previousRun = beforeRun?.state?.lastRunAtMs ?? Date.parse(previous?.lastRun);
    matches = !!actual && ((Number.isFinite(actualRaw.state?.lastRunAtMs) && actualRaw.state.lastRunAtMs > (previousRun || 0))
      || (Number.isFinite(actualRaw.state?.runningAtMs) && actualRaw.state.runningAtMs > (beforeRun?.state?.runningAtMs || 0)));
  }
  const displayed = snap.data?.cron?.jobs?.find(row => row.scheduler === scheduler && String(row.sourceId) === String(sourceId));
  const job = actual ? { ...(displayed || actual), verified: true } : { id, sourceId, scheduler, deleted: true, verified: true };
  let error = null;
  const invalidMetadata = actualRaw && (typeof actualRaw.enabled !== 'boolean'
    || [actualRaw.payload?.model, actualRaw.payload?.thinking, actualRaw.model, actualRaw.provider, actualRaw.base_url]
      .some(value => value != null && typeof value !== 'string')
    || ['lastRunAtMs', 'runningAtMs', 'nextRunAtMs'].some(field => {
      const value = actualRaw.state?.[field];
      return value != null && (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > 8.64e15);
    }));
  if (invalidMetadata) error = httpError(409, 'upstream_unverified', `${scheduler} reports invalid job metadata`);
  else if (!sourceId) error = httpError(409, 'upstream_unverified', `${scheduler} did not return an identifiable job`);
  else if (!matches) {
    const fields = actual ? `enabled=${actual.upstreamEnabled ?? actual.enabled}, state=${actual.schedulerState || actual.status}`
      + (scheduler === 'hermes' ? `, paused_at=${actual.pausedAt || '(unset)'}` : '')
      + (operation === 'edit' ? `, model=${actual.model || '(unset)'}, thinking=${actual.thinking || '(unset)'}` : '')
      + (operation === 'create' ? `, schedule=${actual.schedule || '(unknown)'}` : '')
      + (operation === 'run' ? `, lastRun=${actual.lastRun || '(unknown)'}` : '') : 'job missing';
    const reason = actual?.pausedReason ? `; ${actual.pausedReason}` : '';
    error = httpError(409, 'upstream_rejected', `${scheduler} reports ${redactString(fields + reason).slice(0, 350)}; requested change was not observed`);
  }
  return { job, verified: !error, observed: true, meta: snap.meta, ...(error ? { verificationError: error } : {}) };
}
module.exports = { commitCronMutation };

// Dependent projections use the same committed scheduler facts. Refreshes may
// lag, but cannot resurrect a deleted job or hide its newly saved fields.
async function publishCronDependents({ source, calendarSource, operationsSource, cronService, mutation, result }) {
  const snapshots = [];
  if (operationsSource) snapshots.push(await publishMutation(operationsSource, {
    key: 'cron:committed-view',
    apply() {
      const current = source.snapshot().data;
      return { jobs: current.cron.jobs, operationsSource: current.evidence.operationsSource };
    },
    confirmed: data => Array.isArray(data?.jobs) && source.snapshot().data.cron.jobs.every(job => {
      const actual = data.jobs.find(row => row.id === job.id);
      return actual && ['enabled', 'model', 'thinking', 'lastRun'].every(field => actual[field] === job[field]);
    }) && data.jobs.length === source.snapshot().data.cron.jobs.length,
  }));
  if (calendarSource && cronService.mergeCalendarEntriesWithCronJobs) {
    const id = result.job?.id;
    const raw = source.snapshot().data?.evidence?.jobs?.find(job => (job.scheduler || 'openclaw') === mutation.scheduler && String(job.sourceId ?? job.id) === String(result.job.sourceId));
    const at = new Date().toISOString();
    const project = data => {
      const entries = data?.entries || [];
      const existing = entries.filter(entry => entry.source === 'cron' && entry.linkedJobId === id);
      const rest = entries.filter(entry => !existing.includes(entry));
      const derived = result.job?.deleted === true || !raw ? []
        : cronService.mergeCalendarEntriesWithCronJobs({ entries: existing }, [{ ...raw, id }], at).entries;
      return { ...data, entries: cronService.sortCalendarEntries(rest.concat(derived)) };
    };
    snapshots.push(await publishMutation(calendarSource, {
      key: `cron-derived:${id}`,
      apply: project,
      confirmed: data => Array.isArray(data?.entries) && JSON.stringify(project(data).entries.map(entry => [entry.id, entry.title, entry.schedule, entry.status, entry.startsAt, entry.notes]))
        === JSON.stringify(data.entries.map(entry => [entry.id, entry.title, entry.schedule, entry.status, entry.startsAt, entry.notes])),
    }));
  }
  return snapshots;
}
module.exports.publishCronDependents = publishCronDependents;
