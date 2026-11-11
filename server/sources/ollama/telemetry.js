const os = require('os');
const { createSource } = require('../../core/source');

function clampNum(value, min, max, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.round(n))) : fallback;
}
function normalizeOllamaOptimization(raw = {}) {
  const strategy = String(raw.strategy || 'balanced').toLowerCase();
  return { enabled: raw.enabled !== false, strategy: ['conservative', 'balanced', 'performance'].includes(strategy) ? strategy : 'balanced', keepAlive: String(raw.keepAlive || '5m').trim() || '5m', maxLoadedModels: clampNum(raw.maxLoadedModels, 1, 16, 2), numCtx: clampNum(raw.numCtx, 256, 262144, 2048), numParallel: clampNum(raw.numParallel, 1, 16, 1) };
}
function getOllamaConfig(mcConfig = {}) {
  const raw = mcConfig.ollama || {};
  const host = String(raw.host || '127.0.0.1');
  const port = clampNum(raw.port, 1, 65535, 11434);
  return { enabled: raw.enabled !== false, host, port, baseUrl: `http://${host}:${port}`, optimization: normalizeOllamaOptimization(raw.optimization) };
}
function getApplyCommands(profile) {
  const p = normalizeOllamaOptimization(profile);
  return [`export OLLAMA_KEEP_ALIVE=${p.keepAlive}`, `export OLLAMA_MAX_LOADED_MODELS=${p.maxLoadedModels}`, `export OLLAMA_NUM_CTX=${p.numCtx}`, `export OLLAMA_NUM_PARALLEL=${p.numParallel}`];
}
function sourceError(code, message) { return Object.assign(new Error(message), { code }); }
function parseIoregNumber(raw, key) {
  const match = String(raw || '').match(new RegExp(`"${key}"\\s*=\\s*([0-9]+)`, 'i'));
  return match ? Number(match[1]) : null;
}
async function readGpu({ runner, platform }) {
  const missing = { available: false, platform, limited: true, limitation: 'GPU telemetry is unavailable on this platform', devices: [] };
  if (platform !== 'darwin') return missing;
  if (!runner?.run) return { ...missing, limitation: 'GPU runner is unavailable' };
  let result;
  try { result = await runner.run('ioreg', ['-r', '-d', '1', '-w', '0', '-c', 'IOAccelerator'], { lane: 'default', key: 'ollama.gpu', timeoutMs: 1500, queueTimeoutMs: 1500, maxOutputBytes: 4 * 1024 * 1024 }); } catch { return { ...missing, limitation: 'GPU telemetry could not be read' }; }
  if (!result.ok || !result.stdout?.trim()) return { ...missing, limitation: 'GPU telemetry could not be read' };
  const raw = result.stdout;
  const total = parseIoregNumber(raw, 'Alloc system memory');
  const used = parseIoregNumber(raw, 'In use system memory');
  const cores = parseIoregNumber(raw, 'gpu-core-count');
  const mib = (n) => n === null ? null : Math.round(n / (1024 * 1024));
  const utilDevice = parseIoregNumber(raw, 'Device Utilization %');
  const utilRenderer = parseIoregNumber(raw, 'Renderer Utilization %');
  const utilTiler = parseIoregNumber(raw, 'Tiler Utilization %');
  if ([total, used, cores, utilDevice, utilRenderer, utilTiler].every((n) => n === null)) return { ...missing, limitation: 'GPU metrics were not present in the probe output' };
  return { available: true, platform, limited: false, limitation: null, devices: [{ index: '0', name: raw.match(/"model"\s*=\s*"([^"]+)"/)?.[1] ?? null, vendor: 'Apple', cores: cores === null ? null : String(cores), utilGpu: utilDevice ?? utilRenderer, utilMemory: utilTiler, memTotalMiB: mib(total), memUsedMiB: mib(used), memFreeMiB: total === null || used === null ? null : mib(Math.max(0, total - used)), tempC: null, powerDraw: null, powerLimit: null, memUsedEstimate: false, metricSource: 'apple-ioreg', memorySource: 'apple-ioreg-unified-memory' }] };
}
function createOllamaSource({ runner, mcConfig = {}, fetchImpl = global.fetch, osImpl = os, platform = process.platform, now = Date.now, logger } = {}) {
  let history = [];
  async function probe(url) {
    const started = now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2500);
    try {
      const response = await fetchImpl(url, { signal: controller.signal });
      if (!response.ok) throw new Error('HTTP failure');
      return { ok: true, latencyMs: now() - started, payload: await response.json(), error: null };
    } catch { return { ok: false, latencyMs: now() - started, payload: null, error: 'Ollama probe failed' }; }
    finally { clearTimeout(timer); }
  }
  async function read() {
    const cfg = getOllamaConfig(mcConfig);
    const generatedAt = new Date(now()).toISOString();
    const total = osImpl.totalmem();
    const free = osImpl.freemem();
    const used = Math.max(0, total - free);
    const usedPercent = total > 0 ? used / total * 100 : null;
    const loads = osImpl.loadavg();
    const cores = osImpl.cpus().length;
    const cpuPercent = cores > 0 ? Math.min(100, Math.max(0, loads[0] / cores * 100)) : null;
    const system = { cpu: { cores, load1: loads[0], load5: loads[1], load15: loads[2], usagePercent: cpuPercent }, memory: { totalBytes: total, freeBytes: free, usedBytes: used, usedPercent }, node: { uptimeSeconds: Math.round(process.uptime()) }, measuredAt: generatedAt };
    if (!cfg.enabled) return { generatedAt, healthScore: null, alerts: [{ code: 'OLLAMA_DISABLED', severity: 'warning', message: 'Ollama monitor disabled in config', triggeredAt: generatedAt, suppressed: false, cooldownUntil: generatedAt }], server: { ...cfg, optimization: undefined, status: 'disabled', latencyMs: null, version: null, checks: null, error: null }, runtime: { runningModels: null, totalModels: null, canAcceptRequests: null }, models: null, optimization: { enabled: cfg.optimization.enabled, current: cfg.optimization, recommendation: null, applyCommands: getApplyCommands(cfg.optimization), platform }, system, gpu: { available: false, platform, limited: true, limitation: 'Ollama monitor disabled', devices: [] } };
    const [ps, tags, version, gpu] = await Promise.all([probe(`${cfg.baseUrl}/api/ps`), probe(`${cfg.baseUrl}/api/tags`), probe(`${cfg.baseUrl}/api/version`), readGpu({ runner, platform })]);
    if (!ps.ok || !tags.ok) throw sourceError('ollama_probe_failed', 'Ollama inventory could not be observed');
    if (!Array.isArray(ps.payload?.models) || !Array.isArray(tags.payload?.models)) throw sourceError('ollama_invalid_payload', 'Ollama inventory payload is invalid');
    const text = (value) => typeof value === 'string' ? value : null;
    if ([...ps.payload.models, ...tags.payload.models].some((m) => !m || typeof m !== 'object' || Array.isArray(m))) throw sourceError('ollama_invalid_payload', 'Ollama model metadata is invalid');
    const running = new Map(ps.payload.models.map((m) => [m.name || m.model, m]));
    const models = tags.payload.models.map((m) => {
      const name = m.name || m.model;
      if (typeof name !== 'string' || !name) throw sourceError('ollama_invalid_payload', 'Ollama model name is missing');
      const runtime = running.get(name);
      return { name, status: runtime ? 'running' : 'ready', sizeLabel: Number.isFinite(m.size) ? `${Math.round(m.size / (1024 ** 3) * 10) / 10} GB` : null, digest: text(m.digest), parameterSize: text(m.details?.parameter_size), quantization: text(m.details?.quantization_level), format: text(m.details?.format), family: text(m.details?.family), keepAlive: text(runtime?.keep_alive), expiresAt: text(runtime?.expires_at), loadedAt: text(runtime?.loaded_at) };
    });
    for (const [name] of running) {
      if (typeof name !== 'string' || !name) throw sourceError('ollama_invalid_payload', 'Ollama model name is missing');
      if (!models.some((m) => m.name === name)) models.push({ name, status: 'running' });
    }
    const latencyMs = Math.max(ps.latencyMs, tags.latencyMs, version.latencyMs);
    const status = latencyMs > 2000 || !version.ok ? 'degraded' : 'online';
    const alerts = [];
    if (!version.ok) alerts.push({ code: 'OLLAMA_VERSION_UNAVAILABLE', severity: 'warning', message: 'Ollama version could not be read', triggeredAt: generatedAt, suppressed: false, cooldownUntil: generatedAt });
    if (latencyMs > 2000) alerts.push({ code: 'OLLAMA_LATENCY_HIGH', severity: 'warning', message: `High probe latency: ${latencyMs}ms`, triggeredAt: generatedAt, suppressed: false, cooldownUntil: generatedAt });
    if (usedPercent > 85) alerts.push({ code: 'MEMORY_PRESSURE', severity: 'warning', message: `High memory usage: ${usedPercent.toFixed(1)}%`, triggeredAt: generatedAt, suppressed: false, cooldownUntil: generatedAt });
    const healthScore = Math.max(0, 100 - (status === 'degraded' ? 20 : 0) - (latencyMs > 2500 ? 20 : latencyMs > 1200 ? 10 : 0) - (usedPercent > 90 ? 15 : usedPercent > 80 ? 8 : 0) - (running.size > 3 ? 5 : 0));
    let recommendation = cfg.optimization;
    if (usedPercent >= 85 || latencyMs >= 2500) recommendation = normalizeOllamaOptimization({ ...recommendation, strategy: 'conservative', keepAlive: '2m', maxLoadedModels: 1, numCtx: Math.min(recommendation.numCtx, 4096), numParallel: 1 });
    else if (usedPercent <= 55 && running.size <= 1) recommendation = normalizeOllamaOptimization({ ...recommendation, strategy: 'performance', keepAlive: '10m', maxLoadedModels: Math.max(2, Math.min(4, recommendation.maxLoadedModels)), numCtx: Math.max(recommendation.numCtx, 4096), numParallel: Math.max(2, Math.min(4, recommendation.numParallel)) });
    else recommendation = { ...recommendation, strategy: 'balanced' };
    const checks = Object.fromEntries([['ps', ps], ['tags', tags], ['version', version]].map(([key, result]) => [key, { ok: result.ok, error: result.error }]));
    const payload = { generatedAt, healthScore, alerts, server: { baseUrl: cfg.baseUrl, status, enabled: true, host: cfg.host, port: cfg.port, latencyMs, version: typeof version.payload?.version === 'string' ? version.payload.version : null, checks, error: null }, runtime: { runningModels: running.size, totalModels: models.length, canAcceptRequests: true }, models, optimization: { enabled: cfg.optimization.enabled, current: cfg.optimization, recommendation, applyCommands: getApplyCommands(recommendation), platform }, system, gpu };
    const device = gpu.devices[0];
    history.push({ generatedAt, healthScore, status, latencyMs, memoryUsedPercent: usedPercent, cpuUsagePercent: cpuPercent, gpuUtilPercent: device?.utilGpu ?? null, gpuMemoryPercent: device?.memTotalMiB > 0 && device.memUsedMiB !== null ? device.memUsedMiB / device.memTotalMiB * 100 : null, runningModels: running.size, totalModels: models.length, alerts });
    history = history.filter((item) => Date.parse(item.generatedAt) >= now() - 86400000).slice(-17280);
    return payload;
  }
  const source = createSource({ id: 'ollama.telemetry', read, ttlMs: 5000, timeoutMs: 5000, staleAfterMs: 15000, now, logger });
  return { ...source, history: () => history.slice() };
}
module.exports = { createOllamaSource, normalizeOllamaOptimization, getApplyCommands, getOllamaConfig };
