import type { UiState } from '../../lib/state'

/** Shared envelope: every reading carries its own truth (docs/explanation-backend-redesign.md). */
export interface Meta {
  ok: boolean
  stale: boolean
  observedAt: string | null
  ageMs: number | null
  error: { code: string; message: string } | null
  latencyMs?: number | null
  source?: string
}

export interface Envelope<T> {
  data: T | null
  meta: Meta
}

// ---- GET /api/gbrain/synoptic (v1) ----

export interface Evidence {
  state: UiState
  observedAt: string | null
}

export interface Measurement<T = number> extends Evidence {
  value: T | null
  unit: string
}

export interface SynopticSource extends Evidence {
  id: string
  label: string
  lastSyncAt?: string | null
  behind?: number | null
  /** The source is outside freshness scoring (sync disabled or not sync-tracked): the server's own policy result. */
  excludedByPolicy?: boolean | null
  /** Why the source is in its state ("sync disabled", "never synced"…), in the server's words; null when there is none. */
  reason?: string | null
}

export interface SynopticSourceGroup extends Evidence {
  id: string
  label: string
  items: SynopticSource[]
}

export type ReaderObservation = 'configured' | 'observed' | 'not_configured' | 'unreadable'

export interface SynopticReader extends Evidence {
  id: string
  label: string
  /**
   * What kind of reading the state rests on. A configuration read cannot prove a connection, so
   * `configured` is neutral; `observed` is reserved for real connection telemetry and carries the state colours.
   */
  observation?: ReaderObservation
  /** Configuration evidence. Connection telemetry is not observable locally, so there is no connection object. */
  integration?: Evidence & { configured: boolean | null; evidence: string }
}

/** Source and queue lines carry a measurement. */
export interface MeasuredEdge extends Evidence {
  from: string
  to: string
  label: string
  unit: string
  measurement: Measurement
}

/** Reader lines are configuration evidence only: no measurement and no unit. */
export interface ReaderIntegrationEdge extends Evidence {
  from: string
  to: string
  label: 'configured'
  unit?: undefined
  measurement?: undefined
}

export type SynopticEdge = MeasuredEdge | ReaderIntegrationEdge

export interface SynopticCore extends Evidence {
  version?: Measurement<string>
  pages?: Measurement
  chunks?: Measurement
  embedded?: Measurement
  quality?: Measurement & { components?: Array<Measurement & { id: string }> }
}

export interface SynopticQueue extends Evidence {
  waiting?: Measurement
  active?: Measurement
  stalled?: Measurement
}

/** One reason behind the verdict; `elementId` names the block, source, reader or probe it is about. */
export type ReasonKind = 'action' | 'info'

export interface VerdictReason {
  elementId: string
  state: UiState
  text: string
  /** Set by the server (verdict.js). Optional here only so a payload without it is still read. */
  kind?: ReasonKind
}

/** The single operational verdict (server/sources/gbrain/verdict.js). Every consumer transports it unchanged. */
export interface PayloadVerdict {
  state: UiState
  reasons: VerdictReason[]
}

/**
 * Version 1 of the contract (server/sources/gbrain/contract.d.ts). Members the
 * page tolerates missing are optional here, so the compiler forces a guard.
 */
export interface GBrainSynoptic {
  schemaVersion: '1'
  state: UiState
  /** The one verdict. The page formats it and never derives another. */
  verdict?: PayloadVerdict
  core: SynopticCore
  sources: SynopticSourceGroup[]
  sourcesState?: UiState
  queue: SynopticQueue
  readers: SynopticReader[]
  readersState?: UiState
  readersNote?: string
  edges: SynopticEdge[]
}

export type SynopticEnvelope = Envelope<GBrainSynoptic>

// ---- legacy flat payloads that carry `meta` ----

export interface HealthMetrics {
  pages?: number | null
  chunks?: number | null
  embedded?: number | null
  missingEmbeddings?: number | null
  missingEmbeddingsOverdue?: number | null
  missingEmbeddingsUnavailable?: boolean
  stalePages?: number | null
  stalePagesOverdue?: number | null
  stalePagesCatchingUp?: number | null
  stalePagesUnavailable?: boolean
  queue?: { waiting?: number | null; active?: number | null; stalled?: number | null }
}

/** GET /api/gbrain/health */
export interface HealthReading {
  ok?: boolean
  status?: string
  score?: number | null
  checkedAt?: string
  metrics?: HealthMetrics
  meta: Meta
}

