import { describe, expect, it } from 'vitest'
import { lastRunMarkerDays, planWeek } from './weekPlan'
import type { CalendarEntry } from './scheduleLib'
import { toDayKey } from './scheduleLib'

const SUNDAY = new Date(2026, 10, 8) // week of 2026-11-08 .. 2026-11-14
const week = Array.from({ length: 7 }, (_, i) => new Date(2026, 10, 8 + i))
const wednesday = new Date(2026, 10, 11)

function entry(over: Partial<CalendarEntry> & { id: string }): CalendarEntry {
  return {
    title: over.id,
    schedule: '',
    startsAt: null,
    status: 'active',
    assignee: 'Mudur',
    source: 'cron',
    linkedTaskId: null,
    linkedJobId: null,
    ...over,
  }
}

const plan = (entries: CalendarEntry[], over: { hideDisabled?: boolean; today?: Date } = {}) =>
  planWeek(entries, week, { hideDisabled: over.hideDisabled ?? true, todayStart: over.today ?? wednesday })

const daysOf = (p: ReturnType<typeof plan>, id: string) =>
  week.map(toDayKey).filter((key) => p.byDay[key].some((placed) => placed.entry.id === id))

describe('planWeek', () => {
  it('puts a weekly job on its weekday only, not on all seven days', () => {
    const sunday = entry({ id: 'weekly', schedule: '0 11 * * 0' })
    const monthly = entry({ id: 'monthly', schedule: '35 11 24 * *' })
    // Today is Sunday so the whole week is "from today on".
    const p = plan([sunday, monthly], { today: SUNDAY })
    expect(daysOf(p, 'weekly')).toEqual(['2026-11-08'])
    expect(daysOf(p, 'monthly')).toEqual([])
  })

  it('places weekday jobs on Monday to Friday, and only from today on', () => {
    const job = entry({ id: 'weekdays', schedule: '0 9 * * 1-5' })
    expect(daysOf(plan([job], { today: SUNDAY }), 'weekdays')).toEqual([
      '2026-11-09', '2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13',
    ])
    // Wednesday: Mon and Tue are in the past and stay empty
    expect(daysOf(plan([job]), 'weekdays')).toEqual(['2026-11-11', '2026-11-12', '2026-11-13'])
  })

  it('shows a job that runs many times a day once per day, with a count', () => {
    const p = plan([entry({ id: 'sentinel', schedule: 'every 10m' }), entry({ id: 'poll', schedule: '*/10 9-16 * * 1-5' })])
    const wednesdayList = p.byDay['2026-11-11']
    expect(wednesdayList.filter((x) => x.entry.id === 'sentinel')).toHaveLength(1)
    const sentinel = wednesdayList.find((x) => x.entry.id === 'sentinel')!
    expect(sentinel.label).toBe('every 10m · 144 runs')
    expect(sentinel.runs).toBe(144)
    expect(sentinel.frequent).toBe(true)
    expect(wednesdayList.find((x) => x.entry.id === 'poll')!.label).toBe('48 runs · 9:00 AM–4:50 PM')
    expect(p.byDay['2026-11-14'].find((x) => x.entry.id === 'poll')).toBeUndefined() // Saturday
  })

  it('lists few runs by time and sorts frequent jobs after the rest', () => {
    const p = plan([
      entry({ id: 'busy', schedule: 'every 5m' }),
      entry({ id: 'late', schedule: '0 18 * * *' }),
      entry({ id: 'early', schedule: '0 7 * * *' }),
    ])
    expect(p.byDay['2026-11-11'].map((x) => x.entry.id)).toEqual(['early', 'late', 'busy'])
    expect(p.byDay['2026-11-11'][0].label).toBe('7:00 AM')
  })

  it('puts schedules it does not understand in a separate list with a reason, never on a day', () => {
    const p = plan([
      entry({ id: 'bare', schedule: 'every' }),
      entry({ id: 'broken', schedule: '99 * * * *' }),
      entry({ id: 'long', schedule: 'every 3d' }),
      entry({ id: 'cron-without-schedule', schedule: '', startsAt: null }),
      entry({ id: 'manual-undated', source: 'manual', schedule: '', startsAt: null }),
      entry({ id: 'bad-date', source: 'manual', schedule: '', startsAt: 'not a date' }),
    ], { hideDisabled: false })
    expect(p.unplaced.map((x) => x.entry.id)).toEqual(['bare', 'broken', 'long', 'cron-without-schedule', 'manual-undated', 'bad-date'])
    expect(p.unplaced[0].reason).toBe('No interval was reported')
    expect(p.unplaced[1].reason).toContain('minute')
    expect(p.unplaced[3].reason).toBe('No schedule was reported')
    expect(p.unplaced[4].reason).toBe('It has no date and no schedule')
    expect(p.unplaced[5].reason).toBe('Its start time cannot be read')
    for (const key of week.map(toDayKey)) expect(p.byDay[key]).toEqual([])
  })

  it('places a dated entry on its own day only, past days included', () => {
    const dated = entry({ id: 'dentist', source: 'manual', startsAt: new Date(2026, 10, 9, 14, 30).toISOString(), status: 'scheduled' })
    const p = plan([dated])
    expect(daysOf(p, 'dentist')).toEqual(['2026-11-09'])
    expect(p.byDay['2026-11-09'][0].label).toBe('2:30 PM')
    const outside = entry({ id: 'later', source: 'manual', startsAt: new Date(2026, 11, 2, 9, 0).toISOString() })
    expect(daysOf(plan([outside]), 'later')).toEqual([])
  })

  it('treats a one-time schedule as dated: it shows on its day even in the past', () => {
    const once = entry({ id: 'once', schedule: 'once at 2026-11-09 10:00', status: 'scheduled' })
    expect(daysOf(plan([once]), 'once')).toEqual(['2026-11-09'])
  })

  it('hides disabled entries on request and says how many', () => {
    const on = entry({ id: 'on', schedule: '0 9 * * *' })
    const off = entry({ id: 'off', schedule: '0 9 * * *', status: 'disabled' })
    const hidden = plan([on, off])
    expect(daysOf(hidden, 'off')).toEqual([])
    expect(hidden.hiddenDisabled).toBe(1)
    const shown = plan([on, off], { hideDisabled: false })
    expect(daysOf(shown, 'off').length).toBeGreaterThan(0)
    expect(shown.hiddenDisabled).toBe(0)
  })

  it('does not report a hidden disabled entry as not understood', () => {
    const p = plan([entry({ id: 'x', schedule: 'every', status: 'disabled' })])
    expect(p.unplaced).toEqual([])
    expect(p.hiddenDisabled).toBe(1)
  })
})

