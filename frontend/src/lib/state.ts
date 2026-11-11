/**
 * One state vocabulary for the whole app (docs/reference-design-system.md, section 3).
 *
 * Every legacy status word maps onto one of five states. Unknown input maps to
 * `unavailable`: absence of evidence is never rendered as healthy or as "off".
 */
export type UiState = 'healthy' | 'warning' | 'critical' | 'unavailable' | 'inactive'

export const UI_STATES: readonly UiState[] = [
  'healthy',
  'warning',
  'critical',
  'unavailable',
  'inactive',
]

const STATE_BY_WORD = new Map<string, UiState>([
  // healthy
  ['ok', 'healthy'],
  ['active', 'healthy'],
  ['running', 'healthy'],
  ['success', 'healthy'],
  ['succeeded', 'healthy'],
  ['done', 'healthy'],
  ['connected', 'healthy'],
  ['healthy', 'healthy'],
  ['fresh', 'healthy'],
  ['green', 'healthy'],
  // warning
  ['warning', 'warning'],
  ['warn', 'warning'],
  ['stale', 'warning'],
  ['degraded', 'warning'],
  ['paused-by-error', 'warning'],
  ['blocked', 'warning'],
  ['overdue', 'warning'],
  ['yellow', 'warning'],
  // critical
  ['failed', 'critical'],
  ['failure', 'critical'],
  ['error', 'critical'],
  ['errored', 'critical'],
  ['critical', 'critical'],
  ['down', 'critical'],
  ['red', 'critical'],
  // unavailable
  ['unavailable', 'unavailable'],
  ['unknown', 'unavailable'],
  ['no-data', 'unavailable'],
  ['gray', 'unavailable'],
  ['grey', 'unavailable'],
  // inactive
  ['disabled', 'inactive'],
  ['paused', 'inactive'],
  ['off', 'inactive'],
  ['idle', 'inactive'],
  ['inactive', 'inactive'],
  ['archived', 'inactive'],
])

/** Map any legacy status word (case, spaces and underscores ignored) to a `UiState`. */
export function toUiState(raw: unknown): UiState {
  if (typeof raw !== 'string') return 'unavailable'
  const key = raw.trim().toLowerCase().replace(/[\s_]+/g, '-')
  return STATE_BY_WORD.get(key) ?? 'unavailable'
}

const LABELS: Record<UiState, string> = {
  healthy: 'Healthy',
  warning: 'Warning',
  critical: 'Critical',
  unavailable: 'Unavailable',
  inactive: 'Inactive',
}

/** The word shown next to a state dot. State is never colour alone. */
export function stateLabel(state: UiState): string {
  return LABELS[state]
}

// Higher rank = worse. Unavailable outranks healthy: an unread system is not a good one.
const SEVERITY: Record<UiState, number> = {
  critical: 4,
  warning: 3,
  unavailable: 2,
  healthy: 1,
  inactive: 0,
}

/**
 * The state to show for a group: critical > warning > unavailable > healthy > inactive.
 * An empty list means nothing was read, so it is `unavailable`.
 */
export function worstState(states: readonly UiState[]): UiState {
  if (states.length === 0) return 'unavailable'
  let worst = states[0]
  for (const state of states) {
    if (SEVERITY[state] > SEVERITY[worst]) worst = state
  }
  return worst
}
