import { describe, expect, it } from 'vitest'
import { annunciators, attentionPill, attentionReading, attentionWords, countOrNull, navBadges, signalsStale } from './signals'
import type { SignalsData, SignalsEnvelope } from './signals'

const NOW = Date.parse('2026-11-11T09:00:00.000Z')
const RECENT = '2026-11-11T08:58:00.000Z'
const OLD = '2026-11-11T08:00:00.000Z'

const base = (over: Partial<SignalsData> = {}): SignalsData => ({
  systems: {
    gbrain: { state: 'healthy', observedAt: RECENT },
    hermes: { state: 'healthy', observedAt: RECENT },
    openclaw: { state: 'warning', observedAt: RECENT },
  },
  attention: { count: 3, worst: 'warning' },
  automations: { failed: 0, nextRunAt: null },
  loops: { openFindings: 5, overdueConfirmations: 0 },
  services: { down: 0 },
  usage: null,
  ...over,
})

const opts = { loading: false, now: NOW, stale: false }

describe('countOrNull', () => {
  it('accepts only finite non-negative numbers', () => {
    expect(countOrNull(0)).toBe(0)
    expect(countOrNull(4)).toBe(4)
    expect(countOrNull(null)).toBeNull()
    expect(countOrNull(undefined)).toBeNull()
    expect(countOrNull('3')).toBeNull()
    expect(countOrNull(Number.NaN)).toBeNull()
    expect(countOrNull(-1)).toBeNull()
  })
})

describe('signalsStale', () => {
  const envelope = (stale: boolean): SignalsEnvelope => ({
    data: base(),
    meta: { ok: true, stale, observedAt: RECENT, ageMs: 0, error: null },
  })

  it('is stale when the server says so or the request failed', () => {
    expect(signalsStale(envelope(true), false)).toBe(true)
    expect(signalsStale(envelope(false), true)).toBe(true)
    expect(signalsStale(null, true)).toBe(true)
  })

  it('is not stale for a fresh reading or before the first load', () => {
    expect(signalsStale(envelope(false), false)).toBe(false)
    expect(signalsStale(null, false)).toBe(false)
  })
})

describe('annunciators', () => {
  it('is reading before the first load completes', () => {
    const list = annunciators(null, { ...opts, loading: true })
    expect(list.map((item) => item.state)).toEqual(['reading', 'reading', 'reading'])
    expect(list[0].word).toBe('reading…')
  })

  it('is not read (never healthy) when nothing was read after loading', () => {
    const list = annunciators(null, opts)
    expect(list.every((item) => item.state === 'unavailable' && item.word === 'not read')).toBe(true)
  })

  it('keeps a fresh healthy system quiet and lights the others in their state', () => {
    const [gbrain, , openclaw] = annunciators(base(), opts)
    expect(gbrain).toMatchObject({ id: 'gbrain', state: 'healthy', lit: false })
    expect(openclaw).toMatchObject({ id: 'openclaw', state: 'warning', word: 'warning', lit: true })
  })

  it('does not show a null system or null systems block as healthy', () => {
    const missing = annunciators(base({ systems: { gbrain: null, hermes: undefined } }), opts)
    for (const item of missing) expect(item).toMatchObject({ state: 'unavailable', word: 'not read', lit: true })
    const none = annunciators(base({ systems: null }), opts)
    expect(none.every((item) => item.state === 'unavailable')).toBe(true)
  })

  it('does not call a healthy system healthy without a recent reading', () => {
    const unread = annunciators(
      base({ systems: { gbrain: { state: 'healthy', observedAt: null } } }),
      opts,
    )
    expect(unread[0]).toMatchObject({ state: 'unavailable', word: 'not read' })
    const old = annunciators(base({ systems: { gbrain: { state: 'healthy', observedAt: OLD } } }), opts)
    expect(old[0]).toMatchObject({ state: 'warning', word: 'stale' })
    const stalePayload = annunciators(base(), { ...opts, stale: true })
    expect(stalePayload[0]).toMatchObject({ state: 'warning', word: 'stale' })
  })

  it('maps an unknown state word to unavailable', () => {
    const list = annunciators(base({ systems: { gbrain: { state: 'weird', observedAt: RECENT } } }), opts)
    expect(list[0]).toMatchObject({ state: 'unavailable', word: 'unavailable' })
  })
})

