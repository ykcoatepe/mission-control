import { describe, expect, it } from 'vitest'
import {
  annunciators,
  attentionFrom,
  attentionReading,
  attentionUnread,
  attentionWords,
  breakdownWords,
  countOrNull,
  navBadges,
  navUnread,
  plainReason,
  signalsAge,
  signalsStale,
} from './signals'
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
    expect(openclaw).toMatchObject({ id: 'openclaw', state: 'warning', word: 'caution', lit: true })
    expect(gbrain.word).toBe('normal')
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
    expect(list[0]).toMatchObject({ state: 'unavailable', word: 'not read' })
  })
})

const BREAKDOWN = { systems: 3, findings: 23, overdueConfirmations: 3, restricted: 129 }

describe('attentionReading', () => {
  it('is null when nothing was read', () => {
    expect(attentionReading(null)).toBeNull()
    expect(attentionReading(base({ attention: null, loops: null }))).toBeNull()
    expect(attentionReading(base({ attention: { count: null, worst: null } }))).toBeNull()
  })

  it('keeps a null attention count as null, not 0', () => {
    expect(attentionReading(base({ attention: { count: null, worst: null, breakdown: BREAKDOWN } }))).toMatchObject({
      count: null,
      breakdown: BREAKDOWN,
    })
    expect(attentionWords(1)).toBe('1 needs attention')
    expect(attentionWords(30)).toBe('30 need attention')
  })

  it('reads the new shape: count and worst cover new items, standing and restricted are information', () => {
    const reading = attentionReading(
      base({
        attention: {
          count: 2,
          worst: 'warning',
          standing: 126,
          restricted: 21,
          breakdown: { systems: 1, findings: 1, overdueConfirmations: 0 },
        },
      }),
    )
    expect(reading).toMatchObject({ count: 2, standing: 126, restricted: 21, state: 'warning' })
    expect(reading?.breakdown?.restricted).toBeUndefined()
  })

  it('still reads the older shape, taking restricted from the breakdown', () => {
    const reading = attentionReading(base({ attention: { count: 158, worst: 'critical', breakdown: BREAKDOWN } }))
    expect(reading).toMatchObject({ count: 158, standing: null, restricted: 129, state: 'critical' })
  })

  it('never reads a healthy-looking state for a count above zero', () => {
    expect(attentionReading(base({ attention: { count: 2, worst: 'healthy' } }))?.state).toBe('warning')
    expect(attentionReading(base({ attention: { count: 2, worst: null } }))?.state).toBe('warning')
  })

  it('never lets the loops signal change the number or the state', () => {
    const reading = attentionReading(
      base({ attention: { count: 3, worst: 'warning' }, loops: { openFindings: 99, overdueConfirmations: 24 } }),
    )
    expect(reading).toMatchObject({ count: 3, state: 'warning' })
    expect(attentionReading(base({ attention: null, loops: { openFindings: null, overdueConfirmations: 2 } }))).toBeNull()
  })
})

describe('attentionFrom / breakdownWords', () => {
  it('reads the loops copy of the same object', () => {
    expect(attentionFrom({ count: 158, worst: 'critical', breakdown: BREAKDOWN })).toMatchObject({ count: 158, state: 'critical' })
    expect(attentionFrom(null)).toBeNull()
    expect(attentionFrom(undefined)).toBeNull()
  })

  it('leaves out zero parts and says "not read" for a null counted part', () => {
    expect(breakdownWords({ systems: 0, findings: 1, overdueConfirmations: 0, restricted: 0 })).toBe('1 finding')
    expect(breakdownWords({ systems: 1, findings: null, overdueConfirmations: 2, restricted: null })).toBe(
      '1 system · findings not read · 2 overdue',
    )
    // Restricted is information: mentioned when above zero, never as "not read", absent in the new shape.
    expect(breakdownWords({ systems: 3, findings: 23, overdueConfirmations: 3, restricted: 129 })).toBe(
      '3 systems · 23 findings · 3 overdue · 129 restricted',
    )
    expect(breakdownWords({ systems: 1, findings: 0, overdueConfirmations: 0 })).toBe('1 system')
    expect(breakdownWords({ systems: 0, findings: 0, overdueConfirmations: 0, restricted: 0 })).toBeNull()
    expect(breakdownWords(null)).toBeNull()
  })

  it('treats a non-number part as not read', () => {
    const reading = attentionFrom({
      count: 2,
      worst: 'warning',
      breakdown: { systems: 2, findings: '1' as unknown as number, overdueConfirmations: -1, restricted: 0 },
    })
    expect(reading?.breakdown).toEqual({ systems: 2, findings: null, overdueConfirmations: null, restricted: 0 })
  })
})

