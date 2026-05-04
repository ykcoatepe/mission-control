const express = require('express');

function buildQuickRouter({ gatewayPort, gatewayToken }) {
  const router = express.Router();

  router.post('/api/heartbeat/run', async (req, res) => {
    try {
      const response = await fetch(`http://127.0.0.1:${gatewayPort}/tools/invoke`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${gatewayToken}` },
        body: JSON.stringify({ tool: 'cron', args: { action: 'wake', text: 'Manual heartbeat check from Mission Control', mode: 'now' } }),
      });
      const data = await response.json();
      return res.json({ status: 'triggered', result: data });
    } catch (error) {
      return res.json({ status: 'error', error: error.message });
    }
  });

  router.post('/api/quick/emails', async (req, res) => {
    return res.json({ status: 'ok', reply: 'Email checks run via scheduled heartbeats. No manual ping needed.' });
  });

  router.post('/api/quick/schedule', async (req, res) => {
    return res.json({ status: 'ok', reply: 'Calendar checks run via scheduled heartbeats.' });
  });

  return router;
}

module.exports = {
  buildQuickRouter,
};
