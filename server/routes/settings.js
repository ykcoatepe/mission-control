const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');
const multer = require('multer');

function buildSettingsRouter({ settingsService, projectRoot }) {
  const router = express.Router();
  const uploadDir = path.join(projectRoot || os.tmpdir(), 'documents', '.tmp-settings');
  fs.mkdirSync(uploadDir, { recursive: true });
  const upload = multer({ dest: uploadDir, limits: { fileSize: 10 * 1024 * 1024 } });

  router.post('/api/settings/budget', (req, res) => {
    try {
      return res.json(settingsService.updateBudget(req.body?.monthly || 0));
    } catch (error) {
      console.error('[Budget API]', error.message);
      return res.status(500).json({ status: 'error', error: error.message });
    }
  });

  router.get('/api/config', (req, res) => {
    return res.json(settingsService.getPublicConfig());
  });

  router.get('/api/setup', async (req, res) => {
    try {
      return res.json(await settingsService.getSetupStatus());
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  });

  router.post('/api/setup', (req, res) => {
    try {
      return res.json(settingsService.updateSetup(req.body || {}));
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  });

  router.get('/api/settings', async (req, res) => {
    try {
      return res.json(settingsService.getSettingsPayload());
    } catch (error) {
      console.error('Settings error:', error);
      return res.status(500).json({ error: 'Failed to load settings' });
    }
  });

  router.get('/api/settings/model-routing', async (req, res) => {
    try {
      return res.json(settingsService.getModelRouting());
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  });

  router.post('/api/settings/model-routing', async (req, res) => {
    try {
      return res.json(await settingsService.setModelRouting(req.body || {}));
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  });

  router.get('/api/settings/heartbeat', async (req, res) => {
    try {
      return res.json(settingsService.getHeartbeatSettings());
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  });

  router.post('/api/settings/heartbeat', async (req, res) => {
    try {
      return res.json(await settingsService.setHeartbeatInterval(req.body?.interval));
    } catch (error) {
      const status = error.message === 'interval required' ? 400 : 500;
      return res.status(status).json({ error: error.message });
    }
  });

  router.get('/api/settings/export', (req, res) => {
    res.setHeader('Content-Disposition', 'attachment; filename=mc-config.json');
    res.setHeader('Content-Type', 'application/json');
    return res.sendFile(settingsService.getMissionControlConfigPath());
  });

  router.post('/api/settings/import', upload.single('config'), (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: 'No config file uploaded' });
      }
      return res.json(settingsService.importMissionControlConfig(req.file.path));
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  });

  return router;
}

module.exports = {
  buildSettingsRouter,
};
