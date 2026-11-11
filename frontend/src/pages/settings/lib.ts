/** Pure rules for the Settings writes. They mirror the server's validation so a bad value never leaves the page. */

export interface Routing {
  main: string
  subagent: string
  heartbeat: string
}

export type RoutingField = keyof Routing

export const ROUTING_FIELDS: readonly RoutingField[] = ['main', 'subagent', 'heartbeat']

/** server/services/settingsData.js: a model identifier. */
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,255}$/

/**
 * The fields that differ from what the server last reported. Model routing is a
 * partial update: unchanged fields are never sent, so saving one model cannot
 * rewrite the other two (the sub-agent shown as "inherits main" stays unset).
 */
export function changedRouting(baseline: Routing, next: Routing): Partial<Routing> {
  const changed: Partial<Routing> = {}
  for (const field of ROUTING_FIELDS) {
    if (next[field] !== baseline[field]) changed[field] = next[field]
  }
  return changed
}

/**
 * Client-side check of one changed field. Only the heartbeat model may be
 * empty (it means "inherit from the main model" and unsets the setting).
 */
export function routingFieldError(field: RoutingField, value: string): string | null {
  if (field === 'heartbeat' && value === '') return null
  if (!MODEL_ID.test(value)) return 'Choose a valid model.'
  return null
}

export function routingErrors(changed: Partial<Routing>): Partial<Record<RoutingField, string>> {
  const errors: Partial<Record<RoutingField, string>> = {}
  for (const field of ROUTING_FIELDS) {
    const value = changed[field]
    if (value === undefined) continue
    const problem = routingFieldError(field, value)
    if (problem) errors[field] = problem
  }
  return errors
}

/** server: `^\d+(?:ms|s|m|h|d)$`. */
export const HEARTBEAT_INTERVAL = /^\d+(?:ms|s|m|h|d)$/

export function heartbeatError(interval: string): string | null {
  return HEARTBEAT_INTERVAL.test(interval.trim()) ? null : 'Choose a duration such as 30m or 1h.'
}

export interface HeartbeatReading {
  /** "30m", "1h"; null when none is configured. */
  interval: string | null
  /** The interval is zero: the server's "0m" turns the checks off. */
  off: boolean
  /** Plain words for the interval ("Every 30 minutes", "Every hour", "Off"); null when there is none. */
  label: string | null
}

const UNIT_WORDS: Record<string, [string, string]> = {
  ms: ['millisecond', 'milliseconds'],
  s: ['second', 'seconds'],
  m: ['minute', 'minutes'],
  h: ['hour', 'hours'],
  d: ['day', 'days'],
}

/**
 * The configured heartbeat interval in words. `null`, an empty value or anything that is not a
 * duration is "none" (never a made-up interval); a zero duration is "Off", not "Every 0 minutes".
 */
export function describeHeartbeat(value: unknown): HeartbeatReading {
  const text = typeof value === 'string' ? value.trim() : ''
  const match = /^(\d+)(ms|s|m|h|d)$/.exec(text)
  if (!match) return { interval: null, off: false, label: null }
  const amount = Number(match[1])
  const [one, many] = UNIT_WORDS[match[2]]
  if (amount === 0) return { interval: text, off: true, label: 'Off' }
  return { interval: text, off: false, label: amount === 1 ? `Every ${one}` : `Every ${amount} ${many}` }
}
