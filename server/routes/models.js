const express = require('express');
const { asyncHandler, httpError } = require('../core/http');

function buildModelsRouter({ modelsSource }) {
  const router = express.Router();

  router.get('/api/models', asyncHandler((req, res) => {
    const snap = modelsSource.snapshot();
    if (snap.data === null) throw httpError(503, 'models_unavailable', 'Models have not been observed yet');
    // This legacy endpoint is a JSON array. Headers carry sibling metadata
    // without breaking existing array consumers; JSON arrays cannot own it.
    res.set('X-MC-Source-Meta', JSON.stringify(snap.meta));
    return res.json(snap.data.models);
  }));

  return router;
}

module.exports = { buildModelsRouter };
