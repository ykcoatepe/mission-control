const STATE_RANK = {
  critical: 5,
  warning: 4,
  unavailable: 3,
  inactive: 2,
  healthy: 1,
};

function deriveOverallStatus(systems) {
  return Object.values(systems).reduce((worst, system) => (
    STATE_RANK[system.state] > STATE_RANK[worst] ? system.state : worst
  ), 'healthy');
}

function cleanText(value, fallback = '') {
  if (typeof value !== 'string') return fallback;
  return value
    .replace(/Bearer\s+[^\s]+/gi, 'Bearer [redacted]')
    .replace(/\bsk-[A-Za-z0-9_-]+\b/g, '[redacted]')
    .replace(/\/(?:Users|home)\/[^/\s]+/g, '~');
}

function buildOperationsCapabilities({ gbrainActions = [] } = {}) {
  if (!Array.isArray(gbrainActions)) return [];
  return gbrainActions.map((action) => ({
    id: cleanText(action?.id),
    system: 'gbrain',
    label: cleanText(action?.label),
    description: cleanText(action?.description),
    kind: cleanText(action?.kind),
    safetyClass: cleanText(action?.safetyClass),
    requiresConfirmation: Boolean(action?.requiresConfirmation),
    timeoutMs: action?.timeoutMs || null,
    refreshAfter: Boolean(action?.refreshAfter),
    enabled: true,
    disabledReason: '',
    actionEndpoint: '/api/gbrain/actions',
  }));
}

function observedAt(value, fallback) {
  const parsed = value && Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : fallback;
}

function evidence(id, system, kind, status, at, summary, sourceRef, detailHref) {
  return {
    id,
    system,
    kind,
    status,
    observedAt: at,
    summary: cleanText(summary),
    sourceRef,
    detailHref,
  };
}

function unavailableSystem(id, label, detailHref, at, message) {
  const safeMessage = cleanText(message, 'Evidence unavailable.');
  return {
    system: {
      id,
      label,
      state: 'unavailable',
      observedAt: null,
      freshness: 'unavailable',
      caveats: [safeMessage],
      metrics: {},
      evidence: [
        evidence(
          `${id}:unavailable`,
          id,
          'availability',
          'unavailable',
          at,
          safeMessage,
          `${id} reader`,
          detailHref,
        ),
      ],
      detailHref,
    },
    attention: [{
      id: `${id}:unavailable`,
      system: id,
      severity: 'unavailable',
      reasonCode: `${id}_unavailable`,
      title: `${label} evidence unavailable`,
      detail: safeMessage,
      detailHref,
      evidenceRefs: [`${id}:unavailable`],
    }],
  };
}

