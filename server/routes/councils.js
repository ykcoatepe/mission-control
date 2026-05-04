const express = require('express');

function normalizeDecisionRecord(decision) {
  return {
    decisionId: decision.decisionId || decision.id || `DEC-${Date.now()}`,
    council: String(decision.council || 'CROSS').toUpperCase(),
    context: decision.context || '',
    decision: decision.decision || decision.outcome || 'pending',
    outcome: decision.outcome || decision.decision || undefined,
    conditions: Array.isArray(decision.conditions) ? decision.conditions : [],
    voters: Array.isArray(decision.voters) ? decision.voters : [],
    modelFamilies: Array.isArray(decision.modelFamilies) ? decision.modelFamilies : [],
    options: Array.isArray(decision.options) ? decision.options : [],
    quorum: decision.quorum && typeof decision.quorum === 'object' ? decision.quorum : undefined,
    dissent: Array.isArray(decision.dissent) ? decision.dissent : [],
    source: decision.source || decision.createdBy || decision.origin,
    owner: decision.owner || 'orchestrator',
    risk: decision.risk || 'medium',
    status: decision.status || decision.decision || 'open',
    revisitDate: decision.revisitDate,
    evidence: Array.isArray(decision.evidence) ? decision.evidence : [],
    rationale: decision.rationale,
    updatedAt: decision.updatedAt || decision.createdAt || new Date().toISOString(),
    createdAt: decision.createdAt || decision.updatedAt || new Date().toISOString(),
    linkedTaskId: decision.linkedTaskId || decision.taskId,
    delegatedTaskState: decision.delegatedTaskState,
  };
}

function isOpenDecisionStatus(status) {
  const normalized = String(status || '').toLowerCase();
  return ['open', 'pending', 'needs_info', 'need_more_info', 'blocked', 'delegated', 'in_progress'].includes(normalized);
}

function summarizeCouncils(decisions) {
  const base = {
    EC: { health: 'green', openDecisions: 0, totalDecisions: 0, resolvedDecisions: 0, approved: 0, approvedWithConditions: 0, rejected: 0, closed: 0, lastDecisionAt: null },
    OC: { health: 'green', openDecisions: 0, totalDecisions: 0, resolvedDecisions: 0, approved: 0, approvedWithConditions: 0, rejected: 0, closed: 0, lastDecisionAt: null },
    TFC: { health: 'green', openDecisions: 0, totalDecisions: 0, resolvedDecisions: 0, approved: 0, approvedWithConditions: 0, rejected: 0, closed: 0, lastDecisionAt: null },
    CROSS: { health: 'green', openDecisions: 0, totalDecisions: 0, resolvedDecisions: 0, approved: 0, approvedWithConditions: 0, rejected: 0, closed: 0, lastDecisionAt: null },
  };

  for (const decision of decisions) {
    const key = String(decision.council || 'CROSS').toUpperCase();
    if (!base[key]) continue;
    const bucket = base[key];
    const status = String(decision.status || decision.outcome || decision.decision || '').toLowerCase();
    const updatedAt = decision.updatedAt || decision.createdAt || null;

    bucket.totalDecisions += 1;
    if (isOpenDecisionStatus(status)) bucket.openDecisions += 1;
    else bucket.resolvedDecisions += 1;
    if (status === 'approved') bucket.approved += 1;
    else if (status === 'approved_with_conditions') bucket.approvedWithConditions += 1;
    else if (status === 'rejected') bucket.rejected += 1;
    else if (['closed', 'stale_closed', 'resolved'].includes(status)) bucket.closed += 1;
    if (updatedAt && (!bucket.lastDecisionAt || Date.parse(updatedAt) > Date.parse(bucket.lastDecisionAt))) {
      bucket.lastDecisionAt = updatedAt;
    }

    if (isOpenDecisionStatus(status) && String(decision.risk || '').toLowerCase() === 'critical') bucket.health = 'red';
    else if (isOpenDecisionStatus(status) && String(decision.risk || '').toLowerCase() === 'high' && bucket.health !== 'red') bucket.health = 'yellow';
  }

  return base;
}

