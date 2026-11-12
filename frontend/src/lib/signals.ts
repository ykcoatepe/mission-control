import { stateLabel, toUiState } from './state'
import type { UiState } from './state'
import { formatRelative, parseTime } from './time'

/**
 * The shell's small readings: `GET /api/signals` (docs/explanation-backend-redesign.md).
 * Every derivation here is pure. A part the server could not observe is `null`
 * and stays "not read": it never becomes 0, never becomes healthy, never an alarm.
 */

export const SIGNALS_URL = '/api/signals'
export const SIGNALS_POLL_MS = 30_000

/** A healthy system whose own reading is older than this is lit as stale. */
export const SYSTEM_STALE_AFTER_MS = 10 * 60_000

// ---- payload ----

export interface ApiMeta {
  ok: boolean
  stale: boolean
  observedAt: string | null
  ageMs: number | null
  error: unknown
  latencyMs?: number | null
  source?: string
  sources?: Record<string, ApiMeta>
}

export interface ApiEnvelope<T> {
  data: T | null
  meta: ApiMeta
}

export type SystemId = 'gbrain' | 'hermes' | 'openclaw'

export interface SystemSignal {
  state: string
  observedAt: string | null
  /** Why the system is not healthy (one scrubbed line); null when healthy or none was given. */
  reason?: string | null
  /** Where the detail for this system lives; null when the server named none. */
  detailHref?: string | null
}

/**
 * The parts of the one attention count (server/sources/mloop/attention.js).
 * count is the sum of the parts that were read; a part that was not read is null.
 * `restricted` is information, never part of the count (the older payload still carried it here).
 */
export interface AttentionBreakdown {
  systems: number | null
  findings: number | null
  overdueConfirmations: number | null
  restricted?: number | null
}

/**
 * `GET /api/signals` -> `data.attention` (badge rule). `count` and `worst` cover NEW items only: items that are
 * actionable and neither acknowledged nor shelved. `worst` is 'healthy' when count is 0. `standing` is the
 * acknowledged plus shelved items, `restricted` the restricted-project count (information only).
 * Every field is optional so the older shape (count that included standing and restricted items) still reads.
 */
export interface AttentionSignal {
  count: number | null
  worst: string | null
  standing?: number | null
  restricted?: number | null
  breakdown?: AttentionBreakdown | null
  partial?: boolean
  missing?: string[] | null
}

export interface SignalsData {
  generatedAt?: string
  systems: Partial<Record<SystemId, SystemSignal | null>> | null
  attention: AttentionSignal | null
  /** `failed` = enabled jobs whose last run failed and that are not acknowledged or shelved; `standingFailed` = the ones that are. */
  automations: { failed: number | null; standingFailed?: number | null; nextRunAt: string | null } | null
  loops: { openFindings: number | null; overdueConfirmations: number | null } | null
  services: { down: number | null } | null
  usage: { todayUsd: number | null; budgetUsedPct: number | null } | null
}

export type SignalsEnvelope = ApiEnvelope<SignalsData>

// ---- helpers ----

/** A usable count: a finite, non-negative number. Anything else is "not read". */
export function countOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

/** True when the envelope says its data is old or the request failed after a first load. */
export function signalsStale(envelope: SignalsEnvelope | null | undefined, requestFailed: boolean): boolean {
  if (requestFailed) return true
  if (!envelope) return false
  return envelope.meta?.stale === true
}

// ---- top-bar annunciators ----

export const SYSTEM_ORDER: readonly SystemId[] = ['gbrain', 'hermes', 'openclaw']

export const SYSTEM_LABEL: Record<SystemId, string> = {
  gbrain: 'GBrain',
  hermes: 'Hermes',
  openclaw: 'OpenClaw',
}

/**
 * Where an annunciator links when the server named no usable `detailHref`
 * (null, not a local path, or a route that has been removed). Gateways are read on the Services page.
 */
export const SYSTEM_HREF: Record<SystemId, string> = {
  gbrain: '/',
  hermes: '/services',
  openclaw: '/services',
}

/** A `detailHref` is followed only when it is an in-app path (never an external URL). */
function localPath(href: unknown): string | null {
  return typeof href === 'string' && /^\/(?!\/)[^\s]*$/.test(href) ? href : null
}

export interface Annunciator {
  id: SystemId
  label: string
  href: string
  /** `reading` until the first load completes. */
  state: UiState | 'reading'
  /** Always set and always shown: "reading…", "normal", "caution", "stale", "not read", "critical"… */
  word: string
  /** Abnormal or not read: the mark and word take their state colour. A normal system stays neutral. */
  lit: boolean
  /** The server's one-line reason this system is not healthy; null when none was given. */
  reason: string | null
}

export interface AnnunciatorOptions {
  /** The first request has not completed. */
  loading: boolean
  /** Current time in ms (from `useNow`); keeps this function pure. */
  now: number
  /** meta.stale, or the latest request failed. */
  stale: boolean
  /** True for a path that is a live screen (removed screens redirect home); defaults to "any local path". */
  isLivePath?: (path: string) => boolean
}

