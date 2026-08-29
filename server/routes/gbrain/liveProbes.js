'use strict';

const http = require('http');
const https = require('https');
const {
  DEFAULT_SOURCE_FRESHNESS_HOURS,
  SOURCE_FRESHNESS_THRESHOLDS_HOURS,
  REQUIRED_GBRAIN_TOOLS,
} = require('./constants');
const {
  defaultExecFilePromise,
  sanitizeMessage,
  parseJsonFromOutput,
  runGBrain,
} = require('./commandRunner');

// ---------------------------------------------------------------------------
// Payload normalizers for tools, features, providers
// ---------------------------------------------------------------------------

function normalizeToolsPayload(payload, checkedAt) {
  const rawToolsSource = Array.isArray(payload) ? payload : payload?.tools || payload?.data || payload?.items || [];
  const rawTools = Array.isArray(rawToolsSource)
    ? rawToolsSource
    : rawToolsSource && typeof rawToolsSource === 'object'
    ? Object.entries(rawToolsSource).map(([id, value]) => (value && typeof value === 'object' ? { id, ...value } : id))
    : [];
  const toolNames = rawTools
    .map((tool) => String(typeof tool === 'string' ? tool : tool?.name || tool?.id || '').trim())
    .filter(Boolean);
  const toolSet = new Set(toolNames);
  const requiredTools = REQUIRED_GBRAIN_TOOLS.map((tool) => ({
    ...tool,
    present: toolSet.has(tool.id),
  }));
  const presentCount = requiredTools.filter((tool) => tool.present).length;

  return {
    ok: toolNames.length > 0,
    mode: 'live-read-only',
    checkedAt,
    count: toolNames.length,
    presentCount,
    requiredCount: requiredTools.length,
    missingCount: requiredTools.length - presentCount,
    requiredTools,
  };
}

function normalizeFeaturesPayload(payload, checkedAt) {
  const recommendations = Array.isArray(payload?.recommendations) ? payload.recommendations : [];
  return {
    ok: true,
    mode: 'live-read-only',
    checkedAt,
    version: sanitizeMessage(payload?.version || ''),
    brainScore: Number.isFinite(Number(payload?.brain_score)) ? Number(payload.brain_score) : null,
    recommendations: recommendations.map((item) => ({
      id: sanitizeMessage(item?.id || 'feature-gap'),
      priority: Number.isFinite(Number(item?.priority)) ? Number(item.priority) : null,
      title: sanitizeMessage(item?.title || 'Feature recommendation'),
      pitch: sanitizeMessage(item?.pitch || ''),
      command: sanitizeMessage(item?.command || ''),
      severity: item?.id === 'no-integrations' ? 'optional' : 'warning',
    })),
  };
}

function normalizeProvidersPayload(payload, checkedAt) {
  const options = Array.isArray(payload?.options) ? payload.options : [];
  const chatOptions = options
    .filter((item) => item?.touchpoint === 'chat')
    .map((item) => ({
      id: sanitizeMessage(item?.id || ''),
      envReady: item?.env_ready === true,
      tier: sanitizeMessage(item?.tier || ''),
    }))
    .filter((item) => item.id);
  const readyChatOptions = chatOptions.filter((item) => item.envReady);
  return {
    ok: true,
    mode: 'live-read-only',
    checkedAt,
    chatOptions,
    readyChatCount: readyChatOptions.length,
    readyChatProviders: readyChatOptions.map((item) => item.id),
  };
}

// ---------------------------------------------------------------------------
// Hermes proxy probe
// ---------------------------------------------------------------------------

function defaultHermesProxyBaseUrl(processEnv = process.env) {
  return processEnv.HERMES_PROXY_BASE_URL || processEnv.HERMES_PROXY_URL || 'http://127.0.0.1:8645';
}

