import { canStartGBrainAction, resolveGBrainAction } from '../gbrain/actionPolicy'
import type { GBrainActionResult } from '../gbrain/types'
import type { ActionStatus, OperationCapability, TimelineReading } from './types'

export type ActionStartMode = 'direct' | 'confirmed'

export function resolvePendingActionResult(error: unknown): GBrainActionResult | null {
  const payload = (error as { payload?: GBrainActionResult } | null)?.payload
  return payload?.pending === true ? payload : null
}

type ActionSuccessResult = {
  refreshAfter?: boolean
  summary?: string
}

export function resolveActionSuccessPolicy(result: ActionSuccessResult): {
  shouldRefreshReading: boolean
  status: ActionStatus
} {
  const summary = result.summary || 'Action completed'
  if (result.refreshAfter !== true) {
    return {
      shouldRefreshReading: false,
      status: { state: 'complete', message: summary },
    }
  }

  return {
    shouldRefreshReading: true,
    status: {
      state: 'verifying',
      message: `${summary} · waiting for a newer reading`,
    },
  }
}

/** A reading counts as newer only when it is fresh, valid and later than the one before the action. */
export function hasFreshReadingAdvanced(
  previousObservedAt: string | null,
  next: { observedAt: string | null; fresh: boolean } | null | undefined,
) {
  if (!next?.observedAt || !next.fresh) return false

  const nextTime = Date.parse(next.observedAt)
  if (!Number.isFinite(nextTime)) return false
  if (!previousObservedAt) return true
  if (next.observedAt === previousObservedAt) return false

  const previousTime = Date.parse(previousObservedAt)
  return Number.isFinite(previousTime) && nextTime > previousTime
}

export function canStartAction(
  capability: OperationCapability,
  mode: ActionStartMode,
  activeActionId: string | null,
) {
  return canStartGBrainAction(capability, mode, activeActionId)
}

/** The current catalog decides: a confirmed Change must still be an enabled, confirm-required W1. */
export function resolveCurrentConfirmedW1(
  capabilities: OperationCapability[],
  requestedActionId: string,
) {
  return resolveGBrainAction(capabilities, requestedActionId, 'confirmed', null)
}

export type TimelineState = 'ready' | 'stale' | 'loading' | 'unavailable'

/**
 * The readings ledger as the page may show it. The server answers an unreadable
 * ledger with 503 (and a payload with `entries: null` when it was never read):
 * both are "unavailable", never an empty list. A ledger that was read and then
 * failed to refresh is shown, marked stale.
 */
export function resolveTimeline(input: {
  data: TimelineReading | null
  failed: boolean
  loading: boolean
}): { reading: TimelineReading | null; state: TimelineState } {
  const { data, failed, loading } = input
  if (data && data.entries !== null) {
    return { reading: data, state: data.meta?.stale || failed ? 'stale' : 'ready' }
  }
  return { reading: null, state: loading && !failed ? 'loading' : 'unavailable' }
}
