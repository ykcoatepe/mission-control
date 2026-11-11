'use strict';

const { createSource, SourceReadError } = require('../../core/source');

const SKILLS_REFRESH_INTERVAL_MS = 60_000;

function createOpenclawSkillsSource({ openclawCli, parseFirstJson, settingsService, now = Date.now, logger = null } = {}) {
  if (typeof openclawCli !== 'function' || typeof parseFirstJson !== 'function') {
    throw new TypeError('createOpenclawSkillsSource: openclawCli and parseFirstJson required');
  }
  return createSource({
    id: 'openclaw.skills',
    ttlMs: SKILLS_REFRESH_INTERVAL_MS,
    timeoutMs: 60_000,
    staleAfterMs: 180_000,
    now,
    logger,
    read: async () => {
      let result;
      try { result = await openclawCli(['skills', 'list', '--json'], 20_000); } catch {
        throw new SourceReadError('OpenClaw skills could not be read', { code: 'openclaw_skills_unavailable' });
      }
      if (!result?.ok || result.truncated) {
        throw new SourceReadError('OpenClaw skills could not be read', { code: 'openclaw_skills_unavailable' });
      }
      let payload;
      try { payload = parseFirstJson(result.stdout, null); } catch {}
      if (!Array.isArray(payload?.skills) || payload.skills.some((row) => typeof row?.name !== 'string' || !row.name.trim())) {
        throw new SourceReadError('OpenClaw skills response is invalid', { code: 'openclaw_skills_invalid' });
      }
      let entries;
      try { entries = settingsService?.readOpenclawConfigSafe?.()?.skills?.entries || {}; } catch {
        throw new SourceReadError('Skill configuration could not be read', { code: 'openclaw_skills_config_unavailable' });
      }
      const installed = [];
      const available = [];
      for (const skill of payload.skills) {
        const enabled = entries[skill.name]?.enabled !== false;
        const status = skill.disabled || skill.blockedByAllowlist ? 'inactive'
          : skill.eligible === false ? 'available' : !enabled ? 'inactive'
            : skill.eligible === true ? 'active' : null;
        const row = {
          name: skill.name,
          description: typeof skill.description === 'string' ? skill.description : null,
          status,
          installed: status !== 'available',
          type: skill.source === 'openclaw-workspace' ? 'workspace' : typeof skill.source === 'string' ? 'system' : null,
          eligible: typeof skill.eligible === 'boolean' ? skill.eligible : null,
          disabled: typeof skill.disabled === 'boolean' ? skill.disabled : null,
          blockedByAllowlist: typeof skill.blockedByAllowlist === 'boolean' ? skill.blockedByAllowlist : null,
          source: typeof skill.source === 'string' ? skill.source : null,
        };
        (status === 'available' ? available : installed).push(row);
      }
      return { installed, available };
    },
  });
}

module.exports = { createOpenclawSkillsSource, SKILLS_REFRESH_INTERVAL_MS };