const NOT_READ = { state: 'unavailable', word: 'not read' } as const

/** Keep the capital when a replaced word starts a sentence: "Evidence" -> "Reading". */
function matchCase(source: string, replacement: string): string {
  return source.charAt(0) === source.charAt(0).toUpperCase() && source.charAt(0) !== source.charAt(0).toLowerCase()
    ? replacement.charAt(0).toUpperCase() + replacement.slice(1)
    : replacement
}

/**
 * The server's reason for a lit system is written for engineers ("status evidence is unavailable",
 * "probe unavailable"). The tooltip says it the way an operator would (docs/reference-design-system.md, section 6):
 * evidence / proof -> reading, "probe unavailable" -> "could not be read". Everything else passes through.
 */
export function plainReason(reason: string): string {
  return reason
    .replace(/\b(status|state|health|embed-job|job)\s+(?:evidence|proof)\s+(?:is|are)\s+(?:unavailable|missing|not available)\b/gi, '$1 could not be read')
    .replace(/\bprobe\s+(?:is\s+|are\s+)?(?:unavailable|not available|missing)\b/gi, 'could not be read')
    .replace(/\b(?:evidence|proof)s?\b/gi, (word) => matchCase(word, 'reading'))
}

function systemReading(
  system: SystemSignal | null | undefined,
  { now, stale }: Pick<AnnunciatorOptions, 'now' | 'stale'>,
): { state: UiState; word: string } {
  if (!system || typeof system.state !== 'string') return { ...NOT_READ }
  const state = toUiState(system.state)
  if (state !== 'healthy') return { state, word: stateLabel(state).toLowerCase() }
  // "Healthy" needs a recent reading behind it.
  const observed = parseTime(system.observedAt)
  if (observed === null) return { ...NOT_READ }
  if (stale || now - observed > SYSTEM_STALE_AFTER_MS) return { state: 'warning', word: 'stale' }
  return { state, word: stateLabel(state).toLowerCase() }
}

export function annunciators(signals: SignalsData | null | undefined, options: AnnunciatorOptions): Annunciator[] {
  return SYSTEM_ORDER.map((id) => {
    const detail = localPath(signals?.systems?.[id]?.detailHref)
    const href = detail && (options.isLivePath ? options.isLivePath(detail) : true) ? detail : SYSTEM_HREF[id]
    const base = { id, label: SYSTEM_LABEL[id], href, reason: null as string | null }
    if (!signals) {
      // Nothing yet: still loading, or the request failed with nothing to show.
      return options.loading
        ? { ...base, state: 'reading' as const, word: 'reading…', lit: true }
        : { ...base, state: NOT_READ.state, word: NOT_READ.word, lit: true }
    }
    const reading = systemReading(signals.systems?.[id], options)
    const reason = signals.systems?.[id]?.reason
    return {
      ...base,
      state: reading.state,
      word: reading.word,
      lit: reading.state !== 'healthy',
      reason: reading.state !== 'healthy' && typeof reason === 'string' && reason.trim() ? plainReason(reason.trim()) : null,
    }
  })
}

// ---- attention (one number, three places) ----

/**
 * The one definition of "needs attention": `signals.attention.count`, computed by the server and covering
 * NEW, actionable, unacknowledged items only (the badge rule). The rail badge and the Attention page summary
 * show exactly this number; nothing here adds or compares counts. Standing items (acknowledged or shelved) and
 * restricted projects are information and never part of it. The breakdown is secondary text.
 */
export interface AttentionReading {
  /** New items that need the operator; null when the server could not read it. */
  count: number | null
  /** The parts of the count; a part the server did not read is null. */
  breakdown: AttentionBreakdown | null
  /** Acknowledged plus shelved items: listed quietly, not counted. Null when the server did not say. */
  standing: number | null
  /** Restricted-project count (information only). Null when the server did not say. */
  restricted: number | null
  state: UiState
}

function breakdownOf(raw: AttentionBreakdown | null | undefined): AttentionBreakdown | null {
  if (!raw || typeof raw !== 'object') return null
  return {
    systems: countOrNull(raw.systems),
    findings: countOrNull(raw.findings),
    overdueConfirmations: countOrNull(raw.overdueConfirmations),
    restricted: raw.restricted === undefined ? undefined : countOrNull(raw.restricted),
  }
}

function readingState(worst: string | null | undefined): UiState {
  // Something needs attention but nothing says how bad: caution, not an alarm.
  const state = worst ? toUiState(worst) : 'warning'
  return state === 'healthy' || state === 'inactive' || state === 'unavailable' ? 'warning' : state
}

/** Build the reading from the server's attention object (`signals.attention` or `loops.totals.needsOperator`). */
export function attentionFrom(attention: AttentionSignal | null | undefined): AttentionReading | null {
  if (!attention || typeof attention !== 'object') return null
  const count = countOrNull(attention.count)
  const breakdown = breakdownOf(attention.breakdown)
  if (count === null && breakdown === null) return null
  return {
    count,
    breakdown,
    standing: countOrNull(attention.standing),
    restricted: countOrNull(attention.restricted ?? breakdown?.restricted),
    state: readingState(attention.worst),
  }
}

