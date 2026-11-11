const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const routeSource = fs.readFileSync(
  path.join(__dirname, '..', 'server', 'routes', 'ollama.js'),
  'utf8',
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
  routeSource.includes('const visibleModels = mergedModels') &&
    !routeSource.includes('mergedModels.filter((model) => allowedOllamaModels.has'),
  'Ollama Runtime inventory should expose every installed /api/tags model without changing the OpenClaw allowlist',
);

assert.ok(
  routeSource.includes("Object.defineProperty(payload, 'allowedOllamaModels'") &&
    modelTelemetryRoute &&
    modelTelemetryRoute[0].includes('telemetry?.allowedOllamaModels instanceof Set') &&
    !modelTelemetryRoute[0].includes('await getAllowedOllamaModels()'),
  'Ollama model telemetry endpoint should reuse the allowed-model result from the telemetry payload',
);

console.log('ollama telemetry route guards passed');
