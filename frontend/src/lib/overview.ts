import type { OperationsOverview, OperationSystem } from '../pages/brain/types'
import { stateLabel, toUiState, worstState } from './state'
import type { UiState } from './state'

export interface Annunciator {
  state: UiState
  /** The word shown when lit, e.g. "unavailable", "stale". */
  word: string
}

/**
 * State of one system for the top-bar annunciator. A system that reports
 * healthy but whose reading is stale or unread is not shown as healthy.
 */
export function annunciatorFor(system: Pick<OperationSystem, 'state' | 'freshness'>): Annunciator {
  const state = toUiState(system.state)
  if (state !== 'healthy') return { state, word: stateLabel(state).toLowerCase() }
  if (system.freshness === 'stale') return { state: 'warning', word: 'stale' }
  if (system.freshness === 'unknown' || system.freshness === 'unavailable') {
    return { state: 'unavailable', word: 'not read' }
  }
  return { state, word: stateLabel(state).toLowerCase() }
}

export interface AttentionSummary {
  count: number
  state: UiState
}

/** How many items need attention, and how bad the worst one is. Null when nothing was read. */
export function attentionSummary(overview: Pick<OperationsOverview, 'attention'> | null | undefined): AttentionSummary | null {
  if (!overview || !Array.isArray(overview.attention)) return null
  const count = overview.attention.length
  return { count, state: worstState(overview.attention.map((item) => toUiState(item.severity))) }
}

/** Number of blocked Hermes tasks, only when the overview really reports one. */
export function blockedCount(overview: Pick<OperationsOverview, 'systems'> | null | undefined): number | null {
  const blocked = overview?.systems?.hermes?.metrics?.blocked
  return typeof blocked === 'number' && Number.isFinite(blocked) ? blocked : null
}
