import { describeDayRuns, formatMinuteOfDay, LISTED_TIMES, parseSchedule, runsOnDay } from './cronSchedule'
import type { Schedule } from './cronSchedule'
import { isDisabledEntry, toDayKey } from './scheduleLib'
import type { CalendarEntry } from './scheduleLib'

/** One job or entry on one day of the week grid. */
export interface PlacedEntry {
  entry: CalendarEntry
  /** The line under the title: the run times, or a run count for jobs that run often. */
  label: string
  /** Number of runs that day; 1 for a dated entry. */
  runs: number
  /** Minutes since midnight of the first known run; null when the times are not known. */
  firstMinute: number | null
  /** Runs often enough that it is shown as a count and sorted below the rest. */
  frequent: boolean
}

/** An entry that cannot be put on a day, and why. */
export interface UnplacedEntry {
  entry: CalendarEntry
  reason: string
}

export interface WeekPlan {
  /** Day key (yyyy-mm-dd) to the entries that run that day. */
  byDay: Record<string, PlacedEntry[]>
  unplaced: UnplacedEntry[]
  /** Disabled entries left out because the caller asked to hide them. */
  hiddenDisabled: number
}

export interface PlanOptions {
  hideDisabled: boolean
  /** Midnight at the start of today, local time. Recurring jobs are placed from this day on. */
  todayStart: Date
}

function compareEntries(a: PlacedEntry, b: PlacedEntry): number {
  if (a.frequent !== b.frequent) return a.frequent ? 1 : -1
  const am = a.firstMinute ?? Number.MAX_SAFE_INTEGER
  const bm = b.firstMinute ?? Number.MAX_SAFE_INTEGER
  if (am !== bm) return am - bm
  return String(a.entry.title).localeCompare(String(b.entry.title))
}

function place(runsCount: number, schedule: Schedule | null, entry: CalendarEntry, label: string, firstMinute: number | null): PlacedEntry {
  const frequent = schedule !== null && schedule.kind !== 'once' && runsCount > LISTED_TIMES
  return { entry, label, runs: runsCount, firstMinute, frequent }
}

/**
 * Put each entry on the days it actually runs.
 *
 *  - A dated entry (no schedule, a start time) goes on its start day.
 *  - A recurring entry goes on each day its schedule matches, once per day with
 *    its times or run count. Days before today stay empty: the grid shows what
 *    is coming, and the Jobs view has what already ran.
 *  - A one-time schedule ("once at ...") is dated: it shows on its own day.
 *  - Anything else cannot be placed and is listed with the reason, never spread
 *    over the week.
 *
 * `days` are midnight Dates of the days shown.
 */
export function planWeek(entries: CalendarEntry[], days: Date[], options: PlanOptions): WeekPlan {
  const keys = days.map(toDayKey)
  const byDay: Record<string, PlacedEntry[]> = Object.fromEntries(keys.map((key) => [key, []]))
  const unplaced: UnplacedEntry[] = []
  let hiddenDisabled = 0
  const todayTime = options.todayStart.getTime()

  for (const entry of entries) {
    if (options.hideDisabled && isDisabledEntry(entry)) {
      hiddenDisabled++
      continue
    }

    const scheduleText = String(entry.schedule ?? '').trim()
    if (scheduleText) {
      const parsed = parseSchedule(scheduleText)
      if (!parsed.ok) {
        unplaced.push({ entry, reason: parsed.reason })
        continue
      }
      const schedule = parsed.schedule
      days.forEach((day, index) => {
        if (schedule.kind !== 'once' && day.getTime() < todayTime) return
        const runs = runsOnDay(schedule, day)
        if (runs.count === 0) return
        byDay[keys[index]].push(place(runs.count, schedule, entry, describeDayRuns(schedule, runs), runs.first))
      })
      continue
    }

    if (!entry.startsAt) {
      unplaced.push({
        entry,
        reason: entry.source === 'cron' ? 'No schedule was reported' : 'It has no date and no schedule',
      })
      continue
    }
    const startsAt = new Date(entry.startsAt)
    if (Number.isNaN(startsAt.getTime())) {
      unplaced.push({ entry, reason: 'Its start time cannot be read' })
      continue
    }
    const key = toDayKey(startsAt)
    if (byDay[key]) {
      const minute = startsAt.getHours() * 60 + startsAt.getMinutes()
      byDay[key].push({ entry, label: formatMinuteOfDay(minute), runs: 1, firstMinute: minute, frequent: false })
    }
  }

  for (const key of keys) byDay[key].sort(compareEntries)
  return { byDay, unplaced, hiddenDisabled }
}
