'use strict';

const http = require('http');
const https = require('https');
const {
  DEFAULT_SOURCE_FRESHNESS_HOURS,
  SOURCE_FRESHNESS_THRESHOLDS_HOURS,
  REQUIRED_GBRAIN_TOOLS,
  HEALTH_PROBE_SOFT_TIMEOUT_MS,
  EMBED_JOB_PROBE_BUDGET_MS,
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
  const id = normalizeSourceKey(source?.source_id || source?.id || source?.name || source?.source);
  const localPath = source?.local_path || source?.localPath || source?.path || source?.repoPath || source?.repo_path || null;
  const syncEnabled = source?.sync_enabled ?? source?.syncEnabled;
  if (syncEnabled === false) return false;
  if (id === 'default' && !localPath) return false;
  if (source?.federated === false && !localPath) return false;
  return true;
}

function sourceFreshnessStatus(source, lastSyncAt, checkedAt, thresholds = SOURCE_FRESHNESS_THRESHOLDS_HOURS) {
  const sourceId = source?.source_id || source?.id || source?.name || source?.source;
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
  const stalePages = Number(liveHealth.metrics?.stalePagesOverdue ?? liveHealth.metrics?.stalePages);
  // Only overdue missing embeddings are verdict-bearing; health objects
  // without missingEmbeddingsOverdue treat every missing embedding as overdue.
  const missingEmbeddings = Number(liveHealth.metrics?.missingEmbeddingsOverdue ?? liveHealth.metrics?.missingEmbeddings);
  if (/critical|fail|error|unavailable/.test(rawStatus)) return 'critical';
  if (liveHealth.metrics?.stalePagesUnavailable === true) return 'warning';
  if (liveHealth.metrics?.missingEmbeddingsUnavailable === true) return 'warning';
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

// Stale-page tolerance. GBrain's autopilot runs an extract-stale-sweep every
// tick (600s), so pages written since the last sweep are normally stale for
// up to ~10 min. Calibration: 1200s = 2 ticks (design-derived from the 600s
// cadence; sweep job itself ~5s). Review if the tick interval changes or if
// probes show catching-up ages near the limit. Without a valid lag from the
// same health record (older GBrain, null, non-number, negative), any stale
// page stays overdue (fail-closed).
const STALE_PAGES_LAG_TOLERANCE_SECONDS = 1200;

function isValidLag(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

// Missing-embedding tolerance. New chunks are embedded by the autopilot embed
// step, which runs every tick (600s), so a write normally shows up as a
// missing embedding until the next tick.
// Calibration note: value 1200s. Basis: live measurement over 2 days (1,495
// page writes): write-to-embed lag p50 0s, p90 118s, p99 542s, max 1736s;
// 0.2% of writes exceeded 1200s; autopilot tick 600s. Expected overdue rate
// <= 0.5% of probes. Review if the first live observations show a higher
// overdue rate or the tick interval changes. Without a valid oldest age from
// the same health record (older GBrain, null, non-number, negative), any
// missing embedding stays overdue (fail-closed).
const MISSING_EMBEDDINGS_LAG_TOLERANCE_SECONDS = 1200;

// All-or-nothing on the OLDEST item's age: inside the tolerance the whole
// raw count is catching up, beyond it (or without a valid age) all of it is
// overdue.
function splitByOldestAge(count, oldestAgeSeconds, toleranceSeconds) {
  if (!Number.isFinite(count) || count <= 0) {
    return { overdue: count, catchingUp: 0 };
  }
  if (isValidLag(oldestAgeSeconds) && oldestAgeSeconds <= toleranceSeconds) {
    return { overdue: 0, catchingUp: count };
  }
  return { overdue: count, catchingUp: 0 };
}

function splitStalePages(stalePages, oldestLagSeconds) {
  return splitByOldestAge(stalePages, oldestLagSeconds, STALE_PAGES_LAG_TOLERANCE_SECONDS);
}

function splitMissingEmbeddings(missingEmbeddings, oldestAgeSeconds) {
  return splitByOldestAge(missingEmbeddings, oldestAgeSeconds, MISSING_EMBEDDINGS_LAG_TOLERANCE_SECONDS);
}

// Embed-job health signal. The age rule alone cannot see a stuck embedder
// whose pages keep being rewritten (young age), nor a failing embedder inside
// the tolerance window. When missing embeddings > 0 the verdict is OVERDUE if
// the age rule says so, OR the most recent terminal embed / embed-catch-up job
// in the autopilot queue failed / is dead / completed with result.failures > 0,
// OR an embed job in that queue has been waiting longer than
// EMBED_JOB_WAITING_TOLERANCE_MINUTES. The job signal can only ADD overdue,
// never remove it: when it cannot be established (probe failed, timed out,
// unparseable, malformed rows, no terminal job at all) the verdict is the age
// rule alone and a caveat says so.
//
// Producer seam (GBrain list_jobs): filters by name / status / queue, then
// ORDER BY created_at DESC LIMIT. A plain name query can therefore return only
// newer non-terminal rows and hide the latest terminal one, so the terminal
// job is fetched explicitly per (name, status) (see
// EMBED_JOB_TERMINAL_PAGE_LIMIT) and the newest by finished_at wins. Queue scope is EMBED_JOB_QUEUE (where autopilot embed jobs
// run) so a foreign-queue job can neither clear a failure nor add waiting.
// `jobs stats` by_type is GLOBAL across queues, so it is only used as a
// pre-filter: the default-queue waiting set is a subset of the global one, so
// a global "nothing waiting over the tolerance" clears it without a call;
// otherwise the queue-scoped waiting list decides.
//
// Calibration note: 20m waiting = 2 autopilot ticks (600s) — an embed job
// queued across two ticks without being claimed means the worker is not
// draining; review with the first live observations (expected ~0% of probes).
const EMBED_JOB_NAMES = ['embed', 'embed-catch-up'];
const EMBED_JOB_QUEUE = 'default';
const EMBED_JOB_TERMINAL_STATUSES = ['completed', 'failed', 'dead'];
const EMBED_JOB_WAITING_TOLERANCE_MINUTES = 20;
const EMBED_JOB_WAITING_LIST_LIMIT = 50;
// Terminal rows fetched per (name, status). GBrain orders by created_at DESC
// BEFORE the limit, so with worker concurrency > 1 a later-FINISHED job can be
// older-created than the rows returned. Several rows per status are read and
// the newest finished_at across all of them wins; a FULL page can hide an
// older-created job, which could only have finished after the chosen latest
// if it ran for at least (latest finished_at - oldest created_at on that
// page). When that span is below EMBED_JOB_MAX_RUNTIME_MS the page may be
// hiding the true latest -> signal unavailable, never clean.
// Calibration note: 10 rows ~ 100 min of 600s ticks per status, so a full
// page normally spans > 60 min; 60 min is the assumed max embed job runtime
// (autopilot tick 600s; embed has no default handler timeout in GBrain).
// A job running longer than that is outside this model (residual: disclosed).
const EMBED_JOB_TERMINAL_PAGE_LIMIT = 10;
const EMBED_JOB_MAX_RUNTIME_MS = 60 * 60 * 1000;

function clockText(ms) {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

// True when the GLOBAL by_type row proves no `name` job waits longer than the
// tolerance in any queue (hence not in EMBED_JOB_QUEUE either).
function globalWaitingClears(jobsPayload, name) {
  const byType = jobsPayload && typeof jobsPayload === 'object' ? jobsPayload.by_type : undefined;
  if (!Array.isArray(byType)) return false;
  const rows = byType.filter((entry) => entry && entry.name === name);
  if (rows.length === 0) return true;
  if (rows.length > 1) return false;
  const [{ waiting_now: waitingNow, oldest_waiting_minutes: oldest }] = rows;
  if (!isFiniteNumber(waitingNow) || waitingNow < 0) return false;
  if (waitingNow === 0) return true;
  // GBrain publishes Math.round(seconds / 60): a published 20 can be 20m29s.
  // Only a published value <= tolerance - 1 (true age < 19m30s) clears.
  return isFiniteNumber(oldest) && oldest >= 0 && oldest <= EMBED_JOB_WAITING_TOLERANCE_MINUTES - 1;
}

function isQueueJob(job, name, status) {
  return Boolean(job) && typeof job === 'object' && !Array.isArray(job)
    && job.name === name && job.status === status && job.queue === EMBED_JOB_QUEUE;
}

// embedJobs: result of probeEmbedJobs ({ available: true, terminal: {name:
// {status: [job]}}, waiting: {name: [job]} }) or { available: false } /
// undefined. Returns { available, reasons } — reasons are overdue causes and
// may be non-empty even when part of the signal is unavailable.
// 2 = failed/dead, 1 = completed with failures > 0, 0 = clean completion.
function embedJobBadness(job) {
  if (job?.status === 'failed' || job?.status === 'dead') return 2;
  const failures = job?.result?.failures;
  return isFiniteNumber(failures) && failures > 0 ? 1 : 0;
}

function evaluateEmbedJobSignal(embedJobs, jobsPayload, nowMs = Date.now()) {
  const reasons = [];
  if (!embedJobs || embedJobs.available !== true || !embedJobs.terminal || !embedJobs.waiting) {
    return { available: false, reasons };
  }
  let available = true;

  let latest = null;
  const fullPageOldestCreated = [];
  for (const name of EMBED_JOB_NAMES) {
    for (const status of EMBED_JOB_TERMINAL_STATUSES) {
      const rows = embedJobs.terminal[name]?.[status];
      if (!Array.isArray(rows) || rows.length > EMBED_JOB_TERMINAL_PAGE_LIMIT) {
        available = false;
        continue;
      }
      if (rows.length === EMBED_JOB_TERMINAL_PAGE_LIMIT) {
        const created = rows.map((job) => Date.parse(job?.created_at));
        if (created.every(Number.isFinite)) fullPageOldestCreated.push(Math.min(...created));
        else available = false;
      }
      for (const job of rows) {
        if (!isQueueJob(job, name, status)) {
          available = false;
          continue;
        }
        const at = Date.parse(job.finished_at);
        if (!Number.isFinite(at)) {
          available = false;
          continue;
        }
        if (status === 'completed') {
          const result = job.result;
          if (result !== null && result !== undefined && (typeof result !== 'object' || Array.isArray(result))) {
            available = false;
            continue;
          }
          if (result && Object.prototype.hasOwnProperty.call(result, 'failures')
            && !(isFiniteNumber(result.failures) && result.failures >= 0)) {
            available = false;
            continue;
          }
        }
        // Equal finish times (ms precision) with conflicting outcomes: the
        // worse outcome wins, so a tie can never read as clean.
        if (!latest || at > latest.at || (at === latest.at && embedJobBadness(job) > embedJobBadness(latest.job))) {
          latest = { job, at };
        }
      }
    }
  }
  if (latest && fullPageOldestCreated.some((oldestCreated) => latest.at - oldestCreated < EMBED_JOB_MAX_RUNTIME_MS)) {
    // A full page may hide an older-created job that finished later than
    // `latest`: the latest terminal job is not established.
    available = false;
    latest = null;
  }
  if (!latest) {
    // No terminal embed job could be established: never read that as clean.
    available = false;
  } else if (latest.job.status === 'failed' || latest.job.status === 'dead') {
    reasons.push(`${latest.job.name} job ${latest.job.status} at ${clockText(latest.at)}`);
  } else {
    const failures = latest.job.result?.failures;
    if (isFiniteNumber(failures) && failures > 0) {
      reasons.push(`${latest.job.name} job completed with ${failures} failure${failures === 1 ? '' : 's'} at ${clockText(latest.at)}`);
    }
  }

  for (const name of EMBED_JOB_NAMES) {
    const rows = embedJobs.waiting[name];
    if (rows === undefined) {
      if (!globalWaitingClears(jobsPayload, name)) available = false;
      continue;
    }
    if (!Array.isArray(rows)) {
      available = false;
      continue;
    }
    let oldest = null;
    let valid = true;
    for (const job of rows) {
      const created = isQueueJob(job, name, 'waiting') ? Date.parse(job.created_at) : NaN;
      if (!Number.isFinite(created)) {
        valid = false;
        continue;
      }
      if (oldest === null || created < oldest) oldest = created;
    }
    if (!valid) available = false;
    const oldestMinutes = oldest === null ? null : (nowMs - oldest) / 60000;
    if (oldestMinutes !== null && oldestMinutes > EMBED_JOB_WAITING_TOLERANCE_MINUTES) {
      reasons.push(`${name} job waiting ${Math.round(oldestMinutes)}m`);
    } else if (rows.length >= EMBED_JOB_WAITING_LIST_LIMIT) {
      // Saturated newest-first list: an older waiting job may be hidden.
      available = false;
    }
  }

  return { available, reasons };
}

// Bounded and serialized: every list_jobs child goes through the same probe
// runner (reaped before the next), at most 3 terminal pages per name plus one
// waiting call per name the global stats cannot clear, all inside
// EMBED_JOB_PROBE_BUDGET_MS (each call's soft window is capped to the budget
// left). The first failed / timed-out / unparseable call stops the chain; a
// timed-out one is reported as `pending` so the caller stops probing too.
async function probeEmbedJobs(runProbe, execFilePromise, jobsPayload, { budgetMs = EMBED_JOB_PROBE_BUDGET_MS, now = Date.now } = {}) {
  const started = now();
  const call = async (params) => {
    const remaining = budgetMs - (now() - started);
    if (remaining <= 0) return { stop: true, error: 'embed-job probe budget exhausted' };
    const result = await runProbe(
      execFilePromise,
      ['call', 'list_jobs', JSON.stringify(params)],
      { suppressStartupHooks: true, softTimeoutMs: Math.min(HEALTH_PROBE_SOFT_TIMEOUT_MS, remaining) },
    );
    if (result.pending) return { stop: true, pending: true, error: result.error || 'list_jobs timed out' };
    if (!result.ok) return { stop: true, error: result.error || 'list_jobs failed' };
    const parsed = parseJsonFromOutput(result.stdout);
    if (!Array.isArray(parsed)) return { stop: true, error: 'list_jobs did not return a JSON array' };
    return { jobs: parsed };
  };
  const terminal = {};
  for (const name of EMBED_JOB_NAMES) {
    terminal[name] = {};
    for (const status of EMBED_JOB_TERMINAL_STATUSES) {
      const r = await call({ name, status, queue: EMBED_JOB_QUEUE, limit: EMBED_JOB_TERMINAL_PAGE_LIMIT });
      if (r.stop) return { available: false, pending: Boolean(r.pending), error: r.error };
      terminal[name][status] = r.jobs;
    }
  }
  const waiting = {};
  for (const name of EMBED_JOB_NAMES) {
    if (globalWaitingClears(jobsPayload, name)) continue;
    const r = await call({ name, status: 'waiting', queue: EMBED_JOB_QUEUE, limit: EMBED_JOB_WAITING_LIST_LIMIT });
    if (r.stop) return { available: false, pending: Boolean(r.pending), error: r.error };
    waiting[name] = r.jobs;
  }
  return { available: true, terminal, waiting };
}

// A count and its age are read together from the ONE record that owns
// `countKey`. The count must be a non-negative integer JSON number, the age
// a finite non-negative JSON number; several owner records are ambiguous.
// Anything else is reported as unavailable (count null), which the verdict
// treats as a warning, never as zero.
function readCountWithAge(payload, countKey, ageKey) {
  const owners = [];
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
    if (Object.prototype.hasOwnProperty.call(item, countKey)) owners.push(item);
    for (const value of Object.values(item)) stack.push(value);
  }
  if (owners.length !== 1) return { count: null, age: null };
  const [record] = owners;
  const count = record[countKey];
  if (typeof count !== 'number' || !Number.isInteger(count) || count < 0) return { count: null, age: null };
  const age = record[ageKey];
  return { count, age: isValidLag(age) ? age : null };
}

function readStaleRecord(payload) {
  const { count, age } = readCountWithAge(payload, 'stale_pages', 'stale_pages_oldest_lag_seconds');
  return { count, lag: age };
}

function readMissingEmbeddingsRecord(payload) {
  return readCountWithAge(payload, 'missing_embeddings', 'missing_embeddings_oldest_age_seconds');
}

function normalizeHealthPayload(healthPayload, jobsPayload, checkedAt, embedJobs) {
  const score = normalizeHealthScore(findNumber(healthPayload, ['brain_score', 'brainScore', 'health_score', 'healthScore', 'score']));
  const pages = findNumber(healthPayload, ['pages', 'page_count', 'total_pages']);
  const chunks = findNumber(healthPayload, ['chunks', 'chunk_count', 'total_chunks']);
  const embedded = findNumber(healthPayload, ['embedded', 'embedded_chunks', 'embedded_count']);
  const { count: missing, age: missingAge } = readMissingEmbeddingsRecord(healthPayload);
  const missingEmbeddingsUnavailable = missing === null;
  // missingEmbeddings stays the raw count; missingEmbeddingsOverdue is the
  // verdict-bearing part (oldest older than the tolerance).
  const ageSplit = splitMissingEmbeddings(missing, missingAge);
  // Job signal only when there is something to embed; it can only add overdue.
  const checkedMs = Date.parse(checkedAt);
  const jobSignal = Number.isFinite(missing) && missing > 0
    ? evaluateEmbedJobSignal(embedJobs, jobsPayload, Number.isFinite(checkedMs) ? checkedMs : Date.now())
    : null;
  const missingEmbeddingsJobReasons = jobSignal ? jobSignal.reasons : [];
  const embedJobProbeUnavailable = Boolean(jobSignal && !jobSignal.available);
  const {
    overdue: missingEmbeddingsOverdue,
    catchingUp: missingEmbeddingsCatchingUp,
  } = missingEmbeddingsJobReasons.length > 0 ? { overdue: missing, catchingUp: 0 } : ageSplit;
  const { count: stalePages, lag: staleLag } = readStaleRecord(healthPayload);
  const stalePagesUnavailable = stalePages === null;
  // stalePages stays the raw count; stalePagesOverdue is the verdict-bearing
  // part (older than the tolerance), the rest is catching up.
  const { overdue: stalePagesOverdue, catchingUp: stalePagesCatchingUp } = splitStalePages(stalePages, staleLag);
  const coverage = findNumber(healthPayload, ['embed_coverage', 'embedding_coverage', 'coverage']);
  const waiting = findNumber(jobsPayload, ['waiting', 'queued', 'pending']);
  const active = findNumber(jobsPayload, ['active', 'running', 'processing']);
  const stalled = findNumber(jobsPayload, ['stalled', 'dead']);
  const rawStatus = findString(healthPayload, ['status', 'health_status']);
  const status = rawStatus || (
    stalePagesOverdue > 0 || stalePagesUnavailable
      ? 'stale'
      : missingEmbeddingsOverdue > 0 || missingEmbeddingsUnavailable
      ? 'warning'
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
      missingEmbeddingsOverdue,
      missingEmbeddingsCatchingUp,
      missingEmbeddingsUnavailable,
      missingEmbeddingsOldestAgeSeconds: missingAge,
      missingEmbeddingsJobReasons,
      embedJobProbeUnavailable,
      stalePages,
      stalePagesOverdue,
      stalePagesCatchingUp,
      stalePagesUnavailable,
      stalePagesOldestLagSeconds: staleLag,
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
  // Whole-line integer only: '0.5', '0junk', '0e3' are malformed -> unavailable.
  // The text output carries no age, so any missing embedding is overdue.
  const missing = numberFromText(healthText, /^\s*Missing embeddings:\s*(\d+)\s*$/im);
  // Whole-line integer only: '0.5', '0junk', '0e3' are malformed -> unavailable.
  const stalePages = numberFromText(healthText, /^\s*Stale pages:\s*(\d+)\s*$/im);
  const waiting = numberFromText(jobsText, /Queue health:\s*(\d+)\s+waiting/i);
  const active = numberFromText(jobsText, /Queue health:\s*\d+\s+waiting,\s*(\d+)\s+active/i);
  const stalled = numberFromText(jobsText, /Queue health:\s*\d+\s+waiting,\s*\d+\s+active,\s*(\d+)\s+stalled/i);

  if (score === null && coveragePercent === null && missing === null && stalePages === null) return null;

  return {
    ok: true,
    mode: 'live-read-only',
    checkedAt,
    status: stalePages === null || stalePages > 0
      ? 'stale'
      : missing === null || missing > 0
      ? 'warning'
      : score !== null && score >= 7 ? 'healthy' : 'warning',
    score: score !== null ? score * 10 : null,
    metrics: {
      pages: null,
      chunks: null,
      embedded: null,
      missingEmbeddings: missing,
      missingEmbeddingsOverdue: missing,
      missingEmbeddingsCatchingUp: 0,
      missingEmbeddingsUnavailable: missing === null,
      missingEmbeddingsOldestAgeSeconds: null,
      stalePages,
      stalePagesOverdue: stalePages,
      stalePagesUnavailable: stalePages === null,
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

// A soft-timed-out probe resolves before its child has been reaped; hold each
// successor command until that child exits so the overview's two-process
// database bound holds under load. Mirrors the actionsExecutor cleanup contract.
function createProbeCommandRunner(runGBrainImpl) {
  return async function runProbeCommand(execFilePromise, args, options) {
    const result = await runGBrainImpl(execFilePromise, args, options);
    if (result.cleanup) await result.cleanup;
    return result;
  };
}

const runProbeCommand = createProbeCommandRunner(runGBrain);

async function buildLiveGBrainStats(options = {}) {
  const execFilePromise = options.execFilePromise || defaultExecFilePromise;
  const runProbe = options.probeCommand || runProbeCommand;
  const result = await runProbe(execFilePromise, ['stats', '--source', '__all__', '--json'], { suppressStartupHooks: true, softTimeoutMs: HEALTH_PROBE_SOFT_TIMEOUT_MS });
  const payload = parseJsonFromOutput(result.stdout);
  if (result.ok && payload) return normalizeStatsPayload(payload);
  const textStats = normalizeStatsText(result.stdout);
  if (result.ok && textStats) return textStats;
  // A soft-timed-out child means gbrain is already too loaded or hung; stop
  // instead of stacking a fallback probe on the same database.
  if (result.pending) return null;
  const fallbackResult = await runProbe(execFilePromise, ['stats', '--source', '__all__'], { suppressStartupHooks: true, softTimeoutMs: HEALTH_PROBE_SOFT_TIMEOUT_MS });
  const fallbackPayload = parseJsonFromOutput(fallbackResult.stdout);
  if (fallbackResult.ok && fallbackPayload) return normalizeStatsPayload(fallbackPayload);
  return fallbackResult.ok ? normalizeStatsText(fallbackResult.stdout) : null;
}

function normalizeSourcesPayload(payload, checkedAt) {
  const rawSources = Array.isArray(payload)
    ? payload
    : payload?.sync?.sources || payload?.sources || payload?.data || payload?.items || [];
  const sources = rawSources
    .filter((source) => source && typeof source === 'object')
    .map((source) => {
      const rawPages = source.pages ?? source.page_count;
      const pages = Number.isFinite(Number(rawPages)) ? Number(rawPages) : null;
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
      const rawChunks = source.chunks ?? source.chunk_count ?? source.chunks_total;
      return {
        id: String(source.source_id || source.id || source.name || source.source || 'unknown'),
        status: String(status),
        statusReported: Boolean(reportedStatus),
        pages,
        chunks: Number.isFinite(Number(rawChunks)) ? Number(rawChunks) : null,
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

// Embed-job probes run only when the health record reports missing
// embeddings; otherwise the job state cannot change the verdict.
async function maybeProbeEmbedJobs(healthPayload, jobsPayload, runProbe, execFilePromise, options) {
  const { count } = readMissingEmbeddingsRecord(healthPayload);
  if (!(Number.isFinite(count) && count > 0)) return undefined;
  return probeEmbedJobs(runProbe, execFilePromise, jobsPayload, {
    budgetMs: options.embedJobProbeBudgetMs,
    now: options.now,
  });
}

// Stats backfill follows the same stop rule as the main chain: after a
// timed-out embed-job probe the database is too contended to keep probing.
async function finishHealth(health, embedJobs, options) {
  if (embedJobs?.pending || !needsStatsBackfill(health)) return health;
  return mergeStatsIntoHealth(health, await buildLiveGBrainStats(options));
}

async function buildLiveGBrainHealth(options = {}) {
  const execFilePromise = options.execFilePromise || defaultExecFilePromise;
  const runProbe = options.probeCommand || runProbeCommand;
  const checkedAt = new Date().toISOString();
  // Keep each top-level probe to one child command. The overview scheduler may
  // run two probes concurrently; a nested health fan-out would otherwise allow
  // three simultaneous GBrain subprocesses and defeat that database bound.
  const healthResult = await runProbe(execFilePromise, ['call', '--source', '__all__', 'get_health'], { suppressStartupHooks: true, softTimeoutMs: HEALTH_PROBE_SOFT_TIMEOUT_MS });
  // A soft-timed-out child has already consumed the soft window plus hard-kill
  // cleanup; successor probes would stack on the same loaded database and
  // stretch a single overview request to minutes. Report unavailable instead.
  if (healthResult.pending) {
    return { ok: false, mode: 'live-read-only', checkedAt, status: 'unavailable', error: healthResult.error };
  }
  const jobsResult = await runProbe(execFilePromise, ['jobs', 'stats', '--json'], { suppressStartupHooks: true, softTimeoutMs: HEALTH_PROBE_SOFT_TIMEOUT_MS });
  // Same stop rule as above: a timed-out jobs probe means the database is too
  // contended to keep probing, and reporting a healthy score with unavailable
  // queue counters would be the false "healthy" this probe chain exists to
  // prevent.
  if (jobsResult.pending) {
    return { ok: false, mode: 'live-read-only', checkedAt, status: 'unavailable', error: jobsResult.error };
  }
  const healthPayload = parseJsonFromOutput(healthResult.stdout);
  const jobsPayload = parseJsonFromOutput(jobsResult.stdout) || {
    waiting: numberFromText(jobsResult.stdout, /Queue health:\s*(\d+)\s+waiting/i),
    active: numberFromText(jobsResult.stdout, /Queue health:\s*\d+\s+waiting,\s*(\d+)\s+active/i),
    stalled: numberFromText(jobsResult.stdout, /Queue health:\s*\d+\s+waiting,\s*\d+\s+active,\s*(\d+)\s+stalled/i),
  };

  if (healthResult.ok && healthPayload) {
    const embedJobs = await maybeProbeEmbedJobs(healthPayload, jobsPayload, runProbe, execFilePromise, options);
    const health = normalizeHealthPayload(healthPayload, jobsPayload, checkedAt, embedJobs);
    return finishHealth(health, embedJobs, options);
  }

  const fallbackHealthResult = await runProbe(execFilePromise, ['health', '--source', '__all__', '--json'], { suppressStartupHooks: true, softTimeoutMs: HEALTH_PROBE_SOFT_TIMEOUT_MS });
  if (fallbackHealthResult.pending) {
    return { ok: false, mode: 'live-read-only', checkedAt, status: 'unavailable', error: fallbackHealthResult.error };
  }
  const fallbackPayload = parseJsonFromOutput(fallbackHealthResult.stdout);
  if (fallbackHealthResult.ok && fallbackPayload) {
    const embedJobs = await maybeProbeEmbedJobs(fallbackPayload, jobsPayload, runProbe, execFilePromise, options);
    const health = normalizeHealthPayload(fallbackPayload, jobsPayload, checkedAt, embedJobs);
    return finishHealth(health, embedJobs, options);
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
  const snapshotResult = await runGBrain(
    execFilePromise,
    ['call', '--source', '__all__', 'get_status_snapshot'],
    { suppressStartupHooks: true },
  );
  const snapshotPayload = parseJsonFromOutput(snapshotResult.stdout);

  if (snapshotResult.ok && Array.isArray(snapshotPayload?.sync?.sources)) {
    return normalizeSourcesPayload(snapshotPayload.sync.sources, checkedAt);
  }

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
      error: snapshotResult.error || result.error || fallbackResult?.error || 'gbrain source probes did not return parseable output',
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
  STALE_PAGES_LAG_TOLERANCE_SECONDS,
  MISSING_EMBEDDINGS_LAG_TOLERANCE_SECONDS,
  EMBED_JOB_WAITING_TOLERANCE_MINUTES,
  EMBED_JOB_QUEUE,
  EMBED_JOB_TERMINAL_PAGE_LIMIT,
  EMBED_JOB_MAX_RUNTIME_MS,
  evaluateEmbedJobSignal,
  probeEmbedJobs,
  splitStalePages,
  splitMissingEmbeddings,
  readStaleRecord,
  readMissingEmbeddingsRecord,
  normalizeToolsPayload,
  normalizeFeaturesPayload,
  normalizeProvidersPayload,
  defaultHermesProxyBaseUrl,
  probeJsonEndpoint,
  buildLiveHermesProxyStatus,
  buildLiveGBrainTools,
  buildLiveGBrainFeatures,
  buildLiveGBrainProviders,
  createProbeCommandRunner,
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