function adaptOpenClaw(status, sessions, cron, generatedAt) {
  const statusUnavailable = !status || status?.unavailable;
  const sessionsUnavailable = !sessions || sessions?.unavailable;
  if (statusUnavailable && sessionsUnavailable) {
    return unavailableSystem(
      'openclaw',
      'OpenClaw',
      '/systems',
      generatedAt,
      'OpenClaw status and sessions could not be read.',
    );
  }

  const at = observedAt(
    status?.generatedAt || sessions?.generatedAt || cron?.generatedAt,
    generatedAt,
  );
  const statusSessions = Number(status?.agent?.activeSessions || 0);
  const activeSessions = Array.isArray(sessions?.sessions)
    ? sessions.sessions.filter((session) => session?.isActive).length
    : sessionsUnavailable
      ? statusSessions
      : Number(sessions?.count || 0);
  const sessionConflict = !statusUnavailable
    && !sessionsUnavailable
    && statusSessions !== activeSessions;
  const heartbeatValue = Number(status?.heartbeat?.lastHeartbeat || 0);
  const heartbeatAt = heartbeatValue > 0
    ? new Date(heartbeatValue > 1e12 ? heartbeatValue : heartbeatValue * 1000).toISOString()
    : null;
  const heartbeatStale = !heartbeatAt
    || (Date.parse(generatedAt) - Date.parse(heartbeatAt)) > 2 * 60 * 60 * 1000;
  const caveats = [
    ...(statusUnavailable ? ['OpenClaw status evidence is unavailable.'] : []),
    ...(sessionsUnavailable ? ['OpenClaw session evidence is unavailable.'] : []),
    ...(sessionConflict
      ? [`Status reports ${statusSessions} active sessions while the session reader reports ${activeSessions}.`]
      : []),
    ...(heartbeatStale ? ['Heartbeat proof is stale or unavailable.'] : []),
  ];
  const openclawEvidence = [
    evidence(
      'openclaw:sessions',
      'openclaw',
      'sessions',
      sessionsUnavailable ? 'unavailable' : sessionConflict ? 'warning' : 'healthy',
      at,
      sessionsUnavailable
        ? `Session evidence unavailable; status reports ${activeSessions} active sessions`
        : `${activeSessions} active sessions`,
      '/api/sessions',
      '/sessions',
    ),
    evidence(
      'openclaw:heartbeat',
      'openclaw',
      'heartbeat',
      statusUnavailable ? 'unavailable' : heartbeatStale ? 'warning' : 'healthy',
      heartbeatAt,
      heartbeatStale ? 'Heartbeat stale or unavailable' : 'Heartbeat current',
      '/api/status',
      '/systems',
    ),
  ];
  const attention = [];
  if (statusUnavailable) {
    attention.push({
      id: 'openclaw:status-unavailable',
      system: 'openclaw',
      severity: 'unavailable',
      reasonCode: 'openclaw_status_unavailable',
      title: 'OpenClaw status evidence unavailable',
      detail: 'The status reader did not return evidence; session evidence remains available.',
      detailHref: '/systems',
      evidenceRefs: ['openclaw:heartbeat'],
    });
  }
  if (sessionsUnavailable) {
    attention.push({
      id: 'openclaw:sessions-unavailable',
      system: 'openclaw',
      severity: 'unavailable',
      reasonCode: 'openclaw_sessions_unavailable',
      title: 'OpenClaw session evidence unavailable',
      detail: 'The session reader did not return evidence; status evidence remains available.',
      detailHref: '/sessions',
      evidenceRefs: ['openclaw:sessions'],
    });
  }
  if (sessionConflict) {
    attention.push({
      id: 'openclaw:session-conflict',
      system: 'openclaw',
      severity: 'warning',
      reasonCode: 'openclaw_session_count_conflict',
      title: 'OpenClaw session evidence conflicts',
      detail: caveats[0],
      detailHref: '/sessions',
      evidenceRefs: ['openclaw:sessions', 'openclaw:heartbeat'],
    });
  }
  if (heartbeatStale) {
    attention.push({
      id: 'openclaw:heartbeat-stale',
      system: 'openclaw',
      severity: 'warning',
      reasonCode: 'openclaw_heartbeat_stale',
      title: 'OpenClaw heartbeat needs fresh proof',
      detail: 'The last verified heartbeat is older than two hours or unavailable.',
      detailHref: '/systems',
      evidenceRefs: ['openclaw:heartbeat'],
    });
  }

  return {
    system: {
      id: 'openclaw',
      label: 'OpenClaw',
      state: caveats.length ? 'warning' : 'healthy',
      observedAt: at,
      freshness: statusUnavailable ? 'unavailable' : heartbeatStale ? 'stale' : 'fresh',
      caveats,
      metrics: {
        activeSessions,
        channels: Array.isArray(status?.agent?.channels) ? status.agent.channels.length : 0,
        cronJobs: Array.isArray(cron?.jobs)
          ? cron.jobs.filter((job) => job?.scheduler !== 'hermes').length
          : null,
      },
      evidence: openclawEvidence,
      detailHref: '/systems',
    },
    attention,
  };
}

function adaptHermes(board, cron, generatedAt) {
  if (!board || board?.unavailable || board?.ok === false) {
    return unavailableSystem(
      'hermes',
      'Hermes',
      '/work',
      generatedAt,
      'Hermes Kanban could not be read.',
    );
  }

  const at = observedAt(board?.refreshedAt, generatedAt);
  const blocked = Number(board?.summary?.blocked || 0);
  const running = Number(board?.summary?.running || 0);
  const state = blocked > 0 ? 'critical' : 'healthy';
  const proof = evidence(
    'hermes:kanban',
    'hermes',
    'work',
    state,
    at,
    `${running} running, ${blocked} blocked`,
    '/api/hermes-kanban',
    '/work',
  );
  return {
    system: {
      id: 'hermes',
      label: 'Hermes',
      state,
      observedAt: at,
      freshness: 'fresh',
      caveats: blocked > 0 ? [`${blocked} Hermes tasks are blocked.`] : [],
      metrics: {
        total: Number(board?.summary?.total || 0),
        active: Number(board?.summary?.active || 0),
        running,
        blocked,
        cronJobs: Array.isArray(cron?.jobs)
          ? cron.jobs.filter((job) => job?.scheduler === 'hermes').length
          : null,
      },
      evidence: [proof],
      detailHref: '/work',
    },
    attention: blocked > 0 ? [{
      id: 'hermes:blocked',
      system: 'hermes',
      severity: 'critical',
      reasonCode: 'hermes_tasks_blocked',
      title: 'Hermes work is blocked',
      detail: `${blocked} tasks require operator review.`,
      detailHref: '/work',
      evidenceRefs: [proof.id],
    }] : [],
  };
}