describe('annunciator reason and link', () => {
  it('carries the server reason for an unhealthy system and none for a healthy one', () => {
    const [gbrain, , openclaw] = annunciators(
      base({
        systems: {
          gbrain: { state: 'healthy', observedAt: RECENT, reason: 'ignored while healthy' },
          openclaw: { state: 'warning', observedAt: RECENT, reason: 'OpenClaw status evidence is unavailable.' },
        },
      }),
      opts,
    )
    expect(gbrain.reason).toBeNull()
    expect(openclaw.reason).toBe('OpenClaw status could not be read.')
  })

  it('links to the server detailHref, else the static fallback', () => {
    const list = annunciators(
      base({
        systems: {
          gbrain: { state: 'warning', observedAt: RECENT, detailHref: '/gbrain' },
          hermes: { state: 'warning', observedAt: RECENT, detailHref: null },
          openclaw: { state: 'warning', observedAt: RECENT, detailHref: 'https://evil.example/x' },
        },
      }),
      opts,
    )
    expect(list.map((item) => item.href)).toEqual(['/gbrain', '/services', '/services'])
  })

  it('does not follow a detailHref the app no longer renders', () => {
    const live = (path: string) => path === '/gbrain'
    const list = annunciators(
      base({
        systems: {
          gbrain: { state: 'warning', observedAt: RECENT, detailHref: '/gbrain' },
          hermes: { state: 'warning', observedAt: RECENT, detailHref: '/work' },
        },
      }),
      { ...opts, isLivePath: live },
    )
    expect(list[0].href).toBe('/gbrain')
    expect(list[1].href).toBe('/services')
  })
})

