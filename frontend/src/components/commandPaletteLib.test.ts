import { describe, expect, it } from 'vitest'
import { rankEntries } from './commandPaletteLib'

const entries = [
  { id: '1', label: 'Daily Hermes system health check' },
  { id: '2', label: 'Hermes backup', subtitle: 'nightly' },
  { id: '3', label: 'Weekly report', subtitle: 'sent by hermes' },
  { id: '4', label: 'Usage' },
]

describe('rankEntries', () => {
  it('ranks prefix matches above word and substring matches above subtitle matches', () => {
    expect(rankEntries('hermes', entries, 8).map((e) => e.id)).toEqual(['2', '1', '3'])
  })

  it('is case-insensitive and trims the query', () => {
    expect(rankEntries('  USAGE ', entries, 8).map((e) => e.id)).toEqual(['4'])
  })

  it('returns nothing when nothing matches', () => {
    expect(rankEntries('zzz', entries, 8)).toEqual([])
  })

  it('caps the result and keeps order for an empty query', () => {
    expect(rankEntries('', entries, 2).map((e) => e.id)).toEqual(['1', '2'])
    expect(rankEntries('hermes', entries, 1)).toHaveLength(1)
  })
})
