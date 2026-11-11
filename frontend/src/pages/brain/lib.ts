import { worstState } from '../../lib/state'
import type { UiState } from '../../lib/state'
import { deriveQueueEvidenceStatus, timelineDeltaLines } from '../gbrain/presentation'
import type {
  GBrainSynoptic,
  HealthReading,
  IncidentBanner,
  Meta,
  SourceRecord,
  SourcesReading,
  SynopticReader,
  SynopticSourceGroup,
  TimelineEntry,
} from './types'

// ---- formatting ----

const NUMBER = new Intl.NumberFormat('en-US')

/** A count for display. `null` is "—": a reading that was not taken is never 0. */
export function fmtCount(value: number | null | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) ? NUMBER.format(value) : '—'
}

/** Compact duration from seconds: "<1m", "4m", "3h", "2d". `null` stays "—". */
export function fmtAge(seconds: number | null | undefined): string {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) return '—'
  const mins = Math.floor(seconds / 60)
  if (mins < 1) return '<1m'
  if (mins < 60) return `${mins}m`
  if (mins < 1440) return `${Math.floor(mins / 60)}h`
  return `${Math.floor(mins / 1440)}d`
}

function plural(count: number, one: string, many = `${one}s`) {
  return count === 1 ? one : many
}

const WORD_FIXES: Array<[RegExp, string]> = [
  [/\bcaveats\b/gi, 'notes'],
  [/\bcaveat\b/gi, 'note'],
  [/\bproof\b/gi, 'reading'],
  [/\bevidence\b/gi, 'reading'],
]

/** Backend sentences use older words; the interface says "reading" and "note". */
export function plainWords(text: string): string {
  let out = text
  for (const [pattern, replacement] of WORD_FIXES) {
    out = out.replace(pattern, (match) =>
      match[0] === match[0].toUpperCase() ? replacement[0].toUpperCase() + replacement.slice(1) : replacement,
    )
  }
  return out
}

// ---- model ----

export type ElementKind = 'core' | 'reader' | 'group' | 'queue'

export interface BlockModel {
  id: string
  kind: ElementKind
  label: string
  state: UiState
  /** Second line of the block. */
  sub: string
  /** Item count shown in the block title (source groups). */
  count: number | null
}

export interface CoreModel extends BlockModel {
  version: string | null
  rows: Array<{ label: string; value: string }>
}

export interface EdgeModel {
  id: string
  blockId: string
  state: UiState
  /** The one small label. Always a real reading or a state word. */
  label: string
  /** Full description for the tooltip and the accessible name. */
  title: string
}

export interface Condition {
  id: string
  state: UiState
  text: string
}

export interface BrainModel {
  core: CoreModel
  readers: BlockModel[]
  groups: BlockModel[]
  queue: BlockModel
  edges: EdgeModel[]
  conditions: Condition[]
  /** The displayed state of every block, by id. */
  states: Record<string, UiState>
}

export const CORE_ID = 'core'
export const QUEUE_ID = 'queue'
export const readerBlockId = (id: string) => `reader:${id}`
export const groupBlockId = (id: string) => `group:${id}`
export const edgeId = (blockId: string) => `edge:${blockId}`

/** A missing measurement is never healthy: it reads as not read. */
function stateOf(evidence: { state: UiState } | null | undefined): UiState {
  return evidence?.state ?? 'unavailable'
}

/** Short word under a reader name. Configuration is the only thing the backend can read. */
function readerSub(reader: SynopticReader): string {
  const integration = reader.integration
  if (integration?.configured === false || reader.state === 'inactive') return 'not configured'
  if (!integration || reader.state === 'unavailable' || integration.state === 'unavailable') return 'not read'
  return 'configured'
}

function recordFor(sources: SourcesReading | null | undefined, id: string): SourceRecord | undefined {
  return sources?.sources?.find((record) => record.id === id)
}

function problemWord(item: SynopticSourceGroup['items'][number], record: SourceRecord | undefined): string | null {
  if (record?.freshness?.status === 'warning') return 'stale'
  if ((item.behind ?? 0) > 0) return 'behind'
  return null
}

