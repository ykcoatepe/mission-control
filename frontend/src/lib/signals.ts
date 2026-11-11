import { stateLabel, toUiState } from './state'
import type { UiState } from './state'
import { parseTime } from './time'

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
 */
export interface AttentionBreakdown {
  systems: number | null
  findings: number | null
  overdueConfirmations: number | null
  restricted: number | null
}

export interface AttentionSignal {
  count: number | null
  worst: string | null
  breakdown?: AttentionBreakdown | null
}

export interface SignalsData {
  generatedAt?: string
  systems: Partial<Record<SystemId, SystemSignal | null>> | null
  attention: AttentionSignal | null
  automations: { failed: number | null; nextRunAt: string | null } | null
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
  /** Always set: "reading…", "healthy", "stale", "not read", "critical"… */
  word: string
  /** Show the word next to the name (everything except a plain healthy system). */
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
      reason: reading.state !== 'healthy' && typeof reason === 'string' && reason.trim() ? reason.trim() : null,
    }
  })
}

// ---- attention (one number, three places) ----

/**
 * The one definition of "needs attention": `signals.attention.count`, computed by
 * the server (system attention items, manager-loop findings rated warning or
 * error, overdue confirmations, restricted projects by count). The top-bar pill,
 * the sidebar badge and the Attention page summary all show exactly this number;
 * nothing here adds or compares counts. The breakdown is secondary text.
 */
export interface AttentionReading {
  /** Items that need the operator; null when the server could not read it. */
  count: number | null
  /** The parts of the count; a part the server did not read is null. */
  breakdown: AttentionBreakdown | null
  state: UiState
}

function breakdownOf(raw: AttentionBreakdown | null | undefined): AttentionBreakdown | null {
  if (!raw || typeof raw !== 'object') return null
  return {
    systems: countOrNull(raw.systems),
    findings: countOrNull(raw.findings),
    overdueConfirmations: countOrNull(raw.overdueConfirmations),
    restricted: countOrNull(raw.restricted),
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
  return { count, breakdown, state: readingState(attention.worst) }
}

export function attentionReading(signals: SignalsData | null | undefined): AttentionReading | null {
  return signals ? attentionFrom(signals.attention) : null
}

/** "30 need attention", "1 needs attention". */
export function attentionWords(count: number): string {
  return count === 1 ? '1 needs attention' : `${count} need attention`
}

const PART_WORDS: ReadonlyArray<readonly [keyof AttentionBreakdown, (n: number) => string, string]> = [
  ['systems', (n) => `${n} ${n === 1 ? 'system' : 'systems'}`, 'systems not read'],
  ['findings', (n) => `${n} ${n === 1 ? 'finding' : 'findings'}`, 'findings not read'],
  ['overdueConfirmations', (n) => `${n} overdue`, 'overdue not read'],
  ['restricted', (n) => `${n} restricted`, 'restricted not read'],
]

/**
 * "3 systems · 23 findings · 3 overdue · 129 restricted" for secondary text.
 * A part that is zero is left out; a part that was not read says so (never "0").
 * null when there is no breakdown or nothing to mention.
 */
export function breakdownWords(breakdown: AttentionBreakdown | null | undefined): string | null {
  if (!breakdown) return null
  const parts: string[] = []
  for (const [key, words, unread] of PART_WORDS) {
    const value = breakdown[key]
    if (value === null) parts.push(unread)
    else if (value > 0) parts.push(words(value))
  }
  return parts.length > 0 ? parts.join(' · ') : null
}

export interface AttentionPill {
  count: number
  state: UiState
  /** The pill's words: "30 need attention". */
  text: string
  /** Secondary text: the breakdown, or null. */
  secondary: string | null
}

/** The top-bar pill. Hidden when nothing needs attention or the count was not read. */
export function attentionPill(signals: SignalsData | null | undefined): AttentionPill | null {
  const reading = attentionReading(signals)
  if (!reading || reading.count === null || reading.count === 0) return null
  return {
    count: reading.count,
    state: reading.state,
    text: attentionWords(reading.count),
    secondary: breakdownWords(reading.breakdown),
  }
}

// ---- sidebar badges ----

export interface NavBadge {
  count: number
  tone: 'warning' | 'critical'
  /** Spoken after the count: "need attention", "failed". */
  word: string
  /** Secondary text for the tooltip: the breakdown of the count. */
  secondary?: string | null
}

/** Abnormal-only counts by route path. A path with no entry shows no badge. */
export function navBadges(signals: SignalsData | null | undefined): Record<string, NavBadge | undefined> {
  const badges: Record<string, NavBadge | undefined> = {}
  if (!signals) return badges

  const failed = countOrNull(signals.automations?.failed)
  if (failed !== null && failed > 0) badges['/automations'] = { count: failed, tone: 'critical', word: 'failed' }

  // The same number and words as the top-bar pill.
  const pill = attentionPill(signals)
  if (pill) {
    const tone = pill.state === 'critical' ? 'critical' : 'warning'
    badges['/attention'] = {
      count: pill.count,
      tone,
      word: pill.text.replace(/^\d+ /, ''),
      secondary: pill.secondary,
    }
  }

  const down = countOrNull(signals.services?.down)
  if (down !== null && down > 0) badges['/services'] = { count: down, tone: 'critical', word: 'down' }

  return badges
}