export function attentionReading(signals: SignalsData | null | undefined): AttentionReading | null {
  return signals ? attentionFrom(signals.attention) : null
}

/** "30 need attention", "1 needs attention". */
export function attentionWords(count: number): string {
  return count === 1 ? '1 needs attention' : `${count} need attention`
}

const PART_WORDS: ReadonlyArray<readonly [keyof AttentionBreakdown, (n: number) => string, string | null]> = [
  ['systems', (n) => `${n} ${n === 1 ? 'system' : 'systems'}`, 'systems not read'],
  ['findings', (n) => `${n} ${n === 1 ? 'finding' : 'findings'}`, 'findings not read'],
  ['overdueConfirmations', (n) => `${n} overdue`, 'overdue not read'],
  ['restricted', (n) => `${n} restricted`, null],
]

/**
 * "3 systems · 23 findings · 3 overdue" for secondary text.
 * A part that is zero is left out; a counted part that was not read says so (never "0").
 * Restricted is information: mentioned only when the server sent it and it is above zero.
 * null when there is no breakdown or nothing to mention.
 */
export function breakdownWords(breakdown: AttentionBreakdown | null | undefined): string | null {
  if (!breakdown) return null
  const parts: string[] = []
  for (const [key, words, unread] of PART_WORDS) {
    const value = breakdown[key]
    if (value === null || value === undefined) {
      if (value === null && unread) parts.push(unread)
    } else if (value > 0) parts.push(words(value))
  }
  return parts.length > 0 ? parts.join(' · ') : null
}

/**
 * Signals arrived (or the request failed with nothing to show) but the attention count was not read.
 * A badge that simply vanished would read as "nothing is new", so the rail shows a hollow "not read"
 * mark instead. Still loading is not unread.
 */
export function attentionUnread(signals: SignalsData | null | undefined, options: { loading: boolean }): boolean {
  if (!signals) return !options.loading
  const reading = attentionReading(signals)
  return reading === null || reading.count === null
}

// ---- data age of the signals reading ----

export interface SignalsAge {
  /** The short visible text: "Updated 2m ago", "Reading…", "Not read". */
  text: string
  /** The tooltip. It names the signals so it does not contradict a page's own freshness. */
  title: string
}

/** The top bar's data age. It is the age of the shell signals, not of the page being shown. */
export function signalsAge(observedAt: string | null | undefined, now: number, loading: boolean): SignalsAge {
  const ms = parseTime(observedAt)
  if (ms === null) {
    return loading
      ? { text: 'Reading…', title: 'Reading the shell signals…' }
      : { text: 'Not read', title: 'The shell signals (systems, attention count) could not be read.' }
  }
  const ago = formatRelative(ms, now)
  return {
    text: `Updated ${ago}`,
    title: `Signals updated ${ago} (${new Date(ms).toLocaleString()}). This is the shell reading: the systems and the attention count. Each page shows its own freshness.`,
  }
}

// ---- sidebar badges ----

export interface NavBadge {
  count: number
  tone: 'warning' | 'critical'
  /** Spoken after the count: "need attention", "failed". The badge shows the number only. */
  word: string
}

/**
 * Rail badges (badge rule): a count of NEW, actionable, unacknowledged items, by route path.
 * Attention = `attention.count`; Automations = `automations.failed`. Restricted and standing items never
 * count. A path with no entry (a real zero, or a count that was not read) shows no badge.
 */
export function navBadges(signals: SignalsData | null | undefined): Record<string, NavBadge | undefined> {
  const badges: Record<string, NavBadge | undefined> = {}
  if (!signals) return badges

  const failed = countOrNull(signals.automations?.failed)
  if (failed !== null && failed > 0) badges['/automations'] = { count: failed, tone: 'critical', word: 'failed' }

  const reading = attentionReading(signals)
  if (reading && reading.count !== null && reading.count > 0) {
    badges['/attention'] = {
      count: reading.count,
      tone: reading.state === 'critical' ? 'critical' : 'warning',
      word: reading.count === 1 ? 'needs attention' : 'need attention',
    }
  }

  return badges
}

/**
 * Routes whose badge count could not be read. A missing badge means "nothing new", so an unread
 * count gets its own hollow mark instead of silence. Before the first load nothing is unread yet.
 */
export function navUnread(signals: SignalsData | null | undefined, options: { loading: boolean }): Record<string, true | undefined> {
  const unread: Record<string, true | undefined> = {}
  if (!signals) {
    if (options.loading) return unread
    unread['/attention'] = true
    unread['/automations'] = true
    return unread
  }
  if (attentionUnread(signals, options)) unread['/attention'] = true
  if (countOrNull(signals.automations?.failed) === null) unread['/automations'] = true
  return unread
}
