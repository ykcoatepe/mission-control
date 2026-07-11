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

function heartbeatEventToPayload(value, {
  now = () => Date.now(),
  maxFutureSkewMs = 5 * 60 * 1000,
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

function mergeHeartbeatPayloads(primary = {}, fallback = {}) {
  const normalizedPrimary = normalizeHeartbeatPayload(primary || {});
  const normalizedFallback = normalizeHeartbeatPayload(fallback || {});
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
  execSync,
  fs,
  path,
  processEnv = process.env,
}) {
  let statusCache = null;
  let statusCacheTime = 0;
  let refreshInFlight = null;
  const statusCacheTtl = 60000;

  function buildMinimalStatusResponse() {
    const modelKey = getOpenclawDefaultModelKey();
    return {
      generatedAt: new Date().toISOString(),
      agent: {
        name: mcConfig.name || 'Mission Control',
        status: 'active',
        model: prettyModelName(modelKey),
        activeSessions: 0,
        totalAgents: 0,
        memoryFiles: 0,
        memoryChunks: 0,
        heartbeatInterval: '1h',
        channels: [],
      },
      heartbeat: { lastChecks: {}, lastProactiveTasks: {} },
      recentActivity: [],
      tokenUsage: { used: 0, limit: 0, percentage: 0 },
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
        status: 'active',
        model: prettyModelName(defaultModelKey || (modelMatch ? modelMatch[1] : '')),
        activeSessions: sessionsMatch ? Number.parseInt(sessionsMatch[1], 10) : 0,
        totalAgents: agentsMatch ? Number.parseInt(agentsMatch[1], 10) : 1,
        memoryFiles: memoryMatch ? Number.parseInt(memoryMatch[1], 10) : 46,
        memoryChunks: memoryMatch ? Number.parseInt(memoryMatch[2], 10) : 225,
        heartbeatInterval: heartbeatInterval ? heartbeatInterval[1] : '1h',
        channels: channels || [],
      },
      heartbeat: hb,
      recentActivity: recentActivity || [],
      tokenUsage: tokenUsage || { used: 0, limit: 1000000, percentage: 0 },
      generatedAt: cache.generatedAt || new Date().toISOString(),
    };
  }

  function buildActivityFromMemory() {
    const recentActivity = [];
    for (const dayOffset of [0, 1]) {
      const date = new Date();
      date.setDate(date.getDate() - dayOffset);
      const dateStr = date.toISOString().split('T')[0];
      try {
        const memPath = path.join(memoryPath, `${dateStr}.md`);
        if (!fs.existsSync(memPath)) continue;
        const memContent = fs.readFileSync(memPath, 'utf8');
        const sections = memContent.split(/\n## /).slice(1);
        sections.slice(0, 6).forEach((section) => {
          const firstLine = section.split('\n')[0].trim();
          const timeMatch = firstLine.match(/(\d{2}:\d{2})\s*UTC/);
          const time = timeMatch ? `${dateStr}T${timeMatch[1]}:00Z` : `${dateStr}T12:00:00Z`;
          const title = firstLine
            .replace(/\d{2}:\d{2}\s*UTC\s*[-—]\s*/, '')
            .replace(/\*\*/g, '')
            .substring(0, 80);
          const bullets = section.split('\n').filter((line) => /^[-*]\s/.test(line.trim()));
          const detail = (bullets[0] || '').replace(/^[-*]\s*/, '').replace(/\*\*/g, '').substring(0, 120);
          let type = 'general';
          const lower = (title + ' ' + detail).toLowerCase();
          if (lower.includes('bug') || lower.includes('security')) type = 'security';
          else if (lower.includes('build') || lower.includes('deploy') || lower.includes('dashboard')) type = 'development';
          else if (lower.includes('email') || lower.includes('lead')) type = 'business';
          else if (lower.includes('heartbeat')) type = 'heartbeat';
          else if (lower.includes('meeting')) type = 'meeting';
          if (title) recentActivity.push({ time, action: title, detail: detail || 'Activity logged', type });
        });
        if (recentActivity.length > 2) break;
      } catch {}
    }
    return recentActivity.length
      ? recentActivity
      : [{ time: new Date().toISOString(), action: 'System running', detail: 'Dashboard active', type: 'general' }];
  }

  async function doRefreshStatusCache() {
    try {
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
            resolve({
              output: execSync('openclaw status 2>&1', { timeout: 8000, encoding: 'utf8' }),
              commandSucceeded: true,
            });
          } catch (error) {
            resolve({
              output: error.stdout || gatewayHealth,
              commandSucceeded: false,
            });
          }
        }),
        fetchNotionActivity(8).catch(() => null),
        fetchSessions(50).catch(() => ({ count: 0, sessions: [] })),
        Promise.resolve().then(() => {
          try {
            return heartbeatEventToPayload(execSync('openclaw system heartbeat last --json', {
              timeout: 8000,
              encoding: 'utf8',
            }));
          } catch {
            return {};
          }
        }),
      ]);

      const statusResult = openclawStatus.status === 'fulfilled'
        ? openclawStatus.value
        : { output: '', commandSucceeded: false };
      const ocStatus = statusResult.output || '';
      const activity = notionActivity.status === 'fulfilled' ? notionActivity.value : null;
      const sessions = sessionData.status === 'fulfilled' ? sessionData.value : { count: 0, sessions: [] };

      let defaultModelKey = '';
      try {
        const ocCfgPath = path.join(processEnv.HOME || '/home/ubuntu', '.openclaw/openclaw.json');
        const ocCfg = JSON.parse(fs.readFileSync(ocCfgPath, 'utf8'));
        defaultModelKey = ocCfg?.agents?.defaults?.model?.primary
          || ocCfg?.agents?.defaults?.model?.default
          || ocCfg?.model?.default
          || '';
      } catch {}

      const sessionsMatch = ocStatus.match(/(\d+) active/);
      const modelMatch = ocStatus.match(/default\s+([^\s(]+)/);
      const memoryMatch = ocStatus.match(/(\d+)\s*files.*?(\d+)\s*chunks/);
      const heartbeatInterval = ocStatus.match(/Heartbeat\s*│\s*(\w+)/);
      const agentsMatch = ocStatus.match(/Agents\s*│\s*(\d+)/);

      const channels = [];
      const channelRegex = /│\s*(Discord|WhatsApp|Telegram)\s*│\s*(ON|OFF)\s*│\s*(OK|OFF|ERROR)\s*│\s*(.+?)\s*│/g;
      let match;
      while ((match = channelRegex.exec(ocStatus)) !== null) {
        channels.push({ name: match[1], enabled: match[2], state: match[3], detail: match[4].trim() });
      }

      const statusShapeObserved = Boolean(
        sessionsMatch || modelMatch || memoryMatch || heartbeatInterval || agentsMatch || channels.length,
      );
      const statusObservedAt = statusResult.commandSucceeded && statusShapeObserved
        ? new Date().toISOString()
        : null;

      const sessionList = sessions.sessions || [];
      const totalTokens = sessionList.reduce((sum, session) => sum + (session.totalTokens || 0), 0);
      const tokenUsage = {
        used: totalTokens,
        limit: 0,
        percentage: 0,
      };

      let recentActivity = activity;
      if (!recentActivity || !recentActivity.length) {
        recentActivity = buildActivityFromMemory();
      }

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
    if (snapshot) {
      return {
        ...snapshot,
        heartbeat: normalizeHeartbeatPayload(snapshot.heartbeat || {}),
      };
    }

    if (Date.now() - statusCacheTime > statusCacheTtl) {
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

    const response = buildStatusResponseFromCache(statusCache, heartbeat);
    writeRuntimeSnapshot('status', response);
    return response;
  }

  async function getOperationsStatusResponse() {
    await refreshStatusCache();
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

  return {
    refreshStatusCache,
    getStatusResponse,
    getOperationsStatusResponse,
  };
}

module.exports = {
  createStatusService,
  heartbeatEventToPayload,
  heartbeatValueToSeconds,
  mergeHeartbeatPayloads,
  normalizeHeartbeatPayload,
};
