const express = require('express');
const { httpError } = require('../core/http');

function buildOperationsRouter({ operationsOverviewService } = {}) {
  if (typeof operationsOverviewService?.getOverview !== 'function') {
    throw new Error('operationsOverviewService.getOverview required');
  }

  const router = express.Router();

  // The overview composes from memory. If composing itself fails, the answer
  // is the one error contract (503), never a 200/500 body with ok:false and
  // never the underlying error text.
  router.get('/api/operations/overview', async (_req, res, next) => {
    let overview;
    try {
      overview = await operationsOverviewService.getOverview();
    } catch {
      return next(httpError(503, 'operations_unavailable', 'Operations overview unavailable'));
    }
    return res.json(overview);
  });

  return router;
}

module.exports = { buildOperationsRouter };