function buildArchiveMetrics(decisions) {
  const statusCounts = {};
  const ownerCounts = {};
  const riskCounts = {};
  let lastDecisionAt = null;
  let oldestDecisionAt = null;

  for (const decision of decisions) {
    const status = String(decision.status || decision.outcome || decision.decision || 'unknown').toLowerCase();
    const owner = String(decision.owner || 'unknown');
    const risk = String(decision.risk || 'unknown').toLowerCase();
    const ts = decision.updatedAt || decision.createdAt || null;
    statusCounts[status] = (statusCounts[status] || 0) + 1;
    ownerCounts[owner] = (ownerCounts[owner] || 0) + 1;
    riskCounts[risk] = (riskCounts[risk] || 0) + 1;
    if (ts && (!lastDecisionAt || Date.parse(ts) > Date.parse(lastDecisionAt))) lastDecisionAt = ts;
    if (ts && (!oldestDecisionAt || Date.parse(ts) < Date.parse(oldestDecisionAt))) oldestDecisionAt = ts;
  }

  const activeDecisions = decisions.filter((decision) => isOpenDecisionStatus(decision.status)).length;
  const conditionalApprovals = Number(statusCounts.approved_with_conditions || 0);
  return {
    activeDecisions,
    totalDecisions: decisions.length,
    archivedDecisions: Math.max(0, decisions.length - activeDecisions),
    resolvedDecisions: decisions.length - activeDecisions,
    conditionalApprovals,
    rejectedDecisions: Number(statusCounts.rejected || 0),
    closedDecisions: Number(statusCounts.closed || 0) + Number(statusCounts.stale_closed || 0) + Number(statusCounts.resolved || 0),
    statusCounts,
    ownerCounts,
    riskCounts,
    lastDecisionAt,
    oldestDecisionAt,
    mode: activeDecisions > 0 ? 'active_governance' : 'archive_health',
  };
}

function isDelegationAutorunInfraFailureText(text) {
  const normalized = String(text || '').toLowerCase();
  return (
    normalized.includes('gateway timeout') ||
    normalized.includes('pairing required') ||
    normalized.includes('connection timeout') ||
    normalized.includes('could not start') ||
    normalized.includes('spawn error') ||
    normalized.includes('timed out')
  );
}

function isAutorunFailedEvent(event) {
  return String(event?.eventType || '') === 'decision.delegation.autorun.failed';
}

function isAutorunInfraFailedEvent(event) {
  const eventType = String(event?.eventType || '');
  if (eventType === 'decision.delegation.autorun.degraded') return true;
  if (!isAutorunFailedEvent(event)) return false;
  const payload = event?.payload && typeof event.payload === 'object' ? event.payload : {};
  const failureText = `${payload.response || ''} ${payload.error || ''}`;
  return isDelegationAutorunInfraFailureText(failureText);
}

