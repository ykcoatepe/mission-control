const express = require('express');
const { asyncHandler, httpError } = require('../core/http');

function buildModelsRouter({ modelsSource, settingsService }) {
  const router = express.Router();

  function snapshot() {
    const snap = modelsSource.snapshot();
    if (snap.data === null) throw httpError(503, 'models_unavailable', 'Models have not been observed yet');
    return snap;
  }

  router.get('/api/models', asyncHandler((req, res) => {
    const snap = snapshot();
    // This legacy endpoint is a JSON array. Headers carry sibling metadata
    // without breaking existing array consumers; JSON arrays cannot own it.
    res.set('X-MC-Source-Meta', JSON.stringify(snap.meta));
    return res.json(snap.data.models);
  }));

  router.get('/api/model', asyncHandler((req, res) => {
    const snap = snapshot();
    return res.json({ model: snap.data.model, meta: snap.meta });
  }));

  router.post('/api/model', asyncHandler(async (req, res) => {
    if (typeof req.body?.model !== 'string' || !req.body.model.trim() || req.body.model.length > 500) {
      throw httpError(400, 'invalid_model', 'model must be a nonempty string');
    }
    try {
      return res.json(await settingsService.setDefaultModel(req.body.model));
    } catch {
      throw httpError(503, 'model_update_failed', 'The default model could not be updated');
    }
  }));

  return router;
}

module.exports = { buildModelsRouter };
