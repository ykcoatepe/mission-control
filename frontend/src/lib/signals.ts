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

// ---- attention pill ----

export interface AttentionPill {
  count: number
  state: UiState
  text: string
}

/**
 * "N need attention", from the attention signal and the manager-loop overdue
 * confirmations. Null (hide the pill) at zero or when neither was read.
 */
export function attentionPill(signals: SignalsData | null | undefined): AttentionPill | null {
  if (!signals) return null
  const attention = countOrNull(signals.attention?.count)
  const overdue = countOrNull(signals.loops?.overdueConfirmations)
  if (attention === null && overdue === null) return null
  // Overdue confirmations are part of the attention count; never add them twice.
  const count = Math.max(attention ?? 0, overdue ?? 0)
  if (count === 0) return null
  const states: UiState[] = []
  if (signals.attention?.worst) states.push(toUiState(signals.attention.worst))
  if (overdue !== null && overdue > 0) states.push('critical')
  // Something needs attention but nothing says how bad: caution, not an alarm.
  const worst = states.length > 0 ? worstState(states) : 'warning'
  const state: UiState = worst === 'healthy' || worst === 'inactive' || worst === 'unavailable' ? 'warning' : worst
  return { count, state, text: count === 1 ? '1 needs attention' : `${count} need attention` }
}

// ---- sidebar badges ----

export interface NavBadge {
  count: number
  tone: 'warning' | 'critical'
  /** Spoken after the label: "3 failed". */
  word: string
}

/** Abnormal-only counts by route path. A path with no entry shows no badge. */
export function navBadges(signals: SignalsData | null | undefined): Record<string, NavBadge | undefined> {
  const badges: Record<string, NavBadge | undefined> = {}
  if (!signals) return badges

  const failed = countOrNull(signals.automations?.failed)
  if (failed !== null && failed > 0) badges['/automations'] = { count: failed, tone: 'critical', word: 'failed' }

  const overdue = countOrNull(signals.loops?.overdueConfirmations)
  const open = countOrNull(signals.attention?.count)
  if (overdue !== null && overdue > 0) {
    badges['/attention'] = { count: overdue, tone: 'critical', word: 'overdue' }
  } else if (open !== null && open > 0) {
    badges['/attention'] = { count: open, tone: 'warning', word: 'open' }
  }

  const down = countOrNull(signals.services?.down)
  if (down !== null && down > 0) badges['/services'] = { count: down, tone: 'critical', word: 'down' }

  return badges
}