describe('attentionPill', () => {
  it('is hidden when nothing was read or the count is zero', () => {
    expect(attentionPill(null)).toBeNull()
    expect(attentionPill(base({ attention: null, loops: null }))).toBeNull()
    expect(attentionPill(base({ attention: { count: 0, worst: null }, loops: { openFindings: 0, overdueConfirmations: 0 } }))).toBeNull()
  })

  it('does not turn a null count into a pill', () => {
    expect(attentionPill(base({ attention: { count: null, worst: null }, loops: null }))).toBeNull()
  })

  it('uses the worst severity and pluralises', () => {
    expect(attentionPill(base({ attention: { count: 1, worst: 'warning' }, loops: null }))).toEqual({
      count: 1,
      state: 'warning',
      text: '1 needs attention',
      secondary: null,
    })
    expect(attentionPill(base({ attention: { count: 27, worst: 'critical' } }))).toMatchObject({
      count: 27,
      state: 'critical',
      text: '27 need attention',
    })
  })

  it('is critical when confirmations are overdue, and does not add them twice', () => {
    const pill = attentionPill(
      base({ attention: { count: 27, worst: 'warning' }, loops: { openFindings: 1, overdueConfirmations: 24 } }),
    )
    expect(pill).toMatchObject({ count: 27, state: 'critical', text: '27 need attention', secondary: '24 overdue' })
  })

  it('says "overdue" in its own words when only the overdue count was read', () => {
    expect(attentionPill(base({ attention: null, loops: { openFindings: null, overdueConfirmations: 2 } }))).toEqual({
      count: 2,
      state: 'critical',
      text: '2 overdue',
      secondary: null,
    })
    expect(attentionPill(base({ attention: null, loops: { openFindings: null, overdueConfirmations: 0 } }))).toBeNull()
  })

  it('never replaces the attention count by a larger or smaller overdue count', () => {
    const pill = attentionPill(base({ attention: { count: 3, worst: 'warning' }, loops: { openFindings: 1, overdueConfirmations: 9 } }))
    expect(pill).toMatchObject({ count: 3, text: '3 need attention', secondary: '9 overdue' })
  })

  it('keeps a null attention count out of the reading as null, not 0', () => {
    expect(attentionReading(base({ attention: { count: null, worst: null }, loops: { openFindings: 1, overdueConfirmations: 4 } }))).toMatchObject({
      count: null,
      overdue: 4,
    })
    expect(attentionReading(base({ attention: null, loops: null }))).toBeNull()
    expect(attentionWords(1)).toBe('1 needs attention')
    expect(attentionWords(30)).toBe('30 need attention')
  })

  it('never shows a healthy-looking pill', () => {
    expect(attentionPill(base({ attention: { count: 2, worst: 'healthy' }, loops: null }))?.state).toBe('warning')
    expect(attentionPill(base({ attention: { count: 2, worst: null }, loops: null }))?.state).toBe('warning')
  })
})

describe('navBadges', () => {
  it('shows nothing when signals are absent or all quiet', () => {
    expect(navBadges(null)).toEqual({})
    expect(navBadges(base({ attention: { count: 0, worst: null } }))).toEqual({})
  })

  it('shows nothing for null signals (not 0, not an alarm)', () => {
    expect(
      navBadges(base({ automations: null, loops: null, attention: null, services: null })),
    ).toEqual({})
    expect(
      navBadges(
        base({
          automations: { failed: null, nextRunAt: null },
          loops: { openFindings: null, overdueConfirmations: null },
          attention: { count: null, worst: null },
          services: { down: null },
        }),
      ),
    ).toEqual({})
  })

  it('maps automations failed and services down to critical badges', () => {
    const badges = navBadges(base({ automations: { failed: 3, nextRunAt: null }, services: { down: 2 } }))
    expect(badges['/automations']).toEqual({ count: 3, tone: 'critical', word: 'failed' })
    expect(badges['/services']).toEqual({ count: 2, tone: 'critical', word: 'down' })
  })

  it('shows the same number and words as the top-bar pill, with overdue as secondary text', () => {
    const signals = base({ loops: { openFindings: 9, overdueConfirmations: 24 }, attention: { count: 30, worst: 'critical' } })
    const pill = attentionPill(signals)
    expect(navBadges(signals)['/attention']).toEqual({ count: 30, tone: 'critical', word: 'need attention', secondary: '24 overdue' })
    expect(pill).toMatchObject({ count: 30, text: '30 need attention' })
  })

  it('uses a caution badge when nothing is overdue and the worst item is a warning', () => {
    expect(
      navBadges(base({ loops: { openFindings: 9, overdueConfirmations: 0 }, attention: { count: 4, worst: 'warning' } }))['/attention'],
    ).toEqual({ count: 4, tone: 'warning', word: 'need attention', secondary: null })
    expect(navBadges(base({ loops: null, attention: { count: 4, worst: 'warning' } }))['/attention']).toMatchObject({
      tone: 'warning',
    })
  })

  it('does not turn an unread attention count into a badge of another number', () => {
    expect(navBadges(base({ attention: { count: null, worst: null }, loops: { openFindings: 1, overdueConfirmations: 0 } }))['/attention']).toBeUndefined()
    expect(navBadges(base({ attention: { count: null, worst: null }, loops: { openFindings: 1, overdueConfirmations: 5 } }))['/attention']).toMatchObject({
      count: 5,
      word: 'overdue',
    })
  })
})
