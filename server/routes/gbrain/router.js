'use strict';

const express = require('express');
const { createGBrainOverviewService } = require('../../services/gbrainOverviewData');
const {
  buildLiveGBrainHealth,
  buildLiveGBrainSources,
  buildLiveGBrainVersion,
  buildLiveGBrainTools,
  buildLiveGBrainFeatures,
  buildLiveGBrainProviders,
  buildLiveHermesProxyStatus,
} = require('./liveProbes');
const { buildLocalGBrainIntegrationRuntime } = require('./integrationRuntime');
const { buildGBrainIntegrationHealth } = require('./integrationHealth');
const { GBrainActionDefinitions } = require('./constants');
const { listGBrainActions, runGBrainAction } = require('./actionsExecutor');
const { requiresExplicitConfirmation } = require('./actionPolicy');

function buildGBrainRouter(options = {}) {
  const router = express.Router();
  const overviewService = options.gbrainOverviewService || createGBrainOverviewService(options);
  const timelineService = overviewService.timelineService;

  router.get('/api/gbrain/overview', async (_req, res) => {
    res.json(await overviewService.getOverview());
  });

  router.get('/api/gbrain/health', async (req, res) => {
    res.json(await buildLiveGBrainHealth(options));
  });

  router.get('/api/gbrain/sources', async (req, res) => {
    res.json(await buildLiveGBrainSources(options));
  });

  router.get('/api/gbrain/version', async (req, res) => {
    res.json(await buildLiveGBrainVersion(options));
  });

  router.get('/api/gbrain/integration-health', async (req, res) => {
    const [health, sources, tools, features, providers, hermesProxy] = await Promise.all([
      buildLiveGBrainHealth(options),
      buildLiveGBrainSources(options),
      buildLiveGBrainTools(options),
      buildLiveGBrainFeatures(options),
      buildLiveGBrainProviders(options),
      buildLiveHermesProxyStatus(options),
    ]);
    res.json(buildGBrainIntegrationHealth({ health, sources, tools, features, providers, hermesProxy }, buildLocalGBrainIntegrationRuntime(options)));
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
    const result = await runGBrainAction(req.body?.action, options);
    const statusCode = result.ok ? 200 : result.status === 'busy' ? 409 : result.status === 'failed' ? 502 : 400;
    res.status(statusCode).json(result);
  });

  router.get('/api/gbrain/timeline', (req, res) => {
    res.json(timelineService.readTimeline({ limit: req.query.limit }));
  });

  return router;
}

module.exports = { buildGBrainRouter };
