import { describe, expect, it } from 'vitest'
import type { AttentionItem, OperationsOverview } from '../pages/brain/types'
import { annunciatorFor, attentionSummary, blockedCount } from './overview'

describe('annunciatorFor', () => {
  it('shows a fresh healthy system as healthy', () => {
    expect(annunciatorFor({ state: 'healthy', freshness: 'fresh' })).toEqual({ state: 'healthy', word: 'healthy' })
  })

  it('does not call a stale or unread healthy system healthy', () => {
    expect(annunciatorFor({ state: 'healthy', freshness: 'stale' })).toEqual({ state: 'warning', word: 'stale' })
    expect(annunciatorFor({ state: 'healthy', freshness: 'unavailable' })).toEqual({ state: 'unavailable', word: 'not read' })
    expect(annunciatorFor({ state: 'healthy', freshness: 'unknown' })).toEqual({ state: 'unavailable', word: 'not read' })
  })

  it('keeps the reported non-healthy state and its word', () => {
    expect(annunciatorFor({ state: 'critical', freshness: 'fresh' })).toEqual({ state: 'critical', word: 'critical' })
    expect(annunciatorFor({ state: 'unavailable', freshness: 'unavailable' })).toEqual({ state: 'unavailable', word: 'unavailable' })
  })
})

const item = (severity: AttentionItem['severity']): AttentionItem => ({
  id: severity,
  system: 'hermes',
  severity,
  reasonCode: 'x',
  title: 't',
  detail: 'd',
  detailHref: '/',
  evidenceRefs: [],
})

describe('attentionSummary', () => {
  it('is null when the overview was not read', () => {
    expect(attentionSummary(null)).toBeNull()
    expect(attentionSummary(undefined)).toBeNull()
  })

  it('counts items and reports the worst severity', () => {
    expect(attentionSummary({ attention: [] })).toEqual({ count: 0, state: 'unavailable' })
    expect(attentionSummary({ attention: [item('warning'), item('critical')] })).toEqual({ count: 2, state: 'critical' })
    expect(attentionSummary({ attention: [item('unavailable')] })).toEqual({ count: 1, state: 'unavailable' })
  })
})

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
