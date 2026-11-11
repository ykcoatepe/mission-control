// Refresh policy for the Local models page's token-usage query: retry fast while
// the costs payload is a fallback / refreshing / stale, relax to a steady refresh
// once it has recovered (or the retry budget is spent). Pure.

export const TOKEN_USAGE_RETRY_INTERVAL_MS = 2500
export const TOKEN_USAGE_RETRY_LIMIT = 60
export const TOKEN_USAGE_RETRY_TIMEOUT_MS = TOKEN_USAGE_RETRY_INTERVAL_MS * TOKEN_USAGE_RETRY_LIMIT
export const TOKEN_USAGE_STEADY_REFRESH_MS = 60000

export interface TokenUsageFreshness {
  source?: string
  meta?: {
    updatedAt?: string
    refreshing?: boolean
    stale?: boolean
    refreshStartedAt?: string
    preservedPreviousOpenClaw?: boolean
    preservedPreviousUsage?: boolean
  }
}

export interface TokenUsageRetryState {
  key: string
  startedAt: number
}

function isPreservedTokenUsageCache(tokens?: TokenUsageFreshness | null) {
  return !!(
    tokens?.meta?.stale &&
    !tokens.meta.refreshing &&
    (tokens.meta.preservedPreviousOpenClaw || tokens.meta.preservedPreviousUsage)
  )
}

export function shouldRetryTokenUsageFast(tokens?: TokenUsageFreshness | null) {
  if (!tokens) return true
  if (isPreservedTokenUsageCache(tokens)) return false
  return (
    tokens.source === 'sessions.fast_fallback' ||
    !!tokens.meta?.refreshing ||
    !!tokens.meta?.stale
  )
}

export function nextTokenUsageRefetch(
  tokens: TokenUsageFreshness | undefined,
  period: string,
  previous: TokenUsageRetryState | null,
  now: number,
): { interval: number; state: TokenUsageRetryState | null } {
  if (!shouldRetryTokenUsageFast(tokens)) {
    return { interval: TOKEN_USAGE_STEADY_REFRESH_MS, state: null }
  }
  const retryKey = [
    period,
    tokens?.source || 'pending',
    tokens?.meta?.refreshStartedAt || tokens?.meta?.updatedAt || 'unknown',
  ].join(':')
  const state = previous?.key === retryKey ? previous : { key: retryKey, startedAt: now }
  return {
    interval: now - state.startedAt < TOKEN_USAGE_RETRY_TIMEOUT_MS
      ? TOKEN_USAGE_RETRY_INTERVAL_MS
      : TOKEN_USAGE_STEADY_REFRESH_MS,
    state,
  }
}
