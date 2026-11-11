import { describe, expect, it } from 'vitest'
import {
  annunciators,
  attentionFrom,
  attentionPill,
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

const BREAKDOWN = { systems: 3, findings: 23, overdueConfirmations: 3, restricted: 129 }

describe('attentionPill', () => {
  it('is hidden when nothing was read or the count is zero', () => {
    expect(attentionPill(null)).toBeNull()
    expect(attentionPill(base({ attention: null, loops: null }))).toBeNull()
    expect(attentionPill(base({ attention: { count: 0, worst: null } }))).toBeNull()
  })

  it('does not turn a null count into a pill', () => {
    expect(attentionPill(base({ attention: { count: null, worst: null } }))).toBeNull()
    expect(attentionPill(base({ attention: { count: null, worst: null, breakdown: BREAKDOWN } }))).toBeNull()
  })

  it('uses the worst severity and pluralises', () => {
    expect(attentionPill(base({ attention: { count: 1, worst: 'warning' } }))).toEqual({
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

  it('shows the server count as is, with the breakdown as secondary text', () => {
    const pill = attentionPill(base({ attention: { count: 158, worst: 'critical', breakdown: BREAKDOWN } }))
    expect(pill).toMatchObject({
      count: 158,
      state: 'critical',
      text: '158 need attention',
      secondary: '3 systems · 23 findings · 3 overdue · 129 restricted',
    })
  })

  it('never lets the loops signal change the number or the state', () => {
    const pill = attentionPill(
      base({ attention: { count: 3, worst: 'warning' }, loops: { openFindings: 99, overdueConfirmations: 24 } }),
    )
    expect(pill).toMatchObject({ count: 3, state: 'warning', secondary: null })
    expect(attentionPill(base({ attention: null, loops: { openFindings: null, overdueConfirmations: 2 } }))).toBeNull()
  })

  it('keeps a null attention count as null, not 0', () => {
    expect(attentionReading(base({ attention: { count: null, worst: null }, loops: null }))).toBeNull()
    expect(attentionReading(base({ attention: { count: null, worst: null, breakdown: BREAKDOWN } }))).toMatchObject({
      count: null,
      breakdown: BREAKDOWN,
    })
    expect(attentionReading(base({ attention: null, loops: null }))).toBeNull()
    expect(attentionWords(1)).toBe('1 needs attention')
    expect(attentionWords(30)).toBe('30 need attention')
  })

  it('never shows a healthy-looking pill', () => {
    expect(attentionPill(base({ attention: { count: 2, worst: 'healthy' } }))?.state).toBe('warning')
    expect(attentionPill(base({ attention: { count: 2, worst: null } }))?.state).toBe('warning')
  })
})

describe('attentionFrom / breakdownWords', () => {
  it('reads the loops copy of the same object', () => {
    expect(attentionFrom({ count: 158, worst: 'critical', breakdown: BREAKDOWN })).toMatchObject({ count: 158, state: 'critical' })
    expect(attentionFrom(null)).toBeNull()
    expect(attentionFrom(undefined)).toBeNull()
  })

  it('leaves out zero parts and says "not read" for a null part', () => {
    expect(breakdownWords({ systems: 0, findings: 1, overdueConfirmations: 0, restricted: 0 })).toBe('1 finding')
    expect(breakdownWords({ systems: 1, findings: null, overdueConfirmations: 2, restricted: null })).toBe(
      '1 system · findings not read · 2 overdue · restricted not read',
    )
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

  it('shows the same number as the top-bar pill and leaves the breakdown to the pill', () => {
    const signals = base({ loops: { openFindings: 9, overdueConfirmations: 24 }, attention: { count: 158, worst: 'critical', breakdown: BREAKDOWN } })
    const pill = attentionPill(signals)
    // The pill carries the breakdown; the badge is the number only.
    expect(navBadges(signals)['/attention']).toEqual({ count: 158, tone: 'critical', word: 'need attention' })
    expect(pill).toMatchObject({ count: 158, text: '158 need attention', secondary: '3 systems · 23 findings · 3 overdue · 129 restricted' })
  })

  it('uses a caution badge when the worst item is a warning', () => {
    expect(navBadges(base({ attention: { count: 4, worst: 'warning' } }))['/attention']).toEqual({
      count: 4,
      tone: 'warning',
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
    expect(unread).toEqual({ '/attention': true, '/automations': true, '/services': true })
    expect(navUnread(base(), { loading: false })).toEqual({})
    expect(navUnread(base({ automations: { failed: 0, nextRunAt: null }, services: { down: 0 } }), { loading: false })).toEqual({})
    expect(navUnread(null, { loading: true })).toEqual({})
    expect(Object.keys(navUnread(null, { loading: false })).sort()).toEqual(['/attention', '/automations', '/services'])
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
