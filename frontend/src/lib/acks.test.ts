import { describe, expect, it } from 'vitest'
import { SHELVE_OPTIONS, shelveUntil } from './acks'

const NOW = Date.parse('2026-11-12T10:00:00.000Z')
const DAY = 86_400_000

describe('shelveUntil', () => {
  it('offers 7 days, 30 days and until I undo', () => {
    expect(SHELVE_OPTIONS.map((option) => option.label)).toEqual(['7 days', '30 days', 'Until I undo'])
  })

  it('counts forward from now, and sends null for "until I undo"', () => {
    expect(shelveUntil('7d', NOW)).toBe(new Date(NOW + 7 * DAY).toISOString())
    expect(shelveUntil('30d', NOW)).toBe(new Date(NOW + 30 * DAY).toISOString())
    expect(shelveUntil('forever', NOW)).toBeNull()
  })
})
