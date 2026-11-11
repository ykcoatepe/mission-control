import { describe, expect, it } from 'vitest'
import type { OperationsOverview } from '../pages/brain/types'
import { blockedCount } from './overview'

describe('blockedCount', () => {
  const systems = (metrics: Record<string, number | string | null>) =>
    ({ hermes: { metrics } }) as unknown as OperationsOverview['systems']

  it('returns the number only when it is a real number', () => {
    expect(blockedCount({ systems: systems({ blocked: 3 }) })).toBe(3)
    expect(blockedCount({ systems: systems({ blocked: 0 }) })).toBe(0)
  })

  it('returns null when the metric is absent or not numeric', () => {
    expect(blockedCount({ systems: systems({}) })).toBeNull()
    expect(blockedCount({ systems: systems({ blocked: null }) })).toBeNull()
    expect(blockedCount({ systems: systems({ blocked: 'many' }) })).toBeNull()
    expect(blockedCount(null)).toBeNull()
  })
})
