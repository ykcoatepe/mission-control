import type { GBrainSynoptic, HealthReading, Meta, SourcesReading } from './types'

const AT = '2026-11-11T08:19:30.000Z'
const m = (value: number | null, unit = 'chunks', state: 'healthy' | 'warning' | 'critical' | 'unavailable' | 'inactive' = 'healthy') => ({
  value,
  unit,
  observedAt: value === null ? null : AT,
  state,
})

export const META: Meta = { ok: true, stale: false, observedAt: AT, ageMs: 1000, error: null }

export function synoptic(overrides: Partial<GBrainSynoptic> = {}): GBrainSynoptic {
  const item = (id: string, extra: Record<string, unknown> = {}) => ({
    id,
    label: id,
    state: 'healthy' as const,
    observedAt: AT,
    lastSyncAt: AT,
    behind: null,
    excludedByPolicy: null,
    ...extra,
  })
  const reader = (id: string, label: string) => ({
    id,
    label,
    state: 'warning' as const,
    observedAt: AT,
    integration: { configured: true, state: 'healthy' as const, observedAt: AT, evidence: 'local MCP configuration' },
    connection: { state: 'unavailable' as const, observedAt: null },
  })
  return {
    schemaVersion: '1',
    state: 'warning',
    core: {
      version: { value: '0.60.599.0', unit: 'version', observedAt: AT, state: 'healthy' },
      pages: m(63313, 'pages'),
      chunks: m(445941),
      embedded: m(443856),
      quality: { ...m(100, 'points/100'), components: [{ id: 'embed_coverage_score', ...m(35, 'points') }] },
      state: 'healthy',
      observedAt: AT,
    },
    sources: [
      { id: 'projects', label: 'projects', state: 'healthy', observedAt: AT, items: [item('mission-control'), item('off', { state: 'inactive' })] },
      { id: 'reference', label: 'reference', state: 'healthy', observedAt: AT, items: [item('a320-manuals')] },
    ],
    sourcesState: 'healthy',
    queue: { state: 'healthy', observedAt: AT, waiting: m(0, 'jobs'), active: m(0, 'jobs'), stalled: m(0, 'jobs') },
    readers: [reader('hermes', 'Hermes'), reader('codex', 'Codex')],
    readersState: 'warning',
    edges: [
      { from: 'mission-control', to: 'gbrain', state: 'healthy', label: 'time since source sync', unit: 'seconds', observedAt: AT, measurement: m(240, 'seconds') },
      { from: 'off', to: 'gbrain', state: 'inactive', label: 'time since source sync', unit: 'seconds', observedAt: AT, measurement: m(54000, 'seconds') },
      { from: 'a320-manuals', to: 'gbrain', state: 'healthy', label: 'time since source sync', unit: 'seconds', observedAt: AT, measurement: m(270, 'seconds') },
      { from: 'queue', to: 'gbrain', state: 'healthy', label: 'embedding jobs waiting', unit: 'jobs', observedAt: AT, measurement: m(0, 'jobs') },
      { from: 'hermes', to: 'gbrain', state: 'unavailable', label: 'connection not observed', unit: 'connection', observedAt: null, measurement: m(null, 'connection', 'unavailable') },
      { from: 'codex', to: 'gbrain', state: 'unavailable', label: 'connection not observed', unit: 'connection', observedAt: null, measurement: m(null, 'connection', 'unavailable') },
    ],
    ...overrides,
  }
}

export function health(metrics: Record<string, unknown> = {}, extra: Partial<HealthReading> = {}): HealthReading {
  return {
    ok: true,
    status: 'healthy',
    score: 100,
    checkedAt: AT,
    metrics: {
      stalePages: 0,
      stalePagesOverdue: 0,
      stalePagesCatchingUp: 0,
      missingEmbeddings: 0,
      missingEmbeddingsOverdue: 0,
      queue: { waiting: 0, active: 0, stalled: 0 },
      ...metrics,
    },
    meta: META,
    ...extra,
  }
}

export function sources(records: SourcesReading['sources'] = []): SourcesReading {
  return { ok: true, freshness: { defaultThresholdHours: 24 }, sources: records, meta: META }
}
