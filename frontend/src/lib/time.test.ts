import { describe, expect, it } from 'vitest'
import { formatAge, formatRelative, parseTime } from './time'

const NOW = Date.parse('2026-11-11T12:00:00Z')

describe('formatRelative', () => {
  it('formats past times', () => {
    expect(formatRelative(NOW - 10_000, NOW)).toBe('just now')
    expect(formatRelative(NOW - 5 * 60_000, NOW)).toBe('5m ago')
    expect(formatRelative(NOW - 3 * 3_600_000, NOW)).toBe('3h ago')
    expect(formatRelative(NOW - 2 * 86_400_000, NOW)).toBe('2d ago')
  })

  it('formats future times', () => {
    expect(formatRelative(NOW + 10_000, NOW)).toBe('in <1m')
    expect(formatRelative(NOW + 90 * 60_000, NOW)).toBe('in 1h')
  })
})

describe('formatAge', () => {
  it('is compact and never negative', () => {
    expect(formatAge(NOW - 30_000, NOW)).toBe('<1m')
    expect(formatAge(NOW - 61 * 60_000, NOW)).toBe('1h')
    expect(formatAge(NOW + 60_000, NOW)).toBe('<1m')
  })
})

describe('parseTime', () => {
  it('rejects empty and invalid values instead of inventing a time', () => {
    expect(parseTime(null)).toBeNull()
    expect(parseTime(undefined)).toBeNull()
    expect(parseTime('')).toBeNull()
    expect(parseTime('not a date')).toBeNull()
    expect(parseTime(Number.NaN)).toBeNull()
  })

  it('parses ISO strings, numbers and dates', () => {
    expect(parseTime('2026-11-11T12:00:00Z')).toBe(NOW)
    expect(parseTime(NOW)).toBe(NOW)
    expect(parseTime(new Date(NOW))).toBe(NOW)
  })
})
