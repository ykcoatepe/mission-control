import { describe, expect, it } from 'vitest'
import { joinNames, readSchedulers, readingNotices, schedulersIn } from './schedulerReadings'
import type { CronApiResponse } from './types'

const NOW = Date.parse('2026-11-11T12:00:00Z')
const GOOD = { sourceSucceeded: true, observedAt: '2026-11-11T11:59:00.000Z' }
const UNREAD = { sourceSucceeded: false, observedAt: null }

describe('readSchedulers', () => {
  it('both read', () => {
    const r = readSchedulers({ schedulers: { openclaw: GOOD, hermes: GOOD } }, NOW)
    expect(r.openclaw.state).toBe('read')
    expect(r.hermes.state).toBe('read')
    expect(readingNotices(r, { ok: true, stale: false, error: null }, NOW)).toEqual([])
  })

  it('one scheduler unread is not read, never read', () => {
    const r = readSchedulers({ schedulers: { openclaw: UNREAD, hermes: GOOD } }, NOW)
    expect(r.openclaw.state).toBe('not-read')
    expect(r.hermes.state).toBe('read')
    expect(schedulersIn(r, 'not-read').map((x) => x.scheduler)).toEqual(['openclaw'])
    expect(joinNames(schedulersIn(r, 'not-read'))).toBe('OpenClaw')
  })

  it('names the unread scheduler and says there is no earlier reading when none is known', () => {
    const r = readSchedulers({ schedulers: { openclaw: UNREAD, hermes: GOOD } }, NOW)
    const [notice] = readingNotices(r, { ok: false, stale: true, error: { code: 'scheduler_stale' } }, NOW)
    expect(notice.title).toBe('OpenClaw could not be read')
    expect(notice.tone).toBe('warning')
    expect(notice.body).toContain('No earlier reading is available.')
  })

  it('gives the age of the last good reading seen by this browser when the server has forgotten it', () => {
    const r = readSchedulers({ schedulers: { openclaw: UNREAD, hermes: GOOD } }, NOW, { openclaw: '2026-11-11T11:48:00.000Z' })
    const [notice] = readingNotices(r, null, NOW)
    expect(notice.body).toContain('Last good reading 12m ago.')
  })

  it('Hermes unread names Hermes only', () => {
    const r = readSchedulers({ schedulers: { openclaw: GOOD, hermes: UNREAD } }, NOW)
    const notices = readingNotices(r, null, NOW)
    expect(notices.map((n) => n.title)).toEqual(['Hermes could not be read'])
  })

  it('both unread gives one notice each', () => {
    const r = readSchedulers({ schedulers: { openclaw: UNREAD, hermes: UNREAD } }, NOW)
    expect(readingNotices(r, null, NOW).map((n) => n.title)).toEqual(['OpenClaw could not be read', 'Hermes could not be read'])
    expect(joinNames(schedulersIn(r, 'not-read'))).toBe('OpenClaw and Hermes')
  })

  it('stale-but-served keeps its reading and says how old it is', () => {
    const stale = { sourceSucceeded: true, stale: true, staleAgeMs: 7 * 60_000, observedAt: '2026-11-11T11:53:00.000Z' }
    const r = readSchedulers({ schedulers: { openclaw: stale, hermes: GOOD } }, NOW)
    expect(r.openclaw.state).toBe('stale')
    const [notice] = readingNotices(r, { ok: false, stale: true }, NOW)
    expect(notice.title).toBe('OpenClaw jobs are from an older reading')
    expect(notice.body).toContain('Last good reading 7m ago.')
  })

  it('a payload that does not describe its schedulers claims nothing', () => {
    const r = readSchedulers({} as CronApiResponse, NOW)
    expect(r.openclaw.state).toBe('unknown')
    expect(readingNotices(r, { ok: true, stale: false }, NOW)).toEqual([])
  })

  it('a whole reading that is old, with no scheduler flagged, still says so', () => {
    const r = readSchedulers({ schedulers: { openclaw: GOOD, hermes: GOOD } }, NOW)
    const [notice] = readingNotices(r, { ok: false, stale: true, observedAt: '2026-11-11T11:50:00.000Z', error: { message: 'Read timed out' } }, NOW)
    expect(notice.title).toBe('Showing the last good reading')
    expect(notice.body).toContain('Read timed out')
    expect(notice.body).toContain('10m ago')
  })
})