export interface SourceRecord {
  id: string
  status?: string
  pages?: number | null
  chunks?: number | null
  lastSyncAt?: string | null
  syncEnabled?: boolean
  freshness?: {
    status?: string
    label?: string
    ageHours?: number | null
    thresholdHours?: number | null
    syncTracked?: boolean
  }
  behind?: number | null
  excludedByPolicy?: boolean | null
  /** Same wording as the synoptic source's `reason`. */
  reason?: string | null
}

/** GET /api/gbrain/sources */
export interface SourcesReading {
  ok?: boolean
  freshness?: {
    status?: string
    staleCount?: number
    freshCount?: number
    unknownCount?: number
    untrackedCount?: number
    defaultThresholdHours?: number
  }
  sources?: SourceRecord[]
  meta: Meta
}

export interface IncidentBanner {
  status?: string
  title: string
  detail: string
  snapshotId?: string
  kind?: string
}

export interface TimelineEntry {
  id: string
  capturedAt: string
  trust: {
    label: string
    /** The entry's own state when it has no `verdict` (older entries). */
    status: 'healthy' | 'warning' | 'critical' | 'inactive' | 'unavailable'
    score: number | null
  }
  /** The shared verdict captured with the reading; its state is the entry's state. Older entries have none. */
  verdict?: { state: string; reasons: Array<{ elementId: string; state: string; text: string }> }
  metrics: Record<string, string | number | null>
  sourceFreshness: { status: 'healthy' | 'warning' | 'critical' | 'inactive' }
  warnings: string[]
}

/** GET /api/gbrain/timeline */
export interface TimelineReading {
  enabled?: boolean
  entries: TimelineEntry[] | null
  warnings?: string[]
  retainedEntryCount: number | null
  incidentBanners?: IncidentBanner[]
  meta: Meta
}

// ---- GET /api/operations/overview (capabilities) ----

export type SafetyClass = 'R0' | 'W1' | 'W2'
export type FreshnessState = 'fresh' | 'stale' | 'unknown' | 'unavailable'

export interface OperationCapability {
  id: string
  system: 'gbrain'
  label: string
  description: string
  kind: string
  safetyClass: SafetyClass
  requiresConfirmation: boolean
  timeoutMs: number | null
  refreshAfter: boolean
  enabled: boolean
  disabledReason: string
  actionEndpoint: '/api/gbrain/actions'
}

export type OperationSystemId = 'gbrain' | 'hermes' | 'openclaw'
export type OperationState = 'healthy' | 'warning' | 'critical' | 'inactive' | 'unavailable'

export interface EvidenceItem {
  id: string
  system: OperationSystemId
  kind: string
  status: OperationState
  observedAt: string | null
  summary: string
  sourceRef: string
  detailHref: string
}

export interface AttentionItem {
  id: string
  system: OperationSystemId
  severity: OperationState
  reasonCode: string
  title: string
  detail: string
  detailHref: string
  evidenceRefs: string[]
}

export interface OperationSystem {
  id: OperationSystemId
  label: string
  state: OperationState
  observedAt: string | null
  freshness: FreshnessState
  caveats: string[]
  /** The shared verdict captured with the reading; its state is the entry's state. Older entries have none. */
  verdict?: { state: string; reasons: Array<{ elementId: string; state: string; text: string }> }
  metrics: Record<string, string | number | null>
  evidence: EvidenceItem[]
  detailHref: string
}

/** GET /api/operations/overview. Shared with the shell, so the full shape stays. */
export interface OperationsOverview {
  ok: boolean
  schemaVersion: '1'
  generatedAt: string
  mode: 'live-read-first'
  overall: { state: OperationState; reasonCodes: string[] }
  systems: Record<OperationSystemId, OperationSystem>
  attention: AttentionItem[]
  evidence: EvidenceItem[]
  capabilities: OperationCapability[]
}

// ---- GET /api/gbrain/search and /api/gbrain/pages/:slug ----

export interface SearchResult {
  slug: string
  title: string | null
  type?: string | null
  snippet: string | null
  score?: number | null
}

export interface SearchData {
  query: string
  limit: number
  results: SearchResult[]
  withheld?: number
}

export interface PageData {
  slug: string
  title: string | null
  type?: string | null
  content: string | null
  truncated?: boolean
  updatedAt?: string | null
}

// ---- action flow ----

export type ActionStatus = {
  state: 'running' | 'verifying' | 'verified' | 'pending-reading' | 'failed' | 'complete'
  message: string
}
