const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');
const multer = require('multer');
const { asyncHandler, httpError } = require('../core/http');

function buildSettingsRouter({ settingsService, projectRoot }) {
  const router = express.Router();
  const uploadDir = path.join(projectRoot || os.tmpdir(), 'documents', '.tmp-settings');
  fs.mkdirSync(uploadDir, { recursive: true });
  const upload = multer({ dest: uploadDir, limits: { fileSize: 10 * 1024 * 1024 } });
  const localConfigMeta = () => ({
    ok: true, stale: false, observedAt: new Date().toISOString(), ageMs: 0,
    error: null, latencyMs: null, source: 'settings.local-config',
  });
  const read = (fn) => asyncHandler(async (req, res) => {
    const payload = await fn(req);
    return res.json({ ...payload, meta: payload.meta || localConfigMeta() });
  });
  router.post('/api/settings/budget', asyncHandler((req, res) => res.json(settingsService.updateBudget(req.body?.monthly))));
  router.get('/api/config', read(() => settingsService.getPublicConfig()));
  router.get('/api/setup', read(() => settingsService.getSetupStatus()));
  router.post('/api/setup', asyncHandler((req, res) => res.json(settingsService.updateSetup(req.body || {}))));
  router.get('/api/settings', read(() => settingsService.getSettingsPayload()));
  router.get('/api/settings/model-routing', read(() => settingsService.getModelRouting()));
  router.post('/api/settings/model-routing', asyncHandler(async (req, res) => res.json(await settingsService.setModelRouting(req.body || {}))));
  router.get('/api/settings/heartbeat', read(() => settingsService.getHeartbeatSettings()));
  router.post('/api/settings/heartbeat', asyncHandler(async (req, res) => res.json(await settingsService.setHeartbeatInterval(req.body?.interval))));
  router.get('/api/settings/export', (req, res) => {
    res.setHeader('Content-Disposition', 'attachment; filename=mc-config.json');
    const payload = settingsService.getExportConfig();
    res.setHeader('X-MC-Source-Meta', JSON.stringify(localConfigMeta()));
    return res.json(payload);
  });
  // Upload failures are client errors in the one contract, never a 500 with
  // the multer text (which can name the temp path).
  const receiveConfig = (req, res, next) => upload.single('config')(req, res, (error) => {
    if (!error) return next();
    if (error.code === 'LIMIT_FILE_SIZE') return next(httpError(413, 'payload_too_large', 'Config file is too large'));
    return next(httpError(400, 'invalid_upload', 'Config upload could not be read'));
  });
  router.post('/api/settings/import', receiveConfig, asyncHandler((req, res) => {
    if (!req.file) throw httpError(400, 'config_file_required', 'No config file uploaded');
    try {
      return res.json(settingsService.importMissionControlConfig(req.file.path));
    } finally {
      fs.rmSync(req.file.path, { force: true });
    }
  }));
  return router;
}

module.exports = { buildSettingsRouter };
