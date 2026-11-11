function heartbeatValueToSeconds(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 1e12 ? Math.floor(value / 1000) : value;
  }

  if (typeof value === 'string' && value.trim()) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric > 1e12 ? Math.floor(numeric / 1000) : numeric;

    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return Math.floor(parsed / 1000);
  }

  return null;
}

function normalizeHeartbeatPayload(heartbeat = {}) {
  if (!heartbeat || typeof heartbeat !== 'object' || Array.isArray(heartbeat)) return heartbeat || {};
  const normalized = { ...heartbeat };
  const lastHeartbeat = heartbeatValueToSeconds(normalized.lastHeartbeat);
  if (lastHeartbeat != null) {
    normalized.lastHeartbeat = lastHeartbeat;
    return normalized;
  }

  const fallbackHeartbeat = heartbeatValueToSeconds(normalized.lastHeartbeatAt || normalized.lastChecks?.heartbeat);
  if (fallbackHeartbeat != null) normalized.lastHeartbeat = fallbackHeartbeat;
  return normalized;
}

const HEARTBEAT_EVENT_KEYS = ['lastEventStatus', 'lastEventReason', 'lastEventDurationMs'];
const MAX_HEARTBEAT_FUTURE_SKEW_MS = 5 * 60 * 1000;

function heartbeatEventToPayload(value, {
  now = () => Date.now(),
  maxFutureSkewMs = MAX_HEARTBEAT_FUTURE_SKEW_MS,
} = {}) {
  let event = value;
  if (typeof value === 'string') {
    try {
      event = JSON.parse(value);
    } catch {
      return {};
    }
  }
  if (!event || typeof event !== 'object' || Array.isArray(event)) return {};

  const lastHeartbeat = heartbeatValueToSeconds(event.ts);
  if (lastHeartbeat == null) return {};
  const observed = new Date(lastHeartbeat * 1000);
  const observedMs = observed.getTime();
  if (!Number.isFinite(observedMs) || observedMs > now() + maxFutureSkewMs) return {};

  const payload = {
    lastHeartbeat,
    lastHeartbeatAt: observed.toISOString(),
  };
  if (typeof event.status === 'string' && event.status.trim()) {
    payload.lastEventStatus = event.status.trim().slice(0, 64);
  }
  if (typeof event.reason === 'string' && event.reason.trim()) {
    payload.lastEventReason = event.reason.trim().slice(0, 160);
  }
  if (typeof event.durationMs === 'number' && Number.isFinite(event.durationMs) && event.durationMs >= 0) {
    payload.lastEventDurationMs = event.durationMs;
  }
  return payload;
}

function boundHeartbeatPayload(heartbeat, {
  now = () => Date.now(),
  maxFutureSkewMs = MAX_HEARTBEAT_FUTURE_SKEW_MS,
} = {}) {
  const normalized = normalizeHeartbeatPayload(heartbeat || {});
  const lastHeartbeat = heartbeatValueToSeconds(normalized.lastHeartbeat);
  if (lastHeartbeat == null) return normalized;
  const observedMs = lastHeartbeat * 1000;
  if (!Number.isFinite(observedMs) || observedMs > now() + maxFutureSkewMs) return {};
  return normalized;
}

function mergeHeartbeatPayloads(primary = {}, fallback = {}, options = {}) {
  const normalizedPrimary = boundHeartbeatPayload(primary, options);
  const normalizedFallback = boundHeartbeatPayload(fallback, options);
  const primaryAt = heartbeatValueToSeconds(normalizedPrimary.lastHeartbeat);
  const fallbackAt = heartbeatValueToSeconds(normalizedFallback.lastHeartbeat);

  const primaryWins = primaryAt != null && (fallbackAt == null || primaryAt >= fallbackAt);
  const winner = primaryWins ? normalizedPrimary : normalizedFallback;
  const loser = primaryWins ? normalizedFallback : normalizedPrimary;
  const merged = { ...loser, ...winner };

  for (const key of HEARTBEAT_EVENT_KEYS) {
    if (!Object.hasOwn(winner, key)) delete merged[key];
  }
  return merged;
}

// Combine stdout and stderr the way `openclaw status 2>&1` used to.
function combinedOutput(result) {
  const out = String(result?.stdout || '');
  const err = String(result?.stderr || '');
  if (!err) return out;
  return out ? `${out}${out.endsWith('\n') ? '' : '\n'}${err}` : err;
}

