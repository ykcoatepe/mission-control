const express = require('express');
const { asyncHandler, httpError } = require('../core/http');
const { normalizeOllamaOptimization, getApplyCommands } = require('../sources/ollama/telemetry');

function buildOllamaRouter({ ollamaSource, mcConfig, persistMcConfig }) {
  const router = express.Router();
  let optimizationBackup = null;

  function observed() {
    const snapshot = ollamaSource.snapshot();
    if (snapshot.data === null) throw httpError(503, 'ollama_unavailable', 'Ollama telemetry has not been observed');
    return snapshot;
  }

  router.get('/api/ollama/telemetry', asyncHandler((req, res) => {
    const snapshot = observed();
    return res.json({ ...snapshot.data, meta: snapshot.meta });
  }));
  router.get('/api/ollama/telemetry/history', asyncHandler((req, res) => {
    const snapshot = observed();
    const history = ollamaSource.history();
    return res.json({ generatedAt: snapshot.data.generatedAt, history, total: history.length, meta: snapshot.meta });
  }));
  router.get('/api/ollama/telemetry/models', asyncHandler((req, res) => {
    const snapshot = observed();
    return res.json({
      generatedAt: snapshot.data.generatedAt,
      mode: 'unmeasured',
      estimated: false,
      telemetrySource: 'unmeasured',
      limitations: ['Per-model request counts, latency and errors are not measured by the Ollama inventory API.'],
      windowMs: null,
      models: snapshot.data.models?.map((model) => ({
        name: model.name, status: model.status, requestCount: null, errorCount: null,
        errorRate: null, avgLatencyMs: null, p95LatencyMs: null, requestsPerMinute: null,
        estimated: false, note: 'Not measured; inventory probes are not model requests.',
      })) ?? null,
      meta: snapshot.meta,
    });
  }));

  router.post('/api/ollama/optimization', asyncHandler(async (req, res) => {
    const body = req.body || {};
    const inferredLegacy = Object.prototype.hasOwnProperty.call(body, 'strategy') || Object.prototype.hasOwnProperty.call(body, 'keepAlive');
    const action = String(body.action || 'apply').toLowerCase();
    if (!['apply', 'dry-run', 'rollback'].includes(action)) throw httpError(400, 'invalid_action', 'Unknown optimization action');
    const current = normalizeOllamaOptimization(mcConfig?.ollama?.optimization || {});
    const profile = normalizeOllamaOptimization(body.profile || (inferredLegacy ? body : {}));
    const diff = { from: current, to: profile, changed: Object.keys(profile).filter((key) => JSON.stringify(profile[key]) !== JSON.stringify(current[key])), applyCommands: getApplyCommands(profile) };
    if (action === 'dry-run' || body.dryRun === true) return res.json({ success: true, action: 'dry-run', diff, requiresConfirm: true });
    if (action === 'rollback') {
      if (body.confirm !== true) throw httpError(400, 'confirmation_required', 'confirm=true required for rollback');
      if (!optimizationBackup) throw httpError(400, 'no_backup', 'No rollback backup available');
    } else if (body.confirm !== true && !inferredLegacy) {
      throw httpError(400, 'confirmation_required', 'confirm=true required for apply (or use action=dry-run first)');
    }
    if (typeof persistMcConfig !== 'function') throw httpError(503, 'config_store_unavailable', 'ConfigStore is unavailable');
    const nextProfile = action === 'rollback' ? normalizeOllamaOptimization(optimizationBackup.profile) : profile;
    const previousOllama = mcConfig.ollama;
    mcConfig.ollama = { ...(previousOllama || {}), optimization: nextProfile };
    try { await persistMcConfig(); } catch (error) { mcConfig.ollama = previousOllama; throw error; }
    if (action !== 'rollback') optimizationBackup = { profile: current, savedAt: new Date().toISOString() };
    // Applying this setting stores a recommendation; verification comes from the
    // next scheduled probe, never an extra request-time upstream read.
    const snapshot = ollamaSource.snapshot();
    const verification = { ok: null, latencyMs: null, error: null, pending: true, note: 'Awaiting scheduled telemetry refresh', observedAt: snapshot.meta.observedAt };
    if (action === 'rollback') return res.json({ success: true, action, optimization: nextProfile, verification, rollbackFrom: optimizationBackup });
    return res.json({ success: true, action, optimization: nextProfile, diff, verification, rollbackAvailable: true });
  }));
  return router;
}

module.exports = { buildOllamaRouter };
