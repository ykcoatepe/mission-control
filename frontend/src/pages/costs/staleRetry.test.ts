import { describe, expect, it } from 'vitest'
import {
  ACTIVE_REFRESH_RETRY_TIMEOUT_MS,
  STALE_COSTS_RETRY_INTERVAL_MS,
  STALE_COSTS_RETRY_LIMIT,
  STALE_COSTS_RETRY_TIMEOUT_MS,
  nextStaleRetry,
} from './staleRetry'
import type { CostsTokenData, StaleRetryState } from './staleRetry'

const live = { period: 'month', anchor: null }
const tokens = (extra: Record<string, unknown>) => extra as unknown as CostsTokenData

describe('nextStaleRetry', () => {
  it('keeps retrying while data is the fast fallback, refreshing or stale, and stops on settled data', () => {
    for (const data of [
      tokens({ source: 'sessions.fast_fallback' }),
      tokens({ source: 'token-usage.csv', meta: { refreshing: true } }),
      tokens({ source: 'token-usage.csv', meta: { stale: true } }),
    ]) {
      expect(nextStaleRetry(data, live, null, 0).interval).toBe(STALE_COSTS_RETRY_INTERVAL_MS)
    }
    expect(nextStaleRetry(tokens({ source: 'token-usage.csv', meta: {} }), live, null, 0)).toEqual({ interval: false, state: null })
    expect(nextStaleRetry(undefined, live, null, 0)).toEqual({ interval: false, state: null })
  })

  it('polls an empty pending anchored month like the live fallback', () => {
    expect(nextStaleRetry(tokens({ source: 'anchored.pending' }), { period: 'month', anchor: '2026-06' }, null, 0).interval)
      .toBe(STALE_COSTS_RETRY_INTERVAL_MS)
  })

  it('settles on a preserved cache that holds data, for each preserved slice', () => {
    for (const flag of ['preservedPreviousOpenClaw', 'preservedPreviousClaudeCode', 'preservedPreviousHermes', 'preservedPreviousUsage']) {
      const data = tokens({ source: 'token-usage.csv', meta: { stale: true, [flag]: true } })
      expect(nextStaleRetry(data, live, null, 0)).toEqual({ interval: false, state: null })
    }
  })

  it('does not settle on a preserved empty anchored.pending entry (the month would stay at zero)', () => {
    const data = tokens({ source: 'anchored.pending', meta: { stale: true, preservedPreviousUsage: true } })
    expect(nextStaleRetry(data, { period: 'month', anchor: '2026-06' }, null, 0).interval).toBe(STALE_COSTS_RETRY_INTERVAL_MS)
  })

  it('does not settle on a preserved slice while a configured producer is still unavailable', () => {
    const data = tokens({
      source: 'token-usage.csv',
      meta: { stale: true, preservedPreviousOpenClaw: true, hermesStatus: 'unavailable' },
    })
    expect(nextStaleRetry(data, live, null, 0).interval).toBe(STALE_COSTS_RETRY_INTERVAL_MS)
    const optional = tokens({
      source: 'token-usage.csv',
      meta: { stale: true, preservedPreviousOpenClaw: true, hermesStatus: 'not_configured' },
    })
    expect(nextStaleRetry(optional, live, null, 0).interval).toBe(false)
  })

  it('caps polling at the idle budget (60 attempts), then gives a settled result exactly one more window', () => {
    expect(STALE_COSTS_RETRY_TIMEOUT_MS).toBe(STALE_COSTS_RETRY_INTERVAL_MS * STALE_COSTS_RETRY_LIMIT)
    const data = tokens({ source: 'sessions.fast_fallback' })
    let state: StaleRetryState | null = null
    let decision = nextStaleRetry(data, live, state, 1000)
    state = decision.state
    // Just inside the budget: still polling.
    decision = nextStaleRetry(data, live, state, 1000 + STALE_COSTS_RETRY_TIMEOUT_MS - 1)
    expect(decision.interval).toBe(STALE_COSTS_RETRY_INTERVAL_MS)
    state = decision.state
    // Budget used up: one fresh idle window is granted, exactly once.
    const expiredAt = 1000 + STALE_COSTS_RETRY_TIMEOUT_MS
    decision = nextStaleRetry(data, live, state, expiredAt)
    expect(decision.interval).toBe(STALE_COSTS_RETRY_INTERVAL_MS)
    expect(decision.state?.settleResets).toBe(1)
    state = decision.state
    decision = nextStaleRetry(data, live, state, expiredAt + STALE_COSTS_RETRY_TIMEOUT_MS)
    expect(decision.interval).toBe(false)
  })

  it('does not restart the deadline when per-attempt refresh metadata changes', () => {
    const attempt = (n: number) => tokens({ source: 'sessions.fast_fallback', meta: { stale: true, refreshStartedAt: `t${n}`, updatedAt: `u${n}` } })
    let state: StaleRetryState | null = null
    let now = 0
    for (let n = 0; n < 20; n += 1) {
      const decision = nextStaleRetry(attempt(n), live, state, now)
      state = decision.state
      now += STALE_COSTS_RETRY_INTERVAL_MS
    }
    expect(state?.startedAt).toBe(0)
  })

  it('restarts the budget when the selection or the source changes', () => {
    const first = nextStaleRetry(tokens({ source: 'sessions.fast_fallback' }), live, null, 0)
    const otherMonth = nextStaleRetry(tokens({ source: 'sessions.fast_fallback' }), { period: 'month', anchor: '2026-06' }, first.state, 5000)
    expect(otherMonth.state?.startedAt).toBe(5000)
    const otherSource = nextStaleRetry(tokens({ source: 'anchored.pending' }), live, first.state, 7000)
    expect(otherSource.state?.startedAt).toBe(7000)
  })

  it('lets a queued month wait far longer while the server reports work in flight, but not forever', () => {
    const data = tokens({ source: 'anchored.pending', meta: { refreshing: true } })
    const selection = { period: 'month', anchor: '2026-06' }
    let decision = nextStaleRetry(data, selection, null, 0)
    decision = nextStaleRetry(data, selection, decision.state, STALE_COSTS_RETRY_TIMEOUT_MS * 2)
    expect(decision.interval).toBe(STALE_COSTS_RETRY_INTERVAL_MS)
    decision = nextStaleRetry(data, selection, decision.state, ACTIVE_REFRESH_RETRY_TIMEOUT_MS)
    expect(decision.interval).toBe(false)
  })
})
