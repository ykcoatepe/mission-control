const STATE_RANK = {
  critical: 5,
  warning: 4,
  unavailable: 3,
  inactive: 2,
  healthy: 1,
};
const FUTURE_SKEW_MS = 5 * 60 * 1000;
const RFC3339_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|([+-])(\d{2}):(\d{2}))$/i;

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
    timeoutMs: typeof action?.timeoutMs === 'number'
      && Number.isFinite(action.timeoutMs)
      && action.timeoutMs > 0
      ? action.timeoutMs
      : null,
    refreshAfter: Boolean(action?.refreshAfter),
    enabled: true,
    disabledReason: '',
    actionEndpoint: '/api/gbrain/actions',
  }));
}

function observedAt(value, referenceAt) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  const match = trimmed.match(RFC3339_TIMESTAMP);
  if (!match) return null;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText,
    , offsetHourText, offsetMinuteText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const offsetHour = offsetHourText == null ? 0 : Number(offsetHourText);
  const offsetMinute = offsetMinuteText == null ? 0 : Number(offsetMinuteText);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12
    || day < 1 || day > daysInMonth[month - 1]
    || hour > 23 || minute > 59 || second > 59
    || offsetHour > 23 || offsetMinute > 59) return null;
  const parsed = Date.parse(trimmed);
  if (!Number.isFinite(parsed)) return null;
  const referenceTime = Date.parse(referenceAt);
  if (Number.isFinite(referenceTime) && parsed > referenceTime + FUTURE_SKEW_MS) return null;
  return new Date(parsed).toISOString();
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isCount(value) {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function hasSourceProof(value, generatedAt) {
  const proof = value?.operationsSource;
  return isRecord(proof)
    && proof.sourceSucceeded === true
    && typeof proof.provenance === 'string'
    && proof.provenance.trim().length > 0
    && Boolean(observedAt(proof.observedAt, generatedAt));
}

function hasStatusProof(status, generatedAt) {
  return isRecord(status)
    && !status.unavailable
    && status.ok !== false
    && hasSourceProof(status, generatedAt)
    && Boolean(observedAt(status.generatedAt, generatedAt))
    && isRecord(status.agent)
    && isCount(status.agent.activeSessions)
    && Array.isArray(status.agent.channels);
}

function hasSessionsProof(sessions, generatedAt) {
  return isRecord(sessions)
    && !sessions.unavailable
    && sessions.ok !== false
    && hasSourceProof(sessions, generatedAt)
    && (Array.isArray(sessions.sessions) || isCount(sessions.count));
}

function getSchedulerProof(cron, scheduler) {
  return cron?.operationsSource?.schedulers?.[scheduler];
}

function hasCronProof(cron, generatedAt, scheduler) {
  const proof = getSchedulerProof(cron, scheduler);
  return isRecord(cron)
    && !cron.unavailable
    && cron.ok !== false
    && isRecord(proof)
    && proof.sourceSucceeded === true
    && typeof proof.provenance === 'string'
    && proof.provenance.trim().length > 0
    && Boolean(observedAt(proof.observedAt, generatedAt))
    && Array.isArray(cron.jobs);
}

function sourceObservedAt(value, generatedAt) {
  return observedAt(value?.operationsSource?.observedAt, generatedAt);
}

function schedulerObservedAt(cron, scheduler, generatedAt) {
  return observedAt(getSchedulerProof(cron, scheduler)?.observedAt, generatedAt);
}

function hasHermesProof(board, generatedAt) {
  const summary = board?.summary;
  return isRecord(board)
    && !board.unavailable
    && board.ok !== false
    && Boolean(observedAt(board.refreshedAt, generatedAt))
    && isRecord(summary)
    && ['total', 'active', 'running', 'blocked'].every((key) => isCount(summary[key]));
}

function hasGBrainProof(overview, generatedAt) {
  const trust = overview?.trust;
  const sourceFreshness = overview?.live?.sources?.freshness;
  return isRecord(overview)
    && !overview.unavailable
    && overview.ok !== false
    && isRecord(trust)
    && ['healthy', 'warning', 'critical', 'inactive'].includes(trust.status)
    && typeof trust.score === 'number'
    && Number.isFinite(trust.score)
    && trust.score >= 0
    && trust.score <= 100
    && typeof trust.label === 'string'
    && trust.label.trim().length > 0
    && Boolean(observedAt(trust.lastVerifiedAt, generatedAt))
    && Array.isArray(overview.caveats)
    && isRecord(sourceFreshness)
    && isCount(sourceFreshness.staleCount);
}

function epochObservedAt(value, referenceAt) {
  let numeric;
  try {
    numeric = Number(value);
  } catch {
    return null;
  }
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  const milliseconds = numeric > 1e12 ? numeric : numeric * 1000;
  if (!Number.isFinite(milliseconds)) return null;
  const date = new Date(milliseconds);
  const time = date.getTime();
  if (!Number.isFinite(time)) return null;
  const referenceTime = Date.parse(referenceAt);
  if (Number.isFinite(referenceTime) && time > referenceTime + FUTURE_SKEW_MS) return null;
  return date.toISOString();
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

function compareEvidenceByObservedAt(a, b) {
  const aTime = Date.parse(a?.observedAt);
  const bTime = Date.parse(b?.observedAt);
  const aValid = Number.isFinite(aTime);
  const bValid = Number.isFinite(bTime);
  if (aValid && bValid) return bTime - aTime || String(a?.id).localeCompare(String(b?.id));
  if (aValid) return -1;
  if (bValid) return 1;
  return String(a?.id).localeCompare(String(b?.id));
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
  const statusUnavailable = !hasStatusProof(status, generatedAt);
  const sessionsUnavailable = !hasSessionsProof(sessions, generatedAt);
  const cronUnavailable = !hasCronProof(cron, generatedAt, 'openclaw');
  if (statusUnavailable && sessionsUnavailable) {
    return unavailableSystem(
      'openclaw',
      'OpenClaw',
      '/systems',
      generatedAt,
      'OpenClaw status and sessions could not be read.',
    );
  }

  const statusAt = statusUnavailable ? null : observedAt(status.generatedAt, generatedAt);
  const sessionsAt = sessionsUnavailable ? null : sourceObservedAt(sessions, generatedAt);
  const cronAt = cronUnavailable ? null : schedulerObservedAt(cron, 'openclaw', generatedAt);
  const at = statusAt || sessionsAt;
  const statusSessions = statusUnavailable ? 0 : Number(status?.agent?.activeSessions || 0);
  const statusSessionsObserved = !statusUnavailable && status?.agent?.activeSessionsObserved !== false;
  const activeSessions = sessionsUnavailable
    ? statusSessions
    : Array.isArray(sessions?.sessions)
      ? sessions.sessions.filter((session) => session?.isActive).length
      : Number(sessions?.count || 0);
  const sessionConflict = statusSessionsObserved
    && !sessionsUnavailable
    && statusSessions !== activeSessions;
  const sessionConflictDetail = sessionConflict
    ? `Status reports ${statusSessions} active sessions while the session reader reports ${activeSessions}.`
    : '';
  const heartbeatAt = statusUnavailable
    ? null
    : epochObservedAt(status?.heartbeat?.lastHeartbeat, generatedAt);
  const heartbeatDisabled = !statusUnavailable
    && String(status?.agent?.heartbeatInterval || '').trim().toLowerCase() === 'disabled';
  const heartbeatStale = !heartbeatDisabled && (
    !heartbeatAt
    || (Date.parse(generatedAt) - Date.parse(heartbeatAt)) > 2 * 60 * 60 * 1000
  );
  const caveats = [
    ...(statusUnavailable ? ['OpenClaw status evidence is unavailable.'] : []),
    ...(sessionsUnavailable ? ['OpenClaw session evidence is unavailable.'] : []),
    ...(cronUnavailable ? ['OpenClaw scheduling evidence is unavailable.'] : []),
    ...(sessionConflict ? [sessionConflictDetail] : []),
    ...(heartbeatStale ? ['Heartbeat proof is stale or unavailable.'] : []),
  ];
  const openclawEvidence = [
    evidence(
      'openclaw:status-sessions',
      'openclaw',
      'status-sessions',
      statusUnavailable ? 'unavailable' : sessionConflict ? 'warning' : 'healthy',
      statusAt,
      statusUnavailable
        ? 'Status session evidence unavailable'
        : !statusSessionsObserved
          ? 'Status does not expose a comparable active-session count'
        : `${statusSessions} active sessions reported by status`,
      '/api/status',
      '/systems',
    ),
    evidence(
      'openclaw:sessions',
      'openclaw',
      'sessions',
      sessionsUnavailable ? 'unavailable' : sessionConflict ? 'warning' : 'healthy',
      sessionsAt,
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
      statusUnavailable ? 'unavailable' : heartbeatDisabled ? 'inactive' : heartbeatStale ? 'warning' : 'healthy',
      heartbeatAt,
      heartbeatDisabled
        ? 'Heartbeat disabled by configuration'
        : heartbeatStale
          ? 'Heartbeat stale or unavailable'
          : 'Heartbeat current',
      '/api/status',
      '/systems',
    ),
  ];
  if (cronUnavailable) {
    openclawEvidence.push(evidence(
      'openclaw:cron',
      'openclaw',
      'scheduling',
      'unavailable',
      cronAt,
      'OpenClaw scheduling evidence unavailable',
      '/api/cron',
      '/automations',
    ));
  }
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
      evidenceRefs: ['openclaw:status-sessions', 'openclaw:heartbeat'],
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
  if (cronUnavailable) {
    attention.push({
      id: 'openclaw:cron-unavailable',
      system: 'openclaw',
      severity: 'unavailable',
      reasonCode: 'openclaw_cron_unavailable',
      title: 'OpenClaw scheduling evidence unavailable',
      detail: 'The cron reader did not return OpenClaw scheduling evidence.',
      detailHref: '/automations',
      evidenceRefs: ['openclaw:cron'],
    });
  }
  if (sessionConflict) {
    attention.push({
      id: 'openclaw:session-conflict',
      system: 'openclaw',
      severity: 'warning',
      reasonCode: 'openclaw_session_count_conflict',
      title: 'OpenClaw session evidence conflicts',
      detail: sessionConflictDetail,
      detailHref: '/sessions',
      evidenceRefs: ['openclaw:status-sessions', 'openclaw:sessions'],
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
        channels: !statusUnavailable && Array.isArray(status?.agent?.channels)
          ? status.agent.channels.length
          : 0,
        cronJobs: !cronUnavailable && Array.isArray(cron?.jobs)
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
  if (!hasHermesProof(board, generatedAt)) {
    return unavailableSystem(
      'hermes',
      'Hermes',
      '/work',
      generatedAt,
      'Hermes Kanban could not be read.',
    );
  }

  const at = observedAt(board.refreshedAt, generatedAt);
  const blocked = Number(board?.summary?.blocked || 0);
  const running = Number(board?.summary?.running || 0);
  const cronUnavailable = !hasCronProof(cron, generatedAt, 'hermes');
  const cronAt = cronUnavailable ? null : schedulerObservedAt(cron, 'hermes', generatedAt);
  const kanbanState = blocked > 0 ? 'warning' : 'healthy';
  const state = cronUnavailable ? 'warning' : 'healthy';
  const proof = evidence(
    'hermes:kanban',
    'hermes',
    'work',
    kanbanState,
    at,
    `${running} running, ${blocked} blocked`,
    '/api/hermes-kanban',
    '/work',
  );
  const hermesEvidence = [proof];
  if (cronUnavailable) {
    hermesEvidence.push(evidence(
      'hermes:cron',
      'hermes',
      'scheduling',
      'unavailable',
      cronAt,
      'Hermes scheduling evidence unavailable',
      '/api/cron',
      '/automations',
    ));
  } else {
    hermesEvidence.push(evidence(
      'hermes:cron',
      'hermes',
      'scheduling',
      'healthy',
      cronAt,
      `${cron.jobs.filter((job) => job?.scheduler === 'hermes').length} Hermes scheduled jobs`,
      '/api/cron',
      '/automations',
    ));
  }
  const attention = [];
  if (blocked > 0) {
    attention.push({
      id: 'hermes:blocked',
      system: 'hermes',
      severity: 'warning',
      reasonCode: 'hermes_tasks_blocked',
      title: 'Hermes work is blocked',
      detail: `${blocked} tasks require operator review.`,
      detailHref: '/work',
      evidenceRefs: [proof.id],
    });
  }
  if (cronUnavailable) {
    attention.push({
      id: 'hermes:cron-unavailable',
      system: 'hermes',
      severity: 'unavailable',
      reasonCode: 'hermes_cron_unavailable',
      title: 'Hermes scheduling evidence unavailable',
      detail: 'The cron reader did not return Hermes scheduling evidence.',
      detailHref: '/automations',
      evidenceRefs: ['hermes:cron'],
    });
  }
  return {
    system: {
      id: 'hermes',
      label: 'Hermes',
      state,
      observedAt: at,
      freshness: 'fresh',
      caveats: [
        ...(blocked > 0 ? [`${blocked} Hermes tasks are blocked.`] : []),
        ...(cronUnavailable ? ['Hermes scheduling evidence is unavailable.'] : []),
      ],
      metrics: {
        total: Number(board?.summary?.total || 0),
        active: Number(board?.summary?.active || 0),
        running,
        blocked,
        cronJobs: !cronUnavailable && Array.isArray(cron?.jobs)
          ? cron.jobs.filter((job) => job?.scheduler === 'hermes').length
          : null,
      },
      evidence: hermesEvidence,
      detailHref: '/work',
    },
    attention,
  };
}

function adaptGBrain(overview, generatedAt) {
  if (!hasGBrainProof(overview, generatedAt)) {
    return unavailableSystem(
      'gbrain',
      'GBrain',
      '/gbrain',
      generatedAt,
      'GBrain overview could not be read.',
    );
  }

  const at = observedAt(overview.trust.lastVerifiedAt, generatedAt);
  const trustState = overview.trust.status;
  const caveats = overview.caveats.map((item) => cleanText(String(item)));
  const staleSources = overview.live.sources.freshness.staleCount;
  const sourceStale = staleSources > 0;
  const state = trustState === 'healthy' && (caveats.length || sourceStale)
    ? 'warning'
    : trustState;
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
  const staleProof = sourceStale ? evidence(
    'gbrain:source-freshness',
    'gbrain',
    'source-freshness',
    'warning',
    at,
    `${staleSources} stale GBrain sources`,
    '/api/gbrain/overview',
    '/gbrain',
  ) : null;
  const attention = caveats.map((detail, index) => ({
    id: `gbrain:caveat:${index}`,
    system: 'gbrain',
    severity: state === 'critical' ? 'critical' : 'warning',
    reasonCode: 'gbrain_active_caveat',
    title: 'GBrain has an active caveat',
    detail,
    detailHref: '/gbrain',
    evidenceRefs: [proof.id],
  }));
  if (staleProof) {
    attention.push({
      id: 'gbrain:stale-sources',
      system: 'gbrain',
      severity: 'warning',
      reasonCode: 'gbrain_stale_sources',
      title: 'GBrain source evidence is stale',
      detail: `${staleSources} sources require a fresh verification signal.`,
      detailHref: '/gbrain',
      evidenceRefs: [staleProof.id],
    });
  }
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
      evidence: staleProof ? [proof, staleProof] : [proof],
      detailHref: '/gbrain',
    },
    attention,
  };
}

function buildOperationsOverview(input = {}, { generatedAt = new Date().toISOString() } = {}) {
  const adapted = {
    openclaw: adaptOpenClaw(input.status, input.sessions, input.cron, generatedAt),
    hermes: adaptHermes(input.hermes, input.cron, generatedAt),
    gbrain: adaptGBrain(input.gbrain, generatedAt),
  };
  if (input.capabilitiesUnavailable) {
    const capabilityProof = evidence(
      'gbrain:capabilities-unavailable',
      'gbrain',
      'capabilities',
      'unavailable',
      generatedAt,
      'GBrain capability metadata unavailable',
      'GBrain capability registry',
      '/gbrain',
    );
    adapted.gbrain.system.evidence.push(capabilityProof);
    adapted.gbrain.attention.push({
      id: 'gbrain:capabilities-unavailable',
      system: 'gbrain',
      severity: 'unavailable',
      reasonCode: 'gbrain_capabilities_unavailable',
      title: 'GBrain capability metadata unavailable',
      detail: 'Read evidence remains available, but the safe action catalog could not be read.',
      detailHref: '/gbrain',
      evidenceRefs: [capabilityProof.id],
    });
  }
  const systems = Object.fromEntries(
    Object.entries(adapted).map(([id, value]) => [id, value.system]),
  );
  const evidenceItems = Object.values(systems)
    .flatMap((system) => system.evidence)
    .sort(compareEvidenceByObservedAt);
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
    try {
      input.capabilities = buildOperationsCapabilities({
        gbrainActions: listCapabilities(),
      });
    } catch {
      input.capabilities = [];
      input.capabilitiesUnavailable = true;
    }
    return buildOperationsOverview(input, { generatedAt: now().toISOString() });
  }

  return { getOverview };
}

function createOperationsReaders({
  statusService,
  sessionsService,
  cronService,
  hermesKanbanService,
  gbrainOverviewService,
} = {}) {
  return {
    status: () => statusService.getOperationsStatusResponse(),
    sessions: () => sessionsService.getOperationsSessions(25),
    cron: async () => {
      const parsed = await cronService.fetchCronJobsForOperations();
      const jobs = Array.isArray(parsed) ? parsed : parsed?.jobs || [];
      return {
        jobs: jobs.map(cronService.mapCronJobForApi),
        operationsSource: parsed?.operationsSource || {
          sourceSucceeded: false,
          provenance: 'scheduler-readers-unavailable',
          observedAt: null,
          schedulers: {},
        },
      };
    },
    hermes: () => hermesKanbanService.getBoard(),
    gbrain: async () => (await gbrainOverviewService.readSnapshot()).overview,
  };
}

module.exports = {
  STATE_RANK,
  buildOperationsCapabilities,
  buildOperationsOverview,
  createOperationsOverviewService,
  createOperationsReaders,
  deriveOverallStatus,
};
