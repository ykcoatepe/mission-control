import { describe, expect, it } from 'vitest'
import { describeDayRuns, formatMinuteOfDay, parseSchedule, runsOnDay, scheduleDisplay } from './cronSchedule'
import type { DayRuns, Schedule } from './cronSchedule'

/** Local-calendar Date at midnight; month is 1-based. 2026-11-11 is a Wednesday. */
const day = (year: number, month: number, date: number) => new Date(year, month - 1, date)

function schedule(text: string): Schedule {
  const parsed = parseSchedule(text)
  if (!parsed.ok) throw new Error(`"${text}" should parse: ${parsed.reason}`)
  return parsed.schedule
}

const runs = (text: string, d: Date): DayRuns => runsOnDay(schedule(text), d)
const runsThatDay = (text: string, d: Date) => runs(text, d).count > 0

describe('calendar used by these tests', () => {
  it('2026-11-11 is a Wednesday and 2026-11-08 a Sunday', () => {
    expect(day(2026, 11, 11).getDay()).toBe(3)
    expect(day(2026, 11, 8).getDay()).toBe(0)
  })
})

describe('real schedule strings from the automations API', () => {
  // [expression, day, runs that day]
  const table: Array<[string, Date, boolean]> = [
    // weekly, Sunday only
    ['0 11 * * 0', day(2026, 11, 8), true],
    ['0 11 * * 0', day(2026, 11, 9), false],
    ['0 11 * * 0', day(2026, 11, 14), false],
    ['20 18 * * 0', day(2026, 11, 15), true],
    ['20 18 * * 0', day(2026, 11, 11), false],
    // weekly, Monday only
    ['0 9 * * 1', day(2026, 11, 9), true],
    ['0 9 * * 1', day(2026, 11, 10), false],
    ['0 20 * * 1', day(2026, 11, 16), true],
    // weekdays
    ['0 9 * * 1-5', day(2026, 11, 9), true],
    ['0 9 * * 1-5', day(2026, 11, 13), true],
    ['0 9 * * 1-5', day(2026, 11, 14), false],
    ['0 9 * * 1-5', day(2026, 11, 15), false],
    // Tuesday to Saturday
    ['10 0 * * 2-6', day(2026, 11, 14), true],
    ['10 0 * * 2-6', day(2026, 11, 9), false],
    ['10 0 * * 2-6', day(2026, 11, 15), false],
    // monthly on a fixed date
    ['35 11 24 * *', day(2026, 11, 24), true],
    ['35 11 24 * *', day(2026, 11, 23), false],
    ['35 11 24 * *', day(2026, 12, 24), true],
    ['0 10 1 * *', day(2026, 12, 1), true],
    ['0 10 2 * *', day(2026, 11, 2), true],
    ['0 10 2 * *', day(2026, 11, 3), false],
    ['15 9 5-10 * *', day(2026, 11, 5), true],
    ['15 9 5-10 * *', day(2026, 11, 10), true],
    ['15 9 5-10 * *', day(2026, 11, 11), false],
    // step over the day of month: 1, 3, 5, ...
    ['0 9 */2 * *', day(2026, 11, 1), true],
    ['0 9 */2 * *', day(2026, 11, 2), false],
    ['0 9 */2 * *', day(2026, 11, 29), true],
    ['0 8 */3 * *', day(2026, 11, 7), true],
    ['0 8 */3 * *', day(2026, 11, 8), false],
    // every day
    ['0 3 * * *', day(2026, 11, 11), true],
    ['*/30 * * * *', day(2026, 11, 11), true],
    ['0 * * * *', day(2026, 11, 14), true],
    // hours as ranges and lists on weekdays
    ['*/10 9-16 * * 1-5', day(2026, 11, 11), true],
    ['*/10 9-16 * * 1-5', day(2026, 11, 14), false],
    ['25 10,13,20 * * 1-5', day(2026, 11, 13), true],
    ['25 10,13,20 * * 1-5', day(2026, 11, 15), false],
    ['0 17,18 * * 1-5', day(2026, 11, 12), true],
  ]
  it.each(table)('"%s" on %s runs: %s', (expression, d, expected) => {
    expect(runsThatDay(expression, d)).toBe(expected)
  })

  it('a weekly job lands on exactly one day of a seven-day week', () => {
    const week = Array.from({ length: 7 }, (_, i) => day(2026, 11, 8 + i))
    for (const expression of ['0 11 * * 0', '0 9 * * 1', '35 11 24 * *', '20 18 * * 0']) {
      const days = week.filter((d) => runsThatDay(expression, d))
      expect(days.length).toBeLessThanOrEqual(1)
    }
    expect(week.filter((d) => runsThatDay('0 11 * * 0', d))).toHaveLength(1)
    expect(week.filter((d) => runsThatDay('0 9 * * 1-5', d))).toHaveLength(5)
  })
})

