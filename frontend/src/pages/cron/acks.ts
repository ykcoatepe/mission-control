import { parseTime } from '../../lib/time'
import { isNewFailure, isStandingFailure } from './jobState'
import type { CronAck, CronApiResponse } from './types'

/**
 * Shows an acknowledgement at once in the cached jobs list: the job's `ack`, and the failed / standing counts of
 * the summary move by one when the job is a failure. The next refetch replaces it with the server's own reading.
 */
export function applyAck(current: CronApiResponse, ackKey: string, ack: CronAck | null): CronApiResponse {
  const jobs = current.jobs
  if (!Array.isArray(jobs)) return current
  let failed = 0
  let standing = 0
  const next = jobs.map((job) => {
    if (job.ackKey !== ackKey) return job
    const updated = { ...job, ack }
    if (isNewFailure(job) && ack) {
      failed -= 1
      standing += 1
    } else if (isStandingFailure(job) && !ack) {
      failed += 1
      standing -= 1
    }
    return updated
  })
  const summary = current.summary
  return {
    ...current,
    jobs: next,
    summary: summary
      ? {
          ...summary,
          failed: typeof summary.failed === 'number' ? Math.max(0, summary.failed + failed) : summary.failed,
          standingFailed:
            typeof summary.standingFailed === 'number' ? Math.max(0, summary.standingFailed + standing) : summary.standingFailed,
        }
      : summary,
  }
}

/** "Acknowledged" or "Shelved until 19 Nov": the quiet note on a standing failure. */
export function ackNote(ack: CronAck): string {
  if (ack.kind === 'ack') return 'Acknowledged'
  const until = parseTime(ack.until)
  if (until === null) return 'Shelved until undone'
  return `Shelved until ${new Date(until).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}`
}
