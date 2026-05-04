const express = require('express');

function buildSkillsRouter({ openclawExec, parseFirstJson, settingsService }) {
  const router = express.Router();

  router.get('/api/skills', async (req, res) => {
    const requestHost = req.headers.host || '(unknown)';
    const requestIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '(unknown)';
    console.info(`[api:skills] start host=${requestHost} ip=${requestIp}`);

    try {
      const cfg = settingsService.readOpenclawConfigSafe();
      const entries = cfg?.skills?.entries || {};

      const rawCli = await openclawExec(['skills', 'list', '--json'], 20000);
      const payloadText = [rawCli.stdout, rawCli.stderr].filter(Boolean).join('\n');
      const payload = parseFirstJson(payloadText, {});
      const skills = payload.skills || [];
      console.info(`[api:skills] parsed skills=${skills.length} raw_stdout=${String(rawCli.stdout || '').length} raw_stderr=${String(rawCli.stderr || '').length} host=${requestHost}`);

      const installed = skills.map((skill) => {
        const entry = entries[skill.name] || null;
        const enabled = entry?.enabled !== false;
        const type = skill.source === 'openclaw-workspace' ? 'workspace' : 'system';
        const status = skill.disabled || skill.blockedByAllowlist
          ? 'inactive'
          : !skill.eligible
            ? 'available'
            : !enabled
              ? 'inactive'
              : 'active';

        return {
          name: skill.name,
          description: skill.description || '',
          status,
          installed: true,
          path: type === 'workspace' ? undefined : undefined,
          type,
          eligible: !!skill.eligible,
          disabled: !!skill.disabled,
          blockedByAllowlist: !!skill.blockedByAllowlist,
          source: skill.source,
        };
      });

      const available = installed.filter((skill) => skill.status === 'available').map((skill) => ({ ...skill, installed: false }));
      const realInstalled = installed.filter((skill) => skill.status !== 'available');
      console.info(`[api:skills] response installed=${realInstalled.length} available=${available.length}`);
      return res.json({ installed: realInstalled, available });
    } catch (error) {
      console.error('Skills error:', error);
      return res.status(500).json({ error: 'Failed to load skills' });
    }
  });

  router.post('/api/skills/:name/toggle', async (req, res) => {
    try {
      const { name } = req.params;
      const { enabled } = req.body || {};
      if (typeof enabled !== 'boolean') {
        return res.status(400).json({ error: 'enabled must be boolean' });
      }

      const property = `skills.entries["${String(name).replace(/"/g, '\\"')}"]`;
      await openclawExec(['config', 'set', '--json', `${property}.enabled`, enabled ? 'true' : 'false'], 15000);
      await settingsService.reloadGatewayConfig();
      return res.json({ ok: true });
    } catch (error) {
      console.error('Skill toggle error:', error);
      return res.status(500).json({ error: 'Failed to toggle skill' });
    }
  });

  router.post('/api/skills/:name/install', async (req, res) => {
    try {
      return res.json({ success: true, message: 'Skill installation not implemented' });
    } catch (error) {
      return res.status(500).json({ error: 'Failed to install skill' });
    }
  });

  router.post('/api/skills/:name/uninstall', async (req, res) => {
    try {
      return res.json({ success: true, message: 'Skill uninstall not implemented' });
    } catch (error) {
      return res.status(500).json({ error: 'Failed to uninstall skill' });
    }
  });

  return router;
}

module.exports = {
  buildSkillsRouter,
};
