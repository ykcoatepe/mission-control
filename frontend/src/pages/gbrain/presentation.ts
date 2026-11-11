export type GBrainEvidenceStatus = 'healthy' | 'warning' | 'critical' | 'inactive'

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
  // Verdict-bearing part of missingEmbeddings (oldest older than the embed
  // tolerance). Absent means every missing embedding counts.
  missingEmbeddingsOverdue?: number | null
  missingEmbeddingsUnavailable?: boolean
  stalledJobs: number | null
}

function evidenceStatusLabel(status: GBrainEvidenceStatus) {
  if (status === 'healthy') return 'Normal'
  if (status === 'warning') return 'Warning'
  if (status === 'critical') return 'Critical'
  return 'Not read'
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

function oldestAgeText(seconds: number | null) {
  return seconds === null ? '' : ` (oldest ${Math.max(1, Math.round(seconds / 60))}m)`
}

// Raw missing-embedding count; inside the embed tolerance it is labeled as
// catching up, beyond it with the oldest age. Snapshots without
// missingEmbeddingsOverdue treat every missing embedding as overdue.
function missingEmbeddingsLabel(entry: TimelineDeltaEntry) {
  const count = missingEmbeddingsCount(entry)
  if (count === null) return null
  const overdue = structuredCount(entry.metrics, 'missingEmbeddingsOverdue') ?? count
  const oldest = oldestAgeText(structuredCount(entry.metrics, 'missingEmbeddingsOldestAgeSeconds'))
  if (overdue > 0) return `${count.toLocaleString()}${oldest}`
  if (count > 0) return `${count.toLocaleString()} catching up${oldest}`
  return count.toLocaleString()
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

export function deriveQueueEvidenceStatus(input: QueueEvidenceInput): GBrainEvidenceStatus {
  if (!input.hasLiveHealth) return input.fallbackStatus
  if (input.missingEmbeddingsUnavailable === true) return 'warning'
  const missingEmbeddings = input.missingEmbeddingsOverdue ?? input.missingEmbeddings
  if (!input.countersAvailable || missingEmbeddings === null || input.stalledJobs === null) return 'warning'
  if (missingEmbeddings > 0 || input.stalledJobs > 0) return 'warning'
  return 'healthy'
}

export function timelineDeltaLines(
  current: TimelineDeltaEntry,
  previous: TimelineDeltaEntry | undefined,
): string[] {
  if (!previous) return []

  const values: { label: string; from: string | number | null | undefined; to: string | number | null | undefined }[] = [
    {
      label: 'State',
      from: evidenceStatusLabel(previous.trust.status),
      to: evidenceStatusLabel(current.trust.status),
    },
    { label: 'Quality', from: previous.trust.score, to: current.trust.score },
    { label: 'Health', from: previous.metrics.health, to: current.metrics.health },
    { label: 'Embeddings', from: previous.metrics.embeddings, to: current.metrics.embeddings },
    {
      label: 'Missing embeddings',
      from: missingEmbeddingsLabel(previous),
      to: missingEmbeddingsLabel(current),
    },
    {
      label: 'Link extraction',
      from: compiledTruthLabel(previous),
      to: compiledTruthLabel(current),
    },
    { label: 'Queue', from: previous.metrics.queue, to: current.metrics.queue },
    {
      label: 'Source sync',
      from: sourceSyncLabel(previous.sourceFreshness.status),
      to: sourceSyncLabel(current.sourceFreshness.status),
    },
    { label: 'Notes', from: previous.metrics.caveats, to: current.metrics.caveats },
  ]

  return values.flatMap(({ label, from, to }) => {
    if (from === undefined || from === null || to === undefined || to === null || from === to) return []
    return [`${label} ${from} → ${to}`]
  })
}