describe('times and counts on a day', () => {
  it('lists the single time of a once-a-day job', () => {
    const r = runs('0 9 * * *', day(2026, 11, 11))
    expect(r).toMatchObject({ count: 1, times: [540], first: 540, last: 540, approximate: false })
  })

  it('counts every run but lists only the first few times', () => {
    const r = runs('*/10 9-16 * * 1-5', day(2026, 11, 11))
    expect(r.count).toBe(48)
    expect(r.times).toEqual([540, 550, 560])
    expect(r.first).toBe(540)
    expect(r.last).toBe(16 * 60 + 50)
  })

  it('honours the cap on listed times', () => {
    const r = runsOnDay(schedule('*/10 * * * *'), day(2026, 11, 11), 2)
    expect(r.count).toBe(144)
    expect(r.times).toEqual([0, 10])
  })

  it('combines hours and minutes as a product', () => {
    expect(runs('5,35 16-23 * * 1-5', day(2026, 11, 11)).count).toBe(16)
    expect(runs('12,42 16-23 * * 1-5', day(2026, 11, 11)).times).toEqual([16 * 60 + 12, 16 * 60 + 42, 17 * 60 + 12])
    expect(runs('30 16,18,20,21 * * 1-5', day(2026, 11, 11)).count).toBe(4)
  })

  it('handles stepped ranges and a start with a step', () => {
    expect(runs('2-59/5 * * * *', day(2026, 11, 11)).count).toBe(12 * 24)
    expect(runs('1-59/10 16-23 * * 1-5', day(2026, 11, 11)).count).toBe(6 * 8)
    expect(runs('5/15 * * * *', day(2026, 11, 11)).times).toEqual([5, 20, 35])
    expect(runs('0 */6 * * *', day(2026, 11, 11)).times).toEqual([0, 360, 720])
    expect(runs('27 */6 * * *', day(2026, 11, 11)).count).toBe(4)
  })

  it('reports no runs as a zero count with no times', () => {
    expect(runs('0 11 * * 0', day(2026, 11, 11))).toEqual({
      count: 0, times: [], first: null, last: null, approximate: false, everyMinutes: null,
    })
  })
})

describe('day of month and day of week', () => {
  it('runs when EITHER matches if both are restricted', () => {
    // the 13th, or any Friday. 2026-11-13 is a Friday; 2026-11-20 a Friday; 2026-12-13 a Sunday.
    expect(runsThatDay('0 0 13 * 5', day(2026, 11, 13))).toBe(true)
    expect(runsThatDay('0 0 13 * 5', day(2026, 11, 20))).toBe(true)
    expect(runsThatDay('0 0 13 * 5', day(2026, 12, 13))).toBe(true)
    expect(runsThatDay('0 0 13 * 5', day(2026, 11, 12))).toBe(false)
    expect(runsThatDay('0 0 1 * 1', day(2026, 11, 1))).toBe(true) // the 1st (a Sunday)
    expect(runsThatDay('0 0 1 * 1', day(2026, 11, 2))).toBe(true) // a Monday
    expect(runsThatDay('0 0 1 * 1', day(2026, 11, 3))).toBe(false)
  })

  it('requires both when either field starts with a star', () => {
    // odd days of the month that are also a Monday
    expect(runsThatDay('0 0 */2 * 1', day(2026, 11, 9))).toBe(true)
    expect(runsThatDay('0 0 */2 * 1', day(2026, 11, 2))).toBe(false)
    expect(runsThatDay('0 0 */2 * 1', day(2026, 11, 16))).toBe(false)
    // any day of the month, but only Sundays
    expect(runsThatDay('0 0 * * 0', day(2026, 11, 8))).toBe(true)
    expect(runsThatDay('0 0 * * 0', day(2026, 11, 9))).toBe(false)
  })
})

