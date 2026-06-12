import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { timeAgo, formatDate } from './hooks'

// ---------------------------------------------------------------------------
// timeAgo — use fake timers for determinism
// ---------------------------------------------------------------------------

describe('timeAgo', () => {
  const NOW = new Date('2024-06-01T12:00:00.000Z').getTime()

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('returns "—" for empty string', () => {
    expect(timeAgo('')).toBe('—')
  })

  it('returns "just now" for < 1 minute ago', () => {
    const date = new Date(NOW - 30_000).toISOString() // 30s ago
    expect(timeAgo(date)).toBe('just now')
  })

  it('returns minutes ago', () => {
    const date = new Date(NOW - 5 * 60_000).toISOString() // 5m ago
    expect(timeAgo(date)).toBe('5m ago')
  })

  it('returns hours ago', () => {
    const date = new Date(NOW - 3 * 3600_000).toISOString() // 3h ago
    expect(timeAgo(date)).toBe('3h ago')
  })

  it('returns days ago', () => {
    const date = new Date(NOW - 2 * 86400_000).toISOString() // 2d ago
    expect(timeAgo(date)).toBe('2d ago')
  })

  it('returns "in <1m" for a future date < 1 minute ahead', () => {
    const date = new Date(NOW + 30_000).toISOString() // 30s in the future
    expect(timeAgo(date)).toBe('in <1m')
  })

  it('returns "in Xm" for future minutes', () => {
    const date = new Date(NOW + 10 * 60_000).toISOString() // 10m in the future
    expect(timeAgo(date)).toBe('in 10m')
  })

  it('returns "in Xh" for future hours', () => {
    const date = new Date(NOW + 5 * 3600_000).toISOString() // 5h in the future
    expect(timeAgo(date)).toBe('in 5h')
  })

  it('returns "in Xd" for future days', () => {
    const date = new Date(NOW + 3 * 86400_000).toISOString() // 3d in the future
    expect(timeAgo(date)).toBe('in 3d')
  })
})

// ---------------------------------------------------------------------------
// formatDate
// ---------------------------------------------------------------------------

describe('formatDate', () => {
  it('returns a non-empty string for a valid ISO date', () => {
    const result = formatDate('2024-06-01T12:00:00.000Z')
    expect(typeof result).toBe('string')
    expect(result.length).toBeGreaterThan(0)
  })

  it('includes month abbreviation and day number', () => {
    // In en-US locale, "Jun 1" or "Jun 1" pattern
    const result = formatDate('2024-06-01T12:00:00.000Z')
    expect(result).toMatch(/Jun/)
    expect(result).toMatch(/1/)
  })
})
