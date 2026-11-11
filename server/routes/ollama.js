const express = require('express');
const { asyncHandler, httpError } = require('../core/http');

function buildOllamaRouter({ ollamaSource }) {
  const router = express.Router();

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
  return router;
}

module.exports = { buildOllamaRouter };
