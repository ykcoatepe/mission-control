/**
 * Reads the schedule strings the automations API returns and answers one
 * question: does this job run on this calendar day, and at which times?
 *
 * Understood forms:
 *  - five-field cron: lists (1,15), ranges (9-17), steps (*\/10, 1-59/10, 5/15),
 *    month and weekday names (jan, mon), weekday 7 as Sunday, and the @daily
 *    family;
 *  - interval strings: "every 10m", "every 2h", "every 1d";
 *  - one-shot strings: "once at 2026-11-06 10:00".
 *
 * Day of month and day of week follow classic cron: when both are restricted a
 * day matches if EITHER does; when one of them starts with "*" both must match.
 *
 * Everything is evaluated on the calendar of the Date it is given (the browser's
 * local time zone), never on UTC. Anything else is reported as "not understood"
 * with a reason; it is never guessed onto a day.
 */

export interface CronExpression {
  kind: 'cron'
  /** Minutes (0-59) and hours (0-23) a run can start at, ascending. */
  minutes: number[]
  hours: number[]
  /** Days of month (1-31), months (1-12), weekdays (0-6, Sunday = 0). */
  daysOfMonth: ReadonlySet<number>
  months: ReadonlySet<number>
  daysOfWeek: ReadonlySet<number>
  /** The field started with "*": classic cron then requires both day fields to match. */
  domStar: boolean
  dowStar: boolean
}

export interface IntervalSchedule {
  kind: 'interval'
  everyMinutes: number
  /** The interval as the API wrote it, for display ("every 10m"). */
  text: string
}

export interface OnceSchedule {
  kind: 'once'
  year: number
  month: number
  day: number
  minuteOfDay: number
}

export type Schedule = CronExpression | IntervalSchedule | OnceSchedule

export type ParsedSchedule = { ok: true; schedule: Schedule } | { ok: false; reason: string }

/** What a schedule does on one calendar day. `count` 0 means it does not run that day. */
export interface DayRuns {
  count: number
  /** The first few start times as minutes since midnight (see `cap`). */
  times: number[]
  first: number | null
  last: number | null
  /** The count is a rounded figure (an interval that does not divide the day evenly). */
  approximate: boolean
  /** Set for interval schedules, whose start times within the day are not known. */
  everyMinutes: number | null
}

const MONTH_NAMES = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const WEEKDAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']

const MACROS: Record<string, string> = {
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
  '@monthly': '0 0 1 * *',
  '@weekly': '0 0 * * 0',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@hourly': '0 * * * *',
}

const MINUTES_PER_DAY = 1440

interface FieldSpec {
  label: string
  min: number
  max: number
  names?: readonly string[]
  /** Offset of the first name (months start at 1, weekdays at 0). */
  nameBase?: number
}

const FIELDS: FieldSpec[] = [
  { label: 'minute', min: 0, max: 59 },
  { label: 'hour', min: 0, max: 23 },
  { label: 'day of month', min: 1, max: 31 },
  { label: 'month', min: 1, max: 12, names: MONTH_NAMES, nameBase: 1 },
  { label: 'day of week', min: 0, max: 7, names: WEEKDAY_NAMES, nameBase: 0 },
]

function parseNumber(token: string, spec: FieldSpec): number | null {
  if (/^\d+$/.test(token)) return Number(token)
  if (spec.names) {
    const index = spec.names.indexOf(token.toLowerCase())
    if (index >= 0) return index + (spec.nameBase ?? 0)
  }
  return null
}

function parseField(text: string, spec: FieldSpec): { values: Set<number>; star: boolean } | null {
  const values = new Set<number>()
  for (const part of text.split(',')) {
    if (!part) return null
    const [rangeText, stepText, ...extra] = part.split('/')
    if (extra.length > 0 || rangeText === '') return null
    let step = 1
    if (stepText !== undefined) {
      if (!/^\d+$/.test(stepText)) return null
      step = Number(stepText)
      if (step < 1) return null
    }
    let low: number
    let high: number
    if (rangeText === '*') {
      low = spec.min
      high = spec.max
    } else if (rangeText.includes('-')) {
      const [a, b, ...more] = rangeText.split('-')
      const from = parseNumber(a, spec)
      const to = parseNumber(b, spec)
      if (more.length > 0 || from === null || to === null) return null
      low = from
      high = to
    } else {
      const single = parseNumber(rangeText, spec)
      if (single === null) return null
      low = single
      // "5/15" means 5 through the end of the field, every 15.
      high = stepText !== undefined ? spec.max : single
    }
    if (low < spec.min || high > spec.max || low > high) return null
    for (let value = low; value <= high; value += step) values.add(value)
  }
  return values.size > 0 ? { values, star: text.startsWith('*') } : null
}