describe('month end and short months', () => {
  it('a run on the 31st skips months with 30 days', () => {
    expect(runsThatDay('0 0 31 * *', day(2026, 11, 30))).toBe(false)
    expect(runsThatDay('0 0 31 * *', day(2026, 12, 31))).toBe(true)
    expect(runsThatDay('0 0 31 * *', day(2026, 10, 31))).toBe(true)
  })

  it('February 29 exists only in leap years', () => {
    expect(runsThatDay('0 0 29 2 *', day(2028, 2, 29))).toBe(true)
    expect(runsThatDay('0 0 29 2 *', day(2027, 2, 28))).toBe(false)
    expect(runsThatDay('0 0 29 2 *', day(2027, 3, 1))).toBe(false)
  })

  it('a month field restricts the year', () => {
    expect(runsThatDay('0 0 1 1 *', day(2027, 1, 1))).toBe(true)
    expect(runsThatDay('0 0 1 1 *', day(2026, 12, 1))).toBe(false)
    expect(runsThatDay('0 0 * 11-12 *', day(2026, 11, 11))).toBe(true)
    expect(runsThatDay('0 0 * 11-12 *', day(2026, 10, 31))).toBe(false)
  })
})

describe('names, 7 as Sunday and macros', () => {
  it('reads month and weekday names in any case', () => {
    expect(runsThatDay('0 9 * NOV Wed', day(2026, 11, 11))).toBe(true)
    expect(runsThatDay('0 9 * nov wed', day(2026, 11, 12))).toBe(false)
    expect(runsThatDay('0 9 * jan-mar mon-fri', day(2027, 2, 3))).toBe(true)
    expect(runsThatDay('0 9 * jan-mar mon-fri', day(2026, 11, 11))).toBe(false)
    expect(runsThatDay('0 9 * * sat,sun', day(2026, 11, 14))).toBe(true)
    expect(runsThatDay('0 9 * * sat,sun', day(2026, 11, 13))).toBe(false)
  })

  it('treats weekday 7 as Sunday', () => {
    expect(runsThatDay('0 0 * * 7', day(2026, 11, 15))).toBe(true)
    expect(runsThatDay('0 0 * * 7', day(2026, 11, 14))).toBe(false)
    expect(runsThatDay('0 0 * * 5-7', day(2026, 11, 13))).toBe(true)
    expect(runsThatDay('0 0 * * 5-7', day(2026, 11, 12))).toBe(false)
  })

  it('expands @daily, @weekly and @monthly', () => {
    expect(runs('@daily', day(2026, 11, 11)).times).toEqual([0])
    expect(runsThatDay('@weekly', day(2026, 11, 15))).toBe(true)
    expect(runsThatDay('@weekly', day(2026, 11, 16))).toBe(false)
    expect(runsThatDay('@monthly', day(2026, 12, 1))).toBe(true)
    expect(runs('@hourly', day(2026, 11, 11)).count).toBe(24)
  })
})

describe('interval strings', () => {
  it('counts the runs in a day without inventing their times', () => {
    expect(runs('every 10m', day(2026, 11, 11))).toMatchObject({ count: 144, times: [], first: null, approximate: false, everyMinutes: 10 })
    expect(runs('every 5m', day(2026, 11, 11)).count).toBe(288)
    expect(runs('every 30m', day(2026, 11, 11)).count).toBe(48)
    expect(runs('every 2h', day(2026, 11, 11)).count).toBe(12)
    expect(runs('every 1d', day(2026, 11, 11)).count).toBe(1)
  })

  it('marks a count that does not divide the day evenly as approximate', () => {
    const r = runs('every 7m', day(2026, 11, 11))
    expect(r.count).toBe(205)
    expect(r.approximate).toBe(true)
  })

  it('is case and spacing tolerant', () => {
    expect(runs('Every 10 minutes', day(2026, 11, 11)).count).toBe(144)
    expect(runs('every 1 hour', day(2026, 11, 11)).count).toBe(24)
  })
})

describe('one-time schedules', () => {
  it('runs on its own day only', () => {
    expect(runs('once at 2026-11-06 10:00', day(2026, 11, 6))).toMatchObject({ count: 1, times: [600] })
    expect(runsThatDay('once at 2026-11-06 10:00', day(2026, 11, 7))).toBe(false)
    expect(runsThatDay('once at 2026-11-06 10:00', day(2027, 11, 6))).toBe(false)
  })
})

