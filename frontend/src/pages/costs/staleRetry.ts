// Polling policy for the Usage page's detailed-cost query. Pure: the page keeps
// the returned state in a ref and feeds it back on the next poll.

import type { TokenData } from './types'

export const STALE_COSTS_RETRY_INTERVAL_MS = 2500
export const STALE_COSTS_RETRY_LIMIT = 60
export const STALE_COSTS_RETRY_TIMEOUT_MS = STALE_COSTS_RETRY_INTERVAL_MS * STALE_COSTS_RETRY_LIMIT
// A queued month can wait behind other scans for longer than the normal budget.
// While the server still reports work in flight for this exact key, giving up
// would strand a refresh that does land — but the wait stays bounded.
export const ACTIVE_REFRESH_RETRY_TIMEOUT_MS = 10 * 60 * 1000

export type CostsTokenData = TokenData & {
  meta?: TokenData['meta'] & {
    preservedPreviousOpenClaw?: boolean
    preservedPreviousClaudeCode?: boolean
    preservedPreviousHermes?: boolean
    preservedPreviousUsage?: boolean
    refreshStartedAt?: string
  }
}

export interface StaleRetryState {
  key: string
  startedAt: number
  settleResets: number
}

export interface StaleRetryDecision {
  /** Milliseconds until the next poll, or false to stop polling. */
  interval: number | false
  /** State to keep for the next call; null once polling has settled. */
  state: StaleRetryState | null
}

export function nextStaleRetry(
  tokens: CostsTokenData | undefined,
  selection: { period: string; anchor: string | null },
  previous: StaleRetryState | null,
  now: number,
): StaleRetryDecision {
  const stale =
    tokens?.source === 'sessions.fast_fallback' ||
    // A pending anchored month: empty by design until the detailed
    // producers answer, so it must keep polling like the live fallback.
    tokens?.source === 'anchored.pending' ||
    tokens?.meta?.refreshing ||
    tokens?.meta?.stale
  if (!stale) return { interval: false, state: null }

  // A preserved cache entry is worth settling on only when it actually holds
  // data. `anchored.pending` is empty by construction, so preserving it (all
  // producers failed on the first refresh) must NOT stop the polling —
  // otherwise the month stays at zero for the whole mounted session even
  // after the producers recover.
  // A configured producer that is still unavailable means the answer is not
  // final, no matter that some other slice was preserved. 'not_configured'
  // does NOT count — an absent optional integration will never recover.
  const producerStillUnavailable = [
    tokens?.meta?.openclawStatus,
    tokens?.meta?.hermesStatus,
    tokens?.meta?.claudeCodeStatus,
  ].includes('unavailable')
  const preservedFreshCache =
    tokens?.source !== 'anchored.pending' &&
    tokens?.meta?.stale &&
    !tokens.meta.refreshing &&
    !producerStillUnavailable &&
    (tokens.meta.preservedPreviousOpenClaw || tokens.meta.preservedPreviousClaudeCode || tokens.meta.preservedPreviousHermes || tokens.meta.preservedPreviousUsage)
  if (preservedFreshCache) return { interval: false, state: null }

  // Keyed by the SELECTION, never by per-attempt refresh metadata: each
  // failed retry rewrites refreshStartedAt, which would reset the deadline
  // every time and let a permanently failing month poll — and relaunch the
  // expensive scans — forever. A changing source is real progress and does
  // legitimately restart the budget.
  const retryKey = [
    selection.period,
    selection.anchor || 'live',
    tokens?.source || 'unknown',
  ].join(':')
  let state: StaleRetryState = previous?.key === retryKey
    ? previous
    : { key: retryKey, startedAt: now, settleResets: 0 }

  // `meta.refreshing` stays true while the refresh for this key is queued or
  // running, so the longer budget only applies while the server is actually
  // still working on it.
  const refreshing = tokens?.meta?.refreshing === true
  // A refresh that ran longer than the idle budget and then settled into a
  // partial result would otherwise flip to an ALREADY-EXPIRED deadline and
  // stop polling instantly. Grant the settled result one fresh idle window
  // — once per selection, so a permanently failing month cannot re-arm
  // itself forever (that eternal loop was fixed in an earlier round).
  if (!refreshing
    && state.settleResets === 0
    && now - state.startedAt >= STALE_COSTS_RETRY_TIMEOUT_MS) {
    state = { key: retryKey, startedAt: now, settleResets: 1 }
  }
  const budget = refreshing
    ? ACTIVE_REFRESH_RETRY_TIMEOUT_MS
    : STALE_COSTS_RETRY_TIMEOUT_MS
  return {
    interval: now - state.startedAt < budget ? STALE_COSTS_RETRY_INTERVAL_MS : false,
    state,
  }
}