function parseCron(text: string): ParsedSchedule {
  const expanded = MACROS[text.trim().toLowerCase()] ?? text
  const parts = expanded.trim().split(/\s+/)
  if (parts.length !== 5) {
    return { ok: false, reason: 'A cron schedule needs five fields: minute, hour, day of month, month, day of week' }
  }
  const parsed: Array<{ values: Set<number>; star: boolean }> = []
  for (let index = 0; index < 5; index++) {
    const field = parseField(parts[index], FIELDS[index])
    if (!field) return { ok: false, reason: `The ${FIELDS[index].label} field is not valid` }
    parsed.push(field)
  }
  const [minute, hour, dom, month, dow] = parsed
  const weekdays = new Set<number>()
  for (const value of dow.values) weekdays.add(value === 7 ? 0 : value)
  return {
    ok: true,
    schedule: {
      kind: 'cron',
      minutes: [...minute.values].sort((a, b) => a - b),
      hours: [...hour.values].sort((a, b) => a - b),
      daysOfMonth: dom.values,
      months: month.values,
      daysOfWeek: weekdays,
      domStar: dom.star,
      dowStar: dow.star,
    },
  }
}

const INTERVAL_UNITS: Record<string, number> = {
  m: 1, min: 1, mins: 1, minute: 1, minutes: 1,
  h: 60, hr: 60, hrs: 60, hour: 60, hours: 60,
  d: 1440, day: 1440, days: 1440,
}

/** Parse the schedule string of a job or schedule entry. Never throws. */
export function parseSchedule(raw: string | null | undefined): ParsedSchedule {
  const text = String(raw ?? '').trim()
  if (text === '' || text === '?') return { ok: false, reason: 'No schedule was reported' }
  if (/^every$/i.test(text)) return { ok: false, reason: 'No interval was reported' }

  const interval = /^every\s+(\d+)\s*([a-z]+)$/i.exec(text)
  if (interval) {
    const unit = INTERVAL_UNITS[interval[2].toLowerCase()]
    const amount = Number(interval[1])
    if (!unit || amount < 1) return { ok: false, reason: 'The interval is not valid' }
    const everyMinutes = amount * unit
    if (everyMinutes > MINUTES_PER_DAY) {
      return { ok: false, reason: 'An interval longer than a day has no reported start, so its days are unknown' }
    }
    return { ok: true, schedule: { kind: 'interval', everyMinutes, text } }
  }

  const once = /^once at (\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})$/i.exec(text)
  if (once) {
    const [year, month, day, hour, minute] = once.slice(1).map(Number)
    const date = new Date(year, month - 1, day)
    const valid = date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day
    if (!valid || hour > 23 || minute > 59) return { ok: false, reason: 'The one-time date is not valid' }
    return { ok: true, schedule: { kind: 'once', year, month, day, minuteOfDay: hour * 60 + minute } }
  }

  if (/^every\b/i.test(text) || /^once\b/i.test(text)) return { ok: false, reason: 'This interval form is not recognised' }
  return parseCron(text)
}

/** The server's own account of a schedule (`scheduleKind`, `everyMs`), as `GET /api/cron` and `GET /api/calendar` send it. */
export interface ScheduleFields {
  schedule?: string | null
  scheduleKind?: string | null
  everyMs?: number | null
}

/**
 * The schedule of a job or calendar entry. When the server names the kind, that
 * decides how it is read: an `interval` is `everyMs` (not the "every 30m" text), a `cron` is
 * its expression, `interval_unknown` is an interval nobody reported (so it is not
 * placed anywhere), and `manual`/`unknown` have no schedule. Without a `scheduleKind`
 * (an older payload) the display string is parsed as before. Never throws.
 */
export function parseEntrySchedule(fields: ScheduleFields): ParsedSchedule {
  const kind = typeof fields.scheduleKind === 'string' ? fields.scheduleKind : null
  const text = String(fields.schedule ?? '').trim()
  switch (kind) {
    case 'interval': {
      const everyMs = fields.everyMs
      if (typeof everyMs !== 'number' || !Number.isFinite(everyMs) || everyMs <= 0) {
        return { ok: false, reason: 'The interval is not valid' }
      }
      const everyMinutes = everyMs / 60_000
      if (everyMinutes > MINUTES_PER_DAY) {
        return { ok: false, reason: 'An interval longer than a day has no reported start, so its days are unknown' }
      }
      return { ok: true, schedule: { kind: 'interval', everyMinutes, text: text || `every ${everyMinutes} min` } }
    }
    case 'interval_unknown':
      return { ok: false, reason: 'The scheduler runs it on an interval but did not report how often' }
    case 'cron':
      return text ? parseCron(text) : { ok: false, reason: 'No schedule was reported' }
    case 'manual':
      return { ok: false, reason: 'It has no schedule; it runs when started by hand' }
    case 'unknown':
      return { ok: false, reason: 'No schedule was reported' }
    case 'at':
    default:
      // A one-time schedule has no structured field in the payload yet: its text is all there is.
      return parseSchedule(text)
  }
}

