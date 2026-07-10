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

  router.get('/api/hermes-kanban/tasks/:taskId', async (req, res) => {
    try {
      res.json(await service.getTaskDetail(req.params.taskId));
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message, taskId: req.params.taskId });
    }
  });

  router.post('/api/hermes-kanban/actions', async (req, res) => {
    try {
      res.json(await service.runAction(req.body || {}));
    } catch (error) {
      res.status(error.statusCode || 500).json(error.responseBody || { ok: false, error: error.message });
    }
  });

  return router;
}

module.exports = { buildHermesKanbanRouter };