function groupConditionText(group: SynopticSourceGroup, sources: SourcesReading | null | undefined): string | null {
  if (group.state === 'unavailable') return `${group.label} sources could not be read`
  const bad = group.items.filter((item) => item.state === 'warning' || item.state === 'critical')
  if (bad.length === 0) return `${group.label} sources need attention`
  const words = new Set(bad.map((item) => problemWord(item, recordFor(sources, item.id))))
  const word = words.size === 1 ? [...words][0] : null
  const subject = `${bad.length} ${plural(bad.length, 'source')}`
  if (word) return `${subject} ${bad.length === 1 ? 'is' : 'are'} ${word}`
  return `${subject} ${bad.length === 1 ? 'needs' : 'need'} attention`
}

function metricProblem(name: string, state: UiState, belowNormal = false): string {
  if (state === 'unavailable') return `${name} could not be read`
  if (state === 'critical') return `${name} is failing`
  return belowNormal ? `${name} is below normal` : `${name} needs attention`
}

const SEVERITY_ORDER: Record<UiState, number> = { critical: 0, warning: 1, unavailable: 2, healthy: 3, inactive: 4 }

export function sortConditions(conditions: Condition[]): Condition[] {
  return conditions
    .map((condition, index) => ({ condition, index }))
    .sort((a, b) => SEVERITY_ORDER[a.condition.state] - SEVERITY_ORDER[b.condition.state] || a.index - b.index)
    .map(({ condition }) => condition)
}

/** Link extraction reading from the health probe. Missing or failed reads are "not read", never "current". */
export function deriveLinkExtraction(health: HealthReading | null | undefined): {
  value: string | number | null
  /** Small text after the value. */
  unit: string | null
  state: UiState
  pages: number | null
} {
  const metrics = health?.metrics
  if (!health || health.ok === false || health.meta?.ok === false || !metrics || metrics.stalePagesUnavailable === true) {
    return { value: null, unit: null, state: 'unavailable', pages: null }
  }
  const total = metrics.stalePages ?? null
  const overdue = metrics.stalePagesOverdue ?? total
  if (overdue === null) return { value: null, unit: null, state: 'unavailable', pages: null }
  if (overdue > 0) return { value: fmtCount(overdue), unit: `${plural(overdue, 'page')} behind`, state: 'warning', pages: overdue }
  const catching = metrics.stalePagesCatchingUp ?? 0
  return {
    value: 'current',
    unit: catching > 0 ? `${fmtCount(catching)} catching up` : null,
    state: 'healthy',
    pages: 0,
  }
}

function queueEvidenceState(health: HealthReading | null | undefined, synQueue: GBrainSynoptic['queue']): UiState {
  if (!health || health.ok === false || !health.metrics) return synQueue.state
  const metrics = health.metrics
  const counters = metrics.queue
  const evidence = deriveQueueEvidenceStatus({
    fallbackStatus: 'inactive',
    hasLiveHealth: true,
    countersAvailable: Boolean(
      counters && [counters.waiting, counters.active, counters.stalled].every((value) => Number.isFinite(value)),
    ),
    missingEmbeddings: metrics.missingEmbeddings ?? null,
    missingEmbeddingsOverdue: metrics.missingEmbeddingsOverdue,
    missingEmbeddingsUnavailable: metrics.missingEmbeddingsUnavailable,
    stalledJobs: counters?.stalled ?? null,
  })
  return worstState([synQueue.state, evidence])
}

export interface ModelContext {
  sources?: SourcesReading | null
  health?: HealthReading | null
}