// CLI channel details sometimes include only a token prefix/suffix; those are
// credentials too. Preserve status text while removing both previews and values.
function redactChannelDetail(value) {
  return String(value || '')
    .replace(/\btoken\s+(?:config|configured)\s*\([^)]*\)/gi, 'token [redacted]')
    .replace(/\b(token|api[_ -]?key|secret|password)\s*[:=]\s*[^\s·,;]+/gi, '$1=[redacted]')
    .replace(/\bBearer\s+[^\s·,;]+/gi, 'Bearer [redacted]')
    .replace(/\b\d{6,}:[A-Za-z0-9_.…-]{8,}/g, '[redacted]')
    .replace(/\b(?:sk-|ghp_|xox[baprs]-)[A-Za-z0-9_.…-]{6,}/g, '[redacted]');
}

function createStatusService({
  mcConfig,
  memoryPath,
  prettyModelName,
  getOpenclawDefaultModelKey,
  fetchNotionActivity,
  fetchSessions,
  readRuntimeSnapshot,
  writeRuntimeSnapshot,
  runtimeSnapshotTtl,
  gatewayPort,
  // (args, timeoutMs) => Promise<{ ok, stdout, stderr, ... }> on the core
  // runner's `openclaw` lane. Never blocks the event loop; never throws for a
  // failed command.
  openclawCli,
  fs,
  path,
  sessionRefreshBudgetMs = 1500,
  processEnv = process.env,
  // When a scheduler owns refresh, reads must not start one (GET is pure).
  refreshOnRead = true,
  statusTimeoutMs = 15000,
  heartbeatTimeoutMs = 10000,
}) {
  if (typeof openclawCli !== 'function') throw new TypeError('createStatusService: openclawCli is required');
  let statusCache = null;
  let statusCacheTime = 0;
  let refreshInFlight = null;
  let completedRefreshes = 0;
  const statusCacheTtl = 60000;

  function buildMinimalStatusResponse() {
    return {
      generatedAt: new Date().toISOString(),
      agent: {
        name: mcConfig.name || 'Mission Control',
        status: null,
        model: null,
        modelObserved: false,
        activeSessions: null,
        activeSessionsObserved: false,
        totalAgents: null,
        totalAgentsObserved: false,
        memoryFiles: null,
        memoryChunks: null,
        memoryObserved: false,
        heartbeatInterval: null,
        heartbeatIntervalObserved: false,
        channels: null,
        channelsObserved: false,
      },
      heartbeat: { lastChecks: {}, lastProactiveTasks: {} },
      recentActivity: null,
      recentActivityObserved: false,
      tokenUsage: { used: null, limit: null, percentage: null, observed: false, limitObserved: false },
    };
  }

  function buildStatusResponseFromCache(cache = {}, heartbeatOverride = null) {
    const {
      sessionsMatch,
      modelMatch,
      defaultModelKey,
      memoryMatch,
      heartbeatInterval,
      agentsMatch,
      channels,
      tokenUsage,
      recentActivity,
      heartbeat,
    } = cache || {};
    const hb = normalizeHeartbeatPayload(heartbeatOverride || heartbeat || {});

    return {
      agent: {
        name: mcConfig.name || 'Mission Control',
        status: cache.operationsSource?.sourceSucceeded ? 'active' : null,
        model: defaultModelKey || modelMatch ? prettyModelName(defaultModelKey || modelMatch[1]) : null,
        modelObserved: Boolean(defaultModelKey || modelMatch),
        activeSessions: sessionsMatch ? Number.parseInt(sessionsMatch[1], 10) : null,
        activeSessionsObserved: Boolean(sessionsMatch),
        totalAgents: agentsMatch ? Number.parseInt(agentsMatch[1], 10) : null,
        totalAgentsObserved: Boolean(agentsMatch),
        memoryFiles: memoryMatch ? Number.parseInt(memoryMatch[1], 10) : null,
        memoryChunks: memoryMatch ? Number.parseInt(memoryMatch[2], 10) : null,
        memoryObserved: Boolean(memoryMatch),
        heartbeatInterval: heartbeatInterval ? heartbeatInterval[1] : null,
        heartbeatIntervalObserved: Boolean(heartbeatInterval),
        channels: channels?.length ? channels : null,
        channelsObserved: Boolean(channels?.length),
      },
      heartbeat: hb,
      recentActivity: recentActivity ?? null,
      recentActivityObserved: recentActivity != null,
      tokenUsage: tokenUsage || { used: null, limit: null, percentage: null, observed: false, limitObserved: false },
      generatedAt: cache.generatedAt || new Date().toISOString(),
    };
  }

  async function doRefreshStatusCache() {
    try {
      const sessionRead = new Promise((resolve) => {
        let settled = false;
        const timer = setTimeout(() => {
          settled = true;
          resolve(null);
        }, sessionRefreshBudgetMs);
        Promise.resolve(fetchSessions(50)).then((value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(value);
        }).catch(() => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(null);
        });
      });
      const [openclawStatus, notionActivity, sessionData, heartbeatEvent] = await Promise.allSettled([
        new Promise(async (resolve) => {
          let gatewayHealth = '';
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 1500);
          try {
            const port = Number(gatewayPort || mcConfig.gateway?.port || 18789);
            const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: controller.signal });
            const body = await response.text();
            gatewayHealth = response.ok ? `Gateway │ live │ ${body}` : '';
          } catch {
          } finally {
            clearTimeout(timeout);
          }

          try {
            const result = await openclawCli(['status'], statusTimeoutMs);
            resolve(result?.ok
              ? { output: combinedOutput(result), commandSucceeded: true }
              : { output: combinedOutput(result) || gatewayHealth, commandSucceeded: false });
          } catch {
            resolve({ output: gatewayHealth, commandSucceeded: false });
          }
        }),
        fetchNotionActivity(8).catch(() => null),
        sessionRead,
        Promise.resolve()
          .then(() => openclawCli(['system', 'heartbeat', 'last', '--json'], heartbeatTimeoutMs))
          .then((result) => (result?.ok ? heartbeatEventToPayload(result.stdout) : {}))
          .catch(() => ({})),
      ]);

      const statusResult = openclawStatus.status === 'fulfilled'
        ? openclawStatus.value
        : { output: '', commandSucceeded: false };
      const ocStatus = statusResult.commandSucceeded ? statusResult.output || '' : '';
      const activity = notionActivity.status === 'fulfilled' ? notionActivity.value : null;
      const sessions = sessionData.status === 'fulfilled' ? sessionData.value : null;

      let defaultModelKey = '';
      try {
        const ocCfgPath = path.join(processEnv.HOME || '/home/ubuntu', '.openclaw/openclaw.json');
        const ocCfg = JSON.parse(fs.readFileSync(ocCfgPath, 'utf8'));
        defaultModelKey = ocCfg?.agents?.defaults?.model?.primary
          || ocCfg?.agents?.defaults?.model?.default
          || ocCfg?.model?.default
          || '';
      } catch {}

      const sessionsMatch = ocStatus.match(/(?:^|\n)\s*(\d+)\s+active sessions\b/i);
      const modelMatch = ocStatus.match(/default\s+([^\s(]+)/);
      const memoryMatch = ocStatus.match(/(\d+)\s*files.*?(\d+)\s*chunks/);
      const heartbeatInterval = ocStatus.match(/Heartbeat\s*│\s*(\w+)/);
      const agentsMatch = ocStatus.match(/Agents\s*│\s*(\d+)/);

      const channels = [];
      const channelRegex = /│\s*(Discord|WhatsApp|Telegram)\s*│\s*(ON|OFF)\s*│\s*(OK|OFF|ERROR)\s*│\s*(.+?)\s*│/g;
      let match;
      while ((match = channelRegex.exec(ocStatus)) !== null) {
        channels.push({ name: match[1], enabled: match[2], state: match[3], detail: redactChannelDetail(match[4].trim()) });
      }

      const statusShapeObserved = Boolean(
        sessionsMatch || modelMatch || memoryMatch || heartbeatInterval || agentsMatch || channels.length,
      );
      const statusObservedAt = statusResult.commandSucceeded && statusShapeObserved
        ? new Date().toISOString()
        : null;

      const sessionList = Array.isArray(sessions?.sessions) ? sessions.sessions : null;
      const tokensObserved = sessionList != null && sessions?.meta?.ok !== false && !sessions?.error && sessionList.every((session) => Number.isFinite(session.totalTokens));
      const tokenUsage = {
        used: tokensObserved ? sessionList.reduce((sum, session) => sum + session.totalTokens, 0) : null,
        limit: null,
        percentage: null,
        observed: tokensObserved,
        limitObserved: false,
      };
      // Absence of activity is not a synthetic "System running" event. No
      // memory content is read or forwarded as fallback activity.
      const recentActivity = Array.isArray(activity) ? activity : null;

      let heartbeat = {};
      try {
        heartbeat = JSON.parse(fs.readFileSync(path.join(memoryPath, 'heartbeat-state.json'), 'utf8'));
      } catch {
        heartbeat = { lastHeartbeat: null, lastChecks: {} };
      }
      const liveHeartbeat = heartbeatEvent.status === 'fulfilled' ? heartbeatEvent.value : {};
      heartbeat = mergeHeartbeatPayloads(liveHeartbeat, heartbeat);

      statusCache = {
        generatedAt: new Date().toISOString(),
        operationsSource: {
          sourceSucceeded: Boolean(statusObservedAt),
          provenance: statusObservedAt ? 'openclaw-status-cli' : 'openclaw-status-unavailable',
          observedAt: statusObservedAt,
        },
        sessionsMatch,
        modelMatch,
        defaultModelKey,
        memoryMatch,
        heartbeatInterval,
        agentsMatch,
        channels,
        tokenUsage,
        recentActivity,
        heartbeat,
      };
      statusCacheTime = Date.now();
      completedRefreshes += 1;
      writeRuntimeSnapshot('status', buildStatusResponseFromCache(statusCache, heartbeat));
    } catch (error) {
      console.error('[StatusCache] refresh failed:', error.message);
    }
  }

  function refreshStatusCache() {
    if (refreshInFlight) return refreshInFlight;
    refreshInFlight = new Promise((resolve) => {
      setImmediate(async () => {
        try {
          await doRefreshStatusCache();
        } finally {
          refreshInFlight = null;
          resolve();
        }
      });
    });
    return refreshInFlight;
  }

  async function getStatusResponse() {
    const snapshot = readRuntimeSnapshot('status', runtimeSnapshotTtl.status);
    if (snapshot && !statusCache) {
      const minimal = buildMinimalStatusResponse();
      return {
        ...minimal,
        generatedAt: snapshot.generatedAt || minimal.generatedAt,
        heartbeat: normalizeHeartbeatPayload(snapshot.heartbeat || {}),
      };
    }

    if (refreshOnRead && Date.now() - statusCacheTime > statusCacheTtl) {
      refreshStatusCache();
    }

    if (!statusCache) {
      return buildMinimalStatusResponse();
    }

    let heartbeat = statusCache.heartbeat || {};
    try {
      const fileHeartbeat = JSON.parse(fs.readFileSync(path.join(memoryPath, 'heartbeat-state.json'), 'utf8'));
      heartbeat = mergeHeartbeatPayloads(fileHeartbeat, heartbeat);
    } catch {}

    // GET is pure: the snapshot file is written only by the refresh.
    return buildStatusResponseFromCache(statusCache, heartbeat);
  }

  async function getOperationsStatusResponse() {
    if (refreshOnRead && (!statusCache || Date.now() - statusCacheTime > statusCacheTtl)) {
      await refreshStatusCache();
    }
    const response = statusCache
      ? buildStatusResponseFromCache(statusCache, statusCache.heartbeat || {})
      : buildMinimalStatusResponse();
    return {
      ...response,
      operationsSource: statusCache?.operationsSource || {
        sourceSucceeded: false,
        provenance: 'openclaw-status-unavailable',
        observedAt: null,
      },
    };
  }

  // Source read (see server/sources/openclaw/status.js): one refresh, and the
  // status payload only when the OpenClaw status CLI was actually observed.
  // Throws otherwise, so the caller keeps its last-good value.
  async function readObservedStatus() {
    const before = completedRefreshes;
    await refreshStatusCache();
    if (completedRefreshes === before || !statusCache) {
      const error = new Error('Status refresh did not complete');
      error.code = 'refresh_failed';
      throw error;
    }
    if (!statusCache.operationsSource?.sourceSucceeded) {
      const error = new Error('OpenClaw status CLI produced no observable status');
      error.code = 'openclaw_status_unavailable';
      throw error;
    }
    return buildStatusResponseFromCache(statusCache, statusCache.heartbeat || {});
  }

  return {
    refreshStatusCache,
    getStatusResponse,
    getOperationsStatusResponse,
    readObservedStatus,
    buildMinimalStatusResponse,
  };
}

module.exports = {
  createStatusService,
  heartbeatEventToPayload,
  heartbeatValueToSeconds,
  mergeHeartbeatPayloads,
  normalizeHeartbeatPayload,
  redactChannelDetail,
};
