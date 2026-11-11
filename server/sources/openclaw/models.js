'use strict';

const { createSource, SourceReadError } = require('../../core/source');

const MODELS_REFRESH_INTERVAL_MS = 60_000;

function createOpenclawModelsSource({ openclawCli, parseFirstJson, prettyModelName = (id) => id, settingsService, now = Date.now, logger = null } = {}) {
  if (typeof openclawCli !== 'function' || typeof parseFirstJson !== 'function') {
    throw new TypeError('createOpenclawModelsSource: openclawCli and parseFirstJson required');
  }
  return createSource({
    id: 'openclaw.models',
    ttlMs: MODELS_REFRESH_INTERVAL_MS,
    timeoutMs: 60_000,
    staleAfterMs: 180_000,
    now,
    logger,
    read: async () => {
      let result;
      try { result = await openclawCli(['models', 'list', '--json'], 12_000); } catch {
        throw new SourceReadError('OpenClaw models could not be read', { code: 'openclaw_models_unavailable' });
      }
      if (!result?.ok || result.truncated) {
        throw new SourceReadError('OpenClaw models could not be read', { code: 'openclaw_models_unavailable' });
      }
      let payload;
      try { payload = parseFirstJson(result.stdout, null); } catch {}
      if (!Array.isArray(payload?.models) || payload.models.some((row) => typeof row?.key !== 'string' || !row.key.trim())) {
        throw new SourceReadError('OpenClaw models response is invalid', { code: 'openclaw_models_invalid' });
      }
      const models = payload.models.map((row) => ({
        id: row.key,
        name: typeof row.name === 'string' && row.name ? row.name : prettyModelName(row.key),
        contextWindow: Number.isFinite(row.contextWindow) ? row.contextWindow : null,
        input: typeof row.input === 'string' ? row.input : Array.isArray(row.input) && row.input.every((item) => typeof item === 'string') ? [...row.input] : null,
        local: typeof row.local === 'boolean' ? row.local : null,
        available: typeof row.available === 'boolean' ? row.available : null,
        tags: Array.isArray(row.tags) ? row.tags.filter((tag) => typeof tag === 'string') : null,
      }));
      let configuredModel;
      try { configuredModel = settingsService?.getSettingsPayload?.().model; } catch {
        throw new SourceReadError('The configured model could not be read', { code: 'openclaw_model_config_unavailable' });
      }
      return { models, model: typeof configuredModel === 'string' && configuredModel ? configuredModel : null };
    },
  });
}

module.exports = { createOpenclawModelsSource, MODELS_REFRESH_INTERVAL_MS };
