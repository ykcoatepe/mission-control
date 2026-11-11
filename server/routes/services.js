'use strict';

// GET /api/services — launchd services plus gateway / Ollama reachability,
// composed from two scheduled sources. Read-only: no route here (or anywhere
// in this area) starts, stops or kicks a service.

const express = require('express');
const { sendEnvelope } = require('../core/http');
const { composeMeta } = require('../services/operationsOverview');

function servicesView(launchd, reachability) {
  if (!launchd && !reachability) return null;
  return {
    services: launchd ? launchd.services : null,
    counts: launchd ? launchd.counts : null,
    gateways: reachability ? reachability.gateways : null,
    ollama: reachability ? reachability.ollama : null,
  };
}

function buildServicesRouter({ launchdSource, reachabilitySource } = {}) {
  if (typeof launchdSource?.snapshot !== 'function') throw new TypeError('buildServicesRouter: launchdSource required');
  if (typeof reachabilitySource?.snapshot !== 'function') throw new TypeError('buildServicesRouter: reachabilitySource required');
  const router = express.Router();

  router.get('/api/services', (req, res) => {
    const launchd = launchdSource.snapshot();
    const reachability = reachabilitySource.snapshot();
    return sendEnvelope(res, {
      data: servicesView(launchd.data, reachability.data),
      meta: composeMeta({ launchd, reachability }, 'services'),
    });
  });

  return router;
}

module.exports = { buildServicesRouter, composeMeta, servicesView };
