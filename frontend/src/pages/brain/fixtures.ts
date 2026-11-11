import type { GBrainSynoptic, HealthReading, Meta, PayloadVerdict, SourcesReading, VerdictReason } from './types'

const AT = '2026-11-11T08:19:30.000Z'
const m = (value: number | null, unit = 'chunks', state: 'healthy' | 'warning' | 'critical' | 'unavailable' | 'inactive' = 'healthy') => ({
  value,
  unit,
  observedAt: value === null ? null : AT,
  state,
})

export const META: Meta = { ok: true, stale: false, observedAt: AT, ageMs: 1000, error: null }

/** The server's precedence (server/sources/gbrain/state.js): a failed reading outranks critical, then warning. */
const RANK = { unavailable: 0, critical: 1, warning: 2, healthy: 3, inactive: 4 } as const

/**
 * A payload verdict the way the server builds it: the most severe non-inactive
 * reason decides (unavailable > critical > warning), and a verdict with no such reason is healthy.
 */
export function verdictOf(...reasons: VerdictReason[]): PayloadVerdict {
  const attention = reasons.filter((reason) => reason.state !== 'inactive')
  const state = attention.reduce<VerdictReason['state']>(
    (worst, reason) => (RANK[reason.state] < RANK[worst] ? reason.state : worst),
    'healthy',
  )
  return { state, reasons }
}

/** The same payload with a verdict (and the matching top-level state), as the server sends it. */
export function withVerdict(syn: GBrainSynoptic, ...reasons: VerdictReason[]): GBrainSynoptic {
  const verdict = verdictOf(...reasons)
  return { ...syn, state: verdict.state, verdict }
}

/** Only what the contract requires: no optional object, no note, no component list. */
export function minimalSynoptic(): GBrainSynoptic {
  return {
    schemaVersion: '1',
    state: 'unavailable',
    verdict: verdictOf({ elementId: 'gbrain-core', state: 'unavailable', text: 'GBrain core reading unavailable.' }),
    core: { state: 'unavailable', observedAt: null },
    sources: [],
    queue: { state: 'unavailable', observedAt: null },
    readers: [{ id: 'hermes', label: 'Hermes', state: 'unavailable', observedAt: null }],
    edges: [],
  }
}

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
    state: 'healthy' as const,
    observedAt: AT,
    integration: { configured: true, state: 'healthy' as const, observedAt: AT, evidence: 'local MCP configuration' },
  })
  return {
    schemaVersion: '1',
    state: 'healthy',
    verdict: verdictOf(),
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
    readersState: 'healthy',
    readersNote: 'connection telemetry is not observable locally',
    edges: [
      { from: 'mission-control', to: 'gbrain', state: 'healthy', label: 'time since source sync', unit: 'seconds', observedAt: AT, measurement: m(240, 'seconds') },
      { from: 'off', to: 'gbrain', state: 'inactive', label: 'time since source sync', unit: 'seconds', observedAt: AT, measurement: m(54000, 'seconds') },
      { from: 'a320-manuals', to: 'gbrain', state: 'healthy', label: 'time since source sync', unit: 'seconds', observedAt: AT, measurement: m(270, 'seconds') },
      { from: 'queue', to: 'gbrain', state: 'healthy', label: 'embedding jobs waiting', unit: 'jobs', observedAt: AT, measurement: m(0, 'jobs') },
      { from: 'hermes', to: 'gbrain', state: 'healthy', label: 'configured', observedAt: AT },
      { from: 'codex', to: 'gbrain', state: 'healthy', label: 'configured', observedAt: AT },
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