function adaptGBrain(overview, generatedAt) {
  if (!overview || overview?.unavailable || overview?.ok === false) {
    return unavailableSystem(
      'gbrain',
      'GBrain',
      '/gbrain',
      generatedAt,
      'GBrain overview could not be read.',
    );
  }

  const at = observedAt(
    overview?.trust?.lastVerifiedAt || overview?.refreshedAt,
    generatedAt,
  );
  const trustState = ['healthy', 'warning', 'critical', 'inactive'].includes(overview?.trust?.status)
    ? overview.trust.status
    : 'unavailable';
  const caveats = Array.isArray(overview?.caveats)
    ? overview.caveats.map((item) => cleanText(String(item)))
    : [];
  const staleSources = Number(overview?.live?.sources?.freshness?.staleCount || 0);
  const sourceStale = staleSources > 0;
  const state = trustState === 'healthy' && caveats.length ? 'warning' : trustState;
  const proof = evidence(
    'gbrain:trust',
    'gbrain',
    'trust',
    state,
    at,
    `${cleanText(overview?.trust?.label, 'GBrain trust unavailable')} · ${Number(overview?.trust?.score || 0)}/100`,
    '/api/gbrain/overview',
    '/gbrain',
  );
  return {
    system: {
      id: 'gbrain',
      label: 'GBrain',
      state,
      observedAt: at,
      freshness: sourceStale ? 'stale' : 'fresh',
      caveats,
      metrics: {
        trustScore: Number(overview?.trust?.score || 0),
        staleSources,
        caveats: caveats.length,
      },
      evidence: [proof],
      detailHref: '/gbrain',
    },
    attention: caveats.map((detail, index) => ({
      id: `gbrain:caveat:${index}`,
      system: 'gbrain',
      severity: state === 'critical' ? 'critical' : 'warning',
      reasonCode: 'gbrain_active_caveat',
      title: 'GBrain has an active caveat',
      detail,
      detailHref: '/gbrain',
      evidenceRefs: [proof.id],
    })),
  };
}

function buildOperationsOverview(input = {}, { generatedAt = new Date().toISOString() } = {}) {
  const adapted = {
    openclaw: adaptOpenClaw(input.status, input.sessions, input.cron, generatedAt),
    hermes: adaptHermes(input.hermes, input.cron, generatedAt),
    gbrain: adaptGBrain(input.gbrain, generatedAt),
  };
  const systems = Object.fromEntries(
    Object.entries(adapted).map(([id, value]) => [id, value.system]),
  );
  const evidenceItems = Object.values(systems)
    .flatMap((system) => system.evidence)
    .sort((a, b) => String(b.observedAt).localeCompare(String(a.observedAt)));
  const attention = Object.values(adapted)
    .flatMap((value) => value.attention)
    .sort((a, b) => (
      STATE_RANK[b.severity] - STATE_RANK[a.severity] || a.id.localeCompare(b.id)
    ));
  const state = deriveOverallStatus(systems);
  return {
    ok: true,
    schemaVersion: '1',
    generatedAt,
    mode: 'live-read-first',
    overall: {
      state,
      reasonCodes: attention.map((item) => item.reasonCode),
    },
    systems,
    attention,
    evidence: evidenceItems,
    capabilities: Array.isArray(input.capabilities) ? input.capabilities : [],
  };
}

function withTimeout(reader, timeoutMs, source) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${source} timed out`)), timeoutMs);

    Promise.resolve()
      .then(() => {
        if (typeof reader !== 'function') throw new Error(`${source} reader unavailable`);
        return reader();
      })
      .then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        },
      );
  });
}

function createOperationsOverviewService({
  readers = {},
  listCapabilities = () => [],
  now = () => new Date(),
  sourceTimeoutMs = 10_000,
} = {}) {
  async function getOverview() {
    const names = ['status', 'sessions', 'cron', 'hermes', 'gbrain'];
    const results = await Promise.allSettled(
      names.map((name) => withTimeout(readers[name], sourceTimeoutMs, name)),
    );
    const input = Object.fromEntries(results.map((result, index) => [
      names[index],
      result.status === 'fulfilled'
        ? result.value
        : {
          ok: false,
          unavailable: true,
          error: result.reason?.message || `${names[index]} unavailable`,
        },
    ]));
    input.capabilities = listCapabilities();
    return buildOperationsOverview(input, { generatedAt: now().toISOString() });
  }

  return { getOverview };
}

module.exports = {
  STATE_RANK,
  buildOperationsCapabilities,
  buildOperationsOverview,
  createOperationsOverviewService,
  deriveOverallStatus,
};