/** Turn the synoptic payload into blocks, lines and conditions. Pure: no time, no network. */
export function buildBrainModel(syn: GBrainSynoptic, ctx: ModelContext = {}): BrainModel {
  const states: Record<string, UiState> = {}
  const conditions: Condition[] = []

  // ---- core ----
  const core = syn.core
  const coreMetrics: Array<[string, UiState, boolean]> = [
    ['Quality score', stateOf(core.quality), true],
    ['GBrain version', stateOf(core.version), false],
    ['Page count', stateOf(core.pages), false],
    ['Chunk count', stateOf(core.chunks), false],
    ['Embedded chunk count', stateOf(core.embedded), false],
  ]
  const coreProblems = coreMetrics.filter(([, state]) => state !== 'healthy' && state !== 'inactive')
  const coreState = core.state
  if (coreState !== 'healthy' && coreState !== 'inactive') {
    const allUnread = coreProblems.length > 1 && coreProblems.every(([, state]) => state === 'unavailable')
    const first = coreProblems[0]
    conditions.push({
      id: CORE_ID,
      state: coreState,
      text: allUnread
        ? 'GBrain core readings could not be read'
        : first
          ? metricProblem(first[0], first[1], first[2])
          : 'The core reading needs attention',
    })
  }
  states[CORE_ID] = coreState
  const version = core.version?.value ?? null
  const coreModel: CoreModel = {
    id: CORE_ID,
    kind: 'core',
    label: 'GBrain core',
    state: coreState,
    sub: version ? `v${version}` : 'version not read',
    count: null,
    version,
    rows: [
      { label: 'Pages', value: fmtCount(core.pages?.value) },
      { label: 'Chunks', value: fmtCount(core.chunks?.value) },
      { label: 'Embedded', value: fmtCount(core.embedded?.value) },
    ],
  }

  // ---- source groups ----
  const groups: BlockModel[] = []
  const edges: EdgeModel[] = []
  for (const group of syn.sources) {
    const id = groupBlockId(group.id)
    const bad = group.items.filter((item) => item.state === 'warning' || item.state === 'critical')
    const off = group.items.filter((item) => item.state === 'inactive').length
    let sub: string
    if (group.state === 'unavailable') sub = 'not read'
    else if (group.state === 'inactive') sub = 'sync off'
    else if (bad.length > 0) sub = `${bad.length} of ${group.items.length} need attention`
    else sub = off > 0 ? `all fresh · ${off} off` : 'all fresh'
    groups.push({ id, kind: 'group', label: group.label, state: group.state, sub, count: group.items.length })
    states[id] = group.state
    if (group.state === 'warning' || group.state === 'critical' || group.state === 'unavailable') {
      const text = groupConditionText(group, ctx.sources)
      if (text) conditions.push({ id, state: group.state, text })
    }

    const active = group.items.filter((item) => item.state !== 'inactive')
    const ages = active.flatMap((item) => {
      const edge = syn.edges.find((e) => e.from === item.id && e.unit === 'seconds')
      const value = edge?.measurement?.value
      return typeof value === 'number' ? [value] : []
    })
    const behind = group.items.reduce((sum, item) => sum + (item.behind ?? 0), 0)
    let label: string
    let edgeState: UiState = group.state
    if (group.state === 'inactive' || active.length === 0) label = 'sync off'
    else if (ages.length === 0) {
      label = 'not read'
      edgeState = 'unavailable'
    } else {
      const age = fmtAge(Math.max(...ages))
      label = behind > 0 ? `${age} · ${fmtCount(behind)} behind` : `sync ${age}`
    }
    edges.push({
      id: edgeId(id),
      blockId: id,
      state: edgeState,
      label,
      title: `${group.label} to GBrain core: ${label}`,
    })
  }

  // ---- readers ----
  // The backend derives a reader's state from its integration reading alone.
  const readers: BlockModel[] = []
  for (const reader of syn.readers) {
    const id = readerBlockId(reader.id)
    const state = reader.state
    readers.push({ id, kind: 'reader', label: reader.label, state, sub: readerSub(reader), count: null })
    states[id] = state
    const notConfigured = reader.integration?.configured === false
    if (state === 'warning' || state === 'critical' || state === 'unavailable' || notConfigured) {
      conditions.push({
        id,
        state: notConfigured && (state === 'inactive' || state === 'healthy') ? 'warning' : state,
        text: notConfigured ? `${reader.label} is not configured` : state === 'unavailable' ? `${reader.label} could not be read` : `${reader.label} needs attention`,
      })
    }
    const payloadEdge = syn.edges.find((e) => e.from === reader.id && e.label === 'configured')
    const edgeState: UiState = payloadEdge?.state ?? state
    const label =
      edgeState === 'unavailable' ? 'not read'
      : edgeState === 'inactive' ? 'not configured'
      : (payloadEdge?.label ?? 'configured')
    edges.push({
      id: edgeId(id),
      blockId: id,
      state: edgeState,
      label,
      title: `${reader.label} to GBrain core: ${label}`,
    })
  }

  // ---- queue ----
  const queueState = queueEvidenceState(ctx.health, syn.queue)
  const q = syn.queue
  const stalled = q.stalled?.value ?? null
  const overdue = ctx.health?.metrics?.missingEmbeddingsOverdue ?? null
  states[QUEUE_ID] = queueState
  if (queueState !== 'healthy' && queueState !== 'inactive') {
    let text = 'The embedding queue needs attention'
    if (queueState === 'unavailable') text = 'The embedding queue could not be read'
    else if (typeof stalled === 'number' && stalled > 0) text = `${fmtCount(stalled)} embedding ${plural(stalled, 'job')} stalled`
    else if (typeof overdue === 'number' && overdue > 0) text = `${fmtCount(overdue)} ${plural(overdue, 'chunk')} overdue for embedding`
    conditions.push({ id: QUEUE_ID, state: queueState, text })
  }
  const queueModel: BlockModel = {
    id: QUEUE_ID,
    kind: 'queue',
    label: 'Embedding queue',
    state: queueState,
    sub: `${fmtCount(q.waiting?.value)} waiting · ${fmtCount(q.active?.value)} active · ${fmtCount(q.stalled?.value)} stalled`,
    count: null,
  }
  const waiting = q.waiting?.value
  edges.push({
    id: edgeId(QUEUE_ID),
    blockId: QUEUE_ID,
    state: typeof waiting === 'number' ? queueState : 'unavailable',
    label: typeof waiting === 'number' ? `${fmtCount(waiting)} waiting` : 'not read',
    title: `Embedding queue to GBrain core: ${typeof waiting === 'number' ? `${fmtCount(waiting)} waiting` : 'not read'}`,
  })

  return {
    core: coreModel,
    readers,
    groups,
    queue: queueModel,
    edges,
    conditions: sortConditions(conditions),
    states,
  }
}

