import { stateLabel, toUiState, worstState } from './state'
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
}

export interface SignalsData {
  generatedAt?: string
  systems: Partial<Record<SystemId, SystemSignal | null>> | null
  attention: { count: number | null; worst: string | null } | null
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

/** Where each annunciator links. Gateways are read on the Services page. */
export const SYSTEM_HREF: Record<SystemId, string> = {
  gbrain: '/',
  hermes: '/services',
  openclaw: '/services',
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
}

export interface AnnunciatorOptions {
  /** The first request has not completed. */
  loading: boolean
  /** Current time in ms (from `useNow`); keeps this function pure. */
  now: number
  /** meta.stale, or the latest request failed. */
  stale: boolean
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
    const base = { id, label: SYSTEM_LABEL[id], href: SYSTEM_HREF[id] }
    if (!signals) {
      // Nothing yet: still loading, or the request failed with nothing to show.
      return options.loading
        ? { ...base, state: 'reading' as const, word: 'reading…', lit: true }
        : { ...base, state: NOT_READ.state, word: NOT_READ.word, lit: true }
    }
    const reading = systemReading(signals.systems?.[id], options)
    return { ...base, state: reading.state, word: reading.word, lit: reading.state !== 'healthy' }
  })
}

// ---- attention (one number, three places) ----

/**
 * The one definition of "needs attention": `signals.attention.count`, the items
 * that need the operator (system warnings plus manager-loop findings rated
 * warning or error; info is left out). The top-bar pill, the sidebar badge and
 * the Attention page summary all show exactly this number with these words.
 * Overdue confirmations are a sub-count, shown as secondary text and never added.
 */
export interface AttentionReading {
  /** Items that need the operator; null when the shell signal could not read it. */
  count: number | null
  /** Overdue confirmations (secondary); null when not read. */
  overdue: number | null
  state: UiState
}

export function attentionReading(signals: SignalsData | null | undefined): AttentionReading | null {
  if (!signals) return null
  const count = countOrNull(signals.attention?.count)
  const overdue = countOrNull(signals.loops?.overdueConfirmations)
  if (count === null && overdue === null) return null
  const states: UiState[] = []
  if (signals.attention?.worst) states.push(toUiState(signals.attention.worst))
  if (overdue !== null && overdue > 0) states.push('critical')
  // Something needs attention but nothing says how bad: caution, not an alarm.
  const worst = states.length > 0 ? worstState(states) : 'warning'
  const state: UiState = worst === 'healthy' || worst === 'inactive' || worst === 'unavailable' ? 'warning' : worst
  return { count, overdue, state }
}

/** "30 need attention", "1 needs attention". */
export function attentionWords(count: number): string {
  return count === 1 ? '1 needs attention' : `${count} need attention`
}

/** "24 overdue" for the secondary text; null when there is none to mention. */
export function overdueWords(overdue: number | null): string | null {
  return overdue !== null && overdue > 0 ? `${overdue} overdue` : null
}

export interface AttentionPill {
  count: number
  state: UiState
  /** The pill's words: "30 need attention". */
  text: string
  /** Secondary text: "24 overdue", or null. */
  secondary: string | null
}

/**
 * The top-bar pill. Hidden when nothing needs attention or nothing was read.
 * Only when the attention count itself was not read but overdue confirmations
 * were, the pill says so in its own words ("24 overdue") instead of borrowing
 * the attention wording for a different number.
 */
export function attentionPill(signals: SignalsData | null | undefined): AttentionPill | null {
  const reading = attentionReading(signals)
  if (!reading) return null
  if (reading.count === null) {
    const overdue = reading.overdue ?? 0
    return overdue > 0 ? { count: overdue, state: 'critical', text: `${overdue} overdue`, secondary: null } : null
  }
  if (reading.count === 0) return null
  return {
    count: reading.count,
    state: reading.state,
    text: attentionWords(reading.count),
    secondary: overdueWords(reading.overdue),
  }
}

// ---- sidebar badges ----

export interface NavBadge {
  count: number
  tone: 'warning' | 'critical'
  /** Spoken after the count: "need attention", "failed". */
  word: string
  /** Secondary text for the tooltip, e.g. "24 overdue". */
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
