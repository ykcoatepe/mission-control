import { useState } from 'react'
import { formatRelative, parseTime } from '../../lib/time'
import type { CronApiResponse, CronMeta, CronScheduler, CronSchedulerProof } from './types'

/**
 * How well each scheduler was read for GET /api/cron.
 *
 * The list only ever holds the jobs of a scheduler that was read, so a scheduler
 * that was not read looks, in the list alone, like one with no jobs. This module
 * is where that difference is kept: "not read" is never a zero and never healthy.
 */

export const SCHEDULERS: readonly CronScheduler[] = ['openclaw', 'hermes']

export const SCHEDULER_NAMES: Record<CronScheduler, string> = { openclaw: 'OpenClaw', hermes: 'Hermes' }

/**
 * - `read`: a fresh reading.
 * - `stale`: its jobs are the last good reading, older than the scheduler's fresh window.
 * - `not-read`: the scheduler could not be read and no jobs of it are in the list.
 * - `unknown`: the payload does not say (an older server). Nothing is claimed.
 */
export type ReadingState = 'read' | 'stale' | 'not-read' | 'unknown'

export interface SchedulerReading {
  scheduler: CronScheduler
  name: string
  state: ReadingState
  /** When the last good reading of this scheduler was taken, when known. */
  observedAt: string | null
}

export type SchedulerReadings = Record<CronScheduler, SchedulerReading>

/** The last good `observedAt` this browser has seen per scheduler; the server forgets it once a scheduler is unread. */
export type LastGoodReadings = Partial<Record<CronScheduler, string>>

function readingOf(
  scheduler: CronScheduler,
  proof: CronSchedulerProof | undefined,
  now: number,
  lastGood: LastGoodReadings,
): SchedulerReading {
  const name = SCHEDULER_NAMES[scheduler]
  if (!proof || typeof proof.sourceSucceeded !== 'boolean') return { scheduler, name, state: 'unknown', observedAt: null }
  const own = parseTime(proof.observedAt) !== null ? (proof.observedAt as string) : null
  if (!proof.sourceSucceeded) {
    return { scheduler, name, state: 'not-read', observedAt: own ?? lastGood[scheduler] ?? null }
  }
  if (proof.stale === true) {
    // The server's own age wins; the clock is only a fallback.
    const fromAge =
      typeof proof.staleAgeMs === 'number' && Number.isFinite(proof.staleAgeMs) ? new Date(now - proof.staleAgeMs).toISOString() : null
    return { scheduler, name, state: 'stale', observedAt: own ?? fromAge }
  }
  return { scheduler, name, state: 'read', observedAt: own }
}

export function readSchedulers(
  payload: Pick<CronApiResponse, 'schedulers'> | null | undefined,
  now: number,
  lastGood: LastGoodReadings = {},
): SchedulerReadings {
  const schedulers = payload?.schedulers
  return {
    openclaw: readingOf('openclaw', schedulers?.openclaw, now, lastGood),
    hermes: readingOf('hermes', schedulers?.hermes, now, lastGood),
  }
}

/** Schedulers whose reading is in the given state, in display order. */
export function schedulersIn(readings: SchedulerReadings, state: ReadingState): SchedulerReading[] {
  return SCHEDULERS.map((scheduler) => readings[scheduler]).filter((reading) => reading.state === state)
}

/** "OpenClaw", "OpenClaw and Hermes". */
export function joinNames(readings: SchedulerReading[]): string {
  return readings.map((reading) => reading.name).join(' and ')
}

export interface ReadingNotice {
  id: string
  tone: 'warning' | 'info'
  title: string
  body: string
}

function lastGoodSentence(observedAt: string | null, now: number): string {
  const at = parseTime(observedAt)
  return at === null ? 'No earlier reading is available.' : `Last good reading ${formatRelative(at, now)}.`
}

/**
 * The notices for a reading that is not fully good. Fully good returns none.
 * A scheduler that was not read and one that is only cached each get their own;
 * when the server only says the whole reading is old (no scheduler is flagged)
 * one notice says so.
 */
export function readingNotices(
  readings: SchedulerReadings,
  meta: CronMeta | null | undefined,
  now: number,
): ReadingNotice[] {
  const notices: ReadingNotice[] = []
  for (const reading of schedulersIn(readings, 'not-read')) {
    notices.push({
      id: `not-read:${reading.scheduler}`,
      tone: 'warning',
      title: `${reading.name} could not be read`,
      body: `Its jobs are missing from this list, and the totals leave them out. ${lastGoodSentence(reading.observedAt, now)}`,
    })
  }
  for (const reading of schedulersIn(readings, 'stale')) {
    notices.push({
      id: `stale:${reading.scheduler}`,
      tone: 'warning',
      title: `${reading.name} jobs are from an older reading`,
      body: `They may have changed since. ${lastGoodSentence(reading.observedAt, now)}`,
    })
  }
  if (notices.length === 0 && (meta?.ok === false || meta?.stale === true)) {
    const message = meta?.error?.message
    notices.push({
      id: 'overall',
      tone: 'warning',
      title: 'Showing the last good reading',
      body: `${message ? `${message}. ` : ''}${lastGoodSentence(meta?.observedAt ?? null, now)}`,
    })
  }
  return notices
}

/**
 * Remembers, for this browser, the last good reading time of each scheduler so
 * a scheduler that later goes unread can say how old its last good reading is.
 * Updates during render with the "adjust state while rendering" pattern.
 */
export function useLastGoodReadings(readings: SchedulerReadings): LastGoodReadings {
  const [lastGood, setLastGood] = useState<LastGoodReadings>({})
  let next: LastGoodReadings | null = null
  for (const scheduler of SCHEDULERS) {
    const reading = readings[scheduler]
    if (reading.state === 'read' && reading.observedAt && lastGood[scheduler] !== reading.observedAt) {
      next = { ...(next ?? lastGood), [scheduler]: reading.observedAt }
    }
  }
  if (next) setLastGood(next)
  return lastGood
}
