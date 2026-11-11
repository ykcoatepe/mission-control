'use strict';

const express = require('express');
const { createGBrainOverviewService } = require('../../services/gbrainOverviewData');
const { sendEnvelope, httpError, safeMessage } = require('../../core/http');
const { limitInput, slugInput } = require('../../sources/gbrain/lookups');
const { GBrainActionDefinitions } = require('./constants');
const { listGBrainActions, runGBrainAction } = require('./actionsExecutor');
const { requiresExplicitConfirmation } = require('./actionPolicy');

// The action result keeps every field the frontend reads (status, pending,
// refreshAfter, summary, checkedAt, ...); only `error` takes the one error
// contract shape. Status codes are unchanged.
const ACTION_ERROR_CODES = {
  'confirmation-required': 'confirmation_required',
  rejected: 'gbrain_action_rejected',
  busy: 'gbrain_action_busy',
  'timed-out': 'gbrain_action_timed_out',
  failed: 'gbrain_action_failed',
};
function actionErrorBody(result) {
  const code = ACTION_ERROR_CODES[result.status] || 'gbrain_action_failed';
  const message = safeMessage(typeof result.error === 'string' && result.error ? result.error : 'GBrain action failed');
  return { ...result, error: { code, message } };
}

function buildGBrainRouter(options = {}) {
  const router = express.Router();
  const overviewService = options.gbrainOverviewService || createGBrainOverviewService(options);
  // All dashboard reads are snapshots. Only search/page are explicit lookup exceptions.
  router.get('/api/gbrain/overview', async (_req, res) => {
    res.json(await overviewService.getOverview());
  });
  // Legacy reading shapes plus meta. With no reading yet the answer is the
  // error contract (503, meta alongside); a failed refresh after a good one
  // keeps the last good reading and its meta says stale.
  for (const name of ['health', 'sources', 'version']) {
    router.get(`/api/gbrain/${name}`, async (_req, res) => {
      const probe = overviewService.probeSnapshot(name);
      if (probe.data === null || probe.data === undefined) {
        return res.status(503).json({
          error: { code: `gbrain_${name}_unavailable`, message: `GBrain ${name} has not been read` },
          meta: probe.meta,
        });
      }
      const reading = name === 'health' ? (await overviewService.readSnapshot()).live.health : { ...probe.data, meta: probe.meta };
      return res.json({ ...reading, meta: reading.meta || probe.meta });
    });
  }
  router.get('/api/gbrain/integration-health', (_req, res) => {
    const snap = overviewService.integrationSnapshot(); res.json({ ...snap.data, meta: snap.meta });
  });
  router.get('/api/gbrain/actions', (req, res) => {
    res.json({
      ok: true,
      mode: 'live-write-allowlist',
      actions: listGBrainActions(),
    });
  });

  router.post('/api/gbrain/actions', async (req, res) => {
    const action = req.body?.action;
    const definition = Object.hasOwn(GBrainActionDefinitions, action)
      ? GBrainActionDefinitions[action]
      : null;
    if (requiresExplicitConfirmation(definition, req.body)) {
      return res.status(400).json(actionErrorBody({
        ok: false,
        action,
        status: 'confirmation-required',
        checkedAt: new Date().toISOString(),
        error: 'Explicit confirmation is required for this action.',
      }));
    }
    const result = await runGBrainAction(req.body?.action, { ...options, exec: options.exec || overviewService.actionExec, confirmed: req.body?.confirmed });
    if (result.status === 'unavailable') throw httpError(503, 'gbrain_action_quarantined', result.error);
    const statusCode = result.status === 'timed-out' ? 504 : result.ok ? 200 : result.status === 'busy' ? 409 : result.status === 'failed' ? 502 : 400;
    if (statusCode === 200) {
      const { error: _unused, ...success } = result;
      return res.json(success);
    }
    return res.status(statusCode).json(actionErrorBody(result));
  });

  router.get('/api/gbrain/timeline', (req, res) => {
    const snap = overviewService.timelineSnapshot(limitInput(req.query.limit, 50, 200));
    if (snap.meta.error) throw httpError(503, 'gbrain_timeline_unavailable', 'Timeline ledger unavailable');
    res.json({ ...(snap.data || { enabled: overviewService.timelineService?.enabled !== false, entries: null,
      warnings: ['Timeline has not been read'], malformedLineCount: null, retainedEntryCount: null,
      schemaVersion: 1, truncated: false, limit: limitInput(req.query.limit, 50, 200) }), meta: snap.meta });
  });

  router.get('/api/gbrain/synoptic', (_req, res) => sendEnvelope(res, overviewService.synopticSnapshot()));
  router.get('/api/gbrain/search', async (req, res) => sendEnvelope(res, await overviewService.lookups.search(req.query.q, req.query.limit)));
  router.get('/api/gbrain/pages/:slug', async (req, res) => sendEnvelope(res, await overviewService.lookups.page(req.params.slug)));
  router.get('/api/gbrain/graph', (req, res) => {
    if (req.query.around === undefined) throw httpError(400, 'graph_around_required', 'around is required; only neighbourhood graphs are available');
    return sendEnvelope(res, overviewService.graph.request(slugInput(req.query.around), req.query.limit));
  });

  router.use((error, _req, res, next) => {
    if (error.status === 429) res.set('Retry-After', String(error.retryAfter || 2));
    next(error);
  });
  return router;
}

module.exports = { buildGBrainRouter };