// ---- verdict ----

export interface Verdict {
  state: UiState
  text: string
  conditions: Condition[]
}

/** One sentence from the worst condition. Stale or missing readings never read as normal. */
export function deriveVerdict(
  model: BrainModel | null,
  meta: Meta | null,
  extra: Condition[] = [],
): Verdict {
  if (!model) return { state: 'unavailable', text: 'GBrain could not be read', conditions: [] }
  const all = [...extra, ...model.conditions]
  if (meta?.stale) all.push({ id: 'meta', state: 'warning', text: 'the last reading is stale' })
  const conditions = sortConditions(all)
  const first = conditions[0]
  if (!first) return { state: 'healthy', text: 'GBrain is normal', conditions }
  const more = conditions.length - 1
  const suffix = more > 0 ? ` (and ${more} more)` : ''
  if (first.state === 'unavailable') {
    return { state: 'unavailable', text: `GBrain readings are incomplete: ${first.text}${suffix}`, conditions }
  }
  return { state: first.state, text: `GBrain needs attention: ${first.text}${suffix}`, conditions }
}

// ---- readings (the four stats) ----

export interface ReadingSet {
  quality: { value: number | null; state: UiState }
  sourceSync: { value: string | null; state: UiState; hint: string }
  linkExtraction: { value: string | number | null; unit: string | null; state: UiState; hint: string }
  queue: { value: number | null; state: UiState; hint: string }
}

export const LINK_EXTRACTION_HINT = 'Pages awaiting link and timeline extraction; source sync is separate'

export function deriveSourceSync(groups: SynopticSourceGroup[]): ReadingSet['sourceSync'] {
  const items = groups.flatMap((group) => group.items)
  if (items.length === 0) return { value: null, state: 'unavailable', hint: 'No sources were read' }
  const fresh = items.filter((item) => item.state === 'healthy').length
  const stale = items.filter((item) => item.state === 'warning' || item.state === 'critical').length
  const unread = items.filter((item) => item.state === 'unavailable').length
  const excluded = items.filter((item) => item.excludedByPolicy === true).length
  const off = items.filter((item) => item.state === 'inactive' && item.excludedByPolicy !== true).length
  const parts: string[] = []
  if (stale > 0) parts.push(`${stale} stale`)
  if (unread > 0) parts.push(`${unread} not read`)
  if (excluded > 0) parts.push(`${excluded} excluded`)
  if (off > 0) parts.push(`${off} sync off`)
  const considered = groups.filter((group) => group.state !== 'inactive').map((group) => group.state)
  return {
    value: `${fresh} of ${items.length}`,
    state: considered.length ? worstState(considered) : 'inactive',
    hint: parts.length ? parts.join(' · ') : 'all fresh',
  }
}

