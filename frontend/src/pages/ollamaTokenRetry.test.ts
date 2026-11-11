import { describe, expect, it } from 'vitest'
import {
  TOKEN_USAGE_RETRY_INTERVAL_MS,
  TOKEN_USAGE_RETRY_LIMIT,
  TOKEN_USAGE_RETRY_TIMEOUT_MS,
  TOKEN_USAGE_STEADY_REFRESH_MS,
  nextTokenUsageRefetch,
  shouldRetryTokenUsageFast,
} from './ollamaTokenRetry'
import type { TokenUsageRetryState } from './ollamaTokenRetry'

describe('token usage refresh policy', () => {
  it('uses a 2.5 s retry for at most 60 attempts, then a 60 s steady refresh', () => {
    expect(TOKEN_USAGE_RETRY_INTERVAL_MS).toBe(2500)
    expect(TOKEN_USAGE_RETRY_LIMIT).toBe(60)
    expect(TOKEN_USAGE_RETRY_TIMEOUT_MS).toBe(150_000)
    expect(TOKEN_USAGE_STEADY_REFRESH_MS).toBe(60_000)
  })

  it('retries fast while nothing has loaded or the data is a fallback, refreshing or stale', () => {
    expect(shouldRetryTokenUsageFast(undefined)).toBe(true)
    expect(shouldRetryTokenUsageFast({ source: 'sessions.fast_fallback' })).toBe(true)
    expect(shouldRetryTokenUsageFast({ source: 'token-usage.csv', meta: { refreshing: true } })).toBe(true)
    expect(shouldRetryTokenUsageFast({ source: 'token-usage.csv', meta: { stale: true } })).toBe(true)
  })

  it('relaxes to the steady refresh once the data is fresh', () => {
    expect(shouldRetryTokenUsageFast({ source: 'token-usage.csv', meta: {} })).toBe(false)
    expect(nextTokenUsageRefetch({ source: 'token-usage.csv', meta: {} }, 'month', null, 0))
      .toEqual({ interval: TOKEN_USAGE_STEADY_REFRESH_MS, state: null })
  })

  it('treats a stale-but-preserved cache as recovered, unless a refresh is still running', () => {
    for (const flag of ['preservedPreviousOpenClaw', 'preservedPreviousUsage'] as const) {
      expect(shouldRetryTokenUsageFast({ source: 'token-usage.csv', meta: { stale: true, [flag]: true } })).toBe(false)
      expect(shouldRetryTokenUsageFast({ source: 'token-usage.csv', meta: { stale: true, refreshing: true, [flag]: true } })).toBe(true)
    }
  })

  it('falls back to the steady refresh once the retry budget is spent, and restarts it for a new period', () => {
    const data = { source: 'sessions.fast_fallback' }
    let decision = nextTokenUsageRefetch(data, 'month', null, 0)
    expect(decision.interval).toBe(TOKEN_USAGE_RETRY_INTERVAL_MS)
    decision = nextTokenUsageRefetch(data, 'month', decision.state, TOKEN_USAGE_RETRY_TIMEOUT_MS - 1)
    expect(decision.interval).toBe(TOKEN_USAGE_RETRY_INTERVAL_MS)
    decision = nextTokenUsageRefetch(data, 'month', decision.state, TOKEN_USAGE_RETRY_TIMEOUT_MS)
    expect(decision.interval).toBe(TOKEN_USAGE_STEADY_REFRESH_MS)
    const state: TokenUsageRetryState | null = decision.state
    decision = nextTokenUsageRefetch(data, 'day', state, TOKEN_USAGE_RETRY_TIMEOUT_MS + 10)
    expect(decision.interval).toBe(TOKEN_USAGE_RETRY_INTERVAL_MS)
  })
})
