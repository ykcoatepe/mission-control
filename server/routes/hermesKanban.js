const os = require('os');
const express = require('express');
const { httpError } = require('../core/http');
const { homeRelativePath } = require('../core/scrub');

// Task workspace paths are shown home-relative (no absolute home path in a
// response). Task text (titles, bodies) is the operator's own content and is
// returned as written.
function homeRelativeBoard(board, homeDir) {
  if (!board?.columns || typeof board.columns !== 'object') return board;
  const shorten = (value) => homeRelativePath(value, { homeDir });
  const columns = Object.fromEntries(Object.entries(board.columns).map(([status, tasks]) => [status,
    Array.isArray(tasks) ? tasks.map((task) => (task && typeof task === 'object' && 'workspace_path' in task
      ? { ...task, workspace_path: shorten(task.workspace_path) } : task)) : tasks]));
  return { ...board, columns };
}

// GET /api/hermes-kanban — the read-only Hermes board, served from the
// scheduled Operations `hermes` source (the board the overview already
// reads). The request never runs the Hermes CLI.
function buildHermesKanbanRouter({ hermesSource, homeDir = os.homedir() } = {}) {
  if (typeof hermesSource?.snapshot !== 'function') throw new TypeError('buildHermesKanbanRouter: hermesSource required');
  const router = express.Router();

  router.get('/api/hermes-kanban', (_req, res) => {
    const snapshot = hermesSource.snapshot();
    if (!snapshot?.data) throw httpError(503, 'hermes_kanban_unavailable', 'The Hermes board has not been read');
    return res.json({ ...homeRelativeBoard(snapshot.data, homeDir), meta: snapshot.meta });
  });

  return router;
}

module.exports = { buildHermesKanbanRouter };
