import type { OperationsOverview } from '../pages/brain/types'

/** Number of blocked Hermes tasks, only when the overview really reports one. */
export function blockedCount(overview: Pick<OperationsOverview, 'systems'> | null | undefined): number | null {
  const blocked = overview?.systems?.hermes?.metrics?.blocked
  return typeof blocked === 'number' && Number.isFinite(blocked) ? blocked : null
}