describe('navBadges (badge rule)', () => {
  it('shows nothing when signals are absent or all quiet', () => {
    expect(navBadges(null)).toEqual({})
    expect(navBadges(base({ attention: { count: 0, worst: 'healthy' } }))).toEqual({})
  })

  it('shows nothing for null signals (not 0, not an alarm)', () => {
    expect(navBadges(base({ automations: null, loops: null, attention: null, services: null }))).toEqual({})
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

  it('counts automations that failed and are not acknowledged, and ignores the standing ones', () => {
    const badges = navBadges(base({ automations: { failed: 3, standingFailed: 5, nextRunAt: null } }))
    expect(badges['/automations']).toEqual({ count: 3, tone: 'critical', word: 'failed' })
    expect(navBadges(base({ automations: { failed: 0, standingFailed: 5, nextRunAt: null } }))['/automations']).toBeUndefined()
  })

  it('has no Services badge: a service that stays down is a standing condition, not a new item', () => {
    expect(navBadges(base({ services: { down: 2 } }))['/services']).toBeUndefined()
  })

  it('the attention badge is exactly the new count; standing and restricted never add to it', () => {
    const signals = base({
      attention: { count: 2, worst: 'warning', standing: 126, restricted: 21, breakdown: { systems: 1, findings: 1, overdueConfirmations: 0 } },
      loops: { openFindings: 9, overdueConfirmations: 24 },
    })
    expect(navBadges(signals)['/attention']).toEqual({ count: 2, tone: 'warning', word: 'need attention' })
    expect(navBadges(base({ attention: { count: 1, worst: 'warning' } }))['/attention']?.word).toBe('needs attention')
  })

  it('has no attention badge when only standing items remain', () => {
    expect(navBadges(base({ attention: { count: 0, worst: 'healthy', standing: 147, restricted: 129 } }))['/attention']).toBeUndefined()
  })

  it('uses a critical badge when the worst new item is critical', () => {
    expect(navBadges(base({ attention: { count: 4, worst: 'critical' } }))['/attention']).toEqual({
      count: 4,
      tone: 'critical',
      word: 'need attention',
    })
  })

  it('does not turn an unread attention count into a badge of another number', () => {
    expect(navBadges(base({ attention: { count: null, worst: null }, loops: { openFindings: 1, overdueConfirmations: 5 } }))['/attention']).toBeUndefined()
  })
})

describe('plainReason', () => {
  it('says "reading" and "could not be read" instead of evidence, proof and probe', () => {
    expect(plainReason('OpenClaw status evidence is unavailable.')).toBe('OpenClaw status could not be read.')
    expect(plainReason('Embed-job probe unavailable; the missing-embedding verdict uses embedding age only.')).toBe(
      'Embed-job could not be read; the missing-embedding verdict uses embedding age only.',
    )
    expect(plainReason('Evidence is older than 10 minutes.')).toBe('Reading is older than 10 minutes.')
    expect(plainReason('The proof was not refreshed.')).toBe('The reading was not refreshed.')
  })

  it('leaves a plain reason alone and handles long input in linear time', () => {
    expect(plainReason('Hermes has a caveat.')).toBe('Hermes has a caveat.')
    expect(plainReason('')).toBe('')
    const long = `${'status '.repeat(5000)}evidence`
    const started = Date.now()
    plainReason(long)
    expect(Date.now() - started).toBeLessThan(500)
  })

  it('reaches the annunciator tooltip text', () => {
    const [gbrain] = annunciators(
      base({ systems: { gbrain: { state: 'unavailable', observedAt: RECENT, reason: 'Embed-job probe unavailable.' } } }),
      opts,
    )
    expect(gbrain.reason).toBe('Embed-job could not be read.')
  })
})

describe('unread is not quiet', () => {
  it('flags an attention count that was not read, but not while loading or when it is a real zero', () => {
    expect(attentionUnread(base({ attention: null }), { loading: false })).toBe(true)
    expect(attentionUnread(base({ attention: { count: null, worst: null } }), { loading: false })).toBe(true)
    expect(attentionUnread(base({ attention: { count: null, worst: null, breakdown: BREAKDOWN } }), { loading: false })).toBe(true)
    expect(attentionUnread(null, { loading: false })).toBe(true)
    expect(attentionUnread(null, { loading: true })).toBe(false)
    expect(attentionUnread(base({ attention: { count: 0, worst: null } }), { loading: false })).toBe(false)
    expect(attentionUnread(base({ attention: { count: 3, worst: 'warning' } }), { loading: false })).toBe(false)
  })

  it('marks sidebar routes whose count was not read, never as 0', () => {
    const unread = navUnread(base({ automations: null, attention: null, services: { down: null } }), { loading: false })
    expect(unread).toEqual({ '/attention': true, '/automations': true })
    expect(navUnread(base(), { loading: false })).toEqual({})
    expect(navUnread(base({ automations: { failed: 0, nextRunAt: null }, services: { down: 0 } }), { loading: false })).toEqual({})
    expect(navUnread(null, { loading: true })).toEqual({})
    expect(Object.keys(navUnread(null, { loading: false })).sort()).toEqual(['/attention', '/automations'])
  })
})

describe('signalsAge', () => {
  it('names the signals in its tooltip so it does not contradict a page freshness', () => {
    const age = signalsAge(RECENT, NOW, false)
    expect(age.text).toBe('Updated 2m ago')
    expect(age.title).toMatch(/^Signals updated 2m ago/)
  })

  it('says reading, then not read, and never invents a time', () => {
    expect(signalsAge(null, NOW, true).text).toBe('Reading…')
    expect(signalsAge(null, NOW, false).text).toBe('Not read')
    expect(signalsAge('not a date', NOW, false).text).toBe('Not read')
    expect(signalsAge(undefined, NOW, false).title).toMatch(/could not be read/)
  })
})
