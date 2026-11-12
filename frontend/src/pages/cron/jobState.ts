import { normalizeCronStatus } from '../../lib/status'
import type { UiState } from '../../lib/state'
import type { CronJob } from './types'

export interface JobState {
  state: UiState
  label: string
  /** A failed job that was acknowledged or shelved: a standing condition, shown neutral and never counted as new. */
  standing?: boolean
}

type StateInput = Pick<CronJob, 'status' | 'enabled'> & { ack?: CronJob['ack'] }

/** A job switched on whose last run failed and that nobody has acknowledged or shelved yet. */
export function isNewFailure(job: StateInput): boolean {
  return normalizeCronStatus(job.status, job.enabled) === 'failed' && !job.ack
}

/** A job switched on whose last run failed and that was acknowledged or shelved: standing, not new. */
export function isStandingFailure(job: StateInput): boolean {
  return normalizeCronStatus(job.status, job.enabled) === 'failed' && Boolean(job.ack)
}

/**
 * Operator-facing state of a job. Only a run result makes a job "active" or
 * "failed"; a job that is on but has reported nothing is "waiting", never green.
 * A paused job is off (dash), never coloured. A failed job that was acknowledged
 * or shelved keeps its word but is no longer an alarm: `standing`.
 */
export function jobState(job: StateInput): JobState {
  const status = normalizeCronStatus(job.status, job.enabled)
  if (status === 'disabled') return { state: 'inactive', label: 'Paused' }
  if (status === 'failed') return job.ack ? { state: 'critical', label: 'Failed', standing: true } : { state: 'critical', label: 'Failed' }
  if (status === 'active') return { state: 'healthy', label: 'Active' }
  return { state: 'unavailable', label: 'Waiting' }
}
