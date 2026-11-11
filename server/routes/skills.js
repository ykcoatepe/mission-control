const express = require('express');
const { asyncHandler, httpError } = require('../core/http');

function buildSkillsRouter({ openclawExec, skillsSource, settingsService }) {
  const router = express.Router();

  router.get('/api/skills', asyncHandler((req, res) => {
    const snap = skillsSource.snapshot();
    if (snap.data === null) throw httpError(503, 'skills_unavailable', 'Skills have not been observed yet');
    return res.json({ ...snap.data, meta: snap.meta });
  }));

  router.post('/api/skills/:name/toggle', asyncHandler(async (req, res) => {
    const { name } = req.params;
    const { enabled } = req.body || {};
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(name)) {
      throw httpError(400, 'invalid_skill', 'Invalid skill name');
    }
    if (typeof enabled !== 'boolean') throw httpError(400, 'invalid_enabled', 'enabled must be boolean');
    try {
      const property = `skills.entries[${JSON.stringify(name)}].enabled`;
      await openclawExec(['config', 'set', '--json', property, enabled ? 'true' : 'false'], 15000);
      await settingsService.reloadGatewayConfig();
      return res.json({ ok: true });
    } catch {
      throw httpError(503, 'skill_toggle_failed', 'The skill could not be toggled');
    }
  }));

  router.post('/api/skills/:name/install', asyncHandler(() => {
    throw httpError(501, 'not_implemented', 'Skill installation is not implemented');
  }));

  router.post('/api/skills/:name/uninstall', asyncHandler(() => {
    throw httpError(501, 'not_implemented', 'Skill uninstallation is not implemented');
  }));

  return router;
}

module.exports = { buildSkillsRouter };
