const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const pageSource = fs.readFileSync(
  path.join(__dirname, '..', 'frontend', 'src', 'pages', 'OllamaMonitor.tsx'),
  'utf8',
);
const routeSource = fs.readFileSync(
  path.join(__dirname, '..', 'server', 'routes', 'ollama.js'),
  'utf8',
);

assert.ok(
  pageSource.includes('TOKEN_USAGE_RETRY_INTERVAL_MS = 2500') &&
    pageSource.includes('TOKEN_USAGE_RETRY_LIMIT = 60') &&
    pageSource.includes('TOKEN_USAGE_STEADY_REFRESH_MS = 60000'),
  'Ollama Monitor should fast-retry stale token usage and relax to a steady refresh after recovery',
);

assert.ok(
  pageSource.includes("tokens.source === 'sessions.fast_fallback'") &&
    pageSource.includes('!!tokens.meta?.refreshing') &&
    pageSource.includes('!!tokens.meta?.stale') &&
    pageSource.includes('preservedPreviousOpenClaw') &&
    pageSource.includes('preservedPreviousUsage'),
  'Ollama Monitor token usage polling should react to fallback, refreshing, stale, and preserved-cache states',
);

assert.ok(
  pageSource.includes('refetchTelemetry()') &&
    pageSource.includes('refetchHistory()') &&
    pageSource.includes('refetchModelTelemetry()') &&
    pageSource.includes('tokenUsageQuery.refetch()'),
  'Ollama Monitor manual refresh should refresh health, history, model telemetry, and token usage together',
);

assert.ok(
  pageSource.includes("source: 'Monitor samples'") &&
    pageSource.includes('monitor samples') &&
    !pageSource.includes('Estimated telemetry') &&
    !pageSource.includes('estimated telemetry'),
  'Ollama Monitor should label derived model telemetry as monitor samples, not estimated telemetry',
);

assert.ok(
  routeSource.includes('let ollamaTelemetryRefresh = null') &&
    routeSource.includes('async function getOllamaTelemetryPayload') &&
    routeSource.includes('if (ollamaTelemetryRefresh)') &&
    routeSource.includes('ollamaTelemetryCacheAt = Date.now()'),
  'Ollama telemetry API should coalesce refreshes and update the shared telemetry cache',
);

assert.ok(
  /router\.get\('\/api\/ollama\/telemetry\/models'[\s\S]*await getOllamaTelemetryPayload\(\)/.test(routeSource),
  'Ollama model telemetry endpoint should prime the telemetry cache before returning estimated model samples',
);

const modelTelemetryRoute = routeSource.match(/router\.get\('\/api\/ollama\/telemetry\/models'[\s\S]*?\n  \}\);/);
assert.ok(
  routeSource.includes("Object.defineProperty(payload, 'allowedOllamaModels'") &&
    modelTelemetryRoute &&
    modelTelemetryRoute[0].includes('telemetry?.allowedOllamaModels instanceof Set') &&
    !modelTelemetryRoute[0].includes('await getAllowedOllamaModels()'),
  'Ollama model telemetry endpoint should reuse the allowed-model result from the telemetry payload',
);

console.log('ollama monitor behavior guards passed');