function probeJsonEndpoint(url, timeoutMs = 2000) {
  return new Promise((resolve) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch (error) {
      resolve({ ok: false, error: 'invalid URL' });
      return;
    }
    const client = parsed.protocol === 'https:' ? https : http;
    const request = client.get(parsed, { timeout: timeoutMs }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        body += chunk;
        if (body.length > 4096) request.destroy();
      });
      response.on('end', () => {
        let payload = null;
        try { payload = body ? JSON.parse(body) : null; } catch (_) { payload = null; }
        resolve({ ok: response.statusCode >= 200 && response.statusCode < 300, statusCode: response.statusCode, payload });
      });
    });
    request.on('timeout', () => request.destroy(new Error('timeout')));
    request.on('error', (error) => resolve({ ok: false, error: error.message }));
  });
}

async function buildLiveHermesProxyStatus(options = {}) {
  const processEnv = options.processEnv || process.env;
  const checkedAt = new Date().toISOString();
  const baseUrl = String(options.hermesProxyBaseUrl || defaultHermesProxyBaseUrl(processEnv)).replace(/\/v1\/?$/, '').replace(/\/$/, '');
  const result = await probeJsonEndpoint(`${baseUrl}/health`, options.hermesProxyTimeoutMs || 2000);
  const authenticated = result.payload?.authenticated === true;
  const upstream = sanitizeMessage(result.payload?.upstream || 'Hermes proxy');
  return {
    ok: result.ok && authenticated,
    mode: 'live-read-only',
    checkedAt,
    status: result.ok && authenticated ? 'healthy' : 'warning',
    label: result.ok && authenticated ? 'Hermes proxy ready' : 'Hermes proxy unavailable',
    detail: result.ok && authenticated
      ? `${upstream} local proxy authenticated`
      : `Hermes proxy health probe failed${result.error ? `: ${sanitizeMessage(result.error)}` : ''}`,
  };
}

// ---------------------------------------------------------------------------
// Live GBrain probes: tools, features, providers
// ---------------------------------------------------------------------------

async function buildLiveGBrainTools(options = {}) {
  const execFilePromise = options.execFilePromise || defaultExecFilePromise;
  const checkedAt = new Date().toISOString();
  const result = await runGBrain(execFilePromise, ['--tools-json'], { suppressStartupHooks: true });
  const payload = parseJsonFromOutput(result.stdout);
  if (result.ok && payload) return normalizeToolsPayload(payload, checkedAt);
  return {
    ok: false,
    mode: 'live-read-only',
    checkedAt,
    status: 'unavailable',
    error: result.error || 'gbrain --tools-json did not return parseable output',
    requiredTools: REQUIRED_GBRAIN_TOOLS.map((tool) => ({ ...tool, present: false })),
  };
}

async function buildLiveGBrainFeatures(options = {}) {
  const execFilePromise = options.execFilePromise || defaultExecFilePromise;
  const checkedAt = new Date().toISOString();
  const result = await runGBrain(execFilePromise, ['features', '--json'], { suppressStartupHooks: true });
  const payload = parseJsonFromOutput(result.stdout);
  if (result.ok && payload) return normalizeFeaturesPayload(payload, checkedAt);
  return {
    ok: false,
    mode: 'live-read-only',
    checkedAt,
    status: 'unavailable',
    error: result.error || 'gbrain features --json did not return parseable output',
    recommendations: [],
  };
}

async function buildLiveGBrainProviders(options = {}) {
  const execFilePromise = options.execFilePromise || defaultExecFilePromise;
  const checkedAt = new Date().toISOString();
  const result = await runGBrain(execFilePromise, ['providers', 'explain', '--json'], { suppressStartupHooks: true });
  const payload = parseJsonFromOutput(result.stdout);
  if (result.ok && payload) return normalizeProvidersPayload(payload, checkedAt);
  return {
    ok: false,
    mode: 'live-read-only',
    checkedAt,
    status: 'unavailable',
    error: result.error || 'gbrain providers explain --json did not return parseable output',
    chatOptions: [],
    readyChatCount: 0,
    readyChatProviders: [],
  };
}

