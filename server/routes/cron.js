const express = require('express');
const { httpError } = require('../core/http');
const { withWriteThrough } = require('../sources/openclaw/writeThrough');
const { commitCronMutation } = require('../sources/openclaw/cronMutations');
const { parseFirstJson } = require('../services/cronData');

const CRON_MODEL_ALIASES = {
  'local-qwen3.6-35b-a3b-nvfp4': 'ollama/qwen3.6:35b-a3b-nvfp4',
};

function normalizeCronModel(model) {
  const key = String(model || '').trim();
  return CRON_MODEL_ALIASES[key] || key;
}

function parseCronJobRef(id = '', schedulerHint = '') {
  if (schedulerHint && !['openclaw', 'hermes'].includes(schedulerHint)) throw httpError(400, 'invalid_scheduler', 'Invalid scheduler');
  const raw = String(id || '');
  const explicitScheduler = String(schedulerHint || '').trim().toLowerCase();
  const match = raw.match(/^(openclaw|hermes):(.+)$/);
  if (match) return { scheduler: match[1], sourceId: match[2] };
  return { scheduler: explicitScheduler || 'openclaw', sourceId: raw };
}

function assertSafeCronSourceId(sourceId) {
  const value = String(sourceId || '').trim();
  if (!value) throw httpError(400, 'cron_id_required', 'Cron job id is required');
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value)) throw httpError(400, 'invalid_cron_id', 'Invalid cron job id');
  return value;
}

function assertOpenclawCronAction(id, schedulerHint = '') {
  const ref = parseCronJobRef(id, schedulerHint);
  if (ref.scheduler !== 'openclaw') {
    throw httpError(501, 'hermes_cron_read_only', 'Hermes cron jobs are shown read-only in Mission Control for now. Manage them from Hermes Agent.');
  }
  return assertSafeCronSourceId(ref.sourceId);
}

function isUsableCronSnapshot(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.jobs) || snapshot.jobs.length === 0) return false;
  return snapshot.jobs.every((job) => {
    if (!job.scheduler && !job.actions) return true;
    if (job.scheduler === 'hermes') return job.actions?.model === true && job.actions?.toggle === true;
    return true;
  });
}

function hasCronModelPatch(body = {}) {
  return Object.prototype.hasOwnProperty.call(body || {}, 'model') || !!body?.thinking;
}

function validateCreateJob(job) {
  const text = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 32000 && !value.includes('\0') && !value.trimStart().startsWith('-');
  if (!job || !text(job.name) || job.name.length > 256 || !job.schedule) throw httpError(400, 'invalid_job', 'name and schedule required');
  const schedule = job.schedule;
  const valid = schedule.kind === 'cron' ? text(schedule.expr) && [5, 6].includes(schedule.expr.trim().split(/\s+/).length)
    : schedule.kind === 'every' ? Number.isFinite(schedule.everyMs) && schedule.everyMs >= 1000
      : schedule.kind === 'at' && text(schedule.at) && Number.isFinite(Date.parse(schedule.at));
  if (!valid) throw httpError(400, 'invalid_schedule', 'Invalid job schedule');
  if (job.enabled !== undefined && typeof job.enabled !== 'boolean') throw httpError(400, 'invalid_enabled', 'enabled must be a boolean');
  if (job.sessionTarget !== undefined && !['main', 'isolated'].includes(job.sessionTarget)) throw httpError(400, 'invalid_session', 'Invalid session target');
  if (!['agentTurn', 'systemEvent'].includes(job.payload?.kind)) throw httpError(400, 'invalid_payload', 'Invalid payload kind');
  const message = job.payload.kind === 'agentTurn' ? job.payload.message : (job.payload.text || job.payload.message);
  if (!text(message)) throw httpError(400, 'invalid_payload', 'A message or event text is required and cannot start with a dash');
  if (job.payload.model !== undefined && (typeof job.payload.model !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,255}$/.test(job.payload.model))) throw httpError(400, 'invalid_model', 'Invalid model');
}