export function deriveReadings(syn: GBrainSynoptic, model: BrainModel, health: HealthReading | null | undefined): ReadingSet {
  const link = deriveLinkExtraction(health)
  const q = syn.queue
  return {
    quality: { value: syn.core.quality?.value ?? null, state: stateOf(syn.core.quality) },
    sourceSync: deriveSourceSync(syn.sources),
    linkExtraction: { value: link.value, unit: link.unit, state: link.state, hint: LINK_EXTRACTION_HINT },
    queue: {
      value: q.waiting?.value ?? null,
      state: model.states[QUEUE_ID] ?? q.state,
      hint: `${fmtCount(q.active?.value)} active · ${fmtCount(q.stalled?.value)} stalled`,
    },
  }
}

/** The link extraction condition is separate from the synoptic and feeds the verdict. */
export function linkExtractionCondition(health: HealthReading | null | undefined): Condition[] {
  if (health === undefined) return []
  const link = deriveLinkExtraction(health)
  if (link.state === 'warning') {
    const n = link.pages ?? 0
    return [{ id: 'link-extraction', state: 'warning', text: `${fmtCount(n)} ${plural(n, 'page')} awaiting link extraction` }]
  }
  if (link.state === 'unavailable') return [{ id: 'link-extraction', state: 'unavailable', text: 'link extraction could not be read' }]
  return []
}

// ---- element detail ----

export interface DetailRow {
  label: string
  value: string
  /** When set, the value is a point in time shown as a relative time. */
  valueAt?: string | null
  mono?: boolean
  observedAt?: string | null
  state?: UiState
}

export interface DetailItem {
  id: string
  label: string
  state: UiState
  lastSyncAt: string | null
  note: string | null
}

export interface ElementDetail {
  id: string
  title: string
  state: UiState
  observedAt: string | null
  rows: DetailRow[]
  items: DetailItem[]
  notes: string[]
  actionIds: string[]
}

const COMPONENT_LABELS: Record<string, string> = {
  embed_coverage_score: 'Embedding coverage',
  link_density_score: 'Link density',
  timeline_coverage_score: 'Timeline coverage',
  no_orphans_score: 'Pages without orphans',
  no_dead_links_score: 'Pages without dead links',
}

export const ACTIONS_FOR = {
  core: ['doctor-fast', 'storage-status', 'check-resolvable'],
  groupHealthy: ['preview-sync', 'sync-sources'],
  groupAbnormal: ['retry-failed-sync', 'preview-sync', 'sync-sources'],
  queue: ['embed-stale', 'embed-missing'],
  reader: [] as string[],
} as const

function actionsForBlock(id: string, state: UiState): string[] {
  if (id === CORE_ID) return [...ACTIONS_FOR.core]
  if (id === QUEUE_ID) return [...ACTIONS_FOR.queue]
  if (id.startsWith('group:')) {
    return [...(state === 'healthy' || state === 'inactive' ? ACTIONS_FOR.groupHealthy : ACTIONS_FOR.groupAbnormal)]
  }
  return [...ACTIONS_FOR.reader]
}

export function blockIdOfElement(id: string): string {
  return id.startsWith('edge:') ? id.slice('edge:'.length) : id
}

/** A row for one measurement; a missing measurement is a dash with a "not read" state. */
function measuredRow<T extends string | number>(
  label: string,
  m: { value: T | null; observedAt: string | null; state: UiState } | null | undefined,
  format: (value: T) => string,
  mono = true,
): DetailRow {
  const value = m?.value
  return {
    label,
    value: value === null || value === undefined ? '—' : format(value),
    mono,
    observedAt: m?.observedAt ?? null,
    state: stateOf(m),
  }
}

