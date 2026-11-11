const express = require('express');
const { httpError, sendEnvelope } = require('../core/http');
// Only query validation belongs to the HTTP layer. Usage data comes exclusively
// from the in-memory service, with no legacy reconstruction or zero fallbacks.
function parseMonthAnchor(value, now = new Date()) {
  if (value === undefined || value === null || value === '') return { ok: true, anchor: null };
  const raw = String(value);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(raw)) return { ok: false, error: 'month must be formatted as YYYY-MM with a month between 01 and 12' };
  const current = now.toLocaleDateString('en-CA').slice(0, 7);
  if (raw > current) return { ok: false, error: 'month cannot be in the future' };
  const floor = new Date(now.getFullYear(), now.getMonth() - 24, 1).toLocaleDateString('en-CA').slice(0, 7);
  if (raw < floor) return { ok: false, error: 'month is older than the 24-month history window' };
  return { ok: true, anchor: raw === current ? null : raw };
}

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
    const parsed = parseMonthAnchor(req.query.month, new Date(now()));
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
module.exports = { buildCostsRouter, parseMonthAnchor };