function buildCronRouter({ cronService, openclawExec, automationSource, afterCronWrite }) {
  const router = express.Router();
  withWriteThrough(automationSource);
  async function committed(mutation) {
    const result = await commitCronMutation({ source: automationSource, cronService, ...mutation });
    if (afterCronWrite) {
      try {
        const dependents = await afterCronWrite({ mutation, result });
        if (dependents?.some(snapshot => snapshot?.meta?.stale)) result.meta = { ...result.meta, ok: false, stale: true, error: { code: 'post_write_refresh_pending', message: 'The write succeeded; dependent readings are catching up' } };
      } catch { result.meta = { ...result.meta, ok: false, stale: true, error: { code: 'post_write_refresh_pending', message: 'The write succeeded; dependent readings are catching up' } }; }
    }
    return result;
  }
  router.get('/api/cron', (req, res) => {
    const snap = automationSource.snapshot();
    if (!snap.data) throw httpError(503, 'automations_unavailable', 'Automation data has not been observed');
    return res.json({ ...snap.data.cron, meta: snap.meta });
  });

  router.post('/api/cron/:id/toggle', async (req, res, next) => {
    try {
      const { id } = req.params;
      const { enabled, scheduler } = req.body || {};
      if (typeof enabled !== 'boolean') throw httpError(400, 'invalid_enabled', 'enabled must be a boolean');
      const ref = parseCronJobRef(id, scheduler);
      if (ref.scheduler === 'hermes') {
        const job = cronService.updateHermesCronJobEnabled(assertSafeCronSourceId(ref.sourceId), enabled !== false);
        const mappedJob = cronService.mapCronJobForApi(job);
        const updated = await committed({ scheduler: 'hermes', sourceId: ref.sourceId, operation: 'toggle', rawJob: job, patch: { enabled } });
        return res.json({ ok: true, message: `Hermes job ${enabled !== false ? 'enabled' : 'disabled'}`, ...updated });
      }
      const sourceId = assertOpenclawCronAction(id, scheduler);
      const command = enabled ? 'enable' : 'disable';
      const { stdout, stderr } = await openclawExec(['cron', command, sourceId], 15000);
      const rawJob = parseFirstJson([stdout, stderr].filter(Boolean).join('\n'));
      const updated = await committed({ scheduler: 'openclaw', sourceId, operation: 'toggle', rawJob, patch: { enabled } });
      return res.json({ ok: true, message: `Job ${enabled ? 'enabled' : 'disabled'}`, ...updated });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/api/cron/:id/run', async (req, res, next) => {
    try {
      const { id } = req.params;
      const sourceId = assertOpenclawCronAction(id, req.body?.scheduler);
      const { stdout, stderr } = await openclawExec(['cron', 'run', sourceId], 30000);
      const rawJob = parseFirstJson([stdout, stderr].filter(Boolean).join('\n'));
      const updated = await committed({ scheduler: 'openclaw', sourceId, operation: 'run', rawJob });
      return res.json({ ok: true, message: 'Job triggered successfully', ...updated });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/api/cron/create', async (req, res, next) => {
    try {
      const { job } = req.body || {};
      validateCreateJob(job);
      if (!job || !job.name || !job.schedule) {
        throw httpError(400, 'invalid_job', 'name and schedule required');
      }

      const args = ['cron', 'add', '--name', job.name];
      if (job.schedule?.kind === 'cron' && job.schedule.expr) {
        args.push('--cron', job.schedule.expr);
      } else if (job.schedule?.kind === 'every' && job.schedule.everyMs) {
        args.push('--every', `${Math.round(job.schedule.everyMs / 1000)}s`);
      } else if (job.schedule?.kind === 'at' && job.schedule.at) {
        args.push('--at', job.schedule.at);
      }
      args.push('--session', job.sessionTarget || 'isolated');
      if (job.payload?.kind === 'agentTurn') {
        args.push('--message', job.payload.message || '');
        if (job.payload.model) args.push('--model', job.payload.model);
      } else if (job.payload?.kind === 'systemEvent') {
        args.push('--system-event', job.payload.text || job.payload.message || '');
      }
      if (job.enabled === false) args.push('--disabled');
      args.push('--json');

      const { stdout, stderr } = await openclawExec(args, 20000);
      const parsed = cronService.parseFirstJson([stdout, stderr].filter(Boolean).join('\n')) || {};
      const updated = await committed({ scheduler: 'openclaw', sourceId: parsed.id || parsed.job?.id, operation: 'create', rawJob: parsed });
      return res.json({ ok: true, message: 'Job created successfully', job: parsed, entity: updated.job, meta: updated.meta });
    } catch (error) {
      return next(error);
    }
  });

  router.delete('/api/cron/:id', async (req, res, next) => {
    try {
      const { id } = req.params;
      const sourceId = assertOpenclawCronAction(id, req.body?.scheduler);
      await openclawExec(['cron', 'rm', sourceId], 15000);
      const updated = await committed({ scheduler: 'openclaw', sourceId, operation: 'delete' });
      return res.json({ ok: true, message: 'Job deleted successfully', ...updated });
    } catch (error) {
      return next(error);
    }
  });

  router.patch('/api/cron/:id/model', async (req, res, next) => {
    try {
      const { id } = req.params;
      const body = req.body || {};
      const { model, thinking, scheduler } = body;
      if (model !== undefined && (typeof model !== 'string' || model.length > 256)) throw httpError(400, 'invalid_model', 'model must be a string');
      if (thinking !== undefined && !['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'adaptive'].includes(thinking)) throw httpError(400, 'invalid_thinking', 'Invalid thinking level');
      const ref = parseCronJobRef(id, scheduler);
      if (!hasCronModelPatch(body)) {
        throw httpError(400, 'invalid_model', 'Provide at least model or thinking');
      }

      const normalizedModel = normalizeCronModel(model);
      if (normalizedModel && !/^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,255}$/.test(normalizedModel)) throw httpError(400, 'invalid_model', 'Invalid model');

      if (ref.scheduler === 'hermes') {
        if (thinking) {
          throw httpError(501, 'not_implemented', 'Hermes cron thinking edits are not supported');
        }
        const updated = cronService.updateHermesCronJobModel(assertSafeCronSourceId(ref.sourceId), normalizedModel);
        const published = await committed({ scheduler: 'hermes', sourceId: ref.sourceId, operation: 'edit', rawJob: updated, patch: { model: cronService.mapCronJobForApi(updated).model } });
        return res.json({
          ok: true,
          message: `Hermes cron model updated to ${normalizedModel || 'default'}`,
          ...published,
        });
      }

      if (!normalizedModel && !thinking) {
        throw httpError(400, 'invalid_model', 'Provide at least model or thinking');
      }

      const args = ['cron', 'edit', assertSafeCronSourceId(ref.sourceId)];
      if (normalizedModel) args.push('--model', normalizedModel);
      if (thinking) args.push('--thinking', thinking);

      const { stdout, stderr } = await openclawExec(args, 15000);
      const parsed = cronService.parseFirstJson([stdout, stderr].filter(Boolean).join('\n')) || {};
      const updated = typeof parsed === 'object' && parsed !== null ? parsed : {};
      const published = await committed({ scheduler: 'openclaw', sourceId: ref.sourceId, operation: 'edit', rawJob: updated,
        patch: { ...(normalizedModel ? { model: normalizedModel } : {}), ...(thinking ? { thinking } : {}) } });
      return res.json({
        ok: true,
        message: `Model updated to ${updated.payload?.model || normalizedModel || '(unchanged)'}`,
        ...published,
      });
    } catch (error) {
      return next(error);
    }
  });

  return router;
}

module.exports = {
  buildCronRouter,
  hasCronModelPatch,
  isUsableCronSnapshot,
};