// ---------------------------------------------------------------------------
// Health / sources / version builders (large section)
// ---------------------------------------------------------------------------

function findNumber(payload, keys) {
  const wanted = new Set(keys.map((key) => key.toLowerCase()));
  const seen = new Set();
  const stack = [payload];

  while (stack.length) {
    const item = stack.pop();
    if (!item || typeof item !== 'object' || seen.has(item)) continue;
    seen.add(item);

    if (Array.isArray(item)) {
      for (const child of item) stack.push(child);
      continue;
    }

    for (const [key, value] of Object.entries(item)) {
      if (wanted.has(key.toLowerCase())) {
        const number = Number(value);
        if (Number.isFinite(number)) return number;
      }
      if (value && typeof value === 'object') stack.push(value);
    }
  }

  return null;
}

function findString(payload, keys) {
  const wanted = new Set(keys.map((key) => key.toLowerCase()));
  const seen = new Set();
  const stack = [payload];

  while (stack.length) {
    const item = stack.pop();
    if (!item || typeof item !== 'object' || seen.has(item)) continue;
    seen.add(item);

    if (Array.isArray(item)) {
      for (const child of item) stack.push(child);
      continue;
    }

    for (const [key, value] of Object.entries(item)) {
      if (wanted.has(key.toLowerCase()) && typeof value === 'string') return value;
      if (value && typeof value === 'object') stack.push(value);
    }
  }

  return '';
}

function formatCount(value) {
  return Number.isFinite(value) ? new Intl.NumberFormat('en-US').format(value) : '—';
}

function formatPercent(value) {
  if (!Number.isFinite(value)) return '—';
  const percent = value <= 1 ? value * 100 : value;
  return `${Math.round(percent)}%`;
}

function parseVersionOutput(output) {
  const text = String(output || '').trim();
  const match = text.match(/(?:gbrain\s+)?v?(\d+\.\d+\.\d+(?:\.\d+)?(?:[-+][A-Za-z0-9._-]+)?)/i);
  return match ? match[1] : '';
}

function normalizeSourceKey(value) {
  return String(value || '').replace(/[^a-z0-9]/gi, '').toLowerCase();
}

function freshnessThresholdHours(sourceId, thresholds = SOURCE_FRESHNESS_THRESHOLDS_HOURS) {
  const key = normalizeSourceKey(sourceId);
  const foundKey = Object.keys(thresholds).find((candidate) => normalizeSourceKey(candidate) === key);
  const value = Number(thresholds[foundKey] ?? thresholds.default ?? DEFAULT_SOURCE_FRESHNESS_HOURS);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_SOURCE_FRESHNESS_HOURS;
}

