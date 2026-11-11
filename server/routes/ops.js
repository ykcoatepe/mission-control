const express = require('express');

function buildOpsRouter({ readJsonFileSafe, opsEventsPath }) {
  const router = express.Router();

  router.get('/api/ops/events', (req, res) => {
    const events = readJsonFileSafe(opsEventsPath, []);
    const list = (Array.isArray(events) ? events : [])
      .sort((left, right) => new Date(right.timestamp || 0).getTime() - new Date(left.timestamp || 0).getTime())
      .slice(0, 200);
    return res.json({ events: list });
  });

  return router;
}

module.exports = {
  buildOpsRouter,
};