describe('schedules that are not understood', () => {
  const invalid: Array<[string | null | undefined, string]> = [
    [null, 'No schedule was reported'],
    [undefined, 'No schedule was reported'],
    ['', 'No schedule was reported'],
    ['   ', 'No schedule was reported'],
    ['?', 'No schedule was reported'],
    ['every', 'No interval was reported'],
    ['EVERY', 'No interval was reported'],
    ['* * * *', 'five fields'],
    ['* * * * * *', 'five fields'],
    ['61 * * * *', 'minute field'],
    ['* 24 * * *', 'hour field'],
    ['* * 0 * *', 'day of month field'],
    ['* * 32 * *', 'day of month field'],
    ['* * * 13 *', 'month field'],
    ['* * * * 8', 'day of week field'],
    ['*/0 * * * *', 'minute field'],
    ['5-1 * * * *', 'minute field'],
    ['1,,2 * * * *', 'minute field'],
    ['a * * * *', 'minute field'],
    ['0 0 ? * *', 'day of month field'],
    ['0 0 * foo *', 'month field'],
    ['0 0 * * funday', 'day of week field'],
    ['every 0m', 'not valid'],
    ['every 3d', 'longer than a day'],
    ['every 36h', 'longer than a day'],
    ['every tomorrow', 'not recognised'],
    ['once at 2026-02-30 10:00', 'not valid'],
    ['once at 2026-11-06 25:00', 'not valid'],
    ['once upon a time', 'not recognised'],
    ['hello world', 'five fields'],
  ]
  it.each(invalid)('%j is not understood', (text, reason) => {
    const parsed = parseSchedule(text)
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.reason).toContain(reason)
  })

  it('never throws, whatever the input', () => {
    for (const text of ['\u0000', '* * * * *\n* * * * *', '1-', '-1 * * * *', '1/ * * * *', '/5 * * * *', '*/*', '9'.repeat(400)]) {
      expect(() => parseSchedule(text)).not.toThrow()
    }
  })
})

describe('formatMinuteOfDay and describeDayRuns', () => {
  it('formats 12-hour times with a fixed shape', () => {
    expect(formatMinuteOfDay(0)).toBe('12:00 AM')
    expect(formatMinuteOfDay(5)).toBe('12:05 AM')
    expect(formatMinuteOfDay(12 * 60)).toBe('12:00 PM')
    expect(formatMinuteOfDay(14 * 60 + 58)).toBe('2:58 PM')
    expect(formatMinuteOfDay(23 * 60 + 59)).toBe('11:59 PM')
  })

  it('lists a few times and counts many', () => {
    const d = day(2026, 11, 11)
    const describe = (text: string) => describeDayRuns(schedule(text), runs(text, d))
    expect(describe('0 9 * * *')).toBe('9:00 AM')
    expect(describe('0 9,12,15 * * *')).toBe('9:00 AM, 12:00 PM, 3:00 PM')
    expect(describe('0 */6 * * *')).toBe('4 runs · 12:00 AM–6:00 PM')
    expect(describe('*/10 9-16 * * 1-5')).toBe('48 runs · 9:00 AM–4:50 PM')
    expect(describe('every 10m')).toBe('every 10m · 144 runs')
    expect(describe('every 7m')).toBe('every 7m · about 205 runs')
    expect(describe('every 1d')).toBe('every 1d')
    expect(describe('once at 2026-11-11 10:00')).toBe('10:00 AM')
  })
})

describe('scheduleDisplay', () => {
  it('shows a missing value in words and a real one as raw text', () => {
    expect(scheduleDisplay('every')).toEqual({ text: 'Interval not reported', raw: false })
    expect(scheduleDisplay('?')).toEqual({ text: 'Schedule not reported', raw: false })
    expect(scheduleDisplay('')).toEqual({ text: 'Schedule not reported', raw: false })
    expect(scheduleDisplay(null)).toEqual({ text: 'Schedule not reported', raw: false })
    expect(scheduleDisplay('every 10m')).toEqual({ text: 'every 10m', raw: true })
    expect(scheduleDisplay(' 0 9 * * 1 ')).toEqual({ text: '0 9 * * 1', raw: true })
  })
})
