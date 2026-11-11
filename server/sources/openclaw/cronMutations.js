'use strict';
const { publishMutation } = require('./writeThrough');

function newestRun(job, known) {
  const floor = Date.parse(known?.lastRun);
  if (!Number.isFinite(floor) || Date.parse(job?.lastRun) >= floor) return job;
  return { ...job, lastRun: known.lastRun, history: known.history,
    status: job.enabled === false ? 'disabled' : known.status };
}

async function commitCronMutation({ source, cronService, scheduler, sourceId, operation, rawJob, patch = {} }) {
  const before = source?.snapshot()?.data;
  const rows = before?.cron?.jobs || [];
  rawJob = rawJob?.job || rawJob;
  sourceId ||= rawJob?.id;
  const id = sourceId ? `${scheduler}:${sourceId}` : null;
  const matches = job => job && (job.id === id || (job.scheduler === scheduler && String(job.sourceId ?? job.id) === String(sourceId)));
  const previous = rows.find(matches);
  const previousRaw = before?.evidence?.jobs?.find(job => job && (job.scheduler || 'openclaw') === scheduler && String(job.sourceId ?? job.id) === String(sourceId));
  const priorExecution = previousRaw?.state || {};
  const reportedExecution = rawJob?.state || {};
  const execution = typeof reportedExecution.lastRunAtMs === 'number'
    && reportedExecution.lastRunAtMs >= (priorExecution.lastRunAtMs ?? -Infinity) ? reportedExecution : priorExecution;
  const observed = rawJob?.id && cronService.mapCronJobForApi ? cronService.mapCronJobForApi({ ...rawJob, scheduler, sourceId }) : null;
  const baseline = newestRun({ ...previous, ...observed }, previous);
  const known = newestRun({ ...baseline, ...patch, id, sourceId, scheduler }, previous);
  if (operation === 'run') known.lastRunRequestedAt = new Date().toISOString();
  if (known.enabled === false) known.status = 'disabled';
  else if (patch.enabled === true) known.status = cronService.normalizeCronRunStatus?.({ ...previousRaw, ...rawJob, enabled: true }) || 'idle';
  const deleted = operation === 'delete';
  const prefix = `cron:${id || 'unidentified-create'}:`;
  const fact = (factPatch, key) => ({
    key: prefix + key,
    ...(['create', 'delete'].includes(operation) ? { removePrefix: prefix } : {}),
    apply(data) {
      let jobs = Array.isArray(data?.cron?.jobs) ? data.cron.jobs : rows;
      const current = jobs.find(matches);
      const updated = newestRun({ ...known, ...current, ...factPatch }, known);
      if (Object.hasOwn(factPatch, 'enabled')) updated.status = factPatch.enabled ? known.status : 'disabled';
      if (operation === 'run') updated.lastRunRequestedAt = known.lastRunRequestedAt;
      if (deleted) jobs = jobs.filter(job => !matches(job));
      else if (id) jobs = jobs.filter(job => !matches(job)).concat(updated);
      let evidenceJobs = Array.isArray(data?.evidence?.jobs) ? data.evidence.jobs : before?.evidence?.jobs || [];
      const rawMatch = job => job && (job.scheduler || 'openclaw') === scheduler && String(job.sourceId ?? job.id) === String(sourceId);
      const rawCurrent = evidenceJobs.find(rawMatch) || previousRaw || rawJob || {};
      const raw = { ...rawCurrent, id: sourceId, sourceId, scheduler };
      if (operation === 'create') Object.assign(raw, rawJob);
      if (Object.hasOwn(factPatch, 'enabled')) raw.enabled = factPatch.enabled;
      for (const field of ['model', 'thinking']) if (Object.hasOwn(factPatch, field)) raw.payload = { ...raw.payload, [field]: factPatch[field] };
      if (updated.lastRun && !(typeof raw.state?.lastRunAtMs === 'number' && Number.isFinite(raw.state.lastRunAtMs) && raw.state.lastRunAtMs >= Date.parse(updated.lastRun))) {
        raw.state = { ...raw.state, lastRunAtMs: Date.parse(updated.lastRun),
          // Paused/disabled is a presentation state, never a run outcome.
          lastStatus: execution.lastStatus ?? execution.lastRunStatus ?? raw.state?.lastStatus };
      }
      if (deleted) evidenceJobs = evidenceJobs.filter(job => !rawMatch(job));
      else if (id) evidenceJobs = evidenceJobs.filter(job => !rawMatch(job)).concat(raw);
      const projected = source?.projectJobs ? source.projectJobs(data, jobs) : { ...data, cron: { ...data?.cron, jobs } };
      return { ...projected, evidence: { ...data?.evidence, jobs: evidenceJobs, operationsSource: data?.evidence?.operationsSource || before?.evidence?.operationsSource } };
    },
    confirmed(data) {
      const actual = data?.cron?.jobs?.find(matches);
      if (!id) return false;
      if (deleted) return Array.isArray(data?.cron?.jobs) && !actual;
      if (!actual || Object.entries(factPatch).some(([field, value]) => actual[field] !== value)) return false;
      const floor = Date.parse(known.lastRun);
      if (Number.isFinite(floor) && !(Date.parse(actual.lastRun) >= floor)) return false;
      if (operation === 'run' && !(Date.parse(actual.lastRun) > (Date.parse(previous?.lastRun) || 0))) return false;
      return true;
    },
  });
  const mutations = ['create', 'delete'].includes(operation) ? [fact(patch, 'exists')]
    : Object.entries(patch).map(([field, value]) => fact({ [field]: value }, field));
  if (operation === 'run' || Number.isFinite(Date.parse(known.lastRun))) mutations.push(fact({}, 'lastRun'));
  const snap = await publishMutation(source, mutations.length ? mutations : [fact({}, 'unknown')]);
  return { job: deleted ? { ...known, deleted: true } : snap.data?.cron?.jobs?.find(matches) || known, meta: snap.meta };
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
      const derived = mutation.operation === 'delete' || !raw ? []
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