/** Everything the detail panel shows for a block or a line. Null when the element does not exist. */
export function describeElement(
  elementId: string,
  syn: GBrainSynoptic,
  model: BrainModel,
  ctx: ModelContext = {},
): ElementDetail | null {
  const isEdge = elementId.startsWith('edge:')
  const blockId = blockIdOfElement(elementId)
  const block =
    blockId === CORE_ID ? model.core
    : blockId === QUEUE_ID ? model.queue
    : [...model.readers, ...model.groups].find((b) => b.id === blockId)
  if (!block) return null
  const edge = isEdge ? model.edges.find((e) => e.id === elementId) : undefined
  if (isEdge && !edge) return null
  const notes = model.conditions.filter((c) => c.id === blockId).map((c) => `${c.text.charAt(0).toUpperCase()}${c.text.slice(1)}.`)
  const rows: DetailRow[] = []
  const items: DetailItem[] = []
  let observedAt: string | null = null

  if (blockId === CORE_ID) {
    const c = syn.core
    observedAt = c.observedAt
    rows.push(
      measuredRow('Version', c.version, (v) => v, true),
      measuredRow('Pages', c.pages, fmtCount),
      measuredRow('Chunks', c.chunks, fmtCount),
      measuredRow('Embedded', c.embedded, fmtCount),
      measuredRow('Quality', c.quality, (v) => `${fmtCount(v)}/100`),
    )
    for (const part of c.quality?.components ?? []) {
      rows.push({ ...measuredRow(COMPONENT_LABELS[part.id] ?? part.id, part, (v) => `${fmtCount(v)} points`) })
    }
  } else if (blockId === QUEUE_ID) {
    const q = syn.queue
    observedAt = q.observedAt
    rows.push(
      measuredRow('Waiting', q.waiting, fmtCount),
      measuredRow('Active', q.active, fmtCount),
      measuredRow('Stalled', q.stalled, fmtCount),
    )
    const m = ctx.health?.metrics
    const healthReading = ctx.health
    if (m && healthReading && healthReading.ok !== false) {
      rows.push(
        { label: 'Missing embeddings', value: fmtCount(m.missingEmbeddings ?? null), mono: true, observedAt: healthReading.checkedAt ?? null },
        { label: 'Overdue for embedding', value: fmtCount(m.missingEmbeddingsOverdue ?? null), mono: true, observedAt: healthReading.checkedAt ?? null },
      )
    }
  } else if (blockId.startsWith('group:')) {
    const group = syn.sources.find((g) => groupBlockId(g.id) === blockId)
    if (!group) return null
    observedAt = group.observedAt
    const synced = group.items
      .filter((item) => item.state !== 'inactive')
      .flatMap((item) => (item.lastSyncAt ? [Date.parse(item.lastSyncAt)] : []))
      .filter(Number.isFinite)
    rows.push({ label: 'Sources', value: fmtCount(group.items.length), mono: true, observedAt: group.observedAt, state: group.state })
    if (synced.length) rows.push({ label: 'Oldest successful sync', value: '—', valueAt: new Date(Math.min(...synced)).toISOString() })
    const limit = ctx.sources?.freshness?.defaultThresholdHours
    if (typeof limit === 'number') rows.push({ label: 'Freshness limit', value: `${limit}h`, mono: true })
    const ordered = [...group.items].sort((a, b) => SEVERITY_ORDER[a.state] - SEVERITY_ORDER[b.state])
    for (const item of ordered) {
      const record = recordFor(ctx.sources, item.id)
      const parts: string[] = []
      if (item.state === 'inactive') parts.push(item.excludedByPolicy === true ? 'excluded by policy' : 'sync off')
      if ((item.behind ?? 0) > 0) parts.push(`${fmtCount(item.behind)} behind`)
      if (record?.pages != null) parts.push(`${fmtCount(record.pages)} pages`)
      items.push({
        id: item.id,
        label: item.label,
        state: item.state,
        lastSyncAt: item.lastSyncAt ?? null,
        note: parts.length ? parts.join(' · ') : null,
      })
    }
  } else {
    const reader = syn.readers.find((r) => readerBlockId(r.id) === blockId)
    if (!reader) return null
    observedAt = reader.observedAt
    const integration = reader.integration
    rows.push(
      {
        label: 'Configuration',
        value: integration?.configured === true ? 'configured' : integration?.configured === false ? 'not configured' : 'not read',
        observedAt: integration?.observedAt ?? null,
        state: integration?.state ?? 'unavailable',
      },
      { label: 'Read from', value: integration?.evidence || '—' },
    )
  }

  if (edge) {
    rows.unshift({ label: 'Line', value: edge.label, mono: true, state: edge.state })
  }

  return {
    id: elementId,
    title: edge ? `${block.label} to GBrain core` : block.label,
    state: edge ? edge.state : block.state,
    observedAt,
    rows,
    items,
    notes,
    actionIds: actionsForBlock(blockId, block.state),
  }
}

// ---- notes: current conditions and recovered regressions ----

export interface NoteLine {
  id: string
  state: UiState
  text: string
}

