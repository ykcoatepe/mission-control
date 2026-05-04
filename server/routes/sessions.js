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

  router.get('/api/sessions/:sessionKey/history', async (req, res) => {
    try {
      return res.json(await sessionsService.getSessionHistory(req.params.sessionKey));
    } catch (error) {
      return res.json({ messages: [], error: error.message });
    }
  });

  router.post('/api/sessions/:sessionKey/send', async (req, res) => {
    try {
      const { message } = req.body;
      if (!message) return res.status(400).json({ error: 'message required' });
      return res.json(await sessionsService.sendSessionMessage(req.params.sessionKey, message));
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  });

  router.delete('/api/sessions/:key/close', async (req, res) => {
    try {
      return res.json(sessionsService.hideSession(req.params.key));
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  });

  return router;
}

module.exports = {
  buildSessionsRouter,
};
