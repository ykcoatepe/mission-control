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
