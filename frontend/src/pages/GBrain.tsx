import { useMemo, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import {
  AlertTriangle,
  Bot,
  Brain,
  ChevronDown,
  CheckCircle2,
  Clock,
  Database,
  Link2,
  Network,
  Play,
  Radio,
  RefreshCw,
  ShieldCheck,
} from 'lucide-react'
import PageTransition from '../components/PageTransition'
import GlassCard from '../components/GlassCard'
import { formatDate, timeAgo, useApi } from '../lib/hooks'
import { postGBrainAction } from './gbrain/api'
import { deriveOperationalState, deriveQueueEvidenceStatus, timelineDeltaLines } from './gbrain/presentation'
import {
  resolveGBrainAction,
  visibleGBrainActions,
} from './gbrain/actionPolicy'
import type { GBrainActionResult } from './gbrain/types'
import type { GBrainEvidenceStatus } from './gbrain/presentation'
import { ActionConfirmDialog } from './brain/ActionConfirmDialog'
import type { OperationCapability, OperationSystem, SafetyClass } from './brain/types'
import styles from './GBrain.module.css'

type EvidenceStatus = GBrainEvidenceStatus
type NodeKind = 'core' | 'agent' | 'source' | 'queue' | 'bridge'

interface Proof {
  label: string
  source: string
  verifiedAt: string
  detail: string
}

interface GBrainNode {
  id: string
  label: string
  kind: NodeKind
  status: EvidenceStatus
  summary: string
  proof: Proof
  metrics: { label: string; value: string }[]
  risks: string[]
  nextSafeAction: string
}

interface GBrainEdge {
  id: string
  from: string
  to: string
  label: string
  status: EvidenceStatus
  proofNodeId: string
}

interface CockpitMetric {
  label: string
  value: string
  detail: string
  status: EvidenceStatus
  proofNodeId: string
}

interface IntegrationSystem {
  id: string
  label: string
  localMemory: string
  gbrainUse: string
  proof: string
}

interface IntegrationContract {
  role: string
  label: string
  summary: string
  localMemoryBoundary: string
  writePolicy: string
  systems: IntegrationSystem[]
}

interface IntegrationHealthTool {
  id: string
  label: string
  mode: string
  present: boolean
}

interface IntegrationSystemHealth {
  id: string
  label: string
  status: EvidenceStatus
  mcp: { configured: boolean; status: EvidenceStatus; proof: string }
  runtimeContract: { status: EvidenceStatus; proof: string; label: string }
  source: { id: string; status: EvidenceStatus; lastSyncAt: string | null; pages: number | null; proof: string }
  tools: IntegrationHealthTool[]
  thinkRuntime?: ThinkRuntime
  readSmoke: { status: EvidenceStatus; proof: string; checkedAt: string | null }
  writeSmoke: { status: EvidenceStatus; proof: string; label: string }
}

interface ThinkRuntime {
  status: EvidenceStatus
  label: string
  detail: string
  proof: string
  checkedAt: string | null
  toolPresent: boolean
  activeModelConfigured: boolean
  proxyConfigured: boolean
  readyChatProviderCount: number
  readyChatProviders: string[]
}

interface IntegrationHealth {
  ok: boolean
  status: EvidenceStatus
  checkedAt: string
  connectedCount: number
  systemCount: number
  healthyCount: number
  systems: IntegrationSystemHealth[]
  toolContract: {
    status: EvidenceStatus
    checkedAt: string | null
    requiredCount: number
    presentCount: number
    missingCount: number
    baseRequiredCount?: number
    basePresentCount?: number
    tools: IntegrationHealthTool[]
  }
  thinkRuntime: ThinkRuntime
  featureGaps: {
    status: EvidenceStatus
    checkedAt: string | null
    count: number
    blockingCount?: number
    optionalCount?: number
    recommendations: { id: string; priority: number | null; title: string; pitch: string; command: string }[]
  }
}

interface GBrainOverview {
  ok: boolean
  mode: string
  refreshedAt: string
  title: string
  subtitle: string
  trust: {
    label: string
    status: EvidenceStatus
    score: number
    lastVerifiedAt: string
    source: string
  }
  cockpit: Record<string, CockpitMetric>
  nodes: GBrainNode[]
  edges: GBrainEdge[]
  warnings: string[]
  caveats?: string[]
  integrationContract?: IntegrationContract
  integrationHealth?: IntegrationHealth
  handoff: {
    source: string
    recommendedNextSlice: string
  }
  live?: {
    health?: LiveHealth | null
    sources?: LiveSources | null
  }
  timelineSummary?: TimelineSummary
  incidentBanner?: IncidentBanner | null
  incidentBanners?: IncidentBanner[]
}

interface SourceFreshness {
  status: EvidenceStatus
  label: string
  ageHours: number | null
  thresholdHours: number
  lastSyncAt: string | null
}

interface LiveSource {
  id: string
  status: string
  pages: number | null
  chunks: number | null
  lastSyncAt?: string | null
  freshness?: SourceFreshness
}

interface LiveSourcesAvailable {
  ok: true
  checkedAt: string
  freshness?: {
    status: EvidenceStatus
    defaultThresholdHours: number
    staleCount: number
    freshCount: number
    unknownCount: number
    untrackedCount: number
    oldestSourceId: string | null
    oldestAgeHours: number | null
  }
  sources: LiveSource[]
}

interface LiveSourcesUnavailable {
  ok: false
  checkedAt: string
  status: string
  error?: string
  sources: LiveSource[]
  freshness?: undefined
}

type LiveSources = LiveSourcesAvailable | LiveSourcesUnavailable

interface LiveHealthAvailable {
  ok: true
  checkedAt: string
  status: string
  score: number | null
  metrics: {
    pages: number | null
    chunks: number | null
    embedded: number | null
    missingEmbeddings: number | null
    stalePages: number | null
    embeddingCoverage: number | null
    queue: { waiting: number | null; active: number | null; stalled: number | null }
  }
}

interface LiveHealthUnavailable {
  ok: false
  checkedAt: string
  status: string
  error?: string
  score?: undefined
  metrics?: undefined
}

type LiveHealth = LiveHealthAvailable | LiveHealthUnavailable

interface TimelineDiff {
  kind: string
  summary: string
  changes: { field: string; from: string | number | null; to: string | number | null }[]
}

interface IncidentBanner {
  status: EvidenceStatus
  title: string
  detail: string
  snapshotId?: string
  kind?: string
}

interface TimelineSummary {
  enabled: boolean
  status: EvidenceStatus
  lastCapturedAt: string | null
  lastCaptureReason: string
  skippedDuplicateCount: number
  malformedLineCount: number
  retainedEntryCount: number
  warning: string
  diff: TimelineDiff
  incidentBanner: IncidentBanner | null
  incidentBanners?: IncidentBanner[]
}

interface TimelineEntry {
  id: string
  capturedAt: string
  actor: string
  trust: {
    label: string
    status: EvidenceStatus
    score: number | null
    source: string
    lastVerifiedAt: string
  }
  metrics: Record<string, string | number | null>
  bridgeProof: { id: string; label: string; status: EvidenceStatus; proofLabel: string; proofSource: string; verifiedAt: string }[]
  sourceFreshness: { status: EvidenceStatus; label: string; warningCount: number; defaultThresholdHours: number }
  warnings: string[]
}

interface TimelineResponse {
  enabled: boolean
  entries: TimelineEntry[]
  warnings: string[]
  malformedLineCount: number
  retainedEntryCount: number
  truncated: boolean
  limit: number
  schemaVersion: number
  diff: TimelineDiff
  incidentBanner: IncidentBanner | null
  incidentBanners?: IncidentBanner[]
}

type PageGBrainActionResult = GBrainActionResult & {
  pending?: boolean
}

interface GBrainActionDefinition {
  id: string
  label: string
  description: string
  kind: string
  command: string
  refreshAfter: boolean
  timeoutMs?: number
  safetyClass: SafetyClass
  requiresConfirmation: boolean
  enabled?: boolean
  disabledReason?: string
}

interface GBrainActionsResponse {
  ok: boolean
  actions: GBrainActionDefinition[]
}

const fallbackActions: GBrainActionDefinition[] = [
  {
    id: 'sync-sources',
    label: 'Sync local sources',
    description: 'Incrementally sync every registered local source without remote pulls, then embed stale chunks.',
    kind: 'maintenance',
    command: 'gbrain sync --all --no-pull --parallel 1 --timeout 105 --json --yes && gbrain embed --stale',
    refreshAfter: true,
    timeoutMs: 120000,
    safetyClass: 'W1',
    requiresConfirmation: true,
  },
  {
    id: 'embed-stale',
    label: 'Embed stale chunks',
    description: 'Refresh embeddings for chunks marked stale by GBrain.',
    kind: 'maintenance',
    command: 'gbrain embed --stale',
    refreshAfter: true,
    timeoutMs: 120000,
    safetyClass: 'W1',
    requiresConfirmation: true,
  },
  {
    id: 'embed-missing',
    label: 'Backfill missing embeddings',
    description: 'Backfill missing embedding vectors using the stale-chunk fast path, then refresh live proof.',
    kind: 'repair',
    command: 'gbrain embed --stale --priority recent --batch-size 1000',
    refreshAfter: true,
    timeoutMs: 1800000,
    safetyClass: 'W1',
    requiresConfirmation: true,
  },
]

const nodePositions: Record<string, { x: number; y: number; size: number }> = {
  'gbrain-core': { x: 50, y: 50, size: 150 },
  hermes: { x: 17, y: 30, size: 112 },
  openclaw: { x: 83, y: 30, size: 112 },
  codex: { x: 17, y: 70, size: 112 },
  sources: { x: 83, y: 70, size: 112 },
  queues: { x: 50, y: 85, size: 112 },
  'google-bridge': { x: 50, y: 15, size: 112 },
}

function statusColor(status: EvidenceStatus) {
  if (status === 'healthy') return '#32D74B'
  if (status === 'warning') return '#FFD60A'
  if (status === 'critical') return '#FF453A'
  return '#8E8E93'
}

function statusLabel(status: EvidenceStatus) {
  if (status === 'healthy') return 'Verified'
  if (status === 'warning') return 'Caveat'
  if (status === 'critical') return 'Failing'
  return 'Read-only'
}

function proofScopeFor(data: GBrainOverview | null | undefined, loading: boolean) {
  if (loading) {
    return {
      label: 'Checking live proof',
      detail: 'Refreshing read probes before showing operator trust state.',
      status: 'inactive' as EvidenceStatus,
    }
  }

  if (!data) {
    return {
      label: 'No proof loaded',
      detail: 'The cockpit has not received a GBrain overview payload yet.',
      status: 'inactive' as EvidenceStatus,
    }
  }

  if (data.mode === 'live-read-only') {
    return {
      label: data.integrationContract?.label || 'Read proof only',
      detail: data.integrationContract?.summary || 'Health, sources, queues, and bridge checks are live; write and repair proof stays in allowlisted actions.',
      status: data.trust.status,
    }
  }

  return {
    label: data.mode === 'read-only-fixture' ? 'Saved audit baseline' : 'Bounded operator surface',
    detail: 'Use the evidence drawer before treating this state as current operational proof.',
    status: data.trust.status,
  }
}

function actionKindLabel(kind: string) {
  if (kind === 'diagnostic') return 'Check'
  if (kind === 'preview') return 'Dry run'
  if (kind === 'repair') return 'Repair'
  if (kind === 'maintenance') return 'Maintain'
  return 'Action'
}

function actionKindColor(kind: string) {
  if (kind === 'diagnostic') return '#64D2FF'
  if (kind === 'preview') return '#BF5AF2'
  if (kind === 'repair') return '#FFD60A'
  return '#32D74B'
}

function formatActionTimeout(timeoutMs?: number) {
  if (!timeoutMs || timeoutMs <= 0) return ''
  const minutes = Math.round(timeoutMs / 60000)
  if (minutes >= 1) return minutes === 1 ? '1m' : `${minutes}m`
  return `${Math.round(timeoutMs / 1000)}s`
}

function incidentDetailForDisplay(detail: string) {
  const normalized = detail.replace(/\b1 stale pages\b/i, '1 stale page')
  return normalized.replace(/ at (\d{4}-\d{2}-\d{2}T[\d:.]+Z)\.?$/, (_match, timestamp: string) => (
    ` · detected ${timeAgo(timestamp)}`
  ))
}

function kindIcon(kind: NodeKind) {
  if (kind === 'core') return <Brain size={22} />
  if (kind === 'agent') return <Bot size={19} />
  if (kind === 'source') return <Database size={19} />
  if (kind === 'queue') return <RefreshCw size={19} />
  return <Link2 size={19} />
}

function kindAccent(kind: NodeKind) {
  if (kind === 'core') return '#64D2FF'
  if (kind === 'agent') return '#0A84FF'
  if (kind === 'source') return '#BF5AF2'
  return '#5E5CE6'
}

function nodeRole(node: GBrainNode) {
  if (node.kind === 'core') return 'AI Memory Kernel'
  if (node.kind === 'agent') return 'MCP Server'
  if (node.kind === 'source') return 'Data & Knowledge'
  if (node.kind === 'queue') return 'Vector Pipelines'
  if (node.id === 'google-bridge') return 'Custom Bridge'
  return 'Integration Layer'
}

function lineFor(edge: GBrainEdge) {
  const from = nodePositions[edge.from]
  const to = nodePositions[edge.to]
  return { x1: from.x, y1: from.y, x2: to.x, y2: to.y, mx: (from.x + to.x) / 2, my: (from.y + to.y) / 2 }
}

export default function GBrain() {
  const { data, loading, error, refetch } = useApi<GBrainOverview>('/api/gbrain/overview', 30000)
  const {
    data: timeline,
    loading: timelineLoading,
    error: timelineError,
    refetch: refetchTimeline,
  } = useApi<TimelineResponse>('/api/gbrain/timeline?limit=50', 60000)
  const { data: actionsData, error: actionsError } = useApi<GBrainActionsResponse>('/api/gbrain/actions')
  const [selectedId, setSelectedId] = useState('gbrain-core')
  const [runningAction, setRunningAction] = useState<string | null>(null)
  const runningActionRef = useRef<string | null>(null)
  const [actionResult, setActionResult] = useState<PageGBrainActionResult | null>(null)
  const [confirmationActionId, setConfirmationActionId] = useState<string | null>(null)
  const [mapAnimationCycle, setMapAnimationCycle] = useState(0)
  const confirmationTriggerRef = useRef<HTMLButtonElement | null>(null)
  const drawerRef = useRef<HTMLDivElement | null>(null)
  const [acknowledgedIncidents, setAcknowledgedIncidents] = useState<Set<string>>(() => {
    if (typeof window === 'undefined') return new Set()
    try {
      return new Set(JSON.parse(window.localStorage.getItem('gbrain.acknowledgedIncidents') || '[]'))
    } catch {
      return new Set()
    }
  })
  const [recoveredIncidentsExpanded, setRecoveredIncidentsExpanded] = useState(false)

  const selectedNode = useMemo(() => {
    if (!data?.nodes?.length) return null
    return data.nodes.find((node) => node.id === selectedId) || data.nodes[0]
  }, [data, selectedId])

  const nodeById = useMemo(() => new Map((data?.nodes || []).map((node) => [node.id, node])), [data])

  const selectProofNode = (nodeId: string) => {
    const exists = nodeById.has(nodeId)
    if (exists) setSelectedId(nodeId)
  }

  const revealSelectedEvidence = () => {
    drawerRef.current?.scrollIntoView({ behavior: 'auto', block: 'start' })
    drawerRef.current?.focus({ preventScroll: true })
  }

  const timelineSummary = data?.timelineSummary
  const incidentCandidates = data?.incidentBanners?.length
    ? data.incidentBanners
    : timeline?.incidentBanners?.length
      ? timeline.incidentBanners
      : timelineSummary?.incidentBanners?.length
        ? timelineSummary.incidentBanners
        : [data?.incidentBanner || timeline?.incidentBanner || timelineSummary?.incidentBanner].filter(Boolean) as IncidentBanner[]
  const visibleIncidentCandidates = incidentCandidates.filter((candidate) => {
    const key = candidate.snapshotId || `${candidate.title}:${candidate.detail}`
    return candidate.kind !== 'recent-regression' || !acknowledgedIncidents.has(key)
  })
  const activeIncidentBanner = visibleIncidentCandidates.find((candidate) => candidate.kind !== 'recent-regression') || null
  // Timeline heartbeats can retain multiple ledger rows with the same fingerprint.
  // They are one operator-facing incident and must collapse before counting/rendering.
  const recoveredIncidentMap = new Map<string, IncidentBanner>()
  for (const candidate of visibleIncidentCandidates) {
    if (candidate.kind !== 'recent-regression') continue
    const key = candidate.snapshotId || `${candidate.title}:${candidate.detail}`
    if (!recoveredIncidentMap.has(key)) recoveredIncidentMap.set(key, candidate)
  }
  const recoveredIncidentBanners = [...recoveredIncidentMap.values()]
  const recoveredIncidentKeys = [...recoveredIncidentMap.keys()]
  const incidentIsCurrent = Boolean(activeIncidentBanner)
  const timelineEnabled = timeline?.enabled ?? timelineSummary?.enabled ?? true
  const timelineEntries = timeline?.entries || []
  const visibleTimelineEntries = timelineEntries.slice(0, 4)
  const hiddenTimelineCount = Math.max(0, (timeline?.retainedEntryCount ?? timelineEntries.length) - visibleTimelineEntries.length)
  const timelineDiff = timeline?.diff || timelineSummary?.diff
  const showTimelineDiff = Boolean(timelineDiff && timelineDiff.kind !== 'unchanged')
  const staleSources = useMemo(() => {
    return (data?.live?.sources?.sources || []).filter((source) => source.freshness?.status === 'warning')
  }, [data?.live?.sources?.sources])
  const actions = actionsData?.actions?.length ? actionsData.actions : fallbackActions
  const visibleActions = visibleGBrainActions(actions)
  const actionGroups = [
    {
      id: 'r0',
      label: 'R0 diagnostics',
      detail: 'Direct · read-only',
      actions: visibleActions.filter((action) => action.safetyClass === 'R0'),
    },
    {
      id: 'w1',
      label: 'W1 maintenance',
      detail: 'Confirmation required',
      actions: visibleActions.filter((action) => action.safetyClass === 'W1'),
    },
  ].filter((group) => group.actions.length > 0)
  const canRunActions = Boolean(data)
  const proofScope = proofScopeFor(data, loading)
  const confirmationAction = confirmationActionId
    ? resolveGBrainAction(actions, confirmationActionId, 'confirmed', runningAction)
    : null
  const confirmationCapability = confirmationAction
    ? {
        ...confirmationAction,
        system: 'gbrain',
        timeoutMs: confirmationAction.timeoutMs ?? null,
        enabled: confirmationAction.enabled !== false,
        disabledReason: confirmationAction.disabledReason || '',
        actionEndpoint: '/api/gbrain/actions',
      } satisfies OperationCapability
    : null
  const confirmationProof: OperationSystem = {
    id: 'gbrain',
    label: 'GBrain',
    state: data?.trust.status || 'unavailable',
    observedAt: data?.trust.lastVerifiedAt || null,
    freshness: data?.live?.sources?.freshness?.status === 'healthy'
      ? 'fresh'
      : data?.live?.sources?.freshness?.status === 'warning'
        ? 'stale'
        : 'unknown',
    caveats: [...(data?.caveats || []), ...(data?.warnings || [])],
    metrics: {},
    evidence: [],
    detailHref: '/gbrain',
  }
  const selectedContractSystem = data?.integrationContract?.systems?.find((system) => system.id === selectedNode?.id)
  const selectedIntegrationSystem = data?.integrationHealth?.systems?.find((system) => system.id === selectedNode?.id)
  const missingIntegrationTools = data?.integrationHealth?.toolContract?.tools?.filter((tool) => !tool.present) || []
  const integrationConnectedCount = data?.integrationHealth?.connectedCount ?? 0
  const integrationSystemCount = data?.integrationHealth?.systemCount ?? 0
  const allIntegrationSystemsConnected = Boolean(data?.integrationHealth && integrationConnectedCount === integrationSystemCount)
  const liveSources = data?.live?.sources
  const liveSourcesAvailable = liveSources?.ok === true
  const sourcesUnavailable = liveSources?.ok === false
  const sourceFreshness = liveSourcesAvailable ? liveSources.freshness : undefined
  const liveHealth = data?.live?.health
  const liveHealthAvailable = liveHealth?.ok === true
  const healthUnavailable = liveHealth?.ok === false
  const liveHealthMetrics = liveHealthAvailable ? liveHealth.metrics : null
  const queueCounters = liveHealthMetrics?.queue
  const queueEvidenceStatus = deriveQueueEvidenceStatus({
    fallbackStatus: data?.nodes?.find((node) => node.id === 'queues')?.status || 'inactive',
    hasLiveHealth: liveHealthAvailable,
    countersAvailable: Boolean(queueCounters && [queueCounters.waiting, queueCounters.active, queueCounters.stalled].every(Number.isFinite)),
    missingEmbeddings: liveHealthMetrics?.missingEmbeddings ?? null,
    stalledJobs: queueCounters?.stalled ?? null,
  })
  const presentedNodes = (data?.nodes || []).map((node) => (
    node.id === 'queues' ? { ...node, status: queueEvidenceStatus } : node
  ))
  const selectedNodeStatus = selectedNode?.id === 'queues' ? queueEvidenceStatus : selectedNode?.status || 'inactive'
  const healthyNodeCount = presentedNodes.filter((node) => node.status === 'healthy').length
  const degradedNodeCount = presentedNodes.filter((node) => node.status === 'warning').length
  const disconnectedNodeCount = presentedNodes.filter((node) => node.status === 'critical' || node.status === 'inactive').length
  const nodeCount = presentedNodes.length
  const stalePageCount = liveHealthMetrics?.stalePages ?? null
  const brainQualityScore = liveHealthAvailable ? liveHealth.score : null
  const brainQualityStatus: EvidenceStatus = healthUnavailable
    ? 'critical'
    : brainQualityScore === null
      ? 'inactive'
    : brainQualityScore >= 90
      ? 'healthy'
      : brainQualityScore >= 70
        ? 'warning'
        : 'critical'
  const compiledTruthStatus: EvidenceStatus = healthUnavailable
    ? 'critical'
    : stalePageCount === null
      ? 'inactive'
    : stalePageCount > 0
      ? 'warning'
      : 'healthy'
  const compiledTruthValue = healthUnavailable
    ? 'Unavailable'
    : stalePageCount === null
      ? 'Unknown'
    : stalePageCount > 0
      ? `${stalePageCount} page${stalePageCount === 1 ? '' : 's'} behind`
      : 'Current'
  const allSourcesNotApplicable = Boolean(
    sourceFreshness
    && sourceFreshness.freshCount === 0
    && sourceFreshness.staleCount === 0
    && sourceFreshness.unknownCount === 0
    && sourceFreshness.untrackedCount > 0,
  )
  const sourceSyncValue = sourcesUnavailable
    ? 'Unavailable'
    : allSourcesNotApplicable
      ? 'Not applicable'
      : sourceFreshness?.status === 'healthy'
        ? 'Fresh'
        : sourceFreshness?.status === 'warning'
          ? `${sourceFreshness.staleCount} stale`
          : sourceFreshness?.status === 'critical'
            ? 'Unavailable'
            : 'Unknown'
  const sourceSyncStatus: EvidenceStatus = sourcesUnavailable
    ? 'critical'
    : allSourcesNotApplicable
      ? 'inactive'
      : sourceFreshness?.status || 'inactive'
  const probeAttemptAt = [liveHealth?.checkedAt, liveSources?.checkedAt]
    .filter((value): value is string => Boolean(value))
    .sort()
    .at(-1) || null
  const probeUnavailable = healthUnavailable || sourcesUnavailable
  const probeValue = probeUnavailable
    ? 'Unavailable'
    : probeAttemptAt
      ? timeAgo(probeAttemptAt)
      : data?.mode === 'read-only-fixture'
        ? 'Saved audit'
        : 'Unknown'
  const probeStatus: EvidenceStatus = probeUnavailable ? 'critical' : probeAttemptAt ? 'healthy' : 'inactive'
  const caveatCount = new Set([...(data?.caveats || []), ...(data?.warnings || [])]).size
  const operationalState = deriveOperationalState({
    hasData: Boolean(data),
    loading,
    trustStatus: data?.trust.status || 'inactive',
    incidentStatus: activeIncidentBanner?.status,
    incidentIsCurrent,
    caveatCount,
  })
  const operationalDetail = loading
    ? 'Refreshing live probes before showing the current operator state.'
    : activeIncidentBanner
      ? `${activeIncidentBanner.title}. ${incidentDetailForDisplay(activeIncidentBanner.detail)}`
      : data?.caveats?.[0] || data?.warnings?.[0] || proofScope.detail
  const heroSignals: { label: string; value: string; detail: string; status: EvidenceStatus; icon: ReactNode; proofNodeId: string }[] = [
    {
      label: 'Brain quality',
      icon: <ShieldCheck size={13} />,
      value: healthUnavailable ? 'Unavailable' : brainQualityScore === null ? 'Unknown' : `${brainQualityScore}/100`,
      detail: healthUnavailable
        ? liveHealth.error || 'Live health probe is unavailable'
        : brainQualityScore === null
          ? 'No live brain quality score returned'
          : 'Coverage, links, timelines, orphans, and dead links; freshness is separate',
      status: brainQualityStatus,
      proofNodeId: 'gbrain-core',
    },
    {
      label: 'Compiled truth',
      icon: <Brain size={13} />,
      value: compiledTruthValue,
      detail: healthUnavailable
        ? liveHealth.error || 'Live health probe is unavailable'
        : stalePageCount === null
          ? 'No compiled page counter returned'
          : 'Compiled pages compared with newer timeline evidence',
      status: compiledTruthStatus,
      proofNodeId: 'gbrain-core',
    },
    {
      label: 'Source sync',
      icon: <Database size={13} />,
      value: sourceSyncValue,
      detail: sourcesUnavailable
        ? liveSources.error || 'Live source probe is unavailable'
        : sourceFreshness
          ? `${sourceFreshness.freshCount} sync-tracked fresh · ${sourceFreshness.untrackedCount || 0} not applicable`
          : 'No live source timestamps returned',
      status: sourceSyncStatus,
      proofNodeId: 'sources',
    },
    {
      label: 'Systems',
      icon: <Network size={13} />,
      value: data?.integrationHealth ? `${integrationConnectedCount}/${integrationSystemCount}` : `${data?.nodes?.length || 0} nodes`,
      detail: data?.integrationHealth
        ? allIntegrationSystemsConnected
          ? 'All required systems connected'
          : `${integrationSystemCount - integrationConnectedCount} required system${integrationSystemCount - integrationConnectedCount === 1 ? '' : 's'} missing runtime proof`
        : 'Topology loaded from overview',
      status: data?.integrationHealth?.status || data?.trust.status || 'inactive',
      proofNodeId: 'gbrain-core',
    },
    {
      label: 'Probe checked',
      icon: <Clock size={13} />,
      value: probeValue,
      detail: probeUnavailable
        ? `Live probe attempted ${probeAttemptAt ? timeAgo(probeAttemptAt) : 'recently'}; evidence unavailable`
        : probeAttemptAt
          ? data?.trust.source || 'Live read probes completed'
          : 'No current live probe attempt recorded',
      status: probeStatus,
      proofNodeId: 'gbrain-core',
    },
  ]
  // These cockpit metrics are already shown in the hero strip; skip them in the rail.
  const heroCockpitLabels = new Set(['health', 'embeddings', 'integration health', 'freshness', 'source freshness'])
  const cockpitEntries = Object.entries(data?.cockpit || {}).filter(
    ([, metric]) => !heroCockpitLabels.has(metric.label.toLowerCase()),
  )
  const mapReady = operationalState.status === 'healthy' && disconnectedNodeCount === 0
  const mapSummary = mapReady
    ? 'All live proof dimensions are operational'
    : operationalState.status === 'critical'
      ? 'Critical proof requires operator review'
      : 'Live proof degraded; review GBrain Core'
  const mapIsActive = Boolean(runningAction || showTimelineDiff)
  const timelineAnimationKey = timelineEntries[0]?.capturedAt || timelineSummary?.lastCapturedAt || 'stable'
  const mapAnimationKey = `${timelineAnimationKey}:${mapAnimationCycle}`
  const timelineRows = visibleTimelineEntries.map((entry, index) => ({
    entry,
    changes: timelineDeltaLines(entry, timelineEntries[index + 1]),
  }))

  const runAction = async (action: string, confirmed = false) => {
    if (runningActionRef.current) return
    runningActionRef.current = action
    setMapAnimationCycle((current) => current + 1)
    setRunningAction(action)
    setActionResult(null)
    try {
      const result = (await postGBrainAction(action, confirmed)) as PageGBrainActionResult
      setActionResult(result)
      if (result.refreshAfter) await Promise.all([refetch(), refetchTimeline()])
    } catch (err) {
      const payload = (err as Error & { payload?: PageGBrainActionResult })?.payload
      setActionResult(
        payload || {
          ok: false,
          action,
          label: action,
          status: 'failed',
          summary: err instanceof Error ? err.message : 'Action failed',
          checkedAt: new Date().toISOString(),
        },
      )
      if (payload?.refreshAfter) await Promise.all([refetch(), refetchTimeline()])
    } finally {
      runningActionRef.current = null
      setRunningAction(null)
    }
  }

  const requestAction = (actionId: string, trigger?: HTMLButtonElement | null) => {
    const directAction = resolveGBrainAction(actions, actionId, 'direct', runningAction)
    if (directAction) {
      void runAction(directAction.id)
      return
    }

    const confirmableAction = resolveGBrainAction(actions, actionId, 'confirmed', runningAction)
    if (!confirmableAction) return
    confirmationTriggerRef.current = trigger || null
    setConfirmationActionId(confirmableAction.id)
  }

  const confirmAction = () => {
    if (!confirmationActionId) return
    const currentAction = resolveGBrainAction(actions, confirmationActionId, 'confirmed', runningAction)
    setConfirmationActionId(null)
    if (currentAction) void runAction(currentAction.id, true)
  }

  const acknowledgeIncidents = () => {
    if (!recoveredIncidentKeys.length) return
    setAcknowledgedIncidents((current) => {
      const next = new Set(current)
      for (const key of recoveredIncidentKeys) next.add(key)
      try {
        window.localStorage.setItem('gbrain.acknowledgedIncidents', JSON.stringify([...next].slice(-50)))
      } catch {
        // Keep the in-session acknowledgement even if storage is unavailable.
      }
      return next
    })
  }

  return (
    <PageTransition>
      <div className={styles.page}>
        <div className={styles.topBar}>
          <div>
            <div className={styles.pageEyebrow}>Explore · Shared memory</div>
            <div className={styles.titleRow}>
              <span className={styles.titleIcon}><Brain size={20} /></span>
              <h1>{data?.title || 'GBrain'}</h1>
            </div>
            <div className={styles.subtitle}>
              {data?.subtitle || 'Shared memory for Hermes, OpenClaw, and Codex'}
            </div>
          </div>
          <button
            className={styles.trustBadge}
            onClick={() => refetch()}
            style={{ '--status-color': statusColor(operationalState.status) } as CSSProperties}
            aria-label="Refresh live GBrain proof"
          >
            <RefreshCw size={15} />
            <span>
              <strong>{loading ? 'Checking live proof' : 'Refresh live proof'}</strong>
              <small>{data?.trust.lastVerifiedAt ? `Probe checked ${timeAgo(data.trust.lastVerifiedAt)}` : 'Run read-only probes'}</small>
            </span>
          </button>
        </div>

        <section
          className={styles.statusOverview}
          style={{ '--status-color': statusColor(operationalState.status) } as CSSProperties}
        >
          <span className={styles.srOnly} role="status" aria-live="polite" aria-atomic="true">
            {operationalState.label}. {operationalDetail}
          </span>
          <div className={styles.statusLead}>
            <span className={styles.statusLeadIcon}>
              {operationalState.status === 'healthy' ? <CheckCircle2 size={18} /> : <AlertTriangle size={18} />}
            </span>
            <div>
              <span className={styles.statusEyebrow}>Live operational state</span>
              <strong>{operationalState.label}</strong>
              <p>{operationalDetail}</p>
            </div>
          </div>

          <div className={styles.heroStrip} aria-label="Independent proof dimensions">
            {heroSignals.map((signal) => (
              <button
                className={styles.heroCard}
                key={signal.label}
                style={{ '--status-color': statusColor(signal.status) } as CSSProperties}
                type="button"
                title={signal.detail}
                onClick={() => selectProofNode(signal.proofNodeId)}
              >
                <span className={styles.heroLabel}>{signal.icon}{signal.label}</span>
                <strong className={styles.heroValue}>{signal.value}</strong>
                <small className={styles.heroDetail}>{signal.detail}</small>
              </button>
            ))}
          </div>

          <div
            className={styles.proofScope}
            style={{ '--status-color': statusColor(proofScope.status) } as CSSProperties}
            title={proofScope.detail}
          >
            <ShieldCheck size={14} />
            <strong>{proofScope.label}</strong>
            <span>Brain quality, source sync, compiled truth, and probe time are independent evidence dimensions.</span>
          </div>
        </section>

        {recoveredIncidentBanners.length ? (
          <aside
            className={styles.recoveredIncidentPanel}
            style={{ '--status-color': statusColor(recoveredIncidentBanners[0].status) } as CSSProperties}
            aria-label={recoveredIncidentBanners.length === 1
              ? 'Recovered regression awaiting acknowledgement'
              : `Recovered regressions awaiting acknowledgement: ${recoveredIncidentBanners.length}`}
          >
            <div className={styles.recoveredIncidentHeader}>
              <button
                id="gbrain-recovered-incidents-toggle"
                type="button"
                className={styles.recoveredIncidentToggle}
                aria-expanded={recoveredIncidentsExpanded}
                aria-controls="gbrain-recovered-incidents"
                aria-label="Toggle recovered regression history"
                onClick={() => setRecoveredIncidentsExpanded((expanded) => !expanded)}
              >
                <Clock size={16} />
                <div>
                  <strong>
                    {recoveredIncidentBanners.length === 1
                      ? 'Recovered regression awaiting acknowledgement'
                      : `Recovered regressions awaiting acknowledgement (${recoveredIncidentBanners.length})`}
                  </strong>
                  <span>Worst-first history. Select to show details.</span>
                </div>
                <ChevronDown
                  size={16}
                  className={recoveredIncidentsExpanded ? styles.recoveredIncidentChevronExpanded : styles.recoveredIncidentChevron}
                />
              </button>
              <button type="button" onClick={acknowledgeIncidents}>
                {recoveredIncidentBanners.length === 1 ? 'Acknowledge history' : `Acknowledge all ${recoveredIncidentBanners.length}`}
              </button>
            </div>

            {recoveredIncidentsExpanded ? (
              <ul
                id="gbrain-recovered-incidents"
                className={styles.recoveredIncidentList}
                aria-labelledby="gbrain-recovered-incidents-toggle"
              >
                {recoveredIncidentBanners.map((incident, index) => (
                  <li key={incident.snapshotId || `${incident.title}:${incident.detail}`}>
                    <span aria-hidden="true">{index + 1}</span>
                    <div>
                      <strong>{incident.title}</strong>
                      <small>{incidentDetailForDisplay(incident.detail)}</small>
                    </div>
                  </li>
                ))}
              </ul>
            ) : null}
          </aside>
        ) : null}

        {error ? <GlassCard><div className={styles.error}>{error}</div></GlassCard> : null}

        <div className={styles.layout}>
          <GlassCard noPad hover={false} className={styles.rail}>
            <div className={styles.panelHeader}>
              <div className={styles.panelTitle}><ShieldCheck size={15} /> Proof dimensions</div>
              <div className={styles.panelMeta}>Independent signals</div>
            </div>
            <div className={styles.railBody}>
              <div className={styles.statGrid}>
                {cockpitEntries.map(([key, metric]) => (
                  <button
                    key={key}
                    className={styles.statCell}
                    title={metric.detail}
                    onClick={() => selectProofNode(metric.proofNodeId)}
                  >
                    <span className={styles.statTop}>
                      <span className={styles.statLabel}>{metric.label}</span>
                      <span className={styles.statusDot} style={{ '--status-color': statusColor(metric.status) } as CSSProperties} />
                    </span>
                    <span className={styles.statValue}>{metric.value}</span>
                  </button>
                ))}
              </div>
              {!data && !loading ? <div className={styles.metricDetail}>No overview payload loaded.</div> : null}
            </div>
          </GlassCard>

          <GlassCard noPad hover={false} className={styles.mapPanel}>
            <div className={styles.panelHeader}>
              <div className={styles.panelTitle}><Network size={15} /> Living Brain Map</div>
              <div className={styles.panelMeta}>{data?.mode || 'read-only'}</div>
            </div>
            <div className={styles.mapCanvas}>
              <div className={styles.mapStage}>
                <div
                  key={mapAnimationKey}
                  className={`${styles.mapAnimationLayer} ${mapIsActive ? styles.mapAnimationLayerActive : ''}`}
                  aria-hidden="true"
                >
                  <div className={styles.mapGlow} />
                  <div className={styles.mapOrbit} />
                  <div className={styles.mapInnerOrbit} />
                  <svg className={styles.edgeLayer} viewBox="0 0 100 100" preserveAspectRatio="none">
                    {(data?.edges || []).map((edge) => {
                      const line = lineFor(edge)
                      const edgeStatus = edge.proofNodeId === 'queues' ? queueEvidenceStatus : edge.status
                      return (
                        <g key={edge.id}>
                          <line
                            className={styles.edgeLine}
                            x1={line.x1}
                            y1={line.y1}
                            x2={line.x2}
                            y2={line.y2}
                            style={{ '--status-color': statusColor(edgeStatus) } as CSSProperties}
                          />
                          <circle
                            className={styles.edgePulse}
                            cx={line.mx}
                            cy={line.my}
                            r="0.75"
                            style={{ '--status-color': statusColor(edgeStatus) } as CSSProperties}
                          />
                        </g>
                      )
                    })}
                  </svg>
                  <span className={styles.mapCorePulse} />
                </div>

                {presentedNodes.map((node) => {
                  const position = nodePositions[node.id] || { x: 50, y: 50, size: 110 }
                  const active = selectedNode?.id === node.id
                  const healthy = node.status === 'healthy'
                  return (
                    <button
                      key={node.id}
                      className={`${styles.node} ${node.kind === 'core' ? styles.coreNode : ''} ${active ? styles.nodeActive : ''} ${!healthy ? styles.nodeAlert : ''}`}
                      onClick={() => setSelectedId(node.id)}
                      aria-pressed={active}
                      aria-controls="gbrain-evidence-drawer"
                      style={{
                        '--node-x': `${position.x}%`,
                        '--node-y': `${position.y}%`,
                        '--node-size': `${position.size}px`,
                        '--status-color': statusColor(node.status),
                        '--node-accent': kindAccent(node.kind),
                      } as CSSProperties}
                    >
                      <span className={styles.nodeDot} title={statusLabel(node.status)} />
                      <span className={styles.nodeIcon}>{kindIcon(node.kind)}</span>
                      <span className={styles.nodeLabel}>{node.label}</span>
                      <span className={styles.nodeRole}>{nodeRole(node)}</span>
                      {!healthy ? (
                        <span className={styles.nodeStatus}><AlertTriangle size={11} />{statusLabel(node.status)}</span>
                      ) : null}
                    </button>
                  )
                })}
              </div>
              <div className={styles.mobileNodeList} aria-label="GBrain topology">
                {presentedNodes.map((node) => (
                  <button
                    key={`mobile-${node.id}`}
                    type="button"
                    className={`${styles.mobileNode} ${selectedNode?.id === node.id ? styles.mobileNodeActive : ''}`}
                    onClick={() => setSelectedId(node.id)}
                    aria-pressed={selectedNode?.id === node.id}
                    aria-controls="gbrain-evidence-drawer"
                    style={{ '--status-color': statusColor(node.status), '--node-accent': kindAccent(node.kind) } as CSSProperties}
                  >
                    <span className={styles.nodeIcon}>{kindIcon(node.kind)}</span>
                    <span>
                      <strong>{node.label}</strong>
                      <small>{nodeRole(node)}</small>
                    </span>
                    <em><i />{statusLabel(node.status)}</em>
                  </button>
                ))}
              </div>
              {selectedNode ? (
                <div className={styles.mobileEvidencePreview}>
                  <div role="status" aria-live="polite" aria-atomic="true">
                    <strong>{selectedNode.label}</strong>
                    <span>{selectedNode.proof.label} · {statusLabel(selectedNodeStatus)}</span>
                  </div>
                  <button type="button" onClick={revealSelectedEvidence} aria-controls="gbrain-evidence-drawer">
                    View evidence
                  </button>
                </div>
              ) : null}
              <div
                className={styles.mapActionBand}
                style={{ '--status-color': statusColor(operationalState.status) } as CSSProperties}
              >
                <span className={styles.mapActionIcon}><RefreshCw size={18} /></span>
                <div>
                  <strong>{mapSummary}</strong>
                  <span>{selectedNode ? `${selectedNode.label}: ${selectedNode.proof.label}` : 'GBrain is ready to read, reason, and remember.'}</span>
                </div>
                <div className={styles.mapActionStats}>
                  <span><i style={{ '--status-color': statusColor('healthy') } as CSSProperties} />{healthyNodeCount}/{nodeCount || '—'} verified</span>
                  <span><i style={{ '--status-color': statusColor(degradedNodeCount ? 'warning' : 'healthy') } as CSSProperties} />{degradedNodeCount} degraded</span>
                  <span><i style={{ '--status-color': statusColor(brainQualityStatus) } as CSSProperties} />{brainQualityScore === null ? '—' : `${brainQualityScore}/100`} quality</span>
                </div>
              </div>
            </div>
            <div className={styles.actionsDock}>
              <div className={styles.actionHeader}>
                <span>Controlled operations</span>
                <small>{runningAction ? 'running' : `${visibleActions.length} allowlisted · probes stay read-only`}</small>
              </div>
              <div className={styles.actionGroups}>
                {actionGroups.map((group) => (
                  <section className={styles.actionGroup} key={group.id} aria-labelledby={`gbrain-actions-${group.id}`}>
                    <div className={styles.actionGroupHeader}>
                      <strong id={`gbrain-actions-${group.id}`}>{group.label}</strong>
                      <span>{group.detail}</span>
                    </div>
                    <div className={styles.actionGrid}>
                      {group.actions.map((action) => {
                        const timeoutLabel = formatActionTimeout(action.timeoutMs)
                        return (
                          <button
                            key={action.id}
                            className={styles.actionButton}
                            type="button"
                            disabled={!canRunActions || Boolean(runningAction) || action.enabled === false}
                            title={`${action.command}${timeoutLabel ? ` · timeout ${timeoutLabel}` : ''}`}
                            style={{ '--action-color': actionKindColor(action.kind) } as CSSProperties}
                            onClick={(event) => requestAction(action.id, event.currentTarget)}
                          >
                            <span className={styles.actionIconTile}>
                              {action.kind === 'diagnostic' || action.kind === 'preview' ? <RefreshCw size={13} /> : <Play size={13} />}
                            </span>
                            <span>
                              <span className={styles.actionTitleRow}>
                                <strong>{runningAction === action.id ? `${action.label}...` : action.label}</strong>
                                <em>{[
                                  actionKindLabel(action.kind),
                                  action.safetyClass,
                                  action.requiresConfirmation ? 'confirm' : 'direct',
                                  timeoutLabel,
                                ].filter(Boolean).join(' · ')}</em>
                              </span>
                              <small className={styles.actionDescription}>{action.description}</small>
                            </span>
                          </button>
                        )
                      })}
                    </div>
                  </section>
                ))}
              </div>
              {actionResult ? (
                <div
                  className={styles.actionResult}
                  style={{ '--status-color': statusColor(actionResult.ok ? 'healthy' : 'warning') } as CSSProperties}
                >
                  <strong>
                    {actionResult.ok
                      ? `${actionResult.label} complete`
                      : actionResult.pending
                        ? `${actionResult.label || actionResult.action} stopping`
                        : `${actionResult.label || actionResult.action} failed`}
                  </strong>
                  <span>{actionResult.error || actionResult.summary}</span>
                </div>
              ) : null}
              {actionsError ? <div className={styles.actionHint}>{actionsError}</div> : null}
            </div>
            <ActionConfirmDialog
              action={confirmationCapability}
              proof={confirmationProof}
              onCancel={() => setConfirmationActionId(null)}
              onConfirm={confirmAction}
              returnFocusRef={confirmationTriggerRef}
            />
          </GlassCard>

          <GlassCard noPad hover={false} className={styles.drawer}>
            <div
              id="gbrain-evidence-drawer"
              ref={drawerRef}
              className={styles.drawerTarget}
              tabIndex={-1}
              aria-label={`Evidence Drawer${selectedNode ? `: ${selectedNode.label}` : ''}`}
            >
            <div className={styles.panelHeader}>
              <div className={styles.panelTitle}><Radio size={15} /> Evidence Drawer</div>
              <div className={styles.panelMeta}>{selectedNode ? statusLabel(selectedNodeStatus) : '—'}</div>
            </div>
            {selectedNode ? (
              <div className={styles.drawerBody} key={selectedNode.id}>
                <div className={styles.selectedTitle}>
                  <h2>{selectedNode.label}</h2>
                  <span className={styles.statusDot} style={{ '--status-color': statusColor(selectedNodeStatus) } as CSSProperties} />
                </div>
                <p className={styles.summary}>{selectedNode.summary}</p>

                {selectedNode.metrics.length ? (
                  <div className={styles.miniMetrics}>
                    {selectedNode.metrics.map((metric) => (
                      <div className={styles.miniMetric} key={`${selectedNode.id}-${metric.label}`}>
                        <span>{metric.label}</span>
                        <strong>{metric.value}</strong>
                      </div>
                    ))}
                  </div>
                ) : null}

                {data?.integrationContract && (selectedNode.id === 'gbrain-core' || selectedContractSystem) ? (
                  <div className={styles.section}>
                    <h3>{data.integrationContract.label}</h3>
                    <div className={styles.proofBox}>
                      <div className={styles.proofLabel}>
                        <ShieldCheck size={13} style={{ marginRight: 6, verticalAlign: -2 }} />
                        {selectedContractSystem?.label || 'GBrain'}
                      </div>
                      <div className={styles.proofDetail} style={{ marginTop: 7 }}>
                        {selectedContractSystem
                          ? `${selectedContractSystem.localMemory} ${selectedContractSystem.gbrainUse}`
                          : data.integrationContract.summary}
                      </div>
                      <div className={styles.proofPath}>{selectedContractSystem?.proof || data.integrationContract.localMemoryBoundary}</div>
                      <div className={styles.proofPath}>{data.integrationContract.writePolicy}</div>
                    </div>
                  </div>
                ) : null}

                {data?.integrationHealth && (selectedNode.id === 'gbrain-core' || selectedIntegrationSystem) ? (
                  <div className={styles.section}>
                    <h3>Integration Health</h3>
                    {selectedIntegrationSystem ? (
                      <div className={styles.proofBox}>
                        <div className={styles.proofLabel}>
                          <CheckCircle2 size={13} style={{ marginRight: 6, verticalAlign: -2 }} />
                          {selectedIntegrationSystem.label}
                        </div>
                        <div className={styles.miniMetrics} style={{ marginTop: 9 }}>
                          <div className={styles.miniMetric}><span>MCP</span><strong>{selectedIntegrationSystem.mcp.configured ? 'Connected' : 'Missing'}</strong></div>
                          <div className={styles.miniMetric}><span>Runtime</span><strong>{selectedIntegrationSystem.runtimeContract.status}</strong></div>
                          <div className={styles.miniMetric}><span>Source</span><strong>{selectedIntegrationSystem.source.status}</strong></div>
                          <div className={styles.miniMetric}><span>Think</span><strong>{selectedIntegrationSystem.thinkRuntime?.status || data.integrationHealth.thinkRuntime.status}</strong></div>
                          <div className={styles.miniMetric}><span>Read smoke</span><strong>{selectedIntegrationSystem.readSmoke.status}</strong></div>
                          <div className={styles.miniMetric}><span>Write path</span><strong>{selectedIntegrationSystem.writeSmoke.status}</strong></div>
                        </div>
                        <div className={styles.proofPath}>{selectedIntegrationSystem.mcp.proof}</div>
                        <div className={styles.proofPath}>{selectedIntegrationSystem.runtimeContract.label}</div>
                        <div className={styles.proofPath}>{selectedIntegrationSystem.thinkRuntime?.detail || data.integrationHealth.thinkRuntime.detail}</div>
                        <div className={styles.proofPath}>{selectedIntegrationSystem.writeSmoke.label}</div>
                      </div>
                    ) : (
                      <div className={styles.proofBox}>
                        <div className={styles.proofLabel}>
                          <CheckCircle2 size={13} style={{ marginRight: 6, verticalAlign: -2 }} />
                          {data.integrationHealth.connectedCount}/{data.integrationHealth.systemCount} systems connected
                        </div>
                        <div className={styles.proofDetail} style={{ marginTop: 7 }}>
                          {data.integrationHealth.toolContract.basePresentCount ?? data.integrationHealth.toolContract.presentCount}/{data.integrationHealth.toolContract.baseRequiredCount ?? data.integrationHealth.toolContract.requiredCount} base tools present; think {statusLabel(data.integrationHealth.thinkRuntime.status)}
                          {missingIntegrationTools.length ? `; missing ${missingIntegrationTools.map((tool) => tool.label).join(', ')}` : '; no core tool gaps'}
                        </div>
                        <div className={styles.proofPath}>{data.integrationHealth.thinkRuntime.detail}</div>
                        <div className={styles.proofPath}>
                          Feature recommendations: {data.integrationHealth.featureGaps.count
                            ? data.integrationHealth.featureGaps.recommendations.map((item) => item.title).join(', ')
                            : 'none reported'}
                        </div>
                      </div>
                    )}
                  </div>
                ) : null}

                <div className={styles.section}>
                  <h3>Last Known Proof</h3>
                  <div className={styles.proofBox}>
                    <div className={styles.proofLabel}><CheckCircle2 size={13} style={{ marginRight: 6, verticalAlign: -2 }} />{selectedNode.proof.label}</div>
                    <div className={styles.proofDetail} style={{ marginTop: 7 }}>{selectedNode.proof.detail}</div>
                    <div className={styles.proofPath}>{selectedNode.proof.source}</div>
                    <div className={styles.proofPath}>{formatDate(selectedNode.proof.verifiedAt)}</div>
                  </div>
                </div>

                <div className={styles.section}>
                  <h3>Known Risks</h3>
                  <div className={styles.riskBox}>
                    {selectedNode.risks.length ? (
                      <ul>
                        {selectedNode.risks.map((risk) => <li key={risk}>{risk}</li>)}
                      </ul>
                    ) : (
                      <div className={styles.proofDetail}>No specific risk captured for this node.</div>
                    )}
                  </div>
                </div>

                {selectedNode.id === 'sources' && data?.live?.sources?.freshness ? (
                  <div className={styles.section}>
                    <h3>Freshness Thresholds</h3>
                    <div className={styles.freshnessBox}>
                      <div className={styles.freshnessSummary}>
                        <span style={{ '--status-color': statusColor(data.live.sources.freshness.status) } as CSSProperties} />
                        <strong>
                          {data.live.sources.freshness.staleCount > 0
                            ? `${data.live.sources.freshness.staleCount} stale source${data.live.sources.freshness.staleCount === 1 ? '' : 's'}`
                            : 'All sync-tracked source syncs are fresh'}
                        </strong>
                        <small>Default threshold {data.live.sources.freshness.defaultThresholdHours}h · {data.live.sources.freshness.untrackedCount || 0} not applicable</small>
                      </div>
                      {staleSources.length ? (
                        <div className={styles.freshnessList}>
                          {staleSources.slice(0, 4).map((source) => (
                            <div key={source.id}>
                              <strong>{source.id}</strong>
                              <span>
                                {source.freshness?.ageHours !== null && source.freshness?.ageHours !== undefined
                                  ? `${source.freshness.ageHours}h old`
                                  : 'no sync timestamp'}
                                {' '}· threshold {source.freshness?.thresholdHours ?? data.live?.sources?.freshness?.defaultThresholdHours}h
                              </span>
                            </div>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  </div>
                ) : null}

                <div className={styles.section}>
                  <h3>Next Safe Action</h3>
                  <div className={styles.nextAction}>
                    <Play size={13} />
                    <span>{selectedNode.nextSafeAction}</span>
                  </div>
                </div>

                <div className={styles.section}>
                  <h3>Global Warnings</h3>
                  <div className={styles.riskBox}>
                    <ul>
                      {((data?.caveats?.length ? data.caveats : data?.warnings) || []).map((warning) => <li key={warning}>{warning}</li>)}
                    </ul>
                  </div>
                </div>
              </div>
            ) : (
              <div className={styles.drawerBody}>
                <div className={styles.summary}>Loading evidence...</div>
              </div>
            )}
            </div>
          </GlassCard>
        </div>

        <GlassCard noPad hover={false} className={styles.timelinePanel}>
          <div className={styles.panelHeader}>
            <div className={styles.panelTitle}><RefreshCw size={15} /> Evidence Timeline</div>
            <div className={styles.panelMeta}>
              {timelineEnabled ? `${timeline?.retainedEntryCount ?? timelineSummary?.retainedEntryCount ?? 0} retained` : 'disabled'}
            </div>
          </div>
          <div className={styles.timelineBody}>
            {showTimelineDiff ? (
              <div className={styles.diffStrip}>
                <CheckCircle2 size={15} />
                <span>{timelineDiff?.summary}</span>
              </div>
            ) : null}

            {timelineSummary?.warning || timelineError || (timeline?.warnings || []).length ? (
              <div className={styles.timelineWarning}>
                <AlertTriangle size={15} />
                <span>{timelineSummary?.warning || timelineError || timeline?.warnings?.[0]}</span>
              </div>
            ) : null}

            {!timelineEnabled ? (
              <div className={styles.timelineEmpty}>Evidence Timeline disabled. Current cockpit proof remains available.</div>
            ) : timelineLoading && !timeline ? (
              <div className={styles.timelineEmpty}>Loading evidence timeline...</div>
            ) : timelineEntries.length === 0 ? (
              <div className={styles.timelineEmpty}>No timeline entries yet. Current live proof is shown above.</div>
            ) : (
              <div className={styles.timelineList}>
                {timelineRows.map(({ entry, changes }, index) => {
                  const changeLines = changes.length
                    ? changes
                    : [index === 0 && showTimelineDiff ? timelineDiff?.summary || 'Latest proof captured' : 'No material change']
                  const omittedChangeCount = Math.max(0, changeLines.length - 3)
                  return (
                    <article
                      key={`${entry.id}-${index === 0 && showTimelineDiff ? timelineAnimationKey : 'stable'}`}
                      className={`${styles.timelineEntry} ${index === 0 && showTimelineDiff ? styles.timelineEntryNew : ''}`}
                      style={{ '--status-color': statusColor(entry.trust.status) } as CSSProperties}
                    >
                      <span className={styles.timelineDot} />
                      <div className={styles.timelineEntryTop}>
                        <div>
                          <strong>{entry.trust.label}</strong>
                          <span>{timeAgo(entry.capturedAt)} · {entry.actor}</span>
                        </div>
                        <span className={styles.timelineStatus}>{statusLabel(entry.trust.status)}</span>
                      </div>
                      <div className={styles.timelineChanges}>
                        {changeLines.slice(0, 3).map((change) => <span key={`${entry.id}-${change}`}>{change}</span>)}
                        {omittedChangeCount > 0 ? (
                          <span className={styles.timelineMoreChanges}>+{omittedChangeCount} more change{omittedChangeCount === 1 ? '' : 's'}</span>
                        ) : null}
                      </div>
                    </article>
                  )
                })}
                {hiddenTimelineCount > 0 ? (
                  <div className={styles.timelineMore}>{hiddenTimelineCount} older proof snapshots retained in the ledger.</div>
                ) : null}
              </div>
            )}
          </div>
        </GlassCard>
      </div>
    </PageTransition>
  )
}
