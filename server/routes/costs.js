const express = require('express');
const { httpError, sendEnvelope } = require('../core/http');
const compatibility = require('../sources/usage/compatibility');

function buildCostsRouter({ usageService, now = Date.now } = {}) {
  if (!usageService) throw new TypeError('Usage service is required');
  const router = express.Router();
  function query(req) {
    const period = req.query.period === undefined ? 'month' : req.query.period;
    if (typeof period !== 'string' || !['day', '7d', 'month'].includes(period)) {
      throw httpError(400, 'invalid_usage_query', 'period must be day, 7d or month');
    }
    if (req.query.month !== undefined && typeof req.query.month !== 'string') {
      throw httpError(400, 'invalid_usage_query', 'month must be YYYY-MM');
    }
    const parsed = compatibility.parseMonthAnchor(req.query.month, new Date(now()));
    if (!parsed.ok) throw httpError(400, 'invalid_usage_query', parsed.error);
    return { period, anchor: period === 'month' ? parsed.anchor : null };
  }
  router.get('/api/costs', (req, res) => {
    const { period, anchor } = query(req);
    res.json(usageService.costs(period, anchor));
  });
  router.get('/api/costs/codexbar', (req, res) => {
    const { anchor } = query(req);
    res.json(usageService.codexbar(anchor));
  });
  router.get('/api/costs/months', (_req, res) => res.json(usageService.months()));
  router.get('/api/usage/summary', (_req, res) => sendEnvelope(res, usageService.summary()));
  return router;
}
module.exports = { ...compatibility, buildCostsRouter };
