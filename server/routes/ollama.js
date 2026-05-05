const express = require('express');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const OLLAMA_TELEMETRY_TTL_MS = 2500;
const OLLAMA_HISTORY_WINDOW_MS = 24 * 60 * 60 * 1000;
const OLLAMA_HISTORY_MAX_POINTS = Math.ceil(OLLAMA_HISTORY_WINDOW_MS / 5000);
const OLLAMA_MODEL_WINDOW_MS = 30 * 60 * 1000;
const OLLAMA_MODEL_WINDOW_POINTS = 360;

let ollamaTelemetryCache = null;
let ollamaTelemetryCacheAt = 0;
let ollamaHistory = [];
const ollamaModelSeries = new Map();
let ollamaOptimizationBackup = null;
let allowedOllamaModelsCache = { at: 0, models: null };

function clampNum(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function normalizeOllamaOptimization(raw = {}) {
  const strategyRaw = String(raw.strategy || 'balanced').toLowerCase();
  return {
    enabled: raw.enabled !== false,
    strategy: ['conservative', 'balanced', 'performance'].includes(strategyRaw) ? strategyRaw : 'balanced',
    keepAlive: String(raw.keepAlive || '5m').trim() || '5m',
    maxLoadedModels: clampNum(raw.maxLoadedModels, 1, 16, 2),
    numCtx: clampNum(raw.numCtx, 256, 262144, 2048),
    numParallel: clampNum(raw.numParallel, 1, 16, 1),
  };
}

function percentile(values, p) {
  if (!Array.isArray(values) || !values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

function buildOllamaRouter({
  exec: execAsync,
  openclawExec,
  mcConfig,
  missionControlConfigPath,
}) {
  const router = express.Router();
  const openclawConfigPath = path.join(process.env.HOME || '/home/ubuntu', '.openclaw/openclaw.json');

  try {
    fs.watch(openclawConfigPath, { persistent: false }, () => {
      allowedOllamaModelsCache = { at: 0, models: null };
    });
  } catch {}

  async function getAllowedOllamaModels() {
    const now = Date.now();
    if (allowedOllamaModelsCache.models && now - allowedOllamaModelsCache.at < 10_000) {
      return allowedOllamaModelsCache.models;
    }

    try {
      const { stdout } = await openclawExec(['models', 'list', '--json'], 12000);
      const jsonStart = (stdout || '{').indexOf('{');
      const payload = jsonStart >= 0 ? JSON.parse(stdout.slice(jsonStart)) : {};
      const rows = Array.isArray(payload?.models) ? payload.models : [];
      const rawNames = rows
        .map((model) => String(model?.key || '').trim())
        .filter((key) => key.startsWith('ollama/'))
        .map((key) => key.slice('ollama/'.length));
      const allowed = new Set(rawNames);
      for (const name of rawNames) {
        if (!name.includes(':')) allowed.add(`${name}:latest`);
      }
      allowedOllamaModelsCache = { at: now, models: allowed };
      return allowed;
    } catch {
      return null;
    }
  }

  function getOllamaConfig() {
    const raw = mcConfig.ollama || {};
    const host = String(raw.host || '127.0.0.1');
    const port = clampNum(raw.port, 1, 65535, 11434);
    return {
      enabled: raw.enabled !== false,
      host,
      port,
      baseUrl: `http://${host}:${port}`,
      optimization: normalizeOllamaOptimization(raw.optimization || {}),
    };
  }

  function computeOllamaRecommendation(current, latencyMs, memUsedPercent, runningModels) {
    let strategy = current.strategy;
    let keepAlive = current.keepAlive;
    let maxLoadedModels = current.maxLoadedModels;
    let numCtx = current.numCtx;
    let numParallel = current.numParallel;
    const reasons = [];

    if ((Number.isFinite(memUsedPercent) && memUsedPercent >= 85) || (Number.isFinite(latencyMs) && latencyMs >= 2500)) {
      strategy = 'conservative';
      keepAlive = '2m';
      maxLoadedModels = 1;
      numCtx = Math.min(numCtx, 4096);
      numParallel = 1;
      reasons.push('Yüksek bellek/gecikme: daha konservatif çalışma önerildi.');
    } else if (Number.isFinite(memUsedPercent) && memUsedPercent <= 55 && runningModels <= 1) {
      strategy = 'performance';
      keepAlive = '10m';
      maxLoadedModels = Math.max(2, Math.min(4, maxLoadedModels));
      numCtx = Math.max(numCtx, 4096);
      numParallel = Math.max(2, Math.min(4, numParallel));
      reasons.push('Düşük yük: modeli sıcak tutup yeniden yükleme gecikmesini azaltma önerildi.');
    } else {
      strategy = 'balanced';
      reasons.push('Mevcut yük dengeli: balanced profil uygun.');
    }

    return normalizeOllamaOptimization({ strategy, keepAlive, maxLoadedModels, numCtx, numParallel, enabled: current.enabled, reasons });
  }

  async function fetchJsonWithTiming(url, timeoutMs = 2500) {
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { signal: controller.signal });
      const latencyMs = Date.now() - started;
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return { ok: true, latencyMs, payload: await response.json(), error: null };
    } catch (error) {
      return { ok: false, latencyMs: Date.now() - started, payload: null, error: error.message || 'request failed' };
    } finally {
      clearTimeout(timer);
    }
  }

  function appendOllamaHistory(item) {
    if (!item) return;
    ollamaHistory.push(item);
    if (ollamaHistory.length > OLLAMA_HISTORY_MAX_POINTS) {
      ollamaHistory = ollamaHistory.slice(-OLLAMA_HISTORY_MAX_POINTS);
    }
    const cutoff = Date.now() - OLLAMA_HISTORY_WINDOW_MS;
    ollamaHistory = ollamaHistory.filter((entry) => new Date(entry.generatedAt).getTime() >= cutoff);
  }

  function recordModelTelemetry(models, telemetry) {
    const now = Date.now();
    const latencyMs = Number(telemetry?.server?.latencyMs);
    const status = String(telemetry?.server?.status || '').toLowerCase();

    for (const model of models || []) {
      const name = String(model?.name || '').trim();
      if (!name) continue;
      const key = name.toLowerCase();
      const existing = ollamaModelSeries.get(key) || [];
      const event = {
        ts: now,
        requestWeight: 1,
        errorWeight: status === 'offline' ? 1 : (status === 'degraded' ? 0.5 : 0),
        latencyMs: Number.isFinite(latencyMs) ? latencyMs : null,
        status: String(model?.status || 'unknown').toLowerCase(),
        name,
      };
      existing.push(event);
      const cutoff = now - OLLAMA_MODEL_WINDOW_MS;
      const trimmed = existing.filter((entry) => entry.ts >= cutoff).slice(-OLLAMA_MODEL_WINDOW_POINTS);
      ollamaModelSeries.set(key, trimmed);
    }
  }

  function isOllamaEmbeddingModel(model) {
    const name = String(model?.name || model?.model || '').toLowerCase();
    const details = model?.details || {};
    const family = String(details.family || '').toLowerCase();
    const families = Array.isArray(details.families) ? details.families.map((item) => String(item || '').toLowerCase()) : [];
    const parameterSize = String(details.parameter_size || '').toLowerCase();

    return (
      name.includes('embed')
      || family.includes('embed')
      || family.includes('bert')
      || families.some((item) => item.includes('embed') || item.includes('bert'))
      || (name.includes('embedding') && parameterSize)
    );
  }

  function getModelTelemetrySnapshot(allowedModels = null) {
    const now = Date.now();
    const rpmCutoff = now - 60 * 1000;
    const models = [];

    for (const series of ollamaModelSeries.values()) {
      if (!series.length) continue;
      const name = series[series.length - 1].name;
      if (allowedModels instanceof Set && !allowedModels.has(String(name || '').trim()) && !isOllamaEmbeddingModel(series[series.length - 1])) continue;
      const requestCount = series.reduce((total, entry) => total + (Number(entry.requestWeight) || 0), 0);
      const errorCount = series.reduce((total, entry) => total + (Number(entry.errorWeight) || 0), 0);
      const requestsPerMinute = series.filter((entry) => entry.ts >= rpmCutoff).reduce((total, entry) => total + (Number(entry.requestWeight) || 0), 0);
      const latencies = series.map((entry) => Number(entry.latencyMs)).filter(Number.isFinite);
      const avgLatencyMs = latencies.length ? (latencies.reduce((total, value) => total + value, 0) / latencies.length) : null;
      const p95LatencyMs = percentile(latencies, 95);
      const latestStatus = String(series[series.length - 1].status || 'unknown');

      models.push({
        name,
        requestCount: Number(requestCount.toFixed(3)),
        errorCount: Number(errorCount.toFixed(3)),
        errorRate: requestCount > 0 ? Number((errorCount / requestCount).toFixed(4)) : 0,
        avgLatencyMs: Number.isFinite(avgLatencyMs) ? Number(avgLatencyMs.toFixed(2)) : null,
        p95LatencyMs: Number.isFinite(p95LatencyMs) ? Number(p95LatencyMs.toFixed(2)) : null,
        requestsPerMinute: Number(requestsPerMinute.toFixed(3)),
        status: latestStatus,
        estimated: true,
      });
    }

    return {
      generatedAt: new Date().toISOString(),
      mode: 'snapshot',
      estimated: true,
      telemetrySource: 'snapshot-estimation',
      limitations: [
        'samples are generated by Mission Control polling, not by Ollama request logs',
        'latency is the Ollama health probe latency, not per-model generation latency',
        'error rate is inferred from server status during poll samples',
      ],
      windowMs: OLLAMA_MODEL_WINDOW_MS,
      models: models.sort((left, right) => right.requestsPerMinute - left.requestsPerMinute),
    };
  }

  function getApplyCommands(profile) {
    const normalized = normalizeOllamaOptimization(profile);
    return [
      `export OLLAMA_KEEP_ALIVE=${normalized.keepAlive}`,
      `export OLLAMA_MAX_LOADED_MODELS=${normalized.maxLoadedModels}`,
      `export OLLAMA_NUM_CTX=${normalized.numCtx}`,
      `export OLLAMA_NUM_PARALLEL=${normalized.numParallel}`,
    ];
  }

  function computeHealthScore(serverStatus, latencyMs, memUsedPercent, runningModels) {
    let score = 100;
    if (serverStatus === 'offline') score -= 60;
    else if (serverStatus === 'degraded') score -= 20;
    if (Number.isFinite(latencyMs) && latencyMs > 2500) score -= 20;
    else if (Number.isFinite(latencyMs) && latencyMs > 1200) score -= 10;
    if (Number.isFinite(memUsedPercent) && memUsedPercent > 90) score -= 15;
    else if (Number.isFinite(memUsedPercent) && memUsedPercent > 80) score -= 8;
    if (runningModels > 3) score -= 5;
    return Math.max(0, Math.min(100, score));
  }

  function parseIoregNumber(raw, key) {
    const match = String(raw || '').match(new RegExp(`"${key}"\\s*=\\s*([0-9]+)`, 'i'));
    if (!match) return null;
    const n = Number(match[1]);
    return Number.isFinite(n) ? n : null;
  }

  function parseIoregString(raw, key) {
    const match = String(raw || '').match(new RegExp(`"${key}"\\s*=\\s*"([^"]+)"`, 'i'));
    return match ? match[1] : null;
  }

  function getAppleGpuStats() {
    if (process.platform !== 'darwin') return null;
    try {
      const out = execSync('ioreg -r -d 1 -w 0 -c IOAccelerator', { encoding: 'utf8', timeout: 1500, maxBuffer: 1024 * 1024 * 4 });
      if (!out) return null;

      const utilDevice = parseIoregNumber(out, 'Device Utilization %');
      const utilRenderer = parseIoregNumber(out, 'Renderer Utilization %');
      const utilTiler = parseIoregNumber(out, 'Tiler Utilization %');
      const memUsedBytes = parseIoregNumber(out, 'In use system memory');
      const memTotalBytes = parseIoregNumber(out, 'Alloc system memory');
      const gpuCores = parseIoregNumber(out, 'gpu-core-count');
      const model = parseIoregString(out, 'model') || 'Apple GPU';
      const toMiB = (value) => (Number.isFinite(value) ? Math.round(value / (1024 * 1024)) : null);

      return {
        available: true,
        platform: 'darwin',
        limited: false,
        limitation: null,
        devices: [
          {
            index: '0',
            name: model,
            vendor: 'Apple',
            cores: Number.isFinite(gpuCores) ? String(gpuCores) : null,
            utilGpu: Number.isFinite(utilDevice) ? utilDevice : (Number.isFinite(utilRenderer) ? utilRenderer : null),
            utilMemory: Number.isFinite(utilTiler) ? utilTiler : null,
            memTotalMiB: toMiB(memTotalBytes),
            memUsedMiB: toMiB(memUsedBytes),
            memFreeMiB: Number.isFinite(memTotalBytes) && Number.isFinite(memUsedBytes) ? toMiB(Math.max(0, memTotalBytes - memUsedBytes)) : null,
            tempC: null,
            powerDraw: null,
            powerLimit: null,
            memUsedEstimate: false,
            metricSource: 'apple-ioreg',
            memorySource: 'apple-ioreg-unified-memory',
          },
        ],
      };
    } catch (error) {
      return {
        available: false,
        platform: 'darwin',
        limited: true,
        limitation: 'GPU live metriği alınamadı',
        error: error.message || 'ioreg failed',
        devices: [],
      };
    }
  }

  router.get('/api/ollama/telemetry', async (req, res) => {
    const now = Date.now();
    if (ollamaTelemetryCache && now - ollamaTelemetryCacheAt <= OLLAMA_TELEMETRY_TTL_MS) {
      return res.json(ollamaTelemetryCache);
    }

    const cfg = getOllamaConfig();
    if (!cfg.enabled) {
      return res.json({
        generatedAt: new Date().toISOString(),
        healthScore: 0,
        alerts: [{ code: 'OLLAMA_DISABLED', severity: 'warning', message: 'Ollama monitor disabled in config', triggeredAt: new Date().toISOString(), suppressed: false, cooldownUntil: new Date().toISOString() }],
        server: { baseUrl: cfg.baseUrl, status: 'offline', enabled: false, host: cfg.host, port: cfg.port, latencyMs: null, version: null, checks: { ps: { ok: false, error: 'disabled' }, tags: { ok: false, error: 'disabled' }, version: { ok: false, error: 'disabled' } }, error: 'disabled' },
        runtime: { runningModels: 0, totalModels: 0, canAcceptRequests: false },
        models: [],
        optimization: { enabled: cfg.optimization.enabled, current: cfg.optimization, recommendation: cfg.optimization, applyCommands: getApplyCommands(cfg.optimization), platform: process.platform },
        system: { cpu: { cores: 0, load1: 0, load5: 0, load15: 0, usagePercent: 0 }, memory: { totalBytes: 0, freeBytes: 0, usedBytes: 0, usedPercent: 0 }, node: { uptimeSeconds: process.uptime() }, measuredAt: new Date().toISOString() },
      });
    }

    const [psResult, tagsResult, versionResult] = await Promise.all([
      fetchJsonWithTiming(`${cfg.baseUrl}/api/ps`, 2500),
      fetchJsonWithTiming(`${cfg.baseUrl}/api/tags`, 2500),
      fetchJsonWithTiming(`${cfg.baseUrl}/api/version`, 2500),
    ]);

    const reachable = psResult.ok || tagsResult.ok || versionResult.ok;
    const latencyMs = Math.max(psResult.latencyMs || 0, tagsResult.latencyMs || 0, versionResult.latencyMs || 0) || null;
    const running = Array.isArray(psResult.payload?.models) ? psResult.payload.models : [];
    const tags = Array.isArray(tagsResult.payload?.models) ? tagsResult.payload.models : [];
    const runningMap = new Map(running.map((model) => [String(model?.name || model?.model || ''), model]));

    const mergedModels = tags.map((model) => {
      const name = String(model?.name || model?.model || 'unknown');
      const runtime = runningMap.get(name);
      return {
        name,
        status: runtime ? 'running' : 'ready',
        sizeLabel: model?.size ? `${Math.round(Number(model.size) / (1024 * 1024 * 1024) * 10) / 10} GB` : null,
        digest: model?.digest || null,
        parameterSize: model?.details?.parameter_size || null,
        quantization: model?.details?.quantization_level || null,
        format: model?.details?.format || null,
        family: model?.details?.family || null,
        keepAlive: runtime?.keep_alive || null,
        expiresAt: runtime?.expires_at || null,
        loadedAt: runtime?.loaded_at || null,
      };
    });

    for (const runtime of running) {
      const name = String(runtime?.name || runtime?.model || 'unknown');
      if (!mergedModels.find((model) => model.name === name)) {
        mergedModels.push({ name, status: 'running' });
      }
    }

    const allowedOllamaModels = await getAllowedOllamaModels();
    const visibleModels = (allowedOllamaModels instanceof Set)
      ? mergedModels.filter((model) => allowedOllamaModels.has(String(model?.name || '').trim()) || isOllamaEmbeddingModel(model))
      : mergedModels;
    const visibleRunningCount = visibleModels.filter((model) => String(model?.status || '').toLowerCase() === 'running').length;

    const totalMem = Number(require('os').totalmem()) || 0;
    const freeMem = Number(require('os').freemem()) || 0;
    const usedMem = Math.max(0, totalMem - freeMem);
    const usedPercent = totalMem > 0 ? (usedMem / totalMem) * 100 : 0;
    const loads = require('os').loadavg();
    const cpuCores = Number(require('os').cpus()?.length || 0);
    const approxCpuUsagePercent = cpuCores > 0 ? Math.min(100, Math.max(0, (Number(loads[0]) / cpuCores) * 100)) : 0;

    const serverStatus = !reachable ? 'offline' : ((Number.isFinite(latencyMs) && latencyMs > 2000) ? 'degraded' : 'online');
    const healthScore = computeHealthScore(serverStatus, latencyMs, usedPercent, visibleRunningCount);
    const alerts = [];
    if (serverStatus === 'offline') alerts.push({ code: 'OLLAMA_OFFLINE', severity: 'critical', message: 'Ollama erişilemiyor', triggeredAt: new Date().toISOString(), suppressed: false, cooldownUntil: new Date().toISOString() });
    if (Number.isFinite(latencyMs) && latencyMs > 2000) alerts.push({ code: 'OLLAMA_LATENCY_HIGH', severity: 'warning', message: `Yüksek gecikme: ${latencyMs}ms`, triggeredAt: new Date().toISOString(), suppressed: false, cooldownUntil: new Date().toISOString() });
    if (usedPercent > 85) alerts.push({ code: 'MEMORY_PRESSURE', severity: 'warning', message: `Yüksek bellek kullanımı: ${usedPercent.toFixed(1)}%`, triggeredAt: new Date().toISOString(), suppressed: false, cooldownUntil: new Date().toISOString() });

    const recommendation = computeOllamaRecommendation(cfg.optimization, latencyMs, usedPercent, running.length);
    const payload = {
      generatedAt: new Date().toISOString(),
      healthScore,
      alerts,
      server: {
        baseUrl: cfg.baseUrl,
        status: serverStatus,
        enabled: true,
        host: cfg.host,
        port: cfg.port,
        latencyMs,
        version: versionResult.payload?.version || null,
        checks: {
          ps: { ok: psResult.ok, error: psResult.error || null },
          tags: { ok: tagsResult.ok, error: tagsResult.error || null },
          version: { ok: versionResult.ok, error: versionResult.error || null },
        },
        error: reachable ? null : (psResult.error || tagsResult.error || versionResult.error || 'unreachable'),
      },
      runtime: {
        runningModels: visibleRunningCount,
        totalModels: visibleModels.length,
        canAcceptRequests: reachable,
      },
      models: visibleModels,
      optimization: {
        enabled: cfg.optimization.enabled,
        current: cfg.optimization,
        recommendation,
        applyCommands: getApplyCommands(recommendation),
        platform: process.platform,
      },
      system: {
        cpu: {
          cores: cpuCores,
          load1: Number((loads[0] || 0).toFixed(2)),
          load5: Number((loads[1] || 0).toFixed(2)),
          load15: Number((loads[2] || 0).toFixed(2)),
          usagePercent: Number(approxCpuUsagePercent.toFixed(2)),
        },
        memory: {
          totalBytes: totalMem,
          freeBytes: freeMem,
          usedBytes: usedMem,
          usedPercent: Number(usedPercent.toFixed(2)),
        },
        node: { uptimeSeconds: Math.round(process.uptime()) },
        measuredAt: new Date().toISOString(),
      },
      gpu: getAppleGpuStats() || {
        available: false,
        platform: process.platform,
        limited: true,
        limitation: 'GPU telemetri bu buildde sınırlı',
        devices: [],
      },
    };

    recordModelTelemetry(visibleModels, payload);
    appendOllamaHistory({
      generatedAt: payload.generatedAt,
      healthScore: payload.healthScore,
      status: payload.server.status,
      latencyMs: payload.server.latencyMs,
      memoryUsedPercent: payload.system.memory.usedPercent,
      cpuUsagePercent: payload.system.cpu.usagePercent,
      gpuUtilPercent: payload.gpu?.devices?.[0]?.utilGpu ?? null,
      gpuMemoryPercent: (
        Number.isFinite(payload.gpu?.devices?.[0]?.memUsedMiB)
        && Number.isFinite(payload.gpu?.devices?.[0]?.memTotalMiB)
        && payload.gpu.devices[0].memTotalMiB > 0
      )
        ? Number(((payload.gpu.devices[0].memUsedMiB / payload.gpu.devices[0].memTotalMiB) * 100).toFixed(2))
        : null,
      runningModels: payload.runtime.runningModels,
      totalModels: payload.runtime.totalModels,
      alerts: payload.alerts,
    });

    ollamaTelemetryCache = payload;
    ollamaTelemetryCacheAt = Date.now();
    return res.json(payload);
  });

  router.get('/api/ollama/telemetry/history', (req, res) => {
    return res.json({ generatedAt: new Date().toISOString(), history: ollamaHistory, total: ollamaHistory.length });
  });

  router.get('/api/ollama/telemetry/models', async (req, res) => {
    const allowed = await getAllowedOllamaModels();
    return res.json(getModelTelemetrySnapshot(allowed));
  });

  router.post('/api/ollama/optimization', async (req, res) => {
    try {
      const body = req.body || {};
      const inferredLegacy = Object.prototype.hasOwnProperty.call(body, 'strategy') || Object.prototype.hasOwnProperty.call(body, 'keepAlive');
      const action = String(body.action || (inferredLegacy ? 'apply' : 'apply')).toLowerCase();
      const profile = normalizeOllamaOptimization(body.profile || (inferredLegacy ? body : {}));
      const current = normalizeOllamaOptimization(mcConfig?.ollama?.optimization || {});
      const dryRun = action === 'dry-run' || body.dryRun === true;

      if (action === 'rollback') {
        if (body.confirm !== true) return res.status(400).json({ error: 'confirm=true required for rollback' });
        if (!ollamaOptimizationBackup) return res.status(400).json({ error: 'No rollback backup available' });
        if (!mcConfig.ollama) mcConfig.ollama = {};
        mcConfig.ollama.optimization = normalizeOllamaOptimization(ollamaOptimizationBackup.profile || current);
        fs.writeFileSync(missionControlConfigPath, JSON.stringify(mcConfig, null, 2), 'utf8');
        const verify = await fetchJsonWithTiming(`${getOllamaConfig().baseUrl}/api/ps`, 2500);
        return res.json({
          success: true,
          action: 'rollback',
          optimization: mcConfig.ollama.optimization,
          verification: { ok: verify.ok, latencyMs: verify.latencyMs, error: verify.error || null },
          rollbackFrom: ollamaOptimizationBackup,
        });
      }

      const diff = {
        from: current,
        to: profile,
        changed: Object.keys(profile).filter((key) => JSON.stringify(profile[key]) !== JSON.stringify(current[key])),
        applyCommands: getApplyCommands(profile),
      };

      if (dryRun) {
        return res.json({ success: true, action: 'dry-run', diff, requiresConfirm: true });
      }

      if (body.confirm !== true && !inferredLegacy) {
        return res.status(400).json({ error: 'confirm=true required for apply (or use action=dry-run first)' });
      }

      ollamaOptimizationBackup = { profile: current, savedAt: new Date().toISOString() };
      if (!mcConfig.ollama) mcConfig.ollama = {};
      mcConfig.ollama.optimization = profile;
      fs.writeFileSync(missionControlConfigPath, JSON.stringify(mcConfig, null, 2), 'utf8');

      const verify = await fetchJsonWithTiming(`${getOllamaConfig().baseUrl}/api/ps`, 2500);
      return res.json({
        success: true,
        action: 'apply',
        optimization: profile,
        diff,
        verification: {
          ok: verify.ok,
          latencyMs: verify.latencyMs,
          error: verify.error || null,
        },
        rollbackAvailable: true,
      });
    } catch (error) {
      return res.status(500).json({ error: error.message || 'Failed to handle optimization request' });
    }
  });

  return router;
}

module.exports = {
  buildOllamaRouter,
};
