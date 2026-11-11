const express = require('express');
const {
  STATUSES,
  createHermesKanbanService,
} = require('../services/hermesKanbanData');

function buildHermesKanbanRouter({ mcConfig, hermesKanbanService } = {}) {
  const router = express.Router();
  const service = hermesKanbanService || createHermesKanbanService({ mcConfig });

  router.get('/api/hermes-kanban', async (_req, res) => {
    try {
      res.json(await service.getBoard());
    } catch (error) {
      res.status(503).json({
        ok: false,
        error: error.message,
        profile: service.profile,
        columns: Object.fromEntries(STATUSES.map((status) => [status, []])),
        statuses: STATUSES,
      });
    }
  });

  return router;
}

module.exports = { buildHermesKanbanRouter };
