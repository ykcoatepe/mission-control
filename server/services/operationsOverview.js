const STATE_RANK = {
  critical: 5,
  warning: 4,
  unavailable: 3,
  inactive: 2,
  healthy: 1,
};
const HERMES_SOFT_DEADLINE_MS = 7_000;
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

const GATEWAY_STATUSES = ['running', 'stale', 'down'];

function hasGatewayProof(gateway, generatedAt) {
  return isRecord(gateway)
    && !gateway.unavailable
    && gateway.ok !== false
    && GATEWAY_STATUSES.includes(gateway.status)
    && Boolean(observedAt(gateway.observedAt, generatedAt));
}

function formatAge(seconds) {
  if (seconds < 90) return `${seconds}s`;
  return `${Math.round(seconds / 60)}m`;
}

// Gateway liveness is the primary Hermes signal; Kanban is work evidence.
function adaptHermes(board, cron, generatedAt, gateway) {
  const gatewayProven = hasGatewayProof(gateway, generatedAt);
  const kanbanProven = hasHermesProof(board, generatedAt);
  if (!gatewayProven && !kanbanProven) {
    return unavailableSystem(
      'hermes',
      'Hermes',
      '/work',
      generatedAt,
      'Hermes gateway and Kanban could not be read.',
    );
  }

  const hermesEvidence = [];
  const attention = [];
  const caveats = [];
  const states = [];

  // Gateway
  let gatewayAt = null;
  if (gatewayProven) {
    gatewayAt = observedAt(gateway.observedAt, generatedAt);
    const gatewayState = gateway.status === 'down' ? 'critical' : gateway.status === 'stale' ? 'warning' : 'healthy';
    states.push(gatewayState);
    const summaries = {
      running: 'Gateway running',
      stale: 'Gateway heartbeat is stale',
      down: 'Gateway is not running',
    };
    hermesEvidence.push(evidence(
      'hermes:gateway', 'hermes', 'gateway', gatewayState, gatewayAt,
      summaries[gateway.status], 'hermes gateway state', '/work',
    ));
    if (gateway.status === 'down') {
      attention.push({
        id: 'hermes:gateway-down',
        system: 'hermes',
        severity: 'critical',
        reasonCode: 'hermes_gateway_down',
        title: 'Hermes gateway is down',
        detail: 'The Hermes gateway process is not running; Kanban reads do not prove Hermes is serving.',
        detailHref: '/work',
        evidenceRefs: ['hermes:gateway'],
      });
      caveats.push('Hermes gateway is down.');
    } else if (gateway.status === 'stale') {
      attention.push({
        id: 'hermes:gateway-stale',
        system: 'hermes',
        severity: 'warning',
        reasonCode: 'hermes_gateway_stale',
        title: 'Hermes gateway heartbeat is stale',
        detail: 'The gateway process exists but has not refreshed its heartbeat recently.',
        detailHref: '/work',
        evidenceRefs: ['hermes:gateway'],
      });
      caveats.push('Hermes gateway heartbeat is stale.');
    }
  } else {
    states.push('warning');
    hermesEvidence.push(evidence(
      'hermes:gateway', 'hermes', 'gateway', 'unavailable', null,
      'Hermes gateway liveness unavailable', 'hermes gateway state', '/work',
    ));
    attention.push({
      id: 'hermes:gateway-unverified',
      system: 'hermes',
      severity: 'unavailable',
      reasonCode: 'hermes_gateway_unverified',
      title: 'Hermes gateway liveness unverified',
      detail: 'The gateway state could not be read, so Hermes cannot be reported healthy.',
      detailHref: '/work',
      evidenceRefs: ['hermes:gateway'],
    });
    caveats.push('Hermes gateway liveness is unverified.');
  }

  // Kanban
  const blocked = kanbanProven ? Number(board?.summary?.blocked || 0) : 0;
  const running = kanbanProven ? Number(board?.summary?.running || 0) : 0;
  const kanbanStale = kanbanProven && board.stale === true;
  const kanbanAgeSeconds = kanbanStale && Number.isFinite(Number(board.staleAgeMs))
    ? Math.max(0, Math.round(Number(board.staleAgeMs) / 1000))
    : null;
  const at = kanbanProven ? observedAt(board.refreshedAt, generatedAt) : gatewayAt;
  if (kanbanProven) {
    const kanbanState = blocked > 0 ? 'warning' : 'healthy';
    states.push(kanbanState);
    const proof = evidence(
      'hermes:kanban', 'hermes', 'work', kanbanState, at,
      `${running} running, ${blocked} blocked${kanbanStale ? ' (stale)' : ''}`,
      '/api/hermes-kanban', '/work',
    );
    hermesEvidence.push(proof);
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
      caveats.push(`${blocked} Hermes tasks are blocked.`);
    }
    if (kanbanStale) {
      caveats.push(`Hermes Kanban data is stale${kanbanAgeSeconds === null ? '' : ` (${formatAge(kanbanAgeSeconds)} old)`}.`);
    }
  } else {
    states.push('warning');
    hermesEvidence.push(evidence(
      'hermes:kanban', 'hermes', 'work', 'unavailable', null,
      'Hermes Kanban could not be read', '/api/hermes-kanban', '/work',
    ));
    attention.push({
      id: 'hermes:kanban-unavailable',
      system: 'hermes',
      severity: 'unavailable',
      reasonCode: 'hermes_kanban_unavailable',
      title: 'Hermes Kanban could not be read',
      detail: 'The gateway state is known, but work evidence is unavailable.',
      detailHref: '/work',
      evidenceRefs: ['hermes:kanban'],
    });
    caveats.push('Hermes Kanban could not be read.');
  }

  // Scheduling
  const cronUnavailable = !hasCronProof(cron, generatedAt, 'hermes');
  const cronAt = cronUnavailable ? null : schedulerObservedAt(cron, 'hermes', generatedAt);
  const cronStale = !cronUnavailable && getSchedulerProof(cron, 'hermes')?.stale === true;
  if (cronUnavailable) {
    states.push('warning');
    hermesEvidence.push(evidence(
      'hermes:cron', 'hermes', 'scheduling', 'unavailable', cronAt,
      'Hermes scheduling evidence unavailable', '/api/cron', '/automations',
    ));
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
    caveats.push('Hermes scheduling evidence is unavailable.');
  } else {
    hermesEvidence.push(evidence(
      'hermes:cron', 'hermes', 'scheduling', 'healthy', cronAt,
      `${cron.jobs.filter((job) => job?.scheduler === 'hermes').length} Hermes scheduled jobs${cronStale ? ' (stale)' : ''}`,
      '/api/cron', '/automations',
    ));
    if (cronStale) caveats.push('Hermes scheduling evidence is stale.');
  }

  // blocked tasks warn through attention only (state stays as before)
  const state = states.includes('critical')
    ? 'critical'
    : (!gatewayProven || !kanbanProven || cronUnavailable || gateway?.status === 'stale')
      ? 'warning'
      : 'healthy';
  const freshness = kanbanStale || cronStale || !kanbanProven ? 'stale' : 'fresh';
  return {
    system: {
      id: 'hermes',
      label: 'Hermes',
      state,
      observedAt: at,
      freshness,
      caveats,
      metrics: {
        total: Number(board?.summary?.total || 0),
        active: Number(board?.summary?.active || 0),
        running,
        blocked,
        cronJobs: !cronUnavailable && Array.isArray(cron?.jobs)
          ? cron.jobs.filter((job) => job?.scheduler === 'hermes').length
          : null,
        ...(kanbanAgeSeconds !== null ? { kanbanAgeSeconds } : {}),
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
    hermes: adaptHermes(input.hermes, input.cron, generatedAt, input.hermesGateway),
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

const OPERATIONS_SOURCE_NAMES = Object.freeze(['status', 'sessions', 'cron', 'hermes', 'hermesGateway', 'gbrain']);

// Refresh budgets per reader (backend map, 'operations' recommendations):
// Hermes every 30 s; OpenClaw status/sessions serialized on the openclaw lane
// every 60 s (sessions gets lane wait on top of its 10 s); cron every 60 s
// (its own 7 s soft deadline); GBrain every 60 s with the GBrain deadline
// passed in from the probe constants (the GBrain service runs its own probe
// schedule; readSnapshot serves its last result). The status reader only
// reads the status service's memory (the openclaw.status source refreshes it).
const OPERATIONS_SOURCE_BUDGETS = Object.freeze({
  status: { intervalMs: 30_000, timeoutMs: 10_000 },
  sessions: { intervalMs: 60_000, timeoutMs: 30_000 },
  cron: { intervalMs: 60_000, timeoutMs: 10_000 },
  hermes: { intervalMs: 30_000, timeoutMs: 10_000 },
  hermesGateway: { intervalMs: 30_000, timeoutMs: 10_000 },
  gbrain: { intervalMs: 60_000, timeoutMs: 10_000 },
});

// One meta for a payload composed from several sources: ok only when every
// part is ok, stale when any part is, observedAt = the oldest observation.
function composeMeta(parts, sourceId) {
  const entries = Object.entries(parts);
  const metas = entries.filter(([, snap]) => snap && snap.meta);
  const observed = metas
    .map(([, snap]) => Date.parse(snap.meta.observedAt))
    .filter(Number.isFinite);
  const oldest = observed.length ? Math.min(...observed) : null;
  const failing = metas.filter(([, snap]) => !snap.meta.ok).map(([name]) => name);
  const missing = entries.filter(([, snap]) => !snap || !snap.meta).map(([name]) => name);
  const ages = metas.map(([, snap]) => snap.meta.ageMs).filter(Number.isFinite);
  return {
    ok: failing.length === 0 && missing.length === 0 && metas.length > 0,
    stale: metas.some(([, snap]) => snap.meta.stale) || missing.length > 0 || metas.length === 0,
    observedAt: oldest == null ? null : new Date(oldest).toISOString(),
    ageMs: ages.length ? Math.max(...ages) : null,
    error: failing.length || missing.length
      ? { code: 'partial', message: `Not current: ${[...failing, ...missing].join(', ')}` }
      : null,
    latencyMs: null,
    source: sourceId,
    sources: Object.fromEntries(metas.map(([name, snap]) => [name, snap.meta])),
  };
}

// A reader result that says it could not read is a failed read: the source
// keeps its last good value instead of replacing it with an unavailable body.
function sourceReadFromReader(reader, name) {
  return async () => {
    if (typeof reader !== 'function') {
      throw Object.assign(new Error(`${name} reader unavailable`), { code: `${name}_reader_missing` });
    }
    let value;
    try {
      value = await reader();
    } catch (error) {
      // Reader text may carry child-process output; meta gets a fixed message.
      const code = typeof error?.code === 'string' && /^[a-z][a-z0-9_]{1,63}$/i.test(error.code)
        ? error.code
        : `${name}_read_failed`;
      throw Object.assign(new Error(`${name} could not be read`), { code });
    }
    if (value == null || value.ok === false || value.unavailable === true) {
      throw Object.assign(new Error(`${name} could not be read`), { code: `${name}_unavailable` });
    }
    return value;
  };
}

// One scheduled source per Operations reader. The app registers each with
// the scheduler; GET /api/operations/overview then only composes from them.
function createOperationsSources({
  readers = {},
  createSource,
  sourceTimeoutMsOverrides = {},
  budgets = OPERATIONS_SOURCE_BUDGETS,
  now = Date.now,
  logger = null,
} = {}) {
  if (typeof createSource !== 'function') throw new TypeError('createOperationsSources: createSource required');
  return Object.fromEntries(OPERATIONS_SOURCE_NAMES.map((name) => {
    const budget = budgets[name] || { intervalMs: 60_000, timeoutMs: 10_000 };
    const timeoutMs = sourceTimeoutMsOverrides[name] ?? budget.timeoutMs;
    return [name, {
      intervalMs: budget.intervalMs,
      source: createSource({
        id: `operations.${name}`,
        read: sourceReadFromReader(readers[name], name),
        ttlMs: budget.intervalMs,
        timeoutMs,
        staleAfterMs: Math.max(3 * budget.intervalMs, timeoutMs + budget.intervalMs),
        now,
        logger,
      }),
    }];
  }));
}

// Memory-only input: last-good data while it is younger than its source's
// stale horizon, otherwise the same unavailable marker a failed live read
// produced. Never a default.
function inputFromSources(sources) {
  const input = {};
  const snapshots = {};
  for (const name of OPERATIONS_SOURCE_NAMES) {
    const source = sources[name];
    const snapshot = typeof source?.snapshot === 'function' ? source.snapshot() : null;
    snapshots[name] = snapshot;
    const staleAfterMs = typeof source?.status === 'function' ? source.status().staleAfterMs : null;
    const agedOut = snapshot?.meta?.ageMs != null && Number.isFinite(staleAfterMs) && snapshot.meta.ageMs > staleAfterMs;
    input[name] = snapshot?.data != null && !agedOut
      ? snapshot.data
      : {
        ok: false,
        unavailable: true,
        error: agedOut ? `${name} evidence is older than its freshness limit` : `${name} has not been observed`,
      };
  }
  return { input, snapshots };
}

function createOperationsOverviewService({
  readers = {},
  sources = null,
  listCapabilities = () => [],
  now = () => new Date(),
  sourceTimeoutMs = 10_000,
  sourceTimeoutMsOverrides = {},
} = {}) {
  function withCapabilities(input) {
    try {
      input.capabilities = buildOperationsCapabilities({
        gbrainActions: listCapabilities(),
      });
    } catch {
      input.capabilities = [];
      input.capabilitiesUnavailable = true;
    }
    return input;
  }

  // With scheduled sources the overview is composed from memory only: no
  // reader runs and nothing waits on an upstream.
  if (sources) {
    const missing = OPERATIONS_SOURCE_NAMES.filter((name) => typeof sources[name]?.snapshot !== 'function');
    if (missing.length) throw new TypeError(`createOperationsOverviewService: sources missing ${missing.join(', ')}`);
    return {
      async getOverview() {
        const { input, snapshots } = inputFromSources(sources);
        const overview = buildOperationsOverview(withCapabilities(input), { generatedAt: now().toISOString() });
        return { ...overview, meta: composeMeta(snapshots, 'operations.overview') };
      },
    };
  }

  async function getOverview() {
    const names = ['status', 'sessions', 'cron', 'hermes', 'hermesGateway', 'gbrain'];
    const results = await Promise.allSettled(
      names.map((name) => withTimeout(
        readers[name],
        sourceTimeoutMsOverrides[name] ?? sourceTimeoutMs,
        name,
      )),
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
    return buildOperationsOverview(withCapabilities(input), { generatedAt: now().toISOString() });
  }

  // Live mode (no sources): kept for callers and tests that pass readers
  // directly. The app wires sources, so no request reaches this path there.
  return { getOverview };
}

function createOperationsReaders({
  statusService,
  sessionsService,
  cronService,
  hermesKanbanService,
  hermesGatewayHealthService,
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
    // Soft deadline < sourceTimeoutMs so a slow CLI refresh yields the cached
    // (stale) board instead of timing the whole system out.
    hermes: () => hermesKanbanService.getBoard({ softDeadlineMs: HERMES_SOFT_DEADLINE_MS }),
    hermesGateway: () => hermesGatewayHealthService.getHealth(),
    gbrain: async () => (await gbrainOverviewService.readSnapshot()).overview,
  };
}

module.exports = {
  OPERATIONS_SOURCE_BUDGETS,
  OPERATIONS_SOURCE_NAMES,
  STATE_RANK,
  buildOperationsCapabilities,
  buildOperationsOverview,
  composeMeta,
  createOperationsOverviewService,
  createOperationsReaders,
  createOperationsSources,
  deriveOverallStatus,
};
