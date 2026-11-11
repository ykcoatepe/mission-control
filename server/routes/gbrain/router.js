'use strict';

const express = require('express');
const { createGBrainOverviewService } = require('../../services/gbrainOverviewData');
const { sendEnvelope, httpError } = require('../../core/http');
const { limitInput, slugInput } = require('../../sources/gbrain/lookups');
const { GBrainActionDefinitions } = require('./constants');
const { listGBrainActions, runGBrainAction } = require('./actionsExecutor');
const { requiresExplicitConfirmation } = require('./actionPolicy');

function buildGBrainRouter(options = {}) {
  const router = express.Router();
  const overviewService = options.gbrainOverviewService || createGBrainOverviewService(options);
  // All dashboard reads are snapshots. Only search/page are explicit lookup exceptions.
  router.get('/api/gbrain/overview', async (_req, res) => {
    res.json(await overviewService.getOverview());
  });
  for (const name of ['health', 'sources', 'version']) {
    router.get(`/api/gbrain/${name}`, async (_req, res) => {
      const health = name === 'health' ? (await overviewService.readSnapshot()).live.health : null;
      const snap = health ? { data: health, meta: health.meta } : overviewService.probeSnapshot(name);
      res.json({ ...(snap.data || { ok: false, mode: 'live-read-only', status: 'unavailable' }),
        ...(snap.meta.error ? { ok: false, status: 'unavailable' } : {}), meta: snap.meta });
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
      return res.status(400).json({
        ok: false,
        action,
        status: 'confirmation-required',
        checkedAt: new Date().toISOString(),
        error: 'Explicit confirmation is required for this action.',
      });
    }
    const result = await runGBrainAction(req.body?.action, { ...options, confirmed: req.body?.confirmed });
    const statusCode = result.ok ? 200 : result.status === 'busy' ? 409 : result.status === 'failed' ? 502 : 400;
    res.status(statusCode).json(result);
  });

  router.get('/api/gbrain/timeline', (req, res) => {
    const snap = overviewService.timelineSnapshot(limitInput(req.query.limit, 50, 200));
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

  return router;
}

module.exports = { buildGBrainRouter };
