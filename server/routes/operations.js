const express = require('express');

function buildOperationsRouter({ operationsOverviewService } = {}) {
  if (typeof operationsOverviewService?.getOverview !== 'function') {
    throw new Error('operationsOverviewService.getOverview required');
  }

  const router = express.Router();

  router.get('/api/operations/overview', async (_req, res) => {
    try {
      return res.json(await operationsOverviewService.getOverview());
    } catch {
      return res.status(500).json({
        ok: false,
        error: 'Operations overview unavailable',
      });
    }
  });

  return router;
}

module.exports = { buildOperationsRouter };
