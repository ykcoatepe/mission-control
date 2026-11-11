const express = require('express');
const { httpError } = require('../core/http');

// GET /api/hermes-kanban — the read-only Hermes board, served from the
// scheduled Operations `hermes` source (the board the overview already
// reads). The request never runs the Hermes CLI.
function buildHermesKanbanRouter({ hermesSource } = {}) {
  if (typeof hermesSource?.snapshot !== 'function') throw new TypeError('buildHermesKanbanRouter: hermesSource required');
  const router = express.Router();

  router.get('/api/hermes-kanban', (_req, res) => {
    const snapshot = hermesSource.snapshot();
    if (!snapshot?.data) throw httpError(503, 'hermes_kanban_unavailable', 'The Hermes board has not been read');
    return res.json({ ...snapshot.data, meta: snapshot.meta });
  });

  return router;
}

module.exports = { buildHermesKanbanRouter };