function parseTimestamp(value) {
  if (!value) return null;
  const ms = Date.parse(String(value));
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

function isSyncTrackedSource(source) {
  const id = normalizeSourceKey(source?.id || source?.name || source?.source);
  const localPath = source?.local_path || source?.localPath || source?.path || source?.repoPath || source?.repo_path || null;
  const syncEnabled = source?.sync_enabled ?? source?.syncEnabled;
  if (syncEnabled === false) return false;
  if (id === 'default' && !localPath) return false;
  if (source?.federated === false && !localPath) return false;
  return true;
}

function sourceFreshnessStatus(source, lastSyncAt, checkedAt, thresholds = SOURCE_FRESHNESS_THRESHOLDS_HOURS) {
  const sourceId = source?.id || source?.name || source?.source;
  const thresholdHours = freshnessThresholdHours(sourceId, thresholds);
  const parsedLastSyncAt = parseTimestamp(lastSyncAt);
  const checkedMs = Date.parse(checkedAt);
  const lastSyncMs = parsedLastSyncAt ? Date.parse(parsedLastSyncAt) : NaN;
  if (!isSyncTrackedSource(source)) {
    return {
      status: 'inactive',
      label: 'Sync timestamp not applicable',
      ageHours: null,
      thresholdHours,
      lastSyncAt: parsedLastSyncAt,
      syncTracked: false,
    };
  }
  if (!Number.isFinite(checkedMs) || !Number.isFinite(lastSyncMs)) {
    return {
      status: 'warning',
      label: 'No sync timestamp',
      ageHours: null,
      thresholdHours,
      lastSyncAt: parsedLastSyncAt,
      syncTracked: true,
    };
  }

  const ageHours = Math.max(0, (checkedMs - lastSyncMs) / (60 * 60 * 1000));
  const stale = ageHours > thresholdHours;
  return {
    status: stale ? 'warning' : 'healthy',
    label: stale ? `Stale over ${thresholdHours}h` : `Fresh under ${thresholdHours}h`,
    ageHours: Number(ageHours.toFixed(1)),
    thresholdHours,
    lastSyncAt: parsedLastSyncAt,
    syncTracked: true,
  };
}

function summarizeSourceFreshness(sources, checkedAt) {
  const items = Array.isArray(sources) ? sources : [];
  const trackedItems = items.filter((source) => source.freshness?.syncTracked !== false);
  const stale = trackedItems.filter((source) => source.freshness?.status === 'warning');
  const fresh = trackedItems.filter((source) => source.freshness?.status === 'healthy');
  const untracked = items.filter((source) => source.freshness?.syncTracked === false);
  const oldest = trackedItems
    .filter((source) => Number.isFinite(source.freshness?.ageHours))
    .sort((a, b) => b.freshness.ageHours - a.freshness.ageHours)[0] || null;

  return {
    status: stale.length > 0 ? 'warning' : trackedItems.length > 0 ? 'healthy' : 'inactive',
    checkedAt,
    defaultThresholdHours: DEFAULT_SOURCE_FRESHNESS_HOURS,
    staleCount: stale.length,
    freshCount: fresh.length,
    unknownCount: trackedItems.length - stale.length - fresh.length,
    untrackedCount: untracked.length,
    oldestSourceId: oldest?.id || null,
    oldestAgeHours: Number.isFinite(oldest?.freshness?.ageHours) ? oldest.freshness.ageHours : null,
    staleSources: stale.map((source) => ({
      id: source.id,
      status: source.status,
      lastSyncAt: source.freshness.lastSyncAt,
      ageHours: source.freshness.ageHours,
      thresholdHours: source.freshness.thresholdHours,
      label: source.freshness.label,
    })),
  };
}

function liveHealthStatus(liveHealth, healthUnavailable = false) {
  if (healthUnavailable) return 'warning';
  if (!liveHealth) return 'warning';
  const rawStatus = String(liveHealth.status || '').toLowerCase();
  const score = Number(liveHealth.score);
  const stalePages = Number(liveHealth.metrics?.stalePages);
  const missingEmbeddings = Number(liveHealth.metrics?.missingEmbeddings);
  if (/critical|fail|error|unavailable/.test(rawStatus)) return 'critical';
  if (Number.isFinite(score) && score < 90) return 'warning';
  if (Number.isFinite(stalePages) && stalePages > 0) return 'warning';
  if (Number.isFinite(missingEmbeddings) && missingEmbeddings > 0) return 'warning';
  if (/warn|degrad|unknown/.test(rawStatus)) return 'warning';
  return 'healthy';
}

function liveSourceStatus(liveSources, sourcesUnavailable = false) {
  if (sourcesUnavailable) return 'warning';
  if (!liveSources) return 'warning';
  if (liveSources.freshness?.status === 'warning') return 'warning';
  if (liveSources.warningCount > 0) return 'warning';
  if (liveSources.count > 0) return 'healthy';
  return 'warning';
}

function isHealthySourceStatus(status) {
  const lower = String(status || '').toLowerCase();
  if (/never[-_\s]?synced/.test(lower)) return false;
  return /\b(ok|clean|healthy|synced|isolated)\b/.test(lower);
}

function isWarningSourceStatus(status) {
  const lower = String(status || '').toLowerCase();
  if (!lower) return true;
  if (/warn|corrupt|dirty|missing|error|fail|never[-_\s]?synced/i.test(lower)) return true;
  return !isHealthySourceStatus(lower);
}

function numberFromText(text, pattern) {
  const match = String(text || '').match(pattern);
  if (!match) return null;
  const value = Number(String(match[1]).replace(/,/g, ''));
  return Number.isFinite(value) ? value : null;
}

function normalizeHealthScore(score) {
  if (score === null || score === undefined) return null;
  const value = Number(score);
  if (!Number.isFinite(value)) return null;
  return value > 0 && value <= 10 ? value * 10 : value;
}

function normalizeHealthPayload(healthPayload, jobsPayload, checkedAt) {
  const score = normalizeHealthScore(findNumber(healthPayload, ['brain_score', 'brainScore', 'health_score', 'healthScore', 'score']));
  const pages = findNumber(healthPayload, ['pages', 'page_count', 'total_pages']);
  const chunks = findNumber(healthPayload, ['chunks', 'chunk_count', 'total_chunks']);
  const embedded = findNumber(healthPayload, ['embedded', 'embedded_chunks', 'embedded_count']);
  const missing = findNumber(healthPayload, ['missing_embeddings', 'missingEmbeddings', 'missing']);
  const stalePages = findNumber(healthPayload, ['stale_pages', 'stalePages', 'stale']);
  const coverage = findNumber(healthPayload, ['embed_coverage', 'embedding_coverage', 'coverage']);
  const waiting = findNumber(jobsPayload, ['waiting', 'queued', 'pending']);
  const active = findNumber(jobsPayload, ['active', 'running', 'processing']);
  const stalled = findNumber(jobsPayload, ['stalled', 'dead']);
  const rawStatus = findString(healthPayload, ['status', 'health_status']);
  const status = rawStatus || (
    stalePages > 0
      ? 'stale'
      : score !== null
        ? score >= 90 ? 'healthy' : 'warning'
        : 'unknown'
  );

  return {
    ok: true,
    mode: 'live-read-only',
    checkedAt,
    status,
    score,
    metrics: {
      pages,
      chunks,
      embedded,
      missingEmbeddings: missing,
      stalePages,
      embeddingCoverage: coverage,
      queue: { waiting, active, stalled },
    },
  };
}

function normalizeHealthText(healthOutput, jobsOutput, checkedAt) {
  const healthText = String(healthOutput || '');
  const jobsText = String(jobsOutput || '');
  const score = numberFromText(healthText, /Health score:\s*(\d+(?:\.\d+)?)\s*\/\s*10/i);
  const coveragePercent = numberFromText(healthText, /Embed coverage:\s*(\d+(?:\.\d+)?)%/i);
  const missing = numberFromText(healthText, /Missing embeddings:\s*(\d+)/i);
  const stalePages = numberFromText(healthText, /Stale pages:\s*(\d+)/i);
  const waiting = numberFromText(jobsText, /Queue health:\s*(\d+)\s+waiting/i);
  const active = numberFromText(jobsText, /Queue health:\s*\d+\s+waiting,\s*(\d+)\s+active/i);
  const stalled = numberFromText(jobsText, /Queue health:\s*\d+\s+waiting,\s*\d+\s+active,\s*(\d+)\s+stalled/i);

  if (score === null && coveragePercent === null && missing === null && stalePages === null) return null;

  return {
    ok: true,
    mode: 'live-read-only',
    checkedAt,
    status: stalePages > 0 ? 'stale' : score !== null && score >= 7 ? 'healthy' : 'warning',
    score: score !== null ? score * 10 : null,
    metrics: {
      pages: null,
      chunks: null,
      embedded: null,
      missingEmbeddings: missing,
      stalePages,
      embeddingCoverage: coveragePercent !== null ? coveragePercent : null,
      queue: { waiting, active, stalled },
    },
  };
}

function normalizeStatsPayload(statsPayload) {
  if (!statsPayload) return null;
  return {
    pages: findNumber(statsPayload, ['pages', 'page_count', 'pageCount', 'total_pages', 'totalPages']),
    chunks: findNumber(statsPayload, ['chunks', 'chunk_count', 'chunkCount', 'total_chunks', 'totalChunks']),
    embedded: findNumber(statsPayload, ['embedded', 'embedded_chunks', 'embeddedChunks', 'embedded_count', 'embeddedCount']),
  };
}

function normalizeStatsText(statsOutput) {
  const text = String(statsOutput || '');
  const stats = {
    pages: numberFromText(text, /Pages:\s*([\d,]+)/i),
    chunks: numberFromText(text, /Chunks:\s*([\d,]+)/i),
    embedded: numberFromText(text, /Embedded:\s*([\d,]+)/i),
  };
  return Object.values(stats).some((value) => value !== null) ? stats : null;
}

function mergeStatsIntoHealth(health, stats) {
  if (!health?.ok || !stats) return health;
  return {
    ...health,
    metrics: {
      ...health.metrics,
      pages: stats.pages ?? health.metrics?.pages ?? null,
      chunks: stats.chunks ?? health.metrics?.chunks ?? null,
      embedded: stats.embedded ?? health.metrics?.embedded ?? null,
    },
  };
}

function needsStatsBackfill(health) {
  if (!health?.ok) return false;
  return health.metrics?.pages === null || health.metrics?.chunks === null || health.metrics?.embedded === null;
}

async function buildLiveGBrainStats(options = {}) {
  const execFilePromise = options.execFilePromise || defaultExecFilePromise;
  const result = await runGBrain(execFilePromise, ['stats', '--source', '__all__', '--json'], { suppressStartupHooks: true });
  const payload = parseJsonFromOutput(result.stdout);
  if (result.ok && payload) return normalizeStatsPayload(payload);
  const textStats = normalizeStatsText(result.stdout);
  if (result.ok && textStats) return textStats;
  const fallbackResult = await runGBrain(execFilePromise, ['stats', '--source', '__all__'], { suppressStartupHooks: true });
  const fallbackPayload = parseJsonFromOutput(fallbackResult.stdout);
  if (fallbackResult.ok && fallbackPayload) return normalizeStatsPayload(fallbackPayload);
  return fallbackResult.ok ? normalizeStatsText(fallbackResult.stdout) : null;
}

function normalizeSourcesPayload(payload, checkedAt) {
  const rawSources = Array.isArray(payload)
    ? payload
    : payload?.sources || payload?.data || payload?.items || [];
  const sources = rawSources
    .filter((source) => source && typeof source === 'object')
    .map((source) => {
      const pages = Number.isFinite(Number(source.pages || source.page_count)) ? Number(source.pages || source.page_count) : null;
      const reportedStatus = source.status || source.clone_state || source.cloneState;
      const status = reportedStatus
        || (source.last_sync_at ? 'synced' : source.federated === false ? 'isolated' : 'unknown');
      const lastSyncAt = parseTimestamp(
        source.last_sync_at
        || source.lastSyncAt
        || source.last_synced_at
        || source.lastSyncedAt
        || source.synced_at
        || source.syncedAt
        || source.updated_at
        || source.updatedAt,
      );
      const rawSyncEnabled = source.sync_enabled ?? source.syncEnabled;
      const syncEnabled = typeof rawSyncEnabled === 'boolean' ? rawSyncEnabled : null;
      const freshness = sourceFreshnessStatus(source, lastSyncAt, checkedAt);
      return {
        id: String(source.id || source.name || source.source || 'unknown'),
        status: String(status),
        statusReported: Boolean(reportedStatus),
        pages,
        chunks: Number.isFinite(Number(source.chunks || source.chunk_count)) ? Number(source.chunks || source.chunk_count) : null,
        lastSyncAt,
        syncEnabled,
        freshness,
      };
    })
    .filter((source) => source.id && source.id !== 'unknown');
  const totalPages = sources.reduce((sum, source) => sum + (source.pages || 0), 0);
  const freshness = summarizeSourceFreshness(sources, checkedAt);
  const statusWarningCount = sources.filter(
    (source) => source.freshness?.syncTracked === false
      ? source.statusReported && isWarningSourceStatus(source.status)
      : isWarningSourceStatus(source.status),
  ).length;

  return {
    ok: true,
    mode: 'live-read-only',
    checkedAt,
    count: sources.length,
    totalPages,
    healthyCount: sources.filter((source) => isHealthySourceStatus(source.status)).length,
    warningCount: statusWarningCount,
    freshness,
    sources,
  };
}

function normalizeSourcesText(output, checkedAt) {
  const sources = String(output || '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !/^id\b|^-+|SOURCES/i.test(line))
    .map((line) => {
      const columns = line.split(/\s+/);
      const id = columns[0] || '';
      if (!id || id.includes('/') || id === 'sources' || id.startsWith('─')) return null;
      const pageMatch = line.match(/\s(\d[\d,]*)\s+pages\b/i);
      const syncMatch = line.match(/last sync\s+([^\s]+)/i);
      const synced = Boolean(syncMatch);
      const neverSynced = /never synced/i.test(line);
      const statusColumn = columns.find((column) => /ok|clean|healthy|synced|warn|corrupt|dirty|missing|error|fail/i.test(column));
      const kind = columns.find((column, index) => index > 0 && !column.includes('/')) || 'unknown';
      const status = neverSynced ? 'never-synced' : synced ? 'synced' : statusColumn || kind;
      const lastSyncAt = synced ? parseTimestamp(syncMatch[1]) : null;
      const freshness = sourceFreshnessStatus({ id }, lastSyncAt, checkedAt);
      return {
        id,
        status,
        pages: pageMatch ? Number(pageMatch[1].replace(/,/g, '')) : null,
        chunks: null,
        lastSyncAt,
        freshness,
      };
    })
    .filter(Boolean);
  const totalPages = sources.reduce((sum, source) => sum + (source.pages || 0), 0);
  const freshness = summarizeSourceFreshness(sources, checkedAt);
  const statusWarningCount = sources.filter((source) => isWarningSourceStatus(source.status)).length;

  return {
    ok: sources.length > 0,
    mode: 'live-read-only',
    checkedAt,
    count: sources.length,
    totalPages,
    healthyCount: sources.filter((source) => isHealthySourceStatus(source.status)).length,
    warningCount: statusWarningCount,
    freshness,
    sources,
  };
}

async function buildLiveGBrainHealth(options = {}) {
  const execFilePromise = options.execFilePromise || defaultExecFilePromise;
  const checkedAt = new Date().toISOString();
  // Keep each top-level probe to one child command. The overview scheduler may
  // run two probes concurrently; a nested health fan-out would otherwise allow
  // three simultaneous GBrain subprocesses and defeat that database bound.
  const healthResult = await runGBrain(execFilePromise, ['call', '--source', '__all__', 'get_health'], { suppressStartupHooks: true });
  const jobsResult = await runGBrain(execFilePromise, ['jobs', 'stats', '--json'], { suppressStartupHooks: true });
  const healthPayload = parseJsonFromOutput(healthResult.stdout);
  const jobsPayload = parseJsonFromOutput(jobsResult.stdout) || {
    waiting: numberFromText(jobsResult.stdout, /Queue health:\s*(\d+)\s+waiting/i),
    active: numberFromText(jobsResult.stdout, /Queue health:\s*\d+\s+waiting,\s*(\d+)\s+active/i),
    stalled: numberFromText(jobsResult.stdout, /Queue health:\s*\d+\s+waiting,\s*\d+\s+active,\s*(\d+)\s+stalled/i),
  };

  if (healthResult.ok && healthPayload) {
    const health = normalizeHealthPayload(healthPayload, jobsPayload, checkedAt);
    return needsStatsBackfill(health) ? mergeStatsIntoHealth(health, await buildLiveGBrainStats(options)) : health;
  }

  const fallbackHealthResult = await runGBrain(execFilePromise, ['health', '--source', '__all__', '--json'], { suppressStartupHooks: true });
  const fallbackPayload = parseJsonFromOutput(fallbackHealthResult.stdout);
  if (fallbackHealthResult.ok && fallbackPayload) {
    const health = normalizeHealthPayload(fallbackPayload, jobsPayload, checkedAt);
    return needsStatsBackfill(health) ? mergeStatsIntoHealth(health, await buildLiveGBrainStats(options)) : health;
  }

  const textHealth = fallbackHealthResult.ok ? normalizeHealthText(fallbackHealthResult.stdout, jobsResult.stdout, checkedAt) : null;
  if (!textHealth?.ok) {
    return {
      ok: false,
      mode: 'live-read-only',
      checkedAt,
      status: 'unavailable',
      error: healthResult.error || fallbackHealthResult.error || 'gbrain health did not return JSON',
    };
  }

  return needsStatsBackfill(textHealth) ? mergeStatsIntoHealth(textHealth, await buildLiveGBrainStats(options)) : textHealth;
}

async function buildLiveGBrainSources(options = {}) {
  const execFilePromise = options.execFilePromise || defaultExecFilePromise;
  const checkedAt = new Date().toISOString();
  const result = await runGBrain(execFilePromise, ['sources', 'list', '--json'], { suppressStartupHooks: true });
  const payload = parseJsonFromOutput(result.stdout);

  if (result.ok && payload) {
    return normalizeSourcesPayload(payload, checkedAt);
  }

  const fallbackResult = await runGBrain(execFilePromise, ['sources', 'list'], { suppressStartupHooks: true });
  const textSources = fallbackResult.ok ? normalizeSourcesText(fallbackResult.stdout, checkedAt) : null;
  if (!textSources?.ok) {
    return {
      ok: false,
      mode: 'live-read-only',
      checkedAt,
      status: 'unavailable',
      error: result.error || fallbackResult?.error || 'gbrain sources list did not return parseable output',
      sources: [],
    };
  }

  return textSources;
}

async function buildLiveGBrainVersion(options = {}) {
  const execFilePromise = options.execFilePromise || defaultExecFilePromise;
  const checkedAt = new Date().toISOString();
  const result = await runGBrain(execFilePromise, ['--version'], { suppressStartupHooks: true });
  const version = parseVersionOutput(result.stdout || result.stderr);

  if (result.ok && version) {
    return {
      ok: true,
      mode: 'live-read-only',
      checkedAt,
      version,
      source: 'gbrain --version',
    };
  }

  return {
    ok: false,
    mode: 'live-read-only',
    checkedAt,
    status: 'unavailable',
    error: result.error || 'gbrain --version did not return a parseable version',
  };
}

module.exports = {
  normalizeToolsPayload,
  normalizeFeaturesPayload,
  normalizeProvidersPayload,
  defaultHermesProxyBaseUrl,
  probeJsonEndpoint,
  buildLiveHermesProxyStatus,
  buildLiveGBrainTools,
  buildLiveGBrainFeatures,
  buildLiveGBrainProviders,
  findNumber,
  findString,
  formatCount,
  formatPercent,
  parseVersionOutput,
  normalizeSourceKey,
  freshnessThresholdHours,
  parseTimestamp,
  isSyncTrackedSource,
  sourceFreshnessStatus,
  summarizeSourceFreshness,
  liveHealthStatus,
  liveSourceStatus,
  isHealthySourceStatus,
  isWarningSourceStatus,
  numberFromText,
  normalizeHealthScore,
  normalizeHealthPayload,
  normalizeHealthText,
  normalizeStatsPayload,
  normalizeStatsText,
  mergeStatsIntoHealth,
  needsStatsBackfill,
  buildLiveGBrainStats,
  normalizeSourcesPayload,
  normalizeSourcesText,
  buildLiveGBrainHealth,
  buildLiveGBrainSources,
  buildLiveGBrainVersion,
};
