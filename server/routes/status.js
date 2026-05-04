const express = require('express');

function buildStatusRouter({ statusService }) {
  const router = express.Router();

  router.get('/api/status', async (req, res) => {
    try {
      const payload = await statusService.getStatusResponse();
      return res.json(payload);
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  });

  return router;
}

module.exports = {
  buildStatusRouter,
};