function buildCouncilsRouter({
  readRuntimeSnapshot,
  writeRuntimeSnapshot,
  runtimeSnapshotTtl,
  decisionLogPath,
  opsEventsPath,
  agentRegistryPath,
  readJsonFileSafe,
  writeJsonFileAtomic,
}) {
  const router = express.Router();
  const councilActionsEnabled = String(process.env.MISSION_CONTROL_ENABLE_COUNCIL_ACTIONS || '').trim() === '1';

  function buildCouncilsSummaryPayload() {
    const raw = readJsonFileSafe(decisionLogPath, []);
    const decisions = Array.isArray(raw) ? raw.map(normalizeDecisionRecord) : [];
    const metrics = buildArchiveMetrics(decisions);
    return {
      purpose: 'decision_archive_governance_health',
      councils: summarizeCouncils(decisions),
      metrics,
      archive: {
        mode: metrics.mode,
        totalDecisions: metrics.totalDecisions,
        archivedDecisions: metrics.archivedDecisions,
        activeDecisions: metrics.activeDecisions,
        lastDecisionAt: metrics.lastDecisionAt,
        oldestDecisionAt: metrics.oldestDecisionAt,
        statusCounts: metrics.statusCounts,
        ownerCounts: metrics.ownerCounts,
        riskCounts: metrics.riskCounts,
      },
    };
  }

  function buildGovernanceScorecardPayload() {
    const raw = readJsonFileSafe(decisionLogPath, []);
    const decisions = Array.isArray(raw) ? raw.map(normalizeDecisionRecord) : [];
    const open = decisions.filter((decision) => isOpenDecisionStatus(decision.status)).length;
    const blocked = decisions.filter((decision) => String(decision.status || '').toLowerCase() === 'blocked').length;
    const delegatedBlocked = decisions.filter((decision) => String(decision.delegatedTaskState || '').toLowerCase() === 'blocked').length;

    const nowMs = Date.now();
    const liveCutoffMs = nowMs - (24 * 60 * 60 * 1000);
    const rawEvents = readJsonFileSafe(opsEventsPath, []);
    const events = Array.isArray(rawEvents) ? rawEvents : [];
    const parseEventTs = (event) => {
      const rawTs = event?.timestamp || event?.createdAt;
      if (!rawTs) return null;
      const parsed = Date.parse(rawTs);
      return Number.isFinite(parsed) ? parsed : null;
    };

    const autorunStarted = events.filter((event) => String(event?.eventType || '') === 'decision.delegation.autorun.started');
    const autorunFailed = events.filter((event) => isAutorunFailedEvent(event));
    const autorunInfraFailed = events.filter((event) => isAutorunInfraFailedEvent(event));
    const autorunApplicationFailedCount = Math.max(0, autorunFailed.length - autorunInfraFailed.length);
    const autorunAttempts = autorunStarted.length + autorunApplicationFailedCount;
    const autorunSuccessRate = autorunAttempts > 0 ? (autorunStarted.length / autorunAttempts) : 1;

    const autorunFailed24h = autorunFailed.filter((event) => {
      const ts = parseEventTs(event);
      return ts !== null && ts >= liveCutoffMs;
    });
    const autorunInfraFailed24h = autorunInfraFailed.filter((event) => {
      const ts = parseEventTs(event);
      return ts !== null && ts >= liveCutoffMs;
    });

    const latestReviewEvent = events
      .filter((event) => String(event?.eventType || '') === 'governance.review.completed')
      .slice()
      .sort((left, right) => (parseEventTs(right) || 0) - (parseEventTs(left) || 0))[0] || null;
    const latestReviewPayload = latestReviewEvent?.payload && typeof latestReviewEvent.payload === 'object'
      ? latestReviewEvent.payload
      : null;
    const latestReviewOverall = String(latestReviewPayload?.overall || '').toLowerCase() === 'yellow' ? 'yellow' : 'green';
    const selfReferentialSurfaceWarn = Boolean(latestReviewPayload?.selfReferentialSurfaceWarn);
    const effectiveOverall = (blocked > 0 || latestReviewOverall === 'yellow' || selfReferentialSurfaceWarn) ? 'yellow' : 'green';

    return {
      overall: effectiveOverall,
      mode: 'archive_only',
      recommendation: 'Keep councils as a read-only governance archive; use Workflow, Cron Jobs, Digital Office, and Tasks for live operations.',
      metrics: {
        delegationAutorunSuccessRate: Number(autorunSuccessRate.toFixed(3)),
        delegationAutorunAttempts: autorunAttempts,
        delegationAutorunFailureAttempts: autorunFailed.length,
        delegationAutorunFailureAttemptsLive24h: autorunFailed24h.length,
        delegationAutorunFailureAttemptsStale: Math.max(0, autorunFailed.length - autorunFailed24h.length),
        delegationAutorunTotalAttempts: autorunStarted.length + autorunFailed.length,
        delegationAutorunInfraFailureAttempts: autorunInfraFailed.length,
        delegationAutorunInfraFailureAttemptsLive24h: autorunInfraFailed24h.length,
        delegationAutorunInfraFailureAttemptsStale: Math.max(0, autorunInfraFailed.length - autorunInfraFailed24h.length),
        delegatedBlocked,
        activeDecisions: open,
      },
      review: latestReviewPayload ? {
        overall: latestReviewOverall,
        timestamp: latestReviewEvent?.timestamp || latestReviewEvent?.createdAt || null,
        warnMetrics: Array.isArray(latestReviewPayload.warnMetrics) ? latestReviewPayload.warnMetrics : [],
        recentEventsLive24h: Number(latestReviewPayload.recentEventsLive24h || 0),
        governanceEventsLive24h: Number(latestReviewPayload.governanceEventsLive24h || 0),
        allNonGovernanceEventsLive24h: Number(latestReviewPayload.allNonGovernanceEventsLive24h || 0),
        nonGovernanceEventsLive24h: Number(latestReviewPayload.nonGovernanceEventsLive24h || 0),
        workflowHeartbeatEventsLive24h: Number(latestReviewPayload.workflowHeartbeatEventsLive24h || 0),
        governanceReviewSurfaceRatio24h: latestReviewPayload.governanceReviewSurfaceRatio24h ?? null,
        governanceReviewLoopingWarn: Boolean(latestReviewPayload.governanceReviewLoopingWarn),
        governanceOnlyLive24h: Boolean(latestReviewPayload.governanceOnlyLive24h),
        workflowSurfaceLive24h: Number(latestReviewPayload.workflowSurfaceLive24h || 0),
        workflowSurfaceLive4d: Number(latestReviewPayload.workflowSurfaceLive4d || 0),
        governanceEventsLive4d: Number(latestReviewPayload.governanceEventsLive4d || 0),
        nonGovernanceEventsLive4d: Number(latestReviewPayload.nonGovernanceEventsLive4d || 0),
        governanceOnlyLive4d: Boolean(latestReviewPayload.governanceOnlyLive4d),
        workflowSurfaceGap4dWarn: Boolean(latestReviewPayload.workflowSurfaceGap4dWarn),
        workflowSignalGapWarn: Boolean(latestReviewPayload.workflowSignalGapWarn),
        workflowSurfaceLastSeenAt: latestReviewPayload.workflowSurfaceLastSeenAt || null,
        workflowSurfaceLastSource: latestReviewPayload.workflowSurfaceLastSource || null,
        workflowSurfaceSilenceHours: latestReviewPayload.workflowSurfaceSilenceHours == null ? null : Number(latestReviewPayload.workflowSurfaceSilenceHours),
        selfReferentialSurfaceWarn: Boolean(latestReviewPayload.selfReferentialSurfaceWarn),
        eventSourcesLive24h: Array.isArray(latestReviewPayload.eventSourcesLive24h) ? latestReviewPayload.eventSourcesLive24h : [],
        idleAdvisories: Array.isArray(latestReviewPayload.idleAdvisories) ? latestReviewPayload.idleAdvisories : [],
        rcaTaskCreated: latestReviewPayload.rcaTaskCreated || null,
        rcaTaskActive: latestReviewPayload.rcaTaskActive || null,
        registryCanonicalTaskCreated: latestReviewPayload.registryCanonicalTaskCreated || null,
        registryCanonicalTaskActive: latestReviewPayload.registryCanonicalTaskActive || null,
      } : null,
    };
  }

  router.get('/api/councils/summary', (req, res) => {
    const snapshot = readRuntimeSnapshot('councils-summary', runtimeSnapshotTtl.councilsSummary);
    if (snapshot) return res.json(snapshot);
    return res.json(writeRuntimeSnapshot('councils-summary', buildCouncilsSummaryPayload()));
  });

  router.get('/api/councils/decisions', (req, res) => {
    const raw = readJsonFileSafe(decisionLogPath, []);
    const decisions = (Array.isArray(raw) ? raw : [])
      .map(normalizeDecisionRecord)
      .sort((left, right) => new Date(right.updatedAt || right.createdAt || 0).getTime() - new Date(left.updatedAt || left.createdAt || 0).getTime());
    return res.json({ decisions });
  });

  router.get('/api/councils/agents', (req, res) => {
    const registry = readJsonFileSafe(agentRegistryPath, {});
    const agents = Array.isArray(registry?.agents) ? registry.agents : (Array.isArray(registry) ? registry : []);
    return res.json({ agents });
  });

  router.get('/api/councils/governance/scorecard', (req, res) => {
    const snapshot = readRuntimeSnapshot('governance-scorecard', runtimeSnapshotTtl.governanceScorecard);
    if (snapshot) return res.json(snapshot);
    return res.json(writeRuntimeSnapshot('governance-scorecard', buildGovernanceScorecardPayload()));
  });

  router.get('/api/councils/decisions/:decisionId/timeline', (req, res) => {
    const decisionId = String(req.params.decisionId || '').trim();
    const events = readJsonFileSafe(opsEventsPath, []);
    const decisionEvents = (Array.isArray(events) ? events : [])
      .filter((event) => {
        if (String(event?.entityId || '') === decisionId) return true;
        const meta = event?.payload?.meta || {};
        const data = event?.data || {};
        const payload = event?.payload || {};
        return String(meta?.decisionId || '') === decisionId
          || String(data?.decisionId || '') === decisionId
          || String(payload?.decisionId || '') === decisionId
          || String(data?.linkedDecisionId || '') === decisionId
          || String(payload?.linkedDecisionId || '') === decisionId;
      })
      .sort((left, right) => new Date(right.timestamp || 0).getTime() - new Date(left.timestamp || 0).getTime());
    return res.json({ events: decisionEvents.slice(0, 50) });
  });

  router.post('/api/councils/decisions/:decisionId/action', (req, res) => {
    if (!councilActionsEnabled) {
      return res.status(410).json({
        error: 'Council actions are disabled',
        mode: 'archive_only',
        recommendation: 'Use live operation surfaces for new work; keep this endpoint disabled unless council execution is explicitly restored.',
      });
    }

    const decisionId = String(req.params.decisionId || '').trim();
    const { action, note, by } = req.body || {};
    if (!decisionId) return res.status(400).json({ error: 'decisionId required' });
    if (!action) return res.status(400).json({ error: 'action required' });
    if (!note || !String(note).trim()) return res.status(400).json({ error: 'note required' });

    const raw = readJsonFileSafe(decisionLogPath, []);
    const list = Array.isArray(raw) ? raw : [];
    const index = list.findIndex((decision) => String(decision?.decisionId || decision?.id || '') === decisionId);
    if (index < 0) return res.status(404).json({ error: 'decision not found' });

    const current = normalizeDecisionRecord(list[index]);
    const normalizedAction = String(action).toLowerCase();
    const statusMap = {
      approve: 'approved',
      reject: 'rejected',
      need_more_info: 'needs_info',
      delegate_to_mudur: 'delegated',
    };
    const nextStatus = statusMap[normalizedAction] || current.status || 'open';
    const updated = {
      ...current,
      status: nextStatus,
      outcome: nextStatus,
      decision: nextStatus,
      updatedAt: new Date().toISOString(),
      rationale: `${String(note).trim()}${by ? ` (by: ${by})` : ''}`,
      delegatedTaskState: normalizedAction === 'delegate_to_mudur' ? 'queued' : current.delegatedTaskState,
    };

    list[index] = updated;
    writeJsonFileAtomic(decisionLogPath, list);

    const events = readJsonFileSafe(opsEventsPath, []);
    const eventList = Array.isArray(events) ? events : [];
    eventList.unshift({
      eventId: `EVT-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      eventType: 'council_manual_action',
      source: 'mission-control-ui',
      entityId: decisionId,
      entityType: 'decision',
      council: updated.council,
      payload: { action: normalizedAction, note: String(note).trim(), by: by || 'unknown' },
      timestamp: new Date().toISOString(),
    });
    writeJsonFileAtomic(opsEventsPath, eventList);

    return res.json({ ok: true, decision: updated });
  });

  return router;
}

module.exports = {
  buildCouncilsRouter,
};
