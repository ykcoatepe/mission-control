import { describeApiError, isBusyError, isUnavailableError } from '../../lib/hooks'
import { stateLabel, toUiState, worstState } from '../../lib/state'
import type { UiState } from '../../lib/state'
import { timelineDeltaLines } from '../gbrain/presentation'
import type {
  GBrainSynoptic,
  HealthReading,
  IncidentBanner,
  Meta,
  PayloadVerdict,
  ReasonKind,
  VerdictReason,
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

/** One word for a source whose sync is switched off, everywhere on the page. */
const VOCABULARY: Array<[RegExp, string]> = [
  [/\bsync(?:ing)? (?:is )?disabled\b/gi, 'sync off'],
  [/\bexcluded by policy\b/gi, 'sync off'],
]

/** The part of a source the sync wording depends on (synoptic items and `/api/gbrain/sources` records both carry it). */
export interface SyncSubject {
  state?: UiState | string | null
  excludedByPolicy?: boolean | null
  reason?: string | null
}

/** True when the server says the source is outside freshness scoring (sync disabled or not sync-tracked). */
export function isSyncOff(source: SyncSubject | null | undefined): boolean {
  return source?.excludedByPolicy === true
}

/**
 * The one word for a source's sync, used by every list and count on the page:
 * "sync off" when the server excluded the source by policy, "fresh" when it is
 * healthy, otherwise its state word. The state alone never decides "sync off".
 */
export function syncWord(source: SyncSubject | null | undefined): string {
  if (isSyncOff(source)) return 'sync off'
  const state = toUiState(source?.state ?? 'unavailable')
  return state === 'healthy' ? 'fresh' : stateLabel(state).toLowerCase()
}

/** Only the shared vocabulary: backend reasons keep their own wording otherwise. */
export function sameVocabulary(text: string): string {
  return VOCABULARY.reduce((out, [pattern, replacement]) => out.replace(pattern, replacement), text)
}

/** Backend sentences use older words; the interface says "reading" and "note". */
export function plainWords(text: string): string {
  let out = sameVocabulary(text)
  for (const [pattern, replacement] of WORD_FIXES) {
    out = out.replace(pattern, (match) =>
      match[0] === match[0].toUpperCase() ? replacement[0].toUpperCase() + replacement.slice(1) : replacement,
    )
  }
  return out
}

/**
 * Capitalise the first letter of a sentence, but never re-case an identifier:
 * "tk-omc-ain: sync off." keeps its source id exactly as the backend wrote it.
 */
export function startSentence(text: string): string {
  const trimmed = text.trim()
  const first = trimmed.split(/\s+/, 1)[0] ?? ''
  if (!first || /[-_./:\d]/.test(first)) return trimmed
  return `${trimmed.charAt(0).toUpperCase()}${trimmed.slice(1)}`
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
  /**
   * The block is a configuration reading, not an observed state (readers): it carries no state
   * dot, no state colour and no state word. Observed readings keep the dot.
   */
  neutral?: boolean
  /** Readers only: whether the integration is set up. A reader that is not set up looks different, not dim. */
  presence?: 'set_up' | 'not_set_up'
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
  /** A configuration line, not an observed one: a plain neutral line with no label and no state colour. */
  neutral?: boolean
}

export interface Condition {
  id: string
  state: UiState
  text: string
  /** The server's own split: something to act on, or something to know. */
  kind: ReasonKind
}

export interface BrainModel {
  core: CoreModel
  readers: BlockModel[]
  groups: BlockModel[]
  queue: BlockModel
  edges: EdgeModel[]
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

/**
 * Short words under a reader name, from the server's `observation`. A reader whose configuration was
 * read is "Set up": whether it is connected right now cannot be observed here, so that is not a state.
 * An observed reader shows its state; one whose observation was not sent is "not read".
 */
function readerSub(reader: SynopticReader): string {
  switch (reader.observation) {
    case 'configured':
      return 'Set up'
    case 'not_configured':
      return 'Not set up'
    case 'observed':
      return stateLabel(reader.state).toLowerCase()
    default:
      return 'not read'
  }
}

function recordFor(sources: SourcesReading | null | undefined, id: string): SourceRecord | undefined {
  return sources?.sources?.find((record) => record.id === id)
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

export interface ModelContext {
  sources?: SourcesReading | null
  health?: HealthReading | null
}

/** Turn the synoptic payload into blocks and lines. Pure: no time, no network. It forms no verdict of its own. */
export function buildBrainModel(syn: GBrainSynoptic): BrainModel {
  const states: Record<string, UiState> = {}

  // ---- core ----
  const core = syn.core
  const coreState = core.state
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
    const off = group.items.filter(isSyncOff).length
    let sub: string
    if (group.state === 'unavailable') sub = 'not read'
    else if (group.state === 'inactive') sub = off === group.items.length ? 'sync off' : 'inactive'
    else if (bad.length > 0) sub = `${bad.length} of ${group.items.length} need attention`
    else sub = off > 0 ? `all fresh · ${off} sync off` : 'all fresh'
    groups.push({ id, kind: 'group', label: group.label, state: group.state, sub, count: group.items.length })
    states[id] = group.state

    const active = group.items.filter((item) => !isSyncOff(item))
    const ages = active.flatMap((item) => {
      const edge = syn.edges.find((e) => e.from === item.id && e.unit === 'seconds')
      const value = edge?.measurement?.value
      return typeof value === 'number' ? [value] : []
    })
    const behind = group.items.reduce((sum, item) => sum + (item.behind ?? 0), 0)
    let label: string
    let edgeState: UiState = group.state
    if (group.state === 'inactive' || active.length === 0) label = off === group.items.length ? 'sync off' : 'inactive'
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
  // `observation` says what the reader's state rests on. Configuration cannot show a connection, so
  // "set up" and "not set up" are facts, not states: no dot, no state colour, no label on the line.
  // Only an observed reader (real telemetry, if a server ever sends it) or a failed read gets a state.
  const readers: BlockModel[] = []
  for (const reader of syn.readers) {
    const id = readerBlockId(reader.id)
    const state = reader.state
    const sub = readerSub(reader)
    const neutral = reader.observation === 'configured' || reader.observation === 'not_configured'
    const presence = reader.observation === 'configured' ? 'set_up' : reader.observation === 'not_configured' ? 'not_set_up' : undefined
    readers.push({ id, kind: 'reader', label: reader.label, state, sub, count: null, neutral, presence })
    states[id] = state
    const payloadEdge = syn.edges.find((e) => e.from === reader.id && e.to === 'gbrain')
    const edgeState: UiState = payloadEdge?.state ?? state
    // A neutral line says nothing; an observed one says its state word.
    const label = neutral ? '' : sub
    edges.push({
      id: edgeId(id),
      blockId: id,
      state: edgeState,
      label,
      title: neutral ? `${reader.label} to GBrain core` : `${reader.label} to GBrain core: ${label}`,
      neutral,
    })
  }

  // ---- queue ----
  // The queue's state is the payload's. The health reading adds numbers to its detail, never a second opinion.
  const queueState = syn.queue.state
  const q = syn.queue
  states[QUEUE_ID] = queueState
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
    states,
  }
}

// ---- verdict ----

export interface Verdict {
  state: UiState
  text: string
  /** The payload's own reasons, most severe first. Inactive reasons are listed but never degrade the state. */
  conditions: Condition[]
  /** What the verdict could not observe, said next to a normal verdict so it never claims more than was read. */
  caveat: string | null
}

const KNOWN_STATES: readonly UiState[] = ['healthy', 'warning', 'critical', 'unavailable', 'inactive']

/** The payload verdict, if it has the shape the contract promises; otherwise null (never repaired). */
export function readPayloadVerdict(syn: Pick<GBrainSynoptic, 'verdict'> | null | undefined): PayloadVerdict | null {
  const v = syn?.verdict
  if (!v || !KNOWN_STATES.includes(v.state) || !Array.isArray(v.reasons)) return null
  const reasons = v.reasons.filter(
    (r: VerdictReason) => r && typeof r.elementId === 'string' && KNOWN_STATES.includes(r.state) && typeof r.text === 'string' && r.text.trim(),
  )
  return { state: v.state, reasons }
}

/** The one ordering (lib/state.ts worstState, server state.js): critical, warning, unavailable, healthy, inactive. */
const VERDICT_ORDER: Record<UiState, number> = { critical: 0, warning: 1, unavailable: 2, healthy: 3, inactive: 4 }

/** The server's `kind`. An older server sends none: an inactive reason is information, anything else is action. */
const kindOf = (reason: VerdictReason): ReasonKind => reason.kind ?? (reason.state === 'inactive' ? 'info' : 'action')

const sentence = (text: string) => sameVocabulary(text.trim().replace(/[.\s]+$/, ''))

/**
 * The page's one verdict. It is the payload's `verdict { state, reasons[] }`,
 * which the Operations overview and the top-bar signal carry unchanged: this
 * function formats it and never decides. The one thing it adds is the reading's
 * age: a healthy verdict on a stale reading is shown as caution, the same rule
 * the top bar applies, so the two cannot disagree.
 */
export function deriveVerdict(
  syn: Pick<GBrainSynoptic, 'verdict'> & Partial<Pick<GBrainSynoptic, 'readers'>> | null | undefined,
  meta: Meta | null,
): Verdict {
  if (!syn) return { state: 'unavailable', text: 'GBrain could not be read', conditions: [], caveat: null }
  const payload = readPayloadVerdict(syn)
  if (!payload) return { state: 'unavailable', text: 'GBrain did not report a verdict', conditions: [], caveat: null }
  // Readers read from configuration only: a normal verdict must say they were not observed.
  const configOnly = (syn.readers ?? []).some((reader) => reader.observation === 'configured')
  const caveat = configOnly ? "reader connections can't be read from this machine" : null
  const conditions: Condition[] = payload.reasons
    .map((reason, index) => ({ condition: { id: reason.elementId, state: reason.state, text: sentence(reason.text), kind: kindOf(reason) }, index }))
    // At equal severity something to act on leads: the headline is the first one.
    .sort((a, b) => VERDICT_ORDER[a.condition.state] - VERDICT_ORDER[b.condition.state]
      || Number(a.condition.kind === 'info') - Number(b.condition.kind === 'info') || a.index - b.index)
    .map(({ condition }) => condition)
  const attention = conditions.filter((condition) => condition.state !== 'inactive')
  const first = attention[0]
  if (!first) {
    if (payload.state === 'healthy' || payload.state === 'inactive') {
      return meta?.stale
        ? { state: 'warning', text: 'GBrain needs attention: the last reading is stale', conditions, caveat: null }
        : { state: payload.state, text: 'GBrain is normal', conditions, caveat }
    }
    const generic = payload.state === 'unavailable' ? 'GBrain readings are incomplete' : 'GBrain needs attention'
    return { state: payload.state, text: generic, conditions, caveat: null }
  }
  const more = attention.length - 1
  const suffix = more > 0 ? ` (and ${more} more)` : ''
  const lead = payload.state === 'unavailable' ? 'GBrain readings are incomplete' : 'GBrain needs attention'
  return { state: payload.state, text: `${lead}: ${first.text}${suffix}`, conditions, caveat: null }
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
  // One word for a source that is switched off, whatever the reason the backend gives.
  const off = items.filter(isSyncOff).length
  const parts: string[] = []
  if (stale > 0) parts.push(`${stale} stale`)
  if (unread > 0) parts.push(`${unread} not read`)
  if (off > 0) parts.push(`${off} sync off`)
  const considered = groups.filter((group) => group.state !== 'inactive').map((group) => group.state)
  return {
    value: `${fresh} of ${items.length}`,
    state: considered.length ? worstState(considered) : 'inactive',
    hint: parts.length ? parts.join(' · ') : 'all fresh',
  }
}

/**
 * A reading's colour may not claim more than the verdict does. The verdict is the
 * only judgment; a figure can still be shown, but a healthy verdict never sits
 * beside a lit tile, and a warning verdict never sits beside a critical one.
 * "Not read" is not an alarm and is kept.
 */
export function alignWithVerdict(state: UiState, verdictState: UiState): UiState {
  // An unavailable verdict means no observed warning or critical outranked it: a tile keeps its own state.
  if (verdictState === 'unavailable') return state
  if (state === 'critical' && verdictState !== 'critical') {
    return verdictState === 'warning' ? 'warning' : 'healthy'
  }
  if (state === 'warning' && (verdictState === 'healthy' || verdictState === 'inactive')) return 'healthy'
  return state
}

export function deriveReadings(
  syn: GBrainSynoptic,
  model: BrainModel,
  health: HealthReading | null | undefined,
  verdictState: UiState,
): ReadingSet {
  const link = deriveLinkExtraction(health)
  const q = syn.queue
  const sync = deriveSourceSync(syn.sources)
  return {
    quality: { value: syn.core.quality?.value ?? null, state: alignWithVerdict(stateOf(syn.core.quality), verdictState) },
    sourceSync: { ...sync, state: alignWithVerdict(sync.state, verdictState) },
    // The only reading that comes from a second endpoint (health): its figure is shown, its colour follows the verdict.
    linkExtraction: { value: link.value, unit: link.unit, state: alignWithVerdict(link.state, verdictState), hint: LINK_EXTRACTION_HINT },
    queue: {
      value: q.waiting?.value ?? null,
      state: alignWithVerdict(model.states[QUEUE_ID] ?? q.state, verdictState),
      hint: `${fmtCount(q.active?.value)} active · ${fmtCount(q.stalled?.value)} stalled`,
    },
  }
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
  /** The sync word for the row (`syncWord`): "fresh", "sync off", "warning"… */
  word: string
  lastSyncAt: string | null
  note: string | null
}

export interface ElementDetail {
  id: string
  title: string
  state: UiState
  /** The word shown with the state ("configured" for a reader that was only read from configuration). */
  stateWord: string | null
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

/** Which payload verdict reasons are about a block (by the element ids the server uses). */
export function reasonsForBlock(blockId: string, syn: GBrainSynoptic): VerdictReason[] {
  const reasons = readPayloadVerdict(syn)?.reasons ?? []
  const coreReasons = new Set(['gbrain-core', 'embed-job-probe', 'missing-embeddings', 'stale-pages'])
  const mine = (elementId: string): boolean => {
    if (blockId === CORE_ID) return coreReasons.has(elementId) || (elementId.startsWith('gbrain.') && elementId !== 'gbrain.sources')
    if (blockId === QUEUE_ID) return elementId === 'queue'
    if (blockId.startsWith('group:')) {
      const group = syn.sources.find((g) => groupBlockId(g.id) === blockId)
      return Boolean(group?.items.some((item) => item.id === elementId))
    }
    return readerBlockId(elementId) === blockId
  }
  return reasons.filter((reason) => mine(reason.elementId))
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
  const notes = reasonsForBlock(blockId, syn).map((reason) => `${sentence(reason.text)}.`)
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
      .filter((item) => !isSyncOff(item))
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
      if ((item.behind ?? 0) > 0) parts.push(`${fmtCount(item.behind)} behind`)
      if (record?.pages != null) parts.push(`${fmtCount(record.pages)} pages`)
      // A reason other than the switched-off one ("never synced") is the server's own explanation.
      if (!isSyncOff(item) && item.reason) parts.push(item.reason)
      items.push({
        id: item.id,
        label: item.label,
        state: item.state,
        word: syncWord(item),
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
        label: 'Setup',
        value:
          reader.observation === 'not_configured' ? 'Not set up'
          : reader.observation === 'configured' || integration?.configured === true ? 'Set up'
          : integration?.configured === false ? 'Not set up'
          : 'not read',
        observedAt: integration?.observedAt ?? null,
        // A configuration reading carries no state colour: it is not an observed connection.
        state: block.neutral ? undefined : (integration?.state ?? 'unavailable'),
      },
      { label: 'Read from', value: integration?.evidence || '—' },
    )
    if (block.neutral) {
      rows.push({ label: 'Connection', value: "Can't be read from this machine" })
    }
  }

  if (edge) {
    rows.unshift({ label: 'Line', value: edge.label, mono: true, state: edge.state })
  }

  return {
    id: elementId,
    title: edge ? `${block.label} to GBrain core` : block.label,
    state: edge ? edge.state : block.state,
    stateWord: (edge ? edge.neutral : block.neutral) ? block.sub : null,
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
  kind: ReasonKind
}

export interface NoteGroups {
  /** Warning, critical and unread readings, most severe first. */
  action: NoteLine[]
  /** For information only: sync-off sources, set-up readers, reading limitations. Never coloured as a fault. */
  info: NoteLine[]
}

/**
 * Current notes, split the way the server split them (`kind`): what needs action, and what is only
 * for information. Deduplicated, plain words. The page never decides which is which.
 */
export function currentNotes(verdict: Verdict, caveats: readonly string[] = []): NoteGroups {
  const lines: NoteLine[] = verdict.conditions.map((condition) => ({
    id: `condition:${condition.id}`,
    state: condition.state,
    text: `${startSentence(condition.text)}.`,
    kind: condition.kind,
  }))
  const seen = new Set(lines.map((line) => line.text.toLowerCase()))
  for (const caveat of caveats) {
    const text = plainWords(caveat.trim())
    if (!text || seen.has(text.toLowerCase())) continue
    seen.add(text.toLowerCase())
    lines.push({ id: `note:${text}`, state: 'warning', text, kind: 'action' })
  }
  return { action: lines.filter((line) => line.kind === 'action'), info: lines.filter((line) => line.kind === 'info') }
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

/**
 * The incident ledger joins its parts with " / " and writes the queue as "queue 14 / 2 / 0", which is
 * waiting / active / stalled (the overview's own queue value). Say the parts out; a part whose meaning
 * is not certain keeps its label.
 */
function incidentParts(body: string): string {
  const raw = body.split(' / ').map((part) => part.trim()).filter(Boolean)
  const parts: string[] = []
  for (let i = 0; i < raw.length; i += 1) {
    const queue = raw[i].match(/^queue (\d+)$/i)
    if (queue && /^\d+$/.test(raw[i + 1] ?? '') && /^\d+$/.test(raw[i + 2] ?? '')) {
      parts.push(`queue: ${queue[1]} waiting, ${raw[i + 1]} active, ${raw[i + 2]} stalled`)
      i += 2
    } else {
      parts.push(plainWords(raw[i]))
    }
  }
  return parts.join(' · ')
}

/** Split "1,433 missing embeddings / 3 caveats at 2026-…Z." into plain parts and the time it happened. */
export function describeIncident(banner: IncidentBanner): { text: string; at: string | null } {
  const match = banner.detail.match(/^(.*?)\s+at\s+(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\.?$/)
  if (!match) return { text: incidentParts(banner.detail), at: null }
  return { text: incidentParts(match[1]), at: match[2] }
}

export interface RecoveredLine {
  key: string
  text: string
  at: string | null
}

/** Recovered problems for display: plain parts, newest first (entries without a time last, in ledger order). */
export function recoveredLines(recovered: ReadonlyArray<{ key: string; banner: IncidentBanner }>): RecoveredLine[] {
  const time = (at: string | null) => (at === null ? Number.NEGATIVE_INFINITY : Date.parse(at))
  return recovered
    .map(({ key, banner }, index) => ({ line: { key, ...describeIncident(banner) }, index }))
    .sort((a, b) => time(b.line.at) - time(a.line.at) || a.index - b.index)
    .map(({ line }) => line)
}

// ---- recent readings ----

export interface ReadingRow {
  id: string
  /** When the newest reading in this row was recorded. */
  at: string
  /** The state recorded at that time. It is history: the current state is the verdict, never this. */
  state: UiState
  /** The recorded state as a word. */
  stateWord: string
  quality: string
  headline: string
  /** How many consecutive readings this row stands for (they differ only by an age ticking up). */
  count: number
  /** When the oldest of those readings was recorded; null for a single reading. */
  since: string | null
  /** Set on the newest row only when it disagrees with the current reading, and says how. */
  note: string | null
}

/** The current reading the history is compared with: the verdict state and when it was read. */
export interface CurrentReading {
  state: UiState
  observedAt: string | null
}

const MAX_CHANGES = 3

const CLOCK = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false })
const DAY = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' })

/** "12:01" in local time, with the date first when it is not the same day as `reference`. Missing input stays "—". */
export function fmtClock(at: string | null | undefined, reference?: string | null): string {
  const time = at ? Date.parse(at) : Number.NaN
  if (!Number.isFinite(time)) return '—'
  const date = new Date(time)
  const ref = reference ? Date.parse(reference) : Number.NaN
  const sameDay = Number.isFinite(ref) && DAY.format(date) === DAY.format(new Date(ref))
  return sameDay || !Number.isFinite(ref) ? CLOCK.format(date) : `${DAY.format(date)}, ${CLOCK.format(date)}`
}

/**
 * The state a ledger entry recorded: the shared verdict captured with it, else its trust status
 * (older entries). The server already reports a former "GBrain unavailable" entry as unavailable,
 * so no label text is read. An unknown or missing state is "unavailable", never healthy.
 */
export function ledgerState(entry: Pick<TimelineEntry, 'trust'> & Partial<Pick<TimelineEntry, 'verdict'>>): UiState {
  return toUiState(entry.verdict?.state ?? entry.trust?.status)
}

/**
 * A ledger entry whose optional sections are missing still reads; the missing parts are "not read".
 * The recorded state is normalised here once (see `ledgerState`), so every line speaks the same words.
 */
function completeEntry(entry: TimelineEntry): TimelineEntry {
  const trust = entry.trust ?? { label: '', status: 'unavailable' as const, score: null }
  return {
    ...entry,
    trust: { ...trust, status: ledgerState({ trust, verdict: entry.verdict }) },
    metrics: entry.metrics ?? {},
    sourceFreshness: entry.sourceFreshness ?? { status: 'inactive' },
    warnings: entry.warnings ?? [],
  }
}

const RECORDED_WORD: Record<UiState, string> = {
  healthy: 'normal',
  warning: 'warning',
  critical: 'critical',
  unavailable: 'unavailable',
  inactive: 'inactive',
}

const SIGNATURE_KEYS = [
  'health',
  'embeddings',
  'queue',
  'caveats',
  'bridge',
  'missingEmbeddings',
  'missingEmbeddingsOverdue',
  'stalePages',
  'stalePagesOverdue',
  'stalePagesCatchingUp',
] as const

/** Everything an entry records except ages that grow by themselves ("oldest 12m"). Equal signatures are one row. */
function stableSignature(entry: TimelineEntry): string {
  const detail = entry.metrics.embeddingsDetail
  return JSON.stringify([
    ledgerState(entry),
    (entry.verdict?.reasons ?? []).map((reason) => `${reason.elementId}:${reason.state}`),
    entry.trust?.score ?? null,
    entry.sourceFreshness.status,
    typeof detail === 'string' ? detail.replace(/\s*\(oldest [^)]*\)/gi, '').trim() : null,
    ...SIGNATURE_KEYS.map((key) => entry.metrics[key] ?? null),
    entry.warnings,
  ])
}

function recordedQuality(entry: TimelineEntry): string {
  const health = entry.metrics.health
  // The ledger writes "Unavailable" where the health probe could not be read: that is "not read", said once.
  if (typeof health === 'string' && /^unavailable$/i.test(health.trim())) return 'not read'
  if (typeof health === 'string' && health) return health
  const score = entry.trust?.score
  return typeof score === 'number' ? `${score}/100` : 'not read'
}

function relationNote(at: string, current: CurrentReading): string {
  const then = Date.parse(at)
  const now = current.observedAt ? Date.parse(current.observedAt) : Number.NaN
  if (!Number.isFinite(then) || !Number.isFinite(now)) return 'Differs from the current reading'
  return then < now ? 'Older than the current reading' : 'Newer than the current reading'
}

/**
 * The history list: newest first, each row the state recorded at that time. Consecutive readings that
 * differ only by an age ticking up are one row with a count. The newest row either agrees with the
 * current verdict or says that it does not (and whether it is older or newer than the current reading).
 */
export function recentReadings(
  entries: readonly TimelineEntry[] | null | undefined,
  limit = 6,
  current?: CurrentReading | null,
): ReadingRow[] {
  if (!entries) return []
  const complete = entries.map(completeEntry)
  const signatures = complete.map(stableSignature)
  const rows: ReadingRow[] = []
  for (let first = 0; first < complete.length && rows.length < limit; ) {
    let last = first
    while (last + 1 < complete.length && signatures[last + 1] === signatures[first]) last += 1
    const entry = complete[first]
    const before = complete[last + 1]
    const changes = before ? timelineDeltaLines(complete[last], before, { withAge: false }) : []
    const state = ledgerState(entry)
    rows.push({
      id: entry.id,
      at: entry.capturedAt,
      state,
      stateWord: RECORDED_WORD[state],
      quality: recordedQuality(entry),
      headline: changes.length
        ? `${changes.slice(0, MAX_CHANGES).join(' · ')}${changes.length > MAX_CHANGES ? ` · +${changes.length - MAX_CHANGES} more` : ''}`
        : before ? 'Minor details changed' : 'Earliest reading shown',
      count: last - first + 1,
      since: last > first ? complete[last].capturedAt : null,
      note: null,
    })
    first = last + 1
  }
  const newest = rows[0]
  if (newest && current && newest.state !== current.state) newest.note = relationNote(newest.at, current)
  return rows
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

// ---- lookups that can be busy or unavailable ----

export interface LookupFailure {
  kind: 'busy' | 'unavailable' | 'error'
  title: string
  message: string
}

/**
 * What to say when a brain lookup (search, page read) fails. A lookup runs a
 * bounded command on request: when the queue is full the server answers 429 with
 * a Retry-After, which is "busy, try again", not a failure of the brain; 503 is
 * "not available" (the envelope has `data: null`); anything else is an error.
 */
export function describeLookupFailure(error: unknown, subject: 'Search' | 'This page'): LookupFailure {
  if (isBusyError(error)) {
    return { kind: 'busy', title: `${subject === 'Search' ? 'Search' : 'The page'} is busy`, message: describeApiError(error) }
  }
  if (isUnavailableError(error)) {
    return {
      kind: 'unavailable',
      title: `${subject} is not available`,
      message: describeApiError(error, 'GBrain is not available right now.'),
    }
  }
  return {
    kind: 'error',
    title: subject === 'Search' ? 'Search could not be read' : 'This page could not be read',
    message: error ? describeApiError(error, 'GBrain did not return a result.') : 'GBrain did not return a result.',
  }
}

// ---- confirmation ----

/** The confirm button says what will happen in plain words. Anything not listed uses the action's own verb label. */
const CONFIRM_LABEL: Record<string, string> = {
  'sync-sources': 'Run sync',
  'retry-failed-sync': 'Retry syncs',
  'embed-stale': 'Embed chunks',
  'embed-missing': 'Run backfill',
}

export const confirmLabel = (action: { id: string; label: string }): string => CONFIRM_LABEL[action.id] ?? action.label