describe('planWeek with the schedule strings the API returns', () => {
  it('never produces seven copies of one job', () => {
    const strings = [
      '0 11 * * 0', '0 9 * * 1', '35 11 24 * *', '0 10 2 * *', '0 9 */2 * *', '10 0 * * 2-6',
      '15 9 5-10 * *', '0 */6 * * *', '2-59/5 * * * *', 'every 30m', 'once at 2026-11-06 10:00',
    ]
    const entries = strings.map((schedule, i) => entry({ id: `job-${i}`, schedule, status: 'active' }))
    const p = plan(entries, { today: SUNDAY })
    const everyDay = entries.filter((e) => daysOf(p, e.id).length === 7).map((e) => e.schedule)
    // only schedules that genuinely run daily (or more) fill all seven days
    expect(everyDay.sort()).toEqual(['0 */6 * * *', '2-59/5 * * * *', 'every 30m'].sort())
  })
})

describe('planWeek with scheduleKind and everyMs', () => {
  it('places an interval from everyMs on every day, without reading the text', () => {
    const job = entry({ id: 'iv', schedule: 'something else entirely', scheduleKind: 'interval', everyMs: 1_800_000 })
    const p = plan([job], { today: SUNDAY })
    expect(daysOf(p, 'iv')).toHaveLength(7)
    const placed = p.byDay['2026-11-09'][0]
    expect(placed.runs).toBe(48)
    expect(placed.label).toContain('48 runs')
  })

  it('lists an interval_unknown job as not placed, with the reason, even when it has a next run', () => {
    const job = entry({ id: 'iu', schedule: null, scheduleKind: 'interval_unknown', everyMs: null, startsAt: '2026-11-11T13:15:00.000Z' })
    const p = plan([job], { today: SUNDAY })
    expect(daysOf(p, 'iu')).toEqual([])
    expect(p.unplaced).toEqual([{ entry: job, reason: expect.stringContaining('did not report how often') }])
  })

  it('does not read an interval text as a cron slot when the kind is cron, nor a cron text as an interval', () => {
    const p = plan([entry({ id: 'bad', schedule: 'every 5m', scheduleKind: 'cron' })], { today: SUNDAY })
    expect(daysOf(p, 'bad')).toEqual([])
    expect(p.unplaced).toHaveLength(1)
  })
})

describe('lastRunMarkerDays', () => {
  const keys = week.map(toDayKey)
  const todayKey = toDayKey(wednesday)

  it('marks a failing recurring job on its first occurrence from today, not on the days after', () => {
    const job = entry({ id: 'bad', schedule: '0 9 * * *', status: 'failed' })
    const p = plan([job])
    const marked = lastRunMarkerDays(p.byDay, keys, todayKey)
    expect(marked.get('bad')).toBe('2026-11-11')
    expect(daysOf(p, 'bad').length).toBeGreaterThan(1)
  })

  it('a job that does not run today is marked on its next day', () => {
    const job = entry({ id: 'bad', schedule: '0 9 * * 5', status: 'failed' })
    expect(lastRunMarkerDays(plan([job]).byDay, keys, todayKey).get('bad')).toBe('2026-11-13')
  })

  it('marks nothing in a week that does not contain today, and nothing for a dated entry', () => {
    const job = entry({ id: 'bad', schedule: '0 9 * * *', status: 'failed' })
    expect(lastRunMarkerDays(plan([job]).byDay, keys, '2026-11-20').size).toBe(0)
    const dated = entry({ id: 'dated', startsAt: new Date(2026, 10, 12, 10).toISOString(), status: 'failed' })
    const p = plan([dated])
    expect(p.byDay['2026-11-12'][0].recurring).toBe(false)
    expect(lastRunMarkerDays(p.byDay, keys, todayKey).size).toBe(0)
  })
})
