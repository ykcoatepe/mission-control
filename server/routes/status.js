const express = require('express');

// GET /api/status — thin route over the openclaw.status source (the worked
// example in server/core/README.md). It composes from memory and never starts
// a process. The legacy payload shape is kept for the current frontend;
// `meta` (the source envelope's meta) is added alongside.
//
// With no observed status yet, the legacy payload from statusService (fresh
// runtime snapshot, unobserved cache, or minimal) is returned with
// meta.ok === false, so the client can tell it is not evidence.
function buildStatusRouter({ statusService, statusSource = null }) {
  const router = express.Router();

  router.get('/api/status', async (req, res) => {
    if (statusSource) {
      const snapshot = statusSource.snapshot();
      const payload = snapshot.data || await statusService.getStatusResponse();
      return res.json({ ...payload, meta: snapshot.meta });
    }
    return res.json(await statusService.getStatusResponse());
  });

  return router;
}

module.exports = {
  buildStatusRouter,
};
