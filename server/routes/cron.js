const express = require('express');

const CRON_MODEL_ALIASES = {
  'local-qwen3.6-35b-a3b-nvfp4': 'ollama/qwen3.6:35b-a3b-nvfp4',
};

function normalizeCronModel(model) {
  const key = String(model || '').trim();
  return CRON_MODEL_ALIASES[key] || key;
}

function cleanOpenclawError(error) {
  const raw = [error?.stderr, error?.stdout, error?.message]
    .filter(Boolean)
    .join('\n');
  const lines = raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line
      && !/^Config \([^)]*openclaw\.json\): missing env var /.test(line)
      && !/^Command failed: \/.*openclaw\b/.test(line));
  return lines[0] || 'OpenClaw command failed';
}

function buildCronRouter({
  readRuntimeSnapshot,
  writeRuntimeSnapshot,
  runtimeSnapshotTtl,
  cronService,
  openclawExec,
}) {
  const router = express.Router();
  let cronCache = null;
  let cronCacheTime = 0;
  let cronRefresh = null;
  const cronCacheTtl = 30000;

  function clearCronCache() {
    cronCache = null;
    cronCacheTime = 0;
  }

  async function refreshCronCache() {
    if (cronRefresh) return cronRefresh;
    cronRefresh = new Promise((resolve) => {
      setImmediate(async () => {
        try {
          const parsed = await cronService.fetchCronJobsLive();
          const rawJobs = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.jobs) ? parsed.jobs : []);
          if (!rawJobs || rawJobs.length === 0) {
            resolve(cronCache);
            return;
          }
          const jobs = rawJobs.map((job) => cronService.mapCronJobForApi(job));
          const result = writeRuntimeSnapshot('cron', { jobs });
          cronCache = result;
          cronCacheTime = Date.now();
          resolve(result);
        } catch {
          resolve(cronCache);
        } finally {
          cronRefresh = null;
        }
      });
    });
    return cronRefresh;
  }

  router.get('/api/cron', async (req, res) => {
    try {
      const snapshot = readRuntimeSnapshot('cron', runtimeSnapshotTtl.cron);
      if (snapshot && Array.isArray(snapshot.jobs) && snapshot.jobs.length > 0) {
        return res.json(snapshot);
      }

      if (cronCache && Array.isArray(cronCache.jobs) && cronCache.jobs.length > 0 && Date.now() - cronCacheTime < cronCacheTtl) {
        return res.json(cronCache);
      }

      if (cronCache && Array.isArray(cronCache.jobs) && cronCache.jobs.length > 0) {
        refreshCronCache();
        return res.json({ ...cronCache, refreshing: true, warning: 'Serving cached cron snapshot while refreshing in background.' });
      }

      const result = await refreshCronCache();
      if (result && Array.isArray(result.jobs) && result.jobs.length > 0) {
        return res.json(result);
      }
      return res.json({ jobs: [], error: 'No cron jobs available from live fetch or cache.' });
    } catch (error) {
      console.error('[Cron API]', error.message);
      return res.json({ jobs: [], error: error.message, detail: error.stdout || error.stderr || null });
    }
  });

  router.post('/api/cron/:id/toggle', async (req, res) => {
    try {
      const { id } = req.params;
      const { enabled } = req.body;
      const command = enabled ? 'enable' : 'disable';
      await openclawExec(['cron', command, id], 15000);
      clearCronCache();
      return res.json({ ok: true, message: `Job ${enabled ? 'enabled' : 'disabled'}` });
    } catch (error) {
      console.error('[Cron toggle]', error.message);
      return res.status(500).json({ error: error.message });
    }
  });

  router.post('/api/cron/:id/run', async (req, res) => {
    try {
      const { id } = req.params;
      await openclawExec(['cron', 'run', id], 30000);
      clearCronCache();
      return res.json({ ok: true, message: 'Job triggered successfully' });
    } catch (error) {
      console.error('[Cron run]', error.message);
      return res.status(500).json({ error: error.message });
    }
  });

  router.post('/api/cron/create', async (req, res) => {
    try {
      const { job } = req.body;
      if (!job || !job.name || !job.schedule) {
        return res.status(400).json({ error: 'Invalid job format - name and schedule required' });
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
      clearCronCache();
      return res.json({ ok: true, message: 'Job created successfully', job: parsed });
    } catch (error) {
      console.error('[Cron create]', error.message);
      return res.status(500).json({ error: error.message });
    }
  });

  router.delete('/api/cron/:id', async (req, res) => {
    try {
      const { id } = req.params;
      await openclawExec(['cron', 'rm', id], 15000);
      clearCronCache();
      return res.json({ ok: true, message: 'Job deleted successfully' });
    } catch (error) {
      console.error('[Cron delete]', error.message);
      return res.status(500).json({ error: error.message });
    }
  });

  router.patch('/api/cron/:id/model', async (req, res) => {
    try {
      const { id } = req.params;
      const { model, thinking } = req.body;
      if (!model && !thinking) {
        return res.status(400).json({ error: 'Provide at least model or thinking' });
      }

      const args = ['cron', 'edit', id];
      const normalizedModel = normalizeCronModel(model);
      if (normalizedModel) args.push('--model', normalizedModel);
      if (thinking) args.push('--thinking', thinking);

      const { stdout, stderr } = await openclawExec(args, 15000);
      const parsed = cronService.parseFirstJson([stdout, stderr].filter(Boolean).join('\n')) || {};
      const updated = typeof parsed === 'object' && parsed !== null ? parsed : {};
      clearCronCache();
      return res.json({
        ok: true,
        message: `Model updated to ${updated.payload?.model || normalizedModel || '(unchanged)'}`,
        job: cronService.mapCronJobForApi(updated),
      });
    } catch (error) {
      console.error('[Cron update model]', error.message);
      return res.status(500).json({ error: cleanOpenclawError(error) });
    }
  });

  return router;
}

module.exports = {
  buildCronRouter,
};
