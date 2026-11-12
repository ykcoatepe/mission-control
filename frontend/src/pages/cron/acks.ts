import { sendJson } from '../../lib/hooks'
import { parseTime } from '../../lib/time'
import { isNewFailure, isStandingFailure } from './jobState'
import type { CronAck, CronApiResponse } from './types'

/** How long a shelve lasts: the choices the operator is offered. `null` days = until I undo. */
export const SHELVE_CHOICES = [
  { id: '7d', label: '7 days', days: 7 },
  { id: '30d', label: '30 days', days: 30 },
  { id: 'undo', label: 'Until I undo', days: null },
] as const

export type ShelveChoice = (typeof SHELVE_CHOICES)[number]

/** The end of a shelve, as an ISO date; null when it lasts until the operator undoes it. */
export function shelveUntil(days: number | null, now: number): string | null {
  return days === null ? null : new Date(now + days * 86_400_000).toISOString()
}

interface AckResponse {
  ok?: boolean
  key?: string
  ack?: CronAck | null
}

/** Acknowledge ("seen, it will stay like this") or shelve a failed job. Keys contain ':' and are sent as given in the body. */
export function acknowledgeJob(key: string, kind: 'ack' | 'shelve', until: string | null = null) {
  return sendJson<AckResponse>('/api/attention/acks', 'POST', kind === 'shelve' ? { key, kind, until } : { key, kind })
}

/** Remove an acknowledgement or shelve. The key must be encoded: it contains ':'. */
export function undoAcknowledgement(key: string) {
  return sendJson<AckResponse>(`/api/attention/acks/${encodeURIComponent(key)}`, 'DELETE')
}

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
