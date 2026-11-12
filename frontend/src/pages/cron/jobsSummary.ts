import { normalizeCronStatus } from '../../lib/status'
import { parseTime } from '../../lib/time'
import type { CronJob, CronSummary } from './types'

/**
 * A job is "on" when it is switched on. That is the scheduler's own meaning of
 * "active" in the API summary (`summary.active` counts every enabled job, the
 * failed ones included), so the strip, the Active filter and the API agree.
 */
export function isJobOn(job: Pick<CronJob, 'status' | 'enabled'>): boolean {
  return normalizeCronStatus(job.status, job.enabled) !== 'disabled'
}

export interface JobsSummary {
  /** Jobs switched on (includes failed ones and ones still waiting for a first result). */
  active: number
  paused: number
  /** Jobs switched on whose last run failed and that nobody has acknowledged or shelved: the new failures. */
  failed: number
  /** Failed jobs that are acknowledged or shelved: standing, counted apart and never as new. */
  standingFailed: number
  /** Jobs switched on that have not reported a result yet. */
  waiting: number
  nextRun: { at: number; name: string | null } | null
}

const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0

/**
 * The numbers for the summary strip. The API's own summary wins when it is
 * well-formed; a count it does not give is derived from the list with the same
 * rule. A figure is never filled in as 0 for something unknown: the next run is
 * null when no future run is known.
 */
export function summarizeJobs(jobs: CronJob[], apiSummary: CronSummary | null | undefined, now: number): JobsSummary {
  let on = 0
  let failed = 0
  let standingFailed = 0
  let waiting = 0
  let nextRun: { at: number; name: string | null } | null = null
  for (const job of jobs) {
    const status = normalizeCronStatus(job.status, job.enabled)
    if (status === 'disabled') continue
    on++
    if (status === 'failed') {
      if (job.ack) standingFailed++
      else failed++
    }
    else if (status !== 'active') waiting++
    // An overdue run is not "next": the scheduler has not run it when it said it would.
    const at = job.nextRunOverdue || job.nextRunDue ? null : parseTime(job.nextRun)
    if (at !== null && at >= now && (!nextRun || at < nextRun.at)) nextRun = { at, name: job.name }
  }
  if (!nextRun && apiSummary?.nextRunAt) {
    const at = parseTime(apiSummary.nextRunAt)
    if (at !== null && at >= now) nextRun = { at, name: null }
  }
  return {
    active: isCount(apiSummary?.active) ? apiSummary.active : on,
    paused: isCount(apiSummary?.paused) ? apiSummary.paused : jobs.length - on,
    failed: isCount(apiSummary?.failed) ? apiSummary.failed : failed,
    standingFailed: isCount(apiSummary?.standingFailed) ? apiSummary.standingFailed : standingFailed,
    waiting,
    nextRun,
  }
}