/** Current notes: conditions first, then reading limitations. Deduplicated, plain words. */
export function currentNotes(
  verdict: Verdict,
  caveats: readonly string[] = [],
  readersNote?: string | null,
): NoteLine[] {
  const lines: NoteLine[] = verdict.conditions.map((condition) => ({
    id: `condition:${condition.id}`,
    state: condition.state,
    text: `${condition.text.charAt(0).toUpperCase()}${condition.text.slice(1)}.`,
  }))
  const note = readersNote?.trim()
  if (note) {
    lines.push({ id: 'readers-note', state: 'unavailable', text: `${note.charAt(0).toUpperCase()}${note.slice(1)}${/[.!?]$/.test(note) ? '' : '.'}` })
  }
  const seen = new Set(lines.map((line) => line.text.toLowerCase()))
  for (const caveat of caveats) {
    const text = plainWords(caveat.trim())
    if (!text || seen.has(text.toLowerCase())) continue
    seen.add(text.toLowerCase())
    lines.push({ id: `note:${text}`, state: 'warning', text })
  }
  return lines
}

export function incidentKey(banner: IncidentBanner): string {
  return banner.snapshotId || `${banner.title}:${banner.detail}`
}

/**
 * Recovered regressions that still await acknowledgement. The ledger repeats
 * one incident across heartbeats, so repeats collapse to one entry.
 */
export function collapseIncidents(
  banners: readonly IncidentBanner[] | null | undefined,
  acknowledged: ReadonlySet<string>,
): Array<{ key: string; banner: IncidentBanner }> {
  const seen = new Map<string, IncidentBanner>()
  for (const banner of banners ?? []) {
    if (banner.kind !== 'recent-regression') continue
    const key = incidentKey(banner)
    if (acknowledged.has(key) || seen.has(key)) continue
    seen.set(key, banner)
  }
  return [...seen].map(([key, banner]) => ({ key, banner }))
}

/** Split "3 caveats at 2026-…Z." into plain text and the time it happened. */
export function describeIncident(banner: IncidentBanner): { text: string; at: string | null } {
  const match = banner.detail.match(/^(.*?)\s+at\s+(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\.?$/)
  if (!match) return { text: plainWords(banner.detail), at: null }
  return { text: plainWords(match[1]), at: match[2] }
}

// ---- recent readings ----

export interface ReadingRow {
  id: string
  at: string
  state: UiState
  quality: string
  headline: string
}

const MAX_CHANGES = 3

/** A ledger entry whose optional sections are missing still reads; the missing parts are "not read". */
function completeEntry(entry: TimelineEntry): TimelineEntry {
  return {
    ...entry,
    metrics: entry.metrics ?? {},
    sourceFreshness: entry.sourceFreshness ?? { status: 'inactive' },
    warnings: entry.warnings ?? [],
  }
}

export function recentReadings(entries: readonly TimelineEntry[] | null | undefined, limit = 6): ReadingRow[] {
  if (!entries) return []
  const complete = entries.map(completeEntry)
  return complete.slice(0, limit).map((entry, index) => {
    const changes = timelineDeltaLines(entry, complete[index + 1])
    const health = entry.metrics.health
    return {
      id: entry.id,
      at: entry.capturedAt,
      state: entry.trust.status === 'inactive' ? 'inactive' : entry.trust.status,
      quality: typeof health === 'string' && health ? health : entry.trust.score === null ? 'not read' : `${entry.trust.score}/100`,
      headline: changes.length
        ? `${changes.slice(0, MAX_CHANGES).join(' · ')}${changes.length > MAX_CHANGES ? ` · +${changes.length - MAX_CHANGES} more` : ''}`
        : 'No change',
    }
  })
}

// ---- knowledge search ----

export const MIN_QUERY_LENGTH = 2
const SEARCH_LIMIT = 20

/** The search URL, or null when the query is too short to send. */
export function searchUrl(query: string): string | null {
  const trimmed = query.trim()
  if (trimmed.length < MIN_QUERY_LENGTH) return null
  return `/api/gbrain/search?q=${encodeURIComponent(trimmed)}&limit=${SEARCH_LIMIT}`
}

export function pageUrl(slug: string): string {
  return `/api/gbrain/pages/${encodeURIComponent(slug)}`
}

/** Class-W2 actions are never listed: they cannot be started from here. */
export function visibleActions<T extends { safetyClass: string }>(capabilities: T[]): T[] {
  return capabilities.filter((capability) => capability.safetyClass !== 'W2')
}
