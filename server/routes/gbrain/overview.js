'use strict';

const {
  AUDIT_REPORT_PATH,
  DESIGN_HANDOFF_PATH,
  AUDIT_VERIFIED_AT,
  GBRAIN_INTEGRATION_CONTRACT,
} = require('./constants');
const { formatCount, formatPercent, liveHealthStatus, liveSourceStatus } = require('./liveProbes');
const { buildGBrainIntegrationHealth } = require('./integrationHealth');
const { listGBrainActions } = require('./actionsExecutor');

function statusLabelText(status) {
  if (status === 'healthy') return 'ready';
  if (status === 'critical') return 'missing';
  if (status === 'warning') return 'unverified';
  return 'not probed';
}

function buildGBrainOverview(live = {}, extra = {}) {
  const liveHealth = live.health?.ok ? live.health : null;
  const liveSources = live.sources?.ok ? live.sources : null;
  const liveVersion = live.version?.ok ? live.version : null;
  const hasIntegrationRuntime = Boolean(extra.integrationRuntime);
  const integrationHealth = buildGBrainIntegrationHealth(live, extra.integrationRuntime || {});
  const liveAttemptedAt = live.health?.checkedAt || live.sources?.checkedAt || live.version?.checkedAt || live.tools?.checkedAt || live.features?.checkedAt || null;
  const liveCheckedAt = liveHealth?.checkedAt || liveSources?.checkedAt || liveVersion?.checkedAt || liveAttemptedAt;
  const healthUnavailable = Boolean(live.health && !live.health.ok);
  const sourcesUnavailable = Boolean(live.sources && !live.sources.ok);
  const versionUnavailable = Boolean(live.version && !live.version.ok);
  const versionValue = liveVersion?.version || '0.40.2.0';
  const versionMetricValue = versionUnavailable ? 'Unavailable' : versionValue;
  const healthScore = liveHealth?.score ?? null;
  const healthValue = healthUnavailable ? 'Unavailable' : healthScore !== null ? `${healthScore}/100` : '9/10';
  const pages = liveHealth?.metrics?.pages ?? liveSources?.totalPages ?? null;
  const chunks = liveHealth?.metrics?.chunks ?? null;
  const embedded = liveHealth?.metrics?.embedded ?? null;
  const missing = liveHealth?.metrics?.missingEmbeddings ?? null;
  const stalePages = liveHealth?.metrics?.stalePages ?? null;
  const coverage = liveHealth?.metrics?.embeddingCoverage ?? null;
  const hasMissingEmbeddings = Number.isFinite(missing) && missing > 0;
  const queue = liveHealth?.metrics?.queue || {};
  const hasLiveQueueCounters = [queue.waiting, queue.active, queue.stalled].every(Number.isFinite);
  const queueUnavailable = Boolean(liveHealth && !hasLiveQueueCounters);
  const healthStatus = liveHealthStatus(liveHealth, healthUnavailable);
  const queueStatus = healthUnavailable ? 'warning' : queueUnavailable ? 'warning' : healthStatus;
  const sourceStatus = liveSourceStatus(liveSources, sourcesUnavailable);
  const queueValue = hasLiveQueueCounters
    ? `${queue.waiting} / ${queue.active} / ${queue.stalled}`
    : liveHealth ? 'Unavailable' : '0 / 0 / 0';
  const sourceCount = liveSources?.count ?? null;
  const sourceWarnings = liveSources?.warningCount ?? null;
  const sourceFreshness = liveSources?.freshness || null;
  const staleSourceCount = sourceFreshness?.staleCount ?? 0;
  const sourceFreshnessStatus = sourceFreshness?.status || sourceStatus;
  const sourceFreshnessDetail = sourcesUnavailable
    ? 'source freshness unavailable'
    : liveSources && sourceFreshness
    ? staleSourceCount > 0
      ? `${staleSourceCount} source${staleSourceCount === 1 ? '' : 's'} stale or missing sync proof`
      : `all sync-tracked sources fresh under ${sourceFreshness.defaultThresholdHours}h default`
    : 'saved audit has no freshness thresholds';
  const sourceRisks = sourcesUnavailable
    ? ['Live source probe could not reach the local GBrain runtime.']
    : staleSourceCount > 0
    ? sourceFreshness.staleSources.map((source) => `${source.id} freshness is ${source.label.toLowerCase()}.`)
    : sourceWarnings > 0
    ? [`${sourceWarnings} live source${sourceWarnings === 1 ? '' : 's'} reported a warning status.`]
    : [];
  const hasRuntimeIntegrationWarning = hasIntegrationRuntime && Boolean(liveAttemptedAt) && integrationHealth.systems.some((system) => [
    system.mcp?.status,
    system.runtimeContract?.status,
    system.readSmoke?.status,
    system.writeSmoke?.status,
  ].some((status) => status === 'warning' || status === 'critical'));
  const activeCaveats = [
    ...(healthUnavailable ? ['Live health probe unavailable.'] : []),
    ...(sourcesUnavailable ? ['Live source probe unavailable.'] : []),
    ...(stalePages > 0 ? [`Live health reports ${formatCount(stalePages)} stale page${stalePages === 1 ? '' : 's'}.`] : []),
    ...(hasMissingEmbeddings ? [`Live health reports ${formatCount(missing)} missing embedding${missing === 1 ? '' : 's'}.`] : []),
    ...(staleSourceCount > 0 ? [`${staleSourceCount} source${staleSourceCount === 1 ? '' : 's'} exceeded freshness thresholds.`] : []),
    ...((sourceWarnings || 0) > 0 ? [`${sourceWarnings} live source${sourceWarnings === 1 ? '' : 's'} reported a warning status.`] : []),
    ...(hasRuntimeIntegrationWarning ? ['Integration health warning: runtime readiness is degraded.'] : []),
    ...(integrationHealth.thinkRuntime?.status === 'warning' || integrationHealth.thinkRuntime?.status === 'critical'
      ? [`${integrationHealth.thinkRuntime.label}: ${integrationHealth.thinkRuntime.detail}`]
      : []),
  ];
  const hasActiveCaveats = activeCaveats.length > 0;

  const nodes = [
    {
      id: 'gbrain-core',
      label: 'GBrain Core',
      kind: 'core',
      status: healthStatus,
      summary: 'Postgres-backed local shared memory for Hermes, OpenClaw, and Codex.',
      proof: {
        label: liveHealth || healthUnavailable ? 'Live health probe' : 'Hermes audit',
        source: liveHealth || healthUnavailable ? 'gbrain call get_health' : AUDIT_REPORT_PATH,
        verifiedAt: liveCheckedAt || AUDIT_VERIFIED_AT,
        detail: healthUnavailable
          ? `Read-only health probe is unavailable: ${live.health.error}`
          : liveHealth
          ? `Read-only health probe returned ${liveHealth.status}.`
          : 'Installed GBrain 0.40.2.0; engine is Postgres-backed; health 9/10.',
      },
      metrics: [
        { label: 'Version', value: versionMetricValue },
        { label: 'Pages', value: pages !== null ? formatCount(pages) : healthUnavailable ? 'Unavailable' : '15,713' },
        { label: 'Chunks', value: chunks !== null ? formatCount(chunks) : healthUnavailable ? 'Unavailable' : '191,638' },
        { label: 'Embedded', value: embedded !== null ? formatCount(embedded) : healthUnavailable ? 'Unavailable' : '191,638' },
        ...(stalePages !== null ? [{ label: 'Stale pages', value: formatCount(stalePages) }] : []),
      ],
      risks: [
        liveHealth
          ? stalePages > 0
            ? 'Live health reports stale pages; do not treat current data as fully live.'
            : 'Live probe is read-only and does not prove write or repair paths.'
          : healthUnavailable
          ? 'Live GBrain health probe could not reach the local runtime.'
          : 'Green state is based on the latest saved audit, not a live mutation or repair run.',
        GBRAIN_INTEGRATION_CONTRACT.localMemoryBoundary,
      ],
      nextSafeAction: liveHealth
        ? 'Use the allowlisted Operator Actions for local maintenance; keep arbitrary repair commands outside this surface.'
        : healthUnavailable
        ? 'Restore local GBrain database connectivity, then refresh this page.'
        : 'Restore local GBrain database connectivity, then refresh the live health probe.',
    },
    {
      id: 'hermes',
      label: 'Hermes hmudur',
      kind: 'agent',
      status: 'healthy',
      summary: 'Conversational operator surface reading GBrain through the MCP bridge while keeping Hermes profile memory local.',
      proof: {
        label: 'Read smoke passed',
        source: AUDIT_REPORT_PATH,
        verifiedAt: AUDIT_VERIFIED_AT,
        detail: 'Hermes hmudur read smoke passed through GBrain MCP.',
      },
      metrics: [
        { label: 'Bridge', value: 'MCP read' },
        { label: 'Memory boundary', value: 'Local + curated' },
      ],
      risks: ['Do not promote raw Hermes transcripts or private profile memory into GBrain.'],
      nextSafeAction: 'Store bridge smoke results as structured JSON instead of report text.',
    },
    {
      id: 'openclaw',
      label: 'OpenClaw',
      kind: 'agent',
      status: 'healthy',
      summary: 'Runtime tool surface with verified GBrain tool-call reads while keeping OpenClaw native memory local.',
      proof: {
        label: 'Tool smoke passed',
        source: AUDIT_REPORT_PATH,
        verifiedAt: AUDIT_VERIFIED_AT,
        detail: 'OpenClaw read smoke passed through GBrain tool with failures 0.',
      },
      metrics: [
        { label: 'Failures', value: '0' },
        { label: 'Memory boundary', value: 'Local + shared recall' },
      ],
      risks: ['Do not mirror raw OpenClaw sessions, credentials, or untagged runtime memory into GBrain.'],
      nextSafeAction: 'Expose latest gateway bridge proof without writing to memory.',
    },
    {
      id: 'codex',
      label: 'Codex',
      kind: 'agent',
      status: 'healthy',
      summary: 'Local Codex memories and workspace sessions included as GBrain sources.',
      proof: {
        label: 'Source registered',
        source: AUDIT_REPORT_PATH,
        verifiedAt: AUDIT_VERIFIED_AT,
        detail: 'Sources include codex-memories and mission-control.',
      },
      metrics: [{ label: 'Mode', value: 'source' }],
      risks: ['Codex is represented as one node in v1; App, memories, and sessions may split later.'],
      nextSafeAction: 'Decide whether Codex needs separate app, memory, and workspace nodes.',
    },
    {
      id: 'sources',
      label: 'Source Systems',
      kind: 'source',
      status: sourceStatus,
      summary: liveSources
        ? 'Project sources feeding the shared brain, verified by the live source probe.'
        : 'Project sources feeding the shared brain, verified by the saved audit.',
      proof: {
        label: liveSources || sourcesUnavailable ? 'Live source probe' : 'Source list captured',
        source: liveSources || sourcesUnavailable ? 'gbrain sources list' : AUDIT_REPORT_PATH,
        verifiedAt: liveSources?.checkedAt || live.sources?.checkedAt || AUDIT_VERIFIED_AT,
        detail: sourcesUnavailable
          ? `Read-only source probe is unavailable: ${live.sources.error}`
          : liveSources
          ? `Read-only source probe returned ${sourceCount} registered source${sourceCount === 1 ? '' : 's'}.`
          : 'Sources include clawd, hermes-agent, gbrain, codex-memories, finance-analyzer, mission-control, PDFQuickFix, JapaneseBuddy, gstack.',
      },
      metrics: [
        { label: 'Known sources', value: sourceCount !== null ? String(sourceCount) : '9' },
        ...(liveSources?.totalPages ? [{ label: 'Source pages', value: formatCount(liveSources.totalPages) }] : []),
        ...(sourceFreshness ? [{ label: 'Stale sources', value: String(staleSourceCount) }] : []),
      ],
      risks: sourceRisks,
      nextSafeAction: liveSources
        ? staleSourceCount > 0
          ? 'Refresh stale source syncs before relying on this as live runtime context.'
          : 'Keep source freshness thresholds visible as the live shape evolves.'
        : sourcesUnavailable
        ? 'Restore local GBrain database connectivity, then refresh this page.'
        : 'Restore local GBrain database connectivity, then refresh the live source probe.',
    },
    {
      id: 'queues',
      label: 'Embedding Queues',
      kind: 'queue',
      status: queueStatus,
      summary: hasMissingEmbeddings
        ? `Embedding coverage reports ${formatCount(missing)} missing embedding${missing === 1 ? '' : 's'} in the latest live audit.`
        : 'Embedding coverage and minion queue are clean in the latest audit.',
      proof: {
        label: liveHealth || healthUnavailable ? 'Live queue probe' : 'Queue audit',
        source: liveHealth || healthUnavailable ? 'gbrain jobs stats --json' : AUDIT_REPORT_PATH,
        verifiedAt: liveCheckedAt || AUDIT_VERIFIED_AT,
        detail: healthUnavailable
          ? `Read-only jobs probe is unavailable because health is unavailable: ${live.health.error}`
          : queueUnavailable
          ? 'Read-only health probe refreshed, but jobs stats counters were unavailable.'
          : liveHealth
          ? 'Read-only health and jobs probes refreshed embedding and queue counters.'
          : 'Embed coverage 100%; missing embeddings 0; 0 waiting, 0 active, 0 stalled.',
      },
      metrics: [
        { label: 'Coverage', value: coverage !== null ? formatPercent(coverage) : healthUnavailable ? 'Unavailable' : '100%' },
        { label: 'Missing', value: missing !== null ? formatCount(missing) : healthUnavailable ? 'Unavailable' : '0' },
        { label: 'Stalled', value: Number.isFinite(queue.stalled) ? formatCount(queue.stalled) : liveHealth || healthUnavailable ? 'Unavailable' : '0' },
      ],
      risks: [
        ...(healthUnavailable ? ['Live health and jobs probes were unavailable; queue counters are not current.'] : []),
        ...(queueUnavailable ? ['Live jobs stats counters were not available; do not treat queue depth as clean.'] : []),
        ...(hasMissingEmbeddings ? [`Live health reports ${formatCount(missing)} missing embedding${missing === 1 ? '' : 's'}.`] : []),
      ],
      nextSafeAction: healthUnavailable
        ? 'Restore local GBrain database connectivity, then refresh the live queue probe.'
        : hasMissingEmbeddings
        ? 'Run the embedding repair/backfill path before calling this node clean.'
        : 'Refresh at a conservative interval to avoid false negatives or extra load.',
    },
    {
      id: 'google-bridge',
      label: 'Google Bridge',
      kind: 'bridge',
      status: 'healthy',
      summary: 'Custom local Google bridge is operational and tracked with bridge-specific proof.',
      proof: {
        label: 'Custom bridge proof captured',
        source: AUDIT_REPORT_PATH,
        verifiedAt: AUDIT_VERIFIED_AT,
        detail: 'Custom local Google bridge is verified separately from the official integrations doctor.',
      },
      metrics: [{ label: 'Bridge signal', value: 'custom verified' }],
      risks: [],
      nextSafeAction: 'Keep the bridge-specific proof fresh alongside Gmail and Calendar ingest checks.',
    },
  ];

  const edges = [
    { id: 'edge-hermes-gbrain', from: 'hermes', to: 'gbrain-core', label: 'read', status: 'healthy', proofNodeId: 'hermes' },
    { id: 'edge-openclaw-gbrain', from: 'openclaw', to: 'gbrain-core', label: 'tool read', status: 'healthy', proofNodeId: 'openclaw' },
    { id: 'edge-codex-gbrain', from: 'codex', to: 'gbrain-core', label: 'source sync', status: 'healthy', proofNodeId: 'codex' },
    { id: 'edge-sources-gbrain', from: 'sources', to: 'gbrain-core', label: 'sync', status: sourceStatus, proofNodeId: 'sources' },
    { id: 'edge-queues-gbrain', from: 'queues', to: 'gbrain-core', label: 'embed', status: queueStatus, proofNodeId: 'queues' },
    { id: 'edge-google-gbrain', from: 'google-bridge', to: 'gbrain-core', label: 'bridge', status: 'healthy', proofNodeId: 'google-bridge' },
  ];

  const overview = {
    ok: true,
    mode: liveAttemptedAt ? 'live-read-only' : 'read-only-fixture',
    refreshedAt: liveCheckedAt || AUDIT_VERIFIED_AT,
    evidenceFreshness: liveAttemptedAt ? 'live-read-only' : 'saved-audit',
    title: 'GBrain',
    subtitle: 'Shared memory for Hermes, OpenClaw, and Codex',
    trust: {
      label: healthUnavailable
        ? 'Health probe unavailable'
        : stalePages > 0 || staleSourceCount > 0
        ? 'Live data stale'
        : hasActiveCaveats
        ? liveHealth
          ? 'Live with caveats'
          : 'Trusted with caveats'
        : liveHealth
        ? 'Live trusted'
        : 'Trusted',
      status: healthUnavailable ? 'warning' : hasActiveCaveats && healthStatus === 'healthy' ? 'warning' : healthStatus,
      score: healthScore ?? 90,
      lastVerifiedAt: liveCheckedAt || AUDIT_VERIFIED_AT,
      source: liveAttemptedAt ? 'gbrain call get_health' : AUDIT_REPORT_PATH,
    },
    cockpit: {
      health: { label: 'Health', value: healthValue, status: healthStatus, proofNodeId: 'gbrain-core' },
      version: {
        label: 'Active version',
        value: versionUnavailable ? 'Unavailable' : versionValue,
        detail: liveVersion ? 'gbrain --version' : versionUnavailable ? 'version probe unavailable' : 'saved audit baseline',
        status: versionUnavailable ? 'warning' : healthStatus,
        proofNodeId: 'gbrain-core',
      },
      embeddings: {
        label: 'Embeddings',
        value: healthUnavailable ? 'Unavailable' : coverage !== null ? formatPercent(coverage) : '100%',
        detail: healthUnavailable
          ? 'health probe unavailable'
          : stalePages > 0
          ? `${formatCount(stalePages)} stale pages`
          : `${missing !== null ? formatCount(missing) : '0'} missing`,
        status: healthStatus,
        proofNodeId: 'queues',
      },
      freshness: {
        label: 'Freshness',
        value: sourcesUnavailable ? 'Unavailable' : staleSourceCount > 0 ? `${staleSourceCount} stale` : liveSources ? 'Fresh' : 'Audit',
        detail: sourceFreshnessDetail,
        status: sourcesUnavailable ? 'warning' : sourceFreshnessStatus,
        proofNodeId: 'sources',
      },
      queue: {
        label: 'Queue',
        value: healthUnavailable ? 'Unavailable' : queueValue,
        detail: healthUnavailable ? 'health probe unavailable' : queueUnavailable ? 'jobs stats unavailable' : 'waiting / active / stalled',
        status: queueStatus,
        proofNodeId: 'queues',
      },
      memoryRole: {
        label: 'Memory role',
        value: 'Shared brain',
        detail: 'Hermes/OpenClaw keep local memory; GBrain stores curated cross-system knowledge',
        status: 'healthy',
        proofNodeId: 'gbrain-core',
      },
      integration: {
        label: 'Integration health',
        value: `${integrationHealth.connectedCount}/${integrationHealth.systemCount} connected`,
        detail: `${integrationHealth.toolContract.basePresentCount}/${integrationHealth.toolContract.baseRequiredCount} base tools; think ${statusLabelText(integrationHealth.thinkRuntime.status)}; ${integrationHealth.featureGaps.optionalCount} optional feature${integrationHealth.featureGaps.optionalCount === 1 ? '' : 's'}`,
        status: integrationHealth.status,
        proofNodeId: 'gbrain-core',
      },
      think: {
        label: 'Think runtime',
        value: integrationHealth.thinkRuntime.status === 'healthy' ? 'Ready' : integrationHealth.thinkRuntime.status === 'inactive' ? 'Not probed' : 'Unverified',
        detail: integrationHealth.thinkRuntime.detail,
        status: integrationHealth.thinkRuntime.status === 'inactive' ? 'warning' : integrationHealth.thinkRuntime.status,
        proofNodeId: 'gbrain-core',
      },
      autopilot: { label: 'Operator actions', value: 'Allowlisted', detail: `${listGBrainActions().length} local actions; probes remain read-only`, status: 'healthy', proofNodeId: 'gbrain-core' },
      bridge: { label: 'Bridge proof', value: '2 passed', detail: 'Hermes + OpenClaw read smokes', status: 'healthy', proofNodeId: 'hermes' },
      caveats: {
        label: 'Caveats',
        value: String(activeCaveats.length),
        detail: activeCaveats.length ? activeCaveats.join(' ') : 'No active caveats',
        status: activeCaveats.length ? 'warning' : 'healthy',
        proofNodeId: activeCaveats.length ? (staleSourceCount > 0 || (sourceWarnings || 0) > 0 ? 'sources' : 'queues') : 'gbrain-core',
      },
    },
    nodes,
    edges,
    caveats: activeCaveats,
    warnings: [],
    integrationContract: GBRAIN_INTEGRATION_CONTRACT,
    integrationHealth,
    handoff: {
      source: DESIGN_HANDOFF_PATH,
      recommendedNextSlice: liveHealth || liveSources
        ? 'Live health/source freshness thresholds are connected read-only.'
        : liveAttemptedAt
        ? 'Live health/source endpoints are connected read-only, but the local GBrain runtime is unavailable.'
        : 'Live health/source endpoints are present but the local GBrain runtime is unavailable.',
    },
    live: {
      health: live.health || null,
      sources: live.sources || null,
      version: live.version || null,
      tools: live.tools || null,
      features: live.features || null,
    },
  };

  if (extra.timelineSummary) overview.timelineSummary = extra.timelineSummary;
  if (extra.incidentBanner !== undefined) overview.incidentBanner = extra.incidentBanner;
  return overview;
}

module.exports = { buildGBrainOverview, statusLabelText };
