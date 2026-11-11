'use strict';

const {
  DESIGN_HANDOFF_PATH,
  GBRAIN_INTEGRATION_CONTRACT,
} = require('./constants');
const { formatCount, formatPercent, liveHealthStatus, liveSourceStatus } = require('./liveProbes');
const { buildGBrainIntegrationHealth } = require('./integrationHealth');
const { verdictCaveats } = require('../../sources/gbrain/verdict');
const { listGBrainActions } = require('./actionsExecutor');

function statusLabelText(status) {
  if (status === 'healthy') return 'ready';
  if (status === 'critical') return 'missing';
  if (status === 'warning') return 'unverified';
  return 'not probed';
}

function featureGapDetail(featureGaps = {}) {
  const warningCount = Number(featureGaps.blockingCount || 0);
  const optionalCount = Number(featureGaps.optionalCount || 0);
  const parts = [];
  if (warningCount > 0) parts.push(`${warningCount} maintenance warning${warningCount === 1 ? '' : 's'}`);
  if (optionalCount > 0) parts.push(`${optionalCount} optional feature${optionalCount === 1 ? '' : 's'}`);
  return parts.length ? parts.join('; ') : 'no feature gaps';
}

// Age suffix for a count judged on its OLDEST item, e.g. ' (oldest 4m)'.
function oldestAgeText(seconds) {
  return Number.isFinite(seconds) ? ` (oldest ${Math.max(1, Math.round(seconds / 60))}m)` : '';
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
  const versionValue = liveVersion?.version || null;
  const versionMetricValue = versionValue || 'Unavailable';
  const healthScore = liveHealth?.score ?? null;
  const healthValue = healthScore !== null ? `${healthScore}/100` : 'Unavailable';
  const pages = liveHealth?.metrics?.pages ?? liveSources?.totalPages ?? null;
  const chunks = liveHealth?.metrics?.chunks ?? null;
  const embedded = liveHealth?.metrics?.embedded ?? null;
  // missingEmbeddings is the raw count; only the overdue part is
  // verdict-bearing (health objects without missingEmbeddingsOverdue treat
  // every missing embedding as overdue). Unavailable is a warning, never zero.
  const missing = liveHealth?.metrics?.missingEmbeddings ?? null;
  const missingOverdue = liveHealth?.metrics?.missingEmbeddingsOverdue ?? missing;
  const missingCatchingUp = liveHealth?.metrics?.missingEmbeddingsCatchingUp ?? 0;
  const missingAgeSeconds = liveHealth?.metrics?.missingEmbeddingsOldestAgeSeconds ?? null;
  const missingUnavailable = Boolean(liveHealth) && (
    liveHealth.metrics?.missingEmbeddingsUnavailable === true
  );
  // stalePages is the raw count; only the overdue part is verdict-bearing
  // (health objects without stalePagesOverdue treat every stale page as overdue).
  const stalePagesRaw = liveHealth?.metrics?.stalePages ?? null;
  const stalePages = liveHealth?.metrics?.stalePagesOverdue ?? stalePagesRaw;
  const stalePagesCatchingUp = liveHealth?.metrics?.stalePagesCatchingUp ?? 0;
  const staleLagSeconds = liveHealth?.metrics?.stalePagesOldestLagSeconds ?? null;
  // The overdue verdict is all-or-nothing on the OLDEST page's age, so counts
  // are always shown as the raw stale count with that age, never as an exact
  // number of overdue pages.
  const staleOldestText = oldestAgeText(staleLagSeconds);
  const stalePagesCatchingUpText = stalePagesCatchingUp > 0
    ? `${formatCount(stalePagesCatchingUp)} catching up${staleOldestText}`
    : null;
  const stalePagesValue = stalePagesRaw === null
    ? null
    : !(stalePages > 0) && stalePagesCatchingUpText
    ? stalePagesCatchingUpText
    : `${formatCount(stalePagesRaw)}${stalePages > 0 ? staleOldestText : ''}`;
  const coverage = liveHealth?.metrics?.embeddingCoverage ?? null;
  // Same all-or-nothing rule as stale pages: raw count with the oldest age.
  const missingOldestText = oldestAgeText(missingAgeSeconds);
  const hasMissingEmbeddings = Number.isFinite(missingOverdue) && missingOverdue > 0;
  const missingCatchingUpText = !hasMissingEmbeddings && missingCatchingUp > 0
    ? `${formatCount(missingCatchingUp)} catching up${missingOldestText}`
    : null;
  const missingValue = missing === null
    ? null
    : missingCatchingUpText || `${formatCount(missing)}${hasMissingEmbeddings ? missingOldestText : ''}`;
  // Embed-job overdue causes (failed/dead/failures/waiting) and a probe
  // outage are reported alongside the count; the outage never relaxes the
  // age verdict.
  const missingJobReasons = Array.isArray(liveHealth?.metrics?.missingEmbeddingsJobReasons)
    ? liveHealth.metrics.missingEmbeddingsJobReasons
    : [];
  const missingJobReasonText = missingJobReasons.length ? `; ${missingJobReasons.join('; ')}` : '';
  const missingOverdueText = hasMissingEmbeddings
    ? `Live health reports ${formatCount(missing)} missing embedding${missing === 1 ? '' : 's'}${missingOldestText}${missingJobReasonText}.`
    : null;
  const embedJobProbeUnavailableText = liveHealth?.metrics?.embedJobProbeUnavailable === true
    ? 'Embed-job probe unavailable; the missing-embedding verdict uses embedding age only.'
    : null;
  const missingUnavailableText = 'Live health did not report a valid missing-embedding count.';
  const queue = liveHealth?.metrics?.queue || {};
  const hasLiveQueueCounters = [queue.waiting, queue.active, queue.stalled].every(Number.isFinite);
  const queueUnavailable = Boolean(liveHealth && !hasLiveQueueCounters);
  const healthStatus = live.health?.meta?.stale ? 'warning' : liveHealthStatus(liveHealth, healthUnavailable);
  const queueStatus = healthUnavailable ? 'warning' : queueUnavailable ? 'warning' : healthStatus;
  const sourceStatus = live.sources?.meta?.stale ? 'warning' : liveSourceStatus(liveSources, sourcesUnavailable);
  const queueValue = hasLiveQueueCounters
    ? `${queue.waiting} / ${queue.active} / ${queue.stalled}`
    : 'Unavailable';
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
    : 'Source freshness not read';
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
  ].some((status) => status === 'warning' || status === 'critical'));
  const activeCaveats = [
    ...(healthUnavailable ? ['Live health probe unavailable.'] : []),
    ...(sourcesUnavailable ? ['Live source probe unavailable.'] : []),
    ...(live.health?.meta?.stale ? ['Health evidence is stale; see meta.'] : []),
    ...(live.sources?.meta?.stale ? ['Source evidence is stale; see meta.'] : []),
    ...(liveHealth?.metrics?.stalePagesUnavailable === true ? ['Live health did not report a valid stale-page count.'] : []),
    ...(stalePages > 0 ? [`Live health reports ${formatCount(stalePages)} stale page${stalePages === 1 ? '' : 's'}${staleOldestText}.`] : []),
    ...(missingUnavailable ? [missingUnavailableText] : []),
    ...(missingOverdueText ? [missingOverdueText] : []),
    ...(embedJobProbeUnavailableText ? [embedJobProbeUnavailableText] : []),
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
        label: liveHealth || healthUnavailable ? 'Live health probe' : 'Not read',
        source: liveHealth || healthUnavailable ? 'gbrain call get_health' : 'not-read',
        verifiedAt: liveCheckedAt || null,
        detail: healthUnavailable
          ? `Read-only health probe is unavailable: ${live.health.error}`
          : liveHealth
          ? `Read-only health probe returned ${liveHealth.status}.`
          : 'GBrain core has not been read.',
      },
      metrics: [
        { label: 'Version', value: versionMetricValue },
        { label: 'Pages', value: pages !== null ? formatCount(pages) : healthUnavailable ? 'Unavailable' : 'Unavailable' },
        { label: 'Chunks', value: chunks !== null ? formatCount(chunks) : healthUnavailable ? 'Unavailable' : 'Unavailable' },
        { label: 'Embedded', value: embedded !== null ? formatCount(embedded) : healthUnavailable ? 'Unavailable' : 'Unavailable' },
        ...(stalePagesValue !== null ? [{ label: 'Stale pages', value: stalePagesValue }] : []),
      ],
      risks: [
        liveHealth
          ? stalePages > 0
            ? 'Live health reports stale pages; do not treat current data as fully live.'
            : 'Live probe is read-only and does not prove write or repair paths.'
          : healthUnavailable
          ? 'Live GBrain health probe could not reach the local runtime.'
          : 'Core state has not been read.',
        GBRAIN_INTEGRATION_CONTRACT.localMemoryBoundary,
      ],
      nextSafeAction: liveHealth
        ? 'Use the allowlisted Operator Actions for local maintenance; keep arbitrary repair commands outside this surface.'
        : healthUnavailable
        ? 'Restore local GBrain database connectivity, then refresh this page.'
        : 'Restore local GBrain database connectivity, then refresh the live health probe.',
    },
    ...[
      ['hermes', 'Hermes hmudur'], ['openclaw', 'OpenClaw'], ['codex', 'Codex'],
    ].map(([id, label]) => ({ id, label, kind: 'agent', status: 'inactive',
      summary: 'Reader calls have not been observed.',
      proof: { label: 'Not read', source: 'not-read', verifiedAt: null,
        detail: 'MCP configuration and source sync do not establish a successful reader call.' },
      metrics: [], risks: [], nextSafeAction: 'Inspect integration configuration and read evidence.' })),
    {
      id: 'sources',
      label: 'Source Systems',
      kind: 'source',
      status: sourceStatus,
      summary: liveSources
        ? 'Project sources feeding the shared brain, verified by the live source probe.'
        : 'Source systems have not been read.',
      proof: {
        label: liveSources || sourcesUnavailable ? 'Live source probe' : 'Not read',
        source: liveSources || sourcesUnavailable ? 'gbrain sources list' : 'not-read',
        verifiedAt: liveSources?.checkedAt || live.sources?.checkedAt || null,
        detail: sourcesUnavailable
          ? `Read-only source probe is unavailable: ${live.sources.error}`
          : liveSources
          ? `Read-only source probe returned ${sourceCount} registered source${sourceCount === 1 ? '' : 's'}.`
          : 'Registered sources have not been read.',
      },
      metrics: [
        { label: 'Known sources', value: sourceCount !== null ? String(sourceCount) : 'Unavailable' },
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
      summary: missingUnavailable
        ? 'Live health did not report a valid missing-embedding count; embedding coverage is unverified.'
        : hasMissingEmbeddings
        ? `Embedding coverage reports ${formatCount(missing)} missing embedding${missing === 1 ? '' : 's'}${missingOldestText}${missingJobReasonText} in the latest live audit.`
        : missingCatchingUpText
        ? `Embedding coverage is catching up: ${formatCount(missing)} new chunk${missing === 1 ? '' : 's'} awaiting the next embed tick${missingOldestText}.`
        : hasLiveQueueCounters ? 'Embedding and queue counters were read.' : 'Embedding and queue counters have not been read.',
      proof: {
        label: liveHealth || healthUnavailable ? 'Live queue probe' : 'Not read',
        source: liveHealth || healthUnavailable ? 'gbrain jobs stats --json' : 'not-read',
        verifiedAt: liveCheckedAt || null,
        detail: healthUnavailable
          ? `Read-only jobs probe is unavailable because health is unavailable: ${live.health.error}`
          : queueUnavailable
          ? 'Read-only health probe refreshed, but jobs stats counters were unavailable.'
          : liveHealth
          ? 'Read-only health and jobs probes refreshed embedding and queue counters.'
          : 'Embedding and queue statistics have not been read.',
      },
      metrics: [
        { label: 'Coverage', value: coverage !== null ? formatPercent(coverage) : 'Unavailable' },
        { label: 'Missing', value: missingValue !== null ? missingValue : 'Unavailable' },
        { label: 'Stalled', value: Number.isFinite(queue.stalled) ? formatCount(queue.stalled) : 'Unavailable' },
      ],
      risks: [
        ...(healthUnavailable ? ['Live health and jobs probes were unavailable; queue counters are not current.'] : []),
        ...(queueUnavailable ? ['Live jobs stats counters were not available; do not treat queue depth as clean.'] : []),
        ...(missingUnavailable ? [missingUnavailableText] : []),
        ...(missingOverdueText ? [missingOverdueText] : []),
        ...(embedJobProbeUnavailableText ? [embedJobProbeUnavailableText] : []),
      ],
      nextSafeAction: healthUnavailable
        ? 'Restore local GBrain database connectivity, then refresh the live queue probe.'
        : hasMissingEmbeddings
        ? 'Run the embedding repair/backfill path before calling this node clean.'
        : missingUnavailable
        ? 'Refresh the live health probe; do not treat embeddings as clean until it reports a valid missing-embedding count.'
        : 'Refresh at a conservative interval to avoid false negatives or extra load.',
    },
    { id: 'google-bridge', label: 'Google Bridge', kind: 'bridge', status: 'inactive',
      summary: 'Google bridge has not been probed.',
      proof: { label: 'Not read', source: 'not-read', verifiedAt: null, detail: 'No bridge-specific observation is available.' },
      metrics: [], risks: [], nextSafeAction: 'Read bridge-specific evidence before claiming readiness.' },
  ];

  const edges = [
    { id: 'edge-hermes-gbrain', from: 'hermes', to: 'gbrain-core', label: 'read', status: 'inactive', proofNodeId: 'hermes' },
    { id: 'edge-openclaw-gbrain', from: 'openclaw', to: 'gbrain-core', label: 'tool read', status: 'inactive', proofNodeId: 'openclaw' },
    { id: 'edge-codex-gbrain', from: 'codex', to: 'gbrain-core', label: 'source sync', status: 'inactive', proofNodeId: 'codex' },
    { id: 'edge-sources-gbrain', from: 'sources', to: 'gbrain-core', label: 'sync', status: sourceStatus, proofNodeId: 'sources' },
    { id: 'edge-queues-gbrain', from: 'queues', to: 'gbrain-core', label: 'embed', status: queueStatus, proofNodeId: 'queues' },
    { id: 'edge-google-gbrain', from: 'google-bridge', to: 'gbrain-core', label: 'bridge', status: 'inactive', proofNodeId: 'google-bridge' },
  ];

  const overview = {
    ok: true,
    mode: 'live-read-only',
    refreshedAt: liveCheckedAt || null,
    evidenceFreshness: liveAttemptedAt ? 'live-read-only' : 'unavailable',
    title: 'GBrain',
    subtitle: 'Shared memory for Hermes, OpenClaw, and Codex',
    trust: {
      label: !liveHealth
        ? healthUnavailable ? 'Health probe unavailable' : 'Health not read'
        : stalePages > 0 || staleSourceCount > 0
        ? 'Live data stale'
        : hasActiveCaveats
        ? liveHealth
          ? 'Live with caveats'
          : 'Trusted with caveats'
        : liveHealth
        ? 'Live trusted'
        : 'Health not read',
      status: healthUnavailable ? 'warning' : hasActiveCaveats && healthStatus === 'healthy' ? 'warning' : healthStatus,
      score: healthScore,
      lastVerifiedAt: liveCheckedAt || null,
      source: liveAttemptedAt ? 'gbrain call get_health' : 'not-read',
    },
    cockpit: {
      health: { label: 'Health', value: healthValue, status: healthStatus, proofNodeId: 'gbrain-core' },
      version: {
        label: 'Active version',
        value: versionValue || 'Unavailable',
        detail: liveVersion ? 'gbrain --version' : 'version not read',
        status: versionUnavailable || live.version?.meta?.stale ? 'warning' : healthStatus,
        proofNodeId: 'gbrain-core',
      },
      embeddings: {
        label: 'Embeddings',
        value: healthUnavailable ? 'Unavailable' : coverage !== null ? formatPercent(coverage) : 'Unavailable',
        detail: healthUnavailable
          ? 'health probe unavailable'
          : stalePages > 0
          ? `${formatCount(stalePages)} stale pages`
          : missingUnavailable
          ? 'missing-embedding count unavailable'
          : missingCatchingUpText
          ? `${formatCount(missing)} missing, catching up${missingOldestText}`
          : `${missing !== null ? formatCount(missing) : 'Unknown'} missing${hasMissingEmbeddings ? missingOldestText : ''}`,
        status: healthStatus,
        proofNodeId: 'queues',
      },
      freshness: {
        label: 'Freshness',
        value: sourcesUnavailable ? 'Unavailable' : staleSourceCount > 0 ? `${staleSourceCount} stale` : liveSources ? 'Fresh' : 'Unavailable',
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
        detail: `${integrationHealth.toolContract.basePresentCount}/${integrationHealth.toolContract.baseRequiredCount} base tools; think ${statusLabelText(integrationHealth.thinkRuntime.status)}; ${featureGapDetail(integrationHealth.featureGaps)}`,
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
      bridge: { label: 'Bridge proof', value: 'Not read', detail: 'Reader calls have not been observed', status: 'inactive', proofNodeId: 'hermes' },
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

  if (extra.verdict) {
    overview.verdict = extra.verdict;
    overview.state = extra.verdict.state;
    overview.trust.status = extra.verdict.state;
    overview.trust.label = extra.verdict.state === 'healthy' ? 'Operational' : `GBrain ${extra.verdict.state}`;
    overview.caveats = verdictCaveats(extra.verdict);
    if (extra.sourcesState) {
      const sourceNode = overview.nodes.find((node) => node.id === 'sources');
      const sourceIds = new Set((liveSources?.sources || []).map((s) => s.id));
      if (sourceNode) {
        sourceNode.status = extra.sourcesState;
        sourceNode.risks = extra.verdict.reasons.filter((r) => r.state !== 'inactive'
          && (sourceIds.has(r.elementId) || r.elementId === 'gbrain.sources')).map((r) => r.text);
      }
      overview.edges.find((edge) => edge.id === 'edge-sources-gbrain').status = extra.sourcesState;
      overview.cockpit.freshness.status = extra.sourcesState;
      if (extra.sourcesState === 'inactive') overview.cockpit.freshness.value = 'Not applicable';
      if (Number.isFinite(liveSources?.freshness?.freshCount) && Number.isFinite(liveSources?.freshness?.untrackedCount)) overview.cockpit.freshness.detail = `${liveSources.freshness.freshCount} sync-tracked fresh, ${liveSources.freshness.untrackedCount} not applicable`;
    }
    overview.cockpit.caveats = { ...overview.cockpit.caveats, value: String(overview.caveats.length),
      detail: overview.caveats.join(' ') || 'No active caveats', status: extra.verdict.state };
  }
  if (extra.timelineSummary) overview.timelineSummary = extra.timelineSummary;
  if (extra.incidentBanner !== undefined) overview.incidentBanner = extra.incidentBanner;
  if (extra.incidentBanners !== undefined) overview.incidentBanners = extra.incidentBanners;
  return overview;
}

module.exports = { buildGBrainOverview, statusLabelText };
