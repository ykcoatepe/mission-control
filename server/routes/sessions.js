const express = require('express');

function buildSessionsRouter({ sessionsService }) {
  const router = express.Router();

  router.get('/api/sessions', async (req, res) => {
    try {
      return res.json(await sessionsService.listVisibleSessions(25));
    } catch (error) {
      console.error('[Sessions API]', error.message);
      return res.json({ count: 0, sessions: [], error: error.message });
    }
  });

  return router;
}

module.exports = {
  buildSessionsRouter,
};
