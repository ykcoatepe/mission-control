export type GBrainEvidenceStatus = 'healthy' | 'warning' | 'critical' | 'inactive'

export interface OperationalStateInput {
  hasData: boolean
  loading: boolean
  trustStatus: GBrainEvidenceStatus
  incidentStatus?: GBrainEvidenceStatus | null
  incidentIsCurrent?: boolean
  caveatCount: number
}

export interface OperationalState {
  status: GBrainEvidenceStatus
  label: string
}

export interface TimelineDeltaEntry {
  trust: {
    status: GBrainEvidenceStatus
    score: number | null
  }
  metrics: Record<string, string | number | null>
  sourceFreshness: {
    status: GBrainEvidenceStatus
  }
}

export interface QueueEvidenceInput {
  fallbackStatus: GBrainEvidenceStatus
  hasLiveHealth: boolean
  countersAvailable: boolean
  missingEmbeddings: number | null
  stalledJobs: number | null
}

const statusRank: Record<GBrainEvidenceStatus, number> = {
  inactive: 0,
  healthy: 1,
  warning: 2,
  critical: 3,
}

function evidenceStatusLabel(status: GBrainEvidenceStatus) {
  if (status === 'healthy') return 'Verified'
  if (status === 'warning') return 'Caveat'
  if (status === 'critical') return 'Failing'
  return 'Read-only'
}

function sourceSyncLabel(status: GBrainEvidenceStatus) {
  if (status === 'healthy') return 'Fresh'
  if (status === 'warning') return 'Stale'
  if (status === 'critical') return 'Unavailable'
  return 'Not tracked'
}

function structuredCount(metrics: TimelineDeltaEntry['metrics'], key: string) {
  const value = metrics[key]
  if (value === null || value === undefined || value === '') return null
  const count = Number(String(value).replace(/,/g, ''))
  return Number.isFinite(count) ? count : null
}

function legacyCount(detail: string | number | null | undefined, pattern: RegExp) {
  const match = String(detail || '').match(pattern)
  if (!match) return null
  const count = Number(String(match[1] || '').replace(/,/g, ''))
  return Number.isFinite(count) ? count : null
}

function missingEmbeddingsCount(entry: TimelineDeltaEntry) {
  return structuredCount(entry.metrics, 'missingEmbeddings')
    ?? legacyCount(entry.metrics.embeddingsDetail, /([\d,]+)\s+missing/i)
}

function stalePagesCount(entry: TimelineDeltaEntry) {
  return structuredCount(entry.metrics, 'stalePages')
    ?? legacyCount(entry.metrics.embeddingsDetail, /([\d,]+)\s+stale pages?/i)
}

// Overdue pages (older than the sweep tolerance) are "stale"; the rest of the
// raw count is shown as catching up. Snapshots without stalePagesOverdue
// treat every stale page as overdue.
function compiledTruthLabel(entry: TimelineDeltaEntry) {
  const count = stalePagesCount(entry)
  if (count === null) return null
  const overdue = structuredCount(entry.metrics, 'stalePagesOverdue') ?? count
  if (overdue > 0) return `${overdue.toLocaleString()} stale page${overdue === 1 ? '' : 's'}`
  if (count > 0) return `Current · ${count.toLocaleString()} catching up`
  return 'Current'
}

export function deriveOperationalState(input: OperationalStateInput): OperationalState {
  if (input.loading) return { status: 'inactive', label: 'Checking live proof' }
  if (!input.hasData) return { status: 'inactive', label: 'No live proof' }

  const statuses = [input.trustStatus, input.incidentIsCurrent === false ? null : input.incidentStatus]
    .filter((status): status is GBrainEvidenceStatus => Boolean(status))
  if (input.caveatCount > 0) statuses.push('warning')
  const status = statuses.reduce<GBrainEvidenceStatus>((mostSevere, current) => (
    statusRank[current] > statusRank[mostSevere] ? current : mostSevere
  ), 'inactive')

  if (status === 'critical') return { status, label: 'Action required' }
  if (status === 'warning') return { status, label: 'Degraded' }
  if (status === 'healthy') return { status, label: 'Operational' }
  return { status, label: 'Read-only' }
}

export function deriveQueueEvidenceStatus(input: QueueEvidenceInput): GBrainEvidenceStatus {
  if (!input.hasLiveHealth) return input.fallbackStatus
  if (!input.countersAvailable || input.missingEmbeddings === null || input.stalledJobs === null) return 'warning'
  if (input.missingEmbeddings > 0 || input.stalledJobs > 0) return 'warning'
  return 'healthy'
}

export function timelineDeltaLines(
  current: TimelineDeltaEntry,
  previous: TimelineDeltaEntry | undefined,
): string[] {
  if (!previous) return []

  const values: { label: string; from: string | number | null | undefined; to: string | number | null | undefined }[] = [
    {
      label: 'Proof state',
      from: evidenceStatusLabel(previous.trust.status),
      to: evidenceStatusLabel(current.trust.status),
    },
    { label: 'Trust', from: previous.trust.score, to: current.trust.score },
    { label: 'Health', from: previous.metrics.health, to: current.metrics.health },
    { label: 'Embeddings', from: previous.metrics.embeddings, to: current.metrics.embeddings },
    {
      label: 'Missing embeddings',
      from: missingEmbeddingsCount(previous),
      to: missingEmbeddingsCount(current),
    },
    {
      label: 'Compiled truth',
      from: compiledTruthLabel(previous),
      to: compiledTruthLabel(current),
    },
    { label: 'Queue', from: previous.metrics.queue, to: current.metrics.queue },
    {
      label: 'Source sync',
      from: sourceSyncLabel(previous.sourceFreshness.status),
      to: sourceSyncLabel(current.sourceFreshness.status),
    },
    { label: 'Caveats', from: previous.metrics.caveats, to: current.metrics.caveats },
  ]

  return values.flatMap(({ label, from, to }) => {
    if (from === undefined || from === null || to === undefined || to === null || from === to) return []
    return [`${label} ${from} → ${to}`]
  })
}