/** Does a cron expression run on this calendar day (any time of day)? */
function cronRunsOnDay(cron: CronExpression, day: Date): boolean {
  if (!cron.months.has(day.getMonth() + 1)) return false
  const domMatch = cron.daysOfMonth.has(day.getDate())
  const dowMatch = cron.daysOfWeek.has(day.getDay())
  return cron.domStar || cron.dowStar ? domMatch && dowMatch : domMatch || dowMatch
}

const NO_RUNS: DayRuns = { count: 0, times: [], first: null, last: null, approximate: false, everyMinutes: null }

/**
 * What `schedule` does on the calendar day of `day`. `cap` limits how many start
 * times are listed (the count is always the full figure).
 */
export function runsOnDay(schedule: Schedule, day: Date, cap = 3): DayRuns {
  if (schedule.kind === 'once') {
    const same = day.getFullYear() === schedule.year && day.getMonth() + 1 === schedule.month && day.getDate() === schedule.day
    return same
      ? { count: 1, times: [schedule.minuteOfDay], first: schedule.minuteOfDay, last: schedule.minuteOfDay, approximate: false, everyMinutes: null }
      : NO_RUNS
  }
  if (schedule.kind === 'interval') {
    const count = Math.floor(MINUTES_PER_DAY / schedule.everyMinutes)
    return {
      count,
      times: [],
      first: null,
      last: null,
      approximate: MINUTES_PER_DAY % schedule.everyMinutes !== 0,
      everyMinutes: schedule.everyMinutes,
    }
  }
  if (!cronRunsOnDay(schedule, day)) return NO_RUNS

  const { hours, minutes } = schedule
  const times: number[] = []
  for (const hour of hours) {
    for (const minute of minutes) {
      if (times.length >= cap) break
      times.push(hour * 60 + minute)
    }
    if (times.length >= cap) break
  }
  return {
    count: hours.length * minutes.length,
    times,
    first: hours[0] * 60 + minutes[0],
    last: hours[hours.length - 1] * 60 + minutes[minutes.length - 1],
    approximate: false,
    everyMinutes: null,
  }
}

/** "2:58 PM" from minutes since midnight. Fixed format, independent of the browser's locale data. */
export function formatMinuteOfDay(minuteOfDay: number): string {
  const hour = Math.floor(minuteOfDay / 60) % 24
  const minute = minuteOfDay % 60
  const suffix = hour < 12 ? 'AM' : 'PM'
  const hour12 = hour % 12 === 0 ? 12 : hour % 12
  return `${hour12}:${String(minute).padStart(2, '0')} ${suffix}`
}

/** How many start times a chip lists before it switches to "N runs". */
export const LISTED_TIMES = 3

/**
 * The short line under a job in the week grid: its times when there are few,
 * otherwise a run count ("every 10m · 144 runs", "48 runs · 9:00 AM–4:50 PM").
 */
export function describeDayRuns(schedule: Schedule, runs: DayRuns): string {
  const countText = `${runs.approximate ? 'about ' : ''}${runs.count} ${runs.count === 1 ? 'run' : 'runs'}`
  if (schedule.kind === 'interval') {
    return runs.count > 1 ? `${schedule.text} · ${countText}` : schedule.text
  }
  if (runs.count <= LISTED_TIMES) return runs.times.map(formatMinuteOfDay).join(', ')
  const span = runs.first !== null && runs.last !== null ? ` · ${formatMinuteOfDay(runs.first)}–${formatMinuteOfDay(runs.last)}` : ''
  return `${countText}${span}`
}

/** A job or entry schedule as it should be shown: raw text in monospace, a missing value in words. */
export function scheduleDisplay(
  raw: string | null | undefined,
  scheduleKind?: string | null,
): { text: string; raw: boolean } {
  const text = String(raw ?? '').trim()
  if (scheduleKind === 'interval_unknown') return { text: 'Interval not reported', raw: false }
  if (scheduleKind === 'manual' && text === '') return { text: 'Runs when started by hand', raw: false }
  if (text === '' || text === '?') return { text: 'Schedule not reported', raw: false }
  if (/^every$/i.test(text)) return { text: 'Interval not reported', raw: false }
  return { text, raw: true }
}
